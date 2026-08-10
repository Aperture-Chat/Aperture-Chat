from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import ValidationError

from app.core.sparse_vectors import sparse_text_vector
from app.models.schemas import KnowledgeChunk, KnowledgeDocument


SOURCE_STATE_VERSION = 4
TARGET_STATE_VERSION = 5
SEMANTIC_FORMAT = "aperture-knowledge-model-v1"
SPARSE_VECTOR_FORMAT = "aperture-sparse-vector-v1"

_ACTIVE_AUTHORITY = "knowledge"
_RECEIPT_TABLE = "knowledge_state_imports"
_ACTIVE_TABLE = "knowledge_state_active"


class KnowledgeImportStateError(RuntimeError):
    """Raised when the vector-store cutover cannot be proven safe."""


class KnowledgeImportOutcome(StrEnum):
    IMPORTED = "imported"
    ADOPTED = "adopted"
    ALREADY_APPLIED = "already_applied"


@dataclass(frozen=True, slots=True)
class KnowledgeStateImportReceipt:
    source_digest: str
    source_version: int
    target_version: int
    semantic_digest: str
    semantic_format: str
    sparse_vector_format: str
    document_count: int
    chunk_count: int
    completed_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class KnowledgeStateImportResult:
    outcome: KnowledgeImportOutcome
    receipt: KnowledgeStateImportReceipt


@dataclass(frozen=True, slots=True)
class _ValidatedKnowledgePayload:
    documents: dict[str, tuple[KnowledgeDocument, ...]]
    chunks: dict[str, tuple[KnowledgeChunk, ...]]
    semantic_digest: str
    document_count: int
    chunk_count: int


def knowledge_semantic_digest(
    documents: Mapping[str, Sequence[KnowledgeDocument]],
    chunks: Mapping[str, Sequence[KnowledgeChunk]],
) -> str:
    """Return the strict v4 knowledge digest used by the A7 identity importer.

    Configuration keys are sorted, but record order inside each configuration
    is significant. Dense and sparse vectors are derived SQLite state and are
    intentionally absent from this digest.
    """

    return _validate_payload(documents, chunks).semantic_digest


def coordinate_knowledge_state_import(
    connection: sqlite3.Connection,
    *,
    source_digest: str,
    expected_semantic_digest: str,
    documents: Mapping[str, Sequence[KnowledgeDocument]],
    chunks: Mapping[str, Sequence[KnowledgeChunk]],
    completed_at: datetime | None = None,
) -> KnowledgeStateImportResult:
    """Import or adopt v4 knowledge into the vector database exactly once.

    The caller must hold the vector store's application-level connection lock.
    The connection must be idle because this coordinator owns a
    ``BEGIN IMMEDIATE`` transaction. Once an active matching receipt exists,
    this function never compares or rewrites live vector rows: SQLite is then
    the sole authority and legitimate post-cutover changes must survive stale
    v4 JSON on every later startup.
    """

    _require_sha256(source_digest, "source")
    _require_sha256(expected_semantic_digest, "knowledge semantic")
    payload = _validate_payload(documents, chunks)
    if payload.semantic_digest != expected_semantic_digest:
        raise KnowledgeImportStateError(
            "The validated knowledge payload does not match its identity-import digest."
        )
    if not isinstance(connection, sqlite3.Connection):
        raise KnowledgeImportStateError("A sqlite3 connection is required for knowledge cutover.")
    if connection.in_transaction:
        raise KnowledgeImportStateError("Knowledge cutover requires an idle SQLite connection.")

    completed_at_value = _utc_timestamp(completed_at)
    transaction_started = False
    try:
        connection.execute("begin immediate")
        transaction_started = True
        _validate_vector_schema(connection)
        _ensure_receipt_schema(connection)
        active = _read_active_receipt(connection)
        if active is not None:
            _assert_receipt_matches_payload(
                active,
                source_digest=source_digest,
                payload=payload,
            )
            connection.commit()
            return KnowledgeStateImportResult(
                outcome=KnowledgeImportOutcome.ALREADY_APPLIED,
                receipt=active,
            )

        document_count = int(
            connection.execute("select count(*) from knowledge_documents").fetchone()[0]
        )
        chunk_count = int(connection.execute("select count(*) from knowledge_chunks").fetchone()[0])
        if document_count == 0 and chunk_count == 0:
            _insert_payload(connection, payload)
            outcome = KnowledgeImportOutcome.IMPORTED
        else:
            _assert_existing_payload_matches(connection, payload)
            outcome = KnowledgeImportOutcome.ADOPTED

        receipt = KnowledgeStateImportReceipt(
            source_digest=source_digest,
            source_version=SOURCE_STATE_VERSION,
            target_version=TARGET_STATE_VERSION,
            semantic_digest=payload.semantic_digest,
            semantic_format=SEMANTIC_FORMAT,
            sparse_vector_format=SPARSE_VECTOR_FORMAT,
            document_count=payload.document_count,
            chunk_count=payload.chunk_count,
            completed_at=completed_at_value,
        )
        _insert_receipt_and_pointer(connection, receipt)
        connection.commit()
        return KnowledgeStateImportResult(outcome=outcome, receipt=receipt)
    except KnowledgeImportStateError:
        if transaction_started and connection.in_transaction:
            connection.rollback()
        raise
    except Exception as exc:
        if transaction_started and connection.in_transaction:
            connection.rollback()
        raise KnowledgeImportStateError("Knowledge cutover transaction failed.") from exc
    except BaseException:
        if transaction_started and connection.in_transaction:
            connection.rollback()
        raise


