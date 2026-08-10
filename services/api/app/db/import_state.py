from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Callable
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ValidationError
from sqlalchemy import func, or_, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import InstrumentedAttribute, Session

from app.core.config import get_settings, resolve_repo_path
from app.db.engine import (
    APPLICATION_STATE_IMPORT_REVISION,
    CHAT_STATE_IMPORT_REVISION,
    HEAD_REVISION,
    create_application_engine,
    create_session_factory,
    session_scope,
    upgrade_database,
)
from app.db.orm import (
    AlertNotificationRow,
    AlertRuleRuntimeRow,
    AuditEventRow,
    AuditOutboxRow,
    ChatAttachmentRow,
    ChatFolderRow,
    ChatStateImportRow,
    ChatThreadRow,
    RuntimeStateImportRow,
    UsageRecordRow,
    UserApiKeyRow,
    UserSessionWatermarkRow,
)
from app.models.schemas import (
    AlertNotification,
    AlertRule,
    AuditEvent,
    ChatActivityTraceStep,
    ChatAttachment,
    ChatCitation,
    ChatFolder,
    ChatMessage,
    ChatSession,
    ChatThread,
    ModelConfig,
    Role,
    Tenant,
    UsageRecord,
    User,
    UserApiKeyRecord,
)


LEGACY_STATE_VERSION = 2
RELATIONAL_STATE_VERSION = 3
CHAT_RELATIONAL_STATE_VERSION = 4
APPLICATION_STATE_METADATA_KEY = "application_state_import"
CHAT_STATE_METADATA_KEY = "chat_state_import"
_EMPTY_PREDECESSOR_LOCK_ID = 2_026_072_000_004
LEGACY_USAGE_RECORDS_MAX = 20_000
RELATIONAL_STATE_RETIRED_FIELDS = frozenset(
    {
        "audit_events",
        "usage_records",
        "elastic_events",
        "alert_notifications",
    }
)
CHAT_STATE_RETIRED_FIELDS = frozenset(
    {
        "chat_threads",
        "chat_folders",
        "chat_sessions",
        "chat_attachments",
        "user_api_keys",
        "user_session_watermarks",
        "session_issued_before_ms",
    }
)
UNSUPPORTED_LEGACY_WATERMARK_FIELDS = frozenset(
    {"user_session_watermarks", "session_issued_before_ms"}
)


class StateImportError(ValueError):
    """Raised when runtime state cannot be migrated or verified without loss."""


@dataclass(frozen=True, slots=True)
class LegacyOutboxItem:
    dedupe_key: str
    event_id: str | None
    tenant_id: str | None
    payload: dict[str, Any]


@dataclass(frozen=True, slots=True)
class AlertRuleRuntimeItem:
    rule_id: str
    last_triggered_at: datetime | None


@dataclass(frozen=True, slots=True)
class ApplicationStateImportMetadata:
    source_digest: str
    source_version: int
    target_version: int
    schema_revision: str
    audit_count: int
    usage_count: int
    outbox_count: int
    alert_notification_count: int
    alert_runtime_count: int

    def to_dict(self) -> dict[str, str | int]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ChatStateImportMetadata:
    source_digest: str
    source_version: int
    target_version: int
    schema_revision: str
    prior_application_state_digest: str
    thread_count: int
    folder_count: int
    attachment_count: int
    api_key_count: int
    watermark_count: int

    def to_dict(self) -> dict[str, str | int]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ValidatedLegacyState:
    source_payload: dict[str, Any]
    audit_events: tuple[AuditEvent, ...]
    usage_records: tuple[UsageRecord, ...]
    outbox_items: tuple[LegacyOutboxItem, ...]
    alert_notifications: tuple[AlertNotification, ...]
    alert_rule_runtime: tuple[AlertRuleRuntimeItem, ...]
    source_digest: str
    usage_backfilled: bool

    @property
    def metadata(self) -> ApplicationStateImportMetadata:
        return ApplicationStateImportMetadata(
            source_digest=self.source_digest,
            source_version=LEGACY_STATE_VERSION,
            target_version=RELATIONAL_STATE_VERSION,
            schema_revision=APPLICATION_STATE_IMPORT_REVISION,
            audit_count=len(self.audit_events),
            usage_count=len(self.usage_records),
            outbox_count=len(self.outbox_items),
            alert_notification_count=len(self.alert_notifications),
            alert_runtime_count=len(self.alert_rule_runtime),
        )


@dataclass(frozen=True, slots=True)
class ValidatedV3ChatState:
    source_payload: dict[str, Any]
    application_metadata: ApplicationStateImportMetadata
    chat_threads: tuple[ChatThread, ...]
    chat_folders: tuple[ChatFolder, ...]
    chat_attachments: tuple[ChatAttachment, ...]
    user_api_keys: tuple[UserApiKeyRecord, ...]
    source_digest: str

    @property
    def metadata(self) -> ChatStateImportMetadata:
        return ChatStateImportMetadata(
            source_digest=self.source_digest,
            source_version=RELATIONAL_STATE_VERSION,
            target_version=CHAT_RELATIONAL_STATE_VERSION,
            schema_revision=CHAT_STATE_IMPORT_REVISION,
            prior_application_state_digest=self.application_metadata.source_digest,
            thread_count=len(self.chat_threads),
            folder_count=len(self.chat_folders),
            attachment_count=len(self.chat_attachments),
            api_key_count=len(self.user_api_keys),
            # Version 3 never had an authoritative issued-before source. Empty
            # means active sessions retain their existing validity semantics.
            watermark_count=0,
        )


@dataclass(frozen=True, slots=True)
class ImportResult:
    state_version: int
    audit_imported: int
    audit_skipped: int
    usage_imported: int
    usage_skipped: int
    outbox_imported: int
    outbox_skipped: int
    alert_notification_imported: int = 0
    alert_notification_skipped: int = 0
    alert_runtime_imported: int = 0
    alert_runtime_skipped: int = 0
    marker_created: bool = False
    source_digest: str = ""

    def to_dict(self) -> dict[str, str | int | bool]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ChatImportResult:
    state_version: int
    thread_imported: int
    thread_skipped: int
    folder_imported: int
    folder_skipped: int
    attachment_imported: int
    attachment_skipped: int
    api_key_imported: int
    api_key_skipped: int
    watermark_imported: int = 0
    watermark_skipped: int = 0
    marker_created: bool = False
    source_digest: str = ""

    def to_dict(self) -> dict[str, str | int | bool]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class RuntimeStatePreparation:
    payload: dict[str, Any]
    metadata: ApplicationStateImportMetadata
    import_result: ImportResult | None
    rewritten: bool
    chat_metadata: ChatStateImportMetadata | None = None
    chat_import_result: ChatImportResult | None = None


def _reject_nonfinite_json(value: str) -> None:
    raise ValueError(f"Non-finite JSON number {value!r} is not supported.")


def _reject_duplicate_object_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    materialized: dict[str, Any] = {}
    for key, value in pairs:
        if key in materialized:
            raise ValueError(f"Duplicate JSON object key {key!r} is not supported.")
        materialized[key] = value
    return materialized


def _read_payload(state_path: Path) -> dict[str, Any]:
    try:
        raw_payload = json.loads(
            state_path.read_text(encoding="utf-8"),
            parse_constant=_reject_nonfinite_json,
            object_pairs_hook=_reject_duplicate_object_keys,
        )
    except OSError as exc:
        raise StateImportError(f"Could not read runtime state at {state_path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise StateImportError(
            f"Runtime state at {state_path} is not valid JSON: line {exc.lineno}, "
            f"column {exc.colno}."
        ) from exc
    except ValueError as exc:
        raise StateImportError(f"Runtime state at {state_path} is not strict JSON.") from exc
    if not isinstance(raw_payload, dict):
        raise StateImportError("Runtime state must be a JSON object.")
    return raw_payload


