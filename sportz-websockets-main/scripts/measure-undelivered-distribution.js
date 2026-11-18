import { WebSocket } from 'ws';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.resolve(ROOT_DIR, '.env') });
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const INSTANCES = [
    { id: 1, port: 8000, ws: 'ws://127.0.0.1:8000/ws', api: 'http://127.0.0.1:8000' },
    { id: 2, port: 8001, ws: 'ws://127.0.0.1:8001/ws', api: 'http://127.0.0.1:8001' },
];

const TOTAL_CLIENTS = 5000;
const CLIENTS_PER_INSTANCE = 2500;
const MATCH_ROOMS = [1, 2, 3, 4, 5]; // 5 rooms (1,000 clients/room)
const BROADCAST_ROUNDS_PER_RUN = 25; // 25 messages per client
const TOTAL_RUNS = 5;
const COLLECTION_WINDOW_MS = 2000; // 2.0s collection window
const SLA_CUTOFF_MS = 400; // >400ms considered missed

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function spawnServer(port) {
    const proc = spawn(process.execPath, [path.resolve(ROOT_DIR, 'src/index.js')], {
        cwd: ROOT_DIR,
        env: {
            ...process.env,
            PORT: String(port),
            REDIS_URL,
            BENCHMARK_BYPASS_ARCJET: '1',
            AUTO_SEED: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    return proc;
}

async function stopProcess(proc) {
    if (!proc || proc.killed) return;
    try {
        if (process.platform === 'win32') {
            try { execSync(`taskkill /pid ${proc.pid} /f /t`, { stdio: 'ignore' }); } catch {}
        } else {
            proc.kill('SIGTERM');
        }
    } catch {}
    await delay(500);
}

async function waitForHttp(url, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return true;
        } catch {}
        await delay(200);
    }
    throw new Error(`Timeout waiting for ${url}`);
}

class BenchmarkClient {
    constructor(id, instanceId, targetWs, matchId) {
        this.id = id;
        this.instanceId = instanceId;
        this.targetWs = targetWs;
        this.matchId = matchId;
        this.ws = null;
        this.connected = false;
        this.subscribed = false;
        this.receivedMessages = [];
        this.injectDelayMs = 0; // If > 0, artificially delays arrival timestamp
    }

    connect() {
        return new Promise((resolve) => {
            try {
                this.ws = new WebSocket(this.targetWs);
            } catch {
                return resolve(false);
            }

            const timeout = setTimeout(() => {
                if (!this.connected) {
                    try { this.ws.close(); } catch {}
                    resolve(false);
                }
            }, 10000);

            this.ws.on('open', () => {
                this.connected = true;
            });

            this.ws.on('message', async (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    let receivedAt = Date.now();

                    if (msg.type === 'welcome') {
                        this.ws.send(JSON.stringify({ type: 'subscribe', matchId: this.matchId }));
                    } else if (msg.type === 'subscribed') {
                        this.subscribed = true;
                        clearTimeout(timeout);
                        resolve(true);
                    } else if (msg.type === 'reaction_broadcast' || msg.type === 'commentary' || msg.type === 'score_update') {
                        if (this.injectDelayMs > 0) {
                            await delay(this.injectDelayMs);
                            receivedAt = Date.now();
                        }
                        this.receivedMessages.push({
                            type: msg.type,
                            serverTimestamp: msg.serverTimestamp,
                            receivedAt,
                            latency: msg.serverTimestamp ? (receivedAt - msg.serverTimestamp) : 0,
                            instanceId: this.instanceId,
                            clientId: this.id,
                        });
                    }
                } catch {}
            });

            this.ws.on('error', () => {
                clearTimeout(timeout);
                resolve(false);
            });

            this.ws.on('close', () => {
                this.connected = false;
            });
        });
    }

    sendReaction(emoji = '🔥') {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'reaction',
                matchId: this.matchId,
                emoji,
            }));
        }
    }

    close() {
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.terminate();
            } catch {}
            this.ws = null;
        }
    }
}

