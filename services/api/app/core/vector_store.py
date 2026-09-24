from __future__ import annotations

import heapq
import json
import logging
import sqlite3
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from threading import Condition, Lock, RLock, Thread
from typing import Any

from app.core.sparse_vectors import sparse_text_vector
from app.db.knowledge_import_state import (
    KnowledgeStateImportReceipt,
    KnowledgeStateImportResult,
    coordinate_knowledge_state_import,
    get_active_knowledge_import_receipt,
)
from app.models.schemas import KnowledgeChunk, KnowledgeDocument, Role, User

try:  # numpy ships with fastembed; retrieval falls back to pure Python without it.
    import numpy as np
except ImportError:  # pragma: no cover - exercised only in stripped installs
    np = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

# Chunks are embedded in small batches so a chat query waiting on the shared
# embedder is delayed by at most one batch while a large upload indexes.
DENSE_BATCH_SIZE = 32
# Upper bound on chunks held in the parsed search cache across all knowledge
# bases. Larger corpora fall back to streaming rows from SQLite per query.
SEARCH_CACHE_MAX_CHUNKS = 250_000
_EMPTY_DENSE = "[]"
QUERY_EMBED_WAIT_SECONDS = 5.0


@dataclass
class _SearchIndex:
    """Parsed, query-ready view of one knowledge base's chunks."""

    generation: int
    chunks: list[KnowledgeChunk]
    row_by_id: dict[str, int]
    searchable: list[str]
    sparse: list[dict[str, float]]
    sparse_norms: list[float]
    dense: Any  # numpy (n, d) float32 matrix, zero rows where a vector is missing
    dense_norms: Any
    dense_lists: list[list[float]] | None  # pure-Python fallback when numpy is absent


