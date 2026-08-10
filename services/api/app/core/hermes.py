"""Hermes companion learning loop.

When an agent profile has the Hermes companion enabled, the chat runtime
teaches the model three fenced blocks and captures them from completed
replies:

- ```hermes-memory``` — a durable note persisted per profile and injected
  into that profile's future runs (recursive learning).
- ```hermes-skill``` — a reusable skill stored in the tenant skill library
  and attached to the profile, so the existing skill-file injection carries
  it into future runs.
- ```hermes-automation``` — a proposed scheduled task, created disabled in
  the automations console for human review; never scheduled silently.

Every capture is a real stored record with an audit event, and nothing here
runs for profiles without the companion.
"""

from __future__ import annotations

import json
import logging
import re
from uuid import uuid4

from app.core import clock
from app.models.schemas import (
    Automation,
    AutomationStep,
    CompanionMemory,
    ModelConfig,
    SkillFile,
    User,
)
from app.repositories.seed import SeedStore

logger = logging.getLogger("aperture.hermes")

HERMES_COMPANION = "hermes"
HERMES_BLOCK_PATTERN = re.compile(
    r"```hermes-(memory|skill|automation)[^\S\n]*\n(.*?)```", re.DOTALL
)
# Per-turn caps guard against runaway saves from a single reply; the
# per-profile cap keeps the memory store bounded (oldest pruned first).
MAX_MEMORIES_PER_TURN = 3
MAX_SKILLS_PER_TURN = 2
MAX_AUTOMATIONS_PER_TURN = 1
MAX_MEMORIES_PER_PROFILE = 100
MEMORY_MAX_CHARS = 2000
PROMPT_MEMORY_LIMIT = 20
VALID_AUTOMATION_TRIGGERS = {"once", "weekly", "cron"}


def recent_memories(store: SeedStore, profile_id: str) -> list[CompanionMemory]:
    """The profile's newest memories, oldest-first for prompt coherence."""
    memories = [
        memory
        for memory in store.companion_memories.values()
        if memory.profile_id == profile_id
    ]
    memories.sort(key=lambda memory: memory.created_at)
    return memories[-PROMPT_MEMORY_LIMIT:]


def profile_memories(store: SeedStore, profile_id: str) -> list[CompanionMemory]:
    """All memories for a profile, newest first (management surfaces)."""
    memories = [
        memory
        for memory in store.companion_memories.values()
        if memory.profile_id == profile_id
    ]
    memories.sort(key=lambda memory: memory.created_at, reverse=True)
    return memories


