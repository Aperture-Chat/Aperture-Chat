from __future__ import annotations

import json
import math
from datetime import UTC, datetime

import pytest

from app.core.vector_store import LocalVectorStore
from app.db import import_identity_config
from app.db.knowledge_import_state import (
    KnowledgeImportOutcome,
    KnowledgeImportStateError,
    coordinate_knowledge_state_import,
    get_active_knowledge_import_receipt,
    knowledge_semantic_digest,
)
from app.models.schemas import KnowledgeChunk, KnowledgeDocument


CONFIG_ID = "knowledge-a7"
TENANT_ID = "tenant-a7"
SOURCE_DIGEST = "a" * 64
COMPLETED_AT = datetime(2026, 7, 20, 18, 30, tzinfo=UTC)


def _document(
    document_id: str = "document-a7",
    *,
    name: str = "A7 source",
    chunk_count: int = 1,
) -> KnowledgeDocument:
    return KnowledgeDocument(
        id=document_id,
        knowledge_config_id=CONFIG_ID,
        tenant_id=TENANT_ID,
        name=name,
        source_uri=f"upload://{document_id}.txt",
        source_type="upload",
        chunk_count=chunk_count,
        acl_group_ids=["group-a7"],
        updated_at="2026-07-20T18:00:00+00:00",
    )


def _chunk(
    document: KnowledgeDocument,
    chunk_id: str = "chunk-a7",
    *,
    text: str = "The retention deadline is thirty days.",
    ordinal: int = 0,
) -> KnowledgeChunk:
    return KnowledgeChunk(
        id=chunk_id,
        knowledge_config_id=document.knowledge_config_id,
        document_id=document.id,
        tenant_id=document.tenant_id,
        source_name=document.name,
        source_uri=document.source_uri,
        source_type=document.source_type,
        text=text,
        ordinal=ordinal,
        page_start=1,
        page_end=1,
        locator=f"paragraph:{ordinal + 1}",
        acl_group_ids=list(document.acl_group_ids),
        updated_at=document.updated_at,
    )


def _payload(
    *,
    documents: list[KnowledgeDocument] | None = None,
    chunks: list[KnowledgeChunk] | None = None,
) -> tuple[dict[str, list[KnowledgeDocument]], dict[str, list[KnowledgeChunk]]]:
    document_records = documents if documents is not None else [_document()]
    chunk_records = chunks if chunks is not None else [_chunk(document_records[0])]
    return {CONFIG_ID: document_records}, {CONFIG_ID: chunk_records}


def _coordinate(
    store: LocalVectorStore,
    documents: dict[str, list[KnowledgeDocument]],
    chunks: dict[str, list[KnowledgeChunk]],
    *,
    source_digest: str = SOURCE_DIGEST,
):
    digest = knowledge_semantic_digest(documents, chunks)
    return coordinate_knowledge_state_import(
        store._connection,  # noqa: SLF001 - coordinator integration boundary
        source_digest=source_digest,
        expected_semantic_digest=digest,
        documents=documents,
        chunks=chunks,
        completed_at=COMPLETED_AT,
    )


def test_empty_vector_store_imports_payload_and_receipt_in_one_cutover() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()

    result = _coordinate(store, documents, chunks)

    assert result.outcome is KnowledgeImportOutcome.IMPORTED
    assert result.receipt.source_digest == SOURCE_DIGEST
    assert result.receipt.semantic_digest == knowledge_semantic_digest(documents, chunks)
    assert result.receipt.document_count == 1
    assert result.receipt.chunk_count == 1
    assert store.documents_for(CONFIG_ID) == documents[CONFIG_ID]
    assert store.chunks_for(CONFIG_ID) == chunks[CONFIG_ID]
    vector_row = store._connection.execute(  # noqa: SLF001 - stored vector assertion
        "select vector_json, dense_vector_json from knowledge_chunks where id = ?",
        (chunks[CONFIG_ID][0].id,),
    ).fetchone()
    assert json.loads(vector_row["vector_json"]) == {
        "days": 1.0,
        "deadline": 1.0,
        "retention": 1.0,
        "source": 1.0,
        "thirty": 1.0,
    }
    assert vector_row["dense_vector_json"] == "[]"
    assert (
        get_active_knowledge_import_receipt(
            store._connection  # noqa: SLF001 - receipt integration boundary
        )
        == result.receipt
    )


def test_exact_existing_payload_is_adopted_without_replacing_dense_vectors() -> None:
    class DenseEmbedder:
        def passage_embed(self, texts: list[str], *, batch_size: int):
            assert texts
            assert batch_size == 32
            yield [0.25, 0.75]

    store = LocalVectorStore(
        ":memory:",
        dense_embeddings_enabled=True,
        dense_embedder=DenseEmbedder(),
    )
    documents, chunks = _payload()
    store.upsert_sources(documents[CONFIG_ID], chunks[CONFIG_ID])
    dense_before = store._connection.execute(  # noqa: SLF001 - adoption proof
        "select dense_vector_json from knowledge_chunks where id = ?",
        (chunks[CONFIG_ID][0].id,),
    ).fetchone()[0]

    result = _coordinate(store, documents, chunks)

    dense_after = store._connection.execute(  # noqa: SLF001 - adoption proof
        "select dense_vector_json from knowledge_chunks where id = ?",
        (chunks[CONFIG_ID][0].id,),
    ).fetchone()[0]
    assert result.outcome is KnowledgeImportOutcome.ADOPTED
    assert json.loads(dense_before) == [0.25, 0.75]
    assert dense_after == dense_before