class LocalVectorStore:
    """Durable hybrid sparse+dense index for local knowledge retrieval.

    Sparse vectors are written with every chunk, so new content is searchable
    as soon as it is stored. Dense (semantic) vectors are either computed inline
    or, with ``background_dense=True``, filled in by one worker thread so large
    uploads never hold the request -- or the store lock -- while embedding.
    """

    def __init__(
        self,
        path: str,
        *,
        dense_embeddings_enabled: bool = False,
        embedding_model: str = "BAAI/bge-small-en-v1.5",
        embedding_cache_dir: str | None = None,
        embedding_threads: int = 2,
        dense_embedder: object | None = None,
        background_dense: bool = False,
    ) -> None:
        self.path = path
        if path != ":memory:":
            Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        # The embedder's tokenizer is not safe for concurrent calls, so queries
        # and passage batches take turns on it without holding the store lock.
        self._embed_lock = Lock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._dense_embeddings_enabled = dense_embeddings_enabled
        self._embedding_model_name = embedding_model
        self._embedding_cache_dir = embedding_cache_dir
        self._embedding_threads = embedding_threads
        self._dense_embedder = dense_embedder
        self._dense_embedding_failed = False
        self._background_dense = background_dense and dense_embeddings_enabled
        self._dense_condition = Condition()
        self._dense_requested = False
        self._dense_stopped = False
        self._dense_worker: Thread | None = None
        self._generations: dict[str, int] = {}
        self._search_cache: OrderedDict[str, _SearchIndex] = OrderedDict()
        self._init_schema()

    # ------------------------------------------------------------------ writes

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
        rows = self._chunk_rows(chunks, self._inline_dense_vectors(chunks))
        with self._lock:
            existing = self._connection.execute(
                "select 1 from knowledge_documents where knowledge_config_id = ? limit 1",
                (config_id,),
            ).fetchone()
            if existing is not None:
                return
            self._upsert_documents(documents)
            self._write_chunk_rows(rows)
            self._connection.commit()
            self._bump(config_id)
        self._request_dense_backfill()

    def replace_config(
        self,
        config_id: str,
        documents: list[KnowledgeDocument],
        chunks: list[KnowledgeChunk],
    ) -> None:
        """Replace a knowledge base's rows, reusing vectors for unchanged text.

        Re-syncing a source used to re-embed every chunk even when nothing
        changed. Dense vectors are keyed by the exact embedded input, so an
        unchanged passage keeps its vector and only new text is embedded.
        """
        with self._lock:
            reusable = {
                (str(row["source_name"]), str(row["text"])): str(row["dense_vector_json"])
                for row in self._connection.execute(
                    """
                    select source_name, text, dense_vector_json
                    from knowledge_chunks
                    where knowledge_config_id = ? and dense_vector_json != ?
                    """,
                    (config_id, _EMPTY_DENSE),
                ).fetchall()
            }
        reused: list[str | None] = [
            reusable.get((chunk.source_name, chunk.text)) for chunk in chunks
        ]
        missing = [chunk for chunk, vector in zip(chunks, reused, strict=True) if vector is None]
        fresh = iter(self._inline_dense_vectors(missing) or [])
        dense_json: list[str] = []
        for vector in reused:
            if vector is not None:
                dense_json.append(vector)
            else:
                embedded = next(fresh, None)
                dense_json.append(_dense_json(embedded))
        rows = self._chunk_rows(chunks, None, dense_json=dense_json)
        with self._lock:
            self._connection.execute(
                "delete from knowledge_chunks where knowledge_config_id = ?", (config_id,)
            )
            self._connection.execute(
                "delete from knowledge_documents where knowledge_config_id = ?",
                (config_id,),
            )
            self._upsert_documents(documents)
            self._write_chunk_rows(rows)
            self._connection.commit()
            self._bump(config_id)
        self._request_dense_backfill()

    def replace_document(
        self,
        document: KnowledgeDocument,
        chunks: list[KnowledgeChunk],
    ) -> None:
        """Swap one document's chunks, keeping vectors for passages that didn't change."""
        config_id = document.knowledge_config_id
        with self._lock:
            reusable = {
                (str(row["source_name"]), str(row["text"])): str(row["dense_vector_json"])
                for row in self._connection.execute(
                    """
                    select source_name, text, dense_vector_json
                    from knowledge_chunks
                    where knowledge_config_id = ? and document_id = ? and dense_vector_json != '[]'
                    """,
                    (config_id, document.id),
                ).fetchall()
            }
        reused = [reusable.get((chunk.source_name, chunk.text)) for chunk in chunks]
        missing = [chunk for chunk, vector in zip(chunks, reused, strict=True) if vector is None]
        fresh = iter(self._inline_dense_vectors(missing) or [])
        dense_json = [vector if vector is not None else _dense_json(next(fresh, None)) for vector in reused]
        rows = self._chunk_rows(chunks, None, dense_json=dense_json)
        with self._lock:
            self._connection.execute(
                "delete from knowledge_chunks where knowledge_config_id = ? and document_id = ?",
                (config_id, document.id),
            )
            self._upsert_documents([document])
            self._write_chunk_rows(rows)
            self._connection.commit()
            self._bump(config_id)
        self._request_dense_backfill()

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
            self._bump(config_id)

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
            self._bump_all()
            return int(removed_chunks or 0) + int(removed_documents or 0)

    def clear_all(self) -> None:
        with self._lock:
            self._connection.execute("delete from knowledge_chunks")
            self._connection.execute("delete from knowledge_documents")
            self._connection.commit()
            self._bump_all()

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
            self._bump(config_id)
            return True

    def upsert_sources(
        self,
        documents: list[KnowledgeDocument],
        chunks: list[KnowledgeChunk],
    ) -> None:
        # Sparse vectors, JSON payloads and (inline) dense vectors are computed
        # before taking the store lock so retrieval is never blocked by indexing.
        rows = self._chunk_rows(chunks, self._inline_dense_vectors(chunks))
        with self._lock:
            self._upsert_documents(documents)
            self._write_chunk_rows(rows)
            self._connection.commit()
            for config_id in {document.knowledge_config_id for document in documents} | {
                chunk.knowledge_config_id for chunk in chunks
            }:
                self._bump(config_id)
        self._request_dense_backfill()

    def update_config_acl(self, config_id: str, acl_group_ids: list[str]) -> int:
        """Apply a knowledge base's current sharing to every stored row.

        Document and chunk ACLs are copied from the knowledge base when content
        is indexed, and retrieval checks them per chunk. Without this, sharing a
        base with a new group left that group unable to retrieve anything.
        """
        encoded = json.dumps(list(acl_group_ids))
        with self._lock:
            updated = self._connection.execute(
                """
                update knowledge_chunks
                set acl_group_ids = ?, payload = json_set(payload, '$.acl_group_ids', json(?))
                where knowledge_config_id = ?
                """,
                (encoded, encoded, config_id),
            ).rowcount
            self._connection.execute(
                """
                update knowledge_documents
                set payload = json_set(payload, '$.acl_group_ids', json(?))
                where knowledge_config_id = ?
                """,
                (encoded, config_id),
            )
            self._connection.commit()
            self._bump(config_id)
            return int(updated or 0)

    # ------------------------------------------------------- dense indexing

    def backfill_dense_vectors(self) -> None:
        """Embed every chunk that is still missing a dense vector.

        In background mode this only wakes the worker; otherwise it runs to
        completion on the caller's thread, embedding outside the store lock.
        """
        if not self._dense_embeddings_enabled or self._dense_embedding_failed:
            return
        if self._background_dense:
            self._request_dense_backfill()
            return
        while self._embed_pending_batch(batch_size=256):
            pass

    def flush_dense_vectors(self) -> None:
        """Synchronously finish pending dense work (tests and shutdown hooks)."""
        if not self._dense_embeddings_enabled or self._dense_embedding_failed:
            return
        while self._embed_pending_batch(batch_size=256):
            pass

    def dense_status(self, config_id: str) -> dict[str, Any]:
        """Report semantic-index coverage for one knowledge base."""
        enabled = self._dense_embeddings_enabled and not self._dense_embedding_failed
        with self._lock:
            total = int(
                self._connection.execute(
                    "select count(*) from knowledge_chunks where knowledge_config_id = ?",
                    (config_id,),
                ).fetchone()[0]
            )
            pending_rows = (
                self._connection.execute(
                    """
                    select document_id, count(*) as pending
                    from knowledge_chunks
                    where knowledge_config_id = ? and dense_vector_json = '[]'
                    group by document_id
                    """,
                    (config_id,),
                ).fetchall()
                if enabled
                else []
            )
        pending_by_document = {str(row["document_id"]): int(row["pending"]) for row in pending_rows}
        return {
            "semantic_search": "on" if enabled else "off",
            "total_chunks": total,
            "pending_chunks": sum(pending_by_document.values()),
            "pending_by_document": pending_by_document,
        }

    def stop_dense_worker(self, timeout: float = 5.0) -> None:
        with self._dense_condition:
            self._dense_stopped = True
            self._dense_condition.notify_all()
            worker = self._dense_worker
        if worker is not None:
            worker.join(timeout=timeout)

    def request_dense_backfill(self) -> None:
        """Wake the background indexer; a no-op for inline embedding."""
        self._request_dense_backfill()

    def _request_dense_backfill(self) -> None:
        if not self._background_dense or self._dense_embedding_failed:
            return
        with self._dense_condition:
            if self._dense_stopped:
                return
            self._dense_requested = True
            if self._dense_worker is None or not self._dense_worker.is_alive():
                self._dense_worker = Thread(
                    target=self._dense_worker_loop,
                    name="knowledge-dense-indexer",
                    daemon=True,
                )
                self._dense_worker.start()
            self._dense_condition.notify_all()

    def _dense_worker_loop(self) -> None:
        while True:
            with self._dense_condition:
                while not self._dense_requested and not self._dense_stopped:
                    self._dense_condition.wait()
                if self._dense_stopped:
                    return
                self._dense_requested = False
            try:
                while not self._dense_stopped and self._embed_pending_batch(
                    batch_size=DENSE_BATCH_SIZE
                ):
                    pass
            except Exception:  # noqa: BLE001 - the worker must survive a bad batch
                logger.exception("Background knowledge embedding failed.")
            if self._dense_embedding_failed:
                return

    def _embed_pending_batch(self, *, batch_size: int) -> bool:
        """Embed one batch of chunks missing dense vectors; False when done."""
        with self._lock:
            rows = self._connection.execute(
                """
                select id, knowledge_config_id, source_name, text
                from knowledge_chunks
                where dense_vector_json = '[]'
                order by rowid
                limit ?
                """,
                (batch_size,),
            ).fetchall()
        if not rows:
            return False
        vectors = self._embed_passages([f"{row['source_name']} {row['text']}" for row in rows])
        if vectors is None:
            return False
        updates = [
            (_dense_json(vector), str(row["id"]), str(row["text"]))
            for row, vector in zip(rows, vectors, strict=True)
        ]
        with self._lock:
            # The text guard skips rows replaced while this batch was embedding.
            self._connection.executemany(
                """
                update knowledge_chunks set dense_vector_json = ?
                where id = ? and text = ? and dense_vector_json = '[]'
                """,
                updates,
            )
            self._connection.commit()
            for row, vector in zip(rows, vectors, strict=True):
                self._patch_cached_dense(str(row["knowledge_config_id"]), str(row["id"]), vector)
        return True

    # ------------------------------------------------------------------ reads

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
            result = coordinate_knowledge_state_import(
                self._connection,
                source_digest=source_digest,
                expected_semantic_digest=expected_semantic_digest,
                documents=documents,
                chunks=chunks,
            )
            self._bump_all()
            return result

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
        document predicate is applied before chunks are scored so a review cell
        can never draw context from another document.
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
        normalized_query = " ".join(query.lower().split())
        query_norm = _norm(query_vector.values())
        scored: list[tuple[float, KnowledgeChunk]] = []
        for config_id in dict.fromkeys(config_ids):
            index = self._search_index(config_id)
            if index is None:
                scored.extend(
                    self._stream_scores(
                        actor,
                        config_id,
                        query,
                        query_terms,
                        query_vector,
                        dense_query_vector,
                        document_id,
                    )
                )
                continue
            dense_scores = _dense_scores(index, dense_query_vector)
            for row, chunk in enumerate(index.chunks):
                if document_id is not None and chunk.document_id != document_id:
                    continue
                if not _chunk_visible_to_actor(actor, chunk):
                    continue
                searchable = index.searchable[row]
                lexical_score = sum(searchable.count(term) for term in query_terms)
                exact_score = 4.0 if normalized_query and normalized_query in searchable else 0.0
                sparse_score = _sparse_cosine(
                    query_vector, query_norm, index.sparse[row], index.sparse_norms[row]
                )
                score = exact_score + lexical_score + sparse_score + 2.0 * dense_scores[row]
                scored.append((score if score > 0 else 0.1, chunk))
        ranked = [item for item in scored if item[0] > 0.1] or scored
        best = heapq.nsmallest(
            max(0, limit),
            ranked,
            key=lambda item: (-item[0], item[1].source_name.lower(), item[1].ordinal),
        )
        return [chunk.model_copy(update={"score": score}, deep=True) for score, chunk in best]

    def _stream_scores(
        self,
        actor: User,
        config_id: str,
        query: str,
        query_terms: set[str],
        query_vector: dict[str, float],
        dense_query_vector: list[float] | None,
        document_id: str | None,
    ) -> list[tuple[float, KnowledgeChunk]]:
        """Score a knowledge base too large for the cache straight from SQLite."""
        document_clause = ""
        parameters: tuple[str, ...] = (config_id,)
        if document_id is not None:
            document_clause = " and document_id = ?"
            parameters = (config_id, document_id)
        with self._lock:
            rows = self._connection.execute(
                f"""
                select payload, vector_json, dense_vector_json
                from knowledge_chunks
                where knowledge_config_id = ?
                {document_clause}
                """,
                parameters,
            ).fetchall()
        scored: list[tuple[float, KnowledgeChunk]] = []
        for row in rows:
            chunk = KnowledgeChunk.model_validate_json(row["payload"])
            if not _chunk_visible_to_actor(actor, chunk):
                continue
            score = _chunk_score(
                chunk,
                query_terms,
                query,
                query_vector,
                json.loads(row["vector_json"] or "{}"),
                dense_query_vector,
                json.loads(row["dense_vector_json"] or "[]"),
            )
            scored.append((score, chunk))
        return scored

    def _search_index(self, config_id: str) -> _SearchIndex | None:
        with self._lock:
            generation = self._generations.get(config_id, 0)
            cached = self._search_cache.get(config_id)
            if cached is not None and cached.generation == generation:
                self._search_cache.move_to_end(config_id)
                return cached
            count = int(
                self._connection.execute(
                    "select count(*) from knowledge_chunks where knowledge_config_id = ?",
                    (config_id,),
                ).fetchone()[0]
            )
            if count > SEARCH_CACHE_MAX_CHUNKS:
                self._search_cache.pop(config_id, None)
                return None
            rows = self._connection.execute(
                """
                select payload, vector_json, dense_vector_json
                from knowledge_chunks
                where knowledge_config_id = ?
                """,
                (config_id,),
            ).fetchall()
            index = _build_search_index(generation, rows)
            self._search_cache[config_id] = index
            self._search_cache.move_to_end(config_id)
            cached_total = sum(len(item.chunks) for item in self._search_cache.values())
            while cached_total > SEARCH_CACHE_MAX_CHUNKS and len(self._search_cache) > 1:
                _evicted_id, evicted = self._search_cache.popitem(last=False)
                cached_total -= len(evicted.chunks)
            return index

    def _patch_cached_dense(self, config_id: str, chunk_id: str, vector: list[float]) -> None:
        """Apply a freshly embedded vector to a cached index without a rebuild."""
        index = self._search_cache.get(config_id)
        if index is None:
            return
        row = index.row_by_id.get(chunk_id)
        if row is None:
            return
        if np is not None:
            if index.dense is None:
                # Norms first: readers treat a missing norm array as "no vectors".
                index.dense_norms = np.zeros(len(index.chunks), dtype=np.float32)
                index.dense = np.zeros((len(index.chunks), len(vector)), dtype=np.float32)
            if index.dense.shape[1] != len(vector):
                return
            index.dense[row] = vector
            index.dense_norms[row] = float(np.linalg.norm(index.dense[row]))
        elif index.dense_lists is not None:
            index.dense_lists[row] = list(vector)

    def _bump(self, config_id: str) -> None:
        self._generations[config_id] = self._generations.get(config_id, 0) + 1
        self._search_cache.pop(config_id, None)

    def _bump_all(self) -> None:
        for config_id in list(self._generations):
            self._generations[config_id] += 1
        for config_id in list(self._search_cache):
            self._generations[config_id] = self._generations.get(config_id, 0) + 1
        self._search_cache.clear()

    # ----------------------------------------------------------------- schema

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
            # Legacy rows may carry NULL or '' for "no vector"; the background
            # indexer and pending counts look for the canonical '[]' only.
            self._connection.execute(
                """
                update knowledge_chunks set dense_vector_json = '[]'
                where dense_vector_json is null or dense_vector_json = ''
                """
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
            self._connection.execute(
                """
                create index if not exists idx_knowledge_chunks_dense_pending
                on knowledge_chunks (knowledge_config_id, document_id)
                where dense_vector_json = '[]'
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
        """Embed (inline mode) and write chunks; caller holds the store lock."""
        self._write_chunk_rows(self._chunk_rows(chunks, self._inline_dense_vectors(chunks)))

    def _chunk_rows(
        self,
        chunks: list[KnowledgeChunk],
        dense_vectors: list[list[float]] | None,
        *,
        dense_json: list[str] | None = None,
    ) -> list[tuple[Any, ...]]:
        if dense_json is None:
            dense_json = (
                [_dense_json(vector) for vector in dense_vectors]
                if dense_vectors is not None
                else [_EMPTY_DENSE for _chunk in chunks]
            )
        return [
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
                vector_json,
                json.dumps(chunk.acl_group_ids),
                chunk.updated_at,
                chunk.model_dump_json(),
            )
            for chunk, vector_json in zip(chunks, dense_json, strict=True)
        ]

    def _write_chunk_rows(self, rows: list[tuple[Any, ...]]) -> None:
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
            rows,
        )

    # --------------------------------------------------------------- embedder

    def _inline_dense_vectors(self, chunks: list[KnowledgeChunk]) -> list[list[float]] | None:
        """Dense vectors to store with new chunks; None defers to the worker."""
        if self._background_dense or not chunks:
            return None
        return self._embed_passages([f"{chunk.source_name} {chunk.text}" for chunk in chunks])

    def _embed_passages(self, texts: list[str]) -> list[list[float]] | None:
        if not texts or not self._dense_embeddings_enabled or self._dense_embedding_failed:
            return None
        embedder = self._get_dense_embedder()
        if embedder is None:
            return None
        try:
            with self._embed_lock:
                vectors = embedder.passage_embed(texts, batch_size=DENSE_BATCH_SIZE)
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
        # A query waits for at most one in-flight passage batch; if the embedder
        # is unexpectedly busy for longer, this query falls back to keyword
        # scoring instead of stalling chat.
        if not self._embed_lock.acquire(timeout=QUERY_EMBED_WAIT_SECONDS):
            return None
        try:
            vector = next(iter(embedder.query_embed(query)))
            return [float(value) for value in vector]
        except Exception as error:
            self._disable_dense_embeddings(error)
            return None
        finally:
            self._embed_lock.release()

    def _get_dense_embedder(self) -> object | None:
        if self._dense_embedder is not None:
            return self._dense_embedder
        with self._embed_lock:
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


def _dense_json(vector: list[float] | None) -> str:
    if not vector:
        return _EMPTY_DENSE
    return json.dumps(vector, separators=(",", ":"))


def _build_search_index(generation: int, rows: list[sqlite3.Row]) -> _SearchIndex:
    chunks: list[KnowledgeChunk] = []
    searchable: list[str] = []
    sparse: list[dict[str, float]] = []
    sparse_norms: list[float] = []
    dense_rows: list[list[float]] = []
    for row in rows:
        chunk = KnowledgeChunk.model_validate_json(row["payload"])
        vector = json.loads(row["vector_json"] or "{}")
        chunks.append(chunk)
        searchable.append(f"{chunk.source_name} {chunk.text}".lower())
        sparse.append(vector)
        sparse_norms.append(_norm(vector.values()))
        dense_rows.append(json.loads(row["dense_vector_json"] or "[]"))
    dimension = next((len(vector) for vector in dense_rows if vector), 0)
    dense: Any = None
    dense_norms: Any = None
    dense_lists: list[list[float]] | None = None
    if np is not None:
        if dimension:
            dense = np.zeros((len(chunks), dimension), dtype=np.float32)
            for row_index, vector in enumerate(dense_rows):
                if len(vector) == dimension:
                    dense[row_index] = vector
            dense_norms = np.linalg.norm(dense, axis=1).astype(np.float32)
    else:
        dense_lists = dense_rows
    return _SearchIndex(
        generation=generation,
        chunks=chunks,
        row_by_id={chunk.id: row_index for row_index, chunk in enumerate(chunks)},
        searchable=searchable,
        sparse=sparse,
        sparse_norms=sparse_norms,
        dense=dense,
        dense_norms=dense_norms,
        dense_lists=dense_lists,
    )


def _dense_scores(index: _SearchIndex, query_vector: list[float] | None) -> list[float]:
    count = len(index.chunks)
    if not query_vector:
        return [0.0] * count
    if np is not None:
        dense, norms = index.dense, index.dense_norms
        if dense is None or norms is None or dense.shape[1] != len(query_vector):
            return [0.0] * count
        query = np.asarray(query_vector, dtype=np.float32)
        query_norm = float(np.linalg.norm(query))
        if query_norm == 0:
            return [0.0] * count
        dots = dense @ query
        denominators = norms * query_norm
        with np.errstate(divide="ignore", invalid="ignore"):
            scores = np.where((dots > 0) & (denominators > 0), dots / denominators, 0.0)
        return [float(value) for value in scores]
    return [
        max(0.0, _cosine_similarity(query_vector, vector)) if vector else 0.0
        for vector in (index.dense_lists or [[] for _row in range(count)])
    ]


def _sparse_cosine(
    query: dict[str, float],
    query_norm: float,
    chunk: dict[str, float],
    chunk_norm: float,
) -> float:
    if not query or not chunk or query_norm == 0 or chunk_norm == 0:
        return 0.0
    dot_product = sum(weight * chunk.get(token, 0.0) for token, weight in query.items())
    if dot_product <= 0:
        return 0.0
    return dot_product / (query_norm * chunk_norm)


def _norm(values: Any) -> float:
    return sum(value * value for value in values) ** 0.5


def _chunk_visible_to_actor(actor: User, chunk: KnowledgeChunk) -> bool:
    if actor.role == Role.PLATFORM_OWNER:
        return True
    if actor.tenant_id != chunk.tenant_id:
        return False
    # Tenant admins may read every knowledge base in their tenant (see
    # policy.knowledge_config_visible_to_user); chunk ACLs must agree.
    if actor.role == Role.TENANT_ADMIN:
        return True
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
