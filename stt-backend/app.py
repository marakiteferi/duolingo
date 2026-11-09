from fastapi import FastAPI, UploadFile, File
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
        
        print(f"\n🎙️  Processing {info.duration:.1f} seconds of audio...")
        text_output = ""
        
        # Loop through the transcription as it happens to create a visual cue
        for segment in segments:
            progress = min(100.0, (segment.end / info.duration) * 100)
            
            # Create a visual progress bar block
            bar_length = 20
            filled = int((progress / 100) * bar_length)
            bar = "█" * filled + "-" * (bar_length - filled)
            
            # Print the progress bar alongside the text it just figured out
            print(f"[{bar}] {progress:5.1f}% |{segment.text}")
            
            text_output += segment.text + " "
            
        print("✅ Transcription Complete!\n")
        
        return {"text": text_output.strip(), "duration": info.duration}
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
