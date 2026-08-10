from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from threading import RLock

from app.core.sparse_vectors import sparse_text_vector
from app.db.knowledge_import_state import (
    KnowledgeStateImportReceipt,
    KnowledgeStateImportResult,
    coordinate_knowledge_state_import,
    get_active_knowledge_import_receipt,
)
from app.models.schemas import KnowledgeChunk, KnowledgeDocument, Role, User


logger = logging.getLogger(__name__)


class LocalVectorStore:
    """Durable hybrid sparse+dense index for local knowledge retrieval."""

    def __init__(
        self,
        path: str,
        *,
        dense_embeddings_enabled: bool = False,
        embedding_model: str = "BAAI/bge-small-en-v1.5",
        embedding_cache_dir: str | None = None,
        embedding_threads: int = 2,
        dense_embedder: object | None = None,
    ) -> None:
        self.path = path
        if path != ":memory:":
            Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._dense_embeddings_enabled = dense_embeddings_enabled
        self._embedding_model_name = embedding_model
        self._embedding_cache_dir = embedding_cache_dir
        self._embedding_threads = embedding_threads
        self._dense_embedder = dense_embedder
        self._dense_embedding_failed = False
        self._init_schema()

    def bootstrap_config(
        self,
        config_id: str,
        documents: list[KnowledgeDocument],
        chunks: list[KnowledgeChunk],
    ) -> None:
        with self._lock:
            existing = self._connection.execute(
                "select 1 from knowledge_documents where knowledge_config_id = ? limit 1",
                (config_id,),
            ).fetchone()
            if existing is not None:
                return
            self._upsert_documents(documents)
            self._upsert_chunks(chunks)
            self._connection.commit()

    def replace_config(
        self,
        config_id: str,
        documents: list[KnowledgeDocument],
        chunks: list[KnowledgeChunk],
    ) -> None:
        with self._lock:
            self._connection.execute(
                "delete from knowledge_chunks where knowledge_config_id = ?", (config_id,)
            )
            self._connection.execute(
                "delete from knowledge_documents where knowledge_config_id = ?",
                (config_id,),
            )
            self._upsert_documents(documents)
            self._upsert_chunks(chunks)
            self._connection.commit()

    def delete_config(self, config_id: str) -> None:
        with self._lock:
            self._connection.execute(
                "delete from knowledge_chunks where knowledge_config_id = ?", (config_id,)
            )
            self._connection.execute(
                "delete from knowledge_documents where knowledge_config_id = ?",
                (config_id,),
            )
            self._connection.commit()

    def delete_tenant(self, tenant_id: str) -> int:
        """Idempotently remove every vector row owned by one retired tenant id."""

        with self._lock:
            removed_chunks = self._connection.execute(
                "delete from knowledge_chunks where tenant_id = ?", (tenant_id,)
            ).rowcount
            removed_documents = self._connection.execute(
                "delete from knowledge_documents where tenant_id = ?", (tenant_id,)
            ).rowcount
            remaining = self._connection.execute(
                "select count(*) from knowledge_documents where tenant_id = ?",
                (tenant_id,),
            ).fetchone()[0] + self._connection.execute(
                "select count(*) from knowledge_chunks where tenant_id = ?",
                (tenant_id,),
            ).fetchone()[0]
            if remaining:
                self._connection.rollback()
                raise RuntimeError("Tenant vector cleanup did not reach an empty scope.")
            self._connection.commit()
            return int(removed_chunks or 0) + int(removed_documents or 0)

    def clear_all(self) -> None:
        with self._lock:
            self._connection.execute("delete from knowledge_chunks")
            self._connection.execute("delete from knowledge_documents")
            self._connection.commit()

    def delete_document(self, config_id: str, document_id: str) -> bool:
        with self._lock:
            document = self._connection.execute(
                """
                select 1
                from knowledge_documents
                where knowledge_config_id = ? and id = ?
                limit 1
                """,
                (config_id, document_id),
            ).fetchone()
            if document is None:
                return False
            self._connection.execute(
                "delete from knowledge_chunks where knowledge_config_id = ? and document_id = ?",
                (config_id, document_id),
            )
            self._connection.execute(
                "delete from knowledge_documents where knowledge_config_id = ? and id = ?",
                (config_id, document_id),
            )
            self._connection.commit()
            return True

    def upsert_sources(
        self,
        documents: list[KnowledgeDocument],
        chunks: list[KnowledgeChunk],
    ) -> None:
        with self._lock:
            self._upsert_documents(documents)
            self._upsert_chunks(chunks)
            self._connection.commit()

    def backfill_dense_vectors(self) -> None:
        if not self._dense_embeddings_enabled or self._dense_embedding_failed:
            return
        with self._lock:
            rows = self._connection.execute(
                """
                select id, source_name, text
                from knowledge_chunks
                where dense_vector_json is null or dense_vector_json = '' or dense_vector_json = '[]'
                order by rowid
                """
            ).fetchall()
            if not rows:
                return
            vectors = self._embed_passages([f"{row['source_name']} {row['text']}" for row in rows])
            if vectors is None:
                return
            self._connection.executemany(
                "update knowledge_chunks set dense_vector_json = ? where id = ?",
                [
                    (json.dumps(vector, separators=(",", ":")), row["id"])
                    for row, vector in zip(rows, vectors, strict=True)
                ],
            )
            self._connection.commit()

    def import_legacy_knowledge_state(
        self,
        *,
        source_digest: str,
        expected_semantic_digest: str,
        documents: dict[str, tuple[KnowledgeDocument, ...]],
        chunks: dict[str, tuple[KnowledgeChunk, ...]],
    ) -> KnowledgeStateImportResult:
        """Import or adopt a verified v4 payload under the connection lock."""

        with self._lock:
            return coordinate_knowledge_state_import(
                self._connection,
                source_digest=source_digest,
                expected_semantic_digest=expected_semantic_digest,
                documents=documents,
                chunks=chunks,
            )

    def active_import_receipt(self) -> KnowledgeStateImportReceipt | None:
        """Return verified vector authority without creating receipt state."""

        with self._lock:
            return get_active_knowledge_import_receipt(self._connection)

    def knowledge_config_ids(self) -> set[str]:
        """Return every configuration id represented by a document or chunk."""

        with self._lock:
            rows = self._connection.execute(
                """
                select knowledge_config_id from knowledge_documents
                union
                select knowledge_config_id from knowledge_chunks
                """
            ).fetchall()
        return {str(row[0]) for row in rows}

    def documents_for(self, config_id: str) -> list[KnowledgeDocument]:
        with self._lock:
            rows = self._connection.execute(
                """
                select payload
                from knowledge_documents
                where knowledge_config_id = ?
                order by rowid
                """,
                (config_id,),
            ).fetchall()
        return [KnowledgeDocument.model_validate_json(row["payload"]) for row in rows]

    def chunks_for(self, config_id: str) -> list[KnowledgeChunk]:
        with self._lock:
            rows = self._connection.execute(
                """
                select payload
                from knowledge_chunks
                where knowledge_config_id = ?
                order by source_name, ordinal
                """,
                (config_id,),
            ).fetchall()
        return [KnowledgeChunk.model_validate_json(row["payload"]) for row in rows]

    def search(
        self,
        actor: User,
        config_ids: list[str],
        query: str,
        *,
        limit: int,
    ) -> list[KnowledgeChunk]:
        return self._search(actor, config_ids, query, limit=limit, document_id=None)

    def search_document(
        self,
        actor: User,
        config_ids: list[str],
        query: str,
        *,
        document_id: str,
        limit: int,
    ) -> list[KnowledgeChunk]:
        """Search only chunks belonging to one exact indexed document id.

        Ranking and actor visibility are identical to :meth:`search`; the
        document predicate is applied in SQLite before payloads are scored so a
        review cell can never draw context from another document.
        """
        if not document_id:
            return []
        return self._search(
            actor,
            config_ids,
            query,
            limit=limit,
            document_id=document_id,
        )

    def _search(
        self,
        actor: User,
        config_ids: list[str],
        query: str,
        *,
        limit: int,
        document_id: str | None,
    ) -> list[KnowledgeChunk]:
        if not config_ids:
            return []
        query_vector = sparse_text_vector(query)
        dense_query_vector = self._embed_query(query)
        query_terms = set(query_vector)
        placeholders = ", ".join("?" for _ in config_ids)
        document_clause = ""
        parameters: tuple[str, ...] = tuple(config_ids)
        if document_id is not None:
            document_clause = " and document_id = ?"
            parameters = (*parameters, document_id)
        with self._lock:
            rows = self._connection.execute(
                f"""
                select payload, vector_json, dense_vector_json
                from knowledge_chunks
                where knowledge_config_id in ({placeholders})
                {document_clause}
                """,
                parameters,
            ).fetchall()
        candidates: list[KnowledgeChunk] = []
        for row in rows:
            chunk = KnowledgeChunk.model_validate_json(row["payload"])
            if not _chunk_visible_to_actor(actor, chunk):
                continue
            stored_vector = json.loads(row["vector_json"] or "{}")
            stored_dense_vector = json.loads(row["dense_vector_json"] or "[]")
            score = _chunk_score(
                chunk,
                query_terms,
                query,
                query_vector,
                stored_vector,
                dense_query_vector,
                stored_dense_vector,
            )
            candidates.append(chunk.model_copy(update={"score": score}))
        ranked = [chunk for chunk in candidates if chunk.score > 0.1] or candidates
        ranked.sort(key=lambda chunk: (-chunk.score, chunk.source_name.lower(), chunk.ordinal))
        return [chunk.model_copy(deep=True) for chunk in ranked[:limit]]

    def _init_schema(self) -> None:
        with self._lock:
            self._connection.execute(
                """
                create table if not exists knowledge_documents (
                    id text primary key,
                    knowledge_config_id text not null,
                    tenant_id text not null,
                    source_name text not null,
                    source_uri text not null,
                    source_type text not null,
                    updated_at text not null,
                    payload text not null
                )
                """
            )
            self._connection.execute(
                """
                create table if not exists knowledge_chunks (
                    id text primary key,
                    knowledge_config_id text not null,
                    document_id text not null,
                    tenant_id text not null,
                    source_name text not null,
                    source_uri text not null,
                    source_type text not null,
                    ordinal integer not null,
                    text text not null,
                    vector_json text not null,
                    dense_vector_json text not null default '[]',
                    acl_group_ids text not null,
                    updated_at text not null,
                    payload text not null
                )
                """
            )
            chunk_columns = {
                str(row["name"])
                for row in self._connection.execute(
                    "pragma table_info(knowledge_chunks)"
                ).fetchall()
            }
            if "dense_vector_json" not in chunk_columns:
                self._connection.execute(
                    "alter table knowledge_chunks add column dense_vector_json text not null default '[]'"
                )
            self._connection.execute(
                """
                create index if not exists idx_knowledge_documents_config
                on knowledge_documents (knowledge_config_id)
                """
            )
            self._connection.execute(
                """
                create index if not exists idx_knowledge_chunks_config
                on knowledge_chunks (knowledge_config_id)
                """
            )
            self._connection.execute(
                """
                create index if not exists idx_knowledge_chunks_config_document
                on knowledge_chunks (knowledge_config_id, document_id)
                """
            )
            self._connection.commit()

    def _upsert_documents(self, documents: list[KnowledgeDocument]) -> None:
        self._connection.executemany(
            """
            insert into knowledge_documents (
                id, knowledge_config_id, tenant_id, source_name, source_uri, source_type, updated_at, payload
            ) values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
                knowledge_config_id = excluded.knowledge_config_id,
                tenant_id = excluded.tenant_id,
                source_name = excluded.source_name,
                source_uri = excluded.source_uri,
                source_type = excluded.source_type,
                updated_at = excluded.updated_at,
                payload = excluded.payload
            """,
            [
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
                for document in documents
            ],
        )

    def _upsert_chunks(self, chunks: list[KnowledgeChunk]) -> None:
        dense_vectors = self._embed_passages(
            [f"{chunk.source_name} {chunk.text}" for chunk in chunks]
        )
        if dense_vectors is None:
            dense_vectors = [[] for _chunk in chunks]
        self._connection.executemany(
            """
            insert into knowledge_chunks (
                id, knowledge_config_id, document_id, tenant_id, source_name, source_uri,
                source_type, ordinal, text, vector_json, dense_vector_json,
                acl_group_ids, updated_at, payload
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
                knowledge_config_id = excluded.knowledge_config_id,
                document_id = excluded.document_id,
                tenant_id = excluded.tenant_id,
                source_name = excluded.source_name,
                source_uri = excluded.source_uri,
                source_type = excluded.source_type,
                ordinal = excluded.ordinal,
                text = excluded.text,
                vector_json = excluded.vector_json,
                dense_vector_json = excluded.dense_vector_json,
                acl_group_ids = excluded.acl_group_ids,
                updated_at = excluded.updated_at,
                payload = excluded.payload
            """,
            [
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
                    json.dumps(
                        sparse_text_vector(f"{chunk.source_name} {chunk.text}"),
                        sort_keys=True,
                    ),
                    json.dumps(dense_vector, separators=(",", ":")),
                    json.dumps(chunk.acl_group_ids),
                    chunk.updated_at,
                    chunk.model_dump_json(),
                )
                for chunk, dense_vector in zip(chunks, dense_vectors, strict=True)
            ],
        )

    def _embed_passages(self, texts: list[str]) -> list[list[float]] | None:
        if not texts or not self._dense_embeddings_enabled or self._dense_embedding_failed:
            return None
        embedder = self._get_dense_embedder()
        if embedder is None:
            return None
        try:
            vectors = embedder.passage_embed(texts, batch_size=32)
            return [[float(value) for value in vector] for vector in vectors]
        except Exception as error:
            self._disable_dense_embeddings(error)
            return None

    def _embed_query(self, query: str) -> list[float] | None:
        if not query.strip() or not self._dense_embeddings_enabled or self._dense_embedding_failed:
            return None
        embedder = self._get_dense_embedder()
        if embedder is None:
            return None
        try:
            vector = next(iter(embedder.query_embed(query)))
            return [float(value) for value in vector]
        except Exception as error:
            self._disable_dense_embeddings(error)
            return None

    def _get_dense_embedder(self) -> object | None:
        if self._dense_embedder is not None:
            return self._dense_embedder
        try:
            from fastembed import TextEmbedding  # type: ignore[import-not-found]

            self._dense_embedder = TextEmbedding(
                model_name=self._embedding_model_name,
                cache_dir=self._embedding_cache_dir,
                threads=self._embedding_threads,
                local_files_only=True,
            )
        except Exception as error:
            self._disable_dense_embeddings(error)
            return None
        return self._dense_embedder

    def _disable_dense_embeddings(self, error: Exception) -> None:
        self._dense_embedding_failed = True
        logger.warning(
            "Dense knowledge embeddings are unavailable; continuing with sparse retrieval: %s",
            error,
        )


