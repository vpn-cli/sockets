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
});
