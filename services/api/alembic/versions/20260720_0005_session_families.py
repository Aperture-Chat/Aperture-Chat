"""Track stable session-family expiry horizons and revocation state.

Revision ID: 20260720_0005
Revises: 20260720_0004
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0005"
down_revision: str | None = "20260720_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "session_families",
        sa.Column("sid", sa.String(length=128), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("max_expires_at", sa.BigInteger(), nullable=False),
        sa.Column("legacy_unbounded", sa.Boolean(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by_issued_at", sa.BigInteger(), nullable=True),
        sa.Column("revoked_by_expires_at", sa.BigInteger(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "max_expires_at >= 0",
            name=op.f("ck_session_families_max_expires_at_nonnegative"),
        ),
        sa.CheckConstraint(
            "(revoked_at IS NULL AND revoked_by_issued_at IS NULL "
            "AND revoked_by_expires_at IS NULL) OR "
            "(revoked_at IS NOT NULL AND revoked_by_issued_at IS NOT NULL "
            "AND revoked_by_expires_at IS NOT NULL "
            "AND revoked_by_expires_at >= revoked_by_issued_at)",
            name=op.f("ck_session_families_revocation_claims_consistent"),
        ),
        sa.PrimaryKeyConstraint("sid", name=op.f("pk_session_families")),
    )
    op.create_index(
        "ix_session_families_max_expires_at",
        "session_families",
        ["max_expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_session_families_user_max_expires_at",
        "session_families",
        ["user_id", "max_expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_session_families_tenant_max_expires_at",
        "session_families",
        ["tenant_id", "max_expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_session_families_revoked_max_expires_at",
        "session_families",
        ["revoked_at", "max_expires_at"],
        unique=False,
    )

    families = sa.table(
        "session_families",
        sa.column("sid", sa.String(length=128)),
        sa.column("user_id", sa.String(length=255)),
        sa.column("tenant_id", sa.String(length=255)),
        sa.column("max_expires_at", sa.BigInteger()),
        sa.column("legacy_unbounded", sa.Boolean()),
        sa.column("revoked_at", sa.DateTime(timezone=True)),
        sa.column("revoked_by_issued_at", sa.BigInteger()),
        sa.column("revoked_by_expires_at", sa.BigInteger()),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    revoked = sa.table(
        "revoked_sessions",
        sa.column("sid", sa.String(length=128)),
        sa.column("user_id", sa.String(length=255)),
        sa.column("tenant_id", sa.String(length=255)),
        sa.column("issued_at", sa.BigInteger()),
        sa.column("expires_at", sa.BigInteger()),
        sa.column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.execute(
        families.insert().from_select(
            [
                "sid",
                "user_id",
                "tenant_id",
                "max_expires_at",
                "legacy_unbounded",
                "revoked_at",
                "revoked_by_issued_at",
                "revoked_by_expires_at",
                "updated_at",
            ],
            sa.select(
                revoked.c.sid,
                revoked.c.user_id,
                revoked.c.tenant_id,
                sa.case((revoked.c.expires_at < 0, 0), else_=revoked.c.expires_at),
                sa.true(),
                revoked.c.revoked_at,
                revoked.c.issued_at,
                revoked.c.expires_at,
                revoked.c.revoked_at,
            ),
        )
    )


def downgrade() -> None:
    op.drop_index(
        "ix_session_families_revoked_max_expires_at",
        table_name="session_families",
    )
    op.drop_index(
        "ix_session_families_tenant_max_expires_at",
        table_name="session_families",
    )
    op.drop_index(
        "ix_session_families_user_max_expires_at",
        table_name="session_families",
    )
    op.drop_index(
        "ix_session_families_max_expires_at",
        table_name="session_families",
    )
    op.drop_table("session_families")
