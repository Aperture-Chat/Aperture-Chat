from __future__ import annotations

import os
import random
import threading
import time
import zipfile
from collections.abc import Iterator
from email.message import EmailMessage
from io import BytesIO

import pytest
from PIL import Image

import app.core.knowledge_ingestion as knowledge_ingestion
from app.core.knowledge_ingestion import (
    ExtractedSegment,
    chunk_segments,
    chunk_text,
    extract_segments,
    extract_text,
    extract_text_from_file,
)


def test_extract_text_from_docx_and_chunk() -> None:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "word/document.xml",
            """
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body>
                <w:p><w:r><w:t>Processor obligations must be preserved.</w:t></w:r></w:p>
                <w:tbl>
                  <w:tr>
                    <w:tc><w:p><w:r><w:t>Clause</w:t></w:r></w:p></w:tc>
                    <w:tc><w:p><w:r><w:t>Risk</w:t></w:r></w:p></w:tc>
                  </w:tr>
                  <w:tr>
                    <w:tc><w:p><w:r><w:t>Transfer</w:t></w:r></w:p></w:tc>
                    <w:tc><w:p><w:r><w:t>High</w:t></w:r></w:p></w:tc>
                  </w:tr>
                </w:tbl>
                <w:p><w:r><w:t>Cross-border transfer safeguards need client confirmation.</w:t></w:r></w:p>
              </w:body>
            </w:document>
            """,
        )

    text = extract_text("motion.docx", buffer.getvalue())

    assert text is not None
    assert "Processor obligations must be preserved." in text
    assert "Clause | Risk\n\nTransfer | High" in text
    assert "Cross-border transfer safeguards need client confirmation." in text
    assert text.index("Processor obligations") < text.index("Clause | Risk")
    assert text.index("Clause | Risk") < text.index("Cross-border transfer")
    assert chunk_text(text) == [
        (
            "Processor obligations must be preserved.\n\n"
            "Clause | Risk\n\n"
            "Transfer | High\n\n"
            "Cross-border transfer safeguards need client confirmation."
        )
    ]


def test_docx_rejects_untrusted_xml_entities() -> None:
    docx = BytesIO()
    with zipfile.ZipFile(docx, "w") as archive:
        archive.writestr(
            "word/document.xml",
            b"""<?xml version="1.0"?>
            <!DOCTYPE document [<!ENTITY unsafe "expanded">]>
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body><w:p><w:r><w:t>&unsafe;</w:t></w:r></w:p></w:body>
            </w:document>
            """,
        )

    assert extract_text("untrusted.docx", docx.getvalue()) is None


def test_extract_text_from_file_remains_a_join_wrapper() -> None:
    source = BytesIO(b"First paragraph.\n\nSecond paragraph.")

    assert extract_text_from_file("notes.txt", source) == ("First paragraph.\n\nSecond paragraph.")


def test_chunk_text_splits_long_text_with_overlap() -> None:
    text = " ".join(f"sentence-{index}." for index in range(80))
    chunks = chunk_text(text, max_chars=220, overlap=20)

    assert len(chunks) > 1
    assert chunks[1].startswith(chunks[0][-20:].strip())


def test_chunk_text_preserves_tail_of_sentence_longer_than_chunk_limit() -> None:
    text = " ".join(f"term-{index}" for index in range(500))
    text += " unique-tail-marker."

    chunks = chunk_text(text, max_chars=220, overlap=20)

    assert len(chunks) > 1
    assert "unique-tail-marker" in chunks[-1]
    assert "term-0" in chunks[0]


def test_chunk_segments_preserves_page_locator_across_splits() -> None:
    chunks = chunk_segments(
        [
            ExtractedSegment(
                text=" ".join(f"page-two-term-{index}" for index in range(100)),
                page_start=2,
                page_end=2,
                locator="Page 2",
            )
        ],
        max_chars=220,
        overlap=20,
    )

    assert len(chunks) > 1
    assert all(chunk.page_start == 2 and chunk.page_end == 2 for chunk in chunks)
    assert all(chunk.locator == "Page 2" for chunk in chunks)


_SYNTHETIC_WORDS = (
    "agreement party clause notice term transfer liability consent schedule processor "
    "controller breach remedy warranty indemnity payment invoice closing obligation "
    "confidential disclosure review counsel client exhibit"
).split()


