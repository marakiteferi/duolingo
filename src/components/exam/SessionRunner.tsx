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
import { db } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { BlockInputRouter } from './BlockInputRouter';
import { TransitionOverlay } from './TransitionOverlay';
import { WhisperLiveIndicator } from '../common/WhisperLiveIndicator';

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
    const studentText = resp?.textOrTranscript?.trim() ?? '';
    if (!studentText) {
      setInstantEvalError('Write a response or record & transcribe your speech before requesting AI feedback.');
      return;
    }

    pauseSession();
    setInstantEvalLoading(true);
    setInstantEvalError(null);

    try {
      const settings = await db.settings.get('app-settings');
      if (!settings?.geminiApiKey) {
        throw new Error('Gemini API key not configured. Add it in Config -> Settings.');
      }
      const evalPrompts = await db.evalPrompts.toArray();
      const evalPrompt =
        evalPrompts.find((ep) => ep.id === currentBlock.evalPromptId) ??
        evalPrompts.find((ep) => ep.appliesToType === currentBlock.type) ??
        evalPrompts[0];

      if (!evalPrompt) throw new Error('No evaluation prompt found.');

      const feedback = await evaluateResponse({
        apiKey: settings.geminiApiKey,
        evalPromptTemplate: evalPrompt.promptText,
        variables: {
          prompt: resp?.promptSnapshot || currentBlock.instructions,
          response: studentText,
          transcript: studentText,
          durationSec: String(resp?.timeSpentSec ?? 60),
        },
      });

      updateResponse(currentBlock.id, {
        aiFeedback: feedback,
        aiOverallScore: feedback.overallScore,
        aiSubscores: feedback.subscores,
      });
    } catch (err) {
      setInstantEvalError(err instanceof Error ? err.message : 'Instant evaluation failed.');
    } finally {
      setInstantEvalLoading(false);
    }
  }, [currentBlock, draftResponses, pauseSession, updateResponse]);

  const handleAbandon = useCallback(async () => {
    if (window.confirm('Exit this practice session? Your draft responses remain saved in History.')) {
      await abandonSession();
    }
  }, [abandonSession]);

  if (!activeRun || !currentBlock) return null;

  const currentResponse = draftResponses[currentBlock.id];
  const blockFeedback = currentResponse?.aiFeedback;
  const isLowTime = blockTimeRemaining <= 60 && blockTimeRemaining > 0;
  const isCritical = blockTimeRemaining <= 10 && blockTimeRemaining > 0;
  const totalBlocks = activeRun.blockConfigs.length;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Sticky Top Header */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-xs">
        {/* Clickable Segmented Progress Bar (allows jumping between blocks) */}
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

        <div className="flex items-center justify-between px-6 py-2.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleAbandon}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer mr-1"
              title="Exit this session and return to Dashboard"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Exit to Dashboard
            </button>
            <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2.5 py-1 rounded-md">
              Block {currentBlockIndex + 1} / {totalBlocks}
            </span>
            <span className="text-sm font-semibold text-slate-800">{currentBlock.name}</span>
            {lastSavedAt && (
              <span className="text-xs text-slate-400 hidden sm:inline">
                ✓ Auto-saved
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <WhisperLiveIndicator compact />
            <span className="text-xs text-slate-400 font-mono">
              Total {formatTime(overallElapsedSec)}
            </span>
            <span className="w-px h-4 bg-slate-200" />
            <span
              className={`text-base font-bold font-mono tabular-nums px-2.5 py-0.5 rounded ${
                blockTimeRemaining === 0
                  ? 'bg-red-100 text-red-700'
                  : isCritical
                  ? 'bg-red-50 text-red-600 timer-warning'
                  : isLowTime
                  ? 'bg-amber-50 text-amber-600'
                  : 'text-slate-800'
              }`}
            >
              {blockTimeRemaining === 0 ? 'TIME UP' : formatTime(blockTimeRemaining)}
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 max-w-3xl w-full mx-auto px-6 py-6 space-y-6">
        <BlockInputRouter block={currentBlock} />

        {/* Instant AI Evaluation Drawer */}
        {instantEvalError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl p-3">
            {instantEvalError}
          </div>
        )}

        {blockFeedback && (
          <div className="bg-white border-2 border-primary-300 rounded-2xl p-5 shadow-md space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-primary-600">
                  ⚡ Instant DET Calibration (Timer Paused)
                </span>
                <h4 className="text-base font-bold text-slate-900">
                  Block Score Breakdown
                </h4>
              </div>
              <div className="text-right">
                <span className="text-3xl font-black text-primary-600">
                  {currentResponse?.aiOverallScore ?? '—'}
                </span>
                <span className="text-xs text-slate-400 block">/ 160</span>
              </div>
            </div>

            {Object.keys(blockFeedback.subscores).length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(blockFeedback.subscores).map(([k, v]) => (
                  <div key={k} className="bg-slate-50 rounded-lg p-2.5 text-center">
                    <p className="text-xs text-slate-500 capitalize">{k.replace(/_/g, ' ')}</p>
                    <p className="text-base font-bold text-slate-800">{v}</p>
                  </div>
                ))}
              </div>
            )}

            {blockFeedback.suggestedFix && (
              <div className="bg-primary-50 border border-primary-200 rounded-xl p-3">
                <p className="text-xs font-bold text-primary-800 mb-1">
                  ✨ 145–155 Band Suggested Upgrade:
                </p>
                <p className="text-xs text-slate-800 leading-relaxed">
                  {blockFeedback.suggestedFix}
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {blockFeedback.strengths.length > 0 && (
                <div className="bg-green-50 rounded-lg p-3">
                  <p className="font-bold text-green-800 mb-1">✓ Strengths</p>
                  <ul className="list-disc list-inside space-y-1 text-slate-700">
                    {blockFeedback.strengths.map((s, idx) => (
                      <li key={idx}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {blockFeedback.weaknesses.length > 0 && (
                <div className="bg-amber-50 rounded-lg p-3">
                  <p className="font-bold text-amber-800 mb-1">⚠️ Areas to Tighten</p>
                  <ul className="list-disc list-inside space-y-1 text-slate-700">
                    {blockFeedback.weaknesses.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={resumeRunning}
                className="px-4 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800"
              >
                ▶ Resume Timer & Keep Practicing
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sticky Footer Controls */}
      <footer className="sticky bottom-0 z-30 bg-white border-t border-slate-200 px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={handleAbandon}
          className="text-xs font-medium text-slate-400 hover:text-red-600 transition-colors"
        >
          ✕ Exit Session
        </button>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleInstantCheck}
            disabled={instantEvalLoading}
            className="px-4 py-2 text-xs font-semibold text-accent-700 bg-accent-50 border border-accent-200 rounded-lg hover:bg-accent-100 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {instantEvalLoading ? '⏳ Grading Block...' : '⚡ Instant AI Feedback'}
          </button>

          <button
            type="button"
            onClick={isPaused ? resumeRunning : pauseSession}
            className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            {isPaused ? '▶ Resume Timer' : '⏸ Pause'}
          </button>

          <button
            type="button"
            onClick={handleDone}
            className="px-5 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 transition-colors cursor-pointer"
          >
            {isLastBlock ? 'Finish & Review Session →' : 'Next Block →'}
          </button>
        </div>
      </footer>

      {transitionCountdown !== null && (
        <TransitionOverlay
          count={transitionCountdown}
          nextBlockName={activeRun.blockConfigs[currentBlockIndex]?.name}
        />
      )}
    </div>
  );
}
