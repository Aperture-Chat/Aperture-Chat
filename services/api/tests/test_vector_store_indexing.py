"""Background dense indexing, vector reuse, and the parsed search cache."""

from __future__ import annotations

import threading
import time

from app.core.security import SecretVault
import app.core.vector_store as vector_store_module
from app.core.vector_store import LocalVectorStore
from app.models.schemas import KnowledgeChunk, KnowledgeDocument, Role, User
from app.repositories.seed import SeedStore

CONFIG_ID = "knowledge-indexing-test"
TENANT_ID = "tenant-indexing-test"


class CountingEmbedder:
    """Two-dimensional fake: 'automobile' texts point one way, others the other."""

    def __init__(self, gate: threading.Event | None = None) -> None:
        self.passages: list[str] = []
        self.gate = gate
        self.entered = threading.Event()

    def passage_embed(self, texts: list[str], *, batch_size: int):
        del batch_size
        self.entered.set()
        if self.gate is not None:
            assert self.gate.wait(5), "test gate never opened"
        for text in texts:
            self.passages.append(text)
            yield [1.0, 0.0] if "automobile" in text.lower() else [0.0, 1.0]

    def query_embed(self, query: str):
        yield [1.0, 0.0] if "vehicle" in query.lower() else [0.0, 1.0]


def _actor(role: Role = Role.USER, group_ids: list[str] | None = None) -> User:
    return User(
        id="user-indexing",
        tenant_id=TENANT_ID,
        email="indexing@example.test",
        display_name="Indexing User",
        role=role,
        group_ids=group_ids or [],
    )


def _document(document_id: str = "doc-one") -> KnowledgeDocument:
    return KnowledgeDocument(
        id=document_id,
        knowledge_config_id=CONFIG_ID,
        tenant_id=TENANT_ID,
        name=f"{document_id}.txt",
        source_uri=f"upload://{document_id}.txt",
        source_type="upload",
        chunk_count=2,
        updated_at="2026-09-23T12:00:00+00:00",
    )


def _chunks(document: KnowledgeDocument, texts: list[str], acl: list[str] | None = None) -> list[KnowledgeChunk]:
    return [
        KnowledgeChunk(
            id=f"chunk-{document.id}-{index}",
            knowledge_config_id=CONFIG_ID,
            document_id=document.id,
            tenant_id=TENANT_ID,
            source_name=document.name,
            source_uri=document.source_uri,
            source_type="upload",
            text=text,
            ordinal=index,
            acl_group_ids=list(acl or []),
            updated_at=document.updated_at,
        )
        for index, text in enumerate(texts)
    ]


