import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { db, ensureDatabaseUpgraded } from '../../db/database';
import type { SessionRun, DETQuestionType } from '../../types';
import { formatTime } from '../../utils/helpers';
import { extractRecurringErrors, type RecurringErrorItem } from '../../utils/errorLog';
import { WhisperLiveIndicator } from '../common/WhisperLiveIndicator';

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

  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [customDurations, setCustomDurations] = useState<Record<string, number>>({});
  const [instantFeedback, setInstantFeedback] = useState<boolean>(true);
  const [communicativePressure, setCommunicativePressure] = useState<boolean>(false);
  const [preferredQuestionType, setPreferredQuestionType] =
    useState<DETQuestionType | 'all' | 'adaptive'>('adaptive');

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  useEffect(() => {
    ensureDatabaseUpgraded().then(() => loadTemplates());
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

  const handleStart = async () => {
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
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setView('config')}
          className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 px-3.5 py-2 rounded-lg cursor-pointer"
        >
          ← Back to Dashboard
        </button>
        <WhisperLiveIndicator />
      </div>

      {recurringErrors.length > 0 && (
        <div className="mb-6 bg-amber-50 border-2 border-amber-200 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-900">
              Pre-Session Cognitive Priming: Top Recurring Error Log
            </h3>
            <span className="text-[11px] font-semibold text-amber-700">
              Consciously monitor these during output
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

      {incompleteRun && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold text-amber-900">Incomplete Session Found</h3>
            <p className="text-xs text-amber-700">
              Started {new Date(incompleteRun.startedAt).toLocaleString()} • Block{' '}
              {incompleteRun.currentBlockIndex + 1} of {incompleteRun.blockConfigs.length}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => resumeSession(incompleteRun)}
              className="px-4 py-2 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700"
            >
              Resume Session
            </button>
            <button
              onClick={handleDiscardIncomplete}
              className="px-3 py-2 text-xs text-amber-800 border border-amber-300 rounded-lg hover:bg-amber-100"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="mb-6">
        <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
          1. Select Practice Protocol / Template
        </label>
        <div className="grid gap-3">
          {templates.map((t) => (
            <label
              key={t.id}
              className={`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all ${
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
                  <p className="font-semibold text-slate-900">{t.name}</p>
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
      </div>

      {selectedTemplate && (
        <div className="mb-6 bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-slate-800">
              2. Select Blocks to Run ({activeBlocks.length} of {selectedTemplate.blocks.length})
            </h3>
            <span className="text-xs font-mono font-semibold text-slate-700">
              Total: {formatTime(totalSec)}
            </span>
          </div>
          <div className="space-y-2">
            {selectedTemplate.blocks.map((b, i) => {
              const checked = selectedBlockIds.includes(b.id);
              const durMin = Math.max(
                1,
                Math.round((customDurations[b.id] ?? b.durationSec) / 60)
              );
              return (
                <div
                  key={b.id}
                  className={`flex items-center justify-between p-3 rounded-lg border ${
                    checked ? 'bg-slate-50 border-slate-200' : 'opacity-50 border-slate-100'
                  }`}
                >
                  <label className="flex items-center gap-3 cursor-pointer flex-1">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleBlockSelection(b.id)}
                    />
                    <span className="text-sm font-semibold text-slate-800">
                      {i + 1}. {b.name}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-600">
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
                      className="w-16 px-2 py-1 text-xs font-mono border border-slate-300 rounded text-right"
                    />
                    <span className="text-xs text-slate-500">min</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">
            3. Deliberate Practice & Pressure Settings
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={instantFeedback}
              onChange={(e) => setInstantFeedback(e.target.checked)}
              className="mt-1"
            />
            <div>
              <p className="text-sm font-semibold text-slate-800">
                Instant Write-Critique-Rewrite Loop
              </p>
              <p className="text-xs text-slate-500">
                Grade immediately & unlock the "Apply Fixes & Rewrite/Re-record" button.
              </p>
            </div>
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer pt-2 border-t border-slate-100">
            <input
              type="checkbox"
              checked={communicativePressure}
              onChange={(e) => setCommunicativePressure(e.target.checked)}
              className="mt-1 accent-red-600"
            />
            <div>
              <p className="text-sm font-bold text-red-700">
                Strict Communicative Pressure Mode
              </p>
              <p className="text-xs text-slate-500">
                Disables Backspace/Delete in writing and hides Stop in speaking until timer ends.
              </p>
            </div>
          </label>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            4. Question Selection Mode
          </label>
          <select
            value={preferredQuestionType}
            onChange={(e) =>
              setPreferredQuestionType(
                e.target.value as DETQuestionType | 'all' | 'adaptive'
              )
            }
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-800 mb-2"
          >
            <option value="adaptive">Adaptive + SRS Due First (Recommended)</option>
            <option value="all">All Question Types</option>
            <option value="read-and-complete">✍️ Read & Complete (Letter Boxes) Only</option>
            <option value="interactive-reading">📖 Interactive Reading (6-Step Suite) Only</option>
            <option value="interactive-writing">📝 Interactive Writing Only</option>
            <option value="write-about-photo">🧩 Collocation Chunk Writing Only</option>
            <option value="speaking-sample">🎤 Speaking Sample Only</option>
            <option value="interactive-speaking">🎙️ Interactive Speaking Only</option>
            <option value="read-aloud">🗣️ Read Aloud / Shadowing Only</option>
            <option value="listen-and-type">🎧 Listen & Type / Dictogloss Only</option>
          </select>
          {hasSpeakingBlock && (
            <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
              <span className="text-xs text-slate-600">Microphone Status:</span>
              {micStatus === 'granted' ? (
                <span className="text-xs font-semibold text-green-600">✓ Mic Ready</span>
              ) : (
                <button
                  type="button"
                  onClick={handleMicCheck}
                  className="text-xs font-semibold text-primary-600 hover:underline"
                >
                  Test Microphone
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={handleStart}
        disabled={!selectedTemplate || activeBlocks.length === 0 || starting}
        className="w-full py-4 bg-primary-600 text-white text-base font-bold rounded-xl hover:bg-primary-700 disabled:opacity-50 cursor-pointer shadow-sm"
      >
        {starting
          ? 'Starting Session...'
          : `Start Practice (${activeBlocks.length} Block${activeBlocks.length === 1 ? '' : 's'} • ${formatTime(totalSec)})`}
      </button>
    </div>
  );
}
