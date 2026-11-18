import {
    fetchLiveMatches,
    computeDailyCallBudget,
    mapProviderMatchToEvents,
} from './provider-adapter.js';
import { FeedRecorder } from './recorder.js';
import { ingestEvent } from './ingest-service.js';
import { resolveMatchForProvider, ingestEventViaApi } from './match-resolver.js';

export async function runLiveIngest({
    apiKey = process.env.FOOTBALL_DATA_API_KEY,
    pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS || 60),
    record = process.env.RECORD === 'true' || process.env.RECORD === '1',
    db = null,
    apiUrl = process.env.API_URL || null,
    broadcastCommentary = null,
    broadcastScoreUpdate = null,
    maxPollCycles = null,
} = {}) {
    // 1. Compute and verify daily call budget at startup
    console.log(`[Live Ingestor] Initializing live feed worker...`);
    const budgetReport = computeDailyCallBudget({ pollIntervalSeconds });
    console.log(`✅ [Live Ingestor] Budget verified: ${budgetReport.callsPerDay} calls/day.`);

    const recorder = record ? new FeedRecorder() : null;
    if (recorder) {
        await recorder.init();
    }

    let isRunning = true;
    let cycles = 0;

    const stop = () => {
        isRunning = false;
        console.log(`[Live Ingestor] Stopping ingestor...`);
    };

    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);

    while (isRunning) {
        cycles++;
        try {
            console.log(`[Live Ingestor] Fetching live in-play matches (Cycle #${cycles})...`);
            const result = await fetchLiveMatches({ apiKey });

            if (result.rateLimited) {
                const sleepTime = result.retryAfterSeconds || 60;
                console.warn(`⏳ [Live Ingestor] 429 Rate limit hit. Honoring Retry-After header: sleeping for ${sleepTime}s...`);
                await new Promise((r) => setTimeout(r, sleepTime * 1000));
                continue;
            }

            if (recorder && result.raw) {
                await recorder.record(result.raw);
            }

            console.log(`[Live Ingestor] Fetched ${result.matches.length} active match(es).`);

            for (const match of result.matches) {
                const localMatch = await resolveMatchForProvider({
                    providerMatch: match,
                    db,
                    apiUrl,
                });
                const localMatchId = localMatch?.id || match.id;
                const events = mapProviderMatchToEvents(match, localMatchId);

                for (const ev of events) {
                    if (db) {
                        await ingestEvent(ev, {
                            db,
                            broadcastCommentary,
                            broadcastScoreUpdate,
                        });
                    } else if (apiUrl) {
                        await ingestEventViaApi({ apiUrl, eventPayload: ev });
                    }
                }
            }
        } catch (err) {
            console.error(`❌ [Live Ingestor Error] Cycle #${cycles} failed:`, err.message);
        }

        if (maxPollCycles && cycles >= maxPollCycles) {
            break;
        }

        // Wait poll interval before next cycle
        await new Promise((r) => setTimeout(r, pollIntervalSeconds * 1000));
    }

    console.log(`[Live Ingestor] Shutdown complete.`);
}