def _chunk_visible_to_actor(actor: User, chunk: KnowledgeChunk) -> bool:
    if actor.role == Role.PLATFORM_OWNER:
        return True
    if actor.tenant_id != chunk.tenant_id:
        return False
    if chunk.acl_group_ids and not set(actor.group_ids).intersection(chunk.acl_group_ids):
        return False
    return True


def _chunk_score(
    chunk: KnowledgeChunk,
    query_terms: set[str],
    query: str,
    query_vector: dict[str, float],
    chunk_vector: dict[str, float],
    dense_query_vector: list[float] | None,
    dense_chunk_vector: list[float],
) -> float:
    searchable = f"{chunk.source_name} {chunk.text}".lower()
    lexical_score = sum(searchable.count(term) for term in query_terms)
    normalized_query = " ".join(query.lower().split())
    exact_score = 4.0 if normalized_query and normalized_query in searchable else 0.0
    sparse_vector_score = _cosine_similarity(query_vector, chunk_vector)
    dense_vector_score = (
        max(0.0, _cosine_similarity(dense_query_vector, dense_chunk_vector))
        if dense_query_vector and dense_chunk_vector
        else 0.0
    )
    score = exact_score + lexical_score + sparse_vector_score + (2.0 * dense_vector_score)
    return score if score > 0 else 0.1


def _cosine_similarity(
    left: dict[str, float] | list[float],
    right: dict[str, float] | list[float],
) -> float:
    if not left or not right:
        return 0.0
    if isinstance(left, dict) and isinstance(right, dict):
        dot_product = sum(weight * right.get(token, 0.0) for token, weight in left.items())
        left_values = left.values()
        right_values = right.values()
    elif isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            return 0.0
        dot_product = sum(left_value * right_value for left_value, right_value in zip(left, right))
        left_values = left
        right_values = right
    else:
        return 0.0
    if dot_product <= 0:
        return 0.0
    left_norm = sum(weight * weight for weight in left_values) ** 0.5
    right_norm = sum(weight * weight for weight in right_values) ** 0.5
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot_product / (left_norm * right_norm)
