"""Finding a cited passage on the pages of a PDF, and the text view of a document."""

from __future__ import annotations

import pytest

from app.core.document_metadata import PROPERTIES_LOCATOR
from app.core.document_view import (
    PageSpan,
    _PageCorpus,
    find_passage,
    locate_passage,
    match_key,
    recorded_span,
    target_for,
    text_segments,
)
from app.models.schemas import KnowledgeChunk


def _chunk(text: str = "words", ordinal: int = 0, **updates: object) -> KnowledgeChunk:
    values: dict[str, object] = {
        "id": f"chunk-{ordinal}",
        "knowledge_config_id": "kb",
        "document_id": "doc",
        "tenant_id": "tenant",
        "source_name": "doc",
        "source_uri": "upload://doc",
        "source_type": "upload",
        "text": text,
        "ordinal": ordinal,
        "updated_at": "now",
    }
    values.update(updates)
    return KnowledgeChunk(**values)


def _pages(*texts: str) -> list[str]:
    return [match_key(text) for text in texts]


PASSAGE = (
    "The Harlow Creek easement grants the county a thirty foot right of way along the north "
    "bank, measured from the mean high water mark, for the maintenance of the levee."
)


def test_match_key_ignores_case_spacing_punctuation_and_ligatures() -> None:
    assert match_key("The  ﬁnal\nCONVEN-\ntion, 1,250.00") == match_key("the final convention 125000")


def test_match_key_of_punctuation_is_empty() -> None:
    assert match_key(" - , . ") == ""


def test_passage_on_one_page_is_exact() -> None:
    pages = _pages("Filler one.", "Filler two.", f"Before. {PASSAGE} After.", "Filler four.")
    assert find_passage(PASSAGE, pages, 0.5) == PageSpan(3, 3, True)


@pytest.mark.parametrize(
    "rendered",
    [
        PASSAGE.replace("maintenance", "mainte-\nnance"),
        PASSAGE.replace("Harlow", "HARLOW"),
        PASSAGE.replace(" ", "\n"),
        PASSAGE.replace("fo", "ﬀo").replace("ffo", "ﬀo"),
        PASSAGE.replace("right of way", "right­of way"),
    ],
)
def test_rendered_differences_do_not_hide_the_passage(rendered: str) -> None:
    ascii_form = rendered.replace("ﬀ", "f")
    pages = _pages("Filler.", ascii_form)
    assert find_passage(PASSAGE, pages, 0.5).page == 2


def test_passage_running_onto_the_next_page_spans_both() -> None:
    half = len(PASSAGE) // 2
    pages = _pages("Filler.", PASSAGE[:half], PASSAGE[half:], "Filler.")
    assert find_passage(PASSAGE, pages, 0.5) == PageSpan(2, 3, True)


def test_page_footer_in_the_middle_of_a_passage_still_finds_both_pages() -> None:
    half = len(PASSAGE) // 2
    pages = _pages("Filler.", PASSAGE[:half] + " Page 2 of 9", "Survey report " + PASSAGE[half:])
    span = find_passage(PASSAGE, pages, 0.5)
    assert (span.page, span.page_end, span.exact) == (2, 3, True)


def test_repeated_boilerplate_takes_the_nearest_copy_and_admits_the_doubt() -> None:
    pages = _pages(PASSAGE, "Filler.", "Filler.", "Filler.", PASSAGE)
    assert find_passage(PASSAGE, pages, 0.95) == PageSpan(5, 5, False)
    assert find_passage(PASSAGE, pages, 0.0) == PageSpan(1, 1, False)


def test_mostly_changed_text_is_a_guess_at_the_page_that_matched() -> None:
    unmatched = " ".join(f"unmatched{number}" for number in range(60))
    pages = _pages("Filler.", PASSAGE[:100], "Filler.")
    assert find_passage(f"{PASSAGE[:100]} {unmatched}", pages, 0.9) == PageSpan(2, 2, False)


def test_clipped_text_is_certain_when_the_anchors_that_match_all_agree() -> None:
    cell = "agricultural"
    rows = " ".join(
        f"Row {number} {cell} Tamsin county district north lane east {number * 37}"
        for number in range(9)
    )
    pages = _pages("Other sheet.", rows.replace(cell, cell[:-1]))
    assert find_passage(rows, pages, 0.1) == PageSpan(2, 2, True)


def test_anchors_landing_apart_are_not_certain() -> None:
    first = "Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike"
    second = "November oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee"
    third = "Zulu amber birch cedar dogwood elm fir ginkgo hazel ironwood juniper larch maple"
    pages = _pages(first, "Filler.", "Filler.", second + third)
    span = find_passage(f"{first} {second} {third}", pages, 0.5)
    assert span.exact is False


