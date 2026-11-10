// upgrade-human-audio.mjs
// Run from project root: node upgrade-human-audio.mjs
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. PYTHON BACKEND: Serve Human Audio + Upload & YouTube Clip Auto-Transcribe
  // =========================================================================
  'stt-backend/app.py': `import os
import sys
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
os.makedirs(AUDIO_DIR, exist_ok=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve saved human audio clips at http://127.0.0.1:8000/audio/<filename>
app.mount("/audio", StaticFiles(directory=AUDIO_DIR), name="audio")

print("Loading Faster-Whisper model...")
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8_float16")
print("Model loaded successfully!")

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
        "audioUrl": f"http://127.0.0.1:8000/audio/{safe_name}",
        "filename": safe_name,
        "text": transcript_data["text"],
        "timestampedText": transcript_data["timestampedText"],
        "duration": transcript_data["duration"],
    }

class YoutubeClipRequest(BaseModel):
    url: str
    startTime: Optional[str] = "00:00"
    endTime: Optional[str] = "01:30"

@app.post("/audio/youtube")
async def import_youtube_clip(req: YoutubeClipRequest):
    clip_id = f"yt_{uuid.uuid4().hex[:10]}"
    output_template = os.path.join(AUDIO_DIR, f"{clip_id}.%(ext)s")
    final_mp3 = os.path.join(AUDIO_DIR, f"{clip_id}.mp3")

    section_arg = f"*{req.startTime}-{req.endTime}" if req.startTime and req.endTime else "*00:00-01:30"
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
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            raise HTTPException(
                status_code=400,
                detail=f"yt-dlp failed: {proc.stderr.strip() or proc.stdout.strip()}. Ensure yt-dlp and ffmpeg are installed."
            )
    except FileNotFoundError:
        raise HTTPException(status_code=400, detail="yt-dlp not found. Run: pip install yt-dlp")

    # Locate the generated audio file
    saved_file = final_mp3
    if not os.path.exists(saved_file):
        matches = [f for f in os.listdir(AUDIO_DIR) if f.startswith(clip_id)]
        if not matches:
            raise HTTPException(status_code=500, detail="Audio file was not created by yt-dlp.")
        saved_file = os.path.join(AUDIO_DIR, matches[0])

    transcript_data = run_whisper_on_file(saved_file, verbatim_prompt=False)
    filename = os.path.basename(saved_file)

    return {
        "audioUrl": f"http://127.0.0.1:8000/audio/{filename}",
        "filename": filename,
        "text": transcript_data["text"],
        "timestampedText": transcript_data["timestampedText"],
        "duration": transcript_data["duration"],
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
`,

  // =========================================================================
  // 2. TYPES: Add audioUrl to QuestionBankItem
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
  audioUrl?: string;
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
  // 3. QUESTION BANK EDITOR: Upload Human MP3/WAV + YouTube Clipper + Chunks
  // =========================================================================
  'src/components/config/QuestionBankEditor.tsx': `import { useState } from 'react';
import { useConfigStore } from '../../stores/configStore';
import type { QuestionBankItem, DETSkill, DETQuestionType } from '../../types';
import { generateId } from '../../utils/helpers';

const BACKEND_BASE = 'http://127.0.0.1:8000';

export function QuestionBankEditor() {
  const questions = useConfigStore((s) => s.questions);
  const saveQuestion = useConfigStore((s) => s.saveQuestion);
  const deleteQuestion = useConfigStore((s) => s.deleteQuestion);

  const [filterSkill, setFilterSkill] = useState<DETSkill | 'all'>('all');
  const [editingQuestion, setEditingQuestion] = useState<QuestionBankItem | null>(null);
  const [chunksInput, setChunksInput] = useState<string>('');
  const [tagsInput, setTagsInput] = useState<string>('');

  // Human Audio Upload & YouTube Clipper state
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [ytStart, setYtStart] = useState('00:30');
  const [ytEnd, setYtEnd] = useState('01:45');
  const [audioStatus, setAudioStatus] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  const skills: { value: DETSkill; label: string }[] = [
    { value: 'reading', label: 'Reading' },
    { value: 'writing', label: 'Writing' },
    { value: 'speaking', label: 'Speaking / Shadowing' },
    { value: 'listening', label: 'Listening / Dictogloss' },
  ];

  const questionTypes: { value: DETQuestionType; label: string; skill: DETSkill }[] = [
    { value: 'read-aloud', label: 'Read Aloud / Shadowing', skill: 'speaking' },
    { value: 'listen-and-type', label: 'Listen & Type / Dictogloss', skill: 'listening' },
    { value: 'write-about-photo', label: 'Collocation Chunk Writing', skill: 'writing' },
    { value: 'interactive-writing', label: 'Interactive Writing', skill: 'writing' },
    { value: 'interactive-speaking', label: 'Interactive Speaking', skill: 'speaking' },
    { value: 'speaking-sample', label: 'Speaking Sample', skill: 'speaking' },
  ];

  const filtered =
    filterSkill === 'all' ? questions : questions.filter((q) => q.skill === filterSkill);

  const openEditor = (q: QuestionBankItem) => {
    setEditingQuestion({ ...q });
    setChunksInput((q.targetChunks ?? []).join(', '));
    setTagsInput((q.tags ?? []).join(', '));
    setAudioStatus(null);
    setAudioError(null);
  };

  const handleNew = () => {
    openEditor({
      id: generateId(),
      skill: 'speaking',
      type: 'read-aloud',
      prompt: '',
      sourceAudioText: '',
      audioUrl: '',
      targetChunks: [],
      difficulty: 'hard',
      tags: ['shadowing'],
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

      setEditingQuestion({
        ...editingQuestion,
        audioUrl: data.audioUrl,
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

      setEditingQuestion({
        ...editingQuestion,
        audioUrl: data.audioUrl,
        sourceAudioText: data.text || editingQuestion.sourceAudioText,
        prompt: editingQuestion.prompt || data.text,
      });
      setAudioStatus(\`✓ Imported \${data.duration}s human audio clip & auto-transcribed!\`);
      setYtUrl('');
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

    await saveQuestion({
      ...editingQuestion,
      targetChunks: parsedChunks.length > 0 ? parsedChunks : undefined,
      tags: parsedTags,
    });
    setEditingQuestion(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Question Bank & Human Audio Studio
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Add custom prompts, upload real human MP3/WAV recordings, or slice YouTube/TED talks for Shadowing & Dictogloss.
          </p>
        </div>
        <button
          onClick={handleNew}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 cursor-pointer"
        >
          + New Question / Audio Drill
        </button>
      </div>

      {/* Skill filter tabs */}
      {!editingQuestion && (
        <>
          <div className="flex flex-wrap gap-2 mb-4">
            <button
              onClick={() => setFilterSkill('all')}
              className={\`px-3 py-1.5 text-xs font-semibold rounded-lg \${
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
                  className={\`px-3 py-1.5 text-xs font-semibold rounded-lg \${
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
                      <span className="text-xs text-slate-500 font-mono">{q.type}</span>
                      {q.audioUrl && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-800">
                          🎙️ Real Human Audio Attached
                        </span>
                      )}
                      {q.tags.map((t) => (
                        <span
                          key={t}
                          className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                    <p className="text-sm text-slate-800 font-medium line-clamp-2">{q.prompt}</p>
                    {q.audioUrl && (
                      <audio controls src={q.audioUrl} className="h-8 w-full max-w-md mt-1" />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openEditor(q)}
                      className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 cursor-pointer"
                    >
                      Edit / Audio
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

      {/* Question & Human Audio Editor Modal */}
      {editingQuestion && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-base font-bold text-slate-900">
              Customize Prompt & Real Human Audio
            </h3>
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800"
            >
              ✕ Close
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
                onChange={(e) =>
                  setEditingQuestion({
                    ...editingQuestion,
                    type: e.target.value as DETQuestionType,
                  })
                }
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
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Tags (use "shadowing" or "dictogloss")
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="shadowing, dictogloss, vocab"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          {/* REAL HUMAN AUDIO STUDIO */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-primary-700">
                  🎙️ Real Human Audio Source (For Shadowing & Dictogloss)
                </h4>
                <p className="text-xs text-slate-500">
                  Upload an MP3/WAV file or slice a YouTube/TED video. Faster-Whisper will automatically transcribe it!
                </p>
              </div>
            </div>

            {/* Option A: Upload local MP3/WAV */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
              <div className="bg-white p-3.5 rounded-lg border border-slate-200 space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  Option 1: Upload Local Human Audio (.mp3, .wav, .m4a)
                </label>
                <input
                  type="file"
                  accept="audio/*"
                  disabled={uploadingAudio}
                  onChange={handleFileUpload}
                  className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                />
              </div>

              {/* Option B: YouTube / TED Clipper */}
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
                    placeholder="00:30"
                    className="w-20 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                    title="Start Time (MM:SS)"
                  />
                  <span className="text-xs text-slate-400">to</span>
                  <input
                    type="text"
                    value={ytEnd}
                    onChange={(e) => setYtEnd(e.target.value)}
                    placeholder="01:45"
                    className="w-20 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                    title="End Time (MM:SS)"
                  />
                  <button
                    type="button"
                    disabled={uploadingAudio || !ytUrl.trim()}
                    onClick={handleYoutubeImport}
                    className="flex-1 py-1.5 px-3 bg-accent-600 text-white text-xs font-semibold rounded hover:bg-accent-700 disabled:opacity-50 cursor-pointer"
                  >
                    {uploadingAudio ? 'Processing...' : 'Import & Transcribe'}
                  </button>
                </div>
              </div>
            </div>

            {/* Option C: Direct Audio URL */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Audio Stream URL (Auto-filled on upload, or paste any direct .mp3 link):
              </label>
              <input
                type="text"
                value={editingQuestion.audioUrl ?? ''}
                onChange={(e) =>
                  setEditingQuestion({ ...editingQuestion, audioUrl: e.target.value })
                }
                placeholder="http://127.0.0.1:8000/audio/human_clip.mp3"
                className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono"
              />
            </div>

            {editingQuestion.audioUrl && (
              <div className="pt-1">
                <audio controls src={editingQuestion.audioUrl} className="w-full h-9" />
              </div>
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

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Task Prompt / Verbatim Human Transcript (Auto-populated by Whisper on upload):
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
              placeholder="The human speaker's transcript or writing task prompt..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Target Multi-Word Collocation Chunks (comma-separated, for Vocab Writing):
            </label>
            <input
              type="text"
              value={chunksInput}
              onChange={(e) => setChunksInput(e.target.value)}
              placeholder="rigorous empirical validation, shift the research paradigm, bear the consequences"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              150-Band Reference Sample Answer (Optional):
            </label>
            <textarea
              value={editingQuestion.sampleAnswer ?? ''}
              onChange={(e) =>
                setEditingQuestion({ ...editingQuestion, sampleAnswer: e.target.value })
              }
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="px-4 py-2 text-sm text-slate-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-5 py-2 bg-primary-600 text-white text-sm font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Save Question & Audio
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 4. SHADOWING BLOCK: Real Human HTML5 <audio> + Pitch-Preserving Speed
  // =========================================================================
  'src/components/exam/blocks/ShadowingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import type { BlockConfig, QuestionBankItem } from '../../../types';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';

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
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [speechRate, setSpeechRate] = useState<number>(1.0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [hideTranscript, setHideTranscript] = useState(false);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<AudioRecorderService | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];

  useEffect(() => {
    db.questionBank.toArray().then((all) => {
      const shadowItems = all.filter(
        (q) =>
          Boolean(q.audioUrl) ||
          q.tags.includes('shadowing') ||
          q.type === 'read-aloud' ||
          Boolean(q.sourceAudioText)
      );
      // Prioritize items with real human audio first
      shadowItems.sort((a, b) => (b.audioUrl ? 1 : 0) - (a.audioUrl ? 1 : 0));
      setPassages(shadowItems.length > 0 ? shadowItems : all);
    });
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, []);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = currentItem?.audioUrl?.trim() || '';
  const sourceText =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.';

  // Sync playbackRate and pitch preservation on the HTML5 <audio> element
  useEffect(() => {
    const el = audioPlayerRef.current;
    if (!el) return;
    el.playbackRate = speechRate;
    if ('preservesPitch' in el) {
      (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
  }, [speechRate, humanAudioUrl]);

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

      updateResponse(block.id, {
        audioBlobRef: dataUrl,
        textOrTranscript: result.text || '[No speech detected]',
        timestampedTranscript: result.timestampedText || result.text,
        audioDurationSec: actualDuration,
        promptSnapshot: sourceText,
        fillerCount: stats.fillerCount,
        wpm: stats.wpm,
      });
      setRecordingState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Shadowing transcription failed');
      setRecordingState('idle');
    }
  }, [block.id, sourceText, stopNativeAudio, updateResponse]);

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
                : 'bg-amber-100 text-amber-800'
            }\`}
          >
            {humanAudioUrl
              ? '🎙️ Real Human Audio Active'
              : '⚠️ Synthetic TTS Fallback (Add Human MP3 in Config -> Question Bank)'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
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
            <button
              type="button"
              onClick={() => {
                stopNativeAudio();
                setSelectedIdx((i) => (i + 1) % passages.length);
              }}
              className="text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 px-3 py-1 rounded-lg cursor-pointer"
            >
              Next Clip ({selectedIdx + 1}/{passages.length})
            </button>
          )}
        </div>
      </div>

      {/* Real Human HTML5 Audio Player Bar */}
      {humanAudioUrl && (
        <div className="bg-slate-900 text-white rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>Human Reference Track (Pitch-Preserved {speechRate}x) — Wear headphones while shadowing</span>
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
            Arguelles Shadowing Script (Lag by ~0.5s, mirror human prosody & stress)
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHideTranscript((h) => !h)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-slate-700 cursor-pointer"
            >
              {hideTranscript ? 'Show Transcript' : 'Blind Shadowing (Hide Text)'}
            </button>
            {!humanAudioUrl && (
              <button
                type="button"
                onClick={isPlayingAudio ? stopNativeAudio : playNativeAudio}
                className="text-xs font-semibold px-3 py-1 rounded-lg bg-white border border-primary-300 text-primary-800"
              >
                {isPlayingAudio ? 'Stop Audio' : 'Preview Audio'}
              </button>
            )}
          </div>
        </div>
        {hideTranscript ? (
          <p className="text-sm italic text-slate-500 py-4 text-center">
            Transcript hidden for pure auditory-motor shadowing. Listen closely to the human speaker's intonation!
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
            Play Human Audio & Record Your Shadowing Simultaneously
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
  // 5. DICTOGLOSS BLOCK: Real Human <audio> Lecture Playback + Note Compression
  // =========================================================================
  'src/components/exam/blocks/DictoglossBlock.tsx': `import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import type { BlockConfig, QuestionBankItem } from '../../../types';

