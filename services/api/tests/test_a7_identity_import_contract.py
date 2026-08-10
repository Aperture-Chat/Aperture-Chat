from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.db.import_identity_config import (
    A7_RUNTIME_FIELDS,
    IdentityConfigImportError,
    build_v5_tombstone,
    canonicalize_deleted_profile_dependents,
    validate_v4_identity_config_state,
    validate_v5_tombstone,
)
from app.db.import_state import StateImportError, read_runtime_state_payload
from app.models.schemas import (
    Automation,
    AutomationStep,
    CompanionMemory,
    EmailSettings,
    ModelConfig,
    PlatformSettings,
    Provider,
    ProviderKey,
    Tenant,
    User,
)


APPLICATION_DIGEST = "a" * 64
CHAT_DIGEST = "b" * 64


def _valid_payload() -> dict[str, object]:
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
    }
    for field in A7_RUNTIME_FIELDS:
        if field in {"knowledge_documents", "knowledge_chunks"}:
            payload[field] = {}
        elif field in {
            "password_credentials",
            "encrypted_provider_keys",
            "configuration_secrets",
        }:
            payload[field] = {}
        elif field == "temporary_password_user_ids":
            payload[field] = []
        elif field == "platform_settings":
            payload[field] = PlatformSettings().model_dump(mode="json")
        elif field == "email_settings":
            payload[field] = EmailSettings().model_dump(mode="json")
        else:
            payload[field] = []

    payload["tenants"] = [
        Tenant(id="tenant-a", name="Tenant A", slug="tenant-a").model_dump(mode="json")
    ]
    payload["users"] = [
        User(
            id="user-a",
            tenant_id="tenant-a",
            email="user-a@example.com",
            display_name="User A",
        ).model_dump(mode="json")
    ]
    payload["providers"] = [
        Provider(
            id="provider-a",
            name="Provider A",
            kind="test",
            region="local",
        ).model_dump(mode="json")
    ]
    payload["provider_keys"] = [
        ProviderKey(
            id="key-a",
            provider_id="provider-a",
            provider_name="Provider A",
            name="Primary",
            environment="Production",
            last_rotated="Just now",
            expires="Not set",
        ).model_dump(mode="json")
    ]
    payload["encrypted_provider_keys"] = {"key-a": "v2.encrypted-value"}
    return payload


def test_valid_v4_contract_covers_every_runtime_field_and_builds_receipt() -> None:
    payload = _valid_payload()
    payload["password_credentials"] = {"user-a": "pbkdf2_sha256$310000$salt$digest"}
    payload["temporary_password_user_ids"] = ["user-a"]

    state = validate_v4_identity_config_state(payload)
    receipt = state.create_receipt(
        schema_revision="20260720_0009",
        completed_at=datetime(2026, 7, 20, 12, 30),
    )

    assert set(state.collection_counts) == A7_RUNTIME_FIELDS
    assert state.collection_counts["tenants"] == 1
    assert state.collection_counts["provider_keys"] == 1
    assert state.temporary_password_user_ids == ("user-a",)
    assert state.prior_import_chain.application_state_digest == APPLICATION_DIGEST
    assert state.prior_import_chain.chat_state_digest == CHAT_DIGEST
    assert len(state.source_digest) == len(state.relational_digest) == 64
    assert receipt.source_version == 4
    assert receipt.target_version == 5
    assert receipt.schema_revision == "20260720_0009"
    assert receipt.completed_at == "2026-07-20T12:30:00+00:00"


@pytest.mark.parametrize("failure", ["missing", "unknown", "duplicate", "wrong_type"])
def test_strict_contract_rejects_lossy_or_ambiguous_state(failure: str) -> None:
    payload = _valid_payload()
    if failure == "missing":
        payload.pop("automations")
    elif failure == "unknown":
        payload["future_runtime_collection"] = []
    elif failure == "duplicate":
        payload["providers"] = [*payload["providers"], payload["providers"][0]]  # type: ignore[index]
    else:
        payload["providers"][0]["connected"] = 1  # type: ignore[index]

    with pytest.raises(IdentityConfigImportError):
        validate_v4_identity_config_state(payload)


def test_disabled_legacy_automation_preserves_an_unresolved_model_step() -> None:
    payload = _valid_payload()
    payload["automations"] = [
        Automation(
            id="automation-hermes-review",
            tenant_id="tenant-a",
            name="Review this proposed automation",
            steps=[AutomationStep(model_id="deleted-agent-profile")],
            enabled=False,
        ).model_dump(mode="json")
    ]

    state = validate_v4_identity_config_state(payload)

    assert state.collections["automations"][0].id == "automation-hermes-review"
    assert state.collections["automations"][0].enabled is False
    assert state.collections["automations"][0].steps[0].model_id == "deleted-agent-profile"


