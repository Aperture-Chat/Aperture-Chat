"""Persistent, signed downloads produced by sandboxed response actions."""

from __future__ import annotations

import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from app.core.config import get_settings

ARTIFACT_RETENTION_SECONDS = 7 * 24 * 60 * 60
MAX_ARTIFACTS_PER_RUN = 8
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
MAX_ARTIFACT_TOTAL_BYTES = 75 * 1024 * 1024

_SAFE_EXTENSION = re.compile(r"^\.[a-z0-9]{1,10}$")
_MEDIA_TYPES = {
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
}
_STORED_NAME = re.compile(r"^[0-9a-f]{32}\.[a-z0-9]{1,10}$")


@dataclass(frozen=True)
class StoredArtifact:
    stored_name: str
    filename: str
    mime_type: str
    size_bytes: int


class GeneratedArtifactError(ValueError):
    """Raised when a response action emits an unsafe or oversized artifact."""


def generated_artifacts_dir() -> Path:
    return Path(get_settings().runtime_state_path).parent / "generated_artifacts"


def _safe_filename(value: str) -> str:
    name = Path(value).name.strip().replace("\x00", "")
    name = re.sub(r"[^A-Za-z0-9._ -]+", "-", name).strip(" .-")
    return name[:180] or "response-action-output"


def _prune_expired(directory: Path) -> None:
    cutoff = time.time() - ARTIFACT_RETENTION_SECONDS
    for path in directory.iterdir():
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            continue


def persist_generated_artifact(source: Path) -> StoredArtifact:
    """Copy one sandbox output into durable storage and return safe metadata."""
    if source.is_symlink() or not source.is_file():
        raise GeneratedArtifactError("Response action artifacts must be regular files.")
    size = source.stat().st_size
    if size <= 0:
        raise GeneratedArtifactError("Response action produced an empty artifact.")
    if size > MAX_ARTIFACT_BYTES:
        raise GeneratedArtifactError("Response action artifact exceeds the 50 MB limit.")
    filename = _safe_filename(source.name)
    extension = Path(filename).suffix.lower()
    if extension not in _MEDIA_TYPES or not _SAFE_EXTENSION.match(extension):
        raise GeneratedArtifactError(
            "Response action artifact type is not supported. "
            "Use pptx, docx, xlsx, pdf, csv, json, txt, zip, png, jpg, or jpeg."
        )
    directory = generated_artifacts_dir()
    directory.mkdir(parents=True, exist_ok=True)
    _prune_expired(directory)
    stored_name = f"{uuid4().hex}{extension}"
    shutil.copyfile(source, directory / stored_name)
    return StoredArtifact(
        stored_name=stored_name,
        filename=filename,
        mime_type=_MEDIA_TYPES[extension],
        size_bytes=size,
    )


def generated_artifact_file(stored_name: str) -> tuple[Path, str] | None:
    if not _STORED_NAME.match(stored_name):
        return None
    path = generated_artifacts_dir() / stored_name
    if not path.is_file():
        return None
    extension = path.suffix.lower()
    media_type = _MEDIA_TYPES.get(extension)
    return (path, media_type) if media_type else None
