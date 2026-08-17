from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Mapping

from pydantic import BaseModel, ValidationError

from app.core.tenant_identity import (
    TenantIdentityError,
    require_canonical_custom_domain,
    require_canonical_tenant_slug,
)
from app.models.schemas import (
    AgentRun,
    AlertRule,
    Automation,
    CompanionMemory,
    Connector,
    ConnectorConfig,
    ContentFilter,
    EmailSettings,
    Group,
    KnowledgeChunk,
    KnowledgeConfig,
    KnowledgeDocument,
    ModelConfig,
    PlatformSettings,
    PromptTemplate,
    Provider,
    ProviderKey,
    Role,
    ScimTokenRecord,
    SecurityAlert,
    SkillFile,
    SsoConfig,
    Tenant,
    TenantMemoryPolicy,
    TenantRetentionPolicy,
    ToolConfig,
    User,
    UserMemory,
    UserMemorySettings,
)


SOURCE_STATE_VERSION = 4
TARGET_STATE_VERSION = 5
APPLICATION_STATE_METADATA_KEY = "application_state_import"
CHAT_STATE_METADATA_KEY = "chat_state_import"
IDENTITY_CONFIG_METADATA_KEY = "identity_config_import"
KNOWLEDGE_STATE_METADATA_KEY = "knowledge_state_import"
APPLICATION_STATE_IMPORT_REVISION = "20260720_0003"
CHAT_STATE_IMPORT_REVISION = "20260720_0004"


class IdentityConfigImportError(ValueError):
    """Raised when a v4 identity/config cutover cannot be proven lossless."""


class ProviderKeyImportRecord(ProviderKey):
    """A7/A9 import shape for provider credentials.

    Version 4 records do not yet carry ``tenant_id`` and therefore deserialize
    as platform credentials. A9-aware sources may set it without requiring a
    second credential-table migration after the A7 cutover.
    """

MODEL_COLLECTIONS: dict[str, type[BaseModel]] = {
    "tenants": Tenant,
    "users": User,
    "groups": Group,
    "providers": Provider,
    "models": ModelConfig,
    "provider_keys": ProviderKeyImportRecord,
    "connectors": Connector,
    "connector_configs": ConnectorConfig,
    "sso_configs": SsoConfig,
    "knowledge_configs": KnowledgeConfig,
    "tool_configs": ToolConfig,
    "prompt_templates": PromptTemplate,
    "skill_files": SkillFile,
    "security_alerts": SecurityAlert,
    "agent_runs": AgentRun,
    "automations": Automation,
    "companion_memories": CompanionMemory,
    "content_filters": ContentFilter,
    # Per-user personalization memory. Stored in the identity/config snapshot
    # like every other runtime collection; the privacy boundary is enforced by
    # the read paths, never by hiding the rows from persistence.
    "user_memories": UserMemory,
    "tenant_memory_policies": TenantMemoryPolicy,
    "tenant_retention_policies": TenantRetentionPolicy,
    "user_memory_settings": UserMemorySettings,
    "scim_tokens": ScimTokenRecord,
    "alert_rules": AlertRule,
}

GROUPED_MODEL_COLLECTIONS: dict[str, type[BaseModel]] = {
    "knowledge_documents": KnowledgeDocument,
    "knowledge_chunks": KnowledgeChunk,
}

RAW_COLLECTIONS = frozenset(
    {
        "password_credentials",
        "temporary_password_user_ids",
        "encrypted_provider_keys",
        "configuration_secrets",
    }
)

SINGLETON_COLLECTIONS = frozenset({"platform_settings", "email_settings"})

A7_RUNTIME_FIELDS = frozenset(
    {
        *MODEL_COLLECTIONS,
        *GROUPED_MODEL_COLLECTIONS,
        *RAW_COLLECTIONS,
        *SINGLETON_COLLECTIONS,
    }
)

BASE_V4_FIELDS = frozenset(
    {
        "version",
        APPLICATION_STATE_METADATA_KEY,
        CHAT_STATE_METADATA_KEY,
        *A7_RUNTIME_FIELDS,
    }
)


@dataclass(frozen=True, slots=True)
class PriorImportChain:
    application_state_digest: str
    chat_state_digest: str
    application_state_metadata: dict[str, Any]
    chat_state_metadata: dict[str, Any]


@dataclass(frozen=True, slots=True)
class IdentityConfigImportReceipt:
    source_digest: str
    source_version: int
    target_version: int
    schema_revision: str
    prior_application_state_digest: str
    prior_chat_state_digest: str
    relational_digest: str
    knowledge_digest: str
    collection_counts: dict[str, int]
    completed_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ValidatedIdentityConfigState:
    collections: dict[str, tuple[BaseModel, ...]]
    knowledge_documents: dict[str, tuple[KnowledgeDocument, ...]]
    knowledge_chunks: dict[str, tuple[KnowledgeChunk, ...]]
    platform_settings: PlatformSettings
    email_settings: EmailSettings
    password_credentials: tuple[tuple[str, str], ...]
    temporary_password_user_ids: tuple[str, ...]
    encrypted_provider_keys: tuple[tuple[str, str], ...]
    configuration_secrets: tuple[tuple[str, str], ...]
    prior_import_chain: PriorImportChain
    source_digest: str
    relational_digest: str
    knowledge_digest: str
    collection_counts: dict[str, int]

    def create_receipt(
        self,
        *,
        schema_revision: str,
        completed_at: datetime | None = None,
    ) -> IdentityConfigImportReceipt:
        revision = schema_revision.strip()
        if not revision:
            raise IdentityConfigImportError("Identity/config schema revision is required.")
        timestamp = completed_at or datetime.now(UTC)
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=UTC)
        else:
            timestamp = timestamp.astimezone(UTC)
        return IdentityConfigImportReceipt(
            source_digest=self.source_digest,
            source_version=SOURCE_STATE_VERSION,
            target_version=TARGET_STATE_VERSION,
            schema_revision=revision,
            prior_application_state_digest=(self.prior_import_chain.application_state_digest),
            prior_chat_state_digest=self.prior_import_chain.chat_state_digest,
            relational_digest=self.relational_digest,
            knowledge_digest=self.knowledge_digest,
            collection_counts=dict(self.collection_counts),
            completed_at=timestamp.isoformat(),
        )


