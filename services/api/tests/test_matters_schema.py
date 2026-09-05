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
    DraftDocumentRow,
    DraftRevisionRow,
    MatterDeletionJobRow,
    MatterMembershipRow,
    MatterRow,
    create_application_engine,
    create_session_factory,
    current_schema_revision,
    session_scope,
    upgrade_database,
)
from app.db.engine import alembic_config
from app.models.matters import (
    DRAFT_SANITIZER_VERSION,
    MAX_DRAFT_CONTENT_BYTES,
    draft_content_sha256,
)


M9_TABLES = {
    "matters",
    "matter_memberships",
    "matter_deletion_jobs",
    "draft_documents",
    "draft_revisions",
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
            command.upgrade(config, "20260720_0007:20260720_0008", sql=True)
        else:
            command.downgrade(config, "20260720_0008:20260720_0007", sql=True)
    finally:
        get_settings.cache_clear()
    return output.getvalue()


def test_m9_fresh_upgrade_has_exact_tables_links_and_metadata_parity(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "m9-fresh.sqlite3"))
    try:
        upgrade_database(engine)
        inspector = inspect(engine)
        # Later linear migrations may advance HEAD without changing M9's
        # independently rendered 0007 -> 0008 contract below.
        assert current_schema_revision(engine) == HEAD_REVISION
        assert M9_TABLES <= set(inspector.get_table_names())

        expected_columns = {
            "matters": {
                "id",
                "tenant_id",
                "name",
                "retention_days",
                "created_by_user_id",
                "version",
                "created_at",
                "updated_at",
            },
            "matter_memberships": {
                "matter_id",
                "member_user_id",
                "tenant_id",
                "added_by_user_id",
                "created_at",
            },
            "matter_deletion_jobs": {
                "matter_id",
                "tenant_id",
                "requested_by_user_id",
                "requested_matter_version",
                "status",
                "attempt_count",
                "requested_at",
                "updated_at",
                "last_attempt_at",
                "lease_expires_at",
                "application_refs_cleared_at",
                "review_refs_cleared_at",
                "knowledge_refs_cleared_at",
                "legacy_refs_cleared_at",
                "completed_at",
                "last_error_stage",
            },
            "draft_documents": {
                "archived",
                "id",
                "tenant_id",
                "owner_user_id",
                "matter_id",
                "title",
                "current_revision",
                "created_at",
                "updated_at",
            },
            "draft_revisions": {
                "draft_id",
                "revision",
                "tenant_id",
                "owner_user_id",
                "title",
                "content",
                "content_sha256",
                "sanitizer_version",
                "created_at",
            },
        }
        for table, columns in expected_columns.items():
            assert {column["name"] for column in inspector.get_columns(table)} == columns

        assert inspector.get_pk_constraint("matters")["constrained_columns"] == ["id"]
        assert inspector.get_pk_constraint("matter_memberships")["constrained_columns"] == [
            "matter_id",
            "member_user_id",
        ]
        assert inspector.get_pk_constraint("draft_revisions")["constrained_columns"] == [
            "draft_id",
            "revision",
        ]
        assert {index["name"] for index in inspector.get_indexes("matters")} == {
            "ix_matters_tenant_updated_id"
        }
        assert {index["name"] for index in inspector.get_indexes("draft_documents")} == {
            "ix_draft_documents_tenant_matter_owner_updated",
            "ix_draft_documents_tenant_owner_updated",
        }
        assert {index["name"] for index in inspector.get_indexes("matter_deletion_jobs")} == {
            "ix_matter_deletion_jobs_status_lease",
            "ix_matter_deletion_jobs_tenant_status_updated",
        }

        thread_columns = {column["name"] for column in inspector.get_columns("chat_threads")}
        folder_columns = {column["name"] for column in inspector.get_columns("chat_folders")}
        assert "matter_id" in thread_columns
        assert "matter_id" in folder_columns
        assert "ix_chat_threads_tenant_matter_owner_sequence" in {
            index["name"] for index in inspector.get_indexes("chat_threads")
        }
        assert "ix_chat_folders_tenant_matter_owner_sequence" in {
            index["name"] for index in inspector.get_indexes("chat_folders")
        }
        assert inspector.get_foreign_keys("chat_threads") == [
            {
                "name": "fk_chat_threads_matter_id_matters",
                "constrained_columns": ["matter_id"],
                "referred_schema": None,
                "referred_table": "matters",
                "referred_columns": ["id"],
                "options": {"ondelete": "SET NULL"},
            }
        ]
        assert inspector.get_foreign_keys("chat_folders") == [
            {
                "name": "fk_chat_folders_matter_id_matters",
                "constrained_columns": ["matter_id"],
                "referred_schema": None,
                "referred_table": "matters",
                "referred_columns": ["id"],
                "options": {"ondelete": "SET NULL"},
            }
        ]

        with engine.connect() as connection:
            context = MigrationContext.configure(connection)
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()


