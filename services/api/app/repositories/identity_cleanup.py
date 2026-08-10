"""Durable identity cleanup jobs and temporary vector cutover recovery state.

Cleanup jobs are privacy-minimal tombstones: they contain scope, lifecycle
clocks, attempt fencing, and exact tenant user/session cutoffs, but no work
product or secrets. The separately bounded vector journal is used only while
moving a verified v4 knowledge payload into vector authority; it is never a
search or routing source.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from types import MappingProxyType
from typing import Any, Literal, TypeVar, cast
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import or_, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.db.engine import HEAD_REVISION, create_session_factory
from app.db.knowledge_import_state import (
    KnowledgeImportStateError,
    knowledge_semantic_digest,
)
from app.db.orm import (
    CutoverVectorSourceConsumedRow,
    CutoverVectorSourceJournalRow,
    IdentityCleanupJobRow,
    IdentityCleanupJobUserRow,
)
from app.models.schemas import KnowledgeChunk, KnowledgeDocument


CleanupResourceKind = Literal["tenant", "user", "knowledge_config"]
CleanupStatus = Literal["pending", "running", "failed", "complete"]
CleanupStage = Literal["identity", "application", "review", "knowledge_vector", "m9"]

SIGNED_BIGINT_MAX = 9_223_372_036_854_775_807
DEFAULT_CLEANUP_LEASE_SECONDS = 60
MAX_CLEANUP_LEASE_SECONDS = 3_600
MAX_RESUMABLE_CLEANUP_JOBS = 1_000
MAX_VECTOR_JOURNAL_DOCUMENTS = 100_000
MAX_VECTOR_JOURNAL_CHUNKS = 2_000_000
MAX_VECTOR_JOURNAL_BYTES = 512 * 1024 * 1024
VECTOR_JOURNAL_FORMAT = "aperture-cutover-vector-source-journal-v1"

_STAGES: tuple[CleanupStage, ...] = (
    "identity",
    "application",
    "review",
    "knowledge_vector",
    "m9",
)
_STAGE_ATTRIBUTES: dict[CleanupStage, str] = {
    "identity": "identity_committed_at",
    "application": "application_cleared_at",
    "review": "review_cleared_at",
    "knowledge_vector": "knowledge_vector_cleared_at",
    "m9": "m9_cleared_at",
}

T = TypeVar("T")


class IdentityCleanupRepositoryError(RuntimeError):
    """Base error for cleanup and cutover-journal persistence."""


class CleanupJobNotFound(IdentityCleanupRepositoryError):
    """The exact tenant-scoped cleanup generation does not exist."""


class CleanupJobConflict(IdentityCleanupRepositoryError):
    """A cleanup job conflicts with a lease, generation, or stage fence."""


class VectorSourceJournalConflict(IdentityCleanupRepositoryError):
    """A source digest is already bound to different vector material."""


class VectorSourceJournalCorruption(IdentityCleanupRepositoryError):
    """Persisted vector recovery material failed strict integrity checks."""


class IdentityCleanupPersistenceError(IdentityCleanupRepositoryError):
    """The database could not complete a cleanup repository operation."""


@dataclass(frozen=True, slots=True)
class IdentityCleanupJob:
    job_id: str
    resource_kind: CleanupResourceKind
    resource_id: str
    generation: int
    tenant_id: str
    status: CleanupStatus
    attempt_count: int
    requested_at: datetime
    updated_at: datetime
    last_attempt_at: datetime | None
    lease_expires_at: datetime | None
    identity_committed_at: datetime | None
    application_cleared_at: datetime | None
    review_cleared_at: datetime | None
    knowledge_vector_cleared_at: datetime | None
    m9_cleared_at: datetime | None
    completed_at: datetime | None
    last_error_stage: CleanupStage | None
    user_session_cutoffs: Mapping[str, int]

    @property
    def next_stage(self) -> CleanupStage | None:
        for stage in _STAGES:
            if getattr(self, _STAGE_ATTRIBUTES[stage]) is None:
                return stage
        return None


@dataclass(frozen=True, slots=True)
class CutoverVectorSourceJournal:
    source_digest: str
    knowledge_digest: str
    journal_digest: str
    documents: Mapping[str, tuple[KnowledgeDocument, ...]]
    chunks: Mapping[str, tuple[KnowledgeChunk, ...]]
    document_count: int
    chunk_count: int
    created_at: datetime


class IdentityCleanupRepository:
    """Atomic cleanup lifecycle and one-use vector recovery journal APIs."""

    def __init__(
        self,
        engine: Engine,
        *,
        session_factory: sessionmaker[Session] | None = None,
    ) -> None:
        self.engine = engine
        self._sessions = session_factory or create_session_factory(engine)

    def create_cleanup_job(
        self,
        *,
        resource_kind: CleanupResourceKind,
        resource_id: str,
        tenant_id: str,
        user_session_cutoffs: Mapping[str, int],
        job_id: str | None = None,
        now: datetime | None = None,
    ) -> IdentityCleanupJob:
        """Create one active resource generation, or return its exact retry."""

        resource_kind = _resource_kind(resource_kind)
        resource_id = _required_id(resource_id, "resource_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        if resource_kind == "tenant" and resource_id != tenant_id:
            raise ValueError("A tenant cleanup resource_id must equal tenant_id.")
        cutoffs = _user_cutoffs(user_session_cutoffs)
        if resource_kind == "user" and set(cutoffs) != {resource_id}:
            raise ValueError("User cleanup must capture its exact session cutoff.")
        if resource_kind == "knowledge_config" and cutoffs:
            raise ValueError("Knowledge cleanup cannot capture user session cutoffs.")
        requested_job_id = _required_id(
            job_id or f"identity-cleanup-{uuid4()}",
            "job_id",
        )
        timestamp = _aware_utc(now or datetime.now(UTC), "now")

        def operation(session: Session) -> IdentityCleanupJob:
            _require_live_schema(session)
            return create_cleanup_job_in_session(
                session,
                resource_kind=resource_kind,
                resource_id=resource_id,
                tenant_id=tenant_id,
                user_session_cutoffs=cutoffs,
                job_id=requested_job_id,
                requested_at=timestamp,
            )

        return self._run_write(operation, "Cleanup job creation failed.")

    def get_cleanup_job(
        self,
        job_id: str,
        *,
        tenant_id: str,
    ) -> IdentityCleanupJob | None:
        job_id = _required_id(job_id, "job_id")
        tenant_id = _required_id(tenant_id, "tenant_id")

        def operation(session: Session) -> IdentityCleanupJob | None:
            _require_live_schema(session)
            row = session.get(IdentityCleanupJobRow, job_id)
            if row is None:
                return None
            if row.tenant_id != tenant_id:
                raise CleanupJobNotFound("Unknown tenant-scoped cleanup job.")
            return _job_from_row(session, row)

        return self._run_read(operation, "Cleanup job read failed.")

    def assert_resource_recreation_allowed(
        self,
        *,
        resource_kind: CleanupResourceKind,
        resource_id: str,
    ) -> None:
        """Fail when the resource id has any durable cleanup generation.

        Resource ids are permanently retired after destructive cross-store
        cleanup. This prevents an expired stale worker from deleting a new
        object that reused the same tenant or knowledge-config id.
        """

        resource_kind = _resource_kind(resource_kind)
        resource_id = _required_id(resource_id, "resource_id")

        def operation(session: Session) -> None:
            _require_live_schema(session)
            assert_resource_recreation_allowed_in_session(
                session,
                resource_kind=resource_kind,
                resource_id=resource_id,
            )

        self._run_write(operation, "Cleanup recreation guard failed.")

    def claim_cleanup_job(
        self,
        job_id: str,
        *,
        tenant_id: str,
        now: datetime | None = None,
        lease_seconds: int = DEFAULT_CLEANUP_LEASE_SECONDS,
    ) -> IdentityCleanupJob:
        """Claim pending/failed work or reclaim one expired attempt."""

        job_id = _required_id(job_id, "job_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        timestamp = _aware_utc(now or datetime.now(UTC), "now")
        lease_seconds = _lease_seconds(lease_seconds)
        lease_expires_at = timestamp + timedelta(seconds=lease_seconds)

        def operation(session: Session) -> IdentityCleanupJob:
            _require_live_schema(session)
            return claim_cleanup_job_in_session(
                session,
                job_id=job_id,
                tenant_id=tenant_id,
                claimed_at=timestamp,
                lease_expires_at=lease_expires_at,
            )

        return self._run_write(operation, "Cleanup job claim failed.")

    def mark_cleanup_stage(
        self,
        job_id: str,
        *,
        tenant_id: str,
        stage: CleanupStage,
        expected_attempt: int,
        now: datetime | None = None,
    ) -> IdentityCleanupJob:
        """Mark exactly the next ordered stage under an unexpired attempt."""

        job_id = _required_id(job_id, "job_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        stage = _cleanup_stage(stage)
        expected_attempt = _positive_bigint(expected_attempt, "expected_attempt")
        timestamp = _aware_utc(now or datetime.now(UTC), "now")

        def operation(session: Session) -> IdentityCleanupJob:
            _require_live_schema(session)
            return mark_cleanup_stage_in_session(
                session,
                job_id=job_id,
                tenant_id=tenant_id,
                stage=stage,
                expected_attempt=expected_attempt,
                completed_at=timestamp,
            )

        return self._run_write(operation, "Cleanup stage update failed.")

    def fail_cleanup_job(
        self,
        job_id: str,
        *,
        tenant_id: str,
        stage: CleanupStage,
        expected_attempt: int,
        now: datetime | None = None,
    ) -> IdentityCleanupJob:
        """Persist only the bounded next failure stage; never exception text."""

        job_id = _required_id(job_id, "job_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        stage = _cleanup_stage(stage)
        expected_attempt = _positive_bigint(expected_attempt, "expected_attempt")
        timestamp = _aware_utc(now or datetime.now(UTC), "now")

        def operation(session: Session) -> IdentityCleanupJob:
            _require_live_schema(session)
            row = _active_job_row(
                session,
                job_id=job_id,
                tenant_id=tenant_id,
                expected_attempt=expected_attempt,
                timestamp=timestamp,
            )
            if _next_stage(row) != stage:
                raise CleanupJobConflict("A failure must identify the exact next cleanup stage.")
            row.status = "failed"
            row.updated_at = timestamp
            row.lease_expires_at = None
            row.last_error_stage = stage
            session.flush()
            return _job_from_row(session, row)

        return self._run_write(operation, "Cleanup failure update failed.")

    def complete_cleanup_job(
        self,
        job_id: str,
        *,
        tenant_id: str,
        expected_attempt: int,
        now: datetime | None = None,
    ) -> IdentityCleanupJob:
        """Complete only a fully staged, currently fenced cleanup generation."""

        job_id = _required_id(job_id, "job_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        expected_attempt = _positive_bigint(expected_attempt, "expected_attempt")
        timestamp = _aware_utc(now or datetime.now(UTC), "now")

        def operation(session: Session) -> IdentityCleanupJob:
            _require_live_schema(session)
            row = _job_row(session, job_id=job_id, tenant_id=tenant_id, for_update=True)
            if row.attempt_count != expected_attempt:
                raise CleanupJobConflict("The cleanup attempt was superseded.")
            if row.status == "complete":
                return _job_from_row(session, row)
            row = _require_active_row(row, expected_attempt=expected_attempt, timestamp=timestamp)
            if _next_stage(row) is not None:
                raise CleanupJobConflict("Every cleanup stage must finish before completion.")
            row.status = "complete"
            row.updated_at = timestamp
            row.lease_expires_at = None
            row.completed_at = timestamp
            row.last_error_stage = None
            session.flush()
            return _job_from_row(session, row)

        return self._run_write(operation, "Cleanup completion failed.")

    def list_resumable_cleanup_jobs(
        self,
        *,
        now: datetime | None = None,
        tenant_id: str | None = None,
        limit: int = 100,
    ) -> list[IdentityCleanupJob]:
        """List pending, failed, and expired-running jobs in stable order."""

        timestamp = _aware_utc(now or datetime.now(UTC), "now")
        if tenant_id is not None:
            tenant_id = _required_id(tenant_id, "tenant_id")
        if type(limit) is not int or not 1 <= limit <= MAX_RESUMABLE_CLEANUP_JOBS:
            raise ValueError(
                f"limit must be an integer from 1 to {MAX_RESUMABLE_CLEANUP_JOBS}."
            )

        def operation(session: Session) -> list[IdentityCleanupJob]:
            _require_live_schema(session)
            filters: list[Any] = [
                or_(
                    IdentityCleanupJobRow.status.in_(("pending", "failed")),
                    (
                        (IdentityCleanupJobRow.status == "running")
                        & (IdentityCleanupJobRow.lease_expires_at <= timestamp)
                    ),
                )
            ]
            if tenant_id is not None:
                filters.append(IdentityCleanupJobRow.tenant_id == tenant_id)
            rows = session.scalars(
                select(IdentityCleanupJobRow)
                .where(*filters)
                .order_by(IdentityCleanupJobRow.updated_at, IdentityCleanupJobRow.job_id)
                .limit(limit)
            )
            return [_job_from_row(session, row) for row in rows]

        return self._run_read(operation, "Resumable cleanup listing failed.")

    def list_incomplete_cleanup_jobs(
        self,
        *,
        limit: int = 100,
    ) -> list[IdentityCleanupJob]:
        """List every non-complete generation for single-process restart recovery."""

        if type(limit) is not int or not 1 <= limit <= MAX_RESUMABLE_CLEANUP_JOBS:
            raise ValueError(
                f"limit must be an integer from 1 to {MAX_RESUMABLE_CLEANUP_JOBS}."
            )

        def operation(session: Session) -> list[IdentityCleanupJob]:
            _require_live_schema(session)
            rows = session.scalars(
                select(IdentityCleanupJobRow)
                .where(IdentityCleanupJobRow.status != "complete")
                .order_by(IdentityCleanupJobRow.updated_at, IdentityCleanupJobRow.job_id)
                .limit(limit)
            )
            return [_job_from_row(session, row) for row in rows]

        return self._run_read(operation, "Incomplete cleanup listing failed.")

    def put_vector_source_journal(
        self,
        *,
        source_digest: str,
        knowledge_digest: str,
        documents: Mapping[str, Sequence[KnowledgeDocument]],
        chunks: Mapping[str, Sequence[KnowledgeChunk]],
        created_at: datetime | None = None,
    ) -> CutoverVectorSourceJournal:
        """Insert one canonical recovery payload, idempotently by source digest."""

        prepared = _prepare_vector_journal(
            source_digest=source_digest,
            knowledge_digest=knowledge_digest,
            documents=documents,
            chunks=chunks,
            created_at=created_at or datetime.now(UTC),
        )

        def operation(session: Session) -> CutoverVectorSourceJournal:
            _require_live_schema(session)
            return put_vector_source_journal_in_session(session, prepared=prepared)

        return self._run_write(operation, "Vector cutover journal write failed.")

    def get_vector_source_journal(
        self,
        source_digest: str,
    ) -> CutoverVectorSourceJournal | None:
        source_digest = _sha256_digest(source_digest, "source_digest")

        def operation(session: Session) -> CutoverVectorSourceJournal | None:
            _require_live_schema(session)
            row = session.get(CutoverVectorSourceJournalRow, source_digest)
            return None if row is None else _journal_from_row(row)

        return self._run_read(operation, "Vector cutover journal read failed.")

    def delete_vector_source_journal(
        self,
        source_digest: str,
        *,
        expected_knowledge_digest: str,
        expected_journal_digest: str,
        consumed_at: datetime | None = None,
    ) -> bool:
        """Delete only after revalidating exact semantic and journal bindings."""

        source_digest = _sha256_digest(source_digest, "source_digest")
        expected_knowledge_digest = _sha256_digest(
            expected_knowledge_digest,
            "expected_knowledge_digest",
        )
        expected_journal_digest = _sha256_digest(
            expected_journal_digest,
            "expected_journal_digest",
        )
        timestamp = _aware_utc(consumed_at or datetime.now(UTC), "consumed_at")

        def operation(session: Session) -> bool:
            _require_live_schema(session)
            _lock_vector_source(session, source_digest)
            consumed = session.get(CutoverVectorSourceConsumedRow, source_digest)
            if consumed is not None:
                if (
                    consumed.knowledge_digest != expected_knowledge_digest
                    or consumed.journal_digest != expected_journal_digest
                ):
                    raise VectorSourceJournalConflict(
                        "The consumed vector source has a different binding."
                    )
                return False
            row = session.scalar(
                select(CutoverVectorSourceJournalRow)
                .where(CutoverVectorSourceJournalRow.source_digest == source_digest)
                .with_for_update()
            )
            if row is None:
                return False
            current = _journal_from_row(row)
            if (
                current.knowledge_digest != expected_knowledge_digest
                or current.journal_digest != expected_journal_digest
            ):
                raise VectorSourceJournalConflict(
                    "The vector journal changed before verified deletion."
                )
            session.add(
                CutoverVectorSourceConsumedRow(
                    source_digest=source_digest,
                    knowledge_digest=expected_knowledge_digest,
                    journal_digest=expected_journal_digest,
                    consumed_at=timestamp,
                )
            )
            session.delete(row)
            session.flush()
            return True

        return self._run_write(operation, "Vector cutover journal deletion failed.")

    def _run_read(self, operation: Callable[[Session], T], failure: str) -> T:
        return self._run_transaction(operation, failure, immediate=False)

    def _run_write(self, operation: Callable[[Session], T], failure: str) -> T:
        return self._run_transaction(operation, failure, immediate=True)

    def _run_transaction(
        self,
        operation: Callable[[Session], T],
        failure: str,
        *,
        immediate: bool,
    ) -> T:
        if immediate and self.engine.dialect.name == "sqlite":
            return self._run_sqlite_immediate(operation, failure)
        session = self._sessions()
        try:
            with session.begin():
                return operation(session)
        except IdentityCleanupRepositoryError:
            session.rollback()
            raise
        except (SQLAlchemyError, TypeError, ValueError) as exc:
            session.rollback()
            raise IdentityCleanupPersistenceError(failure) from exc
        finally:
            session.close()

    def _run_sqlite_immediate(
        self,
        operation: Callable[[Session], T],
        failure: str,
    ) -> T:
        connection = self.engine.connect()
        dbapi_connection = connection.connection.driver_connection
        previous_autocommit = dbapi_connection.autocommit
        session: Session | None = None
        try:
            dbapi_connection.commit()
            dbapi_connection.autocommit = True
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            session = self._sessions(bind=connection)
            result = operation(session)
            session.flush()
            connection.exec_driver_sql("COMMIT")
            return result
        except IdentityCleanupRepositoryError:
            if dbapi_connection.in_transaction:
                connection.exec_driver_sql("ROLLBACK")
            raise
        except (SQLAlchemyError, TypeError, ValueError) as exc:
            if dbapi_connection.in_transaction:
                connection.exec_driver_sql("ROLLBACK")
            raise IdentityCleanupPersistenceError(failure) from exc
        finally:
            if session is not None:
                session.close()
            if connection.in_transaction():
                connection.rollback()
            dbapi_connection.autocommit = previous_autocommit
            connection.close()


def create_cleanup_job_in_session(
    session: Session,
    *,
    resource_kind: CleanupResourceKind,
    resource_id: str,
    tenant_id: str,
    user_session_cutoffs: Mapping[str, int],
    job_id: str,
    requested_at: datetime,
) -> IdentityCleanupJob:
    """Create/verify a cleanup intent inside the caller's SQL transaction.

    The caller must prove that ``user_session_cutoffs`` names every tenant user
    from the authoritative pre-delete identity snapshot. This helper persists
    that already-proven set with the immutable job generation; it never opens,
    commits, rolls back, or nests a transaction.
    """

    if not isinstance(session, Session):
        raise TypeError("session must be an active SQLAlchemy Session.")
    resource_kind = _resource_kind(resource_kind)
    resource_id = _required_id(resource_id, "resource_id")
    tenant_id = _required_id(tenant_id, "tenant_id")
    job_id = _required_id(job_id, "job_id")
    timestamp = _aware_utc(requested_at, "requested_at")
    if resource_kind == "tenant" and resource_id != tenant_id:
        raise ValueError("A tenant cleanup resource_id must equal tenant_id.")
    cutoffs = _user_cutoffs(user_session_cutoffs)
    if resource_kind == "user" and set(cutoffs) != {resource_id}:
        raise ValueError("User cleanup must capture its exact session cutoff.")
    if resource_kind == "knowledge_config" and cutoffs:
        raise ValueError("Knowledge cleanup cannot capture user session cutoffs.")

    _lock_resource_generation(session, resource_kind, resource_id)
    existing_id = session.get(IdentityCleanupJobRow, job_id)
    if existing_id is not None:
        existing = _job_from_row(session, existing_id)
        if (
            existing.resource_kind != resource_kind
            or existing.resource_id != resource_id
            or existing.tenant_id != tenant_id
            or dict(existing.user_session_cutoffs) != cutoffs
        ):
            raise CleanupJobConflict(
                "The supplied cleanup job id is bound to another immutable generation."
            )
        return existing

    active = session.scalar(
        select(IdentityCleanupJobRow)
        .where(
            IdentityCleanupJobRow.resource_kind == resource_kind,
            IdentityCleanupJobRow.resource_id == resource_id,
            IdentityCleanupJobRow.status != "complete",
        )
        .with_for_update()
    )
    if active is not None:
        model = _job_from_row(session, active)
        if model.tenant_id != tenant_id or dict(model.user_session_cutoffs) != cutoffs:
            raise CleanupJobConflict("The resource already has an active cleanup generation.")
        return model

    latest_generation = session.scalar(
        select(IdentityCleanupJobRow.generation)
        .where(
            IdentityCleanupJobRow.resource_kind == resource_kind,
            IdentityCleanupJobRow.resource_id == resource_id,
        )
        .order_by(IdentityCleanupJobRow.generation.desc())
        .limit(1)
        .with_for_update()
    )
    if latest_generation is not None:
        raise CleanupJobConflict(
            "The resource id was permanently retired by a completed cleanup."
        )
    generation = 1
    row = IdentityCleanupJobRow(
        job_id=job_id,
        resource_kind=resource_kind,
        resource_id=resource_id,
        generation=generation,
        tenant_id=tenant_id,
        status="pending",
        attempt_count=0,
        requested_at=timestamp,
        updated_at=timestamp,
        last_attempt_at=None,
        lease_expires_at=None,
        identity_committed_at=None,
        application_cleared_at=None,
        review_cleared_at=None,
        knowledge_vector_cleared_at=None,
        m9_cleared_at=None,
        completed_at=None,
        last_error_stage=None,
    )
    session.add(row)
    session.flush()
    for user_id, cutoff in sorted(cutoffs.items()):
        session.add(
            IdentityCleanupJobUserRow(
                job_id=job_id,
                resource_kind=resource_kind,
                user_id=user_id,
                session_cutoff_ms=cutoff,
            )
        )
    session.flush()
    return _job_from_row(session, row)


def claim_cleanup_job_in_session(
    session: Session,
    *,
    job_id: str,
    tenant_id: str,
    claimed_at: datetime,
    lease_expires_at: datetime,
) -> IdentityCleanupJob:
    """Claim/reclaim a cleanup generation without owning the transaction."""

    if not isinstance(session, Session):
        raise TypeError("session must be an active SQLAlchemy Session.")
    job_id = _required_id(job_id, "job_id")
    tenant_id = _required_id(tenant_id, "tenant_id")
    timestamp = _aware_utc(claimed_at, "claimed_at")
    lease_end = _aware_utc(lease_expires_at, "lease_expires_at")
    if lease_end <= timestamp:
        raise ValueError("lease_expires_at must follow claimed_at.")
    if (lease_end - timestamp).total_seconds() > MAX_CLEANUP_LEASE_SECONDS:
        raise ValueError("Cleanup lease exceeds its maximum duration.")
    row = _job_row(session, job_id=job_id, tenant_id=tenant_id, for_update=True)
    if row.status == "complete":
        return _job_from_row(session, row)
    if (
        row.status == "running"
        and row.lease_expires_at is not None
        and _aware_utc(row.lease_expires_at, "lease_expires_at") > timestamp
    ):
        raise CleanupJobConflict("The cleanup job is already leased.")
    _require_forward_clock(row, timestamp)
    if row.attempt_count >= SIGNED_BIGINT_MAX:
        raise CleanupJobConflict("The cleanup job exhausted its attempts.")
    row.status = "running"
    row.attempt_count += 1
    row.updated_at = timestamp
    row.last_attempt_at = timestamp
    row.lease_expires_at = lease_end
    row.last_error_stage = None
    session.flush()
    return _job_from_row(session, row)


def mark_cleanup_stage_in_session(
    session: Session,
    *,
    job_id: str,
    tenant_id: str,
    stage: CleanupStage,
    expected_attempt: int,
    completed_at: datetime,
) -> IdentityCleanupJob:
    """Mark the next fenced stage without owning the caller's transaction."""

    if not isinstance(session, Session):
        raise TypeError("session must be an active SQLAlchemy Session.")
    job_id = _required_id(job_id, "job_id")
    tenant_id = _required_id(tenant_id, "tenant_id")
    stage = _cleanup_stage(stage)
    expected_attempt = _positive_bigint(expected_attempt, "expected_attempt")
    timestamp = _aware_utc(completed_at, "completed_at")
    row = _active_job_row(
        session,
        job_id=job_id,
        tenant_id=tenant_id,
        expected_attempt=expected_attempt,
        timestamp=timestamp,
    )
    attribute = _STAGE_ATTRIBUTES[stage]
    if getattr(row, attribute) is not None:
        return _job_from_row(session, row)
    if _next_stage(row) != stage:
        raise CleanupJobConflict("Cleanup stages must complete in strict order.")
    setattr(row, attribute, timestamp)
    row.updated_at = timestamp
    session.flush()
    return _job_from_row(session, row)


