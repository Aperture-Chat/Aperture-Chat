"""Persistence for support tickets, their timelines, and the community hub.

Bound to the application engine like ``ModelAccessRequestRepository``. Three
families live here:

* Tickets (``issue_reports`` + ``issue_report_events``): what people in this
  deployment reported and every reply, note, and field change since.
* The instance-side hub link (``issue_report_upstream``): what this deployment
  shared with the community intake hub and the status the hub reports back.
* The hub queue (``support_hub_reports``): reports this deployment received
  while acting as the community intake hub.

Writes take the engine write lock and retry SQLite busy errors, so a scheduler
pass and a request handler can touch the same ticket safely.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime
from typing import Any, TypeVar
from uuid import uuid4

from sqlalchemy import delete, func, or_, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core import clock
from app.db.engine import create_session_factory, engine_write_lock
from app.db.orm import (
    IssueReportEventRow,
    IssueReportRow,
    IssueReportUpstreamRow,
    SupportHubReportRow,
    SupportSettingsRow,
)
from app.models.schemas import (
    ISSUE_REPORT_OPEN_STATUSES,
    IssueReportEvent,
    IssueReportRecord,
    IssueReportUpstream,
    SupportHubReport,
    SupportSettings,
)

T = TypeVar("T")

# Ticket fields an update may change. Anything else (reporter, text, tenant)
# is fixed at submission.
_MUTABLE_TICKET_FIELDS = frozenset(
    {
        "status",
        "priority",
        "kind",
        "assignee_user_id",
        "assignee_name",
        "resolved_at",
        "reporter_seen_at",
    }
)


class SupportStoreUnavailable(Exception):
    """The relational store could not complete a support operation."""


def new_event_id() -> str:
    return f"issue-event-{uuid4()}"


def new_hub_report_id() -> str:
    return f"hubreport-{uuid4()}"


class SupportTicketRepository:
    def __init__(
        self,
        engine: Engine,
        *,
        session_factory: sessionmaker[Session] | None = None,
    ) -> None:
        self.engine = engine
        self._sessions = session_factory or create_session_factory(engine)
        self._lock = engine_write_lock(engine)

    # Tickets -------------------------------------------------------------

    def create_report(self, report: IssueReportRecord) -> IssueReportRecord:
        """Insert a ticket, numbering it after the organization's newest one."""

        def operation(session: Session) -> IssueReportRecord:
            highest = session.scalar(
                select(func.max(IssueReportRow.number)).where(
                    IssueReportRow.tenant_id == report.tenant_id
                )
            )
            created_at = report.created_at
            row = IssueReportRow.from_model(
                report.model_copy(
                    update={
                        "number": (highest or 0) + 1,
                        "updated_at": report.updated_at or created_at,
                        "last_public_activity_at": report.last_public_activity_at or created_at,
                        "last_activity_by": report.last_activity_by or "reporter",
                        # The reporter has obviously seen their own submission.
                        "reporter_seen_at": report.reporter_seen_at or created_at,
                    }
                )
            )
            session.add(row)
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def get_report(self, report_id: str) -> IssueReportRecord | None:
        def operation(session: Session) -> IssueReportRecord | None:
            row = session.get(IssueReportRow, report_id)
            return row.to_model() if row is not None else None

        return self._run_read(operation)

    def list_reports(
        self,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        limit: int = 500,
    ) -> list[IssueReportRecord]:
        limit = max(1, min(int(limit), 2000))

        def operation(session: Session) -> list[IssueReportRecord]:
            statement = select(IssueReportRow)
            if tenant_id is not None:
                statement = statement.where(IssueReportRow.tenant_id == tenant_id)
            if user_id is not None:
                statement = statement.where(IssueReportRow.user_id == user_id)
            statement = statement.order_by(
                IssueReportRow.created_at.desc(), IssueReportRow.id
            ).limit(limit)
            return [row.to_model() for row in session.scalars(statement)]

        return self._run_read(operation)

    def update_report(
        self,
        report_id: str,
        *,
        changes: dict[str, Any] | None = None,
        events: Iterable[IssueReportEvent] = (),
        now: datetime | None = None,
    ) -> IssueReportRecord | None:
        """Apply field changes and append timeline events in one transaction.

        Public events move ``last_public_activity_at`` (the reporter's unread
        marker); replies from the reporter or support also record who spoke
        last, so the queue can show who is waiting on whom.
        """

        changes = dict(changes or {})
        unknown = set(changes) - _MUTABLE_TICKET_FIELDS
        if unknown:
            raise ValueError(f"Ticket fields cannot be changed: {sorted(unknown)}")
        pending_events = list(events)
        timestamp = now or clock.now()

        def operation(session: Session) -> IssueReportRecord | None:
            row = session.get(IssueReportRow, report_id)
            if row is None:
                return None
            for field_name, value in changes.items():
                setattr(row, field_name, value)
            touched = bool(changes)
            for event in pending_events:
                if event.report_id != report_id:
                    raise ValueError("Event belongs to another ticket.")
                session.add(IssueReportEventRow.from_model(event))
                touched = True
                if event.visibility == "public":
                    row.last_public_activity_at = event.created_at
                    # Automated hub updates are news for the reporter but
                    # don't change who the conversation is waiting on.
                    if event.actor_kind != "system":
                        row.last_activity_by = event.actor_kind
            if touched:
                row.updated_at = timestamp
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def mark_seen(self, report_id: str, *, seen_at: datetime) -> None:
        def operation(session: Session) -> None:
            row = session.get(IssueReportRow, report_id)
            if row is not None and (row.reporter_seen_at is None or row.reporter_seen_at < seen_at):
                row.reporter_seen_at = seen_at

        self._run_write(operation)

    def list_events(
        self, report_id: str, *, include_internal: bool
    ) -> list[IssueReportEvent]:
        def operation(session: Session) -> list[IssueReportEvent]:
            statement = select(IssueReportEventRow).where(
                IssueReportEventRow.report_id == report_id
            )
            if not include_internal:
                statement = statement.where(IssueReportEventRow.visibility == "public")
            statement = statement.order_by(
                IssueReportEventRow.created_at, IssueReportEventRow.id
            )
            return [row.to_model() for row in session.scalars(statement)]

        return self._run_read(operation)

    # Hub link (instance side) --------------------------------------------

    def get_upstream(self, report_id: str) -> IssueReportUpstream | None:
        def operation(session: Session) -> IssueReportUpstream | None:
            row = session.get(IssueReportUpstreamRow, report_id)
            return row.to_model() if row is not None else None

        return self._run_read(operation)

    def upstreams_for(self, report_ids: Iterable[str]) -> dict[str, IssueReportUpstream]:
        ids = sorted(set(report_ids))
        if not ids:
            return {}

        def operation(session: Session) -> dict[str, IssueReportUpstream]:
            found: dict[str, IssueReportUpstream] = {}
            # Chunk to stay well under SQLite's bound-parameter limit.
            for start in range(0, len(ids), 500):
                chunk = ids[start : start + 500]
                for row in session.scalars(
                    select(IssueReportUpstreamRow).where(
                        IssueReportUpstreamRow.report_id.in_(chunk)
                    )
                ):
                    found[row.report_id] = row.to_model()
            return found

        return self._run_read(operation)

    def save_upstream(self, link: IssueReportUpstream) -> IssueReportUpstream:
        def operation(session: Session) -> IssueReportUpstream:
            row = session.merge(IssueReportUpstreamRow.from_model(link))
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def upstreams_due(
        self,
        *,
        now: datetime,
        poll_checked_before: datetime,
        limit: int = 20,
    ) -> list[IssueReportUpstream]:
        """Links waiting to be (re)sent, or whose hub status is stale."""

        def operation(session: Session) -> list[IssueReportUpstream]:
            send_due = (IssueReportUpstreamRow.state.in_(("queued", "failed"))) & (
                (IssueReportUpstreamRow.next_attempt_at.is_(None))
                | (IssueReportUpstreamRow.next_attempt_at <= now)
            )
            # A closed GitHub issue can still be reopened, so closed links keep
            # being checked, just like open ones; declined/private links are final.
            poll_due = IssueReportUpstreamRow.state.in_(("sent", "published")) & (
                IssueReportUpstreamRow.checked_at.is_(None)
                | (IssueReportUpstreamRow.checked_at <= poll_checked_before)
            )
            statement = (
                select(IssueReportUpstreamRow)
                .where(or_(send_due, poll_due))
                .order_by(IssueReportUpstreamRow.updated_at, IssueReportUpstreamRow.report_id)
                .limit(max(1, limit))
            )
            return [row.to_model() for row in session.scalars(statement)]

        return self._run_read(operation)

    # Settings --------------------------------------------------------------

    def get_settings(self) -> SupportSettings:
        """Return the single settings row, creating defaults on first use."""

        def read(session: Session) -> SupportSettings | None:
            row = session.get(SupportSettingsRow, 1)
            return row.to_model() if row is not None else None

        existing = self._run_read(read)
        if existing is not None:
            return existing

        def create(session: Session) -> SupportSettings:
            row = session.get(SupportSettingsRow, 1)
            if row is None:
                row = SupportSettingsRow(
                    singleton_id=1,
                    upstream_mode="review",
                    # Anonymous: lets the hub group and rate-limit a deployment's
                    # reports without learning anything about it.
                    instance_id=str(uuid4()),
                    ai_model_id=None,
                    notify_reporters=True,
                    hub_enabled=False,
                    hub_repository="",
                    hub_auto_publish=False,
                    hub_ai_triage=True,
                    updated_at=clock.now(),
                )
                session.add(row)
                session.flush()
            return row.to_model()

        return self._run_write(create)

    def save_settings(self, settings: SupportSettings) -> SupportSettings:
        def operation(session: Session) -> SupportSettings:
            row = session.get(SupportSettingsRow, 1)
            if row is None:
                row = SupportSettingsRow(singleton_id=1)
                session.add(row)
            for field_name, value in settings.model_dump().items():
                setattr(row, field_name, value)
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    # Hub queue (hub side) --------------------------------------------------

    def create_hub_report(self, report: SupportHubReport) -> SupportHubReport:
        def operation(session: Session) -> SupportHubReport:
            row = SupportHubReportRow.from_model(report)
            session.add(row)
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def get_hub_report(self, report_id: str) -> SupportHubReport | None:
        def operation(session: Session) -> SupportHubReport | None:
            row = session.get(SupportHubReportRow, report_id)
            return row.to_model() if row is not None else None

        return self._run_read(operation)

    def save_hub_report(self, report: SupportHubReport) -> SupportHubReport:
        def operation(session: Session) -> SupportHubReport:
            row = session.merge(SupportHubReportRow.from_model(report))
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def list_hub_reports(
        self, *, status: str | None = None, limit: int = 500
    ) -> list[SupportHubReport]:
        limit = max(1, min(int(limit), 2000))

        def operation(session: Session) -> list[SupportHubReport]:
            statement = select(SupportHubReportRow)
            if status is not None:
                statement = statement.where(SupportHubReportRow.status == status)
            statement = statement.order_by(
                SupportHubReportRow.received_at.desc(), SupportHubReportRow.id
            ).limit(limit)
            return [row.to_model() for row in session.scalars(statement)]

        return self._run_read(operation)

    def hub_status_counts(self) -> dict[str, int]:
        def operation(session: Session) -> dict[str, int]:
            rows = session.execute(
                select(SupportHubReportRow.status, func.count()).group_by(
                    SupportHubReportRow.status
                )
            ).all()
            return {status: int(count) for status, count in rows}

        return self._run_read(operation)

    def hub_instance_counts(self, instance_ids: Iterable[str]) -> dict[str, int]:
        ids = sorted(set(instance_ids))
        if not ids:
            return {}

        def operation(session: Session) -> dict[str, int]:
            rows = session.execute(
                select(SupportHubReportRow.instance_id, func.count())
                .where(SupportHubReportRow.instance_id.in_(ids[:500]))
                .group_by(SupportHubReportRow.instance_id)
            ).all()
            return {instance_id: int(count) for instance_id, count in rows}

        return self._run_read(operation)

    def count_hub_reports_since(
        self, *, since: datetime, instance_id: str | None = None, source_hash: str | None = None
    ) -> int:
        def operation(session: Session) -> int:
            statement = select(func.count()).select_from(SupportHubReportRow).where(
                SupportHubReportRow.received_at >= since
            )
            if instance_id is not None:
                statement = statement.where(SupportHubReportRow.instance_id == instance_id)
            if source_hash is not None:
                statement = statement.where(SupportHubReportRow.source_hash == source_hash)
            return int(session.scalar(statement) or 0)

        return self._run_read(operation)

    def hub_reports_needing_triage(self, *, limit: int = 3) -> list[SupportHubReport]:
        def operation(session: Session) -> list[SupportHubReport]:
            statement = (
                select(SupportHubReportRow)
                .where(
                    SupportHubReportRow.status.in_(("pending", "private")),
                    SupportHubReportRow.triage.is_(None),
                )
                .order_by(SupportHubReportRow.received_at, SupportHubReportRow.id)
                .limit(max(1, limit))
            )
            return [row.to_model() for row in session.scalars(statement)]

        return self._run_read(operation)

    def hub_reports_for_sync(
        self, *, checked_before: datetime, limit: int = 20
    ) -> list[SupportHubReport]:
        def operation(session: Session) -> list[SupportHubReport]:
            statement = (
                select(SupportHubReportRow)
                .where(
                    SupportHubReportRow.status.in_(("published", "linked")),
                    SupportHubReportRow.issue_number.is_not(None),
                    SupportHubReportRow.issue_checked_at.is_(None)
                    | (SupportHubReportRow.issue_checked_at <= checked_before),
                )
                .order_by(SupportHubReportRow.issue_checked_at, SupportHubReportRow.id)
                .limit(max(1, limit))
            )
            return [row.to_model() for row in session.scalars(statement)]

        return self._run_read(operation)

    # Cleanup ---------------------------------------------------------------

    def purge_tenant(self, tenant_id: str) -> int:
        """Remove a deleted organization's ticket timelines and hub links.

        The ticket rows themselves (and their screenshots) are removed by the
        tenant purge in ``ApplicationStateRepository``; children go first so
        the purge never depends on cascade behavior.
        """

        def operation(session: Session) -> int:
            removed = (
                session.execute(
                    delete(IssueReportEventRow).where(IssueReportEventRow.tenant_id == tenant_id)
                ).rowcount
                or 0
            )
            removed += (
                session.execute(
                    delete(IssueReportUpstreamRow).where(
                        IssueReportUpstreamRow.tenant_id == tenant_id
                    )
                ).rowcount
                or 0
            )
            return removed

        return self._run_write(operation)

    # Transactions ----------------------------------------------------------

    def _run_read(self, operation: Callable[[Session], T]) -> T:
        session = self._sessions()
        try:
            return operation(session)
        except SQLAlchemyError as exc:
            raise SupportStoreUnavailable("Support tickets are unavailable.") from exc
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
                    raise SupportStoreUnavailable("Support tickets are unavailable.") from exc
            except SQLAlchemyError as exc:
                raise SupportStoreUnavailable("Support tickets are unavailable.") from exc
        raise SupportStoreUnavailable("Support tickets are unavailable.")


def is_open_status(status: str) -> bool:
    return status in ISSUE_REPORT_OPEN_STATUSES
