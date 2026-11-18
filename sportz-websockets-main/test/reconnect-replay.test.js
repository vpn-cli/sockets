import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { attachWebSocketServer, getGapReplayDbQueryCount, resetGapReplayDbQueryCount } from '../src/ws/server.js';
import { db } from '../src/db/db.js';
import { matches, commentary } from '../src/db/schema.js';
import { ingestEvent } from '../src/ingestor/ingest-service.js';
import { eq } from 'drizzle-orm';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

describe('Reconnect Replay & Sequence Recovery Tests', () => {
    let serverA, serverB;
    let wsUrlA, wsUrlB;
    let handlesA, handlesB;
    let pubA, subA, pubB, subB;
    let testMatchId;
    const testClients = new Set();

    function connectWs(url) {
        return new Promise((resolve, reject) => {
            const client = new WebSocket(url);
            client._messageQueue = [];
            client._waiters = [];

            client.on('message', (data) => {
                let parsed;
                try {
                    parsed = JSON.parse(data.toString());
                } catch {
                    parsed = { raw: data.toString() };
                }

                const waiterIndex = client._waiters.findIndex((w) => !w.type || w.type === parsed.type);
                if (waiterIndex !== -1) {
                    const [waiter] = client._waiters.splice(waiterIndex, 1);
                    clearTimeout(waiter.timer);
                    waiter.resolve(parsed);
                } else {
                    client._messageQueue.push(parsed);
                }
            });

            client.on('open', () => {
                testClients.add(client);
                resolve(client);
            });

            client.on('error', reject);
        });
    }

    function awaitMessage(client, expectedType, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
            const queuedIndex = client._messageQueue.findIndex((m) => !expectedType || m.type === expectedType);
            if (queuedIndex !== -1) {
                const [msg] = client._messageQueue.splice(queuedIndex, 1);
                return resolve(msg);
            }

            const timer = setTimeout(() => {
                const idx = client._waiters.findIndex((w) => w.timer === timer);
                if (idx !== -1) client._waiters.splice(idx, 1);
                reject(new Error(`Timed out after ${timeoutMs}ms waiting for type: ${expectedType}`));
            }, timeoutMs);

            client._waiters.push({ type: expectedType, resolve, reject, timer });
        });
    }

    beforeEach(async () => {
        // 1. Create Redis connections
        const redisOpts = {
            maxRetriesPerRequest: 1,
            enableReadyCheck: false,
            retryStrategy: (times) => Math.min(times * 50, 500),
        };
        pubA = new Redis(REDIS_URL, redisOpts);
        subA = new Redis(REDIS_URL, redisOpts);
        pubB = new Redis(REDIS_URL, redisOpts);
        subB = new Redis(REDIS_URL, redisOpts);
        pubA.on('error', () => {});
        subA.on('error', () => {});
        pubB.on('error', () => {});
        subB.on('error', () => {});

        // 2. Insert test match in DB
        const [m] = await db.insert(matches).values({
            sport: 'football',
            homeTeam: 'Liverpool',
            awayTeam: 'Real Madrid',
            status: 'live',
            homeScore: 0,
            awayScore: 0,
            lastSeq: 0,
        }).returning();
        testMatchId = m.id;

        // 3. Create HTTP servers for Instance A and Instance B
        serverA = http.createServer();
        serverB = http.createServer();

        handlesA = attachWebSocketServer(serverA, {
            heartbeatMs: 60000,
            knownMatchIds: [testMatchId],
            redisPub: pubA,
            redisSub: subA,
        });

        handlesB = attachWebSocketServer(serverB, {
            heartbeatMs: 60000,
            knownMatchIds: [testMatchId],
            redisPub: pubB,
            redisSub: subB,
        });

        await new Promise((resolve) => serverA.listen(0, '127.0.0.1', resolve));
        await new Promise((resolve) => serverB.listen(0, '127.0.0.1', resolve));

        wsUrlA = `ws://127.0.0.1:${serverA.address().port}/ws`;
        wsUrlB = `ws://127.0.0.1:${serverB.address().port}/ws`;
    });

    afterEach(async () => {
        for (const client of testClients) {
            try { client.terminate(); } catch {}
        }
        testClients.clear();

        if (pubA) { try { await pubA.quit(); } catch {} }
        if (subA) { try { await subA.quit(); } catch {} }
        if (pubB) { try { await pubB.quit(); } catch {} }
        if (subB) { try { await subB.quit(); } catch {} }

        await new Promise((resolve) => serverA.close(resolve));
        await new Promise((resolve) => serverB.close(resolve));

        if (testMatchId) {
            await db.delete(commentary).where(eq(commentary.matchId, testMatchId));
            await db.delete(matches).where(eq(matches.id, testMatchId));
        }
    });

    it('disconnect client -> publish 10 events -> reconnect with lastSeq -> all 10 arrive in order without duplicates', async () => {
        // Connect client to Instance A
        const client = await connectWs(wsUrlA);
        await awaitMessage(client, 'welcome');

        client.send(JSON.stringify({ type: 'subscribe', matchId: testMatchId }));
        await awaitMessage(client, 'subscribed');
        const rxSnapshot = await awaitMessage(client, 'reaction_snapshot');
        expect(rxSnapshot.type).toBe('reaction_snapshot');

        // Disconnect client cleanly
        client.close();
        await new Promise((r) => setTimeout(r, 50));

        // Ingest 10 events into Postgres while client is disconnected (fast batch insert)
        const fakeEvents = Array.from({ length: 10 }, (_, i) => ({
            matchId: testMatchId,
            minute: (i + 1) * 5,
            sequence: i + 1,
            message: `Match event #${i + 1} occurred.`,
            provider: 'test-feed',
            providerEventId: `ev_test_${i + 1}_${Date.now()}`,
        }));
        await db.insert(commentary).values(fakeEvents);
        await db.update(matches).set({ lastSeq: 10 }).where(eq(matches.id, testMatchId));

        // Reconnect client with lastSeq: 0 (or requesting replay of all 10)
        const reconnectedClient = await connectWs(wsUrlA);
        await awaitMessage(reconnectedClient, 'welcome');

        reconnectedClient.send(JSON.stringify({
            type: 'subscribe',
            matchId: testMatchId,
            lastSeq: 0,
        }));
        await awaitMessage(reconnectedClient, 'subscribed');
        await awaitMessage(reconnectedClient, 'reaction_snapshot');

        // Wait for replay events payload
        const replayMsg = await awaitMessage(reconnectedClient, 'replay_events');
        expect(replayMsg.type).toBe('replay_events');
        expect(replayMsg.count).toBe(10);
        expect(replayMsg.events.length).toBe(10);

        // Verify strictly increasing sequence numbers
        const sequences = replayMsg.events.map((e) => e.sequence);
        expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

        // Verify individual commentary messages arrived in order
        const replayedCommentaries = [];
        for (let i = 0; i < 10; i++) {
            const comm = await awaitMessage(reconnectedClient, 'commentary');
            replayedCommentaries.push(comm.data.sequence);
        }
        expect(replayedCommentaries).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }, 30000);

    it('oversized-gap (> 200): sends fresh full snapshot instead of replaying hundreds of events', async () => {
        // Ingest 205 events into match
        // Fast batch insert directly to database to simulate high event volume
        const fakeEvents = Array.from({ length: 205 }, (_, i) => ({
            matchId: testMatchId,
            minute: Math.min(90, Math.floor(i / 2) + 1),
            sequence: i + 1,
            message: `Telemetry point ${i + 1}`,
            provider: 'test-bulk',
            providerEventId: `bulk_${i + 1}_${Date.now()}`,
        }));
        await db.insert(commentary).values(fakeEvents);
        await db.update(matches).set({ lastSeq: 205 }).where(eq(matches.id, testMatchId));

        // Connect client with an old lastSeq = 2 (gap = 203 > 200)
        const client = await connectWs(wsUrlA);
        await awaitMessage(client, 'welcome');

        client.send(JSON.stringify({
            type: 'subscribe',
            matchId: testMatchId,
            lastSeq: 2,
        }));

        await awaitMessage(client, 'subscribed');
        await awaitMessage(client, 'reaction_snapshot');

        // Verify server returns fresh full snapshot
        const snapshotMsg = await awaitMessage(client, 'snapshot');
        expect(snapshotMsg.type).toBe('snapshot');
        expect(snapshotMsg.reason).toBe('gap_exceeded');
        expect(snapshotMsg.match.lastSeq).toBe(205);
        expect(snapshotMsg.recentCommentary.length).toBeLessThanOrEqual(50);
    });

    it('reconnect landing on a DIFFERENT instance: Instance B reads Postgres and replays the exact missed gap', async () => {
        // Connect to Instance A
        const clientA = await connectWs(wsUrlA);
        await awaitMessage(clientA, 'welcome');

        clientA.send(JSON.stringify({ type: 'subscribe', matchId: testMatchId }));
        await awaitMessage(clientA, 'subscribed');
        await awaitMessage(clientA, 'reaction_snapshot');

        // Fast batch insert 3 early events
        const earlyEvents = Array.from({ length: 3 }, (_, i) => ({
            matchId: testMatchId,
            minute: (i + 1) * 10,
            sequence: i + 1,
            message: `Early event ${i + 1}`,
            provider: 'test-cross',
            providerEventId: `cross_${i + 1}_${Date.now()}`,
        }));
        await db.insert(commentary).values(earlyEvents);
        await db.update(matches).set({ lastSeq: 3 }).where(eq(matches.id, testMatchId));

        // Client on Instance A disconnects at seq = 3
        clientA.close();
        await new Promise((r) => setTimeout(r, 50));

        // 4 more events (seq 4, 5, 6, 7) are ingested while disconnected
        const missedEvents = Array.from({ length: 4 }, (_, i) => ({
            matchId: testMatchId,
            minute: (i + 4) * 10,
            sequence: i + 4,
            message: `Missed event ${i + 4}`,
            provider: 'test-cross',
            providerEventId: `cross_${i + 4}_${Date.now()}`,
        }));
        await db.insert(commentary).values(missedEvents);
        await db.update(matches).set({ lastSeq: 7 }).where(eq(matches.id, testMatchId));

        // Client reconnects to Instance B (DIFFERENT server instance) sending lastSeq = 3
        const clientB = await connectWs(wsUrlB);
        await awaitMessage(clientB, 'welcome');

        clientB.send(JSON.stringify({
            type: 'subscribe',
            matchId: testMatchId,
            lastSeq: 3,
        }));

        await awaitMessage(clientB, 'subscribed');
        await awaitMessage(clientB, 'reaction_snapshot');

        // Instance B queries Postgres and replays events 4, 5, 6, 7
        const replayMsg = await awaitMessage(clientB, 'replay_events');
        expect(replayMsg.count).toBe(4);
        expect(replayMsg.events.map((e) => e.sequence)).toEqual([4, 5, 6, 7]);
    }, 30000);

    it('reconnect replay works during and after a Redis outage', async () => {
        // 1. Sever Redis connections using CLIENT KILL
        const admin = new Redis(REDIS_URL);
        const pubIdA = await pubA.client('id');
        const subIdA = await subA.client('id');
        await admin.client('kill', 'id', pubIdA);
        await admin.client('kill', 'id', subIdA);
        await admin.quit();

        await new Promise((r) => setTimeout(r, 40));

        // 2. Ingest 4 events into Postgres while Redis is down
        for (let i = 1; i <= 4; i++) {
            await ingestEvent({
                matchId: testMatchId,
                provider: 'test-outage',
                providerEventId: `outage_${i}_${Date.now()}`,
                minute: i * 8,
                message: `Outage event ${i}`,
            }, {
                db,
                broadcastCommentary: handlesA.broadcastCommentary,
            });
        }

        // 3. Client connects with lastSeq = 1 while Redis was degraded
        const client = await connectWs(wsUrlA);
        await awaitMessage(client, 'welcome');

        client.send(JSON.stringify({
            type: 'subscribe',
            matchId: testMatchId,
            lastSeq: 1,
        }));

        await awaitMessage(client, 'subscribed');
        await awaitMessage(client, 'reaction_snapshot');

        // 4. Server successfully reads Postgres and replays sequences 2, 3, 4
        const replayMsg = await awaitMessage(client, 'replay_events');
        expect(replayMsg.count).toBe(3);
        expect(replayMsg.events.map((e) => e.sequence)).toEqual([2, 3, 4]);
    });

    it('replay race: new live event published while replay is in flight -> no event dropped and order preserved', async () => {
        // 1. Seed match with events seq 1, 2, 3, 4, 5
        const initialEvents = Array.from({ length: 5 }, (_, i) => ({
            matchId: testMatchId,
            minute: (i + 1) * 10,
            sequence: i + 1,
            message: `Historical event ${i + 1}`,
            provider: 'test-race',
            providerEventId: `race_${i + 1}_${Date.now()}`,
        }));
        await db.insert(commentary).values(initialEvents);
        await db.update(matches).set({ lastSeq: 5 }).where(eq(matches.id, testMatchId));

        // 2. Client connects with lastSeq = 2 (expecting replay of 3, 4, 5)
        const client = await connectWs(wsUrlA);
        await awaitMessage(client, 'welcome');

        client.send(JSON.stringify({
            type: 'subscribe',
            matchId: testMatchId,
            lastSeq: 2,
        }));

        await awaitMessage(client, 'subscribed');

        // 3. Concurrently publish live event 6 while replay is in flight
        const liveEvent = {
            matchId: testMatchId,
            minute: 65,
            sequence: 6,
            message: 'Live concurrent event 6 during replay',
            provider: 'test-race',
            providerEventId: `race_6_${Date.now()}`,
        };
        handlesA.broadcastCommentary(testMatchId, liveEvent);

        await awaitMessage(client, 'reaction_snapshot');

        // Replay packet arrives
        const replayMsg = await awaitMessage(client, 'replay_events');
        expect(replayMsg.count).toBe(3);
        expect(replayMsg.events.map((e) => e.sequence)).toEqual([3, 4, 5]);

        // Collect all individual commentary messages
        const receivedSeqs = [];
        for (let i = 0; i < 4; i++) {
            const msg = await awaitMessage(client, 'commentary', 10000);
            receivedSeqs.push(msg.data.sequence);
        }

        // Verify that NO events were dropped!
        // Both replayed events (3, 4, 5) AND live event (6) arrived in order!
        expect(receivedSeqs).toEqual([3, 4, 5, 6]);
    }, 30000);

    it('client gap detection: Redis fully stopped -> instance 2 client misses seq 2 -> seq 3 arrives after recovery -> recovers seq 2 without reconnecting', async () => {
        const { execSync } = await import('child_process');

        // 1. Client 1 on Instance A, Client 2 on Instance B
        const client1 = await connectWs(wsUrlA);
        const client2 = await connectWs(wsUrlB);
        await awaitMessage(client1, 'welcome');
        await awaitMessage(client2, 'welcome');

        client1.send(JSON.stringify({ type: 'subscribe', matchId: testMatchId }));
        client2.send(JSON.stringify({ type: 'subscribe', matchId: testMatchId }));
        await awaitMessage(client1, 'subscribed');
        await awaitMessage(client2, 'subscribed');
        await awaitMessage(client1, 'reaction_snapshot');
        await awaitMessage(client2, 'reaction_snapshot');

        // Track received commentary messages on Client 2
        const client2Received = [];
        let client2LastSeenSeq = 0;
        let gapDetectedAndRequested = false;

        client2.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === 'commentary' && msg.data) {
                const seq = msg.data.sequence || msg.data.seq;
                client2Received.push(seq);

                // Client-side gap detection: seq N received while lastSeen < N-1
                if (client2LastSeenSeq > 0 && seq > client2LastSeenSeq + 1) {
                    gapDetectedAndRequested = true;
                    // Requests replay from last seen seq WITHOUT reconnecting
                    client2.send(JSON.stringify({
                        type: 'replay',
                        matchId: testMatchId,
                        lastSeq: client2LastSeenSeq,
                    }));
                }

                if (seq > client2LastSeenSeq) {
                    client2LastSeenSeq = seq;
                }
            }
        });

        // 2. Publish Seq 1 via Instance A: both clients receive seq 1
        await ingestEvent({
            matchId: testMatchId,
            provider: 'test-gap',
            providerEventId: `gap_1_${Date.now()}`,
            minute: 10,
            message: 'Seq 1 live event',
        }, {
            db,
            broadcastCommentary: handlesA.broadcastCommentary,
        });

        // Wait for Client 2 to receive seq 1
        await new Promise((r) => setTimeout(r, 400));
        expect(client2Received).toContain(1);
        expect(client2LastSeenSeq).toBe(1);

        try {
            // 3. Stop Redis fully (docker stop)
            execSync('docker stop sportz-redis -t 1');
            await new Promise((r) => setTimeout(r, 400));

            // 4. Publish Seq 2 via Instance A while Redis is fully stopped
            // Instance A logs degradation and broadcasts locally.
            // Instance B receives NOTHING, so Client 2 misses seq 2!
            await ingestEvent({
                matchId: testMatchId,
                provider: 'test-gap',
                providerEventId: `gap_2_${Date.now()}`,
                minute: 20,
                message: 'Seq 2 event during Redis outage',
            }, {
                db,
                broadcastCommentary: handlesA.broadcastCommentary,
            });

            await new Promise((r) => setTimeout(r, 400));
            // Client 2 on Instance B missed seq 2!
            expect(client2Received).not.toContain(2);
            expect(client2LastSeenSeq).toBe(1);
        } finally {
            // 5. Recover Redis (docker start) - guaranteed recovery in finally block
            execSync('docker start sportz-redis');
        }

        // Wait for ioredis clients on Instance A and Instance B to reconnect
        let reconnected = false;
        for (let i = 0; i < 40; i++) {
            if (pubA.status === 'ready' && pubB.status === 'ready' && subA.status === 'ready' && subB.status === 'ready') {
                reconnected = true;
                break;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        expect(reconnected).toBe(true);
        // Allow Redis subscription channels to re-bind
        await new Promise((r) => setTimeout(r, 500));

        // 6. Publish Seq 3 via Instance A after recovery
        await ingestEvent({
            matchId: testMatchId,
            provider: 'test-gap',
            providerEventId: `gap_3_${Date.now()}`,
            minute: 30,
            message: 'Seq 3 live event after Redis recovery',
        }, {
            db,
            broadcastCommentary: handlesA.broadcastCommentary,
        });

        // Wait for Client 2 to receive seq 3 and trigger gap recovery
        await new Promise((r) => setTimeout(r, 1200));

        // 7. Verify Client 2 detected the gap and recovered seq 2 WITHOUT reconnecting
        expect(client2.readyState).toBe(WebSocket.OPEN); // Connection stayed open!
        expect(gapDetectedAndRequested).toBe(true);
        expect(client2Received).toContain(3);
        expect(client2Received).toContain(2); // Recovered seq 2 via replay!
        // All sequences 1, 2, 3 were received by Client 2!
        expect(new Set(client2Received)).toEqual(new Set([1, 2, 3]));
    }, 45000);

    it('gap-replay stampede: 1,000 clients detect the same gap at once -> count Postgres queries (should be ~1, not 1,000)', async () => {
        // 1. Ingest 5 events into Postgres for testMatchId (seq 1..5)
        for (let seq = 1; seq <= 5; seq++) {
            await ingestEvent({
                matchId: testMatchId,
                provider: 'test-stampede',
                providerEventId: `stampede_${seq}_${Date.now()}`,
                minute: seq * 10,
                message: `Stampede commentary seq ${seq}`,
            }, {
                db,
                broadcastCommentary: () => {},
            });
        }

        // 2. Reset query counter
        resetGapReplayDbQueryCount();

        // 3. Connect 1,000 client sockets to Instance A
        const CLIENT_COUNT = 1000;
        const BATCH_SIZE = 100;
        const clients = [];

        for (let i = 0; i < CLIENT_COUNT; i += BATCH_SIZE) {
            const batch = [];
            const limit = Math.min(i + BATCH_SIZE, CLIENT_COUNT);
            for (let j = i; j < limit; j++) {
                batch.push(connectWs(wsUrlA).then((c) => {
                    clients.push(c);
                    return c;
                }));
            }
            await Promise.all(batch);
            if (limit < CLIENT_COUNT) {
                await new Promise((r) => setTimeout(r, 15));
            }
        }

        expect(clients.length).toBe(CLIENT_COUNT);

        // 4. All 1,000 clients request replay simultaneously for (testMatchId, lastSeq: 2)
        const replayPromises = clients.map((client) => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timed out waiting for replay_events'));
                }, 15000);

                const onMsg = (raw) => {
                    try {
                        const msg = JSON.parse(raw.toString());
                        if (msg.type === 'replay_events') {
                            client.off('message', onMsg);
                            clearTimeout(timeout);
                            resolve(msg);
                        }
                    } catch {}
                };
                client.on('message', onMsg);
                client.send(JSON.stringify({
                    type: 'replay',
                    matchId: testMatchId,
                    lastSeq: 2,
                }));
            });
        });

        const results = await Promise.all(replayPromises);

        // 5. Verify all 1,000 received the replay events (seq 3, 4, 5 -> 3 events)
        expect(results.length).toBe(CLIENT_COUNT);
        for (const res of results) {
            expect(res.matchId).toBe(testMatchId);
            expect(res.count).toBe(3);
            expect(res.events.map((e) => e.sequence)).toEqual([3, 4, 5]);
        }

        // 6. Verify Postgres query count: deduped to ~1 query, NOT 1,000!
        const firedQueries = getGapReplayDbQueryCount();
        console.log(`\n✅ Gap-Replay Stampede: 1,000 simultaneous clients fired ${firedQueries} Postgres queries`);
        expect(firedQueries).toBeGreaterThanOrEqual(1);
        expect(firedQueries).toBeLessThanOrEqual(2); // In-flight coalescing ensures ~1 query

        // 7. Cleanup clients with terminate
        for (const c of clients) {
            try { c.terminate(); } catch {}
        }
        clients.length = 0;
    }, 45000);
});
