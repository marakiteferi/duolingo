import { useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { db } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { formatTime } from '../../utils/helpers';
import type { BlockResponse, DETSkill } from '../../types';

export function PostSession() {
  const activeRun = useSessionStore((s) => s.activeRun);
  const clearActiveRun = useSessionStore((s) => s.clearActiveRun);
  const setView = useAppStore((s) => s.setView);
  const setConfigSection = useAppStore((s) => s.setConfigSection);

  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [localResponses, setLocalResponses] = useState<Record<string, BlockResponse>>(
    activeRun?.responses ?? {}
  );

  const handleUpdateText = (blockId: string, text: string) => {
    setLocalResponses((prev) => ({
      ...prev,
      [blockId]: { ...prev[blockId], textOrTranscript: text, timestampedTranscript: text },
    }));
  };

  const handleEvaluate = useCallback(async () => {
    if (!activeRun) return;
    if (!navigator.onLine) {
      setQueuedOffline(true);
      setEvalError('You are currently offline. Responses are saved and will auto-evaluate when back online.');
      return;
    }
    setEvaluating(true);
    setEvalError(null);
    try {
      const settings = await db.settings.get('app-settings');
      if (!settings?.geminiApiKey) {
        setEvalError('Gemini API key not set. Go to Config -> Settings to paste your free Google AI Studio key.');
        setEvaluating(false);
        return;
      }
      const evalPrompts = await db.evalPrompts.toArray();
      const updatedResponses = { ...localResponses };
      const blockScores: number[] = [];
      const skillScores: Partial<Record<DETSkill, number[]>> = {};

      for (const block of activeRun.blockConfigs) {
        const response = updatedResponses[block.id];
        const text = response?.textOrTranscript?.trim() ?? '';
        if (!text) continue;
        const evalPrompt =
          evalPrompts.find((ep) => ep.id === block.evalPromptId) ??
          evalPrompts.find((ep) => ep.appliesToType === block.type) ??
          evalPrompts[0];
        if (!evalPrompt) continue;

        const verifiedDuration =
          response?.audioDurationSec ??
          (response?.timeSpentSec && response.timeSpentSec > 0 ? response.timeSpentSec : block.durationSec);

        const feedback = await evaluateResponse({
          apiKey: settings.geminiApiKey,
          evalPromptTemplate: evalPrompt.promptText,
          variables: {
            prompt: response?.promptSnapshot || block.instructions,
            response: text,
            transcript: response?.timestampedTranscript || text,
            durationSec: String(verifiedDuration),
            wpm: String(response?.wpm ?? 130),
            fillerCount: String(response?.fillerCount ?? 0),
          },
        });

        const subVals = Object.values(feedback.subscores);
        const computedScore =
          feedback.overallScore ??
          (subVals.length > 0
            ? Math.round(subVals.reduce((a, b) => a + b, 0) / subVals.length)
            : 125);
        blockScores.push(computedScore);

        const targetSkill: DETSkill =
          block.type === 'speaking' || block.type === 'shadowing'
            ? 'speaking'
            : block.type === 'dictogloss'
            ? 'listening'
            : block.type === 'mock-test'
            ? 'reading'
            : 'writing';
        skillScores[targetSkill] = [...(skillScores[targetSkill] ?? []), computedScore];

        updatedResponses[block.id] = {
          ...response,
          aiFeedback: feedback,
          aiOverallScore: computedScore,
          aiSubscores: feedback.subscores,
          evalPendingOffline: false,
        };
      }

      const compositeOverall =
        blockScores.length > 0
          ? Math.round(blockScores.reduce((a, b) => a + b, 0) / blockScores.length)
          : undefined;
      const perSkillScores: Partial<Record<DETSkill, number>> = {};
      for (const [sk, arr] of Object.entries(skillScores) as [DETSkill, number[]][]) {
        if (arr && arr.length > 0) {
          perSkillScores[sk] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
        }
      }

      setLocalResponses(updatedResponses);
      await db.sessionRuns.update(activeRun.id, {
        responses: updatedResponses,
        summary: {
          overallScore: compositeOverall,
          perSkillScores,
          durationSec: activeRun.overallElapsedSec,
        },
      });
      setQueuedOffline(false);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : 'Evaluation failed.');
    } finally {
      setEvaluating(false);
    }
  }, [activeRun, localResponses]);

  useEffect(() => {
    if (!queuedOffline) return;
    const onOnline = () => void handleEvaluate();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [queuedOffline, handleEvaluate]);

  if (!activeRun) return null;

  const scoredValues = Object.values(localResponses)
    .map((r) => r.aiOverallScore)
    .filter((v): v is number => typeof v === 'number');
  const sessionAverage =
    scoredValues.length > 0
      ? Math.round(scoredValues.reduce((a, b) => a + b, 0) / scoredValues.length)
      : null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-primary-600">
            Session Complete
          </span>
          <h2 className="text-2xl font-bold text-slate-900 mt-0.5">{activeRun.templateName}</h2>
          <p className="text-xs text-slate-500 mt-1">
            Total Time: {formatTime(activeRun.overallElapsedSec)} • {activeRun.blockConfigs.length} Blocks
          </p>
        </div>
        {sessionAverage !== null ? (
          <div className="text-right bg-primary-50 border border-primary-200 px-5 py-3 rounded-xl">
            <span className="text-xs font-semibold text-primary-700 block">Estimated DET Band</span>
            <span className="text-4xl font-black text-primary-600">{sessionAverage}</span>
            <span className="text-xs text-primary-600"> / 160</span>
          </div>
        ) : (
          <button
            onClick={handleEvaluate}
            disabled={evaluating}
            className="px-6 py-3 bg-primary-600 text-white text-sm font-bold rounded-xl hover:bg-primary-700 disabled:opacity-50 cursor-pointer"
          >
            {evaluating ? 'Grading with Gemini...' : 'Grade All Blocks with Gemini AI'}
          </button>
        )}
      </div>

      {evalError && (
        <div className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-4">
          {evalError}
        </div>
      )}

      <div className="space-y-6">
        {activeRun.blockConfigs.map((block, idx) => {
          const response = localResponses[block.id];
          const feedback = response?.aiFeedback;
          const score = response?.aiOverallScore;
          const verifiedSec = response?.audioDurationSec ?? response?.timeSpentSec ?? 0;
          return (
            <div key={block.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between p-4 bg-slate-50 border-b border-slate-100">
                <div>
                  <h3 className="font-semibold text-slate-900">
                    {idx + 1}. {block.name}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {block.type} • Verified Duration: {verifiedSec}s
                    {response?.wpm ? ` • ${response.wpm} WPM` : ''}
                    {response?.fillerCount !== undefined ? ` • ${response.fillerCount} fillers` : ''}
                    {response?.attemptCount && response.attemptCount > 1 ? ` • ${response.attemptCount} attempts` : ''}
                  </p>
                </div>
                {score !== undefined && (
                  <div className="text-right">
                    <span className="text-2xl font-black text-primary-600">{score}</span>
                    <span className="text-xs text-slate-400 block">/ 160</span>
                  </div>
                )}
              </div>
              <div className="p-5 space-y-4">
                {response?.audioBlobRef && (
                  <audio controls src={response.audioBlobRef} className="w-full h-10" />
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">
                    Response / Timestamped Verbatim Transcript:
                  </label>
                  <textarea
                    value={response?.timestampedTranscript || response?.textOrTranscript || ''}
                    onChange={(e) => handleUpdateText(block.id, e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs font-mono text-slate-800"
                  />
                </div>
                {feedback?.suggestedFix && (
                  <div className="bg-primary-50 border border-primary-200 rounded-xl p-3.5 text-xs">
                    <p className="font-bold text-primary-800 mb-1">145–155 Band Suggested Upgrade:</p>
                    <p className="text-slate-800">{feedback.suggestedFix}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex flex-wrap justify-between items-center gap-3">
        <button
          onClick={handleEvaluate}
          disabled={evaluating}
          className="px-4 py-2 text-sm font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg"
        >
          {evaluating ? 'Re-evaluating...' : 'Re-evaluate Responses with AI'}
        </button>
        <div className="flex gap-3">
          <button
            onClick={() => clearActiveRun()}
            className="px-4 py-2.5 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg"
          >
            Start Another Session
          </button>
          <button
            onClick={() => {
              clearActiveRun();
              setConfigSection('history');
              setView('config');
            }}
            className="px-5 py-2.5 bg-slate-900 text-white text-sm font-semibold rounded-lg"
          >
            View Score Trends & Error Log
          </button>
        </div>
      </div>
    </div>
  );
}
