"""Turning conversations into memories.

Two paths, deliberately different in cost and trust:

* **Explicit** -- the user literally said "remember that ...". Detected with
  patterns, runs inside the request, costs nothing, and is trusted completely.
* **Inferred** -- a small model pass reads the user's own recent messages and
  proposes durable preferences. It runs *after* the reply has been delivered so
  it cannot add latency, it is sampled rather than run every turn, and every
  failure mode is a silent no-op.

The inferred extractor is fed user messages only. Retrieved knowledge, web
results, and attachment text never reach it, so tenant documents can never end
up inside somebody's personal memory.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.core.memory import (
    build_memory,
    consolidate,
    enforce_caps,
    looks_sensitive,
    normalize_content,
)
from app.core.model_gateway import ModelGatewayError, ModelGatewayRoute
from app.models.schemas import MemoryKind, TenantMemoryPolicy, User, UserMemory
from app.core import clock

logger = logging.getLogger("aperture.memory")

# One short pass; the extractor returns a tiny JSON array, never prose.
EXTRACTION_TOKEN_BUDGET = 400
# How many of the user's own recent messages the extractor may see.
EXTRACTION_MESSAGE_WINDOW = 6
# Sample rather than run every turn. Turn 1 always runs so a new user's stated
# context is captured immediately; after that every third user turn.
EXTRACTION_TURN_INTERVAL = 3
MAX_INFERRED_PER_PASS = 3

_INFERRED_CONFIDENCE_FLOOR = 0.3
_INFERRED_CONFIDENCE_CEILING = 0.9

# Leading forms that unambiguously mean "store this about me". Kept tight on
# purpose: a loose pattern here fills the store with noise the user never asked
# for and then has to clean up.
_EXPLICIT_PATTERNS: tuple[tuple[re.Pattern[str], MemoryKind], ...] = (
    (
        re.compile(
            r"^\s*(?:please\s+|kindly\s+)?remember\s*(?:that|this)?\s*[:,-]?\s*(?P<body>.+)$",
            re.I,
        ),
        MemoryKind.FACT,
    ),
    (
        re.compile(
            r"^\s*(?:can|could|would|will)\s+you\s+(?:please\s+)?remember\s*(?:that|this)?\s*[:,-]?\s*(?P<body>.+?)[?]?\s*$",
            re.I,
        ),
        MemoryKind.FACT,
    ),
    (
        re.compile(
            r"^\s*i(?:'d|\s+would)?\s+(?:like|want)\s+you\s+to\s+remember\s*(?:that|this)?\s*[:,-]?\s*(?P<body>.+)$",
            re.I,
        ),
        MemoryKind.FACT,
    ),
    (
        re.compile(
            r"^\s*(?:please\s+)?(?:save|store)\s*(?:this|that|the\s+following)?\s*(?:for\s+(?:later|future\s+(?:chats|conversations)))?\s*[:,-]?\s*(?P<body>.+)$",
            re.I,
        ),
        MemoryKind.FACT,
    ),
    (
        re.compile(
            r"^\s*(?:please\s+)?(?:keep\s+in\s+mind|(?:do\s+not|don't|dont)\s+forget|make\s+(?:a\s+)?note(?:\s+of)?)\s*(?:that|this)?\s*[:,-]?\s*(?P<body>.+)$",
            re.I,
        ),
        MemoryKind.FACT,
    ),
    (
        re.compile(
            r"^\s*(?P<body>.+?)[,;]\s*(?:please\s+)?remember\s*(?:that|this)?\s*[.!]?\s*$",
            re.I,
        ),
        MemoryKind.FACT,
    ),
    (re.compile(r"^\s*from\s+now\s+on\s*[:,-]?\s*(?P<body>.+)$", re.I), MemoryKind.DIRECTIVE),
    (re.compile(r"^\s*going\s+forward\s*[:,-]?\s*(?P<body>.+)$", re.I), MemoryKind.DIRECTIVE),
    (re.compile(r"^\s*(?:for|in)\s+all\s+(?:future|further)\s+(?:answers|responses|replies|chats)\s*[:,-]?\s*(?P<body>.+)$", re.I), MemoryKind.DIRECTIVE),
    (re.compile(r"^\s*always\s+(?P<body>.+)$", re.I), MemoryKind.DIRECTIVE),
    (re.compile(r"^\s*never\s+(?P<body>.+)$", re.I), MemoryKind.DIRECTIVE),
    (re.compile(r"^\s*my\s+preference\s+is\s*[:,-]?\s*(?P<body>.+)$", re.I), MemoryKind.PREFERENCE),
    (re.compile(r"^\s*i\s+(?:always\s+)?prefer\s+(?P<body>.+)$", re.I), MemoryKind.PREFERENCE),
    (re.compile(r"^\s*note\s+that\s+i\s+(?P<body>.+)$", re.I), MemoryKind.PROFILE),
)

_EXTRACTION_SYSTEM_PROMPT = """You extract durable personalization facts about a single user from their own chat messages.

