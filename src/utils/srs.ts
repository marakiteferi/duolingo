/**
 * SM-2 Spaced Repetition Scheduler.
 *
 * Implements the classic SM-2 algorithm used by SuperMemo / Anki to schedule
 * vocabulary review intervals. Each item carries an `SRSState` that is updated
 * after every review based on the student's self-reported quality grade (0-5).
 *
 * Algorithm summary:
 *   - Quality >= 3 (correct recall):
 *       rep 0 → interval = 1 day
 *       rep 1 → interval = 6 days
 *       rep 2+ → interval = prev interval × ease factor
 *       ease = max(1.3, ease + 0.1 - (5-q) * (0.08 + (5-q) * 0.02))
 *   - Quality < 3 (failed recall):
 *       Reset repetitions to 0, interval = 1 day, keep ease factor
 *
 * @see https://en.wikipedia.org/wiki/SuperMemo#Description_of_SM-2_algorithm
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** The spaced-repetition scheduling state for a single item */
export interface SRSState {
  /** Easiness factor — controls how fast intervals grow (min 1.3) */
  easeFactor: number;
  /** Current inter-repetition interval in days */
  intervalDays: number;
  /** Number of consecutive correct repetitions */
  repetitions: number;
  /** ISO date string of the next scheduled review */
  nextReviewDate: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default starting ease factor (SM-2 standard) */
const DEFAULT_EASE = 2.5;

/** Default starting interval (1 day) */
const DEFAULT_INTERVAL = 1;

/** Minimum ease factor — prevents items from getting "stuck" */
const MIN_EASE = 1.3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute an ISO date string `days` from now (midnight UTC).
 */
function addDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + Math.round(days));
  // Normalise to midnight UTC for clean date comparisons
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a fresh SRS state for a new vocabulary item.
 *
 * @param startEase     — Initial ease factor (default 2.5).
 * @param startInterval — Initial interval in days (default 1).
 */
export function initSRS(
  startEase: number = DEFAULT_EASE,
  startInterval: number = DEFAULT_INTERVAL,
): SRSState {
  return {
    easeFactor: Math.max(MIN_EASE, startEase),
    intervalDays: startInterval,
    repetitions: 0,
    nextReviewDate: addDays(0), // Due immediately (today)
  };
}

/**
 * Process a review and return an updated SRS state.
 *
 * @param state   — Current SRS state of the item.
 * @param quality — Self-assessed quality grade (0 = complete blank, 5 = perfect).
 * @returns A new SRSState (the original is NOT mutated).
 */
export function reviewItem(state: SRSState, quality: number): SRSState {
  // Clamp quality to valid range
  const q = Math.round(Math.max(0, Math.min(5, quality)));

  if (q >= 3) {
    // ── Correct recall ──
    let newInterval: number;
    const newReps = state.repetitions + 1;

    if (state.repetitions === 0) {
      // First successful review → 1 day
      newInterval = 1;
    } else if (state.repetitions === 1) {
      // Second successful review → 6 days
      newInterval = 6;
    } else {
      // Subsequent reviews → grow by ease factor
      newInterval = Math.round(state.intervalDays * state.easeFactor);
    }

    // Update ease factor using SM-2 formula
    const newEase = Math.max(
      MIN_EASE,
      state.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)),
    );

    return {
      easeFactor: newEase,
      intervalDays: newInterval,
      repetitions: newReps,
      nextReviewDate: addDays(newInterval),
    };
  } else {
    // ── Failed recall — reset repetitions but keep ease ──
    return {
      easeFactor: state.easeFactor,
      intervalDays: 1,
      repetitions: 0,
      nextReviewDate: addDays(1),
    };
  }
}

/**
 * Check if an item is due for review (i.e., `nextReviewDate` is today or earlier).
 */
export function isDue(state: SRSState): boolean {
  const now = new Date();
  const reviewDate = new Date(state.nextReviewDate);
  return reviewDate <= now;
}

/**
 * Filter a list of items to only those that are currently due for review.
 *
 * Items without an `srs` field are always considered due (new / unscheduled).
 *
 * @param items — Array of objects that optionally carry an `srs` property.
 * @returns Subset of items whose review date has passed or who have no SRS state.
 */
export function getDueItems<T extends { srs?: SRSState }>(items: T[]): T[] {
  return items.filter((item) => {
    if (!item.srs) {
      // No SRS state — treat as a new item that needs its first review
      return true;
    }
    return isDue(item.srs);
  });
}
