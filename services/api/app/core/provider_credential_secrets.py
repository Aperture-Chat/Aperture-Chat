"""Scoped encryption for provider credentials.

Provider-key ciphertext is durable SQL state.  Its authentication boundary must
therefore include the row identity that authorizes the secret, rather than only
the deployment-wide vault key.  This module keeps that boundary independent of
``SeedStore`` and SQLAlchemy so every writer and reader uses the same canonical
AAD.

Version-4 runtime snapshots contain unscoped vault ciphertext.  The cutover
helper below accepts only an already validated A7 state, upgrades each provider
secret once, preserves the digest of the original source document, and
recomputes the relational digest for the rows that will actually be staged.
"""

from __future__ import annotations

import binascii
import hashlib
import hmac
import json
from dataclasses import dataclass, replace

from app.core.security import SecretVault
from app.db.import_identity_config import (
    MODEL_COLLECTIONS,
    SOURCE_STATE_VERSION,
    TARGET_STATE_VERSION,
    IdentityConfigImportReceipt,
    ProviderKeyImportRecord,
    ValidatedIdentityConfigState,
)
from app.repositories.identity_config import ProviderCredentialBinding


_AAD_KIND = "aperture-provider-credential"
_AAD_VERSION = 1


class ProviderCredentialCiphertextError(ValueError):
    """A provider credential cannot be authenticated for its exact scope."""