Return ONLY a JSON array. No prose, no code fence. Each element:
{"kind": "preference|directive|profile|project|fact", "content": "<one short sentence in third person>", "confidence": 0.0-1.0}

Rules:
- Only include things that will STILL be true and useful in a month.
- "preference" = how they like answers formatted or written.
- "directive" = a standing instruction they want followed every time.
- "profile" = their role, industry, expertise, or tools.
- "project" = an ongoing matter or workstream they keep returning to.
- "fact" = another durable detail they stated about themselves.
- Skip anything about the current question only, anything transient, and anything they did not actually state.
- Never include passwords, keys, tokens, account numbers, government identifiers, or health details.
- Write each entry as a standalone sentence starting with "Prefers", "Wants", "Works", "Is", or similar.
- Return [] when nothing durable was stated. That is the common case; prefer it over guessing."""


def explicit_memory_candidates(text: str) -> list[tuple[MemoryKind, str]]:
    """Detect "remember this" style statements in a single user message."""
    message = str(text or "").strip()
    if not message:
        return []
    candidates: list[tuple[MemoryKind, str]] = []
    # Only the leading clause of each line counts: a mid-sentence "always" is
    # usually part of the question, not an instruction about future answers.
    for line in message.splitlines():
        stripped = line.strip()
        if not stripped or len(stripped) > 600:
            continue
        for pattern, kind in _EXPLICIT_PATTERNS:
            match = pattern.match(stripped)
            if match is None:
                continue
            raw_body = match.group("body").strip()
            if kind is MemoryKind.FACT:
                # Polite requests are often phrased as a question ("Can you
                # remember that I use macOS?"). The question mark belongs to
                # the request, not to the stored fact. Directive questions
                # retain it so _is_directive_body can reject them below.
                raw_body = raw_body.removesuffix("?").rstrip()
            body = normalize_content(raw_body)
            if len(body) < 4 or looks_sensitive(body):
                break
            if kind is MemoryKind.DIRECTIVE and not _is_directive_body(body):
                break
            candidates.append((kind, _as_statement(kind, body, stripped)))
            break
    return candidates[:MAX_INFERRED_PER_PASS]


def _is_directive_body(body: str) -> bool:
    """Filter out questions that merely start with "always" or "never"."""
    if body.endswith("?"):
        return False
    return True


def _as_statement(kind: MemoryKind, body: str, original: str) -> str:
    """Store directives in the imperative form the model will act on."""
    if kind is MemoryKind.DIRECTIVE:
        lowered = original.strip().lower()
        if lowered.startswith("always ") or lowered.startswith("never "):
            return normalize_content(original)
        return normalize_content(body)
    return body


def should_extract(user_turn_count: int) -> bool:
    """Sample extraction so a long conversation does not mean a call per turn."""
    if user_turn_count <= 1:
        return True
    return user_turn_count % EXTRACTION_TURN_INTERVAL == 0


def capture_explicit_memories(
    store,
    actor: User,
    text: str,
    *,
    policy: TenantMemoryPolicy,
    thread_id: str | None,
) -> list[UserMemory]:
    """Persist "remember this" statements immediately.

    Runs inside the request so the user gets same-turn confirmation, which is
    also why it must never raise: a bad pattern match cannot cost someone their
    answer.
    """
    try:
        candidates = explicit_memory_candidates(text)
        if not candidates:
            return []
        return _persist_candidates(
            store,
            actor,
            [(kind, content, 1.0) for kind, content in candidates],
            policy=policy,
            thread_id=thread_id,
            source="explicit",
        )
    except Exception:  # pragma: no cover - defensive; memory never breaks chat
        logger.warning("Explicit memory capture failed", exc_info=True)
        return []


def capture_inferred_memories(
    store,
    actor: User,
    *,
    client: Any,
    route: ModelGatewayRoute,
    messages: list[dict[str, str]],
    policy: TenantMemoryPolicy,
    thread_id: str | None,
) -> list[UserMemory]:
    """Run the deferred extraction pass. Always safe to call; never raises."""
    try:
        if not route.configured:
            return []
        user_texts = _recent_user_texts(messages)
        if not user_texts:
            return []
        existing = store.memories_for_user(actor)
        payload = client.complete(
            route=route,
            messages=[
                {"role": "system", "content": _EXTRACTION_SYSTEM_PROMPT},
                {"role": "user", "content": _extraction_input(user_texts, existing)},
            ],
            max_tokens=EXTRACTION_TOKEN_BUDGET,
        )
        candidates = _parse_extraction(payload)
        if not candidates:
            return []
        return _persist_candidates(
            store,
            actor,
            candidates,
            policy=policy,
            thread_id=thread_id,
            source="inferred",
        )
    except ModelGatewayError as exc:
        logger.info("Memory extraction skipped: %s", exc)
        return []
    except Exception:  # pragma: no cover - defensive; memory never breaks chat
        logger.warning("Memory extraction failed", exc_info=True)
        return []


def _recent_user_texts(messages: list[dict[str, str]]) -> list[str]:
    """User messages only. Assistant turns, tool output, and injected runtime
    context are all excluded so nothing but the person's own words is mined."""
    texts: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "").lower() != "user":
            continue
        content = str(message.get("content") or "").strip()
        if content:
            texts.append(content[:2000])
    return texts[-EXTRACTION_MESSAGE_WINDOW:]