def read_runtime_state_payload(state_path: str | Path) -> dict[str, Any]:
    """Read strict runtime JSON for A7 cutover/tombstone verification."""

    return _read_payload(resolve_repo_path(state_path))


def _strict_version(payload: dict[str, Any]) -> int:
    version = payload.get("version")
    supported_versions = {
        LEGACY_STATE_VERSION,
        RELATIONAL_STATE_VERSION,
        CHAT_RELATIONAL_STATE_VERSION,
    }
    if type(version) is not int or version not in supported_versions:
        raise StateImportError(
            "Unsupported runtime-state version; expected "
            f"{LEGACY_STATE_VERSION}, {RELATIONAL_STATE_VERSION}, or "
            f"{CHAT_RELATIONAL_STATE_VERSION}."
        )
    return version


def _safe_validation_error(key: str, index: int, exc: ValidationError) -> StateImportError:
    safe_errors = exc.errors(include_input=False, include_url=False)
    return StateImportError(f"Invalid {key}[{index}]: {safe_errors}")


def _validate_model_list(
    payload: dict[str, Any],
    key: str,
    model_type: type[BaseModel],
) -> list[Any]:
    raw_records = payload.get(key, [])
    if not isinstance(raw_records, list):
        raise StateImportError(f"Runtime-state field {key!r} must be an array.")
    validated: list[Any] = []
    seen_ids: set[str] = set()
    for index, raw_record in enumerate(raw_records):
        try:
            record = model_type.model_validate(raw_record)
        except ValidationError as exc:
            raise _safe_validation_error(key, index, exc) from exc
        record_id = getattr(record, "id", None)
        if isinstance(record_id, str):
            if record_id in seen_ids:
                raise StateImportError(
                    f"Runtime-state field {key!r} contains duplicate id {record_id!r}."
                )
            seen_ids.add(record_id)
        validated.append(record)
    return validated


def _validate_exact_model_list(
    payload: dict[str, Any],
    key: str,
    model_type: type[BaseModel],
) -> list[Any]:
    """Validate a SQL-owned list without silently discarding unknown fields."""

    raw_records = payload.get(key, [])
    if not isinstance(raw_records, list):
        raise StateImportError(f"Runtime-state field {key!r} must be an array.")
    validated: list[Any] = []
    seen_ids: set[str] = set()
    for index, raw_record in enumerate(raw_records):
        if not isinstance(raw_record, dict):
            raise StateImportError(f"Invalid {key}[{index}]: expected an object.")
        unknown = sorted(set(raw_record).difference(model_type.model_fields))
        if unknown:
            raise StateImportError(f"Invalid {key}[{index}]: unknown fields {', '.join(unknown)}.")
        try:
            record = model_type.model_validate(raw_record, strict=True)
        except ValidationError as exc:
            raise _safe_validation_error(key, index, exc) from exc
        record_id = getattr(record, "id", None)
        if isinstance(record_id, str):
            if record_id in seen_ids:
                raise StateImportError(
                    f"Runtime-state field {key!r} contains duplicate id {record_id!r}."
                )
            seen_ids.add(record_id)
        validated.append(record)
    return validated


def _reject_unknown_nested_fields(
    raw_value: Any,
    model_type: type[BaseModel],
    label: str,
) -> None:
    if not isinstance(raw_value, dict):
        return
    unknown = sorted(set(raw_value).difference(model_type.model_fields))
    if unknown:
        raise StateImportError(f"Invalid {label}: unknown fields {', '.join(unknown)}.")


def _validate_chat_threads(payload: dict[str, Any]) -> list[ChatThread]:
    raw_threads = payload.get("chat_threads", [])
    if not isinstance(raw_threads, list):
        raise StateImportError("Runtime-state field 'chat_threads' must be an array.")
    for thread_index, raw_thread in enumerate(raw_threads):
        if not isinstance(raw_thread, dict):
            continue
        raw_messages = raw_thread.get("messages", [])
        if not isinstance(raw_messages, list):
            raise StateImportError(
                f"Invalid chat_threads[{thread_index}].messages: expected an array."
            )
        for message_index, raw_message in enumerate(raw_messages):
            label = f"chat_threads[{thread_index}].messages[{message_index}]"
            if not isinstance(raw_message, dict):
                raise StateImportError(f"Invalid {label}: expected an object.")
            _reject_unknown_nested_fields(raw_message, ChatMessage, label)
            for nested_key, nested_type in (
                ("attachments", ChatAttachment),
                ("citations", ChatCitation),
                ("activityTrace", ChatActivityTraceStep),
            ):
                nested_values = raw_message.get(nested_key)
                if nested_values is None:
                    continue
                if not isinstance(nested_values, list):
                    raise StateImportError(f"Invalid {label}.{nested_key}: expected an array.")
                for nested_index, nested_value in enumerate(nested_values):
                    _reject_unknown_nested_fields(
                        nested_value,
                        nested_type,
                        f"{label}.{nested_key}[{nested_index}]",
                    )
    return list(_validate_exact_model_list(payload, "chat_threads", ChatThread))


def _validate_chat_sessions_projection(
    payload: dict[str, Any],
    threads: list[ChatThread],
) -> None:
    sessions = list(_validate_exact_model_list(payload, "chat_sessions", ChatSession))
    expected = {
        thread.id: ChatSession.model_validate(
            thread.model_dump(mode="json", exclude={"messages"}),
            strict=True,
        ).model_dump(mode="json")
        for thread in threads
    }
    actual = {session.id: session.model_dump(mode="json") for session in sessions}
    if len(sessions) != len(threads) or actual != expected:
        raise StateImportError(
            "Runtime-state field 'chat_sessions' must exactly match the projection "
            "derived from chat_threads."
        )


def _validate_chat_relationships(
    payload: dict[str, Any],
    threads: list[ChatThread],
    folders: list[ChatFolder],
    attachments: list[ChatAttachment],
    api_keys: list[UserApiKeyRecord],
) -> None:
    tenants = {tenant.id: tenant for tenant in _validate_model_list(payload, "tenants", Tenant)}
    users = {user.id: user for user in _validate_model_list(payload, "users", User)}

    def validate_owner(*, owner_user_id: str, tenant_id: str, label: str) -> User:
        if tenant_id not in tenants:
            raise StateImportError(f"{label} references unknown tenant {tenant_id!r}.")
        owner = users.get(owner_user_id)
        if owner is None:
            raise StateImportError(f"{label} references unknown owner {owner_user_id!r}.")
        if owner.role != Role.PLATFORM_OWNER and owner.tenant_id != tenant_id:
            raise StateImportError(f"{label} crosses tenant ownership boundaries.")
        return owner

    folders_by_id = {folder.id: folder for folder in folders}
    for index, folder in enumerate(folders):
        validate_owner(
            owner_user_id=folder.owner_user_id,
            tenant_id=folder.tenant_id,
            label=f"chat_folders[{index}]",
        )

    for index, thread in enumerate(threads):
        validate_owner(
            owner_user_id=thread.owner_user_id,
            tenant_id=thread.tenant_id,
            label=f"chat_threads[{index}]",
        )
        if thread.folder_id is not None:
            folder = folders_by_id.get(thread.folder_id)
            if (
                folder is None
                or folder.tenant_id != thread.tenant_id
                or folder.owner_user_id != thread.owner_user_id
            ):
                raise StateImportError(
                    f"chat_threads[{index}] references a folder outside its owner and tenant."
                )

    for index, attachment in enumerate(attachments):
        label = f"chat_attachments[{index}]"
        if not isinstance(attachment.id, str) or not attachment.id:
            raise StateImportError(f"{label} requires a nonempty id.")
        if attachment.size_bytes is not None and attachment.size_bytes < 0:
            raise StateImportError(f"{label} has a negative size_bytes value.")
        if attachment.tenant_id is not None and attachment.tenant_id not in tenants:
            raise StateImportError(f"{label} references unknown tenant {attachment.tenant_id!r}.")
        owner = users.get(attachment.owner_user_id) if attachment.owner_user_id else None
        if attachment.owner_user_id is not None and owner is None:
            raise StateImportError(
                f"{label} references unknown owner {attachment.owner_user_id!r}."
            )
        if owner is not None and owner.role != Role.PLATFORM_OWNER:
            if attachment.tenant_id != owner.tenant_id:
                raise StateImportError(f"{label} crosses tenant ownership boundaries.")

    seen_user_ids: set[str] = set()
    seen_hashes: set[str] = set()
    for index, record in enumerate(api_keys):
        label = f"user_api_keys[{index}]"
        if record.id != record.user_id:
            raise StateImportError(f"{label} id must exactly match user_id.")
        user = users.get(record.user_id)
        if user is None:
            raise StateImportError(f"{label} references unknown user {record.user_id!r}.")
        expected_tenant = None if user.role == Role.PLATFORM_OWNER else user.tenant_id
        if record.tenant_id != expected_tenant:
            raise StateImportError(f"{label} tenant does not match its user.")
        if len(record.key_hash) != 64 or any(
            character not in "0123456789abcdef" for character in record.key_hash
        ):
            raise StateImportError(f"{label} key_hash must be a lowercase SHA-256 digest.")
        if record.user_id in seen_user_ids:
            raise StateImportError(
                "Runtime-state field 'user_api_keys' contains duplicate user_id "
                f"{record.user_id!r}."
            )
        if record.key_hash in seen_hashes:
            raise StateImportError(
                "Runtime-state field 'user_api_keys' contains a duplicate key_hash."
            )
        seen_user_ids.add(record.user_id)
        seen_hashes.add(record.key_hash)


