from __future__ import annotations

from datetime import UTC, datetime
from io import StringIO
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.db import (
    HEAD_REVISION,
    Base,
    TenantMfaPolicyRow,
    UsageRecordRow,
    create_application_engine,
    create_session_factory,
    current_schema_revision,
    session_scope,
    upgrade_database,
)
from app.db.engine import alembic_config


USAGE_BUDGET_TABLES = {
    "tenant_usage_budgets",
    "tenant_daily_usage",
    "tenant_usage_permits",
    "tenant_usage_completion_events",
}

EXPECTED_COLUMNS: dict[str, dict[str, tuple[str, bool]]] = {
    "tenant_usage_budgets": {
        "tenant_id": ("VARCHAR(255)", False),
        "budget_unit": ("VARCHAR(16)", False),
        "budget_period": ("VARCHAR(16)", False),
        "daily_token_limit": ("BIGINT", False),
        "spend_limit_nanos": ("BIGINT", False),
        "updated_at": ("DATETIME", False),
        "updated_by": ("VARCHAR(255)", True),
    },
    "tenant_daily_usage": {
        "tenant_id": ("VARCHAR(255)", False),
        "usage_date": ("DATE", False),
        "reported_tokens": ("BIGINT", False),
        "reported_tokens_overflowed": ("BOOLEAN", False),
        "reported_cost_nanos": ("BIGINT", False),
        "reported_cost_overflowed": ("BOOLEAN", False),
        "metered_completions": ("BIGINT", False),
        "unmetered_completions": ("BIGINT", False),
        "cost_metered_completions": ("BIGINT", False),
        "cost_unmetered_completions": ("BIGINT", False),
        "updated_at": ("DATETIME", False),
    },
    "tenant_usage_permits": {
        "permit_id": ("VARCHAR(64)", False),
        "request_id_hash": ("VARCHAR(64)", False),
        "tenant_id": ("VARCHAR(255)", False),
        "admission_date": ("DATE", False),
        "status": ("VARCHAR(32)", False),
        "acquired_at": ("DATETIME", False),
        "closed_at": ("DATETIME", True),
    },
    "tenant_usage_completion_events": {
        "permit_id": ("VARCHAR(64)", False),
        "completion_id_hash": ("VARCHAR(64)", False),
        "usage_record_id": ("VARCHAR(255)", False),
        "usage_record_binding_hash": ("VARCHAR(64)", False),
        "completion_date": ("DATE", False),
        "completed_at": ("DATETIME", False),
        "metering_status": ("VARCHAR(32)", False),
        "prompt_tokens": ("BIGINT", True),
        "completion_tokens": ("BIGINT", True),
        "total_tokens": ("BIGINT", True),
        "reported_cost_nanos": ("BIGINT", True),
    },
}

EXPECTED_PRIMARY_KEYS = {
    "tenant_usage_budgets": ["tenant_id"],
    "tenant_daily_usage": ["tenant_id", "usage_date"],
    "tenant_usage_permits": ["permit_id"],
    "tenant_usage_completion_events": ["completion_id_hash"],
}

EXPECTED_INDEXES = {
    "tenant_usage_budgets": set(),
    "tenant_daily_usage": {"ix_tenant_daily_usage_date_tenant"},
    "tenant_usage_permits": {
        "ix_tenant_usage_permits_status_acquired",
        "ix_tenant_usage_permits_tenant_admission_status_acquired",
    },
    "tenant_usage_completion_events": {
        "ix_tenant_usage_completion_events_completed_at",
        "ix_tenant_usage_completion_events_date_permit",
    },
}

