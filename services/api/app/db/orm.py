from __future__ import annotations

import json
import math
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

from app.core.audit_severity import classify_audit_event
from app.models.matters import (
    DraftDocument,
    DraftRevision,
    Matter,
    MatterDeletionJob,
    MatterMembership,
)
from app.models.schemas import (
    PrincipalDailyUsage,
    PrincipalUsageBudget,
    AlertNotification,
    AuditEvent,
    ChatAttachment,
    ChatActivityTraceStep,
    ChatCitation,
    ChatFolder,
    ChatMessage,
    ChatThread,
    ChatThreadTag,
    RetentionHold,
    TenantDailyUsage,
    TenantUsageBudget,
    TenantUsageCompletionEvent,
    TenantUsagePermit,
    UsageRecord,
    UserApiKeyRecord,
)


NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_name)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class UTCDateTime(TypeDecorator[datetime]):
    """Store timezone-aware UTC values consistently on SQLite and Postgres."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        del dialect
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        del dialect
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


def _validate_json_value(value: Any) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JSON numbers must be finite.")
        return
    if isinstance(value, list):
        for item in value:
            _validate_json_value(item)
        return
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("JSON object keys must be strings.")
        for item in value.values():
            _validate_json_value(item)
        return
    raise ValueError("Value contains data that cannot be represented as strict JSON.")


def _reject_unknown_model_fields(
    value: Any,
    model_type: type[ChatMessage | ChatAttachment | ChatCitation | ChatActivityTraceStep],
) -> None:
    if not isinstance(value, dict):
        return
    unknown = set(value).difference(model_type.model_fields)
    if unknown:
        raise ValueError(f"Chat message data contains unknown {model_type.__name__} fields.")


def _canonical_chat_messages(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError("Expected a JSON array containing only chat-message objects.")
    _validate_json_value(value)

    canonical: list[dict[str, Any]] = []
    for item in value:
        _reject_unknown_model_fields(item, ChatMessage)
        attachments = item.get("attachments")
        if isinstance(attachments, list):
            for attachment in attachments:
                _reject_unknown_model_fields(attachment, ChatAttachment)
        citations = item.get("citations")
        if isinstance(citations, list):
            for citation in citations:
                _reject_unknown_model_fields(citation, ChatCitation)
        trace = item.get("activityTrace")
        if isinstance(trace, list):
            for step in trace:
                _reject_unknown_model_fields(step, ChatActivityTraceStep)
        try:
            message = ChatMessage.model_validate(item, strict=True)
        except (TypeError, ValueError) as exc:
            raise ValueError("Stored chat message does not match the ChatMessage schema.") from exc
        canonical.append(message.model_dump(mode="json"))

    # Round-trip once to guarantee that pydantic output remains standard JSON
    # and to return a detached value that callers cannot mutate by alias.
    return json.loads(json.dumps(canonical, allow_nan=False))


class StrictChatMessagesJSON(TypeDecorator[list[dict[str, Any]]]):
    """Persist a canonical JSON array of strict ChatMessage objects.

    The database JSON types guarantee syntactically valid JSON but do not
    guarantee the shape used by chat messages. This decorator keeps the
    contract dialect-neutral while rejecting top-level objects, scalar list
    members, non-string object keys, and non-finite numbers at the ORM edge.
    """

    impl = JSON
    cache_ok = True

    @staticmethod
    def _validated(value: Any) -> list[dict[str, Any]]:
        return _canonical_chat_messages(value)

    def process_bind_param(
        self,
        value: list[dict[str, Any]] | None,
        dialect: Dialect,
    ) -> list[dict[str, Any]] | None:
        del dialect
        if value is None:
            return None
        return self._validated(value)

    def process_result_value(
        self,
        value: Any,
        dialect: Dialect,
    ) -> list[dict[str, Any]] | None:
        del dialect
        if value is None:
            return None
        return self._validated(value)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class AuditEventRow(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        UniqueConstraint("id", name="uq_audit_events_id"),
        Index("ix_audit_events_tenant_sequence", "tenant_id", "sequence"),
        Index("ix_audit_events_created_at_sequence", "created_at", "sequence"),
        Index(
            "ix_audit_events_tenant_created_at_sequence",
            "tenant_id",
            "created_at",
            "sequence",
        ),
        Index("ix_audit_events_actor_created_at", "actor_id", "created_at"),
        Index("ix_audit_events_action_created_at", "action", "created_at"),
        {"sqlite_autoincrement": True},
    )

    # Existing APIs are append-ordered, independent of created_at. Keep an
    # internal sequence so identical/out-of-order timestamps retain that order.
    sequence: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    actor_id: Mapped[str] = mapped_column(String(255), nullable=False)
    actor_name: Mapped[str] = mapped_column(Text, nullable=False)
    actor_role: Mapped[str] = mapped_column(String(100), nullable=False)
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    action_type: Mapped[str] = mapped_column(String(255), nullable=False)
    target: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str] = mapped_column(String(255), nullable=False)
    target_name: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    redacted: Mapped[bool] = mapped_column(Boolean, nullable=False)
    event_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata",
        JSON(none_as_null=True),
        nullable=False,
    )

    @classmethod
    def from_model(cls, event: AuditEvent) -> AuditEventRow:
        serialized_metadata = event.model_dump(mode="json", include={"metadata"})["metadata"]
        return cls(
            id=event.id,
            tenant_id=event.tenant_id,
            actor_id=event.actor_id,
            actor_name=event.actor_name,
            actor_role=event.actor_role,
            action=event.action,
            action_type=event.action_type,
            target=event.target,
            target_type=event.target_type,
            target_name=event.target_name,
            detail=event.detail,
            created_at=event.created_at,
            redacted=event.redacted,
            event_metadata=serialized_metadata,
        )

    def to_model(self) -> AuditEvent:
        return AuditEvent(
            id=self.id,
            tenant_id=self.tenant_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            actor_role=self.actor_role,
            action=self.action,
            action_type=self.action_type,
            target=self.target,
            target_type=self.target_type,
            target_name=self.target_name,
            detail=self.detail,
            created_at=self.created_at,
            redacted=self.redacted,
            metadata=dict(self.event_metadata),
        )


class UsageRecordRow(Base):
    __tablename__ = "usage_records"
    __table_args__ = (
        UniqueConstraint("id", name="uq_usage_records_id"),
        CheckConstraint("message_count >= 1", name="message_count_positive"),
        CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens >= 0",
            name="prompt_tokens_nonnegative",
        ),
        CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens >= 0",
            name="completion_tokens_nonnegative",
        ),
        CheckConstraint(
            "total_tokens IS NULL OR total_tokens >= 0",
            name="total_tokens_nonnegative",
        ),
        Index("ix_usage_records_tenant_sequence", "tenant_id", "sequence"),
        Index("ix_usage_records_user_sequence", "user_id", "sequence"),
        Index("ix_usage_records_created_at_sequence", "created_at", "sequence"),
        Index(
            "ix_usage_records_tenant_created_at_sequence",
            "tenant_id",
            "created_at",
            "sequence",
        ),
        Index(
            "ix_usage_records_user_created_at_sequence",
            "user_id",
            "created_at",
            "sequence",
        ),
        {"sqlite_autoincrement": True},
    )

    sequence: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    user_name: Mapped[str] = mapped_column(Text, nullable=False)
    user_role: Mapped[str] = mapped_column(String(100), nullable=False)
    model_id: Mapped[str] = mapped_column(Text, nullable=False)
    provider_name: Mapped[str] = mapped_column(Text, nullable=False)
    surface: Mapped[str] = mapped_column(String(100), nullable=False)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False)
    prompt_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    thread_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    @classmethod
    def from_model(cls, record: UsageRecord) -> UsageRecordRow:
        return cls(
            id=record.id,
            tenant_id=record.tenant_id,
            user_id=record.user_id,
            user_name=record.user_name,
            user_role=record.user_role,
            model_id=record.model_id,
            provider_name=record.provider_name,
            surface=record.surface,
            message_count=record.message_count,
            prompt_tokens=record.prompt_tokens,
            completion_tokens=record.completion_tokens,
            total_tokens=record.total_tokens,
            thread_id=record.thread_id,
            source=record.source,
            created_at=record.created_at,
        )

    def to_model(self) -> UsageRecord:
        return UsageRecord(
            id=self.id,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            user_name=self.user_name,
            user_role=self.user_role,
            model_id=self.model_id,
            provider_name=self.provider_name,
            surface=self.surface,
            message_count=self.message_count,
            prompt_tokens=self.prompt_tokens,
            completion_tokens=self.completion_tokens,
            total_tokens=self.total_tokens,
            thread_id=self.thread_id,
            source=self.source,
            created_at=self.created_at,
        )


class TenantUsageBudgetRow(Base):
    """Explicit tenant budget; absence is an unavailable configuration."""

    __tablename__ = "tenant_usage_budgets"
    __table_args__ = (
        CheckConstraint("budget_unit IN ('tokens', 'usd')", name="budget_unit_valid"),
        CheckConstraint(
            "budget_period IN ('day', 'week', 'month')",
            name="budget_period_valid",
        ),
        CheckConstraint("daily_token_limit >= 0", name="daily_token_limit_nonnegative"),
        CheckConstraint(
            "daily_token_limit <= 9223372036854775807",
            name="daily_token_limit_bigint_max",
        ),
        CheckConstraint("spend_limit_nanos >= 0", name="spend_limit_nanos_nonnegative"),
        CheckConstraint(
            "spend_limit_nanos <= 9223372036854775807",
            name="spend_limit_nanos_bigint_max",
        ),
    )

    tenant_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    budget_unit: Mapped[str] = mapped_column(String(16), nullable=False, default="tokens")
    budget_period: Mapped[str] = mapped_column(String(16), nullable=False, default="day")
    daily_token_limit: Mapped[int] = mapped_column(BigInteger, nullable=False)
    spend_limit_nanos: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    def to_model(self) -> TenantUsageBudget:
        return TenantUsageBudget(
            tenant_id=self.tenant_id,
            budget_unit=self.budget_unit,  # type: ignore[arg-type]
            budget_period=self.budget_period,  # type: ignore[arg-type]
            daily_token_limit=self.daily_token_limit,
            spend_limit_nanos=self.spend_limit_nanos,
            updated_at=self.updated_at,
            updated_by=self.updated_by,
        )


class TenantDailyUsageRow(Base):
    """Authoritative tenant/date counters used by admission checks."""

    __tablename__ = "tenant_daily_usage"
    __table_args__ = (
        CheckConstraint("reported_tokens >= 0", name="reported_tokens_nonnegative"),
        CheckConstraint(
            "reported_tokens <= 9223372036854775807",
            name="reported_tokens_bigint_max",
        ),
        CheckConstraint(
            "reported_tokens_overflowed = false OR reported_tokens = 9223372036854775807",
            name="reported_overflow_consistent",
        ),
        CheckConstraint(
            "reported_cost_nanos >= 0",
            name="reported_cost_nanos_nonnegative",
        ),
        CheckConstraint(
            "reported_cost_nanos <= 9223372036854775807",
            name="reported_cost_nanos_bigint_max",
        ),
        CheckConstraint(
            "reported_cost_overflowed = false OR reported_cost_nanos = 9223372036854775807",
            name="reported_cost_overflow_consistent",
        ),
        CheckConstraint(
            "metered_completions >= 0",
            name="metered_completions_nonnegative",
        ),
        CheckConstraint(
            "metered_completions <= 9223372036854775807",
            name="metered_completions_bigint_max",
        ),
        CheckConstraint(
            "unmetered_completions >= 0",
            name="unmetered_completions_nonnegative",
        ),
        CheckConstraint(
            "unmetered_completions <= 9223372036854775807",
            name="unmetered_completions_bigint_max",
        ),
        CheckConstraint(
            "cost_metered_completions >= 0",
            name="cost_metered_completions_nonnegative",
        ),
        CheckConstraint(
            "cost_metered_completions <= 9223372036854775807",
            name="cost_metered_completions_bigint_max",
        ),
        CheckConstraint(
            "cost_unmetered_completions >= 0",
            name="cost_unmetered_completions_nonnegative",
        ),
        CheckConstraint(
            "cost_unmetered_completions <= 9223372036854775807",
            name="cost_unmetered_completions_bigint_max",
        ),
        Index("ix_tenant_daily_usage_date_tenant", "usage_date", "tenant_id"),
    )

    tenant_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    usage_date: Mapped[date] = mapped_column(Date, primary_key=True)
    reported_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reported_tokens_overflowed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    reported_cost_nanos: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    reported_cost_overflowed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    metered_completions: Mapped[int] = mapped_column(BigInteger, nullable=False)
    unmetered_completions: Mapped[int] = mapped_column(BigInteger, nullable=False)
    cost_metered_completions: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    cost_unmetered_completions: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    def to_model(self) -> TenantDailyUsage:
        return TenantDailyUsage(
            tenant_id=self.tenant_id,
            usage_date=self.usage_date,
            reported_tokens=self.reported_tokens,
            reported_tokens_overflowed=self.reported_tokens_overflowed,
            reported_cost_nanos=self.reported_cost_nanos,
            reported_cost_overflowed=self.reported_cost_overflowed,
            metered_completions=self.metered_completions,
            unmetered_completions=self.unmetered_completions,
            cost_metered_completions=self.cost_metered_completions,
            cost_unmetered_completions=self.cost_unmetered_completions,
            updated_at=self.updated_at,
        )


class PrincipalUsageBudgetRow(Base):
    """Per-user/per-group daily allocation inside the tenant ceiling."""

    __tablename__ = "principal_usage_budgets"
    __table_args__ = (
        CheckConstraint(
            "principal_type IN ('user', 'group')",
            name="principal_budget_type_valid",
        ),
        CheckConstraint(
            "budget_period IN ('day', 'week', 'month')",
            name="principal_budget_period_valid",
        ),
        CheckConstraint(
            "daily_token_limit >= 0",
            name="principal_daily_token_limit_nonnegative",
        ),
        CheckConstraint(
            "daily_token_limit <= 9223372036854775807",
            name="principal_daily_token_limit_bigint_max",
        ),
    )

    tenant_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    principal_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    principal_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    budget_period: Mapped[str] = mapped_column(String(16), nullable=False, default="day")
    daily_token_limit: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    def to_model(self) -> PrincipalUsageBudget:
        return PrincipalUsageBudget(
            tenant_id=self.tenant_id,
            principal_type=self.principal_type,  # type: ignore[arg-type]
            principal_id=self.principal_id,
            budget_period=self.budget_period,  # type: ignore[arg-type]
            daily_token_limit=self.daily_token_limit,
            updated_at=self.updated_at,
            updated_by=self.updated_by,
        )


class PrincipalDailyUsageRow(Base):
    """Per-principal/date counters used by allocation admission checks."""

    __tablename__ = "principal_daily_usage"
    __table_args__ = (
        CheckConstraint(
            "principal_type IN ('user', 'group')",
            name="principal_usage_type_valid",
        ),
        CheckConstraint(
            "reported_tokens >= 0",
            name="principal_reported_tokens_nonnegative",
        ),
        CheckConstraint(
            "reported_tokens <= 9223372036854775807",
            name="principal_reported_tokens_bigint_max",
        ),
        CheckConstraint(
            "metered_completions >= 0",
            name="principal_metered_completions_nonnegative",
        ),
        CheckConstraint(
            "unmetered_completions >= 0",
            name="principal_unmetered_completions_nonnegative",
        ),
        Index(
            "ix_principal_daily_usage_date_tenant",
            "usage_date",
            "tenant_id",
        ),
    )

    tenant_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    principal_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    principal_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    usage_date: Mapped[date] = mapped_column(Date, primary_key=True)
    reported_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reported_tokens_overflowed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    metered_completions: Mapped[int] = mapped_column(BigInteger, nullable=False)
    unmetered_completions: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    def to_model(self) -> PrincipalDailyUsage:
        return PrincipalDailyUsage(
            tenant_id=self.tenant_id,
            principal_type=self.principal_type,  # type: ignore[arg-type]
            principal_id=self.principal_id,
            usage_date=self.usage_date,
            reported_tokens=self.reported_tokens,
            reported_tokens_overflowed=self.reported_tokens_overflowed,
            metered_completions=self.metered_completions,
            unmetered_completions=self.unmetered_completions,
            updated_at=self.updated_at,
        )


class TenantUsagePermitRow(Base):
    """Privacy-minimal, reservation-free request admission ledger."""

    __tablename__ = "tenant_usage_permits"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "request_id_hash",
            name="uq_tenant_usage_permits_tenant_request_id_hash",
        ),
        CheckConstraint(
            "length(request_id_hash) = 64",
            name="request_id_hash_sha256_length",
        ),
        CheckConstraint(
            "status IN ('started', 'completed', 'failed', 'abandoned')",
            name="status_valid",
        ),
        CheckConstraint(
            "(status = 'started' AND closed_at IS NULL) OR "
            "(status = 'completed' AND closed_at IS NOT NULL) OR "
            "(status IN ('failed', 'abandoned') AND closed_at IS NOT NULL)",
            name="lifecycle_consistent",
        ),
        CheckConstraint(
            "closed_at IS NULL OR closed_at >= acquired_at",
            name="closed_after_acquire",
        ),
        Index(
            "ix_tenant_usage_permits_tenant_admission_status_acquired",
            "tenant_id",
            "admission_date",
            "status",
            "acquired_at",
        ),
        Index("ix_tenant_usage_permits_status_acquired", "status", "acquired_at"),
    )

    permit_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    request_id_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    admission_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    acquired_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    def to_model(self) -> TenantUsagePermit:
        return TenantUsagePermit(
            permit_id=self.permit_id,
            request_id_hash=self.request_id_hash,
            tenant_id=self.tenant_id,
            admission_date=self.admission_date,
            status=self.status,  # type: ignore[arg-type]
            acquired_at=self.acquired_at,
            closed_at=self.closed_at,
        )


class TenantUsageCompletionEventRow(Base):
    """One provider success, linked to exactly one detailed UsageRecord."""

    __tablename__ = "tenant_usage_completion_events"
    __table_args__ = (
        UniqueConstraint(
            "usage_record_id",
            name="uq_tenant_usage_completion_events_usage_record_id",
        ),
        CheckConstraint(
            "length(completion_id_hash) = 64",
            name="completion_id_hash_sha256_length",
        ),
        CheckConstraint(
            "length(usage_record_binding_hash) = 64",
            name="usage_record_binding_hash_sha256_length",
        ),
        CheckConstraint(
            "metering_status IN ('reported', 'unmetered')",
            name="metering_status_valid",
        ),
        CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens >= 0",
            name="prompt_tokens_nonnegative",
        ),
        CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens <= 9223372036854775807",
            name="prompt_tokens_bigint_max",
        ),
        CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens >= 0",
            name="completion_tokens_nonnegative",
        ),
        CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens <= 9223372036854775807",
            name="completion_tokens_bigint_max",
        ),
        CheckConstraint(
            "total_tokens IS NULL OR total_tokens >= 0",
            name="total_tokens_nonnegative",
        ),
        CheckConstraint(
            "total_tokens IS NULL OR total_tokens <= 9223372036854775807",
            name="total_tokens_bigint_max",
        ),
        CheckConstraint(
            "reported_cost_nanos IS NULL OR reported_cost_nanos >= 0",
            name="reported_cost_nanos_nonnegative",
        ),
        CheckConstraint(
            "reported_cost_nanos IS NULL OR reported_cost_nanos <= 9223372036854775807",
            name="reported_cost_nanos_bigint_max",
        ),
        CheckConstraint(
            "(metering_status = 'reported' AND total_tokens IS NOT NULL) OR "
            "(metering_status = 'unmetered' AND total_tokens IS NULL)",
            name="metering_total_consistent",
        ),
        CheckConstraint(
            "total_tokens IS NULL OR prompt_tokens IS NULL OR "
            "completion_tokens IS NULL OR "
            "total_tokens = prompt_tokens + completion_tokens",
            name="token_totals_consistent",
        ),
        Index(
            "ix_tenant_usage_completion_events_date_permit",
            "completion_date",
            "permit_id",
        ),
        Index(
            "ix_tenant_usage_completion_events_completed_at",
            "completed_at",
        ),
    )

    permit_id: Mapped[str] = mapped_column(
        ForeignKey("tenant_usage_permits.permit_id", ondelete="CASCADE"),
        nullable=False,
    )
    completion_id_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    usage_record_id: Mapped[str] = mapped_column(String(255), nullable=False)
    usage_record_binding_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    completion_date: Mapped[date] = mapped_column(Date, nullable=False)
    completed_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    metering_status: Mapped[str] = mapped_column(String(32), nullable=False)
    prompt_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    reported_cost_nanos: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    def to_model(self) -> TenantUsageCompletionEvent:
        return TenantUsageCompletionEvent(
            permit_id=self.permit_id,
            completion_id_hash=self.completion_id_hash,
            usage_record_id=self.usage_record_id,
            usage_record_binding_hash=self.usage_record_binding_hash,
            completion_date=self.completion_date,
            completed_at=self.completed_at,
            metering_status=self.metering_status,  # type: ignore[arg-type]
            prompt_tokens=self.prompt_tokens,
            completion_tokens=self.completion_tokens,
            total_tokens=self.total_tokens,
            reported_cost_nanos=self.reported_cost_nanos,
        )


class RevokedSessionRow(Base):
    __tablename__ = "revoked_sessions"
    __table_args__ = (
        CheckConstraint("expires_at >= issued_at", name="expiry_after_issue"),
        Index("ix_revoked_sessions_expires_at", "expires_at"),
        Index("ix_revoked_sessions_user_expires_at", "user_id", "expires_at"),
        Index("ix_revoked_sessions_tenant_revoked_at", "tenant_id", "revoked_at"),
    )

    sid: Mapped[str] = mapped_column(String(128), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    issued_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    revoked_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    reason: Mapped[str] = mapped_column(String(255), nullable=False)


class AuditOutboxRow(Base):
    """Durable, ordered Elastic-delivery queue for audit side effects."""

    __tablename__ = "audit_outbox"
    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_audit_outbox_dedupe_key"),
        Index("ix_audit_outbox_delivered_sequence", "delivered_at", "sequence"),
        Index(
            "ix_audit_outbox_tenant_delivered_sequence",
            "tenant_id",
            "delivered_at",
            "sequence",
        ),
        {"sqlite_autoincrement": True},
    )

    sequence: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    dedupe_key: Mapped[str] = mapped_column(String(320), nullable=False)
    event_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    @classmethod
    def from_audit_event(cls, event: AuditEvent) -> AuditOutboxRow:
        severity, _reason = classify_audit_event(event.action, event.metadata)
        payload = {
            "id": event.id,
            "event": event.action,
            "action_type": event.action_type,
            "target": event.target,
            "target_type": event.target_type,
            "target_name": event.target_name,
            "actor_id": event.actor_id,
            "actor_name": event.actor_name,
            "actor_role": event.actor_role,
            "tenant_id": event.tenant_id,
            "created_at": event.created_at.isoformat(),
            "detail": event.detail,
            "metadata": event.model_dump(mode="json", include={"metadata"})["metadata"],
            "severity": severity,
        }
        return cls(
            dedupe_key=f"audit:{event.id}",
            event_id=event.id,
            tenant_id=event.tenant_id,
            payload=payload,
        )


class RuntimeStateImportRow(Base):
    """Receipt for one completed, transactional runtime-state import."""

    __tablename__ = "runtime_state_imports"
    __table_args__ = (
        CheckConstraint("audit_count >= 0", name="audit_count_nonnegative"),
        CheckConstraint("usage_count >= 0", name="usage_count_nonnegative"),
        CheckConstraint("outbox_count >= 0", name="outbox_count_nonnegative"),
        CheckConstraint(
            "alert_notification_count >= 0",
            name="alert_notification_count_nonnegative",
        ),
        CheckConstraint("alert_runtime_count >= 0", name="alert_runtime_count_nonnegative"),
    )

    source_digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_version: Mapped[int] = mapped_column(Integer, nullable=False)
    # The default is deliberately client-side. Alembic upgrades must never
    # manufacture a successful import receipt.
    target_version: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    completed_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    audit_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    usage_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    outbox_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    alert_notification_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    alert_runtime_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class AlertRuleRuntimeRow(Base):
    """Mutable alert cooldown state, separate from rule configuration."""

    __tablename__ = "alert_rule_runtime"

    rule_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    last_triggered_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class AlertNotificationRow(Base):
    """Durable alert delivery queue and user-visible delivery history."""

    __tablename__ = "alert_notifications"
    __table_args__ = (
        UniqueConstraint("id", name="uq_alert_notifications_id"),
        CheckConstraint("scope IN ('platform', 'tenant')", name="scope_valid"),
        CheckConstraint(
            "event_severity IN ('info', 'warning', 'critical')",
            name="event_severity_valid",
        ),
        CheckConstraint(
            "status IN ('queued', 'sent', 'failed', 'not_configured', 'logged')",
            name="status_valid",
        ),
        CheckConstraint("matched_count >= 1", name="matched_count_positive"),
        CheckConstraint("attempts >= 0", name="attempts_nonnegative"),
        Index(
            "ix_alert_notifications_status_created_at_sequence",
            "status",
            "created_at",
            "sequence",
        ),
        Index(
            "ix_alert_notifications_tenant_created_at_sequence",
            "tenant_id",
            "created_at",
            "sequence",
        ),
        {"sqlite_autoincrement": True},
    )

    sequence: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    id: Mapped[str] = mapped_column(String(255), nullable=False)
    rule_id: Mapped[str] = mapped_column(String(255), nullable=False)
    rule_name: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[str] = mapped_column(String(32), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    event_id: Mapped[str] = mapped_column(String(255), nullable=False)
    event_action: Mapped[str] = mapped_column(Text, nullable=False)
    event_severity: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(255), nullable=False)
    actor_name: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    matched_count: Mapped[int] = mapped_column(Integer, nullable=False)
    recipients: Mapped[list[str]] = mapped_column(JSON(none_as_null=True), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    status_detail: Mapped[str] = mapped_column(Text, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    @classmethod
    def from_model(cls, notification: AlertNotification) -> AlertNotificationRow:
        return cls(
            id=notification.id,
            rule_id=notification.rule_id,
            rule_name=notification.rule_name,
            scope=notification.scope,
            tenant_id=notification.tenant_id,
            event_id=notification.event_id,
            event_action=notification.event_action,
            event_severity=notification.event_severity,
            actor_id=notification.actor_id,
            actor_name=notification.actor_name,
            summary=notification.summary,
            matched_count=notification.matched_count,
            recipients=list(notification.recipients),
            status=notification.status,
            status_detail=notification.status_detail,
            attempts=notification.attempts,
            archived=notification.archived,
            created_at=notification.created_at,
            delivered_at=notification.delivered_at,
        )

    def to_model(self) -> AlertNotification:
        return AlertNotification(
            id=self.id,
            rule_id=self.rule_id,
            rule_name=self.rule_name,
            scope=self.scope,
            tenant_id=self.tenant_id,
            event_id=self.event_id,
            event_action=self.event_action,
            event_severity=self.event_severity,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            summary=self.summary,
            matched_count=self.matched_count,
            recipients=list(self.recipients),
            status=self.status,
            status_detail=self.status_detail,
            attempts=self.attempts,
            archived=self.archived,
            created_at=self.created_at,
            delivered_at=self.delivered_at,
        )


class ChatThreadRow(Base):
    """Canonical chat thread; session summaries are derived from these rows."""

    __tablename__ = "chat_threads"
    __table_args__ = (
        UniqueConstraint("id", name="uq_chat_threads_id"),
        Index("ix_chat_threads_owner_sequence", "owner_user_id", "sequence"),
        Index(
            "ix_chat_threads_tenant_owner_sequence",
            "tenant_id",
            "owner_user_id",
            "sequence",
        ),
        Index(
            "ix_chat_threads_tenant_owner_archived_sequence",
            "tenant_id",
            "owner_user_id",
            "archived",
            "sequence",
        ),
        Index(
            "ix_chat_threads_tenant_owner_folder_sequence",
            "tenant_id",
            "owner_user_id",
            "folder_id",
            "sequence",
        ),
        Index(
            "ix_chat_threads_tenant_matter_owner_sequence",
            "tenant_id",
            "matter_id",
            "owner_user_id",
            "sequence",
        ),
        Index(
            "ix_chat_threads_tenant_last_activity",
            "tenant_id",
            "last_activity_at",
        ),
        {"sqlite_autoincrement": True},
    )

    sequence: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    model_id: Mapped[str] = mapped_column(Text, nullable=False)
    group_id: Mapped[str] = mapped_column(String(255), nullable=False)
    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False)
    folder_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    matter_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey(
            "matters.id",
            name="fk_chat_threads_matter_id_matters",
            ondelete="SET NULL",
        ),
        nullable=True,
    )
    used_agent: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # This is the existing public display label (for example "Just now"), not
    # an authoritative clock. Message ISO clock fields remain inside the
    # strictly validated messages document.
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)
    # Authoritative retention clocks and disposition state. Server-owned:
    # ``upsert_chat_thread`` preserves and stamps them, and they never appear
    # in the client-authored thread payload. Nullable only for rows written
    # before migration 0016; the migration backfills from message ISO clocks.
    created_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_activity_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # NULL = live; "pending" = marked by the retention sweep and inside the
    # grace window before archive/purge.
    disposition_state: Mapped[str | None] = mapped_column(String(16), nullable=True)
    disposition_pending_since: Mapped[datetime | None] = mapped_column(
        UTCDateTime(),
        nullable=True,
    )
    messages: Mapped[list[dict[str, Any]]] = mapped_column(
        StrictChatMessagesJSON(none_as_null=True),
        nullable=False,
    )

    @classmethod
    def from_model(cls, thread: ChatThread) -> ChatThreadRow:
        messages = _canonical_chat_messages(
            [message.model_dump(mode="python") for message in thread.messages]
        )
        return cls(
            id=thread.id,
            tenant_id=thread.tenant_id,
            owner_user_id=thread.owner_user_id,
            title=thread.title,
            model_id=thread.model_id,
            group_id=thread.group_id,
            pinned=thread.pinned,
            archived=thread.archived,
            folder_id=thread.folder_id,
            matter_id=thread.matter_id,
            used_agent=thread.used_agent,
            updated_at=thread.updated_at,
            messages=messages,
        )

    def to_model(self) -> ChatThread:
        return ChatThread.model_validate(
            {
                "id": self.id,
                "tenant_id": self.tenant_id,
                "owner_user_id": self.owner_user_id,
                "title": self.title,
                "model_id": self.model_id,
                "group_id": self.group_id,
                "pinned": self.pinned,
                "archived": self.archived,
                "folder_id": self.folder_id,
                "matter_id": self.matter_id,
                "used_agent": self.used_agent,
                "updated_at": self.updated_at,
                "messages": _canonical_chat_messages(self.messages),
            }
        )


class ChatFolderRow(Base):
    __tablename__ = "chat_folders"
    __table_args__ = (
        UniqueConstraint("id", name="uq_chat_folders_id"),
        Index("ix_chat_folders_owner_sequence", "owner_user_id", "sequence"),
        Index(
            "ix_chat_folders_tenant_owner_sequence",
            "tenant_id",
            "owner_user_id",
            "sequence",
        ),
        Index(
            "ix_chat_folders_tenant_matter_owner_sequence",
            "tenant_id",
            "matter_id",
            "owner_user_id",
            "sequence",
        ),
        {"sqlite_autoincrement": True},
    )

    sequence: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    matter_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey(
            "matters.id",
            name="fk_chat_folders_matter_id_matters",
            ondelete="SET NULL",
        ),
        nullable=True,
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)

    @classmethod
    def from_model(cls, folder: ChatFolder) -> ChatFolderRow:
        return cls(
            id=folder.id,
            tenant_id=folder.tenant_id,
            owner_user_id=folder.owner_user_id,
            name=folder.name,
            matter_id=folder.matter_id,
            created_at=folder.created_at,
        )

    def to_model(self) -> ChatFolder:
        return ChatFolder(
            id=self.id,
            tenant_id=self.tenant_id,
            owner_user_id=self.owner_user_id,
            name=self.name,
            matter_id=self.matter_id,
            created_at=self.created_at,
        )


class ChatAttachmentRow(Base):
    __tablename__ = "chat_attachments"
    __table_args__ = (
        CheckConstraint(
            "size_bytes IS NULL OR size_bytes >= 0",
            name="size_bytes_nonnegative",
        ),
        Index("ix_chat_attachments_owner_id", "owner_user_id", "id"),
        Index(
            "ix_chat_attachments_tenant_owner_id",
            "tenant_id",
            "owner_user_id",
            "id",
        ),
        Index("ix_chat_attachments_source_type", "source_type"),
        Index("ix_chat_attachments_thread_id", "thread_id"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    owner_user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Server-derived link to the owning thread, maintained when a thread save
    # references the attachment from a message. Deliberately not a foreign
    # key: the workspace upsert re-inserts thread rows in place, and a
    # cascading constraint would sever links on every save.
    thread_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    size: Mapped[str] = mapped_column(String(100), nullable=False)
    kind: Mapped[str] = mapped_column(String(100), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    source_type: Mapped[str] = mapped_column(String(100), nullable=False)
    source_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(100), nullable=False)
    uploaded_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    text_preview: Mapped[str | None] = mapped_column(Text, nullable=True)

    @classmethod
    def from_model(cls, attachment: ChatAttachment) -> ChatAttachmentRow:
        if attachment.id is None:
            raise ValueError("Chat attachment rows require an id.")
        return cls(
            id=attachment.id,
            tenant_id=attachment.tenant_id,
            owner_user_id=attachment.owner_user_id,
            name=attachment.name,
            size=attachment.size,
            kind=attachment.kind,
            mime_type=attachment.mime_type,
            size_bytes=attachment.size_bytes,
            source_type=attachment.source_type,
            source_uri=attachment.source_uri,
            status=attachment.status,
            uploaded_at=attachment.uploaded_at,
            text_preview=attachment.text_preview,
        )

    def to_model(self) -> ChatAttachment:
        return ChatAttachment(
            id=self.id,
            tenant_id=self.tenant_id,
            owner_user_id=self.owner_user_id,
            name=self.name,
            size=self.size,
            kind=self.kind,
            mime_type=self.mime_type,
            size_bytes=self.size_bytes,
            source_type=self.source_type,
            source_uri=self.source_uri,
            status=self.status,
            uploaded_at=self.uploaded_at,
            text_preview=self.text_preview,
        )


class ChatThreadTagRow(Base):
    """Retention/classification tag on a chat thread.

    Tags are server-owned rows outside the client-authored thread payload.
    ``thread_id`` is deliberately not a foreign key: the workspace upsert
    re-inserts thread rows in place, and a cascading constraint would silently
    drop every tag on every save. Delete paths clean tags up explicitly.
    """

    __tablename__ = "chat_thread_tags"
    __table_args__ = (
        UniqueConstraint(
            "thread_id",
            "namespace",
            "key",
            name="uq_chat_thread_tags_thread_namespace_key",
        ),
        Index("ix_chat_thread_tags_tenant_namespace_key", "tenant_id", "namespace", "key"),
        Index("ix_chat_thread_tags_thread", "thread_id"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    thread_id: Mapped[str] = mapped_column(String(255), nullable=False)
    namespace: Mapped[str] = mapped_column(String(100), nullable=False)
    key: Mapped[str] = mapped_column(String(255), nullable=False)
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(100), nullable=False)
    applied_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    applied_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    @classmethod
    def from_model(cls, tag: ChatThreadTag) -> ChatThreadTagRow:
        return cls(
            id=tag.id,
            tenant_id=tag.tenant_id,
            thread_id=tag.thread_id,
            namespace=tag.namespace,
            key=tag.key,
            value=tag.value,
            source=tag.source,
            applied_at=tag.applied_at,
            applied_by=tag.applied_by,
        )

    def to_model(self) -> ChatThreadTag:
        return ChatThreadTag(
            id=self.id,
            tenant_id=self.tenant_id,
            thread_id=self.thread_id,
            namespace=self.namespace,
            key=self.key,
            value=self.value,
            source=self.source,
            applied_at=self.applied_at,
            applied_by=self.applied_by,
        )


class RetentionHoldRow(Base):
    """Legal hold header; membership rows pin the exact threads it covers."""

    __tablename__ = "retention_holds"
    __table_args__ = (Index("ix_retention_holds_tenant", "tenant_id"),)

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    released_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    @classmethod
    def from_model(cls, hold: RetentionHold) -> RetentionHoldRow:
        return cls(
            id=hold.id,
            tenant_id=hold.tenant_id,
            name=hold.name,
            reason=hold.reason,
            created_by=hold.created_by,
            created_at=hold.created_at,
            released_at=hold.released_at,
            released_by=hold.released_by,
        )

    def to_model(self) -> RetentionHold:
        return RetentionHold(
            id=self.id,
            tenant_id=self.tenant_id,
            name=self.name,
            reason=self.reason,
            created_by=self.created_by,
            created_at=self.created_at,
            released_at=self.released_at,
            released_by=self.released_by,
        )


class RetentionHoldThreadRow(Base):
    """Membership is materialized at hold creation so it stays stable.

    ``thread_id`` is not a foreign key for the same re-insert reason as
    ``chat_thread_tags``.
    """

    __tablename__ = "retention_hold_threads"
    __table_args__ = (Index("ix_retention_hold_threads_thread", "thread_id"),)

    hold_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("retention_holds.id", ondelete="CASCADE"),
        primary_key=True,
    )
    thread_id: Mapped[str] = mapped_column(String(255), primary_key=True)


class UserApiKeyRow(Base):
    __tablename__ = "user_api_keys"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_user_api_keys_user_id"),
        CheckConstraint("length(key_hash) = 64", name="key_hash_sha256_length"),
        Index("ix_user_api_keys_key_hash", "key_hash", unique=True),
        Index("ix_user_api_keys_tenant_user", "tenant_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(32), nullable=False)
    masked_value: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    last_used_at: Mapped[str | None] = mapped_column(Text, nullable=True)

    @classmethod
    def from_model(cls, record: UserApiKeyRecord) -> UserApiKeyRow:
        return cls(
            id=record.id,
            user_id=record.user_id,
            tenant_id=record.tenant_id,
            key_hash=record.key_hash,
            key_prefix=record.key_prefix,
            masked_value=record.masked_value,
            created_at=record.created_at,
            last_used_at=record.last_used_at,
        )

    def to_model(self) -> UserApiKeyRecord:
        return UserApiKeyRecord(
            id=self.id,
            user_id=self.user_id,
            tenant_id=self.tenant_id,
            key_hash=self.key_hash,
            key_prefix=self.key_prefix,
            masked_value=self.masked_value,
            created_at=self.created_at,
            last_used_at=self.last_used_at,
        )


class UserSessionWatermarkRow(Base):
    """Reject user sessions issued before a security cutoff."""

    __tablename__ = "user_session_watermarks"
    __table_args__ = (
        CheckConstraint("issued_before_ms >= 0", name="issued_before_ms_nonnegative"),
        Index(
            "ix_user_session_watermarks_tenant_issued_before_ms",
            "tenant_id",
            "issued_before_ms",
        ),
    )

    user_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    issued_before_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reason: Mapped[str] = mapped_column(String(255), nullable=False)


class SessionFamilyRow(Base):
    """Durable expiry horizon and revocation state for one stable session id."""

    __tablename__ = "session_families"
    __table_args__ = (
        CheckConstraint("max_expires_at >= 0", name="max_expires_at_nonnegative"),
        CheckConstraint(
            "(revoked_at IS NULL AND revoked_by_issued_at IS NULL "
            "AND revoked_by_expires_at IS NULL) OR "
            "(revoked_at IS NOT NULL AND revoked_by_issued_at IS NOT NULL "
            "AND revoked_by_expires_at IS NOT NULL "
            "AND revoked_by_expires_at >= revoked_by_issued_at)",
            name="revocation_claims_consistent",
        ),
        Index("ix_session_families_max_expires_at", "max_expires_at"),
        Index(
            "ix_session_families_user_max_expires_at",
            "user_id",
            "max_expires_at",
        ),
        Index(
            "ix_session_families_tenant_max_expires_at",
            "tenant_id",
            "max_expires_at",
        ),
        Index(
            "ix_session_families_revoked_max_expires_at",
            "revoked_at",
            "max_expires_at",
        ),
    )

    sid: Mapped[str] = mapped_column(String(128), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # How the family was first authenticated ("local" or "sso"). SSO sessions
    # were verified by the identity provider — including whatever MFA its
    # policy demands — so the platform authenticator requirement is evaluated
    # against this method, and rotation can never change it.
    auth_method: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="local"
    )
    max_expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    legacy_unbounded: Mapped[bool] = mapped_column(Boolean, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_by_issued_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    revoked_by_expires_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class TenantMfaPolicyRow(Base):
    """Tenant-wide TOTP enforcement policy with a monotonic generation."""

    __tablename__ = "tenant_mfa_policies"
    __table_args__ = (CheckConstraint("generation >= 1", name="generation_positive"),)

    tenant_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    required: Mapped[bool] = mapped_column(Boolean, nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)


class UserTotpFactorRow(Base):
    """One confirmed TOTP factor; plaintext seeds never enter this schema."""

    __tablename__ = "user_totp_factors"
    __table_args__ = (
        CheckConstraint("generation >= 1", name="generation_positive"),
        CheckConstraint(
            "encrypted_secret_ciphertext LIKE 'v3.%' AND length(encrypted_secret_ciphertext) > 3",
            name="ciphertext_v3_encrypted",
        ),
        CheckConstraint(
            "last_used_step IS NULL OR last_used_step >= 0",
            name="last_used_step_nonnegative",
        ),
        Index("ix_user_totp_factors_tenant_user", "tenant_id", "user_id"),
    )

    user_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    encrypted_secret_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    confirmed_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    last_used_step: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class TotpPendingEnrollmentRow(Base):
    """Expiring show-once TOTP enrollment state addressed only by token hash."""

    __tablename__ = "totp_pending_enrollments"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_totp_pending_enrollments_user_id"),
        UniqueConstraint(
            "source_challenge_hash",
            name="uq_totp_pending_enrollments_source_challenge_hash",
        ),
        CheckConstraint(
            "length(enrollment_token_hash) = 64",
            name="enrollment_token_hash_sha256_length",
        ),
        CheckConstraint("factor_generation >= 1", name="factor_generation_positive"),
        CheckConstraint(
            "auth_method IN ('local', 'sso')",
            name="auth_method_valid",
        ),
        CheckConstraint(
            "(auth_method = 'local' AND sso_config_id IS NULL) OR "
            "(auth_method = 'sso' AND sso_config_id IS NOT NULL)",
            name="auth_context_consistent",
        ),
        CheckConstraint(
            "source_challenge_hash IS NULL OR length(source_challenge_hash) = 64",
            name="source_challenge_hash_sha256_length",
        ),
        CheckConstraint(
            "encrypted_secret_ciphertext LIKE 'v3.%' AND length(encrypted_secret_ciphertext) > 3",
            name="ciphertext_v3_encrypted",
        ),
        CheckConstraint("expires_at > created_at", name="expiry_after_creation"),
        CheckConstraint("max_attempts >= 1", name="max_attempts_positive"),
        CheckConstraint(
            "attempts >= 0 AND attempts <= max_attempts",
            name="attempts_within_limit",
        ),
        CheckConstraint(
            "consumed_at IS NULL OR consumed_at >= created_at",
            name="consumed_after_creation",
        ),
        Index("ix_totp_pending_enrollments_expires_at", "expires_at"),
        Index(
            "ix_totp_pending_enrollments_tenant_expires_at",
            "tenant_id",
            "expires_at",
        ),
    )

    enrollment_token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    factor_generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    auth_method: Mapped[str] = mapped_column(String(32), nullable=False)
    sso_config_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_challenge_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    encrypted_secret_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class MfaPreauthChallengeRow(Base):
    """One-time pre-authentication challenge addressed only by SHA-256 hash."""

    __tablename__ = "mfa_preauth_challenges"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_mfa_preauth_challenges_user_id"),
        CheckConstraint("length(token_hash) = 64", name="token_hash_sha256_length"),
        CheckConstraint(
            "auth_method IN ('local', 'sso')",
            name="auth_method_valid",
        ),
        CheckConstraint(
            "(auth_method = 'local' AND sso_config_id IS NULL) OR "
            "(auth_method = 'sso' AND sso_config_id IS NOT NULL)",
            name="auth_context_consistent",
        ),
        CheckConstraint("purpose IN ('verify', 'enroll')", name="purpose_valid"),
        CheckConstraint(
            "(purpose = 'verify' AND expected_factor_generation IS NOT NULL) OR "
            "(purpose = 'enroll' AND expected_factor_generation IS NULL)",
            name="factor_generation_matches_purpose",
        ),
        CheckConstraint(
            "expected_factor_generation IS NULL OR expected_factor_generation >= 1",
            name="expected_factor_generation_positive",
        ),
        CheckConstraint("expires_at > created_at", name="expiry_after_creation"),
        CheckConstraint("max_attempts >= 1", name="max_attempts_positive"),
        CheckConstraint(
            "attempts >= 0 AND attempts <= max_attempts",
            name="attempts_within_limit",
        ),
        CheckConstraint(
            "consumed_at IS NULL OR consumed_at >= created_at",
            name="consumed_after_creation",
        ),
        Index("ix_mfa_preauth_challenges_expires_at", "expires_at"),
        Index(
            "ix_mfa_preauth_challenges_user_expires_at",
            "user_id",
            "expires_at",
        ),
        Index(
            "ix_mfa_preauth_challenges_tenant_expires_at",
            "tenant_id",
            "expires_at",
        ),
    )

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    auth_method: Mapped[str] = mapped_column(String(32), nullable=False)
    sso_config_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    expected_factor_generation: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class TotpRecoveryCodeRow(Base):
    """One high-entropy recovery code represented only by its SHA-256 hash."""

    __tablename__ = "totp_recovery_codes"
    __table_args__ = (
        CheckConstraint("length(code_hash) = 64", name="code_hash_sha256_length"),
        CheckConstraint("factor_generation >= 1", name="factor_generation_positive"),
        CheckConstraint(
            "used_at IS NULL OR used_at >= created_at",
            name="used_after_creation",
        ),
        Index(
            "ix_totp_recovery_codes_user_generation_used",
            "user_id",
            "factor_generation",
            "used_at",
        ),
        Index(
            "ix_totp_recovery_codes_tenant_user",
            "tenant_id",
            "user_id",
        ),
    )

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    factor_generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class ChatStateImportRow(Base):
    """Receipt for one completed transactional version-3 chat-state import."""

    __tablename__ = "chat_state_imports"
    __table_args__ = (
        CheckConstraint("length(source_digest) = 64", name="source_digest_sha256_length"),
        CheckConstraint(
            "length(prior_application_state_digest) = 64",
            name="prior_digest_sha256_length",
        ),
        CheckConstraint("source_version >= 0", name="source_version_nonnegative"),
        CheckConstraint("target_version >= 0", name="target_version_nonnegative"),
        CheckConstraint("thread_count >= 0", name="thread_count_nonnegative"),
        CheckConstraint("folder_count >= 0", name="folder_count_nonnegative"),
        CheckConstraint("attachment_count >= 0", name="attachment_count_nonnegative"),
        CheckConstraint("api_key_count >= 0", name="api_key_count_nonnegative"),
        CheckConstraint("watermark_count >= 0", name="watermark_count_nonnegative"),
    )

    source_digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_version: Mapped[int] = mapped_column(Integer, nullable=False)
    target_version: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    completed_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    prior_application_state_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    thread_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    folder_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    attachment_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    api_key_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    watermark_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class MatterRow(Base):
    """Tenant-scoped matter container; access comes only from membership rows."""

    __tablename__ = "matters"
    __table_args__ = (
        CheckConstraint(
            "length(trim(name)) >= 1 AND length(name) <= 200",
            name="name_bounded",
        ),
        CheckConstraint(
            "retention_days IS NULL OR (retention_days >= 1 AND retention_days <= 36500)",
            name="retention_days_bounded",
        ),
        CheckConstraint(
            "version >= 1 AND version <= 9223372036854775807",
            name="version_signed_bigint",
        ),
        CheckConstraint("updated_at >= created_at", name="updated_after_creation"),
        UniqueConstraint("id", "tenant_id", name="uq_matters_id_tenant"),
        Index("ix_matters_tenant_updated_id", "tenant_id", "updated_at", "id"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    retention_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    @classmethod
    def from_model(cls, matter: Matter) -> MatterRow:
        return cls(
            id=matter.id,
            tenant_id=matter.tenant_id,
            name=matter.name,
            retention_days=matter.retention_days,
            created_by_user_id=matter.created_by_user_id,
            version=matter.version,
            created_at=matter.created_at,
            updated_at=matter.updated_at,
        )

    def to_model(self) -> Matter:
        return Matter(
            id=self.id,
            tenant_id=self.tenant_id,
            name=self.name,
            retention_days=self.retention_days,
            created_by_user_id=self.created_by_user_id,
            version=self.version,
            created_at=self.created_at,
            updated_at=self.updated_at,
        )


class MatterMembershipRow(Base):
    __tablename__ = "matter_memberships"
    __table_args__ = (
        ForeignKeyConstraint(
            ["matter_id", "tenant_id"],
            ["matters.id", "matters.tenant_id"],
            name="fk_matter_memberships_matter_tenant_matters",
            ondelete="CASCADE",
        ),
        Index(
            "ix_matter_memberships_tenant_member_matter",
            "tenant_id",
            "member_user_id",
            "matter_id",
        ),
    )

    matter_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    member_user_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    added_by_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    def to_model(self) -> MatterMembership:
        return MatterMembership(
            matter_id=self.matter_id,
            tenant_id=self.tenant_id,
            member_user_id=self.member_user_id,
            added_by_user_id=self.added_by_user_id,
            created_at=self.created_at,
        )


class MatterDeletionJobRow(Base):
    """Restart-safe cross-store cleanup intent with no work-product payload."""

    __tablename__ = "matter_deletion_jobs"
    __table_args__ = (
        CheckConstraint(
            "requested_matter_version >= 1 AND requested_matter_version <= 9223372036854775807",
            name="requested_version_signed_bigint",
        ),
        CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 9223372036854775807",
            name="attempt_count_signed_bigint",
        ),
        CheckConstraint(
            "status IN ('pending', 'running', 'failed', 'ready', 'complete')",
            name="status_valid",
        ),
        CheckConstraint("updated_at >= requested_at", name="updated_after_request"),
        CheckConstraint(
            "(attempt_count = 0 AND last_attempt_at IS NULL) OR "
            "(attempt_count >= 1 AND last_attempt_at IS NOT NULL)",
            name="attempt_clock_consistent",
        ),
        CheckConstraint(
            "last_attempt_at IS NULL OR last_attempt_at >= requested_at",
            name="attempt_after_request",
        ),
        CheckConstraint(
            "(status = 'running' AND lease_expires_at IS NOT NULL) OR "
            "(status != 'running' AND lease_expires_at IS NULL)",
            name="lease_status_consistent",
        ),
        CheckConstraint(
            "lease_expires_at IS NULL OR lease_expires_at > last_attempt_at",
            name="lease_after_attempt",
        ),
        CheckConstraint(
            "last_error_stage IS NULL OR "
            "last_error_stage IN ('application', 'review', 'knowledge', 'legacy')",
            name="error_stage_valid",
        ),
        CheckConstraint(
            "(status = 'failed' AND last_error_stage IS NOT NULL) OR "
            "(status != 'failed' AND last_error_stage IS NULL)",
            name="failure_stage_consistent",
        ),
        CheckConstraint(
            "status NOT IN ('ready', 'complete') OR "
            "(application_refs_cleared_at IS NOT NULL "
            "AND review_refs_cleared_at IS NOT NULL "
            "AND knowledge_refs_cleared_at IS NOT NULL "
            "AND legacy_refs_cleared_at IS NOT NULL)",
            name="ready_stages_complete",
        ),
        CheckConstraint(
            "(status = 'complete' AND completed_at IS NOT NULL) OR "
            "(status != 'complete' AND completed_at IS NULL)",
            name="completion_status_consistent",
        ),
        CheckConstraint(
            "(application_refs_cleared_at IS NULL "
            "OR application_refs_cleared_at >= requested_at) "
            "AND (review_refs_cleared_at IS NULL "
            "OR review_refs_cleared_at >= requested_at) "
            "AND (knowledge_refs_cleared_at IS NULL "
            "OR knowledge_refs_cleared_at >= requested_at) "
            "AND (legacy_refs_cleared_at IS NULL "
            "OR legacy_refs_cleared_at >= requested_at)",
            name="stage_clocks_after_request",
        ),
        CheckConstraint(
            "completed_at IS NULL OR completed_at >= requested_at",
            name="completed_after_request",
        ),
        Index(
            "ix_matter_deletion_jobs_tenant_status_updated",
            "tenant_id",
            "status",
            "updated_at",
        ),
        Index(
            "ix_matter_deletion_jobs_status_lease",
            "status",
            "lease_expires_at",
        ),
    )

    matter_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    requested_by_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    requested_matter_version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    attempt_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    requested_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    last_attempt_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    application_refs_cleared_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(), nullable=True
    )
    review_refs_cleared_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    knowledge_refs_cleared_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    legacy_refs_cleared_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_error_stage: Mapped[str | None] = mapped_column(String(32), nullable=True)

    @classmethod
    def from_model(cls, job: MatterDeletionJob) -> MatterDeletionJobRow:
        return cls(**job.model_dump(mode="python"))

    def to_model(self) -> MatterDeletionJob:
        return MatterDeletionJob.model_validate(
            {
                "matter_id": self.matter_id,
                "tenant_id": self.tenant_id,
                "requested_by_user_id": self.requested_by_user_id,
                "requested_matter_version": self.requested_matter_version,
                "status": self.status,
                "attempt_count": self.attempt_count,
                "requested_at": self.requested_at,
                "updated_at": self.updated_at,
                "last_attempt_at": self.last_attempt_at,
                "lease_expires_at": self.lease_expires_at,
                "application_refs_cleared_at": self.application_refs_cleared_at,
                "review_refs_cleared_at": self.review_refs_cleared_at,
                "knowledge_refs_cleared_at": self.knowledge_refs_cleared_at,
                "legacy_refs_cleared_at": self.legacy_refs_cleared_at,
                "completed_at": self.completed_at,
                "last_error_stage": self.last_error_stage,
            }
        )


class DraftDocumentRow(Base):
    __tablename__ = "draft_documents"
    __table_args__ = (
        CheckConstraint(
            "length(trim(title)) >= 1 AND length(title) <= 240",
            name="title_bounded",
        ),
        CheckConstraint(
            "current_revision >= 1 AND current_revision <= 200",
            name="current_revision_bounded",
        ),
        CheckConstraint("updated_at >= created_at", name="updated_after_creation"),
        UniqueConstraint(
            "id",
            "tenant_id",
            "owner_user_id",
            name="uq_draft_documents_id_tenant_owner",
        ),
        Index(
            "ix_draft_documents_tenant_owner_updated",
            "tenant_id",
            "owner_user_id",
            "updated_at",
        ),
        Index(
            "ix_draft_documents_tenant_matter_owner_updated",
            "tenant_id",
            "matter_id",
            "owner_user_id",
            "updated_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    matter_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey(
            "matters.id",
            name="fk_draft_documents_matter_id_matters",
            ondelete="SET NULL",
        ),
        nullable=True,
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    current_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    @classmethod
    def from_model(cls, document: DraftDocument) -> DraftDocumentRow:
        return cls(**document.model_dump(mode="python"))

    def to_model(self) -> DraftDocument:
        return DraftDocument(
            id=self.id,
            tenant_id=self.tenant_id,
            owner_user_id=self.owner_user_id,
            matter_id=self.matter_id,
            title=self.title,
            current_revision=self.current_revision,
            created_at=self.created_at,
            updated_at=self.updated_at,
        )


class DraftRevisionRow(Base):
    __tablename__ = "draft_revisions"
    __table_args__ = (
        CheckConstraint(
            "revision >= 1 AND revision <= 200",
            name="revision_bounded",
        ),
        CheckConstraint(
            "length(trim(title)) >= 1 AND length(title) <= 240",
            name="title_bounded",
        ),
        CheckConstraint(
            "octet_length(content) <= 2000000",
            name="content_utf8_bytes_bounded",
        ),
        CheckConstraint(
            "length(content_sha256) = 64",
            name="content_sha256_length",
        ),
        CheckConstraint(
            "sanitizer_version = 'sanitized-html-v1'",
            name="sanitizer_version_valid",
        ),
        ForeignKeyConstraint(
            ["draft_id", "tenant_id", "owner_user_id"],
            [
                "draft_documents.id",
                "draft_documents.tenant_id",
                "draft_documents.owner_user_id",
            ],
            name="fk_draft_revisions_draft_tenant_owner_documents",
            ondelete="CASCADE",
        ),
        Index(
            "ix_draft_revisions_tenant_owner_draft_revision",
            "tenant_id",
            "owner_user_id",
            "draft_id",
            "revision",
        ),
    )

    draft_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    revision: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    sanitizer_version: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    @classmethod
    def from_model(cls, revision: DraftRevision) -> DraftRevisionRow:
        return cls(**revision.model_dump(mode="python"))

    def to_model(self) -> DraftRevision:
        return DraftRevision(
            draft_id=self.draft_id,
            tenant_id=self.tenant_id,
            owner_user_id=self.owner_user_id,
            revision=self.revision,
            title=self.title,
            content=self.content,
            content_sha256=self.content_sha256,
            sanitizer_version=self.sanitizer_version,
            created_at=self.created_at,
        )


class TenantRow(Base):
    """Authoritative tenant configuration, preserving its validated v4 payload."""

    __tablename__ = "tenants"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_tenants_ordinal"),
        UniqueConstraint("slug", name="uq_tenants_slug"),
        UniqueConstraint("custom_domain", name="uq_tenants_custom_domain"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False)
    custom_domain: Mapped[str | None] = mapped_column(String(253), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class IdentityUserRow(Base):
    """Authoritative user identity and policy payload."""

    __tablename__ = "identity_users"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_identity_users_ordinal"),
        UniqueConstraint("email_normalized", name="uq_identity_users_email_normalized"),
        Index("ix_identity_users_tenant_active", "tenant_id", "active"),
        Index("ix_identity_users_tenant_role", "tenant_id", "role"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
    )
    email_normalized: Mapped[str] = mapped_column(String(320), nullable=False)
    role: Mapped[str] = mapped_column(String(100), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class IdentityGroupRow(Base):
    """Authoritative tenant group and permission payload."""

    __tablename__ = "identity_groups"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_identity_groups_ordinal"),
        Index("ix_identity_groups_tenant_default", "tenant_id", "default_group"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    default_group: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class ProviderRow(Base):
    __tablename__ = "providers"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_providers_ordinal"),
        Index("ix_providers_kind_connected", "kind", "connected"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(100), nullable=False)
    connected: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class ModelConfigRow(Base):
    __tablename__ = "model_configs"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_model_configs_ordinal"),
        Index("ix_model_configs_provider_enabled", "provider_id", "platform_enabled"),
        Index("ix_model_configs_tenant_enabled", "tenant_id", "platform_enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
    )
    provider_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("providers.id", ondelete="RESTRICT"),
        nullable=False,
    )
    platform_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class ProviderKeyRow(Base):
    """Provider-key metadata and ciphertext in one transactional row."""

    __tablename__ = "provider_keys"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        CheckConstraint(
            "(tenant_id IS NULL AND credential_scope = 'platform') OR "
            "(tenant_id IS NOT NULL AND credential_scope = 'tenant:' || tenant_id)",
            name="scope_matches_tenant",
        ),
        UniqueConstraint("ordinal", name="uq_provider_keys_ordinal"),
        UniqueConstraint(
            "id",
            "provider_id",
            "credential_scope",
            name="uq_provider_keys_id_provider_scope",
        ),
        Index("ix_provider_keys_provider_scope", "provider_id", "credential_scope"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    provider_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("providers.id", ondelete="CASCADE"),
        nullable=False,
    )
    tenant_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
    )
    credential_scope: Mapped[str] = mapped_column(String(320), nullable=False)
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class ProviderCredentialBindingRow(Base):
    """The sole selected key for one provider and platform-or-tenant scope."""

    __tablename__ = "provider_credential_bindings"
    __table_args__ = (
        CheckConstraint(
            "(tenant_id IS NULL AND scope_key = 'platform') OR "
            "(tenant_id IS NOT NULL AND scope_key = 'tenant:' || tenant_id)",
            name="scope_matches_tenant",
        ),
        ForeignKeyConstraint(
            ["provider_key_id", "provider_id", "scope_key"],
            [
                "provider_keys.id",
                "provider_keys.provider_id",
                "provider_keys.credential_scope",
            ],
            name="fk_provider_credential_bindings_key_provider_scope",
            ondelete="CASCADE",
        ),
        UniqueConstraint(
            "provider_key_id",
            name="uq_provider_credential_bindings_provider_key_id",
        ),
        Index("ix_provider_credential_bindings_tenant_provider", "tenant_id", "provider_id"),
    )

    provider_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(320), primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
    )
    provider_key_id: Mapped[str] = mapped_column(String(255), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class ConnectorRow(Base):
    __tablename__ = "connectors"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_connectors_ordinal"),
        Index("ix_connectors_platform_tenant_enabled", "platform_enabled", "tenant_enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    platform_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    tenant_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class ConnectorConfigRow(Base):
    __tablename__ = "connector_configs"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_connector_configs_ordinal"),
        Index("ix_connector_configs_tenant_connector", "tenant_id", "connector_id"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    connector_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("connectors.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class SsoConfigRow(Base):
    __tablename__ = "sso_configs"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_sso_configs_ordinal"),
        Index("ix_sso_configs_tenant_enabled", "tenant_id", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class KnowledgeConfigRow(Base):
    __tablename__ = "knowledge_configs"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_knowledge_configs_ordinal"),
        Index("ix_knowledge_configs_tenant_enabled", "tenant_id", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    connector_config_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("connector_configs.id", ondelete="SET NULL"),
        nullable=True,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class ToolConfigRow(Base):
    __tablename__ = "tool_configs"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_tool_configs_ordinal"),
        Index("ix_tool_configs_tenant_enabled", "tenant_id", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class PromptTemplateRow(Base):
    __tablename__ = "prompt_templates"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_prompt_templates_ordinal"),
        Index("ix_prompt_templates_tenant_enabled", "tenant_id", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class SkillFileRow(Base):
    __tablename__ = "skill_files"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_skill_files_ordinal"),
        Index("ix_skill_files_tenant_enabled", "tenant_id", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class SecurityAlertRow(Base):
    __tablename__ = "security_alerts"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_security_alerts_ordinal"),
        Index("ix_security_alerts_tenant_acknowledged", "tenant_id", "acknowledged"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
    )
    acknowledged: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class AgentRunRow(Base):
    __tablename__ = "agent_runs"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_agent_runs_ordinal"),
        Index("ix_agent_runs_tenant_status", "tenant_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(String(100), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class AutomationRow(Base):
    __tablename__ = "automations"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_automations_ordinal"),
        Index("ix_automations_tenant_enabled", "tenant_id", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class CompanionMemoryRow(Base):
    __tablename__ = "companion_memories"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_companion_memories_ordinal"),
        Index("ix_companion_memories_tenant_profile", "tenant_id", "profile_id"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    profile_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("model_configs.id", ondelete="CASCADE"),
        nullable=False,
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class ContentFilterRow(Base):
    __tablename__ = "content_filters"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_content_filters_ordinal"),
        Index("ix_content_filters_tenant_builtin", "tenant_id", "builtin"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
    )
    builtin: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class UserMemoryRow(Base):
    """Per-user personalization memory.

    Content lives in the JSON payload like every other snapshot collection;
    the projected owner/tenant columns exist for integrity and cascade, not
    for querying content. Nothing joins through this table to read memories
    on behalf of another user.
    """

    __tablename__ = "user_memories"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_user_memories_ordinal"),
        Index("ix_user_memories_tenant_owner", "tenant_id", "owner_user_id"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    owner_user_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("identity_users.id", ondelete="CASCADE"),
        nullable=False,
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class TenantMemoryPolicyRow(Base):
    __tablename__ = "tenant_memory_policies"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_tenant_memory_policies_ordinal"),
        UniqueConstraint("tenant_id", name="uq_tenant_memory_policies_tenant"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class TenantRetentionPolicyRow(Base):
    __tablename__ = "tenant_retention_policies"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_tenant_retention_policies_ordinal"),
        UniqueConstraint("tenant_id", name="uq_tenant_retention_policies_tenant"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class UserMemorySettingsRow(Base):
    __tablename__ = "user_memory_settings"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        UniqueConstraint("ordinal", name="uq_user_memory_settings_ordinal"),
        UniqueConstraint("user_id", name="uq_user_memory_settings_user"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    user_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("identity_users.id", ondelete="CASCADE"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class ScimTokenRow(Base):
    __tablename__ = "scim_tokens"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        CheckConstraint("length(token_hash) = 64", name="token_hash_sha256_length"),
        UniqueConstraint("ordinal", name="uq_scim_tokens_ordinal"),
        UniqueConstraint("token_hash", name="uq_scim_tokens_token_hash"),
        Index("ix_scim_tokens_tenant_revoked", "tenant_id", "revoked_at"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    tenant_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    revoked_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class AlertRuleConfigRow(Base):
    __tablename__ = "alert_rule_configs"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        CheckConstraint("scope IN ('platform', 'tenant')", name="scope_valid"),
        CheckConstraint(
            "(scope = 'platform' AND tenant_id IS NULL) OR "
            "(scope = 'tenant' AND tenant_id IS NOT NULL)",
            name="scope_matches_tenant",
        ),
        UniqueConstraint("ordinal", name="uq_alert_rule_configs_ordinal"),
        Index("ix_alert_rule_configs_tenant_enabled", "tenant_id", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    scope: Mapped[str] = mapped_column(String(20), nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class PlatformSettingsRow(Base):
    __tablename__ = "platform_settings"
    __table_args__ = (CheckConstraint("singleton_id = 1", name="singleton_id_one"),)

    singleton_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class EmailSettingsRow(Base):
    __tablename__ = "email_settings"
    __table_args__ = (CheckConstraint("singleton_id = 1", name="singleton_id_one"),)

    singleton_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON(none_as_null=True), nullable=False)


class PasswordCredentialRow(Base):
    __tablename__ = "password_credentials"
    __table_args__ = (Index("ix_password_credentials_temporary", "temporary"),)

    user_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("identity_users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    temporary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ConfigurationSecretRow(Base):
    """Encrypted polymorphic config secret with an exact structured owner."""

    __tablename__ = "configuration_secrets"
    __table_args__ = (
        CheckConstraint("length(namespace) >= 1", name="namespace_nonempty"),
        CheckConstraint("length(resource_id) >= 1", name="resource_id_nonempty"),
        UniqueConstraint(
            "namespace",
            "resource_id",
            "qualifier",
            name="uq_configuration_secrets_owner",
        ),
        Index("ix_configuration_secrets_tenant_namespace", "tenant_id", "namespace"),
    )

    secret_key: Mapped[str] = mapped_column(String(768), primary_key=True)
    namespace: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(255), nullable=False)
    qualifier: Mapped[str] = mapped_column(String(320), nullable=False, default="")
    tenant_id: Mapped[str | None] = mapped_column(
        String(255),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
    )
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)


class IdentityConfigImportRow(Base):
    """Receipt for one staged, fully verified v4 identity/config import."""

    __tablename__ = "identity_config_imports"
    __table_args__ = (
        CheckConstraint("length(source_digest) = 64", name="source_digest_sha256_length"),
        CheckConstraint("source_version = 4", name="source_version_v4"),
        CheckConstraint("target_version = 5", name="target_version_v5"),
        CheckConstraint(
            "schema_revision = '20260720_0009'",
            name="schema_revision_0009",
        ),
        CheckConstraint(
            "length(prior_application_state_digest) = 64",
            name="prior_application_digest_sha256_length",
        ),
        CheckConstraint(
            "length(prior_chat_state_digest) = 64",
            name="prior_chat_digest_sha256_length",
        ),
        CheckConstraint("length(relational_digest) = 64", name="relational_digest_sha256_length"),
        CheckConstraint("length(knowledge_digest) = 64", name="knowledge_digest_sha256_length"),
    )

    source_digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_version: Mapped[int] = mapped_column(Integer, nullable=False)
    target_version: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_revision: Mapped[str] = mapped_column(String(32), nullable=False)
    prior_application_state_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    prior_chat_state_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    relational_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    knowledge_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    collection_counts: Mapped[dict[str, Any]] = mapped_column(
        JSON(none_as_null=True),
        nullable=False,
    )
    completed_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class IdentityConfigActiveImportRow(Base):
    """Singleton authority pointer, written only after vector receipt verification."""

    __tablename__ = "identity_config_active_import"
    __table_args__ = (CheckConstraint("singleton_id = 1", name="singleton_id_one"),)

    singleton_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_digest: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("identity_config_imports.source_digest", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    activated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class IdentityCleanupJobRow(Base):
    """Lease-fenced cleanup tombstone that survives its target resource."""

    __tablename__ = "identity_cleanup_jobs"
    __table_args__ = (
        CheckConstraint(
            "resource_kind IN ('tenant', 'user', 'knowledge_config')",
            name="resource_kind_valid",
        ),
        CheckConstraint(
            "length(job_id) >= 1 AND length(resource_id) >= 1 "
            "AND length(tenant_id) >= 1",
            name="scope_ids_nonempty",
        ),
        CheckConstraint(
            "resource_kind != 'tenant' OR resource_id = tenant_id",
            name="tenant_resource_matches_scope",
        ),
        CheckConstraint(
            "status IN ('pending', 'running', 'failed', 'complete')",
            name="status_valid",
        ),
        CheckConstraint(
            "generation >= 1 AND generation <= 9223372036854775807",
            name="generation_signed_bigint",
        ),
        CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 9223372036854775807",
            name="attempt_count_signed_bigint",
        ),
        CheckConstraint("updated_at >= requested_at", name="updated_after_request"),
        CheckConstraint(
            "(attempt_count = 0 AND status = 'pending' AND last_attempt_at IS NULL) OR "
            "(attempt_count >= 1 AND status != 'pending' AND last_attempt_at IS NOT NULL)",
            name="attempt_clock_consistent",
        ),
        CheckConstraint(
            "last_attempt_at IS NULL OR "
            "(last_attempt_at >= requested_at AND last_attempt_at <= updated_at)",
            name="attempt_clock_bounded",
        ),
        CheckConstraint(
            "(status = 'running' AND lease_expires_at IS NOT NULL) OR "
            "(status != 'running' AND lease_expires_at IS NULL)",
            name="lease_status_consistent",
        ),
        CheckConstraint(
            "lease_expires_at IS NULL OR lease_expires_at > last_attempt_at",
            name="lease_after_attempt",
        ),
        CheckConstraint(
            "status != 'running' OR lease_expires_at > updated_at",
            name="active_lease_after_update",
        ),
        CheckConstraint(
            "last_error_stage IS NULL OR last_error_stage IN "
            "('identity', 'application', 'review', 'knowledge_vector', 'm9')",
            name="error_stage_valid",
        ),
        CheckConstraint(
            "(status = 'failed' AND last_error_stage IS NOT NULL) OR "
            "(status != 'failed' AND last_error_stage IS NULL)",
            name="failure_stage_consistent",
        ),
        CheckConstraint(
            "status != 'failed' OR "
            "(last_error_stage = 'identity' AND identity_committed_at IS NULL) OR "
            "(last_error_stage = 'application' AND identity_committed_at IS NOT NULL "
            "AND application_cleared_at IS NULL) OR "
            "(last_error_stage = 'review' AND application_cleared_at IS NOT NULL "
            "AND review_cleared_at IS NULL) OR "
            "(last_error_stage = 'knowledge_vector' AND review_cleared_at IS NOT NULL "
            "AND knowledge_vector_cleared_at IS NULL) OR "
            "(last_error_stage = 'm9' AND knowledge_vector_cleared_at IS NOT NULL "
            "AND m9_cleared_at IS NULL)",
            name="failure_matches_next_stage",
        ),
        CheckConstraint(
            "(application_cleared_at IS NULL OR identity_committed_at IS NOT NULL) AND "
            "(review_cleared_at IS NULL OR application_cleared_at IS NOT NULL) AND "
            "(knowledge_vector_cleared_at IS NULL OR review_cleared_at IS NOT NULL) AND "
            "(m9_cleared_at IS NULL OR knowledge_vector_cleared_at IS NOT NULL)",
            name="stage_prefix_ordered",
        ),
        CheckConstraint(
            "(identity_committed_at IS NULL OR "
            "(identity_committed_at >= requested_at AND identity_committed_at <= updated_at)) "
            "AND (application_cleared_at IS NULL OR "
            "(application_cleared_at >= identity_committed_at "
            "AND application_cleared_at <= updated_at)) "
            "AND (review_cleared_at IS NULL OR "
            "(review_cleared_at >= application_cleared_at "
            "AND review_cleared_at <= updated_at)) "
            "AND (knowledge_vector_cleared_at IS NULL OR "
            "(knowledge_vector_cleared_at >= review_cleared_at "
            "AND knowledge_vector_cleared_at <= updated_at)) "
            "AND (m9_cleared_at IS NULL OR "
            "(m9_cleared_at >= knowledge_vector_cleared_at "
            "AND m9_cleared_at <= updated_at))",
            name="stage_clocks_ordered",
        ),
        CheckConstraint(
            "attempt_count != 0 OR "
            "(identity_committed_at IS NULL AND application_cleared_at IS NULL "
            "AND review_cleared_at IS NULL AND knowledge_vector_cleared_at IS NULL "
            "AND m9_cleared_at IS NULL)",
            name="unclaimed_has_no_stages",
        ),
        CheckConstraint(
            "(status = 'complete' AND completed_at IS NOT NULL "
            "AND identity_committed_at IS NOT NULL "
            "AND application_cleared_at IS NOT NULL "
            "AND review_cleared_at IS NOT NULL "
            "AND knowledge_vector_cleared_at IS NOT NULL "
            "AND m9_cleared_at IS NOT NULL) OR "
            "(status != 'complete' AND completed_at IS NULL)",
            name="completion_status_consistent",
        ),
        CheckConstraint(
            "completed_at IS NULL OR "
            "(completed_at >= m9_cleared_at AND completed_at <= updated_at)",
            name="completed_clock_ordered",
        ),
        Index(
            "ix_identity_cleanup_jobs_tenant_status_updated",
            "tenant_id",
            "status",
            "updated_at",
            "job_id",
        ),
        Index(
            "ix_identity_cleanup_jobs_status_lease",
            "status",
            "lease_expires_at",
            "updated_at",
            "job_id",
        ),
        Index(
            "uq_identity_cleanup_jobs_active_resource",
            "resource_kind",
            "resource_id",
            unique=True,
            postgresql_where=text("status != 'complete'"),
            sqlite_where=text("status != 'complete'"),
        ),
        UniqueConstraint("job_id", "resource_kind", name="uq_identity_cleanup_jobs_job_kind"),
        UniqueConstraint(
            "resource_kind",
            "resource_id",
            "generation",
            name="uq_identity_cleanup_jobs_resource_generation",
        ),
    )

    job_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    resource_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(255), nullable=False)
    generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    tenant_id: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    attempt_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    requested_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    last_attempt_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    identity_committed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    application_cleared_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    review_cleared_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    knowledge_vector_cleared_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(),
        nullable=True,
    )
    m9_cleared_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_error_stage: Mapped[str | None] = mapped_column(String(32), nullable=True)


class IdentityCleanupJobUserRow(Base):
    """Exact tenant user/session cutoff captured before identity removal."""

    __tablename__ = "identity_cleanup_job_users"
    __table_args__ = (
        CheckConstraint(
            "resource_kind IN ('tenant', 'user')",
            name="identity_subject_jobs_only",
        ),
        CheckConstraint("length(user_id) >= 1", name="user_id_nonempty"),
        CheckConstraint(
            "session_cutoff_ms >= 0 AND session_cutoff_ms <= 9223372036854775807",
            name="cutoff_signed_bigint",
        ),
        ForeignKeyConstraint(
            ["job_id", "resource_kind"],
            [
                "identity_cleanup_jobs.job_id",
                "identity_cleanup_jobs.resource_kind",
            ],
            name="fk_identity_cleanup_job_users_job_kind_identity_cleanup_jobs",
            ondelete="CASCADE",
        ),
    )

    job_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    resource_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    session_cutoff_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)


class CutoverVectorSourceJournalRow(Base):
    """Temporary strict knowledge payload for crash-safe v4 -> v5 cutover."""

    __tablename__ = "cutover_vector_source_journal"
    __table_args__ = (
        CheckConstraint(
            "length(source_digest) = 64",
            name="source_digest_sha256_length",
        ),
        CheckConstraint(
            "length(knowledge_digest) = 64",
            name="knowledge_digest_sha256_length",
        ),
        CheckConstraint(
            "length(journal_digest) = 64",
            name="journal_digest_sha256_length",
        ),
        CheckConstraint(
            "document_count >= 0 AND document_count <= 9223372036854775807",
            name="document_count_signed_bigint",
        ),
        CheckConstraint(
            "chunk_count >= 0 AND chunk_count <= 9223372036854775807",
            name="chunk_count_signed_bigint",
        ),
    )

    source_digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    knowledge_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    journal_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    documents: Mapped[dict[str, Any]] = mapped_column(
        JSON(none_as_null=True),
        nullable=False,
    )
    chunks: Mapped[dict[str, Any]] = mapped_column(
        JSON(none_as_null=True),
        nullable=False,
    )
    document_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    chunk_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class CutoverVectorSourceConsumedRow(Base):
    """Privacy-minimal tombstone preventing stale journal resurrection."""

    __tablename__ = "cutover_vector_source_consumed"
    __table_args__ = (
        CheckConstraint(
            "length(source_digest) = 64",
            name="source_digest_sha256_length",
        ),
        CheckConstraint(
            "length(knowledge_digest) = 64",
            name="knowledge_digest_sha256_length",
        ),
        CheckConstraint(
            "length(journal_digest) = 64",
            name="journal_digest_sha256_length",
        ),
    )

    source_digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    knowledge_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    journal_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    consumed_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
