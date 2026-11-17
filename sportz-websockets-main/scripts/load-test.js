import { WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Command line arguments
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
    const index = args.indexOf(flag);
    if (index !== -1 && index + 1 < args.length) {
        return args[index + 1];
    }
    return defaultValue;
}

const TARGETS_ARG = getArg('--targets', '');
const TARGET_WS_LIST = TARGETS_ARG
    ? TARGETS_ARG.split(',').map(s => s.trim()).filter(Boolean)
    : [getArg('--target', process.env.TARGET_WS || 'ws://127.0.0.1:8000/ws')];

const APIS_ARG = getArg('--apis', '');
const TARGET_API_LIST = APIS_ARG
    ? APIS_ARG.split(',').map(s => s.trim()).filter(Boolean)
    : [getArg('--api', process.env.TARGET_API || 'http://127.0.0.1:8000')];

const TARGET_WS = TARGET_WS_LIST[0];
const TARGET_API = TARGET_API_LIST[0];

const TIERS_ARG = getArg('--tiers', '100,500,1000,2000,5000');
const CONCURRENCY_TIERS = TIERS_ARG.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && n > 0);
const BROADCAST_ROUNDS = Number(getArg('--rounds', '10'));
const REPEAT_COUNT = Number(getArg('--repeat', '1'));
const COOLDOWN_SEC = Number(getArg('--cooldown', '10'));
const MODE = getArg('--mode', 'all'); // 'all', 'tiers', 'global', 'coldstart'
const OUTPUT_FILE = getArg('--output', path.resolve(__dirname, '../../benchmarks/phase2-raw.json'));

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load Generator CPU Tracker
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
    const allStats = [];
    for (const api of TARGET_API_LIST) {
        try {
            const url = forceGc ? `${api}/health?gc=1` : `${api}/health`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                allStats.push({
                    api,
                    cpuPercent: data.cpuPercent ?? 0,
                    dbQueriesFired: data.dbQueriesFired ?? 0,
                    lastQueryDurationMs: data.lastQueryDurationMs ?? 0,
                    ...(data.memory || {})
                });
            }
        } catch {
            // server might be busy or unreachable
        }
    }

    if (allStats.length === 0) return null;
    if (allStats.length === 1) return allStats[0];

    // Aggregate stats across instances
    const totalCpu = Number(allStats.reduce((sum, s) => sum + (s.cpuPercent || 0), 0).toFixed(1));
    const totalRss = Number(allStats.reduce((sum, s) => sum + (s.rssMb || 0), 0).toFixed(1));
    const totalHeap = Number(allStats.reduce((sum, s) => sum + (s.heapUsedMb || 0), 0).toFixed(1));

    return {
        instances: allStats.length,
        cpuPercent: totalCpu,
        rssMb: totalRss,
        heapUsedMb: totalHeap,
        details: allStats
    };
}

async function resetServerDbQueries() {
    try {
        await fetch(`${TARGET_API}/health?resetQueries=1`);
    } catch {}
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
    } catch (e) {
        console.warn(`[Warn] Could not fetch matches from API: ${e.message}`);
    }
    return [1, 2, 3, 4, 5];
}

class LoadClient {
    constructor(id, matchId) {
        this.id = id;
        this.matchId = matchId;
        this.ws = null;
        this.connected = false;
        this.subscribed = false;
        this.error = null;
        this.closeCode = null;
        this.receivedMessages = [];
    }

