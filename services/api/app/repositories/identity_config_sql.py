"""Transactional SQL authority for A7 identity and configuration state.

The JSON-to-SQL cutover is intentionally split across two transactions because
the relational and vector databases cannot share a transaction manager:

1. ``import_validated_identity_config`` stages every non-vector row and its SQL
   receipt atomically, but never writes the authority pointer.
2. ``activate_identity_config`` accepts a caller-verified vector receipt and
   writes the singleton SQL authority pointer only when source, semantic digest,
   and knowledge counts match the staged receipt.

Until phase two commits, ``load_active_snapshot`` returns no SQL authority.
Once active, SQL is authoritative and stale version-4 input is never replayed
over legitimate later mutations.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import RLock
from types import MappingProxyType
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ValidationError
from sqlalchemy import delete, func, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.db.engine import (
    HEAD_REVISION,
    IDENTITY_CONFIG_IMPORT_REVISION,
    create_session_factory,
    engine_write_lock,
)
from app.db.import_identity_config import (
    MODEL_COLLECTIONS,
    SOURCE_STATE_VERSION,
    TARGET_STATE_VERSION,
    IdentityConfigImportReceipt,
    ProviderKeyImportRecord,
    ValidatedIdentityConfigState,
)
from app.db.knowledge_import_state import (
    SEMANTIC_FORMAT,
    SPARSE_VECTOR_FORMAT,
    KnowledgeStateImportReceipt,
    knowledge_semantic_digest,
)
from app.db.orm import (
    AgentRunRow,
    AlertRuleConfigRow,
    AlertRuleRuntimeRow,
    AutomationRow,
    ChatStateImportRow,
    CompanionMemoryRow,
    ConfigurationSecretRow,
    ConnectorConfigRow,
    ConnectorRow,
    ContentFilterRow,
    EmailSettingsRow,
    IdentityConfigActiveImportRow,
    IdentityConfigImportRow,
    IdentityGroupRow,
    IdentityUserRow,
    KnowledgeConfigRow,
    MatterDeletionJobRow,
    MatterMembershipRow,
    ModelConfigRow,
    PasswordCredentialRow,
    PlatformSettingsRow,
    PromptTemplateRow,
    ProviderCredentialBindingRow,
    ProviderKeyRow,
    ProviderRow,
    RuntimeStateImportRow,
    ScimTokenRow,
    SecurityAlertRow,
    SkillFileRow,
    SsoConfigRow,
    TenantMemoryPolicyRow,
    TenantRetentionPolicyRow,
    TenantRow,
    ToolConfigRow,
    UserMemoryRow,
    UserMemorySettingsRow,
)
from app.models.schemas import (
    DEFAULT_GROUP_PERMISSIONS,
    EmailSettings,
    Group,
    PlatformSettings,
    TenantRetentionPolicy,
    ToolConfig,
    User,
)
from app.repositories.identity_config import (
    AmbiguousProviderCredentialBinding,
    ConfigurationSecretResourceIndex,
    ConfigurationSecretResourceKind,
    IdentityConfigImportOutcome,
    IdentityConfigRepositoryError,
    ParsedConfigurationSecretKey,
    ProviderCredentialBinding,
    ProviderCredentialBundle,
    configuration_secret_keys_owned_by,
    parse_configuration_secret_keys,
    provider_scope_key,
    select_provider_credential_binding,
)
from app.repositories.identity_cleanup import (
    CleanupResourceKind,
    IdentityCleanupJob,
    IdentityCleanupRepositoryError,
    assert_resource_recreation_allowed_in_session,
    claim_cleanup_job_in_session,
    create_cleanup_job_in_session,
    mark_cleanup_stage_in_session,
    prepare_vector_source_journal,
    put_vector_source_journal_in_session,
)


T = TypeVar("T")
_POSTGRES_CUTOVER_LOCK_ID = 2_026_072_000_009


class IdentityConfigSqlError(IdentityConfigRepositoryError):
    """The SQL identity/config authority could not complete an operation."""


class IdentityConfigImportConflict(IdentityConfigSqlError):
    """Staged or preexisting relational state conflicts with an import."""


class IdentityConfigActivationError(IdentityConfigSqlError):
    """The staged SQL receipt cannot be activated by the supplied vector receipt."""


class IdentityConfigCorruptionError(IdentityConfigSqlError):
    """Active SQL authority is incomplete or internally inconsistent."""


class ProviderCredentialConflict(IdentityConfigSqlError):
    """A provider credential write lost its scoped compare-and-set."""


class IdentityConfigSnapshotConflict(IdentityConfigSqlError):
    """A live snapshot write was based on stale relational authority."""


@dataclass(frozen=True, slots=True)
class IdentityConfigSqlSnapshot:
    """Detached current relational state, available only after activation."""

    receipt: IdentityConfigImportReceipt
    collections: Mapping[str, tuple[BaseModel, ...]]
    platform_settings: PlatformSettings
    email_settings: EmailSettings
    password_credentials: tuple[tuple[str, str], ...]
    temporary_password_user_ids: tuple[str, ...]
    encrypted_provider_keys: tuple[tuple[str, str], ...]
    configuration_secrets: tuple[tuple[str, str], ...]
    provider_bindings: tuple[ProviderCredentialBinding, ...]

    @property
    def relational_digest(self) -> str:
        """Canonical generation token for compare-and-set snapshot writes."""

        return _snapshot_relational_digest(self)


@dataclass(frozen=True, slots=True)
class IdentityConfigSqlAuthorityState:
    """One atomic observation of empty, staged, or active SQL authority."""

    status: Literal["empty", "staged", "active"]
    snapshot: IdentityConfigSqlSnapshot | None


@dataclass(frozen=True, slots=True)
class _PreparedSecret:
    parsed: ParsedConfigurationSecretKey
    tenant_id: str | None
    ciphertext: str


@dataclass(frozen=True, slots=True)
class _PreparedProviderKey:
    model: ProviderKeyImportRecord
    ciphertext: str
    ordinal: int


@dataclass(frozen=True, slots=True)
class _PreparedImport:
    secrets: tuple[_PreparedSecret, ...]
    provider_keys: tuple[_PreparedProviderKey, ...]
    bindings: tuple[ProviderCredentialBinding, ...]
    completed_at: datetime


_COLLECTION_ROW_TYPES: dict[str, type[Any]] = {
    "tenants": TenantRow,
    "users": IdentityUserRow,
    "groups": IdentityGroupRow,
    "providers": ProviderRow,
    "models": ModelConfigRow,
    "provider_keys": ProviderKeyRow,
    "connectors": ConnectorRow,
    "connector_configs": ConnectorConfigRow,
    "sso_configs": SsoConfigRow,
    "knowledge_configs": KnowledgeConfigRow,
    "tool_configs": ToolConfigRow,
    "prompt_templates": PromptTemplateRow,
    "skill_files": SkillFileRow,
    "security_alerts": SecurityAlertRow,
    "agent_runs": AgentRunRow,
    "automations": AutomationRow,
    "companion_memories": CompanionMemoryRow,
    "content_filters": ContentFilterRow,
    "user_memories": UserMemoryRow,
    "tenant_memory_policies": TenantMemoryPolicyRow,
    "tenant_retention_policies": TenantRetentionPolicyRow,
    "user_memory_settings": UserMemorySettingsRow,
    "scim_tokens": ScimTokenRow,
    "alert_rules": AlertRuleConfigRow,
}

_UPSERT_COLLECTION_NAMES: tuple[str, ...] = (
    "tenants",
    "providers",
    "connectors",
    "users",
    "groups",
    "models",
    "provider_keys",
    "connector_configs",
    "sso_configs",
    "knowledge_configs",
    "tool_configs",
    "prompt_templates",
    "skill_files",
    "security_alerts",
    "agent_runs",
    "automations",
    "companion_memories",
    "content_filters",
    "user_memories",
    "tenant_memory_policies",
    "tenant_retention_policies",
    "user_memory_settings",
    "scim_tokens",
    "alert_rules",
)

_DELETE_COLLECTION_NAMES: tuple[str, ...] = tuple(reversed(_UPSERT_COLLECTION_NAMES))
_MAX_SQL_INTEGER = 2_147_483_647
_MAX_SQL_BIGINT = 9_223_372_036_854_775_807

_AUTHORITY_DATA_ROW_TYPES: tuple[type[Any], ...] = (
    *_COLLECTION_ROW_TYPES.values(),
    ProviderCredentialBindingRow,
    PlatformSettingsRow,
    EmailSettingsRow,
    PasswordCredentialRow,
    ConfigurationSecretRow,
)

def _engine_lock(engine: Engine) -> RLock:
    # Shared with every other repository on this database -- see
    # app.db.engine.engine_write_lock for why a private lock is not enough.
    return engine_write_lock(engine)


class IdentityConfigSqlRepository:
    """SQL implementation of the A7/A9 identity/config contracts."""

    def __init__(
        self,
        engine: Engine,
        *,
        session_factory: sessionmaker[Session] | None = None,
    ) -> None:
        self.engine = engine
        self._sessions = session_factory or create_session_factory(engine)
        self._lock = _engine_lock(engine)

    def import_validated_identity_config(
        self,
        *,
        state: ValidatedIdentityConfigState,
        receipt: IdentityConfigImportReceipt,
    ) -> IdentityConfigImportOutcome:
        """Stage relational state and its receipt without activating authority."""

        prepared = _prepare_import(state, receipt)
        prepared_journal = prepare_vector_source_journal(
            source_digest=state.source_digest,
            knowledge_digest=state.knowledge_digest,
            documents=state.knowledge_documents,
            chunks=state.knowledge_chunks,
            created_at=prepared.completed_at,
        )

        def operation(session: Session) -> IdentityConfigImportOutcome:
            _require_live_schema(session)
            _require_predecessor_receipts(
                session,
                receipt,
                prior_chain=state.prior_import_chain,
            )
            active = session.get(IdentityConfigActiveImportRow, 1)
            existing_receipts = list(session.scalars(select(IdentityConfigImportRow)))

            if active is not None:
                if active.source_digest != receipt.source_digest:
                    raise IdentityConfigImportConflict(
                        "A different identity/config import is already authoritative."
                    )
                row = session.get(IdentityConfigImportRow, active.source_digest)
                if row is None or not _receipt_matches(row, receipt):
                    raise IdentityConfigCorruptionError(
                        "The active identity/config receipt is missing or inconsistent."
                    )
                return _outcome(receipt, "already_applied")

            # The vector source journal and staged relational receipt share
            # this transaction. A crash therefore leaves both recovery inputs
            # visible or neither, including the idempotent staged-state path.
            put_vector_source_journal_in_session(
                session,
                prepared=prepared_journal,
            )

            existing = session.get(IdentityConfigImportRow, receipt.source_digest)
            if existing is not None:
                if len(existing_receipts) != 1 or not _receipt_matches(existing, receipt):
                    raise IdentityConfigImportConflict(
                        "The staged identity/config receipt conflicts with this import."
                    )
                snapshot = _load_snapshot(session, _receipt_from_row(existing))
                _assert_staged_snapshot(snapshot, state, receipt)
                return _outcome(receipt, "already_applied")

            if existing_receipts or _authority_data_exists(session):
                raise IdentityConfigImportConflict(
                    "Identity/config SQL tables contain partial or conflicting preexisting state."
                )

            _insert_state(session, state, receipt, prepared)
            session.flush()
            staged_row = session.get(IdentityConfigImportRow, receipt.source_digest)
            if staged_row is None:
                raise IdentityConfigCorruptionError(
                    "Identity/config staging did not persist its receipt."
                )
            snapshot = _load_snapshot(session, _receipt_from_row(staged_row))
            _assert_staged_snapshot(snapshot, state, receipt)
            if session.get(IdentityConfigActiveImportRow, 1) is not None:
                raise IdentityConfigCorruptionError(
                    "Identity/config staging wrote an authority pointer prematurely."
                )
            return _outcome(receipt, "imported")

        return self._run_transaction(
            operation,
            "Identity/config staging transaction failed.",
            immediate=True,
            cutover_lock=True,
        )

    def activate_identity_config(
        self,
        *,
        source_digest: str,
        vector_receipt: KnowledgeStateImportReceipt,
        activated_at: datetime | None = None,
    ) -> IdentityConfigImportReceipt:
        """Activate staged SQL only after a matching verified vector receipt."""

        _require_sha256(source_digest, "source_digest")
        timestamp = _aware_utc(activated_at or datetime.now(UTC), "activated_at")

        def operation(session: Session) -> IdentityConfigImportReceipt:
            _require_live_schema(session)
            staged = session.get(IdentityConfigImportRow, source_digest)
            if staged is None:
                raise IdentityConfigActivationError(
                    "No staged identity/config receipt matches the requested source."
                )
            receipt = _receipt_from_row(staged)
            _assert_vector_receipt(receipt, vector_receipt)

            active = session.get(IdentityConfigActiveImportRow, 1)
            if active is not None:
                if active.source_digest != source_digest:
                    raise IdentityConfigActivationError(
                        "A different identity/config receipt is already active."
                    )
                return receipt

            if len(list(session.scalars(select(IdentityConfigImportRow.source_digest)))) != 1:
                raise IdentityConfigActivationError(
                    "Identity/config staging contains more than one candidate receipt."
                )
            snapshot = _load_snapshot(session, receipt)
            _assert_snapshot_matches_receipt(snapshot, receipt)
            session.add(
                IdentityConfigActiveImportRow(
                    singleton_id=1,
                    source_digest=source_digest,
                    activated_at=timestamp,
                )
            )
            session.flush()
            return receipt

        return self._run_transaction(
            operation,
            "Identity/config activation transaction failed.",
            immediate=True,
            cutover_lock=True,
        )

    def active_identity_config_receipt(self) -> IdentityConfigImportReceipt | None:
        """Return the active SQL receipt, or ``None`` while import is only staged."""

        def operation(session: Session) -> IdentityConfigImportReceipt | None:
            _require_live_schema(session)
            active = session.get(IdentityConfigActiveImportRow, 1)
            if active is None:
                return None
            receipt = session.get(IdentityConfigImportRow, active.source_digest)
            if receipt is None:
                raise IdentityConfigCorruptionError(
                    "The identity/config authority pointer is orphaned."
                )
            return _receipt_from_row(receipt)

        return self._run_transaction(operation, "Identity/config receipt read failed.")

    def load_authority_state(self) -> IdentityConfigSqlAuthorityState:
        """Read active/staged/empty authority in one repeatable transaction."""

        def operation(session: Session) -> IdentityConfigSqlAuthorityState:
            _require_live_schema(session)
            active = session.get(IdentityConfigActiveImportRow, 1)
            rows = list(session.scalars(select(IdentityConfigImportRow)))
            if active is not None:
                if len(rows) != 1 or rows[0].source_digest != active.source_digest:
                    raise IdentityConfigCorruptionError(
                        "The active identity/config authority pointer is inconsistent."
                    )
                return IdentityConfigSqlAuthorityState(
                    status="active",
                    snapshot=_load_snapshot(session, _receipt_from_row(rows[0])),
                )
            if not rows:
                if _authority_data_exists(session):
                    raise IdentityConfigCorruptionError(
                        "Identity/config staging rows exist without a receipt."
                    )
                return IdentityConfigSqlAuthorityState(status="empty", snapshot=None)
            if len(rows) != 1:
                raise IdentityConfigCorruptionError(
                    "Identity/config staging contains more than one receipt."
                )
            receipt = _receipt_from_row(rows[0])
            _require_predecessor_receipts(session, receipt)
            snapshot = _load_snapshot(session, receipt)
            _assert_snapshot_matches_receipt(snapshot, receipt)
            return IdentityConfigSqlAuthorityState(status="staged", snapshot=snapshot)

        return self._run_transaction(
            operation,
            "Identity/config authority-state read failed.",
            repeatable_read=True,
        )

    def staged_identity_config_receipt(self) -> IdentityConfigImportReceipt | None:
        """Return the sole verified staged receipt before authority activation.

        This is the crash-resume read path. Active authority must be read through
        ``active_identity_config_receipt`` instead, and ambiguous or incomplete
        staging fails closed rather than selecting a receipt by row order.
        """

        snapshot = self.load_staged_snapshot()
        return snapshot.receipt if snapshot is not None else None

    def load_staged_snapshot(self) -> IdentityConfigSqlSnapshot | None:
        """Atomically load the sole verified inactive snapshot for crash resume."""

        def operation(session: Session) -> IdentityConfigSqlSnapshot | None:
            _require_live_schema(session)
            if session.get(IdentityConfigActiveImportRow, 1) is not None:
                raise IdentityConfigActivationError(
                    "Identity/config SQL authority is already active."
                )
            rows = list(session.scalars(select(IdentityConfigImportRow)))
            if not rows:
                if _authority_data_exists(session):
                    raise IdentityConfigCorruptionError(
                        "Identity/config staging rows exist without a receipt."
                    )
                return None
            if len(rows) != 1:
                raise IdentityConfigCorruptionError(
                    "Identity/config staging contains more than one receipt."
                )
            receipt = _receipt_from_row(rows[0])
            _require_predecessor_receipts(session, receipt)
            snapshot = _load_snapshot(session, receipt)
            _assert_snapshot_matches_receipt(snapshot, receipt)
            return snapshot

        return self._run_transaction(
            operation,
            "Identity/config staged snapshot read failed.",
            repeatable_read=True,
        )

    def load_active_snapshot(self) -> IdentityConfigSqlSnapshot | None:
        """Load detached current SQL authority without consulting legacy JSON."""

        def operation(session: Session) -> IdentityConfigSqlSnapshot | None:
            _require_live_schema(session)
            active = session.get(IdentityConfigActiveImportRow, 1)
            if active is None:
                return None
            receipt_row = session.get(IdentityConfigImportRow, active.source_digest)
            if receipt_row is None:
                raise IdentityConfigCorruptionError(
                    "The identity/config authority pointer is orphaned."
                )
            return _load_snapshot(session, _receipt_from_row(receipt_row))

        return self._run_transaction(
            operation,
            "Identity/config snapshot read failed.",
            repeatable_read=True,
        )

    def replace_active_snapshot(
        self,
        *,
        state: ValidatedIdentityConfigState,
        expected_relational_digest: str,
        updated_at: datetime | None = None,
    ) -> IdentityConfigSqlSnapshot:
        """Atomically replace current non-vector authority after cutover.

        The immutable import receipt remains historical proof of the cutover.
        Consequently, final verification is against the supplied live state,
        whose digest and counts may legitimately differ from that receipt.
        """

        if not isinstance(state, ValidatedIdentityConfigState):
            raise TypeError("state must be a ValidatedIdentityConfigState.")
        expected_digest = _require_sha256(
            expected_relational_digest,
            "expected relational digest",
        )
        timestamp = _aware_utc(updated_at or datetime.now(UTC), "updated_at")
        synthetic_receipt = state.create_receipt(
            schema_revision=IDENTITY_CONFIG_IMPORT_REVISION,
            completed_at=timestamp,
        )

        def operation(session: Session) -> IdentityConfigSqlSnapshot:
            _require_live_schema(session)
            _require_active_authority(session, for_update=True)
            current = _load_active_snapshot_in_session(session)
            _assert_reintroduced_resource_ids(session, current=current, state=state)
            prepared = _prepare_import(state, synthetic_receipt)
            if _snapshot_matches_state(current, state, prepared.bindings):
                return current
            if current.relational_digest != expected_digest:
                raise IdentityConfigSnapshotConflict(
                    "Identity/config authority changed before snapshot replacement."
                )

            _replace_state(session, state, prepared, timestamp)
            session.flush()
            replaced = _load_active_snapshot_in_session(session)
            _assert_snapshot_matches_state(replaced, state, prepared.bindings)
            return replaced

        return self._run_transaction(
            operation,
            "Identity/config snapshot replacement transaction failed.",
            immediate=True,
        )

    def replace_active_snapshot_with_cleanup_job(
        self,
        *,
        state: ValidatedIdentityConfigState,
        expected_relational_digest: str,
        resource_kind: CleanupResourceKind,
        resource_id: str,
        tenant_id: str,
        session_cutoff_ms: int | None,
        cleanup_job_id: str,
        updated_at: datetime | None = None,
    ) -> tuple[IdentityConfigSqlSnapshot, IdentityCleanupJob]:
        """Commit one cleanup intent and its identity mutation atomically.

        The returned job is already leased and has its identity stage marked.
        Cross-store workers can therefore resume at the application stage
        without ever observing an identity deletion that lacks durable intent.
        """

        if not isinstance(state, ValidatedIdentityConfigState):
            raise TypeError("state must be a ValidatedIdentityConfigState.")
        expected_digest = _require_sha256(
            expected_relational_digest,
            "expected relational digest",
        )
        timestamp = _aware_utc(updated_at or datetime.now(UTC), "updated_at")
        lease_expires_at = timestamp + timedelta(seconds=60)
        synthetic_receipt = state.create_receipt(
            schema_revision=IDENTITY_CONFIG_IMPORT_REVISION,
            completed_at=timestamp,
        )

        def operation(
            session: Session,
        ) -> tuple[IdentityConfigSqlSnapshot, IdentityCleanupJob]:
            _require_live_schema(session)
            _require_active_authority(session, for_update=True)
            current = _load_active_snapshot_in_session(session)
            cutoffs = _cleanup_cutoffs_and_removal_proof(
                current=current,
                state=state,
                resource_kind=resource_kind,
                resource_id=resource_id,
                tenant_id=tenant_id,
                session_cutoff_ms=session_cutoff_ms,
            )
            if resource_kind == "user":
                _assert_user_m9_deletion_allowed(
                    session,
                    user_id=resource_id,
                    tenant_id=tenant_id,
                )
            prepared = _prepare_import(state, synthetic_receipt)
            if current.relational_digest != expected_digest:
                raise IdentityConfigSnapshotConflict(
                    "Identity/config authority changed before cleanup staging."
                )

            job = create_cleanup_job_in_session(
                session,
                resource_kind=resource_kind,
                resource_id=resource_id,
                tenant_id=tenant_id,
                user_session_cutoffs=cutoffs,
                job_id=cleanup_job_id,
                requested_at=timestamp,
            )
            job = claim_cleanup_job_in_session(
                session,
                job_id=job.job_id,
                tenant_id=tenant_id,
                claimed_at=timestamp,
                lease_expires_at=lease_expires_at,
            )
            if not _snapshot_matches_state(current, state, prepared.bindings):
                if resource_kind == "tenant":
                    alert_rule_ids = [
                        record.id
                        for record in current.collections["alert_rules"]
                        if record.tenant_id == tenant_id
                    ]
                    if alert_rule_ids:
                        session.execute(
                            delete(AlertRuleRuntimeRow).where(
                                AlertRuleRuntimeRow.rule_id.in_(alert_rule_ids)
                            )
                        )
                _replace_state(session, state, prepared, timestamp)
                session.flush()
            replaced = _load_active_snapshot_in_session(session)
            _assert_snapshot_matches_state(replaced, state, prepared.bindings)
            job = mark_cleanup_stage_in_session(
                session,
                job_id=job.job_id,
                tenant_id=tenant_id,
                stage="identity",
                expected_attempt=job.attempt_count,
                completed_at=timestamp,
            )
            return replaced, job

        return self._run_transaction(
            operation,
            "Identity/config cleanup transaction failed.",
            immediate=True,
        )

    def write_provider_credential(
        self,
        credential: ProviderCredentialBundle,
        *,
        expected_binding_key_id: str | None,
        updated_at: datetime | None = None,
    ) -> ProviderCredentialBundle:
        """Compare-and-set metadata, ciphertext, and scoped binding atomically."""

        model = _provider_model_from_bundle(credential)
        _require_scoped_provider_ciphertext(credential.ciphertext)
        if model.status.strip().casefold() != "active":
            raise ProviderCredentialConflict(
                "A selected provider credential must have active metadata status."
            )
        if expected_binding_key_id is not None:
            _required_identifier(expected_binding_key_id, "expected_binding_key_id")
        timestamp = _aware_utc(updated_at or datetime.now(UTC), "updated_at")

        def operation(session: Session) -> ProviderCredentialBundle:
            _require_live_schema(session)
            _require_active_authority(session, for_update=True)
            _load_active_snapshot_in_session(session)
            if session.get(ProviderRow, credential.provider_id) is None:
                raise ProviderCredentialConflict("The provider credential references no provider.")
            if (
                credential.tenant_id is not None
                and session.get(TenantRow, credential.tenant_id) is None
            ):
                raise ProviderCredentialConflict("The provider credential references no tenant.")

            binding_key = (credential.provider_id, credential.binding.scope.key)
            binding_row = session.get(ProviderCredentialBindingRow, binding_key)
            current_key_id = binding_row.provider_key_id if binding_row is not None else None
            if current_key_id != expected_binding_key_id:
                raise ProviderCredentialConflict(
                    "The provider credential binding changed before this write."
                )

            key_row = session.get(ProviderKeyRow, credential.key_id)
            if key_row is None:
                next_ordinal = _next_available_ordinal(
                    set(session.scalars(select(ProviderKeyRow.ordinal)))
                )
                key_row = ProviderKeyRow(
                    id=credential.key_id,
                    ordinal=next_ordinal,
                    provider_id=credential.provider_id,
                    tenant_id=credential.tenant_id,
                    credential_scope=credential.binding.scope.key,
                    ciphertext=credential.ciphertext,
                    payload=dict(credential.metadata),
                )
                session.add(key_row)
            else:
                if (
                    key_row.provider_id != credential.provider_id
                    or key_row.tenant_id != credential.tenant_id
                    or key_row.credential_scope != credential.binding.scope.key
                ):
                    raise ProviderCredentialConflict(
                        "The provider key id is already bound to a different scope."
                    )
                other_binding = session.scalar(
                    select(ProviderCredentialBindingRow).where(
                        ProviderCredentialBindingRow.provider_key_id == credential.key_id,
                    )
                )
                if other_binding is not None and (
                    other_binding.provider_id != credential.provider_id
                    or other_binding.scope_key != credential.binding.scope.key
                ):
                    raise ProviderCredentialConflict(
                        "The provider key is already selected by a different binding."
                    )
                key_row.ciphertext = credential.ciphertext
                key_row.payload = dict(credential.metadata)

            if current_key_id is not None and current_key_id != credential.key_id:
                displaced_row = session.get(ProviderKeyRow, current_key_id)
                if displaced_row is None:
                    raise IdentityConfigCorruptionError(
                        "The displaced provider credential has no key row."
                    )
                displaced_model = _model_from_payload(
                    ProviderKeyImportRecord,
                    displaced_row.payload,
                    "provider key",
                )
                displaced_row.payload = displaced_model.model_copy(
                    update={"status": "Inactive"}
                ).model_dump(mode="json")

            # The ORM deliberately has no relationship property between the
            # key and binding rows. Materialize the composite FK target first,
            # while retaining the same surrounding transaction for rollback.
            session.flush()
            if binding_row is None:
                binding_row = ProviderCredentialBindingRow(
                    provider_id=credential.provider_id,
                    scope_key=credential.binding.scope.key,
                    tenant_id=credential.tenant_id,
                    provider_key_id=credential.key_id,
                    updated_at=timestamp,
                )
                session.add(binding_row)
            else:
                binding_row.provider_key_id = credential.key_id
                binding_row.tenant_id = credential.tenant_id
                binding_row.updated_at = timestamp
            session.flush()
            return _bundle_from_rows(key_row, binding_row)

        return self._run_transaction(
            operation,
            "Provider credential transaction failed.",
            immediate=True,
        )

    def resolve_provider_credential(
        self,
        *,
        provider_id: str,
        tenant_id: str | None,
    ) -> ProviderCredentialBundle | None:
        """Resolve a tenant credential first, then its platform fallback."""

        provider_id = _required_identifier(provider_id, "provider_id")
        if tenant_id is not None:
            _required_identifier(tenant_id, "tenant_id")

        def operation(session: Session) -> ProviderCredentialBundle | None:
            _require_live_schema(session)
            _require_active_authority(session)
            _load_active_snapshot_in_session(session)
            rows = list(
                session.scalars(
                    select(ProviderCredentialBindingRow).where(
                        ProviderCredentialBindingRow.provider_id == provider_id
                    )
                )
            )
            if tenant_id is not None:
                scoped_key_exists = session.scalar(
                    select(func.count())
                    .select_from(ProviderKeyRow)
                    .where(
                        ProviderKeyRow.provider_id == provider_id,
                        ProviderKeyRow.tenant_id == tenant_id,
                    )
                )
                tenant_binding_exists = any(row.tenant_id == tenant_id for row in rows)
                if scoped_key_exists and not tenant_binding_exists:
                    # Presence of an unhealthy/unselected tenant override is
                    # itself authoritative. It blocks platform fallback until
                    # every tenant-scoped key is explicitly removed or a valid
                    # replacement establishes the binding.
                    return None
            bindings = [
                ProviderCredentialBinding(
                    provider_id=row.provider_id,
                    key_id=row.provider_key_id,
                    tenant_id=row.tenant_id,
                )
                for row in rows
            ]
            try:
                selected = select_provider_credential_binding(
                    provider_id=provider_id,
                    tenant_id=tenant_id,
                    bindings=bindings,
                )
            except AmbiguousProviderCredentialBinding as exc:
                raise IdentityConfigCorruptionError(
                    "Provider credential bindings are ambiguous."
                ) from exc
            if selected is None:
                return None
            matching_rows = [
                row
                for row in rows
                if row.scope_key == selected.scope.key and row.provider_key_id == selected.key_id
            ]
            if len(matching_rows) != 1:
                raise IdentityConfigCorruptionError(
                    "The selected provider credential binding is inconsistent."
                )
            key_row = session.get(ProviderKeyRow, selected.key_id)
            if key_row is None:
                raise IdentityConfigCorruptionError(
                    "The selected provider credential has no key row."
                )
            return _bundle_from_rows(key_row, matching_rows[0])

        return self._run_transaction(
            operation,
            "Provider credential resolution failed.",
            repeatable_read=True,
        )

    def configuration_secret_keys_for_resource(
        self,
        *,
        resource_kind: ConfigurationSecretResourceKind,
        resource_id: str,
    ) -> tuple[str, ...]:
        """Resolve exact current secret ownership for a future atomic delete."""

        def operation(session: Session) -> tuple[str, ...]:
            _require_live_schema(session)
            _require_active_authority(session)
            snapshot = _load_active_snapshot_in_session(session)
            resources = _resource_index(snapshot.collections)
            keys = list(session.scalars(select(ConfigurationSecretRow.secret_key)))
            return configuration_secret_keys_owned_by(
                keys,
                resource_kind=resource_kind,
                resource_id=resource_id,
                resources=resources,
            )

        return self._run_transaction(
            operation,
            "Configuration-secret ownership read failed.",
            repeatable_read=True,
        )

    def _run_transaction(
        self,
        operation: Callable[[Session], T],
        failure: str,
        *,
        immediate: bool = False,
        cutover_lock: bool = False,
        repeatable_read: bool = False,
    ) -> T:
        with self._lock:
            if immediate and self.engine.dialect.name == "sqlite":
                return self._run_sqlite_immediate(operation, failure)
            session = self._sessions()
            try:
                with session.begin():
                    if repeatable_read and self.engine.dialect.name == "postgresql":
                        session.connection(
                            execution_options={"isolation_level": "REPEATABLE READ"}
                        )
                    if cutover_lock and self.engine.dialect.name == "postgresql":
                        session.execute(
                            text("select pg_advisory_xact_lock(:lock_id)"),
                            {"lock_id": _POSTGRES_CUTOVER_LOCK_ID},
                        )
                    return operation(session)
            except (IdentityConfigRepositoryError, IdentityCleanupRepositoryError):
                session.rollback()
                raise
            except (SQLAlchemyError, TypeError, ValueError) as exc:
                session.rollback()
                raise IdentityConfigSqlError(failure) from exc
            finally:
                session.close()

    def _run_sqlite_immediate(
        self,
        operation: Callable[[Session], T],
        failure: str,
    ) -> T:
        """Run one SQLite writer transaction with a database-wide CAS lock."""

        # ``connect_args={"autocommit": False}`` deliberately keeps normal
        # sessions inside PEP-249 transactions.  Temporarily enter explicit
        # transaction mode on this dedicated connection so BEGIN IMMEDIATE is
        # the first database statement and reserves the writer slot before the
        # compare-and-set read.  A process-local lock alone cannot protect two
        # repository/engine instances pointing at the same SQLite file.
        connection = self.engine.connect()
        dbapi_connection = connection.connection.driver_connection
        previous_autocommit = dbapi_connection.autocommit
        session: Session | None = None
        try:
            dbapi_connection.commit()
            dbapi_connection.autocommit = True
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            session = self._sessions(bind=connection)
            result = operation(session)
            session.flush()
            connection.exec_driver_sql("COMMIT")
            return result
        except (IdentityConfigRepositoryError, IdentityCleanupRepositoryError):
            if dbapi_connection.in_transaction:
                connection.exec_driver_sql("ROLLBACK")
            raise
        except (SQLAlchemyError, TypeError, ValueError) as exc:
            if dbapi_connection.in_transaction:
                connection.exec_driver_sql("ROLLBACK")
            raise IdentityConfigSqlError(failure) from exc
        finally:
            if session is not None:
                session.close()
            # Clear SQLAlchemy's autobegin bookkeeping after the explicit SQL
            # COMMIT/ROLLBACK before restoring the pool's normal connection
            # mode.
            if connection.in_transaction():
                connection.rollback()
            dbapi_connection.autocommit = previous_autocommit
            connection.close()


def _prepare_import(
    state: ValidatedIdentityConfigState,
    receipt: IdentityConfigImportReceipt,
) -> _PreparedImport:
    if not isinstance(state, ValidatedIdentityConfigState):
        raise TypeError("state must be a ValidatedIdentityConfigState.")
    if not isinstance(receipt, IdentityConfigImportReceipt):
        raise TypeError("receipt must be an IdentityConfigImportReceipt.")
    _assert_state_and_receipt(state, receipt)
    _validate_projected_uniques(state.collections)
    completed_at = _parse_utc(receipt.completed_at, "receipt completed_at")

    resources = _resource_index(state.collections)
    ciphertext_by_secret_key = _unique_pairs(
        state.configuration_secrets,
        "configuration secret",
    )
    parsed = parse_configuration_secret_keys(ciphertext_by_secret_key, resources)
    secrets = tuple(
        _prepare_secret(item, ciphertext_by_secret_key[item.storage_key], state.collections)
        for item in parsed
    )
    owner_keys = {
        (item.parsed.namespace.value, item.parsed.resource_id, _secret_qualifier(item.parsed))
        for item in secrets
    }
    if len(owner_keys) != len(secrets):
        raise IdentityConfigImportConflict(
            "Configuration secrets contain duplicate structured owners."
        )

    encrypted_keys = _unique_pairs(state.encrypted_provider_keys, "provider ciphertext")
    provider_records = state.collections["provider_keys"]
    provider_keys: list[_PreparedProviderKey] = []
    for ordinal, raw_model in enumerate(provider_records):
        if not isinstance(raw_model, ProviderKeyImportRecord):
            raise IdentityConfigImportConflict(
                "Provider-key state does not use the validated import model."
            )
        ciphertext = encrypted_keys.get(raw_model.id)
        if ciphertext is None:
            raise IdentityConfigImportConflict("Provider-key metadata has no matching ciphertext.")
        provider_keys.append(
            _PreparedProviderKey(model=raw_model, ciphertext=ciphertext, ordinal=ordinal)
        )
    if set(encrypted_keys) != {item.model.id for item in provider_keys}:
        raise IdentityConfigImportConflict("Provider-key ciphertext has no matching metadata row.")

    return _PreparedImport(
        secrets=secrets,
        provider_keys=tuple(provider_keys),
        bindings=_expected_provider_bindings(provider_records),
        completed_at=completed_at,
    )


def _assert_state_and_receipt(
    state: ValidatedIdentityConfigState,
    receipt: IdentityConfigImportReceipt,
) -> None:
    if set(state.collections) != set(MODEL_COLLECTIONS):
        raise IdentityConfigImportConflict(
            "Validated identity/config state has an incomplete collection set."
        )
    for name, model_type in MODEL_COLLECTIONS.items():
        if any(not isinstance(record, model_type) for record in state.collections[name]):
            raise IdentityConfigImportConflict(
                f"Validated identity/config collection {name!r} has an invalid model."
            )
    calculated_counts = _state_counts(state)
    relational_digest = _relational_digest(
        collections=state.collections,
        platform_settings=state.platform_settings,
        email_settings=state.email_settings,
        password_credentials=state.password_credentials,
        temporary_password_user_ids=state.temporary_password_user_ids,
        encrypted_provider_keys=state.encrypted_provider_keys,
        configuration_secrets=state.configuration_secrets,
    )
    knowledge_digest = knowledge_semantic_digest(
        state.knowledge_documents,
        state.knowledge_chunks,
    )
    expected = {
        "source_digest": state.source_digest,
        "source_version": SOURCE_STATE_VERSION,
        "target_version": TARGET_STATE_VERSION,
        "schema_revision": IDENTITY_CONFIG_IMPORT_REVISION,
        "prior_application_state_digest": state.prior_import_chain.application_state_digest,
        "prior_chat_state_digest": state.prior_import_chain.chat_state_digest,
        "relational_digest": relational_digest,
        "knowledge_digest": knowledge_digest,
        "collection_counts": calculated_counts,
    }
    actual = receipt.to_dict()
    actual.pop("completed_at", None)
    if actual != expected:
        raise IdentityConfigImportConflict(
            "Identity/config receipt does not match the validated state."
        )
    if state.relational_digest != relational_digest or state.knowledge_digest != knowledge_digest:
        raise IdentityConfigImportConflict(
            "Validated identity/config state digests are inconsistent."
        )
    if state.collection_counts != calculated_counts:
        raise IdentityConfigImportConflict(
            "Validated identity/config collection counts are inconsistent."
        )
    _require_sha256(state.source_digest, "state source digest")


def _state_counts(state: ValidatedIdentityConfigState) -> dict[str, int]:
    counts = {key: len(records) for key, records in state.collections.items()}
    counts.update(
        {
            "knowledge_documents": sum(
                len(records) for records in state.knowledge_documents.values()
            ),
            "knowledge_chunks": sum(len(records) for records in state.knowledge_chunks.values()),
            "password_credentials": len(state.password_credentials),
            "temporary_password_user_ids": len(state.temporary_password_user_ids),
            "encrypted_provider_keys": len(state.encrypted_provider_keys),
            "configuration_secrets": len(state.configuration_secrets),
            "platform_settings": 1,
            "email_settings": 1,
        }
    )
    return counts


def _validate_projected_uniques(
    collections: Mapping[str, tuple[BaseModel, ...]],
) -> None:
    _require_unique_projection(
        (record.slug for record in collections["tenants"]),
        "tenant slug",
    )
    _require_unique_projection(
        (
            record.custom_domain.casefold()
            for record in collections["tenants"]
            if record.custom_domain is not None
        ),
        "tenant custom domain",
    )
    _require_unique_projection(
        (record.email.strip().casefold() for record in collections["users"]),
        "normalized identity email",
    )
    _require_unique_projection(
        (record.token_hash for record in collections["scim_tokens"]),
        "SCIM token hash",
    )


def _require_unique_projection(values: Iterable[str], label: str) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise IdentityConfigImportConflict(f"Duplicate {label} is not allowed.")
        seen.add(value)


def _expected_provider_bindings(
    provider_records: tuple[BaseModel, ...],
) -> tuple[ProviderCredentialBinding, ...]:
    records_by_scope: dict[tuple[str, str], list[ProviderKeyImportRecord]] = {}
    for raw_model in provider_records:
        if not isinstance(raw_model, ProviderKeyImportRecord):
            raise IdentityConfigImportConflict(
                "Provider-key state does not use the validated import model."
            )
        binding = ProviderCredentialBinding(
            provider_id=raw_model.provider_id,
            key_id=raw_model.id,
            tenant_id=raw_model.tenant_id,
        )
        binding_key = (binding.provider_id, binding.scope.key)
        records_by_scope.setdefault(binding_key, []).append(raw_model)

    bindings: dict[tuple[str, str], ProviderCredentialBinding] = {}
    for binding_key, scoped_records in records_by_scope.items():
        active_records = [
            record
            for record in scoped_records
            if record.status.strip().casefold() == "active"
        ]
        if len(active_records) > 1:
            raise AmbiguousProviderCredentialBinding(
                "Multiple active provider keys target the same provider scope."
            )
        selected: ProviderKeyImportRecord | None = active_records[0] if active_records else None
        if selected is None:
            continue
        bindings[binding_key] = ProviderCredentialBinding(
            provider_id=selected.provider_id,
            key_id=selected.id,
            tenant_id=selected.tenant_id,
        )
    return tuple(bindings[key] for key in sorted(bindings))


def _resource_index(
    collections: Mapping[str, tuple[BaseModel, ...]],
) -> ConfigurationSecretResourceIndex:
    return ConfigurationSecretResourceIndex(
        connector_config_ids={record.id for record in collections["connector_configs"]},
        sso_config_ids={record.id for record in collections["sso_configs"]},
        knowledge_config_ids={record.id for record in collections["knowledge_configs"]},
        tool_config_ids={record.id for record in collections["tool_configs"]},
        user_ids={record.id for record in collections["users"]},
    )


def _assert_reintroduced_resource_ids(
    session: Session,
    *,
    current: IdentityConfigSqlSnapshot,
    state: ValidatedIdentityConfigState,
) -> None:
    """Fence tenant/knowledge ids in the same transaction that adds them."""

    for resource_kind, collection_name in (
        ("tenant", "tenants"),
        ("user", "users"),
        ("knowledge_config", "knowledge_configs"),
    ):
        current_ids = {record.id for record in current.collections[collection_name]}
        proposed_ids = {record.id for record in state.collections[collection_name]}
        for resource_id in sorted(proposed_ids - current_ids):
            assert_resource_recreation_allowed_in_session(
                session,
                resource_kind=resource_kind,
                resource_id=resource_id,
            )


def _cleanup_cutoffs_and_removal_proof(
    *,
    current: IdentityConfigSqlSnapshot,
    state: ValidatedIdentityConfigState,
    resource_kind: CleanupResourceKind,
    resource_id: str,
    tenant_id: str,
    session_cutoff_ms: int | None,
) -> dict[str, int]:
    """Derive cleanup cutoffs from the locked authoritative pre-delete view."""

    if resource_kind == "tenant":
        if resource_id != tenant_id:
            raise IdentityConfigImportConflict(
                "Tenant cleanup resource and tenant ids must match."
            )
        if type(session_cutoff_ms) is not int or not 0 <= session_cutoff_ms <= _MAX_SQL_BIGINT:
            raise IdentityConfigImportConflict(
                "Tenant cleanup requires one valid session cutoff."
            )
        current_tenant_ids = {record.id for record in current.collections["tenants"]}
        proposed_tenant_ids = {record.id for record in state.collections["tenants"]}
        if resource_id not in current_tenant_ids or resource_id in proposed_tenant_ids:
            raise IdentityConfigImportConflict(
                "Tenant cleanup must remove the exact current tenant."
            )
        if any(
            record.tenant_id == tenant_id
            for record in state.collections["users"]
        ):
            raise IdentityConfigImportConflict(
                "Tenant cleanup left tenant users in the proposed identity state."
            )
        return {
            record.id: session_cutoff_ms
            for record in current.collections["users"]
            if record.tenant_id == tenant_id
        }

    if resource_kind == "knowledge_config":
        if session_cutoff_ms is not None:
            raise IdentityConfigImportConflict(
                "Knowledge cleanup cannot capture user session cutoffs."
            )
        current_matches = [
            record
            for record in current.collections["knowledge_configs"]
            if record.id == resource_id and record.tenant_id == tenant_id
        ]
        proposed_ids = {record.id for record in state.collections["knowledge_configs"]}
        if len(current_matches) != 1 or resource_id in proposed_ids:
            raise IdentityConfigImportConflict(
                "Knowledge cleanup must remove the exact tenant-bound configuration."
            )
        return {}

    if resource_kind == "user":
        if type(session_cutoff_ms) is not int or not 0 <= session_cutoff_ms <= _MAX_SQL_BIGINT:
            raise IdentityConfigImportConflict(
                "User cleanup requires one valid session cutoff."
            )
        current_matches = [
            record
            for record in current.collections["users"]
            if record.id == resource_id and record.tenant_id == tenant_id
        ]
        proposed_ids = {record.id for record in state.collections["users"]}
        if len(current_matches) != 1 or resource_id in proposed_ids:
            raise IdentityConfigImportConflict(
                "User cleanup must remove the exact tenant-bound identity."
            )
        return {resource_id: session_cutoff_ms}

    raise IdentityConfigImportConflict("Unknown identity cleanup resource kind.")


def _assert_user_m9_deletion_allowed(
    session: Session,
    *,
    user_id: str,
    tenant_id: str,
) -> None:
    """Lock and prove permanent-user M9 cleanup cannot strand work."""

    memberships = list(
        session.scalars(
            select(MatterMembershipRow)
            .where(
                MatterMembershipRow.tenant_id == tenant_id,
                MatterMembershipRow.member_user_id == user_id,
            )
            .with_for_update()
        )
    )
    for membership in memberships:
        member_count = session.scalar(
            select(func.count())
            .select_from(MatterMembershipRow)
            .where(
                MatterMembershipRow.tenant_id == tenant_id,
                MatterMembershipRow.matter_id == membership.matter_id,
            )
        )
        if not isinstance(member_count, int) or member_count <= 1:
            raise IdentityConfigImportConflict(
                "Permanent user deletion would leave a matter without a member."
            )

    pending_request = session.scalar(
        select(MatterDeletionJobRow.matter_id)
        .where(
            MatterDeletionJobRow.tenant_id == tenant_id,
            MatterDeletionJobRow.requested_by_user_id == user_id,
            MatterDeletionJobRow.status != "complete",
        )
        .limit(1)
        .with_for_update()
    )
    if pending_request is not None:
        raise IdentityConfigImportConflict(
            "Permanent user deletion cannot strand an incomplete matter deletion request."
        )


def _prepare_secret(
    parsed: ParsedConfigurationSecretKey,
    ciphertext: str,
    collections: Mapping[str, tuple[BaseModel, ...]],
) -> _PreparedSecret:
    collection_name = {
        ConfigurationSecretResourceKind.CONNECTOR_CONFIG: "connector_configs",
        ConfigurationSecretResourceKind.SSO_CONFIG: "sso_configs",
        ConfigurationSecretResourceKind.KNOWLEDGE_CONFIG: "knowledge_configs",
        ConfigurationSecretResourceKind.TOOL_CONFIG: "tool_configs",
    }.get(parsed.resource_kind)
    tenant_id: str | None = None
    if collection_name is not None:
        owner = next(
            (record for record in collections[collection_name] if record.id == parsed.resource_id),
            None,
        )
        if owner is None:
            raise IdentityConfigImportConflict("Configuration secret references an unknown owner.")
        tenant_id = owner.tenant_id
    elif parsed.resource_kind is not ConfigurationSecretResourceKind.PLATFORM_EMAIL:
        raise IdentityConfigImportConflict("Configuration secret has an unsupported owner type.")

    if parsed.subject_user_id is not None:
        user = next(
            (record for record in collections["users"] if record.id == parsed.subject_user_id),
            None,
        )
        if user is None or user.tenant_id != tenant_id:
            raise IdentityConfigImportConflict(
                "A per-user configuration secret is outside its owner's tenant."
            )
    return _PreparedSecret(parsed=parsed, tenant_id=tenant_id, ciphertext=ciphertext)


def _insert_state(
    session: Session,
    state: ValidatedIdentityConfigState,
    receipt: IdentityConfigImportReceipt,
    prepared: _PreparedImport,
) -> None:
    provider_keys_by_id = {item.model.id: item for item in prepared.provider_keys}
    for name in MODEL_COLLECTIONS:
        if name == "provider_keys":
            for item in prepared.provider_keys:
                session.add(
                    ProviderKeyRow(
                        id=item.model.id,
                        ordinal=item.ordinal,
                        provider_id=item.model.provider_id,
                        tenant_id=item.model.tenant_id,
                        credential_scope=provider_scope_key(item.model.tenant_id),
                        ciphertext=item.ciphertext,
                        payload=item.model.model_dump(mode="json"),
                    )
                )
            # Flush dependency layers inside the same outer transaction. The
            # ORM models intentionally expose no relationships, so relying on
            # unit-of-work relationship sorting would let child tables race
            # their already-pending parent inserts on SQLite.
            session.flush()
            continue
        for ordinal, record in enumerate(state.collections[name]):
            session.add(_row_from_model(name, record, ordinal))
        session.flush()

    for binding in prepared.bindings:
        if binding.key_id not in provider_keys_by_id:
            raise IdentityConfigImportConflict("Provider binding has no key metadata.")
        session.add(
            ProviderCredentialBindingRow(
                provider_id=binding.provider_id,
                scope_key=binding.scope.key,
                tenant_id=binding.tenant_id,
                provider_key_id=binding.key_id,
                updated_at=prepared.completed_at,
            )
        )
    session.flush()

    session.add(
        PlatformSettingsRow(
            singleton_id=1,
            payload=state.platform_settings.model_dump(mode="json"),
        )
    )
    session.add(
        EmailSettingsRow(
            singleton_id=1,
            payload=state.email_settings.model_dump(mode="json"),
        )
    )
    password_hashes = _unique_pairs(state.password_credentials, "password credential")
    temporary_ids = set(state.temporary_password_user_ids)
    for user_id, password_hash in password_hashes.items():
        session.add(
            PasswordCredentialRow(
                user_id=user_id,
                password_hash=password_hash,
                temporary=user_id in temporary_ids,
            )
        )
    for secret in prepared.secrets:
        session.add(
            ConfigurationSecretRow(
                secret_key=secret.parsed.storage_key,
                namespace=secret.parsed.namespace.value,
                resource_id=secret.parsed.resource_id,
                qualifier=_secret_qualifier(secret.parsed),
                tenant_id=secret.tenant_id,
                ciphertext=secret.ciphertext,
            )
        )
    session.add(_receipt_row(receipt, prepared.completed_at))


def _replace_state(
    session: Session,
    state: ValidatedIdentityConfigState,
    prepared: _PreparedImport,
    updated_at: datetime,
) -> None:
    """Reconcile live rows by id without cascading through unchanged parents."""

    for row_type in (
        ProviderCredentialBindingRow,
        PasswordCredentialRow,
        ConfigurationSecretRow,
    ):
        for row in session.scalars(select(row_type)):
            session.delete(row)
    session.flush()

    existing = {
        name: list(session.scalars(select(row_type)))
        for name, row_type in _COLLECTION_ROW_TYPES.items()
    }
    _park_existing_unique_values(session, existing, state.collections)

    provider_keys = {item.model.id: item for item in prepared.provider_keys}
    for name in _UPSERT_COLLECTION_NAMES:
        rows_by_id = {row.id: row for row in existing[name]}
        for ordinal, record in enumerate(state.collections[name]):
            replacement = _replacement_row(name, record, ordinal, provider_keys)
            current = rows_by_id.get(record.id)
            if current is None:
                session.add(replacement)
            else:
                _copy_non_primary_key_columns(current, replacement)
        session.flush()

    target_ids = {
        name: {record.id for record in state.collections[name]} for name in MODEL_COLLECTIONS
    }
    for name in _DELETE_COLLECTION_NAMES:
        for row in existing[name]:
            if row.id not in target_ids[name]:
                session.delete(row)
        session.flush()

    platform_row = session.get(PlatformSettingsRow, 1)
    email_row = session.get(EmailSettingsRow, 1)
    if platform_row is None or email_row is None:
        raise IdentityConfigCorruptionError(
            "Identity/config singleton settings disappeared during replacement."
        )
    platform_row.payload = state.platform_settings.model_dump(mode="json")
    email_row.payload = state.email_settings.model_dump(mode="json")

    password_hashes = _unique_pairs(state.password_credentials, "password credential")
    temporary_ids = set(state.temporary_password_user_ids)
    for user_id, password_hash in password_hashes.items():
        session.add(
            PasswordCredentialRow(
                user_id=user_id,
                password_hash=password_hash,
                temporary=user_id in temporary_ids,
            )
        )
    for secret in prepared.secrets:
        session.add(
            ConfigurationSecretRow(
                secret_key=secret.parsed.storage_key,
                namespace=secret.parsed.namespace.value,
                resource_id=secret.parsed.resource_id,
                qualifier=_secret_qualifier(secret.parsed),
                tenant_id=secret.tenant_id,
                ciphertext=secret.ciphertext,
            )
        )
    session.flush()

    for binding in prepared.bindings:
        session.add(
            ProviderCredentialBindingRow(
                provider_id=binding.provider_id,
                scope_key=binding.scope.key,
                tenant_id=binding.tenant_id,
                provider_key_id=binding.key_id,
                updated_at=updated_at,
            )
        )


def _park_existing_unique_values(
    session: Session,
    existing: Mapping[str, list[Any]],
    collections: Mapping[str, tuple[BaseModel, ...]],
) -> None:
    for name, rows in existing.items():
        occupied_ordinals = {row.ordinal for row in rows}
        occupied_ordinals.update(range(len(collections[name])))
        candidate = 0
        for row in sorted(rows, key=lambda item: item.id):
            while candidate in occupied_ordinals:
                candidate += 1
            if candidate > _MAX_SQL_INTEGER:
                raise IdentityConfigCorruptionError(
                    f"Stored {name} ordinals leave no safe replacement values."
                )
            row.ordinal = candidate
            occupied_ordinals.add(candidate)
            candidate += 1

    tenant_rows = existing["tenants"]
    occupied_slugs = {row.slug for row in tenant_rows}
    occupied_slugs.update(record.slug for record in collections["tenants"])
    for row in sorted(tenant_rows, key=lambda item: item.id):
        row.slug = _parking_value(
            "tenant-slug",
            row.id,
            occupied_slugs,
            lambda digest: f"replace-{digest[:48]}",
        )
        row.custom_domain = None

    user_rows = existing["users"]
    occupied_emails = {row.email_normalized for row in user_rows}
    occupied_emails.update(record.email.strip().casefold() for record in collections["users"])
    for row in sorted(user_rows, key=lambda item: item.id):
        row.email_normalized = _parking_value(
            "identity-email",
            row.id,
            occupied_emails,
            lambda digest: f"replace-{digest[:48]}@invalid.example",
        )

    scim_rows = existing["scim_tokens"]
    occupied_hashes = {row.token_hash for row in scim_rows}
    occupied_hashes.update(record.token_hash for record in collections["scim_tokens"])
    for row in sorted(scim_rows, key=lambda item: item.id):
        row.token_hash = _parking_value(
            "scim-token",
            row.id,
            occupied_hashes,
            lambda digest: digest,
        )
    session.flush()


def _parking_value(
    namespace: str,
    record_id: str,
    occupied: set[str],
    render: Callable[[str], str],
) -> str:
    counter = 0
    while True:
        digest = hashlib.sha256(f"{namespace}\0{record_id}\0{counter}".encode("utf-8")).hexdigest()
        candidate = render(digest)
        if candidate not in occupied:
            occupied.add(candidate)
            return candidate
        counter += 1


def _next_available_ordinal(occupied: set[int]) -> int:
    candidate = 0
    while candidate in occupied:
        candidate += 1
    if candidate > _MAX_SQL_INTEGER:
        raise IdentityConfigCorruptionError("Provider-key ordinals have no available value.")
    return candidate


def _replacement_row(
    name: str,
    record: BaseModel,
    ordinal: int,
    provider_keys: Mapping[str, _PreparedProviderKey],
) -> Any:
    if name != "provider_keys":
        return _row_from_model(name, record, ordinal)
    item = provider_keys.get(record.id)
    if item is None:
        raise IdentityConfigImportConflict("Provider-key replacement has no ciphertext.")
    return ProviderKeyRow(
        id=item.model.id,
        ordinal=ordinal,
        provider_id=item.model.provider_id,
        tenant_id=item.model.tenant_id,
        credential_scope=provider_scope_key(item.model.tenant_id),
        ciphertext=item.ciphertext,
        payload=item.model.model_dump(mode="json"),
    )


def _copy_non_primary_key_columns(current: Any, replacement: Any) -> None:
    for column in replacement.__table__.columns:
        if not column.primary_key:
            setattr(current, column.name, getattr(replacement, column.name))


def _row_from_model(name: str, record: BaseModel, ordinal: int) -> Any:
    payload = record.model_dump(mode="json")
    if name == "tenants":
        return TenantRow(
            id=record.id,
            ordinal=ordinal,
            slug=record.slug,
            custom_domain=record.custom_domain,
            payload=payload,
        )
    if name == "users":
        return IdentityUserRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            email_normalized=record.email.strip().casefold(),
            role=record.role.value,
            active=record.active,
            payload=payload,
        )
    if name == "groups":
        return IdentityGroupRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            default_group=record.default_group,
            payload=payload,
        )
    if name == "providers":
        return ProviderRow(
            id=record.id,
            ordinal=ordinal,
            kind=record.kind,
            connected=record.connected,
            payload=payload,
        )
    if name == "models":
        return ModelConfigRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            provider_id=record.provider_id,
            platform_enabled=record.platform_enabled,
            payload=payload,
        )
    if name == "connectors":
        return ConnectorRow(
            id=record.id,
            ordinal=ordinal,
            platform_enabled=record.platform_enabled,
            tenant_enabled=record.tenant_enabled,
            payload=payload,
        )
    if name == "connector_configs":
        return ConnectorConfigRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            connector_id=record.connector_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "sso_configs":
        return SsoConfigRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "knowledge_configs":
        return KnowledgeConfigRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            connector_config_id=record.connector_config_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "tool_configs":
        return ToolConfigRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "prompt_templates":
        return PromptTemplateRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "skill_files":
        return SkillFileRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "security_alerts":
        return SecurityAlertRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            acknowledged=record.acknowledged,
            created_at=_aware_utc(record.created_at, "security alert created_at"),
            payload=payload,
        )
    if name == "agent_runs":
        return AgentRunRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            status=record.status,
            payload=payload,
        )
    if name == "automations":
        return AutomationRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "companion_memories":
        return CompanionMemoryRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            profile_id=record.profile_id,
            payload=payload,
        )
    if name == "content_filters":
        return ContentFilterRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            builtin=record.builtin,
            payload=payload,
        )
    if name == "user_memories":
        return UserMemoryRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            owner_user_id=record.owner_user_id,
            active=record.active,
            payload=payload,
        )
    if name == "tenant_memory_policies":
        return TenantMemoryPolicyRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "tenant_retention_policies":
        return TenantRetentionPolicyRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "user_memory_settings":
        return UserMemorySettingsRow(
            id=record.id,
            ordinal=ordinal,
            user_id=record.user_id,
            enabled=record.enabled,
            payload=payload,
        )
    if name == "scim_tokens":
        return ScimTokenRow(
            id=record.id,
            ordinal=ordinal,
            tenant_id=record.tenant_id,
            token_hash=record.token_hash,
            revoked_at=record.revoked_at,
            payload=payload,
        )
    if name == "alert_rules":
        return AlertRuleConfigRow(
            id=record.id,
            ordinal=ordinal,
            scope=record.scope,
            tenant_id=record.tenant_id,
            enabled=record.enabled,
            payload=payload,
        )
    raise IdentityConfigImportConflict(f"No SQL row mapping exists for {name!r}.")


def _load_snapshot(
    session: Session,
    receipt: IdentityConfigImportReceipt,
) -> IdentityConfigSqlSnapshot:
    collections: dict[str, tuple[BaseModel, ...]] = {}
    for name, row_type in _COLLECTION_ROW_TYPES.items():
        rows = list(session.scalars(select(row_type).order_by(row_type.ordinal, row_type.id)))
        models: list[BaseModel] = []
        for row in rows:
            model = _model_from_row(name, row)
            _assert_row_projection(name, row, model)
            models.append(model)
        collections[name] = tuple(models)

    platform_row = session.get(PlatformSettingsRow, 1)
    email_row = session.get(EmailSettingsRow, 1)
    if platform_row is None or email_row is None:
        raise IdentityConfigCorruptionError("Identity/config singleton settings are incomplete.")
    platform_settings = _model_from_payload(PlatformSettings, platform_row.payload, "platform")
    email_settings = _model_from_payload(EmailSettings, email_row.payload, "email")

    password_rows = list(
        session.scalars(select(PasswordCredentialRow).order_by(PasswordCredentialRow.user_id))
    )
    password_credentials = tuple((row.user_id, row.password_hash) for row in password_rows)
    temporary_ids = tuple(sorted(row.user_id for row in password_rows if row.temporary))
    provider_rows = list(
        session.scalars(select(ProviderKeyRow).order_by(ProviderKeyRow.ordinal, ProviderKeyRow.id))
    )
    encrypted_keys = tuple((row.id, row.ciphertext) for row in provider_rows)

    secret_rows = list(
        session.scalars(select(ConfigurationSecretRow).order_by(ConfigurationSecretRow.secret_key))
    )
    configuration_secrets = tuple((row.secret_key, row.ciphertext) for row in secret_rows)
    _assert_secret_rows(secret_rows, collections)
    provider_bindings = _assert_provider_binding_rows(session, provider_rows)
    try:
        expected_bindings = _expected_provider_bindings(collections["provider_keys"])
    except (AmbiguousProviderCredentialBinding, IdentityConfigImportConflict) as exc:
        raise IdentityConfigCorruptionError(
            "Stored provider-key metadata has ambiguous active scopes."
        ) from exc
    if provider_bindings != expected_bindings:
        raise IdentityConfigCorruptionError(
            "Provider credential bindings do not match active key metadata."
        )

    return IdentityConfigSqlSnapshot(
        receipt=receipt,
        collections=MappingProxyType(collections),
        platform_settings=platform_settings,
        email_settings=email_settings,
        password_credentials=password_credentials,
        temporary_password_user_ids=temporary_ids,
        encrypted_provider_keys=encrypted_keys,
        configuration_secrets=configuration_secrets,
        provider_bindings=provider_bindings,
    )


def _load_active_snapshot_in_session(session: Session) -> IdentityConfigSqlSnapshot:
    active = session.get(IdentityConfigActiveImportRow, 1)
    if active is None:
        raise IdentityConfigActivationError("Identity/config SQL authority is not active.")
    receipt = session.get(IdentityConfigImportRow, active.source_digest)
    if receipt is None:
        raise IdentityConfigCorruptionError("The identity/config authority pointer is orphaned.")
    return _load_snapshot(session, _receipt_from_row(receipt))


def _model_from_row(name: str, row: Any) -> BaseModel:
    model_type = MODEL_COLLECTIONS[name]
    return _model_from_payload(model_type, row.payload, name)


def _model_from_payload(
    model_type: type[BaseModel],
    payload: Any,
    label: str,
) -> BaseModel:
    if not isinstance(payload, Mapping):
        raise IdentityConfigCorruptionError(f"Stored {label} payload is not an object.")
    canonical_payload = dict(payload)
    if model_type is Group:
        permissions = canonical_payload.get("permissions")
        missing_permissions = (
            {
                key: value
                for key, value in DEFAULT_GROUP_PERMISSIONS.items()
                if key not in permissions
            }
            if isinstance(permissions, Mapping)
            else {}
        )
        if missing_permissions:
            # Group permission keys are added over time, and rows written before
            # a key existed omit it. Backfill only the platform default for the
            # missing keys, which is off for every opt-in capability, so the
            # accommodation stays fail-closed. Unknown keys are still rejected
            # by the canonical comparison below.
            canonical_payload["permissions"] = {**permissions, **missing_permissions}
    if model_type is PlatformSettings and "downstream_api_enabled" not in canonical_payload:
        # The downstream API master policy was added after the identity/config
        # SQL authority shipped. Accept only this exact legacy omission and
        # preserve the deployment's previously available governed API surface.
        # New platform settings still default off; all other canonical checks
        # remain fail-closed.
        canonical_payload["downstream_api_enabled"] = True
    if model_type is PlatformSettings and "memory_enabled" not in canonical_payload:
        # Personalization memory shipped after the identity/config SQL
        # authority. Accept only this exact legacy omission; the feature
        # defaults off, so the backfill cannot widen a deployment's surface.
        canonical_payload["memory_enabled"] = False
    if model_type is TenantRetentionPolicy:
        # Tagging capabilities ship incrementally, after the first retention
        # policies were saved. Accept only these exact legacy omissions; every
        # capability defaults off, so the backfills cannot widen a
        # deployment's surface.
        for tagging_field in ("attachment_tagging_enabled", "subject_tagging_enabled"):
            canonical_payload.setdefault(tagging_field, False)
    if model_type is ToolConfig and "owner_user_id" not in canonical_payload:
        # User-authored tool ownership shipped after the identity/config SQL
        # authority. Rows written before the field existed are admin-created
        # tools, which leave ownership unset. Accept only this exact legacy
        # omission; unowned tools keep their existing tenant-wide semantics,
        # so the backfill cannot widen access.
        canonical_payload["owner_user_id"] = None
    if model_type is User:
        # Access requests shipped after SQL identity authority. Existing user
        # rows legitimately omit these fields; backfill only their inert
        # defaults so old accounts remain loadable without inventing a request
        # or changing authentication state. Unknown or malformed fields still
        # fail the canonical comparison below.
        for field_name in (
            "first_name",
            "last_name",
            "access_request_status",
            "access_requested_at",
            "access_reviewed_at",
        ):
            canonical_payload.setdefault(field_name, None)
    try:
        model = model_type.model_validate(canonical_payload)
    except ValidationError as exc:
        raise IdentityConfigCorruptionError(f"Stored {label} payload is invalid.") from exc
    if _canonical_json(model.model_dump(mode="json")) != _canonical_json(canonical_payload):
        raise IdentityConfigCorruptionError(f"Stored {label} payload is not canonical.")
    return model


def _assert_row_projection(name: str, row: Any, model: BaseModel) -> None:
    expected: dict[str, Any]
    if name == "tenants":
        expected = {"id": model.id, "slug": model.slug, "custom_domain": model.custom_domain}
    elif name == "users":
        expected = {
            "id": model.id,
            "tenant_id": model.tenant_id,
            "email_normalized": model.email.strip().casefold(),
            "role": model.role.value,
            "active": model.active,
        }
    elif name == "groups":
        expected = {
            "id": model.id,
            "tenant_id": model.tenant_id,
            "default_group": model.default_group,
        }
    elif name == "providers":
        expected = {"id": model.id, "kind": model.kind, "connected": model.connected}
    elif name == "models":
        expected = {
            "id": model.id,
            "tenant_id": model.tenant_id,
            "provider_id": model.provider_id,
            "platform_enabled": model.platform_enabled,
        }
    elif name == "provider_keys":
        expected = {
            "id": model.id,
            "provider_id": model.provider_id,
            "tenant_id": model.tenant_id,
            "credential_scope": provider_scope_key(model.tenant_id),
        }
    elif name == "connectors":
        expected = {
            "id": model.id,
            "platform_enabled": model.platform_enabled,
            "tenant_enabled": model.tenant_enabled,
        }
    elif name == "connector_configs":
        expected = {
            "id": model.id,
            "tenant_id": model.tenant_id,
            "connector_id": model.connector_id,
            "enabled": model.enabled,
        }
    elif name in {"sso_configs", "tool_configs", "prompt_templates", "skill_files"}:
        expected = {"id": model.id, "tenant_id": model.tenant_id, "enabled": model.enabled}
    elif name == "knowledge_configs":
        expected = {
            "id": model.id,
            "tenant_id": model.tenant_id,
            "connector_config_id": model.connector_config_id,
            "enabled": model.enabled,
        }
    elif name == "security_alerts":
        expected = {
            "id": model.id,
            "tenant_id": model.tenant_id,
            "acknowledged": model.acknowledged,
            "created_at": _aware_utc(model.created_at, "security alert created_at"),
        }
    elif name == "agent_runs":
        expected = {"id": model.id, "tenant_id": model.tenant_id, "status": model.status}
    elif name == "automations":
        expected = {"id": model.id, "tenant_id": model.tenant_id, "enabled": model.enabled}
    elif name == "companion_memories":
        expected = {"id": model.id, "tenant_id": model.tenant_id, "profile_id": model.profile_id}
    elif name == "content_filters":
        expected = {"id": model.id, "tenant_id": model.tenant_id, "builtin": model.builtin}
    elif name == "user_memories":
        expected = {
            "id": model.id,
            "tenant_id": model.tenant_id,
            "owner_user_id": model.owner_user_id,
            "active": model.active,
        }
    elif name == "tenant_memory_policies":
        expected = {"id": model.id, "tenant_id": model.tenant_id, "enabled": model.enabled}
    elif name == "tenant_retention_policies":
        expected = {"id": model.id, "tenant_id": model.tenant_id, "enabled": model.enabled}
    elif name == "user_memory_settings":
        expected = {"id": model.id, "user_id": model.user_id, "enabled": model.enabled}
    elif name == "scim_tokens":
        expected = {
            "id": model.id,
            "tenant_id": model.tenant_id,
            "token_hash": model.token_hash,
            "revoked_at": model.revoked_at,
        }
    elif name == "alert_rules":
        expected = {
            "id": model.id,
            "scope": model.scope,
            "tenant_id": model.tenant_id,
            "enabled": model.enabled,
        }
    else:
        raise IdentityConfigCorruptionError(f"No projection validation exists for {name!r}.")
    if any(getattr(row, key) != value for key, value in expected.items()):
        raise IdentityConfigCorruptionError(f"Stored {name} projection does not match its payload.")


def _assert_secret_rows(
    rows: list[ConfigurationSecretRow],
    collections: Mapping[str, tuple[BaseModel, ...]],
) -> None:
    resources = _resource_index(collections)
    parsed = {
        item.storage_key: item
        for item in parse_configuration_secret_keys((row.secret_key for row in rows), resources)
    }
    for row in rows:
        prepared = _prepare_secret(parsed[row.secret_key], row.ciphertext, collections)
        if (
            row.namespace != prepared.parsed.namespace.value
            or row.resource_id != prepared.parsed.resource_id
            or row.qualifier != _secret_qualifier(prepared.parsed)
            or row.tenant_id != prepared.tenant_id
        ):
            raise IdentityConfigCorruptionError(
                "Stored configuration-secret ownership is inconsistent."
            )


def _assert_provider_binding_rows(
    session: Session,
    provider_rows: list[ProviderKeyRow],
) -> tuple[ProviderCredentialBinding, ...]:
    provider_by_id = {row.id: row for row in provider_rows}
    bindings = list(session.scalars(select(ProviderCredentialBindingRow)))
    seen: set[tuple[str, str]] = set()
    for row in bindings:
        key = (row.provider_id, row.scope_key)
        if key in seen:
            raise IdentityConfigCorruptionError("Provider credential bindings are ambiguous.")
        seen.add(key)
        provider_key = provider_by_id.get(row.provider_key_id)
        if (
            provider_key is None
            or provider_key.provider_id != row.provider_id
            or provider_key.tenant_id != row.tenant_id
            or provider_key.credential_scope != row.scope_key
            or row.scope_key != provider_scope_key(row.tenant_id)
        ):
            raise IdentityConfigCorruptionError(
                "Provider credential binding does not match its key metadata."
            )
    return tuple(
        sorted(
            (
                ProviderCredentialBinding(
                    provider_id=row.provider_id,
                    key_id=row.provider_key_id,
                    tenant_id=row.tenant_id,
                )
                for row in bindings
            ),
            key=lambda item: (item.provider_id, item.scope.key),
        )
    )


def _assert_staged_snapshot(
    snapshot: IdentityConfigSqlSnapshot,
    state: ValidatedIdentityConfigState,
    receipt: IdentityConfigImportReceipt,
) -> None:
    if not _receipt_values_equal(snapshot.receipt, receipt):
        raise IdentityConfigImportConflict("The staged receipt changed during import.")
    actual_digest = _snapshot_relational_digest(snapshot)
    if actual_digest != receipt.relational_digest:
        raise IdentityConfigImportConflict(
            "The staged relational rows do not match their receipt digest."
        )
    if _snapshot_relational_counts(snapshot) != _relational_receipt_counts(receipt):
        raise IdentityConfigImportConflict(
            "The staged relational rows do not match their receipt counts."
        )
    if actual_digest != state.relational_digest:
        raise IdentityConfigImportConflict(
            "The staged relational rows do not match the validated state."
        )
    if snapshot.provider_bindings != _expected_provider_bindings(
        state.collections["provider_keys"]
    ):
        raise IdentityConfigImportConflict(
            "The staged provider bindings do not match the validated state."
        )


def _assert_snapshot_matches_receipt(
    snapshot: IdentityConfigSqlSnapshot,
    receipt: IdentityConfigImportReceipt,
) -> None:
    if _snapshot_relational_digest(snapshot) != receipt.relational_digest:
        raise IdentityConfigActivationError(
            "Staged SQL rows no longer match the relational receipt digest."
        )
    if _snapshot_relational_counts(snapshot) != _relational_receipt_counts(receipt):
        raise IdentityConfigActivationError(
            "Staged SQL rows no longer match the relational receipt counts."
        )


def _snapshot_matches_state(
    snapshot: IdentityConfigSqlSnapshot,
    state: ValidatedIdentityConfigState,
    bindings: tuple[ProviderCredentialBinding, ...],
) -> bool:
    return (
        _snapshot_relational_digest(snapshot) == state.relational_digest
        and _snapshot_relational_counts(snapshot) == _relational_state_counts(state)
        and snapshot.provider_bindings == bindings
    )


def _assert_snapshot_matches_state(
    snapshot: IdentityConfigSqlSnapshot,
    state: ValidatedIdentityConfigState,
    bindings: tuple[ProviderCredentialBinding, ...],
) -> None:
    if not _snapshot_matches_state(snapshot, state, bindings):
        raise IdentityConfigCorruptionError(
            "Replaced identity/config rows do not match the supplied live state."
        )


def _snapshot_relational_digest(snapshot: IdentityConfigSqlSnapshot) -> str:
    return _relational_digest(
        collections=snapshot.collections,
        platform_settings=snapshot.platform_settings,
        email_settings=snapshot.email_settings,
        password_credentials=snapshot.password_credentials,
        temporary_password_user_ids=snapshot.temporary_password_user_ids,
        encrypted_provider_keys=snapshot.encrypted_provider_keys,
        configuration_secrets=snapshot.configuration_secrets,
    )


def _relational_digest(
    *,
    collections: Mapping[str, tuple[BaseModel, ...]],
    platform_settings: PlatformSettings,
    email_settings: EmailSettings,
    password_credentials: tuple[tuple[str, str], ...],
    temporary_password_user_ids: tuple[str, ...],
    encrypted_provider_keys: tuple[tuple[str, str], ...],
    configuration_secrets: tuple[tuple[str, str], ...],
) -> str:
    payload: dict[str, Any] = {
        key: [record.model_dump(mode="json") for record in collections[key]]
        for key in MODEL_COLLECTIONS
    }
    payload.update(
        {
            "platform_settings": platform_settings.model_dump(mode="json"),
            "email_settings": email_settings.model_dump(mode="json"),
            "password_credentials": dict(password_credentials),
            "temporary_password_user_ids": sorted(temporary_password_user_ids),
            "encrypted_provider_keys": dict(encrypted_provider_keys),
            "configuration_secrets": dict(configuration_secrets),
        }
    )
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _snapshot_relational_counts(snapshot: IdentityConfigSqlSnapshot) -> dict[str, int]:
    counts = {key: len(records) for key, records in snapshot.collections.items()}
    counts.update(
        {
            "password_credentials": len(snapshot.password_credentials),
            "temporary_password_user_ids": len(snapshot.temporary_password_user_ids),
            "encrypted_provider_keys": len(snapshot.encrypted_provider_keys),
            "configuration_secrets": len(snapshot.configuration_secrets),
            "platform_settings": 1,
            "email_settings": 1,
        }
    )
    return counts


def _relational_state_counts(state: ValidatedIdentityConfigState) -> dict[str, int]:
    return {
        key: value
        for key, value in state.collection_counts.items()
        if key not in {"knowledge_documents", "knowledge_chunks"}
    }


def _relational_receipt_counts(receipt: IdentityConfigImportReceipt) -> dict[str, int]:
    return {
        key: value
        for key, value in receipt.collection_counts.items()
        if key not in {"knowledge_documents", "knowledge_chunks"}
    }


def _assert_vector_receipt(
    relational: IdentityConfigImportReceipt,
    vector: KnowledgeStateImportReceipt,
) -> None:
    if not isinstance(vector, KnowledgeStateImportReceipt):
        raise IdentityConfigActivationError(
            "Activation requires a verified knowledge-state receipt."
        )
    expected = {
        "source_digest": relational.source_digest,
        "source_version": relational.source_version,
        "target_version": relational.target_version,
        "semantic_digest": relational.knowledge_digest,
        "semantic_format": SEMANTIC_FORMAT,
        "sparse_vector_format": SPARSE_VECTOR_FORMAT,
        "document_count": relational.collection_counts.get("knowledge_documents"),
        "chunk_count": relational.collection_counts.get("knowledge_chunks"),
    }
    actual = {
        "source_digest": vector.source_digest,
        "source_version": vector.source_version,
        "target_version": vector.target_version,
        "semantic_digest": vector.semantic_digest,
        "semantic_format": vector.semantic_format,
        "sparse_vector_format": vector.sparse_vector_format,
        "document_count": vector.document_count,
        "chunk_count": vector.chunk_count,
    }
    if actual != expected:
        raise IdentityConfigActivationError(
            "The vector receipt does not match the staged identity/config receipt."
        )
    _parse_utc(vector.completed_at, "vector receipt completed_at")


def _provider_model_from_bundle(credential: ProviderCredentialBundle) -> ProviderKeyImportRecord:
    if not isinstance(credential, ProviderCredentialBundle):
        raise TypeError("credential must be a ProviderCredentialBundle.")
    try:
        model = ProviderKeyImportRecord.model_validate(dict(credential.metadata))
    except ValidationError as exc:
        raise ProviderCredentialConflict("Provider credential metadata is invalid.") from exc
    if _canonical_json(model.model_dump(mode="json")) != _canonical_json(dict(credential.metadata)):
        raise ProviderCredentialConflict("Provider credential metadata is not canonical.")
    return model


def _bundle_from_rows(
    key_row: ProviderKeyRow,
    binding_row: ProviderCredentialBindingRow,
) -> ProviderCredentialBundle:
    if (
        key_row.provider_id != binding_row.provider_id
        or key_row.tenant_id != binding_row.tenant_id
        or key_row.credential_scope != binding_row.scope_key
        or key_row.id != binding_row.provider_key_id
    ):
        raise IdentityConfigCorruptionError(
            "Provider credential metadata, ciphertext, and binding are inconsistent."
        )
    return ProviderCredentialBundle(
        metadata=dict(key_row.payload),
        ciphertext=key_row.ciphertext,
        binding=ProviderCredentialBinding(
            provider_id=binding_row.provider_id,
            key_id=binding_row.provider_key_id,
            tenant_id=binding_row.tenant_id,
        ),
    )


def _receipt_row(
    receipt: IdentityConfigImportReceipt,
    completed_at: datetime,
) -> IdentityConfigImportRow:
    return IdentityConfigImportRow(
        source_digest=receipt.source_digest,
        source_version=receipt.source_version,
        target_version=receipt.target_version,
        schema_revision=receipt.schema_revision,
        prior_application_state_digest=receipt.prior_application_state_digest,
        prior_chat_state_digest=receipt.prior_chat_state_digest,
        relational_digest=receipt.relational_digest,
        knowledge_digest=receipt.knowledge_digest,
        collection_counts=dict(receipt.collection_counts),
        completed_at=completed_at,
    )


def _receipt_from_row(row: IdentityConfigImportRow) -> IdentityConfigImportReceipt:
    return IdentityConfigImportReceipt(
        source_digest=row.source_digest,
        source_version=row.source_version,
        target_version=row.target_version,
        schema_revision=row.schema_revision,
        prior_application_state_digest=row.prior_application_state_digest,
        prior_chat_state_digest=row.prior_chat_state_digest,
        relational_digest=row.relational_digest,
        knowledge_digest=row.knowledge_digest,
        collection_counts=dict(row.collection_counts),
        completed_at=_aware_utc(row.completed_at, "stored receipt completed_at").isoformat(),
    )


def _receipt_matches(
    row: IdentityConfigImportRow,
    receipt: IdentityConfigImportReceipt,
) -> bool:
    return _receipt_values_equal(_receipt_from_row(row), receipt)


def _receipt_values_equal(
    left: IdentityConfigImportReceipt,
    right: IdentityConfigImportReceipt,
) -> bool:
    left_values = left.to_dict()
    right_values = right.to_dict()
    left_completed = _parse_utc(left_values.pop("completed_at"), "receipt completed_at")
    right_completed = _parse_utc(right_values.pop("completed_at"), "receipt completed_at")
    return left_values == right_values and left_completed == right_completed


def _require_predecessor_receipts(
    session: Session,
    receipt: IdentityConfigImportReceipt,
    *,
    prior_chain: Any | None = None,
) -> None:
    application = session.get(RuntimeStateImportRow, receipt.prior_application_state_digest)
    chat = session.get(ChatStateImportRow, receipt.prior_chat_state_digest)
    if application is None or chat is None:
        raise IdentityConfigImportConflict(
            "Identity/config import predecessor receipts are missing."
        )
    if chat.prior_application_state_digest != application.source_digest:
        raise IdentityConfigImportConflict(
            "Identity/config predecessor receipt chain is inconsistent."
        )
    if prior_chain is None:
        return

    expected_application = dict(prior_chain.application_state_metadata)
    actual_application = {
        "source_digest": application.source_digest,
        "source_version": application.source_version,
        "target_version": application.target_version,
        "schema_revision": "20260720_0003",
        "audit_count": application.audit_count,
        "usage_count": application.usage_count,
        "outbox_count": application.outbox_count,
        "alert_notification_count": application.alert_notification_count,
        "alert_runtime_count": application.alert_runtime_count,
    }
    expected_chat = dict(prior_chain.chat_state_metadata)
    actual_chat = {
        "source_digest": chat.source_digest,
        "source_version": chat.source_version,
        "target_version": chat.target_version,
        "schema_revision": "20260720_0004",
        "prior_application_state_digest": chat.prior_application_state_digest,
        "thread_count": chat.thread_count,
        "folder_count": chat.folder_count,
        "attachment_count": chat.attachment_count,
        "api_key_count": chat.api_key_count,
        "watermark_count": chat.watermark_count,
    }
    if expected_application != actual_application or expected_chat != actual_chat:
        raise IdentityConfigImportConflict(
            "Identity/config predecessor receipt metadata does not match SQL authority."
        )


def _require_live_schema(session: Session) -> None:
    live_revision = session.scalar(text("select version_num from alembic_version"))
    if live_revision != HEAD_REVISION:
        raise IdentityConfigSqlError(
            "Identity/config repository requires the released database schema head."
        )


def _require_active_authority(
    session: Session,
    *,
    for_update: bool = False,
) -> IdentityConfigActiveImportRow:
    statement = select(IdentityConfigActiveImportRow).where(
        IdentityConfigActiveImportRow.singleton_id == 1
    )
    if for_update:
        statement = statement.with_for_update()
    active = session.scalar(statement)
    if active is None:
        raise IdentityConfigActivationError("Identity/config SQL authority is not active.")
    if session.get(IdentityConfigImportRow, active.source_digest) is None:
        raise IdentityConfigCorruptionError("The identity/config authority pointer is orphaned.")
    return active


def _authority_data_exists(session: Session) -> bool:
    return any(
        (session.scalar(select(func.count()).select_from(row_type)) or 0) != 0
        for row_type in _AUTHORITY_DATA_ROW_TYPES
    )


def _secret_qualifier(parsed: ParsedConfigurationSecretKey) -> str:
    return parsed.subject_user_id or parsed.qualifier or ""


def _unique_pairs(
    values: tuple[tuple[str, str], ...],
    label: str,
) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in values:
        if key in result:
            raise IdentityConfigImportConflict(f"Duplicate {label} id is not allowed.")
        result[key] = value
    return result


def _outcome(
    receipt: IdentityConfigImportReceipt,
    disposition: Literal["imported", "already_applied"],
) -> IdentityConfigImportOutcome:
    return IdentityConfigImportOutcome(
        source_digest=receipt.source_digest,
        relational_digest=receipt.relational_digest,
        disposition=disposition,
    )


def _required_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{label} must be a non-empty canonical string.")
    return value


def _require_scoped_provider_ciphertext(value: str) -> str:
    if not isinstance(value, str) or not value.startswith("v3."):
        raise ProviderCredentialConflict(
            "Provider credential writes require scoped v3 ciphertext."
        )
    encoded = value.removeprefix("v3.")
    try:
        raw = base64.b64decode(
            encoded.encode("ascii"),
            altchars=b"-_",
            validate=True,
        )
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ProviderCredentialConflict(
            "Provider credential writes require well-formed scoped v3 ciphertext."
        ) from exc
    if len(raw) < 28:
        raise ProviderCredentialConflict(
            "Provider credential writes require well-formed scoped v3 ciphertext."
        )
    return value


def _require_sha256(value: str, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest.")
    return value


def _parse_utc(value: str, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be an ISO timestamp.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO timestamp.") from exc
    return _aware_utc(parsed, label)


def _aware_utc(value: datetime, label: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{label} must be timezone-aware.")
    return value.astimezone(UTC)


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
