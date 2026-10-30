from __future__ import annotations

import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pikepdf
import pytest
from pypdf import PdfReader

from app.core.draft_pdf_render import (
    BUNDLED_FACES,
    FONT_DIR,
    PdfRenderError,
    bundled_font_css,
    heading_texts,
    print_document_html,
    render_failure_message,
    render_print_document,
)
from app.models.draft_pdf_export import DraftPdfSource


def _source(**overrides: str) -> DraftPdfSource:
    values = {
        "title": "Synthetic Harbor Lease",
        "lang": "en-US",
        "body_html": '<div id="aperture-draft-print-root" class="draft-print-root"><h1>Lease</h1></div>',
        "css": ".draft-print-root { color: #111; }",
    }
    values.update(overrides)
    return DraftPdfSource(**values)


def test_print_document_locks_the_page_down_before_any_styles() -> None:
    html = print_document_html(_source(), "/* fonts */")

    head = html.split("<body", 1)[0]
    csp = head.index('http-equiv="Content-Security-Policy"')
    assert csp < head.index("<style>")
    assert "default-src 'none'" in head
    assert "img-src data:" in head and "font-src data:" in head
    assert '<html lang="en-US">' in html
    assert '<body class="is-draft-printing"><div id="aperture-draft-print-root"' in html


def test_print_document_escapes_the_title_and_keeps_css_inside_its_style() -> None:
    html = print_document_html(
        _source(title="Smith & Jones <Draft>", css="p{color:red}</style><script>alert(1)</script>"),
        "",
    )

    assert "<title>Smith &amp; Jones &lt;Draft&gt;</title>" in html
    assert "</style><script>" not in html
    assert html.count("</style>") == 1


def test_bundled_faces_follow_the_page_styles_so_they_win() -> None:
    html = print_document_html(_source(css="@font-face{font-family:x}"), "/* bundled faces */")

    assert html.index("@font-face{font-family:x}") < html.index("/* bundled faces */")


def test_bundled_faces_cover_the_app_typefaces_as_static_files() -> None:
    css = bundled_font_css()

    families = {face.family for face in BUNDLED_FACES}
    assert families == {"Plus Jakarta Sans", "JetBrains Mono"}
    for face in BUNDLED_FACES:
        assert (FONT_DIR / face.file).is_file(), face.file
    jakarta = [face for face in BUNDLED_FACES if face.family == "Plus Jakarta Sans"]
    assert {(face.weight, face.style) for face in jakarta} == {
        (weight, style) for weight in (400, 500, 600, 700, 800) for style in ("normal", "italic")
    }
    assert css.count("@font-face") == len(BUNDLED_FACES)
    assert 'font-family:"Plus Jakarta Sans";font-style:italic;font-weight:500;' in css
    assert "src:url(data:font/ttf;base64," in css


def test_heading_texts_read_the_headings_as_written() -> None:
    body = (
        '<h1 class="draft-print-doc-title">Harbor &amp; Co<br>Agreement</h1><p>Body</p>'
        "<H2>1. <em>Defi</em>nitions</H2><h3> </h3><h6>Schedule\n  A</h6>"
    )

    assert heading_texts(body) == ("Harbor & Co Agreement", "1. Definitions", "Schedule A")


def test_a_renderer_crash_is_explained_without_its_internals() -> None:
    crashed = render_failure_message(RuntimeError("Page.printToPDF: Target crashed at 0x7f00 /opt/ms-playwright"))
    closed = render_failure_message(RuntimeError("Target page, context or browser has been closed"))
    other = render_failure_message(RuntimeError("Protocol error (Page.printToPDF): Printing failed"))

    assert crashed == closed
    assert "exceed this server's memory" in crashed
    assert other == "The PDF renderer could not lay out this document."
    assert "/opt" not in crashed + other


# --- Real Chromium -----------------------------------------------------------


def _render(html: str, destination: Path) -> None:
    asyncio.run(render_print_document(html, destination))


