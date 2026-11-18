import { WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { configureBenchmarkDatabase } from '../src/db/guard.js';

const benchmarkDbInfo = configureBenchmarkDatabase();
console.log(`[Benchmark DB] Host: ${benchmarkDbInfo.host} (guarded local-by-default)`);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_WS = process.env.TARGET_WS || 'ws://127.0.0.1:8000/ws';
const TARGET_API = process.env.TARGET_API || 'http://127.0.0.1:8000';
const OUTPUT_FILE = path.resolve(__dirname, '../../benchmarks/repeatability-raw.json');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastGenCpuUsage = process.cpuUsage();
let lastGenCpuTime = Date.now();
function getLoadGenCpu() {
    const curCpu = process.cpuUsage();
    const curTime = Date.now();
    const elapsedMs = Math.max(1, curTime - lastGenCpuTime);
    const userDiffMs = (curCpu.user - lastGenCpuUsage.user) / 1000;
    const sysDiffMs = (curCpu.system - lastGenCpuUsage.system) / 1000;
    const cpu = Number((((userDiffMs + sysDiffMs) / elapsedMs) * 100).toFixed(1));
    lastGenCpuUsage = curCpu;
    lastGenCpuTime = curTime;
    return cpu;
}

function calculatePercentiles(latencies) {
    if (!latencies || latencies.length === 0) {
        return { min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);

    const getP = (p) => {
        const idx = Math.min(Math.floor(count * p), count - 1);
        return sorted[idx];
    };

    return {
        min: sorted[0],
        p50: getP(0.50),
        p95: getP(0.95),
        p99: getP(0.99),
        max: sorted[count - 1],
        avg: Number((sum / count).toFixed(2))
    };
}

async function fetchServerStats(forceGc = false) {
    try {
        const url = forceGc ? `${TARGET_API}/health?gc=1` : `${TARGET_API}/health`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            return {
                cpuPercent: data.cpuPercent ?? 0,
                dbQueriesFired: data.dbQueriesFired ?? 0,
                lastQueryDurationMs: data.lastQueryDurationMs ?? 0,
                ...(data.memory || {})
            };
        }
    } catch {}
    return null;
}

async function fetchMatchIds() {
    try {
        const res = await fetch(`${TARGET_API}/matches?limit=10`);
        if (res.ok) {
            const json = await res.json();
            if (Array.isArray(json.data) && json.data.length > 0) {
                return json.data.map(m => m.id);
            }
        }
    } catch {}
    return [1, 2, 3, 4, 5];
}

class FastLoadClient {
    constructor(id, matchId) {
        this.id = id;
        this.matchId = matchId;
        this.ws = null;
        this.connected = false;
        this.subscribed = false;
        this.receivedCount = 0;
        this.receivedLatencies = [];
    }

    connect(url, autoSub = true) {
        return new Promise((resolve) => {
            try {
                this.ws = new WebSocket(url);
            } catch {
                return resolve(false);
            }

            const timer = setTimeout(() => {
                if (!this.connected) {
                    try { this.ws.close(); } catch {}
                    resolve(false);
                }
            }, 15000);

            this.ws.on('open', () => {
                this.connected = true;
                if (!autoSub) {
                    clearTimeout(timer);
                    resolve(true);
                }
            });

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    const recvTime = Date.now();

                    if (msg.type === 'welcome') {
                        if (autoSub && this.matchId) {
                            this.ws.send(JSON.stringify({ type: 'subscribe', matchId: this.matchId }));
                        }
                    } else if (msg.type === 'subscribed') {
                        this.subscribed = true;
                        clearTimeout(timer);
                        resolve(true);
                    } else if (msg.type === 'reaction_broadcast' || msg.type === 'score_update') {
                        this.receivedCount++;
                        if (msg.serverTimestamp) {
                            this.receivedLatencies.push(recvTime - msg.serverTimestamp);
                        }
                    }
                } catch {}
            });

            this.ws.on('error', () => {
                clearTimeout(timer);
                resolve(false);
            });

            this.ws.on('close', () => {
                this.connected = false;
            });
        });
    }

    subscribe(matchId) {
        return new Promise((resolve) => {
            this.matchId = matchId;
            const onMsg = (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    if (msg.type === 'subscribed' || msg.type === 'error') {
                        this.ws.off('message', onMsg);
                        resolve(msg);
                    }
                } catch {}
            };
            this.ws.on('message', onMsg);
            this.ws.send(JSON.stringify({ type: 'subscribe', matchId }));
        });
    }

    sendReaction(emoji = '🔥') {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'reaction', matchId: this.matchId, emoji }));
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