def validate_v4_identity_config_state(
    payload: Mapping[str, Any],
    *,
    predecessor_fields: frozenset[str] = frozenset(),
) -> ValidatedIdentityConfigState:
    """Strictly validate all v4 fields that remain authoritative after A4/A5.

    ``predecessor_fields`` is deliberately explicit. It lets the final A7
    integration acknowledge SQL-owned metadata introduced by revisions 0006
    through 0008 without silently accepting an unknown runtime collection.
    """

    if not isinstance(payload, Mapping):
        raise IdentityConfigImportError("Version 4 runtime state must be an object.")
    materialized = dict(payload)
    _assert_strict_json(materialized)
    if (
        type(materialized.get("version")) is not int
        or materialized["version"] != SOURCE_STATE_VERSION
    ):
        raise IdentityConfigImportError(
            f"Identity/config import requires runtime-state version {SOURCE_STATE_VERSION}."
        )

    unknown_fields = sorted(set(materialized).difference(BASE_V4_FIELDS | predecessor_fields))
    if unknown_fields:
        raise IdentityConfigImportError(
            "Version 4 runtime state contains unknown fields: " + ", ".join(unknown_fields) + "."
        )
    missing_fields = sorted(A7_RUNTIME_FIELDS.difference(materialized))
    if missing_fields:
        raise IdentityConfigImportError(
            "Version 4 runtime state is missing authoritative fields: "
            + ", ".join(missing_fields)
            + "."
        )

    prior_chain = _validate_prior_import_chain(materialized)
    collections = {
        key: _validate_model_collection(materialized, key, model_type)
        for key, model_type in MODEL_COLLECTIONS.items()
    }
    knowledge_documents = _validate_grouped_collection(
        materialized,
        "knowledge_documents",
        KnowledgeDocument,
        relation_field="knowledge_config_id",
    )
    knowledge_chunks = _validate_grouped_collection(
        materialized,
        "knowledge_chunks",
        KnowledgeChunk,
        relation_field="knowledge_config_id",
    )
    platform_settings = _validate_singleton(
        materialized,
        "platform_settings",
        PlatformSettings,
    )
    email_settings = _validate_singleton(materialized, "email_settings", EmailSettings)
    password_credentials = _validate_string_map(
        materialized,
        "password_credentials",
        max_key_length=255,
    )
    encrypted_provider_keys = _validate_string_map(
        materialized,
        "encrypted_provider_keys",
        max_key_length=255,
    )
    configuration_secrets = _validate_string_map(
        materialized,
        "configuration_secrets",
        max_key_length=768,
    )
    temporary_password_user_ids = _validate_unique_string_list(
        materialized,
        "temporary_password_user_ids",
        max_length=255,
    )

    _validate_relational_column_bounds(collections)
    _validate_import_uniques(collections)
    _validate_canonical_tenant_identities(collections)

    _validate_relationships(
        collections=collections,
        knowledge_documents=knowledge_documents,
        knowledge_chunks=knowledge_chunks,
        password_credentials=password_credentials,
        temporary_password_user_ids=temporary_password_user_ids,
        encrypted_provider_keys=encrypted_provider_keys,
    )

    source_digest = _sha256_json(materialized)
    relational_payload = {
        key: [record.model_dump(mode="json") for record in records]
        for key, records in collections.items()
    }
    relational_payload.update(
        {
            "platform_settings": platform_settings.model_dump(mode="json"),
            "email_settings": email_settings.model_dump(mode="json"),
            "password_credentials": dict(password_credentials),
            "temporary_password_user_ids": list(temporary_password_user_ids),
            "encrypted_provider_keys": dict(encrypted_provider_keys),
            "configuration_secrets": dict(configuration_secrets),
        }
    )
    knowledge_payload = _knowledge_payload(knowledge_documents, knowledge_chunks)

    counts = {key: len(records) for key, records in collections.items()}
    counts.update(
        {
            "knowledge_documents": sum(len(records) for records in knowledge_documents.values()),
            "knowledge_chunks": sum(len(records) for records in knowledge_chunks.values()),
            "password_credentials": len(password_credentials),
            "temporary_password_user_ids": len(temporary_password_user_ids),
            "encrypted_provider_keys": len(encrypted_provider_keys),
            "configuration_secrets": len(configuration_secrets),
            "platform_settings": 1,
            "email_settings": 1,
        }
    )
    return ValidatedIdentityConfigState(
        collections=collections,
        knowledge_documents=knowledge_documents,
        knowledge_chunks=knowledge_chunks,
        platform_settings=platform_settings,
        email_settings=email_settings,
        password_credentials=password_credentials,
        temporary_password_user_ids=temporary_password_user_ids,
        encrypted_provider_keys=encrypted_provider_keys,
        configuration_secrets=configuration_secrets,
        prior_import_chain=prior_chain,
        source_digest=source_digest,
        relational_digest=_sha256_json(relational_payload),
        knowledge_digest=_sha256_json(knowledge_payload),
        collection_counts=counts,
    )


