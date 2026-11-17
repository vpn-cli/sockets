import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { createEmbeddedRedisServer } from '../src/redis/embedded-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return true;
        } catch {}
        await delay(300);
    }
    throw new Error(`Timeout waiting for ${url}`);
}

function spawnServer(port, extraEnv = {}) {
    const proc = spawn(process.execPath, [path.resolve(ROOT_DIR, 'src/index.js')], {
        cwd: ROOT_DIR,
        env: {
            ...process.env,
            PORT: String(port),
            BENCHMARK_BYPASS_ARCJET: '1',
            AUTO_SEED: 'false',
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (d) => {
        const text = d.toString();
        if (text.includes('Listening') || text.includes('Error') || text.includes('Redis')) {
            process.stdout.write(`[Server:${port}] ${text}`);
        }
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
            spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
        } else {
            proc.kill('SIGTERM');
        }
    } catch {}
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
    console.log(`================================================================`);
    console.log(`   PHASE 2: HORIZONTAL SCALING & REDIS COST BENCHMARK SUITE     `);
    console.log(`================================================================`);

    const singleOutputFile = path.resolve(__dirname, '../../benchmarks/phase2-single-instance-raw.json');
    const multiOutputFile = path.resolve(__dirname, '../../benchmarks/phase2-multi-instance-raw.json');

    // -------------------------------------------------------------
    // PART 1: 1 Instance Benchmark (In-Memory Pub/Sub Baseline)
    // -------------------------------------------------------------
    console.log(`\n>>> [Part 1/2] Launching Single Instance Server (port 8000, no Redis) <<<`);
    const server1 = spawnServer(8000, { ENABLE_REDIS: 'false' });
    await waitForHttp('http://127.0.0.1:8000/health');
    console.log(`✅ Single Instance healthy on http://127.0.0.1:8000`);

    console.log(`Running Part 1 Benchmark (Tiers: 100, 500, 1000, 2000, 5000 | 3 runs each)...`);
    await runBenchmarkScript([
        '--target', 'ws://127.0.0.1:8000/ws',
        '--api', 'http://127.0.0.1:8000',
        '--tiers', '100,500,1000,2000,5000',
        '--rounds', '5',
        '--repeat', '3',
        '--cooldown', '4',
        '--mode', 'tiers',
        '--output', singleOutputFile
    ]);

    console.log(`Shutting down Single Instance server...`);
    await stopProcess(server1);
    console.log(`Cooling down 8s for TCP ports and TIME_WAIT sockets to drain...`);
    await delay(8000);

    // -------------------------------------------------------------
    // PART 2: 2 Instances Benchmark (Redis Pub/Sub Horizontal Scaling)
    // -------------------------------------------------------------
    console.log(`\n>>> [Part 2/2] Launching Embedded Redis and 2 Server Instances <<<`);
    const redisServer = createEmbeddedRedisServer(6379);
    await redisServer.listen();
    console.log(`✅ Embedded Redis listening on 127.0.0.1:6379`);

    const clusterInstance1 = spawnServer(8000, {
        ENABLE_REDIS: 'true',
        REDIS_URL: 'redis://127.0.0.1:6379'
    });
    const clusterInstance2 = spawnServer(8001, {
        ENABLE_REDIS: 'true',
        REDIS_URL: 'redis://127.0.0.1:6379'
    });

    await Promise.all([
        waitForHttp('http://127.0.0.1:8000/health'),
        waitForHttp('http://127.0.0.1:8001/health')
    ]);
    console.log(`✅ Both cluster instances healthy (8000 & 8001) connected to Redis.`);

    console.log(`Running Part 2 Benchmark (Tiers: 100, 500, 1000, 2000, 5000 | 3 runs each across 2 instances)...`);
    await runBenchmarkScript([
        '--targets', 'ws://127.0.0.1:8000/ws,ws://127.0.0.1:8001/ws',
        '--apis', 'http://127.0.0.1:8000,http://127.0.0.1:8001',
        '--tiers', '100,500,1000,2000,5000',
        '--rounds', '5',
        '--repeat', '3',
        '--cooldown', '4',
        '--mode', 'tiers',
        '--output', multiOutputFile
    ]);

    console.log(`Tearing down 2 cluster instances and Redis server...`);
    await stopProcess(clusterInstance1);
    await stopProcess(clusterInstance2);
    await redisServer.close();
    console.log(`✅ Cluster teardown complete.`);

    // -------------------------------------------------------------
    // PART 3: Analysis & Comparison Table
    // -------------------------------------------------------------
    const singleData = JSON.parse(await fs.readFile(singleOutputFile, 'utf8'));
    const multiData = JSON.parse(await fs.readFile(multiOutputFile, 'utf8'));

    console.log(`\n========================================================================================`);
    console.log(`                   PHASE 2: 1 INSTANCE vs 2 INSTANCES (REDIS COST)                      `);
    console.log(`========================================================================================`);
    console.log(`| Clients (N) | 1-Instance p50 | 2-Instances p50 | Redis Hop Cost (p50) | 1-Instance p95 | 2-Instances p95 | Late (>150ms) 1-Inst | Late (>150ms) 2-Inst | Undelivered |`);
    console.log(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);

    const comparisonResults = [];
    for (let i = 0; i < singleData.concurrencyTiers.length; i++) {
        const s = singleData.concurrencyTiers[i];
        const m = multiData.concurrencyTiers[i];
        if (!s || !m || s.failed || m.failed) continue;

        const sP50 = s.summary ? s.summary.p50.mean : s.latencyMs.p50;
        const mP50 = m.summary ? m.summary.p50.mean : m.latencyMs.p50;
        const diffP50 = Number((mP50 - sP50).toFixed(1));
        const diffP50Str = diffP50 >= 0 ? `+${diffP50} ms` : `${diffP50} ms`;

        const sP95 = s.summary ? s.summary.p95.mean : s.latencyMs.p95;
        const mP95 = m.summary ? m.summary.p95.mean : m.latencyMs.p95;

        const sLate = s.summary ? `${s.summary.lateRatePercent.mean}%` : `${s.lateRatePercent}%`;
        const mLate = m.summary ? `${m.summary.lateRatePercent.mean}%` : `${m.lateRatePercent}%`;

        const sUndelivered = s.summary ? `${s.summary.undeliveredRatePercent.mean}%` : `${s.undeliveredRatePercent}%`;
        const mUndelivered = m.summary ? `${m.summary.undeliveredRatePercent.mean}%` : `${m.undeliveredRatePercent}%`;

        console.log(`| ${s.concurrency} | ${sP50} ms | ${mP50} ms | **${diffP50Str}** | ${sP95} ms | ${mP95} ms | ${sLate} | ${mLate} | ${sUndelivered} / ${mUndelivered} |`);

        comparisonResults.push({
            concurrency: s.concurrency,
            singleInstance: { p50: sP50, p95: sP95, lateRate: sLate, undeliveredRate: sUndelivered },
            twoInstancesRedis: { p50: mP50, p95: mP95, lateRate: mLate, undeliveredRate: mUndelivered },
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
