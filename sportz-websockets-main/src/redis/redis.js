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
export async function initRedis({ redisUrl = process.env.REDIS_URL, retryCount = 3 } = {}) {
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
                if (times > retryCount) return null;
                return Math.min(times * 100, 1000);
            },
            lazyConnect: true,
        });

        subClient = pubClient.duplicate();

        await Promise.all([pubClient.connect(), subClient.connect()]);

        pubClient.on('error', (err) => {
            console.warn('[Redis] Pub client error:', err.message);
        });

        subClient.on('error', (err) => {
            console.warn('[Redis] Sub client error:', err.message);
        });

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

export function isRedisActive() {
    return redisAvailable && pubClient !== null && subClient !== null;
}

export function getPublisher() {
    return pubClient;
}

export function getSubscriber() {
    return subClient;
}

const DEFAULT_EMOJI_COUNTS = { '🔥': 0, '👏': 0, '⚡': 0, '❤️': 0, '⚽': 0, '🎯': 0 };

/**
 * Publish payload to a Redis channel
 */
export async function publishEvent(channel, payload, client = pubClient) {
    const redis = client || pubClient;
    if (!redis) return 0;
    try {
        const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
        return await redis.publish(channel, message);
    } catch (err) {
        console.error(`[Redis] Publish to ${channel} failed:`, err.message);
        return 0;
    }
}

/**
 * Atomic increment of an emoji reaction in Redis Hash
 */
export async function recordReactionInRedis(matchId, emoji, client = pubClient) {
    const redis = client || pubClient;
    if (!redis) return null;
    const key = getMatchReactionsKey(matchId);
    try {
        await redis.hincrby(key, emoji, 1);
        const rawCounts = await redis.hgetall(key);
        const counts = { ...DEFAULT_EMOJI_COUNTS };
        for (const [k, v] of Object.entries(rawCounts || {})) {
            counts[k] = parseInt(v, 10) || 0;
        }
        return counts;
    } catch (err) {
        console.error(`[Redis] Reaction increment failed for match ${matchId}:`, err.message);
        return null;
    }
}

/**
 * Fetch emoji reaction counts snapshot from Redis Hash
 */
export async function fetchReactionCountsFromRedis(matchId, client = pubClient) {
    const redis = client || pubClient;
    if (!redis) return null;
    const key = getMatchReactionsKey(matchId);
    try {
        const rawCounts = await redis.hgetall(key);
        if (!rawCounts || Object.keys(rawCounts).length === 0) {
            return { ...DEFAULT_EMOJI_COUNTS };
        }
        const counts = { ...DEFAULT_EMOJI_COUNTS };
        for (const [k, v] of Object.entries(rawCounts)) {
            counts[k] = parseInt(v, 10) || 0;
        }
        return counts;
    } catch (err) {
        console.error(`[Redis] Fetch reactions failed for match ${matchId}:`, err.message);
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
