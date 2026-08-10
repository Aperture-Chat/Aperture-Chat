from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import sqlite3
import stat
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import UTC, date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic.script import ScriptDirectory
from sqlalchemy import MetaData, Table, create_engine, func, inspect, select, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool

from app.db.engine import alembic_config, create_application_engine, upgrade_database
from app.db.orm import Base


TRANSFER_FORMAT_VERSION = 1
_ALEMBIC_VERSION_TABLE = "alembic_version"
_EXCLUDED_TABLES = frozenset({_ALEMBIC_VERSION_TABLE})
_POSTGRES_TRANSFER_LOCK = "aperture-sqlite-postgres-transfer-v1"
_RECEIPT_TYPE = "aperture-sqlite-postgres-transfer"
_CHECK_TOKEN_PATTERN = re.compile(
    r"'(?:''|[^'])*'|!~~\*|~~\*|!~~|~~|>=|<=|<>|!=|=|>|<|"
    r"\(|\)|\[|\]|,|\|\||\+|-|\*|/|%|"
    r"[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?"
)
_CHECK_STRING_LITERAL_PATTERN = re.compile(r"'(?:''|[^'])*'")
_CHECK_LITERAL_SENTINEL_PATTERN = re.compile(r"\x00aperture_check_literal_(\d+)\x00")
_POSTGRES_CAST_PATTERN = re.compile(
    r"::\s*(?:character\s+varying|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|"
    r"double\s+precision|smallint|bigint|integer|boolean|text|date|time|numeric|"
    r"jsonb?|uuid)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s*\[\s*\])?",
    flags=re.IGNORECASE,
)
_POSTGRES_PROTECTED_NUMERIC_CAST_LITERAL_PATTERN = re.compile(
    r"\x00aperture_check_literal_(\d+)\x00\s*::\s*"
    r"(?:smallint|bigint|integer|numeric)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?",
    flags=re.IGNORECASE,
)
_POSTGRES_NEXTVAL_DEFAULT_PATTERN = re.compile(
    r"^nextval\(\s*'(?:''|[^'])*'\s*::\s*regclass\s*\)$",
    flags=re.IGNORECASE,
)


class DatabaseTransferError(RuntimeError):
    """Raised when a database transfer cannot be proven complete and lossless."""


@dataclass(frozen=True, slots=True)
class TableManifest:
    columns: tuple[str, ...]
    column_types: tuple[str, ...]
    primary_key: tuple[str, ...]
    nullable: tuple[bool, ...]
    server_defaults: tuple[str, ...]
    generations: tuple[str, ...]
    constraints: tuple[str, ...]
    checks: tuple[str, ...]
    indexes: tuple[str, ...]
    row_count: int
    content_digest: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "columns": list(self.columns),
            "column_types": list(self.column_types),
            "primary_key": list(self.primary_key),
            "nullable": list(self.nullable),
            "server_defaults": list(self.server_defaults),
            "generations": list(self.generations),
            "constraints": list(self.constraints),
            "checks": list(self.checks),
            "indexes": list(self.indexes),
            "row_count": self.row_count,
            "content_digest": self.content_digest,
        }


@dataclass(frozen=True, slots=True)
class DatabaseManifest:
    schema_revision: str
    tables: dict[str, TableManifest]
    sequence_watermarks: dict[str, int]
    source_digest: str

    @property
    def row_count(self) -> int:
        return sum(item.row_count for item in self.tables.values())

    def receipt_payload(self) -> dict[str, Any]:
        return {
            "format_version": TRANSFER_FORMAT_VERSION,
            "schema_revision": self.schema_revision,
            "source_digest": self.source_digest,
            "sequence_watermarks": dict(sorted(self.sequence_watermarks.items())),
            "tables": {name: self.tables[name].to_dict() for name in sorted(self.tables)},
        }


@dataclass(frozen=True, slots=True)
class TransferReport:
    mode: str
    status: str
    source_digest: str
    source_schema_revision: str
    target_schema_revision: str | None
    table_count: int
    row_count: int
    receipt_persisted: bool
    table_manifest: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class _SourceSnapshot:
    connection: Connection
    observer_connection: Connection
    metadata: MetaData
    manifest: DatabaseManifest
    data_version: int


def migration_head_revision() -> str:
    """Return the sole live Alembic head without coupling A8 to a revision ID."""

    heads = ScriptDirectory.from_config(alembic_config()).get_heads()
    if len(heads) != 1:
        raise DatabaseTransferError(
            "The migration tree must have exactly one head before a database transfer; "
            f"found {len(heads)}."
        )
    return heads[0]


def create_readonly_sqlite_engine(database_path: str | Path) -> Engine:
    """Open an existing SQLite database through a query-only URI connection."""

    supplied_path = Path(database_path).expanduser()
    try:
        supplied_status = supplied_path.lstat()
    except OSError as exc:
        raise DatabaseTransferError(f"SQLite source is not readable: {exc}") from exc
    if stat.S_ISLNK(supplied_status.st_mode) or not stat.S_ISREG(supplied_status.st_mode):
        raise DatabaseTransferError(
            "SQLite source must be a regular file, never a symlink or device."
        )
    try:
        path = supplied_path.resolve(strict=True)
        resolved_status = path.stat()
    except OSError as exc:
        raise DatabaseTransferError(f"SQLite source is not readable: {exc}") from exc
    if (
        not stat.S_ISREG(resolved_status.st_mode)
        or resolved_status.st_size == 0
        or (resolved_status.st_dev, resolved_status.st_ino)
        != (supplied_status.st_dev, supplied_status.st_ino)
    ):
        raise DatabaseTransferError(
            "SQLite source must be one unchanged, existing, non-empty regular file."
        )

    uri = f"file:{quote(path.as_posix(), safe='/')}?mode=ro"
    immutable_uri = f"{uri}&immutable=1"

    def _open(candidate_uri: str) -> sqlite3.Connection:
        connection = sqlite3.connect(
            candidate_uri,
            uri=True,
            check_same_thread=False,
            timeout=30.0,
            autocommit=False,
        )
        try:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA foreign_keys=ON")
            # Touch the schema now. A WAL-mode database on a read-only mount can
            # connect successfully and fail only when SQLite tries to create
            # its shared-memory sidecar on the first real database read.
            connection.execute("SELECT 1 FROM sqlite_schema LIMIT 1").fetchone()
        except Exception:
            connection.close()
            raise
        return connection

    def _connect() -> sqlite3.Connection:
        try:
            return _open(uri)
        except sqlite3.OperationalError as exc:
            message = str(exc).lower()
            if not any(
                marker in message
                for marker in (
                    "unable to open database file",
                    "attempt to write a readonly database",
                )
            ):
                raise
            wal_path = path.with_name(f"{path.name}-wal")
            try:
                wal_size = wal_path.stat().st_size
            except FileNotFoundError:
                wal_size = 0
            except OSError as wal_exc:
                raise DatabaseTransferError(
                    "SQLite source WAL state could not be verified on the read-only mount."
                ) from wal_exc
            if wal_size:
                raise DatabaseTransferError(
                    "Frozen read-only SQLite source still has a non-empty WAL sidecar; "
                    "checkpoint it while all writers are stopped before transfer."
                ) from exc
            # A stopped, checkpointed WAL database can still require a new
            # ``-shm`` file merely to read. The release runbook intentionally
            # mounts the restored source volume read-only, so fall back to the
            # immutable URI only after the ordinary observable connection
            # fails and only when no WAL content could be ignored.
            return _open(immutable_uri)

    return create_engine(
        "sqlite+pysqlite://",
        creator=_connect,
        poolclass=NullPool,
        json_serializer=_strict_json,
        pool_pre_ping=True,
    )


def _strict_json(value: Any) -> str:
    return json.dumps(value, allow_nan=False, separators=(",", ":"), sort_keys=True)


def _canonical_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise DatabaseTransferError("Database rows contain a non-finite floating-point value.")
        return {"$float": repr(value)}
    if isinstance(value, datetime):
        normalized = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
        return {"$datetime": normalized.isoformat(timespec="microseconds")}
    if isinstance(value, date):
        return {"$date": value.isoformat()}
    if isinstance(value, time):
        return {"$time": value.isoformat(timespec="microseconds")}
    if isinstance(value, Decimal):
        return {"$decimal": str(value)}
    if isinstance(value, UUID):
        return {"$uuid": str(value)}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"$bytes": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, Mapping):
        normalized: dict[str, Any] = {}
        for key in sorted(value, key=lambda candidate: str(candidate)):
            if not isinstance(key, str):
                raise DatabaseTransferError("JSON objects in database rows must use string keys.")
            normalized[key] = _canonical_value(value[key])
        return normalized
    if isinstance(value, (list, tuple)):
        return [_canonical_value(item) for item in value]
    raise DatabaseTransferError(
        f"Database rows contain an unsupported value type: {type(value).__name__}."
    )


