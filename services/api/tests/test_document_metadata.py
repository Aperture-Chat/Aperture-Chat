"""File properties preserved alongside extracted text (synthetic files only)."""

from __future__ import annotations

import zipfile
from datetime import UTC, datetime
from email.message import EmailMessage
from io import BytesIO

from PIL import Image
from pypdf import PdfWriter

from app.core.document_metadata import (
    MAX_METADATA_FIELDS,
    MAX_METADATA_VALUE_CHARS,
    bounded_metadata,
    metadata_summary,
)
from app.core.knowledge_ingestion import extract_document

_CORE = """<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Falcon Purchase Agreement</dc:title><dc:subject>M&amp;A</dc:subject>
<dc:creator>Avery Example</dc:creator><cp:keywords>falcon, draft</cp:keywords>
<cp:lastModifiedBy>Jordan Sample</cp:lastModifiedBy><cp:revision>7</cp:revision>
<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-05T10:00:00Z</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">2026-02-01T09:30:00Z</dcterms:modified>
</cp:coreProperties>"""
_APP = """<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Company>Example Partners LLP</Company><Pages>3</Pages><Application>Microsoft Office Word</Application>
</Properties>"""
_CUSTOM = """<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Ethical wall"><vt:lpwstr>Project Falcon</vt:lpwstr></property>
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="Matter number"><vt:i4>20419</vt:i4></property>
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="4" name="MSIP_Label_0f1e2d3c-1111-2222-3333-444455556666_Name"><vt:lpwstr>Highly Confidential</vt:lpwstr></property>
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="5" name="MSIP_Label_0f1e2d3c-1111-2222-3333-444455556666_SiteId"><vt:lpwstr>tenant-guid</vt:lpwstr></property>
</Properties>"""
_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def _docx(**parts: str) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "word/document.xml",
            f'<w:document {_W}><w:body><w:p><w:r><w:t>Body text.</w:t></w:r></w:p></w:body></w:document>',
        )
        for name, content in parts.items():
            archive.writestr(name.replace("__", "/").replace("_xml", ".xml"), content)
    return buffer.getvalue()


def test_office_core_app_and_custom_properties_are_preserved() -> None:
    content = _docx(
        docProps__core_xml=_CORE, docProps__app_xml=_APP, docProps__custom_xml=_CUSTOM
    )
    metadata = extract_document("falcon.docx", content).metadata
    assert metadata["Title"] == "Falcon Purchase Agreement"
    assert metadata["Subject"] == "M&A"
    assert metadata["Author"] == "Avery Example"
    assert metadata["Keywords"] == "falcon, draft"
    assert metadata["Last modified by"] == "Jordan Sample"
    assert metadata["Revision"] == "7"
    assert metadata["Created"] == "2026-01-05T10:00:00Z"
    assert metadata["Modified"] == "2026-02-01T09:30:00Z"
    assert metadata["Company"] == "Example Partners LLP"
    assert metadata["Pages"] == "3"
    assert metadata["Ethical wall"] == "Project Falcon"
    assert metadata["Matter number"] == "20419"
    # Microsoft Purview sensitivity labels are stored as MSIP custom properties.
    assert metadata["Sensitivity label"] == "Highly Confidential"
    assert not any(key.startswith("MSIP_Label") for key in metadata)


def test_pdf_info_dictionary_and_custom_keys_are_preserved() -> None:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_metadata(
        {
            "/Title": "Kestrel Board Minutes",
            "/Author": "Corporate Secretary",
            "/Subject": "Board meeting",
            "/Keywords": "board; minutes",
            "/CreationDate": "D:20260301120000Z",
            "/EthicalWall": "Heron Team",
        }
    )
    buffer = BytesIO()
    writer.write(buffer)
    metadata = extract_document("minutes.pdf", buffer.getvalue()).metadata
    assert metadata["Title"] == "Kestrel Board Minutes"
    assert metadata["Author"] == "Corporate Secretary"
    assert metadata["Subject"] == "Board meeting"
    assert metadata["Keywords"] == "board; minutes"
    assert metadata["Created"].startswith("2026-03-01T12:00:00")
    assert metadata["Page count"] == "1"
    assert metadata["EthicalWall"] == "Heron Team"


