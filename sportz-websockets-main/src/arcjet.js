import net from 'node:net';
import arcjet, { detectBot, shield, slidingWindow } from "@arcjet/node";

const arcjetKey = process.env.ARCJET_KEY;

export function isArcjetDevEnv(env = process.env) {
    return env.NODE_ENV !== 'production' || env.ARCJET_ENV === 'development';
}

export function resolveArcjetMode(env = process.env) {
    if (env.ARCJET_MODE === 'LIVE') return 'LIVE';
    if (env.ARCJET_MODE === 'DRY_RUN') return 'DRY_RUN';
    return isArcjetDevEnv(env) ? 'DRY_RUN' : 'LIVE';
}

export function isTrustProxyEnabled(env = process.env) {
    return env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1';
}

export function isDebugIpEnabled(env = process.env) {
    return env.DEBUG_IP === '1' || env.DEBUG_IP === 'true';
}

export function isBenchmarkBypassRequested(env = process.env) {
    return env.BENCHMARK_BYPASS_ARCJET === 'true' || env.BENCHMARK_BYPASS_ARCJET === '1';
}

export function isBenchmarkBypassEnabled(env = process.env, logger = console) {
    if (!isBenchmarkBypassRequested(env)) {
        return false;
    }
    if (env.NODE_ENV === 'production') {
        logger.error(
            '🚨 [Arcjet] BENCHMARK_BYPASS_ARCJET is refused when NODE_ENV=production; ignoring bypass flag.'
        );
        return false;
    }
    return true;
}

const isDev = isArcjetDevEnv();
export const arcjetMode = resolveArcjetMode();

let arcjetErrorCount = 0;
let lastArcjetErrorAt = null;

export function recordArcjetError(at = new Date().toISOString()) {
    arcjetErrorCount += 1;
    lastArcjetErrorAt = at;
}

export function getArcjetErrorStats() {
    return {
        count: arcjetErrorCount,
        lastErrorAt: lastArcjetErrorAt,
    };
}

export function resetArcjetErrorStats() {
    arcjetErrorCount = 0;
    lastArcjetErrorAt = null;
}

if (isBenchmarkBypassRequested(process.env) && process.env.NODE_ENV === 'production') {
    console.error(
        '🚨 [Arcjet] BENCHMARK_BYPASS_ARCJET is set while NODE_ENV=production; refusing and ignoring bypass flag.'
    );
}

if (!arcjetKey) {
    console.warn("⚠️ [Arcjet] ARCJET_KEY is missing. Security middleware will run in bypass mode.");
} else {
    console.info(
        `🛡️ [Arcjet] Configured (mode=${arcjetMode}, trustProxy=${isTrustProxyEnabled()}, nodeEnv=${process.env.NODE_ENV || 'unset'}, arcjetEnv=${process.env.ARCJET_ENV || 'unset'}, keyConfigured=true)`
    );
    if (process.env.NODE_ENV === 'production' && arcjetMode !== 'LIVE') {
        console.warn(
            `⚠️ [Arcjet] Running in ${arcjetMode} mode while NODE_ENV=production (ARCJET_ENV=${process.env.ARCJET_ENV || 'unset'}, ARCJET_MODE=${process.env.ARCJET_MODE || 'unset'}). Requests will NOT be blocked!`
        );
    }
}

export function normalizeIp(ip) {
    if (typeof ip !== 'string') return null;
    const trimmed = ip.trim();
    if (!trimmed) return null;
    const v4Mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (v4Mapped && net.isIP(v4Mapped[1]) === 4) {
        return v4Mapped[1];
    }
    return trimmed;
}

export function getClientIp(req, trustProxy = isTrustProxyEnabled()) {
    if (trustProxy && req?.headers) {
        const rawXff = req.headers['x-forwarded-for'];
        const xForwardedFor = Array.isArray(rawXff) ? rawXff.join(',') : rawXff;
        if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
            const parts = xForwardedFor.split(',').map(s => s.trim()).filter(Boolean);
            if (parts.length > 0) {
                // For 1 trusted reverse proxy hop (e.g. Render, AWS ALB, Cloudflare),
                // the trusted proxy appends the real client IP to the rightmost position.
                // Leftmost entries can be forged by the client.
                const rightmost = normalizeIp(parts[parts.length - 1]);
                if (rightmost && net.isIP(rightmost) !== 0) {
                    return rightmost;
                }
            }
        }
    }
    return normalizeIp(req?.socket?.remoteAddress || req?.ip || null);
}

export function isLocalhostIp(ip, env = process.env, logger = console) {
    if (isBenchmarkBypassEnabled(env, logger)) {
        return true;
    }
    const normalized = normalizeIp(ip);
    return (
        !normalized ||
        normalized === '127.0.0.1' ||
        normalized === '::1' ||
        normalized === 'localhost'
    );
}

