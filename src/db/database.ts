import Dexie, { type Table } from 'dexie';
import type {
  Settings,
  QuestionBankItem,
  EvalPrompt,
  SessionTemplate,
  SessionRun,
} from '../types';

const DEFAULT_WRITING_PROMPT = `You are an expert Duolingo English Test (DET) evaluator. Grade the provided response against the official DET rubric, strictly calibrating for a target score band of 140-150 (graduate-level proficiency).
Focus heavily on grammatical complexity, precise lexical diversity, and cohesive transitions.

Task / Prompt:
{{prompt}}

Student Response (Time spent: {{durationSec}}s):
{{response}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "grammar": "<assessment>", "vocabulary": "<assessment>", "coherence": "<assessment>" },
  "strengths": ["<strength 1>", "<strength 2>"],
  "weaknesses": ["<weakness 1>", "<weakness 2>"],
  "suggestions": ["<actionable fix 1>", "<actionable fix 2>"],
  "suggestedFix": "<A 145-155 band rewrite of the student's weakest sentences>"
}`;

const DEFAULT_SPEAKING_PROMPT = `You are an expert Duolingo English Test (DET) speaking evaluator. Grade the provided verbatim speech transcript against the official DET rubric, strictly calibrating for a target score band of 140-150 (graduate-level proficiency).
IMPORTANT: The transcript is verbatim and includes filler words ("uh", "um", "like"), stutters, and pauses. Penalize hesitation, filler density, and lack of acoustic fluency based on the speaking duration ({{durationSec}}s).

Speaking Task / Prompt:
{{prompt}}

Verbatim Student Transcript:
{{transcript}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "fluency": "<assessment of pace & fillers>", "lexical_diversity": "<assessment>", "grammar": "<assessment>" },
  "strengths": ["<strength 1>", "<strength 2>"],
  "weaknesses": ["<weakness 1>", "<weakness 2>"],
  "suggestions": ["<specific fluency/lexical tip 1>", "<tip 2>"],
  "suggestedFix": "<A polished, natural 150-score spoken version of the student's response>"
}`;

export class DETDatabase extends Dexie {
  settings!: Table<Settings, string>;
  questionBank!: Table<QuestionBankItem, string>;
  evalPrompts!: Table<EvalPrompt, string>;
  sessionTemplates!: Table<SessionTemplate, string>;
  sessionRuns!: Table<SessionRun, string>;

  constructor() {
    super('det-prep-app');

    this.version(1).stores({
      settings: 'id',
      questionBank: 'id, skill, type, difficulty, srs.nextReviewDate',
      evalPrompts: 'id, appliesToType',
      sessionTemplates: 'id, deletedAt',
      sessionRuns: 'id, templateId, status, startedAt',
    });

    this.on('populate', () => this.populateDefaults());
  }

