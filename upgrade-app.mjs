// upgrade-app.mjs
// Run from project root: node upgrade-app.mjs
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. PYTHON BACKEND: Add /health endpoint & safe cleanup
  // =========================================================================
  'stt-backend/app.py': `from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import shutil
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading model...")
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8_float16")
print("Model loaded successfully!")

@app.get("/health")
async def health_check():
    return {"status": "ok", "model": "large-v3-turbo", "device": "cuda"}

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    temp_file = f"temp_{file.filename}"
    try:
        with open(temp_file, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        segments, info = model.transcribe(
            temp_file, 
            beam_size=5,
            condition_on_previous_text=False,
            initial_prompt="Uh, um, like, so yeah, well, [cough], [silent]..."
        )
        
        text_output = " ".join([segment.text for segment in segments])
        return {"text": text_output.strip(), "duration": info.duration}
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
`,

  // =========================================================================
  // 2. TYPES: Add local-whisper, instantFeedback, question filters, history
  // =========================================================================
  'src/types/index.ts': `export type DETSkill = 'reading' | 'writing' | 'speaking' | 'listening';

export type DETQuestionType =
  | 'read-aloud'
  | 'write-about-photo'
  | 'listen-and-type'
  | 'interactive-writing'
  | 'interactive-speaking'
  | 'speaking-sample';

export type BlockType =
  | 'brain-dump'
  | 'vocab-writing'
  | 'speaking'
  | 'mock-test'
  | 'custom';

export type STTProvider = 'local-whisper' | 'whisper' | 'web-speech-api';

export type ViewMode = 'config' | 'exam';
export type AppView = ViewMode;

export type SessionStatus = 'in-progress' | 'completed' | 'abandoned';
export type ScoreScale = 'det-0-160' | 'custom';
export type ConfigSection = 'templates' | 'questions' | 'eval-prompts' | 'history' | 'settings';

export interface SRSData {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  nextReviewDate: string;
}

export interface SRSDefaults {
  startEase: number;
  startIntervalDays: number;
}

export interface Settings {
  id: 'app-settings';
  geminiApiKey: string;
  sttProvider: STTProvider;
  localWhisperUrl?: string;
  sttApiKey?: string;
  autoAdvanceDefault: boolean;
  instantFeedbackDefault?: boolean;
  srsDefaults: SRSDefaults;
}

export interface QuestionBankItem {
  id: string;
  skill: DETSkill;
  type: DETQuestionType;
  prompt: string;
  sampleAnswer?: string;
  difficulty: number | 'easy' | 'mid' | 'hard';
  tags: string[];
  srs?: SRSData;
}

export interface EvalPrompt {
  id: string;
  name: string;
  appliesToType: BlockType;
  promptText: string;
  scoreScale: ScoreScale;
}

export interface Block {
  id: string;
  name: string;
  type: BlockType;
  durationSec: number;
  instructions: string;
  questionSetId?: string;
  preferredQuestionType?: DETQuestionType | 'adaptive';
  autoAdvance: boolean;
  evalPromptId: string;
}

export type BlockConfig = Block;

export interface SessionTemplate {
  id: string;
  name: string;
  description?: string;
  blocks: Block[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface AIFeedback {
  overallScore?: number;
  subscores: Record<string, number>;
  criteria: Record<string, string>;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  suggestedFix?: string;
  note?: string;
}

export interface BlockResponse {
  blockId: string;
  type?: BlockType;
  questionType?: string;
  questionId?: string;
  promptSnapshot?: string;
  textOrTranscript?: string;
  audioBlobRef?: string;
  isComplete: boolean;
  timeSpentSec: number;
  fillerCount?: number;
  wpm?: number;
  aiSubscores?: Record<string, number>;
  aiOverallScore?: number;
  aiFeedback?: AIFeedback;
  evalPendingOffline?: boolean;
}

export interface SessionSummary {
  overallScore?: number;
  perSkillScores?: Partial<Record<DETSkill, number>>;
  durationSec: number;
}

export interface SessionRun {
  id: string;
  templateId: string | null;
  templateName: string;
  blockConfigs: BlockConfig[];
  status: SessionStatus;
  currentBlockIndex: number;
  overallElapsedSec: number;
  instantFeedback?: boolean;
  preferredQuestionType?: DETQuestionType | 'all' | 'adaptive';
  startedAt: string;
  endedAt: string | null;
  responses: Record<string, BlockResponse>;
  summary?: SessionSummary;
}
`,

  // =========================================================================
  // 3. DATABASE: Seed 140-150 rubric prompts with {{variables}} & auto-repair
  // =========================================================================
  'src/db/database.ts': `import Dexie, { type Table } from 'dexie';
import type {
  Settings,
  QuestionBankItem,
  EvalPrompt,
  SessionTemplate,
  SessionRun,
} from '../types';

const DEFAULT_WRITING_PROMPT = \`You are an expert Duolingo English Test (DET) evaluator. Grade the provided response against the official DET rubric, strictly calibrating for a target score band of 140-150 (graduate-level proficiency).
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
}\`;

const DEFAULT_SPEAKING_PROMPT = \`You are an expert Duolingo English Test (DET) speaking evaluator. Grade the provided verbatim speech transcript against the official DET rubric, strictly calibrating for a target score band of 140-150 (graduate-level proficiency).
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
}\`;

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
`,

  // =========================================================================
  // 4. STT SERVICE: Local Faster-Whisper GPU + Disfluency Analyzer
  // =========================================================================
  'src/services/stt.ts': `import type { STTProvider as STTProviderType } from '../types';

export interface STTProvider {
  transcribe(audioBlob: Blob, language?: string): Promise<string>;
  isAvailable(): boolean;
}

const LOCAL_WHISPER_DEFAULT_URL = 'http://127.0.0.1:8000/transcribe';
const LOCAL_WHISPER_HEALTH_URL = 'http://127.0.0.1:8000/health';
const OPENAI_WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_BLOB_SIZE_BYTES = 24 * 1024 * 1024;

/**
 * Checks whether the local Python FastAPI faster-whisper server is online.
 */
export async function checkLocalWhisperHealth(
  transcribeUrl: string = LOCAL_WHISPER_DEFAULT_URL
): Promise<boolean> {
  try {
    const baseUrl = transcribeUrl.replace(/\\/transcribe\\/?$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(\`\${baseUrl}/health\`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return true;
    // Even if /health isn't added yet, a 404 from uvicorn means the server is up!
    return res.status === 404;
  } catch {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(LOCAL_WHISPER_HEALTH_URL, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
}

/**
 * Analyzes a verbatim transcript for filler words, hesitations, and WPM.
 */
export function analyzeSpeechTranscript(text: string, durationSec: number): {
  wordCount: number;
  fillerCount: number;
  fillersFound: string[];
  wpm: number;
} {
  const clean = text.trim();
  if (!clean) {
    return { wordCount: 0, fillerCount: 0, fillersFound: [], wpm: 0 };
  }
  const words = clean.split(/\\s+/);
  const wordCount = words.length;
  const fillerRegex = /\\b(uh+|um+|er+|ah+|hmm+|like|you know|basically|literally)\\b|\\[(silent|cough|pause)\\]/gi;
  const matches = clean.match(fillerRegex) ?? [];
  const minutes = Math.max(0.1, durationSec / 60);
  const wpm = Math.round(wordCount / minutes);

  return {
    wordCount,
    fillerCount: matches.length,
    fillersFound: matches.map((m) => m.toLowerCase()),
    wpm,
  };
}

/**
 * Primary Provider: Local Faster-Whisper running on RTX 3050 (http://127.0.0.1:8000/transcribe)
 */
export class LocalWhisperSTTProvider implements STTProvider {
  private readonly endpointUrl: string;

  constructor(endpointUrl: string = LOCAL_WHISPER_DEFAULT_URL) {
    this.endpointUrl = endpointUrl || LOCAL_WHISPER_DEFAULT_URL;
  }

  isAvailable(): boolean {
    return true;
  }

  async transcribe(audioBlob: Blob): Promise<string> {
    const audioFile = new File([audioBlob], 'recording.webm', {
      type: audioBlob.type || 'audio/webm',
    });
    const formData = new FormData();
    formData.append('file', audioFile);

    let response: Response;
    try {
      response = await fetch(this.endpointUrl, {
        method: 'POST',
        body: formData,
      });
    } catch {
      throw new Error(
        'Could not connect to local Whisper server at ' +
          this.endpointUrl +
          '. Make sure your Python terminal (python app.py) is running on port 8000.'
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown server error');
      throw new Error(\`Local Whisper error (\${response.status}): \${errText}\`);
    }

    const data = (await response.json()) as { text?: string };
    if (typeof data.text !== 'string') {
      throw new Error('Local Whisper returned an unexpected JSON payload.');
    }
    return data.text;
  }
}

/**
 * Optional Cloud OpenAI Whisper Provider
 */
export class WhisperSTTProvider implements STTProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async transcribe(audioBlob: Blob, language: string = 'en'): Promise<string> {
    if (audioBlob.size > MAX_BLOB_SIZE_BYTES) {
      throw new Error('Audio exceeds 24 MB limit.');
    }
    const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('file', audioFile);
    formData.append('model', 'whisper-1');
    formData.append('language', language);
    formData.append('prompt', 'Uh, um, like, so yeah, well, [cough], [silent]...');

    const response = await fetch(OPENAI_WHISPER_API_URL, {
      method: 'POST',
      headers: { Authorization: \`Bearer \${this.apiKey}\` },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(\`OpenAI Whisper error (\${response.status})\`);
    }
    const data = (await response.json()) as { text?: string };
    return data.text ?? '';
  }
}

/**
 * Browser Web Speech API Fallback
 */
export class WebSpeechSTTProvider implements STTProvider {
  isAvailable(): boolean {
    return (
      typeof window !== 'undefined' &&
      Boolean((window as unknown as Record<string, unknown>).SpeechRecognition ||
              (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
    );
  }

  async transcribe(_audioBlob: Blob): Promise<string> {
    throw new Error(
      'Web Speech API only works in live-streaming mode. Use Local Whisper (port 8000) to transcribe recorded audio blobs.'
    );
  }
}

export function createSTTProvider(
  provider: STTProviderType,
  options?: { apiKey?: string; localWhisperUrl?: string }
): STTProvider {
  switch (provider) {
    case 'local-whisper':
      return new LocalWhisperSTTProvider(options?.localWhisperUrl);
    case 'whisper':
      if (!options?.apiKey) {
        return new LocalWhisperSTTProvider(options?.localWhisperUrl);
      }
      return new WhisperSTTProvider(options.apiKey);
    case 'web-speech-api':
      return new WebSpeechSTTProvider();
    default:
      return new LocalWhisperSTTProvider(options?.localWhisperUrl);
  }
}
`,

  // =========================================================================
  // 5. GEMINI SERVICE: Fix EvaluationResult export & guarantee context injection
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
const RETRY_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 35_000;

function interpolateTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let output = template.replace(/\\{\\{(\\w+)\\}\\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });

  // Safety guarantee: if the user's template didn't include {{response}} or {{transcript}},
  // append the prompt and student response automatically so Gemini always sees it.
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
    suggestions.unshift(\`145+ Rewrite: \${suggestedFix}\`);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function evaluateResponse(params: EvaluateParams): Promise<AIFeedback> {
  const { apiKey, evalPromptTemplate, variables } = params;

  if (!apiKey) {
    throw new Error('Gemini API key is missing. Add your free Google AI Studio key in Config -> Settings.');
  }

  const prompt = interpolateTemplate(evalPromptTemplate, variables);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callGemini(apiKey, prompt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isNonRetryableError(lastError)) throw lastError;
      if (attempt === 0) await delay(RETRY_DELAY_MS);
    }
  }

  throw new Error(\`Gemini evaluation failed: \${lastError?.message ?? 'Unknown error'}\`);
}

function isNonRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes('api key') || msg.includes('invalid') || msg.includes('permission') || msg.includes('forbidden');
}

async function callGemini(apiKey: string, prompt: string): Promise<AIFeedback> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    clearTimeout(timeoutId);

    const text = result.response.text();
    if (!text) throw new Error('Gemini returned an empty response.');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(\`Failed to parse Gemini JSON: \${text.slice(0, 160)}\`);
    }

    return validateEvaluationResult(parsed);
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }
}
`,

  // =========================================================================
  // 6. SESSION STORE: Support partial blocks, instantFeedback, autoAdvance fix
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

export interface StartSessionOptions {
  selectedBlockIds?: string[];
  customDurations?: Record<string, number>;
  instantFeedback?: boolean;
  preferredQuestionType?: DETQuestionType | 'all' | 'adaptive';
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
    isComplete: false,
    timeSpentSec: 0,
  };
}

