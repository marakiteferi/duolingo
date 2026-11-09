import os

# Add this exact line before importing any other libraries
os.add_dll_directory(r"C:\Users\Golden Leaf\OneDrive\Documents\projects\Duolingo practice app\stt-backend\whisper-env\Lib\site-packages\torch\lib")

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import shutil

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
             
        segments_gen, info = model.transcribe(
            temp_file, 
            beam_size=5,
            condition_on_previous_text=False,
            initial_prompt="Uh, um, like, so yeah, well, [cough], [silent]..."
        )
        
        flat_text = ""
        timestamped_text = ""
        
        for segment in segments_gen:
            flat_text += segment.text + " "
            # Format: [0.0s - 2.5s] Spoken text...
            timestamped_text += f"[{segment.start:.1f}s - {segment.end:.1f}s] {segment.text.strip()}\n"
             
        return {
            "text": flat_text.strip(),
            "timestampedText": timestamped_text.strip(),
            "duration": info.duration
        }
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
