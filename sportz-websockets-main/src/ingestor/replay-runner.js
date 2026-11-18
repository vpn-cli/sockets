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

/**
 * Replays finished matches already stored in Postgres (the commentary table)
 * for zero-dependency replay in cloud environments like Render.
 */
export async function runReplayFromPostgres({
    db = null,
    matchId = null,
    speed = process.env.REPLAY_SPEED || '1x',
    apiUrl = process.env.API_URL || null,
    broadcastCommentary = null,
    broadcastScoreUpdate = null,
    onEventIngested = null,
    loop = false,
} = {}) {
    const speedFactor = parseSpeedFactor(speed);
    console.log(`[Postgres Replay] Starting replay from finished matches in DB at ${speedFactor}x speed...`);

    let database = db;
    if (!database && process.env.DATABASE_URL) {
        const { db: defaultDb } = await import('../db/db.js');
        database = defaultDb;
    }

    if (!database) {
        throw new Error('Database instance or DATABASE_URL is required for Postgres replay');
    }

    const { matches, commentary } = await import('../db/schema.js');
    const { eq, asc, desc } = await import('drizzle-orm');

    // 1. Find finished match to replay
    let targetMatchId = matchId;
    if (!targetMatchId) {
        const finished = await database
            .select()
            .from(matches)
            .where(eq(matches.status, 'finished'))
            .orderBy(desc(matches.createdAt))
            .limit(1);

        if (finished.length > 0) {
            targetMatchId = finished[0].id;
        } else {
            // Fallback: pick any match with commentary
            const anyMatch = await database
                .select({ matchId: commentary.matchId })
                .from(commentary)
                .orderBy(desc(commentary.id))
                .limit(1);
            if (anyMatch.length > 0) {
                targetMatchId = anyMatch[0].matchId;
            }
        }
    }

    if (!targetMatchId) {
        console.warn(`[Postgres Replay] No matches or commentary found in database to replay.`);
        return { totalIngested: 0, totalDuplicates: 0, source: 'postgres' };
    }

    // 2. Fetch all commentary rows for this match
    const rows = await database
        .select()
        .from(commentary)
        .where(eq(commentary.matchId, targetMatchId))
        .orderBy(asc(commentary.sequence), asc(commentary.createdAt));

    console.log(`[Postgres Replay] Loaded ${rows.length} commentary event(s) for match ${targetMatchId} from Postgres.`);

    let totalIngested = 0;

    do {
        let prevTimestamp = null;
        for (const row of rows) {
            const currentTimestamp = row.createdAt ? new Date(row.createdAt).getTime() : Date.now();
            if (prevTimestamp !== null) {
                const deltaMs = Math.max(0, currentTimestamp - prevTimestamp);
                const delayMs = Math.min(2000, Math.max(20, Math.floor(deltaMs / speedFactor)));
                await new Promise((r) => setTimeout(r, delayMs));
            } else {
                await new Promise((r) => setTimeout(r, Math.max(10, Math.floor(500 / speedFactor))));
            }
            prevTimestamp = currentTimestamp;

            const payload = {
                id: row.id,
                matchId: row.matchId,
                minute: row.minute,
                sequence: row.sequence,
                period: row.period,
                eventType: row.eventType,
                actor: row.actor,
                team: row.team,
                message: row.message,
                provider: row.provider,
                providerEventId: row.providerEventId,
                metadata: row.metadata,
                tags: row.tags,
                createdAt: row.createdAt,
            };

            if (typeof broadcastCommentary === 'function') {
                broadcastCommentary(row.matchId, payload);
            }
            const scoreObj = row.metadata?.score || (typeof row.metadata?.homeScore === 'number' ? row.metadata : null);
            if (scoreObj && typeof broadcastScoreUpdate === 'function') {
                broadcastScoreUpdate(row.matchId, {
                    homeScore: scoreObj.homeScore ?? 0,
                    awayScore: scoreObj.awayScore ?? 0,
                    seq: row.sequence,
                });
            }
            if (apiUrl) {
                try {
                    await fetch(`${apiUrl}/matches/${row.matchId}/commentary`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                } catch {}
            }

            totalIngested++;
            onEventIngested?.({ commentary: payload });
        }
    } while (loop);

    console.log(`[Postgres Replay] Completed replaying ${totalIngested} event(s) from Postgres commentary table.`);
    return { totalIngested, totalDuplicates: 0, source: 'postgres' };
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
    usePostgres = Boolean(process.env.DATABASE_URL && !recordingPath),
} = {}) {
    // If DATABASE_URL is set and no file path was explicitly requested, replay directly from Postgres
    if (usePostgres) {
        return await runReplayFromPostgres({
            db,
            speed,
            apiUrl,
            broadcastCommentary,
            broadcastScoreUpdate,
            onEventIngested,
            loop,
        });
    }

    const speedFactor = parseSpeedFactor(speed);
    console.log(`[Replay Runner] Starting file-based replay at ${speedFactor}x speed...`);

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
