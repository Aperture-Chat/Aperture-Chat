"""Fail-closed runtime orchestration for tenant token-budget accounting.

This module is deliberately independent of FastAPI, request objects, SeedStore,
and provider clients. Routes resolve explicit tenant identifiers before calling
it, then execute a provider only when ``begin_request`` returns a context. Raw
provider usage is forwarded unchanged; missing usage stays unmetered and token
counts are never estimated.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from http import HTTPStatus
from typing import TYPE_CHECKING, Any, Literal, Protocol

from app.core.usage_budget import (
    TemporaryAccessGrantExhausted,
    UsageBudgetError,
    UsageBudgetExceeded,
    UsageBudgetUnavailable,
    UsageMeteringInvalid,
    UsagePermitConflict,
    normalize_reported_usage,
)
from app.models.schemas import Role, TEMP_USER_TOKEN_LIMIT, TenantUsagePermit, UsageRecord, User

if TYPE_CHECKING:
    from app.repositories.usage_budgets import CompletionSettlement, PermitAcquireResult


RuntimeTerminalStatus = Literal["completed", "failed", "abandoned"]
RuntimeStatus = Literal["active", "completed", "failed", "abandoned"]


class UsageBudgetRepositoryPort(Protocol):
    """Repository operations needed by the isolated runtime adapter."""

    def acquire_permit(
        self,
        *,
        tenant_id: str,
        request_id: str | None = None,
        principals: Sequence[tuple[str, str]] | None = None,
        hard_token_limits: Mapping[tuple[str, str], int] | None = None,
        now: datetime | None = None,
    ) -> PermitAcquireResult: ...

    def record_provider_completion(
        self,
        *,
        permit_id: str,
        completion_id: str,
        usage: Mapping[str, Any] | None,
        usage_record: UsageRecord,
        principals: Sequence[tuple[str, str]] | None = None,
        completed_at: datetime | None = None,
    ) -> CompletionSettlement: ...

    def complete_permit(
        self,
        permit_id: str,
        *,
        now: datetime | None = None,
    ) -> TenantUsagePermit: ...

    def fail_permit(
        self,
        permit_id: str,
        *,
        now: datetime | None = None,
    ) -> TenantUsagePermit: ...

    def abandon_permit(
        self,
        permit_id: str,
        *,
        now: datetime | None = None,
    ) -> TenantUsagePermit: ...


class UsageTenantScopeError(ValueError):
    """Pure tenant-resolution failure with an HTTP-ready status and detail."""

    def __init__(self, *, code: str, status_code: int, detail: str) -> None:
        self.code = code
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


class UsageProviderExecutionRefused(RuntimeError):
    """The request already owns a permit, so this caller must not run a provider."""

    def __init__(self, permit: TenantUsagePermit) -> None:
        self.permit = permit
        super().__init__(
            "Provider execution was not acquired for this replayed usage-budget request."
        )


class UsageRequestStateError(RuntimeError):
    """The caller attempted an invalid request-context state transition."""


@dataclass(frozen=True, slots=True)
class UsageBudgetHttpFailure:
    """Framework-neutral data that can be copied into an honest HTTP response."""

    status_code: int
    code: str
    detail: str
    headers: Mapping[str, str] = field(default_factory=dict)
    retry_after_seconds: int | None = None
    reset_at: datetime | None = None
    daily_token_limit: int | None = None
    reported_tokens: int | None = None
    budget_unit: str | None = None
    budget_period: str | None = None
    limit_value: int | None = None
    reported_value: int | None = None


@dataclass(frozen=True, slots=True)
class ProviderUsageAttribution:
    """Exact durable attribution for one real provider child call."""

    model_id: str
    provider_name: str
    surface: str
    message_count: int = 1
    thread_id: str | None = None

    def __post_init__(self) -> None:
        for label, value in (
            ("model_id", self.model_id),
            ("provider_name", self.provider_name),
            ("surface", self.surface),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{label} must be a non-empty string")
        if (
            isinstance(self.message_count, bool)
            or not isinstance(self.message_count, int)
            or self.message_count < 1
        ):
            raise ValueError("message_count must be a positive integer")
        if self.thread_id is not None and not isinstance(self.thread_id, str):
            raise ValueError("thread_id must be a string when present")


def resolve_usage_tenant_id(
    actor: User,
    *,
    explicit_tenant_id: str | None = None,
    resource_tenant_id: str | None = None,
    known_tenant_ids: Collection[str] | None = None,
) -> str:
    """Resolve an authenticated actor to one tenant without implicit fallback.

    Ordinary actors always use their signed actor tenant and may not override
    it. A platform owner ignores any tenant on the owner account itself and must
    supply an already validated explicit tenant or a tenant-bound resource.
    Providing a one-item ``known_tenant_ids`` collection never selects it.
    """

    explicit = _optional_scope(explicit_tenant_id, "explicit_tenant_id")
    resource = _optional_scope(resource_tenant_id, "resource_tenant_id")

    if actor.role == Role.PLATFORM_OWNER:
        if explicit is not None and resource is not None and explicit != resource:
            raise UsageTenantScopeError(
                code="tenant_scope_mismatch",
                status_code=int(HTTPStatus.FORBIDDEN),
                detail="Explicit tenant scope does not match the resource tenant.",
            )
        selected = resource or explicit
        if selected is None:
            raise UsageTenantScopeError(
                code="tenant_scope_required",
                status_code=int(HTTPStatus.BAD_REQUEST),
                detail="Platform-owner usage requests require an explicit tenant scope.",
            )
    else:
        selected = _optional_scope(actor.tenant_id, "actor.tenant_id")
        if selected is None:
            raise UsageTenantScopeError(
                code="actor_tenant_required",
                status_code=int(HTTPStatus.FORBIDDEN),
                detail="The authenticated actor is not bound to a tenant.",
            )
        if explicit is not None and explicit != selected:
            raise UsageTenantScopeError(
                code="tenant_scope_mismatch",
                status_code=int(HTTPStatus.FORBIDDEN),
                detail="Explicit tenant scope does not match the authenticated actor.",
            )
        if resource is not None and resource != selected:
            raise UsageTenantScopeError(
                code="tenant_scope_mismatch",
                status_code=int(HTTPStatus.FORBIDDEN),
                detail="Resource tenant scope does not match the authenticated actor.",
            )

    if known_tenant_ids is not None and selected not in known_tenant_ids:
        raise UsageTenantScopeError(
            code="unknown_tenant",
            status_code=int(HTTPStatus.NOT_FOUND),
            detail="The selected tenant does not exist.",
        )
    return selected


def require_provider_execution(result: PermitAcquireResult) -> TenantUsagePermit:
    """Return the unique execution permit or refuse a replay before provider I/O."""

    if not result.acquired:
        raise UsageProviderExecutionRefused(result.permit)
    return result.permit


def map_usage_budget_error(error: UsageBudgetError) -> UsageBudgetHttpFailure:
    """Map accounting failures without leaking internal database/provider detail."""

    if isinstance(error, TemporaryAccessGrantExhausted):
        return UsageBudgetHttpFailure(
            status_code=int(HTTPStatus.TOO_MANY_REQUESTS),
            code="temporary_access_exhausted",
            detail=(
                "Your 30,000-token temporary access grant has been used. "
                "Ask a workspace administrator to convert your account for continued access."
            ),
            daily_token_limit=error.token_limit,
            reported_tokens=error.reported_tokens,
            budget_unit="tokens",
            budget_period="lifetime",
            limit_value=error.token_limit,
            reported_value=error.reported_tokens,
        )
    if isinstance(error, UsageBudgetExceeded):
        period_label = {
            "day": "daily",
            "week": "weekly",
            "month": "monthly",
        }[error.budget_period]
        measure_label = "provider-reported spend" if error.budget_unit == "usd" else "token budget"
        if error.accounting_overflowed:
            code = "usage_accounting_overflowed"
            detail = (
                f"The {period_label} {measure_label} reached its safe numeric limit. "
                f"Requests are blocked until the next UTC {error.budget_period}."
            )
        else:
            code = (
                "daily_token_budget_exceeded"
                if error.budget_period == "day" and error.budget_unit == "tokens"
                else f"{error.budget_period}_{error.budget_unit}_budget_exceeded"
            )
            scope = getattr(error, "scope", "tenant")
            if scope == "user":
                detail = (
                    f"Your {period_label} token budget has been reached. "
                    f"Requests are blocked until the next UTC {error.budget_period}."
                )
            elif scope == "group":
                detail = (
                    f"Your group's {period_label} token budget has been reached. "
                    f"Requests are blocked until the next UTC {error.budget_period}."
                )
            else:
                detail = (
                    f"The workspace {period_label} {measure_label} has been reached. "
                    f"Requests are blocked until the next UTC {error.budget_period}."
                )
        return UsageBudgetHttpFailure(
            status_code=int(HTTPStatus.TOO_MANY_REQUESTS),
            code=code,
            detail=detail,
            headers={"Retry-After": str(error.retry_after_seconds)},
            retry_after_seconds=error.retry_after_seconds,
            reset_at=error.reset_at,
            daily_token_limit=error.daily_token_limit,
            reported_tokens=error.reported_tokens,
            budget_unit=error.budget_unit,
            budget_period=error.budget_period,
            limit_value=error.limit_value,
            reported_value=error.reported_value,
        )
    if isinstance(error, UsageMeteringInvalid):
        return UsageBudgetHttpFailure(
            status_code=int(HTTPStatus.SERVICE_UNAVAILABLE),
            code="usage_metering_invalid",
            detail=(
                "Provider usage could not be recorded exactly. "
                "The request failed closed without estimating tokens."
            ),
        )
    if isinstance(error, UsagePermitConflict):
        return UsageBudgetHttpFailure(
            status_code=int(HTTPStatus.SERVICE_UNAVAILABLE),
            code="usage_accounting_conflict",
            detail=(
                "Usage accounting could not safely verify this request. "
                "No new provider execution is authorized."
            ),
        )
    if isinstance(error, UsageBudgetUnavailable):
        return UsageBudgetHttpFailure(
            status_code=int(HTTPStatus.SERVICE_UNAVAILABLE),
            code="usage_accounting_unavailable",
            detail="Tenant usage accounting is unavailable, so the request failed closed.",
        )
    raise TypeError(f"Unsupported usage-budget error type: {type(error).__name__}")


class UsageBudgetRequestContext:
    """One admitted logical request with any number of provider child events."""

    def __init__(
        self,
        *,
        repository: UsageBudgetRepositoryPort,
        acquisition: PermitAcquireResult,
        actor: User,
        tenant_id: str,
        principals: Sequence[tuple[str, str]] | None = None,
    ) -> None:
        permit = require_provider_execution(acquisition)
        if permit.tenant_id != tenant_id:
            raise UsagePermitConflict("Acquired usage permit does not match resolved tenant scope.")
        if permit.status != "started":
            raise UsagePermitConflict(
                f"Acquired usage permit is not executable from status {permit.status!r}."
            )
        self._repository = repository
        self._permit = permit
        self._tenant_id = tenant_id
        self._user_id = actor.id
        self._user_name = actor.display_name
        self._user_role = actor.role.value
        self._requires_exact_metering = actor.role == Role.TEMP_USER
        self._principals: tuple[tuple[str, str], ...] = tuple(
            principals
            if principals is not None
            else (("user", actor.id), *(("group", group_id) for group_id in actor.group_ids))
        )
        self._status: RuntimeStatus = "active"
        self._completion_hashes: set[str] = set()

    @property
    def permit(self) -> TenantUsagePermit:
        return self._permit

    @property
    def tenant_id(self) -> str:
        return self._tenant_id

    @property
    def status(self) -> RuntimeStatus:
        return self._status

    @property
    def settled_child_count(self) -> int:
        return len(self._completion_hashes)

    def settle_provider_child(
        self,
        *,
        completion_id: str,
        usage: Mapping[str, Any] | None,
        attribution: ProviderUsageAttribution,
        completed_at: datetime | None = None,
    ) -> CompletionSettlement:
        """Persist one successful child call before any downstream continuation."""

        self._require_active()
        if self._requires_exact_metering and not normalize_reported_usage(usage).is_metered:
            raise UsageMeteringInvalid(
                "Temporary access requires exact provider-reported token usage."
            )
        template = UsageRecord(
            id=f"pending:{completion_id}",
            tenant_id=self._tenant_id,
            user_id=self._user_id,
            user_name=self._user_name,
            user_role=self._user_role,
            model_id=attribution.model_id,
            provider_name=attribution.provider_name,
            surface=attribution.surface,
            message_count=attribution.message_count,
            thread_id=attribution.thread_id,
        )
        settlement = self._repository.record_provider_completion(
            permit_id=self._permit.permit_id,
            completion_id=completion_id,
            usage=usage,
            usage_record=template,
            principals=self._principals,
            completed_at=completed_at,
        )
        self._completion_hashes.add(settlement.event.completion_id_hash)
        return settlement

    def complete_success(self, *, now: datetime | None = None) -> TenantUsagePermit:
        """Close successfully only after at least one provider child settled."""

        self._require_active()
        if not self._completion_hashes:
            raise UsageRequestStateError(
                "A usage-budget request cannot complete without a settled provider child."
            )
        permit = self._repository.complete_permit(self._permit.permit_id, now=now)
        self._mark_terminal("completed", permit)
        return permit

    def fail(self, *, now: datetime | None = None) -> TenantUsagePermit:
        """Close failed without rolling back already committed child events."""

        self._require_active()
        permit = self._repository.fail_permit(self._permit.permit_id, now=now)
        self._mark_terminal("failed", permit)
        return permit

    def abandon(self, *, now: datetime | None = None) -> TenantUsagePermit:
        """Close abandoned without rolling back already committed child events."""

        self._require_active()
        permit = self._repository.abandon_permit(self._permit.permit_id, now=now)
        self._mark_terminal("abandoned", permit)
        return permit

    def _require_active(self) -> None:
        if self._status != "active":
            raise UsageRequestStateError(
                f"Usage-budget request is already terminal ({self._status})."
            )

    def _mark_terminal(
        self,
        expected_status: RuntimeTerminalStatus,
        permit: TenantUsagePermit,
    ) -> None:
        if permit.status != expected_status:
            raise UsagePermitConflict(
                f"Usage repository returned {permit.status!r} while closing as {expected_status!r}."
            )
        self._permit = permit
        self._status = expected_status


class TenantUsageBudgetOrchestrator:
    """Acquire one execution right and create a request accounting context."""

    def __init__(self, repository: UsageBudgetRepositoryPort) -> None:
        self._repository = repository

    def begin_request(
        self,
        *,
        actor: User,
        request_id: str,
        explicit_tenant_id: str | None = None,
        resource_tenant_id: str | None = None,
        known_tenant_ids: Collection[str] | None = None,
        now: datetime | None = None,
    ) -> UsageBudgetRequestContext:
        tenant_id = resolve_usage_tenant_id(
            actor,
            explicit_tenant_id=explicit_tenant_id,
            resource_tenant_id=resource_tenant_id,
            known_tenant_ids=known_tenant_ids,
        )
        principals: tuple[tuple[str, str], ...] = (
            ("user", actor.id),
            *(("group", group_id) for group_id in actor.group_ids),
        )
        hard_token_limits = (
            {("user", actor.id): TEMP_USER_TOKEN_LIMIT}
            if actor.role == Role.TEMP_USER
            else None
        )
        result = self._repository.acquire_permit(
            tenant_id=tenant_id,
            request_id=request_id,
            principals=principals,
            hard_token_limits=hard_token_limits,
            now=now,
        )
        return UsageBudgetRequestContext(
            repository=self._repository,
            acquisition=result,
            actor=actor,
            tenant_id=tenant_id,
            principals=principals,
        )


def _optional_scope(value: str | None, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise UsageTenantScopeError(
            code="invalid_tenant_scope",
            status_code=int(HTTPStatus.BAD_REQUEST),
            detail=f"{label} must be a string when present.",
        )
    normalized = value.strip()
    return normalized or None
