import React, { useEffect, useState } from 'react';

// Create a custom style tag inside the component to avoid touching index.html directly
const loadingStyles = `
  @keyframes slideUpOut {
    0% {
      transform: translateY(0);
    }
    100% {
      transform: translateY(-100%);
    }
  }
  
  .animate-slideUpOut {
    animation: slideUpOut 0.8s cubic-bezier(0.85, 0, 0.15, 1) forwards;
  }

  .loading-marquee-container {
    overflow: hidden;
    white-space: nowrap;
    position: relative;
    border-top: 4px solid #18181B;
    border-bottom: 4px solid #18181B;
    background: #BAE6FD;
  }

  @keyframes marquee {
    0% { transform: translateX(0); }
    100% { transform: translateX(-50%); }
  }

  .loading-marquee {
    display: inline-block;
    animation: marquee 15s linear infinite;
    font-weight: 900;
    text-transform: uppercase;
    font-size: 2rem;
    padding: 0.5rem 0;
  }
`;

interface LoadingScreenProps {
  isLoading: boolean;
  onComplete: () => void;
}

export const LoadingScreen: React.FC<LoadingScreenProps> = ({ isLoading, onComplete }) => {
  const [progress, setProgress] = useState(0);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    if (isLoading) {
      // Logic: Fake the loading buffer to handle a 2 minute cold start nicely without staring at 0%
      // We want the loading to take roughly 10 seconds total (if actual data takes that long).
      // We run at a 100ms interval (100 ticks in 10 seconds)
      interval = setInterval(() => {
        setProgress(prev => {
          if (prev < 80) {
            // From 0 to 80 takes ~60 ticks (~6 seconds) -> average +1.3 per tick
            return prev + (Math.random() > 0.3 ? 2 : 1);
          } else if (prev < 99) {
            // From 80 to 99 takes ~40 ticks (~4 seconds) -> average +0.5 per tick
            return prev + (Math.random() > 0.5 ? 1 : 0);
          }
          return prev;
        });
      }, 100); 
    } else {
      // Actual data has loaded!
      setProgress(100);
      
      // Delay to let the user see 100%, then trigger exit animation
      setTimeout(() => {
        setIsAnimatingOut(true);
        // Delay to let animation finish before unmounting
        setTimeout(() => {
          onComplete();
        }, 800);
      }, 500);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isLoading, onComplete]);

  return (
    <>
      <style>{loadingStyles}</style>
      <div 
        className={`fixed inset-0 z-50 flex flex-col bg-brand-yellow font-sans ${isAnimatingOut ? 'animate-slideUpOut' : ''}`}
      >
        {/* Top Header */}
        <div className="p-8 flex justify-between items-center border-b-4 border-black">
          <div className="flex items-center gap-4">
            <div className="text-5xl animate-bounce leading-none drop-shadow-md pb-1">⚽</div>
            <h1 className="text-4xl font-black tracking-tight text-brand-dark mb-1 uppercase">
              Sportz
            </h1>
          </div>
          <div className="text-right">
            <p className="text-xl font-bold uppercase tracking-widest bg-white border-4 border-black px-4 py-2 shadow-hard">
              System Boot
            </p>
          </div>
        </div>

        {/* Main Center Content */}
        <div className="flex-1 flex flex-col justify-center items-center px-8 relative">
          <div className="w-full max-w-5xl mx-auto flex flex-col items-center gap-12">
            
            {/* The Percentage text */}
            <div className="relative inline-block border-8 border-black bg-white shadow-hard flex flex-col items-center justify-center rounded-3xl" style={{ width: '400px', height: '400px' }}>
              <span className="text-9xl md:text-[12rem] font-black tracking-tighter text-black tabular-nums">
                {progress}
              </span>
              <span className="text-4xl font-bold absolute bottom-8 right-12">%</span>
            </div>

            {/* Progress Bar Container */}
            <div className="w-full max-w-2xl bg-white border-4 border-black h-12 shadow-hard-sm p-1 rounded-full overflow-hidden">
              <div 
                className="h-full bg-black rounded-full transition-all duration-300 ease-out flex items-center justify-end px-2"
                style={{ width: progress + '%' }}
              >
                  {progress > 5 && (
                    <div className="w-4 h-4 bg-brand-yellow rounded-full animate-pulse"></div>
                  )}
              </div>
            </div>

            <p className="text-xl font-medium uppercase tracking-widest text-black flex items-center gap-3">
              <span className="w-3 h-3 bg-red-500 rounded-full animate-ping"></span>
              {progress < 100 ? 'Waking up the backend servers...' : 'Systems ready!'}
            </p>
          </div>
        </div>

        {/* Bottom Marquee */}
        <div className="loading-marquee-container flex items-center">
           <div className="loading-marquee">
              MATCH DATA ESTABLISHED • WAKING DROplets • CALIBRATING WEBSOCKETS • CONTACTING REFEREE • INITIATING 0-100 DRILL • RETRIEVING LIVE SCORES • PREPARING PITCH •
              MATCH DATA ESTABLISHED • WAKING DROplets • CALIBRATING WEBSOCKETS • CONTACTING REFEREE • INITIATING 0-100 DRILL • RETRIEVING LIVE SCORES • PREPARING PITCH •
           </div>
        </div>
      </div>
    </>
  );
};
