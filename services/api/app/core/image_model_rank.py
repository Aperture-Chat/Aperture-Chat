"""Rank image-generation models, best first, for pictures the server draws."""

from __future__ import annotations

import re

# Among gpt-image and MAI-Image models, best first.
_IMAGE_BACKUP_ORDER = tuple(
    re.compile(pattern)
    for pattern in (
        r"^gpt-image-2\.5",
        r"^gpt-image-2(?:$|-(?!mini))",
        r"^mai-image-2\.6$",
        r"^gpt-image-1\.5",
        r"^mai-image-2\.5-pro",
        r"^mai-image-2\.6-flash",
        r"^mai-image-2\.5$",
        r"^gpt-image-1$",
        r"^mai-image-2\.5-flash",
        r"^gpt-image-1-mini",
    )
)
_GEMINI_VERSION = re.compile(r"gemini-(\d+)(?:\.(\d+))?")


def _tail(upstream_model_id: str | None) -> str:
    """Lowercase upstream id without an aggregator vendor prefix."""
    return (upstream_model_id or "").strip().lower().rsplit("/", 1)[-1]


def _backup_rank(tail: str) -> int:
    for index, pattern in enumerate(_IMAGE_BACKUP_ORDER):
        if pattern.search(tail):
            return len(_IMAGE_BACKUP_ORDER) - index
    return 0


def image_model_rank(upstream_model_id: str | None) -> int:
    """Higher is better: Gemini image models first (pro, then newest), then
    the gpt-image and MAI-Image order; 0 for a model it does not know."""
    tail = _tail(upstream_model_id)
    if "gemini" in tail:
        version = _GEMINI_VERSION.search(tail)
        major, minor = (int(version.group(1)), int(version.group(2) or 0)) if version else (0, 0)
        return 1000 + (500 if "pro" in tail else 0) + major * 10 + minor
    backup = _backup_rank(tail)
    return 100 + backup if backup else 0
