import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { attachWebSocketServer } from '../src/ws/server.js';
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
});
