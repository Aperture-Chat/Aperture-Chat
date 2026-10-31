"""Turn a TIFF scan into a PDF, in a process of its own.

Run as a script by ``document_rendition`` inside the same sandbox as LibreOffice,
because an image decoder fed a stranger's file is a parser like any other. Only a
process can be stopped at a deadline, killed with its group, and denied the data
volume. Imports nothing from the application.

    python -I scan_worker.py <input> <output> <max pages> <max pixels>
"""

from __future__ import annotations

import io
import sys
from itertools import islice

import pikepdf
from PIL import Image, ImageSequence

_DPI = 200.0
_TOO_LARGE = 3


def _page(frame: Image.Image) -> pikepdf.Pdf:
    buffer = io.BytesIO()
    frame.convert("RGB").save(buffer, "PDF", resolution=_DPI)
    return pikepdf.open(io.BytesIO(buffer.getvalue()))


def convert(source: str, target: str, max_pages: int, max_pixels: int) -> int:
    """One PDF page per frame. Each is built alone, so the cost stays linear and
    a long scan is never all in memory. Pages hold their sources until the save."""
    output = pikepdf.new()
    sources: list[pikepdf.Pdf] = []
    pixels = 0
    with Image.open(source) as scan:
        for frame in islice(ImageSequence.Iterator(scan), max_pages):
            pixels += frame.width * frame.height
            if pixels > max_pixels:
                return _TOO_LARGE
            sources.append(_page(frame))
            output.pages.extend(sources[-1].pages)
    output.save(target)
    return 0


if __name__ == "__main__":
    sys.exit(convert(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])))
