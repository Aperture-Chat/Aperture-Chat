from __future__ import annotations

from dataclasses import replace

import pytest

from app.core.provider_credential_secrets import (
    ProviderCredentialCipherContext,
    ProviderCredentialCiphertextError,
    decrypt_provider_credential_secret,
    encrypt_provider_credential_secret,
    resume_scoped_provider_credentials_from_stage,
    scope_provider_credentials_for_import,
    upgrade_legacy_provider_credential_ciphertext,
)
from app.core.security import SecretVault
from app.db.import_identity_config import (
    MODEL_COLLECTIONS,
    ProviderKeyImportRecord,
    validate_v4_identity_config_state,
)
from app.models.schemas import Provider, Tenant
from app.repositories.identity_config import ProviderCredentialBinding


def _binding(
    *,
    provider_id: str = "provider-a",
    key_id: str = "key-a",
    tenant_id: str | None = None,
) -> ProviderCredentialBinding:
    return ProviderCredentialBinding(
        provider_id=provider_id,
        key_id=key_id,
        tenant_id=tenant_id,
    )


def _context(
    *,
    provider_id: str = "provider-a",
    key_id: str = "key-a",
    tenant_id: str | None = None,
    scope_key: str = "platform",
) -> ProviderCredentialCipherContext:
    return ProviderCredentialCipherContext(
        provider_id=provider_id,
        key_id=key_id,
        tenant_id=tenant_id,
        scope_key=scope_key,
    )


@pytest.mark.parametrize(
    "replayed_context",
    [
        _context(provider_id="provider-b"),
        _context(key_id="key-b"),
        _context(tenant_id="tenant-a"),
        _context(scope_key="tenant:tenant-a"),
    ],
    ids=["provider", "key", "tenant", "scope"],
)
def test_provider_ciphertext_replay_across_any_authority_dimension_is_rejected(
    replayed_context: ProviderCredentialCipherContext,
) -> None:
    vault = SecretVault("provider-aad-replay-test-signing-secret")
    source_context = _context()
    ciphertext = encrypt_provider_credential_secret(
        vault,
        "provider-secret-value",
        context=source_context,
    )

    assert (
        decrypt_provider_credential_secret(vault, ciphertext, context=source_context)
        == "provider-secret-value"
    )
    with pytest.raises(ProviderCredentialCiphertextError, match="scoped integrity"):
        decrypt_provider_credential_secret(
            vault,
            ciphertext,
            context=replayed_context,
        )


def test_binding_factory_uses_canonical_platform_and_tenant_scopes() -> None:
    platform = ProviderCredentialCipherContext.from_binding(_binding())
    tenant = ProviderCredentialCipherContext.from_binding(
        _binding(key_id="key-tenant", tenant_id="tenant-a")
    )

    assert platform.scope_key == "platform"
    assert platform.tenant_id is None
    assert tenant.scope_key == "tenant:tenant-a"
    assert tenant.tenant_id == "tenant-a"
    assert platform.aad() == platform.aad()
    assert platform.aad() != tenant.aad()


def test_legacy_v2_provider_ciphertext_is_upgraded_once_to_exact_scope() -> None:
    vault = SecretVault("provider-v2-upgrade-test-signing-secret")
    context = ProviderCredentialCipherContext.from_binding(
        _binding(key_id="key-tenant", tenant_id="tenant-a")
    )
    legacy = vault.encrypt("legacy-provider-secret")

    upgraded = upgrade_legacy_provider_credential_ciphertext(
        vault,
        legacy,
        context=context,
    )

    assert legacy.startswith(SecretVault.V2_PREFIX)
    assert upgraded.startswith(SecretVault.V3_PREFIX)
    assert upgraded != legacy
    assert (
        decrypt_provider_credential_secret(vault, upgraded, context=context)
        == "legacy-provider-secret"
    )
    assert (
        upgrade_legacy_provider_credential_ciphertext(
            vault,
            upgraded,
            context=context,
        )
        == upgraded
    )


def test_existing_v3_ciphertext_is_never_reinterpreted_as_legacy() -> None:
    vault = SecretVault("provider-v3-validation-test-signing-secret")
    source_context = _context()
    copied_context = replace(source_context, key_id="key-copied")
    ciphertext = encrypt_provider_credential_secret(
        vault,
        "provider-secret-value",
        context=source_context,
    )

    with pytest.raises(ProviderCredentialCiphertextError, match="scoped integrity"):
        upgrade_legacy_provider_credential_ciphertext(
            vault,
            ciphertext,
            context=copied_context,
        )


