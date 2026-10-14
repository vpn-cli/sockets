import arcjet, { detectBot, shield, slidingWindow } from "@arcjet/node";

const arcjetKey = process.env.ARCJET_KEY;
const isDev = process.env.NODE_ENV !== 'production' || process.env.ARCJET_ENV === 'development';
const arcjetMode = (process.env.ARCJET_MODE === 'DRY_RUN' || isDev) ? 'DRY_RUN' : 'LIVE';

if (!arcjetKey) {
    console.warn("⚠️ [Arcjet] ARCJET_KEY is missing. Security middleware will run in bypass mode.");
}

export function isLocalhostIp(ip) {
    return (
        !ip ||
        ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip === 'localhost'
    );
}

export const httpArcjet = arcjetKey ?
    arcjet({
        key: arcjetKey,
        rules: [
            shield({ mode: arcjetMode }),
            detectBot({ mode: arcjetMode, allow: ['CATEGORY:SEARCH_ENGINE', "CATEGORY:PREVIEW"] }),
            slidingWindow({ mode: arcjetMode, interval: '10s', max: 60 })
        ],
    }) : null;

export const wsArcjet = arcjetKey ?
    arcjet({
        key: arcjetKey,
        rules: [
            shield({ mode: arcjetMode }),
            detectBot({ mode: arcjetMode, allow: ['CATEGORY:SEARCH_ENGINE', "CATEGORY:PREVIEW"] }),
            slidingWindow({ mode: arcjetMode, interval: '10s', max: 30 })
        ],
    }) : null;

export function securityMiddleware() {
    return async (req, res, next) => {
        if (!httpArcjet) return next();

        // Bypass Arcjet rate limiting for local development and seed workers
        if (isLocalhostIp(req.ip)) {
            return next();
        }

        try {
            const decision = await httpArcjet.protect(req);

            if (decision.isDenied()) {
                if (decision.reason.isRateLimit()) {
                    return res.status(429).json({ error: 'Too many requests.' });
                }

                return res.status(403).json({ error: 'Forbidden.' });
            }
        } catch (e) {
            console.error('Arcjet middleware error', e);
            // In development, fail open rather than 503 so local work isn't blocked
            if (isDev) {
                return next();
            }
            return res.status(503).json({ error: 'Service Unavailable' });
        }

        next();
    };
}

