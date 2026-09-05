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
    # Unpublished manuscripts require an explicit opt-in:
    # add --include-drafts --videos access-and-sign-in,account-security,account-mobile-help

A manifest of every synthesized segment (text, durations, wav path) is written
to tmp/tts/narration-manifest.json so a transcription QA pass can verify the
audio against the source narration.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WEB_ROOT = REPO_ROOT / "apps" / "web"
DECKS_DIR = WEB_ROOT / "src" / "components" / "trainingDecks"
PUBLIC_DIR = WEB_ROOT / "public"
WORK_DIR = REPO_ROOT / "tmp" / "tts"
SAMPLE_RATE = 24000

def parse_deck(path: Path, include_drafts=False):
    """Parse explicit lesson objects, including lessons not yet given audio."""
    text = path.read_text()
    result = subprocess.run(
        ["node", str(WEB_ROOT / "scripts" / "training-catalog.cjs"), path.stem]
        + (["--include-drafts"] if include_drafts else []),
        check=True, capture_output=True, text=True,
    )
    videos = json.loads(result.stdout)
    return text, videos


def encode_mp3(wav_path: Path, mp3_path: Path):
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-b:a", "96k", str(mp3_path),
        ],
        check=True,
    )


def apply_replacements(text: str, replacements):
    # Catalog spans arrive as JSON lists; new audio mappings use tuples.
    # Compare numeric offsets so both can be applied in one reverse pass.
    for (start, end), value in sorted(replacements, key=lambda item: item[0][0], reverse=True):
        text = text[:start] + value + text[end:]
    return text


def merge_manifest(previous, current, selected_videos):
    """Keep earlier QA evidence while replacing every segment of selected videos."""
    retained = [row for row in previous if row["video"] not in selected_videos]
    return sorted(retained + current, key=lambda row: (row["deck"], row["video"], row["scene"]))


def write_deck_if_unchanged(path, original, replacements, audio_outputs=()):
    # Synthesis may run while another contributor edits the same deck. Never
    # overwrite those edits with the source snapshot taken at startup.
    if path.read_text() != original:
        raise RuntimeError(f"Training source changed during synthesis: {path.name}; re-run after edits settle")
    path.write_text(apply_replacements(original, replacements))
    for staged, destination in audio_outputs:
        staged.replace(destination)


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
    parser.add_argument("--threads", type=int, default=2, help="CPU synthesis threads (default: 2)")
    parser.add_argument("--dry-run", action="store_true", help="parse and report only, no synthesis")
    parser.add_argument("--include-drafts", action="store_true", help="include unpublished draft manuscripts; does not publish them")
    args = parser.parse_args()
    if args.threads < 1:
        parser.error("--threads must be at least 1")

    deck_names = [name.strip() for name in args.decks.split(",") if name.strip()]
    video_names = {name.strip() for name in args.videos.split(",") if name.strip()}
    decks = {}
    for name in deck_names:
        path = DECKS_DIR / f"{name}.tsx"
        if not path.exists():
            raise SystemExit(f"unknown deck: {name}")
        text, videos = parse_deck(path, args.include_drafts)
        if video_names:
            videos = [video for video in videos if Path(video["audio_src"]).stem in video_names]
            if not videos:
                raise SystemExit(f"none of {sorted(video_names)} found in {path}")
        decks[name] = (text, videos)

    total_scenes = sum(len(v["scenes"]) for _, videos in decks.values() for v in videos)
    print(f"decks={deck_names} videos={sum(len(v) for _, v in decks.values())} scenes={total_scenes}")
    if args.dry_run:
        for name, (_, videos) in decks.items():
            for video in videos:
                suffix = " (audio will be added after synthesis)" if video["audio_missing"] else ""
                print(f"{name}/{video['id']}: {len(video['scenes'])} scenes -> {video['audio_src']}{suffix}")
        return

    # Bound background synthesis so local UI review and tests remain responsive.
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)
    import torch
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(args.threads)
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    lang_code = args.voice[0]  # kokoro convention: 'a' = American, 'b' = British
    pipeline = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M")

    segments_dir = WORK_DIR / "segments"
    segments_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    manifest_path = WORK_DIR / "narration-manifest.json"
    previous_manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    completed_videos = set()
    staging = tempfile.TemporaryDirectory(prefix="narration-", dir=WORK_DIR)

    for deck_name, (text, videos) in decks.items():
        replacements = []
        audio_outputs = []
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
                        "publication": video["publication"],
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
            pending_mp3 = Path(staging.name) / f"{deck_name}-{video['id']}.mp3"
            encode_mp3(video_wav, pending_mp3)
            audio_outputs.append((pending_mp3, mp3_path))
            video_wav.unlink()
            if video["audio_missing"]:
                position = video["audio_insert"]
                replacements.append(((position, position), f'audioSrc: "{video["audio_src"]}",\n    '))
            print(f"{video['audio_src']}: {len(video['scenes'])} scenes, {len(video_audio) / SAMPLE_RATE:.0f}s")

        write_deck_if_unchanged(DECKS_DIR / f"{deck_name}.tsx", text, replacements, audio_outputs)
        completed_videos.update(video["audio_src"] for video in videos)
        merged_manifest = merge_manifest(previous_manifest, manifest, completed_videos)
        pending_manifest = manifest_path.with_suffix(".pending.json")
        pending_manifest.write_text(json.dumps(merged_manifest, indent=1))
        pending_manifest.replace(manifest_path)
        print(f"{deck_name}.tsx: {len(replacements)} durationSeconds updated")

    print(f"manifest: {manifest_path} ({len(merged_manifest)} total segments; {len(manifest)} synthesized)")
    staging.cleanup()


if __name__ == "__main__":
    main()
