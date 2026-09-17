"""Retention lifecycle boundaries with synthetic data and authoritative clocks."""

from datetime import UTC, datetime, timedelta
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from app.core.retention_governance import detected_tags, retention_pass
from app.db.orm import ChatThreadRow
from app.main import app
from app.models.schemas import (
    ChatMessage,
    ChatThread,
    ChatThreadTag,
    RetentionRule,
    RetentionSource,
    TenantRetentionPolicy,
)
from app.repositories.application_state import RetentionDeletedError
from app.repositories.deps import get_store

client = TestClient(app)
HEADERS = {"x-aperture-user": "user-admin"}
NOW = datetime(2026, 9, 17, tzinfo=UTC)


def test_legacy_sql_policy_loads_inactive_without_weakening_canonical_validation():
    from app.repositories.identity_config_sql import (
        IdentityConfigCorruptionError,
        _model_from_payload,
    )

    old = TenantRetentionPolicy(tenant_id="synthetic", enabled=True, chat_retention_days=365).model_dump(mode="json")
    for field in ("automation_enabled", "sensitive_tagging_enabled", "sources"):
        old.pop(field)
    loaded = _model_from_payload(TenantRetentionPolicy, old, "tenant_retention_policies")
    assert loaded.automation_enabled is False
    assert loaded.sensitive_tagging_enabled is False
    assert loaded.sources == []
    assert loaded.enabled is True
    assert loaded.chat_retention_days == 365
    for extra in ({"unexpected": True}, {"automation_enabled": "false"}):
        with pytest.raises(IdentityConfigCorruptionError):
            _model_from_payload(TenantRetentionPolicy, {**old, **extra}, "tenant_retention_policies")


@pytest.fixture(autouse=True)
def reset():
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def thread(store, identity="retention-example", *, age=3000, tenant=None, text="Synthetic records"):
    tenant = tenant or store.users["user-admin"].tenant_id
    saved = store.save_chat_thread(
        ChatThread(
            id=identity,
            tenant_id=tenant,
            owner_user_id="user-admin",
            title="Synthetic client work",
            model_id="model-synthetic",
            group_id="group-synthetic",
            updated_at="Now",
            messages=[ChatMessage(id="m1", role="user", content=text, createdAt="Now")],
        )
    )
    store.application_state_repository.run_transaction(
        lambda session: session.execute(
            update(ChatThreadRow)
            .where(ChatThreadRow.id == identity)
            .values(
                created_at=NOW - timedelta(days=age), last_activity_at=NOW - timedelta(days=age)
            )
        )
    )
    return saved


def policy(store, **changes):
    value = TenantRetentionPolicy(
        tenant_id=store.users["user-admin"].tenant_id,
        enabled=True,
        automation_enabled=True,
        chat_retention_days=2555,
        grace_days=7,
        updated_at=NOW.isoformat(),
    )
    return store.save_tenant_retention_policy(value.model_copy(update=changes))


def test_default_and_legacy_policy_never_delete():
    store = get_store()
    saved = thread(store)
    assert store.tenant_retention_policy(saved.tenant_id).enabled is False
    retention_pass(store, NOW + timedelta(days=30))
    assert saved.id in store.chat_threads
    policy(store, automation_enabled=False)
    retention_pass(store, NOW + timedelta(days=30))
    assert saved.id in store.chat_threads


def test_complete_lifecycle_grace_atomic_audit_and_tombstone():
    store = get_store()
    saved = thread(store)
    policy(store)
    assert retention_pass(store, NOW)["reviewing"] == 1
    assert retention_pass(store, NOW + timedelta(days=6))["deleted"] == 0
    assert retention_pass(store, NOW + timedelta(days=8))["deleted"] == 1
    assert saved.id not in store.chat_threads
    assert any(
        e.action == "retention.chat_deleted" and e.target == saved.id
        for e in store.audit_events_newest_first()
    )
    with pytest.raises(RetentionDeletedError):
        store.save_chat_thread(saved)


