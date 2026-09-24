"""Automation chain execution shared by the run route and the scheduler.

Extracted from the run route so scheduled runs execute exactly the same code
path as "Run now": real gateway calls, real model-access checks, and honest
run bookkeeping. Nothing here simulates output or fabricates success.

A step may name a plain model or a workspace agent profile. An agent step
brings the same instructions chat would: its system and meta prompts, prompt
templates, skill files, Hermes memories, and passages retrieved from its
knowledge bases. Tools and MCP servers need an interactive approval flow and
run only in chat, never inside an unattended chain.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, status

from app.core import clock, hermes
from app.core.automation_schedule import (
    Schedule,
    next_occurrence,
    parse_instant,
    resolve_zone,
)
from app.core.markdown_document import markdown_to_document_html
from app.core.model_gateway import (
    DEFAULT_COMPLETION_TOKEN_BUDGET,
    ModelGatewayClient,
    ModelGatewayRoute,
    resolve_model_route,
)
from app.core.policy import (
    assert_agent_profile_access,
    assert_model_access,
    hermes_companion_allowed,
    is_workspace_agent_profile,
)
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
from app.models.schemas import (
    Automation,
    AutomationRunRecord,
    ChatMessage,
    ChatThread,
    ModelConfig,
    User,
)
from app.repositories.identity_config_sql import IdentityConfigSnapshotConflict
from app.repositories.seed import SeedStore

logger = logging.getLogger("aperture.automations")

# How many times run bookkeeping re-applies its fields after losing a
# relational-digest CAS race to a concurrent writer.
SNAPSHOT_CONFLICT_RETRIES = 3
# Run history kept per automation, newest first.
RUN_HISTORY_LIMIT = 10
# Knowledge passages an agent step retrieves, and how much of each it quotes.
AGENT_STEP_KNOWLEDGE_LIMIT = 4
AGENT_STEP_PASSAGE_CHARS = 1200
AGENT_STEP_QUERY_CHARS = 2000
# Bytes of instruction text quoted from each template or skill file.
AGENT_STEP_EXCERPT_CHARS = 4000
DRAFT_TITLE_CHARS = 200


def persist_automation_fields(
    store: SeedStore,
    automation_id: str,
    fields: dict[str, object] | Callable[[Automation], dict[str, object]],
) -> Automation | None:
    """Apply bookkeeping fields to an automation and persist, surviving races.

    Under SQL authority, ``save_runtime_state`` performs a compare-and-swap on
    the relational digest. Losing that race to a concurrent writer reloads the
    winning generation into the cache and raises — which previously turned a
    finished multi-step run into "failed unexpectedly" at the very last write.
    Bookkeeping fields are safe to re-apply to the fresh record, so retry a
    bounded number of times. Returns ``None`` when the automation was deleted
    by the winning writer: bookkeeping must never resurrect it. ``fields`` may
    be a function of the current record (run history appends to whatever the
    winning writer left), recomputed on every retry.
    """
    last_conflict: IdentityConfigSnapshotConflict | None = None
    for _ in range(SNAPSHOT_CONFLICT_RETRIES):
        current = store.automations.get(automation_id)
        if current is None:
            return None
        update = fields(current) if callable(fields) else fields
        updated = current.model_copy(update=update)
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


def _excerpt(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else f"{text[: limit - 3].rstrip()}..."


def _step_context(
    store: SeedStore,
    actor: User,
    model: ModelConfig,
    step_input: str,
    *,
    step_label: str,
) -> tuple[list[str], list[str]]:
    """System sections a step's model or agent contributes, plus source names.

    Mirrors chat's runtime prompt: a model's own system and meta prompts and
    its prompt templates and skill files always apply; an agent profile also
    brings Hermes memories and retrieves from its knowledge bases. Anything
    chat would refuse (a disabled template, a knowledge base the actor cannot
    read) fails the step with that reason instead of silently running without
    it; a turned-off knowledge base is skipped, as chat does.
    """
    # Late import: the chat route owns the canonical resolvers and access
    # checks; importing lazily keeps core free of a load-time route import.
    from app.routes.chat import (
        _resolve_knowledge_config,
        _resolve_prompt_templates,
        _resolve_skill_files,
    )

    is_agent = is_workspace_agent_profile(model)
    sections: list[str] = []
    sources: list[str] = []
    try:
        if is_agent:
            assert_agent_profile_access(actor, model)
        if model.system_prompt and model.system_prompt.strip():
            sections.append(model.system_prompt.strip())
        if model.meta_prompt and model.meta_prompt.strip():
            sections.append(model.meta_prompt.strip())
        templates = _resolve_prompt_templates(store, actor, list(model.prompt_template_ids))
        for template in templates:
            if template.content.strip():
                sections.append(
                    f"Prompt template — {template.name}:\n"
                    f"{_excerpt(template.content, AGENT_STEP_EXCERPT_CHARS)}"
                )
        skills = _resolve_skill_files(store, actor, list(model.skill_file_ids))
        for skill in skills:
            if skill.content.strip():
                label = f"{skill.name} v{skill.version}" if skill.version else skill.name
                sections.append(
                    f"Skill file — {label}:\n{_excerpt(skill.content, AGENT_STEP_EXCERPT_CHARS)}"
                )
        if not is_agent:
            return sections, sources
        if model.agentic_companion == hermes.HERMES_COMPANION and hermes_companion_allowed(
            actor, store.groups
        ):
            memories = [
                memory.content.strip()
                for memory in hermes.recent_memories(store, model.id)
                if memory.content.strip()
            ]
            if memories:
                sections.append(
                    "Memories saved from earlier conversations with this agent "
                    "(apply them where relevant):\n" + "\n".join(f"- {m}" for m in memories)
                )
        # Like chat, an agent's turned-off knowledge base is skipped rather
        # than failing the run; unknown or unshared bases still refuse.
        knowledge_ids = [
            kid
            for kid in dict.fromkeys(model.knowledge_config_ids)
            if (config := store.knowledge_configs.get(kid)) is None or config.enabled
        ]
        if knowledge_ids:
            configs = [_resolve_knowledge_config(store, actor, kid) for kid in knowledge_ids]
            query = (step_input or "").strip()[:AGENT_STEP_QUERY_CHARS]
            hits = (
                store.retrieve_knowledge(
                    actor,
                    [config.id for config in configs],
                    query,
                    limit=AGENT_STEP_KNOWLEDGE_LIMIT,
                )
                if query
                else []
            )
            seen: set[str] = set()
            passages: list[str] = []
            for hit in hits:
                if hit.id in seen:
                    continue
                seen.add(hit.id)
                passages.append(
                    f"[K{len(passages) + 1}] {hit.source_name}: "
                    f"{_excerpt(' '.join(hit.text.split()), AGENT_STEP_PASSAGE_CHARS)}"
                )
                if hit.source_name not in sources:
                    sources.append(hit.source_name)
            if passages:
                sections.append(
                    "Reference passages retrieved from this agent's knowledge. Ground your "
                    "answer in them where relevant and cite them as [K1], [K2], ...:\n"
                    + "\n".join(passages)
                )
    except HTTPException as exc:
        raise HTTPException(
            status_code=exc.status_code, detail=f"{step_label}: {exc.detail}"
        ) from exc
    return sections, sources


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
        step_input = carry or "Begin the automation."
        context_sections, knowledge_sources = _step_context(
            store, actor, model, step_input, step_label=f"Step {index} ({model.name})"
        )
        instruction = step.instruction.strip()
        system_sections = [*context_sections]
        if instruction:
            # The step's own instruction is the most specific direction, so it
            # comes last, after the agent's standing instructions.
            system_sections.append(instruction)
        if automation.surface == "draft" and index == len(automation.steps):
            system_sections.append(
                "Your answer becomes a new draft document. Write it as a complete, "
                "well-structured document in Markdown with a title heading."
            )
        messages: list[dict[str, str]] = []
        if system_sections:
            messages.append({"role": "system", "content": "\n\n".join(system_sections)})
        messages.append({"role": "user", "content": step_input})
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
                    "agent": is_workspace_agent_profile(model),
                    "knowledge_sources": knowledge_sources,
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


# Scheduled failures in a row before the scheduler pauses an automation.
AUTO_PAUSE_FAILURE_LIMIT = 3


def _with_history(
    current: Automation,
    record: AutomationRunRecord,
    *,
    failed_scheduled: bool,
) -> dict[str, object]:
    """Bookkeeping update for one finished run, applied to the fresh record."""
    status_text = (
        "succeeded"
        if record.status == "succeeded"
        else f"{record.status}: {record.detail}" if record.detail else record.status
    )
    failures = (
        current.consecutive_failures + 1
        if failed_scheduled
        else 0 if record.status == "succeeded" else current.consecutive_failures
    )
    update: dict[str, object] = {
        "last_run_at": record.at,
        "last_run_status": status_text,
        "run_history": [record, *current.run_history][:RUN_HISTORY_LIMIT],
        "consecutive_failures": failures,
    }
    if failed_scheduled and current.enabled and failures >= AUTO_PAUSE_FAILURE_LIMIT:
        # A chain that keeps failing on schedule spends provider budget on
        # every fire and floods the audit log; pause it and say why.
        update["enabled"] = False
        update["last_run_status"] = (
            f"{status_text} — paused after {failures} failed scheduled runs in a row"
        )
    return update


def record_run_success(
    store: SeedStore,
    automation: Automation,
    actor: User,
    *,
    scheduled: bool = False,
    trigger: str | None = None,
    duration_ms: int | None = None,
    thread_id: str | None = None,
    draft_id: str | None = None,
) -> Automation | None:
    run_at = clock.now_iso()
    record = AutomationRunRecord(
        at=run_at,
        status="succeeded",
        trigger=trigger or ("scheduled" if scheduled else "manual"),
        duration_ms=duration_ms,
        steps=len(automation.steps),
        thread_id=thread_id,
        draft_id=draft_id,
    )
    automation.last_run_at = run_at
    automation.last_run_status = "succeeded"
    persisted = persist_automation_fields(
        store,
        automation.id,
        lambda current: _with_history(current, record, failed_scheduled=False),
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
            "trigger": record.trigger,
            "thread_id": thread_id,
            "draft_id": draft_id,
        },
    )
    return persisted


def record_run_failure(
    store: SeedStore,
    automation: Automation,
    actor: User,
    error: str,
    *,
    scheduled: bool = False,
    trigger: str | None = None,
    duration_ms: int | None = None,
) -> Automation | None:
    run_at = clock.now_iso()
    record = AutomationRunRecord(
        at=run_at,
        status="failed",
        trigger=trigger or ("scheduled" if scheduled else "manual"),
        detail=error,
        duration_ms=duration_ms,
        steps=len(automation.steps),
    )
    automation.last_run_at = run_at
    automation.last_run_status = f"failed: {error}"
    persisted = persist_automation_fields(
        store,
        automation.id,
        lambda current: _with_history(current, record, failed_scheduled=scheduled),
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
            "trigger": record.trigger,
        },
    )
    if persisted is not None and scheduled and not persisted.enabled and automation.enabled:
        store.record_audit(
            actor,
            "automation.auto_paused",
            automation.id,
            {"consecutive_failures": persisted.consecutive_failures, "last_error": error},
        )
    return persisted


def record_run_skipped(
    store: SeedStore,
    automation: Automation,
    reason: str,
) -> Automation | None:
    """A scheduled fire that could not execute (for example, inactive creator)."""
    record = AutomationRunRecord(
        at=clock.now_iso(),
        status="skipped",
        trigger="scheduled",
        detail=reason,
        steps=len(automation.steps),
    )
    return persist_automation_fields(
        store,
        automation.id,
        lambda current: {
            "last_run_at": record.at,
            "last_run_status": f"skipped: {reason}",
            "run_history": [record, *current.run_history][:RUN_HISTORY_LIMIT],
        },
    )


# --- Delivery ------------------------------------------------------------------


def _local_stamp(automation: Automation, now: datetime, *, with_time: bool = False) -> str:
    """The run time in the automation's own zone, so titles match its schedule."""
    zone = resolve_zone(automation.timezone) or resolve_zone(None)
    local = now.astimezone(zone)
    if not with_time:
        return local.strftime("%b %d, %Y")
    return f"{local.strftime('%b %d, %Y %H:%M')} {local.tzname() or 'UTC'}"