def _validate_audit_events(payload: dict[str, Any]) -> list[AuditEvent]:
    return list(_validate_model_list(payload, "audit_events", AuditEvent))


def _validate_usage_records(payload: dict[str, Any]) -> list[UsageRecord]:
    records = list(_validate_model_list(payload, "usage_records", UsageRecord))
    _validate_usage_values(records)
    return records


def _validate_usage_values(records: list[UsageRecord]) -> None:
    for index, record in enumerate(records):
        token_values = (record.prompt_tokens, record.completion_tokens, record.total_tokens)
        if record.message_count < 1 or any(
            value is not None and value < 0 for value in token_values
        ):
            raise StateImportError(
                f"Invalid usage_records[{index}]: message_count must be positive and "
                "reported tokens must be nonnegative."
            )


def _validate_outbox(payload: dict[str, Any]) -> list[LegacyOutboxItem]:
    raw_events = payload.get("elastic_events", [])
    if not isinstance(raw_events, list):
        raise StateImportError("Runtime-state field 'elastic_events' must be an array.")
    validated: list[LegacyOutboxItem] = []
    seen_keys: set[str] = set()
    for index, raw_event in enumerate(raw_events):
        if not isinstance(raw_event, dict):
            raise StateImportError(f"Invalid elastic_events[{index}]: expected an object.")
        canonical = _canonical_json(raw_event)
        event_id_value = raw_event.get("id")
        event_id = event_id_value if isinstance(event_id_value, str) and event_id_value else None
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        dedupe_key = f"audit:{event_id}" if event_id else f"legacy:{index}:{digest}"
        if dedupe_key in seen_keys:
            raise StateImportError(
                f"Runtime-state field 'elastic_events' contains duplicate key {dedupe_key!r}."
            )
        seen_keys.add(dedupe_key)
        tenant_value = raw_event.get("tenant_id")
        validated.append(
            LegacyOutboxItem(
                dedupe_key=dedupe_key,
                event_id=event_id,
                tenant_id=tenant_value if isinstance(tenant_value, str) else None,
                payload=dict(raw_event),
            )
        )
    return validated


def _validate_alert_notifications(payload: dict[str, Any]) -> list[AlertNotification]:
    return list(_validate_model_list(payload, "alert_notifications", AlertNotification))


def _validate_alert_runtime(payload: dict[str, Any]) -> list[AlertRuleRuntimeItem]:
    rules = list(_validate_model_list(payload, "alert_rules", AlertRule))
    return [
        AlertRuleRuntimeItem(rule_id=rule.id, last_triggered_at=rule.last_triggered_at)
        for rule in rules
        if rule.last_triggered_at is not None
    ]


def _parse_iso_timestamp(value: str | None) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _as_utc(parsed)


def _usage_token(usage: dict[str, int] | None, key: str) -> int | None:
    if not isinstance(usage, dict):
        return None
    value = usage.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    tokens = int(value)
    return tokens if tokens >= 0 else None


def _deterministic_usage_id(
    thread: ChatThread,
    message_index: int,
    message_id: str,
    created_at_iso: str,
) -> str:
    identity = "\x1f".join((thread.id, str(message_index), message_id, created_at_iso))
    return f"usage-backfill-{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"


def _backfill_legacy_usage(payload: dict[str, Any]) -> list[UsageRecord]:
    threads = list(_validate_model_list(payload, "chat_threads", ChatThread))
    users = {user.id: user for user in _validate_model_list(payload, "users", User)}
    models = {model.id: model for model in _validate_model_list(payload, "models", ModelConfig)}
    records: list[UsageRecord] = []
    for thread in threads:
        owner = users.get(thread.owner_user_id)
        model = models.get(thread.model_id)
        for message_index, message in enumerate(thread.messages):
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
                    id=_deterministic_usage_id(
                        thread,
                        message_index,
                        message.id,
                        message.createdAtIso or "",
                    ),
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
    return records[-LEGACY_USAGE_RECORDS_MAX:]


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _model_json_with_utc(model: BaseModel) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    for field in ("created_at", "delivered_at", "last_triggered_at"):
        value = getattr(model, field, None)
        if isinstance(value, datetime):
            updates[field] = _as_utc(value)
    normalized = model.model_copy(update=updates) if updates else model
    return normalized.model_dump(mode="json")


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _state_digest(
    audit_events: list[AuditEvent],
    usage_records: list[UsageRecord],
    outbox_items: list[LegacyOutboxItem],
    notifications: list[AlertNotification],
    alert_runtime: list[AlertRuleRuntimeItem],
) -> str:
    canonical_state = {
        "source_version": LEGACY_STATE_VERSION,
        "audit_events": [
            {
                key: value
                for key, value in _model_json_with_utc(event).items()
                if key not in {"severity", "severity_reason"}
            }
            for event in audit_events
        ],
        "usage_records": [_model_json_with_utc(record) for record in usage_records],
        "elastic_events": [
            {
                "dedupe_key": item.dedupe_key,
                "event_id": item.event_id,
                "tenant_id": item.tenant_id,
                "payload": item.payload,
            }
            for item in outbox_items
        ],
        "alert_notifications": [
            _model_json_with_utc(notification) for notification in notifications
        ],
        "alert_rule_runtime": [
            {
                "rule_id": item.rule_id,
                "last_triggered_at": _as_utc(item.last_triggered_at).isoformat()
                if item.last_triggered_at is not None
                else None,
            }
            for item in sorted(alert_runtime, key=lambda item: item.rule_id)
        ],
    }
    return hashlib.sha256(_canonical_json(canonical_state).encode("utf-8")).hexdigest()


