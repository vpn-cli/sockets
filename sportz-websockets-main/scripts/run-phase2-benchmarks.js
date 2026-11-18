import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import Redis from 'ioredis';
import { configureBenchmarkDatabase } from '../src/db/guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const benchmarkDbInfo = configureBenchmarkDatabase();
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
console.log(`[Benchmark DB] Host: ${benchmarkDbInfo.host} (guarded local-by-default)`);

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return true;
        } catch { }
        await delay(300);
    }
    throw new Error(`Timeout waiting for ${url}`);
}

async function prewarmServer(wsUrl, matchIds = [1, 2, 3, 4, 5]) {
    console.log(`Pre-warming DB lookups and socket handlers on ${wsUrl}...`);
    try {
        const { WebSocket } = await import('ws');
        const client = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            client.on('open', resolve);
            client.on('error', reject);
        });
        for (const matchId of matchIds) {
            client.send(JSON.stringify({ type: 'subscribe', matchId }));
        }
        await delay(1200);
        client.close();
        await delay(500);
        console.log(`✅ Pre-warm complete for ${wsUrl}`);
    } catch (e) {
        console.warn(`Pre-warming warning:`, e.message);
    }
}

function spawnServer(port, extraEnv = {}) {
    const proc = spawn(process.execPath, [path.resolve(ROOT_DIR, 'src/index.js')], {
        cwd: ROOT_DIR,
        env: {
            ...process.env,
            PORT: String(port),
            DATABASE_URL: process.env.DATABASE_URL,
            SPORTZ_BENCHMARK: '1',
            BENCHMARK_BYPASS_ARCJET: '1',
            AUTO_SEED: 'false',
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(`[Server:${port}] ${text}`);
    });
    proc.stderr.on('data', (d) => {
        process.stderr.write(`[Server:${port}:err] ${d.toString()}`);
    });

    return proc;
}

async function stopProcess(proc) {
    if (!proc || proc.killed) return;
    try {
        if (process.platform === 'win32') {
            try {
                execSync(`taskkill /pid ${proc.pid} /f /t`, { stdio: 'ignore' });
            } catch { }
        } else {
            proc.kill('SIGTERM');
        }
    } catch { }
    await delay(1000);
}

function runBenchmarkScript(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [path.resolve(__dirname, 'load-test.js'), ...args], {
            cwd: ROOT_DIR,
            env: process.env,
            stdio: 'inherit'
        });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Benchmark failed with code ${code}`));
        });
        proc.on('error', reject);
    });
}

async function main() {
    const args = process.argv.slice(2);
    const forcePart1 = args.includes('--force-part1');
    const runPart2Only = args.includes('--part2-only');

    console.log(`================================================================`);
    console.log(`   PHASE 2: HORIZONTAL SCALING & REAL REDIS BENCHMARK SUITE     `);
    console.log(`   (1 vs 2 Instances | 2,000 & 5,000 Clients | 5 Runs Each)    `);
    console.log(`================================================================`);

    // Verify Real Redis is accessible
    console.log(`\nVerifying Real Redis connection on ${REDIS_URL}...`);
    try {
        const redisTest = new Redis(REDIS_URL, { connectTimeout: 3000, maxRetriesPerRequest: 1 });
        redisTest.on('error', () => { });
        const pong = await redisTest.ping();
        console.log(`✅ Real Redis responded: ${pong}`);
        await redisTest.quit();
    } catch (e) {
        console.error(`❌ Could not connect to real Redis at ${REDIS_URL}. Ensure Docker redis container is running:`, e.message);
        process.exit(1);
    }

    const singleOutputFile = path.resolve(__dirname, '../../benchmarks/phase2-single-instance-raw.json');
    const multiOutputFile = path.resolve(__dirname, '../../benchmarks/phase2-multi-instance-raw.json');

    // -------------------------------------------------------------
    // PART 1: 1 Instance Benchmark (In-Memory Pub/Sub Baseline)
    // -------------------------------------------------------------
    let hasPart1 = false;
    try {
        const existing = JSON.parse(await fs.readFile(singleOutputFile, 'utf8'));
        if (existing.concurrencyTiers && existing.concurrencyTiers.length >= 2 && !forcePart1) {
            hasPart1 = true;
            console.log(`\n⏩ Found completed Part 1 baseline in ${singleOutputFile}. Skipping Part 1 (pass --force-part1 to re-run).`);
        }
    } catch { }

    if (!hasPart1 && !runPart2Only) {
        console.log(`\n>>> [Part 1/2] Launching Single Instance Server (port 8000, no Redis) <<<`);
        const server1 = spawnServer(8000, { ENABLE_REDIS: 'false' });
        await waitForHttp('http://127.0.0.1:8000/health');
        console.log(`✅ Single Instance healthy on http://127.0.0.1:8000`);
        await prewarmServer('ws://127.0.0.1:8000/ws');

        console.log(`Running Part 1 Benchmark (Tiers: 2000, 5000 | 5 runs each)...`);
        await runBenchmarkScript([
            '--target', 'ws://127.0.0.1:8000/ws',
            '--api', 'http://127.0.0.1:8000',
            '--tiers', '2000,5000',
            '--rounds', '5',
            '--repeat', '5',
            '--cooldown', '6',
            '--mode', 'tiers',
            '--output', singleOutputFile
        ]);

        console.log(`Shutting down Single Instance server...`);
        await stopProcess(server1);
        console.log(`Cooling down 8s for TCP ports and TIME_WAIT sockets to drain...`);
        await delay(8000);
    }

    // -------------------------------------------------------------
    // PART 2: 2 Instances Benchmark (Real Redis Pub/Sub Cluster)
    // -------------------------------------------------------------
    console.log(`\n>>> [Part 2/2] Launching 2 Server Instances Connected to Real Redis <<<`);
    // Clean up test keys in Redis
    try {
        const cleanupRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
        cleanupRedis.on('error', () => { });
        const keys = await cleanupRedis.keys('sportz:match:*:reactions');
        if (keys.length > 0) {
            await cleanupRedis.del(...keys);
            console.log(`Cleaned up ${keys.length} reaction keys in Redis.`);
        }
        await cleanupRedis.quit();
    } catch (e) {
        console.warn(`Redis cleanup note:`, e.message);
    }

    const clusterInstance1 = spawnServer(8000, {
        ENABLE_REDIS: 'true',
        REDIS_URL
    });
    const clusterInstance2 = spawnServer(8001, {
        ENABLE_REDIS: 'true',
        REDIS_URL
    });

    await Promise.all([
        waitForHttp('http://127.0.0.1:8000/health'),
        waitForHttp('http://127.0.0.1:8001/health')
    ]);
    console.log(`✅ Both cluster instances healthy (8000 & 8001) connected to Real Redis.`);
    await Promise.all([
        prewarmServer('ws://127.0.0.1:8000/ws'),
        prewarmServer('ws://127.0.0.1:8001/ws')
    ]);

    console.log(`Running Part 2 Benchmark (Tiers: 2000, 5000 | 5 runs each across 2 instances)...`);
    await runBenchmarkScript([
        '--targets', 'ws://127.0.0.1:8000/ws,ws://127.0.0.1:8001/ws',
        '--apis', 'http://127.0.0.1:8000,http://127.0.0.1:8001',
        '--tiers', '2000,5000',
        '--rounds', '5',
        '--repeat', '5',
        '--cooldown', '6',
        '--mode', 'tiers',
        '--output', multiOutputFile
    ]);

    console.log(`Tearing down 2 cluster instances...`);
    await stopProcess(clusterInstance1);
    await stopProcess(clusterInstance2);
    console.log(`✅ Cluster teardown complete.`);

    // -------------------------------------------------------------
    // PART 3: Analysis & Detailed Comparison Table
    // -------------------------------------------------------------
    const singleData = JSON.parse(await fs.readFile(singleOutputFile, 'utf8'));
    const multiData = JSON.parse(await fs.readFile(multiOutputFile, 'utf8'));

    console.log(`\n========================================================================================================================`);
    console.log(`                           PHASE 2 BENCHMARK RESULTS (REAL REDIS: 1 INSTANCE vs 2 INSTANCES)                             `);
    console.log(`========================================================================================================================`);
    console.log(`| Clients (N) | Metric | 1 Instance (Mean) | 1 Instance (Min - Max) | 2 Instances (Mean) | 2 Instances (Min - Max) | Difference |`);
    console.log(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);

    const comparisonResults = [];
    for (let i = 0; i < singleData.concurrencyTiers.length; i++) {
        const s = singleData.concurrencyTiers[i];
        const m = multiData.concurrencyTiers[i];
        if (!s || !m || s.failed || m.failed) continue;

        const sSum = s.summary;
        const mSum = m.summary;
        const n = s.concurrency;

        const diffP50 = Number((mSum.p50.mean - sSum.p50.mean).toFixed(1));
        const diffP50Str = diffP50 >= 0 ? `+${diffP50} ms` : `${diffP50} ms`;

        console.log(`| **${n}** | **p50 Latency** | ${sSum.p50.mean} ms | [${sSum.p50.min} - ${sSum.p50.max} ms] | ${mSum.p50.mean} ms | [${mSum.p50.min} - ${mSum.p50.max} ms] | **${diffP50Str} (Redis hop)** |`);
        console.log(`| ${n} | **p95 Latency** | ${sSum.p95.mean} ms | [${sSum.p95.min} - ${sSum.p95.max} ms] | ${mSum.p95.mean} ms | [${mSum.p95.min} - ${mSum.p95.max} ms] | ${(mSum.p95.mean - sSum.p95.mean).toFixed(1)} ms |`);
        console.log(`| ${n} | **p99 Latency** | ${sSum.p99.mean} ms | [${sSum.p99.min} - ${sSum.p99.max} ms] | ${mSum.p99.mean} ms | [${mSum.p99.min} - ${mSum.p99.max} ms] | ${(mSum.p99.mean - sSum.p99.mean).toFixed(1)} ms |`);
        console.log(`| ${n} | **Late (>150ms)** | ${sSum.lateRatePercent.mean}% | [${sSum.lateRatePercent.min}% - ${sSum.lateRatePercent.max}%] | ${mSum.lateRatePercent.mean}% | [${mSum.lateRatePercent.min}% - ${mSum.lateRatePercent.max}%] | - |`);
        console.log(`| ${n} | **Undelivered** | ${sSum.undeliveredRatePercent.mean}% | [${sSum.undeliveredRatePercent.min}% - ${sSum.undeliveredRatePercent.max}%] | ${mSum.undeliveredRatePercent.mean}% | [${mSum.undeliveredRatePercent.min}% - ${mSum.undeliveredRatePercent.max}%] | - |`);
        console.log(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);

        comparisonResults.push({
            concurrency: n,
            runsCount: s.repeatCount,
            singleInstance: {
                p50: sSum.p50,
                p95: sSum.p95,
                p99: sSum.p99,
                lateRatePercent: sSum.lateRatePercent,
                undeliveredRatePercent: sSum.undeliveredRatePercent
            },
            twoInstancesRealRedis: {
                p50: mSum.p50,
                p95: mSum.p95,
                p99: mSum.p99,
                lateRatePercent: mSum.lateRatePercent,
                undeliveredRatePercent: mSum.undeliveredRatePercent
            },
            redisHopCostP50Ms: diffP50
        });
    }

    const comparisonPath = path.resolve(__dirname, '../../benchmarks/phase2-comparison.json');
    await fs.writeFile(comparisonPath, JSON.stringify(comparisonResults, null, 2), 'utf8');
    console.log(`\n✅ Comparison results saved to: ${comparisonPath}`);
}

main().catch((err) => {
    console.error('Fatal benchmark suite failure:', err);
    process.exit(1);
});
