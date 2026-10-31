"""Which words of a chunk a reply's claim rests on.

A wrong passage reads as the source contradicting the answer, so every
uncertain case here must come back None and leave the viewer on the whole chunk.
"""

from __future__ import annotations

import pytest

from app.core.citation_use import citations_used
from app.models.schemas import ChatCitation


def _knowledge_citation(k_index: int) -> ChatCitation:
    return ChatCitation(
        id=f"cite-chunk-{k_index}",
        source_name=f"Document {k_index}",
        source_type="upload",
        source_uri=f"upload://document-{k_index}",
        snippet="Passage.",
        chunk_id=f"chunk-{k_index}",
        k_index=k_index,
        document_id=f"document-{k_index}",
        knowledge_config_id="knowledge-shared",
    )


def _web_citation(w_index: int) -> ChatCitation:
    return ChatCitation(
        id=f"cite-web-{w_index}",
        source_name=f"Result {w_index}",
        source_type="web",
        source_uri=f"https://example.com/{w_index}",
        snippet="Result.",
        w_index=w_index,
    )


def _fetched_citation(u_index: int) -> ChatCitation:
    return ChatCitation(
        id=f"cite-fetch-{u_index}",
        source_name=f"Fetched {u_index}",
        source_type="web",
        source_uri=f"https://example.com/fetched-{u_index}",
        snippet="Fetched.",
        u_index=u_index,
    )


_CHUNK = (
    "The northern boundary restates the recorded survey of the ledger. "
    "Fees are payable quarterly in arrears. "
    "The Osprey Landing culvert overflowed twice in April, closing the access road. "
    "Repairs were completed by the county in June."
)


def _passage_for(answer: str, chunk: str = _CHUNK, k_index: int = 1) -> str | None:
    kept = citations_used(
        answer,
        [_knowledge_citation(k_index)],
        chunk_texts={f"chunk-{k_index}": chunk},
    )
    return kept[0].passage if kept else None


def test_a_passage_is_the_part_of_the_chunk_the_reply_used() -> None:
    passage = _passage_for("The Osprey Landing culvert overflowed twice in April [K1].")

    assert passage == "The Osprey Landing culvert overflowed twice in April, closing the access road."


@pytest.mark.parametrize(
    "answer",
    [
        "The culvert at Osprey Landing overflowed in April. [K1]",
        "Culvert overflow at Osprey Landing [K1, K2].",
        "Culvert overflow at Osprey Landing [K1-K2] happened.",
        "| Osprey Landing culvert overflowed | [K1] |",
        "Fees are one thing. The culvert at Osprey Landing overflowed [K1]. Then fees again.",
    ],
)
def test_a_passage_follows_the_sentence_carrying_the_marker(answer: str) -> None:
    assert "culvert overflowed twice" in (_passage_for(answer) or "")


def test_a_passage_reads_every_sentence_that_cites_the_same_chunk() -> None:
    passage = _passage_for("The culvert overflowed in April [K1]. Repairs by the county [K1].")

    assert passage is not None
    assert "culvert overflowed" in passage and "Repairs were completed" in passage


def test_a_passage_is_always_a_verbatim_substring_of_the_chunk() -> None:
    chunk = "Line one of a table\nOsprey   culvert  overflowed\n\nnext   line. Another  sentence."

    passage = _passage_for("Osprey culvert overflowed [K1].", chunk)

    assert passage is not None and passage in chunk


def test_a_passage_stays_short_when_the_chunk_has_no_sentences() -> None:
    chunk = " ".join(f"cell{number}" for number in range(400)) + " culvert overflowed " + "x " * 300

    passage = _passage_for("The culvert overflowed [K1].", chunk)

    assert passage is not None and passage in chunk
    assert "culvert overflowed" in passage
    assert len(passage) <= 400


def test_a_passage_can_fill_the_whole_limit() -> None:
    filler = " ".join(["word"] * 70)
    chunk = f"Culvert {filler} overflowed tonight."
    chunk = chunk + "x" * (400 - len(chunk) - 1) + "."

    assert len(chunk) == 400
    assert _passage_for("Culvert overflowed [K1].", chunk) == chunk