def _canonical_v3_chat_payload(
    payload: dict[str, Any],
    threads: list[ChatThread],
    folders: list[ChatFolder],
    attachments: list[ChatAttachment],
    api_keys: list[UserApiKeyRecord],
) -> dict[str, Any]:
    """Return the semantic v3 source whose A5 values exactly match SQL rows."""

    canonical = deepcopy(payload)
    canonical["chat_threads"] = [thread.model_dump(mode="json") for thread in threads]
    canonical["chat_folders"] = [folder.model_dump(mode="json") for folder in folders]
    canonical["chat_sessions"] = [
        ChatSession.model_validate(
            thread.model_dump(mode="json", exclude={"messages"}),
            strict=True,
        ).model_dump(mode="json")
        for thread in threads
    ]
    canonical["chat_attachments"] = [
        attachment.model_dump(mode="json") for attachment in attachments
    ]
    canonical["user_api_keys"] = [record.model_dump(mode="json") for record in api_keys]
    return canonical


def validate_v3_chat_state(payload: dict[str, Any]) -> ValidatedV3ChatState:
    """Strictly validate the one-time v3 chat/API-key authority cutover."""

    try:
        _canonical_json(payload)
    except (TypeError, ValueError) as exc:
        raise StateImportError("Version 3 runtime state is not strict JSON.") from exc
    if _strict_version(payload) != RELATIONAL_STATE_VERSION:
        raise StateImportError(
            f"Chat-state import requires version {RELATIONAL_STATE_VERSION}; "
            f"version {CHAT_RELATIONAL_STATE_VERSION} must be verified instead."
        )
    retired = sorted(RELATIONAL_STATE_RETIRED_FIELDS.intersection(payload))
    if retired:
        raise StateImportError(
            f"Version 3 runtime state contains SQL-owned fields: {', '.join(retired)}."
        )
    unsupported_watermarks = sorted(UNSUPPORTED_LEGACY_WATERMARK_FIELDS.intersection(payload))
    if unsupported_watermarks:
        raise StateImportError(
            "Version 3 runtime state contains unsupported session watermarks "
            f"({', '.join(unsupported_watermarks)}); "
            "no authoritative legacy watermark source exists."
        )

    application_metadata = _parse_v3_metadata(payload)
    threads = _validate_chat_threads(payload)
    folders = list(_validate_exact_model_list(payload, "chat_folders", ChatFolder))
    attachments = list(_validate_exact_model_list(payload, "chat_attachments", ChatAttachment))
    api_keys = list(_validate_exact_model_list(payload, "user_api_keys", UserApiKeyRecord))
    _validate_chat_sessions_projection(payload, threads)
    _validate_chat_relationships(payload, threads, folders, attachments, api_keys)
    canonical = _canonical_v3_chat_payload(payload, threads, folders, attachments, api_keys)
    try:
        source_digest = hashlib.sha256(_canonical_json(canonical).encode("utf-8")).hexdigest()
    except (TypeError, ValueError) as exc:
        raise StateImportError("Version 3 runtime state is not strict JSON.") from exc
    return ValidatedV3ChatState(
        source_payload=payload,
        application_metadata=application_metadata,
        chat_threads=tuple(threads),
        chat_folders=tuple(folders),
        chat_attachments=tuple(attachments),
        user_api_keys=tuple(api_keys),
        source_digest=source_digest,
    )


def validate_legacy_state(payload: dict[str, Any]) -> ValidatedLegacyState:
    if _strict_version(payload) != LEGACY_STATE_VERSION:
        raise StateImportError(
            f"Runtime-state import requires version {LEGACY_STATE_VERSION}; "
            f"version {RELATIONAL_STATE_VERSION} must be verified instead."
        )
    audit_events = _validate_audit_events(payload)
    usage_backfilled = "usage_records" not in payload
    usage_records = (
        _backfill_legacy_usage(payload) if usage_backfilled else _validate_usage_records(payload)
    )
    outbox_items = _validate_outbox(payload)
    notifications = _validate_alert_notifications(payload)
    alert_runtime = _validate_alert_runtime(payload)
    digest = _state_digest(
        audit_events,
        usage_records,
        outbox_items,
        notifications,
        alert_runtime,
    )
    return ValidatedLegacyState(
        source_payload=payload,
        audit_events=tuple(audit_events),
        usage_records=tuple(usage_records),
        outbox_items=tuple(outbox_items),
        alert_notifications=tuple(notifications),
        alert_rule_runtime=tuple(alert_runtime),
        source_digest=digest,
        usage_backfilled=usage_backfilled,
    )


def load_legacy_state(state_path: str | Path) -> ValidatedLegacyState:
    return validate_legacy_state(_read_payload(resolve_repo_path(state_path)))


def _insert_if_absent(
    session: Session,
    row: Any,
    key_attribute: InstrumentedAttribute[Any],
    key: str,
    matches_existing: Callable[[Any], bool],
    entity_label: str,
) -> bool:
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        existing = session.scalar(select(type(row)).where(key_attribute == key))
        if existing is None:
            raise
        if not matches_existing(existing):
            raise StateImportError(
                f"Database {entity_label} {key!r} conflicts with the runtime-state payload."
            ) from None
        return False
    return True


def _audit_matches(row: AuditEventRow, event: AuditEvent) -> bool:
    excluded = {"severity", "severity_reason"}
    normalized = AuditEvent.model_validate(event.model_dump(mode="json"))
    normalized.created_at = _as_utc(normalized.created_at)
    return row.to_model().model_dump(exclude=excluded) == normalized.model_dump(exclude=excluded)


def _usage_matches(row: UsageRecordRow, record: UsageRecord) -> bool:
    normalized = UsageRecord.model_validate(record.model_dump(mode="json"))
    normalized.created_at = _as_utc(normalized.created_at)
    return row.to_model().model_dump() == normalized.model_dump()


def _outbox_matches(row: AuditOutboxRow, item: LegacyOutboxItem) -> bool:
    return (
        row.event_id == item.event_id
        and row.tenant_id == item.tenant_id
        and row.payload == item.payload
    )


def _notification_matches(row: AlertNotificationRow, notification: AlertNotification) -> bool:
    expected = AlertNotification.model_validate(notification.model_dump(mode="json"))
    expected.created_at = _as_utc(expected.created_at)
    if expected.delivered_at is not None:
        expected.delivered_at = _as_utc(expected.delivered_at)
    return row.to_model().model_dump() == expected.model_dump()


def _runtime_matches(row: AlertRuleRuntimeRow, item: AlertRuleRuntimeItem) -> bool:
    if row.last_triggered_at is None or item.last_triggered_at is None:
        return row.last_triggered_at is item.last_triggered_at
    return _as_utc(row.last_triggered_at) == _as_utc(item.last_triggered_at)


def _marker_matches(
    marker: RuntimeStateImportRow,
    metadata: ApplicationStateImportMetadata,
) -> bool:
    return (
        marker.source_digest == metadata.source_digest
        and marker.source_version == metadata.source_version
        and marker.target_version == metadata.target_version
        and marker.audit_count == metadata.audit_count
        and marker.usage_count == metadata.usage_count
        and marker.outbox_count == metadata.outbox_count
        and marker.alert_notification_count == metadata.alert_notification_count
        and marker.alert_runtime_count == metadata.alert_runtime_count
    )


def _skipped_result(state: ValidatedLegacyState) -> ImportResult:
    return ImportResult(
        state_version=LEGACY_STATE_VERSION,
        audit_imported=0,
        audit_skipped=len(state.audit_events),
        usage_imported=0,
        usage_skipped=len(state.usage_records),
        outbox_imported=0,
        outbox_skipped=len(state.outbox_items),
        alert_notification_imported=0,
        alert_notification_skipped=len(state.alert_notifications),
        alert_runtime_imported=0,
        alert_runtime_skipped=len(state.alert_rule_runtime),
        marker_created=False,
        source_digest=state.source_digest,
    )


