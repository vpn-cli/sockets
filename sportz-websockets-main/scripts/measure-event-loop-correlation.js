import { WebSocket } from 'ws';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { monitorEventLoopDelay } from 'perf_hooks';
import { configureBenchmarkDatabase } from '../src/db/guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const benchmarkDbInfo = configureBenchmarkDatabase();
dotenv.config({ path: path.resolve(ROOT_DIR, '.env') });
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
console.log(`[Benchmark DB] Host: ${benchmarkDbInfo.host} (guarded local-by-default)`);

const INSTANCES = [
    { id: 1, port: 8000, ws: 'ws://127.0.0.1:8000/ws', api: 'http://127.0.0.1:8000' },
    { id: 2, port: 8001, ws: 'ws://127.0.0.1:8001/ws', api: 'http://127.0.0.1:8001' },
];

const TOTAL_CLIENTS = 5000;
const MATCH_ROOMS = [1, 2, 3, 4, 5]; // 5 rooms (1,000 clients/room)
const BROADCAST_ROUNDS_PER_RUN = 25; // 25 messages per client
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
            DATABASE_URL: process.env.DATABASE_URL,
            SPORTZ_BENCHMARK: '1',
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

async function fetchEventLoopStats(api) {
    try {
        const res = await fetch(`${api}/event-loop-stats?reset=1`);
        if (res.ok) return await res.json();
    } catch {}
    return { maxMs: 0, p99Ms: 0, p50Ms: 0, meanMs: 0 };
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
                            matchId: this.matchId,
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
                this.ws.terminate(); // Socket RST recycling: bypass TIME_WAIT
            } catch {}
            this.ws = null;
        }
    }
}

