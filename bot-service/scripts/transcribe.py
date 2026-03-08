#!/usr/bin/env python3
"""
Meeting Transcription Pipeline
================================

Uses Groq Whisper (free) for transcription + speaker timeline from bot's DOM tracking.
The bot captures which participant is speaking by watching the active speaker indicator
in the meeting UI, giving us REAL participant names instead of generic "Speaker 0".

Usage:
    # With speaker timeline from bot (recommended)
    python transcribe.py audio.webm --meeting-id abc-123 --speaker-timeline speakers.json

    # Without speaker timeline (falls back to single speaker)
    python transcribe.py audio.webm --meeting-id abc-123

    # With captions from bot (skips Groq entirely!)
    python transcribe.py audio.webm --meeting-id abc-123 --captions captions.json

    # Local whisper fallback (no internet needed)
    python transcribe.py audio.webm --meeting-id abc-123 --engine local

Pipeline:
    1. If captions exist → use them directly (free, has real speaker names)
    2. Otherwise → Groq Whisper transcription + speaker timeline alignment
    3. Upload transcript segments to Supabase
    4. Webhook notification
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

# ─── Config ───────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "")
WEBHOOK_AUTH_TOKEN = os.environ.get("WEBHOOK_AUTH_TOKEN", "")


# ─── Audio Preprocessing ──────────────────────────────────────────────────

def preprocess_audio(input_path: str, output_dir: str, for_groq: bool = False) -> str:
    """Convert audio to optimal format for transcription."""
    if for_groq:
        output_path = os.path.join(output_dir, "audio.mp3")
        cmd = ["ffmpeg", "-i", input_path, "-ar", "16000", "-ac", "1", "-b:a", "48k", "-y", output_path]
    else:
        output_path = os.path.join(output_dir, "audio.wav")
        cmd = ["ffmpeg", "-i", input_path, "-ar", "16000", "-ac", "1", "-y", output_path]

    subprocess.run(cmd, capture_output=True, check=True)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"  Preprocessed: {size_mb:.1f} MB")
    return output_path


def split_audio_for_groq(audio_path: str, output_dir: str, max_size_mb: int = 24) -> list[str]:
    """Split audio into chunks if over Groq's 25MB limit."""
    size_mb = os.path.getsize(audio_path) / (1024 * 1024)
    if size_mb <= max_size_mb:
        return [audio_path]

    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", audio_path],
        capture_output=True, text=True,
    )
    duration = float(result.stdout.strip())
    chunks_needed = int(size_mb / max_size_mb) + 1
    chunk_duration = duration / chunks_needed

    chunks = []
    for i in range(chunks_needed):
        start = i * chunk_duration
        chunk_path = os.path.join(output_dir, f"chunk_{i:03d}.mp3")
        subprocess.run(["ffmpeg", "-i", audio_path, "-ss", str(start), "-t", str(chunk_duration), "-y", chunk_path],
                       capture_output=True, check=True)
        chunks.append(chunk_path)
        print(f"  Chunk {i+1}/{chunks_needed}: {os.path.getsize(chunk_path) / (1024*1024):.1f} MB")

    return chunks


# ─── Groq Whisper Transcription (FREE) ────────────────────────────────────

