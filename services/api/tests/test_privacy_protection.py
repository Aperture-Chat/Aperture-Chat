"""Personal-data protection end to end, plus content-filter hardening.

Uses the seeded demo store through the app like the other route suites, with
a mocked provider transport so tests can prove exactly what reached the
model. All data is synthetic.
"""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import ChatCompletionRequest, ChatMessage, ChatThread
from app.repositories.deps import get_store
from app.routes.chat import _GatewayStreamScreen

client = TestClient(app)
SSN = "123-45-6789"
CARD = "4111 1111 1111 1111"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def activate_provider(provider_id: str) -> None:
    store = get_store()
    provider = store.providers[provider_id]
    provider.connected = True
    store.create_provider_key(
        key_id=f"key-{provider_id}-privacy",
        provider=provider,
        name=f"{provider.name} Privacy",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value=f"{provider.kind}-test-key",
    )


def mock_completion(monkeypatch: pytest.MonkeyPatch, content: str, seen: list) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            json={
                "id": "gen-privacy-test",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )


def enable_privacy(**overrides: object) -> dict:
    response = client.patch("/api/admin/privacy/policy", json={"enabled": True, **overrides}, headers=headers("user-admin"))
    assert response.status_code == 200, response.text
    return response.json()


def save_thread(user_id: str, thread_id: str, messages: list[dict], title: str = "Synthetic") -> dict:
    response = client.put(
        f"/api/chat/threads/{thread_id}",
        headers=headers(user_id),
        json={"title": title, "model_id": "gpt-4o", "messages": messages},
    )
    assert response.status_code == 200, response.text
    return response.json()


def message(message_id: str, role: str, content: str) -> dict:
    return {"id": message_id, "role": role, "content": content, "createdAt": "Now", "status": "ok"}


def test_policy_is_off_by_default_and_admin_only() -> None:
    policy = client.get("/api/admin/privacy/policy", headers=headers("user-admin")).json()
    assert policy["enabled"] is False and policy["conceal_from_model"] is True
    assert len(policy["categories"]) == 6
    assert client.get("/api/admin/privacy/policy", headers=headers("user-jane")).status_code == 403
    assert client.patch("/api/admin/privacy/policy", json={"enabled": True}, headers=headers("user-jane")).status_code == 403
    rejected = client.patch("/api/admin/privacy/policy", json={"categories": []}, headers=headers("user-admin"))
    assert rejected.status_code == 422


