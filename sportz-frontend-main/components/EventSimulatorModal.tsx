import React, { useState } from 'react';
import { Match } from '../types';
import { updateMatchScore, postCommentary } from '../services/api';

interface EventSimulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  matches: Match[];
  selectedMatchId?: string | number | null;
  onMatchSelect?: (id: string | number) => void;
}

export const EventSimulatorModal: React.FC<EventSimulatorModalProps> = ({
  isOpen,
  onClose,
  matches,
  selectedMatchId,
  onMatchSelect,
}) => {
  const [activeId, setActiveId] = useState<string | number>(
    selectedMatchId || (matches[0]?.id ?? '')
  );
  const [customMessage, setCustomMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentMatch = matches.find((m) => String(m.id) === String(activeId)) || matches[0];

  const showNotification = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => {
      setSuccessToast(null);
    }, 3000);
  };

  const handleScoreEvent = async (team: 'home' | 'away', points: number, eventType: string, label: string) => {
    if (!currentMatch) return;
    setIsSubmitting(true);
    try {
      const nextHome = team === 'home' ? currentMatch.homeScore + points : currentMatch.homeScore;
      const nextAway = team === 'away' ? currentMatch.awayScore + points : currentMatch.awayScore;
      const teamName = team === 'home' ? currentMatch.homeTeam : currentMatch.awayTeam;

      // 1. Update match score in DB and broadcast via WebSockets
      await updateMatchScore(currentMatch.id, nextHome, nextAway);

      // 2. Post commentary entry
      await postCommentary(currentMatch.id, {
        message: `${label} by ${teamName}! Score is now ${nextHome} - ${nextAway}.`,
        minute: Math.floor(Math.random() * 80) + 10,
        eventType,
        team: teamName,
      });

      showNotification(`⚡ ${label} (${teamName}) broadcasted!`);
      if (onMatchSelect) {
        onMatchSelect(currentMatch.id);
      }
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'Failed to trigger event';
      alert(`Error: ${msg}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCustomCommentary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentMatch || !customMessage.trim()) return;
    setIsSubmitting(true);
    try {
      await postCommentary(currentMatch.id, {
        message: customMessage.trim(),
        minute: Math.floor(Math.random() * 85) + 5,
        eventType: 'commentary',
      });
      setCustomMessage('');
      showNotification(`📣 Commentary broadcasted to live feed!`);
      if (onMatchSelect) {
        onMatchSelect(currentMatch.id);
      }
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'Failed to post commentary';
      alert(`Error: ${msg}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-xl bg-white border-2 border-black rounded-2xl shadow-hard overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 bg-brand-yellow border-b-2 border-black">
          <div className="flex items-center gap-2">
            <span className="text-2xl animate-pulse">⚡</span>
            <div>
              <h2 className="text-xl font-black text-brand-dark">Event Simulator</h2>
              <p className="text-xs font-semibold opacity-75">Simulate live match events & test real-time WebSockets</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full border-2 border-black bg-white hover:bg-gray-100 flex items-center justify-center font-bold text-sm"
          >
            ✕
          </button>
        </div>

        {/* Toast feedback */}
        {successToast && (
          <div className="bg-emerald-500 text-white text-xs font-bold px-4 py-2 text-center animate-in slide-in-from-top-2 duration-200">
            {successToast}
          </div>
        )}

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Target match picker */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-700 mb-2">
              Select Target Match
            </label>
            <select
              value={currentMatch?.id || ''}
              onChange={(e) => setActiveId(e.target.value)}
              className="w-full p-3 bg-gray-50 border-2 border-black rounded-xl font-bold text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue"
            >
              {matches.map((m) => (
                <option key={m.id} value={m.id}>
                  [{m.sport.toUpperCase()}] {m.homeTeam} vs {m.awayTeam} ({m.homeScore} - {m.awayScore})
                </option>
              ))}
            </select>
          </div>

          {currentMatch && (
            <>
              {/* Match Card Preview */}
              <div className="p-4 bg-gray-50 border-2 border-black rounded-xl flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-gray-500 uppercase">{currentMatch.sport}</span>
                  <p className="font-extrabold text-base text-brand-dark">
                    {currentMatch.homeTeam} vs {currentMatch.awayTeam}
                  </p>
                </div>
                <div className="text-2xl font-black font-mono bg-white px-3 py-1 rounded-lg border border-black shadow-hard-sm">
                  {currentMatch.homeScore} - {currentMatch.awayScore}
                </div>
              </div>

              {/* Quick Actions Grid */}
              <div className="space-y-3">
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-700">
                  Quick Event Triggers
                </label>

                {/* Football / General Actions */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={isSubmitting}
                    onClick={() => handleScoreEvent('home', 1, 'goal', '⚽ GOAL')}
                    className="p-3 bg-emerald-100 hover:bg-emerald-200 border-2 border-black rounded-xl font-bold text-xs text-emerald-950 transition-all active:translate-y-0.5"
                  >
                    ⚽ Goal ({currentMatch.homeTeam})
                  </button>
                  <button
                    disabled={isSubmitting}
                    onClick={() => handleScoreEvent('away', 1, 'goal', '⚽ GOAL')}
                    className="p-3 bg-emerald-100 hover:bg-emerald-200 border-2 border-black rounded-xl font-bold text-xs text-emerald-950 transition-all active:translate-y-0.5"
                  >
                    ⚽ Goal ({currentMatch.awayTeam})
                  </button>
                </div>

                {/* Cricket Actions */}
                <div className="grid grid-cols-3 gap-2">
                  <button
                    disabled={isSubmitting}
                    onClick={() => handleScoreEvent('home', 4, 'four', '⚡ FOUR')}
                    className="p-2.5 bg-blue-100 hover:bg-blue-200 border-2 border-black rounded-xl font-bold text-xs text-blue-950 transition-all active:translate-y-0.5"
                  >
                    🏏 Boundary (+4)
                  </button>
                  <button
                    disabled={isSubmitting}
                    onClick={() => handleScoreEvent('home', 6, 'six', '💥 SIX')}
                    className="p-2.5 bg-purple-100 hover:bg-purple-200 border-2 border-black rounded-xl font-bold text-xs text-purple-950 transition-all active:translate-y-0.5"
                  >
                    💥 Maximum (+6)
                  </button>
                  <button
                    disabled={isSubmitting}
                    onClick={() => handleScoreEvent('home', 0, 'wicket', '🔴 WICKET')}
                    className="p-2.5 bg-rose-100 hover:bg-rose-200 border-2 border-black rounded-xl font-bold text-xs text-rose-950 transition-all active:translate-y-0.5"
                  >
                    🔴 Wicket!
                  </button>
                </div>

                {/* Basketball Actions */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={isSubmitting}
                    onClick={() => handleScoreEvent('home', 3, 'points', '🏀 3-POINTER')}
                    className="p-2.5 bg-amber-100 hover:bg-amber-200 border-2 border-black rounded-xl font-bold text-xs text-amber-950 transition-all active:translate-y-0.5"
                  >
                    🏀 3-Pointer (+3)
                  </button>
                  <button
                    disabled={isSubmitting}
                    onClick={() => handleScoreEvent('away', 2, 'points', '🏀 DUNK')}
                    className="p-2.5 bg-amber-100 hover:bg-amber-200 border-2 border-black rounded-xl font-bold text-xs text-amber-950 transition-all active:translate-y-0.5"
                  >
                    🏀 Slam Dunk (+2)
                  </button>
                </div>
              </div>

              {/* Custom Commentary Message */}
              <form onSubmit={handleCustomCommentary} className="space-y-2 pt-2 border-t-2 border-dashed border-gray-200">
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-700">
                  Dispatch Custom Commentary
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customMessage}
                    onChange={(e) => setCustomMessage(e.target.value)}
                    placeholder="e.g. Stunning save by the goalkeeper!"
                    className="flex-1 p-2.5 text-sm bg-gray-50 border-2 border-black rounded-xl font-medium focus:outline-none focus:ring-2 focus:ring-brand-blue"
                  />
                  <button
                    type="submit"
                    disabled={isSubmitting || !customMessage.trim()}
                    className="px-5 py-2.5 bg-black text-white hover:bg-gray-800 disabled:opacity-50 font-bold text-xs rounded-xl border-2 border-black transition-all active:translate-y-0.5"
                  >
                    Broadcast
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
