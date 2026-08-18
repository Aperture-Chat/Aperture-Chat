from __future__ import annotations

from io import StringIO
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.db.engine import (
    HEAD_REVISION,
    alembic_config,
    create_application_engine,
    current_schema_revision,
    upgrade_database,
)
from app.db.orm import Base


A7_TABLES = {
    "tenants",
    "identity_users",
    "identity_groups",
    "providers",
    "model_configs",
    "provider_keys",
    "provider_credential_bindings",
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
    "alert_rule_configs",
    "platform_settings",
    "email_settings",
    "password_credentials",
    "configuration_secrets",
    "identity_config_imports",
    "identity_config_active_import",
}


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _downgrade(engine: object, revision: str) -> None:
    config = alembic_config()
    with engine.begin() as connection:  # type: ignore[union-attr]
        config.attributes["connection"] = connection
        command.downgrade(config, revision)


def _render_migration(
    monkeypatch: pytest.MonkeyPatch,
    *,
    database_url: str,
    direction: str,
) -> str:
    output = StringIO()
    monkeypatch.setenv("APERTURE_DATABASE_URL", database_url)
    get_settings.cache_clear()
    config = alembic_config()
    config.output_buffer = output
    try:
        if direction == "upgrade":
            command.upgrade(config, "20260720_0008:20260720_0009", sql=True)
        else:
            command.downgrade(config, "20260720_0009:20260720_0008", sql=True)
    finally:
        get_settings.cache_clear()
    return output.getvalue()


def test_a7_fresh_upgrade_has_authority_tables_and_no_fabricated_receipt(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a7-fresh.sqlite3"))
    try:
        upgrade_database(engine)
        inspector = inspect(engine)

        assert current_schema_revision(engine) == HEAD_REVISION == "20260817_0017"
        assert A7_TABLES <= set(inspector.get_table_names())
        assert {column["name"] for column in inspector.get_columns("provider_keys")} == {
            "id",
            "ordinal",
            "provider_id",
            "tenant_id",
            "credential_scope",
            "ciphertext",
            "payload",
        }
        assert {column["name"] for column in inspector.get_columns("configuration_secrets")} == {
            "secret_key",
            "namespace",
            "resource_id",
            "qualifier",
            "tenant_id",
            "ciphertext",
        }
        assert {index["name"] for index in inspector.get_indexes("provider_keys")} >= {
            "ix_provider_keys_provider_scope"
        }

        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT count(*) FROM identity_config_imports")
                ).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text("SELECT count(*) FROM identity_config_active_import")
                ).scalar_one()
                == 0
            )
            context = MigrationContext.configure(connection)
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()


def test_a9_provider_binding_enforces_exact_nullable_tenant_scope(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a9-scope.sqlite3"))
    try:
        upgrade_database(engine)
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO tenants (id, ordinal, slug, custom_domain, payload) "
                    "VALUES ('tenant-a', 0, 'tenant-a', NULL, '{}')"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO providers (id, ordinal, kind, connected, payload) "
                    "VALUES ('provider-a', 0, 'test', true, '{}')"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO provider_keys ("
                    "id, ordinal, provider_id, tenant_id, credential_scope, ciphertext, payload"
                    ") VALUES ("
                    "'key-platform', 0, 'provider-a', NULL, 'platform', 'ciphertext-a', '{}')"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO provider_credential_bindings ("
                    "provider_id, scope_key, tenant_id, provider_key_id, updated_at"
                    ") VALUES ("
                    "'provider-a', 'platform', NULL, 'key-platform', "
                    "'2026-07-20T00:00:00+00:00')"
                )
            )

        with pytest.raises(IntegrityError):
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "INSERT INTO provider_keys ("
                        "id, ordinal, provider_id, tenant_id, credential_scope, "
                        "ciphertext, payload"
                        ") VALUES ("
                        "'key-bad-scope', 1, 'provider-a', 'tenant-a', 'platform', "
                        "'ciphertext-b', '{}')"
                    )
                )

        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO provider_keys ("
                    "id, ordinal, provider_id, tenant_id, credential_scope, ciphertext, payload"
                    ") VALUES ("
                    "'key-tenant', 1, 'provider-a', 'tenant-a', 'tenant:tenant-a', "
                    "'ciphertext-c', '{}')"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO provider_credential_bindings ("
                    "provider_id, scope_key, tenant_id, provider_key_id, updated_at"
                    ") VALUES ("
                    "'provider-a', 'tenant:tenant-a', 'tenant-a', 'key-tenant', "
                    "'2026-07-20T00:00:00+00:00')"
                )
            )

        with pytest.raises(IntegrityError):
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "INSERT INTO provider_credential_bindings ("
                        "provider_id, scope_key, tenant_id, provider_key_id, updated_at"
                        ") VALUES ("
                        "'provider-a', 'tenant:other', 'tenant-a', 'key-platform', "
                        "'2026-07-20T00:00:00+00:00')"
                    )
                )
    finally:
        engine.dispose()


def test_a7_down_up_keeps_prior_schema_rows_and_never_creates_receipts(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a7-linear.sqlite3"))
    try:
        upgrade_database(engine, "20260720_0008")
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO matters ("
                    "id, tenant_id, name, retention_days, created_by_user_id, version, "
                    "created_at, updated_at"
                    ") VALUES ("
                    "'matter-before-a7', 'tenant-a', 'Before A7', NULL, 'user-a', 1, "
                    "'2026-07-20T00:00:00+00:00', '2026-07-20T00:00:00+00:00')"
                )
            )

        upgrade_database(engine)
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT name FROM matters WHERE id = 'matter-before-a7'")
                ).scalar_one()
                == "Before A7"
            )
            assert (
                connection.execute(
                    text("SELECT count(*) FROM identity_config_imports")
                ).scalar_one()
                == 0
            )

        _downgrade(engine, "20260720_0008")
        assert A7_TABLES.isdisjoint(inspect(engine).get_table_names())
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT name FROM matters WHERE id = 'matter-before-a7'")
                ).scalar_one()
                == "Before A7"
            )

        upgrade_database(engine)
        assert current_schema_revision(engine) == "20260817_0017"
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT count(*) FROM identity_config_imports")
                ).scalar_one()
                == 0
            )
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "database_url",
    ["sqlite:///offline-a7.sqlite3", "postgresql+psycopg://u:p@db/aperture"],
)
def test_a7_offline_upgrade_and_downgrade_render_for_supported_databases(
    monkeypatch: pytest.MonkeyPatch,
    database_url: str,
) -> None:
    upgrade_sql = _render_migration(
        monkeypatch,
        database_url=database_url,
        direction="upgrade",
    )
    downgrade_sql = _render_migration(
        monkeypatch,
        database_url=database_url,
        direction="downgrade",
    )

    assert "20260720_0009" in upgrade_sql
    assert "CREATE TABLE provider_keys" in upgrade_sql
    assert "CREATE TABLE provider_credential_bindings" in upgrade_sql
    assert "CREATE TABLE identity_config_imports" in upgrade_sql
    assert "INSERT INTO identity_config_imports" not in upgrade_sql
    assert "tenant:" in upgrade_sql
    assert "DROP TABLE provider_keys" in downgrade_sql
