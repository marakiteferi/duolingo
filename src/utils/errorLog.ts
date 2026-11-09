import type { SessionRun } from '../types';

export interface RecurringErrorItem {
  issue: string;
  count: number;
  category: 'grammar' | 'fluency' | 'lexical' | 'general';
  latestFix?: string;
}

export function extractRecurringErrors(runs: SessionRun[], limit: number = 3): RecurringErrorItem[] {
  const map = new Map<string, RecurringErrorItem>();

  for (const run of runs) {
    for (const resp of Object.values(run.responses ?? {})) {
      const fb = resp.aiFeedback;
      if (!fb) continue;

      const items: { text: string; cat: RecurringErrorItem['category'] }[] = [];
      for (const w of fb.weaknesses ?? []) {
        if (w && w.trim().length > 4) {
          const lower = w.toLowerCase();
          const cat: RecurringErrorItem['category'] =
            lower.includes('pause') || lower.includes('filler') || lower.includes('pace') || lower.includes('hesitat')
              ? 'fluency'
              : lower.includes('vocab') || lower.includes('lexical') || lower.includes('collocat') || lower.includes('word')
              ? 'lexical'
              : lower.includes('grammar') || lower.includes('clause') || lower.includes('tense') || lower.includes('article')
              ? 'grammar'
              : 'general';
          items.push({ text: w.trim(), cat });
        }
      }

      if (fb.criteria?.grammar && fb.criteria.grammar.length > 6) {
        items.push({ text: fb.criteria.grammar.trim(), cat: 'grammar' });
      }

      for (const { text, cat } of items) {
        const key = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 48).trim();
        if (!key) continue;
        const existing = map.get(key);
        if (existing) {
          existing.count += 1;
          if (!existing.latestFix && fb.suggestedFix) {
            existing.latestFix = fb.suggestedFix;
          }
        } else {
          map.set(key, {
            issue: text,
            count: 1,
            category: cat,
            latestFix: fb.suggestedFix,
          });
        }
      }
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
