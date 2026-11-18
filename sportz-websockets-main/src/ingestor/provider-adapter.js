/**
 * Provider Adapter: Football-Data.org (v4 API)
 * 
 * Free Tier Documentation: https://www.football-data.org/documentation/api
 * Documented Free Limit: "10 requests/minute" (enforced via HTTP 429 and X-Requests-Available-Minute).
 * Free Tier Feature Set: Scores and status updates via polling; deep match events (minute-by-minute bookings/goal assists) require paid plans.
 * Attribution Requirement: "Football data provided by football-data.org"
 */

export const PROVIDER_NAME = 'football-data.org';
export const PROVIDER_ATTRIBUTION = 'Football data provided by football-data.org';
export const PROVIDER_DOCS_URL = 'https://www.football-data.org/documentation/api';
export const PROVIDER_DOCUMENTED_RATE_LIMIT = '10 requests/minute';
export const MIN_POLL_INTERVAL_SECONDS = 6; // 60s / 10 calls = 6s minimum interval

/**
 * Validates polling cadence against the provider's documented 10 requests/minute limit.
 */
export function computeDailyCallBudget({
    pollIntervalSeconds = 60,
} = {}) {
    if (!pollIntervalSeconds || pollIntervalSeconds <= 0) {
        throw new Error('Invalid pollIntervalSeconds: must be positive integer');
    }

    if (pollIntervalSeconds < MIN_POLL_INTERVAL_SECONDS) {
        throw new Error(
            `Configured poll interval (${pollIntervalSeconds}s) violates documented rate limit (${PROVIDER_DOCUMENTED_RATE_LIMIT})! Interval must be at least ${MIN_POLL_INTERVAL_SECONDS}s.`
        );
    }

    const callsPerMinute = 60 / pollIntervalSeconds;
    console.log(`[Provider Budget] Polling cadence: 1 call every ${pollIntervalSeconds}s (${callsPerMinute.toFixed(2)} calls/min, documented limit: ${PROVIDER_DOCUMENTED_RATE_LIMIT}).`);

    return {
        pollIntervalSeconds,
        callsPerMinute,
        documentedLimit: PROVIDER_DOCUMENTED_RATE_LIMIT,
        isWithinQuota: true,
    };
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
 * Maps a provider match payload into normalized events derived STRICTLY from score and status changes.
 * (Free tier data does not include real-time player/booking events).
 * All commentary text is event-templated and explicitly labeled as event-based (not human commentary).
 */
export function mapProviderMatchToEvents(providerMatch, localMatchId = null) {
    if (!providerMatch) return [];

    const targetMatchId = localMatchId !== null ? localMatchId : providerMatch.id;
    const homeTeam = providerMatch.homeTeam?.shortName || providerMatch.homeTeam?.name || 'Home';
    const awayTeam = providerMatch.awayTeam?.shortName || providerMatch.awayTeam?.name || 'Away';
    const homeScore = providerMatch.score?.fullTime?.home ?? providerMatch.score?.halfTime?.home ?? 0;
    const awayScore = providerMatch.score?.fullTime?.away ?? providerMatch.score?.halfTime?.away ?? 0;
    const status = providerMatch.status || 'SCHEDULED';

    const lastUpdatedPart = providerMatch.lastUpdated ? `_${providerMatch.lastUpdated}` : '';
    const transitionPart = providerMatch.fromScore 
        ? `${providerMatch.fromScore.homeScore}_${providerMatch.fromScore.awayScore}_to_` 
        : (providerMatch.from ? `${providerMatch.from}_to_` : '');

    const events = [];

    // 1. Status event
    const providerStatusEventId = `${PROVIDER_NAME}_m${providerMatch.id}_status_${status}${lastUpdatedPart}`;
    events.push({
        provider: PROVIDER_NAME,
        providerEventId: providerStatusEventId,
        matchId: targetMatchId,
        type: 'status_change',
        eventType: 'status_change',
        status,
        minute: providerMatch.minute ?? null,
        period: status === 'PAUSED' ? 'half-time' : (status === 'IN_PLAY' ? 'live' : status.toLowerCase()),
        actor: null,
        team: null,
        message: `[Event-based] MATCH STATUS: ${homeTeam} vs ${awayTeam} is now ${status}. Current score: ${homeScore} - ${awayScore}.`,
        score: {
            homeScore,
            awayScore,
        },
        metadata: {
            isEventBased: true,
            provider: PROVIDER_NAME,
            providerMatchId: providerMatch.id,
            status,
            lastUpdated: providerMatch.lastUpdated || null,
        },
        tags: ['status', status.toLowerCase(), 'automated-event'],
    });

    // 2. Score event (derived when scores exist, on score corrections/rollbacks, or explicit score updates)
    const isScoreRelevant = homeScore > 0 || awayScore > 0 || providerMatch.isScoreUpdate || providerMatch.scoreRollback || providerMatch.fromScore !== undefined;
    if (isScoreRelevant) {
        const providerScoreEventId = `${PROVIDER_NAME}_m${providerMatch.id}_score_${transitionPart}${homeScore}_${awayScore}${lastUpdatedPart}`;
        events.push({
            provider: PROVIDER_NAME,
            providerEventId: providerScoreEventId,
            matchId: targetMatchId,
            type: 'score_update',
            eventType: 'score_update',
            status,
            minute: providerMatch.minute ?? null,
            period: status === 'PAUSED' ? 'half-time' : (status === 'IN_PLAY' ? 'live' : status.toLowerCase()),
            actor: null,
            team: null,
            message: `[Event-based] SCORE UPDATE: ${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}.`,
            score: {
                homeScore,
                awayScore,
            },
            metadata: {
                isEventBased: true,
                provider: PROVIDER_NAME,
                providerMatchId: providerMatch.id,
                homeScore,
                awayScore,
                lastUpdated: providerMatch.lastUpdated || null,
            },
            tags: ['score', 'score-change', 'automated-event'],
        });
    }

    return events;
}
