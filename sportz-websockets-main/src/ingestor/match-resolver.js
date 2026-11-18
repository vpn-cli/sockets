import { matches } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

/**
 * Resolves a provider match to a local match in Sportz.
 * If local match exists, returns it.
 * If not, creates it in Sportz (via db or apiUrl) and returns the created match.
 */
export async function resolveMatchForProvider({
    providerMatch,
    provider = 'football-data.org',
    db = null,
    apiUrl = null,
}) {
    if (!providerMatch) return null;

    const providerMatchId = String(providerMatch.id);
    const homeTeam = providerMatch.homeTeam?.name || providerMatch.homeTeam?.shortName || 'Home';
    const awayTeam = providerMatch.awayTeam?.name || providerMatch.awayTeam?.shortName || 'Away';
    const homeScore = providerMatch.score?.fullTime?.home ?? providerMatch.score?.halfTime?.home ?? 0;
    const awayScore = providerMatch.score?.fullTime?.away ?? providerMatch.score?.halfTime?.away ?? 0;
    const startTime = providerMatch.utcDate ? new Date(providerMatch.utcDate).toISOString() : new Date().toISOString();
    const endTime = new Date(new Date(startTime).getTime() + 2 * 3600 * 1000).toISOString();

    if (db) {
        try {
            const found = await db
                .select()
                .from(matches)
                .where(and(eq(matches.provider, provider), eq(matches.providerMatchId, providerMatchId)))
                .limit(1);

            if (found.length > 0) {
                return found[0];
            }

            const [created] = await db
                .insert(matches)
                .values({
                    sport: 'football',
                    homeTeam,
                    awayTeam,
                    status: providerMatch.status === 'IN_PLAY' || providerMatch.status === 'PAUSED' ? 'live' : 'scheduled',
                    startTime: new Date(startTime),
                    endTime: new Date(endTime),
                    homeScore,
                    awayScore,
                    lastSeq: 0,
                    provider,
                    providerMatchId,
                })
                .returning();

            return created;
        } catch (err) {
            console.error(`[Match Resolver] DB resolution failed:`, err.message);
        }
    }

    if (apiUrl) {
        try {
            const res = await fetch(`${apiUrl}/matches?limit=100`);
            if (res.ok) {
                const body = await res.json();
                const list = Array.isArray(body.data) ? body.data : [];
                const existing = list.find((m) => m.provider === provider && m.providerMatchId === providerMatchId);
                if (existing) {
                    return existing;
                }
            }

            const createRes = await fetch(`${apiUrl}/matches`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sport: 'football',
                    homeTeam,
                    awayTeam,
                    startTime,
                    endTime,
                    homeScore,
                    awayScore,
                    provider,
                    providerMatchId,
                }),
            });

            if (createRes.ok) {
                const createBody = await createRes.json();
                return createBody.data;
            }
        } catch (err) {
            console.error(`[Match Resolver] API resolution failed:`, err.message);
        }
    }

    // Default fallback: return structure with providerMatch.id
    return {
        id: providerMatch.id,
        sport: 'football',
        homeTeam,
        awayTeam,
        homeScore,
        awayScore,
        provider,
        providerMatchId,
    };
}

export async function ingestEventViaApi({ apiUrl, eventPayload }) {
    const res = await fetch(`${apiUrl}/matches/${eventPayload.matchId}/commentary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventPayload),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to post commentary via API (${res.status}): ${text}`);
    }

    return await res.json();
}
