// upgrade-21day-phase3-study-plan-ui.mjs
// Phase 3 of 3: 21-Day Study Plan Dashboard, 3-Session Daily Goal Tracker,
// Unseen Question Bank Meter, and 1-Click Daily Session Launching.
// Run from project root: node upgrade-21day-phase3-study-plan-ui.mjs

import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. 21-DAY STUDY PLAN DASHBOARD & 3-SESSION DAILY GOAL HUB
  // =========================================================================
  'src/components/config/StudyPlanDashboard.tsx': `import { useState, useEffect, useCallback } from 'react';
import { db, ensureDatabaseUpgraded } from '../../db/database';
import {
  getCompletedQuestionIds,
  resetAllQuestionCompletions,
} from '../../utils/adaptive';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useConfigStore } from '../../stores/configStore';
import type { QuestionBankItem, SessionTemplate, Settings } from '../../types';
import { formatTime } from '../../utils/helpers';

interface DailySlotConfig {
  slotIndex: 1 | 2 | 3;
  templateId: string;
  badge: string;
  title: string;
  subtitle: string;
  durationLabel: string;
  skills: string[];
}

const DAILY_SLOTS: DailySlotConfig[] = [
  {
    slotIndex: 1,
    templateId: 'tpl-daily-session-1-reading-vocab',
    badge: 'Session 1 of 3 • Morning / Part 1',
    title: 'Reading & Lexical Precision',
    subtitle:
      'Unseen Read & Complete (3m) → 6-Step Interactive Reading (7m) → 4-Chunk Collocation Paragraph (5m)',
    durationLabel: '15 min',
    skills: ['Read & Complete', 'Interactive Reading', 'Collocation Chunks'],
  },
  {
    slotIndex: 2,
    templateId: 'tpl-daily-session-2-listening-shadowing',
    badge: 'Session 2 of 3 • Midday / Part 2',
    title: 'Listening, Shadowing & Dictogloss',
    subtitle:
      'Auditory-Motor Prosody Shadowing (4m) → Dictogloss Working-Memory Reconstruction (5m) → 90s Speaking (3m)',
    durationLabel: '12 min',
    skills: ['TED Shadowing', 'Dictogloss', 'Interactive Speaking'],
  },
  {
    slotIndex: 3,
    templateId: 'tpl-daily-session-3-production-mock',
    badge: 'Session 3 of 3 • Evening / Part 3',
    title: 'Interactive Writing & Speaking Production',
    subtitle:
      'Timed Interactive Writing Essay (5m) → Collocation Application Drill (4m) → 90s Speaking Sample (3m)',
    durationLabel: '12 min',
    skills: ['Interactive Writing', 'Collocation Chunks', 'Speaking Sample'],
  },
];

const WEEK_THEMES: { week: number; title: string; days: number[] }[] = [
  {
    week: 1,
    title: 'Week 1 (Days 1–7): Foundation, C-Test Orthography & Core Collocations',
    days: [1, 2, 3, 4, 5, 6, 7],
  },
  {
    week: 2,
    title: 'Week 2 (Days 8–14): Syntactic Subordination, Discourse Bridging & Pacing',
    days: [8, 9, 10, 11, 12, 13, 14],
  },
  {
    week: 3,
    title: 'Week 3 (Days 15–21): High-Stakes 140–150 Exam Stamina & Verbatim Fluency',
    days: [15, 16, 17, 18, 19, 20, 21],
  },
];

export function StudyPlanDashboard({
  instantFeedback = true,
  communicativePressure = false,
}: {
  instantFeedback?: boolean;
  communicativePressure?: boolean;
}) {
  const startSession = useSessionStore((s) => s.startSession);
  const setView = useAppStore((s) => s.setView);
  const loadQuestionsStore = useConfigStore((s) => s.loadQuestions);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedDay, setSelectedDay] = useState<number>(1);
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [completedQIds, setCompletedQIds] = useState<Set<string>>(new Set());
  const [launchingSlot, setLaunchingSlot] = useState<number | null>(null);

  const loadPlanState = useCallback(async () => {
    await ensureDatabaseUpgraded();
    const [savedSettings, allTemplates, allQuestions, doneIds] = await Promise.all([
      db.settings.get('app-settings'),
      db.sessionTemplates.toArray(),
      db.questionBank.toArray(),
      getCompletedQuestionIds(),
    ]);

    if (savedSettings) {
      setSettings(savedSettings);
      setSelectedDay(savedSettings.currentPlanDay ?? 1);
    }
    setTemplates(allTemplates);
    setQuestions(allQuestions);
    setCompletedQIds(doneIds);
  }, []);

  useEffect(() => {
    void loadPlanState();
  }, [loadPlanState]);

  const completedSlots = settings?.completedPlanSlots ?? {};

  const isSlotDone = (day: number, slotIndex: 1 | 2 | 3): boolean => {
    return Boolean(completedSlots[\`day-\${day}-session-\${slotIndex}\`]);
  };

  const getDayCompletedCount = (day: number): number => {
    return (
      (isSlotDone(day, 1) ? 1 : 0) +
      (isSlotDone(day, 2) ? 1 : 0) +
      (isSlotDone(day, 3) ? 1 : 0)
    );
  };

  const handleToggleSlotManual = async (day: number, slotIndex: 1 | 2 | 3) => {
    if (!settings) return;
    const key = \`day-\${day}-session-\${slotIndex}\`;
    const nextSlots = { ...(settings.completedPlanSlots ?? {}) };
    if (nextSlots[key]) {
      delete nextSlots[key];
    } else {
      nextSlots[key] = new Date().toISOString();
    }
    const updated: Settings = {
      ...settings,
      completedPlanSlots: nextSlots,
    };
    await db.settings.put(updated);
    setSettings(updated);
  };

  const handleSetActiveDay = async (day: number) => {
    setSelectedDay(day);
    if (!settings) return;
    const updated: Settings = {
      ...settings,
      currentPlanDay: day,
    };
    await db.settings.put(updated);
    setSettings(updated);
  };

  const handleLaunchSlot = async (slot: DailySlotConfig) => {
    const tpl =
      templates.find((t) => t.id === slot.templateId) ?? templates[0];
    if (!tpl) return;
    setLaunchingSlot(slot.slotIndex);
    await handleSetActiveDay(selectedDay);
    await startSession(tpl, {
      instantFeedback,
      communicativePressure,
      preferredQuestionType: 'adaptive',
      planDay: selectedDay,
      planSlotIndex: slot.slotIndex,
    });
    setView('exam');
  };

  const handleResetAllProgress = async () => {
    if (
      !window.confirm(
        'Reset your 21-day session checkmarks and mark all questions as Unseen again?'
      )
    ) {
      return;
    }
    await resetAllQuestionCompletions();
    if (settings) {
      const updated: Settings = {
        ...settings,
        currentPlanDay: 1,
        completedPlanSlots: {},
        studyPlanStartDate: new Date().toISOString(),
      };
      await db.settings.put(updated);
      setSettings(updated);
      setSelectedDay(1);
    }
    await loadPlanState();
    await loadQuestionsStore();
  };

  // Compute overall 21-day statistics
  const totalSlotsCompleted = Object.keys(completedSlots).length;
  const totalDaysFullyCompleted = Array.from({ length: 21 }, (_, i) => i + 1).filter(
    (d) => getDayCompletedCount(d) === 3
  ).length;
  const currentDayCompletedCount = getDayCompletedCount(selectedDay);

  // Compute unseen question bank counts by category
  const readingTotal = questions.filter((q) => q.skill === 'reading').length;
  const readingUnseen = questions.filter(
    (q) => q.skill === 'reading' && !completedQIds.has(q.id)
  ).length;

  const writingTotal = questions.filter((q) => q.skill === 'writing').length;
  const writingUnseen = questions.filter(
    (q) => q.skill === 'writing' && !completedQIds.has(q.id)
  ).length;

  const speakingTotal = questions.filter(
    (q) =>
      q.skill === 'speaking' &&
      (q.type === 'speaking-sample' || q.type === 'interactive-speaking')
  ).length;
  const speakingUnseen = questions.filter(
    (q) =>
      q.skill === 'speaking' &&
      (q.type === 'speaking-sample' || q.type === 'interactive-speaking') &&
      !completedQIds.has(q.id)
  ).length;

  const audioTotal = questions.filter(
    (q) => q.type === 'read-aloud' || q.skill === 'listening'
  ).length;
  const audioUnseen = questions.filter(
    (q) =>
      (q.type === 'read-aloud' || q.skill === 'listening') &&
      !completedQIds.has(q.id)
  ).length;

  return (
    <div className="space-y-6">
      {/* =================================================================== */}
      {/* TOP HERO: 21-DAY PROGRESS & UNSEEN QUESTION BANK TELEMETRY          */}
      {/* =================================================================== */}
      <div className="bg-slate-900 text-white rounded-2xl p-6 shadow-md border border-slate-800 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="px-2.5 py-1 rounded-full bg-primary-500 text-slate-950 text-xs font-extrabold uppercase tracking-wider">
                Day {selectedDay} of 21
              </span>
              <span className="text-xs font-semibold text-slate-300">
                Target Score Band: 140–150 (C1/C2 Academic English)
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold mt-2">
              21-Day Structured DET Study Plan
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-0.5">
                Complete all 3 focused sessions each day (~39 mins total). Every block automatically serves fresh, unseen DET questions.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={selectedDay <= 1}
              onClick={() => void handleSetActiveDay(Math.max(1, selectedDay - 1))}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg disabled:opacity-40 cursor-pointer"
            >
              ← Day {Math.max(1, selectedDay - 1)}
            </button>
            <button
              type="button"
              disabled={selectedDay >= 21}
              onClick={() => void handleSetActiveDay(Math.min(21, selectedDay + 1))}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg disabled:opacity-40 cursor-pointer"
            >
              Day {Math.min(21, selectedDay + 1)} →
            </button>
            <button
              type="button"
              onClick={handleResetAllProgress}
              className="px-3 py-1.5 bg-slate-800 hover:bg-red-950 text-slate-400 hover:text-red-300 border border-slate-700 text-xs font-semibold rounded-lg cursor-pointer"
            >
              ↺ Reset 21-Day Cycle
            </button>
          </div>
        </div>

        {/* Progress Counters & Unseen Bank Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-1">
          <div className="bg-slate-800/90 border border-slate-700 rounded-xl p-3">
            <p className="text-[11px] text-slate-400 font-semibold">Today's Goal (Day {selectedDay})</p>
            <p className="text-lg font-extrabold text-primary-400 mt-0.5">
              {currentDayCompletedCount} / 3 Sessions
            </p>
          </div>
          <div className="bg-slate-800/90 border border-slate-700 rounded-xl p-3">
            <p className="text-[11px] text-slate-400 font-semibold">21-Day Total Progress</p>
            <p className="text-lg font-extrabold text-white mt-0.5">
              {totalSlotsCompleted} / 63 ({totalDaysFullyCompleted}d done)
            </p>
          </div>
          <div className="bg-slate-800/90 border border-slate-700 rounded-xl p-3">
            <p className="text-[11px] text-slate-400 font-semibold">📖 Unseen Reading</p>
            <p className="text-lg font-extrabold text-emerald-400 mt-0.5">
              {readingUnseen} / {readingTotal} left
            </p>
          </div>
          <div className="bg-slate-800/90 border border-slate-700 rounded-xl p-3">
            <p className="text-[11px] text-slate-400 font-semibold">✍️ Unseen Writing/Chunks</p>
            <p className="text-lg font-extrabold text-emerald-400 mt-0.5">
              {writingUnseen} / {writingTotal} left
            </p>
          </div>
          <div className="bg-slate-800/90 border border-slate-700 rounded-xl p-3">
            <p className="text-[11px] text-slate-400 font-semibold">🎙️ Unseen Speaking</p>
            <p className="text-lg font-extrabold text-emerald-400 mt-0.5">
              {speakingUnseen} / {speakingTotal} left
            </p>
          </div>
          <div className="bg-slate-800/90 border border-slate-700 rounded-xl p-3">
            <p className="text-[11px] text-slate-400 font-semibold">🎧 Unseen Audio/Shadow</p>
            <p className="text-lg font-extrabold text-emerald-400 mt-0.5">
              {audioUnseen} / {audioTotal} left
            </p>
          </div>
        </div>
      </div>

      {/* =================================================================== */}
      {/* TODAY'S 3 DAILY GOAL SESSIONS (1-CLICK LAUNCH CARDS)                */}
      {/* =================================================================== */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-bold text-slate-900">
            🎯 Day {selectedDay} Daily Sessions ({currentDayCompletedCount}/3 Completed)
          </h3>
          {currentDayCompletedCount === 3 && selectedDay < 21 && (
            <button
              type="button"
              onClick={() => void handleSetActiveDay(selectedDay + 1)}
              className="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-lg cursor-pointer shadow-xs"
            >
              🎉 Day {selectedDay} Complete! Advance to Day {selectedDay + 1} →
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {DAILY_SLOTS.map((slot) => {
            const done = isSlotDone(selectedDay, slot.slotIndex);
            const matchedTpl = templates.find((t) => t.id === slot.templateId);
            const totalSec = matchedTpl
              ? matchedTpl.blocks.reduce((sum, b) => sum + b.durationSec, 0)
              : 15 * 60;

            return (
              <div
                key={slot.slotIndex}
                className={\`rounded-2xl border-2 p-5 flex flex-col justify-between transition-all \${
                  done
                    ? 'bg-green-50/70 border-green-400 shadow-2xs'
                    : 'bg-white border-slate-200 hover:border-primary-400 shadow-xs'
                }\`}
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={\`text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full \${
                        done
                          ? 'bg-green-600 text-white'
                          : 'bg-primary-100 text-primary-800'
                      }\`}
                    >
                      {done ? \`✓ Session \${slot.slotIndex} Done\` : slot.badge}
                    </span>
                    <span className="text-xs font-mono font-bold text-slate-500">
                      {formatTime(totalSec)}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-slate-900">{slot.title}</h4>
                    <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                      {slot.subtitle}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {slot.skills.map((sk) => (
                      <span
                        key={sk}
                        className="text-[11px] font-semibold bg-slate-100 text-slate-700 px-2 py-0.5 rounded"
                      >
                        {sk}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="pt-4 mt-4 border-t border-slate-200/80 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={launchingSlot !== null}
                    onClick={() => void handleLaunchSlot(slot)}
                    className={\`flex-1 py-2.5 px-4 rounded-xl text-xs font-bold cursor-pointer transition-colors shadow-2xs \${
                      done
                        ? 'bg-slate-900 hover:bg-slate-800 text-white'
                        : 'bg-primary-600 hover:bg-primary-700 text-white'
                    }\`}
                  >
                    {launchingSlot === slot.slotIndex
                      ? 'Starting...'
                      : done
                      ? \`↻ Practice Session \${slot.slotIndex} Again\`
                      : \`▶ Start Session \${slot.slotIndex} (\${slot.durationLabel})\`}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleToggleSlotManual(selectedDay, slot.slotIndex)}
                    title={done ? 'Mark as incomplete' : 'Mark as completed'}
                    className={\`px-2.5 py-2.5 rounded-xl border text-xs font-bold cursor-pointer \${
                      done
                        ? 'bg-green-100 border-green-400 text-green-800 hover:bg-green-200'
                        : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                    }\`}
                  >
                    ✓
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* =================================================================== */}
      {/* 21-DAY CALENDAR MATRIX (3 WEEKS x 7 DAYS)                           */}
      {/* =================================================================== */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              📅 21-Day Roadmap & Daily Session Checkoff Grid
            </h3>
            <p className="text-xs text-slate-500">
              Click any day below to inspect or launch its 3 sessions. Each dot represents Session 1, Session 2, and Session 3.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> Completed Slot
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300 inline-block" /> Pending Slot
            </span>
          </div>
        </div>

        <div className="space-y-4">
          {WEEK_THEMES.map((wk) => (
            <div key={wk.week} className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                {wk.title}
              </p>
              <div className="grid grid-cols-7 gap-2">
                {wk.days.map((dayNum) => {
                  const s1 = isSlotDone(dayNum, 1);
                  const s2 = isSlotDone(dayNum, 2);
                  const s3 = isSlotDone(dayNum, 3);
                  const count = (s1 ? 1 : 0) + (s2 ? 1 : 0) + (s3 ? 1 : 0);
                  const isSelected = selectedDay === dayNum;
                  const isAllDone = count === 3;

                  return (
                    <button
                      key={dayNum}
                      type="button"
                      onClick={() => void handleSetActiveDay(dayNum)}
                      className={\`p-2.5 rounded-xl border-2 text-left transition-all cursor-pointer flex flex-col justify-between \${
                        isSelected
                          ? 'border-primary-600 bg-primary-50/80 ring-2 ring-primary-200'
                          : isAllDone
                          ? 'border-green-400 bg-green-50/60 hover:border-green-500'
                          : 'border-slate-200 bg-slate-50/60 hover:border-slate-300'
                      }\`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="text-xs font-extrabold text-slate-800">
                          Day {dayNum}
                        </span>
                        {isAllDone && (
                          <span className="text-[10px] font-bold bg-green-600 text-white px-1.5 py-0.2 rounded">
                            ✓
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 mt-2">
                        {[s1, s2, s3].map((done, idx) => (
                          <span
                            key={idx}
                            className={\`w-2.5 h-2.5 rounded-full \${
                              done ? 'bg-green-500' : 'bg-slate-300'
                            }\`}
                          />
                        ))}
                        <span className="ml-auto text-[10px] font-mono font-bold text-slate-500">
                          {count}/3
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
`,

  // =========================================================================
  // 2. TEMPLATE EDITOR: Top Tab Switcher (21-Day Plan + Custom Session Architect)
  // =========================================================================
  'src/components/config/TemplateEditor.tsx': `import { useEffect, useState } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { ensureDatabaseUpgraded } from '../../db/database';
import { StudyPlanDashboard } from './StudyPlanDashboard';
import type {
  Block,
  BlockType,
  DETQuestionType,
  QuestionBankItem,
  SessionTemplate,
} from '../../types';
import { formatTime, generateId } from '../../utils/helpers';

const BLOCK_TYPE_OPTIONS: { value: BlockType; label: string; badge: string }[] = [
  { value: 'interactive-reading', label: '📖 Interactive Reading & Read/Complete', badge: 'Reading' },
  { value: 'shadowing', label: '🗣️ Arguelles Shadowing (TED / Human Audio)', badge: 'Speaking/Audio' },
  { value: 'dictogloss', label: '🎧 Dictogloss Working-Memory Reconstruction', badge: 'Listening' },
  { value: 'vocab-writing', label: '🧩 Collocation Chunk Writing (SRS)', badge: 'Writing' },
  { value: 'speaking', label: '🎙️ Timed Verbatim Speaking', badge: 'Speaking' },
  { value: 'brain-dump', label: '📝 Brain Dump & Structural Outline', badge: 'Writing' },
  { value: 'mock-test', label: '🎯 Timed Adaptive Mock Test', badge: 'All Skills' },
  { value: 'custom', label: '⚙️ Custom Block', badge: 'Custom' },
];

const SUBTYPE_OPTIONS_BY_BLOCK: Partial<
  Record<BlockType, { value: DETQuestionType | 'adaptive'; label: string }[]>
> = {
  'interactive-reading': [
    { value: 'read-and-complete', label: '✍️ Read & Complete (1-Letter-Per-Box Cloze)' },
    { value: 'interactive-reading', label: '📖 Interactive Reading (6-Step Suite)' },
  ],
  'mock-test': [
    { value: 'adaptive', label: '🎯 Adaptive (Targets Weakest Skill)' },
    { value: 'read-and-complete', label: '✍️ Read & Complete (Letter Boxes)' },
    { value: 'interactive-reading', label: '📖 Interactive Reading (6-Step Suite)' },
    { value: 'interactive-writing', label: '📝 Interactive Writing' },
    { value: 'write-about-photo', label: '🧩 Collocation Chunk Writing' },
    { value: 'listen-and-type', label: '🎧 Listen & Type / Dictogloss' },
    { value: 'read-aloud', label: '🗣️ Read Aloud / Shadowing' },
    { value: 'interactive-speaking', label: '🎙️ Interactive Speaking' },
    { value: 'speaking-sample', label: '🎤 Speaking Sample' },
  ],
  speaking: [
    { value: 'adaptive', label: '🎯 Any Speaking Prompt (Adaptive)' },
    { value: 'speaking-sample', label: '🎤 Speaking Sample (90s Monologue)' },
    { value: 'interactive-speaking', label: '🎙️ Interactive Speaking' },
  ],
};

const QUICK_DURATION_PRESETS: { label: string; sec: number }[] = [
  { label: '60s', sec: 60 },
  { label: '90s', sec: 90 },
  { label: '3m', sec: 180 },
  { label: '5m', sec: 300 },
  { label: '8m', sec: 480 },
];

function getEligibleQuestionsForBlock(
  block: Block,
  allQuestions: QuestionBankItem[]
): QuestionBankItem[] {
  switch (block.type) {
    case 'interactive-reading':
      if (block.preferredQuestionType === 'read-and-complete') {
        return allQuestions.filter((q) => q.type === 'read-and-complete');
      }
      if (block.preferredQuestionType === 'interactive-reading') {
        return allQuestions.filter((q) => q.type === 'interactive-reading');
      }
      return allQuestions.filter(
        (q) => q.type === 'read-and-complete' || q.type === 'interactive-reading'
      );
    case 'shadowing':
      return allQuestions.filter(
        (q) =>
          Boolean(q.audioUrl) ||
          Boolean(q.youtubeSource) ||
          q.tags.includes('shadowing') ||
          q.type === 'read-aloud'
      );
    case 'dictogloss':
      return allQuestions.filter(
        (q) =>
          Boolean(q.audioUrl) ||
          q.tags.includes('dictogloss') ||
          q.skill === 'listening'
      );
    case 'vocab-writing':
      return allQuestions.filter(
        (q) => q.skill === 'writing' || q.tags.includes('vocab') || Boolean(q.targetChunks?.length)
      );
    case 'speaking':
      return allQuestions.filter(
        (q) =>
          q.skill === 'speaking' &&
          (q.type === 'speaking-sample' || q.type === 'interactive-speaking')
      );
    case 'brain-dump':
      return allQuestions.filter((q) => q.skill === 'writing');
    case 'mock-test':
      if (block.preferredQuestionType && block.preferredQuestionType !== 'adaptive') {
        return allQuestions.filter((q) => q.type === block.preferredQuestionType);
      }
      return allQuestions;
    default:
      return allQuestions;
  }
}

export function TemplateEditor() {
  const templates = useConfigStore((s) => s.templates);
  const loadTemplates = useConfigStore((s) => s.loadTemplates);
  const questions = useConfigStore((s) => s.questions);
  const loadQuestions = useConfigStore((s) => s.loadQuestions);
  const evalPrompts = useConfigStore((s) => s.evalPrompts);
  const loadEvalPrompts = useConfigStore((s) => s.loadEvalPrompts);
  const editingTemplate = useConfigStore((s) => s.editingTemplate);
  const setEditingTemplate = useConfigStore((s) => s.setEditingTemplate);
  const createTemplate = useConfigStore((s) => s.createTemplate);
  const saveTemplate = useConfigStore((s) => s.saveTemplate);
  const deleteTemplate = useConfigStore((s) => s.deleteTemplate);
  const duplicateTemplate = useConfigStore((s) => s.duplicateTemplate);

  const setSelectedTemplateId = useSessionStore((s) => s.setSelectedTemplateId);
  const setView = useAppStore((s) => s.setView);

  const [activeTab, setActiveTab] = useState<'plan' | 'architect'>('plan');

  useEffect(() => {
    void ensureDatabaseUpgraded().then(() => {
      void loadTemplates();
      void loadQuestions();
      void loadEvalPrompts();
    });
  }, [loadTemplates, loadQuestions, loadEvalPrompts]);

  const findEvalIdForType = (type: BlockType): string => {
    return (
      evalPrompts.find((ep) => ep.appliesToType === type)?.id ??
      evalPrompts[0]?.id ??
      ''
    );
  };

  const handleLaunchTemplateInExam = (templateId: string) => {
    setSelectedTemplateId(templateId);
    setView('exam');
  };

  const handleCreatePresetBlueprint = (
    preset: 'full-det' | 'audio-bootcamp' | 'reading-sprint'
  ) => {
    setActiveTab('architect');
    const now = new Date().toISOString();
    let blueprint: SessionTemplate;

    if (preset === 'full-det') {
      blueprint = {
        id: generateId(),
        name: 'Full DET 140–150 High-Stakes Simulation',
        description:
          'Read & Complete (3m) -> 6-Step Interactive Reading (8m) -> Collocation Writing (5m) -> Dictogloss (4m) -> 90s Verbatim Speaking.',
        createdAt: now,
        updatedAt: now,
        blocks: [
          {
            id: generateId(),
            name: '1. Read & Complete (1-Letter-Per-Box Cloze)',
            type: 'interactive-reading',
            preferredQuestionType: 'read-and-complete',
            durationSec: 180,
            instructions: 'Complete all missing word suffixes under strict time pressure.',
            autoAdvance: true,
            evalPromptId: findEvalIdForType('interactive-reading'),
          },
          {
            id: generateId(),
            name: '2. Interactive Reading (6-Step Suite)',
            type: 'interactive-reading',
            preferredQuestionType: 'interactive-reading',
            durationSec: 480,
            instructions: 'Complete all 6 steps of the academic passage.',
            autoAdvance: true,
            evalPromptId: findEvalIdForType('interactive-reading'),
          },
          {
            id: generateId(),
            name: '3. Collocation Chunk Precision Writing',
            type: 'vocab-writing',
            durationSec: 300,
            instructions: 'Incorporate all 4 C1/C2 multi-word collocation chunks.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('vocab-writing'),
          },
          {
            id: generateId(),
            name: '4. Dictogloss Lecture Reconstruction',
            type: 'dictogloss',
            durationSec: 240,
            instructions: 'Listen twice with fragment notes, then reconstruct the thesis.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('dictogloss'),
          },
          {
            id: generateId(),
            name: '5. 90-Second Verbatim Speaking Sample',
            type: 'speaking',
            preferredQuestionType: 'speaking-sample',
            durationSec: 90,
            instructions: 'Speak continuously for 90 seconds with complex subordination.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('speaking'),
          },
        ],
      };
    } else if (preset === 'audio-bootcamp') {
      blueprint = {
        id: generateId(),
        name: 'YouTube TED Shadowing & Dictogloss Bootcamp',
        description:
          'Warm-up Shadowing (1.0x) -> Blind Shadowing -> Dictogloss Reconstruction -> 90s Spoken Transfer.',
        createdAt: now,
        updatedAt: now,
        blocks: [
          {
            id: generateId(),
            name: '1. TED Talk Shadowing (Transcript Visible)',
            type: 'shadowing',
            durationSec: 180,
            speechSpeed: 1.0,
            blindShadowing: false,
            instructions: 'Shadow the human speaker with a 0.5s lag, matching pitch and stress.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('shadowing'),
          },
          {
            id: generateId(),
            name: '2. Blind Auditory-Motor Shadowing (Transcript Hidden)',
            type: 'shadowing',
            durationSec: 180,
            speechSpeed: 0.95,
            blindShadowing: true,
            instructions: 'Shadow purely by ear without reading the transcript.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('shadowing'),
          },
          {
            id: generateId(),
            name: '3. Dictogloss Working-Memory Synthesis',
            type: 'dictogloss',
            durationSec: 240,
            instructions: 'Take 2-4 word fragment notes and reconstruct the speaker’s argument.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('dictogloss'),
          },
          {
            id: generateId(),
            name: '4. 90s Spontaneous Oral Synthesis',
            type: 'speaking',
            durationSec: 90,
            instructions: 'Speak for 90s reusing the prosody and chunks from the TED talk.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('speaking'),
          },
        ],
      };
    } else {
      blueprint = {
        id: generateId(),
        name: 'DET Reading & Lexical Precision Sprint',
        description:
          'Rapid Read & Complete Drill -> 6-Step Interactive Reading -> Collocation Chunk Writing.',
        createdAt: now,
        updatedAt: now,
        blocks: [
          {
            id: generateId(),
            name: '1. Read & Complete Speed Drill',
            type: 'interactive-reading',
            preferredQuestionType: 'read-and-complete',
            durationSec: 180,
            instructions: 'Complete the segmented letter boxes accurately.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('interactive-reading'),
          },
          {
            id: generateId(),
            name: '2. 6-Step Interactive Reading Suite',
            type: 'interactive-reading',
            preferredQuestionType: 'interactive-reading',
            durationSec: 420,
            instructions: 'Complete all 6 interactive reading steps.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('interactive-reading'),
          },
          {
            id: generateId(),
            name: '3. Collocation Chunk Paragraph',
            type: 'vocab-writing',
            durationSec: 300,
            instructions: 'Synthesize a C1/C2 paragraph using all target chunks.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('vocab-writing'),
          },
        ],
      };
    }

    setEditingTemplate(blueprint);
  };

  const handleAddBlock = (type: BlockType = 'interactive-reading') => {
    if (!editingTemplate) return;
    const option = BLOCK_TYPE_OPTIONS.find((o) => o.value === type);
    const defaultDuration =
      type === 'speaking'
        ? 90
        : type === 'shadowing' || type === 'brain-dump'
        ? 180
        : type === 'interactive-reading'
        ? 480
        : 300;

    const newBlock: Block = {
      id: generateId(),
      name: \`\${editingTemplate.blocks.length + 1}. \${option?.label.replace(/^[^\\s]+\\s/, '') ?? 'Practice Block'}\`,
      type,
      durationSec: defaultDuration,
      preferredQuestionType:
        type === 'interactive-reading' ? 'read-and-complete' : undefined,
      instructions: 'Complete the task below under timed conditions.',
      autoAdvance: false,
      evalPromptId: findEvalIdForType(type),
    };
    setEditingTemplate({
      ...editingTemplate,
      blocks: [...editingTemplate.blocks, newBlock],
    });
  };

  const handleUpdateBlock = (index: number, patch: Partial<Block>) => {
    if (!editingTemplate) return;
    const nextBlocks = editingTemplate.blocks.map((b, i) => {
      if (i !== index) return b;
      const updated = { ...b, ...patch };
      if (patch.type && patch.type !== b.type) {
        updated.evalPromptId = findEvalIdForType(patch.type);
        updated.questionSetId = undefined;
        updated.preferredQuestionType =
          patch.type === 'interactive-reading' ? 'read-and-complete' : undefined;
      }
      return updated;
    });
    setEditingTemplate({ ...editingTemplate, blocks: nextBlocks });
  };

  const handleMoveBlock = (index: number, direction: -1 | 1) => {
    if (!editingTemplate) return;
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= editingTemplate.blocks.length) return;
    const copy = [...editingTemplate.blocks];
    const [moved] = copy.splice(index, 1);
    copy.splice(targetIdx, 0, moved);
    setEditingTemplate({ ...editingTemplate, blocks: copy });
  };

  const handleDuplicateBlock = (index: number) => {
    if (!editingTemplate) return;
    const source = editingTemplate.blocks[index];
    if (!source) return;
    const clone: Block = {
      ...source,
      id: generateId(),
      name: \`\${source.name} (Copy)\`,
    };
    const copy = [...editingTemplate.blocks];
    copy.splice(index + 1, 0, clone);
    setEditingTemplate({ ...editingTemplate, blocks: copy });
  };

  const handleRemoveBlock = (index: number) => {
    if (!editingTemplate) return;
    setEditingTemplate({
      ...editingTemplate,
      blocks: editingTemplate.blocks.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="space-y-6">
      {/* Top Mode Switcher: 21-Day Plan vs Custom Session Architect */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap items-center justify-between gap-2 shadow-2xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setEditingTemplate(null);
              setActiveTab('plan');
            }}
            className={\`px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition-colors \${
              activeTab === 'plan' && !editingTemplate
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
          >
            📅 21-Day Study Plan (3 Daily Sessions)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('architect')}
            className={\`px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition-colors \${
              activeTab === 'architect' || Boolean(editingTemplate)
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
          >
            🛠️ Custom Session Architect ({templates.length} Templates)
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleCreatePresetBlueprint('full-det')}
            className="px-3 py-1.5 bg-primary-50 text-primary-800 border border-primary-200 text-xs font-bold rounded-lg hover:bg-primary-100 cursor-pointer"
          >
            + Full DET Simulation
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('architect');
              createTemplate();
            }}
            className="px-3.5 py-1.5 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
          >
            + Blank Custom Template
          </button>
        </div>
      </div>

      {/* =================================================================== */}
      {/* VIEW 1: 21-DAY STUDY PLAN DASHBOARD                                 */}
      {/* =================================================================== */}
      {activeTab === 'plan' && !editingTemplate && <StudyPlanDashboard />}

      {/* =================================================================== */}
      {/* VIEW 2: SAVED TEMPLATES LIST & CUSTOM ARCHITECT                     */}
      {/* =================================================================== */}
      {activeTab === 'architect' && !editingTemplate && (
        <div className="space-y-3">
          {templates.map((t) => {
            const totalDuration = t.blocks.reduce((sum, b) => sum + b.durationSec, 0);
            return (
              <div
                key={t.id}
                className="bg-white rounded-xl border border-slate-200 p-5 hover:border-primary-300 transition-colors shadow-2xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex-1 min-w-[260px]">
                    <div className="flex items-center gap-2.5">
                      <h3 className="font-bold text-slate-900 text-base">{t.name}</h3>
                      <span className="text-xs font-mono font-bold bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full">
                        {t.blocks.length} blocks • {formatTime(totalDuration)}
                      </span>
                    </div>
                    {t.description && (
                      <p className="text-xs text-slate-500 mt-1">{t.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      {t.blocks.map((b, idx) => {
                        const pinnedQ = b.questionSetId
                          ? questions.find((q) => q.id === b.questionSetId)
                          : undefined;
                        return (
                          <span
                            key={b.id}
                            className="text-xs bg-slate-50 border border-slate-200 text-slate-700 px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5"
                          >
                            <strong className="text-primary-700">{idx + 1}.</strong>
                            <span>{b.name}</span>
                            <span className="text-[11px] font-mono text-slate-400">
                              ({formatTime(b.durationSec)})
                            </span>
                            {pinnedQ && (
                              <span className="text-[10px] bg-primary-100 text-primary-800 px-1.5 py-0.5 rounded font-semibold">
                                📌 Pinned
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleLaunchTemplateInExam(t.id)}
                      className="px-3.5 py-2 text-xs font-bold text-white bg-green-600 rounded-lg hover:bg-green-700 cursor-pointer shadow-2xs"
                    >
                      🚀 Launch Session
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTemplate({ ...t })}
                      className="px-3 py-2 text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 cursor-pointer"
                    >
                      Configure Blocks
                    </button>
                    <button
                      type="button"
                      onClick={() => duplicateTemplate(t.id)}
                      className="px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteTemplate(t.id)}
                      className="px-2.5 py-2 text-xs text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* =================================================================== */}
      {/* INTERACTIVE SESSION ARCHITECT EDITOR                                */}
      {/* =================================================================== */}
      {editingTemplate && (
        <div className="bg-white rounded-2xl border-2 border-slate-200 p-6 space-y-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-primary-600">
                Session Architect
              </span>
              <h3 className="text-lg font-bold text-slate-900">
                Configuring: {editingTemplate.name || 'Untitled Session'}
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold bg-slate-100 text-slate-800 px-3 py-1.5 rounded-lg">
                Total Duration:{' '}
                {formatTime(
                  editingTemplate.blocks.reduce((sum, b) => sum + b.durationSec, 0)
                )}
              </span>
              <button
                type="button"
                onClick={() => setEditingTemplate(null)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                ✕ Close
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Template Name
              </label>
              <input
                type="text"
                value={editingTemplate.name}
                onChange={(e) =>
                  setEditingTemplate({ ...editingTemplate, name: e.target.value })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-semibold"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Session Goal / Description
              </label>
              <input
                type="text"
                value={editingTemplate.description ?? ''}
                onChange={(e) =>
                  setEditingTemplate({
                    ...editingTemplate,
                    description: e.target.value,
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              + Quick-Add Block by Skill Type:
            </span>
            <div className="flex flex-wrap gap-2">
              {BLOCK_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleAddBlock(opt.value)}
                  className="px-3 py-1.5 bg-white hover:bg-primary-50 border border-slate-300 hover:border-primary-400 rounded-lg text-xs font-semibold text-slate-800 cursor-pointer transition-colors shadow-2xs"
                >
                  + {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            {editingTemplate.blocks.map((b, i) => {
              const mins = Math.floor(b.durationSec / 60);
              const secs = b.durationSec % 60;
              const eligibleQuestions = getEligibleQuestionsForBlock(b, questions);
              const subtypeList = SUBTYPE_OPTIONS_BY_BLOCK[b.type];

              return (
                <div
                  key={b.id}
                  className="bg-slate-50/80 border-2 border-slate-200 rounded-2xl p-5 space-y-4 hover:border-slate-300 transition-all"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center justify-center">
                        {i + 1}
                      </span>
                      <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded bg-primary-100 text-primary-800">
                        {b.type}
                      </span>
                      <span className="text-xs font-mono text-slate-500">
                        {formatTime(b.durationSec)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => handleMoveBlock(i, -1)}
                        className="px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                      >
                        ↑ Up
                      </button>
                      <button
                        type="button"
                        disabled={i === editingTemplate.blocks.length - 1}
                        onClick={() => handleMoveBlock(i, 1)}
                        className="px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                      >
                        ↓ Down
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDuplicateBlock(i)}
                        className="px-2.5 py-1 text-xs font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer"
                      >
                        ⧉ Clone
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveBlock(i)}
                        className="px-2.5 py-1 text-xs font-semibold text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                      >
                        ✕ Remove
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    <div className="lg:col-span-4">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Block Title
                      </label>
                      <input
                        type="text"
                        value={b.name}
                        onChange={(e) => handleUpdateBlock(i, { name: e.target.value })}
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold"
                      />
                    </div>

                    <div className="lg:col-span-4">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Block Engine / Mode
                      </label>
                      <select
                        value={b.type}
                        onChange={(e) =>
                          handleUpdateBlock(i, { type: e.target.value as BlockType })
                        }
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold"
                      >
                        {BLOCK_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="lg:col-span-4">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Exact Timer (Min : Sec) & DET Presets
                      </label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          max={60}
                          value={mins}
                          onChange={(e) => {
                            const m = Math.max(0, Number(e.target.value));
                            handleUpdateBlock(i, {
                              durationSec: Math.max(15, m * 60 + secs),
                            });
                          }}
                          className="w-14 px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono text-center"
                        />
                        <span className="text-xs font-bold text-slate-500">m</span>
                        <input
                          type="number"
                          min={0}
                          max={59}
                          step={5}
                          value={secs}
                          onChange={(e) => {
                            const s = Math.max(0, Math.min(59, Number(e.target.value)));
                            handleUpdateBlock(i, {
                              durationSec: Math.max(15, mins * 60 + s),
                            });
                          }}
                          className="w-14 px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono text-center"
                        />
                        <span className="text-xs font-bold text-slate-500 mr-1">s</span>
                        {QUICK_DURATION_PRESETS.map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            onClick={() => handleUpdateBlock(i, { durationSec: p.sec })}
                            className={\`px-2 py-1 rounded text-[11px] font-mono font-bold border cursor-pointer \${
                              b.durationSec === p.sec
                                ? 'bg-slate-900 text-white border-slate-900'
                                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                            }\`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    <div className="lg:col-span-5">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        📌 Pin Specific Question / Passage ({eligibleQuestions.length} available)
                      </label>
                      <select
                        value={b.questionSetId ?? ''}
                        onChange={(e) =>
                          handleUpdateBlock(i, {
                            questionSetId: e.target.value || undefined,
                          })
                        }
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                      >
                        <option value="">
                          🔄 Unseen-First Automatic Selection (Recommended for 21-Day Plan)
                        </option>
                        {eligibleQuestions.map((q) => (
                          <option key={q.id} value={q.id}>
                            [{q.type}] {q.sourceAttribution ? \`(\${q.sourceAttribution}) \` : ''}
                            {q.prompt.slice(0, 68)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="lg:col-span-4">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Sub-Task Mode Filter
                      </label>
                      {subtypeList ? (
                        <select
                          value={b.preferredQuestionType ?? subtypeList[0].value}
                          onChange={(e) =>
                            handleUpdateBlock(i, {
                              preferredQuestionType: e.target.value as
                                | DETQuestionType
                                | 'adaptive',
                            })
                          }
                          className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                        >
                          {subtypeList.map((st) => (
                            <option key={st.value} value={st.value}>
                              {st.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="px-3 py-1.5 bg-slate-100 border border-slate-200 rounded-lg text-xs text-slate-500">
                          Dedicated {b.type} workflow
                        </div>
                      )}
                    </div>

                    <div className="lg:col-span-3">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        AI Grading Rubric
                      </label>
                      <select
                        value={b.evalPromptId}
                        onChange={(e) =>
                          handleUpdateBlock(i, { evalPromptId: e.target.value })
                        }
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                      >
                        {evalPrompts.map((ep) => (
                          <option key={ep.id} value={ep.id}>
                            {ep.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center pt-1">
                    <div className="lg:col-span-6">
                      <input
                        type="text"
                        value={b.instructions}
                        onChange={(e) =>
                          handleUpdateBlock(i, { instructions: e.target.value })
                        }
                        placeholder="Custom instructions displayed at the top of this block..."
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                      />
                    </div>

                    <div className="lg:col-span-6 flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={b.autoAdvance}
                          onChange={(e) =>
                            handleUpdateBlock(i, { autoAdvance: e.target.checked })
                          }
                        />
                        Auto-Advance on Timer End
                      </label>

                      {b.type === 'shadowing' && (
                        <>
                          <label className="flex items-center gap-1.5 text-xs font-semibold text-primary-800 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(b.blindShadowing)}
                              onChange={(e) =>
                                handleUpdateBlock(i, {
                                  blindShadowing: e.target.checked,
                                })
                              }
                            />
                            Blind Shadowing (Hide Text)
                          </label>
                          <div className="flex items-center gap-1">
                            <span className="text-[11px] font-bold text-slate-600">Speed:</span>
                            <select
                              value={b.speechSpeed ?? 1.0}
                              onChange={(e) =>
                                handleUpdateBlock(i, {
                                  speechSpeed: Number(e.target.value),
                                })
                              }
                              className="px-2 py-0.5 bg-white border border-slate-300 rounded text-xs font-mono"
                            >
                              <option value={0.85}>0.85x</option>
                              <option value={0.95}>0.95x</option>
                              <option value={1.0}>1.0x</option>
                              <option value={1.1}>1.1x</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => handleAddBlock('interactive-reading')}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-lg cursor-pointer"
            >
              + Append Another Block
            </button>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditingTemplate(null)}
                className="px-4 py-2 text-sm text-slate-600 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const idToLaunch = editingTemplate.id;
                  await saveTemplate(editingTemplate);
                  handleLaunchTemplateInExam(idToLaunch);
                }}
                className="px-4 py-2 bg-green-600 text-white text-xs font-bold rounded-lg hover:bg-green-700 cursor-pointer"
              >
                💾 Save & Launch Session Now
              </button>
              <button
                type="button"
                onClick={() => saveTemplate(editingTemplate)}
                className="px-5 py-2 bg-primary-600 text-white text-sm font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
              >
                Save Template
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 3. PRE-SESSION: Embeds 21-Day 3-Session Hub + Collapsible Custom Overrides
  // =========================================================================
  'src/components/exam/PreSession.tsx': `import { useEffect, useState } from 'react';
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
                  className={\`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all \${
                    selectedTemplateId === t.id
                      ? 'border-primary-500 bg-primary-50/60'
                      : 'border-slate-200 bg-white hover:border-primary-300'
                  }\`}
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
                      className={\`flex items-center justify-between p-2.5 rounded-lg border bg-white \${
                        checked ? 'border-slate-200' : 'opacity-50 border-slate-100'
                      }\`}
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
                : \`Start Custom Session (\${activeBlocks.length} Block\${activeBlocks.length === 1 ? '' : 's'} • \${formatTime(totalSec)})\`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
`,
};

const cwd = process.cwd();
for (const [relPath, content] of Object.entries(files)) {
  const targetPath = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log('Phase 3 (21-Day Study Plan UI) Updated:', path.relative(cwd, targetPath));
}
console.log('\nAll 3 phases of the 21-Day DET Study Plan upgrade are now complete!');