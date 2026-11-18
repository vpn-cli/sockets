import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    PROVIDER_NAME,
    PROVIDER_ATTRIBUTION,
    PROVIDER_DOCS_URL,
    PROVIDER_DOCUMENTED_RATE_LIMIT,
    MIN_POLL_INTERVAL_SECONDS,
    computeDailyCallBudget,
    fetchLiveMatches,
    mapProviderMatchToEvents,
} from '../src/ingestor/provider-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Provider Adapter & Rate Budget Tests', () => {
    it('documents provider, documented limit of 10 calls/min and attribution', () => {
        expect(PROVIDER_NAME).toBe('football-data.org');
        expect(PROVIDER_ATTRIBUTION).toContain('football-data.org');
        expect(PROVIDER_DOCS_URL).toBe('https://www.football-data.org/documentation/api');
        expect(PROVIDER_DOCUMENTED_RATE_LIMIT).toBe('10 requests/minute');
        expect(MIN_POLL_INTERVAL_SECONDS).toBe(6);
    });

    describe('computeDailyCallBudget', () => {
        it('passes for 60s polling interval (1 call/min <= 10 calls/min)', () => {
            const budget = computeDailyCallBudget({ pollIntervalSeconds: 60 });
            expect(budget.callsPerMinute).toBe(1);
            expect(budget.isWithinQuota).toBe(true);
            expect(budget.documentedLimit).toBe('10 requests/minute');
        });

        it('fails with descriptive error if polling interval violates 10 calls/min (< 6s)', () => {
            expect(() => {
                computeDailyCallBudget({ pollIntervalSeconds: 5 });
            }).toThrow(/violates documented rate limit \(10 requests\/minute\)/);
        });
    });

    describe('fetchLiveMatches', () => {
        it('fetches all live matches in one single request with X-Auth-Token header', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                json: vi.fn().mockResolvedValue({
                    matches: [{ id: 101, status: 'IN_PLAY' }],
                }),
            };
            const mockFetch = vi.fn().mockResolvedValue(mockResponse);

            const res = await fetchLiveMatches({
                apiKey: 'test-api-token-123',
                baseUrl: 'https://api.football-data.org/v4',
                fetchFn: mockFetch,
            });

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-Auth-Token': 'test-api-token-123',
                    }),
                })
            );
            expect(res.rateLimited).toBe(false);
            expect(res.matches.length).toBe(1);
        });

        it('honors Retry-After on HTTP 429 response', async () => {
            const mockResponse = {
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: {
                    get: (name) => (name.toLowerCase() === 'retry-after' ? '45' : null),
                },
            };
            const mockFetch = vi.fn().mockResolvedValue(mockResponse);

            const res = await fetchLiveMatches({
                apiKey: 'test-key',
                fetchFn: mockFetch,
            });

            expect(res.rateLimited).toBe(true);
            expect(res.retryAfterSeconds).toBe(45);
            expect(res.matches).toEqual([]);
        });
    });

    describe('mapProviderMatchToEvents with saved fixture', () => {
        it('derives events strictly from score and status changes with event-based labeling', async () => {
            const fixturePath = path.resolve(__dirname, 'fixtures/football-data-live.json');
            const rawFixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));

            const match1 = rawFixture.matches[0]; // Man City vs Man United (score 2-1, IN_PLAY)
            const events = mapProviderMatchToEvents(match1, 999);

            // Expect 2 derived events: 1 status change event and 1 score update event
            expect(events.length).toBe(2);

            // 1. Status event
            const statusEv = events.find((e) => e.type === 'status_change');
            expect(statusEv).toBeDefined();
            expect(statusEv.matchId).toBe(999);
            expect(statusEv.provider).toBe('football-data.org');
            expect(statusEv.providerEventId).toBe(`football-data.org_m${match1.id}_status_IN_PLAY`);
            expect(statusEv.message).toContain('[Event-based] MATCH STATUS');
            expect(statusEv.message).toContain('IN_PLAY');
            expect(statusEv.score.homeScore).toBe(2);
            expect(statusEv.score.awayScore).toBe(1);

            // 2. Score event
            const scoreEv = events.find((e) => e.type === 'score_update');
            expect(scoreEv).toBeDefined();
            expect(scoreEv.matchId).toBe(999);
            expect(scoreEv.provider).toBe('football-data.org');
            expect(scoreEv.providerEventId).toBe(`football-data.org_m${match1.id}_score_2_1`);
            expect(scoreEv.message).toContain('[Event-based] SCORE UPDATE');
            expect(scoreEv.message).toContain('2 - 1');
            expect(scoreEv.score.homeScore).toBe(2);
            expect(scoreEv.score.awayScore).toBe(1);
        });
    });
});
