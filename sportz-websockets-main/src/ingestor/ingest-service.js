import { eq, and } from "drizzle-orm";
import { matches, commentary } from "../db/schema.js";

/**
 * Ingests a match event idempotently:
 * 1. Locks the match row (FOR UPDATE) to serialize concurrent event processing for the match.
 * 2. Checks candidate sequence: candidateSeq = match.lastSeq + 1.
 * 3. Inserts commentary row with ON CONFLICT (provider, provider_event_id) DO NOTHING.
 * 4. If INSERT affects 0 rows (duplicate event):
 *    - DO NOT update matches.last_seq (prevent burning/wasting sequence numbers).
 *    - Returns duplicate status immediately without broadcasting.
 * 5. If INSERT succeeds (affected 1 row):
 *    - Updates matches.last_seq = candidateSeq in the SAME transaction.
 *    - Broadcasts to WebSocket subscribers ONLY AFTER transaction commit.
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
        // 1. Lock match row to serialize sequence generation for this match
        const [matchRow] = await tx
            .select({
                id: matches.id,
                lastSeq: matches.lastSeq,
                homeScore: matches.homeScore,
                awayScore: matches.awayScore,
            })
            .from(matches)
            .where(eq(matches.id, event.matchId))
            .for('update');

        if (!matchRow) {
            throw new Error(`Match ${event.matchId} not found`);
        }

        const candidateSeq = (matchRow.lastSeq || 0) + 1;

        // 2. Try inserting commentary with candidateSeq
        const insertValues = {
            matchId: event.matchId,
            minute: event.minute ?? null,
            sequence: candidateSeq,
            period: event.period ?? null,
            eventType: event.eventType || event.type || null,
            actor: event.actor ?? null,
            team: event.team ?? null,
            message: event.message || '',
            provider: event.provider ?? null,
            providerEventId: event.providerEventId ?? null,
            metadata: event.metadata ?? null,
            tags: event.tags ?? null,
        };

        let insertedRows = [];
        if (event.provider && event.providerEventId) {
            insertedRows = await tx
                .insert(commentary)
                .values(insertValues)
                .onConflictDoNothing({
                    target: [commentary.provider, commentary.providerEventId],
                })
                .returning();
        } else {
            insertedRows = await tx
                .insert(commentary)
                .values(insertValues)
                .returning();
        }

        // 3. If INSERT affected 0 rows, this event is a duplicate!
        // DO NOT update matches.last_seq, ensuring no sequence gaps.
        if (!insertedRows || insertedRows.length === 0) {
            const [existing] = await tx
                .select({ sequence: commentary.sequence })
                .from(commentary)
                .where(
                    and(
                        eq(commentary.provider, event.provider),
                        eq(commentary.providerEventId, event.providerEventId)
                    )
                )
                .limit(1);

            return {
                isDuplicate: true,
                sequence: existing?.sequence ?? matchRow.lastSeq,
            };
        }

        const insertedCommentary = insertedRows[0];

        // 4. Update match last_seq only when row was actually inserted
        const updatePayload = {
            lastSeq: candidateSeq,
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

        return {
            isDuplicate: false,
            commentary: insertedCommentary,
            match: updatedMatch,
            sequence: candidateSeq,
        };
    });

    if (result.isDuplicate) {
        return { isDuplicate: true, sequence: result.sequence };
    }

    // 5. Broadcast ONLY AFTER commit and ONLY if not duplicate
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