def test_longer_shorter_forever_and_revision_restart():
    store = get_store()
    saved = thread(store)
    policy(store)
    retention_pass(store, NOW)
    policy(store, chat_retention_days=3650, updated_at=(NOW + timedelta(days=8)).isoformat())
    assert retention_pass(store, NOW + timedelta(days=8))["deleted"] == 0
    policy(store, chat_retention_days=365, updated_at=(NOW + timedelta(days=9)).isoformat())
    assert retention_pass(store, NOW + timedelta(days=10))["deleted"] == 0
    policy(store, enabled=False, automation_enabled=False)
    assert retention_pass(store, NOW + timedelta(days=100))["deleted"] == 0
    assert saved.id in store.chat_threads


def test_holds_block_manual_and_automatic_and_release_restarts_review():
    store = get_store()
    saved = thread(store)
    policy(store)
    retention_pass(store, NOW)
    response = client.post(
        "/api/admin/retention/holds",
        headers=HEADERS,
        json={"name": "Synthetic legal hold", "thread_ids": [saved.id]},
    )
    assert response.status_code == 200
    assert store.delete_chat_thread(saved.id) is None
    assert client.delete(f"/api/chat/threads/{saved.id}", headers=HEADERS).status_code == 409
    assert retention_pass(store, NOW + timedelta(days=15))["deleted"] == 0
    response = client.post(
        f"/api/admin/retention/holds/{response.json()['id']}/release", headers=HEADERS
    )
    assert response.status_code == 200
    assert retention_pass(store, NOW + timedelta(days=16))["reviewing"] == 1
    assert retention_pass(store, NOW + timedelta(days=17))["deleted"] == 0


def test_metadata_save_does_not_reset_age_but_message_change_does():
    store = get_store()
    saved = thread(store)

    def activity():
        return store.application_state_repository.retention_overview(
            store.tenant_retention_policy(saved.tenant_id)
        )[saved.id]["last_activity_at"]

    before = activity()
    store.save_chat_thread(saved.model_copy(update={"title": "Renamed"}))
    assert before == activity()
    store.save_chat_thread(
        saved.model_copy(
            update={
                "messages": [
                    *saved.messages,
                    ChatMessage(id="m2", role="user", content="New message", createdAt="Now"),
                ]
            }
        )
    )
    assert activity() > before


def test_alias_matching_late_messages_and_pii_values_not_copied():
    source = RetentionSource(id="client-1042", name="Northwind Industries", aliases=["Client 1042"])
    value = TenantRetentionPolicy(
        tenant_id="synthetic", sources=[source], sensitive_tagging_enabled=True
    )
    found = detected_tags(
        value,
        [
            "Unrelated start",
            "Review CLIENT 1042. SSN 123-45-6789. Card 4111 1111 1111 1111. office@example.test",
        ],
    )
    assert ("suggested_client", source.id, source.name) in found
    assert {key for namespace, key, label in found if namespace == "suggested_sensitive"} == {
        "ssn",
        "payment_card",
        "email",
    }
    assert "123-45-6789" not in str(found) and "4111" not in str(found)
    assert not detected_tags(value, ["Client 10420 unrelated"])


def test_unconfirmed_label_cannot_trigger_purge_and_forever_rule_wins():
    store = get_store()
    saved = thread(store)
    value = policy(
        store,
        chat_retention_days=0,
        rules=[
            RetentionRule(id="r", tag_namespace="client", tag_key="client-a", retention_days=365)
        ],
    )
    tag = ChatThreadTag(
        id="tag-a",
        tenant_id=saved.tenant_id,
        thread_id=saved.id,
        namespace="suggested_client",
        key="client-a",
        source="auto",
        applied_at=NOW,
    )
    store.apply_chat_thread_tag(tag)
    assert not store.application_state_repository.retention_overview(value, now=NOW)[saved.id][
        "eligible"
    ]
    store.apply_chat_thread_tag(
        tag.model_copy(update={"id": "confirmed", "namespace": "client", "source": "manual"})
    )
    assert store.application_state_repository.retention_overview(value, now=NOW)[saved.id][
        "eligible"
    ]
    value = policy(
        store,
        chat_retention_days=365,
        rules=[RetentionRule(id="f", tag_namespace="client", tag_key="client-a", retention_days=0)],
    )
    assert not store.application_state_repository.retention_overview(value, now=NOW)[saved.id][
        "eligible"
    ]


