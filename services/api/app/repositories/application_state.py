"""Transactional SQL repository for application-owned operational state.

The repository is deliberately independent of ``SeedStore`` so the JSON-to-SQL
cutover can be wired in as a separate step.  Every public operation opens one
short transaction and is serialized by an ``RLock``.  The lock is important
for the shared connection used by SQLite ``StaticPool`` tests; production
databases still enforce correctness through their normal transaction and
constraint semantics.
"""

from __future__ import annotations

import hmac
from collections.abc import (
    Callable,
    Collection,
    Iterable,
    Iterator,
    Mapping,
    MutableMapping,
    MutableSequence,
    Sequence,
)
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock, RLock, get_ident
from time import sleep
from typing import Any, TypeVar, overload
from uuid import uuid4
from weakref import WeakKeyDictionary

from pydantic import ConfigDict
from sqlalchemy import and_, case, delete, func, or_, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, aliased, sessionmaker

from app.db.engine import (
    APPLICATION_STATE_IMPORT_REVISION,
    CHAT_STATE_IMPORT_REVISION,
    HEAD_REVISION,
    create_session_factory,
)
from app.db.orm import (
    AlertNotificationRow,
    AlertRuleRuntimeRow,
    AuditEventRow,
    AuditOutboxRow,
    ChatAttachmentRow,
    ChatFeedbackRow,
    ChatFolderRow,
    ChatStateImportRow,
    ChatThreadRow,
    ChatThreadTagRow,
    MatterRow,
    MfaPreauthChallengeRow,
    RetentionHoldRow,
    RetentionHoldThreadRow,
    RevokedSessionRow,
    RuntimeStateImportRow,
    SessionFamilyRow,
    TenantMfaPolicyRow,
    TotpPendingEnrollmentRow,
    TotpRecoveryCodeRow,
    UsageRecordRow,
    UserApiKeyRow,
    UserSessionWatermarkRow,
    UserTotpFactorRow,
)
from app.models.schemas import (
    AlertNotification,
    AuditEvent,
    ChatAttachment,
    ChatFeedbackRecord,
    ChatFolder,
    ChatSession,
    ChatThread,
    ChatThreadTag,
    RetentionHold,
    UsageRecord,
    UserApiKeyRecord,
)
from app.core.attachment_previews import delete_attachment_preview
from app.core.sessions import MAX_MFA_FACTOR_GENERATION


T = TypeVar("T")
Index = int | slice


class SessionRevocationConflictError(RuntimeError):
    """A session id was already bound to different signed claims."""


class SessionFamilyConflictError(RuntimeError):
    """A stable session id has conflicting ownership or is already revoked."""


class SessionFamilyNotCurrentError(SessionFamilyConflictError):
    """Session issuance lost a race with a valid security revocation."""


class MfaStateConflictError(RuntimeError):
    """MFA state changed or is inconsistent with the requested operation."""


class MfaChallengeInvalidError(MfaStateConflictError):
    """An MFA challenge is expired, consumed, exhausted, or mismatched."""


class MfaReplayError(MfaChallengeInvalidError):
    """A TOTP step has already been accepted for the current factor."""


@dataclass(frozen=True, slots=True)
class MfaPolicyState:
    required: bool
    generation: int


@dataclass(frozen=True, slots=True)
class TotpFactorState:
    user_id: str
    tenant_id: str | None
    generation: int
    encrypted_secret_ciphertext: str
    confirmed_at: datetime
    last_used_step: int | None


@dataclass(frozen=True, slots=True)
class MfaChallengeState:
    token_hash: str
    user_id: str
    tenant_id: str | None
    auth_method: str
    sso_config_id: str | None
    purpose: str
    expected_factor_generation: int | None
    created_at: datetime
    expires_at: datetime
    attempts: int
    max_attempts: int
    consumed_at: datetime | None
    # Live availability metadata populated by SeedStore. It is intentionally
    # not persisted on the challenge row because recovery-code consumption is
    # tracked independently and must be re-read for each response.
    recovery_codes_remaining: int = 0


@dataclass(frozen=True, slots=True)
class TotpEnrollmentState:
    enrollment_token_hash: str
    user_id: str
    tenant_id: str | None
    factor_generation: int
    auth_method: str
    sso_config_id: str | None
    source_challenge_hash: str | None
    encrypted_secret_ciphertext: str
    created_at: datetime
    expires_at: datetime
    attempts: int
    max_attempts: int
    consumed_at: datetime | None


class _EngineTransactionState:
    """Process-local ownership state shared by repositories for one engine."""

    def __init__(self) -> None:
        self.lock = RLock()
        self.references = 0
        self.active_thread_id: int | None = None


_ENGINE_STATES_GUARD = Lock()
_ENGINE_STATES: WeakKeyDictionary[Engine, _EngineTransactionState] = WeakKeyDictionary()


def _retain_engine(engine: Engine) -> _EngineTransactionState:
    with _ENGINE_STATES_GUARD:
        state = _ENGINE_STATES.get(engine)
        if state is None:
            state = _EngineTransactionState()
            _ENGINE_STATES[engine] = state
        state.references += 1
        return state


class _FrozenAuditEvent(AuditEvent):
    model_config = ConfigDict(frozen=True)


class _FrozenUsageRecord(UsageRecord):
    model_config = ConfigDict(frozen=True)


class _FrozenAlertNotification(AlertNotification):
    model_config = ConfigDict(frozen=True)


class _FrozenChatThread(ChatThread):
    model_config = ConfigDict(frozen=True)


class _FrozenChatFolder(ChatFolder):
    model_config = ConfigDict(frozen=True)


class _FrozenChatAttachment(ChatAttachment):
    model_config = ConfigDict(frozen=True)


class _FrozenUserApiKeyRecord(UserApiKeyRecord):
    model_config = ConfigDict(frozen=True)


class _FrozenChatSession(ChatSession):
    model_config = ConfigDict(frozen=True)


def _freeze_audit(event: AuditEvent) -> AuditEvent:
    return _FrozenAuditEvent.model_validate(event.model_dump(mode="python"))


def _freeze_usage(record: UsageRecord) -> UsageRecord:
    return _FrozenUsageRecord.model_validate(record.model_dump(mode="python"))


def _freeze_notification(notification: AlertNotification) -> AlertNotification:
    return _FrozenAlertNotification.model_validate(notification.model_dump(mode="python"))


def _freeze_chat_thread(thread: ChatThread) -> ChatThread:
    return _FrozenChatThread.model_validate(thread.model_dump(mode="python"))


def _freeze_chat_folder(folder: ChatFolder) -> ChatFolder:
    return _FrozenChatFolder.model_validate(folder.model_dump(mode="python"))


def _freeze_chat_attachment(attachment: ChatAttachment) -> ChatAttachment:
    return _FrozenChatAttachment.model_validate(attachment.model_dump(mode="python"))


def _freeze_user_api_key(record: UserApiKeyRecord) -> UserApiKeyRecord:
    return _FrozenUserApiKeyRecord.model_validate(record.model_dump(mode="python"))


def _chat_session_from_thread(thread: ChatThread) -> ChatSession:
    return _FrozenChatSession.model_validate(thread.model_dump(exclude={"messages"}, mode="python"))


def _model_values_equal(left: Sequence[Any], right: object, model_type: type[Any]) -> bool:
    if not isinstance(right, Sequence):
        return False
    right_values = list(right)
    if not all(isinstance(value, model_type) for value in right_values):
        return False
    return [value.model_dump(mode="python") for value in left] == [
        value.model_dump(mode="python") for value in right_values
    ]


def _validate_limit(limit: int | None) -> None:
    if limit is not None and limit < 0:
        raise ValueError("limit must be nonnegative")


def _validate_max_records(max_records: int) -> None:
    if max_records < 0:
        raise ValueError("max_records must be nonnegative")