def _assert_strict_import_counts(
    session: Session,
    metadata: ApplicationStateImportMetadata,
) -> None:
    expected = {
        "audit": metadata.audit_count,
        "usage": metadata.usage_count,
        "outbox": metadata.outbox_count,
        "alert_notification": metadata.alert_notification_count,
        "alert_runtime": metadata.alert_runtime_count,
    }
    if imported_row_counts(session) != expected:
        raise StateImportError(
            "Application database contains rows outside the verified runtime-state import."
        )


def import_validated_state(
    session: Session,
    state: ValidatedLegacyState,
    *,
    strict_counts: bool = False,
) -> ImportResult:
    """Import every SQL-owned v2 collection and its marker in one transaction."""

    metadata = state.metadata
    existing_marker = session.get(RuntimeStateImportRow, state.source_digest)
    if existing_marker is not None:
        if not _marker_matches(existing_marker, metadata):
            raise StateImportError("Existing runtime-state import marker conflicts with v2 state.")
        if strict_counts:
            _assert_strict_import_counts(session, metadata)
        return _skipped_result(state)

    marker = RuntimeStateImportRow(
        source_digest=metadata.source_digest,
        source_version=metadata.source_version,
        target_version=metadata.target_version,
        completed_at=datetime.now(UTC),
        audit_count=metadata.audit_count,
        usage_count=metadata.usage_count,
        outbox_count=metadata.outbox_count,
        alert_notification_count=metadata.alert_notification_count,
        alert_runtime_count=metadata.alert_runtime_count,
    )
    try:
        with session.begin_nested():
            session.add(marker)
            session.flush()
    except IntegrityError:
        concurrent_marker = session.get(RuntimeStateImportRow, state.source_digest)
        if concurrent_marker is None or not _marker_matches(concurrent_marker, metadata):
            raise StateImportError(
                "Concurrent runtime-state import marker conflicts with v2 state."
            )
        if strict_counts:
            _assert_strict_import_counts(session, metadata)
        return _skipped_result(state)

    audit_imported = sum(
        _insert_if_absent(
            session,
            AuditEventRow.from_model(event),
            AuditEventRow.id,
            event.id,
            lambda row, event=event: _audit_matches(row, event),
            "audit event",
        )
        for event in state.audit_events
    )
    usage_imported = sum(
        _insert_if_absent(
            session,
            UsageRecordRow.from_model(record),
            UsageRecordRow.id,
            record.id,
            lambda row, record=record: _usage_matches(row, record),
            "usage record",
        )
        for record in state.usage_records
    )
    outbox_imported = sum(
        _insert_if_absent(
            session,
            AuditOutboxRow(
                dedupe_key=item.dedupe_key,
                event_id=item.event_id,
                tenant_id=item.tenant_id,
                payload=item.payload,
            ),
            AuditOutboxRow.dedupe_key,
            item.dedupe_key,
            lambda row, item=item: _outbox_matches(row, item),
            "audit outbox item",
        )
        for item in state.outbox_items
    )
    notification_imported = sum(
        _insert_if_absent(
            session,
            AlertNotificationRow.from_model(notification),
            AlertNotificationRow.id,
            notification.id,
            lambda row, notification=notification: _notification_matches(row, notification),
            "alert notification",
        )
        for notification in state.alert_notifications
    )
    runtime_imported = sum(
        _insert_if_absent(
            session,
            AlertRuleRuntimeRow(
                rule_id=item.rule_id,
                last_triggered_at=item.last_triggered_at,
            ),
            AlertRuleRuntimeRow.rule_id,
            item.rule_id,
            lambda row, item=item: _runtime_matches(row, item),
            "alert-rule runtime",
        )
        for item in state.alert_rule_runtime
    )
    if strict_counts:
        _assert_strict_import_counts(session, metadata)
    return ImportResult(
        state_version=LEGACY_STATE_VERSION,
        audit_imported=audit_imported,
        audit_skipped=len(state.audit_events) - audit_imported,
        usage_imported=usage_imported,
        usage_skipped=len(state.usage_records) - usage_imported,
        outbox_imported=outbox_imported,
        outbox_skipped=len(state.outbox_items) - outbox_imported,
        alert_notification_imported=notification_imported,
        alert_notification_skipped=len(state.alert_notifications) - notification_imported,
        alert_runtime_imported=runtime_imported,
        alert_runtime_skipped=len(state.alert_rule_runtime) - runtime_imported,
        marker_created=True,
        source_digest=state.source_digest,
    )


def _chat_thread_matches(row: ChatThreadRow, thread: ChatThread) -> bool:
    return row.to_model().model_dump(mode="json") == thread.model_dump(mode="json")


def _chat_folder_matches(row: ChatFolderRow, folder: ChatFolder) -> bool:
    return row.to_model().model_dump(mode="json") == folder.model_dump(mode="json")


def _chat_attachment_matches(row: ChatAttachmentRow, attachment: ChatAttachment) -> bool:
    return row.to_model().model_dump(mode="json") == attachment.model_dump(mode="json")


def _api_key_matches(row: UserApiKeyRow, record: UserApiKeyRecord) -> bool:
    return row.to_model().model_dump(mode="json") == record.model_dump(mode="json")


def _chat_marker_matches(
    marker: ChatStateImportRow,
    metadata: ChatStateImportMetadata,
) -> bool:
    return (
        marker.source_digest == metadata.source_digest
        and marker.source_version == metadata.source_version
        and marker.target_version == metadata.target_version
        and marker.prior_application_state_digest == metadata.prior_application_state_digest
        and marker.thread_count == metadata.thread_count
        and marker.folder_count == metadata.folder_count
        and marker.attachment_count == metadata.attachment_count
        and marker.api_key_count == metadata.api_key_count
        and marker.watermark_count == metadata.watermark_count
    )


def _skipped_chat_result(state: ValidatedV3ChatState) -> ChatImportResult:
    return ChatImportResult(
        state_version=RELATIONAL_STATE_VERSION,
        thread_imported=0,
        thread_skipped=len(state.chat_threads),
        folder_imported=0,
        folder_skipped=len(state.chat_folders),
        attachment_imported=0,
        attachment_skipped=len(state.chat_attachments),
        api_key_imported=0,
        api_key_skipped=len(state.user_api_keys),
        watermark_imported=0,
        watermark_skipped=0,
        marker_created=False,
        source_digest=state.source_digest,
    )


def chat_imported_row_counts(session: Session) -> dict[str, int]:
    return {
        "thread": session.scalar(select(func.count()).select_from(ChatThreadRow)) or 0,
        "folder": session.scalar(select(func.count()).select_from(ChatFolderRow)) or 0,
        "attachment": session.scalar(select(func.count()).select_from(ChatAttachmentRow)) or 0,
        "api_key": session.scalar(select(func.count()).select_from(UserApiKeyRow)) or 0,
        "watermark": session.scalar(select(func.count()).select_from(UserSessionWatermarkRow)) or 0,
    }


def _assert_strict_chat_import_counts(
    session: Session,
    metadata: ChatStateImportMetadata,
) -> None:
    expected = {
        "thread": metadata.thread_count,
        "folder": metadata.folder_count,
        "attachment": metadata.attachment_count,
        "api_key": metadata.api_key_count,
        "watermark": metadata.watermark_count,
    }
    if chat_imported_row_counts(session) != expected:
        raise StateImportError(
            "Application database contains chat rows outside the verified v3 import."
        )


def _existing_api_key_rows(session: Session, record: UserApiKeyRecord) -> list[UserApiKeyRow]:
    return list(
        session.scalars(
            select(UserApiKeyRow).where(
                or_(
                    UserApiKeyRow.id == record.id,
                    UserApiKeyRow.user_id == record.user_id,
                    UserApiKeyRow.key_hash == record.key_hash,
                )
            )
        )
    )