def transcribe_groq(audio_path: str, language: str = "en") -> dict:
    """Transcribe using Groq's free Whisper API. Returns word-level timestamps."""
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY not set")

    with open(audio_path, "rb") as f:
        response = httpx.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": (os.path.basename(audio_path), f, "audio/mpeg")},
            # Use list of tuples to send both word AND segment granularities
            data=[
                ("model", "whisper-large-v3"),
                ("response_format", "verbose_json"),
                ("timestamp_granularities[]", "word"),
                ("timestamp_granularities[]", "segment"),
                ("language", language),
            ],
            timeout=120.0,
        )

    response.raise_for_status()
    data = response.json()

    if not isinstance(data, dict):
        print(f"  Warning: Groq returned unexpected response type: {type(data)}")
        return {"words": [], "segments": [], "text": ""}

    # Robustly parse words — skip any with missing keys
    # Use `or []` because Groq can return "words": null (not just missing key)
    words = []
    for w in (data.get("words") or []):
        try:
            if isinstance(w, dict) and "word" in w:
                words.append({"word": w["word"], "start": w.get("start", 0), "end": w.get("end", 0)})
        except (KeyError, TypeError):
            continue

    # Robustly parse segments — skip any with missing keys
    segments = []
    for s in (data.get("segments") or []):
        try:
            if isinstance(s, dict) and "text" in s:
                text = s["text"].strip() if isinstance(s["text"], str) else str(s.get("text", ""))
                segments.append({"text": text, "start": s.get("start", 0), "end": s.get("end", 0)})
        except (KeyError, TypeError, AttributeError):
            continue

    text = data.get("text", "") or ""
    if not text and not segments and not words:
        print("  Warning: Groq returned empty transcript (likely silent audio)")

    return {"words": words, "segments": segments, "text": text}


def transcribe_groq_chunked(chunks: list[str], language: str = "en") -> dict:
    """Transcribe multiple chunks and merge with offset correction."""
    all_words, all_segments, full_text_parts = [], [], []
    time_offset = 0.0

    for i, chunk_path in enumerate(chunks):
        print(f"  Transcribing chunk {i+1}/{len(chunks)} via Groq...")
        result = transcribe_groq(chunk_path, language)

        for word in result["words"]:
            word["start"] += time_offset
            word["end"] += time_offset
            all_words.append(word)

        for seg in result["segments"]:
            seg["start"] += time_offset
            seg["end"] += time_offset
            all_segments.append(seg)

        full_text_parts.append(result["text"])

        if result["segments"]:
            time_offset = result["segments"][-1]["end"]

    return {"words": all_words, "segments": all_segments, "text": " ".join(full_text_parts)}


# ─── Local Transcription (faster-whisper, fully offline) ──────────────────

def transcribe_local(audio_path: str, model_size: str = "base", language: str = "en") -> dict:
    """Transcribe using faster-whisper locally on CPU."""
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments_iter, info = model.transcribe(audio_path, language=language, word_timestamps=True, beam_size=5)

    all_words, all_segments = [], []
    for segment in segments_iter:
        all_segments.append({"text": segment.text.strip(), "start": segment.start, "end": segment.end})
        if segment.words:
            for word in segment.words:
                all_words.append({"word": word.word, "start": word.start, "end": word.end})

    return {"words": all_words, "segments": all_segments, "text": " ".join(s["text"] for s in all_segments)}


# ─── Speaker Assignment (using DOM timeline) ─────────────────────────────

def load_speaker_timeline(timeline_path: str) -> tuple[list[dict], list[str]]:
    """Load the speaker timeline generated by the bot's DOM tracking.
    Returns (speakerEvents, participants).
    """
    with open(timeline_path, "r") as f:
        data = json.load(f)
    return data.get("speakerEvents", []), data.get("participants", [])


def load_captions(captions_path: str) -> list[dict]:
    """Load live captions captured by the bot (if available)."""
    with open(captions_path, "r") as f:
        data = json.load(f)
    return data.get("segments", [])


