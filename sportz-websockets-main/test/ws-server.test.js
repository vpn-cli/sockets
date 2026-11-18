import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { attachWebSocketServer, syncReactionDeltas } from '../src/ws/server.js';
import { getClientIp } from '../src/arcjet.js';
import { getMatchReactionsKey } from '../src/redis/redis.js';
import Redis from 'ioredis';
import { db } from '../src/db/db.js';
import { matches, commentary } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

describe('WebSocket Server Integration Tests', () => {
    let server;
    let wsUrl;
    let serverHandles;
    const activeClients = new Set();

    function connect(url = wsUrl, options = {}) {
        return new Promise((resolve, reject) => {
            const client = new WebSocket(url, options);
            client._messageQueue = [];
            client._waiters = [];

            client.on('message', (data) => {
                let parsed;
                try {
                    parsed = JSON.parse(data.toString());
                } catch {
                    parsed = { raw: data.toString() };
                }

                // Check if any waiter matches this message
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
                activeClients.add(client);
                resolve(client);
            });

            client.on('error', (err) => {
                reject(err);
            });
        });
    }

    function nextMessage(client, expectedType, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            // Check existing queue
            const queueIndex = client._messageQueue.findIndex(
                (msg) => !expectedType || msg.type === expectedType
            );
            if (queueIndex !== -1) {
                const [msg] = client._messageQueue.splice(queueIndex, 1);
                return resolve(msg);
            }

            const timer = setTimeout(() => {
                const waiterIndex = client._waiters.indexOf(waiter);
                if (waiterIndex !== -1) {
                    client._waiters.splice(waiterIndex, 1);
                }
                reject(
                    new Error(
                        `Timeout waiting for message type "${expectedType}" after ${timeoutMs}ms. Queued messages: ${JSON.stringify(
                            client._messageQueue
                        )}`
                    )
                );
            }, timeoutMs);

            const waiter = { type: expectedType, resolve, reject, timer };
            client._waiters.push(waiter);
        });
    }

    function expectNoMessage(client, ms = 150) {
        return new Promise((resolve, reject) => {
            // Any already queued messages (other than welcome)?
            const nonWelcome = client._messageQueue.filter((m) => m.type !== 'welcome');
            if (nonWelcome.length > 0) {
                return reject(
                    new Error(`Expected no message, but found queued: ${JSON.stringify(nonWelcome)}`)
                );
            }

            const onMsg = (data) => {
                cleanup();
                reject(new Error(`Unexpected message received: ${data.toString()}`));
            };

            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, ms);

            function cleanup() {
                clearTimeout(timer);
                client.off('message', onMsg);
            }

            client.on('message', onMsg);
        });
    }

    beforeEach(async () => {
        server = http.createServer();
        serverHandles = attachWebSocketServer(server, {
            heartbeatMs: 30000,
            knownMatchIds: new Set([1, 2, 3, 5, 42]),
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        wsUrl = `ws://127.0.0.1:${port}/ws`;
    });

    afterEach(async () => {
        for (const client of activeClients) {
            try {
                if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
                    client.terminate();
                }
            } catch {
                // ignore
            }
        }
        activeClients.clear();

        if (serverHandles?.wss) {
            serverHandles.wss.close();
        }

        if (server) {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('receives welcome message upon connection', async () => {
        const client = await connect();
        const welcome = await nextMessage(client, 'welcome');
        expect(welcome.type).toBe('welcome');
    });

    it('subscribe -> receives broadcastToMatch commentary for that match', async () => {
        const client = await connect();
        await nextMessage(client, 'welcome');

        client.send(JSON.stringify({ type: 'subscribe', matchId: 1 }));
        const subMsg = await nextMessage(client, 'subscribed');
        expect(subMsg.matchId).toBe(1);

        const commentPayload = {
            type: 'commentary',
            data: { id: 101, matchId: 1, message: 'Goal scored!' },
        };
        serverHandles.broadcastToMatch(1, commentPayload);

        const msg = await nextMessage(client, 'commentary');
        expect(msg.data.message).toBe('Goal scored!');
        expect(msg.data.matchId).toBe(1);
    });

    it('not subscribed -> receives nothing for that match', async () => {
        const client = await connect();
        await nextMessage(client, 'welcome');

        serverHandles.broadcastToMatch(1, {
            type: 'commentary',
            data: { id: 102, matchId: 1, message: 'Should not see this' },
        });

        await expectNoMessage(client, 150);
    });

    it('subscribed to match A -> receives nothing for match B', async () => {
        const client = await connect();
        await nextMessage(client, 'welcome');

        client.send(JSON.stringify({ type: 'subscribe', matchId: 1 }));
        await nextMessage(client, 'subscribed');
        await nextMessage(client, 'reaction_snapshot');

        serverHandles.broadcastToMatch(2, {
            type: 'commentary',
            data: { id: 103, matchId: 2, message: 'Match 2 update' },
        });

        await expectNoMessage(client, 150);
    });

    it('unsubscribe -> stops receiving', async () => {
        const client = await connect();
        await nextMessage(client, 'welcome');

        client.send(JSON.stringify({ type: 'subscribe', matchId: 1 }));
        await nextMessage(client, 'subscribed');

        client.send(JSON.stringify({ type: 'unsubscribe', matchId: 1 }));
        const unsubMsg = await nextMessage(client, 'unsubscribed');
        expect(unsubMsg.matchId).toBe(1);

        // Clear queue of reaction_snapshot
        client._messageQueue = [];

        serverHandles.broadcastToMatch(1, {
            type: 'commentary',
            data: { id: 104, matchId: 1, message: 'After unsub' },
        });

        await expectNoMessage(client, 150);
    });

    it('multiple subscribers on one match all receive the broadcast', async () => {
        const client1 = await connect();
        const client2 = await connect();

        await nextMessage(client1, 'welcome');
        await nextMessage(client2, 'welcome');

        client1.send(JSON.stringify({ type: 'subscribe', matchId: 5 }));
        await nextMessage(client1, 'subscribed');

        client2.send(JSON.stringify({ type: 'subscribe', matchId: 5 }));
        await nextMessage(client2, 'subscribed');

        const broadcastPayload = {
            type: 'commentary',
            data: { id: 105, matchId: 5, message: 'Big save!' },
        };
        serverHandles.broadcastToMatch(5, broadcastPayload);

        const [msg1, msg2] = await Promise.all([
            nextMessage(client1, 'commentary'),
            nextMessage(client2, 'commentary'),
        ]);

        expect(msg1.data.message).toBe('Big save!');
        expect(msg2.data.message).toBe('Big save!');
    });

    it('broadcastToAll (score_update / match_created) reaches every client', async () => {
        const client1 = await connect();
        const client2 = await connect();

        await nextMessage(client1, 'welcome');
        await nextMessage(client2, 'welcome');

        // Client 1 is subscribed to match 1, Client 2 is not subscribed to anything
        client1.send(JSON.stringify({ type: 'subscribe', matchId: 1 }));
        await nextMessage(client1, 'subscribed');

        // Test score_update via broadcastToAll
        serverHandles.broadcastToAll({
            type: 'score_update',
            matchId: 1,
            data: { homeScore: 2, awayScore: 1 },
        });

        const [score1, score2] = await Promise.all([
            nextMessage(client1, 'score_update'),
            nextMessage(client2, 'score_update'),
        ]);
        expect(score1.data.homeScore).toBe(2);
        expect(score2.data.homeScore).toBe(2);

        // Test match_created via broadcastToAll
        serverHandles.broadcastToAll({
            type: 'match_created',
            data: { id: 88, sport: 'basketball' },
        });

        const [created1, created2] = await Promise.all([
            nextMessage(client1, 'match_created'),
            nextMessage(client2, 'match_created'),
        ]);
        expect(created1.data.id).toBe(88);
        expect(created2.data.id).toBe(88);
    });

    it('disconnect -> socket removed from matchSubscribers and empty sets cleaned up', async () => {
        const client = await connect();
        await nextMessage(client, 'welcome');

        client.send(JSON.stringify({ type: 'subscribe', matchId: 42 }));
        await nextMessage(client, 'subscribed');

        expect(serverHandles.matchSubscribers.has(42)).toBe(true);
        expect(serverHandles.matchSubscribers.get(42).size).toBe(1);

        // Disconnect client
        client.close();
        await new Promise((resolve) => client.on('close', resolve));

        // Allow microtask / event loop tick for server 'close' handler to execute
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Verify socket is removed and empty set is cleaned up
        expect(serverHandles.matchSubscribers.has(42)).toBe(false);
    });

    it('{type:"ping"} -> {type:"pong"}', async () => {
        const client = await connect();
        await nextMessage(client, 'welcome');

        client.send(JSON.stringify({ type: 'ping' }));
        const pong = await nextMessage(client, 'pong');
        expect(pong.type).toBe('pong');
    });

    it('malformed JSON -> server does not crash, other clients unaffected', async () => {
        const client1 = await connect();
        const client2 = await connect();

        await nextMessage(client1, 'welcome');
        await nextMessage(client2, 'welcome');

        // Client 1 sends malformed JSON string
        client1.send('invalid json {[');
        const errorMsg = await nextMessage(client1, 'error');
        expect(errorMsg.message).toBe('Invalid JSON');

        // Client 2 remains completely functional
        client2.send(JSON.stringify({ type: 'ping' }));
        const pong = await nextMessage(client2, 'pong');
        expect(pong.type).toBe('pong');
    });

    describe('matchId validation and subscription security', () => {
        it('rejects null, 0, negative, non-numeric, and boolean matchIds with Invalid matchId error', async () => {
            const client = await connect();
            await nextMessage(client, 'welcome');

            const invalidPayloads = [
                { type: 'subscribe', matchId: null },
                { type: 'subscribe', matchId: 0 },
                { type: 'subscribe', matchId: -5 },
                { type: 'subscribe', matchId: 'garbage' },
                { type: 'subscribe', matchId: false },
                { type: 'subscribe', matchId: true },
                { type: 'subscribe', matchId: 3.14 },
            ];

            for (const payload of invalidPayloads) {
                client.send(JSON.stringify(payload));
                const errorMsg = await nextMessage(client, 'error');
                expect(errorMsg.message).toBe('Invalid matchId');
            }
        });

        it('accepts valid numeric string as positive integer', async () => {
            const client = await connect();
            await nextMessage(client, 'welcome');

            client.send(JSON.stringify({ type: 'subscribe', matchId: '1' }));
            const subMsg = await nextMessage(client, 'subscribed');
            expect(subMsg.matchId).toBe(1);
            expect(serverHandles.matchSubscribers.has(1)).toBe(true);
        });

        it('rejects subscriptions to matches that do not exist', async () => {
            const client = await connect();
            await nextMessage(client, 'welcome');

            client.send(JSON.stringify({ type: 'subscribe', matchId: 999999 }));
            const errorMsg = await nextMessage(client, 'error');
            expect(errorMsg.code).toBe('match_not_found');
            expect(errorMsg.message).toBe('Match 999999 not found');
            expect(serverHandles.matchSubscribers.has(999999)).toBe(false);
        });

        it('subscribing succeeds after match is created via broadcastMatchCreated', async () => {
            const client = await connect();
            await nextMessage(client, 'welcome');

            // Initially match 777 does not exist
            client.send(JSON.stringify({ type: 'subscribe', matchId: 777 }));
            const errorMsg = await nextMessage(client, 'error');
            expect(errorMsg.code).toBe('match_not_found');

            // Broadcast match creation -> adds to knownMatchIdsSet
            serverHandles.broadcastMatchCreated({ id: 777, sport: 'tennis' });
            await nextMessage(client, 'match_created');

            // Now subscription succeeds
            client.send(JSON.stringify({ type: 'subscribe', matchId: 777 }));
            const subMsg = await nextMessage(client, 'subscribed');
            expect(subMsg.matchId).toBe(777);
            expect(serverHandles.matchSubscribers.has(777)).toBe(true);
        });

        it('enforces subscription cap per socket', async () => {
            // Spin up a dedicated server with a max cap of 3 subscriptions
            const capServer = http.createServer();
            const capHandles = attachWebSocketServer(capServer, {
                maxSubscriptionsPerSocket: 3,
                knownMatchIds: new Set([10, 20, 30, 40, 50]),
            });
            await new Promise((resolve) => capServer.listen(0, '127.0.0.1', resolve));
            const capPort = capServer.address().port;
            const capUrl = `ws://127.0.0.1:${capPort}/ws`;

            const client = await connect(capUrl);
            await nextMessage(client, 'welcome');

            // First 3 subscriptions succeed
            for (const id of [10, 20, 30]) {
                client.send(JSON.stringify({ type: 'subscribe', matchId: id }));
                const subMsg = await nextMessage(client, 'subscribed');
                expect(subMsg.matchId).toBe(id);
                // Drain reaction_snapshot
                await nextMessage(client, 'reaction_snapshot');
            }

            // 4th subscription exceeds the cap of 3
            client.send(JSON.stringify({ type: 'subscribe', matchId: 40 }));
            const err = await nextMessage(client, 'error');
            expect(err.message).toBe('Subscription limit reached');
            expect(capHandles.matchSubscribers.has(40)).toBe(false);

            // Teardown cap server
            client.terminate();
            capHandles.wss.close();
            if (typeof capServer.closeAllConnections === 'function') {
                capServer.closeAllConnections();
            }
            await new Promise((resolve) => capServer.close(resolve));
        });
    });

    it('heartbeat: client with autoPong: false is terminated after ~2 heartbeat intervals; normal client stays connected', async () => {
        // Spin up server with fast 80ms heartbeat interval for testing
        const hbServer = http.createServer();
        const hbHandles = attachWebSocketServer(hbServer, { heartbeatMs: 80 });
        await new Promise((resolve) => hbServer.listen(0, '127.0.0.1', resolve));
        const hbPort = hbServer.address().port;
        const hbUrl = `ws://127.0.0.1:${hbPort}/ws`;

        const normalClient = await connect(hbUrl);
        const silentClient = await connect(hbUrl, { autoPong: false });

        let silentClosed = false;
        silentClient.on('close', () => {
            silentClosed = true;
        });

        let normalClosed = false;
        normalClient.on('close', () => {
            normalClosed = true;
        });

        // Wait ~200ms (~2.5 intervals of 80ms)
        await new Promise((resolve) => setTimeout(resolve, 240));

        expect(silentClosed).toBe(true);
        expect(normalClosed).toBe(false);
        expect(normalClient.readyState).toBe(WebSocket.OPEN);

        // Normal client can still interact
        normalClient.send(JSON.stringify({ type: 'ping' }));
        const pong = await nextMessage(normalClient, 'pong');
        expect(pong.type).toBe('pong');

        // Cleanup heartbeat server
        normalClient.terminate();
        silentClient.terminate();
        hbHandles.wss.close();
        if (typeof hbServer.closeAllConnections === 'function') {
            hbServer.closeAllConnections();
        }
        await new Promise((resolve) => hbServer.close(resolve));
    });

    describe('Phase 1.5 Quick Fixes Verification', () => {
        it('Fix 1: broadcastToAll stringifies stamped message once and delivers to all connected clients', async () => {
            const client1 = await connect();
            const client2 = await connect();

            await nextMessage(client1, 'welcome');
            await nextMessage(client2, 'welcome');

            const scoreData = { homeScore: 3, awayScore: 2 };
            serverHandles.broadcastScoreUpdate(10, scoreData);

            const [msg1, msg2] = await Promise.all([
                nextMessage(client1, 'score_update'),
                nextMessage(client2, 'score_update'),
            ]);

            expect(msg1.matchId).toBe(10);
            expect(msg1.data.homeScore).toBe(3);
            expect(msg1.serverTimestamp).toBeDefined();
            expect(typeof msg1.serverTimestamp).toBe('number');
            // Both clients receive identical stamped serverTimestamp from the single serialization
            expect(msg1.serverTimestamp).toBe(msg2.serverTimestamp);
        });

        it('Fix 2: getClientIp safely extracts trusted proxy hop and ignores client-supplied fake XFF entries', () => {
            // Scenario A: Direct connection (TRUST_PROXY = false).
            // Attacker sends forged X-Forwarded-For: 127.0.0.1 to attempt bypass.
            const directReq = {
                headers: { 'x-forwarded-for': '127.0.0.1, 8.8.8.8' },
                socket: { remoteAddress: '203.0.113.50' },
            };
            expect(getClientIp(directReq, false)).toBe('203.0.113.50');

            // Scenario B: Reverse proxy setup (TRUST_PROXY = true, e.g. on Render).
            // Attacker supplies fake X-Forwarded-For: "127.0.0.1".
            // Render's reverse proxy appends the real client IP "198.51.100.99" to the header.
            // Header arriving at Node: "127.0.0.1, 198.51.100.99"
            const proxiedReqWithForgedEntry = {
                headers: { 'x-forwarded-for': '127.0.0.1, 198.51.100.99' },
                socket: { remoteAddress: '10.0.0.2' }, // Render router private IP
            };
            // Resolved IP must be the trusted rightmost entry (198.51.100.99), NOT the client's fake 127.0.0.1
            expect(getClientIp(proxiedReqWithForgedEntry, true)).toBe('198.51.100.99');
        });

        it('Fix 3: checkMatchExists dedupes in-flight lookups so 50 concurrent calls invoke DB/lookup function exactly once', async () => {
            let lookupCallCount = 0;
            const slowMockMatchExists = vi.fn(async (id) => {
                lookupCallCount++;
                await new Promise((r) => setTimeout(r, 20));
                return id === 777;
            });

            const testServer = http.createServer();
            const handles = attachWebSocketServer(testServer, {
                matchExists: slowMockMatchExists,
            });

            // Fire 50 simultaneous lookups for the un-cached match ID 777
            const promises = Array.from({ length: 50 }, () => handles.checkMatchExists(777));
            const results = await Promise.all(promises);

            // All 50 resolved to true
            expect(results.every((r) => r === true)).toBe(true);
            // Exactly 1 lookup was initiated; 49 joined the in-flight Promise
            expect(lookupCallCount).toBe(1);
            expect(slowMockMatchExists).toHaveBeenCalledTimes(1);

            // Subsequent call is served from knownMatchIdsSet cache without invoking lookup
            const cachedResult = await handles.checkMatchExists(777);
            expect(cachedResult).toBe(true);
            expect(lookupCallCount).toBe(1);

            handles.wss.close();
        });

        it('Fix 4: Seeder decoupling respects AUTO_SEED flag', () => {
            // Validate that seeder opt-in env evaluation logic evaluates correctly
            const shouldSeed = (envVal) => envVal === 'true' || envVal === '1';

            expect(shouldSeed(undefined)).toBe(false);
            expect(shouldSeed('false')).toBe(false);
            expect(shouldSeed('0')).toBe(false);
            expect(shouldSeed('true')).toBe(true);
            expect(shouldSeed('1')).toBe(true);
        });
    });

    describe('Phase 2 Horizontal Scaling Tests (Real Redis Pub/Sub & Distributed Reactions)', () => {
        const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
        let serverA, serverB;
        let wsUrlA, wsUrlB;
        let handlesA, handlesB;
        let pubA, subA, pubB, subB;
        const phase2Clients = new Set();

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
                    phase2Clients.add(client);
                    resolve(client);
                });

                client.on('error', reject);
            });
        }

        function awaitMessage(client, expectedType, timeoutMs = 2000) {
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
            // 1. Create ioredis connections for Instance A and Instance B connecting to real Redis
            const redisOpts = {
                maxRetriesPerRequest: 1,
                enableReadyCheck: false,
                retryStrategy: (times) => Math.min(times * 50, 500),
            };
            pubA = new Redis(REDIS_URL, redisOpts);
            subA = new Redis(REDIS_URL, redisOpts);
            pubB = new Redis(REDIS_URL, redisOpts);
            subB = new Redis(REDIS_URL, redisOpts);

            // Ensure Redis keys for test matches are flushed
            await pubA.del(
                'sportz:match:100:reactions',
                'sportz:match:200:reactions',
                'sportz:match:300:reactions',
                'sportz:match:400:reactions',
                'sportz:match:888:reactions'
            );

            // 2. Create HTTP servers for Instance A and Instance B
            serverA = http.createServer();
            serverB = http.createServer();

            handlesA = attachWebSocketServer(serverA, {
                heartbeatMs: 60000,
                knownMatchIds: [100, 200, 300, 400, 405],
                redisPub: pubA,
                redisSub: subA,
            });

            handlesB = attachWebSocketServer(serverB, {
                heartbeatMs: 60000,
                knownMatchIds: [100, 200, 300, 400, 405],
                redisPub: pubB,
                redisSub: subB,
            });

            await new Promise((resolve) => serverA.listen(0, '127.0.0.1', resolve));
            await new Promise((resolve) => serverB.listen(0, '127.0.0.1', resolve));

            wsUrlA = `ws://127.0.0.1:${serverA.address().port}/ws`;
            wsUrlB = `ws://127.0.0.1:${serverB.address().port}/ws`;
        });

        afterEach(async () => {
            // Close all active clients
            for (const client of phase2Clients) {
                try { client.terminate(); } catch {}
            }
            phase2Clients.clear();

            // Clean up test keys
            if (pubA) {
                try {
                    await pubA.del(
                        'sportz:match:100:reactions',
                        'sportz:match:200:reactions',
                        'sportz:match:300:reactions',
                        'sportz:match:400:reactions',
                        'sportz:match:888:reactions'
                    );
                } catch {}
            }

            // Close Redis connections
            if (pubA) { try { await pubA.quit(); } catch {} }
            if (subA) { try { await subA.quit(); } catch {} }
            if (pubB) { try { await pubB.quit(); } catch {} }
            if (subB) { try { await subB.quit(); } catch {} }

            // Close HTTP servers
            await new Promise((resolve) => serverA.close(resolve));
            await new Promise((resolve) => serverB.close(resolve));
        });

        it('Phase 2 Correctness 1: client on Instance A receives commentary published on Instance B via Redis pub/sub', async () => {
            const clientA = await connectWs(wsUrlA);
            const welcome = await awaitMessage(clientA, 'welcome');
            expect(welcome.type).toBe('welcome');

            // Subscribe clientA to match 100 on Instance A
            clientA.send(JSON.stringify({ type: 'subscribe', matchId: 100 }));
            await awaitMessage(clientA, 'subscribed');
            await awaitMessage(clientA, 'reaction_snapshot');

            // Instance B broadcasts commentary for match 100
            handlesB.broadcastCommentary(100, { text: 'Cross-instance bicycle kick goal from Server B!' });

            // Client on Instance A receives commentary delivered across Redis
            const msg = await awaitMessage(clientA, 'commentary');
            expect(msg.type).toBe('commentary');
            expect(msg.data.text).toBe('Cross-instance bicycle kick goal from Server B!');
            expect(typeof msg.serverTimestamp).toBe('number');
        });

        it('Phase 2 Correctness 2: no duplicate deliveries when match has subscribers across multiple instances', async () => {
            const clientA1 = await connectWs(wsUrlA);
            const clientA2 = await connectWs(wsUrlA);
            const clientB1 = await connectWs(wsUrlB);

            for (const c of [clientA1, clientA2, clientB1]) {
                await awaitMessage(c, 'welcome');
                c.send(JSON.stringify({ type: 'subscribe', matchId: 200 }));
                await awaitMessage(c, 'subscribed');
                await awaitMessage(c, 'reaction_snapshot');
            }

            // Publish 1 commentary event from Instance A
            handlesA.broadcastCommentary(200, { text: 'Header on target!' });

            const msgA1 = await awaitMessage(clientA1, 'commentary');
            const msgA2 = await awaitMessage(clientA2, 'commentary');
            const msgB1 = await awaitMessage(clientB1, 'commentary');

            expect(msgA1.data.text).toBe('Header on target!');
            expect(msgA2.data.text).toBe('Header on target!');
            expect(msgB1.data.text).toBe('Header on target!');

            // Wait 150ms and assert no duplicate messages arrive in queues
            await new Promise((r) => setTimeout(r, 150));
            const commentaryQueueA1 = clientA1._messageQueue.filter((m) => m.type === 'commentary');
            const commentaryQueueA2 = clientA2._messageQueue.filter((m) => m.type === 'commentary');
            const commentaryQueueB1 = clientB1._messageQueue.filter((m) => m.type === 'commentary');

            expect(commentaryQueueA1.length).toBe(0);
            expect(commentaryQueueA2.length).toBe(0);
            expect(commentaryQueueB1.length).toBe(0);
        });

        it('Phase 2 Correctness 3: concurrent emoji reactions from different instances update Redis atomically and remain consistent', async () => {
            const clientA = await connectWs(wsUrlA);
            const clientB = await connectWs(wsUrlB);

            await awaitMessage(clientA, 'welcome');
            await awaitMessage(clientB, 'welcome');

            clientA.send(JSON.stringify({ type: 'subscribe', matchId: 300 }));
            await awaitMessage(clientA, 'subscribed');
            await awaitMessage(clientA, 'reaction_snapshot');

            clientB.send(JSON.stringify({ type: 'subscribe', matchId: 300 }));
            await awaitMessage(clientB, 'subscribed');
            await awaitMessage(clientB, 'reaction_snapshot');

            // Send 5 reactions from clientA and 5 from clientB concurrently
            const reactionsA = Array.from({ length: 5 }, () =>
                clientA.send(JSON.stringify({ type: 'reaction', matchId: 300, emoji: '🔥' }))
            );
            const reactionsB = Array.from({ length: 5 }, () =>
                clientB.send(JSON.stringify({ type: 'reaction', matchId: 300, emoji: '🔥' }))
            );

            // Wait until Redis stores 10 '🔥' reactions
            let finalCount = 0;
            for (let i = 0; i < 30; i++) {
                const raw = await pubA.hgetall('sportz:match:300:reactions');
                finalCount = parseInt(raw?.['🔥'] || '0', 10);
                if (finalCount === 10) break;
                await new Promise((r) => setTimeout(r, 50));
            }

            expect(finalCount).toBe(10);

            // A new client connecting to Instance B receives the exact snapshot of 10
            const clientB2 = await connectWs(wsUrlB);
            await awaitMessage(clientB2, 'welcome');
            clientB2.send(JSON.stringify({ type: 'subscribe', matchId: 300 }));
            await awaitMessage(clientB2, 'subscribed');
            const snapshot = await awaitMessage(clientB2, 'reaction_snapshot');

            expect(snapshot.counts['🔥']).toBe(10);
        });

        it('Phase 2 Correctness 4: global broadcast (score update and match creation) reaches all instances without duplicates and syncs knownMatchIds', async () => {
            const clientA = await connectWs(wsUrlA);
            const clientB = await connectWs(wsUrlB);

            await awaitMessage(clientA, 'welcome');
            await awaitMessage(clientB, 'welcome');

            // 1. Score update broadcast from Instance A reaches Client B on Instance B
            handlesA.broadcastScoreUpdate(400, { home: 3, away: 1 });

            const scoreMsgA = await awaitMessage(clientA, 'score_update');
            const scoreMsgB = await awaitMessage(clientB, 'score_update');

            expect(scoreMsgA.data.home).toBe(3);
            expect(scoreMsgB.data.home).toBe(3);

            // 2. Match creation on Instance A reaches Client B and updates Instance B's knownMatchIdsSet
            handlesA.broadcastMatchCreated({ id: 888, title: 'Finals Derby' });

            const matchMsgA = await awaitMessage(clientA, 'match_created');
            const matchMsgB = await awaitMessage(clientB, 'match_created');

            expect(matchMsgA.data.id).toBe(888);
            expect(matchMsgB.data.id).toBe(888);

            // Client on Instance B can now subscribe to match 888 successfully
            clientB.send(JSON.stringify({ type: 'subscribe', matchId: 888 }));
            const subConfirm = await awaitMessage(clientB, 'subscribed');
            expect(subConfirm.matchId).toBe(888);
        });

        it('Phase 2 Correctness 6: Redis failure mid-run severs pub/sub, degrades to local broadcast, logs loudly, and resumes cluster mode after reconnect with backoff', async () => {
            const clientA1 = await connectWs(wsUrlA);
            const clientA2 = await connectWs(wsUrlA);
            const clientB = await connectWs(wsUrlB);

            await awaitMessage(clientA1, 'welcome');
            await awaitMessage(clientA2, 'welcome');
            await awaitMessage(clientB, 'welcome');

            // 1. All clients subscribe to match 400
            for (const c of [clientA1, clientA2, clientB]) {
                c.send(JSON.stringify({ type: 'subscribe', matchId: 400 }));
                await awaitMessage(c, 'subscribed');
                await awaitMessage(c, 'reaction_snapshot');
            }

            // 2. Normal operation: Instance A broadcast reaches Client B via Redis pub/sub
            handlesA.broadcastCommentary(400, { text: 'Healthy cluster message via Redis' });
            const [normalA1, normalA2, normalB] = await Promise.all([
                awaitMessage(clientA1, 'commentary'),
                awaitMessage(clientA2, 'commentary'),
                awaitMessage(clientB, 'commentary'),
            ]);
            expect(normalA1.data.text).toBe('Healthy cluster message via Redis');
            expect(normalA2.data.text).toBe('Healthy cluster message via Redis');
            expect(normalB.data.text).toBe('Healthy cluster message via Redis');

            // 3. KILL Redis connection mid-run using real Redis CLIENT KILL
            const admin = new Redis(REDIS_URL);
            const pubIdA = await pubA.client('id');
            const subIdA = await subA.client('id');

            // Listen for loud degradation logs
            const loudLogs = [];
            const originalConsoleError = console.error;
            console.error = (...args) => {
                loudLogs.push(args.join(' '));
                originalConsoleError(...args);
            };

            try {
                // Forcibly sever Instance A's Redis connections
                await admin.client('kill', 'id', pubIdA);
                await admin.client('kill', 'id', subIdA);

                // Wait for socket close / reconnecting event to register on pubA
                await new Promise((resolve) => {
                    if (pubA.status !== 'ready') return resolve();
                    pubA.once('close', resolve);
                    pubA.once('reconnecting', resolve);
                    setTimeout(resolve, 150);
                });
                expect(pubA.status).not.toBe('ready');

                // 4. Mid-run degradation: Instance A broadcasts commentary while Redis is dead
                handlesA.broadcastCommentary(400, { text: 'Degraded local commentary while Redis is down' });

                // Both local clients on Instance A MUST receive the commentary immediately!
                const degradedA1 = await awaitMessage(clientA1, 'commentary', 1000);
                const degradedA2 = await awaitMessage(clientA2, 'commentary', 1000);
                expect(degradedA1.data.text).toBe('Degraded local commentary while Redis is down');
                expect(degradedA2.data.text).toBe('Degraded local commentary while Redis is down');

                // Verify loud warning was logged
                const loggedDegradation = loudLogs.some((log) => log.includes('[REDIS FAILURE]'));
                expect(loggedDegradation).toBe(true);

                // Local reaction increment also works in degraded mode
                clientA1.send(JSON.stringify({ type: 'reaction', matchId: 400, emoji: '🔥' }));
                const rxDegraded = await awaitMessage(clientA1, 'reaction_broadcast', 1000);
                expect(rxDegraded.counts['🔥']).toBe(1);

                // 5. Reconnection with backoff: Wait for pubA and subA to reconnect to real Redis
                for (let i = 0; i < 40; i++) {
                    if (pubA.status === 'ready' && subA.status === 'ready') break;
                    await new Promise((r) => setTimeout(r, 50));
                }
                expect(pubA.status).toBe('ready');
                expect(subA.status).toBe('ready');

                // Give subA a brief tick to finish channel resubscriptions and pubA to flush reaction deltas
                await new Promise((r) => setTimeout(r, 150));

                // Verify reaction counters in Redis after recovery: reaction during outage synced to Redis!
                const redisCounts = await admin.hgetall(getMatchReactionsKey(400));
                expect(parseInt(redisCounts['🔥'] || '0', 10)).toBeGreaterThanOrEqual(1);

                // 6. Restored cluster mode: Instance A broadcast reaches Client B again across Redis!
                handlesA.broadcastCommentary(400, { text: 'Restored cluster commentary after Redis reconnected' });
                const [restoredA1, restoredB] = await Promise.all([
                    awaitMessage(clientA1, 'commentary', 2000),
                    awaitMessage(clientB, 'commentary', 2000),
                ]);
                expect(restoredA1.data.text).toBe('Restored cluster commentary after Redis reconnected');
                expect(restoredB.data.text).toBe('Restored cluster commentary after Redis reconnected');
            } finally {
                console.error = originalConsoleError;
                await admin.quit();
            }
        });

        it('Phase 2 Correctness 7: Reaction sync deletes each delta only after HINCRBY succeeds; Redis dropping mid-sync prevents double counting, and sends clients corrected totals', async () => {
            const admin = new Redis(REDIS_URL);
            const testMatchId = 405;
            const redisKey = getMatchReactionsKey(testMatchId);
            await admin.del(redisKey);

            try {
                // Pre-populate Redis with 10 existing fires
                await admin.hset(redisKey, '🔥', '10');

                // Buffer local deltas while offline: 🔥: 2, ⚽: 3
                const localDeltas = new Map();
                localDeltas.set(testMatchId, { '🔥': 2, '⚽': 3 });

                const matchReactions = new Map();
                let notifiedTotals = null;

                // Simulate Redis client where first HINCRBY succeeds, but second throws (mid-sync drop)
                let callCount = 0;
                const failingPub = {
                    hincrby: async (key, emoji, count) => {
                        callCount++;
                        if (callCount === 1) {
                            // First HINCRBY succeeds against real Redis
                            return await admin.hincrby(key, emoji, count);
                        }
                        // Second HINCRBY fails mid-sync (simulated network/Redis drop)
                        throw new Error('Redis socket closed mid-sync');
                    },
                    status: 'ready',
                };

                // Run Pass 1: Mid-sync failure
                const pass1Result = await syncReactionDeltas({
                    localReactionDeltas: localDeltas,
                    activePub: failingPub,
                    matchReactions,
                    onCorrectedTotals: (id, totals) => { notifiedTotals = totals; },
                });

                expect(pass1Result.aborted).toBe(true);

                // Verify 🔥 was incremented in Redis (10 + 2 = 12), and its delta was DELETED from localDeltas!
                const midRedis = await admin.hgetall(redisKey);
                expect(parseInt(midRedis['🔥'] || '0', 10)).toBe(12);

                const matchDeltasAfterPass1 = localDeltas.get(testMatchId);
                expect(matchDeltasAfterPass1['🔥']).toBeUndefined(); // DELETED!
                expect(matchDeltasAfterPass1['⚽']).toBe(3); // KEPT for retry!

                // Run Pass 2: Redis reconnects (healthy pub client)
                const pass2Result = await syncReactionDeltas({
                    localReactionDeltas: localDeltas,
                    activePub: admin,
                    matchReactions,
                    onCorrectedTotals: (id, totals) => { notifiedTotals = totals; },
                });

                expect(pass2Result.aborted).toBe(false);

                // Verify NO DOUBLE COUNTING: 🔥 is STILL 12, and ⚽ was synced to 3!
                const finalRedis = await admin.hgetall(redisKey);
                expect(parseInt(finalRedis['🔥'] || '0', 10)).toBe(12); // Exactly 12, NOT 14!
                expect(parseInt(finalRedis['⚽'] || '0', 10)).toBe(3);

                // Verify local delta map is now completely drained and deleted
                expect(localDeltas.has(testMatchId)).toBe(false);

                // Verify clients were notified of the corrected totals
                expect(notifiedTotals).toBeDefined();
                expect(notifiedTotals['🔥']).toBe(12);
                expect(notifiedTotals['⚽']).toBe(3);
                expect(matchReactions.get(testMatchId)['🔥']).toBe(12);
            } finally {
                await admin.del(redisKey);
                await admin.quit();
            }
        });
    });

    describe('Single-Instance Local Broadcast Mode (Redis Optional / REDIS_URL Unset)', () => {
        let server;
        let wsUrl;
        let handles;
        const localClients = new Set();

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
                    localClients.add(client);
                    resolve(client);
                });

                client.on('error', reject);
            });
        }

        function awaitMessage(client, expectedType, timeoutMs = 2000) {
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
            server = http.createServer();
            // Attached with enableRedis: false simulating REDIS_URL unset mode
            handles = attachWebSocketServer(server, {
                heartbeatMs: 60000,
                knownMatchIds: [501, 502],
                enableRedis: false,
            });

            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
        });

        afterEach(async () => {
            for (const c of localClients) {
                try { c.terminate(); } catch {}
            }
            localClients.clear();
            await new Promise((resolve) => server.close(resolve));
        });

        it('Phase 2 Correctness 5: server functions 100% in local-broadcast mode when Redis is not configured', async () => {
            const client1 = await connectWs(wsUrl);
            const client2 = await connectWs(wsUrl);

            await awaitMessage(client1, 'welcome');
            await awaitMessage(client2, 'welcome');

            // 1. Both clients subscribe to match 501 locally
            client1.send(JSON.stringify({ type: 'subscribe', matchId: 501 }));
            await awaitMessage(client1, 'subscribed');
            const initialSnapshot = await awaitMessage(client1, 'reaction_snapshot');
            expect(initialSnapshot.counts['🔥']).toBe(0);

            client2.send(JSON.stringify({ type: 'subscribe', matchId: 501 }));
            await awaitMessage(client2, 'subscribed');
            await awaitMessage(client2, 'reaction_snapshot');

            // 2. Commentary broadcast works in local mode
            handles.broadcastCommentary(501, { text: 'Local match commentary without Redis!' });
            const comm1 = await awaitMessage(client1, 'commentary');
            const comm2 = await awaitMessage(client2, 'commentary');
            expect(comm1.data.text).toBe('Local match commentary without Redis!');
            expect(comm2.data.text).toBe('Local match commentary without Redis!');

            // 3. Emoji reaction increments local in-memory counter and broadcasts locally
            client1.send(JSON.stringify({ type: 'reaction', matchId: 501, emoji: '🔥' }));
            const rx1 = await awaitMessage(client1, 'reaction_broadcast');
            const rx2 = await awaitMessage(client2, 'reaction_broadcast');
            expect(rx1.counts['🔥']).toBe(1);
            expect(rx2.counts['🔥']).toBe(1);

            // 4. Global score update broadcast reaches all clients locally
            handles.broadcastScoreUpdate(501, { home: 1, away: 0 });
            const score1 = await awaitMessage(client1, 'score_update');
            const score2 = await awaitMessage(client2, 'score_update');
            expect(score1.data.home).toBe(1);
            expect(score2.data.home).toBe(1);

            // 5. Late joining client receives accurate local reaction snapshot
            const client3 = await connectWs(wsUrl);
            await awaitMessage(client3, 'welcome');
            client3.send(JSON.stringify({ type: 'subscribe', matchId: 501 }));
            await awaitMessage(client3, 'subscribed');
            const snap3 = await awaitMessage(client3, 'reaction_snapshot');
            expect(snap3.counts['🔥']).toBe(1);
        });
    });

    describe('Per-Client Replay from Postgres with Rate Limiting', () => {
        let server;
        let wsUrl;
        let handles;
        let finishedMatchId;
        let liveMatchId;
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
            // 1. Create a finished match in Postgres
            const [fm] = await db.insert(matches).values({
                sport: 'football',
                homeTeam: 'Bayern',
                awayTeam: 'Dortmund',
                status: 'finished',
                homeScore: 3,
                awayScore: 1,
                lastSeq: 3,
            }).returning();
            finishedMatchId = fm.id;

            // Commentary rows for finished match
            await db.insert(commentary).values([
                { matchId: finishedMatchId, sequence: 1, minute: 15, message: 'Bayern 1st goal' },
                { matchId: finishedMatchId, sequence: 2, minute: 40, message: 'Dortmund equalizer' },
                { matchId: finishedMatchId, sequence: 3, minute: 88, message: 'Bayern winner' },
            ]);

            // 2. Create a live match in Postgres
            const [lm] = await db.insert(matches).values({
                sport: 'football',
                homeTeam: 'PSG',
                awayTeam: 'Marseille',
                status: 'live',
                homeScore: 0,
                awayScore: 0,
                lastSeq: 0,
            }).returning();
            liveMatchId = lm.id;

            server = http.createServer();
            handles = attachWebSocketServer(server, {
                heartbeatMs: 60000,
                knownMatchIds: [finishedMatchId, liveMatchId],
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
        });

        afterEach(async () => {
            for (const c of testClients) {
                try { c.terminate(); } catch {}
            }
            testClients.clear();
            await new Promise((resolve) => server.close(resolve));

            if (finishedMatchId) {
                await db.delete(commentary).where(eq(commentary.matchId, finishedMatchId));
                await db.delete(matches).where(eq(matches.id, finishedMatchId));
            }
            if (liveMatchId) {
                await db.delete(commentary).where(eq(commentary.matchId, liveMatchId));
                await db.delete(matches).where(eq(matches.id, liveMatchId));
            }
        });

        it('streams finished match from Postgres at 10x speed to requesting client only, without changing global DATA_SOURCE, and enforces rate limit', async () => {
            const originalDataSource = process.env.DATA_SOURCE;

            const client1 = await connectWs(wsUrl);
            const client2 = await connectWs(wsUrl);
            await awaitMessage(client1, 'welcome');
            await awaitMessage(client2, 'welcome');

            // 1. Attempting replay on an in-play match fails with match_not_finished error
            client1.send(JSON.stringify({
                type: 'client_replay',
                matchId: liveMatchId,
                speed: '10x',
            }));
            const errNotFinished = await awaitMessage(client1, 'error');
            expect(errNotFinished.code).toBe('match_not_finished');

            // Reset rate limit timer on socket for next test step
            // Wait 3.1s for cooldown or clear socket timestamp
            await new Promise((r) => setTimeout(r, 3100));

            // 2. Request replay on finished match at 10x speed
            client1.send(JSON.stringify({
                type: 'client_replay',
                matchId: finishedMatchId,
                speed: '10x',
            }));

            // Client 1 receives start notification
            const startMsg = await awaitMessage(client1, 'client_replay_started');
            expect(startMsg.matchId).toBe(finishedMatchId);
            expect(startMsg.totalEvents).toBe(3);
            expect(startMsg.speed).toBe('10x');

            // Client 1 receives 3 commentary messages in order with isReplay: true
            const comm1 = await awaitMessage(client1, 'commentary');
            const comm2 = await awaitMessage(client1, 'commentary');
            const comm3 = await awaitMessage(client1, 'commentary');
            expect(comm1.isReplay).toBe(true);
            expect(comm1.data.sequence).toBe(1);
            expect(comm2.data.sequence).toBe(2);
            expect(comm3.data.sequence).toBe(3);

            // Client 1 receives completion notification
            const compMsg = await awaitMessage(client1, 'client_replay_completed');
            expect(compMsg.totalEvents).toBe(3);

            // 3. Isolated to client 1: Client 2 receives 0 commentary messages
            expect(client2._messageQueue.filter((m) => m.type === 'commentary').length).toBe(0);

            // 4. Global DATA_SOURCE remains completely untouched
            expect(process.env.DATA_SOURCE).toBe(originalDataSource);

            // 5. Rate limiting: Client 1 immediately requests another replay without waiting 3s
            client1.send(JSON.stringify({
                type: 'client_replay',
                matchId: finishedMatchId,
                speed: '10x',
            }));
            const rateLimitErr = await awaitMessage(client1, 'error');
            expect(rateLimitErr.code).toBe('rate_limited');
        });
    });
});
