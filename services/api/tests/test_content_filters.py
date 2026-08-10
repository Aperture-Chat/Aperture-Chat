from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)


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
    key_id = f"key-{provider_id}-content-filters"
    store.create_provider_key(
        key_id=key_id,
        provider=provider,
        name=f"{provider.name} Content Filters",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value=f"{provider.kind}-test-key",
    )


def mock_completion(monkeypatch: pytest.MonkeyPatch, content: str, seen_payloads: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen_payloads is not None:
            seen_payloads.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            json={
                "id": "gen-content-filter-test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )


BLOCK_FILTER_PAYLOAD = {
    "name": "Project codenames",
    "description": "Blocks mention of the confidential project codename.",
    "rules": [
        {
            "id": "codename",
            "label": "Project codename",
            "pattern": r"(?i)\bproject aurora\b",
            "action": "block",
            "applies_to": "input",
        }
    ],
}


def create_filter(payload: dict, user_id: str = "user-admin") -> dict:
    response = client.post("/api/admin/content-filters", json=payload, headers=headers(user_id))
    assert response.status_code == 201, response.text
    return response.json()


def attach_filters(model_id: str, filter_ids: list[str], user_id: str = "user-admin") -> dict:
    response = client.put(
        f"/api/admin/model-access/{model_id}/content-filters",
        json={"content_filter_ids": filter_ids},
        headers=headers(user_id),
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_admin_sees_builtin_presets_and_can_create_custom_filter() -> None:
    listing = client.get("/api/admin/content-filters", headers=headers("user-admin"))
    assert listing.status_code == 200
    builtin_ids = {item["id"] for item in listing.json() if item["builtin"]}
    assert builtin_ids == {"cf-preset-pii-hipaa", "cf-preset-financial"}

    created = create_filter(BLOCK_FILTER_PAYLOAD)
    assert created["builtin"] is False
    assert created["tenant_id"] == "tenant-example"

    refreshed = client.get("/api/admin/content-filters", headers=headers("user-admin")).json()
    assert any(item["id"] == created["id"] for item in refreshed)
    assert get_store().audit_events[-1].action == "admin.content_filter_created"


def test_filter_validation_rejects_broken_rules() -> None:
    bad_regex = {
        "name": "Broken",
        "rules": [{"id": "r1", "label": "Bad", "pattern": "([unclosed", "action": "redact", "applies_to": "input"}],
    }
    response = client.post("/api/admin/content-filters", json=bad_regex, headers=headers("user-admin"))
    assert response.status_code == 400
    assert "invalid pattern" in response.json()["detail"]

    no_rules = {"name": "Empty", "rules": []}
    response = client.post("/api/admin/content-filters", json=no_rules, headers=headers("user-admin"))
    assert response.status_code == 400

    empty_match = {
        "name": "Matches everything",
        "rules": [{"id": "r1", "label": "All", "pattern": "x*", "action": "redact", "applies_to": "input"}],
    }
    response = client.post("/api/admin/content-filters", json=empty_match, headers=headers("user-admin"))
    assert response.status_code == 400
    assert "empty text" in response.json()["detail"]


def test_builtin_presets_are_read_only() -> None:
    patch = client.patch(
        "/api/admin/content-filters/cf-preset-pii-hipaa",
        json={"name": "Renamed"},
        headers=headers("user-admin"),
    )
    assert patch.status_code == 403

    delete = client.delete("/api/admin/content-filters/cf-preset-pii-hipaa", headers=headers("user-admin"))
    assert delete.status_code == 403


def test_regular_user_cannot_manage_content_filters() -> None:
    response = client.get("/api/admin/content-filters", headers=headers("user-jane"))
    assert response.status_code == 403


def test_attaching_unknown_filter_is_rejected() -> None:
    response = client.put(
        "/api/admin/model-access/gpt-4o/content-filters",
        json={"content_filter_ids": ["cf-does-not-exist"]},
        headers=headers("user-admin"),
    )
    assert response.status_code == 404


def test_block_rule_refuses_request_before_provider_call(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    seen: list = []
    mock_completion(monkeypatch, "Should never be produced.", seen)

    created = create_filter(BLOCK_FILTER_PAYLOAD)
    attach_filters("gpt-4o", [created["id"]])

    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Summarize Project Aurora status."}],
        },
    )
    assert response.status_code == 400
    assert "Project codenames" in response.json()["detail"]
    assert seen == []  # blocked traffic never reaches the provider

    store = get_store()
    assert any(event.action == "security.content_filter_blocked" for event in store.audit_events)
    assert any(alert.rule_id.startswith("content-filter:") for alert in store.security_alerts.values())


def test_redact_rule_rewrites_input_before_provider_call(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    seen: list = []
    mock_completion(monkeypatch, "Understood.", seen)

    attach_filters("gpt-4o", ["cf-preset-pii-hipaa"])

    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Patient SSN is 123-45-6789, please file it."}],
        },
    )
    assert response.status_code == 200
    assert len(seen) == 1
    forwarded = json.dumps(seen[0], ensure_ascii=False)
    assert "123-45-6789" not in forwarded
    assert "[REDACTED · US Social Security number]" in forwarded
    assert any(event.action == "security.content_filter_redacted" for event in get_store().audit_events)


def test_output_redaction_non_streaming(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")
    mock_completion(monkeypatch, "The card on file is 4111 1111 1111 1111, do not share it.")

    attach_filters("gpt-4o", ["cf-preset-financial"])

    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "What card is on file?"}],
        },
    )
    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]
    assert "4111 1111 1111 1111" not in content
    assert "[REDACTED · Payment card number]" in content


def test_output_filter_buffers_stream_and_redacts_across_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")

    class FakeStreamingGateway:
        def stream(self, **_kwargs: object):
            # The card number is split across chunk boundaries on purpose.
            return iter(["Card: 4111 1111 ", "1111 1111 is on file."])

        def complete(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError("stream test must not call complete")

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeStreamingGateway())

    attach_filters("gpt-4o", ["cf-preset-financial"])

    response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={
            "model": "gpt-4o",
            "stream": True,
            "messages": [{"role": "user", "content": "What card is on file?"}],
        },
    )
    assert response.status_code == 200
    body = response.text
    assert "4111 1111" not in body
    delta_lines = [
        line
        for line in body.splitlines()
        if line.startswith("data: {")
        and "delta" in json.loads(line.removeprefix("data: "))
    ]
    assert len(delta_lines) == 1  # buffered: one screened delta, not raw chunks
    delta = json.loads(delta_lines[0].removeprefix("data: "))["delta"]
    assert "[REDACTED · Payment card number]" in delta
    assert "[DONE]" in body


def test_preview_reports_matches_without_persisting() -> None:
    response = client.post(
        "/api/admin/content-filters/preview",
        json={
            "rules": BLOCK_FILTER_PAYLOAD["rules"],
            "sample": "Notes on Project Aurora rollout.",
        },
        headers=headers("user-admin"),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["would_block"] is True
    assert body["matches"][0]["rule_id"] == "codename"
    assert get_store().content_filters == {}


def test_deleting_filter_detaches_it_from_models() -> None:
    created = create_filter(BLOCK_FILTER_PAYLOAD)
    attach_filters("gpt-4o", [created["id"]])
    assert get_store().models["gpt-4o"].content_filter_ids == [created["id"]]

    response = client.delete(f"/api/admin/content-filters/{created['id']}", headers=headers("user-admin"))
    assert response.status_code == 200
    assert get_store().models["gpt-4o"].content_filter_ids == []
