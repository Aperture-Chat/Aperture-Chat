"""Elastic export: target parsing, every stream end to end, and the owner routes."""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import elastic_export
from app.core.config import Settings
from app.core.elastic_export import (
    ElasticConfigError,
    normalize_api_key,
    resolve_endpoint,
    run_elastic_export,
)
from app.main import app
from datetime import UTC, datetime

from app.models.schemas import ChatThreadTag, ElasticExportSettings, PlatformSettings, RetentionHold
from app.repositories.deps import get_store
from app.repositories.identity_config_sql import _model_from_payload

client = TestClient(app)

ENV = Settings(elastic_url="http://elastic.test:9200", elastic_api_key="synthetic-key")
ALL_STREAMS = ["audit", "usage", "chats", "documents", "users"]


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-owner") -> dict[str, str]:
    return {"x-aperture-user": user_id}


class FakeElastic:
    """In-memory Elasticsearch that records what each index received."""

    def __init__(self) -> None:
        self.mappings: dict[str, dict[str, Any]] = {}
        self.docs: dict[str, dict[str, dict[str, Any]]] = {}
        self.requests: list[httpx.Request] = []
        self.item_status: Callable[[str, str, dict[str, Any]], int] = lambda *_args: 201
        self.privileged = True
        self.can_read = True
        self.ops: list[tuple[str, str, str]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "PUT" and path.endswith("/_mapping"):
            name = path.strip("/").split("/")[0]
            self.mappings[name]["properties"].update(json.loads(request.content)["properties"])
            return httpx.Response(200, json={"acknowledged": True})
        if request.method == "PUT":
            name = path.strip("/")
            if name in self.mappings:
                return httpx.Response(
                    400, json={"error": {"type": "resource_already_exists_exception"}}
                )
            self.mappings[name] = json.loads(request.content)["mappings"]
            return httpx.Response(200, json={"acknowledged": True})
        if path == "/_bulk":
            return self._bulk(request)
        if path.endswith("/_update_by_query"):
            return self._update_by_query(request)
        if path == "/_security/_authenticate":
            return httpx.Response(
                200,
                json={
                    "username": "aperture-export",
                    "authentication_type": "api_key",
                    "api_key": {"id": "key-1", "name": "aperture-export"},
                },
            )
        if path == "/":
            return httpx.Response(
                200,
                json={"cluster_name": "synthetic", "version": {"number": "9.1.0"}},
            )
        if path == "/_security/user/_has_privileges":
            return httpx.Response(
                200,
                json={
                    "has_all_requested": self.privileged and self.can_read,
                    "index": {
                        "aperture-*": {
                            "create_index": self.privileged,
                            "index": True,
                            "read": self.can_read,
                        },
                    },
                },
            )
        return httpx.Response(404, json={"error": {"type": "not_found"}})

    def _bulk(self, request: httpx.Request) -> httpx.Response:
        lines = request.content.decode().splitlines()
        items: list[dict[str, Any]] = []
        for action_line, source_line in zip(lines[0::2], lines[1::2], strict=True):
            op, action = next(iter(json.loads(action_line).items()))
            body = json.loads(source_line)
            source = body["doc"] if op == "update" else body
            self.ops.append((op, action["_index"], action["_id"]))
            status = self.item_status(action["_index"], action["_id"], source)
            index_docs = self.docs.setdefault(action["_index"], {})
            if op == "update" and status < 300 and action["_id"] not in index_docs:
                status = 404
            item: dict[str, Any] = {"_index": action["_index"], "_id": action["_id"], "status": status}
            if status == 404:
                item["error"] = {"type": "document_missing_exception", "reason": "missing"}
            elif status < 300 and op == "update":
                index_docs[action["_id"]] = {**index_docs[action["_id"]], **source}
            elif status < 300:
                index_docs[action["_id"]] = source
            elif status == 400:
                item["error"] = {"type": "mapper_parsing_exception", "reason": "bad field"}
            else:
                item["error"] = {"type": "security_exception", "reason": "unauthorized"}
            items.append({"index": item})
        errors = any(next(iter(item.values()))["status"] >= 300 for item in items)
        return httpx.Response(200, json={"errors": errors, "items": items})

    def _update_by_query(self, request: httpx.Request) -> httpx.Response:
        name = request.url.path.strip("/").split("/")[0]
        if name not in self.mappings:
            return httpx.Response(404, json={"error": {"type": "index_not_found_exception"}})
        if not self.can_read:
            return httpx.Response(403, json={"error": {"type": "security_exception"}})
        body = json.loads(request.content)
        thread_ids = set(body["query"]["terms"]["thread_id"])
        deleted_at = body["script"]["params"]["deleted_at"]
        updated = 0
        for doc in self.docs.get(name, {}).values():
            if doc.get("thread_id") in thread_ids:
                doc["thread_deleted"] = True
                doc["thread_deleted_at"] = deleted_at[doc["thread_id"]]
                updated += 1
        return httpx.Response(200, json={"updated": updated, "failures": []})

    def bulk_count(self) -> int:
        return sum(1 for request in self.requests if request.url.path == "/_bulk")


def _enable(store: Any, **updates: Any) -> None:
    config = store.platform_settings.elastic_export
    config.streams = list(ALL_STREAMS)
    for name, value in updates.items():
        setattr(config, name, value)


def _save_thread(thread_id: str, *, content: str = "Synthetic question") -> None:
    response = client.put(
        f"/api/chat/threads/{thread_id}",
        json={
            "title": "Synthetic export thread",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "m1",
                    "role": "user",
                    "content": content,
                    "createdAt": "10:00 AM",
                    "createdAtIso": "2026-10-01T10:00:00Z",
                    "status": "ok",
                    "attachments": [
                        {
                            "id": "attachment-synthetic",
                            "name": "synthetic-brief.pdf",
                            "size": "12 KB",
                            "kind": "PDF",
                            "mime_type": "application/pdf",
                            "size_bytes": 12288,
                            "text_preview": "Synthetic preview text",
                        }
                    ],
                },
                {
                    "id": "m2",
                    "role": "assistant",
                    "content": "Synthetic answer",
                    "createdAt": "10:01 AM",
                    "createdAtIso": "2026-10-01T10:01:00Z",
                    "status": "ok",
                    "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
                },
            ],
        },
        headers=headers("user-jane"),
    )
    assert response.status_code == 200, response.text