    connect(url, autoSubscribe = true) {
        return new Promise((resolve) => {
            try {
                this.ws = new WebSocket(url);
            } catch (err) {
                this.error = err.message;
                return resolve(false);
            }

            const timeout = setTimeout(() => {
                if (!this.connected) {
                    this.error = 'Connection timeout';
                    try { this.ws.close(); } catch {}
                    resolve(false);
                }
            }, 15000);

            this.ws.on('open', () => {
                this.connected = true;
                if (!autoSubscribe) {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    const receivedAt = Date.now();

                    if (msg.type === 'welcome') {
                        if (autoSubscribe && this.matchId) {
                            this.ws.send(JSON.stringify({ type: 'subscribe', matchId: this.matchId }));
                        }
                    } else if (msg.type === 'subscribed') {
                        this.subscribed = true;
                        clearTimeout(timeout);
                        resolve(true);
                    } else if (msg.type === 'error') {
                        this.lastServerError = msg.message;
                        clearTimeout(timeout);
                        resolve(true);
                    } else if (msg.type === 'reaction_broadcast' || msg.type === 'commentary' || msg.type === 'score_update') {
                        this.receivedMessages.push({
                            type: msg.type,
                            serverTimestamp: msg.serverTimestamp,
                            receivedAt,
                            latency: msg.serverTimestamp ? (receivedAt - msg.serverTimestamp) : 0
                        });
                    }
                } catch {
                    // Ignore parsing error
                }
            });

            this.ws.on('error', (err) => {
                this.error = err.message;
                clearTimeout(timeout);
                resolve(false);
            });

            this.ws.on('close', (code, reason) => {
                this.connected = false;
                this.closeCode = code;
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
            this.ws.send(JSON.stringify({
                type: 'reaction',
                matchId: this.matchId,
                emoji
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

// -------------------------------------------------------------
// BENCHMARK 1: Concurrency Scaling & Breaking Point Test
// -------------------------------------------------------------
async function runTier(targetConcurrency, matchIds) {
    console.log(`\n======================================================`);
    console.log(`🚀 Starting Concurrency Tier: N = ${targetConcurrency} sockets`);
    console.log(`======================================================`);

    getLoadGenCpu();
    const initialStats = await fetchServerStats(true);
    console.log(`Initial Server Memory (post-GC): RSS=${initialStats?.rssMb ?? 'N/A'} MB, HeapUsed=${initialStats?.heapUsedMb ?? 'N/A'} MB`);

    const clients = [];
    const roomsCount = Math.min(matchIds.length, 5);
    const activeMatchIds = matchIds.slice(0, roomsCount);
    let connectionErrors = 0;
    const errorDetails = new Map();

    const BATCH_SIZE = 100;
    const BATCH_DELAY_MS = 25;

    const connectStart = Date.now();
    for (let i = 0; i < targetConcurrency; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, targetConcurrency);
        for (let j = i; j < limit; j++) {
            const matchId = activeMatchIds[j % roomsCount];
            const client = new LoadClient(j, matchId);
            clients.push(client);
            const targetWs = TARGET_WS_LIST[j % TARGET_WS_LIST.length];
            batch.push(client.connect(targetWs, true));
        }
        const results = await Promise.all(batch);
        for (let idx = 0; idx < results.length; idx++) {
            if (!results[idx]) {
                connectionErrors++;
                const err = clients[i + idx].error || 'Unknown error';
                errorDetails.set(err, (errorDetails.get(err) || 0) + 1);
            }
        }
        if (limit < targetConcurrency) {
            await delay(BATCH_DELAY_MS);
        }
    }

    const connectDuration = Date.now() - connectStart;
    const connectedClients = clients.filter(c => c.connected && c.subscribed);
    console.log(`Connected & Subscribed: ${connectedClients.length}/${targetConcurrency} in ${connectDuration}ms (Errors: ${connectionErrors})`);

    if (errorDetails.size > 0) {
        console.log(`Error Breakdown:`, Object.fromEntries(errorDetails));
    }

    // If connection failure exceeds 50%, mark breaking point and teardown
    if (connectedClients.length < targetConcurrency * 0.5) {
        console.warn(`⚠️ Major connection failure encountered at N=${targetConcurrency}. Breaking point reached.`);
        for (const c of clients) c.close();
        return {
            concurrency: targetConcurrency,
            connected: connectedClients.length,
            connectionErrors,
            errorDetails: Object.fromEntries(errorDetails),
            failed: true,
            failureReason: 'OS socket or connection limit exhausted'
        };
    }

    await delay(500);

    // Fan-out latency benchmark
    console.log(`Publishing ${BROADCAST_ROUNDS} broadcast events per room across ${roomsCount} rooms...`);
    const allLatencies = [];
    let expectedDeliveries = 0;
    let actualDeliveries = 0;
    let ontimeDeliveries = 0;
    let lateDeliveries = 0;
    let undeliveredDeliveries = 0;

    const roomSubscribers = new Map();
    for (const matchId of activeMatchIds) {
        roomSubscribers.set(matchId, clients.filter(c => c.connected && c.subscribed && c.matchId === matchId));
    }

    getLoadGenCpu();
    for (let round = 1; round <= BROADCAST_ROUNDS; round++) {
        for (const matchId of activeMatchIds) {
            const subs = roomSubscribers.get(matchId) || [];
            if (subs.length === 0) continue;

            const publisher = subs[0];

            for (const c of subs) {
                c.receivedMessages = [];
            }

            publisher.sendReaction('🔥');

            // Wait 150ms for on-time SLA window
            await delay(150);
            // Wait additional 250ms buffer to collect late deliveries (>150ms) without false drops
            await delay(250);

            let roundOntime = 0;
            let roundLate = 0;
            let roundUndelivered = 0;

            for (const c of subs) {
                if (c.receivedMessages.length > 0) {
                    for (const m of c.receivedMessages) {
                        if (m.latency >= 0) {
                            allLatencies.push(m.latency);
                            if (m.latency <= 150) {
                                roundOntime++;
                            } else {
                                roundLate++;
                            }
                        }
                    }
                } else {
                    roundUndelivered++;
                }
            }

            expectedDeliveries += subs.length;
            actualDeliveries += (roundOntime + roundLate);
            ontimeDeliveries += roundOntime;
            lateDeliveries += roundLate;
            undeliveredDeliveries += roundUndelivered;
        }
    }

    const loadGenCpu = getLoadGenCpu();
    const midStats = await fetchServerStats(false);
    console.log(`Peak Server CPU: ${midStats?.cpuPercent ?? 'N/A'}% | Load-Gen CPU: ${loadGenCpu}%`);
    console.log(`Peak Server Memory: RSS=${midStats?.rssMb ?? 'N/A'} MB, HeapUsed=${midStats?.heapUsedMb ?? 'N/A'} MB`);

    const lateRate = expectedDeliveries > 0 ? Number(((lateDeliveries / expectedDeliveries) * 100).toFixed(2)) : 0;
    const undeliveredRate = expectedDeliveries > 0 ? Number(((undeliveredDeliveries / expectedDeliveries) * 100).toFixed(2)) : 0;
    const latencyMetrics = calculatePercentiles(allLatencies);

    console.log(`--- Results (N=${targetConcurrency}) ---`);
    console.log(`Deliveries: ${actualDeliveries}/${expectedDeliveries} (Ontime: ${ontimeDeliveries}, Late >150ms: ${lateDeliveries} [${lateRate}%], Undelivered: ${undeliveredDeliveries} [${undeliveredRate}%])`);
    console.log(`Latency (ms): min=${latencyMetrics.min}, p50=${latencyMetrics.p50}, p95=${latencyMetrics.p95}, p99=${latencyMetrics.p99}, max=${latencyMetrics.max}, avg=${latencyMetrics.avg}`);

    console.log(`Tearing down ${clients.length} sockets...`);
    for (const c of clients) c.close();
    console.log(`Cooling down ${COOLDOWN_SEC}s to let sockets drain...`);
    await delay(COOLDOWN_SEC * 1000);

    const postStats = await fetchServerStats(true);

    return {
        concurrency: targetConcurrency,
        rooms: roomsCount,
        connected: connectedClients.length,
        connectionErrors,
        errorDetails: Object.fromEntries(errorDetails),
        connectDurationMs: connectDuration,
        broadcastRounds: BROADCAST_ROUNDS,
        expectedDeliveries,
        actualDeliveries,
        ontimeDeliveries,
        lateDeliveries,
        lateRatePercent: lateRate,
        undeliveredDeliveries,
        undeliveredRatePercent: undeliveredRate,
        latencyMs: latencyMetrics,
        loadGenCpuPercent: loadGenCpu,
        serverStats: {
            initial: initialStats,
            peak: midStats,
            afterGc: postStats
        }
    };
}

// -------------------------------------------------------------
// BENCHMARK 2: Global Broadcast Fan-Out Benchmark (broadcastToAll)
// -------------------------------------------------------------
async function runGlobalBroadcastBenchmark(clientCount = 2000) {
    console.log(`\n======================================================`);
    console.log(`📢 BENCHMARK 2: Global Broadcast (broadcastToAll) at N=${clientCount}`);
    console.log(`======================================================`);

    const clients = [];
    console.log(`Connecting ${clientCount} sockets...`);
    const BATCH_SIZE = 100;
    for (let i = 0; i < clientCount; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, clientCount);
        for (let j = i; j < limit; j++) {
            const client = new LoadClient(j, 1);
            clients.push(client);
            batch.push(client.connect(TARGET_WS, true));
        }
        await Promise.all(batch);
        await delay(25);
    }

    const connected = clients.filter(c => c.connected);
    console.log(`Connected ${connected.length}/${clientCount} sockets.`);
    await delay(1000);

    // Realistic score update payload (~500 bytes)
    const realisticScorePayload = {
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

    console.log(`Triggering 10 global broadcast rounds with ~500B payload to ALL ${connected.length} sockets...`);
    const globalLatencies = [];
    let expectedTotal = 0;
    let receivedTotal = 0;

    getLoadGenCpu();
    for (let round = 1; round <= 10; round++) {
        for (const c of connected) {
            c.receivedMessages = [];
        }

        const res = await fetch(`${TARGET_API}/benchmark/broadcast-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(realisticScorePayload)
        });

        await delay(200);

        let roundRecv = 0;
        for (const c of connected) {
            const scoreMsgs = c.receivedMessages.filter(m => m.type === 'score_update');
            if (scoreMsgs.length > 0) {
                roundRecv++;
                for (const m of scoreMsgs) {
                    if (m.latency >= 0) globalLatencies.push(m.latency);
                }
            }
        }

        expectedTotal += connected.length;
        receivedTotal += roundRecv;
    }

    const serverStats = await fetchServerStats(false);
    const loadGenCpu = getLoadGenCpu();
    const latMetrics = calculatePercentiles(globalLatencies);

    console.log(`--- Global Broadcast Results ---`);
    console.log(`Deliveries: ${receivedTotal}/${expectedTotal} (Loss Rate: ${((expectedTotal - receivedTotal)/expectedTotal*100).toFixed(2)}%)`);
    console.log(`Latency (ms): p50=${latMetrics.p50}, p95=${latMetrics.p95}, p99=${latMetrics.p99}, max=${latMetrics.max}, avg=${latMetrics.avg}`);
    console.log(`Server Peak CPU: ${serverStats?.cpuPercent}% | Server Heap: ${serverStats?.heapUsedMb} MB`);

    for (const c of clients) c.close();
    await delay(1000);

    return {
        type: 'global_broadcast',
        clients: connected.length,
        payloadBytes: JSON.stringify(realisticScorePayload).length,
        rounds: 10,
        expectedTotal,
        receivedTotal,
        latencyMs: latMetrics,
        serverCpuPercent: serverStats?.cpuPercent ?? 0,
        loadGenCpuPercent: loadGenCpu,
        serverMemory: serverStats
    };
}

// -------------------------------------------------------------
// BENCHMARK 3: Cold-Start Subscribe Burst (checkMatchExists DB Dedupe)
// -------------------------------------------------------------
async function runColdStartSubscribeBurst(clientCount = 1000) {
    console.log(`\n======================================================`);
    console.log(`⚡ BENCHMARK 3: Cold-Start Subscribe Burst (N=${clientCount})`);
    console.log(`======================================================`);

    const clients = [];
    console.log(`Connecting ${clientCount} sockets (without subscribing)...`);
    const BATCH_SIZE = 100;
    for (let i = 0; i < clientCount; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, clientCount);
        for (let j = i; j < limit; j++) {
            const client = new LoadClient(j, null);
            clients.push(client);
            batch.push(client.connect(TARGET_WS, false));
        }
        await Promise.all(batch);
        await delay(25);
    }

    const connected = clients.filter(c => c.connected);
    console.log(`Connected ${connected.length}/${clientCount} clients.`);

    // Reset query counter on server
    await resetServerDbQueries();
    await delay(500);

    const statsBefore = await fetchServerStats(false);
    console.log(`DB queries before burst: ${statsBefore?.dbQueriesFired ?? 0}`);

    // Burst 1: Cold DB Burst
    const uncachedMatchId1 = 888800 + Math.floor(Math.random() * 10000);
    console.log(`Firing Cold subscribe burst for uncached matchId=${uncachedMatchId1}...`);
    const coldStart = Date.now();
    await Promise.all(connected.map(c => c.subscribe(uncachedMatchId1)));
    const coldDurationMs = Date.now() - coldStart;
    const coldStats = await fetchServerStats(false);
    const coldDbQueries = (coldStats?.dbQueriesFired ?? 0) - (statsBefore?.dbQueriesFired ?? 0);
    const coldDbQueryTimeMs = coldStats?.lastQueryDurationMs ?? 0;

    console.log(`Cold burst completed in ${coldDurationMs}ms (DB query time: ${coldDbQueryTimeMs}ms, DB queries: ${coldDbQueries}).`);

    // Burst 2: Warm DB Burst (connection pool already active and warm)
    await delay(500);
    const queriesBeforeWarm = coldStats?.dbQueriesFired ?? 0;
    const uncachedMatchId2 = 988800 + Math.floor(Math.random() * 10000);
    console.log(`Firing Warm subscribe burst for uncached matchId=${uncachedMatchId2}...`);
    const warmStart = Date.now();
    await Promise.all(connected.map(c => c.subscribe(uncachedMatchId2)));
    const warmDurationMs = Date.now() - warmStart;
    const warmStats = await fetchServerStats(false);
    const warmDbQueries = (warmStats?.dbQueriesFired ?? 0) - queriesBeforeWarm;
    const warmDbQueryTimeMs = warmStats?.lastQueryDurationMs ?? 0;

    console.log(`Warm burst completed in ${warmDurationMs}ms (DB query time: ${warmDbQueryTimeMs}ms, DB queries: ${warmDbQueries}).`);

    for (const c of clients) c.close();
    await delay(1000);

    return {
        type: 'cold_start_subscribe_burst',
        clients: connected.length,
        cold: {
            matchId: uncachedMatchId1,
            durationMs: coldDurationMs,
            dbQueryTimeMs: coldDbQueryTimeMs,
            dbQueriesFired: coldDbQueries
        },
        warm: {
            matchId: uncachedMatchId2,
            durationMs: warmDurationMs,
            dbQueryTimeMs: warmDbQueryTimeMs,
            dbQueriesFired: warmDbQueries
        }
    };
}

async function main() {
    console.log(`======================================================`);
    console.log(`   SPORTZ COMPREHENSIVE BASELINE BENCHMARK SUITE      `);
    console.log(`======================================================`);
    console.log(`Target: ${TARGET_WS} | API: ${TARGET_API}`);
    console.log(`Platform: Node ${process.version} (${process.platform} ${process.arch})`);
    console.log(`Mode: ${MODE}\n`);

    const matchIds = await fetchMatchIds();
    console.log(`Using Match Rooms: [${matchIds.join(', ')}]`);

    const fullReport = {
        timestamp: new Date().toISOString(),
        mode: MODE,
        platform: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch
        },
        concurrencyTiers: [],
        globalBroadcast: null,
        coldStartBurst: null
    };

    if (MODE === 'all' || MODE === 'tiers') {
        for (const n of CONCURRENCY_TIERS) {
            const tierRuns = [];
            let failed = false;
            for (let r = 1; r <= REPEAT_COUNT; r++) {
                if (REPEAT_COUNT > 1) {
                    console.log(`\n>>> Tier N=${n} (Run ${r}/${REPEAT_COUNT}) <<<`);
                }
                try {
                    const res = await runTier(n, matchIds);
                    tierRuns.push(res);
                    if (res.failed) {
                        failed = true;
                        break;
                    }
                } catch (err) {
                    console.error(`Tier N=${n} Run ${r} encountered error:`, err);
                    tierRuns.push({ concurrency: n, error: err.message, failed: true });
                    failed = true;
                    break;
                }
            }

            if (tierRuns.length === 1) {
                fullReport.concurrencyTiers.push(tierRuns[0]);
            } else {
                const successfulRuns = tierRuns.filter(r => !r.failed);
                if (successfulRuns.length > 0) {
                    const p50s = successfulRuns.map(r => r.latencyMs.p50);
                    const p95s = successfulRuns.map(r => r.latencyMs.p95);
                    const p99s = successfulRuns.map(r => r.latencyMs.p99);
                    const lateRates = successfulRuns.map(r => r.lateRatePercent);
                    const undeliveredRates = successfulRuns.map(r => r.undeliveredRatePercent);

                    const calcStats = (arr) => ({
                        mean: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)),
                        min: Math.min(...arr),
                        max: Math.max(...arr)
                    });

                    fullReport.concurrencyTiers.push({
                        concurrency: n,
                        repeatCount: REPEAT_COUNT,
                        runs: tierRuns,
                        summary: {
                            p50: calcStats(p50s),
                            p95: calcStats(p95s),
                            p99: calcStats(p99s),
                            lateRatePercent: calcStats(lateRates),
                            undeliveredRatePercent: calcStats(undeliveredRates)
                        }
                    });
                } else {
                    fullReport.concurrencyTiers.push({ concurrency: n, failed: true, runs: tierRuns });
                }
            }

            if (failed) {
                console.warn(`Stopping higher tiers as failure was reached at N=${n}.`);
                break;
            }
        }
    }

    if (MODE === 'all' || MODE === 'global') {
        try {
            fullReport.globalBroadcast = await runGlobalBroadcastBenchmark(2000);
        } catch (err) {
            console.error(`Global broadcast benchmark failed:`, err);
            fullReport.globalBroadcast = { error: err.message };
        }
    }

    if (MODE === 'all' || MODE === 'coldstart') {
        try {
            fullReport.coldStartBurst = await runColdStartSubscribeBurst(1000);
        } catch (err) {
            console.error(`Cold-start burst benchmark failed:`, err);
            fullReport.coldStartBurst = { error: err.message };
        }
    }

    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(fullReport, null, 2), 'utf8');
    console.log(`\n✅ Full benchmark report written to: ${OUTPUT_FILE}`);

    // Print Tables
    if (fullReport.concurrencyTiers.length > 0) {
        console.log(`\n=================== CONCURRENCY BENCHMARK RESULTS ===================`);
        console.log(`| Concurrency (N) | Connected | Errors | Late (>150ms) | Undelivered | Latency p50 | Latency p95 | Latency p99 |`);
        console.log(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
        for (const item of fullReport.concurrencyTiers) {
            if (item.failed) {
                console.log(`| ${item.concurrency} | FAILED | N/A | N/A | N/A | N/A | N/A | N/A |`);
            } else if (item.summary) {
                const s = item.summary;
                console.log(`| ${item.concurrency} (${item.repeatCount} runs) | Mean | 0 | ${s.lateRatePercent.mean}% [${s.lateRatePercent.min}-${s.lateRatePercent.max}%] | ${s.undeliveredRatePercent.mean}% [${s.undeliveredRatePercent.min}-${s.undeliveredRatePercent.max}%] | ${s.p50.mean} ms [${s.p50.min}-${s.p50.max}] | ${s.p95.mean} ms [${s.p95.min}-${s.p95.max}] | ${s.p99.mean} ms [${s.p99.min}-${s.p99.max}] |`);
            } else {
                console.log(`| ${item.concurrency} | ${item.connected} | ${item.connectionErrors} | ${item.lateDeliveries} (${item.lateRatePercent}%) | ${item.undeliveredDeliveries} (${item.undeliveredRatePercent}%) | ${item.latencyMs.p50} ms | ${item.latencyMs.p95} ms | ${item.latencyMs.p99} ms |`);
            }
        }
    }

    if (fullReport.globalBroadcast && !fullReport.globalBroadcast.error) {
        const gb = fullReport.globalBroadcast;
        console.log(`\n=================== GLOBAL BROADCAST (broadcastToAll) ===================`);
        console.log(`Payload: ~${gb.payloadBytes} bytes | Clients: ${gb.clients} | Rounds: ${gb.rounds}`);
        console.log(`Latency: p50=${gb.latencyMs.p50}ms, p95=${gb.latencyMs.p95}ms, p99=${gb.latencyMs.p99}ms, max=${gb.latencyMs.max}ms`);
        console.log(`Server Peak CPU: ${gb.serverCpuPercent}% | LoadGen CPU: ${gb.loadGenCpuPercent}%`);
    }

    if (fullReport.coldStartBurst && !fullReport.coldStartBurst.error) {
        const cs = fullReport.coldStartBurst;
        console.log(`\n=================== COLD-START SUBSCRIBE BURST (1,000 Clients) ===================`);
        console.log(`Cold Burst: Total Duration=${cs.cold.durationMs}ms | DB Query Time=${cs.cold.dbQueryTimeMs}ms | DB Queries=${cs.cold.dbQueriesFired}`);
        console.log(`Warm Burst: Total Duration=${cs.warm.durationMs}ms | DB Query Time=${cs.warm.dbQueryTimeMs}ms | DB Queries=${cs.warm.dbQueriesFired}`);
    }
}

main().catch(err => {
    console.error(`Suite execution failed:`, err);
    process.exit(1);
});
