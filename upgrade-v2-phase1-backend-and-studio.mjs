// upgrade-v2-phase1-backend-and-studio.mjs
// Run from project root: node upgrade-v2-phase1-backend-and-studio.mjs
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. PYTHON BACKEND: /clips Static Mount (Fixes 405 Method Not Allowed)
  // =========================================================================
  'stt-backend/app.py': `import os
import sys
import json
import uuid
import shutil
import subprocess
from typing import Optional

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

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from faster_whisper import WhisperModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(BASE_DIR, "audio_clips")
MANIFEST_PATH = os.path.join(AUDIO_DIR, "curated_manifest.json")
os.makedirs(AUDIO_DIR, exist_ok=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mounted at /clips (not /audio) to avoid intercepting OPTIONS preflight
# on POST /audio/upload and POST /audio/youtube
app.mount("/clips", StaticFiles(directory=AUDIO_DIR), name="clips")

print("Loading Faster-Whisper model...")
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8_float16")
print("Model loaded successfully!")

def normalize_clip_url(url: str, filename: str) -> str:
    if filename:
        return f"http://127.0.0.1:8000/clips/{filename}"
    return url.replace("http://127.0.0.1:8000/audio/", "http://127.0.0.1:8000/clips/")

def load_manifest() -> dict:
    if os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                raw = json.load(f)
                for k, v in raw.items():
                    if isinstance(v, dict):
                        fname = v.get("filename", "")
                        v["audioUrl"] = normalize_clip_url(v.get("audioUrl", ""), fname)
                return raw
        except Exception:
            return {}
    return {}

def save_manifest(data: dict):
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def run_whisper_on_file(filepath: str, verbatim_prompt: bool = True):
    prompt_str = "Uh, um, like, so yeah, well, [cough], [silent]..." if verbatim_prompt else None
    segments, info = model.transcribe(
        filepath,
        beam_size=5,
        word_timestamps=True,
        condition_on_previous_text=False,
        initial_prompt=prompt_str
    )
    total_duration = round(float(info.duration or 0.0), 1)
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

    return {
        "text": " ".join(flat_parts).strip(),
        "timestampedText": "\\n".join(timestamped_lines).strip(),
        "duration": total_duration,
    }

@app.get("/health")
async def health_check():
    return {"status": "ok", "model": "large-v3-turbo", "device": "cuda"}

@app.get("/audio/manifest")
async def get_audio_manifest():
    manifest = load_manifest()
    valid = {}
    for k, v in manifest.items():
        fname = v.get("filename", "")
        if fname and os.path.exists(os.path.join(AUDIO_DIR, fname)):
            v["audioUrl"] = f"http://127.0.0.1:8000/clips/{fname}"
            valid[k] = v
    return valid

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    temp_file = os.path.join(BASE_DIR, f"temp_{uuid.uuid4().hex}_{file.filename}")
    try:
        with open(temp_file, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        return run_whisper_on_file(temp_file, verbatim_prompt=True)
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)

@app.post("/audio/upload")
async def upload_human_audio(
    file: UploadFile = File(...),
    auto_transcribe: bool = Form(True)
):
    ext = os.path.splitext(file.filename or "clip.mp3")[1].lower() or ".mp3"
    safe_name = f"human_{uuid.uuid4().hex[:10]}{ext}"
    dest_path = os.path.join(AUDIO_DIR, safe_name)

    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    transcript_data = {"text": "", "timestampedText": "", "duration": 0.0}
    if auto_transcribe:
        transcript_data = run_whisper_on_file(dest_path, verbatim_prompt=False)

    return {
        "audioUrl": f"http://127.0.0.1:8000/clips/{safe_name}",
        "filename": safe_name,
        "text": transcript_data["text"],
        "timestampedText": transcript_data["timestampedText"],
        "duration": transcript_data["duration"],
    }

class YoutubeClipRequest(BaseModel):
    url: str
    startTime: Optional[str] = "00:20"
    endTime: Optional[str] = "01:35"
    clipKey: Optional[str] = None

@app.post("/audio/youtube")
async def import_youtube_clip(req: YoutubeClipRequest):
    manifest = load_manifest()
    if req.clipKey and req.clipKey in manifest:
        cached = manifest[req.clipKey]
        cached_fname = cached.get("filename", "")
        cached_path = os.path.join(AUDIO_DIR, cached_fname)
        if cached_fname and os.path.exists(cached_path):
            cached["audioUrl"] = f"http://127.0.0.1:8000/clips/{cached_fname}"
            return cached

    clip_id = req.clipKey if req.clipKey else f"yt_{uuid.uuid4().hex[:10]}"
    output_template = os.path.join(AUDIO_DIR, f"{clip_id}.%(ext)s")
    final_mp3 = os.path.join(AUDIO_DIR, f"{clip_id}.mp3")

    section_arg = f"*{req.startTime}-{req.endTime}" if req.startTime and req.endTime else "*00:20-01:35"
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-x", "--audio-format", "mp3",
        "--audio-quality", "128K",
        "--download-sections", section_arg,
        "--force-keyframes-at-cuts",
        "-o", output_template,
        req.url
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        if proc.returncode != 0:
            raise HTTPException(
                status_code=400,
                detail=f"yt-dlp error: {proc.stderr.strip() or proc.stdout.strip()}. Make sure yt-dlp and ffmpeg are installed."
            )
    except FileNotFoundError:
        raise HTTPException(status_code=400, detail="yt-dlp not found. Run: pip install -U yt-dlp")

    saved_file = final_mp3
    if not os.path.exists(saved_file):
        matches = [f for f in os.listdir(AUDIO_DIR) if f.startswith(clip_id)]
        if not matches:
            raise HTTPException(status_code=500, detail="Audio file was not generated by yt-dlp.")
        saved_file = os.path.join(AUDIO_DIR, matches[0])

    transcript_data = run_whisper_on_file(saved_file, verbatim_prompt=False)
    filename = os.path.basename(saved_file)

    result_payload = {
        "audioUrl": f"http://127.0.0.1:8000/clips/{filename}",
        "filename": filename,
        "text": transcript_data["text"],
        "timestampedText": transcript_data["timestampedText"],
        "duration": transcript_data["duration"],
    }

    if req.clipKey:
        manifest[req.clipKey] = result_payload
        save_manifest(manifest)

    return result_payload

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
`,

  // =========================================================================
  // 2. TYPES: Add Per-Block Power Controls for the Session Builder
  // =========================================================================
  'src/types/index.ts': `export type DETSkill = 'reading' | 'writing' | 'speaking' | 'listening';

export type DETQuestionType =
  | 'interactive-reading'
  | 'read-and-complete'
  | 'read-aloud'
  | 'write-about-photo'
  | 'listen-and-type'
  | 'interactive-writing'
  | 'interactive-speaking'
  | 'speaking-sample';

export type BlockType =
  | 'interactive-reading'
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

export interface ClozeBlankItem {
  id: string;
  options: string[];
  correctAnswer: string;
}

export interface InteractiveReadingData {
  sourceName: string;
  paragraph1WithBlanks: string;
  paragraph1Sentences: string[];
  blanks: ClozeBlankItem[];
  passageGapOptions: string[];
  correctPassageGap: string;
  paragraph2Sentences: string[];
  highlightQuestion1: string;
  correctHighlight1: string;
  highlightQuestion2: string;
  correctHighlight2: string;
  mainIdeaOptions: string[];
  correctMainIdea: string;
  titleOptions: string[];
  correctTitle: string;
}

export interface ReadAndCompleteBlank {
  id: string;
  prefix: string;
  missingSuffix: string;
  fullWord: string;
}

export interface ReadAndCompleteData {
  sourceName: string;
  title: string;
  passageWithBlanks: string;
  blanks: ReadAndCompleteBlank[];
}

export interface YoutubeAudioSource {
  clipKey: string;
  url: string;
  startTime: string;
  endTime: string;
  speaker: string;
}

export interface QuestionBankItem {
  id: string;
  skill: DETSkill;
  type: DETQuestionType;
  prompt: string;
  sampleAnswer?: string;
  sourceAttribution?: string;
  targetChunks?: string[];
  sourceAudioText?: string;
  audioUrl?: string;
  youtubeSource?: YoutubeAudioSource;
  interactiveReading?: InteractiveReadingData;
  readAndComplete?: ReadAndCompleteData;
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
  blindShadowing?: boolean;
  speechSpeed?: number;
  communicativePressure?: boolean;
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
  // 3. QUESTION BANK EDITOR: Bulk YouTube & CSV Queue Downloader Studio
  // =========================================================================
  'src/components/config/QuestionBankEditor.tsx': `import { useState, useEffect, useRef } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { db, ensureDatabaseUpgraded } from '../../db/database';