def capture_artifacts(
    store: SeedStore,
    actor: User,
    *,
    profile_id: str,
    source_thread_id: str | None,
    full_text: str,
) -> dict[str, object] | None:
    """Persist hermes-* fenced blocks from a completed reply.

    Returns a summary of what was saved, or None when nothing was captured.
    Only runs for a real, Hermes-enabled agent profile.
    """
    if not profile_id or not full_text or "```hermes-" not in full_text:
        return None
    profile = store.models.get(profile_id)
    if profile is None or profile.agentic_companion != HERMES_COMPANION:
        return None
    tenant_id = profile.tenant_id
    if tenant_id is None or tenant_id not in store.tenants:
        logger.warning("Hermes capture skipped for tenant-ambiguous profile %s", profile.id)
        return None
    if actor.tenant_id is not None and actor.tenant_id != tenant_id:
        logger.warning("Hermes capture rejected for cross-tenant profile %s", profile.id)
        return None

    memories_saved = 0
    skills_saved: list[str] = []
    automations_proposed: list[str] = []
    for kind, raw_body in HERMES_BLOCK_PATTERN.findall(full_text):
        body = raw_body.strip()
        if not body:
            continue
        if kind == "memory" and memories_saved < MAX_MEMORIES_PER_TURN:
            memory = CompanionMemory(
                id=f"hermes-mem-{uuid4().hex[:12]}",
                tenant_id=tenant_id,
                profile_id=profile.id,
                content=body[:MEMORY_MAX_CHARS],
                created_by=actor.id,
                created_at=clock.now_iso(),
                source_thread_id=source_thread_id,
            )
            store.companion_memories[memory.id] = memory
            _prune_profile_memories(store, profile.id)
            store.record_audit(
                actor,
                "hermes.memory_saved",
                memory.id,
                {"profile_id": profile.id, "chars": len(memory.content)},
            )
            memories_saved += 1
        elif kind == "skill" and len(skills_saved) < MAX_SKILLS_PER_TURN:
            name, content = _split_skill(body)
            skill = SkillFile(
                id=f"skill-hermes-{uuid4().hex[:12]}",
                tenant_id=tenant_id,
                name=name,
                description=f"Saved by the Hermes companion from a conversation with {profile.name}.",
                content=content,
                category="hermes",
                group_ids=list(profile.group_ids),
                enabled=True,
                updated_at=clock.now_iso(),
            )
            store.skill_files[skill.id] = skill
            if skill.id not in profile.skill_file_ids:
                profile.skill_file_ids = [*profile.skill_file_ids, skill.id]
            store.record_audit(
                actor,
                "hermes.skill_saved",
                skill.id,
                {"profile_id": profile.id, "name": skill.name},
            )
            skills_saved.append(skill.name)
        elif kind == "automation" and len(automations_proposed) < MAX_AUTOMATIONS_PER_TURN:
            automation = _proposed_automation(actor, profile, body, tenant_id)
            if automation is None:
                store.record_audit(
                    actor,
                    "hermes.automation_rejected",
                    profile.id,
                    {"reason": "block was not valid JSON with a name and prompt"},
                )
                continue
            store.automations[automation.id] = automation
            store.record_audit(
                actor,
                "hermes.automation_proposed",
                automation.id,
                {"profile_id": profile.id, "name": automation.name, "enabled": False},
            )
            automations_proposed.append(automation.name)

    if not memories_saved and not skills_saved and not automations_proposed:
        return None
    store.save_runtime_state()
    return {
        "memories_saved": memories_saved,
        "skills_saved": skills_saved,
        "automations_proposed": automations_proposed,
    }


def _prune_profile_memories(store: SeedStore, profile_id: str) -> None:
    memories = profile_memories(store, profile_id)
    for stale in memories[MAX_MEMORIES_PER_PROFILE:]:
        store.companion_memories.pop(stale.id, None)


def _split_skill(body: str) -> tuple[str, str]:
    """A skill block may lead with "Title: <name>"; otherwise derive one."""
    first_line, _, rest = body.partition("\n")
    title_match = re.match(r"(?i)^title:\s*(.+)$", first_line.strip())
    if title_match and rest.strip():
        return title_match.group(1).strip()[:80], rest.strip()
    derived = " ".join(body.split()[:8])[:80] or "Hermes skill"
    return derived, body


def _proposed_automation(
    actor: User,
    profile: ModelConfig,
    body: str,
    tenant_id: str,
) -> Automation | None:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    name = str(payload.get("name") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    if not name or not prompt:
        return None
    trigger_type = str(payload.get("trigger_type") or "once").strip().lower()
    if trigger_type not in VALID_AUTOMATION_TRIGGERS:
        trigger_type = "once"

    def _optional_text(key: str) -> str | None:
        value = payload.get(key)
        return str(value).strip() if isinstance(value, str) and value.strip() else None

    return Automation(
        id=f"automation-hermes-{uuid4().hex[:12]}",
        tenant_id=tenant_id,
        name=name[:120],
        surface="chat",
        trigger_type=trigger_type,
        run_at=_optional_text("run_at"),
        weekly_day=_optional_text("weekly_day"),
        time_of_day=_optional_text("time_of_day"),
        cron_expression=_optional_text("cron_expression"),
        prompt=prompt,
        steps=[
            AutomationStep(
                model_id=profile.id,
                instruction=str(payload.get("instruction") or "").strip(),
            )
        ],
        # Proposals always require a human to review and enable them.
        enabled=False,
        created_by=actor.id,
        created_at=clock.now_iso(),
        updated_at=clock.now_iso(),
    )
