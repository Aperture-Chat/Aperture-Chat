from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.models import deck_document as deck
from app.models.deck_document import (
    DeckValidationError,
    canonicalize_deck_json,
    deck_background_key,
    deck_content_sha256,
    deck_plain_text,
)

FIXTURES = Path(__file__).parent / "fixtures" / "deck-v1"
PNG = "data:image/png;base64,iVBORw0KGgo="


def _deck(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema": "aperture-deck-v1",
        "title": "Quarterly review",
        "theme": {"colors": {"accent1": "#ABCDEF"}, "fonts": {"major": "Georgia"}},
        "slides": [
            {"id": "s1", "layout": "title", "title": "Quarterly review", "subtitle": [{"text": "Q3", "bold": False}], "notes": "Welcome everyone"},
            {
                "id": "s2",
                "layout": "title-bullets",
                "title": [{"text": "Highlights", "sizePt": 30.4, "color": "#FF0000"}],
                "bullets": [{"runs": [{"text": "Revenue up"}], "level": 0}, {"runs": [{"text": "Churn down"}], "level": 1}],
                "boxes": {"title": {"x": -5, "y": 10.6, "w": 5000, "h": 100}, "bogus": {"x": 1, "y": 1, "w": 1, "h": 1}},
                "unknownKey": "dropped",
            },
        ],
    }
    base.update(overrides)
    return base


def test_canonical_form_is_idempotent_sorted_and_drops_unknown_keys() -> None:
    first = canonicalize_deck_json(json.dumps(_deck()))
    second = canonicalize_deck_json(first)
    assert first == second
    parsed = json.loads(first)
    assert list(parsed.keys()) == sorted(parsed.keys())
    assert "unknownKey" not in json.dumps(parsed)
    slide = parsed["slides"][1]
    assert slide["title"][0]["sizePt"] == 30
    assert slide["title"][0]["color"] == "#ff0000"
    assert slide["boxes"] == {"title": {"x": 0, "y": 11, "w": 960, "h": 100}}
    assert parsed["theme"]["colors"]["accent1"] == "#abcdef"
    assert parsed["theme"]["colors"]["background"] == "#ffffff"
    assert parsed["slides"][0]["subtitle"] == [{"bold": False, "text": "Q3"}]
    assert deck_content_sha256(first) == deck_content_sha256(second)


def test_pictures_must_be_https_or_bounded_data_images() -> None:
    bad = _deck(slides=[{"layout": "image-caption", "title": "x", "image": {"src": "javascript:alert(1)", "alt": ""}, "caption": ""}])
    with pytest.raises(DeckValidationError, match="image.src"):
        canonicalize_deck_json(json.dumps(bad))
    http = _deck(slides=[{"layout": "image-caption", "title": "x", "image": {"src": "http://example.com/a.png", "alt": ""}, "caption": ""}])
    with pytest.raises(DeckValidationError):
        canonicalize_deck_json(json.dumps(http))
    ok = _deck(slides=[{"layout": "image-caption", "title": "x", "image": {"src": "https://example.com/a.png", "alt": "A"}, "caption": "cap"}])
    assert '"src":"https://example.com/a.png"' in canonicalize_deck_json(json.dumps(ok))

    svg_background = _deck(slides=[{"layout": "section", "title": "x", "subtitle": "", "background": {"dataUrl": "data:image/svg+xml;base64,PHN2Zz4="}}])
    with pytest.raises(DeckValidationError, match="background"):
        canonicalize_deck_json(json.dumps(svg_background))


def test_inline_background_migrates_into_the_shared_library() -> None:
    migrated = json.loads(
        canonicalize_deck_json(
            json.dumps(_deck(slides=[{"layout": "section", "title": "x", "subtitle": "", "background": {"dataUrl": PNG}}]))
        )
    )
    key = deck_background_key(PNG)
    assert migrated["theme"]["backgroundLibrary"] == {key: PNG}
    assert migrated["slides"][0]["backgroundId"] == key
    assert "background" not in migrated["slides"][0]
    dangling = json.loads(
        canonicalize_deck_json(json.dumps(_deck(slides=[{"layout": "section", "title": "x", "subtitle": "", "backgroundId": "missing"}])))
    )
    assert "backgroundId" not in dangling["slides"][0]


