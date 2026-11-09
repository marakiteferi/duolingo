/**
 * types/index.ts — Central type definitions for the DET Prep App.
 *
 * Every interface and union type used across the application lives here.
 * No runtime code — purely compile-time type information.
 */

// ---------------------------------------------------------------------------
// Enums & union literals
// ---------------------------------------------------------------------------

/** The four scored skill dimensions on the Duolingo English Test. */
export type DETSkill = 'reading' | 'writing' | 'speaking' | 'listening';

/**
 * Supported DET question formats.
 * Each maps to a distinct interaction pattern in the exam runner.
 */
export type DETQuestionType =
  | 'read-aloud'
  | 'write-about-photo'
  | 'listen-and-type'
  | 'interactive-writing'
  | 'interactive-speaking'
  | 'speaking-sample';

/**
 * Block types determine the UI and timing behaviour of each practice block.
 * - brain-dump:     free-form writing warm-up
 * - vocab-writing:  SRS-driven vocabulary practice
 * - speaking:       mic-recorded spoken responses
 * - mock-test:      timed DET-style question set
 * - custom:         user-defined freeform block
 */
export type BlockType =
  | 'brain-dump'
  | 'vocab-writing'
  | 'speaking'
  | 'mock-test'
  | 'custom';

/** Speech-to-text provider used for transcription. */
export type STTProvider = 'whisper' | 'web-speech-api';

/** Top-level view switch — no React Router needed, just a Zustand value. */
export type ViewMode = 'config' | 'exam';

/** Alias used in the app store. */
export type AppView = ViewMode;

/** Alias used in the app store. */
export type AppView = ViewMode;

/** Lifecycle status of a practice session run. */
export type SessionStatus = 'in-progress' | 'completed' | 'abandoned';

/** Grading scale used by an evaluation prompt. */
export type ScoreScale = 'det-0-160' | 'custom';

/** Navigation sections within the config/admin view. */
export type ConfigSection = 'templates' | 'questions' | 'eval-prompts' | 'settings';

// ---------------------------------------------------------------------------
// SRS (SM-2 spaced repetition) data
// ---------------------------------------------------------------------------

