import React, { useEffect, useMemo, useState } from 'react';
import { useMatchData } from './hooks/useMatchData';
import { MatchCard } from './components/MatchCard';
import { LiveFeed } from './components/LiveFeed';
import { StatusIndicator } from './components/StatusIndicator';
import { LoadingScreen } from './components/LoadingScreen';
import { EventSimulatorModal } from './components/EventSimulatorModal';
import { AiAnalystModal } from './components/AiAnalystModal';
import { WinProbabilityMeter } from './components/WinProbabilityMeter';
import { FanReactions } from './components/FanReactions';
import { isSoundEnabled, setSoundEnabled } from './services/soundEffects';
import { postCommentary, updateMatchScore } from './services/api';

const App: React.FC = () => {
  const pageSize = 6;
  const [currentPage, setCurrentPage] = useState(1);
  const [showLoadingScreen, setShowLoadingScreen] = useState(true);
  const [selectedSport, setSelectedSport] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [soundOn, setSoundOn] = useState<boolean>(() => isSoundEnabled());
  const [isAutoSim, setIsAutoSim] = useState(false);

  const {
    matches,
    isLoading,
    error,
    commentary,
    isCommentaryLoading,
    wsError,
    status,
    activeMatchId,
    newMatchesCount,
    reactions,
    recentReaction,
    sendReaction,
    dismissNewMatches,
    watchMatch,
    unwatchMatch,
    reloadMatches,
  } = useMatchData();

  const activeMatch = useMemo(() => {
    // eslint-disable-next-line eqeqeq
    return matches.find((m) => m.id == activeMatchId) || null;
  }, [matches, activeMatchId]);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundEnabled(next);
  };

  // Autonomous Live Simulation Ticker
  useEffect(() => {
    if (!isAutoSim || matches.length === 0) return;

    const interval = setInterval(async () => {
      // Pick target match: active match first, or a live match, or random match
      // eslint-disable-next-line eqeqeq
      const targetMatch = (activeMatchId ? matches.find(m => m.id == activeMatchId) : null)
        || matches.find(m => m.status.toLowerCase() === 'live')
        || matches[Math.floor(Math.random() * matches.length)];

      if (!targetMatch) return;

      const sport = targetMatch.sport.toLowerCase();
      const isHomeTeamAction = Math.random() > 0.45;
      const actingTeam = isHomeTeamAction ? targetMatch.homeTeam : targetMatch.awayTeam;

      try {
        if (sport.includes('football') || sport.includes('soccer')) {
          const events = [
            { type: 'goal', message: `GOAL! ${actingTeam} scores a sensational strike into the top corner!`, isScore: true },
            { type: 'shot', message: `Close! ${actingTeam} unleashes a ferocious long-range strike that rattles the crossbar.`, isScore: false },
            { type: 'foul', message: `Tactical foul committed in the center circle by ${actingTeam}.`, isScore: false },
            { type: 'card', message: `Yellow card brandished to ${actingTeam} defender after stopping a counter-attack.`, isScore: false },
            { type: 'corner', message: `${actingTeam} forces a corner after a deflected cross.`, isScore: false },
          ];
          const event = events[Math.floor(Math.random() * events.length)];
          const min = Math.floor(Math.random() * 90) + 1;

          await postCommentary(targetMatch.id, {
            message: event.message,
            eventType: event.type,
            team: actingTeam,
            minute: min,
            actor: `${actingTeam} Playmaker`,
          });

          if (event.isScore) {
            const nextHome = isHomeTeamAction ? targetMatch.homeScore + 1 : targetMatch.homeScore;
            const nextAway = !isHomeTeamAction ? targetMatch.awayScore + 1 : targetMatch.awayScore;
            await updateMatchScore(targetMatch.id, nextHome, nextAway);
          }
        } else if (sport.includes('cricket')) {
          const events = [
            { type: 'six', message: `SIX! Massive blow deep into the grandstand by ${actingTeam}!`, runs: 6 },
            { type: 'four', message: `FOUR! Cracking cover drive finds the fence for ${actingTeam}!`, runs: 4 },
            { type: 'wicket', message: `WICKET! Clean bowled! Middle stump uprooted for ${actingTeam}!`, runs: 0 },
            { type: 'single', message: `Quick single pushed into the gap on the onside by ${actingTeam}.`, runs: 1 },
          ];
          const event = events[Math.floor(Math.random() * events.length)];
          await postCommentary(targetMatch.id, {
            message: event.message,
            eventType: event.type,
            team: actingTeam,
            actor: `${actingTeam} Batter`,
          });

          if (event.runs > 0) {
            const nextHome = isHomeTeamAction ? targetMatch.homeScore + event.runs : targetMatch.homeScore;
            const nextAway = !isHomeTeamAction ? targetMatch.awayScore + event.runs : targetMatch.awayScore;
            await updateMatchScore(targetMatch.id, nextHome, nextAway);
          }
        } else {
          // Basketball
          const events = [
            { type: 'three-pointer', message: `From downtown! 3-pointer drained with authority by ${actingTeam}!`, pts: 3 },
            { type: 'dunk', message: `Vicious two-handed slam dunk in transition for ${actingTeam}!`, pts: 2 },
            { type: 'foul', message: `Shooting foul drawn on the drive by ${actingTeam}.`, pts: 1 },
          ];
          const event = events[Math.floor(Math.random() * events.length)];
          await postCommentary(targetMatch.id, {
            message: event.message,
            eventType: event.type,
            team: actingTeam,
            actor: `${actingTeam} Guard`,
          });

          const nextHome = isHomeTeamAction ? targetMatch.homeScore + event.pts : targetMatch.homeScore;
          const nextAway = !isHomeTeamAction ? targetMatch.awayScore + event.pts : targetMatch.awayScore;
          await updateMatchScore(targetMatch.id, nextHome, nextAway);
        }
      } catch (err) {
        console.warn('[AutoSim] Event trigger error:', err);
      }
    }, 6000);

    return () => clearInterval(interval);
  }, [isAutoSim, matches, activeMatchId]);

  // Filter matches based on sport, status, and search query
  const filteredMatches = useMemo(() => {
    return matches.filter((m) => {
      // Sport filter
      if (selectedSport !== 'all' && !m.sport.toLowerCase().includes(selectedSport.toLowerCase())) {
        return false;
      }
      // Status filter
      if (selectedStatus !== 'all' && m.status.toLowerCase() !== selectedStatus.toLowerCase()) {
        return false;
      }
      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const text = `${m.homeTeam} ${m.awayTeam} ${m.sport}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }, [matches, selectedSport, selectedStatus, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredMatches.length / pageSize));

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const pagedMatches = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return filteredMatches.slice(startIndex, startIndex + pageSize);
  }, [filteredMatches, currentPage, pageSize]);

  return (
    <>
      {showLoadingScreen && (
        <LoadingScreen 
          isLoading={isLoading} 
          onComplete={() => setShowLoadingScreen(false)} 
        />
      )}

      {/* Simulator Modal */}
      <EventSimulatorModal
        isOpen={isSimulatorOpen}
        onClose={() => setIsSimulatorOpen(false)}
        matches={matches}
        selectedMatchId={activeMatchId}
        onMatchSelect={(id) => watchMatch(id)}
      />

      {/* AI Analyst Modal */}
      <AiAnalystModal
        isOpen={isAiModalOpen}
        onClose={() => setIsAiModalOpen(false)}
        match={activeMatch || (matches.length > 0 ? matches[0] : null)}
      />

      <div className="min-h-screen p-4 md:p-8 font-sans">
        <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header Section */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-brand-yellow border-2 border-black rounded-2xl p-6 shadow-hard">
          <div className="flex items-center gap-4">
            <div className="text-5xl animate-bounce leading-none drop-shadow-md pb-1">⚽</div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-black tracking-tight text-brand-dark">
                  Sportz
                </h1>
                <span className="text-[10px] font-mono font-bold bg-white text-black border border-black px-2 py-0.5 rounded-full shadow-hard-sm">
                  v2.0 Real-Time + AI
                </span>
              </div>
              <p className="text-sm font-medium opacity-80">Full-Duplex Sports Telemetry & AI Analytics Dashboard</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Auto Sim Button */}
            <button
              onClick={() => setIsAutoSim(!isAutoSim)}
              title="Autonomously fire live match events every 6s"
              className={`
                flex items-center gap-1.5 border-2 border-black rounded-xl font-black text-xs px-3.5 py-2 transition-all active:translate-y-0.5 shadow-hard-sm
                ${isAutoSim ? 'bg-red-500 text-white animate-pulse' : 'bg-white hover:bg-gray-100 text-black'}
              `}
            >
              <span>{isAutoSim ? '🔴' : '▶'}</span>
              <span>{isAutoSim ? 'Auto-Sim: Active' : 'Auto-Sim Demo'}</span>
            </button>

            {/* Sound FX Toggle */}
            <button
              onClick={toggleSound}
              title={soundOn ? 'Sound Effects Enabled' : 'Sound Effects Muted'}
              className="flex items-center gap-1.5 bg-white hover:bg-gray-100 text-black border-2 border-black rounded-xl font-black text-xs px-3 py-2 shadow-hard-sm transition-all active:translate-y-0.5"
            >
              <span>{soundOn ? '🔊' : '🔇'}</span>
              <span>{soundOn ? 'Sound: ON' : 'Sound: OFF'}</span>
            </button>

            {/* Manual Simulator Button */}
            <button
              onClick={() => setIsSimulatorOpen(true)}
              className="flex items-center gap-1.5 bg-white hover:bg-gray-100 text-black border-2 border-black rounded-xl font-black text-xs px-3.5 py-2 shadow-hard-sm transition-all active:translate-y-0.5"
            >
              <span>⚡</span>
              <span>Simulate</span>
            </button>

            {/* AI Analyst Button */}
            <button
              onClick={() => setIsAiModalOpen(true)}
              className="flex items-center gap-1.5 bg-brand-blue hover:bg-blue-200 text-black border-2 border-black rounded-xl font-black text-xs px-3.5 py-2 shadow-hard-sm transition-all active:translate-y-0.5"
            >
              <span>🤖</span>
              <span>AI Analyst</span>
            </button>

            <div className="flex flex-col items-end gap-1">
              <StatusIndicator status={status} />
              {wsError && (
                <span className="text-[10px] font-mono bg-red-100 text-red-700 border border-red-200 px-1.5 py-0.5 rounded">
                  WS: {wsError}
                </span>
              )}
            </div>
          </div>
        </header>

        {/* Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Left Column: Match List & Controls */}
          <main className="lg:col-span-2 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold border-l-4 border-brand-blue pl-3">Current Matches</h2>
                <span className="text-xs font-mono bg-black text-white px-2.5 py-1 rounded-full font-bold">
                  {isLoading ? '...' : filteredMatches.length}
                </span>
              </div>

              {/* Status Tabs */}
              <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-xl border border-black/10 text-xs font-bold">
                {[
                  { id: 'all', label: 'All' },
                  { id: 'live', label: '🔴 Live' },
                  { id: 'scheduled', label: 'Scheduled' },
                  { id: 'finished', label: 'Finished' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => { setSelectedStatus(tab.id); setCurrentPage(1); }}
                    className={`
                      px-2.5 py-1 rounded-lg transition-all
                      ${selectedStatus === tab.id ? 'bg-white text-black shadow-sm' : 'text-gray-500 hover:text-black'}
                    `}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Filters Bar: Sports & Search */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 rounded-xl border-2 border-black shadow-hard-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'all', label: 'All Sports' },
                  { id: 'football', label: '⚽ Football' },
                  { id: 'cricket', label: '🏏 Cricket' },
                  { id: 'basketball', label: '🏀 Basketball' },
                ].map((sport) => (
                  <button
                    key={sport.id}
                    onClick={() => { setSelectedSport(sport.id); setCurrentPage(1); }}
                    className={`
                      px-3 py-1 rounded-full text-xs font-bold border transition-all
                      ${selectedSport === sport.id 
                        ? 'bg-brand-yellow border-black text-black shadow-sm' 
                        : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'}
                    `}
                  >
                    {sport.label}
                  </button>
                ))}
              </div>

              {/* Search input */}
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                  placeholder="Search team or sport..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs font-medium bg-gray-50 border border-black/20 rounded-lg focus:outline-none focus:ring-1 focus:ring-black"
                />
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                  🔍
                </span>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-black text-xs font-bold"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {newMatchesCount > 0 && (
              <div className="flex items-center justify-between gap-3 bg-brand-yellow border-2 border-black rounded-xl px-4 py-3 shadow-hard-sm">
                <span className="text-sm font-bold">
                  {newMatchesCount} new match{newMatchesCount > 1 ? 'es' : ''} added
                </span>
                <button
                  onClick={dismissNewMatches}
                  className="px-3 py-1 rounded-full text-xs font-bold border-2 border-black bg-white hover:bg-gray-50 transition-all"
                >
                  Dismiss
                </button>
              </div>
            )}

            {!showLoadingScreen && isLoading && (
              <div className="p-12 text-center border-2 border-dashed border-gray-300 rounded-2xl">
                <div className="animate-spin w-8 h-8 border-4 border-brand-yellow border-t-black rounded-full mx-auto mb-4"></div>
                <p className="font-medium text-gray-500">Loading matches...</p>
              </div>
            )}

            {error && (
               <div className="bg-red-50 border-2 border-red-500 text-red-900 p-6 rounded-xl text-center shadow-sm">
                  <div className="flex justify-center mb-3 text-red-500">
                    <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                  </div>
                  <h3 className="text-lg font-bold mb-1">Connection Error</h3>
                  <p className="font-mono text-sm bg-red-100 py-1 px-2 rounded inline-block mb-4 border border-red-200">{error}</p>
                  <p className="text-sm opacity-80 mb-6 max-w-md mx-auto">
                    The application could not reach the API. Please ensure the API server is online and accessible.
                  </p>
                  <button 
                    onClick={reloadMatches}
                    className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold text-sm transition-all shadow-md active:translate-y-0.5"
                  >
                    Retry Connection
                  </button>
               </div>
            )}

            {!isLoading && !error && filteredMatches.length === 0 && (
              <div className="p-12 text-center border-2 border-black rounded-2xl bg-gray-50">
                <p className="font-bold text-lg mb-1">No matches found</p>
                <p className="text-sm text-gray-500 mb-4">Try clearing your search query or sport filter.</p>
                <button
                  onClick={() => { setSelectedSport('all'); setSelectedStatus('all'); setSearchQuery(''); }}
                  className="px-4 py-1.5 bg-black text-white text-xs font-bold rounded-lg"
                >
                  Reset Filters
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {pagedMatches.map((match) => (
                <MatchCard 
                  key={match.id} 
                  match={match} 
                  // eslint-disable-next-line eqeqeq
                  isActive={activeMatchId == match.id}
                  onWatch={watchMatch}
                  onUnwatch={unwatchMatch}
                />
              ))}
            </div>

            {!isLoading && !error && filteredMatches.length > pageSize && (
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <span className="text-xs font-medium text-gray-500">
                  Page {currentPage} of {totalPages}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                    className={`
                      px-3 py-1.5 rounded-lg text-xs font-bold border-2 border-black transition-all
                      ${currentPage === 1 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white hover:bg-gray-50'}
                    `}
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                    className={`
                      px-3 py-1.5 rounded-lg text-xs font-bold border-2 border-black transition-all
                      ${currentPage === totalPages ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white hover:bg-gray-50'}
                    `}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </main>

          {/* Right Column: Live Feed & Telemetry (Sticky on Desktop) */}
          <aside className="lg:col-span-1 space-y-4 lg:sticky lg:top-8">
            {/* Live Win Probability & Momentum */}
            {activeMatch && (
              <WinProbabilityMeter
                homeTeam={activeMatch.homeTeam}
                awayTeam={activeMatch.awayTeam}
                homeScore={activeMatch.homeScore}
                awayScore={activeMatch.awayScore}
                status={activeMatch.status}
              />
            )}

            {/* Fan Reactions Bar */}
            {activeMatch && (
              <FanReactions
                reactions={reactions}
                recentReaction={recentReaction}
                onReact={sendReaction}
              />
            )}

            {/* Live Commentary Feed */}
            <div className="h-[460px] lg:h-[calc(100vh-380px)]">
              <LiveFeed 
                messages={commentary} 
                isActive={!!activeMatchId} 
                isLoading={isCommentaryLoading} 
              />
            </div>
          </aside>

        </div>

        {/* Footer */}
        <footer className="mt-12 border-t-2 border-gray-200 pt-8 pb-6 text-center text-sm text-gray-500 font-medium">
          <p>Powered by Node.js, Express, WebSockets, Google Gemini 3.8 Flash, and Neon PostgreSQL.</p>
          <p className="mt-1">Real-time bi-directional telemetry secured by Arcjet.</p>
        </footer>
      </div>
    </div>
    </>
  );
};

export default App;
