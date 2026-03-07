# ─── Zerowing Meeting Bot ─────────────────────────────────────────────────
# Multi-stage build: Node.js + Python + Chromium + PulseAudio + ffmpeg
# Works on both ARM64 (Oracle Cloud Free) and AMD64 (Hetzner/AWS/etc.)
#
# Build:  docker build -t zerowing-meeting-bot .
# Run:    docker run --env-file .env zerowing-meeting-bot

FROM node:22-slim AS base

# Install system dependencies (works on both arm64 and amd64)
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium for Puppeteer (auto-picks correct arch)
    chromium \
    # Audio stack
    pulseaudio \
    pulseaudio-utils \
    # Audio encoding
    ffmpeg \
    # Python for transcription
    python3 \
    python3-pip \
    python3-venv \
    # Virtual display (headless Chromium + video recording via x11grab)
    xvfb \
    libxext6 \
    # Misc
    dbus \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium (works on ARM and x86)
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ─── Python Dependencies ──────────────────────────────────────────────────
WORKDIR /app

COPY requirements.txt .
RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PATH="/app/venv/bin:$PATH"

# ─── Node Dependencies ───────────────────────────────────────────────────
COPY package.json .
RUN npm install --production=false

# ─── Application Code ─────────────────────────────────────────────────────
COPY tsconfig.json .
COPY src/ src/
COPY scripts/ scripts/

# Build TypeScript
RUN npx tsc

# ─── PulseAudio Config ────────────────────────────────────────────────────
# Create virtual audio sink for capturing meeting audio
RUN mkdir -p /root/.config/pulse
COPY <<'PULSE_CONFIG' /root/.config/pulse/default.pa
# Load virtual sink for meeting audio capture
.include /etc/pulse/default.pa
load-module module-null-sink sink_name=virtual_sink sink_properties=device.description="VirtualSink"
set-default-sink virtual_sink
PULSE_CONFIG

# ─── Startup Script ───────────────────────────────────────────────────────
COPY <<'ENTRYPOINT_SCRIPT' /app/start.sh
#!/bin/bash
set -e

# Start virtual display
echo "[startup] Starting Xvfb..."
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
export DISPLAY=:99

# Wait for Xvfb
sleep 1

# Start PulseAudio with virtual sink
echo "[startup] Starting PulseAudio..."
pulseaudio --start --exit-idle-time=-1 --log-level=error 2>/dev/null || true
sleep 1

# Verify audio setup
if pactl info > /dev/null 2>&1; then
  echo "[startup] PulseAudio running with virtual sink"
else
  echo "[startup] WARNING: PulseAudio failed to start"
fi

# Create recording directory
mkdir -p /tmp/recordings

# Start the bot
echo "[startup] Starting meeting bot..."
exec node dist/index.js
ENTRYPOINT_SCRIPT

RUN chmod +x /app/start.sh

# ─── Runtime ──────────────────────────────────────────────────────────────
EXPOSE 3001

CMD ["/app/start.sh"]