def get_active_knowledge_import_receipt(
    connection: sqlite3.Connection,
) -> KnowledgeStateImportReceipt | None:
    """Read the active receipt without creating schema or changing state.

    A missing pair of receipt tables means cutover has not happened. A partial
    schema, orphaned pointer, or malformed receipt is treated as corruption and
    fails closed.
    """

    receipt_exists = _table_exists(connection, _RECEIPT_TABLE)
    active_exists = _table_exists(connection, _ACTIVE_TABLE)
    if not receipt_exists and not active_exists:
        return None
    if receipt_exists != active_exists:
        raise KnowledgeImportStateError("Knowledge import receipt schema is incomplete.")
    _validate_receipt_schema(connection)
    return _read_active_receipt(connection)


def _validate_payload(
    documents: Mapping[str, Sequence[KnowledgeDocument]],
    chunks: Mapping[str, Sequence[KnowledgeChunk]],
) -> _ValidatedKnowledgePayload:
    normalized_documents = _normalize_groups(documents, KnowledgeDocument, "document")
    normalized_chunks = _normalize_groups(chunks, KnowledgeChunk, "chunk")

    documents_by_id: dict[str, KnowledgeDocument] = {}
    for config_id, records in normalized_documents.items():
        for document in records:
            if document.knowledge_config_id != config_id:
                raise KnowledgeImportStateError(
                    f"Knowledge document {document.id!r} is in the wrong configuration group."
                )
            if document.id in documents_by_id:
                raise KnowledgeImportStateError(
                    f"Knowledge document id {document.id!r} is duplicated."
                )
            documents_by_id[document.id] = document

    chunk_ids: set[str] = set()
    for config_id, records in normalized_chunks.items():
        for chunk in records:
            if chunk.knowledge_config_id != config_id:
                raise KnowledgeImportStateError(
                    f"Knowledge chunk {chunk.id!r} is in the wrong configuration group."
                )
            if chunk.id in chunk_ids:
                raise KnowledgeImportStateError(f"Knowledge chunk id {chunk.id!r} is duplicated.")
            chunk_ids.add(chunk.id)
            document = documents_by_id.get(chunk.document_id)
            if (
                document is None
                or document.knowledge_config_id != config_id
                or document.tenant_id != chunk.tenant_id
            ):
                raise KnowledgeImportStateError(
                    f"Knowledge chunk {chunk.id!r} has an unknown or cross-tenant document."
                )

    config_ids = sorted(set(normalized_documents) | set(normalized_chunks))
    semantic_payload = {
        "documents": {
            config_id: [
                record.model_dump(mode="json") for record in normalized_documents.get(config_id, ())
            ]
            for config_id in config_ids
        },
        "chunks": {
            config_id: [
                record.model_dump(mode="json") for record in normalized_chunks.get(config_id, ())
            ]
            for config_id in config_ids
        },
    }
    digest = hashlib.sha256(_canonical_json(semantic_payload).encode("utf-8")).hexdigest()
    return _ValidatedKnowledgePayload(
        documents=normalized_documents,
        chunks=normalized_chunks,
        semantic_digest=digest,
        document_count=sum(len(records) for records in normalized_documents.values()),
        chunk_count=sum(len(records) for records in normalized_chunks.values()),
    )


