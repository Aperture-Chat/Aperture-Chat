"""Lay out a draft's print surface as PDF pages in headless Chromium.

The browser sends the same print surface its own Print uses, with the page's
stylesheet text, so the PDF has the pages the user sees when printing. The
renderer is locked down because that markup is user content: JavaScript is
off, the context is offline, every request is refused before it leaves the
process, and a Content-Security-Policy allows only inline styles and data:
pictures and fonts. Pictures arrive already embedded as data URLs.

The app's typefaces are bundled as static TrueType files (app/static/
pdf-fonts, SIL OFL 1.1). Chromium embeds a static face as a proper TrueType
subset; the variable web fonts the page itself loads would be written as
Type 3 outlines.

Chromium's PDF is streamed to disk in chunks over the DevTools protocol.
Playwright's page.pdf() returns the whole file as one message, which peaked
at 5.5 GB of API memory for a 6,700-page document.
"""

from __future__ import annotations

import base64
import html
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.models.draft_pdf_export import DraftPdfSource

FONT_DIR = Path(__file__).resolve().parents[1] / "static" / "pdf-fonts"

RENDER_CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"

CHROMIUM_ARGS = (
    # Docker's default /dev/shm is 64 MB; long documents need more.
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-first-run",
)

PRINT_TO_PDF = {
    "preferCSSPageSize": True,
    "printBackground": True,
    "generateTaggedPDF": True,
    "generateDocumentOutline": True,
    "transferMode": "ReturnAsStream",
}

# A ligature glyph is written as one character (U+FB02 for "fl"), so search
# and e-discovery tools that read the text find "Ofﬂine", not "Offline". Word
# sets no ligatures by default either.
PDF_TEXT_CSS = "*,*::before,*::after{font-variant-ligatures:no-common-ligatures!important}"

