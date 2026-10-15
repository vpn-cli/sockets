import { WebSocket, WebSocketServer } from 'ws';
import { wsArcjet, isLocalhostIp } from "../arcjet.js";

const matchSubscribers = new Map();
const matchReactions = new Map();
const ALLOWED_EMOJIS = ['🔥', '👏', '⚡', '❤️', '⚽', '🎯'];

function subscribe(matchId, socket) {
    if(!matchSubscribers.has(matchId)) {
        matchSubscribers.set(matchId, new Set());
    }

    matchSubscribers.get(matchId).add(socket);
}

function unsubscribe(matchId, socket) {
    const subscribers = matchSubscribers.get(matchId);

    if(!subscribers) return;

    subscribers.delete(socket);

    if(subscribers.size === 0) {
        matchSubscribers.delete(matchId);
    }
}

function cleanupSubscriptions(socket) {
    for(const matchId of socket.subscriptions) {
        unsubscribe(matchId, socket);
    }
}

function sendJson(socket, payload) {
    if(socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(payload));
}

function broadcastToAll(wss, payload) {
    for (const client of wss.clients)  {
        if(client.readyState !== WebSocket.OPEN) continue;

        client.send(JSON.stringify(payload));
    }
}

function broadcastToMatch(matchId, payload) {
    const subscribers = matchSubscribers.get(matchId);
    if(!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify(payload);

    for(const client of subscribers) {
        if(client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function handleMessage(socket, data) {
    let message;

    try {
        message = JSON.parse(data.toString());
    } catch {
        sendJson(socket, { type: 'error', message: 'Invalid JSON' });
        return;
    }

    const matchId = Number(message?.matchId);

    if(message?.type === "subscribe" && Number.isInteger(matchId)) {
        subscribe(matchId, socket);
        socket.subscriptions.add(matchId);
        sendJson(socket, { type: 'subscribed', matchId });
        // Send initial reaction counts
        sendJson(socket, {
            type: 'reaction_snapshot',
            matchId,
            counts: matchReactions.get(matchId) || { '🔥': 0, '👏': 0, '⚡': 0, '❤️': 0, '⚽': 0, '🎯': 0 }
        });
        return;
    }

    if(message?.type === "reaction" && Number.isInteger(matchId)) {
        const emoji = message?.emoji;
        if (typeof emoji === 'string' && ALLOWED_EMOJIS.includes(emoji)) {
            if (!matchReactions.has(matchId)) {
                matchReactions.set(matchId, { '🔥': 0, '👏': 0, '⚡': 0, '❤️': 0, '⚽': 0, '🎯': 0 });
            }
            const counts = matchReactions.get(matchId);
            counts[emoji] = (counts[emoji] || 0) + 1;

            broadcastToMatch(matchId, {
                type: 'reaction_broadcast',
                matchId,
                emoji,
                counts: { ...counts }
            });
            return;
        }
    }

    if(message?.type === "unsubscribe" && Number.isInteger(matchId)) {
        unsubscribe(matchId, socket);
        socket.subscriptions.delete(matchId);
        sendJson(socket, { type: 'unsubscribed', matchId });
        return;
    }

    if(message?.type === "ping") {
        sendJson(socket, { type: 'pong' });
    }
}

export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({ noServer: true, path: '/ws', maxPayload: 1024 * 1024 });

    server.on('upgrade', async (req, socket, head) => {
        const { pathname } = new URL(req.url, `http://${req.headers.host}`);

        if (pathname !== '/ws') {
            return;
        }

        const clientIp = req.socket.remoteAddress;
        if (wsArcjet && !isLocalhostIp(clientIp)) {
            try {
                const decision = await wsArcjet.protect(req);

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
    }, 30000);

    wss.on('close', () => clearInterval(interval));

    function broadcastMatchCreated(match) {
        broadcastToAll(wss, { type: 'match_created', data: match });
    }

    function broadcastCommentary(matchId, comment) {
        broadcastToMatch(matchId, { type: 'commentary', data: comment });
    }

    function broadcastScoreUpdate(matchId, scoreData) {
        broadcastToAll(wss, { type: 'score_update', matchId: Number(matchId), data: scoreData });
    }

    return { broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate };
}