def _retention_cutoff(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("retention cutoff must be a timezone-aware datetime")
    return value.astimezone(UTC)


def _retention_limit(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 500:
        raise ValueError("retention purge limit must be an integer from 1 to 500")
    return value


def _is_sha256_hex(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _watermark_metadata(reason: str, updated_by: str | None) -> tuple[str, str | None]:
    normalized_reason = reason.strip() if isinstance(reason, str) else ""
    if not normalized_reason or len(normalized_reason) > 255:
        raise ValueError("reason must contain between 1 and 255 characters")
    if updated_by is None:
        return normalized_reason, None
    normalized_actor = updated_by.strip() if isinstance(updated_by, str) else ""
    if not normalized_actor or len(normalized_actor) > 255:
        raise ValueError("updated_by must contain between 1 and 255 characters when provided")
    return normalized_reason, normalized_actor


def _same_tenant(column: Any, tenant_id: str | None) -> Any:
    return column.is_(None) if tenant_id is None else column == tenant_id


def _detach_mfa_factor(row: UserTotpFactorRow) -> TotpFactorState:
    return TotpFactorState(
        user_id=row.user_id,
        tenant_id=row.tenant_id,
        generation=row.generation,
        encrypted_secret_ciphertext=row.encrypted_secret_ciphertext,
        confirmed_at=row.confirmed_at,
        last_used_step=row.last_used_step,
    )


def _detach_mfa_challenge(row: MfaPreauthChallengeRow) -> MfaChallengeState:
    return MfaChallengeState(
        token_hash=row.token_hash,
        user_id=row.user_id,
        tenant_id=row.tenant_id,
        auth_method=row.auth_method,
        sso_config_id=row.sso_config_id,
        purpose=row.purpose,
        expected_factor_generation=row.expected_factor_generation,
        created_at=row.created_at,
        expires_at=row.expires_at,
        attempts=row.attempts,
        max_attempts=row.max_attempts,
        consumed_at=row.consumed_at,
    )


def _detach_totp_enrollment(row: TotpPendingEnrollmentRow) -> TotpEnrollmentState:
    return TotpEnrollmentState(
        enrollment_token_hash=row.enrollment_token_hash,
        user_id=row.user_id,
        tenant_id=row.tenant_id,
        factor_generation=row.factor_generation,
        auth_method=row.auth_method,
        sso_config_id=row.sso_config_id,
        source_challenge_hash=row.source_challenge_hash,
        encrypted_secret_ciphertext=row.encrypted_secret_ciphertext,
        created_at=row.created_at,
        expires_at=row.expires_at,
        attempts=row.attempts,
        max_attempts=row.max_attempts,
        consumed_at=row.consumed_at,
    )


def _apply_audit_model(row: AuditEventRow, event: AuditEvent) -> None:
    replacement = AuditEventRow.from_model(event)
    row.id = replacement.id
    row.tenant_id = replacement.tenant_id
    row.actor_id = replacement.actor_id
    row.actor_name = replacement.actor_name
    row.actor_role = replacement.actor_role
    row.action = replacement.action
    row.action_type = replacement.action_type
    row.target = replacement.target
    row.target_type = replacement.target_type
    row.target_name = replacement.target_name
    row.detail = replacement.detail
    row.created_at = replacement.created_at
    row.redacted = replacement.redacted
    row.event_metadata = replacement.event_metadata


def _apply_usage_model(row: UsageRecordRow, record: UsageRecord) -> None:
    replacement = UsageRecordRow.from_model(record)
    row.id = replacement.id
    row.tenant_id = replacement.tenant_id
    row.user_id = replacement.user_id
    row.user_name = replacement.user_name
    row.user_role = replacement.user_role
    row.model_id = replacement.model_id
    row.provider_name = replacement.provider_name
    row.surface = replacement.surface
    row.message_count = replacement.message_count
    row.prompt_tokens = replacement.prompt_tokens
    row.completion_tokens = replacement.completion_tokens
    row.total_tokens = replacement.total_tokens
    row.thread_id = replacement.thread_id
    row.source = replacement.source
    row.created_at = replacement.created_at


def _apply_notification_model(
    row: AlertNotificationRow,
    notification: AlertNotification,
) -> None:
    replacement = AlertNotificationRow.from_model(notification)
    row.rule_id = replacement.rule_id
    row.rule_name = replacement.rule_name
    row.scope = replacement.scope
    row.tenant_id = replacement.tenant_id
    row.event_id = replacement.event_id
    row.event_action = replacement.event_action
    row.event_severity = replacement.event_severity
    row.actor_id = replacement.actor_id
    row.actor_name = replacement.actor_name
    row.summary = replacement.summary
    row.matched_count = replacement.matched_count
    row.recipients = replacement.recipients
    row.status = replacement.status
    row.status_detail = replacement.status_detail
    row.attempts = replacement.attempts
    row.archived = replacement.archived
    row.created_at = replacement.created_at
    row.delivered_at = replacement.delivered_at


def _clone_import_marker(row: RuntimeStateImportRow) -> RuntimeStateImportRow:
    return RuntimeStateImportRow(
        source_digest=row.source_digest,
        source_version=row.source_version,
        target_version=row.target_version,
        completed_at=row.completed_at,
        audit_count=row.audit_count,
        usage_count=row.usage_count,
        outbox_count=row.outbox_count,
        alert_notification_count=row.alert_notification_count,
        alert_runtime_count=row.alert_runtime_count,
    )


def _clone_chat_import_marker(row: ChatStateImportRow) -> ChatStateImportRow:
    return ChatStateImportRow(
        source_digest=row.source_digest,
        source_version=row.source_version,
        target_version=row.target_version,
        completed_at=row.completed_at,
        prior_application_state_digest=row.prior_application_state_digest,
        thread_count=row.thread_count,
        folder_count=row.folder_count,
        attachment_count=row.attachment_count,
        api_key_count=row.api_key_count,
        watermark_count=row.watermark_count,
    )


class ApplicationStateRepository:
    """Own the SQL engine and all transactions for migrated application state."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self._sessions: sessionmaker[Session] = create_session_factory(engine)
        self._engine_state = _retain_engine(engine)
        self._closed = False
        self._closing = False

        # Compatibility adapters are stable objects so SeedStore can expose
        # them in place of its former in-memory containers.
        self.audit_events = AuditEventSequence(self)
        self.usage_records = UsageRecordSequence(self)
        self.elastic_events = AuditOutboxSequence(self)
        self.alert_notifications = AlertNotificationMapping(self)
        self.chat_threads = ChatThreadMapping(self)
        self.chat_folders = ChatFolderMapping(self)
        self.chat_sessions = ChatSessionProjection(self)
        self.chat_attachments = ChatAttachmentMapping(self)
        self.user_api_keys = UserApiKeyMapping(self)
        self.session_issued_before_ms = SessionIssuedBeforeMsMapping(self)

    @property
    def session_factory(self) -> sessionmaker[Session]:
        return self._sessions

    def run_transaction(self, operation: Callable[[Session], T]) -> T:
        """Run ``operation`` in exactly one serialized database transaction.

        Import code may use this boundary to insert several row types and the
        import receipt atomically.  The callback must use the supplied session
        directly rather than recursively opening repository operations.
        """

        thread_id = get_ident()
        state = self._engine_state
        with _ENGINE_STATES_GUARD:
            if self._closed or self._closing:
                raise RuntimeError("Application state repository is closed.")
            if state.active_thread_id == thread_id:
                raise RuntimeError(
                    "Nested application-state repository transactions are not supported."
                )

        with state.lock:
            with _ENGINE_STATES_GUARD:
                if self._closed or self._closing:
                    raise RuntimeError("Application state repository is closed.")
                if state.active_thread_id is not None:
                    raise RuntimeError("Application-state transaction ownership is inconsistent.")
                state.active_thread_id = thread_id
            session = self._sessions()
            try:
                with session.begin():
                    return operation(session)
            finally:
                try:
                    session.close()
                finally:
                    with _ENGINE_STATES_GUARD:
                        state.active_thread_id = None

    def _run_family_write_transaction(self, operation: Callable[[Session], T]) -> T:
        """Retry SQLite snapshot-upgrade conflicts for idempotent family writes."""

        for attempt in range(5):
            try:
                return self.run_transaction(operation)
            except OperationalError as exc:
                sqlite_error_code = getattr(exc.orig, "sqlite_errorcode", None)
                locked_sqlite = (
                    self.engine.dialect.name == "sqlite"
                    and isinstance(sqlite_error_code, int)
                    and (sqlite_error_code & 0xFF) in {5, 6}
                )
                if not locked_sqlite or attempt == 4:
                    raise
                sleep(0.01 * (attempt + 1))
        raise RuntimeError("Session-family write retry loop exited unexpectedly.")

    def _run_mfa_write_transaction(self, operation: Callable[[Session], T]) -> T:
        """Retry a concurrent unique-user insert as an in-place MFA replacement."""

        for attempt in range(3):
            try:
                return self.run_transaction(operation)
            except IntegrityError:
                if attempt == 2:
                    raise
                # A concurrent transaction may have inserted the unique user
                # row after our snapshot. Retry from a fresh transaction so it
                # is locked and updated without resetting its attempt budget.
                sleep(0.01 * (attempt + 1))
        raise RuntimeError("MFA write retry loop exited unexpectedly.")

    def close(self) -> None:
        """Dispose owned database resources; repeated calls are harmless."""

        state = self._engine_state
        thread_id = get_ident()
        with _ENGINE_STATES_GUARD:
            if self._closed or self._closing:
                return
            if state.active_thread_id == thread_id:
                raise RuntimeError(
                    "Cannot close an application-state repository from its active transaction."
                )
            self._closing = True

        with state.lock:
            with _ENGINE_STATES_GUARD:
                self._closed = True
                self._closing = False
                state.references -= 1
                if state.references < 0:
                    raise RuntimeError("Application-state engine reference count is invalid.")
                if state.references == 0:
                    try:
                        self.engine.dispose()
                    finally:
                        if _ENGINE_STATES.get(self.engine) is state:
                            del _ENGINE_STATES[self.engine]

    # Audit events -------------------------------------------------------

    @staticmethod
    def _audit_filters(
        *,
        tenant_id: str | None,
        tenant_visible: bool,
        excluded_actor_roles: Collection[str] | None,
        created_from: datetime | None,
        created_through: datetime | None,
    ) -> list[Any]:
        filters: list[Any] = []
        if tenant_visible:
            filters.extend(
                (
                    AuditEventRow.tenant_id.is_not(None),
                    ~AuditEventRow.action.startswith("platform."),
                    AuditEventRow.actor_role != "PLATFORM_OWNER",
                )
            )
        if tenant_id is not None:
            filters.append(AuditEventRow.tenant_id == tenant_id)
        if excluded_actor_roles:
            filters.append(AuditEventRow.actor_role.not_in(list(excluded_actor_roles)))
        if created_from is not None:
            filters.append(AuditEventRow.created_at >= created_from)
        if created_through is not None:
            filters.append(AuditEventRow.created_at <= created_through)
        return filters

    def append_audit_with_outbox(self, event: AuditEvent) -> AuditEvent:
        """Atomically append an audit event and its durable delivery item."""

        def operation(session: Session) -> AuditEvent:
            session.add(AuditEventRow.from_model(event))
            session.add(AuditOutboxRow.from_audit_event(event))
            session.flush()
            return _freeze_audit(event)

        return self.run_transaction(operation)

    def append_audit(self, event: AuditEvent) -> AuditEvent:
        """Append only the audit collection for compatibility/import helpers."""

        def operation(session: Session) -> AuditEvent:
            session.add(AuditEventRow.from_model(event))
            session.flush()
            return _freeze_audit(event)

        return self.run_transaction(operation)

    def extend_audit(self, events: Iterable[AuditEvent]) -> None:
        copied = [event.model_copy(deep=True) for event in events]

        def operation(session: Session) -> None:
            session.add_all(AuditEventRow.from_model(event) for event in copied)
            session.flush()

        self.run_transaction(operation)

    def list_audit(
        self,
        *,
        tenant_id: str | None = None,
        tenant_visible: bool = False,
        excluded_actor_roles: Collection[str] | None = None,
        created_from: datetime | None = None,
        created_through: datetime | None = None,
        newest_first: bool = True,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[AuditEvent]:
        _validate_limit(limit)
        if offset < 0:
            raise ValueError("offset must be nonnegative")

        filters = self._audit_filters(
            tenant_id=tenant_id,
            tenant_visible=tenant_visible,
            excluded_actor_roles=excluded_actor_roles,
            created_from=created_from,
            created_through=created_through,
        )

        def operation(session: Session) -> list[AuditEvent]:
            ordering = (
                AuditEventRow.sequence.desc() if newest_first else AuditEventRow.sequence.asc()
            )
            statement = select(AuditEventRow).where(*filters).order_by(ordering).offset(offset)
            if limit is not None:
                statement = statement.limit(limit)
            return [_freeze_audit(row.to_model()) for row in session.scalars(statement)]

        return self.run_transaction(operation)

    def count_audit(
        self,
        *,
        tenant_id: str | None = None,
        tenant_visible: bool = False,
        excluded_actor_roles: Collection[str] | None = None,
        created_from: datetime | None = None,
        created_through: datetime | None = None,
    ) -> int:
        filters = self._audit_filters(
            tenant_id=tenant_id,
            tenant_visible=tenant_visible,
            excluded_actor_roles=excluded_actor_roles,
            created_from=created_from,
            created_through=created_through,
        )
        return self.run_transaction(
            lambda session: (
                session.scalar(select(func.count()).select_from(AuditEventRow).where(*filters)) or 0
            )
        )

    def get_audit_at(self, index: int) -> AuditEvent:
        def operation(session: Session) -> AuditEvent:
            if index >= 0:
                ordering = AuditEventRow.sequence.asc()
                offset = index
            else:
                ordering = AuditEventRow.sequence.desc()
                offset = -index - 1
            row = session.scalar(select(AuditEventRow).order_by(ordering).offset(offset).limit(1))
            if row is None:
                raise IndexError("audit event index out of range")
            return _freeze_audit(row.to_model())

        return self.run_transaction(operation)

    def replace_audit_at(self, index: int, event: AuditEvent) -> AuditEvent:
        def operation(session: Session) -> AuditEvent:
            row = self._audit_row_at(session, index)
            _apply_audit_model(row, event)
            session.flush()
            return _freeze_audit(event)

        return self.run_transaction(operation)

    @staticmethod
    def _audit_row_at(session: Session, index: int) -> AuditEventRow:
        if index >= 0:
            ordering = AuditEventRow.sequence.asc()
            offset = index
        else:
            ordering = AuditEventRow.sequence.desc()
            offset = -index - 1
        row = session.scalar(select(AuditEventRow).order_by(ordering).offset(offset).limit(1))
        if row is None:
            raise IndexError("audit event index out of range")
        return row

    def delete_audit_slice(self, index: Index) -> int:
        def operation(session: Session) -> int:
            sequences = list(
                session.scalars(select(AuditEventRow.sequence).order_by(AuditEventRow.sequence))
            )
            selected = sequences[index]
            selected_sequences = [selected] if isinstance(selected, int) else list(selected)
            if not selected_sequences:
                return 0
            session.execute(
                delete(AuditEventRow).where(AuditEventRow.sequence.in_(selected_sequences))
            )
            return len(selected_sequences)

        return self.run_transaction(operation)

    def clear_audit(self) -> int:
        def operation(session: Session) -> int:
            count = session.scalar(select(func.count()).select_from(AuditEventRow)) or 0
            session.execute(delete(AuditEventRow))
            return count

        return self.run_transaction(operation)

    def trim_audit(self, max_records: int) -> int:
        _validate_max_records(max_records)

        def operation(session: Session) -> int:
            count = session.scalar(select(func.count()).select_from(AuditEventRow)) or 0
            overflow = max(0, count - max_records)
            if not overflow:
                return 0
            sequences = list(
                session.scalars(
                    select(AuditEventRow.sequence).order_by(AuditEventRow.sequence).limit(overflow)
                )
            )
            session.execute(delete(AuditEventRow).where(AuditEventRow.sequence.in_(sequences)))
            return len(sequences)

        return self.run_transaction(operation)

    def purge_audit_before(self, cutoff: datetime, limit: int = 500) -> int:
        """Delete one bounded oldest-first batch of safely delivered audit history.

        An audit event remains authoritative while any matching durable outbox
        item is pending.  Events without an outbox item and events whose
        matching items are all delivered are eligible; delivered matching
        items are removed only after their primary audit row is deleted in the
        same transaction.  Compatibility outbox rows without an explicit
        ``event_id`` are intentionally unrelated and remain untouched.
        """

        cutoff_utc = _retention_cutoff(cutoff)
        batch_limit = _retention_limit(limit)

        def operation(session: Session) -> int:
            candidate_audit = aliased(AuditEventRow)
            candidate_pending_outbox_exists = (
                select(AuditOutboxRow.sequence)
                .where(
                    AuditOutboxRow.event_id == candidate_audit.id,
                    AuditOutboxRow.delivered_at.is_(None),
                )
                .correlate(candidate_audit)
                .exists()
            )
            candidate_sequences = (
                select(candidate_audit.sequence)
                .where(
                    candidate_audit.created_at < cutoff_utc,
                    ~candidate_pending_outbox_exists,
                )
                .order_by(candidate_audit.created_at, candidate_audit.sequence)
                .limit(batch_limit)
            )
            pending_outbox_exists = (
                select(AuditOutboxRow.sequence)
                .where(
                    AuditOutboxRow.event_id == AuditEventRow.id,
                    AuditOutboxRow.delivered_at.is_(None),
                )
                .correlate(AuditEventRow)
                .exists()
            )
            deleted_event_ids = list(
                session.scalars(
                    delete(AuditEventRow)
                    .where(
                        AuditEventRow.sequence.in_(candidate_sequences),
                        AuditEventRow.created_at < cutoff_utc,
                        ~pending_outbox_exists,
                    )
                    .returning(AuditEventRow.id)
                    .execution_options(synchronize_session=False)
                )
            )
            if deleted_event_ids:
                session.execute(
                    delete(AuditOutboxRow).where(
                        AuditOutboxRow.event_id.in_(deleted_event_ids),
                        AuditOutboxRow.delivered_at.is_not(None),
                    )
                )
            return len(deleted_event_ids)

        return self.run_transaction(operation)

    # Usage records ------------------------------------------------------

    @staticmethod
    def _usage_filters(
        *,
        tenant_id: str | None,
        user_id: str | None,
        visible_user_ids: Collection[str] | None,
        created_from: datetime | None,
        created_through: datetime | None,
    ) -> list[Any]:
        filters: list[Any] = []
        if tenant_id is not None:
            filters.append(UsageRecordRow.tenant_id == tenant_id)
        if user_id is not None:
            filters.append(UsageRecordRow.user_id == user_id)
        if visible_user_ids is not None:
            filters.append(UsageRecordRow.user_id.in_(list(visible_user_ids)))
        if created_from is not None:
            filters.append(UsageRecordRow.created_at >= created_from)
        if created_through is not None:
            filters.append(UsageRecordRow.created_at <= created_through)
        return filters

    def append_usage(self, record: UsageRecord, max_records: int) -> UsageRecord:
        """Append a usage record and trim the oldest overflow atomically."""

        _validate_max_records(max_records)

        def operation(session: Session) -> UsageRecord:
            row = UsageRecordRow.from_model(record)
            session.add(row)
            session.flush()
            count = session.scalar(select(func.count()).select_from(UsageRecordRow)) or 0
            overflow = max(0, count - max_records)
            if overflow:
                sequences = list(
                    session.scalars(
                        select(UsageRecordRow.sequence)
                        .order_by(UsageRecordRow.sequence)
                        .limit(overflow)
                    )
                )
                session.execute(
                    delete(UsageRecordRow).where(UsageRecordRow.sequence.in_(sequences))
                )
            return _freeze_usage(record)

        return self.run_transaction(operation)

    def append_usage_unbounded(self, record: UsageRecord) -> UsageRecord:
        def operation(session: Session) -> UsageRecord:
            session.add(UsageRecordRow.from_model(record))
            session.flush()
            return _freeze_usage(record)

        return self.run_transaction(operation)

    def extend_usage(self, records: Iterable[UsageRecord]) -> None:
        copied = [record.model_copy(deep=True) for record in records]

        def operation(session: Session) -> None:
            session.add_all(UsageRecordRow.from_model(record) for record in copied)
            session.flush()

        self.run_transaction(operation)

    def list_usage(
        self,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        visible_user_ids: Collection[str] | None = None,
        created_from: datetime | None = None,
        created_through: datetime | None = None,
        newest_first: bool = True,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[UsageRecord]:
        _validate_limit(limit)
        if offset < 0:
            raise ValueError("offset must be nonnegative")
        filters = self._usage_filters(
            tenant_id=tenant_id,
            user_id=user_id,
            visible_user_ids=visible_user_ids,
            created_from=created_from,
            created_through=created_through,
        )

        def operation(session: Session) -> list[UsageRecord]:
            ordering = (
                UsageRecordRow.sequence.desc() if newest_first else UsageRecordRow.sequence.asc()
            )
            statement = select(UsageRecordRow).where(*filters).order_by(ordering).offset(offset)
            if limit is not None:
                statement = statement.limit(limit)
            return [_freeze_usage(row.to_model()) for row in session.scalars(statement)]

        return self.run_transaction(operation)

    def count_usage(
        self,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        visible_user_ids: Collection[str] | None = None,
        created_from: datetime | None = None,
        created_through: datetime | None = None,
    ) -> int:
        filters = self._usage_filters(
            tenant_id=tenant_id,
            user_id=user_id,
            visible_user_ids=visible_user_ids,
            created_from=created_from,
            created_through=created_through,
        )
        return self.run_transaction(
            lambda session: (
                session.scalar(select(func.count()).select_from(UsageRecordRow).where(*filters))
                or 0
            )
        )

    def get_usage_at(self, index: int) -> UsageRecord:
        def operation(session: Session) -> UsageRecord:
            return _freeze_usage(self._usage_row_at(session, index).to_model())

        return self.run_transaction(operation)

    @staticmethod
    def _usage_row_at(session: Session, index: int) -> UsageRecordRow:
        if index >= 0:
            ordering = UsageRecordRow.sequence.asc()
            offset = index
        else:
            ordering = UsageRecordRow.sequence.desc()
            offset = -index - 1
        row = session.scalar(select(UsageRecordRow).order_by(ordering).offset(offset).limit(1))
        if row is None:
            raise IndexError("usage record index out of range")
        return row

    def replace_usage_at(self, index: int, record: UsageRecord) -> UsageRecord:
        def operation(session: Session) -> UsageRecord:
            row = self._usage_row_at(session, index)
            _apply_usage_model(row, record)
            session.flush()
            return _freeze_usage(record)

        return self.run_transaction(operation)

    def update_usage_record(self, record: UsageRecord) -> UsageRecord:
        """Persist an explicitly mutated detached usage model by external id."""

        def operation(session: Session) -> UsageRecord:
            row = session.scalar(select(UsageRecordRow).where(UsageRecordRow.id == record.id))
            if row is None:
                raise KeyError(record.id)
            _apply_usage_model(row, record)
            session.flush()
            return _freeze_usage(record)

        return self.run_transaction(operation)

    def delete_usage_slice(self, index: Index) -> int:
        def operation(session: Session) -> int:
            sequences = list(
                session.scalars(select(UsageRecordRow.sequence).order_by(UsageRecordRow.sequence))
            )
            selected = sequences[index]
            selected_sequences = [selected] if isinstance(selected, int) else list(selected)
            if not selected_sequences:
                return 0
            session.execute(
                delete(UsageRecordRow).where(UsageRecordRow.sequence.in_(selected_sequences))
            )
            return len(selected_sequences)

        return self.run_transaction(operation)

    def clear_usage(self) -> int:
        def operation(session: Session) -> int:
            count = session.scalar(select(func.count()).select_from(UsageRecordRow)) or 0
            session.execute(delete(UsageRecordRow))
            return count

        return self.run_transaction(operation)

    def purge_usage_before(self, cutoff: datetime, limit: int = 500) -> int:
        """Delete one bounded usage batch in deterministic oldest-first order."""

        cutoff_utc = _retention_cutoff(cutoff)
        batch_limit = _retention_limit(limit)

        def operation(session: Session) -> int:
            candidate_usage = aliased(UsageRecordRow)
            candidate_sequences = (
                select(candidate_usage.sequence)
                .where(candidate_usage.created_at < cutoff_utc)
                .order_by(candidate_usage.created_at, candidate_usage.sequence)
                .limit(batch_limit)
            )
            deleted_sequences = list(
                session.scalars(
                    delete(UsageRecordRow)
                    .where(
                        UsageRecordRow.sequence.in_(candidate_sequences),
                        UsageRecordRow.created_at < cutoff_utc,
                    )
                    .returning(UsageRecordRow.sequence)
                    .execution_options(synchronize_session=False)
                )
            )
            return len(deleted_sequences)

        return self.run_transaction(operation)

    # Audit delivery outbox ---------------------------------------------

    @staticmethod
    def _new_outbox_row(
        payload: Mapping[str, Any],
        *,
        dedupe_key: str | None = None,
    ) -> AuditOutboxRow:
        copied = deepcopy(dict(payload))
        event_id_value = copied.get("id")
        event_id = event_id_value if isinstance(event_id_value, str) and event_id_value else None
        tenant_value = copied.get("tenant_id")
        tenant_id = tenant_value if isinstance(tenant_value, str) else None
        return AuditOutboxRow(
            dedupe_key=dedupe_key or (f"audit:{event_id}" if event_id else f"compat:{uuid4()}"),
            event_id=event_id,
            tenant_id=tenant_id,
            payload=copied,
        )

    def append_outbox_payload(
        self,
        payload: Mapping[str, Any],
        *,
        dedupe_key: str | None = None,
    ) -> dict[str, Any]:
        row = self._new_outbox_row(payload, dedupe_key=dedupe_key)

        def operation(session: Session) -> dict[str, Any]:
            session.add(row)
            session.flush()
            return deepcopy(row.payload)

        return self.run_transaction(operation)

    def extend_outbox_payloads(self, payloads: Iterable[Mapping[str, Any]]) -> None:
        rows = [self._new_outbox_row(payload) for payload in payloads]

        def operation(session: Session) -> None:
            session.add_all(rows)
            session.flush()

        self.run_transaction(operation)

    def pending_outbox(self, limit: int | None = None) -> list[AuditOutboxRow]:
        _validate_limit(limit)

        def operation(session: Session) -> list[AuditOutboxRow]:
            statement = (
                select(AuditOutboxRow)
                .where(AuditOutboxRow.delivered_at.is_(None))
                .order_by(AuditOutboxRow.sequence)
            )
            if limit is not None:
                statement = statement.limit(limit)
            return list(session.scalars(statement))

        return self.run_transaction(operation)

    def count_outbox(self, *, pending_only: bool = True) -> int:
        def operation(session: Session) -> int:
            statement = select(func.count()).select_from(AuditOutboxRow)
            if pending_only:
                statement = statement.where(AuditOutboxRow.delivered_at.is_(None))
            return session.scalar(statement) or 0

        return self.run_transaction(operation)

    def count_pending_outbox(self) -> int:
        return self.count_outbox(pending_only=True)

    def mark_outbox_delivered(
        self,
        sequences: Iterable[int],
        delivered_at: datetime | None = None,
    ) -> int:
        selected = list(dict.fromkeys(sequences))
        timestamp = delivered_at or datetime.now(UTC)

        def operation(session: Session) -> int:
            if not selected:
                return 0
            result = session.execute(
                update(AuditOutboxRow)
                .where(
                    AuditOutboxRow.sequence.in_(selected),
                    AuditOutboxRow.delivered_at.is_(None),
                )
                .values(delivered_at=timestamp)
            )
            return result.rowcount or 0

        return self.run_transaction(operation)

    def get_outbox_payload_at(self, index: int) -> dict[str, Any]:
        def operation(session: Session) -> dict[str, Any]:
            return deepcopy(self._pending_outbox_row_at(session, index).payload)

        return self.run_transaction(operation)

    @staticmethod
    def _pending_outbox_row_at(session: Session, index: int) -> AuditOutboxRow:
        if index >= 0:
            ordering = AuditOutboxRow.sequence.asc()
            offset = index
        else:
            ordering = AuditOutboxRow.sequence.desc()
            offset = -index - 1
        row = session.scalar(
            select(AuditOutboxRow)
            .where(AuditOutboxRow.delivered_at.is_(None))
            .order_by(ordering)
            .offset(offset)
            .limit(1)
        )
        if row is None:
            raise IndexError("audit outbox index out of range")
        return row

    def replace_outbox_payload_at(self, index: int, payload: Mapping[str, Any]) -> dict[str, Any]:
        copied = deepcopy(dict(payload))

        def operation(session: Session) -> dict[str, Any]:
            row = self._pending_outbox_row_at(session, index)
            event_id_value = copied.get("id")
            tenant_value = copied.get("tenant_id")
            row.event_id = (
                event_id_value if isinstance(event_id_value, str) and event_id_value else None
            )
            row.tenant_id = tenant_value if isinstance(tenant_value, str) else None
            row.payload = copied
            session.flush()
            return deepcopy(row.payload)

        return self.run_transaction(operation)

    def delete_outbox_slice(self, index: Index) -> int:
        def operation(session: Session) -> int:
            sequences = list(
                session.scalars(
                    select(AuditOutboxRow.sequence)
                    .where(AuditOutboxRow.delivered_at.is_(None))
                    .order_by(AuditOutboxRow.sequence)
                )
            )
            selected = sequences[index]
            selected_sequences = [selected] if isinstance(selected, int) else list(selected)
            if not selected_sequences:
                return 0
            session.execute(
                delete(AuditOutboxRow).where(AuditOutboxRow.sequence.in_(selected_sequences))
            )
            return len(selected_sequences)

        return self.run_transaction(operation)

    def clear_outbox(self, *, include_delivered: bool = False) -> int:
        def operation(session: Session) -> int:
            filters = [] if include_delivered else [AuditOutboxRow.delivered_at.is_(None)]
            count = (
                session.scalar(select(func.count()).select_from(AuditOutboxRow).where(*filters))
                or 0
            )
            session.execute(delete(AuditOutboxRow).where(*filters))
            return count

        return self.run_transaction(operation)

    def trim_outbox(self, max_records: int) -> int:
        _validate_max_records(max_records)

        def operation(session: Session) -> int:
            count = (
                session.scalar(
                    select(func.count())
                    .select_from(AuditOutboxRow)
                    .where(AuditOutboxRow.delivered_at.is_(None))
                )
                or 0
            )
            overflow = max(0, count - max_records)
            if not overflow:
                return 0
            sequences = list(
                session.scalars(
                    select(AuditOutboxRow.sequence)
                    .where(AuditOutboxRow.delivered_at.is_(None))
                    .order_by(AuditOutboxRow.sequence)
                    .limit(overflow)
                )
            )
            session.execute(delete(AuditOutboxRow).where(AuditOutboxRow.sequence.in_(sequences)))
            return len(sequences)

        return self.run_transaction(operation)

    # Chat workspace state -----------------------------------------------

    @staticmethod
    def _chat_thread_row(session: Session, thread_id: str) -> ChatThreadRow | None:
        return session.scalar(select(ChatThreadRow).where(ChatThreadRow.id == thread_id))

    def upsert_chat_thread(self, thread: ChatThread) -> ChatThread:
        """Save a thread and move it to the newest insertion position."""

        copied = ChatThread.model_validate(thread.model_dump(mode="python"))

        def operation(session: Session) -> ChatThread:
            existing = self._chat_thread_row(session, copied.id)
            # Matter assignment has a separate explicit-membership gate. This
            # general workspace upsert may preserve the authoritative SQL link,
            # but it must neither assign one nor resurrect a stale cached link
            # after the matter repository cleared it.
            matter_id = existing.matter_id if existing is not None else None
            # Retention clocks and disposition state are server-owned. The
            # client-authored payload can neither set nor clear them across
            # this delete-and-reinsert, and every save bumps the activity
            # clock that retention sweeps order by.
            created_at = existing.created_at if existing is not None else None
            disposition_state = existing.disposition_state if existing is not None else None
            disposition_pending_since = (
                existing.disposition_pending_since if existing is not None else None
            )
            session.execute(delete(ChatThreadRow).where(ChatThreadRow.id == copied.id))
            row = ChatThreadRow.from_model(copied)
            row.matter_id = matter_id
            now = datetime.now(UTC)
            row.created_at = created_at or now
            row.last_activity_at = now
            row.disposition_state = disposition_state
            row.disposition_pending_since = disposition_pending_since
            session.add(row)
            session.flush()
            self._link_thread_attachments(session, row.id, row.messages)
            return _freeze_chat_thread(row.to_model())

        return self.run_transaction(operation)

    @staticmethod
    def _link_thread_attachments(
        session: Session,
        thread_id: str,
        messages: Sequence[Mapping[str, Any]],
    ) -> None:
        """Point referenced attachment rows at their thread.

        The upload endpoint cannot know the thread yet, so the link is
        derived here from the canonical messages document on every save.
        """

        attachment_ids = {
            attachment["id"]
            for message in messages
            for attachment in message.get("attachments") or []
            if isinstance(attachment, Mapping) and attachment.get("id")
        }
        if not attachment_ids:
            return
        session.execute(
            update(ChatAttachmentRow)
            .where(ChatAttachmentRow.id.in_(attachment_ids))
            .values(thread_id=thread_id)
        )

    def get_chat_thread(self, thread_id: str) -> ChatThread | None:
        def operation(session: Session) -> ChatThread | None:
            row = self._chat_thread_row(session, thread_id)
            return _freeze_chat_thread(row.to_model()) if row is not None else None

        return self.run_transaction(operation)

    def list_chat_threads(
        self,
        *,
        owner_user_id: str | None = None,
        tenant_id: str | None = None,
        archived: bool | None = None,
        folder_id: str | None = None,
        filter_folder: bool = False,
        newest_first: bool = True,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[ChatThread]:
        _validate_limit(limit)
        if offset < 0:
            raise ValueError("offset must be nonnegative")
        filters: list[Any] = []
        if owner_user_id is not None:
            filters.append(ChatThreadRow.owner_user_id == owner_user_id)
        if tenant_id is not None:
            filters.append(ChatThreadRow.tenant_id == tenant_id)
        if archived is not None:
            filters.append(ChatThreadRow.archived == archived)
        if filter_folder:
            filters.append(
                ChatThreadRow.folder_id.is_(None)
                if folder_id is None
                else ChatThreadRow.folder_id == folder_id
            )

        def operation(session: Session) -> list[ChatThread]:
            ordering = ChatThreadRow.sequence.desc() if newest_first else ChatThreadRow.sequence
            statement = select(ChatThreadRow).where(*filters).order_by(ordering).offset(offset)
            if limit is not None:
                statement = statement.limit(limit)
            return [_freeze_chat_thread(row.to_model()) for row in session.scalars(statement)]

        return self.run_transaction(operation)

    def list_chat_threads_for_owner(
        self,
        *,
        owner_user_id: str,
        tenant_id: str | None,
        allow_cross_tenant: bool = False,
        newest_first: bool = True,
        limit: int | None = None,
    ) -> list[ChatThread]:
        """Return personal chat rows without broadening the caller's tenant ACL."""

        filters: list[Any] = [ChatThreadRow.owner_user_id == owner_user_id]
        if not allow_cross_tenant:
            filters.append(ChatThreadRow.tenant_id == tenant_id)
        _validate_limit(limit)

        def operation(session: Session) -> list[ChatThread]:
            ordering = ChatThreadRow.sequence.desc() if newest_first else ChatThreadRow.sequence
            statement = select(ChatThreadRow).where(*filters).order_by(ordering)
            if limit is not None:
                statement = statement.limit(limit)
            return [_freeze_chat_thread(row.to_model()) for row in session.scalars(statement)]

        return self.run_transaction(operation)

    def get_chat_thread_for_owner(
        self,
        thread_id: str,
        *,
        owner_user_id: str,
        tenant_id: str | None,
        allow_cross_tenant: bool = False,
    ) -> ChatThread | None:
        filters: list[Any] = [
            ChatThreadRow.id == thread_id,
            ChatThreadRow.owner_user_id == owner_user_id,
        ]
        if not allow_cross_tenant:
            filters.append(ChatThreadRow.tenant_id == tenant_id)

        def operation(session: Session) -> ChatThread | None:
            row = session.scalar(select(ChatThreadRow).where(*filters))
            return _freeze_chat_thread(row.to_model()) if row is not None else None

        return self.run_transaction(operation)

    def delete_chat_thread(self, thread_id: str) -> ChatThread | None:
        # Preview files are the only stored copy of uploaded images; collect
        # the doomed IDs inside the transaction and unlink after it commits.
        doomed_attachment_ids: list[str] = []

        def operation(session: Session) -> ChatThread | None:
            row = self._chat_thread_row(session, thread_id)
            if row is None:
                return None
            thread = _freeze_chat_thread(row.to_model())
            doomed_attachment_ids.extend(
                session.execute(
                    select(ChatAttachmentRow.id).where(
                        ChatAttachmentRow.thread_id == thread_id
                    )
                ).scalars()
            )
            session.execute(
                delete(ChatAttachmentRow).where(ChatAttachmentRow.thread_id == thread_id)
            )
            session.execute(
                delete(ChatThreadTagRow).where(ChatThreadTagRow.thread_id == thread_id)
            )
            session.execute(
                delete(RetentionHoldThreadRow).where(
                    RetentionHoldThreadRow.thread_id == thread_id
                )
            )
            session.delete(row)
            return thread

        thread = self.run_transaction(operation)
        for attachment_id in doomed_attachment_ids:
            delete_attachment_preview(attachment_id)
        return thread

    def count_chat_threads(self) -> int:
        return self.run_transaction(
            lambda session: session.scalar(select(func.count()).select_from(ChatThreadRow)) or 0
        )

    def set_chat_threads_archived(
        self,
        thread_ids: Sequence[str],
        *,
        tenant_id: str,
        archived: bool = True,
    ) -> int:
        """Archive/unarchive threads in place.

        A direct UPDATE, never the delete-and-reinsert upsert: archiving must
        not bump the retention activity clock, move the thread to the newest
        sequence position, or touch server-owned disposition state.
        Archiving also unpins, matching the client's own archive behavior.
        """

        ids = list(dict.fromkeys(thread_ids))
        if not ids:
            return 0
        values: dict[str, Any] = {"archived": archived}
        if archived:
            values["pinned"] = False

        def operation(session: Session) -> int:
            return (
                session.execute(
                    update(ChatThreadRow)
                    .where(
                        ChatThreadRow.id.in_(ids),
                        ChatThreadRow.tenant_id == tenant_id,
                    )
                    .values(**values)
                ).rowcount
                or 0
            )

        return self.run_transaction(operation)

    @staticmethod
    def _chat_folder_row(session: Session, folder_id: str) -> ChatFolderRow | None:
        return session.scalar(select(ChatFolderRow).where(ChatFolderRow.id == folder_id))

    def upsert_chat_folder(self, folder: ChatFolder) -> ChatFolder:
        """Save a folder and move it to the newest insertion position."""

        copied = folder.model_copy(deep=True)

        def operation(session: Session) -> ChatFolder:
            existing = self._chat_folder_row(session, copied.id)
            # Matter assignment is reserved for the membership-gated matter
            # repository; ordinary saves only retain the current SQL binding.
            matter_id = existing.matter_id if existing is not None else None
            session.execute(delete(ChatFolderRow).where(ChatFolderRow.id == copied.id))
            row = ChatFolderRow.from_model(copied)
            row.matter_id = matter_id
            session.add(row)
            session.flush()
            return _freeze_chat_folder(row.to_model())

        return self.run_transaction(operation)

    def get_chat_folder(self, folder_id: str) -> ChatFolder | None:
        def operation(session: Session) -> ChatFolder | None:
            row = self._chat_folder_row(session, folder_id)
            return _freeze_chat_folder(row.to_model()) if row is not None else None

        return self.run_transaction(operation)

    def list_chat_folders(
        self,
        *,
        owner_user_id: str | None = None,
        tenant_id: str | None = None,
        newest_first: bool = True,
        limit: int | None = None,
    ) -> list[ChatFolder]:
        _validate_limit(limit)
        filters: list[Any] = []
        if owner_user_id is not None:
            filters.append(ChatFolderRow.owner_user_id == owner_user_id)
        if tenant_id is not None:
            filters.append(ChatFolderRow.tenant_id == tenant_id)

        def operation(session: Session) -> list[ChatFolder]:
            ordering = ChatFolderRow.sequence.desc() if newest_first else ChatFolderRow.sequence
            statement = select(ChatFolderRow).where(*filters).order_by(ordering)
            if limit is not None:
                statement = statement.limit(limit)
            return [_freeze_chat_folder(row.to_model()) for row in session.scalars(statement)]

        return self.run_transaction(operation)

    def list_chat_folders_for_owner(
        self,
        *,
        owner_user_id: str,
        tenant_id: str | None,
        allow_cross_tenant: bool = False,
        newest_first: bool = True,
    ) -> list[ChatFolder]:
        filters: list[Any] = [ChatFolderRow.owner_user_id == owner_user_id]
        if not allow_cross_tenant:
            filters.append(ChatFolderRow.tenant_id == tenant_id)

        def operation(session: Session) -> list[ChatFolder]:
            ordering = ChatFolderRow.sequence.desc() if newest_first else ChatFolderRow.sequence
            rows = session.scalars(select(ChatFolderRow).where(*filters).order_by(ordering))
            return [_freeze_chat_folder(row.to_model()) for row in rows]

        return self.run_transaction(operation)

    def get_chat_folder_for_owner(
        self,
        folder_id: str,
        *,
        owner_user_id: str,
        tenant_id: str | None,
        allow_cross_tenant: bool = False,
    ) -> ChatFolder | None:
        filters: list[Any] = [
            ChatFolderRow.id == folder_id,
            ChatFolderRow.owner_user_id == owner_user_id,
        ]
        if not allow_cross_tenant:
            filters.append(ChatFolderRow.tenant_id == tenant_id)

        def operation(session: Session) -> ChatFolder | None:
            row = session.scalar(select(ChatFolderRow).where(*filters))
            return _freeze_chat_folder(row.to_model()) if row is not None else None

        return self.run_transaction(operation)

    def delete_chat_folder(self, folder_id: str) -> tuple[ChatFolder | None, list[str]]:
        """Delete a folder and unfile only its owner's matching tenant threads."""

        def operation(session: Session) -> tuple[ChatFolder | None, list[str]]:
            row = self._chat_folder_row(session, folder_id)
            if row is None:
                return None, []
            folder = _freeze_chat_folder(row.to_model())
            matching = (
                ChatThreadRow.folder_id == folder_id,
                ChatThreadRow.tenant_id == row.tenant_id,
                ChatThreadRow.owner_user_id == row.owner_user_id,
            )
            cleared_ids = list(
                session.scalars(
                    select(ChatThreadRow.id).where(*matching).order_by(ChatThreadRow.sequence)
                )
            )
            if cleared_ids:
                session.execute(update(ChatThreadRow).where(*matching).values(folder_id=None))
            session.delete(row)
            return folder, cleared_ids

        return self.run_transaction(operation)

    def count_chat_folders(self) -> int:
        return self.run_transaction(
            lambda session: session.scalar(select(func.count()).select_from(ChatFolderRow)) or 0
        )

    def upsert_chat_attachment(self, attachment: ChatAttachment) -> ChatAttachment:
        copied = attachment.model_copy(deep=True)
        if copied.id is None:
            copied = copied.model_copy(update={"id": f"upload-{uuid4()}"})

        def operation(session: Session) -> ChatAttachment:
            row = ChatAttachmentRow.from_model(copied)
            existing = session.get(ChatAttachmentRow, row.id)
            if existing is not None:
                # The thread link is server-derived; a re-upload of the same
                # attachment must not orphan it.
                row.thread_id = existing.thread_id
                session.delete(existing)
                session.flush()
            session.add(row)
            session.flush()
            return _freeze_chat_attachment(row.to_model())

        return self.run_transaction(operation)

    def get_chat_attachment(self, attachment_id: str) -> ChatAttachment | None:
        def operation(session: Session) -> ChatAttachment | None:
            row = session.get(ChatAttachmentRow, attachment_id)
            return _freeze_chat_attachment(row.to_model()) if row is not None else None

        return self.run_transaction(operation)

    def get_chat_attachment_for_owner(
        self,
        attachment_id: str,
        *,
        owner_user_id: str,
        tenant_id: str | None,
        allow_platform_owner_global: bool = False,
    ) -> ChatAttachment | None:
        filters: list[Any] = [ChatAttachmentRow.id == attachment_id]
        if not allow_platform_owner_global:
            filters.extend(
                (
                    ChatAttachmentRow.owner_user_id == owner_user_id,
                    ChatAttachmentRow.tenant_id == tenant_id,
                )
            )

        def operation(session: Session) -> ChatAttachment | None:
            row = session.scalar(select(ChatAttachmentRow).where(*filters))
            return _freeze_chat_attachment(row.to_model()) if row is not None else None

        return self.run_transaction(operation)

    def list_chat_attachments(
        self,
        *,
        owner_user_id: str | None = None,
        tenant_id: str | None = None,
    ) -> list[ChatAttachment]:
        filters: list[Any] = []
        if owner_user_id is not None:
            filters.append(ChatAttachmentRow.owner_user_id == owner_user_id)
        if tenant_id is not None:
            filters.append(ChatAttachmentRow.tenant_id == tenant_id)

        def operation(session: Session) -> list[ChatAttachment]:
            rows = session.scalars(
                select(ChatAttachmentRow).where(*filters).order_by(ChatAttachmentRow.id)
            )
            return [_freeze_chat_attachment(row.to_model()) for row in rows]

        return self.run_transaction(operation)

    def delete_chat_attachment(self, attachment_id: str) -> ChatAttachment | None:
        def operation(session: Session) -> ChatAttachment | None:
            row = session.get(ChatAttachmentRow, attachment_id)
            if row is None:
                return None
            attachment = _freeze_chat_attachment(row.to_model())
            session.delete(row)
            return attachment

        return self.run_transaction(operation)

    def count_chat_attachments(self) -> int:
        return self.run_transaction(
            lambda session: session.scalar(select(func.count()).select_from(ChatAttachmentRow)) or 0
        )

    # Chat response feedback --------------------------------------------

    def upsert_chat_feedback(
        self,
        record: ChatFeedbackRecord,
        *,
        update_comment: bool,
    ) -> ChatFeedbackRecord:
        """One row per (user, message); a repeat click updates it in place.

        ``update_comment=False`` preserves an existing note when only the
        rating changed, so re-clicking a thumb never erases what the person
        wrote.
        """

        copied = record.model_copy(deep=True)

        def operation(session: Session) -> ChatFeedbackRecord:
            existing = session.scalar(
                select(ChatFeedbackRow).where(
                    ChatFeedbackRow.user_id == copied.user_id,
                    ChatFeedbackRow.message_id == copied.message_id,
                )
            )
            if existing is not None:
                existing.rating = copied.rating
                existing.updated_at = copied.updated_at
                if update_comment:
                    existing.comment = copied.comment
                if copied.message_preview:
                    existing.message_preview = copied.message_preview
                if copied.thread_title:
                    existing.thread_title = copied.thread_title
                session.flush()
                return existing.to_model()
            row = ChatFeedbackRow.from_model(copied)
            session.add(row)
            session.flush()
            return row.to_model()

        return self.run_transaction(operation)

    def list_chat_feedback(
        self,
        *,
        tenant_id: str | None = None,
        limit: int | None = 200,
    ) -> list[ChatFeedbackRecord]:
        _validate_limit(limit)
        filters: list[Any] = []
        if tenant_id is not None:
            filters.append(ChatFeedbackRow.tenant_id == tenant_id)

        def operation(session: Session) -> list[ChatFeedbackRecord]:
            statement = (
                select(ChatFeedbackRow)
                .where(*filters)
                .order_by(ChatFeedbackRow.updated_at.desc(), ChatFeedbackRow.id)
            )
            if limit is not None:
                statement = statement.limit(limit)
            return [row.to_model() for row in session.scalars(statement)]

        return self.run_transaction(operation)

    # Chat thread retention tags ----------------------------------------

    def apply_chat_thread_tag(self, tag: ChatThreadTag) -> ChatThreadTag:
        """Idempotently apply a tag; (thread, namespace, key) is the identity."""

        copied = tag.model_copy(deep=True)

        def operation(session: Session) -> ChatThreadTag:
            existing = session.scalar(
                select(ChatThreadTagRow).where(
                    ChatThreadTagRow.thread_id == copied.thread_id,
                    ChatThreadTagRow.namespace == copied.namespace,
                    ChatThreadTagRow.key == copied.key,
                )
            )
            if existing is not None:
                existing.value = copied.value
                existing.source = copied.source
                existing.applied_at = copied.applied_at
                existing.applied_by = copied.applied_by
                session.flush()
                return existing.to_model()
            row = ChatThreadTagRow.from_model(copied)
            session.add(row)
            session.flush()
            return row.to_model()

        return self.run_transaction(operation)

    def list_chat_thread_tags(
        self,
        *,
        tenant_id: str | None = None,
        thread_id: str | None = None,
        namespace: str | None = None,
        key: str | None = None,
    ) -> list[ChatThreadTag]:
        filters: list[Any] = []
        if tenant_id is not None:
            filters.append(ChatThreadTagRow.tenant_id == tenant_id)
        if thread_id is not None:
            filters.append(ChatThreadTagRow.thread_id == thread_id)
        if namespace is not None:
            filters.append(ChatThreadTagRow.namespace == namespace)
        if key is not None:
            filters.append(ChatThreadTagRow.key == key)

        def operation(session: Session) -> list[ChatThreadTag]:
            rows = session.scalars(
                select(ChatThreadTagRow)
                .where(*filters)
                .order_by(
                    ChatThreadTagRow.thread_id,
                    ChatThreadTagRow.namespace,
                    ChatThreadTagRow.key,
                )
            )
            return [row.to_model() for row in rows]

        return self.run_transaction(operation)

    def remove_chat_thread_tag(
        self,
        thread_id: str,
        namespace: str,
        key: str,
    ) -> ChatThreadTag | None:
        def operation(session: Session) -> ChatThreadTag | None:
            row = session.scalar(
                select(ChatThreadTagRow).where(
                    ChatThreadTagRow.thread_id == thread_id,
                    ChatThreadTagRow.namespace == namespace,
                    ChatThreadTagRow.key == key,
                )
            )
            if row is None:
                return None
            tag = row.to_model()
            session.delete(row)
            return tag

        return self.run_transaction(operation)

    # Retention holds ---------------------------------------------------

    def create_retention_hold(
        self,
        hold: RetentionHold,
        thread_ids: Sequence[str],
    ) -> tuple[RetentionHold, list[str]]:
        """Create a hold covering the given threads.

        Membership is materialized at creation and silently drops thread ids
        that do not exist inside the hold's tenant, so a hold can never pin
        another tenant's data. Returns the hold and the ids actually held.
        """

        copied = hold.model_copy(deep=True)
        requested = list(dict.fromkeys(thread_ids))

        def operation(session: Session) -> tuple[RetentionHold, list[str]]:
            held_ids: list[str] = []
            if requested:
                held_ids = list(
                    session.execute(
                        select(ChatThreadRow.id).where(
                            ChatThreadRow.id.in_(requested),
                            ChatThreadRow.tenant_id == copied.tenant_id,
                        )
                    ).scalars()
                )
            row = RetentionHoldRow.from_model(copied)
            session.add(row)
            session.flush()
            for held_id in held_ids:
                session.add(RetentionHoldThreadRow(hold_id=row.id, thread_id=held_id))
            session.flush()
            return row.to_model(), held_ids

        return self.run_transaction(operation)

    def release_retention_hold(
        self,
        hold_id: str,
        *,
        released_at: datetime,
        released_by: str,
    ) -> RetentionHold | None:
        def operation(session: Session) -> RetentionHold | None:
            row = session.get(RetentionHoldRow, hold_id)
            if row is None or row.released_at is not None:
                return None
            row.released_at = released_at
            row.released_by = released_by
            session.flush()
            return row.to_model()

        return self.run_transaction(operation)

    def list_retention_holds(
        self,
        *,
        tenant_id: str | None = None,
        active_only: bool = False,
    ) -> list[RetentionHold]:
        filters: list[Any] = []
        if tenant_id is not None:
            filters.append(RetentionHoldRow.tenant_id == tenant_id)
        if active_only:
            filters.append(RetentionHoldRow.released_at.is_(None))

        def operation(session: Session) -> list[RetentionHold]:
            rows = session.scalars(
                select(RetentionHoldRow).where(*filters).order_by(RetentionHoldRow.created_at)
            )
            return [row.to_model() for row in rows]

        return self.run_transaction(operation)

    def retention_hold_thread_ids(self, hold_id: str) -> list[str]:
        def operation(session: Session) -> list[str]:
            return list(
                session.execute(
                    select(RetentionHoldThreadRow.thread_id)
                    .where(RetentionHoldThreadRow.hold_id == hold_id)
                    .order_by(RetentionHoldThreadRow.thread_id)
                ).scalars()
            )

        return self.run_transaction(operation)

    def matter_labels_for_tenant(self, tenant_id: str) -> dict[str, str]:
        """Matter id -> display name, for governance labels only.

        Deliberately not membership-gated: retention and audit surfaces label
        a chat's matter so client/matter numbers are searchable there, while
        matter content and membership stay behind the matter repository's
        explicit-membership gate.
        """

        def operation(session: Session) -> dict[str, str]:
            rows = session.execute(
                select(MatterRow.id, MatterRow.name).where(MatterRow.tenant_id == tenant_id)
            )
            return {matter_id: name for matter_id, name in rows}

        return self.run_transaction(operation)

    def thread_ids_under_active_hold(self, tenant_id: str) -> set[str]:
        """Thread ids the retention sweep must never dispose of."""

        def operation(session: Session) -> set[str]:
            return set(
                session.execute(
                    select(RetentionHoldThreadRow.thread_id)
                    .join(
                        RetentionHoldRow,
                        RetentionHoldRow.id == RetentionHoldThreadRow.hold_id,
                    )
                    .where(
                        RetentionHoldRow.tenant_id == tenant_id,
                        RetentionHoldRow.released_at.is_(None),
                    )
                ).scalars()
            )

        return self.run_transaction(operation)

    # Personal API keys -------------------------------------------------

    def upsert_user_api_key(self, record: UserApiKeyRecord) -> UserApiKeyRecord:
        copied = record.model_copy(deep=True)
        if not _is_sha256_hex(copied.key_hash):
            raise ValueError("key_hash must be exactly 64 lowercase hexadecimal characters")

        def operation(session: Session) -> UserApiKeyRecord:
            hash_owner = session.scalar(
                select(UserApiKeyRow).where(UserApiKeyRow.key_hash == copied.key_hash)
            )
            if hash_owner is not None and hash_owner.user_id != copied.user_id:
                raise ValueError("key_hash is already assigned to another user")
            id_owner = session.get(UserApiKeyRow, copied.id)
            if id_owner is not None and id_owner.user_id != copied.user_id:
                raise ValueError("API key id is already assigned to another user")
            session.execute(
                delete(UserApiKeyRow).where(
                    or_(UserApiKeyRow.user_id == copied.user_id, UserApiKeyRow.id == copied.id)
                )
            )
            row = UserApiKeyRow.from_model(copied)
            session.add(row)
            session.flush()
            return _freeze_user_api_key(row.to_model())

        return self.run_transaction(operation)

    def get_user_api_key(self, user_id: str) -> UserApiKeyRecord | None:
        def operation(session: Session) -> UserApiKeyRecord | None:
            row = session.scalar(select(UserApiKeyRow).where(UserApiKeyRow.user_id == user_id))
            return _freeze_user_api_key(row.to_model()) if row is not None else None

        return self.run_transaction(operation)

    def list_user_api_keys(self, *, tenant_id: str | None = None) -> list[UserApiKeyRecord]:
        statement = select(UserApiKeyRow)
        if tenant_id is not None:
            statement = statement.where(UserApiKeyRow.tenant_id == tenant_id)
        statement = statement.order_by(UserApiKeyRow.user_id)

        def operation(session: Session) -> list[UserApiKeyRecord]:
            return [_freeze_user_api_key(row.to_model()) for row in session.scalars(statement)]

        return self.run_transaction(operation)

    def delete_user_api_key(self, user_id: str) -> UserApiKeyRecord | None:
        def operation(session: Session) -> UserApiKeyRecord | None:
            row = session.scalar(select(UserApiKeyRow).where(UserApiKeyRow.user_id == user_id))
            if row is None:
                return None
            record = _freeze_user_api_key(row.to_model())
            session.delete(row)
            return record

        return self.run_transaction(operation)

    def lookup_api_key_hash(
        self,
        candidate_hash: str,
        *,
        touch_last_used: bool = False,
        touched_at: str | datetime | None = None,
    ) -> UserApiKeyRecord | None:
        """Use the indexed SHA-256 digest and optionally persist a real auth touch."""

        if not _is_sha256_hex(candidate_hash):
            return None
        if isinstance(touched_at, datetime):
            touched_at_value = touched_at.astimezone(UTC).isoformat()
        else:
            touched_at_value = touched_at

        def operation(session: Session) -> UserApiKeyRecord | None:
            row = session.scalar(
                select(UserApiKeyRow).where(UserApiKeyRow.key_hash == candidate_hash)
            )
            if row is None or not hmac.compare_digest(row.key_hash, candidate_hash):
                return None
            if touch_last_used:
                touched = session.execute(
                    update(UserApiKeyRow)
                    .where(
                        UserApiKeyRow.id == row.id,
                        UserApiKeyRow.key_hash == candidate_hash,
                    )
                    .values(last_used_at=touched_at_value or datetime.now(UTC).isoformat())
                )
                if touched.rowcount != 1:
                    return None
                session.refresh(row)
            return _freeze_user_api_key(row.to_model())

        return self.run_transaction(operation)

    def touch_user_api_key_if_current(
        self,
        key_id: str,
        key_hash: str,
        touched_at: str | datetime,
    ) -> bool:
        """CAS-update last-used only while the authenticated key is still current."""

        if not _is_sha256_hex(key_hash):
            raise ValueError("key_hash must be exactly 64 lowercase hexadecimal characters")
        if isinstance(touched_at, datetime):
            touched_at_value = touched_at.astimezone(UTC).isoformat()
        elif isinstance(touched_at, str) and touched_at.strip():
            touched_at_value = touched_at.strip()
        else:
            raise ValueError("touched_at must be a timestamp string or datetime")

        def operation(session: Session) -> bool:
            result = session.execute(
                update(UserApiKeyRow)
                .where(
                    UserApiKeyRow.id == key_id,
                    UserApiKeyRow.key_hash == key_hash,
                )
                .values(last_used_at=touched_at_value)
            )
            return result.rowcount == 1

        return self.run_transaction(operation)

    def count_user_api_keys(self) -> int:
        return self.run_transaction(
            lambda session: session.scalar(select(func.count()).select_from(UserApiKeyRow)) or 0
        )

    # TOTP multi-factor authentication ---------------------------------

    @staticmethod
    def _mfa_policy_in_session(
        session: Session,
        tenant_id: str | None,
    ) -> MfaPolicyState:
        if tenant_id is None:
            return MfaPolicyState(required=False, generation=0)
        row = session.get(TenantMfaPolicyRow, tenant_id)
        if row is None:
            return MfaPolicyState(required=False, generation=0)
        return MfaPolicyState(required=row.required, generation=row.generation)

    @staticmethod
    def _mfa_factor_in_session(
        session: Session,
        *,
        user_id: str,
        tenant_id: str | None,
        for_update: bool = False,
    ) -> UserTotpFactorRow | None:
        statement = select(UserTotpFactorRow).where(UserTotpFactorRow.user_id == user_id)
        if for_update:
            statement = statement.with_for_update()
        row = session.scalar(statement)
        if row is not None and row.tenant_id != tenant_id:
            raise MfaStateConflictError("The factor tenant binding is inconsistent.")
        return row

    @classmethod
    def _mfa_claims_are_current_in_session(
        cls,
        session: Session,
        *,
        user_id: str,
        tenant_id: str | None,
        mfa_assured: bool,
        mfa_factor_generation: int | None,
        auth_method: str = "local",
    ) -> bool:
        try:
            factor = cls._mfa_factor_in_session(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
            )
        except MfaStateConflictError:
            return False
        # An unassured SSO session is valid regardless of tenant MFA policy or
        # an enrolled platform factor: the identity provider authenticated the
        # sign-in (including its own MFA), and the platform authenticator is
        # opt-in per SSO configuration. An SSO session that DOES claim
        # platform assurance is held to the same generation check as local.
        if auth_method == "sso" and not mfa_assured and mfa_factor_generation is None:
            return True
        policy = cls._mfa_policy_in_session(session, tenant_id)
        if factor is None:
            return not policy.required and not mfa_assured and mfa_factor_generation is None
        return mfa_assured and mfa_factor_generation == factor.generation

    def get_mfa_posture(
        self,
        *,
        user_id: str,
        tenant_id: str | None,
    ) -> tuple[MfaPolicyState, TotpFactorState | None, int]:
        """Return policy, confirmed factor, and unused recovery-code count."""

        def operation(
            session: Session,
        ) -> tuple[MfaPolicyState, TotpFactorState | None, int]:
            policy = self._mfa_policy_in_session(session, tenant_id)
            row = self._mfa_factor_in_session(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
            )
            factor = _detach_mfa_factor(row) if row is not None else None
            unused = 0
            if row is not None:
                unused = (
                    session.scalar(
                        select(func.count())
                        .select_from(TotpRecoveryCodeRow)
                        .where(
                            TotpRecoveryCodeRow.user_id == user_id,
                            _same_tenant(TotpRecoveryCodeRow.tenant_id, tenant_id),
                            TotpRecoveryCodeRow.factor_generation == row.generation,
                            TotpRecoveryCodeRow.used_at.is_(None),
                        )
                    )
                    or 0
                )
            return policy, factor, unused

        return self.run_transaction(operation)

    def get_tenant_mfa_policy(self, tenant_id: str) -> MfaPolicyState:
        if not isinstance(tenant_id, str) or not tenant_id.strip():
            raise ValueError("tenant_id is required")
        return self.run_transaction(lambda session: self._mfa_policy_in_session(session, tenant_id))

    @staticmethod
    def _validate_auth_context(auth_method: str, sso_config_id: str | None) -> None:
        if auth_method not in {"local", "sso"}:
            raise ValueError("auth_method must be local or sso")
        if (auth_method == "local" and sso_config_id is not None) or (
            auth_method == "sso" and not sso_config_id
        ):
            raise ValueError("The SSO configuration does not match the auth method")

    @staticmethod
    def _challenge_is_usable(row: MfaPreauthChallengeRow, now: datetime) -> bool:
        return row.consumed_at is None and row.expires_at > now and row.attempts < row.max_attempts

    @staticmethod
    def _enrollment_is_usable(row: TotpPendingEnrollmentRow, now: datetime) -> bool:
        return row.consumed_at is None and row.expires_at > now and row.attempts < row.max_attempts

    def create_mfa_challenge(
        self,
        *,
        token_hash: str,
        user_id: str,
        tenant_id: str | None,
        auth_method: str,
        sso_config_id: str | None,
        purpose: str,
        expected_factor_generation: int | None,
        created_at: datetime,
        expires_at: datetime,
        max_attempts: int,
    ) -> MfaChallengeState:
        self._validate_auth_context(auth_method, sso_config_id)
        if purpose not in {"verify", "enroll"}:
            raise ValueError("purpose must be verify or enroll")
        if (purpose == "verify") != (expected_factor_generation is not None):
            raise ValueError("Factor generation does not match challenge purpose")
        if len(token_hash) != 64 or not _is_sha256_hex(token_hash):
            raise ValueError("token_hash must be a SHA-256 hexadecimal digest")
        if expires_at <= created_at or max_attempts < 1:
            raise ValueError("Challenge expiry and attempt limit are invalid")

        def operation(session: Session) -> MfaChallengeState:
            factor = self._mfa_factor_in_session(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                for_update=True,
            )
            policy = self._mfa_policy_in_session(session, tenant_id)
            if purpose == "verify":
                if factor is None or factor.generation != expected_factor_generation:
                    raise MfaStateConflictError("The confirmed factor changed.")
            elif factor is not None or not policy.required:
                raise MfaStateConflictError("Enrollment is not required for this login.")
            prior = session.scalar(
                select(MfaPreauthChallengeRow)
                .where(MfaPreauthChallengeRow.user_id == user_id)
                .order_by(MfaPreauthChallengeRow.created_at.desc())
                .limit(1)
                .with_for_update()
            )
            carried_attempts = 0
            effective_created_at = created_at
            effective_expires_at = expires_at
            if (
                prior is not None
                and prior.expires_at > created_at
                and prior.attempts > 0
                and (prior.consumed_at is None or prior.attempts >= prior.max_attempts)
            ):
                if prior.attempts >= prior.max_attempts:
                    raise MfaChallengeInvalidError(
                        "MFA verification is temporarily locked after too many attempts."
                    )
                carried_attempts = prior.attempts
                # Re-running primary authentication can replace the bearer
                # token, but cannot extend the failure window or reset its
                # subscriber-level attempt counter.
                effective_created_at = prior.created_at
                effective_expires_at = prior.expires_at
            if prior is None:
                row = MfaPreauthChallengeRow(
                    token_hash=token_hash,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    auth_method=auth_method,
                    sso_config_id=sso_config_id,
                    purpose=purpose,
                    expected_factor_generation=expected_factor_generation,
                    created_at=effective_created_at,
                    expires_at=effective_expires_at,
                    attempts=carried_attempts,
                    max_attempts=max_attempts,
                    consumed_at=None,
                )
                session.add(row)
            else:
                row = prior
                row.token_hash = token_hash
                row.tenant_id = tenant_id
                row.auth_method = auth_method
                row.sso_config_id = sso_config_id
                row.purpose = purpose
                row.expected_factor_generation = expected_factor_generation
                row.created_at = effective_created_at
                row.expires_at = effective_expires_at
                row.attempts = carried_attempts
                row.max_attempts = max_attempts
                row.consumed_at = None
            session.flush()
            return _detach_mfa_challenge(row)

        return self._run_mfa_write_transaction(operation)

    def get_mfa_challenge(self, token_hash: str) -> MfaChallengeState | None:
        def operation(session: Session) -> MfaChallengeState | None:
            row = session.get(MfaPreauthChallengeRow, token_hash)
            return _detach_mfa_challenge(row) if row is not None else None

        return self.run_transaction(operation)

    def get_user_mfa_challenge(self, user_id: str) -> MfaChallengeState | None:
        def operation(session: Session) -> MfaChallengeState | None:
            row = session.scalar(
                select(MfaPreauthChallengeRow).where(MfaPreauthChallengeRow.user_id == user_id)
            )
            return _detach_mfa_challenge(row) if row is not None else None

        return self.run_transaction(operation)

    def record_mfa_challenge_failure(
        self,
        token_hash: str,
        *,
        now: datetime,
    ) -> int:
        """Count one failed attempt and return attempts remaining."""

        def operation(session: Session) -> int:
            row = session.scalar(
                select(MfaPreauthChallengeRow)
                .where(MfaPreauthChallengeRow.token_hash == token_hash)
                .with_for_update()
            )
            if row is None or not self._challenge_is_usable(row, now):
                raise MfaChallengeInvalidError("The MFA challenge is no longer valid.")
            row.attempts += 1
            if row.attempts >= row.max_attempts:
                row.consumed_at = now
            session.flush()
            return max(0, row.max_attempts - row.attempts)

        return self.run_transaction(operation)

    def start_totp_enrollment(
        self,
        *,
        enrollment_token_hash: str,
        user_id: str,
        tenant_id: str | None,
        factor_generation: int,
        auth_method: str,
        sso_config_id: str | None,
        source_challenge_hash: str | None,
        encrypted_secret_ciphertext: str,
        created_at: datetime,
        expires_at: datetime,
        max_attempts: int,
    ) -> TotpEnrollmentState:
        self._validate_auth_context(auth_method, sso_config_id)
        if not _is_sha256_hex(enrollment_token_hash):
            raise ValueError("enrollment_token_hash must be a SHA-256 digest")
        if source_challenge_hash is not None and not _is_sha256_hex(source_challenge_hash):
            raise ValueError("source_challenge_hash must be a SHA-256 digest")
        if not encrypted_secret_ciphertext.startswith("v3."):
            raise ValueError("MFA seed ciphertext must use the scoped v3 format")
        if (
            type(factor_generation) is not int
            or not 1 <= factor_generation <= MAX_MFA_FACTOR_GENERATION
            or expires_at <= created_at
            or max_attempts < 1
        ):
            raise ValueError("Enrollment generation, expiry, or attempt limit is invalid")

        def operation(session: Session) -> TotpEnrollmentState:
            factor = self._mfa_factor_in_session(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                for_update=True,
            )
            watermark = session.get(UserSessionWatermarkRow, user_id)
            minimum_generation = max(
                factor.generation + 1 if factor is not None else 1,
                (watermark.issued_before_ms + 1) if watermark is not None else 1,
            )
            if minimum_generation > MAX_MFA_FACTOR_GENERATION:
                raise MfaStateConflictError("The factor generation cannot be advanced.")
            if factor_generation < minimum_generation:
                raise MfaStateConflictError("The target factor generation is stale.")
            if source_challenge_hash is not None:
                challenge = session.scalar(
                    select(MfaPreauthChallengeRow)
                    .where(MfaPreauthChallengeRow.token_hash == source_challenge_hash)
                    .with_for_update()
                )
                if (
                    challenge is None
                    or not self._challenge_is_usable(challenge, created_at)
                    or challenge.user_id != user_id
                    or challenge.tenant_id != tenant_id
                    or challenge.auth_method != auth_method
                    or challenge.sso_config_id != sso_config_id
                    or challenge.purpose != "enroll"
                ):
                    raise MfaChallengeInvalidError("The enrollment challenge is invalid.")
                challenge.consumed_at = created_at
            prior = session.scalar(
                select(TotpPendingEnrollmentRow)
                .where(TotpPendingEnrollmentRow.user_id == user_id)
                .with_for_update()
            )
            carried_attempts = 0
            effective_created_at = created_at
            effective_expires_at = expires_at
            if (
                prior is not None
                and prior.expires_at > created_at
                and prior.attempts > 0
                and (prior.consumed_at is None or prior.attempts >= prior.max_attempts)
            ):
                if prior.attempts >= prior.max_attempts:
                    raise MfaChallengeInvalidError(
                        "TOTP enrollment is temporarily locked after too many attempts."
                    )
                carried_attempts = prior.attempts
                effective_created_at = prior.created_at
                effective_expires_at = prior.expires_at
            if prior is None:
                row = TotpPendingEnrollmentRow(
                    enrollment_token_hash=enrollment_token_hash,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    factor_generation=factor_generation,
                    auth_method=auth_method,
                    sso_config_id=sso_config_id,
                    source_challenge_hash=source_challenge_hash,
                    encrypted_secret_ciphertext=encrypted_secret_ciphertext,
                    created_at=effective_created_at,
                    expires_at=effective_expires_at,
                    attempts=carried_attempts,
                    max_attempts=max_attempts,
                    consumed_at=None,
                )
                session.add(row)
            else:
                row = prior
                row.enrollment_token_hash = enrollment_token_hash
                row.tenant_id = tenant_id
                row.factor_generation = factor_generation
                row.auth_method = auth_method
                row.sso_config_id = sso_config_id
                row.source_challenge_hash = source_challenge_hash
                row.encrypted_secret_ciphertext = encrypted_secret_ciphertext
                row.created_at = effective_created_at
                row.expires_at = effective_expires_at
                row.attempts = carried_attempts
                row.max_attempts = max_attempts
                row.consumed_at = None
            session.flush()
            return _detach_totp_enrollment(row)

        return self._run_mfa_write_transaction(operation)

    def get_totp_enrollment(self, token_hash: str) -> TotpEnrollmentState | None:
        def operation(session: Session) -> TotpEnrollmentState | None:
            row = session.get(TotpPendingEnrollmentRow, token_hash)
            return _detach_totp_enrollment(row) if row is not None else None

        return self.run_transaction(operation)

    def get_user_totp_enrollment(self, user_id: str) -> TotpEnrollmentState | None:
        def operation(session: Session) -> TotpEnrollmentState | None:
            row = session.scalar(
                select(TotpPendingEnrollmentRow).where(TotpPendingEnrollmentRow.user_id == user_id)
            )
            return _detach_totp_enrollment(row) if row is not None else None

        return self.run_transaction(operation)

    def record_totp_enrollment_failure(
        self,
        token_hash: str,
        *,
        expected_ciphertext: str,
        now: datetime,
    ) -> int:
        def operation(session: Session) -> int:
            row = session.scalar(
                select(TotpPendingEnrollmentRow)
                .where(TotpPendingEnrollmentRow.enrollment_token_hash == token_hash)
                .with_for_update()
            )
            if (
                row is None
                or not self._enrollment_is_usable(row, now)
                or not hmac.compare_digest(
                    row.encrypted_secret_ciphertext,
                    expected_ciphertext,
                )
            ):
                raise MfaChallengeInvalidError("The TOTP enrollment is no longer valid.")
            row.attempts += 1
            if row.attempts >= row.max_attempts:
                row.consumed_at = now
            session.flush()
            return max(0, row.max_attempts - row.attempts)

        return self.run_transaction(operation)

    def promote_totp_enrollment(
        self,
        *,
        enrollment_token_hash: str,
        expected_ciphertext: str,
        factor_ciphertext: str,
        matched_step: int,
        recovery_code_hashes: Sequence[str],
        now: datetime,
        issued_before_ms: int,
        updated_by: str | None,
    ) -> tuple[MfaChallengeState | None, int, int]:
        """Atomically confirm a factor, replace recovery codes, and revoke sessions."""

        if not factor_ciphertext.startswith("v3."):
            raise ValueError("Confirmed MFA seed must use scoped v3 encryption")
        if type(matched_step) is not int or matched_step < 0:
            raise ValueError("matched_step must be nonnegative")
        hashes = list(recovery_code_hashes)
        if (
            not hashes
            or len(set(hashes)) != len(hashes)
            or any(not _is_sha256_hex(value) for value in hashes)
        ):
            raise ValueError("Recovery-code hashes must be unique SHA-256 digests")
        reason, actor_id = _watermark_metadata("mfa-factor-confirmed", updated_by)

        def operation(session: Session) -> tuple[MfaChallengeState | None, int, int]:
            pending = session.scalar(
                select(TotpPendingEnrollmentRow)
                .where(TotpPendingEnrollmentRow.enrollment_token_hash == enrollment_token_hash)
                .with_for_update()
            )
            if (
                pending is None
                or not self._enrollment_is_usable(pending, now)
                or not hmac.compare_digest(
                    pending.encrypted_secret_ciphertext,
                    expected_ciphertext,
                )
            ):
                raise MfaChallengeInvalidError("The TOTP enrollment is no longer valid.")
            current = self._mfa_factor_in_session(
                session,
                user_id=pending.user_id,
                tenant_id=pending.tenant_id,
                for_update=True,
            )
            watermark = session.get(UserSessionWatermarkRow, pending.user_id)
            minimum_generation = max(
                current.generation + 1 if current is not None else 1,
                (watermark.issued_before_ms + 1) if watermark is not None else 1,
            )
            if minimum_generation > MAX_MFA_FACTOR_GENERATION:
                raise MfaStateConflictError("The factor generation cannot be advanced.")
            if pending.factor_generation < minimum_generation:
                raise MfaStateConflictError("The target factor generation is stale.")
            if current is None:
                factor = UserTotpFactorRow(
                    user_id=pending.user_id,
                    tenant_id=pending.tenant_id,
                    generation=pending.factor_generation,
                    encrypted_secret_ciphertext=factor_ciphertext,
                    confirmed_at=now,
                    last_used_step=matched_step,
                )
                session.add(factor)
            else:
                current.generation = pending.factor_generation
                current.encrypted_secret_ciphertext = factor_ciphertext
                current.confirmed_at = now
                current.last_used_step = matched_step
            session.execute(
                delete(TotpRecoveryCodeRow).where(TotpRecoveryCodeRow.user_id == pending.user_id)
            )
            session.add_all(
                [
                    TotpRecoveryCodeRow(
                        code_hash=value,
                        user_id=pending.user_id,
                        tenant_id=pending.tenant_id,
                        factor_generation=pending.factor_generation,
                        created_at=now,
                        used_at=None,
                    )
                    for value in hashes
                ]
            )
            source: MfaChallengeState | None = None
            if pending.source_challenge_hash is not None:
                source_row = session.get(
                    MfaPreauthChallengeRow,
                    pending.source_challenge_hash,
                )
                if source_row is not None:
                    source = _detach_mfa_challenge(source_row)
            session.execute(
                delete(MfaPreauthChallengeRow).where(
                    MfaPreauthChallengeRow.user_id == pending.user_id
                )
            )
            session.delete(pending)
            cutoff = self._advance_session_watermark_strict(
                session,
                user_id=pending.user_id,
                tenant_id=pending.tenant_id,
                issued_before_ms=issued_before_ms,
                reason=reason,
                updated_at=now,
                updated_by=actor_id,
            )
            session.flush()
            return source, pending.factor_generation, cutoff

        return self.run_transaction(operation)

    @staticmethod
    def _locked_verification_challenge(
        session: Session,
        *,
        token_hash: str,
        now: datetime,
    ) -> MfaPreauthChallengeRow:
        row = session.scalar(
            select(MfaPreauthChallengeRow)
            .where(MfaPreauthChallengeRow.token_hash == token_hash)
            .with_for_update()
        )
        if (
            row is None
            or not ApplicationStateRepository._challenge_is_usable(row, now)
            or row.purpose != "verify"
            or row.expected_factor_generation is None
        ):
            raise MfaChallengeInvalidError("The MFA challenge is no longer valid.")
        return row

    def complete_totp_challenge(
        self,
        *,
        token_hash: str,
        expected_factor_ciphertext: str,
        matched_step: int,
        now: datetime,
    ) -> MfaChallengeState:
        """Consume a challenge and advance last-used step in one transaction."""

        if type(matched_step) is not int or matched_step < 0:
            raise ValueError("matched_step must be nonnegative")

        def operation(session: Session) -> MfaChallengeState:
            challenge = self._locked_verification_challenge(
                session,
                token_hash=token_hash,
                now=now,
            )
            factor = self._mfa_factor_in_session(
                session,
                user_id=challenge.user_id,
                tenant_id=challenge.tenant_id,
                for_update=True,
            )
            if (
                factor is None
                or factor.generation != challenge.expected_factor_generation
                or not hmac.compare_digest(
                    factor.encrypted_secret_ciphertext,
                    expected_factor_ciphertext,
                )
            ):
                raise MfaStateConflictError("The confirmed factor changed.")
            if factor.last_used_step is not None and matched_step <= factor.last_used_step:
                raise MfaReplayError("This TOTP code step was already used.")
            factor.last_used_step = matched_step
            challenge.consumed_at = now
            session.flush()
            return _detach_mfa_challenge(challenge)

        return self.run_transaction(operation)

    def complete_recovery_challenge(
        self,
        *,
        token_hash: str,
        recovery_code_hash: str,
        now: datetime,
    ) -> MfaChallengeState:
        """Consume one recovery hash and its challenge in one transaction."""

        if not _is_sha256_hex(recovery_code_hash):
            raise ValueError("recovery_code_hash must be a SHA-256 digest")

        def operation(session: Session) -> MfaChallengeState:
            challenge = self._locked_verification_challenge(
                session,
                token_hash=token_hash,
                now=now,
            )
            factor = self._mfa_factor_in_session(
                session,
                user_id=challenge.user_id,
                tenant_id=challenge.tenant_id,
                for_update=True,
            )
            if factor is None or factor.generation != challenge.expected_factor_generation:
                raise MfaStateConflictError("The confirmed factor changed.")
            recovery = session.scalar(
                select(TotpRecoveryCodeRow)
                .where(
                    TotpRecoveryCodeRow.code_hash == recovery_code_hash,
                    TotpRecoveryCodeRow.user_id == challenge.user_id,
                    _same_tenant(
                        TotpRecoveryCodeRow.tenant_id,
                        challenge.tenant_id,
                    ),
                    TotpRecoveryCodeRow.factor_generation == factor.generation,
                    TotpRecoveryCodeRow.used_at.is_(None),
                )
                .with_for_update()
            )
            if recovery is None:
                raise MfaChallengeInvalidError("The recovery code is invalid.")
            recovery.used_at = now
            challenge.consumed_at = now
            session.flush()
            return _detach_mfa_challenge(challenge)

        return self.run_transaction(operation)

    def apply_mfa_sensitive_action(
        self,
        *,
        action: str,
        user_id: str,
        tenant_id: str | None,
        expected_generation: int,
        expected_factor_ciphertext: str,
        proof_kind: str,
        matched_step: int | None,
        recovery_code_hash: str | None,
        new_recovery_code_hashes: Sequence[str],
        now: datetime,
        issued_before_ms: int,
        updated_by: str,
    ) -> int:
        """Verify fresh proof and disable or regenerate codes atomically."""

        if action not in {"disable", "regenerate-recovery"}:
            raise ValueError("Unknown MFA sensitive action")
        if proof_kind not in {"totp", "recovery_code"}:
            raise ValueError("Unknown MFA proof kind")
        if (
            type(expected_generation) is not int
            or not 1 <= expected_generation <= MAX_MFA_FACTOR_GENERATION
        ):
            raise ValueError("expected_generation is outside the BIGINT range")
        hashes = list(new_recovery_code_hashes)
        if action == "regenerate-recovery" and (
            not hashes
            or len(set(hashes)) != len(hashes)
            or any(not _is_sha256_hex(value) for value in hashes)
        ):
            raise ValueError("Replacement recovery hashes are invalid")
        if action == "disable" and hashes:
            raise ValueError("Disable cannot install recovery hashes")
        if proof_kind == "totp" and (
            type(matched_step) is not int or matched_step < 0 or recovery_code_hash is not None
        ):
            raise ValueError("TOTP proof requires one matched step")
        if proof_kind == "recovery_code" and (
            matched_step is not None
            or recovery_code_hash is None
            or not _is_sha256_hex(recovery_code_hash)
        ):
            raise ValueError("Recovery proof requires one SHA-256 hash")
        reason, actor_id = _watermark_metadata("mfa-factor-disabled", updated_by)

        def operation(session: Session) -> int:
            factor = self._mfa_factor_in_session(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                for_update=True,
            )
            if (
                factor is None
                or factor.generation != expected_generation
                or not hmac.compare_digest(
                    factor.encrypted_secret_ciphertext,
                    expected_factor_ciphertext,
                )
            ):
                raise MfaStateConflictError("The confirmed factor changed.")
            if proof_kind == "totp":
                assert matched_step is not None
                if factor.last_used_step is not None and matched_step <= factor.last_used_step:
                    raise MfaReplayError("This TOTP code step was already used.")
                factor.last_used_step = matched_step
            else:
                assert recovery_code_hash is not None
                recovery = session.scalar(
                    select(TotpRecoveryCodeRow)
                    .where(
                        TotpRecoveryCodeRow.code_hash == recovery_code_hash,
                        TotpRecoveryCodeRow.user_id == user_id,
                        _same_tenant(TotpRecoveryCodeRow.tenant_id, tenant_id),
                        TotpRecoveryCodeRow.factor_generation == expected_generation,
                        TotpRecoveryCodeRow.used_at.is_(None),
                    )
                    .with_for_update()
                )
                if recovery is None:
                    raise MfaChallengeInvalidError("The recovery code is invalid.")
                recovery.used_at = now

            session.execute(
                delete(TotpRecoveryCodeRow).where(TotpRecoveryCodeRow.user_id == user_id)
            )
            if action == "disable":
                session.delete(factor)
                session.execute(
                    delete(TotpPendingEnrollmentRow).where(
                        TotpPendingEnrollmentRow.user_id == user_id
                    )
                )
                session.execute(
                    delete(MfaPreauthChallengeRow).where(MfaPreauthChallengeRow.user_id == user_id)
                )
                self._advance_session_watermark_strict(
                    session,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    issued_before_ms=issued_before_ms,
                    reason=reason,
                    updated_at=now,
                    updated_by=actor_id,
                )
            else:
                session.add_all(
                    [
                        TotpRecoveryCodeRow(
                            code_hash=value,
                            user_id=user_id,
                            tenant_id=tenant_id,
                            factor_generation=expected_generation,
                            created_at=now,
                            used_at=None,
                        )
                        for value in hashes
                    ]
                )
                session.execute(
                    delete(TotpPendingEnrollmentRow).where(
                        TotpPendingEnrollmentRow.user_id == user_id
                    )
                )
                session.execute(
                    delete(MfaPreauthChallengeRow).where(MfaPreauthChallengeRow.user_id == user_id)
                )
            session.flush()
            return expected_generation

        return self.run_transaction(operation)

    def set_tenant_mfa_policy(
        self,
        *,
        tenant_id: str,
        required: bool,
        expected_generation: int,
        user_ids: Sequence[str],
        now: datetime,
        issued_before_ms: int,
        updated_by: str,
    ) -> MfaPolicyState:
        """Set tenant enforcement and revoke all tenant sessions atomically."""

        if not tenant_id or type(required) is not bool:
            raise ValueError("A tenant and boolean required value are required")
        if type(expected_generation) is not int or not 0 <= expected_generation <= (1 << 31) - 1:
            raise ValueError("expected_generation must be a nonnegative integer")
        reason, actor_id = _watermark_metadata("tenant-mfa-policy-changed", updated_by)
        unique_user_ids = sorted(set(user_ids))

        def operation(session: Session) -> MfaPolicyState:
            row = session.scalar(
                select(TenantMfaPolicyRow)
                .where(TenantMfaPolicyRow.tenant_id == tenant_id)
                .with_for_update()
            )
            live_generation = row.generation if row is not None else 0
            if live_generation != expected_generation:
                raise MfaStateConflictError("The tenant MFA policy changed.")
            if row is None and not required:
                return MfaPolicyState(required=False, generation=0)
            if row is not None and row.required is required:
                return MfaPolicyState(required=row.required, generation=row.generation)
            if row is None:
                row = TenantMfaPolicyRow(
                    tenant_id=tenant_id,
                    required=required,
                    generation=1,
                    updated_at=now,
                    updated_by=updated_by,
                )
                session.add(row)
            else:
                if row.generation >= (1 << 31) - 1:
                    raise MfaStateConflictError("The policy generation cannot be advanced.")
                row.required = required
                row.generation += 1
                row.updated_at = now
                row.updated_by = updated_by
            for user_id in unique_user_ids:
                self._advance_session_watermark_strict(
                    session,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    issued_before_ms=issued_before_ms,
                    reason=reason,
                    updated_at=now,
                    updated_by=actor_id,
                )
            session.execute(
                delete(MfaPreauthChallengeRow).where(MfaPreauthChallengeRow.tenant_id == tenant_id)
            )
            session.execute(
                delete(TotpPendingEnrollmentRow).where(
                    TotpPendingEnrollmentRow.tenant_id == tenant_id
                )
            )
            session.flush()
            return MfaPolicyState(required=row.required, generation=row.generation)

        # The first policy row has no record for SELECT ... FOR UPDATE to lock.
        # Concurrent generation-0 writers can therefore race on the unique
        # tenant key. Retry an integrity collision from a fresh transaction;
        # the loser then observes generation 1 and returns the domain 409 path.
        return self._run_mfa_write_transaction(operation)

    def invalidate_sso_configuration_context(
        self,
        *,
        sso_config_id: str,
        tenant_id: str,
        user_ids: Sequence[str],
        now: datetime,
        issued_before_ms: int,
        updated_by: str,
    ) -> int:
        """Revoke SSO sessions and preauth state before a config mutation."""

        if not sso_config_id or not tenant_id:
            raise ValueError("An SSO configuration and tenant are required")
        self._validate_session_watermark(issued_before_ms)
        reason, actor_id = _watermark_metadata("sso-configuration-changed", updated_by)

        def operation(session: Session) -> int:
            challenge_user_ids = session.scalars(
                select(MfaPreauthChallengeRow.user_id).where(
                    MfaPreauthChallengeRow.sso_config_id == sso_config_id
                )
            ).all()
            enrollment_user_ids = session.scalars(
                select(TotpPendingEnrollmentRow.user_id).where(
                    TotpPendingEnrollmentRow.sso_config_id == sso_config_id
                )
            ).all()
            affected_user_ids = sorted(set(user_ids).union(challenge_user_ids, enrollment_user_ids))
            for user_id in affected_user_ids:
                self._advance_session_watermark_strict(
                    session,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    issued_before_ms=issued_before_ms,
                    reason=reason,
                    updated_at=now,
                    updated_by=actor_id,
                )
            # Clear every flow bound to this configuration, including orphaned
            # rows whose JSON user record no longer exists. Other MFA flows for
            # the same user retain their independent lifecycle.
            session.execute(
                delete(MfaPreauthChallengeRow).where(
                    MfaPreauthChallengeRow.sso_config_id == sso_config_id
                )
            )
            session.execute(
                delete(TotpPendingEnrollmentRow).where(
                    TotpPendingEnrollmentRow.sso_config_id == sso_config_id
                )
            )
            session.flush()
            return len(affected_user_ids)

        return self.run_transaction(operation)

    def reset_user_mfa(
        self,
        *,
        user_id: str,
        tenant_id: str | None,
        now: datetime,
        issued_before_ms: int,
        updated_by: str | None,
        reason: str = "mfa-factor-reset",
    ) -> tuple[bool, int]:
        """Delete current MFA material and advance the user cutoff atomically."""

        normalized_reason, actor_id = _watermark_metadata(reason, updated_by)

        def operation(session: Session) -> tuple[bool, int]:
            factor = self._mfa_factor_in_session(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                for_update=True,
            )
            existed = factor is not None
            if factor is not None:
                session.delete(factor)
            session.execute(
                delete(TotpRecoveryCodeRow).where(TotpRecoveryCodeRow.user_id == user_id)
            )
            session.execute(
                delete(TotpPendingEnrollmentRow).where(TotpPendingEnrollmentRow.user_id == user_id)
            )
            session.execute(
                delete(MfaPreauthChallengeRow).where(MfaPreauthChallengeRow.user_id == user_id)
            )
            cutoff = self._advance_session_watermark_strict(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                issued_before_ms=issued_before_ms,
                reason=normalized_reason,
                updated_at=now,
                updated_by=actor_id,
            )
            return existed, cutoff

        return self.run_transaction(operation)

    def advance_session_watermark_and_clear_mfa_flows(
        self,
        *,
        user_id: str,
        tenant_id: str | None,
        issued_before_ms: int,
        reason: str,
        updated_by: str | None,
        now: datetime | None = None,
    ) -> int:
        """Revoke sessions plus preauth/enrollment flows without removing a factor."""

        normalized_reason, actor_id = _watermark_metadata(reason, updated_by)
        timestamp = now or datetime.now(UTC)

        def operation(session: Session) -> int:
            session.execute(
                delete(TotpPendingEnrollmentRow).where(TotpPendingEnrollmentRow.user_id == user_id)
            )
            session.execute(
                delete(MfaPreauthChallengeRow).where(MfaPreauthChallengeRow.user_id == user_id)
            )
            return self._advance_session_watermark_strict(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                issued_before_ms=issued_before_ms,
                reason=normalized_reason,
                updated_at=timestamp,
                updated_by=actor_id,
            )

        return self.run_transaction(operation)

    def purge_expired_mfa_state(
        self,
        now: datetime,
        *,
        limit: int = 500,
    ) -> int:
        """Delete at most ``limit`` expired/consumed challenges and enrollments."""

        if type(limit) is not int or limit < 1:
            raise ValueError("limit must be positive")

        def operation(session: Session) -> int:
            challenges = list(
                session.scalars(
                    select(MfaPreauthChallengeRow)
                    .where(
                        or_(
                            MfaPreauthChallengeRow.expires_at <= now,
                            MfaPreauthChallengeRow.consumed_at.is_not(None),
                        )
                    )
                    .order_by(
                        MfaPreauthChallengeRow.expires_at,
                        MfaPreauthChallengeRow.token_hash,
                    )
                    .limit(limit)
                    .with_for_update()
                )
            )
            enrollments = list(
                session.scalars(
                    select(TotpPendingEnrollmentRow)
                    .where(
                        or_(
                            TotpPendingEnrollmentRow.expires_at <= now,
                            TotpPendingEnrollmentRow.consumed_at.is_not(None),
                        )
                    )
                    .order_by(
                        TotpPendingEnrollmentRow.expires_at,
                        TotpPendingEnrollmentRow.enrollment_token_hash,
                    )
                    .limit(limit)
                    .with_for_update()
                )
            )
            candidates: list[tuple[datetime, str, object]] = [
                (row.expires_at, f"c:{row.token_hash}", row) for row in challenges
            ] + [(row.expires_at, f"e:{row.enrollment_token_hash}", row) for row in enrollments]
            candidates.sort(key=lambda value: (value[0], value[1]))
            selected = candidates[:limit]
            for _expiry, _identity, row in selected:
                session.delete(row)
            return len(selected)

        return self.run_transaction(operation)

    # Per-user session issued-before watermarks -------------------------

    def session_is_current(
        self,
        *,
        sid: str,
        user_id: str,
        issued_at_ms: int,
        expires_at: int | None = None,
        tenant_id: str | None = None,
        mfa_assured: bool = False,
        mfa_factor_generation: int | None = None,
    ) -> bool:
        """Check family binding, targeted revocation, and user cutoff in one call."""

        if not isinstance(sid, str) or not sid.strip():
            return False
        if not isinstance(user_id, str) or not user_id.strip():
            return False
        if type(issued_at_ms) is not int or issued_at_ms < 0:
            return False
        if expires_at is not None and (type(expires_at) is not int or expires_at < 0):
            return False
        if tenant_id is not None and (not isinstance(tenant_id, str) or not tenant_id.strip()):
            return False
        if type(mfa_assured) is not bool:
            return False
        if mfa_assured:
            if (
                type(mfa_factor_generation) is not int
                or not 1 <= mfa_factor_generation <= MAX_MFA_FACTOR_GENERATION
            ):
                return False
        elif mfa_factor_generation is not None:
            return False

        def operation(session: Session) -> bool:
            revoked_count = (
                select(func.count())
                .select_from(RevokedSessionRow)
                .where(RevokedSessionRow.sid == sid)
                .scalar_subquery()
            )
            watermark = (
                select(UserSessionWatermarkRow.issued_before_ms)
                .where(UserSessionWatermarkRow.user_id == user_id)
                .scalar_subquery()
            )
            family_user_id = (
                select(SessionFamilyRow.user_id)
                .where(SessionFamilyRow.sid == sid)
                .scalar_subquery()
            )
            family_tenant_id = (
                select(SessionFamilyRow.tenant_id)
                .where(SessionFamilyRow.sid == sid)
                .scalar_subquery()
            )
            family_max_expires_at = (
                select(SessionFamilyRow.max_expires_at)
                .where(SessionFamilyRow.sid == sid)
                .scalar_subquery()
            )
            family_legacy_unbounded = (
                select(SessionFamilyRow.legacy_unbounded)
                .where(SessionFamilyRow.sid == sid)
                .scalar_subquery()
            )
            family_revoked_at = (
                select(SessionFamilyRow.revoked_at)
                .where(SessionFamilyRow.sid == sid)
                .scalar_subquery()
            )
            family_auth_method = (
                select(SessionFamilyRow.auth_method)
                .where(SessionFamilyRow.sid == sid)
                .scalar_subquery()
            )
            (
                revoked,
                issued_before_ms,
                bound_user_id,
                bound_tenant_id,
                max_expires_at,
                legacy_unbounded,
                revoked_at,
                bound_auth_method,
            ) = session.execute(
                select(
                    revoked_count,
                    watermark,
                    family_user_id,
                    family_tenant_id,
                    family_max_expires_at,
                    family_legacy_unbounded,
                    family_revoked_at,
                    family_auth_method,
                )
            ).one()
            family_is_current = bound_user_id is None or (
                bound_user_id == user_id
                and bound_tenant_id == tenant_id
                and revoked_at is None
                and (
                    legacy_unbounded
                    or expires_at is None
                    or (max_expires_at is not None and expires_at <= max_expires_at)
                )
            )
            return (
                revoked == 0
                and family_is_current
                and (issued_before_ms is None or issued_at_ms > issued_before_ms)
                and self._mfa_claims_are_current_in_session(
                    session,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    mfa_assured=mfa_assured,
                    mfa_factor_generation=mfa_factor_generation,
                    auth_method=bound_auth_method or "local",
                )
            )

        return self.run_transaction(operation)

    @staticmethod
    def _validate_session_family_identity(
        *,
        sid: str,
        user_id: str,
        tenant_id: str | None,
        expires_at: int,
    ) -> None:
        if not isinstance(sid, str) or not sid or sid != sid.strip() or len(sid) > 128:
            raise ValueError("sid must be a trimmed nonempty string no longer than 128 characters")
        if (
            not isinstance(user_id, str)
            or not user_id
            or user_id != user_id.strip()
            or len(user_id) > 255
        ):
            raise ValueError(
                "user_id must be a trimmed nonempty string no longer than 255 characters"
            )
        if tenant_id is not None and (
            not isinstance(tenant_id, str)
            or not tenant_id
            or tenant_id != tenant_id.strip()
            or len(tenant_id) > 255
        ):
            raise ValueError(
                "tenant_id must be None or a trimmed nonempty string no longer than 255 characters"
            )
        if type(expires_at) is not int or expires_at < 0:
            raise ValueError("expires_at must be a nonnegative integer")

    @staticmethod
    def _detached_session_family(row: SessionFamilyRow) -> SessionFamilyRow:
        return SessionFamilyRow(
            sid=row.sid,
            user_id=row.user_id,
            tenant_id=row.tenant_id,
            max_expires_at=row.max_expires_at,
            legacy_unbounded=row.legacy_unbounded,
            revoked_at=row.revoked_at,
            revoked_by_issued_at=row.revoked_by_issued_at,
            revoked_by_expires_at=row.revoked_by_expires_at,
            updated_at=row.updated_at,
        )

    def get_session_family(self, sid: str) -> SessionFamilyRow | None:
        def operation(session: Session) -> SessionFamilyRow | None:
            row = session.get(SessionFamilyRow, sid)
            return self._detached_session_family(row) if row is not None else None

        return self.run_transaction(operation)

    def register_session_family(
        self,
        *,
        sid: str,
        user_id: str,
        tenant_id: str | None,
        expires_at: int,
        issued_at_ms: int,
        predecessor_expires_at: int | None = None,
        mfa_assured: bool = False,
        mfa_factor_generation: int | None = None,
        updated_at: datetime | None = None,
        auth_method: str = "local",
    ) -> SessionFamilyRow:
        """Register an issued sibling before delivery and monotonically grow its horizon."""

        if auth_method not in {"local", "sso"}:
            raise ValueError("auth_method must be local or sso")
        self._validate_session_family_identity(
            sid=sid,
            user_id=user_id,
            tenant_id=tenant_id,
            expires_at=expires_at,
        )
        if type(issued_at_ms) is not int or issued_at_ms < 0:
            raise ValueError("issued_at_ms must be a nonnegative integer")
        if predecessor_expires_at is not None and (
            type(predecessor_expires_at) is not int or predecessor_expires_at < 0
        ):
            raise ValueError("predecessor_expires_at must be a nonnegative integer or None")
        if type(mfa_assured) is not bool:
            raise ValueError("mfa_assured must be a boolean")
        if mfa_assured:
            if (
                type(mfa_factor_generation) is not int
                or not 1 <= mfa_factor_generation <= MAX_MFA_FACTOR_GENERATION
            ):
                raise ValueError("An assured session requires a positive factor generation")
        elif mfa_factor_generation is not None:
            raise ValueError("An unassured session cannot carry a factor generation")
        requested_horizon = max(
            expires_at,
            predecessor_expires_at if predecessor_expires_at is not None else expires_at,
        )
        timestamp = updated_at or datetime.now(UTC)

        def operation(session: Session) -> SessionFamilyRow:
            locked_watermark = session.scalar(
                select(UserSessionWatermarkRow)
                .where(UserSessionWatermarkRow.user_id == user_id)
                .with_for_update()
            )

            def require_above_watermark() -> None:
                cutoff = locked_watermark.issued_before_ms if locked_watermark is not None else None
                if cutoff is not None and issued_at_ms <= cutoff:
                    raise SessionFamilyNotCurrentError(
                        "Session was issued at or before the user revocation cutoff."
                    )

            # Rotation must never launder a session's origin: an existing
            # family keeps its stored auth method no matter what the caller
            # passes; only a brand-new family adopts the caller's method.
            stored_method = session.scalar(
                select(SessionFamilyRow.auth_method).where(SessionFamilyRow.sid == sid)
            )
            effective_auth_method = stored_method or auth_method

            def require_current_mfa() -> None:
                if not self._mfa_claims_are_current_in_session(
                    session,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    mfa_assured=mfa_assured,
                    mfa_factor_generation=mfa_factor_generation,
                    auth_method=effective_auth_method,
                ):
                    raise SessionFamilyNotCurrentError(
                        "Session MFA assurance is no longer current."
                    )

            def update_existing() -> SessionFamilyRow | None:
                marker_exists = (
                    select(RevokedSessionRow.sid).where(RevokedSessionRow.sid == sid).exists()
                )
                result = session.execute(
                    update(SessionFamilyRow)
                    .where(
                        SessionFamilyRow.sid == sid,
                        SessionFamilyRow.user_id == user_id,
                        SessionFamilyRow.tenant_id == tenant_id,
                        SessionFamilyRow.revoked_at.is_(None),
                        ~marker_exists,
                    )
                    .values(
                        max_expires_at=case(
                            (
                                SessionFamilyRow.max_expires_at < requested_horizon,
                                requested_horizon,
                            ),
                            else_=SessionFamilyRow.max_expires_at,
                        ),
                        updated_at=timestamp,
                    )
                )
                if result.rowcount != 1:
                    return None
                row = session.get(SessionFamilyRow, sid)
                if row is None:
                    raise RuntimeError("Updated session family disappeared.")
                return row

            require_above_watermark()
            require_current_mfa()
            row = update_existing()
            if row is not None:
                return self._detached_session_family(row)

            existing = session.get(SessionFamilyRow, sid)
            if existing is not None:
                if existing.user_id == user_id and existing.tenant_id == tenant_id:
                    if (
                        existing.revoked_at is not None
                        or session.get(RevokedSessionRow, sid) is not None
                    ):
                        raise SessionFamilyNotCurrentError(
                            "Session family was revoked before issuance completed."
                        )
                    require_above_watermark()
                    require_current_mfa()
                raise SessionFamilyConflictError(
                    "Session family is bound to another identity or already revoked."
                )
            if session.get(RevokedSessionRow, sid) is not None:
                raise SessionFamilyNotCurrentError("Session family is already revoked.")
            require_above_watermark()
            require_current_mfa()

            try:
                with session.begin_nested():
                    row = SessionFamilyRow(
                        sid=sid,
                        user_id=user_id,
                        tenant_id=tenant_id,
                        auth_method=auth_method,
                        max_expires_at=requested_horizon,
                        legacy_unbounded=predecessor_expires_at is not None,
                        revoked_at=None,
                        revoked_by_issued_at=None,
                        revoked_by_expires_at=None,
                        updated_at=timestamp,
                    )
                    session.add(row)
                    session.flush()
            except IntegrityError:
                session.expire_all()
                row = update_existing()
                if row is None:
                    existing = session.get(SessionFamilyRow, sid)
                    if (
                        existing is not None
                        and existing.user_id == user_id
                        and existing.tenant_id == tenant_id
                        and existing.revoked_at is not None
                    ):
                        raise SessionFamilyNotCurrentError(
                            "Session family was revoked before issuance completed."
                        )
                    require_above_watermark()
                    require_current_mfa()
                    raise SessionFamilyConflictError(
                        "Session family is bound to another identity or already revoked."
                    )
            return self._detached_session_family(row)

        return self._run_family_write_transaction(operation)

    def get_session_issued_before_ms(self, user_id: str) -> int | None:
        return self.run_transaction(
            lambda session: session.scalar(
                select(UserSessionWatermarkRow.issued_before_ms).where(
                    UserSessionWatermarkRow.user_id == user_id
                )
            )
        )

    def list_session_issued_before_ms(self) -> dict[str, int]:
        def operation(session: Session) -> dict[str, int]:
            rows = session.execute(
                select(
                    UserSessionWatermarkRow.user_id,
                    UserSessionWatermarkRow.issued_before_ms,
                ).order_by(UserSessionWatermarkRow.user_id)
            )
            return {user_id: issued_before_ms for user_id, issued_before_ms in rows}

        return self.run_transaction(operation)

    @staticmethod
    def _validate_session_watermark(issued_before_ms: int) -> None:
        if (
            type(issued_before_ms) is not int
            or not 0 <= issued_before_ms <= MAX_MFA_FACTOR_GENERATION
        ):
            raise ValueError("issued_before_ms must fit a nonnegative signed BIGINT")

    @staticmethod
    def _advance_session_watermark(
        session: Session,
        *,
        user_id: str,
        tenant_id: str | None,
        issued_before_ms: int,
        reason: str,
        updated_at: datetime,
        updated_by: str | None,
    ) -> int:
        result = session.execute(
            update(UserSessionWatermarkRow)
            .where(
                UserSessionWatermarkRow.user_id == user_id,
                UserSessionWatermarkRow.issued_before_ms < issued_before_ms,
            )
            .values(
                tenant_id=tenant_id,
                issued_before_ms=issued_before_ms,
                updated_at=updated_at,
                updated_by=updated_by,
                reason=reason,
            )
        )
        if result.rowcount == 1:
            return issued_before_ms

        existing = session.get(UserSessionWatermarkRow, user_id)
        if existing is not None:
            return existing.issued_before_ms

        try:
            with session.begin_nested():
                session.add(
                    UserSessionWatermarkRow(
                        user_id=user_id,
                        tenant_id=tenant_id,
                        issued_before_ms=issued_before_ms,
                        updated_at=updated_at,
                        updated_by=updated_by,
                        reason=reason,
                    )
                )
                session.flush()
            return issued_before_ms
        except IntegrityError:
            result = session.execute(
                update(UserSessionWatermarkRow)
                .where(
                    UserSessionWatermarkRow.user_id == user_id,
                    UserSessionWatermarkRow.issued_before_ms < issued_before_ms,
                )
                .values(
                    tenant_id=tenant_id,
                    issued_before_ms=issued_before_ms,
                    updated_at=updated_at,
                    updated_by=updated_by,
                    reason=reason,
                )
            )
            if result.rowcount == 1:
                return issued_before_ms
            existing = session.get(UserSessionWatermarkRow, user_id)
            if existing is None:
                raise RuntimeError("Session watermark insert conflict could not be resolved.")
            return existing.issued_before_ms

    @staticmethod
    def _advance_session_watermark_strict(
        session: Session,
        *,
        user_id: str,
        tenant_id: str | None,
        issued_before_ms: int,
        reason: str,
        updated_at: datetime,
        updated_by: str | None,
    ) -> int:
        """Atomically advance to ``max(requested, existing + 1)``."""

        locked_existing = session.scalar(
            select(UserSessionWatermarkRow)
            .where(UserSessionWatermarkRow.user_id == user_id)
            .with_for_update()
        )
        if (
            locked_existing is not None
            and locked_existing.issued_before_ms >= issued_before_ms
            and locked_existing.issued_before_ms >= MAX_MFA_FACTOR_GENERATION
        ):
            raise MfaStateConflictError("The session watermark cannot be advanced.")

        def update_existing() -> int | None:
            result = session.execute(
                update(UserSessionWatermarkRow)
                .where(UserSessionWatermarkRow.user_id == user_id)
                .values(
                    tenant_id=tenant_id,
                    issued_before_ms=case(
                        (
                            UserSessionWatermarkRow.issued_before_ms >= issued_before_ms,
                            UserSessionWatermarkRow.issued_before_ms + 1,
                        ),
                        else_=issued_before_ms,
                    ),
                    updated_at=updated_at,
                    updated_by=updated_by,
                    reason=reason,
                )
            )
            if result.rowcount != 1:
                return None
            advanced = session.scalar(
                select(UserSessionWatermarkRow.issued_before_ms).where(
                    UserSessionWatermarkRow.user_id == user_id
                )
            )
            if advanced is None:
                raise RuntimeError("Strict session watermark update disappeared.")
            return advanced

        advanced = update_existing()
        if advanced is not None:
            return advanced
        try:
            with session.begin_nested():
                session.add(
                    UserSessionWatermarkRow(
                        user_id=user_id,
                        tenant_id=tenant_id,
                        issued_before_ms=issued_before_ms,
                        updated_at=updated_at,
                        updated_by=updated_by,
                        reason=reason,
                    )
                )
                session.flush()
            return issued_before_ms
        except IntegrityError:
            advanced = update_existing()
            if advanced is None:
                raise RuntimeError("Strict session watermark conflict could not be resolved.")
            return advanced

    def advance_session_issued_before_ms(
        self,
        user_id: str,
        tenant_id: str | None,
        issued_before_ms: int,
        *,
        reason: str = "security-revocation",
        updated_at: datetime | None = None,
        updated_by: str | None = None,
    ) -> int:
        """Advance a minimum-valid-session epoch-millisecond without regressing it."""

        self._validate_session_watermark(issued_before_ms)
        reason, updated_by = _watermark_metadata(reason, updated_by)
        timestamp = updated_at or datetime.now(UTC)
        return self.run_transaction(
            lambda session: self._advance_session_watermark(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                issued_before_ms=issued_before_ms,
                reason=reason,
                updated_at=timestamp,
                updated_by=updated_by,
            )
        )

    def advance_session_issued_before_ms_strict(
        self,
        user_id: str,
        tenant_id: str | None,
        issued_before_ms: int,
        *,
        reason: str = "security-revocation",
        updated_at: datetime | None = None,
        updated_by: str | None = None,
        reset_mfa: bool = False,
    ) -> int:
        """Advance the cutoff and invalidate MFA flows in one transaction."""

        self._validate_session_watermark(issued_before_ms)
        reason, updated_by = _watermark_metadata(reason, updated_by)
        timestamp = updated_at or datetime.now(UTC)
        if type(reset_mfa) is not bool:
            raise ValueError("reset_mfa must be a boolean")

        def operation(session: Session) -> int:
            session.execute(
                delete(TotpPendingEnrollmentRow).where(TotpPendingEnrollmentRow.user_id == user_id)
            )
            session.execute(
                delete(MfaPreauthChallengeRow).where(MfaPreauthChallengeRow.user_id == user_id)
            )
            if reset_mfa:
                session.execute(
                    delete(TotpRecoveryCodeRow).where(TotpRecoveryCodeRow.user_id == user_id)
                )
                session.execute(
                    delete(UserTotpFactorRow).where(UserTotpFactorRow.user_id == user_id)
                )
            return self._advance_session_watermark_strict(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                issued_before_ms=issued_before_ms,
                reason=reason,
                updated_at=timestamp,
                updated_by=updated_by,
            )

        return self.run_transaction(operation)

    def purge_a5_user(
        self,
        user_id: str,
        tenant_id: str | None,
        issued_before_ms: int,
        *,
        reason: str = "user-deleted",
        updated_at: datetime | None = None,
        updated_by: str | None = None,
    ) -> dict[str, int]:
        """Atomically remove current user-owned A5 rows and retain a watermark."""

        self._validate_session_watermark(issued_before_ms)
        reason, updated_by = _watermark_metadata(reason, updated_by)
        timestamp = updated_at or datetime.now(UTC)
        # Preview files are the only stored copy of uploaded images; collect
        # the doomed IDs inside the transaction and unlink after it commits.
        doomed_attachment_ids: list[str] = []

        def operation(session: Session) -> dict[str, int]:
            doomed_thread_ids = list(
                session.execute(
                    select(ChatThreadRow.id).where(ChatThreadRow.owner_user_id == user_id)
                ).scalars()
            )
            if doomed_thread_ids:
                session.execute(
                    delete(ChatThreadTagRow).where(
                        ChatThreadTagRow.thread_id.in_(doomed_thread_ids)
                    )
                )
                session.execute(
                    delete(RetentionHoldThreadRow).where(
                        RetentionHoldThreadRow.thread_id.in_(doomed_thread_ids)
                    )
                )
            session.execute(
                delete(ChatFeedbackRow).where(ChatFeedbackRow.user_id == user_id)
            )
            removed_threads = (
                session.execute(
                    delete(ChatThreadRow).where(ChatThreadRow.owner_user_id == user_id)
                ).rowcount
                or 0
            )
            removed_folders = (
                session.execute(
                    delete(ChatFolderRow).where(ChatFolderRow.owner_user_id == user_id)
                ).rowcount
                or 0
            )
            doomed_attachment_ids.extend(
                session.execute(
                    select(ChatAttachmentRow.id).where(
                        ChatAttachmentRow.owner_user_id == user_id
                    )
                ).scalars()
            )
            removed_attachments = (
                session.execute(
                    delete(ChatAttachmentRow).where(ChatAttachmentRow.owner_user_id == user_id)
                ).rowcount
                or 0
            )
            removed_api_keys = (
                session.execute(
                    delete(UserApiKeyRow).where(UserApiKeyRow.user_id == user_id)
                ).rowcount
                or 0
            )
            removed_mfa_challenges = (
                session.execute(
                    delete(MfaPreauthChallengeRow).where(MfaPreauthChallengeRow.user_id == user_id)
                ).rowcount
                or 0
            )
            removed_mfa_enrollments = (
                session.execute(
                    delete(TotpPendingEnrollmentRow).where(
                        TotpPendingEnrollmentRow.user_id == user_id
                    )
                ).rowcount
                or 0
            )
            removed_recovery_codes = (
                session.execute(
                    delete(TotpRecoveryCodeRow).where(TotpRecoveryCodeRow.user_id == user_id)
                ).rowcount
                or 0
            )
            removed_mfa_factors = (
                session.execute(
                    delete(UserTotpFactorRow).where(UserTotpFactorRow.user_id == user_id)
                ).rowcount
                or 0
            )
            self._advance_session_watermark_strict(
                session,
                user_id=user_id,
                tenant_id=tenant_id,
                issued_before_ms=issued_before_ms,
                reason=reason,
                updated_at=timestamp,
                updated_by=updated_by,
            )
            return {
                "removed_threads": removed_threads,
                "removed_folders": removed_folders,
                "removed_sessions": removed_threads,
                "removed_attachments": removed_attachments,
                "removed_api_keys": removed_api_keys,
                "removed_mfa_challenges": removed_mfa_challenges,
                "removed_mfa_enrollments": removed_mfa_enrollments,
                "removed_recovery_codes": removed_recovery_codes,
                "removed_mfa_factors": removed_mfa_factors,
            }

        result = self.run_transaction(operation)
        for attachment_id in doomed_attachment_ids:
            delete_attachment_preview(attachment_id)
        return result

    def purge_a5_tenant(
        self,
        tenant_id: str,
        user_cutoffs: Mapping[str, int],
        *,
        reason: str = "tenant-deleted",
        updated_at: datetime | None = None,
        updated_by: str | None = None,
    ) -> dict[str, int]:
        """Atomically delete tenant current state while retaining all history rows."""

        cutoffs = dict(user_cutoffs)
        for cutoff in cutoffs.values():
            self._validate_session_watermark(cutoff)
        reason, updated_by = _watermark_metadata(reason, updated_by)
        timestamp = updated_at or datetime.now(UTC)
        user_ids = list(cutoffs)
        doomed_attachment_ids: list[str] = []

        def owned_or_tenant(tenant_column: Any, owner_column: Any) -> Any:
            if user_ids:
                return or_(tenant_column == tenant_id, owner_column.in_(user_ids))
            return tenant_column == tenant_id

        def operation(session: Session) -> dict[str, int]:
            doomed_thread_ids = list(
                session.execute(
                    select(ChatThreadRow.id).where(
                        owned_or_tenant(ChatThreadRow.tenant_id, ChatThreadRow.owner_user_id)
                    )
                ).scalars()
            )
            if doomed_thread_ids:
                session.execute(
                    delete(ChatThreadTagRow).where(
                        ChatThreadTagRow.thread_id.in_(doomed_thread_ids)
                    )
                )
                session.execute(
                    delete(RetentionHoldThreadRow).where(
                        RetentionHoldThreadRow.thread_id.in_(doomed_thread_ids)
                    )
                )
            session.execute(
                delete(ChatThreadTagRow).where(ChatThreadTagRow.tenant_id == tenant_id)
            )
            session.execute(
                delete(ChatFeedbackRow).where(
                    owned_or_tenant(ChatFeedbackRow.tenant_id, ChatFeedbackRow.user_id)
                )
            )
            doomed_hold_ids = list(
                session.execute(
                    select(RetentionHoldRow.id).where(RetentionHoldRow.tenant_id == tenant_id)
                ).scalars()
            )
            if doomed_hold_ids:
                session.execute(
                    delete(RetentionHoldThreadRow).where(
                        RetentionHoldThreadRow.hold_id.in_(doomed_hold_ids)
                    )
                )
                session.execute(
                    delete(RetentionHoldRow).where(RetentionHoldRow.id.in_(doomed_hold_ids))
                )
            removed_threads = (
                session.execute(
                    delete(ChatThreadRow).where(
                        owned_or_tenant(ChatThreadRow.tenant_id, ChatThreadRow.owner_user_id)
                    )
                ).rowcount
                or 0
            )
            removed_folders = (
                session.execute(
                    delete(ChatFolderRow).where(
                        owned_or_tenant(ChatFolderRow.tenant_id, ChatFolderRow.owner_user_id)
                    )
                ).rowcount
                or 0
            )
            doomed_attachment_ids.extend(
                session.execute(
                    select(ChatAttachmentRow.id).where(
                        owned_or_tenant(
                            ChatAttachmentRow.tenant_id,
                            ChatAttachmentRow.owner_user_id,
                        )
                    )
                ).scalars()
            )
            removed_attachments = (
                session.execute(
                    delete(ChatAttachmentRow).where(
                        owned_or_tenant(
                            ChatAttachmentRow.tenant_id,
                            ChatAttachmentRow.owner_user_id,
                        )
                    )
                ).rowcount
                or 0
            )
            removed_api_keys = (
                session.execute(
                    delete(UserApiKeyRow).where(
                        owned_or_tenant(UserApiKeyRow.tenant_id, UserApiKeyRow.user_id)
                    )
                ).rowcount
                or 0
            )
            removed_mfa_challenges = (
                session.execute(
                    delete(MfaPreauthChallengeRow).where(
                        MfaPreauthChallengeRow.tenant_id == tenant_id
                    )
                ).rowcount
                or 0
            )
            removed_mfa_enrollments = (
                session.execute(
                    delete(TotpPendingEnrollmentRow).where(
                        TotpPendingEnrollmentRow.tenant_id == tenant_id
                    )
                ).rowcount
                or 0
            )
            removed_recovery_codes = (
                session.execute(
                    delete(TotpRecoveryCodeRow).where(TotpRecoveryCodeRow.tenant_id == tenant_id)
                ).rowcount
                or 0
            )
            removed_mfa_factors = (
                session.execute(
                    delete(UserTotpFactorRow).where(UserTotpFactorRow.tenant_id == tenant_id)
                ).rowcount
                or 0
            )
            removed_mfa_policies = (
                session.execute(
                    delete(TenantMfaPolicyRow).where(TenantMfaPolicyRow.tenant_id == tenant_id)
                ).rowcount
                or 0
            )
            for user_id, cutoff in cutoffs.items():
                self._advance_session_watermark_strict(
                    session,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    issued_before_ms=cutoff,
                    reason=reason,
                    updated_at=timestamp,
                    updated_by=updated_by,
                )
            return {
                "removed_threads": removed_threads,
                "removed_folders": removed_folders,
                "removed_sessions": removed_threads,
                "removed_attachments": removed_attachments,
                "removed_api_keys": removed_api_keys,
                "removed_mfa_challenges": removed_mfa_challenges,
                "removed_mfa_enrollments": removed_mfa_enrollments,
                "removed_recovery_codes": removed_recovery_codes,
                "removed_mfa_factors": removed_mfa_factors,
                "removed_mfa_policies": removed_mfa_policies,
                "retained_watermarks": len(cutoffs),
            }

        result = self.run_transaction(operation)
        for attachment_id in doomed_attachment_ids:
            delete_attachment_preview(attachment_id)
        return result

    # Revoked sessions ---------------------------------------------------

    @staticmethod
    def _bind_revoked_session(
        session: Session,
        *,
        sid: str,
        user_id: str,
        tenant_id: str | None,
        issued_at: int,
        expires_at: int,
        revoked_at: datetime,
        reason: str,
    ) -> RevokedSessionRow:
        row = session.get(RevokedSessionRow, sid)
        if row is None:
            try:
                with session.begin_nested():
                    row = RevokedSessionRow(
                        sid=sid,
                        user_id=user_id,
                        tenant_id=tenant_id,
                        issued_at=issued_at,
                        expires_at=expires_at,
                        revoked_at=revoked_at,
                        reason=reason,
                    )
                    session.add(row)
                    session.flush()
            except IntegrityError:
                session.expire_all()
                row = session.get(RevokedSessionRow, sid)
                if row is None:
                    raise
        if (
            row.user_id != user_id
            or row.tenant_id != tenant_id
            or row.issued_at != issued_at
            or row.expires_at != expires_at
        ):
            raise SessionRevocationConflictError(
                "Session id is already bound to different signed claims."
            )
        return RevokedSessionRow(
            sid=row.sid,
            user_id=row.user_id,
            tenant_id=row.tenant_id,
            issued_at=row.issued_at,
            expires_at=row.expires_at,
            revoked_at=row.revoked_at,
            reason=row.reason,
        )

    def revoke_session(
        self,
        *,
        sid: str,
        user_id: str,
        tenant_id: str | None,
        issued_at: int,
        expires_at: int,
        revoked_at: datetime | None = None,
        reason: str = "logout",
    ) -> RevokedSessionRow:
        """Compatibility entrypoint; untracked ids become legacy quarantine."""

        try:
            return self.revoke_session_family(
                sid=sid,
                user_id=user_id,
                tenant_id=tenant_id,
                issued_at=issued_at,
                expires_at=expires_at,
                revoked_at=revoked_at,
                reason=reason,
            )
        except SessionFamilyConflictError as exc:
            raise SessionRevocationConflictError(
                "Session id is already bound to different signed claims."
            ) from exc

    def revoke_session_family(
        self,
        *,
        sid: str,
        user_id: str,
        tenant_id: str | None,
        issued_at: int,
        expires_at: int,
        revoked_at: datetime | None = None,
        reason: str = "logout",
    ) -> RevokedSessionRow:
        """Atomically quarantine a family and bind the exact presented claims."""

        self._validate_session_family_identity(
            sid=sid,
            user_id=user_id,
            tenant_id=tenant_id,
            expires_at=expires_at,
        )
        if type(issued_at) is not int or issued_at < 0 or expires_at <= issued_at:
            raise ValueError("expires_at must be greater than issued_at")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("reason must be a nonempty string")
        timestamp = revoked_at or datetime.now(UTC)

        def operation(session: Session) -> RevokedSessionRow:
            def revoke_existing() -> SessionFamilyRow | None:
                result = session.execute(
                    update(SessionFamilyRow)
                    .where(
                        SessionFamilyRow.sid == sid,
                        SessionFamilyRow.user_id == user_id,
                        SessionFamilyRow.tenant_id == tenant_id,
                        SessionFamilyRow.revoked_at.is_(None),
                        or_(
                            SessionFamilyRow.legacy_unbounded.is_(True),
                            SessionFamilyRow.max_expires_at >= expires_at,
                        ),
                    )
                    .values(
                        max_expires_at=case(
                            (
                                SessionFamilyRow.max_expires_at < expires_at,
                                expires_at,
                            ),
                            else_=SessionFamilyRow.max_expires_at,
                        ),
                        revoked_at=timestamp,
                        revoked_by_issued_at=issued_at,
                        revoked_by_expires_at=expires_at,
                        updated_at=timestamp,
                    )
                )
                if result.rowcount != 1:
                    return None
                row = session.get(SessionFamilyRow, sid)
                if row is None:
                    raise RuntimeError("Revoked session family disappeared.")
                return row

            family = session.get(SessionFamilyRow, sid)
            if family is None:
                try:
                    with session.begin_nested():
                        family = SessionFamilyRow(
                            sid=sid,
                            user_id=user_id,
                            tenant_id=tenant_id,
                            max_expires_at=expires_at,
                            legacy_unbounded=True,
                            revoked_at=timestamp,
                            revoked_by_issued_at=issued_at,
                            revoked_by_expires_at=expires_at,
                            updated_at=timestamp,
                        )
                        session.add(family)
                        session.flush()
                except IntegrityError:
                    session.expire_all()
                    family = revoke_existing()
                    if family is None:
                        family = session.get(SessionFamilyRow, sid)
            elif family.revoked_at is None:
                family = revoke_existing()
                if family is None:
                    session.expire_all()
                    family = session.get(SessionFamilyRow, sid)

            if family is None:
                raise SessionFamilyConflictError(
                    "Session family is bound to another identity or has inconsistent expiry metadata."
                )
            if family.user_id != user_id or family.tenant_id != tenant_id:
                raise SessionFamilyConflictError("Session family is bound to another identity.")
            if not family.legacy_unbounded and expires_at > family.max_expires_at:
                raise SessionFamilyConflictError(
                    "Session expiry exceeds the registered family horizon."
                )
            if family.revoked_at is not None and (
                family.revoked_by_issued_at != issued_at
                or family.revoked_by_expires_at != expires_at
            ):
                raise SessionRevocationConflictError(
                    "Session id is already bound to different signed claims."
                )
            return self._bind_revoked_session(
                session,
                sid=sid,
                user_id=user_id,
                tenant_id=tenant_id,
                issued_at=issued_at,
                expires_at=expires_at,
                revoked_at=timestamp,
                reason=reason.strip(),
            )

        return self._run_family_write_transaction(operation)

    def is_session_revoked(self, sid: str) -> bool:
        return self.run_transaction(
            lambda session: (
                session.scalar(
                    select(func.count())
                    .select_from(RevokedSessionRow)
                    .where(RevokedSessionRow.sid == sid)
                )
                == 1
            )
        )

    def purge_expired_sessions(self, expires_through: int, *, limit: int = 500) -> int:
        if type(expires_through) is not int or expires_through < 0:
            raise ValueError("expires_through must be a nonnegative integer")
        if type(limit) is not int or limit < 1:
            raise ValueError("limit must be positive")

        def operation(session: Session) -> int:
            any_marker = (
                select(RevokedSessionRow.sid)
                .where(RevokedSessionRow.sid == SessionFamilyRow.sid)
                .exists()
            )
            matching_marker = (
                select(RevokedSessionRow.sid)
                .where(
                    RevokedSessionRow.sid == SessionFamilyRow.sid,
                    RevokedSessionRow.user_id == SessionFamilyRow.user_id,
                    or_(
                        and_(
                            RevokedSessionRow.tenant_id.is_(None),
                            SessionFamilyRow.tenant_id.is_(None),
                        ),
                        RevokedSessionRow.tenant_id == SessionFamilyRow.tenant_id,
                    ),
                    RevokedSessionRow.issued_at == SessionFamilyRow.revoked_by_issued_at,
                    RevokedSessionRow.expires_at == SessionFamilyRow.revoked_by_expires_at,
                    RevokedSessionRow.revoked_at == SessionFamilyRow.revoked_at,
                )
                .exists()
            )
            expired_families = list(
                session.scalars(
                    select(SessionFamilyRow)
                    .where(
                        SessionFamilyRow.legacy_unbounded.is_(False),
                        SessionFamilyRow.max_expires_at <= expires_through,
                        or_(
                            and_(
                                SessionFamilyRow.revoked_at.is_(None),
                                SessionFamilyRow.revoked_by_issued_at.is_(None),
                                SessionFamilyRow.revoked_by_expires_at.is_(None),
                                ~any_marker,
                            ),
                            and_(
                                SessionFamilyRow.revoked_at.is_not(None),
                                matching_marker,
                            ),
                        ),
                    )
                    .order_by(SessionFamilyRow.max_expires_at, SessionFamilyRow.sid)
                    .limit(limit)
                    .with_for_update()
                )
            )
            if not expired_families:
                return 0
            removed = 0
            for family in expired_families:
                family_result = session.execute(
                    delete(SessionFamilyRow).where(
                        SessionFamilyRow.sid == family.sid,
                        SessionFamilyRow.user_id == family.user_id,
                        SessionFamilyRow.tenant_id == family.tenant_id,
                        SessionFamilyRow.legacy_unbounded.is_(False),
                        SessionFamilyRow.max_expires_at == family.max_expires_at,
                        SessionFamilyRow.max_expires_at <= expires_through,
                        SessionFamilyRow.revoked_at == family.revoked_at,
                        SessionFamilyRow.revoked_by_issued_at == family.revoked_by_issued_at,
                        SessionFamilyRow.revoked_by_expires_at == family.revoked_by_expires_at,
                    )
                )
                if family_result.rowcount != 1:
                    continue
                if family.revoked_at is not None:
                    marker_result = session.execute(
                        delete(RevokedSessionRow).where(
                            RevokedSessionRow.sid == family.sid,
                            RevokedSessionRow.user_id == family.user_id,
                            RevokedSessionRow.tenant_id == family.tenant_id,
                            RevokedSessionRow.issued_at == family.revoked_by_issued_at,
                            RevokedSessionRow.expires_at == family.revoked_by_expires_at,
                            RevokedSessionRow.revoked_at == family.revoked_at,
                        )
                    )
                    if marker_result.rowcount != 1:
                        raise RuntimeError(
                            "Session-family revocation marker changed during cleanup."
                        )
                removed += 1
            return removed

        return self._run_family_write_transaction(operation)

    # Runtime-state import receipts -------------------------------------

    def get_import_marker(self, source_digest: str) -> RuntimeStateImportRow | None:
        def operation(session: Session) -> RuntimeStateImportRow | None:
            row = session.get(RuntimeStateImportRow, source_digest)
            return _clone_import_marker(row) if row is not None else None

        return self.run_transaction(operation)

    def list_import_markers(self) -> list[RuntimeStateImportRow]:
        def operation(session: Session) -> list[RuntimeStateImportRow]:
            rows = session.scalars(
                select(RuntimeStateImportRow).order_by(
                    RuntimeStateImportRow.completed_at,
                    RuntimeStateImportRow.source_digest,
                )
            )
            return [_clone_import_marker(row) for row in rows]

        return self.run_transaction(operation)

    def insert_import_marker(self, marker: RuntimeStateImportRow) -> RuntimeStateImportRow:
        stored = _clone_import_marker(marker)

        def operation(session: Session) -> RuntimeStateImportRow:
            session.add(stored)
            session.flush()
            return _clone_import_marker(stored)

        return self.run_transaction(operation)

    @staticmethod
    def _marker_metadata(metadata: Mapping[str, Any]) -> Mapping[str, Any]:
        for key in (
            "application_state_import",
            "applicationStateImport",
            "application_state",
            "applicationState",
            "database_import",
            "databaseImport",
            "runtime_state_import",
            "runtimeStateImport",
            "import_marker",
            "importMarker",
        ):
            nested = metadata.get(key)
            if isinstance(nested, Mapping):
                return nested
        return metadata

    def verify_import_marker(
        self,
        metadata: RuntimeStateImportRow | Mapping[str, Any],
    ) -> bool:
        if isinstance(metadata, RuntimeStateImportRow):
            expected: Mapping[str, Any] = {
                "source_digest": metadata.source_digest,
                "source_version": metadata.source_version,
                "target_version": metadata.target_version,
                "completed_at": metadata.completed_at,
                "audit_count": metadata.audit_count,
                "usage_count": metadata.usage_count,
                "outbox_count": metadata.outbox_count,
                "alert_notification_count": metadata.alert_notification_count,
                "alert_runtime_count": metadata.alert_runtime_count,
                "schema_revision": APPLICATION_STATE_IMPORT_REVISION,
            }
        else:
            expected = self._marker_metadata(metadata)

        aliases = {
            "source_digest": ("source_digest", "sourceDigest"),
            "source_version": ("source_version", "sourceVersion"),
            "target_version": ("target_version", "targetVersion"),
            "schema_revision": ("schema_revision", "schemaRevision"),
            "completed_at": ("completed_at", "completedAt"),
            "audit_count": (
                "audit_count",
                "auditCount",
                "audit_events_count",
                "auditEventsCount",
            ),
            "usage_count": (
                "usage_count",
                "usageCount",
                "usage_records_count",
                "usageRecordsCount",
            ),
            "outbox_count": (
                "outbox_count",
                "outboxCount",
                "outbox_events_count",
                "outboxEventsCount",
            ),
            "alert_notification_count": (
                "alert_notification_count",
                "alertNotificationCount",
                "alert_notifications_count",
                "alertNotificationsCount",
            ),
            "alert_runtime_count": (
                "alert_runtime_count",
                "alertRuntimeCount",
                "alert_rule_runtime_count",
                "alertRuleRuntimeCount",
            ),
        }

        values: dict[str, Any] = {}
        for canonical, names in aliases.items():
            found = [expected[name] for name in names if name in expected]
            if found and any(value != found[0] for value in found[1:]):
                return False
            if found:
                values[canonical] = found[0]

        counts = expected.get("counts")
        if isinstance(counts, Mapping):
            count_aliases = {
                "audit_count": ("auditEvents", "audit_events", "audit"),
                "usage_count": ("usageRecords", "usage_records", "usage"),
                "outbox_count": ("outboxEvents", "outbox_events", "outbox"),
                "alert_notification_count": (
                    "alertNotifications",
                    "alert_notifications",
                ),
                "alert_runtime_count": ("alertRuleRuntime", "alert_rule_runtime"),
            }
            for canonical, names in count_aliases.items():
                for name in names:
                    if name in counts:
                        if canonical in values and values[canonical] != counts[name]:
                            return False
                        values[canonical] = counts[name]
                        break

        digest = values.get("source_digest")
        required = {
            "source_digest",
            "source_version",
            "target_version",
            "audit_count",
            "usage_count",
            "outbox_count",
            "alert_notification_count",
            "alert_runtime_count",
        }
        required.add("schema_revision")
        integer_fields = {
            "source_version",
            "target_version",
            "audit_count",
            "usage_count",
            "outbox_count",
            "alert_notification_count",
            "alert_runtime_count",
        }
        if (
            not required.issubset(values)
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
            or any(type(values.get(key)) is not int or values[key] < 0 for key in integer_fields)
            or not isinstance(values.get("schema_revision"), str)
        ):
            return False

        def operation(session: Session) -> bool:
            row = session.get(RuntimeStateImportRow, digest)
            if row is None:
                return False
            live_revision = session.scalar(text("select version_num from alembic_version"))
            if live_revision != HEAD_REVISION:
                return False
            if values["schema_revision"] != APPLICATION_STATE_IMPORT_REVISION:
                return False
            actual = {
                "source_digest": row.source_digest,
                "source_version": row.source_version,
                "target_version": row.target_version,
                "completed_at": row.completed_at,
                "audit_count": row.audit_count,
                "usage_count": row.usage_count,
                "outbox_count": row.outbox_count,
                "alert_notification_count": row.alert_notification_count,
                "alert_runtime_count": row.alert_runtime_count,
                "schema_revision": APPLICATION_STATE_IMPORT_REVISION,
            }
            for key, value in values.items():
                if key == "completed_at" and isinstance(value, str):
                    try:
                        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    except ValueError:
                        return False
                if isinstance(value, datetime) and isinstance(actual[key], datetime):
                    value = value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC)
                    actual_value = (
                        actual[key].replace(tzinfo=actual[key].tzinfo or UTC).astimezone(UTC)
                    )
                    if value != actual_value:
                        return False
                elif key.endswith("_count") or key in {"source_version", "target_version"}:
                    if type(value) is not int or value != actual[key]:
                        return False
                elif value != actual[key]:
                    return False
            return True

        return self.run_transaction(operation)

    # Chat-state import receipts ----------------------------------------

    def get_chat_import_marker(self, source_digest: str) -> ChatStateImportRow | None:
        def operation(session: Session) -> ChatStateImportRow | None:
            row = session.get(ChatStateImportRow, source_digest)
            return _clone_chat_import_marker(row) if row is not None else None

        return self.run_transaction(operation)

    def list_chat_import_markers(self) -> list[ChatStateImportRow]:
        def operation(session: Session) -> list[ChatStateImportRow]:
            rows = session.scalars(
                select(ChatStateImportRow).order_by(
                    ChatStateImportRow.completed_at,
                    ChatStateImportRow.source_digest,
                )
            )
            return [_clone_chat_import_marker(row) for row in rows]

        return self.run_transaction(operation)

    def insert_chat_import_marker(self, marker: ChatStateImportRow) -> ChatStateImportRow:
        stored = _clone_chat_import_marker(marker)

        def operation(session: Session) -> ChatStateImportRow:
            session.add(stored)
            session.flush()
            return _clone_chat_import_marker(stored)

        return self.run_transaction(operation)

    @staticmethod
    def _chat_marker_metadata(metadata: Mapping[str, Any]) -> Mapping[str, Any]:
        for key in ("chat_state_import", "chatStateImport", "chat_import", "chatImport"):
            nested = metadata.get(key)
            if isinstance(nested, Mapping):
                return nested
        return metadata

    def verify_chat_import_marker(
        self,
        metadata: ChatStateImportRow | Mapping[str, Any],
    ) -> bool:
        if isinstance(metadata, ChatStateImportRow):
            expected: Mapping[str, Any] = {
                "source_digest": metadata.source_digest,
                "source_version": metadata.source_version,
                "target_version": metadata.target_version,
                "completed_at": metadata.completed_at,
                "prior_application_state_digest": metadata.prior_application_state_digest,
                "thread_count": metadata.thread_count,
                "folder_count": metadata.folder_count,
                "attachment_count": metadata.attachment_count,
                "api_key_count": metadata.api_key_count,
                "watermark_count": metadata.watermark_count,
                "schema_revision": CHAT_STATE_IMPORT_REVISION,
            }
        else:
            expected = self._chat_marker_metadata(metadata)

        aliases = {
            "source_digest": ("source_digest", "sourceDigest"),
            "source_version": ("source_version", "sourceVersion"),
            "target_version": ("target_version", "targetVersion"),
            "schema_revision": ("schema_revision", "schemaRevision"),
            "completed_at": ("completed_at", "completedAt"),
            "prior_application_state_digest": (
                "prior_application_state_digest",
                "priorApplicationStateDigest",
            ),
            "thread_count": ("thread_count", "threadCount"),
            "folder_count": ("folder_count", "folderCount"),
            "attachment_count": ("attachment_count", "attachmentCount"),
            "api_key_count": ("api_key_count", "apiKeyCount"),
            "watermark_count": ("watermark_count", "watermarkCount"),
        }
        values: dict[str, Any] = {}
        for canonical, names in aliases.items():
            found = [expected[name] for name in names if name in expected]
            if found and any(value != found[0] for value in found[1:]):
                return False
            if found:
                values[canonical] = found[0]

        counts = expected.get("counts")
        if isinstance(counts, Mapping):
            count_aliases = {
                "thread_count": ("chatThreads", "chat_threads", "threads"),
                "folder_count": ("chatFolders", "chat_folders", "folders"),
                "attachment_count": (
                    "chatAttachments",
                    "chat_attachments",
                    "attachments",
                ),
                "api_key_count": ("userApiKeys", "user_api_keys", "apiKeys"),
                "watermark_count": (
                    "sessionWatermarks",
                    "session_watermarks",
                    "watermarks",
                ),
            }
            for canonical, names in count_aliases.items():
                for name in names:
                    if name in counts:
                        if canonical in values and values[canonical] != counts[name]:
                            return False
                        values[canonical] = counts[name]
                        break

        required = {
            "source_digest",
            "source_version",
            "target_version",
            "schema_revision",
            "prior_application_state_digest",
            "thread_count",
            "folder_count",
            "attachment_count",
            "api_key_count",
            "watermark_count",
        }
        integer_fields = {
            "source_version",
            "target_version",
            "thread_count",
            "folder_count",
            "attachment_count",
            "api_key_count",
            "watermark_count",
        }
        digest = values.get("source_digest")
        prior_digest = values.get("prior_application_state_digest")
        if (
            not required.issubset(values)
            or not isinstance(digest, str)
            or not _is_sha256_hex(digest)
            or not isinstance(prior_digest, str)
            or not _is_sha256_hex(prior_digest)
            or any(type(values.get(key)) is not int or values[key] < 0 for key in integer_fields)
            or values.get("schema_revision") != CHAT_STATE_IMPORT_REVISION
        ):
            return False

        def operation(session: Session) -> bool:
            row = session.get(ChatStateImportRow, digest)
            if row is None:
                return False
            if session.get(RuntimeStateImportRow, prior_digest) is None:
                return False
            live_revision = session.scalar(text("select version_num from alembic_version"))
            if live_revision != HEAD_REVISION:
                return False
            actual: dict[str, Any] = {
                "source_digest": row.source_digest,
                "source_version": row.source_version,
                "target_version": row.target_version,
                "completed_at": row.completed_at,
                "prior_application_state_digest": row.prior_application_state_digest,
                "thread_count": row.thread_count,
                "folder_count": row.folder_count,
                "attachment_count": row.attachment_count,
                "api_key_count": row.api_key_count,
                "watermark_count": row.watermark_count,
                "schema_revision": CHAT_STATE_IMPORT_REVISION,
            }
            for key, value in values.items():
                if key == "completed_at" and isinstance(value, str):
                    try:
                        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    except ValueError:
                        return False
                if isinstance(value, datetime) and isinstance(actual[key], datetime):
                    value = value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC)
                    actual_value = (
                        actual[key].replace(tzinfo=actual[key].tzinfo or UTC).astimezone(UTC)
                    )
                    if value != actual_value:
                        return False
                elif key in integer_fields:
                    if type(value) is not int or value != actual[key]:
                        return False
                elif value != actual[key]:
                    return False
            return True

        return self.run_transaction(operation)

    # Alert cooldown runtime --------------------------------------------

    def get_alert_rule_runtime(self, rule_id: str) -> AlertRuleRuntimeRow | None:
        def operation(session: Session) -> AlertRuleRuntimeRow | None:
            row = session.get(AlertRuleRuntimeRow, rule_id)
            if row is None:
                return None
            return AlertRuleRuntimeRow(
                rule_id=row.rule_id,
                last_triggered_at=row.last_triggered_at,
            )

        return self.run_transaction(operation)

    def set_alert_rule_last_triggered(
        self,
        rule_id: str,
        last_triggered_at: datetime | None,
    ) -> AlertRuleRuntimeRow:
        def operation(session: Session) -> AlertRuleRuntimeRow:
            row = session.get(AlertRuleRuntimeRow, rule_id)
            if row is None:
                row = AlertRuleRuntimeRow(rule_id=rule_id)
                session.add(row)
            row.last_triggered_at = last_triggered_at
            session.flush()
            return AlertRuleRuntimeRow(
                rule_id=row.rule_id,
                last_triggered_at=row.last_triggered_at,
            )

        return self.run_transaction(operation)

    def delete_alert_rule_runtime(self, rule_id: str) -> bool:
        def operation(session: Session) -> bool:
            row = session.get(AlertRuleRuntimeRow, rule_id)
            if row is None:
                return False
            session.delete(row)
            return True

        return self.run_transaction(operation)

    # Alert notifications ----------------------------------------------

    @staticmethod
    def _notification_filters(
        *,
        tenant_id: str | None,
        tenant_visible: bool,
        scope: str | None,
        statuses: str | Sequence[str] | None,
        created_from: datetime | None,
        created_through: datetime | None,
    ) -> list[Any]:
        filters: list[Any] = []
        if tenant_visible:
            filters.extend(
                (
                    AlertNotificationRow.scope == "tenant",
                    AlertNotificationRow.tenant_id.is_not(None),
                )
            )
        if tenant_id is not None:
            filters.append(AlertNotificationRow.tenant_id == tenant_id)
        if scope is not None:
            filters.append(AlertNotificationRow.scope == scope)
        if statuses is not None:
            normalized = [statuses] if isinstance(statuses, str) else list(statuses)
            filters.append(AlertNotificationRow.status.in_(normalized))
        if created_from is not None:
            filters.append(AlertNotificationRow.created_at >= created_from)
        if created_through is not None:
            filters.append(AlertNotificationRow.created_at <= created_through)
        return filters

    def insert_alert_notification(
        self,
        notification: AlertNotification,
    ) -> AlertNotification:
        def operation(session: Session) -> AlertNotification:
            session.add(AlertNotificationRow.from_model(notification))
            session.flush()
            return _freeze_notification(notification)

        return self.run_transaction(operation)

    def upsert_alert_notification(
        self,
        notification: AlertNotification,
    ) -> AlertNotification:
        def operation(session: Session) -> AlertNotification:
            row = self._notification_row(session, notification.id)
            if row is None:
                row = AlertNotificationRow.from_model(notification)
                session.add(row)
            else:
                _apply_notification_model(row, notification)
            session.flush()
            return _freeze_notification(notification)

        return self.run_transaction(operation)

    def save_alert_notification(self, notification: AlertNotification) -> AlertNotification:
        """Persist a new or explicitly mutated detached notification."""

        return self.upsert_alert_notification(notification)

    def record_alert_trigger(
        self,
        notification: AlertNotification,
        *,
        expected_last_triggered_at: datetime | None,
        last_triggered_at: datetime | None,
        max_records: int,
    ) -> AlertNotification | None:
        """Claim a cooldown transition and persist its notification atomically.

        ``None`` means another worker changed the cooldown after the caller
        read it.  That worker owns the trigger and this transaction stores no
        notification.
        """

        _validate_max_records(max_records)
        if max_records == 0:
            raise ValueError("max_records must retain the triggered notification")

        def operation(session: Session) -> AlertNotification | None:
            if expected_last_triggered_at is None:
                claimed = (
                    session.execute(
                        update(AlertRuleRuntimeRow)
                        .where(
                            AlertRuleRuntimeRow.rule_id == notification.rule_id,
                            AlertRuleRuntimeRow.last_triggered_at.is_(None),
                        )
                        .values(last_triggered_at=last_triggered_at)
                    ).rowcount
                    == 1
                )
                if not claimed:
                    try:
                        with session.begin_nested():
                            session.add(
                                AlertRuleRuntimeRow(
                                    rule_id=notification.rule_id,
                                    last_triggered_at=last_triggered_at,
                                )
                            )
                            session.flush()
                    except IntegrityError:
                        return None
            else:
                result = session.execute(
                    update(AlertRuleRuntimeRow)
                    .where(
                        AlertRuleRuntimeRow.rule_id == notification.rule_id,
                        AlertRuleRuntimeRow.last_triggered_at == expected_last_triggered_at,
                    )
                    .values(last_triggered_at=last_triggered_at)
                )
                if result.rowcount != 1:
                    return None

            session.add(AlertNotificationRow.from_model(notification))
            session.flush()

            count = session.scalar(select(func.count()).select_from(AlertNotificationRow)) or 0
            overflow = max(0, count - max_records)
            if overflow:
                sequences = list(
                    session.scalars(
                        select(AlertNotificationRow.sequence)
                        .order_by(
                            AlertNotificationRow.created_at,
                            AlertNotificationRow.sequence,
                        )
                        .limit(overflow)
                    )
                )
                session.execute(
                    delete(AlertNotificationRow).where(AlertNotificationRow.sequence.in_(sequences))
                )
            return _freeze_notification(notification)

        return self.run_transaction(operation)

    def update_alert_notification(
        self,
        notification: AlertNotification,
    ) -> AlertNotification:
        def operation(session: Session) -> AlertNotification:
            row = self._notification_row(session, notification.id)
            if row is None:
                raise KeyError(notification.id)
            _apply_notification_model(row, notification)
            session.flush()
            return _freeze_notification(notification)

        return self.run_transaction(operation)

    def get_alert_notification(self, notification_id: str) -> AlertNotification | None:
        def operation(session: Session) -> AlertNotification | None:
            row = self._notification_row(session, notification_id)
            return _freeze_notification(row.to_model()) if row is not None else None

        return self.run_transaction(operation)

    def list_alert_notifications(
        self,
        *,
        tenant_id: str | None = None,
        tenant_visible: bool = False,
        scope: str | None = None,
        statuses: str | Sequence[str] | None = None,
        created_from: datetime | None = None,
        created_through: datetime | None = None,
        newest_first: bool = True,
        limit: int | None = None,
    ) -> list[AlertNotification]:
        _validate_limit(limit)
        filters = self._notification_filters(
            tenant_id=tenant_id,
            tenant_visible=tenant_visible,
            scope=scope,
            statuses=statuses,
            created_from=created_from,
            created_through=created_through,
        )

        def operation(session: Session) -> list[AlertNotification]:
            if newest_first:
                ordering = (
                    AlertNotificationRow.created_at.desc(),
                    AlertNotificationRow.sequence.asc(),
                )
            else:
                ordering = (
                    AlertNotificationRow.created_at.asc(),
                    AlertNotificationRow.sequence.asc(),
                )
            statement = select(AlertNotificationRow).where(*filters).order_by(*ordering)
            if limit is not None:
                statement = statement.limit(limit)
            return [_freeze_notification(row.to_model()) for row in session.scalars(statement)]

        return self.run_transaction(operation)

    def list_alert_notifications_in_insertion_order(self) -> list[AlertNotification]:
        def operation(session: Session) -> list[AlertNotification]:
            rows = session.scalars(
                select(AlertNotificationRow).order_by(AlertNotificationRow.sequence)
            )
            return [_freeze_notification(row.to_model()) for row in rows]

        return self.run_transaction(operation)

    def count_alert_notifications(
        self,
        *,
        tenant_id: str | None = None,
        tenant_visible: bool = False,
        scope: str | None = None,
        statuses: str | Sequence[str] | None = None,
        created_from: datetime | None = None,
        created_through: datetime | None = None,
    ) -> int:
        filters = self._notification_filters(
            tenant_id=tenant_id,
            tenant_visible=tenant_visible,
            scope=scope,
            statuses=statuses,
            created_from=created_from,
            created_through=created_through,
        )
        return self.run_transaction(
            lambda session: (
                session.scalar(
                    select(func.count()).select_from(AlertNotificationRow).where(*filters)
                )
                or 0
            )
        )

    def queued_alert_notifications(self, limit: int | None = None) -> list[AlertNotification]:
        _validate_limit(limit)

        def operation(session: Session) -> list[AlertNotification]:
            statement = (
                select(AlertNotificationRow)
                .where(AlertNotificationRow.status == "queued")
                .order_by(AlertNotificationRow.created_at, AlertNotificationRow.sequence)
            )
            if limit is not None:
                statement = statement.limit(limit)
            return [_freeze_notification(row.to_model()) for row in session.scalars(statement)]

        return self.run_transaction(operation)

    def delete_alert_notification(self, notification_id: str) -> bool:
        def operation(session: Session) -> bool:
            row = self._notification_row(session, notification_id)
            if row is None:
                return False
            session.delete(row)
            return True

        return self.run_transaction(operation)

    def clear_alert_notifications(self) -> int:
        def operation(session: Session) -> int:
            count = session.scalar(select(func.count()).select_from(AlertNotificationRow)) or 0
            session.execute(delete(AlertNotificationRow))
            return count

        return self.run_transaction(operation)

    def trim_alert_notifications(self, max_records: int) -> int:
        _validate_max_records(max_records)

        def operation(session: Session) -> int:
            count = session.scalar(select(func.count()).select_from(AlertNotificationRow)) or 0
            overflow = max(0, count - max_records)
            if not overflow:
                return 0
            sequences = list(
                session.scalars(
                    select(AlertNotificationRow.sequence)
                    .order_by(
                        AlertNotificationRow.created_at,
                        AlertNotificationRow.sequence,
                    )
                    .limit(overflow)
                )
            )
            session.execute(
                delete(AlertNotificationRow).where(AlertNotificationRow.sequence.in_(sequences))
            )
            return len(sequences)

        return self.run_transaction(operation)

    @staticmethod
    def _notification_row(
        session: Session,
        notification_id: str,
    ) -> AlertNotificationRow | None:
        return session.scalar(
            select(AlertNotificationRow).where(AlertNotificationRow.id == notification_id)
        )


class AuditEventSequence(MutableSequence[AuditEvent]):
    """List-compatible, oldest-first audit view backed by SQL."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_audit()

    def __eq__(self, other: object) -> bool:
        return _model_values_equal(list(self), other, AuditEvent)

    @overload
    def __getitem__(self, index: int) -> AuditEvent: ...

    @overload
    def __getitem__(self, index: slice) -> list[AuditEvent]: ...

    def __getitem__(self, index: Index) -> AuditEvent | list[AuditEvent]:
        if isinstance(index, slice):
            return self._repository.list_audit(newest_first=False)[index]
        return self._repository.get_audit_at(index)

    def __setitem__(self, index: Index, value: AuditEvent | Iterable[AuditEvent]) -> None:
        if isinstance(index, slice):
            raise TypeError("audit slice assignment is not supported")
        if not isinstance(value, AuditEvent):
            raise TypeError("audit sequence values must be AuditEvent instances")
        self._repository.replace_audit_at(index, value)

    def __delitem__(self, index: Index) -> None:
        self._repository.delete_audit_slice(index)

    def __iter__(self) -> Iterator[AuditEvent]:
        return iter(self._repository.list_audit(newest_first=False))

    def __reversed__(self) -> Iterator[AuditEvent]:
        return iter(self._repository.list_audit(newest_first=True))

    def insert(self, index: int, value: AuditEvent) -> None:
        if index != len(self):
            raise IndexError("audit events are append-only")
        self._repository.append_audit(value)

    def append(self, value: AuditEvent) -> None:
        self._repository.append_audit(value)

    def extend(self, values: Iterable[AuditEvent]) -> None:
        self._repository.extend_audit(values)

    def clear(self) -> None:
        self._repository.clear_audit()


class UsageRecordSequence(MutableSequence[UsageRecord]):
    """List-compatible, oldest-first usage view backed by SQL."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_usage()

    def __eq__(self, other: object) -> bool:
        return _model_values_equal(list(self), other, UsageRecord)

    @overload
    def __getitem__(self, index: int) -> UsageRecord: ...

    @overload
    def __getitem__(self, index: slice) -> list[UsageRecord]: ...

    def __getitem__(self, index: Index) -> UsageRecord | list[UsageRecord]:
        if isinstance(index, slice):
            return self._repository.list_usage(newest_first=False)[index]
        return self._repository.get_usage_at(index)

    def __setitem__(self, index: Index, value: UsageRecord | Iterable[UsageRecord]) -> None:
        if isinstance(index, slice):
            raise TypeError("usage slice assignment is not supported")
        if not isinstance(value, UsageRecord):
            raise TypeError("usage sequence values must be UsageRecord instances")
        self._repository.replace_usage_at(index, value)

    def __delitem__(self, index: Index) -> None:
        self._repository.delete_usage_slice(index)

    def __iter__(self) -> Iterator[UsageRecord]:
        return iter(self._repository.list_usage(newest_first=False))

    def __reversed__(self) -> Iterator[UsageRecord]:
        return iter(self._repository.list_usage(newest_first=True))

    def insert(self, index: int, value: UsageRecord) -> None:
        if index != len(self):
            raise IndexError("usage records are append-only")
        self._repository.append_usage_unbounded(value)

    def append(self, value: UsageRecord) -> None:
        self._repository.append_usage_unbounded(value)

    def extend(self, values: Iterable[UsageRecord]) -> None:
        self._repository.extend_usage(values)

    def clear(self) -> None:
        self._repository.clear_usage()


class AuditOutboxSequence(MutableSequence[dict[str, Any]]):
    """List-compatible view over pending, oldest-first audit outbox payloads."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_pending_outbox()

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Sequence) and list(self) == list(other)

    @overload
    def __getitem__(self, index: int) -> dict[str, Any]: ...

    @overload
    def __getitem__(self, index: slice) -> list[dict[str, Any]]: ...

    def __getitem__(self, index: Index) -> dict[str, Any] | list[dict[str, Any]]:
        if isinstance(index, slice):
            payloads = [deepcopy(row.payload) for row in self._repository.pending_outbox()]
            return payloads[index]
        return self._repository.get_outbox_payload_at(index)

    def __setitem__(
        self,
        index: Index,
        value: Mapping[str, Any] | Iterable[Mapping[str, Any]],
    ) -> None:
        if isinstance(index, slice):
            raise TypeError("outbox slice assignment is not supported")
        if not isinstance(value, Mapping):
            raise TypeError("outbox values must be mappings")
        self._repository.replace_outbox_payload_at(index, value)

    def __delitem__(self, index: Index) -> None:
        self._repository.delete_outbox_slice(index)

    def __iter__(self) -> Iterator[dict[str, Any]]:
        return iter([deepcopy(row.payload) for row in self._repository.pending_outbox()])

    def __reversed__(self) -> Iterator[dict[str, Any]]:
        payloads = [deepcopy(row.payload) for row in self._repository.pending_outbox()]
        return reversed(payloads)

    def insert(self, index: int, value: dict[str, Any]) -> None:
        if index != len(self):
            raise IndexError("audit outbox is append-only")
        self._repository.append_outbox_payload(value)

    def append(self, value: dict[str, Any]) -> None:
        self._repository.append_outbox_payload(value)

    def extend(self, values: Iterable[dict[str, Any]]) -> None:
        self._repository.extend_outbox_payloads(values)

    def clear(self) -> None:
        self._repository.clear_outbox()


class AlertNotificationMapping(MutableMapping[str, AlertNotification]):
    """Dict-compatible notification view returning detached model copies."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_alert_notifications()

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Mapping):
            return False
        values = {key: value.model_dump(mode="python") for key, value in self.items()}
        other_values: dict[object, Any] = {}
        for key, value in other.items():
            if not isinstance(value, AlertNotification):
                return False
            other_values[key] = value.model_dump(mode="python")
        return values == other_values

    def __getitem__(self, key: str) -> AlertNotification:
        notification = self._repository.get_alert_notification(key)
        if notification is None:
            raise KeyError(key)
        return notification

    def __setitem__(self, key: str, value: AlertNotification) -> None:
        if key != value.id:
            raise ValueError("notification mapping key must match notification.id")
        self._repository.upsert_alert_notification(value)

    def __delitem__(self, key: str) -> None:
        if not self._repository.delete_alert_notification(key):
            raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        notifications = self._repository.list_alert_notifications_in_insertion_order()
        return iter(notification.id for notification in notifications)

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and self._repository.get_alert_notification(key) is not None

    def values(self) -> list[AlertNotification]:  # type: ignore[override]
        return self._repository.list_alert_notifications_in_insertion_order()

    def items(self) -> list[tuple[str, AlertNotification]]:  # type: ignore[override]
        notifications = self._repository.list_alert_notifications_in_insertion_order()
        return [(notification.id, notification) for notification in notifications]

    def clear(self) -> None:
        self._repository.clear_alert_notifications()