def assert_resource_recreation_allowed_in_session(
    session: Session,
    *,
    resource_kind: CleanupResourceKind,
    resource_id: str,
) -> None:
    """Permanently fence a retired identity under the caller's transaction."""

    if not isinstance(session, Session):
        raise TypeError("session must be an active SQLAlchemy Session.")
    resource_kind = _resource_kind(resource_kind)
    resource_id = _required_id(resource_id, "resource_id")
    _lock_resource_generation(session, resource_kind, resource_id)
    prior = session.scalar(
        select(IdentityCleanupJobRow.job_id)
        .where(
            IdentityCleanupJobRow.resource_kind == resource_kind,
            IdentityCleanupJobRow.resource_id == resource_id,
        )
        .limit(1)
        .with_for_update()
    )
    if prior is not None:
        raise CleanupJobConflict(
            "The resource cannot be recreated after durable cleanup begins."
        )


def prepare_vector_source_journal(
    *,
    source_digest: str,
    knowledge_digest: str,
    documents: Mapping[str, Sequence[KnowledgeDocument]],
    chunks: Mapping[str, Sequence[KnowledgeChunk]],
    created_at: datetime | None = None,
) -> CutoverVectorSourceJournal:
    """Validate and bind vector recovery material before opening a transaction."""

    return _prepare_vector_journal(
        source_digest=source_digest,
        knowledge_digest=knowledge_digest,
        documents=documents,
        chunks=chunks,
        created_at=created_at or datetime.now(UTC),
    )


