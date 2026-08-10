"""Safe, persistent previews for image attachments.

Chat attachment metadata lives in the application store, while bounded image
previews live beside ``runtime_state.json`` on the same persistent data volume.
The original upload is never exposed directly: Pillow decodes, orients, strips
metadata from, resizes, and re-encodes the first frame as WebP. Preview routes
still enforce the attachment's normal owner and tenant scope.
"""

from __future__ import annotations

import base64
import hashlib
import warnings
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.config import get_settings

MAX_PREVIEW_EDGE = 1600
MAX_SOURCE_PIXELS = 50_000_000
PREVIEW_MEDIA_TYPE = "image/webp"


def attachment_previews_dir() -> Path:
    return Path(get_settings().runtime_state_path).parent / "chat_attachment_previews"


def _preview_path(attachment_id: str) -> Path:
    digest = hashlib.sha256(attachment_id.encode("utf-8")).hexdigest()
    return attachment_previews_dir() / f"{digest}.webp"


def save_attachment_preview(attachment_id: str, content: bytes, mime_type: str) -> bool:
    """Persist a safe, bounded preview when ``content`` is a supported image.

    Invalid, oversized, and unsupported image payloads simply return ``False``
    so the attachment can retain its honest generic-file fallback.
    """

    normalized_mime = mime_type.split(";", 1)[0].strip().lower()
    if not normalized_mime.startswith("image/") or normalized_mime == "image/svg+xml":
        return False
    if not content:
        return False

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as source:
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_SOURCE_PIXELS:
                    return False
                if getattr(source, "is_animated", False):
                    source.seek(0)
                source.load()
                preview = ImageOps.exif_transpose(source)
                preview.thumbnail(
                    (MAX_PREVIEW_EDGE, MAX_PREVIEW_EDGE),
                    Image.Resampling.LANCZOS,
                )
                has_alpha = "A" in preview.getbands() or "transparency" in preview.info
                preview = preview.convert("RGBA" if has_alpha else "RGB")

                directory = attachment_previews_dir()
                directory.mkdir(parents=True, exist_ok=True)
                path = _preview_path(attachment_id)
                temporary = path.with_suffix(".webp.tmp")
                preview.save(temporary, format="WEBP", quality=86, method=4)
                temporary.replace(path)
        return True
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        UnidentifiedImageError,
        OSError,
        ValueError,
    ):
        return False


def delete_attachment_preview(attachment_id: str) -> None:
    """Remove a stored preview file; a missing file is already the goal.

    The preview is the only stored copy of an uploaded image, so purging the
    attachment record without this call would leave the user's image content
    orphaned on the data volume forever.
    """

    if not attachment_id:
        return
    try:
        _preview_path(attachment_id).unlink(missing_ok=True)
    except OSError:  # pragma: no cover - best effort; the row is already gone
        pass


def attachment_preview_file(attachment_id: str) -> tuple[Path, str] | None:
    """Resolve a previously generated preview, or ``None`` when unavailable."""

    if not attachment_id:
        return None
    path = _preview_path(attachment_id)
    if not path.is_file():
        return None
    return path, PREVIEW_MEDIA_TYPE


def attachment_preview_data_url(attachment_id: str) -> str | None:
    """Base64 data URL of the sanitized preview, sized for provider vision input.

    The preview is the only stored copy of an uploaded image (originals are
    never persisted), so it is also what gets sent to image-capable models.
    """

    resolved = attachment_preview_file(attachment_id)
    if resolved is None:
        return None
    path, media_type = resolved
    try:
        content = path.read_bytes()
    except OSError:
        return None
    if not content:
        return None
    encoded = base64.b64encode(content).decode("ascii")
    return f"data:{media_type};base64,{encoded}"