def test_preview_conceals_without_storing() -> None:
    response = client.post(
        "/api/admin/privacy/preview",
        headers=headers("user-admin"),
        json={"sample": f"SSN {SSN} and card {CARD}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["concealed_sample"] == "SSN ⟦SSN⟧ and card ⟦CARD NUMBER⟧"
    assert {item["id"] for item in body["detections"]} == {"ssn", "payment_card"}
    assert not any(SSN in json.dumps(event.metadata) for event in get_store().audit_events)


def test_saved_chats_and_their_traces_are_concealed() -> None:
    enable_privacy()
    saved = save_thread(
        "user-jane",
        "thread-privacy-save",
        [message("m1", "user", f"My SSN is {SSN}"), message("m2", "assistant", f"Noted. Card {CARD} too.")],
        title=f"SSN {SSN}",
    )
    assert saved["title"] == "SSN ⟦SSN⟧"
    assert saved["messages"][0]["content"] == "My SSN is ⟦SSN⟧"
    assert saved["messages"][1]["content"] == "Noted. Card ⟦CARD NUMBER⟧ too."
    stored = get_store().chat_threads.get("thread-privacy-save")
    assert SSN not in json.dumps(stored.model_dump(mode="json"))

    activity = client.get("/api/admin/prompt-activity?thread_id=thread-privacy-save", headers=headers("user-admin")).json()
    assert activity[0]["content"] == "My SSN is ⟦SSN⟧"

    feedback = client.post(
        "/api/chat/feedback",
        headers=headers("user-jane"),
        json={"thread_id": "thread-privacy-save", "message_id": "m2", "rating": "negative", "comment": f"Remove {SSN}"},
    ).json()
    assert feedback["comment"] == "Remove ⟦SSN⟧"
    listed = client.get("/api/admin/chat-feedback", headers=headers("user-admin")).json()
    assert all(SSN not in json.dumps(item) for item in listed)


def test_history_saved_before_protection_is_concealed_when_shown() -> None:
    store = get_store()
    jane = store.users["user-jane"]
    store.save_chat_thread(
        ChatThread(
            id="thread-legacy",
            tenant_id=jane.tenant_id,
            owner_user_id=jane.id,
            title="Legacy",
            model_id="gpt-4o",
            group_id="",
            updated_at="Earlier",
            messages=[ChatMessage(id="legacy-1", role="user", content=f"Old note {SSN}", createdAt="Earlier")],
        )
    )
    assert SSN in store.chat_threads.get("thread-legacy").messages[0].content
    enable_privacy()
    threads = client.get("/api/chat/threads", headers=headers("user-jane")).json()
    legacy = next(thread for thread in threads if thread["id"] == "thread-legacy")
    assert legacy["messages"][0]["content"] == "Old note ⟦SSN⟧"
    activity = client.get("/api/admin/prompt-activity?thread_id=thread-legacy", headers=headers("user-admin")).json()
    assert activity[0]["content"] == "Old note ⟦SSN⟧"


def test_model_receives_concealed_prompt_and_reply_is_concealed(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    enable_privacy()
    seen: list = []
    mock_completion(monkeypatch, f"Card on file: {CARD}.", seen)
    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": f"Client SSN {SSN}, draft a letter."}]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    forwarded = json.dumps(seen[0], ensure_ascii=False)
    assert SSN not in forwarded and "⟦SSN⟧" in forwarded
    assert body["choices"][0]["message"]["content"] == "Card on file: ⟦CARD NUMBER⟧."
    assert body["concealed_prompt"] == "Client SSN ⟦SSN⟧, draft a letter."
    concealed_events = [event for event in get_store().audit_events if event.action == "privacy.prompt_concealed"]
    assert concealed_events and SSN not in json.dumps(concealed_events[-1].metadata)


def test_model_can_be_allowed_to_read_values_that_are_still_concealed_in_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activate_provider("provider-azure")
    enable_privacy(conceal_from_model=False)
    seen: list = []
    mock_completion(monkeypatch, "Done.", seen)
    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": f"Fill the form with SSN {SSN}."}]},
    )
    assert response.status_code == 200
    assert SSN in json.dumps(seen[0])
    assert response.json()["concealed_prompt"] == "Fill the form with SSN ⟦SSN⟧."


def test_streamed_reply_is_concealed_with_a_privacy_event(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    enable_privacy()

    class FakeStreamingGateway:
        def stream(self, **_kwargs: object):
            return iter(["The card ", "is 4111 1111 ", "1111 1111", " and that is all."])

        def complete(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError("stream test must not call complete")

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeStreamingGateway())
    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "stream": True, "messages": [{"role": "user", "content": f"SSN {SSN}"}]},
    )
    assert response.status_code == 200
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: {")]
    assert events[0] == {"privacy": {"concealed_prompt": "SSN ⟦SSN⟧"}}
    streamed = "".join(event.get("delta", "") for event in events)
    assert streamed == "The card is ⟦CARD NUMBER⟧ and that is all."
    assert "4111" not in response.text


def test_drafts_are_not_rewritten(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    enable_privacy()
    seen: list = []
    mock_completion(monkeypatch, "Revised draft.", seen)
    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "surface": "draft", "messages": [{"role": "user", "content": f"Exhibit A lists {SSN}."}]},
    )
    assert response.status_code == 200
    assert SSN in json.dumps(seen[0])


def test_attachment_text_cannot_bypass_the_pii_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    seen: list = []
    mock_completion(monkeypatch, "Summary ready.", seen)
    attached = client.put(
        "/api/admin/model-access/gpt-4o/content-filters",
        json={"content_filter_ids": ["cf-preset-pii-hipaa"]},
        headers=headers("user-admin"),
    )
    assert attached.status_code == 200
    upload = client.post(
        "/api/chat/attachments",
        files={"file": ("intake.txt", f"Patient intake. SSN {SSN}. MRN: 00482913.".encode(), "text/plain")},
        headers=headers("user-jane"),
    )
    assert upload.status_code == 200, upload.text
    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Summarize the attached intake."}],
            "attachment_ids": [upload.json()["id"]],
        },
    )
    assert response.status_code == 200, response.text
    forwarded = json.dumps(seen[0], ensure_ascii=False)
    assert SSN not in forwarded and "00482913" not in forwarded
    assert "[REDACTED · US Social Security number]" in forwarded


