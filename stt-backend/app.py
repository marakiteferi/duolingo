from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import shutil
import os

app = FastAPI()

# Allow your React frontend to communicate with this local API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load the turbo model using 8-bit weights and 16-bit activations
# This strictly caps VRAM usage at ~1.5 - 2 GB, easily fitting your 6GB limit
print("Loading model...")
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8_float16")
print("Model loaded successfully!")

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    temp_file = f"temp_{file.filename}"
    with open(temp_file, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    # Verbatim parameters force the AI to transcribe hesitations, stutters, and silences
    segments, info = model.transcribe(
        temp_file, 
        beam_size=5,
        condition_on_previous_text=False,
        initial_prompt="Uh, um, like, so yeah, well, [cough], [silent]..."
    )
    
    text_output = " ".join([segment.text for segment in segments])
    
    os.remove(temp_file)
    
    return {"text": text_output.strip()}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)