def _normalize_groups(
    groups: Mapping[str, Sequence[Any]],
    model_type: type[KnowledgeDocument] | type[KnowledgeChunk],
    label: str,
) -> dict[str, tuple[Any, ...]]:
    if not isinstance(groups, Mapping):
        raise KnowledgeImportStateError(f"Knowledge {label} groups must be an object.")
    normalized: dict[str, tuple[Any, ...]] = {}
    for config_id, records in groups.items():
        if not isinstance(config_id, str) or not config_id:
            raise KnowledgeImportStateError(
                f"Knowledge {label} groups require non-empty configuration ids."
            )
        if not isinstance(records, Sequence) or isinstance(records, (str, bytes, bytearray)):
            raise KnowledgeImportStateError(
                f"Knowledge {label} group {config_id!r} must be a sequence."
            )
        cloned: list[Any] = []
        for record in records:
            if not isinstance(record, model_type):
                raise KnowledgeImportStateError(
                    f"Knowledge {label} group {config_id!r} contains an invalid record."
                )
            record_id = getattr(record, "id", None)
            if not isinstance(record_id, str) or not record_id:
                raise KnowledgeImportStateError(f"Knowledge {label} ids must be non-empty.")
            cloned.append(record.model_copy(deep=True))
        normalized[config_id] = tuple(cloned)
    return normalized


def _validate_vector_schema(connection: sqlite3.Connection) -> None:
    required: dict[str, dict[str, str]] = {
        "knowledge_documents": {
            "id": "text",
            "knowledge_config_id": "text",
            "tenant_id": "text",
            "source_name": "text",
            "source_uri": "text",
            "source_type": "text",
            "updated_at": "text",
            "payload": "text",
        },
        "knowledge_chunks": {
            "id": "text",
            "knowledge_config_id": "text",
            "document_id": "text",
            "tenant_id": "text",
            "source_name": "text",
            "source_uri": "text",
            "source_type": "text",
            "ordinal": "integer",
            "text": "text",
            "vector_json": "text",
            "dense_vector_json": "text",
            "acl_group_ids": "text",
            "updated_at": "text",
            "payload": "text",
        },
    }
    for table_name, required_columns in required.items():
        if not _table_exists(connection, table_name):
            raise KnowledgeImportStateError(
                f"Vector database is missing required table {table_name!r}."
            )
        actual_columns = {
            str(row[1]): {
                "type": str(row[2]).casefold(),
                "not_null": int(row[3]),
                "primary_key": int(row[5]),
            }
            for row in connection.execute(f"pragma table_info({table_name})")
        }
        missing = sorted(set(required_columns).difference(actual_columns))
        if missing:
            raise KnowledgeImportStateError(
                f"Vector table {table_name!r} is missing required columns."
            )
        for column_name, expected_type in required_columns.items():
            column = actual_columns[column_name]
            if column["type"] != expected_type:
                raise KnowledgeImportStateError(
                    f"Vector table {table_name!r} has incompatible column types."
                )
            if column_name != "id" and column["not_null"] != 1:
                raise KnowledgeImportStateError(
                    f"Vector table {table_name!r} has nullable authority columns."
                )
        if (
            actual_columns["id"]["primary_key"] != 1
            and not _has_unique_index(connection, table_name, ("id",))
        ):
            raise KnowledgeImportStateError(
                f"Vector table {table_name!r} requires a unique id authority key."
            )


