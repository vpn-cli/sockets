import Redis from 'ioredis';

let pubClient = null;
let subClient = null;
let isInitialized = false;
let redisAvailable = false;

// Channel helper names
export function getMatchChannel(matchId) {
    return `sportz:match:${matchId}`;
}

export const GLOBAL_CHANNEL = 'sportz:global';

export function getMatchReactionsKey(matchId) {
    return `sportz:match:${matchId}:reactions`;
}

/**
 * Initializes Redis connection for Pub/Sub and Reaction storage.
 * If redisUrl is not supplied or fails, degrades gracefully to in-memory.
 */
export async function initRedis({ redisUrl = process.env.REDIS_URL, retryCount = 10 } = {}) {
    if (!redisUrl) {
        isInitialized = true;
        redisAvailable = false;
        pubClient = null;
        subClient = null;
        console.log('ℹ️ [Redis] REDIS_URL not configured. Running in single-instance local-broadcast mode.');
        return { enabled: false };
    }

    try {
        pubClient = new Redis(redisUrl, {
            maxRetriesPerRequest: 1,
            retryStrategy: (times) => {
                if (retryCount !== null && times > retryCount) {
                    console.error(`🚨 [REDIS FAILURE] Reconnect failed after ${retryCount} attempts. Stopping reconnects.`);
                    return null;
                }
                const delay = Math.min(times * 100, 3000);
                console.warn(`⏳ [Redis] Reconnecting attempt #${times} in ${delay}ms...`);
                return delay;
            },
            lazyConnect: true,
        });

        subClient = pubClient.duplicate();

        pubClient.on('connect', () => {
            console.log('🔌 [Redis Pub] Socket connected');
        });

        pubClient.on('ready', () => {
            redisAvailable = true;
            console.log('✅ [Redis Pub] Ready');
        });

        pubClient.on('close', () => {
            if (redisAvailable) {
                redisAvailable = false;
                console.error('🚨 [REDIS FAILURE] Redis pub client disconnected! Degrading to local-only broadcast.');
            }
        });

        pubClient.on('error', (err) => {
            console.warn('⚠️ [Redis Pub Error]:', err.message);
        });

        subClient.on('connect', () => {
            console.log('🔌 [Redis Sub] Socket connected');
        });

        subClient.on('ready', () => {
            console.log('✅ [Redis Sub] Ready');
        });

        subClient.on('close', () => {
            console.error('🚨 [REDIS FAILURE] Redis sub client disconnected!');
        });

        subClient.on('error', (err) => {
            console.warn('⚠️ [Redis Sub Error]:', err.message);
        });

        await Promise.all([pubClient.connect(), subClient.connect()]);

        isInitialized = true;
        redisAvailable = true;
        console.log(`✅ [Redis] Connected to Redis Pub/Sub: ${redisUrl}`);
        return { enabled: true, pubClient, subClient };
    } catch (err) {
        console.warn(`⚠️ [Redis] Connection failed (${err.message}). Falling back to local in-memory pub/sub.`);
        if (pubClient) { try { pubClient.disconnect(); } catch {} pubClient = null; }
        if (subClient) { try { subClient.disconnect(); } catch {} subClient = null; }
        redisAvailable = false;
        return { enabled: false, error: err.message };
    }
}

export function isRedisActive(client = pubClient) {
    const target = client || pubClient;
    return Boolean(target && target.status === 'ready');
}

export function getPublisher() {
    return pubClient;
}

export function getSubscriber() {
    return subClient;
}

const DEFAULT_EMOJI_COUNTS = { '🔥': 0, '👏': 0, '⚡': 0, '❤️': 0, '⚽': 0, '🎯': 0 };

function withTimeout(promise, ms, operationName = 'Redis operation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operationName} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Publish payload to a Redis channel with fallback detection
 */
export async function publishEvent(channel, payload, client = pubClient, timeoutMs = 500) {
    const redis = client || pubClient;
    if (!redis || redis.status !== 'ready') {
        return { success: false, reason: 'Redis not ready' };
    }
    try {
        const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const count = await withTimeout(redis.publish(channel, message), timeoutMs, `Publish to ${channel}`);
        return { success: true, count };
    } catch (err) {
        console.error(`🚨 [REDIS FAILURE] Publish to ${channel} failed:`, err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Atomic increment of an emoji reaction in Redis Hash
 */
export async function recordReactionInRedis(matchId, emoji, client = pubClient, timeoutMs = 500) {
    const redis = client || pubClient;
    if (!redis || redis.status !== 'ready') return null;
    const key = getMatchReactionsKey(matchId);
    try {
        await withTimeout(redis.hincrby(key, emoji, 1), timeoutMs, `Reaction hincrby for match ${matchId}`);
        const rawCounts = await withTimeout(redis.hgetall(key), timeoutMs, `Reaction hgetall for match ${matchId}`);
        const counts = { ...DEFAULT_EMOJI_COUNTS };
        for (const [k, v] of Object.entries(rawCounts || {})) {
            counts[k] = parseInt(v, 10) || 0;
        }
        return counts;
    } catch (err) {
        console.error(`🚨 [REDIS FAILURE] Reaction increment failed for match ${matchId}:`, err.message);
        return null;
    }
}

/**
 * Fetch emoji reaction counts snapshot from Redis Hash
 */
export async function fetchReactionCountsFromRedis(matchId, client = pubClient, timeoutMs = 500) {
    const redis = client || pubClient;
    if (!redis || redis.status !== 'ready') return null;
    const key = getMatchReactionsKey(matchId);
    try {
        const rawCounts = await withTimeout(redis.hgetall(key), timeoutMs, `Fetch reactions for match ${matchId}`);
        if (!rawCounts || Object.keys(rawCounts).length === 0) {
            return { ...DEFAULT_EMOJI_COUNTS };
        }
        const counts = { ...DEFAULT_EMOJI_COUNTS };
        for (const [k, v] of Object.entries(rawCounts)) {
            counts[k] = parseInt(v, 10) || 0;
        }
        return counts;
    } catch (err) {
        console.error(`🚨 [REDIS FAILURE] Fetch reactions failed for match ${matchId}:`, err.message);
        return null;
    }
}

export async function closeRedis() {
    if (pubClient) {
        try { pubClient.disconnect(); } catch {}
        pubClient = null;
    }
    if (subClient) {
        try { subClient.disconnect(); } catch {}
        subClient = null;
    }
    isInitialized = false;
    redisAvailable = false;
}
