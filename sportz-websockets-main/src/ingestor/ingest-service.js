import { eq, and } from "drizzle-orm";
import { matches, commentary } from "../db/schema.js";

export function mapToMatchStatus(status) {
    if (!status) return null;
    const s = String(status).toLowerCase();
    if (s === 'in_play' || s === 'paused' || s === 'live') return 'live';
    if (s === 'finished' || s === 'awarded') return 'finished';
    if (s === 'scheduled' || s === 'timed') return 'scheduled';
    return null;
}

/**
 * Ingests a match event idempotently:
 * 1. Locks the match row (FOR UPDATE) to serialize concurrent event processing for the match.
 * 2. Checks candidate sequence: candidateSeq = match.lastSeq + 1.
 * 3. Inserts commentary row with ON CONFLICT (provider, provider_event_id) DO NOTHING.
 * 4. If INSERT affects 0 rows (duplicate event):
 *    - DO NOT update matches.last_seq (prevent burning/wasting sequence numbers).
 *    - ALWAYS upserts current score and status on the match row even when commentary is duplicate.
 *    - If the score changed (e.g. VAR rollback whose event ID collided), broadcasts score update.
 * 5. If INSERT succeeds (affected 1 row):
 *    - Updates matches.last_seq = candidateSeq, score, and status in the SAME transaction.
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
                status: matches.status,
            })
            .from(matches)
            .where(eq(matches.id, event.matchId))
            .for('update');

        if (!matchRow) {
            throw new Error(`Match ${event.matchId} not found`);
        }

        const candidateSeq = (matchRow.lastSeq || 0) + 1;

        // Prepare match update payload for score & status (always applied even if event commentary is duplicate)
        const matchUpdatePayload = {};
        if (event.score && typeof event.score.homeScore === 'number' && typeof event.score.awayScore === 'number') {
            matchUpdatePayload.homeScore = event.score.homeScore;
            matchUpdatePayload.awayScore = event.score.awayScore;
        }

        const rawStatus = event.status || event.metadata?.status;
        if (rawStatus) {
            const mappedStatus = mapToMatchStatus(rawStatus);
            if (mappedStatus) {
                matchUpdatePayload.status = mappedStatus;
            }
        }

        const scoreChanged = Boolean(
            event.score &&
            typeof event.score.homeScore === 'number' &&
            typeof event.score.awayScore === 'number' &&
            (matchRow.homeScore !== event.score.homeScore || matchRow.awayScore !== event.score.awayScore)
        );

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

        // 3. If INSERT affected 0 rows, this commentary event is a duplicate!
        // DO NOT update matches.last_seq, ensuring no sequence gaps.
        // ALWAYS update match's current score and status if this duplicate event represents the latest match state
        // (preventing past historical events from regressing current match state).
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

            const isLatestEvent = !existing || existing.sequence >= matchRow.lastSeq;
            let updatedMatch = matchRow;
            let scoreChanged = false;

            if (isLatestEvent && Object.keys(matchUpdatePayload).length > 0) {
                const [m] = await tx
                    .update(matches)
                    .set(matchUpdatePayload)
                    .where(eq(matches.id, event.matchId))
                    .returning({
                        id: matches.id,
                        lastSeq: matches.lastSeq,
                        homeScore: matches.homeScore,
                        awayScore: matches.awayScore,
                        status: matches.status,
                    });
                if (m) updatedMatch = m;

                scoreChanged = Boolean(
                    event.score &&
                    typeof event.score.homeScore === 'number' &&
                    typeof event.score.awayScore === 'number' &&
                    (matchRow.homeScore !== event.score.homeScore || matchRow.awayScore !== event.score.awayScore)
                );
            }

            return {
                isDuplicate: true,
                sequence: existing?.sequence ?? matchRow.lastSeq,
                match: updatedMatch,
                scoreChanged,
            };
        }

        const insertedCommentary = insertedRows[0];

        // 4. Update match last_seq only when row was actually inserted
        matchUpdatePayload.lastSeq = candidateSeq;

        const [updatedMatch] = await tx
            .update(matches)
            .set(matchUpdatePayload)
            .where(eq(matches.id, event.matchId))
            .returning({
                id: matches.id,
                lastSeq: matches.lastSeq,
                homeScore: matches.homeScore,
                awayScore: matches.awayScore,
                status: matches.status,
            });

        return {
            isDuplicate: false,
            commentary: insertedCommentary,
            match: updatedMatch,
            sequence: candidateSeq,
            scoreChanged,
        };
    });

    // 5. Broadcast ONLY AFTER commit and ONLY if not duplicate commentary
    if (!result.isDuplicate && typeof broadcastCommentary === 'function' && result.commentary) {
        broadcastCommentary(event.matchId, result.commentary);
    }

    // 6. Broadcast score update:
    // - On fresh score events (not duplicate)
    // - On duplicate events if the score actually changed (e.g. VAR rollback whose event ID collided)
    if (typeof broadcastScoreUpdate === 'function' && event.score && (!result.isDuplicate || result.scoreChanged)) {
        broadcastScoreUpdate(event.matchId, {
            homeScore: result.match.homeScore,
            awayScore: result.match.awayScore,
            seq: result.sequence,
        });
    }

    if (result.isDuplicate) {
        return {
            isDuplicate: true,
            sequence: result.sequence,
            match: result.match,
        };
    }

    return {
        isDuplicate: false,
        commentary: result.commentary,
        match: result.match,
        sequence: result.sequence,
    };
}