def test_m9_upgrade_down_up_preserves_preexisting_chat_rows(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "m9-linear.sqlite3"))
    try:
        upgrade_database(engine, "20260720_0007")
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO chat_threads (
                        id, tenant_id, owner_user_id, title, model_id, group_id,
                        pinned, archived, folder_id, used_agent, updated_at, messages
                    ) VALUES (
                        'thread-before-m9', 'tenant-a', 'user-a', 'Before M9',
                        'model-a', '', false, false, 'folder-before-m9', false,
                        'Just now', '[]'
                    )
                    """
                )
            )
            # Deleted sequence values are still part of SQLite's
            # AUTOINCREMENT contract and must survive each batch rebuild.
            connection.execute(
                text(
                    """
                    INSERT INTO chat_threads (
                        sequence, id, tenant_id, owner_user_id, title, model_id,
                        group_id, pinned, archived, folder_id, used_agent,
                        updated_at, messages
                    ) VALUES (
                        50, 'thread-deleted-high-water', 'tenant-a', 'user-a',
                        'Deleted', 'model-a', '', false, false, NULL, false,
                        'Just now', '[]'
                    )
                    """
                )
            )
            connection.execute(text("DELETE FROM chat_threads WHERE sequence = 50"))
            connection.execute(
                text(
                    """
                    INSERT INTO chat_folders (
                        sequence, id, tenant_id, owner_user_id, name, created_at
                    ) VALUES (
                        70, 'folder-deleted-high-water', 'tenant-a', 'user-a',
                        'Deleted', 'Now'
                    )
                    """
                )
            )
            connection.execute(text("DELETE FROM chat_folders WHERE sequence = 70"))
            assert dict(
                connection.execute(
                    text(
                        "SELECT name, seq FROM sqlite_sequence "
                        "WHERE name IN ('chat_threads', 'chat_folders')"
                    )
                )
                .tuples()
                .all()
            ) == {"chat_threads": 50, "chat_folders": 70}
            connection.execute(
                text(
                    """
                    INSERT INTO chat_folders (
                        sequence, id, tenant_id, owner_user_id, name, created_at
                    ) VALUES (
                        1, 'folder-before-m9', 'tenant-a', 'user-a', 'Before M9', 'Now'
                    )
                    """
                )
            )

        upgrade_database(engine)
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT matter_id FROM chat_threads WHERE id = 'thread-before-m9'")
                ).scalar_one()
                is None
            )
            assert (
                connection.execute(
                    text("SELECT matter_id FROM chat_folders WHERE id = 'folder-before-m9'")
                ).scalar_one()
                is None
            )
            assert dict(
                connection.execute(
                    text(
                        "SELECT name, seq FROM sqlite_sequence "
                        "WHERE name IN ('chat_threads', 'chat_folders')"
                    )
                )
                .tuples()
                .all()
            ) == {"chat_threads": 50, "chat_folders": 70}

        _downgrade(engine, "20260720_0007")
        inspector = inspect(engine)
        assert current_schema_revision(engine) == "20260720_0007"
        assert not (M9_TABLES & set(inspector.get_table_names()))
        assert "matter_id" not in {
            column["name"] for column in inspector.get_columns("chat_threads")
        }
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT title FROM chat_threads WHERE id = 'thread-before-m9'")
                ).scalar_one()
                == "Before M9"
            )
            assert (
                connection.execute(
                    text("SELECT name FROM chat_folders WHERE id = 'folder-before-m9'")
                ).scalar_one()
                == "Before M9"
            )
            assert dict(
                connection.execute(
                    text(
                        "SELECT name, seq FROM sqlite_sequence "
                        "WHERE name IN ('chat_threads', 'chat_folders')"
                    )
                )
                .tuples()
                .all()
            ) == {"chat_threads": 50, "chat_folders": 70}

        upgrade_database(engine)
        assert current_schema_revision(engine) == HEAD_REVISION
        assert "matter_id" in {
            column["name"] for column in inspect(engine).get_columns("chat_threads")
        }
        with engine.begin() as connection:
            thread_sequence = connection.execute(
                text(
                    """
                    INSERT INTO chat_threads (
                        id, tenant_id, owner_user_id, title, model_id, group_id,
                        pinned, archived, folder_id, matter_id, used_agent,
                        updated_at, messages
                    ) VALUES (
                        'thread-after-rebuild', 'tenant-a', 'user-a', 'After',
                        'model-a', '', false, false, NULL, NULL, false,
                        'Just now', '[]'
                    ) RETURNING sequence
                    """
                )
            ).scalar_one()
            folder_sequence = connection.execute(
                text(
                    """
                    INSERT INTO chat_folders (
                        id, tenant_id, owner_user_id, name, matter_id, created_at
                    ) VALUES (
                        'folder-after-rebuild', 'tenant-a', 'user-a', 'After',
                        NULL, 'Now'
                    ) RETURNING sequence
                    """
                )
            ).scalar_one()
        assert thread_sequence == 51
        assert folder_sequence == 71
    finally:
        engine.dispose()


def test_m9_composite_scope_and_revision_constraints_fail_closed(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "m9-constraints.sqlite3"))
    factory = create_session_factory(engine)
    now = datetime(2026, 7, 20, 12, tzinfo=UTC)
    try:
        upgrade_database(engine)
        with session_scope(factory) as session:
            session.add(
                MatterRow(
                    id="matter-a",
                    tenant_id="tenant-a",
                    name="Matter A",
                    retention_days=None,
                    created_by_user_id="user-a",
                    version=1,
                    created_at=now,
                    updated_at=now,
                )
            )
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(
                    MatterMembershipRow(
                        matter_id="matter-a",
                        tenant_id="tenant-b",
                        member_user_id="user-b",
                        added_by_user_id="user-a",
                        created_at=now,
                    )
                )
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(
                    MatterRow(
                        id="matter-invalid-retention",
                        tenant_id="tenant-a",
                        name="Invalid",
                        retention_days=0,
                        created_by_user_id="user-a",
                        version=1,
                        created_at=now,
                        updated_at=now,
                    )
                )
        with session_scope(factory) as session:
            session.add(
                DraftDocumentRow(
                    id="draft-a",
                    tenant_id="tenant-a",
                    owner_user_id="user-a",
                    matter_id="matter-a",
                    title="Draft A",
                    current_revision=1,
                    created_at=now,
                    updated_at=now,
                )
            )
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(
                    DraftRevisionRow(
                        draft_id="draft-a",
                        revision=201,
                        tenant_id="tenant-a",
                        owner_user_id="user-a",
                        title="Draft A",
                        content="<p>Too late</p>",
                        content_sha256="a" * 64,
                        sanitizer_version=DRAFT_SANITIZER_VERSION,
                        created_at=now,
                    )
                )
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(
                    MatterDeletionJobRow(
                        matter_id="matter-bad-job",
                        tenant_id="tenant-a",
                        requested_by_user_id="user-a",
                        requested_matter_version=1,
                        status="complete",
                        attempt_count=0,
                        requested_at=now,
                        updated_at=now,
                        completed_at=None,
                    )
                )
    finally:
        engine.dispose()


def test_sqlite_octet_length_enforces_exact_utf8_byte_bound(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "m9-octets.sqlite3"))
    factory = create_session_factory(engine)
    now = datetime(2026, 7, 20, 12, tzinfo=UTC)
    exact = "é" * (MAX_DRAFT_CONTENT_BYTES // 2)
    oversized = f"{exact}é"
    try:
        upgrade_database(engine)
        with engine.connect() as connection:
            assert connection.execute(text("SELECT octet_length('é')")).scalar_one() == 2
        with session_scope(factory) as session:
            session.add(
                DraftDocumentRow(
                    id="draft-byte-bound",
                    tenant_id="tenant-a",
                    owner_user_id="user-a",
                    matter_id=None,
                    title="Byte bound",
                    current_revision=1,
                    created_at=now,
                    updated_at=now,
                )
            )
            session.add(
                DraftRevisionRow(
                    draft_id="draft-byte-bound",
                    revision=1,
                    tenant_id="tenant-a",
                    owner_user_id="user-a",
                    title="Byte bound",
                    content=exact,
                    content_sha256=draft_content_sha256(exact),
                    sanitizer_version=DRAFT_SANITIZER_VERSION,
                    created_at=now,
                )
            )
        assert factory().scalar(select(DraftRevisionRow.draft_id)) == "draft-byte-bound"

        with pytest.raises(IntegrityError):
            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO draft_revisions (
                            draft_id, revision, tenant_id, owner_user_id, title,
                            content, content_sha256, sanitizer_version, created_at
                        ) VALUES (
                            'draft-byte-bound', 2, 'tenant-a', 'user-a', 'Byte bound',
                            :content, :digest, 'sanitized-html-v1', :created_at
                        )
                        """
                    ),
                    {
                        "content": oversized,
                        "digest": draft_content_sha256(oversized),
                        "created_at": now,
                    },
                )
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "database_url",
    ["sqlite:///offline-m9.sqlite3", "postgresql+psycopg://u:p@db/aperture"],
)
def test_m9_offline_upgrade_and_downgrade_render_for_both_dialects(
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
    assert "20260720_0008" in upgrade_sql
    assert "CREATE TABLE matters" in upgrade_sql
    assert "CREATE TABLE draft_revisions" in upgrade_sql
    assert "octet_length(content) <= 2000000" in upgrade_sql
    assert "matter_id" in upgrade_sql
    assert "DROP TABLE matters" in downgrade_sql
