"""Move identity and configuration authority into relational storage.

Revision ID: 20260720_0009
Revises: 20260720_0008
Create Date: 2026-07-20

This migration creates schema only. Runtime startup performs the validated v4
import and writes its receipts; Alembic must never manufacture evidence that a
cross-store import completed.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0009"
down_revision: str | None = "20260720_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _ordered_payload_table(
    name: str,
    *columns: sa.Column[object],
    constraints: Sequence[sa.Constraint] = (),
) -> None:
    op.create_table(
        name,
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        *columns,
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.CheckConstraint(
            "ordinal >= 0",
            name=op.f(f"ck_{name}_ordinal_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{name}")),
        sa.UniqueConstraint("ordinal", name=op.f(f"uq_{name}_ordinal")),
        *constraints,
    )


def upgrade() -> None:
    _ordered_payload_table(
        "tenants",
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column("custom_domain", sa.String(length=253), nullable=True),
        constraints=(
            sa.UniqueConstraint("slug", name=op.f("uq_tenants_slug")),
            sa.UniqueConstraint(
                "custom_domain",
                name=op.f("uq_tenants_custom_domain"),
            ),
        ),
    )

    _ordered_payload_table(
        "identity_users",
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("email_normalized", sa.String(length=320), nullable=False),
        sa.Column("role", sa.String(length=100), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_identity_users_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint(
                "email_normalized",
                name=op.f("uq_identity_users_email_normalized"),
            ),
        ),
    )
    op.create_index(
        "ix_identity_users_tenant_active",
        "identity_users",
        ["tenant_id", "active"],
        unique=False,
    )
    op.create_index(
        "ix_identity_users_tenant_role",
        "identity_users",
        ["tenant_id", "role"],
        unique=False,
    )

    _ordered_payload_table(
        "identity_groups",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("default_group", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_identity_groups_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_identity_groups_tenant_default",
        "identity_groups",
        ["tenant_id", "default_group"],
        unique=False,
    )

    _ordered_payload_table(
        "providers",
        sa.Column("kind", sa.String(length=100), nullable=False),
        sa.Column("connected", sa.Boolean(), nullable=False),
    )
    op.create_index(
        "ix_providers_kind_connected",
        "providers",
        ["kind", "connected"],
        unique=False,
    )

    _ordered_payload_table(
        "model_configs",
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("provider_id", sa.String(length=255), nullable=False),
        sa.Column("platform_enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_model_configs_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["provider_id"],
                ["providers.id"],
                name=op.f("fk_model_configs_provider_id_providers"),
                ondelete="RESTRICT",
            ),
        ),
    )
    op.create_index(
        "ix_model_configs_provider_enabled",
        "model_configs",
        ["provider_id", "platform_enabled"],
        unique=False,
    )
    op.create_index(
        "ix_model_configs_tenant_enabled",
        "model_configs",
        ["tenant_id", "platform_enabled"],
        unique=False,
    )

    _ordered_payload_table(
        "provider_keys",
        sa.Column("provider_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("credential_scope", sa.String(length=320), nullable=False),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        constraints=(
            sa.CheckConstraint(
                "(tenant_id IS NULL AND credential_scope = 'platform') OR "
                "(tenant_id IS NOT NULL AND credential_scope = 'tenant:' || tenant_id)",
                name=op.f("ck_provider_keys_scope_matches_tenant"),
            ),
            sa.ForeignKeyConstraint(
                ["provider_id"],
                ["providers.id"],
                name=op.f("fk_provider_keys_provider_id_providers"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_provider_keys_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint(
                "id",
                "provider_id",
                "credential_scope",
                name=op.f("uq_provider_keys_id_provider_scope"),
            ),
        ),
    )
    op.create_index(
        "ix_provider_keys_provider_scope",
        "provider_keys",
        ["provider_id", "credential_scope"],
        unique=False,
    )

    op.create_table(
        "provider_credential_bindings",
        sa.Column("provider_id", sa.String(length=255), nullable=False),
        sa.Column("scope_key", sa.String(length=320), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("provider_key_id", sa.String(length=255), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "(tenant_id IS NULL AND scope_key = 'platform') OR "
            "(tenant_id IS NOT NULL AND scope_key = 'tenant:' || tenant_id)",
            name=op.f("ck_provider_credential_bindings_scope_matches_tenant"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_provider_credential_bindings_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["provider_key_id", "provider_id", "scope_key"],
            ["provider_keys.id", "provider_keys.provider_id", "provider_keys.credential_scope"],
            name="fk_provider_credential_bindings_key_provider_scope",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "provider_id",
            "scope_key",
            name=op.f("pk_provider_credential_bindings"),
        ),
        sa.UniqueConstraint(
            "provider_key_id",
            name=op.f("uq_provider_credential_bindings_provider_key_id"),
        ),
    )
    op.create_index(
        "ix_provider_credential_bindings_tenant_provider",
        "provider_credential_bindings",
        ["tenant_id", "provider_id"],
        unique=False,
    )

    _ordered_payload_table(
        "connectors",
        sa.Column("platform_enabled", sa.Boolean(), nullable=False),
        sa.Column("tenant_enabled", sa.Boolean(), nullable=False),
    )
    op.create_index(
        "ix_connectors_platform_tenant_enabled",
        "connectors",
        ["platform_enabled", "tenant_enabled"],
        unique=False,
    )

    _ordered_payload_table(
        "connector_configs",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("connector_id", sa.String(length=255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_connector_configs_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["connector_id"],
                ["connectors.id"],
                name=op.f("fk_connector_configs_connector_id_connectors"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_connector_configs_tenant_connector",
        "connector_configs",
        ["tenant_id", "connector_id"],
        unique=False,
    )

    _ordered_payload_table(
        "sso_configs",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_sso_configs_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_sso_configs_tenant_enabled",
        "sso_configs",
        ["tenant_id", "enabled"],
        unique=False,
    )

    _ordered_payload_table(
        "knowledge_configs",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("connector_config_id", sa.String(length=255), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_knowledge_configs_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["connector_config_id"],
                ["connector_configs.id"],
                name=op.f("fk_knowledge_configs_connector_config_id_connector_configs"),
                ondelete="SET NULL",
            ),
        ),
    )
    op.create_index(
        "ix_knowledge_configs_tenant_enabled",
        "knowledge_configs",
        ["tenant_id", "enabled"],
        unique=False,
    )

    for table_name in ("tool_configs", "prompt_templates", "skill_files"):
        _ordered_payload_table(
            table_name,
            sa.Column("tenant_id", sa.String(length=255), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            constraints=(
                sa.ForeignKeyConstraint(
                    ["tenant_id"],
                    ["tenants.id"],
                    name=op.f(f"fk_{table_name}_tenant_id_tenants"),
                    ondelete="CASCADE",
                ),
            ),
        )
        op.create_index(
            f"ix_{table_name}_tenant_enabled",
            table_name,
            ["tenant_id", "enabled"],
            unique=False,
        )

    _ordered_payload_table(
        "security_alerts",
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("acknowledged", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_security_alerts_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_security_alerts_tenant_acknowledged",
        "security_alerts",
        ["tenant_id", "acknowledged"],
        unique=False,
    )

    _ordered_payload_table(
        "agent_runs",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=100), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_agent_runs_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_agent_runs_tenant_status",
        "agent_runs",
        ["tenant_id", "status"],
        unique=False,
    )

    _ordered_payload_table(
        "automations",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_automations_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_automations_tenant_enabled",
        "automations",
        ["tenant_id", "enabled"],
        unique=False,
    )

    _ordered_payload_table(
        "companion_memories",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("profile_id", sa.String(length=255), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_companion_memories_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["profile_id"],
                ["model_configs.id"],
                name=op.f("fk_companion_memories_profile_id_model_configs"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_companion_memories_tenant_profile",
        "companion_memories",
        ["tenant_id", "profile_id"],
        unique=False,
    )

    _ordered_payload_table(
        "content_filters",
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("builtin", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_content_filters_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_content_filters_tenant_builtin",
        "content_filters",
        ["tenant_id", "builtin"],
        unique=False,
    )

    _ordered_payload_table(
        "scim_tokens",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("revoked_at", sa.Text(), nullable=True),
        constraints=(
            sa.CheckConstraint(
                "length(token_hash) = 64",
                name=op.f("ck_scim_tokens_token_hash_sha256_length"),
            ),
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_scim_tokens_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint(
                "token_hash",
                name=op.f("uq_scim_tokens_token_hash"),
            ),
        ),
    )
    op.create_index(
        "ix_scim_tokens_tenant_revoked",
        "scim_tokens",
        ["tenant_id", "revoked_at"],
        unique=False,
    )

    _ordered_payload_table(
        "alert_rule_configs",
        sa.Column("scope", sa.String(length=20), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.CheckConstraint(
                "scope IN ('platform', 'tenant')",
                name=op.f("ck_alert_rule_configs_scope_valid"),
            ),
            sa.CheckConstraint(
                "(scope = 'platform' AND tenant_id IS NULL) OR "
                "(scope = 'tenant' AND tenant_id IS NOT NULL)",
                name=op.f("ck_alert_rule_configs_scope_matches_tenant"),
            ),
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_alert_rule_configs_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_alert_rule_configs_tenant_enabled",
        "alert_rule_configs",
        ["tenant_id", "enabled"],
        unique=False,
    )

    op.create_table(
        "platform_settings",
        sa.Column("singleton_id", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.CheckConstraint(
            "singleton_id = 1",
            name=op.f("ck_platform_settings_singleton_id_one"),
        ),
        sa.PrimaryKeyConstraint("singleton_id", name=op.f("pk_platform_settings")),
    )
    op.create_table(
        "email_settings",
        sa.Column("singleton_id", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.CheckConstraint(
            "singleton_id = 1",
            name=op.f("ck_email_settings_singleton_id_one"),
        ),
        sa.PrimaryKeyConstraint("singleton_id", name=op.f("pk_email_settings")),
    )

    op.create_table(
        "password_credentials",
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("temporary", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["identity_users.id"],
            name=op.f("fk_password_credentials_user_id_identity_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_password_credentials")),
    )
    op.create_index(
        "ix_password_credentials_temporary",
        "password_credentials",
        ["temporary"],
        unique=False,
    )

    op.create_table(
        "configuration_secrets",
        sa.Column("secret_key", sa.String(length=768), nullable=False),
        sa.Column("namespace", sa.String(length=100), nullable=False),
        sa.Column("resource_id", sa.String(length=255), nullable=False),
        sa.Column("qualifier", sa.String(length=320), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "length(namespace) >= 1",
            name=op.f("ck_configuration_secrets_namespace_nonempty"),
        ),
        sa.CheckConstraint(
            "length(resource_id) >= 1",
            name=op.f("ck_configuration_secrets_resource_id_nonempty"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_configuration_secrets_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("secret_key", name=op.f("pk_configuration_secrets")),
        sa.UniqueConstraint(
            "namespace",
            "resource_id",
            "qualifier",
            name=op.f("uq_configuration_secrets_owner"),
        ),
    )
    op.create_index(
        "ix_configuration_secrets_tenant_namespace",
        "configuration_secrets",
        ["tenant_id", "namespace"],
        unique=False,
    )

    op.create_table(
        "identity_config_imports",
        sa.Column("source_digest", sa.String(length=64), nullable=False),
        sa.Column("source_version", sa.Integer(), nullable=False),
        sa.Column("target_version", sa.Integer(), nullable=False),
        sa.Column("schema_revision", sa.String(length=32), nullable=False),
        sa.Column("prior_application_state_digest", sa.String(length=64), nullable=False),
        sa.Column("prior_chat_state_digest", sa.String(length=64), nullable=False),
        sa.Column("relational_digest", sa.String(length=64), nullable=False),
        sa.Column("knowledge_digest", sa.String(length=64), nullable=False),
        sa.Column("collection_counts", sa.JSON(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(source_digest) = 64",
            name=op.f("ck_identity_config_imports_source_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "source_version = 4",
            name=op.f("ck_identity_config_imports_source_version_v4"),
        ),
        sa.CheckConstraint(
            "target_version = 5",
            name=op.f("ck_identity_config_imports_target_version_v5"),
        ),
        sa.CheckConstraint(
            "schema_revision = '20260720_0009'",
            name=op.f("ck_identity_config_imports_schema_revision_0009"),
        ),
        sa.CheckConstraint(
            "length(prior_application_state_digest) = 64",
            name=op.f("ck_identity_config_imports_prior_application_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(prior_chat_state_digest) = 64",
            name=op.f("ck_identity_config_imports_prior_chat_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(relational_digest) = 64",
            name=op.f("ck_identity_config_imports_relational_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(knowledge_digest) = 64",
            name=op.f("ck_identity_config_imports_knowledge_digest_sha256_length"),
        ),
        sa.PrimaryKeyConstraint(
            "source_digest",
            name=op.f("pk_identity_config_imports"),
        ),
    )

    op.create_table(
        "identity_config_active_import",
        sa.Column("singleton_id", sa.Integer(), nullable=False),
        sa.Column("source_digest", sa.String(length=64), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "singleton_id = 1",
            name=op.f("ck_identity_config_active_import_singleton_id_one"),
        ),
        sa.ForeignKeyConstraint(
            ["source_digest"],
            ["identity_config_imports.source_digest"],
            name=op.f("fk_identity_config_active_import_source_digest_identity_config_imports"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "singleton_id",
            name=op.f("pk_identity_config_active_import"),
        ),
        sa.UniqueConstraint(
            "source_digest",
            name=op.f("uq_identity_config_active_import_source_digest"),
        ),
    )


def downgrade() -> None:
    op.drop_table("identity_config_active_import")
    op.drop_table("identity_config_imports")
    op.drop_index(
        "ix_configuration_secrets_tenant_namespace",
        table_name="configuration_secrets",
    )
    op.drop_table("configuration_secrets")
    op.drop_index(
        "ix_password_credentials_temporary",
        table_name="password_credentials",
    )
    op.drop_table("password_credentials")
    op.drop_table("email_settings")
    op.drop_table("platform_settings")
    op.drop_index(
        "ix_alert_rule_configs_tenant_enabled",
        table_name="alert_rule_configs",
    )
    op.drop_table("alert_rule_configs")
    op.drop_index("ix_scim_tokens_tenant_revoked", table_name="scim_tokens")
    op.drop_table("scim_tokens")
    op.drop_index(
        "ix_content_filters_tenant_builtin",
        table_name="content_filters",
    )
    op.drop_table("content_filters")
    op.drop_index(
        "ix_companion_memories_tenant_profile",
        table_name="companion_memories",
    )
    op.drop_table("companion_memories")
    op.drop_index("ix_automations_tenant_enabled", table_name="automations")
    op.drop_table("automations")
    op.drop_index("ix_agent_runs_tenant_status", table_name="agent_runs")
    op.drop_table("agent_runs")
    op.drop_index(
        "ix_security_alerts_tenant_acknowledged",
        table_name="security_alerts",
    )
    op.drop_table("security_alerts")
    for table_name in ("skill_files", "prompt_templates", "tool_configs"):
        op.drop_index(f"ix_{table_name}_tenant_enabled", table_name=table_name)
        op.drop_table(table_name)
    op.drop_index(
        "ix_knowledge_configs_tenant_enabled",
        table_name="knowledge_configs",
    )
    op.drop_table("knowledge_configs")
    op.drop_index("ix_sso_configs_tenant_enabled", table_name="sso_configs")
    op.drop_table("sso_configs")
    op.drop_index(
        "ix_connector_configs_tenant_connector",
        table_name="connector_configs",
    )
    op.drop_table("connector_configs")
    op.drop_index(
        "ix_connectors_platform_tenant_enabled",
        table_name="connectors",
    )
    op.drop_table("connectors")
    op.drop_index(
        "ix_provider_credential_bindings_tenant_provider",
        table_name="provider_credential_bindings",
    )
    op.drop_table("provider_credential_bindings")
    op.drop_index("ix_provider_keys_provider_scope", table_name="provider_keys")
    op.drop_table("provider_keys")
    op.drop_index("ix_model_configs_tenant_enabled", table_name="model_configs")
    op.drop_index("ix_model_configs_provider_enabled", table_name="model_configs")
    op.drop_table("model_configs")
    op.drop_index("ix_providers_kind_connected", table_name="providers")
    op.drop_table("providers")
    op.drop_index(
        "ix_identity_groups_tenant_default",
        table_name="identity_groups",
    )
    op.drop_table("identity_groups")
    op.drop_index("ix_identity_users_tenant_role", table_name="identity_users")
    op.drop_index("ix_identity_users_tenant_active", table_name="identity_users")
    op.drop_table("identity_users")
    op.drop_table("tenants")