def assign_speakers_from_timeline(
    transcript: dict,
    speaker_events: list[dict],
) -> list[dict]:
    """
    Merge word-level transcript with DOM speaker timeline.
    Maps each word to the speaker who was active at that timestamp.
    Returns final segments with REAL participant names.
    """

    def get_speaker(timestamp: float) -> str:
        """Find which speaker was active at a given timestamp."""
        for event in reversed(speaker_events):  # Search from most recent
            if event["startTime"] <= timestamp <= event["endTime"]:
                return event["speaker"]
        # Find closest speaker event
        if speaker_events:
            closest = min(speaker_events, key=lambda e: abs(e["startTime"] - timestamp))
            return closest["speaker"]
        return "Unknown"

    # Group consecutive words by speaker
    final_segments = []
    current = None

    for word in transcript.get("words", []):
        speaker = get_speaker(word["start"])

        if current is None or current["speaker"] != speaker:
            if current:
                current["text"] = current["text"].strip()
                final_segments.append(current)

            current = {
                "speaker": speaker,
                "text": "",
                "start_time": word["start"],
                "end_time": word["end"],
                "word_count": 0,
            }

        current["text"] += word["word"] + " "
        current["end_time"] = word["end"]
        current["word_count"] += 1

    if current:
        current["text"] = current["text"].strip()
        final_segments.append(current)

    # Fallback to segment-level if no word timestamps
    if not final_segments and transcript.get("segments"):
        for seg in transcript["segments"]:
            speaker = get_speaker(seg["start"])
            final_segments.append({
                "speaker": speaker,
                "text": seg["text"],
                "start_time": seg["start"],
                "end_time": seg["end"],
                "word_count": len(seg["text"].split()),
            })

    return final_segments


def captions_to_segments(caption_segments: list[dict]) -> list[dict]:
    """Convert live captions to transcript segments (no Groq needed!)."""
    final = []
    for seg in caption_segments:
        final.append({
            "speaker": seg.get("speaker", "Unknown"),
            "text": seg.get("text", ""),
            "start_time": seg.get("startTime", 0),
            "end_time": seg.get("endTime", 0),
            "word_count": len(seg.get("text", "").split()),
        })
    return final


# ─── Supabase Upload ─────────────────────────────────────────────────────

def upload_segments_to_supabase(meeting_id: str, segments: list[dict]) -> int:
    """Write transcript segments to Supabase via REST API."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print("  WARNING: Supabase not configured. Skipping upload.")
        return 0

    # Build unique speaker map
    speakers = {}
    for seg in segments:
        name = seg["speaker"]
        if name not in speakers:
            speakers[name] = len(speakers)

    rows = []
    for seg in segments:
        rows.append({
            "meeting_id": meeting_id,
            "speaker": seg["speaker"],
            "speaker_id": speakers.get(seg["speaker"], 0),
            "text": seg["text"],
            "start_time": seg["start_time"],
            "end_time": seg["end_time"],
            "confidence": seg.get("confidence", 0.9),
            "is_final": True,
            "language": "en",
            "word_count": seg.get("word_count", len(seg["text"].split())),
        })

    response = httpx.post(
        f"{SUPABASE_URL}/rest/v1/transcript_segments",
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        json=rows,
        timeout=30.0,
    )

    if response.status_code not in (200, 201):
        print(f"  ERROR: Supabase insert failed ({response.status_code}): {response.text[:200]}")
        return 0

    return len(rows)


def upload_speaker_map(meeting_id: str, segments: list[dict]):
    """Upload speaker name mapping to Supabase."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return

    speakers = {}
    for seg in segments:
        name = seg["speaker"]
        if name not in speakers:
            speakers[name] = len(speakers)

    rows = [
        {
            "meeting_id": meeting_id,
            "speaker_id": sid,
            "speaker_label": name,
            "confidence": 0.9,  # High confidence since we got names from DOM
        }
        for name, sid in speakers.items()
    ]

    httpx.post(
        f"{SUPABASE_URL}/rest/v1/meeting_speaker_map",
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        json=rows,
        timeout=30.0,
    )


# ─── Webhook Notification ────────────────────────────────────────────────

def notify_webhook(meeting_id: str, event: str, **kwargs):
    """Notify the Vercel app that transcription is complete."""
    if not WEBHOOK_URL or not WEBHOOK_AUTH_TOKEN:
        print(f"  WARNING: Webhook not configured. Skipping notification.")
        return

    response = httpx.post(
        WEBHOOK_URL,
        headers={"Authorization": f"Bearer {WEBHOOK_AUTH_TOKEN}", "Content-Type": "application/json"},
        json={"meeting_id": meeting_id, "event": event, **kwargs},
        timeout=30.0,
    )

    if response.status_code == 200:
        print(f"  Webhook sent: {event}")
    else:
        print(f"  WARNING: Webhook failed ({response.status_code}): {response.text[:200]}")