def _model_mapping_equal(
    values: Mapping[str, Any],
    other: object,
    model_type: type[Any],
) -> bool:
    if not isinstance(other, Mapping):
        return False
    other_values: dict[object, Any] = {}
    for key, value in other.items():
        if not isinstance(value, model_type):
            return False
        other_values[key] = value.model_dump(mode="python")
    return {key: value.model_dump(mode="python") for key, value in values.items()} == other_values


class ChatThreadMapping(MutableMapping[str, ChatThread]):
    """Dict-compatible thread view returning frozen detached models."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_chat_threads()

    def __eq__(self, other: object) -> bool:
        return _model_mapping_equal(dict(self.items()), other, ChatThread)

    def __getitem__(self, key: str) -> ChatThread:
        thread = self._repository.get_chat_thread(key)
        if thread is None:
            raise KeyError(key)
        return thread

    def __setitem__(self, key: str, value: ChatThread) -> None:
        if key != value.id:
            raise ValueError("thread mapping key must match thread.id")
        self._repository.upsert_chat_thread(value)

    def __delitem__(self, key: str) -> None:
        if self._repository.delete_chat_thread(key) is None:
            raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        return iter(thread.id for thread in self._repository.list_chat_threads(newest_first=False))

    def values(self) -> list[ChatThread]:  # type: ignore[override]
        return self._repository.list_chat_threads(newest_first=False)

    def items(self) -> list[tuple[str, ChatThread]]:  # type: ignore[override]
        threads = self._repository.list_chat_threads(newest_first=False)
        return [(thread.id, thread) for thread in threads]


class ChatFolderMapping(MutableMapping[str, ChatFolder]):
    """Dict-compatible folder view returning frozen detached models."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_chat_folders()

    def __eq__(self, other: object) -> bool:
        return _model_mapping_equal(dict(self.items()), other, ChatFolder)

    def __getitem__(self, key: str) -> ChatFolder:
        folder = self._repository.get_chat_folder(key)
        if folder is None:
            raise KeyError(key)
        return folder

    def __setitem__(self, key: str, value: ChatFolder) -> None:
        if key != value.id:
            raise ValueError("folder mapping key must match folder.id")
        self._repository.upsert_chat_folder(value)

    def __delitem__(self, key: str) -> None:
        folder, _cleared = self._repository.delete_chat_folder(key)
        if folder is None:
            raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        return iter(folder.id for folder in self._repository.list_chat_folders(newest_first=False))

    def values(self) -> list[ChatFolder]:  # type: ignore[override]
        return self._repository.list_chat_folders(newest_first=False)

    def items(self) -> list[tuple[str, ChatFolder]]:  # type: ignore[override]
        folders = self._repository.list_chat_folders(newest_first=False)
        return [(folder.id, folder) for folder in folders]


