// new-incomplete-fix.mjs  (completed)
// Run from project root: node "new-incomlete fix.mjs"
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. PYTHON BACKEND: Curated YouTube Pack + Deterministic Local MP3 Caching
  //    NOTE: StaticFiles mounted at /clips (not /audio) to avoid intercepting
  //    the OPTIONS preflight on POST /audio/upload and /audio/youtube
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
# on POST /audio/upload and /audio/youtube
app.mount("/clips", StaticFiles(directory=AUDIO_DIR), name="clips")

print("Loading Faster-Whisper model...")
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8_float16")
print("Model loaded successfully!")

def load_manifest() -> dict:
    if os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
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
        cached_path = os.path.join(AUDIO_DIR, cached.get("filename", ""))
        if os.path.exists(cached_path):
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
  // 2. TYPES
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
};

// =========================================================================
// RUNNER
// =========================================================================
const root = path.resolve('.');

for (const [relPath, content] of Object.entries(files)) {
  const fullPath = path.join(root, relPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log(`Updated: ${relPath}`);
}

console.log('\nFix applied: /audio → /clips static mount + types updated!');