def test_only_the_last_words_of_a_passage_surviving_still_finds_the_page() -> None:
    long_text = " ".join(f"uniqueword{number} measure" for number in range(30))
    tail = long_text[-60:]
    pages = _pages("Filler.", tail, "Filler.", "Filler.")
    assert find_passage(long_text, pages, 0.0).page == 2


def test_passage_mostly_on_its_second_page_reports_the_page_it_starts_on() -> None:
    long_text = " ".join(f"uniqueword{number} measure" for number in range(60))
    split = len(long_text) // 4
    pages = _pages("Filler.", long_text[:split] + " Footer", "Header " + long_text[split:])
    span = find_passage(long_text, pages, 0.5)
    assert (span.page, span.page_end) == (2, 3)


def test_search_for_a_common_string_is_capped() -> None:
    corpus = _PageCorpus(["ab" * 200])
    assert len(corpus.occurrences("ab")) == 64


def test_text_found_nowhere_guesses_from_its_position_in_the_document() -> None:
    pages = _pages(*[f"Filler page {number}" for number in range(1, 11)])
    assert find_passage("Nothing like this appears anywhere at all.", pages, 0.42) == PageSpan(
        5, 5, False
    )
    assert find_passage("Nothing like this appears anywhere at all.", pages, 0.0).page == 1
    assert find_passage("Nothing like this appears anywhere at all.", pages, 1.0).page == 10


def test_short_passage_matches_whole() -> None:
    pages = _pages("Alpha.", "Beta gamma.")
    assert find_passage("Beta gamma", pages, 0.1) == PageSpan(2, 2, True)


def test_empty_inputs_have_no_page() -> None:
    assert find_passage(" . ", _pages("Words."), 0.5) == PageSpan(None, None, False)
    assert find_passage("Words", [], 0.5) == PageSpan(None, None, False)


def test_locate_uses_the_recorded_page_without_reading_any_text() -> None:
    def load_pages() -> list[str]:
        raise AssertionError("a recorded page needs no search")

    chunk = _chunk(page_start=40, page_end=41, locator="Page 40")
    assert locate_passage(chunk, [chunk], load_pages) == PageSpan(40, 41, True)


def test_locate_treats_a_slide_as_a_page() -> None:
    def load_pages() -> list[str]:
        raise AssertionError("a slide number needs no search")

    chunk = _chunk(locator="Slide 7")
    assert locate_passage(chunk, [chunk], load_pages) == PageSpan(7, 7, True)


def test_locate_searches_when_nothing_was_recorded() -> None:
    chunks = [_chunk("Filler chunk.", 0), _chunk(PASSAGE, 1)]
    pages = _pages("Filler chunk.", PASSAGE)
    assert locate_passage(chunks[1], chunks, lambda: pages) == PageSpan(2, 2, True)


def test_locate_estimates_position_from_the_body_chunks_only() -> None:
    chunks = [
        *[_chunk(f"Body number {index}.", index) for index in range(9)],
        _chunk("Nothing like this is on any page anywhere.", 9),
        _chunk("Title: x", 10, locator=PROPERTIES_LOCATOR),
    ]
    pages = _pages(*[f"Page body {index}" for index in range(10)])
    assert locate_passage(chunks[9], chunks, lambda: pages).page == 10


def test_locate_guesses_from_how_far_through_the_chunks_the_passage_is() -> None:
    chunks = [_chunk(f"Body number {index}.", index) for index in range(5)]
    chunks[2] = _chunk("Nothing like this is on any page anywhere.", 2)
    pages = _pages(*[f"Page body {index}" for index in range(10)])
    assert locate_passage(chunks[2], chunks, lambda: pages).page == 5


def test_properties_passage_has_no_page() -> None:
    chunk = _chunk("Title: Survey", locator=PROPERTIES_LOCATOR)

    def load_pages() -> list[str]:
        raise AssertionError("properties are not on a page")

    assert locate_passage(chunk, [chunk], load_pages) == PageSpan(None, None, False)


def test_sheet_passage_is_searched_on_that_sheets_pages() -> None:
    row = "Northern parcel | 1,204 acres | approved"
    chunk = _chunk(row, 1, locator="Sheet: Q3 Holdings")
    pages = _pages(
        f"Summary {row}",
        "Q3 Holdings Unrelated header row",
        f"Q3 Holdings {row}",
        f"Q4 Holdings {row}",
    )
    assert locate_passage(chunk, [_chunk("x", 0), chunk], lambda: pages) == PageSpan(3, 3, True)


