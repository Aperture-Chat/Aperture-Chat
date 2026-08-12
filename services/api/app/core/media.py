"""Local audio/video inspection and ffmpeg extraction.

Chat dictation already sends WAV/MP3 to an audio-capable model. Uploaded
recordings and video files need a local pass first: probe duration, pull a
speech-friendly MP3, optionally grab a few stills, and fail honestly when
ffmpeg is missing for a format that cannot ride the existing WAV/MP3 path.
"""

from __future__ import annotations

import mimetypes
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Speech-sized chunks stay inside the same envelope as composer dictation
# (15 MB of 16 kHz WAV is roughly eight minutes).
AUDIO_CHUNK_SECONDS = 8 * 60
MAX_MEDIA_DURATION_SECONDS = 45 * 60
MAX_VIDEO_FRAMES = 4
FFMPEG_TIMEOUT_SECONDS = 120.0
FFPROBE_TIMEOUT_SECONDS = 20.0

_AUDIO_EXTENSIONS = {
    ".aac",
    ".flac",
    ".m4a",
    ".mp3",
    ".oga",
    ".ogg",
    ".wav",
    ".wave",
}
_VIDEO_EXTENSIONS = {
    ".avi",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".webm",
}
_DIRECT_AUDIO_FORMATS = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
}
_AUDIO_MIME_PREFIXES = ("audio/",)
_VIDEO_MIME_PREFIXES = ("video/",)


class MediaProcessingError(RuntimeError):
    """User-safe failure while inspecting or transcoding uploaded media."""


@dataclass(frozen=True, slots=True)
class MediaKind:
    is_audio: bool
    is_video: bool
    extension: str
    mime_type: str

    @property
    def is_media(self) -> bool:
        return self.is_audio or self.is_video

    @property
    def label(self) -> str:
        if self.is_video:
            return "Video"
        if self.is_audio:
            return "Audio"
        return "File"


@dataclass(frozen=True, slots=True)
class PreparedAudio:
    """One model-ready audio slice plus optional stills from the same file."""

    chunks: tuple[bytes, ...]
    audio_format: str
    duration_seconds: float | None
    frames: tuple[bytes, ...]
    had_audio_track: bool
    used_ffmpeg: bool


def classify_media(filename: str, mime_type: str | None = None) -> MediaKind:
    extension = _extension(filename)
    guessed = (mime_type or mimetypes.guess_type(filename)[0] or "").split(";", 1)[0]
    guessed = guessed.strip().lower()
    is_video = extension in _VIDEO_EXTENSIONS or guessed.startswith(_VIDEO_MIME_PREFIXES)
    is_audio = (not is_video) and (
        extension in _AUDIO_EXTENSIONS or guessed.startswith(_AUDIO_MIME_PREFIXES)
    )
    # audio/webm vs video/webm: the extension is shared, so MIME wins when set.
    if extension == ".webm" and guessed.startswith("audio/"):
        is_video = False
        is_audio = True
    return MediaKind(
        is_audio=is_audio,
        is_video=is_video,
        extension=extension,
        mime_type=guessed,
    )


