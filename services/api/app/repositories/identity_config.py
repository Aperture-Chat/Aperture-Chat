"""Framework-neutral contracts for the A7 identity/config SQL cutover.

This module deliberately contains no SQLAlchemy, engine, or ``SeedStore``
dependency.  It defines the transaction boundaries and pure ownership rules
that the eventual SQL repository must implement:

* one relational import transaction for validated identity/config state;
* one provider-credential transaction for metadata, ciphertext, and its scoped
  binding; and
* exact configuration-secret ownership parsing before import or deletion.

Provider credentials retain a nullable ``tenant_id`` in their public metadata.
The nullable column is not itself the uniqueness mechanism: every credential
binding also has a non-null canonical scope key (``platform`` or
``tenant:<tenant_id>``).  A SQL implementation must enforce one binding per
``(provider_id, scope_key)`` so SQLite and PostgreSQL do not disagree about
NULL uniqueness.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Any, Literal, Protocol, runtime_checkable

from app.db.import_identity_config import (
    IdentityConfigImportReceipt,
    ValidatedIdentityConfigState,
)
from app.db.knowledge_import_state import KnowledgeStateImportReceipt


PLATFORM_PROVIDER_SCOPE_KEY = "platform"
TENANT_PROVIDER_SCOPE_PREFIX = "tenant:"


class IdentityConfigRepositoryError(RuntimeError):
    """Base error for identity/config repository contract violations."""


class ProviderCredentialScopeError(IdentityConfigRepositoryError, ValueError):
    """A provider credential has an invalid platform or tenant scope."""


class AmbiguousProviderCredentialBinding(IdentityConfigRepositoryError):
    """More than one credential is bound to the same provider and scope."""


class ConfigurationSecretKeyError(IdentityConfigRepositoryError, ValueError):
    """A stored configuration-secret key has no single known owner."""


@dataclass(frozen=True, slots=True)
class ProviderCredentialScope:
    """Canonical provider-credential scope with explicit NULL semantics."""

    tenant_id: str | None

    def __post_init__(self) -> None:
        if self.tenant_id is not None:
            try:
                _required_identifier(self.tenant_id, "tenant_id")
            except ValueError as exc:
                raise ProviderCredentialScopeError(
                    "Provider credential tenant scope must be a canonical identifier."
                ) from exc

    @property
    def kind(self) -> Literal["platform", "tenant"]:
        return "platform" if self.tenant_id is None else "tenant"

    @property
    def key(self) -> str:
        if self.tenant_id is None:
            return PLATFORM_PROVIDER_SCOPE_KEY
        return f"{TENANT_PROVIDER_SCOPE_PREFIX}{self.tenant_id}"


def provider_credential_scope(tenant_id: str | None) -> ProviderCredentialScope:
    """Return the canonical scope for a nullable provider-key ``tenant_id``."""

    return ProviderCredentialScope(tenant_id=tenant_id)


def provider_scope_key(tenant_id: str | None) -> str:
    """Return the non-null key used by the scoped-binding unique constraint."""

    return provider_credential_scope(tenant_id).key


@dataclass(frozen=True, slots=True)
class ProviderCredentialBinding:
    """The sole active credential selection for one provider and scope."""

    provider_id: str
    key_id: str
    tenant_id: str | None

    def __post_init__(self) -> None:
        _required_identifier(self.provider_id, "provider_id")
        _required_identifier(self.key_id, "key_id")
        provider_credential_scope(self.tenant_id)

    @property
    def scope(self) -> ProviderCredentialScope:
        return provider_credential_scope(self.tenant_id)


@dataclass(frozen=True, slots=True)
class ProviderCredentialBundle:
    """Metadata, encrypted value, and binding that must commit together.

    ``metadata`` is copied and exposed through a read-only top-level mapping.
    It must include ``id``, ``provider_id``, and ``tenant_id`` so the nullable
    tenant scope is carried in the provider-key record as well as in its
    binding.  Ciphertext remains a separate value and secret-shaped metadata
    fields are rejected.
    """

    metadata: Mapping[str, Any]
    ciphertext: str
    binding: ProviderCredentialBinding

    def __post_init__(self) -> None:
        if not isinstance(self.metadata, Mapping):
            raise TypeError("Provider credential metadata must be a mapping.")
        copied_metadata = deepcopy(dict(self.metadata))
        if any(not isinstance(key, str) or not key for key in copied_metadata):
            raise ValueError("Provider credential metadata keys must be non-empty strings.")
        forbidden_fields = {
            "ciphertext",
            "encrypted_value",
            "secret",
            "secret_value",
        }
        if forbidden_fields.intersection(key.casefold() for key in copied_metadata):
            raise ValueError("Provider credential metadata must not contain secret material.")
        if copied_metadata.get("id") != self.binding.key_id:
            raise ValueError("Provider credential metadata id does not match its binding.")
        if copied_metadata.get("provider_id") != self.binding.provider_id:
            raise ValueError("Provider credential provider does not match its binding.")
        if "tenant_id" not in copied_metadata:
            raise ValueError("Provider credential metadata must include nullable tenant_id.")
        metadata_scope = provider_credential_scope(copied_metadata["tenant_id"])
        if metadata_scope != self.binding.scope:
            raise ValueError("Provider credential tenant scope does not match its binding.")
        if (
            not isinstance(self.ciphertext, str)
            or not self.ciphertext
            or self.ciphertext != self.ciphertext.strip()
        ):
            raise ValueError("Provider credential ciphertext must be a non-empty string.")
        object.__setattr__(self, "metadata", MappingProxyType(copied_metadata))

    @property
    def key_id(self) -> str:
        return self.binding.key_id

    @property
    def provider_id(self) -> str:
        return self.binding.provider_id

    @property
    def tenant_id(self) -> str | None:
        return self.binding.tenant_id


def select_provider_credential_binding(
    *,
    provider_id: str,
    tenant_id: str | None,
    bindings: Iterable[ProviderCredentialBinding],
) -> ProviderCredentialBinding | None:
    """Resolve a credential without ever relying on insertion order.

    A tenant-specific binding wins over the platform binding.  A platform
    caller can only use the platform binding.  Duplicate bindings for any
    scope of the requested provider fail closed before selection, including a
    duplicate fallback that would otherwise be hidden by a tenant match.
    """

    provider_id = _required_identifier(provider_id, "provider_id")
    requested_scope = provider_credential_scope(tenant_id)
    by_scope: dict[str, ProviderCredentialBinding] = {}
    for binding in bindings:
        if not isinstance(binding, ProviderCredentialBinding):
            raise TypeError("Provider credential bindings must use the contract type.")
        if binding.provider_id != provider_id:
            continue
        scope_key = binding.scope.key
        if scope_key in by_scope:
            raise AmbiguousProviderCredentialBinding(
                f"Provider {provider_id!r} has multiple bindings for scope {scope_key!r}."
            )
        by_scope[scope_key] = binding

    if requested_scope.kind == "tenant":
        selected = by_scope.get(requested_scope.key)
        if selected is not None:
            return selected
    return by_scope.get(PLATFORM_PROVIDER_SCOPE_KEY)


class ConfigurationSecretNamespace(StrEnum):
    CONNECTOR = "connector"
    CONNECTOR_OAUTH = "connector-oauth"
    CONNECTOR_USER_OAUTH = "connector-user-oauth"
    CONNECTOR_PASSWORD = "connector-password"
    SSO = "sso"
    KNOWLEDGE = "knowledge"
    KNOWLEDGE_API_SOURCE = "knowledge-api-source"
    KNOWLEDGE_OAUTH_TOKEN = "knowledge-oauth-token"
    TOOL = "tool"
    TOOL_OAUTH_TOKEN = "tool-oauth-token"
    SMTP = "smtp"


class ConfigurationSecretResourceKind(StrEnum):
    CONNECTOR_CONFIG = "connector_config"
    SSO_CONFIG = "sso_config"
    KNOWLEDGE_CONFIG = "knowledge_config"
    TOOL_CONFIG = "tool_config"
    PLATFORM_EMAIL = "platform_email"


@dataclass(frozen=True, slots=True)
class ConfigurationSecretResourceIndex:
    """Known resource IDs used to prove ownership of legacy vault keys."""

    connector_config_ids: frozenset[str] = field(default_factory=frozenset)
    sso_config_ids: frozenset[str] = field(default_factory=frozenset)
    knowledge_config_ids: frozenset[str] = field(default_factory=frozenset)
    tool_config_ids: frozenset[str] = field(default_factory=frozenset)
    user_ids: frozenset[str] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        for field_name in (
            "connector_config_ids",
            "sso_config_ids",
            "knowledge_config_ids",
            "tool_config_ids",
            "user_ids",
        ):
            values = frozenset(getattr(self, field_name))
            for value in values:
                _required_identifier(value, field_name)
            object.__setattr__(self, field_name, values)


@dataclass(frozen=True, slots=True)
class ParsedConfigurationSecretKey:
    """A legacy vault key resolved to one exact owning resource."""

    storage_key: str
    namespace: ConfigurationSecretNamespace
    resource_kind: ConfigurationSecretResourceKind
    resource_id: str
    qualifier: str | None = None
    subject_user_id: str | None = None


_EXACT_SECRET_NAMESPACES: dict[
    ConfigurationSecretNamespace,
    tuple[ConfigurationSecretResourceKind, str],
] = {
    ConfigurationSecretNamespace.CONNECTOR: (
        ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
        "connector_config_ids",
    ),
    ConfigurationSecretNamespace.CONNECTOR_OAUTH: (
        ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
        "connector_config_ids",
    ),
    ConfigurationSecretNamespace.CONNECTOR_PASSWORD: (
        ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
        "connector_config_ids",
    ),
    ConfigurationSecretNamespace.SSO: (
        ConfigurationSecretResourceKind.SSO_CONFIG,
        "sso_config_ids",
    ),
    ConfigurationSecretNamespace.KNOWLEDGE: (
        ConfigurationSecretResourceKind.KNOWLEDGE_CONFIG,
        "knowledge_config_ids",
    ),
    ConfigurationSecretNamespace.KNOWLEDGE_OAUTH_TOKEN: (
        ConfigurationSecretResourceKind.KNOWLEDGE_CONFIG,
        "knowledge_config_ids",
    ),
    ConfigurationSecretNamespace.TOOL: (
        ConfigurationSecretResourceKind.TOOL_CONFIG,
        "tool_config_ids",
    ),
    ConfigurationSecretNamespace.TOOL_OAUTH_TOKEN: (
        ConfigurationSecretResourceKind.TOOL_CONFIG,
        "tool_config_ids",
    ),
}


def parse_configuration_secret_key(
    storage_key: str,
    resources: ConfigurationSecretResourceIndex,
) -> ParsedConfigurationSecretKey:
    """Parse one ``namespace:record_id`` key and prove a single exact owner.

    Composite namespaces are resolved with known resource IDs rather than a
    prefix comparison.  An unknown, orphaned, malformed, or multiply-owned key
    raises instead of being assigned heuristically.
    """

    if not isinstance(resources, ConfigurationSecretResourceIndex):
        raise TypeError("resources must be a ConfigurationSecretResourceIndex.")
    if not isinstance(storage_key, str) or not storage_key:
        raise ConfigurationSecretKeyError("Configuration-secret key must be non-empty.")
    if len(storage_key) > 768:
        raise ConfigurationSecretKeyError(
            "Configuration-secret key exceeds its 768-character SQL bound."
        )
    raw_namespace, separator, record_id = storage_key.partition(":")
    if not separator or not raw_namespace or not record_id:
        raise ConfigurationSecretKeyError("Configuration-secret key has an invalid shape.")
    try:
        namespace = ConfigurationSecretNamespace(raw_namespace)
    except (TypeError, ValueError) as exc:
        raise ConfigurationSecretKeyError(
            f"Configuration-secret namespace {raw_namespace!r} is not recognized."
        ) from exc

    exact_owner = _EXACT_SECRET_NAMESPACES.get(namespace)
    if exact_owner is not None:
        resource_kind, index_attribute = exact_owner
        known_ids = getattr(resources, index_attribute)
        if record_id not in known_ids:
            raise ConfigurationSecretKeyError(
                f"Configuration-secret namespace {namespace.value!r} references an unknown resource."
            )
        return ParsedConfigurationSecretKey(
            storage_key=storage_key,
            namespace=namespace,
            resource_kind=resource_kind,
            resource_id=record_id,
        )

    if namespace is ConfigurationSecretNamespace.CONNECTOR_USER_OAUTH:
        candidates = _connector_user_candidates(record_id, resources)
        resource_id, subject_user_id = _single_composite_owner(namespace, candidates)
        return ParsedConfigurationSecretKey(
            storage_key=storage_key,
            namespace=namespace,
            resource_kind=ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
            resource_id=resource_id,
            subject_user_id=subject_user_id,
        )

    if namespace is ConfigurationSecretNamespace.KNOWLEDGE_API_SOURCE:
        candidates = _knowledge_source_candidates(record_id, resources)
        resource_id, qualifier = _single_composite_owner(namespace, candidates)
        if len(qualifier) > 320:
            raise ConfigurationSecretKeyError(
                "Configuration-secret qualifier exceeds its 320-character SQL bound."
            )
        return ParsedConfigurationSecretKey(
            storage_key=storage_key,
            namespace=namespace,
            resource_kind=ConfigurationSecretResourceKind.KNOWLEDGE_CONFIG,
            resource_id=resource_id,
            qualifier=qualifier,
        )

    if namespace is ConfigurationSecretNamespace.SMTP:
        if record_id != "primary":
            raise ConfigurationSecretKeyError(
                "The SMTP configuration-secret key must reference the primary settings record."
            )
        return ParsedConfigurationSecretKey(
            storage_key=storage_key,
            namespace=namespace,
            resource_kind=ConfigurationSecretResourceKind.PLATFORM_EMAIL,
            resource_id="primary",
        )

    raise ConfigurationSecretKeyError(
        f"Configuration-secret namespace {namespace.value!r} has no ownership rule."
    )


def parse_configuration_secret_keys(
    storage_keys: Iterable[str],
    resources: ConfigurationSecretResourceIndex,
) -> tuple[ParsedConfigurationSecretKey, ...]:
    """Parse a complete key set in deterministic order, failing on any orphan."""

    if not isinstance(resources, ConfigurationSecretResourceIndex):
        raise TypeError("resources must be a ConfigurationSecretResourceIndex.")
    parsed = [parse_configuration_secret_key(key, resources) for key in storage_keys]
    return tuple(sorted(parsed, key=lambda item: item.storage_key))


def configuration_secret_keys_owned_by(
    storage_keys: Iterable[str],
    *,
    resource_kind: ConfigurationSecretResourceKind,
    resource_id: str,
    resources: ConfigurationSecretResourceIndex,
) -> tuple[str, ...]:
    """Return exact keys safe to delete for one resource.

    Every input key is parsed first.  A malformed or orphaned key aborts the
    operation, which lets a repository roll back rather than perform a partial
    prefix-based deletion.
    """

    resource_id = _required_identifier(resource_id, "resource_id")
    try:
        normalized_kind = ConfigurationSecretResourceKind(resource_kind)
    except ValueError as exc:
        raise ConfigurationSecretKeyError("Configuration-secret resource kind is invalid.") from exc
    parsed = parse_configuration_secret_keys(storage_keys, resources)
    return tuple(
        item.storage_key
        for item in parsed
        if item.resource_kind is normalized_kind and item.resource_id == resource_id
    )


def _connector_user_candidates(
    record_id: str,
    resources: ConfigurationSecretResourceIndex,
) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []
    for config_id in resources.connector_config_ids:
        prefix = f"{config_id}:"
        if not record_id.startswith(prefix):
            continue
        user_id = record_id[len(prefix) :]
        if user_id in resources.user_ids:
            candidates.append((config_id, user_id))
    return candidates


def _knowledge_source_candidates(
    record_id: str,
    resources: ConfigurationSecretResourceIndex,
) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []
    for config_id in resources.knowledge_config_ids:
        prefix = f"{config_id}:"
        if not record_id.startswith(prefix):
            continue
        qualifier = record_id[len(prefix) :]
        # Current keys use either "oauth-client" or a UUID-like source token;
        # neither contains a colon.  Rejecting a colon prevents a shorter
        # config ID from claiming a longer config ID's secret by prefix.
        if qualifier and ":" not in qualifier:
            candidates.append((config_id, qualifier))
    return candidates


def _single_composite_owner(
    namespace: ConfigurationSecretNamespace,
    candidates: Sequence[tuple[str, str]],
) -> tuple[str, str]:
    if len(candidates) != 1:
        status = "unknown" if not candidates else "ambiguous"
        raise ConfigurationSecretKeyError(
            f"Configuration-secret namespace {namespace.value!r} has an {status} owner."
        )
    return candidates[0]


def _required_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{label} must be a non-empty canonical string.")
    if len(value) > 255:
        raise ValueError(f"{label} exceeds its 255-character SQL bound.")
    return value


def _required_sha256(value: str, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest.")
    return value


@dataclass(frozen=True, slots=True)
class IdentityConfigImportOutcome:
    """Result of an import transaction or an exact idempotent replay."""

    source_digest: str
    relational_digest: str
    disposition: Literal["imported", "already_applied"]

    def __post_init__(self) -> None:
        _required_sha256(self.source_digest, "source_digest")
        _required_sha256(self.relational_digest, "relational_digest")
        if self.disposition not in {"imported", "already_applied"}:
            raise ValueError("Identity/config import disposition is invalid.")


@runtime_checkable
class IdentityConfigSnapshotView(Protocol):
    """Minimal detached snapshot shape shared by stage resume and live CAS."""

    receipt: IdentityConfigImportReceipt
    encrypted_provider_keys: tuple[tuple[str, str], ...]


@runtime_checkable
class IdentityConfigImportRepository(Protocol):
    """Two-phase relational boundary for the vector-gated v4-to-v5 cutover.

    Import stages every non-vector row and its receipt atomically but never
    writes the authority pointer. A verified matching vector receipt is a
    separate activation boundary. Crash resume reads one atomic, fully checked
    inactive snapshot so randomized credential ciphertext is reused exactly.
    Once active, live full-snapshot writes require a relational-digest CAS;
    stale writers fail without modifying either rows or the immutable receipt.
    """

    def import_validated_identity_config(
        self,
        *,
        state: ValidatedIdentityConfigState,
        receipt: IdentityConfigImportReceipt,
    ) -> IdentityConfigImportOutcome: ...

    def active_identity_config_receipt(self) -> IdentityConfigImportReceipt | None: ...

    def load_staged_snapshot(self) -> IdentityConfigSnapshotView | None: ...

    def activate_identity_config(
        self,
        *,
        source_digest: str,
        vector_receipt: KnowledgeStateImportReceipt,
    ) -> IdentityConfigImportReceipt: ...

    def replace_active_snapshot(
        self,
        *,
        state: ValidatedIdentityConfigState,
        expected_relational_digest: str,
    ) -> IdentityConfigSnapshotView: ...


@runtime_checkable
class ProviderCredentialRepository(Protocol):
    """Atomic provider credential writes and scoped, fail-closed reads."""

    def write_provider_credential(
        self,
        credential: ProviderCredentialBundle,
        *,
        expected_binding_key_id: str | None,
    ) -> ProviderCredentialBundle:
        """Commit metadata, ciphertext, and binding in one transaction.

        The implementation must compare the current scoped binding with
        ``expected_binding_key_id`` (``None`` means no binding is expected),
        enforce one ``(provider_id, scope_key)`` binding, and roll back all
        three records on conflict.
        """
        ...

    def resolve_provider_credential(
        self,
        *,
        provider_id: str,
        tenant_id: str | None,
    ) -> ProviderCredentialBundle | None:
        """Read one transactionally consistent bundle using tenant-first fallback."""
        ...


@runtime_checkable
class IdentityConfigRepository(
    IdentityConfigImportRepository,
    ProviderCredentialRepository,
    Protocol,
):
    """Complete framework-neutral repository surface required by A7/A9."""