def _ensure_receipt_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        f"""
        create table if not exists {_RECEIPT_TABLE} (
            source_digest text primary key,
            source_version integer not null check (source_version = {SOURCE_STATE_VERSION}),
            target_version integer not null check (target_version = {TARGET_STATE_VERSION}),
            semantic_digest text not null check (length(semantic_digest) = 64),
            semantic_format text not null check (semantic_format = '{SEMANTIC_FORMAT}'),
            sparse_vector_format text not null
                check (sparse_vector_format = '{SPARSE_VECTOR_FORMAT}'),
            document_count integer not null check (document_count >= 0),
            chunk_count integer not null check (chunk_count >= 0),
            completed_at text not null,
            check (length(source_digest) = 64)
        )
        """
    )
    connection.execute(
        f"""
        create table if not exists {_ACTIVE_TABLE} (
            authority text primary key check (authority = '{_ACTIVE_AUTHORITY}'),
            source_digest text not null unique,
            activated_at text not null,
            foreign key (source_digest)
                references {_RECEIPT_TABLE}(source_digest) on delete restrict
        )
        """
    )
    _validate_receipt_schema(connection)


def _validate_receipt_schema(connection: sqlite3.Connection) -> None:
    expected_types = {
        _RECEIPT_TABLE: {
            "source_digest": "text",
            "source_version": "integer",
            "target_version": "integer",
            "semantic_digest": "text",
            "semantic_format": "text",
            "sparse_vector_format": "text",
            "document_count": "integer",
            "chunk_count": "integer",
            "completed_at": "text",
        },
        _ACTIVE_TABLE: {
            "authority": "text",
            "source_digest": "text",
            "activated_at": "text",
        },
    }
    primary_keys = {
        _RECEIPT_TABLE: "source_digest",
        _ACTIVE_TABLE: "authority",
    }
    for table_name, columns in expected_types.items():
        table_info = {
            str(row[1]): {
                "type": str(row[2]).lower(),
                "not_null": int(row[3]),
                "primary_key": int(row[5]),
            }
            for row in connection.execute(f"pragma table_info({table_name})")
        }
        if not set(columns).issubset(table_info):
            raise KnowledgeImportStateError("Knowledge import receipt schema is incompatible.")
        for column_name, expected_type in columns.items():
            column = table_info[column_name]
            if column["type"] != expected_type:
                raise KnowledgeImportStateError("Knowledge import receipt schema is incompatible.")
            if column_name != primary_keys[table_name] and column["not_null"] != 1:
                raise KnowledgeImportStateError("Knowledge import receipt schema is incompatible.")
        if table_info[primary_keys[table_name]]["primary_key"] != 1:
            raise KnowledgeImportStateError("Knowledge import receipt schema is incompatible.")

    if not _has_unique_index(connection, _ACTIVE_TABLE, ("source_digest",)):
        raise KnowledgeImportStateError("Knowledge import receipt schema is incompatible.")
    foreign_keys = connection.execute(f"pragma foreign_key_list({_ACTIVE_TABLE})").fetchall()
    if not any(
        str(row[2]) == _RECEIPT_TABLE
        and str(row[3]) == "source_digest"
        and str(row[4]) == "source_digest"
        and str(row[6]).upper() in {"NO ACTION", "RESTRICT"}
        for row in foreign_keys
    ):
        raise KnowledgeImportStateError("Knowledge import receipt schema is incompatible.")

    _require_schema_checks(
        connection,
        _RECEIPT_TABLE,
        (
            rf"source_version\s*=\s*{SOURCE_STATE_VERSION}",
            rf"target_version\s*=\s*{TARGET_STATE_VERSION}",
            r"length\s*\(\s*source_digest\s*\)\s*=\s*64",
            r"length\s*\(\s*semantic_digest\s*\)\s*=\s*64",
            rf"semantic_format\s*=\s*'{re.escape(SEMANTIC_FORMAT)}'",
            rf"sparse_vector_format\s*=\s*'{re.escape(SPARSE_VECTOR_FORMAT)}'",
            r"document_count\s*>=\s*0",
            r"chunk_count\s*>=\s*0",
        ),
    )
    _require_schema_checks(
        connection,
        _ACTIVE_TABLE,
        (rf"authority\s*=\s*'{_ACTIVE_AUTHORITY}'",),
    )