def _route_transport(monkeypatch: pytest.MonkeyPatch, fake: FakeElastic) -> None:
    original = elastic_export._client
    monkeypatch.setattr(
        elastic_export,
        "_client",
        lambda target, _transport: original(target, httpx.MockTransport(fake)),
    )


# --- Target parsing ----------------------------------------------------------


def test_endpoint_accepts_urls_hosts_and_cloud_ids() -> None:
    assert resolve_endpoint(" https://es.example.test:9243/ ") == "https://es.example.test:9243"
    assert resolve_endpoint("https://proxy.example.test/elastic/") == (
        "https://proxy.example.test/elastic"
    )
    assert resolve_endpoint("my-deploy.es.us-east-1.aws.elastic.cloud") == (
        "https://my-deploy.es.us-east-1.aws.elastic.cloud"
    )
    encoded = base64.b64encode(b"us-east-1.aws.found.io:443$abc123$kib456").decode()
    assert resolve_endpoint(f"synthetic-deployment:{encoded}") == (
        "https://abc123.us-east-1.aws.found.io"
    )
    port_encoded = base64.b64encode(b"cloud.example.test$es789:9243$kb").decode()
    assert resolve_endpoint(f"name:{port_encoded}") == "https://es789.cloud.example.test:9243"
    for bad in ("", "ftp://es.example.test", "not a url", "https://user:pw@es.example.test"):
        with pytest.raises(ElasticConfigError):
            resolve_endpoint(bad)


def test_api_key_accepts_every_kibana_format() -> None:
    encoded = base64.b64encode(b"key-id:key-secret").decode()
    assert normalize_api_key(encoded) == encoded
    assert normalize_api_key("key-id:key-secret") == encoded
    assert normalize_api_key(f"ApiKey {encoded}") == encoded
    assert normalize_api_key(f"Authorization: ApiKey {encoded}") == encoded
    assert normalize_api_key(json.dumps({"id": "key-id", "api_key": "key-secret"})) == encoded
    assert normalize_api_key(json.dumps({"encoded": encoded, "name": "x"})) == encoded
    with pytest.raises(ElasticConfigError):
        normalize_api_key("two words")


def test_legacy_platform_settings_without_elastic_block_still_load() -> None:
    legacy = PlatformSettings().model_dump(mode="json")
    legacy.pop("elastic_export")
    loaded = _model_from_payload(PlatformSettings, legacy, "platform")
    # The backfill matches what an environment-only export already sent.
    assert loaded.elastic_export == ElasticExportSettings()
    assert loaded.elastic_export.streams == ["audit"]
    assert loaded.elastic_export.include_content is False


