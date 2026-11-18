import { WebSocket } from 'ws';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const INSTANCES = [
    { id: 1, port: 8000, ws: 'ws://127.0.0.1:8000/ws', api: 'http://127.0.0.1:8000' },
    { id: 2, port: 8001, ws: 'ws://127.0.0.1:8001/ws', api: 'http://127.0.0.1:8001' },
];

const TOTAL_CLIENTS = 5000;
const CLIENTS_PER_INSTANCE = 2500;
const TOTAL_RUNS = 5;
const BROADCAST_ROUNDS_PER_RUN = 3;
const COLLECTION_WINDOW_MS = 2000; // 2.0s collection window
const SLA_CUTOFF_MS = 400; // Messages > 400ms are considered to have "missed 400ms"

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
    }

    connect() {
        return new Promise((resolve) => {
            try {
                this.ws = new WebSocket(this.targetWs);
            } catch (err) {
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

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    const receivedAt = Date.now();

                    if (msg.type === 'welcome') {
                        this.ws.send(JSON.stringify({ type: 'subscribe', matchId: this.matchId }));
                    } else if (msg.type === 'subscribed') {
                        this.subscribed = true;
                        clearTimeout(timeout);
                        resolve(true);
                    } else if (msg.type === 'reaction_broadcast' || msg.type === 'commentary' || msg.type === 'score_update') {
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
                this.ws.close();
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

async function run() {
    console.log('========================================================================');
    console.log('📊 Benchmark: 2 Instances × 5,000 Clients (2s Collection Window, 5 Runs)');
    console.log('Tracking arrival times and instance breakdown for all messages > 400ms');
    console.log('========================================================================');

    // 1. Start Server 1 and Server 2
    console.log('\n[Setup] Launching Instance 1 (port 8000) and Instance 2 (port 8001)...');
    const proc1 = spawnServer(8000);
    const proc2 = spawnServer(8001);

    try {
        await Promise.all([
            waitForHttp('http://127.0.0.1:8000/health'),
            waitForHttp('http://127.0.0.1:8001/health'),
        ]);
        console.log('✅ Both server instances healthy and listening.');

        const runSummaries = [];
        const globalBuckets = createBuckets();
        let globalTotalDeliveries = 0;
        let globalTotalMissed = 0;

        for (let runIdx = 1; runIdx <= TOTAL_RUNS; runIdx++) {
            console.log(`\n------------------------------------------------------------------------`);
            console.log(`🚀 RUN ${runIdx}/${TOTAL_RUNS}: Connecting ${TOTAL_CLIENTS} sockets (2,500 per instance)...`);
            console.log(`------------------------------------------------------------------------`);

            const clients = [];
            const MATCH_ROOMS = [1, 2, 3, 4, 5];
            const BATCH_SIZE = 100;
            const BATCH_DELAY_MS = 20;

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
                if (limit < TOTAL_CLIENTS) {
                    await delay(BATCH_DELAY_MS);
                }
            }

            const connected = clients.filter((c) => c.connected && c.subscribed);
            const connectElapsed = Date.now() - connectStart;
            console.log(`✅ Connected & Subscribed: ${connected.length}/${TOTAL_CLIENTS} in ${connectElapsed}ms`);

            await delay(500);

            // Group clients by match room
            const roomSubscribers = new Map();
            for (const mId of MATCH_ROOMS) {
                roomSubscribers.set(mId, clients.filter((c) => c.connected && c.subscribed && c.matchId === mId));
            }

            const runBuckets = createBuckets();
            let runTotalExpected = 0;
            let runTotalReceived = 0;
            let runMissed400Count = 0;
            let runOntimeCount = 0;

            for (let round = 1; round <= BROADCAST_ROUNDS_PER_RUN; round++) {
                for (const matchId of MATCH_ROOMS) {
                    const subs = roomSubscribers.get(matchId) || [];
                    if (subs.length === 0) continue;

                    // Clear messages before firing broadcast
                    for (const c of subs) {
                        c.receivedMessages = [];
                    }

                    // Send reaction broadcast from first client
                    const publisher = subs[0];
                    publisher.sendReaction('🔥');

                    // 2.0s Collection Window
                    await delay(COLLECTION_WINDOW_MS);

                    // Collect metrics
                    runTotalExpected += subs.length;

                    for (const c of subs) {
                        if (c.receivedMessages.length > 0) {
                            runTotalReceived++;
                            const msg = c.receivedMessages[0];
                            const lat = msg.latency;
                            if (lat <= SLA_CUTOFF_MS) {
                                runOntimeCount++;
                            } else {
                                runMissed400Count++;
                                categorizeLatency(lat, c.instanceId, runBuckets);
                                categorizeLatency(lat, c.instanceId, globalBuckets);
                            }
                        } else {
                            // Undelivered within the 2.0s window
                            runMissed400Count++;
                            categorizeLatency(2500, c.instanceId, runBuckets);
                            categorizeLatency(2500, c.instanceId, globalBuckets);
                        }
                    }
                }
            }

            const runMissedPercent = Number(((runMissed400Count / runTotalExpected) * 100).toFixed(2));
            const runOntimePercent = Number(((runOntimeCount / runTotalExpected) * 100).toFixed(2));

            console.log(`\n[Run ${runIdx} Results] Total Deliveries Expected: ${runTotalExpected}`);
            console.log(`On-Time (<= 400ms): ${runOntimeCount} (${runOntimePercent}%) | Missed > 400ms: ${runMissed400Count} (${runMissedPercent}%)`);
            console.log(`Arrival Distribution for Messages Missing 400ms (Run ${runIdx}):`);
            printDistributionTable(runBuckets, runTotalExpected);

            runSummaries.push({
                run: runIdx,
                expected: runTotalExpected,
                received: runTotalReceived,
                ontime: runOntimeCount,
                missed400: runMissed400Count,
                missedPercent: runMissedPercent,
                buckets: runBuckets,
            });

            globalTotalDeliveries += runTotalExpected;
            globalTotalMissed += runMissed400Count;

            // Teardown sockets and cooldown
            console.log(`Tearing down ${clients.length} sockets...`);
            for (const c of clients) c.close();
            await delay(4000);
        }

        console.log('\n========================================================================');
        console.log('🏆 AGGREGATE 5-RUN DISTRIBUTION (Messages Missing 400ms across 2 Instances)');
        console.log('========================================================================');
        const globalMissedPercent = Number(((globalTotalMissed / globalTotalDeliveries) * 100).toFixed(2));
        console.log(`Total Monitored Deliveries: ${globalTotalDeliveries}`);
        console.log(`Total Missed 400ms: ${globalTotalMissed} (${globalMissedPercent}%)`);
        printDistributionTable(globalBuckets, globalTotalDeliveries);

        // Save raw benchmark data
        const outPath = path.resolve(ROOT_DIR, '../benchmarks/missed-400ms-distribution.json');
        await fs.writeFile(outPath, JSON.stringify({
            test: '2 instances x 5000 clients, 2s collection window, 5 runs',
            totalDeliveries: globalTotalDeliveries,
            totalMissed400: globalTotalMissed,
            missedPercent: globalMissedPercent,
            runs: runSummaries,
            globalBuckets,
        }, null, 2));
        console.log(`\n💾 Raw distribution saved to: ${outPath}\n`);

    } finally {
        console.log('[Teardown] Stopping server instances...');
        await stopProcess(proc1);
        await stopProcess(proc2);
    }
}

function printDistributionTable(buckets, totalDeliveries) {
    console.log('+----------------------+-------+------------+------------+---------------+');
    console.log('| Latency Bucket       | Total | Instance 1 | Instance 2 | % of Total    |');
    console.log('+----------------------+-------+------------+------------+---------------+');
    for (const [range, data] of Object.entries(buckets)) {
        const pct = totalDeliveries > 0 ? ((data.count / totalDeliveries) * 100).toFixed(3) : '0.000';
        const rangePad = range.padEnd(20);
        const countPad = String(data.count).padStart(5);
        const inst1Pad = String(data.inst1).padStart(10);
        const inst2Pad = String(data.inst2).padStart(10);
        const pctPad = `${pct}%`.padStart(13);
        console.log(`| ${rangePad} | ${countPad} | ${inst1Pad} | ${inst2Pad} | ${pctPad} |`);
    }
    console.log('+----------------------+-------+------------+------------+---------------+');
}

run().catch((err) => {
    console.error('Benchmark execution error:', err);
    process.exit(1);
});