class ChatSessionProjection(Mapping[str, ChatSession]):
    """Read-only compatibility projection derived solely from chat threads."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_chat_threads()

    def __eq__(self, other: object) -> bool:
        return _model_mapping_equal(dict(self.items()), other, ChatSession)

    def __getitem__(self, key: str) -> ChatSession:
        thread = self._repository.get_chat_thread(key)
        if thread is None:
            raise KeyError(key)
        return _chat_session_from_thread(thread)

    def __iter__(self) -> Iterator[str]:
        return iter(thread.id for thread in self._repository.list_chat_threads(newest_first=False))

    def values(self) -> list[ChatSession]:  # type: ignore[override]
        return [
            _chat_session_from_thread(thread)
            for thread in self._repository.list_chat_threads(newest_first=False)
        ]

    def items(self) -> list[tuple[str, ChatSession]]:  # type: ignore[override]
        return [(session.id, session) for session in self.values()]


class ChatAttachmentMapping(MutableMapping[str, ChatAttachment]):
    """Dict-compatible attachment metadata view backed by SQL."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_chat_attachments()

    def __eq__(self, other: object) -> bool:
        return _model_mapping_equal(dict(self.items()), other, ChatAttachment)

    def __getitem__(self, key: str) -> ChatAttachment:
        attachment = self._repository.get_chat_attachment(key)
        if attachment is None:
            raise KeyError(key)
        return attachment

    def __setitem__(self, key: str, value: ChatAttachment) -> None:
        if value.id is None:
            value = value.model_copy(update={"id": key})
        elif key != value.id:
            raise ValueError("attachment mapping key must match attachment.id")
        self._repository.upsert_chat_attachment(value)

    def __delitem__(self, key: str) -> None:
        if self._repository.delete_chat_attachment(key) is None:
            raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        return iter(attachment.id for attachment in self._repository.list_chat_attachments())

    def values(self) -> list[ChatAttachment]:  # type: ignore[override]
        return self._repository.list_chat_attachments()

    def items(self) -> list[tuple[str, ChatAttachment]]:  # type: ignore[override]
        return [
            (attachment.id, attachment)
            for attachment in self._repository.list_chat_attachments()
            if attachment.id is not None
        ]


