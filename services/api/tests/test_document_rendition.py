"""How a stored file becomes a view: format sniffing, the sanitized copy, the
guarded process, and the cache. LibreOffice itself is played by a shell script,
so these run everywhere; the real thing is in test_document_rendition_proof."""

from __future__ import annotations

import errno
import gzip
import io
import os
import stat
import threading
import time
import warnings
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pikepdf
import pypdfium2
import pytest
from PIL import Image

from app.core import document_rendition as rendition
from app.core import scan_worker
from app.core.config import Settings, resolve_repo_path
from app.core.document_rendition import (
    ConversionError,
    RenditionOptions,
    fit_sheet_to_width,
    find_soffice,
    prepare_document,
    prepare_input,
    profile_settings_xml,
    sniff_office_format,
    soffice_environment,
)
from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore
from tests import crafted_documents as crafted

REF = DocumentRef("tenant", "config", "document")


def _script(path: Path, body: str) -> str:
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


# A stand-in for soffice: writes a PDF where the real one would, into --outdir.
_FAKE_CONVERT = '''
while [ $# -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then shift; outdir="$1"; fi
  shift
done
printf '%%PDF-1.7 fake' > "$outdir/input.pdf"
'''


@pytest.fixture
def originals(tmp_path: Path) -> KnowledgeOriginalStore:
    return KnowledgeOriginalStore(tmp_path / "originals")


def _options(soffice: str | None, timeout: float = 20.0) -> RenditionOptions:
    return RenditionOptions(
        soffice=soffice, timeout_seconds=timeout, memory_mb=2048, require_isolation=False
    )


def _docx() -> bytes:
    return crafted.docx("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")


def _prepared(originals: KnowledgeOriginalStore, soffice: str | None, **kwargs: object):
    return prepare_document(originals, REF, name="brief.docx", options=_options(soffice, **kwargs))


@pytest.fixture
def fake_pdf_count(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stand-in writes a marker file, not a page PDFium could open."""
    monkeypatch.setattr(rendition, "_pdf_page_count", lambda _path: 2)


# ------------------------------------------------------------------- sniffing


@pytest.mark.parametrize(
    ("build", "extension"),
    [
        (_docx, "docx"),
        (lambda: crafted.xlsx(""), "xlsx"),
        (lambda: crafted.pptx(""), "pptx"),
        (lambda: b"{\\rtf1 hello}", "rtf"),
        (lambda: crafted.odf("application/vnd.oasis.opendocument.text", ""), "odt"),
        (lambda: crafted.odf("application/vnd.oasis.opendocument.spreadsheet", ""), "ods"),
        (lambda: crafted.odf("application/vnd.oasis.opendocument.presentation", ""), "odp"),
    ],
)
def test_format_comes_from_the_bytes_whatever_the_name(
    tmp_path: Path, build: object, extension: str
) -> None:
    path = tmp_path / "misleading-name.txt"
    path.write_bytes(build())
    office_format = sniff_office_format(path)
    assert office_format is not None
    assert office_format.extension == extension


@pytest.mark.parametrize(
    "content",
    [
        b"just some text",
        b"PK\x03\x04 but not really a zip",
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 a legacy OLE compound file",
        b"<html><body>hello</body></html>",
        b"",
    ],
)
def test_anything_else_is_not_converted(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "report.docx"
    path.write_bytes(content)
    assert sniff_office_format(path) is None


def _zip(parts: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return buffer.getvalue()


@pytest.mark.parametrize(
    "parts",
    [
        {"unrelated.txt": b"a plain zip"},
        {"mimetype": b"application/epub+zip"},
        {"mimetype": b"x" * 1000},
        {"[Content_Types].xml": b"<not-xml"},
        {"[Content_Types].xml": b"<Types><Override ContentType='text/plain'/></Types>"},
        {"[Content_Types].xml": b"<!DOCTYPE x [<!ENTITY y 'z'>]><Types/>"},
    ],
)
def test_zip_that_is_not_an_allowlisted_document_is_not_converted(
    tmp_path: Path, parts: dict[str, bytes]
) -> None:
    path = tmp_path / "file.docx"
    path.write_bytes(_zip(parts))
    assert sniff_office_format(path) is None


# ----------------------------------------------------- the copy LibreOffice sees


def _prepared_copy(tmp_path: Path, content: bytes) -> Path:
    source = tmp_path / "source"
    source.write_bytes(content)
    office_format = sniff_office_format(source)
    assert office_format is not None
    target = tmp_path / f"input.{office_format.extension}"
    prepare_input(source, office_format, target)
    return target


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (9, 8, 7)).save(buffer, "PNG")
    return buffer.getvalue()


def _copied_parts(copy: Path) -> set[str]:
    with zipfile.ZipFile(copy) as archive:
        return set(archive.namelist())


def _relationships_of(copy: Path, part: str = "word/_rels/document.xml.rels") -> str:
    with zipfile.ZipFile(copy) as archive:
        return archive.read(part).decode()


def test_no_external_relationship_reaches_the_converter_whatever_it_calls_itself(
    tmp_path: Path,
) -> None:
    content = crafted.docx(
        "",
        rels=[
            ("rId1", f"{crafted.OFFICE_RELS}/image", "file:///etc/passwd", True),
            ("rId2", f"{crafted.OFFICE_RELS}/oleObject", "http://169.254.169.254/x", True),
            ("rId3", f"{crafted.OFFICE_RELS}/hyperlink", "https://example.test/gone", True),
        ],
    )
    relationships = _relationships_of(_prepared_copy(tmp_path, content))
    assert "/etc/passwd" not in relationships
    assert "169.254" not in relationships
    assert "example.test" not in relationships


def test_external_relationship_in_any_spelling_is_found(tmp_path: Path) -> None:
    hostile = (
        f'<Relationships xmlns="{crafted.PACKAGE_RELS}">'
        '<Relationship Target="file:///etc/passwd" TargetMode="&#69;xternal" Id="rId1" '
        f'Type="{crafted.OFFICE_RELS}/image"/></Relationships>'
    )
    source = crafted.docx("", settings="<w:zoom w:percent='100'/>")
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(source)) as archive, zipfile.ZipFile(buffer, "w") as rewritten:
        for entry in archive.infolist():
            rewritten.writestr(entry, archive.read(entry))
        rewritten.writestr("word/_rels/settings.xml.rels", hostile)
    copy = _prepared_copy(tmp_path, buffer.getvalue())
    assert "/etc/passwd" not in _relationships_of(copy, "word/_rels/settings.xml.rels")


def test_a_relationship_stays_only_if_it_is_a_known_kind_pointing_at_a_kept_part(
    tmp_path: Path,
) -> None:
    content = crafted.docx(
        "",
        rels=[
            ("rIdGood", f"{crafted.OFFICE_RELS}/image", "media/real.png", False),
            ("rIdEncoded", f"{crafted.OFFICE_RELS}/image", "media/with%20space.png", False),
            ("rIdAbsolute", f"{crafted.OFFICE_RELS}/image", "/word/media/real.png", False),
            ("rIdUp", f"{crafted.OFFICE_RELS}/image", "../word/media/real.png", False),
            ("rIdLiar", f"{crafted.OFFICE_RELS}/image", "media/fake.png", False),
            ("rIdMissing", f"{crafted.OFFICE_RELS}/image", "media/absent.png", False),
            ("rIdUnknown", "urn:not-a-kind", "media/real.png", False),
            ("rIdOle", f"{crafted.OFFICE_RELS}/oleObject", "media/real.png", False),
        ],
        extra_parts={
            "word/media/real.png": _png(),
            "word/media/with space.png": _png(),
            "word/media/fake.png": b"<html><img src='file:///x'></html>",
        },
    )
    relationships = _relationships_of(_prepared_copy(tmp_path, content))
    for kept in ("rIdGood", "rIdEncoded", "rIdAbsolute", "rIdUp"):
        assert f'Id="{kept}"' in relationships
    for dropped in ("rIdLiar", "rIdMissing", "rIdUnknown", "rIdOle"):
        assert dropped not in relationships


def test_only_the_parts_a_rendition_needs_reach_the_converter(tmp_path: Path) -> None:
    content = crafted.docx(
        "",
        extra_parts={
            "word/media/real.png": _png(),
            "word/media/fake.png": b"<html><img src='file:///x'></html>",
            "word/media/trap.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
            "word/media/trap.xml": "<svg xmlns='http://www.w3.org/2000/svg'/>",
            "word/afchunk.html": "<html></html>",
            "word/embeddings/inner.docx": b"PK\x03\x04 nested",
            "word/vbaProject.bin": b"\xd0\xcf\x11\xe0 macros",
            "customXml/item1.xml": "<data/>",
            "docProps/core.xml": "<props/>",
            "word/theme/theme1.xml": "<theme/>",
        },
    )
    parts = _copied_parts(_prepared_copy(tmp_path, content))
    assert {"word/media/real.png", "word/theme/theme1.xml", "word/document.xml"} <= parts
    assert not parts & {
        "word/media/fake.png",
        "word/media/trap.svg",
        "word/media/trap.xml",
        "word/afchunk.html",
        "word/embeddings/inner.docx",
        "word/vbaProject.bin",
        "customXml/item1.xml",
        "docProps/core.xml",
    }


@pytest.mark.parametrize(
    "image_format", ["PNG", "JPEG", "GIF", "BMP", "TIFF", "WEBP"], ids=str.lower
)
def test_ordinary_pictures_are_kept(tmp_path: Path, image_format: str) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (9, 8, 7)).save(buffer, image_format)
    content = crafted.docx("", extra_parts={"word/media/picture.bin": buffer.getvalue()})
    assert "word/media/picture.bin" in _copied_parts(_prepared_copy(tmp_path, content))


def _emf(*, size: int = 200) -> bytes:
    """The header of a real enhanced metafile, as Windows writes it."""
    header = (
        (1).to_bytes(4, "little")  # record type EMR_HEADER
        + (108).to_bytes(4, "little")  # record size
        + b"\x00" * 32  # bounds and frame
        + b" EMF"
        + (0x10000).to_bytes(4, "little")  # version
        + size.to_bytes(4, "little")  # total bytes
        + (3).to_bytes(4, "little")  # records
    )
    return header.ljust(size, b"\x00")


def _wmf_header() -> bytes:
    return (
        (1).to_bytes(2, "little")  # in memory
        + (9).to_bytes(2, "little")  # header words
        + (0x0300).to_bytes(2, "little")  # version
    ).ljust(60, b"\x00")


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("image1.emf", _emf()),
        ("image1.wmf", _wmf_header()),
        ("image2.wmf", b"\xd7\xcd\xc6\x9a" + b"\x00" * 18 + _wmf_header()),
        ("image1.emz", gzip.compress(_emf())),
    ],
)
def test_office_metafiles_are_kept(tmp_path: Path, name: str, content: bytes) -> None:
    source = crafted.docx("", extra_parts={f"word/media/{name}": content})
    assert f"word/media/{name}" in _copied_parts(_prepared_copy(tmp_path, source))


def _at_offset_40(content: bytes) -> bytes:
    return b"<!--" + b"x" * 36 + b" EMF-->" + content


@pytest.mark.parametrize(
    "content",
    [
        _at_offset_40(b"<w:altChunk xmlns:w='urn:w' r:id='rId1'/>"),
        b"\x00" * 40 + b" EMF" + b"\x00" * 60,
        (1).to_bytes(4, "little") + b"\x00" * 36 + b" EMF" + b"\x00" * 60,
        (1).to_bytes(4, "little") + (7).to_bytes(4, "little") + b"\x00" * 32 + b" EMF",
        _emf()[:44] + (5).to_bytes(4, "little") + _emf()[48:],
        _emf(size=200)[:48] + (9999).to_bytes(4, "little") + _emf()[52:],
        b"PK\x03\x04 a nested package",
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 an OLE2 compound file",
        b"\x89PNG\r\n\x1a\n and then not a header",
        b"\xff\xd8\xff" + b"\x00" * 8,
        b"GIF89a" + b"\x00" * 8,
        b"II*\x00" + b"\x00" * 16,
        b"MM\x00*" + b"\xff" * 16,
        b"RIFF\x10\x00\x00\x00WEBPnope",
        (2).to_bytes(2, "little") + (8).to_bytes(2, "little") + (0x0300).to_bytes(2, "little"),
        (1).to_bytes(2, "little") + (9).to_bytes(2, "little") + (0x0555).to_bytes(2, "little"),
        b"\xd7\xcd\xc6\x9a" + b"\x00" * 30,
    ],
    ids=lambda content: content[:6].hex(),
)
def test_a_signature_alone_does_not_make_a_picture(tmp_path: Path, content: bytes) -> None:
    source = crafted.docx(
        "",
        rels=[("rIdMasked", f"{crafted.OFFICE_RELS}/image", "masked.emf", False)],
        extra_parts={"word/masked.emf": content},
    )
    copy = _prepared_copy(tmp_path, source)
    assert "word/masked.emf" not in _copied_parts(copy)
    assert "rIdMasked" not in _relationships_of(copy)


def _kept_as_a_picture(tmp_path: Path, content: bytes) -> bool:
    source = crafted.docx("", extra_parts={"word/media/picture.bin": content})
    return "word/media/picture.bin" in _copied_parts(_prepared_copy(tmp_path, source))


def _emf_with(*, record_size: int = 108, total: int = 200) -> bytes:
    head = bytearray(_emf())
    head[4:8] = record_size.to_bytes(4, "little")
    head[48:52] = total.to_bytes(4, "little")
    return bytes(head)


@pytest.mark.parametrize(
    ("content", "kept"),
    [
        (b"GIF89a\x01\x00\x01\x00" + b"\x00" * 8, True),
        (b"GIF89a\x00\x00\x01\x00" + b"\x00" * 8, False),
        (b"GIF89a\x01\x00\x00\x00" + b"\x00" * 8, False),
        (b"MM\x00*\x00\x00\x00\x08" + b"\x00" * 8, True),
        (b"II*\x00\x08\x00\x00\x00" + b"\x00" * 8, True),
        (b"II*\x00\x07\x00\x00\x00" + b"\x00" * 8, False),
        (b"II*\x00\x10\x00\x00\x00" + b"\x00" * 8, False),
        (_emf_with(record_size=88), True),
        (_emf_with(record_size=84), False),
        (_emf_with(record_size=90), False),
        (_emf_with(total=200), True),
        (_emf_with(total=0), False),
        (_emf_with(total=201), False),
        (b"\xff\xd8\xff\xc0" + b"\x00" * 8, True),
        (b"\xff\xd8\xff\xfe" + b"\x00" * 8, True),
        (b"\xff\xd8\xff", False),
        (b"\xff\xd8\xff\xbf" + b"\x00" * 8, False),
        (b"\xff\xd8\xff\xff" + b"\x00" * 8, False),
    ],
    ids=lambda value: value.hex()[:16] if isinstance(value, bytes) else str(value),
)
def test_picture_headers_at_their_edges(tmp_path: Path, content: bytes, kept: bool) -> None:
    assert _kept_as_a_picture(tmp_path, content) is kept


def _moved_to_a_picture_name(content: bytes) -> bytes:
    """The document's own body, moved to a part the scan would treat as a picture."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(content)) as archive, zipfile.ZipFile(buffer, "w") as moved:
        for entry in archive.infolist():
            name, data = entry.filename, archive.read(entry)
            if name == "word/document.xml":
                name, data = "word/body.emf", _emf().replace(b"\x00" * 60, data[:60], 1)
            elif name == "word/_rels/document.xml.rels":
                name = "word/_rels/body.emf.rels"
            elif name == "_rels/.rels":
                data = data.replace(b"word/document.xml", b"word/body.emf")
            moved.writestr(name, data)
    return buffer.getvalue()


def test_a_real_picture_cannot_play_the_main_document(tmp_path: Path) -> None:
    copy = _prepared_copy(tmp_path, _moved_to_a_picture_name(crafted.docx("")))
    assert "body.emf" not in _relationships_of(copy, "_rels/.rels")


@pytest.mark.parametrize(
    "kind",
    ["header", "footer", "officeDocument", "chart", "slide", "worksheet", "drawing", "theme"],
)
def test_only_an_image_relationship_may_reach_a_part_not_named_as_xml(
    tmp_path: Path, kind: str
) -> None:
    source = crafted.docx(
        "",
        rels=[
            ("rIdPlaying", f"{crafted.OFFICE_RELS}/{kind}", "media/real.png", False),
            ("rIdPicture", f"{crafted.OFFICE_RELS}/image", "media/real.png", False),
        ],
        extra_parts={"word/media/real.png": _png()},
    )
    relationships = _relationships_of(_prepared_copy(tmp_path, source))
    assert "rIdPlaying" not in relationships
    assert "rIdPicture" in relationships


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("word/embeddings/inner.docx", crafted.docx("")),
        ("word/embeddings/oleObject1.bin", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 512),
        ("word/vbaProject.bin", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 512),
    ],
)
def test_nested_packages_and_ole_blobs_never_arrive(
    tmp_path: Path, name: str, content: bytes
) -> None:
    source = crafted.docx("", extra_parts={name: content})
    assert name not in _copied_parts(_prepared_copy(tmp_path, source))


