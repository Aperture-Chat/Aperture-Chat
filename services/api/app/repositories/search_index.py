"""Relational search index: derived text rows that narrow global-search candidates.

Rows live in the application database next to the records they describe.
They carry only coarse scoping columns (tenant, owner, visibility) so a query
can be bounded in SQL; authorization is still decided by the live record in
``routes/search.py``. The index is rebuildable at any time.

Text matching uses the portable LIKE mode on a pre-lowercased ``search_text``
column. Dialect-specific acceleration (FTS5 / tsvector) can replace ``query``
without changing callers; ``search_index_state.fts_mode`` records what is in use.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, TypeVar

from sqlalchemy import delete, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.db.engine import create_session_factory, engine_write_lock
from app.db.orm import SearchIndexEntryRow, SearchIndexStateRow

T = TypeVar("T")

SearchIndexKind = Literal["chat", "draft", "agent", "automation", "matter", "review", "knowledge"]
SearchIndexVisibility = Literal["owner", "tenant", "groups", "private", "matter"]

INDEX_VERSION = 1
MAX_BODY_CHARS = 64 * 1024
_TOKEN_PATTERN = re.compile(r"[a-zA-Z0-9]+")


class SearchIndexUnavailable(Exception):
    """The relational index could not complete an operation."""


@dataclass(frozen=True, slots=True)
class SearchIndexEntry:
    tenant_id: str
    kind: SearchIndexKind
    resource_id: str
    title: str
    body: str
    source_updated_at: datetime
    owner_user_id: str | None = None
    visibility: SearchIndexVisibility = "owner"
    acl_group_ids: tuple[str, ...] = ()
    matter_id: str | None = None
    archived: bool = False

    @property
    def id(self) -> str:
        return f"{self.kind}:{self.resource_id}"


@dataclass(frozen=True, slots=True)
class SearchIndexCandidate:
    kind: str
    resource_id: str
    owner_user_id: str | None
    title: str
    body: str
    matter_id: str | None
    archived: bool
    score: float


@dataclass(frozen=True, slots=True)
class SearchIndexState:
    tenant_id: str
    backfill_revision: int
    backfill_completed_at: datetime | None
    fts_mode: str
    entry_count: int
    extra: dict[str, object] = field(default_factory=dict)

    @property
    def ready(self) -> bool:
        return self.backfill_completed_at is not None


def entry_id(kind: str, resource_id: str) -> str:
    return f"{kind}:{resource_id}"


def build_search_text(title: str, body: str) -> str:
    return " ".join(f"{title}\n{body}".casefold().split())


def _bounded_body(body: str) -> str:
    return body if len(body) <= MAX_BODY_CHARS else body[:MAX_BODY_CHARS]


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def entry_to_row(entry: SearchIndexEntry, *, indexed_at: datetime | None = None) -> SearchIndexEntryRow:
    body = _bounded_body(entry.body)
    return SearchIndexEntryRow(
        id=entry.id,
        tenant_id=entry.tenant_id,
        kind=entry.kind,
        resource_id=entry.resource_id,
        owner_user_id=entry.owner_user_id,
        visibility=entry.visibility,
        acl_group_ids=list(entry.acl_group_ids) or None,
        matter_id=entry.matter_id,
        archived=entry.archived,
        title=entry.title,
        body=body,
        search_text=build_search_text(entry.title, body),
        source_updated_at=_aware(entry.source_updated_at),
        indexed_at=indexed_at or datetime.now(UTC),
        index_version=INDEX_VERSION,
    )


def write_entry(session: Session, entry: SearchIndexEntry) -> None:
    """Upsert inside a caller-owned session (same transaction as the source write)."""

    session.execute(delete(SearchIndexEntryRow).where(SearchIndexEntryRow.id == entry.id))
    session.add(entry_to_row(entry))


def remove_entry(session: Session, kind: str, resource_id: str) -> None:
    session.execute(
        delete(SearchIndexEntryRow).where(SearchIndexEntryRow.id == entry_id(kind, resource_id))
    )


def lexical_score(search_text: str, query: str) -> float:
    folded = query.casefold()
    terms = {term.casefold() for term in _TOKEN_PATTERN.findall(query)}
    score = float(sum(search_text.count(term) for term in terms))
    if folded in search_text:
        score += 4.0
    return score


class SearchIndexRepository:
    def __init__(
        self,
        engine: Engine,
        *,
        session_factory: sessionmaker[Session] | None = None,
    ) -> None:
        self.engine = engine
        self._sessions = session_factory or create_session_factory(engine)
        self._lock = engine_write_lock(engine)

    # Writes ------------------------------------------------------------

    def upsert(self, entry: SearchIndexEntry) -> None:
        self.upsert_many([entry])

    def upsert_many(self, entries: Iterable[SearchIndexEntry]) -> int:
        items = list(entries)
        if not items:
            return 0

        def operation(session: Session) -> int:
            now = datetime.now(UTC)
            session.execute(
                delete(SearchIndexEntryRow).where(
                    SearchIndexEntryRow.id.in_([item.id for item in items])
                )
            )
            for item in items:
                session.add(entry_to_row(item, indexed_at=now))
            return len(items)

        return self._run_write(operation)

    def delete(self, kind: str, resource_id: str) -> None:
        def operation(session: Session) -> None:
            remove_entry(session, kind, resource_id)

        self._run_write(operation)

    def delete_many(self, kind: str, resource_ids: Sequence[str]) -> int:
        if not resource_ids:
            return 0
        ids = [entry_id(kind, resource_id) for resource_id in resource_ids]

        def operation(session: Session) -> int:
            return int(
                session.execute(
                    delete(SearchIndexEntryRow).where(SearchIndexEntryRow.id.in_(ids))
                ).rowcount
                or 0
            )

        return self._run_write(operation)

    def delete_for_owner(self, *, tenant_id: str, user_id: str) -> int:
        def operation(session: Session) -> int:
            return int(
                session.execute(
                    delete(SearchIndexEntryRow).where(
                        SearchIndexEntryRow.tenant_id == tenant_id,
                        SearchIndexEntryRow.owner_user_id == user_id,
                    )
                ).rowcount
                or 0
            )

        return self._run_write(operation)

    def delete_for_tenant(self, tenant_id: str) -> int:
        def operation(session: Session) -> int:
            removed = int(
                session.execute(
                    delete(SearchIndexEntryRow).where(SearchIndexEntryRow.tenant_id == tenant_id)
                ).rowcount
                or 0
            )
            session.execute(
                delete(SearchIndexStateRow).where(SearchIndexStateRow.tenant_id == tenant_id)
            )
            return removed

        return self._run_write(operation)

    def prune_kind(self, *, tenant_id: str, kind: str, keep_resource_ids: Iterable[str]) -> int:
        """Drop index rows for a kind whose source no longer exists (reconcile)."""

        keep = set(keep_resource_ids)

        def operation(session: Session) -> int:
            existing = list(
                session.scalars(
                    select(SearchIndexEntryRow.resource_id).where(
                        SearchIndexEntryRow.tenant_id == tenant_id,
                        SearchIndexEntryRow.kind == kind,
                    )
                )
            )
            doomed = [entry_id(kind, resource_id) for resource_id in existing if resource_id not in keep]
            if not doomed:
                return 0
            return int(
                session.execute(
                    delete(SearchIndexEntryRow).where(SearchIndexEntryRow.id.in_(doomed))
                ).rowcount
                or 0
            )

        return self._run_write(operation)

    def mark_backfilled(self, tenant_id: str, *, fts_mode: str = "like") -> SearchIndexState:
        def operation(session: Session) -> SearchIndexState:
            count = session.scalar(
                select(func.count())
                .select_from(SearchIndexEntryRow)
                .where(SearchIndexEntryRow.tenant_id == tenant_id)
            )
            row = session.get(SearchIndexStateRow, tenant_id)
            if row is None:
                row = SearchIndexStateRow(tenant_id=tenant_id, backfill_revision=0)
                session.add(row)
            row.backfill_revision = int(row.backfill_revision or 0) + 1
            row.backfill_completed_at = datetime.now(UTC)
            row.fts_mode = fts_mode
            row.entry_count = int(count or 0)
            session.flush()
            return _state_from_row(row)

        return self._run_write(operation)

    def reset_state(self, tenant_id: str) -> None:
        def operation(session: Session) -> None:
            row = session.get(SearchIndexStateRow, tenant_id)
            if row is not None:
                row.backfill_completed_at = None

        self._run_write(operation)

    # Reads -------------------------------------------------------------

    def state(self, tenant_id: str) -> SearchIndexState | None:
        def operation(session: Session) -> SearchIndexState | None:
            row = session.get(SearchIndexStateRow, tenant_id)
            return _state_from_row(row) if row is not None else None

        return self._run_read(operation)

    def states(self) -> list[SearchIndexState]:
        def operation(session: Session) -> list[SearchIndexState]:
            return [_state_from_row(row) for row in session.scalars(select(SearchIndexStateRow))]

        return self._run_read(operation)

    def count(self, tenant_id: str | None = None) -> int:
        def operation(session: Session) -> int:
            statement = select(func.count()).select_from(SearchIndexEntryRow)
            if tenant_id is not None:
                statement = statement.where(SearchIndexEntryRow.tenant_id == tenant_id)
            return int(session.scalar(statement) or 0)

        return self._run_read(operation)

    def query(
        self,
        *,
        tenant_id: str,
        text: str,
        kinds: Sequence[str],
        owner_user_id: str | None = None,
        limit: int = 50,
    ) -> list[SearchIndexCandidate]:
        """Bounded LIKE candidates for one tenant; owner-scoped kinds add the owner filter.

        Every query term must appear somewhere in ``search_text``; ranking
        reuses the route's lexical score so ordering matches the scan path.
        """

        terms = [term.casefold() for term in _TOKEN_PATTERN.findall(text)]
        if not terms or not kinds:
            return []
        limit = max(1, min(int(limit), 500))

        def operation(session: Session) -> list[SearchIndexCandidate]:
            statement = select(SearchIndexEntryRow).where(
                SearchIndexEntryRow.tenant_id == tenant_id,
                SearchIndexEntryRow.kind.in_(list(kinds)),
            )
            if owner_user_id is not None:
                statement = statement.where(SearchIndexEntryRow.owner_user_id == owner_user_id)
            for term in terms:
                statement = statement.where(
                    SearchIndexEntryRow.search_text.like(f"%{_escape_like(term)}%", escape="\\")
                )
            statement = statement.order_by(SearchIndexEntryRow.source_updated_at.desc()).limit(limit)
            candidates = [
                SearchIndexCandidate(
                    kind=row.kind,
                    resource_id=row.resource_id,
                    owner_user_id=row.owner_user_id,
                    title=row.title,
                    body=row.body,
                    matter_id=row.matter_id,
                    archived=row.archived,
                    score=lexical_score(row.search_text, text),
                )
                for row in session.scalars(statement)
            ]
            candidates.sort(key=lambda item: (-item.score, item.title.casefold(), item.resource_id))
            return candidates

        return self._run_read(operation)

    # Plumbing ----------------------------------------------------------

    def _run_read(self, operation: Callable[[Session], T]) -> T:
        session = self._sessions()
        try:
            return operation(session)
        except SQLAlchemyError as exc:
            raise SearchIndexUnavailable("Search index is unavailable.") from exc
        finally:
            session.close()

    def _run_write(self, operation: Callable[[Session], T]) -> T:
        for attempt in range(5):
            try:
                with self._lock:
                    session = self._sessions()
                    try:
                        with session.begin():
                            return operation(session)
                    finally:
                        session.close()
            except OperationalError as exc:
                code = getattr(exc.orig, "sqlite_errorcode", None)
                locked = (
                    self.engine.dialect.name == "sqlite"
                    and isinstance(code, int)
                    and (code & 0xFF) in {5, 6}
                )
                if not locked or attempt == 4:
                    raise SearchIndexUnavailable("Search index is unavailable.") from exc
            except SQLAlchemyError as exc:
                raise SearchIndexUnavailable("Search index is unavailable.") from exc
        raise SearchIndexUnavailable("Search index is unavailable.")


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _state_from_row(row: SearchIndexStateRow) -> SearchIndexState:
    return SearchIndexState(
        tenant_id=row.tenant_id,
        backfill_revision=int(row.backfill_revision or 0),
        backfill_completed_at=row.backfill_completed_at,
        fts_mode=row.fts_mode,
        entry_count=int(row.entry_count or 0),
    )