def test_a_passage_can_come_from_a_chunk_with_one_unbroken_token() -> None:
    chunk = "culvert overflowed " + "x" * 1000

    passage = _passage_for("Culvert overflowed [K1].", chunk)

    assert passage == "culvert overflowed"


def test_a_passage_can_come_from_after_an_unbroken_token() -> None:
    chunk = "y" * 1000 + " culvert overflowed"

    passage = _passage_for("Culvert overflowed [K1].", chunk)

    assert passage is not None and passage.endswith("culvert overflowed")


def test_a_passage_reads_only_the_sentences_carrying_its_own_number() -> None:
    answer = "Fees are payable quarterly [K2]. The culvert overflowed twice in April [K1]."

    kept = citations_used(
        answer,
        [_knowledge_citation(1), _knowledge_citation(2)],
        chunk_texts={"chunk-1": _CHUNK, "chunk-2": _CHUNK},
    )

    assert [citation.passage for citation in kept] == [
        "The Osprey Landing culvert overflowed twice in April, closing the access road.",
        "Fees are payable quarterly in arrears.",
    ]


def test_a_web_marker_does_not_feed_a_knowledge_passage() -> None:
    answer = "Fees are payable quarterly [W1]. The culvert overflowed twice in April [K1]."

    assert _passage_for(answer) == (
        "The Osprey Landing culvert overflowed twice in April, closing the access road."
    )


def test_a_passage_is_never_guessed() -> None:
    assert _passage_for("Nothing here matches at all [K1].") is None
    assert _passage_for("Grounded [K1].", "") is None


def test_a_passage_needs_more_than_one_stray_shared_word() -> None:
    assert _passage_for("Quarterly reporting obligations remain unchanged [K1].") is None


def test_a_one_word_claim_can_still_find_its_passage() -> None:
    assert _passage_for("Culvert [K1].") == (
        "The Osprey Landing culvert overflowed twice in April, closing the access road."
    )


def test_a_passage_works_for_text_with_no_spaces() -> None:
    chunk = "第一条规定了管辖法院。押金为合同金额的百分之十二。付款按季度进行。"

    assert _passage_for("押金为百分之十二[K1]。", chunk) == "押金为合同金额的百分之十二。"


def test_text_with_no_spaces_matches_by_pairs_not_single_characters() -> None:
    assert _passage_for("乙丙丁[K1]。", "丁丙乙。甲乙丙丁。") == "甲乙丙丁。"


# Flattened PDF text from the reviewer's table: a row's last cell glues onto the
# next row's first, and the only sentence breaks sit inside the rows.
_FLAT_TABLE = (
    "Schedule C Item Amount Condition Terms prior notice $461,238.00 The seasonal boundary "
    "records the adjoining drainage of the permit. Holdback 5% eastern drainage $388,120.00 "
    "Released after the eastern survey is filed with the registrar. Holdback 9% Quillon Marsh "
    "retainage $412,900.00 Released in three tranches after the Quillon Marsh inspection is "
    "signed by the county engineer. Holdback 7% western levee bond $207,455.00 Held until the "
    "levee bond is renewed by the district. Holdback 3%"
)
_PIPE_TABLE = (
    "Item | Amount | Holdback\n"
    "Quillon Marsh retainage | $412,900.00 | 7%\n"
    "Eastern drainage | $461,238.00 | 5%\n"
    "Western levee bond | $207,455.00 | 9%"
)
_NUMBER_ROWS = (
    "Holdback 5% on the Harlow retainage\n"
    "Holdback 7% on the Harlow retainage\n"
    "Holdback 17% on the Harlow retainage\n"
    "Holdback 70% on the Harlow retainage"
)
_DATE_ROWS = (
    "Harlow inspection on March 3, 2026\n"
    "Harlow inspection on March 13, 2026\n"
    "Harlow inspection on March 30, 2026\n"
    "Harlow inspection on April 13, 2026"
)
_NAME_ROWS = (
    "Holdback 7% payable to Harlow Creek\n"
    "Holdback 7% payable to Quillon Marsh\n"
    "Holdback 7% payable to Western Levee"
)
_CODE_ROWS = "Revenue for Q3 was flat\nRevenue for Q4 was flat\nRevenue for Q1 was flat"


