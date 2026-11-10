// fix-session-store.mjs
// Restores resetBlockForRewrite in src/stores/sessionStore.ts while preserving 21-day plan tracking
// Run from project root: node fix-session-store.mjs

import fs from 'node:fs';
import path from 'node:path';

const sessionStoreContent = `import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type {
  SessionTemplate,
  SessionRun,
  BlockConfig,
  BlockResponse,
  DETQuestionType,
} from '../types';
import { db } from '../db';
import { markQuestionCompleted } from '../utils/adaptive';

export interface StartSessionOptions {
  selectedBlockIds?: string[];
  customDurations?: Record<string, number>;
  instantFeedback?: boolean;
  communicativePressure?: boolean;
  preferredQuestionType?: DETQuestionType | 'all' | 'adaptive';
  planDay?: number;
  planSlotIndex?: number; // 1, 2, or 3
}

interface SessionState {
  activeRun: SessionRun | null;
  currentBlockIndex: number;
  blockElapsedSec: number;
  overallElapsedSec: number;
  isRunning: boolean;
  isPaused: boolean;
  transitionCountdown: number | null;
  draftResponses: Record<string, BlockResponse>;
  selectedTemplateId: string | null;
  lastSavedAt: string | null;
}

interface SessionActions {
  startSession: (template: SessionTemplate, options?: StartSessionOptions) => Promise<void>;
  resumeSession: (run: SessionRun) => void;
  tick: () => void;
  advanceBlock: () => void;
  jumpToBlock: (index: number) => void;
  completeBlock: () => void;
  updateResponse: (blockId: string, patch: Partial<BlockResponse>) => void;
  resetBlockForRewrite: (blockId?: string) => void;
  pauseSession: () => void;
  resumeRunning: () => void;
  completeSession: () => Promise<void>;
  persistToDb: () => Promise<void>;
  abandonSession: () => Promise<void>;
  clearActiveRun: () => void;
  setSelectedTemplateId: (id: string | null) => void;
}

const TRANSITION_SEC = 3;

function emptyResponse(block: BlockConfig): BlockResponse {
  return {
    blockId: block.id,
    type: block.type,
    questionType: block.preferredQuestionType ?? block.type,
    questionId: block.questionSetId,
    attemptCount: 1,
    isComplete: false,
    timeSpentSec: 0,
  };
}

function buildResponses(blocks: BlockConfig[]): Record<string, BlockResponse> {
  return Object.fromEntries(blocks.map((b) => [b.id, emptyResponse(b)]));
}

function inferSlotFromTemplateId(templateId?: string | null): number | undefined {
  if (!templateId) return undefined;
  if (templateId === 'tpl-daily-session-1-reading-vocab') return 1;
  if (templateId === 'tpl-daily-session-2-listening-shadowing') return 2;
  if (templateId === 'tpl-daily-session-3-production-mock') return 3;
  return undefined;
}

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
    lastSavedAt: null,

    setSelectedTemplateId: (id) => set({ selectedTemplateId: id }),

    clearActiveRun: () =>
      set({
        activeRun: null,
        currentBlockIndex: 0,
        blockElapsedSec: 0,
        overallElapsedSec: 0,
        isRunning: false,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: {},
      }),

    startSession: async (template, options) => {
      const now = new Date().toISOString();
      const settings = await db.settings.get('app-settings');
      const currentPlanDay = options?.planDay ?? settings?.currentPlanDay ?? 1;
      const inferredSlot = options?.planSlotIndex ?? inferSlotFromTemplateId(template.id);

      const filteredBlocks = template.blocks
        .filter((b) =>
          options?.selectedBlockIds ? options.selectedBlockIds.includes(b.id) : true
        )
        .map((b) => ({
          ...b,
          durationSec: options?.customDurations?.[b.id] ?? b.durationSec,
        }));

      const blockConfigs =
        filteredBlocks.length > 0 ? filteredBlocks : template.blocks.map((b) => ({ ...b }));
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
        instantFeedback: options?.instantFeedback ?? true,
        communicativePressure: options?.communicativePressure ?? false,
        preferredQuestionType: options?.preferredQuestionType ?? 'adaptive',
        planDay: currentPlanDay,
        planSlotIndex: inferredSlot,
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
        lastSavedAt: now,
      });
    },

    resumeSession: (run) => {
      const activeBlock = run.blockConfigs[run.currentBlockIndex];
      const savedBlockTime = activeBlock
        ? (run.responses[activeBlock.id]?.timeSpentSec ?? 0)
        : 0;
      set({
        activeRun: run,
        currentBlockIndex: run.currentBlockIndex,
        blockElapsedSec: savedBlockTime,
        overallElapsedSec: run.overallElapsedSec,
        isRunning: true,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: { ...run.responses },
        lastSavedAt: new Date().toISOString(),
      });
    },

    tick: () => {
      const state = get();
      if (!state.isRunning || state.isPaused || !state.activeRun) return;

      if (state.transitionCountdown !== null) {
        if (state.transitionCountdown <= 1) {
          set({ transitionCountdown: null, blockElapsedSec: 0 });
        } else {
          set({ transitionCountdown: state.transitionCountdown - 1 });
        }
        return;
      }

      const block = state.activeRun.blockConfigs[state.currentBlockIndex];
      if (!block) return;

      if (state.blockElapsedSec >= block.durationSec && !block.autoAdvance) {
        return;
      }

      const newBlockElapsed = state.blockElapsedSec + 1;
      const newOverall = state.overallElapsedSec + 1;
      const isLastBlock =
        state.currentBlockIndex >= state.activeRun.blockConfigs.length - 1;

      const updatedResponses = {
        ...state.draftResponses,
        [block.id]: {
          ...state.draftResponses[block.id],
          timeSpentSec: newBlockElapsed,
        },
      };

      if (newBlockElapsed >= block.durationSec) {
        updatedResponses[block.id] = {
          ...updatedResponses[block.id],
          isComplete: true,
          timeSpentSec: block.durationSec,
        };

        const qId = updatedResponses[block.id]?.questionId;
        if (qId) void markQuestionCompleted(qId);

        if (!block.autoAdvance) {
          set({
            blockElapsedSec: block.durationSec,
            overallElapsedSec: newOverall,
            draftResponses: updatedResponses,
          });
          void get().persistToDb();
          return;
        }

        if (isLastBlock) {
          set({
            blockElapsedSec: block.durationSec,
            overallElapsedSec: newOverall,
            draftResponses: updatedResponses,
            isRunning: false,
          });
          void get().completeSession();
          return;
        }

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

      set({
        blockElapsedSec: newBlockElapsed,
        overallElapsedSec: newOverall,
        draftResponses: updatedResponses,
      });

      if (newOverall % 5 === 0) void get().persistToDb();
    },

    advanceBlock: () => {
      const state = get();
      if (!state.activeRun) return;
      const isLast =
        state.currentBlockIndex >= state.activeRun.blockConfigs.length - 1;
      const block = state.activeRun.blockConfigs[state.currentBlockIndex];

      if (block) {
        const currentResp = state.draftResponses[block.id];
        if (
          currentResp?.questionId &&
          Boolean(
            currentResp.textOrTranscript?.trim() ||
              currentResp.audioBlobRef ||
              currentResp.aiOverallScore
          )
        ) {
          void markQuestionCompleted(currentResp.questionId);
        }

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
      }

      if (isLast) {
        void get().completeSession();
        return;
      }

      set({
        currentBlockIndex: state.currentBlockIndex + 1,
        blockElapsedSec: 0,
        transitionCountdown: TRANSITION_SEC,
      });
      void get().persistToDb();
    },

    jumpToBlock: (index) => {
      const state = get();
      if (!state.activeRun) return;
      if (index < 0 || index >= state.activeRun.blockConfigs.length) return;
      const targetBlock = state.activeRun.blockConfigs[index];
      const priorSpent = state.draftResponses[targetBlock.id]?.timeSpentSec ?? 0;
      set({
        currentBlockIndex: index,
        blockElapsedSec: Math.min(priorSpent, targetBlock.durationSec - 1),
        transitionCountdown: null,
      });
      void get().persistToDb();
    },

    completeBlock: () => {
      const state = get();
      if (!state.activeRun) return;
      const block = state.activeRun.blockConfigs[state.currentBlockIndex];
      if (!block) return;

      const currentResp = state.draftResponses[block.id];
      if (currentResp?.questionId) {
        void markQuestionCompleted(currentResp.questionId);
      }

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

    updateResponse: (blockId, patch) => {
      const existing = get().draftResponses[blockId] ?? {
        blockId,
        isComplete: false,
        timeSpentSec: get().blockElapsedSec,
      };
      set({
        draftResponses: {
          ...get().draftResponses,
          [blockId]: { ...existing, ...patch },
        },
      });
      void get().persistToDb();
    },

    resetBlockForRewrite: (blockId?: string) => {
      const state = get();
      const activeBlock = state.activeRun?.blockConfigs[state.currentBlockIndex];
      const targetId = blockId ?? activeBlock?.id;
      if (!targetId) return;

      const existing = state.draftResponses[targetId];
      const isAudioBlock =
        activeBlock?.type === 'speaking' || activeBlock?.type === 'shadowing';

      set({
        blockElapsedSec: 0,
        isPaused: false,
        isRunning: true,
        draftResponses: {
          ...state.draftResponses,
          [targetId]: {
            ...existing,
            blockId: targetId,
            previousDraft:
              existing?.timestampedTranscript ||
              existing?.textOrTranscript ||
              existing?.previousDraft,
            attemptCount: (existing?.attemptCount ?? 1) + 1,
            audioBlobRef: isAudioBlock ? undefined : existing?.audioBlobRef,
            textOrTranscript: isAudioBlock ? '' : (existing?.textOrTranscript ?? ''),
            timestampedTranscript: isAudioBlock ? undefined : existing?.timestampedTranscript,
            aiFeedback: undefined,
            aiOverallScore: undefined,
            aiSubscores: undefined,
            isComplete: false,
            timeSpentSec: 0,
          },
        },
      });
      void get().persistToDb();
    },

    pauseSession: () => set({ isPaused: true }),
    resumeRunning: () => set({ isPaused: false }),

    completeSession: async () => {
      const state = get();
      if (!state.activeRun) return;
      const now = new Date().toISOString();

      for (const resp of Object.values(state.draftResponses)) {
        if (
          resp.questionId &&
          Boolean(
            resp.textOrTranscript?.trim() ||
              resp.audioBlobRef ||
              resp.aiOverallScore
          )
        ) {
          await markQuestionCompleted(resp.questionId);
        }
      }

      const planDay = state.activeRun.planDay;
      const slotIdx =
        state.activeRun.planSlotIndex ??
        inferSlotFromTemplateId(state.activeRun.templateId);

      if (planDay && slotIdx) {
        const settings = await db.settings.get('app-settings');
        if (settings) {
          const updatedSlots = {
            ...(settings.completedPlanSlots ?? {}),
            [\`day-\${planDay}-session-\${slotIdx}\`]: now,
          };
          const s1Done = Boolean(updatedSlots[\`day-\${planDay}-session-1\`]);
          const s2Done = Boolean(updatedSlots[\`day-\${planDay}-session-2\`]);
          const s3Done = Boolean(updatedSlots[\`day-\${planDay}-session-3\`]);
          const nextDay =
            s1Done && s2Done && s3Done && settings.currentPlanDay === planDay
              ? Math.min(21, planDay + 1)
              : settings.currentPlanDay ?? 1;

          await db.settings.put({
            ...settings,
            completedPlanSlots: updatedSlots,
            currentPlanDay: nextDay,
          });
        }
      }

      const completed: SessionRun = {
        ...state.activeRun,
        responses: { ...state.draftResponses },
        currentBlockIndex: state.currentBlockIndex,
        overallElapsedSec: state.overallElapsedSec,
        status: 'completed',
        endedAt: now,
        summary: {
          durationSec: state.overallElapsedSec,
        },
      };

      await db.sessionRuns.put(completed);
      set({
        activeRun: completed,
        isRunning: false,
        isPaused: false,
        transitionCountdown: null,
        lastSavedAt: now,
      });
    },

    persistToDb: async () => {
      const state = get();
      if (!state.activeRun) return;
      const now = new Date().toISOString();
      const snapshot: SessionRun = {
        ...state.activeRun,
        responses: state.draftResponses,
        currentBlockIndex: state.currentBlockIndex,
        overallElapsedSec: state.overallElapsedSec,
      };
      await db.sessionRuns.put(snapshot);
      set({ lastSavedAt: now });
    },

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
`;

const targetPath = path.join(process.cwd(), 'src/stores/sessionStore.ts');
fs.writeFileSync(targetPath, sessionStoreContent, 'utf8');
console.log('Fixed src/stores/sessionStore.ts (resetBlockForRewrite restored)!');