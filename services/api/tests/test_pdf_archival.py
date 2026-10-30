from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pikepdf
import pytest

from app.core.pdf_archival import (
    PDFA_CONFORMANCE,
    ArchivalMetadata,
    finish_archival_pdf,
    restored_bookmark_titles,
)

FIXTURE = Path(__file__).parent / "fixtures" / "chromium-print-sample.pdf"
METADATA = ArchivalMetadata(
    title="Synthetic Harbor Lease",
    author="Jordan Avery",
    lang="en-US",
    created=datetime(2026, 10, 29, 15, 0, tzinfo=UTC),
)

PRINT = 4
HIDDEN_FLAGS = 1 | 2 | 32  # Invisible, Hidden, NoView


@pytest.fixture()
def finished(tmp_path: Path):
    destination = tmp_path / "lease.pdf"
    summary = finish_archival_pdf(FIXTURE, destination, METADATA)
    with pikepdf.open(destination) as pdf:
        yield summary, pdf, destination


def test_identifies_the_file_as_pdfa_2b_in_its_metadata(finished) -> None:
    _summary, pdf, _path = finished

    meta = pdf.open_metadata()
    assert meta["pdfaid:part"] == "2"
    assert meta["pdfaid:conformance"] == "B"
    assert meta["dc:title"] == "Synthetic Harbor Lease"
    assert meta["dc:creator"] == ["Jordan Avery"]
    assert meta["xmp:CreatorTool"] == "Aperture Chat Drafts"
    assert PDFA_CONFORMANCE == "PDF/A-2b"
    # The Info dictionary agrees with the XMP packet, as PDF/A requires.
    assert str(pdf.docinfo["/Title"]) == "Synthetic Harbor Lease"
    assert str(pdf.docinfo["/Author"]) == "Jordan Avery"
    assert str(pdf.docinfo["/Producer"]) == "Aperture Chat"


def test_declares_an_srgb_output_intent_for_its_colors(finished) -> None:
    _summary, pdf, _path = finished

    intents = pdf.Root.OutputIntents
    assert len(intents) == 1
    intent = intents[0]
    assert intent.S == pikepdf.Name.GTS_PDFA1
    assert str(intent.OutputConditionIdentifier) == "sRGB IEC61966-2.1"
    profile = intent.DestOutputProfile
    assert int(profile.N) == 3
    assert profile.read_bytes()[36:40] == b"acsp"  # an ICC profile signature


def test_links_print_and_describe_themselves(finished) -> None:
    _summary, pdf, _path = finished

    links = [annot for page in pdf.pages for annot in page.obj.get("/Annots", [])]
    assert len(links) == 2
    for link in links:
        flags = int(link.F)
        assert flags & PRINT
        assert not flags & HIDDEN_FLAGS
    descriptions = sorted(str(link.Contents) for link in links)
    assert descriptions == ["Link to https://example.com/terms", "Link within this document"]


def test_opens_readably_for_assistive_technology_and_bookmarks(finished) -> None:
    summary, pdf, _path = finished

    assert str(pdf.Root.Lang) == "en-US"
    assert bool(pdf.Root.ViewerPreferences.DisplayDocTitle) is True
    assert pdf.Root.MarkInfo.Marked is True
    assert "/StructTreeRoot" in pdf.Root
    assert pdf.Root.PageMode == pikepdf.Name.UseOutlines
    assert summary.bookmark_count == 3


def test_reports_what_it_wrote_and_is_never_encrypted(finished) -> None:
    summary, pdf, path = finished

    assert summary.page_count == len(pdf.pages) == 3
    assert summary.size_bytes == path.stat().st_size
    assert not pdf.is_encrypted
    assert pdf.trailer.ID  # PDF/A needs a file identifier
    assert pdf.is_linearized


def test_finishing_a_finished_file_changes_nothing_structural(tmp_path: Path) -> None:
    once = tmp_path / "once.pdf"
    twice = tmp_path / "twice.pdf"
    finish_archival_pdf(FIXTURE, once, METADATA)

    summary = finish_archival_pdf(once, twice, METADATA)

    with pikepdf.open(twice) as pdf:
        assert len(pdf.Root.OutputIntents) == 1
        assert summary.page_count == 3
        links = [annot for page in pdf.pages for annot in page.obj.get("/Annots", [])]
        assert sorted(str(link.Contents) for link in links) == [
            "Link to https://example.com/terms",
            "Link within this document",
        ]


def test_bookmark_titles_get_back_the_spaces_lost_at_line_wraps() -> None:
    titles = ["HarborLogisticsMasterServicesAgreement", "1. Definitions", "Unrelated", "2.Term"]
    headings = ["Harbor Logistics Master Services Agreement", "1. Definitions", "2. Term"]

    assert restored_bookmark_titles(titles, headings) == [
        "Harbor Logistics Master Services Agreement",
        "1. Definitions",
        "Unrelated",
        "2. Term",
    ]


def test_finishing_restores_wrapped_heading_bookmarks(tmp_path: Path) -> None:
    wrapped = tmp_path / "wrapped.pdf"
    with pikepdf.open(FIXTURE) as pdf:
        with pdf.open_outline() as outline:
            outline.root[0].title = "SyntheticHarborLease"
        pdf.save(wrapped)
    metadata = ArchivalMetadata(
        title=METADATA.title,
        author=METADATA.author,
        lang=METADATA.lang,
        created=METADATA.created,
        headings=("Synthetic Harbor Lease", "Term", "Rent"),
    )

    finish_archival_pdf(wrapped, tmp_path / "out.pdf", metadata)

    with pikepdf.open(tmp_path / "out.pdf") as pdf, pdf.open_outline() as outline:
        top = outline.root[0]
        assert top.title == "Synthetic Harbor Lease"
        assert [child.title for child in top.children] == ["Term", "Rent"]


def test_each_heading_restores_one_bookmark_in_order() -> None:
    # Two headings with the same letters: each bookmark takes its own heading.
    titles = ["ExhibitA", "ExhibitA", "ExhibitA"]
    headings = ["Exhibit A", "Exhibit A", "ExhibitA"]

    assert restored_bookmark_titles(titles, headings) == ["Exhibit A", "Exhibit A", "ExhibitA"]


def test_existing_descriptions_and_other_annotations_are_left_alone(tmp_path: Path) -> None:
    marked = tmp_path / "marked.pdf"
    with pikepdf.open(FIXTURE) as pdf:
        links = [annot for page in pdf.pages for annot in page.obj.get("/Annots", [])]
        links[0].Contents = "Read the posted terms"
        note = pdf.make_indirect(
            pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Square, Rect=[10, 10, 20, 20])
        )
        pdf.pages[0].obj.Annots.append(note)
        pdf.save(marked)

    finish_archival_pdf(marked, tmp_path / "out.pdf", METADATA)

    with pikepdf.open(tmp_path / "out.pdf") as pdf:
        annotations = [annot for page in pdf.pages for annot in page.obj.get("/Annots", [])]
        described = {str(annot.Subtype): annot.get("/Contents") for annot in annotations if annot.Subtype != pikepdf.Name.Link}
        assert described == {"/Square": None}
        assert "Read the posted terms" in [str(annot.get("/Contents")) for annot in annotations]
        assert all(int(annot.F) & PRINT for annot in annotations)
