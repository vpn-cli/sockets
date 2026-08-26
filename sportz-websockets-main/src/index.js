import AgentAPI from "apminsight";
AgentAPI.config();

import express from 'express';
import http from 'http';
import cors from 'cors';
import {matchRouter} from "./routes/matches.js";
import {attachWebSocketServer} from "./ws/server.js";
import {securityMiddleware} from "./arcjet.js";
import {commentaryRouter} from "./routes/commentary.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

app.use(cors({
    origin: '*', // Allows all origins, including your localhost and Vercel domains
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello from Express server!');
});

app.use(securityMiddleware());

app.use('/matches', matchRouter);
app.use('/matches/:id/commentary', commentaryRouter);

const { broadcastMatchCreated, broadcastCommentary } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentary = broadcastCommentary;

server.listen(PORT, HOST, async () => {
    const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;

    console.log(`Server is running on ${baseUrl}`);
    console.log(`WebSocket Server is running on ${baseUrl.replace('http', 'ws')}/ws`);

    // Automatically spawn the seed script in the background
    const { spawn } = await import('child_process');
    console.log("Starting background seed worker...");
    spawn('node', ['src/seed/seed.js'], {
        env: { ...process.env, API_URL: `http://127.0.0.1:${PORT}` },
        stdio: 'inherit'
    });
});