/** SM-2 algorithm state attached to each vocabulary / question bank item. */
export interface SRSData {
  /** Easiness factor — starts at 2.5, minimum 1.3 */
  easeFactor: number;
  /** Days until the next scheduled review */
  intervalDays: number;
  /** Total successful consecutive repetitions */
  repetitions: number;
  /** ISO-8601 date string for the next review */
  nextReviewDate: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Default values used when creating new SRS entries. */
export interface SRSDefaults {
  startEase: number;         // typically 2.5
  startIntervalDays: number; // typically 1
}

/**
 * App-wide settings, stored as a singleton row in IndexedDB.
 * API keys live here rather than in .env so users can change them at runtime.
 */
export interface Settings {
  /** Fixed key — always 'app-settings' for the singleton pattern. */
  id: 'app-settings';
  /** Gemini API key for AI evaluation / feedback. */
  geminiApiKey: string;
  /** Which STT provider to use for transcription. */
  sttProvider: STTProvider;
  /** Optional third-party STT API key (e.g. OpenAI Whisper). */
  sttApiKey?: string;
  /** Whether blocks auto-advance to the next when the timer expires. */
  autoAdvanceDefault: boolean;
  /** Default SM-2 parameters for newly created vocabulary items. */
  srsDefaults: SRSDefaults;
}

// ---------------------------------------------------------------------------
// Question Bank
// ---------------------------------------------------------------------------

/**
 * A single item in the question bank — can be a DET-style question or
 * a vocabulary/writing prompt used across blocks.
 */
export interface QuestionBankItem {
  /** UUID v4 primary key. */
  id: string;
  /** Which DET skill dimension this question targets. */
  skill: DETSkill;
  /** The specific question format. */
  type: DETQuestionType;
  /** The question text or instruction shown to the student. */
  prompt: string;
  /** Optional model answer used for self-check or AI comparison. */
  sampleAnswer?: string;
  /** 1–5 difficulty rating (1 = easy, 5 = hardest) OR 'easy'|'mid'|'hard' label. */
  difficulty: number | 'easy' | 'mid' | 'hard';
  /** Freeform tags for filtering / categorisation. */
  tags: string[];
  /** SM-2 spaced-repetition state (undefined until the item is first reviewed). */
  srs?: SRSData;
}

// ---------------------------------------------------------------------------
// Evaluation Prompts
// ---------------------------------------------------------------------------

/**
 * A reusable prompt template sent to Gemini for AI-powered scoring.
 * Each prompt targets a specific block type and defines the grading rubric.
 */
export interface EvalPrompt {
  /** UUID v4 primary key. */
  id: string;
  /** Human-readable name for the prompt. */
  name: string;
  /** Which block type this evaluation prompt applies to. */
  appliesToType: BlockType;
  /** The full system/user prompt text sent to Gemini. */
  promptText: string;
  /** Scoring scale — DET official or a custom rubric. */
  scoreScale: ScoreScale;
}

// ---------------------------------------------------------------------------
// Blocks & Session Templates
// ---------------------------------------------------------------------------

/**
 * A single timed activity block within a session template.
 * Blocks are stored inline (embedded) inside SessionTemplate.blocks[].
 */
export interface Block {
  /** UUID v4 — unique per block instance. */
  id: string;
  /** Display name (e.g. "Brain Dump Warm-Up"). */
  name: string;
  /** Determines the UI, timer behaviour, and input mode. */
  type: BlockType;
  /** Duration in seconds for this block's countdown timer. */
  durationSec: number;
  /** Instructions shown to the user at the start of the block. */
  instructions: string;
  /** Optional reference to a question set for mock-test / vocab blocks. */
  questionSetId?: string;
  /** Whether to automatically advance to the next block when time expires. */
  autoAdvance: boolean;
  /** Reference to the EvalPrompt used for AI scoring of this block. */
  evalPromptId: string;
}

/**
 * BlockConfig is an alias for Block — the session store uses this name internally.
 * Both refer to the same shape.
 */
export type BlockConfig = Block;

/**
 * A session template defines the ordered sequence of blocks for a practice run.
 * Soft-deleted via `deletedAt` — never truly removed from IndexedDB.
 */
export interface SessionTemplate {
  /** UUID v4 primary key. */
  id: string;
  /** User-facing template name. */
  name: string;
  /** Optional description shown in the template picker. */
  description?: string;
  /** Ordered list of blocks executed in sequence. */
  blocks: Block[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-modified timestamp. */
  updatedAt: string;
  /** ISO-8601 soft-delete timestamp. Null or undefined means active. */
  deletedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Session Runs
// ---------------------------------------------------------------------------

/**
 * Structured AI feedback returned by Gemini after evaluating a response.
 * This shape is enforced in the eval prompt so Gemini returns valid JSON.
 */
export interface AIFeedback {
  /** Numeric sub-scores per evaluated dimension (e.g. grammar: 130). */
  subscores: Record<string, number>;
  /** Detailed criteria assessments keyed by rubric dimension. */
  criteria: Record<string, string>;
  /** List of things the student did well. */
  strengths: string[];
  /** List of areas that need improvement. */
  weaknesses: string[];
  /** Actionable suggestions for the student. */
  suggestions: string[];
  /** Optional free-text note from the AI evaluator. */
  note?: string;
}

/**
 * A single response captured during a session run — one per block.
 * Audio responses store a blob reference for later playback / re-evaluation.
 */
export interface BlockResponse {
  /** The block ID this response corresponds to. */
  blockId: string;
  /** The block type (denormalized for quick access without template lookup). */
  type?: BlockType;
  /** The DET question type (from the question that was shown). */
  questionType?: string;
  /** Written text or speech-to-text transcript. */
  textOrTranscript?: string;
  /** IndexedDB key or object URL referencing the recorded audio blob. */
  audioBlobRef?: string;
  /** Whether the user has explicitly finished this block. */
  isComplete: boolean;
  /** Seconds the user spent on this block. */
  timeSpentSec: number;
  /** AI-assigned sub-scores (e.g. per skill dimension). */
  aiSubscores?: Record<string, number>;
  /** AI-assigned overall score for this block. */
  aiOverallScore?: number;
  /** Full structured AI feedback. */
  aiFeedback?: AIFeedback;
}

/**
 * Aggregated summary of an entire session run.
 * Computed after all blocks are complete and (optionally) AI-evaluated.
 */
export interface SessionSummary {
  /** Composite score across all blocks (optional until AI eval completes). */
  overallScore?: number;
  /** Breakdown by DET skill dimension. */
  perSkillScores?: Partial<Record<DETSkill, number>>;
  /** Total wall-clock duration of the session in seconds. */
  durationSec: number;
}

/**
 * A single practice session run — the core record of a student's attempt.
 *
 * Uses `blockConfigs` (a denormalized snapshot of blocks) so historical
 * runs remain accurate even if the template is later edited or deleted.
 */
export interface SessionRun {
  /** UUID v4 primary key. */
  id: string;
  /** Reference to the originating template (may be soft-deleted). */
  templateId: string;
  /** Denormalized template name, so deleted templates still display correctly. */
  templateName: string;
  /** Frozen snapshot of blocks at run-start (denormalized, not a foreign key). */
  blockConfigs: BlockConfig[];
  /** Current lifecycle status. */
  status: SessionStatus;
  /** Zero-based index of the block the student is currently on. */
  currentBlockIndex: number;
  /** Total seconds elapsed across the whole session. */
  overallElapsedSec: number;
  /** ISO-8601 timestamp when the session was started. */
  startedAt: string;
  /** ISO-8601 timestamp when the session ended (null while in-progress). */
  endedAt: string | null;
  /** Responses keyed by blockId — one entry per block. */
  responses: Record<string, BlockResponse>;
}