def test_email_headers_and_attachment_names_are_preserved() -> None:
    message = EmailMessage()
    message["From"] = "Avery <avery@example.com>"
    message["To"] = "Jordan <jordan@example.com>"
    message["Cc"] = "team@example.com"
    message["Subject"] = "Falcon closing checklist"
    message["Date"] = "Mon, 02 Mar 2026 09:00:00 +0000"
    message["Message-ID"] = "<falcon-1@example.com>"
    message.set_content("See the attached checklist.")
    message.add_attachment(b"Checklist item one.", maintype="text", subtype="plain", filename="checklist.txt")
    metadata = extract_document("closing.eml", message.as_bytes()).metadata
    assert metadata["From"] == "Avery <avery@example.com>"
    assert metadata["To"] == "Jordan <jordan@example.com>"
    assert metadata["Cc"] == "team@example.com"
    assert metadata["Subject"] == "Falcon closing checklist"
    assert metadata["Sent"] == "Mon, 02 Mar 2026 09:00:00 +0000"
    assert metadata["Message ID"] == "<falcon-1@example.com>"
    assert metadata["Attachments"] == "checklist.txt"


def test_image_exif_is_preserved_without_location() -> None:
    image = Image.new("RGB", (40, 30), "white")
    exif = Image.Exif()
    exif[0x010F] = "ExampleCam"  # Make
    exif[0x0110] = "Model 7"  # Model
    exif[0x013B] = "Site Photographer"  # Artist
    exif[0x0132] = "2026:03:04 10:11:12"  # DateTime
    exif[0x8825] = {1: "N", 2: (1.0, 2.0, 3.0)}  # GPS IFD
    buffer = BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    metadata = extract_document("site.jpg", buffer.getvalue(), ocr_enabled=False).metadata
    assert metadata["Camera"] == "ExampleCam Model 7"
    assert metadata["Artist"] == "Site Photographer"
    assert metadata["Taken"] == "2026:03:04 10:11:12"
    assert metadata["Dimensions"] == "40 × 30 px"
    assert not any("gps" in key.lower() or "location" in key.lower() for key in metadata)


def test_unknown_formats_have_no_metadata() -> None:
    assert extract_document("data.bin", b"\x00\x01").metadata == {}


def test_metadata_is_bounded_and_cleaned() -> None:
    pairs = [(f"Field {index}", f"value {index}") for index in range(MAX_METADATA_FIELDS + 20)]
    pairs.append(("Long", "x" * (MAX_METADATA_VALUE_CHARS + 50)))
    pairs.insert(0, ("Control\x00chars", "a\x07b\n c"))
    pairs.insert(0, ("Empty", "   "))
    metadata = bounded_metadata(pairs)
    assert len(metadata) == MAX_METADATA_FIELDS
    assert "Empty" not in metadata
    assert metadata["Controlchars"] == "ab c"


def test_bounded_metadata_truncates_long_values() -> None:
    metadata = bounded_metadata([("Long", "x" * (MAX_METADATA_VALUE_CHARS + 50))])
    assert len(metadata["Long"]) == MAX_METADATA_VALUE_CHARS
    assert metadata["Long"].endswith("…")


def test_summary_lists_the_most_useful_properties_first() -> None:
    summary = metadata_summary(
        {
            "Pages": "3",
            "Title": "Falcon Purchase Agreement",
            "Author": "Avery Example",
            "Modified": "2026-02-01T09:30:00Z",
            "Sensitivity label": "Highly Confidential",
            "Ethical wall": "Project Falcon",
        }
    )
    assert summary == (
        "Title: Falcon Purchase Agreement · Author: Avery Example · "
        "Modified: 2026-02-01T09:30:00Z · Sensitivity label: Highly Confidential · "
        "Ethical wall: Project Falcon"
    )


def test_upload_facts_and_technical_counts_are_not_descriptive() -> None:
    from app.core.document_metadata import descriptive_properties

    metadata = {
        "File size": "2 KB",
        "Uploaded by": "Alex Morgan",
        "Uploaded": "Oct 28, 2026",
        "Page count": "1",
        "Producer": "Example PDF Library",
        "Matter number": "2026-0419",
    }
    assert descriptive_properties(metadata) == [("Matter number", "2026-0419")]
    assert metadata_summary({key: metadata[key] for key in ("File size", "Uploaded by")}) is None


def test_summary_is_capped() -> None:
    summary = metadata_summary({f"Key {index}": "v" * 80 for index in range(20)})
    assert summary is not None and len(summary) <= 320


def test_empty_summary_is_none() -> None:
    assert metadata_summary({}) is None


def test_created_date_from_datetime_is_iso() -> None:
    from app.core.document_metadata import metadata_value

    assert metadata_value(datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)) == "2026-01-02T03:04:05+00:00"
    assert metadata_value(["a", "b"]) == "a, b"
    assert metadata_value(None) == ""