def canonicalize_deleted_profile_dependents(
    payload: Mapping[str, Any],
) -> tuple[dict[str, Any], tuple[str, ...]]:
    """Remove only unreachable legacy rows left by an already-deleted profile.

    Version 4 profile deletion removed the model record but did not cascade its
    Hermes companion memories. Version 5 enforces that parent relationship in
    SQL, so those orphan rows cannot be imported or used. This compatibility
    pass leaves the caller's payload untouched, removes only memories whose
    profile ID no longer exists, and returns their IDs for an operator-visible
    cleanup count. Cross-tenant memories remain in place so strict validation
    still fails closed.
    """

    materialized = dict(payload)
    raw_models = materialized.get("models")
    raw_memories = materialized.get("companion_memories")
    if not isinstance(raw_models, list) or not isinstance(raw_memories, list):
        return materialized, ()

    model_ids = {
        record.get("id")
        for record in raw_models
        if isinstance(record, Mapping) and isinstance(record.get("id"), str)
    }
    retained: list[Any] = []
    removed_ids: list[str] = []
    for record in raw_memories:
        if not isinstance(record, Mapping):
            retained.append(record)
            continue
        profile_id = record.get("profile_id")
        if isinstance(profile_id, str) and profile_id not in model_ids:
            record_id = record.get("id")
            removed_ids.append(record_id if isinstance(record_id, str) else "<unknown>")
            continue
        retained.append(record)

    if not removed_ids:
        return materialized, ()
    materialized["companion_memories"] = retained
    return materialized, tuple(removed_ids)