@pytest.mark.parametrize(
    ("claim", "chunk", "passage"),
    [
        ("The Quillon Marsh holdback is 7%", _PIPE_TABLE, "Quillon Marsh retainage | $412,900.00 | 7%"),
        ("The Quillon Marsh retainage is $412,900.00", _PIPE_TABLE, "Quillon Marsh retainage | $412,900.00 | 7%"),
        ("The Quillon Marsh retainage is $412,900", _PIPE_TABLE, "Quillon Marsh retainage | $412,900.00 | 7%"),
        ("The drainage amount is $461,238.00", _PIPE_TABLE, "Eastern drainage | $461,238.00 | 5%"),
        ("The Harlow holdback is 7%", _NUMBER_ROWS, "Holdback 7% on the Harlow retainage"),
        ("The Harlow holdback is 17%", _NUMBER_ROWS, "Holdback 17% on the Harlow retainage"),
        ("The Harlow holdback is seven percent", _NUMBER_ROWS, "Holdback 7% on the Harlow retainage"),
        ("The Harlow holdback is 7 percent", _NUMBER_ROWS, "Holdback 7% on the Harlow retainage"),
        ("Inspection was on March 13, 2026", _DATE_ROWS, "Harlow inspection on March 13, 2026"),
        ("Inspection was on April 13, 2026", _DATE_ROWS, "Harlow inspection on April 13, 2026"),
        ("The 7% holdback is payable to Quillon Marsh", _NAME_ROWS, "Holdback 7% payable to Quillon Marsh"),
        ("The holdback goes to Western Levee", _NAME_ROWS, "Holdback 7% payable to Western Levee"),
        ("Revenue in Q4 was flat", _CODE_ROWS, "Revenue for Q4 was flat"),
    ],
)
def test_a_passage_in_a_table_is_the_row_with_the_claims_values(
    claim: str, chunk: str, passage: str
) -> None:
    assert _passage_for(f"{claim} [K1].", chunk) == passage


@pytest.mark.parametrize(
    ("claim", "chunk"),
    [
        ("The holdback is 6%", _NUMBER_ROWS),
        ("The Harlow holdback is 8 percent", _NUMBER_ROWS),
        ("Inspection was on March 14, 2026", _DATE_ROWS),
        ("Inspection was on May 13, 2026", _DATE_ROWS),
        ("The retainage is $412,901.00", _PIPE_TABLE),
        ("The holdback is 7 days", _NUMBER_ROWS),
        ("The holdback is 7%", _NAME_ROWS),
        ("The Harlow inspection took place", _DATE_ROWS),
        ("The 7% holdback is 9%", _PIPE_TABLE),
    ],
)
def test_a_passage_is_withheld_when_the_values_are_missing_or_it_is_a_tie(
    claim: str, chunk: str
) -> None:
    assert _passage_for(f"{claim} [K1].", chunk) is None


def test_an_ordinal_is_a_figure_too() -> None:
    chunk = "The option expires at noon on the ninetieth day after notice."

    assert _passage_for("The option expires on the sixtieth day [K1].", chunk) is None
    assert _passage_for("The option expires on the ninetieth day [K1].", chunk) == chunk


def test_first_and_second_are_ordinary_words() -> None:
    chunk = "The holdback is released at closing to the seller."

    assert _passage_for("The first holdback is released at closing [K1].", chunk) == chunk


def test_a_vague_claim_does_not_stitch_sentences_together() -> None:
    chunk = (
        "The seasonal survey restates the prior permit of the survey. "
        "The northern notice describes the adjoining county."
    )

    assert _passage_for("The notice restates the survey of the county [K1].", chunk) is None


def test_a_claim_needs_most_of_its_words_in_the_passage() -> None:
    chunk = "Fees are payable quarterly in arrears."

    assert _passage_for("Fees and penalties accrue daily under the agreement [K1].", chunk) is None
    assert _passage_for("Fees are payable quarterly under it [K1].", chunk) == chunk


def test_a_flattened_table_never_marks_the_neighbouring_rows_figure() -> None:
    passage = _passage_for("The Quillon Marsh holdback is 7% [K1].", _FLAT_TABLE)

    assert passage == "Quillon Marsh inspection is signed by the county engineer. Holdback 7%"


