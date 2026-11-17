import { createEmbeddedRedisServer } from './embedded-server.js';

const PORT = Number(process.env.REDIS_PORT || 6379);
const HOST = process.env.REDIS_HOST || '127.0.0.1';

const server = createEmbeddedRedisServer(PORT, HOST);
await server.listen();
console.log(`🚀 [Embedded Redis] Listening on ${HOST}:${PORT}`);

process.on('SIGINT', async () => {
    console.log('[Embedded Redis] Shutting down...');
    await server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('[Embedded Redis] Shutting down...');
    await server.close();
    process.exit(0);
});