function buildResponses(blocks: BlockConfig[]): Record<string, BlockResponse> {
  return Object.fromEntries(blocks.map((b) => [b.id, emptyResponse(b)]));
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
      const filteredBlocks = template.blocks
        .filter((b) =>
          options?.selectedBlockIds ? options.selectedBlockIds.includes(b.id) : true
        )
        .map((b) => ({
          ...b,
          durationSec: options?.customDurations?.[b.id] ?? b.durationSec,
        }));

      const blockConfigs = filteredBlocks.length > 0 ? filteredBlocks : template.blocks.map((b) => ({ ...b }));
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
        instantFeedback: options?.instantFeedback ?? false,
        preferredQuestionType: options?.preferredQuestionType ?? 'adaptive',
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
      const savedBlockTime = activeBlock ? (run.responses[activeBlock.id]?.timeSpentSec ?? 0) : 0;
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

      // If block has already reached duration and autoAdvance is false, wait for user
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

        // Respect autoAdvance=false: stop advancing and let user finish/inspect feedback
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

    pauseSession: () => set({ isPaused: true }),
    resumeRunning: () => set({ isPaused: false }),

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
        lastSavedAt: new Date().toISOString(),
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
  // 7. ADAPTIVE QUESTION & SRS SELECTOR UTILITY (Step 7)
  // =========================================================================
  'src/utils/adaptive.ts': `import { db } from '../db';
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
`,

  // =========================================================================
  // 8. SPEAKING BLOCK: Auto Local Whisper STT, Verbatim Highlight, WPM, Base64
  // =========================================================================
  'src/components/exam/blocks/SpeakingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore, selectBlockTimeRemaining } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript, checkLocalWhisperHealth } from '../../../services/stt';
import { db } from '../../../db/database';
import { getAdaptiveQuestions } from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function SpeakingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const activeRun = useSessionStore((s) => s.activeRun);
  const blockTimeRemaining = useSessionStore(selectBlockTimeRemaining);

  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(new Array(32).fill(0));
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [whisperOnline, setWhisperOnline] = useState<boolean | null>(null);
  const [prompts, setPrompts] = useState<QuestionBankItem[]>([]);
  const [selectedPromptIdx, setSelectedPromptIdx] = useState(0);

  const recorderRef = useRef<AudioRecorderService | null>(null);
  const animFrameRef = useRef<number>(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];
  const transcript = response?.textOrTranscript ?? '';

  // Check local Whisper server status and load speaking prompts
  useEffect(() => {
    checkLocalWhisperHealth().then(setWhisperOnline);
    getAdaptiveQuestions({
      skill: 'speaking',
      questionType: activeRun?.preferredQuestionType ?? 'adaptive',
      limit: 8,
    }).then(({ selected }) => {
      setPrompts(selected);
    });
  }, [activeRun?.preferredQuestionType]);

  const activePromptText =
    response?.promptSnapshot ||
    prompts[selectedPromptIdx]?.prompt ||
    block.instructions ||
    'Speak for 90 seconds expanding on your structured outline. Aim for smooth transitions and minimal hesitations.';

  const animateWaveform = useCallback(() => {
    const recorder = recorderRef.current;
    const analyser = recorder?.getAnalyser();
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    const buckets = 32;
    const step = Math.floor(data.length / buckets);
    const newLevels = Array.from({ length: buckets }, (_, i) =>
      Math.round((data[i * step] / 255) * 100)
    );
    setLevels(newLevels);
    animFrameRef.current = requestAnimationFrame(animateWaveform);
  }, []);

  const transcribeBlob = useCallback(
    async (blob: Blob, durationSec: number) => {
      setRecordingState('transcribing');
      setError(null);
      try {
        const dataUrl = await blobToDataUrl(blob);
        const settings = await db.settings.get('app-settings');
        const stt = createSTTProvider(settings?.sttProvider ?? 'local-whisper', {
          apiKey: settings?.sttApiKey,
          localWhisperUrl: settings?.localWhisperUrl,
        });

        const verbatimText = await stt.transcribe(blob, 'en');
        const stats = analyzeSpeechTranscript(verbatimText, Math.max(5, durationSec));

        updateResponse(block.id, {
          audioBlobRef: dataUrl,
          textOrTranscript: verbatimText || '[No speech detected in recording]',
          promptSnapshot: activePromptText,
          fillerCount: stats.fillerCount,
          wpm: stats.wpm,
        });
        setRecordingState('done');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Transcription failed';
        setError(msg);
        const fallbackUrl = await blobToDataUrl(blob).catch(() => '');
        updateResponse(block.id, {
          audioBlobRef: fallbackUrl,
          promptSnapshot: activePromptText,
          textOrTranscript: transcript || '',
        });
        setRecordingState('done');
      }
    },
    [activePromptText, block.id, transcript, updateResponse]
  );

  const handleStop = useCallback(async () => {
    cancelAnimationFrame(animFrameRef.current);
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    setLevels(new Array(32).fill(0));

    const recorder = recorderRef.current;
    if (!recorder || !recorder.isRecording()) return;

    try {
      const blob = await recorder.stop();
      recorderRef.current = null;
      await transcribeBlob(blob, recordDurationRef.current);
    } catch (e) {
      setError(\`Recording failed: \${e instanceof Error ? e.message : 'Unknown error'}\`);
      setRecordingState('idle');
    }
  }, [transcribeBlob]);

  // Auto-stop recording 1 second before block timer expires so audio is never lost!
  useEffect(() => {
    if (recordingState === 'recording' && blockTimeRemaining <= 1) {
      void handleStop();
    }
  }, [blockTimeRemaining, recordingState, handleStop]);

  const handleStart = useCallback(async () => {
    setError(null);
    try {
      const recorder = new AudioRecorderService();
      const hasPermission = await recorder.requestPermission();
      if (!hasPermission) {
        setError('Microphone permission denied. Please allow microphone access in your browser.');
        return;
      }
      await recorder.start();
      recorderRef.current = recorder;
      recordDurationRef.current = 0;
      setRecordingSeconds(0);
      setRecordingState('recording');
      animateWaveform();

      recTimerRef.current = setInterval(() => {
        recordDurationRef.current += 1;
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch (e) {
      setError(\`Could not start recording: \${e instanceof Error ? e.message : 'Unknown error'}\`);
    }
  }, [animateWaveform]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, []);

  const handleRerecord = () => {
    setRecordingState('idle');
    setRecordingSeconds(0);
    updateResponse(block.id, {
      audioBlobRef: undefined,
      textOrTranscript: '',
      fillerCount: undefined,
      wpm: undefined,
    });
  };

  const handleCyclePrompt = () => {
    if (prompts.length === 0) return;
    const nextIdx = (selectedPromptIdx + 1) % prompts.length;
    setSelectedPromptIdx(nextIdx);
    updateResponse(block.id, {
      promptSnapshot: prompts[nextIdx].prompt,
      questionId: prompts[nextIdx].id,
      questionType: prompts[nextIdx].type,
    });
  };

  const speechStats = analyzeSpeechTranscript(
    transcript,
    recordingSeconds || response?.timeSpentSec || 60
  );

  return (
    <div className="space-y-5">
      {/* Local GPU Status & Prompt Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={\`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium \${
              whisperOnline
                ? 'bg-green-100 text-green-800'
                : whisperOnline === false
                ? 'bg-red-100 text-red-700'
                : 'bg-slate-100 text-slate-600'
            }\`}
          >
            <span
              className={\`w-2 h-2 rounded-full \${
                whisperOnline ? 'bg-green-500' : whisperOnline === false ? 'bg-red-500' : 'bg-slate-400'
              }\`}
            />
            {whisperOnline
              ? 'Local Whisper GPU Online (Verbatim Mode)'
              : whisperOnline === false
              ? 'Local Whisper Offline (Start python app.py on port 8000)'
              : 'Checking Local Whisper...'}
          </span>
        </div>

        {prompts.length > 1 && (
          <button
            type="button"
            onClick={handleCyclePrompt}
            className="text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 border border-primary-200 px-3 py-1 rounded-lg transition-colors"
          >
            ↻ Switch Speaking Prompt ({selectedPromptIdx + 1}/{prompts.length})
          </button>
        )}
      </div>

      {/* Prompt Card */}
      <div className="bg-primary-50 border border-primary-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-semibold text-primary-700 uppercase tracking-wide">
            Speaking Prompt ({prompts[selectedPromptIdx]?.type ?? 'speaking-sample'})
          </p>
          <span className="text-xs text-primary-600 font-medium">Target: 60–90s • 130–150 WPM</span>
        </div>
        <p className="text-base text-slate-800 leading-relaxed font-medium">{activePromptText}</p>
      </div>

      {/* Waveform Visualizer */}
      {recordingState === 'recording' && (
        <div className="bg-slate-900 rounded-xl p-5 shadow-inner">
          <div className="flex items-end justify-center gap-1 h-20">
            {levels.map((level, i) => (
              <div
                key={i}
                className="w-2 rounded-sm bg-primary-400 transition-all duration-75"
                style={{ height: \`\${Math.max(6, level)}%\` }}
              />
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-slate-300 mt-3 pt-2 border-t border-slate-800">
            <span className="flex items-center gap-2 text-red-400 font-semibold">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
              Recording Verbatim Audio...
            </span>
            <span className="font-mono text-sm text-white">{recordingSeconds}s recorded</span>
          </div>
        </div>
      )}

      {/* Transcribing Spinner */}
      {recordingState === 'transcribing' && (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-6 text-center space-y-2">
          <div className="inline-block w-6 h-6 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-semibold text-accent-800">
            Transcribing via Local Faster-Whisper (RTX 3050)...
          </p>
          <p className="text-xs text-accent-600">
            Preserving verbatim hesitations ("uh", "um", pauses) for accurate DET fluency grading.
          </p>
        </div>
      )}

      {/* Recording Controls */}
      <div className="flex flex-col items-center gap-4">
        {recordingState === 'idle' && !response?.audioBlobRef && (
          <button
            type="button"
            onClick={handleStart}
            className="px-8 py-4 rounded-2xl bg-red-500 hover:bg-red-600 text-white font-bold text-base flex items-center gap-3 shadow-lg transition-all hover:scale-105 cursor-pointer"
          >
            <span className="w-3.5 h-3.5 rounded-full bg-white animate-pulse" />
            Start Speaking Recording
          </button>
        )}

        {recordingState === 'recording' && (
          <button
            type="button"
            onClick={handleStop}
            className="px-8 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-base flex items-center gap-3 shadow-lg animate-pulse cursor-pointer"
          >
            <span className="w-3.5 h-3.5 rounded-sm bg-red-500" />
            Stop & Transcribe Now ({recordingSeconds}s)
          </button>
        )}
      </div>

      {/* Captured Audio + Verbatim Transcript & Disfluency Analytics */}
      {response?.audioBlobRef && recordingState !== 'recording' && recordingState !== 'transcribing' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-green-700 flex items-center gap-1.5">
              ✓ Audio Captured & Saved
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRerecord}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
              >
                ↺ Re-record
              </button>
            </div>
          </div>

          <audio controls src={response.audioBlobRef} className="w-full h-10" />

          {/* Fluency & Disfluency Metrics */}
          <div className="grid grid-cols-3 gap-3 pt-1">
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Word Count</p>
              <p className="text-lg font-bold text-slate-900">{speechStats.wordCount} words</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Speaking Pace</p>
              <p
                className={\`text-lg font-bold \${
                  speechStats.wpm >= 115 && speechStats.wpm <= 165
                    ? 'text-green-600'
                    : 'text-amber-600'
                }\`}
              >
                {speechStats.wpm} WPM
              </p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Verbatim Fillers ("uh/um")</p>
              <p
                className={\`text-lg font-bold \${
                  speechStats.fillerCount <= 2 ? 'text-green-600' : 'text-red-600'
                }\`}
              >
                {speechStats.fillerCount} detected
              </p>
            </div>
          </div>

          {/* Editable Verbatim Transcript */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Verbatim Transcript (Local Faster-Whisper output — editable if needed):
            </label>
            <textarea
              value={transcript}
              onChange={(e) =>
                updateResponse(block.id, {
                  textOrTranscript: e.target.value,
                  promptSnapshot: activePromptText,
                })
              }
              rows={4}
              placeholder="Your verbatim transcript will appear here after recording..."
              className="w-full p-3 text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
            />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 9. VOCAB WRITING BLOCK: SM-2 Due Items + Self-Grading (Step 7)
  // =========================================================================
  'src/components/exam/blocks/VocabWritingBlock.tsx': `import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import { initSRS, reviewItem, getDueItems } from '../../../utils/srs';
import type { BlockConfig, QuestionBankItem } from '../../../types';

export function VocabWritingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);

  const [dueQuestions, setDueQuestions] = useState<QuestionBankItem[]>([]);
  const [activeQuestion, setActiveQuestion] = useState<QuestionBankItem | null>(null);
  const [gradedMessage, setGradedMessage] = useState<string | null>(null);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\\s+/).length : 0;

  useEffect(() => {
    const loadVocabItems = async () => {
      const all = await db.questionBank.toArray();
      const writingItems = all.filter((q) => q.skill === 'writing' || q.tags.includes('vocab'));
      const due = getDueItems(writingItems.length > 0 ? writingItems : all);
      const list = due.length > 0 ? due : writingItems;
      setDueQuestions(list);
      if (list.length > 0) {
        setActiveQuestion(list[0]);
      }
    };
    void loadVocabItems();
  }, []);

  const promptText =
    activeQuestion?.prompt ||
    block.instructions ||
    'Write a dense academic paragraph using your target graduate vocabulary.';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, {
        textOrTranscript: e.target.value,
        promptSnapshot: promptText,
        questionId: activeQuestion?.id,
      });
    },
    [activeQuestion?.id, block.id, promptText, updateResponse]
  );

  const handleRateSRS = async (quality: number, label: string) => {
    if (!activeQuestion) return;
    const currentSrs = activeQuestion.srs ?? initSRS();
    const updatedSrs = reviewItem(currentSrs, quality);
    const updatedItem: QuestionBankItem = { ...activeQuestion, srs: updatedSrs };
    await db.questionBank.put(updatedItem);
    setActiveQuestion(updatedItem);
    setGradedMessage(\`SRS Updated (\${label}): Next review in \${updatedSrs.intervalDays} day(s)\`);
    setTimeout(() => setGradedMessage(null), 3500);
  };

  return (
    <div className="space-y-4">
      {/* SRS Prompt Selector Bar */}
      {dueQuestions.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800">
              🧠 {dueQuestions.length} SRS Due Prompt{dueQuestions.length === 1 ? '' : 's'}
            </span>
            <select
              value={activeQuestion?.id ?? ''}
              onChange={(e) => {
                const found = dueQuestions.find((q) => q.id === e.target.value) ?? null;
                setActiveQuestion(found);
              }}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary-400"
            >
              {dueQuestions.map((q, idx) => (
                <option key={q.id} value={q.id}>
                  #{idx + 1} [{q.type}] {q.prompt.slice(0, 60)}...
                </option>
              ))}
            </select>
          </div>

          {/* SM-2 Recall Rating */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400 mr-1">Rate Recall:</span>
            <button
              type="button"
              onClick={() => handleRateSRS(2, 'Hard / Reset')}
              className="px-2.5 py-1 text-xs font-medium bg-red-50 text-red-700 rounded hover:bg-red-100"
            >
              Again (1d)
            </button>
            <button
              type="button"
              onClick={() => handleRateSRS(4, 'Good')}
              className="px-2.5 py-1 text-xs font-medium bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
            >
              Good
            </button>
            <button
              type="button"
              onClick={() => handleRateSRS(5, 'Easy')}
              className="px-2.5 py-1 text-xs font-medium bg-green-50 text-green-700 rounded hover:bg-green-100"
            >
              Easy
            </button>
          </div>
        </div>
      )}

      {gradedMessage && (
        <div className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          ✓ {gradedMessage}
        </div>
      )}

      {/* Prompt Card */}
      <div className="bg-accent-50 border border-accent-200 rounded-xl p-4">
        <p className="text-xs font-semibold text-accent-600 uppercase tracking-wide mb-1.5">
          Active Vocabulary & Precision Writing Prompt
        </p>
        <p className="text-sm text-slate-800 leading-relaxed font-medium">{promptText}</p>
        {activeQuestion?.sampleAnswer && (
          <details className="mt-2 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold text-accent-700">
              Show Reference 150-Band Sample Answer
            </summary>
            <p className="mt-1.5 p-2.5 bg-white/80 rounded-lg border border-accent-100 italic">
              {activeQuestion.sampleAnswer}
            </p>
          </details>
        )}
      </div>

      {/* Writing Area */}
      <div>
        <textarea
          value={text}
          onChange={handleChange}
          placeholder="Write your academic paragraph here..."
          className="w-full min-h-[300px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-accent-400 leading-relaxed placeholder:text-slate-300"
          spellCheck
          autoFocus
        />
        <div className="flex justify-between mt-1.5 text-xs text-slate-500">
          <span>Target: 75–120 words with complex clause transitions</span>
          <span className={wordCount >= 75 ? 'text-green-600 font-semibold' : ''}>
            {wordCount} {wordCount === 1 ? 'word' : 'words'}
            {wordCount >= 75 ? ' ✓' : ' / 75+'}
          </span>
        </div>
      </div>
    </div>
  );
}
`,

  // =========================================================================
  // 10. MOCK TEST BLOCK: Question Type Filter & Adaptive Picker (Step 7)
  // =========================================================================
  'src/components/exam/blocks/MockTestBlock.tsx': `import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { getAdaptiveQuestions } from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem, DETQuestionType, DETSkill } from '../../../types';

const QUESTION_TYPE_LABELS: { value: DETQuestionType | 'adaptive'; label: string }[] = [
  { value: 'adaptive', label: '⚡ Adaptive (Targets Weakest Skill)' },
  { value: 'interactive-writing', label: '✍️ Interactive Writing' },
  { value: 'write-about-photo', label: '🖼️ Write About Photo' },
  { value: 'listen-and-type', label: '🎧 Listen & Type' },
  { value: 'read-aloud', label: '📖 Read Aloud' },
  { value: 'interactive-speaking', label: '🗣️ Interactive Speaking' },
  { value: 'speaking-sample', label: '🎤 Speaking Sample' },
];

export function MockTestBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const activeRun = useSessionStore((s) => s.activeRun);

  const [selectedType, setSelectedType] = useState<DETQuestionType | 'adaptive'>(
    block.preferredQuestionType ??
      (activeRun?.preferredQuestionType === 'all' ? 'adaptive' : activeRun?.preferredQuestionType) ??
      'adaptive'
  );
  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [weakestSkill, setWeakestSkill] = useState<DETSkill | null>(null);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\\s+/).length : 0;

  useEffect(() => {
    getAdaptiveQuestions({
      questionType: selectedType,
      limit: 12,
    }).then(({ selected, weakestSkill: ws }) => {
      setQuestions(selected);
      setWeakestSkill(ws);
      setCurrentIndex(0);
    });
  }, [selectedType]);

  const activeQuestion = questions[currentIndex] ?? null;
  const activePrompt =
    activeQuestion?.prompt ||
    block.instructions ||
    'Complete the DET-style task below under strict exam conditions.';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, {
        textOrTranscript: e.target.value,
        promptSnapshot: activePrompt,
        questionId: activeQuestion?.id,
        questionType: activeQuestion?.type ?? selectedType,
      });
    },
    [activePrompt, activeQuestion?.id, activeQuestion?.type, block.id, selectedType, updateResponse]
  );

  return (
    <div className="space-y-4">
      {/* Question Type Switcher & Adaptive Badge */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl p-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600">Question Type:</label>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as DETQuestionType | 'adaptive')}
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-400"
          >
            {QUESTION_TYPE_LABELS.map((qt) => (
              <option key={qt.value} value={qt.value}>
                {qt.label}
              </option>
            ))}
          </select>
          {weakestSkill && (
            <span className="text-xs bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full">
              Adaptive Focus: {weakestSkill}
            </span>
          )}
        </div>

        {questions.length > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCurrentIndex((i) => (i - 1 + questions.length) % questions.length)}
              className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50"
            >
              ← Prev
            </button>
            <span className="text-xs text-slate-500 font-mono">
              {currentIndex + 1} / {questions.length}
            </span>
            <button
              type="button"
              onClick={() => setCurrentIndex((i) => (i + 1) % questions.length)}
              className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50"
            >
              Next Prompt →
            </button>
          </div>
        )}
      </div>

      {/* Prompt Card */}
      <div className="bg-white border-2 border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-primary-700 bg-primary-50 px-2.5 py-0.5 rounded uppercase tracking-wide">
            {activeQuestion?.type ?? 'mock-test'} • {activeQuestion?.difficulty ?? 'hard'}
          </span>
          <span className="text-xs text-slate-400">DET 140–150 Simulation</span>
        </div>
        <p className="text-base text-slate-800 leading-relaxed font-medium">{activePrompt}</p>
      </div>

      {/* Response Textarea */}
      <textarea
        value={text}
        onChange={handleChange}
        placeholder="Type your full DET response here..."
        className="w-full min-h-[280px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 leading-relaxed placeholder:text-slate-300"
        spellCheck
        autoFocus
      />
      <div className="flex justify-between text-xs text-slate-500">
        <span>Aim for structured paragraphs, varied subordination, and precise vocabulary</span>
        <span className="font-mono font-semibold text-slate-700">
          {wordCount} {wordCount === 1 ? 'word' : 'words'}
        </span>
      </div>
    </div>
  );
}
`,

  // =========================================================================
  // 11. PRE-SESSION: Block Checkboxes, Question Type Filter, Instant Feedback Toggle
  // =========================================================================
  'src/components/exam/PreSession.tsx': `import { useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { db, ensureDatabaseUpgraded } from '../../db/database';
import { checkLocalWhisperHealth } from '../../services/stt';
import type { SessionRun, DETQuestionType } from '../../types';
import { formatTime } from '../../utils/helpers';

export function PreSession() {
  const templates = useConfigStore((s) => s.templates);
  const loadTemplates = useConfigStore((s) => s.loadTemplates);
  const startSession = useSessionStore((s) => s.startSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const selectedTemplateId = useSessionStore((s) => s.selectedTemplateId);
  const setSelectedTemplateId = useSessionStore((s) => s.setSelectedTemplateId);

  const [incompleteRun, setIncompleteRun] = useState<SessionRun | null>(null);
  const [micStatus, setMicStatus] = useState<'unchecked' | 'granted' | 'denied'>('unchecked');
  const [whisperOnline, setWhisperOnline] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);

  // User customization states
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [customDurations, setCustomDurations] = useState<Record<string, number>>({});
  const [instantFeedback, setInstantFeedback] = useState<boolean>(true);
  const [preferredQuestionType, setPreferredQuestionType] = useState<DETQuestionType | 'all' | 'adaptive'>('adaptive');

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  useEffect(() => {
    ensureDatabaseUpgraded().then(() => loadTemplates());
    checkLocalWhisperHealth().then(setWhisperOnline);
    db.sessionRuns
      .where('status')
      .equals('in-progress')
      .reverse()
      .sortBy('startedAt')
      .then((inProgress) => {
        if (inProgress.length > 0) setIncompleteRun(inProgress[0]);
      });
  }, [loadTemplates]);

  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId, setSelectedTemplateId]);

  // Whenever selected template changes, select all its blocks by default
  useEffect(() => {
    if (selectedTemplate) {
      setSelectedBlockIds(selectedTemplate.blocks.map((b) => b.id));
      const durations: Record<string, number> = {};
      for (const b of selectedTemplate.blocks) {
        durations[b.id] = b.durationSec;
      }
      setCustomDurations(durations);
    }
  }, [selectedTemplate]);

  const activeBlocks =
    selectedTemplate?.blocks.filter((b) => selectedBlockIds.includes(b.id)) ?? [];
  const hasSpeakingBlock = activeBlocks.some((b) => b.type === 'speaking');
  const totalSec = activeBlocks.reduce(
    (sum, b) => sum + (customDurations[b.id] ?? b.durationSec),
    0
  );

  const toggleBlockSelection = (blockId: string) => {
    setSelectedBlockIds((prev) =>
      prev.includes(blockId) ? prev.filter((id) => id !== blockId) : [...prev, blockId]
    );
  };

  const handleMicCheck = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
    } catch {
      setMicStatus('denied');
    }
  };

  const handleStart = async () => {
    if (!selectedTemplate || activeBlocks.length === 0) return;
    setStarting(true);
    await startSession(selectedTemplate, {
      selectedBlockIds,
      customDurations,
      instantFeedback,
      preferredQuestionType,
    });
  };

  const handleDiscardIncomplete = async () => {
    if (!incompleteRun) return;
    await db.sessionRuns.update(incompleteRun.id, {
      status: 'abandoned',
      endedAt: new Date().toISOString(),
    });
    setIncompleteRun(null);
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* Interrupted Session Banner */}
      {incompleteRun && (
        <div className="mb-8 bg-amber-50 border border-amber-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold text-amber-900">⚠️ Incomplete Session Found</h3>
            <p className="text-xs text-amber-700 mt-0.5">
              Started {new Date(incompleteRun.startedAt).toLocaleString()} • Block{' '}
              {incompleteRun.currentBlockIndex + 1} of {incompleteRun.blockConfigs.length}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => resumeSession(incompleteRun)}
              className="px-4 py-2 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700"
            >
              ▶ Resume Session
            </button>
            <button
              onClick={handleDiscardIncomplete}
              className="px-3 py-2 text-xs text-amber-800 border border-amber-300 rounded-lg hover:bg-amber-100"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Configure & Start Practice</h2>
          <p className="text-sm text-slate-500">
            Choose a full template or select individual blocks, question types, and feedback mode.
          </p>
        </div>
        <span
          className={\`text-xs font-medium px-3 py-1 rounded-full \${
            whisperOnline
              ? 'bg-green-100 text-green-800'
              : 'bg-slate-200 text-slate-700'
          }\`}
        >
          {whisperOnline ? '🟢 Local Whisper GPU Ready' : '⚪ Local Whisper (Port 8000)'}
        </span>
      </div>

      {/* 1. Template Picker */}
      <div className="mb-6">
        <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
          1. Select Session Template
        </label>
        <div className="grid gap-3">
          {templates.map((t) => (
            <label
              key={t.id}
              className={\`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all \${
                selectedTemplateId === t.id
                  ? 'border-primary-500 bg-primary-50/60'
                  : 'border-slate-200 bg-white hover:border-primary-300'
              }\`}
            >
              <input
                type="radio"
                name="template"
                checked={selectedTemplateId === t.id}
                onChange={() => setSelectedTemplateId(t.id)}
                className="mt-1 text-primary-600"
              />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-slate-900">{t.name}</p>
                  <span className="text-xs font-mono text-slate-500">
                    {t.blocks.length} blocks
                  </span>
                </div>
                {t.description && (
                  <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>
                )}
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* 2. Choose Full or Partial Blocks + Custom Durations */}
      {selectedTemplate && (
        <div className="mb-6 bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">
                2. Select Blocks to Run ({activeBlocks.length} of {selectedTemplate.blocks.length} selected)
              </h3>
              <p className="text-xs text-slate-500">
                Uncheck any block if you only want to drill specific parts today.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelectedBlockIds(selectedTemplate.blocks.map((b) => b.id))}
                className="text-xs text-primary-600 hover:underline font-medium"
              >
                Select All
              </button>
              <span className="text-slate-300">|</span>
              <span className="text-xs font-mono font-semibold text-slate-700">
                Total: {formatTime(totalSec)}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            {selectedTemplate.blocks.map((b, i) => {
              const checked = selectedBlockIds.includes(b.id);
              const durMin = Math.max(1, Math.round((customDurations[b.id] ?? b.durationSec) / 60));
              return (
                <div
                  key={b.id}
                  className={\`flex items-center justify-between p-3 rounded-lg border transition-colors \${
                    checked ? 'bg-slate-50 border-slate-200' : 'bg-slate-50/40 border-slate-100 opacity-50'
                  }\`}
                >
                  <label className="flex items-center gap-3 cursor-pointer flex-1">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleBlockSelection(b.id)}
                      className="rounded text-primary-600 focus:ring-primary-500"
                    />
                    <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-700 text-xs flex items-center justify-center font-bold">
                      {i + 1}
                    </span>
                    <div>
                      <span className="text-sm font-semibold text-slate-800">{b.name}</span>
                      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-600">
                        {b.type}
                      </span>
                    </div>
                  </label>

                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={durMin}
                      onChange={(e) =>
                        setCustomDurations((prev) => ({
                          ...prev,
                          [b.id]: Math.max(1, Number(e.target.value)) * 60,
                        }))
                      }
                      className="w-16 px-2 py-1 text-xs font-mono border border-slate-300 rounded text-right"
                    />
                    <span className="text-xs text-slate-500">min</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Feedback Mode & Question Type Filter */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            3. AI Feedback Timing
          </label>
          <div className="space-y-2">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="radio"
                checked={instantFeedback}
                onChange={() => setInstantFeedback(true)}
                className="mt-1 text-primary-600"
              />
              <div>
                <p className="text-sm font-semibold text-slate-800">⚡ Instant Per-Block Feedback</p>
                <p className="text-xs text-slate-500">
                  Grade any block immediately while practicing (pauses timer while reviewing).
                </p>
              </div>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="radio"
                checked={!instantFeedback}
                onChange={() => setInstantFeedback(false)}
                className="mt-1 text-primary-600"
              />
              <div>
                <p className="text-sm font-semibold text-slate-800">🎯 Exam Simulation Mode</p>
                <p className="text-xs text-slate-500">
                  No interruptions—evaluate all blocks together at the end of the session.
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            4. Question Selection Mode
          </label>
          <select
            value={preferredQuestionType}
            onChange={(e) =>
              setPreferredQuestionType(e.target.value as DETQuestionType | 'all' | 'adaptive')
            }
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-800 mb-2"
          >
            <option value="adaptive">⚡ Adaptive + SRS Due First (Recommended)</option>
            <option value="all">All Question Types</option>
            <option value="interactive-writing">✍️ Interactive Writing Only</option>
            <option value="write-about-photo">🖼️ Write About Photo Only</option>
            <option value="speaking-sample">🎤 Speaking Sample Only</option>
            <option value="interactive-speaking">🗣️ Interactive Speaking Only</option>
            <option value="read-aloud">📖 Read Aloud Only</option>
            <option value="listen-and-type">🎧 Listen & Type Only</option>
          </select>

          {hasSpeakingBlock && (
            <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
              <span className="text-xs text-slate-600">Microphone Status:</span>
              {micStatus === 'granted' ? (
                <span className="text-xs font-semibold text-green-600">✓ Mic Ready</span>
              ) : (
                <button
                  type="button"
                  onClick={handleMicCheck}
                  className="text-xs font-semibold text-primary-600 hover:underline"
                >
                  Test Microphone
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Start Button */}
      <button
        onClick={handleStart}
        disabled={!selectedTemplate || activeBlocks.length === 0 || starting}
        className="w-full py-4 bg-primary-600 text-white text-base font-bold rounded-xl hover:bg-primary-700 disabled:opacity-50 transition-colors cursor-pointer shadow-sm"
      >
        {starting
          ? 'Starting Session...'
          : \`▶ Start Practice (\${activeBlocks.length} Block\${activeBlocks.length === 1 ? '' : 's'} • \${formatTime(totalSec)})\`}
      </button>
    </div>
  );
}
`,

  // =========================================================================
  // 12. SESSION RUNNER: Instant AI Feedback Drawer, Auto-Save Badge, Block Jump
  // =========================================================================
  'src/components/exam/SessionRunner.tsx': `import { useEffect, useRef, useCallback, useState } from 'react';
import {
  useSessionStore,
  selectCurrentBlock,
  selectBlockTimeRemaining,
  selectBlockProgress,
  selectIsLastBlock,
} from '../../stores/sessionStore';
import { TimerEngine } from '../../utils/timer';
import { formatTime } from '../../utils/helpers';
import { db } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { BlockInputRouter } from './BlockInputRouter';
import { TransitionOverlay } from './TransitionOverlay';

export function SessionRunner() {
  const isRunning = useSessionStore((s) => s.isRunning);
  const isPaused = useSessionStore((s) => s.isPaused);
  const transitionCountdown = useSessionStore((s) => s.transitionCountdown);
  const overallElapsedSec = useSessionStore((s) => s.overallElapsedSec);
  const currentBlockIndex = useSessionStore((s) => s.currentBlockIndex);
  const activeRun = useSessionStore((s) => s.activeRun);
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const lastSavedAt = useSessionStore((s) => s.lastSavedAt);

  const tick = useSessionStore((s) => s.tick);
  const pauseSession = useSessionStore((s) => s.pauseSession);
  const resumeRunning = useSessionStore((s) => s.resumeRunning);
  const advanceBlock = useSessionStore((s) => s.advanceBlock);
  const jumpToBlock = useSessionStore((s) => s.jumpToBlock);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const abandonSession = useSessionStore((s) => s.abandonSession);

  const currentBlock = useSessionStore(selectCurrentBlock);
  const blockTimeRemaining = useSessionStore(selectBlockTimeRemaining);
  const blockProgress = useSessionStore(selectBlockProgress);
  const isLastBlock = useSessionStore(selectIsLastBlock);

  const [instantEvalLoading, setInstantEvalLoading] = useState(false);
  const [instantEvalError, setInstantEvalError] = useState<string | null>(null);

  const timerRef = useRef<TimerEngine | null>(null);
  useEffect(() => {
    timerRef.current = new TimerEngine(tick, 1000);
    timerRef.current.start();
    return () => timerRef.current?.stop();
  }, [tick]);

  useEffect(() => {
    if (!timerRef.current) return;
    if (isPaused) {
      timerRef.current.stop();
    } else if (isRunning) {
      timerRef.current.start();
    }
  }, [isPaused, isRunning]);

  const handleDone = useCallback(() => {
    setInstantEvalError(null);
    advanceBlock();
  }, [advanceBlock]);

  const handleInstantCheck = useCallback(async () => {
    if (!currentBlock) return;
    const resp = draftResponses[currentBlock.id];
    const studentText = resp?.textOrTranscript?.trim() ?? '';
    if (!studentText) {
      setInstantEvalError('Write a response or record & transcribe your speech before requesting AI feedback.');
      return;
    }

    pauseSession();
    setInstantEvalLoading(true);
    setInstantEvalError(null);

    try {
      const settings = await db.settings.get('app-settings');
      if (!settings?.geminiApiKey) {
        throw new Error('Gemini API key not configured. Add it in Config -> Settings.');
      }
      const evalPrompts = await db.evalPrompts.toArray();
      const evalPrompt =
        evalPrompts.find((ep) => ep.id === currentBlock.evalPromptId) ??
        evalPrompts.find((ep) => ep.appliesToType === currentBlock.type) ??
        evalPrompts[0];

      if (!evalPrompt) throw new Error('No evaluation prompt found.');

      const feedback = await evaluateResponse({
        apiKey: settings.geminiApiKey,
        evalPromptTemplate: evalPrompt.promptText,
        variables: {
          prompt: resp?.promptSnapshot || currentBlock.instructions,
          response: studentText,
          transcript: studentText,
          durationSec: String(resp?.timeSpentSec ?? 60),
        },
      });

      updateResponse(currentBlock.id, {
        aiFeedback: feedback,
        aiOverallScore: feedback.overallScore,
        aiSubscores: feedback.subscores,
      });
    } catch (err) {
      setInstantEvalError(err instanceof Error ? err.message : 'Instant evaluation failed.');
    } finally {
      setInstantEvalLoading(false);
    }
  }, [currentBlock, draftResponses, pauseSession, updateResponse]);

  const handleAbandon = useCallback(async () => {
    if (window.confirm('Exit this practice session? Your draft responses remain saved in History.')) {
      await abandonSession();
    }
  }, [abandonSession]);

  if (!activeRun || !currentBlock) return null;

  const currentResponse = draftResponses[currentBlock.id];
  const blockFeedback = currentResponse?.aiFeedback;
  const isLowTime = blockTimeRemaining <= 60 && blockTimeRemaining > 0;
  const isCritical = blockTimeRemaining <= 10 && blockTimeRemaining > 0;
  const totalBlocks = activeRun.blockConfigs.length;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Sticky Top Header */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-xs">
        {/* Clickable Segmented Progress Bar (allows jumping between blocks) */}
        <div className="flex gap-1 px-2 pt-1.5">
          {activeRun.blockConfigs.map((block, i) => {
            let fill = 0;
            if (i < currentBlockIndex) fill = 1;
            else if (i === currentBlockIndex) fill = blockProgress;
            return (
              <button
                key={block.id}
                type="button"
                onClick={() => jumpToBlock(i)}
                title={\`Jump to Block \${i + 1}: \${block.name}\`}
                className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden cursor-pointer hover:opacity-80"
              >
                <div
                  className="h-full bg-primary-500 transition-all duration-500"
                  style={{ width: \`\${fill * 100}%\` }}
                />
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between px-6 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2.5 py-1 rounded-md">
              Block {currentBlockIndex + 1} / {totalBlocks}
            </span>
            <span className="text-sm font-semibold text-slate-800">{currentBlock.name}</span>
            {lastSavedAt && (
              <span className="text-xs text-slate-400 hidden sm:inline">
                ✓ Auto-saved
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            <span className="text-xs text-slate-400 font-mono">
              Total {formatTime(overallElapsedSec)}
            </span>
            <span className="w-px h-4 bg-slate-200" />
            <span
              className={\`text-base font-bold font-mono tabular-nums px-2.5 py-0.5 rounded \${
                blockTimeRemaining === 0
                  ? 'bg-red-100 text-red-700'
                  : isCritical
                  ? 'bg-red-50 text-red-600 timer-warning'
                  : isLowTime
                  ? 'bg-amber-50 text-amber-600'
                  : 'text-slate-800'
              }\`}
            >
              {blockTimeRemaining === 0 ? 'TIME UP' : formatTime(blockTimeRemaining)}
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 max-w-3xl w-full mx-auto px-6 py-6 space-y-6">
        <BlockInputRouter block={currentBlock} />

        {/* Instant AI Evaluation Drawer */}
        {instantEvalError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl p-3">
            {instantEvalError}
          </div>
        )}

        {blockFeedback && (
          <div className="bg-white border-2 border-primary-300 rounded-2xl p-5 shadow-md space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-primary-600">
                  ⚡ Instant DET Calibration (Timer Paused)
                </span>
                <h4 className="text-base font-bold text-slate-900">
                  Block Score Breakdown
                </h4>
              </div>
              <div className="text-right">
                <span className="text-3xl font-black text-primary-600">
                  {currentResponse?.aiOverallScore ?? '—'}
                </span>
                <span className="text-xs text-slate-400 block">/ 160</span>
              </div>
            </div>

            {Object.keys(blockFeedback.subscores).length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(blockFeedback.subscores).map(([k, v]) => (
                  <div key={k} className="bg-slate-50 rounded-lg p-2.5 text-center">
                    <p className="text-xs text-slate-500 capitalize">{k.replace(/_/g, ' ')}</p>
                    <p className="text-base font-bold text-slate-800">{v}</p>
                  </div>
                ))}
              </div>
            )}

            {blockFeedback.suggestedFix && (
              <div className="bg-primary-50 border border-primary-200 rounded-xl p-3">
                <p className="text-xs font-bold text-primary-800 mb-1">
                  ✨ 145–155 Band Suggested Upgrade:
                </p>
                <p className="text-xs text-slate-800 leading-relaxed">
                  {blockFeedback.suggestedFix}
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {blockFeedback.strengths.length > 0 && (
                <div className="bg-green-50 rounded-lg p-3">
                  <p className="font-bold text-green-800 mb-1">✓ Strengths</p>
                  <ul className="list-disc list-inside space-y-1 text-slate-700">
                    {blockFeedback.strengths.map((s, idx) => (
                      <li key={idx}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {blockFeedback.weaknesses.length > 0 && (
                <div className="bg-amber-50 rounded-lg p-3">
                  <p className="font-bold text-amber-800 mb-1">⚠️ Areas to Tighten</p>
                  <ul className="list-disc list-inside space-y-1 text-slate-700">
                    {blockFeedback.weaknesses.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={resumeRunning}
                className="px-4 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800"
              >
                ▶ Resume Timer & Keep Practicing
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sticky Footer Controls */}
      <footer className="sticky bottom-0 z-30 bg-white border-t border-slate-200 px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={handleAbandon}
          className="text-xs font-medium text-slate-400 hover:text-red-600 transition-colors"
        >
          ✕ Exit Session
        </button>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleInstantCheck}
            disabled={instantEvalLoading}
            className="px-4 py-2 text-xs font-semibold text-accent-700 bg-accent-50 border border-accent-200 rounded-lg hover:bg-accent-100 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {instantEvalLoading ? '⏳ Grading Block...' : '⚡ Instant AI Feedback'}
          </button>

          <button
            type="button"
            onClick={isPaused ? resumeRunning : pauseSession}
            className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            {isPaused ? '▶ Resume Timer' : '⏸ Pause'}
          </button>

          <button
            type="button"
            onClick={handleDone}
            className="px-5 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 transition-colors cursor-pointer"
          >
            {isLastBlock ? 'Finish & Review Session →' : 'Next Block →'}
          </button>
        </div>
      </footer>

      {transitionCountdown !== null && (
        <TransitionOverlay
          count={transitionCountdown}
          nextBlockName={activeRun.blockConfigs[currentBlockIndex]?.name}
        />
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 13. POST-SESSION: Fixed Gemini Scoring, Summary Persistence, Offline Queue
  // =========================================================================
  'src/components/exam/PostSession.tsx': `import { useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { db } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { formatTime } from '../../utils/helpers';
import type { BlockResponse, DETSkill } from '../../types';

export function PostSession() {
  const activeRun = useSessionStore((s) => s.activeRun);
  const clearActiveRun = useSessionStore((s) => s.clearActiveRun);
  const setView = useAppStore((s) => s.setView);
  const setConfigSection = useAppStore((s) => s.setConfigSection);

  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [localResponses, setLocalResponses] = useState<Record<string, BlockResponse>>(
    activeRun?.responses ?? {}
  );

  const handleUpdateText = (blockId: string, text: string) => {
    setLocalResponses((prev) => ({
      ...prev,
      [blockId]: { ...prev[blockId], textOrTranscript: text },
    }));
  };

  const handleEvaluate = useCallback(async () => {
    if (!activeRun) return;

    if (!navigator.onLine) {
      setQueuedOffline(true);
      setEvalError('You are currently offline. Responses are saved and will auto-evaluate when back online.');
      return;
    }

    setEvaluating(true);
    setEvalError(null);

    try {
      const settings = await db.settings.get('app-settings');
      if (!settings?.geminiApiKey) {
        setEvalError('Gemini API key not set. Go to Config -> Settings to paste your free Google AI Studio key.');
        setEvaluating(false);
        return;
      }

      const evalPrompts = await db.evalPrompts.toArray();
      const updatedResponses = { ...localResponses };
      const blockScores: number[] = [];
      const skillScores: Partial<Record<DETSkill, number[]>> = {};

      for (const block of activeRun.blockConfigs) {
        const response = updatedResponses[block.id];
        const text = response?.textOrTranscript?.trim() ?? '';
        if (!text) continue;

        const evalPrompt =
          evalPrompts.find((ep) => ep.id === block.evalPromptId) ??
          evalPrompts.find((ep) => ep.appliesToType === block.type) ??
          evalPrompts[0];

        if (!evalPrompt) continue;

        const feedback = await evaluateResponse({
          apiKey: settings.geminiApiKey,
          evalPromptTemplate: evalPrompt.promptText,
          variables: {
            prompt: response?.promptSnapshot || block.instructions,
            response: text,
            transcript: text,
            durationSec: String(response?.timeSpentSec ?? block.durationSec),
          },
        });

        const subVals = Object.values(feedback.subscores);
        const computedScore =
          feedback.overallScore ??
          (subVals.length > 0
            ? Math.round(subVals.reduce((a, b) => a + b, 0) / subVals.length)
            : 125);

        blockScores.push(computedScore);

        const targetSkill: DETSkill =
          block.type === 'speaking'
            ? 'speaking'
            : block.type === 'mock-test'
            ? 'reading'
            : 'writing';
        skillScores[targetSkill] = [...(skillScores[targetSkill] ?? []), computedScore];

        updatedResponses[block.id] = {
          ...response,
          aiFeedback: feedback,
          aiOverallScore: computedScore,
          aiSubscores: feedback.subscores,
          evalPendingOffline: false,
        };
      }

      const compositeOverall =
        blockScores.length > 0
          ? Math.round(blockScores.reduce((a, b) => a + b, 0) / blockScores.length)
          : undefined;

      const perSkillScores: Partial<Record<DETSkill, number>> = {};
      for (const [sk, arr] of Object.entries(skillScores) as [DETSkill, number[]][]) {
        if (arr && arr.length > 0) {
          perSkillScores[sk] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
        }
      }

      setLocalResponses(updatedResponses);
      await db.sessionRuns.update(activeRun.id, {
        responses: updatedResponses,
        summary: {
          overallScore: compositeOverall,
          perSkillScores,
          durationSec: activeRun.overallElapsedSec,
        },
      });
      setQueuedOffline(false);
    } catch (err) {
      setEvalError(
        err instanceof Error ? err.message : 'Evaluation failed. Check your Gemini API key.'
      );
    } finally {
      setEvaluating(false);
    }
  }, [activeRun, localResponses]);

  // Auto-evaluate when connection is restored if queued offline
  useEffect(() => {
    if (!queuedOffline) return;
    const onOnline = () => {
      void handleEvaluate();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [queuedOffline, handleEvaluate]);

  if (!activeRun) return null;

  const scoredValues = Object.values(localResponses)
    .map((r) => r.aiOverallScore)
    .filter((v): v is number => typeof v === 'number');
  const sessionAverage =
    scoredValues.length > 0
      ? Math.round(scoredValues.reduce((a, b) => a + b, 0) / scoredValues.length)
      : null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* Header Banner */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-8 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-primary-600">
            Session Complete
          </span>
          <h2 className="text-2xl font-bold text-slate-900 mt-0.5">{activeRun.templateName}</h2>
          <p className="text-xs text-slate-500 mt-1">
            Total Time: {formatTime(activeRun.overallElapsedSec)} • {activeRun.blockConfigs.length} Blocks
          </p>
        </div>

        {sessionAverage !== null ? (
          <div className="text-right bg-primary-50 border border-primary-200 px-5 py-3 rounded-xl">
            <span className="text-xs font-semibold text-primary-700 block">Estimated DET Band</span>
            <span className="text-4xl font-black text-primary-600">{sessionAverage}</span>
            <span className="text-xs text-primary-600"> / 160 (Target: 140–150)</span>
          </div>
        ) : (
          <button
            onClick={handleEvaluate}
            disabled={evaluating}
            className="px-6 py-3 bg-primary-600 text-white text-sm font-bold rounded-xl hover:bg-primary-700 disabled:opacity-50 cursor-pointer shadow-sm"
          >
            {evaluating ? '⏳ Grading with Gemini...' : '✨ Grade All Blocks with Gemini AI'}
          </button>
        )}
      </div>

      {evalError && (
        <div className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-4">
          {evalError}
        </div>
      )}

      {/* Per-block review cards */}
      <div className="space-y-6">
        {activeRun.blockConfigs.map((block, idx) => {
          const response = localResponses[block.id];
          const feedback = response?.aiFeedback;
          const score = response?.aiOverallScore;

          return (
            <div key={block.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between p-4 bg-slate-50 border-b border-slate-100">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-full bg-slate-200 text-slate-700 text-xs flex items-center justify-center font-bold">
                    {idx + 1}
                  </span>
                  <div>
                    <h3 className="font-semibold text-slate-900">{block.name}</h3>
                    <p className="text-xs text-slate-500">
                      {block.type} • {formatTime(response?.timeSpentSec ?? 0)} spent
                      {response?.wpm ? \` • \${response.wpm} WPM\` : ''}
                      {response?.fillerCount !== undefined ? \` • \${response.fillerCount} fillers\` : ''}
                    </p>
                  </div>
                </div>
                {score !== undefined && (
                  <div className="text-right">
                    <span className="text-2xl font-black text-primary-600">{score}</span>
                    <span className="text-xs text-slate-400 block">/ 160</span>
                  </div>
                )}
              </div>

              <div className="p-5 space-y-4">
                {response?.audioBlobRef && (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">
                      Recorded Audio
                    </label>
                    <audio controls src={response.audioBlobRef} className="w-full h-10" />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">
                    Your Response / Verbatim Transcript (Editable before re-evaluating):
                  </label>
                  <textarea
                    value={response?.textOrTranscript ?? ''}
                    onChange={(e) => handleUpdateText(block.id, e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-400"
                  />
                </div>

                {feedback && (
                  <div className="space-y-4 pt-2 border-t border-slate-100">
                    {Object.keys(feedback.subscores).length > 0 && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {Object.entries(feedback.subscores).map(([key, val]) => (
                          <div key={key} className="bg-slate-50 rounded-lg p-2.5 border border-slate-100">
                            <p className="text-xs text-slate-500 capitalize">{key.replace(/_/g, ' ')}</p>
                            <p className="text-lg font-bold text-primary-600">{val}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {feedback.suggestedFix && (
                      <div className="bg-primary-50 border border-primary-200 rounded-xl p-3.5">
                        <p className="text-xs font-bold text-primary-800 mb-1">
                          ✨ 145–155 Band Suggested Upgrade
                        </p>
                        <p className="text-xs text-slate-800 leading-relaxed">
                          {feedback.suggestedFix}
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                      {feedback.strengths.length > 0 && (
                        <div className="bg-green-50 rounded-lg p-3">
                          <p className="font-bold text-green-800 mb-1.5">✓ Strengths</p>
                          <ul className="space-y-1 text-slate-700 list-disc list-inside">
                            {feedback.strengths.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {feedback.weaknesses.length > 0 && (
                        <div className="bg-amber-50 rounded-lg p-3">
                          <p className="font-bold text-amber-800 mb-1.5">⚠️ Weaknesses</p>
                          <ul className="space-y-1 text-slate-700 list-disc list-inside">
                            {feedback.weaknesses.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {feedback.suggestions.length > 0 && (
                        <div className="bg-blue-50 rounded-lg p-3">
                          <p className="font-bold text-blue-800 mb-1.5">💡 Actionable Fixes</p>
                          <ul className="space-y-1 text-slate-700 list-disc list-inside">
                            {feedback.suggestions.map((sg, i) => (
                              <li key={i}>{sg}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer Actions */}
      <div className="mt-8 flex flex-wrap justify-between items-center gap-3">
        <button
          onClick={handleEvaluate}
          disabled={evaluating}
          className="px-4 py-2 text-sm font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 disabled:opacity-50"
        >
          {evaluating ? 'Re-evaluating...' : '↻ Re-evaluate Responses with AI'}
        </button>

        <div className="flex gap-3">
          <button
            onClick={() => {
              clearActiveRun();
            }}
            className="px-4 py-2.5 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-white"
          >
            Start Another Session
          </button>
          <button
            onClick={() => {
              clearActiveRun();
              setConfigSection('history');
              setView('config');
            }}
            className="px-5 py-2.5 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-800"
          >
            📊 View Score Trends & History
          </button>
        </div>
      </div>
    </div>
  );
}
`,

  // =========================================================================
  // 14. HISTORY & TREND DASHBOARD (Step 8)
  // =========================================================================
  'src/components/config/HistoryPanel.tsx': `import { useEffect, useState } from 'react';
import { db } from '../../db/database';
import { formatDate, formatTime } from '../../utils/helpers';
import type { SessionRun } from '../../types';

export function HistoryPanel() {
  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<SessionRun | null>(null);

  const loadRuns = async () => {
    const all = await db.sessionRuns.orderBy('startedAt').reverse().toArray();
    setRuns(all);
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  const completedWithScores = runs
    .filter((r) => r.summary?.overallScore !== undefined)
    .slice()
    .reverse();

  const handleDeleteRun = async (id: string) => {
    if (!window.confirm('Delete this session record permanently?')) return;
    await db.sessionRuns.delete(id);
    if (selectedRun?.id === id) setSelectedRun(null);
    await loadRuns();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Session History & 140–150 Score Trends</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Track your composite DET score progression and review past verbatim recordings.
        </p>
      </div>

      {/* SVG Trend Chart */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-800">Overall Score Progression (0–160 Scale)</h3>
          <span className="text-xs px-2.5 py-0.5 rounded-full bg-green-100 text-green-800 font-semibold">
            Green Band = 140–150 Target Zone
          </span>
        </div>

        {completedWithScores.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-400">
            Complete and AI-evaluate a session to plot your 0–160 score trend.
          </div>
        ) : (
          <svg viewBox="0 0 600 180" className="w-full h-44 overflow-visible">
            {/* Target 140-150 Band Highlight */}
            <rect
              x="40"
              y={160 - (150 / 160) * 140}
              width="540"
              height={(15 / 160) * 140}
              fill="#dcfce7"
              rx="4"
            />
            {[0, 80, 120, 140, 160].map((val) => {
              const y = 160 - (val / 160) * 140;
              return (
                <g key={val}>
                  <line
                    x1="40"
                    y1={y}
                    x2="580"
                    y2={y}
                    stroke="#e2e8f0"
                    strokeDasharray={val === 140 ? '4 2' : undefined}
                  />
                  <text x="8" y={y + 4} className="text-[10px] fill-slate-400 font-mono">
                    {val}
                  </text>
                </g>
              );
            })}

            {/* Score Polyline */}
            {completedWithScores.length > 1 && (
              <polyline
                fill="none"
                stroke="#4f46e5"
                strokeWidth="2.5"
                points={completedWithScores
                  .map((r, idx) => {
                    const score = r.summary?.overallScore ?? 0;
                    const x =
                      40 +
                      (idx / Math.max(1, completedWithScores.length - 1)) * 520;
                    const y = 160 - (Math.min(160, Math.max(0, score)) / 160) * 140;
                    return x + ',' + y;
                  })
                  .join(' ')}
              />
            )}

            {/* Data Points */}
            {completedWithScores.map((r, idx) => {
              const score = r.summary?.overallScore ?? 0;
              const x =
                completedWithScores.length === 1
                  ? 300
                  : 40 + (idx / (completedWithScores.length - 1)) * 520;
              const y = 160 - (Math.min(160, Math.max(0, score)) / 160) * 140;
              return (
                <g key={r.id}>
                  <circle
                    cx={x}
                    cy={y}
                    r="5"
                    className="fill-primary-600 stroke-white stroke-2 cursor-pointer"
                    onClick={() => setSelectedRun(r)}
                  />
                  <text
                    x={x}
                    y={y - 10}
                    textAnchor="middle"
                    className="text-[11px] font-bold fill-slate-700"
                  >
                    {score}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Runs List */}
      <div className="space-y-3">
        {runs.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">
            No practice sessions recorded yet. Start a session on the Exam page!
          </div>
        ) : (
          runs.map((run) => {
            const overall = run.summary?.overallScore;
            const isSelected = selectedRun?.id === run.id;
            const statusClass =
              run.status === 'completed'
                ? 'bg-green-100 text-green-800'
                : run.status === 'in-progress'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-600';

            return (
              <div
                key={run.id}
                className="bg-white border border-slate-200 rounded-xl p-4 transition-all"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-slate-900">{run.templateName}</h4>
                      <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + statusClass}>
                        {run.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {formatDate(run.startedAt)} • Duration: {formatTime(run.overallElapsedSec)} •{' '}
                      {run.blockConfigs.length} Blocks
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    {overall !== undefined && (
                      <div className="text-right mr-2">
                        <span className="text-xl font-black text-primary-600">{overall}</span>
                        <span className="text-xs text-slate-400"> / 160</span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedRun(isSelected ? null : run)}
                      className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100"
                    >
                      {isSelected ? 'Hide Details' : 'Inspect Responses & Audio'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteRun(run.id)}
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {isSelected && (
                  <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
                    {run.blockConfigs.map((b, i) => {
                      const resp = run.responses[b.id];
                      return (
                        <div key={b.id} className="bg-slate-50 rounded-xl p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-800">
                              {i + 1}. {b.name} ({b.type})
                            </span>
                            {resp?.aiOverallScore !== undefined && (
                              <span className="text-xs font-bold text-primary-700 bg-primary-100 px-2 py-0.5 rounded">
                                Score: {resp.aiOverallScore} / 160
                              </span>
                            )}
                          </div>

                          {resp?.audioBlobRef && (
                            <audio controls src={resp.audioBlobRef} className="w-full h-9" />
                          )}

                          <p className="text-xs text-slate-700 whitespace-pre-wrap bg-white p-3 rounded-lg border border-slate-200">
                            {resp?.textOrTranscript || '(No response recorded)'}
                          </p>

                          {resp?.aiFeedback?.suggestedFix && (
                            <p className="text-xs text-primary-800 bg-primary-50 p-2.5 rounded-lg border border-primary-200">
                              <strong>145+ Suggested Fix:</strong> {resp.aiFeedback.suggestedFix}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default HistoryPanel;
`,
};

// =========================================================================
// 15. WRITE ALL FILES TO DISK (Supports running from root or /frontend)
// =========================================================================
const cwd = process.cwd();
const isFrontendDir =
  fs.existsSync(path.join(cwd, 'src')) && fs.existsSync(path.join(cwd, 'package.json'));

for (const [relPath, content] of Object.entries(files)) {
  let targetPath;
  if (relPath.startsWith('stt-backend/')) {
    targetPath = isFrontendDir && !fs.existsSync(path.join(cwd, 'stt-backend'))
      ? path.join(cwd, '..', relPath)
      : path.join(cwd, relPath);
  } else {
    targetPath = isFrontendDir
      ? path.join(cwd, relPath)
      : fs.existsSync(path.join(cwd, 'frontend'))
      ? path.join(cwd, 'frontend', relPath)
      : path.join(cwd, relPath);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log('✓ Updated:', path.relative(cwd, targetPath));
}

console.log('\n✅ All DET Prep App upgrades applied successfully!');