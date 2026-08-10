from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import (
    Automation,
    AutomationStep,
    KnowledgeChunk,
    KnowledgeConfig,
    KnowledgeDocument,
    ModelConfig,
)
from app.repositories.deps import get_store
from app.repositories.review_deps import close_review_services

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    close_review_services()
    get_store.cache_clear()
    yield
    close_review_services()
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _section(body: dict[str, object], kind: str) -> list[dict[str, object]]:
    sections = body["sections"]
    assert isinstance(sections, list)
    section = next(item for item in sections if item["kind"] == kind)
    return section["results"]


def _save_thread(
    user_id: str,
    thread_id: str,
    title: str,
    content: str,
    *,
    archived: bool = False,
) -> None:
    response = client.put(
        f"/api/chat/threads/{thread_id}",
        json={
            "title": title,
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "archived": archived,
            "messages": [
                {
                    "id": f"message-{thread_id}",
                    "role": "user",
                    "content": content,
                    "createdAt": "10:00 AM",
                }
            ],
        },
        headers=headers(user_id),
    )
    assert response.status_code == 200


def test_search_requires_authentication_and_nonblank_query() -> None:
    assert client.get("/api/search", params={"q": "matter"}).status_code == 401

    blank = client.get("/api/search", params={"q": "   "}, headers=headers("user-jane"))
    assert blank.status_code == 422
    assert blank.json()["detail"] == "Search query must not be blank."


