import { useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { db, ensureDatabaseUpgraded } from '../../db/database';
import { checkLocalWhisperHealth } from '../../services/stt';
import type { SessionRun, DETQuestionType } from '../../types';
import { formatTime } from '../../utils/helpers';

export function PreSession() {
  const templates = useConfigStore((s) => s.templates);
  const loadTemplates = useConfigStore((s) => s.loadTemplates);
  const startSession = useSessionStore((s) => s.startSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const selectedTemplateId = useSessionStore((s) => s.selectedTemplateId);
  const setSelectedTemplateId = useSessionStore((s) => s.setSelectedTemplateId);

  const [incompleteRun, setIncompleteRun] = useState<SessionRun | null>(null);
  const [micStatus, setMicStatus] = useState<'unchecked' | 'granted' | 'denied'>('unchecked');
  const [whisperOnline, setWhisperOnline] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);

  // User customization states
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [customDurations, setCustomDurations] = useState<Record<string, number>>({});
  const [instantFeedback, setInstantFeedback] = useState<boolean>(true);
  const [preferredQuestionType, setPreferredQuestionType] = useState<DETQuestionType | 'all' | 'adaptive'>('adaptive');

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  useEffect(() => {
    ensureDatabaseUpgraded().then(() => loadTemplates());
    checkLocalWhisperHealth().then(setWhisperOnline);
    db.sessionRuns
      .where('status')
      .equals('in-progress')
      .reverse()
      .sortBy('startedAt')
      .then((inProgress) => {
        if (inProgress.length > 0) setIncompleteRun(inProgress[0]);
      });
  }, [loadTemplates]);

  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId, setSelectedTemplateId]);

  // Whenever selected template changes, select all its blocks by default
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
  const hasSpeakingBlock = activeBlocks.some((b) => b.type === 'speaking');
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
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* Interrupted Session Banner */}
      {incompleteRun && (
        <div className="mb-8 bg-amber-50 border border-amber-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold text-amber-900">⚠️ Incomplete Session Found</h3>
            <p className="text-xs text-amber-700 mt-0.5">
              Started {new Date(incompleteRun.startedAt).toLocaleString()} • Block{' '}
              {incompleteRun.currentBlockIndex + 1} of {incompleteRun.blockConfigs.length}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => resumeSession(incompleteRun)}
              className="px-4 py-2 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700"
            >
              ▶ Resume Session
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

      <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Configure & Start Practice</h2>
          <p className="text-sm text-slate-500">
            Choose a full template or select individual blocks, question types, and feedback mode.
          </p>
        </div>
        <span
          className={`text-xs font-medium px-3 py-1 rounded-full ${
            whisperOnline
              ? 'bg-green-100 text-green-800'
              : 'bg-slate-200 text-slate-700'
          }`}
        >
          {whisperOnline ? '🟢 Local Whisper GPU Ready' : '⚪ Local Whisper (Port 8000)'}
        </span>
      </div>

      {/* 1. Template Picker */}
      <div className="mb-6">
        <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
          1. Select Session Template
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

      {/* 2. Choose Full or Partial Blocks + Custom Durations */}
      {selectedTemplate && (
        <div className="mb-6 bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">
                2. Select Blocks to Run ({activeBlocks.length} of {selectedTemplate.blocks.length} selected)
              </h3>
              <p className="text-xs text-slate-500">
                Uncheck any block if you only want to drill specific parts today.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelectedBlockIds(selectedTemplate.blocks.map((b) => b.id))}
                className="text-xs text-primary-600 hover:underline font-medium"
              >
                Select All
              </button>
              <span className="text-slate-300">|</span>
              <span className="text-xs font-mono font-semibold text-slate-700">
                Total: {formatTime(totalSec)}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            {selectedTemplate.blocks.map((b, i) => {
              const checked = selectedBlockIds.includes(b.id);
              const durMin = Math.max(1, Math.round((customDurations[b.id] ?? b.durationSec) / 60));
              return (
                <div
                  key={b.id}
                  className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                    checked ? 'bg-slate-50 border-slate-200' : 'bg-slate-50/40 border-slate-100 opacity-50'
                  }`}
                >
                  <label className="flex items-center gap-3 cursor-pointer flex-1">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleBlockSelection(b.id)}
                      className="rounded text-primary-600 focus:ring-primary-500"
                    />
                    <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-700 text-xs flex items-center justify-center font-bold">
                      {i + 1}
                    </span>
                    <div>
                      <span className="text-sm font-semibold text-slate-800">{b.name}</span>
                      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-600">
                        {b.type}
                      </span>
                    </div>
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

      {/* 3. Feedback Mode & Question Type Filter */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            3. AI Feedback Timing
          </label>
          <div className="space-y-2">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="radio"
                checked={instantFeedback}
                onChange={() => setInstantFeedback(true)}
                className="mt-1 text-primary-600"
              />
              <div>
                <p className="text-sm font-semibold text-slate-800">⚡ Instant Per-Block Feedback</p>
                <p className="text-xs text-slate-500">
                  Grade any block immediately while practicing (pauses timer while reviewing).
                </p>
              </div>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="radio"
                checked={!instantFeedback}
                onChange={() => setInstantFeedback(false)}
                className="mt-1 text-primary-600"
              />
              <div>
                <p className="text-sm font-semibold text-slate-800">🎯 Exam Simulation Mode</p>
                <p className="text-xs text-slate-500">
                  No interruptions—evaluate all blocks together at the end of the session.
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            4. Question Selection Mode
          </label>
          <select
            value={preferredQuestionType}
            onChange={(e) =>
              setPreferredQuestionType(e.target.value as DETQuestionType | 'all' | 'adaptive')
            }
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-800 mb-2"
          >
            <option value="adaptive">⚡ Adaptive + SRS Due First (Recommended)</option>
            <option value="all">All Question Types</option>
            <option value="interactive-writing">✍️ Interactive Writing Only</option>
            <option value="write-about-photo">🖼️ Write About Photo Only</option>
            <option value="speaking-sample">🎤 Speaking Sample Only</option>
            <option value="interactive-speaking">🗣️ Interactive Speaking Only</option>
            <option value="read-aloud">📖 Read Aloud Only</option>
            <option value="listen-and-type">🎧 Listen & Type Only</option>
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

      {/* Start Button */}
      <button
        onClick={handleStart}
        disabled={!selectedTemplate || activeBlocks.length === 0 || starting}
        className="w-full py-4 bg-primary-600 text-white text-base font-bold rounded-xl hover:bg-primary-700 disabled:opacity-50 transition-colors cursor-pointer shadow-sm"
      >
        {starting
          ? 'Starting Session...'
          : `▶ Start Practice (${activeBlocks.length} Block${activeBlocks.length === 1 ? '' : 's'} • ${formatTime(totalSec)})`}
      </button>
    </div>
  );
}
