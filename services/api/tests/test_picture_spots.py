from __future__ import annotations

import logging
from concurrent.futures import Future

import pytest

from app.core.picture_spots import MAX_PICTURE_SPOTS, PictureSpots


def _done(value: str) -> Future[str]:
    future: Future[str] = Future()
    future.set_result(value)
    return future


def _spots(started: list[str], futures: dict[str, Future[str]] | None = None) -> PictureSpots[str]:
    def start(description: str) -> Future[str]:
        started.append(description)
        return (futures or {}).get(description) or _done(f"photo of {description}")

    return PictureSpots(start, lambda description, found: f"![{description}]({found})")


def _all(spots: PictureSpots[str], *chunks: str) -> str:
    out = "".join(spots.feed(chunk) for chunk in chunks)
    return out + "".join(piece for piece in spots.close(tick_seconds=0.01) if piece)


def test_a_spot_line_becomes_the_picture_and_other_text_passes_unchanged() -> None:
    started: list[str] = []
    text = _all(_spots(started), "Intro line.\n", "[[Picture: Napoleon at Austerlitz, 1805]]\n", "After.\n")

    assert started == ["Napoleon at Austerlitz, 1805"]
    assert text == "Intro line.\n\n![Napoleon at Austerlitz, 1805](photo of Napoleon at Austerlitz, 1805)\n\nAfter.\n"


def test_a_spot_split_across_chunks_is_still_found() -> None:
    started: list[str] = []
    text = _all(_spots(started), "Text\n  [[Pic", "ture: Elba harbour", " in 1814]]  ", "\nMore")

    assert started == ["Elba harbour in 1814"]
    assert "[[Picture" not in text
    assert text.endswith("\nMore")


def test_ordinary_lines_stream_without_waiting_for_their_end() -> None:
    spots = _spots([])

    assert spots.feed("The emperor") == "The emperor"
    assert spots.feed(" returned [[Picture: not a spot]] mid-line") == " returned [[Picture: not a spot]] mid-line"


def test_a_line_that_only_starts_like_a_spot_is_released_once_it_differs() -> None:
    spots = _spots([])

    assert spots.feed("[[Pi") == ""
    assert spots.feed("ng]] is a wiki link") == "[[Ping]] is a wiki link"


def test_text_after_an_unfinished_picture_waits_in_order() -> None:
    pending: Future[str] = Future()
    spots = _spots([], {"Waterloo": pending})

    assert spots.feed("Before\n[[Picture: Waterloo]]\nAfter\n") == "Before\n"
    assert spots.feed("Later\n") == ""
    pending.set_result("found")
    assert spots.feed("") == "\n![Waterloo](found)\n\nAfter\nLater\n"


def test_close_waits_for_pending_pictures_and_reports_ticks() -> None:
    pending: Future[str] = Future()
    spots = _spots([], {"Saint Helena": pending})
    spots.feed("[[Picture: Saint Helena]]")
    pieces = spots.close(tick_seconds=0.01)

    assert next(pieces) is None
    pending.set_result("island")
    assert "".join(piece for piece in pieces if piece) == "\n![Saint Helena](island)\n\n"


def test_a_failed_lookup_renders_through_the_same_hook() -> None:
    failed: Future[str] = Future()
    failed.set_exception(RuntimeError("down"))
    spots = PictureSpots(lambda description: failed, lambda description, found: f"[{description}: {found}]")

    assert _all(spots, "[[Picture: Corsica]]\n") == "\n[Corsica: None]\n\n"


def test_spots_past_the_cap_are_left_out_with_a_note() -> None:
    started: list[str] = []
    lines = "".join(f"[[Picture: scene {index}]]\n" for index in range(MAX_PICTURE_SPOTS + 1))
    text = _all(_spots(started), lines)

    assert len(started) == MAX_PICTURE_SPOTS
    assert f"scene {MAX_PICTURE_SPOTS}" in text
    assert text.count("![") == MAX_PICTURE_SPOTS
    assert "[[Picture" not in text


@pytest.mark.parametrize(
    "line",
    [
        "- [[Picture: Elba harbour]]\n",
        "* [[Picture: Elba harbour]]\n",
        "2. [[Picture: Elba harbour]]\n",
        "> [[Picture: Elba harbour]]\n",
        "**[[Picture: Elba harbour]]**\n",
        "*[[Picture: Elba harbour]]*\n",
        "[[Picture: Elba harbour]].\n",
        "[[Picture: Elba harbour]]\r\n",
    ],
)
def test_a_spot_written_as_a_list_item_quote_or_emphasis_is_still_a_spot(line: str) -> None:
    started: list[str] = []
    text = _all(_spots(started), "Before\n", line, "After\n")

    assert started == ["Elba harbour"]
    assert "[[Picture" not in text
    assert text.startswith("Before\n") and text.endswith("After\n")


def test_a_decorated_spot_streamed_a_few_characters_at_a_time_is_still_a_spot() -> None:
    started: list[str] = []
    line = "1. **[[Picture: Elba harbour]]**\r\n"
    text = _all(_spots(started), *line)

    assert started == ["Elba harbour"]
    assert "[[Picture" not in text


def test_ordinary_list_items_and_bold_lines_still_stream_at_once() -> None:
    spots = _spots([])

    assert spots.feed("- Napoleon") == "- Napoleon"
    spots.feed("\n")
    assert spots.feed("**Exile") == "**Exile"


def test_abandon_releases_waiting_text_and_says_pending_pictures_were_not_added() -> None:
    pending: Future[str] = Future()
    spots = _spots([], {"Waterloo": pending})

    assert spots.feed("Before\n[[Picture: Waterloo]]\nAfter\n[[Pic") == "Before\n"
    text = spots.abandon()

    assert "Waterloo" in text and "not added" in text
    assert text.endswith("After\n")
    assert "[[Pic" not in text
    assert spots.abandon() == ""


def test_abandon_shows_pictures_already_found_and_releases_an_unfinished_ordinary_line() -> None:
    pending: Future[str] = Future()
    spots = _spots([], {"Waterloo": pending})
    spots.feed("[[Picture: Waterloo]]\n[[Picture: Corsica]]\nThe emp")

    text = spots.abandon()

    assert "![Corsica](photo of Corsica)" in text
    assert text.endswith("The emp")


def test_shown_is_everything_the_reader_was_sent() -> None:
    spots = _spots([])
    text = _all(spots, "Intro\n", "[[Picture: Corsica]]\n", "End")

    assert spots.shown == text
    assert "[[Picture" not in spots.shown


def test_a_failed_lookup_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    failed: Future[str] = Future()
    failed.set_exception(RuntimeError("down"))
    spots = PictureSpots(lambda description: failed, lambda description, found: "")

    with caplog.at_level(logging.WARNING, logger="app.core.picture_spots"):
        _all(spots, "[[Picture: Corsica]]\n")

    assert any("Corsica" in record.getMessage() for record in caplog.records)
