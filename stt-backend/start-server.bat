@echo off
echo Starting Local Faster-Whisper GPU Server on http://127.0.0.1:8000...
cd /d "%~dp0"
if exist "whisper-env\Scripts\activate.bat" (
    call whisper-env\Scripts\activate.bat
)
python app.py
pause