def test_gateway_stream_screen_conceals_and_filters_proxied_chunks() -> None:
    store = get_store()
    actor = store.users["user-jane"]
    model = store.models["gpt-4o"]
    request = ChatCompletionRequest(model="gpt-4o", messages=[{"role": "user", "content": "hi"}], stream=True)

    screen = _GatewayStreamScreen(store, actor, request, model, {"privacy_enabled": True, "privacy_categories": ["financial"]})
    chunks = [
        {"choices": [{"index": 0, "delta": {"content": "Card 4111 1111 "}, "finish_reason": None}]},
        {"choices": [{"index": 0, "delta": {"content": "1111 1111."}, "finish_reason": None}]},
        {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0}]}, "finish_reason": "stop"}]},
    ]
    text = ""
    for chunk in chunks:
        screen.apply(chunk)
        text += chunk["choices"][0]["delta"].get("content", "")
    assert text == "Card ⟦CARD NUMBER⟧."
    assert chunks[2]["choices"][0]["delta"]["tool_calls"] == [{"index": 0}]

    model.content_filter_ids = ["cf-preset-pii-hipaa"]
    buffered = _GatewayStreamScreen(store, actor, request, model, {})
    first = {"choices": [{"index": 0, "delta": {"content": f"SSN {SSN}"}, "finish_reason": None}]}
    buffered.apply(first)
    assert first["choices"][0]["delta"]["content"] == ""
    closing = buffered.closing_chunks("gpt-4o")
    assert SSN not in json.dumps(closing) and "REDACTED" in json.dumps(closing)


def test_content_filter_hardening_validators_and_evasion() -> None:
    response = client.post(
        "/api/admin/content-filters/preview",
        headers=headers("user-admin"),
        json={
            "rules": [
                {"id": "card", "label": "Card", "pattern": r"(?:\d[ -]?){12,18}\d", "action": "redact", "validator": "luhn"},
                {"id": "ssn", "label": "SSN", "pattern": r"\d{3}-\d{2}-\d{4}", "action": "redact"},
            ],
            "sample": "Card 4111 1111 1111 1111, order 1234 5678 9012 3456, SSN 1​23–45-6789",
        },
    )
    assert response.status_code == 200, response.text
    sample = response.json()["redacted_sample"]
    assert "order 1234 5678 9012 3456" in sample
    assert "4111" not in sample and "6789" not in sample
    bad = client.post(
        "/api/admin/content-filters",
        headers=headers("user-admin"),
        json={"name": "Bad", "rules": [{"id": "x", "label": "X", "pattern": r"\d+", "validator": "nope"}]},
    )
    assert bad.status_code in (400, 422)


def test_stored_content_filters_saved_before_validators_still_load() -> None:
    from app.models.schemas import ContentFilter
    from app.repositories.identity_config_sql import _model_from_payload

    legacy = {
        "id": "cf-custom-legacy",
        "tenant_id": "tenant-example",
        "name": "Legacy codenames",
        "description": "",
        "builtin": False,
        "rules": [
            {"id": "codename", "label": "Codename", "pattern": "aurora", "action": "redact", "applies_to": "input"}
        ],
        "created_by": None,
        "updated_at": "Just now",
    }
    loaded = _model_from_payload(ContentFilter, legacy, "content_filters")
    assert loaded.rules[0].validator is None