def test_a_flattened_row_keeps_its_own_sentence_but_not_the_cell_before_it() -> None:
    passage = _passage_for("The Quillon Marsh retainage is $412,900.00 [K1].", _FLAT_TABLE)

    assert passage == (
        "Quillon Marsh retainage $412,900.00 Released in three tranches after the "
        "Quillon Marsh inspection is signed by the county engineer."
    )


def test_a_claim_with_no_figures_still_stays_out_of_the_neighbouring_cells() -> None:
    passage = _passage_for("Released in three tranches after the inspection [K1].", _FLAT_TABLE)

    assert passage == (
        "Released in three tranches after the Quillon Marsh inspection is signed by the "
        "county engineer."
    )


def test_a_different_figure_inside_the_span_withholds_the_passage() -> None:
    chunk = "Rates rose from 5%, then 6%, then 7% across the term."

    assert _passage_for("Rates went from 5% to 7% [K1].", chunk) is None


def test_two_copies_of_the_same_words_are_not_a_tie() -> None:
    chunk = "The holdback is 7%. Fees follow later. The holdback is 7%."

    assert _passage_for("The holdback is 7% [K1].", chunk) == "The holdback is 7%."


def test_the_best_of_two_overlapping_windows_is_not_a_tie() -> None:
    chunk = "The escrow holdback is 7%. Fees follow later."

    assert _passage_for("The escrow holdback is 7% [K1].", chunk) == "The escrow holdback is 7%."


def test_a_name_the_chunk_never_mentions_does_not_block_the_passage() -> None:
    passage = _passage_for("According to Field Notes, the culvert overflowed in April [K1].")

    assert passage == (
        "The Osprey Landing culvert overflowed twice in April, closing the access road."
    )


@pytest.mark.parametrize("prefix", ["- ", "* ", "1. ", "12) "])
def test_a_list_number_is_not_a_figure_in_the_claim(prefix: str) -> None:
    assert _passage_for(f"{prefix}The holdback is 7% [K1].", _NUMBER_ROWS.replace("Harlow", "Other")) == (
        "Holdback 7% on the Other retainage"
    )


def test_a_sentence_with_two_figures_marks_the_part_with_the_claims_figure() -> None:
    chunk = "Base rent escalates 3% annually and the deposit is 5%."

    assert _passage_for("Base rent escalates 3% [K1].", chunk) == "Base rent escalates 3%"


def test_a_passage_keeps_the_claims_words_up_to_a_figure_it_did_not_make() -> None:
    chunk = (
        "9.3 Harrowgate dock. The Harrowgate dock is excluded from this clause for any claim "
        "first made after the third anniversary of the closing."
    )

    passage = _passage_for("The Harrowgate dock is excluded from the indemnity [K1].", chunk)

    assert passage == "The Harrowgate dock is excluded"


def test_a_passage_keeps_the_claims_words_back_to_a_figure_it_did_not_make() -> None:
    chunk = "Each 5% tranche of the Harlow retainage is released at closing."

    passage = _passage_for("The Harlow retainage is released at closing [K1].", chunk)

    assert passage == "Harlow retainage is released at closing."


def test_separate_claims_on_different_rows_still_find_a_passage() -> None:
    answer = "The Quillon Marsh holdback is 7% [K1]. The drainage amount is $461,238.00 [K1]."

    assert _passage_for(answer, _PIPE_TABLE) == "Quillon Marsh retainage | $412,900.00 | 7%"


def test_a_passage_ignores_a_thinking_block() -> None:
    answer = "<think>Fees are payable quarterly [K1].</think>The culvert overflowed in April [K1]."

    assert "culvert overflowed" in (_passage_for(answer) or "")


def test_web_and_fetched_rows_have_no_passage() -> None:
    kept = citations_used("From [W1] and [U1].", [_web_citation(1), _fetched_citation(1)])

    assert [citation.passage for citation in kept] == [None, None]