import type {
  QuestionBankItem,
  DETSkill,
  DETQuestionType,
  ReadAndCompleteData,
  ReadAndCompleteBlank,
} from '../../types';
import { generateId } from '../../utils/helpers';

const BACKEND_BASE = 'http://127.0.0.1:8000';

interface BulkYoutubeQueueItem {
  id: string;
  url: string;
  startTime: string;
  endTime: string;
  speaker: string;
  targetMode: 'shadowing' | 'dictogloss';
  existingQuestionId?: string;
  clipKey?: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  message?: string;
  audioUrl?: string;
}

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

function readAndCompleteToBracketText(rc?: ReadAndCompleteData): string {
  if (!rc) return '';
  return rc.passageWithBlanks.replace(/\\{\\{(\\d+)\\}\\}/g, (match, id) => {
    const b = rc.blanks.find((item) => item.id === id);
    if (!b) return match;
    return \`\${b.prefix}[\${b.missingSuffix}]\`;
  });
}

function parseBracketTextToReadAndComplete(
  bracketText: string,
  title: string,
  sourceName: string
): ReadAndCompleteData {
  const blanks: ReadAndCompleteBlank[] = [];
  let counter = 0;
  const passageWithBlanks = bracketText.replace(
    /([a-zA-Z]+)\\[([a-zA-Z]+)\\]/g,
    (_fullMatch, prefix: string, suffix: string) => {
      counter += 1;
      const id = String(counter);
      blanks.push({
        id,
        prefix,
        missingSuffix: suffix,
        fullWord: prefix + suffix,
      });
      return \`{{\${id}}}\`;
    }
  );
  return {
    title: title || 'Custom Read and Complete Passage',
    sourceName: sourceName || 'Custom Academic Source',
    passageWithBlanks,
    blanks,
  };
}

function autoBracketPlainParagraph(plainText: string): string {
  const clean = plainText.replace(/([a-zA-Z]+)\\[([a-zA-Z]+)\\]/g, '$1$2');
  const tokens = clean.split(/(\\s+)/);
  let wordCounter = 0;
  let blanksCreated = 0;

  return tokens
    .map((tok) => {
      const match = tok.match(/^([a-zA-Z]{5,})([.,;!?]?)$/);
      if (!match) return tok;
      wordCounter += 1;
      if (wordCounter % 5 === 0 && blanksCreated < 12) {
        const word = match[1];
        const punct = match[2] ?? '';
        const keepLen = Math.max(2, Math.floor(word.length / 2));
        const prefix = word.slice(0, keepLen);
        const suffix = word.slice(keepLen);
        blanksCreated += 1;
        return \`\${prefix}[\${suffix}]\${punct}\`;
      }
      return tok;
    })
    .join('');
}

/**
 * Parses pasted multi-line text or CSV content into queue items.
 * Supported formats per line:
 * 1) Just a URL: https://www.youtube.com/watch?v=...
 * 2) CSV: url, startTime, endTime, speaker/title, mode(shadowing|dictogloss)
 */
function parseBulkInputToQueueItems(rawText: string): BulkYoutubeQueueItem[] {
  const lines = rawText
    .split(/\\r?\\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  const results: BulkYoutubeQueueItem[] = [];

  for (const line of lines) {
    // Skip CSV header row if present
    if (/^url\\s*,/i.test(line)) continue;

    const cols = line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
    const url = cols[0] ?? '';
    if (!url.startsWith('http')) continue;

    const timeRegex = /^\\d{1,2}:\\d{2}(:\\d{2})?$/;
    const startTime = cols[1] && timeRegex.test(cols[1]) ? cols[1] : '00:20';
    const endTime = cols[2] && timeRegex.test(cols[2]) ? cols[2] : '01:35';
    const speaker =
      cols[3] && !timeRegex.test(cols[3])
        ? cols[3]
        : cols[1] && !timeRegex.test(cols[1])
        ? cols[1]
        : \`YouTube Clip (\${startTime}-\${endTime})\`;
    const rawMode = (cols[4] ?? '').toLowerCase();
    const targetMode: 'shadowing' | 'dictogloss' =
      rawMode.includes('dicto') || rawMode.includes('listen') ? 'dictogloss' : 'shadowing';

    results.push({
      id: generateId(),
      url,
      startTime,
      endTime,
      speaker,
      targetMode,
      status: 'queued',
    });
  }

  return results;
}

export function QuestionBankEditor() {
  const questions = useConfigStore((s) => s.questions);
  const loadQuestions = useConfigStore((s) => s.loadQuestions);
  const saveQuestion = useConfigStore((s) => s.saveQuestion);
  const deleteQuestion = useConfigStore((s) => s.deleteQuestion);

  const [filterSkill, setFilterSkill] = useState<DETSkill | 'all'>('all');
  const [editingQuestion, setEditingQuestion] = useState<QuestionBankItem | null>(null);
  const [chunksInput, setChunksInput] = useState<string>('');
  const [tagsInput, setTagsInput] = useState<string>('');

  const [rcTitle, setRcTitle] = useState('');
  const [rcSource, setRcSource] = useState('');
  const [rcBracketText, setRcBracketText] = useState('');

  // Bulk YouTube & CSV Queue Studio state
  const [showBulkStudio, setShowBulkStudio] = useState<boolean>(true);
  const [bulkRawText, setBulkRawText] = useState<string>('');
  const [queueItems, setQueueItems] = useState<BulkYoutubeQueueItem[]>([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState<boolean>(false);
  const stopQueueRef = useRef<boolean>(false);

  // Single question editor audio states
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [ytStart, setYtStart] = useState('00:20');
  const [ytEnd, setYtEnd] = useState('01:35');
  const [audioStatus, setAudioStatus] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  useEffect(() => {
    void ensureDatabaseUpgraded().then(async () => {
      // Also normalize any legacy /audio/ URLs stored in IndexedDB to /clips/
      const all = await db.questionBank.toArray();
      for (const q of all) {
        if (q.audioUrl && q.audioUrl.includes('/audio/')) {
          await db.questionBank.put({
            ...q,
            audioUrl: normalizeAudioUrl(q.audioUrl),
          });
        }
      }
      await loadQuestions();
    });
  }, [loadQuestions]);

  const skills: { value: DETSkill; label: string }[] = [
    { value: 'reading', label: '📖 Reading (Read & Complete / Interactive)' },
    { value: 'writing', label: '✍️ Writing & Chunks' },
    { value: 'speaking', label: '🗣️ Speaking & Shadowing' },
    { value: 'listening', label: '🎧 Listening & Dictogloss' },
  ];

  const questionTypes: { value: DETQuestionType; label: string; skill: DETSkill }[] = [
    { value: 'read-and-complete', label: 'Read and Complete (Prefix Letter Boxes)', skill: 'reading' },
    { value: 'interactive-reading', label: 'Interactive Reading (6-Step Suite)', skill: 'reading' },
    { value: 'read-aloud', label: 'Read Aloud / Arguelles Shadowing', skill: 'speaking' },
    { value: 'listen-and-type', label: 'Listen & Type / Dictogloss', skill: 'listening' },
    { value: 'write-about-photo', label: 'Collocation Chunk Writing', skill: 'writing' },
    { value: 'interactive-writing', label: 'Interactive Writing', skill: 'writing' },
    { value: 'interactive-speaking', label: 'Interactive Speaking', skill: 'speaking' },
    { value: 'speaking-sample', label: 'Speaking Sample', skill: 'speaking' },
  ];

  const filtered =
    filterSkill === 'all' ? questions : questions.filter((q) => q.skill === filterSkill);

  // =========================================================================
  // BULK YOUTUBE & CSV QUEUE HANDLERS
  // =========================================================================
  const handleParseTextToQueue = () => {
    const parsed = parseBulkInputToQueueItems(bulkRawText);
    if (parsed.length === 0) return;
    setQueueItems((prev) => [...prev, ...parsed]);
    setBulkRawText('');
  };

  const handleCsvFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseBulkInputToQueueItems(text);
    if (parsed.length > 0) {
      setQueueItems((prev) => [...prev, ...parsed]);
    }
    e.target.value = '';
  };

  const handleLoadCuratedSixIntoQueue = () => {
    const curatedQuestions = questions.filter((q) => q.youtubeSource);
    const existingUrls = new Set(queueItems.map((item) => item.url));
    const toAdd: BulkYoutubeQueueItem[] = [];

    for (const q of curatedQuestions) {
      if (!q.youtubeSource || existingUrls.has(q.youtubeSource.url)) continue;
      toAdd.push({
        id: generateId(),
        url: q.youtubeSource.url,
        startTime: q.youtubeSource.startTime || '00:20',
        endTime: q.youtubeSource.endTime || '01:35',
        speaker: q.youtubeSource.speaker || q.sourceAttribution || 'Curated Talk',
        targetMode: q.skill === 'listening' ? 'dictogloss' : 'shadowing',
        existingQuestionId: q.id,
        clipKey: q.youtubeSource.clipKey,
        status: q.audioUrl ? 'done' : 'queued',
        audioUrl: normalizeAudioUrl(q.audioUrl),
        message: q.audioUrl ? 'Already downloaded on disk' : 'Ready in queue',
      });
    }
    setQueueItems((prev) => [...prev, ...toAdd]);
  };

  const handleAddBlankRow = () => {
    setQueueItems((prev) => [
      ...prev,
      {
        id: generateId(),
        url: '',
        startTime: '00:20',
        endTime: '01:35',
        speaker: 'Custom Academic Speaker',
        targetMode: 'shadowing',
        status: 'queued',
      },
    ]);
  };

  const handleDownloadSampleCsv = () => {
    const sample = [
      'url,startTime,endTime,speaker,mode',
      'https://www.youtube.com/watch?v=RKK7wGAYP6k,00:20,01:35,Prof. Lera Boroditsky - TED,shadowing',
      'https://www.youtube.com/watch?v=LNHBMFCzznE,00:30,01:45,Dr. Lara Boyd - Neuroplasticity,shadowing',
      'https://www.youtube.com/watch?v=eIho2S0ZahI,00:20,01:35,Julian Treasure - Prosody,dictogloss',
    ].join('\\n');
    const blob = new Blob([sample], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'youtube_shadowing_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateQueueRow = (id: string, patch: Partial<BulkYoutubeQueueItem>) => {
    setQueueItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const removeQueueRow = (id: string) => {
    setQueueItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleRunQueueSequentially = async () => {
    if (isProcessingQueue) return;
    setIsProcessingQueue(true);
    stopQueueRef.current = false;

    for (const item of queueItems) {
      if (stopQueueRef.current) break;
      if (item.status === 'done' || !item.url.trim().startsWith('http')) continue;

      updateQueueRow(item.id, {
        status: 'processing',
        message: 'Downloading slice via yt-dlp & transcribing on GPU...',
      });

      const clipKey = item.clipKey || \`yt_\${item.id.slice(0, 8)}\`;
      try {
        const res = await fetch(\`\${BACKEND_BASE}/audio/youtube\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: item.url.trim(),
            startTime: item.startTime.trim() || '00:20',
            endTime: item.endTime.trim() || '01:35',
            clipKey,
          }),
        });

        if (!res.ok) {
          const errObj = await res.json().catch(() => ({ detail: \`HTTP \${res.status}\` }));
          throw new Error(errObj.detail || \`Server returned \${res.status}\`);
        }

        const data = (await res.json()) as {
          audioUrl: string;
          text: string;
          duration: number;
        };

        const normalizedUrl = normalizeAudioUrl(data.audioUrl);
        const targetQuestionId = item.existingQuestionId || \`yt-custom-\${item.id.slice(0, 8)}\`;
        const existingQ = questions.find((q) => q.id === targetQuestionId);

        const newOrUpdatedQuestion: QuestionBankItem = existingQ
          ? {
              ...existingQ,
              audioUrl: normalizedUrl,
              sourceAudioText: data.text || existingQ.sourceAudioText,
              prompt: data.text || existingQ.prompt,
              sourceAttribution: item.speaker || existingQ.sourceAttribution,
            }
          : {
              id: targetQuestionId,
              skill: item.targetMode === 'dictogloss' ? 'listening' : 'speaking',
              type: item.targetMode === 'dictogloss' ? 'listen-and-type' : 'read-aloud',
              sourceAttribution: item.speaker || 'YouTube Human Audio',
              prompt:
                data.text ||
                \`[\${item.speaker}] Audio Clip (\${item.startTime} - \${item.endTime})\`,
              sourceAudioText: data.text,
              audioUrl: normalizedUrl,
              youtubeSource: {
                clipKey,
                url: item.url.trim(),
                startTime: item.startTime.trim() || '00:20',
                endTime: item.endTime.trim() || '01:35',
                speaker: item.speaker || 'YouTube Speaker',
              },
              difficulty: 'hard',
              tags: [
                item.targetMode === 'dictogloss' ? 'dictogloss' : 'shadowing',
                'youtube',
                'human-audio',
              ],
            };

        await saveQuestion(newOrUpdatedQuestion);
        updateQueueRow(item.id, {
          status: 'done',
          audioUrl: normalizedUrl,
          message: \`✓ Saved (\${data.duration}s) — "\${(data.text || '').slice(0, 65)}..."\`,
        });
      } catch (err) {
        updateQueueRow(item.id, {
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to connect to stt-backend on port 8000',
        });
      }
    }

    setIsProcessingQueue(false);
  };

  // =========================================================================
  // SINGLE QUESTION MODAL HANDLERS
  // =========================================================================
  const openEditor = (q: QuestionBankItem) => {
    setEditingQuestion({ ...q, audioUrl: normalizeAudioUrl(q.audioUrl) });
    setChunksInput((q.targetChunks ?? []).join(', '));
    setTagsInput((q.tags ?? []).join(', '));
    setRcTitle(q.readAndComplete?.title ?? q.prompt ?? '');
    setRcSource(
      q.readAndComplete?.sourceName ??
        q.sourceAttribution ??
        'BBC Science Focus / The Conversation'
    );
    setRcBracketText(readAndCompleteToBracketText(q.readAndComplete));
    setYtUrl(q.youtubeSource?.url ?? '');
    setYtStart(q.youtubeSource?.startTime ?? '00:20');
    setYtEnd(q.youtubeSource?.endTime ?? '01:35');
    setAudioStatus(null);
    setAudioError(null);
  };

  const handleNewReadAndComplete = () => {
    openEditor({
      id: generateId(),
      skill: 'reading',
      type: 'read-and-complete',
      prompt: 'Read and Complete: Custom Academic Passage',
      sourceAttribution: 'BBC Science Focus / The Conversation',
      difficulty: 'hard',
      tags: ['read-and-complete', 'custom'],
      readAndComplete: {
        title: 'Custom Academic Passage',
        sourceName: 'BBC Science Focus',
        passageWithBlanks:
          'Paste any paragraph below and put [brackets] around the second half of words like {{1}} or click Auto-Convert!',
        blanks: [
          { id: '1', prefix: 'neuro', missingSuffix: 'science', fullWord: 'neuroscience' },
        ],
      },
    });
  };

  const handleNewGeneral = () => {
    openEditor({
      id: generateId(),
      skill: filterSkill === 'all' ? 'speaking' : filterSkill,
      type: filterSkill === 'reading' ? 'read-and-complete' : 'read-aloud',
      prompt: '',
      sourceAudioText: '',
      audioUrl: '',
      targetChunks: [],
      difficulty: 'hard',
      tags: ['custom'],
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editingQuestion) return;
    setUploadingAudio(true);
    setAudioError(null);
    setAudioStatus('Uploading human audio & auto-transcribing with Faster-Whisper...');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('auto_transcribe', 'true');

      const res = await fetch(\`\${BACKEND_BASE}/audio/upload\`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Upload failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
        duration: number;
      };

      const cleanUrl = normalizeAudioUrl(data.audioUrl);
      setEditingQuestion({
        ...editingQuestion,
        audioUrl: cleanUrl,
        sourceAudioText: data.text || editingQuestion.sourceAudioText,
        prompt: editingQuestion.prompt || data.text,
      });
      setAudioStatus(\`✓ Human audio attached (\${data.duration}s) & transcribed by Faster-Whisper!\`);
    } catch (err) {
      setAudioError(
        err instanceof Error
          ? err.message
          : 'Could not connect to stt-backend on port 8000.'
      );
      setAudioStatus(null);
    } finally {
      setUploadingAudio(false);
    }
  };

  const handleYoutubeImport = async () => {
    if (!ytUrl.trim() || !editingQuestion) return;
    setUploadingAudio(true);
    setAudioError(null);
    setAudioStatus(\`Extracting clip (\${ytStart} - \${ytEnd}) via yt-dlp & transcribing with Whisper...\`);

    try {
      const res = await fetch(\`\${BACKEND_BASE}/audio/youtube\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ytUrl.trim(),
          startTime: ytStart.trim(),
          endTime: ytEnd.trim(),
          clipKey: editingQuestion.youtubeSource?.clipKey,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'yt-dlp import failed' }));
        throw new Error(errData.detail || 'yt-dlp import failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
        duration: number;
      };

      const cleanUrl = normalizeAudioUrl(data.audioUrl);
      setEditingQuestion({
        ...editingQuestion,
        audioUrl: cleanUrl,
        sourceAudioText: data.text || editingQuestion.sourceAudioText,
        prompt: editingQuestion.prompt || data.text,
      });
      setAudioStatus(\`✓ Imported \${data.duration}s human audio clip & auto-transcribed!\`);
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : 'YouTube import failed');
      setAudioStatus(null);
    } finally {
      setUploadingAudio(false);
    }
  };

  const handleSave = async () => {
    if (!editingQuestion) return;
    const parsedChunks = chunksInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const parsedTags = tagsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let updatedReadAndComplete = editingQuestion.readAndComplete;
    let updatedPrompt = editingQuestion.prompt;

    if (editingQuestion.type === 'read-and-complete') {
      updatedReadAndComplete = parseBracketTextToReadAndComplete(
        rcBracketText,
        rcTitle,
        rcSource
      );
      updatedPrompt = \`Read and Complete: \${rcTitle} (\${rcSource})\`;
    }

    await saveQuestion({
      ...editingQuestion,
      audioUrl: normalizeAudioUrl(editingQuestion.audioUrl),
      prompt: updatedPrompt,
      sourceAttribution: rcSource || editingQuestion.sourceAttribution,
      readAndComplete: updatedReadAndComplete,
      targetChunks: parsedChunks.length > 0 ? parsedChunks : undefined,
      tags: parsedTags,
    });
    setEditingQuestion(null);
  };

  const previewParsedRc =
    editingQuestion?.type === 'read-and-complete'
      ? parseBracketTextToReadAndComplete(rcBracketText, rcTitle, rcSource)
      : null;

  const doneCount = queueItems.filter((i) => i.status === 'done').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Question Bank, Reading Builder & Bulk YouTube Studio
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Batch-download & GPU-transcribe YouTube links via CSV or paste, or build Read & Complete passages.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowBulkStudio((v) => !v)}
            className="px-3.5 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
          >
            {showBulkStudio ? '▾ Hide Bulk YouTube Studio' : '🎬 Open Bulk YouTube & CSV Studio'}
          </button>
          <button
            type="button"
            onClick={handleNewReadAndComplete}
            className="px-3.5 py-2 bg-accent-600 text-white text-xs font-bold rounded-lg hover:bg-accent-700 cursor-pointer"
          >
            + New "Read & Complete" Passage
          </button>
          <button
            type="button"
            onClick={handleNewGeneral}
            className="px-3.5 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
          >
            + New Single Question
          </button>
        </div>
      </div>

      {/* =================================================================== */}
      {/* BULK YOUTUBE & CSV QUEUE DOWNLOADER + TRANSCRIBER STUDIO            */}
      {/* =================================================================== */}
      {!editingQuestion && showBulkStudio && (
        <div className="bg-slate-900 text-white rounded-2xl p-5 space-y-4 shadow-md border border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-primary-400">
                🎬 Bulk YouTube & CSV Queue Downloader + Faster-Whisper Transcriber
              </span>
              <p className="text-xs text-slate-300 mt-0.5">
                Paste multiple YouTube URLs (or CSV rows) or upload a <code>.csv</code> / <code>.txt</code> file. Clips download one by one to <code>stt-backend/audio_clips/</code> and auto-save as Shadowing or Dictogloss drills.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleLoadCuratedSixIntoQueue}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-primary-300 border border-slate-700 rounded-lg text-xs font-semibold cursor-pointer"
              >
                + Load 6 Built-In TED Talks
              </button>
              <button
                type="button"
                onClick={handleDownloadSampleCsv}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold cursor-pointer"
              >
                ⬇️ Sample CSV Template
              </button>
              <label className="px-3 py-1.5 bg-accent-600 hover:bg-accent-700 text-white rounded-lg text-xs font-bold cursor-pointer">
                📂 Upload .CSV / .TXT File
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleCsvFileUpload}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {/* Multi-Line Paste Box */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-8 space-y-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                Copy-Paste YouTube Links (one URL per line, OR CSV: <code>url, start, end, speaker, shadowing|dictogloss</code>):
              </label>
              <textarea
                value={bulkRawText}
                onChange={(e) => setBulkRawText(e.target.value)}
                rows={3}
                placeholder={\`https://www.youtube.com/watch?v=RKK7wGAYP6k, 00:20, 01:35, Prof. Lera Boroditsky, shadowing\\nhttps://www.youtube.com/watch?v=LNHBMFCzznE, 00:30, 01:45, Dr. Lara Boyd, dictogloss\`}
                className="w-full p-3 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-primary-400"
              />
            </div>
            <div className="lg:col-span-4 flex flex-col justify-end gap-2">
              <button
                type="button"
                onClick={handleParseTextToQueue}
                disabled={!bulkRawText.trim()}
                className="w-full py-2.5 px-4 bg-primary-500 hover:bg-primary-400 text-slate-950 font-bold text-xs rounded-xl disabled:opacity-40 cursor-pointer"
              >
                + Parse & Add Pasted Links to Queue
              </button>
              <button
                type="button"
                onClick={handleAddBlankRow}
                className="w-full py-2 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs rounded-xl border border-slate-700 cursor-pointer"
              >
                + Add Manual Empty Row
              </button>
            </div>
          </div>

          {/* Queue Table */}
          {queueItems.length > 0 && (
            <div className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-300">
                  Download & Transcription Queue ({doneCount} / {queueItems.length} completed)
                </span>
                <div className="flex items-center gap-2">
                  {!isProcessingQueue ? (
                    <button
                      type="button"
                      onClick={handleRunQueueSequentially}
                      className="px-4 py-2 bg-green-500 hover:bg-green-400 text-slate-950 font-bold text-xs rounded-xl cursor-pointer shadow-xs"
                    >
                      ▶ Start Sequential Download & GPU Transcription ({queueItems.filter((i) => i.status !== 'done').length} pending)
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        stopQueueRef.current = true;
                      }}
                      className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white font-bold text-xs rounded-xl cursor-pointer"
                    >
                      ⏹ Stop Queue After Current Clip
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={isProcessingQueue}
                    onClick={() => setQueueItems([])}
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-xl disabled:opacity-40 cursor-pointer"
                  >
                    Clear Queue
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="p-2.5">#</th>
                      <th className="p-2.5">YouTube URL</th>
                      <th className="p-2.5 w-24">Start</th>
                      <th className="p-2.5 w-24">End</th>
                      <th className="p-2.5">Speaker / Title</th>
                      <th className="p-2.5 w-36">Target Mode</th>
                      <th className="p-2.5">Status / Transcript Preview</th>
                      <th className="p-2.5 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {queueItems.map((item, idx) => (
                      <tr key={item.id} className="hover:bg-slate-900/60">
                        <td className="p-2 font-mono text-slate-400">{idx + 1}</td>
                        <td className="p-2">
                          <input
                            type="url"
                            value={item.url}
                            disabled={item.status === 'processing'}
                            onChange={(e) => updateQueueRow(item.id, { url: e.target.value })}
                            placeholder="https://www.youtube.com/watch?v=..."
                            className="w-full min-w-[210px] px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-100 font-mono text-xs"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={item.startTime}
                            disabled={item.status === 'processing'}
                            onChange={(e) => updateQueueRow(item.id, { startTime: e.target.value })}
                            className="w-20 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-100 font-mono text-xs text-center"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={item.endTime}
                            disabled={item.status === 'processing'}
                            onChange={(e) => updateQueueRow(item.id, { endTime: e.target.value })}
                            className="w-20 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-100 font-mono text-xs text-center"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={item.speaker}
                            disabled={item.status === 'processing'}
                            onChange={(e) => updateQueueRow(item.id, { speaker: e.target.value })}
                            className="w-full min-w-[150px] px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-100 text-xs"
                          />
                        </td>
                        <td className="p-2">
                          <select
                            value={item.targetMode}
                            disabled={item.status === 'processing'}
                            onChange={(e) =>
                              updateQueueRow(item.id, {
                                targetMode: e.target.value as 'shadowing' | 'dictogloss',
                              })
                            }
                            className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-100 text-xs"
                          >
                            <option value="shadowing">🗣️ Shadowing</option>
                            <option value="dictogloss">🎧 Dictogloss</option>
                          </select>
                        </td>
                        <td className="p-2">
                          <div className="space-y-1">
                            <span
                              className={\`inline-block px-2 py-0.5 rounded font-bold text-[11px] \${
                                item.status === 'done'
                                  ? 'bg-green-900/60 text-green-300 border border-green-700'
                                  : item.status === 'processing'
                                  ? 'bg-amber-900/60 text-amber-300 border border-amber-700 animate-pulse'
                                  : item.status === 'error'
                                  ? 'bg-red-900/60 text-red-300 border border-red-700'
                                  : 'bg-slate-800 text-slate-300'
                              }\`}
                            >
                              {item.status === 'done'
                                ? '✓ Saved'
                                : item.status === 'processing'
                                ? '⏳ Processing...'
                                : item.status === 'error'
                                ? '❌ Error'
                                : 'Queued'}
                            </span>
                            {item.message && (
                              <p className="text-[11px] text-slate-400 line-clamp-1">
                                {item.message}
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="p-2 text-right">
                          <button
                            type="button"
                            disabled={item.status === 'processing'}
                            onClick={() => removeQueueRow(item.id)}
                            className="text-slate-400 hover:text-red-400 px-2 py-1 cursor-pointer"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {!editingQuestion && (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setFilterSkill('all')}
              className={\`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer \${
                filterSkill === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }\`}
            >
              All ({questions.length})
            </button>
            {skills.map((s) => {
              const count = questions.filter((q) => q.skill === s.value).length;
              return (
                <button
                  key={s.value}
                  onClick={() => setFilterSkill(s.value)}
                  className={\`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer \${
                    filterSkill === s.value
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }\`}
                >
                  {s.label} ({count})
                </button>
              );
            })}
          </div>

          <div className="space-y-3">
            {filtered.map((q) => (
              <div
                key={q.id}
                className="bg-white rounded-xl border border-slate-200 p-4 hover:border-primary-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-accent-100 text-accent-700">
                        {q.skill}
                      </span>
                      <span className="text-xs text-slate-600 font-mono font-semibold bg-slate-100 px-2 py-0.5 rounded">
                        {q.type}
                      </span>
                      {q.sourceAttribution && (
                        <span className="text-xs font-semibold text-slate-600">
                          • {q.sourceAttribution}
                        </span>
                      )}
                      {q.readAndComplete && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-purple-100 text-purple-800">
                          {q.readAndComplete.blanks.length} Letter-Box Words
                        </span>
                      )}
                      {q.audioUrl && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-800">
                          🎙️ Local Human MP3 Ready
                        </span>
                      )}
                      {!q.audioUrl && q.youtubeSource && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                          🎬 YouTube Linked ({q.youtubeSource.speaker})
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-800 font-semibold">{q.prompt}</p>
                    {q.readAndComplete && (
                      <p className="text-xs text-slate-500 font-mono line-clamp-2">
                        {readAndCompleteToBracketText(q.readAndComplete)}
                      </p>
                    )}
                    {q.audioUrl && (
                      <audio
                        controls
                        src={normalizeAudioUrl(q.audioUrl)}
                        className="h-8 w-full max-w-md mt-1"
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => openEditor(q)}
                      className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 cursor-pointer"
                    >
                      Edit Question
                    </button>
                    <button
                      onClick={() => deleteQuestion(q.id)}
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {editingQuestion && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-base font-bold text-slate-900">
              Edit Question ({editingQuestion.type})
            </h3>
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              ✕ Close Editor
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Skill</label>
              <select
                value={editingQuestion.skill}
                onChange={(e) =>
                  setEditingQuestion({ ...editingQuestion, skill: e.target.value as DETSkill })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                {skills.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Question Type</label>
              <select
                value={editingQuestion.type}
                onChange={(e) => {
                  const newType = e.target.value as DETQuestionType;
                  const matchedSkill =
                    questionTypes.find((qt) => qt.value === newType)?.skill ??
                    editingQuestion.skill;
                  setEditingQuestion({
                    ...editingQuestion,
                    type: newType,
                    skill: matchedSkill,
                  });
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                {questionTypes.map((qt) => (
                  <option key={qt.value} value={qt.value}>
                    {qt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Tags</label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="read-and-complete, bbc, shadowing"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          {editingQuestion.type === 'read-and-complete' && (
            <div className="bg-purple-50/70 border-2 border-purple-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-purple-900">
                    ✍️ Read and Complete Letter-Box Passage Builder
                  </h4>
                  <p className="text-xs text-purple-700 mt-0.5">
                    Put <code>[brackets]</code> around the letters you want hidden as individual boxes: e.g. <code>act[ivity]</code> shows <strong>act</strong> + 5 letter boxes!
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRcBracketText(autoBracketPlainParagraph(rcBracketText))}
                  className="px-3 py-1.5 bg-purple-700 hover:bg-purple-800 text-white text-xs font-bold rounded-lg cursor-pointer"
                >
                  ⚡ Auto-Convert Plain Paragraph into [Bracket] Blanks
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Passage Title:
                  </label>
                  <input
                    type="text"
                    value={rcTitle}
                    onChange={(e) => setRcTitle(e.target.value)}
                    placeholder="e.g., Acoustic Stimulation and Neural Waste Clearance"
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Source Attribution (BBC, The Conversation, etc.):
                  </label>
                  <input
                    type="text"
                    value={rcSource}
                    onChange={(e) => setRcSource(e.target.value)}
                    placeholder="e.g., BBC Science Focus — Neurology"
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Passage Text with <code>prefix[suffix]</code> Brackets:
                </label>
                <textarea
                  value={rcBracketText}
                  onChange={(e) => setRcBracketText(e.target.value)}
                  rows={6}
                  placeholder="Paste any paragraph here, then either bracket words like neuro[science] or click the Auto-Convert button above..."
                  className="w-full p-3 bg-white border border-purple-300 rounded-lg text-sm font-mono leading-relaxed"
                />
              </div>

              {previewParsedRc && previewParsedRc.blanks.length > 0 && (
                <div className="bg-white p-3.5 rounded-lg border border-purple-200 space-y-2">
                  <p className="text-xs font-bold text-purple-900">
                    Live Preview ({previewParsedRc.blanks.length} Segmented Word Blanks Detected):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {previewParsedRc.blanks.map((b) => (
                      <span
                        key={b.id}
                        className="text-xs font-mono bg-slate-100 border border-slate-300 px-2 py-1 rounded"
                      >
                        <strong>{b.prefix}</strong>
                        <span className="text-purple-700 font-bold">
                          {'[' + '□'.repeat(b.missingSuffix.length) + ']'}
                        </span>{' '}
                        <span className="text-slate-400">({b.missingSuffix.length} boxes)</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {(editingQuestion.skill === 'speaking' || editingQuestion.skill === 'listening') && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-primary-700">
                🎙️ Real Human Audio Source (Upload File or Slice YouTube URL)
              </h4>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white p-3.5 rounded-lg border border-slate-200 space-y-2">
                  <label className="block text-xs font-bold text-slate-700">
                    Option 1: Upload Local Human Audio (.mp3, .wav, .m4a)
                  </label>
                  <input
                    type="file"
                    accept="audio/*"
                    disabled={uploadingAudio}
                    onChange={handleFileUpload}
                    className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-primary-50 file:text-primary-700"
                  />
                </div>

                <div className="bg-white p-3.5 rounded-lg border border-slate-200 space-y-2">
                  <label className="block text-xs font-bold text-slate-700">
                    Option 2: Slice YouTube / TED Talk Clip (via yt-dlp)
                  </label>
                  <input
                    type="url"
                    value={ytUrl}
                    onChange={(e) => setYtUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={ytStart}
                      onChange={(e) => setYtStart(e.target.value)}
                      placeholder="00:20"
                      className="w-20 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                    />
                    <span className="text-xs text-slate-400">to</span>
                    <input
                      type="text"
                      value={ytEnd}
                      onChange={(e) => setYtEnd(e.target.value)}
                      placeholder="01:35"
                      className="w-20 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                    />
                    <button
                      type="button"
                      disabled={uploadingAudio || !ytUrl.trim()}
                      onClick={handleYoutubeImport}
                      className="flex-1 py-1.5 px-3 bg-accent-600 text-white text-xs font-semibold rounded hover:bg-accent-700 disabled:opacity-50 cursor-pointer"
                    >
                      {uploadingAudio ? 'Processing...' : 'Download & Transcribe'}
                    </button>
                  </div>
                </div>
              </div>

              {editingQuestion.audioUrl && (
                <audio
                  controls
                  src={normalizeAudioUrl(editingQuestion.audioUrl)}
                  className="w-full h-9"
                />
              )}
              {audioStatus && (
                <div className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg p-2.5">
                  {audioStatus}
                </div>
              )}
              {audioError && (
                <div className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  {audioError}
                </div>
              )}
            </div>
          )}

          {editingQuestion.type !== 'read-and-complete' && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Prompt / Verbatim Reference Transcript:
              </label>
              <textarea
                value={editingQuestion.prompt}
                onChange={(e) =>
                  setEditingQuestion({
                    ...editingQuestion,
                    prompt: e.target.value,
                    sourceAudioText: e.target.value,
                  })
                }
                rows={4}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          )}

          {editingQuestion.skill === 'writing' && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Target Multi-Word Collocation Chunks (comma-separated):
              </label>
              <input
                type="text"
                value={chunksInput}
                onChange={(e) => setChunksInput(e.target.value)}
                placeholder="rigorous empirical validation, shift the research paradigm"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="px-4 py-2 text-sm text-slate-600 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-5 py-2 bg-primary-600 text-white text-sm font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Save Question
            </button>
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
  console.log('Phase 1 v2 Updated:', path.relative(cwd, targetPath));
}
console.log('\nPhase 1 v2 (/clips Backend Fix + Bulk YouTube/CSV Studio) applied successfully!');