def _has_unique_index(
    connection: sqlite3.Connection,
    table_name: str,
    columns: tuple[str, ...],
) -> bool:
    for index_row in connection.execute(f"pragma index_list({table_name})"):
        if int(index_row[2]) != 1:
            continue
        indexed_columns = tuple(
            str(column_row[2])
            for column_row in connection.execute(f"pragma index_info({index_row[1]})")
        )
        if indexed_columns == columns:
            return True
    return False


def _require_schema_checks(
    connection: sqlite3.Connection,
    table_name: str,
    patterns: tuple[str, ...],
) -> None:
    row = connection.execute(
        "select sql from sqlite_master where type = 'table' and name = ?",
        (table_name,),
    ).fetchone()
    if row is None or not isinstance(row[0], str):
        raise KnowledgeImportStateError("Knowledge import receipt schema is incompatible.")
    normalized_sql = row[0].lower().replace('"', "").replace("`", "")
    if any(re.search(pattern, normalized_sql) is None for pattern in patterns):
        raise KnowledgeImportStateError("Knowledge import receipt schema is incompatible.")


def _read_active_receipt(
    connection: sqlite3.Connection,
) -> KnowledgeStateImportReceipt | None:
    active_rows = connection.execute(
        f"select authority, source_digest, activated_at from {_ACTIVE_TABLE}"
    ).fetchall()
    if not active_rows:
        receipt_count = int(
            connection.execute(f"select count(*) from {_RECEIPT_TABLE}").fetchone()[0]
        )
        if receipt_count:
            raise KnowledgeImportStateError(
                "Knowledge import receipts exist without an active authority pointer."
            )
        return None
    if len(active_rows) != 1:
        raise KnowledgeImportStateError("Knowledge authority pointer is ambiguous.")
    receipt_count = int(connection.execute(f"select count(*) from {_RECEIPT_TABLE}").fetchone()[0])
    if receipt_count != 1:
        raise KnowledgeImportStateError(
            "Knowledge authority pointer has conflicting import receipts."
        )
    authority, source_digest, activated_at = active_rows[0]
    if authority != _ACTIVE_AUTHORITY:
        raise KnowledgeImportStateError("Knowledge authority pointer is invalid.")
    _require_sha256(source_digest, "active source")
    _require_utc_timestamp(activated_at, "authority activation")

    rows = connection.execute(
        f"""
        select source_digest, source_version, target_version, semantic_digest,
               semantic_format, sparse_vector_format, document_count, chunk_count,
               completed_at
        from {_RECEIPT_TABLE}
        where source_digest = ?
        """,
        (source_digest,),
    ).fetchall()
    if len(rows) != 1:
        raise KnowledgeImportStateError(
            "Knowledge authority pointer does not resolve to one receipt."
        )
    row = rows[0]
    receipt = KnowledgeStateImportReceipt(
        source_digest=str(row[0]),
        source_version=_strict_nonnegative_integer(row[1], "source version"),
        target_version=_strict_nonnegative_integer(row[2], "target version"),
        semantic_digest=str(row[3]),
        semantic_format=str(row[4]),
        sparse_vector_format=str(row[5]),
        document_count=_strict_nonnegative_integer(row[6], "document count"),
        chunk_count=_strict_nonnegative_integer(row[7], "chunk count"),
        completed_at=str(row[8]),
    )
    _require_sha256(receipt.source_digest, "receipt source")
    _require_sha256(receipt.semantic_digest, "receipt semantic")
    _require_utc_timestamp(receipt.completed_at, "receipt completion")
    if (
        receipt.source_version != SOURCE_STATE_VERSION
        or receipt.target_version != TARGET_STATE_VERSION
        or receipt.semantic_format != SEMANTIC_FORMAT
        or receipt.sparse_vector_format != SPARSE_VECTOR_FORMAT
        or activated_at != receipt.completed_at
    ):
        raise KnowledgeImportStateError("Active knowledge import receipt is incompatible.")
    return receipt


