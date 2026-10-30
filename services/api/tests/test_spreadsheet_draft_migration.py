from __future__ import annotations

import json
import sqlite3
from io import StringIO
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.db.engine import alembic_config, create_application_engine, upgrade_database
from app.models.deck_document import canonicalize_deck_json
from app.repositories.matters import DraftConflict, MatterDraftRepository

BEFORE = "20261021_0027"
AFTER = "20261029_0028"
TENANT = "tenant-test"
OWNER = "user-test"


def _workbook(label: str) -> str:
    return json.dumps({"sheets": [{"name": "Plan", "cells": {"A1": {"v": label}, "A2": {"v": 42}}}]})


def _deck(title: str) -> str:
    return json.dumps({"schema": "aperture-deck-v1", "title": title, "slides": [{"layout": "title", "title": title}]})


def _engine(tmp_path: Path, revision: str) -> Engine:
    engine = create_application_engine(f"sqlite:///{tmp_path / 'spreadsheet-migration.sqlite3'}")
    upgrade_database(engine, revision)
    return engine


def _seed_documents_and_decks(engine: Engine) -> None:
    repository = MatterDraftRepository(engine)
    for draft_id, kind, contents in (
        ("draft-memo", "document", ["<p>First memo.</p>", "<p>Second memo.</p>", "<p>Third memo.</p>"]),
        ("draft-deck", "deck", [_deck("Kickoff"), _deck("Kickoff v2")]),
    ):
        repository.create_draft(
            tenant_id=TENANT, owner_user_id=OWNER, draft_id=draft_id, title=draft_id, content=contents[0], kind=kind
        )
        for revision, content in enumerate(contents[1:], start=1):
            repository.update_draft(
                draft_id, tenant_id=TENANT, owner_user_id=OWNER, expected_revision=revision, content=content
            )


def _rows(engine: Engine, table: str) -> list[tuple[object, ...]]:
    order = "id" if table == "draft_documents" else "draft_id, revision"
    with engine.connect() as connection:
        return [tuple(row) for row in connection.execute(text(f"SELECT * FROM {table} ORDER BY {order}"))]


def _migrate(engine: Engine, direction: str, revision: str) -> int:
    """Run one migration on a single connection and report its foreign_keys pragma afterwards."""

    config = alembic_config()
    with engine.connect() as connection:
        with connection.begin():
            config.attributes["connection"] = connection
            getattr(command, direction)(config, revision)
        return connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one()


def _table_sql(engine: Engine, table: str) -> str:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = :name"), {"name": table}
        ).scalar_one()


def _create_sql(engine: Engine) -> dict[str, str]:
    """CREATE TABLE text of both draft tables, ignoring the quoting a rename adds."""

    return {
        table: _table_sql(engine, table).replace(f'CREATE TABLE "{table}"', f"CREATE TABLE {table}")
        for table in ("draft_documents", "draft_revisions")
    }


def _indexes(engine: Engine) -> set[str]:
    with engine.connect() as connection:
        return set(
            connection.execute(
                text("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'draft_%' AND sql IS NOT NULL")
            ).scalars()
        )


