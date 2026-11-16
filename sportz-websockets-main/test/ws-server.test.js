import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { attachWebSocketServer } from '../src/ws/server.js';

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
        serverHandles = attachWebSocketServer(server, { heartbeatMs: 30000 });
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

    describe('invalid matchId on subscribe behaviour', () => {
        it('ignores non-numeric/non-integer string matchId without crashing or subscribing', async () => {
            const client = await connect();
            await nextMessage(client, 'welcome');

            // Send non-integer garbage string
            client.send(JSON.stringify({ type: 'subscribe', matchId: 'garbage' }));

            // Server ignores it (Number("garbage") is NaN -> Number.isInteger(NaN) is false)
            await expectNoMessage(client, 150);
            expect(serverHandles.matchSubscribers.has(NaN)).toBe(false);
        });

        it('currently accepts any integer (including non-existent match IDs and null -> 0) because DB validation is omitted', async () => {
            const client = await connect();
            await nextMessage(client, 'welcome');

            // Arbitrary non-existent match ID integer
            client.send(JSON.stringify({ type: 'subscribe', matchId: 999999 }));
            const subMsg = await nextMessage(client, 'subscribed');
            expect(subMsg.matchId).toBe(999999);
            expect(serverHandles.matchSubscribers.has(999999)).toBe(true);

            // null coerces to 0 via Number(null), which Number.isInteger(0) accepts
            client.send(JSON.stringify({ type: 'subscribe', matchId: null }));
            const nullSubMsg = await nextMessage(client, 'subscribed');
            expect(nullSubMsg.matchId).toBe(0);
            expect(serverHandles.matchSubscribers.has(0)).toBe(true);
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
        // Interval 1 (80ms): server marks isAlive=false, pings both
        // normalClient automatically sends pong -> server marks isAlive=true
        // silentClient does NOT send pong -> server leaves isAlive=false
        // Interval 2 (160ms): silentClient has isAlive=false -> terminated!
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
        hbHandles.wss.close();
        await new Promise((resolve) => hbServer.close(resolve));
    });
});