def _insert_api_key_if_absent(session: Session, record: UserApiKeyRecord) -> bool:
    existing = _existing_api_key_rows(session, record)
    if existing:
        if len(existing) == 1 and _api_key_matches(existing[0], record):
            return False
        raise StateImportError(
            f"Database user API key {record.id!r} conflicts with the runtime-state payload."
        )
    try:
        with session.begin_nested():
            session.add(UserApiKeyRow.from_model(record))
            session.flush()
    except IntegrityError:
        existing = _existing_api_key_rows(session, record)
        if len(existing) == 1 and _api_key_matches(existing[0], record):
            return False
        raise StateImportError(
            f"Database user API key {record.id!r} conflicts with the runtime-state payload."
        ) from None
    return True


def import_validated_chat_state(
    session: Session,
    state: ValidatedV3ChatState,
    *,
    strict_counts: bool = False,
) -> ChatImportResult:
    """Import every A5 SQL-owned collection and its receipt atomically."""

    metadata = state.metadata
    existing_marker = session.get(ChatStateImportRow, state.source_digest)
    if existing_marker is not None:
        if not _chat_marker_matches(existing_marker, metadata):
            raise StateImportError("Existing chat-state import marker conflicts with v3 state.")
        if strict_counts:
            _assert_strict_chat_import_counts(session, metadata)
        return _skipped_chat_result(state)

    marker = ChatStateImportRow(
        source_digest=metadata.source_digest,
        source_version=metadata.source_version,
        target_version=metadata.target_version,
        completed_at=datetime.now(UTC),
        prior_application_state_digest=metadata.prior_application_state_digest,
        thread_count=metadata.thread_count,
        folder_count=metadata.folder_count,
        attachment_count=metadata.attachment_count,
        api_key_count=metadata.api_key_count,
        watermark_count=metadata.watermark_count,
    )
    try:
        with session.begin_nested():
            session.add(marker)
            session.flush()
    except IntegrityError:
        concurrent_marker = session.get(ChatStateImportRow, state.source_digest)
        if concurrent_marker is None or not _chat_marker_matches(concurrent_marker, metadata):
            raise StateImportError("Concurrent chat-state import marker conflicts with v3 state.")
        if strict_counts:
            _assert_strict_chat_import_counts(session, metadata)
        return _skipped_chat_result(state)

    thread_imported = sum(
        _insert_if_absent(
            session,
            ChatThreadRow.from_model(thread),
            ChatThreadRow.id,
            thread.id,
            lambda row, thread=thread: _chat_thread_matches(row, thread),
            "chat thread",
        )
        for thread in state.chat_threads
    )
    folder_imported = sum(
        _insert_if_absent(
            session,
            ChatFolderRow.from_model(folder),
            ChatFolderRow.id,
            folder.id,
            lambda row, folder=folder: _chat_folder_matches(row, folder),
            "chat folder",
        )
        for folder in state.chat_folders
    )
    attachment_imported = sum(
        _insert_if_absent(
            session,
            ChatAttachmentRow.from_model(attachment),
            ChatAttachmentRow.id,
            attachment.id or "",
            lambda row, attachment=attachment: _chat_attachment_matches(row, attachment),
            "chat attachment",
        )
        for attachment in state.chat_attachments
    )
    api_key_imported = sum(
        _insert_api_key_if_absent(session, record) for record in state.user_api_keys
    )
    if strict_counts:
        _assert_strict_chat_import_counts(session, metadata)
    return ChatImportResult(
        state_version=RELATIONAL_STATE_VERSION,
        thread_imported=thread_imported,
        thread_skipped=len(state.chat_threads) - thread_imported,
        folder_imported=folder_imported,
        folder_skipped=len(state.chat_folders) - folder_imported,
        attachment_imported=attachment_imported,
        attachment_skipped=len(state.chat_attachments) - attachment_imported,
        api_key_imported=api_key_imported,
        api_key_skipped=len(state.user_api_keys) - api_key_imported,
        watermark_imported=0,
        watermark_skipped=0,
        marker_created=True,
        source_digest=state.source_digest,
    )


def _metadata_from_marker(marker: RuntimeStateImportRow) -> ApplicationStateImportMetadata:
    return ApplicationStateImportMetadata(
        source_digest=marker.source_digest,
        source_version=marker.source_version,
        target_version=marker.target_version,
        schema_revision=APPLICATION_STATE_IMPORT_REVISION,
        audit_count=marker.audit_count,
        usage_count=marker.usage_count,
        outbox_count=marker.outbox_count,
        alert_notification_count=marker.alert_notification_count,
        alert_runtime_count=marker.alert_runtime_count,
    )


def _chat_metadata_from_marker(marker: ChatStateImportRow) -> ChatStateImportMetadata:
    return ChatStateImportMetadata(
        source_digest=marker.source_digest,
        source_version=marker.source_version,
        target_version=marker.target_version,
        schema_revision=CHAT_STATE_IMPORT_REVISION,
        prior_application_state_digest=marker.prior_application_state_digest,
        thread_count=marker.thread_count,
        folder_count=marker.folder_count,
        attachment_count=marker.attachment_count,
        api_key_count=marker.api_key_count,
        watermark_count=marker.watermark_count,
    )


def _parse_v3_metadata(payload: dict[str, Any]) -> ApplicationStateImportMetadata:
    raw = payload.get(APPLICATION_STATE_METADATA_KEY)
    if not isinstance(raw, dict):
        raise StateImportError("Version 3 runtime state is missing application-state metadata.")
    required_ints = (
        "source_version",
        "target_version",
        "audit_count",
        "usage_count",
        "outbox_count",
        "alert_notification_count",
        "alert_runtime_count",
    )
    if any(type(raw.get(key)) is not int or raw[key] < 0 for key in required_ints):
        raise StateImportError("Version 3 application-state metadata has invalid counts.")
    digest = raw.get("source_digest")
    revision = raw.get("schema_revision")
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
        or not isinstance(revision, str)
    ):
        raise StateImportError("Version 3 application-state metadata is invalid.")
    metadata = ApplicationStateImportMetadata(
        source_digest=digest,
        source_version=raw["source_version"],
        target_version=raw["target_version"],
        schema_revision=revision,
        audit_count=raw["audit_count"],
        usage_count=raw["usage_count"],
        outbox_count=raw["outbox_count"],
        alert_notification_count=raw["alert_notification_count"],
        alert_runtime_count=raw["alert_runtime_count"],
    )
    if metadata.target_version != RELATIONAL_STATE_VERSION:
        raise StateImportError("Version 3 application-state target version does not match.")
    if metadata.schema_revision != APPLICATION_STATE_IMPORT_REVISION:
        raise StateImportError("Version 3 application-state import revision does not match.")
    return metadata


def _parse_v4_chat_metadata(payload: dict[str, Any]) -> ChatStateImportMetadata:
    raw = payload.get(CHAT_STATE_METADATA_KEY)
    if not isinstance(raw, dict):
        raise StateImportError("Version 4 runtime state is missing chat-state metadata.")
    required_ints = (
        "source_version",
        "target_version",
        "thread_count",
        "folder_count",
        "attachment_count",
        "api_key_count",
        "watermark_count",
    )
    if any(type(raw.get(key)) is not int or raw[key] < 0 for key in required_ints):
        raise StateImportError("Version 4 chat-state metadata has invalid counts.")
    digest = raw.get("source_digest")
    prior_digest = raw.get("prior_application_state_digest")
    revision = raw.get("schema_revision")
    digests = (digest, prior_digest)
    if any(
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
        for value in digests
    ) or not isinstance(revision, str):
        raise StateImportError("Version 4 chat-state metadata is invalid.")
    metadata = ChatStateImportMetadata(
        source_digest=digest,
        source_version=raw["source_version"],
        target_version=raw["target_version"],
        schema_revision=revision,
        prior_application_state_digest=prior_digest,
        thread_count=raw["thread_count"],
        folder_count=raw["folder_count"],
        attachment_count=raw["attachment_count"],
        api_key_count=raw["api_key_count"],
        watermark_count=raw["watermark_count"],
    )
    if (
        metadata.source_version != RELATIONAL_STATE_VERSION
        or metadata.target_version != CHAT_RELATIONAL_STATE_VERSION
    ):
        raise StateImportError("Version 4 chat-state source or target version does not match.")
    if metadata.schema_revision != CHAT_STATE_IMPORT_REVISION:
        raise StateImportError("Version 4 chat-state import revision does not match.")
    return metadata


