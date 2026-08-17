"""Application repository over relational identity/config and vector state.

The in-process cache retains the existing route contract, while the coalesced
flusher writes one transactional SQL snapshot. Credential and secret mutations
use the synchronous urgent path. The retired runtime JSON file contains only
cutover receipts and is never rewritten with live application state.
"""

from __future__ import annotations

import atexit
import hashlib
import hmac
import logging
import math
import re
import secrets
import threading
import time
import weakref
from collections import Counter, defaultdict
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.core import clock
from app.core.alerting import evaluate_audit_event
from app.core.config import get_settings
from app.core.mfa import (
    MFA_CHALLENGE_TTL_SECONDS,
    MFA_ENROLLMENT_TTL_SECONDS,
    MFA_MAX_ATTEMPTS,
    factor_seed_aad,
    hash_opaque_secret,
    hash_recovery_code,
    matching_totp_step,
    new_challenge_token,
    new_enrollment_token,
    new_recovery_codes,
    new_totp_secret,
    pending_seed_aad,
    provisioning_uri,
)
from app.core.policy import knowledge_access_allowed
from app.core.provider_credential_expiry import parse_provider_credential_expiry
from app.core.provider_credential_secrets import (
    ProviderCredentialCipherContext,
    decrypt_provider_credential_secret,
    encrypt_provider_credential_secret,
    resume_equivalent_empty_bootstrap_from_stage,
    resume_scoped_provider_credentials_from_stage,
    scope_provider_credentials_for_import,
    upgrade_legacy_provider_credential_ciphertext,
)
from app.core.security import SecretVault, hash_password, mask_secret, redact_metadata, verify_password
from app.core.sessions import (
    MAX_MFA_FACTOR_GENERATION,
    SessionClaims,
    issue_session_token,
    sign_asset_token,
    verify_session_token,
)
from app.core.tenant_identity import (
    TenantIdentityError,
    normalize_custom_domain,
    normalize_tenant_slug,
)
from app.core.vector_store import LocalVectorStore
from app.db.engine import (
    IDENTITY_CONFIG_IMPORT_REVISION,
    create_application_engine,
    upgrade_database,
)
from app.db.import_identity_config import (
    A7_RUNTIME_FIELDS,
    IdentityConfigImportError,
    IdentityConfigImportReceipt,
    ValidatedIdentityConfigState,
    build_v5_tombstone,
    canonicalize_deleted_profile_dependents,
    validate_v4_identity_config_state,
    validate_v5_tombstone,
)
from app.db.knowledge_import_state import KnowledgeStateImportReceipt
from app.db.import_state import (
    APPLICATION_STATE_METADATA_KEY,
    CHAT_RELATIONAL_STATE_VERSION,
    CHAT_STATE_METADATA_KEY,
    ApplicationStateImportMetadata,
    ChatStateImportMetadata,
    load_predecessor_import_metadata,
    prepare_empty_runtime_state,
    prepare_runtime_state,
    read_runtime_state_payload,
    write_runtime_state_atomic,
)
from app.models.schemas import (
    AgentRun,
    AlertNotification,
    AlertRule,
    Automation,
    CompanionMemory,
    AgentStep,
    Approval,
    Artifact,
    AuditEvent,
    EmailSettings,
    ChatAttachment,
    ChatFolder,
    ChatMessage,
    ChatThread,
    ChatThreadTag,
    Connector,
    ConnectorConfig,
    ContentFilter,
    Group,
    KnowledgeChunk,
    KnowledgeConfig,
    KnowledgeDocument,
    MemoryUserStat,
    ModelConfig,
    PlatformSettings,
    Provider,
    ProviderKey,
    ProviderKeySecret,
    PromptTemplate,
    Role,
    ScimTokenRecord,
    ScimTokenSummary,
    SecurityAlert,
    SkillFile,
    SsoConfig,
    Tenant,
    TenantBrandingUpdateRequest,
    TenantCreate,
    TenantMemoryPolicy,
    TenantRetentionPolicy,
    TenantSummary,
    TenantUpdate,
    ToolConfig,
    User,
    UsageRecord,
    UserApiKeyRecord,
    UserMemory,
    UserMemorySettings,
    UserPromptRecord,
    DEFAULT_USER_GROUP_ID,
    default_user_group_for_tenant,
)
from app.repositories.application_state import (
    ApplicationStateRepository,
    MfaChallengeInvalidError,
    MfaChallengeState,
    MfaPolicyState,
    MfaReplayError,
    MfaStateConflictError,
    SessionFamilyNotCurrentError,
    TotpFactorState,
)
from app.repositories.identity_config_sql import (
    IdentityConfigCorruptionError,
    IdentityConfigImportConflict,
    IdentityConfigSqlRepository,
    IdentityConfigSqlSnapshot,
    IdentityConfigSnapshotConflict,
)
from app.repositories.identity_config import (
    ConfigurationSecretResourceKind,
    ProviderCredentialBinding,
    select_provider_credential_binding,
)
from app.repositories.identity_cleanup import (
    CutoverVectorSourceJournal,
    IdentityCleanupJob,
    IdentityCleanupRepository,
)
from app.repositories.matters import MatterDraftRepository
from app.repositories.usage_budgets import TenantUsageBudgetRepository


logger = logging.getLogger("aperture.seed")

_SEARCH_STOPWORDS = {
    "and",
    "are",
    "for",
    "from",
    "into",
    "the",
    "this",
    "that",
    "what",
    "with",
    "your",
}

OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_DEFAULT_MODEL = "openai/gpt-5.5"
PROMPT_RESPONSE_PREVIEW_CHARS = 12_000
# Generated-image links embedded in a saved reply carry signed tokens that
# expire; the audit surface re-signs each image name at read time so owners
# and admins can always review what was generated. Bounded per record so one
# image-heavy reply cannot bloat the payload.
PROMPT_RESPONSE_IMAGE_LIMIT = 12
_GENERATED_IMAGE_NAME_PATTERN = re.compile(r"/api/chat/generated-images/([A-Za-z0-9][\w.-]*)")


def _generated_image_audit_links(content: str) -> list[str]:
    """Freshly signed viewer links for every generated image in one saved reply."""
    names = list(dict.fromkeys(_GENERATED_IMAGE_NAME_PATTERN.findall(content)))
    if not names:
        return []
    secret = get_settings().secret_key
    return [
        f"/api/chat/generated-images/{name}?token={sign_asset_token(name, secret)}"
        for name in names[:PROMPT_RESPONSE_IMAGE_LIMIT]
    ]
# Durable usage records are capped so runtime_state.json stays bounded; the
# oldest records are trimmed first.
USAGE_RECORDS_MAX = 20_000
RUNTIME_STATE_FLUSH_DEBOUNCE_SECONDS = 2.0


class TenantStoreError(ValueError):
    """Base class for tenant lifecycle validation failures."""


class TenantConflictError(TenantStoreError):
    """A normalized tenant identity collides with an existing tenant."""


class FinalTenantDeletionError(TenantStoreError):
    """The platform must always retain at least one tenant."""


class SessionUserStateError(RuntimeError):
    """The exact active user expected by a session mutation is no longer current."""


class MfaVerificationError(ValueError):
    """An MFA bearer or submitted proof was invalid without revealing why."""


class MfaTemporarilyLockedError(MfaVerificationError):
    """The durable attempt budget is exhausted until the current expiry."""

    def __init__(self, message: str, *, retry_after_seconds: int) -> None:
        self.retry_after_seconds = max(1, retry_after_seconds)
        super().__init__(message)


class LastActiveAdministrativeAccountError(RuntimeError):
    """Deactivation would remove the final active owner or tenant administrator."""

    def __init__(self, role: Role) -> None:
        self.role = role
        super().__init__(f"Cannot deactivate the last active {role.value} account.")


class UserIdentityConflictError(ValueError):
    """A user email or external identity collides with another account."""


def _normalize_tenant_slug(value: str) -> str:
    try:
        return normalize_tenant_slug(value)
    except TenantIdentityError as exc:
        raise TenantStoreError(str(exc)) from exc


def _normalize_custom_domain(value: str | None) -> str | None:
    try:
        return normalize_custom_domain(value)
    except TenantIdentityError as exc:
        raise TenantStoreError(str(exc)) from exc


def _request_host(value: str) -> str:
    host = value.strip().lower().rstrip(".")
    if host.startswith("["):
        closing = host.find("]")
        return host[1:closing] if closing > 0 else host
    return host.split(":", 1)[0]


def _close_store_at_exit(store_ref: weakref.ReferenceType[SeedStore]) -> None:
    """Best-effort final flush without keeping short-lived stores alive."""
    store = store_ref()
    if store is None:
        return
    try:
        store.close()
    except Exception:  # noqa: BLE001 - interpreter shutdown cannot recover
        logger.exception("Final runtime-state flush failed during interpreter shutdown")


def _memory_timestamp() -> str:
    return clock.now_iso()


