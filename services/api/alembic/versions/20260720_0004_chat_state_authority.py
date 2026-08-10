"""Move chat workspace and API-session authority into SQL.

Revision ID: 20260720_0004
Revises: 20260720_0003
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0004"
down_revision: str | None = "20260720_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chat_threads",
        sa.Column(
            "sequence",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("owner_user_id", sa.String(length=255), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("model_id", sa.Text(), nullable=False),
        sa.Column("group_id", sa.String(length=255), nullable=False),
        sa.Column("pinned", sa.Boolean(), nullable=False),
        sa.Column("archived", sa.Boolean(), nullable=False),
        sa.Column("folder_id", sa.String(length=255), nullable=True),
        sa.Column("used_agent", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("messages", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("sequence", name=op.f("pk_chat_threads")),
        sa.UniqueConstraint("id", name=op.f("uq_chat_threads_id")),
        sqlite_autoincrement=True,
    )
    op.create_index(
        "ix_chat_threads_owner_sequence",
        "chat_threads",
        ["owner_user_id", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_chat_threads_tenant_owner_archived_sequence",
        "chat_threads",
        ["tenant_id", "owner_user_id", "archived", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_chat_threads_tenant_owner_folder_sequence",
        "chat_threads",
        ["tenant_id", "owner_user_id", "folder_id", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_chat_threads_tenant_owner_sequence",
        "chat_threads",
        ["tenant_id", "owner_user_id", "sequence"],
        unique=False,
    )

    op.create_table(
        "chat_folders",
        sa.Column(
            "sequence",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("owner_user_id", sa.String(length=255), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("sequence", name=op.f("pk_chat_folders")),
        sa.UniqueConstraint("id", name=op.f("uq_chat_folders_id")),
        sqlite_autoincrement=True,
    )
    op.create_index(
        "ix_chat_folders_owner_sequence",
        "chat_folders",
        ["owner_user_id", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_chat_folders_tenant_owner_sequence",
        "chat_folders",
        ["tenant_id", "owner_user_id", "sequence"],
        unique=False,
    )

    op.create_table(
        "chat_attachments",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("owner_user_id", sa.String(length=255), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("size", sa.String(length=100), nullable=False),
        sa.Column("kind", sa.String(length=100), nullable=False),
        sa.Column("mime_type", sa.String(length=255), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("source_type", sa.String(length=100), nullable=False),
        sa.Column("source_uri", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=100), nullable=False),
        sa.Column("uploaded_at", sa.Text(), nullable=True),
        sa.Column("text_preview", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "size_bytes IS NULL OR size_bytes >= 0",
            name=op.f("ck_chat_attachments_size_bytes_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_attachments")),
    )
    op.create_index(
        "ix_chat_attachments_owner_id",
        "chat_attachments",
        ["owner_user_id", "id"],
        unique=False,
    )
    op.create_index(
        "ix_chat_attachments_source_type",
        "chat_attachments",
        ["source_type"],
        unique=False,
    )
    op.create_index(
        "ix_chat_attachments_tenant_owner_id",
        "chat_attachments",
        ["tenant_id", "owner_user_id", "id"],
        unique=False,
    )

    op.create_table(
        "user_api_keys",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("key_prefix", sa.String(length=32), nullable=False),
        sa.Column("masked_value", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("last_used_at", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "length(key_hash) = 64",
            name=op.f("ck_user_api_keys_key_hash_sha256_length"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_api_keys")),
        sa.UniqueConstraint("user_id", name=op.f("uq_user_api_keys_user_id")),
    )
    op.create_index(
        "ix_user_api_keys_key_hash",
        "user_api_keys",
        ["key_hash"],
        unique=True,
    )
    op.create_index(
        "ix_user_api_keys_tenant_user",
        "user_api_keys",
        ["tenant_id", "user_id"],
        unique=False,
    )

    op.create_table(
        "user_session_watermarks",
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("issued_before_ms", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.String(length=255), nullable=True),
        sa.Column("reason", sa.String(length=255), nullable=False),
        sa.CheckConstraint(
            "issued_before_ms >= 0",
            name=op.f("ck_user_session_watermarks_issued_before_ms_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_user_session_watermarks")),
    )
    op.create_index(
        "ix_user_session_watermarks_tenant_issued_before_ms",
        "user_session_watermarks",
        ["tenant_id", "issued_before_ms"],
        unique=False,
    )

    op.create_table(
        "chat_state_imports",
        sa.Column("source_digest", sa.String(length=64), nullable=False),
        sa.Column("source_version", sa.Integer(), nullable=False),
        sa.Column("target_version", sa.Integer(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("prior_application_state_digest", sa.String(length=64), nullable=False),
        sa.Column("thread_count", sa.Integer(), nullable=False),
        sa.Column("folder_count", sa.Integer(), nullable=False),
        sa.Column("attachment_count", sa.Integer(), nullable=False),
        sa.Column("api_key_count", sa.Integer(), nullable=False),
        sa.Column("watermark_count", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "length(source_digest) = 64",
            name=op.f("ck_chat_state_imports_source_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(prior_application_state_digest) = 64",
            name=op.f("ck_chat_state_imports_prior_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "source_version >= 0",
            name=op.f("ck_chat_state_imports_source_version_nonnegative"),
        ),
        sa.CheckConstraint(
            "target_version >= 0",
            name=op.f("ck_chat_state_imports_target_version_nonnegative"),
        ),
        sa.CheckConstraint(
            "thread_count >= 0",
            name=op.f("ck_chat_state_imports_thread_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "folder_count >= 0",
            name=op.f("ck_chat_state_imports_folder_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "attachment_count >= 0",
            name=op.f("ck_chat_state_imports_attachment_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "api_key_count >= 0",
            name=op.f("ck_chat_state_imports_api_key_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "watermark_count >= 0",
            name=op.f("ck_chat_state_imports_watermark_count_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("source_digest", name=op.f("pk_chat_state_imports")),
    )


def downgrade() -> None:
    op.drop_table("chat_state_imports")
    op.drop_index(
        "ix_user_session_watermarks_tenant_issued_before_ms",
        table_name="user_session_watermarks",
    )
    op.drop_table("user_session_watermarks")
    op.drop_index("ix_user_api_keys_tenant_user", table_name="user_api_keys")
    op.drop_index("ix_user_api_keys_key_hash", table_name="user_api_keys")
    op.drop_table("user_api_keys")
    op.drop_index(
        "ix_chat_attachments_tenant_owner_id",
        table_name="chat_attachments",
    )
    op.drop_index("ix_chat_attachments_source_type", table_name="chat_attachments")
    op.drop_index("ix_chat_attachments_owner_id", table_name="chat_attachments")
    op.drop_table("chat_attachments")
    op.drop_index(
        "ix_chat_folders_tenant_owner_sequence",
        table_name="chat_folders",
    )
    op.drop_index("ix_chat_folders_owner_sequence", table_name="chat_folders")
    op.drop_table("chat_folders")
    op.drop_index(
        "ix_chat_threads_tenant_owner_sequence",
        table_name="chat_threads",
    )
    op.drop_index(
        "ix_chat_threads_tenant_owner_folder_sequence",
        table_name="chat_threads",
    )
    op.drop_index(
        "ix_chat_threads_tenant_owner_archived_sequence",
        table_name="chat_threads",
    )
    op.drop_index("ix_chat_threads_owner_sequence", table_name="chat_threads")
    op.drop_table("chat_threads")
