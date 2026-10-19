"""One lock for every PDFium call in the API process.

PDFium (through pypdfium2) is not thread-safe, even across different
documents, and both knowledge ingestion (OCR page renders) and Drafts PDF
imports call it from the request threadpool. Every PDFium call — opening,
reading, rendering, and closing documents, pages, and bitmaps — holds this
lock. Holders take it per page, never for a whole long job, so one large
file cannot starve the other feature. It is re-entrant so a helper that
locks can be called from code that already holds it.
"""

from __future__ import annotations

import threading

PDFIUM_LOCK = threading.RLock()
