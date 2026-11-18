import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { FeedRecorder } from '../src/ingestor/recorder.js';
import { parseSpeedFactor, runReplay } from '../src/ingestor/replay-runner.js';

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
    });
});