def test_upgrade_keeps_every_revision_byte_identical_and_foreign_keys_on(tmp_path: Path) -> None:
    engine = _engine(tmp_path, BEFORE)
    _seed_documents_and_decks(engine)
    documents, revisions, indexes = _rows(engine, "draft_documents"), _rows(engine, "draft_revisions"), _indexes(engine)
    before = _create_sql(engine)
    assert len(revisions) == 5

    assert _migrate(engine, "upgrade", AFTER) == 1

    assert _rows(engine, "draft_revisions") == revisions
    assert _rows(engine, "draft_documents") == documents
    assert _indexes(engine) == indexes
    # Only the IN-lists change; the kind CHECK stays inline on its column.
    assert _create_sql(engine) == {
        "draft_documents": before["draft_documents"].replace(
            "CHECK (kind IN ('document', 'deck'))", "CHECK (kind IN ('document', 'deck', 'spreadsheet'))"
        ),
        "draft_revisions": before["draft_revisions"].replace(
            "'deck-json-v1'))", "'deck-json-v1', 'sheet-json-v1'))"
        ),
    }
    assert "NOT NULL CONSTRAINT ck_draft_documents_kind_valid CHECK (kind IN" in _table_sql(engine, "draft_documents")
    with engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
        assert connection.exec_driver_sql("PRAGMA integrity_check").scalar_one() == "ok"

    # Spreadsheets now store and revise with CAS; old drafts still read back.
    repository = MatterDraftRepository(engine)
    created = repository.create_draft(
        tenant_id=TENANT, owner_user_id=OWNER, draft_id="draft-sheet", title="Budget", content=_workbook("Revenue"),
        kind="spreadsheet",
    )
    assert created.revision.sanitizer_version == "sheet-json-v1"
    with pytest.raises(DraftConflict):
        repository.update_draft("draft-sheet", tenant_id=TENANT, owner_user_id=OWNER, expected_revision=2, content=_workbook("Costs"))
    revised = repository.update_draft(
        "draft-sheet", tenant_id=TENANT, owner_user_id=OWNER, expected_revision=1, content=_workbook("Costs")
    )
    assert revised.document.current_revision == 2
    assert '"v":"Costs"' in revised.revision.content
    deck = repository.get_draft("draft-deck", tenant_id=TENANT, owner_user_id=OWNER)
    assert deck.revision.content == canonicalize_deck_json(_deck("Kickoff v2"))

    # The parent rebuild kept the cascade: deleting a draft still removes its revisions.
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM draft_documents WHERE id = 'draft-memo'"))
    assert [row[0] for row in _rows(engine, "draft_revisions")].count("draft-memo") == 0
    engine.dispose()


def test_upgrade_rolls_back_and_restores_foreign_keys_when_the_check_finds_orphans(tmp_path: Path) -> None:
    engine = _engine(tmp_path, BEFORE)
    _seed_documents_and_decks(engine)
    # An orphan revision written behind the application's back (raw sqlite3
    # leaves foreign keys off) must stop the rebuild instead of being copied.
    raw = sqlite3.connect(tmp_path / "spreadsheet-migration.sqlite3")
    raw.create_function("octet_length", 1, lambda value: len(str(value).encode("utf-8")))
    raw.execute(
        "INSERT INTO draft_revisions SELECT 'draft-gone', revision, tenant_id, owner_user_id, title, content, "
        "content_sha256, sanitizer_version, created_at FROM draft_revisions WHERE draft_id = 'draft-memo' AND revision = 1"
    )
    raw.commit()
    raw.close()
    before_sql = _table_sql(engine, "draft_documents")
    revisions = _rows(engine, "draft_revisions")

    config = alembic_config()
    with engine.connect() as connection:
        with pytest.raises(RuntimeError, match="foreign key"):
            with connection.begin():
                config.attributes["connection"] = connection
                command.upgrade(config, AFTER)
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1

    assert _table_sql(engine, "draft_documents") == before_sql
    assert _rows(engine, "draft_revisions") == revisions
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == BEFORE
    engine.dispose()


def test_rerunning_an_interrupted_upgrade_leaves_the_rebuilt_tables_alone(tmp_path: Path) -> None:
    engine = _engine(tmp_path, AFTER)
    _seed_documents_and_decks(engine)
    rebuilt, revisions = _create_sql(engine), _rows(engine, "draft_revisions")
    # A crash after the rebuild committed but before the version stamp.
    with engine.begin() as connection:
        connection.execute(text("UPDATE alembic_version SET version_num = :before"), {"before": BEFORE})

    assert _migrate(engine, "upgrade", AFTER) == 1

    assert _create_sql(engine) == rebuilt
    assert _rows(engine, "draft_revisions") == revisions
    engine.dispose()