@pytest.fixture(scope="module")
def chromium_available(tmp_path_factory: pytest.TempPathFactory) -> None:
    probe = tmp_path_factory.mktemp("probe") / "probe.pdf"
    try:
        _render("<!doctype html><p>probe</p>", probe)
    except PdfRenderError as exc:
        pytest.skip(f"Chromium is not installed here: {exc}")


class _Beacon(BaseHTTPRequestHandler):
    hits: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        _Beacon.hits.append(self.path)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_args: object) -> None:
        return


def test_the_renderer_never_reaches_the_network(chromium_available: None, tmp_path: Path) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Beacon)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    _Beacon.hits.clear()
    body = (
        f'<div class="draft-print-root"><p>Offline.</p><img src="{origin}/img">'
        f'<link rel="stylesheet" href="{origin}/sheet"><iframe src="{origin}/frame"></iframe>'
        f'<script src="{origin}/script"></script><meta http-equiv="refresh" content="0;url={origin}/nav">'
        f'<div style="background:url({origin}/bg)">x</div></div>'
    )
    css = f'@import url("{origin}/import"); p {{ background: url({origin}/css); }}'
    try:
        _render(print_document_html(_source(body_html=body, css=css), ""), tmp_path / "out.pdf")
    finally:
        server.shutdown()

    assert _Beacon.hits == []
    # The refresh and the frame were stopped in place: the user's page printed.
    text = "".join(page.extract_text() for page in PdfReader(tmp_path / "out.pdf").pages)
    assert "Offline." in text


def test_renders_tagged_pages_with_bundled_fonts_on_the_css_paper(chromium_available: None, tmp_path: Path) -> None:
    body = (
        '<div class="draft-print-root"><h1>Synthetic Lease</h1>'
        '<p style="font-family:\'Plus Jakarta Sans\'">Rent is due monthly.</p>'
        '<h2>Term</h2><p>Twelve months.</p></div>'
    )
    css = "@page { size: 612pt 1008pt; margin: 0.5in; }"
    destination = tmp_path / "lease.pdf"

    _render(print_document_html(_source(body_html=body, css=css), bundled_font_css()), destination)

    with pikepdf.open(destination) as pdf:
        assert len(pdf.pages) == 1
        assert [round(float(value)) for value in pdf.pages[0].mediabox] == [0, 0, 612, 1008]
        assert "/StructTreeRoot" in pdf.Root
        with pdf.open_outline() as outline:
            assert [item.title for item in outline.root] == ["Synthetic Lease"]
        fonts = {
            str(font.get("/BaseFont")): font.Subtype
            for page in pdf.pages
            for font in page.resources.Font.values()
        }
        jakarta = [name for name in fonts if "PlusJakartaSans" in name]
        assert jakarta, fonts
        # A static face embeds as a TrueType subset, not Type 3 outlines.
        assert all(fonts[name] == pikepdf.Name.Type0 for name in jakarta)


def test_markup_cannot_run_scripts_even_without_the_page_policy(chromium_available: None, tmp_path: Path) -> None:
    # print_document_html adds a policy that blocks scripts; the renderer also
    # turns JavaScript off on its own.
    document = (
        "<!doctype html><p id=\"note\">Unchanged.</p>"
        "<script>document.getElementById('note').textContent = 'Script ran.'</script>"
    )

    _render(document, tmp_path / "out.pdf")

    text = PdfReader(tmp_path / "out.pdf").pages[0].extract_text()
    assert "Unchanged." in text
    assert "Script ran." not in text


def test_a_long_document_is_not_cut_off_by_a_step_timeout(chromium_available: None, tmp_path: Path) -> None:
    paragraphs = "".join(f"<p>Clause {index}: the tenant keeps the premises in repair.</p>" for index in range(4000))
    destination = tmp_path / "long.pdf"

    _render(print_document_html(_source(body_html=f"<div>{paragraphs}</div>"), ""), destination)

    with pikepdf.open(destination) as pdf:
        assert len(pdf.pages) > 50
