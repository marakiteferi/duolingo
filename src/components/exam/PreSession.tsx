import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { db, ensureDatabaseUpgraded } from '../../db/database';
import type { SessionRun, DETQuestionType } from '../../types';
import { formatTime } from '../../utils/helpers';
import { extractRecurringErrors, type RecurringErrorItem } from '../../utils/errorLog';
import { WhisperLiveIndicator } from '../common/WhisperLiveIndicator';
import { StudyPlanDashboard } from '../config/StudyPlanDashboard';

export function PreSession() {
  const setView = useAppStore((s) => s.setView);
  const templates = useConfigStore((s) => s.templates);
  const loadTemplates = useConfigStore((s) => s.loadTemplates);
  const startSession = useSessionStore((s) => s.startSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const selectedTemplateId = useSessionStore((s) => s.selectedTemplateId);
  const setSelectedTemplateId = useSessionStore((s) => s.setSelectedTemplateId);

  const [incompleteRun, setIncompleteRun] = useState<SessionRun | null>(null);
  const [recurringErrors, setRecurringErrors] = useState<RecurringErrorItem[]>([]);
  const [micStatus, setMicStatus] = useState<'unchecked' | 'granted' | 'denied'>('unchecked');
  const [starting, setStarting] = useState(false);
  const [showCustomOverride, setShowCustomOverride] = useState(false);

  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [customDurations, setCustomDurations] = useState<Record<string, number>>({});
  const [instantFeedback, setInstantFeedback] = useState<boolean>(true);
  const [communicativePressure, setCommunicativePressure] = useState<boolean>(false);
  const [preferredQuestionType, setPreferredQuestionType] =
    useState<DETQuestionType | 'all' | 'adaptive'>('adaptive');

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  useEffect(() => {
    void ensureDatabaseUpgraded().then(() => loadTemplates());
    db.sessionRuns
      .orderBy('startedAt')
      .reverse()
      .toArray()
      .then((allRuns) => {
        const inProg = allRuns.find((r) => r.status === 'in-progress');
        if (inProg) setIncompleteRun(inProg);
        setRecurringErrors(extractRecurringErrors(allRuns, 3));
      });
  }, [loadTemplates]);

  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId, setSelectedTemplateId]);

  useEffect(() => {
    if (selectedTemplate) {
      setSelectedBlockIds(selectedTemplate.blocks.map((b) => b.id));
      const durations: Record<string, number> = {};
      for (const b of selectedTemplate.blocks) {
        durations[b.id] = b.durationSec;
      }
      setCustomDurations(durations);
    }
  }, [selectedTemplate]);

  const activeBlocks =
    selectedTemplate?.blocks.filter((b) => selectedBlockIds.includes(b.id)) ?? [];
  const hasSpeakingBlock = activeBlocks.some(
    (b) => b.type === 'speaking' || b.type === 'shadowing'
  );
  const totalSec = activeBlocks.reduce(
    (sum, b) => sum + (customDurations[b.id] ?? b.durationSec),
    0
  );

  const toggleBlockSelection = (blockId: string) => {
    setSelectedBlockIds((prev) =>
      prev.includes(blockId) ? prev.filter((id) => id !== blockId) : [...prev, blockId]
    );
  };

  const handleMicCheck = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
    } catch {
      setMicStatus('denied');
    }
  };

  const handleStartCustom = async () => {
    if (!selectedTemplate || activeBlocks.length === 0) return;
    setStarting(true);
    await startSession(selectedTemplate, {
      selectedBlockIds,
      customDurations,
      instantFeedback,
      communicativePressure,
      preferredQuestionType,
    });
  };

  const handleDiscardIncomplete = async () => {
    if (!incompleteRun) return;
    await db.sessionRuns.update(incompleteRun.id, {
      status: 'abandoned',
      endedAt: new Date().toISOString(),
    });
    setIncompleteRun(null);
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setView('config')}
          className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 px-3.5 py-2 rounded-lg cursor-pointer"
        >
          ← Back to Config & Question Bank
        </button>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 px-3 py-1.5 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={instantFeedback}
              onChange={(e) => setInstantFeedback(e.target.checked)}
            />
            Instant AI Critique Loop
          </label>
          <label className="flex items-center gap-1.5 text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-3 py-1.5 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={communicativePressure}
              onChange={(e) => setCommunicativePressure(e.target.checked)}
              className="accent-red-600"
            />
            Strict Pressure Mode (No Backspace)
          </label>
          <WhisperLiveIndicator />
        </div>
      </div>

      {incompleteRun && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold text-amber-900">Incomplete Session Found</h3>
            <p className="text-xs text-amber-700">
              {incompleteRun.templateName} • Started{' '}
              {new Date(incompleteRun.startedAt).toLocaleString()} • Block{' '}
              {incompleteRun.currentBlockIndex + 1} of {incompleteRun.blockConfigs.length}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => resumeSession(incompleteRun)}
              className="px-4 py-2 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700 cursor-pointer"
            >
              Resume Session
            </button>
            <button
              onClick={handleDiscardIncomplete}
              className="px-3 py-2 text-xs text-amber-800 border border-amber-300 rounded-lg hover:bg-amber-100 cursor-pointer"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {recurringErrors.length > 0 && (
        <div className="bg-amber-50/90 border-2 border-amber-200 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-900">
              Pre-Session Cognitive Priming: Top Recurring Error Log
            </h3>
            <span className="text-[11px] font-semibold text-amber-700">
              Consciously monitor these during today's 3 sessions
            </span>
          </div>
          <ul className="space-y-1.5">
            {recurringErrors.map((err, i) => (
              <li
                key={i}
                className="text-xs text-slate-800 flex items-start justify-between gap-2 bg-white/80 p-2 rounded-lg border border-amber-100"
              >
                <span>
                  <strong className="uppercase text-[10px] px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 mr-2">
                    {err.category}
                  </strong>
                  {err.issue}
                </span>
                <span className="text-[11px] font-mono font-bold text-amber-800 shrink-0">
                  {err.count}x
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Primary 21-Day Study Plan & 3 Daily Sessions Launcher */}
      <StudyPlanDashboard
        instantFeedback={instantFeedback}
        communicativePressure={communicativePressure}
      />

      {/* Collapsible Custom Block / Template Override Section */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-800">
              ⚙️ Custom Template & Individual Block Overrides
            </h3>
            <p className="text-xs text-slate-500">
              Want to drill a single block, adjust block minutes, or test your microphone? Expand below.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowCustomOverride((v) => !v)}
            className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg cursor-pointer"
          >
            {showCustomOverride ? '▴ Hide Custom Overrides' : '▾ Open Custom Block Selector'}
          </button>
        </div>

        {showCustomOverride && (
          <div className="space-y-5 pt-3 border-t border-slate-100">
            <div className="grid gap-2.5">
              {templates.map((t) => (
                <label
                  key={t.id}
                  className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                    selectedTemplateId === t.id
                      ? 'border-primary-500 bg-primary-50/60'
                      : 'border-slate-200 bg-white hover:border-primary-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="template"
                    checked={selectedTemplateId === t.id}
                    onChange={() => setSelectedTemplateId(t.id)}
                    className="mt-1 text-primary-600"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-sm text-slate-900">{t.name}</p>
                      <span className="text-xs font-mono text-slate-500">
                        {t.blocks.length} blocks
                      </span>
                    </div>
                    {t.description && (
                      <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>
                    )}
                  </div>
                </label>
              ))}
            </div>

            {selectedTemplate && (
              <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-2">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-bold text-slate-700">
                    Select Blocks to Run ({activeBlocks.length} of {selectedTemplate.blocks.length})
                  </h4>
                  <span className="text-xs font-mono font-semibold text-slate-700">
                    Total: {formatTime(totalSec)}
                  </span>
                </div>
                {selectedTemplate.blocks.map((b, i) => {
                  const checked = selectedBlockIds.includes(b.id);
                  const durMin = Math.max(
                    1,
                    Math.round((customDurations[b.id] ?? b.durationSec) / 60)
                  );
                  return (
                    <div
                      key={b.id}
                      className={`flex items-center justify-between p-2.5 rounded-lg border bg-white ${
                        checked ? 'border-slate-200' : 'opacity-50 border-slate-100'
                      }`}
                    >
                      <label className="flex items-center gap-3 cursor-pointer flex-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBlockSelection(b.id)}
                        />
                        <span className="text-xs font-semibold text-slate-800">
                          {i + 1}. {b.name}
                        </span>
                        <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                          {b.type}
                        </span>
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={60}
                          value={durMin}
                          onChange={(e) =>
                            setCustomDurations((prev) => ({
                              ...prev,
                              [b.id]: Math.max(1, Number(e.target.value)) * 60,
                            }))
                          }
                          className="w-14 px-2 py-1 text-xs font-mono border border-slate-300 rounded text-right"
                        />
                        <span className="text-xs text-slate-500">min</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-slate-600">Question Filter:</label>
                <select
                  value={preferredQuestionType}
                  onChange={(e) =>
                    setPreferredQuestionType(
                      e.target.value as DETQuestionType | 'all' | 'adaptive'
                    )
                  }
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-medium text-slate-800"
                >
                  <option value="adaptive">✨ Unseen-First + Adaptive (Recommended)</option>
                  <option value="all">All Question Types</option>
                  <option value="read-and-complete">✍️ Read & Complete Only</option>
                  <option value="interactive-reading">📖 Interactive Reading Only</option>
                  <option value="interactive-writing">📝 Interactive Writing Only</option>
                  <option value="write-about-photo">🧩 Collocation Chunk Writing Only</option>
                  <option value="speaking-sample">🎤 Speaking Sample Only</option>
                  <option value="interactive-speaking">🎙️ Interactive Speaking Only</option>
                </select>
              </div>

              {hasSpeakingBlock && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-600">Microphone:</span>
                  {micStatus === 'granted' ? (
                    <span className="text-xs font-semibold text-green-600">✓ Mic Ready</span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleMicCheck}
                      className="text-xs font-semibold text-primary-600 hover:underline cursor-pointer"
                    >
                      Test Microphone
                    </button>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={handleStartCustom}
              disabled={!selectedTemplate || activeBlocks.length === 0 || starting}
              className="w-full py-3.5 bg-slate-900 text-white text-sm font-bold rounded-xl hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
            >
              {starting
                ? 'Starting Custom Session...'
                : `Start Custom Session (${activeBlocks.length} Block${activeBlocks.length === 1 ? '' : 's'} • ${formatTime(totalSec)})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
