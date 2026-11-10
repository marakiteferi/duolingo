import { useEffect, useState, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { db, DEFAULT_SPEAKING_PROMPT } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { formatTime } from '../../utils/helpers';
import type { AIFeedback, DETSkill } from '../../types';

export function PostSession() {
  const activeRun = useSessionStore((s) => s.activeRun);
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const clearActiveRun = useSessionStore((s) => s.clearActiveRun);
  const setView = useAppStore((s) => s.setView);

  const [evaluating, setEvaluating] = useState(false);
  const [evalProgress, setEvalProgress] = useState<string>('');
  const [evalError, setEvalError] = useState<string | null>(null);

  const evaluateAllBlocks = useCallback(async () => {
    if (!activeRun) return;
    setEvaluating(true);
    setEvalError(null);

    try {
      const settings = await db.settings.get('app-settings');
      const evalPrompts = await db.evalPrompts.toArray();
      const apiKey = settings?.geminiApiKey ?? '';

      for (let i = 0; i < activeRun.blockConfigs.length; i++) {
        const block = activeRun.blockConfigs[i];
        const resp = draftResponses[block.id] ?? activeRun.responses[block.id];

        if (resp?.aiOverallScore !== undefined && resp?.aiFeedback) {
          continue;
        }

        const studentText = (resp?.timestampedTranscript || resp?.textOrTranscript || '').trim();

        if (!studentText) {
          const skippedFeedback: AIFeedback = {
            overallScore: 0,
            subscores: { literacy: 0, comprehension: 0, conversation: 0, production: 0 },
            criteria: {
              status: 'Block was skipped or left unanswered (counted as 0/160 toward session total).',
            },
            strengths: [],
            weaknesses: ['Block was skipped or left blank during the session.'],
            suggestions: ['Complete all blocks in the session to maximize your overall DET score.'],
          };
          updateResponse(block.id, {
            aiOverallScore: 0,
            aiSubscores: skippedFeedback.subscores,
            aiFeedback: skippedFeedback,
          });
          continue;
        }

        setEvalProgress(`Evaluating Block ${i + 1} of ${activeRun.blockConfigs.length}: ${block.name}...`);

        const isSpokenResponse =
          block.type === 'speaking' ||
          block.type === 'shadowing' ||
          resp?.questionType === 'spoken-collocation-drill' ||
          Boolean(resp?.audioBlobRef);

        const evalPrompt = isSpokenResponse
          ? evalPrompts.find((ep) => ep.appliesToType === 'speaking')
          : evalPrompts.find((ep) => ep.id === block.evalPromptId) ??
            evalPrompts.find((ep) => ep.appliesToType === block.type) ??
            evalPrompts[0];

        const verifiedDuration = resp?.audioDurationSec || resp?.timeSpentSec || 60;

        const feedback = await evaluateResponse({
          apiKey,
          evalPromptTemplate:
            evalPrompt?.promptText ??
            (isSpokenResponse ? DEFAULT_SPEAKING_PROMPT : ''),
          variables: {
            prompt: resp?.promptSnapshot || block.instructions,
            response: studentText,
            transcript: studentText,
            durationSec: String(verifiedDuration),
            wpm: String(resp?.wpm ?? 0),
            fillerCount: String(resp?.fillerCount ?? 0),
          },
        });

        updateResponse(block.id, {
          aiFeedback: feedback,
          aiOverallScore: feedback.overallScore ?? 0,
          aiSubscores: feedback.subscores,
        });
      }

      const latestResponses = useSessionStore.getState().draftResponses;
      const totalBlocksCount = Math.max(1, activeRun.blockConfigs.length);
      let totalScoreSum = 0;

      for (const b of activeRun.blockConfigs) {
        const r = latestResponses[b.id];
        totalScoreSum += r?.aiOverallScore ?? 0;
      }

      const penalizedOverallScore = Math.round(totalScoreSum / totalBlocksCount);
      await db.sessionRuns.update(activeRun.id, {
        responses: latestResponses,
        summary: {
          overallScore: penalizedOverallScore,
          durationSec: activeRun.overallElapsedSec,
        },
      });
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : 'Evaluation encountered an error.');
    } finally {
      setEvaluating(false);
      setEvalProgress('');
    }
  }, [activeRun, draftResponses, updateResponse]);

  useEffect(() => {
    void evaluateAllBlocks();
  }, [evaluateAllBlocks]);

  if (!activeRun) return null;

  const blocks = activeRun.blockConfigs;
  const totalBlocks = Math.max(1, blocks.length);

  let sumAllBlocks = 0;
  let answeredBlocksCount = 0;
  let sumAnsweredOnly = 0;

  const subscoreTotals: Record<string, { sum: number; count: number }> = {
    literacy: { sum: 0, count: 0 },
    comprehension: { sum: 0, count: 0 },
    conversation: { sum: 0, count: 0 },
    production: { sum: 0, count: 0 },
  };

  for (const b of blocks) {
    const r = draftResponses[b.id] ?? activeRun.responses[b.id];
    const hasContent = Boolean(
      r?.textOrTranscript?.trim() || r?.audioBlobRef || (r?.aiOverallScore && r.aiOverallScore > 0)
    );
    const blockScore = hasContent ? (r?.aiOverallScore ?? 0) : 0;

    sumAllBlocks += blockScore;
    if (hasContent && blockScore > 0) {
      answeredBlocksCount += 1;
      sumAnsweredOnly += blockScore;
    }

    for (const key of ['literacy', 'comprehension', 'conversation', 'production'] as DETSkill[] | string[]) {
      const subVal = hasContent ? (r?.aiSubscores?.[key] ?? blockScore) : 0;
      if (subscoreTotals[key]) {
        subscoreTotals[key].sum += subVal;
        subscoreTotals[key].count += 1;
      }
    }
  }

  const strictOverallScore = Math.round(sumAllBlocks / totalBlocks);
  const answeredOnlyAverage =
    answeredBlocksCount > 0 ? Math.round(sumAnsweredOnly / answeredBlocksCount) : 0;
  const skippedCount = totalBlocks - answeredBlocksCount;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div className="bg-slate-900 text-white rounded-2xl p-6 shadow-md space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-primary-400">
              Session Complete • {activeRun.templateName}
            </span>
            <h2 className="text-2xl font-bold mt-1">
              Official-Style DET Performance Breakdown
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              Total Time: {formatTime(activeRun.overallElapsedSec)} • Blocks Completed:{' '}
              {answeredBlocksCount} of {totalBlocks}
              {skippedCount > 0
                ? ` (${skippedCount} skipped block${skippedCount > 1 ? 's' : ''} counted as 0)`
                : ' (All blocks completed ✓)'}
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right bg-slate-800 border border-slate-700 px-4 py-2.5 rounded-xl">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                True Session Score (All {totalBlocks} Blocks)
              </p>
              <p className="text-3xl font-extrabold text-primary-400 font-mono">
                {strictOverallScore} <span className="text-sm text-slate-400">/ 160</span>
              </p>
              {skippedCount > 0 && answeredOnlyAverage > 0 && (
                <p className="text-[11px] text-amber-300 mt-0.5">
                  Answered-Only Avg: {answeredOnlyAverage}/160 (-{answeredOnlyAverage - strictOverallScore} penalty for {skippedCount} skipped)
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
          {(['literacy', 'comprehension', 'conversation', 'production'] as const).map((sub) => {
            const stat = subscoreTotals[sub];
            const val = stat.count > 0 ? Math.round(stat.sum / stat.count) : 0;
            return (
              <div
                key={sub}
                className="bg-slate-800/90 border border-slate-700 rounded-xl p-3"
              >
                <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">
                  {sub}
                </p>
                <p className="text-xl font-bold text-white font-mono mt-0.5">
                  {val} <span className="text-xs text-slate-400">/ 160</span>
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {evaluating && (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-5 flex items-center justify-center gap-3 text-sm font-semibold text-accent-900">
          <div className="w-5 h-5 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
          <span>{evalProgress || 'Evaluating session blocks...'}</span>
        </div>
      )}

      {evalError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-700 flex items-center justify-between">
          <span>{evalError}</span>
          <button
            type="button"
            onClick={() => void evaluateAllBlocks()}
            className="px-3 py-1 bg-red-600 text-white font-bold rounded-lg cursor-pointer"
          >
            Retry Evaluation
          </button>
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-base font-bold text-slate-900">
          Block-by-Block Evaluation ({blocks.length} Blocks)
        </h3>

        {blocks.map((block, idx) => {
          const resp = draftResponses[block.id] ?? activeRun.responses[block.id];
          const fb = resp?.aiFeedback;
          const hasContent = Boolean(
            resp?.textOrTranscript?.trim() ||
              resp?.audioBlobRef ||
              (resp?.aiOverallScore && resp.aiOverallScore > 0)
          );
          const score = hasContent ? (resp?.aiOverallScore ?? 0) : 0;

          return (
            <div
              key={block.id}
              className={`bg-white rounded-2xl border-2 p-5 space-y-4 shadow-2xs ${
                !hasContent ? 'border-amber-200 bg-amber-50/20' : 'border-slate-200'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-6 h-6 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <div>
                    <h4 className="font-bold text-slate-900 text-sm">{block.name}</h4>
                    <span className="text-xs text-slate-500">
                      Mode: {resp?.questionType || block.type} • Time Spent:{' '}
                      {formatTime(resp?.timeSpentSec ?? 0)}
                    </span>
                  </div>
                </div>

                <span
                  className={`px-3 py-1 rounded-full text-xs font-extrabold font-mono ${
                    !hasContent || score === 0
                      ? 'bg-red-100 text-red-800 border border-red-300'
                      : score >= 135
                      ? 'bg-green-100 text-green-800 border border-green-300'
                      : 'bg-primary-100 text-primary-800 border border-primary-300'
                  }`}
                >
                  {!hasContent ? '0 / 160 (Skipped)' : `${score} / 160`}
                </span>
              </div>

              {resp?.promptSnapshot && (
                <div className="text-xs bg-slate-50 p-3 rounded-lg border border-slate-200 text-slate-700 whitespace-pre-wrap">
                  <strong className="text-slate-900">Task Prompt:</strong> {resp.promptSnapshot}
                </div>
              )}

              {resp?.audioBlobRef && (
                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-1">Your Recorded Audio:</p>
                  <audio controls src={resp.audioBlobRef} className="w-full h-9" />
                </div>
              )}

              {resp?.textOrTranscript && (
                <div className="text-xs bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-slate-800 whitespace-pre-wrap leading-relaxed">
                  <strong className="block text-slate-600 mb-1">
                    Submitted Response / Transcript:
                  </strong>
                  {resp.textOrTranscript}
                </div>
              )}

              {fb && (
                <div className="space-y-3 pt-1">
                  {fb.note && (
                    <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">
                      ℹ️ {fb.note}
                    </p>
                  )}

                  {Object.keys(fb.criteria ?? {}).length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                      {Object.entries(fb.criteria).map(([k, v]) => (
                        <div
                          key={k}
                          className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 text-xs"
                        >
                          <strong className="uppercase text-[10px] text-slate-500 block">
                            {k.replace(/_/g, ' ')}
                          </strong>
                          <span className="text-slate-800">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    {fb.strengths.length > 0 && (
                      <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                        <strong className="text-green-900 block mb-1">✓ Strengths</strong>
                        <ul className="list-disc list-inside space-y-1 text-green-800">
                          {fb.strengths.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {fb.weaknesses.length > 0 && (
                      <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                        <strong className="text-red-900 block mb-1">⚠️ Areas to Fix</strong>
                        <ul className="list-disc list-inside space-y-1 text-red-800">
                          {fb.weaknesses.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {fb.suggestedFix && (
                    <div className="bg-primary-50 border border-primary-200 rounded-xl p-3.5 text-xs text-slate-900">
                      <strong className="text-primary-800 block mb-1">
                        ✨ 150-Band C1/C2 Model Rewrite:
                      </strong>
                      <p className="italic leading-relaxed">{fb.suggestedFix}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200">
        <button
          type="button"
          onClick={() => {
            clearActiveRun();
            setView('config');
          }}
          className="px-5 py-3 bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-bold rounded-xl cursor-pointer"
        >
          ← Return to 21-Day Dashboard
        </button>

        <button
          type="button"
          onClick={() => {
            clearActiveRun();
            setView('exam');
          }}
          className="px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white text-sm font-bold rounded-xl cursor-pointer shadow-xs"
        >
          🎯 Back to Daily Sessions Hub →
        </button>
      </div>
    </div>
  );
}