async function runTierOnce(N, matchIds, rounds = 5) {
    const clients = [];
    const roomsCount = matchIds.length;
    const BATCH_SIZE = 100;

    for (let i = 0; i < N; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, N);
        for (let j = i; j < limit; j++) {
            const client = new FastLoadClient(j, matchIds[j % roomsCount]);
            clients.push(client);
            batch.push(client.connect(TARGET_WS, true));
        }
        await Promise.all(batch);
        await delay(20);
    }

    const connected = clients.filter(c => c.connected && c.subscribed);
    await delay(500);

    const roomSubs = new Map();
    for (const id of matchIds) {
        roomSubs.set(id, clients.filter(c => c.connected && c.subscribed && c.matchId === id));
    }

    const allLatencies = [];
    let expected = 0;
    let actual = 0;

    for (let r = 1; r <= rounds; r++) {
        for (const id of matchIds) {
            const subs = roomSubs.get(id) || [];
            if (subs.length === 0) continue;

            for (const c of subs) {
                c.receivedCount = 0;
                c.receivedLatencies = [];
            }

            subs[0].sendReaction('🔥');
            await delay(150);

            for (const c of subs) {
                if (c.receivedCount > 0) {
                    actual++;
                    allLatencies.push(...c.receivedLatencies);
                }
            }
            expected += subs.length;
        }
    }

    const lost = expected - actual;
    const lossRate = expected > 0 ? Number(((lost / expected) * 100).toFixed(2)) : 0;
    const lat = calculatePercentiles(allLatencies);

    for (const c of clients) c.close();
    await delay(500);

    return {
        concurrency: N,
        connected: connected.length,
        expected,
        actual,
        lost,
        lossRate,
        latency: lat
    };
}

function computeStats(runs) {
    const losses = runs.map(r => r.lost);
    const lossRates = runs.map(r => r.lossRate);
    const p50s = runs.map(r => r.latency.p50);
    const p95s = runs.map(r => r.latency.p95);

    const avg = arr => Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
    const min = arr => Math.min(...arr);
    const max = arr => Math.max(...arr);

    return {
        runsCount: runs.length,
        loss: { min: min(losses), max: max(losses), mean: avg(losses) },
        lossRatePercent: { min: min(lossRates), max: max(lossRates), mean: avg(lossRates) },
        p50Ms: { min: min(p50s), max: max(p50s), mean: avg(p50s) },
        p95Ms: { min: min(p95s), max: max(p95s), mean: avg(p95s) }
    };
}