def _synthetic_sentence(rng: random.Random) -> str:
    words = [rng.choice(_SYNTHETIC_WORDS) for _ in range(rng.randint(8, 22))]
    return " ".join(words).capitalize() + rng.choice([".", ".", "?", "!"])


def _synthetic_paragraph(rng: random.Random, target_chars: int = 600) -> str:
    sentences: list[str] = []
    while sum(len(sentence) + 1 for sentence in sentences) < target_chars - 40:
        sentences.append(_synthetic_sentence(rng))
    return " ".join(sentences)


def _synthetic_chunk_inputs() -> dict[str, str]:
    rng = random.Random(20260923)
    return {
        "short_paragraphs": "\n\n".join(
            " ".join(rng.choice(_SYNTHETIC_WORDS) for _ in range(rng.randint(1, 8))) + "."
            for _ in range(300)
        ),
        "600_char_paragraphs": "\n\n".join(_synthetic_paragraph(rng) for _ in range(40)),
        "giant_paragraph": " ".join(_synthetic_sentence(rng) for _ in range(400)),
        "giant_unpunctuated_paragraph": " ".join(rng.choice(_SYNTHETIC_WORDS) for _ in range(3000)),
        "giant_token": "x" * 7000,
        "mixed": "\n\n".join(
            [
                "Heading",
                _synthetic_paragraph(rng, 1500),
                "tiny",
                f"Lead-in {'y' * 2500} trailing words. Another sentence!",
                " ".join(rng.choice(_SYNTHETIC_WORDS) for _ in range(400)),
                _synthetic_paragraph(rng, 300),
                " messy\twhitespace\r\nacross  lines\n\n\n\n with  gaps\x00here. ",
                _synthetic_paragraph(rng, 900),
            ]
        ),
    }


_CHUNK_INPUTS = _synthetic_chunk_inputs()
_CHUNK_LIMITS = [(1200, 160), (220, 20), (200, 66), (500, 0), (150, 160)]


def _chunk_bodies(chunks: list[str], overlap: int) -> list[str]:
    """Strip each chunk's overlap prefix, asserting it is the documented tail."""

    bodies: list[str] = []
    for index, chunk in enumerate(chunks):
        prefix = chunks[index - 1][-overlap:].strip() if index and overlap else ""
        if prefix:
            assert chunk.startswith(f"{prefix}\n\n")
            chunk = chunk[len(prefix) + 2 :]
        assert chunk.strip()
        bodies.append(chunk)
    return bodies


@pytest.mark.parametrize(("max_chars", "overlap"), _CHUNK_LIMITS)
@pytest.mark.parametrize("name", sorted(_CHUNK_INPUTS))
def test_chunk_text_never_exceeds_limit_including_overlap(
    name: str, max_chars: int, overlap: int
) -> None:
    chunks = chunk_text(_CHUNK_INPUTS[name], max_chars=max_chars, overlap=overlap)

    assert chunks
    assert max(len(chunk) for chunk in chunks) <= max(200, max_chars)