def put_vector_source_journal_in_session(
    session: Session,
    *,
    prepared: CutoverVectorSourceJournal,
) -> CutoverVectorSourceJournal:
    """Insert/verify a journal inside the caller's existing SQL transaction.

    The v4 identity importer calls this from the same immediate/advisory-locked
    transaction that stages its relational receipt. A crash can therefore
    expose either both staged SQL and its vector recovery material or neither.
    This helper never commits, rolls back, or creates a nested transaction.
    """

    if not isinstance(session, Session):
        raise TypeError("session must be an active SQLAlchemy Session.")
    if not isinstance(prepared, CutoverVectorSourceJournal):
        raise TypeError("prepared must be a CutoverVectorSourceJournal.")
    # Rebuild from detached models so callers cannot construct a forged
    # dataclass with unverified counts or digests.
    verified = _prepare_vector_journal(
        source_digest=prepared.source_digest,
        knowledge_digest=prepared.knowledge_digest,
        documents=prepared.documents,
        chunks=prepared.chunks,
        created_at=prepared.created_at,
    )
    if verified.journal_digest != prepared.journal_digest:
        raise VectorSourceJournalConflict("Prepared vector journal binding is invalid.")
    _lock_vector_source(session, verified.source_digest)
    if session.get(CutoverVectorSourceConsumedRow, verified.source_digest) is not None:
        raise VectorSourceJournalConflict(
            "The vector source was already consumed and cannot be journaled again."
        )
    existing = session.get(CutoverVectorSourceJournalRow, verified.source_digest)
    if existing is not None:
        current = _journal_from_row(existing)
        if current.journal_digest != verified.journal_digest:
            raise VectorSourceJournalConflict(
                "The source digest is already bound to different vector material."
            )
        return current
    document_json, chunk_json = _journal_json(verified.documents, verified.chunks)
    row = CutoverVectorSourceJournalRow(
        source_digest=verified.source_digest,
        knowledge_digest=verified.knowledge_digest,
        journal_digest=verified.journal_digest,
        documents=document_json,
        chunks=chunk_json,
        document_count=verified.document_count,
        chunk_count=verified.chunk_count,
        created_at=verified.created_at,
    )
    session.add(row)
    session.flush()
    return _journal_from_row(row)


