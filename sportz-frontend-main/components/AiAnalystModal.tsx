import React, { useEffect, useState } from 'react';
import { fetchAiMatchInsights } from '../services/api';
import { AiInsights, Match } from '../types';

interface AiAnalystModalProps {
  isOpen: boolean;
  onClose: () => void;
  match: Match | null;
}

export const AiAnalystModal: React.FC<AiAnalystModalProps> = ({
  isOpen,
  onClose,
  match,
}) => {
  const [insights, setInsights] = useState<AiInsights | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInsights = async () => {
    if (!match) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetchAiMatchInsights(match.id);
      setInsights(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate tactical analysis.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && match) {
      loadInsights();
    } else {
      setInsights(null);
      setError(null);
    }
  }, [isOpen, match?.id]);

  if (!isOpen || !match) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div 
        className="relative w-full max-w-2xl bg-white border-2 border-black rounded-2xl shadow-hard overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 bg-brand-yellow border-b-2 border-black flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white border-2 border-black rounded-xl flex items-center justify-center text-xl shadow-hard-sm">
              🤖
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-black text-brand-dark">AI Match Analyst</h3>
                <span className="text-[10px] font-mono font-bold bg-white text-black border border-black px-2 py-0.5 rounded-full">
                  Gemini 3.8 Flash
                </span>
              </div>
              <p className="text-xs font-semibold text-brand-dark/80">
                {match.homeTeam} vs {match.awayTeam} ({match.homeScore} - {match.awayScore})
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg border-2 border-black bg-white hover:bg-gray-100 font-bold transition-all active:translate-y-0.5"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-5">
          {isLoading && (
            <div className="py-16 text-center space-y-4">
              <div className="animate-spin w-10 h-10 border-4 border-brand-yellow border-t-black rounded-full mx-auto" />
              <div className="space-y-1">
                <p className="font-black text-base text-gray-900">Synthesizing Match Intelligence...</p>
                <p className="text-xs text-gray-500 font-medium max-w-sm mx-auto">
                  Parsing live commentary sequence, momentum swings, and play-by-play telemetry with Google Gemini.
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border-2 border-red-500 rounded-xl text-center space-y-2">
              <p className="font-bold text-red-900 text-sm">Failed to generate insights</p>
              <p className="text-xs text-red-700 font-mono">{error}</p>
              <button
                onClick={loadInsights}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg transition-all"
              >
                Try Again
              </button>
            </div>
          )}

          {!isLoading && insights && (
            <>
              {/* Tactical Summary */}
              <div className="p-4 bg-brand-blue/30 border-2 border-black rounded-xl space-y-1.5 shadow-hard-sm">
                <div className="flex items-center gap-1.5 text-xs font-black uppercase text-gray-800">
                  <span>⚡</span>
                  <span>Tactical Summary</span>
                </div>
                <p className="text-sm font-medium text-gray-900 leading-relaxed">
                  {insights.summary}
                </p>
              </div>

              {/* Momentum & Win Prob */}
              <div className="p-4 bg-white border-2 border-black rounded-xl space-y-3 shadow-hard-sm">
                <div className="flex items-center justify-between text-xs font-bold">
                  <div className="flex items-center gap-1.5">
                    <span>📊</span>
                    <span className="font-black uppercase text-gray-800">Momentum Breakdown</span>
                  </div>
                  <span className="text-xs font-black bg-brand-yellow px-2 py-0.5 rounded border border-black/20">
                    Leader: {insights.momentum.favoredTeam}
                  </span>
                </div>
                <p className="text-xs text-gray-600 font-medium">
                  {insights.momentum.description}
                </p>
                <div className="h-5 bg-gray-100 border-2 border-black rounded-lg overflow-hidden flex">
                  <div
                    className="h-full bg-brand-yellow flex items-center justify-start pl-2 font-black text-[10px] text-brand-dark truncate transition-all duration-500"
                    style={{ width: `${insights.momentum.homeWinProbability}%` }}
                  >
                    {match.homeTeam}: {insights.momentum.homeWinProbability}%
                  </div>
                  <div
                    className="h-full bg-brand-blue flex items-center justify-end pr-2 font-black text-[10px] text-brand-dark truncate transition-all duration-500"
                    style={{ width: `${insights.momentum.awayWinProbability}%` }}
                  >
                    {insights.momentum.awayWinProbability}% :{match.awayTeam}
                  </div>
                </div>
              </div>

              {/* Key Tactical Points */}
              <div className="space-y-2">
                <h4 className="text-xs font-black uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
                  <span>🎯</span>
                  <span>Key Tactical Observations</span>
                </h4>
                <div className="space-y-2">
                  {insights.keyTacticalPoints?.map((point, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-2.5 p-3 bg-gray-50 border border-black/20 rounded-xl text-xs font-medium text-gray-800"
                    >
                      <span className="w-5 h-5 bg-black text-white rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">
                        {index + 1}
                      </span>
                      <p className="leading-normal">{point}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Standout Players & Predicted Outcome */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-3 bg-gray-50 border border-black/20 rounded-xl space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-gray-500 flex items-center gap-1">
                    <span>⭐</span> Standout Performers
                  </span>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {insights.standoutPlayers?.map((player, idx) => (
                      <span
                        key={idx}
                        className="text-xs font-bold bg-white border border-black/20 px-2 py-1 rounded-md text-gray-800"
                      >
                        {player}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="p-3 bg-brand-yellow/20 border border-black/20 rounded-xl space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-gray-600 flex items-center gap-1">
                    <span>🔮</span> Predicted Outcome
                  </span>
                  <p className="text-xs font-bold text-gray-900 pt-1">
                    {insights.predictedOutcome}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-gray-50 border-t-2 border-black flex items-center justify-between">
          <span className="text-[10px] font-mono text-gray-500">
            Powered by Gemini Multi-Turn Tactical Engine
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={loadInsights}
              disabled={isLoading}
              className="px-3.5 py-1.5 bg-white hover:bg-gray-100 text-black border-2 border-black rounded-lg text-xs font-bold transition-all active:translate-y-0.5 shadow-[1px_1px_0px_0px_#18181B]"
            >
              🔄 Refresh Analysis
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-black hover:bg-gray-800 text-white border-2 border-black rounded-lg text-xs font-bold transition-all active:translate-y-0.5"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
