import { useState, useEffect, useCallback } from 'react';
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
    return Boolean(completedSlots[`day-${day}-session-${slotIndex}`]);
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
    const key = `day-${day}-session-${slotIndex}`;
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
                className={`rounded-2xl border-2 p-5 flex flex-col justify-between transition-all ${
                  done
                    ? 'bg-green-50/70 border-green-400 shadow-2xs'
                    : 'bg-white border-slate-200 hover:border-primary-400 shadow-xs'
                }`}
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full ${
                        done
                          ? 'bg-green-600 text-white'
                          : 'bg-primary-100 text-primary-800'
                      }`}
                    >
                      {done ? `✓ Session ${slot.slotIndex} Done` : slot.badge}
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
                    className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-bold cursor-pointer transition-colors shadow-2xs ${
                      done
                        ? 'bg-slate-900 hover:bg-slate-800 text-white'
                        : 'bg-primary-600 hover:bg-primary-700 text-white'
                    }`}
                  >
                    {launchingSlot === slot.slotIndex
                      ? 'Starting...'
                      : done
                      ? `↻ Practice Session ${slot.slotIndex} Again`
                      : `▶ Start Session ${slot.slotIndex} (${slot.durationLabel})`}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleToggleSlotManual(selectedDay, slot.slotIndex)}
                    title={done ? 'Mark as incomplete' : 'Mark as completed'}
                    className={`px-2.5 py-2.5 rounded-xl border text-xs font-bold cursor-pointer ${
                      done
                        ? 'bg-green-100 border-green-400 text-green-800 hover:bg-green-200'
                        : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                    }`}
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
                      className={`p-2.5 rounded-xl border-2 text-left transition-all cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'border-primary-600 bg-primary-50/80 ring-2 ring-primary-200'
                          : isAllDone
                          ? 'border-green-400 bg-green-50/60 hover:border-green-500'
                          : 'border-slate-200 bg-slate-50/60 hover:border-slate-300'
                      }`}
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
                            className={`w-2.5 h-2.5 rounded-full ${
                              done ? 'bg-green-500' : 'bg-slate-300'
                            }`}
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
