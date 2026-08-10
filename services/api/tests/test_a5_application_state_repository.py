from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import StatementError

from app.db.engine import CHAT_STATE_IMPORT_REVISION, create_application_engine, upgrade_database
from app.db.orm import (
    ChatStateImportRow,
    RevokedSessionRow,
    RuntimeStateImportRow,
    SessionFamilyRow,
    UserSessionWatermarkRow,
)
from app.models.schemas import (
    AuditEvent,
    ChatAttachment,
    ChatFolder,
    ChatMessage,
    ChatThread,
    UsageRecord,
    UserApiKeyRecord,
)
from app.repositories.application_state import ApplicationStateRepository


NOW = datetime(2026, 7, 20, 18, 30, tzinfo=UTC)


def _repository() -> ApplicationStateRepository:
    engine = create_application_engine("sqlite+pysqlite:///:memory:")
    upgrade_database(engine)
    return ApplicationStateRepository(engine)


def _thread(
    thread_id: str,
    *,
    tenant_id: str = "tenant-one",
    owner_user_id: str = "user-one",
    folder_id: str | None = None,
    content: str = "Original",
) -> ChatThread:
    return ChatThread(
        id=thread_id,
        tenant_id=tenant_id,
        owner_user_id=owner_user_id,
        title=f"Thread {thread_id}",
        model_id="model-one",
        group_id="group-one",
        pinned=True,
        folder_id=folder_id,
        updated_at="Just now",
        messages=[
            ChatMessage(
                id=f"message-{thread_id}",
                role="user",
                content=content,
                createdAt="10:30 AM",
                createdAtIso="2026-07-20T18:30:00+00:00",
                metadata={"nested": {"page": 4}, "labels": ["legal", "real"]},
                attachments=[
                    ChatAttachment(
                        id=f"inline-{thread_id}",
                        tenant_id=tenant_id,
                        owner_user_id=owner_user_id,
                        name="brief.pdf",
                        size="20 KB",
                        kind="PDF",
                        size_bytes=20_480,
                    )
                ],
                usage={"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
            )
        ],
    )


def _folder(
    folder_id: str,
    *,
    tenant_id: str = "tenant-one",
    owner_user_id: str = "user-one",
) -> ChatFolder:
    return ChatFolder(
        id=folder_id,
        tenant_id=tenant_id,
        owner_user_id=owner_user_id,
        name=f"Folder {folder_id}",
        created_at="2026-07-20T18:30:00+00:00",
    )


def _attachment(
    attachment_id: str | None,
    *,
    tenant_id: str = "tenant-one",
    owner_user_id: str = "user-one",
) -> ChatAttachment:
    return ChatAttachment(
        id=attachment_id,
        tenant_id=tenant_id,
        owner_user_id=owner_user_id,
        name="evidence.txt",
        size="12 B",
        kind="Text",
        mime_type="text/plain",
        size_bytes=12,
        source_type="upload",
        source_uri=f"upload://{attachment_id}" if attachment_id else None,
        status="uploaded",
        uploaded_at="2026-07-20T18:30:00+00:00",
        text_preview="runtime truth",
    )


def _api_key(user_id: str, secret: str, *, tenant_id: str = "tenant-one") -> UserApiKeyRecord:
    digest = hashlib.sha256(secret.encode()).hexdigest()
    return UserApiKeyRecord(
        id=user_id,
        user_id=user_id,
        tenant_id=tenant_id,
        key_hash=digest,
        key_prefix=secret[:12],
        masked_value=f"{secret[:12]}••••{secret[-4:]}",
        created_at="2026-07-20T18:30:00+00:00",
    )


def _audit() -> AuditEvent:
    return AuditEvent(
        id="audit-retained",
        tenant_id="tenant-one",
        actor_id="user-one",
        actor_name="User One",
        actor_role="USER",
        action="auth.login",
        target="user-one",
        created_at=NOW,
    )


def _usage() -> UsageRecord:
    return UsageRecord(
        id="usage-retained",
        tenant_id="tenant-one",
        user_id="user-one",
        user_name="User One",
        user_role="USER",
        model_id="model-one",
        created_at=NOW,
    )


def test_constructor_adapters_round_trip_messages_and_derive_sessions_only() -> None:
    repository = _repository()
    thread = _thread("thread-one")
    try:
        assert repository.chat_threads == {}
        assert repository.chat_folders == {}
        assert repository.chat_attachments == {}
        assert repository.user_api_keys == {}
        assert repository.chat_sessions == {}
        assert repository.session_issued_before_ms == {}

        repository.chat_threads[thread.id] = thread
        stored = repository.chat_threads[thread.id]

        assert stored.model_dump(mode="json") == thread.model_dump(mode="json")
        assert repository.chat_sessions[thread.id].model_dump(mode="json") == thread.model_dump(
            mode="json", exclude={"messages"}
        )
        assert not hasattr(repository.chat_sessions[thread.id], "messages")
        with pytest.raises(TypeError):
            repository.chat_sessions[thread.id] = repository.chat_sessions[thread.id]  # type: ignore[index]
        with pytest.raises(ValidationError, match="frozen"):
            stored.title = "Mutation must be explicit"

        # Nested values are detached even though compatibility callers can
        # still manipulate their local Pydantic copy.
        stored.messages[0].content = "Detached change"
        assert repository.chat_threads[thread.id].messages[0].content == "Original"
    finally:
        repository.close()


def test_thread_save_order_and_strict_message_json_fail_closed() -> None:
    repository = _repository()
    try:
        repository.upsert_chat_thread(_thread("thread-one"))
        repository.upsert_chat_thread(_thread("thread-two"))
        repository.upsert_chat_thread(_thread("thread-one", content="Updated"))

        assert list(repository.chat_threads) == ["thread-two", "thread-one"]
        assert [thread.id for thread in repository.list_chat_threads()] == [
            "thread-one",
            "thread-two",
        ]

        corrupt = [
            {
                **_thread("thread-one").messages[0].model_dump(mode="json"),
                "unknown_runtime_field": "must not disappear silently",
            }
        ]
        with repository.engine.begin() as connection:
            connection.execute(
                text("update chat_threads set messages = :messages where id = :thread_id"),
                {"messages": json.dumps(corrupt), "thread_id": "thread-one"},
            )
        with pytest.raises((StatementError, ValueError), match="unknown|Stored chat message"):
            repository.get_chat_thread("thread-one")

        nonfinite = _thread("thread-nan")
        nonfinite.messages[0].metadata["invalid"] = float("nan")
        with pytest.raises((StatementError, ValueError), match="finite|strict JSON"):
            repository.upsert_chat_thread(nonfinite)
        assert repository.get_chat_thread("thread-nan") is None
    finally:
        repository.close()


def test_folder_delete_unfiles_only_authorized_threads_without_reordering() -> None:
    repository = _repository()
    try:
        repository.upsert_chat_folder(_folder("folder-one"))
        repository.upsert_chat_thread(_thread("thread-match", folder_id="folder-one"))
        repository.upsert_chat_thread(
            _thread("thread-other-owner", owner_user_id="user-two", folder_id="folder-one")
        )
        repository.upsert_chat_thread(
            _thread("thread-other-tenant", tenant_id="tenant-two", folder_id="folder-one")
        )
        before = list(repository.chat_threads)

        deleted, cleared = repository.delete_chat_folder("folder-one")

        assert deleted is not None
        assert cleared == ["thread-match"]
        assert list(repository.chat_threads) == before
        assert repository.chat_threads["thread-match"].folder_id is None
        assert repository.chat_threads["thread-other-owner"].folder_id == "folder-one"
        assert repository.chat_threads["thread-other-tenant"].folder_id == "folder-one"
        assert [
            thread.id
            for thread in repository.list_chat_threads_for_owner(
                owner_user_id="user-one",
                tenant_id="tenant-one",
            )
        ] == ["thread-match"]
        assert (
            repository.list_chat_threads_for_owner(
                owner_user_id="user-one",
                tenant_id="tenant-three",
            )
            == []
        )
        assert {
            thread.id
            for thread in repository.list_chat_threads_for_owner(
                owner_user_id="user-one",
                tenant_id=None,
                allow_cross_tenant=True,
            )
        } == {"thread-match", "thread-other-tenant"}
    finally:
        repository.close()


def test_attachment_acl_matches_personal_and_platform_owner_contract() -> None:
    repository = _repository()
    try:
        generated = repository.upsert_chat_attachment(_attachment(None))
        assert generated.id is not None and generated.id.startswith("upload-")
        repository.upsert_chat_attachment(
            _attachment("attachment-two", tenant_id="tenant-two", owner_user_id="user-two")
        )

        assert (
            repository.get_chat_attachment_for_owner(
                generated.id,
                owner_user_id="user-one",
                tenant_id="tenant-one",
            )
            == generated
        )
        assert (
            repository.get_chat_attachment_for_owner(
                "attachment-two",
                owner_user_id="user-one",
                tenant_id="tenant-one",
            )
            is None
        )
        assert (
            repository.get_chat_attachment_for_owner(
                "attachment-two",
                owner_user_id="platform-owner",
                tenant_id=None,
                allow_platform_owner_global=True,
            )
            is not None
        )
    finally:
        repository.close()


def test_api_key_hash_lookup_validation_and_real_touch_are_sql_only() -> None:
    repository = _repository()
    first = _api_key("user-one", "apt_real_secret_one")
    try:
        repository.upsert_user_api_key(first)

        preclassified = repository.lookup_api_key_hash(first.key_hash, touch_last_used=False)
        assert preclassified is not None and preclassified.last_used_at is None
        assert repository.user_api_keys["user-one"].last_used_at is None

        touched = repository.lookup_api_key_hash(
            first.key_hash,
            touch_last_used=True,
            touched_at="2026-07-20T18:31:00+00:00",
        )
        assert touched is not None
        assert touched.last_used_at == "2026-07-20T18:31:00+00:00"
        assert repository.user_api_keys["user-one"].last_used_at == touched.last_used_at

        invalid = first.model_copy(update={"key_hash": "A" * 64})
        with pytest.raises(ValueError, match="64 lowercase hexadecimal"):
            repository.upsert_user_api_key(invalid)
        assert repository.lookup_api_key_hash("not-a-sha256") is None

        duplicate = first.model_copy(update={"id": "key-two", "user_id": "user-two"})
        with pytest.raises(ValueError, match="another user"):
            repository.upsert_user_api_key(duplicate)
        assert list(repository.user_api_keys) == ["user-one"]

        # Simulate rotation after a non-touching preclassification. The stale
        # digest must not touch the replacement row.
        replacement = _api_key("user-one", "apt_rotated_secret")
        repository.upsert_user_api_key(replacement)
        assert not repository.touch_user_api_key_if_current(
            first.id,
            first.key_hash,
            "2026-07-20T18:32:00+00:00",
        )
        assert repository.user_api_keys["user-one"].last_used_at is None
        assert repository.touch_user_api_key_if_current(
            replacement.id,
            replacement.key_hash,
            "2026-07-20T18:33:00+00:00",
        )
        assert repository.user_api_keys["user-one"].last_used_at == "2026-07-20T18:33:00+00:00"
    finally:
        repository.close()


def test_session_watermark_is_epoch_ms_monotonic_and_concurrency_safe() -> None:
    engine = create_application_engine("sqlite+pysqlite:///:memory:")
    upgrade_database(engine)
    first = ApplicationStateRepository(engine)
    second = ApplicationStateRepository(engine)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            values = list(
                executor.map(
                    lambda item: item[0].advance_session_issued_before_ms(
                        "user-one",
                        "tenant-one",
                        item[1],
                        reason="admin-revoke",
                        updated_at=NOW,
                        updated_by="admin-one",
                    ),
                    ((first, 1_721_500_000_123), (second, 1_721_500_000_999)),
                )
            )
        assert max(values) == 1_721_500_000_999
        assert first.get_session_issued_before_ms("user-one") == 1_721_500_000_999
        assert (
            first.advance_session_issued_before_ms(
                "user-one",
                "tenant-one",
                1_721_500_000_500,
                reason="must-not-regress",
            )
            == 1_721_500_000_999
        )
        assert first.session_issued_before_ms == {"user-one": 1_721_500_000_999}
        row = first.run_transaction(
            lambda session: session.scalar(
                select(UserSessionWatermarkRow).where(UserSessionWatermarkRow.user_id == "user-one")
            )
        )
        assert row is not None and row.updated_by == "admin-one"
        with pytest.raises(ValueError, match="reason"):
            first.advance_session_issued_before_ms(
                "user-two",
                "tenant-one",
                1,
                reason="   ",
            )
        with pytest.raises(ValueError, match="updated_by"):
            first.advance_session_issued_before_ms(
                "user-two",
                "tenant-one",
                1,
                updated_by=" " * 2,
            )
    finally:
        first.close()
        second.close()


def test_expired_session_purge_is_ordered_and_bounded() -> None:
    repository = _repository()
    try:
        for suffix, expires_at in (
            ("oldest", 101),
            ("middle", 102),
            ("newest", 103),
            ("live", 200),
        ):
            repository.register_session_family(
                sid=f"session-{suffix}",
                user_id="user-one",
                tenant_id="tenant-one",
                expires_at=expires_at,
                issued_at_ms=100_000,
            )
            repository.revoke_session_family(
                sid=f"session-{suffix}",
                user_id="user-one",
                tenant_id="tenant-one",
                issued_at=100,
                expires_at=expires_at,
                revoked_at=NOW,
            )

        assert repository.purge_expired_sessions(150, limit=2) == 2
        remaining = repository.run_transaction(
            lambda session: list(
                session.scalars(
                    select(RevokedSessionRow.sid).order_by(RevokedSessionRow.expires_at)
                )
            )
        )
        assert remaining == ["session-newest", "session-live"]

        assert repository.purge_expired_sessions(150, limit=2) == 1
        assert repository.is_session_revoked("session-live")
        assert repository.purge_expired_sessions(150, limit=2) == 0
        with pytest.raises(ValueError, match="limit must be positive"):
            repository.purge_expired_sessions(150, limit=0)
    finally:
        repository.close()


def test_expired_family_cleanup_is_bounded_across_unrevoked_and_revoked_rows() -> None:
    repository = _repository()
    try:
        for sid, expires_at in (
            ("active-oldest", 101),
            ("revoked-middle", 102),
            ("active-newest", 103),
            ("active-live", 200),
        ):
            repository.register_session_family(
                sid=sid,
                user_id="user-one",
                tenant_id="tenant-one",
                expires_at=expires_at,
                issued_at_ms=100_000,
            )
        repository.revoke_session_family(
            sid="revoked-middle",
            user_id="user-one",
            tenant_id="tenant-one",
            issued_at=100,
            expires_at=102,
            revoked_at=NOW,
        )
        repository.revoke_session_family(
            sid="legacy-quarantine",
            user_id="user-one",
            tenant_id="tenant-one",
            issued_at=1,
            expires_at=50,
            revoked_at=NOW,
        )

        assert not repository.is_session_revoked("active-oldest")
        assert repository.purge_expired_sessions(150, limit=2) == 2
        assert repository.get_session_family("active-oldest") is None
        assert not repository.is_session_revoked("active-oldest")
        assert repository.get_session_family("revoked-middle") is None
        assert not repository.is_session_revoked("revoked-middle")
        assert repository.get_session_family("active-newest") is not None
        assert repository.get_session_family("active-live") is not None
        legacy = repository.get_session_family("legacy-quarantine")
        assert legacy is not None and legacy.legacy_unbounded is True

        assert repository.purge_expired_sessions(150, limit=2) == 1
        assert repository.get_session_family("active-newest") is None
        assert repository.get_session_family("active-live") is not None
        assert repository.get_session_family("legacy-quarantine") is not None
    finally:
        repository.close()


def test_cleanup_quarantines_orphan_and_mismatched_revocation_markers() -> None:
    repository = _repository()
    try:
        repository.run_transaction(
            lambda session: session.add_all(
                [
                    RevokedSessionRow(
                        sid="orphan-marker",
                        user_id="user-one",
                        tenant_id="tenant-one",
                        issued_at=100,
                        expires_at=200,
                        revoked_at=NOW,
                        reason="orphan",
                    ),
                    SessionFamilyRow(
                        sid="mismatched-marker",
                        user_id="user-one",
                        tenant_id="tenant-one",
                        max_expires_at=200,
                        legacy_unbounded=False,
                        revoked_at=NOW,
                        revoked_by_issued_at=100,
                        revoked_by_expires_at=200,
                        updated_at=NOW,
                    ),
                    RevokedSessionRow(
                        sid="mismatched-marker",
                        user_id="user-one",
                        tenant_id="tenant-one",
                        issued_at=100,
                        expires_at=201,
                        revoked_at=NOW,
                        reason="mismatch",
                    ),
                ]
            )
        )

        assert repository.purge_expired_sessions(10_000, limit=10) == 0
        assert repository.is_session_revoked("orphan-marker")
        assert repository.get_session_family("orphan-marker") is None
        mismatched = repository.get_session_family("mismatched-marker")
        assert mismatched is not None and mismatched.revoked_at == NOW
        assert repository.is_session_revoked("mismatched-marker")
    finally:
        repository.close()


def test_atomic_user_and_tenant_purge_retain_governance_and_watermark_history() -> None:
    repository = _repository()
    try:
        repository.append_audit_with_outbox(_audit())
        repository.append_usage_unbounded(_usage())
        repository.revoke_session(
            sid="session-retained",
            user_id="user-one",
            tenant_id="tenant-one",
            issued_at=1_721_500_000,
            expires_at=1_722_000_000,
            revoked_at=NOW,
        )
        repository.upsert_chat_thread(_thread("thread-one"))
        repository.upsert_chat_folder(_folder("folder-one"))
        repository.upsert_chat_attachment(_attachment("attachment-one"))
        repository.upsert_user_api_key(_api_key("user-one", "apt_delete_me"))

        removed = repository.purge_a5_user(
            "user-one",
            "tenant-one",
            1_721_500_000_001,
            updated_at=NOW,
            updated_by="admin-one",
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
        assert repository.chat_threads == {}
        assert repository.chat_folders == {}
        assert repository.chat_attachments == {}
        assert repository.user_api_keys == {}
        assert repository.count_audit() == 1
        assert repository.count_usage() == 1
        assert repository.count_outbox() == 1
        assert repository.is_session_revoked("session-retained")
        assert repository.session_issued_before_ms["user-one"] == 1_721_500_000_001

        # Recreating a current-state identity does not erase its security
        # history; tenant deletion advances the same retained row.
        repository.upsert_chat_thread(_thread("thread-recreated"))
        repository.upsert_user_api_key(_api_key("user-one", "apt_recreated"))
        tenant_removed = repository.purge_a5_tenant(
            "tenant-one",
            {"user-one": 1_721_500_000_777},
            updated_at=NOW,
            updated_by="platform-owner",
        )
        assert tenant_removed["removed_threads"] == 1
        assert tenant_removed["removed_api_keys"] == 1
        assert tenant_removed["retained_watermarks"] == 1
        assert repository.session_issued_before_ms["user-one"] == 1_721_500_000_777
        assert repository.count_audit() == 1
        assert repository.count_usage() == 1
        assert repository.count_outbox() == 1
        assert repository.is_session_revoked("session-retained")
    finally:
        repository.close()


def test_chat_import_marker_requires_matching_a4_receipt_and_live_head() -> None:
    repository = _repository()
    a4_digest = "a" * 64
    chat_digest = "b" * 64
    try:
        repository.insert_import_marker(
            RuntimeStateImportRow(
                source_digest=a4_digest,
                source_version=2,
                target_version=3,
                completed_at=NOW,
                audit_count=0,
                usage_count=0,
                outbox_count=0,
                alert_notification_count=0,
                alert_runtime_count=0,
            )
        )
        marker = ChatStateImportRow(
            source_digest=chat_digest,
            source_version=3,
            target_version=4,
            completed_at=NOW,
            prior_application_state_digest=a4_digest,
            thread_count=1,
            folder_count=2,
            attachment_count=3,
            api_key_count=4,
            watermark_count=0,
        )
        repository.insert_chat_import_marker(marker)
        canonical = {
            "source_digest": chat_digest,
            "source_version": 3,
            "target_version": 4,
            "schema_revision": CHAT_STATE_IMPORT_REVISION,
            "prior_application_state_digest": a4_digest,
            "thread_count": 1,
            "folder_count": 2,
            "attachment_count": 3,
            "api_key_count": 4,
            "watermark_count": 0,
        }
        assert repository.verify_chat_import_marker(marker)
        assert repository.verify_chat_import_marker({"chat_state_import": canonical})
        assert not repository.verify_chat_import_marker(
            {"chat_state_import": {**canonical, "api_key_count": 99}}
        )
    finally:
        repository.close()
