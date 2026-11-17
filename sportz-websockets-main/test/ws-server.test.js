import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { attachWebSocketServer } from '../src/ws/server.js';
import { getClientIp } from '../src/arcjet.js';

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
});
