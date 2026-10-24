import os
import tempfile
import traceback
import logging
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, BackgroundTasks
from app.api.auth import get_current_user
from app.services.voice_service import voice_service
from pydantic import BaseModel
from typing import Optional
from fastapi.responses import FileResponse

# Speech-to-text and text-to-speech use the CPU of this PC, so they need a logged-in user like every other data route.
router = APIRouter(dependencies=[Depends(get_current_user)])
logger = logging.getLogger(__name__)

class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None

def remove_file(path: str):
    try:
        if os.path.exists(path):
            os.unlink(path)
    except Exception as e:
        logger.error(f"Failed to delete temp file {path}: {e}")

@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as temp_audio:
        temp_audio.write(await file.read())
        temp_audio_path = temp_audio.name
        
    try:
        text = voice_service.transcribe(temp_audio_path)
        return {"text": text}
    except Exception as e:
        logger.error("Voice transcription error:", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.unlink(temp_audio_path)

@router.post("/synthesize")
async def synthesize(req: SynthesizeRequest, background_tasks: BackgroundTasks):
    temp_audio_path = tempfile.mktemp(suffix=".wav")
    try:
        voice_service.synthesize(req.text, temp_audio_path, req.voice)
        background_tasks.add_task(remove_file, temp_audio_path)
        return FileResponse(temp_audio_path, media_type="audio/wav", filename="tts.wav")
    except Exception as e:
        logger.error("Voice synthesis error:", exc_info=True)
        # Clean up temp file on error
        if os.path.exists(temp_audio_path):
            os.unlink(temp_audio_path)
        raise HTTPException(status_code=500, detail=str(e))