def _application_table_names(connection: Connection) -> tuple[str, ...]:
    names = {
        name
        for name in inspect(connection).get_table_names()
        if name not in _EXCLUDED_TABLES and not name.startswith("sqlite_")
    }
    return tuple(sorted(names))


def _schema_revision(connection: Connection) -> str | None:
    if _ALEMBIC_VERSION_TABLE not in inspect(connection).get_table_names():
        return None
    revisions = (
        connection.execute(text(f"SELECT version_num FROM {_ALEMBIC_VERSION_TABLE}"))
        .scalars()
        .all()
    )
    if len(revisions) != 1:
        raise DatabaseTransferError(
            "The database must contain exactly one Alembic revision before transfer."
        )
    return str(revisions[0])


def _reflect_tables(connection: Connection, names: Sequence[str]) -> MetaData:
    metadata = MetaData()
    if names:
        metadata.reflect(bind=connection, only=list(names))
    return metadata


def _authoritative_column_type(
    table_name: str,
    column_name: str,
) -> sa.types.TypeEngine[Any] | None:
    table = Base.metadata.tables.get(table_name)
    if table is None or column_name not in table.c:
        return None
    return table.c[column_name].type


def _type_family(
    column_type: sa.types.TypeEngine[Any],
    *,
    dialect_name: str | None = None,
    expected_type: sa.types.TypeEngine[Any] | None = None,
) -> str:
    """Return a cross-dialect family for supported application columns."""

    if isinstance(column_type, sa.JSON):
        expected_jsonb = (
            expected_type is not None and type(expected_type).__name__.upper() == "JSONB"
        )
        actual_jsonb = type(column_type).__name__.upper() == "JSONB"
        if actual_jsonb or (dialect_name == "sqlite" and expected_jsonb):
            return "jsonb"
        return "json"
    if isinstance(column_type, sa.Boolean):
        return "boolean"
    if isinstance(column_type, sa.DateTime):
        expected_timezone = getattr(expected_type, "timezone", None)
        if expected_timezone is None and expected_type is not None:
            expected_timezone = getattr(getattr(expected_type, "impl", None), "timezone", None)
        timezone = (
            bool(expected_timezone)
            if dialect_name == "sqlite" and expected_type is not None
            else bool(column_type.timezone)
        )
        return f"datetime:{'timezone' if timezone else 'naive'}"
    if isinstance(column_type, sa.Date):
        return "date"
    if isinstance(column_type, sa.Time):
        return "time"
    if isinstance(column_type, sa.LargeBinary):
        return "binary"
    if isinstance(column_type, sa.Text):
        return "text"
    if isinstance(column_type, sa.String):
        length = column_type.length
        return f"string:{length if length is not None else '*'}"
    if isinstance(column_type, sa.BigInteger):
        return "bigint"
    if isinstance(column_type, sa.SmallInteger):
        return "smallint"
    if isinstance(column_type, sa.Integer):
        sqlite_variant = (
            getattr(expected_type, "_variant_mapping", {}).get("sqlite")
            if expected_type is not None
            else None
        )
        if (
            dialect_name == "sqlite"
            and isinstance(expected_type, sa.BigInteger)
            and isinstance(sqlite_variant, sa.Integer)
        ):
            # AUTOINCREMENT requires the exact `INTEGER PRIMARY KEY` spelling
            # on SQLite, while the authoritative/current-head type is BIGINT.
            return "bigint"
        return "integer"
    if isinstance(column_type, sa.Numeric):
        precision = column_type.precision
        scale = column_type.scale
        return (
            f"numeric:{precision if precision is not None else '*'}:"
            f"{scale if scale is not None else '*'}"
        )
    if isinstance(column_type, sa.Float):
        return "float"
    raise DatabaseTransferError(
        f"Column type {type(column_type).__name__!r} has no safe transfer family."
    )


def _strip_wrapping_parentheses(tokens: list[str]) -> list[str]:
    while len(tokens) >= 2 and tokens[0] == "(":
        depth = 0
        matching_index: int | None = None
        for index, token in enumerate(tokens):
            if token == "(":
                depth += 1
            elif token == ")":
                depth -= 1
                if depth == 0:
                    matching_index = index
                    break
        if matching_index != len(tokens) - 1:
            break
        tokens = tokens[1:-1]
    return tokens


def _contains_top_level(tokens: Sequence[str], candidates: set[str]) -> bool:
    depth = 0
    for token in tokens:
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
        elif depth == 0 and token in candidates:
            return True
    return False


def _normalize_check_parentheses(tokens: list[str]) -> list[str]:
    tokens = _strip_wrapping_parentheses(tokens)
    normalized: list[str] = []
    index = 0
    while index < len(tokens):
        if tokens[index] != "(":
            normalized.append(tokens[index])
            index += 1
            continue
        depth = 1
        closing_index = index + 1
        while closing_index < len(tokens) and depth:
            if tokens[closing_index] == "(":
                depth += 1
            elif tokens[closing_index] == ")":
                depth -= 1
            closing_index += 1
        if depth:
            raise DatabaseTransferError("A check constraint contains unbalanced parentheses.")
        inner = _normalize_check_parentheses(tokens[index + 1 : closing_index - 1])
        previous = normalized[-1] if normalized else None
        following = tokens[closing_index] if closing_index < len(tokens) else None
        function_call = bool(
            previous
            and re.fullmatch(r"[a-z_][a-z0-9_]*", previous)
            and previous not in {"and", "or", "not", "in", "is", "like", "ilike"}
        )
        arithmetic_group = _contains_top_level(inner, {"+", "-", "*", "/", "%"})
        comparison_operators = {"=", "<>", ">", "<", ">=", "<="}
        arithmetic_wrapper_is_redundant = arithmetic_group and (
            (previous in comparison_operators and following in {None, "and", "or", ")"})
            or (following in comparison_operators and previous in {None, "and", "or", "("})
        )
        preserves_semantics = (
            previous == "in"
            or function_call
            or _contains_top_level(inner, {"and", "or"})
            or (arithmetic_group and not arithmetic_wrapper_is_redundant)
        )
        if preserves_semantics:
            normalized.extend(["(", *inner, ")"])
        else:
            normalized.extend(inner)
        index = closing_index
    return _strip_wrapping_parentheses(normalized)


def _matching_parenthesis(tokens: Sequence[str], opening_index: int) -> int:
    depth = 0
    for index in range(opening_index, len(tokens)):
        if tokens[index] == "(":
            depth += 1
        elif tokens[index] == ")":
            depth -= 1
            if depth == 0:
                return index
    raise DatabaseTransferError("A check constraint contains unbalanced parentheses.")


def _normalize_postgres_array_membership(tokens: list[str]) -> list[str]:
    normalized: list[str] = []
    index = 0
    while index < len(tokens):
        operator_pair = tokens[index : index + 2]
        if (
            operator_pair in (["=", "any"], ["<>", "all"], ["!=", "all"])
            and index + 3 < len(tokens)
            and tokens[index + 2] == "("
        ):
            closing_index = _matching_parenthesis(tokens, index + 2)
            contents = _strip_wrapping_parentheses(tokens[index + 3 : closing_index])
            if len(contents) >= 3 and contents[:2] == ["array", "["] and contents[-1] == "]":
                membership = ["in"] if operator_pair == ["=", "any"] else ["not", "in"]
                normalized.extend([*membership, "(", *contents[2:-1], ")"])
                index = closing_index + 1
                continue
        normalized.append(tokens[index])
        index += 1
    return normalized


def _normalize_trim_syntax(tokens: list[str]) -> list[str]:
    normalized: list[str] = []
    index = 0
    while index < len(tokens):
        if tokens[index : index + 4] == ["trim", "(", "both", "from"]:
            closing_index = _matching_parenthesis(tokens, index + 1)
            normalized.extend(["trim", "(", *tokens[index + 4 : closing_index], ")"])
            index = closing_index + 1
            continue
        normalized.append("trim" if tokens[index] == "btrim" else tokens[index])
        index += 1
    return normalized


