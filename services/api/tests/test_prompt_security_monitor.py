from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import Role, SecurityAlert, User
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
    key_id = f"key-{provider_id}-prompt-monitor"
    store.create_provider_key(
        key_id=key_id,
        provider=provider,
        name=f"{provider.name} Prompt Monitor",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value=f"{provider.kind}-test-key",
    )


def test_owner_can_drill_into_user_prompts_and_acknowledge_dlp_alert(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider("provider-azure")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-prompt-monitor",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Recorded for review."},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )

    prompt = "Please analyze SSN 123-45-6789 for this matter."
    completion_response = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": prompt}],
            "thread_id": "thread-jane-dlp",
        },
    )
    assert completion_response.status_code == 200

    save_response = client.put(
        "/api/chat/threads/thread-jane-dlp",
        headers=headers("user-jane"),
        json={
            "tenant_id": "tenant-example",
            "title": "Matter intake DLP check",
            "model_id": "gpt-4o",
            "group_id": "group-litigation",
            "updated_at": "Jul 6, 2026, 5:00 PM UTC",
            "messages": [
                {
                    "id": "message-jane-dlp",
                    "role": "user",
                    "content": prompt,
                    "createdAt": "Jul 6, 2026, 5:00 PM UTC",
                    "createdAtIso": "2026-07-06T23:00:00+00:00",
                },
                {
                    "id": "message-jane-dlp-response",
                    "role": "assistant",
                    "content": "Recorded for review.",
                    "createdAt": "Jul 6, 2026, 5:00 PM UTC",
                    "createdAtIso": "2026-07-06T23:00:01+00:00",
                }
            ],
        },
    )
    assert save_response.status_code == 200

    alerts_response = client.get(
        "/api/platform/security-alerts?user_id=user-jane",
        headers=headers("user-owner"),
    )
    assert alerts_response.status_code == 200
    alerts = alerts_response.json()
    assert len(alerts) == 1
    alert = alerts[0]
    assert alert["rule_id"] == "ssn"
    assert alert["user_id"] == "user-jane"
    assert alert["thread_id"] == "thread-jane-dlp"
    assert "123-45-6789" not in alert["snippet"]

    prompt_response = client.get(
        "/api/platform/prompt-activity?user_id=user-jane",
        headers=headers("user-owner"),
    )
    assert prompt_response.status_code == 200
    prompt_records = prompt_response.json()
    assert prompt_records[0]["thread_title"] == "Matter intake DLP check"
    assert prompt_records[0]["content"] == prompt
    assert prompt_records[0]["user_role"] == "USER"
    assert prompt_records[0]["response_message_id"] == "message-jane-dlp-response"
    assert prompt_records[0]["response_content"] == "Recorded for review."
    assert prompt_records[0]["response_status"] == "ok"
    assert prompt_records[0]["response_truncated"] is False
    assert prompt_records[0]["alert_count"] == 1

    admin_blocked = client.get(
        "/api/platform/security-alerts?user_id=user-jane",
        headers=headers("user-admin"),
    )
    assert admin_blocked.status_code == 403

    owner_save_response = client.put(
        "/api/chat/threads/thread-owner-private",
        headers=headers("user-owner"),
        json={
            "tenant_id": "tenant-example",
            "title": "Owner private governance",
            "model_id": "gpt-4o",
            "group_id": "group-litigation",
            "updated_at": "Jul 6, 2026, 6:00 PM UTC",
            "messages": [
                {
                    "id": "message-owner-private",
                    "role": "user",
                    "content": "Owner private platform query.",
                    "createdAt": "Jul 6, 2026, 6:00 PM UTC",
                    "createdAtIso": "2026-07-07T00:00:00+00:00",
                }
            ],
        },
    )
    assert owner_save_response.status_code == 200
    get_store().record_security_alert(
        SecurityAlert(
            id="alert-owner-private",
            tenant_id="tenant-example",
            user_id="user-owner",
            user_name="Aperture Platform Owner",
            rule_id="owner-private",
            rule_label="Owner private alert",
            category="dlp",
            severity="high",
            snippet="Owner private platform query.",
            model_id="gpt-4o",
            thread_id="thread-owner-private",
        )
    )

    admin_prompt_response = client.get(
        "/api/admin/prompt-activity",
        headers=headers("user-admin"),
    )
    assert admin_prompt_response.status_code == 200
    admin_prompt_records = admin_prompt_response.json()
    assert any(record["user_id"] == "user-jane" for record in admin_prompt_records)
    assert all(record["user_id"] != "user-owner" for record in admin_prompt_records)

    admin_owner_prompt_response = client.get(
        "/api/admin/prompt-activity?user_id=user-owner",
        headers=headers("user-admin"),
    )
    assert admin_owner_prompt_response.status_code == 404

    admin_alerts_response = client.get(
        "/api/admin/security-alerts",
        headers=headers("user-admin"),
    )
    assert admin_alerts_response.status_code == 200
    admin_alerts = admin_alerts_response.json()
    assert any(item["user_id"] == "user-jane" for item in admin_alerts)
    assert all(item["user_id"] != "user-owner" for item in admin_alerts)

    admin_owner_alert_response = client.patch(
        "/api/admin/security-alerts/alert-owner-private",
        headers=headers("user-admin"),
        json={"acknowledged": True},
    )
    assert admin_owner_alert_response.status_code == 404

    admin_acknowledge_response = client.patch(
        f"/api/admin/security-alerts/{alert['id']}",
        headers=headers("user-admin"),
        json={"acknowledged": True},
    )
    assert admin_acknowledge_response.status_code == 200
    assert admin_acknowledge_response.json()["acknowledged"] is True

    acknowledge_response = client.patch(
        f"/api/platform/security-alerts/{alert['id']}",
        headers=headers("user-owner"),
        json={"acknowledged": True},
    )
    assert acknowledge_response.status_code == 200
    assert acknowledge_response.json()["acknowledged"] is True
    assert get_store().audit_events[-1].action == "security.alert_acknowledged"

    refreshed_prompts = client.get(
        "/api/platform/prompt-activity?user_id=user-jane",
        headers=headers("user-owner"),
    ).json()
    assert refreshed_prompts[0]["alert_count"] == 0