def _require_current_schema_revision(session: Session) -> None:
    live_revision = session.scalar(text("select version_num from alembic_version"))
    if live_revision != HEAD_REVISION:
        raise StateImportError("Application database schema is not at the current migration head.")


def _verify_application_marker(
    session: Session,
    payload: dict[str, Any],
) -> ApplicationStateImportMetadata:
    metadata = _parse_v3_metadata(payload)
    marker = session.get(RuntimeStateImportRow, metadata.source_digest)
    if marker is None or not _marker_matches(marker, metadata):
        raise StateImportError(
            "Runtime state has no matching relational import marker; refusing startup."
        )
    return metadata


def verify_v3_state(session: Session, payload: dict[str, Any]) -> ApplicationStateImportMetadata:
    if _strict_version(payload) != RELATIONAL_STATE_VERSION:
        raise StateImportError("Only version 3 runtime state can be verified.")
    retired_fields = sorted(RELATIONAL_STATE_RETIRED_FIELDS.intersection(payload))
    if retired_fields:
        raise StateImportError(
            f"Version 3 runtime state contains SQL-owned fields: {', '.join(retired_fields)}."
        )
    _require_current_schema_revision(session)
    try:
        return _verify_application_marker(session, payload)
    except StateImportError as exc:
        if "no matching relational import marker" in str(exc):
            raise StateImportError(
                "Version 3 runtime state has no matching relational import marker; "
                "refusing startup."
            ) from exc
        raise


def verify_v4_state(
    session: Session,
    payload: dict[str, Any],
) -> tuple[ApplicationStateImportMetadata, ChatStateImportMetadata]:
    if _strict_version(payload) != CHAT_RELATIONAL_STATE_VERSION:
        raise StateImportError("Only version 4 runtime state can be verified.")
    retired_fields = sorted(
        (RELATIONAL_STATE_RETIRED_FIELDS | CHAT_STATE_RETIRED_FIELDS).intersection(payload)
    )
    if retired_fields:
        raise StateImportError(
            f"Version 4 runtime state contains SQL-owned fields: {', '.join(retired_fields)}."
        )
    _require_current_schema_revision(session)
    application_metadata = _verify_application_marker(session, payload)
    chat_metadata = _parse_v4_chat_metadata(payload)
    if chat_metadata.prior_application_state_digest != application_metadata.source_digest:
        raise StateImportError(
            "Version 4 chat-state receipt is not bound to its application-state receipt."
        )
    marker = session.get(ChatStateImportRow, chat_metadata.source_digest)
    if marker is None or not _chat_marker_matches(marker, chat_metadata):
        raise StateImportError(
            "Version 4 runtime state has no matching chat-state import marker; refusing startup."
        )
    return application_metadata, chat_metadata


def build_v3_payload(state: ValidatedLegacyState) -> dict[str, Any]:
    payload = dict(state.source_payload)
    payload["version"] = RELATIONAL_STATE_VERSION
    for key in RELATIONAL_STATE_RETIRED_FIELDS:
        payload.pop(key, None)
    raw_rules = payload.get("alert_rules")
    if isinstance(raw_rules, list):
        payload["alert_rules"] = [
            {key: value for key, value in rule.items() if key != "last_triggered_at"}
            if isinstance(rule, dict)
            else rule
            for rule in raw_rules
        ]
    payload[APPLICATION_STATE_METADATA_KEY] = state.metadata.to_dict()
    return payload


def build_v4_payload(state: ValidatedV3ChatState) -> dict[str, Any]:
    payload = deepcopy(state.source_payload)
    payload["version"] = CHAT_RELATIONAL_STATE_VERSION
    for key in RELATIONAL_STATE_RETIRED_FIELDS | CHAT_STATE_RETIRED_FIELDS:
        payload.pop(key, None)
    payload[APPLICATION_STATE_METADATA_KEY] = state.application_metadata.to_dict()
    payload[CHAT_STATE_METADATA_KEY] = state.metadata.to_dict()
    return payload


def _empty_state_metadata(session: Session) -> ApplicationStateImportMetadata:
    if any(imported_row_counts(session).values()):
        raise StateImportError(
            "Runtime state is missing but the application database is not empty; "
            "refusing to create an unrelated import marker."
        )
    digest = hashlib.sha256(b"aperture-empty-application-state-v3").hexdigest()
    marker = session.get(RuntimeStateImportRow, digest)
    if marker is None:
        marker = RuntimeStateImportRow(
            source_digest=digest,
            source_version=0,
            target_version=RELATIONAL_STATE_VERSION,
            completed_at=datetime.now(UTC),
            audit_count=0,
            usage_count=0,
            outbox_count=0,
            alert_notification_count=0,
            alert_runtime_count=0,
        )
        session.add(marker)
        session.flush()
    return _metadata_from_marker(marker)


