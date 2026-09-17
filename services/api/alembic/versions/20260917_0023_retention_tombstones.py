"""Prevent retained chat content from being restored by stale workspace saves."""

from alembic import op
import sqlalchemy as sa

revision = "20260917_0023"
down_revision = "20260913_0022"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "chat_retention_tombstones",
        sa.Column("thread_id", sa.String(255), primary_key=True),
        sa.Column("tenant_id", sa.String(255), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("policy_revision", sa.String(100), nullable=False),
    )


def downgrade():
    op.drop_table("chat_retention_tombstones")
