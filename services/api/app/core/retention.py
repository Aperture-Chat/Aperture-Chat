"""Pure retention-policy resolution.

Longest applicable retention always wins, matching how Microsoft Purview
resolves competing labels: an externally passed-down tag can extend a
thread's life but never shorten it. Resolution is fail-closed — a thread
that matches no retention value at all is ungoverned and never eligible for
disposition, and legal holds are checked by the sweep before anything here
matters.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Protocol
from uuid import uuid4

from app.core import clock
from app.models.schemas import ChatThreadTag, RetentionBatchResult, TenantRetentionPolicy

if TYPE_CHECKING:
    from app.models.schemas import User
    from app.repositories.seed import SeedStore


MCP_TAG_NAMESPACE = "mcp"
ATTACHMENT_TAG_NAMESPACE = "attachments"
SUBJECT_TAG_NAMESPACE = "subject"

# Curated two-level taxonomy for subject tagging. The classifier must choose
# from this list and anything else is dropped, so the tag table can never
# accumulate free-text labels that retention rules cannot target.
SUBJECT_TAXONOMY: dict[str, tuple[str, ...]] = {
    "legal": ("litigation", "transactional", "regulatory", "ip", "employment"),
    "financial": ("ira", "tax", "banking", "investments", "insurance"),
    "medical": (),
    "code": (),
    "hr": (),
    "marketing": (),
    "operations": (),
    "personal": (),
}

_SUBJECT_CLASSIFY_TOKEN_BUDGET = 24
_SUBJECT_INPUT_MESSAGES = 3
_SUBJECT_INPUT_CHARS = 1500


def _subject_system_prompt() -> str:
    options = ", ".join(
        primary if not subtypes else f"{primary} (subtypes: {', '.join(subtypes)})"
        for primary, subtypes in SUBJECT_TAXONOMY.items()
    )
    return (
        "You label conversations for records retention. Reply with exactly one "
        "line containing a subject, or subject/subtype when one clearly fits, "
        f"chosen ONLY from: {options}. Reply with the single word other when "
        "nothing fits. No explanations."
    )


def parse_subject_label(text: str | None) -> tuple[str, str | None] | None:
    """Validate a classifier reply against the taxonomy; junk yields None."""

    if not isinstance(text, str):
        return None
    line = text.strip().splitlines()[0].strip().strip("\"'`.").lower() if text.strip() else ""
    if not line:
        return None
    primary, _, subtype = line.partition("/")
    primary = primary.strip()
    subtype = subtype.strip() or None
    if primary not in SUBJECT_TAXONOMY:
        return None
    if subtype is not None and subtype not in SUBJECT_TAXONOMY[primary]:
        subtype = None
    return primary, subtype


def classify_thread_subject(
    client: Any,
    route: Any,
    messages: Iterable[Mapping[str, Any]],
) -> tuple[str, str | None] | None:
    """Ask the chat's own model for a taxonomy label. Never raises.

    Only the user's own words are sent, mirroring memory extraction: no
    assistant output, tool results, or injected runtime context.
    """

    try:
        if not getattr(route, "configured", False):
            return None
        user_texts: list[str] = []
        for message in messages:
            if not isinstance(message, Mapping):
                continue
            if str(message.get("role") or "").lower() != "user":
                continue
            content = str(message.get("content") or "").strip()
            if content:
                user_texts.append(content[:_SUBJECT_INPUT_CHARS])
            if len(user_texts) >= _SUBJECT_INPUT_MESSAGES:
                break
        if not user_texts:
            return None
        payload = client.complete(
            route=route,
            messages=[
                {"role": "system", "content": _subject_system_prompt()},
                {"role": "user", "content": "\n\n".join(user_texts)},
            ],
            max_tokens=_SUBJECT_CLASSIFY_TOKEN_BUDGET,
        )
        choices = payload.get("choices") or []
        message = (choices[0].get("message") or {}) if choices else {}
        return parse_subject_label(message.get("content"))
    except Exception:  # noqa: BLE001 - classification is best-effort bookkeeping
        return None

# Attachment kinds that count as images; everything else is a document for
# retention purposes. Coarse buckets keep per-tag retention rules writable.
_IMAGE_KINDS = frozenset({"image", "img", "png", "jpg", "jpeg", "gif", "webp"})

# Audit metadata carries at most this many thread ids per batch; the counts
# stay complete either way.
BATCH_AUDIT_ID_LIMIT = 50


def apply_attachment_runtime_tags(
    store: ChatThreadTagWriter,
    *,
    tenant_id: str,
    thread_id: str,
    actor_id: str,
    attachments: Iterable[Mapping[str, Any]],
) -> list[ChatThreadTag]:
    """Tag a thread for the uploaded files its completion carried.

    Coarse ``document``/``image`` keys under the ``attachments`` namespace:
    enough for retention rules and batch targeting without recording file
    names in the tag table. Idempotent like MCP tagging.
    """

    applied: list[ChatThreadTag] = []
    seen: set[str] = set()
    now = clock.now()
    for attachment in attachments:
        if not isinstance(attachment, Mapping):
            continue
        kind = str(attachment.get("kind") or "").strip().lower()
        mime = str(attachment.get("mime_type") or "").strip().lower()
        key = (
            "image"
            if kind in _IMAGE_KINDS or mime.startswith("image/")
            else "document"
        )
        if key in seen:
            continue
        seen.add(key)
        applied.append(
            store.apply_chat_thread_tag(
                ChatThreadTag(
                    id=f"tag-{uuid4()}",
                    tenant_id=tenant_id,
                    thread_id=thread_id,
                    namespace=ATTACHMENT_TAG_NAMESPACE,
                    key=key,
                    value=None,
                    source="auto",
                    applied_at=now,
                    applied_by=actor_id,
                )
            )
        )
    return applied


def batch_dispose_threads(
    store: "SeedStore",
    actor: "User",
    *,
    tenant_id: str,
    thread_ids: Sequence[str],
    action: str,
) -> RetentionBatchResult:
    """Delete or archive a tenant-scoped batch of chat threads.

    Ids outside the tenant (or already gone) are silently skipped so a stale
    console selection can never touch another tenant's data. Active legal
    holds win over deletion; archiving is non-destructive and allowed under
    hold. Deletion reuses the single-thread cascade (attachments, preview
    files, tags, hold membership rows).
    """

    if action not in ("delete", "archive"):
        raise ValueError(f"Unsupported retention batch action: {action!r}")
    requested = list(dict.fromkeys(thread_ids))
    valid_ids = [
        thread_id
        for thread_id in requested
        if (thread := store.chat_threads.get(thread_id)) is not None
        and thread.tenant_id == tenant_id
    ]
    skipped_missing = len(requested) - len(valid_ids)
    skipped_held = 0
    if action == "delete":
        held = store.thread_ids_under_active_hold(tenant_id)
        deletable = [thread_id for thread_id in valid_ids if thread_id not in held]
        skipped_held = len(valid_ids) - len(deletable)
        disposed = 0
        for thread_id in deletable:
            if store.delete_chat_thread(thread_id) is not None:
                disposed += 1
        disposed_ids = deletable
    else:
        disposed = store.set_chat_threads_archived(valid_ids, tenant_id=tenant_id)
        disposed_ids = valid_ids
    result = RetentionBatchResult(
        action=action,
        requested=len(requested),
        disposed=disposed,
        skipped_held=skipped_held,
        skipped_missing=skipped_missing,
    )
    store.record_audit(
        actor,
        f"retention.batch_{'deleted' if action == 'delete' else 'archived'}",
        tenant_id,
        {
            "requested": result.requested,
            "disposed": result.disposed,
            "skipped_held": result.skipped_held,
            "skipped_missing": result.skipped_missing,
            "thread_ids": disposed_ids[:BATCH_AUDIT_ID_LIMIT],
        },
        runtime_state_changed=False,
    )
    return result


class ChatThreadTagWriter(Protocol):
    def apply_chat_thread_tag(self, tag: ChatThreadTag) -> ChatThreadTag: ...


def apply_mcp_runtime_tags(
    store: ChatThreadTagWriter,
    *,
    tenant_id: str,
    thread_id: str,
    actor_id: str,
    mcp_tool_results: Iterable[Mapping[str, Any]],
) -> list[ChatThreadTag]:
    """Tag a thread for every MCP server it touched during a completion.

    Every invocation attempt counts, including errors — data may have been
    exposed on any call, and over-inclusion is the safe direction for
    retention. Idempotent: (thread, namespace, key) is the tag identity, so
    repeated chats against the same server refresh one tag.
    """

    applied: list[ChatThreadTag] = []
    seen: set[str] = set()
    now = clock.now()
    for result in mcp_tool_results:
        if not isinstance(result, Mapping):
            continue
        tool_config_id = str(result.get("tool_config_id") or "").strip()
        if not tool_config_id or tool_config_id in seen:
            continue
        seen.add(tool_config_id)
        server_name = str(result.get("server_name") or "").strip() or None
        applied.append(
            store.apply_chat_thread_tag(
                ChatThreadTag(
                    id=f"tag-{uuid4()}",
                    tenant_id=tenant_id,
                    thread_id=thread_id,
                    namespace=MCP_TAG_NAMESPACE,
                    key=tool_config_id,
                    value=server_name,
                    source="auto",
                    applied_at=now,
                    applied_by=actor_id,
                )
            )
        )
    return applied


def effective_retention_days(
    policy: TenantRetentionPolicy,
    *,
    tags: Iterable[tuple[str, str]] = (),
    matter_retention_days: int | None = None,
) -> int | None:
    """Return the governing retention window in days, or ``None``.

    ``None`` means the thread is not governed by any retention and must be
    kept. ``tags`` are ``(namespace, key)`` pairs on the thread. A matter's
    own retention acts as a floor for its chats, never as a trigger: with no
    chat-side policy match the thread stays ungoverned regardless of the
    matter value.
    """

    if not policy.enabled:
        return None
    candidates: list[int] = []
    if policy.chat_retention_days > 0:
        candidates.append(policy.chat_retention_days)
    tag_pairs = set(tags)
    tagged_namespaces = {namespace for namespace, _key in tag_pairs}
    for rule in policy.rules:
        if rule.tag_key is None:
            if rule.tag_namespace in tagged_namespaces:
                candidates.append(rule.retention_days)
        elif (rule.tag_namespace, rule.tag_key) in tag_pairs:
            candidates.append(rule.retention_days)
    if not candidates:
        return None
    if matter_retention_days is not None and matter_retention_days > 0:
        candidates.append(matter_retention_days)
    return max(candidates)
