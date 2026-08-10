from __future__ import annotations

from app.core.vector_store import LocalVectorStore
from app.models.schemas import KnowledgeChunk, KnowledgeDocument, Role, User


CONFIG_ID = "knowledge-review-test"
TENANT_ID = "tenant-review-test"


def _actor(*, group_ids: list[str] | None = None, tenant_id: str = TENANT_ID) -> User:
    return User(
        id="user-review-test",
        tenant_id=tenant_id,
        email="reviewer@example.test",
        display_name="Review Test User",
        role=Role.USER,
        group_ids=group_ids or [],
    )


def _document(document_id: str, name: str) -> KnowledgeDocument:
    return KnowledgeDocument(
        id=document_id,
        knowledge_config_id=CONFIG_ID,
        tenant_id=TENANT_ID,
        name=name,
        source_uri=f"upload://{document_id}.txt",
        source_type="upload",
        chunk_count=1,
        updated_at="2026-07-19T12:00:00+00:00",
    )


def _chunk(
    document: KnowledgeDocument,
    chunk_id: str,
    text: str,
    *,
    ordinal: int = 0,
    acl_group_ids: list[str] | None = None,
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
        acl_group_ids=acl_group_ids or [],
        updated_at=document.updated_at,
    )


def test_search_document_filters_exact_document_before_ranking() -> None:
    store = LocalVectorStore(":memory:")
    first = _document("doc-contract", "Contract")
    second = _document("doc-contract-supplement", "Contract supplement")
    chunks = [
        _chunk(first, "chunk-contract", "The shared renewal deadline is May 1."),
        _chunk(second, "chunk-supplement", "The shared renewal deadline is June 1."),
    ]
    store.upsert_sources([first, second], chunks)

    broad_hits = store.search(
        _actor(),
        [CONFIG_ID],
        "shared renewal deadline",
        limit=10,
    )
    exact_hits = store.search_document(
        _actor(),
        [CONFIG_ID],
        "shared renewal deadline",
        document_id=first.id,
        limit=10,
    )

    assert {hit.document_id for hit in broad_hits} == {first.id, second.id}
    assert [hit.id for hit in exact_hits] == ["chunk-contract"]
    assert store.search_document(
        _actor(),
        [CONFIG_ID],
        "shared renewal deadline",
        document_id="doc-contract-supp",
        limit=10,
    ) == []
    assert store.search_document(
        _actor(),
        ["knowledge-other"],
        "shared renewal deadline",
        document_id=first.id,
        limit=10,
    ) == []


def test_search_document_preserves_actor_chunk_visibility() -> None:
    store = LocalVectorStore(":memory:")
    document = _document("doc-acl", "ACL source")
    store.upsert_sources(
        [document],
        [
            _chunk(
                document,
                "chunk-litigation",
                "Litigation deadline evidence.",
                acl_group_ids=["group-litigation"],
            ),
            _chunk(
                document,
                "chunk-finance",
                "Finance deadline evidence.",
                ordinal=1,
                acl_group_ids=["group-finance"],
            ),
        ],
    )

    hits = store.search_document(
        _actor(group_ids=["group-litigation"]),
        [CONFIG_ID],
        "deadline evidence",
        document_id=document.id,
        limit=10,
    )
    cross_tenant_hits = store.search_document(
        _actor(group_ids=["group-litigation"], tenant_id="tenant-other"),
        [CONFIG_ID],
        "deadline evidence",
        document_id=document.id,
        limit=10,
    )

    assert [hit.id for hit in hits] == ["chunk-litigation"]
    assert cross_tenant_hits == []


def test_search_document_uses_the_same_dense_ranking_as_search() -> None:
    class SemanticEmbedder:
        def passage_embed(self, texts: list[str], *, batch_size: int):
            del batch_size
            for text in texts:
                yield [1.0, 0.0] if "automobile" in text.lower() else [0.0, 1.0]

        def query_embed(self, query: str):
            assert query == "vehicle"
            yield [1.0, 0.0]

    store = LocalVectorStore(
        ":memory:",
        dense_embeddings_enabled=True,
        dense_embedder=SemanticEmbedder(),
    )
    document = _document("doc-semantic-review", "Semantic review")
    store.upsert_sources(
        [document],
        [
            _chunk(document, "chunk-automobile", "The automobile policy renews next month."),
            _chunk(
                document,
                "chunk-discovery",
                "The discovery deadline is Friday.",
                ordinal=1,
            ),
        ],
    )

    hits = store.search_document(
        _actor(),
        [CONFIG_ID],
        "vehicle",
        document_id=document.id,
        limit=2,
    )

    assert hits[0].id == "chunk-automobile"
    assert hits[0].score > 1.0


def test_vector_store_has_config_document_composite_index() -> None:
    store = LocalVectorStore(":memory:")

    indexes = {
        row["name"]: [
            column["name"]
            for column in store._connection.execute(  # noqa: SLF001 - schema assertion
                f"pragma index_info({row['name']})"
            ).fetchall()
        ]
        for row in store._connection.execute(  # noqa: SLF001 - schema assertion
            "pragma index_list(knowledge_chunks)"
        ).fetchall()
    }

    assert indexes["idx_knowledge_chunks_config_document"] == [
        "knowledge_config_id",
        "document_id",
    ]
