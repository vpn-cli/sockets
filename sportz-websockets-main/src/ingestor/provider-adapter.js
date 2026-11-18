/**
 * Provider Adapter: Football-Data.org (v4 API)
 * 
 * Free Tier Documentation: https://www.football-data.org/documentation/api
 * Documented Free Limit: 10 requests / minute (600 / hour, up to 14,400 / day).
 * Cache Policy: Provider caches responses for 60 seconds (Cache-Control: max-age=60).
 * Attribution Requirement: "Football data provided by football-data.org"
 */

export const PROVIDER_NAME = 'football-data.org';
export const PROVIDER_ATTRIBUTION = 'Football data provided by football-data.org';
export const PROVIDER_DOCS_URL = 'https://www.football-data.org/documentation/api';
export const PROVIDER_FREE_TIER_DAILY_LIMIT = 14400; // 10 req/min * 1440 min/day

/**
 * Computes the daily API call budget for a given polling cadence and fails if it exceeds free quota.
 */
export function computeDailyCallBudget({
    pollIntervalSeconds = 60,
    providerDailyLimit = PROVIDER_FREE_TIER_DAILY_LIMIT,
} = {}) {
    if (!pollIntervalSeconds || pollIntervalSeconds <= 0) {
        throw new Error('Invalid pollIntervalSeconds: must be positive integer');
    }

    const callsPerDay = Math.ceil((24 * 60 * 60) / pollIntervalSeconds);
    const isWithinQuota = callsPerDay <= providerDailyLimit;

    const report = {
        pollIntervalSeconds,
        callsPerDay,
        providerDailyLimit,
        isWithinQuota,
        percentOfQuota: Number(((callsPerDay / providerDailyLimit) * 100).toFixed(2)),
    };

    console.log(`[Provider Budget] Cadence: 1 call every ${pollIntervalSeconds}s -> ${callsPerDay} calls/day (Free quota: ${providerDailyLimit}/day, ${report.percentOfQuota}% utilized).`);

    if (!isWithinQuota) {
        throw new Error(
            `Daily API call budget (${callsPerDay} calls/day) exceeds provider free quota (${providerDailyLimit} calls/day)! Polling interval must be at least ${Math.ceil((24 * 3600) / providerDailyLimit)}s.`
        );
    }

    return report;
}

/**
 * Fetches all live in-play matches across leagues in ONE single HTTP request.
 */
export async function fetchLiveMatches({
    apiKey = process.env.FOOTBALL_DATA_API_KEY,
    baseUrl = 'https://api.football-data.org/v4',
    fetchFn = fetch,
} = {}) {
    const url = `${baseUrl}/matches?status=IN_PLAY,PAUSED`;
    const headers = {
        'Accept': 'application/json',
    };

    if (apiKey) {
        headers['X-Auth-Token'] = apiKey;
    }

    const response = await fetchFn(url, { headers });

    if (response.status === 429) {
        const retryHeader = response.headers?.get?.('Retry-After') || response.headers?.get?.('x-requestcounter-reset');
        const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : 60;
        console.warn(`⚠️ [Provider 429] Rate limit reached. Server requested Retry-After: ${retryAfterSeconds}s.`);
        return {
            rateLimited: true,
            retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 60,
            matches: [],
        };
    }

    if (!response.ok) {
        throw new Error(`Provider API failed with HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return {
        rateLimited: false,
        matches: Array.isArray(data?.matches) ? data.matches : [],
        raw: data,
    };
}

/**
 * Maps a provider match payload and its child events (goals, cards, status) into the normalized event schema.
 * All commentary text is event-templated and explicitly labeled as event-based (not human commentary).
 */
export function mapProviderMatchToEvents(providerMatch, localMatchId = null) {
    if (!providerMatch) return [];

    const targetMatchId = localMatchId !== null ? localMatchId : providerMatch.id;
    const homeTeam = providerMatch.homeTeam?.shortName || providerMatch.homeTeam?.name || 'Home';
    const awayTeam = providerMatch.awayTeam?.shortName || providerMatch.awayTeam?.name || 'Away';
    const homeScore = providerMatch.score?.fullTime?.home ?? providerMatch.score?.halfTime?.home ?? 0;
    const awayScore = providerMatch.score?.fullTime?.away ?? providerMatch.score?.halfTime?.away ?? 0;

    const events = [];

    // 1. Goals mapping
    if (Array.isArray(providerMatch.goals)) {
        for (let i = 0; i < providerMatch.goals.length; i++) {
            const g = providerMatch.goals[i];
            const minute = g.minute ?? 0;
            const scorerName = g.scorer?.name || 'Player';
            const teamName = g.team?.name || (g.team?.id === providerMatch.homeTeam?.id ? homeTeam : awayTeam);
            const goalType = g.type ? ` (${g.type})` : '';
            const assistStr = g.assist?.name ? ` (assist: ${g.assist.name})` : '';
            const scoreSnapshot = g.score || { home: homeScore, away: awayScore };

            const providerEventId = `${PROVIDER_NAME}_m${providerMatch.id}_goal_${minute}_${g.scorer?.id || i}_${scoreSnapshot.home}_${scoreSnapshot.away}`;

            events.push({
                provider: PROVIDER_NAME,
                providerEventId,
                matchId: targetMatchId,
                type: 'goal',
                eventType: 'goal',
                minute,
                period: providerMatch.period || (minute > 45 ? '2nd-half' : '1st-half'),
                actor: scorerName,
                team: teamName,
                message: `[Event-based] GOAL! ${scorerName} scores for ${teamName} in minute ${minute}'${goalType}${assistStr}. Score: ${scoreSnapshot.home} - ${scoreSnapshot.away}`,
                score: {
                    homeScore: scoreSnapshot.home,
                    awayScore: scoreSnapshot.away,
                },
                metadata: {
                    isEventBased: true,
                    provider: PROVIDER_NAME,
                    providerMatchId: providerMatch.id,
                    goalType: g.type,
                    assist: g.assist?.name,
                },
                tags: ['goal', 'score-change', 'automated-event'],
            });
        }
    }

    // 2. Bookings / Cards mapping
    if (Array.isArray(providerMatch.bookings)) {
        for (let i = 0; i < providerMatch.bookings.length; i++) {
            const b = providerMatch.bookings[i];
            const minute = b.minute ?? 0;
            const playerName = b.player?.name || 'Player';
            const teamName = b.team?.name || (b.team?.id === providerMatch.homeTeam?.id ? homeTeam : awayTeam);
            const cardName = b.card === 'RED_CARD' ? 'RED CARD' : 'YELLOW CARD';

            const providerEventId = `${PROVIDER_NAME}_m${providerMatch.id}_booking_${minute}_${b.player?.id || i}_${b.card}`;

            events.push({
                provider: PROVIDER_NAME,
                providerEventId,
                matchId: targetMatchId,
                type: 'card',
                eventType: b.card === 'RED_CARD' ? 'red_card' : 'card',
                minute,
                period: providerMatch.period || (minute > 45 ? '2nd-half' : '1st-half'),
                actor: playerName,
                team: teamName,
                message: `[Event-based] ${cardName} brandished to ${playerName} (${teamName}) at minute ${minute}'.`,
                score: {
                    homeScore,
                    awayScore,
                },
                metadata: {
                    isEventBased: true,
                    provider: PROVIDER_NAME,
                    providerMatchId: providerMatch.id,
                    card: b.card,
                },
                tags: ['card', b.card.toLowerCase(), 'automated-event'],
            });
        }
    }

    // Sort mapped events by minute ascending
    events.sort((a, b) => (a.minute || 0) - (b.minute || 0));

    return events;
}