def test_an_unexpected_table_shape_is_refused_untouched(tmp_path: Path) -> None:
    engine = _engine(tmp_path, BEFORE)
    _seed_documents_and_decks(engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE stray (id INTEGER)"))
    raw = sqlite3.connect(tmp_path / "spreadsheet-migration.sqlite3")
    raw.execute("PRAGMA writable_schema=ON")
    raw.execute(
        "UPDATE sqlite_master SET sql = replace(sql, \"'deck'))\", \"'deck', 'poster'))\") WHERE name = 'draft_documents'"
    )
    raw.commit()
    raw.close()
    reshaped, revisions = _create_sql(engine), _rows(engine, "draft_revisions")

    with pytest.raises(RuntimeError, match="Unexpected draft_documents schema"):
        _migrate(engine, "upgrade", AFTER)

    assert _create_sql(engine) == reshaped
    assert _rows(engine, "draft_revisions") == revisions
    engine.dispose()


def test_downgrade_without_spreadsheets_restores_the_old_constraints(tmp_path: Path) -> None:
    engine = _engine(tmp_path, BEFORE)
    expected_sql = _create_sql(engine)
    assert _migrate(engine, "upgrade", AFTER) == 1
    _seed_documents_and_decks(engine)
    documents, revisions = _rows(engine, "draft_documents"), _rows(engine, "draft_revisions")

    assert _migrate(engine, "downgrade", BEFORE) == 1

    assert _rows(engine, "draft_revisions") == revisions
    assert _rows(engine, "draft_documents") == documents
    assert _create_sql(engine) == expected_sql
    with pytest.raises(IntegrityError):
        with engine.begin() as connection:
            connection.execute(text("UPDATE draft_documents SET kind = 'spreadsheet' WHERE id = 'draft-memo'"))
    # Rolling forward again works on the same file.
    assert _migrate(engine, "upgrade", AFTER) == 1
    assert _rows(engine, "draft_revisions") == revisions
    engine.dispose()


def test_downgrade_refuses_while_spreadsheets_exist(tmp_path: Path) -> None:
    engine = _engine(tmp_path, AFTER)
    repository = MatterDraftRepository(engine)
    repository.create_draft(
        tenant_id=TENANT, owner_user_id=OWNER, draft_id="draft-sheet", title="Budget", content=_workbook("Revenue"),
        kind="spreadsheet",
    )
    revisions = _rows(engine, "draft_revisions")

    with pytest.raises(RuntimeError, match="1 spreadsheet draft"):
        _migrate(engine, "downgrade", BEFORE)

    assert _rows(engine, "draft_revisions") == revisions
    assert "'spreadsheet'" in _table_sql(engine, "draft_documents")
    assert repository.get_draft("draft-sheet", tenant_id=TENANT, owner_user_id=OWNER).document.kind == "spreadsheet"
    engine.dispose()


def _render_postgres(monkeypatch: pytest.MonkeyPatch, direction: str, span: str) -> str:
    output = StringIO()
    monkeypatch.setenv("APERTURE_DATABASE_URL", "postgresql://offline.invalid/aperture")
    get_settings.cache_clear()
    config = alembic_config()
    config.output_buffer = output
    try:
        getattr(command, direction)(config, span, sql=True)
    finally:
        get_settings.cache_clear()
    return output.getvalue()


def test_postgres_replaces_the_named_checks_in_place(monkeypatch: pytest.MonkeyPatch) -> None:
    upgrade = _render_postgres(monkeypatch, "upgrade", f"{BEFORE}:{AFTER}")
    assert "ALTER TABLE draft_documents DROP CONSTRAINT ck_draft_documents_kind_valid;" in upgrade
    assert (
        "ALTER TABLE draft_documents ADD CONSTRAINT ck_draft_documents_kind_valid "
        "CHECK (kind IN ('document', 'deck', 'spreadsheet'));"
    ) in upgrade
    assert "ALTER TABLE draft_revisions DROP CONSTRAINT ck_draft_revisions_sanitizer_version_known;" in upgrade
    assert (
        "ALTER TABLE draft_revisions ADD CONSTRAINT ck_draft_revisions_sanitizer_version_known "
        "CHECK (sanitizer_version IN ('sanitized-html-v1', 'deck-json-v1', 'sheet-json-v1'));"
    ) in upgrade
    assert "_alembic_tmp" not in upgrade and "PRAGMA" not in upgrade

    downgrade = _render_postgres(monkeypatch, "downgrade", f"{AFTER}:{BEFORE}")
    assert "CHECK (kind IN ('document', 'deck'));" in downgrade
    assert "CHECK (sanitizer_version IN ('sanitized-html-v1', 'deck-json-v1'));" in downgrade