def _require_live_schema(session: Session) -> None:
    revision = session.scalar(text("select version_num from alembic_version"))
    if revision != HEAD_REVISION:
        raise IdentityCleanupPersistenceError(
            f"Identity cleanup requires database schema {HEAD_REVISION}."
        )


def _lock_resource_generation(
    session: Session,
    resource_kind: CleanupResourceKind,
    resource_id: str,
) -> None:
    if session.bind is None or session.bind.dialect.name != "postgresql":
        return
    material = f"identity-cleanup-generation\0{resource_kind}\0{resource_id}".encode()
    lock_id = int.from_bytes(hashlib.sha256(material).digest()[:8], "big", signed=True)
    session.execute(
        text("select pg_advisory_xact_lock(:lock_id)"),
        {"lock_id": lock_id},
    )


def _lock_vector_source(session: Session, source_digest: str) -> None:
    """Serialize absent-row journal put/consume decisions on Postgres."""

    if session.bind is None or session.bind.dialect.name != "postgresql":
        return
    material = f"cutover-vector-source\0{source_digest}".encode()
    lock_id = int.from_bytes(hashlib.sha256(material).digest()[:8], "big", signed=True)
    session.execute(
        text("select pg_advisory_xact_lock(:lock_id)"),
        {"lock_id": lock_id},
    )


