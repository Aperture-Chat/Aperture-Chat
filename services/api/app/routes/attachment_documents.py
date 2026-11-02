"""An attached file as a document: shown, downloaded, or taken back.

The one gate is ``SeedStore.chat_attachment_for``, which holds an attachment to
its owner, so every refusal is a 404 and an id proves nothing. An attachment is
not a knowledge document: no group, wall, or knowledge permission applies, and
only the person who attached it gets in.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import FileResponse

from app.core.attachment_documents import (
    AttachmentIndex,
    attachment_ref,
    load_attachment_index,
)
from app.core.attachment_previews import attachment_preview_file
from app.core.document_presentation import (
    PRIVATE_FILE_HEADERS,
    cited_target,
    prepared_document,
    view_media_type,
    view_properties,
)
from app.core.document_rendition import PreparedDocument
from app.core.document_view import text_segments
from app.core.knowledge_attachments import knowledge_address
from app.models.schemas import (
    ChatAttachment,
    KnowledgeChunk,
    KnowledgeDocumentView,
    KnowledgeDocumentViewSegment,
    User,
)
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user
from app.routes.knowledge import base_contents_view, document_original, document_view

router = APIRouter(prefix="/api/chat/attachments", tags=["chat"])

_UNKNOWN_ATTACHMENT = "Unknown attachment."
_NO_STORED_FILE = "No stored file for this attachment."
_IN_A_CHAT = "This file is part of a chat. Delete the chat to remove it."


def _viewable(
    attachment_id: str, actor: User, store: SeedStore, *, access: str
) -> ChatAttachment:
    attachment = store.chat_attachment_for(actor, attachment_id)
    if attachment is None or attachment.id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN_ATTACHMENT)
    store.record_audit(
        actor,
        "chat.attachment.viewed",
        attachment.id,
        {"access": access},
        runtime_state_changed=False,
    )
    return attachment


def _prepared(attachment: ChatAttachment, store: SeedStore) -> PreparedDocument:
    """A file from before originals were kept may still have its image preview."""
    attachment_id = attachment.id or ""
    prepared = prepared_document(
        store.attachment_documents, attachment_ref(attachment_id), attachment.name
    )
    preview = None if prepared.original_available else attachment_preview_file(attachment_id)
    if preview is None:
        return prepared
    path, media_type = preview
    return PreparedDocument("image", media_type, False, path, 1)


def _shown_text(
    attachment: ChatAttachment, chunks: list[KnowledgeChunk]
) -> list[KnowledgeDocumentViewSegment]:
    segments = text_segments(chunks)
    if segments or not attachment.text_preview:
        return segments
    return [KnowledgeDocumentViewSegment(id="preview", text=attachment.text_preview)]


def _passages(index: AttachmentIndex | None) -> list[KnowledgeChunk]:
    return index.passages if index is not None else []


@router.get("/{attachment_id}/view")
def attachment_view(
    attachment_id: str,
    response: Response,
    chunk_id: str | None = None,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeDocumentView:
    """How to present a file, and where a cited passage of it is."""
    attachment = _viewable(attachment_id, actor, store, access="view")
    address = knowledge_address(attachment)
    if address is not None:
        # The knowledge gate answers, and the viewer loads its bytes from there.
        if address.document_id is None:
            return base_contents_view(address.config_id, attachment_id, actor, store)
        return document_view(address.config_id, address.document_id, response, chunk_id, actor, store)
    # The excerpt and segments are the file's own text.
    response.headers["Cache-Control"] = "private, no-store"
    prepared = _prepared(attachment, store)
    index = load_attachment_index(store.attachment_documents, attachment)
    chunks = _passages(index)
    cited = next((chunk for chunk in chunks if chunk.id == chunk_id), None)
    return KnowledgeDocumentView(
        document_id=attachment_id,
        knowledge_config_id="",
        attachment_id=attachment_id,
        name=attachment.name,
        content_type=prepared.content_type,
        mode=prepared.mode,
        file_url=f"/api/chat/attachments/{attachment_id}/view/file" if prepared.file_path else None,
        original_available=prepared.original_available,
        page_count=prepared.page_count,
        target=cited_target(
            cited, chunks, prepared, attachment_ref(attachment_id), store.attachment_documents
        ),
        segments=_shown_text(attachment, chunks) if prepared.mode == "text" else None,
        notice=prepared.notice,
        properties=view_properties(index.metadata) if index is not None else [],
        passage_count=len(text_segments(chunks)) if chunks else None,
    )


@router.get("/{attachment_id}/view/file")
def attachment_view_file(
    attachment_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> FileResponse:
    """The bytes the viewer renders: a PDF or an image, never anything active."""
    attachment = _viewable(attachment_id, actor, store, access="file")
    prepared = _prepared(attachment, store)
    if prepared.file_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NO_STORED_FILE)
    return FileResponse(
        prepared.file_path,
        media_type=view_media_type(prepared),
        headers={**PRIVATE_FILE_HEADERS, "Content-Disposition": "inline"},
    )


@router.get("/{attachment_id}/original")
def attachment_original(
    attachment_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> FileResponse:
    """The file as it was attached, as a download the browser cannot render."""
    attachment = _viewable(attachment_id, actor, store, access="original")
    address = knowledge_address(attachment)
    if address is not None and address.document_id is not None:
        return document_original(address.config_id, address.document_id, actor, store)
    path = store.attachment_documents.path(attachment_ref(attachment_id))
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NO_STORED_FILE)
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=attachment.name,
        headers=PRIVATE_FILE_HEADERS,
    )


@router.delete("/{attachment_id}")
def take_back_attachment(
    attachment_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    """Remove a file staged in the composer. Once a chat holds it, it goes with
    that chat, so a saved message can never lose its file from here."""
    attachment = store.chat_attachment_for(actor, attachment_id)
    if attachment is None or attachment.owner_user_id != actor.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN_ATTACHMENT)
    if not store.application_state_repository.delete_unsent_chat_attachment(attachment_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_IN_A_CHAT)
    store.record_audit(
        actor,
        "chat.attachment_removed",
        attachment_id,
        {"name": attachment.name},
        runtime_state_changed=False,
    )
    return {"status": "deleted", "id": attachment_id}