@dataclass(frozen=True, slots=True)
class ProviderCredentialCipherContext:
    """Authoritative row projections bound into provider-secret ciphertext.

    ``tenant_id`` and ``scope_key`` are intentionally separate inputs.  They
    are redundant during normal operation, but both are stored SQL columns;
    authenticating both makes a copied ciphertext unusable if either projection
    is changed.  ``from_binding`` is the normal construction path and supplies
    the repository contract's canonical scope.
    """

    provider_id: str
    key_id: str
    tenant_id: str | None
    scope_key: str

    def __post_init__(self) -> None:
        _canonical_identifier(self.provider_id, "provider_id")
        _canonical_identifier(self.key_id, "key_id")
        if self.tenant_id is not None:
            _canonical_identifier(self.tenant_id, "tenant_id")
        _canonical_identifier(self.scope_key, "scope_key")

    @classmethod
    def from_binding(
        cls,
        binding: ProviderCredentialBinding,
    ) -> ProviderCredentialCipherContext:
        if not isinstance(binding, ProviderCredentialBinding):
            raise TypeError("binding must be a ProviderCredentialBinding.")
        return cls(
            provider_id=binding.provider_id,
            key_id=binding.key_id,
            tenant_id=binding.tenant_id,
            scope_key=binding.scope.key,
        )

    def aad(self) -> bytes:
        """Return deterministic, collision-safe JSON for ``SecretVault`` AAD."""

        return json.dumps(
            {
                "key_id": self.key_id,
                "kind": _AAD_KIND,
                "provider_id": self.provider_id,
                "scope_key": self.scope_key,
                "tenant_id": self.tenant_id,
                "version": _AAD_VERSION,
            },
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")


def encrypt_provider_credential_secret(
    vault: SecretVault,
    value: str,
    *,
    context: ProviderCredentialCipherContext,
) -> str:
    """Encrypt a provider secret for one exact provider/key/scope row."""

    _require_vault(vault)
    _require_context(context)
    if not isinstance(value, str) or not value:
        raise ValueError("Provider credential secret must be a non-empty string.")
    return vault.encrypt_scoped(value, aad=context.aad())


def decrypt_provider_credential_secret(
    vault: SecretVault,
    ciphertext: str,
    *,
    context: ProviderCredentialCipherContext,
) -> str:
    """Decrypt only scoped v3 ciphertext under the authoritative row context."""

    _require_vault(vault)
    _require_context(context)
    try:
        return vault.decrypt_scoped(ciphertext, aad=context.aad())
    except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
        raise ProviderCredentialCiphertextError(
            "Provider credential ciphertext failed scoped integrity validation."
        ) from exc


def upgrade_legacy_provider_credential_ciphertext(
    vault: SecretVault,
    ciphertext: str,
    *,
    context: ProviderCredentialCipherContext,
) -> str:
    """Verify scoped ciphertext or upgrade one legacy unscoped token.

    A token claiming the v3 format is never sent through the compatibility
    decryptor.  This prevents an invalid scoped token from being reinterpreted
    as legacy data and silently rebound to a different row.
    """

    _require_vault(vault)
    _require_context(context)
    if not isinstance(ciphertext, str) or not ciphertext:
        raise ProviderCredentialCiphertextError(
            "Provider credential ciphertext must be a non-empty string."
        )
    if ciphertext.startswith(SecretVault.V3_PREFIX):
        decrypt_provider_credential_secret(vault, ciphertext, context=context)
        return ciphertext
    try:
        plaintext = vault.decrypt(ciphertext)
    except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
        raise ProviderCredentialCiphertextError(
            "Legacy provider credential ciphertext failed integrity validation."
        ) from exc
    return encrypt_provider_credential_secret(vault, plaintext, context=context)


def scope_provider_credentials_for_import(
    vault: SecretVault,
    state: ValidatedIdentityConfigState,
) -> ValidatedIdentityConfigState:
    """Return a cutover state whose provider ciphertext is scoped v3.

    The caller must first run ``validate_v4_identity_config_state``.  This
    function deliberately does not accept raw mappings, so relationship and
    exact-ID validation cannot be bypassed during a legacy upgrade.

    ``source_digest`` remains the digest of the validated v4 input.  Only the
    provider ciphertext and relational digest change, which keeps crash resume
    keyed to the stable source document while making the staged receipt prove
    the exact scoped SQL rows.
    """

    _require_vault(vault)
    if not isinstance(state, ValidatedIdentityConfigState):
        raise TypeError("state must be a ValidatedIdentityConfigState.")

    ciphertext_by_id = _unique_provider_ciphertexts(state.encrypted_provider_keys)
    records = state.collections.get("provider_keys")
    if records is None:
        raise ProviderCredentialCiphertextError("Validated provider-key collection is missing.")
    record_ids: set[str] = set()
    scoped_by_id: dict[str, str] = {}
    for record in records:
        if not isinstance(record, ProviderKeyImportRecord):
            raise ProviderCredentialCiphertextError(
                "Validated provider-key collection has an invalid record."
            )
        if record.id in record_ids:
            raise ProviderCredentialCiphertextError(
                "Validated provider-key collection contains duplicate IDs."
            )
        record_ids.add(record.id)
        ciphertext = ciphertext_by_id.get(record.id)
        if ciphertext is None:
            raise ProviderCredentialCiphertextError(
                "Provider-key metadata and ciphertext IDs do not match exactly."
            )
        binding = ProviderCredentialBinding(
            provider_id=record.provider_id,
            key_id=record.id,
            tenant_id=record.tenant_id,
        )
        scoped_by_id[record.id] = upgrade_legacy_provider_credential_ciphertext(
            vault,
            ciphertext,
            context=ProviderCredentialCipherContext.from_binding(binding),
        )

    if record_ids != set(ciphertext_by_id):
        raise ProviderCredentialCiphertextError(
            "Provider-key metadata and ciphertext IDs do not match exactly."
        )
    scoped_pairs = tuple(
        (key_id, scoped_by_id[key_id]) for key_id, _ciphertext in state.encrypted_provider_keys
    )
    relational_digest = _relational_digest(state, scoped_pairs)
    if (
        scoped_pairs == state.encrypted_provider_keys
        and relational_digest == state.relational_digest
    ):
        return state
    return replace(
        state,
        encrypted_provider_keys=scoped_pairs,
        relational_digest=relational_digest,
    )


def resume_scoped_provider_credentials_from_stage(
    vault: SecretVault,
    state: ValidatedIdentityConfigState,
    *,
    staged_receipt: IdentityConfigImportReceipt,
    staged_encrypted_provider_keys: tuple[tuple[str, str], ...],
) -> ValidatedIdentityConfigState:
    """Reconstruct the exact randomized provider transform already in SQL.

    Scoped encryption uses a fresh random nonce, so an unchanged v4 source must
    never be encrypted again after its SQL staging transaction commits.  A
    restart instead reads the inactive staged receipt and ciphertext rows, then
    calls this function.  Every staged token is authenticated under the source
    metadata and the recomputed relational digest must exactly match the staged
    receipt before the state can be reused for vector import/activation.
    """

    _require_vault(vault)
    if not isinstance(state, ValidatedIdentityConfigState):
        raise TypeError("state must be a ValidatedIdentityConfigState.")
    if not isinstance(staged_receipt, IdentityConfigImportReceipt):
        raise TypeError("staged_receipt must be an IdentityConfigImportReceipt.")
    if (
        staged_receipt.source_version != SOURCE_STATE_VERSION
        or staged_receipt.target_version != TARGET_STATE_VERSION
        or staged_receipt.source_digest != state.source_digest
        or staged_receipt.prior_application_state_digest
        != state.prior_import_chain.application_state_digest
        or staged_receipt.prior_chat_state_digest != state.prior_import_chain.chat_state_digest
        or staged_receipt.knowledge_digest != state.knowledge_digest
        or staged_receipt.collection_counts != state.collection_counts
    ):
        raise ProviderCredentialCiphertextError(
            "Staged provider credentials do not match the validated v4 source."
        )

    ciphertext_by_id = _unique_provider_ciphertexts(staged_encrypted_provider_keys)
    records = state.collections.get("provider_keys")
    if records is None:
        raise ProviderCredentialCiphertextError("Validated provider-key collection is missing.")
    record_ids: set[str] = set()
    for record in records:
        if not isinstance(record, ProviderKeyImportRecord) or record.id in record_ids:
            raise ProviderCredentialCiphertextError(
                "Validated provider-key collection has an invalid record."
            )
        record_ids.add(record.id)
        ciphertext = ciphertext_by_id.get(record.id)
        if ciphertext is None or not ciphertext.startswith(SecretVault.V3_PREFIX):
            raise ProviderCredentialCiphertextError(
                "Staged provider credentials are not exact scoped ciphertext."
            )
        binding = ProviderCredentialBinding(
            provider_id=record.provider_id,
            key_id=record.id,
            tenant_id=record.tenant_id,
        )
        decrypt_provider_credential_secret(
            vault,
            ciphertext,
            context=ProviderCredentialCipherContext.from_binding(binding),
        )
    if record_ids != set(ciphertext_by_id):
        raise ProviderCredentialCiphertextError(
            "Staged provider-key metadata and ciphertext IDs do not match exactly."
        )

    relational_digest = _relational_digest(state, staged_encrypted_provider_keys)
    if relational_digest != staged_receipt.relational_digest:
        raise ProviderCredentialCiphertextError(
            "Staged provider credentials do not match their relational receipt."
        )
    return replace(
        state,
        encrypted_provider_keys=staged_encrypted_provider_keys,
        relational_digest=relational_digest,
    )


def resume_equivalent_empty_bootstrap_from_stage(
    vault: SecretVault,
    state: ValidatedIdentityConfigState,
    *,
    staged_receipt: IdentityConfigImportReceipt,
    staged_encrypted_provider_keys: tuple[tuple[str, str], ...],
    staged_configuration_secrets: tuple[tuple[str, str], ...],
) -> ValidatedIdentityConfigState:
    """Adopt the winner of a concurrent randomized empty bootstrap.

    Two constructors can assemble the same seed data while producing different
    nonces for provider and configuration-secret ciphertext. The first staged
    SQL transaction is authoritative. A loser may adopt it only after every
    source secret decrypts to the same plaintext and the winner ciphertext
    recomputes the exact staged relational digest. No normal v4 file import is
    allowed to ignore a source-digest mismatch; callers must restrict this
    helper to canonical empty-predecessor initialization.
    """

    _require_vault(vault)
    if not isinstance(state, ValidatedIdentityConfigState):
        raise TypeError("state must be a ValidatedIdentityConfigState.")
    if not isinstance(staged_receipt, IdentityConfigImportReceipt):
        raise TypeError("staged_receipt must be an IdentityConfigImportReceipt.")

    source_config = _unique_secret_ciphertexts(
        state.configuration_secrets,
        "source configuration secret",
    )
    staged_config = _unique_secret_ciphertexts(
        staged_configuration_secrets,
        "staged configuration secret",
    )
    if set(source_config) != set(staged_config):
        raise ProviderCredentialCiphertextError(
            "Bootstrap configuration-secret IDs do not match exactly."
        )
    for secret_key in sorted(source_config):
        try:
            source_plaintext = vault.decrypt(source_config[secret_key])
            staged_plaintext = vault.decrypt(staged_config[secret_key])
        except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
            raise ProviderCredentialCiphertextError(
                "Bootstrap configuration-secret ciphertext failed integrity validation."
            ) from exc
        if not hmac.compare_digest(source_plaintext, staged_plaintext):
            raise ProviderCredentialCiphertextError(
                "Bootstrap configuration-secret plaintext does not match the staged winner."
            )

    source_provider = _unique_provider_ciphertexts(state.encrypted_provider_keys)
    staged_provider = _unique_provider_ciphertexts(staged_encrypted_provider_keys)
    records = state.collections.get("provider_keys")
    if records is None:
        raise ProviderCredentialCiphertextError("Validated provider-key collection is missing.")
    record_ids: set[str] = set()
    for record in records:
        if not isinstance(record, ProviderKeyImportRecord) or record.id in record_ids:
            raise ProviderCredentialCiphertextError(
                "Validated provider-key collection has an invalid record."
            )
        record_ids.add(record.id)
        source_ciphertext = source_provider.get(record.id)
        staged_ciphertext = staged_provider.get(record.id)
        if source_ciphertext is None or staged_ciphertext is None:
            raise ProviderCredentialCiphertextError(
                "Bootstrap provider-key IDs do not match exactly."
            )
        context = ProviderCredentialCipherContext.from_binding(
            ProviderCredentialBinding(
                provider_id=record.provider_id,
                key_id=record.id,
                tenant_id=record.tenant_id,
            )
        )
        try:
            source_plaintext = (
                decrypt_provider_credential_secret(
                    vault,
                    source_ciphertext,
                    context=context,
                )
                if source_ciphertext.startswith(SecretVault.V3_PREFIX)
                else vault.decrypt(source_ciphertext)
            )
            staged_plaintext = decrypt_provider_credential_secret(
                vault,
                staged_ciphertext,
                context=context,
            )
        except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
            raise ProviderCredentialCiphertextError(
                "Bootstrap provider credential failed integrity validation."
            ) from exc
        if not hmac.compare_digest(source_plaintext, staged_plaintext):
            raise ProviderCredentialCiphertextError(
                "Bootstrap provider credential plaintext does not match the staged winner."
            )
    if record_ids != set(source_provider) or record_ids != set(staged_provider):
        raise ProviderCredentialCiphertextError(
            "Bootstrap provider-key IDs do not match exactly."
        )

    candidate = replace(
        state,
        source_digest=staged_receipt.source_digest,
        configuration_secrets=staged_configuration_secrets,
    )
    return resume_scoped_provider_credentials_from_stage(
        vault,
        candidate,
        staged_receipt=staged_receipt,
        staged_encrypted_provider_keys=staged_encrypted_provider_keys,
    )


def _unique_provider_ciphertexts(
    pairs: tuple[tuple[str, str], ...],
) -> dict[str, str]:
    result: dict[str, str] = {}
    for key_id, ciphertext in pairs:
        if (
            not isinstance(key_id, str)
            or not key_id
            or not isinstance(ciphertext, str)
            or not ciphertext
            or key_id in result
        ):
            raise ProviderCredentialCiphertextError(
                "Validated provider ciphertext entries are invalid or duplicated."
            )
        result[key_id] = ciphertext
    return result


def _unique_secret_ciphertexts(
    pairs: tuple[tuple[str, str], ...],
    label: str,
) -> dict[str, str]:
    result: dict[str, str] = {}
    for secret_key, ciphertext in pairs:
        if (
            not isinstance(secret_key, str)
            or not secret_key
            or not isinstance(ciphertext, str)
            or not ciphertext
            or secret_key in result
        ):
            raise ProviderCredentialCiphertextError(
                f"{label.capitalize()} entries are invalid or duplicated."
            )
        result[secret_key] = ciphertext
    return result


def _relational_digest(
    state: ValidatedIdentityConfigState,
    encrypted_provider_keys: tuple[tuple[str, str], ...],
) -> str:
    payload = {
        key: [record.model_dump(mode="json") for record in state.collections[key]]
        for key in MODEL_COLLECTIONS
    }
    payload.update(
        {
            "platform_settings": state.platform_settings.model_dump(mode="json"),
            "email_settings": state.email_settings.model_dump(mode="json"),
            "password_credentials": dict(state.password_credentials),
            "temporary_password_user_ids": list(state.temporary_password_user_ids),
            "encrypted_provider_keys": dict(encrypted_provider_keys),
            "configuration_secrets": dict(state.configuration_secrets),
        }
    )
    canonical = json.dumps(
        payload,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _canonical_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{label} must be a non-empty canonical string.")
    return value


def _require_vault(vault: SecretVault) -> None:
    if not isinstance(vault, SecretVault):
        raise TypeError("vault must be a SecretVault.")


def _require_context(context: ProviderCredentialCipherContext) -> None:
    if not isinstance(context, ProviderCredentialCipherContext):
        raise TypeError("context must be a ProviderCredentialCipherContext.")


__all__ = [
    "ProviderCredentialCipherContext",
    "ProviderCredentialCiphertextError",
    "decrypt_provider_credential_secret",
    "encrypt_provider_credential_secret",
    "resume_equivalent_empty_bootstrap_from_stage",
    "resume_scoped_provider_credentials_from_stage",
    "scope_provider_credentials_for_import",
    "upgrade_legacy_provider_credential_ciphertext",
]
