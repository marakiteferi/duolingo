/**
 * Session Store — Exam runner state management.
 *
 * Manages the entire lifecycle of a practice session:
 * starting, timing, block transitions, response collection, and DB persistence.
 *
 * Key design decisions:
 * - tick() is called every 1s by an external TimerEngine. It increments time,
 *   checks block expiry, and auto-advances when configured.
 * - persistToDb() is called every 5 ticks (5s) + on every response update.
 * - Transition countdown (3-2-1) is managed here — tick() doesn't increment
 *   real time while a transition is active.
 * - Selector functions (selectXxx) are exported for use with useSessionStore().
 */

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

import type {
  SessionTemplate,
  SessionRun,
  BlockConfig,
  BlockResponse,
} from '../types';
import { db } from '../db';

// ─── State ───────────────────────────────────────────────────────────────────

interface SessionState {
  activeRun: SessionRun | null;
  currentBlockIndex: number;
  blockElapsedSec: number;
  overallElapsedSec: number;
  isRunning: boolean;
  isPaused: boolean;
  /** 3-2-1 inter-block countdown; null = no transition in progress */
  transitionCountdown: number | null;
  /** Draft responses keyed by blockId — written continuously to DB */
  draftResponses: Record<string, BlockResponse>;
  selectedTemplateId: string | null;
}

