// fix-all-phase1-core-and-blocks.mjs
// Phase 1 of 2: Fixes 3-2-1 countdown freeze, Gemini grading hang/gibberish handling,
// Read & Complete auto-saving, Shadowing audio-text sync, and Dictogloss step-by-step UI guide.
// Run from project root: node fix-all-phase1-core-and-blocks.mjs

import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. SESSION STORE: Unpause on advanceBlock & jumpToBlock (Fixes Stuck at 3!)
  // =========================================================================
  'src/stores/sessionStore.ts': `import { create } from 'zustand';
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
  planSlotIndex?: number;
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
  skipTransition: () => void;
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
      const safeIndex = Math.min(
        Math.max(0, run.currentBlockIndex),
        Math.max(0, run.blockConfigs.length - 1)
      );
      const activeBlock = run.blockConfigs[safeIndex];
      const savedBlockTime = activeBlock
        ? (run.responses[activeBlock.id]?.timeSpentSec ?? 0)
        : 0;
      set({
        activeRun: { ...run, status: 'in-progress' },
        currentBlockIndex: safeIndex,
        blockElapsedSec: Math.min(savedBlockTime, Math.max(0, (activeBlock?.durationSec ?? 60) - 1)),
        overallElapsedSec: run.overallElapsedSec ?? 0,
        isRunning: true,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: { ...run.responses },
        lastSavedAt: new Date().toISOString(),
      });
    },

    skipTransition: () => {
      set({
        transitionCountdown: null,
        blockElapsedSec: 0,
        isPaused: false,
        isRunning: true,
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
          isPaused: false,
          isRunning: true,
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
              currentResp.aiOverallScore !== undefined
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

      // CRITICAL FIX: Always unpause (isPaused: false, isRunning: true) when advancing
      // so the 3-2-1 transition countdown never freezes after Instant Feedback!
      set({
        currentBlockIndex: state.currentBlockIndex + 1,
        blockElapsedSec: 0,
        transitionCountdown: TRANSITION_SEC,
        isPaused: false,
        isRunning: true,
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
        blockElapsedSec: Math.min(priorSpent, Math.max(0, targetBlock.durationSec - 1)),
        transitionCountdown: null,
        isPaused: false,
        isRunning: true,
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
              resp.aiOverallScore !== undefined
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
`,

  // =========================================================================
  // 2. TRANSITION OVERLAY: Add "Start Block Now ->" Skip Button on 3-2-1 Screen
  // =========================================================================
  'src/components/exam/TransitionOverlay.tsx': `import { useSessionStore } from '../../stores/sessionStore';

interface TransitionOverlayProps {
  countdown: number;
  nextBlockName: string;
}

export function TransitionOverlay({ countdown, nextBlockName }: TransitionOverlayProps) {
  const skipTransition = useSessionStore((s) => s.skipTransition);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-xs flex flex-col items-center justify-center text-white p-6">
      <p className="text-xs font-bold uppercase tracking-widest text-primary-400 mb-2">
        Up Next
      </p>
      <h2 className="text-2xl font-bold mb-6 text-center">{nextBlockName}</h2>
      <div className="w-24 h-24 rounded-full border-4 border-primary-400 flex items-center justify-center text-5xl font-extrabold font-mono animate-pulse mb-8">
        {countdown}
      </div>
      <button
        type="button"
        onClick={skipTransition}
        className="px-5 py-2.5 bg-white/10 hover:bg-white/20 border border-white/25 rounded-xl text-xs font-bold text-white cursor-pointer transition-colors"
      >
        Skip Countdown & Start Block Now →
      </button>
    </div>
  );
}
`,

  // =========================================================================
  // 3. GEMINI SERVICE: Hard Promise.race Timeout + Gibberish Detector + Fallback
  // =========================================================================
  'src/services/gemini.ts': `import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIFeedback } from '../types';

export type EvaluationResult = AIFeedback;

export interface EvaluateParams {
  apiKey: string;
  evalPromptTemplate: string;
  variables: Record<string, string>;
}

const GEMINI_MODEL = 'gemini-2.0-flash';
const REQUEST_TIMEOUT_MS = 18_000;

/**
 * Detects if the student input is keyboard-smash gibberish (e.g., "aksdj ajsd kajd...")
 * or way too short so we can return an immediate, accurate DET score without hanging.
 */
function detectGibberishOrEmpty(text: string): { isGibberish: boolean; reason?: string } {
  const clean = text.trim();
  if (!clean || clean === '[No speech detected in recording]' || clean === '[No speech detected]') {
    return { isGibberish: true, reason: 'No meaningful response or speech was detected.' };
  }

  const words = clean
    .toLowerCase()
    .replace(/[^a-z\\s]/g, '')
    .split(/\\s+/)
    .filter(Boolean);

  if (words.length < 3) {
    return {
      isGibberish: true,
      reason: 'Response is too brief (fewer than 3 words) to demonstrate proficiency.',
    };
  }

  // Check how many words contain a basic English vowel or common structure,
  // or repeated keyboard smash patterns like "aksdj", "kdd", "djdak"
  const commonShortWords = new Set([
    'a', 'i', 'in', 'on', 'at', 'to', 'of', 'is', 'it', 'be', 'as', 'by', 'or', 'we', 'an', 'so', 'no', 'up', 'if', 'my', 'do', 'go'
  ]);
  let suspiciousCount = 0;

  for (const w of words) {
    const hasVowel = /[aeiouy]/.test(w);
    const hasSmashCluster = /[bcdfghjklmnpqrstvwxz]{4,}|(aj|jd|kd|dk|sj|ak){2,}/i.test(w);
    if (!hasVowel || hasSmashCluster || (w.length <= 2 && !commonShortWords.has(w))) {
      suspiciousCount += 1;
    }
  }

  if (suspiciousCount / words.length >= 0.45) {
    return {
      isGibberish: true,
      reason:
        'Response consists largely of non-word character sequences or keyboard gibberish rather than coherent English clauses.',
    };
  }

  return { isGibberish: false };
}

/**
 * Builds an instant heuristic evaluation when input is gibberish or when offline/timed out.
 */
export function buildLocalFallbackEvaluation(
  studentText: string,
  promptText: string,
  noteReason?: string
): AIFeedback {
  const check = detectGibberishOrEmpty(studentText);
  if (check.isGibberish) {
    return {
      overallScore: 25,
      subscores: {
        literacy: 25,
        comprehension: 25,
        conversation: 25,
        production: 20,
      },
      criteria: {
        grammar: check.reason || 'Unintelligible or incomplete syntax.',
        vocabulary: 'No valid academic collocations or recognizable lexical items detected.',
        coherence: 'Lacks meaningful propositional content addressing the prompt.',
      },
      strengths: ['Submitted block attempt'],
      weaknesses: [
        check.reason || 'Input did not contain coherent English sentences.',
        'Did not address the task prompt or incorporate target collocations.',
      ],
      suggestions: [
        'Write complete, meaningful sentences that directly address the prompt topic.',
        'Click "Apply Fixes & Rewrite" below to replace the placeholder text with a real paragraph.',
      ],
      suggestedFix: \` Write 3–4 structured sentences addressing: "\${promptText.slice(0, 120)}..."\`,
      note: noteReason,
    };
  }

  const words = studentText.trim().split(/\\s+/).filter(Boolean);
  const wordCount = words.length;
  const uniqueRatio = new Set(words.map((w) => w.toLowerCase())).size / Math.max(1, wordCount);
  const hasComplexMarkers =
    /\\b(although|whereas|consequently|furthermore|nevertheless|while|despite|therefore|moreover)\\b/i.test(
      studentText
    );

  const baseScore = Math.min(
    145,
    Math.max(
      65,
      Math.round(75 + Math.min(45, wordCount * 0.45) + (hasComplexMarkers ? 15 : 0) + uniqueRatio * 15)
    )
  );

  return {
    overallScore: baseScore,
    subscores: {
      literacy: baseScore,
      comprehension: baseScore,
      conversation: Math.max(60, baseScore - 5),
      production: baseScore,
    },
    criteria: {
      grammar: hasComplexMarkers
        ? 'Includes subordinate or discourse transitions.'
        : 'Add more complex subordination (whereas, although, consequently).',
      vocabulary: \`\${wordCount} words (\${Math.round(uniqueRatio * 100)}% lexical variety).\`,
      coherence: 'Evaluated via instant local rubric fallback.',
    },
    strengths: [
      \`Produced \${wordCount} words on topic\`,
      hasComplexMarkers
        ? 'Used academic discourse markers'
        : 'Clear baseline sentence structure',
    ],
    weaknesses: hasComplexMarkers
      ? ['Could further tighten C1/C2 collocation precision']
      : ['Limited use of subordinate clauses and high-level academic transitions'],
    suggestions: [
      'Embed relative clauses and contrastive transitions (whereas, meskipun/although).',
    ],
    note: noteReason || 'Evaluated via local offline fallback rubric.',
  };
}

function interpolateTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let output = template.replace(/\\{\\{(\\w+)\\}\\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });

  const studentText = vars.response || vars.transcript || '';
  if (studentText && !template.includes('{{response}}') && !template.includes('{{transcript}}')) {
    output += \`\\n\\n---\\nTask Prompt: \${vars.prompt ?? ''}\\nDuration: \${vars.durationSec ?? 0}s\\nStudent Response:\\n\${studentText}\`;
  }
  return output;
}

function validateEvaluationResult(data: unknown): AIFeedback {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Gemini returned a non-object response.');
  }
  const obj = data as Record<string, unknown>;

  const toNumericRecord = (val: unknown): Record<string, number> => {
    if (typeof val !== 'object' || val === null) return {};
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => [k, Math.round(v as number)])
    );
  };

  const subscores = toNumericRecord(obj.subscores ?? obj.subscore_breakdown);

  const criteria: Record<string, string> = {};
  if (typeof obj.criteria === 'object' && obj.criteria !== null) {
    for (const [k, v] of Object.entries(obj.criteria as Record<string, unknown>)) {
      if (typeof v === 'string') criteria[k] = v;
      else if (typeof v === 'number' && !(k in subscores)) subscores[k] = Math.round(v);
    }
  }

  const toStringArray = (val: unknown): string[] => {
    if (!Array.isArray(val)) return [];
    return val.filter((item): item is string => typeof item === 'string');
  };

  const subValues = Object.values(subscores);
  const computedAvg =
    subValues.length > 0
      ? Math.round(subValues.reduce((a, b) => a + b, 0) / subValues.length)
      : undefined;

  const overallScore =
    typeof obj.overallScore === 'number'
      ? Math.round(obj.overallScore)
      : computedAvg;

  const suggestions = toStringArray(obj.suggestions);
  const suggestedFix = typeof obj.suggestedFix === 'string' ? obj.suggestedFix : undefined;
  if (suggestedFix && !suggestions.includes(suggestedFix)) {
    suggestions.unshift(\`150-Band Rewrite: \${suggestedFix}\`);
  }

  return {
    overallScore,
    subscores,
    criteria,
    strengths: toStringArray(obj.strengths),
    weaknesses: toStringArray(obj.weaknesses),
    suggestions,
    suggestedFix,
    note: typeof obj.note === 'string' ? obj.note : undefined,
  };
}

export async function evaluateResponse(params: EvaluateParams): Promise<AIFeedback> {
  const { apiKey, evalPromptTemplate, variables } = params;
  const studentText = (variables.response || variables.transcript || '').trim();
  const promptText = variables.prompt || '';

  // 1. Instant Gibberish / Empty Check (prevents hanging on "aksdj ajsd...")
  const gibberishCheck = detectGibberishOrEmpty(studentText);
  if (gibberishCheck.isGibberish) {
    return buildLocalFallbackEvaluation(studentText, promptText);
  }

  // 2. If no API key configured, use local rubric immediately instead of failing
  if (!apiKey || !apiKey.trim()) {
    return buildLocalFallbackEvaluation(
      studentText,
      promptText,
      'Gemini API key not set — graded using built-in local heuristic rubric.'
    );
  }

  const prompt = interpolateTemplate(evalPromptTemplate, variables);

  try {
    return await callGeminiWithTimeout(apiKey.trim(), prompt);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return buildLocalFallbackEvaluation(
      studentText,
      promptText,
      \`Gemini API timed out or was unreachable (\${errMsg.slice(0, 80)}) — graded via local fallback rubric.\`
    );
  }
}

async function callGeminiWithTimeout(apiKey: string, prompt: string): Promise<AIFeedback> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error('Gemini evaluation timed out after 18 seconds')),
      REQUEST_TIMEOUT_MS
    );
  });

  const requestPromise = (async () => {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const text = result.response.text();
    if (!text) throw new Error('Gemini returned an empty response.');
    const parsed = JSON.parse(text) as unknown;
    return validateEvaluationResult(parsed);
  })();

  return Promise.race([requestPromise, timeoutPromise]);
}
`,

  // =========================================================================
  // 4. INTERACTIVE READING BLOCK: Auto-Save & Auto-Grade on Every Keystroke!
  // =========================================================================
  'src/components/exam/blocks/InteractiveReadingBlock.tsx': `import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db, ensureDatabaseUpgraded } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type {
  BlockConfig,
  QuestionBankItem,
  ReadAndCompleteBlank,
  ReadAndCompleteData,
  InteractiveReadingData,
} from '../../../types';

const STEP_LABELS = [
  '1. Complete the Sentences',
  '2. Complete the Passage',
  '3. Highlight the Answer #1',
  '4. Highlight the Answer #2',
  '5. Identify the Idea',
  '6. Title the Passage',
];

function computeReadAndCompleteEvaluation(
  rc: ReadAndCompleteData,
  activeItem: QuestionBankItem,
  inputs: Record<string, string>
) {
  let earned = 0;
  const total = rc.blanks.length;
  const missedWords: string[] = [];

  for (const b of rc.blanks) {
    const userSuffix = (inputs[b.id] ?? '').trim().toLowerCase();
    if (userSuffix === b.missingSuffix.toLowerCase()) {
      earned += 1;
    } else {
      missedWords.push(
        \`\${b.prefix}[\${b.missingSuffix}] (you typed: "\${b.prefix}\${userSuffix || '___'}")\`
      );
    }
  }

  const accuracy = earned / Math.max(1, total);
  const detScore = Math.round(65 + accuracy * 95);
  const summaryTranscript = \`[Read and Complete — \${rc.title} (\${rc.sourceName})] Score: \${earned}/\${total} (\${Math.round(
    accuracy * 100
  )}%) -> DET Band \${detScore}/160. \${
    missedWords.length > 0
      ? 'Missed words: ' + missedWords.join(', ')
      : 'All boxed words completed with 100% accuracy!'
  }\`;

  return {
    earned,
    total,
    detScore,
    missedWords,
    patch: {
      questionId: activeItem.id,
      questionType: 'read-and-complete',
      promptSnapshot: activeItem.prompt,
      textOrTranscript: summaryTranscript,
      aiOverallScore: detScore,
      aiSubscores: {
        literacy: detScore,
        comprehension: detScore,
        conversation: Math.max(60, detScore - 5),
        production: Math.max(60, detScore - 5),
      },
      aiFeedback: {
        overallScore: detScore,
        subscores: {
          literacy: detScore,
          comprehension: detScore,
          conversation: Math.max(60, detScore - 5),
          production: Math.max(60, detScore - 5),
        },
        criteria: {
          lexical_cloze: \`\${earned} / \${total} boxed words correct (\${Math.round(accuracy * 100)}%)\`,
          passage: rc.title,
        },
        strengths:
          earned >= total - 1
            ? ['Excellent orthographic & collocation recall under time pressure']
            : [\`Completed \${earned} of \${total} word completions accurately\`],
        weaknesses: missedWords,
        suggestions: [
          'Pay attention to grammatical suffixes (-tion, -ive, -ly, -ments) and exact letter box counts.',
        ],
      },
    },
  };
}

function computeInteractiveReadingEvaluation(
  ir: InteractiveReadingData,
  activeItem: QuestionBankItem,
  state: {
    clozeAnswers: Record<string, string>;
    selectedGapSentence: string;
    highlighted1: string;
    highlighted2: string;
    selectedIdea: string;
    selectedTitle: string;
  }
) {
  let earned = 0;
  const totalPossible = ir.blanks.length + 5;
  const wrongDetails: string[] = [];
  const rightDetails: string[] = [];

  for (const b of ir.blanks) {
    if (state.clozeAnswers[b.id] === b.correctAnswer) {
      earned += 1;
    } else {
      wrongDetails.push(
        \`Blank [\${b.id}]: chose "\${state.clozeAnswers[b.id] || 'none'}" (Correct: "\${b.correctAnswer}")\`
      );
    }
  }
  if (earned === ir.blanks.length) {
    rightDetails.push('Perfect lexical precision on Step 1 (Complete the Sentences).');
  }

  if (state.selectedGapSentence === ir.correctPassageGap) {
    earned += 1;
    rightDetails.push('Correctly bridged discourse transition in Step 2 (Complete the Passage).');
  } else {
    wrongDetails.push('Missed discourse transition sentence in Step 2 (Complete the Passage).');
  }

  if (state.highlighted1.trim() === ir.correctHighlight1.trim()) {
    earned += 1;
    rightDetails.push('Pinpointed exact factual evidence in Step 3 (Highlight the Answer #1).');
  } else {
    wrongDetails.push('Inaccurate sentence selection on Step 3 (Highlight the Answer #1).');
  }

  if (state.highlighted2.trim() === ir.correctHighlight2.trim()) {
    earned += 1;
    rightDetails.push('Pinpointed exact factual evidence in Step 4 (Highlight the Answer #2).');
  } else {
    wrongDetails.push('Inaccurate sentence selection on Step 4 (Highlight the Answer #2).');
  }

  if (state.selectedIdea === ir.correctMainIdea) {
    earned += 1;
    rightDetails.push('Identified primary macro-thesis in Step 5 (Identify the Idea).');
  } else {
    wrongDetails.push('Missed main idea synthesis in Step 5 (Identify the Idea).');
  }

  if (state.selectedTitle === ir.correctTitle) {
    earned += 1;
  } else {
    wrongDetails.push('Selected suboptimal academic title in Step 6.');
  }

  const accuracy = earned / Math.max(1, totalPossible);
  const detScore = Math.round(65 + accuracy * 95);

  const summaryTranscript = [
    \`[Interactive Reading — \${ir.sourceName}]\`,
    \`Accuracy: \${earned}/\${totalPossible} (\${Math.round(accuracy * 100)}%) -> DET Band \${detScore}/160\`,
    wrongDetails.length > 0
      ? \`Mistakes: \${wrongDetails.join(' | ')}\`
      : 'Zero errors across all 6 steps!',
  ].join('\\n');

  return {
    earned,
    totalPossible,
    detScore,
    patch: {
      questionId: activeItem.id,
      questionType: 'interactive-reading',
      promptSnapshot: activeItem.prompt,
      textOrTranscript: summaryTranscript,
      aiOverallScore: detScore,
      aiSubscores: {
        literacy: detScore,
        comprehension: detScore,
        conversation: Math.max(60, detScore - 5),
        production: Math.max(60, detScore - 5),
      },
      aiFeedback: {
        overallScore: detScore,
        subscores: {
          literacy: detScore,
          comprehension: detScore,
          conversation: Math.max(60, detScore - 5),
          production: Math.max(60, detScore - 5),
        },
        criteria: {
          reading_accuracy: \`\${earned} / \${totalPossible} items correct (\${Math.round(accuracy * 100)}%)\`,
          source: ir.sourceName,
        },
        strengths:
          rightDetails.length > 0 ? rightDetails : ['Completed interactive reading suite'],
        weaknesses: wrongDetails,
        suggestions: [
          'Pay close attention to discourse markers (however, consequently, whereas) when bridging paragraphs.',
        ],
      },
    },
  };
}

function SegmentedWordBlank({
  blank,
  value,
  submitted,
  onChange,
}: {
  blank: ReadAndCompleteBlank;
  value: string;
  submitted: boolean;
  onChange: (newVal: string) => void;
}) {
  const len = blank.missingSuffix.length;
  const boxRefs = useRef<(HTMLInputElement | null)[]>([]);

  const chars = Array.from({ length: len }, (_, i) => value[i] ?? '');
  const isCorrect =
    submitted && value.trim().toLowerCase() === blank.missingSuffix.toLowerCase();
  const isWrong =
    submitted && value.trim().toLowerCase() !== blank.missingSuffix.toLowerCase();

  const updateCharAt = (index: number, char: string) => {
    const next = [...chars];
    next[index] = char;
    onChange(next.join(''));
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (chars[index]) {
        updateCharAt(index, '');
      } else if (index > 0) {
        updateCharAt(index - 1, '');
        boxRefs.current[index - 1]?.focus();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      boxRefs.current[index - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowRight' && index < len - 1) {
      e.preventDefault();
      boxRefs.current[index + 1]?.focus();
      return;
    }
  };

  const handleInput = (index: number, e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (!raw) {
      updateCharAt(index, '');
      return;
    }
    const clean = raw.replace(/[^a-zA-Z-]/g, '');
    if (!clean) return;

    if (clean.length === 1) {
      updateCharAt(index, clean);
      if (index < len - 1) {
        boxRefs.current[index + 1]?.focus();
      }
    } else {
      const next = [...chars];
      for (let i = 0; i < clean.length && index + i < len; i++) {
        next[index + i] = clean[i];
      }
      onChange(next.join(''));
      const nextFocus = Math.min(len - 1, index + clean.length);
      boxRefs.current[nextFocus]?.focus();
    }
  };

  return (
    <span className="inline-flex items-center mx-1 my-0.5 align-baseline">
      <span className="font-bold text-slate-900 font-mono text-base px-1 py-0.5 bg-slate-200/80 rounded-l-md border border-r-0 border-slate-300">
        {blank.prefix}
      </span>

      <span className="inline-flex items-center">
        {chars.map((ch, i) => (
          <input
            key={i}
            ref={(el) => {
              boxRefs.current[i] = el;
            }}
            type="text"
            inputMode="text"
            maxLength={2}
            value={ch}
            onChange={(e) => handleInput(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            aria-label={\`\${blank.prefix} letter \${i + 1} of \${len}\`}
            className={\`w-6 h-7 text-center font-mono text-sm font-bold border border-r-0 last:border-r last:rounded-r-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:z-10 transition-colors \${
              isCorrect
                ? 'bg-green-100 border-green-500 text-green-900'
                : isWrong
                ? 'bg-red-50 border-red-400 text-red-800'
                : ch
                ? 'bg-primary-50 border-primary-400 text-primary-900'
                : 'bg-white border-slate-300 text-slate-800'
            }\`}
          />
        ))}
      </span>

      {isWrong && (
        <span className="ml-1.5 text-xs font-mono font-bold text-green-800 bg-green-100 px-1.5 py-0.5 rounded">
          ✓ {blank.fullWord}
        </span>
      )}
    </span>
  );
}

export function InteractiveReadingBlock({
  block,
  forcedMode,
}: {
  block: BlockConfig;
  forcedMode?: 'interactive-reading' | 'read-and-complete';
}) {
  const updateResponse = useSessionStore((s) => s.updateResponse);

  const initialMode: 'interactive-reading' | 'read-and-complete' =
    forcedMode ??
    (block.preferredQuestionType === 'interactive-reading'
      ? 'interactive-reading'
      : 'read-and-complete');

  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'interactive-reading' | 'read-and-complete'>(initialMode);
  const [currentIdx, setCurrentIdx] = useState(0);

  const [step, setStep] = useState(0);
  const [clozeAnswers, setClozeAnswers] = useState<Record<string, string>>({});
  const [selectedGapSentence, setSelectedGapSentence] = useState<string>('');
  const [highlighted1, setHighlighted1] = useState<string>('');
  const [highlighted2, setHighlighted2] = useState<string>('');
  const [selectedIdea, setSelectedIdea] = useState<string>('');
  const [selectedTitle, setSelectedTitle] = useState<string>('');
  const [submittedReading, setSubmittedReading] = useState(false);

  const [prefixInputs, setPrefixInputs] = useState<Record<string, string>>({});
  const [submittedCloze, setSubmittedCloze] = useState(false);
  const [lastClozeScore, setLastClozeScore] = useState<{
    earned: number;
    total: number;
    detScore: number;
  } | null>(null);

  useEffect(() => {
    if (forcedMode) {
      setMode(forcedMode);
    } else if (
      block.preferredQuestionType === 'interactive-reading' ||
      block.preferredQuestionType === 'read-and-complete'
    ) {
      setMode(block.preferredQuestionType);
    }
  }, [forcedMode, block.preferredQuestionType]);

  useEffect(() => {
    void ensureDatabaseUpgraded().then(async () => {
      const [all, doneSet] = await Promise.all([
        db.questionBank.toArray(),
        getCompletedQuestionIds(),
      ]);
      setCompletedIds(doneSet);

      const readingItems = all.filter(
        (q) =>
          q.skill === 'reading' &&
          (q.type === 'interactive-reading' || q.type === 'read-and-complete')
      );

      readingItems.sort((a, b) => {
        const aDone = doneSet.has(a.id) ? 1 : 0;
        const bDone = doneSet.has(b.id) ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return (a.dayNumber ?? 99) - (b.dayNumber ?? 99);
      });

      setQuestions(readingItems);

      if (block.questionSetId) {
        const pinned = readingItems.find((q) => q.id === block.questionSetId);
        if (
          pinned &&
          (pinned.type === 'read-and-complete' || pinned.type === 'interactive-reading')
        ) {
          setMode(pinned.type);
          const subset = readingItems.filter((q) => q.type === pinned.type);
          const idx = subset.findIndex((q) => q.id === pinned.id);
          if (idx >= 0) setCurrentIdx(idx);
        }
      }
    });
  }, [block.questionSetId]);

  const filteredList = useMemo(
    () => questions.filter((q) => q.type === mode),
    [questions, mode]
  );

  const activeItem = filteredList[currentIdx] ?? null;
  const ir = activeItem?.interactiveReading;
  const rc = activeItem?.readAndComplete;

  // CRITICAL FIX: Auto-save & auto-grade Read & Complete whenever any letter box changes
  // so that even if the user clicks "Next Block" without clicking "Check Answers",
  // the full evaluation & DET score are already recorded in draftResponses!
  const syncReadAndCompleteToStore = useCallback(
    (nextInputs: Record<string, string>, markDone: boolean) => {
      if (!rc || !activeItem) return;
      const hasAnyTyped = Object.values(nextInputs).some((v) => v.trim().length > 0);
      if (!hasAnyTyped && !markDone) return;

      const evalData = computeReadAndCompleteEvaluation(rc, activeItem, nextInputs);
      updateResponse(block.id, evalData.patch);

      if (markDone || Object.values(nextInputs).filter((v) => v.trim().length > 0).length >= 3) {
        void markQuestionCompleted(activeItem.id);
        setCompletedIds((prev) => new Set(prev).add(activeItem.id));
      }
      return evalData;
    },
    [activeItem, block.id, rc, updateResponse]
  );

  // CRITICAL FIX: Auto-save & auto-grade 6-Step Interactive Reading whenever any step is answered
  useEffect(() => {
    if (mode !== 'interactive-reading' || !ir || !activeItem) return;
    const anyAnswered =
      Object.keys(clozeAnswers).length > 0 ||
      Boolean(selectedGapSentence) ||
      Boolean(highlighted1) ||
      Boolean(highlighted2) ||
      Boolean(selectedIdea) ||
      Boolean(selectedTitle);

    if (!anyAnswered) return;

    const evalData = computeInteractiveReadingEvaluation(ir, activeItem, {
      clozeAnswers,
      selectedGapSentence,
      highlighted1,
      highlighted2,
      selectedIdea,
      selectedTitle,
    });
    updateResponse(block.id, evalData.patch);
  }, [
    mode,
    ir,
    activeItem,
    clozeAnswers,
    selectedGapSentence,
    highlighted1,
    highlighted2,
    selectedIdea,
    selectedTitle,
    block.id,
    updateResponse,
  ]);

  const resetStates = () => {
    setStep(0);
    setClozeAnswers({});
    setSelectedGapSentence('');
    setHighlighted1('');
    setHighlighted2('');
    setSelectedIdea('');
    setSelectedTitle('');
    setSubmittedReading(false);
    setPrefixInputs({});
    setSubmittedCloze(false);
    setLastClozeScore(null);
  };

  const handleSwitchPassage = (nextIndex: number) => {
    setCurrentIdx(nextIndex);
    resetStates();
  };

  const handleJumpToNextUnseenPassage = () => {
    const nextUnseenIdx = filteredList.findIndex(
      (q, i) => i !== currentIdx && !completedIds.has(q.id)
    );
    if (nextUnseenIdx >= 0) {
      handleSwitchPassage(nextUnseenIdx);
    } else if (filteredList.length > 1) {
      handleSwitchPassage((currentIdx + 1) % filteredList.length);
    }
  };

  const handleGradeInteractiveReading = () => {
    if (!ir || !activeItem) return;
    const evalData = computeInteractiveReadingEvaluation(ir, activeItem, {
      clozeAnswers,
      selectedGapSentence,
      highlighted1,
      highlighted2,
      selectedIdea,
      selectedTitle,
    });
    setSubmittedReading(true);
    void markQuestionCompleted(activeItem.id);
    setCompletedIds((prev) => new Set(prev).add(activeItem.id));
    updateResponse(block.id, evalData.patch);
  };

  const handleGradeReadAndComplete = () => {
    if (!rc || !activeItem) return;
    const evalData = syncReadAndCompleteToStore(prefixInputs, true);
    setSubmittedCloze(true);
    if (evalData) {
      setLastClozeScore({
        earned: evalData.earned,
        total: evalData.total,
        detScore: evalData.detScore,
      });
    }
  };

  const renderParagraphWithDropdowns = () => {
    if (!ir) return null;
    const parts = ir.paragraph1WithBlanks.split(/(\\{\\{\\d+\\}\\})/g);
    return (
      <p className="text-sm sm:text-base text-slate-800 leading-8">
        {parts.map((part, i) => {
          const match = part.match(/^\\{\\{(\\d+)\\}\\}$/);
          if (!match) return <span key={i}>{part}</span>;
          const blankId = match[1];
          const blankObj = ir.blanks.find((b) => b.id === blankId);
          if (!blankObj) return <span key={i}>{part}</span>;
          const val = clozeAnswers[blankId] ?? '';
          const isCorrect = submittedReading && val === blankObj.correctAnswer;
          const isWrong = submittedReading && val !== blankObj.correctAnswer;
          return (
            <span key={i} className="inline-block mx-1">
              <select
                value={val}
                onChange={(e) =>
                  setClozeAnswers((prev) => ({ ...prev, [blankId]: e.target.value }))
                }
                className={\`px-2.5 py-1 text-sm font-bold rounded-lg border-2 transition-colors cursor-pointer \${
                  isCorrect
                    ? 'bg-green-100 border-green-500 text-green-900'
                    : isWrong
                    ? 'bg-red-100 border-red-500 text-red-900'
                    : val
                    ? 'bg-primary-50 border-primary-500 text-primary-900'
                    : 'bg-amber-50 border-amber-300 text-slate-700'
                }\`}
              >
                <option value="">[{blankId}] Select word...</option>
                {blankObj.options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              {isWrong && (
                <span className="ml-1 text-xs font-bold text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
                  ✓ {blankObj.correctAnswer}
                </span>
              )}
            </span>
          );
        })}
      </p>
    );
  };

  const renderClickableSentences = (sentences: string[], isHighlightStep: boolean) => {
    const activeSelection = step === 2 ? highlighted1 : step === 3 ? highlighted2 : '';
    return (
      <p className="text-sm sm:text-base text-slate-800 leading-7">
        {sentences.map((sentence, idx) => {
          const isSelected = activeSelection.trim() === sentence.trim();
          return (
            <span
              key={idx}
              onClick={() => {
                if (!isHighlightStep) return;
                if (step === 2) setHighlighted1(sentence);
                if (step === 3) setHighlighted2(sentence);
              }}
              className={\`inline transition-colors rounded px-1 py-0.5 \${
                isHighlightStep
                  ? isSelected
                    ? 'bg-amber-200 text-slate-900 font-semibold ring-2 ring-amber-400 cursor-pointer'
                    : 'hover:bg-primary-100 cursor-pointer'
                  : ''
              }\`}
            >
              {sentence}{' '}
            </span>
          );
        })}
      </p>
    );
  };

  const rcList = questions.filter((q) => q.type === 'read-and-complete');
  const irList = questions.filter((q) => q.type === 'interactive-reading');
  const unseenInMode = filteredList.filter((q) => !completedIds.has(q.id)).length;

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('read-and-complete');
              const firstUnseen = rcList.findIndex((q) => !completedIds.has(q.id));
              setCurrentIdx(firstUnseen >= 0 ? firstUnseen : 0);
              resetStates();
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'read-and-complete'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
          >
            ✍️ Read and Complete ({rcList.filter((q) => !completedIds.has(q.id)).length}/{rcList.length} Unseen)
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('interactive-reading');
              const firstUnseen = irList.findIndex((q) => !completedIds.has(q.id));
              setCurrentIdx(firstUnseen >= 0 ? firstUnseen : 0);
              resetStates();
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'interactive-reading'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
          >
            📖 Interactive Reading ({irList.filter((q) => !completedIds.has(q.id)).length}/{irList.length} Unseen)
          </button>
        </div>

        {filteredList.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2.5 py-1 rounded-full">
              ✨ {unseenInMode} Unseen Left
            </span>
            <select
              value={currentIdx}
              onChange={(e) => handleSwitchPassage(Number(e.target.value))}
              className="text-xs font-semibold text-slate-800 border border-slate-300 rounded-lg px-2.5 py-1.5 bg-slate-50 max-w-xs"
            >
              {filteredList.map((item, idx) => {
                const isDone = completedIds.has(item.id);
                return (
                  <option key={item.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {item.dayNumber ? \`Day \${item.dayNumber}: \` : \`#\${idx + 1}: \`}
                    {item.readAndComplete?.title || item.prompt.slice(0, 42)}
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              onClick={handleJumpToNextUnseenPassage}
              className="px-3 py-1.5 text-xs font-bold bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer"
            >
              Next Unseen →
            </button>
          </div>
        )}
      </div>

      {mode === 'read-and-complete' && rc && (
        <div className="bg-white border-2 border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-accent-700 bg-accent-50 px-2.5 py-1 rounded">
                  Type the missing letters • {rc.sourceName}
                </span>
                {activeItem?.dayNumber && (
                  <span className="text-xs font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                    Plan Day {activeItem.dayNumber}
                  </span>
                )}
              </div>
              <h3 className="text-lg font-bold text-slate-900 mt-1.5">{rc.title}</h3>
            </div>

            <div className="flex items-center gap-2">
              {lastClozeScore && (
                <span className="text-xs font-bold bg-green-100 text-green-800 border border-green-300 px-3 py-1.5 rounded-lg">
                  Score: {lastClozeScore.earned}/{lastClozeScore.total} • Band {lastClozeScore.detScore}/160
                </span>
              )}
              <button
                type="button"
                onClick={handleGradeReadAndComplete}
                className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer shadow-2xs"
              >
                ✓ Check Answers
              </button>
              {submittedCloze && filteredList.length > 1 && (
                <button
                  type="button"
                  onClick={handleJumpToNextUnseenPassage}
                  className="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  Next Unseen Passage →
                </button>
              )}
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Each small box represents <strong>one missing letter</strong>. Your answers are <strong>auto-saved & auto-scored in real time</strong> for your final session evaluation:
          </p>

          <div className="text-base text-slate-800 leading-10 bg-slate-50 p-6 rounded-xl border border-slate-200">
            {rc.passageWithBlanks.split(/(\\{\\{\\d+\\}\\})/g).map((part, idx) => {
              const match = part.match(/^\\{\\{(\\d+)\\}\\}$/);
              if (!match) return <span key={idx}>{part}</span>;
              const bId = match[1];
              const blank = rc.blanks.find((b) => b.id === bId);
              if (!blank) return <span key={idx}>{part}</span>;

              return (
                <SegmentedWordBlank
                  key={\`\${activeItem?.id}-\${bId}\`}
                  blank={blank}
                  value={prefixInputs[bId] ?? ''}
                  submitted={submittedCloze}
                  onChange={(newVal) => {
                    const next = { ...prefixInputs, [bId]: newVal };
                    setPrefixInputs(next);
                    syncReadAndCompleteToStore(next, false);
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {mode === 'interactive-reading' && ir && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {STEP_LABELS.map((label, idx) => (
              <button
                key={label}
                type="button"
                onClick={() => setStep(idx)}
                className={\`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer \${
                  step === idx
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }\`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 bg-white border-2 border-slate-200 rounded-2xl p-5 space-y-4 shadow-xs">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <span className="text-xs font-bold uppercase tracking-wider text-primary-700 bg-primary-50 px-2.5 py-1 rounded">
                  Source: {ir.sourceName}
                </span>
                {(step === 2 || step === 3) && (
                  <span className="text-xs font-bold text-amber-800 bg-amber-100 px-2.5 py-1 rounded animate-pulse">
                    Click a sentence below to highlight your answer
                  </span>
                )}
              </div>

              {step === 0
                ? renderParagraphWithDropdowns()
                : renderClickableSentences(ir.paragraph1Sentences, step === 2 || step === 3)}

              {step >= 1 && (
                <div
                  className={\`p-3 rounded-xl border-2 text-sm font-medium transition-all \${
                    selectedGapSentence
                      ? submittedReading
                        ? selectedGapSentence === ir.correctPassageGap
                          ? 'bg-green-50 border-green-400 text-green-900'
                          : 'bg-red-50 border-red-400 text-red-900'
                        : 'bg-primary-50 border-primary-400 text-slate-900'
                      : 'bg-amber-50/70 border-dashed border-amber-400 text-amber-800 italic'
                  }\`}
                >
                  {selectedGapSentence ||
                    '[Step 2 Gap: Select the best transitional sentence on the right to bridge these two paragraphs...]'}
                </div>
              )}

              {step >= 1 &&
                renderClickableSentences(ir.paragraph2Sentences, step === 2 || step === 3)}
            </div>

            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between space-y-4 shadow-xs">
              <div className="space-y-4">
                <span className="text-xs font-bold uppercase tracking-wider text-accent-700 bg-accent-50 px-2.5 py-1 rounded">
                  {STEP_LABELS[step]}
                </span>

                {step === 0 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best word for each blank in the passage on the left.
                    </h4>
                    <div className="space-y-2 pt-2">
                      {ir.blanks.map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center justify-between text-xs bg-slate-50 p-2.5 rounded-lg border border-slate-200"
                        >
                          <span className="font-bold text-slate-700">Blank [{b.id}]:</span>
                          <span className="font-semibold text-primary-700">
                            {clozeAnswers[b.id] || 'Not selected yet'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {step === 1 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best sentence to fill in the blank between the two paragraphs.
                    </h4>
                    <div className="space-y-2">
                      {ir.passageGapOptions.map((opt) => {
                        const chosen = selectedGapSentence === opt;
                        const isRight = submittedReading && opt === ir.correctPassageGap;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedGapSentence(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Click a sentence in the passage to answer the question below:
                    </h4>
                    <div className="p-3.5 bg-slate-900 text-white rounded-xl text-xs font-semibold leading-relaxed">
                      {ir.highlightQuestion1}
                    </div>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-slate-800">
                      <strong>Your Highlighted Sentence:</strong>
                      <p className="mt-1 italic">
                        {highlighted1 || '(Click directly on any sentence in the left passage)'}
                      </p>
                    </div>
                    {submittedReading && highlighted1.trim() !== ir.correctHighlight1.trim() && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-900">
                        <strong>✓ Correct Sentence:</strong> {ir.correctHighlight1}
                      </div>
                    )}
                  </div>
                )}

                {step === 3 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Click a sentence in the passage to answer the second question:
                    </h4>
                    <div className="p-3.5 bg-slate-900 text-white rounded-xl text-xs font-semibold leading-relaxed">
                      {ir.highlightQuestion2}
                    </div>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-slate-800">
                      <strong>Your Highlighted Sentence:</strong>
                      <p className="mt-1 italic">
                        {highlighted2 || '(Click directly on any sentence in the left passage)'}
                      </p>
                    </div>
                    {submittedReading && highlighted2.trim() !== ir.correctHighlight2.trim() && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-900">
                        <strong>✓ Correct Sentence:</strong> {ir.correctHighlight2}
                      </div>
                    )}
                  </div>
                )}

                {step === 4 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the idea that is expressed in the passage:
                    </h4>
                    <div className="space-y-2">
                      {ir.mainIdeaOptions.map((opt) => {
                        const chosen = selectedIdea === opt;
                        const isRight = submittedReading && opt === ir.correctMainIdea;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedIdea(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {step === 5 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best title for the passage:
                    </h4>
                    <div className="space-y-2">
                      {ir.titleOptions.map((opt) => {
                        const chosen = selectedTitle === opt;
                        const isRight = submittedReading && opt === ir.correctTitle;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedTitle(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
                <button
                  type="button"
                  disabled={step === 0}
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg disabled:opacity-40 cursor-pointer"
                >
                  ← Previous Step
                </button>
                {step < 5 ? (
                  <button
                    type="button"
                    onClick={() => setStep((s) => Math.min(5, s + 1))}
                    className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
                  >
                    Next Step ({step + 2}/6) →
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleGradeInteractiveReading}
                      className="px-4 py-2 bg-green-600 text-white text-xs font-bold rounded-lg hover:bg-green-700 cursor-pointer shadow-xs"
                    >
                      ✓ Check All 6 Answers
                    </button>
                    {submittedReading && filteredList.length > 1 && (
                      <button
                        type="button"
                        onClick={handleJumpToNextUnseenPassage}
                        className="px-3 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
                      >
                        Next Unseen →
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 5. SHADOWING BLOCK: Always Sync Transcript with Manifest Audio!
  // =========================================================================
  'src/components/exam/blocks/ShadowingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function computeWordMatchPercent(source: string, spoken: string): number {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\\s]/g, '')
      .split(/\\s+/)
      .filter(Boolean);
  const srcWords = clean(source);
  const spkSet = new Set(clean(spoken));
  if (srcWords.length === 0) return 0;
  const matched = srcWords.filter((w) => spkSet.has(w)).length;
  return Math.round((matched / srcWords.length) * 100);
}

export function ShadowingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [speechRate, setSpeechRate] = useState<number>(block.speechSpeed ?? 1.0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [hideTranscript, setHideTranscript] = useState<boolean>(Boolean(block.blindShadowing));
  const [downloadingYt, setDownloadingYt] = useState(false);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<AudioRecorderService | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];

  useEffect(() => {
    if (block.speechSpeed) setSpeechRate(block.speechSpeed);
    setHideTranscript(Boolean(block.blindShadowing));
  }, [block.id, block.speechSpeed, block.blindShadowing]);

  const loadShadowingPassages = useCallback(async () => {
    const [all, doneSet] = await Promise.all([
      db.questionBank.toArray(),
      getCompletedQuestionIds(),
    ]);
    setCompletedIds(doneSet);

    let manifest: Record<string, { audioUrl: string; text: string }> = {};
    let backendOnline = false;
    try {
      const res = await fetch(\`\${BACKEND_BASE}/audio/manifest\`);
      if (res.ok) {
        backendOnline = true;
        manifest = (await res.json()) as Record<string, { audioUrl: string; text: string }>;
      }
    } catch {
      backendOnline = false;
    }

    const updatedItems: QuestionBankItem[] = [];
    for (const q of all) {
      const clipKey = q.youtubeSource?.clipKey;
      // CRITICAL FIX: Always sync both audioUrl AND verbatim transcript from manifest
      // even if q.audioUrl was already set, so the on-screen text ALWAYS matches the MP3 voice!
      if (clipKey && manifest[clipKey]) {
        const cached = manifest[clipKey];
        const cleanAudioUrl = normalizeAudioUrl(cached.audioUrl);
        const verbatimTranscript = cached.text?.trim() || q.sourceAudioText || q.prompt;
        const upgraded: QuestionBankItem = {
          ...q,
          audioUrl: cleanAudioUrl,
          sourceAudioText: verbatimTranscript,
          prompt: verbatimTranscript,
        };
        if (
          q.audioUrl !== cleanAudioUrl ||
          q.sourceAudioText !== verbatimTranscript ||
          q.prompt !== verbatimTranscript
        ) {
          await db.questionBank.put(upgraded);
        }
        updatedItems.push(upgraded);
      } else {
        // If backend is offline or clip is not in manifest, clear stale localhost audioUrl
        // so browser TTS speaks the exact on-screen text instead of playing a broken/mismatched file
        const hasValidLocalAudio =
          backendOnline && q.audioUrl && !clipKey ? normalizeAudioUrl(q.audioUrl) : '';
        updatedItems.push({
          ...q,
          audioUrl: hasValidLocalAudio || undefined,
        });
      }
    }

    const shadowItems = updatedItems.filter(
      (q) =>
        Boolean(q.audioUrl) ||
        Boolean(q.youtubeSource) ||
        q.tags.includes('shadowing') ||
        q.type === 'read-aloud' ||
        Boolean(q.sourceAudioText)
    );

    shadowItems.sort((a, b) => {
      const aDone = doneSet.has(a.id) ? 1 : 0;
      const bDone = doneSet.has(b.id) ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const aAudio = a.audioUrl ? 2 : a.youtubeSource ? 1 : 0;
      const bAudio = b.audioUrl ? 2 : b.youtubeSource ? 1 : 0;
      return bAudio - aAudio;
    });

    const finalList = shadowItems.length > 0 ? shadowItems : updatedItems;
    setPassages(finalList);

    if (block.questionSetId) {
      const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
      if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
    } else {
      const firstUnseen = finalList.findIndex((q) => !doneSet.has(q.id));
      if (firstUnseen >= 0) setSelectedIdx(firstUnseen);
    }
  }, [block.questionSetId]);

  useEffect(() => {
    void loadShadowingPassages();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, [loadShadowingPassages]);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = normalizeAudioUrl(currentItem?.audioUrl?.trim());
  const ytSource = currentItem?.youtubeSource;
  const sourceText =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'Restoring native wetland corridors along municipal riverbanks not only absorbs seasonal floodwaters before they inundate residential neighborhoods, but also re-establishes critical stopover habitats for migratory songbirds.';

  useEffect(() => {
    const el = audioPlayerRef.current;
    if (!el) return;
    el.playbackRate = speechRate;
    if ('preservesPitch' in el) {
      (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
  }, [speechRate, humanAudioUrl]);

  const handleDownloadCuratedYoutube = async () => {
    if (!currentItem || !ytSource) return;
    setDownloadingYt(true);
    setError(null);
    try {
      const res = await fetch(\`\${BACKEND_BASE}/audio/youtube\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ytSource.url,
          startTime: ytSource.startTime,
          endTime: ytSource.endTime,
          clipKey: ytSource.clipKey,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'Download failed' }));
        throw new Error(errData.detail || 'yt-dlp download failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
      };
      const verbatim = data.text?.trim() || currentItem.sourceAudioText || currentItem.prompt;
      const updatedItem: QuestionBankItem = {
        ...currentItem,
        audioUrl: normalizeAudioUrl(data.audioUrl),
        sourceAudioText: verbatim,
        prompt: verbatim,
      };
      await db.questionBank.put(updatedItem);
      setPassages((prev) =>
        prev.map((p, idx) => (idx === selectedIdx ? updatedItem : p))
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to download YouTube clip. Make sure python app.py is running and yt-dlp is installed.'
      );
    } finally {
      setDownloadingYt(false);
    }
  };

  const playNativeAudio = useCallback(() => {
    if (humanAudioUrl && audioPlayerRef.current) {
      audioPlayerRef.current.playbackRate = speechRate;
      audioPlayerRef.current.currentTime = 0;
      void audioPlayerRef.current.play();
      setIsPlayingAudio(true);
      return;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(sourceText);
      utterance.lang = 'en-US';
      utterance.rate = speechRate;
      utterance.onstart = () => setIsPlayingAudio(true);
      utterance.onend = () => setIsPlayingAudio(false);
      utterance.onerror = () => setIsPlayingAudio(false);
      window.speechSynthesis.speak(utterance);
    }
  }, [humanAudioUrl, sourceText, speechRate]);

  const stopNativeAudio = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlayingAudio(false);
  }, []);

  const rewindFiveSeconds = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.currentTime = Math.max(0, audioPlayerRef.current.currentTime - 5);
    }
  };

  const handleStartShadowing = useCallback(async () => {
    setError(null);
    try {
      const recorder = new AudioRecorderService();
      const hasPermission = await recorder.requestPermission();
      if (!hasPermission) {
        setError('Microphone permission denied. Use headphones so your mic only captures your voice.');
        return;
      }
      await recorder.start();
      recorderRef.current = recorder;
      recordDurationRef.current = 0;
      setRecordingSeconds(0);
      setRecordingState('recording');
      playNativeAudio();
      recTimerRef.current = setInterval(() => {
        recordDurationRef.current += 1;
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start shadowing.');
    }
  }, [playNativeAudio]);

  const handleStopShadowing = useCallback(async () => {
    stopNativeAudio();
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (!recorder || !recorder.isRecording()) return;
    setRecordingState('transcribing');
    try {
      const blob = await recorder.stop();
      recorderRef.current = null;
      const dataUrl = await blobToDataUrl(blob);
      const settings = await db.settings.get('app-settings');
      const stt = createSTTProvider(settings?.sttProvider ?? 'local-whisper', {
        apiKey: settings?.sttApiKey,
        localWhisperUrl: settings?.localWhisperUrl,
      });
      const result = await stt.transcribe(blob, 'en');
      const actualDuration = result.durationSec ?? Math.max(5, recordDurationRef.current);
      const stats = analyzeSpeechTranscript(result.text, actualDuration);

      if (currentItem?.id) {
        void markQuestionCompleted(currentItem.id);
        setCompletedIds((prev) => new Set(prev).add(currentItem.id));
      }

      updateResponse(block.id, {
        audioBlobRef: dataUrl,
        textOrTranscript: result.text || '[No speech detected]',
        timestampedTranscript: result.timestampedText || result.text,
        audioDurationSec: actualDuration,
        promptSnapshot: sourceText,
        questionId: currentItem?.id,
        fillerCount: stats.fillerCount,
        wpm: stats.wpm,
      });
      setRecordingState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Shadowing transcription failed');
      setRecordingState('idle');
    }
  }, [block.id, currentItem?.id, sourceText, stopNativeAudio, updateResponse]);

  const matchPercent = computeWordMatchPercent(sourceText, response?.textOrTranscript ?? '');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <WhisperLiveIndicator />
          <span
            className={\`text-xs font-bold px-2.5 py-1 rounded-full \${
              humanAudioUrl
                ? 'bg-green-100 text-green-800 border border-green-300'
                : ytSource
                ? 'bg-blue-100 text-blue-800 border border-blue-300'
                : 'bg-amber-100 text-amber-800'
            }\`}
          >
            {humanAudioUrl
              ? '🎙️ Real Human Audio + Verbatim Whisper Transcript Synced'
              : ytSource
              ? \`🎬 Curated YouTube Talk: \${ytSource.speaker}\`
              : '🔊 Browser Voice (Matches On-Screen Text)'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <label className="text-xs font-semibold text-slate-600">Speed:</label>
          {[0.85, 0.95, 1.0, 1.1].map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => setSpeechRate(rate)}
              className={\`px-2 py-1 text-xs rounded-lg font-mono font-semibold border cursor-pointer \${
                speechRate === rate
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white text-slate-700 border-slate-200'
              }\`}
            >
              {rate}x
            </button>
          ))}
          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                stopNativeAudio();
                setSelectedIdx(Number(e.target.value));
              }}
              className="text-xs font-semibold text-primary-800 bg-primary-50 border border-primary-200 px-2.5 py-1 rounded-lg cursor-pointer max-w-[240px]"
            >
              {passages.map((p, idx) => {
                const isDone = completedIds.has(p.id);
                return (
                  <option key={p.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {p.sourceAttribution || p.prompt.slice(0, 35)}
                  </option>
                );
              })}
            </select>
          )}
        </div>
      </div>

      {!humanAudioUrl && ytSource && (
        <div className="bg-accent-50 border-2 border-accent-300 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-accent-800">
              🎬 Curated TED / Academic Talk Linked ({ytSource.speaker} • {ytSource.startTime}–{ytSource.endTime})
            </p>
            <p className="text-xs text-slate-600 mt-0.5">
              Currently using Browser Voice for the text below, or click once to download the real human MP3 + exact Faster-Whisper transcript.
            </p>
          </div>
          <button
            type="button"
            disabled={downloadingYt}
            onClick={handleDownloadCuratedYoutube}
            className="px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-lg disabled:opacity-50 cursor-pointer shadow-xs"
          >
            {downloadingYt
              ? '⏳ Downloading & Transcribing via GPU...'
              : '⬇️ Download Real Human Audio + Exact Transcript'}
          </button>
        </div>
      )}

      {humanAudioUrl && (
        <div className="bg-slate-900 text-white rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>
              Human Reference Track ({currentItem?.sourceAttribution || 'Local MP3'} • Pitch-Preserved {speechRate}x)
            </span>
            <button
              type="button"
              onClick={rewindFiveSeconds}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded font-mono text-xs cursor-pointer"
            >
              ↺ Rewind -5s
            </button>
          </div>
          <audio
            ref={audioPlayerRef}
            controls
            src={humanAudioUrl}
            onPlay={() => setIsPlayingAudio(true)}
            onPause={() => setIsPlayingAudio(false)}
            onEnded={() => setIsPlayingAudio(false)}
            className="w-full h-10"
          />
        </div>
      )}

      <div className="bg-primary-50 border border-primary-200 rounded-xl p-5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-primary-700">
            Arguelles Shadowing Script ({currentItem?.sourceAttribution || 'Academic Passage'})
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHideTranscript((h) => !h)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-slate-700 cursor-pointer"
            >
              {hideTranscript ? 'Show Transcript' : 'Blind Shadowing (Hide Text)'}
            </button>
            <button
              type="button"
              onClick={isPlayingAudio ? stopNativeAudio : playNativeAudio}
              className="text-xs font-semibold px-3 py-1 rounded-lg bg-white border border-primary-300 text-primary-800 cursor-pointer"
            >
              {isPlayingAudio ? '⏹ Stop Audio' : '🔊 Preview Audio'}
            </button>
          </div>
        </div>
        {hideTranscript ? (
          <p className="text-sm italic text-slate-500 py-4 text-center">
            Transcript hidden for pure auditory-motor shadowing. Listen closely to the speaker's intonation!
          </p>
        ) : (
          <p className="text-base text-slate-900 leading-relaxed font-medium">{sourceText}</p>
        )}
      </div>

      <div className="flex justify-center">
        {recordingState !== 'recording' && recordingState !== 'transcribing' && (
          <button
            type="button"
            onClick={handleStartShadowing}
            className="px-7 py-4 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm shadow-lg cursor-pointer flex items-center gap-3"
          >
            <span className="w-3 h-3 rounded-full bg-white animate-ping" />
            Play Audio & Record Your Shadowing Simultaneously
          </button>
        )}
        {recordingState === 'recording' && (
          <button
            type="button"
            onClick={handleStopShadowing}
            className="px-7 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm shadow-lg cursor-pointer"
          >
            Stop & Transcribe Shadowing ({recordingSeconds}s)
          </button>
        )}
      </div>

      {recordingState === 'transcribing' && (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-5 text-center text-sm font-semibold text-accent-800">
          Transcribing shadowed speech & computing prosody alignment via Faster-Whisper...
        </div>
      )}

      {response?.textOrTranscript && recordingState !== 'recording' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Lexical Capture</p>
              <p className="text-lg font-bold text-primary-600">{matchPercent}% matched</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Shadowing Pace</p>
              <p className="text-lg font-bold text-slate-800">{response.wpm ?? 0} WPM</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Spoken Duration</p>
              <p className="text-lg font-bold text-slate-800">
                {response.audioDurationSec ?? recordingSeconds}s
              </p>
            </div>
          </div>

          {response.audioBlobRef && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-1">Your Recorded Shadowing:</p>
              <audio controls src={response.audioBlobRef} className="w-full h-9" />
            </div>
          )}

          {response.timestampedTranscript && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-1">
                Timestamped Shadowing Output (Sent to Gemini):
              </p>
              <pre className="text-xs font-mono bg-slate-900 text-green-300 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                {response.timestampedTranscript}
              </pre>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 6. DICTOGLOSS BLOCK: Built-In 3-Step Visual Guide + Manifest Sync
  // =========================================================================
  'src/components/exam/blocks/DictoglossBlock.tsx': `import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

