"""Mirror platform activity into Elasticsearch so it can be explored in Kibana.

Five streams, each written to its own index under a configurable prefix
(``aperture`` by default):

- ``audit`` -> ``<prefix>-audit``: every audit event (sign-ins, admin changes,
  uploads, deletions, security flags), delivered from the durable SQL outbox
  that is written in the same transaction as the event.
- ``usage`` -> ``<prefix>-usage``: one document per model completion with the
  provider-reported token counts.
- ``chats`` -> ``<prefix>-chats`` and ``<prefix>-chat-messages``: one document
  per conversation and one per message, re-sent whenever a thread is saved.
- ``documents`` -> ``<prefix>-documents``: chat uploads and knowledge-library
  documents.
- ``users`` -> ``<prefix>-users``: the current user directory.

Every document has a stable ``_id``, so redelivery overwrites instead of
duplicating. Delivery is at-least-once: progress (outbox rows, stream cursors,
snapshot fingerprints) only advances for documents Elastic acknowledged.
Documents Elastic rejects as malformed are counted and skipped; permission,
throttling, and server errors keep the data pending for the next pass.

Message and document text is copied only when the owner turns on
``include_content``; otherwise the export carries activity metadata only.

The target comes from the platform console (endpoint plus vaulted API key)
and falls back, field by field, to the operator environment
(``APERTURE_ELASTIC_URL`` / ``APERTURE_ELASTIC_CLOUD_ID`` /
``APERTURE_ELASTIC_API_KEY``). Console endpoints are owner input and pass
through the shared egress guard; environment endpoints are operator
configuration and do not.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import re
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.core.privacy import conceal_thread, conceal_title, privacy_policy_for
from app.core import clock
from app.core.config import Settings
from app.core.net_guard import EgressBlocked, validate_public_url, validate_request_hook
from app.models.schemas import (
    TenantPrivacyPolicy,
    ELASTIC_EXPORT_STREAMS,
    ChatAttachment,
    ChatMessage,
    ElasticExportSettings,
    KnowledgeDocument,
    UsageRecord,
    User,
)
from app.repositories.application_state import (
    ApplicationStateRepository,
    ChatThreadExportRow,
    ChatThreadGovernance,
    ChatThreadMetadataRow,
)

logger = logging.getLogger("aperture.elastic")

DEFAULT_INDEX_PREFIX = "aperture"
FLUSH_BATCH_LIMIT = 500
THREAD_BATCH_LIMIT = 50
REQUEST_TIMEOUT_SECONDS = 15.0
BULK_MAX_BYTES = 8 * 1024 * 1024
CONTENT_MAX_CHARS = 100_000
SCHEDULED_TIME_BUDGET_SECONDS = 10.0
# Tags, holds, archiving, matter moves, and retention state change threads in
# place, without the re-save the content cursor follows; a periodic scan of
# those fields (cheap: no message bodies) carries them to Elastic.
METADATA_SCAN_INTERVAL_SECONDS = 60.0
METADATA_PAGE_LIMIT = 1000
MANUAL_TIME_BUDGET_SECONDS = 25.0
_ERROR_TEXT_LIMIT = 300

STREAM_LABELS: dict[str, str] = {
    "audit": "Audit trail",
    "usage": "Model usage",
    "chats": "Chats",
    "documents": "Documents",
    "users": "Users",
}
STREAM_INDEX_SUFFIXES: dict[str, tuple[str, ...]] = {
    "audit": ("audit",),
    "usage": ("usage",),
    "chats": ("chats", "chat-messages"),
    "documents": ("documents",),
    "users": ("users",),
}
# Cursor-driven streams and the cursor names they persist.
_THREAD_CURSOR = {"chats": "chats", "documents": "documents"}
# Audit events whose target is a conversation that no longer exists.
_THREAD_DELETION_EVENTS = frozenset({"chat.thread_deleted", "retention.chat_deleted"})
_MARK_THREAD_DELETED_SCRIPT = (
    "ctx._source.thread_deleted = true; "
    "ctx._source.thread_deleted_at = params.deleted_at.get(ctx._source.thread_id);"
)

_INDEX_PREFIX_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,47}$")
_BARE_HOST_PATTERN = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d{1,5})?$")
_HOST_LABELS_PATTERN = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$")
# Bulk item errors that mean "this document can never be indexed as sent".
# Anything else (auth, missing index, throttling, shard failures) is retried.
_PERMANENT_ITEM_ERRORS = frozenset(
    {
        "mapper_parsing_exception",
        "document_parsing_exception",
        "illegal_argument_exception",
        "strict_dynamic_mapping_exception",
        "x_content_parse_exception",
        "parse_exception",
    }
)


class ElasticConfigError(ValueError):
    """The configured endpoint, API key, or index prefix is unusable.

    The message is safe to show an owner; it never contains the API key.
    """


class ElasticDeliveryError(RuntimeError):
    """Elastic could not be reached or refused a request; safe to display."""


# --- Target resolution -------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ElasticTarget:
    base_url: str
    api_key: str
    index_prefix: str
    streams: tuple[str, ...]
    include_content: bool
    endpoint_source: str  # "console" | "environment"
    api_key_source: str  # "console" | "environment"

    @property
    def signature(self) -> str:
        # Identifies "this cluster and these indices" for cursors and caches.
        material = f"{self.base_url}|{self.index_prefix}".encode()
        return hashlib.sha256(material).hexdigest()

    @property
    def host(self) -> str:
        return urlsplit(self.base_url).hostname or self.base_url

    def index(self, suffix: str) -> str:
        return f"{self.index_prefix}-{suffix}"


def console_settings(store: Any) -> ElasticExportSettings:
    platform_settings = getattr(store, "platform_settings", None)
    config = getattr(platform_settings, "elastic_export", None)
    return config if isinstance(config, ElasticExportSettings) else ElasticExportSettings()


def validate_index_prefix(value: str) -> str:
    prefix = (value or "").strip().lower()
    if not _INDEX_PREFIX_PATTERN.match(prefix):
        raise ElasticConfigError(
            "Index prefix must be 1-48 lowercase letters, digits, '-', '_' or '.', "
            "starting with a letter or digit."
        )
    return prefix


def resolve_endpoint(raw: str) -> str:
    """Return the Elasticsearch base URL for a URL, bare host, or Cloud ID."""

    value = (raw or "").strip()
    if not value:
        raise ElasticConfigError("Enter an Elasticsearch endpoint URL or Elastic Cloud ID.")
    if value.lower().startswith(("http://", "https://")):
        parts = urlsplit(value)
        if not parts.hostname:
            raise ElasticConfigError("The Elasticsearch URL has no host name.")
        if parts.username or parts.password:
            raise ElasticConfigError(
                "Remove credentials from the URL; put the API key in the API key field."
            )
        if parts.query or parts.fragment:
            raise ElasticConfigError("Remove the query string from the Elasticsearch URL.")
        try:
            parts.port  # noqa: B018 - raises ValueError for an invalid port
        except ValueError as exc:
            raise ElasticConfigError("The Elasticsearch URL has an invalid port.") from exc
        return urlunsplit((parts.scheme.lower(), parts.netloc, parts.path.rstrip("/"), "", ""))
    if "://" in value:
        raise ElasticConfigError("Use an http:// or https:// Elasticsearch URL.")
    cloud_url = _decode_cloud_id(value)
    if cloud_url:
        return cloud_url
    if _BARE_HOST_PATTERN.match(value):
        return f"https://{value}"
    raise ElasticConfigError(
        "Enter the Elasticsearch endpoint (https://…) or the deployment's Cloud ID "
        "(name:base64…) from the Elastic Cloud console."
    )


def _decode_cloud_id(value: str) -> str | None:
    _name, separator, encoded = value.partition(":")
    candidate = (encoded if separator else value).strip()
    if not candidate:
        return None
    try:
        decoded = base64.b64decode(
            candidate + "=" * (-len(candidate) % 4), validate=True
        ).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    parts = decoded.split("$")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        return None
    host, elasticsearch_id = parts[0], parts[1]
    port = ""
    if ":" in host:
        host, port = host.rsplit(":", 1)
    if ":" in elasticsearch_id:
        elasticsearch_id, port = elasticsearch_id.split(":", 1)
    if not _HOST_LABELS_PATTERN.match(host) or not _HOST_LABELS_PATTERN.match(elasticsearch_id):
        return None
    if port and not port.isdigit():
        return None
    netloc = f"{elasticsearch_id}.{host}"
    if port and port != "443":
        netloc = f"{netloc}:{port}"
    return f"https://{netloc}"


def normalize_api_key(raw: str) -> str:
    """Accept every format Kibana shows and return the encoded key.

    Kibana offers the base64 "Encoded" key, the Beats/Logstash ``id:api_key``
    pair, and the JSON creation response; all three are accepted.
    """

    value = (raw or "").strip()
    # Tolerate a pasted header ("Authorization: ApiKey <key>").
    for prefix in ("authorization:", "apikey "):
        if value.lower().startswith(prefix):
            value = value[len(prefix) :].strip()
    if value.startswith("{"):
        try:
            payload = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ElasticConfigError("The API key JSON could not be read.") from exc
        if not isinstance(payload, dict):
            raise ElasticConfigError("The API key JSON could not be read.")
        encoded = payload.get("encoded")
        if isinstance(encoded, str) and encoded.strip():
            value = encoded.strip()
        elif isinstance(payload.get("id"), str) and isinstance(payload.get("api_key"), str):
            value = f"{payload['id']}:{payload['api_key']}"
        else:
            raise ElasticConfigError("The API key JSON has no 'encoded' value.")
    if ":" in value:
        value = base64.b64encode(value.encode("utf-8")).decode("ascii")
    if not value or any(character.isspace() for character in value):
        raise ElasticConfigError(
            "That does not look like an Elastic API key. Paste the Encoded key from "
            "Kibana → Stack Management → API keys."
        )
    return value


def _console_api_key(store: Any, config: ElasticExportSettings) -> str | None:
    if not config.api_key_set:
        return None
    reader = getattr(store, "configuration_secret", None)
    if reader is None:
        return None
    try:
        return reader("elastic", "primary") or None
    except Exception:  # noqa: BLE001 - an unreadable vault entry reads as "not set"
        logger.warning("The vaulted Elastic API key could not be decrypted.")
        return None


def environment_endpoint(settings: Settings) -> str:
    return (settings.elastic_url or "").strip() or (settings.elastic_cloud_id or "").strip()


def resolve_elastic_target(
    store: Any,
    settings: Settings,
    *,
    endpoint_override: str | None = None,
    api_key_override: str | None = None,
    index_prefix_override: str | None = None,
    streams_override: Sequence[str] | None = None,
) -> ElasticTarget | None:
    """Return the effective target, or None when no endpoint/key is configured.

    Raises :class:`ElasticConfigError` for a configured but unusable value.
    """

    config = console_settings(store)
    console_endpoint = (
        endpoint_override if endpoint_override is not None else config.endpoint
    ).strip()
    if console_endpoint:
        base_url, endpoint_source = resolve_endpoint(console_endpoint), "console"
    else:
        env_endpoint = environment_endpoint(settings)
        if not env_endpoint:
            return None
        base_url, endpoint_source = resolve_endpoint(env_endpoint), "environment"

    if api_key_override is not None and api_key_override.strip():
        api_key, api_key_source = api_key_override, "console"
    else:
        api_key, api_key_source = _console_api_key(store, config), "console"
    if not api_key:
        api_key, api_key_source = settings.elastic_api_key, "environment"
    if not api_key:
        return None

    streams = config.streams if streams_override is None else list(streams_override)
    return ElasticTarget(
        base_url=base_url,
        api_key=normalize_api_key(api_key),
        index_prefix=validate_index_prefix(
            index_prefix_override if index_prefix_override is not None else config.index_prefix
        ),
        streams=tuple(stream for stream in ELASTIC_EXPORT_STREAMS if stream in streams),
        include_content=config.include_content,
        endpoint_source=endpoint_source,
        api_key_source=api_key_source,
    )


def check_target_egress(target: ElasticTarget) -> None:
    """Console endpoints are owner input; run them through the egress guard."""

    if target.endpoint_source != "console":
        return
    try:
        validate_public_url(target.base_url)
    except EgressBlocked as exc:
        raise ElasticConfigError(str(exc)) from exc


def _client(target: ElasticTarget, transport: httpx.BaseTransport | None) -> httpx.Client:
    hooks = {"request": [validate_request_hook]} if target.endpoint_source == "console" else {}
    return httpx.Client(
        base_url=target.base_url,
        timeout=REQUEST_TIMEOUT_SECONDS,
        transport=transport,
        headers={"Authorization": f"ApiKey {target.api_key}"},
        event_hooks=hooks,
    )


# --- Export state ------------------------------------------------------------


@dataclass
class StreamStats:
    delivered: int = 0
    rejected: int = 0
    last_delivery_at: str | None = None
    last_error: str | None = None
    last_rejection: str | None = None


@dataclass
class ElasticExportState:
    """Process-local delivery bookkeeping; durable progress lives in SQL."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    stats: dict[str, StreamStats] = field(default_factory=dict)
    # f"{target signature}:{stream}" -> document id -> content digest.
    fingerprints: dict[str, dict[str, str]] = field(default_factory=dict)
    ensured_indices: set[str] = field(default_factory=set)
    index_notes: dict[str, str] = field(default_factory=dict)
    last_pass_at: str | None = None
    last_contact_at: str | None = None
    # time.monotonic() of the last complete thread-metadata scan.
    metadata_scanned_at: float = 0.0
    # Deleted conversations (from durable audit events) still to be flagged.
    pending_deletions: dict[str, str] = field(default_factory=dict)

    def stream(self, name: str) -> StreamStats:
        return self.stats.setdefault(name, StreamStats())