_STREAM_CHUNK_BYTES = 4 * 1024 * 1024
_HEADING = re.compile(r"<h([1-6])\b[^>]*>(.*?)</h\1\s*>", re.IGNORECASE | re.DOTALL)
_LINE_BREAK = re.compile(r"<br\b[^>]*>", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")
_STYLE_END = re.compile(r"</(style)", re.IGNORECASE)


class PdfRenderError(RuntimeError):
    """The renderer could not produce a PDF; the message is safe to show."""


@dataclass(frozen=True, slots=True)
class BundledFace:
    family: str
    file: str
    weight: int
    style: str = "normal"


def _jakarta(name: str, weight: int, italic: bool) -> BundledFace:
    return BundledFace(
        "Plus Jakarta Sans",
        f"plus-jakarta-sans/PlusJakartaSans-{name}.ttf",
        weight,
        "italic" if italic else "normal",
    )


_JAKARTA_WEIGHTS = (("Regular", "Italic", 400), ("Medium", "MediumItalic", 500),
                    ("SemiBold", "SemiBoldItalic", 600), ("Bold", "BoldItalic", 700),
                    ("ExtraBold", "ExtraBoldItalic", 800))

BUNDLED_FACES: tuple[BundledFace, ...] = (
    *(face for upright, italic, weight in _JAKARTA_WEIGHTS
      for face in (_jakarta(upright, weight, False), _jakarta(italic, weight, True))),
    BundledFace("JetBrains Mono", "jetbrains-mono/JetBrainsMono-Regular.ttf", 400),
    BundledFace("JetBrains Mono", "jetbrains-mono/JetBrainsMono-Italic.ttf", 400, "italic"),
    BundledFace("JetBrains Mono", "jetbrains-mono/JetBrainsMono-Medium.ttf", 500),
    BundledFace("JetBrains Mono", "jetbrains-mono/JetBrainsMono-SemiBold.ttf", 600),
    BundledFace("JetBrains Mono", "jetbrains-mono/JetBrainsMono-Bold.ttf", 700),
)


@lru_cache(maxsize=1)
def bundled_font_css() -> str:
    """@font-face rules for the bundled faces, with the files inlined."""
    rules = []
    for face in BUNDLED_FACES:
        data = base64.b64encode((FONT_DIR / face.file).read_bytes()).decode("ascii")
        rules.append(
            f'@font-face{{font-family:"{face.family}";font-style:{face.style};'
            f'font-weight:{face.weight};src:url(data:font/ttf;base64,{data}) format("truetype");}}'
        )
    return "\n".join(rules)


def print_document_html(source: DraftPdfSource, font_css: str) -> str:
    """The standalone page the renderer prints. The bundled faces come after
    the page's own rules so they win for the families they declare."""
    css = _STYLE_END.sub(r"<\\/\1", f"{source.css}\n{font_css}\n{PDF_TEXT_CSS}")
    return (
        "<!doctype html>\n"
        f'<html lang="{html.escape(source.lang)}"><head><meta charset="utf-8">'
        f'<meta http-equiv="Content-Security-Policy" content="{RENDER_CSP}">'
        f"<title>{html.escape(source.title)}</title>"
        f"<style>{css}</style></head>"
        f'<body class="is-draft-printing">{source.body_html}</body></html>'
    )


def heading_texts(body_html: str) -> tuple[str, ...]:
    """The text of each h1-h6, in document order, as a reader sees it. The
    markup is the browser's own serialization, so headings never nest."""
    texts = []
    for match in _HEADING.finditer(body_html):
        inner = _TAG.sub("", _LINE_BREAK.sub(" ", match.group(2)))
        text = " ".join(html.unescape(inner).split())
        if text:
            texts.append(text)
    return tuple(texts)


async def _refuse(route) -> None:  # noqa: ANN001 - playwright Route
    """Nothing leaves the renderer. A navigation (a meta refresh or a frame in
    the markup) is answered locally with 204 No Content, which keeps the page
    where it is; aborting it would swap the document for an error page."""
    if route.request.is_navigation_request():
        await route.fulfill(status=204)
    else:
        await route.abort("blockedbyclient")


async def _stream_pdf(session, handle: str, destination: Path) -> None:  # noqa: ANN001
    with destination.open("wb") as output:
        while True:
            chunk = await session.send("IO.read", {"handle": handle, "size": _STREAM_CHUNK_BYTES})
            data = chunk.get("data", "")
            output.write(base64.b64decode(data) if chunk.get("base64Encoded") else data.encode("latin-1"))
            if chunk.get("eof"):
                break
    await session.send("IO.close", {"handle": handle})


def render_failure_message(error: Exception) -> str:
    """What to tell the person when Chromium fails; never the raw error."""
    text = str(error).lower()
    if "crash" in text or "closed" in text:
        return (
            "The PDF renderer stopped while laying out pages. A very large document can "
            "exceed this server's memory; try exporting it in parts."
        )
    return "The PDF renderer could not lay out this document."


async def render_print_document(document_html: str, destination: Path) -> None:
    """Print `document_html` to `destination` as a tagged PDF with bookmarks."""
    try:
        from playwright.async_api import Error as PlaywrightError
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise PdfRenderError("PDF rendering is not installed on this server.") from exc

    async with async_playwright() as playwright:
        try:
            browser = await playwright.chromium.launch(args=list(CHROMIUM_ARGS))
        except PlaywrightError as exc:
            raise PdfRenderError("The PDF renderer is not available on this server.") from exc
        try:
            context = await browser.new_context(
                java_script_enabled=False,
                offline=True,
                service_workers="block",
                accept_downloads=False,
            )
            await context.route("**/*", _refuse)
            page = await context.new_page()
            # The export job's own deadline bounds the whole render.
            page.set_default_timeout(0)
            await page.set_content(document_html, wait_until="load")
            await page.evaluate("document.fonts.ready.then(() => true)")
            session = await context.new_cdp_session(page)
            printed = await session.send("Page.printToPDF", PRINT_TO_PDF)
            await _stream_pdf(session, printed["stream"], destination)
        except PlaywrightError as exc:
            raise PdfRenderError(render_failure_message(exc)) from exc
        finally:
            await browser.close()