# ─── Speaker Fallback Helpers ─────────────────────────────────────────────

def _get_fallback_speaker(participants: list[str] | None) -> str:
    """Determine the fallback speaker name from the participant list.

    If there's exactly 1 participant → use their name.
    If multiple → join them (better than 'Unknown').
    If none → 'Unknown'.
    """
    if not participants:
        return "Unknown"
    # Filter out empty names and the bot itself
    names = [n.strip() for n in participants if n.strip() and n.strip().lower() not in ("captain", "zerowing", "meeting bot", "bot")]
    if len(names) == 1:
        return names[0]
    elif len(names) > 1:
        return ", ".join(names)  # "Alice, Bob" — at least shows who was there
    return "Unknown"


def _segments_with_speaker(transcript: dict, speaker_name: str) -> list[dict]:
    """Create segments from transcript with a fixed speaker name.
    Uses segments if available, falls back to building from words or text."""
    final_segments = []
    for seg in transcript.get("segments", []):
        final_segments.append({
            "speaker": speaker_name,
            "text": seg["text"],
            "start_time": seg["start"],
            "end_time": seg["end"],
            "word_count": len(seg["text"].split()),
        })

    # Fallback: if no segments but words exist, build from words
    if not final_segments and transcript.get("words"):
        chunk_text, chunk_start = [], 0.0
        for w in transcript["words"]:
            if not chunk_text:
                chunk_start = w.get("start", 0)
            chunk_text.append(w["word"])
            if len(chunk_text) >= 20 or w["word"].rstrip().endswith((".", "!", "?")):
                text = " ".join(chunk_text).strip()
                final_segments.append({
                    "speaker": speaker_name,
                    "text": text,
                    "start_time": chunk_start,
                    "end_time": w.get("end", 0),
                    "word_count": len(chunk_text),
                })
                chunk_text = []
        if chunk_text:
            text = " ".join(chunk_text).strip()
            final_segments.append({
                "speaker": speaker_name,
                "text": text,
                "start_time": chunk_start,
                "end_time": transcript["words"][-1].get("end", 0),
                "word_count": len(chunk_text),
            })

    # Last resort: if still nothing, use the full text
    if not final_segments and transcript.get("text"):
        final_segments.append({
            "speaker": speaker_name,
            "text": transcript["text"],
            "start_time": 0,
            "end_time": 0,
            "word_count": len(transcript["text"].split()),
        })

    return final_segments


# ─── Main Pipeline ────────────────────────────────────────────────────────