EXPECTED_CHECKS = {
    "tenant_usage_budgets": {
        "ck_tenant_usage_budgets_budget_period_valid",
        "ck_tenant_usage_budgets_budget_unit_valid",
        "ck_tenant_usage_budgets_daily_token_limit_bigint_max",
        "ck_tenant_usage_budgets_daily_token_limit_nonnegative",
        "ck_tenant_usage_budgets_spend_limit_nanos_bigint_max",
        "ck_tenant_usage_budgets_spend_limit_nanos_nonnegative",
    },
    "tenant_daily_usage": {
        "ck_tenant_daily_usage_metered_completions_bigint_max",
        "ck_tenant_daily_usage_metered_completions_nonnegative",
        "ck_tenant_daily_usage_cost_metered_completions_bigint_max",
        "ck_tenant_daily_usage_cost_metered_completions_nonnegative",
        "ck_tenant_daily_usage_cost_unmetered_completions_bigint_max",
        "ck_tenant_daily_usage_cost_unmetered_completions_nonnegative",
        "ck_tenant_daily_usage_reported_cost_nanos_bigint_max",
        "ck_tenant_daily_usage_reported_cost_nanos_nonnegative",
        "ck_tenant_daily_usage_reported_cost_overflow_consistent",
        "ck_tenant_daily_usage_reported_tokens_bigint_max",
        "ck_tenant_daily_usage_reported_tokens_nonnegative",
        "ck_tenant_daily_usage_reported_overflow_consistent",
        "ck_tenant_daily_usage_unmetered_completions_bigint_max",
        "ck_tenant_daily_usage_unmetered_completions_nonnegative",
    },
    "tenant_usage_permits": {
        "ck_tenant_usage_permits_closed_after_acquire",
        "ck_tenant_usage_permits_lifecycle_consistent",
        "ck_tenant_usage_permits_request_id_hash_sha256_length",
        "ck_tenant_usage_permits_status_valid",
    },
    "tenant_usage_completion_events": {
        "ck_tenant_usage_completion_events_completion_id_hash_sha256_length",
        "ck_tenant_usage_completion_events_completion_tokens_bigint_max",
        "ck_tenant_usage_completion_events_completion_tokens_nonnegative",
        "ck_tenant_usage_completion_events_metering_status_valid",
        "ck_tenant_usage_completion_events_metering_total_consistent",
        "ck_tenant_usage_completion_events_prompt_tokens_bigint_max",
        "ck_tenant_usage_completion_events_prompt_tokens_nonnegative",
        "ck_tenant_usage_completion_events_reported_cost_nanos_bigint_max",
        "ck_tenant_usage_completion_events_reported_cost_nanos_nonnegative",
        "ck_tenant_usage_completion_events_token_totals_consistent",
        "ck_tenant_usage_completion_events_total_tokens_bigint_max",
        "ck_tenant_usage_completion_events_total_tokens_nonnegative",
        "ck_tenant_usage_completion_events_usage_record_binding_hash_sha256_length",
    },
}


def _sqlite_url(path: Path) -> str:
    return f"sqlite:///{path}"


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
            command.upgrade(config, "20260720_0006:20260720_0007", sql=True)
        else:
            command.downgrade(config, "20260720_0007:20260720_0006", sql=True)
    finally:
        get_settings.cache_clear()
    return output.getvalue()


def _legacy_usage_values(
    *,
    record_id: str,
    tenant_id: str | None,
    message_count: int,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    total_tokens: int | None,
    created_at: str,
) -> dict[str, object]:
    return {
        "id": record_id,
        "tenant_id": tenant_id,
        "user_id": f"user-{record_id}",
        "user_name": "Budget Test User",
        "user_role": "user",
        "model_id": "provider/model",
        "provider_name": "Provider",
        "surface": "chat",
        "message_count": message_count,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "thread_id": None,
        "source": "live",
        "created_at": created_at,
    }


