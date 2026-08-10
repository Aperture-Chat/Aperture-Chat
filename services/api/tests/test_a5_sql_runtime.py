"""A5 SQL runtime contracts for chats, keys, ACLs, and deletion history."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select, text

from app.core.config import Settings
from app.core.rate_limit import RateLimitMiddleware
from app.core.security import SecretVault
from app.db import create_application_engine, upgrade_database
from app.db.import_identity_config import A7_RUNTIME_FIELDS
from app.db.orm import ChatStateImportRow, UserSessionWatermarkRow
from app.models.schemas import (
    ChatAttachment,
    ChatFolder,
    ChatMessage,
    ChatSession,
    ChatThread,
    Role,
    User,
    UserApiKeyRecord,
)
from app.repositories import review_deps
from app.repositories.application_state import ApplicationStateRepository
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes import auth, chat
from app.routes.dependencies import current_user, current_user_or_api_key


SQL_OWNED_A5_FIELDS = {
    "chat_threads",
    "chat_folders",
    "chat_sessions",
    "chat_attachments",
    "user_api_keys",
    "user_session_watermarks",
}


def _database_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _repository(path: Path) -> ApplicationStateRepository:
    engine = create_application_engine(_database_url(path))
    upgrade_database(engine)
    return ApplicationStateRepository(engine)


def _persistent_store(
    root: Path,
    *,
    seed_demo_data_enabled: bool = True,
) -> SeedStore:
    return SeedStore(
        SecretVault("a5-sql-runtime-test-secret"),
        seed_demo_data_enabled=seed_demo_data_enabled,
        runtime_state_path=str(root / "runtime_state.json"),
    )


def _thread(
    thread_id: str,
    *,
    tenant_id: str = "tenant-example",
    owner_user_id: str = "user-jane",
    folder_id: str | None = "folder-a5",
) -> ChatThread:
    return ChatThread(
        id=thread_id,
        tenant_id=tenant_id,
        owner_user_id=owner_user_id,
        title=f"SQL thread {thread_id}",
        model_id="gpt-4o-mini",
        group_id="group-litigation",
        pinned=True,
        archived=True,
        folder_id=folder_id,
        used_agent=True,
        updated_at="2026-07-20T12:00:00+00:00",
        messages=[
            ChatMessage(
                id=f"message-{thread_id}",
                role="user",
                content="Persist this exact message.",
                createdAt="12:00 PM",
                createdAtIso="2026-07-20T12:00:00+00:00",
                attachments=[
                    ChatAttachment(
                        id="attachment-a5",
                        tenant_id=tenant_id,
                        owner_user_id=owner_user_id,
                        name="evidence.txt",
                        size="12 B",
                        kind="Text",
                    )
                ],
            )
        ],
    )


def _folder(
    folder_id: str,
    *,
    tenant_id: str = "tenant-example",
    owner_user_id: str = "user-jane",
) -> ChatFolder:
    return ChatFolder(
        id=folder_id,
        tenant_id=tenant_id,
        owner_user_id=owner_user_id,
        name=f"SQL folder {folder_id}",
        created_at="2026-07-20T11:00:00+00:00",
    )


def _attachment(
    attachment_id: str,
    *,
    tenant_id: str = "tenant-example",
    owner_user_id: str = "user-jane",
) -> ChatAttachment:
    return ChatAttachment(
        id=attachment_id,
        tenant_id=tenant_id,
        owner_user_id=owner_user_id,
        name=f"{attachment_id}.txt",
        size="12 B",
        kind="Text",
        mime_type="text/plain",
        size_bytes=12,
        source_type="upload",
        source_uri=f"upload://{attachment_id}",
        status="uploaded",
        uploaded_at="2026-07-20T11:30:00+00:00",
        text_preview="bounded preview",
    )


def _user(
    user_id: str,
    tenant_id: str | None,
    *,
    role: Role = Role.USER,
) -> User:
    return User(
        id=user_id,
        tenant_id=tenant_id,
        email=f"{user_id}@example.test",
        display_name=user_id,
        role=role,
        auth_method="local",
    )


def _a5_sql_snapshot(store: SeedStore) -> dict[str, object]:
    def model_mapping(
        mapping: object,
    ) -> dict[str, dict[str, object]]:
        items = getattr(mapping, "items")()
        return {
            str(key): value.model_dump(mode="json")
            for key, value in sorted(items, key=lambda item: str(item[0]))
        }

    repository = store.application_state_repository
    watermarks = repository.run_transaction(
        lambda session: [
            {
                "user_id": row.user_id,
                "tenant_id": row.tenant_id,
                "issued_before_ms": row.issued_before_ms,
                "updated_at": row.updated_at.isoformat(),
                "updated_by": row.updated_by,
                "reason": row.reason,
            }
            for row in session.scalars(
                select(UserSessionWatermarkRow).order_by(UserSessionWatermarkRow.user_id)
            )
        ]
    )
    import_markers = [
        {
            column.name: (
                getattr(marker, column.name).isoformat()
                if isinstance(getattr(marker, column.name), datetime)
                else getattr(marker, column.name)
            )
            for column in ChatStateImportRow.__table__.columns
        }
        for marker in repository.list_chat_import_markers()
    ]
    return {
        "threads": model_mapping(store.chat_threads),
        "folders": model_mapping(store.chat_folders),
        "sessions": model_mapping(store.chat_sessions),
        "attachments": model_mapping(store.chat_attachments),
        "api_keys": model_mapping(store.user_api_keys),
        "watermarks": watermarks,
        "import_markers": import_markers,
    }


def _json_owned_in_memory_digest(store: SeedStore) -> str:
    def model_collection(name: str) -> dict[str, dict[str, object]]:
        collection = getattr(store, name)
        return {
            str(key): value.model_dump(mode="json")
            for key, value in sorted(collection.items(), key=lambda item: str(item[0]))
        }

    def grouped_model_collection(name: str) -> dict[str, list[dict[str, object]]]:
        collection = getattr(store, name)
        return {
            str(key): [value.model_dump(mode="json") for value in values]
            for key, values in sorted(collection.items(), key=lambda item: str(item[0]))
        }

    collection_names = (
        "tenants",
        "users",
        "groups",
        "providers",
        "models",
        "provider_keys",
        "connectors",
        "connector_configs",
        "sso_configs",
        "knowledge_configs",
        "tool_configs",
        "prompt_templates",
        "skill_files",
        "security_alerts",
        "agent_runs",
        "automations",
        "companion_memories",
        "content_filters",
        "scim_tokens",
        "alert_rules",
    )
    payload: dict[str, object] = {name: model_collection(name) for name in collection_names}
    payload.update(
        {
            "knowledge_documents": grouped_model_collection("knowledge_documents"),
            "knowledge_chunks": grouped_model_collection("knowledge_chunks"),
            "platform_settings": store.platform_settings.model_dump(mode="json"),
            "password_credentials": dict(sorted(store.password_credentials.items())),
            "temporary_password_user_ids": sorted(store.temporary_password_user_ids),
            "email_settings": store.email_settings.model_dump(mode="json"),
            "encrypted_provider_keys": dict(sorted(store._encrypted_keys.items())),  # noqa: SLF001
            "configuration_secrets": dict(
                sorted(store._configuration_secrets.items())  # noqa: SLF001
            ),
        }
    )
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _assert_runtime_file_unchanged(
    state_path: Path,
    expected_bytes: bytes,
    expected_mtime_ns: int,
) -> None:
    if state_path.read_bytes() != expected_bytes:
        pytest.fail("runtime_state.json byte content changed")
    if state_path.stat().st_mtime_ns != expected_mtime_ns:
        pytest.fail("runtime_state.json modification time changed")


def test_v5_restart_persists_a5_rows_and_omits_sql_owned_json_fields(
    tmp_path: Path,
) -> None:
    store = _persistent_store(tmp_path)
    assert (
        store.session_issued_before_ms
        is store.application_state_repository.session_issued_before_ms
    )
    thread = _thread("thread-a5-restart")
    folder = _folder("folder-a5")
    attachment = _attachment("attachment-a5")
    actor = store.users["user-jane"]

    store.chat_folders[folder.id] = folder
    store.chat_attachments[attachment.id or ""] = attachment
    store.chat_threads[thread.id] = thread
    api_key, secret = store.create_user_api_key(actor)
    store.flush_now()

    state_path = tmp_path / "runtime_state.json"
    raw_text = state_path.read_text(encoding="utf-8")
    payload = json.loads(raw_text)
    assert payload["version"] == 5
    assert SQL_OWNED_A5_FIELDS.isdisjoint(payload)
    assert A7_RUNTIME_FIELDS.isdisjoint(payload)
    assert secret not in raw_text
    store.close()

    restarted = _persistent_store(tmp_path)
    try:
        assert (
            restarted.session_issued_before_ms
            is restarted.application_state_repository.session_issued_before_ms
        )
        assert restarted.chat_threads[thread.id].model_dump() == thread.model_dump()
        assert restarted.chat_folders[folder.id].model_dump() == folder.model_dump()
        assert restarted.chat_attachments[attachment.id or ""].model_dump() == (
            attachment.model_dump()
        )
        assert restarted.user_api_keys[actor.id].model_dump() == api_key.model_dump()
        expected_session = ChatSession.model_validate(thread.model_dump(exclude={"messages"}))
        assert restarted.chat_sessions[thread.id].model_dump() == expected_session.model_dump()
    finally:
        restarted.close()


def test_real_a5_routes_and_audits_never_rewrite_runtime_json(tmp_path: Path) -> None:
    store = _persistent_store(tmp_path)
    actor = store.users["user-jane"]
    group = store.groups["group-litigation"]
    store.platform_settings.downstream_api_enabled = True
    group.permissions = {**group.permissions, "api_access": True}
    store.save_runtime_state(urgent=True)
    state_path = tmp_path / "runtime_state.json"
    expected_bytes = state_path.read_bytes()
    # A fixed old nanosecond timestamp makes a same-content atomic rewrite
    # observable without a timing sleep or filesystem-resolution assumption.
    guarded_mtime_ns = 1_700_000_000_123_456_789
    os.utime(state_path, ns=(guarded_mtime_ns, guarded_mtime_ns))
    assert store._runtime_state_dirty is False  # noqa: SLF001

    route_app = FastAPI()
    route_app.include_router(auth.router)
    route_app.include_router(chat.router)
    route_app.dependency_overrides[get_store] = lambda: store
    route_app.dependency_overrides[current_user] = lambda: actor

    def assert_sql_only() -> None:
        _assert_runtime_file_unchanged(
            state_path,
            expected_bytes,
            guarded_mtime_ns,
        )
        assert store._runtime_state_dirty is False  # noqa: SLF001

    try:
        with TestClient(route_app) as client:
            folder = client.put(
                "/api/chat/folders",
                json={"id": "folder-route-sql", "name": "SQL route folder"},
            )
            assert folder.status_code == 200
            assert_sql_only()

            attachment = client.post(
                "/api/chat/attachments",
                files={"file": ("route-proof.txt", b"real SQL route", "text/plain")},
            )
            assert attachment.status_code == 200
            attachment_id = attachment.json()["id"]
            assert attachment_id in store.chat_attachments
            assert_sql_only()

            thread = client.put(
                "/api/chat/threads/thread-route-sql",
                json={
                    "title": "SQL route thread",
                    "model_id": "gpt-4o-mini",
                    "group_id": "group-litigation",
                    "folder_id": "folder-route-sql",
                    "messages": [],
                },
            )
            assert thread.status_code == 200
            assert_sql_only()

            api_key = client.post("/api/auth/api-key")
            assert api_key.status_code == 200
            assert actor.id in store.user_api_keys
            assert_sql_only()

            deleted_thread = client.delete("/api/chat/threads/thread-route-sql")
            assert deleted_thread.status_code == 200
            assert_sql_only()

            deleted_folder = client.delete("/api/chat/folders/folder-route-sql")
            assert deleted_folder.status_code == 200
            assert_sql_only()

            revoked_key = client.delete("/api/auth/api-key")
            assert revoked_key.status_code == 200
            assert actor.id not in store.user_api_keys
            assert_sql_only()

        # There is intentionally no public attachment-delete route. Exercise
        # the SQL-backed mapping deletion directly instead of inventing one.
        del store.chat_attachments[attachment_id]
        assert attachment_id not in store.chat_attachments
        assert_sql_only()

        assert [event.action for event in store.audit_events[-7:]] == [
            "chat.folder_saved",
            "chat.attachment_uploaded",
            "chat.thread_saved",
            "auth.api_key_created",
            "chat.thread_deleted",
            "chat.folder_deleted",
            "auth.api_key_revoked",
        ]
    finally:
        store.close()


def test_chat_sessions_are_a_stable_exact_read_only_thread_projection(
    tmp_path: Path,
) -> None:
    store = _persistent_store(tmp_path, seed_demo_data_enabled=False)
    try:
        sessions = store.chat_sessions
        thread = _thread("thread-a5-session")
        store.chat_threads[thread.id] = thread

        assert store.chat_sessions is sessions
        assert set(sessions) == set(store.chat_threads)
        expected = ChatSession.model_validate(thread.model_dump(exclude={"messages"}))
        assert sessions[thread.id].model_dump() == expected.model_dump()
        assert "messages" not in sessions[thread.id].model_dump()

        updated = thread.model_copy(
            update={
                "title": "Updated SQL title",
                "folder_id": None,
                "archived": False,
                "updated_at": "2026-07-20T12:30:00+00:00",
            }
        )
        store.chat_threads[thread.id] = updated
        assert sessions[thread.id].title == "Updated SQL title"
        assert sessions[thread.id].folder_id is None
        assert sessions[thread.id].archived is False

        del store.chat_threads[thread.id]
        assert thread.id not in sessions
        assert len(sessions) == len(store.chat_threads) == 0
    finally:
        store.close()


def test_chat_acl_filters_owner_and_tenant_without_platform_owner_overreach(
    tmp_path: Path,
) -> None:
    store = _persistent_store(tmp_path, seed_demo_data_enabled=False)
    try:
        jane = _user("user-jane-a5", "tenant-a")
        casey = _user("user-casey-a5", "tenant-a")
        owner = _user("user-owner-a5", None, role=Role.PLATFORM_OWNER)

        for thread in (
            _thread(
                "thread-jane-own",
                tenant_id="tenant-a",
                owner_user_id=jane.id,
                folder_id=None,
            ),
            _thread(
                "thread-jane-wrong-tenant",
                tenant_id="tenant-b",
                owner_user_id=jane.id,
                folder_id=None,
            ),
            _thread(
                "thread-casey",
                tenant_id="tenant-a",
                owner_user_id=casey.id,
                folder_id=None,
            ),
            _thread(
                "thread-owner-own",
                tenant_id="tenant-a",
                owner_user_id=owner.id,
                folder_id=None,
            ),
        ):
            store.chat_threads[thread.id] = thread

        for folder in (
            _folder("folder-jane-own", tenant_id="tenant-a", owner_user_id=jane.id),
            _folder(
                "folder-jane-wrong-tenant",
                tenant_id="tenant-b",
                owner_user_id=jane.id,
            ),
            _folder("folder-casey", tenant_id="tenant-a", owner_user_id=casey.id),
            _folder("folder-owner-own", tenant_id="tenant-a", owner_user_id=owner.id),
        ):
            store.chat_folders[folder.id] = folder

        attachments = (
            _attachment("attachment-jane-own", tenant_id="tenant-a", owner_user_id=jane.id),
            _attachment(
                "attachment-jane-wrong-tenant",
                tenant_id="tenant-b",
                owner_user_id=jane.id,
            ),
            _attachment("attachment-casey", tenant_id="tenant-a", owner_user_id=casey.id),
        )
        for attachment in attachments:
            store.chat_attachments[attachment.id or ""] = attachment

        assert [thread.id for thread in store.chat_threads_for(jane)] == ["thread-jane-own"]
        assert [folder.id for folder in store.chat_folders_for(jane)] == ["folder-jane-own"]
        # Platform governance does not grant access to another user's personal
        # chat history or folders; an owner sees only rows they personally own.
        assert [thread.id for thread in store.chat_threads_for(owner)] == ["thread-owner-own"]
        assert [folder.id for folder in store.chat_folders_for(owner)] == ["folder-owner-own"]

        assert store.chat_attachment_for(jane, "attachment-jane-own") is not None
        assert store.chat_attachment_for(jane, "attachment-jane-wrong-tenant") is None
        assert store.chat_attachment_for(jane, "attachment-casey") is None
        # Preserve the existing governance behavior for attachment resolution:
        # platform owners can resolve attachment metadata globally.
        assert store.chat_attachment_for(owner, "attachment-casey") is not None
        assert store.chat_attachment_for(owner, "attachment-jane-wrong-tenant") is not None
    finally:
        store.close()


def test_indexed_api_key_lookup_distinguishes_rate_limit_from_real_auth_touch(
    tmp_path: Path,
) -> None:
    store = _persistent_store(tmp_path)
    try:
        actor = store.users["user-jane"]
        group = store.groups["group-litigation"]
        store.platform_settings.downstream_api_enabled = True
        group.permissions = {**group.permissions, "api_access": True}
        record, secret = store.create_user_api_key(actor)
        store.flush_now()
        assert store.user_api_keys[actor.id].last_used_at is None
        assert store._runtime_state_dirty is False  # noqa: SLF001

        key_hash = hashlib.sha256(secret.encode("utf-8")).hexdigest()
        assert key_hash == record.key_hash
        inspector = inspect(store.application_state_repository.engine)
        hash_index = next(
            index
            for index in inspector.get_indexes("user_api_keys")
            if index["name"] == "ix_user_api_keys_key_hash"
        )
        assert hash_index["column_names"] == ["key_hash"]
        assert bool(hash_index["unique"]) is True
        with store.application_state_repository.engine.connect() as connection:
            query_plan = connection.execute(
                text("EXPLAIN QUERY PLAN SELECT id FROM user_api_keys WHERE key_hash = :key_hash"),
                {"key_hash": key_hash},
            ).all()
        assert any("ix_user_api_keys_key_hash" in str(row[-1]) for row in query_plan)

        limiter_app = FastAPI()

        @limiter_app.post("/v1/chat/completions")
        def _limited_request() -> dict[str, str]:
            return {"status": "accepted"}

        limiter_app.add_middleware(
            RateLimitMiddleware,
            settings=Settings(
                environment="production",
                secret_key="a5-rate-limit-test-secret-value-1234567890",
                chat_rate_limit_per_minute=10,
            ),
            store_factory=lambda: store,
            bypass_during_pytest=False,
        )
        limiter_client = TestClient(limiter_app)
        limited = limiter_client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {secret}"},
        )
        assert limited.status_code == 200
        # Rate-limit identity validation must use the index without turning a
        # pre-handler policy check into a last-used authentication event.
        assert store.user_api_keys[actor.id].last_used_at is None
        assert store._runtime_state_dirty is False  # noqa: SLF001

        authenticated = current_user_or_api_key(
            authorization=f"Bearer {secret}",
            x_aperture_session=None,
            x_aperture_user=None,
            store=store,
        )
        assert authenticated.id == actor.id
        assert store.user_api_keys[actor.id].last_used_at is not None
        # The real authentication touch is a targeted SQL update, never a v4
        # runtime-state rewrite.
        assert store._runtime_state_dirty is False  # noqa: SLF001
    finally:
        store.close()


def test_api_key_cas_rejects_replaced_revoked_and_invalid_owner_records(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _persistent_store(tmp_path, seed_demo_data_enabled=False)
    repository = store.application_state_repository
    valid_user = _user("user-api-valid", "tenant-api-valid")
    store.users[valid_user.id] = valid_user
    stale_record, stale_secret = store.create_user_api_key(valid_user)

    try:
        first_touch = "2026-07-20T12:01:00+00:00"
        assert (
            repository.touch_user_api_key_if_current(
                stale_record.id,
                stale_record.key_hash,
                first_touch,
            )
            is True
        )
        assert store.user_api_keys[valid_user.id].last_used_at == first_touch

        replacement_secret = "apt_a5_replacement_secret"
        replacement = UserApiKeyRecord(
            id=valid_user.id,
            user_id=valid_user.id,
            tenant_id=valid_user.tenant_id,
            key_hash=hashlib.sha256(replacement_secret.encode("utf-8")).hexdigest(),
            key_prefix="apt_a5_repl",
            masked_value="apt_a5_repl••••••••cret",
            created_at="2026-07-20T12:02:00+00:00",
        )
        original_lookup = repository.lookup_api_key_hash
        rotated = False

        def _lookup_then_rotate(
            candidate_hash: str,
            *,
            touch_last_used: bool = False,
            touched_at: str | datetime | None = None,
        ) -> UserApiKeyRecord | None:
            nonlocal rotated
            matched = original_lookup(
                candidate_hash,
                touch_last_used=touch_last_used,
                touched_at=touched_at,
            )
            if matched is not None and not rotated:
                repository.upsert_user_api_key(replacement)
                rotated = True
            return matched

        # Reproduce a rotation between indexed lookup and the last-used touch.
        # The second phase must compare both id and hash, fail closed, and
        # leave the replacement untouched.
        with monkeypatch.context() as context:
            context.setattr(repository, "lookup_api_key_hash", _lookup_then_rotate)
            assert store.user_for_api_key(stale_secret) is None

        assert rotated is True
        assert store.user_api_keys[valid_user.id].key_hash == replacement.key_hash
        assert store.user_api_keys[valid_user.id].last_used_at is None
        assert (
            repository.touch_user_api_key_if_current(
                stale_record.id,
                stale_record.key_hash,
                "2026-07-20T12:03:00+00:00",
            )
            is False
        )
        assert store.user_api_keys[valid_user.id].last_used_at is None

        authenticated = store.user_for_api_key(replacement_secret)
        assert authenticated is not None and authenticated.id == valid_user.id
        assert store.user_api_keys[valid_user.id].last_used_at is not None

        revoked = store.revoke_user_api_key(valid_user.id)
        assert revoked is not None and revoked.key_hash == replacement.key_hash
        assert store.user_for_api_key(replacement_secret) is None
        assert valid_user.id not in store.user_api_keys

        def _record(
            user_id: str,
            tenant_id: str | None,
            secret: str,
        ) -> UserApiKeyRecord:
            return UserApiKeyRecord(
                id=user_id,
                user_id=user_id,
                tenant_id=tenant_id,
                key_hash=hashlib.sha256(secret.encode("utf-8")).hexdigest(),
                key_prefix=secret[:12],
                masked_value=f"{secret[:12]}••••••••{secret[-4:]}",
                created_at="2026-07-20T12:04:00+00:00",
            )

        orphan_secret = "apt_a5_orphan_secret"
        orphan_record = _record("user-api-orphan", "tenant-api-valid", orphan_secret)
        store.user_api_keys[orphan_record.user_id] = orphan_record
        assert store.user_for_api_key(orphan_secret) is None
        assert store.user_api_keys[orphan_record.user_id].last_used_at is None

        inactive_user = _user("user-api-inactive", "tenant-api-valid")
        inactive_user.active = False
        store.users[inactive_user.id] = inactive_user
        inactive_secret = "apt_a5_inactive_secret"
        inactive_record = _record(
            inactive_user.id,
            inactive_user.tenant_id,
            inactive_secret,
        )
        store.user_api_keys[inactive_user.id] = inactive_record
        assert store.user_for_api_key(inactive_secret) is None
        assert store.user_api_keys[inactive_user.id].last_used_at is None

        mismatch_user = _user("user-api-mismatch", "tenant-api-valid")
        store.users[mismatch_user.id] = mismatch_user
        mismatch_secret = "apt_a5_tenant_mismatch_secret"
        mismatch_record = _record(
            mismatch_user.id,
            "tenant-api-other",
            mismatch_secret,
        )
        store.user_api_keys[mismatch_user.id] = mismatch_record
        assert store.user_for_api_key(mismatch_secret) is None
        assert store.user_api_keys[mismatch_user.id].last_used_at is None
    finally:
        store.close()


def test_repository_watermark_is_monotonic_and_survives_delete_recreate_restart(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "watermark.sqlite3"
    repository = _repository(database_path)
    user_id = "user-watermark-a5"
    tenant_id = "tenant-watermark-a5"
    first_cutoff = 1_800_000_000_000
    higher_cutoff = first_cutoff + 10_000
    try:
        assert (
            repository.advance_session_issued_before_ms(
                user_id,
                tenant_id,
                first_cutoff,
                reason="initial-security-cutoff",
                updated_at=datetime(2026, 7, 20, 12, 0, tzinfo=UTC),
                updated_by=None,
            )
            == first_cutoff
        )
        initial_row = repository.run_transaction(
            lambda session: session.get(UserSessionWatermarkRow, user_id)
        )
        assert initial_row is not None
        assert initial_row.issued_before_ms == first_cutoff
        assert initial_row.updated_by is None

        # A stale writer cannot lower the cutoff or overwrite its attribution.
        assert (
            repository.advance_session_issued_before_ms(
                user_id,
                tenant_id,
                first_cutoff - 1,
                reason="stale-cutoff",
                updated_by="user-stale-actor",
            )
            == first_cutoff
        )
        unchanged_row = repository.run_transaction(
            lambda session: session.get(UserSessionWatermarkRow, user_id)
        )
        assert unchanged_row is not None
        assert unchanged_row.reason == "initial-security-cutoff"
        assert unchanged_row.updated_by is None

        assert (
            repository.advance_session_issued_before_ms(
                user_id,
                tenant_id,
                higher_cutoff,
                reason="administrator-logout-all",
                updated_at=datetime(2026, 7, 20, 12, 5, tzinfo=UTC),
                updated_by="user-security-admin",
            )
            == higher_cutoff
        )
        attributed_row = repository.run_transaction(
            lambda session: session.get(UserSessionWatermarkRow, user_id)
        )
        assert attributed_row is not None
        assert attributed_row.issued_before_ms == higher_cutoff
        assert attributed_row.updated_by == "user-security-admin"
        assert attributed_row.reason == "administrator-logout-all"

        repository.upsert_chat_thread(
            _thread(
                "thread-before-user-purge",
                tenant_id=tenant_id,
                owner_user_id=user_id,
                folder_id="folder-before-user-purge",
            )
        )
        repository.upsert_chat_folder(
            _folder(
                "folder-before-user-purge",
                tenant_id=tenant_id,
                owner_user_id=user_id,
            )
        )
        repository.upsert_chat_attachment(
            _attachment(
                "attachment-before-user-purge",
                tenant_id=tenant_id,
                owner_user_id=user_id,
            )
        )
        repository.upsert_user_api_key(
            UserApiKeyRecord(
                id="api-key-before-user-purge",
                user_id=user_id,
                tenant_id=tenant_id,
                key_hash=hashlib.sha256(b"watermark-test-key").hexdigest(),
                key_prefix="apt_water",
                masked_value="apt_water••••••••mark",
                created_at="2026-07-20T12:00:00+00:00",
            )
        )
        removed = repository.purge_a5_user(
            user_id,
            tenant_id,
            first_cutoff,
            updated_by="user-delete-actor",
        )
        assert removed == {
            "removed_threads": 1,
            "removed_folders": 1,
            "removed_sessions": 1,
            "removed_attachments": 1,
            "removed_api_keys": 1,
            "removed_mfa_challenges": 0,
            "removed_mfa_enrollments": 0,
            "removed_recovery_codes": 0,
            "removed_mfa_factors": 0,
        }
        deletion_cutoff = higher_cutoff + 1
        assert repository.get_session_issued_before_ms(user_id) == deletion_cutoff

        # Recreating the same logical user/current state never resurrects a
        # lower session cutoff that deletion deliberately retained.
        recreated = _thread(
            "thread-after-user-recreate",
            tenant_id=tenant_id,
            owner_user_id=user_id,
            folder_id=None,
        )
        repository.upsert_chat_thread(recreated)
        assert repository.get_session_issued_before_ms(user_id) == deletion_cutoff
    finally:
        repository.close()

    restarted = _repository(database_path)
    try:
        assert restarted.get_session_issued_before_ms(user_id) == deletion_cutoff
        assert restarted.get_chat_thread("thread-after-user-recreate") is not None
        restarted_row = restarted.run_transaction(
            lambda session: session.scalar(
                select(UserSessionWatermarkRow).where(UserSessionWatermarkRow.user_id == user_id)
            )
        )
        assert restarted_row is not None
        assert restarted_row.updated_by == "user-delete-actor"
        assert restarted_row.reason == "user-deleted"
    finally:
        restarted.close()


def test_hard_user_delete_purges_current_a5_state_after_review_and_retains_history(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _persistent_store(tmp_path)
    repository = store.application_state_repository
    user = store.users["user-jane"].model_copy(deep=True)
    thread = _thread("thread-user-delete")
    folder = _folder("folder-user-delete")
    attachment = _attachment("attachment-user-delete")
    store.chat_threads[thread.id] = thread
    store.chat_folders[folder.id] = folder
    store.chat_attachments[attachment.id or ""] = attachment
    store.create_user_api_key(user)
    event = store.record_audit(user, "test.a5_user_history", user.id)
    usage = store.record_usage(actor=user, model_id="a5-user-history-model")
    repository.revoke_session(
        sid="sid-a5-user-delete",
        user_id=user.id,
        tenant_id=user.tenant_id,
        issued_at=1_800_000_000,
        expires_at=1_900_000_000,
        revoked_at=datetime(2026, 7, 20, 12, 0, tzinfo=UTC),
        reason="pre-delete-revocation",
    )
    baseline_cutoff = 1_000
    repository.advance_session_issued_before_ms(
        user.id,
        user.tenant_id,
        baseline_cutoff,
        reason="pre-delete-cutoff",
        updated_by=None,
    )

    order: list[str] = []
    monkeypatch.setattr(
        review_deps,
        "purge_review_owner",
        lambda owner_user_id: order.append(f"review:{owner_user_id}") or 0,
    )
    original_purge = repository.purge_a5_user

    def _observed_purge(*args: object, **kwargs: object) -> dict[str, int]:
        assert order == [f"review:{user.id}"]
        order.append("application")
        return original_purge(*args, **kwargs)

    monkeypatch.setattr(repository, "purge_a5_user", _observed_purge)
    removed = store.delete_user_account(user.id)

    assert order == [f"review:{user.id}", "application"]
    assert removed == {
        "removed_threads": 1,
        "removed_folders": 1,
        "removed_sessions": 1,
        "removed_attachments": 1,
        "removed_api_keys": 1,
        "removed_mfa_challenges": 0,
        "removed_mfa_enrollments": 0,
        "removed_recovery_codes": 0,
        "removed_mfa_factors": 0,
        "user_memories": 0,
    }
    assert user.id not in store.users
    assert thread.id not in store.chat_threads
    assert thread.id not in store.chat_sessions
    assert folder.id not in store.chat_folders
    assert attachment.id not in store.chat_attachments
    assert user.id not in store.user_api_keys

    assert any(candidate.id == event.id for candidate in store.audit_events)
    assert any(candidate.id == usage.id for candidate in store.usage_records)
    assert any(row.event_id == event.id for row in repository.pending_outbox())
    assert repository.is_session_revoked("sid-a5-user-delete") is True
    retained_cutoff = repository.get_session_issued_before_ms(user.id)
    assert retained_cutoff is not None and retained_cutoff >= baseline_cutoff
    retained_row = repository.run_transaction(
        lambda session: session.get(UserSessionWatermarkRow, user.id)
    )
    assert retained_row is not None
    assert retained_row.updated_by is None
    assert retained_row.reason == "user-deleted"

    # Reusing the same logical id does not clear the retained security cutoff.
    store.users[user.id] = user
    store.save_runtime_state(urgent=True)
    assert store.session_issued_before_ms[user.id] == retained_cutoff
    store.close()

    restarted = _persistent_store(tmp_path)
    try:
        assert restarted.users[user.id].email == user.email
        assert restarted.session_issued_before_ms[user.id] == retained_cutoff
        assert restarted.application_state_repository.is_session_revoked("sid-a5-user-delete")
        assert any(candidate.id == event.id for candidate in restarted.audit_events)
        assert any(candidate.id == usage.id for candidate in restarted.usage_records)
    finally:
        restarted.close()


def test_hard_tenant_delete_retains_histories_and_attributes_watermarks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _persistent_store(tmp_path)
    repository = store.application_state_repository
    owner = store.users["user-owner"]
    tenant_id = "tenant-a5-delete"
    tenant = store.tenants["tenant-example"].model_copy(
        update={
            "id": tenant_id,
            "name": "A5 Delete Tenant",
            "slug": "a5-delete-tenant",
            "custom_domain": "a5-delete.example.test",
        },
        deep=True,
    )
    user = store.users["user-jane"].model_copy(
        update={
            "id": "user-a5-tenant-delete",
            "tenant_id": tenant_id,
            "email": "a5.tenant.delete@example.test",
            "group_ids": [],
        },
        deep=True,
    )
    store.tenants[tenant.id] = tenant
    store.users[user.id] = user
    thread = _thread(
        "thread-tenant-delete",
        tenant_id=tenant_id,
        owner_user_id=user.id,
        folder_id="folder-tenant-delete",
    )
    folder = _folder(
        "folder-tenant-delete",
        tenant_id=tenant_id,
        owner_user_id=user.id,
    )
    attachment = _attachment(
        "attachment-tenant-delete",
        tenant_id=tenant_id,
        owner_user_id=user.id,
    )
    store.chat_threads[thread.id] = thread
    store.chat_folders[folder.id] = folder
    store.chat_attachments[attachment.id or ""] = attachment
    store.create_user_api_key(user)
    event = store.record_audit(user, "test.a5_tenant_history", tenant_id)
    usage = store.record_usage(actor=user, model_id="a5-tenant-history-model")
    repository.revoke_session(
        sid="sid-a5-tenant-delete",
        user_id=user.id,
        tenant_id=tenant_id,
        issued_at=1_800_000_000,
        expires_at=1_900_000_000,
        revoked_at=datetime(2026, 7, 20, 12, 0, tzinfo=UTC),
        reason="tenant-pre-delete-revocation",
    )
    repository.advance_session_issued_before_ms(
        user.id,
        tenant_id,
        2_000,
        reason="tenant-pre-delete-cutoff",
        updated_by=None,
    )

    order: list[str] = []
    monkeypatch.setattr(
        review_deps,
        "purge_review_tenant",
        lambda deleted_tenant_id: order.append(f"review:{deleted_tenant_id}") or 0,
    )
    original_purge = repository.purge_a5_tenant

    def _observed_purge(*args: object, **kwargs: object) -> dict[str, int]:
        # The fenced cleanup saga clears application authority before the
        # review stage runs (identity -> application -> review -> ...).
        assert order == []
        order.append("application")
        return original_purge(*args, **kwargs)

    monkeypatch.setattr(repository, "purge_a5_tenant", _observed_purge)
    deleted = store.delete_tenant(tenant_id, owner)

    assert deleted.id == tenant_id
    assert order == ["application", f"review:{tenant_id}"]
    assert tenant_id not in store.tenants
    assert user.id not in store.users
    assert thread.id not in store.chat_threads
    assert thread.id not in store.chat_sessions
    assert folder.id not in store.chat_folders
    assert attachment.id not in store.chat_attachments
    assert user.id not in store.user_api_keys

    assert any(candidate.id == event.id for candidate in store.audit_events)
    assert any(candidate.id == usage.id for candidate in store.usage_records)
    assert any(row.event_id == event.id for row in repository.pending_outbox())
    assert repository.is_session_revoked("sid-a5-tenant-delete") is True
    assert store.session_issued_before_ms[user.id] >= 2_000
    retained_row = repository.run_transaction(
        lambda session: session.get(UserSessionWatermarkRow, user.id)
    )
    assert retained_row is not None
    # The fenced cleanup job applies the watermark and may resume at startup
    # without an actor; attribution lives in the audit event instead.
    assert retained_row.updated_by is None
    assert retained_row.reason == "tenant-deleted"
    assert store.audit_events[-1].action == "platform.tenant_deleted"
    assert store.audit_events[-1].tenant_id is None
    store.close()


def test_user_delete_fails_closed_when_review_purge_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _persistent_store(tmp_path)
    repository = store.application_state_repository
    user = store.users["user-jane"]
    folder = _folder("folder-review-user-failure")
    thread = _thread(
        "thread-review-user-failure",
        folder_id=folder.id,
    )
    attachment = _attachment("attachment-review-user-failure")
    store.chat_folders[folder.id] = folder
    store.chat_threads[thread.id] = thread
    store.chat_attachments[attachment.id or ""] = attachment
    store.create_user_api_key(user)
    repository.advance_session_issued_before_ms(
        user.id,
        user.tenant_id,
        1_800_000_100_000,
        reason="pre-review-user-failure",
        updated_at=datetime(2026, 7, 20, 13, 0, tzinfo=UTC),
        updated_by="security-admin",
    )
    store.save_runtime_state(urgent=True)

    state_path = tmp_path / "runtime_state.json"
    expected_bytes = state_path.read_bytes()
    guarded_mtime_ns = 1_700_000_000_223_456_789
    os.utime(state_path, ns=(guarded_mtime_ns, guarded_mtime_ns))
    expected_identity_config = store.identity_config_repository.load_active_snapshot()
    assert expected_identity_config is not None
    expected_in_memory_digest = _json_owned_in_memory_digest(store)
    expected_a5 = _a5_sql_snapshot(store)
    assert store._runtime_state_dirty is False  # noqa: SLF001

    def _review_failure(_owner_user_id: str) -> int:
        raise RuntimeError("review owner purge failed")

    monkeypatch.setattr(review_deps, "purge_review_owner", _review_failure)
    try:
        with pytest.raises(RuntimeError, match="review owner purge failed"):
            store.delete_user_account(user.id)

        _assert_runtime_file_unchanged(
            state_path,
            expected_bytes,
            guarded_mtime_ns,
        )
        assert store.identity_config_repository.load_active_snapshot() == expected_identity_config
        assert _json_owned_in_memory_digest(store) == expected_in_memory_digest
        actual_a5 = _a5_sql_snapshot(store)
        assert {key: value for key, value in actual_a5.items() if key != "watermarks"} == {
            key: value for key, value in expected_a5.items() if key != "watermarks"
        }
        expected_watermarks = {
            row["user_id"]: row
            for row in expected_a5["watermarks"]  # type: ignore[index]
        }
        actual_watermarks = {
            row["user_id"]: row
            for row in actual_a5["watermarks"]  # type: ignore[index]
        }
        assert actual_watermarks.keys() == expected_watermarks.keys()
        assert {
            user_id: row for user_id, row in actual_watermarks.items() if user_id != user.id
        } == {user_id: row for user_id, row in expected_watermarks.items() if user_id != user.id}
        assert (
            actual_watermarks[user.id]["issued_before_ms"]
            > expected_watermarks[user.id]["issued_before_ms"]
        )
        assert actual_watermarks[user.id]["tenant_id"] == user.tenant_id
        assert actual_watermarks[user.id]["reason"] == "user-deleted"
        assert actual_watermarks[user.id]["updated_by"] is None
        assert store._runtime_state_dirty is False  # noqa: SLF001
    finally:
        store.close()


def test_tenant_delete_review_failure_is_durable_and_resumable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _persistent_store(tmp_path)
    repository = store.application_state_repository
    actor = store.users["user-owner"]
    tenant_id = "tenant-review-failure"
    tenant = store.tenants["tenant-example"].model_copy(
        update={
            "id": tenant_id,
            "name": "Review Failure Tenant",
            "slug": "review-failure-tenant",
            "custom_domain": "review-failure.example.test",
        },
        deep=True,
    )
    user = store.users["user-jane"].model_copy(
        update={
            "id": "user-review-tenant-failure",
            "tenant_id": tenant_id,
            "email": "review.failure@example.test",
            "group_ids": [],
        },
        deep=True,
    )
    store.tenants[tenant.id] = tenant
    store.users[user.id] = user
    folder = _folder(
        "folder-review-tenant-failure",
        tenant_id=tenant_id,
        owner_user_id=user.id,
    )
    thread = _thread(
        "thread-review-tenant-failure",
        tenant_id=tenant_id,
        owner_user_id=user.id,
        folder_id=folder.id,
    )
    attachment = _attachment(
        "attachment-review-tenant-failure",
        tenant_id=tenant_id,
        owner_user_id=user.id,
    )
    store.chat_folders[folder.id] = folder
    store.chat_threads[thread.id] = thread
    store.chat_attachments[attachment.id or ""] = attachment
    store.create_user_api_key(user)
    repository.advance_session_issued_before_ms(
        user.id,
        tenant_id,
        1_800_000_200_000,
        reason="pre-review-tenant-failure",
        updated_at=datetime(2026, 7, 20, 13, 30, tzinfo=UTC),
        updated_by=actor.id,
    )
    store.save_runtime_state(urgent=True)

    def _review_failure(_tenant_id: str) -> int:
        raise RuntimeError("review tenant purge failed")

    monkeypatch.setattr(review_deps, "purge_review_tenant", _review_failure)
    try:
        # The fenced saga commits the identity deletion, clears application
        # authority, then surfaces the review-stage failure honestly instead
        # of reporting a completed deletion.
        with pytest.raises(RuntimeError, match="review tenant purge failed"):
            store.delete_tenant(tenant_id, actor)

        assert tenant_id not in store.tenants
        assert user.id not in store.users
        incomplete = store.identity_cleanup_repository.list_incomplete_cleanup_jobs()
        assert len(incomplete) == 1
        failed_job = incomplete[0]
        assert failed_job.tenant_id == tenant_id
        assert failed_job.identity_committed_at is not None
        assert failed_job.next_stage == "review"
        assert failed_job.last_error_stage == "review"

        # A healed restart resumes the durable job and finishes every
        # remaining stage; nothing is silently marked complete earlier.
        resumed_tenants: list[str] = []
        monkeypatch.setattr(
            review_deps,
            "purge_review_tenant",
            lambda deleted_tenant_id: resumed_tenants.append(deleted_tenant_id) or 0,
        )
        assert store.resume_identity_cleanup_jobs() == 1
        assert resumed_tenants == [tenant_id]
        assert store.identity_cleanup_repository.list_incomplete_cleanup_jobs() == []
    finally:
        store.close()