def test_enabled_or_cross_tenant_automation_model_steps_still_fail_closed() -> None:
    payload = _valid_payload()
    payload["automations"] = [
        Automation(
            id="automation-enabled",
            tenant_id="tenant-a",
            name="Enabled automation",
            steps=[AutomationStep(model_id="deleted-agent-profile")],
            enabled=True,
        ).model_dump(mode="json")
    ]
    with pytest.raises(IdentityConfigImportError, match="Enabled automation.*unknown model"):
        validate_v4_identity_config_state(payload)

    payload = _valid_payload()
    payload["tenants"].append(  # type: ignore[union-attr]
        Tenant(id="tenant-b", name="Tenant B", slug="tenant-b").model_dump(mode="json")
    )
    payload["models"] = [
        ModelConfig(
            id="tenant-b-model",
            name="Tenant B model",
            provider_id="provider-a",
            provider_name="Provider A",
            tenant_id="tenant-b",
        ).model_dump(mode="json")
    ]
    payload["automations"] = [
        Automation(
            id="automation-cross-tenant",
            tenant_id="tenant-a",
            name="Cross-tenant automation",
            steps=[AutomationStep(model_id="tenant-b-model")],
            enabled=False,
        ).model_dump(mode="json")
    ]
    with pytest.raises(IdentityConfigImportError, match="cross-tenant model"):
        validate_v4_identity_config_state(payload)


def test_deleted_profile_cleanup_removes_only_unreachable_companion_memories() -> None:
    payload = _valid_payload()
    payload["models"] = [
        ModelConfig(
            id="live-profile",
            name="Live profile",
            provider_id="provider-a",
            provider_name="Provider A",
            tenant_id="tenant-a",
        ).model_dump(mode="json")
    ]
    payload["companion_memories"] = [
        CompanionMemory(
            id="memory-live",
            tenant_id="tenant-a",
            profile_id="live-profile",
            content="Keep this memory.",
            created_by="user-a",
            created_at="2026-07-20T12:30:00+00:00",
        ).model_dump(mode="json"),
        CompanionMemory(
            id="memory-orphan",
            tenant_id="tenant-a",
            profile_id="deleted-profile",
            content="Unreachable legacy residue.",
            created_by="user-a",
            created_at="2026-07-20T12:31:00+00:00",
        ).model_dump(mode="json"),
    ]

    canonical, removed_ids = canonicalize_deleted_profile_dependents(payload)

    assert removed_ids == ("memory-orphan",)
    assert [record["id"] for record in canonical["companion_memories"]] == ["memory-live"]
    assert len(payload["companion_memories"]) == 2  # type: ignore[arg-type]
    state = validate_v4_identity_config_state(canonical)
    assert state.collection_counts["companion_memories"] == 1


def test_predecessor_receipts_must_be_exact_and_cryptographically_chained() -> None:
    payload = _valid_payload()
    payload["chat_state_import"]["prior_application_state_digest"] = "c" * 64  # type: ignore[index]
    with pytest.raises(IdentityConfigImportError, match="not bound"):
        validate_v4_identity_config_state(payload)

    payload = _valid_payload()
    payload["application_state_import"]["unexpected"] = 1  # type: ignore[index]
    with pytest.raises(IdentityConfigImportError, match="incompatible shape"):
        validate_v4_identity_config_state(payload)


def test_provider_metadata_ciphertext_and_scope_binding_fail_closed() -> None:
    payload = _valid_payload()
    payload["encrypted_provider_keys"] = {}
    with pytest.raises(IdentityConfigImportError, match="do not match exactly"):
        validate_v4_identity_config_state(payload)

    payload = _valid_payload()
    duplicate = deepcopy(payload["provider_keys"][0])  # type: ignore[index]
    duplicate["id"] = "key-b"
    duplicate["name"] = "Also active"
    payload["provider_keys"] = [*payload["provider_keys"], duplicate]  # type: ignore[arg-type]
    payload["encrypted_provider_keys"] = {
        "key-a": "v2.encrypted-value",
        "key-b": "v2.other-encrypted-value",
    }
    with pytest.raises(IdentityConfigImportError, match="ambiguous active"):
        validate_v4_identity_config_state(payload)

    payload = _valid_payload()
    payload["provider_keys"][0]["expires"] = "Nto set"
    with pytest.raises(IdentityConfigImportError, match=r"provider_keys\[0\]"):
        validate_v4_identity_config_state(payload)


