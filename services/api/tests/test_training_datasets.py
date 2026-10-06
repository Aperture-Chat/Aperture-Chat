"""Training-signal capture, dataset routing, review, and export.

Uses the seeded demo store through the app like the other route suites.
All data is synthetic.
"""

from __future__ import annotations

import io
import json
import zipfile
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core import clock
from app.core.training_capture import correction_strength, is_correction, practice_area_from_keywords, task_type_from_keywords
from app.main import app
from app.models.schemas import ChatThreadTag
from app.repositories.deps import get_store

client = TestClient(app)
SSN = "123-45-6789"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def message(message_id: str, role: str, content: str) -> dict:
    return {"id": message_id, "role": role, "content": content, "createdAt": "Now", "status": "ok"}


CORRECTION_CHAT = [
    message("u1", "user", f"Draft a motion to compel discovery responses for the plaintiff. Client SSN {SSN}."),
    message("a1", "assistant", "Here is a motion to compel. Responses are due within 14 days of service under the rule."),
    message("u2", "user", "No, that's wrong. The response deadline should be 30 days, not 14. Please revise."),
    message("a2", "assistant", "Revised motion: responses are due within 30 days of service, as you noted."),
]


def enable_capture(**overrides: object) -> dict:
    response = client.patch("/api/admin/training/policy", json={"enabled": True, **overrides}, headers=headers("user-admin"))
    assert response.status_code == 200, response.text
    return response.json()


def save_thread(thread_id: str, messages: list[dict], user_id: str = "user-jane") -> None:
    response = client.put(
        f"/api/chat/threads/{thread_id}",
        headers=headers(user_id),
        json={"title": "Synthetic matter", "model_id": "gpt-4o", "messages": messages},
    )
    assert response.status_code == 200, response.text


def examples(**params: str) -> list[dict]:
    query = "&".join(f"{key}={value}" for key, value in params.items())
    response = client.get(f"/api/admin/training/examples?{query}", headers=headers("user-admin"))
    assert response.status_code == 200, response.text
    return response.json()["items"]


def test_correction_and_label_classifiers() -> None:
    assert is_correction("No, that's wrong. The deadline should be 30 days.")
    assert is_correction("Too long. Rewrite it shorter.")
    assert not is_correction("Thanks, now draft the cover email.")
    assert correction_strength("You missed the indemnification clause") >= 2
    assert practice_area_from_keywords(["Draft a motion to compel discovery from the defendant"]) == "legal/litigation"
    assert practice_area_from_keywords(["Roth IRA rollover question"]) == "financial/ira"
    assert practice_area_from_keywords(["hello there"]) == ""
    assert task_type_from_keywords("Summarize this deposition transcript") == "summarization"
    assert task_type_from_keywords("Redline the indemnity clause") == "review"


def test_nothing_is_captured_until_an_admin_opts_in() -> None:
    save_thread("thread-off", CORRECTION_CHAT)
    assert examples() == []
    assert client.get("/api/admin/training/policy", headers=headers("user-jane")).status_code == 403
    assert client.get("/api/admin/training/overview", headers=headers("user-jane")).status_code == 403


def test_corrections_and_ratings_are_captured_de_identified_and_labeled() -> None:
    enable_capture()
    save_thread("thread-correction", CORRECTION_CHAT)
    captured = examples()
    assert [item["signal"] for item in captured] == ["correction"]
    correction = captured[0]
    assert correction["status"] == "pending"
    assert correction["practice_area"] == "legal/litigation" and correction["practice_source"] == "keywords"
    assert correction["task_type"] == "drafting"
    assert correction["group_ids"] == ["group-litigation"]
    assert correction["revision_accepted"] is True
    assert "30 days" in correction["revision"] and "14 days" in correction["completion"]
    assert SSN not in json.dumps(correction) and "⟦SSN⟧" in correction["prompt"][0]["content"]
    assert correction["redaction_count"] >= 1

    rated = client.post(
        "/api/chat/feedback",
        headers=headers("user-jane"),
        json={"thread_id": "thread-correction", "message_id": "a1", "rating": "negative", "comment": "Wrong deadline"},
    )
    assert rated.status_code == 200
    signals = sorted(item["signal"] for item in examples())
    assert signals == ["correction", "negative"]

    # Flipping the thumb replaces the old signal instead of keeping both.
    client.post(
        "/api/chat/feedback",
        headers=headers("user-jane"),
        json={"thread_id": "thread-correction", "message_id": "a1", "rating": "positive"},
    )
    assert sorted(item["signal"] for item in examples()) == ["correction", "positive"]


def test_workspace_names_are_concealed_and_sensitive_chats_are_skipped() -> None:
    enable_capture()
    store = get_store()
    jane = store.users["user-jane"]
    save_thread(
        "thread-names",
        [
            message("u1", "user", f"Ask {jane.display_name} to review the indemnity clause in the contract."),
            message("a1", "assistant", f"{jane.display_name} should review clause 9, which carries the indemnity cap."),
            message("u2", "user", "That's incorrect, the cap is in clause 12. Fix it."),
            message("a2", "assistant", "Corrected: the indemnity cap is in clause 12."),
        ],
    )
    captured = examples()
    content = [
        {key: item[key] for key in ("prompt", "completion", "correction", "revision", "comment")} for item in captured
    ]
    # The admin list still names who the example came from; the content does not.
    assert captured and jane.display_name not in json.dumps(content)
    assert "⟦PERSON⟧" in captured[0]["prompt"][0]["content"]

    store.apply_chat_thread_tag(
        ChatThreadTag(
            id=f"tag-{uuid4()}",
            tenant_id=jane.tenant_id,
            thread_id="thread-sensitive",
            namespace="suggested_sensitive",
            key="ssn",
            value="Possible Social Security number",
            applied_at=clock.now(),
        )
    )
    save_thread("thread-sensitive", CORRECTION_CHAT)
    assert all(item["thread_id"] != "thread-sensitive" for item in examples())


