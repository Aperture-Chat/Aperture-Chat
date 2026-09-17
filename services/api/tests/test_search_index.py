from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.core.search_index import backfill_tenant, reconcile_store_collections
from app.main import app
from app.models.schemas import Automation, ChatMessage, ChatThread, ModelConfig
from app.repositories.deps import get_store
from app.repositories.search_index import SearchIndexEntry

client = TestClient(app)
TENANT = "tenant-example"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _thread(thread_id: str, owner: str, title: str, text: str) -> ChatThread:
    return ChatThread(
        id=thread_id,
        tenant_id=TENANT,
        owner_user_id=owner,
        title=title,
        model_id="gpt-4o-mini",
        group_id="group-litigation",
        updated_at="2026-09-13T00:00:00Z",
        messages=[
            ChatMessage(id=f"{thread_id}-u", role="user", content=text, createdAt="12:00 PM"),
            ChatMessage(
                id=f"{thread_id}-a",
                role="assistant",
                content="Reply ```hermes-trace\nsecret companion text\n``` done",
                createdAt="12:01 PM",
            ),
        ],
    )


def _section(body: dict[str, object], kind: str) -> list[dict[str, object]]:
    return next(item for item in body["sections"] if item["kind"] == kind)["results"]  # type: ignore[index,call-overload,return-value]


def test_repository_scopes_queries_by_tenant_and_owner_and_escapes_like() -> None:
    repo = get_store().search_index_repository
    now = datetime.now(UTC)
    repo.upsert_many(
        [
            SearchIndexEntry(TENANT, "chat", "t1", "Peregrine memo", "budget 100% done", now, owner_user_id="user-jane"),
            SearchIndexEntry(TENANT, "chat", "t2", "Peregrine notes", "other", now, owner_user_id="user-casey"),
            SearchIndexEntry("tenant-other", "chat", "t3", "Peregrine leak", "other", now, owner_user_id="user-jane"),
        ]
    )
    jane = repo.query(tenant_id=TENANT, text="peregrine", kinds=["chat"], owner_user_id="user-jane")
    assert [c.resource_id for c in jane] == ["t1"]
    both = repo.query(tenant_id=TENANT, text="peregrine", kinds=["chat"])
    assert {c.resource_id for c in both} == {"t1", "t2"}
    assert repo.query(tenant_id=TENANT, text="100%", kinds=["chat"], owner_user_id="user-jane")[0].resource_id == "t1"
    assert repo.query(tenant_id=TENANT, text="budget done", kinds=["chat"], owner_user_id="user-jane")
    assert repo.query(tenant_id=TENANT, text="missing", kinds=["chat"]) == []
    repo.delete("chat", "t1")
    assert repo.query(tenant_id=TENANT, text="peregrine", kinds=["chat"], owner_user_id="user-jane") == []
    assert repo.delete_for_owner(tenant_id=TENANT, user_id="user-casey") == 1
    assert repo.delete_for_tenant("tenant-other") == 1
    assert repo.count() == 0


def test_chat_and_draft_writes_index_in_the_same_transaction_and_hermes_is_stripped() -> None:
    store = get_store()
    repo = store.search_index_repository
    store.application_state_repository.upsert_chat_thread(
        _thread("thread-idx", "user-jane", "Quarterly Kestrel review", "Discuss the kestrel roadmap")
    )
    hits = repo.query(tenant_id=TENANT, text="kestrel", kinds=["chat"], owner_user_id="user-jane")
    assert [hit.resource_id for hit in hits] == ["thread-idx"]
    assert "secret companion text" not in hits[0].body
    assert repo.query(tenant_id=TENANT, text="companion", kinds=["chat"], owner_user_id="user-jane") == []

    snapshot = store.matter_draft_repository.create_draft(
        tenant_id=TENANT, owner_user_id="user-jane", title="Kestrel brief", content="<p>Kestrel wording here.</p>"
    )
    drafts = repo.query(tenant_id=TENANT, text="wording", kinds=["draft"], owner_user_id="user-jane")
    assert [hit.resource_id for hit in drafts] == [snapshot.document.id]
    store.matter_draft_repository.update_draft(
        snapshot.document.id,
        tenant_id=TENANT,
        owner_user_id="user-jane",
        expected_revision=1,
        content="<p>Rewritten with falcon terms.</p>",
    )
    assert repo.query(tenant_id=TENANT, text="wording", kinds=["draft"], owner_user_id="user-jane") == []
    assert repo.query(tenant_id=TENANT, text="falcon", kinds=["draft"], owner_user_id="user-jane")
    store.matter_draft_repository.delete_draft(
        snapshot.document.id, tenant_id=TENANT, owner_user_id="user-jane", expected_revision=2
    )
    assert repo.query(tenant_id=TENANT, text="falcon", kinds=["draft"], owner_user_id="user-jane") == []
    store.application_state_repository.delete_chat_thread("thread-idx")
    assert repo.query(tenant_id=TENANT, text="kestrel", kinds=["chat"], owner_user_id="user-jane") == []