function createBuckets() {
    return {
        '400-500ms': { count: 0, inst1: 0, inst2: 0, latencies: [] },
        '500-600ms': { count: 0, inst1: 0, inst2: 0, latencies: [] },
        '600-800ms': { count: 0, inst1: 0, inst2: 0, latencies: [] },
        '800-1000ms': { count: 0, inst1: 0, inst2: 0, latencies: [] },
        '1000-1500ms': { count: 0, inst1: 0, inst2: 0, latencies: [] },
        '1500-2000ms': { count: 0, inst1: 0, inst2: 0, latencies: [] },
        '>2000ms (undelivered)': { count: 0, inst1: 0, inst2: 0, latencies: [] },
    };
}

function categorizeLatency(latency, instanceId, buckets) {
    let key;
    if (latency <= 400) return; // on-time, within 400ms SLA
    if (latency <= 500) key = '400-500ms';
    else if (latency <= 600) key = '500-600ms';
    else if (latency <= 800) key = '600-800ms';
    else if (latency <= 1000) key = '800-1000ms';
    else if (latency <= 1500) key = '1000-1500ms';
    else if (latency <= 2000) key = '1500-2000ms';
    else key = '>2000ms (undelivered)';

    buckets[key].count++;
    if (instanceId === 1) buckets[key].inst1++;
    else if (instanceId === 2) buckets[key].inst2++;
    buckets[key].latencies.push(latency);
}

function printDistributionTable(title, buckets, totalExpected, missedCount) {
    console.log(`\n========================================================================`);
    console.log(`📊 ${title}`);
    console.log(`Total Expected Deliveries: ${totalExpected.toLocaleString()}`);
    console.log(`Total Messages Missing 400ms: ${missedCount.toLocaleString()} (${((missedCount / totalExpected) * 100).toFixed(3)}%)`);
    console.log(`------------------------------------------------------------------------`);
    console.log(`Latency Bucket            | Total Count | Instance 1 | Instance 2 | Min/Max Latency`);
    console.log(`--------------------------+-------------+------------+------------+----------------`);

    for (const [bucket, data] of Object.entries(buckets)) {
        const minLat = data.latencies.length > 0 ? `${Math.min(...data.latencies)}ms` : '-';
        const maxLat = data.latencies.length > 0 ? `${Math.max(...data.latencies)}ms` : '-';
        const latRange = data.latencies.length > 0 ? `[${minLat} - ${maxLat}]` : '-';
        const bucketStr = bucket.padEnd(25);
        const countStr = String(data.count).padStart(11);
        const inst1Str = String(data.inst1).padStart(10);
        const inst2Str = String(data.inst2).padStart(10);
        console.log(`${bucketStr} | ${countStr} | ${inst1Str} | ${inst2Str} | ${latRange}`);
    }
    console.log(`========================================================================\n`);
}

