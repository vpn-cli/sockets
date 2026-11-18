import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { FeedRecorder } from '../src/ingestor/recorder.js';
import { parseSpeedFactor, runReplay, runReplayFromPostgres } from '../src/ingestor/replay-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_REC_DIR = path.resolve(__dirname, 'fixtures/test-recordings');

describe('FeedRecorder & ReplayRunner', () => {
    beforeEach(async () => {
        await fs.mkdir(TEST_REC_DIR, { recursive: true });
    });

    afterEach(async () => {
        try {
            await fs.rm(TEST_REC_DIR, { recursive: true, force: true });
        } catch {}
    });

    describe('parseSpeedFactor', () => {
        it('parses valid speed strings and numbers', () => {
            expect(parseSpeedFactor('1x')).toBe(1.0);
            expect(parseSpeedFactor('10x')).toBe(10.0);
            expect(parseSpeedFactor('2.5X')).toBe(2.5);
            expect(parseSpeedFactor(5)).toBe(5.0);
            expect(parseSpeedFactor('invalid')).toBe(1.0);
            expect(parseSpeedFactor(0)).toBe(0.1); // clamped minimum
        });
    });

    describe('FeedRecorder', () => {
        it('records raw payloads with timestamps to JSONL and reads them back intact', async () => {
            const recorder = new FeedRecorder(TEST_REC_DIR);
            const filePath = await recorder.init('test-session.jsonl');

            const payload1 = { matches: [{ id: 101, homeTeam: { name: 'Team A' }, awayTeam: { name: 'Team B' } }] };
            const payload2 = { matches: [{ id: 102, homeTeam: { name: 'Team C' }, awayTeam: { name: 'Team D' } }] };

            await recorder.record(payload1);
            await recorder.record(payload2);

            const frames = await FeedRecorder.readRecording(filePath);
            expect(frames).toHaveLength(2);
            expect(frames[0].payload).toEqual(payload1);
            expect(frames[0].timestamp).toBeTypeOf('number');
            expect(frames[1].payload).toEqual(payload2);
        });
    });

    describe('runReplay', () => {
        it('replays recorded frames through the adapter at 10x speed', async () => {
            const recorder = new FeedRecorder(TEST_REC_DIR);
            const filePath = await recorder.init('replay-test.jsonl');

            const fixturePath = path.resolve(__dirname, 'fixtures/football-data-live.json');
            const samplePayload = JSON.parse(await fs.readFile(fixturePath, 'utf8'));

            await recorder.record(samplePayload);

            const ingestedEvents = [];
            const result = await runReplay({
                recordingPath: filePath,
                speed: '10x',
                onEventIngested: (ev) => {
                    ingestedEvents.push(ev);
                },
            });

            expect(result.totalIngested).toBeGreaterThan(0);
            expect(ingestedEvents.length).toBe(result.totalIngested);

            // Verify the events are cleanly formatted and labeled as event-based
            const firstEvent = ingestedEvents[0].commentary;
            expect(firstEvent.provider).toBe('football-data.org');
            expect(firstEvent.message).toContain('[Event-based]');
        });

        it('replays finished matches directly from Postgres commentary table without needing file recordings', async () => {
            // Mock Postgres DB returning a finished match and its stored commentary rows
            const mockRows = [
                {
                    id: 1,
                    matchId: 777,
                    sequence: 1,
                    minute: 10,
                    eventType: 'score_update',
                    message: '[Event-based] GOAL! 1-0',
                    metadata: { score: { homeScore: 1, awayScore: 0 } },
                    createdAt: new Date('2026-11-18T10:00:00Z'),
                },
                {
                    id: 2,
                    matchId: 777,
                    sequence: 2,
                    minute: 45,
                    eventType: 'status_change',
                    message: '[Event-based] Half-time',
                    createdAt: new Date('2026-11-18T10:00:10Z'),
                },
            ];

            const mockDb = {
                select: () => ({
                    from: () => ({
                        where: () => ({
                            orderBy: () => ({
                                limit: async () => [{ id: 777, status: 'finished' }],
                            }),
                            orderBy: () => mockRows,
                        }),
                    }),
                }),
            };

            const broadcastComm = vi.fn();
            const broadcastScore = vi.fn();

            const res = await runReplayFromPostgres({
                db: mockDb,
                matchId: 777,
                speed: '100x',
                broadcastCommentary: broadcastComm,
                broadcastScoreUpdate: broadcastScore,
            });

            expect(res.source).toBe('postgres');
            expect(res.totalIngested).toBe(2);
            expect(broadcastComm).toHaveBeenCalledTimes(2);
            expect(broadcastScore).toHaveBeenCalledTimes(1);
            expect(broadcastScore).toHaveBeenCalledWith(777, { homeScore: 1, awayScore: 0, seq: 1 });
        });
    });
});
