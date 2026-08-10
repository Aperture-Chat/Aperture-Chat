from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier
from typing import Any, cast

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.db.engine import (
    IDENTITY_CONFIG_IMPORT_REVISION,
    create_application_engine,
    upgrade_database,
)
from app.db.import_identity_config import (
    IdentityConfigImportReceipt,
    MODEL_COLLECTIONS,
    ProviderKeyImportRecord,
    ValidatedIdentityConfigState,
    validate_v4_identity_config_state,
)
from app.db.knowledge_import_state import (
    SEMANTIC_FORMAT,
    SPARSE_VECTOR_FORMAT,
    KnowledgeStateImportReceipt,
)
from app.db.orm import ChatStateImportRow, RuntimeStateImportRow
from app.models.schemas import Connector, ConnectorConfig, Provider, Tenant, User
from app.repositories.identity_config import ProviderCredentialBinding, ProviderCredentialBundle
from app.repositories.identity_config_sql import (
    IdentityConfigActivationError,
    IdentityConfigCorruptionError,
    IdentityConfigImportConflict,
    IdentityConfigSqlError,
    IdentityConfigSqlRepository,
    IdentityConfigSnapshotConflict,
)


APPLICATION_DIGEST = "a" * 64
CHAT_DIGEST = "b" * 64
STAMP = datetime(2026, 7, 20, 18, 30, tzinfo=UTC)


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    database = create_application_engine(
        f"sqlite+pysqlite:///{(tmp_path / 'identity-config.sqlite3').as_posix()}"
    )
    upgrade_database(database)
    try:
        yield database
    finally:
        database.dispose()


def _state_and_receipt() -> tuple[
    ValidatedIdentityConfigState,
    IdentityConfigImportReceipt,
]:
    tenant = Tenant(id="tenant-a", name="Tenant A", slug="tenant-a")
    user = User(
        id="user-a",
        tenant_id=tenant.id,
        email="USER@Example.com",
        display_name="User A",
        auth_method="local",
    )
    provider = Provider(
        id="provider-a",
        name="Provider A",
        kind="openrouter",
        region="global",
    )
    provider_key = ProviderKeyImportRecord(
        id="key-platform",
        provider_id=provider.id,
        tenant_id=None,
        provider_name=provider.name,
        name="Platform credential",
        environment="Production",
        status="Active",
        last_rotated="2026-07-20",
        expires="Not set",
        masked_value="masked-platform",
    )
    connector = Connector(id="connector-a", name="Connector A", category="Files")
    connector_config = ConnectorConfig(
        id="connector-config-a",
        tenant_id=tenant.id,
        connector_id=connector.id,
        auth_type="oauth",
        secret_set=True,
        masked_secret="masked-connector",
    )

    payload: dict[str, object] = {
        "version": 4,
        "application_state_import": {
            "source_digest": APPLICATION_DIGEST,
            "source_version": 2,
            "target_version": 3,
            "schema_revision": "20260720_0003",
            "audit_count": 0,
            "usage_count": 0,
            "outbox_count": 0,
            "alert_notification_count": 0,
            "alert_runtime_count": 0,
        },
        "chat_state_import": {
            "source_digest": CHAT_DIGEST,
            "source_version": 3,
            "target_version": 4,
            "schema_revision": "20260720_0004",
            "prior_application_state_digest": APPLICATION_DIGEST,
            "thread_count": 0,
            "folder_count": 0,
            "attachment_count": 0,
            "api_key_count": 0,
            "watermark_count": 0,
        },
        "knowledge_documents": {},
        "knowledge_chunks": {},
        "platform_settings": {},
        "email_settings": {},
        "password_credentials": {user.id: "password-hash"},
        # The validator canonicalizes this set before hashing it.
        "temporary_password_user_ids": [user.id],
        "encrypted_provider_keys": {provider_key.id: "v2.provider-ciphertext"},
        "configuration_secrets": {
            f"connector-user-oauth:{connector_config.id}:{user.id}": ("v2.connector-ciphertext")
        },
    }
    for collection_name in MODEL_COLLECTIONS:
        payload[collection_name] = []
    payload["tenants"] = [tenant.model_dump(mode="json")]
    payload["users"] = [user.model_dump(mode="json")]
    payload["providers"] = [provider.model_dump(mode="json")]
    payload["provider_keys"] = [provider_key.model_dump(mode="json")]
    payload["connectors"] = [connector.model_dump(mode="json")]
    payload["connector_configs"] = [connector_config.model_dump(mode="json")]

    state = validate_v4_identity_config_state(payload)
    receipt = state.create_receipt(
        schema_revision=IDENTITY_CONFIG_IMPORT_REVISION,
        completed_at=STAMP,
    )
    return state, receipt