def _job_row(
    session: Session,
    *,
    job_id: str,
    tenant_id: str,
    for_update: bool = False,
) -> IdentityCleanupJobRow:
    statement = select(IdentityCleanupJobRow).where(IdentityCleanupJobRow.job_id == job_id)
    if for_update:
        statement = statement.with_for_update()
    row = session.scalar(statement)
    if row is None or row.tenant_id != tenant_id:
        raise CleanupJobNotFound("Unknown tenant-scoped cleanup job.")
    return row


def _active_job_row(
    session: Session,
    *,
    job_id: str,
    tenant_id: str,
    expected_attempt: int,
    timestamp: datetime,
) -> IdentityCleanupJobRow:
    row = _job_row(session, job_id=job_id, tenant_id=tenant_id, for_update=True)
    return _require_active_row(
        row,
        expected_attempt=expected_attempt,
        timestamp=timestamp,
    )


def _require_active_row(
    row: IdentityCleanupJobRow,
    *,
    expected_attempt: int,
    timestamp: datetime,
) -> IdentityCleanupJobRow:
    if row.attempt_count != expected_attempt:
        raise CleanupJobConflict("The cleanup attempt was superseded.")
    if row.status != "running" or row.lease_expires_at is None:
        raise CleanupJobConflict("The cleanup job is not actively leased.")
    if _aware_utc(row.lease_expires_at, "lease_expires_at") <= timestamp:
        raise CleanupJobConflict("The cleanup job lease expired.")
    _require_forward_clock(row, timestamp)
    return row