def build_v5_tombstone(
    receipt: IdentityConfigImportReceipt,
    *,
    application_state_metadata: Mapping[str, Any],
    chat_state_metadata: Mapping[str, Any],
    knowledge_state_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    """Build the non-authoritative v5 receipt document.

    This deliberately accepts only receipt metadata. No runtime collection or
    ciphertext can enter the active v5 file through this function.
    """

    tombstone = {
        "version": TARGET_STATE_VERSION,
        APPLICATION_STATE_METADATA_KEY: dict(application_state_metadata),
        CHAT_STATE_METADATA_KEY: dict(chat_state_metadata),
        IDENTITY_CONFIG_METADATA_KEY: receipt.to_dict(),
        KNOWLEDGE_STATE_METADATA_KEY: dict(knowledge_state_metadata),
    }
    _assert_strict_json(tombstone)
    # A tombstone is small enough that constructing an invalid one should be
    # impossible.  Reuse the reader's complete receipt binding checks so a
    # malformed predecessor receipt fails at the writer boundary rather than
    # bricking the next process restart.
    validate_v5_tombstone(
        tombstone,
        identity_receipt=receipt,
        knowledge_state_metadata=knowledge_state_metadata,
    )
    return tombstone


def validate_v5_tombstone(
    payload: Mapping[str, Any],
    *,
    identity_receipt: IdentityConfigImportReceipt,
    knowledge_state_metadata: Mapping[str, Any],
) -> PriorImportChain:
    """Verify a retired runtime file against both active authority receipts."""

    if not isinstance(payload, Mapping):
        raise IdentityConfigImportError("Version 5 runtime tombstone must be an object.")
    materialized = dict(payload)
    _assert_strict_json(materialized)
    expected_fields = {
        "version",
        APPLICATION_STATE_METADATA_KEY,
        CHAT_STATE_METADATA_KEY,
        IDENTITY_CONFIG_METADATA_KEY,
        KNOWLEDGE_STATE_METADATA_KEY,
    }
    if set(materialized) != expected_fields or materialized.get("version") != 5:
        raise IdentityConfigImportError(
            "Version 5 runtime tombstone has an incompatible shape."
        )
    if materialized.get(IDENTITY_CONFIG_METADATA_KEY) != identity_receipt.to_dict():
        raise IdentityConfigImportError(
            "Version 5 runtime tombstone does not match active SQL authority."
        )
    if materialized.get(KNOWLEDGE_STATE_METADATA_KEY) != dict(knowledge_state_metadata):
        raise IdentityConfigImportError(
            "Version 5 runtime tombstone does not match active vector authority."
        )
    prior = _validate_prior_import_chain(materialized)
    if (
        prior.application_state_digest
        != identity_receipt.prior_application_state_digest
        or prior.chat_state_digest != identity_receipt.prior_chat_state_digest
    ):
        raise IdentityConfigImportError(
            "Version 5 runtime tombstone does not match predecessor authority."
        )
    return prior


def _validate_prior_import_chain(payload: Mapping[str, Any]) -> PriorImportChain:
    application = payload.get(APPLICATION_STATE_METADATA_KEY)
    chat = payload.get(CHAT_STATE_METADATA_KEY)
    if not isinstance(application, Mapping) or not isinstance(chat, Mapping):
        raise IdentityConfigImportError(
            "Version 4 runtime state is missing its application/chat import receipts."
        )
    _validate_predecessor_receipt(
        application,
        label="application-state",
        expected_fields={
            "source_digest",
            "source_version",
            "target_version",
            "schema_revision",
            "audit_count",
            "usage_count",
            "outbox_count",
            "alert_notification_count",
            "alert_runtime_count",
        },
        count_fields={
            "audit_count",
            "usage_count",
            "outbox_count",
            "alert_notification_count",
            "alert_runtime_count",
        },
        expected_source_versions={0, 2},
        expected_target_version=3,
        expected_schema_revision=APPLICATION_STATE_IMPORT_REVISION,
    )
    _validate_predecessor_receipt(
        chat,
        label="chat-state",
        expected_fields={
            "source_digest",
            "source_version",
            "target_version",
            "schema_revision",
            "prior_application_state_digest",
            "thread_count",
            "folder_count",
            "attachment_count",
            "api_key_count",
            "watermark_count",
        },
        count_fields={
            "thread_count",
            "folder_count",
            "attachment_count",
            "api_key_count",
            "watermark_count",
        },
        expected_source_versions={3},
        expected_target_version=4,
        expected_schema_revision=CHAT_STATE_IMPORT_REVISION,
    )
    application_digest = _require_sha256(
        application.get("source_digest"),
        "application-state receipt",
    )
    chat_digest = _require_sha256(chat.get("source_digest"), "chat-state receipt")
    prior_digest = _require_sha256(
        chat.get("prior_application_state_digest"),
        "chat-state prior receipt",
    )
    if prior_digest != application_digest:
        raise IdentityConfigImportError(
            "Version 4 chat-state receipt is not bound to its application-state receipt."
        )
    return PriorImportChain(
        application_state_digest=application_digest,
        chat_state_digest=chat_digest,
        application_state_metadata=dict(application),
        chat_state_metadata=dict(chat),
    )


def _validate_predecessor_receipt(
    receipt: Mapping[str, Any],
    *,
    label: str,
    expected_fields: set[str],
    count_fields: set[str],
    expected_source_versions: set[int],
    expected_target_version: int,
    expected_schema_revision: str,
) -> None:
    if set(receipt) != expected_fields:
        raise IdentityConfigImportError(f"Version 4 {label} receipt has an incompatible shape.")
    source_version = receipt.get("source_version")
    target_version = receipt.get("target_version")
    if (
        type(source_version) is not int
        or source_version not in expected_source_versions
        or type(target_version) is not int
        or target_version != expected_target_version
        or receipt.get("schema_revision") != expected_schema_revision
        or any(type(receipt.get(field)) is not int or receipt[field] < 0 for field in count_fields)
    ):
        raise IdentityConfigImportError(f"Version 4 {label} receipt metadata is invalid.")


def _validate_model_collection(
    payload: Mapping[str, Any],
    key: str,
    model_type: type[BaseModel],
) -> tuple[BaseModel, ...]:
    raw_records = payload.get(key)
    if not isinstance(raw_records, list):
        raise IdentityConfigImportError(f"Runtime-state field {key!r} must be a list.")
    records: list[BaseModel] = []
    seen_ids: set[str] = set()
    for index, raw_record in enumerate(raw_records):
        record = _validate_model_record(raw_record, model_type, f"{key}[{index}]")
        record_id = getattr(record, "id", None)
        if not isinstance(record_id, str) or not record_id:
            raise IdentityConfigImportError(f"Runtime-state field {key}[{index}] has no id.")
        _require_bounded_string(record_id, 255, f"{key}[{index}].id")
        if record_id in seen_ids:
            raise IdentityConfigImportError(
                f"Runtime-state field {key!r} contains duplicate id {record_id!r}."
            )
        if (
            key == "alert_rules"
            and isinstance(raw_record, Mapping)
            and "last_triggered_at" in raw_record
        ):
            raise IdentityConfigImportError(
                "Version 4 alert_rules contains SQL-owned last_triggered_at state."
            )
        seen_ids.add(record_id)
        records.append(record)
    return tuple(records)


def _validate_grouped_collection(
    payload: Mapping[str, Any],
    key: str,
    model_type: type[BaseModel],
    *,
    relation_field: str,
) -> dict[str, tuple[Any, ...]]:
    raw_groups = payload.get(key)
    if not isinstance(raw_groups, Mapping):
        raise IdentityConfigImportError(f"Runtime-state field {key!r} must be an object.")
    groups: dict[str, tuple[Any, ...]] = {}
    seen_ids: set[str] = set()
    for raw_group_id, raw_records in raw_groups.items():
        group_id = str(raw_group_id)
        if not group_id or not isinstance(raw_records, list):
            raise IdentityConfigImportError(f"Runtime-state field {key!r} has an invalid group.")
        records: list[Any] = []
        for index, raw_record in enumerate(raw_records):
            record = _validate_model_record(
                raw_record,
                model_type,
                f"{key}[{group_id!r}][{index}]",
            )
            record_id = getattr(record, "id", None)
            if not isinstance(record_id, str) or not record_id:
                raise IdentityConfigImportError(
                    f"Runtime-state field {key}[{group_id!r}][{index}] has no id."
                )
            if record_id in seen_ids:
                raise IdentityConfigImportError(
                    f"Runtime-state field {key!r} contains duplicate id {record_id!r}."
                )
            if getattr(record, relation_field, None) != group_id:
                raise IdentityConfigImportError(
                    f"Runtime-state field {key!r} groups record {record_id!r} under the wrong config."
                )
            seen_ids.add(record_id)
            records.append(record)
        groups[group_id] = tuple(records)
    return groups


def _validate_singleton(
    payload: Mapping[str, Any],
    key: str,
    model_type: type[BaseModel],
) -> Any:
    return _validate_model_record(payload.get(key), model_type, key)


def _validate_model_record(
    raw_record: Any,
    model_type: type[BaseModel],
    label: str,
) -> Any:
    if not isinstance(raw_record, Mapping):
        raise IdentityConfigImportError(f"Runtime-state field {label} must be an object.")
    unknown_fields = sorted(set(raw_record).difference(model_type.model_fields))
    if unknown_fields:
        raise IdentityConfigImportError(
            f"Runtime-state field {label} has unknown fields: {', '.join(unknown_fields)}."
        )
    try:
        # Strict JSON validation accepts JSON encodings for enums/datetimes
        # while still rejecting Python-side coercions such as integers for
        # strings or truthy integers for booleans.
        return model_type.model_validate_json(_canonical_json(raw_record), strict=True)
    except ValidationError as exc:
        field_names = sorted(
            {
                ".".join(str(part) for part in error.get("loc", ())) or "record"
                for error in exc.errors(include_input=False, include_url=False)
            }
        )
        raise IdentityConfigImportError(
            f"Runtime-state field {label} is invalid at: {', '.join(field_names)}."
        ) from exc


def _validate_string_map(
    payload: Mapping[str, Any],
    key: str,
    *,
    max_key_length: int,
) -> tuple[tuple[str, str], ...]:
    raw_mapping = payload.get(key)
    if not isinstance(raw_mapping, Mapping):
        raise IdentityConfigImportError(f"Runtime-state field {key!r} must be an object.")
    normalized: list[tuple[str, str]] = []
    for raw_key, raw_value in raw_mapping.items():
        if (
            not isinstance(raw_key, str)
            or not raw_key
            or not isinstance(raw_value, str)
            or not raw_value
        ):
            raise IdentityConfigImportError(
                f"Runtime-state field {key!r} contains an invalid key or value."
            )
        _require_bounded_string(raw_key, max_key_length, f"{key} key")
        normalized.append((raw_key, raw_value))
    return tuple(normalized)


def _validate_unique_string_list(
    payload: Mapping[str, Any],
    key: str,
    *,
    max_length: int,
) -> tuple[str, ...]:
    raw_values = payload.get(key)
    if not isinstance(raw_values, list) or any(
        not isinstance(value, str) or not value for value in raw_values
    ):
        raise IdentityConfigImportError(f"Runtime-state field {key!r} must be a string list.")
    if len(set(raw_values)) != len(raw_values):
        raise IdentityConfigImportError(f"Runtime-state field {key!r} contains duplicates.")
    for index, value in enumerate(raw_values):
        _require_bounded_string(value, max_length, f"{key}[{index}]")
    # This field represents a set in SeedStore and legacy snapshots already
    # emit it sorted. Canonicalizing here makes the SQL representation and its
    # independent digest reconstruction dialect-neutral.
    return tuple(sorted(raw_values))


def _validate_relational_column_bounds(
    collections: Mapping[str, tuple[BaseModel, ...]],
) -> None:
    """Mirror every bounded 0009 projection before either SQL dialect writes."""

    field_bounds: dict[str, tuple[tuple[str, int], ...]] = {
        "tenants": (("slug", 80), ("custom_domain", 253)),
        "users": (("tenant_id", 255), ("email", 320), ("role", 100)),
        "groups": (("tenant_id", 255),),
        "providers": (("kind", 100),),
        "models": (("tenant_id", 255), ("provider_id", 255)),
        "provider_keys": (("provider_id", 255), ("tenant_id", 255)),
        "connector_configs": (("tenant_id", 255), ("connector_id", 255)),
        "sso_configs": (("tenant_id", 255),),
        "knowledge_configs": (("tenant_id", 255), ("connector_config_id", 255)),
        "tool_configs": (("tenant_id", 255),),
        "prompt_templates": (("tenant_id", 255),),
        "skill_files": (("tenant_id", 255),),
        "security_alerts": (("tenant_id", 255),),
        "agent_runs": (("tenant_id", 255), ("status", 100)),
        "automations": (("tenant_id", 255),),
        "companion_memories": (("tenant_id", 255), ("profile_id", 255)),
        "content_filters": (("tenant_id", 255),),
        "user_memories": (("tenant_id", 255), ("owner_user_id", 255)),
        "tenant_memory_policies": (("tenant_id", 255),),
        "tenant_retention_policies": (("tenant_id", 255),),
        "user_memory_settings": (("user_id", 255),),
        "scim_tokens": (("tenant_id", 255), ("token_hash", 64)),
        "alert_rules": (("scope", 20), ("tenant_id", 255)),
    }
    for collection_name, specs in field_bounds.items():
        for index, record in enumerate(collections[collection_name]):
            for field_name, maximum in specs:
                value = getattr(record, field_name)
                if value is None:
                    continue
                if hasattr(value, "value"):
                    value = value.value
                normalized = (
                    value.strip().casefold()
                    if collection_name == "users" and field_name == "email"
                    else value
                )
                _require_bounded_string(
                    normalized,
                    maximum,
                    f"{collection_name}[{index}].{field_name}",
                )

    for index, key in enumerate(collections["provider_keys"]):
        scope_key = "platform" if key.tenant_id is None else f"tenant:{key.tenant_id}"
        _require_bounded_string(scope_key, 320, f"provider_keys[{index}].credential_scope")


def _validate_import_uniques(
    collections: Mapping[str, tuple[BaseModel, ...]],
) -> None:
    projections: tuple[tuple[str, list[str]], ...] = (
        ("tenant slug", [record.slug for record in collections["tenants"]]),
        (
            "tenant custom domain",
            [
                record.custom_domain.casefold()
                for record in collections["tenants"]
                if record.custom_domain is not None
            ],
        ),
        (
            "normalized identity email",
            [record.email.strip().casefold() for record in collections["users"]],
        ),
        ("SCIM token hash", [record.token_hash for record in collections["scim_tokens"]]),
    )
    for label, values in projections:
        if len(values) != len(set(values)):
            raise IdentityConfigImportError(f"Duplicate {label} is not allowed.")


def _validate_canonical_tenant_identities(
    collections: Mapping[str, tuple[BaseModel, ...]],
) -> None:
    for index, tenant in enumerate(collections["tenants"]):
        try:
            require_canonical_tenant_slug(tenant.slug)
            require_canonical_custom_domain(tenant.custom_domain)
        except TenantIdentityError as exc:
            raise IdentityConfigImportError(
                f"Runtime-state tenant[{index}] identity is not canonical: {exc}"
            ) from exc


def _require_bounded_string(value: Any, maximum: int, label: str) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise IdentityConfigImportError(
            f"Runtime-state field {label} exceeds its {maximum}-character SQL bound."
        )
    return value


def _validate_relationships(
    *,
    collections: dict[str, tuple[BaseModel, ...]],
    knowledge_documents: dict[str, tuple[KnowledgeDocument, ...]],
    knowledge_chunks: dict[str, tuple[KnowledgeChunk, ...]],
    password_credentials: tuple[tuple[str, str], ...],
    temporary_password_user_ids: tuple[str, ...],
    encrypted_provider_keys: tuple[tuple[str, str], ...],
) -> None:
    indexed = {
        key: {str(record.id): record for record in records} for key, records in collections.items()
    }
    tenants = indexed["tenants"]
    users = indexed["users"]
    groups = indexed["groups"]
    providers = indexed["providers"]
    models = indexed["models"]
    connectors = indexed["connectors"]
    connector_configs = indexed["connector_configs"]
    knowledge_configs = indexed["knowledge_configs"]
    tool_configs = indexed["tool_configs"]
    prompt_templates = indexed["prompt_templates"]
    skill_files = indexed["skill_files"]
    content_filters = indexed["content_filters"]

    for user in users.values():
        if user.role == Role.PLATFORM_OWNER:
            if user.tenant_id is not None:
                raise IdentityConfigImportError(
                    f"Platform owner {user.id!r} must not be bound to a tenant."
                )
        elif user.tenant_id not in tenants:
            raise IdentityConfigImportError(f"User {user.id!r} references an unknown tenant.")
        for group_id in user.group_ids:
            group = groups.get(group_id)
            if group is None or group.tenant_id != user.tenant_id:
                raise IdentityConfigImportError(
                    f"User {user.id!r} has an unknown or cross-tenant group."
                )

    for group in groups.values():
        if group.tenant_id not in tenants:
            raise IdentityConfigImportError(f"Group {group.id!r} references an unknown tenant.")

    for model in models.values():
        if model.provider_id not in providers:
            raise IdentityConfigImportError(f"Model {model.id!r} references an unknown provider.")
        if model.tenant_id is not None and model.tenant_id not in tenants:
            raise IdentityConfigImportError(f"Model {model.id!r} references an unknown tenant.")
        _require_known_ids(model.id, "group", model.group_ids, groups)
        _require_known_ids(
            model.id,
            "knowledge config",
            model.knowledge_config_ids,
            knowledge_configs,
        )
        _require_known_ids(model.id, "tool config", model.tool_config_ids, tool_configs)
        _require_known_ids(
            model.id,
            "prompt template",
            model.prompt_template_ids,
            prompt_templates,
        )
        _require_known_ids(model.id, "skill file", model.skill_file_ids, skill_files)
        unknown_filters = [
            filter_id
            for filter_id in model.content_filter_ids
            if filter_id not in content_filters and not filter_id.startswith("cf-preset-")
        ]
        if unknown_filters:
            raise IdentityConfigImportError(
                f"Model {model.id!r} references an unknown content filter."
            )

    for key in collections["provider_keys"]:
        if key.provider_id not in providers:
            raise IdentityConfigImportError(
                f"Provider key {key.id!r} references an unknown provider."
            )
        if key.tenant_id is not None and key.tenant_id not in tenants:
            raise IdentityConfigImportError(
                f"Provider key {key.id!r} references an unknown tenant."
            )

    provider_key_ids = set(indexed["provider_keys"])
    encrypted_key_ids = {key_id for key_id, _ciphertext in encrypted_provider_keys}
    if provider_key_ids != encrypted_key_ids:
        raise IdentityConfigImportError(
            "Provider-key metadata and encrypted ciphertext IDs do not match exactly."
        )
    active_provider_scopes: set[tuple[str, str]] = set()
    for key in collections["provider_keys"]:
        if key.status.casefold() != "active":
            continue
        scope = "platform" if key.tenant_id is None else f"tenant:{key.tenant_id}"
        binding = (key.provider_id, scope)
        if binding in active_provider_scopes:
            raise IdentityConfigImportError(
                "Provider keys contain an ambiguous active provider/scope binding."
            )
        active_provider_scopes.add(binding)

    for config in connector_configs.values():
        _require_tenant(config.id, config.tenant_id, tenants, "Connector config")
        if config.connector_id not in connectors:
            raise IdentityConfigImportError(
                f"Connector config {config.id!r} references an unknown connector."
            )

    for config in indexed["sso_configs"].values():
        _require_tenant(config.id, config.tenant_id, tenants, "SSO config")
        # mapped_groups maps an IdP group claim value → workspace group id;
        # the workspace group (the value) must exist inside the same tenant.
        for group_id in config.mapped_groups.values():
            _require_group_in_tenant(config.id, group_id, config.tenant_id, groups, "SSO config")

    for config in knowledge_configs.values():
        _require_tenant(config.id, config.tenant_id, tenants, "Knowledge config")
        if config.connector_config_id is not None:
            connector_config = connector_configs.get(config.connector_config_id)
            if connector_config is None or connector_config.tenant_id != config.tenant_id:
                raise IdentityConfigImportError(
                    f"Knowledge config {config.id!r} has an unknown or cross-tenant connector."
                )
        if config.owner_user_id is not None:
            owner = users.get(config.owner_user_id)
            # The platform owner is tenant-unbound by invariant, so it may own
            # knowledge configs in any tenant.
            if owner is None or (
                owner.role != Role.PLATFORM_OWNER and owner.tenant_id != config.tenant_id
            ):
                raise IdentityConfigImportError(
                    f"Knowledge config {config.id!r} has an unknown or cross-tenant owner."
                )
        for group_id in config.acl_group_ids:
            _require_group_in_tenant(
                config.id,
                group_id,
                config.tenant_id,
                groups,
                "Knowledge config",
            )

    for collection_name, group_field, label in (
        ("tool_configs", "allowed_group_ids", "Tool config"),
        ("prompt_templates", "group_ids", "Prompt template"),
        ("skill_files", "group_ids", "Skill file"),
    ):
        for record in indexed[collection_name].values():
            _require_tenant(record.id, record.tenant_id, tenants, label)
            for group_id in getattr(record, group_field):
                _require_group_in_tenant(
                    record.id,
                    group_id,
                    record.tenant_id,
                    groups,
                    label,
                )

    for record in content_filters.values():
        if record.tenant_id is not None and record.tenant_id not in tenants:
            raise IdentityConfigImportError(
                f"Content filter {record.id!r} references an unknown tenant."
            )

    for alert in indexed["security_alerts"].values():
        if alert.tenant_id is not None and alert.tenant_id not in tenants:
            raise IdentityConfigImportError(
                f"Security alert {alert.id!r} references an unknown tenant."
            )

    for run in indexed["agent_runs"].values():
        _require_tenant(run.id, run.tenant_id, tenants, "Agent run")

    for automation in indexed["automations"].values():
        _require_tenant(automation.id, automation.tenant_id, tenants, "Automation")
        for step in automation.steps:
            model = models.get(step.model_id)
            if model is None:
                # Legacy Hermes proposals are deliberately stored disabled for
                # human review. A later agent-profile deletion could leave the
                # proposal's model reference unresolved. Preserve that disabled
                # work product during the v4-to-v5 cutover; the automation API
                # still refuses to enable or run it until a valid model is
                # selected. Enabled automations must remain fully resolvable.
                if not automation.enabled:
                    continue
                raise IdentityConfigImportError(
                    f"Enabled automation {automation.id!r} has an unknown model step."
                )
            if model.tenant_id is not None and model.tenant_id != automation.tenant_id:
                raise IdentityConfigImportError(
                    f"Automation {automation.id!r} has a cross-tenant model step."
                )

    for memory in indexed["companion_memories"].values():
        _require_tenant(memory.id, memory.tenant_id, tenants, "Companion memory")
        profile = models.get(memory.profile_id)
        if profile is None or profile.tenant_id != memory.tenant_id:
            raise IdentityConfigImportError(
                f"Companion memory {memory.id!r} has an unknown or cross-tenant profile."
            )

    # Personalization memory is strictly per-user. Tenant users must own rows
    # in their tenant; a tenant-unbound platform owner may use the primary
    # tenant as a durable SQL scope, matching owner-created knowledge records.
    for memory in indexed["user_memories"].values():
        _require_tenant(memory.id, memory.tenant_id, tenants, "User memory")
        owner = users.get(memory.owner_user_id)
        if owner is None or (
            owner.role != Role.PLATFORM_OWNER and owner.tenant_id != memory.tenant_id
        ):
            raise IdentityConfigImportError(
                f"User memory {memory.id!r} has an unknown or cross-tenant owner."
            )

    for policy in indexed["tenant_memory_policies"].values():
        _require_tenant(policy.id, policy.tenant_id, tenants, "Tenant memory policy")
        if policy.id != policy.tenant_id:
            raise IdentityConfigImportError(
                f"Tenant memory policy {policy.id!r} must be keyed by its tenant."
            )

    for policy in indexed["tenant_retention_policies"].values():
        _require_tenant(policy.id, policy.tenant_id, tenants, "Tenant retention policy")
        if policy.id != policy.tenant_id:
            raise IdentityConfigImportError(
                f"Tenant retention policy {policy.id!r} must be keyed by its tenant."
            )

    for settings in indexed["user_memory_settings"].values():
        if settings.user_id not in users:
            raise IdentityConfigImportError(
                f"User memory settings {settings.id!r} reference an unknown user."
            )
        if settings.id != settings.user_id:
            raise IdentityConfigImportError(
                f"User memory settings {settings.id!r} must be keyed by their user."
            )

    for token in indexed["scim_tokens"].values():
        _require_tenant(token.id, token.tenant_id, tenants, "SCIM token")

    for rule in indexed["alert_rules"].values():
        if rule.scope == "platform":
            if rule.tenant_id is not None:
                raise IdentityConfigImportError(
                    f"Platform alert rule {rule.id!r} must not have a tenant."
                )
        elif rule.scope == "tenant":
            _require_tenant(rule.id, rule.tenant_id, tenants, "Tenant alert rule")
        else:
            raise IdentityConfigImportError(f"Alert rule {rule.id!r} has an invalid scope.")

    credential_user_ids = {user_id for user_id, _hash in password_credentials}
    if not credential_user_ids.issubset(users):
        raise IdentityConfigImportError("Password credentials reference an unknown user.")
    if not set(temporary_password_user_ids).issubset(credential_user_ids):
        raise IdentityConfigImportError("Temporary-password users must have a password credential.")

    documents_by_id: dict[str, KnowledgeDocument] = {}
    for config_id, documents in knowledge_documents.items():
        config = knowledge_configs.get(config_id)
        if config is None:
            raise IdentityConfigImportError(
                f"Knowledge documents reference unknown config {config_id!r}."
            )
        for document in documents:
            if document.tenant_id != config.tenant_id:
                raise IdentityConfigImportError(
                    f"Knowledge document {document.id!r} is cross-tenant."
                )
            for group_id in document.acl_group_ids:
                _require_group_in_tenant(
                    document.id,
                    group_id,
                    document.tenant_id,
                    groups,
                    "Knowledge document",
                )
            documents_by_id[document.id] = document

    for config_id, chunks in knowledge_chunks.items():
        config = knowledge_configs.get(config_id)
        if config is None:
            raise IdentityConfigImportError(
                f"Knowledge chunks reference unknown config {config_id!r}."
            )
        for chunk in chunks:
            document = documents_by_id.get(chunk.document_id)
            if (
                document is None
                or document.knowledge_config_id != config_id
                or chunk.tenant_id != config.tenant_id
            ):
                raise IdentityConfigImportError(
                    f"Knowledge chunk {chunk.id!r} has an unknown or cross-tenant document."
                )
            for group_id in chunk.acl_group_ids:
                _require_group_in_tenant(
                    chunk.id,
                    group_id,
                    chunk.tenant_id,
                    groups,
                    "Knowledge chunk",
                )


def _require_tenant(
    record_id: str,
    tenant_id: str | None,
    tenants: Mapping[str, BaseModel],
    label: str,
) -> None:
    if tenant_id is None or tenant_id not in tenants:
        raise IdentityConfigImportError(f"{label} {record_id!r} references an unknown tenant.")


def _require_group_in_tenant(
    record_id: str,
    group_id: str,
    tenant_id: str,
    groups: Mapping[str, BaseModel],
    label: str,
) -> None:
    group = groups.get(group_id)
    if group is None or getattr(group, "tenant_id", None) != tenant_id:
        raise IdentityConfigImportError(
            f"{label} {record_id!r} has an unknown or cross-tenant group."
        )


def _require_known_ids(
    record_id: str,
    label: str,
    referenced_ids: list[str],
    records: Mapping[str, BaseModel],
) -> None:
    if any(referenced_id not in records for referenced_id in referenced_ids):
        raise IdentityConfigImportError(f"Record {record_id!r} references an unknown {label}.")


def _knowledge_payload(
    documents: Mapping[str, tuple[KnowledgeDocument, ...]],
    chunks: Mapping[str, tuple[KnowledgeChunk, ...]],
) -> dict[str, Any]:
    config_ids = sorted(set(documents) | set(chunks))
    return {
        "documents": {
            config_id: [record.model_dump(mode="json") for record in documents.get(config_id, ())]
            for config_id in config_ids
        },
        "chunks": {
            config_id: [record.model_dump(mode="json") for record in chunks.get(config_id, ())]
            for config_id in config_ids
        },
    }


def _assert_strict_json(value: Any) -> None:
    try:
        _canonical_json(value)
    except (TypeError, ValueError) as exc:
        raise IdentityConfigImportError("Runtime state is not strict JSON.") from exc


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _sha256_json(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _require_sha256(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise IdentityConfigImportError(f"Version 4 {label} digest is invalid.")
    return value