def test_outlook_metadata_reads_sender_headers_and_attachment_names() -> None:
    from app.core.document_metadata import outlook_metadata

    class Attachment:
        def __init__(self, name: str | None) -> None:
            self.file_name = name

    class Message:
        sender = "Avery <avery@example.com>"
        subject = "Falcon closing"
        sent_date = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        message_headers = {"To": "jordan@example.com", "CC": "team@example.com", "Message-ID": "<m1@example.com>"}
        attachments = [Attachment("checklist.pdf"), Attachment(None)]

    metadata = bounded_metadata(outlook_metadata(Message()))
    assert metadata == {
        "From": "Avery <avery@example.com>",
        "To": "jordan@example.com",
        "Cc": "team@example.com",
        "Sent": "2026-03-02T09:00:00+00:00",
        "Subject": "Falcon closing",
        "Message ID": "<m1@example.com>",
        "Attachments": "checklist.pdf",
    }


def test_outlook_metadata_falls_back_to_headers() -> None:
    from app.core.document_metadata import outlook_metadata

    class Message:
        sender = None
        subject = None
        sent_date = None
        message_headers = {"From": "x@example.com", "Subject": "Re: hello", "Date": "Mon, 2 Mar 2026"}
        attachments = None

    metadata = bounded_metadata(outlook_metadata(Message()))
    assert metadata == {"From": "x@example.com", "Sent": "Mon, 2 Mar 2026", "Subject": "Re: hello"}


def test_value_at_the_limit_is_kept_whole() -> None:
    value = "v" * MAX_METADATA_VALUE_CHARS
    assert bounded_metadata([("Exact", value)])["Exact"] == value


def test_summary_fills_exactly_to_its_cap() -> None:
    from app.core.document_metadata import MAX_SUMMARY_CHARS

    exact = "x" * (MAX_SUMMARY_CHARS - len("Title: "))
    assert metadata_summary({"Title": exact}) == f"Title: {exact}"
    assert metadata_summary({"Title": exact + "y"}) is None


def test_summary_counts_the_separator_between_properties() -> None:
    from app.core.document_metadata import MAX_SUMMARY_CHARS

    first = "Title: " + "a" * 93  # 100 characters
    room = MAX_SUMMARY_CHARS - len(first) - 3
    fits = "b" * (room - len("Author: "))
    assert metadata_summary({"Title": first[7:], "Author": fits}) == f"{first} · Author: {fits}"
    assert metadata_summary({"Title": first[7:], "Author": fits + "c"}) == first


def test_office_properties_without_namespaces_are_read() -> None:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", "<document><body/></document>")
        archive.writestr("docProps/app.xml", "<Properties><Company>Example LLP</Company></Properties>")
    from app.core.document_metadata import office_metadata

    assert office_metadata(buffer.getvalue()) == [("Company", "Example LLP")]


def test_metadata_is_read_from_a_file_object_at_any_position() -> None:
    content = _docx(docProps__core_xml=_CORE)
    stream = BytesIO(content)
    stream.seek(len(content))
    assert extract_document("falcon.docx", stream).metadata["Title"] == "Falcon Purchase Agreement"


def test_xmp_custom_properties_tolerate_missing_values() -> None:
    from app.core.document_metadata import _xmp_custom_properties

    class Xmp:
        def __init__(self, custom: object) -> None:
            self.custom_properties = custom

    class Reader:
        def __init__(self, xmp: object) -> None:
            self.xmp_metadata = xmp

    assert _xmp_custom_properties(Reader(Xmp(None))) == []
    assert _xmp_custom_properties(Reader(None)) == []
    assert _xmp_custom_properties(Reader(Xmp({"Wall": "Heron"}))) == [("Wall", "Heron")]


def test_image_metadata_is_read_from_a_file_object_at_any_position() -> None:
    buffer = BytesIO()
    Image.new("RGB", (12, 8), "white").save(buffer, format="PNG")
    buffer.seek(5)
    metadata = extract_document("pixel.png", buffer, ocr_enabled=False).metadata
    assert metadata["Dimensions"] == "12 × 8 px"


def test_pdf_metadata_is_read_from_a_file_object_at_any_position() -> None:
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.add_metadata({"/Title": "Mid-stream"})
    buffer = BytesIO()
    writer.write(buffer)
    assert extract_document("mid.pdf", buffer).metadata["Title"] == "Mid-stream"
