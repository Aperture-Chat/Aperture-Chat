from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from app.repositories.identity_config import (
    AmbiguousProviderCredentialBinding,
    ConfigurationSecretKeyError,
    ConfigurationSecretNamespace,
    ConfigurationSecretResourceIndex,
    ConfigurationSecretResourceKind,
    ProviderCredentialBinding,
    ProviderCredentialBundle,
    ProviderCredentialScopeError,
    configuration_secret_keys_owned_by,
    parse_configuration_secret_key,
    parse_configuration_secret_keys,
    provider_credential_scope,
    provider_scope_key,
    select_provider_credential_binding,
)


def _binding(
    key_id: str,
    *,
    provider_id: str = "provider-openrouter",
    tenant_id: str | None = None,
) -> ProviderCredentialBinding:
    return ProviderCredentialBinding(
        provider_id=provider_id,
        key_id=key_id,
        tenant_id=tenant_id,
    )


def _resources() -> ConfigurationSecretResourceIndex:
    return ConfigurationSecretResourceIndex(
        connector_config_ids={"conn", "conn-child", "conn:colon"},
        sso_config_ids={"sso-main"},
        knowledge_config_ids={"kb", "kb:colon"},
        tool_config_ids={"tool-main"},
        user_ids={"user-a", "user:colon"},
    )


def test_provider_scope_preserves_nullable_platform_semantics() -> None:
    platform = provider_credential_scope(None)
    tenant = provider_credential_scope("tenant-a")

    assert platform.kind == "platform"
    assert platform.key == "platform"
    assert tenant.kind == "tenant"
    assert tenant.key == "tenant:tenant-a"
    assert provider_scope_key(None) == "platform"
    assert provider_scope_key("tenant-a") == "tenant:tenant-a"

    with pytest.raises((ProviderCredentialScopeError, ValueError)):
        provider_credential_scope("")
    with pytest.raises((ProviderCredentialScopeError, ValueError)):
        provider_credential_scope(" tenant-a")


def test_provider_binding_prefers_tenant_then_platform_independent_of_order() -> None:
    platform = _binding("key-platform")
    tenant_a = _binding("key-tenant-a", tenant_id="tenant-a")
    tenant_b = _binding("key-tenant-b", tenant_id="tenant-b")

    first_order = [platform, tenant_b, tenant_a]
    reverse_order = list(reversed(first_order))

    assert (
        select_provider_credential_binding(
            provider_id="provider-openrouter",
            tenant_id="tenant-a",
            bindings=first_order,
        )
        == tenant_a
    )
    assert (
        select_provider_credential_binding(
            provider_id="provider-openrouter",
            tenant_id="tenant-a",
            bindings=reverse_order,
        )
        == tenant_a
    )
    assert (
        select_provider_credential_binding(
            provider_id="provider-openrouter",
            tenant_id="tenant-missing",
            bindings=first_order,
        )
        == platform
    )
    assert (
        select_provider_credential_binding(
            provider_id="provider-openrouter",
            tenant_id=None,
            bindings=first_order,
        )
        == platform
    )


def test_provider_binding_ambiguity_fails_before_tenant_selection() -> None:
    bindings = [
        _binding("key-platform-a"),
        _binding("key-tenant", tenant_id="tenant-a"),
        _binding("key-platform-b"),
    ]

    with pytest.raises(AmbiguousProviderCredentialBinding):
        select_provider_credential_binding(
            provider_id="provider-openrouter",
            tenant_id="tenant-a",
            bindings=bindings,
        )


def test_provider_binding_isolated_by_provider_and_returns_none_without_fallback() -> None:
    other_provider = _binding("key-other", provider_id="provider-other")

    assert (
        select_provider_credential_binding(
            provider_id="provider-openrouter",
            tenant_id="tenant-a",
            bindings=[other_provider],
        )
        is None
    )


def test_provider_credential_bundle_binds_metadata_ciphertext_and_scope() -> None:
    metadata = {
        "id": "key-tenant",
        "provider_id": "provider-openrouter",
        "tenant_id": "tenant-a",
        "name": "Tenant key",
        "masked_value": "masked",
    }
    bundle = ProviderCredentialBundle(
        metadata=metadata,
        ciphertext="v2.encrypted-value",
        binding=_binding("key-tenant", tenant_id="tenant-a"),
    )

    metadata["name"] = "mutated after construction"
    assert bundle.metadata["name"] == "Tenant key"
    with pytest.raises(TypeError):
        bundle.metadata["name"] = "cannot mutate"  # type: ignore[index]
    with pytest.raises(FrozenInstanceError):
        bundle.ciphertext = "replacement"  # type: ignore[misc]


@pytest.mark.parametrize(
    ("metadata", "binding"),
    [
        (
            {"id": "wrong", "provider_id": "provider-openrouter", "tenant_id": None},
            _binding("key-platform"),
        ),
        (
            {"id": "key-platform", "provider_id": "wrong", "tenant_id": None},
            _binding("key-platform"),
        ),
        (
            {
                "id": "key-platform",
                "provider_id": "provider-openrouter",
                "tenant_id": "tenant-a",
            },
            _binding("key-platform"),
        ),
        (
            {"id": "key-platform", "provider_id": "provider-openrouter"},
            _binding("key-platform"),
        ),
    ],
)
def test_provider_credential_bundle_rejects_misaligned_metadata(
    metadata: dict[str, object],
    binding: ProviderCredentialBinding,
) -> None:
    with pytest.raises(ValueError):
        ProviderCredentialBundle(
            metadata=metadata,
            ciphertext="v2.encrypted-value",
            binding=binding,
        )


