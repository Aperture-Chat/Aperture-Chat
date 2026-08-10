"""Transactional matter and private-draft persistence.

The repository has no role-based bypass. Every matter-scoped operation requires
an explicit membership row, including calls made on behalf of administrators or
platform owners. Personal resources retain an independent owner predicate, so
membership can never grant access to another user's chats, folders, or drafts.

Draft writes are explicit API operations only. This module never inspects or
imports legacy browser-local history, and every successful change appends one
immutable, sanitized snapshot under optimistic revision control.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from threading import RLock
from time import sleep
from typing import Any, TypeVar, cast

from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session, aliased, sessionmaker

from app.db.engine import create_session_factory, engine_write_lock
from app.db.orm import (
    ChatFolderRow,
    ChatThreadRow,
    DraftDocumentRow,
    DraftRevisionRow,
    MatterDeletionJobRow,
    MatterMembershipRow,
    MatterRow,
)
from app.models.matters import (
    DRAFT_SANITIZER_VERSION,
    MAX_DRAFT_LIST_LIMIT,
    MAX_DRAFT_REVISIONS,
    MAX_DRAFT_REVISION_LIST_LIMIT,
    MAX_MATTER_RETENTION_DAYS,
    SIGNED_BIGINT_MAX,
    DraftDocument,
    DraftRevision,
    DraftRevisionCapacity,
    DraftSnapshot,
    Matter,
    MatterDeletionJob,
    MatterDeletionResult,
    MatterDeletionStage,
    MatterMembership,
    draft_content_sha256,
    matter_now,
    new_draft_id,
    new_matter_id,
    normalize_draft_title,
    normalize_matter_name,
    sanitize_draft_html,
)


T = TypeVar("T")


class MatterRepositoryError(RuntimeError):
    """Base error for bounded matter/draft persistence."""


class MatterNotFound(MatterRepositoryError):
    """The tenant-scoped matter does not exist."""


class MatterAccessDenied(MatterRepositoryError):
    """The actor lacks an explicit membership for the matter."""


class MatterConflict(MatterRepositoryError):
    """A matter mutation lost optimistic concurrency or conflicts with state."""


class PrivateResourceNotFound(MatterRepositoryError):
    """The owner-scoped chat, folder, or draft does not exist."""


class DraftConflict(MatterRepositoryError):
    """A draft mutation lost optimistic concurrency or conflicts with state."""


class DraftRevisionLimitExceeded(DraftConflict):
    """A draft reached the hard history ceiling; no snapshot was discarded."""

    def __init__(self, current_revision: int) -> None:
        self.current_revision = current_revision
        self.max_revisions = MAX_DRAFT_REVISIONS
        super().__init__(
            f"This draft has reached its {MAX_DRAFT_REVISIONS}-revision storage limit. "
            "No prior revision was removed."
        )


class MatterPersistenceUnavailable(MatterRepositoryError):
    """The relational matter/draft store could not complete an operation."""


_UNSET = object()
DEFAULT_DELETION_LEASE_SECONDS = 60
MAX_DELETION_LEASE_SECONDS = 3_600


def _engine_lock(engine: Engine) -> RLock:
    # One mutex per engine, shared with every other repository on the same
    # database. A private lock here would only serialize matter writes against
    # each other while still racing usage/identity writers on the same file.
    return engine_write_lock(engine)


class MatterDraftRepository:
    """SQL-backed matter membership and private revisioned draft operations."""

    def __init__(
        self,
        engine: Engine,
        *,
        session_factory: sessionmaker[Session] | None = None,
    ) -> None:
        self.engine = engine
        self._sessions = session_factory or create_session_factory(engine)
        self._lock = _engine_lock(engine)

    # Matter workspace -------------------------------------------------

    def purge_tenant(self, tenant_id: str) -> dict[str, int]:
        """Idempotently purge all M9 current/tombstone rows for a retired tenant."""

        tenant_id = _required_id(tenant_id, "tenant_id")

        def operation(session: Session) -> dict[str, int]:
            removed_drafts = (
                session.execute(
                    delete(DraftDocumentRow).where(DraftDocumentRow.tenant_id == tenant_id)
                ).rowcount
                or 0
            )
            removed_jobs = (
                session.execute(
                    delete(MatterDeletionJobRow).where(MatterDeletionJobRow.tenant_id == tenant_id)
                ).rowcount
                or 0
            )
            removed_memberships = (
                session.execute(
                    delete(MatterMembershipRow).where(MatterMembershipRow.tenant_id == tenant_id)
                ).rowcount
                or 0
            )
            removed_matters = (
                session.execute(delete(MatterRow).where(MatterRow.tenant_id == tenant_id)).rowcount
                or 0
            )
            session.flush()
            for row_type in (
                DraftDocumentRow,
                DraftRevisionRow,
                MatterDeletionJobRow,
                MatterMembershipRow,
                MatterRow,
            ):
                remaining = session.scalar(
                    select(func.count())
                    .select_from(row_type)
                    .where(row_type.tenant_id == tenant_id)
                )
                if remaining:
                    raise MatterPersistenceUnavailable(
                        "Tenant matter cleanup did not reach an empty scope."
                    )
            return {
                "removed_drafts": int(removed_drafts),
                "removed_deletion_jobs": int(removed_jobs),
                "removed_memberships": int(removed_memberships),
                "removed_matters": int(removed_matters),
            }

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            raise MatterPersistenceUnavailable(
                "Tenant matter cleanup could not be completed."
            ) from exc

    def purge_user(self, *, tenant_id: str, user_id: str) -> dict[str, int]:
        """Remove one permanently retired user's memberships and private drafts."""

        tenant_id = _required_id(tenant_id, "tenant_id")
        user_id = _required_id(user_id, "user_id")

        def operation(session: Session) -> dict[str, int]:
            removed_drafts = (
                session.execute(
                    delete(DraftDocumentRow).where(
                        DraftDocumentRow.tenant_id == tenant_id,
                        DraftDocumentRow.owner_user_id == user_id,
                    )
                ).rowcount
                or 0
            )
            removed_memberships = (
                session.execute(
                    delete(MatterMembershipRow).where(
                        MatterMembershipRow.tenant_id == tenant_id,
                        MatterMembershipRow.member_user_id == user_id,
                    )
                ).rowcount
                or 0
            )
            session.flush()
            remaining_drafts = session.scalar(
                select(func.count())
                .select_from(DraftDocumentRow)
                .where(
                    DraftDocumentRow.tenant_id == tenant_id,
                    DraftDocumentRow.owner_user_id == user_id,
                )
            )
            remaining_memberships = session.scalar(
                select(func.count())
                .select_from(MatterMembershipRow)
                .where(
                    MatterMembershipRow.tenant_id == tenant_id,
                    MatterMembershipRow.member_user_id == user_id,
                )
            )
            if remaining_drafts or remaining_memberships:
                raise MatterPersistenceUnavailable(
                    "Permanent user matter cleanup did not reach an empty scope."
                )
            return {
                "removed_drafts": int(removed_drafts),
                "removed_memberships": int(removed_memberships),
            }

        return self._run_write(operation)

    def create_matter(
        self,
        *,
        tenant_id: str,
        name: str,
        creator_user_id: str,
        member_user_ids: Iterable[str] = (),
        retention_days: int | None = None,
        matter_id: str | None = None,
        now: datetime | None = None,
    ) -> Matter:
        tenant_id = _required_id(tenant_id, "tenant_id")
        creator_user_id = _required_id(creator_user_id, "creator_user_id")
        matter_id = _required_id(matter_id or new_matter_id(), "matter_id")
        retention_days = _retention_days(retention_days)
        timestamp = _aware_utc(now or matter_now())
        member_ids = sorted(
            {_required_id(user_id, "member_user_id") for user_id in member_user_ids}
            | {creator_user_id}
        )
        model = Matter(
            id=matter_id,
            tenant_id=tenant_id,
            name=normalize_matter_name(name),
            retention_days=retention_days,
            created_by_user_id=creator_user_id,
            version=1,
            created_at=timestamp,
            updated_at=timestamp,
        )

        def operation(session: Session) -> Matter:
            if session.get(MatterDeletionJobRow, matter_id) is not None:
                raise MatterConflict("The matter id is reserved by a durable deletion tombstone.")
            row = MatterRow.from_model(model)
            session.add(row)
            session.flush()
            for member_user_id in member_ids:
                session.add(
                    MatterMembershipRow(
                        matter_id=matter_id,
                        tenant_id=tenant_id,
                        member_user_id=member_user_id,
                        added_by_user_id=creator_user_id,
                        created_at=timestamp,
                    )
                )
            session.flush()
            return row.to_model()

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            raise MatterConflict("The matter id or membership set already exists.") from exc

    def get_matter(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
    ) -> Matter:
        matter_id, tenant_id, actor_user_id = _scope(matter_id, tenant_id, actor_user_id)
        return self._run_read(
            lambda session: self._matter_for_member(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
            ).to_model()
        )

    def list_matters(
        self,
        *,
        tenant_id: str,
        actor_user_id: str,
        limit: int = MAX_DRAFT_LIST_LIMIT,
        offset: int = 0,
    ) -> list[Matter]:
        tenant_id = _required_id(tenant_id, "tenant_id")
        actor_user_id = _required_id(actor_user_id, "actor_user_id")
        limit = _bounded_limit(limit, maximum=MAX_DRAFT_LIST_LIMIT)
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise ValueError("offset must be a nonnegative integer")

        def operation(session: Session) -> list[Matter]:
            rows = session.scalars(
                select(MatterRow)
                .join(
                    MatterMembershipRow,
                    (MatterMembershipRow.matter_id == MatterRow.id)
                    & (MatterMembershipRow.tenant_id == MatterRow.tenant_id),
                )
                .where(
                    MatterRow.tenant_id == tenant_id,
                    MatterMembershipRow.member_user_id == actor_user_id,
                )
                .order_by(MatterRow.updated_at.desc(), MatterRow.id)
                .offset(offset)
                .limit(limit)
            )
            return [row.to_model() for row in rows]

        return self._run_read(operation)

    def update_matter(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
        expected_version: int,
        name: str | None = None,
        retention_days: int | None | object = _UNSET,
        now: datetime | None = None,
    ) -> Matter:
        matter_id, tenant_id, actor_user_id = _scope(matter_id, tenant_id, actor_user_id)
        expected_version = _positive_bigint(expected_version, "expected_version")
        normalized_name = None if name is None else normalize_matter_name(name)
        validated_retention = (
            _UNSET
            if retention_days is _UNSET
            else _retention_days(cast(int | None, retention_days))
        )
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> Matter:
            current = self._matter_for_member(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
            )
            self._assert_matter_not_deleting(session, matter_id)
            self._assert_matter_version(current, expected_version)
            target_name = current.name if normalized_name is None else normalized_name
            target_retention = (
                current.retention_days
                if validated_retention is _UNSET
                else cast(int | None, validated_retention)
            )
            if target_name == current.name and target_retention == current.retention_days:
                return current.to_model()
            if timestamp < _aware_utc(current.updated_at):
                raise ValueError("Matter update time cannot move backward.")
            next_version = _next_version(current.version, "matter version")
            changed = session.execute(
                update(MatterRow)
                .where(
                    MatterRow.id == matter_id,
                    MatterRow.tenant_id == tenant_id,
                    MatterRow.version == expected_version,
                )
                .values(
                    name=target_name,
                    retention_days=target_retention,
                    version=next_version,
                    updated_at=timestamp,
                )
            ).rowcount
            if changed != 1:
                raise MatterConflict("The matter changed before this update completed.")
            return Matter(
                id=current.id,
                tenant_id=current.tenant_id,
                name=target_name,
                retention_days=target_retention,
                created_by_user_id=current.created_by_user_id,
                version=next_version,
                created_at=current.created_at,
                updated_at=timestamp,
            )

        return self._run_write(operation)

    def list_memberships(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
    ) -> list[MatterMembership]:
        matter_id, tenant_id, actor_user_id = _scope(matter_id, tenant_id, actor_user_id)

        def operation(session: Session) -> list[MatterMembership]:
            self._matter_for_member(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
            )
            rows = session.scalars(
                select(MatterMembershipRow)
                .where(
                    MatterMembershipRow.matter_id == matter_id,
                    MatterMembershipRow.tenant_id == tenant_id,
                )
                .order_by(MatterMembershipRow.created_at, MatterMembershipRow.member_user_id)
            )
            return [row.to_model() for row in rows]

        return self._run_read(operation)

    def add_member(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
        member_user_id: str,
        expected_version: int,
        now: datetime | None = None,
    ) -> Matter:
        matter_id, tenant_id, actor_user_id = _scope(matter_id, tenant_id, actor_user_id)
        member_user_id = _required_id(member_user_id, "member_user_id")
        expected_version = _positive_bigint(expected_version, "expected_version")
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> Matter:
            current = self._matter_for_member(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
            )
            self._assert_matter_not_deleting(session, matter_id)
            self._assert_matter_version(current, expected_version)
            existing = session.get(
                MatterMembershipRow,
                {"matter_id": matter_id, "member_user_id": member_user_id},
            )
            if existing is not None:
                raise MatterConflict("The user is already an explicit member of this matter.")
            next_version = self._advance_matter_version(
                session,
                current=current,
                expected_version=expected_version,
                timestamp=timestamp,
            )
            session.add(
                MatterMembershipRow(
                    matter_id=matter_id,
                    tenant_id=tenant_id,
                    member_user_id=member_user_id,
                    added_by_user_id=actor_user_id,
                    created_at=timestamp,
                )
            )
            session.flush()
            return self._matter_with_version(current, next_version, timestamp)

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            raise MatterConflict("The user is already an explicit member of this matter.") from exc

    def remove_member(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
        member_user_id: str,
        expected_version: int,
        now: datetime | None = None,
    ) -> Matter:
        matter_id, tenant_id, actor_user_id = _scope(matter_id, tenant_id, actor_user_id)
        member_user_id = _required_id(member_user_id, "member_user_id")
        expected_version = _positive_bigint(expected_version, "expected_version")
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> Matter:
            current = self._matter_for_member(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
            )
            self._assert_matter_not_deleting(session, matter_id)
            self._assert_matter_version(current, expected_version)
            membership = session.get(
                MatterMembershipRow,
                {"matter_id": matter_id, "member_user_id": member_user_id},
            )
            if membership is None or membership.tenant_id != tenant_id:
                raise MatterConflict("The user is not a member of this matter.")
            member_count = session.scalar(
                select(func.count())
                .select_from(MatterMembershipRow)
                .where(
                    MatterMembershipRow.matter_id == matter_id,
                    MatterMembershipRow.tenant_id == tenant_id,
                )
            )
            if member_count is None or member_count <= 1:
                raise MatterConflict("A matter must retain at least one explicit member.")
            next_version = self._advance_matter_version(
                session,
                current=current,
                expected_version=expected_version,
                timestamp=timestamp,
            )
            session.delete(membership)
            return self._matter_with_version(current, next_version, timestamp)

        return self._run_write(operation)

    def request_matter_deletion(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
        expected_version: int,
        now: datetime | None = None,
    ) -> MatterDeletionJob:
        """Persist a deletion intent without deleting or unlinking any work."""

        matter_id, tenant_id, actor_user_id = _scope(matter_id, tenant_id, actor_user_id)
        expected_version = _positive_bigint(expected_version, "expected_version")
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> MatterDeletionJob:
            existing = session.get(MatterDeletionJobRow, matter_id)
            if existing is not None:
                if (
                    existing.tenant_id != tenant_id
                    or existing.requested_by_user_id != actor_user_id
                ):
                    raise MatterAccessDenied("The matter deletion job is out of scope.")
                if existing.requested_matter_version != expected_version:
                    raise MatterConflict(
                        "The deletion request is already bound to another matter version."
                    )
                return existing.to_model()
            current = self._matter_for_member(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
            )
            self._assert_matter_version(current, expected_version)
            job = MatterDeletionJob(
                matter_id=matter_id,
                tenant_id=tenant_id,
                requested_by_user_id=actor_user_id,
                requested_matter_version=expected_version,
                status="pending",
                attempt_count=0,
                requested_at=timestamp,
                updated_at=timestamp,
            )
            session.add(MatterDeletionJobRow.from_model(job))
            session.flush()
            return job

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            raise MatterConflict("A matter deletion request already exists.") from exc

    def get_matter_deletion_job(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
    ) -> MatterDeletionJob | None:
        matter_id, tenant_id, actor_user_id = _scope(matter_id, tenant_id, actor_user_id)

        def operation(session: Session) -> MatterDeletionJob | None:
            row = session.get(MatterDeletionJobRow, matter_id)
            if row is None:
                return None
            if row.tenant_id != tenant_id:
                raise MatterNotFound("Unknown tenant-scoped matter deletion job.")
            if row.status == "complete":
                if row.requested_by_user_id != actor_user_id:
                    raise MatterAccessDenied("The matter deletion job is out of scope.")
            else:
                self._matter_for_member(
                    session,
                    matter_id=matter_id,
                    tenant_id=tenant_id,
                    actor_user_id=actor_user_id,
                )
            return row.to_model()

        return self._run_read(operation)

    def claim_matter_deletion(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        now: datetime | None = None,
        lease_seconds: int = DEFAULT_DELETION_LEASE_SECONDS,
    ) -> MatterDeletionJob:
        """Claim or reclaim an expired cleanup job for one bounded attempt."""

        matter_id = _required_id(matter_id, "matter_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        timestamp = _aware_utc(now or matter_now())
        if (
            isinstance(lease_seconds, bool)
            or not isinstance(lease_seconds, int)
            or lease_seconds < 1
            or lease_seconds > MAX_DELETION_LEASE_SECONDS
        ):
            raise ValueError(
                f"lease_seconds must be an integer from 1 to {MAX_DELETION_LEASE_SECONDS}"
            )
        lease_expires_at = timestamp + timedelta(seconds=lease_seconds)

        def operation(session: Session) -> MatterDeletionJob:
            row = self._deletion_job_row(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                for_update=True,
            )
            if row.status == "complete":
                return row.to_model()
            if row.status == "ready":
                return row.to_model()
            if (
                row.status == "running"
                and row.lease_expires_at is not None
                and _aware_utc(row.lease_expires_at) > timestamp
            ):
                raise MatterConflict("The matter deletion job is already leased.")
            if timestamp < _aware_utc(row.updated_at):
                raise ValueError("Deletion job time cannot move backward.")
            if row.attempt_count >= SIGNED_BIGINT_MAX:
                raise MatterConflict("The deletion job exhausted its signed-BIGINT attempts.")
            row.status = "running"
            row.attempt_count += 1
            row.updated_at = timestamp
            row.last_attempt_at = timestamp
            row.lease_expires_at = lease_expires_at
            row.last_error_stage = None
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def clear_application_matter_references(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        expected_attempt: int,
        now: datetime | None = None,
    ) -> MatterDeletionResult:
        """Atomically null SQL chat/folder/draft refs without deleting work."""

        matter_id = _required_id(matter_id, "matter_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        expected_attempt = _positive_bigint(expected_attempt, "expected_attempt")
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> MatterDeletionResult:
            job = self._active_deletion_job(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                timestamp=timestamp,
                expected_attempt=expected_attempt,
            )
            thread_ids = list(
                session.scalars(
                    select(ChatThreadRow.id)
                    .where(
                        ChatThreadRow.tenant_id == tenant_id,
                        ChatThreadRow.matter_id == matter_id,
                    )
                    .order_by(ChatThreadRow.id)
                )
            )
            folder_ids = list(
                session.scalars(
                    select(ChatFolderRow.id)
                    .where(
                        ChatFolderRow.tenant_id == tenant_id,
                        ChatFolderRow.matter_id == matter_id,
                    )
                    .order_by(ChatFolderRow.id)
                )
            )
            draft_ids = list(
                session.scalars(
                    select(DraftDocumentRow.id)
                    .where(
                        DraftDocumentRow.tenant_id == tenant_id,
                        DraftDocumentRow.matter_id == matter_id,
                    )
                    .order_by(DraftDocumentRow.id)
                )
            )
            session.execute(
                update(ChatThreadRow)
                .where(
                    ChatThreadRow.tenant_id == tenant_id,
                    ChatThreadRow.matter_id == matter_id,
                )
                .values(matter_id=None)
            )
            session.execute(
                update(ChatFolderRow)
                .where(
                    ChatFolderRow.tenant_id == tenant_id,
                    ChatFolderRow.matter_id == matter_id,
                )
                .values(matter_id=None)
            )
            session.execute(
                update(DraftDocumentRow)
                .where(
                    DraftDocumentRow.tenant_id == tenant_id,
                    DraftDocumentRow.matter_id == matter_id,
                )
                .values(matter_id=None)
            )
            if job.application_refs_cleared_at is None:
                job.application_refs_cleared_at = timestamp
            self._refresh_deletion_job_status(job, timestamp)
            session.flush()
            return MatterDeletionResult(
                matter_id=matter_id,
                tenant_id=tenant_id,
                unlinked_chat_thread_ids=thread_ids,
                unlinked_chat_folder_ids=folder_ids,
                unlinked_draft_ids=draft_ids,
            )

        return self._run_write(operation)

    def mark_matter_deletion_stage_cleared(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        stage: MatterDeletionStage,
        expected_attempt: int,
        now: datetime | None = None,
    ) -> MatterDeletionJob:
        """Record an idempotent external-store nulling step after it succeeds."""

        if stage not in {"review", "knowledge", "legacy"}:
            raise ValueError("External deletion stage must be review, knowledge, or legacy.")
        matter_id = _required_id(matter_id, "matter_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        expected_attempt = _positive_bigint(expected_attempt, "expected_attempt")
        timestamp = _aware_utc(now or matter_now())
        attribute = {
            "review": "review_refs_cleared_at",
            "knowledge": "knowledge_refs_cleared_at",
            "legacy": "legacy_refs_cleared_at",
        }[stage]

        def operation(session: Session) -> MatterDeletionJob:
            row = self._deletion_job_row(session, matter_id=matter_id, tenant_id=tenant_id)
            if row.status in {"ready", "complete"}:
                return row.to_model()
            row = self._active_deletion_job(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                timestamp=timestamp,
                expected_attempt=expected_attempt,
            )
            if getattr(row, attribute) is None:
                setattr(row, attribute, timestamp)
            self._refresh_deletion_job_status(row, timestamp)
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def mark_matter_deletion_failed(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        stage: MatterDeletionStage,
        expected_attempt: int,
        now: datetime | None = None,
    ) -> MatterDeletionJob:
        """Persist only a bounded failure stage, never exception/work-product text."""

        if stage not in {"application", "review", "knowledge", "legacy"}:
            raise ValueError("Unknown matter deletion stage.")
        matter_id = _required_id(matter_id, "matter_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        expected_attempt = _positive_bigint(expected_attempt, "expected_attempt")
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> MatterDeletionJob:
            row = self._active_deletion_job(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                timestamp=timestamp,
                expected_attempt=expected_attempt,
            )
            if row.status in {"ready", "complete"}:
                return row.to_model()
            row.status = "failed"
            row.updated_at = timestamp
            row.lease_expires_at = None
            row.last_error_stage = stage
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def finalize_matter_deletion(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        now: datetime | None = None,
    ) -> MatterDeletionJob:
        """Remove the empty matter container only after every nulling stage."""

        matter_id = _required_id(matter_id, "matter_id")
        tenant_id = _required_id(tenant_id, "tenant_id")
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> MatterDeletionJob:
            job = self._deletion_job_row(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                for_update=True,
            )
            if job.status == "complete":
                return job.to_model()
            if job.status != "ready" or not job.to_model().all_references_cleared:
                raise MatterConflict("Every matter reference store must be cleared first.")
            if timestamp < _aware_utc(job.updated_at):
                raise ValueError("Deletion job time cannot move backward.")
            current = self._matter_row(session, matter_id=matter_id, tenant_id=tenant_id)
            if current.version != job.requested_matter_version:
                raise MatterConflict("The matter changed after deletion was requested.")
            self._assert_no_application_refs(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
            )
            removed = session.execute(
                delete(MatterRow).where(
                    MatterRow.id == matter_id,
                    MatterRow.tenant_id == tenant_id,
                    MatterRow.version == job.requested_matter_version,
                )
            ).rowcount
            if removed != 1:
                raise MatterConflict("The matter changed before deletion completed.")
            job.status = "complete"
            job.updated_at = timestamp
            job.completed_at = timestamp
            job.lease_expires_at = None
            job.last_error_stage = None
            session.flush()
            return job.to_model()

        return self._run_write(operation)

    # Identity lifecycle coordination ---------------------------------

    def preflight_permanent_user_purge(
        self,
        *,
        tenant_id: str,
        user_id: str,
    ) -> None:
        """Fail before external cleanup if permanent M9 removal is unsafe."""

        tenant_id = _required_id(tenant_id, "tenant_id")
        user_id = _required_id(user_id, "user_id")
        self._run_read(
            lambda session: self._assert_permanent_user_purge_allowed(
                session,
                tenant_id=tenant_id,
                user_id=user_id,
            )
        )

    def purge_permanent_user(
        self,
        *,
        tenant_id: str,
        user_id: str,
    ) -> dict[str, int]:
        """Remove one user's tenant-scoped memberships and private drafts."""

        tenant_id = _required_id(tenant_id, "tenant_id")
        user_id = _required_id(user_id, "user_id")

        def operation(session: Session) -> dict[str, int]:
            counts = self._permanent_user_lifecycle_counts(
                session,
                tenant_id=tenant_id,
                user_id=user_id,
            )
            # Repeat the public preflight in this transaction immediately
            # before deletion so a stale orchestration check cannot strand a
            # matter or an in-flight deletion request.
            self._assert_permanent_user_purge_allowed(
                session,
                tenant_id=tenant_id,
                user_id=user_id,
            )
            session.execute(
                delete(DraftDocumentRow).where(
                    DraftDocumentRow.tenant_id == tenant_id,
                    DraftDocumentRow.owner_user_id == user_id,
                )
            )
            session.execute(
                delete(MatterMembershipRow).where(
                    MatterMembershipRow.tenant_id == tenant_id,
                    MatterMembershipRow.member_user_id == user_id,
                )
            )
            session.flush()
            if any(
                self._permanent_user_lifecycle_counts(
                    session,
                    tenant_id=tenant_id,
                    user_id=user_id,
                ).values()
            ):
                raise MatterPersistenceUnavailable(
                    "Permanent user matter cleanup left tenant-scoped private state."
                )
            return {
                "removed_draft_revisions": counts["draft_revisions"],
                "removed_drafts": counts["draft_documents"],
                "removed_memberships": counts["matter_memberships"],
            }

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            raise MatterPersistenceUnavailable(
                "Permanent user matter cleanup could not be completed."
            ) from exc

    # Personal-resource bindings --------------------------------------

    def bind_chat_thread(
        self,
        thread_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        matter_id: str | None,
        boundary_matter_id: str | None = None,
    ) -> None:
        self._bind_private_row(
            ChatThreadRow,
            thread_id,
            tenant_id=tenant_id,
            owner_user_id=owner_user_id,
            matter_id=matter_id,
            boundary_matter_id=boundary_matter_id,
        )

    def bind_chat_folder(
        self,
        folder_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        matter_id: str | None,
        boundary_matter_id: str | None = None,
    ) -> None:
        self._bind_private_row(
            ChatFolderRow,
            folder_id,
            tenant_id=tenant_id,
            owner_user_id=owner_user_id,
            matter_id=matter_id,
            boundary_matter_id=boundary_matter_id,
        )

    def chat_thread_ids_for_matter(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
    ) -> list[str]:
        return self._private_ids_for_matter(
            ChatThreadRow,
            matter_id,
            tenant_id=tenant_id,
            actor_user_id=actor_user_id,
        )

    def chat_folder_ids_for_matter(
        self,
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
    ) -> list[str]:
        return self._private_ids_for_matter(
            ChatFolderRow,
            matter_id,
            tenant_id=tenant_id,
            actor_user_id=actor_user_id,
        )

    # Private revisioned drafts ---------------------------------------

    def create_draft(
        self,
        *,
        tenant_id: str,
        owner_user_id: str,
        title: str,
        content: str,
        matter_id: str | None = None,
        draft_id: str | None = None,
        now: datetime | None = None,
    ) -> DraftSnapshot:
        tenant_id = _required_id(tenant_id, "tenant_id")
        owner_user_id = _required_id(owner_user_id, "owner_user_id")
        draft_id = _required_id(draft_id or new_draft_id(), "draft_id")
        matter_id = _optional_id(matter_id, "matter_id")
        title = normalize_draft_title(title)
        content = sanitize_draft_html(content)
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> DraftSnapshot:
            if matter_id is not None:
                self._matter_for_member(
                    session,
                    matter_id=matter_id,
                    tenant_id=tenant_id,
                    actor_user_id=owner_user_id,
                )
                self._assert_matter_not_deleting(session, matter_id)
            document = DraftDocument(
                id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
                matter_id=matter_id,
                title=title,
                current_revision=1,
                created_at=timestamp,
                updated_at=timestamp,
            )
            revision = self._revision_model(
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
                revision=1,
                title=title,
                content=content,
                created_at=timestamp,
            )
            session.add(DraftDocumentRow.from_model(document))
            session.add(DraftRevisionRow.from_model(revision))
            session.flush()
            return DraftSnapshot(document=document, revision=revision)

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            raise DraftConflict("Draft creation could not be completed.") from exc

    def get_draft(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
    ) -> DraftSnapshot:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        return self._run_read(
            lambda session: self._draft_snapshot(
                session,
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
            )
        )

    def get_draft_in_matter(
        self,
        draft_id: str,
        *,
        matter_id: str,
        tenant_id: str,
        actor_user_id: str,
    ) -> DraftSnapshot:
        draft_id, tenant_id, actor_user_id = _scope(draft_id, tenant_id, actor_user_id)
        matter_id = _required_id(matter_id, "matter_id")

        def operation(session: Session) -> DraftSnapshot:
            self._matter_for_member(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
            )
            snapshot = self._draft_snapshot(
                session,
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=actor_user_id,
            )
            if snapshot.document.matter_id != matter_id:
                raise PrivateResourceNotFound("The private draft is not in this matter.")
            return snapshot

        return self._run_read(operation)

    def list_drafts(
        self,
        *,
        tenant_id: str,
        owner_user_id: str,
        matter_id: str | None = None,
        limit: int = MAX_DRAFT_LIST_LIMIT,
        offset: int = 0,
    ) -> list[DraftSnapshot]:
        tenant_id = _required_id(tenant_id, "tenant_id")
        owner_user_id = _required_id(owner_user_id, "owner_user_id")
        matter_id = _optional_id(matter_id, "matter_id")
        limit = _bounded_limit(limit, maximum=MAX_DRAFT_LIST_LIMIT)
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise ValueError("offset must be a nonnegative integer")

        def operation(session: Session) -> list[DraftSnapshot]:
            if matter_id is not None:
                self._matter_for_member(
                    session,
                    matter_id=matter_id,
                    tenant_id=tenant_id,
                    actor_user_id=owner_user_id,
                )
            filters = [
                DraftDocumentRow.tenant_id == tenant_id,
                DraftDocumentRow.owner_user_id == owner_user_id,
            ]
            if matter_id is not None:
                filters.append(DraftDocumentRow.matter_id == matter_id)
            rows = session.execute(
                select(DraftDocumentRow, DraftRevisionRow)
                .join(
                    DraftRevisionRow,
                    (DraftRevisionRow.draft_id == DraftDocumentRow.id)
                    & (DraftRevisionRow.revision == DraftDocumentRow.current_revision),
                )
                .where(*filters)
                .order_by(DraftDocumentRow.updated_at.desc(), DraftDocumentRow.id)
                .offset(offset)
                .limit(limit)
            )
            return [
                DraftSnapshot(document=document.to_model(), revision=revision.to_model())
                for document, revision in rows
            ]

        return self._run_read(operation)

    def list_draft_documents(
        self,
        *,
        tenant_id: str,
        owner_user_id: str,
        matter_id: str | None = None,
        limit: int = MAX_DRAFT_LIST_LIMIT,
        offset: int = 0,
    ) -> list[DraftDocument]:
        """List bounded private draft metadata without loading snapshot bodies."""

        tenant_id = _required_id(tenant_id, "tenant_id")
        owner_user_id = _required_id(owner_user_id, "owner_user_id")
        matter_id = _optional_id(matter_id, "matter_id")
        limit = _bounded_limit(limit, maximum=MAX_DRAFT_LIST_LIMIT)
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise ValueError("offset must be a nonnegative integer")

        def operation(session: Session) -> list[DraftDocument]:
            if matter_id is not None:
                self._matter_for_member(
                    session,
                    matter_id=matter_id,
                    tenant_id=tenant_id,
                    actor_user_id=owner_user_id,
                )
            filters = [
                DraftDocumentRow.tenant_id == tenant_id,
                DraftDocumentRow.owner_user_id == owner_user_id,
            ]
            if matter_id is not None:
                filters.append(DraftDocumentRow.matter_id == matter_id)
            rows = session.scalars(
                select(DraftDocumentRow)
                .where(*filters)
                .order_by(DraftDocumentRow.updated_at.desc(), DraftDocumentRow.id)
                .offset(offset)
                .limit(limit)
            )
            return [row.to_model() for row in rows]

        return self._run_read(operation)

    def update_draft(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        expected_revision: int,
        title: str | None = None,
        content: str | None = None,
        matter_id: str | None | object = _UNSET,
        now: datetime | None = None,
    ) -> DraftSnapshot:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        expected_revision = _positive_bigint(expected_revision, "expected_revision")
        normalized_title = None if title is None else normalize_draft_title(title)
        sanitized_content = None if content is None else sanitize_draft_html(content)
        validated_matter_id = (
            _UNSET
            if matter_id is _UNSET
            else _optional_id(cast(str | None, matter_id), "matter_id")
        )
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> DraftSnapshot:
            current = self._draft_snapshot(
                session,
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
            )
            if current.document.current_revision != expected_revision:
                raise DraftConflict("The draft changed before this update completed.")
            if current.document.matter_id is not None:
                self._assert_matter_not_deleting(
                    session,
                    current.document.matter_id,
                )
            target_title = current.document.title if normalized_title is None else normalized_title
            target_content = (
                current.revision.content if sanitized_content is None else sanitized_content
            )
            if validated_matter_id is _UNSET:
                target_matter_id = current.document.matter_id
            else:
                target_matter_id = cast(str | None, validated_matter_id)
            if target_matter_id is not None:
                self._matter_for_member(
                    session,
                    matter_id=target_matter_id,
                    tenant_id=tenant_id,
                    actor_user_id=owner_user_id,
                )
                self._assert_matter_not_deleting(session, target_matter_id)
            if (
                target_title == current.document.title
                and target_content == current.revision.content
                and target_matter_id == current.document.matter_id
            ):
                return current
            if timestamp < current.document.updated_at:
                raise ValueError("Draft update time cannot move backward.")
            if expected_revision >= MAX_DRAFT_REVISIONS:
                raise DraftRevisionLimitExceeded(expected_revision)
            next_revision = expected_revision + 1
            changed = session.execute(
                update(DraftDocumentRow)
                .where(
                    DraftDocumentRow.id == draft_id,
                    DraftDocumentRow.tenant_id == tenant_id,
                    DraftDocumentRow.owner_user_id == owner_user_id,
                    DraftDocumentRow.current_revision == expected_revision,
                )
                .values(
                    title=target_title,
                    matter_id=target_matter_id,
                    current_revision=next_revision,
                    updated_at=timestamp,
                )
            ).rowcount
            if changed != 1:
                raise DraftConflict("The draft changed before this update completed.")
            revision = self._revision_model(
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
                revision=next_revision,
                title=target_title,
                content=target_content,
                created_at=timestamp,
            )
            session.add(DraftRevisionRow.from_model(revision))
            session.flush()
            document = DraftDocument(
                id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
                matter_id=target_matter_id,
                title=target_title,
                current_revision=next_revision,
                created_at=current.document.created_at,
                updated_at=timestamp,
            )
            return DraftSnapshot(document=document, revision=revision)

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            raise DraftConflict("The draft changed before this update completed.") from exc

    def list_draft_revisions(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        limit: int = MAX_DRAFT_REVISION_LIST_LIMIT,
        before_revision: int | None = None,
    ) -> list[DraftRevision]:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        limit = _bounded_limit(limit, maximum=MAX_DRAFT_REVISION_LIST_LIMIT)
        if before_revision is not None:
            before_revision = _positive_bigint(before_revision, "before_revision")

        def operation(session: Session) -> list[DraftRevision]:
            self._draft_document_for_owner(
                session,
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
            )
            filters: list[Any] = [
                DraftRevisionRow.draft_id == draft_id,
                DraftRevisionRow.tenant_id == tenant_id,
                DraftRevisionRow.owner_user_id == owner_user_id,
            ]
            if before_revision is not None:
                filters.append(DraftRevisionRow.revision < before_revision)
            rows = session.scalars(
                select(DraftRevisionRow)
                .where(*filters)
                .order_by(DraftRevisionRow.revision.desc())
                .limit(limit)
            )
            return [row.to_model() for row in rows]

        return self._run_read(operation)

    def draft_revision_capacity(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
    ) -> DraftRevisionCapacity:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)

        def operation(session: Session) -> DraftRevisionCapacity:
            row = self._draft_document_for_owner(
                session,
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
            )
            return DraftRevisionCapacity(
                current_revision=row.current_revision,
                max_revisions=MAX_DRAFT_REVISIONS,
                remaining_revisions=MAX_DRAFT_REVISIONS - row.current_revision,
            )

        return self._run_read(operation)

    def restore_draft_revision(
        self,
        draft_id: str,
        revision: int,
        *,
        tenant_id: str,
        owner_user_id: str,
        expected_revision: int,
        now: datetime | None = None,
    ) -> DraftSnapshot:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        revision = _positive_bigint(revision, "revision")

        def load(session: Session) -> DraftRevision:
            self._draft_document_for_owner(
                session,
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
            )
            row = session.get(
                DraftRevisionRow,
                {"draft_id": draft_id, "revision": revision},
            )
            if row is None or row.tenant_id != tenant_id or row.owner_user_id != owner_user_id:
                raise PrivateResourceNotFound("Unknown private draft revision.")
            return row.to_model()

        target = self._run_read(load)
        return self.update_draft(
            draft_id,
            tenant_id=tenant_id,
            owner_user_id=owner_user_id,
            expected_revision=expected_revision,
            title=target.title,
            content=target.content,
            now=now,
        )

    def delete_draft(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        expected_revision: int,
    ) -> DraftDocument:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        expected_revision = _positive_bigint(expected_revision, "expected_revision")

        def operation(session: Session) -> DraftDocument:
            row = self._draft_document_for_owner(
                session,
                draft_id=draft_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
            )
            if row.matter_id is not None:
                self._assert_matter_not_deleting(session, row.matter_id)
            if row.current_revision != expected_revision:
                raise DraftConflict("The draft changed before deletion completed.")
            model = row.to_model()
            removed = session.execute(
                delete(DraftDocumentRow).where(
                    DraftDocumentRow.id == draft_id,
                    DraftDocumentRow.tenant_id == tenant_id,
                    DraftDocumentRow.owner_user_id == owner_user_id,
                    DraftDocumentRow.current_revision == expected_revision,
                )
            ).rowcount
            if removed != 1:
                raise DraftConflict("The draft changed before deletion completed.")
            return model

        return self._run_write(operation)

    def search_drafts(
        self,
        query: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        limit: int = 50,
    ) -> list[DraftSnapshot]:
        tenant_id = _required_id(tenant_id, "tenant_id")
        owner_user_id = _required_id(owner_user_id, "owner_user_id")
        query = " ".join(_required_id(query, "query").split())
        if len(query) > 500:
            raise ValueError("query is limited to 500 characters")
        limit = _bounded_limit(limit, maximum=MAX_DRAFT_LIST_LIMIT)
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"

        def operation(session: Session) -> list[DraftSnapshot]:
            rows = session.execute(
                select(DraftDocumentRow, DraftRevisionRow)
                .join(
                    DraftRevisionRow,
                    (DraftRevisionRow.draft_id == DraftDocumentRow.id)
                    & (DraftRevisionRow.revision == DraftDocumentRow.current_revision),
                )
                .where(
                    DraftDocumentRow.tenant_id == tenant_id,
                    DraftDocumentRow.owner_user_id == owner_user_id,
                    (
                        DraftDocumentRow.title.ilike(pattern, escape="\\")
                        | DraftRevisionRow.content.ilike(pattern, escape="\\")
                    ),
                )
                .order_by(DraftDocumentRow.updated_at.desc(), DraftDocumentRow.id)
                .limit(limit)
            )
            return [
                DraftSnapshot(document=document.to_model(), revision=revision.to_model())
                for document, revision in rows
            ]

        return self._run_read(operation)

    # Internal guards --------------------------------------------------

    @staticmethod
    def _permanent_user_lifecycle_counts(
        session: Session,
        *,
        tenant_id: str,
        user_id: str,
    ) -> dict[str, int]:
        predicates = (
            (
                DraftRevisionRow,
                (DraftRevisionRow.tenant_id == tenant_id)
                & (DraftRevisionRow.owner_user_id == user_id),
            ),
            (
                DraftDocumentRow,
                (DraftDocumentRow.tenant_id == tenant_id)
                & (DraftDocumentRow.owner_user_id == user_id),
            ),
            (
                MatterMembershipRow,
                (MatterMembershipRow.tenant_id == tenant_id)
                & (MatterMembershipRow.member_user_id == user_id),
            ),
        )
        return {
            row_type.__tablename__: int(
                session.scalar(select(func.count()).select_from(row_type).where(predicate)) or 0
            )
            for row_type, predicate in predicates
        }

    @staticmethod
    def _assert_permanent_user_purge_allowed(
        session: Session,
        *,
        tenant_id: str,
        user_id: str,
    ) -> None:
        active_request = session.scalar(
            select(MatterDeletionJobRow.matter_id)
            .where(
                MatterDeletionJobRow.tenant_id == tenant_id,
                MatterDeletionJobRow.requested_by_user_id == user_id,
                MatterDeletionJobRow.status != "complete",
            )
            .limit(1)
        )
        if active_request is not None:
            raise MatterConflict(
                "Permanent user deletion is blocked by an incomplete matter deletion request."
            )

        peer = aliased(MatterMembershipRow)
        sole_membership = session.scalar(
            select(MatterMembershipRow.matter_id)
            .join(
                peer,
                (peer.matter_id == MatterMembershipRow.matter_id)
                & (peer.tenant_id == MatterMembershipRow.tenant_id),
            )
            .where(
                MatterMembershipRow.tenant_id == tenant_id,
                MatterMembershipRow.member_user_id == user_id,
            )
            .group_by(MatterMembershipRow.matter_id)
            .having(func.count(peer.member_user_id) == 1)
            .limit(1)
        )
        if sole_membership is not None:
            raise MatterConflict(
                "Permanent user deletion would leave a matter without an explicit member."
            )

    @staticmethod
    def _deletion_job_row(
        session: Session,
        *,
        matter_id: str,
        tenant_id: str,
        for_update: bool = False,
    ) -> MatterDeletionJobRow:
        statement = select(MatterDeletionJobRow).where(MatterDeletionJobRow.matter_id == matter_id)
        if for_update:
            statement = statement.with_for_update()
        row = session.scalar(statement)
        if row is None or row.tenant_id != tenant_id:
            raise MatterNotFound("Unknown tenant-scoped matter deletion job.")
        return row

    def _active_deletion_job(
        self,
        session: Session,
        *,
        matter_id: str,
        tenant_id: str,
        timestamp: datetime,
        expected_attempt: int,
    ) -> MatterDeletionJobRow:
        row = self._deletion_job_row(
            session,
            matter_id=matter_id,
            tenant_id=tenant_id,
            for_update=True,
        )
        if row.status != "running" or row.lease_expires_at is None:
            raise MatterConflict("The matter deletion job is not actively leased.")
        if _aware_utc(row.lease_expires_at) <= timestamp:
            raise MatterConflict("The matter deletion job lease expired.")
        if row.attempt_count != expected_attempt:
            raise MatterConflict("The matter deletion attempt was superseded.")
        if timestamp < _aware_utc(row.updated_at):
            raise ValueError("Deletion job time cannot move backward.")
        return row

    @staticmethod
    def _refresh_deletion_job_status(
        row: MatterDeletionJobRow,
        timestamp: datetime,
    ) -> None:
        row.updated_at = timestamp
        row.last_error_stage = None
        if all(
            value is not None
            for value in (
                row.application_refs_cleared_at,
                row.review_refs_cleared_at,
                row.knowledge_refs_cleared_at,
                row.legacy_refs_cleared_at,
            )
        ):
            row.status = "ready"
            row.lease_expires_at = None

    @staticmethod
    def _assert_matter_not_deleting(session: Session, matter_id: str) -> None:
        job = session.get(MatterDeletionJobRow, matter_id)
        if job is not None and job.status != "complete":
            raise MatterConflict("The matter is frozen while durable reference cleanup is pending.")

    @staticmethod
    def _assert_no_application_refs(
        session: Session,
        *,
        matter_id: str,
        tenant_id: str,
    ) -> None:
        for row_type in (ChatThreadRow, ChatFolderRow, DraftDocumentRow):
            reference = session.scalar(
                select(row_type.id)
                .where(
                    row_type.tenant_id == tenant_id,
                    row_type.matter_id == matter_id,
                )
                .limit(1)
            )
            if reference is not None:
                raise MatterConflict(
                    "Application database matter references reappeared before finalization."
                )

    def _bind_private_row(
        self,
        row_type: type[ChatThreadRow] | type[ChatFolderRow],
        resource_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        matter_id: str | None,
        boundary_matter_id: str | None = None,
    ) -> None:
        resource_id, tenant_id, owner_user_id = _scope(resource_id, tenant_id, owner_user_id)
        matter_id = _optional_id(matter_id, "matter_id")
        boundary_matter_id = _optional_id(boundary_matter_id, "boundary_matter_id")

        def operation(session: Session) -> None:
            row = session.scalar(
                select(row_type).where(
                    row_type.id == resource_id,
                    row_type.tenant_id == tenant_id,
                    row_type.owner_user_id == owner_user_id,
                )
            )
            if row is None:
                raise PrivateResourceNotFound("Unknown private matter resource.")
            if boundary_matter_id is not None:
                # The caller's membership was checked against exactly this
                # matter; refuse to mutate an assignment that belongs to a
                # different matter's workspace.
                if matter_id is not None:
                    if row.matter_id is not None and row.matter_id != boundary_matter_id:
                        raise MatterConflict(
                            "This resource is assigned to another matter; unlink it there first."
                        )
                elif row.matter_id != boundary_matter_id:
                    raise MatterConflict("This resource is not assigned to this matter.")
            if row.matter_id is not None:
                self._assert_matter_not_deleting(session, row.matter_id)
            if matter_id is not None:
                self._matter_for_member(
                    session,
                    matter_id=matter_id,
                    tenant_id=tenant_id,
                    actor_user_id=owner_user_id,
                )
                self._assert_matter_not_deleting(session, matter_id)
            row.matter_id = matter_id
            session.flush()

        self._run_write(operation)

    def _private_ids_for_matter(
        self,
        row_type: type[ChatThreadRow] | type[ChatFolderRow],
        matter_id: str,
        *,
        tenant_id: str,
        actor_user_id: str,
    ) -> list[str]:
        matter_id, tenant_id, actor_user_id = _scope(matter_id, tenant_id, actor_user_id)

        def operation(session: Session) -> list[str]:
            self._matter_for_member(
                session,
                matter_id=matter_id,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
            )
            return list(
                session.scalars(
                    select(row_type.id)
                    .where(
                        row_type.tenant_id == tenant_id,
                        row_type.owner_user_id == actor_user_id,
                        row_type.matter_id == matter_id,
                    )
                    .order_by(row_type.id)
                )
            )

        return self._run_read(operation)

    @staticmethod
    def _matter_row(session: Session, *, matter_id: str, tenant_id: str) -> MatterRow:
        row = session.scalar(
            select(MatterRow).where(
                MatterRow.id == matter_id,
                MatterRow.tenant_id == tenant_id,
            )
        )
        if row is None:
            raise MatterNotFound("Unknown tenant-scoped matter.")
        return row

    def _matter_for_member(
        self,
        session: Session,
        *,
        matter_id: str,
        tenant_id: str,
        actor_user_id: str,
    ) -> MatterRow:
        row = self._matter_row(session, matter_id=matter_id, tenant_id=tenant_id)
        membership = session.get(
            MatterMembershipRow,
            {"matter_id": matter_id, "member_user_id": actor_user_id},
        )
        if membership is None or membership.tenant_id != tenant_id:
            raise MatterAccessDenied("Explicit matter membership is required.")
        return row

    @staticmethod
    def _assert_matter_version(row: MatterRow, expected_version: int) -> None:
        if row.version != expected_version:
            raise MatterConflict("The matter changed before this mutation completed.")

    @staticmethod
    def _matter_with_version(
        current: MatterRow,
        version: int,
        updated_at: datetime,
    ) -> Matter:
        return Matter(
            id=current.id,
            tenant_id=current.tenant_id,
            name=current.name,
            retention_days=current.retention_days,
            created_by_user_id=current.created_by_user_id,
            version=version,
            created_at=current.created_at,
            updated_at=updated_at,
        )

    @staticmethod
    def _advance_matter_version(
        session: Session,
        *,
        current: MatterRow,
        expected_version: int,
        timestamp: datetime,
    ) -> int:
        if timestamp < _aware_utc(current.updated_at):
            raise ValueError("Matter update time cannot move backward.")
        next_version = _next_version(expected_version, "matter version")
        changed = session.execute(
            update(MatterRow)
            .where(
                MatterRow.id == current.id,
                MatterRow.tenant_id == current.tenant_id,
                MatterRow.version == expected_version,
            )
            .values(version=next_version, updated_at=timestamp)
        ).rowcount
        if changed != 1:
            raise MatterConflict("The matter changed before this mutation completed.")
        return next_version

    @staticmethod
    def _draft_document_for_owner(
        session: Session,
        *,
        draft_id: str,
        tenant_id: str,
        owner_user_id: str,
    ) -> DraftDocumentRow:
        row = session.scalar(
            select(DraftDocumentRow).where(
                DraftDocumentRow.id == draft_id,
                DraftDocumentRow.tenant_id == tenant_id,
                DraftDocumentRow.owner_user_id == owner_user_id,
            )
        )
        if row is None:
            raise PrivateResourceNotFound("Unknown private draft.")
        return row

    def _draft_snapshot(
        self,
        session: Session,
        *,
        draft_id: str,
        tenant_id: str,
        owner_user_id: str,
    ) -> DraftSnapshot:
        document = self._draft_document_for_owner(
            session,
            draft_id=draft_id,
            tenant_id=tenant_id,
            owner_user_id=owner_user_id,
        )
        revision = session.get(
            DraftRevisionRow,
            {"draft_id": draft_id, "revision": document.current_revision},
        )
        if (
            revision is None
            or revision.tenant_id != tenant_id
            or revision.owner_user_id != owner_user_id
        ):
            raise MatterPersistenceUnavailable("The current draft revision is missing.")
        return DraftSnapshot(
            document=document.to_model(),
            revision=revision.to_model(),
        )

    @staticmethod
    def _revision_model(
        *,
        draft_id: str,
        tenant_id: str,
        owner_user_id: str,
        revision: int,
        title: str,
        content: str,
        created_at: datetime,
    ) -> DraftRevision:
        return DraftRevision(
            draft_id=draft_id,
            tenant_id=tenant_id,
            owner_user_id=owner_user_id,
            revision=revision,
            title=title,
            content=content,
            content_sha256=draft_content_sha256(content),
            sanitizer_version=DRAFT_SANITIZER_VERSION,
            created_at=created_at,
        )

    def _run_read(self, operation: Callable[[Session], T]) -> T:
        session = self._sessions()
        try:
            return operation(session)
        except MatterRepositoryError:
            raise
        except (TypeError, ValueError) as exc:
            raise MatterPersistenceUnavailable(
                "Stored matter or draft state failed validation."
            ) from exc
        except SQLAlchemyError as exc:
            raise MatterPersistenceUnavailable("Matter persistence is unavailable.") from exc
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
            except MatterRepositoryError:
                raise
            except (TypeError, ValueError) as exc:
                raise MatterPersistenceUnavailable(
                    "Stored matter or draft state failed validation."
                ) from exc
            except IntegrityError:
                raise
            except OperationalError as exc:
                sqlite_error_code = getattr(exc.orig, "sqlite_errorcode", None)
                locked_sqlite = (
                    self.engine.dialect.name == "sqlite"
                    and isinstance(sqlite_error_code, int)
                    and (sqlite_error_code & 0xFF) in {5, 6}
                )
                if not locked_sqlite or attempt == 4:
                    raise MatterPersistenceUnavailable(
                        "Matter persistence is unavailable."
                    ) from exc
                sleep(0.01 * (attempt + 1))
            except SQLAlchemyError as exc:
                raise MatterPersistenceUnavailable("Matter persistence is unavailable.") from exc
        raise MatterPersistenceUnavailable("Matter persistence retry loop exited unexpectedly.")


def _scope(resource_id: str, tenant_id: str, actor_user_id: str) -> tuple[str, str, str]:
    return (
        _required_id(resource_id, "resource_id"),
        _required_id(tenant_id, "tenant_id"),
        _required_id(actor_user_id, "actor_user_id"),
    )


def _required_id(value: str, label: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{label} must be a string")
    value = value.strip()
    if not value:
        raise ValueError(f"{label} cannot be blank")
    if len(value) > 255 or "\x00" in value:
        raise ValueError(f"{label} is invalid")
    return value


def _optional_id(value: str | None, label: str) -> str | None:
    return None if value is None else _required_id(value, label)


def _retention_days(value: int | None) -> int | None:
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 1
        or value > MAX_MATTER_RETENTION_DAYS
    ):
        raise ValueError(
            f"retention_days must be null or an integer from 1 to {MAX_MATTER_RETENTION_DAYS}"
        )
    return value


def _positive_bigint(value: int, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 1
        or value > SIGNED_BIGINT_MAX
    ):
        raise ValueError(f"{label} must be a positive signed-BIGINT integer")
    return value


def _next_version(value: int, label: str) -> int:
    current = _positive_bigint(value, label)
    if current == SIGNED_BIGINT_MAX:
        raise MatterConflict(f"{label} has reached the signed-BIGINT limit.")
    return current + 1


def _bounded_limit(value: int, *, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum:
        raise ValueError(f"limit must be an integer from 1 to {maximum}")
    return value


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Matter and draft timestamps must be timezone-aware.")
    return value.astimezone(UTC)