def _repair_reflected_boundary_parentheses(tokens: list[str]) -> list[str]:
    """Repair SQLAlchemy's PostgreSQL CHECK wrapper stripping at both ends."""

    depth = 0
    minimum_depth = 0
    for token in tokens:
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
            minimum_depth = min(minimum_depth, depth)
    if depth != 0:
        raise DatabaseTransferError("A check constraint contains unbalanced parentheses.")
    if minimum_depth < 0:
        wrappers = -minimum_depth
        return [*(["("] * wrappers), *tokens, *([")"] * wrappers)]
    return tokens


def _split_top_level_boolean(tokens: Sequence[str], operator: str) -> list[list[str]]:
    parts: list[list[str]] = []
    current: list[str] = []
    depth = 0
    for token in tokens:
        if token in {"(", "["}:
            depth += 1
        elif token in {
            ")",
            "]",
        }:
            depth -= 1
        if depth == 0 and token == operator:
            parts.append(current)
            current = []
        else:
            current.append(token)
    parts.append(current)
    return parts


def _canonical_boolean_expression(tokens: list[str]) -> str:
    tokens = _strip_wrapping_parentheses(tokens)
    for operator in ("or", "and"):
        parts = _split_top_level_boolean(tokens, operator)
        if len(parts) > 1:
            if any(not part for part in parts):
                raise DatabaseTransferError(
                    "A check constraint contains an incomplete boolean expression."
                )
            return (
                operator
                + "("
                + "|".join(_canonical_boolean_expression(part) for part in parts)
                + ")"
            )
    return " ".join(tokens)


def _canonical_check_expression(expression: Any) -> str:
    """Normalize current SQLite/PostgreSQL check rendering into semantic tokens."""

    literals: list[str] = []

    def _protect_literal(match: re.Match[str]) -> str:
        literals.append(match.group(0))
        return f"\x00aperture_check_literal_{len(literals) - 1}\x00"

    rendered = _CHECK_STRING_LITERAL_PATTERN.sub(_protect_literal, str(expression))

    def _normalize_numeric_cast(match: re.Match[str]) -> str:
        literal = literals[int(match.group(1))]
        value = literal[1:-1].replace("''", "'")
        if re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value):
            return value
        return match.group(0)

    rendered = _POSTGRES_PROTECTED_NUMERIC_CAST_LITERAL_PATTERN.sub(
        _normalize_numeric_cast,
        rendered,
    )
    rendered = _POSTGRES_CAST_PATTERN.sub("", rendered).replace('"', "")
    rendered = _CHECK_LITERAL_SENTINEL_PATTERN.sub(
        lambda match: literals[int(match.group(1))],
        rendered,
    )
    tokens: list[str] = []
    consumed = 0
    for match in _CHECK_TOKEN_PATTERN.finditer(rendered):
        if rendered[consumed : match.start()].strip():
            raise DatabaseTransferError(
                "A check constraint contains unsupported syntax and cannot be compared safely."
            )
        token = match.group(0)
        if token.startswith("'"):
            tokens.append(token)
        elif token == "~~":
            tokens.append("like")
        elif token == "!~~":
            tokens.extend(("not", "like"))
        elif token == "~~*":
            tokens.append("ilike")
        elif token == "!~~*":
            tokens.extend(("not", "ilike"))
        elif token == "!=":
            tokens.append("<>")
        else:
            tokens.append(token.lower())
        consumed = match.end()
    if rendered[consumed:].strip():
        raise DatabaseTransferError(
            "A check constraint contains unsupported syntax and cannot be compared safely."
        )
    if not tokens:
        raise DatabaseTransferError("A check constraint could not be normalized safely.")
    tokens = _repair_reflected_boundary_parentheses(tokens)
    tokens = _normalize_check_parentheses(
        _normalize_trim_syntax(_normalize_postgres_array_membership(tokens))
    )
    return _canonical_boolean_expression(tokens)


def _constraint_signatures(table: Table) -> tuple[str, ...]:
    signatures: list[str] = []
    for constraint in table.constraints:
        if isinstance(constraint, sa.UniqueConstraint):
            columns = ",".join(column.name for column in constraint.columns)
            signatures.append(f"unique:{columns}")
        elif isinstance(constraint, sa.ForeignKeyConstraint):
            local_columns = ",".join(column.name for column in constraint.columns)
            elements = tuple(constraint.elements)
            remote_table = elements[0].column.table.name if elements else ""
            remote_columns = ",".join(element.column.name for element in elements)
            ondelete = (constraint.ondelete or "").upper()
            onupdate = (constraint.onupdate or "").upper()
            signatures.append(
                f"foreign:{local_columns}->{remote_table}:{remote_columns}:"
                f"delete={ondelete}:update={onupdate}"
            )
    return tuple(sorted(signatures))


def _check_signatures(table: Table) -> tuple[str, ...]:
    return tuple(
        sorted(
            _canonical_check_expression(constraint.sqltext)
            for constraint in table.constraints
            if isinstance(constraint, sa.CheckConstraint)
        )
    )


def _index_expression_signature(expression: Any) -> str:
    if isinstance(expression, sa.Column):
        return f"column:{expression.name}"
    return "expression:" + _canonical_check_expression(expression)


def _index_signatures(table: Table, *, dialect_name: str) -> tuple[str, ...]:
    def _options(index: sa.Index) -> str:
        where: Any = None
        method = "btree"
        include: Sequence[str] = ()
        operator_classes: Mapping[str, Any] = {}
        nulls_not_distinct = False
        if dialect_name == "postgresql":
            options = index.dialect_options["postgresql"]
            where = options.get("where")
            method = str(options.get("using") or "btree").lower()
            include = tuple(str(item) for item in (options.get("include") or ()))
            operator_classes = options.get("ops") or {}
            nulls_not_distinct = bool(options.get("nulls_not_distinct"))
            unsupported = {
                key: value
                for key, value in {
                    "concurrently": options.get("concurrently"),
                    "tablespace": options.get("tablespace"),
                    "with": options.get("with"),
                }.items()
                if value not in (None, False, {}, ())
            }
            if unsupported:
                raise DatabaseTransferError(
                    f"Index {index.name!r} uses unsupported PostgreSQL options."
                )
        elif dialect_name == "sqlite":
            where = index.dialect_options["sqlite"].get("where")
        predicate = "none" if where is None else _canonical_check_expression(where)
        ops = ",".join(f"{key}:{operator_classes[key]}" for key in sorted(operator_classes))
        return (
            f"method={method}:where={predicate}:include={','.join(include)}:"
            f"ops={ops}:nulls_not_distinct={int(nulls_not_distinct)}"
        )

    return tuple(
        sorted(
            "index:"
            f"unique={int(bool(index.unique))}:"
            + ",".join(_index_expression_signature(item) for item in index.expressions)
            + ":"
            + _options(index)
            for index in table.indexes
        )
    )


def _ordered_table_columns(table: Table) -> tuple[sa.Column[Any], ...]:
    authoritative = Base.metadata.tables.get(table.name)
    if authoritative is None:
        return tuple(table.columns)
    authoritative_names = tuple(column.name for column in authoritative.columns)
    reflected_names = {column.name for column in table.columns}
    ordered_names = [name for name in authoritative_names if name in reflected_names]
    ordered_names.extend(
        column.name for column in table.columns if column.name not in authoritative_names
    )
    return tuple(table.c[name] for name in ordered_names)


def _ordered_primary_key(table: Table) -> tuple[str, ...]:
    reflected_names = tuple(column.name for column in table.primary_key.columns)
    authoritative = Base.metadata.tables.get(table.name)
    if authoritative is not None:
        authoritative_names = tuple(column.name for column in authoritative.primary_key.columns)
        reflected_set = set(reflected_names)
        ordered = [name for name in authoritative_names if name in reflected_set]
        ordered.extend(name for name in reflected_names if name not in authoritative_names)
        return tuple(ordered)
    return reflected_names


def _column_type_signatures(
    connection: Connection,
    table: Table,
    columns: Sequence[sa.Column[Any]],
) -> tuple[str, ...]:
    return tuple(
        _type_family(
            column.type,
            dialect_name=connection.dialect.name,
            expected_type=_authoritative_column_type(table.name, column.name),
        )
        for column in columns
    )