def test_preview_required_exact_and_default_off_can_save_without_preview():
    store = get_store()
    thread(store)
    patch = {
        "enabled": True,
        "automation_enabled": True,
        "chat_retention_days": 2555,
        "grace_days": 7,
    }
    assert (
        client.patch("/api/admin/retention/policy", headers=HEADERS, json=patch).status_code == 409
    )
    response = client.post("/api/admin/retention/preview", headers=HEADERS, json=patch)
    assert response.status_code == 200
    token = response.json()["preview_token"]
    assert (
        client.patch(
            "/api/admin/retention/policy",
            headers=HEADERS,
            json={**patch, "chat_retention_days": 365, "preview_token": token},
        ).status_code
        == 409
    )
    assert (
        client.patch(
            "/api/admin/retention/policy", headers=HEADERS, json={**patch, "preview_token": token}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            "/api/admin/retention/policy",
            headers=HEADERS,
            json={"enabled": False, "automation_enabled": False},
        ).status_code
        == 200
    )


def test_source_review_scan_and_authorization():
    store = get_store()
    saved = thread(store, text="Client 1042 needs a review")
    body = {
        "sources": [
            {
                "id": "client-1042",
                "name": "Northwind Industries",
                "aliases": ["Client 1042"],
                "kind": "client",
            }
        ]
    }
    assert (
        client.patch("/api/admin/retention/policy", headers=HEADERS, json=body).status_code == 200
    )
    scan = client.post("/api/admin/retention/scan", headers=HEADERS)
    assert scan.status_code == 200 and scan.json()["suggestions"] >= 1
    review = {
        "thread_ids": [saved.id],
        "namespace": "client",
        "key": "client-1042",
        "action": "confirm",
    }
    assert (
        client.post(
            "/api/admin/retention/tags/review",
            headers={"x-aperture-user": "user-jane"},
            json=review,
        ).status_code
        == 403
    )
    assert (
        client.post("/api/admin/retention/tags/review", headers=HEADERS, json=review).json()[
            "reviewed"
        ]
        == 1
    )
    assert [
        (tag.namespace, tag.source) for tag in store.list_chat_thread_tags(thread_id=saved.id)
    ] == [("client", "manual")]
    client.post(
        "/api/admin/retention/tags/review", headers=HEADERS, json={**review, "action": "remove"}
    )
    client.post("/api/admin/retention/scan", headers=HEADERS)
    assert all(
        tag.namespace != "suggested_client"
        for tag in store.list_chat_thread_tags(thread_id=saved.id)
    )


def test_review_window_restarts_after_label_review_and_message_changes():
    store = get_store()
    saved = thread(store)
    policy(store, sources=[RetentionSource(id="client-a", name="Client Example")])
    retention_pass(store, NOW)
    response = client.post(
        "/api/admin/retention/tags/review",
        headers=HEADERS,
        json={
            "thread_ids": [saved.id],
            "namespace": "client",
            "key": "client-a",
            "action": "confirm",
        },
    )
    assert response.status_code == 200
    assert retention_pass(store, NOW + timedelta(days=20))["reviewing"] == 1
    assert retention_pass(store, NOW + timedelta(days=21))["deleted"] == 0
    store.save_chat_thread(
        saved.model_copy(
            update={
                "messages": [
                    ChatMessage(id="changed", role="user", content="New evidence", createdAt="Now")
                ]
            }
        )
    )
    info = store.application_state_repository.retention_overview(
        store.tenant_retention_policy(saved.tenant_id)
    )[saved.id]
    assert info["pending_since"] is None