def test_gzip_that_is_not_a_metafile_is_dropped(tmp_path: Path) -> None:
    content = crafted.docx(
        "", extra_parts={"word/media/image1.svgz": gzip.compress(b"<svg/>"), "word/media/x.gz": b"\x1f\x8bnot"}
    )
    parts = _copied_parts(_prepared_copy(tmp_path, content))
    assert "word/media/image1.svgz" not in parts
    assert "word/media/x.gz" not in parts


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"kind": "urn:not-a-chunk"},
        {"document_encoding": "UTF-16"},
        {
            "wrap": (
                '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
                '<mc:Choice Requires="w">{}</mc:Choice></mc:AlternateContent>'
            )
        },
    ],
    ids=["retyped", "unknown-type", "utf-16", "alternate-content"],
)
def test_a_nested_document_is_refused_by_what_it_is_not_what_it_says(
    tmp_path: Path, options: dict[str, object]
) -> None:
    source = tmp_path / "source"
    source.write_bytes(crafted.retyped_chunk("file:///x.png", **options))
    with pytest.raises(ConversionError, match="nests"):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.docx")


def test_subdocument_element_is_refused(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_bytes(crafted.docx('<w:p><w:subDoc r:id="rId9"/></w:p>'))
    with pytest.raises(ConversionError, match="nests"):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.docx")


def test_entity_in_any_part_is_refused(tmp_path: Path) -> None:
    content = crafted.docx(
        "", extra_parts={"word/footer1.xml": '<!DOCTYPE x [<!ENTITY y "z">]><w:ftr/>'}
    )
    source = tmp_path / "source"
    source.write_bytes(content)
    with pytest.raises(ConversionError, match="entity"):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.docx")


def test_malformed_xml_part_is_refused(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_bytes(crafted.docx("", extra_parts={"word/footer1.xml": "<not-closed"}))
    with pytest.raises(rendition.expat.ExpatError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.docx")


def test_relationship_part_with_an_entity_is_refused(tmp_path: Path) -> None:
    bomb = b'<!DOCTYPE x [<!ENTITY a "b">]><Relationships/>'
    source = tmp_path / "source"
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(_docx())) as archive, zipfile.ZipFile(buffer, "w") as rewritten:
        for entry in archive.infolist():
            content = bomb if entry.filename == "word/_rels/document.xml.rels" else archive.read(entry)
            rewritten.writestr(entry.filename, content)
    source.write_bytes(buffer.getvalue())
    office_format = sniff_office_format(source)
    with pytest.raises(rendition.DefusedXmlException):
        prepare_input(source, office_format, tmp_path / "input.docx")


def test_package_that_expands_too_far_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rendition, "_MAX_PACKAGE_BYTES", 10)
    source = tmp_path / "source"
    source.write_bytes(_docx())
    with pytest.raises(ConversionError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.docx")


def test_package_with_too_many_entries_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rendition, "_MAX_PACKAGE_ENTRIES", 1)
    source = tmp_path / "source"
    source.write_bytes(_docx())
    with pytest.raises(ConversionError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.docx")


def _encrypted(content: bytes) -> bytes:
    """Set the 'encrypted' flag on every entry, which ``zipfile`` will not read."""
    buffer = bytearray(content)
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        start = buffer.find(signature)
        while start != -1:
            buffer[start + flag_offset] |= 1
            start = buffer.find(signature, start + 4)
    return bytes(buffer)


def test_password_protected_package_is_not_treated_as_a_document(tmp_path: Path) -> None:
    path = tmp_path / "locked.docx"
    path.write_bytes(_encrypted(_docx()))
    assert sniff_office_format(path) is None


def test_package_that_breaks_while_copying_falls_back_to_text(
    tmp_path: Path, originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    originals.save(REF, _docx())

    def explode(*_args: object) -> None:
        raise RuntimeError("File is encrypted, password required")

    monkeypatch.setattr(rendition, "prepare_input", explode)
    prepared = _prepared(originals, soffice)
    assert (prepared.mode, prepared.notice) == ("text", "conversion_failed")


def _largest_entry(content: bytes, suffix: str) -> int:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        return max(
            entry.file_size for entry in archive.infolist() if entry.filename.endswith(suffix)
        )


def test_package_exactly_at_its_limits_is_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = _docx()
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
    monkeypatch.setattr(rendition, "_MAX_PACKAGE_ENTRIES", len(entries))
    monkeypatch.setattr(rendition, "_MAX_PACKAGE_BYTES", sum(entry.file_size for entry in entries))
    monkeypatch.setattr(rendition, "_MAX_RELATIONSHIPS_BYTES", _largest_entry(content, ".rels"))
    _prepared_copy(tmp_path, content)


def test_types_part_exactly_at_its_limit_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = _docx()
    monkeypatch.setattr(rendition, "_MAX_TYPES_BYTES", _largest_entry(content, "Content_Types].xml"))
    path = tmp_path / "file.docx"
    path.write_bytes(content)
    assert sniff_office_format(path) is not None


def test_mimetype_entry_of_the_largest_allowed_size_is_read(tmp_path: Path) -> None:
    mimetype = b"application/vnd.oasis.opendocument.text".ljust(256)
    path = tmp_path / "file.odt"
    path.write_bytes(_zip({"mimetype": mimetype}))
    assert sniff_office_format(path).extension == "odt"


def test_sheet_exactly_at_the_patch_limit_is_fitted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = crafted.xlsx("")
    monkeypatch.setattr(
        rendition, "_MAX_PATCHED_SHEET_BYTES", _largest_entry(content, "sheet1.xml")
    )
    with zipfile.ZipFile(_prepared_copy(tmp_path, content)) as archive:
        assert b"fitToPage" in archive.read("xl/worksheets/sheet1.xml")


def test_oversized_relationship_part_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rendition, "_MAX_RELATIONSHIPS_BYTES", 10)
    source = tmp_path / "source"
    source.write_bytes(_docx())
    with pytest.raises(ConversionError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.docx")


def test_rtf_fields_lose_their_instructions_and_keep_their_results(tmp_path: Path) -> None:
    content = (
        b"{\\rtf1 Text {\\field{\\*\\fldinst INCLUDEPICTURE \"file:///x.png\"}{\\fldrslt saved}}"
        b"{\\field{\\fldinst LINK x}{\\fldrslt also}} {\\object\\objautlink\\objupdate y}}"
    )
    copy = _prepared_copy(tmp_path, content)
    rewritten = copy.read_bytes()
    assert b"\\fldinst" not in rewritten
    assert b"\\objautlink" not in rewritten
    assert b"\\objupdate" not in rewritten
    assert b"\\fldrslt saved" in rewritten
    assert rewritten.startswith(b"{\\rtf1 Text")


def test_rtf_control_words_that_merely_begin_alike_are_left_alone(tmp_path: Path) -> None:
    content = b"{\\rtf1 {\\fldinstx kept}\\objlinks kept}"
    assert _prepared_copy(tmp_path, content).read_bytes() == content


def test_rtf_control_words_are_matched_in_any_case(tmp_path: Path) -> None:
    content = b'{\\rtf1 {\\field{\\*\\FLDINST INCLUDEPICTURE "x"}{\\fldrslt saved}}\\OBJAUTLINK}'
    rewritten = _prepared_copy(tmp_path, content).read_bytes()
    assert b"FLDINST" not in rewritten
    assert b"OBJAUTLINK" not in rewritten


@pytest.mark.parametrize(
    "href",
    ["file:///etc/passwd", "http://internal/x.png", "smb://host/share", "/etc/passwd", "../up.png"],
)
def test_odf_that_reaches_outside_is_refused(tmp_path: Path, href: str) -> None:
    body = f'<office:text><draw:image xlink:href="{href}" xlink:type="simple"/></office:text>'
    source = tmp_path / "source"
    source.write_bytes(crafted.odf("application/vnd.oasis.opendocument.text", body))
    with pytest.raises(ConversionError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


def test_odf_namespace_alias_cannot_hide_an_outside_reference(tmp_path: Path) -> None:
    body = (
        '<office:text><draw:image xmlns:hidden="http://www.w3.org/1999/xlink" '
        'hidden:href="file:///etc/passwd"/></office:text>'
    )
    source = tmp_path / "source"
    source.write_bytes(crafted.odf("application/vnd.oasis.opendocument.text", body))
    with pytest.raises(ConversionError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


def test_outside_reference_in_a_nested_odf_object_is_refused(tmp_path: Path) -> None:
    inner = (
        '<?xml version="1.0"?><x xmlns:xlink="http://www.w3.org/1999/xlink" '
        'xlink:href="file:///etc/passwd"/>'
    )
    source = tmp_path / "source"
    source.write_bytes(
        crafted.odf(
            "application/vnd.oasis.opendocument.text",
            "<office:text/>",
            extra={"Object 1/content.xml": inner},
        )
    )
    with pytest.raises(ConversionError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


def test_a_part_name_used_twice_is_refused(tmp_path: Path) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as repeated:
        with zipfile.ZipFile(io.BytesIO(crafted.docx(""))) as archive:
            for entry in archive.infolist():
                repeated.writestr(entry.filename, archive.read(entry))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            repeated.writestr("word/media/real.png", _png())
            repeated.writestr("word/media/real.png", b"NOT A PICTURE")
    source = tmp_path / "source"
    source.write_bytes(buffer.getvalue())
    with pytest.raises(ConversionError, match="repeats"):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.docx")


def test_an_odf_part_name_used_twice_is_refused(tmp_path: Path) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as repeated:
        with zipfile.ZipFile(
            io.BytesIO(crafted.odf("application/vnd.oasis.opendocument.text", "<office:text/>"))
        ) as archive:
            for entry in archive.infolist():
                repeated.writestr(entry.filename, archive.read(entry))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            repeated.writestr("content.xml", "<not-scanned-if-the-first-wins/>")
    source = tmp_path / "source"
    source.write_bytes(buffer.getvalue())
    with pytest.raises(ConversionError, match="repeats"):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


_CHART_PART = "<c:chartSpace xmlns:c='http://schemas.openxmlformats.org/drawingml/2006/chart'/>"


def _charted(body: str = "", **options: object) -> bytes:
    return crafted.docx(
        body,
        rels=[("rIdChart", f"{crafted.OFFICE_RELS}/chart", "charts/chart1.xml", False)],
        extra_parts={"word/charts/chart1.xml": _CHART_PART, **options},
    )


def _draws_charts(tmp_path: Path, content: bytes) -> bool:
    source = tmp_path / "source"
    source.write_bytes(content)
    return prepare_input(source, sniff_office_format(source), tmp_path / "copy")


def test_a_document_with_no_chart_keeps_active_content_off(tmp_path: Path) -> None:
    assert _draws_charts(tmp_path, crafted.docx("")) is False


def test_a_document_with_only_charts_may_draw_them(tmp_path: Path) -> None:
    assert _draws_charts(tmp_path, _charted()) is True


@pytest.mark.parametrize(
    "body",
    [
        '<w:p><w:r><w:object><o:OLEObject Type="Embed" ProgID="Word.Document.12"/></w:object></w:r></w:p>',
        '<w:p><w:r><w:control r:id="rId9"/></w:r></w:p>',
        '<w:p><w:fldSimple w:instr=" DDEAUTO excel &quot;Sheet1&quot; "/></w:p>',
        '<w:p><w:r><w:instrText> DDE excel x </w:instrText></w:r></w:p>',
        '<w:p><w:r><w:instrText> DD</w:instrText></w:r><w:r><w:instrText>E excel x </w:instrText></w:r></w:p>',
        '<w:p><w:r><w:instrText xml:space="preserve"> LINK Excel.Sheet.12 x </w:instrText></w:r></w:p>',
    ],
    ids=["ole", "control", "dde-simple", "dde-field", "dde-split-across-runs", "link-field"],
)
def test_a_chart_beside_anything_active_stays_off_and_loses_the_chart(
    tmp_path: Path, body: str
) -> None:
    assert _draws_charts(tmp_path, _charted(body)) is False


def test_active_elements_in_any_kept_part_count(tmp_path: Path) -> None:
    part = (
        '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<ddeLink ddeService="soffice" ddeTopic="x"/></externalLink>'
    )
    assert _draws_charts(tmp_path, _charted(**{"word/extra.xml": part})) is False


def test_only_field_instructions_are_read_as_fields(tmp_path: Path) -> None:
    body = (
        "<w:p><w:r><w:t> DDE is only a word here </w:t></w:r>"
        "<w:r><w:instrText> PAGE </w:instrText> LINK after it <w:t> LINK too </w:t></w:r></w:p>"
    )
    assert _draws_charts(tmp_path, _charted(body)) is True


def test_a_hyperlink_field_is_not_a_link_field(tmp_path: Path) -> None:
    body = '<w:p><w:r><w:instrText> HYPERLINK "https://example.test" </w:instrText></w:r></w:p>'
    assert _draws_charts(tmp_path, _charted(body)) is True


def test_rtf_and_odf_never_draw_charts_with_active_content(tmp_path: Path) -> None:
    assert _draws_charts(tmp_path, b"{\\rtf1 x}") is False
    odf = crafted.odf("application/vnd.oasis.opendocument.text", "<office:text/>")
    assert _draws_charts(tmp_path, odf) is False


def test_the_profile_follows_what_the_copy_found(tmp_path: Path) -> None:
    record = tmp_path / "profile"
    soffice = _script(
        tmp_path / "soffice",
        f'cat "$HOME/profile/user/registrymodifications.xcu" >> "{record}"\n{_FAKE_CONVERT}',
    )
    for index, content in enumerate((crafted.docx(""), _charted())):
        source = tmp_path / f"source{index}"
        source.write_bytes(content)
        work = tmp_path / f"work{index}"
        work.mkdir()
        rendition.convert_to_pdf(
            source, sniff_office_format(source), work, soffice=soffice, options=_options(soffice)
        )
    strict, charted = record.read_text().split("<?xml")[1:]
    assert 'oor:name="DisableActiveContent" oor:op="fuse"><value>true</value>' in strict
    assert 'oor:name="DisableActiveContent" oor:op="fuse"><value>false</value>' in charted


@pytest.mark.parametrize("kind", ["aFChunk", "subDocument", "oleObject", "package", "customXml"])
def test_kinds_a_rendition_has_no_use_for_are_dropped(tmp_path: Path, kind: str) -> None:
    content = crafted.docx(
        "",
        rels=[("rIdTrap", f"{crafted.OFFICE_RELS}/{kind}", "media/real.png", False)],
        extra_parts={"word/media/real.png": _png()},
    )
    assert "rIdTrap" not in _relationships_of(_prepared_copy(tmp_path, content))


def test_odf_hyperlinks_and_package_images_are_fine(tmp_path: Path) -> None:
    body = (
        '<office:text><text:p><text:a xlink:href="https://example.test/">link</text:a></text:p>'
        '<draw:image xlink:href="Pictures/inside.png" xlink:type="simple"/></office:text>'
    )
    content = crafted.odf("application/vnd.oasis.opendocument.text", body)
    copy = _prepared_copy(tmp_path, content)
    with zipfile.ZipFile(copy) as archive:
        assert b"https://example.test/" in archive.read("content.xml")


def _odf_parts() -> dict[str, str | bytes]:
    return {
        "meta.xml": "<meta/>",
        "settings.xml": "<settings/>",
        "Basic/script-lc.xml": "<libraries/>",
        "Pictures/real.png": _png(),
        "Pictures/fake.png": b"<html></html>",
        "Pictures/trap.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
        "ObjectReplacements/Object 1": b"VCLMTF" + b"\x00" * 32,
        "Object 1/content.xml": "<chart/>",
        "Object 1/styles.xml": "<styles/>",
        "Object 1/meta.xml": "<meta/>",
        "Thumbnails/thumbnail.png": _png(),
    }


def test_odf_is_rebuilt_from_only_what_a_rendition_needs(tmp_path: Path) -> None:
    content = crafted.odf(
        "application/vnd.oasis.opendocument.text", "<office:text/>", extra=_odf_parts()
    )
    parts = _copied_parts(_prepared_copy(tmp_path, content))
    assert parts == {
        "mimetype",
        "content.xml",
        "META-INF/manifest.xml",
        "Pictures/real.png",
        "ObjectReplacements/Object 1",
        "Object 1/content.xml",
        "Object 1/styles.xml",
    }


def test_only_the_preview_folder_may_hold_a_libreoffice_metafile(tmp_path: Path) -> None:
    content = crafted.odf(
        "application/vnd.oasis.opendocument.text",
        "<office:text/>",
        extra={
            "Pictures/preview": b"VCLMTF" + b"\x00" * 32,
            "ObjectReplacements/Object 1": b"NOTAMETAFILE" + b"\x00" * 32,
        },
    )
    parts = _copied_parts(_prepared_copy(tmp_path, content))
    assert "Pictures/preview" not in parts
    assert "ObjectReplacements/Object 1" not in parts


def test_rebuilt_odf_starts_with_its_mimetype_stored(tmp_path: Path) -> None:
    content = crafted.odf("application/vnd.oasis.opendocument.text", "<office:text/>")
    with zipfile.ZipFile(_prepared_copy(tmp_path, content)) as archive:
        first = archive.infolist()[0]
    assert first.filename == "mimetype"
    assert first.compress_type == zipfile.ZIP_STORED


@pytest.mark.parametrize("attribute", ["src", "action", "resource"])
def test_odf_xforms_links_are_outside_references(tmp_path: Path, attribute: str) -> None:
    forms = (
        '<office:forms><xforms:model xmlns:xforms="http://www.w3.org/2002/xforms">'
        f'<xforms:instance {attribute}="http://internal/x"/></xforms:model></office:forms>'
    )
    source = tmp_path / "source"
    source.write_bytes(crafted.odf("application/vnd.oasis.opendocument.text", f"<office:text>{forms}</office:text>"))
    with pytest.raises(ConversionError, match="outside"):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


def test_odf_xforms_with_a_local_reference_is_fine(tmp_path: Path) -> None:
    forms = (
        '<office:forms><xforms:model xmlns:xforms="http://www.w3.org/2002/xforms">'
        '<xforms:bind id="b1"/></xforms:model></office:forms>'
    )
    content = crafted.odf("application/vnd.oasis.opendocument.text", f"<office:text>{forms}</office:text>")
    assert "content.xml" in _copied_parts(_prepared_copy(tmp_path, content))


def test_odf_percent_encoded_traversal_is_an_outside_reference(tmp_path: Path) -> None:
    body = '<office:text><draw:image xlink:href="%2e%2e/%2e%2e/x.png"/></office:text>'
    source = tmp_path / "source"
    source.write_bytes(crafted.odf("application/vnd.oasis.opendocument.text", body))
    with pytest.raises(ConversionError, match="outside"):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


def test_odf_with_an_entity_is_refused(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_bytes(
        crafted.odf(
            "application/vnd.oasis.opendocument.text",
            "<office:text/>",
            doctype='<!DOCTYPE x [<!ENTITY y "z">]>',
        )
    )
    with pytest.raises(ConversionError, match="entity"):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


def test_malformed_odf_is_refused(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_bytes(
        crafted.odf(
            "application/vnd.oasis.opendocument.text",
            "<office:text/>",
            extra={"Object 1/content.xml": "<not-closed"},
        )
    )
    with pytest.raises(rendition.expat.ExpatError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


def test_odf_too_large_to_expand_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rendition, "_MAX_PACKAGE_BYTES", 10)
    source = tmp_path / "source"
    source.write_bytes(crafted.odf("application/vnd.oasis.opendocument.text", "<office:text/>"))
    with pytest.raises(ConversionError):
        prepare_input(source, sniff_office_format(source), tmp_path / "input.odt")


# --------------------------------------------------------------- fit to width

_ROOT = '<worksheet xmlns="m">'
_DATA = "<sheetData/>"


def test_self_closed_sheet_properties_are_opened_in_place() -> None:
    sheet = f'{_ROOT}<sheetPr codeName="a"/>{_DATA}</worksheet>'
    patched = fit_sheet_to_width(sheet.encode()).decode()
    assert patched.count("<sheetPr") == 1
    assert patched.startswith(f'{_ROOT}<sheetPr codeName="a"><pageSetUpPr')


@pytest.mark.parametrize(
    ("sheet", "expected_properties"),
    [
        (f"{_ROOT}{_DATA}</worksheet>", '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'),
        (
            f'{_ROOT}<sheetPr codeName="a"/>{_DATA}</worksheet>',
            '<sheetPr codeName="a"><pageSetUpPr fitToPage="1"/></sheetPr>',
        ),
        (
            f'{_ROOT}<sheetPr><tabColor rgb="FF0000"/></sheetPr>{_DATA}</worksheet>',
            '<sheetPr><tabColor rgb="FF0000"/><pageSetUpPr fitToPage="1"/></sheetPr>',
        ),
        (
            f'{_ROOT}<sheetPr><pageSetUpPr fitToPage="0"/></sheetPr>{_DATA}</worksheet>',
            '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
        ),
    ],
)
def test_sheet_is_flagged_fit_to_page(sheet: str, expected_properties: str) -> None:
    assert expected_properties in fit_sheet_to_width(sheet.encode()).decode()


def test_sheet_without_page_setup_gets_landscape_fit_to_width_and_its_name() -> None:
    patched = fit_sheet_to_width(f"{_ROOT}{_DATA}</worksheet>".encode()).decode()
    assert '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' in patched
    assert "<oddHeader>&amp;A</oddHeader>" in patched
    assert patched.endswith("</worksheet>")


def test_existing_page_setup_keeps_its_orientation_and_loses_its_scale() -> None:
    sheet = (
        f'{_ROOT}{_DATA}<pageSetup paperSize="9" scale="40" fitToHeight="3" '
        'orientation="portrait"/></worksheet>'
    )
    patched = fit_sheet_to_width(sheet.encode()).decode()
    assert 'paperSize="9"' in patched
    assert 'orientation="portrait"' in patched
    assert "scale=" not in patched
    assert 'fitToHeight="0"' in patched
    assert 'fitToHeight="3"' not in patched


def test_existing_page_setup_in_single_quotes_loses_its_scale_too() -> None:
    sheet = f"{_ROOT}<pageSetup scale='40' fitToWidth='2'/></worksheet>"
    patched = fit_sheet_to_width(sheet.encode()).decode()
    assert "scale=" not in patched
    assert patched.count("fitToWidth") == 1


def test_existing_page_setup_without_orientation_turns_landscape() -> None:
    patched = fit_sheet_to_width(f'{_ROOT}<pageSetup paperSize="9"/></worksheet>'.encode()).decode()
    assert 'orientation="landscape"' in patched


def test_existing_header_is_kept() -> None:
    sheet = f"{_ROOT}{_DATA}<headerFooter><oddHeader>Mine</oddHeader></headerFooter></worksheet>"
    patched = fit_sheet_to_width(sheet.encode()).decode()
    assert "Mine" in patched
    assert "&amp;A" not in patched


def test_sheet_in_an_unexpected_shape_is_left_alone() -> None:
    assert fit_sheet_to_width(b"<x:worksheet/>") == b"<x:worksheet/>"


def test_workbook_copy_fits_its_sheets_and_a_huge_sheet_is_left_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    copy = _prepared_copy(tmp_path, crafted.xlsx(""))
    with zipfile.ZipFile(copy) as archive:
        assert b"fitToPage" in archive.read("xl/worksheets/sheet1.xml")

    monkeypatch.setattr(rendition, "_MAX_PATCHED_SHEET_BYTES", 1)
    copy = _prepared_copy(tmp_path, crafted.xlsx(""))
    with zipfile.ZipFile(copy) as archive:
        assert b"fitToPage" not in archive.read("xl/worksheets/sheet1.xml")


# -------------------------------------------------------------------- profile


def test_profile_turns_off_every_way_out() -> None:
    profile = profile_settings_xml()
    assert 'oor:name="DisableActiveContent" oor:op="fuse"><value>true</value>' in profile
    for document_filter in ("HTML (StarWriter)", "writerglobal8_HTML", "writerweb8_writer", "HTML"):
        assert f'<node oor:name="{document_filter}" oor:op="remove"/>' in profile
    for name, value in [
        ("DisableMacrosExecution", "true"),
        ("MacroSecurityLevel", "3"),
        ("BlockUntrustedRefererLinks", "true"),
        ("ooInetProxyType", "2"),
        ("ooInetHTTPProxyName", "127.0.0.1"),
    ]:
        assert f'oor:name="{name}" oor:op="fuse"><value>{value}</value>' in profile
    assert 'oor:name="SecureURL" oor:op="fuse"><value></value>' in profile
    for import_filter in ("svg_Import", "svgz_Import", "eps_Import"):
        assert f'<node oor:name="{import_filter}" oor:op="remove"/>' in profile


def test_environment_carries_nothing_of_the_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APERTURE_SECRET_KEY", "must-not-leak")
    monkeypatch.setenv("OPENROUTER_API_KEY", "must-not-leak")
    environment = soffice_environment(tmp_path)
    assert "must-not-leak" not in str(environment)
    assert environment["HOME"] == str(tmp_path)
    assert environment["http_proxy"] == environment["https_proxy"] == "http://127.0.0.1:9"
    assert environment["no_proxy"] == ""


# -------------------------------------------------------------------- process


def test_finding_soffice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rendition, "_MAC_SOFFICE", str(tmp_path / "absent"))
    monkeypatch.setattr(rendition.shutil, "which", lambda _name: None)
    assert find_soffice() is None
    assert find_soffice(str(tmp_path / "also-absent")) is None

    configured = _script(tmp_path / "soffice", "exit 0")
    assert find_soffice(configured) == configured

    not_runnable = tmp_path / "plain-file"
    not_runnable.write_text("x")
    assert find_soffice(str(not_runnable)) is None

    monkeypatch.setattr(rendition.shutil, "which", lambda name: configured if name == "soffice" else None)
    assert find_soffice() == configured


def test_convert_runs_on_the_sanitized_copy_with_limits_and_a_fresh_profile(
    tmp_path: Path, originals: KnowledgeOriginalStore
) -> None:
    record = tmp_path / "record"
    soffice = _script(
        tmp_path / "soffice",
        f'''
{{ ulimit -c; ulimit -t; ulimit -f; ulimit -n; pwd; env; printf 'ARGV:%s\\n' "$@"; }} > "{record}"
ls -a "$HOME/profile/user" >> "{record}"
{_FAKE_CONVERT}
''',
    )
    work = tmp_path / "work"
    work.mkdir()
    source = tmp_path / "evil name; rm -rf.docx"
    source.write_bytes(_docx())

    produced = rendition.convert_to_pdf(
        source,
        sniff_office_format(source),
        work,
        soffice=soffice,
        options=_options(soffice, timeout=33.0),
    )

    assert produced == work / "rendition.pdf"
    assert produced.read_bytes().startswith(b"%PDF-")
    lines = record.read_text().splitlines()
    assert lines[0] == "0"
    assert lines[1] == "33"
    assert int(lines[2]) == 1024 * 1024 * 1024 // rendition._FILE_SIZE_BLOCK_BYTES
    assert lines[3] == "4096"
    recorded = record.read_text()
    scratch = Path(next(line[5:] for line in recorded.splitlines() if line.startswith("HOME=")))
    assert f"ARGV:-env:UserInstallation={(scratch / 'profile').as_uri()}" in recorded
    assert "ARGV:--headless" in recorded
    assert "ARGV:--norestore" in recorded
    assert "ARGV:--nolockcheck" in recorded
    assert "ARGV:--nodefault" in recorded
    assert "ARGV:--infilter=MS Word 2007 XML" in recorded
    assert f"ARGV:{scratch / 'input.docx'}" in recorded
    assert "evil name" not in recorded
    assert "registrymodifications.xcu" in recorded
    assert scratch.name.startswith("aperture-render-")
    assert not scratch.exists()


def test_scratch_is_outside_the_data_volume_and_is_removed_after_a_failure(
    tmp_path: Path, originals: KnowledgeOriginalStore
) -> None:
    record = tmp_path / "home"
    soffice = _script(tmp_path / "soffice", f'echo "$HOME" > "{record}"\nexit 1')
    originals.save(REF, _docx())
    _prepared(originals, soffice)
    scratch = Path(record.read_text().strip())
    assert not scratch.is_relative_to(originals.root)
    assert not scratch.exists()


def test_startup_clears_scratch_left_by_a_crash(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rendition.tempfile, "gettempdir", lambda: str(tmp_path))
    leftover = tmp_path / "aperture-render-crashed"
    leftover.mkdir()
    (leftover / "input.docx").write_bytes(b"a full copy of a document")
    other = tmp_path / "unrelated"
    other.mkdir()
    rendition.clear_scratch()
    assert not leftover.exists()
    assert other.exists()


def test_memory_limit_is_passed_in_kilobytes(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_bytes(_docx())
    options = RenditionOptions(soffice="soffice", timeout_seconds=20.0, memory_mb=3000)
    command = rendition.soffice_command(
        "soffice", source, sniff_office_format(source), tmp_path, options
    )
    assert str(3000 * 1024) in command


def test_presentations_keep_hidden_slides_so_slide_numbers_are_page_numbers(tmp_path: Path) -> None:
    source = tmp_path / "deck"
    source.write_bytes(crafted.pptx(""))
    assert '"ExportHiddenSlides"' in sniff_office_format(source).output_filter


def test_timeout_kills_the_whole_process_group(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    soffice = _script(tmp_path / "soffice", f'sleep 300 &\necho $! > "{pid_file}"\nwait')
    work = tmp_path / "work"
    work.mkdir()
    source = tmp_path / "source"
    source.write_bytes(_docx())

    started = time.monotonic()
    with pytest.raises(ConversionError, match="out of time"):
        rendition.convert_to_pdf(
            source, sniff_office_format(source), work, soffice=soffice, options=_options(soffice, 0.5)
        )
    assert time.monotonic() - started < 10

    child = int(pid_file.read_text())
    for _ in range(50):
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    pytest.fail("the conversion's child process outlived the timeout")


def test_child_left_behind_after_a_clean_exit_is_killed_too(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    soffice = _script(
        tmp_path / "soffice", f'sleep 300 &\necho $! > "{pid_file}"\n{_FAKE_CONVERT}'
    )
    work = tmp_path / "work"
    work.mkdir()
    source = tmp_path / "source"
    source.write_bytes(_docx())
    rendition.convert_to_pdf(
        source, sniff_office_format(source), work, soffice=soffice, options=_options(soffice)
    )
    child = int(pid_file.read_text())
    for _ in range(50):
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    pytest.fail("a stray child survived the conversion")


@pytest.mark.parametrize(
    "body",
    ["exit 1", 'printf "not a pdf" > "$(dirname "$0")/ignored"; exit 0'],
)
def test_no_pdf_is_a_conversion_error(tmp_path: Path, body: str) -> None:
    soffice = _script(tmp_path / "soffice", body)
    work = tmp_path / "work"
    work.mkdir()
    source = tmp_path / "source"
    source.write_bytes(_docx())
    with pytest.raises(ConversionError):
        rendition.convert_to_pdf(
            source, sniff_office_format(source), work, soffice=soffice, options=_options(soffice)
        )


def test_output_that_is_not_a_pdf_is_a_conversion_error(tmp_path: Path) -> None:
    soffice = _script(
        tmp_path / "soffice",
        _FAKE_CONVERT.replace("%%PDF-1.7 fake", "<html>not a pdf</html>"),
    )
    work = tmp_path / "work"
    work.mkdir()
    source = tmp_path / "source"
    source.write_bytes(_docx())
    with pytest.raises(ConversionError, match="other than a PDF"):
        rendition.convert_to_pdf(
            source, sniff_office_format(source), work, soffice=soffice, options=_options(soffice)
        )


# ------------------------------------------------------------- what opens how


def test_pdf_with_bytes_before_its_header_is_still_a_pdf(originals: KnowledgeOriginalStore) -> None:
    originals.save(REF, b"\r\n\r\n" + _pdf_with_text("Text"))
    assert prepare_document(originals, REF, name="x.bin", options=_options(None)).mode == "pdf"


def test_text_that_merely_starts_like_a_bitmap_stays_text(originals: KnowledgeOriginalStore) -> None:
    originals.save(REF, b"BMW fleet notes for the quarter, nothing to do with images.")
    assert prepare_document(originals, REF, name="fleet.txt", options=_options(None)).mode == "text"


def test_other_riff_files_are_not_images(originals: KnowledgeOriginalStore) -> None:
    originals.save(REF, b"RIFF\x24\x00\x00\x00WAVEfmt ")
    prepared = prepare_document(originals, REF, name="clip.wav", options=_options(None))
    assert prepared.mode == "text"
    assert prepared.content_type.startswith("audio/")


def test_real_bitmap_is_an_image(originals: KnowledgeOriginalStore) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (1, 2, 3)).save(buffer, "BMP")
    originals.save(REF, buffer.getvalue())
    prepared = prepare_document(originals, REF, name="scan", options=_options(None))
    assert (prepared.mode, prepared.content_type) == ("image", "image/bmp")


def test_webp_gif_and_jpeg_are_images(originals: KnowledgeOriginalStore) -> None:
    for image_format, content_type in (
        ("WEBP", "image/webp"),
        ("GIF", "image/gif"),
        ("JPEG", "image/jpeg"),
    ):
        buffer = io.BytesIO()
        Image.new("RGB", (4, 4), (1, 2, 3)).save(buffer, image_format)
        originals.save(REF, buffer.getvalue())
        prepared = prepare_document(originals, REF, name="scan", options=_options(None))
        assert (prepared.mode, prepared.content_type) == ("image", content_type)


def test_binary_file_with_no_viewer_says_the_layout_is_unavailable(
    originals: KnowledgeOriginalStore,
) -> None:
    originals.save(REF, b"\xd0\xcf\x11\xe0\x00\x00 legacy word")
    prepared = prepare_document(originals, REF, name="old.doc", options=_options(None))
    assert (prepared.mode, prepared.notice) == ("text", "conversion_unavailable")
    assert prepared.original_available is True


def test_plain_text_needs_no_notice(originals: KnowledgeOriginalStore) -> None:
    originals.save(REF, b"Plain words")
    prepared = prepare_document(originals, REF, name="notes", options=_options(None))
    assert (prepared.mode, prepared.notice, prepared.content_type) == (
        "text",
        None,
        "application/octet-stream",
    )


# ------------------------------------------------------------------- scans


def _tiff(frames: int) -> bytes:
    images = [Image.new("L", (64, 64), 40 + index * 40) for index in range(frames)]
    buffer = io.BytesIO()
    images[0].save(buffer, "TIFF", save_all=True, append_images=images[1:])
    return buffer.getvalue()


def test_multi_page_scan_becomes_a_pdf_browsers_can_show(originals: KnowledgeOriginalStore) -> None:
    originals.save(REF, _tiff(3))

    prepared = prepare_document(originals, REF, name="scan.tif", options=_options(None))

    assert prepared.mode == "pdf"
    assert prepared.page_count == 3
    assert prepared.content_type == "image/tiff"
    assert prepared.file_path.read_bytes().startswith(b"%PDF-")
    assert prepared.notice is None


def test_scan_converts_without_libreoffice(
    originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rendition, "find_soffice", lambda _configured: None)
    originals.save(REF, _tiff(1))
    assert prepare_document(originals, REF, name="scan.tif", options=_options(None)).mode == "pdf"


def test_scan_longer_than_the_limit_stops_at_the_limit(
    originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rendition, "_MAX_SCAN_PAGES", 2)
    originals.save(REF, _tiff(4))
    assert prepare_document(originals, REF, name="scan.tif", options=_options(None)).page_count == 2


def test_broken_scan_is_text_with_a_notice(originals: KnowledgeOriginalStore) -> None:
    originals.save(REF, b"II*\x00 not really a tiff")
    prepared = prepare_document(originals, REF, name="scan.tif", options=_options(None))
    assert (prepared.mode, prepared.notice) == ("text", "conversion_failed")


# ---------------------------------------------------------------- the OS wall


@pytest.fixture
def forbid_isolation(monkeypatch: pytest.MonkeyPatch) -> None:
    """This process cannot drop to the rendition account."""
    monkeypatch.setattr(rendition, "rendition_account", lambda: None)


def _strict_options(soffice: str | None) -> RenditionOptions:
    return RenditionOptions(soffice=soffice, timeout_seconds=20.0, memory_mb=2048)


def test_options_require_isolation_unless_told_otherwise() -> None:
    assert RenditionOptions(soffice=None, timeout_seconds=1.0, memory_mb=2048).require_isolation


def test_conversion_is_refused_when_it_cannot_drop_to_another_account(
    tmp_path: Path, originals: KnowledgeOriginalStore, forbid_isolation: None
) -> None:
    runs = tmp_path / "runs"
    soffice = _script(tmp_path / "soffice", f'touch "{runs}"\n{_FAKE_CONVERT}')
    originals.save(REF, _docx())

    prepared = prepare_document(originals, REF, name="x.docx", options=_strict_options(soffice))

    assert (prepared.mode, prepared.notice) == ("text", "conversion_unavailable")
    assert not runs.exists()
    assert originals.derived(REF, "rendition.failed") is None


def test_scan_is_refused_when_it_cannot_drop_to_another_account(
    originals: KnowledgeOriginalStore, forbid_isolation: None
) -> None:
    originals.save(REF, _tiff(1))
    prepared = prepare_document(originals, REF, name="x.tif", options=_strict_options(None))
    assert (prepared.mode, prepared.notice) == ("text", "conversion_unavailable")


def test_local_environment_may_convert_without_another_account(
    tmp_path: Path, originals: KnowledgeOriginalStore, forbid_isolation: None, fake_pdf_count: None
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    originals.save(REF, _docx())
    assert _prepared(originals, soffice).mode == "pdf"


def _isolated_options(soffice: str | None, *directories: Path) -> RenditionOptions:
    return RenditionOptions(
        soffice=soffice, timeout_seconds=20.0, memory_mb=2048, private_directories=directories
    )


@pytest.fixture
def account_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rendition, "rendition_account", lambda: rendition.SandboxAccount(10001, 10001))


@pytest.mark.parametrize("mode", [0o755, 0o750, 0o701, 0o770, 0o705])
def test_conversion_is_refused_when_the_data_directory_can_be_entered(
    tmp_path: Path, originals: KnowledgeOriginalStore, account_exists: None, mode: int
) -> None:
    runs = tmp_path / "runs"
    soffice = _script(tmp_path / "soffice", f'touch "{runs}"\n{_FAKE_CONVERT}')
    data = tmp_path / "data"
    data.mkdir()
    data.chmod(mode)
    originals.save(REF, _docx())

    prepared = prepare_document(
        originals, REF, name="x.docx", options=_isolated_options(soffice, data)
    )

    assert (prepared.mode, prepared.notice) == ("text", "conversion_unavailable")
    assert not runs.exists()


def test_scan_is_refused_when_the_data_directory_can_be_entered(
    tmp_path: Path, originals: KnowledgeOriginalStore, account_exists: None
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    data.chmod(0o755)
    originals.save(REF, _tiff(1))
    prepared = prepare_document(originals, REF, name="x.tif", options=_isolated_options(None, data))
    assert (prepared.mode, prepared.notice) == ("text", "conversion_unavailable")


def test_conversion_is_refused_when_a_data_directory_is_missing_or_not_ours(
    tmp_path: Path,
    originals: KnowledgeOriginalStore,
    account_exists: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    originals.save(REF, _docx())
    missing = _isolated_options(soffice, tmp_path / "absent")
    prepared = prepare_document(originals, REF, name="x", options=missing)
    assert (prepared.mode, prepared.notice) == ("text", "conversion_unavailable")

    data = tmp_path / "data"
    data.mkdir()
    data.chmod(0o700)
    monkeypatch.setattr(rendition.os, "geteuid", lambda: os.getuid() + 1)
    theirs = _isolated_options(soffice, data)
    prepared = prepare_document(originals, REF, name="x", options=theirs)
    assert (prepared.mode, prepared.notice) == ("text", "conversion_unavailable")


def test_a_private_data_directory_lets_the_conversion_run(
    tmp_path: Path,
    originals: KnowledgeOriginalStore,
    account_exists: None,
    fake_pdf_count: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rendition, "_hand_over", lambda *_args: None)
    monkeypatch.setattr(rendition, "_account_arguments", lambda _account: {})
    monkeypatch.setattr(rendition, "_end_stragglers", lambda _account: None)
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    data = tmp_path / "data"
    data.mkdir()
    data.chmod(0o700)
    originals.save(REF, _docx())
    prepared = prepare_document(originals, REF, name="x", options=_isolated_options(soffice, data))
    assert prepared.mode == "pdf"


def test_local_environment_does_not_check_the_data_directory(
    tmp_path: Path, originals: KnowledgeOriginalStore, fake_pdf_count: None
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    data = tmp_path / "data"
    data.mkdir()
    data.chmod(0o755)
    originals.save(REF, _docx())
    options = RenditionOptions(
        soffice=soffice,
        timeout_seconds=20.0,
        memory_mb=2048,
        require_isolation=False,
        private_directories=(data,),
    )
    assert prepare_document(originals, REF, name="x", options=options).mode == "pdf"


def test_only_root_can_drop(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rendition.os, "geteuid", lambda: 501)
    assert rendition.rendition_account() is None


def test_root_drops_to_the_dedicated_account(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rendition.os, "geteuid", lambda: 0)
    entries = {"aperture-render": SimpleNamespace(pw_uid=10001, pw_gid=10002)}
    monkeypatch.setattr(rendition.pwd, "getpwnam", lambda name: entries[name])
    assert rendition.rendition_account() == rendition.SandboxAccount(10001, 10002)


def test_root_without_the_account_cannot_drop(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rendition.os, "geteuid", lambda: 0)

    def missing(_name: str) -> object:
        raise KeyError(_name)

    monkeypatch.setattr(rendition.pwd, "getpwnam", missing)
    assert rendition.rendition_account() is None


def test_child_and_sweep_run_as_the_account_with_no_extra_groups(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[dict[str, object]] = []

    class Finished:
        pid = 999999

        def wait(self, timeout: float | None = None) -> int:
            return 0

    def popen(command: list[str], **kwargs: object) -> Finished:
        calls.append(kwargs)
        return Finished()

    def run(command: list[str], **kwargs: object) -> None:
        calls.append(kwargs)
        calls[-1]["sweep"] = command

    monkeypatch.setattr(rendition.subprocess, "Popen", popen)
    monkeypatch.setattr(rendition.subprocess, "run", run)
    account = rendition.SandboxAccount(10001, 10002)

    rendition.run_sandboxed(["soffice"], tmp_path, 1.0, account)

    for call in calls:
        assert (call["user"], call["group"], call["extra_groups"]) == (10001, 10002, [])
    assert "os.kill(-1" in calls[1]["sweep"][-1]
    assert calls[1]["env"] == {}
    # Exits non-zero when nothing was left to kill, which is the good case.
    assert calls[1]["check"] is False


def test_without_an_account_nothing_is_swept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("no account means no kill(-1): it would hit this user's own processes")

    monkeypatch.setattr(rendition.subprocess, "run", forbidden)
    rendition.run_sandboxed(["/bin/sh", "-c", ":"], tmp_path, 5.0, None)


def test_scratch_is_handed_to_the_account_without_following_links(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "out").mkdir()
    (tmp_path / "input.docx").write_bytes(b"x")
    calls: list[tuple[Path, int, int, bool]] = []

    def chown(path: Path, uid: int, gid: int, *, follow_symlinks: bool = True) -> None:
        calls.append((Path(path), uid, gid, follow_symlinks))

    monkeypatch.setattr(rendition.os, "chown", chown)
    rendition._hand_over(tmp_path, rendition.SandboxAccount(10001, 10002))

    assert {call[0] for call in calls} == {tmp_path, tmp_path / "out", tmp_path / "input.docx"}
    assert all(call[1:3] == (10001, 10002) for call in calls)
    assert all(call[3] is False for call in calls if call[0] != tmp_path)


def test_nothing_is_handed_over_without_an_account(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("no account, no chown")

    monkeypatch.setattr(rendition.os, "chown", forbidden)
    rendition._hand_over(tmp_path, None)


def _scratch_with_output(tmp_path: Path, content: bytes) -> Path:
    scratch = tmp_path / "scratch"
    (scratch / "out").mkdir(parents=True)
    (scratch / "out" / "input.pdf").write_bytes(content)
    return scratch


def test_output_is_copied_out_of_the_sandbox(tmp_path: Path) -> None:
    scratch = _scratch_with_output(tmp_path, b"%PDF-1.7 made")
    target = tmp_path / "rendition.pdf"
    assert rendition._take_output(scratch, "input.pdf", target) == target
    assert target.read_bytes() == b"%PDF-1.7 made"


def test_output_that_is_a_link_is_not_followed(tmp_path: Path) -> None:
    secret = tmp_path / "secret.pdf"
    secret.write_bytes(b"%PDF-1.7 a root-only file")
    scratch = tmp_path / "scratch"
    (scratch / "out").mkdir(parents=True)
    (scratch / "out" / "input.pdf").symlink_to(secret)
    with pytest.raises(ConversionError, match="no PDF"):
        rendition._take_output(scratch, "input.pdf", tmp_path / "rendition.pdf")
    assert not (tmp_path / "rendition.pdf").exists()


def test_output_folder_that_is_a_link_is_not_followed(tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "input.pdf").write_bytes(b"%PDF-1.7 a root-only file")
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "out").symlink_to(elsewhere)
    with pytest.raises(ConversionError, match="no PDF"):
        rendition._take_output(scratch, "input.pdf", tmp_path / "rendition.pdf")


def test_output_that_is_a_fifo_cannot_hang_the_api(tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    (scratch / "out").mkdir(parents=True)
    os.mkfifo(scratch / "out" / "input.pdf")
    with pytest.raises(ConversionError, match="other than a PDF"):
        rendition._take_output(scratch, "input.pdf", tmp_path / "rendition.pdf")


def test_output_too_large_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scratch = _scratch_with_output(tmp_path, b"%PDF-1.7 made")
    monkeypatch.setattr(rendition, "_MAX_OUTPUT_BYTES", 13)
    rendition._take_output(scratch, "input.pdf", tmp_path / "exactly-at-the-limit.pdf")
    monkeypatch.setattr(rendition, "_MAX_OUTPUT_BYTES", 12)
    with pytest.raises(ConversionError, match="other than a PDF"):
        rendition._take_output(scratch, "input.pdf", tmp_path / "over-the-limit.pdf")


def test_scan_has_a_real_deadline_and_the_lock_comes_back(
    tmp_path: Path, originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    hung = tmp_path / "hung_worker.py"
    hung.write_text("import time\ntime.sleep(300)\n")
    monkeypatch.setattr(rendition, "_SCAN_WORKER", hung)
    originals.save(REF, _tiff(1))

    started = time.monotonic()
    prepared = prepare_document(originals, REF, name="scan.tif", options=_options(None, 0.5))

    assert time.monotonic() - started < 15
    assert (prepared.mode, prepared.notice) == ("text", "conversion_failed")
    assert rendition._conversion_lock.acquire(blocking=False)
    rendition._conversion_lock.release()


def _page_shades(pdf: Path) -> list[int]:
    document = pypdfium2.PdfDocument(pdf)
    try:
        return [
            document[index].render(scale=0.2).to_pil().convert("L").getpixel((4, 4))
            for index in range(len(document))
        ]
    finally:
        document.close()


def test_each_frame_of_a_scan_becomes_its_own_page(tmp_path: Path) -> None:
    source = tmp_path / "scan.tif"
    source.write_bytes(_tiff(3))
    target = tmp_path / "scan.pdf"

    assert scan_worker.convert(str(source), str(target), 10, 10**9) == 0

    shades = _page_shades(target)
    assert len(shades) == 3
    assert shades[0] < shades[1] < shades[2]


def test_worker_stops_at_the_page_limit(tmp_path: Path) -> None:
    source = tmp_path / "scan.tif"
    source.write_bytes(_tiff(4))
    target = tmp_path / "scan.pdf"
    assert scan_worker.convert(str(source), str(target), 2, 10**9) == 0
    assert len(_page_shades(target)) == 2


def test_worker_gives_up_past_the_pixel_budget_and_writes_nothing(tmp_path: Path) -> None:
    source = tmp_path / "scan.tif"
    source.write_bytes(_tiff(2))
    target = tmp_path / "scan.pdf"
    assert scan_worker.convert(str(source), str(target), 10, 64 * 64) != 0
    assert not target.exists()


def test_scan_past_the_pixel_budget_is_refused(
    originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rendition, "_MAX_SCAN_PIXELS", 64 * 64)
    originals.save(REF, _tiff(2))
    prepared = prepare_document(originals, REF, name="scan.tif", options=_options(None))
    assert (prepared.mode, prepared.notice) == ("text", "conversion_failed")


def test_scan_exactly_at_the_pixel_budget_converts(
    originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rendition, "_MAX_SCAN_PIXELS", 2 * 64 * 64)
    originals.save(REF, _tiff(2))
    assert prepare_document(originals, REF, name="scan.tif", options=_options(None)).page_count == 2


# ------------------------------------------------------------------ the cache


def test_full_disk_during_conversion_is_text_not_a_500(
    tmp_path: Path, originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    originals.save(REF, _docx())

    def full(_store: object) -> object:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(KnowledgeOriginalStore, "work_directory", full)
    prepared = _prepared(originals, soffice)
    assert (prepared.mode, prepared.notice) == ("text", "conversion_failed")


def test_full_disk_while_caching_the_page_index_still_answers(
    originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    originals.save(REF, _pdf_with_text("Words"))

    def full(_store: object) -> object:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(KnowledgeOriginalStore, "work_directory", full)
    assert rendition.page_index(originals, REF, originals.path(REF)) == ["words"]


def test_page_index_built_from_superseded_bytes_is_not_cached(
    originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    originals.save(REF, _pdf_with_text("Old"))
    pdf = originals.path(REF)

    def replaced_while_reading(path: Path) -> list[str]:
        keys = ["old"]
        originals.save(REF, _pdf_with_text("New version"))
        return keys

    monkeypatch.setattr(rendition, "_page_keys", replaced_while_reading)
    rendition.page_index(originals, REF, pdf)
    assert originals.derived(REF, "pages.json") is None


def test_failure_log_names_the_exception_and_never_quotes_the_document(
    tmp_path: Path,
    originals: KnowledgeOriginalStore,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    originals.save(REF, _docx())

    def explode(*_args: object) -> None:
        raise ValueError("attacker-chosen entity name")

    monkeypatch.setattr(rendition, "prepare_input", explode)
    with caplog.at_level("WARNING", logger="aperture.knowledge.rendition"):
        _prepared(originals, soffice)
    assert "ValueError" in caplog.text
    assert "attacker-chosen" not in caplog.text


def test_first_view_converts_and_later_views_reuse_it(
    tmp_path: Path, originals: KnowledgeOriginalStore, fake_pdf_count: None
) -> None:
    counter = tmp_path / "runs"
    soffice = _script(tmp_path / "soffice", f'echo run >> "{counter}"\n{_FAKE_CONVERT}')
    originals.save(REF, _docx())

    first = _prepared(originals, soffice)
    second = _prepared(originals, soffice)

    assert first.mode == second.mode == "pdf"
    assert first.file_path == second.file_path
    assert first.content_type.endswith("wordprocessingml.document")
    assert first.page_count == 2
    assert first.notice is None
    assert first.original_available is True
    assert counter.read_text().count("run") == 1


def test_new_bytes_convert_again(
    tmp_path: Path, originals: KnowledgeOriginalStore, fake_pdf_count: None
) -> None:
    counter = tmp_path / "runs"
    soffice = _script(tmp_path / "soffice", f'echo run >> "{counter}"\n{_FAKE_CONVERT}')
    originals.save(REF, _docx())
    _prepared(originals, soffice)
    originals.save(REF, crafted.docx("<w:p><w:r><w:t>Changed.</w:t></w:r></w:p>"))
    _prepared(originals, soffice)
    assert counter.read_text().count("run") == 2


def test_view_of_a_document_with_no_stored_file(originals: KnowledgeOriginalStore) -> None:
    prepared = prepare_document(originals, REF, name="brief.txt", options=_options(None))
    assert (prepared.mode, prepared.notice) == ("text", "original_missing")
    assert prepared.original_available is False
    assert prepared.content_type == "text/plain"


def test_native_pdf_keeps_its_own_bytes_and_says_it_has_an_original(
    originals: KnowledgeOriginalStore,
) -> None:
    originals.save(REF, _pdf_with_text("One", "Two"))
    prepared = prepare_document(originals, REF, name="x.pdf", options=_options(None))
    assert prepared.file_path == originals.path(REF)
    assert prepared.original_available is True
    assert prepared.page_count == 2


def test_unreadable_pdf_still_has_an_original(originals: KnowledgeOriginalStore) -> None:
    originals.save(REF, b"%PDF-1.7 not really")
    prepared = prepare_document(originals, REF, name="x.pdf", options=_options(None))
    assert (prepared.mode, prepared.original_available) == ("text", True)


def test_image_is_one_page_with_an_original(originals: KnowledgeOriginalStore) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (1, 2, 3)).save(buffer, "PNG")
    originals.save(REF, buffer.getvalue())
    prepared = prepare_document(originals, REF, name="x.png", options=_options(None))
    assert (prepared.page_count, prepared.original_available) == (1, True)


def test_no_soffice_means_text_with_a_notice(
    originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rendition, "find_soffice", lambda _configured: None)
    originals.save(REF, _docx())
    prepared = _prepared(originals, None)
    assert prepared.mode == "text"
    assert prepared.notice == "conversion_unavailable"
    assert prepared.original_available is True
    assert prepared.file_path is None


def test_failed_conversion_is_text_and_is_not_retried_on_every_click(
    tmp_path: Path, originals: KnowledgeOriginalStore
) -> None:
    counter = tmp_path / "runs"
    soffice = _script(tmp_path / "soffice", f'echo run >> "{counter}"\nexit 1')
    originals.save(REF, _docx())

    assert _prepared(originals, soffice).notice == "conversion_failed"
    assert _prepared(originals, soffice).notice == "conversion_failed"

    assert counter.read_text().count("run") == 1


def test_failed_conversion_is_tried_again_after_a_while(
    tmp_path: Path, originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    counter = tmp_path / "runs"
    soffice = _script(tmp_path / "soffice", f'echo run >> "{counter}"\nexit 1')
    originals.save(REF, _docx())
    _prepared(originals, soffice)

    monkeypatch.setattr(rendition, "_FAILURE_RETRY_SECONDS", -1)
    _prepared(originals, soffice)

    assert counter.read_text().count("run") == 2


def test_unconvertible_rendition_is_text(
    tmp_path: Path, originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    originals.save(REF, _docx())
    monkeypatch.setattr(rendition, "_pdf_page_count", lambda _path: None)
    prepared = _prepared(originals, soffice)
    assert (prepared.mode, prepared.notice) == ("text", "conversion_failed")
    assert prepared.original_available is True


def test_only_one_conversion_runs_at_a_time(
    tmp_path: Path, originals: KnowledgeOriginalStore, fake_pdf_count: None
) -> None:
    log = tmp_path / "log"
    soffice = _script(
        tmp_path / "soffice",
        f'echo start >> "{log}"\nsleep 0.2\necho end >> "{log}"\n{_FAKE_CONVERT}',
    )
    refs = [DocumentRef("tenant", "config", f"doc-{index}") for index in range(3)]
    for ref in refs:
        originals.save(ref, _docx())

    threads = [
        threading.Thread(
            target=prepare_document,
            args=(originals, ref),
            kwargs={"name": "x.docx", "options": _options(soffice)},
        )
        for ref in refs
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert log.read_text().split() == ["start", "end"] * 3


def test_a_queue_that_is_full_sends_the_reader_away_instead_of_holding_a_thread(
    tmp_path: Path, originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    originals.save(REF, _docx())
    monkeypatch.setattr(rendition, "_conversion_queue", threading.BoundedSemaphore(1))
    assert rendition._conversion_queue.acquire(blocking=False)
    try:
        prepared = _prepared(originals, soffice)
    finally:
        rendition._conversion_queue.release()
    assert (prepared.mode, prepared.notice) == ("text", "conversion_unavailable")
    assert originals.derived(REF, "rendition.failed") is None


def test_two_readers_of_one_document_convert_once(
    tmp_path: Path, originals: KnowledgeOriginalStore, fake_pdf_count: None
) -> None:
    counter = tmp_path / "runs"
    soffice = _script(tmp_path / "soffice", f'echo run >> "{counter}"\nsleep 0.2\n{_FAKE_CONVERT}')
    originals.save(REF, _docx())
    threads = [
        threading.Thread(
            target=prepare_document,
            args=(originals, REF),
            kwargs={"name": "x.docx", "options": _options(soffice)},
        )
        for _ in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert counter.read_text().count("run") == 1


def test_document_deleted_during_conversion_leaves_nothing(
    tmp_path: Path, originals: KnowledgeOriginalStore
) -> None:
    started = tmp_path / "started"
    gate = tmp_path / "gate"
    soffice = _script(
        tmp_path / "soffice",
        f'touch "{started}"\nwhile [ ! -f "{gate}" ]; do sleep 0.02; done\n{_FAKE_CONVERT}',
    )
    originals.save(REF, _docx())
    thread = threading.Thread(
        target=prepare_document,
        args=(originals, REF),
        kwargs={"name": "x.docx", "options": _options(soffice)},
    )
    thread.start()
    while not started.exists():
        time.sleep(0.01)
    originals.delete_document(REF)
    gate.touch()
    thread.join()
    assert [path for path in originals.root.rglob("*") if path.is_file()] == []


def test_work_files_are_gone_after_a_conversion(
    tmp_path: Path, originals: KnowledgeOriginalStore, fake_pdf_count: None
) -> None:
    soffice = _script(tmp_path / "soffice", _FAKE_CONVERT)
    originals.save(REF, _docx())
    _prepared(originals, soffice)
    assert list((originals.root / ".work").iterdir()) == []


def _pdf_with_text(*pages: str) -> bytes:
    document = pikepdf.new()
    font = pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica)
    for text in pages:
        page = document.add_blank_page(page_size=(612, 792))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = document.make_stream(f"BT /F1 12 Tf 72 700 Td ({text}) Tj ET".encode())
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def test_page_index_reads_every_page_as_a_match_key(
    originals: KnowledgeOriginalStore,
) -> None:
    originals.save(REF, _pdf_with_text("First Page", "The Harlow-Creek survey"))
    assert rendition.page_index(originals, REF, originals.path(REF)) == [
        "firstpage",
        "theharlowcreeksurvey",
    ]


def test_pdf_page_that_cannot_be_read_gives_an_empty_index_not_an_error(
    originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(_path: Path) -> list[str]:
        raise pypdfium2.PdfiumError("page will not load")

    monkeypatch.setattr(rendition, "_page_keys", fail)
    originals.save(REF, _pdf_with_text("Text"))
    assert rendition.page_index(originals, REF, originals.path(REF)) == []


def test_page_index_is_built_once_per_version(
    tmp_path: Path, originals: KnowledgeOriginalStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[Path] = []

    def keys(path: Path) -> list[str]:
        calls.append(path)
        return ["pageone", "pagetwo"]

    monkeypatch.setattr(rendition, "_page_keys", keys)
    originals.save(REF, b"%PDF-1.7")
    pdf = originals.path(REF)
    assert rendition.page_index(originals, REF, pdf) == ["pageone", "pagetwo"]
    assert rendition.page_index(originals, REF, pdf) == ["pageone", "pagetwo"]
    assert len(calls) == 1


def test_a_relative_database_path_guards_the_directory_the_database_really_uses() -> None:
    """.env.example ships repository-relative paths, so a fresh install must not
    look for its data directory relative to wherever the process started."""
    settings = Settings(
        application_db_path="services/api/data/aperture.sqlite3",
        runtime_state_path="services/api/data/runtime_state.json",
        vector_db_path="services/api/data/knowledge_vectors.sqlite3",
    )

    assert settings.private_data_directories == (resolve_repo_path("services/api/data"),)
