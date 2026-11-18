import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import arcjet, { slidingWindow } from '@arcjet/node';
import {
    getClientIp,
    normalizeIp,
    isLocalhostIp,
    resolveArcjetMode,
    buildProtectOptions,
    sanitizeLogValue,
    securityMiddleware,
} from '../src/arcjet.js';
import { attachWebSocketServer } from '../src/ws/server.js';

function createMockLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

function createMockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
    return res;
}

describe('Arcjet configuration, IP resolution, and decision logging', () => {
    describe('resolveArcjetMode', () => {
        it('uses LIVE in production when ARCJET_ENV and ARCJET_MODE are unset', () => {
            expect(resolveArcjetMode({ NODE_ENV: 'production' })).toBe('LIVE');
        });

        it('uses DRY_RUN in non-production by default', () => {
            expect(resolveArcjetMode({ NODE_ENV: 'development' })).toBe('DRY_RUN');
            expect(resolveArcjetMode({})).toBe('DRY_RUN');
        });

        it('uses DRY_RUN when ARCJET_ENV=development even if NODE_ENV=production', () => {
            expect(resolveArcjetMode({ NODE_ENV: 'production', ARCJET_ENV: 'development' })).toBe('DRY_RUN');
        });

        it('honors explicit ARCJET_MODE=LIVE and ARCJET_MODE=DRY_RUN overrides', () => {
            expect(resolveArcjetMode({ NODE_ENV: 'development', ARCJET_MODE: 'LIVE' })).toBe('LIVE');
            expect(resolveArcjetMode({ NODE_ENV: 'production', ARCJET_MODE: 'DRY_RUN' })).toBe('DRY_RUN');
        });
    });

    describe('getClientIp, normalizeIp, and buildProtectOptions', () => {
        it('extracts rightmost trusted X-Forwarded-For hop when trustProxy=true and ignores forged leftmost entries', () => {
            const req = {
                headers: { 'x-forwarded-for': '127.0.0.1, 1.2.3.4, 198.51.100.42' },
                socket: { remoteAddress: '10.0.0.2' },
            };
            expect(getClientIp(req, true)).toBe('198.51.100.42');
        });

        it('ignores X-Forwarded-For when trustProxy=false', () => {
            const req = {
                headers: { 'x-forwarded-for': '198.51.100.42' },
                socket: { remoteAddress: '203.0.113.9' },
            };
            expect(getClientIp(req, false)).toBe('203.0.113.9');
        });

        it('normalizes IPv4-mapped IPv6 addresses to plain IPv4', () => {
            expect(normalizeIp('::ffff:203.0.113.55')).toBe('203.0.113.55');
            expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
            expect(isLocalhostIp('::ffff:127.0.0.1')).toBe(true);
            expect(isLocalhostIp('::ffff:203.0.113.55')).toBe(false);
        });

        it('falls back to socket.remoteAddress if rightmost XFF entry is malformed', () => {
            const req = {
                headers: { 'x-forwarded-for': 'not-an-ip' },
                socket: { remoteAddress: '203.0.113.77' },
            };
            expect(getClientIp(req, true)).toBe('203.0.113.77');
        });

        it('passes ipSrc (not ip) in protect options and resolves identically in @arcjet/node even with RENDER=true', () => {
            const prevRender = process.env.RENDER;
            const prevNodeEnv = process.env.NODE_ENV;
            const prevArcjetEnv = process.env.ARCJET_ENV;
            try {
                process.env.RENDER = 'true';
                process.env.NODE_ENV = 'production';
                delete process.env.ARCJET_ENV;

                const req = {
                    method: 'GET',
                    url: '/matches',
                    headers: {
                        host: 'sportz.onrender.com',
                        'x-forwarded-for': '127.0.0.1, 198.51.100.88',
                    },
                    socket: { remoteAddress: '10.0.0.2' },
                };
                const clientIp = getClientIp(req, true);
                const opts = buildProtectOptions(clientIp);
                expect(opts).toEqual({ ipSrc: '198.51.100.88' });
                expect('ip' in opts).toBe(false);

                const aj = arcjet({
                    key: 'aj_prj_key_test_only_000000000000',
                    rules: [slidingWindow({ mode: 'LIVE', interval: '10s', max: 60 })],
                });
                const details = aj.clientIpDetails(req, opts);
                expect(details).toEqual({
                    ip: '198.51.100.88',
                    provenance: 'manual',
                    verified: true,
                });
            } finally {
                if (prevRender === undefined) delete process.env.RENDER; else process.env.RENDER = prevRender;
                if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
                if (prevArcjetEnv === undefined) delete process.env.ARCJET_ENV; else process.env.ARCJET_ENV = prevArcjetEnv;
            }
        });
    });

    describe('sanitizeLogValue', () => {
        it('redacts aj_prj_key_, ajkey_, and Bearer tokens', () => {
            const raw = 'Auth failed for aj_prj_key_01m7secret123 and ajkey_oldsecret456 Bearer tok_xyz';
            const cleaned = sanitizeLogValue(raw);
            expect(cleaned).not.toContain('01m7secret123');
            expect(cleaned).not.toContain('oldsecret456');
            expect(cleaned).not.toContain('tok_xyz');
            expect(cleaned).toContain('[REDACTED_ARCJET_KEY]');
            expect(cleaned).toContain('Bearer [REDACTED]');
        });
    });

    describe('securityMiddleware', () => {
        it('passes ipSrc matching TRUST_PROXY rightmost hop and allows ALLOW decisions quietly', async () => {
            const logger = createMockLogger();
            const protect = vi.fn().mockResolvedValue({
                id: 'req_allow_1',
                conclusion: 'ALLOW',
                isAllowed: () => true,
                isDenied: () => false,
                isErrored: () => false,
                reason: { type: 'RATE_LIMIT', max: 60, remaining: 59, reset: 10, window: 10 },
                results: [],
            });
            const mw = securityMiddleware({
                client: { protect },
                trustProxy: true,
                mode: 'LIVE',
                devMode: false,
                logger,
            });

            const req = {
                method: 'GET',
                originalUrl: '/matches?token=supersecret',
                headers: { 'x-forwarded-for': '127.0.0.1, 198.51.100.10' },
                socket: { remoteAddress: '10.0.0.2' },
            };
            const res = createMockRes();
            const next = vi.fn();

            await mw(req, res, next);

            expect(protect).toHaveBeenCalledWith(req, { ipSrc: '198.51.100.10' });
            expect(next).toHaveBeenCalledTimes(1);
            expect(logger.warn).not.toHaveBeenCalled();
            expect(logger.error).not.toHaveBeenCalled();
        });

        it('returns 429 and logs loudly on rate-limit DENY without leaking query strings or keys', async () => {
            const logger = createMockLogger();
            const protect = vi.fn().mockResolvedValue({
                id: 'req_rl_1',
                conclusion: 'DENY',
                isAllowed: () => false,
                isDenied: () => true,
                isErrored: () => false,
                reason: {
                    type: 'RATE_LIMIT',
                    isRateLimit: () => true,
                    max: 60,
                    remaining: 0,
                    reset: 7,
                    window: 10,
                },
                results: [],
            });
            const mw = securityMiddleware({
                client: { protect },
                trustProxy: true,
                mode: 'LIVE',
                devMode: false,
                logger,
            });

            const req = {
                method: 'GET',
                originalUrl: '/matches?apiKey=secret123',
                headers: {
                    'x-forwarded-for': '198.51.100.20',
                    authorization: 'Bearer aj_prj_key_secret_should_never_log',
                },
                socket: { remoteAddress: '10.0.0.2' },
            };
            const res = createMockRes();
            const next = vi.fn();

            await mw(req, res, next);

            expect(res.statusCode).toBe(429);
            expect(res.body).toEqual({ error: 'Too many requests.' });
            expect(next).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledTimes(1);
            const logged = logger.warn.mock.calls[0].join(' ');
            expect(logged).toContain('DENIED');
            expect(logged).toContain('198.51.100.20');
            expect(logged).toContain('/matches');
            expect(logged).not.toContain('secret123');
            expect(logged).not.toContain('aj_prj_key_secret_should_never_log');
        });

        it('returns 403 and logs loudly on non-rate-limit DENY (e.g. bot detection)', async () => {
            const logger = createMockLogger();
            const protect = vi.fn().mockResolvedValue({
                id: 'req_bot_1',
                conclusion: 'DENY',
                isAllowed: () => false,
                isDenied: () => true,
                isErrored: () => false,
                reason: {
                    type: 'BOT',
                    isRateLimit: () => false,
                    isBot: () => true,
                    denied: ['CURL'],
                    verified: false,
                    spoofed: false,
                },
                results: [],
            });
            const mw = securityMiddleware({
                client: { protect },
                trustProxy: false,
                mode: 'LIVE',
                devMode: false,
                logger,
            });

            const req = {
                method: 'GET',
                originalUrl: '/matches',
                headers: {},
                socket: { remoteAddress: '203.0.113.44' },
            };
            const res = createMockRes();
            const next = vi.fn();

            await mw(req, res, next);

            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({ error: 'Forbidden.' });
            expect(next).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledTimes(1);
        });

        it('logs ERROR decisions loudly (even when isAllowed() is true) and fails open', async () => {
            const logger = createMockLogger();
            const protect = vi.fn().mockResolvedValue({
                id: 'lreq_err_1',
                conclusion: 'ERROR',
                isAllowed: () => true,
                isDenied: () => false,
                isErrored: () => true,
                reason: {
                    type: 'ERROR',
                    message: 'Unauthenticated key aj_prj_key_secret999',
                },
                results: [],
            });
            const mw = securityMiddleware({
                client: { protect },
                trustProxy: true,
                mode: 'LIVE',
                devMode: false,
                logger,
            });

            const req = {
                method: 'GET',
                originalUrl: '/matches',
                headers: { 'x-forwarded-for': '198.51.100.30' },
                socket: { remoteAddress: '10.0.0.2' },
            };
            const res = createMockRes();
            const next = vi.fn();

            await mw(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(logger.error).toHaveBeenCalledTimes(1);
            const logged = logger.error.mock.calls[0].join(' ');
            expect(logged).toContain('ERROR decision');
            expect(logged).toContain('[REDACTED_ARCJET_KEY]');
            expect(logged).not.toContain('aj_prj_key_secret999');
        });

        it('logs DRY_RUN rule denies loudly so misconfigured DRY_RUN in prod is visible', async () => {
            const logger = createMockLogger();
            const protect = vi.fn().mockResolvedValue({
                id: 'req_dry_1',
                conclusion: 'ALLOW',
                isAllowed: () => true,
                isDenied: () => false,
                isErrored: () => false,
                reason: { type: 'RATE_LIMIT', max: 60, remaining: 0, reset: 5, window: 10 },
                results: [
                    {
                        state: 'DRY_RUN',
                        conclusion: 'DENY',
                        isDenied: () => true,
                        isErrored: () => false,
                        reason: { type: 'RATE_LIMIT', isRateLimit: () => true, max: 60, remaining: 0, reset: 5, window: 10 },
                    },
                ],
            });
            const mw = securityMiddleware({
                client: { protect },
                trustProxy: true,
                mode: 'DRY_RUN',
                devMode: false,
                logger,
            });

            const req = {
                method: 'GET',
                originalUrl: '/matches',
                headers: { 'x-forwarded-for': '198.51.100.31' },
                socket: { remoteAddress: '10.0.0.2' },
            };
            const res = createMockRes();
            const next = vi.fn();

            await mw(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0].join(' ')).toContain('DRY_RUN');
        });

        it('logs thrown exceptions loudly with secret redaction and returns 503 in prod', async () => {
            const logger = createMockLogger();
            const protect = vi.fn().mockRejectedValue(new Error('Invalid token Bearer secret_tok_123'));
            const mw = securityMiddleware({
                client: { protect },
                trustProxy: true,
                mode: 'LIVE',
                devMode: false,
                logger,
            });

            const req = {
                method: 'GET',
                originalUrl: '/matches',
                headers: { 'x-forwarded-for': '198.51.100.32' },
                socket: { remoteAddress: '10.0.0.2' },
            };
            const res = createMockRes();
            const next = vi.fn();

            await mw(req, res, next);

            expect(res.statusCode).toBe(503);
            expect(next).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledTimes(1);
            const logged = logger.error.mock.calls[0].join(' ');
            expect(logged).toContain('Bearer [REDACTED]');
            expect(logged).not.toContain('secret_tok_123');
        });
    });

    describe('WebSocket upgrade protection', () => {
        let server;
        let handles;
        const sockets = new Set();

        afterEach(async () => {
            for (const ws of sockets) {
                try { ws.terminate(); } catch {}
            }
            sockets.clear();
            if (handles?.wss) handles.wss.close();
            if (server) {
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                await new Promise((r) => server.close(r));
            }
        });

        it('passes ipSrc from rightmost XFF hop, rejects 429 on rate-limit DENY, and logs loudly', async () => {
            const logger = createMockLogger();
            let count = 0;
            const protect = vi.fn(async () => {
                count++;
                if (count > 1) {
                    return {
                        id: `req_ws_deny_${count}`,
                        conclusion: 'DENY',
                        isAllowed: () => false,
                        isDenied: () => true,
                        isErrored: () => false,
                        reason: {
                            type: 'RATE_LIMIT',
                            isRateLimit: () => true,
                            max: 1,
                            remaining: 0,
                            reset: 10,
                            window: 10,
                        },
                        results: [],
                    };
                }
                return {
                    id: 'req_ws_allow_1',
                    conclusion: 'ALLOW',
                    isAllowed: () => true,
                    isDenied: () => false,
                    isErrored: () => false,
                    reason: { type: 'RATE_LIMIT', max: 1, remaining: 0, reset: 10, window: 10 },
                    results: [],
                };
            });

            server = http.createServer();
            handles = attachWebSocketServer(server, {
                enableRedis: false,
                wsArcjetClient: { protect },
                trustProxy: true,
                arcjetLogger: logger,
            });
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            const port = server.address().port;

            // First connection allowed
            const ws1 = await new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
                    headers: { 'x-forwarded-for': '127.0.0.1, 198.51.100.70' },
                });
                sockets.add(ws);
                ws.on('open', () => resolve(ws));
                ws.on('error', reject);
            });
            expect(ws1.readyState).toBe(WebSocket.OPEN);
            expect(protect).toHaveBeenCalledWith(expect.anything(), { ipSrc: '198.51.100.70' });

            // Second connection denied with 429
            const statusCode = await new Promise((resolve) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
                    headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.70' },
                });
                sockets.add(ws);
                ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
                ws.on('open', () => resolve(101));
                ws.on('error', () => {});
            });

            expect(statusCode).toBe(429);
            expect(protect).toHaveBeenNthCalledWith(2, expect.anything(), { ipSrc: '198.51.100.70' });
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0].join(' ')).toContain('Arcjet:ws');
        });

        it('logs ERROR decisions loudly on WS upgrade and fails open', async () => {
            const logger = createMockLogger();
            const protect = vi.fn().mockResolvedValue({
                id: 'lreq_ws_err_1',
                conclusion: 'ERROR',
                isAllowed: () => true,
                isDenied: () => false,
                isErrored: () => true,
                reason: { type: 'ERROR', message: 'Upstream timeout' },
                results: [],
            });

            server = http.createServer();
            handles = attachWebSocketServer(server, {
                enableRedis: false,
                wsArcjetClient: { protect },
                trustProxy: true,
                arcjetLogger: logger,
            });
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            const port = server.address().port;

            const ws = await new Promise((resolve, reject) => {
                const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
                    headers: { 'x-forwarded-for': '198.51.100.71' },
                });
                sockets.add(client);
                client.on('open', () => resolve(client));
                client.on('error', reject);
            });

            expect(ws.readyState).toBe(WebSocket.OPEN);
            expect(logger.error).toHaveBeenCalledTimes(1);
            expect(logger.error.mock.calls[0].join(' ')).toContain('ERROR decision');
        });
    });
});
