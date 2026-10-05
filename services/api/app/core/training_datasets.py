"""Route captured examples into datasets and package them for training.

Membership is computed, never stored: an example belongs to every dataset
whose rules it satisfies and whose format can use its signal. Exports are
ZIP bundles holding a trainer-ready ``train.jsonl`` (OpenAI/TRL chat
conventions), a line-aligned ``metadata.jsonl``, and a ``README.md``
dataset card. Only approved examples are exported unless the caller asks
for pending ones too; excluded examples never are.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from collections import Counter
from collections.abc import Iterable
from datetime import datetime

from app.core.training_capture import TASK_LABELS, practice_area_label
from app.models.schemas import TrainingDataset, TrainingExample

FORMAT_LABELS = {
    "sft": "Supervised fine-tuning (chat)",
    "preference": "Preference pairs (DPO)",
    "kto": "Binary feedback (KTO)",
}
SIGNAL_LABELS = {"positive": "Rated helpful", "negative": "Rated unhelpful", "correction": "Corrected"}
SUGGESTION_MIN_EXAMPLES = 3


def format_accepts(dataset_format: str, example: TrainingExample) -> bool:
    """Whether an example can produce a record in this format."""
    if dataset_format == "sft":
        return example.signal == "positive" or (example.signal == "correction" and example.revision_accepted)
    if dataset_format == "preference":
        return example.signal == "correction" and example.revision_accepted and bool(example.revision)
    return True  # kto takes every judged response


def _practice_matches(selected: list[str], value: str) -> bool:
    if not selected:
        return True
    return any(value == item or value.startswith(f"{item}/") for item in selected)


def matches(dataset: TrainingDataset, example: TrainingExample) -> bool:
    rules = dataset.rules
    return (
        (not rules.signals or example.signal in rules.signals)
        and _practice_matches(rules.practice_areas, example.practice_area)
        and (not rules.task_types or example.task_type in rules.task_types)
        and (not rules.group_ids or bool(set(rules.group_ids) & set(example.group_ids)))
        and (not rules.model_ids or example.model_id in rules.model_ids)
        and format_accepts(dataset.format, example)
    )


def route(datasets: Iterable[TrainingDataset], examples: list[TrainingExample]) -> tuple[list[TrainingDataset], list[TrainingExample]]:
    """Datasets with derived counts, and examples with their dataset ids."""
    active = [dataset for dataset in datasets]
    routed_examples: list[TrainingExample] = []
    counts: dict[str, Counter[str]] = {dataset.id: Counter() for dataset in active}
    for example in examples:
        ids = [dataset.id for dataset in active if not dataset.archived and matches(dataset, example)]
        for dataset_id in ids:
            counts[dataset_id][example.status] += 1
        routed_examples.append(example.model_copy(update={"dataset_ids": ids}))
    routed_datasets = [
        dataset.model_copy(
            update={
                "example_count": sum(counts[dataset.id][status] for status in ("pending", "approved")),
                "approved_count": counts[dataset.id]["approved"],
                "pending_count": counts[dataset.id]["pending"],
            }
        )
        for dataset in active
    ]
    return routed_datasets, routed_examples


def overview(
    examples: list[TrainingExample],
    datasets: list[TrainingDataset],
    group_names: dict[str, str],
) -> dict[str, object]:
    """Work-mix breakdown and dataset suggestions for the console."""
    live = [example for example in examples if example.status != "excluded"]
    by_status = Counter(example.status for example in examples)
    by_signal = Counter(example.signal for example in live)
    by_practice = Counter(example.practice_area for example in live)
    by_task = Counter(example.task_type for example in live)
    by_group: Counter[str] = Counter()
    for example in live:
        by_group.update(example.group_ids)
    unrouted = sum(1 for example in live if not example.dataset_ids)

    covered_practices = {area for dataset in datasets if not dataset.archived for area in dataset.rules.practice_areas}
    covered_groups = {group for dataset in datasets if not dataset.archived for group in dataset.rules.group_ids}
    suggestions: list[dict[str, object]] = []
    for practice, count in by_practice.most_common():
        if not practice or count < SUGGESTION_MIN_EXAMPLES or practice in covered_practices:
            continue
        practice_examples = [example for example in live if example.practice_area == practice]
        corrections = sum(
            1 for example in practice_examples if example.signal == "correction" and example.revision_accepted
        )
        dataset_format = "preference" if corrections >= SUGGESTION_MIN_EXAMPLES else "sft"
        label = practice_area_label(practice)
        suggestions.append(
            {
                "key": f"practice:{practice}",
                "name": f"{label} — {'corrections' if dataset_format == 'preference' else 'approved answers'}",
                "reason": f"{count} captured examples are labeled {label}.",
                "format": dataset_format,
                "rules": {"practice_areas": [practice], "signals": [], "task_types": [], "group_ids": [], "model_ids": []},
            }
        )
    for group_id, count in by_group.most_common():
        if count < SUGGESTION_MIN_EXAMPLES or group_id in covered_groups or group_id not in group_names:
            continue
        suggestions.append(
            {
                "key": f"group:{group_id}",
                "name": f"{group_names[group_id]} department",
                "reason": f"{count} captured examples came from members of {group_names[group_id]}.",
                "format": "kto",
                "rules": {"group_ids": [group_id], "practice_areas": [], "signals": [], "task_types": [], "model_ids": []},
            }
        )
    return {
        "total": len(examples),
        "pending": by_status["pending"],
        "approved": by_status["approved"],
        "excluded": by_status["excluded"],
        "redactions": sum(example.redaction_count for example in live),
        "unrouted": unrouted,
        "by_signal": dict(by_signal),
        "by_practice_area": [
            {"key": key, "label": practice_area_label(key), "count": count} for key, count in by_practice.most_common()
        ],
        "by_task_type": [
            {"key": key, "label": TASK_LABELS.get(key, key), "count": count} for key, count in by_task.most_common()
        ],
        "by_group": [
            {"key": key, "label": group_names.get(key, key), "count": count} for key, count in by_group.most_common()
        ],
        "suggestions": suggestions[:6],
    }


# --- export -------------------------------------------------------------------------


def _messages(system_prompt: str, prompt: list) -> list[dict[str, str]]:
    messages = [{"role": item.role, "content": item.content} for item in prompt]
    if system_prompt.strip():
        messages.insert(0, {"role": "system", "content": system_prompt.strip()})
    return messages


def training_records(dataset: TrainingDataset, example: TrainingExample) -> list[dict[str, object]]:
    """Trainer-ready rows for one example (a correction can yield two KTO rows)."""
    prompt = _messages(dataset.system_prompt, example.prompt)
    if dataset.format == "sft":
        answer = example.completion if example.signal == "positive" else example.revision
        return [{"messages": [*prompt, {"role": "assistant", "content": answer}]}]
    if dataset.format == "preference":
        return [
            {
                "prompt": prompt,
                "chosen": [{"role": "assistant", "content": example.revision}],
                "rejected": [{"role": "assistant", "content": example.completion}],
            }
        ]
    if example.signal == "correction":
        rows: list[dict[str, object]] = [
            {"prompt": prompt, "completion": [{"role": "assistant", "content": example.completion}], "label": False}
        ]
        if example.revision and example.revision_accepted:
            rows.append(
                {"prompt": prompt, "completion": [{"role": "assistant", "content": example.revision}], "label": True}
            )
        return rows
    return [
        {
            "prompt": prompt,
            "completion": [{"role": "assistant", "content": example.completion}],
            "label": example.signal == "positive",
        }
    ]


def _metadata(example: TrainingExample, group_names: dict[str, str]) -> dict[str, object]:
    # Deliberately no user id, name, thread id, or title: the bundle leaves
    # the deployment and must not re-identify the person behind an example.
    return {
        "example_id": example.id,
        "signal": example.signal,
        "correction_kind": example.correction_kind or None,
        "correction": example.correction or None,
        "comment": example.comment or None,
        "practice_area": example.practice_area or None,
        "practice_area_source": example.practice_source or None,
        "task_type": example.task_type,
        "departments": sorted(group_names.get(group_id, "Unknown group") for group_id in example.group_ids),
        "model_id": example.model_id,
        "captured_on": example.captured_at.date().isoformat(),
        "redactions": example.redaction_count,
        "status": example.status,
    }


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return cleaned[:60] or "dataset"


def export_bundle(
    dataset: TrainingDataset,
    examples: list[TrainingExample],
    *,
    group_names: dict[str, str],
    organization: str,
    generated_at: datetime,
    include_pending: bool,
) -> tuple[bytes, dict[str, int]]:
    allowed = {"approved", "pending"} if include_pending else {"approved"}
    chosen: list[TrainingExample] = []
    seen: set[str] = set()
    for example in examples:
        if example.status not in allowed or not matches(dataset, example):
            continue
        # A forked chat copies earlier turns, so the same signal can be
        # captured twice; identical training content is exported once.
        fingerprint = hashlib.sha256(
            json.dumps(
                [[m.content for m in example.prompt], example.completion, example.revision, example.signal],
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        chosen.append(example)
    train_lines: list[str] = []
    metadata_lines: list[str] = []
    for example in chosen:
        for record in training_records(dataset, example):
            train_lines.append(json.dumps(record, ensure_ascii=False))
            metadata_lines.append(json.dumps(_metadata(example, group_names), ensure_ascii=False))
    stats = {
        "examples": len(chosen),
        "records": len(train_lines),
        "redactions": sum(example.redaction_count for example in chosen),
    }
    rules = dataset.rules
    card = "\n".join(
        [
            f"# {dataset.name}",
            "",
            dataset.description or "Captured from rated and corrected responses in Aperture Chat.",
            "",
            f"- Organization: {organization}",
            f"- Generated: {generated_at.isoformat(timespec='seconds')}",
            f"- Format: {FORMAT_LABELS[dataset.format]} (`train.jsonl`)",
            f"- Examples: {stats['examples']} ({stats['records']} training rows)",
            f"- Review state: {'approved and pending' if include_pending else 'approved only'}",
            f"- Signals: {', '.join(SIGNAL_LABELS[item] for item in rules.signals) or 'any'}",
            f"- Practice areas: {', '.join(practice_area_label(item) for item in rules.practice_areas) or 'any'}",
            f"- Work types: {', '.join(TASK_LABELS.get(item, item) for item in rules.task_types) or 'any'}",
            f"- Departments: {', '.join(group_names.get(item, item) for item in rules.group_ids) or 'any'}",
            f"- Models: {', '.join(rules.model_ids) or 'any'}",
            "",
            "## De-identification",
            "",
            f"Every example was de-identified when it was captured ({stats['redactions']} values replaced).",
            "Detected identifiers (SSNs, contact details, account and card numbers, health",
            "identifiers, secrets, network addresses) appear as typed tokens such as ⟦SSN⟧.",
            "Workspace people and configured client or matter names appear as ⟦PERSON⟧,",
            "⟦CLIENT⟧, or ⟦MATTER⟧ when name concealment was on. Pattern-based detection",
            "cannot recognize every name or free-text description of a person's health,",
            "so review examples before training and keep this bundle inside your organization.",
            "",
            "## Files",
            "",
            "- `train.jsonl`: one training row per line in the format above.",
            "- `metadata.jsonl`: line-aligned labels (signal, practice area, work type,",
            "  departments, model, capture date). It holds no user identities.",
        ]
    )
    buffer = io.BytesIO()
    base = slug(dataset.name)
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{base}/train.jsonl", "\n".join(train_lines) + ("\n" if train_lines else ""))
        archive.writestr(f"{base}/metadata.jsonl", "\n".join(metadata_lines) + ("\n" if metadata_lines else ""))
        archive.writestr(f"{base}/README.md", card + "\n")
    return buffer.getvalue(), stats