async function runGlobalBroadcastOnce(clientCount = 2000) {
    const clients = [];
    const BATCH_SIZE = 100;
    for (let i = 0; i < clientCount; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, clientCount);
        for (let j = i; j < limit; j++) {
            const client = new FastLoadClient(j, 1);
            clients.push(client);
            batch.push(client.connect(TARGET_WS, true));
        }
        await Promise.all(batch);
        await delay(20);
    }

    const connected = clients.filter(c => c.connected);
    await delay(500);

    const payload = {
        matchId: 1,
        sport: 'football',
        homeTeam: 'Real Madrid',
        awayTeam: 'Barcelona',
        homeScore: 2,
        awayScore: 1,
        period: '2nd-half',
        minute: 78,
        status: 'live',
        lastEvent: 'Goal scored by Jude Bellingham from 22 yards out assisted by Vinicius Jr.',
        stats: {
            possession: [48, 52],
            shots: [12, 15],
            shotsOnTarget: [5, 7],
            corners: [4, 6],
            fouls: [8, 11]
        }
    };

    const latencies = [];
    let expected = 0;
    let actual = 0;

    for (let r = 1; r <= 10; r++) {
        for (const c of connected) {
            c.receivedCount = 0;
            c.receivedLatencies = [];
        }

        await fetch(`${TARGET_API}/benchmark/broadcast-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        await delay(180);

        for (const c of connected) {
            if (c.receivedCount > 0) {
                actual++;
                latencies.push(...c.receivedLatencies);
            }
        }
        expected += connected.length;
    }

    const serverStats = await fetchServerStats(false);
    const latMetrics = calculatePercentiles(latencies);

    for (const c of clients) c.close();
    await delay(500);

    return {
        clients: connected.length,
        rounds: 10,
        expected,
        actual,
        lossRate: ((expected - actual) / expected * 100).toFixed(2),
        latency: latMetrics,
        serverPeakCpu: serverStats?.cpuPercent ?? 0
    };
}

async function runColdWarmBurst(clientCount = 1000) {
    const clients = [];
    const BATCH_SIZE = 100;
    for (let i = 0; i < clientCount; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, clientCount);
        for (let j = i; j < limit; j++) {
            const client = new FastLoadClient(j, null);
            clients.push(client);
            batch.push(client.connect(TARGET_WS, false));
        }
        await Promise.all(batch);
        await delay(20);
    }

    const connected = clients.filter(c => c.connected);
    await delay(500);

    // Cold Burst
    const idCold = 711000 + Math.floor(Math.random() * 50000);
    const coldStart = Date.now();
    await Promise.all(connected.map(c => c.subscribe(idCold)));
    const coldDuration = Date.now() - coldStart;
    const coldStats = await fetchServerStats(false);

    // Warm Burst
    await delay(500);
    const idWarm = 811000 + Math.floor(Math.random() * 50000);
    const warmStart = Date.now();
    await Promise.all(connected.map(c => c.subscribe(idWarm)));
    const warmDuration = Date.now() - warmStart;
    const warmStats = await fetchServerStats(false);

    for (const c of clients) c.close();
    await delay(500);

    return {
        clients: connected.length,
        cold: {
            durationMs: coldDuration,
            dbQueryTimeMs: coldStats?.lastQueryDurationMs ?? 0
        },
        warm: {
            durationMs: warmDuration,
            dbQueryTimeMs: warmStats?.lastQueryDurationMs ?? 0
        }
    };
}

async function main() {
    console.log(`Starting Repeatability & Verification Benchmarking Suite`);
    const matchIds = await fetchMatchIds();

    console.log(`\n--- Running 5 Iterations of Tier 5,000 ---`);
    const tier5000Runs = [];
    for (let i = 1; i <= 5; i++) {
        console.log(`Run ${i}/5 for N=5,000...`);
        const res = await runTierOnce(5000, matchIds, 5);
        console.log(`  Run ${i}: Lost=${res.lost} (${res.lossRate}%), p50=${res.latency.p50}ms, p95=${res.latency.p95}ms`);
        tier5000Runs.push(res);
    }
    const tier5000Stats = computeStats(tier5000Runs);

    console.log(`\n--- Running 5 Iterations of Tier 10,000 ---`);
    const tier10000Runs = [];
    for (let i = 1; i <= 5; i++) {
        console.log(`Run ${i}/5 for N=10,000...`);
        const res = await runTierOnce(10000, matchIds, 5);
        console.log(`  Run ${i}: Lost=${res.lost} (${res.lossRate}%), p50=${res.latency.p50}ms, p95=${res.latency.p95}ms`);
        tier10000Runs.push(res);
    }
    const tier10000Stats = computeStats(tier10000Runs);

    console.log(`\n--- Running Global Broadcast Benchmark (broadcastToAll) ---`);
    const globalRes = await runGlobalBroadcastOnce(2000);
    console.log(`Global Broadcast (2,000 clients, 10 rounds): p50=${globalRes.latency.p50}ms, p95=${globalRes.latency.p95}ms, p99=${globalRes.latency.p99}ms, Server CPU=${globalRes.serverPeakCpu}%`);

    console.log(`\n--- Running Cold vs Warm Subscribe Burst (1,000 clients) ---`);
    const burstRes = await runColdWarmBurst(1000);
    console.log(`Cold Burst: ${burstRes.cold.durationMs}ms (DB Query Time: ${burstRes.cold.dbQueryTimeMs}ms)`);
    console.log(`Warm Burst: ${burstRes.warm.durationMs}ms (DB Query Time: ${burstRes.warm.dbQueryTimeMs}ms)`);

    const report = {
        timestamp: new Date().toISOString(),
        tier5000: { runs: tier5000Runs, stats: tier5000Stats },
        tier10000: { runs: tier10000Runs, stats: tier10000Stats },
        globalBroadcast: globalRes,
        coldWarmBurst: burstRes
    };

    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n✅ Repeatability report saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error('Repeatability suite failed:', err);
    process.exit(1);
});

