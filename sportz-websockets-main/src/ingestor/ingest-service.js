import { sql, eq, and } from "drizzle-orm";
import { matches, commentary } from "../db/schema.js";

/**
 * Ingests a match event idempotently:
 * 1. Checks (provider, provider_event_id) unique constraint to prevent duplicate ingestion.
 * 2. Assigns a per-match monotonically increasing sequence number in the SAME transaction.
 * 3. Updates match score (if score event).
 * 4. Inserts commentary row with assigned sequence.
 * 5. Broadcasts to WebSocket subscribers ONLY AFTER transaction commit succeeds.
 */
export async function ingestEvent(event, {
    db,
    broadcastCommentary = null,
    broadcastScoreUpdate = null,
} = {}) {
    if (!db) {
        throw new Error('Database instance is required for ingestEvent');
    }
    if (!event || !event.matchId) {
        throw new Error('Invalid event payload: matchId is required');
    }

    const result = await db.transaction(async (tx) => {
        // 1. Idempotency Check: (provider, provider_event_id)
        if (event.provider && event.providerEventId) {
            const [existing] = await tx
                .select({ id: commentary.id, sequence: commentary.sequence })
                .from(commentary)
                .where(
                    and(
                        eq(commentary.provider, event.provider),
                        eq(commentary.providerEventId, event.providerEventId)
                    )
                )
                .limit(1);

            if (existing) {
                return {
                    isDuplicate: true,
                    existingId: existing.id,
                    sequence: existing.sequence,
                };
            }
        }

        // 2. Monotonically increment matches.last_seq in the same transaction
        const updatePayload = {
            lastSeq: sql`${matches.lastSeq} + 1`,
        };

        if (event.score && typeof event.score.homeScore === 'number' && typeof event.score.awayScore === 'number') {
            updatePayload.homeScore = event.score.homeScore;
            updatePayload.awayScore = event.score.awayScore;
        }

        const [updatedMatch] = await tx
            .update(matches)
            .set(updatePayload)
            .where(eq(matches.id, event.matchId))
            .returning({
                id: matches.id,
                lastSeq: matches.lastSeq,
                homeScore: matches.homeScore,
                awayScore: matches.awayScore,
            });

        if (!updatedMatch) {
            throw new Error(`Match ${event.matchId} not found`);
        }

        const assignedSeq = updatedMatch.lastSeq;

        // 3. Insert commentary row with the assigned sequence
        const [insertedCommentary] = await tx
            .insert(commentary)
            .values({
                matchId: event.matchId,
                minute: event.minute ?? null,
                sequence: assignedSeq,
                period: event.period ?? null,
                eventType: event.eventType || event.type || null,
                actor: event.actor ?? null,
                team: event.team ?? null,
                message: event.message || '',
                provider: event.provider ?? null,
                providerEventId: event.providerEventId ?? null,
                metadata: event.metadata ?? null,
                tags: event.tags ?? null,
            })
            .returning();

        return {
            isDuplicate: false,
            commentary: insertedCommentary,
            match: updatedMatch,
            sequence: assignedSeq,
        };
    });

    if (result.isDuplicate) {
        return { isDuplicate: true, sequence: result.sequence };
    }

    // 4. CRITICAL: Broadcast ONLY AFTER transaction commit!
    if (typeof broadcastCommentary === 'function' && result.commentary) {
        broadcastCommentary(event.matchId, result.commentary);
    }

    if (typeof broadcastScoreUpdate === 'function' && event.score) {
        broadcastScoreUpdate(event.matchId, {
            homeScore: result.match.homeScore,
            awayScore: result.match.awayScore,
            seq: result.sequence,
        });
    }

    return {
        isDuplicate: false,
        commentary: result.commentary,
        match: result.match,
        sequence: result.sequence,
    };
}
