import os
from functools import lru_cache
from pathlib import Path

from app.core.config import get_settings, resolve_repo_path
from app.core.security import SecretVault
from app.core.usage_budget_runtime import TenantUsageBudgetOrchestrator
from app.repositories.seed import SeedStore
from app.repositories.usage_budgets import TenantUsageBudgetRepository


@lru_cache
def get_store() -> SeedStore:
    settings = get_settings()
    running_tests = bool(os.environ.get("PYTEST_CURRENT_TEST"))
    return SeedStore(
        SecretVault(settings.secret_key),
        openrouter_api_key=settings.openrouter_api_key,
        openrouter_base_url=settings.openrouter_base_url,
        openrouter_default_model=settings.openrouter_default_model,
        seed_platform_owner_enabled=settings.seed_platform_owner_enabled,
        seed_demo_data_enabled=True if running_tests else settings.seed_demo_data_enabled,
        runtime_state_path=None
        if running_tests
        else _repo_relative_path(settings.runtime_state_path),
        application_database_url=(
            "sqlite+pysqlite:///:memory:" if running_tests else settings.application_database_url
        ),
        vector_db_path=":memory:" if running_tests else settings.vector_db_path,
        dense_embeddings_enabled=(
            False if running_tests else settings.knowledge_dense_embeddings_enabled
        ),
        embedding_model=settings.knowledge_embedding_model,
        embedding_cache_dir=settings.knowledge_embedding_cache_dir,
        embedding_threads=settings.knowledge_embedding_threads,
    )


def get_usage_budget_repository() -> TenantUsageBudgetRepository:
    """Return the budget repository bound to the process's application DB."""

    return _cached_usage_budget_repository(get_store())


def get_usage_budget_orchestrator() -> TenantUsageBudgetOrchestrator:
    """Return the process-local fail-closed budget runtime adapter."""

    return _cached_usage_budget_orchestrator(get_usage_budget_repository())


@lru_cache(maxsize=1)
def _cached_usage_budget_repository(store: SeedStore) -> TenantUsageBudgetRepository:
    return store.usage_budget_repository


@lru_cache(maxsize=1)
def _cached_usage_budget_orchestrator(
    repository: TenantUsageBudgetRepository,
) -> TenantUsageBudgetOrchestrator:
    return TenantUsageBudgetOrchestrator(repository)


def _repo_relative_path(value: str | None) -> str | None:
    if not value:
        return None
    path = Path(value).expanduser()
    return str(resolve_repo_path(path))
