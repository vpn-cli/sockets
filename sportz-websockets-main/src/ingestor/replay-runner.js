import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { FeedRecorder } from './recorder.js';
import { mapProviderMatchToEvents } from './provider-adapter.js';
import { ingestEvent } from './ingest-service.js';
import { resolveMatchForProvider, ingestEventViaApi } from './match-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function parseSpeedFactor(speedStr = '1x') {
    if (typeof speedStr === 'number') return Math.max(0.1, speedStr);
    const cleaned = String(speedStr).toLowerCase().replace('x', '').trim();
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.0;
}

export async function runReplay({
    recordingPath = null,
    speed = process.env.REPLAY_SPEED || '1x',
    db = null,
    apiUrl = process.env.API_URL || null,
    broadcastCommentary = null,
    broadcastScoreUpdate = null,
    onEventIngested = null,
    loop = false,
} = {}) {
    const speedFactor = parseSpeedFactor(speed);
    console.log(`[Replay Runner] Starting replay at ${speedFactor}x speed...`);

    // Determine recording file
    let filePath = recordingPath;
    if (!filePath) {
        // Look for existing recordings or use bundled fixture
        const recDir = path.resolve(__dirname, '../../recordings');
        try {
            const files = await fs.readdir(recDir);
            const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
            if (jsonlFiles.length > 0) {
                filePath = path.join(recDir, jsonlFiles[jsonlFiles.length - 1]);
            }
        } catch {}
    }

    if (!filePath) {
        filePath = path.resolve(__dirname, '../../test/fixtures/football-data-live.json');
        console.log(`[Replay Runner] No recording file specified; using default fixture: ${filePath}`);
    }

    let frames = [];
    if (filePath.endsWith('.jsonl')) {
        frames = await FeedRecorder.readRecording(filePath);
    } else {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
        frames = [{ timestamp: Date.now(), payload: raw }];
    }

    console.log(`[Replay Runner] Loaded ${frames.length} frame(s) from ${filePath}.`);

    let totalIngested = 0;
    let totalDuplicates = 0;

    do {
        let prevTimestamp = null;

        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            if (prevTimestamp !== null) {
                const deltaMs = Math.max(0, frame.timestamp - prevTimestamp);
                const delayMs = Math.max(10, Math.floor(deltaMs / speedFactor));
                await new Promise((r) => setTimeout(r, delayMs));
            }
            prevTimestamp = frame.timestamp;

            const matches = Array.isArray(frame.payload?.matches)
                ? frame.payload.matches
                : Array.isArray(frame.payload)
                    ? frame.payload
                    : [];

            for (const match of matches) {
                const localMatch = await resolveMatchForProvider({
                    providerMatch: match,
                    db,
                    apiUrl,
                });
                const localMatchId = localMatch?.id || match.id;
                const events = mapProviderMatchToEvents(match, localMatchId);

                for (const ev of events) {
                    if (db) {
                        const res = await ingestEvent(ev, {
                            db,
                            broadcastCommentary,
                            broadcastScoreUpdate,
                        });
                        if (res.isDuplicate) {
                            totalDuplicates++;
                        } else {
                            totalIngested++;
                            onEventIngested?.(res);
                        }
                    } else if (apiUrl) {
                        try {
                            const res = await ingestEventViaApi({ apiUrl, eventPayload: ev });
                            if (res.status === 'duplicate_ignored') {
                                totalDuplicates++;
                            } else {
                                totalIngested++;
                                onEventIngested?.(res);
                            }
                        } catch (err) {
                            console.error(`[Replay Runner] Failed to ingest via API:`, err.message);
                        }
                    } else {
                        totalIngested++;
                        onEventIngested?.({ commentary: ev });
                    }
                }
            }
        }
    } while (loop);

    console.log(`[Replay Runner] Replay complete. Ingested: ${totalIngested}, Duplicates skipped: ${totalDuplicates}.`);
    return { totalIngested, totalDuplicates };
}
