"""Process-local factories for the dedicated Review Grid runtime."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from app.core.review_runner import ReviewRunner
from app.core.review_store import ReviewStore
from app.repositories.deps import get_store, get_usage_budget_orchestrator


_REPO_ROOT = Path(__file__).resolve().parents[4]


@lru_cache
def get_review_store() -> ReviewStore:
    running_tests = bool(os.environ.get("PYTEST_CURRENT_TEST"))
    path = ":memory:" if running_tests else _review_db_path()
    return ReviewStore(
        path, max_queued_runs=_bounded_int("APERTURE_REVIEW_MAX_QUEUED_RUNS", 4, 1, 20)
    )


@lru_cache
def get_review_runner() -> ReviewRunner:
    seed_store = get_store()
    return ReviewRunner(
        get_review_store(),
        seed_store,
        max_concurrency=_bounded_int("APERTURE_REVIEW_MAX_CONCURRENCY", 3, 1, 8),
        activity_writes_sql_only=bool(getattr(seed_store, "review_activity_sink_sql_only", False)),
        usage_budget_orchestrator=get_usage_budget_orchestrator(),
    )


def initialize_review_services() -> None:
    """Open the review database so restart interruption runs at app startup."""
    get_review_store()


def close_review_services() -> None:
    """Stop workers before closing their SQLite connection."""
    if get_review_runner.cache_info().currsize:
        get_review_runner().close()
        get_review_runner.cache_clear()
    if get_review_store.cache_info().currsize:
        get_review_store().close()
        get_review_store.cache_clear()


def purge_review_tenant(tenant_id: str) -> int:
    """Cancel and delete tenant review data; callers must abort on any error.

    Invoke this before deleting the corresponding tenant from application
    state. The return value is the number of matrices deleted.
    """
    return get_review_runner().purge_tenant(tenant_id)


def purge_review_owner(owner_user_id: str) -> int:
    """Cancel and delete owner review data; callers must abort on any error.

    Invoke this before deleting the corresponding user from application state.
    The return value is the number of matrices deleted.
    """
    return get_review_runner().purge_owner(owner_user_id)


def set_review_matrix_matter(
    matrix_id: str,
    *,
    tenant_id: str,
    matter_id: str | None,
):
    """Assign or clear one matrix's matter reference; access checks are the
    caller's responsibility."""

    return get_review_store().set_matrix_matter(
        matrix_id, tenant_id=tenant_id, matter_id=matter_id
    )


def clear_review_matter_references(matter_id: str) -> int:
    """Null every matrix reference to one deleted matter; deletes no results."""

    return get_review_store().clear_matter_references(matter_id)


def _review_db_path() -> str:
    default = "services/api/data/review.sqlite3"
    raw = (
        os.environ.get(
            "APERTURE_REVIEW_DB_PATH",
            default,
        ).strip()
        or default
    )
    if raw == ":memory:":
        return raw
    path = Path(raw).expanduser()
    if path.is_absolute():
        return str(path)
    return str((_REPO_ROOT / path).resolve())


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    try:
        value = int(raw) if raw is not None else default
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))
