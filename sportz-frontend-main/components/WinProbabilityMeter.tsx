import React, { useMemo } from 'react';

interface WinProbabilityMeterProps {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: string;
  customProbabilities?: {
    home: number;
    away: number;
  };
}

export const WinProbabilityMeter: React.FC<WinProbabilityMeterProps> = ({
  homeTeam,
  awayTeam,
  homeScore,
  awayScore,
  status,
  customProbabilities,
}) => {
  const { homeProb, awayProb, leaderText } = useMemo(() => {
    if (customProbabilities) {
      const h = Math.max(5, Math.min(95, Math.round(customProbabilities.home)));
      const a = 100 - h;
      let leader = 'Balanced';
      if (h > a) leader = `${homeTeam} favored (${h}%)`;
      else if (a > h) leader = `${awayTeam} favored (${a}%)`;
      return { homeProb: h, awayProb: a, leaderText: leader };
    }

    const isFinished = status.toLowerCase() === 'finished';
    const diff = (homeScore || 0) - (awayScore || 0);

    if (isFinished) {
      if (diff > 0) return { homeProb: 100, awayProb: 0, leaderText: `${homeTeam} Won` };
      if (diff < 0) return { homeProb: 0, awayProb: 100, leaderText: `${awayTeam} Won` };
      return { homeProb: 50, awayProb: 50, leaderText: 'Ended in Draw' };
    }

    if (diff === 0) {
      return { homeProb: 50, awayProb: 50, leaderText: 'Evenly poised' };
    }

    let h = 50 + diff * 14;
    h = Math.max(10, Math.min(90, Math.round(h)));
    const a = 100 - h;
    const leader = diff > 0 ? `${homeTeam} in control (+${diff})` : `${awayTeam} in control (+${Math.abs(diff)})`;

    return { homeProb: h, awayProb: a, leaderText: leader };
  }, [homeTeam, awayTeam, homeScore, awayScore, status, customProbabilities]);

  return (
    <div className="bg-white border-2 border-black rounded-xl p-3 shadow-hard-sm space-y-2">
      <div className="flex items-center justify-between text-xs font-bold">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">📈</span>
          <span className="font-black tracking-wide uppercase text-gray-800">
            Win Probability
          </span>
        </div>
        <span className="text-[11px] font-mono font-bold bg-brand-yellow px-2 py-0.5 rounded border border-black/20">
          {leaderText}
        </span>
      </div>

      {/* Progress Bar */}
      <div className="relative h-6 bg-gray-100 border-2 border-black rounded-lg overflow-hidden flex">
        <div
          className="h-full bg-brand-yellow flex items-center justify-start pl-2 transition-all duration-700 ease-out font-black text-[11px] text-brand-dark truncate"
          style={{ width: `${homeProb}%` }}
        >
          {homeProb >= 20 && `${homeProb}%`}
        </div>
        <div
          className="h-full bg-brand-blue flex items-center justify-end pr-2 transition-all duration-700 ease-out font-black text-[11px] text-brand-dark truncate"
          style={{ width: `${awayProb}%` }}
        >
          {awayProb >= 20 && `${awayProb}%`}
        </div>
      </div>

      {/* Team Labels */}
      <div className="flex justify-between items-center text-[11px] font-bold text-gray-700 px-0.5">
        <span className="truncate max-w-[45%]">
          {homeTeam} ({homeProb}%)
        </span>
        <span className="truncate max-w-[45%] text-right">
          ({awayProb}%) {awayTeam}
        </span>
      </div>
    </div>
  );
};
