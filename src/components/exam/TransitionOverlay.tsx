/**
 * TransitionOverlay — Full-screen 3-2-1 countdown between blocks.
 * Fixed overlay, no interaction with block UI underneath until dismissed.
 */
interface TransitionOverlayProps {
  count: number
  nextBlockName?: string
}

export function TransitionOverlay({ count, nextBlockName }: TransitionOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/80 flex flex-col items-center justify-center">
      <p className="text-white/60 text-sm font-medium mb-4 uppercase tracking-widest">
        Next up
      </p>
      {nextBlockName && (
        <p className="text-white text-xl font-semibold mb-8">{nextBlockName}</p>
      )}
      <div
        key={count} // remount on each count change to re-trigger animation
        className="countdown-number text-white font-black"
        style={{ fontSize: '8rem', lineHeight: 1 }}
      >
        {count}
      </div>
      <p className="text-white/40 text-sm mt-8">Starting automatically…</p>
    </div>
  )
}

