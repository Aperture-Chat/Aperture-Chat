from __future__ import annotations

import hashlib
import re
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core import clock
from app.core.provider_credential_expiry import parse_provider_credential_expiry
from app.core.usage_budget import NANODOLLARS_PER_DOLLAR, SIGNED_BIGINT_MAX


def now_utc() -> datetime:
    return clock.now()


class Role(StrEnum):
    PLATFORM_OWNER = "PLATFORM_OWNER"
    TENANT_ADMIN = "TENANT_ADMIN"
    TEMP_USER = "TEMP_USER"
    POWER_USER = "POWER_USER"
    AUDITOR = "AUDITOR"
    AGENT_APPROVER = "AGENT_APPROVER"
    USER = "USER"


TENANT_ADMIN_ASSIGNABLE_ROLES = {
    Role.TEMP_USER,
    Role.USER,
    Role.POWER_USER,
    Role.AUDITOR,
    Role.AGENT_APPROVER,
}


TEMP_USER_TOKEN_LIMIT = 30_000


DEFAULT_GROUP_PERMISSIONS = {
    "chat_access": True,
    "knowledge_access": True,
    "agents_access": True,
    "tools_access": True,
    # External API credentials are intentionally opt-in. An admin must grant
    # this permission before a user can create or use a personal key.
    "api_access": False,
    # The Hermes learning companion is opt-in: an admin must grant this
    # permission before Hermes can be enabled on agent profiles or run its
    # learning loop for a user's chats.
    "hermes_companion": False,
    # Authoring agent profiles is opt-in and sits under the
    # users_can_create_models organization ceiling. Granted users build private
    # agents for themselves; publishing to the tenant stays admin-only.
    "agent_authoring": False,
    # User-created knowledge bases and tools are opt-in. Granted users author
    # private, self-owned records; group sharing and tenant-wide management
    # stay admin-only.
    "knowledge_authoring": False,
    "tool_authoring": False,
    # Personalization memory is on by group default, but inert until both the
    # platform owner and the tenant admin have switched memory on.
    "memory_access": True,
}


def default_group_permissions() -> dict[str, bool]:
    return DEFAULT_GROUP_PERMISSIONS.copy()


def normalize_group_permissions(
    permissions: dict[str, bool] | None = None,
    *,
    base: dict[str, bool] | None = None,
) -> dict[str, bool]:
    """Return a full permission map with only known keys.

    ``base`` is the map a partial update is applied to. Without it a caller
    that sends one flag gets the defaults for every flag it omitted, which
    silently revokes grants an administrator never touched. Creation paths pass
    no base and so still start from the defaults.
    """
    normalized = default_group_permissions()
    for source in (base, permissions):
        for key, value in (source or {}).items():
            if key in normalized:
                normalized[key] = bool(value)
    return normalized


class Tenant(BaseModel):
    id: str
    name: str
    slug: str
    custom_domain: str | None = None
    primary_color: str = "#087d8b"
    logo_mark: str = "aperture"
    chat_brand_name: str | None = "Aperture Chat"
    logo_url: str | None = None
    icon_url: str | None = None
    gradient_start: str | None = None
    gradient_end: str | None = None
    text_color: str | None = None


class TenantCreate(BaseModel):
    id: str | None = Field(default=None, min_length=1, max_length=96)
    name: str = Field(min_length=1, max_length=160)
    slug: str = Field(min_length=1, max_length=80)
    custom_domain: str | None = Field(default=None, max_length=253)
    primary_color: str = "#087d8b"
    logo_mark: str = "aperture"
    chat_brand_name: str | None = Field(default="Aperture Chat", max_length=60)
    logo_url: str | None = Field(default=None, max_length=400_000)
    icon_url: str | None = Field(default=None, max_length=400_000)
    gradient_start: str | None = None
    gradient_end: str | None = None
    text_color: str | None = None


class TenantUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    slug: str | None = Field(default=None, min_length=1, max_length=80)
    custom_domain: str | None = Field(default=None, max_length=253)
    primary_color: str | None = None
    logo_mark: str | None = None
    chat_brand_name: str | None = Field(default=None, max_length=60)
    logo_url: str | None = Field(default=None, max_length=400_000)
    icon_url: str | None = Field(default=None, max_length=400_000)
    gradient_start: str | None = None
    gradient_end: str | None = None
    text_color: str | None = None


class TenantSummary(Tenant):
    user_count: int = 0
    group_count: int = 0
    scim_token_count: int = 0


class ScimTokenRecord(BaseModel):
    """Durable SCIM credential metadata; only a SHA-256 digest is stored."""

    id: str
    tenant_id: str
    token_hash: str = Field(min_length=64, max_length=64)
    token_prefix: str
    created_at: str
    created_by: str
    revoked_at: str | None = None


class ScimTokenSummary(BaseModel):
    id: str
    tenant_id: str
    token_prefix: str
    created_at: str
    created_by: str
    revoked_at: str | None = None


class ScimTokenCreateResponse(ScimTokenSummary):
    secret_value: str


_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

# Logo/icon values may be inline data URLs; this cap keeps a single tenant's
# branding bounded (~300 KB decoded) so runtime_state.json cannot grow without
# limit through repeated uploads.
BRANDING_IMAGE_URL_MAX_LENGTH = 400_000