# --- Streams end to end ------------------------------------------------------


def test_every_stream_reaches_its_index_with_metadata_only_by_default() -> None:
    _save_thread("thread-export-one")
    store = get_store()
    store.record_usage(
        actor=store.users["user-jane"],
        model_id="gpt-4o-mini",
        provider_name="Synthetic",
        usage={"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
        thread_id="thread-export-one",
    )
    _enable(store)
    fake = FakeElastic()

    result = run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))

    assert result is not None and not result.errors, result
    assert set(fake.mappings) == {
        "aperture-audit",
        "aperture-usage",
        "aperture-chats",
        "aperture-chat-messages",
        "aperture-documents",
        "aperture-users",
    }
    assert fake.mappings["aperture-audit"]["properties"]["metadata"]["type"] == "flattened"
    assert fake.docs["aperture-audit"]
    assert store.elastic_pending_count() == 0

    usage = next(iter(fake.docs["aperture-usage"].values()))
    assert usage["user_email"] == store.users["user-jane"].email
    assert usage["total_tokens"] == 20

    thread = fake.docs["aperture-chats"]["thread-export-one"]
    assert thread["message_count"] == 2
    assert thread["owner_user_id"] == "user-jane"
    assert thread["total_tokens"] == 20
    assert thread["tenant_name"]

    message = fake.docs["aperture-chat-messages"]["thread-export-one:m1"]
    assert message["role"] == "user"
    assert message["attachment_names"] == ["synthetic-brief.pdf"]
    assert message["@timestamp"].startswith("2026-10-01T10:00:00")
    assert "content" not in message
    assert message["content_length"] == len("Synthetic question")

    attachment = fake.docs["aperture-documents"]["attachment:attachment-synthetic"]
    assert attachment["origin"] == "chat_upload"
    assert attachment["thread_id"] == "thread-export-one"
    assert "text_preview" not in attachment
    knowledge = [doc for doc in fake.docs["aperture-documents"].values() if doc["origin"] == "knowledge_library"]
    assert len(knowledge) == sum(len(docs) for docs in store.knowledge_documents.values())

    assert set(fake.docs["aperture-users"]) == set(store.users)
    assert "password" not in json.dumps(fake.docs["aperture-users"]).lower()

    # A second pass has nothing new to send; cursors and fingerprints hold.
    sent = fake.bulk_count()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))
    assert fake.bulk_count() == sent

    # Saving the thread again re-sends it under the same document ids.
    _save_thread("thread-export-one", content="Synthetic edited question")
    store = get_store()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))
    assert fake.docs["aperture-chat-messages"]["thread-export-one:m1"]["content_length"] == len(
        "Synthetic edited question"
    )


def test_include_content_copies_message_and_preview_text() -> None:
    _save_thread("thread-export-content")
    store = get_store()
    _enable(store, include_content=True)
    fake = FakeElastic()

    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))

    message = fake.docs["aperture-chat-messages"]["thread-export-content:m2"]
    assert message["content"] == "Synthetic answer"
    assert message["content_truncated"] is False
    attachment = fake.docs["aperture-documents"]["attachment:attachment-synthetic"]
    assert attachment["text_preview"] == "Synthetic preview text"


def test_default_settings_export_audit_only() -> None:
    _save_thread("thread-export-default")
    store = get_store()
    fake = FakeElastic()

    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))

    assert set(fake.docs) == {"aperture-audit"}


def test_rejected_document_is_skipped_but_permission_errors_stay_pending() -> None:
    store = get_store()
    for _ in range(3):
        store.record_audit(store.users["user-owner"], "auth.login", "user-owner")
    pending = store.elastic_pending_count()
    assert pending >= 3
    poisoned: list[str] = []

    def reject_first(_index: str, doc_id: str, _source: dict[str, Any]) -> int:
        if not poisoned:
            poisoned.append(doc_id)
        return 400 if doc_id == poisoned[0] else 201

    fake = FakeElastic()
    fake.item_status = reject_first
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))
    # One malformed event cannot wedge the queue behind it.
    assert store.elastic_pending_count() == 0
    assert len(fake.docs["aperture-audit"]) == pending - 1
    stats = elastic_export.export_state(store).stats["audit"]
    assert stats.rejected == 1
    assert "mapper_parsing_exception" in (stats.last_rejection or "")

    store.record_audit(store.users["user-owner"], "auth.login", "user-owner")
    denied = FakeElastic()
    denied.item_status = lambda *_args: 403
    run_elastic_export(store, ENV, transport=httpx.MockTransport(denied))
    # A permission problem is the operator's to fix; nothing is dropped.
    assert store.elastic_pending_count() == 1
    assert "security_exception" in (store.elastic_last_delivery_error or "")


