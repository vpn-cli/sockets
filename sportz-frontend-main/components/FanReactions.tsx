import React, { useEffect, useState } from 'react';
import { ReactionCounts } from '../types';

interface FanReactionsProps {
  reactions: ReactionCounts;
  recentReaction: { emoji: string; id: number } | null;
  onReact: (emoji: string) => void;
  disabled?: boolean;
}

interface FloatingEmoji {
  id: number;
  emoji: string;
  leftPercent: number;
}

const EMOJI_OPTIONS = [
  { emoji: '🔥', label: 'Fire' },
  { emoji: '👏', label: 'Clap' },
  { emoji: '⚡', label: 'Hype' },
  { emoji: '❤️', label: 'Love' },
  { emoji: '⚽', label: 'Goal' },
  { emoji: '🎯', label: 'Spot on' },
];

export const FanReactions: React.FC<FanReactionsProps> = ({
  reactions,
  recentReaction,
  onReact,
  disabled = false,
}) => {
  const [floatingEmojis, setFloatingEmojis] = useState<FloatingEmoji[]>([]);

  useEffect(() => {
    if (!recentReaction) return;

    const newFloat: FloatingEmoji = {
      id: recentReaction.id,
      emoji: recentReaction.emoji,
      leftPercent: 15 + Math.random() * 70,
    };

    setFloatingEmojis((prev) => [...prev.slice(-15), newFloat]);

    const timer = setTimeout(() => {
      setFloatingEmojis((prev) => prev.filter((item) => item.id !== newFloat.id));
    }, 1800);

    return () => clearTimeout(timer);
  }, [recentReaction]);

  return (
    <div className="relative bg-white border-2 border-black rounded-xl p-3 shadow-hard-sm">
      {/* Floating Emoji Canvas */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
        {floatingEmojis.map((item) => (
          <span
            key={item.id}
            className="absolute bottom-4 text-2xl font-bold animate-float-up drop-shadow-md select-none"
            style={{
              left: `${item.leftPercent}%`,
              animation: 'floatUp 1.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards',
            }}
          >
            {item.emoji}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">📣</span>
          <span className="text-xs font-black tracking-wide uppercase text-gray-800">
            Live Fan Reactions
          </span>
        </div>
        <span className="text-[10px] font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full border border-black/10">
          Syncs Real-Time
        </span>
      </div>

      {/* Buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {EMOJI_OPTIONS.map(({ emoji, label }) => {
          const count = reactions[emoji] || 0;
          return (
            <button
              key={emoji}
              onClick={() => onReact(emoji)}
              disabled={disabled}
              title={`React with ${label}`}
              className={`
                flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-50 hover:bg-brand-yellow/30 
                border-2 border-black rounded-lg text-xs font-bold transition-all 
                active:translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed
                shadow-[1px_1px_0px_0px_#18181B]
              `}
            >
              <span className="text-sm leading-none">{emoji}</span>
              <span className="font-mono text-[11px] text-gray-800 font-black">
                {count > 0 ? count : ''}
              </span>
            </button>
          );
        })}
      </div>

      <style>{`
        @keyframes floatUp {
          0% {
            transform: translateY(0) scale(0.7);
            opacity: 1;
          }
          70% {
            opacity: 0.9;
          }
          100% {
            transform: translateY(-80px) scale(1.4);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
};