def delivery_thread(
    automation: Automation,
    owner: User,
    transcript: list[dict[str, object]],
    final_output: str,
    now: datetime,
    *,
    prompt: str | None = None,
    scheduled: bool = True,
) -> ChatThread:
    """A chat thread carrying a run's real output to its owner."""
    stamp = _local_stamp(automation, now, with_time=True)
    iso = now.isoformat()
    metadata = {
        "automation_id": automation.id,
        "automation_name": automation.name,
        "scheduled": scheduled,
    }
    return ChatThread(
        id=f"thread-automation-{uuid4()}",
        tenant_id=automation.tenant_id,
        owner_user_id=owner.id,
        title=f"{automation.name} — {stamp}",
        model_id=automation.steps[-1].model_id if automation.steps else "",
        group_id="",
        updated_at=iso,
        messages=[
            ChatMessage(
                id=f"msg-{uuid4()}",
                role="user",
                content=(prompt if prompt is not None else automation.prompt)
                or "Begin the automation.",
                createdAt=stamp,
                createdAtIso=iso,
                metadata=metadata,
            ),
            ChatMessage(
                id=f"msg-{uuid4()}",
                role="assistant",
                content=final_output,
                createdAt=stamp,
                createdAtIso=iso,
                metadata={**metadata, "steps": len(transcript)},
            ),
        ],
    )