def test_cluster_outage_keeps_cursor_and_retries() -> None:
    _save_thread("thread-export-outage")
    store = get_store()
    _enable(store)

    def unavailable(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": {"type": "unavailable", "reason": "down"}})

    run_elastic_export(store, ENV, transport=httpx.MockTransport(unavailable))
    assert "HTTP 503" in (store.elastic_last_delivery_error or "")
    status = elastic_export.elastic_status(store, ENV)
    chats = next(stream for stream in status["streams"] if stream["id"] == "chats")
    assert chats["pending"] == 1

    fake = FakeElastic()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))
    assert "thread-export-outage" in fake.docs["aperture-chats"]
    assert store.elastic_last_delivery_error is None


def test_paused_export_sends_nothing() -> None:
    store = get_store()
    _enable(store, enabled=False)

    def fail(_request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        raise AssertionError("A paused export must not contact Elastic.")

    assert run_elastic_export(store, ENV, transport=httpx.MockTransport(fail)) is None


# --- Tags, holds, and in-place thread changes --------------------------------


def _tag(thread_id: str, namespace: str, key: str, value: str | None, source: str = "manual") -> ChatThreadTag:
    return ChatThreadTag(
        id=f"tag-{namespace}-{key}",
        tenant_id="tenant-example",
        thread_id=thread_id,
        namespace=namespace,
        key=key,
        value=value,
        source=source,
        applied_at=datetime(2026, 10, 2, 9, 30, tzinfo=UTC),
        applied_by="user-admin",
    )


def test_tags_and_holds_reach_the_thread_and_its_messages() -> None:
    _save_thread("thread-export-tags")
    store = get_store()
    store.apply_chat_thread_tag(_tag("thread-export-tags", "subject", "employment", "Wage claim", "auto"))
    store.apply_chat_thread_tag(_tag("thread-export-tags", "sensitive", "privileged", "Attorney-client"))
    store.application_state_repository.create_retention_hold(
        RetentionHold(
            id="hold-synthetic",
            tenant_id="tenant-example",
            name="Synthetic litigation hold",
            created_by="user-admin",
            created_at=datetime(2026, 10, 2, 9, 0, tzinfo=UTC),
        ),
        ["thread-export-tags"],
    )
    _enable(store)
    fake = FakeElastic()

    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))

    thread = fake.docs["aperture-chats"]["thread-export-tags"]
    assert thread["tags"] == ["sensitive:privileged", "subject:employment"]
    assert thread["tag_values"] == [
        "sensitive:privileged=Attorney-client",
        "subject:employment=Wage claim",
    ]
    assert thread["tag_sources"] == ["auto", "manual"]
    detail = next(tag for tag in thread["tag_details"] if tag["key"] == "privileged")
    assert detail["applied_by_name"] == store.users["user-admin"].display_name
    assert detail["applied_at"].startswith("2026-10-02T09:30:00")
    assert thread["held"] is True
    assert thread["hold_names"] == ["Synthetic litigation hold"]
    assert fake.mappings["aperture-chats"]["properties"]["tag_details"]["type"] == "nested"
    message = fake.docs["aperture-chat-messages"]["thread-export-tags:m1"]
    assert message["thread_tags"] == ["sensitive:privileged", "subject:employment"]
    assert message["thread_held"] is True


def test_tags_applied_after_export_reach_elastic_without_a_resave() -> None:
    _save_thread("thread-export-late-tag")
    store = get_store()
    _enable(store)
    fake = FakeElastic()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))
    assert fake.docs["aperture-chats"]["thread-export-late-tag"]["tags"] == []

    # Tagging, archiving, and holds update the thread in place; nothing re-saves it.
    store.apply_chat_thread_tag(_tag("thread-export-late-tag", "matter", "acme", "Acme v. Synthetic"))
    store.application_state_repository.set_chat_threads_archived(
        ["thread-export-late-tag"], tenant_id="tenant-example"
    )
    fake.ops.clear()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake), thorough=True)

    thread = fake.docs["aperture-chats"]["thread-export-late-tag"]
    assert thread["tags"] == ["matter:acme"]
    assert thread["archived"] is True
    # The changed thread is re-sent whole so its messages carry the tag too.
    assert ("index", "aperture-chat-messages", "thread-export-late-tag:m1") in fake.ops
    assert fake.docs["aperture-chat-messages"]["thread-export-late-tag:m2"]["thread_tags"] == [
        "matter:acme"
    ]

    store.remove_chat_thread_tag("thread-export-late-tag", "matter", "acme")
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake), thorough=True)
    assert fake.docs["aperture-chats"]["thread-export-late-tag"]["tags"] == []

    # Unchanged threads are not re-sent on the next scan.
    fake.ops.clear()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake), thorough=True)
    assert not [op for op in fake.ops if op[1].startswith("aperture-chat")]