def _extraction_input(user_texts: list[str], existing: list[UserMemory]) -> str:
    known = [memory.content for memory in existing][:20]
    sections = ["Messages the user wrote:"]
    sections.extend(f"- {text}" for text in user_texts)
    if known:
        sections.append("")
        sections.append("Already known about this user (do not repeat these):")
        sections.extend(f"- {item}" for item in known)
    return "\n".join(sections)


def _parse_extraction(payload: dict[str, Any]) -> list[tuple[MemoryKind, str, float]]:
    """Strict parse. Anything unexpected yields nothing rather than garbage."""
    choices = payload.get("choices") or []
    if not choices:
        return []
    message = choices[0].get("message") or {}
    raw = message.get("content")
    if not isinstance(raw, str):
        return []
    text = raw.strip()
    # Tolerate a fenced block, since some models add one despite instructions.
    fence = re.match(r"^```(?:json)?\s*(?P<body>.*?)\s*```$", text, re.S)
    if fence:
        text = fence.group("body").strip()
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end <= start:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []

    candidates: list[tuple[MemoryKind, str, float]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        content = normalize_content(item.get("content") or "")
        if len(content) < 8 or looks_sensitive(content):
            continue
        try:
            kind = MemoryKind(str(item.get("kind") or "fact").strip().lower())
        except ValueError:
            kind = MemoryKind.FACT
        try:
            confidence = float(item.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        confidence = max(_INFERRED_CONFIDENCE_FLOOR, min(_INFERRED_CONFIDENCE_CEILING, confidence))
        candidates.append((kind, content, confidence))
        if len(candidates) >= MAX_INFERRED_PER_PASS:
            break
    return candidates


def _persist_candidates(
    store,
    actor: User,
    candidates: list[tuple[MemoryKind, str, float]],
    *,
    policy: TenantMemoryPolicy,
    thread_id: str | None,
    source: str,
) -> list[UserMemory]:
    """Merge candidates into the user's store, then apply retention and caps."""
    existing = store.memories_for_user(actor)
    live = {memory.id: memory for memory in existing}
    saved: list[UserMemory] = []

    for kind, content, confidence in candidates:
        match = consolidate(list(live.values()), content, kind)
        if match is not None:
            stored = store.user_memories.get(match.id)
            if stored is None:
                continue
            stored.content = content
            stored.confidence = max(stored.confidence, confidence)
            stored.updated_at = clock.now_iso()
            if source == "explicit":
                stored.source = "explicit"
            live[stored.id] = stored
            saved.append(stored)
            continue
        memory = build_memory(
            actor=actor,
            content=content,
            kind=kind,
            source=source,
            policy=policy,
            thread_id=thread_id,
            confidence=confidence,
        )
        if memory is None:
            continue
        store.user_memories[memory.id] = memory
        live[memory.id] = memory
        saved.append(memory)

    if not saved:
        return []

    for retired in enforce_caps(list(live.values()), policy):
        record = store.user_memories.get(retired.id)
        if record is not None:
            record.active = False
    store.save_runtime_state()
    return saved


def touch_memories(store, memory_ids: list[str]) -> None:
    """Record that memories were actually used, which feeds future ranking."""
    if not memory_ids:
        return
    try:
        touched = False
        stamp = clock.now_iso()
        for memory_id in memory_ids:
            memory = store.user_memories.get(memory_id)
            if memory is None or not memory.active:
                continue
            memory.use_count += 1
            memory.last_used_at = stamp
            touched = True
        if touched:
            store.save_runtime_state()
    except Exception:  # pragma: no cover - defensive; memory never breaks chat
        logger.warning("Failed to record memory usage", exc_info=True)