export function sanitizeLogValue(value) {
    if (typeof value !== 'string') return value;
    return value
        .replace(/aj_prj_key_[A-Za-z0-9_-]+/g, '[REDACTED_ARCJET_KEY]')
        .replace(/ajkey_[A-Za-z0-9_-]+/g, '[REDACTED_ARCJET_KEY]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
}

function extractSafePath(req) {
    const raw = req?.originalUrl || req?.url || req?.path || '';
    if (typeof raw !== 'string' || !raw) return '/';
    const qIndex = raw.indexOf('?');
    return qIndex >= 0 ? raw.slice(0, qIndex) : raw;
}

function extractHeaderValue(headers, name) {
    if (!headers || typeof headers !== 'object') return undefined;
    const raw = headers[name];
    if (Array.isArray(raw)) {
        const joined = raw.join(', ').trim();
        return joined ? sanitizeLogValue(joined) : undefined;
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
        return sanitizeLogValue(raw.trim());
    }
    return undefined;
}

const debugIpLoggedRequests = new WeakSet();

export function logDebugIpIfEnabled({
    scope,
    req,
    clientIp,
    trustProxy = isTrustProxyEnabled(),
    debugIp = isDebugIpEnabled(),
    logger = console,
}) {
    if (!debugIp) return;
    if (req && typeof req === 'object') {
        if (debugIpLoggedRequests.has(req)) return;
        debugIpLoggedRequests.add(req);
    }

    const xForwardedFor = extractHeaderValue(req?.headers, 'x-forwarded-for');
    const trueClientIp = extractHeaderValue(req?.headers, 'true-client-ip');
    const xRealIp = extractHeaderValue(req?.headers, 'x-real-ip');

    const entry = {
        scope,
        method: req?.method || null,
        path: extractSafePath(req),
        trustProxy: Boolean(trustProxy),
        xForwardedFor: xForwardedFor ?? null,
        ...(trueClientIp !== undefined ? { trueClientIp } : {}),
        ...(xRealIp !== undefined ? { xRealIp } : {}),
        remoteAddress: req?.socket?.remoteAddress || null,
        resolvedClientIp: clientIp || null,
    };

    logger.info(`🔍 [DEBUG_IP:${scope}]`, JSON.stringify(entry));
}

export function debugIpMiddleware({
    trustProxy,
    debugIp,
    logger = console,
} = {}) {
    return (req, _res, next) => {
        const enabled = debugIp !== undefined ? debugIp : isDebugIpEnabled();
        if (enabled) {
            const effectiveTrustProxy = trustProxy !== undefined ? trustProxy : isTrustProxyEnabled();
            const clientIp = getClientIp(req, effectiveTrustProxy);
            logDebugIpIfEnabled({
                scope: 'http',
                req,
                clientIp,
                trustProxy: effectiveTrustProxy,
                debugIp: true,
                logger,
            });
        }
        next();
    };
}

function summarizeReason(reason) {
    if (!reason || typeof reason !== 'object') return null;
    const summary = {};
    if (typeof reason.type === 'string') summary.type = reason.type;
    if (typeof reason.message === 'string') summary.message = sanitizeLogValue(reason.message);
    if (reason.isRateLimit?.() || reason.type === 'RATE_LIMIT') {
        summary.max = reason.max;
        summary.remaining = reason.remaining;
        summary.reset = reason.reset;
        summary.window = reason.window;
    }
    if (reason.isBot?.() || reason.type === 'BOT') {
        summary.denied = reason.denied;
        summary.verified = reason.verified;
        summary.spoofed = reason.spoofed;
    }
    if (reason.isShield?.() || reason.type === 'SHIELD') {
        summary.shieldTriggered = reason.shieldTriggered;
    }
    return summary;
}

export function buildProtectOptions(clientIp, logger = console) {
    const normalized = normalizeIp(clientIp);
    if (normalized && net.isIP(normalized) !== 0) {
        return { ipSrc: normalized };
    }
    if (clientIp) {
        logger.warn(
            `⚠️ [Arcjet] Resolved clientIp is not a valid IP address; falling back to SDK IP resolution.`
        );
    }
    return {};
}

export function logArcjetDecisionIfNeeded({
    scope,
    req,
    clientIp,
    decision,
    mode = arcjetMode,
    logger = console,
}) {
    if (!decision) return;

    const isErrored = Boolean(decision.isErrored?.() || decision.conclusion === 'ERROR');
    const isDenied = Boolean(decision.isDenied?.() || decision.conclusion === 'DENY');
    const conclusion = decision.conclusion || (isErrored ? 'ERROR' : isDenied ? 'DENY' : 'ALLOW');
    const isNonAllowed = isErrored || isDenied || conclusion !== 'ALLOW';

    const results = Array.isArray(decision.results) ? decision.results : [];
    const erroredRules = results
        .filter(r => r?.isErrored?.() || r?.conclusion === 'ERROR')
        .map(r => ({
            state: r.state,
            conclusion: r.conclusion,
            reason: summarizeReason(r.reason),
        }));
    const dryRunDenies = results
        .filter(r => r?.state === 'DRY_RUN' && (r?.isDenied?.() || r?.conclusion === 'DENY'))
        .map(r => ({
            state: r.state,
            conclusion: r.conclusion,
            reason: summarizeReason(r.reason),
        }));

    if (!isNonAllowed && erroredRules.length === 0 && dryRunDenies.length === 0) {
        return;
    }

    if (isErrored || erroredRules.length > 0) {
        recordArcjetError();
    }

    const entry = {
        scope,
        mode,
        id: decision.id || null,
        conclusion,
        method: req?.method || null,
        path: extractSafePath(req),
        clientIp: clientIp || null,
        reason: summarizeReason(decision.reason),
        ...(erroredRules.length > 0 ? { erroredRules } : {}),
        ...(dryRunDenies.length > 0 ? { dryRunDenies } : {}),
    };

    if (isDenied) {
        logger.warn(`🛑 [Arcjet:${scope}] DENIED request:`, JSON.stringify(entry));
        if (erroredRules.length > 0) {
            logger.error(`🚨 [Arcjet:${scope}] Rule error(s) occurred alongside DENY decision:`, JSON.stringify(entry));
        }
    } else if (isErrored) {
        logger.error(`🚨 [Arcjet:${scope}] ERROR decision (failing open):`, JSON.stringify(entry));
    } else if (erroredRules.length > 0) {
        logger.error(`🚨 [Arcjet:${scope}] Rule error(s) in decision (failing open):`, JSON.stringify(entry));
    } else if (conclusion !== 'ALLOW') {
        logger.warn(`⚠️ [Arcjet:${scope}] Non-ALLOW decision (${conclusion}):`, JSON.stringify(entry));
    } else if (dryRunDenies.length > 0) {
        logger.warn(`⚠️ [Arcjet:${scope}] DRY_RUN rule would have denied request:`, JSON.stringify(entry));
    }
}

export function logArcjetError({ scope, req, clientIp, error, mode = arcjetMode, logger = console }) {
    recordArcjetError();
    const entry = {
        scope,
        mode,
        method: req?.method || null,
        path: extractSafePath(req),
        clientIp: clientIp || null,
        errorName: error?.name || 'Error',
        errorCode: error?.code || null,
        errorMessage: sanitizeLogValue(error?.message || String(error)),
    };
    logger.error(`🚨 [Arcjet:${scope}] Unexpected protection error:`, JSON.stringify(entry));
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

export function securityMiddleware({
    client = httpArcjet,
    trustProxy,
    debugIp,
    mode = arcjetMode,
    devMode = isDev,
    env = process.env,
    logger = console,
} = {}) {
    return async (req, res, next) => {
        const effectiveTrustProxy = trustProxy !== undefined ? trustProxy : isTrustProxyEnabled(env);
        const clientIp = getClientIp(req, effectiveTrustProxy);

        logDebugIpIfEnabled({
            scope: 'http',
            req,
            clientIp,
            trustProxy: effectiveTrustProxy,
            debugIp: debugIp !== undefined ? debugIp : isDebugIpEnabled(env),
            logger,
        });

        if (!client) return next();

        // Bypass Arcjet rate limiting for local development and seed workers
        if (isLocalhostIp(clientIp, env, logger)) {
            return next();
        }

        try {
            const protectOptions = buildProtectOptions(clientIp, logger);
            const decision = await client.protect(req, protectOptions);

            logArcjetDecisionIfNeeded({
                scope: 'http',
                req,
                clientIp,
                decision,
                mode,
                logger,
            });

            if (decision.isDenied?.()) {
                if (decision.reason?.isRateLimit?.()) {
                    return res.status(429).json({ error: 'Too many requests.' });
                }

                return res.status(403).json({ error: 'Forbidden.' });
            }
        } catch (e) {
            logArcjetError({
                scope: 'http',
                req,
                clientIp,
                error: e,
                mode,
                logger,
            });
            // In development, fail open rather than 503 so local work isn't blocked
            if (devMode) {
                return next();
            }
            return res.status(503).json({ error: 'Service Unavailable' });
        }

        next();
    };
}


