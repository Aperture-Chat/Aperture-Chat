"""Storage for chat-generated images.

Generated images are decoded from provider data URLs and written to the API
data directory (next to ``runtime_state.json``) so they survive restarts and
container rebuilds that keep the data volume. Files are named with an
unguessable 128-bit hex id; the id doubles as the fetch capability because
browser ``<img>`` tags cannot attach auth headers.
"""

from __future__ import annotations

import base64
import binascii
import re
from pathlib import Path
from uuid import uuid4

from app.core.config import get_settings

_DATA_URL_PATTERN = re.compile(
    r"^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$",
    re.IGNORECASE,
)
_IMAGE_NAME_PATTERN = re.compile(r"^[0-9a-f]{32}\.(png|jpg|webp)$")
_MEDIA_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}


class GeneratedImageError(ValueError):
    """Raised when a provider image payload cannot be decoded or stored."""


def generated_images_dir() -> Path:
    return Path(get_settings().runtime_state_path).parent / "generated_images"


def save_generated_image(data_url: str) -> str:
    """Persist a provider ``data:image/...`` URL and return the stored file name."""
    match = _DATA_URL_PATTERN.match(data_url.strip())
    if not match:
        raise GeneratedImageError("Provider returned an unsupported image payload.")
    extension = match.group(1).lower()
    if extension == "jpeg":
        extension = "jpg"
    try:
        content = base64.b64decode(re.sub(r"\s+", "", match.group(2)))
    except (binascii.Error, ValueError) as exc:
        raise GeneratedImageError("Provider returned malformed base64 image data.") from exc
    if not content:
        raise GeneratedImageError("Provider returned an empty image payload.")
    directory = generated_images_dir()
    directory.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}.{extension}"
    (directory / name).write_bytes(content)
    return name


def generated_image_file(image_name: str) -> tuple[Path, str] | None:
    """Resolve a stored image by name; ``None`` when the name is invalid or missing."""
    match = _IMAGE_NAME_PATTERN.match(image_name)
    if not match:
        return None
    path = generated_images_dir() / image_name
    if not path.is_file():
        return None
    return path, _MEDIA_TYPES[match.group(1)]