def test_matching_receipt_is_idempotent_and_never_replays_stale_json() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    first = _coordinate(store, documents, chunks)
    live_document = _document(name="Live SQLite source")
    live_chunk = _chunk(live_document, text="This update exists only in SQLite.")
    store.replace_config(CONFIG_ID, [live_document], [live_chunk])

    second = _coordinate(store, documents, chunks)

    assert first.outcome is KnowledgeImportOutcome.IMPORTED
    assert second.outcome is KnowledgeImportOutcome.ALREADY_APPLIED
    assert second.receipt == first.receipt
    assert store.documents_for(CONFIG_ID) == [live_document]
    assert store.chunks_for(CONFIG_ID) == [live_chunk]


@pytest.mark.parametrize("existing_state", ["partial", "extra", "mismatch", "reordered"])
def test_non_exact_existing_payload_fails_closed_without_receipt(
    existing_state: str,
) -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    if existing_state == "partial":
        store.upsert_sources(documents[CONFIG_ID], [])
    elif existing_state == "extra":
        extra_document = _document("document-extra", name="Extra", chunk_count=1)
        extra_chunk = _chunk(extra_document, "chunk-extra", text="Unexpected vector content.")
        store.upsert_sources(
            [*documents[CONFIG_ID], extra_document],
            [*chunks[CONFIG_ID], extra_chunk],
        )
    elif existing_state == "mismatch":
        mismatched_chunk = _chunk(documents[CONFIG_ID][0], text="Different vector content.")
        store.upsert_sources(documents[CONFIG_ID], [mismatched_chunk])
    else:
        second_chunk = _chunk(
            documents[CONFIG_ID][0],
            "chunk-second",
            text="Second expected chunk.",
            ordinal=1,
        )
        chunks[CONFIG_ID].append(second_chunk)
        store.upsert_sources(documents[CONFIG_ID], list(reversed(chunks[CONFIG_ID])))

    counts_before = (
        store._connection.execute(  # noqa: SLF001 - fail-closed assertion
            "select count(*) from knowledge_documents"
        ).fetchone()[0],
        store._connection.execute(  # noqa: SLF001 - fail-closed assertion
            "select count(*) from knowledge_chunks"
        ).fetchone()[0],
    )

    with pytest.raises(KnowledgeImportStateError):
        _coordinate(store, documents, chunks)

    counts_after = (
        store._connection.execute(  # noqa: SLF001 - fail-closed assertion
            "select count(*) from knowledge_documents"
        ).fetchone()[0],
        store._connection.execute(  # noqa: SLF001 - fail-closed assertion
            "select count(*) from knowledge_chunks"
        ).fetchone()[0],
    )
    assert counts_after == counts_before
    assert (
        get_active_knowledge_import_receipt(
            store._connection  # noqa: SLF001 - receipt integration boundary
        )
        is None
    )


def test_import_failure_rolls_back_vector_rows_and_receipt() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    store._connection.execute(  # noqa: SLF001 - deterministic transaction fault
        """
        create trigger reject_a7_chunk
        before insert on knowledge_chunks
        begin
            select raise(abort, 'forced A7 import failure');
        end
        """
    )
    store._connection.commit()  # noqa: SLF001 - deterministic transaction fault

    with pytest.raises(KnowledgeImportStateError, match="transaction failed"):
        _coordinate(store, documents, chunks)

    assert (
        store._connection.execute(  # noqa: SLF001 - rollback proof
            "select count(*) from knowledge_documents"
        ).fetchone()[0]
        == 0
    )
    assert (
        store._connection.execute(  # noqa: SLF001 - rollback proof
            "select count(*) from knowledge_chunks"
        ).fetchone()[0]
        == 0
    )
    assert (
        get_active_knowledge_import_receipt(
            store._connection  # noqa: SLF001 - receipt integration boundary
        )
        is None
    )


def test_different_source_cannot_replace_an_active_receipt() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    first = _coordinate(store, documents, chunks)

    with pytest.raises(KnowledgeImportStateError, match="different knowledge import receipt"):
        _coordinate(store, documents, chunks, source_digest="b" * 64)

    assert (
        get_active_knowledge_import_receipt(
            store._connection  # noqa: SLF001 - receipt integration boundary
        )
        == first.receipt
    )


def test_orphaned_receipt_without_active_pointer_fails_closed() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    _coordinate(store, documents, chunks)
    store._connection.execute(  # noqa: SLF001 - corruption simulation
        "delete from knowledge_state_active"
    )
    store._connection.commit()  # noqa: SLF001 - corruption simulation

    with pytest.raises(KnowledgeImportStateError, match="without an active authority"):
        get_active_knowledge_import_receipt(
            store._connection  # noqa: SLF001 - receipt integration boundary
        )
    with pytest.raises(KnowledgeImportStateError, match="without an active authority"):
        _coordinate(store, documents, chunks)


