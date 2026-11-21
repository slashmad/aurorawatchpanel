# ---- /Dockerfile ----
FROM python:3.11-slim-bookworm
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        nano \
        gcc \
        build-essential \
        libffi-dev \
        libssl-dev \
        git \
        curl \
        fonts-dejavu \
        mariadb-client \
        tesseract-ocr \
        tesseract-ocr-swe \
		nodejs \
		npm \
    && rm -rf /var/lib/apt/lists/*

COPY app/ /app

RUN python -m pip install --upgrade pip && \
    python -m pip install --no-cache-dir -r requirements.lock.txt && \
    python -m pip check

RUN npm install -g esbuild@0.28.1

EXPOSE 32231
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "32231"]

# docker exec aurora-watch-backend esbuild static/js/main.js --bundle --format=esm --minify --outfile=static/js/main.min.js
