"""How much of an attached file goes to the model, and which part."""

from __future__ import annotations

from app.core.attachment_context import (
    EARLIER_TURN_PASSAGES,
    attachment_turn_budget,
    earlier_turn_passages,
    select_passages,
    share_budget,
)
from app.models.schemas import KnowledgeChunk


def _chunk(ordinal: int, text: str) -> KnowledgeChunk:
    return KnowledgeChunk(
        id=f"a:{ordinal}",
        knowledge_config_id="",
        document_id="a",
        tenant_id="t",
        source_name="agreement.docx",
        source_uri="upload://a",
        source_type="upload",
        text=text,
        ordinal=ordinal,
        updated_at="now",
    )


FILLER = "Ordinary upkeep clause about resident notices and shared hallways. " * 6


def _document(count: int) -> list[KnowledgeChunk]:
    return [_chunk(index, f"{index} {FILLER}") for index in range(count)]


def test_a_document_that_fits_goes_whole_in_reading_order() -> None:
    chunks = _document(4)

    selected = select_passages(chunks, "anything", budget_chars=100_000)

    assert selected.complete is True
    assert [chunk.ordinal for chunk in selected.passages] == [0, 1, 2, 3]


def test_a_long_document_keeps_its_opening_and_what_the_question_names() -> None:
    chunks = _document(40)
    chunks[33] = _chunk(33, "The ZEPHYRINE management fee is four percent of revenue.")

    selected = select_passages(chunks, "What is the ZEPHYRINE fee?", budget_chars=2000)

    ordinals = [chunk.ordinal for chunk in selected.passages]
    assert selected.complete is False
    assert ordinals[0] == 0
    assert 33 in ordinals
    assert ordinals == sorted(ordinals)
    assert sum(len(chunk.text) for chunk in selected.passages) <= 2000


def test_a_question_that_names_nothing_reads_on_from_the_start() -> None:
    chunks = _document(40)

    selected = select_passages(chunks, "Fill in the gaps", budget_chars=2000)

    ordinals = [chunk.ordinal for chunk in selected.passages]
    assert ordinals == list(range(len(ordinals)))
    assert selected.complete is False


def test_nothing_is_selected_from_nothing() -> None:
    selected = select_passages([], "anything", budget_chars=2000)

    assert selected.passages == []
    assert selected.complete is True


def test_a_single_passage_longer_than_the_budget_is_still_shown() -> None:
    selected = select_passages([_chunk(0, FILLER * 10)], "anything", budget_chars=100)

    assert len(selected.passages) == 1
    assert selected.complete is False


def test_the_budget_is_a_share_of_a_known_window() -> None:
    small = attachment_turn_budget(8_000)
    large = attachment_turn_budget(1_000_000)

    assert small < large
    assert small < 8_000 * 4
    assert attachment_turn_budget(None) < large
    assert attachment_turn_budget(0) == attachment_turn_budget(None)


def test_a_huge_window_is_still_bounded() -> None:
    assert attachment_turn_budget(50_000_000) == attachment_turn_budget(100_000_000)


def test_files_share_the_budget_and_what_one_leaves_goes_to_the_others() -> None:
    assert share_budget([100, 5000, 5000], 3000) == [100, 1450, 1450]


def test_a_budget_shared_by_nothing_is_nothing() -> None:
    assert share_budget([], 3000) == []


def test_an_earlier_file_gives_only_passages_the_question_names() -> None:
    chunks = _document(30)
    chunks[20] = _chunk(20, "The ZEPHYRINE management fee is four percent of revenue.")

    found = earlier_turn_passages(chunks, "What about the ZEPHYRINE fee?")

    assert found[0].ordinal == 20
    assert len(found) <= EARLIER_TURN_PASSAGES


def test_an_earlier_file_that_shares_no_words_gives_nothing() -> None:
    assert earlier_turn_passages(_document(5), "penguins") == []


def test_the_budget_is_exactly_a_third_of_the_window_in_characters() -> None:
    assert attachment_turn_budget(30_000) == 40_000


def test_a_document_exactly_the_size_of_the_budget_goes_whole() -> None:
    chunks = _document(3)
    size = sum(len(chunk.text) for chunk in chunks)

    assert select_passages(chunks, "anything", budget_chars=size).complete is True
    assert select_passages(chunks, "anything", budget_chars=size - 1).complete is False


def test_a_passage_that_exactly_fills_what_is_left_is_taken() -> None:
    chunks = [_chunk(index, "x" * 100) for index in range(5)]

    selected = select_passages(chunks, "anything", budget_chars=300)

    assert [chunk.ordinal for chunk in selected.passages] == [0, 1, 2]


def test_no_passage_is_chosen_twice() -> None:
    chunks = [_chunk(index, "x" * 100) for index in range(10)]

    selected = select_passages(chunks, "Fill in the gaps", budget_chars=900)

    ids = [chunk.id for chunk in selected.passages]
    assert len(ids) == len(set(ids))