@pytest.mark.parametrize(
    ("claim", "chunk", "passage"),
    [
        # A bare number and a stated kind are the same figure, in either order.
        ("The Harlow holdback is 7%", "Holdback 7 on the Harlow retainage", "Holdback 7 on the Harlow retainage"),
        ("The Harlow holdback is 7", "Holdback 7% on the Harlow retainage", "Holdback 7% on the Harlow retainage"),
        # A row is a row at exactly the table limits.
        ("Row two is 7%", "Row one | 5% | $100 | alpha\nRow two | 7% | $200 | beta\nRow three | 9% | $300 | gamma", "Row two | 7% | $200 | beta"),
        (
            "Row two is 7%",
            "Row one | 5% | $100 | alpha.\nRow two | 7% | $200 | beta.\nRow three | 9% | $300 | gamma\nRow four | 3% | $400 | delta",
            "Row two | 7% | $200 | beta.",
        ),
        # Figures sitting exactly at a row's edges.
        ("The 7% holdback", "7% holdback to Harlow\n9% holdback to Harlow\n5% holdback to Harlow", "7% holdback to Harlow"),
        # A figure between the claim's words stays; a span is not cut through itself.
        ("Fees are payable quarterly", "Fees 5% are payable quarterly.", "Fees 5% are payable quarterly."),
        ("Fees are payable quarterly", "Annual fees 5% are payable quarterly.", "Annual fees 5% are payable quarterly."),
        ("Fees are payable quarterly", "Fees 5% are payable quarterly at closing.", "Fees 5% are payable quarterly at closing."),
        ("Fees are payable quarterly", "Fees are payable 5% quarterly", "Fees are payable 5% quarterly"),
        # A figure at a window's edge, or touching the words, is still left out.
        ("Fees are payable quarterly", "5% Fees are payable quarterly.", "Fees are payable quarterly."),
        ("Fees are payable quarterly", "Fees are payable quarterly at 5%", "Fees are payable quarterly"),
        ("Fees are payable quarterly", "Holdback 5%Fees are payable quarterly.", "Fees are payable quarterly."),
        ("Fees are payable quarterly", "Fees are payable quarterly$500 today.", "Fees are payable quarterly"),
        # Words that echo the claim are kept right up to such a figure.
        ("The holdback is 7%", "Rate 5%Holdback is 7% today.", "Holdback is 7% today."),
        ("The holdback is final at 7%", "Rate 5% then 7% is final$5 later.", "7% is final"),
        # The figure alone can be the whole passage when no word echoes the claim.
        ("The holdback is seven percent", "Rate 9% then 7% apply $5.", "7%"),
    ],
)
def test_where_a_passage_begins_and_ends(claim: str, chunk: str, passage: str) -> None:
    assert _passage_for(f"{claim} [K1].", chunk) == passage


def test_a_name_counts_from_the_second_word_of_the_claim() -> None:
    rows = "Holdback 7% payable to Harlow\nHoldback 7% payable to Quillon\nHoldback 7% payable to Levee"

    passage = _passage_for("Paying Quillon the holdback under every other agreement today [K1].", rows)

    assert passage == "Holdback 7% payable to Quillon"


@pytest.mark.parametrize(
    "chunk",
    ["押金为十二。押金为十二元。", "押金为十二元。押金为十二。"],
)
def test_two_sentences_with_nothing_between_them_are_still_a_tie(chunk: str) -> None:
    assert _passage_for("押金为十[K1]。", chunk) is None


def test_half_of_a_claims_words_is_not_most_of_them() -> None:
    chunk = "Fees are payable quarterly in arrears."

    assert _passage_for("Fees and penalties remain quarterly [K1].", chunk) is None


# Flattened PDF text: rows that differ only by a date, with no breaks between them.
_FLAT_DATES = (
    "Payment schedule Payment Due date Amount First installment 3 March 2027 $10,000.00 "
    "Second installment 3 June 2027 $10,000.00 Third installment 3 September 2027 $10,000.00 "
    "Final installment 3 December 2027 $20,000.00"
)
_FLAT_INSPECTIONS = (
    "Dunlin inspection Due 3 March 2027 Dunlin inspection Due 3 June 2027 "
    "Dunlin inspection Due 3 September 2027"
)


def test_a_date_with_a_month_name_stops_the_mark_at_another_rows_date() -> None:
    passage = _passage_for("The second installment of $10,000 is due on 3 June 2027 [K1].", _FLAT_DATES)

    assert passage == "Second installment 3 June 2027 $10,000.00"


