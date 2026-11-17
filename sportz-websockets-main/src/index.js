try {
    const { default: AgentAPI } = await import("apminsight");
    AgentAPI.config();
} catch (e) {
    // APM Insight is optional; fail gracefully if unavailable
}

import express from 'express';
import http from 'http';
import cors from 'cors';
import { matchRouter } from "./routes/matches.js";
import { attachWebSocketServer, getCheckMatchExistsQueryCount, resetCheckMatchExistsQueryCount } from "./ws/server.js";
import { securityMiddleware } from "./arcjet.js";
import { commentaryRouter } from "./routes/commentary.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

if (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
}

app.use(cors({
    origin: '*', // Allows all origins, including localhost and Vercel domains
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Hello from Sportz Express server!');
});

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    const currentCpu = process.cpuUsage();
    const currentTime = Date.now();
    const elapsedMs = Math.max(1, currentTime - lastCpuTime);
    const userDiffMs = (currentCpu.user - lastCpuUsage.user) / 1000;
    const sysDiffMs = (currentCpu.system - lastCpuUsage.system) / 1000;
    const cpuPercent = Number((((userDiffMs + sysDiffMs) / elapsedMs) * 100).toFixed(1));

    lastCpuUsage = currentCpu;
    lastCpuTime = currentTime;

    if (req.query.resetQueries === '1') {
        resetCheckMatchExistsQueryCount();
    }
    if (typeof global.gc === 'function' && req.query.gc === '1') {
        global.gc();
    }

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cpuPercent,
        dbQueriesFired: getCheckMatchExistsQueryCount(),
        memory: {
            rssMb: Number((mem.rss / (1024 * 1024)).toFixed(2)),
            heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
            heapTotalMb: Number((mem.heapTotal / (1024 * 1024)).toFixed(2)),
        },
        uptime: process.uptime(),
    });
});

app.use(securityMiddleware());

app.use('/matches', matchRouter);
app.use('/matches/:id/commentary', commentaryRouter);

const { broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentary = broadcastCommentary;
app.locals.broadcastScoreUpdate = broadcastScoreUpdate;

if (process.env.BENCHMARK_BYPASS_ARCJET) {
    app.post('/benchmark/broadcast-all', (req, res) => {
        const payload = req.body && Object.keys(req.body).length > 0 ? req.body : {
            matchId: 1,
            sport: 'football',
            homeTeam: 'Real Madrid',
            awayTeam: 'Barcelona',
            homeScore: 2,
            awayScore: 1,
            period: '2nd-half',
            minute: 78,
            status: 'live',
            lastEvent: 'Goal scored by Jude Bellingham from 22 yards out assisted by Vinicius Jr.',
            stats: {
                possession: [48, 52],
                shots: [12, 15],
                shotsOnTarget: [5, 7],
                corners: [4, 6],
                fouls: [8, 11]
            }
        };

        if (app.locals.broadcastScoreUpdate) {
            app.locals.broadcastScoreUpdate(payload.matchId || 1, payload);
        }
        res.json({ ok: true, serverSentAt: Date.now() });
    });
}

server.listen(PORT, HOST, async () => {
    const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;

    console.log(`Server is running on ${baseUrl}`);
    console.log(`WebSocket Server is running on ${baseUrl.replace('http', 'ws')}/ws`);

    if (process.env.AUTO_SEED === 'true' || process.env.AUTO_SEED === '1') {
        const { spawn } = await import('child_process');
        console.log("Starting background seed worker (AUTO_SEED enabled)...");
        spawn('node', ['src/seed/seed.js'], {
            env: { ...process.env, API_URL: `http://127.0.0.1:${PORT}` },
            stdio: 'inherit'
        });
    } else {
        console.log("Background seed worker disabled by default (opt-in via AUTO_SEED=true or 'npm run seed').");
    }
});
