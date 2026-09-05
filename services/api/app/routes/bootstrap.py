from fastapi import APIRouter, Depends

from app.core.memory import memory_state_for
from app.core.policy import (
    is_platform_owner,
    is_tenant_admin,
    knowledge_authoring_allowed,
    knowledge_config_visible_to_user,
    model_access_allowed,
    tool_authoring_allowed,
)
from app.models.schemas import ChatSession, Role, User
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api", tags=["bootstrap"])


@router.get("/me")
def me(actor: User = Depends(current_user)) -> User:
    return actor


@router.get("/bootstrap")
def bootstrap(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, object]:
    return bootstrap_payload(actor, store)


def bootstrap_payload(actor: User, store: SeedStore) -> dict[str, object]:
    snapshot = store.snapshot(current_tenant_id=actor.tenant_id)
    snapshot["me"] = actor
    # "users" is the actor-visible directory (owner console needs owner accounts);
    # "visibleUsers" backs tenant-scoped admin surfaces and never lists platform owners.
    snapshot["users"] = store.visible_users_for(actor)
    snapshot["visibleUsers"] = store.tenant_visible_users_for(actor)
    snapshot["providerKeys"] = store.provider_key_records() if actor.role == "PLATFORM_OWNER" else []
    # Read-only policy booleans: admin surfaces gate their management UI on
    # these instead of discovering restrictions through 403s.
    snapshot["platformSettings"] = store.platform_settings
    # Chat history is a personal workspace boundary. Tenant administration and
    # platform governance do not grant access to another user's chat titles.
    snapshot["chatSessions"] = [
        ChatSession(**thread.model_dump(exclude={"messages"}))
        for thread in store.chat_threads_for(actor)
    ]
    # Memory availability and the caller's own preference, never memory
    # content: the manager fetches that lazily and only for its owner.
    memory_state = memory_state_for(store, actor)
    snapshot["memoryState"] = memory_state.as_response()
    snapshot["memorySettings"] = store.user_memory_settings_for(actor.id)
    snapshot["memoryPolicy"] = memory_state.policy
    # Resolved authoring capabilities so the workspace can show real create
    # controls instead of discovering the tenant grants through 403s.
    snapshot["authoringState"] = {
        "knowledge_enabled": knowledge_authoring_allowed(actor, store.groups),
        "tools_enabled": tool_authoring_allowed(actor, store.groups),
    }
    if actor.role != Role.PLATFORM_OWNER:
        tenant = store.tenants.get(actor.tenant_id or "")
        snapshot["tenants"] = [tenant] if tenant is not None else []
        snapshot["currentTenant"] = tenant
        snapshot["groups"] = [group for group in store.groups.values() if group.tenant_id == actor.tenant_id]
        snapshot["models"] = [model for model in store.models.values() if model_access_allowed(actor, model)]
    if actor.role != "PLATFORM_OWNER":
        snapshot["agentRuns"] = [
            run for run in store.agent_runs.values() if run.tenant_id == actor.tenant_id
        ]
        snapshot["connectorConfigs"] = [
            record for record in store.connector_configs.values() if record.tenant_id == actor.tenant_id
        ]
        snapshot["ssoConfigs"] = [
            record for record in store.sso_configs.values() if record.tenant_id == actor.tenant_id
        ]
        snapshot["knowledgeConfigs"] = [
            record
            for record in store.knowledge_configs.values()
            if knowledge_config_visible_to_user(actor, record)
        ]
        snapshot["toolConfigs"] = [
            record
            for record in store.tool_configs.values()
            if record.tenant_id == actor.tenant_id
            # Another user's private (owner-scoped, unshared) tools stay out
            # of the payload; admins keep the full tenant catalog.
            and (
                is_tenant_admin(actor)
                or not record.owner_user_id
                or record.allowed_group_ids
                or record.owner_user_id == actor.id
            )
        ]
        snapshot["promptTemplates"] = [
            record for record in store.prompt_templates.values() if record.tenant_id == actor.tenant_id
        ]
        if not is_tenant_admin(actor):
            # The owner console's connector switches are workspace kill
            # switches: a disabled connector removes the capability from user
            # payloads entirely — off is off, not merely hidden. Admins keep
            # the records so their consoles stay coherent.
            if not _workspace_connector_enabled(store, "mcp"):
                snapshot["toolConfigs"] = [
                    record for record in snapshot["toolConfigs"] if record.tool_type != "mcp"
                ]
            if not _workspace_connector_enabled(store, "prompt-library"):
                snapshot["promptTemplates"] = []
        snapshot["skillFiles"] = [
            record for record in store.skill_files.values() if record.tenant_id == actor.tenant_id
        ]
        snapshot["automations"] = visible_automations_for(actor, store)
    return snapshot


def _workspace_connector_enabled(store: SeedStore, connector_id: str) -> bool:
    connector = store.connectors.get(connector_id)
    return connector is not None and connector.platform_enabled and connector.tenant_enabled


def visible_automations_for(actor: User, store: SeedStore) -> list[object]:
    if is_platform_owner(actor):
        return list(store.automations.values())
    same_tenant = [record for record in store.automations.values() if record.tenant_id == actor.tenant_id]
    if is_tenant_admin(actor):
        return same_tenant
    return [record for record in same_tenant if record.created_by == actor.id]