def test_prompt_output_visibility_respects_owner_and_admin_boundaries() -> None:
    store = get_store()
    store.users["user-owner-two"] = User(
        id="user-owner-two",
        email="owner-two@aperture.local",
        display_name="Second Platform Owner",
        role=Role.PLATFORM_OWNER,
        auth_method="local",
    )

    def save_prompt(owner_id: str, suffix: str, response: str) -> None:
        payload: dict[str, object] = {
            "title": f"{suffix} audit thread",
            "model_id": "gpt-4o",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": f"prompt-{suffix}",
                    "role": "user",
                    "content": f"Prompt from {suffix}",
                    "createdAt": "Jul 9, 2026, 8:00 PM UTC",
                    "createdAtIso": "2026-07-10T02:00:00+00:00",
                },
                {
                    "id": f"response-{suffix}",
                    "role": "assistant",
                    "content": response,
                    "createdAt": "Jul 9, 2026, 8:00 PM UTC",
                    "createdAtIso": "2026-07-10T02:00:01+00:00",
                },
            ],
        }
        if store.users[owner_id].role == Role.PLATFORM_OWNER:
            payload["tenant_id"] = "tenant-example"
        saved = client.put(
            f"/api/chat/threads/thread-{suffix}",
            headers=headers(owner_id),
            json=payload,
        )
        assert saved.status_code == 200

    save_prompt("user-owner", "owner-self", "Owner response")
    save_prompt("user-owner-two", "owner-other", "Other owner response")
    save_prompt("user-admin", "admin-alex", "Alex admin response")
    save_prompt(
        "user-drew",
        "admin-drew",
        "Drew admin response\n\n"
        "![Generated image](/api/chat/generated-images/audit-image-test.jpg?token=stale-token)",
    )
    save_prompt("user-jane", "user-jane", "J" * 12_001)

    owner_records = client.get(
        "/api/platform/prompt-activity", headers=headers("user-owner")
    )
    assert owner_records.status_code == 200
    owner_by_user = {record["user_id"]: record for record in owner_records.json()}
    # Owners audit each other: a platform owner sees every user's prompts and
    # outputs, peer platform owners included.
    assert set(owner_by_user) == {
        "user-owner",
        "user-owner-two",
        "user-admin",
        "user-drew",
        "user-jane",
    }
    assert owner_by_user["user-admin"]["response_content"] == "Alex admin response"
    assert len(owner_by_user["user-jane"]["response_content"]) == 12_000
    assert owner_by_user["user-jane"]["response_truncated"] is True
    assert owner_by_user["user-owner-two"]["response_content"] == "Other owner response"
    # Generated images in saved outputs are re-signed at read time so the
    # auditor can view them even after the persisted link token expired.
    drew_images = owner_by_user["user-drew"]["response_images"]
    assert len(drew_images) == 1
    assert drew_images[0].startswith("/api/chat/generated-images/audit-image-test.jpg?token=")
    assert "stale-token" not in drew_images[0]
    assert owner_by_user["user-admin"]["response_images"] == []
    peer_owner_drilldown = client.get(
        "/api/platform/prompt-activity?user_id=user-owner-two",
        headers=headers("user-owner"),
    )
    assert peer_owner_drilldown.status_code == 200
    assert {record["user_id"] for record in peer_owner_drilldown.json()} == {"user-owner-two"}

    alex_records = client.get(
        "/api/admin/prompt-activity", headers=headers("user-admin")
    )
    assert alex_records.status_code == 200
    assert {record["user_id"] for record in alex_records.json()} == {
        "user-admin",
        "user-jane",
    }
    assert all(record["response_content"] for record in alex_records.json())
    assert client.get(
        "/api/admin/prompt-activity?user_id=user-drew",
        headers=headers("user-admin"),
    ).status_code == 404

    drew_records = client.get(
        "/api/admin/prompt-activity", headers=headers("user-drew")
    )
    assert {record["user_id"] for record in drew_records.json()} == {
        "user-drew",
        "user-jane",
    }