def test_restart_sends_cheap_partial_updates_not_whole_threads() -> None:
    _save_thread("thread-export-restart")
    store = get_store()
    _enable(store)
    fake = FakeElastic()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))
    store.apply_chat_thread_tag(_tag("thread-export-restart", "subject", "lease", "Lease review"))

    # A restart loses the in-memory fingerprints; the SQL cursor survives.
    del store.elastic_export_state
    fake.ops.clear()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake), thorough=True)

    assert ("update", "aperture-chats", "thread-export-restart") in fake.ops
    assert not [op for op in fake.ops if op[1] == "aperture-chat-messages"]
    assert fake.docs["aperture-chats"]["thread-export-restart"]["tags"] == ["subject:lease"]


def test_deleted_chats_and_users_are_flagged_not_erased() -> None:
    _save_thread("thread-export-deleted")
    store = get_store()
    _enable(store)
    fake = FakeElastic()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))

    deleted = client.delete("/api/chat/threads/thread-export-deleted", headers=headers("user-jane"))
    assert deleted.status_code in (200, 204), deleted.text
    store = get_store()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))

    thread = fake.docs["aperture-chats"]["thread-export-deleted"]
    assert thread["deleted"] is True and thread["deleted_at"]
    message = fake.docs["aperture-chat-messages"]["thread-export-deleted:m1"]
    assert message["thread_deleted"] is True
    assert message["content_length"] == len("Synthetic question")
    upload = fake.docs["aperture-documents"]["attachment:attachment-synthetic"]
    assert upload["thread_deleted"] is True

    store.users.pop("user-drew")
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))
    assert fake.docs["aperture-users"]["user-drew"]["deleted"] is True
    assert fake.docs["aperture-users"]["user-jane"]["deleted"] is False


def test_key_without_read_still_flags_the_chat_and_explains_the_rest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _save_thread("thread-export-noread")
    store = get_store()
    _enable(store)
    fake = FakeElastic()
    fake.can_read = False
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))

    assert client.delete(
        "/api/chat/threads/thread-export-noread", headers=headers("user-jane")
    ).status_code in (200, 204)
    store = get_store()
    run_elastic_export(store, ENV, transport=httpx.MockTransport(fake))

    assert fake.docs["aperture-chats"]["thread-export-noread"]["deleted"] is True
    assert fake.docs["aperture-chat-messages"]["thread-export-noread:m1"]["thread_deleted"] is False
    status = elastic_export.elastic_status(store, ENV)
    assert "lacks 'read'" in status["indexNotes"]["aperture-chat-messages"]
    assert store.elastic_last_delivery_error is None

    _route_transport(monkeypatch, fake)
    checked = client.post(
        "/api/platform/elastic/test",
        headers=headers(),
        json={"endpoint": "https://synthetic.es.example.test", "api_key": "synthetic-id:secret"},
    ).json()
    assert checked["ok"] is True
    read = next(check for check in checked["checks"] if check["id"] == "read")
    assert read["status"] == "warn"


# --- Owner routes ------------------------------------------------------------


