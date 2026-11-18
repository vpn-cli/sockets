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
});
