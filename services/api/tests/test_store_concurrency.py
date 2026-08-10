from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import main as main_module
from app.core.security import SecretVault
from app.models.schemas import ChatThread
from app.repositories.seed import SeedStore


def _persistent_store(tmp_path) -> SeedStore:
    return SeedStore(
        SecretVault("test-secret"),
        runtime_state_path=str(tmp_path / "runtime_state.json"),
    )


def _thread(index: int) -> ChatThread:
    return ChatThread(
        id=f"thread-concurrent-{index}",
        tenant_id="tenant-example",
        owner_user_id="user-admin",
        title=f"Concurrent thread {index}",
        model_id="gpt-4o-mini",
        group_id="group-litigation",
        updated_at=f"write-{index}",
    )


def test_seed_store_exposes_stable_a5_sql_views(tmp_path) -> None:
    store = _persistent_store(tmp_path)
    try:
        repository = store.application_state_repository
        assert store.chat_threads is repository.chat_threads
        assert store.chat_folders is repository.chat_folders
        assert store.chat_sessions is repository.chat_sessions
        assert store.chat_attachments is repository.chat_attachments
        assert store.user_api_keys is repository.user_api_keys
        assert store.session_issued_before_ms is repository.session_issued_before_ms
    finally:
        store.close()


def test_fifty_concurrent_writers_persist_one_complete_snapshot(tmp_path) -> None:
    store = _persistent_store(tmp_path)
    actor = store.users["user-admin"]

    def write(index: int) -> ChatThread:
        store.record_audit(actor, "test.concurrent_write", f"target-{index}")
        store.record_usage(actor=actor, model_id=f"concurrent-model-{index}")
        return store.save_chat_thread(_thread(index))

    with ThreadPoolExecutor(max_workers=16) as executor:
        saved = list(executor.map(write, range(50)))

    assert len(saved) == 50
    store.flush_now()
    store.close()

    reloaded = _persistent_store(tmp_path)
    try:
        expected_ids = {f"thread-concurrent-{index}" for index in range(50)}
        assert expected_ids <= set(reloaded.chat_threads)
        assert expected_ids <= set(reloaded.chat_sessions)
        assert all(
            reloaded.chat_threads[thread_id].title == reloaded.chat_sessions[thread_id].title
            for thread_id in expected_ids
        )
        assert (
            len(
                [
                    event
                    for event in reloaded.audit_events
                    if event.action == "test.concurrent_write"
                ]
            )
            == 50
        )
        assert (
            len(
                [
                    record
                    for record in reloaded.usage_records
                    if record.model_id.startswith("concurrent-model-")
                ]
            )
            == 50
        )
    finally:
        reloaded.close()


def test_active_sql_authority_saves_before_each_mutation_returns(tmp_path, monkeypatch) -> None:
    store = _persistent_store(tmp_path)
    original_write = store._write_runtime_state
    write_count = 0

    def counted_write() -> None:
        nonlocal write_count
        write_count += 1
        original_write()

    monkeypatch.setattr(store, "_write_runtime_state", counted_write)
    actor = store.users["user-admin"]
    for index in range(10):
        store.record_audit(actor, "test.debounced_write", f"target-{index}")
        assert write_count == index + 1

    assert store._runtime_state_dirty is False
    store.close()


def test_sustained_sql_authority_writes_never_defer_acknowledgement(tmp_path, monkeypatch) -> None:
    store = _persistent_store(tmp_path)
    original_write = store._write_runtime_state
    write_count = 0

    def counted_write() -> None:
        nonlocal write_count
        write_count += 1
        original_write()

    monkeypatch.setattr(store, "_write_runtime_state", counted_write)
    actor = store.users["user-admin"]
    for index in range(20):
        store.record_audit(actor, "test.sustained_write", f"target-{index}")
        assert write_count == index + 1

    store.flush_now()
    assert write_count == 20
    store.close()