def direct_audio_format(filename: str, mime_type: str | None = None) -> str | None:
    """Return wav/mp3 when the bytes can be sent without transcoding."""

    kind = classify_media(filename, mime_type)
    if kind.mime_type in _DIRECT_AUDIO_FORMATS:
        return _DIRECT_AUDIO_FORMATS[kind.mime_type]
    if kind.extension in {".wav", ".wave"}:
        return "wav"
    if kind.extension == ".mp3":
        return "mp3"
    return None


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def prepare_media_audio(
    content: bytes,
    filename: str,
    mime_type: str | None = None,
    *,
    extract_frames: bool = True,
) -> PreparedAudio:
    """Return MP3/WAV chunks (and optional video stills) for transcription.

    WAV and MP3 that already fit one dictation-sized request skip ffmpeg so a
    bare-metal API without the binary can still transcribe those uploads.
    Everything else requires ffmpeg and fails closed when it is missing.
    """
    if not content:
        raise MediaProcessingError("The uploaded media file was empty.")
    kind = classify_media(filename, mime_type)
    if not kind.is_media:
        raise MediaProcessingError("That file is not a recognized audio or video format.")

    native_format = direct_audio_format(filename, mime_type)
    if native_format and not kind.is_video and len(content) <= 15 * 1024 * 1024:
        return PreparedAudio(
            chunks=(content,),
            audio_format=native_format,
            duration_seconds=None,
            frames=(),
            had_audio_track=True,
            used_ffmpeg=False,
        )

    if not ffmpeg_available():
        raise MediaProcessingError(
            "This deployment cannot process this media format. Install ffmpeg "
            "in the API environment (it is included in the release image) or "
            "upload a WAV or MP3 file under 15 MB."
        )

    suffix = kind.extension or ".bin"
    with tempfile.TemporaryDirectory(prefix="aperture-media-") as tmp:
        source = Path(tmp) / f"source{suffix}"
        source.write_bytes(content)
        duration = probe_duration_seconds(source)
        if duration is not None and duration > MAX_MEDIA_DURATION_SECONDS:
            limit_minutes = MAX_MEDIA_DURATION_SECONDS // 60
            raise MediaProcessingError(
                f"Media longer than {limit_minutes} minutes cannot be transcribed "
                "in this version. Split the file and upload the portion you need."
            )
        audio_path = Path(tmp) / "speech.mp3"
        had_audio = _extract_mp3(source, audio_path)
        chunks: tuple[bytes, ...] = ()
        if had_audio:
            chunks = _split_or_read_mp3(audio_path, duration)
        frames: tuple[bytes, ...] = ()
        if extract_frames and kind.is_video:
            frames = _extract_frames(source, Path(tmp), duration)
        if not chunks and not frames:
            raise MediaProcessingError(
                "This file has no audio track, and no still frames could be extracted."
            )
        return PreparedAudio(
            chunks=chunks,
            audio_format="mp3",
            duration_seconds=duration,
            frames=frames,
            had_audio_track=had_audio,
            used_ffmpeg=True,
        )


def probe_duration_seconds(source: Path) -> float | None:
    try:
        completed = _run_command(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(source),
            ],
            timeout=FFPROBE_TIMEOUT_SECONDS,
        )
    except MediaProcessingError:
        return None
    raw = (completed.stdout or "").strip()
    if not raw or raw.upper() == "N/A":
        return None
    try:
        duration = float(raw)
    except ValueError:
        return None
    if duration <= 0 or duration != duration:  # NaN
        return None
    return duration


def _extract_mp3(source: Path, dest: Path) -> bool:
    try:
        _run_command(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(source),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "64k",
                str(dest),
            ],
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except MediaProcessingError:
        return False
    return dest.is_file() and dest.stat().st_size > 0


def _split_or_read_mp3(audio_path: Path, duration: float | None) -> tuple[bytes, ...]:
    if duration is None or duration <= AUDIO_CHUNK_SECONDS:
        return (audio_path.read_bytes(),)
    chunks: list[bytes] = []
    start = 0.0
    index = 0
    while start < duration - 0.05:
        part = audio_path.with_name(f"chunk-{index:02d}.mp3")
        _run_command(
            [
                "ffmpeg",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-t",
                str(AUDIO_CHUNK_SECONDS),
                "-i",
                str(audio_path),
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "64k",
                str(part),
            ],
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
        if part.is_file() and part.stat().st_size > 0:
            chunks.append(part.read_bytes())
        start += AUDIO_CHUNK_SECONDS
        index += 1
        if index > 20:
            break
    return tuple(chunks) if chunks else (audio_path.read_bytes(),)


def _extract_frames(source: Path, tmp: Path, duration: float | None) -> tuple[bytes, ...]:
    if duration is None or duration <= 0:
        timestamps = [0.0]
    else:
        count = min(MAX_VIDEO_FRAMES, max(1, int(duration // 15) + 1))
        if count == 1:
            timestamps = [min(1.0, duration / 2)]
        else:
            step = duration / (count + 1)
            timestamps = [step * (index + 1) for index in range(count)]
    frames: list[bytes] = []
    for index, timestamp in enumerate(timestamps):
        dest = tmp / f"frame-{index:02d}.jpg"
        try:
            _run_command(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    f"{max(0.0, timestamp):.3f}",
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "5",
                    str(dest),
                ],
                timeout=FFMPEG_TIMEOUT_SECONDS,
            )
        except MediaProcessingError:
            continue
        if dest.is_file() and dest.stat().st_size > 0:
            frames.append(dest.read_bytes())
    return tuple(frames)


def _run_command(command: list[str], *, timeout: float) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise MediaProcessingError(
            "ffmpeg is not installed in this API environment."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaProcessingError("Media processing timed out.") from exc
    if completed.returncode != 0:
        raise MediaProcessingError("ffmpeg could not read this media file.")
    return completed


def _extension(filename: str) -> str:
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." not in name:
        return ""
    return f".{name.rsplit('.', 1)[-1].lower()}"
