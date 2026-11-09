import { db } from '../db';
import type { QuestionBankItem, DETQuestionType, DETSkill } from '../types';
import { getDueItems } from './srs';

/**
 * Selects the best practice questions based on:
 * 1. User's preferred question type filter (if specified)
 * 2. Spaced Repetition (SM-2) due status
 * 3. Adaptive weighting toward the user's lowest-scoring DET skills from recent runs
 */
export async function getAdaptiveQuestions(options: {
  skill?: DETSkill;
  questionType?: DETQuestionType | 'all' | 'adaptive';
  limit?: number;
}): Promise<{
  selected: QuestionBankItem[];
  weakestSkill: DETSkill | null;
  dueCount: number;
}> {
  const allQuestions = await db.questionBank.toArray();
  const completedRuns = await db.sessionRuns
    .where('status')
    .equals('completed')
    .reverse()
    .sortBy('startedAt');

  // Compute historical average per skill
  const skillTotals: Record<DETSkill, { sum: number; count: number }> = {
    reading: { sum: 0, count: 0 },
    writing: { sum: 0, count: 0 },
    speaking: { sum: 0, count: 0 },
    listening: { sum: 0, count: 0 },
  };

  for (const run of completedRuns.slice(0, 10)) {
    for (const resp of Object.values(run.responses)) {
      if (!resp.aiOverallScore) continue;
      if (resp.type === 'speaking') {
        skillTotals.speaking.sum += resp.aiOverallScore;
        skillTotals.speaking.count += 1;
      } else if (resp.type === 'vocab-writing' || resp.type === 'brain-dump') {
        skillTotals.writing.sum += resp.aiOverallScore;
        skillTotals.writing.count += 1;
      } else {
        skillTotals.reading.sum += resp.aiOverallScore;
        skillTotals.reading.count += 1;
      }
    }
  }

  let weakestSkill: DETSkill | null = null;
  let lowestAvg = 999;
  for (const [skill, stats] of Object.entries(skillTotals) as [DETSkill, { sum: number; count: number }][]) {
    if (stats.count > 0) {
      const avg = stats.sum / stats.count;
      if (avg < lowestAvg) {
        lowestAvg = avg;
        weakestSkill = skill;
      }
    }
  }

  let pool = [...allQuestions];
  if (options.questionType && options.questionType !== 'all' && options.questionType !== 'adaptive') {
    const byType = pool.filter((q) => q.type === options.questionType);
    if (byType.length > 0) pool = byType;
  } else if (options.skill) {
    const bySkill = pool.filter((q) => q.skill === options.skill);
    if (bySkill.length > 0) pool = bySkill;
  }

  const dueItems = getDueItems(pool);
  const dueIds = new Set(dueItems.map((d) => d.id));

  // Score each question for priority sorting
  const scored = pool.map((q) => {
    let weight = 0;
    if (dueIds.has(q.id)) weight += 50;
    if (weakestSkill && q.skill === weakestSkill) weight += 30;
    if (q.difficulty === 'hard' || q.difficulty === 4 || q.difficulty === 5) weight += 15;
    return { item: q, weight };
  });

  scored.sort((a, b) => b.weight - a.weight);

  return {
    selected: scored.slice(0, options.limit ?? 10).map((s) => s.item),
    weakestSkill,
    dueCount: dueItems.length,
  };
}