def _seed_predecessor_receipts(engine: Engine) -> None:
    with Session(engine) as session, session.begin():
        session.add(
            RuntimeStateImportRow(
                source_digest=APPLICATION_DIGEST,
                source_version=2,
                target_version=3,
                completed_at=STAMP,
                audit_count=0,
                usage_count=0,
                outbox_count=0,
                alert_notification_count=0,
                alert_runtime_count=0,
            )
        )
        session.add(
            ChatStateImportRow(
                source_digest=CHAT_DIGEST,
                source_version=3,
                target_version=4,
                completed_at=STAMP,
                prior_application_state_digest=APPLICATION_DIGEST,
                thread_count=0,
                folder_count=0,
                attachment_count=0,
                api_key_count=0,
                watermark_count=0,
            )
        )


def _vector_receipt(state: ValidatedIdentityConfigState) -> KnowledgeStateImportReceipt:
    return KnowledgeStateImportReceipt(
        source_digest=state.source_digest,
        source_version=4,
        target_version=5,
        semantic_digest=state.knowledge_digest,
        semantic_format=SEMANTIC_FORMAT,
        sparse_vector_format=SPARSE_VECTOR_FORMAT,
        document_count=state.collection_counts["knowledge_documents"],
        chunk_count=state.collection_counts["knowledge_chunks"],
        completed_at=STAMP.isoformat(),
    )


def _stage_and_activate(
    engine: Engine,
) -> tuple[
    IdentityConfigSqlRepository,
    ValidatedIdentityConfigState,
    IdentityConfigImportReceipt,
]:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    repository = IdentityConfigSqlRepository(engine)
    repository.import_validated_identity_config(state=state, receipt=receipt)
    repository.activate_identity_config(
        source_digest=state.source_digest,
        vector_receipt=_vector_receipt(state),
        activated_at=STAMP,
    )
    return repository, state, receipt


def _active_digest(repository: IdentityConfigSqlRepository) -> str:
    snapshot = repository.load_active_snapshot()
    assert snapshot is not None
    return snapshot.relational_digest


def _payload_from_state(state: ValidatedIdentityConfigState) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "version": 4,
        "application_state_import": {
            "source_digest": state.prior_import_chain.application_state_digest,
            "source_version": 2,
            "target_version": 3,
            "schema_revision": "20260720_0003",
            "audit_count": 0,
            "usage_count": 0,
            "outbox_count": 0,
            "alert_notification_count": 0,
            "alert_runtime_count": 0,
        },
        "chat_state_import": {
            "source_digest": state.prior_import_chain.chat_state_digest,
            "source_version": 3,
            "target_version": 4,
            "schema_revision": "20260720_0004",
            "prior_application_state_digest": (state.prior_import_chain.application_state_digest),
            "thread_count": 0,
            "folder_count": 0,
            "attachment_count": 0,
            "api_key_count": 0,
            "watermark_count": 0,
        },
        "knowledge_documents": {
            key: [record.model_dump(mode="json") for record in records]
            for key, records in state.knowledge_documents.items()
        },
        "knowledge_chunks": {
            key: [record.model_dump(mode="json") for record in records]
            for key, records in state.knowledge_chunks.items()
        },
        "platform_settings": state.platform_settings.model_dump(mode="json"),
        "email_settings": state.email_settings.model_dump(mode="json"),
        "password_credentials": dict(state.password_credentials),
        "temporary_password_user_ids": list(state.temporary_password_user_ids),
        "encrypted_provider_keys": dict(state.encrypted_provider_keys),
        "configuration_secrets": dict(state.configuration_secrets),
    }
    payload.update(
        {
            name: [record.model_dump(mode="json") for record in records]
            for name, records in state.collections.items()
        }
    )
    return payload