def test_validated_v4_cutover_scopes_provider_ciphertext_without_changing_source_digest() -> None:
    vault = SecretVault("provider-cutover-test-signing-secret")
    legacy = vault.encrypt("cutover-provider-secret")
    source = validate_v4_identity_config_state(_v4_payload(legacy))

    scoped = scope_provider_credentials_for_import(vault, source)
    scoped_ciphertext = dict(scoped.encrypted_provider_keys)["key-platform"]
    transformed_reference = validate_v4_identity_config_state(_v4_payload(scoped_ciphertext))

    assert scoped.source_digest == source.source_digest
    assert scoped.source_digest != transformed_reference.source_digest
    assert scoped.relational_digest == transformed_reference.relational_digest
    assert scoped.relational_digest != source.relational_digest
    assert scoped.collection_counts == source.collection_counts
    assert scoped.knowledge_digest == source.knowledge_digest
    assert scoped_ciphertext.startswith(SecretVault.V3_PREFIX)
    assert (
        decrypt_provider_credential_secret(
            vault,
            scoped_ciphertext,
            context=ProviderCredentialCipherContext.from_binding(
                _binding(provider_id="provider-a", key_id="key-platform")
            ),
        )
        == "cutover-provider-secret"
    )

    # A crash retry over already-scoped validated state must not create a new
    # nonce or a different staged relational digest.
    assert scope_provider_credentials_for_import(vault, scoped) is scoped


def test_v4_cutover_rejects_scoped_ciphertext_from_another_key() -> None:
    vault = SecretVault("provider-cutover-replay-test-signing-secret")
    copied_ciphertext = encrypt_provider_credential_secret(
        vault,
        "provider-secret-value",
        context=_context(key_id="key-other"),
    )
    validated = validate_v4_identity_config_state(_v4_payload(copied_ciphertext))

    with pytest.raises(ProviderCredentialCiphertextError, match="scoped integrity"):
        scope_provider_credentials_for_import(vault, validated)


def test_unchanged_v4_restart_reuses_exact_randomized_staged_ciphertext() -> None:
    vault = SecretVault("provider-cutover-crash-retry-signing-secret")
    unchanged_payload = _v4_payload(vault.encrypt("provider-secret-value"))
    first_process_source = validate_v4_identity_config_state(unchanged_payload)
    staged_state = scope_provider_credentials_for_import(vault, first_process_source)
    staged_receipt = staged_state.create_receipt(schema_revision="20260720_0009")

    # Simulate a crash after SQL staging but before vector import/activation.
    # The next process reads the unchanged v4 file and the inactive staged SQL
    # rows. It must authenticate and reuse their exact randomized token rather
    # than generating another nonce and conflicting relational digest.
    restarted_source = validate_v4_identity_config_state(unchanged_payload)
    resumed = resume_scoped_provider_credentials_from_stage(
        vault,
        restarted_source,
        staged_receipt=staged_receipt,
        staged_encrypted_provider_keys=staged_state.encrypted_provider_keys,
    )

    assert resumed.source_digest == first_process_source.source_digest
    assert resumed.relational_digest == staged_receipt.relational_digest
    assert resumed.encrypted_provider_keys == staged_state.encrypted_provider_keys


def test_staged_resume_rejects_ciphertext_or_receipt_from_another_transform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = SecretVault("provider-cutover-stage-conflict-signing-secret")
    source = validate_v4_identity_config_state(_v4_payload(vault.encrypt("provider-secret-value")))
    nonces = iter((b"\x01" * 12, b"\x02" * 12))
    monkeypatch.setattr("app.core.security.os.urandom", lambda size: next(nonces))
    first_stage = scope_provider_credentials_for_import(vault, source)
    first_receipt = first_stage.create_receipt(schema_revision="20260720_0009")
    second_stage = scope_provider_credentials_for_import(vault, source)

    with pytest.raises(ProviderCredentialCiphertextError, match="relational receipt"):
        resume_scoped_provider_credentials_from_stage(
            vault,
            source,
            staged_receipt=first_receipt,
            staged_encrypted_provider_keys=second_stage.encrypted_provider_keys,
        )


def test_v4_cutover_requires_the_strict_validated_state_type() -> None:
    vault = SecretVault("provider-cutover-type-test-signing-secret")

    with pytest.raises(TypeError, match="ValidatedIdentityConfigState"):
        scope_provider_credentials_for_import(vault, _v4_payload(vault.encrypt("secret")))  # type: ignore[arg-type]


def _v4_payload(ciphertext: str) -> dict[str, object]:
    tenant = Tenant(id="tenant-a", name="Tenant A", slug="tenant-a")
    provider = Provider(
        id="provider-a",
        name="Provider A",
        kind="openrouter",
        region="global",
    )
    key = ProviderKeyImportRecord(
        id="key-platform",
        provider_id=provider.id,
        tenant_id=None,
        provider_name=provider.name,
        name="Platform credential",
        environment="Production",
        status="Active",
        last_rotated="2026-07-20",
        expires="Not set",
        masked_value="masked-provider-secret",
    )
    payload: dict[str, object] = {
        "version": 4,
        "application_state_import": {
            "source_digest": "a" * 64,
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
            "source_digest": "b" * 64,
            "source_version": 3,
            "target_version": 4,
            "schema_revision": "20260720_0004",
            "prior_application_state_digest": "a" * 64,
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
        "password_credentials": {},
        "temporary_password_user_ids": [],
        "encrypted_provider_keys": {key.id: ciphertext},
        "configuration_secrets": {},
    }
    for collection_name in MODEL_COLLECTIONS:
        payload[collection_name] = []
    payload["tenants"] = [tenant.model_dump(mode="json")]
    payload["providers"] = [provider.model_dump(mode="json")]
    payload["provider_keys"] = [key.model_dump(mode="json")]
    return payload
