"""Work-trace facts for the chat stream.

The chat surface shows a live trace of what the platform actually did for a
reply. These helpers turn a resolved runtime context, a finished reply, and a
Hermes capture summary into small ``activity`` payloads streamed alongside the
deltas. They carry counts and short configuration names only -- never
retrieved passages, URLs, tool output, memories, or standing rules -- so the
trace adds nothing that privacy concealment or the audit trail has to guard.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.core.directives import Directive, directive_results

MAX_REPORTED_TOOL_CALLS = 8


def _list(runtime_context: Mapping[str, object], key: str) -> list[Any]:
    value = runtime_context.get(key)
    return value if isinstance(value, list) else []


def _dicts(runtime_context: Mapping[str, object], key: str) -> list[dict[str, Any]]:
    return [item for item in _list(runtime_context, key) if isinstance(item, dict)]


def _directives(runtime_context: Mapping[str, object]) -> list[Directive]:
    return [item for item in _list(runtime_context, "directives") if isinstance(item, Directive)]


def _verifiable(runtime_context: Mapping[str, object]) -> list[Directive]:
    return [directive for directive in _directives(runtime_context) if directive.verifiable]


def _counted(kind: str, **counts: int) -> dict[str, Any] | None:
    """A fact made of counts, reported only when something was counted."""
    return {"kind": kind, **counts} if any(counts.values()) else None


def _list_counts(runtime_context: Mapping[str, object], kind: str, **keys: str) -> dict[str, Any] | None:
    """Counts the context lists named by ``keys`` (fact field -> context key)."""
    return _counted(kind, **{field: len(_list(runtime_context, key)) for field, key in keys.items()})


def _agent(runtime_context: Mapping[str, object]) -> dict[str, Any] | None:
    name = runtime_context.get("agent_profile_name")
    return {"kind": "agent", "name": name} if isinstance(name, str) and name else None


def _privacy(runtime_context: Mapping[str, object]) -> dict[str, Any] | None:
    concealed = isinstance(runtime_context.get("privacy_concealed_prompt"), str)
    return {"kind": "privacy", "concealed": True} if concealed else None


def _knowledge(runtime_context: Mapping[str, object]) -> dict[str, Any] | None:
    if not _list(runtime_context, "knowledge_config_ids"):
        return None
    hits = _dicts(runtime_context, "knowledge_hits")
    sources = {str(hit.get("document_id") or hit.get("source_name") or "") for hit in hits}
    return {"kind": "knowledge", "passages": len(hits), "sources": len(sources - {""})}


def _web(runtime_context: Mapping[str, object], provider_web_search: bool) -> dict[str, Any] | None:
    if "web_results" in runtime_context:
        engine = runtime_context.get("web_search_engine")
        return {
            "kind": "web",
            "results": len(_list(runtime_context, "web_results")),
            "engine": engine if isinstance(engine, str) else "",
        }
    return {"kind": "web", "provider": True} if provider_web_search else None


def _tools(runtime_context: Mapping[str, object]) -> dict[str, Any] | None:
    servers = len(_list(runtime_context, "mcp_servers"))
    results = _dicts(runtime_context, "mcp_tool_results")
    if not servers and not results:
        return None
    calls = [
        {"name": str(result.get("tool_name") or "tool"), "ok": not bool(result.get("is_error"))}
        for result in results[:MAX_REPORTED_TOOL_CALLS]
    ]
    return {"kind": "tools", "servers": servers, "calls": calls}


def _attachments(runtime_context: Mapping[str, object]) -> dict[str, Any] | None:
    files = len(_list(runtime_context, "attachments"))
    images = runtime_context.get("image_attachment_count")
    if not files:
        return None
    return {"kind": "attachments", "files": files, "images": images if isinstance(images, int) else 0}


def _requirements(runtime_context: Mapping[str, object]) -> dict[str, Any] | None:
    count = len(_verifiable(runtime_context))
    return {"kind": "requirements", "phase": "noted", "count": count} if count else None


def context_activity(
    runtime_context: Mapping[str, object],
    *,
    provider_web_search: bool,
    screening: bool,
) -> list[dict[str, Any]]:
    """What was gathered for this reply before the model started, in order."""
    facts = [
        _agent(runtime_context),
        _privacy(runtime_context),
        _knowledge(runtime_context),
        _web(runtime_context, provider_web_search),
        _list_counts(runtime_context, "fetch", pages="fetched_urls"),
        _tools(runtime_context),
        _attachments(runtime_context),
        _list_counts(runtime_context, "memory", recalled="memory_ids", companion="hermes_memories"),
        _list_counts(runtime_context, "skills", skills="skill_files", templates="prompt_templates"),
        _requirements(runtime_context),
        {"kind": "screen", "phase": "hold"} if screening else None,
    ]
    return [fact for fact in facts if fact is not None]


def requirement_checks(runtime_context: Mapping[str, object], text: str) -> dict[str, Any] | None:
    """The verifiable requirements from this turn, checked against the reply."""
    results = directive_results(_verifiable(runtime_context), text)
    if not results:
        return None
    return {
        "kind": "requirements",
        "phase": "checked",
        "checks": [{"label": label, "met": met} for _id, label, met in results],
    }


def hermes_activity(summary: Mapping[str, object] | None) -> dict[str, Any] | None:
    """What the Hermes companion saved from this reply."""
    if not summary:
        return None
    memories = summary.get("memories_saved")
    return {
        "kind": "hermes",
        "memories": memories if isinstance(memories, int) else 0,
        "skills": [str(name) for name in _list(summary, "skills_saved")],
        "automations": [str(name) for name in _list(summary, "automations_proposed")],
    }
