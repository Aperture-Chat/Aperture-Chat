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
    assert set(limits["designs"]) == deck.DECK_DESIGNS


def test_background_key_matches_the_client_fnv_variant() -> None:
    # Reference values computed with the client's deckBackgroundKey.
    assert deck_background_key("abc") == "bg1a47e90b-3"
    assert deck_background_key(PNG) == "bgb9764a8c-y"


def test_theme_design_is_kept_classic_is_implicit_and_unknown_drops() -> None:
    def design_of(value: object) -> object:
        parsed = json.loads(canonicalize_deck_json(json.dumps(_deck(theme={"design": value}))))
        return parsed["theme"].get("design", "<absent>")

    assert design_of("orbit") == "orbit"
    # The classic look is stored as no design, so older decks keep their bytes.
    assert design_of("rule") == "<absent>"
    assert design_of("neon-zebra") == "<absent>"
    assert design_of(7) == "<absent>"
    assert "design" not in canonicalize_deck_json(json.dumps(_deck()))


def test_statement_big_number_and_picture_bullets_layouts_canonicalize() -> None:
    slides = [
        {"id": "a", "layout": "statement", "title": "Ship weekly", "body": "Small batches win", "stray": 1},
        {"id": "b", "layout": "big-number", "title": "42%", "subtitle": "of renewals came from referrals"},
        {
            "id": "c",
            "layout": "image-bullets",
            "title": "New office",
            "image": {"src": "", "alt": "Harbor office"},
            "bullets": [{"runs": [{"text": "Opens in May"}], "level": 0}],
        },
    ]
    canonical = canonicalize_deck_json(json.dumps(_deck(slides=slides)))
    parsed = json.loads(canonical)["slides"]
    assert parsed[0] == {"id": "a", "layout": "statement", "notes": "", "title": [{"text": "Ship weekly"}], "body": [{"text": "Small batches win"}]}
    assert parsed[1]["subtitle"] == [{"text": "of renewals came from referrals"}]
    assert parsed[2]["image"] == {"src": "", "alt": "Harbor office"}
    assert parsed[2]["bullets"] == [{"runs": [{"text": "Opens in May"}], "level": 0}]
    text = deck_plain_text(canonical)
    for expected in ("Small batches win", "of renewals came from referrals", "Opens in May", "Harbor office"):
        assert expected in text

    unsafe = _deck(slides=[{"layout": "image-bullets", "title": "x", "image": {"src": "javascript:alert(1)", "alt": ""}, "bullets": []}])
    with pytest.raises(DeckValidationError):
        canonicalize_deck_json(json.dumps(unsafe))


def test_deleted_blocks_are_kept_sorted_and_hold_no_words() -> None:
    slides = [
        {
            "id": "a",
            "layout": "two-column",
            "title": "Compare",
            "left": [{"runs": [{"text": "Hidden words"}], "level": 0}],
            "right": [],
            "removed": ["right", "left", "right", "subtitle", 7, ["left"], {"left": 1}],
        },
        {
            "id": "b",
            "layout": "image-caption",
            "title": "New office",
            "image": {"src": "https://example.com/secret.png", "alt": "Secret"},
            "caption": "Opens in May",
            "removed": ["image"],
            "boxes": {"image": {"x": 10, "y": 20, "w": 300, "h": 200}},
        },
        {"id": "c", "layout": "title", "title": "Kept", "subtitle": "Also kept", "removed": "title"},
        {"id": "d", "layout": "quote", "quote": "Said", "attribution": "By", "removed": []},
    ]
    first = canonicalize_deck_json(json.dumps(_deck(slides=slides)))
    assert canonicalize_deck_json(first) == first
    two_column, picture, cover, quote = json.loads(first)["slides"]
    assert two_column["removed"] == ["left", "right"]
    assert two_column["left"] == [] and two_column["right"] == []
    assert two_column["title"] == [{"text": "Compare"}]
    assert picture["removed"] == ["image"]
    assert picture["image"] == {"alt": "", "src": ""}
    assert picture["caption"] == [{"text": "Opens in May"}]
    # A block comes back where the author had put it, so its box is kept.
    assert picture["boxes"] == {"image": {"x": 10, "y": 20, "w": 300, "h": 200}}
    # A broken or empty list deletes nothing.
    assert "removed" not in cover and cover["subtitle"] == [{"text": "Also kept"}]
    assert "removed" not in quote
    assert "Hidden words" not in first and "secret.png" not in first
    assert "Hidden words" not in deck_plain_text(first)
    assert "removed" not in canonicalize_deck_json(json.dumps(_deck()))


def test_every_layout_can_lose_each_of_its_blocks_and_only_those() -> None:
    expected = {
        "title": ["subtitle", "title"],
        "section": ["subtitle", "title"],
        "big-number": ["subtitle", "title"],
        "title-bullets": ["bullets", "title"],
        "image-bullets": ["bullets", "image", "title"],
        "two-column": ["left", "right", "title"],
        "image-caption": ["caption", "image", "title"],
        "quote": ["attribution", "quote"],
        "chart": ["title"],
        "closing": ["body", "title"],
        "statement": ["body", "title"],
    }
    assert set(expected) == deck.DECK_LAYOUTS
    for layout, blocks in expected.items():
        slide = {
            "id": "s",
            "layout": layout,
            "title": "Heading",
            "subtitle": "Sub",
            "bullets": [],
            "left": [],
            "right": [],
            "quote": "Said",
            "attribution": "By",
            "caption": "Cap",
            "body": "Body",
            "image": {"src": "", "alt": ""},
            "removed": sorted(deck.BOX_REGIONS, reverse=True),
        }
        parsed = json.loads(canonicalize_deck_json(json.dumps(_deck(slides=[slide]))))["slides"][0]
        assert parsed["removed"] == blocks, layout


