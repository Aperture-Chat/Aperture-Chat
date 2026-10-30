"""Domain-separated digests for stored draft revisions."""

from __future__ import annotations

from hashlib import sha256


def draft_content_digest(sanitizer_version: str, content: str) -> str:
    """SHA-256 of content under its sanitizer id, so one kind's bytes never match another's."""

    prefix = f"aperture-draft-content:{sanitizer_version}:".encode("utf-8")
    return sha256(prefix + content.encode("utf-8")).hexdigest()