def _replacement_state(
    state: ValidatedIdentityConfigState,
    *,
    tenant_name: str,
    secret_ciphertext: str,
    include_tenant_credential: bool = True,
) -> ValidatedIdentityConfigState:
    payload = _payload_from_state(state)
    tenant_rows = cast(list[dict[str, Any]], payload["tenants"])
    tenant_rows[0]["name"] = tenant_name
    secrets = cast(dict[str, str], payload["configuration_secrets"])
    secrets["connector-user-oauth:connector-config-a:user-a"] = secret_ciphertext
    if include_tenant_credential:
        credential = _tenant_credential("key-tenant")
        provider_keys = cast(list[dict[str, Any]], payload["provider_keys"])
        if not any(row["id"] == credential.key_id for row in provider_keys):
            provider_keys.append(dict(credential.metadata))
        encrypted = cast(dict[str, str], payload["encrypted_provider_keys"])
        encrypted[credential.key_id] = credential.ciphertext
    return validate_v4_identity_config_state(payload)


def _state_with_second_identity(
    state: ValidatedIdentityConfigState,
) -> ValidatedIdentityConfigState:
    payload = _payload_from_state(state)
    tenant_rows = cast(list[dict[str, Any]], payload["tenants"])
    user_rows = cast(list[dict[str, Any]], payload["users"])
    tenant_rows.append(
        Tenant(id="tenant-b", name="Tenant B", slug="tenant-b").model_dump(mode="json")
    )
    user_rows.append(
        User(
            id="user-b",
            tenant_id="tenant-b",
            email="user-b@example.com",
            display_name="User B",
            auth_method="local",
        ).model_dump(mode="json")
    )
    return validate_v4_identity_config_state(payload)


def _state_with_swapped_identity_uniques(
    state: ValidatedIdentityConfigState,
) -> ValidatedIdentityConfigState:
    payload = _payload_from_state(state)
    tenant_rows = cast(list[dict[str, Any]], payload["tenants"])
    user_rows = cast(list[dict[str, Any]], payload["users"])
    tenant_by_id = {row["id"]: row for row in tenant_rows}
    tenant_by_id["tenant-a"]["slug"] = "tenant-b"
    tenant_by_id["tenant-b"]["slug"] = "tenant-a"
    payload["tenants"] = list(reversed(tenant_rows))
    user_by_id = {row["id"]: row for row in user_rows}
    user_by_id["user-a"]["email"] = "user-b@example.com"
    user_by_id["user-b"]["email"] = "USER@Example.com"
    payload["users"] = list(reversed(user_rows))
    return validate_v4_identity_config_state(payload)


def _tenant_credential(key_id: str) -> ProviderCredentialBundle:
    model = ProviderKeyImportRecord(
        id=key_id,
        provider_id="provider-a",
        tenant_id="tenant-a",
        provider_name="Provider A",
        name="Tenant credential",
        environment="Production",
        status="Active",
        last_rotated="2026-07-20",
        expires="Not set",
        masked_value=f"masked-{key_id}",
    )
    return ProviderCredentialBundle(
        metadata=model.model_dump(mode="json"),
        ciphertext="v3."
        + base64.urlsafe_b64encode(
            f"ciphertext-{key_id}".encode("utf-8").ljust(32, b"x")
        ).decode("ascii"),
        binding=ProviderCredentialBinding(
            provider_id=model.provider_id,
            key_id=model.id,
            tenant_id=model.tenant_id,
        ),
    )


def test_stage_is_atomic_idempotent_and_never_activates_sql(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    repository = IdentityConfigSqlRepository(engine)

    first = repository.import_validated_identity_config(state=state, receipt=receipt)
    second = repository.import_validated_identity_config(state=state, receipt=receipt)

    assert first.disposition == "imported"
    assert second.disposition == "already_applied"
    assert repository.active_identity_config_receipt() is None
    assert repository.load_active_snapshot() is None
    with engine.connect() as connection:
        assert connection.execute(text("select count(*) from tenants")).scalar_one() == 1
        assert connection.execute(text("select count(*) from provider_keys")).scalar_one() == 1
        assert (
            connection.execute(text("select count(*) from identity_config_imports")).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text("select count(*) from identity_config_active_import")
            ).scalar_one()
            == 0
        )