def _strip_default_parentheses(rendered: str) -> str:
    rendered = rendered.strip()
    while rendered.startswith("(") and rendered.endswith(")"):
        depth = 0
        wraps_entire_expression = True
        in_string = False
        index = 0
        while index < len(rendered):
            character = rendered[index]
            if character == "'":
                if in_string and index + 1 < len(rendered) and rendered[index + 1] == "'":
                    index += 2
                    continue
                in_string = not in_string
            elif not in_string:
                if character == "(":
                    depth += 1
                elif character == ")":
                    depth -= 1
                    if depth == 0 and index != len(rendered) - 1:
                        wraps_entire_expression = False
                        break
            index += 1
        if not wraps_entire_expression or depth != 0 or in_string:
            break
        rendered = rendered[1:-1].strip()
    return rendered


def _server_default_signature(
    column: sa.Column[Any],
    *,
    generation: str,
) -> str:
    if generation != "none":
        return "none"
    if column.server_default is None:
        return "none"
    argument = getattr(column.server_default, "arg", column.server_default)
    rendered = _POSTGRES_CAST_PATTERN.sub("", str(argument)).strip()
    rendered = _strip_default_parentheses(rendered)
    compact = " ".join(rendered.split())
    unquoted = compact[1:-1] if compact.startswith("'") and compact.endswith("'") else compact
    lowered = unquoted.lower()
    if isinstance(column.type, sa.Boolean):
        if lowered in {"0", "false"}:
            return "boolean:false"
        if lowered in {"1", "true"}:
            return "boolean:true"
    if isinstance(column.type, (sa.Integer, sa.Numeric, sa.Float)):
        try:
            return f"number:{Decimal(unquoted).normalize()}"
        except Exception as exc:
            raise DatabaseTransferError(
                f"Numeric default for column {column.name!r} cannot be normalized safely."
            ) from exc
    if lowered in {"current_timestamp", "now()"}:
        return "current_timestamp"
    return f"sql:{compact}"


def _sqlite_table_uses_autoincrement(connection: Connection, table_name: str) -> bool:
    create_sql = connection.exec_driver_sql(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
        (table_name,),
    ).scalar_one_or_none()
    return bool(create_sql and re.search(r"\bAUTOINCREMENT\b", str(create_sql), re.IGNORECASE))


def _sqlite_implicit_integer_key(connection: Connection, table: Table) -> str | None:
    """Return the rowid-backed integer key used when AUTOINCREMENT is absent."""

    if connection.dialect.name != "sqlite" or _sqlite_table_uses_autoincrement(
        connection, table.name
    ):
        return None
    create_sql = connection.exec_driver_sql(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
        (table.name,),
    ).scalar_one_or_none()
    if not create_sql or re.search(r"\bWITHOUT\s+ROWID\b", str(create_sql), re.IGNORECASE):
        return None
    if re.search(r"\bPRIMARY\s+KEY\b[^,)]*\bDESC\b", str(create_sql), re.IGNORECASE):
        return None
    primary_key = tuple(table.primary_key.columns)
    if len(primary_key) != 1 or _type_family(primary_key[0].type) != "integer":
        return None
    return primary_key[0].name


def _authoritative_implicit_integer_key(table_name: str) -> str | None:
    table = Base.metadata.tables.get(table_name)
    if table is None or bool(table.dialect_options["sqlite"].get("autoincrement")):
        return None
    primary_key = tuple(table.primary_key.columns)
    if len(primary_key) != 1 or _type_family(primary_key[0].type) != "integer":
        return None
    return primary_key[0].name


def _generation_signatures(
    connection: Connection,
    table: Table,
    columns: Sequence[sa.Column[Any]],
) -> tuple[str, ...]:
    sqlite_autoincrement_column: str | None = None
    sqlite_implicit_integer_column: str | None = None
    if connection.dialect.name == "sqlite" and _sqlite_table_uses_autoincrement(
        connection, table.name
    ):
        primary_key = tuple(table.primary_key.columns)
        if len(primary_key) != 1 or not isinstance(primary_key[0].type, sa.Integer):
            raise DatabaseTransferError(
                f"SQLite AUTOINCREMENT table {table.name!r} has no single integer key."
            )
        sqlite_autoincrement_column = primary_key[0].name
    elif connection.dialect.name == "sqlite":
        sqlite_implicit_integer_column = _sqlite_implicit_integer_key(connection, table)

    signatures: list[str] = []
    for column in columns:
        if column.name == sqlite_autoincrement_column:
            generation = "sequence"
        elif column.name == sqlite_implicit_integer_column:
            generation = "implicit-integer-key"
        else:
            generation = "none"
        if connection.dialect.name == "postgresql":
            default_argument = (
                str(getattr(column.server_default, "arg", column.server_default))
                if column.server_default is not None
                else ""
            )
            normalized_default = _strip_default_parentheses(default_argument)
            if column.computed is not None:
                generation = "computed"
            elif column.identity is not None:
                generation = (
                    "identity:always" if bool(column.identity.always) else "identity:default"
                )
            elif _POSTGRES_NEXTVAL_DEFAULT_PATTERN.fullmatch(normalized_default):
                generation = (
                    "implicit-integer-key"
                    if column.name == _authoritative_implicit_integer_key(table.name)
                    else "sequence"
                )
            elif re.search(r"\bnextval\s*\(", normalized_default, re.IGNORECASE):
                generation = "unsafe-nextval-expression"
            else:
                generation = "none"
        signatures.append(generation)
    return tuple(signatures)


def _fingerprint_table(connection: Connection, table: Table) -> TableManifest:
    ordered_columns = _ordered_table_columns(table)
    columns = tuple(column.name for column in ordered_columns)
    column_types = _column_type_signatures(connection, table, ordered_columns)
    primary_key = _ordered_primary_key(table)
    if not primary_key:
        raise DatabaseTransferError(
            f"Table {table.name!r} has no primary key; deterministic transfer is unsafe."
        )
    nullable = tuple(bool(column.nullable) for column in ordered_columns)
    generations = _generation_signatures(connection, table, ordered_columns)
    server_defaults = tuple(
        _server_default_signature(column, generation=generation)
        for column, generation in zip(ordered_columns, generations, strict=True)
    )
    constraints = _constraint_signatures(table)
    checks = _check_signatures(table)
    indexes = _index_signatures(table, dialect_name=connection.dialect.name)
    digest = hashlib.sha256()
    digest.update(
        _strict_json(
            {
                "format_version": TRANSFER_FORMAT_VERSION,
                "table": table.name,
                "columns": columns,
                "column_types": column_types,
                "primary_key": primary_key,
                "nullable": nullable,
                "server_defaults": server_defaults,
                "generations": generations,
                "constraints": constraints,
                "checks": checks,
                "indexes": indexes,
            }
        ).encode("utf-8")
    )
    row_digests: list[bytes] = []
    statement = select(table)
    result = connection.execution_options(stream_results=True).execute(statement).mappings()
    for row in result:
        payload = [_canonical_value(row[name]) for name in columns]
        row_digests.append(hashlib.sha256(_strict_json(payload).encode("utf-8")).digest())
    row_digests.sort()
    for row_digest in row_digests:
        digest.update(b"\n")
        digest.update(row_digest)
    row_count = len(row_digests)
    return TableManifest(
        columns=columns,
        column_types=column_types,
        primary_key=primary_key,
        nullable=nullable,
        server_defaults=server_defaults,
        generations=generations,
        constraints=constraints,
        checks=checks,
        indexes=indexes,
        row_count=row_count,
        content_digest=digest.hexdigest(),
    )


