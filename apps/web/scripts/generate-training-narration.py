#!/usr/bin/env python3
"""Regenerate the training-video narration MP3s with the Kokoro neural TTS.

The Help drawer and console Documentation videos are Remotion slideshows whose
audio lives in apps/web/public/training/**. Each scene's narration is
synthesized as one segment, padded with trailing silence to exactly
ceil(speech_seconds) + 1 so scene boundaries land on integer seconds, then the
segments are concatenated per video and encoded to MP3. The script rewrites
each scene's `durationSeconds` in src/components/trainingDecks/*.tsx to match
the padded segment length, because the Remotion timeline is driven by those
values, not by the audio file.

Environment (one-time):
    uv venv --python 3.12 tmp/tts/.venv
    uv pip install --python tmp/tts/.venv/bin/python kokoro soundfile
    # ffmpeg must be on PATH

Usage (from the repo root):
    tmp/tts/.venv/bin/python apps/web/scripts/generate-training-narration.py \
        [--decks user,admin,owner] [--videos personalization-memory] [--voice af_heart] [--dry-run]

A manifest of every synthesized segment (text, durations, wav path) is written
to tmp/tts/narration-manifest.json so a transcription QA pass can verify the
audio against the source narration.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WEB_ROOT = REPO_ROOT / "apps" / "web"
DECKS_DIR = WEB_ROOT / "src" / "components" / "trainingDecks"
PUBLIC_DIR = WEB_ROOT / "public"
WORK_DIR = REPO_ROOT / "tmp" / "tts"
SAMPLE_RATE = 24000

AUDIO_SRC_RE = re.compile(r'audioSrc:\s*"([^"]+)"')
SCENE_RE = re.compile(r'narration:\s*\n?\s*"([^"]+)",\s*\n\s*durationSeconds:\s*(\d+)')


def parse_deck(path: Path):
    """Yield videos as {audio_src, scenes: [{narration, duration, span}]}.

    Scenes are attributed to the closest preceding audioSrc. The span covers
    the durationSeconds integer so it can be rewritten in place.
    """
    text = path.read_text()
    videos = [{"audio_src": m.group(1), "start": m.start(), "scenes": []} for m in AUDIO_SRC_RE.finditer(text)]
    if not videos:
        raise SystemExit(f"no audioSrc entries found in {path}")
    for m in SCENE_RE.finditer(text):
        owner = None
        for video in videos:
            if video["start"] < m.start():
                owner = video
        if owner is None:
            raise SystemExit(f"scene before first audioSrc in {path}: {m.group(1)[:40]!r}")
        owner["scenes"].append(
            {"narration": m.group(1), "duration": int(m.group(2)), "span": m.span(2)}
        )
    for video in videos:
        if not video["scenes"]:
            raise SystemExit(f"video {video['audio_src']} has no scenes in {path}")
    return text, videos


def encode_mp3(wav_path: Path, mp3_path: Path):
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-b:a", "96k", str(mp3_path),
        ],
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--decks", default="user,admin,owner")
    parser.add_argument(
        "--videos",
        default="",
        help="optional comma-separated audio stems to synthesize, such as personalization-memory",
    )
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--dry-run", action="store_true", help="parse and report only, no synthesis")
    args = parser.parse_args()

    deck_names = [name.strip() for name in args.decks.split(",") if name.strip()]
    video_names = {name.strip() for name in args.videos.split(",") if name.strip()}
    decks = {}
    for name in deck_names:
        path = DECKS_DIR / f"{name}.tsx"
        if not path.exists():
            raise SystemExit(f"unknown deck: {name}")
        text, videos = parse_deck(path)
        if video_names:
            videos = [video for video in videos if Path(video["audio_src"]).stem in video_names]
            if not videos:
                raise SystemExit(f"none of {sorted(video_names)} found in {path}")
        decks[name] = (text, videos)

    total_scenes = sum(len(v["scenes"]) for _, videos in decks.values() for v in videos)
    print(f"decks={deck_names} videos={sum(len(v) for _, v in decks.values())} scenes={total_scenes}")
    if args.dry_run:
        return

    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    lang_code = args.voice[0]  # kokoro convention: 'a' = American, 'b' = British
    pipeline = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M")

    segments_dir = WORK_DIR / "segments"
    segments_dir.mkdir(parents=True, exist_ok=True)
    manifest = []

    for deck_name, (text, videos) in decks.items():
        replacements = []
        for video in videos:
            parts = []
            for index, scene in enumerate(video["scenes"]):
                chunks = [audio for _, _, audio in pipeline(scene["narration"], voice=args.voice, speed=args.speed)]
                speech = np.concatenate(chunks)
                raw_seconds = len(speech) / SAMPLE_RATE
                padded_seconds = math.ceil(raw_seconds) + 1
                segment = np.zeros(padded_seconds * SAMPLE_RATE, dtype=speech.dtype)
                segment[: len(speech)] = speech
                parts.append(segment)

                stem = Path(video["audio_src"]).stem
                wav_path = segments_dir / f"{deck_name}-{stem}-{index:02d}.wav"
                sf.write(wav_path, speech, SAMPLE_RATE)
                manifest.append(
                    {
                        "deck": deck_name,
                        "video": video["audio_src"],
                        "scene": index,
                        "narration": scene["narration"],
                        "speech_seconds": round(raw_seconds, 2),
                        "duration_seconds": padded_seconds,
                        "previous_duration_seconds": scene["duration"],
                        "wav": str(wav_path),
                    }
                )
                if padded_seconds != scene["duration"]:
                    replacements.append((scene["span"], str(padded_seconds)))

            video_audio = np.concatenate(parts)
            video_wav = WORK_DIR / "video.wav"
            sf.write(video_wav, video_audio, SAMPLE_RATE)
            mp3_path = PUBLIC_DIR / video["audio_src"]
            mp3_path.parent.mkdir(parents=True, exist_ok=True)
            encode_mp3(video_wav, mp3_path)
            video_wav.unlink()
            print(f"{video['audio_src']}: {len(video['scenes'])} scenes, {len(video_audio) / SAMPLE_RATE:.0f}s")

        for (start, end), value in sorted(replacements, reverse=True):
            text = text[:start] + value + text[end:]
        (DECKS_DIR / f"{deck_name}.tsx").write_text(text)
        print(f"{deck_name}.tsx: {len(replacements)} durationSeconds updated")

    manifest_path = WORK_DIR / "narration-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f"manifest: {manifest_path} ({len(manifest)} segments)")


if __name__ == "__main__":
    main()