async function run() {
    console.log('========================================================================');
    console.log('📊 Benchmark: 2 Instances × 5,000 Clients (2s Collection Window)');
    console.log('Workload: 5 rooms × 5,000 clients × 25 messages/client (125,000 msgs/run)');
    console.log('Tracking arrival times and instance breakdown for all messages > 400ms');
    console.log('========================================================================');

    // 1. Launch Instance 1 (8000) and Instance 2 (8001)
    console.log('\n[Setup] Launching Instance 1 (port 8000) and Instance 2 (port 8001)...');
    const proc1 = spawnServer(8000);
    const proc2 = spawnServer(8001);

    try {
        await Promise.all([
            waitForHttp('http://127.0.0.1:8000/health'),
            waitForHttp('http://127.0.0.1:8001/health'),
        ]);
        console.log('✅ Both server instances healthy and listening.');

        // ====================================================================
        // STEP 1: PROVE THE MEASUREMENT CAN CATCH DELAYS (INJECT 600ms DELAY)
        // ====================================================================
        console.log('\n========================================================================');
        console.log('🧪 PROOF OF MEASUREMENT: Injecting 600ms delay on 10 messages');
        console.log('Verifying that injected delays land strictly in the 600-800ms bucket');
        console.log('========================================================================');

        const proofClients = [];
        const BATCH_SIZE = 100;
        const BATCH_DELAY_MS = 20;

        for (let i = 0; i < TOTAL_CLIENTS; i += BATCH_SIZE) {
            const batch = [];
            const limit = Math.min(i + BATCH_SIZE, TOTAL_CLIENTS);
            for (let j = i; j < limit; j++) {
                const instance = INSTANCES[j % 2];
                const matchId = MATCH_ROOMS[j % MATCH_ROOMS.length];
                const client = new BenchmarkClient(j, instance.id, instance.ws, matchId);
                proofClients.push(client);
                batch.push(client.connect());
            }
            await Promise.all(batch);
            if (limit < TOTAL_CLIENTS) await delay(BATCH_DELAY_MS);
        }

        const proofConnected = proofClients.filter(c => c.connected && c.subscribed);
        console.log(`✅ Proof Clients Connected: ${proofConnected.length}/${TOTAL_CLIENTS}`);

        // Inject 600ms artificial delay on exactly 10 clients (5 on Instance 1, 5 on Instance 2)
        const delayClientIndices = [0, 200, 400, 600, 800, 1001, 1201, 1401, 1601, 1801];
        for (const idx of delayClientIndices) {
            proofClients[idx].injectDelayMs = 600;
        }

        const proofBuckets = createBuckets();
        let proofMissed = 0;

        // Group proof clients by room
        const proofRooms = new Map();
        for (const mId of MATCH_ROOMS) {
            proofRooms.set(mId, proofClients.filter(c => c.connected && c.subscribed && c.matchId === mId));
        }

        // Fire 1 round across all 5 rooms
        for (const [mId, subs] of proofRooms.entries()) {
            for (const c of subs) c.receivedMessages = [];
            subs[0].sendReaction('🔥');
        }

        await delay(COLLECTION_WINDOW_MS);

        for (const c of proofClients) {
            if (c.receivedMessages.length > 0) {
                const lat = c.receivedMessages[0].latency;
                if (lat > SLA_CUTOFF_MS) {
                    proofMissed++;
                    categorizeLatency(lat, c.instanceId, proofBuckets);
                }
            } else {
                proofMissed++;
                categorizeLatency(2500, c.instanceId, proofBuckets);
            }
        }

        printDistributionTable('PROOF TEST: INJECTED 600ms DELAY DISTRIBUTION', proofBuckets, TOTAL_CLIENTS, proofMissed);

        // Teardown proof clients
        for (const c of proofClients) c.close();
        await delay(1000);

        // ====================================================================
        // STEP 2: FULL 5-RUN BENCHMARK (ORIGINAL WORKLOAD: 25 MSGS/CLIENT)
        // ====================================================================
        console.log('========================================================================');
        console.log('🚀 EXECUTING 5-RUN BENCHMARK WITH ORIGINAL LOAD-TEST.JS WORKLOAD');
        console.log(`Configuration: 5 rooms × 5,000 clients × 25 messages/client = 125,000 deliveries/run`);
        console.log(`Collection Window: ${COLLECTION_WINDOW_MS}ms | Runs: ${TOTAL_RUNS}`);
        console.log('========================================================================');

        const runSummaries = [];
        const globalBuckets = createBuckets();
        let globalTotalDeliveries = 0;
        let globalTotalMissed = 0;

        for (let runIdx = 1; runIdx <= TOTAL_RUNS; runIdx++) {
            console.log(`\n------------------------------------------------------------------------`);
            console.log(`🚀 RUN ${runIdx}/${TOTAL_RUNS}: Connecting 5,000 sockets (2,500 per instance)...`);
            console.log(`------------------------------------------------------------------------`);

            const clients = [];
            const connectStart = Date.now();
            for (let i = 0; i < TOTAL_CLIENTS; i += BATCH_SIZE) {
                const batch = [];
                const limit = Math.min(i + BATCH_SIZE, TOTAL_CLIENTS);
                for (let j = i; j < limit; j++) {
                    const instance = INSTANCES[j % 2];
                    const matchId = MATCH_ROOMS[j % MATCH_ROOMS.length];
                    const client = new BenchmarkClient(j, instance.id, instance.ws, matchId);
                    clients.push(client);
                    batch.push(client.connect());
                }
                await Promise.all(batch);
                if (limit < TOTAL_CLIENTS) await delay(BATCH_DELAY_MS);
            }

            const connected = clients.filter(c => c.connected && c.subscribed);
            const connectElapsed = Date.now() - connectStart;
            console.log(`✅ Connected & Subscribed: ${connected.length}/${TOTAL_CLIENTS} in ${connectElapsed}ms`);

            await delay(500);

            // Group clients by match room
            const roomSubscribers = new Map();
            for (const mId of MATCH_ROOMS) {
                roomSubscribers.set(mId, clients.filter(c => c.connected && c.subscribed && c.matchId === mId));
            }

            const runBuckets = createBuckets();
            let runTotalExpected = 0;
            let runMissed400Count = 0;
            let runOntimeCount = 0;

            console.log(`Publishing ${BROADCAST_ROUNDS_PER_RUN} broadcast rounds across 5 rooms (125,000 deliveries)...`);

            for (let round = 1; round <= BROADCAST_ROUNDS_PER_RUN; round++) {
                // Clear message buffers for all subscribers before this round
                for (const c of clients) {
                    c.receivedMessages = [];
                }

                // Fire reaction in each of the 5 match rooms
                for (const [mId, subs] of roomSubscribers.entries()) {
                    if (subs.length === 0) continue;
                    subs[0].sendReaction('🔥');
                }

                // 2.0s collection window per round
                await delay(COLLECTION_WINDOW_MS);

                // Collect results for this round
                for (const c of clients) {
                    runTotalExpected++;
                    if (c.receivedMessages.length > 0) {
                        const lat = c.receivedMessages[0].latency;
                        if (lat <= SLA_CUTOFF_MS) {
                            runOntimeCount++;
                        } else {
                            runMissed400Count++;
                            categorizeLatency(lat, c.instanceId, runBuckets);
                            categorizeLatency(lat, c.instanceId, globalBuckets);
                        }
                    } else {
                        // Undelivered within 2.0s
                        runMissed400Count++;
                        categorizeLatency(2500, c.instanceId, runBuckets);
                        categorizeLatency(2500, c.instanceId, globalBuckets);
                    }
                }
            }

            const runMissedPercent = Number(((runMissed400Count / runTotalExpected) * 100).toFixed(3));
            const runOntimePercent = Number(((runOntimeCount / runTotalExpected) * 100).toFixed(3));

            console.log(`\n[Run ${runIdx} Completed] Total Deliveries: ${runTotalExpected.toLocaleString()}`);
            console.log(`On-Time (<= 400ms): ${runOntimeCount.toLocaleString()} (${runOntimePercent}%) | Missed > 400ms: ${runMissed400Count.toLocaleString()} (${runMissedPercent}%)`);

            runSummaries.push({
                run: runIdx,
                totalExpected: runTotalExpected,
                ontime: runOntimeCount,
                missed400: runMissed400Count,
                missedPercent: runMissedPercent,
                buckets: runBuckets,
            });

            globalTotalDeliveries += runTotalExpected;
            globalTotalMissed += runMissed400Count;

            printDistributionTable(`RUN ${runIdx} DISTRIBUTION`, runBuckets, runTotalExpected, runMissed400Count);

            // Teardown clients for next run
            for (const c of clients) c.close();
            clients.length = 0;
            if (typeof global.gc === 'function') {
                global.gc();
            }
            await delay(3000);
        }

        // ====================================================================
        // FINAL GLOBAL SUMMARY ACROSS ALL 5 RUNS (625,000 DELIVERIES)
        // ====================================================================
        printDistributionTable('OVERALL 5-RUN AGGREGATE DISTRIBUTION (625,000 DELIVERIES)', globalBuckets, globalTotalDeliveries, globalTotalMissed);

        // Save raw results to JSON file
        const outputFile = path.resolve(ROOT_DIR, 'benchmarks/undelivered-distribution-original-workload.json');
        await fs.mkdir(path.dirname(outputFile), { recursive: true });
        await fs.writeFile(outputFile, JSON.stringify({
            workload: '5 rooms × 5,000 clients × 25 messages/client',
            totalRuns: TOTAL_RUNS,
            totalExpectedDeliveries: globalTotalDeliveries,
            totalMissed400: globalTotalMissed,
            globalBuckets,
            runSummaries,
        }, null, 2));

        console.log(`📁 Raw results saved to: ${outputFile}`);

    } finally {
        console.log('\n[Teardown] Stopping Instance 1 and Instance 2...');
        await stopProcess(proc1);
        await stopProcess(proc2);
        console.log('✅ Teardown complete.');
    }
}

run().catch((err) => {
    console.error('❌ Benchmark failed:', err);
    process.exit(1);
});