def test_structural_bounds_and_schema_are_enforced() -> None:
    with pytest.raises(DeckValidationError, match="schema"):
        canonicalize_deck_json(json.dumps(_deck(schema="other")))
    with pytest.raises(DeckValidationError, match="valid JSON"):
        canonicalize_deck_json("{not json")
    too_many = _deck(slides=[{"layout": "section", "title": "x", "subtitle": ""}] * 101)
    with pytest.raises(DeckValidationError, match="limited to 100 slides"):
        canonicalize_deck_json(json.dumps(too_many))
    with pytest.raises(DeckValidationError, match="layout"):
        canonicalize_deck_json(json.dumps(_deck(slides=[{"layout": "hero"}])))
    truncated = json.loads(
        canonicalize_deck_json(
            json.dumps(_deck(slides=[{"layout": "title-bullets", "title": "x", "bullets": [{"runs": [{"text": "b"}], "level": 0}] * 12}]))
        )
    )
    assert len(truncated["slides"][0]["bullets"]) == 8
    with pytest.raises(DeckValidationError, match="exceeds 2000"):
        canonicalize_deck_json(json.dumps(_deck(slides=[{"layout": "closing", "title": "x", "body": "y" * 2001}])))
    huge = _deck(slides=[{"layout": "section", "title": "x", "subtitle": "", "notes": "n" * 4000}] * 100)
    payload = json.dumps(huge)
    assert len(payload.encode()) < deck.MAX_DECK_CONTENT_BYTES
    with pytest.raises(DeckValidationError, match="content limit"):
        canonicalize_deck_json("{" + " " * deck.MAX_DECK_CONTENT_BYTES + "}")


def test_duplicate_and_invalid_slide_ids_are_repaired() -> None:
    parsed = json.loads(
        canonicalize_deck_json(
            json.dumps(_deck(slides=[
                {"id": "dup", "layout": "section", "title": "a", "subtitle": ""},
                {"id": "dup", "layout": "section", "title": "b", "subtitle": ""},
                {"id": "not valid!", "layout": "section", "title": "c", "subtitle": ""},
            ]))
        )
    )
    assert [slide["id"] for slide in parsed["slides"]] == ["dup", "dup-x", "slide-r3"]


def test_plain_text_covers_title_runs_bullets_and_notes() -> None:
    text = deck_plain_text(canonicalize_deck_json(json.dumps(_deck())))
    for expected in ("Quarterly review", "Q3", "Highlights", "Revenue up", "Churn down", "Welcome everyone"):
        assert expected in text
    assert "#ff0000" not in text
    assert deck_plain_text("not json") == ""


def test_constants_are_pinned_to_the_client_fixture() -> None:
    limits = json.loads((FIXTURES / "limits.json").read_text())
    assert limits["schema"] == deck.DECK_SCHEMA_VERSION
    assert limits["sanitizer_version"] == deck.DECK_SANITIZER_VERSION
    assert limits["max_content_bytes"] == deck.MAX_DECK_CONTENT_BYTES
    assert limits["max_slides"] == deck.MAX_DECK_SLIDES
    assert limits["max_bullets_per_slide"] == deck.MAX_DECK_BULLETS_PER_SLIDE
    assert limits["max_slide_background_chars"] == deck.MAX_SLIDE_BACKGROUND_CHARS
    assert limits["max_background_library_entries"] == deck.MAX_BACKGROUND_LIBRARY_ENTRIES
    assert set(limits["layouts"]) == deck.DECK_LAYOUTS


def test_background_key_matches_the_client_fnv_variant() -> None:
    # Reference values computed with the client's deckBackgroundKey.
    assert deck_background_key("abc") == "bg1a47e90b-3"
    assert deck_background_key(PNG) == "bgb9764a8c-y"