_STATE_GUARD = threading.Lock()


def export_state(store: Any) -> ElasticExportState:
    with _STATE_GUARD:
        state = getattr(store, "elastic_export_state", None)
        if not isinstance(state, ElasticExportState):
            state = ElasticExportState()
            store.elastic_export_state = state
        return state


def _repository(store: Any) -> ApplicationStateRepository:
    repository = getattr(store, "application_state_repository", None)
    if not isinstance(repository, ApplicationStateRepository):
        raise RuntimeError("Application SQL state repository is not initialized.")
    return repository


# --- Index mappings ----------------------------------------------------------

_KEYWORD: dict[str, Any] = {"type": "keyword", "ignore_above": 1024}
_DATE: dict[str, Any] = {"type": "date"}
_LONG: dict[str, Any] = {"type": "long"}
_BOOL: dict[str, Any] = {"type": "boolean"}
_TEXT: dict[str, Any] = {"type": "text"}
_TEXT_KEYWORD: dict[str, Any] = {
    "type": "text",
    "fields": {"keyword": {"type": "keyword", "ignore_above": 512}},
}
# ``flattened`` keeps free-form metadata searchable without letting one
# event's value types collide with another's mapping.
_FLATTENED: dict[str, Any] = {"type": "flattened", "ignore_above": 1024}
_COMMON: dict[str, Any] = {
    "@timestamp": _DATE,
    "tenant_id": _KEYWORD,
    "tenant_name": _KEYWORD,
}
_OWNER: dict[str, Any] = {
    "owner_user_id": _KEYWORD,
    "owner_name": _KEYWORD,
    "owner_email": _KEYWORD,
}
_TOKENS: dict[str, Any] = {
    "prompt_tokens": _LONG,
    "completion_tokens": _LONG,
    "total_tokens": _LONG,
}
_DELETION: dict[str, Any] = {"deleted": _BOOL, "deleted_at": _DATE}
# Retention/classification tags. ``tags`` ("namespace:key") and ``tag_values``
# ("namespace:key=value") are plain keywords for quick filters; ``tag_details``
# keeps each tag's fields together (KQL: tag_details:{ namespace: "subject" }).
_TAGS: dict[str, Any] = {
    "tags": _KEYWORD,
    "tag_values": _KEYWORD,
    "tag_count": _LONG,
    "tag_sources": _KEYWORD,
    "tag_details": {
        "type": "nested",
        "properties": {
            "namespace": _KEYWORD,
            "key": _KEYWORD,
            "value": _KEYWORD,
            "source": _KEYWORD,
            "applied_at": _DATE,
            "applied_by": _KEYWORD,
            "applied_by_name": _KEYWORD,
        },
    },
    "held": _BOOL,
    "hold_ids": _KEYWORD,
    "hold_names": _KEYWORD,
}