interface SessionActions {
  startSession: (template: SessionTemplate) => Promise<void>;
  resumeSession: (run: SessionRun) => void;
  tick: () => void;
  advanceBlock: () => void;
  completeBlock: () => void;
  updateResponse: (blockId: string, patch: Partial<BlockResponse>) => void;
  pauseSession: () => void;
  resumeRunning: () => void;
  completeSession: () => Promise<void>;
  persistToDb: () => Promise<void>;
  abandonSession: () => Promise<void>;
  setSelectedTemplateId: (id: string | null) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TRANSITION_SEC = 3;

function emptyResponse(block: BlockConfig): BlockResponse {
  return {
    blockId: block.id,
    questionType: block.type,
    isComplete: false,
    timeSpentSec: 0,
  };
}

function buildResponses(blocks: BlockConfig[]): Record<string, BlockResponse> {
  return Object.fromEntries(blocks.map((b) => [b.id, emptyResponse(b)]));
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState & SessionActions>()(
  (set, get) => ({
    activeRun: null,
    currentBlockIndex: 0,
    blockElapsedSec: 0,
    overallElapsedSec: 0,
    isRunning: false,
    isPaused: false,
    transitionCountdown: null,
    draftResponses: {},
    selectedTemplateId: null,

    setSelectedTemplateId: (id) => set({ selectedTemplateId: id }),

    // ── Start a brand-new session ─────────────────────────────────────────────

    startSession: async (template) => {
      const now = new Date().toISOString();
      const blockConfigs = template.blocks.map((b) => ({ ...b })); // snapshot
      const responses = buildResponses(blockConfigs);

      const run: SessionRun = {
        id: uuidv4(),
        templateId: template.id,
        templateName: template.name,
        blockConfigs,
        responses,
        currentBlockIndex: 0,
        status: 'in-progress',
        overallElapsedSec: 0,
        startedAt: now,
        endedAt: null,
      };

      await db.sessionRuns.put(run);

      set({
        activeRun: run,
        currentBlockIndex: 0,
        blockElapsedSec: 0,
        overallElapsedSec: 0,
        isRunning: true,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: responses,
      });
    },

    // ── Resume an existing in-progress run ────────────────────────────────────

    resumeSession: (run) => {
      set({
        activeRun: run,
        currentBlockIndex: run.currentBlockIndex,
        blockElapsedSec: 0, // sub-block elapsed is not persisted; restart from 0
        overallElapsedSec: run.overallElapsedSec,
        isRunning: true,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: { ...run.responses },
      });
    },

    // ── Timer tick (called every ~1s) ─────────────────────────────────────────

    tick: () => {
      const state = get();
      if (!state.isRunning || state.isPaused || !state.activeRun) return;

      // ── Transition countdown ──
      if (state.transitionCountdown !== null) {
        if (state.transitionCountdown <= 1) {
          set({ transitionCountdown: null, blockElapsedSec: 0 });
        } else {
          set({ transitionCountdown: state.transitionCountdown - 1 });
        }
        return; // don't advance real time during transition
      }

      const newBlockElapsed = state.blockElapsedSec + 1;
      const newOverall = state.overallElapsedSec + 1;

      const block = state.activeRun.blockConfigs[state.currentBlockIndex];
      const isLastBlock =
        state.currentBlockIndex >= state.activeRun.blockConfigs.length - 1;

      // ── Block expired ──
      if (block && newBlockElapsed >= block.durationSec) {
        const updatedResponses = {
          ...state.draftResponses,
          [block.id]: {
            ...state.draftResponses[block.id],
            isComplete: true,
            timeSpentSec: block.durationSec,
          },
        };

        if (isLastBlock) {
          // Last block expired → auto-complete session
          set({
            blockElapsedSec: block.durationSec,
            overallElapsedSec: newOverall,
            draftResponses: updatedResponses,
            isRunning: false,
          });
          void get().completeSession();
          return;
        }

        // Not last → start transition countdown
        set({
          currentBlockIndex: state.currentBlockIndex + 1,
          blockElapsedSec: 0,
          overallElapsedSec: newOverall,
          draftResponses: updatedResponses,
          transitionCountdown: TRANSITION_SEC,
        });
        void get().persistToDb();
        return;
      }

      // ── Normal tick ──
      set({ blockElapsedSec: newBlockElapsed, overallElapsedSec: newOverall });

      // Persist every 5s to reduce IndexedDB write pressure
      if (newOverall % 5 === 0) void get().persistToDb();
    },

    // ── Manual block advance (user clicks "I'm done") ─────────────────────────

    advanceBlock: () => {
      const state = get();
      if (!state.activeRun) return;

      const isLast =
        state.currentBlockIndex >= state.activeRun.blockConfigs.length - 1;

      if (isLast) {
        void get().completeSession();
        return;
      }

      const block = state.activeRun.blockConfigs[state.currentBlockIndex];
      set({
        currentBlockIndex: state.currentBlockIndex + 1,
        blockElapsedSec: 0,
        transitionCountdown: TRANSITION_SEC,
        draftResponses: {
          ...state.draftResponses,
          [block.id]: {
            ...state.draftResponses[block.id],
            isComplete: true,
            timeSpentSec: state.blockElapsedSec,
          },
        },
      });
      void get().persistToDb();
    },

    // ── Explicitly mark current block complete (without advancing) ────────────

    completeBlock: () => {
      const state = get();
      if (!state.activeRun) return;
      const block = state.activeRun.blockConfigs[state.currentBlockIndex];
      if (!block) return;

      set({
        draftResponses: {
          ...state.draftResponses,
          [block.id]: {
            ...state.draftResponses[block.id],
            isComplete: true,
            timeSpentSec: state.blockElapsedSec,
          },
        },
      });
      void get().persistToDb();
    },

    // ── Update a draft response (text typed, audio recorded, etc.) ────────────

    updateResponse: (blockId, patch) => {
      const existing = get().draftResponses[blockId];
      if (!existing) return;
      set({
        draftResponses: {
          ...get().draftResponses,
          [blockId]: { ...existing, ...patch },
        },
      });
      void get().persistToDb();
    },

    pauseSession: () => set({ isPaused: true }),
    resumeRunning: () => set({ isPaused: false }),

    // ── Complete the session ──────────────────────────────────────────────────

    completeSession: async () => {
      const state = get();
      if (!state.activeRun) return;

      const completed: SessionRun = {
        ...state.activeRun,
        responses: { ...state.draftResponses },
        currentBlockIndex: state.currentBlockIndex,
        overallElapsedSec: state.overallElapsedSec,
        status: 'completed',
        endedAt: new Date().toISOString(),
      };

      await db.sessionRuns.put(completed);

      set({
        activeRun: completed,  // keep for PostSession to read
        isRunning: false,
        isPaused: false,
        transitionCountdown: null,
      });
    },

    // ── Persist current state to IndexedDB ────────────────────────────────────

    persistToDb: async () => {
      const state = get();
      if (!state.activeRun) return;

      const snapshot: SessionRun = {
        ...state.activeRun,
        responses: state.draftResponses,
        currentBlockIndex: state.currentBlockIndex,
        overallElapsedSec: state.overallElapsedSec,
      };

      await db.sessionRuns.put(snapshot);
    },

    // ── Abandon (save state but mark as abandoned) ────────────────────────────

    abandonSession: async () => {
      const state = get();
      if (!state.activeRun) return;

      const abandoned: SessionRun = {
        ...state.activeRun,
        responses: { ...state.draftResponses },
        currentBlockIndex: state.currentBlockIndex,
        overallElapsedSec: state.overallElapsedSec,
        status: 'abandoned',
        endedAt: new Date().toISOString(),
      };

      await db.sessionRuns.put(abandoned);

      set({
        activeRun: null,
        currentBlockIndex: 0,
        blockElapsedSec: 0,
        overallElapsedSec: 0,
        isRunning: false,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: {},
      });
    },
  })
);

// ─── Selector Functions ───────────────────────────────────────────────────────
// Use with: useSessionStore(selector) — selector-based subscriptions avoid
// re-rendering the full tree on every 1s tick.

type S = SessionState;

export const selectCurrentBlock = (s: S): BlockConfig | undefined =>
  s.activeRun?.blockConfigs[s.currentBlockIndex];

export const selectIsLastBlock = (s: S): boolean =>
  !s.activeRun ? false : s.currentBlockIndex >= s.activeRun.blockConfigs.length - 1;

export const selectBlockTimeRemaining = (s: S): number => {
  const block = s.activeRun?.blockConfigs[s.currentBlockIndex];
  if (!block) return 0;
  return Math.max(0, block.durationSec - s.blockElapsedSec);
};

export const selectTotalDuration = (s: S): number =>
  s.activeRun?.blockConfigs.reduce((sum, b) => sum + b.durationSec, 0) ?? 0;

export const selectOverallProgress = (s: S): number => {
  const total = selectTotalDuration(s);
  return total === 0 ? 0 : Math.min(1, s.overallElapsedSec / total);
};

export const selectBlockProgress = (s: S): number => {
  const block = s.activeRun?.blockConfigs[s.currentBlockIndex];
  if (!block || block.durationSec === 0) return 0;
  return Math.min(1, s.blockElapsedSec / block.durationSec);
};