def test_provider_credential_bundle_keeps_secret_material_out_of_metadata() -> None:
    with pytest.raises(ValueError, match="secret material"):
        ProviderCredentialBundle(
            metadata={
                "id": "key-platform",
                "provider_id": "provider-openrouter",
                "tenant_id": None,
                "secret_value": "must-not-be-here",
            },
            ciphertext="v2.encrypted-value",
            binding=_binding("key-platform"),
        )


@pytest.mark.parametrize(
    ("storage_key", "namespace", "resource_kind", "resource_id"),
    [
        (
            "connector:conn",
            ConfigurationSecretNamespace.CONNECTOR,
            ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
            "conn",
        ),
        (
            "connector-oauth:conn-child",
            ConfigurationSecretNamespace.CONNECTOR_OAUTH,
            ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
            "conn-child",
        ),
        (
            "connector-password:conn:colon",
            ConfigurationSecretNamespace.CONNECTOR_PASSWORD,
            ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
            "conn:colon",
        ),
        (
            "sso:sso-main",
            ConfigurationSecretNamespace.SSO,
            ConfigurationSecretResourceKind.SSO_CONFIG,
            "sso-main",
        ),
        (
            "knowledge:kb",
            ConfigurationSecretNamespace.KNOWLEDGE,
            ConfigurationSecretResourceKind.KNOWLEDGE_CONFIG,
            "kb",
        ),
        (
            "knowledge-oauth-token:kb:colon",
            ConfigurationSecretNamespace.KNOWLEDGE_OAUTH_TOKEN,
            ConfigurationSecretResourceKind.KNOWLEDGE_CONFIG,
            "kb:colon",
        ),
        (
            "tool:tool-main",
            ConfigurationSecretNamespace.TOOL,
            ConfigurationSecretResourceKind.TOOL_CONFIG,
            "tool-main",
        ),
        (
            "tool-oauth-token:tool-main",
            ConfigurationSecretNamespace.TOOL_OAUTH_TOKEN,
            ConfigurationSecretResourceKind.TOOL_CONFIG,
            "tool-main",
        ),
        (
            "smtp:primary",
            ConfigurationSecretNamespace.SMTP,
            ConfigurationSecretResourceKind.PLATFORM_EMAIL,
            "primary",
        ),
    ],
)
def test_configuration_secret_parser_resolves_exact_known_resources(
    storage_key: str,
    namespace: ConfigurationSecretNamespace,
    resource_kind: ConfigurationSecretResourceKind,
    resource_id: str,
) -> None:
    parsed = parse_configuration_secret_key(storage_key, _resources())

    assert parsed.namespace is namespace
    assert parsed.resource_kind is resource_kind
    assert parsed.resource_id == resource_id


def test_configuration_secret_parser_resolves_composite_owners_exactly() -> None:
    connector = parse_configuration_secret_key(
        "connector-user-oauth:conn:colon:user:colon",
        _resources(),
    )
    knowledge = parse_configuration_secret_key(
        "knowledge-api-source:kb:colon:oauth-client",
        _resources(),
    )

    assert connector.resource_id == "conn:colon"
    assert connector.subject_user_id == "user:colon"
    assert knowledge.resource_id == "kb:colon"
    assert knowledge.qualifier == "oauth-client"


@pytest.mark.parametrize(
    "storage_key",
    [
        "unknown:key",
        "connector:missing",
        "connector-user-oauth:conn:missing-user",
        "knowledge-api-source:missing:oauth-client",
        "smtp:secondary",
        "missing-separator",
    ],
)
def test_configuration_secret_parser_fails_closed_for_unknown_or_orphaned_keys(
    storage_key: str,
) -> None:
    with pytest.raises(ConfigurationSecretKeyError):
        parse_configuration_secret_key(storage_key, _resources())


def test_configuration_secret_parser_fails_closed_for_ambiguous_composite_owner() -> None:
    resources = ConfigurationSecretResourceIndex(
        connector_config_ids={"conn", "conn:user"},
        user_ids={"user:target", "target"},
    )

    with pytest.raises(ConfigurationSecretKeyError, match="ambiguous"):
        parse_configuration_secret_key(
            "connector-user-oauth:conn:user:target",
            resources,
        )


def test_owned_secret_keys_use_parsed_identity_not_prefix_matching() -> None:
    resources = ConfigurationSecretResourceIndex(
        connector_config_ids={"conn", "conn-child"},
        user_ids={"user-a"},
    )
    storage_keys = {
        "connector:conn",
        "connector-oauth:conn",
        "connector-user-oauth:conn:user-a",
        "connector-password:conn",
        "connector:conn-child",
        "connector-user-oauth:conn-child:user-a",
    }

    owned = configuration_secret_keys_owned_by(
        storage_keys,
        resource_kind=ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
        resource_id="conn",
        resources=resources,
    )

    assert owned == (
        "connector-oauth:conn",
        "connector-password:conn",
        "connector-user-oauth:conn:user-a",
        "connector:conn",
    )


def test_batch_parser_is_deterministic_and_aborts_on_any_orphan() -> None:
    resources = _resources()
    parsed = parse_configuration_secret_keys(
        ["tool:tool-main", "connector:conn"],
        resources,
    )
    assert [item.storage_key for item in parsed] == ["connector:conn", "tool:tool-main"]

    with pytest.raises(ConfigurationSecretKeyError):
        parse_configuration_secret_keys(
            ["connector:conn", "connector:orphan"],
            resources,
        )
