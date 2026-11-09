/**
 * db/database.ts — Dexie v4 database definition for the DET Prep App.
 *
 * Defines all IndexedDB tables, their indexes, and the first-run seed data.
 * Uses Dexie's `on('populate')` hook so defaults are inserted exactly once
 * (when the database is created for the first time).
 *
 * Tables:
 *   settings          – singleton row keyed by 'app-settings'
 *   questionBank      – DET-style questions with optional SRS state
 *   evalPrompts       – reusable Gemini prompt templates
 *   sessionTemplates  – ordered block sequences (soft-deletable)
 *   sessionRuns       – denormalized practice attempt records
 */

import Dexie, { type Table } from 'dexie';
import type {
  Settings,
  QuestionBankItem,
  EvalPrompt,
  SessionTemplate,
  SessionRun,
} from '../types';

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class DETDatabase extends Dexie {
  // Typed table accessors — Dexie populates these from the stores definition.
  settings!: Table<Settings, string>;
  questionBank!: Table<QuestionBankItem, string>;
  evalPrompts!: Table<EvalPrompt, string>;
  sessionTemplates!: Table<SessionTemplate, string>;
  sessionRuns!: Table<SessionRun, string>;

  constructor() {
    super('det-prep-app');

    // ----- Version 1 schema ------------------------------------------------
    this.version(1).stores({
      settings: 'id',
      questionBank: 'id, skill, type, difficulty, srs.nextReviewDate',
      evalPrompts: 'id, appliesToType',
      sessionTemplates: 'id, deletedAt',
      sessionRuns: 'id, templateId, status, startedAt',
    });

    // ----- First-run seed --------------------------------------------------
    // `on('populate')` fires only when the DB is brand-new (version 0 → 1).
    this.on('populate', () => this.populateDefaults());
  }

  // -------------------------------------------------------------------------
  // Seed data
  // -------------------------------------------------------------------------

  /**
   * Seeds the database with starter content on first run.
   * Called from the `on('populate')` hook — runs inside a versionchange
   * transaction, so all puts share the same atomic commit.
   */
  async populateDefaults(): Promise<void> {
    const now = new Date().toISOString();

    // --- 1. Default settings -----------------------------------------------
    await this.settings.put({
      id: 'app-settings',
      geminiApiKey: '',
      sttProvider: 'whisper',
      sttApiKey: undefined,
      autoAdvanceDefault: true,
      srsDefaults: {
        startEase: 2.5,
        startIntervalDays: 1,
      },
    });

    // --- 2. Starter eval prompts -------------------------------------------
    const writingEvalId = crypto.randomUUID();
    const speakingEvalId = crypto.randomUUID();

    await this.evalPrompts.bulkPut([
      {
        id: writingEvalId,
        name: 'DET Writing Evaluator',
        appliesToType: 'brain-dump',
        scoreScale: 'det-0-160',
        promptText: [
          'You are an expert DET (Duolingo English Test) writing evaluator.',
          'Score the following student response on a scale of 0-160.',
          '',
          'Evaluate across these criteria:',
          '- Grammar & Mechanics (accuracy of grammar, spelling, punctuation)',
          '- Vocabulary Range (variety and precision of word choice)',
          '- Coherence & Organization (logical flow, paragraph structure)',
          '- Content & Development (depth of ideas, supporting details)',
          '',
          'Return your evaluation as JSON in this exact format:',
          '{',
          '  "subscores": { "grammar": <0-160>, "vocabulary": <0-160>, "coherence": <0-160>, "content": <0-160> },',
          '  "criteria": { "grammar": "<brief assessment>", "vocabulary": "<brief assessment>", "coherence": "<brief assessment>", "content": "<brief assessment>" },',
          '  "strengths": ["<strength 1>", "<strength 2>"],',
          '  "weaknesses": ["<weakness 1>", "<weakness 2>"],',
          '  "suggestions": ["<suggestion 1>", "<suggestion 2>"],',
          '  "note": "<optional overall comment>"',
          '}',
        ].join('\n'),
      },
      {
        id: speakingEvalId,
        name: 'DET Speaking Evaluator',
        appliesToType: 'speaking',
        scoreScale: 'det-0-160',
        promptText: [
          'You are an expert DET (Duolingo English Test) speaking evaluator.',
          'Score the following student transcript on a scale of 0-160.',
          '',
          'Evaluate across these criteria:',
          '- Fluency & Coherence (smooth delivery, logical connection of ideas)',
          '- Pronunciation & Intonation (clarity, natural stress patterns)',
          '- Vocabulary & Grammar (range and accuracy in spoken context)',
          '- Content & Relevance (task completion, depth of response)',
          '',
          'Return your evaluation as JSON in this exact format:',
          '{',
          '  "subscores": { "fluency": <0-160>, "pronunciation": <0-160>, "vocabulary_grammar": <0-160>, "content": <0-160> },',
          '  "criteria": { "fluency": "<brief assessment>", "pronunciation": "<brief assessment>", "vocabulary_grammar": "<brief assessment>", "content": "<brief assessment>" },',
          '  "strengths": ["<strength 1>", "<strength 2>"],',
          '  "weaknesses": ["<weakness 1>", "<weakness 2>"],',
          '  "suggestions": ["<suggestion 1>", "<suggestion 2>"],',
          '  "note": "<optional overall comment>"',
          '}',
        ].join('\n'),
      },
    ]);

    // --- 3. Starter question bank items ------------------------------------
    // Six items covering a spread of DET question types and skills.
    await this.questionBank.bulkPut([
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'read-aloud',
        prompt:
          'Read the following sentence aloud: "The university announced that all undergraduate students must complete a community service requirement before graduation."',
        sampleAnswer: undefined,
        difficulty: 2,
        tags: ['starter', 'academic'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'writing',
        type: 'write-about-photo',
        prompt:
          'Describe the photo in at least 50 words. Focus on what you see, what might be happening, and why it matters.',
        sampleAnswer:
          'The photo shows a bustling outdoor market with colourful stalls selling fresh produce. Shoppers browse the aisles while vendors arrange their displays. The scene suggests a vibrant community that values locally sourced food.',
        difficulty: 3,
        tags: ['starter', 'descriptive'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'listening',
        type: 'listen-and-type',
        prompt:
          'Listen to the audio clip and type exactly what you hear.',
        sampleAnswer:
          'Scientific research has shown that regular exercise can significantly improve cognitive function in adults over the age of fifty.',
        difficulty: 3,
        tags: ['starter', 'academic'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'writing',
        type: 'interactive-writing',
        prompt:
          'Some people believe that technology has made our lives easier, while others argue it has made us more dependent. Write a response discussing both perspectives and share your own opinion. (Minimum 100 words)',
        sampleAnswer: undefined,
        difficulty: 4,
        tags: ['starter', 'opinion', 'technology'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'interactive-speaking',
        prompt:
          'Talk about a time when you had to learn something new quickly. What was the situation, how did you approach it, and what did you learn from the experience? Speak for at least 60 seconds.',
        sampleAnswer: undefined,
        difficulty: 3,
        tags: ['starter', 'personal-experience'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'speaking-sample',
        prompt:
          'Do you think it is better to live in a big city or a small town? Explain your preference and give specific reasons. Speak for 90 seconds.',
        sampleAnswer: undefined,
        difficulty: 3,
        tags: ['starter', 'opinion'],
      },
    ]);

    // --- 4. Default "Full Practice" session template -----------------------
    await this.sessionTemplates.put({
      id: crypto.randomUUID(),
      name: 'Full Practice',
      blocks: [
        {
          id: crypto.randomUUID(),
          name: 'Brain Dump Warm-Up',
          type: 'brain-dump',
          durationSec: 5 * 60, // 5 minutes
          instructions:
            'Free-write about any topic for 5 minutes. Focus on getting your thoughts flowing in English — don\'t worry about perfection.',
          autoAdvance: true,
          evalPromptId: writingEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: 'Vocabulary Writing',
          type: 'vocab-writing',
          durationSec: 10 * 60, // 10 minutes
          instructions:
            'Practice writing with vocabulary words. Use each word in a complete sentence that demonstrates its meaning.',
          autoAdvance: true,
          evalPromptId: writingEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: 'Speaking Practice',
          type: 'speaking',
          durationSec: 5 * 60, // 5 minutes
          instructions:
            'Record yourself speaking on the given topic. Aim for clear pronunciation, natural pacing, and well-organized ideas.',
          autoAdvance: true,
          evalPromptId: speakingEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: 'Mock Test',
          type: 'mock-test',
          durationSec: 15 * 60, // 15 minutes
          instructions:
            'Complete a timed set of DET-style questions. Simulate real test conditions — no pausing or looking things up.',
          autoAdvance: true,
          evalPromptId: writingEvalId,
        },
      ],
      createdAt: now,
      updatedAt: now,
      deletedAt: undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/**
 * The single database instance used throughout the app.
 * Import this wherever you need to read/write IndexedDB.
 *
 * @example
 * ```ts
 * import { db } from '@/db';
 * const settings = await db.settings.get('app-settings');
 * ```
 */
export const db = new DETDatabase();
