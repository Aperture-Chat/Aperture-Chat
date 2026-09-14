"""Server-side canonical form for slide decks stored as drafts.

Mirrors ``apps/web/src/lib/deck/deckModel.ts`` (``parseSlideDeck`` +
``serializeSlideDeck``): the browser validates for a good editing experience,
this module is the authority for what may be persisted. Anything executable or
external is refused (only ``https:`` picture links and bounded ``data:image``
payloads survive), unknown keys are dropped, and the output is key-sorted
compact JSON so identical decks always hash identically.

The constants below are pinned to the client by ``tests/test_deck_document.py``
through the shared fixture under ``tests/fixtures/deck-v1``.
"""

from __future__ import annotations

import json
import re
from hashlib import sha256
from typing import Any

DECK_SCHEMA_VERSION = "aperture-deck-v1"
DECK_SANITIZER_VERSION = "deck-json-v1"
MAX_DECK_CONTENT_BYTES = 8_000_000
MAX_DECK_SLIDES = 100
MAX_DECK_BULLETS_PER_SLIDE = 8
MAX_RUN_TEXT_CHARS = 2000
MAX_NOTES_CHARS = 4000
MAX_TITLE_CHARS = 300
MAX_CAPTION_CHARS = 500
MAX_IMAGE_ALT_CHARS = 500
MAX_MERMAID_CHARS = 8000
MAX_SLIDE_BACKGROUND_CHARS = 900_000
MAX_LOGO_CHARS = 700_000
MAX_DECK_BACKGROUND_CHARS = 1_200_000
MAX_BACKGROUND_LIBRARY_ENTRIES = 60
MAX_FONT_CHARS = 100
MAX_SOURCE_LABEL_CHARS = 200
SLIDE_WIDTH = 960
SLIDE_HEIGHT = 540
BOX_MIN_W = 40
BOX_MIN_H = 24

DECK_LAYOUTS = frozenset(
    {"title", "title-bullets", "two-column", "image-caption", "quote", "section", "chart", "closing"}
)
BOX_REGIONS = frozenset(
    {"title", "subtitle", "bullets", "left", "right", "quote", "attribution", "caption", "body", "image"}
)

_HEX_COLOR = re.compile(r"^#[0-9a-f]{6}$", re.IGNORECASE)
_RUN_FONT_NAME = re.compile(r"^[a-z0-9][a-z0-9 \-]{0,58}$", re.IGNORECASE)
_SLIDE_ID = re.compile(r"^[\w-]{1,60}$")
_IMAGE_SRC = re.compile(r"^(https://|data:image/(png|jpe?g|gif|webp);)", re.IGNORECASE)
_BACKGROUND_DATA_URL = re.compile(r"^data:image/(png|jpe?g);", re.IGNORECASE)

DEFAULT_THEME: dict[str, Any] = {
    "colors": {
        "background": "#ffffff",
        "surface": "#eef4f6",
        "heading": "#0c1a26",
        "body": "#22313f",
        "accent1": "#087d8b",
        "accent2": "#0aa4b5",
    },
    "fonts": {"major": "Plus Jakarta Sans", "minor": "Plus Jakarta Sans"},
    "logo": None,
    "backgroundImage": None,
    "backgroundLibrary": {},
    "sourceLabel": None,
}


class DeckValidationError(ValueError):
    """The submitted deck is not storable; the message is safe to show."""


def deck_content_sha256(content: str) -> str:
    return sha256(
        f"aperture-draft-content:{DECK_SANITIZER_VERSION}:".encode("utf-8") + content.encode("utf-8")
    ).hexdigest()