class TenantBrandingUpdateRequest(BaseModel):
    chat_brand_name: str | None = Field(default=None, max_length=60)
    logo_url: str | None = Field(default=None, max_length=BRANDING_IMAGE_URL_MAX_LENGTH)
    icon_url: str | None = Field(default=None, max_length=BRANDING_IMAGE_URL_MAX_LENGTH)
    logo_mark: str | None = None
    primary_color: str | None = None
    custom_domain: str | None = Field(default=None, max_length=253)
    gradient_start: str | None = None
    gradient_end: str | None = None
    text_color: str | None = None

    @field_validator("primary_color", "gradient_start", "gradient_end", "text_color")
    @classmethod
    def _validate_hex_color(cls, value: str | None) -> str | None:
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            return None
        if not _HEX_COLOR_RE.match(candidate):
            raise ValueError("Colors must be 6-digit hex values like #087d8b.")
        return candidate.lower()

    @field_validator("logo_mark")
    @classmethod
    def _validate_logo_mark(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if value not in {"aperture", "custom"}:
            raise ValueError("logo_mark must be either 'aperture' or 'custom'.")
        return value

    @field_validator("logo_url", "icon_url")
    @classmethod
    def _validate_image_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            return None
        if not (candidate.startswith("https://") or candidate.startswith("data:image/")):
            raise ValueError("Logo and icon URLs must be https:// or data:image/ values.")
        return candidate


class PlatformSettings(BaseModel):
    downstream_api_enabled: bool = False
    require_sso_for_admins: bool = False
    users_can_create_models: bool = False
    # Owner-first waterfall: identity configuration belongs to the platform
    # owner unless the owner explicitly delegates it to tenant admins.
    tenant_admins_can_manage_sso: bool = False
    tenant_admins_can_create_admins: bool = False
    default_user_group_enabled: bool = True
    # Zero disables automatic deletion. Positive values are evaluated by the
    # scheduler against UTC timestamps and purged in hard-capped SQL batches.
    audit_retention_days: int = Field(default=0, strict=True, ge=0, le=36_500)
    usage_retention_days: int = Field(default=0, strict=True, ge=0, le=36_500)
    # Top of the memory enablement cascade. Off by default so existing
    # deployments keep byte-identical prompts until an owner opts in.
    memory_enabled: bool = False


class PlatformSettingsUpdateRequest(BaseModel):
    downstream_api_enabled: bool | None = None
    require_sso_for_admins: bool | None = None
    users_can_create_models: bool | None = None
    tenant_admins_can_manage_sso: bool | None = None
    tenant_admins_can_create_admins: bool | None = None
    default_user_group_enabled: bool | None = None
    audit_retention_days: int | None = Field(default=None, strict=True, ge=0, le=36_500)
    usage_retention_days: int | None = Field(default=None, strict=True, ge=0, le=36_500)
    memory_enabled: bool | None = None


class User(BaseModel):
    id: str
    tenant_id: str | None = None
    email: str
    display_name: str
    bio: str | None = None
    firm_name: str | None = None
    website_url: str | None = None
    phone: str | None = None
    avatar_url: str | None = None
    role: Role = Role.USER
    entra_object_id: str | None = None
    group_ids: list[str] = Field(default_factory=list)
    active: bool = True
    last_active: str = "Never"
    auth_method: str = "sso"
    first_run_guide_seen_at: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    access_request_status: Literal["pending", "approved"] | None = None
    access_requested_at: str | None = None
    access_reviewed_at: str | None = None


class AccessRequestCreateRequest(BaseModel):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    email: str = Field(min_length=3, max_length=320)

    @field_validator("first_name", "last_name")
    @classmethod
    def normalize_access_request_name(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized or any(ord(character) < 32 for character in normalized):
            raise ValueError("Name is invalid.")
        return normalized


class AccessRequestCreateResponse(BaseModel):
    status: Literal["pending"] = "pending"
    message: str = "Your access request is pending review."


class AccessRequestReviewRequest(BaseModel):
    role: Role


class UserCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    email: str
    display_name: str
    role: Role = Role.USER
    entra_object_id: str | None = None
    group_ids: list[str] = Field(default_factory=list)
    active: bool = True
    auth_method: str = "sso"


class UserUpdateRequest(BaseModel):
    tenant_id: str | None = None
    email: str | None = None
    display_name: str | None = None
    role: Role | None = None
    entra_object_id: str | None = None
    group_ids: list[str] | None = None
    active: bool | None = None
    auth_method: str | None = None


class AuthProviderOption(BaseModel):
    id: str
    name: str
    provider: str
    protocol: str
    tenant_id: str
    domains: list[str] = Field(default_factory=list)
    enforced: bool = False
    mfa_methods: list[str] = Field(default_factory=list)
    mfa_enforced: bool = False
    mfa_notes: str | None = None
    start_url: str | None = None


class AuthOptionsResponse(BaseModel):
    local_auth_enabled: bool = True
    bootstrap_required: bool = False
    password_auth_enabled: bool = False
    providers: list[AuthProviderOption] = Field(default_factory=list)
    tenant_branding: Tenant | None = None
    supported_sso_protocols: list[str] = Field(default_factory=lambda: ["OIDC"])
    deferred_sso_protocols: list[str] = Field(default_factory=lambda: ["SAML"])


class AuthLoginRequest(BaseModel):
    email: str
    display_name: str | None = None
    provider_id: str | None = None
    auth_method: str = "sso"
    password: str | None = None
    group_ids: list[str] = Field(default_factory=list)


class AuthBootstrapOwnerRequest(BaseModel):
    email: str
    display_name: str
    password: str


class AuthProfileUpdateRequest(BaseModel):
    display_name: str | None = None
    bio: str | None = None
    firm_name: str | None = None
    website_url: str | None = None
    phone: str | None = None
    avatar_url: str | None = None


class AuthPasswordUpdateRequest(BaseModel):
    current_password: str
    new_password: str


class UserApiKeyRecord(BaseModel):
    id: str
    user_id: str
    tenant_id: str | None = None
    key_hash: str
    key_prefix: str
    masked_value: str
    created_at: str
    last_used_at: str | None = None


class UserApiKeyStatus(BaseModel):
    enabled: bool
    has_key: bool
    masked_value: str | None = None
    created_at: str | None = None
    last_used_at: str | None = None


class UserApiKeyCreateResponse(UserApiKeyStatus):
    secret_value: str


class AdminPasswordResetRequest(BaseModel):
    password: str
    temporary: bool = True


class AuthSession(BaseModel):
    user_id: str
    auth_method: str
    sso_config_id: str | None = None
    token: str | None = None
    expires_at: int | None = None
    mfa_assured: bool = False
    mfa_factor_generation: int | None = None


class AuthLoginResponse(BaseModel):
    user: User
    session: AuthSession
    bootstrap: dict[str, Any]
    # True when the account signed in with an admin-issued temporary password
    # and must set its own password before continuing.
    must_change_password: bool = False


class AuthMfaPreauthResponse(BaseModel):
    status: Literal["mfa_required"] = "mfa_required"
    challenge_token: str
    purpose: Literal["verify", "enroll"]
    expires_at: datetime
    methods: list[Literal["totp", "recovery_code"]]
    attempts_remaining: int


class AuthMfaChallengeRequest(BaseModel):
    challenge_token: str = Field(min_length=32, max_length=512)


class AuthMfaPreauthStatusResponse(BaseModel):
    status: Literal["mfa_required"] = "mfa_required"
    purpose: Literal["verify", "enroll"]
    expires_at: datetime
    methods: list[Literal["totp", "recovery_code"]]
    attempts_remaining: int


class AuthMfaVerifyRequest(AuthMfaChallengeRequest):
    method: Literal["totp", "recovery_code"]
    code: str = Field(min_length=6, max_length=64)


class AuthMfaStatus(BaseModel):
    enabled: bool
    tenant_required: bool
    confirmed_at: datetime | None = None
    recovery_codes_remaining: int = 0
    can_disable: bool = False


class AuthMfaEnrollRequest(BaseModel):
    challenge_token: str | None = Field(default=None, min_length=32, max_length=512)
    current_password: str | None = Field(default=None, min_length=1, max_length=1024)


class AuthMfaEnrollmentResponse(BaseModel):
    enrollment_token: str
    secret: str
    provisioning_uri: str
    expires_at: datetime


class AuthMfaEnrollmentConfirmRequest(BaseModel):
    enrollment_token: str = Field(min_length=32, max_length=512)
    code: str = Field(min_length=6, max_length=16)


class AuthMfaEnrollmentConfirmResponse(AuthLoginResponse):
    recovery_codes: list[str]


class AuthMfaSensitiveActionRequest(BaseModel):
    method: Literal["totp", "recovery_code"]
    code: str = Field(min_length=6, max_length=64)


class AuthMfaRecoveryCodesResponse(BaseModel):
    recovery_codes: list[str]


class TenantMfaPolicyResponse(BaseModel):
    tenant_id: str
    required: bool
    generation: int


class TenantMfaPolicyUpdateRequest(BaseModel):
    required: bool
    expected_generation: int = Field(ge=0, le=(1 << 31) - 1)


class AdminMfaResetResponse(BaseModel):
    status: Literal["reset"] = "reset"
    factor_existed: bool


class Group(BaseModel):
    id: str
    tenant_id: str
    name: str
    distinguished_name: str
    entra_object_id: str
    synced: bool = True
    user_count: int = 0
    default_group: bool = False
    permissions: dict[str, bool] = Field(default_factory=default_group_permissions)

    @model_validator(mode="after")
    def include_default_permissions(self) -> "Group":
        self.permissions = normalize_group_permissions(self.permissions)
        return self


DEFAULT_USER_GROUP_ID = "group-default-users"
DEFAULT_USER_GROUP_NAME = "Default Users"


def default_user_group_for_tenant(tenant_id: str) -> Group:
    group_id = (
        DEFAULT_USER_GROUP_ID
        if tenant_id == "tenant-example"
        else f"{DEFAULT_USER_GROUP_ID}-{hashlib.sha256(tenant_id.encode('utf-8')).hexdigest()[:12]}"
    )
    return Group(
        id=group_id,
        tenant_id=tenant_id,
        name=DEFAULT_USER_GROUP_NAME,
        distinguished_name="Protected default platform group",
        entra_object_id=f"platform-{group_id}",
        synced=True,
        user_count=0,
        default_group=True,
        permissions=default_group_permissions(),
    )


class GroupCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    name: str
    distinguished_name: str | None = None
    entra_object_id: str | None = None
    synced: bool = True
    user_count: int = 0
    permissions: dict[str, bool] = Field(default_factory=default_group_permissions)


class GroupUpdateRequest(BaseModel):
    name: str | None = None
    distinguished_name: str | None = None
    entra_object_id: str | None = None
    synced: bool | None = None
    user_count: int | None = None
    permissions: dict[str, bool] | None = None


class GroupBulkCreateRequest(BaseModel):
    groups: list[GroupCreateRequest]


class GroupBulkDeleteRequest(BaseModel):
    group_ids: list[str]


class Provider(BaseModel):
    id: str
    name: str
    kind: str
    region: str
    base_url: str | None = None
    auth_type: str = "api-key"
    auth_metadata: dict[str, Any] = Field(default_factory=dict)
    connected: bool = True
    model_count: int = 0
    enabled_model_count: int = 0
    last_sync: str = "1 minute ago"
    status_message: str | None = None


class ProviderCreateRequest(BaseModel):
    id: str | None = None
    name: str
    kind: str
    region: str
    base_url: str | None = None
    auth_type: str = "api-key"
    auth_metadata: dict[str, Any] = Field(default_factory=dict)
    connected: bool = True
    model_count: int = 0
    enabled_model_count: int = 0
    last_sync: str = "Just now"
    status_message: str | None = None


class ProviderUpdateRequest(BaseModel):
    name: str | None = None
    kind: str | None = None
    region: str | None = None
    base_url: str | None = None
    auth_type: str | None = None
    auth_metadata: dict[str, Any] | None = None
    connected: bool | None = None
    model_count: int | None = None
    enabled_model_count: int | None = None
    last_sync: str | None = None
    status_message: str | None = None


class ModelCapabilities(BaseModel):
    """Provider-reported capability metadata captured at model sync.

    Populated from the provider catalog (e.g. OpenRouter's
    ``supported_parameters`` and ``architecture`` fields) so feature gates can
    key off what a model actually supports instead of hardcoded provider or
    family lists. Empty lists mean "not reported", not "not supported" —
    consumers must fall back to family heuristics when data is absent.
    """

    supported_parameters: list[str] = Field(default_factory=list)
    input_modalities: list[str] = Field(default_factory=list)
    output_modalities: list[str] = Field(default_factory=list)


class ModelConfig(BaseModel):
    id: str
    tenant_id: str | None = None
    provider_id: str
    provider_name: str
    name: str
    upstream_model_id: str | None = None
    system_prompt: str | None = None
    meta_prompt: str | None = None
    knowledge_config_ids: list[str] = Field(default_factory=list)
    tool_config_ids: list[str] = Field(default_factory=list)
    platform_enabled: bool = True
    tenant_restricted: bool = False
    group_ids: list[str] = Field(default_factory=list)
    notes: str | None = None
    is_custom: bool = False
    created_by: str | None = None
    context_window: int | None = None
    visibility: str = "organization"
    agentic_companion: str | None = None
    prompt_template_ids: list[str] = Field(default_factory=list)
    skill_file_ids: list[str] = Field(default_factory=list)
    admin_delete_locked: bool = False
    content_filter_ids: list[str] = Field(default_factory=list)
    capabilities: ModelCapabilities | None = None


class ModelCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    provider_id: str
    name: str
    upstream_model_id: str | None = None
    system_prompt: str | None = None
    meta_prompt: str | None = None
    knowledge_config_ids: list[str] = Field(default_factory=list)
    tool_config_ids: list[str] = Field(default_factory=list)
    platform_enabled: bool = True
    tenant_restricted: bool = False
    group_ids: list[str] = Field(default_factory=list)
    notes: str | None = None
    is_custom: bool = False
    created_by: str | None = None
    context_window: int | None = None
    visibility: str = "organization"
    agentic_companion: str | None = None
    prompt_template_ids: list[str] = Field(default_factory=list)
    skill_file_ids: list[str] = Field(default_factory=list)
    admin_delete_locked: bool = False
    content_filter_ids: list[str] = Field(default_factory=list)


class ModelUpdateRequest(BaseModel):
    tenant_id: str | None = None
    provider_id: str | None = None
    name: str | None = None
    upstream_model_id: str | None = None
    system_prompt: str | None = None
    meta_prompt: str | None = None
    knowledge_config_ids: list[str] | None = None
    tool_config_ids: list[str] | None = None
    platform_enabled: bool | None = None
    tenant_restricted: bool | None = None
    group_ids: list[str] | None = None
    notes: str | None = None
    is_custom: bool | None = None
    created_by: str | None = None
    context_window: int | None = None
    visibility: str | None = None
    agentic_companion: str | None = None
    prompt_template_ids: list[str] | None = None
    skill_file_ids: list[str] | None = None
    admin_delete_locked: bool | None = None
    content_filter_ids: list[str] | None = None


class AdminModelAccessUpdateRequest(BaseModel):
    group_ids: list[str]


class ContentFilterRule(BaseModel):
    id: str
    label: str
    pattern: str
    action: str = "redact"  # "redact" rewrites matches; "block" refuses the traffic
    applies_to: str = "input"  # "input" | "output" | "both"


class ContentFilter(BaseModel):
    id: str
    tenant_id: str | None = None
    name: str
    description: str = ""
    builtin: bool = False
    rules: list[ContentFilterRule] = Field(default_factory=list)
    created_by: str | None = None
    updated_at: str = "Just now"


class ContentFilterCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    name: str
    description: str = ""
    rules: list[ContentFilterRule] = Field(default_factory=list)


class ContentFilterUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    rules: list[ContentFilterRule] | None = None


class ContentFilterPreviewRequest(BaseModel):
    rules: list[ContentFilterRule] = Field(default_factory=list)
    sample: str = ""


class ContentFilterRuleMatchSummary(BaseModel):
    rule_id: str
    label: str
    action: str
    match_count: int


class ContentFilterPreviewResponse(BaseModel):
    matches: list[ContentFilterRuleMatchSummary] = Field(default_factory=list)
    redacted_sample: str = ""
    would_block: bool = False


class ModelContentFiltersUpdateRequest(BaseModel):
    content_filter_ids: list[str]


class PromptTemplate(BaseModel):
    id: str
    tenant_id: str
    name: str
    description: str = ""
    content: str
    category: str = "general"
    variables: list[str] = Field(default_factory=list)
    group_ids: list[str] = Field(default_factory=list)
    enabled: bool = True
    updated_at: str = "Just now"


class PromptTemplateCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    name: str
    description: str = ""
    content: str
    category: str = "general"
    variables: list[str] = Field(default_factory=list)
    group_ids: list[str] = Field(default_factory=list)
    enabled: bool = True


class PromptTemplateUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    content: str | None = None
    category: str | None = None
    variables: list[str] | None = None
    group_ids: list[str] | None = None
    enabled: bool | None = None


class SkillFile(BaseModel):
    id: str
    tenant_id: str
    name: str
    description: str = ""
    content: str
    category: str = "workflow"
    format: str = "markdown"
    version: str = "1.0.0"
    group_ids: list[str] = Field(default_factory=list)
    enabled: bool = True
    updated_at: str = "Just now"


class CompanionMemory(BaseModel):
    """A durable note the Hermes companion saved from a real conversation.

    Memories are captured server-side from ```hermes-memory blocks the model
    emits, persisted per agent profile, and injected into that profile's
    future runs — the recursive-learning loop. Never synthesized.
    """

    id: str
    tenant_id: str
    profile_id: str
    content: str
    created_by: str
    created_at: str
    source_thread_id: str | None = None


class SkillFileCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    name: str
    description: str = ""
    content: str
    category: str = "workflow"
    format: str = "markdown"
    version: str = "1.0.0"
    group_ids: list[str] = Field(default_factory=list)
    enabled: bool = True


class SkillFileUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    content: str | None = None
    category: str | None = None
    format: str | None = None
    version: str | None = None
    group_ids: list[str] | None = None
    enabled: bool | None = None


class ProviderModelSyncResponse(BaseModel):
    provider: Provider
    models: list[ModelConfig] = Field(default_factory=list)
    imported_count: int = 0
    updated_count: int = 0
    removed_count: int = 0
    source: str
    message: str


class ProviderKey(BaseModel):
    id: str
    provider_id: str
    tenant_id: str | None = None
    provider_name: str
    name: str
    environment: str
    status: str = "Active"
    last_rotated: str
    expires: str
    masked_value: str = "••••••••••"

    @field_validator("expires")
    @classmethod
    def validate_expires(cls, value: str) -> str:
        parse_provider_credential_expiry(value)
        return value

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        if value not in {"Active", "Inactive", "Expired"}:
            raise ValueError(
                "Provider key status must be Active, Inactive, or Expired."
            )
        return value


class ProviderKeySecret(ProviderKey):
    secret_value: str


class ProviderKeyCreateRequest(BaseModel):
    id: str | None = None
    provider_id: str
    tenant_id: str | None = None
    name: str
    environment: str = "Production"
    status: str = "Active"
    expires: str = "Not set"
    secret_value: str

    @field_validator("expires")
    @classmethod
    def validate_expires(cls, value: str) -> str:
        parse_provider_credential_expiry(value)
        return value

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        if value not in {"Active", "Inactive", "Expired"}:
            raise ValueError(
                "Provider key status must be Active, Inactive, or Expired."
            )
        return value


class TenantScopedSecretRecord(BaseModel):
    id: str
    tenant_id: str
    enabled: bool = True
    settings: dict[str, Any] = Field(default_factory=dict)
    secret_set: bool = False
    masked_secret: str | None = None


class Connector(BaseModel):
    id: str
    name: str
    category: str
    platform_enabled: bool = True
    tenant_enabled: bool = True
    configured_by: Role = Role.PLATFORM_OWNER
    scopes: list[str] = Field(default_factory=list)
    secret_visible_to_admin: bool = False


class ConnectorUpdateRequest(BaseModel):
    name: str | None = None
    category: str | None = None
    platform_enabled: bool | None = None
    tenant_enabled: bool | None = None
    configured_by: Role | None = None
    scopes: list[str] | None = None
    secret_visible_to_admin: bool | None = None


class ConnectorConfig(TenantScopedSecretRecord):
    connector_id: str
    auth_type: str = "oauth"
    scopes: list[str] = Field(default_factory=list)


class ConnectorConfigCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    connector_id: str
    enabled: bool = True
    auth_type: str = "oauth"
    scopes: list[str] = Field(default_factory=list)
    settings: dict[str, Any] = Field(default_factory=dict)
    secret_value: str | None = None
    # Service-account password for iManage's resource-owner password grant;
    # stored in the "connector-password" vault namespace and never echoed back.
    service_password: str | None = None


class ConnectorConfigUpdateRequest(BaseModel):
    connector_id: str | None = None
    enabled: bool | None = None
    auth_type: str | None = None
    scopes: list[str] | None = None
    settings: dict[str, Any] | None = None
    secret_value: str | None = None
    service_password: str | None = None
    replace_settings: bool = False
    clear_secret: bool = False
    clear_oauth: bool = False
    clear_service_password: bool = False


class SsoConfig(TenantScopedSecretRecord):
    provider: str
    issuer_url: str
    client_id: str
    scopes: list[str] = Field(default_factory=list)
    mapped_groups: dict[str, str] = Field(default_factory=dict)


class SsoConfigCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    provider: str
    issuer_url: str
    client_id: str
    enabled: bool = True
    scopes: list[str] = Field(default_factory=list)
    mapped_groups: dict[str, str] = Field(default_factory=dict)
    settings: dict[str, Any] = Field(default_factory=dict)
    client_secret: str | None = None


class SsoConfigUpdateRequest(BaseModel):
    provider: str | None = None
    issuer_url: str | None = None
    client_id: str | None = None
    enabled: bool | None = None
    scopes: list[str] | None = None
    mapped_groups: dict[str, str] | None = None
    settings: dict[str, Any] | None = None
    client_secret: str | None = None


class KnowledgeConfig(TenantScopedSecretRecord):
    name: str
    source_type: str
    connector_config_id: str | None = None
    acl_group_ids: list[str] = Field(default_factory=list)
    owner_user_id: str | None = None
    # Matter binding is an additional organizational reference assigned only
    # through the membership-gated matters router; it never widens access.
    matter_id: str | None = None


class KnowledgeDocument(BaseModel):
    id: str
    knowledge_config_id: str
    tenant_id: str
    name: str
    source_uri: str
    source_type: str
    status: str = "indexed"
    chunk_count: int = 0
    acl_group_ids: list[str] = Field(default_factory=list)
    updated_at: str
    citation_required: bool = True


class KnowledgeChunk(BaseModel):
    id: str
    knowledge_config_id: str
    document_id: str
    tenant_id: str
    source_name: str
    source_uri: str
    source_type: str
    text: str
    ordinal: int = 0
    score: float = 0
    page_start: int | None = Field(default=None, ge=1)
    page_end: int | None = Field(default=None, ge=1)
    locator: str | None = None
    acl_group_ids: list[str] = Field(default_factory=list)
    updated_at: str


class KnowledgeSyncRequest(BaseModel):
    force: bool = False


class KnowledgeSearchRequest(BaseModel):
    query: str
    knowledge_config_ids: list[str] = Field(default_factory=list)
    agent_profile_id: str | None = None
    limit: int = 4


class KnowledgeWebSourceCreateRequest(BaseModel):
    name: str
    url: str
    text: str | None = None


class KnowledgeApiSourceCreateRequest(BaseModel):
    name: str
    base_url: str
    auth_type: str = "api-key"
    secret_value: str | None = None
    description: str | None = None
    source_label: str | None = None
    resource_id: str | None = None
    request_method: str | None = None
    header_notes: str | None = None
    credential_name: str | None = None
    credential_location: str | None = None
    client_id: str | None = None
    authorization_url: str | None = None
    token_url: str | None = None
    callback_url: str | None = None
    scopes: list[str] = Field(default_factory=list)
    audience: str | None = None


class KnowledgeSyncResponse(BaseModel):
    config: KnowledgeConfig
    documents: list[KnowledgeDocument]
    status: str
    synced_at: str
    provider_status: str = "cached"
    provider_message: str | None = None


class KnowledgeSearchResponse(BaseModel):
    query: str
    knowledge_config_ids: list[str]
    hits: list[KnowledgeChunk]


class KnowledgeConfigCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    name: str
    source_type: str
    connector_config_id: str | None = None
    enabled: bool = True
    acl_group_ids: list[str] = Field(default_factory=list)
    owner_user_id: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    secret_value: str | None = None


class KnowledgeConfigUpdateRequest(BaseModel):
    name: str | None = None
    source_type: str | None = None
    connector_config_id: str | None = None
    enabled: bool | None = None
    acl_group_ids: list[str] | None = None
    owner_user_id: str | None = None
    settings: dict[str, Any] | None = None
    secret_value: str | None = None


class ToolConfig(TenantScopedSecretRecord):
    name: str
    tool_type: str
    endpoint_url: str | None = None
    approval_required: bool = True
    allowed_group_ids: list[str] = Field(default_factory=list)
    # Set only for user-authored tools. An owner-scoped tool with no group
    # shares stays private to its author; admin-created tools leave this None
    # and keep today's tenant-wide semantics.
    owner_user_id: str | None = None


class ToolConfigCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    name: str
    tool_type: str
    endpoint_url: str | None = None
    enabled: bool = True
    approval_required: bool = True
    allowed_group_ids: list[str] = Field(default_factory=list)
    settings: dict[str, Any] = Field(default_factory=dict)
    secret_value: str | None = None


class ToolConfigUpdateRequest(BaseModel):
    name: str | None = None
    tool_type: str | None = None
    endpoint_url: str | None = None
    enabled: bool | None = None
    approval_required: bool | None = None
    allowed_group_ids: list[str] | None = None
    settings: dict[str, Any] | None = None
    secret_value: str | None = None


class McpToolSummary(BaseModel):
    name: str
    description: str | None = None
    input_schema: dict[str, Any] | None = None


class McpHealthResponse(BaseModel):
    tool_config_id: str
    name: str
    transport: str
    command: str | None = None
    status: str
    message: str
    tools: list[McpToolSummary] = Field(default_factory=list)
    server_info: dict[str, Any] = Field(default_factory=dict)


class McpToolCallRequest(BaseModel):
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    label: str | None = None


class CustomScriptRunRequest(BaseModel):
    input: str = ""


class CustomScriptArtifact(BaseModel):
    filename: str
    mime_type: str
    size_bytes: int
    download_url: str


class CustomScriptRunResponse(BaseModel):
    tool_config_id: str = ""
    name: str = ""
    status: str  # "ok" | "error" | "timeout"
    output: str = ""
    error: str = ""
    exit_code: int | None = None
    duration_ms: int = 0
    truncated: bool = False
    artifacts: list[CustomScriptArtifact] = Field(default_factory=list)


class CustomScriptPreviewRequest(BaseModel):
    script: str
    input: str = ""
    timeout_seconds: int = 10


class McpToolCallResponse(BaseModel):
    tool_config_id: str
    name: str
    transport: str
    command: str | None = None
    tool_name: str
    label: str | None = None
    status: str
    message: str
    result_text: str | None = None
    structured_content: dict[str, Any] | list[Any] | str | int | float | bool | None = None
    is_error: bool = False


class AuditEvent(BaseModel):
    id: str
    tenant_id: str | None = None
    actor_id: str
    actor_name: str = ""
    actor_role: str = ""
    action: str
    action_type: str = ""
    target: str
    target_type: str = "resource"
    target_name: str = ""
    detail: str = ""
    created_at: datetime = Field(default_factory=now_utc)
    redacted: bool = True
    metadata: dict[str, Any] = Field(default_factory=dict)
    # Derived on read by app.core.audit_severity — never trusted from storage,
    # so persisted events written before the classifier existed load unchanged.
    severity: str = ""
    severity_reason: str = ""


class SecurityAlert(BaseModel):
    """A rule-based DLP/misuse flag raised on a user prompt.

    Snippets are pre-redacted by the scanner; the sensitive value itself is
    never stored on the alert.
    """

    id: str
    tenant_id: str | None = None
    user_id: str
    user_name: str = ""
    rule_id: str
    rule_label: str
    category: str = "dlp"
    severity: str = "medium"
    snippet: str = ""
    model_id: str = ""
    thread_id: str | None = None
    surface: str = "chat"
    created_at: datetime = Field(default_factory=now_utc)
    acknowledged: bool = False
    acknowledged_by: str | None = None
    acknowledged_at: datetime | None = None


class SecurityAlertUpdateRequest(BaseModel):
    acknowledged: bool = True


class AlertNotificationArchiveRequest(BaseModel):
    archived: bool = True


class UsageRecord(BaseModel):
    """One real model completion, recorded durably for usage analytics.

    Token fields are provider-reported only and stay ``None`` when the
    provider reported nothing — usage numbers are never synthesized.
    """

    id: str
    tenant_id: str | None = None
    user_id: str
    user_name: str = ""
    user_role: str = ""
    model_id: str
    provider_name: str = ""
    surface: str = "chat"  # chat | draft | gateway | agent | automation | image
    message_count: int = 1
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    thread_id: str | None = None
    source: str = "live"  # live | backfill
    created_at: datetime = Field(default_factory=now_utc)


class TenantUsageBudget(BaseModel):
    """One tenant's token or provider-reported-spend ceiling."""

    tenant_id: str
    budget_unit: Literal["tokens", "usd"] = "tokens"
    budget_period: Literal["day", "week", "month"] = "day"
    daily_token_limit: int = Field(strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    spend_limit_nanos: int = Field(default=0, strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    updated_at: datetime = Field(default_factory=now_utc)
    updated_by: str | None = None


class TenantUsageBudgetUpdateRequest(BaseModel):
    """Granular workspace budget update with legacy daily-token compatibility."""

    budget_unit: Literal["tokens", "usd"] = "tokens"
    budget_period: Literal["day", "week", "month"] = "day"
    limit_value: Decimal | None = Field(default=None, ge=0)
    daily_token_limit: int | None = Field(
        default=None,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )

    @model_validator(mode="after")
    def validate_limit_shape(self) -> TenantUsageBudgetUpdateRequest:
        if self.limit_value is None and self.daily_token_limit is None:
            raise ValueError("limit_value is required")
        if self.limit_value is not None and self.daily_token_limit is not None:
            raise ValueError("send limit_value or daily_token_limit, not both")
        value = self.resolved_limit_value()
        if self.budget_unit == "tokens":
            if value != value.to_integral_value():
                raise ValueError("token budgets require a whole-number limit_value")
            if value > SIGNED_BIGINT_MAX:
                raise ValueError("token budget exceeds the supported maximum")
        else:
            nanos = value * NANODOLLARS_PER_DOLLAR
            if nanos != nanos.to_integral_value():
                raise ValueError("USD budgets support at most nine decimal places")
            if nanos > SIGNED_BIGINT_MAX:
                raise ValueError("USD budget exceeds the supported maximum")
        return self

    def resolved_limit_value(self) -> Decimal:
        if self.limit_value is not None:
            return self.limit_value
        return Decimal(self.daily_token_limit or 0)

    def resolved_token_limit(self) -> int:
        return int(self.resolved_limit_value()) if self.budget_unit == "tokens" else 0

    def resolved_spend_limit_nanos(self) -> int:
        if self.budget_unit != "usd":
            return 0
        return int(self.resolved_limit_value() * NANODOLLARS_PER_DOLLAR)


class TenantDailyUsage(BaseModel):
    """Authoritative enforcement aggregate for one tenant and UTC date."""

    tenant_id: str
    usage_date: date
    reported_tokens: int = Field(default=0, strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    reported_tokens_overflowed: bool = Field(default=False, strict=True)
    reported_cost_nanos: int = Field(default=0, strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    reported_cost_overflowed: bool = Field(default=False, strict=True)
    metered_completions: int = Field(default=0, strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    unmetered_completions: int = Field(
        default=0,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )
    cost_metered_completions: int = Field(
        default=0,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )
    cost_unmetered_completions: int = Field(
        default=0,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )
    updated_at: datetime = Field(default_factory=now_utc)

    @model_validator(mode="after")
    def validate_reported_overflow_shape(self) -> TenantDailyUsage:
        if self.reported_tokens_overflowed and self.reported_tokens != SIGNED_BIGINT_MAX:
            raise ValueError("overflowed daily usage must be saturated at signed BIGINT max")
        if self.reported_cost_overflowed and self.reported_cost_nanos != SIGNED_BIGINT_MAX:
            raise ValueError("overflowed daily cost must be saturated at signed BIGINT max")
        return self


class PrincipalUsageBudget(BaseModel):
    """A per-user or per-group UTC token allocation inside the tenant
    ceiling; zero means no cap for that principal."""

    tenant_id: str
    principal_type: Literal["user", "group"]
    principal_id: str
    budget_period: Literal["day", "week", "month"] = "day"
    daily_token_limit: int = Field(strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    updated_at: datetime = Field(default_factory=now_utc)
    updated_by: str | None = None


class PrincipalUsageBudgetUpdateRequest(BaseModel):
    principal_type: Literal["user", "group"]
    principal_id: str = Field(min_length=1, max_length=255)
    budget_period: Literal["day", "week", "month"] = "day"
    daily_token_limit: int = Field(strict=True, ge=0, le=SIGNED_BIGINT_MAX)


class PrincipalDailyUsage(BaseModel):
    """Authoritative per-principal usage aggregate for one UTC date."""

    tenant_id: str
    principal_type: Literal["user", "group"]
    principal_id: str
    usage_date: date
    reported_tokens: int = Field(default=0, strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    reported_tokens_overflowed: bool = Field(default=False, strict=True)
    metered_completions: int = Field(default=0, strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    unmetered_completions: int = Field(
        default=0,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )
    updated_at: datetime = Field(default_factory=now_utc)


class PrincipalBudgetAllocation(BaseModel):
    """Admin-facing allocation row with current UTC-period usage."""

    principal_type: Literal["user", "group"]
    principal_id: str
    display_name: str
    budget_period: Literal["day", "week", "month"] = "day"
    daily_token_limit: int = Field(strict=True, ge=0, le=SIGNED_BIGINT_MAX)
    period_start: date
    period_end: date
    reported_tokens: int = Field(default=0, strict=True, ge=0)
    metered_completions: int = Field(default=0, strict=True, ge=0)
    updated_at: datetime = Field(default_factory=now_utc)
    updated_by: str | None = None


class MyUsageBudgetCap(BaseModel):
    """One cap that applies to the requesting user (their own or a group's)."""

    scope: Literal["user", "group"]
    label: str
    budget_period: Literal["day", "week", "month", "lifetime"] = "day"
    daily_token_limit: int = Field(strict=True, ge=0)
    reported_tokens: int = Field(default=0, strict=True, ge=0)
    period_start: date
    period_end: date


class MyUsageBudgetResponse(BaseModel):
    """Honest personal quota view: only finite caps that actually apply."""

    caps: list[MyUsageBudgetCap] = Field(default_factory=list)
    usage_date: date


class TenantUsagePermit(BaseModel):
    """Privacy-minimal admission state for one tenant-scoped request."""

    permit_id: str
    request_id_hash: str = Field(min_length=64, max_length=64)
    tenant_id: str
    admission_date: date
    status: Literal["started", "completed", "failed", "abandoned"]
    acquired_at: datetime
    closed_at: datetime | None = None


class TenantUsageCompletionEvent(BaseModel):
    """Exactly-once accounting result for one successful upstream completion."""

    permit_id: str
    completion_id_hash: str = Field(min_length=64, max_length=64)
    usage_record_id: str
    usage_record_binding_hash: str = Field(min_length=64, max_length=64)
    completion_date: date
    completed_at: datetime
    metering_status: Literal["reported", "unmetered"]
    prompt_tokens: int | None = Field(
        default=None,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )
    completion_tokens: int | None = Field(
        default=None,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )
    total_tokens: int | None = Field(
        default=None,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )
    reported_cost_nanos: int | None = Field(
        default=None,
        strict=True,
        ge=0,
        le=SIGNED_BIGINT_MAX,
    )

    @model_validator(mode="after")
    def validate_metering_shape(self) -> TenantUsageCompletionEvent:
        if self.metering_status == "reported" and self.total_tokens is None:
            raise ValueError("reported completion events require total_tokens")
        if self.metering_status == "unmetered" and self.total_tokens is not None:
            raise ValueError("unmetered completion events cannot have total_tokens")
        if (
            self.total_tokens is not None
            and self.prompt_tokens is not None
            and self.completion_tokens is not None
            and self.total_tokens != self.prompt_tokens + self.completion_tokens
        ):
            raise ValueError("total_tokens must equal prompt_tokens plus completion_tokens")
        return self


ALERT_SEVERITY_LEVELS = ("info", "warning", "critical")


class AlertRule(BaseModel):
    """A custom watch rule over audit events, evaluated as events are recorded.

    Tenant-scope rules (admin-created) match only events a tenant admin could
    see; platform-scope rules (owner-created) match everything.
    """

    id: str
    scope: str = "platform"  # "platform" | "tenant"
    tenant_id: str | None = None
    name: str
    description: str = ""
    enabled: bool = True
    # Exact action names or prefix globs such as "security.*"; empty = any.
    action_patterns: list[str] = Field(default_factory=list)
    min_severity: str = "info"
    actor_ids: list[str] = Field(default_factory=list)  # empty = any actor
    threshold_count: int = 1  # 1 = fire per matching event
    window_minutes: int = 60
    cooldown_minutes: int = 60
    recipients: list[str] = Field(default_factory=list)  # empty = in-app log only
    created_by: str
    created_by_name: str = ""
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)
    last_triggered_at: datetime | None = None


class AlertRuleCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    enabled: bool = True
    action_patterns: list[str] = Field(default_factory=list, max_length=20)
    min_severity: str = "info"
    actor_ids: list[str] = Field(default_factory=list, max_length=50)
    threshold_count: int = Field(default=1, ge=1, le=1000)
    window_minutes: int = Field(default=60, ge=1, le=1440)
    cooldown_minutes: int = Field(default=60, ge=0, le=10080)
    recipients: list[str] = Field(default_factory=list, max_length=20)


class AlertRuleUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    enabled: bool | None = None
    action_patterns: list[str] | None = Field(default=None, max_length=20)
    min_severity: str | None = None
    actor_ids: list[str] | None = Field(default=None, max_length=50)
    threshold_count: int | None = Field(default=None, ge=1, le=1000)
    window_minutes: int | None = Field(default=None, ge=1, le=1440)
    cooldown_minutes: int | None = Field(default=None, ge=0, le=10080)
    recipients: list[str] | None = Field(default=None, max_length=20)


class AlertNotification(BaseModel):
    """One alert-rule trigger and its honest delivery status."""

    id: str
    rule_id: str
    rule_name: str
    scope: str = "platform"
    tenant_id: str | None = None
    event_id: str
    event_action: str
    event_severity: str = "info"
    actor_id: str = ""
    actor_name: str = ""
    # Built from already-redacted audit fields; never carries secrets.
    summary: str = ""
    matched_count: int = 1
    recipients: list[str] = Field(default_factory=list)
    status: str = "queued"  # queued | sent | failed | not_configured | logged
    status_detail: str = ""
    attempts: int = 0
    # View management only: an archived delivery stays in the durable history
    # and exports, it is just hidden from the default console list.
    archived: bool = False
    created_at: datetime = Field(default_factory=now_utc)
    delivered_at: datetime | None = None


class EmailSettings(BaseModel):
    """Non-secret SMTP configuration; the password lives in the encrypted vault."""

    host: str = ""
    port: int = 587
    security: str = "starttls"  # starttls | ssl | none
    username: str = ""
    from_address: str = ""
    password_set: bool = False
    masked_password: str = ""
    last_test_at: str | None = None
    last_test_status: str | None = None
    updated_at: str | None = None


class EmailSettingsUpdateRequest(BaseModel):
    host: str | None = Field(default=None, max_length=253)
    port: int | None = Field(default=None, ge=1, le=65535)
    security: str | None = None
    username: str | None = Field(default=None, max_length=254)
    password: str | None = Field(default=None, max_length=500)  # write-only; never echoed
    from_address: str | None = Field(default=None, max_length=254)


class EmailTestRequest(BaseModel):
    recipient: str = Field(min_length=3, max_length=254)


class UserPromptRecord(BaseModel):
    """One saved prompt and its corresponding real model-output preview."""

    id: str
    user_id: str
    user_name: str = ""
    user_email: str = ""
    user_role: Role = Role.USER
    thread_id: str
    thread_title: str
    model_id: str
    content: str
    created_at: str
    created_at_iso: str | None = None
    response_message_id: str | None = None
    response_content: str | None = None
    response_created_at: str | None = None
    response_created_at_iso: str | None = None
    response_status: str | None = None
    response_truncated: bool = False
    # Freshly signed viewer links for every generated image embedded in the
    # saved output. The tokens inside the persisted markdown expire; these are
    # re-signed at read time so auditors can always see what was generated.
    response_images: list[str] = []
    alert_count: int = 0


class MemoryKind(StrEnum):
    """Why a memory exists, which decides how it is recalled.

    PREFERENCE and DIRECTIVE are standing instructions and are always injected;
    the remaining kinds are contextual and are injected only when relevant.
    """

    PREFERENCE = "preference"
    DIRECTIVE = "directive"
    PROFILE = "profile"
    PROJECT = "project"
    FACT = "fact"


STANDING_MEMORY_KINDS = {MemoryKind.PREFERENCE, MemoryKind.DIRECTIVE}

MEMORY_CONTENT_MAX_CHARS = 400


class UserMemory(BaseModel):
    id: str
    tenant_id: str
    # The isolation key. Every read path filters on this and never bypasses it,
    # including for platform owners.
    owner_user_id: str
    kind: MemoryKind = MemoryKind.FACT
    content: str
    source: str = "inferred"  # "explicit" | "inferred"
    source_thread_id: str | None = None
    confidence: float = 0.5
    pinned: bool = False
    use_count: int = 0
    last_used_at: str | None = None
    expires_at: str | None = None
    active: bool = True
    created_at: str = ""
    updated_at: str = ""


class UserMemoryCreateRequest(BaseModel):
    content: str
    kind: MemoryKind = MemoryKind.PREFERENCE
    pinned: bool = False


class UserMemoryUpdateRequest(BaseModel):
    content: str | None = None
    kind: MemoryKind | None = None
    pinned: bool | None = None


class TenantMemoryPolicy(BaseModel):
    # One policy per tenant; the id mirrors tenant_id so the record can ride
    # the generic identity/config snapshot machinery, which keys rows by id.
    id: str = ""
    tenant_id: str
    enabled: bool = False
    auto_capture_enabled: bool = True
    retention_days: int = 365
    max_memories_per_user: int = 200
    excluded_kinds: list[MemoryKind] = Field(default_factory=list)
    updated_at: str = ""
    updated_by: str | None = None

    @model_validator(mode="after")
    def _default_id(self) -> "TenantMemoryPolicy":
        if not self.id:
            object.__setattr__(self, "id", self.tenant_id)
        return self


class TenantMemoryPolicyUpdateRequest(BaseModel):
    enabled: bool | None = None
    auto_capture_enabled: bool | None = None
    retention_days: int | None = Field(default=None, ge=1, le=3650)
    max_memories_per_user: int | None = Field(default=None, ge=1, le=2000)
    excluded_kinds: list[MemoryKind] | None = None


class RetentionRule(BaseModel):
    """Per-tag retention override; the longest applicable retention wins."""

    id: str
    tag_namespace: str
    # None applies the rule to every tag in the namespace.
    tag_key: str | None = None
    retention_days: int = Field(strict=True, ge=1, le=36_500)
    action: Literal["purge", "archive_then_purge"] = "purge"
    note: str = ""


class TenantRetentionPolicy(BaseModel):
    # One policy per tenant; the id mirrors tenant_id so the record can ride
    # the generic identity/config snapshot machinery, which keys rows by id.
    id: str = ""
    tenant_id: str
    enabled: bool = False
    # Zero keeps the tenant-wide default disabled; per-tag rules may still
    # govern individual threads. A thread matching nothing is never disposed.
    chat_retention_days: int = Field(default=0, strict=True, ge=0, le=36_500)
    retention_basis: Literal["last_activity", "created"] = "last_activity"
    action: Literal["purge", "archive_then_purge"] = "purge"
    grace_days: int = Field(default=0, strict=True, ge=0, le=365)
    notify_admins: bool = False
    mcp_tagging_enabled: bool = False
    # Tags chats whose completions carried uploaded files, so document-bearing
    # conversations stay identifiable even when no MCP connection was used.
    attachment_tagging_enabled: bool = False
    # Classifies each chat once into the curated subject taxonomy using the
    # chat's own model (one small background completion per conversation).
    subject_tagging_enabled: bool = False
    external_tags_enabled: bool = False
    rules: list[RetentionRule] = Field(default_factory=list)
    last_swept_at: str | None = None
    updated_at: str = ""
    updated_by: str | None = None

    @model_validator(mode="after")
    def _default_id(self) -> "TenantRetentionPolicy":
        if not self.id:
            object.__setattr__(self, "id", self.tenant_id)
        return self


class TenantRetentionPolicyUpdateRequest(BaseModel):
    enabled: bool | None = None
    chat_retention_days: int | None = Field(default=None, ge=0, le=36_500)
    retention_basis: Literal["last_activity", "created"] | None = None
    action: Literal["purge", "archive_then_purge"] | None = None
    grace_days: int | None = Field(default=None, ge=0, le=365)
    notify_admins: bool | None = None
    mcp_tagging_enabled: bool | None = None
    attachment_tagging_enabled: bool | None = None
    subject_tagging_enabled: bool | None = None
    external_tags_enabled: bool | None = None
    rules: list[RetentionRule] | None = None


class ChatThreadTag(BaseModel):
    """A retention/classification tag on a chat thread.

    Tags live in their own SQL table, never inside the client-authored thread
    payload, so a workspace save can neither create nor clear them.
    """

    id: str
    tenant_id: str
    thread_id: str
    namespace: str
    key: str
    value: str | None = None
    source: Literal["auto", "manual", "external"] = "auto"
    applied_at: datetime
    applied_by: str | None = None


class RetentionHold(BaseModel):
    """A legal hold. Threads under an active hold are never disposed."""

    id: str
    tenant_id: str
    name: str
    reason: str = ""
    created_by: str
    created_at: datetime
    released_at: datetime | None = None
    released_by: str | None = None


class RetentionTaggedThread(BaseModel):
    """Admin drilldown row: a tagged thread's metadata, never its content."""

    thread_id: str
    # None when the thread has since been deleted (or is outside the caller's
    # tenant); its tags remain listed so cleanup stays visible.
    title: str | None = None
    owner_user_id: str | None = None
    archived: bool = False
    # Matter linkage, label only: lets legal teams search by client/matter
    # number without opening the membership-gated matter itself.
    matter_id: str | None = None
    matter_label: str | None = None
    tags: list[ChatThreadTag] = Field(default_factory=list)


class RetentionBatchRequest(BaseModel):
    action: Literal["delete", "archive"]
    thread_ids: list[str] = Field(min_length=1, max_length=500)


class RetentionBatchResult(BaseModel):
    action: str
    requested: int
    disposed: int
    # Active legal holds always win: held threads are reported, never deleted.
    skipped_held: int = 0
    skipped_missing: int = 0


class UserMemorySettings(BaseModel):
    # One settings row per user; the id mirrors user_id for the same generic
    # snapshot-keying reason as TenantMemoryPolicy.
    id: str = ""
    user_id: str
    enabled: bool = True
    auto_capture_enabled: bool = True

    @model_validator(mode="after")
    def _default_id(self) -> "UserMemorySettings":
        if not self.id:
            object.__setattr__(self, "id", self.user_id)
        return self


class UserMemorySettingsUpdateRequest(BaseModel):
    enabled: bool | None = None
    auto_capture_enabled: bool | None = None


class MemoryStateResponse(BaseModel):
    """Effective memory availability for the calling user, tier by tier.

    Surfaced so the UI can explain *why* memory is off instead of guessing.
    """

    enabled: bool = False
    capture_enabled: bool = False
    platform_enabled: bool = False
    tenant_enabled: bool = False
    group_allowed: bool = False
    user_enabled: bool = True
    reason: str | None = None


class MemoryCollectionResponse(BaseModel):
    state: MemoryStateResponse
    settings: UserMemorySettings
    memories: list[UserMemory] = Field(default_factory=list)


class MemoryUserStat(BaseModel):
    """Content-free memory reporting for admins."""

    user_id: str
    display_name: str
    email: str
    count: int
    last_updated: str | None = None


class MemorySavedNotice(BaseModel):
    id: str
    kind: MemoryKind
    content: str


class DirectiveResult(BaseModel):
    id: str
    label: str
    satisfied: bool


class ChatSession(BaseModel):
    id: str
    tenant_id: str
    owner_user_id: str
    title: str
    model_id: str
    group_id: str
    pinned: bool = False
    archived: bool = False
    folder_id: str | None = None
    matter_id: str | None = None
    used_agent: bool = False
    updated_at: str


class ChatFolder(BaseModel):
    id: str
    tenant_id: str
    owner_user_id: str
    name: str
    matter_id: str | None = None
    created_at: str


class ChatFolderUpsertRequest(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    tenant_id: str | None = None
    name: str = Field(min_length=1, max_length=160)
    created_at: str | None = None


class ChatAttachment(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    owner_user_id: str | None = None
    name: str
    size: str
    kind: str
    mime_type: str | None = None
    size_bytes: int | None = None
    source_type: str = "upload"
    source_uri: str | None = None
    status: str = "uploaded"
    uploaded_at: str | None = None
    text_preview: str | None = None


class CloudAttachmentItem(BaseModel):
    id: str
    name: str
    kind: str = "File"
    item_type: str = "file"
    mime_type: str | None = None
    size: str = "0 B"
    size_bytes: int | None = None
    source_type: str
    source_uri: str
    modified_at: str | None = None


class CloudAttachmentImportRequest(BaseModel):
    item_ids: list[str] = Field(default_factory=list, max_length=10)
    tenant_id: str | None = None


class ChatCitation(BaseModel):
    id: str
    source_name: str
    source_type: str
    source_uri: str
    snippet: str
    page_start: int | None = Field(default=None, ge=1)
    page_end: int | None = Field(default=None, ge=1)
    locator: str | None = None
    chunk_id: str | None = None
    k_index: int | None = Field(default=None, ge=1)


class ChatActivityTraceStep(BaseModel):
    id: str
    label: str
    detail: str | None = None


class ChatMessage(BaseModel):
    id: str
    role: str
    content: str
    createdAt: str
    createdAtIso: str | None = None
    executedAt: str | None = None
    completedAt: str | None = None
    durationMs: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    status: str = "ok"
    attachments: list[ChatAttachment] | None = None
    citations: list[ChatCitation] = Field(default_factory=list)
    activityTrace: list[ChatActivityTraceStep] = Field(default_factory=list)
    startedAtMs: int | None = None
    # Provider-reported token usage for assistant replies; absent when the
    # provider did not report usage. Never synthesized.
    usage: dict[str, int] | None = None


class ChatThread(ChatSession):
    messages: list[ChatMessage] = Field(default_factory=list)


class ChatThreadUpsertRequest(BaseModel):
    tenant_id: str | None = None
    owner_user_id: str | None = None
    title: str = "New chat"
    model_id: str
    group_id: str = ""
    pinned: bool = False
    archived: bool = False
    folder_id: str | None = None
    used_agent: bool = False
    updated_at: str = "Just now"
    messages: list[ChatMessage] = Field(default_factory=list)


class ChatThreadTitleUpdateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=160)


class ChatCompletionRequest(BaseModel):
    # Agentic clients commonly send additional OpenAI-compatible options. We
    # explicitly model and forward the safe generation/tool fields below while
    # ignoring unrelated vendor extensions.
    model_config = ConfigDict(extra="ignore")

    model: str
    messages: list[dict[str, Any]]
    stream: bool = False
    surface: str = "chat"
    thread_id: str | None = None
    draft_title: str | None = None
    client_started_at: str | None = None
    max_completion_tokens: int | None = Field(default=None, ge=256, le=64000)
    max_tokens: int | None = Field(default=None, ge=1, le=64000)
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, ge=0, le=1)
    # Reasoning depth for reasoning-capable models: "minimal" favors the
    # fastest useful answer (and routes to throughput-priority providers),
    # "high" makes the model think longer before responding. The gateway
    # translates per provider dialect and drops this for models without
    # reasoning control, so it never reaches providers that would reject it.
    reasoning_effort: Literal["minimal", "low", "medium", "high"] | None = None
    stop: str | list[str] | None = None
    seed: int | None = None
    response_format: dict[str, Any] | None = None
    tools: list[dict[str, Any]] = Field(default_factory=list)
    tool_choice: str | dict[str, Any] | None = None
    parallel_tool_calls: bool | None = None
    agent_profile_id: str | None = None
    knowledge_config_ids: list[str] = Field(default_factory=list)
    tool_config_ids: list[str] = Field(default_factory=list)
    # Legacy: kept on the wire for compatibility but no longer trusted for
    # authorization. Approval is proven by signed approval_tokens instead.
    approved_tool_config_ids: list[str] = Field(default_factory=list)
    approval_tokens: list[str] = Field(default_factory=list)
    web_enabled: bool = False
    fetch_urls: list[str] = Field(default_factory=list, max_length=3)
    agent_enabled: bool = False
    citations_enabled: bool = True
    attachment_ids: list[str] = Field(default_factory=list)
    attachment_names: list[str] = Field(default_factory=list)
    # Attachments from earlier turns in the thread, re-supplied so image
    # content stays visible to the model on follow-up questions. Resolved
    # leniently: ids whose uploads no longer exist are skipped, never fatal.
    context_attachment_ids: list[str] = Field(default_factory=list)


class ChatCompletionChoice(BaseModel):
    index: int = 0
    message: dict[str, Any]
    finish_reason: str = "stop"


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    model: str
    choices: list[ChatCompletionChoice]
    usage: dict[str, int]
    citations: list[ChatCitation] = Field(default_factory=list)
    # How many of the caller's own memories shaped this turn, surfaced so the
    # user can always see when personalization was applied.
    memory_used: int = 0
    # Explicit "remember this" captures from this turn. Only ever the caller's
    # own text, so echoing it back leaks nothing.
    memory_saved: list[MemorySavedNotice] = Field(default_factory=list)
    directives: list[DirectiveResult] = Field(default_factory=list)


class AgentStep(BaseModel):
    id: str
    label: str
    status: str
    detail: str
    timestamp: str | None = None


class Artifact(BaseModel):
    id: str
    name: str
    kind: str
    size: str
    created_at: str


class Approval(BaseModel):
    id: str
    title: str
    requested_by: str
    requested_at: str
    status: str = "Pending"


class AgentRun(BaseModel):
    id: str
    tenant_id: str
    name: str
    status: str
    started_by: str
    started_at: str
    sources: list[str]
    steps: list[AgentStep]
    artifacts: list[Artifact]
    approvals: list[Approval]
    logs: list[dict[str, str]]
    is_sample: bool = False


class ScimName(BaseModel):
    givenName: str | None = None
    familyName: str | None = None


class ScimUserCreate(BaseModel):
    userName: str
    active: bool = True
    name: ScimName | None = None
    externalId: str | None = None
    groups: list[dict[str, str]] = Field(default_factory=list)


class ScimListResponse(BaseModel):
    schemas: list[str] = ["urn:ietf:params:scim:api:messages:2.0:ListResponse"]
    totalResults: int
    Resources: list[dict[str, Any]]
    startIndex: int = 1
    itemsPerPage: int


class AutomationStep(BaseModel):
    """One model invocation in an automation chain. The step's output feeds the
    next step's input, enabling multi-step (model-chaining) automations."""

    model_id: str
    instruction: str = ""


class Automation(BaseModel):
    id: str
    tenant_id: str
    name: str
    # Which surface the run targets: a chat completion or a drafting run.
    surface: str = "chat"  # "chat" | "draft"
    # Schedule shape, interpreted in UTC. Enabled schedules are fired by the
    # in-process scheduler (app/core/scheduler.py); "Run now" executes the
    # chain on demand through the same runner.
    trigger_type: str = "weekly"  # "once" | "daily" | "weekly" | "cron"
    run_at: str | None = None  # ISO datetime for a one-time run
    weekly_day: str | None = None  # e.g. "monday"
    time_of_day: str | None = None  # "HH:MM", used by daily and weekly triggers
    cron_expression: str | None = None
    # The initial input handed to the first step of the chain.
    prompt: str = ""
    steps: list[AutomationStep] = Field(default_factory=list)
    enabled: bool = False
    created_by: str | None = None
    created_at: str = "Just now"
    updated_at: str = "Just now"
    # Honest run bookkeeping; None until a real run has occurred.
    last_run_at: str | None = None
    last_run_status: str | None = None
    # Stamped by the scheduler when it fires a trigger, before execution, so
    # scheduler passes and restarts never double-fire the same occurrence.
    last_scheduled_fire_at: str | None = None


class AutomationCreateRequest(BaseModel):
    id: str | None = None
    tenant_id: str | None = None
    name: str
    surface: str = "chat"
    trigger_type: str = "weekly"
    run_at: str | None = None
    weekly_day: str | None = None
    time_of_day: str | None = None
    cron_expression: str | None = None
    prompt: str = ""
    steps: list[AutomationStep] = Field(default_factory=list)
    enabled: bool = False


class AutomationUpdateRequest(BaseModel):
    name: str | None = None
    surface: str | None = None
    trigger_type: str | None = None
    run_at: str | None = None
    weekly_day: str | None = None
    time_of_day: str | None = None
    cron_expression: str | None = None
    prompt: str | None = None
    steps: list[AutomationStep] | None = None
    enabled: bool | None = None


class AutomationRunRequest(BaseModel):
    # Optional caller-provided input that replaces the stored prompt as the
    # chain's first-step input for this run only. The chat ">" shortcut sends
    # the user's typed message here; scheduled fires never set it.
    input: str | None = None
