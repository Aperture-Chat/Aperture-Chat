"""Bounded asynchronous execution for Review Grid cells.

Each cell retrieves only chunks from its selected document, calls exactly the
matrix's selected model, and commits an honest terminal state.  Review usage
and audit events deliberately go through the repository surface; live
acceptance remains blocked until A4 routes those two high-volume records to
transactional SQL rather than ``runtime_state.json``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from threading import RLock
from typing import Any, Callable

from app.core.content_filters import (
    ContentRuleMatch,
    evaluate_content_filters,
    resolve_model_content_filters,
    validate_content_filter_rules,
)
from app.core.model_gateway import (
    ModelGatewayClient,
    ModelGatewayConfigurationError,
    ModelGatewayError,
    ModelGatewayRoute,
    get_model_gateway_client,
    resolve_model_route,
)
from app.core.policy import assert_model_access
from app.core.review_store import ReviewConflict, ReviewNotFound, ReviewStore
from app.core.usage_budget import UsageBudgetError, UsageMeteringInvalid, new_accounting_id
from app.core.usage_budget_runtime import (
    ProviderUsageAttribution,
    TenantUsageBudgetOrchestrator,
    UsageBudgetRequestContext,
    UsageProviderExecutionRefused,
    UsageTenantScopeError,
    map_usage_budget_error,
)
from app.models.review import (
    MAX_REVIEW_ANSWER_CHARS,
    ReviewCell,
    ReviewCitation,
    ReviewColumn,
    ReviewMatrix,
    ReviewRunAccepted,
)
from app.models.schemas import ContentFilter, KnowledgeChunk, ModelConfig, Role, User
from app.repositories.seed import SeedStore


REVIEW_CONTEXT_CHUNKS = 5
REVIEW_MAX_OUTPUT_TOKENS = 2_048
MAX_REVIEW_CONCURRENCY = 8
# Models answering in or after CJK context emit full-width brackets -- the same
# model that writes "[K1]" here will write "【K1】" elsewhere. Matching only the
# ASCII form threw away correct answers as uncited, which made review grids look
# entirely broken on short documents while working on long ones.
_CITATION_PATTERN = re.compile(r"[\[［【]\s*K\s*(\d+)\s*[\]］】]")


class ReviewRunConfigurationError(RuntimeError):
    """The selected model or its enforcement policy cannot run safely."""


class ReviewCellExecutionError(RuntimeError):
    """A cell cannot produce a deliverable answer."""


@dataclass(slots=True)
class _UsageContextSlot:
    """A future-visible reference populated when a queued cell is admitted."""

    context: UsageBudgetRequestContext | None = None


class ReviewRunner:
    def __init__(
        self,
        review_store: ReviewStore,
        seed_store: SeedStore,
        *,
        max_concurrency: int = 3,
        gateway_factory: Callable[[], ModelGatewayClient] = get_model_gateway_client,
        activity_writes_sql_only: bool = False,
        usage_budget_orchestrator: TenantUsageBudgetOrchestrator | None = None,
    ) -> None:
        self.review_store = review_store
        self.seed_store = seed_store
        self.max_concurrency = max(1, min(max_concurrency, MAX_REVIEW_CONCURRENCY))
        self._gateway_factory = gateway_factory
        # Matrix/cell state already lives in review SQLite. Audit, usage, and
        # the Elastic outbox must also be SQL-backed before a run is accepted;
        # an environment flag alone is not sufficient proof of that capability.
        self._activity_writes_sql_only = activity_writes_sql_only
        self._usage_budget_orchestrator = (
            usage_budget_orchestrator
            or TenantUsageBudgetOrchestrator(seed_store.usage_budget_repository)
        )
        self._executor = ThreadPoolExecutor(
            max_workers=self.max_concurrency,
            thread_name_prefix="aperture-review",
        )
        self._futures: set[Future[None]] = set()
        self._future_matrix_ids: dict[Future[None], str] = {}
        self._future_usage_slots: dict[Future[None], _UsageContextSlot] = {}
        self._futures_lock = RLock()
        self._transition_lock = RLock()
        self._cancelled_matrix_ids: set[str] = set()
        self._closed = False
        self._aborting = False

    def start_matrix(self, matrix_id: str, actor: User) -> ReviewRunAccepted:
        matrix = self.review_store.get_matrix(matrix_id)
        if matrix is None:
            raise ReviewRunConfigurationError("Unknown review matrix.")
        tenant_actor = _tenant_attributed_actor(actor, matrix)
        model, route, filters = self._resolve_run_contract(matrix, tenant_actor)
        client = self._new_gateway_client()
        with self._transition_lock:
            self._assert_accepting(matrix.id)
            try:
                running, cells = self.review_store.begin_run(
                    matrix.id,
                    expected_updated_at=matrix.updated_at,
                )
            except ReviewNotFound as exc:
                raise ReviewRunConfigurationError(
                    "The review matrix was deleted before its run could be accepted."
                ) from exc
            try:
                first_usage_context = self._acquire_usage_context(
                    running,
                    cells[0],
                    tenant_actor,
                )
            except (UsageBudgetError, UsageProviderExecutionRefused, UsageTenantScopeError):
                self._fail_undispatched_cells(
                    running,
                    cells,
                    "Review usage-budget admission failed; no work was dispatched.",
                )
                raise
            try:
                self.seed_store.record_audit(
                    tenant_actor,
                    "review.run",
                    matrix.id,
                    {
                        "mode": "matrix",
                        "tenant_id": matrix.tenant_id,
                        "knowledge_config_ids": matrix.knowledge_config_ids,
                        "document_count": len(matrix.document_ids),
                        "column_count": len(matrix.columns),
                        "cell_count": len(cells),
                        "model_id": model.id,
                        **route.audit_metadata(),
                    },
                    runtime_state_changed=False,
                )
            except Exception as exc:
                cleanup_error = _abandon_usage_context(first_usage_context)
                self._fail_undispatched_cells(
                    running,
                    cells,
                    "Review audit recording failed; no work was dispatched.",
                )
                if cleanup_error is not None:
                    raise cleanup_error from exc
                raise ReviewRunConfigurationError(
                    "Review audit recording failed; no work was dispatched."
                ) from exc
            for index, cell in enumerate(cells):
                self._submit_cell(
                    running,
                    cell,
                    tenant_actor.model_copy(deep=True),
                    model,
                    route,
                    filters,
                    client,
                    _UsageContextSlot(first_usage_context if index == 0 else None),
                )
            return ReviewRunAccepted(
                matrix_id=matrix.id,
                status="running",
                cell_count=len(cells),
            )

    def rerun_cell(self, matrix_id: str, cell_id: str, actor: User) -> ReviewRunAccepted:
        matrix = self.review_store.get_matrix(matrix_id)
        if matrix is None:
            raise ReviewRunConfigurationError("Unknown review matrix.")
        tenant_actor = _tenant_attributed_actor(actor, matrix)
        model, route, filters = self._resolve_run_contract(matrix, tenant_actor)
        client = self._new_gateway_client()
        with self._transition_lock:
            self._assert_accepting(matrix.id)
            try:
                running, cell = self.review_store.begin_cell_rerun(
                    matrix.id,
                    cell_id,
                    expected_updated_at=matrix.updated_at,
                )
            except ReviewNotFound as exc:
                raise ReviewRunConfigurationError(
                    "The review matrix or cell was deleted before its rerun could be accepted."
                ) from exc
            try:
                usage_context = self._acquire_usage_context(
                    running,
                    cell,
                    tenant_actor,
                )
            except (UsageBudgetError, UsageProviderExecutionRefused, UsageTenantScopeError):
                self._fail_undispatched_cells(
                    running,
                    [cell],
                    "Review usage-budget admission failed; no work was dispatched.",
                )
                raise
            try:
                self.seed_store.record_audit(
                    tenant_actor,
                    "review.run",
                    matrix.id,
                    {
                        "mode": "cell_rerun",
                        "cell_id": cell.id,
                        "tenant_id": matrix.tenant_id,
                        "knowledge_config_ids": matrix.knowledge_config_ids,
                        "model_id": model.id,
                        **route.audit_metadata(),
                    },
                    runtime_state_changed=False,
                )
            except Exception as exc:
                cleanup_error = _abandon_usage_context(usage_context)
                self._fail_undispatched_cells(
                    running,
                    [cell],
                    "Review audit recording failed; no work was dispatched.",
                )
                if cleanup_error is not None:
                    raise cleanup_error from exc
                raise ReviewRunConfigurationError(
                    "Review audit recording failed; no work was dispatched."
                ) from exc
            self._submit_cell(
                running,
                cell,
                tenant_actor.model_copy(deep=True),
                model,
                route,
                filters,
                client,
                _UsageContextSlot(usage_context),
            )
            return ReviewRunAccepted(matrix_id=matrix.id, status="running", cell_count=1)

    def wait_for_idle(self, *, timeout: float = 10.0) -> bool:
        """Wait for currently submitted work; intended for shutdown and tests."""
        with self._futures_lock:
            futures = set(self._futures)
        if not futures:
            return True
        _done, pending = wait(futures, timeout=timeout)
        return not pending

    def purge_tenant(self, tenant_id: str) -> int:
        """Cancel and purge every matrix/cell owned by one tenant."""
        return self._purge_scope(lambda: self.review_store.purge_tenant(tenant_id))

    def purge_owner(self, owner_user_id: str) -> int:
        """Cancel and purge every matrix/cell owned by one user."""
        return self._purge_scope(lambda: self.review_store.purge_owner(owner_user_id))

    def _purge_scope(self, purge: Callable[[], list[str]]) -> int:
        with self._transition_lock:
            matrix_ids = purge()
            if not matrix_ids:
                return 0
            matrix_id_set = set(matrix_ids)
            self._cancelled_matrix_ids.update(matrix_id_set)
            with self._futures_lock:
                futures = [
                    future
                    for future, matrix_id in self._future_matrix_ids.items()
                    if matrix_id in matrix_id_set
                ]
            for future in futures:
                future.cancel()
            return len(matrix_ids)

    def _assert_accepting(self, matrix_id: str) -> None:
        if self._closed or self._aborting:
            raise ReviewRunConfigurationError("Review processing is shutting down.")
        if matrix_id in self._cancelled_matrix_ids:
            raise ReviewRunConfigurationError("This review matrix has been purged.")

    def _new_gateway_client(self) -> ModelGatewayClient:
        try:
            return self._gateway_factory()
        except Exception as exc:  # noqa: BLE001 - fail before reserving durable work
            raise ReviewRunConfigurationError(
                "The review model gateway could not be initialized; no work was accepted."
            ) from exc

    def _acquire_usage_context(
        self,
        matrix: ReviewMatrix,
        cell: ReviewCell,
        actor: User,
    ) -> UsageBudgetRequestContext:
        return self._usage_budget_orchestrator.begin_request(
            actor=actor,
            request_id=cell.run_token,
            resource_tenant_id=matrix.tenant_id,
            known_tenant_ids=self.seed_store.tenants.keys(),
        )

    def close(self, *, timeout: float = 5.0) -> None:
        with self._futures_lock:
            if self._closed:
                return
            self._closed = True
            futures = set(self._futures)
        _done, pending = wait(futures, timeout=max(0.0, timeout)) if futures else (set(), set())
        if pending:
            # Provider calls are synchronous and cannot be force-cancelled.
            # Stop accepting their results, durably interrupt every unfinished
            # cell, and return control to the container within the bound.
            with self._transition_lock:
                self._aborting = True
                self.review_store.interrupt_unfinished_runs()
            for future in pending:
                future.cancel()
            self._executor.shutdown(wait=False, cancel_futures=True)
            return
        self._executor.shutdown(wait=True, cancel_futures=False)

    def _resolve_run_contract(
        self,
        matrix: ReviewMatrix,
        actor: User,
    ) -> tuple[ModelConfig, ModelGatewayRoute, list[ContentFilter]]:
        if not self._activity_writes_sql_only:
            raise ReviewRunConfigurationError(
                "Review runs are unavailable until the SQL audit, usage, and export-outbox sink is active."
            )
        model = self.seed_store.models.get(matrix.model_id)
        if model is None:
            raise ReviewRunConfigurationError(f"Unknown model '{matrix.model_id}'.")
        assert_model_access(actor, model)
        if model.tenant_id is not None and model.tenant_id != matrix.tenant_id:
            raise ReviewRunConfigurationError(
                "The selected model is not available in the review matrix tenant."
            )
        try:
            route = resolve_model_route(
                self.seed_store,
                model,
                tenant_id=matrix.tenant_id,
            )
        except ModelGatewayConfigurationError as exc:
            raise ReviewRunConfigurationError(str(exc)) from exc
        if not route.configured:
            raise ReviewRunConfigurationError(
                f"{route.provider_name} is not configured for live review completions: {route.status_message}"
            )
        filters = _resolve_filters_fail_closed(self.seed_store, model)
        return model, route, filters

    def _submit_cell(
        self,
        matrix: ReviewMatrix,
        cell: ReviewCell,
        actor: User,
        model: ModelConfig,
        route: ModelGatewayRoute,
        filters: list[ContentFilter],
        client: ModelGatewayClient,
        usage_slot: _UsageContextSlot,
    ) -> None:
        future: Future[None] | None = None
        dispatch_error: str | None = None
        with self._futures_lock:
            if self._closed:
                dispatch_error = "Review processing is shutting down; this cell was not dispatched."
            else:
                try:
                    future = self._executor.submit(
                        self._execute_cell,
                        matrix,
                        cell,
                        actor,
                        model,
                        route,
                        filters,
                        client,
                        usage_slot,
                    )
                except RuntimeError:
                    dispatch_error = "Review processing could not dispatch this cell."
                else:
                    self._futures.add(future)
                    self._future_matrix_ids[future] = matrix.id
                    self._future_usage_slots[future] = usage_slot
        if future is None:
            _abandon_usage_context(usage_slot.context)
            try:
                if self._claim_cell(cell):
                    self._fail_cell(
                        cell, dispatch_error or "Review processing could not dispatch this cell."
                    )
            except Exception:  # noqa: BLE001 - claim may have committed before raising
                self._fail_reserved_cell_attempt(
                    cell,
                    dispatch_error or "Review processing could not dispatch this cell.",
                )
            self._finish_matrix(matrix.id)
            return
        future.add_done_callback(self._discard_future)

    def _execute_cell(
        self,
        matrix: ReviewMatrix,
        cell: ReviewCell,
        actor: User,
        model: ModelConfig,
        route: ModelGatewayRoute,
        filters: list[ContentFilter],
        client: ModelGatewayClient,
        usage_slot: _UsageContextSlot,
    ) -> None:
        usage_context = usage_slot.context
        try:
            try:
                claimed = self._claim_cell(cell)
            except Exception as exc:  # noqa: BLE001 - claim outcome may be pending or committed
                close_error = _fail_usage_context(usage_context)
                self._fail_reserved_cell_attempt(
                    cell,
                    (
                        _usage_accounting_detail(close_error)
                        if close_error is not None
                        else f"Review processing failed unexpectedly ({type(exc).__name__})."
                    ),
                )
                return
            if not claimed:
                _abandon_usage_context(usage_context)
                return
            column = next(column for column in matrix.columns if column.id == cell.column_id)
            hits = self.seed_store.vector_store.search_document(
                actor,
                matrix.knowledge_config_ids,
                column.question,
                document_id=cell.document_id,
                limit=REVIEW_CONTEXT_CHUNKS,
            )
            if not hits:
                raise ReviewCellExecutionError(
                    "No readable indexed text was available for this document and question."
                )
            messages, context_citations = _review_messages(column, hits, filters)
            with self._transition_lock:
                if self._aborting or matrix.id in self._cancelled_matrix_ids:
                    _abandon_usage_context(usage_context)
                    return
            if usage_context is None:
                usage_context = self._acquire_usage_context(matrix, cell, actor)
                usage_slot.context = usage_context
                with self._transition_lock:
                    if self._aborting or matrix.id in self._cancelled_matrix_ids:
                        _abandon_usage_context(usage_context)
                        return
            completion_id = new_accounting_id()
            try:
                payload = client.complete(
                    route=route,
                    messages=messages,
                    max_tokens=REVIEW_MAX_OUTPUT_TOKENS,
                )
            except ModelGatewayError as exc:
                raise ReviewCellExecutionError(
                    f"{route.provider_name} did not return a review answer: {exc}"
                ) from exc
            usage_context.settle_provider_child(
                completion_id=completion_id,
                usage=_raw_provider_usage(payload),
                attribution=ProviderUsageAttribution(
                    model_id=model.id,
                    provider_name=route.provider_name,
                    surface="review",
                    message_count=1,
                    thread_id=matrix.id,
                ),
            )
            answer = _completion_text(payload)
            answer = _filter_output(answer, filters)
            if len(answer) > MAX_REVIEW_ANSWER_CHARS:
                raise ReviewCellExecutionError(
                    f"The model answer exceeded the {MAX_REVIEW_ANSWER_CHARS}-character review cell limit."
                )
            citations = _used_citations(answer, context_citations)
            with self._transition_lock:
                if self._aborting or matrix.id in self._cancelled_matrix_ids:
                    _abandon_usage_context(usage_context)
                    return
                # Close authoritative accounting before delivering the cell.
                # A cross-store cell conflict may discard output, but it must
                # never erase or misclassify a provider call already settled.
                usage_context.complete_success()
                self.review_store.complete_cell(
                    matrix.id,
                    cell.id,
                    answer=answer,
                    citations=citations,
                    expected_attempt=cell.attempt,
                    run_token=cell.run_token,
                )
        except (UsageBudgetError, UsageProviderExecutionRefused, UsageTenantScopeError) as exc:
            close_error = _fail_usage_context(usage_context)
            self._fail_cell(cell, _usage_accounting_detail(close_error or exc))
        except ReviewCellExecutionError as exc:
            close_error = _fail_usage_context(usage_context)
            self._fail_cell(
                cell,
                _usage_accounting_detail(close_error) if close_error is not None else str(exc),
            )
        except ReviewConflict:
            # A restart sweep or newer rerun owns the cell now. The stale
            # worker must never overwrite that attempt's state.
            _abandon_usage_context(usage_context)
            return
        except StopIteration:
            close_error = _fail_usage_context(usage_context)
            self._fail_cell(
                cell,
                (
                    _usage_accounting_detail(close_error)
                    if close_error is not None
                    else "Review matrix configuration changed before this cell could run."
                ),
            )
        except Exception as exc:  # noqa: BLE001 - terminal state must survive unexpected worker errors
            close_error = _fail_usage_context(usage_context)
            self._fail_cell(
                cell,
                (
                    _usage_accounting_detail(close_error)
                    if close_error is not None
                    else f"Review processing failed unexpectedly ({type(exc).__name__})."
                ),
            )
        finally:
            if usage_context is not None and usage_context.status == "active":
                _abandon_usage_context(usage_context)
            self._finish_matrix(matrix.id)

    def _fail_undispatched_cells(
        self,
        matrix: ReviewMatrix,
        cells: list[ReviewCell],
        error: str,
    ) -> None:
        for cell in cells:
            if self._claim_cell(cell):
                self._fail_cell(cell, error)
        self._finish_matrix(matrix.id)

    def _claim_cell(self, cell: ReviewCell) -> bool:
        with self._transition_lock:
            if self._aborting or cell.matrix_id in self._cancelled_matrix_ids:
                return False
            try:
                return (
                    self.review_store.mark_cell_running(
                        cell.matrix_id,
                        cell.id,
                        expected_attempt=cell.attempt,
                        run_token=cell.run_token,
                    )
                    is not None
                )
            except ReviewNotFound:
                return False

    def _fail_cell(self, cell: ReviewCell, error: str) -> None:
        with self._transition_lock:
            if self._aborting or cell.matrix_id in self._cancelled_matrix_ids:
                return
            try:
                self.review_store.fail_cell(
                    cell.matrix_id,
                    cell.id,
                    error=error,
                    expected_attempt=cell.attempt,
                    run_token=cell.run_token,
                )
            except (ReviewConflict, ReviewNotFound):
                # Stale attempts are intentionally idempotent no-ops.
                pass

    def _fail_reserved_cell_attempt(self, cell: ReviewCell, error: str) -> None:
        with self._transition_lock:
            if self._aborting or cell.matrix_id in self._cancelled_matrix_ids:
                return
            try:
                self.review_store.fail_reserved_cell_attempt(
                    cell.matrix_id,
                    cell.id,
                    error=error,
                    expected_attempt=cell.attempt,
                    run_token=cell.run_token,
                )
            except (ReviewConflict, ReviewNotFound):
                # A different attempt or a terminal result always wins.
                pass

    def _finish_matrix(self, matrix_id: str) -> None:
        with self._transition_lock:
            if self._aborting or matrix_id in self._cancelled_matrix_ids:
                return
            try:
                self.review_store.finish_matrix_if_terminal(matrix_id)
            except ReviewNotFound:
                pass

    def _discard_future(self, future: Future[None]) -> None:
        with self._futures_lock:
            self._futures.discard(future)
            self._future_matrix_ids.pop(future, None)
            usage_slot = self._future_usage_slots.pop(future, None)
        if future.cancelled() and usage_slot is not None:
            _abandon_usage_context(usage_slot.context)


def _raw_provider_usage(payload: object) -> Mapping[str, Any] | None:
    if not isinstance(payload, Mapping):
        return None
    usage = payload.get("usage")
    if usage is None:
        return None
    if not isinstance(usage, Mapping):
        raise UsageMeteringInvalid("Provider usage must be an object when present.")
    return usage


def _fail_usage_context(
    context: UsageBudgetRequestContext | None,
) -> UsageBudgetError | None:
    if context is None or context.status != "active":
        return None
    try:
        context.fail()
    except UsageBudgetError as exc:
        return exc
    return None


def _abandon_usage_context(
    context: UsageBudgetRequestContext | None,
) -> UsageBudgetError | None:
    if context is None or context.status != "active":
        return None
    try:
        context.abandon()
    except UsageBudgetError as exc:
        return exc
    return None


def _usage_accounting_detail(
    error: UsageBudgetError | UsageProviderExecutionRefused | UsageTenantScopeError,
) -> str:
    if isinstance(error, UsageTenantScopeError):
        return error.detail
    if isinstance(error, UsageProviderExecutionRefused):
        return (
            "Usage accounting could not safely verify this request. "
            "No new provider execution is authorized."
        )
    return map_usage_budget_error(error).detail


def _resolve_filters_fail_closed(store: SeedStore, model: ModelConfig) -> list[ContentFilter]:
    filters = resolve_model_content_filters(store, model)
    resolved_ids = {content_filter.id for content_filter in filters}
    missing_ids = [
        filter_id for filter_id in model.content_filter_ids if filter_id not in resolved_ids
    ]
    if missing_ids:
        raise ReviewRunConfigurationError(
            "One or more assigned content filters are unavailable; review work was not dispatched."
        )
    for content_filter in filters:
        try:
            validate_content_filter_rules(content_filter.rules)
        except ValueError as exc:
            raise ReviewRunConfigurationError(
                f"Content filter '{content_filter.name}' is invalid; review work was not dispatched."
            ) from exc
    # Freeze the accepted run contract. Admin edits mutate SeedStore filter
    # objects in place; queued cells must keep using the rules validated here.
    return [content_filter.model_copy(deep=True) for content_filter in filters]


def _review_messages(
    column: ReviewColumn,
    hits: list[KnowledgeChunk],
    filters: list[ContentFilter],
) -> tuple[list[dict[str, Any]], list[ReviewCitation]]:
    filtered_question = _filter_input(column.question, filters)
    blocks: list[str] = []
    citations: list[ReviewCitation] = []
    for index, hit in enumerate(hits, start=1):
        text = _filter_input(hit.text, filters)
        location = _chunk_location(hit)
        blocks.append(f"[K{index}]{location} {hit.source_name}\n{text}")
        citations.append(
            ReviewCitation(
                k_index=index,
                knowledge_config_id=hit.knowledge_config_id,
                document_id=hit.document_id,
                chunk_id=hit.id,
                source_name=hit.source_name,
                source_uri=hit.source_uri,
                page_start=hit.page_start,
                page_end=hit.page_end,
                locator=hit.locator,
            )
        )
    format_instruction = {
        "text": "Answer concisely in plain text.",
        "yes_no": "Begin with Yes, No, or Not determinable, then explain briefly.",
        "date": "Give the supported date, or Not determinable, then explain briefly.",
        "amount": "Give the supported amount and currency, or Not determinable, then explain briefly.",
    }[column.answer_format]
    system = (
        "You are filling one enterprise document-review cell. Use only the supplied excerpts. "
        "Do not infer facts that the excerpts do not support. Cite every supported assertion inline "
        "with the stable labels [K1], [K2], and so on. If the excerpts are insufficient, say "
        "Not determinable. "
        f"{format_instruction}"
    )
    user = f"Question: {filtered_question}\n\nDocument excerpts:\n\n" + "\n\n".join(blocks)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}], citations


def _chunk_location(chunk: KnowledgeChunk) -> str:
    details: list[str] = []
    if chunk.page_start is not None:
        if chunk.page_end is not None and chunk.page_end != chunk.page_start:
            details.append(f"pp. {chunk.page_start}-{chunk.page_end}")
        else:
            details.append(f"p. {chunk.page_start}")
    if chunk.locator:
        details.append(chunk.locator)
    return f" ({' · '.join(details)})" if details else ""


def _filter_input(text: str, filters: list[ContentFilter]) -> str:
    evaluation = evaluate_content_filters(filters, text, "input")
    if evaluation.blocked:
        raise ReviewCellExecutionError(_blocked_filter_error(evaluation.blocked[0], "input"))
    return evaluation.text


def _filter_output(text: str, filters: list[ContentFilter]) -> str:
    evaluation = evaluate_content_filters(filters, text, "output")
    if evaluation.blocked:
        raise ReviewCellExecutionError(_blocked_filter_error(evaluation.blocked[0], "output"))
    return evaluation.text


def _blocked_filter_error(match: ContentRuleMatch, direction: str) -> str:
    return (
        f"Review {direction} was blocked by content filter '{match.filter_name}': "
        f"{match.label} detected."
    )


def _completion_text(payload: object) -> str:
    if not isinstance(payload, dict):
        raise ReviewCellExecutionError("The model returned an invalid review response.")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ReviewCellExecutionError("The model returned no review answer.")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ReviewCellExecutionError("The model returned no review answer.")
    content = message.get("content")
    if isinstance(content, str):
        answer = content.strip()
    elif isinstance(content, list):
        answer = "\n".join(
            str(part.get("text") or "").strip()
            for part in content
            if isinstance(part, dict) and part.get("type") in {None, "text", "output_text"}
        ).strip()
    else:
        answer = ""
    if not answer:
        raise ReviewCellExecutionError("The model returned an empty review answer.")
    return answer


def _used_citations(answer: str, citations: list[ReviewCitation]) -> list[ReviewCitation]:
    by_index = {citation.k_index: citation for citation in citations}
    used: list[ReviewCitation] = []
    seen: set[int] = set()
    raw_indices = _CITATION_PATTERN.findall(answer)
    if not raw_indices:
        raise ReviewCellExecutionError(
            "The model answer did not include a verifiable document citation."
        )
    unknown: list[int] = []
    for raw_index in raw_indices:
        index = int(raw_index)
        citation = by_index.get(index)
        if citation is None:
            # Drop the invented reference rather than the whole answer. Failing
            # the cell outright meant one stray index discarded work that was
            # otherwise correctly grounded in the supplied chunks.
            if index not in unknown:
                unknown.append(index)
            continue
        if index not in seen:
            used.append(citation)
            seen.add(index)
    if not used:
        cited = ", ".join(f"[K{index}]" for index in unknown)
        raise ReviewCellExecutionError(
            f"The model answer cited {cited}, which was not supplied to this review cell."
            if unknown
            else "The model answer did not include a verifiable document citation."
        )
    return used


def _tenant_attributed_actor(actor: User, matrix: ReviewMatrix) -> User:
    """Bind owner activity to the matrix tenant without changing identity/role."""
    if actor.tenant_id == matrix.tenant_id:
        return actor
    if actor.role != Role.PLATFORM_OWNER:
        raise ReviewRunConfigurationError(
            "The authenticated actor is not in the review matrix tenant."
        )
    return actor.model_copy(update={"tenant_id": matrix.tenant_id})
