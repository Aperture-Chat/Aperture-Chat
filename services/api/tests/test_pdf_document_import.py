from __future__ import annotations

import ctypes
import html as html_lib
import io
import re

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

from app.core.pdf_document_import import (
    PdfReadError,
    clean_font_name,
    css_font_family_stack,
    import_pdf_document,
)
from app.models.matters import sanitize_draft_html


def _utf16le_buffer(text: str):
    buffer = (ctypes.c_ushort * (len(text) + 1))()
    for index, character in enumerate(text):
        buffer[index] = ord(character)
    return buffer


def _add_text(
    doc: pdfium.PdfDocument,
    page: pdfium.PdfPage,
    text: str,
    *,
    x: float,
    y: float,
    size: float = 12,
    font: bytes = b"Times-Roman",
    color: tuple[int, int, int] = (0, 0, 0),
) -> None:
    text_obj = pdfium_c.FPDFPageObj_NewTextObj(doc.raw, font, size)
    pdfium_c.FPDFText_SetText(text_obj, _utf16le_buffer(text))
    pdfium_c.FPDFPageObj_Transform(text_obj, 1, 0, 0, 1, x, y)
    pdfium_c.FPDFPageObj_SetFillColor(text_obj, color[0], color[1], color[2], 255)
    pdfium_c.FPDFPage_InsertObject(page.raw, text_obj)


def _add_image(
    doc: pdfium.PdfDocument,
    page: pdfium.PdfPage,
    *,
    x: float,
    y: float,
    width: float,
    height: float,
) -> None:
    pil = Image.new("RGBA", (20, 12), (200, 40, 30, 255))
    bitmap = pdfium.PdfBitmap.from_pil(pil)
    image = pdfium.PdfImage.new(doc)
    image.set_bitmap(bitmap, pages=[page])
    image.set_matrix(pdfium.PdfMatrix(width, 0, 0, height, x, y))
    page.insert_obj(image)
    bitmap.close()


def _add_rect(
    page: pdfium.PdfPage,
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    color: tuple[int, int, int] = (0, 0, 0),
) -> None:
    rect = pdfium_c.FPDFPageObj_CreateNewRect(x, y, width, height)
    pdfium_c.FPDFPageObj_SetFillColor(rect, color[0], color[1], color[2], 255)
    pdfium_c.FPDFPath_SetDrawMode(rect, pdfium_c.FPDF_FILLMODE_ALTERNATE, 0)
    pdfium_c.FPDFPage_InsertObject(page.raw, rect)


def _pdf_bytes(pages: list[tuple[float, float, list[tuple[str, dict]]]]) -> bytes:
    doc = pdfium.PdfDocument.new()
    opened_pages: list[pdfium.PdfPage] = []
    try:
        for width, height, objects in pages:
            page = doc.new_page(width, height)
            opened_pages.append(page)
            for kind, kwargs in objects:
                if kind == "text":
                    _add_text(doc, page, **kwargs)
                elif kind == "image":
                    _add_image(doc, page, **kwargs)
                elif kind == "rect":
                    _add_rect(page, **kwargs)
            page.gen_content()
        buffer = io.BytesIO()
        doc.save(buffer)
        return buffer.getvalue()
    finally:
        for page in opened_pages:
            page.close()
        doc.close()


def _text_width(text: str, font: bytes = b"Times-Roman", size: float = 12) -> float:
    """Drawn width of a string in a standard font, measured by PDFium."""

    pdf = pdfium.PdfDocument(_pdf_bytes([(612, 792, [("text", {"text": text, "x": 0, "y": 100, "font": font, "size": size})])]))
    try:
        textpage = pdf[0].get_textpage()
        right = textpage.get_charbox(textpage.count_chars() - 1)[2]
        left = textpage.get_charbox(0)[0]
        textpage.close()
        return right - left
    finally:
        pdf.close()


def _text(text: str, x: float, y: float, **kwargs) -> tuple[str, dict]:
    return ("text", {"text": text, "x": x, "y": y, **kwargs})


def _body(html: str) -> str:
    """The HTML after the page-setup marker."""

    depth = 0
    for match in re.finditer(r"<(/?)div\b[^>]*>", html):
        depth += -1 if match.group(1) else 1
        if depth == 0:
            return html[match.end() :]
    return html


def test_font_names_and_stacks_mirror_the_editor_contract() -> None:
    assert clean_font_name("ABCDEF+TimesNewRomanPS-BoldItalicMT") == "Times New Roman"
    assert clean_font_name("Arial-BoldMT") == "Arial"
    assert clean_font_name("Times-Roman") == "Times New Roman"
    assert clean_font_name("CourierNewPSMT") == "Courier New"
    assert clean_font_name("Calibri,Bold") == "Calibri"
    assert clean_font_name("BookAntiqua") == "Book Antiqua"
    # Same stacks as cssFontFamilyStack in apps/web/src/lib/documentPageSetup.ts.
    assert css_font_family_stack("Calibri") == "Calibri, Carlito, Arial, sans-serif"
    assert css_font_family_stack("Times New Roman") == "'Times New Roman', 'Liberation Serif', Tinos, Times, serif"