def test_usage_budget_fresh_upgrade_has_exact_schema_and_metadata_parity(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "usage-budget-fresh.sqlite3"))
    try:
        upgrade_database(engine)
        inspector = inspect(engine)

        assert current_schema_revision(engine) == HEAD_REVISION == "20260820_0018"
        assert USAGE_BUDGET_TABLES <= set(inspector.get_table_names())

        for table, expected_columns in EXPECTED_COLUMNS.items():
            reflected_columns = {
                column["name"]: (str(column["type"]).upper(), column["nullable"])
                for column in inspector.get_columns(table)
            }
            assert reflected_columns == expected_columns
            assert (
                inspector.get_pk_constraint(table)["constrained_columns"]
                == (EXPECTED_PRIMARY_KEYS[table])
            )
            assert {index["name"] for index in inspector.get_indexes(table)} == (
                EXPECTED_INDEXES[table]
            )
            assert {
                constraint["name"] for constraint in inspector.get_check_constraints(table)
            } == EXPECTED_CHECKS[table]

        assert inspector.get_unique_constraints("tenant_usage_budgets") == []
        assert inspector.get_unique_constraints("tenant_daily_usage") == []
        assert inspector.get_unique_constraints("tenant_usage_permits") == [
            {
                "name": "uq_tenant_usage_permits_tenant_request_id_hash",
                "column_names": ["tenant_id", "request_id_hash"],
            }
        ]
        assert inspector.get_unique_constraints("tenant_usage_completion_events") == [
            {
                "name": "uq_tenant_usage_completion_events_usage_record_id",
                "column_names": ["usage_record_id"],
            }
        ]

        for table in (
            "tenant_usage_budgets",
            "tenant_daily_usage",
            "tenant_usage_permits",
        ):
            assert inspector.get_foreign_keys(table) == []
        assert inspector.get_foreign_keys("tenant_usage_completion_events") == [
            {
                "name": ("fk_tenant_usage_completion_events_permit_id_tenant_usage_permits"),
                "constrained_columns": ["permit_id"],
                "referred_schema": None,
                "referred_table": "tenant_usage_permits",
                "referred_columns": ["permit_id"],
                "options": {"ondelete": "CASCADE"},
            }
        ]

        with engine.connect() as connection:
            context = MigrationContext.configure(connection)
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()


def test_usage_budget_0006_upgrade_and_downgrade_preserve_existing_rows(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "usage-budget-linear.sqlite3"))
    factory = create_session_factory(engine)
    now = datetime(2026, 7, 20, 18, tzinfo=UTC)
    try:
        upgrade_database(engine, "20260720_0006")
        with session_scope(factory) as session:
            session.add_all(
                [
                    TenantMfaPolicyRow(
                        tenant_id="tenant-linear",
                        required=True,
                        generation=1,
                        updated_at=now,
                        updated_by="owner-linear",
                    ),
                    UsageRecordRow(
                        id="usage-linear",
                        tenant_id="tenant-linear",
                        user_id="user-linear",
                        user_name="Linear User",
                        user_role="user",
                        model_id="provider/model",
                        provider_name="Provider",
                        surface="chat",
                        message_count=7,
                        prompt_tokens=11,
                        completion_tokens=13,
                        total_tokens=24,
                        thread_id="thread-linear",
                        source="live",
                        created_at=now,
                    ),
                ]
            )

        upgrade_database(engine)
        assert current_schema_revision(engine) == HEAD_REVISION == "20260820_0018"
        assert USAGE_BUDGET_TABLES <= set(inspect(engine).get_table_names())

        _downgrade(engine, "20260720_0006")
        assert current_schema_revision(engine) == "20260720_0006"
        assert USAGE_BUDGET_TABLES.isdisjoint(inspect(engine).get_table_names())
        with session_scope(factory) as session:
            assert session.get(TenantMfaPolicyRow, "tenant-linear") is not None
            assert (
                session.scalar(select(UsageRecordRow).where(UsageRecordRow.id == "usage-linear"))
                is not None
            )
    finally:
        engine.dispose()