def test_prompt_activity_thread_filter_returns_full_conversation() -> None:
    """The audit preview drills into one thread: the thread_id filter returns
    every exchange of that conversation and nothing else, and the visibility
    boundaries still hold when a hidden thread is requested directly."""

    saved = client.put(
        "/api/chat/threads/thread-jane-multi",
        headers=headers("user-jane"),
        json={
            "title": "Jane multi-turn matter review",
            "model_id": "gpt-4o",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "prompt-jane-multi-1",
                    "role": "user",
                    "content": "First question about the intake form.",
                    "createdAt": "Jul 9, 2026, 8:00 PM UTC",
                    "createdAtIso": "2026-07-10T02:00:00+00:00",
                },
                {
                    "id": "response-jane-multi-1",
                    "role": "assistant",
                    "content": "First saved answer.",
                    "createdAt": "Jul 9, 2026, 8:00 PM UTC",
                    "createdAtIso": "2026-07-10T02:00:01+00:00",
                },
                {
                    "id": "prompt-jane-multi-2",
                    "role": "user",
                    "content": "Second question about retention.",
                    "createdAt": "Jul 9, 2026, 8:05 PM UTC",
                    "createdAtIso": "2026-07-10T02:05:00+00:00",
                },
                {
                    "id": "response-jane-multi-2",
                    "role": "assistant",
                    "content": "Second saved answer.",
                    "createdAt": "Jul 9, 2026, 8:05 PM UTC",
                    "createdAtIso": "2026-07-10T02:05:01+00:00",
                },
            ],
        },
    )
    assert saved.status_code == 200
    noise = client.put(
        "/api/chat/threads/thread-jane-noise",
        headers=headers("user-jane"),
        json={
            "title": "Jane unrelated thread",
            "model_id": "gpt-4o",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "prompt-jane-noise-1",
                    "role": "user",
                    "content": "Unrelated question.",
                    "createdAt": "Jul 9, 2026, 9:00 PM UTC",
                    "createdAtIso": "2026-07-10T03:00:00+00:00",
                },
            ],
        },
    )
    assert noise.status_code == 200

    owner_response = client.get(
        "/api/platform/prompt-activity?thread_id=thread-jane-multi",
        headers=headers("user-owner"),
    )
    assert owner_response.status_code == 200
    owner_rows = owner_response.json()
    assert [row["id"] for row in owner_rows] == [
        "prompt-jane-multi-2",
        "prompt-jane-multi-1",
    ]
    assert all(row["thread_id"] == "thread-jane-multi" for row in owner_rows)
    assert owner_rows[0]["response_content"] == "Second saved answer."
    assert owner_rows[1]["response_content"] == "First saved answer."

    admin_response = client.get(
        "/api/admin/prompt-activity?thread_id=thread-jane-multi",
        headers=headers("user-admin"),
    )
    assert admin_response.status_code == 200
    assert [row["id"] for row in admin_response.json()] == [
        "prompt-jane-multi-2",
        "prompt-jane-multi-1",
    ]

    # An owner-owned thread stays invisible to tenant admins even when
    # requested directly by thread id.
    owner_thread = client.put(
        "/api/chat/threads/thread-owner-direct",
        headers=headers("user-owner"),
        json={
            "tenant_id": "tenant-example",
            "title": "Owner direct thread",
            "model_id": "gpt-4o",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "prompt-owner-direct-1",
                    "role": "user",
                    "content": "Owner-only question.",
                    "createdAt": "Jul 9, 2026, 9:30 PM UTC",
                    "createdAtIso": "2026-07-10T03:30:00+00:00",
                },
            ],
        },
    )
    assert owner_thread.status_code == 200
    hidden = client.get(
        "/api/admin/prompt-activity?thread_id=thread-owner-direct",
        headers=headers("user-admin"),
    )
    assert hidden.status_code == 200
    assert hidden.json() == []

    # Group-scoped admin visibility also applies to the thread drilldown:
    # Drew cannot pull Alex's conversation by thread id.
    admin_thread = client.put(
        "/api/chat/threads/thread-admin-direct",
        headers=headers("user-admin"),
        json={
            "title": "Alex admin direct thread",
            "model_id": "gpt-4o",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "prompt-admin-direct-1",
                    "role": "user",
                    "content": "Alex admin question.",
                    "createdAt": "Jul 9, 2026, 9:45 PM UTC",
                    "createdAtIso": "2026-07-10T03:45:00+00:00",
                },
            ],
        },
    )
    assert admin_thread.status_code == 200
    drew_hidden = client.get(
        "/api/admin/prompt-activity?thread_id=thread-admin-direct",
        headers=headers("user-drew"),
    )
    assert drew_hidden.status_code == 200
    assert drew_hidden.json() == []