class UserApiKeyMapping(MutableMapping[str, UserApiKeyRecord]):
    """User-id keyed API-key metadata view; bearer secrets never enter SQL."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return self._repository.count_user_api_keys()

    def __eq__(self, other: object) -> bool:
        return _model_mapping_equal(dict(self.items()), other, UserApiKeyRecord)

    def __getitem__(self, key: str) -> UserApiKeyRecord:
        record = self._repository.get_user_api_key(key)
        if record is None:
            raise KeyError(key)
        return record

    def __setitem__(self, key: str, value: UserApiKeyRecord) -> None:
        if key != value.user_id:
            raise ValueError("API-key mapping key must match record.user_id")
        self._repository.upsert_user_api_key(value)

    def __delitem__(self, key: str) -> None:
        if self._repository.delete_user_api_key(key) is None:
            raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        return iter(record.user_id for record in self._repository.list_user_api_keys())

    def values(self) -> list[UserApiKeyRecord]:  # type: ignore[override]
        return self._repository.list_user_api_keys()

    def items(self) -> list[tuple[str, UserApiKeyRecord]]:  # type: ignore[override]
        records = self._repository.list_user_api_keys()
        return [(record.user_id, record) for record in records]


class SessionIssuedBeforeMsMapping(Mapping[str, int]):
    """Read-only retained session-watermark view keyed by user id."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self._repository = repository

    def __len__(self) -> int:
        return len(self._repository.list_session_issued_before_ms())

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Mapping) and dict(self.items()) == dict(other.items())

    def __getitem__(self, key: str) -> int:
        issued_before_ms = self._repository.get_session_issued_before_ms(key)
        if issued_before_ms is None:
            raise KeyError(key)
        return issued_before_ms

    def __iter__(self) -> Iterator[str]:
        return iter(self._repository.list_session_issued_before_ms())

    def items(self) -> list[tuple[str, int]]:  # type: ignore[override]
        return list(self._repository.list_session_issued_before_ms().items())


__all__ = [
    "AlertNotificationMapping",
    "ApplicationStateRepository",
    "AuditEventSequence",
    "AuditOutboxSequence",
    "ChatAttachmentMapping",
    "ChatFolderMapping",
    "ChatSessionProjection",
    "ChatThreadMapping",
    "SessionIssuedBeforeMsMapping",
    "SessionFamilyConflictError",
    "SessionFamilyNotCurrentError",
    "SessionRevocationConflictError",
    "UsageRecordSequence",
    "UserApiKeyMapping",
]