def _seed_model_config_id(provider: Provider, upstream_model_id: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", upstream_model_id.lower()).strip("-") or "model"
    provider_slug = provider.id.removeprefix("provider-")
    return f"{provider_slug}-{slug}"[:96].strip("-")


def _parse_vault_expiry(value: str) -> datetime | None:
    return parse_provider_credential_expiry(value)


def _provider_key_is_expired(key: ProviderKey, *, now: datetime | None = None) -> bool:
    expires_at = _parse_vault_expiry(key.expires)
    if expires_at is None:
        return False
    current = now or datetime.now(UTC)
    return expires_at.date() < current.date()


def _provider_credential_cipher_context(
    key: ProviderKey,
) -> ProviderCredentialCipherContext:
    return ProviderCredentialCipherContext.from_binding(
        ProviderCredentialBinding(
            provider_id=key.provider_id,
            key_id=key.id,
            tenant_id=key.tenant_id,
        )
    )


class SeedStore:
    def __init__(
        self,
        vault: SecretVault,
        *,
        openrouter_api_key: str | None = None,
        openrouter_base_url: str = OPENROUTER_DEFAULT_BASE_URL,
        openrouter_default_model: str = OPENROUTER_DEFAULT_MODEL,
        seed_platform_owner_enabled: bool = True,
        seed_demo_data_enabled: bool = True,
        runtime_state_path: str | None = None,
        application_database_url: str | None = None,
        application_state_repository: ApplicationStateRepository | None = None,
        vector_db_path: str | None = None,
        dense_embeddings_enabled: bool = False,
        embedding_model: str = "BAAI/bge-small-en-v1.5",
        embedding_cache_dir: str | None = None,
        embedding_threads: int = 2,
    ) -> None:
        self.vault = vault
        self._runtime_state_path = (
            Path(runtime_state_path).expanduser().resolve() if runtime_state_path else None
        )
        self.review_activity_sink_sql_only = False

        if application_state_repository is None:
            database_url = (application_database_url or "").strip()
            if not database_url:
                if self._runtime_state_path is None:
                    database_url = "sqlite+pysqlite:///:memory:"
                else:
                    database_path = self._runtime_state_path.with_suffix(".sqlite3")
                    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
            application_engine = create_application_engine(database_url)
            owns_application_repository = True
        else:
            application_engine = application_state_repository.engine
            owns_application_repository = False

        upgrade_database(application_engine)
        self.identity_config_repository = IdentityConfigSqlRepository(application_engine)
        self.identity_cleanup_repository = IdentityCleanupRepository(application_engine)
        self.matter_draft_repository = MatterDraftRepository(application_engine)
        identity_authority = self.identity_config_repository.load_authority_state()
        authority_snapshot = identity_authority.snapshot
        active_identity_snapshot = (
            authority_snapshot if identity_authority.status == "active" else None
        )
        staged_identity_snapshot = (
            authority_snapshot if identity_authority.status == "staged" else None
        )
        active_identity_receipt = (
            active_identity_snapshot.receipt
            if active_identity_snapshot is not None
            else None
        )
        staged_identity_receipt = (
            staged_identity_snapshot.receipt
            if staged_identity_snapshot is not None
            else None
        )
        predecessor_identity_receipt = active_identity_receipt or staged_identity_receipt
        active_predecessor_metadata: tuple[
            ApplicationStateImportMetadata,
            ChatStateImportMetadata,
        ] | None = None
        if predecessor_identity_receipt is not None:
            active_predecessor_metadata = load_predecessor_import_metadata(
                application_engine,
                application_source_digest=(
                    predecessor_identity_receipt.prior_application_state_digest
                ),
                chat_source_digest=predecessor_identity_receipt.prior_chat_state_digest,
            )
        preparation = None
        if active_identity_receipt is None:
            if self._runtime_state_path is not None and (
                staged_identity_receipt is None or self._runtime_state_path.exists()
            ):
                preparation = prepare_runtime_state(
                    application_engine,
                    self._runtime_state_path,
                )
            elif staged_identity_receipt is None:
                preparation = prepare_empty_runtime_state(application_engine)
        self.application_state_repository = (
            application_state_repository
            or ApplicationStateRepository(application_engine)
        )
        self.usage_budget_repository = TenantUsageBudgetRepository(application_engine)
        self._owns_application_state_repository = owns_application_repository
        self._prepared_runtime_state_payload = (
            preparation.payload if preparation is not None else None
        )
        self._application_state_metadata: ApplicationStateImportMetadata | None = (
            preparation.metadata
            if preparation is not None
            else active_predecessor_metadata[0]
            if active_predecessor_metadata is not None
            else None
        )
        self._chat_state_metadata: ChatStateImportMetadata | None = (
            preparation.chat_metadata
            if preparation is not None
            else active_predecessor_metadata[1]
            if active_predecessor_metadata is not None
            else None
        )
        self._identity_config_metadata: IdentityConfigImportReceipt | None = (
            active_identity_receipt
        )
        self._identity_config_staged_metadata: IdentityConfigImportReceipt | None = (
            staged_identity_receipt
        )
        self._identity_config_staged_snapshot = staged_identity_snapshot
        self._identity_config_live_digest = (
            active_identity_snapshot.relational_digest
            if active_identity_snapshot is not None
            else None
        )
        self._identity_config_legacy_import_pending = bool(
            preparation is not None
            and A7_RUNTIME_FIELDS.issubset(preparation.payload)
        )
        self._identity_config_empty_bootstrap = bool(
            preparation is not None
            and not A7_RUNTIME_FIELDS.issubset(preparation.payload)
        )
        self._identity_config_cutover_required = active_identity_receipt is None
        # One re-entrant lock protects mutation+snapshot invariants for the
        # high-churn store methods. Normal saves are coalesced for up to two
        # seconds; callers that change credentials or secrets use the urgent
        # path and do not accept that durability window.
        self._store_lock = threading.RLock()
        self._runtime_state_flush_condition = threading.Condition(self._store_lock)
        self._runtime_state_dirty = False
        self._runtime_state_flush_deadline: float | None = None
        self._runtime_state_flush_thread: threading.Thread | None = None
        self._runtime_state_closed = False
        self._runtime_state_atexit_callback: Any | None = None
        resolved_vector_db_path = vector_db_path
        if resolved_vector_db_path is None:
            resolved_vector_db_path = (
                str(self._runtime_state_path.with_suffix(".vectors.sqlite3"))
                if self._runtime_state_path is not None
                else ":memory:"
            )
        self.vector_store = LocalVectorStore(
            resolved_vector_db_path,
            dense_embeddings_enabled=dense_embeddings_enabled,
            embedding_model=embedding_model,
            embedding_cache_dir=embedding_cache_dir,
            embedding_threads=embedding_threads,
        )
        self.openrouter_api_key = (openrouter_api_key or "").strip()
        self.openrouter_base_url = (openrouter_base_url or OPENROUTER_DEFAULT_BASE_URL).strip()
        if not self.openrouter_base_url:
            self.openrouter_base_url = OPENROUTER_DEFAULT_BASE_URL
        self.openrouter_default_model = (openrouter_default_model or OPENROUTER_DEFAULT_MODEL).strip()
        if not self.openrouter_default_model:
            self.openrouter_default_model = OPENROUTER_DEFAULT_MODEL
        openrouter_connected = bool(self.openrouter_api_key)
        self.tenants: dict[str, Tenant] = {
            "tenant-example": Tenant(
                id="tenant-example",
                name="Example Corporation",
                slug="example",
                custom_domain="chat.example.com",
                chat_brand_name="Aperture Chat",
                logo_url=None,
                icon_url=None,
            )
        }
        self.users: dict[str, User] = {
            "user-owner": User(
                id="user-owner",
                email="owner@aperture.local",
                display_name="Aperture Platform Owner",
                role=Role.PLATFORM_OWNER,
                last_active="Now",
                auth_method="local",
            ),
            "user-admin": User(
                id="user-admin",
                tenant_id="tenant-example",
                email="alex.morgan@example.com",
                display_name="Alex Morgan",
                role=Role.TENANT_ADMIN,
                entra_object_id="entra-admin-001",
                group_ids=["group-litigation", "group-finance"],
                last_active="2h ago",
                auth_method="sso",
            ),
            "user-jane": User(
                id="user-jane",
                tenant_id="tenant-example",
                email="jane.smith@example.com",
                display_name="Jane Smith",
                role=Role.USER,
                entra_object_id="entra-user-001",
                group_ids=["group-litigation"],
                last_active="1h ago",
                auth_method="sso",
            ),
            "user-casey": User(
                id="user-casey",
                tenant_id="tenant-example",
                email="casey.doe@example.com",
                display_name="Casey Doe",
                role=Role.USER,
                entra_object_id="entra-user-002",
                group_ids=["group-litigation"],
                last_active="3h ago",
                auth_method="sso",
            ),
            "user-drew": User(
                id="user-drew",
                tenant_id="tenant-example",
                email="drew.parker@example.com",
                display_name="Drew Parker",
                role=Role.TENANT_ADMIN,
                entra_object_id="entra-admin-002",
                group_ids=["group-litigation"],
                last_active="2h ago",
                auth_method="sso",
            ),
            "user-maya": User(
                id="user-maya",
                tenant_id="tenant-example",
                email="maya.patel@example.com",
                display_name="Maya Patel",
                role=Role.USER,
                entra_object_id="entra-user-003",
                group_ids=[],
                last_active="Pending",
                auth_method="sso",
            ),
        }
        if not seed_platform_owner_enabled:
            self.users.pop("user-owner", None)
        self.groups: dict[str, Group] = {
            "group-litigation": Group(
                id="group-litigation",
                tenant_id="tenant-example",
                name="Litigation",
                distinguished_name="Platform-managed group",
                entra_object_id="entra-group-litigation",
                user_count=4,
                permissions={
                    "chat_access": True,
                    "knowledge_access": True,
                    "agents_access": True,
                    "tools_access": True,
                },
            ),
            "group-corporate": Group(
                id="group-corporate",
                tenant_id="tenant-example",
                name="Corporate",
                distinguished_name="Platform-managed group",
                entra_object_id="entra-group-corporate",
                user_count=0,
            ),
            "group-hr": Group(
                id="group-hr",
                tenant_id="tenant-example",
                name="HR",
                distinguished_name="Platform-managed group",
                entra_object_id="entra-group-hr",
                user_count=0,
            ),
            "group-finance": Group(
                id="group-finance",
                tenant_id="tenant-example",
                name="Finance Team",
                distinguished_name="Platform-managed group",
                entra_object_id="entra-group-finance",
                user_count=1,
            ),
        }
        self.providers: dict[str, Provider] = {
            "provider-azure": Provider(
                id="provider-azure",
                name="Azure OpenAI",
                kind="azure-openai",
                region="East US",
                base_url="https://example-openai.openai.azure.com/openai",
                auth_type="api-key",
                auth_metadata={"api_version": "2024-10-21", "header_name": "api-key"},
                connected=False,
                model_count=12,
                enabled_model_count=0,
            ),
            "provider-openai": Provider(
                id="provider-openai",
                name="OpenAI",
                kind="openai",
                region="Global",
                base_url="https://api.openai.com/v1",
                auth_type="bearer",
                auth_metadata={"header_name": "Authorization"},
                connected=False,
                model_count=9,
                enabled_model_count=0,
            ),
            "provider-openrouter": Provider(
                id="provider-openrouter",
                name="OpenRouter",
                kind="openrouter",
                region="US",
                base_url=self.openrouter_base_url,
                auth_type="bearer",
                auth_metadata={"header_name": "Authorization", "catalog_scope": "zdr"},
                connected=openrouter_connected,
                model_count=1 if openrouter_connected else 0,
                enabled_model_count=1 if openrouter_connected else 0,
                last_sync="Loaded from backend environment" if openrouter_connected else "Not connected",
                status_message=(
                    "OpenRouter key loaded from backend environment."
                    if openrouter_connected
                    else "Set OPENROUTER_API_KEY to connect OpenRouter."
                ),
            ),
        }
        self.models: dict[str, ModelConfig] = {
            "gpt-4o": ModelConfig(
                id="gpt-4o",
                provider_id="provider-azure",
                provider_name="Azure OpenAI",
                name="gpt-4o",
                upstream_model_id="gpt-4o",
                notes="Recommended",
                group_ids=["group-litigation", "group-corporate"],
            ),
            "gpt-4o-mini": ModelConfig(
                id="gpt-4o-mini",
                provider_id="provider-azure",
                provider_name="Azure OpenAI",
                name="gpt-4o-mini",
                upstream_model_id="gpt-4o-mini",
                tenant_restricted=True,
                group_ids=["group-litigation"],
                notes="Cost-optimized",
            ),
            "gpt-4.1": ModelConfig(
                id="gpt-4.1",
                provider_id="provider-openai",
                provider_name="OpenAI",
                name="gpt-4.1",
                upstream_model_id="gpt-4.1",
                notes="Latest",
                group_ids=["group-litigation", "group-finance"],
            ),
            "o3-mini": ModelConfig(
                id="o3-mini",
                provider_id="provider-openai",
                provider_name="OpenAI",
                name="o3-mini",
                upstream_model_id="o3-mini",
                platform_enabled=False,
                notes="Disabled globally",
            ),
            "openrouter-openai-gpt-5-5": ModelConfig(
                id="openrouter-openai-gpt-5-5",
                provider_id="provider-openrouter",
                provider_name="OpenRouter",
                name="OpenAI: GPT-5.5",
                upstream_model_id="openai/gpt-5.5",
                system_prompt=(
                    "Use connected workspace context where available. For long-form drafting, produce the full requested "
                    "deliverable, include source-aware structure, and do not stop at an outline."
                ),
                notes="Default high-capability OpenRouter route for complete long-form drafting.",
                tool_config_ids=["tool-agent-workflow"],
                knowledge_config_ids=["knowledge-litigation-playbook", "knowledge-box-matters"],
                context_window=1_000_000,
                visibility="organization",
            ),
            "openrouter-openai-gpt-4o-mini": ModelConfig(
                id="openrouter-openai-gpt-4o-mini",
                provider_id="provider-openrouter",
                provider_name="OpenRouter",
                name="OpenRouter: openai/gpt-4o-mini",
                upstream_model_id="openai/gpt-4o-mini",
                system_prompt="Use connected workspace context where available and cite sources when requested.",
                notes="Cost-optimized OpenRouter route; not preferred for long-form drafting.",
                tool_config_ids=["tool-agent-workflow"],
                knowledge_config_ids=["knowledge-litigation-playbook", "knowledge-box-matters"],
                context_window=128000,
                visibility="organization",
            ),
            "agent-client-update": ModelConfig(
                id="agent-client-update",
                provider_id="provider-openrouter",
                provider_name="OpenRouter",
                name="Client Update Agent",
                upstream_model_id=self.openrouter_default_model,
                system_prompt=(
                    "You are a source-grounded legal workflow agent. Use the configured knowledge bases, "
                    "prepare cited work product, and require approval before sending external messages."
                ),
                meta_prompt=(
                    "For every answer, state the matter sources used, identify missing context, and keep "
                    "client-facing output separate from internal analysis."
                ),
                knowledge_config_ids=["knowledge-litigation-playbook", "knowledge-box-matters"],
                tool_config_ids=[
                    "tool-agent-workflow",
                    "tool-hermes-agent-mcp",
                    "tool-template-prompts",
                    "tool-skill-library",
                ],
                platform_enabled=True,
                tenant_restricted=True,
                group_ids=["group-litigation", "group-finance"],
                notes="GPT-style agent profile with Hermes MCP companion enabled.",
                is_custom=True,
                created_by="Aperture Platform Owner",
                context_window=128000,
                visibility="tenant",
                agentic_companion="hermes",
                prompt_template_ids=["template-client-update", "template-approval-email"],
                skill_file_ids=["skill-client-update-package", "skill-citation-discipline"],
            ),
        }
        if openrouter_connected:
            self.ensure_default_openrouter_model(self.providers["provider-openrouter"])
        self.prompt_templates: dict[str, PromptTemplate] = {
            "template-client-update": PromptTemplate(
                id="template-client-update",
                tenant_id="tenant-example",
                name="Client Update Package",
                description="Structured matter update prompt with source and approval gates.",
                category="client-communications",
                variables=["matter", "deadline", "source_summary", "client_decisions"],
                group_ids=["group-litigation"],
                content=(
                    "Prepare a client update package with three sections: internal source summary, "
                    "client-facing update, and open decisions. Cite retrieved matter sources by name, "
                    "lead with the response deadline, and flag any missing client decisions before drafting."
                ),
                updated_at="Seeded today",
            ),
            "template-approval-email": PromptTemplate(
                id="template-approval-email",
                tenant_id="tenant-example",
                name="Approval Email",
                description="Approval request template before external client communications.",
                category="approval",
                variables=["approver", "recipient", "artifact_summary"],
                group_ids=["group-litigation", "group-finance"],
                content=(
                    "Before any external send, draft an approval note for the responsible attorney. "
                    "Include the intended recipients, artifacts, source citations used, and the exact "
                    "client-facing text that needs approval."
                ),
                updated_at="Seeded today",
            ),
            "template-matter-summary": PromptTemplate(
                id="template-matter-summary",
                tenant_id="tenant-example",
                name="Matter Summary",
                description="Reusable prompt for concise cited matter summaries.",
                category="summary",
                variables=["matter", "audience"],
                group_ids=["group-litigation"],
                content=(
                    "Summarize the matter for the requested audience. Separate facts, procedural posture, "
                    "risks, and next actions. Do not infer facts that are not present in retrieved sources."
                ),
                updated_at="Seeded today",
            ),
        }
        self.skill_files: dict[str, SkillFile] = {
            "skill-client-update-package": SkillFile(
                id="skill-client-update-package",
                tenant_id="tenant-example",
                name="Client Update Package Skill",
                description="Workflow rules for producing attorney-reviewed client updates.",
                category="legal-workflow",
                version="1.0.0",
                group_ids=["group-litigation"],
                content=(
                    "# Client Update Package Skill\n"
                    "- Gather retrieved knowledge excerpts before drafting.\n"
                    "- Keep internal analysis separate from client-facing language.\n"
                    "- Include cited source names in every substantive section.\n"
                    "- Require attorney approval before sending or scheduling external messages."
                ),
                updated_at="Seeded today",
            ),
            "skill-citation-discipline": SkillFile(
                id="skill-citation-discipline",
                tenant_id="tenant-example",
                name="Citation Discipline",
                description="Rules for source-grounded answers and missing-context handling.",
                category="source-control",
                version="1.0.0",
                group_ids=["group-litigation", "group-finance"],
                content=(
                    "# Citation Discipline\n"
                    "- Cite retrieved knowledge by source name when it supports a claim.\n"
                    "- Mark unsupported facts as missing context instead of filling gaps.\n"
                    "- Prefer the most recent or matter-specific source when sources conflict.\n"
                    "- Never expose secret values, API keys, or raw connector credentials."
                ),
                updated_at="Seeded today",
            ),
            "skill-approval-routing": SkillFile(
                id="skill-approval-routing",
                tenant_id="tenant-example",
                name="Approval Routing",
                description="Approval and notification behavior for agentic workflows.",
                category="approval",
                version="1.0.0",
                group_ids=["group-litigation", "group-finance"],
                content=(
                    "# Approval Routing\n"
                    "- Route external communications to the configured approver before send.\n"
                    "- Preserve an audit note with artifact names and approval state.\n"
                    "- If approval is missing, return a draft and do not claim it was sent."
                ),
                updated_at="Seeded today",
            ),
        }
        raw_keys = {"key-openrouter-primary": self.openrouter_api_key} if openrouter_connected else {}
        self._encrypted_keys = {key: self.vault.encrypt(value) for key, value in raw_keys.items()}
        self.provider_keys: dict[str, ProviderKey] = {}
        if openrouter_connected:
            self.provider_keys["key-openrouter-primary"] = ProviderKey(
                id="key-openrouter-primary",
                provider_id="provider-openrouter",
                provider_name="OpenRouter",
                name="OpenRouter Primary",
                environment="Production",
                status="Active",
                last_rotated="Loaded from backend environment",
                expires="Not set",
                masked_value=mask_secret(raw_keys["key-openrouter-primary"]),
            )
        self.connectors: dict[str, Connector] = {
            "google-drive": Connector(
                id="google-drive",
                name="Google Drive",
                category="content",
                scopes=["drive.readonly"],
            ),
            "microsoft-graph": Connector(
                id="microsoft-graph",
                name="OneDrive / SharePoint / Outlook",
                category="content",
                scopes=["Files.Read.All", "Sites.Read.All", "Mail.Send"],
            ),
            "box": Connector(id="box", name="Box", category="content", scopes=["root_readwrite"]),
            "imanage": Connector(id="imanage", name="iManage", category="legal-dms"),
            "web": Connector(id="web", name="Web Search", category="search", configured_by=Role.TENANT_ADMIN),
            "mcp": Connector(id="mcp", name="MCP Servers", category="tools", configured_by=Role.TENANT_ADMIN),
            "prompt-library": Connector(id="prompt-library", name="Prompt Library", category="prompts"),
            "knowledge-ingestion": Connector(
                id="knowledge-ingestion",
                name="Knowledge Ingestion",
                category="content",
                configured_by=Role.TENANT_ADMIN,
            ),
            "document-templates": Connector(
                id="document-templates",
                name="Document Templates",
                category="documents",
                configured_by=Role.TENANT_ADMIN,
            ),
            "audit-analytics": Connector(
                id="audit-analytics",
                name="Audit and Analytics Export",
                category="analytics",
            ),
        }
        # Seeded records never fake credentials: connector and knowledge secrets
        # stay empty until a real credential is saved (the OpenRouter env key is
        # the only real credential loaded at seed time).
        raw_config_secrets = {
            "sso:sso-entra-example": "entra-client-secret-651df904",
            "tool:tool-hermes-example": "hermes-webhook-secret-c4d131a2",
            "tool:tool-hermes-agent-mcp": "hermes-mcp-secret-4a82bc91",
        }
        self._configuration_secrets = {
            key: self.vault.encrypt(value) for key, value in raw_config_secrets.items()
        }
        # Each seeded connector uses the provider's real recommended auth mode and
        # carries its full settings field set; unknown values stay empty until an
        # admin fills them in (no invented connected state).
        self.connector_configs: dict[str, ConnectorConfig] = {
            "conncfg-graph-example": ConnectorConfig(
                id="conncfg-graph-example",
                tenant_id="tenant-example",
                connector_id="microsoft-graph",
                enabled=True,
                auth_type="client-credentials",
                scopes=["Files.Read.All", "Sites.Read.All", "Mail.Send"],
                settings={
                    "drive_item_id": "example-litigation-drive-root",
                    "library_label": "SharePoint Litigation Library",
                    "source_root_id": "example-litigation-drive-root",
                    "source_label": "SharePoint Litigation Library",
                    "tenant_id": "",
                    "client_id": "entra-aperture-graph-client",
                    "site_id": "",
                    "drive_id": "",
                    "token_url": "",
                    "auth_mode": "client-credentials",
                    "acl_mode": "entra-groups",
                    "sync_status": "idle",
                    "last_sync": "Never",
                },
                secret_set=False,
            ),
            "conncfg-google-drive-example": ConnectorConfig(
                id="conncfg-google-drive-example",
                tenant_id="tenant-example",
                connector_id="google-drive",
                enabled=True,
                auth_type="oauth-client",
                scopes=["drive.readonly"],
                settings={
                    "folder_id": "policy-library-folder",
                    "root_folder": "Google Drive Policy Library",
                    "source_root_id": "policy-library-folder",
                    "source_label": "Google Drive Policy Library",
                    "client_id": "google-aperture-drive-client",
                    "authorization_url": "",
                    "token_url": "",
                    "oauth_status": "not-connected",
                    "auth_mode": "oauth-client",
                    "acl_mode": "google-groups",
                    "sync_status": "idle",
                    "last_sync": "Never",
                },
                secret_set=False,
            ),
            "conncfg-box-example": ConnectorConfig(
                id="conncfg-box-example",
                tenant_id="tenant-example",
                connector_id="box",
                enabled=True,
                auth_type="client-credentials",
                scopes=["root_readwrite"],
                settings={
                    "root_folder": "/Clients/Example",
                    "client_id": "",
                    "enterprise_id": "",
                    "box_subject_type": "enterprise",
                    "token_url": "",
                    "auth_mode": "client-credentials",
                    "acl_mode": "group",
                    "sync_status": "idle",
                    "last_sync": "Never",
                },
                secret_set=False,
            ),
            "conncfg-imanage-example": ConnectorConfig(
                id="conncfg-imanage-example",
                tenant_id="tenant-example",
                connector_id="imanage",
                enabled=False,
                auth_type="oauth-client",
                scopes=["dms.read", "workspace.read"],
                settings={
                    "workspace_id": "EXAMPLE-LITIGATION",
                    "workspace_label": "iManage / EXAMPLE Litigation",
                    "source_root_id": "EXAMPLE-LITIGATION",
                    "source_label": "iManage / EXAMPLE Litigation",
                    "base_url": "https://imanage.example.internal",
                    "client_id": "",
                    "customer_id": "",
                    "library_id": "",
                    "token_url": "",
                    "user_authorization_url": "",
                    "user_token_url": "",
                    "auth_mode": "oauth-client",
                    "acl_mode": "dms-security",
                    "sync_status": "idle",
                    "last_sync": "Never",
                },
                secret_set=False,
            ),
        }
        self.sso_configs: dict[str, SsoConfig] = {
            "sso-entra-example": SsoConfig(
                id="sso-entra-example",
                tenant_id="tenant-example",
                provider="entra-id",
                issuer_url="https://login.microsoftonline.com/example/v2.0",
                client_id="aperture-example-client",
                scopes=["openid", "profile", "email"],
                # IdP group claim value (e.g. the Entra group object id) →
                # workspace group id. Membership in mapped workspace groups
                # follows the token's group claim on every SSO sign-in.
                mapped_groups={
                    "entra-litigation-group": "group-litigation",
                    "entra-finance-group": "group-finance",
                },
                settings={
                    "jit_provisioning": True,
                    "default_role": Role.USER,
                    "default_group_ids": [],
                    "domains": ["example.com"],
                    "enforced": True,
                    # Off: the identity provider's own MFA (e.g. Conditional
                    # Access) is the second factor; the platform authenticator
                    # is layered on only when an owner opts in.
                    "require_platform_mfa": False,
                    "mfa_enforced": True,
                    "mfa_methods": ["Microsoft Authenticator", "Duo Mobile"],
                    "mfa_notes": (
                        "MFA is enforced by the identity provider; Aperture stores the SSO baseline "
                        "and redirects users to the configured provider challenge."
                    ),
                    "redirect_url": "https://chat.example.com/auth/callback",
                    "acs_url": "https://chat.example.com/auth/callback",
                    "entity_id": "api://aperture-chat",
                    "role_claim": "roles",
                    "group_claim": "groups",
                    "saml_login_url": "https://login.microsoftonline.com/example/saml2",
                    "saml_logout_url": "https://login.microsoftonline.com/example/saml2",
                    "saml_certificate": "",
                    "duo_api_hostname": "api-example.duosecurity.com",
                    "duo_redirect_uri": "https://chat.example.com/auth/callback",
                    "scim_base_url": "https://chat.example.com/scim/v2",
                    "status": "enforced",
                    "last_tested": "Today, 9:18 AM",
                    "admin_notes": "SSO admits users into pending access; platform groups are assigned in the admin console.",
                },
                secret_set=True,
                masked_secret=mask_secret(raw_config_secrets["sso:sso-entra-example"]),
            )
        }
        self.knowledge_configs: dict[str, KnowledgeConfig] = {
            "knowledge-litigation-playbook": KnowledgeConfig(
                id="knowledge-litigation-playbook",
                tenant_id="tenant-example",
                name="Litigation Playbook",
                source_type="microsoft-graph",
                connector_config_id="conncfg-graph-example",
                acl_group_ids=["group-litigation"],
                settings={
                    "description": "Pleadings, discovery templates, matter strategy notes, and cited legal guidance.",
                    "source": "Sample seeded content",
                    "status": "stale",
                    "sync_interval_minutes": 15,
                    "citation_required": True,
                    "document_count": 2,
                    "last_sync": "Never synced",
                    "acl": "AD Group: Litigation",
                    "provider_status": "cached",
                    "provider_message": "Seeded sample documents for the local demo; connect Microsoft Graph credentials and sync to replace them.",
                },
                secret_set=False,
            ),
            "knowledge-policy-library": KnowledgeConfig(
                id="knowledge-policy-library",
                tenant_id="tenant-example",
                name="Corporate Policy Library",
                source_type="google-drive",
                connector_config_id="conncfg-google-drive-example",
                acl_group_ids=["group-corporate"],
                settings={
                    "description": "Policies, compliance memos, retention rules, and approved clause language.",
                    "source": "Sample seeded content",
                    "status": "stale",
                    "sync_interval_minutes": 60,
                    "citation_required": True,
                    "document_count": 2,
                    "last_sync": "Never synced",
                    "acl": "AD Group: Corporate",
                    "provider_status": "cached",
                    "provider_message": "Seeded sample documents for the local demo; connect Google Drive credentials and sync to replace them.",
                },
                secret_set=False,
            ),
            "knowledge-box-matters": KnowledgeConfig(
                id="knowledge-box-matters",
                tenant_id="tenant-example",
                name="Box Matter Knowledge",
                source_type="box",
                connector_config_id="conncfg-box-example",
                acl_group_ids=["group-litigation"],
                settings={
                    "description": "Box matter pleadings, discovery, and client update work product.",
                    "source": "Sample seeded content",
                    "status": "stale",
                    "sync_interval_minutes": 30,
                    "citation_required": True,
                    "document_count": 3,
                    "last_sync": "Never synced",
                    "acl": "Groups: Litigation",
                    "provider_status": "cached",
                    "provider_message": "Seeded sample documents for the local demo; connect Box credentials and sync to replace them.",
                },
                secret_set=False,
            ),
            "knowledge-imanage-workspace": KnowledgeConfig(
                id="knowledge-imanage-workspace",
                tenant_id="tenant-example",
                name="iManage Workspace",
                source_type="imanage",
                connector_config_id="conncfg-imanage-example",
                enabled=False,
                acl_group_ids=["group-litigation"],
                settings={
                    "description": "Legal DMS workspace awaiting platform-owner OAuth configuration.",
                    "source": "iManage / EXAMPLE Litigation",
                    "status": "draft",
                    "sync_interval_minutes": 30,
                    "citation_required": True,
                    "document_count": 0,
                    "last_sync": "Not synced",
                    "acl": "Pending DMS security mapping",
                    "provider_status": "cached",
                    "provider_message": "iManage source inventory is cached until OAuth credentials are saved.",
                },
                secret_set=False,
            ),
        }
        self.knowledge_documents: dict[str, list[KnowledgeDocument]] = {
            "knowledge-litigation-playbook": [
                KnowledgeDocument(
                    id="doc-graph-pleading-template",
                    knowledge_config_id="knowledge-litigation-playbook",
                    tenant_id="tenant-example",
                    name="Responsive pleading template.docx",
                    source_uri="graph://sites/example-litigation/pleadings/responsive-pleading-template.docx",
                    source_type="microsoft-graph",
                    status="indexed",
                    chunk_count=31,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                    citation_required=True,
                ),
                KnowledgeDocument(
                    id="doc-graph-discovery-objections",
                    knowledge_config_id="knowledge-litigation-playbook",
                    tenant_id="tenant-example",
                    name="Discovery objections playbook.pdf",
                    source_uri="graph://sites/example-litigation/discovery/discovery-objections-playbook.pdf",
                    source_type="microsoft-graph",
                    status="indexed",
                    chunk_count=53,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                    citation_required=True,
                ),
            ],
            "knowledge-policy-library": [
                KnowledgeDocument(
                    id="doc-drive-retention-policy",
                    knowledge_config_id="knowledge-policy-library",
                    tenant_id="tenant-example",
                    name="Records retention policy.pdf",
                    source_uri="gdrive://policy-library-folder/records-retention-policy.pdf",
                    source_type="google-drive",
                    status="indexed",
                    chunk_count=24,
                    acl_group_ids=["group-corporate"],
                    updated_at="Seeded sample data",
                    citation_required=True,
                ),
                KnowledgeDocument(
                    id="doc-drive-ai-use-policy",
                    knowledge_config_id="knowledge-policy-library",
                    tenant_id="tenant-example",
                    name="Approved AI use policy.docx",
                    source_uri="gdrive://policy-library-folder/approved-ai-use-policy.docx",
                    source_type="google-drive",
                    status="indexed",
                    chunk_count=19,
                    acl_group_ids=["group-corporate"],
                    updated_at="Seeded sample data",
                    citation_required=True,
                ),
            ],
            "knowledge-box-matters": [
                KnowledgeDocument(
                    id="doc-box-complaint-outline",
                    knowledge_config_id="knowledge-box-matters",
                    tenant_id="tenant-example",
                    name="Complaint response outline.docx",
                    source_uri="box://matter-1042/pleadings/complaint-response-outline.docx",
                    source_type="box",
                    status="indexed",
                    chunk_count=42,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                    citation_required=True,
                ),
                KnowledgeDocument(
                    id="doc-box-discovery-plan",
                    knowledge_config_id="knowledge-box-matters",
                    tenant_id="tenant-example",
                    name="Discovery plan and custodians.xlsx",
                    source_uri="box://matter-1042/discovery/discovery-plan-custodians.xlsx",
                    source_type="box",
                    status="indexed",
                    chunk_count=28,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                    citation_required=True,
                ),
                KnowledgeDocument(
                    id="doc-box-client-update",
                    knowledge_config_id="knowledge-box-matters",
                    tenant_id="tenant-example",
                    name="Client weekly update draft.md",
                    source_uri="box://matter-1042/client-updates/weekly-update-draft.md",
                    source_type="box",
                    status="indexed",
                    chunk_count=15,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                    citation_required=True,
                ),
            ]
        }
        self.knowledge_chunks: dict[str, list[KnowledgeChunk]] = {
            "knowledge-litigation-playbook": [
                KnowledgeChunk(
                    id="chunk-graph-pleading-template-1",
                    knowledge_config_id="knowledge-litigation-playbook",
                    document_id="doc-graph-pleading-template",
                    tenant_id="tenant-example",
                    source_name="Responsive pleading template.docx",
                    source_uri="graph://sites/example-litigation/pleadings/responsive-pleading-template.docx",
                    source_type="microsoft-graph",
                    text=(
                        "Responsive pleading template: preserve jurisdictional objections, identify "
                        "affirmative defenses by claim element, and cite the client-approved privilege language."
                    ),
                    ordinal=0,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                ),
                KnowledgeChunk(
                    id="chunk-graph-discovery-objections-1",
                    knowledge_config_id="knowledge-litigation-playbook",
                    document_id="doc-graph-discovery-objections",
                    tenant_id="tenant-example",
                    source_name="Discovery objections playbook.pdf",
                    source_uri="graph://sites/example-litigation/discovery/discovery-objections-playbook.pdf",
                    source_type="microsoft-graph",
                    text=(
                        "Discovery objections playbook: overbroad data requests should be narrowed by "
                        "custodian, date range, and proportionality before collection begins."
                    ),
                    ordinal=0,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                ),
            ],
            "knowledge-policy-library": [
                KnowledgeChunk(
                    id="chunk-drive-retention-policy-1",
                    knowledge_config_id="knowledge-policy-library",
                    document_id="doc-drive-retention-policy",
                    tenant_id="tenant-example",
                    source_name="Records retention policy.pdf",
                    source_uri="gdrive://policy-library-folder/records-retention-policy.pdf",
                    source_type="google-drive",
                    text=(
                        "Records retention policy: litigation holds suspend ordinary retention schedules "
                        "for custodians and systems listed in the hold notice."
                    ),
                    ordinal=0,
                    acl_group_ids=["group-corporate"],
                    updated_at="Seeded sample data",
                ),
                KnowledgeChunk(
                    id="chunk-drive-ai-use-policy-1",
                    knowledge_config_id="knowledge-policy-library",
                    document_id="doc-drive-ai-use-policy",
                    tenant_id="tenant-example",
                    source_name="Approved AI use policy.docx",
                    source_uri="gdrive://policy-library-folder/approved-ai-use-policy.docx",
                    source_type="google-drive",
                    text=(
                        "Approved AI use policy: confidential client material may be used only with "
                        "approved tenant models, source ACL enforcement, and retained citation logs."
                    ),
                    ordinal=0,
                    acl_group_ids=["group-corporate"],
                    updated_at="Seeded sample data",
                ),
            ],
            "knowledge-box-matters": [
                KnowledgeChunk(
                    id="chunk-complaint-outline-1",
                    knowledge_config_id="knowledge-box-matters",
                    document_id="doc-box-complaint-outline",
                    tenant_id="tenant-example",
                    source_name="Complaint response outline.docx",
                    source_uri="box://matter-1042/pleadings/complaint-response-outline.docx",
                    source_type="box",
                    text=(
                        "Complaint response outline: preserve objections to broad data sharing requests, "
                        "press for processor obligations, and ask the client to confirm whether any "
                        "cross-border transfer safeguards are already in place."
                    ),
                    ordinal=0,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                ),
                KnowledgeChunk(
                    id="chunk-discovery-plan-1",
                    knowledge_config_id="knowledge-box-matters",
                    document_id="doc-box-discovery-plan",
                    tenant_id="tenant-example",
                    source_name="Discovery plan and custodians.xlsx",
                    source_uri="box://matter-1042/discovery/discovery-plan-custodians.xlsx",
                    source_type="box",
                    text=(
                        "Discovery plan: priority custodians are the product lead, privacy officer, "
                        "and customer success director. Proposed collection should be staged after "
                        "the protective order is entered."
                    ),
                    ordinal=0,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                ),
                KnowledgeChunk(
                    id="chunk-client-update-1",
                    knowledge_config_id="knowledge-box-matters",
                    document_id="doc-box-client-update",
                    tenant_id="tenant-example",
                    source_name="Client weekly update draft.md",
                    source_uri="box://matter-1042/client-updates/weekly-update-draft.md",
                    source_type="box",
                    text=(
                        "Client weekly update draft: lead with the response deadline, summarize the "
                        "four risk areas, note discovery sequencing, and identify client decisions "
                        "needed before sending the update package."
                    ),
                    ordinal=0,
                    acl_group_ids=["group-litigation"],
                    updated_at="Seeded sample data",
                ),
            ]
        }
        if (
            not self._identity_config_cutover_required
            and
            self._identity_config_metadata is None
            and self._identity_config_staged_metadata is None
            and not self._identity_config_legacy_import_pending
        ):
            self._bootstrap_knowledge_vector_store()
            self.vector_store.backfill_dense_vectors()
        self.tool_configs: dict[str, ToolConfig] = {
            "tool-agent-workflow": ToolConfig(
                id="tool-agent-workflow",
                tenant_id="tenant-example",
                name="Agent Workflow Runner",
                tool_type="workflow",
                endpoint_url="/api/agents/runs",
                approval_required=True,
                allowed_group_ids=["group-litigation", "group-finance"],
                settings={
                    "description": "Runs multi-step legal work orders with source gathering, drafting, and approvals.",
                    "status": "ready",
                    "scopes": ["agent.run", "artifact.write", "mail.draft"],
                    "connected_model_ids": ["agent-client-update"],
                },
            ),
            "tool-hermes-agent-mcp": ToolConfig(
                id="tool-hermes-agent-mcp",
                tenant_id="tenant-example",
                name="Hermes Agent MCP",
                tool_type="mcp",
                endpoint_url="stdio://hermes mcp serve",
                approval_required=True,
                allowed_group_ids=["group-litigation", "group-finance"],
                settings={
                    "description": "Runs Hermes as an MCP companion for selected agent profiles.",
                    "status": "ready",
                    "transport": "stdio",
                    "command": "hermes",
                    "args": ["mcp", "serve"],
                    "auth_type": "oauth",
                    "client_id": "hermes-agent-mcp-client",
                    "oauth_authorization_url": "https://hermes.example.local/oauth/authorize",
                    "oauth_callback_url": "http://localhost:8000/api/tools/tool-hermes-agent-mcp/oauth/callback",
                    "mcp_server": "hermes-agent",
                    "capabilities": ["tools", "resources", "prompts"],
                    "connected_model_ids": ["agent-client-update"],
                    "scopes": ["mcp.invoke", "agent.run", "artifact.write"],
                    "skill_files": ["client-update-package", "citation-discipline"],
                    "prompt_templates": ["client-update", "approval-email"],
                    "hermes_companion": True,
                },
                secret_set=True,
                masked_secret=mask_secret(raw_config_secrets["tool:tool-hermes-agent-mcp"]),
            ),
            "tool-template-prompts": ToolConfig(
                id="tool-template-prompts",
                tenant_id="tenant-example",
                name="Template Prompt Library",
                tool_type="prompt-library",
                endpoint_url="prompt-library://tenant-example/templates",
                approval_required=False,
                allowed_group_ids=["group-litigation", "group-finance"],
                settings={
                    "description": "Reusable meta prompts and work-order templates available to agent profiles.",
                    "status": "ready",
                    "scopes": ["prompt.read", "prompt.write"],
                    "connected_model_ids": ["agent-client-update"],
                    "prompt_templates": ["client-update", "approval-email", "matter-summary"],
                },
            ),
            "tool-skill-library": ToolConfig(
                id="tool-skill-library",
                tenant_id="tenant-example",
                name="Skill File Library",
                tool_type="skill-library",
                endpoint_url="skills://tenant-example/legal-workflows",
                approval_required=False,
                allowed_group_ids=["group-litigation", "group-finance"],
                settings={
                    "description": "Skill files used to constrain agent workflows, output structure, and approvals.",
                    "status": "ready",
                    "scopes": ["skill.read", "skill.write"],
                    "connected_model_ids": ["agent-client-update"],
                    "skill_files": ["client-update-package", "citation-discipline", "approval-routing"],
                },
            ),
            "tool-web-search": ToolConfig(
                id="tool-web-search",
                tenant_id="tenant-example",
                name="Web Search",
                tool_type="provider-web-search",
                endpoint_url="openrouter://plugins/web",
                approval_required=False,
                allowed_group_ids=["group-litigation", "group-finance"],
                settings={
                    "description": "Uses OpenRouter's web plugin for current public sources with URL citations.",
                    "status": "ready",
                    "scopes": ["web.read"],
                    "connected_model_ids": ["openrouter-openai-gpt-5-5", "openrouter-openai-gpt-4o-mini", "agent-client-update"],
                    "provider_tool": "web",
                    "max_results": 5,
                },
            ),
            "tool-hermes-example": ToolConfig(
                id="tool-hermes-example",
                tenant_id="tenant-example",
                name="Hermes Client Updates",
                tool_type="webhook",
                endpoint_url="https://hermes.aperture.local/jobs",
                approval_required=True,
                allowed_group_ids=["group-litigation"],
                settings={"timeout_seconds": 45, "send_notifications": True},
                secret_set=True,
                masked_secret=mask_secret(raw_config_secrets["tool:tool-hermes-example"]),
            )
        }
        # SQL-backed compatibility mappings are stable objects. Values are
        # detached and immutable, and chat sessions are derived dynamically
        # from canonical thread rows rather than stored separately.
        self.chat_threads = self.application_state_repository.chat_threads
        self.chat_folders = self.application_state_repository.chat_folders
        self.chat_sessions = self.application_state_repository.chat_sessions
        self.chat_attachments = self.application_state_repository.chat_attachments
        self.security_alerts: dict[str, SecurityAlert] = {}
        self.agent_runs: dict[str, AgentRun] = {
            "run-hermes-client-update": AgentRun(
                id="run-hermes-client-update",
                tenant_id="tenant-example",
                name="Generate client update package",
                is_sample=True,
                status="Waiting for approval",
                started_by="Alex Morgan",
                started_at="10:24 AM",
                sources=["Matter folder", "Outlook thread", "SharePoint policy", "Box files"],
                steps=[
                    AgentStep(id="step-1", label="Intake", status="Completed", detail="Work order received"),
                    AgentStep(id="step-2", label="Gather Sources", status="Completed", detail="Retrieved 42 items"),
                    AgentStep(id="step-3", label="Draft Document", status="Completed", detail="Drafted documents and email"),
                    AgentStep(id="step-4", label="Review", status="In progress", detail="Awaiting approval"),
                    AgentStep(id="step-5", label="Send Notification", status="Pending", detail="Email pending approval"),
                ],
                artifacts=[
                    Artifact(id="artifact-docx", name="Client_Update.docx", kind="DOCX", size="184 KB", created_at="10:26 AM"),
                    Artifact(id="artifact-pdf", name="Executive_Summary.pdf", kind="PDF", size="612 KB", created_at="10:26 AM"),
                    Artifact(id="artifact-email", name="Email_Draft.eml", kind="EML", size="42 KB", created_at="10:26 AM"),
                ],
                approvals=[
                    Approval(
                        id="approval-email",
                        title="Email notifications require approval",
                        requested_by="Hermes Connector",
                        requested_at="10:26 AM",
                    )
                ],
                logs=[
                    {"time": "10:24:12 AM", "step": "Intake", "event": "Work order received and validated"},
                    {"time": "10:24:35 AM", "step": "Gather Sources", "event": "Sources retrieved"},
                    {"time": "10:26:18 AM", "step": "Draft Document", "event": "Draft generated"},
                    {"time": "10:26:40 AM", "step": "Review", "event": "Waiting for approval"},
                ],
            )
        }
        self.automations: dict[str, Automation] = {}
        # Hermes companion memories, keyed by memory id. Starts empty; only
        # real conversations populate it.
        self.companion_memories: dict[str, CompanionMemory] = {}
        self.content_filters: dict[str, ContentFilter] = {}
        # Personalization memory. Deliberately kept out of the shared knowledge
        # vector index so it can never surface through knowledge retrieval.
        self.user_memories: dict[str, UserMemory] = {}
        self.tenant_memory_policies: dict[str, TenantMemoryPolicy] = {}
        self.tenant_retention_policies: dict[str, TenantRetentionPolicy] = {}
        self.user_memory_settings: dict[str, UserMemorySettings] = {}
        self.platform_settings = PlatformSettings()
        self.audit_events = self.application_state_repository.audit_events
        self.elastic_events = self.application_state_repository.elastic_events
        # Elastic delivery status for the platform console; in-memory only
        # (resets on restart), set by app/core/elastic_export.py.
        self.elastic_last_delivery_at: str | None = None
        self.elastic_last_delivery_error: str | None = None
        self.password_credentials: dict[str, str] = {}
        self.temporary_password_user_ids: set[str] = set()
        self.user_api_keys = self.application_state_repository.user_api_keys
        self.session_issued_before_ms = (
            self.application_state_repository.session_issued_before_ms
        )
        # Per-tenant SCIM credentials are persisted only as SHA-256 digests.
        # The raw bearer value is returned exactly once by ``mint_scim_token``.
        self.scim_tokens: dict[str, ScimTokenRecord] = {}
        # SQL-backed compatibility views remain append-ordered oldest-first.
        self.usage_records = self.application_state_repository.usage_records
        self._usage_records_loaded = True
        # Custom alert rules and their trigger/delivery log.
        self.alert_rules: dict[str, AlertRule] = {}
        self.alert_notifications = self.application_state_repository.alert_notifications
        self.email_settings = EmailSettings()
        if not seed_demo_data_enabled:
            self._reset_to_blank_platform()
        self._initialize_identity_config_authority()
        self._runtime_state_atexit_callback = partial(
            _close_store_at_exit,
            weakref.ref(self),
        )
        atexit.register(self._runtime_state_atexit_callback)
        self._upgrade_legacy_secret_tokens()
        self.reconcile_provider_model_counts()
        self._reconcile_model_tenant_scope()
        self.ensure_default_user_group()
        for tenant_id in self.tenants:
            self.usage_budget_repository.provision_budget(tenant_id)
        # Review accepts work only after the relational schema and any legacy
        # import marker have been verified above. Its audit and usage activity
        # can therefore be written without touching runtime_state.json.
        self.review_activity_sink_sql_only = True

    def snapshot(self, current_tenant_id: str | None = None) -> dict[str, Any]:
        current_tenant = self.tenants.get(current_tenant_id) if current_tenant_id else None
        if current_tenant is None and len(self.tenants) == 1:
            current_tenant = next(iter(self.tenants.values()))
        return {
            "tenants": list(self.tenants.values()),
            # Multi-tenant callers must name their tenant explicitly. Returning
            # an insertion-order tenant here would leak branding and policy.
            "currentTenant": current_tenant,
            "providers": list(self.providers.values()),
            "models": list(self.models.values()),
            "groups": self.groups_with_live_counts(),
            "users": list(self.users.values()),
            "connectors": list(self.connectors.values()),
            "connectorConfigs": list(self.connector_configs.values()),
            "ssoConfigs": list(self.sso_configs.values()),
            "knowledgeConfigs": list(self.knowledge_configs.values()),
            "toolConfigs": list(self.tool_configs.values()),
            "promptTemplates": list(self.prompt_templates.values()),
            "skillFiles": list(self.skill_files.values()),
            "chatSessions": list(self.chat_sessions.values()),
            "agentRuns": list(self.agent_runs.values()),
            "automations": list(self.automations.values()),
        }

    def tenant_by_host(self, host: str | None) -> Tenant | None:
        normalized = _request_host(host or "")
        if not normalized:
            return None
        with self._store_lock:
            matches = [
                tenant
                for tenant in self.tenants.values()
                if tenant.custom_domain
                and _request_host(tenant.custom_domain) == normalized
            ]
            return matches[0] if len(matches) == 1 else None

    def tenant_by_slug(self, slug: str | None) -> Tenant | None:
        if not slug:
            return None
        try:
            normalized = _normalize_tenant_slug(slug)
        except TenantStoreError:
            return None
        with self._store_lock:
            matches = [tenant for tenant in self.tenants.values() if tenant.slug == normalized]
            return matches[0] if len(matches) == 1 else None

    def tenant_summary(self, tenant: Tenant) -> TenantSummary:
        with self._store_lock:
            return TenantSummary(
                **tenant.model_dump(),
                user_count=sum(1 for user in self.users.values() if user.tenant_id == tenant.id),
                group_count=sum(1 for group in self.groups.values() if group.tenant_id == tenant.id),
                scim_token_count=sum(
                    1
                    for record in self.scim_tokens.values()
                    if record.tenant_id == tenant.id and record.revoked_at is None
                ),
            )

    def create_tenant(self, payload: TenantCreate, actor: User) -> TenantSummary:
        slug = _normalize_tenant_slug(payload.slug)
        domain = _normalize_custom_domain(payload.custom_domain)
        self._validate_tenant_branding(payload.model_dump())
        tenant_id = (payload.id or f"tenant-{slug}").strip().lower()
        if re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,94}[a-z0-9])?", tenant_id) is None:
            raise TenantStoreError("Tenant id may contain only lowercase letters, numbers, and hyphens.")
        name = payload.name.strip()
        if not name:
            raise TenantStoreError("Tenant name is required.")
        with self._store_lock:
            self._assert_unique_tenant_identity(slug=slug, custom_domain=domain)
            if tenant_id in self.tenants:
                raise TenantConflictError("Tenant id already exists.")
            tenant = Tenant(
                **payload.model_dump(exclude={"id", "name", "slug", "custom_domain"}),
                id=tenant_id,
                name=name,
                slug=slug,
                custom_domain=domain,
            )
            default_group = default_user_group_for_tenant(tenant.id)
            if default_group.id in self.groups:
                raise TenantConflictError("Tenant default-group identity already exists.")
            self.usage_budget_repository.provision_budget(tenant.id)
            self.tenants[tenant.id] = tenant
            self.groups[default_group.id] = default_group
            if self.platform_settings.default_user_group_enabled:
                for model in self.models.values():
                    if (
                        model.platform_enabled
                        and model.tenant_id is None
                        and not model.is_custom
                        and not model.tenant_restricted
                    ):
                        model.group_ids = list(dict.fromkeys([*model.group_ids, default_group.id]))
            self.record_audit(
                actor,
                "platform.tenant_created",
                tenant.id,
                {"tenant_id": tenant.id, "name": tenant.name, "slug": tenant.slug, "custom_domain": domain},
            )
            self.save_runtime_state(urgent=True)
            return self.tenant_summary(tenant)

    def update_tenant(
        self,
        tenant_id: str,
        payload: TenantUpdate,
        actor: User,
        *,
        audit_action: str = "platform.tenant_updated",
    ) -> TenantSummary:
        updates = payload.model_dump(exclude_unset=True)
        if not updates:
            raise TenantStoreError("No tenant updates provided.")
        with self._store_lock:
            tenant = self.tenants.get(tenant_id)
            if tenant is None:
                raise KeyError(tenant_id)
            previous = tenant.model_dump(mode="json")
            if "slug" in updates:
                if updates["slug"] is None:
                    raise TenantStoreError("Tenant slug cannot be cleared.")
                updates["slug"] = _normalize_tenant_slug(str(updates["slug"]))
            if "name" in updates:
                name = str(updates["name"] or "").strip()
                if not name:
                    raise TenantStoreError("Tenant name cannot be cleared.")
                updates["name"] = name
            if "custom_domain" in updates:
                updates["custom_domain"] = _normalize_custom_domain(updates["custom_domain"])
            self._validate_tenant_branding(updates)
            self._assert_unique_tenant_identity(
                slug=str(updates.get("slug", tenant.slug)),
                custom_domain=updates.get("custom_domain", tenant.custom_domain),
                exclude_tenant_id=tenant.id,
            )
            for field, value in updates.items():
                setattr(tenant, field, value)
            self.record_audit(
                actor,
                audit_action,
                tenant.id,
                {
                    "tenant_id": tenant.id,
                    "name": tenant.name,
                    "changed": sorted(updates),
                    "previous_slug": previous["slug"],
                    "current_slug": tenant.slug,
                },
            )
            self.save_runtime_state(urgent=True)
            return self.tenant_summary(tenant)

    def delete_tenant(self, tenant_id: str, actor: User) -> Tenant:
        """Delete one tenant and every owned record under one store-wide lock.

        Historical audit/usage records and the Elastic outbox are retained for
        compliance and later retention-policy processing. A final
        platform-scoped deletion event is added without any secret values.
        """
        with self._store_lock:
            tenant = self.tenants.get(tenant_id)
            if tenant is None:
                raise KeyError(tenant_id)
            if len(self.tenants) <= 1:
                raise FinalTenantDeletionError("The final tenant cannot be deleted.")

            user_ids = {user.id for user in self.users.values() if user.tenant_id == tenant_id}
            group_ids = {group.id for group in self.groups.values() if group.tenant_id == tenant_id}
            knowledge_ids = {
                record.id for record in self.knowledge_configs.values() if record.tenant_id == tenant_id
            }
            connector_ids = {
                record.id for record in self.connector_configs.values() if record.tenant_id == tenant_id
            }
            sso_ids = {record.id for record in self.sso_configs.values() if record.tenant_id == tenant_id}
            tool_ids = {record.id for record in self.tool_configs.values() if record.tenant_id == tenant_id}
            prompt_ids = {
                record.id for record in self.prompt_templates.values() if record.tenant_id == tenant_id
            }
            skill_ids = {record.id for record in self.skill_files.values() if record.tenant_id == tenant_id}
            filter_ids = {
                record.id for record in self.content_filters.values() if record.tenant_id == tenant_id
            }
            model_ids = {
                model.id for model in self.models.values() if model.tenant_id == tenant_id
            }
            provider_key_ids = {
                key.id for key in self.provider_keys.values() if key.tenant_id == tenant_id
            }
            owned_secret_keys: set[str] = set()
            for resource_kind, resource_ids in (
                (ConfigurationSecretResourceKind.CONNECTOR_CONFIG, connector_ids),
                (ConfigurationSecretResourceKind.SSO_CONFIG, sso_ids),
                (ConfigurationSecretResourceKind.KNOWLEDGE_CONFIG, knowledge_ids),
                (ConfigurationSecretResourceKind.TOOL_CONFIG, tool_ids),
            ):
                for resource_id in sorted(resource_ids):
                    owned_secret_keys.update(
                        self.identity_config_repository.configuration_secret_keys_for_resource(
                            resource_kind=resource_kind,
                            resource_id=resource_id,
                        )
                    )

            deletion_cutoff_ms = int(datetime.now(UTC).timestamp() * 1000)
            for config_id in knowledge_ids:
                self.knowledge_documents.pop(config_id, None)
                self.knowledge_chunks.pop(config_id, None)

            for collection in (
                self.users,
                self.groups,
                self.models,
                self.connector_configs,
                self.sso_configs,
                self.knowledge_configs,
                self.tool_configs,
                self.prompt_templates,
                self.skill_files,
                self.security_alerts,
                self.agent_runs,
                self.automations,
                self.companion_memories,
                self.content_filters,
                self.user_memories,
                self.tenant_memory_policies,
                self.tenant_retention_policies,
                self.alert_rules,
                self.alert_notifications,
            ):
                for record_id, record in list(collection.items()):
                    if getattr(record, "tenant_id", None) == tenant_id:
                        collection.pop(record_id, None)

            # Memory settings are keyed by user, so they go with the tenant's users.
            for user_id in user_ids:
                self.user_memory_settings.pop(user_id, None)

            self.password_credentials = {
                user_id: value for user_id, value in self.password_credentials.items() if user_id not in user_ids
            }
            self.temporary_password_user_ids.difference_update(user_ids)
            for token_id, token in list(self.scim_tokens.items()):
                if token.tenant_id == tenant_id:
                    self.scim_tokens.pop(token_id, None)
            for secret_key in owned_secret_keys:
                self._configuration_secrets.pop(secret_key, None)
            for key_id in provider_key_ids:
                self.provider_keys.pop(key_id, None)
                self._encrypted_keys.pop(key_id, None)

            # Global catalog models survive but cannot retain references to the
            # deleted tenant's groups/configuration records.
            for model in self.models.values():
                model.group_ids = [value for value in model.group_ids if value not in group_ids]
                model.knowledge_config_ids = [
                    value for value in model.knowledge_config_ids if value not in knowledge_ids
                ]
                model.tool_config_ids = [value for value in model.tool_config_ids if value not in tool_ids]
                model.prompt_template_ids = [
                    value for value in model.prompt_template_ids if value not in prompt_ids
                ]
                model.skill_file_ids = [value for value in model.skill_file_ids if value not in skill_ids]
                model.content_filter_ids = [
                    value for value in model.content_filter_ids if value not in filter_ids
                ]
            for user in self.users.values():
                user.group_ids = [value for value in user.group_ids if value not in group_ids]
            for config in self.knowledge_configs.values():
                config.acl_group_ids = [value for value in config.acl_group_ids if value not in group_ids]
            for config in self.tool_configs.values():
                config.allowed_group_ids = [value for value in config.allowed_group_ids if value not in group_ids]
            for template in self.prompt_templates.values():
                template.group_ids = [value for value in template.group_ids if value not in group_ids]
            for skill in self.skill_files.values():
                skill.group_ids = [value for value in skill.group_ids if value not in group_ids]
            for config in self.sso_configs.values():
                config.mapped_groups = {
                    source: target
                    for source, target in config.mapped_groups.items()
                    if target not in group_ids
                }
            for documents in self.knowledge_documents.values():
                for document in documents:
                    document.acl_group_ids = [
                        value for value in document.acl_group_ids if value not in group_ids
                    ]
            for chunks in self.knowledge_chunks.values():
                for chunk in chunks:
                    chunk.acl_group_ids = [value for value in chunk.acl_group_ids if value not in group_ids]
            for automation in self.automations.values():
                if any(step.model_id in model_ids for step in automation.steps):
                    automation.steps = [step for step in automation.steps if step.model_id not in model_ids]
                    automation.enabled = False

            self.tenants.pop(tenant_id)
            self.reconcile_provider_model_counts()
            expected_digest = self._identity_config_live_digest
            if expected_digest is None:
                raise IdentityConfigCorruptionError(
                    "Active identity/config cache has no relational generation token."
                )
            state = scope_provider_credentials_for_import(
                self.vault,
                validate_v4_identity_config_state(self._identity_config_v4_payload()),
            )
            try:
                replaced, cleanup_job = (
                    self.identity_config_repository.replace_active_snapshot_with_cleanup_job(
                        state=state,
                        expected_relational_digest=expected_digest,
                        resource_kind="tenant",
                        resource_id=tenant_id,
                        tenant_id=tenant_id,
                        session_cutoff_ms=deletion_cutoff_ms,
                        cleanup_job_id=f"identity-cleanup-{uuid4()}",
                    )
                )
            except Exception:
                current = self.identity_config_repository.load_active_snapshot()
                if current is not None:
                    self._load_identity_config_snapshot(current)
                    self._identity_config_live_digest = current.relational_digest
                raise
            self._identity_config_live_digest = replaced.relational_digest
            self._runtime_state_dirty = False
            cleanup_counts = self._run_identity_cleanup_job(cleanup_job)
            self.record_audit(
                actor,
                "platform.tenant_deleted",
                tenant_id,
                {
                    "tenant_id": tenant_id,
                    "name": tenant.name,
                    "removed_users": len(user_ids),
                    "removed_groups": len(group_ids),
                    "removed_knowledge_configs": len(knowledge_ids),
                    **cleanup_counts,
                },
                runtime_state_changed=False,
            )
            return tenant

    def clear_matter_knowledge_references(self, matter_id: str) -> int:
        """Null identity-owned knowledge references to one deleted matter."""

        with self._store_lock:
            cleared = 0
            for config in self.knowledge_configs.values():
                if config.matter_id == matter_id:
                    config.matter_id = None
                    cleared += 1
            if cleared:
                self.save_runtime_state()
            return cleared

    def count_matter_references(self, matter_id: str) -> int:
        """Count remaining references so legacy cleanup can prove completion."""

        with self._store_lock:
            remaining = sum(
                1
                for config in self.knowledge_configs.values()
                if config.matter_id == matter_id
            )
            remaining += sum(
                1
                for thread in self.chat_threads.values()
                if thread.matter_id == matter_id
            )
            remaining += sum(
                1
                for folder in self.chat_folders.values()
                if folder.matter_id == matter_id
            )
            return remaining

    def resume_identity_cleanup_jobs(self) -> int:
        """Finish identity-first cleanup generations before accepting traffic."""

        completed = 0
        with self._store_lock:
            for job in self.identity_cleanup_repository.list_incomplete_cleanup_jobs():
                if job.identity_committed_at is None:
                    raise IdentityConfigCorruptionError(
                        "A cleanup job exists without a committed identity deletion."
                    )
                self._run_identity_cleanup_job(job, startup_reclaim=True)
                completed += 1
        return completed

    def _run_identity_cleanup_job(
        self,
        job: IdentityCleanupJob,
        *,
        startup_reclaim: bool = False,
    ) -> dict[str, int]:
        """Run idempotent external stages under the durable attempt fence."""

        if job.status != "running":
            claimed_at = datetime.now(UTC)
            if (
                startup_reclaim
                and job.lease_expires_at is not None
                and job.lease_expires_at >= claimed_at
            ):
                claimed_at = job.lease_expires_at + timedelta(microseconds=1)
            job = self.identity_cleanup_repository.claim_cleanup_job(
                job.job_id,
                tenant_id=job.tenant_id,
                now=claimed_at,
            )
        elif startup_reclaim:
            claimed_at = datetime.now(UTC)
            if job.lease_expires_at is not None and job.lease_expires_at >= claimed_at:
                claimed_at = job.lease_expires_at + timedelta(microseconds=1)
            job = self.identity_cleanup_repository.claim_cleanup_job(
                job.job_id,
                tenant_id=job.tenant_id,
                now=claimed_at,
            )

        counts: dict[str, int] = {}
        while job.next_stage is not None:
            stage = job.next_stage
            completed_at = max(datetime.now(UTC), job.updated_at)
            try:
                if stage == "application":
                    if job.resource_kind == "tenant":
                        counts.update(
                            self.application_state_repository.purge_a5_tenant(
                                job.tenant_id,
                                job.user_session_cutoffs,
                                reason="tenant-deleted",
                                updated_at=completed_at,
                            )
                        )
                        self.usage_budget_repository.delete_budget(job.tenant_id)
                    elif job.resource_kind == "user":
                        counts.update(
                            self.application_state_repository.purge_a5_user(
                                job.resource_id,
                                job.tenant_id,
                                job.user_session_cutoffs[job.resource_id],
                                reason="user-deleted",
                                updated_at=completed_at,
                            )
                        )
                elif stage == "review":
                    if job.resource_kind == "tenant":
                        from app.repositories.review_deps import purge_review_tenant

                        counts["removed_review_matrices"] = purge_review_tenant(
                            job.tenant_id
                        )
                    elif job.resource_kind == "user":
                        from app.repositories.review_deps import purge_review_owner

                        counts["removed_review_matrices"] = purge_review_owner(
                            job.resource_id
                        )
                elif stage == "knowledge_vector":
                    if job.resource_kind == "tenant":
                        counts["removed_vector_rows"] = self.vector_store.delete_tenant(
                            job.tenant_id
                        )
                    else:
                        self.vector_store.delete_config(job.resource_id)
                elif stage == "m9":
                    if job.resource_kind == "tenant":
                        counts.update(self.matter_draft_repository.purge_tenant(job.tenant_id))
                    elif job.resource_kind == "user":
                        counts.update(
                            self.matter_draft_repository.purge_user(
                                tenant_id=job.tenant_id,
                                user_id=job.resource_id,
                            )
                        )
                else:
                    raise IdentityConfigCorruptionError(
                        "Cleanup resumed before its identity stage committed."
                    )
                job = self.identity_cleanup_repository.mark_cleanup_stage(
                    job.job_id,
                    tenant_id=job.tenant_id,
                    stage=stage,
                    expected_attempt=job.attempt_count,
                    now=max(datetime.now(UTC), completed_at),
                )
            except Exception:
                try:
                    self.identity_cleanup_repository.fail_cleanup_job(
                        job.job_id,
                        tenant_id=job.tenant_id,
                        stage=stage,
                        expected_attempt=job.attempt_count,
                        now=max(datetime.now(UTC), completed_at),
                    )
                except Exception:  # noqa: BLE001 - retain the original stage failure
                    logger.exception("Failed to persist cleanup failure for %s", job.job_id)
                raise
        self.identity_cleanup_repository.complete_cleanup_job(
            job.job_id,
            tenant_id=job.tenant_id,
            expected_attempt=job.attempt_count,
            now=max(datetime.now(UTC), job.updated_at),
        )
        return counts

    def mint_scim_token(self, tenant_id: str, actor: User) -> tuple[ScimTokenSummary, str]:
        with self._store_lock:
            if tenant_id not in self.tenants:
                raise KeyError(tenant_id)
            secret_value = f"ap_scim_{secrets.token_urlsafe(32)}"
            record = ScimTokenRecord(
                id=f"scim-token-{uuid4()}",
                tenant_id=tenant_id,
                token_hash=hashlib.sha256(secret_value.encode("utf-8")).hexdigest(),
                token_prefix=f"{secret_value[:15]}...",
                created_at=datetime.now(UTC).isoformat(),
                created_by=actor.id,
            )
            self.scim_tokens[record.id] = record
            self.record_audit(
                actor,
                "platform.scim_token_created",
                record.id,
                {"tenant_id": tenant_id, "token_prefix": record.token_prefix},
            )
            self.save_runtime_state(urgent=True)
            return ScimTokenSummary(**record.model_dump(exclude={"token_hash"})), secret_value

    def revoke_scim_token(self, tenant_id: str, token_id: str, actor: User) -> ScimTokenSummary:
        with self._store_lock:
            record = self.scim_tokens.get(token_id)
            if record is None or record.tenant_id != tenant_id:
                raise KeyError(token_id)
            if record.revoked_at is None:
                record.revoked_at = datetime.now(UTC).isoformat()
                self.record_audit(
                    actor,
                    "platform.scim_token_revoked",
                    record.id,
                    {"tenant_id": tenant_id, "token_prefix": record.token_prefix},
                )
                self.save_runtime_state(urgent=True)
            return ScimTokenSummary(**record.model_dump(exclude={"token_hash"}))

    def scim_token_summaries(self, tenant_id: str) -> list[ScimTokenSummary]:
        with self._store_lock:
            return [
                ScimTokenSummary(**record.model_dump(exclude={"token_hash"}))
                for record in self.scim_tokens.values()
                if record.tenant_id == tenant_id
            ]

    def tenant_for_scim_token(self, secret_value: str) -> Tenant | None:
        candidate_hash = hashlib.sha256(secret_value.encode("utf-8")).hexdigest()
        matched_tenant_id: str | None = None
        with self._store_lock:
            # Traverse every active token and use constant-time digest compares;
            # never persist or log the caller-provided bearer value.
            for record in self.scim_tokens.values():
                if record.revoked_at is None and hmac.compare_digest(record.token_hash, candidate_hash):
                    matched_tenant_id = record.tenant_id
            return self.tenants.get(matched_tenant_id) if matched_tenant_id else None

    def _assert_unique_tenant_identity(
        self,
        *,
        slug: str,
        custom_domain: str | None,
        exclude_tenant_id: str | None = None,
    ) -> None:
        for tenant in self.tenants.values():
            if tenant.id == exclude_tenant_id:
                continue
            if tenant.slug == slug:
                raise TenantConflictError("Tenant slug already exists.")
            if custom_domain and tenant.custom_domain and tenant.custom_domain.casefold() == custom_domain.casefold():
                raise TenantConflictError("Tenant custom domain already exists.")

    @staticmethod
    def _validate_tenant_branding(values: dict[str, Any]) -> None:
        branding_fields = TenantBrandingUpdateRequest.model_fields.keys()
        candidate = {key: value for key, value in values.items() if key in branding_fields}
        if not candidate:
            return
        try:
            TenantBrandingUpdateRequest.model_validate(candidate)
        except ValueError as exc:
            raise TenantStoreError(str(exc)) from exc

    def _reconcile_model_tenant_scope(self) -> None:
        """Conservatively bind legacy agent profiles to an inferable tenant."""
        group_tenants = {group.id: group.tenant_id for group in self.groups.values()}
        resource_tenants = {
            **{record.id: record.tenant_id for record in self.knowledge_configs.values()},
            **{record.id: record.tenant_id for record in self.tool_configs.values()},
            **{record.id: record.tenant_id for record in self.prompt_templates.values()},
            **{record.id: record.tenant_id for record in self.skill_files.values()},
        }
        for model in self.models.values():
            if model.tenant_id is not None or not model.is_custom:
                continue
            candidates = {
                tenant_id
                for reference_id in (
                    *model.group_ids,
                    *model.knowledge_config_ids,
                    *model.tool_config_ids,
                    *model.prompt_template_ids,
                    *model.skill_file_ids,
                )
                if (tenant_id := group_tenants.get(reference_id) or resource_tenants.get(reference_id))
            }
            if len(candidates) == 1:
                model.tenant_id = next(iter(candidates))
            elif not candidates and len(self.tenants) == 1:
                model.tenant_id = next(iter(self.tenants))

    def reconcile_provider_model_counts(self) -> None:
        """Derive provider inventory counters from the real stored catalog."""
        for provider in self.providers.values():
            provider_models = [
                model for model in self.models.values() if model.provider_id == provider.id
            ]
            provider.model_count = len(provider_models)
            provider.enabled_model_count = sum(
                1 for model in provider_models if model.platform_enabled
            )

    def _reset_to_blank_platform(self) -> None:
        self.tenants = {
            "tenant-example": Tenant(
                id="tenant-example",
                name="New Organization",
                slug="new-organization",
                custom_domain=None,
                chat_brand_name="Aperture Chat",
                logo_url=None,
                icon_url=None,
            )
        }
        self.users.clear()
        self.groups.clear()
        self.providers.clear()
        self.models.clear()
        self.prompt_templates.clear()
        self.skill_files.clear()
        self.provider_keys.clear()
        self._encrypted_keys.clear()
        # The connector catalog is product capability, not demo content: a blank
        # platform still offers Google Drive/Graph/Box/iManage etc. for setup.
        # Only tenant-level configurations (credentials) are cleared.
        self.connector_configs.clear()
        self.sso_configs.clear()
        self.knowledge_configs.clear()
        self.knowledge_documents.clear()
        self.knowledge_chunks.clear()
        self._configuration_secrets.clear()
        self.tool_configs.clear()
        # A5 collections are SQL authority. ``prepare_runtime_state`` may have
        # imported them before this seed reset runs, so never clear them here.
        self.security_alerts.clear()
        self.agent_runs.clear()
        self.automations.clear()
        self.content_filters.clear()
        self.user_memories.clear()
        self.tenant_memory_policies.clear()
        self.tenant_retention_policies.clear()
        self.user_memory_settings.clear()
        self.password_credentials.clear()
        self.temporary_password_user_ids.clear()
        self.scim_tokens.clear()
        self.alert_rules.clear()
        self.email_settings = EmailSettings()
        self.platform_settings = PlatformSettings()
        if (
            self._identity_config_metadata is None
            and self._identity_config_staged_metadata is None
        ):
            self.vector_store.clear_all()

    def ensure_default_user_group(self) -> None:
        if not self.tenants:
            return
        for tenant_id in self.tenants:
            default_group = next(
                (
                    group
                    for group in self.groups.values()
                    if group.tenant_id == tenant_id and (group.default_group or group.id == DEFAULT_USER_GROUP_ID)
                ),
                None,
            )
            created_default_group = default_group is None
            if default_group is None:
                default_group = default_user_group_for_tenant(tenant_id)
                self.groups[default_group.id] = default_group
            else:
                default_group.default_group = True
                if not default_group.name.strip():
                    default_group.name = "Default Users"
            for user in self.users.values():
                if (
                    self.platform_settings.default_user_group_enabled
                    and user.tenant_id == tenant_id
                    and user.active
                    and user.role != Role.PLATFORM_OWNER
                    and not user.group_ids
                ):
                    user.group_ids = [default_group.id]
            default_group.user_count = sum(
                1
                for user in self.users.values()
                if user.tenant_id == tenant_id and user.role != Role.PLATFORM_OWNER and default_group.id in user.group_ids
            )
            if created_default_group and self.platform_settings.default_user_group_enabled:
                for model in self.models.values():
                    if (
                        model.platform_enabled
                        and model.tenant_id is None
                        and not model.is_custom
                        and not model.tenant_restricted
                        and default_group.id not in model.group_ids
                    ):
                        model.group_ids = [*model.group_ids, default_group.id]

    def default_group_for_tenant(self, tenant_id: str) -> Group | None:
        with self._store_lock:
            return next(
                (
                    group
                    for group in self.groups.values()
                    if group.tenant_id == tenant_id and group.default_group
                ),
                None,
            )

    def ensure_default_openrouter_model(self, provider: Provider) -> ModelConfig:
        upstream_model_id = self.openrouter_default_model
        model_id = _seed_model_config_id(provider, upstream_model_id)
        model = self.models.get(model_id)
        if model is None:
            model = ModelConfig(
                id=model_id,
                provider_id=provider.id,
                provider_name=provider.name,
                name=f"OpenRouter: {upstream_model_id}",
                upstream_model_id=upstream_model_id,
                system_prompt="Use connected workspace context where available and cite sources when requested.",
                notes="Default OpenRouter model from backend configuration.",
                context_window=128000,
                # Provider-created defaults should be owner-visible but remain
                # unavailable to users until explicitly enabled.
                platform_enabled=False,
                group_ids=[],
                visibility="organization",
            )
            self.models[model_id] = model
        else:
            model.provider_id = provider.id
            model.provider_name = provider.name
            model.name = f"OpenRouter: {upstream_model_id}"
            model.upstream_model_id = upstream_model_id
        provider_models = [item for item in self.models.values() if item.provider_id == provider.id]
        provider.model_count = len(provider_models)
        provider.enabled_model_count = sum(1 for item in provider_models if item.platform_enabled)
        return model

    def provider_key_secret(self, key_id: str) -> ProviderKeySecret:
        public = self.provider_keys[key_id]
        secret_value = decrypt_provider_credential_secret(
            self.vault,
            self._encrypted_keys[key_id],
            context=_provider_credential_cipher_context(public),
        )
        return ProviderKeySecret(**public.model_dump(), secret_value=secret_value)

    def provider_key_secret_for_provider(
        self,
        provider_id: str,
        tenant_id: str | None = None,
    ) -> ProviderKeySecret | None:
        """Resolve one exact tenant credential, then its platform fallback."""

        if self._identity_config_metadata is not None:
            bundle = self.identity_config_repository.resolve_provider_credential(
                provider_id=provider_id,
                tenant_id=tenant_id,
            )
            if bundle is None:
                return None
            public = ProviderKey.model_validate(bundle.metadata)
            if (
                public.status.casefold() != "active"
                or self.provider_key_is_expired(public)
            ):
                return None
            return ProviderKeySecret(
                **public.model_dump(),
                secret_value=decrypt_provider_credential_secret(
                    self.vault,
                    bundle.ciphertext,
                    context=ProviderCredentialCipherContext.from_binding(bundle.binding),
                ),
            )

        # Pre-cutover compatibility remains deterministic and fail-closed; it
        # never selects a credential by dictionary insertion order.
        provider_keys = [
            key for key in self.provider_keys.values() if key.provider_id == provider_id
        ]
        scoped_keys = (
            [key for key in provider_keys if key.tenant_id == tenant_id]
            if tenant_id is not None
            and any(key.tenant_id == tenant_id for key in provider_keys)
            else [key for key in provider_keys if key.tenant_id is None]
        )
        keys_by_id = {
            key.id: key
            for key in scoped_keys
            if key.status.casefold() == "active"
        }
        if len(keys_by_id) != 1:
            return None
        selected = select_provider_credential_binding(
            provider_id=provider_id,
            tenant_id=next(iter(keys_by_id.values())).tenant_id,
            bindings=(
                ProviderCredentialBinding(
                    provider_id=key.provider_id,
                    key_id=key.id,
                    tenant_id=key.tenant_id,
                )
                for key in keys_by_id.values()
            ),
        )
        if selected is None:
            return None
        selected_key = keys_by_id[selected.key_id]
        if self.provider_key_is_expired(selected_key):
            return None
        return self.provider_key_secret(selected_key.id)

    def provider_key_is_expired(self, key: ProviderKey) -> bool:
        return _provider_key_is_expired(key)

    def provider_key_records(self) -> list[ProviderKey]:
        records: list[ProviderKey] = []
        for key in self.provider_keys.values():
            record = key.model_copy(deep=True)
            if self.provider_key_is_expired(record):
                record.status = "Expired"
            records.append(record)
        return records

    def create_provider_key(
        self,
        *,
        key_id: str,
        provider: Provider,
        name: str,
        environment: str,
        status: str,
        expires: str,
        secret_value: str,
        tenant_id: str | None = None,
    ) -> ProviderKey:
        if tenant_id is not None and tenant_id not in self.tenants:
            raise KeyError(tenant_id)
        created_at = datetime.now(UTC)
        expires_at = _parse_vault_expiry(expires)
        effective_status = "Expired" if expires_at is not None and expires_at.date() < created_at.date() else status
        key = ProviderKey(
            id=key_id,
            provider_id=provider.id,
            tenant_id=tenant_id,
            provider_name=provider.name,
            name=name,
            environment=environment,
            status=effective_status,
            last_rotated=_format_vault_time(created_at),
            expires=expires,
            masked_value=mask_secret(secret_value),
        )
        encrypted_secret = encrypt_provider_credential_secret(
            self.vault,
            secret_value,
            context=_provider_credential_cipher_context(key),
        )
        with self._store_lock:
            if key.status.casefold() == "active":
                for existing in self.provider_keys.values():
                    if (
                        existing.provider_id == provider.id
                        and existing.tenant_id == tenant_id
                        and existing.status.casefold() == "active"
                    ):
                        existing.status = "Inactive"
            self._encrypted_keys[key.id] = encrypted_secret
            self.provider_keys[key.id] = key
            if (
                provider.kind.strip().lower() == "openrouter"
                and key.tenant_id is None
                and key.status.lower() == "active"
            ):
                self.ensure_default_openrouter_model(provider)
            self.save_runtime_state(urgent=True)
            return key

    def rotate_provider_key(self, key_id: str) -> ProviderKey:
        with self._store_lock:
            public = self.provider_keys[key_id]
            provider = self.providers.get(public.provider_id)
            prefix = "sk"
            if provider is not None and provider.kind == "azure-openai":
                prefix = "az"
            elif provider is not None and provider.kind == "openrouter":
                prefix = "sk-or-v1"
            elif provider is not None and provider.kind == "amazon-bedrock":
                prefix = "aws"
            new_secret = f"{prefix}-rotated-{uuid4().hex}"
            rotated_at = datetime.now(UTC)
            public.last_rotated = _format_vault_time(rotated_at)
            public.expires = _format_vault_date(rotated_at + timedelta(days=365))
            public.status = "Active"
            public.masked_value = mask_secret(new_secret)
            self._encrypted_keys[key_id] = encrypt_provider_credential_secret(
                self.vault,
                new_secret,
                context=_provider_credential_cipher_context(public),
            )
            self.save_runtime_state(urgent=True)
            return public

    def delete_provider_key(self, key_id: str) -> ProviderKey:
        with self._store_lock:
            public = self.provider_keys.pop(key_id)
            self._encrypted_keys.pop(key_id, None)
            self.save_runtime_state(urgent=True)
            return public

    def delete_user_account(
        self,
        user_id: str,
        *,
        updated_by: str | None = None,
        expected_user: User | None = None,
        expected_role: Role | None = None,
        expected_tenant_id: str | None = None,
        expected_active: bool | None = None,
        preserve_last_active_admin: bool = False,
    ) -> dict[str, int]:
        """Permanently remove a user and the runtime state only they own.

        Audit events are retained: they are the immutable record that the
        account existed and what it did. The caller persists the store.
        """
        from app.repositories.review_deps import purge_review_owner

        with self._store_lock:
            current = self.users.get(user_id)
            if expected_user is not None and (
                current is not expected_user
                or expected_user.id != user_id
                or (
                    expected_role is not None
                    and (current.role != expected_role or current.tenant_id != expected_tenant_id)
                )
                or (expected_active is not None and current.active is not expected_active)
            ):
                raise SessionUserStateError("The user selected for deletion is no longer current.")
            if preserve_last_active_admin and current is not None and current.active:
                self._assert_active_administrative_peer_locked(current)
            deletion_cutoff_ms = int(datetime.now(UTC).timestamp() * 1000)
            self.application_state_repository.advance_session_issued_before_ms_strict(
                user_id,
                current.tenant_id if current is not None else None,
                deletion_cutoff_ms,
                reason="user-deleted",
                updated_by=updated_by,
            )
            purge_review_owner(user_id)
            removed = self.application_state_repository.purge_a5_user(
                user_id,
                current.tenant_id if current is not None else None,
                deletion_cutoff_ms,
                reason="user-deleted",
                updated_by=updated_by,
            )
            self.users.pop(user_id, None)
            self.password_credentials.pop(user_id, None)
            self.temporary_password_user_ids.discard(user_id)
            # Memory rows must go with the account: snapshot validation
            # rejects a memory whose owner no longer exists, and the content
            # is private to the deleted user anyway. Count only, never text.
            memory_ids = [
                memory_id
                for memory_id, memory in self.user_memories.items()
                if memory.owner_user_id == user_id
            ]
            for memory_id in memory_ids:
                self.user_memories.pop(memory_id, None)
            self.user_memory_settings.pop(user_id, None)
            removed["user_memories"] = len(memory_ids)
            return removed

    def record_audit(
        self,
        actor: User,
        action: str,
        target: str,
        metadata: dict[str, object] | None = None,
        *,
        runtime_state_changed: bool = True,
    ) -> AuditEvent:
        with self._store_lock:
            redacted_metadata = redact_metadata(metadata or {})
            event = AuditEvent(
                id=f"audit-{uuid4()}",
                tenant_id=actor.tenant_id,
                actor_id=actor.id,
                actor_name=actor.display_name,
                actor_role=str(actor.role),
                action=action,
                action_type=_audit_action_type(action, redacted_metadata),
                target=target,
                target_type=_audit_target_type(action),
                target_name=self._audit_target_name(target, redacted_metadata),
                detail=_audit_detail(redacted_metadata),
                metadata=redacted_metadata,
            )
            self.application_state_repository.append_audit_with_outbox(event)
            try:
                evaluate_audit_event(self, event)
            except Exception:  # noqa: BLE001 - alerting must never break auditing
                logger.exception("Alert evaluation failed for %s", event.action)
            if runtime_state_changed:
                self.save_runtime_state()
            return event

    def record_usage(
        self,
        *,
        actor: User,
        model_id: str,
        provider_name: str = "",
        surface: str = "chat",
        usage: dict[str, Any] | None = None,
        thread_id: str | None = None,
        message_count: int = 1,
    ) -> UsageRecord:
        with self._store_lock:
            prompt_tokens = _usage_token(usage, "prompt_tokens")
            completion_tokens = _usage_token(usage, "completion_tokens")
            total_tokens = _usage_token(usage, "total_tokens")
            # The gateway zero-fills usage when a provider reports nothing; an
            # all-zero payload means "not reported", so token fields stay None
            # instead of fabricating zeros.
            if not any((prompt_tokens, completion_tokens, total_tokens)):
                prompt_tokens = completion_tokens = total_tokens = None
            record = UsageRecord(
                id=f"usage-{uuid4()}",
                tenant_id=actor.tenant_id,
                user_id=actor.id,
                user_name=actor.display_name,
                user_role=str(actor.role),
                model_id=model_id,
                provider_name=provider_name,
                surface=surface,
                message_count=message_count,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                thread_id=thread_id,
            )
            return self.application_state_repository.append_usage(
                record,
                USAGE_RECORDS_MAX,
            )

    def usage_records_newest_first(self) -> list[UsageRecord]:
        with self._store_lock:
            return self.application_state_repository.list_usage(newest_first=True)

    def usage_records_filtered(
        self,
        *,
        tenant_id: str | None = None,
        visible_user_ids: set[str] | None = None,
        user_id: str | None = None,
        from_date: str | None = None,
        through_date: str | None = None,
        newest_first: bool = False,
        limit: int | None = None,
    ) -> list[UsageRecord]:
        """Query SQL-owned usage with the consoles' inclusive date semantics."""

        created_from: datetime | None = None
        created_through: datetime | None = None
        invalid_date_filter = False
        if from_date:
            try:
                created_from = datetime.fromisoformat(
                    f"{from_date}T00:00:00+00:00"
                )
            except ValueError:
                invalid_date_filter = True
        if through_date:
            try:
                created_through = datetime.fromisoformat(
                    f"{through_date}T23:59:59.999999+00:00"
                )
            except ValueError:
                invalid_date_filter = True

        records = self.application_state_repository.list_usage(
            tenant_id=tenant_id,
            visible_user_ids=visible_user_ids,
            user_id=user_id,
            created_from=None if invalid_date_filter else created_from,
            created_through=None if invalid_date_filter else created_through,
            newest_first=newest_first,
            limit=None if invalid_date_filter else limit,
        )
        if invalid_date_filter:
            records = [
                record
                for record in records
                if (not from_date or record.created_at.date().isoformat() >= from_date)
                and (
                    not through_date
                    or record.created_at.date().isoformat() <= through_date
                )
            ]
            if limit is not None:
                records = records[:limit]
        return records

    def _backfill_usage_records(self) -> None:
        """Derive usage records from pre-existing chat threads, exactly once.

        Only assistant messages with a trustworthy ISO timestamp are included;
        records are never given invented timestamps or token counts.
        """
        records: list[UsageRecord] = []
        for thread in self.chat_threads.values():
            owner = self.users.get(thread.owner_user_id)
            model = self.models.get(thread.model_id)
            for message in thread.messages:
                if message.role != "assistant":
                    continue
                created_at = _parse_iso_timestamp(message.createdAtIso)
                if created_at is None:
                    continue
                prompt_tokens = _usage_token(message.usage, "prompt_tokens")
                completion_tokens = _usage_token(message.usage, "completion_tokens")
                total_tokens = _usage_token(message.usage, "total_tokens")
                if not any((prompt_tokens, completion_tokens, total_tokens)):
                    prompt_tokens = completion_tokens = total_tokens = None
                records.append(
                    UsageRecord(
                        id=f"usage-{uuid4()}",
                        tenant_id=thread.tenant_id,
                        user_id=thread.owner_user_id,
                        user_name=owner.display_name if owner else "",
                        user_role=str(owner.role) if owner else "",
                        model_id=thread.model_id,
                        provider_name=model.provider_name if model else "",
                        surface="chat",
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        total_tokens=total_tokens,
                        thread_id=thread.id,
                        source="backfill",
                        created_at=created_at,
                    )
                )
        records.sort(key=lambda record: record.created_at)
        self.usage_records = records[-USAGE_RECORDS_MAX:]
        self._usage_records_loaded = True

    def has_active_platform_owner(self) -> bool:
        return any(user.active and user.role == Role.PLATFORM_OWNER for user in self.users.values())

    def bootstrap_required(self) -> bool:
        return not self.has_active_platform_owner()

    def password_sign_in_available(self, tenant_id: str | None = None) -> bool:
        return any(
            user.active
            and user.id in self.password_credentials
            and (
                tenant_id is None
                or user.role == Role.PLATFORM_OWNER
                or user.tenant_id == tenant_id
            )
            for user in self.users.values()
        )

    def set_password_credential(self, user_id: str, password: str, *, temporary: bool = False) -> None:
        encoded_password = hash_password(password)
        with self._store_lock:
            self.password_credentials[user_id] = encoded_password
            if temporary:
                self.temporary_password_user_ids.add(user_id)
            else:
                self.temporary_password_user_ids.discard(user_id)
            self.save_runtime_state(urgent=True)

    def password_is_temporary(self, user_id: str) -> bool:
        return user_id in self.temporary_password_user_ids

    def verify_password_credential(self, user_id: str, password: str | None) -> bool:
        if password is None:
            return False
        return verify_password(password, self.password_credentials.get(user_id))

    def mfa_posture_for_user(
        self,
        expected_user: User,
    ) -> tuple[MfaPolicyState, TotpFactorState | None, int]:
        with self._store_lock:
            current = self.users.get(expected_user.id)
            if current is not expected_user or not current.active:
                raise SessionUserStateError("The MFA user is stale or inactive.")
            return self.application_state_repository.get_mfa_posture(
                user_id=current.id,
                tenant_id=current.tenant_id,
            )

    def begin_primary_mfa_challenge(
        self,
        expected_user: User,
        *,
        auth_method: str,
        sso_config_id: str | None,
    ) -> tuple[str, MfaChallengeState] | None:
        """Return a preauth bearer only when live policy/factor state requires it."""

        with self._store_lock:
            current = self.users.get(expected_user.id)
            if current is not expected_user or not current.active:
                raise SessionUserStateError("The primary-auth user is stale or inactive.")
            policy, factor, unused = self.application_state_repository.get_mfa_posture(
                user_id=current.id,
                tenant_id=current.tenant_id,
            )
            if factor is not None:
                purpose = "verify"
                generation = factor.generation
            elif policy.required:
                purpose = "enroll"
                generation = None
            else:
                return None
            token = new_challenge_token()
            now = datetime.now(UTC)
            try:
                challenge = self.application_state_repository.create_mfa_challenge(
                    token_hash=hash_opaque_secret(token),
                    user_id=current.id,
                    tenant_id=current.tenant_id,
                    auth_method=auth_method,
                    sso_config_id=sso_config_id,
                    purpose=purpose,
                    expected_factor_generation=generation,
                    created_at=now,
                    expires_at=now + timedelta(seconds=MFA_CHALLENGE_TTL_SECONDS),
                    max_attempts=MFA_MAX_ATTEMPTS,
                )
            except MfaChallengeInvalidError as exc:
                locked = self.application_state_repository.get_user_mfa_challenge(current.id)
                retry_after = (
                    math.ceil((locked.expires_at - now).total_seconds())
                    if locked is not None
                    else MFA_CHALLENGE_TTL_SECONDS
                )
                raise MfaTemporarilyLockedError(
                    "Too many MFA attempts.",
                    retry_after_seconds=retry_after,
                ) from exc
            return token, replace(
                challenge,
                recovery_codes_remaining=unused if purpose == "verify" else 0,
            )

    def mfa_challenge_status(self, challenge_token: str) -> MfaChallengeState:
        token_hash = hash_opaque_secret(challenge_token)
        with self._store_lock:
            state = self.application_state_repository.get_mfa_challenge(token_hash)
            now = datetime.now(UTC)
            if (
                state is None
                or state.consumed_at is not None
                or state.expires_at <= now
                or state.attempts >= state.max_attempts
            ):
                raise MfaVerificationError("The MFA challenge is invalid or expired.")
            user = self.users.get(state.user_id)
            if user is None or not user.active or user.tenant_id != state.tenant_id:
                raise MfaVerificationError("The MFA challenge is invalid or expired.")
            policy, factor, unused = self.application_state_repository.get_mfa_posture(
                user_id=user.id,
                tenant_id=user.tenant_id,
            )
            if state.purpose == "verify" and (
                factor is None or factor.generation != state.expected_factor_generation
            ):
                raise MfaVerificationError("The MFA challenge is invalid or expired.")
            if state.purpose == "enroll" and (factor is not None or not policy.required):
                raise MfaVerificationError("The MFA challenge is invalid or expired.")
            if state.auth_method == "sso":
                config = self.sso_configs.get(state.sso_config_id or "")
                if (
                    config is None
                    or not config.enabled
                    or config.tenant_id != state.tenant_id
                    or not config.issuer_url.strip()
                    or not config.client_id.strip()
                    or not self.configuration_secret("sso", config.id)
                ):
                    raise MfaVerificationError("The MFA challenge is invalid or expired.")
            return replace(
                state,
                recovery_codes_remaining=unused if state.purpose == "verify" else 0,
            )

    def begin_totp_enrollment(
        self,
        *,
        expected_user: User | None,
        auth_method: str,
        sso_config_id: str | None,
        source_challenge_token: str | None,
        issuer_name: str,
    ) -> dict[str, object]:
        """Create one show-once pending enrollment with a scoped encrypted seed."""

        with self._store_lock:
            source_hash: str | None = None
            if source_challenge_token is not None:
                source_hash = hash_opaque_secret(source_challenge_token)
                source = self.mfa_challenge_status(source_challenge_token)
                if source.purpose != "enroll":
                    raise MfaVerificationError("The MFA challenge cannot enroll a factor.")
                user = self.users.get(source.user_id)
                if user is None:
                    raise MfaVerificationError("The MFA challenge is invalid or expired.")
                auth_method = source.auth_method
                sso_config_id = source.sso_config_id
            else:
                if expected_user is None:
                    raise MfaVerificationError("A signed session or challenge is required.")
                user = self.users.get(expected_user.id)
                if user is not expected_user or not user.active:
                    raise SessionUserStateError("The enrollment user is stale or inactive.")
            policy, factor, _unused = self.application_state_repository.get_mfa_posture(
                user_id=user.id,
                tenant_id=user.tenant_id,
            )
            if source_hash is not None and (factor is not None or not policy.required):
                raise MfaStateConflictError("Forced enrollment is no longer required.")
            watermark = self.application_state_repository.get_session_issued_before_ms(user.id) or 0
            now = datetime.now(UTC)
            factor_generation = max(
                int(now.timestamp() * 1000),
                watermark + 1,
                factor.generation + 1 if factor is not None else 1,
            )
            if factor_generation > MAX_MFA_FACTOR_GENERATION:
                raise MfaStateConflictError("The factor generation cannot be advanced.")
            enrollment_token = new_enrollment_token()
            enrollment_hash = hash_opaque_secret(enrollment_token)
            secret = new_totp_secret()
            ciphertext = self.vault.encrypt_scoped(
                secret,
                aad=pending_seed_aad(
                    tenant_id=user.tenant_id,
                    user_id=user.id,
                    factor_generation=factor_generation,
                    enrollment_token_hash=enrollment_hash,
                ),
            )
            try:
                enrollment = self.application_state_repository.start_totp_enrollment(
                    enrollment_token_hash=enrollment_hash,
                    user_id=user.id,
                    tenant_id=user.tenant_id,
                    factor_generation=factor_generation,
                    auth_method=auth_method,
                    sso_config_id=sso_config_id,
                    source_challenge_hash=source_hash,
                    encrypted_secret_ciphertext=ciphertext,
                    created_at=now,
                    expires_at=now + timedelta(seconds=MFA_ENROLLMENT_TTL_SECONDS),
                    max_attempts=MFA_MAX_ATTEMPTS,
                )
            except MfaChallengeInvalidError as exc:
                locked = self.application_state_repository.get_user_totp_enrollment(user.id)
                if (
                    locked is not None
                    and locked.expires_at > now
                    and locked.attempts >= locked.max_attempts
                ):
                    raise MfaTemporarilyLockedError(
                        "Too many MFA attempts.",
                        retry_after_seconds=math.ceil(
                            (locked.expires_at - now).total_seconds()
                        ),
                    ) from exc
                raise MfaVerificationError(
                    "The TOTP enrollment is invalid or expired."
                ) from exc
            return {
                "enrollment_token": enrollment_token,
                "secret": secret,
                "provisioning_uri": provisioning_uri(
                    secret,
                    account_name=user.email,
                    issuer_name=issuer_name,
                ),
                "expires_at": enrollment.expires_at,
            }

    def confirm_totp_enrollment(
        self,
        *,
        enrollment_token: str,
        code: str,
    ) -> tuple[User, str, str | None, int, list[str]]:
        token_hash = hash_opaque_secret(enrollment_token)
        with self._store_lock:
            pending = self.application_state_repository.get_totp_enrollment(token_hash)
            now = datetime.now(UTC)
            if (
                pending is None
                or pending.consumed_at is not None
                or pending.expires_at <= now
                or pending.attempts >= pending.max_attempts
            ):
                raise MfaVerificationError("The TOTP enrollment is invalid or expired.")
            user = self.users.get(pending.user_id)
            if user is None or not user.active or user.tenant_id != pending.tenant_id:
                raise MfaVerificationError("The TOTP enrollment is invalid or expired.")
            if pending.auth_method == "sso":
                config = self.sso_configs.get(pending.sso_config_id or "")
                if (
                    config is None
                    or not config.enabled
                    or config.tenant_id != pending.tenant_id
                    or not config.issuer_url.strip()
                    or not config.client_id.strip()
                    or not self.configuration_secret("sso", config.id)
                ):
                    raise MfaVerificationError("The TOTP enrollment is invalid or expired.")
            try:
                secret = self.vault.decrypt_scoped(
                    pending.encrypted_secret_ciphertext,
                    aad=pending_seed_aad(
                        tenant_id=pending.tenant_id,
                        user_id=pending.user_id,
                        factor_generation=pending.factor_generation,
                        enrollment_token_hash=pending.enrollment_token_hash,
                    ),
                )
            except ValueError as exc:
                raise RuntimeError("MFA seed integrity validation failed.") from exc
            matched_step = matching_totp_step(secret, code)
            if matched_step is None:
                try:
                    remaining = self.application_state_repository.record_totp_enrollment_failure(
                        token_hash,
                        expected_ciphertext=pending.encrypted_secret_ciphertext,
                        now=now,
                    )
                except MfaChallengeInvalidError as exc:
                    raise MfaVerificationError("The TOTP enrollment is invalid or expired.") from exc
                if remaining == 0:
                    raise MfaTemporarilyLockedError(
                        "Too many MFA attempts.",
                        retry_after_seconds=math.ceil(
                            (pending.expires_at - now).total_seconds()
                        ),
                    )
                raise MfaVerificationError("The TOTP code is invalid.")
            recovery_codes = new_recovery_codes()
            recovery_hashes = [hash_opaque_secret(code.replace("-", "")) for code in recovery_codes]
            factor_ciphertext = self.vault.encrypt_scoped(
                secret,
                aad=factor_seed_aad(
                    tenant_id=pending.tenant_id,
                    user_id=pending.user_id,
                    factor_generation=pending.factor_generation,
                ),
            )
            try:
                self.application_state_repository.promote_totp_enrollment(
                    enrollment_token_hash=token_hash,
                    expected_ciphertext=pending.encrypted_secret_ciphertext,
                    factor_ciphertext=factor_ciphertext,
                    matched_step=matched_step,
                    recovery_code_hashes=recovery_hashes,
                    now=now,
                    issued_before_ms=int(now.timestamp() * 1000),
                    updated_by=user.id,
                )
            except (MfaChallengeInvalidError, MfaReplayError) as exc:
                raise MfaVerificationError("The TOTP enrollment is invalid or expired.") from exc
            return user, pending.auth_method, pending.sso_config_id, pending.factor_generation, recovery_codes

    def verify_primary_mfa_challenge(
        self,
        *,
        challenge_token: str,
        method: str,
        code: str,
    ) -> tuple[User, str, str | None, int]:
        token_hash = hash_opaque_secret(challenge_token)
        with self._store_lock:
            challenge = self.mfa_challenge_status(challenge_token)
            if challenge.purpose != "verify" or method not in {"totp", "recovery_code"}:
                raise MfaVerificationError("The MFA challenge cannot verify this method.")
            user = self.users[challenge.user_id]
            _policy, factor, _unused = self.application_state_repository.get_mfa_posture(
                user_id=user.id,
                tenant_id=user.tenant_id,
            )
            if factor is None or factor.generation != challenge.expected_factor_generation:
                raise MfaVerificationError("The MFA challenge is invalid or expired.")
            now = datetime.now(UTC)
            try:
                if method == "totp":
                    secret = self.vault.decrypt_scoped(
                        factor.encrypted_secret_ciphertext,
                        aad=factor_seed_aad(
                            tenant_id=factor.tenant_id,
                            user_id=factor.user_id,
                            factor_generation=factor.generation,
                        ),
                    )
                    matched_step = matching_totp_step(secret, code)
                    if matched_step is None:
                        raise MfaVerificationError("The MFA code is invalid.")
                    completed = self.application_state_repository.complete_totp_challenge(
                        token_hash=token_hash,
                        expected_factor_ciphertext=factor.encrypted_secret_ciphertext,
                        matched_step=matched_step,
                        now=now,
                    )
                else:
                    recovery_hash = hash_recovery_code(code)
                    if recovery_hash is None:
                        raise MfaVerificationError("The MFA code is invalid.")
                    completed = self.application_state_repository.complete_recovery_challenge(
                        token_hash=token_hash,
                        recovery_code_hash=recovery_hash,
                        now=now,
                    )
            except ValueError as exc:
                if isinstance(exc, MfaVerificationError):
                    verification_error = exc
                else:
                    raise RuntimeError("MFA seed integrity validation failed.") from exc
                try:
                    remaining = self.application_state_repository.record_mfa_challenge_failure(
                        token_hash,
                        now=now,
                    )
                except MfaChallengeInvalidError as state_exc:
                    raise MfaVerificationError("The MFA challenge is invalid or expired.") from state_exc
                if remaining == 0:
                    raise MfaTemporarilyLockedError(
                        "Too many MFA attempts.",
                        retry_after_seconds=math.ceil(
                            (challenge.expires_at - now).total_seconds()
                        ),
                    ) from verification_error
                raise verification_error
            except (MfaChallengeInvalidError, MfaReplayError, MfaStateConflictError) as exc:
                try:
                    remaining = self.application_state_repository.record_mfa_challenge_failure(
                        token_hash,
                        now=now,
                    )
                except MfaChallengeInvalidError:
                    raise MfaVerificationError(
                        "The MFA challenge is invalid or expired."
                    ) from exc
                if remaining == 0:
                    raise MfaTemporarilyLockedError(
                        "Too many MFA attempts.",
                        retry_after_seconds=math.ceil(
                            (challenge.expires_at - now).total_seconds()
                        ),
                    ) from exc
                raise MfaVerificationError("The MFA challenge is invalid or expired.") from exc
            return user, completed.auth_method, completed.sso_config_id, factor.generation

    def apply_mfa_sensitive_action(
        self,
        expected_user: User,
        *,
        action: str,
        method: str,
        code: str,
    ) -> list[str]:
        with self._store_lock:
            current = self.users.get(expected_user.id)
            if current is not expected_user or not current.active:
                raise SessionUserStateError("The MFA user is stale or inactive.")
            policy, factor, _unused = self.application_state_repository.get_mfa_posture(
                user_id=current.id,
                tenant_id=current.tenant_id,
            )
            if factor is None:
                raise MfaStateConflictError("No confirmed MFA factor exists.")
            if action == "disable" and policy.required:
                raise MfaStateConflictError("Tenant policy requires MFA.")
            try:
                secret = self.vault.decrypt_scoped(
                    factor.encrypted_secret_ciphertext,
                    aad=factor_seed_aad(
                        tenant_id=factor.tenant_id,
                        user_id=factor.user_id,
                        factor_generation=factor.generation,
                    ),
                )
            except ValueError as exc:
                raise RuntimeError("MFA seed integrity validation failed.") from exc
            matched_step: int | None = None
            recovery_hash: str | None = None
            if method == "totp":
                matched_step = matching_totp_step(secret, code)
                if matched_step is None:
                    raise MfaVerificationError("The MFA code is invalid.")
            elif method == "recovery_code":
                recovery_hash = hash_recovery_code(code)
                if recovery_hash is None:
                    raise MfaVerificationError("The MFA code is invalid.")
            else:
                raise MfaVerificationError("The MFA method is invalid.")
            replacement_codes = new_recovery_codes() if action == "regenerate-recovery" else []
            replacement_hashes = [
                hash_opaque_secret(value.replace("-", "")) for value in replacement_codes
            ]
            now = datetime.now(UTC)
            try:
                self.application_state_repository.apply_mfa_sensitive_action(
                    action=action,
                    user_id=current.id,
                    tenant_id=current.tenant_id,
                    expected_generation=factor.generation,
                    expected_factor_ciphertext=factor.encrypted_secret_ciphertext,
                    proof_kind=method,
                    matched_step=matched_step,
                    recovery_code_hash=recovery_hash,
                    new_recovery_code_hashes=replacement_hashes,
                    now=now,
                    issued_before_ms=int(now.timestamp() * 1000),
                    updated_by=current.id,
                )
            except (MfaChallengeInvalidError, MfaReplayError) as exc:
                raise MfaVerificationError("The MFA code is invalid.") from exc
            return replacement_codes

    def set_tenant_mfa_policy(
        self,
        *,
        tenant_id: str,
        required: bool,
        expected_generation: int,
        actor: User,
    ) -> MfaPolicyState:
        with self._store_lock:
            tenant = self.tenants.get(tenant_id)
            current_actor = self.users.get(actor.id)
            if tenant is None or current_actor is not actor or not actor.active:
                raise SessionUserStateError("The tenant policy scope is no longer current.")
            if actor.role != Role.PLATFORM_OWNER and not (
                actor.role == Role.TENANT_ADMIN and actor.tenant_id == tenant_id
            ):
                raise PermissionError("The actor cannot manage this tenant MFA policy.")
            user_ids = sorted(
                user.id
                for user in self.users.values()
                if user.active and user.tenant_id == tenant_id
            )
            now = datetime.now(UTC)
            return self.application_state_repository.set_tenant_mfa_policy(
                tenant_id=tenant_id,
                required=required,
                expected_generation=expected_generation,
                user_ids=user_ids,
                now=now,
                issued_before_ms=int(now.timestamp() * 1000),
                updated_by=actor.id,
            )

    def reset_user_mfa_as_admin(
        self,
        *,
        target: User,
        actor: User,
    ) -> bool:
        with self._store_lock:
            current_actor = self.users.get(actor.id)
            current_target = self.users.get(target.id)
            if current_actor is not actor or not actor.active or current_target is not target:
                raise SessionUserStateError("The MFA reset scope is no longer current.")
            if actor.id == target.id:
                raise PermissionError("Use self-service MFA disable for your own account.")
            if actor.role == Role.TENANT_ADMIN:
                if target.tenant_id != actor.tenant_id or target.role not in {
                    Role.USER,
                    Role.TEMP_USER,
                    Role.POWER_USER,
                    Role.AUDITOR,
                    Role.AGENT_APPROVER,
                }:
                    raise PermissionError("The target is outside the tenant administrator scope.")
            elif actor.role != Role.PLATFORM_OWNER:
                raise PermissionError("Only administrators can reset MFA.")
            now = datetime.now(UTC)
            existed, _cutoff = self.application_state_repository.reset_user_mfa(
                user_id=target.id,
                tenant_id=target.tenant_id,
                now=now,
                issued_before_ms=int(now.timestamp() * 1000),
                updated_by=actor.id,
                reason="admin-mfa-reset",
            )
            return existed

    def user_for_session_claims(self, claims: SessionClaims) -> User | None:
        """Resolve one current signed session through a single SQL check."""

        with self._store_lock:
            user = self.users.get(claims.uid)
            if not self.application_state_repository.session_is_current(
                sid=claims.sid,
                user_id=claims.uid,
                issued_at_ms=claims.iat_ms,
                expires_at=claims.exp,
                tenant_id=user.tenant_id if user is not None else None,
                mfa_assured=claims.mfa,
                mfa_factor_generation=claims.mfg,
            ):
                return None
            return user if user is not None and user.active else None

    def issue_session_token_for_user(
        self,
        expected_user: User,
        secret: str,
        ttl_seconds: int,
        *,
        session_id: str | None = None,
        presented_claims: SessionClaims | None = None,
        mfa_assured: bool | None = None,
        mfa_factor_generation: int | None = None,
        auth_method: str = "local",
    ) -> tuple[str, int]:
        """Atomically recheck identity/revocation and sign above its watermark."""

        with self._store_lock:
            current = self.users.get(expected_user.id)
            if current is not expected_user or not current.active:
                raise SessionUserStateError("The session user is stale or inactive.")
            if session_id is not None and presented_claims is None:
                raise ValueError(
                    "A supplied session_id requires the signed predecessor claims."
                )
            if presented_claims is not None and (
                presented_claims.uid != current.id
                or not self.application_state_repository.session_is_current(
                    sid=presented_claims.sid,
                    user_id=presented_claims.uid,
                    issued_at_ms=presented_claims.iat_ms,
                    expires_at=presented_claims.exp,
                    tenant_id=current.tenant_id,
                    mfa_assured=presented_claims.mfa,
                    mfa_factor_generation=presented_claims.mfg,
                )
            ):
                raise SessionUserStateError("The presented session is no longer current.")
            if presented_claims is not None:
                if session_id is None:
                    session_id = presented_claims.sid
                elif session_id != presented_claims.sid:
                    raise SessionUserStateError(
                        "The replacement session id does not match the presented family."
                    )
                if mfa_assured is None:
                    mfa_assured = presented_claims.mfa
                    mfa_factor_generation = presented_claims.mfg
                elif (
                    mfa_assured != presented_claims.mfa
                    or mfa_factor_generation != presented_claims.mfg
                ):
                    raise SessionUserStateError(
                        "Session rotation cannot change MFA assurance."
                    )
            elif mfa_assured is None:
                mfa_assured = False
            assert mfa_assured is not None
            issued_after_ms = self.application_state_repository.get_session_issued_before_ms(
                current.id
            )
            token, expires_at = issue_session_token(
                current.id,
                secret,
                ttl_seconds,
                session_id=session_id,
                issued_after_ms=issued_after_ms,
                mfa_assured=mfa_assured,
                mfa_factor_generation=mfa_factor_generation,
            )
            issued_claims = verify_session_token(token, secret)
            if issued_claims is None:
                raise RuntimeError("Newly issued session token failed strict verification.")
            try:
                self.application_state_repository.register_session_family(
                    sid=issued_claims.sid,
                    user_id=current.id,
                    tenant_id=current.tenant_id,
                    expires_at=issued_claims.exp,
                    issued_at_ms=issued_claims.iat_ms,
                    predecessor_expires_at=(
                        presented_claims.exp if presented_claims is not None else None
                    ),
                    mfa_assured=issued_claims.mfa,
                    mfa_factor_generation=issued_claims.mfg,
                    auth_method=auth_method,
                )
            except SessionFamilyNotCurrentError as exc:
                raise SessionUserStateError(
                    "The session was revoked before issuance completed."
                ) from exc
            return token, expires_at

    def advance_user_session_watermark(
        self,
        user_id: str,
        tenant_id: str | None,
        *,
        reason: str,
        updated_by: str | None,
        issued_before_ms: int | None = None,
        expected_user: User | None = None,
        expected_role: Role | None = None,
        deactivate: bool = False,
        active_after: bool | None = None,
        preserve_last_active_admin: bool = False,
    ) -> int:
        """Strictly advance a cutoff and optionally deactivate the exact user."""

        with self._store_lock:
            current = self.users.get(user_id)
            if expected_user is not None and (
                current is not expected_user
                or expected_user.id != user_id
                or current.tenant_id != tenant_id
                or (expected_role is not None and current.role != expected_role)
            ):
                raise SessionUserStateError("The session user is no longer current.")
            if deactivate and expected_user is None:
                raise ValueError("deactivate=True requires expected_user")
            if active_after is not None and not deactivate:
                raise ValueError("active_after requires deactivate=True")
            if preserve_last_active_admin and not deactivate:
                raise ValueError("preserve_last_active_admin=True requires deactivate=True")
            if preserve_last_active_admin and current is not None and current.active:
                self._assert_active_administrative_peer_locked(current)
            cutoff = issued_before_ms if issued_before_ms is not None else int(time.time() * 1000)
            advanced = self.application_state_repository.advance_session_issued_before_ms_strict(
                user_id,
                tenant_id,
                cutoff,
                reason=reason,
                updated_by=updated_by,
            )
            if deactivate:
                expected_user.active = False if active_after is None else active_after
            return advanced

    def set_user_active_state(
        self,
        expected_user: User,
        *,
        expected_role: Role,
        expected_tenant_id: str | None,
        expected_active: bool,
        active: bool,
    ) -> None:
        """Set active state without revocation only for the exact authorized scope."""

        with self._store_lock:
            current = self.users.get(expected_user.id)
            if (
                current is not expected_user
                or current.role != expected_role
                or current.tenant_id != expected_tenant_id
                or current.active is not expected_active
            ):
                raise SessionUserStateError("The user active state is no longer current.")
            current.active = active

    def assert_user_mutation_scope(
        self,
        expected_user: User,
        *,
        expected_role: Role,
        expected_tenant_id: str | None,
        expected_group_ids: tuple[str, ...],
        expected_active: bool,
    ) -> None:
        """Fail when an authorized user object changed in place before mutation."""

        with self._store_lock:
            current = self.users.get(expected_user.id)
            if (
                current is not expected_user
                or current.role != expected_role
                or current.tenant_id != expected_tenant_id
                or tuple(current.group_ids) != expected_group_ids
                or current.active is not expected_active
            ):
                raise SessionUserStateError("The authorized user scope is no longer current.")

    def apply_scim_user_mutation(
        self,
        expected_user: User,
        *,
        actor: User,
        expected_role: Role,
        expected_tenant_id: str | None,
        expected_group_ids: tuple[str, ...],
        expected_active: bool,
        updates: dict[str, Any],
        revoke_sessions: bool,
        reason: str,
        updated_by: str | None,
    ) -> int | None:
        """Apply one exact-scope SCIM mutation, revoking before any deactivation edits."""

        allowed_fields = {"email", "display_name", "active", "entra_object_id", "group_ids"}
        if not updates.keys() <= allowed_fields:
            raise ValueError("Unsupported SCIM user mutation field.")
        with self._store_lock:
            current = self.users.get(expected_user.id)
            if (
                current is not expected_user
                or current.role != expected_role
                or current.tenant_id != expected_tenant_id
                or tuple(current.group_ids) != expected_group_ids
                or current.active is not expected_active
            ):
                raise SessionUserStateError("The SCIM user scope is no longer current.")
            if (
                actor.auth_method != "scim"
                or actor.role != Role.TENANT_ADMIN
                or actor.tenant_id != expected_tenant_id
                or actor.id != f"scim-provisioner-{expected_tenant_id}"
                or expected_tenant_id not in self.tenants
                or expected_role == Role.PLATFORM_OWNER
            ):
                raise SessionUserStateError("The SCIM actor scope is no longer current.")
            requested_email = updates.get("email")
            requested_entra_id = updates.get("entra_object_id")
            normalized_email = (
                str(requested_email).strip().lower() if requested_email is not None else None
            )
            normalized_entra_id = (
                str(requested_entra_id).strip().lower()
                if requested_entra_id is not None
                else None
            )
            for other in self.users.values():
                if other is current:
                    continue
                if normalized_email and other.email.strip().lower() == normalized_email:
                    raise UserIdentityConflictError("User email already exists.")
                if (
                    normalized_entra_id
                    and (other.entra_object_id or "").strip().lower() == normalized_entra_id
                ):
                    raise UserIdentityConflictError("User Entra object ID already exists.")
            requested_group_ids = updates.get("group_ids")
            if requested_group_ids is not None and any(
                group_id not in self.groups
                or self.groups[group_id].tenant_id != expected_tenant_id
                for group_id in requested_group_ids
            ):
                raise SessionUserStateError("The SCIM group scope is no longer current.")
            cutoff: int | None = None
            if revoke_sessions:
                final_active = bool(updates.get("active", current.active))
                cutoff = self.advance_user_session_watermark(
                    current.id,
                    expected_tenant_id,
                    reason=reason,
                    updated_by=updated_by,
                    expected_user=current,
                    expected_role=expected_role,
                    deactivate=True,
                    active_after=final_active,
                    preserve_last_active_admin=not final_active,
                )
            for field, value in updates.items():
                setattr(current, field, list(value) if field == "group_ids" else value)
            return cutoff

    def transition_user_access_scope(
        self,
        expected_user: User,
        *,
        expected_role: Role,
        expected_tenant_id: str | None,
        expected_group_ids: tuple[str, ...],
        expected_active: bool,
        role: Role,
        tenant_id: str | None,
        group_ids: list[str],
        active: bool,
        reason: str,
        updated_by: str | None,
        issued_before_ms: int | None = None,
    ) -> int:
        """Atomically revoke old sessions before changing an exact user's access scope."""

        with self._store_lock:
            current = self.users.get(expected_user.id)
            if (
                current is not expected_user
                or current.role != expected_role
                or current.tenant_id != expected_tenant_id
                or tuple(current.group_ids) != expected_group_ids
                or current.active is not expected_active
            ):
                raise SessionUserStateError("The user access scope is no longer current.")
            if current.role == role and current.tenant_id == tenant_id:
                raise ValueError("The requested user access scope is unchanged.")
            leaves_current_administrative_scope = current.active and (
                not active
                or current.role != role
                or (
                    current.role == Role.TENANT_ADMIN
                    and current.tenant_id != tenant_id
                )
            )
            if leaves_current_administrative_scope:
                self._assert_active_administrative_peer_locked(current)
            cutoff = issued_before_ms if issued_before_ms is not None else int(time.time() * 1000)
            advanced = self.application_state_repository.advance_session_issued_before_ms_strict(
                current.id,
                current.tenant_id,
                cutoff,
                reason=reason,
                updated_by=updated_by,
                reset_mfa=current.tenant_id != tenant_id,
            )
            if tenant_id is not None and current.tenant_id != tenant_id:
                # Personalization memories follow their owner across tenants:
                # reporting, compliance purge, and the SQLite→Postgres
                # importer all require memory.tenant_id to match the owner's
                # tenant, and rows stranded on the old tenant would be
                # invisible to both tenants' admins. Promotion to platform
                # owner (tenant_id None) leaves rows on their tenant, since
                # memory rows are tenant-bound by schema.
                for memory in self.user_memories.values():
                    if memory.owner_user_id == current.id:
                        memory.tenant_id = tenant_id
            current.role = role
            current.tenant_id = tenant_id
            current.group_ids = list(group_ids)
            current.active = active
            return advanced

    def _assert_active_administrative_peer_locked(self, current: User) -> None:
        if current.role == Role.PLATFORM_OWNER and not any(
            user is not current and user.active and user.role == Role.PLATFORM_OWNER
            for user in self.users.values()
        ):
            raise LastActiveAdministrativeAccountError(Role.PLATFORM_OWNER)
        # Owners administer every tenant, so an active owner satisfies the
        # tenant's administrative coverage: the last tenant admin may go as
        # long as any owner (or another admin in the tenant) remains active.
        if current.role == Role.TENANT_ADMIN and not any(
            user is not current
            and user.active
            and (
                user.role == Role.PLATFORM_OWNER
                or (user.role == Role.TENANT_ADMIN and user.tenant_id == current.tenant_id)
            )
            for user in self.users.values()
        ):
            raise LastActiveAdministrativeAccountError(Role.TENANT_ADMIN)

    def revoke_session_claims(
        self,
        claims: SessionClaims,
        *,
        tenant_id: str | None,
        reason: str = "logout",
    ) -> None:
        """Durably revoke one signed session family."""

        with self._store_lock:
            self.application_state_repository.revoke_session_family(
                sid=claims.sid,
                user_id=claims.uid,
                tenant_id=tenant_id,
                issued_at=claims.iat,
                expires_at=claims.exp,
                reason=reason,
            )

    def create_user_api_key(self, user: User) -> tuple[UserApiKeyRecord, str]:
        """Create or rotate a user's personal API key.

        Only a SHA-256 digest is persisted. The high-entropy bearer secret is
        returned once to the caller and cannot be recovered later.
        """
        secret_value = f"apt_{secrets.token_urlsafe(32)}"
        created_at = datetime.now(UTC).isoformat()
        record = UserApiKeyRecord(
            id=user.id,
            user_id=user.id,
            tenant_id=user.tenant_id,
            key_hash=hashlib.sha256(secret_value.encode("utf-8")).hexdigest(),
            key_prefix=secret_value[:12],
            masked_value=f"{secret_value[:12]}••••••••{secret_value[-4:]}",
            created_at=created_at,
        )
        with self._store_lock:
            saved = self.application_state_repository.upsert_user_api_key(record)
            return saved, secret_value

    def revoke_user_api_key(self, user_id: str) -> UserApiKeyRecord | None:
        with self._store_lock:
            return self.application_state_repository.delete_user_api_key(user_id)

    def user_for_api_key(
        self,
        secret_value: str,
        *,
        touch_last_used: bool = True,
    ) -> User | None:
        candidate_hash = hashlib.sha256(secret_value.encode("utf-8")).hexdigest()
        with self._store_lock:
            matched = self.application_state_repository.lookup_api_key_hash(
                candidate_hash,
                touch_last_used=False,
            )
            if matched is None:
                return None
            user = self.users.get(matched.user_id)
            if user is None or not user.active or user.tenant_id != matched.tenant_id:
                return None
            if touch_last_used and not self.application_state_repository.touch_user_api_key_if_current(
                matched.id,
                matched.key_hash,
                datetime.now(UTC),
            ):
                return None
            return user

    def save_runtime_state(self, urgent: bool = False) -> None:
        """Mark runtime state dirty and persist it within the durability window.

        Normal mutations are coalesced by a daemon flusher and may remain only
        in memory for roughly two seconds. Security-critical callers pass
        ``urgent=True`` to synchronously persist before returning.
        """
        if self._runtime_state_path is None and self._identity_config_metadata is None:
            return
        with self._runtime_state_flush_condition:
            if self._runtime_state_closed:
                raise RuntimeError("Cannot save a closed SeedStore.")
            was_dirty = self._runtime_state_dirty
            self._runtime_state_dirty = True
            if self._identity_config_metadata is not None:
                # SQL is the sole live authority after cutover. Every mutation
                # must complete its relational-digest CAS before its request
                # can report success; background/debounced persistence would
                # acknowledge state that another process can immediately lose.
                self._runtime_state_flush_deadline = None
                try:
                    self._flush_dirty_locked()
                except Exception:
                    self._runtime_state_flush_deadline = None
                    raise
                return
            if urgent:
                self._runtime_state_flush_deadline = None
                try:
                    self._flush_dirty_locked()
                except Exception:
                    self._schedule_runtime_state_retry_locked()
                    raise
                return
            # The first dirty mutation starts a bounded durability window.
            # Later mutations coalesce into that pending snapshot without
            # extending the deadline indefinitely under sustained traffic.
            if not was_dirty or self._runtime_state_flush_deadline is None:
                self._runtime_state_flush_deadline = (
                    time.monotonic() + RUNTIME_STATE_FLUSH_DEBOUNCE_SECONDS
                )
            self._ensure_runtime_state_flush_thread_locked()
            self._runtime_state_flush_condition.notify_all()

    def flush_now(self) -> None:
        """Synchronously persist pending runtime state, primarily for tests and shutdown."""
        if self._runtime_state_path is None and self._identity_config_metadata is None:
            return
        with self._runtime_state_flush_condition:
            try:
                self._flush_dirty_locked()
            except Exception:
                self._schedule_runtime_state_retry_locked()
                raise

    def close(self) -> None:
        """Flush pending state and stop the background flusher.

        A failed final write leaves the store open and dirty so a caller can
        correct the underlying problem and retry instead of silently losing the
        pending snapshot.
        """
        thread: threading.Thread | None = None
        callback: Any | None = None
        with self._runtime_state_flush_condition:
            if self._runtime_state_closed:
                return
            try:
                self._flush_dirty_locked()
            except Exception:
                self._schedule_runtime_state_retry_locked()
                raise
            self._runtime_state_closed = True
            self._runtime_state_flush_deadline = None
            thread = self._runtime_state_flush_thread
            self._runtime_state_flush_thread = None
            callback = self._runtime_state_atexit_callback
            self._runtime_state_atexit_callback = None
            self._runtime_state_flush_condition.notify_all()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5.0)
        if callback is not None:
            atexit.unregister(callback)
        if self._owns_application_state_repository:
            self.application_state_repository.close()

    def _ensure_runtime_state_flush_thread_locked(self) -> None:
        thread = self._runtime_state_flush_thread
        if thread is not None and thread.is_alive():
            return
        thread = threading.Thread(
            target=self._runtime_state_flush_loop,
            name="aperture-runtime-state-flusher",
            daemon=True,
        )
        self._runtime_state_flush_thread = thread
        thread.start()

    def _schedule_runtime_state_retry_locked(self) -> None:
        self._runtime_state_flush_deadline = (
            time.monotonic() + RUNTIME_STATE_FLUSH_DEBOUNCE_SECONDS
        )
        self._ensure_runtime_state_flush_thread_locked()
        self._runtime_state_flush_condition.notify_all()

    def _runtime_state_flush_loop(self) -> None:
        while True:
            with self._runtime_state_flush_condition:
                while (
                    not self._runtime_state_closed
                    and (
                        not self._runtime_state_dirty
                        or self._runtime_state_flush_deadline is None
                    )
                ):
                    self._runtime_state_flush_condition.wait()
                if self._runtime_state_closed:
                    return
                deadline = self._runtime_state_flush_deadline
                if deadline is None:
                    continue
                remaining = deadline - time.monotonic()
                if remaining > 0:
                    self._runtime_state_flush_condition.wait(timeout=remaining)
                    continue
                try:
                    self._flush_dirty_locked()
                except Exception:  # noqa: BLE001 - retry on the next debounce window
                    logger.exception("Background runtime-state flush failed; retrying")
                    self._runtime_state_flush_deadline = (
                        time.monotonic() + RUNTIME_STATE_FLUSH_DEBOUNCE_SECONDS
                    )

    def _flush_dirty_locked(self) -> None:
        if not self._runtime_state_dirty:
            return
        # Clear the dirty bit only after the transactional SQL replacement
        # succeeds. Any validation or database failure remains retryable.
        self._write_runtime_state()
        self._runtime_state_dirty = False
        self._runtime_state_flush_deadline = None

    def _identity_config_v4_payload(self) -> dict[str, Any]:
        if self._application_state_metadata is None:
            raise RuntimeError("Application-state import metadata is unavailable.")
        if self._chat_state_metadata is None:
            raise RuntimeError("Chat-state import metadata is unavailable.")
        return {
            "version": CHAT_RELATIONAL_STATE_VERSION,
            APPLICATION_STATE_METADATA_KEY: self._application_state_metadata.to_dict(),
            CHAT_STATE_METADATA_KEY: self._chat_state_metadata.to_dict(),
            "tenants": self._dump_model_collection(self.tenants),
            "users": self._dump_model_collection(self.users),
            "groups": self._dump_model_collection(self.groups),
            "providers": self._dump_model_collection(self.providers),
            "models": self._dump_model_collection(self.models),
            "provider_keys": self._dump_model_collection(self.provider_keys),
            "connectors": self._dump_model_collection(self.connectors),
            "connector_configs": self._dump_model_collection(self.connector_configs),
            "sso_configs": self._dump_model_collection(self.sso_configs),
            "knowledge_configs": self._dump_model_collection(self.knowledge_configs),
            "knowledge_documents": self._dump_grouped_model_collection(self.knowledge_documents),
            "knowledge_chunks": self._dump_grouped_model_collection(self.knowledge_chunks),
            "tool_configs": self._dump_model_collection(self.tool_configs),
            "prompt_templates": self._dump_model_collection(self.prompt_templates),
            "skill_files": self._dump_model_collection(self.skill_files),
            "security_alerts": self._dump_model_collection(self.security_alerts),
            "agent_runs": self._dump_model_collection(self.agent_runs),
            "automations": self._dump_model_collection(self.automations),
            "companion_memories": self._dump_model_collection(self.companion_memories),
            "content_filters": self._dump_model_collection(self.content_filters),
            "user_memories": self._dump_model_collection(self.user_memories),
            "tenant_memory_policies": self._dump_model_collection(self.tenant_memory_policies),
            "tenant_retention_policies": self._dump_model_collection(self.tenant_retention_policies),
            "user_memory_settings": self._dump_model_collection(self.user_memory_settings),
            "platform_settings": self.platform_settings.model_dump(mode="json"),
            "password_credentials": self.password_credentials,
            "temporary_password_user_ids": sorted(self.temporary_password_user_ids),
            "scim_tokens": self._dump_model_collection(self.scim_tokens),
            "alert_rules": [
                rule.model_dump(mode="json", exclude={"last_triggered_at"})
                for rule in self.alert_rules.values()
            ],
            "email_settings": self.email_settings.model_dump(mode="json"),
            "encrypted_provider_keys": self._encrypted_keys,
            "configuration_secrets": self._configuration_secrets,
        }

    def _initialize_identity_config_authority(self) -> None:
        """Complete or verify the two-store v4-to-v5 authority handoff."""

        authority = self.identity_config_repository.load_authority_state()
        active_snapshot = authority.snapshot if authority.status == "active" else None
        staged_snapshot = authority.snapshot if authority.status == "staged" else None
        active_receipt = active_snapshot.receipt if active_snapshot is not None else None
        staged_receipt = staged_snapshot.receipt if staged_snapshot is not None else None
        vector_receipt = self.vector_store.active_import_receipt()
        source_payload: dict[str, Any] | None = None
        recovery_journal: CutoverVectorSourceJournal | None = None

        if active_receipt is None:
            if staged_receipt is not None and vector_receipt is not None:
                self._assert_active_vector_authority(staged_receipt, vector_receipt)
                active_receipt = self.identity_config_repository.activate_identity_config(
                    source_digest=staged_receipt.source_digest,
                    vector_receipt=vector_receipt,
                )
            else:
                prepared = self._prepared_runtime_state_payload
                if isinstance(prepared, dict) and A7_RUNTIME_FIELDS.issubset(prepared):
                    source_payload = deepcopy(prepared)
                elif staged_receipt is None:
                    source_payload = self._identity_config_v4_payload()
                else:
                    recovery_journal = (
                        self.identity_cleanup_repository.get_vector_source_journal(
                            staged_receipt.source_digest
                        )
                    )
                    if recovery_journal is None:
                        raise IdentityConfigCorruptionError(
                            "Staged SQL identity/config authority has no recoverable vector "
                            "receipt, vector journal, or version 4 source."
                        )
                    self._assert_vector_source_journal(staged_receipt, recovery_journal)
                    vector_result = self.vector_store.import_legacy_knowledge_state(
                        source_digest=staged_receipt.source_digest,
                        expected_semantic_digest=staged_receipt.knowledge_digest,
                        documents=recovery_journal.documents,
                        chunks=recovery_journal.chunks,
                    )
                    vector_receipt = vector_result.receipt
                    active_receipt = self.identity_config_repository.activate_identity_config(
                        source_digest=staged_receipt.source_digest,
                        vector_receipt=vector_receipt,
                    )
                if source_payload is None:
                    assert active_receipt is not None
                    assert vector_receipt is not None
                else:
                    source_payload, removed_memory_ids = canonicalize_deleted_profile_dependents(
                        source_payload
                    )
                    if removed_memory_ids:
                        logger.warning(
                            "Removed %d unreachable companion memories left by deleted profiles "
                            "during the version 4 to version 5 cutover.",
                            len(removed_memory_ids),
                        )
                    raw_state = validate_v4_identity_config_state(source_payload)
                    if staged_snapshot is not None:
                        state = self._resume_cutover_state(
                            raw_state,
                            staged_snapshot,
                        )
                        if state.source_digest != raw_state.source_digest:
                            source_payload = None
                        receipt = staged_snapshot.receipt
                    else:
                        state = scope_provider_credentials_for_import(self.vault, raw_state)
                        receipt = state.create_receipt(
                            schema_revision=IDENTITY_CONFIG_IMPORT_REVISION,
                        )
                        try:
                            self.identity_config_repository.import_validated_identity_config(
                                state=state,
                                receipt=receipt,
                            )
                        except IdentityConfigImportConflict:
                            # Another startup may have scoped the same v4 source
                            # with a different random nonce. Reuse and authenticate
                            # the winning staged ciphertext instead of retrying its
                            # relational digest with fresh encryption.
                            winner = self.identity_config_repository.load_authority_state()
                            if winner.status == "active":
                                active_snapshot = winner.snapshot
                                assert active_snapshot is not None
                                state = self._resume_cutover_state(
                                    raw_state,
                                    active_snapshot,
                                )
                                if state.source_digest != raw_state.source_digest:
                                    source_payload = None
                                active_receipt = active_snapshot.receipt
                            elif winner.status == "staged":
                                staged_snapshot = winner.snapshot
                                assert staged_snapshot is not None
                                state = self._resume_cutover_state(
                                    raw_state,
                                    staged_snapshot,
                                )
                                if state.source_digest != raw_state.source_digest:
                                    source_payload = None
                                receipt = staged_snapshot.receipt
                            else:
                                raise
                    if active_receipt is not None:
                        refreshed_vector = self.vector_store.active_import_receipt()
                        if refreshed_vector is None:
                            raise IdentityConfigCorruptionError(
                                "Active SQL identity/config authority has no vector receipt."
                            )
                        vector_receipt = refreshed_vector
                    else:
                        # An idempotent retry is safe when the competing startup
                        # already completed the exact staged state.
                        self.identity_config_repository.import_validated_identity_config(
                            state=state,
                            receipt=receipt,
                        )
                    vector_result = self.vector_store.import_legacy_knowledge_state(
                        source_digest=state.source_digest,
                        expected_semantic_digest=state.knowledge_digest,
                        documents=state.knowledge_documents,
                        chunks=state.knowledge_chunks,
                    )
                    if active_receipt is None:
                        vector_receipt = vector_result.receipt
                        active_receipt = self.identity_config_repository.activate_identity_config(
                            source_digest=receipt.source_digest,
                            vector_receipt=vector_receipt,
                        )
        elif vector_receipt is None:
            raise IdentityConfigCorruptionError(
                "SQL identity/config authority has no vector authority receipt."
            )

        assert active_receipt is not None
        assert vector_receipt is not None
        self._assert_active_vector_authority(active_receipt, vector_receipt)
        if recovery_journal is None:
            recovery_journal = self.identity_cleanup_repository.get_vector_source_journal(
                active_receipt.source_digest
            )
        if recovery_journal is not None:
            self._assert_vector_source_journal(active_receipt, recovery_journal)
            self.identity_cleanup_repository.delete_vector_source_journal(
                active_receipt.source_digest,
                expected_knowledge_digest=active_receipt.knowledge_digest,
                expected_journal_digest=recovery_journal.journal_digest,
            )
        self._retire_vectors_for_committed_cleanup_jobs()
        snapshot = self.identity_config_repository.load_active_snapshot()
        if snapshot is None or snapshot.receipt.source_digest != active_receipt.source_digest:
            raise IdentityConfigCorruptionError(
                "SQL identity/config authority has no matching active snapshot."
            )
        self._load_identity_config_snapshot(snapshot)
        self._identity_config_metadata = active_receipt
        self._identity_config_staged_metadata = None
        self._identity_config_staged_snapshot = None
        self._identity_config_live_digest = snapshot.relational_digest
        self._verify_or_retire_runtime_state(
            identity_receipt=active_receipt,
            vector_metadata=vector_receipt.to_dict(),
            source_payload=source_payload,
        )

    @staticmethod
    def _assert_active_vector_authority(
        identity_receipt: IdentityConfigImportReceipt,
        vector_receipt: KnowledgeStateImportReceipt,
    ) -> None:
        if (
            vector_receipt.source_digest != identity_receipt.source_digest
            or vector_receipt.source_version != 4
            or vector_receipt.target_version != 5
            or vector_receipt.semantic_digest != identity_receipt.knowledge_digest
            or vector_receipt.document_count
            != identity_receipt.collection_counts["knowledge_documents"]
            or vector_receipt.chunk_count
            != identity_receipt.collection_counts["knowledge_chunks"]
        ):
            raise IdentityConfigCorruptionError(
                "SQL and vector authority receipts do not match."
            )

    @staticmethod
    def _assert_vector_source_journal(
        identity_receipt: IdentityConfigImportReceipt,
        journal: CutoverVectorSourceJournal,
    ) -> None:
        if (
            journal.source_digest != identity_receipt.source_digest
            or journal.knowledge_digest != identity_receipt.knowledge_digest
            or journal.document_count
            != identity_receipt.collection_counts["knowledge_documents"]
            or journal.chunk_count
            != identity_receipt.collection_counts["knowledge_chunks"]
        ):
            raise IdentityConfigCorruptionError(
                "The staged vector recovery journal does not match SQL authority."
            )

    def _resume_cutover_state(
        self,
        raw_state: ValidatedIdentityConfigState,
        snapshot: IdentityConfigSqlSnapshot,
    ) -> ValidatedIdentityConfigState:
        if (
            self._identity_config_empty_bootstrap
            and raw_state.source_digest != snapshot.receipt.source_digest
        ):
            return resume_equivalent_empty_bootstrap_from_stage(
                self.vault,
                raw_state,
                staged_receipt=snapshot.receipt,
                staged_encrypted_provider_keys=snapshot.encrypted_provider_keys,
                staged_configuration_secrets=snapshot.configuration_secrets,
            )
        return resume_scoped_provider_credentials_from_stage(
            self.vault,
            raw_state,
            staged_receipt=snapshot.receipt,
            staged_encrypted_provider_keys=snapshot.encrypted_provider_keys,
        )

    def _retire_vectors_for_committed_cleanup_jobs(self) -> None:
        """Make an identity-first crash loadable before full startup resume."""

        for job in self.identity_cleanup_repository.list_incomplete_cleanup_jobs():
            if job.identity_committed_at is None:
                continue
            if job.resource_kind == "tenant":
                self.vector_store.delete_tenant(job.tenant_id)
            elif job.resource_kind == "knowledge_config":
                self.vector_store.delete_config(job.resource_id)

    def _verify_or_retire_runtime_state(
        self,
        *,
        identity_receipt: IdentityConfigImportReceipt,
        vector_metadata: dict[str, Any],
        source_payload: dict[str, Any] | None,
    ) -> None:
        path = self._runtime_state_path
        if path is None:
            return
        payload = source_payload
        if payload is None and path.exists():
            payload = read_runtime_state_payload(path)
        if payload is None:
            # Version 5 retires the file entirely; a matching pair of active
            # SQL/vector receipts is sufficient when no tombstone remains.
            return
        version = payload.get("version")
        if version == 5:
            validate_v5_tombstone(
                payload,
                identity_receipt=identity_receipt,
                knowledge_state_metadata=vector_metadata,
            )
            self._prepared_runtime_state_payload = payload
            return
        if version != CHAT_RELATIONAL_STATE_VERSION:
            raise IdentityConfigImportError(
                "Active SQL authority conflicts with a pre-v4 runtime file."
            )
        state = validate_v4_identity_config_state(payload)
        if state.source_digest != identity_receipt.source_digest:
            raise IdentityConfigImportError(
                "Active SQL authority conflicts with the version 4 runtime file."
            )
        tombstone = build_v5_tombstone(
            identity_receipt,
            application_state_metadata=payload[APPLICATION_STATE_METADATA_KEY],
            chat_state_metadata=payload[CHAT_STATE_METADATA_KEY],
            knowledge_state_metadata=vector_metadata,
        )
        write_runtime_state_atomic(path, tombstone)
        self._prepared_runtime_state_payload = tombstone

    def _load_identity_config_snapshot(self, snapshot: IdentityConfigSqlSnapshot) -> None:
        """Replace the in-process cache from detached active SQL/vector rows."""

        collections = snapshot.collections

        def records(name: str) -> dict[str, Any]:
            return {
                str(record.id): record.model_copy(deep=True)
                for record in collections[name]
            }

        self.tenants = records("tenants")
        self.users = records("users")
        self.groups = records("groups")
        self.providers = records("providers")
        self.models = records("models")
        self.provider_keys = records("provider_keys")
        connector_catalog = dict(self.connectors)
        connector_catalog.update(records("connectors"))
        self.connectors = connector_catalog
        self.connector_configs = records("connector_configs")
        self.sso_configs = records("sso_configs")
        self.knowledge_configs = records("knowledge_configs")
        self.tool_configs = records("tool_configs")
        self.prompt_templates = records("prompt_templates")
        self.skill_files = records("skill_files")
        self.security_alerts = records("security_alerts")
        self.agent_runs = records("agent_runs")
        self.automations = records("automations")
        self.companion_memories = records("companion_memories")
        self.content_filters = records("content_filters")
        self.user_memories = records("user_memories")
        # Policies and settings are keyed by their natural key, not the mirror id.
        self.tenant_memory_policies = {
            record.tenant_id: record.model_copy(deep=True)
            for record in collections["tenant_memory_policies"]
        }
        self.tenant_retention_policies = {
            record.tenant_id: record.model_copy(deep=True)
            for record in collections["tenant_retention_policies"]
        }
        self.user_memory_settings = {
            record.user_id: record.model_copy(deep=True)
            for record in collections["user_memory_settings"]
        }
        self.scim_tokens = records("scim_tokens")
        self.alert_rules = records("alert_rules")
        self.platform_settings = snapshot.platform_settings.model_copy(deep=True)
        self.email_settings = snapshot.email_settings.model_copy(deep=True)
        self.password_credentials = dict(snapshot.password_credentials)
        self.temporary_password_user_ids = set(snapshot.temporary_password_user_ids)
        self._encrypted_keys = dict(snapshot.encrypted_provider_keys)
        self._configuration_secrets = dict(snapshot.configuration_secrets)

        sql_config_ids = set(self.knowledge_configs)
        vector_config_ids = self.vector_store.knowledge_config_ids()
        orphaned = sorted(vector_config_ids.difference(sql_config_ids))
        if orphaned:
            raise IdentityConfigCorruptionError(
                "Vector authority contains an unknown knowledge configuration."
            )
        self.knowledge_documents = {
            config_id: self.vector_store.documents_for(config_id)
            for config_id in sql_config_ids
        }
        self.knowledge_chunks = {
            config_id: self.vector_store.chunks_for(config_id)
            for config_id in sql_config_ids
        }
        for rule in self.alert_rules.values():
            runtime = self.application_state_repository.get_alert_rule_runtime(rule.id)
            rule.last_triggered_at = (
                runtime.last_triggered_at if runtime is not None else None
            )

    def _write_runtime_state(self) -> None:
        if self._identity_config_metadata is None:
            assert self._runtime_state_path is not None
            write_runtime_state_atomic(
                self._runtime_state_path,
                self._identity_config_v4_payload(),
            )
            return

        expected_digest = self._identity_config_live_digest
        if expected_digest is None:
            raise IdentityConfigCorruptionError(
                "Active identity/config cache has no relational generation token."
            )
        state = scope_provider_credentials_for_import(
            self.vault,
            validate_v4_identity_config_state(self._identity_config_v4_payload()),
        )
        try:
            replaced = self.identity_config_repository.replace_active_snapshot(
                state=state,
                expected_relational_digest=expected_digest,
            )
        except IdentityConfigSnapshotConflict:
            # Discard the losing mutation before surfacing the conflict. The
            # caller can explicitly retry against the freshly loaded cache;
            # it must never overwrite the winning generation automatically.
            current = self.identity_config_repository.load_active_snapshot()
            if current is None:
                raise IdentityConfigCorruptionError(
                    "Identity/config authority disappeared after a CAS conflict."
                )
            self._load_identity_config_snapshot(current)
            self._identity_config_live_digest = current.relational_digest
            raise
        self._identity_config_live_digest = replaced.relational_digest

    def _load_runtime_state(self) -> None:
        if self._runtime_state_path is None:
            return
        payload = self._prepared_runtime_state_payload
        if not isinstance(payload, dict):
            raise RuntimeError("Verified runtime-state payload is unavailable.")

        loaded_tenants = self._load_model_collection(payload, "tenants", Tenant)
        if loaded_tenants is not None:
            self.tenants = loaded_tenants

        loaded_users = self._load_model_collection(payload, "users", User)
        if loaded_users is not None:
            self.users = loaded_users

        loaded_groups = self._load_model_collection(payload, "groups", Group)
        if loaded_groups is not None:
            self.groups = loaded_groups

        loaded_providers = self._load_model_collection(payload, "providers", Provider)
        if loaded_providers is not None:
            self.providers = loaded_providers

        loaded_models = self._load_model_collection(payload, "models", ModelConfig)
        if loaded_models is not None:
            self.models = loaded_models

        loaded_provider_keys = self._load_model_collection(payload, "provider_keys", ProviderKey)
        if loaded_provider_keys is not None:
            self.provider_keys = loaded_provider_keys

        loaded_connectors = self._load_model_collection(payload, "connectors", Connector)
        if loaded_connectors is not None:
            # Persisted state carries owner toggles, but the built-in catalog must
            # survive states saved before a connector existed (or saved empty).
            catalog = dict(self.connectors)
            catalog.update(loaded_connectors)
            self.connectors = catalog

        loaded_connector_configs = self._load_model_collection(payload, "connector_configs", ConnectorConfig)
        if loaded_connector_configs is not None:
            self.connector_configs = loaded_connector_configs

        loaded_sso_configs = self._load_model_collection(payload, "sso_configs", SsoConfig)
        if loaded_sso_configs is not None:
            self.sso_configs = loaded_sso_configs

        loaded_knowledge_configs = self._load_model_collection(payload, "knowledge_configs", KnowledgeConfig)
        if loaded_knowledge_configs is not None:
            self.knowledge_configs = loaded_knowledge_configs

        loaded_knowledge_documents = self._load_grouped_model_collection(
            payload,
            "knowledge_documents",
            KnowledgeDocument,
            "knowledge_config_id",
        )
        if loaded_knowledge_documents is not None:
            self.knowledge_documents = loaded_knowledge_documents

        loaded_knowledge_chunks = self._load_grouped_model_collection(
            payload,
            "knowledge_chunks",
            KnowledgeChunk,
            "knowledge_config_id",
        )
        if loaded_knowledge_chunks is not None:
            self.knowledge_chunks = loaded_knowledge_chunks

        loaded_tool_configs = self._load_model_collection(payload, "tool_configs", ToolConfig)
        if loaded_tool_configs is not None:
            self.tool_configs = loaded_tool_configs

        loaded_prompt_templates = self._load_model_collection(payload, "prompt_templates", PromptTemplate)
        if loaded_prompt_templates is not None:
            self.prompt_templates = loaded_prompt_templates

        loaded_skill_files = self._load_model_collection(payload, "skill_files", SkillFile)
        if loaded_skill_files is not None:
            self.skill_files = loaded_skill_files

        loaded_security_alerts = self._load_model_collection(payload, "security_alerts", SecurityAlert)
        if loaded_security_alerts is not None:
            self.security_alerts = loaded_security_alerts

        loaded_agent_runs = self._load_model_collection(payload, "agent_runs", AgentRun)
        if loaded_agent_runs is not None:
            self.agent_runs = loaded_agent_runs

        loaded_automations = self._load_model_collection(payload, "automations", Automation)
        if loaded_automations is not None:
            self.automations = loaded_automations

        loaded_companion_memories = self._load_model_collection(
            payload, "companion_memories", CompanionMemory
        )
        if loaded_companion_memories is not None:
            self.companion_memories = loaded_companion_memories

        loaded_content_filters = self._load_model_collection(payload, "content_filters", ContentFilter)
        if loaded_content_filters is not None:
            self.content_filters = loaded_content_filters

        loaded_memories = self._load_model_collection(payload, "user_memories", UserMemory)
        if loaded_memories is not None:
            self.user_memories = loaded_memories

        loaded_memory_policies = self._load_keyed_model_collection(
            payload, "tenant_memory_policies", TenantMemoryPolicy, "tenant_id"
        )
        if loaded_memory_policies is not None:
            self.tenant_memory_policies = loaded_memory_policies

        loaded_retention_policies = self._load_keyed_model_collection(
            payload, "tenant_retention_policies", TenantRetentionPolicy, "tenant_id"
        )
        if loaded_retention_policies is not None:
            self.tenant_retention_policies = loaded_retention_policies

        loaded_memory_settings = self._load_keyed_model_collection(
            payload, "user_memory_settings", UserMemorySettings, "user_id"
        )
        if loaded_memory_settings is not None:
            self.user_memory_settings = loaded_memory_settings

        raw_platform_settings = payload.get("platform_settings")
        if isinstance(raw_platform_settings, dict):
            try:
                self.platform_settings = PlatformSettings.model_validate(raw_platform_settings)
            except (TypeError, ValueError):
                pass

        loaded_alert_rules = self._load_model_collection(payload, "alert_rules", AlertRule)
        if loaded_alert_rules is not None:
            self.alert_rules = loaded_alert_rules
        for rule in self.alert_rules.values():
            runtime = self.application_state_repository.get_alert_rule_runtime(rule.id)
            rule.last_triggered_at = (
                runtime.last_triggered_at if runtime is not None else None
            )

        raw_email_settings = payload.get("email_settings")
        if isinstance(raw_email_settings, dict):
            try:
                self.email_settings = EmailSettings.model_validate(raw_email_settings)
            except (TypeError, ValueError):
                pass

        raw_credentials = payload.get("password_credentials", {})
        if isinstance(raw_credentials, dict):
            self.password_credentials = {
                str(user_id): str(encoded_hash)
                for user_id, encoded_hash in raw_credentials.items()
                if str(user_id) in self.users and isinstance(encoded_hash, str)
            }

        raw_temporary = payload.get("temporary_password_user_ids", [])
        if isinstance(raw_temporary, list):
            self.temporary_password_user_ids = {
                str(user_id) for user_id in raw_temporary if str(user_id) in self.password_credentials
            }

        loaded_scim_tokens = self._load_model_collection(payload, "scim_tokens", ScimTokenRecord)
        if loaded_scim_tokens is not None:
            self.scim_tokens = {
                token_id: record
                for token_id, record in loaded_scim_tokens.items()
                if record.tenant_id in self.tenants
            }

        raw_encrypted_keys = payload.get("encrypted_provider_keys", {})
        if isinstance(raw_encrypted_keys, dict):
            self._encrypted_keys = {
                str(key_id): str(encrypted_value)
                for key_id, encrypted_value in raw_encrypted_keys.items()
                if isinstance(encrypted_value, str)
            }

        raw_configuration_secrets = payload.get("configuration_secrets", {})
        if isinstance(raw_configuration_secrets, dict):
            self._configuration_secrets = {
                str(secret_id): str(encrypted_value)
                for secret_id, encrypted_value in raw_configuration_secrets.items()
                if isinstance(encrypted_value, str)
            }

        if self.knowledge_documents or self.knowledge_chunks:
            config_ids = set(self.knowledge_documents) | set(self.knowledge_chunks)
            for config_id in config_ids:
                self.vector_store.replace_config(
                    config_id,
                    self.knowledge_documents.get(config_id, []),
                    self.knowledge_chunks.get(config_id, []),
                )

    def _dump_model_collection(self, collection: dict[str, Any]) -> list[dict[str, Any]]:
        return [record.model_dump(mode="json") for record in collection.values()]

    def _upgrade_legacy_secret_tokens(self) -> None:
        """Rewrite legacy vault ciphertext once after durable state is loaded."""
        changed = False
        if set(self._encrypted_keys) != set(self.provider_keys):
            raise IdentityConfigCorruptionError(
                "Provider-key metadata and ciphertext IDs do not match exactly."
            )
        for key_id, token in list(self._encrypted_keys.items()):
            key = self.provider_keys[key_id]
            upgraded = upgrade_legacy_provider_credential_ciphertext(
                self.vault,
                token,
                context=_provider_credential_cipher_context(key),
            )
            if upgraded != token:
                self._encrypted_keys[key_id] = upgraded
                changed = True
        for record_id, token in list(self._configuration_secrets.items()):
            if token.startswith(SecretVault.V2_PREFIX):
                continue
            self._configuration_secrets[record_id] = self.vault.encrypt(
                self.vault.decrypt(token)
            )
            changed = True
        if changed:
            self.save_runtime_state(urgent=True)

    def _dump_grouped_model_collection(self, collection: dict[str, list[Any]]) -> dict[str, list[dict[str, Any]]]:
        return {
            group_id: [record.model_dump(mode="json") for record in records]
            for group_id, records in collection.items()
        }

    def _load_model_collection(
        self,
        payload: dict[str, Any],
        key: str,
        model_type: type[Any],
    ) -> dict[str, Any] | None:
        raw_items = payload.get(key)
        if not isinstance(raw_items, list):
            return None
        loaded: dict[str, Any] = {}
        for raw_item in raw_items:
            try:
                item = model_type.model_validate(raw_item)
            except (TypeError, ValueError):
                continue
            item_id = getattr(item, "id", None)
            if isinstance(item_id, str):
                loaded[item_id] = item
        return loaded

    def _load_keyed_model_collection(
        self,
        payload: dict[str, Any],
        key: str,
        model_type: type[Any],
        key_attribute: str,
    ) -> dict[str, Any] | None:
        """Load records keyed by something other than ``id`` (tenant_id, user_id)."""
        raw_items = payload.get(key)
        if not isinstance(raw_items, list):
            return None
        loaded: dict[str, Any] = {}
        for raw_item in raw_items:
            try:
                item = model_type.model_validate(raw_item)
            except (TypeError, ValueError):
                continue
            item_key = getattr(item, key_attribute, None)
            if isinstance(item_key, str) and item_key:
                loaded[item_key] = item
        return loaded

    def _load_model_list(self, raw_items: list[Any], model_type: type[Any]) -> list[Any]:
        loaded: list[Any] = []
        for raw_item in raw_items:
            try:
                loaded.append(model_type.model_validate(raw_item))
            except (TypeError, ValueError):
                continue
        return loaded

    def _load_grouped_model_collection(
        self,
        payload: dict[str, Any],
        key: str,
        model_type: type[Any],
        group_attribute: str,
    ) -> dict[str, list[Any]] | None:
        raw_grouped_items = payload.get(key)
        if isinstance(raw_grouped_items, dict):
            loaded: dict[str, list[Any]] = {}
            for group_id, raw_items in raw_grouped_items.items():
                if not isinstance(raw_items, list):
                    continue
                for raw_item in raw_items:
                    try:
                        item = model_type.model_validate(raw_item)
                    except (TypeError, ValueError):
                        continue
                    loaded.setdefault(str(group_id), []).append(item)
            return loaded
        if isinstance(raw_grouped_items, list):
            loaded = {}
            for raw_item in raw_grouped_items:
                try:
                    item = model_type.model_validate(raw_item)
                except (TypeError, ValueError):
                    continue
                group_id = getattr(item, group_attribute, None)
                if isinstance(group_id, str):
                    loaded.setdefault(group_id, []).append(item)
            return loaded
        return None

    def set_configuration_secret(self, namespace: str, record_id: str, secret_value: str) -> str:
        encrypted_secret = self.vault.encrypt(secret_value)
        with self._store_lock:
            self._configuration_secrets[f"{namespace}:{record_id}"] = encrypted_secret
            self.save_runtime_state(urgent=True)
            return mask_secret(secret_value)

    def delete_configuration_secret(self, namespace: str, record_id: str) -> None:
        with self._store_lock:
            self._configuration_secrets.pop(f"{namespace}:{record_id}", None)
            self.save_runtime_state(urgent=True)

    def delete_configuration_secret_prefix(self, namespace: str, record_id_prefix: str) -> None:
        with self._store_lock:
            if namespace != "connector-user-oauth" or not record_id_prefix.endswith(":"):
                raise ValueError("Bulk secret deletion requires a structured connector owner.")
            resource_id = record_id_prefix[:-1]
            owned_keys = self.identity_config_repository.configuration_secret_keys_for_resource(
                resource_kind=ConfigurationSecretResourceKind.CONNECTOR_CONFIG,
                resource_id=resource_id,
            )
            for key in owned_keys:
                stored_namespace, separator, _remainder = key.partition(":")
                if separator and stored_namespace == namespace:
                    self._configuration_secrets.pop(key, None)
            self.save_runtime_state(urgent=True)

    def configuration_secret(self, namespace: str, record_id: str) -> str | None:
        encrypted = self._configuration_secrets.get(f"{namespace}:{record_id}")
        if encrypted is None:
            return None
        return self.vault.decrypt(encrypted)

    def brand_name(self, tenant_id: str | None = None) -> str:
        """Return explicit/sole-tenant branding without insertion-order fallback."""
        tenant = self.tenants.get(tenant_id) if tenant_id else None
        if tenant is None and len(self.tenants) == 1:
            tenant = next(iter(self.tenants.values()))
        if tenant is None:
            return "Aperture Chat"
        return (tenant.chat_brand_name or "").strip() or "Aperture Chat"

    def _bootstrap_knowledge_vector_store(self) -> None:
        for config_id, documents in self.knowledge_documents.items():
            self.vector_store.bootstrap_config(
                config_id,
                documents,
                self.knowledge_chunks.get(config_id, []),
            )
            persisted_documents = self.vector_store.documents_for(config_id)
            persisted_chunks = self.vector_store.chunks_for(config_id)
            if persisted_documents:
                self.knowledge_documents[config_id] = persisted_documents
                settings = dict(self.knowledge_configs[config_id].settings)
                settings["document_count"] = len(persisted_documents)
                if settings.get("status") == "draft":
                    settings["status"] = "synced"
                self.knowledge_configs[config_id].settings = settings
            if persisted_chunks:
                self.knowledge_chunks[config_id] = persisted_chunks

    def knowledge_documents_for(self, config_id: str) -> list[KnowledgeDocument]:
        documents = self.vector_store.documents_for(config_id)
        if documents:
            return [deepcopy(document) for document in documents]
        return [deepcopy(document) for document in self.knowledge_documents.get(config_id, [])]

    def knowledge_chunks_for(self, config_id: str) -> list[KnowledgeChunk]:
        chunks = self.vector_store.chunks_for(config_id)
        if chunks:
            return [deepcopy(chunk) for chunk in chunks]
        return [deepcopy(chunk) for chunk in self.knowledge_chunks.get(config_id, [])]

    def delete_knowledge_config(self, config_id: str) -> None:
        with self._store_lock:
            config = self.knowledge_configs.get(config_id)
            if config is None:
                raise KeyError(config_id)
            owned_secret_keys = (
                self.identity_config_repository.configuration_secret_keys_for_resource(
                    resource_kind=ConfigurationSecretResourceKind.KNOWLEDGE_CONFIG,
                    resource_id=config_id,
                )
            )
            self.knowledge_configs.pop(config_id)
            self.knowledge_documents.pop(config_id, None)
            self.knowledge_chunks.pop(config_id, None)
            for secret_key in owned_secret_keys:
                self._configuration_secrets.pop(secret_key, None)
            for model in self.models.values():
                if config_id in model.knowledge_config_ids:
                    model.knowledge_config_ids = [
                        knowledge_id
                        for knowledge_id in model.knowledge_config_ids
                        if knowledge_id != config_id
                    ]

            expected_digest = self._identity_config_live_digest
            if expected_digest is None:
                raise IdentityConfigCorruptionError(
                    "Active identity/config cache has no relational generation token."
                )
            state = scope_provider_credentials_for_import(
                self.vault,
                validate_v4_identity_config_state(self._identity_config_v4_payload()),
            )
            try:
                replaced, cleanup_job = (
                    self.identity_config_repository.replace_active_snapshot_with_cleanup_job(
                        state=state,
                        expected_relational_digest=expected_digest,
                        resource_kind="knowledge_config",
                        resource_id=config_id,
                        tenant_id=config.tenant_id,
                        session_cutoff_ms=None,
                        cleanup_job_id=f"identity-cleanup-{uuid4()}",
                    )
                )
            except Exception:
                current = self.identity_config_repository.load_active_snapshot()
                if current is not None:
                    self._load_identity_config_snapshot(current)
                    self._identity_config_live_digest = current.relational_digest
                raise
            self._identity_config_live_digest = replaced.relational_digest
            self._runtime_state_dirty = False
            self._run_identity_cleanup_job(cleanup_job)

    def delete_knowledge_document(
        self,
        config: KnowledgeConfig,
        document_id: str,
        *,
        synced_at: str,
    ) -> tuple[KnowledgeConfig, list[KnowledgeDocument], str] | None:
        current_documents = self.knowledge_documents.get(config.id, [])
        document = next((item for item in current_documents if item.id == document_id), None)
        if document is None:
            persisted_documents = self.vector_store.documents_for(config.id)
            document = next((item for item in persisted_documents if item.id == document_id), None)
            if document is None:
                return None
            current_documents = persisted_documents

        self.knowledge_documents[config.id] = [item for item in current_documents if item.id != document_id]
        self.knowledge_chunks[config.id] = [
            chunk for chunk in self.knowledge_chunks.get(config.id, []) if chunk.document_id != document_id
        ]
        self.vector_store.delete_document(config.id, document_id)
        persisted_chunks = self.vector_store.chunks_for(config.id)
        if persisted_chunks:
            self.knowledge_chunks[config.id] = persisted_chunks

        settings = dict(config.settings)
        settings["status"] = "synced"
        settings["document_count"] = len(self.knowledge_documents.get(config.id, []))
        settings["last_sync"] = synced_at
        settings["provider_status"] = "live"
        settings["provider_message"] = f"Deleted {document.name} from the knowledge index."
        config.settings = settings
        self.save_runtime_state()
        return config, self.knowledge_documents_for(config.id), synced_at

    def retrieve_knowledge(
        self,
        actor: User,
        config_ids: list[str],
        query: str,
        *,
        limit: int = 4,
    ) -> list[KnowledgeChunk]:
        config_ids = [
            config_id
            for config_id in config_ids
            if (config := self.knowledge_configs.get(config_id)) is not None
            and knowledge_access_allowed(actor, config)
        ]
        vector_hits = self.vector_store.search(actor, config_ids, query, limit=limit)
        if vector_hits:
            return vector_hits
        query_terms = _tokenize(query)
        candidates: list[KnowledgeChunk] = []
        for config_id in config_ids:
            for chunk in self.knowledge_chunks.get(config_id, []):
                if not _chunk_visible_to_actor(actor, chunk):
                    continue
                score = _chunk_score(chunk, query_terms, query)
                candidates.append(chunk.model_copy(update={"score": score}))
        ranked = [chunk for chunk in candidates if chunk.score > 0.1] or candidates
        ranked.sort(key=lambda chunk: (-chunk.score, chunk.source_name.lower(), chunk.ordinal))
        return [deepcopy(chunk) for chunk in ranked[:limit]]

    def append_knowledge_sources(
        self,
        config: KnowledgeConfig,
        documents: list[KnowledgeDocument],
        chunks: list[KnowledgeChunk],
        *,
        synced_at: str,
        provider_status: str,
        provider_message: str,
    ) -> tuple[KnowledgeConfig, list[KnowledgeDocument], str]:
        self.knowledge_documents.setdefault(config.id, []).extend(documents)
        self.knowledge_chunks.setdefault(config.id, []).extend(chunks)
        self.vector_store.upsert_sources(documents, chunks)
        settings = dict(config.settings)
        settings["status"] = knowledge_sync_status(provider_status)
        settings["document_count"] = len(self.knowledge_documents.get(config.id, []))
        settings["last_sync"] = synced_at
        settings["provider_status"] = provider_status
        settings["provider_message"] = provider_message
        config.settings = settings
        self.save_runtime_state()
        return config, self.knowledge_documents_for(config.id), synced_at

    def sync_knowledge_config(
        self,
        config_id: str,
        documents: list[KnowledgeDocument] | None = None,
        *,
        chunks: list[KnowledgeChunk] | None = None,
        provider_status: str = "cached",
        provider_message: str | None = None,
    ) -> tuple[KnowledgeConfig, list[KnowledgeDocument], str]:
        config = self.knowledge_configs[config_id]
        current_documents = self.knowledge_documents.setdefault(config_id, [])
        synced_at = _format_sync_time(datetime.now(UTC))
        citation_required = bool(config.settings.get("citation_required", True))

        if documents is not None:
            self.knowledge_documents[config_id] = documents
            current_documents = self.knowledge_documents[config_id]
            self.knowledge_chunks[config_id] = chunks or _chunks_from_documents(config, current_documents, synced_at)

        # An empty knowledge base stays empty: fabricating a placeholder "source
        # index" document would misreport what the sync actually returned.
        if current_documents:
            for document in current_documents:
                if document.status != "metadata-only":
                    document.status = "indexed"
                document.updated_at = synced_at
                document.citation_required = citation_required
                if not document.acl_group_ids:
                    document.acl_group_ids = list(config.acl_group_ids)
            if not self.knowledge_chunks.get(config_id):
                self.knowledge_chunks[config_id] = _chunks_from_documents(config, current_documents, synced_at)
        else:
            self.knowledge_chunks[config_id] = []

        settings = dict(config.settings)
        settings["status"] = knowledge_sync_status(provider_status)
        settings["document_count"] = len(current_documents)
        settings["last_sync"] = synced_at
        settings["provider_status"] = provider_status
        if provider_message:
            settings["provider_message"] = provider_message
        else:
            settings.pop("provider_message", None)
        config.settings = settings
        self.vector_store.replace_config(config_id, current_documents, self.knowledge_chunks.get(config_id, []))
        self.save_runtime_state()
        return config, self.knowledge_documents_for(config_id), synced_at

    def groups_with_live_counts(self) -> list[Group]:
        """Return groups whose ``user_count`` reflects current membership.

        The stored field is only refreshed for the protected default group, so
        every admin-created group reported the count it was created with --
        normally zero. An administrator reads that number to judge how many
        people a permission change will affect, so it is derived here instead
        of trusted from storage.
        """
        with self._store_lock:
            counts: dict[str, int] = {}
            for user in self.users.values():
                if user.role == Role.PLATFORM_OWNER:
                    continue
                for group_id in user.group_ids:
                    counts[group_id] = counts.get(group_id, 0) + 1
            return [
                group.model_copy(update={"user_count": counts.get(group.id, 0)})
                for group in self.groups.values()
            ]

    def chat_threads_for(self, actor: User) -> list[ChatThread]:
        # Chat history is personal workspace state. Platform governance access
        # does not imply access to another user's conversation list.
        with self._store_lock:
            return self.application_state_repository.list_chat_threads_for_owner(
                owner_user_id=actor.id,
                tenant_id=actor.tenant_id,
                allow_cross_tenant=actor.role == Role.PLATFORM_OWNER,
                newest_first=True,
            )

    def chat_folders_for(self, actor: User) -> list[ChatFolder]:
        # Folders follow the same personal ownership boundary as their threads.
        with self._store_lock:
            return self.application_state_repository.list_chat_folders_for_owner(
                owner_user_id=actor.id,
                tenant_id=actor.tenant_id,
                allow_cross_tenant=actor.role == Role.PLATFORM_OWNER,
                newest_first=True,
            )

    def save_chat_folder(self, folder: ChatFolder) -> ChatFolder:
        with self._store_lock:
            return self.application_state_repository.upsert_chat_folder(folder)

    def delete_chat_folder(self, folder_id: str) -> tuple[ChatFolder | None, list[str]]:
        with self._store_lock:
            return self.application_state_repository.delete_chat_folder(folder_id)

    def save_chat_thread(self, thread: ChatThread) -> ChatThread:
        with self._store_lock:
            return self.application_state_repository.upsert_chat_thread(thread)

    def delete_chat_thread(self, thread_id: str) -> ChatThread | None:
        with self._store_lock:
            return self.application_state_repository.delete_chat_thread(thread_id)

    def save_chat_attachment(self, attachment: ChatAttachment) -> ChatAttachment:
        with self._store_lock:
            return self.application_state_repository.upsert_chat_attachment(attachment)

    def apply_chat_thread_tag(self, tag: ChatThreadTag) -> ChatThreadTag:
        with self._store_lock:
            return self.application_state_repository.apply_chat_thread_tag(tag)

    def list_chat_thread_tags(
        self,
        *,
        tenant_id: str | None = None,
        thread_id: str | None = None,
        namespace: str | None = None,
        key: str | None = None,
    ) -> list[ChatThreadTag]:
        with self._store_lock:
            return self.application_state_repository.list_chat_thread_tags(
                tenant_id=tenant_id,
                thread_id=thread_id,
                namespace=namespace,
                key=key,
            )

    def remove_chat_thread_tag(
        self, thread_id: str, namespace: str, key: str
    ) -> ChatThreadTag | None:
        with self._store_lock:
            return self.application_state_repository.remove_chat_thread_tag(
                thread_id, namespace, key
            )

    def set_chat_threads_archived(
        self, thread_ids: Sequence[str], *, tenant_id: str, archived: bool = True
    ) -> int:
        with self._store_lock:
            return self.application_state_repository.set_chat_threads_archived(
                thread_ids, tenant_id=tenant_id, archived=archived
            )

    def thread_ids_under_active_hold(self, tenant_id: str) -> set[str]:
        with self._store_lock:
            return self.application_state_repository.thread_ids_under_active_hold(tenant_id)

    def chat_attachment_for(self, actor: User, attachment_id: str) -> ChatAttachment | None:
        with self._store_lock:
            return self.application_state_repository.get_chat_attachment_for_owner(
                attachment_id,
                owner_user_id=actor.id,
                tenant_id=actor.tenant_id,
                allow_platform_owner_global=actor.role == Role.PLATFORM_OWNER,
            )

    def memories_for_user(self, actor: User) -> list[UserMemory]:
        """Active memories owned by ``actor``.

        There is no platform-owner bypass here, unlike every other collection:
        memory content is private to the person who created it, and admins get
        counts and purge only.
        """
        if actor.tenant_id is None and actor.role != Role.PLATFORM_OWNER:
            return []
        memories = [
            deepcopy(memory)
            for memory in self.user_memories.values()
            if memory.active
            and memory.owner_user_id == actor.id
            and (
                actor.role == Role.PLATFORM_OWNER
                or memory.tenant_id == actor.tenant_id
            )
        ]
        memories.sort(key=lambda memory: (not memory.pinned, memory.created_at), reverse=False)
        return memories

    def memory_for_user(self, actor: User, memory_id: str) -> UserMemory | None:
        memory = self.user_memories.get(memory_id)
        if memory is None or not memory.active:
            return None
        if memory.owner_user_id != actor.id:
            return None
        if actor.role != Role.PLATFORM_OWNER and memory.tenant_id != actor.tenant_id:
            return None
        return deepcopy(memory)

    def save_user_memory(self, memory: UserMemory, *, persist: bool = True) -> UserMemory:
        self.user_memories[memory.id] = memory
        if persist:
            self.save_runtime_state()
        return deepcopy(memory)

    def save_user_memories(self, memories: list[UserMemory]) -> None:
        if not memories:
            return
        for memory in memories:
            self.user_memories[memory.id] = memory
        self.save_runtime_state()

    def deactivate_user_memory(self, memory_id: str) -> bool:
        memory = self.user_memories.get(memory_id)
        if memory is None or not memory.active:
            return False
        memory.active = False
        memory.updated_at = _memory_timestamp()
        self.save_runtime_state()
        return True

    def purge_user_memories(self, user_id: str) -> int:
        """Hard delete every memory owned by a user. Used for self-purge,
        admin compliance purge, and account deletion."""
        doomed = [
            memory_id
            for memory_id, memory in self.user_memories.items()
            if memory.owner_user_id == user_id
        ]
        for memory_id in doomed:
            self.user_memories.pop(memory_id, None)
        self.user_memory_settings.pop(user_id, None)
        if doomed:
            self.save_runtime_state()
        return len(doomed)

    def memory_counts_for_tenant(self, tenant_id: str | None) -> list[MemoryUserStat]:
        """Per-user memory counts with no content, for admin reporting."""
        counts: dict[str, int] = defaultdict(int)
        latest: dict[str, str] = {}
        for memory in self.user_memories.values():
            if not memory.active:
                continue
            if tenant_id is not None and memory.tenant_id != tenant_id:
                continue
            counts[memory.owner_user_id] += 1
            stamp = memory.updated_at or memory.created_at
            if stamp and stamp > latest.get(memory.owner_user_id, ""):
                latest[memory.owner_user_id] = stamp
        stats: list[MemoryUserStat] = []
        for user in self.users.values():
            if user.role == Role.PLATFORM_OWNER:
                continue
            if tenant_id is not None and user.tenant_id != tenant_id:
                continue
            stats.append(
                MemoryUserStat(
                    user_id=user.id,
                    display_name=user.display_name,
                    email=user.email,
                    count=counts.get(user.id, 0),
                    last_updated=latest.get(user.id),
                )
            )
        stats.sort(key=lambda stat: (-stat.count, stat.display_name.lower()))
        return stats

    def tenant_memory_policy(self, tenant_id: str | None) -> TenantMemoryPolicy:
        if tenant_id is None:
            return TenantMemoryPolicy(tenant_id="")
        policy = self.tenant_memory_policies.get(tenant_id)
        if policy is None:
            return TenantMemoryPolicy(tenant_id=tenant_id)
        return deepcopy(policy)

    def save_tenant_memory_policy(self, policy: TenantMemoryPolicy) -> TenantMemoryPolicy:
        self.tenant_memory_policies[policy.tenant_id] = policy
        self.save_runtime_state()
        return deepcopy(policy)

    def tenant_retention_policy(self, tenant_id: str | None) -> TenantRetentionPolicy:
        if tenant_id is None:
            return TenantRetentionPolicy(tenant_id="")
        policy = self.tenant_retention_policies.get(tenant_id)
        if policy is None:
            return TenantRetentionPolicy(tenant_id=tenant_id)
        return deepcopy(policy)

    def save_tenant_retention_policy(
        self, policy: TenantRetentionPolicy
    ) -> TenantRetentionPolicy:
        self.tenant_retention_policies[policy.tenant_id] = policy
        self.save_runtime_state()
        return deepcopy(policy)

    def user_memory_settings_for(self, user_id: str) -> UserMemorySettings:
        settings = self.user_memory_settings.get(user_id)
        if settings is None:
            return UserMemorySettings(user_id=user_id)
        return deepcopy(settings)

    def save_user_memory_settings(self, settings: UserMemorySettings) -> UserMemorySettings:
        self.user_memory_settings[settings.user_id] = settings
        self.save_runtime_state()
        return deepcopy(settings)

    def visible_users_for(self, actor: User) -> list[User]:
        from app.core.policy import can_view_user

        return [deepcopy(user) for user in self.users.values() if can_view_user(actor, user)]

    def tenant_visible_users_for(self, actor: User) -> list[User]:
        # Tenant-scoped user surfaces never list platform owners, even when the
        # actor is a platform owner previewing the tenant admin console.
        return [user for user in self.visible_users_for(actor) if user.role != Role.PLATFORM_OWNER]

    def audit_events_newest_first(self, limit: int | None = None) -> list[AuditEvent]:
        with self._store_lock:
            return self.application_state_repository.list_audit(
                newest_first=True,
                limit=limit,
            )

    def tenant_audit_events_newest_first(self, tenant_id: str | None, limit: int | None = None) -> list[AuditEvent]:
        # Tenant-scoped trail: platform-owner-only actions (key reveals, provider
        # mutations) are recorded without a tenant_id and never appear here.
        with self._store_lock:
            return self.application_state_repository.list_audit(
                tenant_id=tenant_id,
                tenant_visible=True,
                excluded_actor_roles={str(Role.PLATFORM_OWNER)},
                newest_first=True,
                limit=limit,
            )

    def audit_event_count(
        self,
        *,
        tenant_id: str | None = None,
        tenant_scoped: bool = False,
    ) -> int:
        with self._store_lock:
            return self.application_state_repository.count_audit(
                tenant_id=tenant_id,
                tenant_visible=tenant_scoped,
                excluded_actor_roles=(
                    {str(Role.PLATFORM_OWNER)} if tenant_scoped else None
                ),
            )

    def alert_notifications_newest_first(
        self,
        *,
        scope: str | None = None,
        tenant_id: str | None = None,
        limit: int | None = None,
    ) -> list[AlertNotification]:
        with self._store_lock:
            return self.application_state_repository.list_alert_notifications(
                scope=scope,
                tenant_id=tenant_id,
                tenant_visible=scope == "tenant",
                newest_first=True,
                limit=limit,
            )

    def set_alert_notification_archived(
        self,
        notification_id: str,
        archived: bool,
        *,
        require_tenant_id: str | None = None,
    ) -> AlertNotification | None:
        """Archive or restore one delivery. When ``require_tenant_id`` is set
        (tenant-admin scope), only that tenant's tenant-scope notifications are
        reachable — platform-scope deliveries stay owner-only."""
        with self._store_lock:
            notification = self.application_state_repository.get_alert_notification(notification_id)
            if notification is None:
                return None
            if require_tenant_id is not None and (
                notification.scope != "tenant" or notification.tenant_id != require_tenant_id
            ):
                return None
            if notification.archived == archived:
                return notification
            updated = notification.model_copy(update={"archived": archived})
            return self.application_state_repository.update_alert_notification(updated)

    def elastic_pending_count(self) -> int:
        return self.application_state_repository.count_pending_outbox()

    def elastic_pending_events(self, tenant_id: str | None) -> list[dict[str, Any]]:
        rows = self.application_state_repository.pending_outbox()
        return [
            deepcopy(row.payload)
            for row in rows
            if tenant_id is None or row.tenant_id == tenant_id
        ]

    def user_prompt_records(
        self,
        tenant_id: str | None,
        *,
        user_id: str | None = None,
        thread_id: str | None = None,
        limit: int | None = None,
    ) -> list[UserPromptRecord]:
        active_alert_counts = Counter(
            (alert.user_id, alert.thread_id)
            for alert in self.security_alerts.values()
            if not alert.acknowledged
            and alert.thread_id is not None
            and (tenant_id is None or alert.tenant_id == tenant_id)
            and (user_id is None or alert.user_id == user_id)
        )
        records: list[UserPromptRecord] = []
        for thread in self.chat_threads.values():
            if tenant_id is not None and thread.tenant_id != tenant_id:
                continue
            if user_id is not None and thread.owner_user_id != user_id:
                continue
            # Audit drilldown: the console fetches one thread's full
            # conversation so the preview can show every exchange, not just
            # the record that fell inside the newest-first list window.
            if thread_id is not None and thread.id != thread_id:
                continue
            owner = self.users.get(thread.owner_user_id)
            for index, message in enumerate(thread.messages):
                if message.role.lower() != "user":
                    continue
                response = _assistant_response_after(thread.messages, index)
                response_content = response.content if response is not None else None
                records.append(
                    UserPromptRecord(
                        id=message.id,
                        user_id=thread.owner_user_id,
                        user_name=owner.display_name if owner is not None else thread.owner_user_id,
                        user_email=owner.email if owner is not None else "",
                        user_role=owner.role if owner is not None else Role.USER,
                        thread_id=thread.id,
                        thread_title=thread.title,
                        model_id=thread.model_id,
                        content=message.content,
                        created_at=message.createdAt,
                        created_at_iso=message.createdAtIso,
                        response_message_id=response.id if response is not None else None,
                        response_content=(
                            response_content[:PROMPT_RESPONSE_PREVIEW_CHARS]
                            if response_content is not None
                            else None
                        ),
                        response_created_at=response.createdAt if response is not None else None,
                        response_created_at_iso=response.createdAtIso if response is not None else None,
                        response_status=response.status if response is not None else None,
                        response_truncated=(
                            response_content is not None
                            and len(response_content) > PROMPT_RESPONSE_PREVIEW_CHARS
                        ),
                        # Extracted from the full saved output, not the preview
                        # slice, so images past the truncation point still show.
                        response_images=(
                            _generated_image_audit_links(response_content)
                            if response_content is not None
                            else []
                        ),
                        alert_count=active_alert_counts[(thread.owner_user_id, thread.id)],
                    )
                )
        records.sort(key=_prompt_record_sort_key, reverse=True)
        return records[:limit] if limit is not None else records

    def record_security_alert(self, alert: SecurityAlert) -> SecurityAlert:
        self.security_alerts[alert.id] = alert
        return alert

    def security_alerts_newest_first(
        self,
        tenant_id: str | None,
        *,
        user_id: str | None = None,
        include_acknowledged: bool = True,
        limit: int | None = None,
    ) -> list[SecurityAlert]:
        alerts = [
            deepcopy(alert)
            for alert in self.security_alerts.values()
            if (tenant_id is None or alert.tenant_id == tenant_id)
            and (user_id is None or alert.user_id == user_id)
            and (include_acknowledged or not alert.acknowledged)
        ]
        alerts.sort(key=lambda alert: alert.created_at, reverse=True)
        return alerts[:limit] if limit is not None else alerts

    def update_security_alert_acknowledgement(
        self,
        alert_id: str,
        *,
        acknowledged: bool,
        actor: User,
    ) -> SecurityAlert | None:
        alert = self.security_alerts.get(alert_id)
        if alert is None:
            return None
        alert.acknowledged = acknowledged
        if acknowledged:
            alert.acknowledged_by = actor.id
            alert.acknowledged_at = datetime.now(UTC)
        else:
            alert.acknowledged_by = None
            alert.acknowledged_at = None
        self.record_audit(
            actor,
            "security.alert_acknowledged" if acknowledged else "security.alert_reopened",
            alert.id,
            {
                "alert_id": alert.id,
                "user_id": alert.user_id,
                "rule_id": alert.rule_id,
                "rule_label": alert.rule_label,
                "severity": alert.severity,
                "acknowledged": acknowledged,
            },
        )
        return deepcopy(alert)

    def _audit_target_name(self, target: str, metadata: dict[str, object]) -> str:
        for key in ("name", "display_name", "title", "email"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                return value
        collections: tuple[dict[str, Any], ...] = (
            self.models,
            self.providers,
            self.provider_keys,
            self.users,
            self.groups,
            self.connectors,
            self.connector_configs,
            self.sso_configs,
            self.knowledge_configs,
            self.tool_configs,
            self.prompt_templates,
            self.skill_files,
            self.tenants,
            self.agent_runs,
            self.chat_threads,
        )
        for collection in collections:
            record = collection.get(target)
            if record is not None:
                for attribute in ("name", "display_name", "title", "provider"):
                    value = getattr(record, attribute, None)
                    if isinstance(value, str) and value.strip():
                        return value
        return target

    def group_users(self) -> dict[str, list[User]]:
        grouped: dict[str, list[User]] = defaultdict(list)
        for user in self.users.values():
            for group_id in user.group_ids:
                grouped[group_id].append(user)
        return grouped


def knowledge_sync_status(provider_status: str) -> str:
    """Map provider truth to the knowledge-base status shown in the UI.

    "synced" is reserved for live provider syncs; cached fallbacks are "stale"
    and provider failures are "error" so a failed sync can never show green.
    """
    if provider_status == "live":
        return "synced"
    if provider_status == "error":
        return "error"
    return "stale"


def _chunk_visible_to_actor(actor: User, chunk: KnowledgeChunk) -> bool:
    if actor.role == Role.PLATFORM_OWNER:
        return True
    if actor.tenant_id != chunk.tenant_id:
        return False
    if chunk.acl_group_ids and not set(actor.group_ids).intersection(chunk.acl_group_ids):
        return False
    return True


def _chunk_score(chunk: KnowledgeChunk, query_terms: set[str], query: str) -> float:
    searchable = f"{chunk.source_name} {chunk.text}".lower()
    if not query_terms:
        return 0.1
    lexical_score = 0.0
    for term in query_terms:
        lexical_score += searchable.count(term)
    normalized_query = " ".join(query.lower().split())
    exact_score = 0.0
    if normalized_query and normalized_query in searchable:
        exact_score = 4.0
    vector_score = _cosine_similarity(_text_vector(query), _text_vector(searchable))
    # Keep zero-overlap chunks available as deterministic fallback context.
    score = exact_score + lexical_score + vector_score
    return score if score > 0 else 0.1


def _tokenize(value: str) -> set[str]:
    return set(_text_vector(value).keys())


def _text_vector(value: str) -> dict[str, float]:
    vector: dict[str, float] = defaultdict(float)
    for raw_token in re.findall(r"[a-zA-Z0-9]+", value.lower()):
        token = _normalize_search_token(raw_token)
        if token is None:
            continue
        vector[token] += 1.0
    return dict(vector)


def _normalize_search_token(token: str) -> str | None:
    if len(token) <= 2 or token in _SEARCH_STOPWORDS:
        return None
    if len(token) > 4 and token.endswith("s"):
        token = token[:-1]
    return token


def _cosine_similarity(left: dict[str, float], right: dict[str, float]) -> float:
    if not left or not right:
        return 0.0
    dot_product = sum(weight * right.get(token, 0.0) for token, weight in left.items())
    if dot_product <= 0:
        return 0.0
    left_norm = sum(weight * weight for weight in left.values()) ** 0.5
    right_norm = sum(weight * weight for weight in right.values()) ** 0.5
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot_product / (left_norm * right_norm)


def _chunks_from_documents(
    config: KnowledgeConfig,
    documents: list[KnowledgeDocument],
    synced_at: str,
) -> list[KnowledgeChunk]:
    chunks: list[KnowledgeChunk] = []
    for index, document in enumerate(documents):
        chunks.append(
            KnowledgeChunk(
                id=f"chunk-{document.id}-inventory",
                knowledge_config_id=config.id,
                document_id=document.id,
                tenant_id=document.tenant_id,
                source_name=document.name,
                source_uri=document.source_uri,
                source_type=document.source_type,
                text=_document_inventory_chunk_text(config, document),
                ordinal=index,
                acl_group_ids=document.acl_group_ids or list(config.acl_group_ids),
                updated_at=document.updated_at or synced_at,
            )
        )
    return chunks


def _document_inventory_chunk_text(config: KnowledgeConfig, document: KnowledgeDocument) -> str:
    return (
        f"{config.name} indexed source inventory: {document.name} is available from "
        f"{document.source_type} at {document.source_uri}. Full file-text extraction is not available yet; "
        f"this source currently contributes document metadata and citation provenance."
    )


def _usage_token(usage: dict[str, Any] | None, key: str) -> int | None:
    if not isinstance(usage, dict):
        return None
    value = usage.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    tokens = int(value)
    return tokens if tokens >= 0 else None


def _parse_iso_timestamp(value: str | None) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


_AUDIT_ACTION_TYPES = {
    "platform.provider_created": "PROVIDER_ADDED",
    "platform.provider_updated": "PROVIDER_UPDATED",
    "platform.model_created": "MODEL_ADDED",
    "platform.model_updated": "MODEL_UPDATED",
    "platform.model_deleted": "MODEL_DELETED",
    "platform.provider_models_synced": "MODEL_SYNC_RUN",
    "platform.provider_models_sync_failed": "MODEL_SYNC_FAILED",
    "platform.provider_key_created": "PROVIDER_KEY_ADDED",
    "platform.provider_key_revealed": "PROVIDER_KEY_REVEALED",
    "platform.provider_key_rotated": "PROVIDER_KEY_ROTATED",
    "platform.provider_key_deleted": "PROVIDER_KEY_DELETED",
    "platform.connector_updated": "CONNECTOR_UPDATED",
    "admin.model_catalog_synced": "MODEL_SYNC_RUN",
    "admin.model_catalog_sync_failed": "MODEL_SYNC_FAILED",
    "admin.user_created": "USER_CREATED",
    "admin.user_deactivated": "USER_DEACTIVATED",
    "admin.user_deleted": "USER_DELETED",
    "admin.group_created": "GROUP_CREATED",
    "admin.group_updated": "GROUP_UPDATED",
    "admin.group_deleted": "GROUP_DELETED",
    "admin.sso_config_created": "SSO_SETTINGS_CREATED",
    "admin.sso_config_updated": "SSO_SETTINGS_UPDATED",
    "auth.login": "USER_LOGIN",
    "auth.user_jit_created": "USER_JIT_PROVISIONED",
    "platform.branding_updated": "BRANDING_UPDATED",
    "platform.settings_updated": "PLATFORM_SETTINGS_UPDATED",
    "knowledge.oauth_token_stored": "KNOWLEDGE_OAUTH_TOKEN_STORED",
    "scim.user_created": "USER_PROVISIONED",
    "scim.user_replaced": "USER_UPDATED",
    "scim.user_patched": "USER_UPDATED",
    "scim.user_deactivated": "USER_DEACTIVATED",
}

_AUDIT_TARGET_TYPES = (
    ("provider_key", "provider-key"),
    ("provider_models", "provider"),
    ("provider", "provider"),
    ("model_catalog", "provider"),
    ("model_access", "model"),
    ("model", "model"),
    ("agent_profile", "model"),
    ("user", "user"),
    ("group", "group"),
    ("connector_config", "connector-config"),
    ("connector", "connector"),
    ("sso", "sso-config"),
    ("knowledge", "knowledge-config"),
    ("tool_config", "tool-config"),
    ("mcp", "tool-config"),
    ("prompt_template", "prompt-template"),
    ("skill_file", "skill-file"),
    ("login", "session"),
)


def _audit_action_type(action: str, metadata: dict[str, object]) -> str:
    if action == "platform.model_status_changed":
        return "MODEL_ENABLED" if metadata.get("platform_enabled") else "MODEL_DISABLED"
    if action == "admin.user_updated":
        changed = metadata.get("changed")
        if isinstance(changed, list) and "role" in changed:
            return "USER_ROLE_CHANGED"
        return "USER_UPDATED"
    if action == "admin.model_access_updated":
        return _grant_action_type(metadata)
    mapped = _AUDIT_ACTION_TYPES.get(action)
    if mapped:
        return mapped
    suffix = action.split(".", 1)[-1]
    return re.sub(r"[^A-Z0-9]+", "_", suffix.upper()).strip("_") or "EVENT"


def _grant_action_type(metadata: dict[str, object]) -> str:
    current = metadata.get("group_ids")
    previous = metadata.get("previous_group_ids")
    if isinstance(current, list) and isinstance(previous, list):
        added = set(map(str, current)) - set(map(str, previous))
        removed = set(map(str, previous)) - set(map(str, current))
        if added and not removed:
            return "GRANT_ADDED"
        if removed and not added:
            return "GRANT_REMOVED"
    return "GRANT_UPDATED"


def _audit_target_type(action: str) -> str:
    namespace, _, suffix = action.partition(".")
    if namespace == "agent":
        return "agent-run"
    if namespace == "chat":
        return "chat"
    if namespace == "scim":
        return "user"
    if namespace == "knowledge":
        return "knowledge-config"
    if action == "platform.branding_updated":
        return "tenant"
    if action == "platform.settings_updated":
        return "platform-settings"
    for prefix, target_type in _AUDIT_TARGET_TYPES:
        if suffix.startswith(prefix):
            return target_type
    return "resource"


def _audit_detail(metadata: dict[str, object], *, max_length: int = 200) -> str:
    parts: list[str] = []
    for key, value in metadata.items():
        rendered = _render_audit_value(value)
        if rendered is None:
            continue
        parts.append(f"{key}={rendered}")
        if len(parts) >= 5:
            break
    detail = "; ".join(parts)
    if len(detail) > max_length:
        detail = f"{detail[: max_length - 3]}..."
    return detail


def _prompt_record_sort_key(record: UserPromptRecord) -> datetime:
    value = record.created_at_iso or ""
    if value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.min.replace(tzinfo=UTC)


def _assistant_response_after(
    messages: list[ChatMessage], prompt_index: int
) -> ChatMessage | None:
    """Return the saved assistant output paired with one user-authored turn."""

    for message in messages[prompt_index + 1 :]:
        role = message.role.lower()
        if role == "user":
            break
        if role == "assistant":
            return message
    return None


def _render_audit_value(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        return text if len(text) <= 60 else f"{text[:57]}..."
    if isinstance(value, list):
        rendered_items = [item for item in (_render_audit_value(item) for item in value) if item is not None]
        return f"[{', '.join(rendered_items)}]" if rendered_items else "[]"
    if isinstance(value, dict):
        return f"{{{len(value)} fields}}"
    return str(value)


def _format_vault_time(value: datetime) -> str:
    return value.strftime("%b %d, %Y, %I:%M %p").replace(" 0", " ")


def _format_vault_date(value: datetime) -> str:
    return value.strftime("%b %d, %Y").replace(" 0", " ")


def _format_sync_time(value: datetime) -> str:
    return value.strftime("%b %d, %Y, %I:%M %p UTC").replace(" 0", " ")
