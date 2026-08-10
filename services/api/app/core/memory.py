"""Per-user personalization memory.

Memory is the platform's way of learning that a person prefers diagrams, works
in litigation support, or always wants citations. It is deliberately narrow in
scope and wide in guarantees:

* **Private.** A memory belongs to exactly one user. Nothing in this module,
  and no route built on it, lets one account read another's memory content --
  platform owners included. Admins get counts, policy, and purge.
* **Gated four ways.** Platform owner -> tenant admin -> group permission ->
  the user themselves. Every tier defaults such that a deployment that has not
  opted in sees byte-identical prompts to before this feature existed.
* **Non-fatal.** Callers treat every function here as best-effort. A memory
  problem must never fail, slow, or corrupt a chat turn.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, datetime, timedelta
from typing import Mapping, NamedTuple
from uuid import uuid4

from app.core import clock
from app.core.policy import group_permission_allowed
from app.models.schemas import (
    MEMORY_CONTENT_MAX_CHARS,
    STANDING_MEMORY_KINDS,
    Group,
    MemoryKind,
    MemoryStateResponse,
    PlatformSettings,
    Role,
    TenantMemoryPolicy,
    User,
    UserMemory,
    UserMemorySettings,
)

# Standing instructions ("always include a diagram") are injected on every turn:
# filtering them by relevance to the current question would defeat the point.
MAX_STANDING_MEMORIES = 12
# Contextual memories compete for a small slot budget by relevance.
MAX_CONTEXTUAL_MEMORIES = 6
# When the user explicitly asks what Aperture remembers, retrieving only by
# lexical overlap is the wrong behavior: "What do you remember about me?" has
# no shared words with facts such as "Works in legal operations." This wider
# window is used only for an intentional memory-recall turn.
MAX_RECALL_QUERY_MEMORIES = 18
# Hard ceiling on how much of the prompt memory may consume.
MEMORY_PROMPT_CHAR_BUDGET = 1200
# A direct memory inspection can spend more prompt space than an ordinary
# answer while remaining bounded and far below the per-user storage limit.
MEMORY_RECALL_PROMPT_CHAR_BUDGET = 4000
# Above this token-overlap ratio two memories are treated as the same idea.
CONSOLIDATION_SIMILARITY = 0.8

_STOPWORDS = {
    "a",
    "about",
    "always",
    "an",
    "and",
    "any",
    "are",
    "be",
    "for",
    "from",
    "have",
    "i",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "please",
    "prefer",
    "prefers",
    "that",
    "the",
    "their",
    "them",
    "they",
    "this",
    "to",
    "user",
    "want",
    "wants",
    "with",
    "you",
    "your",
}

_NEGATION_TOKENS = {"never", "not", "no", "stop", "avoid", "don't", "dont", "without"}

# Anything matching these never becomes a memory. Personalization is not worth
# creating a durable store of credentials or regulated identifiers.
_SENSITIVE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(?:password|passphrase|passcode|api[\s_-]?key|secret|token|credential)s?\b", re.I),
    re.compile(r"\b(?:private[\s_-]?key|access[\s_-]?key|bearer)\b", re.I),
    re.compile(r"\bsk-[A-Za-z0-9]{12,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b"),  # JWT-ish
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),  # SSN
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),  # payment card
    re.compile(r"\b(?:routing|account)\s+number\b", re.I),
    re.compile(r"\bmfa\b|\b2fa\b|\bone[\s-]?time\s+code\b", re.I),
)

_MEMORY_RECALL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bwhat\s+(?:do|can)\s+you\s+remember(?:\s+about\s+me)?\b", re.I),
    re.compile(r"\bwhat\s+(?:have|did)\s+you\s+(?:remember|save|store)(?:\s+about\s+me)?\b", re.I),
    re.compile(
        r"\b(?:show|list|read\s+back|tell\s+me)(?:\s+(?:what|everything))?\s+"
        r"(?:you\s+)?(?:remember|know|have\s+saved|have\s+stored)(?:\s+about\s+me)?\b",
        re.I,
    ),
    re.compile(r"\bdo\s+you\s+remember\b", re.I),
    re.compile(r"\b(?:show|list|read\s+back|open)\s+my\s+(?:saved\s+)?memories\b", re.I),
    re.compile(r"\bwhat\s+do\s+you\s+know\s+about\s+me\b", re.I),
    re.compile(
        r"\bwhat\s+(?:memories|information|details)\s+"
        r"(?:do\s+you\s+have|have\s+you\s+(?:saved|stored))(?:\s+about\s+me)?\b",
        re.I,
    ),
)


class MemoryState(NamedTuple):
    """Resolved availability of memory for one actor on one turn."""

    enabled: bool
    capture_enabled: bool
    platform_enabled: bool
    tenant_enabled: bool
    group_allowed: bool
    user_enabled: bool
    policy: TenantMemoryPolicy
    reason: str | None

    def as_response(self) -> MemoryStateResponse:
        return MemoryStateResponse(
            enabled=self.enabled,
            capture_enabled=self.capture_enabled,
            platform_enabled=self.platform_enabled,
            tenant_enabled=self.tenant_enabled,
            group_allowed=self.group_allowed,
            user_enabled=self.user_enabled,
            reason=self.reason,
        )


def resolve_memory_state(
    *,
    actor: User,
    platform_settings: PlatformSettings,
    policy: TenantMemoryPolicy,
    groups: Mapping[str, Group],
    settings: UserMemorySettings,
) -> MemoryState:
    """AND the four enablement tiers and explain the first one that says no."""
    platform_enabled = bool(platform_settings.memory_enabled)
    is_platform_owner = actor.role == Role.PLATFORM_OWNER
    # Platform owners are governed by the platform switch they control. Their
    # records use the primary organization solely as a durable SQL scope; a
    # tenant admin's on/off choice must not block the owner's own memory.
    tenant_enabled = is_platform_owner or bool(policy.enabled)
    group_allowed = group_permission_allowed(actor, groups, "memory_access")
    user_enabled = bool(settings.enabled)
    # Tenant users use their own tenant. A platform owner uses the primary
    # organization policy resolved by memory_state_for below.
    has_memory_scope = actor.tenant_id is not None or bool(policy.tenant_id)

    reason: str | None = None
    if not platform_enabled:
        reason = "Memory is turned off for this platform."
    elif not has_memory_scope:
        reason = "Create an organization before using personalization memory."
    elif not tenant_enabled:
        reason = "Memory is turned off for your organization."
    elif not group_allowed:
        reason = "Memory is disabled for your platform groups by tenant policy."
    elif not user_enabled:
        reason = "You turned memory off for your account."

    enabled = (
        platform_enabled
        and has_memory_scope
        and tenant_enabled
        and group_allowed
        and user_enabled
    )
    capture_enabled = (
        enabled and bool(policy.auto_capture_enabled) and bool(settings.auto_capture_enabled)
    )
    return MemoryState(
        enabled=enabled,
        capture_enabled=capture_enabled,
        platform_enabled=platform_enabled,
        tenant_enabled=tenant_enabled,
        group_allowed=group_allowed,
        user_enabled=user_enabled,
        policy=policy,
        reason=reason,
    )


def memory_state_for(store, actor: User) -> MemoryState:
    """Resolve memory availability for ``actor`` from live store state."""
    tenant_id = actor.tenant_id
    if tenant_id is None and actor.role == Role.PLATFORM_OWNER:
        # Match the organization context used when an owner previews the admin
        # console. Content remains isolated by owner_user_id and is never
        # exposed to that organization's administrators.
        tenant_id = next(iter(store.tenants), None)
    return resolve_memory_state(
        actor=actor,
        platform_settings=store.platform_settings,
        policy=store.tenant_memory_policy(tenant_id),
        groups=store.groups,
        settings=store.user_memory_settings_for(actor.id),
    )


def recall_memories(
    memories: list[UserMemory],
    query: str,
    *,
    policy: TenantMemoryPolicy | None = None,
    char_budget: int = MEMORY_PROMPT_CHAR_BUDGET,
) -> list[UserMemory]:
    """Pick the memories worth spending prompt tokens on this turn.

    Standing instructions come first and unconditionally; contextual memories
    fill whatever budget is left, ranked by relevance to the current question.
    """
    excluded = set(policy.excluded_kinds) if policy else set()
    usable = [
        memory
        for memory in memories
        if memory.active and memory.kind not in excluded and not _is_expired(memory)
    ]
    if not usable:
        return []

    standing = [memory for memory in usable if memory.kind in STANDING_MEMORY_KINDS]
    standing.sort(key=lambda memory: (not memory.pinned, -memory.confidence, memory.created_at))
    standing = standing[:MAX_STANDING_MEMORIES]

    contextual = [memory for memory in usable if memory.kind not in STANDING_MEMORY_KINDS]
    recall_requested = is_memory_recall_query(query)
    if recall_requested:
        # The question is about the memory store itself, so all saved context is
        # relevant. Rank the most durable/recent entries first instead of
        # requiring words from the memory to appear in the generic question.
        selected_contextual = sorted(
            contextual,
            key=lambda memory: (not memory.pinned, -_value_score(memory), memory.created_at),
        )[:MAX_RECALL_QUERY_MEMORIES]
    else:
        query_tokens = _tokenize(query)
        scored = sorted(
            contextual,
            key=lambda memory: -_relevance(memory, query_tokens),
        )
        selected_contextual = [
            memory
            for memory in scored[:MAX_CONTEXTUAL_MEMORIES]
            if _relevance(memory, query_tokens) > 0
        ]

    selected: list[UserMemory] = []
    spent = 0
    effective_char_budget = (
        max(char_budget, MEMORY_RECALL_PROMPT_CHAR_BUDGET)
        if recall_requested
        else char_budget
    )
    for memory in [*standing, *selected_contextual]:
        cost = len(memory.content) + 8
        if spent + cost > effective_char_budget:
            continue
        selected.append(memory)
        spent += cost
    return selected


def is_memory_recall_query(text: str) -> bool:
    """Return True when ordinary English asks Aperture to disclose memory.

    This is intentionally broader than the save-command detector. Reading the
    caller's own private memories is safe once normal memory access checks have
    passed, and a broad recall question must not depend on keyword overlap.
    """
    message = " ".join(str(text or "").split())
    return bool(message and any(pattern.search(message) for pattern in _MEMORY_RECALL_PATTERNS))


def _relevance(memory: UserMemory, query_tokens: set[str]) -> float:
    """Lexical overlap, weighted by how trusted, recent, and used a memory is."""
    memory_tokens = _tokenize(memory.content)
    if not memory_tokens:
        return 0.0
    overlap = len(memory_tokens & query_tokens)
    if overlap == 0 and not memory.pinned:
        return 0.0
    base = overlap / math.sqrt(len(memory_tokens))
    if memory.pinned:
        base += 1.0
    base *= 0.5 + memory.confidence
    base *= _recency_weight(memory)
    base *= 1.0 + min(memory.use_count, 10) * 0.05
    return base


def _recency_weight(memory: UserMemory) -> float:
    stamp = _parse_timestamp(memory.updated_at or memory.created_at)
    if stamp is None:
        return 1.0
    age_days = max((clock.now() - stamp).total_seconds() / 86400.0, 0.0)
    # Half-life of roughly 90 days; never decays below a useful floor.
    return max(0.4, math.exp(-age_days / 130.0))


def consolidate(
    existing: list[UserMemory],
    content: str,
    kind: MemoryKind,
) -> UserMemory | None:
    """Find the memory a new observation should merge into, if any.

    Returning an existing record keeps the store from filling with near
    duplicates every time a user restates a preference. A contradiction
    ("always use tables" then "never use tables") also lands here, and the
    caller overwrites the content rather than storing both.
    """
    candidate_tokens = _tokenize(content)
    if not candidate_tokens:
        return None
    best: UserMemory | None = None
    best_score = 0.0
    for memory in existing:
        if not memory.active or memory.kind != kind:
            continue
        score = _similarity(candidate_tokens, _tokenize(memory.content))
        if score > best_score:
            best_score = score
            best = memory
    if best is None:
        return None
    if best_score >= CONSOLIDATION_SIMILARITY:
        return best
    # A near-match that flips polarity is a correction, not a new fact.
    if best_score >= 0.55 and _polarity(content) != _polarity(best.content):
        return best
    return None


def _similarity(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _polarity(text: str) -> bool:
    """True when the statement reads as an instruction to *not* do something."""
    return bool(_NEGATION_TOKENS & _tokenize(text, keep_stopwords=True))


def enforce_caps(memories: list[UserMemory], policy: TenantMemoryPolicy) -> list[UserMemory]:
    """Return the memories that must be retired to satisfy tenant policy.

    Expired records go first, then the least valuable unpinned records until
    the per-user cap is met. Pinned memories are never evicted by the cap: the
    user explicitly said those matter.
    """
    retired: list[UserMemory] = []
    live: list[UserMemory] = []
    for memory in memories:
        if not memory.active:
            continue
        if _is_expired(memory):
            retired.append(memory)
        else:
            live.append(memory)

    overflow = len(live) - max(policy.max_memories_per_user, 1)
    if overflow > 0:
        evictable = sorted((m for m in live if not m.pinned), key=_value_score)
        retired.extend(evictable[:overflow])
    return retired


def _value_score(memory: UserMemory) -> float:
    return memory.confidence * _recency_weight(memory) * (1.0 + min(memory.use_count, 10) * 0.1)


def _is_expired(memory: UserMemory) -> bool:
    if not memory.expires_at:
        return False
    stamp = _parse_timestamp(memory.expires_at)
    if stamp is None:
        return False
    return stamp <= clock.now()


def looks_sensitive(text: str) -> bool:
    """Reject candidates that would make memory a liability instead of a feature."""
    return any(pattern.search(text) for pattern in _SENSITIVE_PATTERNS)


def normalize_content(text: str) -> str:
    """Collapse a candidate to a single tidy line within the length cap."""
    normalized = " ".join(str(text or "").split())
    if len(normalized) > MEMORY_CONTENT_MAX_CHARS:
        normalized = f"{normalized[: MEMORY_CONTENT_MAX_CHARS - 3].rstrip()}..."
    return normalized


def build_memory(
    *,
    actor: User,
    content: str,
    kind: MemoryKind,
    source: str,
    policy: TenantMemoryPolicy,
    thread_id: str | None = None,
    confidence: float = 0.5,
    pinned: bool = False,
) -> UserMemory | None:
    """Create a memory record, or None when the content is unusable."""
    normalized = normalize_content(content)
    if len(normalized) < 4 or looks_sensitive(normalized):
        return None
    if kind in set(policy.excluded_kinds):
        return None
    tenant_id = actor.tenant_id
    if tenant_id is None and actor.role == Role.PLATFORM_OWNER:
        tenant_id = policy.tenant_id or None
    if tenant_id is None:
        return None
    now = clock.now_iso()
    return UserMemory(
        id=f"mem-{uuid4().hex}",
        tenant_id=tenant_id,
        owner_user_id=actor.id,
        kind=kind,
        content=normalized,
        source=source,
        source_thread_id=thread_id,
        confidence=max(0.0, min(1.0, confidence)),
        pinned=pinned,
        created_at=now,
        updated_at=now,
        expires_at=expiry_for(policy),
    )


def expiry_for(policy: TenantMemoryPolicy) -> str | None:
    days = policy.retention_days
    if days <= 0:
        return None
    return (clock.now() + timedelta(days=days)).isoformat()


def memory_prompt_block(
    memories: list[UserMemory],
    *,
    recall_requested: bool = False,
    saved_this_turn: list[UserMemory] | None = None,
) -> str:
    """Render recalled memories as a governing instruction block.

    Standing directives are stated as rules; context is stated as background.
    The override sentence matters: a stored preference must never win an
    argument with what the user just typed.
    """
    saved = list(saved_this_turn or [])
    if not memories and not recall_requested and not saved:
        return ""
    standing = [memory for memory in memories if memory.kind in STANDING_MEMORY_KINDS]
    context = [memory for memory in memories if memory.kind not in STANDING_MEMORY_KINDS]

    lines = [
        "Personalization memory for this user (private to them, learned from their own chats):",
    ]
    if recall_requested:
        if memories:
            lines.append(
                "The user explicitly asked what you remember. Answer directly and accurately from the saved entries below. "
                "Do not claim that conversations always start fresh or that persistent memory is unavailable, and do not invent details."
            )
        else:
            lines.append(
                "The user explicitly asked what you remember, but no saved memory entries are available. "
                "Say that there are no saved memories yet and that they can ask you to remember something in ordinary language. "
                "Do not claim that persistent memory is unsupported or can never retain information."
            )
    if saved:
        lines.append(
            "The user's explicit memory request was saved successfully this turn. Briefly confirm what was saved; "
            "do not say that you cannot retain it for future chats."
        )
    index = 1
    if standing:
        lines.append(
            "Standing preferences - apply these by default, but this turn's message always wins if it says otherwise:"
        )
        for memory in standing:
            lines.append(f"- [M{index}] {memory.content}")
            index += 1
    if context:
        if recall_requested:
            lines.append("Saved context about this user - recite it only because they asked what you remember:")
        else:
            lines.append("Known context about this user - use only where it is relevant, never recite it back:")
        for memory in context:
            lines.append(f"- [M{index}] {memory.content}")
            index += 1
    if not recall_requested:
        lines.append(
            "Do not mention that a memory system exists unless the user asks about it."
        )
    return "\n".join(lines)


def _tokenize(text: str, *, keep_stopwords: bool = False) -> set[str]:
    tokens = re.findall(r"[a-z0-9']+", str(text or "").lower())
    if keep_stopwords:
        return set(tokens)
    return {token for token in tokens if len(token) > 2 and token not in _STOPWORDS}


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(value)
    except ValueError:
        return None
    # Timestamps persisted before the platform clock was timezone-aware would
    # otherwise blow up any comparison against clock.now().
    return stamp if stamp.tzinfo is not None else stamp.replace(tzinfo=UTC)