def test_a_flattened_row_with_only_a_date_marks_that_date_and_no_other() -> None:
    passage = _passage_for("The Dunlin inspection is due on 3 June 2027 [K1].", _FLAT_INSPECTIONS)

    assert passage == "Dunlin inspection Due 3 June 2027"


def test_a_date_split_by_the_length_limit_still_stops_the_mark() -> None:
    filler = "Dunlin inspection Due 3 June 2027 " + "alpha " * 60
    chunk = f"{filler}and Due 3 September 2027 beyond the limit of a single passage window."

    passage = _passage_for("The Dunlin inspection is due on 3 June 2027 [K1].", chunk)

    assert passage is not None and "September" not in passage and not passage.endswith("3")


def test_a_chunk_can_write_a_month_with_a_dot() -> None:
    chunk = "The sale closed on Jun. 3, 2027 at the county office."

    assert _passage_for("It closed on 3 June 2027 [K1].", chunk) == chunk


def test_a_figure_touching_a_date_is_a_figure_of_its_own() -> None:
    chunk = "Alpha due 3 June 2027$500 for the county fee."

    assert _passage_for("It is due 3 June 2027 [K1].", chunk) == "Alpha due 3 June 2027"


@pytest.mark.parametrize(
    ("claim", "chunk", "passage"),
    [
        ("The fee is $5", "Rate 9% then fee$5 today at noon $8.", "fee$5"),
        ("The holdback is final at 7%", "Rate 5% then 7%final later $5.", "7%final"),
    ],
)
def test_an_echo_touching_the_figure_is_kept(claim: str, chunk: str, passage: str) -> None:
    assert _passage_for(f"{claim} [K1].", chunk) == passage


def test_a_term_seen_again_is_the_next_rows_label_not_more_of_the_claim() -> None:
    chunk = "Fee Alpha 3 June 2027 Fee Beta 3 July 2027"

    assert _passage_for("The Alpha fee is due 3 June 2027 [K1].", chunk) == "Fee Alpha 3 June 2027"


@pytest.mark.parametrize(
    "claim",
    [
        "The Dunlin inspection is due on 3 July 2027",
        "The Dunlin inspection is due on 3 June 2028",
        "The Dunlin inspection is due on 4 June 2027",
        "The Dunlin inspection is due on June 4, 2027",
    ],
)
def test_a_date_the_chunk_does_not_hold_gives_no_passage(claim: str) -> None:
    assert _passage_for(f"{claim} [K1].", _FLAT_INSPECTIONS) is None


@pytest.mark.parametrize(
    "claim",
    [
        "It closed on 3 June 2027",
        "It closed on June 3, 2027",
        "It closed on June 3rd, 2027",
        "It closed on 3rd June 2027",
        "It closed on Jun 3, 2027",
        "It closed on June 2027",
        "It closed on June 3",
        "It closed on 3 June",
    ],
)
def test_every_way_of_writing_a_month_date_is_the_same_figure(claim: str) -> None:
    chunk = "The sale closed on 3 June 2027 at the county office."

    assert _passage_for(f"{claim} [K1].", chunk) == chunk


def test_a_short_date_does_not_match_a_different_day_or_year() -> None:
    chunk = "The sale closed on 3 June 2027 at the county office."

    assert _passage_for("It closed on June 4 [K1].", chunk) is None
    assert _passage_for("It closed in June 2028 [K1].", chunk) is None


def test_may_as_a_verb_is_not_a_date() -> None:
    chunk = "The tenant may 3 times renew the lease at the county office."

    assert _passage_for("The tenant may renew the lease [K1].", chunk) is not None


def test_a_month_name_alone_is_not_a_date_figure() -> None:
    chunk = "Repairs finished in June at the county office."

    assert _passage_for("Repairs finished in June [K1].", chunk) == chunk


def test_two_rows_with_the_same_date_stay_a_tie() -> None:
    chunk = "Alpha due 3 June 2027\nBeta due 3 June 2027\nGamma due 3 June 2027"

    assert _passage_for("It is due on 3 June 2027 [K1].", chunk) is None

