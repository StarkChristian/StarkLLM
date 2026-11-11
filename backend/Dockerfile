FROM python:3.11-slim

WORKDIR /app

# Install system dependencies required for pymupdf and audio
RUN apt-get update && apt-get install -y \
    build-essential \
    libpoppler-cpp-dev \
    pkg-config \
    poppler-utils \
    ffmpeg \
    tesseract-ocr \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The search reranker's model ships inside the image: it is not fetched from the internet on the user's PC at first
# start (no network connection the user did not ask for, and search works offline from the first minute)
ENV STARKLLM_RERANKER_DIR=/opt/starkllm-models
RUN python -c "from flashrank import Ranker; Ranker(model_name='ms-marco-TinyBERT-L-2-v2', cache_dir='/opt/starkllm-models')" \
    && test -d /opt/starkllm-models/ms-marco-TinyBERT-L-2-v2

# Copy application code
COPY ./app /app/app

# Copy Alembic migration files
COPY alembic.ini .
COPY alembic/ ./alembic/

# Run Alembic migrations then start the server.
# `mkdir -p data` ensures the DB directory exists even on a fresh volume.
CMD ["sh", "-c", "mkdir -p data && python -c 'from app.db.session import engine, Base; import app.db.models; Base.metadata.create_all(bind=engine)' && alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
