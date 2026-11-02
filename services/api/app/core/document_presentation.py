"""Presenting a stored document, whichever store it is in.

Knowledge documents and chat attachments open in one viewer. They differ in who
may reach them, which their routes decide. How a file is shown, where a passage
sits in it, and which headers its bytes carry are the same, and live here.
"""

from __future__ import annotations

from collections.abc import Mapping

from app.core.config import get_settings
from app.core.document_metadata import descriptive_properties
from app.core.document_rendition import (
    PreparedDocument,
    RenditionOptions,
    page_index,
    prepare_document,
)
from app.core.document_view import locate_passage, recorded_span, target_for
from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore
from app.models.schemas import (
    KnowledgeChunk,
    KnowledgeDocumentProperty,
    KnowledgeDocumentViewTarget,
)

PRIVATE_FILE_HEADERS = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
}


def prepared_document(
    originals: KnowledgeOriginalStore, ref: DocumentRef, name: str
) -> PreparedDocument:
    settings = get_settings()
    return prepare_document(
        originals,
        ref,
        name=name,
        options=RenditionOptions(
            soffice=settings.knowledge_rendition_soffice_path,
            timeout_seconds=settings.knowledge_rendition_timeout_seconds,
            memory_mb=settings.knowledge_rendition_memory_mb,
            require_isolation=settings.environment.strip().lower() != "local",
            private_directories=settings.private_data_directories,
        ),
    )


def cited_target(
    cited: KnowledgeChunk | None,
    chunks: list[KnowledgeChunk],
    prepared: PreparedDocument,
    ref: DocumentRef,
    originals: KnowledgeOriginalStore,
) -> KnowledgeDocumentViewTarget | None:
    if cited is None:
        return None
    pdf = prepared.file_path
    if prepared.mode != "pdf" or pdf is None:
        return target_for(cited, recorded_span(cited))
    span = locate_passage(cited, chunks, lambda: page_index(originals, ref, pdf))
    return target_for(cited, span)


def view_media_type(prepared: PreparedDocument) -> str:
    return "application/pdf" if prepared.mode == "pdf" else prepared.content_type


def view_properties(metadata: Mapping[str, str]) -> list[KnowledgeDocumentProperty]:
    """What the file says about itself, most useful first."""
    return [
        KnowledgeDocumentProperty(label=label, value=value)
        for label, value in descriptive_properties(metadata)
    ]
