import React, { useMemo, useState } from 'react';
import { Commentary } from '../types';

interface LiveFeedProps {
  messages: Commentary[];
  isActive: boolean;
  isLoading?: boolean;
}

const formatMinute = (minute?: number) => {
  if (minute === undefined || minute === null) {
    return null;
  }
  return `${minute}'`;
};

const formatMetadata = (metadata?: Record<string, unknown>) => {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null;
  }
  try {
    return JSON.stringify(metadata);
  } catch {
    return null;
  }
};

const getEventBadge = (eventType?: string, message?: string) => {
  const text = `${eventType || ''} ${message || ''}`.toLowerCase();

  if (text.includes('goal')) {
    return { icon: '⚽', label: 'GOAL', color: 'bg-emerald-100 text-emerald-900 border-emerald-600', isHighlight: true };
  }
  if (text.includes('wicket')) {
    return { icon: '🏏', label: 'WICKET', color: 'bg-rose-100 text-rose-900 border-rose-600', isHighlight: true };
  }
  if (text.includes('six') || text.includes('maximum')) {
    return { icon: '💥', label: '6 RUNS', color: 'bg-purple-100 text-purple-900 border-purple-600', isHighlight: true };
  }
  if (text.includes('four') || text.includes('boundary')) {
    return { icon: '⚡', label: '4 RUNS', color: 'bg-blue-100 text-blue-900 border-blue-600', isHighlight: true };
  }
  if (text.includes('red card')) {
    return { icon: '🟥', label: 'RED CARD', color: 'bg-red-100 text-red-900 border-red-600', isHighlight: true };
  }
  if (text.includes('booked') || text.includes('yellow card')) {
    return { icon: '🟨', label: 'BOOKING', color: 'bg-amber-100 text-amber-900 border-amber-600', isHighlight: true };
  }
  if (text.includes('foul')) {
    return { icon: '⚠️', label: 'FOUL', color: 'bg-orange-100 text-orange-900 border-orange-500', isHighlight: false };
  }
  if (text.includes('jumper') || text.includes('dunk') || text.includes('three-pointer')) {
    return { icon: '🏀', label: 'POINTS', color: 'bg-amber-100 text-amber-900 border-amber-600', isHighlight: true };
  }
  if (eventType) {
    return { icon: '📢', label: eventType.toUpperCase(), color: 'bg-brand-yellow text-black border-black', isHighlight: false };
  }
  return null;
};

export const LiveFeed: React.FC<LiveFeedProps> = ({ messages, isActive, isLoading }) => {
  const [highlightsOnly, setHighlightsOnly] = useState(false);

  const filteredMessages = useMemo(() => {
    if (!highlightsOnly) return messages;
    return messages.filter((msg) => {
      const badge = getEventBadge(msg.eventType, msg.message);
      return badge?.isHighlight;
    });
  }, [messages, highlightsOnly]);

  if (!isActive) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8 bg-gray-50 border-2 border-black rounded-2xl border-dashed">
        <div className="w-16 h-16 bg-brand-yellow rounded-full border-2 border-black flex items-center justify-center mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
        <h3 className="font-bold text-xl mb-2">No Match Selected</h3>
        <p className="text-gray-500 max-w-xs">Select a match from the list to view live commentary and real-time updates.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white border-2 border-black rounded-2xl overflow-hidden shadow-hard">
      {/* Header */}
      <div className="p-4 bg-brand-blue border-b-2 border-black flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-lg">Live Commentary</h3>
          <span className="text-xs bg-white px-2 py-0.5 border border-black rounded-full font-medium shadow-hard-sm">
            {messages.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setHighlightsOnly(!highlightsOnly)}
            className={`
              text-xs px-2.5 py-1 rounded-full font-bold border border-black transition-all
              ${highlightsOnly ? 'bg-brand-yellow text-black' : 'bg-white text-gray-700 hover:bg-gray-50'}
            `}
          >
            {highlightsOnly ? '⭐ Highlights' : 'All Updates'}
          </button>
        </div>
      </div>
      
      {/* Feed list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
        {isLoading ? (
          <div className="text-center py-10 text-gray-400 italic">
            Loading commentary...
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="text-center py-10 text-gray-400 italic">
            {highlightsOnly ? 'No key highlights yet for this match.' : 'Waiting for live updates...'}
          </div>
        ) : (
          filteredMessages.map((msg) => {
            const timestamp = msg.createdAt ? new Date(msg.createdAt) : new Date();
            const minuteLabel = formatMinute(msg.minute);
            const metadataLabel = formatMetadata(msg.metadata);
            const eventBadge = getEventBadge(msg.eventType, msg.message);
            const isHighlight = eventBadge?.isHighlight;

            return (
              <div
                key={msg.id}
                className={`
                  p-3 rounded-xl border-2 transition-all
                  ${isHighlight 
                    ? 'bg-amber-50/60 border-black shadow-hard-sm' 
                    : 'bg-gray-50 border-gray-200'}
                `}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 mb-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-gray-400 text-[11px]">
                      {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    {minuteLabel && (
                      <span className="px-2 py-0.5 bg-black text-white rounded-full font-bold text-[10px]">
                        {minuteLabel}
                      </span>
                    )}
                    {msg.period && (
                      <span className="px-2 py-0.5 bg-white border border-gray-300 rounded-full font-medium text-[10px]">
                        {msg.period}
                      </span>
                    )}
                  </div>
                  {eventBadge && (
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 border rounded-full text-[10px] font-black ${eventBadge.color}`}>
                      <span>{eventBadge.icon}</span>
                      <span>{eventBadge.label}</span>
                    </span>
                  )}
                </div>

                {(msg.actor || msg.team) && (
                  <div className="text-xs font-bold text-gray-800 mb-1 flex items-center gap-1.5">
                    {msg.actor && <span>{msg.actor}</span>}
                    {msg.team && (
                      <span className="text-gray-500 font-medium">({msg.team})</span>
                    )}
                  </div>
                )}

                <p className="text-sm font-medium text-gray-900 leading-snug">
                  {msg.message}
                </p>

                {metadataLabel && (
                  <div className="mt-2 text-[11px] font-mono text-gray-500 bg-white border border-gray-200 px-2 py-1 rounded">
                    {metadataLabel}
                  </div>
                )}
                {msg.tags && msg.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {msg.tags.map((tag) => (
                      <span key={`${msg.id}-${tag}`} className="text-[10px] uppercase font-bold text-gray-600 bg-white border border-black/20 px-2 py-0.5 rounded-full">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