def _require_forward_clock(row: IdentityCleanupJobRow, timestamp: datetime) -> None:
    if timestamp < _aware_utc(row.updated_at, "updated_at"):
        raise ValueError("Cleanup job time cannot move backward.")


def _next_stage(row: IdentityCleanupJobRow) -> CleanupStage | None:
    for stage in _STAGES:
        if getattr(row, _STAGE_ATTRIBUTES[stage]) is None:
            return stage
    return None


def _job_from_row(session: Session, row: IdentityCleanupJobRow) -> IdentityCleanupJob:
    resource_kind = _resource_kind(row.resource_kind)
    status = cast(CleanupStatus, row.status)
    if status not in {"pending", "running", "failed", "complete"}:
        raise IdentityCleanupPersistenceError("Cleanup job status is corrupt.")
    user_rows = session.execute(
        select(
            IdentityCleanupJobUserRow.user_id,
            IdentityCleanupJobUserRow.session_cutoff_ms,
        )
        .where(IdentityCleanupJobUserRow.job_id == row.job_id)
        .order_by(IdentityCleanupJobUserRow.user_id)
    )
    cutoffs = {user_id: cutoff for user_id, cutoff in user_rows}
    if resource_kind == "user" and set(cutoffs) != {row.resource_id}:
        raise IdentityCleanupPersistenceError(
            "A user cleanup job does not contain its exact session cutoff."
        )
    if resource_kind == "knowledge_config" and cutoffs:
        raise IdentityCleanupPersistenceError(
            "A knowledge cleanup job contains user session cutoffs."
        )
    last_error = None if row.last_error_stage is None else _cleanup_stage(row.last_error_stage)
    model = IdentityCleanupJob(
        job_id=_required_id(row.job_id, "job_id"),
        resource_kind=resource_kind,
        resource_id=_required_id(row.resource_id, "resource_id"),
        generation=_positive_bigint(row.generation, "generation"),
        tenant_id=_required_id(row.tenant_id, "tenant_id"),
        status=status,
        attempt_count=_nonnegative_bigint(row.attempt_count, "attempt_count"),
        requested_at=_aware_utc(row.requested_at, "requested_at"),
        updated_at=_aware_utc(row.updated_at, "updated_at"),
        last_attempt_at=_optional_utc(row.last_attempt_at, "last_attempt_at"),
        lease_expires_at=_optional_utc(row.lease_expires_at, "lease_expires_at"),
        identity_committed_at=_optional_utc(
            row.identity_committed_at,
            "identity_committed_at",
        ),
        application_cleared_at=_optional_utc(
            row.application_cleared_at,
            "application_cleared_at",
        ),
        review_cleared_at=_optional_utc(row.review_cleared_at, "review_cleared_at"),
        knowledge_vector_cleared_at=_optional_utc(
            row.knowledge_vector_cleared_at,
            "knowledge_vector_cleared_at",
        ),
        m9_cleared_at=_optional_utc(row.m9_cleared_at, "m9_cleared_at"),
        completed_at=_optional_utc(row.completed_at, "completed_at"),
        last_error_stage=last_error,
        user_session_cutoffs=MappingProxyType(cutoffs),
    )
    _validate_job_model(model)
    return model