def _sqlite_sequence_watermarks(
    connection: Connection,
    metadata: MetaData,
) -> dict[str, int]:
    """Capture generated integer-key watermarks without copying sqlite_sequence."""

    if connection.dialect.name != "sqlite":
        return {}
    autoincrement_tables = {
        table.name
        for table in metadata.tables.values()
        if _sqlite_table_uses_autoincrement(connection, table.name)
    }
    implicit_integer_tables = {
        table.name
        for table in metadata.tables.values()
        if _sqlite_implicit_integer_key(connection, table) is not None
    }
    sequence_table_exists = connection.exec_driver_sql(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'"
    ).scalar_one_or_none()
    if sequence_table_exists is None:
        if autoincrement_tables:
            raise DatabaseTransferError(
                "SQLite AUTOINCREMENT tables exist without sqlite_sequence metadata."
            )

    stored_watermarks: dict[str, int] = {}
    rows = (
        connection.exec_driver_sql("SELECT name, seq FROM sqlite_sequence ORDER BY name").mappings()
        if sequence_table_exists is not None
        else ()
    )
    for row in rows:
        table_name = str(row["name"])
        if table_name not in metadata.tables:
            raise DatabaseTransferError(
                f"SQLite sequence metadata references unknown table {table_name!r}."
            )
        if table_name not in autoincrement_tables:
            raise DatabaseTransferError(
                f"SQLite sequence metadata for {table_name!r} is not AUTOINCREMENT-owned."
            )
        if table_name in stored_watermarks:
            raise DatabaseTransferError(
                f"SQLite sequence metadata for {table_name!r} is duplicated."
            )
        sequence_value = row["seq"]
        if (
            isinstance(sequence_value, bool)
            or not isinstance(sequence_value, int)
            or sequence_value < 0
        ):
            raise DatabaseTransferError(f"SQLite sequence metadata for {table_name!r} is invalid.")
        table = metadata.tables[table_name]
        primary_key = tuple(table.primary_key.columns)
        if len(primary_key) != 1 or _type_family(primary_key[0].type) != "integer":
            raise DatabaseTransferError(
                f"SQLite sequence metadata for {table_name!r} has no single integer key."
            )
        stored_watermarks[table_name] = sequence_value

    watermarks: dict[str, int] = {}
    for table_name in sorted(autoincrement_tables | implicit_integer_tables):
        table = metadata.tables[table_name]
        primary_key = tuple(table.primary_key.columns)
        if len(primary_key) != 1 or not isinstance(primary_key[0].type, sa.Integer):
            raise DatabaseTransferError(
                f"SQLite generated-key table {table_name!r} has no single integer key."
            )
        maximum = int(connection.scalar(select(func.max(primary_key[0]))) or 0)
        watermark = (
            stored_watermarks.get(table_name, 0) if table_name in autoincrement_tables else maximum
        )
        if watermark < maximum:
            raise DatabaseTransferError(
                f"SQLite sequence metadata for {table_name!r} is below its primary key."
            )
        watermarks[table_name] = watermark
    return watermarks


def _build_manifest(
    connection: Connection,
    metadata: MetaData,
    *,
    schema_revision: str,
    sequence_watermarks: Mapping[str, int] | None = None,
) -> DatabaseManifest:
    normalized_watermarks = dict(
        sorted(
            (
                _sqlite_sequence_watermarks(connection, metadata)
                if sequence_watermarks is None
                else sequence_watermarks
            ).items()
        )
    )
    table_manifests = {
        name: _fingerprint_table(connection, metadata.tables[name])
        for name in sorted(metadata.tables)
    }
    digest_payload = {
        "format_version": TRANSFER_FORMAT_VERSION,
        "schema_revision": schema_revision,
        "sequence_watermarks": normalized_watermarks,
        "tables": {name: table_manifests[name].to_dict() for name in sorted(table_manifests)},
    }
    source_digest = hashlib.sha256(_strict_json(digest_payload).encode("utf-8")).hexdigest()
    return DatabaseManifest(
        schema_revision=schema_revision,
        tables=table_manifests,
        sequence_watermarks=normalized_watermarks,
        source_digest=source_digest,
    )


@contextmanager
def _source_snapshot(source_engine: Engine) -> Iterator[_SourceSnapshot]:
    if source_engine.dialect.name != "sqlite":
        raise DatabaseTransferError("The transfer source must use SQLite.")
    expected_head = migration_head_revision()
    with source_engine.connect() as observer_connection:
        data_version = _observer_data_version(observer_connection)
        with source_engine.connect() as connection, connection.begin():
            revision = _schema_revision(connection)
            if revision != expected_head:
                raise DatabaseTransferError(
                    "SQLite source schema is not at the sole current Alembic head; "
                    "upgrade and validate it before transfer."
                )
            names = _application_table_names(connection)
            if not names:
                raise DatabaseTransferError("SQLite source has no application tables to transfer.")
            metadata = _reflect_tables(connection, names)
            manifest = _build_manifest(
                connection,
                metadata,
                schema_revision=revision,
            )
            snapshot = _SourceSnapshot(
                connection=connection,
                observer_connection=observer_connection,
                metadata=metadata,
                manifest=manifest,
                data_version=data_version,
            )
            yield snapshot
            _assert_source_unchanged(snapshot)


def _observer_data_version(connection: Connection) -> int:
    """Read data_version on a connection independent from the source snapshot."""

    current = int(connection.exec_driver_sql("PRAGMA data_version").scalar_one())
    if connection.in_transaction():
        connection.commit()
    return current


def _assert_source_unchanged(snapshot: _SourceSnapshot) -> None:
    current = _observer_data_version(snapshot.observer_connection)
    if current != snapshot.data_version:
        raise DatabaseTransferError(
            "SQLite source changed while it was being read; no transfer receipt can be issued. "
            "Stop the API and repeat the dry-run."
        )


def _assert_schema_compatible(
    source: DatabaseManifest,
    target: MetaData,
    connection: Connection,
) -> None:
    source_names = set(source.tables)
    target_names = set(target.tables)
    if source_names != target_names:
        missing = sorted(source_names - target_names)
        extra = sorted(target_names - source_names)
        details: list[str] = []
        if missing:
            details.append(f"missing target tables: {', '.join(missing)}")
        if extra:
            details.append(f"unexpected target tables: {', '.join(extra)}")
        raise DatabaseTransferError("Database schemas differ; " + "; ".join(details) + ".")

    for name, expected in source.tables.items():
        table = target.tables[name]
        ordered_columns = _ordered_table_columns(table)
        columns = tuple(column.name for column in ordered_columns)
        column_types = _column_type_signatures(connection, table, ordered_columns)
        primary_key = _ordered_primary_key(table)
        nullable = tuple(bool(column.nullable) for column in ordered_columns)
        generations = _generation_signatures(connection, table, ordered_columns)
        server_defaults = tuple(
            _server_default_signature(column, generation=generation)
            for column, generation in zip(ordered_columns, generations, strict=True)
        )
        constraints = _constraint_signatures(table)
        checks = _check_signatures(table)
        indexes = _index_signatures(table, dialect_name=connection.dialect.name)
        if (
            columns != expected.columns
            or column_types != expected.column_types
            or primary_key != expected.primary_key
            or nullable != expected.nullable
            or server_defaults != expected.server_defaults
            or generations != expected.generations
            or constraints != expected.constraints
            or checks != expected.checks
            or indexes != expected.indexes
        ):
            raise DatabaseTransferError(
                f"Table {name!r} has incompatible columns, types, defaults, keys, "
                "checks, or indexes."
            )


def _target_nonempty_tables(connection: Connection, table_names: Sequence[str]) -> list[str]:
    if not table_names:
        return []
    metadata = _reflect_tables(connection, table_names)
    return [
        name
        for name in table_names
        if int(connection.scalar(select(func.count()).select_from(metadata.tables[name])) or 0) > 0
    ]


def _lock_postgres_tables_for_verification(
    connection: Connection,
    table_names: Sequence[str],
) -> None:
    if connection.dialect.name != "postgresql" or not table_names:
        return
    preparer = connection.dialect.identifier_preparer
    qualified_tables = ", ".join(
        preparer.quote_identifier(table_name) for table_name in table_names
    )
    # SHARE conflicts with INSERT/UPDATE/DELETE and is held until this
    # transaction ends. The importing transaction can still write its own rows.
    connection.exec_driver_sql(f"LOCK TABLE {qualified_tables} IN SHARE MODE")


