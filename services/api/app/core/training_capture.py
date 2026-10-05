"""Capture de-identified learning signals from saved chats.

A signal is something a person did that says how good an answer was:

- ``positive``/``negative``: a thumbs rating (with the optional note);
- ``correction``: the person pushed back in the next turn ("that's wrong,
  the deadline is 30 days", "make it shorter") or regenerated the answer.
  The judged answer becomes the rejected response and the reply that
  followed becomes the preferred one, unless that reply was itself rated
  down or corrected.

Every captured text is de-identified with the shared personal-data engine
(all categories, regardless of the chat-time policy) and, by default, with
the organization's own people and client/matter names. Labels are routed
deterministically: the chat's retention subject tag when one exists (the
model-based classifier), otherwise a transparent keyword classifier over the
person's own words. Nothing here calls a model or leaves the deployment.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from typing import TYPE_CHECKING

from app.core import clock
from app.core.personal_data import ALL_CATEGORIES, TOKEN_PATTERN, conceal, conceal_names
from app.core.retention import SUBJECT_TAG_NAMESPACE, SUBJECT_TAXONOMY
from app.models.schemas import (
    ChatFeedbackRecord,
    ChatMessage,
    ChatThread,
    TrainingCapturePolicy,
    TrainingExample,
    TrainingMessage,
)
from app.repositories.data_protection import new_example_id

if TYPE_CHECKING:
    from app.repositories.seed import SeedStore

logger = logging.getLogger(__name__)

MESSAGE_CHAR_LIMIT = 12_000
MIN_RESPONSE_CHARS = 24
EXCLUDING_TAG_NAMESPACES = frozenset(
    {"sensitive", "suggested_sensitive", "regulated", "suggested_regulated"}
)

# --- correction detection -------------------------------------------------------

_STRONG_CORRECTION = re.compile(
    r"\b(?:that'?s\s+(?:wrong|incorrect|not\s+(?:right|correct|true|accurate|what))"
    r"|(?:is|was|are|were)\s+(?:wrong|incorrect|inaccurate|outdated)"
    r"|not\s+(?:correct|accurate|right|true)|incorrect|inaccurate|you\s+(?:missed|forgot|left\s+out|misread|misunderstood|ignored)"
    r"|you\s+did(?:\s+not|n'?t)\s+(?:include|mention|address|follow|answer)"
    r"|should\s+(?:be|have\s+been|say|read|state)|not\s+what\s+i\s+(?:asked|meant|wanted)"
    r"|i\s+(?:meant|asked\s+for|said)|hallucinat\w*|made\s+(?:that|it|this)\s+up|(?:does|do)\s*(?:n'?t|\s+not)\s+exist"
    r"|the\s+correct\s+\w+\s+is|correction:|wrong\s+(?:statute|case|date|number|amount|section|rule|citation|jurisdiction))\b",
    re.IGNORECASE,
)
_STYLE_CORRECTION = re.compile(
    r"\b(?:try\s+again|redo|rewrite|re-?write|revise|rephrase|fix\s+(?:this|that|it)|change\s+(?:it|this|that)\s+to"
    r"|too\s+(?:long|short|formal|casual|wordy|vague|generic)|shorter|more\s+(?:concise|detail(?:ed)?|specific|formal)"
    r"|less\s+(?:formal|wordy)|instead\s+of|rather\s+than|(?:please\s+)?remove\s+the|do(?:\s+not|n'?t)\s+(?:include|use|mention))\b",
    re.IGNORECASE,
)
_NEGATIVE_OPENER = re.compile(
    r"^\s*(?:no\b|nope\b|not\s+quite|not\s+really|wrong\b|actually\b|close,?\s+but|almost,?\s+but|hmm\b|wait\b)",
    re.IGNORECASE,
)


def correction_strength(text: str) -> int:
    """0 when the turn is not a correction; higher is more certain.

    Transparent and deterministic so an administrator can predict what is
    captured: a factual pushback counts double, a style revision once, and
    a negative opener ("No, …", "Actually …") adds one.
    """
    if not text or len(text) > 4000:
        return 0
    score = 2 * len(_STRONG_CORRECTION.findall(text)) + len(_STYLE_CORRECTION.findall(text))
    if _NEGATIVE_OPENER.search(text):
        score += 1
    return score


def is_correction(text: str) -> bool:
    return correction_strength(text) >= 2


# --- work labels ------------------------------------------------------------------

_TASK_KEYWORDS: dict[str, re.Pattern[str]] = {
    "translation": re.compile(r"\btranslat\w*|\binto\s+(?:spanish|french|german|chinese|japanese|portuguese|italian)\b", re.I),
    # "Summary judgment" is a litigation motion, not a request to summarize.
    "summarization": re.compile(r"\bsummar(?!y\s+judgment)\w*|\btl;?dr\b|\bkey\s+(?:points|takeaways)\b|\brecap\b|\bcondense\b|\bdigest\b", re.I),
    "extraction": re.compile(r"\bextract\w*|\bpull\s+out\b|\blist\s+(?:all|every|each)\b|\bidentify\s+(?:all|every|each)\b|\bfind\s+(?:all|every)\b|\bparse\b", re.I),
    "review": re.compile(r"\breview\w*|\bredline\w*|\bmark\s*up\b|\bproofread\w*|\bcritique\b|\bflag\s+(?:any\s+)?(?:issues|risks|problems)\b|\bcheck\s+(?:this|the|my)\b", re.I),
    "drafting": re.compile(r"\bdraft\w*|\bwrite\b|\bcompose\b|\bprepare\s+(?:a|an|the)\b|\bredraft\w*|\bletter\b|\bmemo\b|\bmotion\b|\bclause\b|\bemail\s+to\b", re.I),
    "coding": re.compile(r"\bcode\b|\bfunction\b|\bscript\b|\bsql\b|\bpython\b|\bjavascript\b|\btypescript\b|\bregex\b|\bstack\s+trace\b|\bbug\b", re.I),
    "analysis": re.compile(r"\banaly[sz]\w*|\bcalculat\w*|\bcompare\b|\bforecast\w*|\bprojection\w*|\bevaluat\w*|\bassess\w*|\bmodel\s+(?:the|a)\b", re.I),
    "research": re.compile(r"\bresearch\w*|\bcase\s+law\b|\bprecedent\w*|\bstatute\w*|\bwhat\s+(?:is|are|does)\b|\bexplain\b|\bhow\s+(?:does|do|can|should)\b|\bwhy\b|\bcite\b|\bauthorit\w*", re.I),
}
TASK_TYPES: tuple[str, ...] = (*_TASK_KEYWORDS, "general")
TASK_LABELS: dict[str, str] = {
    "translation": "Translation",
    "summarization": "Summarization",
    "extraction": "Extraction",
    "review": "Review & redlining",
    "drafting": "Drafting",
    "coding": "Coding",
    "analysis": "Analysis",
    "research": "Research & Q&A",
    "general": "General",
}

_PRACTICE_KEYWORDS: dict[str, re.Pattern[str]] = {
    "legal/litigation": re.compile(
        r"\blitigat\w*|\blawsuit\w*|\bcomplaint\b|\bmotion\s+(?:to|for)\b|\bdeposition\w*|\bdiscovery\b|\bplaintiff\w*|\bdefendant\w*"
        r"|\bcourt\b|\btrial\b|\bpleading\w*|\bsubpoena\w*|\bappeal\w*|\bsummary\s+judgment\b|\bclass\s+action\b|\binterrogator\w*",
        re.I,
    ),
    "legal/transactional": re.compile(
        r"\bmerger\w*|\bacquisition\w*|\bm&a\b|\bpurchase\s+agreement\b|\bterm\s+sheet\b|\bclosing\b|\bdue\s+diligence\b"
        r"|\bindemnif\w*|\breps?\s+and\s+warrant\w*|\brepresentations\s+and\s+warrant\w*|\bescrow\b|\blease\b|\bcredit\s+agreement\b",
        re.I,
    ),
    "legal/regulatory": re.compile(
        r"\bregulat\w*|\bcompliance\b|\bsec\b|\bfinra\b|\bcfpb\b|\bgdpr\b|\bccpa\b|\brulemaking\b|\benforcement\s+action\b", re.I
    ),
    "legal/ip": re.compile(r"\bpatent\w*|\btrademark\w*|\bcopyright\w*|\btrade\s+secret\w*|\binfring\w*|\bprior\s+art\b|\buspto\b", re.I),
    "legal/employment": re.compile(
        r"\bemployment\b|\bemployee\w*|\bwrongful\s+termination\b|\bdiscriminat\w*|\bharassment\b|\bfmla\b|\bflsa\b"
        r"|\bnon-?compete\w*|\bseverance\b|\beeoc\b|\bwage\s+and\s+hour\b",
        re.I,
    ),
    "legal": re.compile(r"\bcontract\w*|\bagreement\w*|\blegal\b|\battorney\w*|\bcounsel\b|\bstatut\w*|\blaw\b|\bjurisdiction\w*|\bclause\w*", re.I),
    "financial/tax": re.compile(r"\btax\w*|\birs\b|\bdeduction\w*|\b1099\b|\bw-2\b|\bk-1\b|\bcapital\s+gains?\b|\bestate\s+tax\b", re.I),
    "financial/ira": re.compile(r"\bira\b|\broth\b|\b401\(?k\)?|\brollover\b|\brequired\s+minimum\s+distribution\w*|\brmds?\b", re.I),
    "financial/banking": re.compile(r"\bbank\w*|\bloan\w*|\bmortgage\w*|\bwire\s+transfer\b|\bach\b|\blending\b|\bdeposit\w*", re.I),
    "financial/investments": re.compile(r"\bportfolio\w*|\binvest\w*|\bequit(?:y|ies)\b|\bbonds?\b|\betfs?\b|\ballocation\b|\bvaluation\w*|\bsecurities\b", re.I),
    "financial/insurance": re.compile(r"\binsur\w*|\bpremium\w*|\bunderwrit\w*|\bannuit\w*|\bpolicyholder\w*", re.I),
    "financial": re.compile(r"\bfinanc\w*|\bbudget\w*|\brevenue\b|\bebitda\b|\bcash\s+flow\b|\bbalance\s+sheet\b|\bp&l\b", re.I),
    "medical": re.compile(r"\bpatient\w*|\bdiagnos\w*|\bclinical\b|\bmedication\w*|\btreatment\w*|\bsymptom\w*|\bphysician\w*|\bmedical\b|\bprescri\w*", re.I),
    "code": re.compile(r"\bpython\b|\bjavascript\b|\btypescript\b|\bsql\b|\bfunction\b|\bstack\s+trace\b|\brepository\b|\bcompil\w*|\bregex\b", re.I),
    "hr": re.compile(r"\bonboarding\b|\bperformance\s+review\w*|\bbenefits\b|\bpto\b|\bhiring\b|\brecruit\w*|\bjob\s+description\w*", re.I),
    "marketing": re.compile(r"\bmarketing\b|\bcampaign\w*|\bbrand\w*|\bseo\b|\bsocial\s+media\b|\bpress\s+release\w*|\bnewsletter\w*|\bcopywrit\w*", re.I),
    "operations": re.compile(r"\bworkflow\w*|\bvendor\w*|\bprocurement\b|\bsupply\s+chain\b|\blogistics\b|\bsops?\b|\bproject\s+plan\w*", re.I),
}


def practice_area_from_keywords(texts: Sequence[str]) -> str:
    """Best taxonomy label for the person's words, or "" when nothing fits.

    Scores every primary (its own keywords plus its subtypes'), then picks
    the strongest subtype inside the winning primary when one scored.
    """
    joined = "\n".join(texts)[:20_000]
    if not joined.strip():
        return ""
    scores = {label: len(pattern.findall(joined)) for label, pattern in _PRACTICE_KEYWORDS.items()}
    primaries: Counter[str] = Counter()
    for label, score in scores.items():
        primaries[label.split("/")[0]] += score
    if not primaries or primaries.most_common(1)[0][1] == 0:
        return ""
    primary = primaries.most_common(1)[0][0]
    subtypes = [
        (score, label)
        for label, score in scores.items()
        if label.startswith(f"{primary}/") and score > 0
    ]
    if subtypes:
        return max(subtypes)[1]
    return primary if primary in SUBJECT_TAXONOMY else ""


def task_type_from_keywords(text: str) -> str:
    scores = {task: len(pattern.findall(text or "")) for task, pattern in _TASK_KEYWORDS.items()}
    best = max(scores.values(), default=0)
    if best == 0:
        return "general"
    # Ties resolve in declaration order, most specific first.
    return next(task for task, score in scores.items() if score == best)


def practice_area_label(value: str) -> str:
    if not value:
        return "Unclassified"
    primary, _, subtype = value.partition("/")
    names = {"ip": "IP", "hr": "HR", "ira": "IRA"}
    title = names.get(primary, primary.capitalize())
    if not subtype:
        return title
    return f"{title} · {names.get(subtype, subtype.capitalize())}"


# --- capture ----------------------------------------------------------------------


class _Deidentifier:
    """Conceal identifiers (all categories) and, optionally, known names."""

    def __init__(self, names: list[tuple[str, str]]) -> None:
        self.names = names

    def __call__(self, text: str) -> str:
        # Conceal the whole text first: a value cut by the length limit would
        # no longer be recognized and could leak most of its digits.
        concealed = conceal(text or "", ALL_CATEGORIES).text
        if self.names:
            concealed = conceal_names(concealed, self.names).text
        return concealed[:MESSAGE_CHAR_LIMIT]


def concealed_value_count(example: TrainingExample) -> int:
    """Placeholders in everything an export would contain. Counted from the
    final text, so values concealed earlier (by chat-time protection) count
    the same as values concealed at capture."""
    texts = [message.content for message in example.prompt]
    texts += [example.completion, example.correction, example.revision, example.comment]
    return sum(len(TOKEN_PATTERN.findall(text)) for text in texts if text)


def _known_names(store: "SeedStore", tenant_id: str) -> list[tuple[str, str]]:
    """Multi-word people names and configured client/matter labels.

    Single words are skipped on purpose: first names such as "Will", "May",
    or "Grant" are also ordinary words, and shredding them would ruin the
    training text more than they reveal.
    """
    names: list[tuple[str, str]] = []
    for user in store.users.values():
        if user.tenant_id != tenant_id:
            continue
        candidates = {user.display_name, f"{user.first_name or ''} {user.last_name or ''}".strip()}
        for candidate in candidates:
            if candidate and len(candidate.split()) >= 2:
                names.append((candidate, "PERSON"))
    policy = store.tenant_retention_policy(tenant_id)
    for source in policy.sources:
        label = "CLIENT" if source.kind == "client" else "MATTER" if source.kind == "matter" else "CLIENT"
        for alias in [source.name, *source.aliases]:
            if len(alias.strip()) >= 4:
                names.append((alias, label))
    try:
        labels = store.application_state_repository.matter_labels_for_tenant(tenant_id)
    except Exception:  # noqa: BLE001 - matter labels are an optional enrichment
        labels = {}
    for label in labels.values():
        if label and len(label.strip()) >= 4:
            names.append((label, "MATTER"))
    return names


def _usable(message: ChatMessage) -> bool:
    return message.role in ("user", "assistant") and message.status == "ok" and bool(message.content.strip())


def _context_before(
    messages: list[ChatMessage], index: int, limit: int, scrub: _Deidentifier
) -> list[TrainingMessage]:
    earlier = [message for message in messages[:index] if _usable(message)]
    window = earlier[-limit:]
    # A prompt must open on the person's turn.
    while window and window[0].role != "user":
        window = window[1:]
    return [TrainingMessage(role=message.role, content=scrub(message.content)) for message in window]


def _next_user_index(messages: list[ChatMessage], start: int) -> int | None:
    for index in range(start + 1, len(messages)):
        if messages[index].role == "user":
            return index
        if messages[index].role == "assistant" and messages[index].status == "ok":
            return None
    return None


def _next_assistant_index(messages: list[ChatMessage], start: int) -> int | None:
    for index in range(start + 1, len(messages)):
        if messages[index].role == "assistant":
            return index if _usable(messages[index]) else None
        if messages[index].role == "user":
            return None
    return None


def _version_texts(message: ChatMessage) -> tuple[str, str] | None:
    """(rejected, chosen) when the person regenerated this answer."""
    versions = (message.metadata or {}).get("responseVersions")
    if not isinstance(versions, list) or len(versions) < 2:
        return None
    ok = [
        version
        for version in versions
        if isinstance(version, dict) and version.get("status") == "ok" and str(version.get("content") or "").strip()
    ]
    if len(ok) < 2:
        return None
    active = (message.metadata or {}).get("activeResponseVersionIndex")
    chosen = versions[active] if isinstance(active, int) and 0 <= active < len(versions) else ok[-1]
    if not isinstance(chosen, dict) or chosen.get("status") != "ok":
        return None
    rejected = next((version for version in ok if version is not chosen), None)
    if rejected is None:
        return None
    return str(rejected.get("content") or ""), str(chosen.get("content") or "")


def build_thread_examples(
    store: "SeedStore",
    thread: ChatThread,
    policy: TrainingCapturePolicy,
    feedback: Iterable[ChatFeedbackRecord],
) -> list[TrainingExample]:
    owner = store.users.get(thread.owner_user_id)
    if owner is None:
        return []
    group_ids = [
        group_id
        for group_id in owner.group_ids
        if (group := store.groups.get(group_id)) is not None and not group.default_group
    ]
    if set(owner.group_ids) & set(policy.excluded_group_ids):
        return []
    tags = store.list_chat_thread_tags(tenant_id=thread.tenant_id, thread_id=thread.id)
    if policy.exclude_sensitive_chats and any(tag.namespace in EXCLUDING_TAG_NAMESPACES for tag in tags):
        return []
    subject = next((tag for tag in tags if tag.namespace == SUBJECT_TAG_NAMESPACE), None)
    ratings = {record.message_id: record for record in feedback if record.user_id == thread.owner_user_id}
    names = _known_names(store, thread.tenant_id) if policy.conceal_names else []
    messages = thread.messages
    user_words = [message.content for message in messages if message.role == "user" and _usable(message)]
    if subject is not None:
        practice_area = subject.key if not subject.value else f"{subject.key}/{subject.value}"
        practice_source = "subject_tag"
    else:
        practice_area = practice_area_from_keywords(user_words)
        practice_source = "keywords" if practice_area else ""

    examples: list[TrainingExample] = []
    now = clock.now()
    scrub = _Deidentifier(names)
    for index, message in enumerate(messages):
        if message.role != "assistant" or not _usable(message) or len(message.content.strip()) < MIN_RESPONSE_CHARS:
            continue
        prompt = _context_before(messages, index, policy.context_messages, scrub)
        if not prompt or prompt[-1].role != "user":
            continue
        # The person's latest words name the work; when they are only a
        # follow-up ("please revise"), the earlier turns in the window do.
        task_type = task_type_from_keywords(prompt[-1].content)
        if task_type == "general":
            task_type = task_type_from_keywords(
                "\n".join(item.content for item in prompt if item.role == "user")
            )
        base = {
            "tenant_id": thread.tenant_id,
            "thread_id": thread.id,
            "message_id": message.id,
            "user_id": thread.owner_user_id,
            "model_id": thread.model_id,
            "practice_area": practice_area,
            "practice_source": practice_source,
            "task_type": task_type,
            "group_ids": group_ids,
            "prompt": prompt,
            "captured_at": now,
            "updated_at": now,
        }
        rating = ratings.get(message.id)
        if rating is not None and (
            (rating.rating == "positive" and policy.capture_positive)
            or (rating.rating == "negative" and policy.capture_negative)
        ):
            examples.append(
                TrainingExample(
                    id=new_example_id(),
                    signal=rating.rating,
                    completion=scrub(message.content),
                    comment=scrub(rating.comment),
                    **base,
                )
            )
        if not policy.capture_corrections:
            continue
        follow_index = _next_user_index(messages, index)
        follow = messages[follow_index] if follow_index is not None else None
        if follow is not None and _usable(follow) and is_correction(follow.content):
            revision_index = _next_assistant_index(messages, follow_index)
            revision = messages[revision_index] if revision_index is not None else None
            accepted = False
            if revision is not None:
                revision_rating = ratings.get(revision.id)
                after = _next_user_index(messages, revision_index)
                accepted = (revision_rating is None or revision_rating.rating == "positive") and not (
                    after is not None and is_correction(messages[after].content)
                )
            examples.append(
                TrainingExample(
                    id=new_example_id(),
                    signal="correction",
                    correction_kind="follow_up",
                    completion=scrub(message.content),
                    correction=scrub(follow.content),
                    revision=scrub(revision.content) if revision is not None else "",
                    revision_accepted=accepted,
                    **base,
                )
            )
            continue
        regenerated = _version_texts(message)
        if regenerated is not None:
            rejected, chosen = regenerated
            current = ratings.get(message.id)
            examples.append(
                TrainingExample(
                    id=new_example_id(),
                    signal="correction",
                    correction_kind="regenerate",
                    completion=scrub(rejected),
                    revision=scrub(chosen),
                    revision_accepted=current is None or current.rating == "positive",
                    **base,
                )
            )
    return [example.model_copy(update={"redaction_count": concealed_value_count(example)}) for example in examples]


def capture_thread(store: "SeedStore", thread: ChatThread) -> int:
    """Recapture one thread's signals. Returns how many examples are new.

    Best effort by design: a capture failure is logged and never fails the
    chat save that triggered it.
    """
    try:
        repository = store.data_protection_repository
        policy = repository.training_policy(thread.tenant_id)
        if not policy.enabled:
            return 0
        feedback = store.list_chat_feedback_for_thread(thread.id)
        examples = build_thread_examples(store, thread, policy, feedback)
        return repository.replace_thread_examples(
            tenant_id=thread.tenant_id,
            thread_id=thread.id,
            examples=examples,
            auto_approve=not policy.require_review,
        )
    except Exception:  # noqa: BLE001 - capture must never break a chat save
        logger.warning("Training capture failed for a chat thread", exc_info=True)
        return 0