def run_pipeline(
    audio_path: str,
    meeting_id: str,
    engine: str = "groq",
    language: str = "en",
    whisper_model: str = "base",
    speaker_timeline_path: str | None = None,
    captions_path: str | None = None,
    participants: list[str] | None = None,
):
    """Run the full transcription pipeline."""
    total_start = time.time()
    print(f"\n{'='*60}")
    print(f"Meeting Transcription Pipeline")
    print(f"  Audio: {audio_path}")
    print(f"  Meeting ID: {meeting_id}")
    print(f"  Engine: {engine}")
    print(f"  Speaker timeline: {speaker_timeline_path or 'none'}")
    print(f"  Captions: {captions_path or 'none'}")
    print(f"  Participants: {', '.join(participants) if participants else 'none'}")
    print(f"{'='*60}\n")

    # ─── Path A: Use live captions (skip transcription entirely!) ─────
    if captions_path and os.path.exists(captions_path):
        print("[FAST PATH] Using live captions from bot — skipping Groq transcription!\n")
        caption_segments = load_captions(captions_path)

        if caption_segments:
            final_segments = captions_to_segments(caption_segments)
            speakers = set(s["speaker"] for s in final_segments)

            print(f"  Captions: {len(final_segments)} segments, {len(speakers)} speakers")
            print(f"  Speakers: {', '.join(speakers)}\n")

            print("[Upload] Writing to Supabase...")
            uploaded = upload_segments_to_supabase(meeting_id, final_segments)
            if uploaded == 0:
                print("  ERROR: Supabase upload failed — aborting pipeline")
                sys.exit(1)
            upload_speaker_map(meeting_id, final_segments)
            print(f"  Done: {uploaded} segments uploaded\n")

            total_time = time.time() - total_start
            notify_webhook(meeting_id, "transcription_complete",
                           segment_count=uploaded, duration_seconds=int(total_time))

            print(f"\n{'='*60}")
            print(f"Pipeline complete in {total_time:.1f}s (captions fast-path)")
            print(f"  Cost: $0.00")
            print(f"{'='*60}\n")
            return final_segments

        print("  Captions file empty, falling back to audio transcription...\n")

    # ─── Path B: Audio transcription + speaker timeline ───────────────
    with tempfile.TemporaryDirectory() as tmpdir:
        # Step 1: Preprocess
        print("[1/4] Preprocessing audio...")
        step_start = time.time()
        processed_audio = preprocess_audio(audio_path, tmpdir, for_groq=(engine == "groq"))
        print(f"  Done ({time.time() - step_start:.1f}s)\n")

        # Step 2: Transcribe
        print(f"[2/4] Transcribing ({engine})...")
        step_start = time.time()

        if engine == "groq":
            chunks = split_audio_for_groq(processed_audio, tmpdir)
            transcript = transcribe_groq_chunked(chunks, language) if len(chunks) > 1 else transcribe_groq(chunks[0], language)
        elif engine == "local":
            wav_audio = preprocess_audio(audio_path, tmpdir, for_groq=False) if engine != "local" else processed_audio
            transcript = transcribe_local(wav_audio, model_size=whisper_model, language=language)
        else:
            raise ValueError(f"Unknown engine: {engine}")

        word_count = len(transcript.get("words", []))
        seg_count = len(transcript.get("segments", []))
        print(f"  Done: {word_count} words, {seg_count} segments ({time.time() - step_start:.1f}s)\n")

        # When Groq returns words but no segments, build segments from words
        if seg_count == 0 and word_count > 0:
            print("  Building segments from word timestamps (Groq returned no segments)...")
            words = transcript["words"]
            segments = []
            chunk = []
            for w in words:
                chunk.append(w)
                # Split every ~20 words or at sentence-ending punctuation
                is_sentence_end = w["word"].rstrip().endswith((".", "!", "?"))
                if len(chunk) >= 20 or (is_sentence_end and len(chunk) >= 5):
                    text = " ".join(c["word"] for c in chunk).strip()
                    segments.append({"text": text, "start": chunk[0]["start"], "end": chunk[-1]["end"]})
                    chunk = []
            if chunk:
                text = " ".join(c["word"] for c in chunk).strip()
                segments.append({"text": text, "start": chunk[0]["start"], "end": chunk[-1]["end"]})
            transcript["segments"] = segments
            seg_count = len(segments)
            print(f"  Built {seg_count} segments from {word_count} words")

        # Handle empty transcript (silent audio / no speech detected)
        if seg_count == 0 and word_count == 0:
            text = transcript.get("text", "").strip()
            if not text:
                print("  ⚠ No speech detected in recording")
                # Create a single marker segment so the pipeline knows transcription ran
                empty_seg = [{
                    "speaker": "System",
                    "text": "(No speech detected in recording)",
                    "start_time": 0,
                    "end_time": 0,
                    "word_count": 0,
                }]
                uploaded = upload_segments_to_supabase(meeting_id, empty_seg)
                if uploaded == 0:
                    print("  ERROR: Failed to upload empty transcript marker")
                    sys.exit(1)
                total_time = time.time() - total_start
                notify_webhook(meeting_id, "transcription_complete",
                               segment_count=0, duration_seconds=int(total_time))
                return
            else:
                # Text was returned but no segments — create a single segment
                transcript["segments"] = [{"text": text, "start": 0, "end": 0}]
                seg_count = 1

        # Step 3: Assign speakers
        print("[3/4] Assigning speakers...")
        step_start = time.time()

        if speaker_timeline_path and os.path.exists(speaker_timeline_path):
            # Use real speaker names from DOM tracking!
            speaker_events, timeline_participants = load_speaker_timeline(speaker_timeline_path)

            # Merge participant sources: CLI args + speaker timeline file
            all_participants = list(set((participants or []) + (timeline_participants or [])))

            if speaker_events:
                print(f"  Using DOM speaker timeline: {len(speaker_events)} events")
                final_segments = assign_speakers_from_timeline(transcript, speaker_events)
            else:
                print("  Speaker timeline has no events — falling back to participant names")
                fallback_name = _get_fallback_speaker(all_participants)
                print(f"  Speaker fallback: '{fallback_name}'")
                final_segments = _segments_with_speaker(transcript, fallback_name)
        else:
            # No speaker timeline — use participant names if available
            fallback_name = _get_fallback_speaker(participants)
            print(f"  No speaker timeline — assigning to '{fallback_name}'")
            final_segments = _segments_with_speaker(transcript, fallback_name)

        speakers = set(s["speaker"] for s in final_segments)
        print(f"  Done: {len(final_segments)} segments, {len(speakers)} speakers: {', '.join(speakers)} ({time.time() - step_start:.1f}s)\n")

        # Step 4: Upload
        print("[4/4] Uploading to Supabase...")
        step_start = time.time()
        uploaded = upload_segments_to_supabase(meeting_id, final_segments)
        if uploaded == 0:
            print("  ERROR: Supabase upload failed — aborting pipeline")
            sys.exit(1)
        upload_speaker_map(meeting_id, final_segments)
        print(f"  Done: {uploaded} segments uploaded ({time.time() - step_start:.1f}s)\n")

    total_time = time.time() - total_start
    notify_webhook(meeting_id, "transcription_complete",
                   segment_count=uploaded, duration_seconds=int(total_time))

    print(f"\n{'='*60}")
    print(f"Pipeline complete in {total_time:.1f}s")
    print(f"  Segments: {len(final_segments)}")
    print(f"  Speakers: {len(speakers)} — {', '.join(speakers)}")
    print(f"  Cost: $0.00 (free tier)")
    print(f"{'='*60}\n")

    return final_segments