def _preflight_target(
    connection: Connection,
    manifest: DatabaseManifest,
    *,
    expected_head: str,
) -> tuple[str | None, bool]:
    if connection.dialect.name == "postgresql":
        # SQLite's timezone-aware columns are stored as UTC wall-clock values.
        # Pin the Postgres session so naive source datetimes cannot be shifted
        # by an operator-specific server/session timezone during insert/hash.
        connection.exec_driver_sql("SET LOCAL TIME ZONE 'UTC'")
    target_revision = _schema_revision(connection)
    existing_names = set(_application_table_names(connection))
    if target_revision is None and existing_names:
        raise DatabaseTransferError(
            "Target has application tables but no Alembic revision; use a dedicated empty database."
        )
    if target_revision is not None:
        known_revisions = {
            revision.revision
            for revision in ScriptDirectory.from_config(alembic_config()).walk_revisions()
        }
        if target_revision not in known_revisions:
            raise DatabaseTransferError(
                "Target Alembic revision is not part of the current migration graph."
            )
    unknown = sorted(existing_names - set(manifest.tables))
    if unknown:
        raise DatabaseTransferError(
            "Target contains application tables that are not in the SQLite source: "
            + ", ".join(unknown)
            + "."
        )
    _lock_postgres_tables_for_verification(connection, sorted(existing_names))
    nonempty = _target_nonempty_tables(connection, sorted(existing_names))
    if nonempty:
        if target_revision != expected_head:
            raise DatabaseTransferError("Non-empty target is not at the sole current Alembic head.")
        metadata = _reflect_tables(connection, sorted(existing_names))
        _assert_schema_compatible(manifest, metadata, connection)
        if connection.dialect.name == "postgresql":
            _assert_postgres_sequence_watermarks(
                connection,
                metadata,
                manifest.sequence_watermarks,
            )
        target_manifest = _build_manifest(
            connection,
            metadata,
            schema_revision=expected_head,
            sequence_watermarks=(
                manifest.sequence_watermarks if connection.dialect.name == "postgresql" else None
            ),
        )
        if target_manifest.source_digest != manifest.source_digest:
            raise DatabaseTransferError(
                "Target is non-empty and does not exactly match the SQLite source."
            )
        return target_revision, True
    if target_revision == expected_head:
        metadata = _reflect_tables(connection, sorted(existing_names))
        _assert_schema_compatible(manifest, metadata, connection)
        if connection.dialect.name == "postgresql":
            sequence_state = _classify_postgres_sequence_state(
                connection,
                metadata,
                manifest.sequence_watermarks,
            )
            if sequence_state in {"exact", "exact-pristine"}:
                target_manifest = _build_manifest(
                    connection,
                    metadata,
                    schema_revision=expected_head,
                    sequence_watermarks=manifest.sequence_watermarks,
                )
                if target_manifest.source_digest == manifest.source_digest:
                    return target_revision, True
                if sequence_state == "exact":
                    raise DatabaseTransferError(
                        "Empty target has source sequence history but not the source rows."
                    )
        elif connection.dialect.name == "sqlite":
            target_manifest = _build_manifest(
                connection,
                metadata,
                schema_revision=expected_head,
            )
            if target_manifest.source_digest == manifest.source_digest:
                return target_revision, True
            if set(target_manifest.sequence_watermarks) != set(manifest.sequence_watermarks) or any(
                target_manifest.sequence_watermarks.values()
            ):
                raise DatabaseTransferError(
                    "Empty target contains sequence history from a different database."
                )
    return target_revision, False


def analyze_database_transfer(
    source_engine: Engine,
    target_engine: Engine,
    *,
    require_postgresql: bool = True,
) -> TransferReport:
    """Validate source and target without changing either database."""

    if require_postgresql and target_engine.dialect.name != "postgresql":
        raise DatabaseTransferError("The transfer target must use PostgreSQL.")
    expected_head = migration_head_revision()
    with _source_snapshot(source_engine) as snapshot:
        with target_engine.connect() as target:
            target_revision, exact_existing = _preflight_target(
                target,
                snapshot.manifest,
                expected_head=expected_head,
            )
            _assert_source_unchanged(snapshot)
            return TransferReport(
                mode="dry-run",
                status="already-imported" if exact_existing else "dry-run",
                source_digest=snapshot.manifest.source_digest,
                source_schema_revision=snapshot.manifest.schema_revision,
                target_schema_revision=target_revision,
                table_count=len(snapshot.manifest.tables),
                row_count=snapshot.manifest.row_count,
                receipt_persisted=False,
                table_manifest=snapshot.manifest.receipt_payload(),
            )


def _copy_table(
    source: Connection,
    source_table: Table,
    target: Connection,
    target_table: Table,
    *,
    batch_size: int,
) -> None:
    primary_key = tuple(column.name for column in source_table.primary_key.columns)
    statement = select(source_table).order_by(*(source_table.c[name].asc() for name in primary_key))
    result = source.execution_options(stream_results=True).execute(statement).mappings()
    while True:
        rows = result.fetchmany(batch_size)
        if not rows:
            return
        target.execute(target_table.insert(), [dict(row) for row in rows])


def _postgres_sequence_name(
    connection: Connection,
    table: Table,
    column: sa.Column[Any],
) -> str | None:
    return connection.scalar(
        text("SELECT pg_get_serial_sequence(:table_name, :column_name)"),
        {"table_name": table.name, "column_name": column.name},
    )


def _postgres_sequence_state(
    connection: Connection,
    sequence_name: str,
) -> tuple[int, bool]:
    identifiers = connection.scalar(
        text("SELECT parse_ident(:sequence_name, true)"),
        {"sequence_name": sequence_name},
    )
    if not isinstance(identifiers, (list, tuple)) or not 1 <= len(identifiers) <= 2:
        raise DatabaseTransferError("PostgreSQL returned an invalid sequence identifier.")
    preparer = connection.dialect.identifier_preparer
    qualified_name = ".".join(
        preparer.quote_identifier(str(identifier)) for identifier in identifiers
    )
    state = (
        connection.exec_driver_sql(f"SELECT last_value, is_called FROM {qualified_name}")
        .mappings()
        .one()
    )
    return int(state["last_value"]), bool(state["is_called"])


def _assert_postgres_sequence_configuration(
    connection: Connection,
    sequence_name: str,
    column: sa.Column[Any],
) -> None:
    configuration = (
        connection.execute(
            text(
                "SELECT seqincrement, seqmin, seqmax, seqstart, seqcache, seqcycle, "
                "seqtypid::regtype::text AS seqtype "
                "FROM pg_sequence WHERE seqrelid = CAST(:sequence_name AS regclass)"
            ),
            {"sequence_name": sequence_name},
        )
        .mappings()
        .one_or_none()
    )
    if configuration is None:
        raise DatabaseTransferError("PostgreSQL sequence metadata is missing.")
    column_family = _type_family(
        column.type,
        dialect_name="postgresql",
        expected_type=_authoritative_column_type(column.table.name, column.name),
    )
    expected_sequence_types = {
        "smallint": ("smallint", 32767),
        "integer": ("integer", 2147483647),
        "bigint": ("bigint", 9223372036854775807),
    }
    expected_sequence = expected_sequence_types.get(column_family)
    if expected_sequence is None:
        raise DatabaseTransferError(
            f"Generated key {column.table.name}.{column.name} is not an integer width."
        )
    expected_type, expected_maximum = expected_sequence
    if (
        int(configuration["seqincrement"]) != 1
        or int(configuration["seqmin"]) != 1
        or int(configuration["seqmax"]) != expected_maximum
        or int(configuration["seqstart"]) != 1
        or int(configuration["seqcache"]) != 1
        or bool(configuration["seqcycle"])
        or str(configuration["seqtype"]) != expected_type
    ):
        raise DatabaseTransferError(
            "PostgreSQL sequence configuration is incompatible with SQLite integer-key generation."
        )


def _assert_postgres_sequence_watermarks(
    connection: Connection,
    metadata: MetaData,
    watermarks: Mapping[str, int],
) -> None:
    for table_name, watermark in watermarks.items():
        table = metadata.tables.get(table_name)
        if table is None:
            raise DatabaseTransferError(
                f"Sequence watermark references missing target table {table_name!r}."
            )
        primary_key = tuple(table.primary_key.columns)
        if len(primary_key) != 1:
            raise DatabaseTransferError(
                f"Sequence watermark for {table_name!r} has no single target key."
            )
        sequence_name = _postgres_sequence_name(connection, table, primary_key[0])
        if not sequence_name:
            raise DatabaseTransferError(
                f"Sequence watermark for {table_name!r} has no PostgreSQL sequence."
            )
        maximum = connection.scalar(select(func.max(primary_key[0])))
        if int(maximum or 0) > watermark:
            raise DatabaseTransferError(
                f"PostgreSQL primary key for {table_name!r} exceeds the source watermark."
            )
        _assert_postgres_sequence_configuration(connection, sequence_name, primary_key[0])
        current_value, is_called = _postgres_sequence_state(connection, sequence_name)
        expected_value = watermark if watermark > 0 else 1
        if current_value != expected_value or is_called is not (watermark > 0):
            raise DatabaseTransferError(
                f"PostgreSQL sequence for {table_name!r} does not match the source watermark."
            )


