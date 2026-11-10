import { useEffect, useState, useCallback } from 'react';
import { db } from '../../db/database';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import type { SessionRun } from '../../types';
import { formatTime } from '../../utils/helpers';

export function HistoryPanel() {
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const setView = useAppStore((s) => s.setView);

  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    const all = await db.sessionRuns.orderBy('startedAt').reverse().toArray();
    setRuns(all);
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const handleResumeRun = (run: SessionRun) => {
    resumeSession(run);
    setView('exam');
  };

  const handleDeleteRun = async (id: string) => {
    await db.sessionRuns.delete(id);
    await loadRuns();
  };

  const handleClearAllInProgress = async () => {
    const inProgIds = runs.filter((r) => r.status === 'in-progress').map((r) => r.id);
    if (inProgIds.length === 0) return;
    await db.sessionRuns.bulkDelete(inProgIds);
    await loadRuns();
  };

  const computeTrueSessionScore = (run: SessionRun): number | null => {
    const totalBlocks = Math.max(1, run.blockConfigs?.length ?? 1);
    const responses = Object.values(run.responses ?? {});
    const hasAnyScored = responses.some((r) => r.aiOverallScore !== undefined);
    if (!hasAnyScored) return run.summary?.overallScore ?? null;

    let sum = 0;
    for (const b of run.blockConfigs) {
      const r = run.responses?.[b.id];
      const hasContent = Boolean(
        r?.textOrTranscript?.trim() || r?.audioBlobRef || (r?.aiOverallScore && r.aiOverallScore > 0)
      );
      sum += hasContent ? (r?.aiOverallScore ?? 0) : 0;
    }
    return Math.round(sum / totalBlocks);
  };

  const inProgressCount = runs.filter((r) => r.status === 'in-progress').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Session Score & Practice History</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Resume unfinished "in-progress" sessions at the exact block you left off, or inspect past AI evaluations.
          </p>
        </div>

        {inProgressCount > 0 && (
          <button
            type="button"
            onClick={handleClearAllInProgress}
            className="px-3.5 py-2 bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 text-xs font-bold rounded-lg cursor-pointer"
          >
            🗑️ Discard All {inProgressCount} Unfinished ("in-progress") Attempts
          </button>
        )}
      </div>

      {runs.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
          No practice sessions recorded yet. Start a session from the 21-Day Study Plan!
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => {
            const trueScore = computeTrueSessionScore(run);
            const isExpanded = expandedId === run.id;
            const answeredBlocks = run.blockConfigs.filter((b) => {
              const r = run.responses?.[b.id];
              return Boolean(
                r?.textOrTranscript?.trim() ||
                  r?.audioBlobRef ||
                  (r?.aiOverallScore && r.aiOverallScore > 0)
              );
            }).length;

            return (
              <div
                key={run.id}
                className="bg-white rounded-xl border border-slate-200 p-4 space-y-3 shadow-2xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`text-xs font-bold px-2.5 py-0.5 rounded-full uppercase ${
                          run.status === 'completed'
                            ? 'bg-green-100 text-green-800'
                            : run.status === 'in-progress'
                            ? 'bg-amber-100 text-amber-800 border border-amber-300'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {run.status}
                      </span>
                      <h3 className="font-bold text-slate-900 text-sm">{run.templateName}</h3>
                      {run.planDay && (
                        <span className="text-xs font-mono bg-primary-50 text-primary-800 px-2 py-0.5 rounded">
                          Day {run.planDay}
                          {run.planSlotIndex ? ` • Session ${run.planSlotIndex}` : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500">
                      {new Date(run.startedAt).toLocaleString()} • Duration:{' '}
                      {formatTime(run.overallElapsedSec)} • Blocks Answered: {answeredBlocks}/
                      {run.blockConfigs.length}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {trueScore !== null && (
                      <span className="px-3 py-1 bg-slate-900 text-primary-400 font-mono font-extrabold text-xs rounded-lg">
                        Score: {trueScore} / 160
                      </span>
                    )}

                    {run.status === 'in-progress' && (
                      <button
                        type="button"
                        onClick={() => handleResumeRun(run)}
                        className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-lg cursor-pointer shadow-2xs"
                      >
                        ▶ Resume Session (Block {run.currentBlockIndex + 1}/{run.blockConfigs.length})
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : run.id)}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg cursor-pointer"
                    >
                      {isExpanded ? 'Hide Details' : 'View Blocks'}
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDeleteRun(run.id)}
                      className="px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="pt-3 border-t border-slate-100 space-y-2.5">
                    {run.blockConfigs.map((b, i) => {
                      const r = run.responses?.[b.id];
                      const hasContent = Boolean(
                        r?.textOrTranscript?.trim() ||
                          r?.audioBlobRef ||
                          (r?.aiOverallScore && r.aiOverallScore > 0)
                      );
                      return (
                        <div
                          key={b.id}
                          className="bg-slate-50 rounded-lg p-3 border border-slate-200 text-xs space-y-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-slate-800">
                              {i + 1}. {b.name} ({b.type})
                            </span>
                            <span className="font-mono font-bold text-primary-700">
                              {hasContent
                                ? r?.aiOverallScore !== undefined
                                  ? `${r.aiOverallScore}/160`
                                  : 'Answered'
                                : '0/160 (Skipped)'}
                            </span>
                          </div>
                          {r?.textOrTranscript && (
                            <p className="text-slate-700 whitespace-pre-wrap">
                              {r.textOrTranscript}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
