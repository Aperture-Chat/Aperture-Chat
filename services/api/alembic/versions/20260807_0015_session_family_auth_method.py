"""Record the originating auth method on each session family.

SSO sessions are authenticated (and MFA-challenged, when the identity
provider's policy says so) by the IdP. Storing the method on the family lets
the MFA-currency invariant distinguish "platform authenticator required" from
"identity provider already vouched for this sign-in" without weakening either
path: rotation reuses the stored method, so a session can never launder its
origin.

Revision ID: 20260807_0015
Revises: 20260802_0014
Create Date: 2026-08-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260807_0015"
down_revision: str | None = "20260802_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Existing rows predate SSO-aware issuance; "local" preserves their
    # current strict MFA semantics exactly.
    op.add_column(
        "session_families",
        sa.Column("auth_method", sa.String(16), nullable=False, server_default="local"),
    )


def downgrade() -> None:
    op.drop_column("session_families", "auth_method")