SPOT = {"x": 80, "y": 300, "w": 400, "h": 120}


def _slides(deck_json: str) -> list[dict[str, object]]:
    return json.loads(deck_json)["slides"]


def test_added_blocks_are_kept_in_order_and_unusable_ones_dropped() -> None:
    added = [
        {"id": "text-1", "box": {"x": -40, "y": 530, "w": 5000, "h": 2}, "text": "Plain words", "stray": 1},
        {"id": "text-1", "box": SPOT, "text": "Same name again"},
        {"id": "title", "box": SPOT, "text": "A layout name"},
        {"id": "list-1", "box": SPOT},
        {"id": "picture-1", "box": SPOT},
        {"id": "text-2", "text": "No box"},
        {"id": "text-3", "box": {"x": "left", "y": 0, "w": 10, "h": 10}, "text": "Bad box"},
        {"id": "text-4\n", "box": SPOT, "text": "Trailing newline in the name"},
        {"id": "xtext-5", "box": SPOT, "text": "Bad prefix"},
        {"id": 7, "box": SPOT},
        "text-6",
        {"id": "list-2", "box": SPOT, "bullets": [{"runs": [{"text": "A point", "bold": True}], "level": 1}]},
        {"id": "picture-2", "box": SPOT, "image": {"src": "https://example.com/a.png", "alt": "Chart of results"}},
    ]
    slide = {"id": "a", "layout": "title", "title": "Cover", "subtitle": "", "added": added}
    first = canonicalize_deck_json(json.dumps(_deck(slides=[slide])))
    assert canonicalize_deck_json(first) == first
    assert _slides(first)[0]["added"] == [
        {"box": {"h": 24, "w": 960, "x": 0, "y": 516}, "id": "text-1", "text": [{"text": "Plain words"}]},
        {"box": SPOT, "bullets": [], "id": "list-1"},
        {"box": SPOT, "id": "picture-1", "image": {"alt": "", "src": ""}},
        {"box": SPOT, "bullets": [{"level": 1, "runs": [{"bold": True, "text": "A point"}]}], "id": "list-2"},
        {"box": SPOT, "id": "picture-2", "image": {"alt": "Chart of results", "src": "https://example.com/a.png"}},
    ]
    text = deck_plain_text(first)
    for expected in ("Cover", "Plain words", "A point", "Chart of results"):
        assert expected in text
    assert "Same name again" not in text

    for broken in ("text-1", {}, None, []):
        parsed = _slides(canonicalize_deck_json(json.dumps(_deck(slides=[{**slide, "added": broken}]))))[0]
        assert "added" not in parsed
    assert "added" not in canonicalize_deck_json(json.dumps(_deck()))


def test_added_blocks_are_bounded_and_their_content_is_checked() -> None:
    def with_added(added: object) -> str:
        slide = {"id": "a", "layout": "statement", "title": "x", "body": "", "added": added}
        return canonicalize_deck_json(json.dumps(_deck(slides=[slide])))

    many = [{"id": f"text-{index + 1}", "box": SPOT, "text": ""} for index in range(deck.MAX_DECK_ADDED_BLOCKS)]
    # Past the limit a block is dropped unread, even an unsafe one.
    extra = {"id": "picture-1", "box": SPOT, "image": {"src": "javascript:alert(1)", "alt": ""}}
    kept = _slides(with_added([*many, extra]))[0]["added"]
    assert [block["id"] for block in kept] == [f"text-{index + 1}" for index in range(12)]  # type: ignore[index, union-attr]

    with pytest.raises(DeckValidationError, match=r"added\[0\].image.src"):
        with_added([extra])
    with pytest.raises(DeckValidationError, match=r"added\[1\].text"):
        with_added([many[0], {"id": "text-2", "box": SPOT, "text": 7}])
    with pytest.raises(DeckValidationError, match=r"added\[0\].bullets"):
        with_added([{"id": "list-1", "box": SPOT, "bullets": "x"}])
    with pytest.raises(DeckValidationError, match="exceeds 2000"):
        with_added([{"id": "text-1", "box": SPOT, "text": "y" * 2001}])


def test_an_added_blocks_box_is_pulled_back_onto_the_slide_from_any_side() -> None:
    def box_of(box: object) -> object:
        slide = {"id": "a", "layout": "statement", "title": "x", "body": "", "added": [{"id": "text-1", "box": box, "text": "x"}]}
        added = _slides(canonicalize_deck_json(json.dumps(_deck(slides=[slide]))))[0].get("added")
        return added[0]["box"] if added else None  # type: ignore[index]

    assert box_of({"x": -5, "y": -7, "w": 100, "h": 50}) == {"x": 0, "y": 0, "w": 100, "h": 50}
    assert box_of({"x": 950, "y": 530, "w": 100, "h": 50}) == {"x": 860, "y": 490, "w": 100, "h": 50}
    assert box_of({"x": True, "y": 0, "w": 100, "h": 50}) is None
    assert box_of([1, 2, 3, 4]) is None
