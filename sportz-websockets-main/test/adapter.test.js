import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    PROVIDER_NAME,
    PROVIDER_ATTRIBUTION,
    PROVIDER_DOCS_URL,
    PROVIDER_FREE_TIER_DAILY_LIMIT,
    computeDailyCallBudget,
    fetchLiveMatches,
    mapProviderMatchToEvents,
} from '../src/ingestor/provider-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Provider Adapter & Rate Budget Tests', () => {
    it('documents provider, free tier limits and attribution', () => {
        expect(PROVIDER_NAME).toBe('football-data.org');
        expect(PROVIDER_ATTRIBUTION).toContain('football-data.org');
        expect(PROVIDER_DOCS_URL).toBe('https://www.football-data.org/documentation/api');
        expect(PROVIDER_FREE_TIER_DAILY_LIMIT).toBe(14400); // 10 req/min
    });

    describe('computeDailyCallBudget', () => {
        it('computes 1,440 calls/day for 60s polling and passes within free tier quota', () => {
            const budget = computeDailyCallBudget({ pollIntervalSeconds: 60 });
            expect(budget.callsPerDay).toBe(1440);
            expect(budget.isWithinQuota).toBe(true);
            expect(budget.percentOfQuota).toBe(10); // 1440 / 14400 = 10%
        });

        it('fails with descriptive error if polling interval exceeds free tier quota', () => {
            expect(() => {
                // Polling every 5 seconds = 17,280 calls/day > 14,400 quota
                computeDailyCallBudget({ pollIntervalSeconds: 5, providerDailyLimit: 14400 });
            }).toThrow(/Daily API call budget .* exceeds provider free quota/);
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
        it('correctly maps goals and bookings from saved Football-Data.org fixture with event-based labeling', async () => {
            const fixturePath = path.resolve(__dirname, 'fixtures/football-data-live.json');
            const rawFixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));

            const match1 = rawFixture.matches[0]; // Man City vs Man United
            const events = mapProviderMatchToEvents(match1, 999);

            // Fixture has 3 goals + 2 bookings = 5 events
            expect(events.length).toBe(5);

            // 1. Verify Goal 1 (Haaland, 23')
            const goal1 = events.find((e) => e.actor === 'Erling Haaland');
            expect(goal1).toBeDefined();
            expect(goal1.matchId).toBe(999);
            expect(goal1.type).toBe('goal');
            expect(goal1.minute).toBe(23);
            expect(goal1.score.homeScore).toBe(1);
            expect(goal1.score.awayScore).toBe(0);
            expect(goal1.provider).toBe('football-data.org');
            expect(goal1.providerEventId).toContain('goal_23');
            expect(goal1.message).toContain('[Event-based] GOAL!');
            expect(goal1.message).toContain('Erling Haaland');
            expect(goal1.metadata.isEventBased).toBe(true);
            expect(goal1.metadata.assist).toBe('Kevin De Bruyne');

            // 2. Verify Penalty Goal (Bruno Fernandes, 38')
            const penaltyGoal = events.find((e) => e.actor === 'Bruno Fernandes');
            expect(penaltyGoal).toBeDefined();
            expect(penaltyGoal.minute).toBe(38);
            expect(penaltyGoal.score.homeScore).toBe(1);
            expect(penaltyGoal.score.awayScore).toBe(1);
            expect(penaltyGoal.message).toContain('(PENALTY)');

            // 3. Verify Yellow Card (Casemiro, 31')
            const card1 = events.find((e) => e.actor === 'Casemiro');
            expect(card1).toBeDefined();
            expect(card1.type).toBe('card');
            expect(card1.minute).toBe(31);
            expect(card1.message).toContain('[Event-based] YELLOW CARD');
            expect(card1.metadata.isEventBased).toBe(true);

            // 4. Events sorted by minute ascending
            const minutes = events.map((e) => e.minute);
            expect(minutes).toEqual([23, 31, 38, 45, 52]);
        });
    });
});