async function run() {
    console.log('========================================================================');
    console.log('🔬 EVENT LOOP LAG & LATE MESSAGE CORRELATION MEASUREMENT');
    console.log('Tracking perf_hooks.monitorEventLoopDelay on Load Generator & Servers');
    console.log('Workload: 2 Instances × 5,000 Clients × 25 Rounds (125,000 deliveries)');
    console.log('Flags: --max-old-space-size=4096 --expose-gc Socket-RST-Recycling');
    console.log('========================================================================\n');

    const loadGenMonitor = monitorEventLoopDelay({ resolution: 10 });
    loadGenMonitor.enable();

    console.log('[Setup] Launching Instance 1 (8000) and Instance 2 (8001)...');
    const proc1 = spawnServer(8000);
    const proc2 = spawnServer(8001);

    try {
        await Promise.all([
            waitForHttp('http://127.0.0.1:8000/health'),
            waitForHttp('http://127.0.0.1:8001/health'),
        ]);
        console.log('✅ Both server instances healthy and listening.');

        // Warm up and reset event loop stats on both servers
        await fetchEventLoopStats(INSTANCES[0].api);
        await fetchEventLoopStats(INSTANCES[1].api);

        const clients = [];
        const BATCH_SIZE = 100;
        const BATCH_DELAY_MS = 20;

        console.log('\n[Connecting] Establishing 5,000 WebSocket connections...');
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
        console.log(`✅ Connected & Subscribed: ${connected.length}/${TOTAL_CLIENTS} in ${Date.now() - connectStart}ms`);

        const roomSubscribers = new Map();
        for (const mId of MATCH_ROOMS) {
            roomSubscribers.set(mId, clients.filter(c => c.connected && c.subscribed && c.matchId === mId));
        }

        await delay(1000);

        console.log('\n[Executing 25 Broadcast Rounds with Event Loop Lag Tracking]');
        console.log('Round | On-Time | >400ms | Late Latencies [min - max] | LoadGen Lag (Max/p99) | Inst 1 Lag (Max) | Inst 2 Lag (Max)');
        console.log('------+---------+--------+----------------------------+-----------------------+------------------+------------------');

        const roundCorrelations = [];

        for (let round = 1; round <= BROADCAST_ROUNDS_PER_RUN; round++) {
            for (const c of clients) {
                c.receivedMessages = [];
            }

            // Reset event loop monitors right before broadcast
            loadGenMonitor.reset();
            await fetchEventLoopStats(INSTANCES[0].api);
            await fetchEventLoopStats(INSTANCES[1].api);

            // Fire reaction in each of the 5 match rooms
            for (const [mId, subs] of roomSubscribers.entries()) {
                if (subs.length === 0) continue;
                subs[0].sendReaction('🔥');
            }

            // Wait collection window
            await delay(COLLECTION_WINDOW_MS);

            // Capture event loop stats immediately after collection window
            const loadGenMax = Number((loadGenMonitor.max / 1e6).toFixed(1));
            const loadGenP99 = Number((loadGenMonitor.percentile(99) / 1e6).toFixed(1));
            const inst1Stats = await fetchEventLoopStats(INSTANCES[0].api);
            const inst2Stats = await fetchEventLoopStats(INSTANCES[1].api);

            let ontime = 0;
            let late = 0;
            const lateLatencies = [];

            for (const c of clients) {
                if (c.receivedMessages.length > 0) {
                    const lat = c.receivedMessages[0].latency;
                    if (lat <= SLA_CUTOFF_MS) {
                        ontime++;
                    } else {
                        late++;
                        lateLatencies.push(lat);
                    }
                } else {
                    late++;
                    lateLatencies.push(2000);
                }
            }

            const lateRangeStr = lateLatencies.length > 0
                ? `[${Math.min(...lateLatencies)}ms - ${Math.max(...lateLatencies)}ms]`
                : 'None';

            const roundStr = String(round).padStart(5);
            const ontimeStr = String(ontime).padStart(7);
            const lateStr = String(late).padStart(6);
            const rangeCol = lateRangeStr.padEnd(26);
            const lgCol = `${loadGenMax}ms / ${loadGenP99}ms`.padEnd(21);
            const i1Col = `${inst1Stats.maxMs}ms`.padEnd(16);
            const i2Col = `${inst2Stats.maxMs}ms`.padEnd(16);

            console.log(`${roundStr} | ${ontimeStr} | ${lateStr} | ${rangeCol} | ${lgCol} | ${i1Col} | ${i2Col}`);

            roundCorrelations.push({
                round,
                ontime,
                late,
                lateLatencies,
                loadGenMax,
                loadGenP99,
                inst1Max: inst1Stats.maxMs,
                inst2Max: inst2Stats.maxMs,
            });
        }

        // Teardown
        for (const c of clients) c.close();
        clients.length = 0;
        if (typeof global.gc === 'function') global.gc();

        // Print correlation analysis
        console.log('\n========================================================================');
        console.log('📊 LAG SPIKE & LATE MESSAGE CORRELATION ANALYSIS');
        console.log('========================================================================');

        const roundsWithLate = roundCorrelations.filter(r => r.late > 0);
        const roundsWithoutLate = roundCorrelations.filter(r => r.late === 0);

        const avgLgLate = roundsWithLate.length > 0
            ? (roundsWithLate.reduce((sum, r) => sum + r.loadGenMax, 0) / roundsWithLate.length).toFixed(1)
            : 'N/A';
        const avgLgOntime = roundsWithoutLate.length > 0
            ? (roundsWithoutLate.reduce((sum, r) => sum + r.loadGenMax, 0) / roundsWithoutLate.length).toFixed(1)
            : 'N/A';

        const avgI1Late = roundsWithLate.length > 0
            ? (roundsWithLate.reduce((sum, r) => sum + r.inst1Max, 0) / roundsWithLate.length).toFixed(1)
            : 'N/A';
        const avgI1Ontime = roundsWithoutLate.length > 0
            ? (roundsWithoutLate.reduce((sum, r) => sum + r.inst1Max, 0) / roundsWithoutLate.length).toFixed(1)
            : 'N/A';

        console.log(`Rounds with late messages (>400ms): ${roundsWithLate.length} / 25`);
        console.log(`Average Load Generator Max Lag:`);
        console.log(`  - On Late Rounds:   ${avgLgLate} ms`);
        console.log(`  - On On-Time Rounds: ${avgLgOntime} ms`);
        console.log(`Average Server Instance 1 Max Lag:`);
        console.log(`  - On Late Rounds:   ${avgI1Late} ms`);
        console.log(`  - On On-Time Rounds: ${avgI1Ontime} ms`);
        console.log('========================================================================\n');

        // Save raw output
        const outPath = path.resolve(ROOT_DIR, 'benchmarks/event-loop-correlation.json');
        await fs.writeFile(outPath, JSON.stringify(roundCorrelations, null, 2));
        console.log(`📁 Saved detailed correlation log to ${outPath}`);

    } finally {
        console.log('\n[Teardown] Stopping Instance 1 and Instance 2...');
        await stopProcess(proc1);
        await stopProcess(proc2);
        console.log('✅ Done.');
    }
}

run().catch(err => {
    console.error('❌ Failed:', err);
    process.exit(1);
});