# ─── CLI ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Meeting transcription pipeline")
    parser.add_argument("audio", help="Path to audio file (webm, mp3, wav, etc.)")
    parser.add_argument("--meeting-id", required=True, help="Meeting UUID from Supabase")
    parser.add_argument("--engine", default="groq", choices=["groq", "local"],
                        help="Transcription engine (default: groq)")
    parser.add_argument("--language", default="en", help="Language code (default: en)")
    parser.add_argument("--whisper-model", default="base",
                        help="Whisper model size for local engine (default: base)")
    parser.add_argument("--speaker-timeline", default=None,
                        help="Path to speaker timeline JSON from bot DOM tracking")
    parser.add_argument("--captions", default=None,
                        help="Path to captions JSON from bot (skips transcription!)")
    parser.add_argument("--participants", default=None,
                        help="Comma-separated participant names (fallback for speaker labeling)")

    args = parser.parse_args()

    if not os.path.exists(args.audio):
        print(f"ERROR: Audio file not found: {args.audio}")
        sys.exit(1)

    # Parse participants from comma-separated string
    participant_list = None
    if args.participants:
        participant_list = [name.strip() for name in args.participants.split(",") if name.strip()]

    run_pipeline(
        audio_path=args.audio,
        meeting_id=args.meeting_id,
        engine=args.engine,
        language=args.language,
        whisper_model=args.whisper_model,
        speaker_timeline_path=args.speaker_timeline,
        captions_path=args.captions,
        participants=participant_list,
    )