def test_pending_records_do_not_starve_later_batches():
    store = get_store()
    for index in range(102):
        thread(store, identity=f"bounded-{index:03}")
    policy(store)
    assert retention_pass(store, NOW)["reviewing"] == 100
    assert retention_pass(store, NOW + timedelta(hours=1))["reviewing"] == 2
    assert retention_pass(store, NOW + timedelta(days=8))["deleted"] == 100
    assert retention_pass(store, NOW + timedelta(days=8))["deleted"] == 2


def test_scoped_review_rejects_other_tenant_and_hold_release():
    from app.models.schemas import RetentionHold

    store = get_store()
    tenant_id = store.users["user-admin"].tenant_id
    other = "other-retention-tenant"
    store.tenants[other] = store.tenants[tenant_id].model_copy(
        update={
            "id": other,
            "slug": "other-retention",
            "name": "Other synthetic tenant",
            "custom_domain": None,
        }
    )
    store.save_runtime_state()
    saved = thread(store, tenant=other)
    hold, _ = store.application_state_repository.create_retention_hold(
        RetentionHold(
            id="other-hold",
            tenant_id=other,
            name="Other tenant hold",
            created_by="synthetic",
            created_at=NOW,
        ),
        [saved.id],
    )
    assert (
        client.post(f"/api/admin/retention/holds/{hold.id}/release", headers=HEADERS).status_code
        == 404
    )
    policy(store, sources=[RetentionSource(id="client-a", name="Client Example")])
    response = client.post(
        "/api/admin/retention/tags/review",
        headers=HEADERS,
        json={
            "thread_ids": [saved.id],
            "namespace": "client",
            "key": "client-a",
            "action": "confirm",
        },
    )
    assert response.json()["reviewed"] == 0
    assert not store.list_chat_thread_tags(thread_id=saved.id)


@pytest.mark.parametrize("automatic", [True, False])
def test_cleanup_preserves_upload_shared_with_a_held_chat(automatic):
    from app.models.schemas import ChatAttachment, RetentionHold
    from app.db.orm import ChatAttachmentRow

    store = get_store()
    saved = thread(store, "shared-doomed")
    held = thread(store, "shared-held")
    attachment = ChatAttachment(
        id="shared-upload",
        tenant_id=saved.tenant_id,
        owner_user_id="user-admin",
        name="Synthetic evidence.txt",
        size="1 KB",
        kind="Document",
    )
    store.save_chat_attachment(attachment)
    for item in [held, saved]:
        messages = [item.messages[0].model_copy(update={"attachments": [attachment]})]
        store.save_chat_thread(item.model_copy(update={"messages": messages}))
        store.application_state_repository.run_transaction(
            lambda session, item=item: session.execute(
                update(ChatThreadRow)
                .where(ChatThreadRow.id == item.id)
                .values(last_activity_at=NOW - timedelta(days=3000))
            )
        )
    store.application_state_repository.create_retention_hold(
        RetentionHold(
            id="shared-hold",
            tenant_id=held.tenant_id,
            name="Synthetic evidence hold",
            created_by="user-admin",
            created_at=NOW,
        ),
        [held.id],
    )
    if automatic:
        policy(store)
        retention_pass(store, NOW)
        assert retention_pass(store, NOW + timedelta(days=8))["deleted"] == 1
    else:
        store.delete_chat_thread(saved.id)
        assert saved.id not in store.chat_threads
    assert held.id in store.chat_threads
    assert (
        store.application_state_repository.run_transaction(
            lambda session: session.get(ChatAttachmentRow, attachment.id).thread_id
        )
        == held.id
    )
