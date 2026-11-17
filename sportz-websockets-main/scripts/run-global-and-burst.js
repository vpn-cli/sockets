import { WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_WS = process.env.TARGET_WS || 'ws://127.0.0.1:8000/ws';
const TARGET_API = process.env.TARGET_API || 'http://127.0.0.1:8000';
const LABEL = process.argv[2] || 'test';
const OUTPUT_FILE = path.resolve(__dirname, `../../benchmarks/global-burst-${LABEL}.json`);

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

async function fetchServerStats() {
    try {
        const res = await fetch(`${TARGET_API}/health`);
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

class BenchClient {
    constructor(id) {
        this.id = id;
        this.ws = null;
        this.connected = false;
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
            }, 10000);

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
                        if (autoSub) {
                            this.ws.send(JSON.stringify({ type: 'subscribe', matchId: 1 }));
                        }
                    } else if (msg.type === 'subscribed') {
                        clearTimeout(timer);
                        resolve(true);
                    } else if (msg.type === 'score_update') {
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

async function runGlobalBroadcast(clientCount = 2000) {
    console.log(`\n--- Running Global Broadcast Benchmark (N=${clientCount}, 10 rounds) ---`);
    const clients = [];
    const BATCH_SIZE = 100;
    for (let i = 0; i < clientCount; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, clientCount);
        for (let j = i; j < limit; j++) {
            const c = new BenchClient(j);
            clients.push(c);
            batch.push(c.connect(TARGET_WS, true));
        }
        await Promise.all(batch);
        await delay(20);
    }

    const connected = clients.filter(c => c.connected);
    console.log(`Connected: ${connected.length}/${clientCount}`);
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

    getLoadGenCpu();
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

        await delay(200);

        for (const c of connected) {
            if (c.receivedCount > 0) {
                actual++;
                latencies.push(...c.receivedLatencies);
            }
        }
        expected += connected.length;
    }

    const loadGenCpu = getLoadGenCpu();
    const serverStats = await fetchServerStats();
    const latMetrics = calculatePercentiles(latencies);

    console.log(`Global Deliveries: ${actual}/${expected} (Loss Rate: ${((expected-actual)/expected*100).toFixed(2)}%)`);
    console.log(`Latency (ms): min=${latMetrics.min}, p50=${latMetrics.p50}, p95=${latMetrics.p95}, p99=${latMetrics.p99}, max=${latMetrics.max}, avg=${latMetrics.avg}`);
    console.log(`Server Peak CPU: ${serverStats?.cpuPercent}% | LoadGen CPU: ${loadGenCpu}%`);

    for (const c of clients) c.close();
    await delay(1000);

    return {
        clients: connected.length,
        rounds: 10,
        payloadBytes: JSON.stringify(payload).length,
        expected,
        actual,
        latency: latMetrics,
        serverPeakCpu: serverStats?.cpuPercent ?? 0,
        loadGenCpu
    };
}

async function runColdWarmBurst(clientCount = 1000) {
    console.log(`\n--- Running Cold-Start vs Warm Subscribe Burst (N=${clientCount}) ---`);
    const clients = [];
    const BATCH_SIZE = 100;
    for (let i = 0; i < clientCount; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, clientCount);
        for (let j = i; j < limit; j++) {
            const c = new BenchClient(j);
            clients.push(c);
            batch.push(c.connect(TARGET_WS, false));
        }
        await Promise.all(batch);
        await delay(20);
    }

    const connected = clients.filter(c => c.connected);
    console.log(`Connected: ${connected.length}/${clientCount}`);
    await delay(500);

    // Cold Burst
    await fetch(`${TARGET_API}/health?resetQueries=1`);
    const idCold = 600000 + Math.floor(Math.random() * 50000);
    console.log(`Firing Cold Burst for uncached matchId=${idCold}...`);
    const coldStart = Date.now();
    await Promise.all(connected.map(c => c.subscribe(idCold)));
    const coldDuration = Date.now() - coldStart;
    const coldStats = await fetchServerStats();

    console.log(`Cold Burst Duration: ${coldDuration}ms | DB Query Duration: ${coldStats?.lastQueryDurationMs}ms | DB Queries: ${coldStats?.dbQueriesFired}`);

    // Warm Burst
    await delay(500);
    const queriesBeforeWarm = coldStats?.dbQueriesFired ?? 0;
    const idWarm = 700000 + Math.floor(Math.random() * 50000);
    console.log(`Firing Warm Burst for uncached matchId=${idWarm}...`);
    const warmStart = Date.now();
    await Promise.all(connected.map(c => c.subscribe(idWarm)));
    const warmDuration = Date.now() - warmStart;
    const warmStats = await fetchServerStats();
    const warmQueries = (warmStats?.dbQueriesFired ?? 0) - queriesBeforeWarm;

    console.log(`Warm Burst Duration: ${warmDuration}ms | DB Query Duration: ${warmStats?.lastQueryDurationMs}ms | DB Queries: ${warmQueries}`);

    for (const c of clients) c.close();
    await delay(1000);

    return {
        clients: connected.length,
        cold: {
            durationMs: coldDuration,
            dbQueryTimeMs: coldStats?.lastQueryDurationMs ?? 0,
            dbQueriesFired: coldStats?.dbQueriesFired ?? 0
        },
        warm: {
            durationMs: warmDuration,
            dbQueryTimeMs: warmStats?.lastQueryDurationMs ?? 0,
            dbQueriesFired: warmQueries
        }
    };
}

async function main() {
    console.log(`Executing Benchmark Suite: Label = ${LABEL}`);
    const globalResult = await runGlobalBroadcast(2000);
    const burstResult = await runColdWarmBurst(1000);

    const result = {
        label: LABEL,
        timestamp: new Date().toISOString(),
        globalBroadcast: globalResult,
        subscribeBurst: burstResult
    };

    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log(`\nSaved results to ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
