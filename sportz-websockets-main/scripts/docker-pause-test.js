import http from 'http';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { execSync } from 'child_process';
import { attachWebSocketServer } from '../src/ws/server.js';
import { configureBenchmarkDatabase } from '../src/db/guard.js';

const benchmarkDbInfo = configureBenchmarkDatabase();
console.log(`[Benchmark DB] Host: ${benchmarkDbInfo.host} (guarded local-by-default)`);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const MATCH_ID = 888;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
    console.log('======================================================');
    console.log('--- 2-Instance Docker Pause Outage & Seq Dedupe Test ---');
    console.log('======================================================');

    // 1. Verify Docker container sportz-redis is running
    const dockerPs = execSync('docker ps --filter "name=sportz-redis" --format "{{.Status}}"').toString().trim();
    console.log(`[Docker Status] sportz-redis container status: ${dockerPs}`);
    if (!dockerPs) {
        throw new Error('Container sportz-redis is not running! Run `docker compose up -d redis` first.');
    }

    // 2. Setup Redis pub/sub clients for Instance 1 & Instance 2
    const redisOpts = {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (t) => Math.min(t * 100, 500),
    };

    const pub1 = new Redis(REDIS_URL, redisOpts);
    const sub1 = new Redis(REDIS_URL, redisOpts);
    const pub2 = new Redis(REDIS_URL, redisOpts);
    const sub2 = new Redis(REDIS_URL, redisOpts);

    await Promise.all([
        new Promise((r) => pub1.once('ready', r)),
        new Promise((r) => sub1.once('ready', r)),
        new Promise((r) => pub2.once('ready', r)),
        new Promise((r) => sub2.once('ready', r)),
    ]);
    console.log('✅ [Redis] Pub and Sub clients connected for Instance 1 and Instance 2.');

    // 3. Create HTTP & WS Server for Instance 1
    const server1 = http.createServer();
    const handles1 = attachWebSocketServer(server1, {
        heartbeatMs: 30000,
        knownMatchIds: [MATCH_ID],
        redisPub: pub1,
        redisSub: sub1,
    });
    await new Promise((r) => server1.listen(0, '127.0.0.1', r));
    const port1 = server1.address().port;
    const wsUrl1 = `ws://127.0.0.1:${port1}/ws`;
    console.log(`[Instance 1] WS Server running on ${wsUrl1}`);

    // Create HTTP & WS Server for Instance 2
    const server2 = http.createServer();
    const handles2 = attachWebSocketServer(server2, {
        heartbeatMs: 30000,
        knownMatchIds: [MATCH_ID],
        redisPub: pub2,
        redisSub: sub2,
    });
    await new Promise((r) => server2.listen(0, '127.0.0.1', r));
    const port2 = server2.address().port;
    const wsUrl2 = `ws://127.0.0.1:${port2}/ws`;
    console.log(`[Instance 2] WS Server running on ${wsUrl2}`);

    // 4. Connect WebSocket clients
    // Client 1 connects to Instance 1
    const client1 = new WebSocket(wsUrl1);
    const messages1 = [];
    client1.on('message', (d) => messages1.push(JSON.parse(d.toString())));
    await new Promise((r) => client1.on('open', r));
    client1.send(JSON.stringify({ type: 'subscribe', matchId: MATCH_ID }));

    // Client 2 connects to Instance 2
    const client2 = new WebSocket(wsUrl2);
    const messages2 = [];
    client2.on('message', (d) => messages2.push(JSON.parse(d.toString())));
    await new Promise((r) => client2.on('open', r));
    client2.send(JSON.stringify({ type: 'subscribe', matchId: MATCH_ID }));

    await delay(300);
    console.log(`✅ [Clients] Client 1 (Instance 1) & Client 2 (Instance 2) subscribed to match ${MATCH_ID}`);

    // 5. Normal broadcast through Redis (seq: 1)
    console.log('\n--- Step 1: Pre-pause Broadcast (seq: 1) ---');
    handles1.broadcastCommentary(MATCH_ID, { seq: 1, sequence: 1, message: 'Pre-pause event via Redis' });
    await delay(300);

    const pre1 = messages1.filter((m) => m.type === 'commentary' && (m.data?.seq === 1 || m.data?.sequence === 1));
    const pre2 = messages2.filter((m) => m.type === 'commentary' && (m.data?.seq === 1 || m.data?.sequence === 1));
    console.log(`Client 1 received seq 1: ${pre1.length} time(s)`);
    console.log(`Client 2 received seq 1: ${pre2.length} time(s)`);
    if (pre1.length !== 1 || pre2.length !== 1) {
        throw new Error(`Pre-pause broadcast failed: Client 1 received ${pre1.length}, Client 2 received ${pre2.length}`);
    }

    // 6. PAUSE REDIS CONTAINER
    console.log('\n--- Step 2: Freezing Redis ---');
    console.log('⏸️ Executing: docker pause sportz-redis...');
    execSync('docker pause sportz-redis');
    console.log('✅ Container paused. Redis is now completely frozen.');

    // 7. Broadcast degraded event carrying seq: 2 from Instance 1
    console.log('\n--- Step 3: Broadcast Degraded Event during Pause (seq: 2) ---');
    console.log('Instance 1 broadcasting commentary with seq: 2 while Redis is frozen...');
    handles1.broadcastCommentary(MATCH_ID, { seq: 2, sequence: 2, message: 'Degraded event during pause' });

    // Wait for the 500ms timeout on Instance 1's publish and local degradation delivery
    await delay(800);

    const duringPause1 = messages1.filter((m) => m.type === 'commentary' && (m.data?.seq === 2 || m.data?.sequence === 2));
    const duringPause2 = messages2.filter((m) => m.type === 'commentary' && (m.data?.seq === 2 || m.data?.sequence === 2));
    console.log(`[During Pause] Client 1 received seq 2: ${duringPause1.length} time(s) (via Instance 1 local degradation)`);
    console.log(`[During Pause] Client 2 received seq 2: ${duringPause2.length} time(s) (cross-instance blocked by paused Redis)`);

    // 8. UNPAUSE REDIS CONTAINER
    console.log('\n--- Step 4: Unpausing Redis ---');
    console.log('▶️ Executing: docker unpause sportz-redis...');
    execSync('docker unpause sportz-redis');
    console.log('✅ Container unpaused. Waiting for Redis to resume and pub/sub to settle...');
    await delay(1200);

    // 9. Count how many times degraded message (seq: 2) reached each client
    console.log('\n--- Step 5: Post-unpause Message Count Verification ---');
    const postUnpauseSeq2Client1 = messages1.filter((m) => m.type === 'commentary' && (m.data?.seq === 2 || m.data?.sequence === 2));
    const postUnpauseSeq2Client2 = messages2.filter((m) => m.type === 'commentary' && (m.data?.seq === 2 || m.data?.sequence === 2));

    console.log(`Client 1 total received count for seq 2: ${postUnpauseSeq2Client1.length} (MUST BE EXACTLY 1)`);
    console.log(`Client 2 total received count for seq 2: ${postUnpauseSeq2Client2.length} (MUST BE EXACTLY 1)`);

    // 10. Broadcast post-unpause event (seq: 3) from Instance 2
    console.log('\n--- Step 6: Post-unpause Cluster Broadcast (seq: 3) ---');
    handles2.broadcastCommentary(MATCH_ID, { seq: 3, sequence: 3, message: 'Post-unpause restored event from Instance 2' });
    await delay(300);

    const post3Client1 = messages1.filter((m) => m.type === 'commentary' && (m.data?.seq === 3 || m.data?.sequence === 3));
    const post3Client2 = messages2.filter((m) => m.type === 'commentary' && (m.data?.seq === 3 || m.data?.sequence === 3));
    console.log(`Client 1 received seq 3: ${post3Client1.length} time(s)`);
    console.log(`Client 2 received seq 3: ${post3Client2.length} time(s)`);

    // Cleanup
    client1.close();
    client2.close();
    await pub1.quit();
    await sub1.quit();
    await pub2.quit();
    await sub2.quit();
    await new Promise((r) => server1.close(r));
    await new Promise((r) => server2.close(r));

    // Assert exact delivery counts
    if (postUnpauseSeq2Client1.length !== 1) {
        throw new Error(`Client 1 received degraded message ${postUnpauseSeq2Client1.length} times (expected exactly 1). Duplication occurred!`);
    }
    if (postUnpauseSeq2Client2.length !== 1) {
        throw new Error(`Client 2 received degraded message ${postUnpauseSeq2Client2.length} times (expected exactly 1).`);
    }

    console.log('\n======================================================');
    console.log('🎉 [SUCCESS] 2-Instance Docker Pause Outage Test Passed!');
    console.log('All degraded messages reached each client EXACTLY ONCE.');
    console.log('======================================================\n');
}

run().catch((err) => {
    console.error('❌ Test failed:', err.message);
    try {
        console.log('Safety unpause executing...');
        execSync('docker unpause sportz-redis');
    } catch {}
    process.exit(1);
});
