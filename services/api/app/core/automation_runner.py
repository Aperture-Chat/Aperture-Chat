"""Automation chain execution shared by the run route and the scheduler.

Extracted from the run route so scheduled runs execute exactly the same code
path as "Run now": real gateway calls, real model-access checks, and honest
run bookkeeping. Nothing here simulates output or fabricates success.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from fastapi import HTTPException, status

from app.core import clock
from app.core.model_gateway import (
    DEFAULT_COMPLETION_TOKEN_BUDGET,
    ModelGatewayClient,
    ModelGatewayRoute,
    resolve_model_route,
)
from app.core.policy import assert_model_access
from app.core.web_search import OPENROUTER_WEB_SEARCH_TOOL
from app.core.usage_budget import UsageBudgetError, UsageMeteringInvalid, new_accounting_id
from app.core.usage_budget_runtime import (
    ProviderUsageAttribution,
    TenantUsageBudgetOrchestrator,
    UsageBudgetRequestContext,
    UsageProviderExecutionRefused,
    UsageTenantScopeError,
    map_usage_budget_error,
)
from app.models.schemas import Automation, ModelConfig, User
from app.repositories.identity_config_sql import IdentityConfigSnapshotConflict
from app.repositories.seed import SeedStore

logger = logging.getLogger("aperture.automations")

# How many times run bookkeeping re-applies its fields after losing a
# relational-digest CAS race to a concurrent writer.
SNAPSHOT_CONFLICT_RETRIES = 3


def persist_automation_fields(
    store: SeedStore, automation_id: str, fields: dict[str, object]
) -> Automation | None:
    """Apply bookkeeping fields to an automation and persist, surviving races.

    Under SQL authority, ``save_runtime_state`` performs a compare-and-swap on
    the relational digest. Losing that race to a concurrent writer reloads the
    winning generation into the cache and raises — which previously turned a
    finished multi-step run into "failed unexpectedly" at the very last write.
    Bookkeeping fields are safe to re-apply to the fresh record, so retry a
    bounded number of times. Returns ``None`` when the automation was deleted
    by the winning writer: bookkeeping must never resurrect it.
    """
    last_conflict: IdentityConfigSnapshotConflict | None = None
    for _ in range(SNAPSHOT_CONFLICT_RETRIES):
        current = store.automations.get(automation_id)
        if current is None:
            return None
        updated = current.model_copy(update=fields)
        store.automations[automation_id] = updated
        try:
            store.save_runtime_state()
        except IdentityConfigSnapshotConflict as exc:
            last_conflict = exc
            logger.warning(
                "Automation %s bookkeeping lost a snapshot write race; retrying "
                "against the reloaded cache.",
                automation_id,
            )
            continue
        return updated
    assert last_conflict is not None
    raise last_conflict

# Chain steps get the same completion headroom as a chat turn. The previous
# fixed 2000-token ceiling silently starved reasoning models: hidden reasoning
# tokens are billed against this budget, so a step could spend the entire
# allowance thinking and return an empty answer that still looked successful.
AUTOMATION_STEP_TOKEN_BUDGET = DEFAULT_COMPLETION_TOKEN_BUDGET
LONG_CONTEXT_STEP_TOKEN_BUDGET = 12000
LONG_CONTEXT_WINDOW_TOKENS = 64000
# Provider finish reasons meaning "I ran out of room", not "I finished".
TRUNCATED_FINISH_REASONS = {"length", "max_tokens", "max_completion_tokens", "model_length"}


def _step_token_budget(model: ModelConfig) -> int:
    """Completion headroom for one chain step, mirroring the chat pipeline."""
    context_window = model.context_window or 0
    if context_window >= LONG_CONTEXT_WINDOW_TOKENS:
        return LONG_CONTEXT_STEP_TOKEN_BUDGET
    return AUTOMATION_STEP_TOKEN_BUDGET


def _step_web_search_tools(
    store: SeedStore, route: ModelGatewayRoute
) -> list[dict[str, Any]] | None:
    """OpenRouter's server-side web search tool for OpenRouter chain steps.

    Same governance rule as chat: the admin Web Search connector is the kill
    switch, and a missing record means the keyless platform default (on).
    Non-OpenRouter routes run without live search here — the platform search
    engine is a chat-request pipeline and is not wired into chain steps.
    """
    web_connector = store.connectors.get("web")
    web_config = next(
        (config for config in store.connector_configs.values() if config.connector_id == "web"),
        None,
    )
    disabled = (
        web_connector is not None
        and not (web_connector.platform_enabled and web_connector.tenant_enabled)
    ) or (web_config is not None and not web_config.enabled)
    if disabled:
        return None
    if route.provider_kind.strip().lower() != "openrouter":
        return None
    tool = dict(OPENROUTER_WEB_SEARCH_TOOL)
    parameters = tool.get("parameters")
    if isinstance(parameters, dict):
        tool["parameters"] = dict(parameters)
    return [tool]


def _web_sources_from_annotations(message: Mapping[str, Any]) -> list[tuple[str, str]]:
    """(title, url) pairs from OpenRouter url_citation annotations, deduped."""
    annotations = message.get("annotations")
    if not isinstance(annotations, list):
        return []
    sources: list[tuple[str, str]] = []
    seen: set[str] = set()
    for annotation in annotations:
        if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
            continue
        raw = annotation.get("url_citation")
        if not isinstance(raw, dict):
            raw = annotation
        url = str(raw.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        title = str(raw.get("title") or "").strip() or url
        sources.append((title, url))
    return sources


def execute_chain(
    store: SeedStore,
    automation: Automation,
    actor: User,
    client: ModelGatewayClient,
    usage_budget_orchestrator: TenantUsageBudgetOrchestrator | None = None,
    *,
    prompt_override: str | None = None,
) -> tuple[list[dict[str, object]], str]:
    """Run each step in order, feeding one step's output into the next.

    ``prompt_override`` replaces the stored prompt as the first step's input
    for this run only (the chat ">" shortcut sends the typed message here);
    scheduled fires always use the stored prompt.

    Raises HTTPException for model/access/route problems and lets
    ModelGatewayError propagate for provider failures; the caller decides how
    to record and surface each.
    """
    orchestrator = usage_budget_orchestrator or TenantUsageBudgetOrchestrator(
        store.usage_budget_repository
    )
    transcript: list[dict[str, object]] = []
    initial = automation.prompt if prompt_override is None else prompt_override
    carry = initial.strip()
    for index, step in enumerate(automation.steps, start=1):
        model = store.models.get(step.model_id)
        if model is None:
            raise HTTPException(
                status_code=404, detail=f"Step {index} references an unknown model."
            )
        if model.tenant_id is not None and model.tenant_id != automation.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Step {index} references a model outside the automation tenant.",
            )
        assert_model_access(actor, model)
        route = resolve_model_route(store, model, tenant_id=automation.tenant_id)
        if not route.configured:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Step {index} ({model.name}) is not runnable: {route.status_message}",
            )
        messages: list[dict[str, str]] = []
        instruction = step.instruction.strip()
        if instruction:
            messages.append({"role": "system", "content": instruction})
        messages.append({"role": "user", "content": carry or "Begin the automation."})
        web_tools = _step_web_search_tools(store, route)
        try:
            usage_context = orchestrator.begin_request(
                actor=actor,
                request_id=new_accounting_id(),
                resource_tenant_id=automation.tenant_id,
                known_tenant_ids=store.tenants.keys(),
            )
        except (UsageBudgetError, UsageProviderExecutionRefused, UsageTenantScopeError) as exc:
            raise _usage_budget_http_exception(exc) from exc

        try:
            # Allocate the provider-child identifier only after admission, but
            # inside the permit cleanup boundary. Identifier generation is a
            # prerequisite to provider I/O and must not be able to strand an
            # active permit if it unexpectedly fails.
            completion_id = new_accounting_id()
            payload = client.complete(
                route=route,
                messages=messages,
                max_tokens=_step_token_budget(model),
                tools=web_tools,
            )
        except Exception as exc:
            close_error = _fail_usage_context(usage_context)
            if close_error is not None:
                raise _usage_budget_http_exception(close_error) from exc
            raise

        try:
            usage_context.settle_provider_child(
                completion_id=completion_id,
                usage=_raw_provider_usage(payload),
                attribution=ProviderUsageAttribution(
                    model_id=model.id,
                    provider_name=route.provider_name,
                    surface="automation",
                    message_count=1,
                ),
            )
            choices = payload.get("choices") or []
            content = ""
            truncated = False
            if choices:
                message = choices[0].get("message") or {}
                raw = message.get("content")
                content = raw if isinstance(raw, str) else ""
                truncated = choices[0].get("finish_reason") in TRUNCATED_FINISH_REASONS
                sources = _web_sources_from_annotations(message)
                if sources and content:
                    content += "\n\nSources:\n" + "\n".join(
                        f"- [{title}]({url})" for title, url in sources
                    )
            transcript.append(
                {
                    "step": index,
                    "model_id": model.id,
                    "model_name": model.name,
                    "instruction": step.instruction,
                    "output": content,
                    "truncated": truncated,
                }
            )
            carry = content
            usage_context.complete_success()
        except UsageBudgetError as exc:
            _fail_usage_context(usage_context)
            # The budget guard fails closed on counters it cannot record
            # exactly, but the caller only sees a generic 503. Log the exact
            # provider payload so a rejection is diagnosable after the fact.
            logger.warning(
                "Automation %s step %d: provider usage rejected (%s). Raw usage: %r",
                automation.id,
                index,
                exc,
                payload.get("usage") if isinstance(payload, Mapping) else payload,
            )
            raise _usage_budget_http_exception(exc) from exc
        except Exception as exc:
            close_error = _fail_usage_context(usage_context)
            if close_error is not None:
                raise _usage_budget_http_exception(close_error) from exc
            raise

        # A step that produced no text cannot feed the next step, and reporting
        # the run as a success would show an empty answer as if it worked. Fail
        # with the real reason instead. Usage is already settled above, so the
        # provider work stays billed and audited honestly.
        if not content.strip():
            if truncated:
                detail = (
                    f"Step {index} ({model.name}) hit its "
                    f"{_step_token_budget(model):,}-token limit before writing an answer — "
                    "reasoning consumed the whole budget. Shorten the step instruction or "
                    "split the work across more steps."
                )
            else:
                detail = f"Step {index} ({model.name}) returned an empty response."
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)
    return transcript, carry


def _raw_provider_usage(payload: object) -> Mapping[str, Any] | None:
    # A provider can return any valid JSON value with HTTP 200. The provider
    # child still happened, so a non-object response must first settle as an
    # explicitly unmetered completion before response parsing rejects it.
    if not isinstance(payload, Mapping):
        return None
    usage = payload.get("usage")
    if usage is None:
        return None
    if not isinstance(usage, Mapping):
        raise UsageMeteringInvalid("Provider usage must be an object when present.")
    return usage


def _fail_usage_context(context: UsageBudgetRequestContext) -> UsageBudgetError | None:
    if context.status != "active":
        return None
    try:
        context.fail()
    except UsageBudgetError as exc:
        return exc
    return None


def _usage_budget_http_exception(
    error: UsageBudgetError | UsageProviderExecutionRefused | UsageTenantScopeError,
) -> HTTPException:
    if isinstance(error, UsageTenantScopeError):
        return HTTPException(status_code=error.status_code, detail=error.detail)
    if isinstance(error, UsageProviderExecutionRefused):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Usage accounting could not safely verify this request. "
                "No new provider execution is authorized."
            ),
        )
    failure = map_usage_budget_error(error)
    return HTTPException(
        status_code=failure.status_code,
        detail=failure.detail,
        headers=dict(failure.headers),
    )


def record_run_success(
    store: SeedStore,
    automation: Automation,
    actor: User,
    *,
    scheduled: bool = False,
) -> None:
    run_at = clock.now_iso()
    automation.last_run_at = run_at
    automation.last_run_status = "succeeded"
    persist_automation_fields(
        store,
        automation.id,
        {"last_run_at": run_at, "last_run_status": "succeeded"},
    )
    # The audit trail lives in application state, not the identity snapshot:
    # the run happened, so it is recorded even if the automation was deleted
    # concurrently.
    store.record_audit(
        actor,
        "automation.run",
        automation.id,
        {
            "surface": automation.surface,
            "executed_at": run_at,
            "steps": len(automation.steps),
            "scheduled": scheduled,
        },
    )


def record_run_failure(
    store: SeedStore,
    automation: Automation,
    actor: User,
    error: str,
    *,
    scheduled: bool = False,
) -> None:
    run_at = clock.now_iso()
    automation.last_run_at = run_at
    automation.last_run_status = f"failed: {error}"
    persist_automation_fields(
        store,
        automation.id,
        {"last_run_at": run_at, "last_run_status": f"failed: {error}"},
    )
    store.record_audit(
        actor,
        "automation.run_failed",
        automation.id,
        {
            "surface": automation.surface,
            "executed_at": run_at,
            "error": error,
            "scheduled": scheduled,
        },
    )
