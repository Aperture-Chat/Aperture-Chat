from __future__ import annotations

from collections.abc import Mapping

from fastapi import HTTPException, status

from app.models.schemas import (
    Group,
    KnowledgeConfig,
    ModelConfig,
    PlatformSettings,
    Role,
    TENANT_ADMIN_ASSIGNABLE_ROLES,
    ToolConfig,
    User,
)


def is_platform_owner(user: User) -> bool:
    return user.role == Role.PLATFORM_OWNER


def is_tenant_admin(user: User) -> bool:
    return user.role == Role.TENANT_ADMIN


def is_pending_platform_user(user: User) -> bool:
    return user.active and user.role not in {Role.PLATFORM_OWNER, Role.TENANT_ADMIN} and not user.group_ids


def require_platform_owner(user: User) -> None:
    if not is_platform_owner(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires service-level privileges.",
        )


def require_admin_or_owner(user: User) -> None:
    if user.role not in {Role.PLATFORM_OWNER, Role.TENANT_ADMIN}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges are required.",
        )


def same_tenant(actor: User, target: User) -> bool:
    return actor.tenant_id is not None and actor.tenant_id == target.tenant_id


def can_view_user(actor: User, target: User) -> bool:
    if is_platform_owner(actor):
        return True
    if is_tenant_admin(actor):
        return same_tenant(actor, target) and target.role != Role.PLATFORM_OWNER
    return actor.id == target.id


def tenant_admin_assignable_roles(tenant_admins_can_create_admins: bool = False) -> set[Role]:
    roles = set(TENANT_ADMIN_ASSIGNABLE_ROLES)
    if tenant_admins_can_create_admins:
        roles.add(Role.TENANT_ADMIN)
    return roles


def can_create_role(actor: User, role: Role, *, tenant_admins_can_create_admins: bool = False) -> bool:
    if is_platform_owner(actor):
        return True
    if is_tenant_admin(actor):
        return role in tenant_admin_assignable_roles(tenant_admins_can_create_admins)
    return False


def assert_can_create_role(actor: User, role: Role, *, tenant_admins_can_create_admins: bool = False) -> None:
    if not can_create_role(actor, role, tenant_admins_can_create_admins=tenant_admins_can_create_admins):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot assign the requested role.",
        )


def can_modify_user(actor: User, target: User, *, tenant_admins_can_create_admins: bool = False) -> bool:
    if is_platform_owner(actor):
        return True
    if is_tenant_admin(actor):
        return same_tenant(actor, target) and target.role in tenant_admin_assignable_roles(tenant_admins_can_create_admins)
    return False


def assert_can_modify_user(actor: User, target: User, *, tenant_admins_can_create_admins: bool = False) -> None:
    if not can_modify_user(actor, target, tenant_admins_can_create_admins=tenant_admins_can_create_admins):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot modify this account under the current service policy.",
        )


def model_access_allowed(user: User, model: ModelConfig, explicit_deny: bool = False) -> bool:
    if explicit_deny:
        return False
    if model.tenant_id is not None and not is_platform_owner(user) and user.tenant_id != model.tenant_id:
        return False
    if is_workspace_agent_profile(model):
        return agent_profile_access_allowed(user, model)
    if not model.platform_enabled:
        return False
    if is_platform_owner(user):
        return True
    if is_pending_platform_user(user):
        return False
    return bool(set(user.group_ids).intersection(model.group_ids))


def assert_model_access(user: User, model: ModelConfig, explicit_deny: bool = False) -> None:
    if not model_access_allowed(user, model, explicit_deny=explicit_deny):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Model access is restricted by platform, tenant, group, or explicit deny policy.",
        )


def is_workspace_agent_profile(model: ModelConfig) -> bool:
    if model.agentic_companion:
        return True
    return bool(
        model.is_custom
        and (
            model.created_by
            or model.meta_prompt
            or model.knowledge_config_ids
            or model.tool_config_ids
            or model.prompt_template_ids
            or model.skill_file_ids
        )
    )


