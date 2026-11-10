import { db, ensureDatabaseUpgraded } from '../db/database';
import type { QuestionBankItem, DETQuestionType, DETSkill } from '../types';
import { getDueItems } from './srs';

/**
 * Returns the set of all question IDs that the user has already completed
 * either via explicit question.completedAt or in any previous SessionRun.
 */
export async function getCompletedQuestionIds(): Promise<Set<string>> {
  const completedIds = new Set<string>();

  const allQuestions = await db.questionBank.toArray();
  for (const q of allQuestions) {
    if (q.completedAt || (q.timesCompleted && q.timesCompleted > 0)) {
      completedIds.add(q.id);
    }
  }

  const allRuns = await db.sessionRuns.toArray();
  for (const run of allRuns) {
    for (const resp of Object.values(run.responses ?? {})) {
      if (
        resp.questionId &&
        Boolean(
          resp.textOrTranscript?.trim() ||
            resp.audioBlobRef ||
            resp.aiOverallScore ||
            resp.isComplete
        )
      ) {
        completedIds.add(resp.questionId);
      }
    }
  }

  return completedIds;
}

/**
 * Marks a question as completed in IndexedDB so that future sessions
 * automatically advance to the next unseen item in the 21-day bank.
 */
export async function markQuestionCompleted(questionId?: string): Promise<void> {
  if (!questionId) return;
  const item = await db.questionBank.get(questionId);
  if (!item) return;
  await db.questionBank.put({
    ...item,
    completedAt: new Date().toISOString(),
    timesCompleted: (item.timesCompleted ?? 0) + 1,
  });
}

/**
 * Resets completion flags across the question bank if the user wants to start
 * a fresh 21-day cycle.
 */
export async function resetAllQuestionCompletions(): Promise<void> {
  const all = await db.questionBank.toArray();
  const reset = all.map((q) => ({
    ...q,
    completedAt: null,
    timesCompleted: 0,
  }));
  await db.questionBank.bulkPut(reset);
}

/**
 * Selects questions prioritizing:
 * 1. UNSEEN / UNCOMPLETED questions first (+1000 priority boost) so the user
 *    never repeats the same passage or prompt during their 21-day plan.
 * 2. Questions assigned to the current or earlier study plan day.
 * 3. Spaced Repetition (SM-2) due status & weakest skill weighting.
 */
export async function getAdaptiveQuestions(options: {
  skill?: DETSkill;
  questionType?: DETQuestionType | 'all' | 'adaptive';
  tagsInclude?: string;
  limit?: number;
}): Promise<{
  selected: QuestionBankItem[];
  weakestSkill: DETSkill | null;
  dueCount: number;
  unseenCount: number;
  completedIds: Set<string>;
}> {
  await ensureDatabaseUpgraded();
  const allQuestions = await db.questionBank.toArray();
  const completedIds = await getCompletedQuestionIds();
  const settings = await db.settings.get('app-settings');
  const currentPlanDay = settings?.currentPlanDay ?? 1;

  const completedRuns = await db.sessionRuns
    .where('status')
    .equals('completed')
    .reverse()
    .sortBy('startedAt');

  const skillTotals: Record<DETSkill, { sum: number; count: number }> = {
    reading: { sum: 0, count: 0 },
    writing: { sum: 0, count: 0 },
    speaking: { sum: 0, count: 0 },
    listening: { sum: 0, count: 0 },
  };

  for (const run of completedRuns.slice(0, 12)) {
    for (const resp of Object.values(run.responses)) {
      if (!resp.aiOverallScore) continue;
      if (resp.type === 'speaking' || resp.type === 'shadowing') {
        skillTotals.speaking.sum += resp.aiOverallScore;
        skillTotals.speaking.count += 1;
      } else if (resp.type === 'vocab-writing' || resp.type === 'brain-dump') {
        skillTotals.writing.sum += resp.aiOverallScore;
        skillTotals.writing.count += 1;
      } else if (resp.type === 'dictogloss') {
        skillTotals.listening.sum += resp.aiOverallScore;
        skillTotals.listening.count += 1;
      } else {
        skillTotals.reading.sum += resp.aiOverallScore;
        skillTotals.reading.count += 1;
      }
    }
  }

  let weakestSkill: DETSkill | null = null;
  let lowestAvg = 999;
  for (const [skill, stats] of Object.entries(skillTotals) as [
    DETSkill,
    { sum: number; count: number }
  ][]) {
    if (stats.count > 0) {
      const avg = stats.sum / stats.count;
      if (avg < lowestAvg) {
        lowestAvg = avg;
        weakestSkill = skill;
      }
    }
  }

  let pool = [...allQuestions];

  if (
    options.questionType &&
    options.questionType !== 'all' &&
    options.questionType !== 'adaptive'
  ) {
    const byType = pool.filter((q) => q.type === options.questionType);
    if (byType.length > 0) pool = byType;
  } else if (options.skill) {
    const bySkill = pool.filter((q) => q.skill === options.skill);
    if (bySkill.length > 0) pool = bySkill;
  }

  if (options.tagsInclude) {
    const byTag = pool.filter((q) => q.tags.includes(options.tagsInclude!));
    if (byTag.length > 0) pool = byTag;
  }

  const dueItems = getDueItems(pool);
  const dueIds = new Set(dueItems.map((d) => d.id));
  const unseenCount = pool.filter((q) => !completedIds.has(q.id)).length;

  const scored = pool.map((q) => {
    let weight = 0;
    const isCompleted = completedIds.has(q.id);

    // 1. Huge priority boost for UNSEEN questions so questions never repeat!
    if (!isCompleted) {
      weight += 1000;
    } else {
      // Penalize by how many times it was already completed
      weight -= (q.timesCompleted ?? 1) * 150;
    }

    // 2. Prioritize items scheduled for the user's current 21-day plan day
    if (q.dayNumber !== undefined) {
      if (q.dayNumber === currentPlanDay) weight += 120;
      else if (q.dayNumber < currentPlanDay && !isCompleted) weight += 80;
      else weight += Math.max(0, 40 - Math.abs(q.dayNumber - currentPlanDay));
    }

    // 3. SRS Due & Weakest Skill
    if (dueIds.has(q.id)) weight += 50;
    if (weakestSkill && q.skill === weakestSkill) weight += 30;
    if (q.difficulty === 'hard' || q.difficulty === 4 || q.difficulty === 5) weight += 15;

    return { item: q, weight };
  });

  scored.sort((a, b) => b.weight - a.weight);

  return {
    selected: scored.slice(0, options.limit ?? 30).map((s) => s.item),
    weakestSkill,
    dueCount: dueItems.length,
    unseenCount,
    completedIds,
  };
}