def _validate_job_model(job: IdentityCleanupJob) -> None:
    stage_values = [getattr(job, _STAGE_ATTRIBUTES[stage]) for stage in _STAGES]
    seen_gap = False
    previous = job.requested_at
    for value in stage_values:
        if value is None:
            seen_gap = True
            continue
        if seen_gap or value < previous or value > job.updated_at:
            raise IdentityCleanupPersistenceError("Cleanup stage clocks are corrupt.")
        previous = value
    if job.status == "running":
        if job.lease_expires_at is None or job.lease_expires_at <= job.updated_at:
            raise IdentityCleanupPersistenceError("Cleanup lease state is corrupt.")
    elif job.lease_expires_at is not None:
        raise IdentityCleanupPersistenceError("Cleanup lease state is corrupt.")
    if job.status == "failed" and job.last_error_stage != job.next_stage:
        raise IdentityCleanupPersistenceError("Cleanup failure stage is corrupt.")
    if job.status != "failed" and job.last_error_stage is not None:
        raise IdentityCleanupPersistenceError("Cleanup failure state is corrupt.")
    if job.status == "complete":
        if job.next_stage is not None or job.completed_at is None:
            raise IdentityCleanupPersistenceError("Cleanup completion state is corrupt.")
    elif job.completed_at is not None:
        raise IdentityCleanupPersistenceError("Cleanup completion state is corrupt.")


def _prepare_vector_journal(
    *,
    source_digest: str,
    knowledge_digest: str,
    documents: Mapping[str, Sequence[KnowledgeDocument]],
    chunks: Mapping[str, Sequence[KnowledgeChunk]],
    created_at: datetime,
) -> CutoverVectorSourceJournal:
    source_digest = _sha256_digest(source_digest, "source_digest")
    knowledge_digest = _sha256_digest(knowledge_digest, "knowledge_digest")
    normalized_documents = _normalize_model_groups(
        documents,
        model_type=KnowledgeDocument,
        label="documents",
    )
    normalized_chunks = _normalize_model_groups(
        chunks,
        model_type=KnowledgeChunk,
        label="chunks",
    )
    try:
        semantic_digest = knowledge_semantic_digest(
            normalized_documents,
            normalized_chunks,
        )
    except KnowledgeImportStateError as exc:
        raise ValueError("Vector journal knowledge payload is invalid.") from exc
    if semantic_digest != knowledge_digest:
        raise ValueError("Vector journal knowledge_digest does not match its payload.")
    document_count = sum(len(records) for records in normalized_documents.values())
    chunk_count = sum(len(records) for records in normalized_chunks.values())
    if document_count > MAX_VECTOR_JOURNAL_DOCUMENTS:
        raise ValueError("Vector journal document count exceeds its safety limit.")
    if chunk_count > MAX_VECTOR_JOURNAL_CHUNKS:
        raise ValueError("Vector journal chunk count exceeds its safety limit.")
    document_json, chunk_json = _journal_json(normalized_documents, normalized_chunks)
    journal_digest, byte_count = _vector_journal_digest(
        source_digest=source_digest,
        knowledge_digest=knowledge_digest,
        documents=document_json,
        chunks=chunk_json,
        document_count=document_count,
        chunk_count=chunk_count,
    )
    if byte_count > MAX_VECTOR_JOURNAL_BYTES:
        raise ValueError("Vector journal serialized payload exceeds its safety limit.")
    return CutoverVectorSourceJournal(
        source_digest=source_digest,
        knowledge_digest=knowledge_digest,
        journal_digest=journal_digest,
        documents=MappingProxyType(normalized_documents),
        chunks=MappingProxyType(normalized_chunks),
        document_count=document_count,
        chunk_count=chunk_count,
        created_at=_aware_utc(created_at, "created_at"),
    )


def _journal_from_row(row: CutoverVectorSourceJournalRow) -> CutoverVectorSourceJournal:
    source_digest = _sha256_digest(row.source_digest, "stored source_digest")
    knowledge_digest = _sha256_digest(row.knowledge_digest, "stored knowledge_digest")
    stored_journal_digest = _sha256_digest(row.journal_digest, "stored journal_digest")
    documents = _models_from_stored_json(
        row.documents,
        model_type=KnowledgeDocument,
        label="documents",
    )
    chunks = _models_from_stored_json(
        row.chunks,
        model_type=KnowledgeChunk,
        label="chunks",
    )
    try:
        semantic_digest = knowledge_semantic_digest(documents, chunks)
    except KnowledgeImportStateError as exc:
        raise VectorSourceJournalCorruption(
            "Stored vector journal relationships are invalid."
        ) from exc
    document_count = sum(len(records) for records in documents.values())
    chunk_count = sum(len(records) for records in chunks.values())
    if (
        semantic_digest != knowledge_digest
        or document_count != row.document_count
        or chunk_count != row.chunk_count
        or document_count > MAX_VECTOR_JOURNAL_DOCUMENTS
        or chunk_count > MAX_VECTOR_JOURNAL_CHUNKS
    ):
        raise VectorSourceJournalCorruption(
            "Stored vector journal semantic digest or counts do not match."
        )
    document_json, chunk_json = _journal_json(documents, chunks)
    computed_journal_digest, byte_count = _vector_journal_digest(
        source_digest=source_digest,
        knowledge_digest=knowledge_digest,
        documents=document_json,
        chunks=chunk_json,
        document_count=document_count,
        chunk_count=chunk_count,
    )
    if computed_journal_digest != stored_journal_digest or byte_count > MAX_VECTOR_JOURNAL_BYTES:
        raise VectorSourceJournalCorruption(
            "Stored vector journal binding digest does not match."
        )
    return CutoverVectorSourceJournal(
        source_digest=source_digest,
        knowledge_digest=knowledge_digest,
        journal_digest=stored_journal_digest,
        documents=MappingProxyType(documents),
        chunks=MappingProxyType(chunks),
        document_count=document_count,
        chunk_count=chunk_count,
        created_at=_aware_utc(row.created_at, "stored created_at"),
    )


