from app.core.policy import can_create_role, can_modify_user, is_pending_platform_user, knowledge_access_allowed, model_access_allowed, tool_access_allowed
from app.models.schemas import DEFAULT_USER_GROUP_ID, ModelConfig, Role
from app.repositories.deps import get_store


def test_tenant_admin_role_creation_is_limited() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    assert can_create_role(admin, Role.USER)
    assert can_create_role(admin, Role.AGENT_APPROVER)
    assert not can_create_role(admin, Role.TENANT_ADMIN)
    assert not can_create_role(admin, Role.PLATFORM_OWNER)


def test_tenant_admin_admin_creation_can_be_owner_delegated() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    other_admin = store.users["user-drew"]
    owner = store.users["user-owner"]
    assert can_create_role(admin, Role.TENANT_ADMIN, tenant_admins_can_create_admins=True)
    assert can_modify_user(admin, other_admin, tenant_admins_can_create_admins=True)
    assert not can_create_role(admin, Role.PLATFORM_OWNER, tenant_admins_can_create_admins=True)
    assert not can_modify_user(admin, owner, tenant_admins_can_create_admins=True)


def test_tenant_admin_can_modify_regular_users_only() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    regular_user = store.users["user-jane"]
    other_admin = store.users["user-drew"]
    owner = store.users["user-owner"]
    assert can_modify_user(admin, regular_user)
    assert not can_modify_user(admin, other_admin)
    assert not can_modify_user(admin, owner)


def test_model_policy_precedence() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    owner = store.users["user-owner"]
    jane = store.users["user-jane"]
    disabled_model = store.models["o3-mini"]
    restricted_model = store.models["gpt-4o-mini"]
    ungranted_model = store.models["openrouter-openai-gpt-5-5"]
    assert not model_access_allowed(owner, disabled_model)
    assert not model_access_allowed(owner, disabled_model, explicit_deny=True)
    assert not model_access_allowed(jane, disabled_model)
    assert model_access_allowed(jane, restricted_model)
    assert not model_access_allowed(admin, ungranted_model)
    assert not model_access_allowed(jane, ungranted_model)

    casey = store.users["user-casey"].model_copy(update={"group_ids": ["group-hr"]})
    assert not model_access_allowed(casey, restricted_model)
    assert not model_access_allowed(casey, store.models["gpt-4.1"])


def test_agent_profile_visibility_bypasses_user_scopes_for_admins() -> None:
    store = get_store()
    owner = store.users["user-owner"]
    admin = store.users["user-admin"]
    jane = store.users["user-jane"]
    casey = store.users["user-casey"]
    private_agent = ModelConfig(
        id="agent-private-casey",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Casey Private Agent",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=False,
        is_custom=True,
        created_by="Casey Doe",
        visibility="private",
        meta_prompt="Keep this workspace private to the creator.",
    )
    group_agent = ModelConfig(
        id="agent-finance-only",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Finance Agent",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=False,
        is_custom=True,
        created_by="Alex Morgan",
        visibility="group",
        group_ids=["group-finance"],
        meta_prompt="Use finance group sources.",
    )
    tenant_agent = ModelConfig(
        id="agent-tenant-wide",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Tenant Wide Agent",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=False,
        is_custom=True,
        created_by="Alex Morgan",
        visibility="tenant",
        meta_prompt="Available tenant-wide.",
    )

    assert model_access_allowed(owner, private_agent)
    assert model_access_allowed(admin, private_agent)
    assert model_access_allowed(casey, private_agent)
    assert not model_access_allowed(jane, private_agent)

    assert model_access_allowed(admin, group_agent)
    assert not model_access_allowed(jane, group_agent)

    assert model_access_allowed(jane, tenant_agent)


def test_default_user_group_grants_seeded_baseline_access() -> None:
    store = get_store()
    default_group = store.groups[DEFAULT_USER_GROUP_ID]
    default_user = store.users["user-maya"]

    assert default_group.default_group
    assert default_user.group_ids == [DEFAULT_USER_GROUP_ID]
    assert not is_pending_platform_user(default_user)
    assert model_access_allowed(default_user, store.models["openrouter-openai-gpt-5-5"])


def test_pending_sso_user_has_no_group_scoped_runtime_access() -> None:
    store = get_store()
    pending_user = store.users["user-maya"].model_copy(update={"id": "user-pending", "group_ids": []})

    assert is_pending_platform_user(pending_user)
    assert not model_access_allowed(pending_user, store.models["gpt-4o"])
    assert not knowledge_access_allowed(pending_user, store.knowledge_configs["knowledge-litigation-playbook"])
    assert not tool_access_allowed(pending_user, store.tool_configs["tool-agent-workflow"])
