import { useState, useEffect, useRef, useCallback } from 'react';
import { WS_BASE_URL, INITIAL_RECONNECT_DELAY, MAX_RECONNECT_DELAY } from '../constants';
import { ConnectionStatus, WSMessage } from '../types';

export function getReconnectDelay(
  attempt: number,
  initialDelay: number = INITIAL_RECONNECT_DELAY,
  maxDelay: number = MAX_RECONNECT_DELAY
): number {
  return Math.min(initialDelay * (2 ** Math.max(0, attempt)), maxDelay);
}

interface UseWebSocketReturn {
  status: ConnectionStatus;
  connectGlobal: () => void;
  subscribeMatch: (matchId: string | number) => void;
  unsubscribeMatch: (matchId: string | number) => void;
  sendReaction: (matchId: string | number, emoji: string) => void;
  requestClientReplay: (matchId: string | number, speed?: '1x' | '10x') => void;
  disconnect: () => void;
}

export const useWebSocket = (
  onMessage: (msg: WSMessage) => void
): UseWebSocketReturn => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const isIntentionalClose = useRef(false);
  const subscribedMatchIdsRef = useRef(new Set<string>());
  const lastSeenSeqByMatch = useRef<Map<string, number>>(new Map());
  const seenSeqsByMatch = useRef<Map<string, Set<number>>>(new Map());
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const normalizeId = (matchId: string | number) => String(matchId);

  const sendMessage = useCallback((message: WSMessage | Record<string, unknown>) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(message));
    }
  }, []);

  const cleanupSocket = useCallback((socket: WebSocket | null) => {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }, []);

  // Core connect function
  const initConnection = useCallback(() => {
    // If reconnect timer is already pending, clear it
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }

    // Clean up previous connection completely
    if (ws.current) {
      cleanupSocket(ws.current);
      ws.current = null;
    }

    setStatus(reconnectAttempts.current > 0 ? 'reconnecting' : 'connecting');
    isIntentionalClose.current = false;

    // Construct URL
    const socketUrl = `${WS_BASE_URL}?all=1`;
    
    try {
      const socket = new WebSocket(socketUrl);
      ws.current = socket;

      socket.onopen = () => {
        if (ws.current !== socket) return;

        setStatus('connected');
        reconnectAttempts.current = 0;
        if (reconnectTimeout.current) {
          clearTimeout(reconnectTimeout.current);
          reconnectTimeout.current = null;
        }

        // Re-subscribe to any active matches with lastSeen sequence
        if (subscribedMatchIdsRef.current.size > 0) {
          subscribedMatchIdsRef.current.forEach((matchId) => {
            const lastSeq = lastSeenSeqByMatch.current.get(matchId) || 0;
            socket.send(JSON.stringify({
              type: 'subscribe',
              matchId: Number(matchId),
              lastSeq,
            }));
          });
        }
        console.log('[WebSocket] Connected successfully');
      };

      socket.onmessage = (event) => {
        if (ws.current !== socket) return;
        try {
          const data = JSON.parse(event.data);

          // Track seen sequences per match: drop true duplicates, detect gaps, but NEVER drop missed events due to out-of-order live events
          if (data?.type === 'commentary' && data?.data) {
            const matchId = String(data.data.matchId || data.matchId);
            const seq = Number(data.data.sequence ?? data.data.seq);
            if (matchId && Number.isInteger(seq) && seq > 0) {
              let seen = seenSeqsByMatch.current.get(matchId);
              if (!seen) {
                seen = new Set();
                seenSeqsByMatch.current.set(matchId, seen);
              }

              if (seen.has(seq)) {
                // Drop duplicate message
                return;
              }
              seen.add(seq);

              const prevMax = lastSeenSeqByMatch.current.get(matchId) || 0;
              if (prevMax > 0 && seq > prevMax + 1) {
                // Gap detected! Client received seq N while it last saw seq < N-1.
                // Request replay from last seen seq over the open socket without reconnecting.
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({
                    type: 'replay',
                    matchId: Number(matchId),
                    lastSeq: prevMax,
                  }));
                }
              }

              if (seq > prevMax) {
                lastSeenSeqByMatch.current.set(matchId, seq);
              }
            }
          } else if (data?.type === 'replay_events' && Array.isArray(data?.events)) {
            const matchId = String(data.matchId);
            for (const ev of data.events) {
              const seq = Number(ev.sequence ?? ev.seq);
              if (seq > 0) {
                const prevMax = lastSeenSeqByMatch.current.get(matchId) || 0;
                if (seq > prevMax) {
                  lastSeenSeqByMatch.current.set(matchId, seq);
                }
              }
            }
          }

          onMessageRef.current?.(data);
        } catch (e) {
          console.error('[WebSocket] Failed to parse message:', e);
        }
      };

      socket.onerror = () => {
        if (ws.current !== socket) return;
        console.warn('[WebSocket] Connection error occurred');
        if (socket.readyState === WebSocket.OPEN) {
          setStatus('error');
        }
      };

      socket.onclose = (event) => {
        if (ws.current !== socket) return;
        ws.current = null;

        if (isIntentionalClose.current) {
          setStatus('disconnected');
          return;
        }

        // Unintentional disconnect: initiate reconnect backoff
        setStatus('reconnecting');
        const delay = getReconnectDelay(reconnectAttempts.current);
        
        console.log(`[WebSocket] Disconnected (Code: ${event.code}). Reconnecting in ${delay}ms...`);
        
        if (reconnectTimeout.current) {
          clearTimeout(reconnectTimeout.current);
        }
        reconnectTimeout.current = setTimeout(() => {
          reconnectAttempts.current += 1;
          initConnection();
        }, delay);
      };

    } catch (e) {
      console.error('[WebSocket] Connection creation failed:', e);
      setStatus('error');
    }
  }, [cleanupSocket]);

  // Public connect method
  const connectGlobal = useCallback(() => {
    isIntentionalClose.current = false;
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }

    if (
      ws.current &&
      (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    reconnectAttempts.current = 0;
    initConnection();
  }, [initConnection]);

  const subscribeMatch = useCallback((matchId: string | number) => {
    const normalized = normalizeId(matchId);
    subscribedMatchIdsRef.current.add(normalized);
    const lastSeq = lastSeenSeqByMatch.current.get(normalized) || 0;
    sendMessage({ type: 'subscribe', matchId: Number(matchId), lastSeq });
  }, [sendMessage]);

  const unsubscribeMatch = useCallback((matchId: string | number) => {
    const normalized = normalizeId(matchId);
    subscribedMatchIdsRef.current.delete(normalized);
    lastSeenSeqByMatch.current.delete(normalized);
    sendMessage({ type: 'unsubscribe', matchId: Number(matchId) });
  }, [sendMessage]);

  const sendReaction = useCallback((matchId: string | number, emoji: string) => {
    sendMessage({
      type: 'reaction',
      matchId: Number(matchId),
      emoji,
    });
  }, [sendMessage]);

  const requestClientReplay = useCallback((matchId: string | number, speed: '1x' | '10x' = '1x') => {
    sendMessage({
      type: 'client_replay',
      matchId: Number(matchId),
      speed,
    });
  }, [sendMessage]);

  // Public disconnect method
  const disconnect = useCallback(() => {
    isIntentionalClose.current = true;
    
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    
    if (ws.current) {
      cleanupSocket(ws.current);
      ws.current = null;
    }
    
    setStatus('disconnected');
  }, [cleanupSocket]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isIntentionalClose.current = true;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
        reconnectTimeout.current = null;
      }
      if (ws.current) {
        cleanupSocket(ws.current);
        ws.current = null;
      }
    };
  }, [cleanupSocket]);

  return { status, connectGlobal, subscribeMatch, unsubscribeMatch, sendReaction, requestClientReplay, disconnect };
};
