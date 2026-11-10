import { useSessionStore } from '../../stores/sessionStore';

export interface TransitionOverlayProps {
  count?: number;
  countdown?: number;
  nextBlockName: string;
}

export function TransitionOverlay({
  count,
  countdown,
  nextBlockName,
}: TransitionOverlayProps) {
  const skipTransition = useSessionStore((s) => s.skipTransition);
  const displayValue = count ?? countdown ?? 3;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-xs flex flex-col items-center justify-center text-white p-6">
      <p className="text-xs font-bold uppercase tracking-widest text-primary-400 mb-2">
        Up Next
      </p>
      <h2 className="text-2xl font-bold mb-6 text-center">{nextBlockName}</h2>
      <div className="w-24 h-24 rounded-full border-4 border-primary-400 flex items-center justify-center text-5xl font-extrabold font-mono animate-pulse mb-8">
        {displayValue}
      </div>
      <button
        type="button"
        onClick={skipTransition}
        className="px-5 py-2.5 bg-white/10 hover:bg-white/20 border border-white/25 rounded-xl text-xs font-bold text-white cursor-pointer transition-colors"
      >
        Skip Countdown & Start Block Now →
      </button>
    </div>
  );
}
