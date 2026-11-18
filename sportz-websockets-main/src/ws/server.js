import { WebSocket, WebSocketServer } from 'ws';
import { wsArcjet, isLocalhostIp, getClientIp } from "../arcjet.js";
import {
    getMatchChannel,
    GLOBAL_CHANNEL,
    isRedisActive,
    getPublisher,
    getSubscriber,
    publishEvent,
    recordReactionInRedis,
    fetchReactionCountsFromRedis,
} from "../redis/redis.js";

const ALLOWED_EMOJIS = ['🔥', '👏', '⚡', '❤️', '⚽', '🎯'];

function sendJson(socket, payload) {
    if(socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(payload));
}

function broadcastToAll(wss, payload) {
    const stamped = payload.serverTimestamp ? payload : { ...payload, serverTimestamp: Date.now() };
    if (process.env.BENCHMARK_LOOP_STRINGIFY === '1' || process.env.BENCHMARK_LOOP_STRINGIFY === 'true') {
        for (const client of wss.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            client.send(JSON.stringify(stamped));
        }
        return;
    }
    const message = JSON.stringify(stamped);
    for (const client of wss.clients) {
        if(client.readyState !== WebSocket.OPEN) continue;

        client.send(message);
    }
}

function parsePositiveInteger(val) {
    if (typeof val === 'number') {
        return Number.isInteger(val) && val > 0 ? val : null;
    }
    if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
        const num = Number(val.trim());
        return Number.isInteger(num) && num > 0 ? num : null;
    }
    return null;
}

let checkMatchExistsQueryCount = 0;
let lastQueryTiming = { queryDurationMs: 0 };

export function getLastQueryTiming() {
    return lastQueryTiming;
}

export function getCheckMatchExistsQueryCount() {
    return checkMatchExistsQueryCount;
}

export function resetCheckMatchExistsQueryCount() {
    checkMatchExistsQueryCount = 0;
}