def deliver_run_output(
    store: SeedStore,
    automation: Automation,
    owner: User,
    transcript: list[dict[str, object]],
    final_output: str,
    *,
    prompt: str | None = None,
    scheduled: bool = True,
) -> tuple[str | None, str | None]:
    """Deliver a finished run as a new chat thread or draft; returns their ids.

    Delivery is part of the run: a draft or thread that cannot be saved fails
    the run rather than reporting success with nowhere to find the output.
    """
    now = clock.now()
    if automation.surface == "draft":
        # Late import: the draft repository pulls in the SQL session stack.
        from app.repositories.matters import MatterDraftRepository

        title = f"{automation.name} — {_local_stamp(automation, now)}"[:DRAFT_TITLE_CHARS]
        repository = MatterDraftRepository(store.application_state_repository.engine)
        snapshot = repository.create_draft(
            tenant_id=automation.tenant_id,
            owner_user_id=owner.id,
            title=title,
            content=markdown_to_document_html(final_output),
            kind="document",
        )
        return None, snapshot.document.id
    thread = store.save_chat_thread(
        delivery_thread(
            automation, owner, transcript, final_output, now, prompt=prompt, scheduled=scheduled
        )
    )
    return thread.id, None


def with_next_run(automation: Automation, now: datetime | None = None) -> Automation:
    """A copy carrying `next_run_at` for display; None when nothing is scheduled."""
    upcoming: datetime | None = None
    schedule = Schedule.of(automation)
    if automation.enabled and automation.steps:
        if automation.trigger_type == "once":
            # A one-time run fires at run_at, or on the next pass if run_at has
            # passed unfired; once fired it has nothing further scheduled.
            zone = resolve_zone(schedule.timezone)
            if not automation.last_scheduled_fire_at and zone is not None:
                upcoming = parse_instant(schedule.run_at, zone)
        else:
            upcoming = next_occurrence(schedule, now or clock.now())
    return automation.model_copy(
        update={"next_run_at": upcoming.isoformat() if upcoming is not None else None}
    )