def test_page_setup_title_and_rejoined_paragraph() -> None:
    lines = [
        "This paragraph wraps across three lines in the PDF and must come back as one",
        "editable paragraph whose lines keep their pitch, their font, and their place,",
        "just as they were.",
    ]
    title_width = _text_width("Centered Title", b"Helvetica-Bold", 18)
    column_right = 72 + max(_text_width(line) for line in lines)
    payload = _pdf_bytes(
        [
            (
                612,
                792,
                [
                    _text("Centered Title", (72 + column_right - title_width) / 2, 700, size=18, font=b"Helvetica-Bold"),
                    *[_text(line, 72, 650 - index * 14, size=12) for index, line in enumerate(lines)],
                ],
            )
        ]
    )

    result = import_pdf_document("brief.pdf", payload)
    html = html_lib.unescape(result.html)
    body = _body(html)

    assert html.startswith('<div class="document-page-setup"')
    assert "width: 612pt" in html and "height: 792pt" in html
    assert "padding-left: 72pt" in html
    assert "'Times New Roman', 'Liberation Serif', Tinos, Times, serif" in html
    assert "font-size: 17.69px" in html
    heading = re.search(r"<h1 [^>]*>(.*?)</h1>", body)
    assert heading and "Centered Title" in heading.group(1) and "<strong>" in heading.group(1)
    assert "text-align: center" in heading.group(0)
    assert "font-size: 26.53px" in heading.group(0)
    paragraphs = re.findall(r"<p [^>]*>(.*?)</p>", body)
    assert any(
        "must come back as one editable paragraph whose lines keep their pitch" in paragraph
        and "just as they were." in paragraph
        for paragraph in paragraphs
    )
    # 14pt baseline pitch in preview px.
    assert "line-height: 20.64px" in body


def test_runs_keep_color_italic_highlight_and_underline() -> None:
    payload = _pdf_bytes(
        [
            (
                612,
                792,
                [
                    ("rect", {"x": 70, "y": 696, "width": 120, "height": 14, "color": (255, 255, 0)}),
                    _text("Highlighted words", 72, 700, size=12),
                    _text("Colored italic text", 72, 670, font=b"Times-Italic", color=(204, 51, 0)),
                    _text("Underlined", 72, 640),
                    ("rect", {"x": 72, "y": 638, "width": 52, "height": 0.6}),
                ],
            )
        ]
    )

    body = _body(import_pdf_document("styled.pdf", payload).html)

    assert "background-color: #ffff00" in body
    # A paragraph in one color carries it on the paragraph itself.
    assert re.search(r'<p [^>]*color: #cc3300[^>]*><em>Colored italic text</em></p>', body)
    assert "<u>Underlined</u>" in body


def test_lists_indents_and_pictures() -> None:
    payload = _pdf_bytes(
        [
            (
                612,
                792,
                [
                    _text("Body text at the margin anchors the column.", 72, 700),
                    _text("Indented paragraph", 108, 670),
                    _text("•", 90, 640),
                    _text("Bullet item", 108, 640),
                    ("image", {"x": 72, "y": 540, "width": 96, "height": 48}),
                ],
            )
        ]
    )

    body = _body(import_pdf_document("list.pdf", payload).html)

    assert "margin-left: 53.06px" in body
    bullet = re.search(r"<p [^>]*>(?:(?!</p>).)*Bullet item</p>", body)
    assert bullet and 'class="document-list-marker"' in bullet.group(0)
    assert "document-tab document-tab-left document-tab-at-720" in bullet.group(0)
    assert "text-indent: -26.53px" in bullet.group(0)
    assert re.search(r'<img src="data:image/(png|jpeg);base64,[^"]+" alt="" style="width: 141.5\d?px; height: 70.7\dpx', body)


def test_repeating_footer_becomes_page_fields_and_early_break_is_kept() -> None:
    payload = _pdf_bytes(
        [
            (612, 792, [_text("Short first page", 72, 700), _text("Page 1 of 2", 280, 30, size=10)]),
            (612, 792, [_text("Second page body", 72, 700), _text("Page 2 of 2", 280, 30, size=10)]),
        ]
    )

    html = import_pdf_document("footer.pdf", payload).html
    body = _body(html)

    footer = re.search(r'<div class="document-page-footer">(.*?)</div>', html)
    assert footer
    assert '<span class="document-field-page">' in footer.group(1)
    assert '<span class="document-field-pages">2</span>' in footer.group(1)
    assert "Page 1" not in body and "Page 2" not in body
    assert '<hr class="document-page-break">' in body


def test_full_page_flows_on_without_a_hard_break() -> None:
    payload = _pdf_bytes(
        [
            (612, 792, [_text("Top of a full page", 72, 700), _text("Bottom line near the margin", 72, 74)]),
            (612, 792, [_text("Next page", 72, 700)]),
        ]
    )

    assert '<hr class="document-page-break">' not in import_pdf_document("full.pdf", payload).html


