/**
 * Config Store — CRUD state for templates, questions, and eval prompts.
 *
 * All mutations persist to Dexie immediately. Cached lists stay in sync
 * via optimistic updates after every DB write.
 *
 * Templates use soft delete (`deletedAt` timestamp, never hard-deleted).
 */

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

import type {
  SessionTemplate,
  QuestionBankItem,
  EvalPrompt,
} from '../types';
import { db } from '../db';

// ─── State ───────────────────────────────────────────────────────────────────

interface ConfigState {
  templates: SessionTemplate[];
  questions: QuestionBankItem[];
  evalPrompts: EvalPrompt[];
  editingTemplate: SessionTemplate | null;
  editingQuestion: QuestionBankItem | null;
  editingEvalPrompt: EvalPrompt | null;
  isLoading: boolean;
}

interface ConfigActions {
  loadTemplates: () => Promise<void>;
  loadQuestions: () => Promise<void>;
  loadEvalPrompts: () => Promise<void>;
  loadAll: () => Promise<void>;

  setEditingTemplate: (t: SessionTemplate | null) => void;
  createTemplate: () => void;
  saveTemplate: (t: SessionTemplate) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  restoreTemplate: (id: string) => Promise<void>;
  duplicateTemplate: (id: string) => Promise<void>;

  setEditingQuestion: (q: QuestionBankItem | null) => void;
  saveQuestion: (q: QuestionBankItem) => Promise<void>;
  deleteQuestion: (id: string) => Promise<void>;

  setEditingEvalPrompt: (p: EvalPrompt | null) => void;
  saveEvalPrompt: (p: EvalPrompt) => Promise<void>;
  deleteEvalPrompt: (id: string) => Promise<void>;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useConfigStore = create<ConfigState & ConfigActions>()(
  (set, get) => ({
    templates: [],
    questions: [],
    evalPrompts: [],
    editingTemplate: null,
    editingQuestion: null,
    editingEvalPrompt: null,
    isLoading: false,

    // ── Loaders ──────────────────────────────────────────────────────────────

    loadTemplates: async () => {
      // Load all templates then filter active ones in JS — Dexie's null index
      // query is unreliable across versions; filtering in JS is safer.
      const all = await db.sessionTemplates.toArray();
      const active = all
        .filter((t) => !t.deletedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      set({ templates: active });
    },

    loadQuestions: async () => {
      const questions = await db.questionBank.toArray();
      set({ questions });
    },

    loadEvalPrompts: async () => {
      const evalPrompts = await db.evalPrompts.toArray();
      set({ evalPrompts });
    },

    loadAll: async () => {
      set({ isLoading: true });
      await Promise.all([
        get().loadTemplates(),
        get().loadQuestions(),
        get().loadEvalPrompts(),
      ]);
      set({ isLoading: false });
    },

    // ── Template CRUD ─────────────────────────────────────────────────────────

    setEditingTemplate: (t) => set({ editingTemplate: t }),

    createTemplate: () => {
      const now = new Date().toISOString();
      set({
        editingTemplate: {
          id: uuidv4(),
          name: 'New Template',
          blocks: [],
          createdAt: now,
          updatedAt: now,
        },
      });
    },

    saveTemplate: async (template) => {
      const updated: SessionTemplate = {
        ...template,
        updatedAt: new Date().toISOString(),
      };
      await db.sessionTemplates.put(updated);

      const { templates } = get();
      const idx = templates.findIndex((t) => t.id === updated.id);
      const next =
        idx >= 0
          ? templates.map((t) => (t.id === updated.id ? updated : t))
          : [updated, ...templates];

      set({ templates: next.filter((t) => !t.deletedAt), editingTemplate: null });
    },

    deleteTemplate: async (id) => {
      const now = new Date().toISOString();
      await db.sessionTemplates.update(id, { deletedAt: now });
      set({
        templates: get().templates.filter((t) => t.id !== id),
        editingTemplate: get().editingTemplate?.id === id ? null : get().editingTemplate,
      });
    },

    restoreTemplate: async (id) => {
      await db.sessionTemplates.update(id, { deletedAt: undefined });
      await get().loadTemplates();
    },

    duplicateTemplate: async (id) => {
      const original = await db.sessionTemplates.get(id);
      if (!original) return;
      const now = new Date().toISOString();
      const dupe: SessionTemplate = {
        ...original,
        id: uuidv4(),
        name: `${original.name} (Copy)`,
        blocks: original.blocks.map((b) => ({ ...b, id: uuidv4() })),
        createdAt: now,
        updatedAt: now,
        deletedAt: undefined,
      };
      await db.sessionTemplates.put(dupe);
      set({ templates: [dupe, ...get().templates] });
    },

    // ── Question CRUD ─────────────────────────────────────────────────────────

    setEditingQuestion: (q) => set({ editingQuestion: q }),

    saveQuestion: async (question) => {
      await db.questionBank.put(question);
      const { questions } = get();
      const idx = questions.findIndex((q) => q.id === question.id);
      const next =
        idx >= 0
          ? questions.map((q) => (q.id === question.id ? question : q))
          : [question, ...questions];
      set({ questions: next, editingQuestion: null });
    },

    deleteQuestion: async (id) => {
      await db.questionBank.delete(id);
      set({
        questions: get().questions.filter((q) => q.id !== id),
        editingQuestion: get().editingQuestion?.id === id ? null : get().editingQuestion,
      });
    },

    // ── Eval Prompt CRUD ──────────────────────────────────────────────────────

    setEditingEvalPrompt: (p) => set({ editingEvalPrompt: p }),

    saveEvalPrompt: async (prompt) => {
      await db.evalPrompts.put(prompt);
      const { evalPrompts } = get();
      const idx = evalPrompts.findIndex((p) => p.id === prompt.id);
      const next =
        idx >= 0
          ? evalPrompts.map((p) => (p.id === prompt.id ? prompt : p))
          : [prompt, ...evalPrompts];
      set({ evalPrompts: next, editingEvalPrompt: null });
    },

    deleteEvalPrompt: async (id) => {
      await db.evalPrompts.delete(id);
      set({
        evalPrompts: get().evalPrompts.filter((p) => p.id !== id),
        editingEvalPrompt: get().editingEvalPrompt?.id === id ? null : get().editingEvalPrompt,
      });
    },
  })
);
