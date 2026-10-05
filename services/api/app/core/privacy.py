"""Personal-data concealment applied to stored and served records.

Enforcement lives at the persistence boundary (``SeedStore`` saves) and at
the model boundary (chat routes), and the read helpers here re-apply it so
history saved before an organization turned protection on is never shown
unconcealed. Every function is a no-op when the policy is off.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, MutableMapping
from typing import TYPE_CHECKING, Any

from app.core.personal_data import DETECTORS_BY_ID, conceal
from app.models.schemas import (
    ChatFeedbackRecord,
    ChatMessage,
    ChatThread,
    ChatThreadTag,
    SecurityAlert,
    TenantPrivacyPolicy,
)

if TYPE_CHECKING:
    from app.repositories.seed import SeedStore


def privacy_policy_for(store: "SeedStore", tenant_id: str | None) -> TenantPrivacyPolicy:
    """The tenant's policy; a disabled default when there is no tenant or the
    store cannot be read (protection must never break saving a chat)."""
    if not tenant_id:
        return TenantPrivacyPolicy(tenant_id="")
    repository = getattr(store, "data_protection_repository", None)
    if repository is None:
        return TenantPrivacyPolicy(tenant_id=tenant_id)
    return repository.privacy_policy(tenant_id)


def _text(value: str | None, categories: Iterable[str], counts: Counter[str]) -> str | None:
    if not value:
        return value
    result = conceal(value, categories)
    counts.update(result.counts)
    return result.text


def _conceal_trace(trace: Any, categories: list[str], counts: Counter[str]) -> Any:
    if not isinstance(trace, list):
        return trace
    concealed = []
    for step in trace:
        if isinstance(step, MutableMapping):
            step = dict(step)
            for key in ("label", "detail"):
                if isinstance(step.get(key), str):
                    step[key] = _text(step[key], categories, counts)
        concealed.append(step)
    return concealed


def _conceal_dict_fields(
    items: Any, fields: tuple[str, ...], categories: list[str], counts: Counter[str]
) -> Any:
    if not isinstance(items, list):
        return items
    concealed = []
    for item in items:
        if isinstance(item, MutableMapping):
            item = dict(item)
            for key in fields:
                if isinstance(item.get(key), str):
                    item[key] = _text(item[key], categories, counts)
        concealed.append(item)
    return concealed


# Text-bearing fields a message can carry besides its content. Attachment
# text previews are copied into the message by the client, and citation
# snippets quote source documents; both are stored with the thread.
_ATTACHMENT_FIELDS = ("name", "text_preview")
_CITATION_FIELDS = ("snippet", "source_name")


def _conceal_metadata(metadata: dict[str, Any], categories: list[str], counts: Counter[str]) -> dict[str, Any]:
    """Earlier regenerated answers live in ``responseVersions``; conceal them too."""
    versions = metadata.get("responseVersions")
    if not isinstance(versions, list):
        return metadata
    updated = []
    for version in versions:
        if isinstance(version, MutableMapping):
            version = dict(version)
            if isinstance(version.get("content"), str):
                version["content"] = _text(version["content"], categories, counts)
            if "activityTrace" in version:
                version["activityTrace"] = _conceal_trace(version["activityTrace"], categories, counts)
            if "citations" in version:
                version["citations"] = _conceal_dict_fields(version["citations"], _CITATION_FIELDS, categories, counts)
            if "attachments" in version:
                version["attachments"] = _conceal_dict_fields(
                    version["attachments"], _ATTACHMENT_FIELDS, categories, counts
                )
        updated.append(version)
    return {**metadata, "responseVersions": updated}


def conceal_thread(thread: ChatThread, policy: TenantPrivacyPolicy) -> tuple[ChatThread, Counter[str]]:
    counts: Counter[str] = Counter()
    if not policy.enabled:
        return thread, counts
    categories = list(policy.categories)
    messages = []
    for message in thread.messages:
        update: dict[str, Any] = {"content": _text(message.content, categories, counts) or ""}
        if message.activityTrace:
            update["activityTrace"] = [
                step.model_copy(
                    update={
                        "label": _text(step.label, categories, counts) or "",
                        "detail": _text(step.detail, categories, counts),
                    }
                )
                for step in message.activityTrace
            ]
        if message.metadata:
            update["metadata"] = _conceal_metadata(message.metadata, categories, counts)
        if message.attachments:
            update["attachments"] = [
                attachment.model_copy(
                    update={
                        "name": _text(attachment.name, categories, counts) or attachment.name,
                        "text_preview": _text(attachment.text_preview, categories, counts),
                    }
                )
                for attachment in message.attachments
            ]
        if message.citations:
            update["citations"] = [
                citation.model_copy(
                    update={
                        "snippet": _text(citation.snippet, categories, counts) or "",
                        "source_name": _text(citation.source_name, categories, counts) or citation.source_name,
                    }
                )
                for citation in message.citations
            ]
        messages.append(message.model_copy(update=update))
    concealed = thread.model_copy(
        update={"title": _text(thread.title, categories, counts) or thread.title, "messages": messages}
    )
    return concealed, counts


def conceal_feedback(record: ChatFeedbackRecord, policy: TenantPrivacyPolicy) -> ChatFeedbackRecord:
    if not policy.enabled:
        return record
    counts: Counter[str] = Counter()
    categories = list(policy.categories)
    return record.model_copy(
        update={
            "thread_title": _text(record.thread_title, categories, counts) or "",
            "comment": _text(record.comment, categories, counts) or "",
            "message_preview": _text(record.message_preview, categories, counts) or "",
        }
    )


def conceal_tag(tag: ChatThreadTag, policy: TenantPrivacyPolicy) -> ChatThreadTag:
    """Tag keys and values can arrive from external systems; never let one
    carry an identifier."""
    if not policy.enabled:
        return tag
    counts: Counter[str] = Counter()
    categories = list(policy.categories)
    return tag.model_copy(
        update={
            "key": _text(tag.key, categories, counts) or tag.key,
            "value": _text(tag.value, categories, counts),
        }
    )


def conceal_alert(alert: SecurityAlert, policy: TenantPrivacyPolicy) -> SecurityAlert:
    if not policy.enabled or not alert.snippet:
        return alert
    return alert.model_copy(update={"snippet": conceal(alert.snippet, policy.categories).text})


def conceal_title(title: str, policy: TenantPrivacyPolicy) -> str:
    if not policy.enabled or not title:
        return title
    return conceal(title, policy.categories).text


def conceal_message_dicts(messages: list[dict[str, Any]], categories: Iterable[str]) -> Counter[str]:
    """Conceal provider-bound chat messages in place (string and text parts)."""
    counts: Counter[str] = Counter()
    categories = list(categories)
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            message["content"] = _text(content, categories, counts) or content
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, MutableMapping) and isinstance(part.get("text"), str):
                    part["text"] = _text(part["text"], categories, counts) or part["text"]
    return counts


def detection_summary(counts: Counter[str] | dict[str, int]) -> list[dict[str, object]]:
    """Audit-safe counts by detector label. A list of objects, not a dict
    keyed by detector id, because audit redaction blanks any metadata key
    containing "key" or "password"."""
    return [
        {"type": DETECTORS_BY_ID[detector_id].label if detector_id in DETECTORS_BY_ID else detector_id, "count": count}
        for detector_id, count in sorted(dict(counts).items())
    ]


def concealed_message_payloads(messages: list[dict[str, Any]], policy: TenantPrivacyPolicy) -> list[dict[str, Any]]:
    """Stored message JSON as the store would save it under ``policy``.

    Lets the chat upsert tell a privacy-only rewrite of older history apart
    from a real change, so concealing a chat never resets its retention
    activity clock.
    """
    if not policy.enabled:
        return messages
    try:
        thread = ChatThread(
            id="",
            tenant_id="",
            owner_user_id="",
            title="",
            model_id="",
            group_id="",
            updated_at="",
            messages=[ChatMessage.model_validate(message) for message in messages],
        )
    except Exception:  # noqa: BLE001 - unparseable history simply counts as changed
        return messages
    return conceal_thread(thread, policy)[0].model_dump(mode="json")["messages"]


def conceal_for_tenant(store: "SeedStore", tenant_id: str | None, text: str) -> str:
    """``text`` as the tenant's policy would store it (memories, notes)."""
    policy = privacy_policy_for(store, tenant_id)
    if not policy.enabled or not text:
        return text
    return conceal(text, policy.categories).text