def test_search_route_falls_back_until_backfill_then_uses_index_with_live_reverification() -> None:
    store = get_store()
    repo = store.search_index_repository
    store.application_state_repository.upsert_chat_thread(
        _thread("thread-jane", "user-jane", "Osprey planning", "osprey migration budget")
    )
    store.application_state_repository.upsert_chat_thread(
        _thread("thread-casey", "user-casey", "Osprey private", "osprey secret")
    )

    before = client.get("/api/search", params={"q": "osprey"}, headers=headers("user-jane"))
    assert before.status_code == 200
    assert before.json()["index_state"] == "backfilling"
    assert [hit["id"] for hit in _section(before.json(), "chat")] == ["thread-jane"]

    state = backfill_tenant(store, TENANT)
    assert state.ready and state.fts_mode == "like"
    after = client.get("/api/search", params={"q": "osprey"}, headers=headers("user-jane"))
    assert after.json()["index_state"] == "ready"
    hits = _section(after.json(), "chat")
    assert [hit["id"] for hit in hits] == ["thread-jane"]
    assert "budget" in hits[0]["snippet"]
    assert hits[0]["navigation"] == {"view": "chat", "thread_id": "thread-jane"}

    # Tenant admins never receive another person's chats through the index.
    admin = client.get("/api/search", params={"q": "osprey"}, headers=headers("user-admin"))
    assert _section(admin.json(), "chat") == []

    # A stale or mis-tagged index row is filtered by the live owner-scoped load.
    repo.upsert(
        SearchIndexEntry(
            TENANT, "chat", "thread-casey", "Osprey private", "osprey secret",
            datetime.now(UTC), owner_user_id="user-jane",
        )
    )
    poisoned = client.get("/api/search", params={"q": "osprey"}, headers=headers("user-jane"))
    assert [hit["id"] for hit in _section(poisoned.json(), "chat")] == ["thread-jane"]
    repo.upsert(
        SearchIndexEntry(TENANT, "chat", "thread-gone", "Osprey ghost", "osprey", datetime.now(UTC), owner_user_id="user-jane")
    )
    ghost = client.get("/api/search", params={"q": "osprey"}, headers=headers("user-jane"))
    assert "thread-gone" not in {hit["id"] for hit in _section(ghost.json(), "chat")}

    # kinds narrows the sections that do work; unknown kinds are refused.
    only_chat = client.get("/api/search", params={"q": "osprey", "kinds": "chat"}, headers=headers("user-jane"))
    assert _section(only_chat.json(), "draft") == []
    assert client.get("/api/search", params={"q": "osprey", "kinds": "nope"}, headers=headers("user-jane")).status_code == 422


def test_backfill_is_idempotent_reconciles_store_collections_and_owner_endpoints_gate() -> None:
    store = get_store()
    repo = store.search_index_repository
    store.automations["auto-x"] = Automation(
        id="auto-x", tenant_id=TENANT, name="Heron digest", prompt="Summarize heron filings", created_by="user-jane"
    )
    store.models["agent-heron"] = ModelConfig(
        id="agent-heron", tenant_id=TENANT, provider_id="provider-openrouter", provider_name="OpenRouter",
        name="Heron Agent", upstream_model_id="openai/gpt-4o-mini", is_custom=True, created_by="Jane Smith",
        meta_prompt="Heron agent prompt", visibility="tenant",
    )
    first = backfill_tenant(store, TENANT)
    second = backfill_tenant(store, TENANT)
    assert second.entry_count == first.entry_count
    assert second.backfill_revision == first.backfill_revision + 1
    assert repo.query(tenant_id=TENANT, text="heron", kinds=["automation"])[0].resource_id == "auto-x"
    assert repo.query(tenant_id=TENANT, text="heron", kinds=["agent"])[0].resource_id == "agent-heron"
    del store.automations["auto-x"]
    reconcile_store_collections(store, tenant_id=TENANT)
    assert repo.query(tenant_id=TENANT, text="heron", kinds=["automation"]) == []

    forbidden = client.get("/api/platform/search-index/status", headers=headers("user-admin"))
    assert forbidden.status_code == 403
    status = client.get("/api/platform/search-index/status", headers=headers("user-owner"))
    assert status.status_code == 200
    body = status.json()
    assert body["enabled"] is True
    tenant_state = next(item for item in body["tenants"] if item["tenant_id"] == TENANT)
    assert tenant_state["ready"] is True
    assert tenant_state["fts_mode"] == "like"
    rebuilt = client.post("/api/platform/search-index/rebuild", headers=headers("user-owner"))
    assert rebuilt.status_code == 200
    assert next(item for item in rebuilt.json()["tenants"] if item["tenant_id"] == TENANT)["backfill_revision"] == second.backfill_revision + 1
    assert client.post("/api/platform/search-index/rebuild", params={"tenant_id": "nope"}, headers=headers("user-owner")).status_code == 404
    assert "platform.search_index_rebuilt" in [e.action for e in store.audit_events_newest_first(limit=5)]