def write_runtime_state_atomic(state_path: Path, payload: dict[str, Any]) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_name(f"{state_path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        temporary.replace(state_path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare_empty_runtime_state(engine: Engine) -> RuntimeStatePreparation:
    """Create honest empty A4/A5 predecessor receipts without a JSON path.

    A7 uses this for a brand-new relational deployment whose seeded identity
    snapshot will be assembled later in ``SeedStore``. The returned v4 payload
    contains only the real predecessor receipts; no identity/config import is
    claimed here.
    """

    upgrade_database(engine)
    if engine.dialect.name == "sqlite":
        connection = engine.connect()
        dbapi_connection = connection.connection.driver_connection
        previous_autocommit = dbapi_connection.autocommit
        session: Session | None = None
        try:
            dbapi_connection.commit()
            dbapi_connection.autocommit = True
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            session = Session(bind=connection, expire_on_commit=False, autoflush=False)
            result = _prepare_empty_runtime_state_in_session(session)
            session.flush()
            connection.exec_driver_sql("COMMIT")
            return result
        except Exception:
            if dbapi_connection.in_transaction:
                connection.exec_driver_sql("ROLLBACK")
            raise
        finally:
            if session is not None:
                session.close()
            if connection.in_transaction():
                connection.rollback()
            dbapi_connection.autocommit = previous_autocommit
            connection.close()

    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        if engine.dialect.name == "postgresql":
            session.execute(
                text("select pg_advisory_xact_lock(:lock_id)"),
                {"lock_id": _EMPTY_PREDECESSOR_LOCK_ID},
            )
        return _prepare_empty_runtime_state_in_session(session)


def _prepare_empty_runtime_state_in_session(
    session: Session,
) -> RuntimeStatePreparation:
    if any(imported_row_counts(session).values()) or any(
        chat_imported_row_counts(session).values()
    ):
        raise StateImportError(
            "Cannot initialize empty predecessor receipts because the application "
            "database already contains operational or chat authority."
        )

    application_rows = list(session.scalars(select(RuntimeStateImportRow)))
    chat_rows = list(session.scalars(select(ChatStateImportRow)))
    if application_rows or chat_rows:
        if len(application_rows) != 1 or len(chat_rows) != 1:
            raise StateImportError(
                "Empty predecessor receipt initialization is partial or ambiguous."
            )
        metadata = _metadata_from_marker(application_rows[0])
        chat_metadata = _chat_metadata_from_marker(chat_rows[0])
        expected_application_digest = hashlib.sha256(
            b"aperture-empty-application-state-v3"
        ).hexdigest()
        if (
            metadata.source_digest != expected_application_digest
            or metadata.source_version != 0
            or metadata.target_version != RELATIONAL_STATE_VERSION
            or any(
                (
                    metadata.audit_count,
                    metadata.usage_count,
                    metadata.outbox_count,
                    metadata.alert_notification_count,
                    metadata.alert_runtime_count,
                    chat_metadata.thread_count,
                    chat_metadata.folder_count,
                    chat_metadata.attachment_count,
                    chat_metadata.api_key_count,
                    chat_metadata.watermark_count,
                )
            )
            or chat_metadata.source_version != RELATIONAL_STATE_VERSION
            or chat_metadata.target_version != CHAT_RELATIONAL_STATE_VERSION
            or chat_metadata.prior_application_state_digest != metadata.source_digest
        ):
            raise StateImportError(
                "Existing predecessor receipts are not the canonical empty authority."
            )
        return RuntimeStatePreparation(
            payload={
                "version": CHAT_RELATIONAL_STATE_VERSION,
                APPLICATION_STATE_METADATA_KEY: metadata.to_dict(),
                CHAT_STATE_METADATA_KEY: chat_metadata.to_dict(),
            },
            metadata=metadata,
            import_result=None,
            rewritten=False,
            chat_metadata=chat_metadata,
            chat_import_result=None,
        )

    metadata = _empty_state_metadata(session)
    v3_payload = {
        "version": RELATIONAL_STATE_VERSION,
        APPLICATION_STATE_METADATA_KEY: metadata.to_dict(),
    }
    chat_state = validate_v3_chat_state(v3_payload)
    chat_import_result = import_validated_chat_state(
        session,
        chat_state,
        strict_counts=True,
    )
    return RuntimeStatePreparation(
        payload=build_v4_payload(chat_state),
        metadata=metadata,
        import_result=None,
        rewritten=True,
        chat_metadata=chat_state.metadata,
        chat_import_result=chat_import_result,
    )


def load_predecessor_import_metadata(
    engine: Engine,
    *,
    application_source_digest: str,
    chat_source_digest: str,
) -> tuple[ApplicationStateImportMetadata, ChatStateImportMetadata]:
    """Load the exact A4/A5 receipts bound into an active A7 receipt."""

    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        application_row = session.get(RuntimeStateImportRow, application_source_digest)
        chat_row = session.get(ChatStateImportRow, chat_source_digest)
        if application_row is None or chat_row is None:
            raise StateImportError("Identity/config authority has no predecessor receipts.")
        application = _metadata_from_marker(application_row)
        chat = _chat_metadata_from_marker(chat_row)
        if (
            application.target_version != RELATIONAL_STATE_VERSION
            or chat.source_version != RELATIONAL_STATE_VERSION
            or chat.target_version != CHAT_RELATIONAL_STATE_VERSION
            or chat.prior_application_state_digest != application.source_digest
        ):
            raise StateImportError("Identity/config predecessor receipts are incompatible.")
        return application, chat


def prepare_runtime_state(engine: Engine, state_path: str | Path) -> RuntimeStatePreparation:
    """Migrate v2/v3 to v4 or verify v4 before exposing runtime state."""

    path = resolve_repo_path(state_path)
    upgrade_database(engine)
    factory = create_session_factory(engine)
    if not path.exists():
        preparation = prepare_empty_runtime_state(engine)
        write_runtime_state_atomic(path, preparation.payload)
        return preparation

    payload = _read_payload(path)
    version = _strict_version(payload)
    if version == CHAT_RELATIONAL_STATE_VERSION:
        with session_scope(factory) as session:
            metadata, chat_metadata = verify_v4_state(session, payload)
        return RuntimeStatePreparation(
            payload=payload,
            metadata=metadata,
            import_result=None,
            rewritten=False,
            chat_metadata=chat_metadata,
            chat_import_result=None,
        )

    if version == RELATIONAL_STATE_VERSION:
        chat_state = validate_v3_chat_state(payload)
        with session_scope(factory) as session:
            metadata = verify_v3_state(session, payload)
            chat_import_result = import_validated_chat_state(
                session,
                chat_state,
                strict_counts=True,
            )
        migrated = build_v4_payload(chat_state)
        write_runtime_state_atomic(path, migrated)
        return RuntimeStatePreparation(
            payload=migrated,
            metadata=metadata,
            import_result=None,
            rewritten=True,
            chat_metadata=chat_state.metadata,
            chat_import_result=chat_import_result,
        )

    state = validate_legacy_state(payload)
    with session_scope(factory) as session:
        import_result = import_validated_state(session, state, strict_counts=True)
    v3_payload = build_v3_payload(state)
    chat_state = validate_v3_chat_state(v3_payload)
    with session_scope(factory) as session:
        metadata = verify_v3_state(session, v3_payload)
        chat_import_result = import_validated_chat_state(
            session,
            chat_state,
            strict_counts=True,
        )
    migrated = build_v4_payload(chat_state)
    write_runtime_state_atomic(path, migrated)
    return RuntimeStatePreparation(
        payload=migrated,
        metadata=metadata,
        import_result=import_result,
        rewritten=True,
        chat_metadata=chat_state.metadata,
        chat_import_result=chat_import_result,
    )


def import_legacy_state(engine: Engine, state_path: str | Path) -> ImportResult:
    """Additively import v2 SQL-owned records without rewriting source JSON."""

    state = load_legacy_state(state_path)
    upgrade_database(engine)
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        return import_validated_state(session, state)


def import_v3_chat_state(engine: Engine, state_path: str | Path) -> ChatImportResult:
    """Additively import v3 chat/API-key rows without rewriting source JSON."""

    path = resolve_repo_path(state_path)
    payload = _read_payload(path)
    state = validate_v3_chat_state(payload)
    upgrade_database(engine)
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        verify_v3_state(session, payload)
        return import_validated_chat_state(session, state, strict_counts=True)


def imported_row_counts(session: Session) -> dict[str, int]:
    return {
        "audit": session.scalar(select(func.count()).select_from(AuditEventRow)) or 0,
        "usage": session.scalar(select(func.count()).select_from(UsageRecordRow)) or 0,
        "outbox": session.scalar(select(func.count()).select_from(AuditOutboxRow)) or 0,
        "alert_notification": session.scalar(select(func.count()).select_from(AlertNotificationRow))
        or 0,
        "alert_runtime": session.scalar(select(func.count()).select_from(AlertRuleRuntimeRow)) or 0,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Additively import SQL-owned rows from runtime-state v2 or v3 "
            "without rewriting the source file."
        )
    )
    parser.add_argument(
        "--state-path",
        type=Path,
        help="Runtime-state JSON path (defaults to APERTURE_RUNTIME_STATE_PATH).",
    )
    parser.add_argument(
        "--database-url",
        help="SQLAlchemy URL (defaults to APERTURE_DATABASE_URL or the SQLite path setting).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    settings = get_settings()
    state_path = args.state_path or Path(settings.runtime_state_path)
    database_url = args.database_url or settings.application_database_url
    engine = create_application_engine(database_url)
    try:
        version = _strict_version(_read_payload(resolve_repo_path(state_path)))
        if version == LEGACY_STATE_VERSION:
            result: ImportResult | ChatImportResult = import_legacy_state(engine, state_path)
        elif version == RELATIONAL_STATE_VERSION:
            result = import_v3_chat_state(engine, state_path)
        else:
            raise StateImportError(
                "Version 4 runtime state is already relational and has nothing to import."
            )
    except StateImportError as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        engine.dispose()
    print(json.dumps(result.to_dict(), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