def test_temporary_password_ids_are_a_canonical_semantic_set() -> None:
    payload = _valid_payload()
    payload["users"] = [
        *payload["users"],  # type: ignore[list-item]
        User(
            id="user-b",
            tenant_id="tenant-a",
            email="user-b@example.com",
            display_name="User B",
        ).model_dump(mode="json"),
    ]
    payload["password_credentials"] = {"user-a": "hash-a", "user-b": "hash-b"}
    payload["temporary_password_user_ids"] = ["user-b", "user-a"]

    state = validate_v4_identity_config_state(payload)

    assert state.temporary_password_user_ids == ("user-a", "user-b")


def test_v5_tombstone_contains_only_bound_receipts_and_never_secret_state() -> None:
    state = validate_v4_identity_config_state(_valid_payload())
    receipt = state.create_receipt(
        schema_revision="20260720_0009",
        completed_at=datetime(2026, 7, 20, 12, 30, tzinfo=UTC),
    )

    tombstone = build_v5_tombstone(
        receipt,
        application_state_metadata=state.prior_import_chain.application_state_metadata,
        chat_state_metadata=state.prior_import_chain.chat_state_metadata,
        knowledge_state_metadata={
            "source_digest": state.source_digest,
            "semantic_digest": state.knowledge_digest,
        },
    )

    assert set(tombstone) == {
        "version",
        "application_state_import",
        "chat_state_import",
        "identity_config_import",
        "knowledge_state_import",
    }
    assert tombstone["version"] == 5
    serialized = repr(tombstone)
    assert "v2.encrypted-value" not in serialized
    assert (
        validate_v5_tombstone(
            tombstone,
            identity_receipt=receipt,
            knowledge_state_metadata=tombstone["knowledge_state_import"],
        )
        == state.prior_import_chain
    )


def test_v5_tombstone_builder_rejects_malformed_predecessor_metadata() -> None:
    state = validate_v4_identity_config_state(_valid_payload())
    receipt = state.create_receipt(schema_revision="20260720_0009")

    with pytest.raises(IdentityConfigImportError, match="incompatible shape"):
        build_v5_tombstone(
            receipt,
            application_state_metadata={"source_digest": APPLICATION_DIGEST},
            chat_state_metadata=state.prior_import_chain.chat_state_metadata,
            knowledge_state_metadata={
                "source_digest": state.source_digest,
                "semantic_digest": state.knowledge_digest,
            },
        )


@pytest.mark.parametrize(
    "raw_json",
    [
        '{"version":4,"providers":[],"providers":[]}',
        (
            '{"version":4,"configuration_secrets":'
            '{"tool:config-a":"v2.a","tool:config-a":"v2.b"}}'
        ),
    ],
)
def test_runtime_json_reader_rejects_duplicate_object_keys(
    tmp_path: Path,
    raw_json: str,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    state_path.write_text(raw_json, encoding="utf-8")

    with pytest.raises(StateImportError, match="strict JSON"):
        read_runtime_state_payload(state_path)


def test_import_bounds_match_postgres_varchar_semantics() -> None:
    payload = _valid_payload()
    provider_id = "p" * 255
    payload["providers"][0]["id"] = provider_id  # type: ignore[index]
    payload["provider_keys"][0]["provider_id"] = provider_id  # type: ignore[index]
    validate_v4_identity_config_state(payload)

    payload = deepcopy(payload)
    provider_id = "p" * 256
    payload["providers"][0]["id"] = provider_id  # type: ignore[index]
    payload["provider_keys"][0]["provider_id"] = provider_id  # type: ignore[index]
    with pytest.raises(IdentityConfigImportError, match="255-character SQL bound"):
        validate_v4_identity_config_state(payload)


def test_custom_domains_are_unique_case_insensitively_before_sql() -> None:
    payload = _valid_payload()
    payload["tenants"][0]["custom_domain"] = "EXAMPLE.com"  # type: ignore[index]
    second = Tenant(
        id="tenant-b",
        name="Tenant B",
        slug="tenant-b",
        custom_domain="example.com",
    ).model_dump(mode="json")
    payload["tenants"] = [*payload["tenants"], second]  # type: ignore[arg-type]

    with pytest.raises(IdentityConfigImportError, match="custom domain"):
        validate_v4_identity_config_state(payload)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("slug", "Tenant A"),
        ("custom_domain", "https://EXAMPLE.com/path"),
        ("custom_domain", "EXAMPLE.com"),
    ],
)
def test_import_rejects_noncanonical_tenant_routing_identity(
    field: str,
    value: str,
) -> None:
    payload = _valid_payload()
    payload["tenants"][0][field] = value  # type: ignore[index]

    with pytest.raises(IdentityConfigImportError, match="not canonical"):
        validate_v4_identity_config_state(payload)