def _classify_postgres_sequence_state(
    connection: Connection,
    metadata: MetaData,
    watermarks: Mapping[str, int],
) -> str:
    exact = True
    pristine = True
    for table_name, watermark in watermarks.items():
        table = metadata.tables.get(table_name)
        if table is None:
            raise DatabaseTransferError(
                f"Sequence watermark references missing target table {table_name!r}."
            )
        primary_key = tuple(table.primary_key.columns)
        if len(primary_key) != 1:
            raise DatabaseTransferError(
                f"Sequence watermark for {table_name!r} has no single target key."
            )
        sequence_name = _postgres_sequence_name(connection, table, primary_key[0])
        if not sequence_name:
            raise DatabaseTransferError(
                f"Sequence watermark for {table_name!r} has no PostgreSQL sequence."
            )
        _assert_postgres_sequence_configuration(connection, sequence_name, primary_key[0])
        value, is_called = _postgres_sequence_state(connection, sequence_name)
        expected_value = watermark if watermark > 0 else 1
        exact = exact and value == expected_value and is_called == (watermark > 0)
        pristine = pristine and value == 1 and not is_called
    if exact and pristine:
        return "exact-pristine"
    if exact:
        return "exact"
    if pristine:
        return "pristine"
    raise DatabaseTransferError(
        "Empty PostgreSQL target contains sequence history from a different database."
    )


def _reset_postgres_sequences(
    connection: Connection,
    metadata: MetaData,
    watermarks: Mapping[str, int],
) -> None:
    for table_name, watermark in watermarks.items():
        table = metadata.tables.get(table_name)
        if table is None:
            raise DatabaseTransferError(
                f"Sequence watermark references missing target table {table_name!r}."
            )
        primary_key = tuple(table.primary_key.columns)
        if len(primary_key) != 1:
            raise DatabaseTransferError(
                f"Sequence watermark for {table_name!r} has no single target key."
            )
        maximum = int(connection.scalar(select(func.max(primary_key[0]))) or 0)
        if maximum > watermark:
            raise DatabaseTransferError(
                f"PostgreSQL primary key for {table_name!r} exceeds the source watermark."
            )
        sequence_name = _postgres_sequence_name(connection, table, primary_key[0])
        if not sequence_name:
            raise DatabaseTransferError(
                f"Sequence watermark for {table_name!r} has no PostgreSQL sequence."
            )
        _assert_postgres_sequence_configuration(connection, sequence_name, primary_key[0])
        if watermark == 0:
            connection.execute(
                text("SELECT setval(CAST(:sequence_name AS regclass), 1, false)"),
                {"sequence_name": sequence_name},
            )
        else:
            connection.execute(
                text("SELECT setval(CAST(:sequence_name AS regclass), :value, true)"),
                {"sequence_name": sequence_name, "value": watermark},
            )


def _reset_sqlite_sequences(
    connection: Connection,
    metadata: MetaData,
    watermarks: Mapping[str, int],
) -> None:
    for table_name, watermark in watermarks.items():
        table = metadata.tables.get(table_name)
        if table is None:
            raise DatabaseTransferError(
                f"Sequence watermark references missing target table {table_name!r}."
            )
        primary_key = tuple(table.primary_key.columns)
        if len(primary_key) != 1 or _type_family(primary_key[0].type) != "integer":
            raise DatabaseTransferError(
                f"Sequence watermark for {table_name!r} has no single integer target key."
            )
        maximum = int(connection.scalar(select(func.max(primary_key[0]))) or 0)
        if maximum > watermark:
            raise DatabaseTransferError(
                f"SQLite primary key for {table_name!r} exceeds the source watermark."
            )
        if not _sqlite_table_uses_autoincrement(connection, table_name):
            if _sqlite_implicit_integer_key(connection, table) is None or maximum != watermark:
                raise DatabaseTransferError(
                    f"SQLite implicit integer key for {table_name!r} does not match the source."
                )
            continue
        desired_value = watermark
        result = connection.exec_driver_sql(
            "UPDATE sqlite_sequence SET seq = ? WHERE name = ?",
            (desired_value, table_name),
        )
        if result.rowcount == 0:
            connection.exec_driver_sql(
                "INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)",
                (table_name, desired_value),
            )


def _reset_target_sequences(
    connection: Connection,
    metadata: MetaData,
    watermarks: Mapping[str, int],
) -> None:
    if connection.dialect.name == "postgresql":
        _reset_postgres_sequences(connection, metadata, watermarks)
    elif connection.dialect.name == "sqlite":
        _reset_sqlite_sequences(connection, metadata, watermarks)


@contextmanager
def _target_transfer_lock(target_engine: Engine) -> Iterator[None]:
    """Hold one PostgreSQL session lock across preflight, DDL, and data copy."""

    if target_engine.dialect.name != "postgresql":
        yield
        return

    with target_engine.connect() as lock_connection:
        acquired = False
        try:
            try:
                lock_connection.execute(
                    text("SELECT pg_advisory_lock(hashtext(:lock_name))"),
                    {"lock_name": _POSTGRES_TRANSFER_LOCK},
                )
                acquired = True
                lock_connection.commit()
            except SQLAlchemyError:
                # The server may have acquired the lock even if the client did
                # not receive a successful response. Never return that session
                # to the pool when acquisition cannot be proven clean.
                try:
                    lock_connection.invalidate()
                except SQLAlchemyError:
                    pass
                acquired = False
                raise
            yield
        finally:
            if acquired:
                try:
                    if lock_connection.in_transaction():
                        lock_connection.rollback()
                    lock_connection.execute(
                        text("SELECT pg_advisory_unlock(hashtext(:lock_name))"),
                        {"lock_name": _POSTGRES_TRANSFER_LOCK},
                    )
                    lock_connection.commit()
                except SQLAlchemyError:
                    # A pooled Connection.close() may preserve its database
                    # session. Invalidate it so an unlock failure cannot leak.
                    try:
                        lock_connection.invalidate()
                    except SQLAlchemyError:
                        pass


def _execute_locked_transfer(
    snapshot: _SourceSnapshot,
    target_engine: Engine,
    *,
    expected_head: str,
    batch_size: int,
) -> tuple[str, str | None]:
    with target_engine.connect() as preflight:
        target_revision, exact_existing = _preflight_target(
            preflight,
            snapshot.manifest,
            expected_head=expected_head,
        )
        if exact_existing:
            return "already-imported", target_revision

    # Target DDL may advance only after the read-only preflight proves that
    # every existing application table is empty.
    upgrade_database(target_engine)
    with target_engine.begin() as target:
        target_revision = _schema_revision(target)
        if target_revision != expected_head:
            raise DatabaseTransferError("Target did not reach the sole current Alembic head.")
        _, exact_existing = _preflight_target(
            target,
            snapshot.manifest,
            expected_head=expected_head,
        )
        if exact_existing:
            status = "already-imported"
        else:
            names = _application_table_names(target)
            target_metadata = _reflect_tables(target, names)
            _assert_schema_compatible(snapshot.manifest, target_metadata, target)
            ordered_tables = [
                table
                for table in target_metadata.sorted_tables
                if table.name in snapshot.manifest.tables
            ]
            for target_table in ordered_tables:
                _copy_table(
                    snapshot.connection,
                    snapshot.metadata.tables[target_table.name],
                    target,
                    target_table,
                    batch_size=batch_size,
                )
            _reset_target_sequences(
                target,
                target_metadata,
                snapshot.manifest.sequence_watermarks,
            )

            target_manifest = _build_manifest(
                target,
                target_metadata,
                schema_revision=target_revision,
                sequence_watermarks=(
                    snapshot.manifest.sequence_watermarks
                    if target.dialect.name == "postgresql"
                    else None
                ),
            )
            if target_manifest.source_digest != snapshot.manifest.source_digest:
                raise DatabaseTransferError(
                    "Post-copy target verification failed; transaction was rolled back."
                )

            status = "imported"
        _assert_source_unchanged(snapshot)
    return status, target_revision


