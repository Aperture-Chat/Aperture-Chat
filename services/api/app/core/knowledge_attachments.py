"""A knowledge document or a whole knowledge base pulled into a chat with ``#``.

It is an attachment so the block, the message, later turns, and deleting the chat
all treat it as one, but it holds only an address. Nothing is copied, so every
read goes back through the knowledge gate, and a wall, a lost group, or a deletion
reaches a block already sitting in a chat.

The address says where to ask, never who may look.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlsplit

from app.models.schemas import ChatAttachment, KnowledgeChunk

SOURCE_TYPE = "knowledge"
BASE_KIND = "Knowledge"
# How far a search reaches into a base too large to read whole: about what the
# largest turn budget can hold.
BASE_SEARCH_PASSAGES = 240
_SCHEME = "knowledge"


@dataclass(frozen=True, slots=True)
class KnowledgeAddress:
    """One document, or with no ``document_id`` everything in the base."""

    config_id: str
    document_id: str | None = None

    @property
    def is_base(self) -> bool:
        return self.document_id is None


def knowledge_uri(address: KnowledgeAddress) -> str:
    base = f"{_SCHEME}://{quote(address.config_id, safe='')}"
    if address.document_id is None:
        return base
    return f"{base}/{quote(address.document_id, safe='')}"


def knowledge_address(attachment: ChatAttachment) -> KnowledgeAddress | None:
    """Where ``attachment`` points, or None for a file that is its own."""
    if attachment.source_type != SOURCE_TYPE or not attachment.source_uri:
        return None
    uri = urlsplit(attachment.source_uri)
    if uri.scheme != _SCHEME or not uri.netloc:
        return None
    config_id = unquote(uri.netloc)
    if not uri.path:
        return KnowledgeAddress(config_id)
    document_id = uri.path.removeprefix("/")
    if not document_id or "/" in document_id:
        return None
    return KnowledgeAddress(config_id, unquote(document_id))


def is_whole_base(attachment: ChatAttachment) -> bool:
    address = knowledge_address(attachment)
    return address is not None and address.is_base


def _addresses(attachments: Iterable[ChatAttachment]) -> set[KnowledgeAddress]:
    found = (knowledge_address(attachment) for attachment in attachments)
    return {address for address in found if address is not None}


def without_files_in_attached_bases(attachments: Sequence[ChatAttachment]) -> list[ChatAttachment]:
    """A file whose whole base is also attached is read with the base."""
    addresses = _addresses(attachments)

    def read_with_a_base(attachment: ChatAttachment) -> bool:
        address = knowledge_address(attachment)
        return (
            address is not None
            and not address.is_base
            and KnowledgeAddress(address.config_id) in addresses
        )

    return [attachment for attachment in attachments if not read_with_a_base(attachment)]


def hits_outside_attachments(
    hits: Sequence[KnowledgeChunk], attachments: Iterable[ChatAttachment]
) -> list[KnowledgeChunk]:
    """What a search found that no attachment already reads, so a passage gets one
    marker and the model never reads it twice."""
    addresses = _addresses(attachments)
    return [
        hit
        for hit in hits
        if KnowledgeAddress(hit.knowledge_config_id) not in addresses
        and KnowledgeAddress(hit.knowledge_config_id, hit.document_id) not in addresses
    ]


def passages_within(ranked: Sequence[KnowledgeChunk], budget_chars: int) -> list[KnowledgeChunk]:
    """Best first until the budget is spent. A shorter passage may still fit after
    a longer one did not."""
    chosen: list[KnowledgeChunk] = []
    used = 0
    for chunk in ranked:
        if used + len(chunk.text) <= budget_chars:
            chosen.append(chunk)
            used += len(chunk.text)
    return chosen


def in_reading_order(chunks: Iterable[KnowledgeChunk]) -> list[KnowledgeChunk]:
    """Each file's passages together and in order, which ``text_segments`` needs."""
    return sorted(chunks, key=lambda chunk: (chunk.source_name.lower(), chunk.document_id, chunk.ordinal))