def _normalize_model_groups(
    groups: Mapping[str, Sequence[Any]],
    *,
    model_type: type[KnowledgeDocument] | type[KnowledgeChunk],
    label: str,
) -> dict[str, tuple[Any, ...]]:
    if not isinstance(groups, Mapping):
        raise ValueError(f"Vector journal {label} must be an object.")
    normalized: dict[str, tuple[Any, ...]] = {}
    for config_id, records in groups.items():
        config_id = _required_id(config_id, f"{label} configuration id")
        if not isinstance(records, Sequence) or isinstance(records, (str, bytes, bytearray)):
            raise ValueError(f"Vector journal {label}[{config_id!r}] must be a sequence.")
        cloned: list[Any] = []
        for record in records:
            if not isinstance(record, model_type):
                raise ValueError(f"Vector journal {label} contains an invalid model.")
            cloned.append(record.model_copy(deep=True))
        normalized[config_id] = tuple(cloned)
    return dict(sorted(normalized.items()))


def _models_from_stored_json(
    groups: Any,
    *,
    model_type: type[KnowledgeDocument] | type[KnowledgeChunk],
    label: str,
) -> dict[str, tuple[Any, ...]]:
    if type(groups) is not dict:
        raise VectorSourceJournalCorruption(f"Stored vector journal {label} is not an object.")
    parsed: dict[str, tuple[Any, ...]] = {}
    for config_id, records in groups.items():
        if not isinstance(config_id, str) or not config_id or len(config_id) > 255:
            raise VectorSourceJournalCorruption(
                f"Stored vector journal {label} has an invalid configuration id."
            )
        if type(records) is not list:
            raise VectorSourceJournalCorruption(
                f"Stored vector journal {label}[{config_id!r}] is not an array."
            )
        models: list[Any] = []
        for raw in records:
            if type(raw) is not dict or set(raw).difference(model_type.model_fields):
                raise VectorSourceJournalCorruption(
                    f"Stored vector journal {label} contains unknown fields."
                )
            try:
                model = model_type.model_validate(raw, strict=True)
            except (TypeError, ValueError, ValidationError) as exc:
                raise VectorSourceJournalCorruption(
                    f"Stored vector journal {label} contains invalid metadata."
                ) from exc
            if model.model_dump(mode="json") != raw:
                raise VectorSourceJournalCorruption(
                    f"Stored vector journal {label} is not canonical."
                )
            models.append(model)
        parsed[config_id] = tuple(models)
    return dict(sorted(parsed.items()))


def _journal_json(
    documents: Mapping[str, Sequence[KnowledgeDocument]],
    chunks: Mapping[str, Sequence[KnowledgeChunk]],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    config_ids = sorted(set(documents) | set(chunks))
    document_json = {
        config_id: [record.model_dump(mode="json") for record in documents.get(config_id, ())]
        for config_id in config_ids
    }
    chunk_json = {
        config_id: [record.model_dump(mode="json") for record in chunks.get(config_id, ())]
        for config_id in config_ids
    }
    return document_json, chunk_json


def _vector_journal_digest(
    *,
    source_digest: str,
    knowledge_digest: str,
    documents: Mapping[str, Any],
    chunks: Mapping[str, Any],
    document_count: int,
    chunk_count: int,
) -> tuple[str, int]:
    payload = {
        "format": VECTOR_JOURNAL_FORMAT,
        "source_digest": source_digest,
        "knowledge_digest": knowledge_digest,
        "documents": documents,
        "chunks": chunks,
        "document_count": document_count,
        "chunk_count": chunk_count,
    }
    try:
        encoded = json.dumps(
            payload,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise VectorSourceJournalCorruption("Vector journal is not strict JSON.") from exc
    return hashlib.sha256(encoded).hexdigest(), len(encoded)


def _resource_kind(value: Any) -> CleanupResourceKind:
    if value not in {"tenant", "user", "knowledge_config"}:
        raise ValueError("resource_kind must be tenant, user, or knowledge_config.")
    return cast(CleanupResourceKind, value)


def _cleanup_stage(value: Any) -> CleanupStage:
    if value not in _STAGES:
        raise ValueError("Unknown cleanup stage.")
    return cast(CleanupStage, value)


def _user_cutoffs(value: Mapping[str, int]) -> dict[str, int]:
    if not isinstance(value, Mapping):
        raise ValueError("user_session_cutoffs must be an exact mapping.")
    cutoffs: dict[str, int] = {}
    for user_id, cutoff in value.items():
        user_id = _required_id(user_id, "user_id")
        if user_id in cutoffs:
            raise ValueError("user_session_cutoffs contains a duplicate user id.")
        cutoffs[user_id] = _nonnegative_bigint(cutoff, "session_cutoff_ms")
    return cutoffs


def _required_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 255:
        raise ValueError(f"{label} must be a non-empty string of at most 255 characters.")
    return value.strip()


def _nonnegative_bigint(value: Any, label: str) -> int:
    if type(value) is not int or not 0 <= value <= SIGNED_BIGINT_MAX:
        raise ValueError(f"{label} must fit a nonnegative signed BIGINT.")
    return value


def _positive_bigint(value: Any, label: str) -> int:
    value = _nonnegative_bigint(value, label)
    if value == 0:
        raise ValueError(f"{label} must be positive.")
    return value


def _lease_seconds(value: Any) -> int:
    if type(value) is not int or not 1 <= value <= MAX_CLEANUP_LEASE_SECONDS:
        raise ValueError(
            f"lease_seconds must be an integer from 1 to {MAX_CLEANUP_LEASE_SECONDS}."
        )
    return value


def _sha256_digest(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest.")
    return value


def _aware_utc(value: datetime, label: str) -> datetime:
    if not isinstance(value, datetime):
        raise ValueError(f"{label} must be a datetime.")
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _optional_utc(value: datetime | None, label: str) -> datetime | None:
    return None if value is None else _aware_utc(value, label)