  async populateDefaults(): Promise<void> {
    const now = new Date().toISOString();

    await this.settings.put({
      id: 'app-settings',
      geminiApiKey: '',
      sttProvider: 'local-whisper',
      localWhisperUrl: 'http://127.0.0.1:8000/transcribe',
      autoAdvanceDefault: true,
      instantFeedbackDefault: false,
      srsDefaults: {
        startEase: 2.5,
        startIntervalDays: 1,
      },
    });

    const brainDumpEvalId = crypto.randomUUID();
    const vocabEvalId = crypto.randomUUID();
    const speakingEvalId = crypto.randomUUID();
    const mockEvalId = crypto.randomUUID();

    await this.evalPrompts.bulkPut([
      {
        id: brainDumpEvalId,
        name: 'DET Brain-Dump & Outline Evaluator (140-150)',
        appliesToType: 'brain-dump',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_WRITING_PROMPT,
      },
      {
        id: vocabEvalId,
        name: 'DET Vocab & Precision Writing Evaluator (140-150)',
        appliesToType: 'vocab-writing',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_WRITING_PROMPT,
      },
      {
        id: speakingEvalId,
        name: 'DET Verbatim Speaking Evaluator (140-150)',
        appliesToType: 'speaking',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_SPEAKING_PROMPT,
      },
      {
        id: mockEvalId,
        name: 'DET Mock Test Evaluator (140-150)',
        appliesToType: 'mock-test',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_WRITING_PROMPT,
      },
    ]);

    await this.questionBank.bulkPut([
      {
        id: crypto.randomUUID(),
        skill: 'writing',
        type: 'interactive-writing',
        prompt: 'Outline your thoughts on the impact of artificial intelligence on traditional university education systems. Focus on structural arguments and counter-arguments.',
        sampleAnswer: 'While AI democratizes personalized tutoring and accelerates literature synthesis, over-reliance risks eroding foundational critical thinking unless assessments evolve toward oral and applied defense.',
        difficulty: 'hard',
        tags: ['writing-to-speaking', 'ai', 'education'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'writing',
        type: 'write-about-photo',
        prompt: 'Write a 60-word academic paragraph about scientific research using the words: empirical, methodology, ubiquitous, paradigm.',
        sampleAnswer: 'In modern computer science, the ubiquitous adoption of machine learning has shifted the research paradigm, requiring rigorous empirical validation and transparent methodology to ensure reproducibility.',
        difficulty: 'hard',
        tags: ['vocab', 'academic', 'graduate'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'speaking-sample',
        prompt: 'Speak for 90 seconds expanding on the outline you created about artificial intelligence in higher education. Maintain smooth transitions and minimize filler words.',
        sampleAnswer: undefined,
        difficulty: 'hard',
        tags: ['writing-to-speaking', 'academic', 'fluency'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'reading',
        type: 'read-aloud',
        prompt: 'Read aloud with natural academic prosody: "Cryptographic hash chaining ensures immutable document provenance across distributed administrative workflows."',
        sampleAnswer: undefined,
        difficulty: 'mid',
        tags: ['pronunciation', 'systems'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'interactive-speaking',
        prompt: 'Describe a complex technical project you architected from scratch. How did you verify its reliability and handle edge-case failures? Speak for 90 seconds.',
        sampleAnswer: undefined,
        difficulty: 'hard',
        tags: ['engineering', 'personal-experience'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'listening',
        type: 'listen-and-type',
        prompt: 'Synthesize and type the core thesis: Empirical studies indicate that spaced repetition combined with active production accelerates second-language lexical retrieval.',
        sampleAnswer: 'Empirical studies indicate that spaced repetition combined with active production accelerates second-language lexical retrieval.',
        difficulty: 'mid',
        tags: ['cognitive-science', 'starter'],
      },
    ]);

    await this.sessionTemplates.put({
      id: crypto.randomUUID(),
      name: 'Writing-to-Speaking Flow (140-150 Target)',
      description: 'Structured 3-step cognitive transfer: Brain-Dump Outline -> Precision Vocab Writing -> Verbatim Speaking + Mock Drill.',
      blocks: [
        {
          id: crypto.randomUUID(),
          name: '1. Brain-Dump & Structural Outline',
          type: 'brain-dump',
          durationSec: 3 * 60,
          instructions: 'Outline your thesis, 2 core arguments, and high-level transitions on the impact of AI on education systems.',
          autoAdvance: true,
          evalPromptId: brainDumpEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: '2. Active Academic Vocab Writing',
          type: 'vocab-writing',
          durationSec: 5 * 60,
          instructions: 'Write a dense academic paragraph incorporating the due SRS vocabulary items: empirical, methodology, ubiquitous, paradigm.',
          autoAdvance: true,
          evalPromptId: vocabEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: '3. Verbatim Speaking Expansion',
          type: 'speaking',
          durationSec: 2 * 60,
          instructions: 'Speak for 90 seconds expanding on your written outline without reading word-for-word. Focus on eliminating "uh" and "um" hesitations.',
          autoAdvance: false,
          evalPromptId: speakingEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: '4. Timed Adaptive Mock Test',
          type: 'mock-test',
          durationSec: 8 * 60,
          instructions: 'Complete the adaptive DET prompt under strict exam pressure.',
          autoAdvance: true,
          evalPromptId: mockEvalId,
        },
      ],
      createdAt: now,
      updatedAt: now,
      deletedAt: undefined,
    });
  }
}

export const db = new DETDatabase();

/**
 * Ensures existing IndexedDB installations are seamlessly upgraded so
 * local-whisper is enabled and any old eval prompts missing {{response}} are repaired.
 */
export async function ensureDatabaseUpgraded(): Promise<void> {
  const settings = await db.settings.get('app-settings');
  if (settings && (!settings.localWhisperUrl || settings.sttProvider === 'whisper')) {
    await db.settings.put({
      ...settings,
      sttProvider: settings.sttApiKey ? settings.sttProvider : 'local-whisper',
      localWhisperUrl: settings.localWhisperUrl || 'http://127.0.0.1:8000/transcribe',
    });
  }

  const prompts = await db.evalPrompts.toArray();
  for (const ep of prompts) {
    if (!ep.promptText.includes('{{response}}') && !ep.promptText.includes('{{transcript}}')) {
      await db.evalPrompts.put({
        ...ep,
        promptText: ep.appliesToType === 'speaking' ? DEFAULT_SPEAKING_PROMPT : DEFAULT_WRITING_PROMPT,
      });
    }
  }

  const hasVocabPrompt = prompts.some((p) => p.appliesToType === 'vocab-writing');
  if (!hasVocabPrompt) {
    await db.evalPrompts.put({
      id: crypto.randomUUID(),
      name: 'DET Vocab & Writing Evaluator (140-150)',
      appliesToType: 'vocab-writing',
      scoreScale: 'det-0-160',
      promptText: DEFAULT_WRITING_PROMPT,
    });
  }

  const hasMockPrompt = prompts.some((p) => p.appliesToType === 'mock-test');
  if (!hasMockPrompt) {
    await db.evalPrompts.put({
      id: crypto.randomUUID(),
      name: 'DET Mock Test Evaluator (140-150)',
      appliesToType: 'mock-test',
      scoreScale: 'det-0-160',
      promptText: DEFAULT_WRITING_PROMPT,
    });
  }
}