INDEX_MAPPINGS: dict[str, dict[str, Any]] = {
    "audit": {
        "properties": {
            **_COMMON,
            "id": _KEYWORD,
            "event": _KEYWORD,
            "action_type": _KEYWORD,
            "target": _KEYWORD,
            "target_type": _KEYWORD,
            "target_name": _TEXT_KEYWORD,
            "actor_id": _KEYWORD,
            "actor_name": _KEYWORD,
            "actor_role": _KEYWORD,
            "created_at": _DATE,
            "detail": _TEXT,
            "metadata": _FLATTENED,
            "severity": _KEYWORD,
        }
    },
    "usage": {
        "properties": {
            **_COMMON,
            **_TOKENS,
            "id": _KEYWORD,
            "user_id": _KEYWORD,
            "user_name": _KEYWORD,
            "user_email": _KEYWORD,
            "user_role": _KEYWORD,
            "model_id": _KEYWORD,
            "model_name": _KEYWORD,
            "provider_name": _KEYWORD,
            "surface": _KEYWORD,
            "message_count": _LONG,
            "thread_id": _KEYWORD,
            "source": _KEYWORD,
            "created_at": _DATE,
        }
    },
    "chats": {
        "properties": {
            **_COMMON,
            **_OWNER,
            **_TOKENS,
            **_TAGS,
            **_DELETION,
            "matter_name": _KEYWORD,
            "disposition_state": _KEYWORD,
            "disposition_pending_since": _DATE,
            "thread_id": _KEYWORD,
            "title": _TEXT_KEYWORD,
            "model_id": _KEYWORD,
            "model_name": _KEYWORD,
            "group_id": _KEYWORD,
            "folder_id": _KEYWORD,
            "matter_id": _KEYWORD,
            "archived": _BOOL,
            "pinned": _BOOL,
            "used_agent": _BOOL,
            "message_count": _LONG,
            "user_message_count": _LONG,
            "assistant_message_count": _LONG,
            "attachment_count": _LONG,
            "created_at": _DATE,
            "last_activity_at": _DATE,
            "first_message_at": _DATE,
            "last_message_at": _DATE,
        }
    },
    "chat-messages": {
        "properties": {
            **_COMMON,
            **_OWNER,
            **_TOKENS,
            "message_id": _KEYWORD,
            "thread_id": _KEYWORD,
            "thread_title": _TEXT_KEYWORD,
            "role": _KEYWORD,
            "status": _KEYWORD,
            "model_id": _KEYWORD,
            "model_name": _KEYWORD,
            "created_at": _DATE,
            "completed_at": _DATE,
            "duration_ms": _LONG,
            "content": _TEXT,
            "content_length": _LONG,
            "content_truncated": _BOOL,
            "attachment_count": _LONG,
            "attachment_names": _KEYWORD,
            "citation_count": _LONG,
            "citation_sources": _KEYWORD,
            "metadata": _FLATTENED,
            "matter_id": _KEYWORD,
            "thread_tags": _KEYWORD,
            "thread_held": _BOOL,
            "thread_deleted": _BOOL,
            "thread_deleted_at": _DATE,
        }
    },
    "documents": {
        "properties": {
            **_COMMON,
            **_OWNER,
            "document_id": _KEYWORD,
            "origin": _KEYWORD,
            "name": _TEXT_KEYWORD,
            "kind": _KEYWORD,
            "mime_type": _KEYWORD,
            "size": _KEYWORD,
            "size_bytes": _LONG,
            "source_type": _KEYWORD,
            "source_uri": _KEYWORD,
            "status": _KEYWORD,
            "uploaded_at": _DATE,
            "updated_at": _DATE,
            "thread_id": _KEYWORD,
            "thread_title": _TEXT_KEYWORD,
            "knowledge_config_id": _KEYWORD,
            "knowledge_config_name": _KEYWORD,
            "chunk_count": _LONG,
            "acl_group_ids": _KEYWORD,
            "acl_group_names": _KEYWORD,
            "text_preview": _TEXT,
            **_DELETION,
            "thread_deleted": _BOOL,
            "thread_deleted_at": _DATE,
        }
    },
    "users": {
        "properties": {
            **_COMMON,
            "user_id": _KEYWORD,
            "email": _KEYWORD,
            "display_name": _TEXT_KEYWORD,
            "first_name": _KEYWORD,
            "last_name": _KEYWORD,
            "firm_name": _KEYWORD,
            "role": _KEYWORD,
            "active": _BOOL,
            "auth_method": _KEYWORD,
            "last_active": _KEYWORD,
            "group_ids": _KEYWORD,
            "group_names": _KEYWORD,
            "access_request_status": _KEYWORD,
            "access_requested_at": _DATE,
            "first_run_guide_seen_at": _DATE,
            **_DELETION,
        }
    },
}


# --- HTTP helpers ------------------------------------------------------------


def _error_reason(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return ""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            reason = error.get("reason") or error.get("type") or ""
            return str(reason)[:_ERROR_TEXT_LIMIT]
        if isinstance(error, str):
            return error[:_ERROR_TEXT_LIMIT]
        message = payload.get("message")
        if isinstance(message, str):
            return message[:_ERROR_TEXT_LIMIT]
    return ""


def describe_http_failure(response: httpx.Response, target: ElasticTarget) -> str:
    status = response.status_code
    reason = _error_reason(response)
    suffix = f" Elastic said: {reason}" if reason else ""
    if status == 401:
        return (
            "Elastic rejected the API key (HTTP 401). Check that the key is active and "
            "was pasted completely." + suffix
        )
    if status == 403:
        return (
            "The API key is valid but lacks permission (HTTP 403). Grant it the "
            f"'create_index', 'index', and 'read' privileges on '{target.index_prefix}-*'."
            + suffix
        )
    if status == 404:
        return (
            f"Elastic returned HTTP 404 for {response.request.url.path}. Make sure the endpoint "
            "is the Elasticsearch URL, not the Kibana URL." + suffix
        )
    if status == 413:
        return "Elastic refused the request as too large (HTTP 413)." + suffix
    if status == 429:
        return "Elastic is throttling requests (HTTP 429); delivery will retry." + suffix
    return f"Elastic returned HTTP {status}." + suffix


def describe_transport_failure(exc: Exception, target: ElasticTarget) -> str:
    text = str(exc) or exc.__class__.__name__
    if isinstance(exc, httpx.TimeoutException):
        return (
            f"Timed out after {REQUEST_TIMEOUT_SECONDS:.0f}s waiting for {target.host}. "
            "Check the endpoint and that the cluster is running."
        )
    if "CERTIFICATE_VERIFY_FAILED" in text or "certificate verify failed" in text.lower():
        return (
            f"The TLS certificate for {target.host} could not be verified. Use an endpoint "
            "with a publicly trusted certificate (Elastic Cloud endpoints have one)."
        )
    if isinstance(exc, httpx.ConnectError):
        return (
            f"Could not connect to {target.host}: {text[:_ERROR_TEXT_LIMIT]}. Self-managed "
            "Elasticsearch usually listens on port 9200; Elastic Cloud uses 443."
        )
    return f"Request to {target.host} failed: {text[:_ERROR_TEXT_LIMIT]}"


@dataclass(frozen=True, slots=True)
class _Doc:
    index: str
    doc_id: str
    source: dict[str, Any]
    # "index" replaces the whole document; "update" merges ``source`` into an
    # existing one (in-place changes such as tags) and skips missing documents.
    op: str = "index"


@dataclass(frozen=True, slots=True)
class _Outcome:
    status: str  # "delivered" | "skipped" | "rejected" | "retry"
    reason: str | None = None


def _encode(doc: _Doc) -> bytes:
    if doc.op == "update":
        action = json.dumps(
            {"update": {"_index": doc.index, "_id": doc.doc_id, "retry_on_conflict": 3}}
        )
        body = json.dumps({"doc": doc.source}, default=str, ensure_ascii=False)
    else:
        action = json.dumps({"index": {"_index": doc.index, "_id": doc.doc_id}})
        body = json.dumps(doc.source, default=str, ensure_ascii=False)
    return f"{action}\n{body}\n".encode()


def _bulk(ctx: _ExportContext, docs: Sequence[_Doc]) -> list[_Outcome]:
    """Index ``docs``; return one outcome per doc in order.

    Raises :class:`ElasticDeliveryError` when a request fails as a whole. Every
    document has a stable ``_id``, so re-sending after a partial failure only
    overwrites what already arrived.
    """

    outcomes: list[_Outcome] = []
    chunk: list[_Doc] = []
    chunk_lines: list[bytes] = []
    size = 0
    for doc in docs:
        encoded = _encode(doc)
        if chunk and size + len(encoded) > BULK_MAX_BYTES:
            outcomes.extend(_send_chunk(ctx, chunk, chunk_lines))
            chunk, chunk_lines, size = [], [], 0
        chunk.append(doc)
        chunk_lines.append(encoded)
        size += len(encoded)
    if chunk:
        outcomes.extend(_send_chunk(ctx, chunk, chunk_lines))
    return outcomes


def _send_chunk(ctx: _ExportContext, chunk: Sequence[_Doc], lines: Sequence[bytes]) -> list[_Outcome]:
    try:
        response = ctx.client.post(
            "/_bulk",
            content=b"".join(lines),
            headers={"Content-Type": "application/x-ndjson"},
        )
    except httpx.HTTPError as exc:
        raise ElasticDeliveryError(describe_transport_failure(exc, ctx.target)) from exc
    if response.status_code >= 300:
        raise ElasticDeliveryError(describe_http_failure(response, ctx.target))
    try:
        payload = response.json()
    except ValueError as exc:
        raise ElasticDeliveryError(
            f"{ctx.target.host} did not answer like Elasticsearch. Check that the endpoint "
            "is the Elasticsearch URL, not the Kibana URL."
        ) from exc
    ctx.state.last_contact_at = clock.now_iso()
    if not isinstance(payload, dict) or not payload.get("errors"):
        return [_Outcome("delivered")] * len(chunk)
    items = payload.get("items") or []
    outcomes: list[_Outcome] = []
    for position in range(len(chunk)):
        item = items[position] if position < len(items) else None
        action = next(iter(item.values()), None) if isinstance(item, dict) and item else None
        if not isinstance(action, dict):
            outcomes.append(_Outcome("retry", "Elastic did not report a result for this document."))
            continue
        status = int(action.get("status") or 0)
        if 200 <= status < 300:
            outcomes.append(_Outcome("delivered"))
            continue
        error = action.get("error")
        error_type = error.get("type", "") if isinstance(error, dict) else ""
        if status == 404 and error_type == "document_missing_exception":
            # A partial update for a document the export has not created yet;
            # the full document will carry the same fields when it is sent.
            outcomes.append(_Outcome("skipped"))
            continue
        error_reason = error.get("reason", "") if isinstance(error, dict) else str(error or "")
        reason = f"{error_type}: {error_reason}".strip(": ")[:_ERROR_TEXT_LIMIT]
        if status == 400 and error_type in _PERMANENT_ITEM_ERRORS:
            outcomes.append(_Outcome("rejected", reason or f"HTTP {status}"))
        else:
            outcomes.append(_Outcome("retry", reason or f"HTTP {status}"))
    return outcomes


def _ensure_indices(ctx: _ExportContext, stream: str) -> None:
    """Create the stream's indices with explicit mappings the first time."""

    for suffix in STREAM_INDEX_SUFFIXES[stream]:
        name = ctx.target.index(suffix)
        key = f"{ctx.target.signature}:{name}"
        if key in ctx.state.ensured_indices:
            continue
        try:
            response = ctx.client.put(f"/{name}", json={"mappings": INDEX_MAPPINGS[suffix]})
        except httpx.HTTPError as exc:
            raise ElasticDeliveryError(describe_transport_failure(exc, ctx.target)) from exc
        if response.status_code < 300:
            ctx.state.index_notes.pop(name, None)
        elif response.status_code == 400 and "resource_already_exists" in response.text:
            ctx.state.index_notes.pop(name, None)
            _add_new_fields(ctx, name, suffix)
        elif response.status_code == 403:
            # The key may only be allowed to write into indices an operator
            # created; bulk results will show whether writes are permitted.
            ctx.state.index_notes[name] = (
                "The API key cannot create this index, so it must already exist; "
                "Aperture's field mappings were not applied."
            )
        else:
            raise ElasticDeliveryError(describe_http_failure(response, ctx.target))
        ctx.state.last_contact_at = clock.now_iso()
        ctx.state.ensured_indices.add(key)


def _add_new_fields(ctx: _ExportContext, name: str, suffix: str) -> None:
    """Add fields introduced since the index was created (best effort).

    Elastic accepts new fields on an existing mapping; a field whose type
    already differs is left alone and noted for the owner.
    """

    try:
        response = ctx.client.put(
            f"/{name}/_mapping", json={"properties": INDEX_MAPPINGS[suffix]["properties"]}
        )
    except httpx.HTTPError:
        return
    if response.status_code == 400:
        ctx.state.index_notes[name] = (
            "This index already existed with different field types, so some Aperture "
            f"mappings were not applied. {_error_reason(response)}"
        ).strip()


# --- Document builders -------------------------------------------------------


def _iso(value: object) -> str | None:
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, str) and value.strip():
        try:
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat()


