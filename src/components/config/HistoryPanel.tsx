import { useEffect, useState } from 'react';
import { db } from '../../db/database';
import { formatDate, formatTime } from '../../utils/helpers';
import type { SessionRun } from '../../types';

export function HistoryPanel() {
  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<SessionRun | null>(null);

  const loadRuns = async () => {
    const all = await db.sessionRuns.orderBy('startedAt').reverse().toArray();
    setRuns(all);
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  const completedWithScores = runs
    .filter((r) => r.summary?.overallScore !== undefined)
    .slice()
    .reverse();

  const handleDeleteRun = async (id: string) => {
    if (!window.confirm('Delete this session record permanently?')) return;
    await db.sessionRuns.delete(id);
    if (selectedRun?.id === id) setSelectedRun(null);
    await loadRuns();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Session History & 140–150 Score Trends</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Track your composite DET score progression and review past verbatim recordings.
        </p>
      </div>

      {/* SVG Trend Chart */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-800">Overall Score Progression (0–160 Scale)</h3>
          <span className="text-xs px-2.5 py-0.5 rounded-full bg-green-100 text-green-800 font-semibold">
            Green Band = 140–150 Target Zone
          </span>
        </div>

        {completedWithScores.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-400">
            Complete and AI-evaluate a session to plot your 0–160 score trend.
          </div>
        ) : (
          <svg viewBox="0 0 600 180" className="w-full h-44 overflow-visible">
            {/* Target 140-150 Band Highlight */}
            <rect
              x="40"
              y={160 - (150 / 160) * 140}
              width="540"
              height={(15 / 160) * 140}
              fill="#dcfce7"
              rx="4"
            />
            {[0, 80, 120, 140, 160].map((val) => {
              const y = 160 - (val / 160) * 140;
              return (
                <g key={val}>
                  <line
                    x1="40"
                    y1={y}
                    x2="580"
                    y2={y}
                    stroke="#e2e8f0"
                    strokeDasharray={val === 140 ? '4 2' : undefined}
                  />
                  <text x="8" y={y + 4} className="text-[10px] fill-slate-400 font-mono">
                    {val}
                  </text>
                </g>
              );
            })}

            {/* Score Polyline */}
            {completedWithScores.length > 1 && (
              <polyline
                fill="none"
                stroke="#4f46e5"
                strokeWidth="2.5"
                points={completedWithScores
                  .map((r, idx) => {
                    const score = r.summary?.overallScore ?? 0;
                    const x =
                      40 +
                      (idx / Math.max(1, completedWithScores.length - 1)) * 520;
                    const y = 160 - (Math.min(160, Math.max(0, score)) / 160) * 140;
                    return x + ',' + y;
                  })
                  .join(' ')}
              />
            )}

            {/* Data Points */}
            {completedWithScores.map((r, idx) => {
              const score = r.summary?.overallScore ?? 0;
              const x =
                completedWithScores.length === 1
                  ? 300
                  : 40 + (idx / (completedWithScores.length - 1)) * 520;
              const y = 160 - (Math.min(160, Math.max(0, score)) / 160) * 140;
              return (
                <g key={r.id}>
                  <circle
                    cx={x}
                    cy={y}
                    r="5"
                    className="fill-primary-600 stroke-white stroke-2 cursor-pointer"
                    onClick={() => setSelectedRun(r)}
                  />
                  <text
                    x={x}
                    y={y - 10}
                    textAnchor="middle"
                    className="text-[11px] font-bold fill-slate-700"
                  >
                    {score}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Runs List */}
      <div className="space-y-3">
        {runs.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">
            No practice sessions recorded yet. Start a session on the Exam page!
          </div>
        ) : (
          runs.map((run) => {
            const overall = run.summary?.overallScore;
            const isSelected = selectedRun?.id === run.id;
            const statusClass =
              run.status === 'completed'
                ? 'bg-green-100 text-green-800'
                : run.status === 'in-progress'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-600';

            return (
              <div
                key={run.id}
                className="bg-white border border-slate-200 rounded-xl p-4 transition-all"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-slate-900">{run.templateName}</h4>
                      <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + statusClass}>
                        {run.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {formatDate(run.startedAt)} • Duration: {formatTime(run.overallElapsedSec)} •{' '}
                      {run.blockConfigs.length} Blocks
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    {overall !== undefined && (
                      <div className="text-right mr-2">
                        <span className="text-xl font-black text-primary-600">{overall}</span>
                        <span className="text-xs text-slate-400"> / 160</span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedRun(isSelected ? null : run)}
                      className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100"
                    >
                      {isSelected ? 'Hide Details' : 'Inspect Responses & Audio'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteRun(run.id)}
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {isSelected && (
                  <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
                    {run.blockConfigs.map((b, i) => {
                      const resp = run.responses[b.id];
                      return (
                        <div key={b.id} className="bg-slate-50 rounded-xl p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-800">
                              {i + 1}. {b.name} ({b.type})
                            </span>
                            {resp?.aiOverallScore !== undefined && (
                              <span className="text-xs font-bold text-primary-700 bg-primary-100 px-2 py-0.5 rounded">
                                Score: {resp.aiOverallScore} / 160
                              </span>
                            )}
                          </div>

                          {resp?.audioBlobRef && (
                            <audio controls src={resp.audioBlobRef} className="w-full h-9" />
                          )}

                          <p className="text-xs text-slate-700 whitespace-pre-wrap bg-white p-3 rounded-lg border border-slate-200">
                            {resp?.textOrTranscript || '(No response recorded)'}
                          </p>

                          {resp?.aiFeedback?.suggestedFix && (
                            <p className="text-xs text-primary-800 bg-primary-50 p-2.5 rounded-lg border border-primary-200">
                              <strong>145+ Suggested Fix:</strong> {resp.aiFeedback.suggestedFix}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default HistoryPanel;