def test_owner_saves_connection_and_key_never_leaves_the_vault() -> None:
    secret = base64.b64encode(b"synthetic-id:synthetic-secret").decode()
    response = client.put(
        "/api/platform/elastic/settings",
        headers=headers(),
        json={
            "endpoint": "https://synthetic.es.example.test",
            "api_key": "synthetic-id:synthetic-secret",
            "index_prefix": "Aperture-Prod",
            "streams": ["chats", "audit", "users"],
            "include_content": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["configured"] is True
    assert body["endpoint"] == "https://synthetic.es.example.test"
    assert body["endpointSource"] == "console"
    assert body["settings"]["index_prefix"] == "aperture-prod"
    assert body["settings"]["streams"] == ["audit", "chats", "users"]
    assert body["settings"]["api_key_set"] is True
    assert secret not in response.text
    assert "synthetic-secret" not in response.text
    assert get_store().configuration_secret("elastic", "primary") == secret

    audit = client.get("/api/platform/audit-events", headers=headers())
    assert audit.status_code == 200
    assert "platform.elastic_settings_updated" in audit.text
    assert "synthetic.es.example.test" in audit.text
    assert "synthetic-secret" not in audit.text
    assert secret not in audit.text

    platform_settings = client.get("/api/platform/settings", headers=headers())
    assert secret not in platform_settings.text

    cleared = client.put(
        "/api/platform/elastic/settings", headers=headers(), json={"api_key": ""}
    )
    assert cleared.json()["settings"]["api_key_set"] is False
    assert get_store().configuration_secret("elastic", "primary") is None


def test_settings_reject_bad_input_and_non_owners() -> None:
    for payload in (
        {"streams": ["audit", "everything"]},
        {"index_prefix": "Bad Prefix!"},
        {"endpoint": "ftp://synthetic.example.test"},
        # Cloud metadata is never a legitimate export target.
        {"endpoint": "http://169.254.169.254"},
        {"api_key": "two words"},
    ):
        response = client.put("/api/platform/elastic/settings", headers=headers(), json=payload)
        assert response.status_code == 400, payload
    # A bad key in the same request leaves the valid fields unapplied.
    partial = client.put(
        "/api/platform/elastic/settings",
        headers=headers(),
        json={"endpoint": "https://synthetic.es.example.test", "api_key": "two words"},
    )
    assert partial.status_code == 400
    assert get_store().platform_settings.elastic_export.endpoint == ""
    blocked = client.put(
        "/api/platform/elastic/settings",
        headers=headers("user-admin"),
        json={"enabled": False},
    )
    assert blocked.status_code == 403
    assert client.post("/api/platform/elastic/test", headers=headers("user-admin")).status_code == 403
    assert client.post("/api/platform/elastic/sync", headers=headers("user-admin")).status_code == 403


def test_connection_test_reports_each_check(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeElastic()
    _route_transport(monkeypatch, fake)
    unconfigured = client.post("/api/platform/elastic/test", headers=headers())
    assert unconfigured.status_code == 400

    response = client.post(
        "/api/platform/elastic/test",
        headers=headers(),
        json={"endpoint": "https://synthetic.es.example.test", "api_key": "synthetic-id:secret"},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"] is True
    assert [check["id"] for check in result["checks"]] == ["reach", "auth", "cluster", "write"]
    assert result["cluster"]["version"] == "9.1.0"
    # Testing unsaved values does not overwrite the saved test result.
    assert get_store().platform_settings.elastic_export.last_test_status is None
    # The test is read-only: it never creates indices.
    assert fake.mappings == {}

    fake.privileged = False
    denied = client.post(
        "/api/platform/elastic/test",
        headers=headers(),
        json={"endpoint": "https://synthetic.es.example.test", "api_key": "synthetic-id:secret"},
    ).json()
    assert denied["ok"] is False
    write = next(check for check in denied["checks"] if check["id"] == "write")
    assert write["status"] == "fail"
    assert "'create_index'" in write["detail"]


def test_sync_now_delivers_and_full_resync_resends_history(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeElastic()
    _route_transport(monkeypatch, fake)
    _save_thread("thread-export-sync")
    saved = client.put(
        "/api/platform/elastic/settings",
        headers=headers(),
        json={
            "endpoint": "https://synthetic.es.example.test",
            "api_key": "synthetic-id:secret",
            "streams": ALL_STREAMS,
        },
    )
    assert saved.status_code == 200

    synced = client.post("/api/platform/elastic/sync", headers=headers(), json={})
    assert synced.status_code == 200, synced.text
    body = synced.json()
    assert body["sync"]["errors"] == {}
    assert body["sync"]["delivered"]["chats"] >= 3
    assert body["connected"] is True
    assert "thread-export-sync" in fake.docs["aperture-chats"]

    fake.docs.clear()
    resent = client.post("/api/platform/elastic/sync", headers=headers(), json={"full": True}).json()
    assert resent["sync"]["auditRequeued"] > 0
    assert "thread-export-sync" in fake.docs["aperture-chats"]
    assert fake.docs["aperture-audit"]

    paused = client.put("/api/platform/elastic/settings", headers=headers(), json={"enabled": False})
    assert paused.json()["enabled"] is False
    assert client.post("/api/platform/elastic/sync", headers=headers()).status_code == 409
