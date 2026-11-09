// upgrade-phase1.mjs
// Run from project root: node upgrade-phase1.mjs
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. PYTHON BACKEND: Auto-load cuBLAS/cuDNN DLLs + Timestamped Segments
  // =========================================================================
  'stt-backend/app.py': `import os
import sys
import shutil

# Explicitly register PyTorch CUDA/cuDNN DLL directory on Windows for Python 3.8+
torch_lib_candidates = [
    os.path.join(os.path.dirname(__file__), "whisper-env", "Lib", "site-packages", "torch", "lib"),
    r"C:\\Users\\Golden Leaf\\OneDrive\\Documents\\projects\\Duolingo practice app\\stt-backend\\whisper-env\\Lib\\site-packages\\torch\\lib",
]
for dll_dir in torch_lib_candidates:
    if os.path.exists(dll_dir) and hasattr(os, "add_dll_directory"):
        try:
            os.add_dll_directory(dll_dir)
            os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")
            print(f"Registered CUDA DLL directory: {dll_dir}")
            break
        except Exception as e:
            print(f"Warning registering DLL dir {dll_dir}: {e}")

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading Faster-Whisper model...")
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
            word_timestamps=True,
            condition_on_previous_text=False,
            initial_prompt="Uh, um, like, so yeah, well, [cough], [silent]..."
        )
        
        total_duration = round(float(info.duration or 0.0), 1)
        print(f"\\nProcessing {total_duration:.1f} seconds of audio...")
        
        flat_parts = []
        timestamped_lines = []
        prev_end = 0.0
        
        for segment in segments:
            seg_text = segment.text.strip()
            if not seg_text:
                continue
            gap = segment.start - prev_end
            if prev_end > 0 and gap >= 1.0:
                timestamped_lines.append(f"[PAUSE {gap:.1f}s]")
            timestamped_lines.append(f"[{segment.start:.1f}s - {segment.end:.1f}s] {seg_text}")
            flat_parts.append(seg_text)
            prev_end = segment.end
            
            if total_duration > 0:
                progress = min(100.0, (segment.end / total_duration) * 100)
                print(f"[{progress:5.1f}%] [{segment.start:.1f}s -> {segment.end:.1f}s] {seg_text}")
                
        flat_text = " ".join(flat_parts).strip()
        timestamped_text = "\\n".join(timestamped_lines).strip()
        print("Transcription Complete!\\n")
        
        return {
            "text": flat_text,
            "timestampedText": timestamped_text,
            "duration": total_duration
        }
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
`,

  // =========================================================================
  // 2. TYPES: Add Shadowing, Dictogloss, Timestamps, Chunks & Pressure Mode
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
  | 'shadowing'
  | 'dictogloss'
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
  localSttEndpoint?: string;
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
  targetChunks?: string[];
  sourceAudioText?: string;
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
  timestampedTranscript?: string;
  audioDurationSec?: number;
  fragmentNotes?: string;
  attemptCount?: number;
  previousDraft?: string;
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
  communicativePressure?: boolean;
  preferredQuestionType?: DETQuestionType | 'all' | 'adaptive';
  startedAt: string;
  endedAt: string | null;
  responses: Record<string, BlockResponse>;
  summary?: SessionSummary;
}
`,

  // =========================================================================
  // 3. STT SERVICE: Return STTResult with timestampedText & durationSec
  // =========================================================================
  'src/services/stt.ts': `import type { STTProvider as STTProviderType } from '../types';

export interface STTResult {
  text: string;
  timestampedText?: string;
  durationSec?: number;
}

export interface STTProvider {
  transcribe(audioBlob: Blob, language?: string): Promise<STTResult>;
  isAvailable(): boolean;
}

const LOCAL_WHISPER_DEFAULT_URL = 'http://127.0.0.1:8000/transcribe';
const LOCAL_WHISPER_HEALTH_URL = 'http://127.0.0.1:8000/health';
const OPENAI_WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_BLOB_SIZE_BYTES = 24 * 1024 * 1024;

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