def test_search_and_retention_views_never_surface_raw_values() -> None:
    store = get_store()
    jane = store.users["user-jane"]
    store.save_chat_thread(
        ChatThread(
            id="thread-search-legacy",
            tenant_id=jane.tenant_id,
            owner_user_id=jane.id,
            title=f"Saffron intake {SSN}",
            model_id="gpt-4o",
            group_id="",
            updated_at="Earlier",
            messages=[ChatMessage(id="search-1", role="user", content=f"Saffron comet client SSN {SSN}", createdAt="Earlier")],
        )
    )
    enable_privacy()

    # Searching for the raw value finds nothing: results are scored on the
    # concealed copy (only the person's own query is echoed back).
    probe = client.get("/api/search", params={"q": SSN}, headers=headers("user-jane")).json()
    assert all(section["results"] == [] for section in probe["sections"] if section["kind"] == "chat")
    found = client.get("/api/search", params={"q": "saffron comet"}, headers=headers("user-jane")).json()
    chats = next(section["results"] for section in found["sections"] if section["kind"] == "chat")
    assert chats and SSN not in json.dumps(chats)

    listed = client.get("/api/admin/retention/threads", headers=headers("user-admin")).json()
    row = next(item for item in listed if item["thread_id"] == "thread-search-legacy")
    assert row["title"] == "Saffron intake ⟦SSN⟧"


def _enable_api_access(user_id: str) -> None:
    store = get_store()
    store.platform_settings.downstream_api_enabled = True
    for group_id in store.users[user_id].group_ids:
        store.groups[group_id].permissions["api_access"] = True


def test_draft_surface_cannot_bypass_protection_on_the_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    enable_privacy()
    _enable_api_access("user-jane")
    seen: list = []
    mock_completion(monkeypatch, "Done.", seen)
    response = client.post(
        "/v1/chat/completions",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "surface": "draft", "messages": [{"role": "user", "content": f"SSN {SSN}"}]},
    )
    assert response.status_code == 200, response.text
    assert SSN not in json.dumps(seen[0])


def test_workspace_draft_requests_with_personal_data_are_audited(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    enable_privacy()
    seen: list = []
    mock_completion(monkeypatch, "Revised draft.", seen)
    client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "surface": "draft", "messages": [{"role": "user", "content": f"Exhibit lists {SSN}."}]},
    )
    events = [event for event in get_store().audit_events if event.action == "privacy.draft_not_concealed"]
    assert events and SSN not in json.dumps(events[-1].metadata)


def test_another_organizations_thread_cannot_switch_protection_off(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    enable_privacy()
    store = get_store()
    created = client.post(
        "/api/platform/tenants",
        headers=headers("user-owner"),
        json={"name": "Synthetic Other Org", "slug": "synthetic-other-org"},
    )
    assert created.status_code == 201, created.text
    other_tenant = created.json()["id"]
    store.save_chat_thread(
        ChatThread(
            id="thread-other-org",
            tenant_id=other_tenant,
            owner_user_id="user-owner",
            title="Elsewhere",
            model_id="gpt-4o",
            group_id="",
            updated_at="Now",
            messages=[],
        )
    )
    seen: list = []
    mock_completion(monkeypatch, "Done.", seen)
    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "thread_id": "thread-other-org", "messages": [{"role": "user", "content": f"SSN {SSN}"}]},
    )
    from app.routes.chat import _privacy_tenant_id

    probe = ChatCompletionRequest(model="gpt-4o", messages=[], thread_id="thread-other-org")
    assert _privacy_tenant_id(store, store.users["user-jane"], probe) == store.users["user-jane"].tenant_id
    # The caller's own organization decides; either the request is refused
    # outright or the provider sees only the placeholder.
    assert (response.status_code >= 400 and not seen) or (seen and SSN not in json.dumps(seen[0])), response.text


