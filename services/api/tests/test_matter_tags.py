"""Client-matter tags on knowledge bases, end to end through the real routes.

A user names a matter (for example a client-matter number), links a
knowledge base to it through the membership-gated matters router, and every
viewer of that base then sees the matter's label in their workspace payload,
so records staff can find a matter's bases by number. All data is synthetic.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import KnowledgeConfig
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _private_base(config_id: str, owner_user_id: str) -> None:
    get_store().knowledge_configs[config_id] = KnowledgeConfig(
        id=config_id,
        tenant_id="tenant-example",
        name=f"Synthetic {config_id}",
        source_type="upload",
        enabled=True,
        owner_user_id=owner_user_id,
        acl_group_ids=[],
        settings={"description": "Synthetic uploads.", "status": "synced"},
    )


def _bootstrap_bases(user_id: str) -> dict[str, dict]:
    response = client.get("/api/bootstrap", headers=headers(user_id))
    assert response.status_code == 200
    return {item["id"]: item for item in response.json()["knowledgeConfigs"]}


def _tag_base(user_id: str, config_id: str, label: str) -> str:
    created = client.post("/api/matters", headers=headers(user_id), json={"name": label})
    assert created.status_code == 201, created.text
    matter_id = created.json()["id"]
    linked = client.put(
        f"/api/matters/{matter_id}/resources/knowledge-configs/{config_id}",
        headers=headers(user_id),
    )
    assert linked.status_code == 200, linked.text
    return matter_id


def test_tagged_knowledge_base_carries_its_matter_label_to_every_viewer() -> None:
    _private_base("knowledge-matter-jane", "user-jane")
    _private_base("knowledge-untagged-jane", "user-jane")
    matter_id = _tag_base("user-jane", "knowledge-matter-jane", "100234-0001")

    jane = _bootstrap_bases("user-jane")
    assert jane["knowledge-matter-jane"]["matter_id"] == matter_id
    assert jane["knowledge-matter-jane"]["matter_label"] == "100234-0001"
    assert jane["knowledge-untagged-jane"]["matter_label"] is None

    # The administrator is not a member of Jane's matter, yet still needs the
    # number to find this base when the matter's records are cleared out.
    admin = _bootstrap_bases("user-admin")
    assert admin["knowledge-matter-jane"]["matter_label"] == "100234-0001"

    # Someone who cannot see the base learns nothing about its matter.
    assert "knowledge-matter-jane" not in _bootstrap_bases("user-casey")


def test_clearing_the_tag_removes_the_label() -> None:
    _private_base("knowledge-matter-jane", "user-jane")
    matter_id = _tag_base("user-jane", "knowledge-matter-jane", "100234-0002")

    cleared = client.delete(
        f"/api/matters/{matter_id}/resources/knowledge-configs/knowledge-matter-jane",
        headers=headers("user-jane"),
    )
    assert cleared.status_code == 200, cleared.text

    base = _bootstrap_bases("user-jane")["knowledge-matter-jane"]
    assert base["matter_id"] is None
    assert base["matter_label"] is None