@pytest.mark.parametrize(("max_chars", "overlap"), _CHUNK_LIMITS)
@pytest.mark.parametrize("name", sorted(_CHUNK_INPUTS))
def test_chunk_text_preserves_all_content_in_order(name: str, max_chars: int, overlap: int) -> None:
    text = _CHUNK_INPUTS[name]
    limit = max(200, max_chars)
    effective_overlap = max(0, min(overlap, limit // 3))

    chunks = chunk_text(text, max_chars=max_chars, overlap=overlap)
    bodies = _chunk_bodies(chunks, effective_overlap)

    normalized_words = knowledge_ingestion._normalize_text(text).split()
    body_words = " ".join(bodies).split()
    assert "".join(body_words) == "".join(normalized_words)
    if max(len(word) for word in normalized_words) <= limit - effective_overlap - 2:
        # Without tokens too long for any chunk, no word is ever cut apart.
        assert body_words == normalized_words


def test_chunk_text_packs_paragraphs_to_fill_chunks() -> None:
    rng = random.Random(7)
    paragraphs = [_synthetic_paragraph(rng) for _ in range(80)]

    chunks = chunk_text("\n\n".join(paragraphs))

    average = sum(len(chunk) for chunk in chunks) / len(chunks)
    assert average >= 0.8 * 1200
    assert len(chunks) < 0.75 * len(paragraphs)
    assert max(len(chunk) for chunk in chunks) <= 1200
    # Paragraphs are split only at sentence boundaries when sentences fit a chunk.
    assert all(body[-1] in ".!?" for body in _chunk_bodies(chunks, 160))


def test_chunk_text_handles_huge_inputs_in_linear_time() -> None:
    rng = random.Random(11)
    one_paragraph = " ".join(_synthetic_sentence(rng) for _ in range(20_000))

    for text in (one_paragraph, "z" * 2_000_000):
        started = time.perf_counter()
        chunks = chunk_text(text)
        elapsed = time.perf_counter() - started

        assert elapsed < 2.0
        assert max(len(chunk) for chunk in chunks) <= 1200


def test_chunk_segments_never_merges_text_across_segments() -> None:
    rng = random.Random(3)
    segments = [
        ExtractedSegment(
            text=" ".join(f"alpha{index}." for index in range(150)),
            page_start=1,
            page_end=1,
            locator="Page 1",
        ),
        ExtractedSegment(text="beta1 beta2.", page_start=2, page_end=2, locator="Page 2"),
        ExtractedSegment(
            text="\n\n".join(
                " ".join(f"gamma{rng.randint(0, 99)}" for _ in range(40)) + "." for _ in range(8)
            ),
            locator="Slide 3",
        ),
    ]

    chunks = chunk_segments(segments, max_chars=300, overlap=40)

    families = ["alpha", "beta", "gamma"]
    owners: list[int] = []
    for chunk in chunks:
        assert len(chunk.text) <= 300
        present = [family for family in families if family in chunk.text]
        assert len(present) == 1, chunk.text
        owner = families.index(present[0])
        source = segments[owner]
        assert (chunk.page_start, chunk.page_end, chunk.locator) == (
            source.page_start,
            source.page_end,
            source.locator,
        )
        owners.append(owner)
    assert owners == sorted(owners)
    assert set(owners) == {0, 1, 2}
    assert [chunk.text for chunk in chunks if chunk.locator == "Page 2"] == ["beta1 beta2."]


def test_pdf_segments_retain_one_based_page_provenance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    PdfWriter = pytest.importorskip("pypdf").PdfWriter
    pdf_buffer = BytesIO()
    writer = PdfWriter()
    for _ in range(3):
        writer.add_blank_page(width=612, height=792)
    writer.write(pdf_buffer)
    monkeypatch.setattr(
        knowledge_ingestion,
        "_ocr_pdf_pages",
        lambda _source, page_indexes, *, timeout_seconds: {
            page_index: f"OCR text for physical page {page_index + 1}."
            for page_index in page_indexes
        },
    )

    segments = extract_segments("three-pages.pdf", pdf_buffer.getvalue())

    assert [segment.page_start for segment in segments] == [1, 2, 3]
    assert [segment.page_end for segment in segments] == [1, 2, 3]
    assert [segment.locator for segment in segments] == ["Page 1", "Page 2", "Page 3"]
    assert "physical page 3" in segments[-1].text


def test_xlsx_segments_retain_sheet_locators() -> None:
    openpyxl = pytest.importorskip("openpyxl")
    workbook = openpyxl.Workbook()
    revenue = workbook.active
    revenue.title = "Revenue"
    revenue.append(["Year", "Amount"])
    revenue.append([2026, 1250000])
    risks = workbook.create_sheet("Risk Register")
    risks.append(["Risk", "Rating"])
    risks.append(["Currency", "High"])
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()

    segments = extract_segments("model.xlsx", buffer.getvalue())

    assert [segment.locator for segment in segments] == ["Sheet: Revenue", "Sheet: Risk Register"]
    assert "Year | Amount" in segments[0].text
    assert "Currency | High" in segments[1].text
    assert "Sheet: Revenue" not in (extract_text("model.xlsx", buffer.getvalue()) or "")


def test_xlsx_indexes_cell_values_not_formula_text() -> None:
    openpyxl = pytest.importorskip("openpyxl")
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Budget"
    sheet.append(["Line", "Amount"])
    sheet.append(["Discovery", 1200])
    sheet.append(["Total", "=SUM(B2:B2)"])
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()

    [segment] = extract_segments("budget.xlsx", buffer.getvalue())

    assert "Discovery | 1200" in segment.text
    assert "=SUM" not in segment.text


def test_pptx_segments_retain_slide_locators_and_tables() -> None:
    pptx = pytest.importorskip("pptx")
    presentation = pptx.Presentation()
    first = presentation.slides.add_slide(presentation.slide_layouts[6])
    box = first.shapes.add_textbox(0, 0, 4_000_000, 500_000)
    box.text = "Transaction overview"
    second = presentation.slides.add_slide(presentation.slide_layouts[6])
    table = second.shapes.add_table(2, 2, 0, 0, 4_000_000, 1_000_000).table
    table.cell(0, 0).text = "Metric"
    table.cell(0, 1).text = "Value"
    table.cell(1, 0).text = "EBITDA"
    table.cell(1, 1).text = "$12M"
    buffer = BytesIO()
    presentation.save(buffer)

    segments = extract_segments("deal.pptx", buffer.getvalue())

    assert [segment.locator for segment in segments] == ["Slide 1", "Slide 2"]
    assert segments[0].text == "Transaction overview"
    assert "Metric | Value\n\nEBITDA | $12M" in segments[1].text


def test_eml_reader_extracts_selected_headers_and_decoded_body() -> None:
    message = EmailMessage()
    message["From"] = "counsel@example.com"
    message["To"] = "client@example.com"
    message["Subject"] = "Closing checklist"
    message.set_content("Confirm signatures before the Friday closing.")

    text = extract_text("closing.eml", message.as_bytes())

    assert text is not None
    assert "From: counsel@example.com" in text
    assert "To: client@example.com" in text
    assert "Subject: Closing checklist" in text
    assert "Confirm signatures before the Friday closing." in text
    assert "Content-Transfer-Encoding" not in text


def test_msg_reader_uses_oxmsg_headers_and_plain_body(monkeypatch: pytest.MonkeyPatch) -> None:
    oxmsg = pytest.importorskip("oxmsg")
    captured: dict[str, bytes] = {}

    class FakeMessage:
        message_headers = {"To": "client@example.com", "Cc": "team@example.com"}
        sender = "counsel@example.com"
        sent_date = None
        subject = "Outlook update"
        body = "The diligence response is ready."
        html_body = "<p>unused</p>"

    def load(content: bytes) -> FakeMessage:
        captured["content"] = content
        return FakeMessage()

    monkeypatch.setattr(oxmsg.Message, "load", load)

    text = extract_text("update.msg", b"test-msg-bytes")

    assert captured["content"] == b"test-msg-bytes"
    assert text is not None
    assert "From: counsel@example.com" in text
    assert "To: client@example.com" in text
    assert "Subject: Outlook update" in text
    assert "The diligence response is ready." in text
    assert "unused" not in text


def test_eml_and_msg_parser_failures_return_no_fabricated_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    oxmsg = pytest.importorskip("oxmsg")

    class BrokenEmailParser:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def parsebytes(self, _content: bytes) -> object:
            raise ValueError("malformed email")

    def broken_msg_load(_content: bytes) -> object:
        raise ValueError("malformed Outlook message")

    monkeypatch.setattr(knowledge_ingestion, "BytesParser", BrokenEmailParser)
    monkeypatch.setattr(oxmsg.Message, "load", broken_msg_load)

    assert extract_text("broken.eml", b"broken") is None
    assert extract_text("broken.msg", b"broken") is None


def test_segment_character_limit_is_cumulative_including_join_separators() -> None:
    limited = knowledge_ingestion._limit_segments(
        [
            ExtractedSegment(text="A" * 12, locator="Page 1"),
            ExtractedSegment(text="B" * 12, locator="Page 2"),
        ],
        max_chars=20,
    )

    joined = "\n\n".join(segment.text for segment in limited)
    assert len(joined) == 20
    assert limited[0].locator == "Page 1"
    assert limited[1].locator == "Page 2"


def test_image_upload_uses_local_ocr_text(monkeypatch: pytest.MonkeyPatch) -> None:
    image_buffer = BytesIO()
    Image.new("RGB", (300, 120), "white").save(image_buffer, format="PNG")
    monkeypatch.setattr(
        knowledge_ingestion,
        "_ocr_image",
        lambda _image, *, timeout_seconds: (
            f"Scanned discovery deadline extracted in {timeout_seconds:g} seconds."
        ),
    )

    text = extract_text("scanned-deadline.png", image_buffer.getvalue())

    assert text == "Scanned discovery deadline extracted in 45 seconds."


def test_image_only_pdf_pages_fall_back_to_local_ocr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    PdfWriter = pytest.importorskip("pypdf").PdfWriter
    pdf_buffer = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.write(pdf_buffer)
    monkeypatch.setattr(
        knowledge_ingestion,
        "_ocr_pdf_pages",
        lambda _source, page_indexes, *, timeout_seconds: {
            page_indexes[0]: f"Scanned exhibit extracted in {timeout_seconds:g} seconds."
        },
    )

    text = extract_text("scanned-exhibit.pdf", pdf_buffer.getvalue())

    assert text == "Scanned exhibit extracted in 45 seconds."


@pytest.fixture
def restore_omp_thread_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    # Parallel OCR calls os.environ.setdefault("OMP_THREAD_LIMIT", ...); record
    # the original value so monkeypatch restores it after each test.
    monkeypatch.setenv("OMP_THREAD_LIMIT", "placeholder")
    monkeypatch.delenv("OMP_THREAD_LIMIT")


def _blank_pdf_with_page_widths(widths: list[int]) -> bytes:
    PdfWriter = pytest.importorskip("pypdf").PdfWriter
    pytest.importorskip("pypdfium2")
    buffer = BytesIO()
    writer = PdfWriter()
    for width in widths:
        writer.add_blank_page(width=width, height=300)
    writer.write(buffer)
    return buffer.getvalue()


class _SlowFakeOcr:
    """Stand-in for _ocr_image that identifies each page by its rendered width."""

    def __init__(self, delay_seconds: float, fail_width: int | None = None) -> None:
        self.delay_seconds = delay_seconds
        self.fail_width = fail_width
        self.calls: list[int] = []
        self.threads: set[str] = set()
        self._lock = threading.Lock()

    def __call__(self, image: Image.Image, *, timeout_seconds: float) -> str:
        width = image.size[0]
        with self._lock:
            self.calls.append(width)
            self.threads.add(threading.current_thread().name)
        time.sleep(self.delay_seconds)
        if width == self.fail_width:
            raise RuntimeError("tesseract failed on this page")
        return f"text of {width}px page"


@pytest.mark.usefixtures("restore_omp_thread_limit")
def test_pdf_ocr_runs_pages_concurrently_and_keeps_page_mapping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    widths = [200 + 20 * index for index in range(6)]
    pdf = _blank_pdf_with_page_widths(widths)
    fake_ocr = _SlowFakeOcr(delay_seconds=0.2)
    monkeypatch.setattr(knowledge_ingestion, "_ocr_image", fake_ocr)
    monkeypatch.setattr(knowledge_ingestion, "_ocr_worker_count", lambda: 3)

    started = time.perf_counter()
    results = knowledge_ingestion._ocr_pdf_pages(pdf, list(range(6)), timeout_seconds=5)
    elapsed = time.perf_counter() - started

    # Pages render at scale 2, so each page's text names twice its point width.
    assert results == {index: f"text of {width * 2}px page" for index, width in enumerate(widths)}
    assert list(results) == list(range(6))
    assert sorted(fake_ocr.calls) == [width * 2 for width in widths]
    assert elapsed < 0.9  # Sequential OCR needs at least 6 x 0.2 = 1.2 seconds.
    assert len(fake_ocr.threads) > 1
    assert "MainThread" not in fake_ocr.threads
    assert os.environ.get("OMP_THREAD_LIMIT") == "1"


@pytest.mark.usefixtures("restore_omp_thread_limit")
def test_pdf_ocr_failure_on_one_page_skips_only_that_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    widths = [200 + 20 * index for index in range(5)]
    pdf = _blank_pdf_with_page_widths(widths)
    monkeypatch.setattr(
        knowledge_ingestion,
        "_ocr_image",
        _SlowFakeOcr(delay_seconds=0.05, fail_width=widths[2] * 2),
    )
    monkeypatch.setattr(knowledge_ingestion, "_ocr_worker_count", lambda: 3)

    results = knowledge_ingestion._ocr_pdf_pages(pdf, list(range(5)), timeout_seconds=5)

    assert results == {
        index: f"text of {width * 2}px page" for index, width in enumerate(widths) if index != 2
    }


@pytest.mark.usefixtures("restore_omp_thread_limit")
def test_pdf_ocr_bounds_rendered_pages_and_closes_them_on_calling_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf = _blank_pdf_with_page_widths([200 + 10 * index for index in range(10)])
    monkeypatch.setattr(knowledge_ingestion, "_ocr_image", _SlowFakeOcr(delay_seconds=0.05))
    monkeypatch.setattr(knowledge_ingestion, "_ocr_worker_count", lambda: 2)
    calling_thread = threading.current_thread()
    live_images: set[int] = set()
    max_live = 0
    close_threads: list[threading.Thread] = []
    original_render = knowledge_ingestion._render_pdf_pages
    original_close_all = knowledge_ingestion._close_all

    def tracking_render(pdf_document: object, page_indexes: list[int]) -> Iterator[object]:
        nonlocal max_live
        for page in original_render(pdf_document, page_indexes):
            assert threading.current_thread() is calling_thread
            live_images.add(id(page.image))
            max_live = max(max_live, len(live_images))
            yield page

    def tracking_close_all(*resources: object) -> None:
        if resources and id(resources[0]) in live_images:
            live_images.discard(id(resources[0]))
            close_threads.append(threading.current_thread())
        original_close_all(*resources)

    monkeypatch.setattr(knowledge_ingestion, "_render_pdf_pages", tracking_render)
    monkeypatch.setattr(knowledge_ingestion, "_close_all", tracking_close_all)

    results = knowledge_ingestion._ocr_pdf_pages(pdf, list(range(10)), timeout_seconds=5)

    assert sorted(results) == list(range(10))
    assert max_live <= 4  # Never more than 2 x workers rendered pages at once.
    assert not live_images
    assert len(close_threads) == 10
    assert all(thread is calling_thread for thread in close_threads)


@pytest.mark.usefixtures("restore_omp_thread_limit")
def test_single_page_ocr_does_not_start_a_worker_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    class ForbiddenPool:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            raise AssertionError("single-page OCR must not start a thread pool")

    monkeypatch.setattr(knowledge_ingestion, "ThreadPoolExecutor", ForbiddenPool)
    monkeypatch.setattr(knowledge_ingestion, "_ocr_worker_count", lambda: 4)
    monkeypatch.setattr(knowledge_ingestion, "_ocr_image", _SlowFakeOcr(delay_seconds=0))
    image_buffer = BytesIO()
    Image.new("RGB", (300, 120), "white").save(image_buffer, format="PNG")

    pdf_results = knowledge_ingestion._ocr_pdf_pages(
        _blank_pdf_with_page_widths([250]), [0], timeout_seconds=5
    )
    image_text = extract_text("single-frame.png", image_buffer.getvalue())

    assert pdf_results == {0: "text of 500px page"}
    assert image_text == "text of 300px page"
    assert "OMP_THREAD_LIMIT" not in os.environ


@pytest.mark.usefixtures("restore_omp_thread_limit")
def test_multi_frame_image_ocr_runs_concurrently_in_page_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    widths = [300 + 10 * index for index in range(6)]
    frames = [Image.new("L", (width, 80), 255) for width in widths]
    buffer = BytesIO()
    frames[0].save(buffer, format="TIFF", save_all=True, append_images=frames[1:])
    fake_ocr = _SlowFakeOcr(delay_seconds=0.2)
    monkeypatch.setattr(knowledge_ingestion, "_ocr_image", fake_ocr)
    monkeypatch.setattr(knowledge_ingestion, "_ocr_worker_count", lambda: 3)

    started = time.perf_counter()
    segments = extract_segments("scan.tiff", buffer.getvalue())
    elapsed = time.perf_counter() - started

    assert [segment.page_start for segment in segments] == [1, 2, 3, 4, 5, 6]
    assert [segment.locator for segment in segments] == [f"Page {n}" for n in range(1, 7)]
    assert [segment.text for segment in segments] == [f"text of {width}px page" for width in widths]
    assert elapsed < 0.9  # Sequential OCR needs at least 6 x 0.2 = 1.2 seconds.
    assert len(fake_ocr.threads) > 1


def test_ocr_worker_count_defaults_and_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APERTURE_KNOWLEDGE_OCR_WORKERS", raising=False)
    for cpu_count, expected in ((16, 4), (4, 3), (2, 1), (1, 1), (None, 1)):
        monkeypatch.setattr(knowledge_ingestion.os, "cpu_count", lambda value=cpu_count: value)
        assert knowledge_ingestion._ocr_worker_count() == expected

    monkeypatch.setattr(knowledge_ingestion.os, "cpu_count", lambda: 16)
    monkeypatch.setenv("APERTURE_KNOWLEDGE_OCR_WORKERS", "6")
    assert knowledge_ingestion._ocr_worker_count() == 6
    for invalid in ("0", "-2", "many", " "):
        monkeypatch.setenv("APERTURE_KNOWLEDGE_OCR_WORKERS", invalid)
        assert knowledge_ingestion._ocr_worker_count() == 4
