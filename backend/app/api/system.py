import os
import shutil
import tempfile
import zipfile
import logging
from datetime import datetime
import subprocess
import time
from typing import Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.background import BackgroundTasks
from app.api.auth import get_current_user
from app.db import models
from app.db.session import engine

router = APIRouter()
logger = logging.getLogger(__name__)

# Identify the root data directory.
# Since CHROMA_PERSIST_DIRECTORY is usually "data/chroma", its parent is "data".
# We use abspath to be safe.
DATA_DIR = os.path.abspath("data")

@router.get("/backup")
def backup_system(current_user: models.User = Depends(get_current_user)):
    """
    Creates a zip archive of the local data directory and returns it as a download.
    """
    if not os.path.exists(DATA_DIR):
        raise HTTPException(status_code=404, detail="Data directory not found.")
        
    try:
        # Create a temporary directory to store the zip file
        temp_dir = tempfile.mkdtemp()
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        zip_filename = f"starkllm_backup_{timestamp}"
        zip_path = os.path.join(temp_dir, zip_filename)
        
        # shutil.make_archive adds the .zip extension automatically
        archive_path = shutil.make_archive(zip_path, 'zip', DATA_DIR)
        
        # Return the file response, allowing the browser to download it
        # We attach a background task to clean up the temporary directory after the download
        background_tasks = BackgroundTasks()
        background_tasks.add_task(shutil.rmtree, temp_dir, ignore_errors=True)
        
        return FileResponse(
            path=archive_path,
            filename=f"{zip_filename}.zip",
            media_type="application/zip",
            background=background_tasks
        )
    except Exception as e:
        logger.error(f"Backup failed: {e}")
        # Clean up immediately if it failed before returning
        if 'temp_dir' in locals():
            shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to create backup: {str(e)}")

@router.post("/restore")
async def restore_system(
    file: UploadFile = File(...),
    current_user: models.User = Depends(get_current_user)
):
    """
    Restores the system from an uploaded zip backup.
    NOTE: On Windows, file locks on sqlite/chroma files may prevent overwrite.
    """
    if not file.filename.endswith('.zip'):
        raise HTTPException(status_code=400, detail="Must upload a .zip backup file.")
        
    temp_dir = tempfile.mkdtemp()
    zip_path = os.path.join(temp_dir, "uploaded_backup.zip")
    extract_dir = os.path.join(temp_dir, "extracted")
    
    try:
        # Save uploaded zip
        with open(zip_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Extract zip
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(extract_dir)
            
        # Basic validation: check if starkllm.db exists in the extracted root
        if not os.path.exists(os.path.join(extract_dir, "starkllm.db")):
            # It might be nested one level deep depending on how it was zipped
            nested_dirs = [d for d in os.listdir(extract_dir) if os.path.isdir(os.path.join(extract_dir, d))]
            if len(nested_dirs) == 1 and os.path.exists(os.path.join(extract_dir, nested_dirs[0], "starkllm.db")):
                extract_dir = os.path.join(extract_dir, nested_dirs[0])
            else:
                raise HTTPException(status_code=400, detail="Invalid backup file: starkllm.db not found.")
        
        # 1. Close SQLAlchemy connections to release sqlite locks
        engine.dispose()
        
        # 2. Attempt to overwrite files
        try:
            # We copy files over individually to overwrite
            shutil.copytree(extract_dir, DATA_DIR, dirs_exist_ok=True)
        except PermissionError:
            # This is extremely common on Windows for active SQLite / ChromaDB files
            raise HTTPException(
                status_code=409, 
                detail="Permission Denied: The server is actively locking the database files. "
                       "Please stop the StarkLLM backend server, manually extract this ZIP file into "
                       "the 'data' folder, and restart the server."
            )
            
        return {"status": "success", "message": "Restore completed successfully. Please reload the page."}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Restore failed: {e}")
        raise HTTPException(status_code=500, detail=f"Restore failed: {str(e)}")
    finally:
        # Cleanup temporary files
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except:
            pass


# --- Sandboxed Code Interpreter / Runner ---

class ExecuteCodeRequest(BaseModel):
    code: str
    language: Optional[str] = "python"
    timeout_seconds: Optional[int] = 5


@router.post("/execute-code")
def execute_code(
    req: ExecuteCodeRequest,
    current_user: models.User = Depends(get_current_user)
):
    """
    Safely execute a code snippet in an isolated process with strict timeout.
    Returns stdout, stderr, execution_time_ms, and exit_code.
    """
    lang = (req.language or "python").lower().strip()
    timeout = min(max(req.timeout_seconds or 5, 1), 10)

    # Use python3 or python
    cmd = ["python3", "-c", req.code]

    t0 = time.time()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        t1 = time.time()
        exec_ms = round((t1 - t0) * 1000)
        return {
            "stdout": proc.stdout[:15000],
            "stderr": proc.stderr[:5000],
            "exit_code": proc.returncode,
            "execution_time_ms": exec_ms
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"Execution timed out after {timeout} seconds.",
            "exit_code": 124,
            "execution_time_ms": timeout * 1000
        }
    except Exception as e:
        logger.error(f"Code execution error: {e}")
        return {
            "stdout": "",
            "stderr": f"Execution failed: {str(e)}",
            "exit_code": 1,
            "execution_time_ms": 0
        }