def test_activation_requires_exact_vector_receipt_then_exposes_snapshot(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    repository = IdentityConfigSqlRepository(engine)
    repository.import_validated_identity_config(state=state, receipt=receipt)
    wrong_vector = replace(_vector_receipt(state), semantic_digest="f" * 64)

    with pytest.raises(IdentityConfigActivationError, match="vector receipt"):
        repository.activate_identity_config(
            source_digest=state.source_digest,
            vector_receipt=wrong_vector,
        )
    assert repository.active_identity_config_receipt() is None

    activated = repository.activate_identity_config(
        source_digest=state.source_digest,
        vector_receipt=_vector_receipt(state),
        activated_at=STAMP,
    )
    replay = repository.activate_identity_config(
        source_digest=state.source_digest,
        vector_receipt=_vector_receipt(state),
        activated_at=STAMP,
    )
    snapshot = repository.load_active_snapshot()

    assert activated.source_digest == state.source_digest
    assert replay.source_digest == state.source_digest
    assert snapshot is not None
    assert snapshot.collections["users"][0].email == "USER@Example.com"
    assert snapshot.temporary_password_user_ids == ("user-a",)
    assert dict(snapshot.encrypted_provider_keys) == {"key-platform": "v2.provider-ciphertext"}
    assert dict(snapshot.configuration_secrets) == {
        "connector-user-oauth:connector-config-a:user-a": "v2.connector-ciphertext"
    }


def test_receipt_tamper_blocks_activation_without_pointer(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    repository = IdentityConfigSqlRepository(engine)
    repository.import_validated_identity_config(state=state, receipt=receipt)
    with engine.begin() as connection:
        connection.execute(
            text(
                "update identity_config_imports set relational_digest = :digest "
                "where source_digest = :source"
            ),
            {"digest": "f" * 64, "source": state.source_digest},
        )

    with pytest.raises(IdentityConfigActivationError, match="relational receipt digest"):
        repository.activate_identity_config(
            source_digest=state.source_digest,
            vector_receipt=_vector_receipt(state),
        )
    with engine.connect() as connection:
        assert (
            connection.execute(
                text("select count(*) from identity_config_active_import")
            ).scalar_one()
            == 0
        )


def test_incoming_receipt_tamper_fails_before_any_sql_mutation(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    tampered = replace(receipt, relational_digest="f" * 64)
    repository = IdentityConfigSqlRepository(engine)

    with pytest.raises(IdentityConfigImportConflict, match="does not match"):
        repository.import_validated_identity_config(state=state, receipt=tampered)

    with engine.connect() as connection:
        assert connection.execute(text("select count(*) from tenants")).scalar_one() == 0
        assert (
            connection.execute(text("select count(*) from identity_config_imports")).scalar_one()
            == 0
        )


def test_partial_preexisting_authority_fails_closed(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    with engine.begin() as connection:
        connection.execute(
            text(
                "insert into tenants (id, ordinal, slug, custom_domain, payload) "
                "values ('partial', 0, 'partial', null, :payload)"
            ),
            {
                "payload": (
                    '{"id":"partial","name":"Partial","slug":"partial",'
                    '"custom_domain":null,"primary_color":"#087d8b",'
                    '"logo_mark":"aperture","chat_brand_name":"Aperture Chat",'
                    '"logo_url":null,"icon_url":null,"gradient_start":null,'
                    '"gradient_end":null,"text_color":null}'
                )
            },
        )
    repository = IdentityConfigSqlRepository(engine)

    with pytest.raises(IdentityConfigImportConflict, match="partial"):
        repository.import_validated_identity_config(state=state, receipt=receipt)
    with engine.connect() as connection:
        assert connection.execute(text("select count(*) from tenants")).scalar_one() == 1
        assert (
            connection.execute(text("select count(*) from identity_config_imports")).scalar_one()
            == 0
        )


@pytest.mark.parametrize(
    ("metadata_key", "field", "value"),
    [
        ("application_state_import", "source_version", 0),
        ("application_state_import", "audit_count", 1),
        ("application_state_import", "usage_count", 1),
        ("application_state_import", "outbox_count", 1),
        ("application_state_import", "alert_notification_count", 1),
        ("application_state_import", "alert_runtime_count", 1),
        ("chat_state_import", "thread_count", 1),
        ("chat_state_import", "folder_count", 1),
        ("chat_state_import", "attachment_count", 1),
        ("chat_state_import", "api_key_count", 1),
        ("chat_state_import", "watermark_count", 1),
    ],
)
def test_embedded_predecessor_metadata_must_exactly_match_sql_receipts(
    engine: Engine,
    metadata_key: str,
    field: str,
    value: int,
) -> None:
    _seed_predecessor_receipts(engine)
    initial_state, _initial_receipt = _state_and_receipt()
    payload = _payload_from_state(initial_state)
    payload[metadata_key][field] = value
    state = validate_v4_identity_config_state(payload)
    receipt = state.create_receipt(
        schema_revision=IDENTITY_CONFIG_IMPORT_REVISION,
        completed_at=STAMP,
    )

    with pytest.raises(IdentityConfigImportConflict, match="metadata does not match"):
        IdentityConfigSqlRepository(engine).import_validated_identity_config(
            state=state,
            receipt=receipt,
        )


def test_database_failure_rolls_back_every_staged_row_and_receipt(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    with engine.begin() as connection:
        connection.execute(
            text(
                "create trigger reject_provider_key before insert on provider_keys "
                "begin select raise(abort, 'forced provider-key failure'); end"
            )
        )
    repository = IdentityConfigSqlRepository(engine)

    with pytest.raises(IdentityConfigSqlError, match="staging transaction failed"):
        repository.import_validated_identity_config(state=state, receipt=receipt)

    with engine.connect() as connection:
        for table_name in (
            "tenants",
            "identity_users",
            "providers",
            "provider_keys",
            "configuration_secrets",
            "identity_config_imports",
            "identity_config_active_import",
        ):
            assert connection.execute(text(f"select count(*) from {table_name}")).scalar_one() == 0


def test_provider_resolution_prefers_tenant_then_platform_fallback(engine: Engine) -> None:
    repository, state, receipt = _stage_and_activate(engine)

    platform_fallback = repository.resolve_provider_credential(
        provider_id="provider-a",
        tenant_id="tenant-a",
    )
    tenant_credential = _tenant_credential("key-tenant")
    stored = repository.write_provider_credential(
        tenant_credential,
        expected_binding_key_id=None,
        updated_at=STAMP,
    )

    assert platform_fallback is not None
    assert platform_fallback.key_id == "key-platform"
    assert stored.key_id == "key-tenant"
    assert (
        repository.resolve_provider_credential(
            provider_id="provider-a",
            tenant_id="tenant-a",
        ).key_id
        == "key-tenant"
    )

    rotated = repository.write_provider_credential(
        _tenant_credential("key-tenant-next"),
        expected_binding_key_id="key-tenant",
        updated_at=STAMP,
    )
    snapshot = repository.load_active_snapshot()
    assert rotated.key_id == "key-tenant-next"
    assert snapshot is not None
    assert {record.id: record.status for record in snapshot.collections["provider_keys"]} == {
        "key-platform": "Active",
        "key-tenant": "Inactive",
        "key-tenant-next": "Active",
    }
    assert (
        repository.resolve_provider_credential(
            provider_id="provider-a",
            tenant_id="tenant-other",
        ).key_id
        == "key-platform"
    )

    # Active SQL ignores an exact stale import replay after legitimate writes.
    replay = repository.import_validated_identity_config(state=state, receipt=receipt)
    assert replay.disposition == "already_applied"
    assert (
        repository.resolve_provider_credential(
            provider_id="provider-a",
            tenant_id="tenant-a",
        ).key_id
        == "key-tenant-next"
    )


def test_provider_ciphertext_and_binding_roll_back_together(engine: Engine) -> None:
    repository, _, _ = _stage_and_activate(engine)
    first = _tenant_credential("key-tenant")
    repository.write_provider_credential(
        first,
        expected_binding_key_id=None,
        updated_at=STAMP,
    )
    with engine.begin() as connection:
        connection.execute(
            text(
                "create trigger reject_binding_update before update "
                "on provider_credential_bindings "
                "begin select raise(abort, 'forced binding failure'); end"
            )
        )

    with pytest.raises(IdentityConfigSqlError, match="credential transaction failed"):
        repository.write_provider_credential(
            _tenant_credential("key-tenant-next"),
            expected_binding_key_id="key-tenant",
            updated_at=STAMP,
        )

    with engine.connect() as connection:
        assert (
            connection.execute(
                text("select count(*) from provider_keys where id = 'key-tenant-next'")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text(
                    "select provider_key_id from provider_credential_bindings "
                    "where provider_id = 'provider-a' and scope_key = 'tenant:tenant-a'"
                )
            ).scalar_one()
            == "key-tenant"
        )


def test_conflicting_active_pointer_cannot_be_replaced(engine: Engine) -> None:
    repository, state, receipt = _stage_and_activate(engine)
    other_source = "c" * 64
    with engine.begin() as connection:
        connection.execute(
            text(
                "insert into identity_config_imports ("
                "source_digest, source_version, target_version, schema_revision, "
                "prior_application_state_digest, prior_chat_state_digest, "
                "relational_digest, knowledge_digest, collection_counts, completed_at"
                ") select :source, source_version, target_version, schema_revision, "
                "prior_application_state_digest, prior_chat_state_digest, "
                "relational_digest, knowledge_digest, collection_counts, completed_at "
                "from identity_config_imports where source_digest = :original"
            ),
            {"source": other_source, "original": state.source_digest},
        )
    other_vector = replace(_vector_receipt(state), source_digest=other_source)

    with pytest.raises(IdentityConfigActivationError, match="different"):
        repository.activate_identity_config(
            source_digest=other_source,
            vector_receipt=other_vector,
        )
    assert repository.active_identity_config_receipt().source_digest == receipt.source_digest


def test_staged_receipt_supports_crash_resume_and_rejects_active_authority(
    engine: Engine,
) -> None:
    repository = IdentityConfigSqlRepository(engine)
    assert repository.staged_identity_config_receipt() is None
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    repository.import_validated_identity_config(state=state, receipt=receipt)

    staged = repository.staged_identity_config_receipt()
    staged_snapshot = repository.load_staged_snapshot()

    assert staged is not None
    assert staged_snapshot is not None
    assert staged.to_dict() == receipt.to_dict()
    assert staged_snapshot.receipt.to_dict() == receipt.to_dict()
    assert staged_snapshot.encrypted_provider_keys == state.encrypted_provider_keys
    repository.activate_identity_config(
        source_digest=state.source_digest,
        vector_receipt=_vector_receipt(state),
        activated_at=STAMP,
    )
    with pytest.raises(IdentityConfigActivationError, match="already active"):
        repository.staged_identity_config_receipt()


def test_staged_receipt_fails_closed_when_provider_binding_is_missing(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    repository = IdentityConfigSqlRepository(engine)
    repository.import_validated_identity_config(state=state, receipt=receipt)
    with engine.begin() as connection:
        connection.execute(text("delete from provider_credential_bindings"))

    with pytest.raises(IdentityConfigCorruptionError, match="do not match active"):
        repository.staged_identity_config_receipt()
    assert repository.active_identity_config_receipt() is None


def test_replace_active_snapshot_is_verified_idempotent_and_preserves_receipt(
    engine: Engine,
) -> None:
    repository, initial_state, receipt = _stage_and_activate(engine)
    replacement_state = _replacement_state(
        initial_state,
        tenant_name="Tenant A Renamed",
        secret_ciphertext="v2.connector-ciphertext-updated",
    )

    replaced = repository.replace_active_snapshot(
        state=replacement_state,
        expected_relational_digest=_active_digest(repository),
        updated_at=STAMP,
    )

    assert replaced.collections["tenants"][0].name == "Tenant A Renamed"
    assert dict(replaced.configuration_secrets) == {
        "connector-user-oauth:connector-config-a:user-a": ("v2.connector-ciphertext-updated")
    }
    assert {binding.key_id for binding in replaced.provider_bindings} == {
        "key-platform",
        "key-tenant",
    }
    assert replaced.receipt.to_dict() == receipt.to_dict()
    assert (
        repository.resolve_provider_credential(
            provider_id="provider-a",
            tenant_id="tenant-a",
        ).key_id
        == "key-tenant"
    )
    with engine.begin() as connection:
        connection.execute(
            text(
                "create trigger reject_settings_update before update on platform_settings "
                "begin select raise(abort, 'idempotent replacement wrote rows'); end"
            )
        )

    replay = repository.replace_active_snapshot(
        state=replacement_state,
        # Exact replay is a no-write success even with the original stale
        # generation because it cannot erase a disjoint newer value.
        expected_relational_digest=initial_state.relational_digest,
        updated_at=STAMP,
    )

    assert replay == replaced
    with engine.connect() as connection:
        assert (
            connection.execute(text("select count(*) from identity_config_imports")).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text("select count(*) from identity_config_active_import")
            ).scalar_one()
            == 1
        )


def test_replace_active_snapshot_rolls_back_every_authority_row(engine: Engine) -> None:
    repository, initial_state, receipt = _stage_and_activate(engine)
    baseline = repository.load_active_snapshot()
    replacement_state = _replacement_state(
        initial_state,
        tenant_name="Must Roll Back",
        secret_ciphertext="v2.must-roll-back",
    )
    with engine.begin() as connection:
        connection.execute(
            text(
                "create trigger reject_replacement_binding before insert "
                "on provider_credential_bindings "
                "begin select raise(abort, 'forced final binding failure'); end"
            )
        )

    with pytest.raises(IdentityConfigSqlError, match="replacement transaction failed"):
        repository.replace_active_snapshot(
            state=replacement_state,
            expected_relational_digest=_active_digest(repository),
            updated_at=STAMP,
        )

    assert repository.load_active_snapshot() == baseline
    assert repository.active_identity_config_receipt().to_dict() == receipt.to_dict()
    with engine.connect() as connection:
        assert (
            connection.execute(
                text("select json_extract(payload, '$.name') from tenants where id = 'tenant-a'")
            ).scalar_one()
            == "Tenant A"
        )
        assert (
            connection.execute(
                text("select provider_key_id from provider_credential_bindings")
            ).scalar_one()
            == "key-platform"
        )


def test_replace_active_snapshot_handles_unique_swaps_and_parent_deletes(
    engine: Engine,
) -> None:
    repository, initial_state, _ = _stage_and_activate(engine)
    two_identities = _state_with_second_identity(initial_state)
    repository.replace_active_snapshot(
        state=two_identities,
        expected_relational_digest=_active_digest(repository),
        updated_at=STAMP,
    )
    swapped = _state_with_swapped_identity_uniques(two_identities)

    swapped_snapshot = repository.replace_active_snapshot(
        state=swapped,
        expected_relational_digest=_active_digest(repository),
        updated_at=STAMP,
    )

    assert [record.id for record in swapped_snapshot.collections["tenants"]] == [
        "tenant-b",
        "tenant-a",
    ]
    assert {record.id: record.slug for record in swapped_snapshot.collections["tenants"]} == {
        "tenant-a": "tenant-b",
        "tenant-b": "tenant-a",
    }
    assert {record.id: record.email for record in swapped_snapshot.collections["users"]} == {
        "user-a": "user-b@example.com",
        "user-b": "USER@Example.com",
    }

    final_state = _replacement_state(
        initial_state,
        tenant_name="Tenant A Final",
        secret_ciphertext="v2.connector-ciphertext-final",
        include_tenant_credential=False,
    )
    final_snapshot = repository.replace_active_snapshot(
        state=final_state,
        expected_relational_digest=_active_digest(repository),
        updated_at=STAMP,
    )

    assert [record.id for record in final_snapshot.collections["tenants"]] == ["tenant-a"]
    assert [record.id for record in final_snapshot.collections["users"]] == ["user-a"]
    assert [binding.key_id for binding in final_snapshot.provider_bindings] == ["key-platform"]


def test_two_engine_stale_snapshot_cannot_overwrite_disjoint_newer_write(
    engine: Engine,
) -> None:
    first, initial_state, _receipt = _stage_and_activate(engine)
    second_engine = create_application_engine(str(engine.url))
    second = IdentityConfigSqlRepository(second_engine)
    try:
        first_generation = _active_digest(first)
        stale_generation = _active_digest(second)
        assert stale_generation == first_generation
        first_state = _replacement_state(
            initial_state,
            tenant_name="First writer won",
            secret_ciphertext="v2.connector-ciphertext",
        )
        stale_state = _replacement_state(
            initial_state,
            tenant_name="Tenant A",
            secret_ciphertext="v2.second-writer-secret",
        )

        first.replace_active_snapshot(
            state=first_state,
            expected_relational_digest=first_generation,
            updated_at=STAMP,
        )
        with pytest.raises(IdentityConfigSnapshotConflict, match="changed before"):
            second.replace_active_snapshot(
                state=stale_state,
                expected_relational_digest=stale_generation,
                updated_at=STAMP,
            )

        current = first.load_active_snapshot()
        assert current is not None
        assert current.collections["tenants"][0].name == "First writer won"
        assert dict(current.configuration_secrets) == {
            "connector-user-oauth:connector-config-a:user-a": "v2.connector-ciphertext"
        }
    finally:
        second_engine.dispose()


def test_two_engine_same_source_cutover_race_is_idempotent(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    second_engine = create_application_engine(str(engine.url))
    repositories = (
        IdentityConfigSqlRepository(engine),
        IdentityConfigSqlRepository(second_engine),
    )
    barrier = Barrier(2)

    def stage(repository: IdentityConfigSqlRepository) -> str:
        barrier.wait()
        return repository.import_validated_identity_config(
            state=state,
            receipt=receipt,
        ).disposition

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            dispositions = list(executor.map(stage, repositories))
        assert sorted(dispositions) == ["already_applied", "imported"]
    finally:
        second_engine.dispose()


def test_two_engine_conflicting_source_cutover_race_fails_one_closed(
    engine: Engine,
) -> None:
    _seed_predecessor_receipts(engine)
    first_state, first_receipt = _state_and_receipt()
    payload = _payload_from_state(first_state)
    payload["tenants"][0]["name"] = "Conflicting tenant"
    second_state = validate_v4_identity_config_state(payload)
    second_receipt = second_state.create_receipt(
        schema_revision=IDENTITY_CONFIG_IMPORT_REVISION,
        completed_at=STAMP,
    )
    second_engine = create_application_engine(str(engine.url))
    inputs = (
        (IdentityConfigSqlRepository(engine), first_state, first_receipt),
        (IdentityConfigSqlRepository(second_engine), second_state, second_receipt),
    )
    barrier = Barrier(2)

    def stage(
        item: tuple[
            IdentityConfigSqlRepository,
            ValidatedIdentityConfigState,
            IdentityConfigImportReceipt,
        ],
    ) -> str:
        repository, state, receipt = item
        barrier.wait()
        try:
            return repository.import_validated_identity_config(
                state=state,
                receipt=receipt,
            ).disposition
        except IdentityConfigImportConflict:
            return "conflict"

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            dispositions = list(executor.map(stage, inputs))
        assert sorted(dispositions) == ["conflict", "imported"]
    finally:
        second_engine.dispose()


def test_two_engine_same_vector_activation_race_is_idempotent(engine: Engine) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    first = IdentityConfigSqlRepository(engine)
    first.import_validated_identity_config(state=state, receipt=receipt)
    second_engine = create_application_engine(str(engine.url))
    repositories = (first, IdentityConfigSqlRepository(second_engine))
    barrier = Barrier(2)

    def activate(repository: IdentityConfigSqlRepository) -> str:
        barrier.wait()
        return repository.activate_identity_config(
            source_digest=state.source_digest,
            vector_receipt=_vector_receipt(state),
            activated_at=STAMP,
        ).source_digest

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            sources = list(executor.map(activate, repositories))
        assert sources == [state.source_digest, state.source_digest]
        assert first.active_identity_config_receipt() is not None
    finally:
        second_engine.dispose()


def test_two_engine_mismatched_vector_activation_contender_fails_closed(
    engine: Engine,
) -> None:
    _seed_predecessor_receipts(engine)
    state, receipt = _state_and_receipt()
    first = IdentityConfigSqlRepository(engine)
    first.import_validated_identity_config(state=state, receipt=receipt)
    second_engine = create_application_engine(str(engine.url))
    inputs = (
        (first, _vector_receipt(state)),
        (
            IdentityConfigSqlRepository(second_engine),
            replace(_vector_receipt(state), semantic_digest="f" * 64),
        ),
    )
    barrier = Barrier(2)

    def activate(
        item: tuple[IdentityConfigSqlRepository, KnowledgeStateImportReceipt],
    ) -> str:
        repository, vector_receipt = item
        barrier.wait()
        try:
            repository.activate_identity_config(
                source_digest=state.source_digest,
                vector_receipt=vector_receipt,
                activated_at=STAMP,
            )
            return "activated"
        except IdentityConfigActivationError:
            return "rejected"

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(activate, inputs))
        assert sorted(outcomes) == ["activated", "rejected"]
        active = first.active_identity_config_receipt()
        assert active is not None
        assert active.source_digest == state.source_digest
    finally:
        second_engine.dispose()