def test_excluded_groups_are_never_captured() -> None:
    enable_capture(excluded_group_ids=["group-litigation"])
    save_thread("thread-excluded", CORRECTION_CHAT)
    assert examples() == []


def test_datasets_route_review_and_export_trainer_ready_bundles() -> None:
    enable_capture(require_review=True)
    save_thread("thread-export", CORRECTION_CHAT)
    client.post(
        "/api/chat/feedback",
        headers=headers("user-jane"),
        json={"thread_id": "thread-export", "message_id": "a2", "rating": "positive"},
    )
    preference = client.post(
        "/api/admin/training/datasets",
        headers=headers("user-admin"),
        json={"name": "Litigation corrections", "format": "preference", "rules": {"practice_areas": ["legal"]}},
    )
    assert preference.status_code == 201, preference.text
    sft = client.post(
        "/api/admin/training/datasets",
        headers=headers("user-admin"),
        json={"name": "Approved answers", "format": "sft", "rules": {"group_ids": ["group-litigation"]}},
    ).json()
    invalid = client.post(
        "/api/admin/training/datasets",
        headers=headers("user-admin"),
        json={"name": "Bad", "format": "sft", "rules": {"practice_areas": ["astrology"]}},
    )
    assert invalid.status_code == 422

    overview = client.get("/api/admin/training/overview", headers=headers("user-admin")).json()
    counts = {dataset["name"]: (dataset["pending_count"], dataset["approved_count"]) for dataset in overview["datasets"]}
    assert counts == {"Litigation corrections": (1, 0), "Approved answers": (2, 0)}

    # Nothing pending is exported by default.
    empty = client.get(f"/api/admin/training/datasets/{preference.json()['id']}/export", headers=headers("user-admin"))
    with zipfile.ZipFile(io.BytesIO(empty.content)) as archive:
        assert archive.read("litigation-corrections/train.jsonl") == b""

    ids = [item["id"] for item in examples()]
    reviewed = client.post(
        "/api/admin/training/examples/review",
        headers=headers("user-admin"),
        json={"example_ids": ids, "status": "approved"},
    )
    assert reviewed.json() == {"reviewed": 2}

    exported = client.get(f"/api/admin/training/datasets/{preference.json()['id']}/export", headers=headers("user-admin"))
    assert exported.status_code == 200
    assert exported.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        rows = [json.loads(line) for line in archive.read("litigation-corrections/train.jsonl").decode().splitlines()]
        metadata = [json.loads(line) for line in archive.read("litigation-corrections/metadata.jsonl").decode().splitlines()]
        card = archive.read("litigation-corrections/README.md").decode()
    assert len(rows) == 1 and set(rows[0]) == {"prompt", "chosen", "rejected"}
    assert "30 days" in rows[0]["chosen"][0]["content"] and "14 days" in rows[0]["rejected"][0]["content"]
    assert metadata[0]["departments"] == ["Litigation"] and "user_id" not in metadata[0]
    assert "Preference pairs" in card
    everything = json.dumps(rows) + json.dumps(metadata) + card
    assert SSN not in everything and "user-jane" not in everything and "thread-export" not in everything

    sft_export = client.get(f"/api/admin/training/datasets/{sft['id']}/export", headers=headers("user-admin"))
    with zipfile.ZipFile(io.BytesIO(sft_export.content)) as archive:
        sft_rows = [json.loads(line) for line in archive.read("approved-answers/train.jsonl").decode().splitlines()]
    assert all(row["messages"][-1]["role"] == "assistant" for row in sft_rows)
    assert any(event.action == "training.dataset_exported" for event in get_store().audit_events)


def test_deleting_a_chat_removes_its_examples() -> None:
    enable_capture()
    save_thread("thread-delete", CORRECTION_CHAT)
    assert examples()
    deleted = client.delete("/api/chat/threads/thread-delete", headers=headers("user-jane"))
    assert deleted.status_code == 200
    assert examples() == []


def test_scan_captures_chats_saved_before_capture_was_on() -> None:
    save_thread("thread-earlier", CORRECTION_CHAT)
    assert client.post("/api/admin/training/scan", headers=headers("user-admin")).status_code == 409
    enable_capture()
    scanned = client.post("/api/admin/training/scan", headers=headers("user-admin")).json()
    assert scanned["scanned"] >= 1 and scanned["captured"] >= 1
    assert any(item["thread_id"] == "thread-earlier" for item in examples())


def test_tenant_admin_cannot_read_another_admins_examples() -> None:
    enable_capture()
    save_thread("thread-admin-drew", CORRECTION_CHAT, user_id="user-drew")
    assert examples() == []  # user-admin cannot audit a fellow tenant admin
    owner_view = client.get("/api/admin/training/examples", headers=headers("user-owner")).json()
    assert owner_view["total"] == 1


def test_an_approved_example_returns_to_review_when_its_text_changes() -> None:
    enable_capture()
    save_thread("thread-reapprove", CORRECTION_CHAT)
    example_id = examples()[0]["id"]
    client.post(
        "/api/admin/training/examples/review",
        headers=headers("user-admin"),
        json={"example_ids": [example_id], "status": "approved"},
    )
    assert examples(status="approved")[0]["id"] == example_id
    edited = [*CORRECTION_CHAT[:3], message("a2", "assistant", "Revised again: responses are due within 28 days.")]
    save_thread("thread-reapprove", edited)
    pending = examples(status="pending")
    assert [item["id"] for item in pending] == [example_id]
    assert pending[0]["reviewed_by"] is None
