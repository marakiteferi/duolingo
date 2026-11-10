import { useEffect, useRef, useCallback, useState } from 'react';
import {
  useSessionStore,
  selectCurrentBlock,
  selectBlockTimeRemaining,
  selectBlockProgress,
  selectIsLastBlock,
} from '../../stores/sessionStore';
import { TimerEngine } from '../../utils/timer';
import { formatTime } from '../../utils/helpers';
import { db, DEFAULT_SPEAKING_PROMPT } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { BlockInputRouter } from './BlockInputRouter';
import { TransitionOverlay } from './TransitionOverlay';

export function SessionRunner() {
  const isRunning = useSessionStore((s) => s.isRunning);
  const isPaused = useSessionStore((s) => s.isPaused);
  const transitionCountdown = useSessionStore((s) => s.transitionCountdown);
  const overallElapsedSec = useSessionStore((s) => s.overallElapsedSec);
  const currentBlockIndex = useSessionStore((s) => s.currentBlockIndex);
  const activeRun = useSessionStore((s) => s.activeRun);
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const lastSavedAt = useSessionStore((s) => s.lastSavedAt);
  const tick = useSessionStore((s) => s.tick);
  const pauseSession = useSessionStore((s) => s.pauseSession);
  const resumeRunning = useSessionStore((s) => s.resumeRunning);
  const advanceBlock = useSessionStore((s) => s.advanceBlock);
  const jumpToBlock = useSessionStore((s) => s.jumpToBlock);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const resetBlockForRewrite = useSessionStore((s) => s.resetBlockForRewrite);
  const abandonSession = useSessionStore((s) => s.abandonSession);

  const currentBlock = useSessionStore(selectCurrentBlock);
  const blockTimeRemaining = useSessionStore(selectBlockTimeRemaining);
  const blockProgress = useSessionStore(selectBlockProgress);
  const isLastBlock = useSessionStore(selectIsLastBlock);

  const [instantEvalLoading, setInstantEvalLoading] = useState(false);
  const [instantEvalError, setInstantEvalError] = useState<string | null>(null);

  const timerRef = useRef<TimerEngine | null>(null);

  useEffect(() => {
    timerRef.current = new TimerEngine(tick, 1000);
    timerRef.current.start();
    return () => timerRef.current?.stop();
  }, [tick]);

  useEffect(() => {
    if (!timerRef.current) return;
    if (isPaused) {
      timerRef.current.stop();
    } else if (isRunning) {
      timerRef.current.start();
    }
  }, [isPaused, isRunning]);

  const handleDone = useCallback(() => {
    setInstantEvalError(null);
    advanceBlock();
  }, [advanceBlock]);

  const handleInstantCheck = useCallback(async () => {
    if (!currentBlock) return;
    const resp = draftResponses[currentBlock.id];
    const studentText = (resp?.timestampedTranscript || resp?.textOrTranscript || '').trim();

    if (!studentText) {
      setInstantEvalError(
        'Write a response or record & transcribe your speech before requesting AI feedback.'
      );
      return;
    }

    pauseSession();
    setInstantEvalLoading(true);
    setInstantEvalError(null);

    try {
      const settings = await db.settings.get('app-settings');
      const evalPrompts = await db.evalPrompts.toArray();

      // Detect if this block was answered via Spoken Voice Mode (including Spoken Collocation Drill!)
      const isSpokenResponse =
        currentBlock.type === 'speaking' ||
        currentBlock.type === 'shadowing' ||
        resp?.questionType === 'spoken-collocation-drill' ||
        Boolean(resp?.audioBlobRef);

      const evalPrompt = isSpokenResponse
        ? evalPrompts.find((ep) => ep.appliesToType === 'speaking')
        : evalPrompts.find((ep) => ep.id === currentBlock.evalPromptId) ??
          evalPrompts.find((ep) => ep.appliesToType === currentBlock.type) ??
          evalPrompts[0];

      const verifiedDuration =
        resp?.audioDurationSec || resp?.timeSpentSec || 60;

      const feedback = await evaluateResponse({
        apiKey: settings?.geminiApiKey ?? '',
        evalPromptTemplate:
          evalPrompt?.promptText ??
          (isSpokenResponse ? DEFAULT_SPEAKING_PROMPT : ''),
        variables: {
          prompt: resp?.promptSnapshot || currentBlock.instructions,
          response: studentText,
          transcript: studentText,
          durationSec: String(verifiedDuration),
          wpm: String(resp?.wpm ?? 0),
          fillerCount: String(resp?.fillerCount ?? 0),
        },
      });

      updateResponse(currentBlock.id, {
        aiFeedback: feedback,
        aiOverallScore: feedback.overallScore,
        aiSubscores: feedback.subscores,
      });
    } catch (err) {
      setInstantEvalError(
        err instanceof Error ? err.message : 'Instant evaluation failed.'
      );
    } finally {
      setInstantEvalLoading(false);
    }
  }, [currentBlock, draftResponses, pauseSession, updateResponse]);

  const handleAbandon = useCallback(async () => {
    if (
      window.confirm(
        'Exit this practice session? Your draft responses remain saved in History.'
      )
    ) {
      await abandonSession();
    }
  }, [abandonSession]);

  if (!activeRun || !currentBlock) return null;

  const currentResponse = draftResponses[currentBlock.id];
  const blockFeedback = currentResponse?.aiFeedback;
  const isLowTime = blockTimeRemaining <= 60 && blockTimeRemaining > 0;
  const isCritical = blockTimeRemaining <= 10 && blockTimeRemaining > 0;
  const totalBlocks = activeRun.blockConfigs.length;
  const nextBlock = activeRun.blockConfigs[currentBlockIndex + 1];

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {transitionCountdown !== null && (
        <TransitionOverlay
          count={transitionCountdown}
          nextBlockName={nextBlock?.name ?? 'Next Block'}
        />
      )}

      {/* Sticky Top Header */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-xs">
        <div className="flex gap-1 px-2 pt-1.5">
          {activeRun.blockConfigs.map((block, i) => {
            let fill = 0;
            if (i < currentBlockIndex) fill = 1;
            else if (i === currentBlockIndex) fill = blockProgress;
            return (
              <button
                key={block.id}
                type="button"
                onClick={() => jumpToBlock(i)}
                title={`Jump to Block ${i + 1}: ${block.name}`}
                className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden cursor-pointer hover:opacity-80"
              >
                <div
                  className="h-full bg-primary-500 transition-all duration-500"
                  style={{ width: `${fill * 100}%` }}
                />
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2.5 py-1 rounded-md">
              Block {currentBlockIndex + 1} / {totalBlocks}
            </span>
            <span className="text-sm font-semibold text-slate-800">
              {currentBlock.name}
            </span>
            {currentResponse?.attemptCount && currentResponse.attemptCount > 1 && (
              <span className="text-xs font-bold bg-accent-100 text-accent-800 px-2 py-0.5 rounded-full">
                Attempt #{currentResponse.attemptCount}
              </span>
            )}
            {lastSavedAt && (
              <span className="text-[11px] text-slate-400 hidden sm:inline">
                Auto-saved
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 hidden md:inline">
              Total: {formatTime(overallElapsedSec)}
            </span>

            <div
              className={`px-3 py-1 rounded-lg font-mono text-base font-bold ${
                isCritical
                  ? 'bg-red-600 text-white animate-pulse'
                  : isLowTime
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-slate-100 text-slate-800'
              }`}
            >
              {formatTime(blockTimeRemaining)}
            </div>

            <button
              type="button"
              onClick={isPaused ? resumeRunning : pauseSession}
              className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              {isPaused ? '▶ Resume' : '⏸ Pause'}
            </button>

            <button
              type="button"
              onClick={handleAbandon}
              className="px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
            >
              Exit
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-6 space-y-6">
        <BlockInputRouter block={currentBlock} />

        {instantEvalError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-700">
            {instantEvalError}
          </div>
        )}

        {/* Instant AI Feedback Drawer */}
        {blockFeedback && (
          <div className="bg-white border-2 border-primary-300 rounded-2xl p-5 space-y-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-primary-700">
                  ⚡ Instant Deliberate-Practice Critique
                </span>
                <h4 className="text-base font-bold text-slate-900 mt-0.5">
                  Estimated DET Band: {blockFeedback.overallScore ?? '—'} / 160
                </h4>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => resetBlockForRewrite(currentBlock.id)}
                  className="px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl cursor-pointer shadow-2xs"
                >
                  ↺ Apply Fixes & Rewrite / Re-record Now
                </button>
                <button
                  type="button"
                  onClick={handleDone}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl cursor-pointer"
                >
                  {isLastBlock ? 'Finish Session →' : 'Continue to Next Block →'}
                </button>
              </div>
            </div>

            {blockFeedback.note && (
              <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">
                ℹ️ {blockFeedback.note}
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {blockFeedback.strengths.length > 0 && (
                <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                  <strong className="text-green-900 block mb-1">✓ Strengths</strong>
                  <ul className="list-disc list-inside space-y-1 text-green-800">
                    {blockFeedback.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {blockFeedback.weaknesses.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                  <strong className="text-red-900 block mb-1">⚠️ Gaps to Fix</strong>
                  <ul className="list-disc list-inside space-y-1 text-red-800">
                    {blockFeedback.weaknesses.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {blockFeedback.suggestedFix && (
              <div className="bg-primary-50 border border-primary-200 rounded-xl p-3.5 text-xs text-slate-900">
                <strong className="text-primary-800 block mb-1">
                  ✨ 150-Band C1/C2 Target Rewrite:
                </strong>
                <p className="italic leading-relaxed">{blockFeedback.suggestedFix}</p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Bottom Action Footer */}
      <footer className="sticky bottom-0 z-30 bg-white border-t border-slate-200 px-6 py-3.5">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {activeRun.instantFeedback && currentBlock.type !== 'interactive-reading' && (
              <button
                type="button"
                disabled={instantEvalLoading}
                onClick={() => void handleInstantCheck()}
                className="px-4 py-2.5 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer shadow-2xs"
              >
                {instantEvalLoading
                  ? '⏳ Grading Response...'
                  : '⚡ Get Instant AI Critique & Score'}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleDone}
            className="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-bold rounded-xl cursor-pointer shadow-xs"
          >
            {isLastBlock
              ? '✓ Complete Session & View Final Score'
              : `Next Block (${currentBlockIndex + 2}/${totalBlocks}) →`}
          </button>
        </div>
      </footer>
    </div>
  );
}
