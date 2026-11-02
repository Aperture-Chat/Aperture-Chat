"""A file attached to a chat, kept as a document.

An upload used to leave a 2,400-character preview and lose the file, so the
model saw the opening of a document and nothing could show it. Now the bytes are
kept in a store of their own and indexed by the knowledge pipeline, so an
attachment opens in the document viewer and the model reads all of it.

This is not a knowledge base. A knowledge document belongs to a tenant and is
found through groups and walls. An attachment belongs to the person who attached
it, and its one gate is ``SeedStore.chat_attachment_for``. Passages use the
knowledge chunk shape so ranking, chunk location, and the viewer stay one piece
of code, and ``knowledge_config_id`` stays empty so no such chunk can be mistaken
for a knowledge base's.

The index is a derived file, so it is fingerprinted to the bytes it came from and
is deleted with them.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass

from pydantic import ValidationError

from app.core.config import get_settings
from app.core.document_metadata import metadata_summary
from app.core.knowledge_ingestion import (
    ExtractedDocument,
    ExtractedSegment,
    chunk_segments,
    extract_document,
    properties_passages,
)
from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore
from app.models.schemas import ChatAttachment, KnowledgeChunk

logger = logging.getLogger(__name__)

ROOT_DIRECTORY = "chat_attachment_documents"
INDEX_NAME = "index.json"
_INDEX_VERSION = 1
# Attachment ids are unique across tenants, and scope is decided by the row, so
# the store's tenant and base levels carry no meaning here.
_STORE_SCOPE = "chat-attachments"
# Uploading waits for this, so a long scan is indexed in part. The viewer still
# shows every page, and the prompt says when a file is partial.
_OCR_MAX_PAGES = 12


@dataclass(frozen=True, slots=True)
class AttachmentIndex:
    passages: list[KnowledgeChunk]
    metadata: dict[str, str]


@dataclass(frozen=True, slots=True)
class _StoredPassage:
    text: str
    page_start: int | None
    page_end: int | None
    locator: str | None


def attachment_ref(attachment_id: str) -> DocumentRef:
    return DocumentRef(_STORE_SCOPE, _STORE_SCOPE, attachment_id)


def _extract(attachment: ChatAttachment, content: bytes) -> ExtractedDocument:
    settings = get_settings()
    return extract_document(
        attachment.name,
        content,
        attachment.mime_type,
        ocr_enabled=settings.knowledge_ocr_enabled,
        ocr_max_pages=min(_OCR_MAX_PAGES, settings.knowledge_ocr_max_pages),
        ocr_page_timeout_seconds=settings.knowledge_ocr_page_timeout_seconds,
    )


def _stored_passages(extracted: ExtractedDocument) -> list[_StoredPassage]:
    chunked = chunk_segments(extracted.segments)
    if chunked:
        chunked += properties_passages(extracted.metadata)
    return [
        _StoredPassage(segment.text, segment.page_start, segment.page_end, segment.locator)
        for segment in chunked
    ]


def _write_index(
    documents: KnowledgeOriginalStore,
    ref: DocumentRef,
    passages: list[_StoredPassage],
    metadata: dict[str, str],
) -> None:
    payload = {
        "version": _INDEX_VERSION,
        "metadata": metadata,
        "passages": [asdict(passage) for passage in passages],
    }
    with documents.work_directory() as work:
        produced = work / INDEX_NAME
        produced.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        documents.publish(ref, INDEX_NAME, produced)


def retain_attachment(
    documents: KnowledgeOriginalStore,
    attachment: ChatAttachment,
    content: bytes,
    *,
    transcript: str | None = None,
) -> None:
    """Keep the file and index it. ``transcript`` stands in for a recording's text.

    A file that cannot be kept or read still attaches, with the preview it always
    had: the person sent it, and the turn must not fail for it.
    """
    if not attachment.id:
        return
    ref = attachment_ref(attachment.id)
    try:
        documents.save(ref, content)
        extracted = (
            ExtractedDocument([ExtractedSegment(transcript)], {})
            if transcript
            else _extract(attachment, content)
        )
        _write_index(documents, ref, _stored_passages(extracted), extracted.metadata)
    except Exception:  # noqa: BLE001 - parsers of uploaded files fail in many ways
        logger.exception("Could not index attachment %s", attachment.id)


def _passage_chunk(
    attachment: ChatAttachment, ordinal: int, stored: dict, details: str | None
) -> KnowledgeChunk:
    return KnowledgeChunk(
        id=f"{attachment.id}:{ordinal}",
        knowledge_config_id="",
        document_id=attachment.id or "",
        tenant_id=attachment.tenant_id or "",
        source_name=attachment.name,
        source_uri=attachment.source_uri or f"upload://{attachment.id}",
        source_type=attachment.source_type,
        text=stored["text"],
        ordinal=ordinal,
        page_start=stored.get("page_start"),
        page_end=stored.get("page_end"),
        locator=stored.get("locator"),
        updated_at=attachment.uploaded_at or "",
        source_details=details,
    )


def load_attachment_index(
    documents: KnowledgeOriginalStore, attachment: ChatAttachment
) -> AttachmentIndex | None:
    """The file's passages and properties, or None for a file with no index."""
    if not attachment.id:
        return None
    path = documents.derived(attachment_ref(attachment.id), INDEX_NAME)
    if path is None:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("version") != _INDEX_VERSION:
            return None
        metadata = dict(payload["metadata"])
        details = metadata_summary(metadata)
        return AttachmentIndex(
            [
                _passage_chunk(attachment, ordinal, stored, details)
                for ordinal, stored in enumerate(payload["passages"])
            ],
            metadata,
        )
    except (OSError, ValueError, KeyError, TypeError, AttributeError, ValidationError):
        logger.warning("Ignoring the unreadable index of attachment %s", attachment.id)
        return None