def _wait_for(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition was not met in time")


def test_background_indexing_makes_chunks_searchable_before_vectors_exist() -> None:
    gate = threading.Event()
    embedder = CountingEmbedder(gate)
    store = LocalVectorStore(
        ":memory:", dense_embeddings_enabled=True, dense_embedder=embedder, background_dense=True
    )
    document = _document()
    started = time.monotonic()
    store.upsert_sources([document], _chunks(document, ["The automobile policy renews.", "Discovery closes Friday."]))
    assert time.monotonic() - started < 1.0, "upsert must not wait for embeddings"

    # The worker is blocked mid-batch: vectors are pending, yet a query still
    # answers from keyword scoring once its bounded wait for the embedder ends.
    assert embedder.entered.wait(5)
    status = store.dense_status(CONFIG_ID)
    assert status["semantic_search"] == "on"
    assert status["pending_chunks"] == 2
    assert status["pending_by_document"] == {"doc-one": 2}
    monkeypatched_wait = vector_store_module.QUERY_EMBED_WAIT_SECONDS
    vector_store_module.QUERY_EMBED_WAIT_SECONDS = 0.1
    try:
        hits = store.search(_actor(), [CONFIG_ID], "discovery", limit=1)
    finally:
        vector_store_module.QUERY_EMBED_WAIT_SECONDS = monkeypatched_wait
    assert hits[0].text == "Discovery closes Friday."

    gate.set()
    _wait_for(lambda: store.dense_status(CONFIG_ID)["pending_chunks"] == 0)
    semantic = store.search(_actor(), [CONFIG_ID], "vehicle", limit=1)
    assert semantic[0].text == "The automobile policy renews."
    store.stop_dense_worker()


def test_search_is_not_blocked_by_a_long_embedding_batch() -> None:
    gate = threading.Event()
    embedder = CountingEmbedder(gate)
    store = LocalVectorStore(":memory:", dense_embeddings_enabled=False)
    document = _document()
    store.upsert_sources([document], _chunks(document, ["Existing deadline memo."]))
    # Switch on dense embeddings with a blocked embedder, as if a big upload
    # were mid-embedding on another thread.
    store._dense_embeddings_enabled = True  # noqa: SLF001
    store._dense_embedder = embedder  # noqa: SLF001
    writer = threading.Thread(
        target=store.upsert_sources,
        args=([_document("doc-two")], _chunks(_document("doc-two"), ["Automobile claims."])),
    )
    writer.start()
    assert embedder.entered.wait(5)

    store._dense_embeddings_enabled = False  # queries skip the embedder  # noqa: SLF001
    started = time.monotonic()
    hits = store.search(_actor(), [CONFIG_ID], "deadline", limit=1)
    assert time.monotonic() - started < 1.0
    assert hits[0].text == "Existing deadline memo."
    gate.set()
    writer.join(5)


def test_replace_config_reuses_vectors_for_unchanged_passages() -> None:
    embedder = CountingEmbedder()
    store = LocalVectorStore(":memory:", dense_embeddings_enabled=True, dense_embedder=embedder)
    document = _document()
    store.replace_config(CONFIG_ID, [document], _chunks(document, ["Alpha passage.", "Beta passage."]))
    assert len(embedder.passages) == 2

    store.replace_config(
        CONFIG_ID, [document], _chunks(document, ["Alpha passage.", "Beta passage.", "Gamma passage."])
    )

    assert len(embedder.passages) == 3
    assert embedder.passages[-1].endswith("Gamma passage.")
    assert store.dense_status(CONFIG_ID)["pending_chunks"] == 0


def test_replace_document_swaps_one_document_and_keeps_others() -> None:
    embedder = CountingEmbedder()
    store = LocalVectorStore(":memory:", dense_embeddings_enabled=True, dense_embedder=embedder)
    first, second = _document("doc-one"), _document("doc-two")
    store.upsert_sources([first, second], _chunks(first, ["Old API text."]) + _chunks(second, ["Kept upload."]))

    store.replace_document(first, _chunks(first, ["New API text."]))

    texts = sorted(chunk.text for chunk in store.chunks_for(CONFIG_ID))
    assert texts == ["Kept upload.", "New API text."]
    assert [hit.text for hit in store.search(_actor(), [CONFIG_ID], "new api", limit=1)] == ["New API text."]


def test_search_cache_sees_every_kind_of_write() -> None:
    store = LocalVectorStore(":memory:")
    document = _document()
    store.upsert_sources([document], _chunks(document, ["Retention schedule."], acl=["group-a"]))
    member = _actor(group_ids=["group-a"])
    outsider = _actor(group_ids=["group-b"])
    assert store.search(member, [CONFIG_ID], "retention", limit=1)  # warms the cache
    assert store.search(outsider, [CONFIG_ID], "retention", limit=1) == []

    store.update_config_acl(CONFIG_ID, ["group-a", "group-b"])
    assert store.search(outsider, [CONFIG_ID], "retention", limit=1)

    store.upsert_sources([document], _chunks(document, ["Retention schedule.", "Litigation hold."], acl=["group-a"]))
    assert store.search(member, [CONFIG_ID], "litigation hold", limit=1)[0].text == "Litigation hold."

    store.delete_document(CONFIG_ID, document.id)
    assert store.search(member, [CONFIG_ID], "retention", limit=5) == []


def test_cached_search_matches_streaming_scores() -> None:
    store = LocalVectorStore(":memory:")
    document = _document()
    texts = [f"Clause {index} covers indemnity and warranty obligations." for index in range(20)]
    texts.append("Warranty warranty warranty exact phrase match.")
    store.upsert_sources([document], _chunks(document, texts))
    actor = _actor()
    cached = store.search(actor, [CONFIG_ID], "warranty exact phrase", limit=5)
    streamed = sorted(
        store._stream_scores(  # noqa: SLF001
            actor, CONFIG_ID, "warranty exact phrase", {"warranty", "exact", "phrase"},
            {"warranty": 1.0, "exact": 1.0, "phrase": 1.0}, None, None,
        ),
        key=lambda item: (-item[0], item[1].source_name.lower(), item[1].ordinal),
    )[:5]
    assert [hit.id for hit in cached] == [chunk.id for _score, chunk in streamed]
    assert [round(hit.score, 6) for hit in cached] == [round(score, 6) for score, _chunk in streamed]


def test_tenant_admin_sees_group_restricted_chunks_in_their_tenant() -> None:
    store = LocalVectorStore(":memory:")
    document = _document()
    store.upsert_sources([document], _chunks(document, ["Privileged memo."], acl=["group-legal"]))
    assert store.search(_actor(Role.TENANT_ADMIN), [CONFIG_ID], "memo", limit=1)
    assert store.search(_actor(Role.USER), [CONFIG_ID], "memo", limit=1) == []
    other_tenant_admin = _actor(Role.TENANT_ADMIN).model_copy(update={"tenant_id": "tenant-other"})
    assert store.search(other_tenant_admin, [CONFIG_ID], "memo", limit=1) == []


def test_live_snapshot_payload_skips_knowledge_collections() -> None:
    store = SeedStore(SecretVault("test-secret"))
    assert any(store.knowledge_chunks.values())
    full = store._identity_config_v4_payload()  # noqa: SLF001
    live = store._identity_config_live_payload()  # noqa: SLF001
    assert full["knowledge_chunks"]
    assert live["knowledge_chunks"] == {}
    assert live["knowledge_documents"] == {}
    skipped = {"knowledge_documents", "knowledge_chunks"}
    assert {key: value for key, value in live.items() if key not in skipped} == {
        key: value for key, value in full.items() if key not in skipped
    }
