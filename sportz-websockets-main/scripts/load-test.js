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

const TARGET_WS = getArg('--target', process.env.TARGET_WS || 'ws://127.0.0.1:8000/ws');
const TARGET_API = getArg('--api', process.env.TARGET_API || 'http://127.0.0.1:8000');
const TIERS_ARG = getArg('--tiers', '100,500,1000,2000');
const CONCURRENCY_TIERS = TIERS_ARG.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && n > 0);
const BROADCAST_ROUNDS = Number(getArg('--rounds', '10'));
const OUTPUT_FILE = getArg('--output', path.resolve(__dirname, '../../benchmarks/baseline-raw.json'));

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
                ...(data.memory || {})
            };
        }
    } catch {
        // server might be busy or unreachable
    }
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
        this.receivedMessages = [];
    }

    connect(url) {
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
            }, 10000);

            this.ws.on('open', () => {
                this.connected = true;
            });

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    const receivedAt = Date.now();

                    if (msg.type === 'welcome') {
                        // Request subscription
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
                            data: msg
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

async function runTier(targetConcurrency, matchIds) {
    console.log(`\n======================================================`);
    console.log(`🚀 Starting Tier: N = ${targetConcurrency} concurrent sockets`);
    console.log(`======================================================`);

    const initialStats = await fetchServerStats();
    console.log(`Initial Server Memory: RSS=${initialStats?.rssMb ?? 'N/A'} MB, HeapUsed=${initialStats?.heapUsedMb ?? 'N/A'} MB`);

    const clients = [];
    const roomsCount = matchIds.length;
    let connectionErrors = 0;

    // Connect clients in staggered batches to prevent OS listen socket backlog drops
    const BATCH_SIZE = 50;
    const BATCH_DELAY_MS = 25;

    const connectStart = Date.now();
    for (let i = 0; i < targetConcurrency; i += BATCH_SIZE) {
        const batch = [];
        const limit = Math.min(i + BATCH_SIZE, targetConcurrency);
        for (let j = i; j < limit; j++) {
            const matchId = matchIds[j % roomsCount];
            const client = new LoadClient(j, matchId);
            clients.push(client);
            batch.push(client.connect(TARGET_WS));
        }
        const results = await Promise.all(batch);
        for (const success of results) {
            if (!success) connectionErrors++;
        }
        if (limit < targetConcurrency) {
            await delay(BATCH_DELAY_MS);
        }
    }

    const connectDuration = Date.now() - connectStart;
    const connectedClients = clients.filter(c => c.connected && c.subscribed);
    console.log(`Connected & Subscribed: ${connectedClients.length}/${targetConcurrency} in ${connectDuration}ms (Errors: ${connectionErrors})`);

    // Warm-up pause
    await delay(1000);

    // Fan-out latency benchmark
    // For each room, trigger BROADCAST_ROUNDS reactions from a designated publisher client
    console.log(`Publishing ${BROADCAST_ROUNDS} broadcast events per room across ${roomsCount} rooms...`);
    const allLatencies = [];
    let expectedDeliveries = 0;
    let actualDeliveries = 0;

    // Map clients by matchId
    const roomSubscribers = new Map();
    for (const matchId of matchIds) {
        roomSubscribers.set(matchId, clients.filter(c => c.connected && c.subscribed && c.matchId === matchId));
    }

    for (let round = 1; round <= BROADCAST_ROUNDS; round++) {
        for (const matchId of matchIds) {
            const subs = roomSubscribers.get(matchId) || [];
            if (subs.length === 0) continue;

            const publisher = subs[0];
            const roundStart = Date.now();

            // Clear received messages before round
            for (const c of subs) {
                c.receivedMessages = [];
            }

            publisher.sendReaction('🔥');

            // Wait for propagation
            await delay(150);

            let roundReceived = 0;
            for (const c of subs) {
                if (c.receivedMessages.length > 0) {
                    roundReceived++;
                    for (const m of c.receivedMessages) {
                        if (m.latency >= 0) {
                            allLatencies.push(m.latency);
                        }
                    }
                }
            }

            expectedDeliveries += subs.length;
            actualDeliveries += roundReceived;
        }
    }

    const midStats = await fetchServerStats();
    console.log(`Peak Server Memory: RSS=${midStats?.rssMb ?? 'N/A'} MB, HeapUsed=${midStats?.heapUsedMb ?? 'N/A'} MB`);

    const messagesLost = Math.max(0, expectedDeliveries - actualDeliveries);
    const lossRate = expectedDeliveries > 0 ? Number(((messagesLost / expectedDeliveries) * 100).toFixed(2)) : 0;
    const latencyMetrics = calculatePercentiles(allLatencies);

    console.log(`\n--- Tier Results (N=${targetConcurrency}) ---`);
    console.log(`Deliveries: ${actualDeliveries}/${expectedDeliveries} (Lost: ${messagesLost}, Loss Rate: ${lossRate}%)`);
    console.log(`Latency (ms): min=${latencyMetrics.min}, p50=${latencyMetrics.p50}, p95=${latencyMetrics.p95}, p99=${latencyMetrics.p99}, max=${latencyMetrics.max}, avg=${latencyMetrics.avg}`);

    // Teardown clients cleanly
    console.log(`Tearing down ${clients.length} sockets...`);
    for (const c of clients) {
        c.close();
    }
    await delay(1000);

    const postStats = await fetchServerStats();

    return {
        concurrency: targetConcurrency,
        rooms: roomsCount,
        connected: connectedClients.length,
        connectionErrors,
        connectDurationMs: connectDuration,
        broadcastRounds: BROADCAST_ROUNDS,
        expectedDeliveries,
        actualDeliveries,
        messagesLost,
        lossRatePercent: lossRate,
        latencyMs: latencyMetrics,
        serverMemoryMb: {
            initial: initialStats,
            peak: midStats,
            after: postStats
        }
    };
}

async function main() {
    console.log(`Starting Sportz WebSocket Load Benchmark`);
    console.log(`Target WebSocket: ${TARGET_WS}`);
    console.log(`Target API: ${TARGET_API}`);
    console.log(`Concurrency Levels: ${CONCURRENCY_TIERS.join(', ')}`);

    const matchIds = await fetchMatchIds();
    console.log(`Using Match Rooms: [${matchIds.join(', ')}]`);

    const tierResults = [];

    for (const n of CONCURRENCY_TIERS) {
        try {
            const res = await runTier(n, matchIds);
            tierResults.push(res);
        } catch (err) {
            console.error(`Error during tier N=${n}:`, err);
            tierResults.push({
                concurrency: n,
                error: err.message
            });
        }
    }

    const summaryReport = {
        timestamp: new Date().toISOString(),
        targetWs: TARGET_WS,
        targetApi: TARGET_API,
        platform: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch
        },
        results: tierResults
    };

    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(summaryReport, null, 2), 'utf8');
    console.log(`\n✅ Raw benchmark report saved to: ${OUTPUT_FILE}`);

    // Print summary markdown table
    console.log(`\n=================== BENCHMARK SUMMARY TABLE ===================`);
    console.log(`| Concurrency (N) | Connected | Errors | Messages Lost | Loss Rate | Latency p50 | Latency p95 | Latency p99 | Peak CPU | Peak RSS | Peak Heap |`);
    console.log(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const r of tierResults) {
        if (r.error) {
            console.log(`| ${r.concurrency} | FAILED | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |`);
        } else {
            console.log(`| ${r.concurrency} | ${r.connected} | ${r.connectionErrors} | ${r.messagesLost} | ${r.lossRatePercent}% | ${r.latencyMs.p50} ms | ${r.latencyMs.p95} ms | ${r.latencyMs.p99} ms | ${r.serverMemoryMb.peak?.cpuPercent ?? 'N/A'}% | ${r.serverMemoryMb.peak?.rssMb ?? 'N/A'} MB | ${r.serverMemoryMb.peak?.heapUsedMb ?? 'N/A'} MB |`);
        }
    }
    console.log(`================================================================\n`);
}

main().catch(err => {
    console.error(`Benchmark failed:`, err);
    process.exit(1);
});

