import os
import sys
import shutil

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
        print(f"\nProcessing {total_duration:.1f} seconds of audio...")
        
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
        timestamped_text = "\n".join(timestamped_lines).strip()
        print("Transcription Complete!\n")
        
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
