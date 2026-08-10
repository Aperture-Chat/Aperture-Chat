"""Preserve alert-notification insertion order across restarts.

Revision ID: 20260720_0003
Revises: 20260720_0002
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0003"
down_revision: str | None = "20260720_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "alert_notifications"
_SQLITE_V2_TABLE = "alert_notifications_legacy_0002"
_SQLITE_V3_TABLE = "alert_notifications_legacy_0003"
_POSTGRES_SEQUENCE = "alert_notifications_sequence_seq"


def _notification_columns(
    *, include_sequence: bool
) -> list[sa.Column[object] | sa.CheckConstraint]:
    columns: list[sa.Column[object] | sa.CheckConstraint] = []
    if include_sequence:
        columns.append(
            sa.Column(
                "sequence",
                sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
                autoincrement=True,
                nullable=False,
            )
        )
    columns.extend(
        [
            sa.Column("id", sa.String(length=255), nullable=False),
            sa.Column("rule_id", sa.String(length=255), nullable=False),
            sa.Column("rule_name", sa.Text(), nullable=False),
            sa.Column("scope", sa.String(length=32), nullable=False),
            sa.Column("tenant_id", sa.String(length=255), nullable=True),
            sa.Column("event_id", sa.String(length=255), nullable=False),
            sa.Column("event_action", sa.Text(), nullable=False),
            sa.Column("event_severity", sa.String(length=32), nullable=False),
            sa.Column("actor_id", sa.String(length=255), nullable=False),
            sa.Column("actor_name", sa.Text(), nullable=False),
            sa.Column("summary", sa.Text(), nullable=False),
            sa.Column("matched_count", sa.Integer(), nullable=False),
            sa.Column("recipients", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("status_detail", sa.Text(), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
            sa.CheckConstraint(
                "attempts >= 0",
                name=op.f("ck_alert_notifications_attempts_nonnegative"),
            ),
            sa.CheckConstraint(
                "event_severity IN ('info', 'warning', 'critical')",
                name=op.f("ck_alert_notifications_event_severity_valid"),
            ),
            sa.CheckConstraint(
                "matched_count >= 1",
                name=op.f("ck_alert_notifications_matched_count_positive"),
            ),
            sa.CheckConstraint(
                "scope IN ('platform', 'tenant')",
                name=op.f("ck_alert_notifications_scope_valid"),
            ),
            sa.CheckConstraint(
                "status IN ('queued', 'sent', 'failed', 'not_configured', 'logged')",
                name=op.f("ck_alert_notifications_status_valid"),
            ),
        ]
    )
    return columns


def _create_sqlite_v3_table() -> None:
    op.create_table(
        _TABLE,
        *_notification_columns(include_sequence=True),
        sa.PrimaryKeyConstraint("sequence", name=op.f("pk_alert_notifications")),
        sa.UniqueConstraint("id", name=op.f("uq_alert_notifications_id")),
        sqlite_autoincrement=True,
    )


def _create_sqlite_v2_table() -> None:
    op.create_table(
        _TABLE,
        *_notification_columns(include_sequence=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alert_notifications")),
    )


def _drop_v2_indexes() -> None:
    op.drop_index(
        "ix_alert_notifications_status_created_at_id",
        table_name=_TABLE,
    )
    op.drop_index(
        "ix_alert_notifications_tenant_created_at_id",
        table_name=_TABLE,
    )


def _create_v2_indexes() -> None:
    op.create_index(
        "ix_alert_notifications_status_created_at_id",
        _TABLE,
        ["status", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_alert_notifications_tenant_created_at_id",
        _TABLE,
        ["tenant_id", "created_at", "id"],
        unique=False,
    )


def _drop_v3_indexes() -> None:
    op.drop_index(
        "ix_alert_notifications_tenant_created_at_sequence",
        table_name=_TABLE,
    )
    op.drop_index(
        "ix_alert_notifications_status_created_at_sequence",
        table_name=_TABLE,
    )


def _create_v3_indexes() -> None:
    op.create_index(
        "ix_alert_notifications_status_created_at_sequence",
        _TABLE,
        ["status", "created_at", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_alert_notifications_tenant_created_at_sequence",
        _TABLE,
        ["tenant_id", "created_at", "sequence"],
        unique=False,
    )


def _upgrade_sqlite() -> None:
    _drop_v2_indexes()
    op.rename_table(_TABLE, _SQLITE_V2_TABLE)
    _create_sqlite_v3_table()
    op.execute(
        sa.text(
            f"""
            INSERT INTO {_TABLE} (
                sequence, id, rule_id, rule_name, scope, tenant_id, event_id,
                event_action, event_severity, actor_id, actor_name, summary,
                matched_count, recipients, status, status_detail, attempts,
                created_at, delivered_at
            )
            SELECT
                row_number() OVER (ORDER BY created_at, id),
                id, rule_id, rule_name, scope, tenant_id, event_id,
                event_action, event_severity, actor_id, actor_name, summary,
                matched_count, recipients, status, status_detail, attempts,
                created_at, delivered_at
            FROM {_SQLITE_V2_TABLE}
            ORDER BY created_at, id
            """
        )
    )
    op.drop_table(_SQLITE_V2_TABLE)
    _create_v3_indexes()


def _downgrade_sqlite() -> None:
    _drop_v3_indexes()
    op.rename_table(_TABLE, _SQLITE_V3_TABLE)
    _create_sqlite_v2_table()
    op.execute(
        sa.text(
            f"""
            INSERT INTO {_TABLE} (
                id, rule_id, rule_name, scope, tenant_id, event_id,
                event_action, event_severity, actor_id, actor_name, summary,
                matched_count, recipients, status, status_detail, attempts,
                created_at, delivered_at
            )
            SELECT
                id, rule_id, rule_name, scope, tenant_id, event_id,
                event_action, event_severity, actor_id, actor_name, summary,
                matched_count, recipients, status, status_detail, attempts,
                created_at, delivered_at
            FROM {_SQLITE_V3_TABLE}
            ORDER BY sequence
            """
        )
    )
    op.drop_table(_SQLITE_V3_TABLE)
    _create_v2_indexes()


def _upgrade_postgresql() -> None:
    _drop_v2_indexes()
    op.execute(f"CREATE SEQUENCE {_POSTGRES_SEQUENCE} AS BIGINT")
    op.add_column(_TABLE, sa.Column("sequence", sa.BigInteger(), nullable=True))
    op.execute(
        f"""
        WITH ordered AS (
            SELECT id, row_number() OVER (ORDER BY created_at, id)::BIGINT AS sequence
            FROM {_TABLE}
        )
        UPDATE {_TABLE} AS target
        SET sequence = ordered.sequence
        FROM ordered
        WHERE target.id = ordered.id
        """
    )
    op.alter_column(
        _TABLE,
        "sequence",
        existing_type=sa.BigInteger(),
        nullable=False,
    )
    op.execute(
        f"ALTER TABLE {_TABLE} ALTER COLUMN sequence "
        f"SET DEFAULT nextval('{_POSTGRES_SEQUENCE}'::regclass)"
    )
    op.execute(f"ALTER SEQUENCE {_POSTGRES_SEQUENCE} OWNED BY {_TABLE}.sequence")
    op.execute(
        f"SELECT setval('{_POSTGRES_SEQUENCE}', "
        f"COALESCE((SELECT MAX(sequence) + 1 FROM {_TABLE}), 1), false)"
    )
    op.drop_constraint("pk_alert_notifications", _TABLE, type_="primary")
    op.create_primary_key("pk_alert_notifications", _TABLE, ["sequence"])
    op.create_unique_constraint("uq_alert_notifications_id", _TABLE, ["id"])
    _create_v3_indexes()


def _downgrade_postgresql() -> None:
    _drop_v3_indexes()
    op.drop_constraint("pk_alert_notifications", _TABLE, type_="primary")
    op.drop_constraint("uq_alert_notifications_id", _TABLE, type_="unique")
    op.create_primary_key("pk_alert_notifications", _TABLE, ["id"])
    op.execute(f"ALTER TABLE {_TABLE} ALTER COLUMN sequence DROP DEFAULT")
    op.execute(f"ALTER SEQUENCE {_POSTGRES_SEQUENCE} OWNED BY NONE")
    op.drop_column(_TABLE, "sequence")
    op.execute(f"DROP SEQUENCE {_POSTGRES_SEQUENCE}")
    _create_v2_indexes()


def upgrade() -> None:
    dialect = op.get_context().dialect.name
    if dialect == "sqlite":
        _upgrade_sqlite()
        return
    if dialect == "postgresql":
        _upgrade_postgresql()
        return
    raise RuntimeError(f"Migration {revision} does not support dialect {dialect!r}.")


def downgrade() -> None:
    dialect = op.get_context().dialect.name
    if dialect == "sqlite":
        _downgrade_sqlite()
        return
    if dialect == "postgresql":
        _downgrade_postgresql()
        return
    raise RuntimeError(f"Migration {revision} does not support dialect {dialect!r}.")
