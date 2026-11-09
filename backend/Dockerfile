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
    tesseract-ocr-deu \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY ./app /app/app

# Copy Alembic migration files
COPY alembic.ini .
COPY alembic/ ./alembic/

# Run Alembic migrations then start the server.
# `mkdir -p data` ensures the DB directory exists even on a fresh volume.
CMD ["sh", "-c", "mkdir -p data && python -c 'from app.db.session import engine, Base; import app.db.models; Base.metadata.create_all(bind=engine)' && alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
