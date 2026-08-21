from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Lock, RLock
from typing import Any
from weakref import WeakKeyDictionary

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool


# The receipt schema is immutable: later linear migrations may advance HEAD
# without invalidating a completed v2 -> v3 application-state import.
APPLICATION_STATE_IMPORT_REVISION = "20260720_0003"
CHAT_STATE_IMPORT_REVISION = "20260720_0004"
IDENTITY_CONFIG_IMPORT_REVISION = "20260720_0009"
IDENTITY_CLEANUP_REVISION = "20260720_0010"
PRINCIPAL_USAGE_BUDGETS_REVISION = "20260721_0011"
GRANULAR_USAGE_BUDGETS_REVISION = "20260721_0012"
ALERT_NOTIFICATION_ARCHIVED_REVISION = "20260731_0013"
USER_MEMORIES_REVISION = "20260802_0014"
SESSION_AUTH_METHOD_REVISION = "20260807_0015"
CHAT_RETENTION_REVISION = "20260816_0016"
CHAT_FEEDBACK_REVISION = "20260817_0017"
ISSUE_REPORTS_REVISION = "20260820_0018"
HEAD_REVISION = ISSUE_REPORTS_REVISION
_API_ROOT = Path(__file__).resolve().parents[2]
_MIGRATION_LOCK = Lock()

_ENGINE_WRITE_LOCKS: "WeakKeyDictionary[Engine, RLock]" = WeakKeyDictionary()
_ENGINE_WRITE_LOCKS_GUARD = Lock()


def engine_write_lock(engine: Engine) -> RLock:
    """Return the one write mutex shared by every writer on ``engine``.

    SQLite starts ``BEGIN`` deferred, so a transaction that reads before it
    writes only takes the write lock on its first INSERT/UPDATE. If another
    connection committed in between, SQLite fails that upgrade with
    ``SQLITE_BUSY_SNAPSHOT`` *immediately* and ignores ``busy_timeout`` --
    retrying the statement can never succeed, only retrying the whole
    transaction can. Repositories used to hold private locks, so each
    serialized against itself while still colliding with the others on one
    database file. Funnelling every writer through a single per-engine lock
    removes that collision in-process; the retry loops around it remain for
    genuinely out-of-process writers such as migrations.
    """
    with _ENGINE_WRITE_LOCKS_GUARD:
        lock = _ENGINE_WRITE_LOCKS.get(engine)
        if lock is None:
            lock = RLock()
            _ENGINE_WRITE_LOCKS[engine] = lock
        return lock


def _strict_json_serializer(value: Any) -> str:
    return json.dumps(value, allow_nan=False)


def _sqlite_octet_length(value: Any) -> int | None:
    """SQLite equivalent of Postgres octet_length for portable byte caps."""
    if value is None:
        return None
    if isinstance(value, bytes):
        return len(value)
    return len(str(value).encode("utf-8"))


def _run_sqlite_pragmas(dbapi_connection: Any, statements: tuple[str, ...]) -> None:
    previous_autocommit = dbapi_connection.autocommit
    dbapi_connection.autocommit = True
    try:
        cursor = dbapi_connection.cursor()
        try:
            for statement in statements:
                cursor.execute(statement)
        finally:
            cursor.close()
    finally:
        dbapi_connection.autocommit = previous_autocommit


def create_application_engine(database_url: str, *, echo: bool = False) -> Engine:
    """Create a SQLAlchemy engine with safe SQLite concurrency defaults."""
    url = make_url(database_url)
    kwargs: dict[str, Any] = {
        "echo": echo,
        "json_serializer": _strict_json_serializer,
        "pool_pre_ping": True,
    }
    if url.get_backend_name() == "sqlite":
        kwargs["connect_args"] = {
            "autocommit": False,
            "check_same_thread": False,
            "timeout": 30.0,
        }
        if url.database in {None, "", ":memory:"}:
            kwargs["poolclass"] = StaticPool
        elif not url.database.startswith("file:"):
            Path(url.database).expanduser().parent.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, **kwargs)
    if url.get_backend_name() == "sqlite":
        is_memory = url.database in {None, "", ":memory:"}

        @event.listens_for(engine, "first_connect")
        def _configure_sqlite_journal(dbapi_connection: Any, _connection_record: Any) -> None:
            if not is_memory:
                _run_sqlite_pragmas(dbapi_connection, ("PRAGMA journal_mode=WAL",))

        @event.listens_for(engine, "connect")
        def _configure_sqlite(dbapi_connection: Any, _connection_record: Any) -> None:
            dbapi_connection.create_function(
                "octet_length",
                1,
                _sqlite_octet_length,
                deterministic=True,
            )
            _run_sqlite_pragmas(
                dbapi_connection,
                (
                    "PRAGMA foreign_keys=ON",
                    "PRAGMA busy_timeout=30000",
                    "PRAGMA synchronous=NORMAL",
                ),
            )

    return engine


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


@contextmanager
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    session = factory()
    try:
        with session.begin():
            yield session
    finally:
        session.close()


def alembic_config() -> Config:
    config = Config(str(_API_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(_API_ROOT / "alembic"))
    return config


def upgrade_database(engine: Engine, revision: str = "head") -> None:
    """Run Alembic migrations through an existing, already-configured engine."""
    # Alembic's EnvironmentContext installs module-level proxies and is not
    # thread-safe. Serialize in-process startup/import callers around it.
    with _MIGRATION_LOCK:
        config = alembic_config()
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, revision)


def current_schema_revision(engine: Engine) -> str | None:
    if "alembic_version" not in inspect(engine).get_table_names():
        return None
    with engine.connect() as connection:
        return connection.execute(
            text("select version_num from alembic_version")
        ).scalar_one_or_none()
