import { useEffect, useRef, useCallback } from 'react'
import { useSessionStore, selectCurrentBlock, selectBlockTimeRemaining, selectOverallProgress, selectBlockProgress, selectIsLastBlock } from '../../stores/sessionStore'
import { TimerEngine } from '../../utils/timer'
import { formatTime } from '../../utils/helpers'
import { BlockInputRouter } from './BlockInputRouter'
import { TransitionOverlay } from './TransitionOverlay'

/**
 * SessionRunner — The main in-session exam UI.
 *
 * Layout:
 *   - Sticky header: segmented progress bar + overall clock
 *   - Block header: name, instructions, block timer
 *   - Main area: block input component (varies by type)
 *   - Footer: "I'm done" / pause controls
 */
export function SessionRunner() {
  const isRunning = useSessionStore((s) => s.isRunning)
  const isPaused = useSessionStore((s) => s.isPaused)
  const transitionCountdown = useSessionStore((s) => s.transitionCountdown)
  const overallElapsedSec = useSessionStore((s) => s.overallElapsedSec)
  const currentBlockIndex = useSessionStore((s) => s.currentBlockIndex)
  const activeRun = useSessionStore((s) => s.activeRun)

  const tick = useSessionStore((s) => s.tick)
  const pauseSession = useSessionStore((s) => s.pauseSession)
  const resumeRunning = useSessionStore((s) => s.resumeRunning)
  const advanceBlock = useSessionStore((s) => s.advanceBlock)
  const abandonSession = useSessionStore((s) => s.abandonSession)

  // Selector-based subscriptions — only re-render what's needed
  const currentBlock = useSessionStore(selectCurrentBlock)
  const blockTimeRemaining = useSessionStore(selectBlockTimeRemaining)
  const overallProgress = useSessionStore(selectOverallProgress)
  const blockProgress = useSessionStore(selectBlockProgress)
  const isLastBlock = useSessionStore(selectIsLastBlock)

  // Start the interval timer
  const timerRef = useRef<TimerEngine | null>(null)

  useEffect(() => {
    timerRef.current = new TimerEngine(tick, 1000)
    timerRef.current.start()
    return () => timerRef.current?.stop()
  }, [tick])

  // Pause/resume the interval when isPaused changes
  useEffect(() => {
    if (!timerRef.current) return
    if (isPaused) {
      timerRef.current.stop()
    } else if (isRunning) {
      timerRef.current.start()
    }
  }, [isPaused, isRunning])

  const handleDone = useCallback(() => {
    advanceBlock()
  }, [advanceBlock])

  const handleAbandon = useCallback(async () => {
    if (window.confirm('Abandon this session? Progress will be saved but marked as abandoned.')) {
      await abandonSession()
    }
  }, [abandonSession])

  if (!activeRun || !currentBlock) return null

  const isLowTime = blockTimeRemaining <= 60 && blockTimeRemaining > 0
  const isCritical = blockTimeRemaining <= 10 && blockTimeRemaining > 0

  const totalBlocks = activeRun.blockConfigs.length

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">

      {/* ── Sticky top header ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
        {/* Segmented block progress bar */}
        <div className="flex gap-0.5 h-1.5">
          {activeRun.blockConfigs.map((block, i) => {
            let fill = 0
            if (i < currentBlockIndex) fill = 1
            else if (i === currentBlockIndex) fill = blockProgress
            return (
              <div key={block.id} className="flex-1 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary-500 transition-all duration-1000"
                  style={{ width: `${fill * 100}%` }}
                />
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between px-4 py-2">
          {/* Block indicator */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium">
              Block {currentBlockIndex + 1} of {totalBlocks}
            </span>
            <span className="text-xs text-slate-300">·</span>
            <span className="text-xs font-semibold text-slate-700">{currentBlock.name}</span>
          </div>

          {/* Overall session clock */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 font-mono">
              {formatTime(overallElapsedSec)} elapsed
            </span>
            <span className="w-px h-4 bg-slate-200" />
            {/* Block countdown */}
            <span
              className={`text-sm font-bold font-mono tabular-nums ${
                isCritical
                  ? 'text-red-600 timer-warning'
                  : isLowTime
                  ? 'text-amber-500'
                  : 'text-slate-700'
              }`}
            >
              {formatTime(blockTimeRemaining)}
            </span>
          </div>
        </div>
      </header>

      {/* ── Block content area ────────────────────────────────────────────── */}
      <div className="flex-1 max-w-3xl w-full mx-auto px-6 py-6">
        {/* Block header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary-100 text-primary-700">
              {currentBlock.type}
            </span>
            {currentBlock.autoAdvance && (
              <span className="text-xs text-slate-400">auto-advance</span>
            )}
          </div>
          <h2 className="text-xl font-bold text-slate-900">{currentBlock.name}</h2>
          {currentBlock.instructions && (
            <p className="mt-2 text-sm text-slate-600 leading-relaxed bg-slate-50 rounded-lg p-3 border border-slate-100">
              {currentBlock.instructions}
            </p>
          )}
        </div>

        {/* Block input — switches by type */}
        <BlockInputRouter block={currentBlock} />
      </div>

      {/* ── Footer controls ───────────────────────────────────────────────── */}
      <footer className="sticky bottom-0 bg-white border-t border-slate-200 px-6 py-3 flex items-center justify-between">
        <button
          onClick={handleAbandon}
          className="text-sm text-slate-400 hover:text-red-500 transition-colors"
        >
          Abandon
        </button>

        <div className="flex items-center gap-3">
          <button
            onClick={isPaused ? resumeRunning : pauseSession}
            className="px-4 py-2 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button
            onClick={handleDone}
            className="px-5 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
          >
            {isLastBlock ? 'Finish Session →' : "Done — Next Block →"}
          </button>
        </div>
      </footer>

      {/* ── 3-2-1 Transition overlay ──────────────────────────────────────── */}
      {transitionCountdown !== null && (
        <TransitionOverlay
          count={transitionCountdown}
          nextBlockName={activeRun.blockConfigs[currentBlockIndex]?.name}
        />
      )}

      {/* ── Pause overlay ─────────────────────────────────────────────────── */}
      {isPaused && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center">
          <div className="bg-white rounded-2xl p-8 text-center shadow-2xl max-w-sm w-full mx-4">
            <div className="text-5xl mb-4">⏸</div>
            <h3 className="text-xl font-bold text-slate-900 mb-2">Session Paused</h3>
            <p className="text-sm text-slate-500 mb-6">Your progress is saved. Take a breath.</p>
            <button
              onClick={resumeRunning}
              className="w-full py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors"
            >
              ▶ Continue
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