def agent_profile_access_allowed(user: User, model: ModelConfig) -> bool:
    if not is_workspace_agent_profile(model):
        return False
    if is_platform_owner(user):
        return True
    if model.tenant_id is None or user.tenant_id != model.tenant_id:
        return False
    if is_tenant_admin(user):
        return True
    if is_pending_platform_user(user):
        return False
    visibility = (model.visibility or "tenant").lower()
    if visibility in {"organization", "tenant"}:
        return user.tenant_id is not None
    if visibility == "private":
        return _agent_profile_created_by_user(user, model)
    return bool(set(user.group_ids).intersection(model.group_ids))


def assert_agent_profile_access(user: User, model: ModelConfig) -> None:
    if not agent_profile_access_allowed(user, model):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Agent profile access is restricted by tenant, group, or private visibility policy.",
        )


def _agent_profile_created_by_user(user: User, model: ModelConfig) -> bool:
    created_by = (model.created_by or "").strip().casefold()
    if not created_by:
        return False
    owner_tokens = {user.id, user.email, user.display_name}
    return created_by in {token.strip().casefold() for token in owner_tokens if token}


def agent_profile_authored_by(user: User, model: ModelConfig) -> bool:
    """Whether `user` is the recorded creator of `model`.

    Authoring routes use this to keep a granted user inside their own profiles;
    it is the same creator match that private visibility already relies on.
    """
    return _agent_profile_created_by_user(user, model)


def knowledge_config_visible_to_user(user: User, config: KnowledgeConfig) -> bool:
    if is_platform_owner(user):
        return True
    if user.tenant_id != config.tenant_id:
        return False
    if is_tenant_admin(user):
        return True
    if is_pending_platform_user(user):
        return False
    if config.acl_group_ids and not set(user.group_ids).intersection(config.acl_group_ids):
        return False
    if config.acl_group_ids:
        return True
    return config.owner_user_id == user.id


def knowledge_access_allowed(user: User, config: KnowledgeConfig) -> bool:
    if not config.enabled:
        return False
    if not knowledge_config_visible_to_user(user, config):
        return False
    return True


def assert_knowledge_access(user: User, config: KnowledgeConfig) -> None:
    if not knowledge_access_allowed(user, config):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Knowledge access is restricted by tenant, group, or source ACL policy.",
        )


def group_permission_allowed(user: User, groups: Mapping[str, Group], permission: str) -> bool:
    """Group permissions are additive: any of the user's groups can grant a capability.

    Admins and platform owners are not gated by tenant group permissions. Users
    without any platform group have no grants (matching the pending-user model).
    """
    if user.role in {Role.PLATFORM_OWNER, Role.TENANT_ADMIN}:
        return True
    for group_id in user.group_ids:
        group = groups.get(group_id)
        if group is not None and bool(group.permissions.get(permission, True)):
            return True
    return False


def api_access_allowed(
    user: User,
    groups: Mapping[str, Group],
    platform_settings: PlatformSettings,
) -> bool:
    """Apply the owner policy ceiling before any downstream user grant.

    The organization master switch is off by default. Once a platform owner
    enables it, platform owners and tenant admins receive API-key access
    automatically. Regular users still require an explicit group grant from
    an administrator.
    """
    if not platform_settings.downstream_api_enabled:
        return False
    if user.role in {Role.PLATFORM_OWNER, Role.TENANT_ADMIN}:
        return True
    return any(
        bool(groups[group_id].permissions.get("api_access", False))
        for group_id in user.group_ids
        if group_id in groups
    )


def hermes_companion_allowed(user: User, groups: Mapping[str, Group]) -> bool:
    """The Hermes learning companion is opt-in, mirroring api_access.

    The admin team grants the capability per group; it is off by default and
    never requires platform-owner involvement. Owners are covered when any
    managed group enables it; everyone else needs the grant on one of their
    own groups.
    """
    if user.role == Role.PLATFORM_OWNER:
        return any(
            bool(group.permissions.get("hermes_companion", False)) for group in groups.values()
        )
    return any(
        bool(groups[group_id].permissions.get("hermes_companion", False))
        for group_id in user.group_ids
        if group_id in groups
    )


def assert_api_access(
    user: User,
    groups: Mapping[str, Group],
    platform_settings: PlatformSettings,
) -> None:
    if not api_access_allowed(user, groups, platform_settings):
        detail = (
            "Downstream API access is unavailable under the current service policy."
            if not platform_settings.downstream_api_enabled
            else "API access is disabled for your platform groups by tenant policy."
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=detail,
        )


