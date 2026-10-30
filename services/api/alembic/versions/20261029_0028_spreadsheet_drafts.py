"""Store spreadsheets server-side alongside documents and decks.

Widens ``draft_documents.kind`` to ``spreadsheet`` and lets a revision carry
canonical workbook JSON under the ``sheet-json-v1`` sanitizer id. Spreadsheets
share the 8,000,000-byte ceiling decks already use, so that CHECK is unchanged.

PostgreSQL drops and recreates the two named CHECK constraints in place.

SQLite cannot alter a CHECK, so both tables are rebuilt with SQLite's 12-step
procedure from their stored ``CREATE TABLE`` text with only the IN-list
changed; the kind CHECK stays inline on its column, which 0020's downgrade
relies on to drop that column. Dropping the parent table while foreign keys are
on would cascade-delete every revision, and ``PRAGMA foreign_keys`` is a no-op
inside a transaction. The SQLite path therefore commits the work already done
in this run, turns foreign keys off, rebuilds both tables inside one explicit
transaction, commits only if ``PRAGMA foreign_key_check`` is empty, and turns
foreign keys back on whatever happens. A table that already has the target
constraint is left alone, so a crash between that commit and the version stamp
is repaired by running the upgrade again.

Downgrade refuses while any spreadsheet rows exist because they would violate
the restored constraints; roll forward instead.

Revision ID: 20261029_0028
Revises: 20261021_0027
Create Date: 2026-10-29
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager

import sqlalchemy as sa
from alembic import op


revision: str = "20261029_0028"
down_revision: str | None = "20261021_0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (table, constraint, CHECK before this revision, CHECK after it)
_CHECKS = (
    (
        "draft_documents",
        "ck_draft_documents_kind_valid",
        "kind IN ('document', 'deck')",
        "kind IN ('document', 'deck', 'spreadsheet')",
    ),
    (
        "draft_revisions",
        "ck_draft_revisions_sanitizer_version_known",
        "sanitizer_version IN ('sanitized-html-v1', 'deck-json-v1')",
        "sanitizer_version IN ('sanitized-html-v1', 'deck-json-v1', 'sheet-json-v1')",
    ),
)


def upgrade() -> None:
    _replace_checks([(table, name, before, after) for table, name, before, after in _CHECKS])


def downgrade() -> None:
    if not op.get_context().as_sql:
        spreadsheets = op.get_bind().execute(
            sa.text("SELECT count(*) FROM draft_documents WHERE kind = 'spreadsheet'")
        ).scalar_one()
        if spreadsheets:
            raise RuntimeError(
                f"Cannot downgrade: {spreadsheets} spreadsheet draft(s) would violate the "
                "restored document-and-deck constraints. Roll forward instead."
            )
    _replace_checks([(table, name, after, before) for table, name, before, after in _CHECKS])


def _replace_checks(swaps: list[tuple[str, str, str, str]]) -> None:
    if op.get_context().dialect.name == "sqlite":
        with _sqlite_foreign_keys_off() as connection:
            for table, _name, current, target in swaps:
                _rebuild_sqlite_table(connection, table, current, target)
        return
    for table, name, _current, target in swaps:
        op.drop_constraint(op.f(name), table, type_="check")
        op.create_check_constraint(op.f(name), table, target)


@contextmanager
def _sqlite_foreign_keys_off() -> Iterator[sqlite3.Connection]:
    """One explicit transaction with foreign keys off, as SQLite's ALTER TABLE guide prescribes."""

    connection = op.get_bind().connection.dbapi_connection
    previous_autocommit = connection.autocommit
    connection.autocommit = True  # commits the work already done in this run
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        if connection.execute("PRAGMA foreign_keys").fetchone()[0] != 0:
            raise RuntimeError("Could not suspend foreign keys; refusing to rebuild draft tables.")
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
            orphans = connection.execute("PRAGMA foreign_key_check").fetchall()
            if orphans:
                raise RuntimeError(
                    f"Draft table rebuild found {len(orphans)} foreign key violation(s); rolled back."
                )
            connection.execute("COMMIT")
        except BaseException:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
    finally:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.autocommit = previous_autocommit


def _rebuild_sqlite_table(connection: sqlite3.Connection, table: str, current: str, target: str) -> None:
    (create,) = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if current not in create and create.count(target) == 1:
        return  # already rebuilt by an earlier, interrupted run
    staging = f"_{table}_0028"
    staged, renamed = re.subn(rf'^CREATE TABLE "?{table}"? ', f"CREATE TABLE {staging} ", create)
    if create.count(current) != 1 or renamed != 1:
        raise RuntimeError(f"Unexpected {table} schema; refusing to rebuild it.")
    indexes = [
        sql
        for (sql,) in connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", (table,)
        )
    ]
    connection.execute(staged.replace(current, target))
    connection.execute(f"INSERT INTO {staging} SELECT * FROM {table}")
    connection.execute(f"DROP TABLE {table}")
    connection.execute(f"ALTER TABLE {staging} RENAME TO {table}")
    for sql in indexes:
        connection.execute(sql)