export class LocalWhisperSTTProvider implements STTProvider {
  private readonly endpointUrl: string;
  constructor(endpointUrl: string = LOCAL_WHISPER_DEFAULT_URL) {
    this.endpointUrl = endpointUrl || LOCAL_WHISPER_DEFAULT_URL;
  }
  isAvailable(): boolean {
    return true;
  }
  async transcribe(audioBlob: Blob): Promise<STTResult> {
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
    const data = (await response.json()) as {
      text?: string;
      timestampedText?: string;
      duration?: number;
    };
    if (typeof data.text !== 'string') {
      throw new Error('Local Whisper returned an unexpected JSON payload.');
    }
    return {
      text: data.text,
      timestampedText: data.timestampedText || data.text,
      durationSec: typeof data.duration === 'number' ? data.duration : undefined,
    };
  }
}

export class WhisperSTTProvider implements STTProvider {
  private readonly apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }
  async transcribe(audioBlob: Blob, language: string = 'en'): Promise<STTResult> {
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
    return { text: data.text ?? '' };
  }
}

export class WebSpeechSTTProvider implements STTProvider {
  isAvailable(): boolean {
    return (
      typeof window !== 'undefined' &&
      Boolean(
        (window as unknown as Record<string, unknown>).SpeechRecognition ||
          (window as unknown as Record<string, unknown>).webkitSpeechRecognition
      )
    );
  }
  async transcribe(_audioBlob: Blob): Promise<STTResult> {
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
  // 4. GEMINI SERVICE: Fast Fallback (3.5-flash-lite -> 3.8-flash -> 3.1-flash-lite)
  // =========================================================================
  'src/services/gemini.ts': `import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIFeedback } from '../types';

export type EvaluationResult = AIFeedback;

export interface EvaluateParams {
  apiKey: string;
  evalPromptTemplate: string;
  variables: Record<string, string>;
}

const FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
];
const RETRY_DELAY_MS = 1_500;
const REQUEST_TIMEOUT_MS = 30_000;

function interpolateTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let output = template.replace(/\\{\\{(\\w+)\\}\\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
  const studentText = vars.transcript || vars.response || '';
  if (studentText && !template.includes('{{response}}') && !template.includes('{{transcript}}')) {
    output += \`\\n\\n---\\nTask Prompt: \${vars.prompt ?? ''}\\nVerified Audio/Task Duration: \${vars.durationSec ?? 0} seconds\\nStudent Output:\\n\${studentText}\`;
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
  const maxRetriesPerModel = 1;

  for (const currentModel of FALLBACK_MODELS) {
    for (let attempt = 0; attempt <= maxRetriesPerModel; attempt++) {
      try {
        return await callGemini(apiKey, prompt, currentModel);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const msg = lastError.message.toLowerCase();

        // 1. Hard fail on invalid API key or permission errors
        if (msg.includes('api key') || msg.includes('permission') || msg.includes('forbidden')) {
          throw lastError;
        }

        // 2. Immediate zero-delay failover if model is 404/deprecated/unavailable/quota-exhausted
        if (
          msg.includes('404') ||
          msg.includes('not found') ||
          msg.includes('no longer available') ||
          msg.includes('invalid') ||
          msg.includes('429') ||
          msg.includes('quota')
        ) {
          console.warn(\`Model \${currentModel} unavailable or quota reached. Failing over immediately...\`);
          break;
        }

        // 3. Brief backoff on 503 high demand before trying next model
        if (attempt < maxRetriesPerModel) {
          const backoffMs = RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 400;
          console.warn(\`Model \${currentModel} busy (503). Retrying in \${Math.round(backoffMs)}ms...\`);
          await delay(backoffMs);
        }
      }
    }
  }

  throw new Error(\`Gemini evaluation failed across all models: \${lastError?.message ?? 'Unknown error'}\`);
}

async function callGemini(apiKey: string, prompt: string, modelName: string): Promise<AIFeedback> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
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
  // 5. ERROR LOG UTILITY: Aggregates recurring weaknesses across past sessions
  // =========================================================================
  'src/utils/errorLog.ts': `import type { SessionRun } from '../types';

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
        const key = text.toLowerCase().replace(/[^a-z0-9\\s]/g, '').slice(0, 48).trim();
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
`,

  // =========================================================================
  // 6. DATABASE: Timestamp-Aware Prompts, Chunk SRS Items & SLA Template
  // =========================================================================
  'src/db/database.ts': `import Dexie, { type Table } from 'dexie';
import type {
  Settings,
  QuestionBankItem,
  EvalPrompt,
  SessionTemplate,
  SessionRun,
} from '../types';

export const DEFAULT_WRITING_PROMPT = \`You are an expert Duolingo English Test (DET) evaluator. Grade the provided response against the official DET rubric, strictly calibrating for a target score band of 140-150 (C1/C2 graduate proficiency). Focus on syntactic complexity (subordination, embedded clauses), collocation accuracy, and cohesive transitions.

Task / Prompt: {{prompt}}
Verified Time Spent: {{durationSec}} seconds
Student Response:
{{response}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "grammar": "<concise grammar/clause critique>", "vocabulary": "<collocation/chunk assessment>", "coherence": "<transitions assessment>" },
  "strengths": ["<strength 1>", "<strength 2>"],
  "weaknesses": ["<specific recurring error 1>", "<specific error 2>"],
  "suggestions": ["<actionable fix 1>", "<actionable fix 2>"],
  "suggestedFix": "<A 150-band C1/C2 rewrite of the student's weakest sentences>"
}\`;

export const DEFAULT_SPEAKING_PROMPT = \`You are an expert Duolingo English Test (DET) speaking evaluator. Grade the verbatim timestamped speech transcript against the official DET rubric for a target score band of 140-150.

CRITICAL TIMING & TIMESTAMP INSTRUCTIONS:
1. The student's ACTUAL verified total audio recording duration is {{durationSec}} seconds (Speaking rate: {{wpm}} WPM, Fillers detected: {{fillerCount}}). NEVER claim the student spoke for less than {{durationSec}} seconds.
2. The transcript includes exact segment timestamps [start - end] and [PAUSE Xs] markers generated by Faster-Whisper. Use these timestamps to evaluate acoustic fluency, clause-boundary pacing, hesitation clusters ("uh", "um"), and mid-clause pauses.

Speaking Task / Prompt: {{prompt}}
Verified Total Recording Duration: {{durationSec}} seconds ({{wpm}} WPM, {{fillerCount}} fillers)
Timestamped Verbatim Transcript:
{{transcript}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "fluency": "<pace, [PAUSE] analysis & duration assessment>", "lexical_diversity": "<collocations & academic chunks>", "grammar": "<spoken syntactic complexity>" },
  "strengths": ["<strength 1>", "<strength 2>"],
  "weaknesses": ["<specific fluency/grammar gap 1>", "<specific gap 2>"],
  "suggestions": ["<specific tip 1>", "<specific tip 2>"],
  "suggestedFix": "<A polished 150-score spoken version incorporating high-level collocations>"
}\`;

export const DEFAULT_SHADOWING_PROMPT = \`You are an SLA speech prosody and shadowing evaluator. Compare the source native passage against the student's simultaneous shadowed transcript (recorded over {{durationSec}} seconds). Evaluate word retention, chunk automaticity, and hesitation markers.

Source Native Passage:
{{prompt}}

Student Shadowed Timestamped Transcript ({{durationSec}}s):
{{transcript}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "fluency": "<rhythm & pause synchronization>", "accuracy": "<dropped words or stumbled chunks>", "grammar": "<structural retention>" },
  "strengths": ["<strength 1>"],
  "weaknesses": ["<dropped or hesitated chunk>"],
  "suggestions": ["<motor-auditory shadowing drill tip>"],
  "suggestedFix": "<Key multi-word chunks from the source passage to drill aloud>"
}\`;

export const DEFAULT_DICTOGLOSS_PROMPT = \`You are an SLA Dictogloss working-memory and syntactic reconstruction evaluator. Grade how accurately the student reconstructed the core meaning of the source lecture passage using their own complex subordination and academic collocations (do NOT require verbatim word matching).

Original Lecture Passage:
{{prompt}}

Student Reconstructed Text (Time spent: {{durationSec}}s):
{{response}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "comprehension": "<retention of core thesis & causal links>", "grammar": "<subordination & clause embedding>", "vocabulary": "<academic collocations>" },
  "strengths": ["<strength 1>"],
  "weaknesses": ["<missing nuance or syntactic weakness>"],
  "suggestions": ["<note-taking compression or syntax tip>"],
  "suggestedFix": "<A 150-band C1/C2 reconstruction of the passage>"
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
      instantFeedbackDefault: true,
      srsDefaults: {
        startEase: 2.5,
        startIntervalDays: 1,
      },
    });

    const brainDumpEvalId = crypto.randomUUID();
    const vocabEvalId = crypto.randomUUID();
    const speakingEvalId = crypto.randomUUID();
    const shadowingEvalId = crypto.randomUUID();
    const dictoglossEvalId = crypto.randomUUID();
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
        name: 'DET Collocation Chunk & Writing Evaluator (140-150)',
        appliesToType: 'vocab-writing',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_WRITING_PROMPT,
      },
      {
        id: speakingEvalId,
        name: 'DET Timestamped Verbatim Speaking Evaluator (140-150)',
        appliesToType: 'speaking',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_SPEAKING_PROMPT,
      },
      {
        id: shadowingEvalId,
        name: 'SLA Shadowing Prosody Evaluator (140-150)',
        appliesToType: 'shadowing',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_SHADOWING_PROMPT,
      },
      {
        id: dictoglossEvalId,
        name: 'SLA Dictogloss Working-Memory Evaluator (140-150)',
        appliesToType: 'dictogloss',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_DICTOGLOSS_PROMPT,
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
        type: 'write-about-photo',
        prompt: 'Write an analytical paragraph on artificial intelligence in scientific research incorporating all 4 multi-word collocation chunks below.',
        targetChunks: [
          'rigorous empirical validation',
          'shift the research paradigm',
          'ubiquitous adoption of',
          'bear the consequences',
        ],
        sampleAnswer: 'In modern computer science, the ubiquitous adoption of machine learning has begun to shift the research paradigm, requiring rigorous empirical validation so institutions do not bear the consequences of unverified automated models.',
        difficulty: 'hard',
        tags: ['vocab', 'chunks', 'academic', 'graduate'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'writing',
        type: 'interactive-writing',
        prompt: 'Write a dense academic paragraph evaluating algorithmic governance and public policy using all 4 multi-word collocation chunks below.',
        targetChunks: [
          'as a consequence of',
          'mitigate the unintended risks',
          'regulatory frameworks must evolve',
          'exercising due diligence',
        ],
        sampleAnswer: 'As a consequence of rapid deployment in critical infrastructure, regulatory frameworks must evolve in tandem with algorithmic auditing, ensuring that engineering teams are exercising due diligence to mitigate the unintended risks of systemic bias.',
        difficulty: 'hard',
        tags: ['vocab', 'chunks', 'policy'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'read-aloud',
        prompt: 'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.',
        sourceAudioText: 'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.',
        difficulty: 'hard',
        tags: ['shadowing', 'prosody', 'cybersecurity'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'listening',
        type: 'listen-and-type',
        prompt: 'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.',
        sourceAudioText: 'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.',
        sampleAnswer: 'Transitioning to advanced language proficiency depends on producing formulaic word chunks automatically under time constraints rather than consciously piecing together individual words.',
        difficulty: 'hard',
        tags: ['dictogloss', 'cognitive-science', 'listening'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'speaking-sample',
        prompt: 'Speak for 90 seconds expanding on the trade-offs between automated AI code generation and software security assurance. Use smooth clause transitions and minimize filler words.',
        difficulty: 'hard',
        tags: ['writing-to-speaking', 'academic', 'fluency'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'interactive-speaking',
        prompt: 'Describe a complex technical system you architected or audited from scratch. How did you verify its reliability and handle edge-case failures? Speak for 90 seconds.',
        difficulty: 'hard',
        tags: ['engineering', 'personal-experience'],
      },
    ]);

    await this.sessionTemplates.bulkPut([
      {
        id: crypto.randomUUID(),
        name: 'SLA Deliberate Practice Protocol (140-150 C1/C2)',
        description: 'Arguelles Shadowing -> Dictogloss Reconstruction -> Collocation Chunk Writing -> Timed Verbatim Speaking.',
        blocks: [
          {
            id: crypto.randomUUID(),
            name: '1. Motor-Auditory Shadowing (Arguelles Method)',
            type: 'shadowing',
            durationSec: 3 * 60,
            instructions: 'Listen to the native academic passage and speak simultaneously (lagging by 0.5s) to train rhythm, prosody, and automaticity.',
            autoAdvance: false,
            evalPromptId: shadowingEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '2. Dictogloss Working-Memory Reconstruction',
            type: 'dictogloss',
            durationSec: 4 * 60,
            instructions: 'Listen to the passage while taking 2-4 word fragment notes, then reconstruct the core meaning using complex subordination.',
            autoAdvance: false,
            evalPromptId: dictoglossEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '3. Collocation Chunk Precision Writing (SRS)',
            type: 'vocab-writing',
            durationSec: 5 * 60,
            instructions: 'Write a cohesive C1/C2 academic paragraph incorporating all required multi-word collocation chunks.',
            autoAdvance: false,
            evalPromptId: vocabEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '4. Timed Verbatim Speaking & Noticing Loop',
            type: 'speaking',
            durationSec: 2 * 60,
            instructions: 'Speak for 90 seconds on the prompt. Review your timestamped pauses and immediately re-record to fix hesitations.',
            autoAdvance: false,
            evalPromptId: speakingEvalId,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        name: 'Writing-to-Speaking Flow (140-150 Target)',
        description: 'Structured 4-step cognitive transfer: Brain-Dump Outline -> Collocation Chunk Writing -> Verbatim Speaking -> Adaptive Mock.',
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
            name: '2. Active Collocation Chunk Writing',
            type: 'vocab-writing',
            durationSec: 5 * 60,
            instructions: 'Write a dense academic paragraph incorporating the due SRS multi-word collocation chunks.',
            autoAdvance: true,
            evalPromptId: vocabEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '3. Verbatim Speaking Expansion',
            type: 'speaking',
            durationSec: 2 * 60,
            instructions: 'Speak for 90 seconds expanding on your written outline without reading word-for-word.',
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
      },
    ]);
  }
}

export const db = new DETDatabase();

export async function ensureDatabaseUpgraded(): Promise<void> {
  const settings = await db.settings.get('app-settings');
  if (settings && (!settings.localWhisperUrl || settings.sttProvider === 'whisper')) {
    await db.settings.put({
      ...settings,
      sttProvider: settings.sttApiKey ? settings.sttProvider : 'local-whisper',
      localWhisperUrl: settings.localWhisperUrl || 'http://127.0.0.1:8000/transcribe',
    });
  }

  // Upgrade existing speaking/writing prompts to timestamp-aware versions
  const prompts = await db.evalPrompts.toArray();
  for (const ep of prompts) {
    if (ep.appliesToType === 'speaking' && !ep.promptText.includes('CRITICAL TIMING')) {
      await db.evalPrompts.put({ ...ep, promptText: DEFAULT_SPEAKING_PROMPT });
    } else if (
      (ep.appliesToType === 'vocab-writing' || ep.appliesToType === 'brain-dump') &&
      !ep.promptText.includes('Verified Time Spent')
    ) {
      await db.evalPrompts.put({ ...ep, promptText: DEFAULT_WRITING_PROMPT });
    }
  }

  let shadowingEvalId = prompts.find((p) => p.appliesToType === 'shadowing')?.id;
  if (!shadowingEvalId) {
    shadowingEvalId = crypto.randomUUID();
    await db.evalPrompts.put({
      id: shadowingEvalId,
      name: 'SLA Shadowing Prosody Evaluator (140-150)',
      appliesToType: 'shadowing',
      scoreScale: 'det-0-160',
      promptText: DEFAULT_SHADOWING_PROMPT,
    });
  }

  let dictoglossEvalId = prompts.find((p) => p.appliesToType === 'dictogloss')?.id;
  if (!dictoglossEvalId) {
    dictoglossEvalId = crypto.randomUUID();
    await db.evalPrompts.put({
      id: dictoglossEvalId,
      name: 'SLA Dictogloss Working-Memory Evaluator (140-150)',
      appliesToType: 'dictogloss',
      scoreScale: 'det-0-160',
      promptText: DEFAULT_DICTOGLOSS_PROMPT,
    });
  }

  // Ensure chunk-based questions exist in questionBank
  const questions = await db.questionBank.toArray();
  const hasChunks = questions.some((q) => q.targetChunks && q.targetChunks.length > 0);
  if (!hasChunks) {
    await db.questionBank.bulkPut([
      {
        id: crypto.randomUUID(),
        skill: 'writing',
        type: 'write-about-photo',
        prompt: 'Write an analytical paragraph on artificial intelligence in scientific research incorporating all 4 multi-word collocation chunks below.',
        targetChunks: [
          'rigorous empirical validation',
          'shift the research paradigm',
          'ubiquitous adoption of',
          'bear the consequences',
        ],
        sampleAnswer: 'In modern computer science, the ubiquitous adoption of machine learning has begun to shift the research paradigm, requiring rigorous empirical validation so institutions do not bear the consequences of unverified automated models.',
        difficulty: 'hard',
        tags: ['vocab', 'chunks', 'academic'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'speaking',
        type: 'read-aloud',
        prompt: 'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.',
        sourceAudioText: 'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.',
        difficulty: 'hard',
        tags: ['shadowing', 'prosody', 'cybersecurity'],
      },
      {
        id: crypto.randomUUID(),
        skill: 'listening',
        type: 'listen-and-type',
        prompt: 'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.',
        sourceAudioText: 'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.',
        sampleAnswer: 'Transitioning to advanced language proficiency depends on producing formulaic word chunks automatically under time constraints rather than consciously piecing together individual words.',
        difficulty: 'hard',
        tags: ['dictogloss', 'cognitive-science', 'listening'],
      },
    ]);
  }

  // Ensure SLA Deliberate Practice Template exists
  const templates = await db.sessionTemplates.toArray();
  const hasSlaTemplate = templates.some((t) => t.name.includes('SLA Deliberate Practice'));
  if (!hasSlaTemplate) {
    const vocabEvalId = prompts.find((p) => p.appliesToType === 'vocab-writing')?.id ?? crypto.randomUUID();
    const speakingEvalId = prompts.find((p) => p.appliesToType === 'speaking')?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    await db.sessionTemplates.put({
      id: crypto.randomUUID(),
      name: 'SLA Deliberate Practice Protocol (140-150 C1/C2)',
      description: 'Arguelles Shadowing -> Dictogloss Reconstruction -> Collocation Chunk Writing -> Timed Verbatim Speaking.',
      blocks: [
        {
          id: crypto.randomUUID(),
          name: '1. Motor-Auditory Shadowing (Arguelles Method)',
          type: 'shadowing',
          durationSec: 3 * 60,
          instructions: 'Listen to the native academic passage and speak simultaneously (lagging by 0.5s) to train rhythm, prosody, and automaticity.',
          autoAdvance: false,
          evalPromptId: shadowingEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: '2. Dictogloss Working-Memory Reconstruction',
          type: 'dictogloss',
          durationSec: 4 * 60,
          instructions: 'Listen to the passage while taking 2-4 word fragment notes, then reconstruct the core meaning using complex subordination.',
          autoAdvance: false,
          evalPromptId: dictoglossEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: '3. Collocation Chunk Precision Writing (SRS)',
          type: 'vocab-writing',
          durationSec: 5 * 60,
          instructions: 'Write a cohesive C1/C2 academic paragraph incorporating all required multi-word collocation chunks.',
          autoAdvance: false,
          evalPromptId: vocabEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: '4. Timed Verbatim Speaking & Noticing Loop',
          type: 'speaking',
          durationSec: 2 * 60,
          instructions: 'Speak for 90 seconds on the prompt. Review your timestamped pauses and immediately re-record to fix hesitations.',
          autoAdvance: false,
          evalPromptId: speakingEvalId,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
  }
}
`,

  // =========================================================================
  // 7. SESSION STORE: Add communicativePressure & resetBlockForRewrite
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
  communicativePressure?: boolean;
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
  resetBlockForRewrite: (blockId: string) => void;
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
    attemptCount: 1,
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
        attemptCount: 1,
      };
      set({
        draftResponses: {
          ...get().draftResponses,
          [blockId]: { ...existing, ...patch },
        },
      });
      void get().persistToDb();
    },

    resetBlockForRewrite: (blockId) => {
      const state = get();
      const existing = state.draftResponses[blockId];
      if (!existing) return;
      const nextAttempt = (existing.attemptCount ?? 1) + 1;
      set({
        blockElapsedSec: 0,
        isPaused: false,
        draftResponses: {
          ...state.draftResponses,
          [blockId]: {
            ...existing,
            previousDraft: existing.textOrTranscript || existing.previousDraft,
            textOrTranscript: '',
            timestampedTranscript: undefined,
            audioBlobRef: undefined,
            audioDurationSec: undefined,
            wpm: undefined,
            fillerCount: undefined,
            isComplete: false,
            timeSpentSec: 0,
            attemptCount: nextAttempt,
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
};

const cwd = process.cwd();
for (const [relPath, content] of Object.entries(files)) {
  const targetPath = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log('Phase 1 Updated:', path.relative(cwd, targetPath));
}
console.log('\nPhase 1 (Backend, Fast Fallback, Timestamps & Database) applied successfully!');