export function DictoglossBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [phase, setPhase] = useState<'listen' | 'reconstruct'>('listen');
  const [playCount, setPlayCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const response = draftResponses[block.id];
  const fragmentNotes = response?.fragmentNotes ?? '';
  const reconstructedText = response?.textOrTranscript ?? '';

  useEffect(() => {
    db.questionBank.toArray().then((all) => {
      const items = all.filter(
        (q) => Boolean(q.audioUrl) || q.tags.includes('dictogloss') || q.skill === 'listening'
      );
      items.sort((a, b) => (b.audioUrl ? 1 : 0) - (a.audioUrl ? 1 : 0));
      setPassages(items.length > 0 ? items : all);
    });
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = currentItem?.audioUrl?.trim() || '';
  const sourcePassage =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.';

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
    utterance.rate = 1.0;
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
    });
  };

  const handleReconstructionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (communicativePressure && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  };

  const fragmentWordCount = fragmentNotes.trim() ? fragmentNotes.trim().split(/\\s+/).length : 0;

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-accent-700">
            Dictogloss Working-Memory Protocol {humanAudioUrl ? '(🎙️ Real Human Audio)' : '(TTS Fallback)'}
          </span>
          <p className="text-xs text-slate-500 mt-0.5">
            Phase 1: Listen & take compressed 2-4 word fragment notes. Phase 2: Reconstruct full meaning from memory.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {passages.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setPlayCount(0);
                setSelectedIdx((i) => (i + 1) % passages.length);
              }}
              className="px-2.5 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg cursor-pointer"
            >
              Switch Audio ({selectedIdx + 1}/{passages.length})
            </button>
          )}
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
            2. Reconstruct Meaning
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
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-accent-800">
              Audio Listens Used: {playCount} / 2 (Transcript hidden to train working memory)
            </span>
            <button
              type="button"
              onClick={handlePlayPassage}
              disabled={isPlaying}
              className="px-5 py-2.5 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer"
            >
              {isPlaying
                ? 'Playing Human Lecture Audio...'
                : playCount === 0
                ? '▶ Play Human Audio (1st Listen: Comprehension)'
                : '▶ Play Again (2nd Listen: Fragment Note-Taking)'}
            </button>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Fragment Notes Only (Abbreviations, symbols, keywords — max 25 words):
            </label>
            <input
              type="text"
              value={fragmentNotes}
              onChange={handleNotesChange}
              placeholder="e.g., SLA: interm -> adv req multi-word chunks / time press != isol words"
              className="w-full px-3.5 py-2.5 bg-white border border-accent-300 rounded-lg text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            <div className="flex justify-between mt-1 text-[11px] text-slate-500">
              <span>Compress spoken clauses into 2–4 word fragments</span>
              <span>{fragmentWordCount} / 25 fragment words</span>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (audioRef.current) audioRef.current.pause();
                setPhase('reconstruct');
              }}
              className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Lock Audio & Start Reconstruction →
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5">
            <p className="text-xs font-bold text-amber-900">Your Compressed Fragment Notes:</p>
            <p className="text-sm font-mono text-amber-800 mt-1">
              {fragmentNotes || '(No fragment notes taken — reconstruct from working memory)'}
            </p>
          </div>

          <textarea
            value={reconstructedText}
            onKeyDown={handleReconstructionKeyDown}
            onChange={(e) =>
              updateResponse(block.id, {
                textOrTranscript: e.target.value,
                promptSnapshot: sourcePassage,
              })
            }
            placeholder="Reconstruct the passage's full meaning using complex subordination (whereas, consequently, while) and academic collocations..."
            className="w-full min-h-[240px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400"
            autoFocus
          />
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
  console.log('Updated:', path.relative(cwd, targetPath));
}
console.log('\nReal Human Audio Studio & Playback applied successfully!');