def agent_authoring_allowed(
    user: User,
    groups: Mapping[str, Group],
    platform_settings: PlatformSettings,
) -> bool:
    """Apply the owner policy ceiling before any downstream user grant.

    Platform owners and tenant admins always author agent profiles. A standard
    user needs the organization master switch on *and* an explicit
    agent_authoring group grant, which is off by default. Granted users author
    private agents for themselves; the routes keep tenant-wide publication,
    group sharing, and platform enablement on the admin side.
    """
    if user.role in {Role.PLATFORM_OWNER, Role.TENANT_ADMIN}:
        return True
    if not platform_settings.users_can_create_models:
        return False
    if is_pending_platform_user(user):
        return False
    return any(
        bool(groups[group_id].permissions.get("agent_authoring", False))
        for group_id in user.group_ids
        if group_id in groups
    )


def knowledge_authoring_allowed(user: User, groups: Mapping[str, Group]) -> bool:
    """Tenant admins control user-created knowledge bases via a group grant.

    Admins and platform owners always author knowledge bases. A standard user
    needs an explicit knowledge_authoring group grant, off by default. Granted
    users author private, self-owned knowledge bases; group sharing and
    tenant-wide management stay on the admin side.
    """
    if user.role in {Role.PLATFORM_OWNER, Role.TENANT_ADMIN}:
        return True
    if is_pending_platform_user(user):
        return False
    return any(
        bool(groups[group_id].permissions.get("knowledge_authoring", False))
        for group_id in user.group_ids
        if group_id in groups
    )


def assert_knowledge_authoring(user: User, groups: Mapping[str, Group]) -> None:
    if knowledge_authoring_allowed(user, groups):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="User-created knowledge bases are disabled for your platform groups by tenant policy.",
    )


def tool_authoring_allowed(user: User, groups: Mapping[str, Group]) -> bool:
    """Tenant admins control user-created tools via a group grant.

    Admins and platform owners always author tools. A standard user needs an
    explicit tool_authoring group grant, off by default. Granted users author
    private, self-owned tools; group sharing, stdio commands, and tenant-wide
    management stay on the admin/service side.
    """
    if user.role in {Role.PLATFORM_OWNER, Role.TENANT_ADMIN}:
        return True
    if is_pending_platform_user(user):
        return False
    return any(
        bool(groups[group_id].permissions.get("tool_authoring", False))
        for group_id in user.group_ids
        if group_id in groups
    )


def assert_tool_authoring(user: User, groups: Mapping[str, Group]) -> None:
    if tool_authoring_allowed(user, groups):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="User-created tools are disabled for your platform groups by tenant policy.",
    )


def assert_agent_authoring(
    user: User,
    groups: Mapping[str, Group],
    platform_settings: PlatformSettings,
) -> None:
    if agent_authoring_allowed(user, groups, platform_settings):
        return
    detail = (
        "User-created agent profiles are unavailable under the current service policy."
        if not platform_settings.users_can_create_models
        else "Agent authoring is disabled for your platform groups by tenant policy."
    )
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def assert_group_permission(user: User, groups: Mapping[str, Group], permission: str, capability: str) -> None:
    if not group_permission_allowed(user, groups, permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"{capability} is disabled for your platform groups by tenant policy.",
        )


def tool_access_allowed(user: User, config: ToolConfig) -> bool:
    if not config.enabled:
        return False
    if is_platform_owner(user):
        return True
    if user.tenant_id != config.tenant_id:
        return False
    if is_pending_platform_user(user):
        return False
    if config.allowed_group_ids and not set(user.group_ids).intersection(config.allowed_group_ids):
        return False
    if config.owner_user_id and not config.allowed_group_ids:
        # A user-authored tool with no group shares is private to its author;
        # tenant admins keep management access.
        return user.id == config.owner_user_id or is_tenant_admin(user)
    return True


def assert_tool_access(user: User, config: ToolConfig) -> None:
    if not tool_access_allowed(user, config):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tool access is restricted by tenant, group, or tool policy.",
        )