def test_sheet_passage_that_differs_in_format_lands_on_the_sheet_and_says_so() -> None:
    chunk = _chunk("1204.5 | 2026-01-05 00:00:00 | approved by the county board", locator="Sheet: Q3")
    pages = _pages("Q2 Other", "Q3 Rendered differently", "Q3 Second page")
    assert locate_passage(chunk, [chunk], lambda: pages) == PageSpan(2, 2, False)


def test_sheet_guess_counts_only_that_sheets_rows() -> None:
    chunks = [
        _chunk("Other sheet row", 0, locator="Sheet: Q2"),
        _chunk("Other sheet row two", 1, locator="Sheet: Q2"),
        _chunk("Other sheet row three", 2, locator="Sheet: Q2"),
        _chunk("Q3 first row, rendered differently", 3, locator="Sheet: Q3"),
        _chunk("Q3 last row, rendered differently", 4, locator="Sheet: Q3"),
    ]
    pages = _pages("Q2 Page", "Q3 One", "Q3 Two", "Q3 Three", "Q3 Four")
    assert locate_passage(chunks[3], chunks, lambda: pages) == PageSpan(2, 2, False)
    assert locate_passage(chunks[4], chunks, lambda: pages) == PageSpan(5, 5, False)


def test_sheet_passage_with_no_letters_opens_the_sheet() -> None:
    chunk = _chunk("--- | ---", locator="Sheet: Q3")
    pages = _pages("Q2 Page", "Q3 One", "Q3 Two")
    assert locate_passage(chunk, [chunk], lambda: pages) == PageSpan(2, 2, False)


def test_sheet_with_no_printed_name_falls_back_to_the_whole_document() -> None:
    row = "Northern parcel | 1,204 acres | approved"
    chunk = _chunk(row, locator="Sheet: Elsewhere")
    pages = _pages("Other", f"Heading {row}")
    assert locate_passage(chunk, [chunk], lambda: pages) == PageSpan(2, 2, True)


def test_segments_are_in_reading_order_without_the_overlap_or_properties() -> None:
    tail = "the last words of the first chunk"
    chunks = [
        _chunk(f"{tail}\n\nThe second chunk.", 1),
        _chunk(f"The first chunk ends with {tail}", 0),
        _chunk("Title: x", 2, locator=PROPERTIES_LOCATOR),
    ]
    segments = text_segments(chunks)
    assert [segment.text for segment in segments] == [
        f"The first chunk ends with {tail}",
        "The second chunk.",
    ]
    assert [segment.id for segment in segments] == ["chunk-0", "chunk-1"]


def test_short_accidental_match_is_not_overlap() -> None:
    chunks = [_chunk("Ends with the", 0), _chunk("the start of the next", 1)]
    assert text_segments(chunks)[1].text == "the start of the next"


def test_shortest_real_overlap_is_twelve_characters() -> None:
    twelve = "twelve chars"
    chunks = [_chunk(f"Ends with {twelve}", 0), _chunk(f"{twelve} and more", 1)]
    assert text_segments(chunks)[1].text == "and more"
    eleven = twelve[:11]
    chunks = [_chunk(f"Ends with {eleven}", 0), _chunk(f"{eleven} and more", 1)]
    assert text_segments(chunks)[1].text == f"{eleven} and more"


def test_overlap_is_only_removed_inside_one_location() -> None:
    tail = "exactly the same sentence on two pages"
    chunks = [
        _chunk(f"Page one has {tail}", 0, locator="Page 1", page_start=1),
        _chunk(f"{tail} and page two goes on", 1, locator="Page 2", page_start=2),
    ]
    assert text_segments(chunks)[1].text == f"{tail} and page two goes on"


def test_target_labels_a_found_page_when_ingestion_recorded_none() -> None:
    target = target_for(_chunk("Words."), PageSpan(12, 13, False))
    assert target.locator == "Page 12"
    assert (target.page, target.page_end, target.exact) == (12, 13, False)
    assert target_for(_chunk("Words."), PageSpan(None, None, True)).locator is None
    assert target_for(_chunk("Words.", locator="Slide 3"), PageSpan(3, 3, True)).locator == "Slide 3"


def test_recorded_span_of_a_chunk_without_a_place_is_exact_for_the_text_view() -> None:
    assert recorded_span(_chunk()) == PageSpan(None, None, True)
    assert recorded_span(_chunk(page_start=2)) == PageSpan(2, 2, True)