def test_security_critical_mutations_flush_immediately(tmp_path, monkeypatch) -> None:
    store = _persistent_store(tmp_path)
    original_write = store._write_runtime_state
    write_count = 0

    def counted_write() -> None:
        nonlocal write_count
        write_count += 1
        original_write()

    monkeypatch.setattr(store, "_write_runtime_state", counted_write)
    actor = store.users["user-admin"]
    provider = store.providers["provider-openai"]

    store.set_password_credential(actor.id, "urgent-password")
    assert write_count == 1
    store.create_provider_key(
        key_id="key-urgent",
        provider=provider,
        name="Urgent key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="sk-urgent-test",
    )
    assert write_count == 2
    store.rotate_provider_key("key-urgent")
    assert write_count == 3
    configuration_record_id = "tool-hermes-example"
    store.set_configuration_secret("tool", configuration_record_id, "configuration-secret")
    assert write_count == 4
    store.delete_configuration_secret("tool", configuration_record_id)
    assert write_count == 5
    _record, _secret = store.create_user_api_key(actor)
    assert write_count == 5
    assert actor.id in store.user_api_keys
    store.revoke_user_api_key(actor.id)
    assert write_count == 5
    store.delete_provider_key("key-urgent")
    assert write_count == 6
    assert store._runtime_state_dirty is False

    payload = json.loads((tmp_path / "runtime_state.json").read_text(encoding="utf-8"))
    assert payload["version"] == 5
    assert "password_credentials" not in payload
    assert "provider_keys" not in payload
    assert "encrypted_provider_keys" not in payload
    assert "configuration_secrets" not in payload
    store.close()

    reloaded = _persistent_store(tmp_path)
    try:
        assert actor.id in reloaded.password_credentials
        assert "key-urgent" not in reloaded.provider_keys
        assert reloaded.configuration_secret("tool", configuration_record_id) is None
    finally:
        reloaded.close()


def test_api_key_last_used_is_sql_only_and_survives_restart(tmp_path, monkeypatch) -> None:
    store = _persistent_store(tmp_path)
    actor = store.users["user-admin"]
    _record, secret = store.create_user_api_key(actor)
    original_write = store._write_runtime_state
    write_count = 0

    def counted_write() -> None:
        nonlocal write_count
        write_count += 1
        original_write()

    monkeypatch.setattr(store, "_write_runtime_state", counted_write)
    assert store.user_for_api_key(secret, touch_last_used=False) == actor
    assert store._runtime_state_dirty is False
    assert store.user_for_api_key(secret) == actor
    assert write_count == 0
    assert store._runtime_state_dirty is False

    store.flush_now()
    assert write_count == 0
    store.close()

    reloaded = _persistent_store(tmp_path)
    try:
        assert reloaded.user_api_keys[actor.id].last_used_at is not None
    finally:
        reloaded.close()


def test_failed_write_leaves_state_dirty_and_retryable(tmp_path, monkeypatch) -> None:
    store = _persistent_store(tmp_path)
    original_write = store._write_runtime_state
    store.save_chat_thread(_thread(1))

    def failed_write() -> None:
        raise OSError("disk unavailable")

    monkeypatch.setattr(store, "_write_runtime_state", failed_write)
    store.users["user-admin"].last_active = "Pending SQL write"
    with pytest.raises(OSError, match="disk unavailable"):
        store.save_runtime_state()
    assert store._runtime_state_dirty is True

    monkeypatch.setattr(store, "_write_runtime_state", original_write)
    store.flush_now()
    assert store._runtime_state_dirty is False
    store.close()


def test_close_preserves_sql_usage_without_json_flush(tmp_path) -> None:
    store = _persistent_store(tmp_path)
    actor = store.users["user-admin"]
    store.record_usage(actor=actor, model_id="close-flush-model")
    assert store._runtime_state_dirty is False
    store.close()

    reloaded = _persistent_store(tmp_path)
    try:
        assert reloaded.usage_records[-1].model_id == "close-flush-model"
    finally:
        reloaded.close()


def test_api_lifespan_closes_the_runtime_store(monkeypatch) -> None:
    class FakeUsageBudgetRepository:
        abandoned = False

        def abandon_started_permits(self) -> int:
            self.abandoned = True
            return 0

    class FakeStore:
        closed = False
        usage_budget_repository = FakeUsageBudgetRepository()
        cleanup_resumed = False

        def resume_identity_cleanup_jobs(self) -> int:
            self.cleanup_resumed = True
            return 0

        def close(self) -> None:
            self.closed = True

    store = FakeStore()
    monkeypatch.setattr(main_module, "get_store", lambda: store)

    async def exercise_lifespan() -> None:
        async with main_module.lifespan(main_module.app):
            assert store.closed is False

    asyncio.run(exercise_lifespan())

    assert store.usage_budget_repository.abandoned is True
    assert store.cleanup_resumed is True
    assert store.closed is True