def test_ruled_table_keeps_grid_merges_and_shading() -> None:
    rule = 0.75
    objects: list[tuple[str, dict]] = [_text("Lead-in paragraph above the table.", 72, 720)]
    # Header shading, then a 3x2 grid whose right column merges rows 2-3.
    objects.append(("rect", {"x": 72, "y": 676, "width": 300, "height": 20, "color": (31, 56, 100)}))
    for y in (696, 676, 656, 636):
        width = 150 if y == 656 else 300
        objects.append(("rect", {"x": 72, "y": y, "width": width, "height": rule}))
    for x, low in ((72, 636), (222, 636), (372, 636)):
        objects.append(("rect", {"x": x, "y": low, "width": rule, "height": 696 - low}))
    objects += [
        _text("Matter", 78, 682, color=(255, 255, 255)),
        _text("Notes", 228, 682, color=(255, 255, 255)),
        _text("Corporate", 78, 662),
        _text("Merged note", 228, 652),
        _text("Litigation", 78, 642),
    ]
    payload = _pdf_bytes([(612, 792, objects)])

    body = _body(import_pdf_document("table.pdf", payload).html)
    table = re.search(r"<table [^>]*>.*?</table>", body)

    assert table
    assert table.group(0).count("<tr") == 3
    assert 'rowspan="2"' in table.group(0)
    assert "background-color: #1f3864" in table.group(0)
    assert "border-top:" in table.group(0)
    assert "Corporate" in table.group(0) and "Merged note" in table.group(0)
    # Shading belongs to the cell, not repeated behind each word.
    header_cell = re.search(r"<td [^>]*background-color: #1f3864[^>]*>(.*?)</td>", table.group(0))
    assert header_cell and "background-color" not in header_cell.group(1)


def test_output_survives_the_draft_sanitizer() -> None:
    payload = _pdf_bytes(
        [
            (
                612,
                792,
                [
                    _text("Title", 306 - _text_width("Title", b"Helvetica-Bold", 18) / 2, 700, size=18, font=b"Helvetica-Bold"),
                    _text("Body text at the margin.", 72, 660),
                    # Same baseline, far right: a tab-separated column.
                    _text("Right", 540 - _text_width("Right"), 660),
                ],
            )
        ]
    )

    html = import_pdf_document("clean.pdf", payload).html
    sanitized = sanitize_draft_html(html)

    for fragment in (
        'class="document-page-setup"',
        "width: 612pt",
        "padding-top:",
        "margin-top:",
        "line-height:",
        "font-size: 17.69px",
        "text-align: center",
        "font-weight: normal",
        "display: inline-block",
        "document-tab-at-",
    ):
        assert fragment in sanitized, fragment


def test_password_protected_and_garbage_pdfs_fail_honestly() -> None:
    try:
        import_pdf_document("broken.pdf", b"%PDF-1.7 not really a pdf")
    except PdfReadError as error:
        assert "could not be read" in str(error)
    else:  # pragma: no cover
        raise AssertionError("garbage PDF was accepted")


def test_constant_header_digits_stay_text_while_page_numbers_become_fields() -> None:
    pages = [
        (
            612,
            792,
            [
                _text("Schedule 2", 72, 756, size=10),
                _text(f"Body of page {number}", 72, 700),
                _text(f"Page {number} of 3", 280, 30, size=10),
            ],
        )
        for number in (1, 2, 3)
    ]
    html = import_pdf_document("schedule.pdf", _pdf_bytes(pages)).html

    header = re.search(r'<div class="document-page-header">(.*?)</div>', html)
    footer = re.search(r'<div class="document-page-footer">(.*?)</div>', html)
    assert header and "Schedule 2" in header.group(1)
    assert "document-field" not in header.group(1)
    assert footer and '<span class="document-field-page">2</span>' in footer.group(1)
    assert '<span class="document-field-pages">3</span>' in footer.group(1)


def test_control_characters_are_filtered_from_extracted_text() -> None:
    # PDFium's standard-font writer cannot encode C0 controls, so the filter
    # the extractor and OCR paths share is checked directly.
    from app.core.pdf_document_import import _CONTROL_CHARACTERS

    assert _CONTROL_CHARACTERS.sub("", "Clause\x03 text\x1f here\x7f") == "Clause text here"
    assert _CONTROL_CHARACTERS.sub("", "tab\tnewline\n") == "tab\tnewline\n"


def test_conversions_are_capped_so_the_threadpool_cannot_fill_up() -> None:
    from app.core import pdf_document_import as module

    payload = _pdf_bytes([(612, 792, [_text("Waiting", 72, 700)])])
    module._IMPORT_SLOTS.acquire()
    module._IMPORT_SLOTS.acquire()
    try:
        try:
            import_pdf_document("busy.pdf", payload)
        except module.PdfImportBusyError as error:
            assert "Try again" in str(error)
        else:  # pragma: no cover
            raise AssertionError("a third concurrent conversion was accepted")
    finally:
        module._IMPORT_SLOTS.release()
        module._IMPORT_SLOTS.release()
    assert "Waiting" in import_pdf_document("free.pdf", payload).html