def _scalar_metadata(metadata: Mapping[str, Any]) -> dict[str, Any]:
    flattened: dict[str, Any] = {}
    for key, value in metadata.items():
        if isinstance(value, bool | int | float):
            flattened[str(key)] = value
        elif isinstance(value, str) and value:
            flattened[str(key)] = value[:1024]
    return flattened


def _digest(source: Mapping[str, Any]) -> str:
    canonical = json.dumps(source, default=str, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class _ExportContext:
    store: Any
    target: ElasticTarget
    client: httpx.Client
    state: ElasticExportState
    deadline: float
    # A manual Sync now also rescans in-place thread changes immediately.
    thorough: bool = False
    _repository: ApplicationStateRepository | None = None
    _lookups: dict[str, Mapping[str, Any]] = field(default_factory=dict)
    _governance: dict[str, ChatThreadGovernance] = field(default_factory=dict)
    _governance_complete: bool = False
    _matters: dict[str, str | None] = field(default_factory=dict)
    _privacy: dict[str, TenantPrivacyPolicy] = field(default_factory=dict)
    # Metadata digests of threads sent in full, recorded once acknowledged.
    pending_metadata: dict[str, str] = field(default_factory=dict)

    @property
    def repository(self) -> ApplicationStateRepository:
        if self._repository is None:
            self._repository = _repository(self.store)
        return self._repository

    def out_of_time(self) -> bool:
        return time.monotonic() >= self.deadline

    def privacy_policy(self, tenant_id: str) -> TenantPrivacyPolicy:
        if tenant_id not in self._privacy:
            self._privacy[tenant_id] = privacy_policy_for(self.store, tenant_id)
        return self._privacy[tenant_id]

    def cursor(self, name: str) -> int:
        return self.repository.elastic_export_cursor(name, self.target.signature)

    def set_cursor(self, name: str, position: int) -> None:
        self.repository.set_elastic_export_cursor(name, self.target.signature, position)

    def fingerprints(self, stream: str) -> dict[str, str]:
        return self.state.fingerprints.setdefault(f"{self.target.signature}:{stream}", {})

    def record(self, stream: str, outcomes: Sequence[_Outcome]) -> int:
        stats = self.state.stream(stream)
        delivered = sum(1 for outcome in outcomes if outcome.status == "delivered")
        rejected = [outcome for outcome in outcomes if outcome.status == "rejected"]
        retry = next((outcome for outcome in outcomes if outcome.status == "retry"), None)
        stats.delivered += delivered
        stats.rejected += len(rejected)
        if rejected:
            stats.last_rejection = rejected[-1].reason
            logger.warning(
                "Elastic rejected %d %s document(s): %s", len(rejected), stream, rejected[-1].reason
            )
        if delivered:
            stats.last_delivery_at = clock.now_iso()
        if retry is not None:
            raise ElasticDeliveryError(
                f"Elastic did not accept every document; they will be retried. {retry.reason}"
            )
        return delivered

    # Lookups are read once per pass and only when a builder needs them.
    def tenant_name(self, tenant_id: str | None) -> str | None:
        tenant = self._tenants().get(tenant_id or "")
        return getattr(tenant, "name", None)

    def user(self, user_id: str | None) -> User | None:
        user = self._users().get(user_id or "")
        return user if isinstance(user, User) else None

    def model_name(self, model_id: str | None) -> str | None:
        model = self._lookup("models").get(model_id or "")
        return getattr(model, "name", None)

    def group_name(self, group_id: str) -> str | None:
        return getattr(self._lookup("groups").get(group_id), "name", None)

    def knowledge_config_name(self, config_id: str) -> str | None:
        return getattr(self._lookup("knowledge_configs").get(config_id), "name", None)

    def _tenants(self) -> Mapping[str, Any]:
        return self._lookup("tenants")

    def _users(self) -> Mapping[str, Any]:
        return self._lookup("users")

    def _lookup(self, name: str) -> Mapping[str, Any]:
        if name not in self._lookups:
            value = getattr(self.store, name, None)
            self._lookups[name] = dict(value) if isinstance(value, Mapping) else {}
        return self._lookups[name]

    def prefetch_threads(self, thread_ids: Iterable[str], matter_ids: Iterable[str | None]) -> None:
        if not self._governance_complete:
            missing = [tid for tid in thread_ids if tid not in self._governance]
            if missing:
                self._governance.update(self.repository.chat_thread_governance(missing))
        self.prefetch_matters(matter_ids)

    def prefetch_all_governance(self) -> None:
        if not self._governance_complete:
            self._governance = dict(self.repository.chat_thread_governance(None))
            self._governance_complete = True

    def prefetch_matters(self, matter_ids: Iterable[str | None]) -> None:
        missing = [mid for mid in dict.fromkeys(matter_ids) if mid and mid not in self._matters]
        if missing:
            found = self.repository.matter_names(missing)
            self._matters.update({mid: found.get(mid) for mid in missing})

    def governance(self, thread_id: str) -> ChatThreadGovernance:
        governance = self._governance.get(thread_id)
        if governance is None and not self._governance_complete:
            governance = self.repository.chat_thread_governance([thread_id]).get(thread_id)
            if governance is not None:
                self._governance[thread_id] = governance
        return governance or ChatThreadGovernance()

    def matter_name(self, matter_id: str | None) -> str | None:
        if not matter_id:
            return None
        if matter_id not in self._matters:
            self.prefetch_matters([matter_id])
        return self._matters.get(matter_id)

    def owner_fields(self, user_id: str | None) -> dict[str, Any]:
        user = self.user(user_id)
        return {
            "owner_user_id": user_id,
            "owner_name": user.display_name if user else None,
            "owner_email": user.email if user else None,
        }


def _audit_document(ctx: _ExportContext, payload: Mapping[str, Any]) -> dict[str, Any]:
    source = dict(payload)
    metadata = source.get("metadata")
    if metadata is not None and not isinstance(metadata, Mapping):
        source["metadata"] = {"value": str(metadata)[:1024]}
    tenant_id = source.get("tenant_id")
    source["tenant_name"] = ctx.tenant_name(tenant_id if isinstance(tenant_id, str) else None)
    source["@timestamp"] = _iso(source.get("created_at")) or clock.now_iso()
    return source


def _usage_document(ctx: _ExportContext, record: UsageRecord) -> dict[str, Any]:
    user = ctx.user(record.user_id)
    created_at = _iso(record.created_at)
    return {
        "@timestamp": created_at,
        "id": record.id,
        "tenant_id": record.tenant_id,
        "tenant_name": ctx.tenant_name(record.tenant_id),
        "user_id": record.user_id,
        "user_name": record.user_name or (user.display_name if user else None),
        "user_email": user.email if user else None,
        "user_role": record.user_role,
        "model_id": record.model_id,
        "model_name": ctx.model_name(record.model_id),
        "provider_name": record.provider_name,
        "surface": record.surface,
        "message_count": record.message_count,
        "prompt_tokens": record.prompt_tokens,
        "completion_tokens": record.completion_tokens,
        "total_tokens": record.total_tokens,
        "thread_id": record.thread_id,
        "source": record.source,
        "created_at": created_at,
    }


def _message_time(message: ChatMessage) -> str | None:
    return _iso(message.createdAtIso) or _iso(message.executedAt) or _iso(message.completedAt)


def _usage_value(message: ChatMessage, key: str) -> int | None:
    value = (message.usage or {}).get(key)
    return value if isinstance(value, int) and value >= 0 else None


def _sum_reported(values: Iterable[int | None]) -> int | None:
    reported = [value for value in values if value is not None]
    return sum(reported) if reported else None


def _governance_fields(ctx: _ExportContext, governance: ChatThreadGovernance) -> dict[str, Any]:
    tags = governance.tags
    details: list[dict[str, Any]] = []
    for tag in tags:
        applier = ctx.user(tag.applied_by)
        details.append(
            {
                "namespace": tag.namespace,
                "key": tag.key,
                "value": tag.value,
                "source": tag.source,
                "applied_at": _iso(tag.applied_at),
                "applied_by": tag.applied_by,
                "applied_by_name": applier.display_name if applier else None,
            }
        )
    return {
        "tags": sorted({f"{tag.namespace}:{tag.key}" for tag in tags}),
        "tag_values": sorted({f"{tag.namespace}:{tag.key}={tag.value}" for tag in tags if tag.value}),
        "tag_count": len(tags),
        "tag_sources": sorted({tag.source for tag in tags}),
        "tag_details": details,
        "held": bool(governance.holds),
        "hold_ids": [hold_id for hold_id, _name in governance.holds],
        "hold_names": [name for _hold_id, name in governance.holds],
    }


def _thread_metadata(
    ctx: _ExportContext,
    *,
    thread_id: str,
    title: str,
    archived: bool,
    pinned: bool,
    folder_id: str | None,
    matter_id: str | None,
    disposition_state: str | None,
    disposition_pending_since: datetime | None,
) -> dict[str, Any]:
    """Thread fields that can change without a re-save, shared by full and partial sends."""

    return {
        "title": title,
        "archived": archived,
        "pinned": pinned,
        "folder_id": folder_id,
        "matter_id": matter_id,
        "matter_name": ctx.matter_name(matter_id),
        "disposition_state": disposition_state,
        "disposition_pending_since": _iso(disposition_pending_since),
        **_governance_fields(ctx, ctx.governance(thread_id)),
        "deleted": False,
        "deleted_at": None,
    }


def _metadata_from_row(ctx: _ExportContext, row: ChatThreadMetadataRow) -> dict[str, Any]:
    return _thread_metadata(
        ctx,
        thread_id=row.id,
        # Concealed exactly as the full send conceals it, so the metadata
        # digest matches and the rescan never re-sends a raw title.
        title=conceal_title(row.title, ctx.privacy_policy(row.tenant_id)),
        archived=row.archived,
        pinned=row.pinned,
        folder_id=row.folder_id,
        matter_id=row.matter_id,
        disposition_state=row.disposition_state,
        disposition_pending_since=row.disposition_pending_since,
    )


def _mark_threads_deleted(ctx: _ExportContext, deletions: Mapping[str, str]) -> int:
    """Flag deleted conversations in Elastic instead of erasing them.

    Elastic is the organization's monitoring copy: a user deleting a chat must
    not remove the record of it. The thread document gets ``deleted`` and its
    messages and uploads get ``thread_deleted`` so views can include or hide them.
    """

    delivered = 0
    thread_ids = list(deletions)
    for start in range(0, len(thread_ids), FLUSH_BATCH_LIMIT):
        chunk = thread_ids[start : start + FLUSH_BATCH_LIMIT]
        if "chats" in ctx.target.streams:
            docs = [
                _Doc(
                    ctx.target.index("chats"),
                    thread_id,
                    {"deleted": True, "deleted_at": deletions[thread_id]},
                    op="update",
                )
                for thread_id in chunk
            ]
            delivered += ctx.record("chats", _bulk(ctx, docs))
            _mark_by_thread(ctx, ctx.target.index("chat-messages"), chunk, deletions)
        if "documents" in ctx.target.streams:
            _mark_by_thread(ctx, ctx.target.index("documents"), chunk, deletions)
    return delivered


def _mark_by_thread(
    ctx: _ExportContext, index: str, thread_ids: Sequence[str], deletions: Mapping[str, str]
) -> None:
    try:
        response = ctx.client.post(
            f"/{index}/_update_by_query",
            params={"conflicts": "proceed"},
            json={
                "query": {"terms": {"thread_id": list(thread_ids)}},
                "script": {
                    "lang": "painless",
                    "source": _MARK_THREAD_DELETED_SCRIPT,
                    "params": {"deleted_at": {tid: deletions[tid] for tid in thread_ids}},
                },
            },
        )
    except httpx.HTTPError as exc:
        raise ElasticDeliveryError(describe_transport_failure(exc, ctx.target)) from exc
    if response.status_code == 404:
        return  # Nothing was ever exported to this index.
    if response.status_code == 403:
        # Flagging by thread searches the index, which needs 'read'. The
        # conversation document itself is already flagged; say what is missing.
        ctx.state.index_notes[index] = (
            "Deleted conversations are flagged on their chat document, but this API key "
            f"lacks 'read' on '{ctx.target.index_prefix}-*', so their messages and uploads "
            "are not marked thread_deleted. Add 'read' to the key to mark them too."
        )
        return
    if response.status_code >= 300:
        raise ElasticDeliveryError(describe_http_failure(response, ctx.target))
    ctx.state.index_notes.pop(index, None)


def _thread_documents(ctx: _ExportContext, row: ChatThreadExportRow) -> list[_Doc]:
    # Personal-data protection covers what leaves for Elastic too, including
    # history saved before the organization turned it on.
    thread = conceal_thread(row.thread, ctx.privacy_policy(row.thread.tenant_id))[0]
    tenant = {"tenant_id": thread.tenant_id, "tenant_name": ctx.tenant_name(thread.tenant_id)}
    owner = ctx.owner_fields(thread.owner_user_id)
    model_name = ctx.model_name(thread.model_id)
    created_at = _iso(row.created_at)
    message_times = [time_ for time_ in (_message_time(m) for m in thread.messages) if time_]
    thread_time = _iso(row.last_activity_at) or created_at or clock.now_iso()
    metadata = _thread_metadata(
        ctx,
        thread_id=thread.id,
        title=thread.title,
        archived=thread.archived,
        pinned=thread.pinned,
        folder_id=thread.folder_id,
        matter_id=thread.matter_id,
        disposition_state=row.disposition_state,
        disposition_pending_since=row.disposition_pending_since,
    )
    ctx.pending_metadata[thread.id] = _digest(metadata)
    docs: list[_Doc] = [
        _Doc(
            ctx.target.index("chats"),
            thread.id,
            {
                "@timestamp": thread_time,
                **tenant,
                **owner,
                **metadata,
                "thread_id": thread.id,
                "model_id": thread.model_id,
                "model_name": model_name,
                "group_id": thread.group_id or None,
                "used_agent": thread.used_agent,
                "message_count": len(thread.messages),
                "user_message_count": sum(1 for m in thread.messages if m.role == "user"),
                "assistant_message_count": sum(
                    1 for m in thread.messages if m.role == "assistant"
                ),
                "attachment_count": sum(len(m.attachments or []) for m in thread.messages),
                "prompt_tokens": _sum_reported(
                    _usage_value(m, "prompt_tokens") for m in thread.messages
                ),
                "completion_tokens": _sum_reported(
                    _usage_value(m, "completion_tokens") for m in thread.messages
                ),
                "total_tokens": _sum_reported(
                    _usage_value(m, "total_tokens") for m in thread.messages
                ),
                "created_at": created_at,
                "last_activity_at": _iso(row.last_activity_at),
                "first_message_at": min(message_times) if message_times else None,
                "last_message_at": max(message_times) if message_times else None,
            },
        )
    ]
    for message in thread.messages:
        content = message.content or ""
        source: dict[str, Any] = {
            "@timestamp": _message_time(message) or created_at or thread_time,
            **tenant,
            **owner,
            "message_id": message.id,
            "thread_id": thread.id,
            "thread_title": thread.title,
            "matter_id": thread.matter_id,
            "thread_tags": metadata["tags"],
            "thread_held": metadata["held"],
            "thread_deleted": False,
            "role": message.role,
            "status": message.status,
            "model_id": thread.model_id,
            "model_name": model_name,
            "created_at": _message_time(message),
            "completed_at": _iso(message.completedAt),
            "duration_ms": message.durationMs,
            "prompt_tokens": _usage_value(message, "prompt_tokens"),
            "completion_tokens": _usage_value(message, "completion_tokens"),
            "total_tokens": _usage_value(message, "total_tokens"),
            "content_length": len(content),
            "attachment_count": len(message.attachments or []),
            "attachment_names": [attachment.name for attachment in message.attachments or []],
            "citation_count": len(message.citations),
            "citation_sources": sorted({c.source_name for c in message.citations if c.source_name}),
        }
        if ctx.target.include_content:
            source["content"] = content[:CONTENT_MAX_CHARS]
            source["content_truncated"] = len(content) > CONTENT_MAX_CHARS
            source["metadata"] = _scalar_metadata(message.metadata)
        docs.append(_Doc(ctx.target.index("chat-messages"), f"{thread.id}:{message.id}", source))
    return docs


def _attachment_documents(ctx: _ExportContext, row: ChatThreadExportRow) -> list[_Doc]:
    thread = row.thread
    embedded: dict[str, ChatAttachment] = {}
    for message in thread.messages:
        for attachment in message.attachments or []:
            if attachment.id:
                embedded[attachment.id] = attachment
    if not embedded:
        return []
    stored = ctx.repository.chat_attachments_by_id(embedded)
    docs: list[_Doc] = []
    for attachment_id, fallback in embedded.items():
        attachment = stored.get(attachment_id, fallback)
        tenant_id = attachment.tenant_id or thread.tenant_id
        source: dict[str, Any] = {
            "@timestamp": _iso(attachment.uploaded_at) or _iso(row.created_at) or clock.now_iso(),
            "tenant_id": tenant_id,
            "tenant_name": ctx.tenant_name(tenant_id),
            **ctx.owner_fields(attachment.owner_user_id or thread.owner_user_id),
            "document_id": attachment_id,
            "origin": "chat_upload",
            "name": attachment.name,
            "kind": attachment.kind,
            "mime_type": attachment.mime_type,
            "size": attachment.size,
            "size_bytes": attachment.size_bytes,
            "source_type": attachment.source_type,
            # Local uploads only have an internal storage path; cloud imports
            # keep the link back to their source system.
            "source_uri": attachment.source_uri if attachment.source_type != "upload" else None,
            "status": attachment.status,
            "uploaded_at": _iso(attachment.uploaded_at),
            "thread_id": thread.id,
            "thread_title": conceal_title(thread.title, ctx.privacy_policy(thread.tenant_id)),
        }
        privacy = ctx.privacy_policy(tenant_id)
        if privacy.enabled:
            source["name"] = conceal_title(attachment.name, privacy)
        if ctx.target.include_content and attachment.text_preview:
            preview = attachment.text_preview[:CONTENT_MAX_CHARS]
            source["text_preview"] = conceal_title(preview, privacy) if privacy.enabled else preview
        docs.append(_Doc(ctx.target.index("documents"), f"attachment:{attachment_id}", source))
    return docs


def _knowledge_documents(ctx: _ExportContext) -> list[_Doc]:
    documents = getattr(ctx.store, "knowledge_documents", None)
    if not isinstance(documents, Mapping):
        return []
    docs: list[_Doc] = []
    for config_id, items in documents.items():
        for document in items or []:
            if not isinstance(document, KnowledgeDocument):
                continue
            docs.append(
                _Doc(
                    ctx.target.index("documents"),
                    f"knowledge:{document.id}",
                    {
                        "@timestamp": _iso(document.updated_at),
                        "tenant_id": document.tenant_id,
                        "tenant_name": ctx.tenant_name(document.tenant_id),
                        "document_id": document.id,
                        "origin": "knowledge_library",
                        "name": document.name,
                        "source_type": document.source_type,
                        "source_uri": document.source_uri,
                        "status": document.status,
                        "chunk_count": document.chunk_count,
                        "updated_at": _iso(document.updated_at),
                        "knowledge_config_id": config_id,
                        "knowledge_config_name": ctx.knowledge_config_name(config_id),
                        "acl_group_ids": list(document.acl_group_ids),
                        "acl_group_names": [
                            name
                            for name in (ctx.group_name(gid) for gid in document.acl_group_ids)
                            if name
                        ],
                        "deleted": False,
                    },
                )
            )
    return docs


def _user_documents(ctx: _ExportContext) -> list[_Doc]:
    docs: list[_Doc] = []
    for user in ctx._users().values():
        if not isinstance(user, User):
            continue
        docs.append(
            _Doc(
                ctx.target.index("users"),
                user.id,
                {
                    "tenant_id": user.tenant_id,
                    "tenant_name": ctx.tenant_name(user.tenant_id),
                    "user_id": user.id,
                    "email": user.email,
                    "display_name": user.display_name,
                    "first_name": user.first_name,
                    "last_name": user.last_name,
                    "firm_name": user.firm_name,
                    "role": str(user.role),
                    "active": user.active,
                    "auth_method": user.auth_method,
                    "last_active": user.last_active,
                    "group_ids": list(user.group_ids),
                    "group_names": [
                        name for name in (ctx.group_name(gid) for gid in user.group_ids) if name
                    ],
                    "access_request_status": user.access_request_status,
                    "access_requested_at": _iso(user.access_requested_at),
                    "first_run_guide_seen_at": _iso(user.first_run_guide_seen_at),
                    "deleted": False,
                },
            )
        )
    return docs


# --- Stream exporters --------------------------------------------------------


def _export_audit(ctx: _ExportContext) -> int:
    repository = ctx.repository
    index = ctx.target.index("audit")
    total = 0
    while True:
        batch = repository.pending_outbox(limit=FLUSH_BATCH_LIMIT)
        if not batch:
            return total
        docs = [
            _Doc(index, row.event_id or row.dedupe_key, _audit_document(ctx, row.payload))
            for row in batch
        ]
        outcomes = _bulk(ctx, docs)
        # Rejected rows can never be indexed as sent; they leave the queue so
        # they cannot block every later event. The audit log keeps them.
        finished = [
            row.sequence
            for row, outcome in zip(batch, outcomes, strict=True)
            if outcome.status != "retry"
        ]
        repository.mark_outbox_delivered(finished, delivered_at=clock.now())
        _mark_deleted_from_audit(ctx, batch, outcomes)
        total += ctx.record("audit", outcomes)
        if len(batch) < FLUSH_BATCH_LIMIT or ctx.out_of_time():
            return total


def _mark_deleted_from_audit(
    ctx: _ExportContext, batch: Sequence[Any], outcomes: Sequence[_Outcome]
) -> None:
    """Deletion audit events are durable, so they flag deleted chats even
    across restarts, when the in-memory metadata scan has nothing to compare."""

    if not {"chats", "documents"} & set(ctx.target.streams):
        return
    deletions: dict[str, str] = {}
    for row, outcome in zip(batch, outcomes, strict=True):
        payload = row.payload
        target = payload.get("target")
        if (
            outcome.status != "retry"
            and payload.get("event") in _THREAD_DELETION_EVENTS
            and isinstance(target, str)
            and target
        ):
            deletions[target] = _iso(payload.get("created_at")) or clock.now_iso()
    if not deletions:
        return
    ctx.state.pending_deletions.update(deletions)
    try:
        _flush_pending_deletions(ctx)
    except ElasticDeliveryError as exc:
        # Kept in pending_deletions; the chats stream retries and reports it.
        logger.warning("Could not flag deleted conversations yet: %s", exc)


def _flush_pending_deletions(ctx: _ExportContext) -> int:
    pending = dict(ctx.state.pending_deletions)
    if not pending:
        return 0
    for stream in ("chats", "documents"):
        if stream in ctx.target.streams:
            _ensure_indices(ctx, stream)
    delivered = _mark_threads_deleted(ctx, pending)
    cache = ctx.fingerprints("chat-metadata")
    for thread_id in pending:
        ctx.state.pending_deletions.pop(thread_id, None)
        cache.pop(thread_id, None)
    return delivered


def _settled_position(sequences: Sequence[int], ok: Sequence[bool], start: int) -> int:
    """Advance through the leading run of fully acknowledged rows."""

    position = start
    for sequence, acknowledged in zip(sequences, ok, strict=True):
        if not acknowledged:
            break
        position = sequence
    return position


def _export_usage(ctx: _ExportContext) -> int:
    repository = ctx.repository
    index = ctx.target.index("usage")
    cursor = ctx.cursor("usage")
    total = 0
    while True:
        rows = repository.usage_after_sequence(cursor, limit=FLUSH_BATCH_LIMIT)
        if not rows:
            return total
        docs = [_Doc(index, record.id, _usage_document(ctx, record)) for _seq, record in rows]
        outcomes = _bulk(ctx, docs)
        new_cursor = _settled_position(
            [sequence for sequence, _record in rows],
            [outcome.status != "retry" for outcome in outcomes],
            cursor,
        )
        if new_cursor != cursor:
            cursor = new_cursor
            ctx.set_cursor("usage", cursor)
        total += ctx.record("usage", outcomes)
        if len(rows) < FLUSH_BATCH_LIMIT or ctx.out_of_time():
            return total


def _export_thread_stream(
    ctx: _ExportContext,
    stream: str,
    build: Callable[[_ExportContext, ChatThreadExportRow], list[_Doc]],
) -> int:
    cursor_name = _THREAD_CURSOR[stream]
    cursor = ctx.cursor(cursor_name)
    stats = ctx.state.stream(stream)
    before = stats.delivered
    while True:
        rows = ctx.repository.chat_threads_after_sequence(cursor, limit=THREAD_BATCH_LIMIT)
        if not rows:
            return stats.delivered - before
        acknowledged, retry_reason = _send_threads(ctx, stream, rows, build)
        new_cursor = _settled_position([row.sequence for row in rows], acknowledged, cursor)
        if new_cursor != cursor:
            cursor = new_cursor
            ctx.set_cursor(cursor_name, cursor)
        if retry_reason is not None:
            ctx.record(stream, [_Outcome("retry", retry_reason)])
        if len(rows) < THREAD_BATCH_LIMIT or ctx.out_of_time():
            return stats.delivered - before


def _send_threads(
    ctx: _ExportContext,
    stream: str,
    rows: Sequence[ChatThreadExportRow],
    build: Callable[[_ExportContext, ChatThreadExportRow], list[_Doc]],
) -> tuple[list[bool], str | None]:
    """Send whole threads.

    Returns, per row, whether Elastic acknowledged all of it, plus the first
    reason a document must be retried (None when everything was accepted).
    """

    if stream == "chats":
        ctx.prefetch_threads(
            [row.thread.id for row in rows], [row.thread.matter_id for row in rows]
        )
    per_row = [build(ctx, row) for row in rows]
    docs = [doc for row_docs in per_row for doc in row_docs]
    outcomes = _bulk(ctx, docs) if docs else []
    acknowledged: list[bool] = []
    offset = 0
    for row, row_docs in zip(rows, per_row, strict=True):
        row_outcomes = outcomes[offset : offset + len(row_docs)]
        offset += len(row_docs)
        ok = all(outcome.status != "retry" for outcome in row_outcomes)
        acknowledged.append(ok)
        digest = ctx.pending_metadata.pop(row.thread.id, None)
        if stream == "chats" and ok and digest is not None:
            ctx.fingerprints("chat-metadata")[row.thread.id] = digest
    ctx.record(stream, [outcome for outcome in outcomes if outcome.status != "retry"])
    retry = next((outcome for outcome in outcomes if outcome.status == "retry"), None)
    return acknowledged, (retry.reason or "Elastic did not accept every document.") if retry else None


def _export_snapshot(ctx: _ExportContext, stream: str, docs: Sequence[_Doc]) -> int:
    """Send documents that changed since this process last sent them, and flag
    ones that disappeared (a deleted user or library document) as deleted."""

    cache = ctx.fingerprints(stream)
    current_ids = {doc.doc_id for doc in docs}
    total = 0
    # An empty snapshot is treated as "could not read", never as "everything
    # was deleted", so a transient empty store cannot flag every record.
    removed = [doc_id for doc_id in cache if doc_id not in current_ids] if docs else []
    if removed:
        deleted_at = clock.now_iso()
        index = ctx.target.index(STREAM_INDEX_SUFFIXES[stream][0])
        for start in range(0, len(removed), FLUSH_BATCH_LIMIT):
            batch_ids = removed[start : start + FLUSH_BATCH_LIMIT]
            marks = [
                _Doc(index, doc_id, {"deleted": True, "deleted_at": deleted_at}, op="update")
                for doc_id in batch_ids
            ]
            outcomes = _bulk(ctx, marks)
            for doc_id, outcome in zip(batch_ids, outcomes, strict=True):
                if outcome.status != "retry":
                    cache.pop(doc_id, None)
            total += ctx.record(stream, outcomes)
    changed = [(doc, _digest(doc.source)) for doc in docs]
    changed = [(doc, digest) for doc, digest in changed if cache.get(doc.doc_id) != digest]
    exported_at = clock.now_iso()
    for start in range(0, len(changed), FLUSH_BATCH_LIMIT):
        batch = changed[start : start + FLUSH_BATCH_LIMIT]
        stamped = [
            _Doc(
                doc.index,
                doc.doc_id,
                {**doc.source, "@timestamp": doc.source.get("@timestamp") or exported_at},
            )
            for doc, _digest_value in batch
        ]
        outcomes = _bulk(ctx, stamped)
        for (doc, digest), outcome in zip(batch, outcomes, strict=True):
            if outcome.status != "retry":
                cache[doc.doc_id] = digest
        total += ctx.record(stream, outcomes)
        if ctx.out_of_time():
            break
    return total


def _export_chats(ctx: _ExportContext) -> int:
    delivered = _flush_pending_deletions(ctx)
    delivered += _export_thread_stream(ctx, "chats", _thread_documents)
    if ctx.out_of_time():
        return delivered
    return delivered + _reconcile_chat_metadata(ctx)


def _reconcile_chat_metadata(ctx: _ExportContext) -> int:
    """Carry in-place thread changes (tags, holds, archive, matter, retention
    state, deletion) to Elastic.

    Scans only the small, mutable thread fields. A thread whose fields changed
    since it was sent is re-sent whole, so its messages carry the new tags;
    one this process has not sent yet (after a restart) gets a cheap partial
    update that Elastic skips when nothing differs; one that disappeared is
    flagged deleted.
    """

    state = ctx.state
    started = time.monotonic()
    if not ctx.thorough and started - state.metadata_scanned_at < METADATA_SCAN_INTERVAL_SECONDS:
        return 0
    rows: list[ChatThreadMetadataRow] = []
    after = ""
    while True:
        page = ctx.repository.chat_thread_metadata_page(after_id=after, limit=METADATA_PAGE_LIMIT)
        rows.extend(page)
        if len(page) < METADATA_PAGE_LIMIT:
            break
        after = page[-1].id
    ctx.prefetch_all_governance()
    ctx.prefetch_matters(row.matter_id for row in rows)
    current: dict[str, tuple[dict[str, Any], str]] = {}
    for row in rows:
        fields = _metadata_from_row(ctx, row)
        current[row.id] = (fields, _digest(fields))
    cache = ctx.fingerprints("chat-metadata")
    total = 0

    deleted_at = clock.now_iso()
    gone = {thread_id: deleted_at for thread_id in cache if thread_id not in current}
    if gone:
        total += _mark_threads_deleted(ctx, gone)
        for thread_id in gone:
            cache.pop(thread_id, None)

    changed = [tid for tid, (_fields, digest) in current.items() if tid in cache and cache[tid] != digest]
    for start in range(0, len(changed), THREAD_BATCH_LIMIT):
        if ctx.out_of_time():
            state.metadata_scanned_at = 0.0
            return total
        export_rows = ctx.repository.chat_thread_export_rows(changed[start : start + THREAD_BATCH_LIMIT])
        before = state.stream("chats").delivered
        _acknowledged, retry_reason = _send_threads(ctx, "chats", export_rows, _thread_documents)
        total += state.stream("chats").delivered - before
        if retry_reason is not None:
            ctx.record("chats", [_Outcome("retry", retry_reason)])

    unsent = [tid for tid in current if tid not in cache]
    index = ctx.target.index("chats")
    for start in range(0, len(unsent), FLUSH_BATCH_LIMIT):
        if ctx.out_of_time():
            state.metadata_scanned_at = 0.0
            return total
        batch = unsent[start : start + FLUSH_BATCH_LIMIT]
        docs = [_Doc(index, tid, current[tid][0], op="update") for tid in batch]
        outcomes = _bulk(ctx, docs)
        for tid, outcome in zip(batch, outcomes, strict=True):
            if outcome.status != "retry":
                cache[tid] = current[tid][1]
        total += ctx.record("chats", outcomes)
    state.metadata_scanned_at = started
    return total


def _export_documents(ctx: _ExportContext) -> int:
    delivered = _export_snapshot(ctx, "documents", _knowledge_documents(ctx))
    return delivered + _export_thread_stream(ctx, "documents", _attachment_documents)


def _export_users(ctx: _ExportContext) -> int:
    return _export_snapshot(ctx, "users", _user_documents(ctx))


_EXPORTERS: dict[str, Callable[[_ExportContext], int]] = {
    "audit": _export_audit,
    "usage": _export_usage,
    "chats": _export_chats,
    "documents": _export_documents,
    "users": _export_users,
}


# --- Passes ------------------------------------------------------------------


@dataclass
class ElasticPassResult:
    delivered: dict[str, int] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    busy: bool = False


def run_elastic_export(
    store: Any,
    settings: Settings,
    *,
    transport: httpx.BaseTransport | None = None,
    time_budget: float = SCHEDULED_TIME_BUDGET_SECONDS,
    streams: Sequence[str] | None = None,
    thorough: bool = False,
) -> ElasticPassResult | None:
    """Deliver pending data for every enabled stream.

    Returns None when export is unconfigured or paused. Never raises: errors
    are recorded per stream for the status endpoint and retried next pass.
    """

    config = console_settings(store)
    if not config.enabled:
        return None
    try:
        target = resolve_elastic_target(store, settings)
        if target is not None:
            check_target_egress(target)
    except ElasticConfigError as exc:
        store.elastic_last_delivery_error = str(exc)
        return None
    if target is None:
        return None
    state = export_state(store)
    if not state.lock.acquire(blocking=False):
        return ElasticPassResult(busy=True)
    result = ElasticPassResult()
    try:
        selected = [
            stream for stream in target.streams if streams is None or stream in streams
        ]
        with _client(target, transport) as client:
            ctx = _ExportContext(
                store=store,
                target=target,
                client=client,
                state=state,
                deadline=time.monotonic() + time_budget,
                thorough=thorough,
            )
            for stream in selected:
                if ctx.out_of_time():
                    break
                stats = state.stream(stream)
                try:
                    _ensure_indices(ctx, stream)
                    result.delivered[stream] = _EXPORTERS[stream](ctx)
                    stats.last_error = None
                except ElasticDeliveryError as exc:
                    stats.last_error = str(exc)
                    result.errors[stream] = str(exc)
                except Exception as exc:  # noqa: BLE001 - one stream must not stop the rest
                    logger.exception("Elastic export failed for the %s stream", stream)
                    stats.last_error = f"Unexpected export error: {exc}"[:_ERROR_TEXT_LIMIT]
                    result.errors[stream] = stats.last_error
        state.last_pass_at = clock.now_iso()
        if result.errors:
            first = next(iter(result.errors))
            store.elastic_last_delivery_error = (
                f"{STREAM_LABELS.get(first, first)}: {result.errors[first]}"
            )
            logger.warning("Elastic delivery failed: %s", store.elastic_last_delivery_error)
        else:
            store.elastic_last_delivery_error = None
        if sum(result.delivered.values()):
            store.elastic_last_delivery_at = clock.now_iso()
        return result
    finally:
        state.lock.release()


def flush_elastic_events(
    store: Any,
    settings: Settings,
    *,
    transport: httpx.BaseTransport | None = None,
) -> int:
    """Deliver only the buffered audit events. Returns the number delivered."""

    result = run_elastic_export(store, settings, transport=transport, streams=("audit",))
    if result is None:
        return 0
    return result.delivered.get("audit", 0)


def reset_elastic_export(store: Any) -> dict[str, int]:
    """Start every stream over, re-sending history to the current cluster."""

    repository = _repository(store)
    state = export_state(store)
    with state.lock:
        cursors = repository.reset_elastic_export_cursors()
        requeued = repository.requeue_delivered_outbox()
        state.fingerprints.clear()
        state.metadata_scanned_at = 0.0
        state.ensured_indices.clear()
        state.index_notes.clear()
    return {"cursors": cursors, "audit_requeued": requeued}


# --- Connection test ---------------------------------------------------------


def check_elastic_connection(
    target: ElasticTarget,
    *,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any]:
    """Prove the endpoint answers, the key authenticates, and it can write.

    Read-only: it creates nothing on the cluster.
    """

    checks: list[dict[str, str]] = []
    cluster: dict[str, str | None] = {}

    def add(check_id: str, label: str, status: str, detail: str) -> None:
        checks.append({"id": check_id, "label": label, "status": status, "detail": detail})

    def finish() -> dict[str, Any]:
        return {
            "ok": bool(checks) and all(check["status"] != "fail" for check in checks),
            "endpoint": target.base_url,
            "endpointSource": target.endpoint_source,
            "indexPattern": f"{target.index_prefix}-*",
            "cluster": cluster or None,
            "checks": checks,
        }

    with _client(target, transport) as client:
        try:
            response = client.get("/_security/_authenticate")
        except httpx.HTTPError as exc:
            add("reach", "Reach the cluster", "fail", describe_transport_failure(exc, target))
            return finish()
        payload = _json_or_none(response)
        if payload is None or ("statusCode" in payload and "error" in payload):
            hint = " It looks like a Kibana URL." if ".kb." in target.host else ""
            add(
                "reach",
                "Reach the cluster",
                "fail",
                f"{target.host} answered, but not like Elasticsearch.{hint} Use the "
                "Elasticsearch endpoint from your deployment page.",
            )
            return finish()
        add("reach", "Reach the cluster", "pass", f"{target.host} answered.")
        security_enabled = True
        if response.status_code == 200:
            principal = payload.get("username") or "unknown"
            api_key = payload.get("api_key") if isinstance(payload.get("api_key"), dict) else {}
            key_name = api_key.get("name") if isinstance(api_key, dict) else None
            detail = f"Signed in as {principal}"
            if key_name:
                detail += f" with API key '{key_name}'"
            add("auth", "API key accepted", "pass", detail + ".")
        elif response.status_code in (400, 500) and "security" in json.dumps(payload).lower():
            security_enabled = False
            add(
                "auth",
                "API key accepted",
                "warn",
                "Security is turned off on this cluster, so the key is not checked. "
                "Enable security before sending production data.",
            )
        else:
            add("auth", "API key accepted", "fail", describe_http_failure(response, target))
            return finish()

        try:
            info = client.get("/")
        except httpx.HTTPError:
            info = None
        info_payload = _json_or_none(info) if info is not None else None
        if info is not None and info.status_code == 200 and info_payload:
            version = info_payload.get("version") if isinstance(info_payload.get("version"), dict) else {}
            cluster = {
                "name": info_payload.get("cluster_name"),
                "version": version.get("number") if isinstance(version, dict) else None,
                "flavor": version.get("build_flavor") if isinstance(version, dict) else None,
            }
            flavor = f" ({cluster['flavor']})" if cluster.get("flavor") else ""
            add(
                "cluster",
                "Cluster details",
                "pass",
                f"{cluster.get('name') or 'Cluster'} running Elasticsearch "
                f"{cluster.get('version') or 'unknown version'}{flavor}.",
            )
        else:
            add(
                "cluster",
                "Cluster details",
                "warn",
                "The key cannot read cluster details (needs 'monitor'); this is optional.",
            )

        if not security_enabled:
            return finish()
        pattern = f"{target.index_prefix}-*"
        try:
            privileges = client.post(
                "/_security/user/_has_privileges",
                json={
                    "index": [
                        {"names": [pattern], "privileges": ["create_index", "index", "read"]}
                    ]
                },
            )
        except httpx.HTTPError as exc:
            add("write", "Can write Aperture indices", "warn", describe_transport_failure(exc, target))
            return finish()
        privilege_payload = _json_or_none(privileges)
        if privileges.status_code == 200 and privilege_payload is not None:
            missing = _missing_privileges(privilege_payload, pattern)
            write_missing = [name for name in missing if name != "'read'"]
            if write_missing:
                add(
                    "write",
                    "Can write Aperture indices",
                    "fail",
                    f"The key is missing {', '.join(write_missing)} on '{pattern}'. Edit its "
                    "role descriptor to allow 'create_index', 'index', and 'read' on that pattern.",
                )
            else:
                add(
                    "write",
                    "Can write Aperture indices",
                    "pass",
                    f"The key can create and write '{pattern}' indices.",
                )
                if "'read'" in missing:
                    add(
                        "read",
                        "Can mark deleted chats' messages",
                        "warn",
                        f"Without 'read' on '{pattern}', deleted conversations are flagged on "
                        "their chat document only, not on each message and upload.",
                    )
        else:
            add(
                "write",
                "Can write Aperture indices",
                "warn",
                "Elastic did not report privileges; use Sync now to confirm delivery.",
            )
    return finish()


def _json_or_none(response: httpx.Response | None) -> dict[str, Any] | None:
    if response is None:
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _missing_privileges(payload: Mapping[str, Any], pattern: str) -> list[str]:
    index = payload.get("index")
    granted = index.get(pattern) if isinstance(index, Mapping) else None
    if not isinstance(granted, Mapping):
        return []
    return [f"'{name}'" for name, allowed in granted.items() if not allowed]


# --- Status ------------------------------------------------------------------


def _pending_counts(store: Any, target: ElasticTarget | None) -> dict[str, int | None]:
    repository = getattr(store, "application_state_repository", None)
    if not isinstance(repository, ApplicationStateRepository):
        return {stream: None for stream in ELASTIC_EXPORT_STREAMS}
    signature = target.signature if target is not None else ""
    counts: dict[str, int | None] = {"audit": repository.count_pending_outbox()}
    counts["usage"] = repository.count_usage_after_sequence(
        repository.elastic_export_cursor("usage", signature)
    )
    counts["chats"] = repository.count_chat_threads_after_sequence(
        repository.elastic_export_cursor("chats", signature)
    )
    counts["documents"] = repository.count_chat_threads_after_sequence(
        repository.elastic_export_cursor("documents", signature)
    )
    state = export_state(store)
    users = getattr(store, "users", {})
    user_cache = state.fingerprints.get(f"{signature}:users", {})
    counts["users"] = sum(
        1 for user_id in (users if isinstance(users, Mapping) else {}) if user_id not in user_cache
    )
    return counts


def elastic_status(store: Any, settings: Settings) -> dict[str, Any]:
    config = console_settings(store)
    config_error: str | None = None
    try:
        target = resolve_elastic_target(store, settings)
    except ElasticConfigError as exc:
        target, config_error = None, str(exc)
    state = export_state(store)
    configured = target is not None
    delivery_error = getattr(store, "elastic_last_delivery_error", None)
    last_delivery = getattr(store, "elastic_last_delivery_at", None)
    pending = _pending_counts(store, target)
    prefix = target.index_prefix if target is not None else config.index_prefix
    environment = {
        "endpoint": bool(environment_endpoint(settings)),
        "apiKey": bool(settings.elastic_api_key),
    }

    if config_error:
        message = f"Elastic export settings need attention: {config_error}"
    elif not configured:
        message = (
            "Elastic analytics export is not configured. Enter your Elasticsearch endpoint "
            "or Cloud ID and an API key below, or set APERTURE_ELASTIC_URL and "
            "APERTURE_ELASTIC_API_KEY on the server."
        )
    elif not config.enabled:
        message = "Elastic export is paused. Data keeps queueing and is sent when you resume."
    elif delivery_error:
        message = f"Elastic export is configured but the last delivery failed: {delivery_error}"
    elif last_delivery:
        message = "Elastic export is active; new activity is delivered in the background."
    else:
        message = (
            "Elastic export is configured; queued activity will be delivered on the next "
            "background pass (about every 30 seconds) or when you choose Sync now."
        )

    streams: list[dict[str, Any]] = []
    for stream in ELASTIC_EXPORT_STREAMS:
        stats = state.stats.get(stream, StreamStats())
        streams.append(
            {
                "id": stream,
                "label": STREAM_LABELS[stream],
                "enabled": stream in config.streams,
                "indices": [f"{prefix}-{suffix}" for suffix in STREAM_INDEX_SUFFIXES[stream]],
                "pending": pending.get(stream),
                "delivered": stats.delivered,
                "rejected": stats.rejected,
                "lastDeliveryAt": stats.last_delivery_at,
                "lastError": stats.last_error,
                "lastRejection": stats.last_rejection,
            }
        )

    connected = bool(
        configured
        and config.enabled
        and not delivery_error
        and (state.last_contact_at or config.last_test_status == "passed")
    )
    return {
        "configured": configured,
        "connected": connected,
        "enabled": config.enabled,
        "endpoint": target.base_url if target is not None else None,
        "endpointSource": target.endpoint_source if target is not None else None,
        "apiKeySource": target.api_key_source if target is not None else None,
        "lastSync": last_delivery or ("Not connected" if not configured else "No delivery yet"),
        "lastPassAt": state.last_pass_at,
        "eventsBuffered": pending.get("audit") or 0,
        "lastDeliveryError": delivery_error,
        "configError": config_error,
        "message": message,
        "indexPattern": f"{prefix}-*",
        "indexNotes": dict(state.index_notes),
        "environment": environment,
        "settings": config.model_dump(mode="json"),
        "streams": streams,
    }
