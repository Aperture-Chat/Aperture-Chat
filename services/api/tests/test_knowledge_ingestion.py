from __future__ import annotations

import zipfile
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