def test_usage_budget_sqlite_backfill_uses_exact_legacy_completion_rules(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "usage-budget-backfill.sqlite3"))
    try:
        upgrade_database(engine, "20260720_0006")
        rows = [
            _legacy_usage_values(
                record_id="reported-total-crosses-utc-date",
                tenant_id="tenant-backfill",
                message_count=99,
                prompt_tokens=10,
                completion_tokens=20,
                total_tokens=70,
                created_at="2026-07-20T23:30:00-02:00",
            ),
            _legacy_usage_values(
                record_id="reported-components",
                tenant_id="tenant-backfill",
                message_count=42,
                prompt_tokens=3,
                completion_tokens=4,
                total_tokens=None,
                created_at="2026-07-20T12:00:00+00:00",
            ),
            _legacy_usage_values(
                record_id="partial-unmetered",
                tenant_id="tenant-backfill",
                message_count=17,
                prompt_tokens=5,
                completion_tokens=None,
                total_tokens=None,
                created_at="2026-07-20T12:01:00+00:00",
            ),
            _legacy_usage_values(
                record_id="legacy-all-zero-unmetered",
                tenant_id="tenant-backfill",
                message_count=88,
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                created_at="2026-07-20T12:02:00+00:00",
            ),
            _legacy_usage_values(
                record_id="owner-without-attributed-tenant",
                tenant_id=None,
                message_count=1,
                prompt_tokens=500,
                completion_tokens=500,
                total_tokens=1_000,
                created_at="2026-07-20T12:03:00+00:00",
            ),
        ]
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO usage_records (
                        id, tenant_id, user_id, user_name, user_role, model_id,
                        provider_name, surface, message_count, prompt_tokens,
                        completion_tokens, total_tokens, thread_id, source, created_at
                    ) VALUES (
                        :id, :tenant_id, :user_id, :user_name, :user_role, :model_id,
                        :provider_name, :surface, :message_count, :prompt_tokens,
                        :completion_tokens, :total_tokens, :thread_id, :source, :created_at
                    )
                    """
                ),
                rows,
            )

        upgrade_database(engine)
        with engine.connect() as connection:
            aggregates = (
                connection.execute(
                    text(
                        """
                    SELECT tenant_id, usage_date, reported_tokens,
                           reported_tokens_overflowed,
                           metered_completions, unmetered_completions
                    FROM tenant_daily_usage
                    ORDER BY usage_date
                    """
                    )
                )
                .mappings()
                .all()
            )
            assert [dict(row) for row in aggregates] == [
                {
                    "tenant_id": "tenant-backfill",
                    "usage_date": "2026-07-20",
                    "reported_tokens": 7,
                    "reported_tokens_overflowed": 0,
                    "metered_completions": 1,
                    "unmetered_completions": 2,
                },
                {
                    "tenant_id": "tenant-backfill",
                    "usage_date": "2026-07-21",
                    "reported_tokens": 70,
                    "reported_tokens_overflowed": 0,
                    "metered_completions": 1,
                    "unmetered_completions": 0,
                },
            ]
            assert connection.scalar(text("SELECT count(*) FROM tenant_usage_budgets")) == 0
            assert connection.scalar(text("SELECT count(*) FROM tenant_usage_permits")) == 0
            assert (
                connection.scalar(text("SELECT count(*) FROM tenant_usage_completion_events")) == 0
            )
    finally:
        engine.dispose()


def test_usage_budget_sqlite_backfill_saturates_cumulative_bigint_overflow(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "usage-budget-overflow.sqlite3"))
    try:
        upgrade_database(engine, "20260720_0006")
        rows = [
            _legacy_usage_values(
                record_id="near-bigint-max",
                tenant_id="tenant-overflow",
                message_count=1,
                prompt_tokens=None,
                completion_tokens=None,
                total_tokens=9_223_372_036_854_775_806,
                created_at="2026-07-20T12:00:00+00:00",
            ),
            _legacy_usage_values(
                record_id="crosses-bigint-max",
                tenant_id="tenant-overflow",
                message_count=1,
                prompt_tokens=None,
                completion_tokens=None,
                total_tokens=2,
                created_at="2026-07-20T12:01:00+00:00",
            ),
        ]
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO usage_records (
                        id, tenant_id, user_id, user_name, user_role, model_id,
                        provider_name, surface, message_count, prompt_tokens,
                        completion_tokens, total_tokens, thread_id, source, created_at
                    ) VALUES (
                        :id, :tenant_id, :user_id, :user_name, :user_role, :model_id,
                        :provider_name, :surface, :message_count, :prompt_tokens,
                        :completion_tokens, :total_tokens, :thread_id, :source, :created_at
                    )
                    """
                ),
                rows,
            )

        upgrade_database(engine)
        with engine.connect() as connection:
            aggregate = (
                connection.execute(
                    text(
                        """
                        SELECT reported_tokens, reported_tokens_overflowed,
                               metered_completions, unmetered_completions
                        FROM tenant_daily_usage
                        WHERE tenant_id = 'tenant-overflow'
                          AND usage_date = '2026-07-20'
                        """
                    )
                )
                .mappings()
                .one()
            )
        assert dict(aggregate) == {
            "reported_tokens": 9_223_372_036_854_775_807,
            "reported_tokens_overflowed": 1,
            "metered_completions": 2,
            "unmetered_completions": 0,
        }
    finally:
        engine.dispose()


