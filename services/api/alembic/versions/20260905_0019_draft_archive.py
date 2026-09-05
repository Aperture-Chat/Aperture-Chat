"""Keep private draft archive state across devices."""
import sqlalchemy as sa
from alembic import op

revision = "20260905_0019"
down_revision = "20260820_0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("draft_documents", sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("draft_documents", "archived")