def execute_database_transfer(
    source_engine: Engine,
    target_engine: Engine,
    *,
    expected_source_digest: str,
    batch_size: int = 1_000,
    require_postgresql: bool = True,
) -> TransferReport:
    """Copy a validated SQLite snapshot atomically under a target-wide lock."""

    if require_postgresql and target_engine.dialect.name != "postgresql":
        raise DatabaseTransferError("The transfer target must use PostgreSQL.")
    if len(expected_source_digest) != 64:
        raise DatabaseTransferError(
            "Execution requires the exact 64-character source digest from a dry-run."
        )
    if batch_size < 1 or batch_size > 10_000:
        raise DatabaseTransferError("Batch size must be between 1 and 10000.")

    expected_head = migration_head_revision()
    with _source_snapshot(source_engine) as snapshot:
        if snapshot.manifest.source_digest != expected_source_digest.lower():
            raise DatabaseTransferError(
                "SQLite source no longer matches the approved dry-run digest."
            )

        with _target_transfer_lock(target_engine):
            status, target_revision = _execute_locked_transfer(
                snapshot,
                target_engine,
                expected_head=expected_head,
                batch_size=batch_size,
            )
            _assert_source_unchanged(snapshot)

        return TransferReport(
            mode="execute",
            status=status,
            source_digest=snapshot.manifest.source_digest,
            source_schema_revision=snapshot.manifest.schema_revision,
            target_schema_revision=target_revision,
            table_count=len(snapshot.manifest.tables),
            row_count=snapshot.manifest.row_count,
            receipt_persisted=False,
            table_manifest=snapshot.manifest.receipt_payload(),
        )


def write_receipt_file(path: str | Path, report: TransferReport) -> TransferReport:
    """Atomically write an external, secret-free receipt with restrictive mode.

    The receipt deliberately stays outside the application database until a
    later linear Alembic revision can own a receipt table without creating a
    competing migration head. Re-running the importer still re-hashes every
    target row; the file is an operator audit artifact, not a trust shortcut.
    """

    destination = Path(os.path.abspath(os.fspath(Path(path).expanduser())))
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise DatabaseTransferError(
            "The external receipt directory could not be created "
            f"({type(exc).__name__}). The target may already contain the exact import."
        ) from exc
    persisted_report = replace(report, receipt_persisted=True)
    completed_statuses = frozenset({"imported", "already-imported"})
    valid_mode_statuses = {
        "dry-run": frozenset({"dry-run", "already-imported"}),
        "execute": completed_statuses,
    }
    allowed_statuses = valid_mode_statuses.get(persisted_report.mode)
    if allowed_statuses is None or persisted_report.status not in allowed_statuses:
        raise DatabaseTransferError("Transfer mode and status cannot be persisted as a receipt.")
    try:
        destination_status = destination.lstat()
    except FileNotFoundError:
        destination_status = None
    except OSError as exc:
        raise DatabaseTransferError(
            "The receipt destination could not be inspected safely."
        ) from exc

    if destination_status is not None:
        if stat.S_ISLNK(destination_status.st_mode) or not stat.S_ISREG(destination_status.st_mode):
            raise DatabaseTransferError(
                "The receipt destination must be a regular file, never a symlink or device."
            )
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(destination, flags)
            with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    raise DatabaseTransferError(
                        "The receipt destination changed to a non-regular file."
                    )
                existing = json.load(handle)
                os.fchmod(handle.fileno(), 0o600)
            if existing.get("receipt_type") != _RECEIPT_TYPE:
                raise DatabaseTransferError(
                    "The receipt destination has an unsupported receipt type."
                )
            receipt_version = existing.get("receipt_version")
            if (
                isinstance(receipt_version, bool)
                or not isinstance(receipt_version, int)
                or receipt_version != TRANSFER_FORMAT_VERSION
            ):
                raise DatabaseTransferError(
                    "The receipt destination has an unsupported receipt version."
                )
            existing_transfer = existing["transfer"]
            if not isinstance(existing_transfer, Mapping):
                raise DatabaseTransferError(
                    "The receipt destination has an invalid transfer payload."
                )
        except DatabaseTransferError:
            raise
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise DatabaseTransferError(
                "The receipt destination already exists but is not a valid transfer receipt."
            ) from exc
        expected = persisted_report.to_dict()
        if existing_transfer.get("mode") != expected["mode"]:
            raise DatabaseTransferError(
                "The receipt destination already belongs to a different transfer mode."
            )
        existing_status = existing_transfer.get("status")
        expected_status = expected["status"]
        if expected["mode"] == "execute":
            status_matches = existing_status in completed_statuses
        else:
            status_matches = existing_status == expected_status
        stable_fields = (
            "source_digest",
            "source_schema_revision",
            "target_schema_revision",
            "table_count",
            "row_count",
            "receipt_persisted",
            "table_manifest",
        )
        if not status_matches or not all(
            existing_transfer.get(field) == expected[field] for field in stable_fields
        ):
            raise DatabaseTransferError(
                "The receipt destination already belongs to a different transfer."
            )
        return persisted_report

    temporary = destination.with_name(f".{destination.name}.{uuid4().hex}.tmp")
    payload = (
        _strict_json(
            {
                "receipt_type": _RECEIPT_TYPE,
                "receipt_version": TRANSFER_FORMAT_VERSION,
                "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
                "transfer": persisted_report.to_dict(),
            }
        )
        + "\n"
    )
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        # Link the fully-fsynced temporary file into place so an existing
        # operator receipt can never be overwritten by a racing process.
        os.link(temporary, destination)
    except OSError as exc:
        raise DatabaseTransferError(
            "The external receipt could not be persisted "
            f"({type(exc).__name__}). The target may already contain the exact import; "
            "rerun the same digest-bound command to verify it and recreate the receipt."
        ) from exc
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return persisted_report


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate and transfer Aperture application tables from SQLite to PostgreSQL. "
            "The default is a read-only dry-run."
        )
    )
    parser.add_argument(
        "--source-sqlite",
        type=Path,
        required=True,
        help="Path to the quiesced aperture.sqlite3 source.",
    )
    parser.add_argument(
        "--database-url",
        help=(
            "Target postgresql+psycopg URL. Defaults to APERTURE_DATABASE_URL; "
            "the environment is preferred so credentials do not enter shell history."
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="Explicitly select read-only validation (also the safe default).",
    )
    mode.add_argument(
        "--execute",
        action="store_true",
        help="Perform the import. Without this flag, both databases remain unchanged.",
    )
    parser.add_argument(
        "--expected-source-digest",
        help="Exact source_digest emitted by the immediately preceding dry-run.",
    )
    parser.add_argument(
        "--receipt-output",
        type=Path,
        help="Optional path for a mode-0600 JSON receipt after successful validation/import.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=1_000,
        help="Rows inserted per batch during --execute (1..10000; default 1000).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    database_url = (args.database_url or os.environ.get("APERTURE_DATABASE_URL", "")).strip()
    if not database_url:
        raise SystemExit(
            "Set APERTURE_DATABASE_URL to the target PostgreSQL URL before running the importer."
        )
    if args.execute and not args.expected_source_digest:
        raise SystemExit("--execute requires --expected-source-digest from a successful dry-run.")
    if args.execute and not args.receipt_output:
        raise SystemExit("--execute requires --receipt-output for the external transfer receipt.")
    if not args.execute and args.expected_source_digest:
        raise SystemExit("--expected-source-digest is only valid with --execute.")

    source_engine: Engine | None = None
    target_engine: Engine | None = None
    try:
        source_engine = create_readonly_sqlite_engine(args.source_sqlite)
        target_engine = create_application_engine(database_url)
        if args.execute:
            report = execute_database_transfer(
                source_engine,
                target_engine,
                expected_source_digest=args.expected_source_digest,
                batch_size=args.batch_size,
            )
        else:
            report = analyze_database_transfer(source_engine, target_engine)
        if args.receipt_output:
            report = write_receipt_file(args.receipt_output, report)
    except DatabaseTransferError as exc:
        raise SystemExit(f"Database transfer failed: {exc}") from exc
    except SQLAlchemyError as exc:
        # SQLAlchemy statement errors can include bound values. Some Aperture
        # rows contain encrypted provider/config material, so never render the
        # exception, SQL statement, or parameters into operator output.
        raise SystemExit(
            "Database transfer failed inside the database driver "
            f"({type(exc).__name__}); statement details were omitted."
        ) from exc
    finally:
        if target_engine is not None:
            target_engine.dispose()
        if source_engine is not None:
            source_engine.dispose()

    print(_strict_json(report.to_dict()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