def test_usage_budget_constraints_reject_invalid_persisted_states(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "usage-budget-invalid.sqlite3"))
    acquired_at = "2026-07-20 12:01:00"
    closed_at = "2026-07-20 12:02:00"

    def reject(statement: str, parameters: dict[str, object]) -> None:
        with pytest.raises((IntegrityError, OverflowError)):
            with engine.begin() as connection:
                connection.execute(text(statement), parameters)

    try:
        upgrade_database(engine)
        reject(
            """
            INSERT INTO tenant_usage_budgets
                (tenant_id, daily_token_limit, updated_at, updated_by)
            VALUES ('tenant-negative-budget', -1, :updated_at, NULL)
            """,
            {"updated_at": acquired_at},
        )
        reject(
            """
            INSERT INTO tenant_usage_budgets
                (tenant_id, daily_token_limit, updated_at, updated_by)
            VALUES ('tenant-overflow-budget', 9223372036854775808, :updated_at, NULL)
            """,
            {"updated_at": acquired_at},
        )

        for column in (
            "reported_tokens",
            "metered_completions",
            "unmetered_completions",
        ):
            values = {
                "reported_tokens": 0,
                "reported_tokens_overflowed": False,
                "metered_completions": 0,
                "unmetered_completions": 0,
            }
            values[column] = -1
            reject(
                """
                INSERT INTO tenant_daily_usage (
                    tenant_id, usage_date, reported_tokens,
                    reported_tokens_overflowed, metered_completions,
                    unmetered_completions, updated_at
                ) VALUES (
                    :tenant_id, '2026-07-20', :reported_tokens,
                    :reported_tokens_overflowed, :metered_completions,
                    :unmetered_completions, :updated_at
                )
                """,
                {
                    "tenant_id": f"tenant-negative-{column}",
                    "updated_at": acquired_at,
                    **values,
                },
            )

        reject(
            """
            INSERT INTO tenant_daily_usage (
                tenant_id, usage_date, reported_tokens,
                reported_tokens_overflowed, metered_completions,
                unmetered_completions, updated_at
            ) VALUES (
                'tenant-inconsistent-overflow', '2026-07-20', 1,
                true, 0, 0, :updated_at
            )
            """,
            {"updated_at": acquired_at},
        )

        permit_insert = """
            INSERT INTO tenant_usage_permits (
                permit_id, request_id_hash, tenant_id, admission_date,
                status, acquired_at, closed_at
            ) VALUES (
                :permit_id, :request_id_hash, :tenant_id, '2026-07-20',
                :status, :acquired_at, :closed_at
            )
        """
        permit_defaults: dict[str, object] = {
            "request_id_hash": "a" * 64,
            "tenant_id": "tenant-invalid-permit",
            "status": "started",
            "acquired_at": acquired_at,
            "closed_at": None,
        }
        invalid_permits = [
            {"permit_id": "permit-short-hash", "request_id_hash": "short"},
            {"permit_id": "permit-bad-status", "status": "unknown"},
            {
                "permit_id": "permit-started-with-close",
                "status": "started",
                "closed_at": closed_at,
            },
            {
                "permit_id": "permit-completed-without-close",
                "status": "completed",
            },
            {
                "permit_id": "permit-close-before-acquire",
                "status": "completed",
                "closed_at": "2026-07-20 12:00:00",
            },
        ]
        for invalid in invalid_permits:
            reject(permit_insert, {**permit_defaults, **invalid})

        valid_permit = {
            **permit_defaults,
            "permit_id": "permit-valid-parent",
        }
        with engine.begin() as connection:
            connection.execute(text(permit_insert), valid_permit)

        duplicate_request = {
            **permit_defaults,
            "permit_id": "permit-duplicate-request",
        }
        reject(permit_insert, duplicate_request)

        second_valid_permit = {
            **permit_defaults,
            "permit_id": "permit-second-parent",
            "request_id_hash": "d" * 64,
        }
        with engine.begin() as connection:
            connection.execute(text(permit_insert), second_valid_permit)

        completion_insert = """
            INSERT INTO tenant_usage_completion_events (
                permit_id, completion_id_hash, usage_record_id,
                usage_record_binding_hash, completion_date,
                completed_at, metering_status, prompt_tokens,
                completion_tokens, total_tokens
            ) VALUES (
                :permit_id, :completion_id_hash, :usage_record_id,
                :usage_record_binding_hash, '2026-07-20',
                :completed_at, :metering_status, :prompt_tokens,
                :completion_tokens, :total_tokens
            )
        """
        completion_defaults: dict[str, object] = {
            "permit_id": "permit-valid-parent",
            "completion_id_hash": "b" * 64,
            "usage_record_id": "usage-valid-shape",
            "usage_record_binding_hash": "e" * 64,
            "completed_at": closed_at,
            "metering_status": "reported",
            "prompt_tokens": 2,
            "completion_tokens": 3,
            "total_tokens": 5,
        }
        invalid_completions = [
            {"completion_id_hash": "short", "usage_record_id": "usage-short-hash"},
            {
                "usage_record_binding_hash": "short",
                "usage_record_id": "usage-short-binding-hash",
            },
            {"metering_status": "estimated", "usage_record_id": "usage-bad-status"},
            {"prompt_tokens": -1, "usage_record_id": "usage-negative-prompt"},
            {"completion_tokens": -1, "usage_record_id": "usage-negative-completion"},
            {"total_tokens": -1, "usage_record_id": "usage-negative-total"},
            {
                "total_tokens": 6,
                "usage_record_id": "usage-contradictory-total",
            },
            {
                "total_tokens": 9_223_372_036_854_775_808,
                "prompt_tokens": None,
                "completion_tokens": None,
                "usage_record_id": "usage-overflow-total",
            },
            {"total_tokens": None, "usage_record_id": "usage-reported-without-total"},
            {
                "metering_status": "unmetered",
                "total_tokens": 0,
                "usage_record_id": "usage-unmetered-with-total",
            },
            {
                "permit_id": "missing-permit",
                "usage_record_id": "usage-missing-permit",
            },
        ]
        for invalid in invalid_completions:
            reject(completion_insert, {**completion_defaults, **invalid})

        with engine.begin() as connection:
            connection.execute(text(completion_insert), completion_defaults)
        reject(
            completion_insert,
            {
                **completion_defaults,
                "completion_id_hash": "c" * 64,
            },
        )
        reject(
            completion_insert,
            {
                **completion_defaults,
                "permit_id": "permit-second-parent",
                "usage_record_id": "usage-cross-permit-duplicate",
            },
        )
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("database_url", "usage_date_expression"),
    [
        (
            "postgresql://offline.invalid/aperture",
            "CAST(created_at AT TIME ZONE 'UTC' AS DATE)",
        ),
        ("sqlite:///offline-invalid.sqlite3", "date(created_at)"),
    ],
)
def test_usage_budget_upgrade_and_downgrade_render_offline_for_supported_databases(
    monkeypatch: pytest.MonkeyPatch,
    database_url: str,
    usage_date_expression: str,
) -> None:
    rendered_upgrade = _render_migration(
        monkeypatch,
        database_url=database_url,
        direction="upgrade",
    )
    for table in USAGE_BUDGET_TABLES:
        assert f"CREATE TABLE {table}" in rendered_upgrade
    for index_names in EXPECTED_INDEXES.values():
        for index_name in index_names:
            assert f"CREATE INDEX {index_name}" in rendered_upgrade
    assert "INSERT INTO tenant_daily_usage" in rendered_upgrade
    assert usage_date_expression in rendered_upgrade
    assert (
        "message_count"
        not in rendered_upgrade.split("INSERT INTO tenant_daily_usage", maxsplit=1)[1]
    )
    assert "_alembic_tmp_" not in rendered_upgrade

    rendered_downgrade = _render_migration(
        monkeypatch,
        database_url=database_url,
        direction="downgrade",
    )
    for table in USAGE_BUDGET_TABLES:
        assert f"DROP TABLE {table}" in rendered_downgrade
    for index_names in EXPECTED_INDEXES.values():
        for index_name in index_names:
            assert f"DROP INDEX {index_name}" in rendered_downgrade
    assert "_alembic_tmp_" not in rendered_downgrade
