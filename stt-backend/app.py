import os
import sys
import uuid
import shutil
import subprocess
from typing import Optional

# Explicitly register PyTorch CUDA/cuDNN DLL directory on Windows for Python 3.8+
torch_lib_candidates = [
    os.path.join(os.path.dirname(__file__), "whisper-env", "Lib", "site-packages", "torch", "lib"),
    r"C:\Users\Golden Leaf\OneDrive\Documents\projects\Duolingo practice app\stt-backend\whisper-env\Lib\site-packages\torch\lib",
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
        "timestampedText": "\n".join(timestamped_lines).strip(),
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