def _assert_receipt_matches_payload(
    receipt: KnowledgeStateImportReceipt,
    *,
    source_digest: str,
    payload: _ValidatedKnowledgePayload,
) -> None:
    if (
        receipt.source_digest != source_digest
        or receipt.semantic_digest != payload.semantic_digest
        or receipt.document_count != payload.document_count
        or receipt.chunk_count != payload.chunk_count
    ):
        raise KnowledgeImportStateError("A different knowledge import receipt is already active.")


def _insert_payload(
    connection: sqlite3.Connection,
    payload: _ValidatedKnowledgePayload,
) -> None:
    document_rows = []
    for config_id in sorted(payload.documents):
        for document in payload.documents[config_id]:
            document_rows.append(
                (
                    document.id,
                    document.knowledge_config_id,
                    document.tenant_id,
                    document.name,
                    document.source_uri,
                    document.source_type,
                    document.updated_at,
                    document.model_dump_json(),
                )
            )
    connection.executemany(
        """
        insert into knowledge_documents (
            id, knowledge_config_id, tenant_id, source_name, source_uri,
            source_type, updated_at, payload
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        document_rows,
    )

    chunk_rows = []
    for config_id in sorted(payload.chunks):
        for chunk in payload.chunks[config_id]:
            sparse_vector = sparse_text_vector(f"{chunk.source_name} {chunk.text}")
            chunk_rows.append(
                (
                    chunk.id,
                    chunk.knowledge_config_id,
                    chunk.document_id,
                    chunk.tenant_id,
                    chunk.source_name,
                    chunk.source_uri,
                    chunk.source_type,
                    chunk.ordinal,
                    chunk.text,
                    _canonical_json(sparse_vector),
                    "[]",
                    _canonical_json(chunk.acl_group_ids),
                    chunk.updated_at,
                    chunk.model_dump_json(),
                )
            )
    connection.executemany(
        """
        insert into knowledge_chunks (
            id, knowledge_config_id, document_id, tenant_id, source_name,
            source_uri, source_type, ordinal, text, vector_json,
            dense_vector_json, acl_group_ids, updated_at, payload
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        chunk_rows,
    )


def _assert_existing_payload_matches(
    connection: sqlite3.Connection,
    payload: _ValidatedKnowledgePayload,
) -> None:
    document_rows = _rows_by_config(
        connection,
        """
        select id, knowledge_config_id, tenant_id, source_name, source_uri,
               source_type, updated_at, payload
        from knowledge_documents
        order by rowid
        """,
    )
    chunk_rows = _rows_by_config(
        connection,
        """
        select id, knowledge_config_id, document_id, tenant_id, source_name,
               source_uri, source_type, ordinal, text, vector_json,
               dense_vector_json, acl_group_ids, updated_at, payload
        from knowledge_chunks
        order by rowid
        """,
    )

    expected_config_ids = set(payload.documents) | set(payload.chunks)
    if set(document_rows).difference(expected_config_ids) or set(chunk_rows).difference(
        expected_config_ids
    ):
        raise KnowledgeImportStateError("Vector database contains extra knowledge configurations.")

    for config_id in sorted(expected_config_ids):
        expected_documents = payload.documents.get(config_id, ())
        existing_documents = document_rows.get(config_id, [])
        if len(existing_documents) != len(expected_documents):
            raise KnowledgeImportStateError(
                f"Vector database document count differs for configuration {config_id!r}."
            )
        for row, document in zip(existing_documents, expected_documents, strict=True):
            _assert_document_row_matches(row, document)

        expected_chunks = payload.chunks.get(config_id, ())
        existing_chunks = chunk_rows.get(config_id, [])
        if len(existing_chunks) != len(expected_chunks):
            raise KnowledgeImportStateError(
                f"Vector database chunk count differs for configuration {config_id!r}."
            )
        for row, chunk in zip(existing_chunks, expected_chunks, strict=True):
            _assert_chunk_row_matches(row, chunk)


def _rows_by_config(
    connection: sqlite3.Connection,
    query: str,
) -> dict[str, list[dict[str, Any]]]:
    cursor = connection.execute(query)
    columns = [str(column[0]) for column in cursor.description or ()]
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for values in cursor.fetchall():
        row = dict(zip(columns, values, strict=True))
        config_id = row.get("knowledge_config_id")
        if not isinstance(config_id, str) or not config_id:
            raise KnowledgeImportStateError("Vector database contains an invalid configuration id.")
        grouped[config_id].append(row)
    return dict(grouped)


def _assert_document_row_matches(
    row: Mapping[str, Any],
    expected: KnowledgeDocument,
) -> None:
    scalar_values = {
        "id": expected.id,
        "knowledge_config_id": expected.knowledge_config_id,
        "tenant_id": expected.tenant_id,
        "source_name": expected.name,
        "source_uri": expected.source_uri,
        "source_type": expected.source_type,
        "updated_at": expected.updated_at,
    }
    if any(row.get(key) != value for key, value in scalar_values.items()):
        raise KnowledgeImportStateError(
            f"Vector document {expected.id!r} has mismatched indexed fields."
        )
    actual = _parse_model_payload(row.get("payload"), KnowledgeDocument, "document")
    if actual.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise KnowledgeImportStateError(
            f"Vector document {expected.id!r} has mismatched semantic payload."
        )


def _assert_chunk_row_matches(row: Mapping[str, Any], expected: KnowledgeChunk) -> None:
    scalar_values = {
        "id": expected.id,
        "knowledge_config_id": expected.knowledge_config_id,
        "document_id": expected.document_id,
        "tenant_id": expected.tenant_id,
        "source_name": expected.source_name,
        "source_uri": expected.source_uri,
        "source_type": expected.source_type,
        "ordinal": expected.ordinal,
        "text": expected.text,
        "updated_at": expected.updated_at,
    }
    if any(row.get(key) != value for key, value in scalar_values.items()):
        raise KnowledgeImportStateError(
            f"Vector chunk {expected.id!r} has mismatched indexed fields."
        )
    actual = _parse_model_payload(row.get("payload"), KnowledgeChunk, "chunk")
    if actual.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise KnowledgeImportStateError(
            f"Vector chunk {expected.id!r} has mismatched semantic payload."
        )

    sparse_vector = _strict_json_loads(row.get("vector_json"), "sparse vector")
    expected_sparse_vector = sparse_text_vector(f"{expected.source_name} {expected.text}")
    if sparse_vector != expected_sparse_vector:
        raise KnowledgeImportStateError(
            f"Vector chunk {expected.id!r} has a mismatched sparse vector."
        )
    acl_group_ids = _strict_json_loads(row.get("acl_group_ids"), "ACL group list")
    if acl_group_ids != expected.acl_group_ids:
        raise KnowledgeImportStateError(f"Vector chunk {expected.id!r} has mismatched ACL fields.")
    _validate_dense_vector(row.get("dense_vector_json"), expected.id)


def _parse_model_payload(
    value: Any,
    model_type: type[KnowledgeDocument] | type[KnowledgeChunk],
    label: str,
) -> KnowledgeDocument | KnowledgeChunk:
    raw = _strict_json_loads(value, f"{label} payload")
    if not isinstance(raw, dict):
        raise KnowledgeImportStateError(f"Vector {label} payload must be an object.")
    try:
        return model_type.model_validate(raw, strict=True)
    except ValidationError as exc:
        raise KnowledgeImportStateError(f"Vector {label} payload is invalid.") from exc


def _validate_dense_vector(value: Any, chunk_id: str) -> None:
    vector = _strict_json_loads(value, "dense vector")
    if not isinstance(vector, list) or any(not _is_finite_dense_number(item) for item in vector):
        raise KnowledgeImportStateError(f"Vector chunk {chunk_id!r} has an invalid dense vector.")


def _is_finite_dense_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _insert_receipt_and_pointer(
    connection: sqlite3.Connection,
    receipt: KnowledgeStateImportReceipt,
) -> None:
    connection.execute(
        f"""
        insert into {_RECEIPT_TABLE} (
            source_digest, source_version, target_version, semantic_digest,
            semantic_format, sparse_vector_format, document_count, chunk_count,
            completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            receipt.source_digest,
            receipt.source_version,
            receipt.target_version,
            receipt.semantic_digest,
            receipt.semantic_format,
            receipt.sparse_vector_format,
            receipt.document_count,
            receipt.chunk_count,
            receipt.completed_at,
        ),
    )
    connection.execute(
        f"""
        insert into {_ACTIVE_TABLE} (authority, source_digest, activated_at)
        values (?, ?, ?)
        """,
        (_ACTIVE_AUTHORITY, receipt.source_digest, receipt.completed_at),
    )


def _table_exists(connection: sqlite3.Connection, table_name: str) -> bool:
    return (
        connection.execute(
            "select 1 from sqlite_master where type = 'table' and name = ?",
            (table_name,),
        ).fetchone()
        is not None
    )


def _strict_json_loads(value: Any, label: str) -> Any:
    if not isinstance(value, str):
        raise KnowledgeImportStateError(f"Vector {label} is not JSON text.")

    def reject_constant(constant: str) -> None:
        raise ValueError(f"Invalid JSON constant: {constant}")

    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("Duplicate JSON object key")
            result[key] = item
        return result

    try:
        return json.loads(
            value,
            parse_constant=reject_constant,
            object_pairs_hook=reject_duplicate_keys,
        )
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise KnowledgeImportStateError(f"Vector {label} is not strict JSON.") from exc


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise KnowledgeImportStateError("Knowledge payload is not strict JSON.") from exc


def _require_sha256(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise KnowledgeImportStateError(f"Knowledge {label} digest is invalid.")
    return value


def _utc_timestamp(value: datetime | None) -> str:
    timestamp = value or datetime.now(UTC)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    else:
        timestamp = timestamp.astimezone(UTC)
    return timestamp.isoformat()


def _require_utc_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise KnowledgeImportStateError(f"Knowledge {label} timestamp is invalid.")
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise KnowledgeImportStateError(f"Knowledge {label} timestamp is invalid.") from exc
    if timestamp.tzinfo is None or timestamp.utcoffset() != UTC.utcoffset(timestamp):
        raise KnowledgeImportStateError(f"Knowledge {label} timestamp must be UTC.")
    return timestamp


def _strict_nonnegative_integer(value: Any, label: str) -> int:
    if type(value) is not int or value < 0:
        raise KnowledgeImportStateError(f"Knowledge receipt {label} is invalid.")
    return value
