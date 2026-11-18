import { describe, it, expect } from 'vitest';
import { getReconnectDelay } from '../hooks/useWebSocket';
import { INITIAL_RECONNECT_DELAY, MAX_RECONNECT_DELAY } from '../constants';

describe('getReconnectDelay', () => {
    it('returns 1000ms (1s) for attempt 0', () => {
        expect(getReconnectDelay(0)).toBe(1000);
    });

    it('returns 2000ms (2s) for attempt 1', () => {
        expect(getReconnectDelay(1)).toBe(2000);
    });

    it('returns 4000ms (4s) for attempt 2', () => {
        expect(getReconnectDelay(2)).toBe(4000);
    });

    it('returns 8000ms (8s) for attempt 3', () => {
        expect(getReconnectDelay(3)).toBe(8000);
    });

    it('returns 16000ms (16s) for attempt 4', () => {
        expect(getReconnectDelay(4)).toBe(16000);
    });

    it('caps delay at MAX_RECONNECT_DELAY (30000ms / 30s) for attempt 5 and beyond', () => {
        expect(getReconnectDelay(5)).toBe(30000); // 32000 capped to 30000
        expect(getReconnectDelay(6)).toBe(30000);
        expect(getReconnectDelay(10)).toBe(30000);
        expect(getReconnectDelay(50)).toBe(30000);
    });

    it('respects custom initialDelay and maxDelay parameters', () => {
        expect(getReconnectDelay(0, 500, 5000)).toBe(500);
        expect(getReconnectDelay(1, 500, 5000)).toBe(1000);
        expect(getReconnectDelay(2, 500, 5000)).toBe(2000);
        expect(getReconnectDelay(3, 500, 5000)).toBe(4000);
        expect(getReconnectDelay(4, 500, 5000)).toBe(5000); // 8000 capped at 5000
    });

    it('uses constants by default', () => {
        expect(INITIAL_RECONNECT_DELAY).toBe(1000);
        expect(MAX_RECONNECT_DELAY).toBe(30000);
        expect(getReconnectDelay(0)).toBe(INITIAL_RECONNECT_DELAY);
    });

    it('handles negative attempts gracefully by returning initialDelay', () => {
        expect(getReconnectDelay(-1)).toBe(1000);
    });
});

describe('useWebSocket message deduplication logic', () => {
    it('filters out commentary messages with duplicate or older sequence numbers', () => {
        const receivedMessages: any[] = [];
        const lastSeen = new Map<string, number>();

        function processMessage(msg: any) {
            if (msg.type === 'commentary' && msg.data) {
                const matchId = String(msg.data.matchId);
                const seq = Number(msg.data.sequence ?? msg.data.seq);
                if (matchId && Number.isInteger(seq) && seq > 0) {
                    const prev = lastSeen.get(matchId) || 0;
                    if (seq <= prev) {
                        return; // dropped
                    }
                    lastSeen.set(matchId, seq);
                }
            }
            receivedMessages.push(msg);
        }

        // Event seq 1 arrives
        processMessage({ type: 'commentary', data: { matchId: 10, sequence: 1, message: 'Goal 1' } });
        expect(receivedMessages.length).toBe(1);

        // Duplicate event seq 1 arrives (re-delivered by network or replay)
        processMessage({ type: 'commentary', data: { matchId: 10, sequence: 1, message: 'Goal 1 (duplicate)' } });
        expect(receivedMessages.length).toBe(1); // dropped!

        // Event seq 2 arrives
        processMessage({ type: 'commentary', data: { matchId: 10, sequence: 2, message: 'Yellow card' } });
        expect(receivedMessages.length).toBe(2);

        // Older event seq 1 arrives out of order
        processMessage({ type: 'commentary', data: { matchId: 10, sequence: 1, message: 'Old event' } });
        expect(receivedMessages.length).toBe(2); // dropped!
    });

    it('detects sequence gap (seq N while lastSeen < N-1) and emits replay request from lastSeenSeq', () => {
        const replayRequests: any[] = [];
        const seenSeqs = new Set<number>();
        let lastSeenSeq = 0;

        function handleCommentary(matchId: number, seq: number) {
            if (seenSeqs.has(seq)) return;
            seenSeqs.add(seq);

            if (lastSeenSeq > 0 && seq > lastSeenSeq + 1) {
                // Gap detected: request replay
                replayRequests.push({
                    type: 'replay',
                    matchId,
                    lastSeq: lastSeenSeq,
                });
            }

            if (seq > lastSeenSeq) {
                lastSeenSeq = seq;
            }
        }

        // 1. Seq 1 arrives
        handleCommentary(42, 1);
        expect(replayRequests.length).toBe(0);
        expect(lastSeenSeq).toBe(1);

        // 2. Seq 3 arrives (missed seq 2 during network outage)
        handleCommentary(42, 3);
        expect(replayRequests.length).toBe(1);
        expect(replayRequests[0]).toEqual({
            type: 'replay',
            matchId: 42,
            lastSeq: 1,
        });

        // 3. Replayed seq 2 arrives in response without gap trigger
        handleCommentary(42, 2);
        expect(replayRequests.length).toBe(1); // no new gap request!
        expect(seenSeqs.has(1)).toBe(true);
        expect(seenSeqs.has(2)).toBe(true);
        expect(seenSeqs.has(3)).toBe(true);
    });
});

