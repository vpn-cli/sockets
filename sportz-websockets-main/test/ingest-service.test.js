import 'dotenv/config';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ingestEvent } from '../src/ingestor/ingest-service.js';
import { db } from '../src/db/db.js';
import { matches, commentary } from '../src/db/schema.js';
import { eq, and } from 'drizzle-orm';

describe('Idempotent Ingestion & Sequence Assignment Tests', () => {
    let testMatchId;

    beforeEach(async () => {
        // Create an isolated match in DB for testing
        const [m] = await db.insert(matches).values({
            sport: 'football',
            homeTeam: 'Arsenal',
            awayTeam: 'Chelsea',
            status: 'live',
            homeScore: 0,
            awayScore: 0,
            lastSeq: 0,
        }).returning();
        testMatchId = m.id;
    });

    afterEach(async () => {
        // Clean up commentary and test match
        if (testMatchId) {
            await db.delete(commentary).where(eq(commentary.matchId, testMatchId));
            await db.delete(matches).where(eq(matches.id, testMatchId));
        }
    });

    it('assigns strictly increasing sequence starting from 1 in atomic transaction', async () => {
        const mockBroadcast = vi.fn();
        const mockScoreBroadcast = vi.fn();

        const event1 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_test_${Date.now()}_1`,
            minute: 10,
            message: 'First attempt on target',
        };

        const res1 = await ingestEvent(event1, {
            db,
            broadcastCommentary: mockBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });

        expect(res1.isDuplicate).toBe(false);
        expect(res1.sequence).toBe(1);
        expect(res1.commentary.sequence).toBe(1);
        expect(mockBroadcast).toHaveBeenCalledTimes(1);
        expect(mockBroadcast).toHaveBeenCalledWith(testMatchId, expect.objectContaining({ sequence: 1 }));

        const event2 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_test_${Date.now()}_2`,
            minute: 18,
            message: 'Second event',
            score: { homeScore: 1, awayScore: 0 },
        };

        const res2 = await ingestEvent(event2, {
            db,
            broadcastCommentary: mockBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });

        expect(res2.isDuplicate).toBe(false);
        expect(res2.sequence).toBe(2);
        expect(res2.commentary.sequence).toBe(2);
        expect(mockBroadcast).toHaveBeenCalledTimes(2);
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(1);
        expect(mockScoreBroadcast).toHaveBeenCalledWith(testMatchId, { homeScore: 1, awayScore: 0, seq: 2 });

        // Verify match row lastSeq in database is 2
        const [matchRow] = await db.select().from(matches).where(eq(matches.id, testMatchId));
        expect(matchRow.lastSeq).toBe(2);
        expect(matchRow.homeScore).toBe(1);
    });

    it('idempotency: same payload ingested twice gives no duplicate row and NO duplicate broadcast', async () => {
        const mockBroadcast = vi.fn();
        const mockScoreBroadcast = vi.fn();

        const duplicateEventId = `fd_dup_test_${Date.now()}`;
        const event = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: duplicateEventId,
            minute: 34,
            message: '[Event-based] GOAL! Header from corner kick.',
            score: { homeScore: 1, awayScore: 0 },
        };

        // 1. First ingestion
        const firstResult = await ingestEvent(event, {
            db,
            broadcastCommentary: mockBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });

        expect(firstResult.isDuplicate).toBe(false);
        expect(firstResult.sequence).toBe(1);
        expect(mockBroadcast).toHaveBeenCalledTimes(1);
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(1);

        // 2. Second ingestion of the EXACT SAME payload
        const secondResult = await ingestEvent(event, {
            db,
            broadcastCommentary: mockBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });

        // Assert: detected as duplicate
        expect(secondResult.isDuplicate).toBe(true);
        expect(secondResult.sequence).toBe(1);

        // Assert: NO second broadcast was fired
        expect(mockBroadcast).toHaveBeenCalledTimes(1);
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(1);

        // Assert: Only ONE row exists in database for this providerEventId
        const rows = await db
            .select()
            .from(commentary)
            .where(
                and(
                    eq(commentary.provider, 'football-data.org'),
                    eq(commentary.providerEventId, duplicateEventId)
                )
            );

        expect(rows.length).toBe(1);

        // Assert: match.lastSeq was NOT incremented again
        const [matchRow] = await db.select().from(matches).where(eq(matches.id, testMatchId));
        expect(matchRow.lastSeq).toBe(1);
    });

    it('the same full-match payload ingested 3 times gives no gaps, no extra rows, no extra broadcasts', async () => {
        const mockBroadcast = vi.fn();
        const mockScoreBroadcast = vi.fn();

        const ts = Date.now();
        // A full match sequence: Kickoff, Goal Home, Goal Away, Goal Home, Fulltime
        const matchEvents = [
            {
                matchId: testMatchId,
                provider: 'football-data.org',
                providerEventId: `fm_${ts}_status_in_play`,
                message: '[Event-based] MATCH STATUS: Arsenal vs Chelsea is now IN_PLAY.',
            },
            {
                matchId: testMatchId,
                provider: 'football-data.org',
                providerEventId: `fm_${ts}_score_1_0`,
                score: { homeScore: 1, awayScore: 0 },
                message: '[Event-based] SCORE UPDATE: Arsenal 1 - 0 Chelsea.',
            },
            {
                matchId: testMatchId,
                provider: 'football-data.org',
                providerEventId: `fm_${ts}_score_1_1`,
                score: { homeScore: 1, awayScore: 1 },
                message: '[Event-based] SCORE UPDATE: Arsenal 1 - 1 Chelsea.',
            },
            {
                matchId: testMatchId,
                provider: 'football-data.org',
                providerEventId: `fm_${ts}_score_2_1`,
                score: { homeScore: 2, awayScore: 1 },
                message: '[Event-based] SCORE UPDATE: Arsenal 2 - 1 Chelsea.',
            },
            {
                matchId: testMatchId,
                provider: 'football-data.org',
                providerEventId: `fm_${ts}_status_finished`,
                message: '[Event-based] MATCH STATUS: Arsenal vs Chelsea is now FINISHED.',
            },
        ];

        // --- PASS 1: Initial Ingest ---
        const pass1Results = [];
        for (const ev of matchEvents) {
            const res = await ingestEvent(ev, {
                db,
                broadcastCommentary: mockBroadcast,
                broadcastScoreUpdate: mockScoreBroadcast,
            });
            pass1Results.push(res);
        }

        // Verify pass 1 assigned strictly increasing 1..5
        expect(pass1Results.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]);
        expect(pass1Results.every((r) => r.isDuplicate === false)).toBe(true);
        expect(mockBroadcast).toHaveBeenCalledTimes(5);
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(3);

        // --- PASS 2: Re-ingest the EXACT same 5 events ---
        const pass2Results = [];
        for (const ev of matchEvents) {
            const res = await ingestEvent(ev, {
                db,
                broadcastCommentary: mockBroadcast,
                broadcastScoreUpdate: mockScoreBroadcast,
            });
            pass2Results.push(res);
        }

        // Verify all flagged as duplicate, sequences unchanged
        expect(pass2Results.every((r) => r.isDuplicate === true)).toBe(true);
        expect(mockBroadcast).toHaveBeenCalledTimes(5); // NO extra broadcasts
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(3); // NO extra broadcasts

        // --- PASS 3: Re-ingest the EXACT same 5 events a third time ---
        const pass3Results = [];
        for (const ev of matchEvents) {
            const res = await ingestEvent(ev, {
                db,
                broadcastCommentary: mockBroadcast,
                broadcastScoreUpdate: mockScoreBroadcast,
            });
            pass3Results.push(res);
        }

        expect(pass3Results.every((r) => r.isDuplicate === true)).toBe(true);
        expect(mockBroadcast).toHaveBeenCalledTimes(5); // STILL 5 broadcasts
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(3); // STILL 3 broadcasts

        // Verify database row count is strictly 5 (NO extra rows)
        const totalRows = await db
            .select()
            .from(commentary)
            .where(eq(commentary.matchId, testMatchId));
        expect(totalRows.length).toBe(5);

        // Verify match.lastSeq in DB is still 5
        const [matchAfterDupes] = await db.select().from(matches).where(eq(matches.id, testMatchId));
        expect(matchAfterDupes.lastSeq).toBe(5);

        // --- Verify Next New Event gets seq 6 (NO gaps burned) ---
        const postMatchEvent = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fm_${ts}_trophy_lift`,
            message: '[Event-based] Trophy presentation ceremony underway.',
        };
        const nextRes = await ingestEvent(postMatchEvent, {
            db,
            broadcastCommentary: mockBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });

        expect(nextRes.isDuplicate).toBe(false);
        expect(nextRes.sequence).toBe(6); // Perfectly gapless: 1, 2, 3, 4, 5, 6!
        expect(mockBroadcast).toHaveBeenCalledTimes(6);
    }, 30000);

    it('VAR rollback: 1-0 -> 1-1 -> VAR rollback back to 1-0 are all broadcast and final score is 1-0', async () => {
        const mockBroadcast = vi.fn();
        const mockScoreBroadcast = vi.fn();

        // 1. Initial 1-0 event
        const ev1 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_var_${Date.now()}_1_0_t1`,
            message: '[Event-based] GOAL: 1-0',
            score: { homeScore: 1, awayScore: 0 },
        };
        const res1 = await ingestEvent(ev1, { db, broadcastCommentary: mockBroadcast, broadcastScoreUpdate: mockScoreBroadcast });
        expect(res1.sequence).toBe(1);
        expect(mockScoreBroadcast).toHaveBeenLastCalledWith(testMatchId, { homeScore: 1, awayScore: 0, seq: 1 });

        // 2. Goal makes it 1-1
        const ev2 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_var_${Date.now()}_1_1_t2`,
            message: '[Event-based] GOAL: 1-1',
            score: { homeScore: 1, awayScore: 1 },
        };
        const res2 = await ingestEvent(ev2, { db, broadcastCommentary: mockBroadcast, broadcastScoreUpdate: mockScoreBroadcast });
        expect(res2.sequence).toBe(2);
        expect(mockScoreBroadcast).toHaveBeenLastCalledWith(testMatchId, { homeScore: 1, awayScore: 1, seq: 2 });

        // 3. VAR rolls back to 1-0 (even with lastUpdated timestamp token or duplicate event ID)
        const ev3 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_var_${Date.now()}_1_0_t3_var`,
            message: '[Event-based] VAR: Goal disallowed. Score returned to 1-0.',
            score: { homeScore: 1, awayScore: 0 },
        };
        const res3 = await ingestEvent(ev3, { db, broadcastCommentary: mockBroadcast, broadcastScoreUpdate: mockScoreBroadcast });
        expect(res3.sequence).toBe(3);
        expect(mockScoreBroadcast).toHaveBeenLastCalledWith(testMatchId, { homeScore: 1, awayScore: 0, seq: 3 });

        // Verify total score broadcast count = 3
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(3);

        // Verify final score in database is 1-0
        const [matchInDb] = await db.select().from(matches).where(eq(matches.id, testMatchId));
        expect(matchInDb.homeScore).toBe(1);
        expect(matchInDb.awayScore).toBe(0);
    });

    it('VAR rollback: 0-0 -> 1-0 -> 0-0 are both broadcast and final score is 0-0', async () => {
        const mockBroadcast = vi.fn();
        const mockScoreBroadcast = vi.fn();

        // 1. Goal scored: 1-0
        const ev1 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_zero_${Date.now()}_1_0`,
            message: '[Event-based] GOAL: 1-0',
            score: { homeScore: 1, awayScore: 0 },
        };
        await ingestEvent(ev1, { db, broadcastCommentary: mockBroadcast, broadcastScoreUpdate: mockScoreBroadcast });
        expect(mockScoreBroadcast).toHaveBeenLastCalledWith(testMatchId, { homeScore: 1, awayScore: 0, seq: 1 });

        // 2. VAR disallows goal: back to 0-0
        const ev2 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_zero_${Date.now()}_0_0_rollback`,
            message: '[Event-based] VAR: Goal cancelled. Score reverted to 0-0.',
            score: { homeScore: 0, awayScore: 0 },
        };
        await ingestEvent(ev2, { db, broadcastCommentary: mockBroadcast, broadcastScoreUpdate: mockScoreBroadcast });
        expect(mockScoreBroadcast).toHaveBeenLastCalledWith(testMatchId, { homeScore: 0, awayScore: 0, seq: 2 });

        expect(mockScoreBroadcast).toHaveBeenCalledTimes(2);

        // Verify final score in database is 0-0
        const [matchInDb] = await db.select().from(matches).where(eq(matches.id, testMatchId));
        expect(matchInDb.homeScore).toBe(0);
        expect(matchInDb.awayScore).toBe(0);
    });

    it('records two separate PAUSED periods as distinct commentary rows', async () => {
        // Half-Time Pause (e.g. 45 min)
        const pause1 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_pause_${Date.now()}_status_PAUSED_2026-11-18T19:45:00Z`,
            status: 'PAUSED',
            message: '[Event-based] MATCH STATUS: Arsenal vs Chelsea is now PAUSED (Half-Time).',
        };
        const res1 = await ingestEvent(pause1, { db });
        expect(res1.isDuplicate).toBe(false);
        expect(res1.sequence).toBe(1);

        // Resume play
        const live = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_pause_${Date.now()}_status_IN_PLAY_2026-11-18T20:00:00Z`,
            status: 'IN_PLAY',
            message: '[Event-based] MATCH STATUS: Second half underway.',
        };
        await ingestEvent(live, { db });

        // Extra-Time / Second Pause (e.g. 105 min)
        const pause2 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_pause_${Date.now()}_status_PAUSED_2026-11-18T20:45:00Z`,
            status: 'PAUSED',
            message: '[Event-based] MATCH STATUS: Arsenal vs Chelsea is now PAUSED (Extra-Time Break).',
        };
        const res3 = await ingestEvent(pause2, { db });
        expect(res3.isDuplicate).toBe(false);
        expect(res3.sequence).toBe(3);

        // Verify both PAUSED rows exist in commentary table
        const pausedRows = await db
            .select()
            .from(commentary)
            .where(
                and(
                    eq(commentary.matchId, testMatchId),
                    eq(commentary.provider, 'football-data.org')
                )
            );
        const pausedEvents = pausedRows.filter((r) => r.message.includes('PAUSED'));
        expect(pausedEvents.length).toBe(2);
    });

    it('always upserts match current score/status even when commentary event is a duplicate', async () => {
        const mockScoreBroadcast = vi.fn();
        const duplicateEventId = `fd_upsert_dup_${Date.now()}`;

        // 1. Ingest event first time (score 1-0)
        const ev1 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: duplicateEventId,
            message: 'First score',
            score: { homeScore: 1, awayScore: 0 },
            status: 'live',
        };
        const res1 = await ingestEvent(ev1, { db, broadcastScoreUpdate: mockScoreBroadcast });
        expect(res1.isDuplicate).toBe(false);

        // Manually simulate a score correction arriving with the SAME duplicateEventId but corrected score 2-0
        const ev2 = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: duplicateEventId,
            message: 'Duplicate event ID with score update',
            score: { homeScore: 2, awayScore: 0 },
            status: 'finished',
        };
        const res2 = await ingestEvent(ev2, { db, broadcastScoreUpdate: mockScoreBroadcast });
        expect(res2.isDuplicate).toBe(true);

        // Verify match row in database was STILL upserted to 2-0 and status 'finished'
        const [matchInDb] = await db.select().from(matches).where(eq(matches.id, testMatchId));
        expect(matchInDb.homeScore).toBe(2);
        expect(matchInDb.awayScore).toBe(0);
        expect(matchInDb.status).toBe('finished');

        // And score broadcast was triggered for the correction
        expect(mockScoreBroadcast).toHaveBeenLastCalledWith(testMatchId, { homeScore: 2, awayScore: 0, seq: 1 });
    });

    it('same score with a changed lastUpdated across 3 polls -> 0 new events, 0 broadcasts', async () => {
        const mockCommentaryBroadcast = vi.fn();
        const mockScoreBroadcast = vi.fn();

        // 1. Establish initial match state with score 1-0
        const initialGoalEvent = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `fd_m${testMatchId}_score_1_0_initial`,
            eventType: 'score_update',
            type: 'score_update',
            message: 'First goal: 1-0',
            score: { homeScore: 1, awayScore: 0 },
            status: 'live',
        };
        const initialRes = await ingestEvent(initialGoalEvent, {
            db,
            broadcastCommentary: mockCommentaryBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });
        expect(initialRes.isDuplicate).toBe(false);
        expect(initialRes.sequence).toBe(1);
        expect(mockCommentaryBroadcast).toHaveBeenCalledTimes(1);
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(1);

        // Reset broadcast spy counters before the 3 polls
        mockCommentaryBroadcast.mockClear();
        mockScoreBroadcast.mockClear();

        // 2. Poll 1: Same score (1-0), updated lastUpdated timestamp
        const poll1Event = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `football-data.org_m${testMatchId}_score_1_0_2026-11-18T20:01:00Z`,
            eventType: 'score_update',
            type: 'score_update',
            message: '[Event-based] SCORE UPDATE: Home 1 - 0 Away.',
            score: { homeScore: 1, awayScore: 0 },
            status: 'live',
            metadata: { lastUpdated: '2026-11-18T20:01:00Z' },
        };
        const res1 = await ingestEvent(poll1Event, {
            db,
            broadcastCommentary: mockCommentaryBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });
        expect(res1.isDuplicate).toBe(true);

        // 3. Poll 2: Same score (1-0), second changed lastUpdated timestamp
        const poll2Event = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `football-data.org_m${testMatchId}_score_1_0_2026-11-18T20:02:00Z`,
            eventType: 'score_update',
            type: 'score_update',
            message: '[Event-based] SCORE UPDATE: Home 1 - 0 Away.',
            score: { homeScore: 1, awayScore: 0 },
            status: 'live',
            metadata: { lastUpdated: '2026-11-18T20:02:00Z' },
        };
        const res2 = await ingestEvent(poll2Event, {
            db,
            broadcastCommentary: mockCommentaryBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });
        expect(res2.isDuplicate).toBe(true);

        // 4. Poll 3: Same score (1-0), third changed lastUpdated timestamp
        const poll3Event = {
            matchId: testMatchId,
            provider: 'football-data.org',
            providerEventId: `football-data.org_m${testMatchId}_score_1_0_2026-11-18T20:03:00Z`,
            eventType: 'score_update',
            type: 'score_update',
            message: '[Event-based] SCORE UPDATE: Home 1 - 0 Away.',
            score: { homeScore: 1, awayScore: 0 },
            status: 'live',
            metadata: { lastUpdated: '2026-11-18T20:03:00Z' },
        };
        const res3 = await ingestEvent(poll3Event, {
            db,
            broadcastCommentary: mockCommentaryBroadcast,
            broadcastScoreUpdate: mockScoreBroadcast,
        });
        expect(res3.isDuplicate).toBe(true);

        // 5. Verify: exactly 0 new events, 0 broadcasts across all 3 polls
        expect(mockCommentaryBroadcast).toHaveBeenCalledTimes(0);
        expect(mockScoreBroadcast).toHaveBeenCalledTimes(0);

        // Verify commentary row count in DB remained at 1 (from initial ingest)
        const commentaryRows = await db
            .select()
            .from(commentary)
            .where(eq(commentary.matchId, testMatchId));
        expect(commentaryRows.length).toBe(1);

        // Verify match lastSeq remained at 1
        const [matchInDb] = await db.select().from(matches).where(eq(matches.id, testMatchId));
        expect(matchInDb.lastSeq).toBe(1);
        expect(matchInDb.homeScore).toBe(1);
        expect(matchInDb.awayScore).toBe(0);
    });
});