def canonicalize_deck_json(value: str) -> str:
    """Validate a deck JSON string and return its canonical serialization."""

    if not isinstance(value, str):
        raise TypeError("Deck content must be a string.")
    if len(value.encode("utf-8")) > MAX_DECK_CONTENT_BYTES:
        raise DeckValidationError(
            f"Deck exceeds the {MAX_DECK_CONTENT_BYTES // 1_000_000} MB content limit."
        )
    try:
        candidate = json.loads(value)
    except ValueError as exc:
        raise DeckValidationError("Deck content is not valid JSON.") from exc
    deck = _parse_deck(candidate)
    serialized = json.dumps(deck, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(serialized.encode("utf-8")) > MAX_DECK_CONTENT_BYTES:
        raise DeckValidationError(
            f"Deck exceeds the {MAX_DECK_CONTENT_BYTES // 1_000_000} MB content limit."
        )
    return serialized


def deck_plain_text(canonical: str) -> str:
    """Searchable text of a canonical deck: title, every run, and speaker notes."""

    try:
        deck = json.loads(canonical)
    except ValueError:
        return ""
    if not isinstance(deck, dict):
        return ""
    parts: list[str] = []
    title = deck.get("title")
    if isinstance(title, str) and title.strip():
        parts.append(title.strip())
    for slide in deck.get("slides") or []:
        if not isinstance(slide, dict):
            continue
        for key in ("title", "subtitle", "quote", "attribution", "caption", "body"):
            parts.extend(_run_texts(slide.get(key)))
        for key in ("bullets", "left", "right"):
            for bullet in slide.get(key) or []:
                if isinstance(bullet, dict):
                    parts.extend(_run_texts(bullet.get("runs")))
        image = slide.get("image")
        if isinstance(image, dict) and isinstance(image.get("alt"), str) and image["alt"].strip():
            parts.append(image["alt"].strip())
        notes = slide.get("notes")
        if isinstance(notes, str) and notes.strip():
            parts.append(notes.strip())
    return "\n".join(parts)


def _run_texts(runs: object) -> list[str]:
    if not isinstance(runs, list):
        return []
    return [
        run["text"].strip()
        for run in runs
        if isinstance(run, dict) and isinstance(run.get("text"), str) and run["text"].strip()
    ]


# --- parsing ---------------------------------------------------------------


def _fail(message: str) -> None:
    raise DeckValidationError(message)


def _is_record(value: object) -> bool:
    return isinstance(value, dict)


def _clean_text(value: object, max_chars: int, label: str) -> str:
    if not isinstance(value, str):
        _fail(f"{label} must be a string")
    assert isinstance(value, str)
    if len(value) > max_chars:
        _fail(f"{label} exceeds {max_chars} characters")
    return value.replace("\x00", "")


def _parse_run(value: object, label: str) -> dict[str, Any]:
    if not _is_record(value):
        _fail(f"{label} must be an object")
    assert isinstance(value, dict)
    run: dict[str, Any] = {"text": _clean_text(value.get("text"), MAX_RUN_TEXT_CHARS, f"{label}.text")}
    for flag in ("bold", "italic", "underline", "strike"):
        flag_value = value.get(flag)
        if flag_value is True:
            run[flag] = True
        elif flag_value is False and flag in {"bold", "italic"}:
            run[flag] = False
        elif flag_value is not None and flag_value is not False:
            _fail(f"{label}.{flag} must be a boolean")
    color = value.get("color")
    if color is not None:
        if isinstance(color, str) and _HEX_COLOR.match(color):
            run["color"] = color.lower()
        else:
            _fail(f"{label}.color must be #RRGGBB")
    size = value.get("sizePt")
    if size is not None:
        if isinstance(size, (int, float)) and not isinstance(size, bool) and 8 <= size <= 96:
            run["sizePt"] = int(round(size))
        else:
            _fail(f"{label}.sizePt must be between 8 and 96")
    font = value.get("font")
    if font is not None:
        cleaned = " ".join(font.split()) if isinstance(font, str) else ""
        if _RUN_FONT_NAME.match(cleaned):
            run["font"] = cleaned
        else:
            _fail(f"{label}.font must be a plain font family name")
    return run


def _parse_rich_text(value: object, max_chars: int, label: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, str):
        text = _clean_text(value, max_chars, label)
        return [{"text": text}] if text else []
    if not isinstance(value, list):
        _fail(f"{label} must be text or a list of text runs")
    assert isinstance(value, list)
    runs = [_parse_run(run, f"{label}[{index}]") for index, run in enumerate(value)]
    runs = [run for run in runs if run["text"]]
    if sum(len(run["text"]) for run in runs) > max_chars:
        _fail(f"{label} exceeds {max_chars} characters")
    return runs


def _parse_bullets(value: object, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        _fail(f"{label} must be an array")
    assert isinstance(value, list)
    items = value[:MAX_DECK_BULLETS_PER_SLIDE]
    bullets: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        if not _is_record(item):
            _fail(f"{label}[{index}] must be an object")
        assert isinstance(item, dict)
        level = item.get("level", 0)
        if level not in (0, 1, 2) or isinstance(level, bool):
            _fail(f"{label}[{index}].level must be 0, 1, or 2")
        runs_raw = item.get("runs")
        if not isinstance(runs_raw, list):
            _fail(f"{label}[{index}].runs must be an array")
        assert isinstance(runs_raw, list)
        runs = [_parse_run(run, f"{label}[{index}].runs[{run_index}]") for run_index, run in enumerate(runs_raw)]
        bullets.append({"runs": runs, "level": int(level)})
    return bullets


def _parse_image_ref(value: object, label: str) -> dict[str, str]:
    if not _is_record(value):
        _fail(f"{label} must be an object")
    assert isinstance(value, dict)
    src = value.get("src")
    src = src.strip() if isinstance(src, str) else ""
    if src and not _IMAGE_SRC.match(src):
        _fail(f"{label}.src must be https: or a data:image URL")
    if src.lower().startswith("data:") and len(src) > MAX_SLIDE_BACKGROUND_CHARS:
        _fail(f"{label}.src exceeds the inline image size limit")
    alt = _clean_text(value.get("alt", ""), MAX_IMAGE_ALT_CHARS, f"{label}.alt")
    return {"src": src, "alt": alt}


def _bounded_data_image(value: object, max_chars: int) -> str | None:
    if isinstance(value, str) and _BACKGROUND_DATA_URL.match(value) and len(value) <= max_chars:
        return value
    return None


def _parse_background_library(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if not _is_record(value):
        _fail("theme.backgroundLibrary must be an object")
    assert isinstance(value, dict)
    if len(value) > MAX_BACKGROUND_LIBRARY_ENTRIES:
        _fail(f"theme.backgroundLibrary holds more than {MAX_BACKGROUND_LIBRARY_ENTRIES} pictures")
    library: dict[str, str] = {}
    for key, entry in value.items():
        if not isinstance(key, str) or not _SLIDE_ID.match(key):
            _fail("theme.backgroundLibrary contains an invalid picture id")
        picture = _bounded_data_image(entry, MAX_SLIDE_BACKGROUND_CHARS)
        if picture is None:
            _fail(f"theme.backgroundLibrary.{key} must be a bounded data:image/png or jpeg")
        assert picture is not None
        library[key] = picture
    return library


def _parse_theme(value: object) -> dict[str, Any]:
    if not _is_record(value):
        _fail("theme must be an object")
    assert isinstance(value, dict)
    colors = dict(DEFAULT_THEME["colors"])
    colors_raw = value.get("colors") if _is_record(value.get("colors")) else {}
    assert isinstance(colors_raw, dict)
    for key in colors:
        candidate = colors_raw.get(key)
        if candidate is None:
            continue
        if isinstance(candidate, str) and _HEX_COLOR.match(candidate):
            colors[key] = candidate.lower()
        else:
            _fail(f"theme.colors.{key} must be #RRGGBB")
    fonts_raw = value.get("fonts") if _is_record(value.get("fonts")) else {}
    assert isinstance(fonts_raw, dict)
    fonts = {
        "major": _clean_text(
            fonts_raw.get("major", DEFAULT_THEME["fonts"]["major"]), MAX_FONT_CHARS, "theme.fonts.major"
        ),
        "minor": _clean_text(
            fonts_raw.get("minor", DEFAULT_THEME["fonts"]["minor"]), MAX_FONT_CHARS, "theme.fonts.minor"
        ),
    }
    logo: dict[str, Any] | None = None
    logo_raw = value.get("logo")
    if logo_raw is not None:
        picture = _bounded_data_image(logo_raw.get("dataUrl") if _is_record(logo_raw) else None, MAX_LOGO_CHARS)
        width = logo_raw.get("widthPx") if _is_record(logo_raw) else None
        height = logo_raw.get("heightPx") if _is_record(logo_raw) else None
        if picture is None or not _is_number(width) or not _is_number(height):
            _fail("theme.logo must be a bounded data:image/png or jpeg with pixel dimensions")
        assert isinstance(width, (int, float)) and isinstance(height, (int, float))
        logo = {
            "dataUrl": picture,
            "widthPx": max(1, int(round(width))),
            "heightPx": max(1, int(round(height))),
        }
    background_image: dict[str, str] | None = None
    background_raw = value.get("backgroundImage")
    if background_raw is not None:
        picture = _bounded_data_image(
            background_raw.get("dataUrl") if _is_record(background_raw) else None,
            MAX_DECK_BACKGROUND_CHARS,
        )
        if picture is None:
            _fail("theme.backgroundImage must be a bounded data:image/png or jpeg")
        assert picture is not None
        background_image = {"dataUrl": picture}
    library = _parse_background_library(value.get("backgroundLibrary"))
    source_label_raw = value.get("sourceLabel")
    source_label = (
        source_label_raw[:MAX_SOURCE_LABEL_CHARS]
        if isinstance(source_label_raw, str) and source_label_raw.strip()
        else None
    )
    return {
        "colors": colors,
        "fonts": fonts,
        "logo": logo,
        "backgroundImage": background_image,
        "backgroundLibrary": library,
        "sourceLabel": source_label,
    }


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _parse_slide(value: object, index: int, used_ids: set[str]) -> dict[str, Any]:
    label = f"slides[{index}]"
    if not _is_record(value):
        _fail(f"{label} must be an object")
    assert isinstance(value, dict)
    layout = value.get("layout")
    if not isinstance(layout, str) or layout not in DECK_LAYOUTS:
        _fail(f"{label}.layout is not a known slide layout")
    assert isinstance(layout, str)
    raw_id = value.get("id")
    slide_id = raw_id if isinstance(raw_id, str) and _SLIDE_ID.match(raw_id) else f"slide-r{index + 1}"
    while slide_id in used_ids:
        slide_id = f"{slide_id}-x"
    used_ids.add(slide_id)
    slide: dict[str, Any] = {
        "id": slide_id,
        "notes": _clean_text(value.get("notes", ""), MAX_NOTES_CHARS, f"{label}.notes"),
        "layout": layout,
    }

    def title() -> list[dict[str, Any]]:
        return _parse_rich_text(value.get("title"), MAX_TITLE_CHARS, f"{label}.title")

    if layout in {"title", "section"}:
        slide["title"] = title()
        slide["subtitle"] = _parse_rich_text(value.get("subtitle"), MAX_TITLE_CHARS, f"{label}.subtitle")
    elif layout == "title-bullets":
        slide["title"] = title()
        slide["bullets"] = _parse_bullets(value.get("bullets"), f"{label}.bullets")
    elif layout == "two-column":
        slide["title"] = title()
        slide["left"] = _parse_bullets(value.get("left"), f"{label}.left")
        slide["right"] = _parse_bullets(value.get("right"), f"{label}.right")
    elif layout == "image-caption":
        slide["title"] = title()
        slide["image"] = _parse_image_ref(value.get("image"), f"{label}.image")
        slide["caption"] = _parse_rich_text(value.get("caption"), MAX_CAPTION_CHARS, f"{label}.caption")
    elif layout == "quote":
        slide["quote"] = _parse_rich_text(value.get("quote"), MAX_RUN_TEXT_CHARS, f"{label}.quote")
        slide["attribution"] = _parse_rich_text(
            value.get("attribution"), MAX_TITLE_CHARS, f"{label}.attribution"
        )
    elif layout == "chart":
        slide["title"] = title()
        slide["mermaidSource"] = _clean_text(
            value.get("mermaidSource", ""), MAX_MERMAID_CHARS, f"{label}.mermaidSource"
        )
    elif layout == "closing":
        slide["title"] = title()
        slide["body"] = _parse_rich_text(value.get("body"), MAX_RUN_TEXT_CHARS, f"{label}.body")

    text_color = value.get("textColor")
    if text_color is not None:
        if isinstance(text_color, str) and _HEX_COLOR.match(text_color):
            slide["textColor"] = text_color.lower()
        else:
            _fail(f"{label}.textColor must be #RRGGBB")

    boxes_raw = value.get("boxes")
    if _is_record(boxes_raw):
        assert isinstance(boxes_raw, dict)
        boxes: dict[str, dict[str, int]] = {}
        for region, geometry in boxes_raw.items():
            if region not in BOX_REGIONS or not _is_record(geometry):
                continue
            assert isinstance(geometry, dict)
            coords = [geometry.get(key) for key in ("x", "y", "w", "h")]
            if not all(_is_number(coord) for coord in coords):
                continue
            x, y, w, h = (float(coord) for coord in coords)  # type: ignore[arg-type]
            width = int(round(min(max(w, BOX_MIN_W), SLIDE_WIDTH)))
            height = int(round(min(max(h, BOX_MIN_H), SLIDE_HEIGHT)))
            boxes[region] = {
                "x": int(round(min(max(x, 0), SLIDE_WIDTH - width))),
                "y": int(round(min(max(y, 0), SLIDE_HEIGHT - height))),
                "w": width,
                "h": height,
            }
        if boxes:
            slide["boxes"] = boxes
    return slide


def _parse_deck(candidate: object) -> dict[str, Any]:
    if not _is_record(candidate):
        _fail("Deck must be a JSON object.")
    assert isinstance(candidate, dict)
    if candidate.get("schema") != DECK_SCHEMA_VERSION:
        _fail(f'Deck schema must be "{DECK_SCHEMA_VERSION}".')
    title = _clean_text(candidate.get("title", ""), MAX_TITLE_CHARS, "title")
    theme = _parse_theme(candidate.get("theme", DEFAULT_THEME))
    slides_raw = candidate.get("slides")
    if not isinstance(slides_raw, list):
        _fail("Deck slides must be an array.")
    assert isinstance(slides_raw, list)
    if len(slides_raw) > MAX_DECK_SLIDES:
        _fail(f"Decks are limited to {MAX_DECK_SLIDES} slides.")
    used_ids: set[str] = set()
    library: dict[str, str] = dict(theme["backgroundLibrary"])
    slides: list[dict[str, Any]] = []
    for index, raw in enumerate(slides_raw):
        slide = _parse_slide(raw, index, used_ids)
        assert isinstance(raw, dict)
        inline = raw.get("background")
        if inline is not None:
            picture = _bounded_data_image(
                inline.get("dataUrl") if _is_record(inline) else None, MAX_SLIDE_BACKGROUND_CHARS
            )
            if picture is None:
                _fail(f"slides[{index}].background must be a bounded data:image/png or jpeg")
            assert picture is not None
            key = deck_background_key(picture)
            library[key] = picture
            slide["backgroundId"] = key
        else:
            background_id = raw.get("backgroundId")
            if background_id is not None:
                if not isinstance(background_id, str) or not _SLIDE_ID.match(background_id):
                    _fail(f"slides[{index}].backgroundId is not a valid background id")
                elif background_id in library:
                    slide["backgroundId"] = background_id
        slides.append(slide)
    theme["backgroundLibrary"] = library
    return {"schema": DECK_SCHEMA_VERSION, "title": title, "theme": theme, "slides": slides}


def deck_background_key(data_url: str) -> str:
    """FNV-1a content key, identical to the client's ``deckBackgroundKey``."""

    # Data URLs are ASCII, so code points and UTF-16 code units coincide.
    hash_value = 0x811C9DC5
    for char in data_url:
        hash_value ^= ord(char)
        hash_value = (hash_value * 0x01000193) & 0xFFFFFFFF
    return f"bg{hash_value:x}-{_base36(len(data_url))}"


def _base36(value: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    out = ""
    while value:
        value, remainder = divmod(value, 36)
        out = digits[remainder] + out
    return out