def test_chat_search_is_personal_and_searches_message_content() -> None:
    _save_thread(
        "user-jane",
        "thread-jane-search",
        "Private strategy",
        "The saffron comet deadline belongs only to Jane.",
    )
    _save_thread(
        "user-casey",
        "thread-casey-search",
        "Casey private strategy",
        "The saffron comet deadline belongs only to Casey.",
    )

    response = client.get(
        "/api/search",
        params={"q": "saffron comet"},
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "saffron comet"
    chats = _section(body, "chat")
    assert [item["id"] for item in chats] == ["thread-jane-search"]
    assert "belongs only to Jane" in chats[0]["snippet"]
    assert chats[0]["navigation"] == {
        "view": "chat",
        "thread_id": "thread-jane-search",
    }


def test_chat_search_includes_archived_conversations_and_labels_the_section() -> None:
    _save_thread(
        "user-jane",
        "thread-jane-archived",
        "Archived launch retrospective",
        "The marigold handoff decision lives in this archived conversation.",
        archived=True,
    )

    response = client.get(
        "/api/search",
        params={"q": "marigold handoff"},
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    chat_section = next(
        section for section in response.json()["sections"] if section["kind"] == "chat"
    )
    assert chat_section["title"] == "Previous chats"
    assert [item["id"] for item in chat_section["results"]] == ["thread-jane-archived"]
    assert chat_section["results"][0]["metadata"]["archived"] is True
    assert "archived conversation" in chat_section["results"][0]["snippet"]


def test_knowledge_search_preserves_page_provenance_and_acl() -> None:
    store = get_store()
    store.users["user-casey"].group_ids = ["group-finance"]
    config = KnowledgeConfig(
        id="knowledge-search-private",
        tenant_id="tenant-example",
        name="Search private",
        source_type="upload",
        enabled=True,
        owner_user_id="user-jane",
        acl_group_ids=["group-litigation"],
        settings={},
    )
    document = KnowledgeDocument(
        id="document-search-private",
        knowledge_config_id=config.id,
        tenant_id="tenant-example",
        name="Orbital closing checklist.pdf",
        source_uri="upload://orbital-closing-checklist.pdf",
        source_type="upload",
        acl_group_ids=["group-litigation"],
        updated_at="2026-07-19T12:00:00+00:00",
    )
    chunk = KnowledgeChunk(
        id="chunk-search-private",
        knowledge_config_id=config.id,
        document_id=document.id,
        tenant_id="tenant-example",
        source_name=document.name,
        source_uri=document.source_uri,
        source_type=document.source_type,
        text="Orbitalquartz approval is required before the closing transfer.",
        page_start=7,
        page_end=8,
        locator="Pages 7-8",
        acl_group_ids=["group-litigation"],
        updated_at=document.updated_at,
    )
    store.knowledge_configs[config.id] = config
    store.sync_knowledge_config(
        config.id,
        [document],
        chunks=[chunk],
        provider_status="live",
    )

    allowed = client.get(
        "/api/search",
        params={"q": "orbitalquartz"},
        headers=headers("user-jane"),
    )
    blocked = client.get(
        "/api/search",
        params={"q": "orbitalquartz"},
        headers=headers("user-casey"),
    )

    assert allowed.status_code == 200
    knowledge = _section(allowed.json(), "knowledge")
    assert [item["id"] for item in knowledge] == ["chunk-search-private"]
    assert knowledge[0]["metadata"]["page_start"] == 7
    assert knowledge[0]["metadata"]["page_end"] == 8
    assert knowledge[0]["metadata"]["locator"] == "Pages 7-8"
    assert knowledge[0]["navigation"]["page"] == "7"
    assert blocked.status_code == 200
    assert _section(blocked.json(), "knowledge") == []


def test_agent_and_automation_results_follow_existing_visibility_rules() -> None:
    store = get_store()
    for user_id, suffix in (("user-jane", "jane"), ("user-casey", "casey")):
        store.models[f"agent-nebula-{suffix}"] = ModelConfig(
            id=f"agent-nebula-{suffix}",
            tenant_id="tenant-example",
            provider_id="provider-openrouter",
            provider_name="OpenRouter",
            name=f"Nebula diligence {suffix}",
            is_custom=True,
            created_by=user_id,
            visibility="private",
            meta_prompt="Run the cobalt nebula diligence checklist.",
        )
        store.automations[f"automation-nebula-{suffix}"] = Automation(
            id=f"automation-nebula-{suffix}",
            tenant_id="tenant-example",
            name=f"Nebula schedule {suffix}",
            prompt="Run the cobalt nebula diligence checklist.",
            steps=[AutomationStep(model_id="gpt-4o-mini")],
            created_by=user_id,
        )

    response = client.get(
        "/api/search",
        params={"q": "cobalt nebula"},
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    agents = _section(response.json(), "agent")
    automations = _section(response.json(), "automation")
    assert [item["id"] for item in agents] == ["agent-nebula-jane"]
    assert [item["id"] for item in automations] == ["automation-nebula-jane"]


def test_review_grid_search_is_owner_private_and_rechecks_source_access() -> None:
    created = client.post(
        "/api/review/matrices",
        headers=headers("user-jane"),
        json={
            "name": "Heliotrope covenant matrix",
            "knowledge_config_ids": ["knowledge-box-matters"],
            "document_ids": ["doc-box-complaint-outline"],
            "columns": [
                {
                    "id": "covenant",
                    "label": "Covenant",
                    "question": "Find the heliotrope covenant.",
                }
            ],
            "model_id": "gpt-4o-mini",
            "matter_id": None,
        },
    )
    assert created.status_code == 201, created.text

    jane = client.get(
        "/api/search",
        params={"q": "heliotrope"},
        headers=headers("user-jane"),
    )
    casey = client.get(
        "/api/search",
        params={"q": "heliotrope"},
        headers=headers("user-casey"),
    )

    assert jane.status_code == casey.status_code == 200
    reviews = _section(jane.json(), "review")
    assert [item["id"] for item in reviews] == [created.json()["id"]]
    assert reviews[0]["navigation"] == {
        "view": "review",
        "matrix_id": created.json()["id"],
    }
    assert _section(casey.json(), "review") == []

    get_store().knowledge_configs["knowledge-box-matters"].acl_group_ids = [
        "group-finance"
    ]
    revoked = client.get(
        "/api/search",
        params={"q": "heliotrope"},
        headers=headers("user-jane"),
    )
    assert revoked.status_code == 200
    assert _section(revoked.json(), "review") == []


def test_search_limit_is_applied_per_section_and_order_is_deterministic() -> None:
    for index in range(3):
        _save_thread(
            "user-jane",
            f"thread-limit-{index}",
            f"Quartz result {index}",
            "quartz",
        )

    response = client.get(
        "/api/search",
        params={"q": "quartz", "limit": 2},
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    chats = _section(response.json(), "chat")
    assert len(chats) == 2
    assert [item["title"] for item in chats] == ["Quartz result 0", "Quartz result 1"]