def test_attachment_previews_and_citation_snippets_in_saved_chats_are_concealed() -> None:
    enable_privacy()
    saved = save_thread(
        "user-jane",
        "thread-attachment-copy",
        [
            {
                **message("m1", "user", "See attached"),
                "attachments": [
                    {"id": "att-1", "name": f"intake {SSN}.txt", "kind": "Document", "size": "1 KB", "text_preview": f"SSN {SSN}"}
                ],
            },
            {
                **message("m2", "assistant", "Summary [K1]"),
                "citations": [
                    {"id": "c1", "source_name": "Intake", "source_type": "knowledge", "source_uri": "knowledge://x", "snippet": f"card {CARD}"}
                ],
            },
        ],
    )
    dumped = json.dumps(saved)
    assert SSN not in dumped and "4111" not in dumped


def test_concealing_older_history_does_not_reset_its_retention_clock() -> None:
    save_thread("user-jane", "thread-clock", [message("clock-1", "user", f"Old {SSN}")], title="Clock")

    def activity() -> str:
        rows = client.get("/api/admin/retention/threads", headers=headers("user-admin")).json()
        return next(row for row in rows if row["thread_id"] == "thread-clock")["last_activity_at"]

    before = activity()
    enable_privacy()
    shown = next(t for t in client.get("/api/chat/threads", headers=headers("user-jane")).json() if t["id"] == "thread-clock")
    # The client re-saves what it was shown (concealed) with only a pin change.
    response = client.put(
        "/api/chat/threads/thread-clock",
        headers=headers("user-jane"),
        json={"title": shown["title"], "model_id": "gpt-4o", "pinned": True, "messages": shown["messages"]},
    )
    assert response.status_code == 200
    assert activity() == before
    assert SSN not in json.dumps(get_store().chat_threads.get("thread-clock").model_dump(mode="json"))


def test_memories_are_concealed_when_captured() -> None:
    from app.core.memory_capture import capture_explicit_memories
    from app.models.schemas import TenantMemoryPolicy

    enable_privacy()
    store = get_store()
    jane = store.users["user-jane"]
    saved = capture_explicit_memories(
        store,
        jane,
        "Remember that my assistant's email is pat.rivera@example.org",
        policy=TenantMemoryPolicy(tenant_id=jane.tenant_id, enabled=True),
        thread_id=None,
    )
    # Concealed, the note would read "my assistant's email is ⟦EMAIL⟧", which
    # is useless as a memory, so nothing is stored at all.
    assert all("pat.rivera" not in memory.content for memory in saved)
    assert all("pat.rivera" not in memory.content for memory in store.user_memories.values())
    assert all("⟦" not in memory.content for memory in store.user_memories.values())


def test_gateway_stream_screen_conceals_or_withholds_reasoning() -> None:
    store = get_store()
    actor = store.users["user-jane"]
    model = store.models["gpt-4o"]
    request = ChatCompletionRequest(model="gpt-4o", messages=[{"role": "user", "content": "hi"}], stream=True)
    screen = _GatewayStreamScreen(store, actor, request, model, {"privacy_enabled": True, "privacy_categories": ["identity"]})
    chunk = {
        "choices": [
            {
                "index": 0,
                "delta": {"reasoning": f"The SSN is {SSN}.", "reasoning_details": [{"text": SSN}]},
                "finish_reason": "stop",
            }
        ]
    }
    screen.apply(chunk)
    delta = chunk["choices"][0]["delta"]
    assert delta["reasoning"] == "The SSN is ⟦SSN⟧."
    assert "reasoning_details" not in delta


def test_feedback_preview_conceals_before_truncating() -> None:
    enable_privacy()
    long_reply = "x " * 133 + f"card {CARD} end"
    save_thread("user-jane", "thread-preview-cut", [message("m1", "user", "Hi"), message("m2", "assistant", long_reply)])
    record = client.post(
        "/api/chat/feedback",
        headers=headers("user-jane"),
        json={"thread_id": "thread-preview-cut", "message_id": "m2", "rating": "positive"},
    ).json()
    assert "4111" not in record["message_preview"] and "1111 1111" not in record["message_preview"]