def test_additional_inactive_receipt_conflicts_with_singleton_authority() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    _coordinate(store, documents, chunks)
    store._connection.execute(  # noqa: SLF001 - corruption simulation
        """
        insert into knowledge_state_imports (
            source_digest, source_version, target_version, semantic_digest,
            semantic_format, sparse_vector_format, document_count, chunk_count,
            completed_at
        )
        select ?, source_version, target_version, semantic_digest,
               semantic_format, sparse_vector_format, document_count, chunk_count,
               completed_at
        from knowledge_state_imports
        where source_digest = ?
        """,
        ("c" * 64, SOURCE_DIGEST),
    )
    store._connection.commit()  # noqa: SLF001 - corruption simulation

    with pytest.raises(KnowledgeImportStateError, match="conflicting import receipts"):
        get_active_knowledge_import_receipt(
            store._connection  # noqa: SLF001 - receipt integration boundary
        )


def test_incompatible_preexisting_receipt_schema_fails_closed() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    store._connection.executescript(  # noqa: SLF001 - incompatible schema simulation
        """
        create table knowledge_state_imports (
            source_digest text not null,
            source_version integer not null,
            target_version integer not null,
            semantic_digest text not null,
            semantic_format text not null,
            sparse_vector_format text not null,
            document_count integer not null,
            chunk_count integer not null,
            completed_at text not null
        );
        create table knowledge_state_active (
            authority text not null,
            source_digest text not null,
            activated_at text not null
        );
        """
    )

    with pytest.raises(KnowledgeImportStateError, match="schema is incompatible"):
        _coordinate(store, documents, chunks)

    assert not store._connection.in_transaction  # noqa: SLF001 - rollback proof


def test_same_vector_columns_without_unique_id_cannot_activate() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    store._connection.executescript(  # noqa: SLF001 - malformed schema simulation
        """
        drop table knowledge_chunks;
        drop table knowledge_documents;
        create table knowledge_documents (
            id text not null,
            knowledge_config_id text not null,
            tenant_id text not null,
            source_name text not null,
            source_uri text not null,
            source_type text not null,
            updated_at text not null,
            payload text not null
        );
        create table knowledge_chunks (
            id text not null,
            knowledge_config_id text not null,
            document_id text not null,
            tenant_id text not null,
            source_name text not null,
            source_uri text not null,
            source_type text not null,
            ordinal integer not null,
            text text not null,
            vector_json text not null,
            dense_vector_json text not null,
            acl_group_ids text not null,
            updated_at text not null,
            payload text not null
        );
        """
    )

    with pytest.raises(KnowledgeImportStateError, match="unique id authority key"):
        _coordinate(store, documents, chunks)

    assert store.active_import_receipt() is None
    assert not store._connection.in_transaction  # noqa: SLF001 - rollback proof


def test_invalid_huge_dense_number_rolls_back_and_releases_transaction() -> None:
    store = LocalVectorStore(":memory:")
    documents, chunks = _payload()
    store.upsert_sources(documents[CONFIG_ID], chunks[CONFIG_ID])
    store._connection.execute(  # noqa: SLF001 - invalid vector simulation
        "update knowledge_chunks set dense_vector_json = ? where id = ?",
        (json.dumps([10**400]), chunks[CONFIG_ID][0].id),
    )
    store._connection.commit()  # noqa: SLF001 - invalid vector simulation

    with pytest.raises(KnowledgeImportStateError, match="invalid dense vector"):
        _coordinate(store, documents, chunks)

    assert not store._connection.in_transaction  # noqa: SLF001 - rollback proof
    assert (
        get_active_knowledge_import_receipt(
            store._connection  # noqa: SLF001 - receipt integration boundary
        )
        is None
    )


def test_semantic_digest_matches_identity_importer_and_is_strict_about_order() -> None:
    first_document = _document(chunk_count=2)
    first_chunk = _chunk(first_document)
    second_chunk = _chunk(
        first_document,
        "chunk-second",
        text="The second ordered payload.",
        ordinal=1,
    )
    documents, chunks = _payload(
        documents=[first_document],
        chunks=[first_chunk, second_chunk],
    )
    identity_payload = import_identity_config._knowledge_payload(  # noqa: SLF001
        {CONFIG_ID: tuple(documents[CONFIG_ID])},
        {CONFIG_ID: tuple(chunks[CONFIG_ID])},
    )
    expected = import_identity_config._sha256_json(identity_payload)  # noqa: SLF001

    assert knowledge_semantic_digest(documents, chunks) == expected
    assert knowledge_semantic_digest(documents, chunks) != knowledge_semantic_digest(
        documents,
        {CONFIG_ID: list(reversed(chunks[CONFIG_ID]))},
    )

    invalid_chunk = first_chunk.model_copy(update={"score": math.nan})
    with pytest.raises(KnowledgeImportStateError, match="strict JSON"):
        knowledge_semantic_digest(documents, {CONFIG_ID: [invalid_chunk]})