export function DictoglossBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [phase, setPhase] = useState<'listen' | 'reconstruct'>('listen');
  const [playCount, setPlayCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const response = draftResponses[block.id];
  const fragmentNotes = response?.fragmentNotes ?? '';
  const reconstructedText = response?.textOrTranscript ?? '';

  useEffect(() => {
    const loadDictoglossItems = async () => {
      const [all, doneSet] = await Promise.all([
        db.questionBank.toArray(),
        getCompletedQuestionIds(),
      ]);
      setCompletedIds(doneSet);

      let manifest: Record<string, { audioUrl: string; text: string }> = {};
      let backendOnline = false;
      try {
        const res = await fetch(\`\${BACKEND_BASE}/audio/manifest\`);
        if (res.ok) {
          backendOnline = true;
          manifest = (await res.json()) as Record<string, { audioUrl: string; text: string }>;
        }
      } catch {
        backendOnline = false;
      }

      const hydrated = all.map((q) => {
        const clipKey = q.youtubeSource?.clipKey;
        if (clipKey && manifest[clipKey]) {
          const cached = manifest[clipKey];
          const verbatim = cached.text?.trim() || q.sourceAudioText || q.prompt;
          return {
            ...q,
            audioUrl: normalizeAudioUrl(cached.audioUrl),
            sourceAudioText: verbatim,
            prompt: verbatim,
          };
        }
        return {
          ...q,
          audioUrl: backendOnline && q.audioUrl && !clipKey ? normalizeAudioUrl(q.audioUrl) : undefined,
        };
      });

      const items = hydrated.filter(
        (q) => q.tags.includes('dictogloss') || q.skill === 'listening'
      );

      items.sort((a, b) => {
        const aDone = doneSet.has(a.id) ? 1 : 0;
        const bDone = doneSet.has(b.id) ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return (b.audioUrl ? 1 : 0) - (a.audioUrl ? 1 : 0);
      });

      const finalList = items.length > 0 ? items : hydrated;
      setPassages(finalList);

      if (block.questionSetId) {
        const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
        if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
      } else {
        const firstUnseen = finalList.findIndex((q) => !doneSet.has(q.id));
        if (firstUnseen >= 0) setSelectedIdx(firstUnseen);
      }
    };
    void loadDictoglossItems();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [block.questionSetId]);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = normalizeAudioUrl(currentItem?.audioUrl?.trim());
  const sourcePassage =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'Second-language acquisition research indicates that grammatical accuracy emerges naturally when learners internalize multi-word collocation chunks as unified perceptual units rather than assembling individual words through explicit grammatical rules.';

  const handlePlayPassage = useCallback(() => {
    if (humanAudioUrl && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play();
      setIsPlaying(true);
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sourcePassage);
    utterance.lang = 'en-US';
    utterance.rate = 0.98;
    utterance.onstart = () => setIsPlaying(true);
    utterance.onend = () => {
      setIsPlaying(false);
      setPlayCount((c) => c + 1);
    };
    window.speechSynthesis.speak(utterance);
  }, [humanAudioUrl, sourcePassage]);

  const handleNotesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const words = val.trim().split(/\\s+/).filter(Boolean);
    if (words.length > 25) return;
    updateResponse(block.id, {
      fragmentNotes: val,
      promptSnapshot: sourcePassage,
      questionId: currentItem?.id,
    });
  };

  const handleReconstructionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (communicativePressure && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  };

  const fragmentWordCount = fragmentNotes.trim() ? fragmentNotes.trim().split(/\\s+/).length : 0;
  const reconWordCount = reconstructedText.trim()
    ? reconstructedText.trim().split(/\\s+/).length
    : 0;

  return (
    <div className="space-y-5">
      {/* Step-by-Step How-To Guide Banner */}
      <div className="bg-slate-900 text-white rounded-2xl p-4 space-y-2.5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-extrabold uppercase tracking-wider text-primary-400">
            🎧 How Dictogloss Works (3 Simple Steps)
          </span>
          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                setPlayCount(0);
                setPhase('listen');
                setSelectedIdx(Number(e.target.value));
              }}
              className="px-2.5 py-1 text-xs font-semibold text-slate-900 bg-white rounded-lg cursor-pointer max-w-[240px]"
            >
              {passages.map((p, idx) => {
                const isDone = completedIds.has(p.id);
                return (
                  <option key={p.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {p.sourceAttribution || p.prompt.slice(0, 32)}
                  </option>
                );
              })}
            </select>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
          <div
            className={\`p-2.5 rounded-xl border \${
              phase === 'listen' && playCount === 0
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }\`}
          >
            <strong className="text-primary-300 block">Step 1: 1st Listen (Hands Off)</strong>
            Click Play and just listen to grasp the main idea and cause-and-effect structure.
          </div>
          <div
            className={\`p-2.5 rounded-xl border \${
              phase === 'listen' && playCount >= 1
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }\`}
          >
            <strong className="text-primary-300 block">Step 2: 2nd Listen (Fragment Notes)</strong>
            Play a second time and type only 2–4 word shorthand keywords (max 25 words).
          </div>
          <div
            className={\`p-2.5 rounded-xl border \${
              phase === 'reconstruct'
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }\`}
          >
            <strong className="text-primary-300 block">Step 3: Reconstruct Meaning</strong>
            Rebuild the full meaning in your own C1/C2 sentences (not word-for-word memorization).
          </div>
        </div>
      </div>

      {/* Phase Toggle Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-700">
          Current Stage: {phase === 'listen' ? 'Phase 1 — Listening & Shorthand Notes' : 'Phase 2 — Meaning Reconstruction'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPhase('listen')}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer \${
              phase === 'listen' ? 'bg-accent-600 text-white' : 'bg-slate-100 text-slate-600'
            }\`}
          >
            1. Listen & Fragment Notes
          </button>
          <button
            type="button"
            onClick={() => {
              if (audioRef.current) audioRef.current.pause();
              if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                window.speechSynthesis.cancel();
              }
              setIsPlaying(false);
              setPhase('reconstruct');
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer \${
              phase === 'reconstruct' ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600'
            }\`}
          >
            2. Reconstruct Meaning →
          </button>
        </div>
      </div>

      {humanAudioUrl && (
        <audio
          ref={audioRef}
          src={humanAudioUrl}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            setPlayCount((c) => c + 1);
          }}
          className="hidden"
        />
      )}

      {phase === 'listen' ? (
        <div className="bg-accent-50 border-2 border-accent-200 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-xs font-bold text-accent-900">
                Audio Listens Used: {playCount} / 2 Recommended
              </span>
              <p className="text-xs text-slate-600">
                The text is hidden during listening to train your working memory.
              </p>
            </div>
            <button
              type="button"
              onClick={handlePlayPassage}
              disabled={isPlaying}
              className="px-5 py-3 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer shadow-xs"
            >
              {isPlaying
                ? '🔊 Playing Lecture Audio...'
                : playCount === 0
                ? '▶ Play Passage (1st Listen: Just Listen)'
                : '▶ Play Again (2nd Listen: Take Fragment Notes)'}
            </button>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Shorthand Fragment Notes (Abbreviations, arrows, keywords — max 25 words):
            </label>
            <input
              type="text"
              value={fragmentNotes}
              onChange={handleNotesChange}
              placeholder="e.g., SLA: grammar accuracy <- multi-word chunks != isolated words"
              className="w-full px-3.5 py-2.5 bg-white border border-accent-300 rounded-lg text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            <div className="flex justify-between mt-1 text-[11px] text-slate-500">
              <span>Do not write full sentences here — just key concepts</span>
              <span>{fragmentWordCount} / 25 fragment words</span>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => {
                if (audioRef.current) audioRef.current.pause();
                if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                  window.speechSynthesis.cancel();
                }
                setIsPlaying(false);
                setPhase('reconstruct');
              }}
              className="px-5 py-2.5 bg-primary-600 text-white text-xs font-bold rounded-xl hover:bg-primary-700 cursor-pointer shadow-xs"
            >
              Lock Audio & Start Reconstruction →
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold text-amber-900">Your Shorthand Fragment Notes:</p>
              <p className="text-sm font-mono text-amber-800 mt-0.5">
                {fragmentNotes || '(No fragment notes taken — reconstruct from working memory)'}
              </p>
            </div>
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer font-bold text-primary-700 hover:underline">
                Peek at Original Passage (After Attempting)
              </summary>
              <p className="mt-2 p-3 bg-white rounded-lg border border-slate-200 max-w-xl text-slate-800">
                {sourcePassage}
              </p>
            </details>
          </div>

          <textarea
            value={reconstructedText}
            onKeyDown={handleReconstructionKeyDown}
            onChange={(e) => {
              const val = e.target.value;
              const wc = val.trim() ? val.trim().split(/\\s+/).length : 0;
              updateResponse(block.id, {
                textOrTranscript: val,
                promptSnapshot: sourcePassage,
                questionId: currentItem?.id,
              });
              if (wc >= 20 && currentItem && !completedIds.has(currentItem.id)) {
                void markQuestionCompleted(currentItem.id);
                setCompletedIds((prev) => new Set(prev).add(currentItem.id));
              }
            }}
            placeholder="Reconstruct the passage's full meaning in your own words using complex subordination (whereas, consequently, while) and academic collocations..."
            className="w-full min-h-[220px] p-4 text-base text-slate-800 bg-white border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400"
            autoFocus
          />
          <div className="flex justify-between text-xs text-slate-500">
            <span>You are graded on meaning retention + C1/C2 grammar, not exact word matching</span>
            <span className="font-mono font-semibold text-slate-700">
              {reconWordCount} {reconWordCount === 1 ? 'word' : 'words'}
            </span>
          </div>
        </div>
      )}
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
  console.log('Phase 1 Fix Applied:', path.relative(cwd, targetPath));
}
console.log('\nPhase 1 of 2 complete! Now run Phase 2 (fix-all-phase2-postsession-and-history.mjs).');