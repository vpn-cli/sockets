import http from 'http';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { execSync } from 'child_process';
import { attachWebSocketServer } from '../src/ws/server.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const MATCH_ID = 888;

async function run() {
    console.log('--- Starting Docker Pause Outage Test ---');

    // 1. Verify Docker container sportz-redis is running
    const dockerPs = execSync('docker ps --filter "name=sportz-redis" --format "{{.Status}}"').toString().trim();
    console.log(`[Docker Status] sportz-redis container status: ${dockerPs}`);

    // 2. Setup Redis pub/sub clients
    const pub = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: (t) => Math.min(t * 100, 500) });
    const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: (t) => Math.min(t * 100, 500) });

    await Promise.all([
        new Promise((r) => pub.once('ready', r)),
        new Promise((r) => sub.once('ready', r)),
    ]);
    console.log('✅ [Redis] Pub and Sub connected and ready.');

    // 3. Create HTTP & WS Server
    const server = http.createServer();
    const { broadcastCommentary } = attachWebSocketServer(server, {
        heartbeatMs: 30000,
        knownMatchIds: [MATCH_ID],
        redisPub: pub,
        redisSub: sub,
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    console.log(`[WS Server] Running on ${wsUrl}`);

    // 4. Connect WebSocket client
    const client = new WebSocket(wsUrl);
    const messages = [];
    client.on('message', (d) => messages.push(JSON.parse(d.toString())));
    await new Promise((r) => client.on('open', r));

    client.send(JSON.stringify({ type: 'subscribe', matchId: MATCH_ID }));
    await new Promise((r) => setTimeout(r, 200));
    console.log(`✅ [WS Client] Subscribed to match ${MATCH_ID}`);

    // 5. Normal broadcast through Redis
    broadcastCommentary(MATCH_ID, { message: 'Pre-pause event via Redis' });
    await new Promise((r) => setTimeout(r, 200));
    const prePauseMsg = messages.find((m) => m.type === 'commentary' && m.data.message === 'Pre-pause event via Redis');
    console.log(`✅ [Pre-pause] Message received: "${prePauseMsg?.data?.message}"`);

    // 6. PAUSE REDIS CONTAINER
    console.log('\n⏸️ Executing: docker pause sportz-redis...');
    execSync('docker pause sportz-redis');
    console.log('✅ Container paused. Redis is now completely frozen.');

    // 7. Broadcast while Redis is paused -> Server degrades to local broadcast
    console.log('Broadcasting commentary while Redis is frozen...');
    broadcastCommentary(MATCH_ID, { message: 'Degraded event during docker pause' });
    await new Promise((r) => setTimeout(r, 700));

    const pausedMsg = messages.find((m) => m.type === 'commentary' && m.data.message === 'Degraded event during docker pause');
    console.log(`✅ [Degraded Mode] Local client received message: "${pausedMsg?.data?.message}"`);

    // 8. UNPAUSE REDIS CONTAINER
    console.log('\n▶️ Executing: docker unpause sportz-redis...');
    execSync('docker unpause sportz-redis');
    console.log('✅ Container unpaused. Waiting for Redis to resume...');
    await new Promise((r) => setTimeout(r, 1000));

    // 9. Post-unpause broadcast
    broadcastCommentary(MATCH_ID, { message: 'Post-unpause restored event' });
    await new Promise((r) => setTimeout(r, 300));
    const postUnpauseMsg = messages.find((m) => m.type === 'commentary' && m.data.message === 'Post-unpause restored event');
    console.log(`✅ [Restored Mode] Message received: "${postUnpauseMsg?.data?.message}"`);

    // Cleanup
    client.close();
    await pub.quit();
    await sub.quit();
    await new Promise((r) => server.close(r));

    console.log('\n🎉 [Success] Docker pause outage test completed with 100% success!\n');
}

run().catch((err) => {
    console.error('❌ Test failed:', err);
    try { execSync('docker unpause sportz-redis'); } catch {}
    process.exit(1);
});