export function attachWebSocketServer(server, {
    heartbeatMs = 30000,
    maxSubscriptionsPerSocket = 50,
    knownMatchIds = null,
    matchExists = null,
    redisPub = null,
    redisSub = null,
    enableRedis = true,
} = {}) {
    const matchSubscribers = new Map();
    const matchReactions = new Map();
    const inFlightMatchLookups = new Map();
    const negativeMatchIdsSet = new Set();
    const matchEventBuffer = new Map();

    const activePub = enableRedis ? (redisPub || getPublisher()) : null;
    const activeSub = enableRedis ? (redisSub || getSubscriber()) : null;

    function localBroadcastToMatch(matchId, payload) {
        const subscribers = matchSubscribers.get(matchId);
        if(!subscribers || subscribers.size === 0) return;

        const stamped = payload.serverTimestamp ? payload : { ...payload, serverTimestamp: Date.now() };
        const message = JSON.stringify(stamped);

        for(const client of subscribers) {
            if(client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    }

    function localBroadcastToAll(payload) {
        const stamped = payload.serverTimestamp ? payload : { ...payload, serverTimestamp: Date.now() };
        if (process.env.BENCHMARK_LOOP_STRINGIFY === '1' || process.env.BENCHMARK_LOOP_STRINGIFY === 'true') {
            for (const client of wss.clients) {
                if (client.readyState !== WebSocket.OPEN) continue;
                client.send(JSON.stringify(stamped));
            }
            return;
        }
        const message = JSON.stringify(stamped);
        for (const client of wss.clients) {
            if(client.readyState !== WebSocket.OPEN) continue;
            client.send(message);
        }
    }

    if (activeSub) {
        activeSub.subscribe(GLOBAL_CHANNEL).catch(() => {});
        activeSub.on('message', (channel, raw) => {
            try {
                const parsed = JSON.parse(raw);
                if (channel === GLOBAL_CHANNEL) {
                    if (parsed.type === 'match_created' && parsed.data?.id) {
                        knownMatchIdsSet.add(Number(parsed.data.id));
                    }
                    localBroadcastToAll(parsed);
                } else if (channel.startsWith('sportz:match:')) {
                    const matchId = Number(channel.split(':')[2]);
                    if (matchId) {
                        localBroadcastToMatch(matchId, parsed);
                    }
                }
            } catch {}
        });

        activeSub.on('ready', () => {
            console.log('🔄 [Redis Sub] Redis connection ready/restored. Resubscribing active match channels...');
            activeSub.subscribe(GLOBAL_CHANNEL).catch(() => {});
            for (const matchId of matchSubscribers.keys()) {
                activeSub.subscribe(getMatchChannel(matchId)).catch(() => {});
            }
        });
    }

    const knownMatchIdsSet = knownMatchIds instanceof Set
        ? knownMatchIds
        : Array.isArray(knownMatchIds)
            ? new Set(knownMatchIds)
            : new Set();

    async function checkMatchExists(matchId) {
        if (knownMatchIds !== null && typeof matchExists !== 'function') {
            return knownMatchIdsSet.has(matchId);
        }
        if (knownMatchIdsSet.has(matchId)) {
            return true;
        }
        if (negativeMatchIdsSet.has(matchId)) {
            return false;
        }

        // Dedupe in-flight lookups: join pending Promise for this matchId
        if (inFlightMatchLookups.has(matchId)) {
            return await inFlightMatchLookups.get(matchId);
        }

        const lookupPromise = (async () => {
            if (typeof matchExists === 'function') {
                const res = await matchExists(matchId);
                if (res) {
                    knownMatchIdsSet.add(matchId);
                } else {
                    negativeMatchIdsSet.add(matchId);
                }
                return res;
            }
            try {
                if (process.env.DATABASE_URL) {
                    checkMatchExistsQueryCount++;
                    const { db } = await import("../db/db.js");
                    const { matches } = await import("../db/schema.js");
                    const { eq } = await import("drizzle-orm");
                    const queryStart = Date.now();
                    const [row] = await db
                        .select({ id: matches.id })
                        .from(matches)
                        .where(eq(matches.id, matchId))
                        .limit(1);
                    lastQueryTiming = {
                        queryDurationMs: Date.now() - queryStart,
                        timestamp: Date.now(),
                    };
                    if (row) {
                        knownMatchIdsSet.add(matchId);
                        return true;
                    }
                    negativeMatchIdsSet.add(matchId);
                    return false;
                }
            } catch {
                // DB not reachable or unconfigured (e.g. tests)
            }
            return false;
        })().finally(() => {
            inFlightMatchLookups.delete(matchId);
        });

        inFlightMatchLookups.set(matchId, lookupPromise);
        return await lookupPromise;
    }

    function subscribe(matchId, socket) {
        if(!matchSubscribers.has(matchId)) {
            matchSubscribers.set(matchId, new Set());
            if (activeSub) {
                activeSub.subscribe(getMatchChannel(matchId)).catch(() => {});
            }
        }

        matchSubscribers.get(matchId).add(socket);
    }

    function unsubscribe(matchId, socket) {
        const subscribers = matchSubscribers.get(matchId);

        if(!subscribers) return;

        subscribers.delete(socket);

        if(subscribers.size === 0) {
            matchSubscribers.delete(matchId);
            if (activeSub) {
                activeSub.unsubscribe(getMatchChannel(matchId)).catch(() => {});
            }
        }
    }

    function cleanupSubscriptions(socket) {
        for(const matchId of socket.subscriptions) {
            unsubscribe(matchId, socket);
        }
    }

    function broadcastToMatch(matchId, payload) {
        const stamped = payload.serverTimestamp ? payload : { ...payload, serverTimestamp: Date.now() };

        if (activePub && activePub.status === 'ready') {
            publishEvent(getMatchChannel(matchId), stamped, activePub).then((res) => {
                if (!res || !res.success) {
                    console.error(`🚨 [REDIS FAILURE] Failed to publish event for match ${matchId} (${res?.reason || res?.error}). Degrading to local-only broadcast.`);
                    localBroadcastToMatch(matchId, stamped);
                }
            }).catch((err) => {
                console.error(`🚨 [REDIS FAILURE] Publish exception for match ${matchId}: ${err.message}. Degrading to local-only broadcast.`);
                localBroadcastToMatch(matchId, stamped);
            });
            return;
        }

        if (activePub) {
            console.error(`🚨 [REDIS FAILURE] Redis pub client is not ready (status: ${activePub.status}). Degrading to local-only broadcast for match ${matchId}.`);
        }
        localBroadcastToMatch(matchId, stamped);
    }

    async function handleMessage(socket, data) {
        let message;

        try {
            message = JSON.parse(data.toString());
        } catch {
            sendJson(socket, { type: 'error', message: 'Invalid JSON' });
            return;
        }

        if(message?.type === "subscribe") {
            const matchId = parsePositiveInteger(message?.matchId);
            if (matchId === null) {
                sendJson(socket, { type: 'error', message: 'Invalid matchId' });
                return;
            }

            const exists = await checkMatchExists(matchId);
            if (!exists) {
                sendJson(socket, {
                    type: 'error',
                    code: 'match_not_found',
                    message: `Match ${matchId} not found`
                });
                return;
            }

            if (!socket.subscriptions.has(matchId) && socket.subscriptions.size >= maxSubscriptionsPerSocket) {
                sendJson(socket, { type: 'error', message: 'Subscription limit reached' });
                return;
            }

            subscribe(matchId, socket);
            socket.subscriptions.add(matchId);
            sendJson(socket, { type: 'subscribed', matchId });

            let reactionCounts = null;
            if (activePub && activePub.status === 'ready') {
                reactionCounts = await fetchReactionCountsFromRedis(matchId, activePub);
            }
            if (!reactionCounts) {
                reactionCounts = matchReactions.get(matchId) || { '🔥': 0, '👏': 0, '⚡': 0, '❤️': 0, '⚽': 0, '🎯': 0 };
            }

            // Send initial reaction counts (reactions are snapshot-only)
            sendJson(socket, {
                type: 'reaction_snapshot',
                matchId,
                counts: reactionCounts
            });

            // Replay Missed Messages on Reconnect (seq > lastSeq)
            const lastSeq = typeof message?.lastSeq === 'number' && Number.isInteger(message.lastSeq) && message.lastSeq >= 0
                ? message.lastSeq
                : null;

            if (lastSeq !== null) {
                let replayedEvents = null;
                let isOversizedGap = false;

                // 1. Fetch from Postgres if configured
                if (process.env.DATABASE_URL) {
                    try {
                        const { db } = await import("../db/db.js");
                        const { commentary, matches } = await import("../db/schema.js");
                        const { eq, gt, asc, desc, and } = await import("drizzle-orm");

                        // Fetch up to 201 events to detect if gap exceeds 200
                        const rows = await db
                            .select()
                            .from(commentary)
                            .where(and(eq(commentary.matchId, matchId), gt(commentary.sequence, lastSeq)))
                            .orderBy(asc(commentary.sequence))
                            .limit(201);

                        if (rows.length > 200) {
                            isOversizedGap = true;
                            const [matchRow] = await db
                                .select()
                                .from(matches)
                                .where(eq(matches.id, matchId))
                                .limit(1);

                            const recent = await db
                                .select()
                                .from(commentary)
                                .where(eq(commentary.matchId, matchId))
                                .orderBy(desc(commentary.sequence))
                                .limit(50);

                            sendJson(socket, {
                                type: 'snapshot',
                                matchId,
                                reason: 'gap_exceeded',
                                match: matchRow || null,
                                recentCommentary: recent.reverse(),
                            });
                        } else {
                            replayedEvents = rows;
                        }
                    } catch (err) {
                        console.warn(`[Replay] DB query skipped/failed for match ${matchId}:`, err.message);
                    }
                }

                // 2. Fallback to in-memory event buffer (for local/test mode without DB)
                if (!isOversizedGap && replayedEvents === null) {
                    const buffer = matchEventBuffer.get(matchId) || [];
                    const filtered = buffer.filter((e) => (e.sequence || e.seq) > lastSeq);
                    const currentMax = buffer.length > 0 ? (buffer[buffer.length - 1].sequence || buffer[buffer.length - 1].seq) : lastSeq;

                    if (currentMax - lastSeq > 200) {
                        sendJson(socket, {
                            type: 'snapshot',
                            matchId,
                            reason: 'gap_exceeded',
                            recentCommentary: buffer.slice(-50),
                        });
                        isOversizedGap = true;
                    } else {
                        replayedEvents = filtered;
                    }
                }

                // 3. Deliver replayed events in order with no duplicates
                if (!isOversizedGap && Array.isArray(replayedEvents) && replayedEvents.length > 0) {
                    sendJson(socket, {
                        type: 'replay_events',
                        matchId,
                        events: replayedEvents,
                        count: replayedEvents.length,
                    });

                    for (const ev of replayedEvents) {
                        sendJson(socket, {
                            type: 'commentary',
                            data: ev,
                            isReplay: true,
                        });
                    }
                }
            }

            return;
        }

        if(message?.type === "reaction") {
            const matchId = parsePositiveInteger(message?.matchId);
            if (matchId === null) {
                sendJson(socket, { type: 'error', message: 'Invalid matchId' });
                return;
            }

            const emoji = message?.emoji;
            if (typeof emoji === 'string' && ALLOWED_EMOJIS.includes(emoji)) {
                let counts = null;
                if (activePub && activePub.status === 'ready') {
                    counts = await recordReactionInRedis(matchId, emoji, activePub);
                }
                if (!counts) {
                    if (!matchReactions.has(matchId)) {
                        matchReactions.set(matchId, { '🔥': 0, '👏': 0, '⚡': 0, '❤️': 0, '⚽': 0, '🎯': 0 });
                    }
                    const localCounts = matchReactions.get(matchId);
                    localCounts[emoji] = (localCounts[emoji] || 0) + 1;
                    counts = { ...localCounts };
                }

                broadcastToMatch(matchId, {
                    type: 'reaction_broadcast',
                    matchId,
                    emoji,
                    counts: { ...counts }
                });
                return;
            }
        }

        if(message?.type === "unsubscribe") {
            const matchId = parsePositiveInteger(message?.matchId);
            if (matchId === null) {
                sendJson(socket, { type: 'error', message: 'Invalid matchId' });
                return;
            }

            unsubscribe(matchId, socket);
            socket.subscriptions.delete(matchId);
            sendJson(socket, { type: 'unsubscribed', matchId });
            return;
        }

        if(message?.type === "ping") {
            sendJson(socket, { type: 'pong' });
        }
    }

    const wss = new WebSocketServer({ noServer: true, path: '/ws', maxPayload: 1024 * 1024 });

    server.on('upgrade', async (req, socket, head) => {
        const { pathname } = new URL(req.url, `http://${req.headers.host}`);

        if (pathname !== '/ws') {
            return;
        }

        const clientIp = getClientIp(req);
        if (wsArcjet && !isLocalhostIp(clientIp)) {
            try {
                const decision = await wsArcjet.protect(req, { ip: clientIp });

                if (decision.isDenied()) {
                    if (decision.reason.isRateLimit()) {
                        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
                    } else {
                        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    }
                    socket.destroy();
                    return;
                }
            } catch (e) {
                console.error('WS upgrade protection error', e);
                if (process.env.NODE_ENV === 'production') {
                    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                    socket.destroy();
                    return;
                }
            }
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', async (socket, req) => {
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });

        socket.subscriptions = new Set();

        sendJson(socket, { type: 'welcome' });

        socket.on('message', (data) => {
            handleMessage(socket, data);
        });

        socket.on('error', () => {
            socket.terminate();
        });

        socket.on('close', () => {
            cleanupSubscriptions(socket);
        });

        socket.on('error', console.error);
    });

    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();

            ws.isAlive = false;
            ws.ping();
        });
    }, heartbeatMs);

    wss.on('close', () => clearInterval(interval));
    server.on('close', () => {
        clearInterval(interval);
        wss.close();
    });

    const broadcastToAllClients = (arg1, arg2) => {
        const payload = arg2 !== undefined ? arg2 : arg1;
        const stamped = payload.serverTimestamp ? payload : { ...payload, serverTimestamp: Date.now() };

        if (activePub && activePub.status === 'ready') {
            publishEvent(GLOBAL_CHANNEL, stamped, activePub).then((res) => {
                if (!res || !res.success) {
                    console.error(`🚨 [REDIS FAILURE] Failed to publish global event (${res?.reason || res?.error}). Degrading to local-only broadcast.`);
                    localBroadcastToAll(stamped);
                }
            }).catch((err) => {
                console.error(`🚨 [REDIS FAILURE] Global publish exception: ${err.message}. Degrading to local-only broadcast.`);
                localBroadcastToAll(stamped);
            });
            return;
        }

        if (activePub) {
            console.error(`🚨 [REDIS FAILURE] Redis pub client is not ready (status: ${activePub.status}). Degrading to local-only broadcast.`);
        }
        localBroadcastToAll(stamped);
    };

    function broadcastMatchCreated(match) {
        const id = parsePositiveInteger(match?.id);
        if (id !== null) {
            knownMatchIdsSet.add(id);
        }
        broadcastToAllClients({ type: 'match_created', data: match });
    }

    function broadcastCommentary(matchId, comment) {
        const id = Number(matchId);
        let buf = matchEventBuffer.get(id);
        if (!buf) {
            buf = [];
            matchEventBuffer.set(id, buf);
        }
        buf.push(comment);
        if (buf.length > 250) buf.shift();

        broadcastToMatch(id, { type: 'commentary', data: comment });
    }

    function broadcastScoreUpdate(matchId, scoreData) {
        broadcastToAllClients({ type: 'score_update', matchId: Number(matchId), data: scoreData });
    }

    return {
        wss,
        broadcastToAll: broadcastToAllClients,
        broadcastToMatch,
        matchSubscribers,
        knownMatchIds: knownMatchIdsSet,
        checkMatchExists,
        broadcastMatchCreated,
        broadcastCommentary,
        broadcastScoreUpdate,
        getCheckMatchExistsQueryCount,
        resetCheckMatchExistsQueryCount,
        getLastQueryTiming,
    };
}

