"""Ethical walls on knowledge documents.

A wall limits who can retrieve one document's passages, on top of the knowledge
base's own sharing. Walls come from the file's preserved metadata (for example a
Box or Office property named "Ethical wall") or from an administrator, and they
apply to everyone outside the wall -- tenant admins and the platform owner too.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.knowledge_walls import resolve_document_wall
from app.core.policy import knowledge_chunk_visible_to_user, knowledge_wall_allows
from app.main import app
from app.models.schemas import (
    Group,
    KnowledgeChunk,
    KnowledgeConfig,
    KnowledgeDocument,
    Role,
    User,
)
from app.repositories.deps import get_store

client = TestClient(app)

CONFIG_ID = "knowledge-walls-test"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _group(group_id: str, name: str, tenant_id: str = "tenant-example") -> Group:
    return Group(
        id=group_id,
        tenant_id=tenant_id,
        name=name,
        distinguished_name=f"CN={name}",
        entra_object_id=group_id,
    )


def _groups() -> list[Group]:
    return [
        _group("group-falcon", "Project Falcon"),
        _group("group-heron", "Heron Team"),
        _group("group-elsewhere", "Project Osprey", tenant_id="tenant-other"),
    ]


def _user(role: Role = Role.USER, groups: list[str] | None = None) -> User:
    return User(
        id="user-test",
        tenant_id="tenant-example",
        email="test@example.com",
        display_name="Test User",
        role=role,
        group_ids=list(groups or []),
    )


def _chunk(**updates: object) -> KnowledgeChunk:
    values: dict[str, object] = {
        "id": "chunk-1",
        "knowledge_config_id": CONFIG_ID,
        "document_id": "doc-1",
        "tenant_id": "tenant-example",
        "source_name": "memo.pdf",
        "source_uri": "upload://memo.pdf",
        "source_type": "upload",
        "text": "Falcon acquisition price is confidential.",
        "updated_at": "now",
    }
    values.update(updates)
    return KnowledgeChunk(**values)


# ------------------------------------------------------------------ policy


def test_no_wall_allows_everyone() -> None:
    assert knowledge_wall_allows(_user(), None) is True


def test_wall_allows_only_members() -> None:
    assert knowledge_wall_allows(_user(groups=["group-falcon"]), ["group-falcon"]) is True
    assert knowledge_wall_allows(_user(groups=["group-heron"]), ["group-falcon"]) is False


def test_closed_wall_allows_nobody() -> None:
    assert knowledge_wall_allows(_user(groups=["group-falcon"]), []) is False


@pytest.mark.parametrize("role", [Role.TENANT_ADMIN, Role.PLATFORM_OWNER])
def test_wall_applies_to_admins_and_owner(role: Role) -> None:
    chunk = _chunk(wall_group_ids=["group-falcon"])
    assert knowledge_chunk_visible_to_user(_user(role=role), chunk) is False
    assert knowledge_chunk_visible_to_user(_user(role=role, groups=["group-falcon"]), chunk) is True


def test_unwalled_chunk_keeps_existing_sharing_rules() -> None:
    shared = _chunk(acl_group_ids=["group-litigation"])
    assert knowledge_chunk_visible_to_user(_user(groups=["group-litigation"]), shared) is True
    assert knowledge_chunk_visible_to_user(_user(groups=["group-hr"]), shared) is False
    assert knowledge_chunk_visible_to_user(_user(role=Role.TENANT_ADMIN), shared) is True
    other_tenant = _chunk(tenant_id="tenant-other")
    assert knowledge_chunk_visible_to_user(_user(), other_tenant) is False


# --------------------------------------------------------------- resolution


def test_metadata_wall_names_groups_by_name_or_id() -> None:
    wall = resolve_document_wall(
        {"Title": "Memo", "Ethical wall": "Project Falcon; group-heron"},
        tenant_id="tenant-example",
        groups=_groups(),
    )
    assert wall is not None
    assert wall.source == "metadata"
    assert wall.field == "Ethical wall"
    assert wall.group_ids == ["group-falcon", "group-heron"]
    assert wall.values == ["Project Falcon", "group-heron"]
    assert wall.unresolved == []


def test_metadata_wall_field_match_ignores_case_spacing_and_prefix() -> None:
    wall = resolve_document_wall(
        {"Box metadata · Matter Info · ETHICAL_WALL": "project  falcon"},
        tenant_id="tenant-example",
        groups=_groups(),
    )
    assert wall is not None
    assert wall.group_ids == ["group-falcon"]


def test_unknown_wall_group_fails_closed() -> None:
    wall = resolve_document_wall(
        {"Information barrier": "Project Kestrel"},
        tenant_id="tenant-example",
        groups=_groups(),
    )
    assert wall is not None
    assert wall.group_ids == []
    assert wall.unresolved == ["Project Kestrel"]


def test_wall_never_matches_another_tenants_group() -> None:
    wall = resolve_document_wall(
        {"Ethical wall": "Project Osprey"},
        tenant_id="tenant-example",
        groups=_groups(),
    )
    assert wall is not None
    assert wall.group_ids == []
    assert wall.unresolved == ["Project Osprey"]


def test_custom_wall_field_from_knowledge_base_settings() -> None:
    metadata = {"Matter team": "Heron Team"}
    assert resolve_document_wall(metadata, tenant_id="tenant-example", groups=_groups()) is None
    wall = resolve_document_wall(
        metadata,
        tenant_id="tenant-example",
        groups=_groups(),
        extra_fields=["matter team"],
    )
    assert wall is not None and wall.group_ids == ["group-heron"]


def test_blank_wall_value_is_no_wall() -> None:
    assert (
        resolve_document_wall({"Ethical wall": "  "}, tenant_id="tenant-example", groups=_groups())
        is None
    )


def test_manual_override_wins_over_metadata() -> None:
    restricted = resolve_document_wall(
        {"Ethical wall": "Project Falcon"},
        tenant_id="tenant-example",
        groups=_groups(),
        override={"mode": "restricted", "group_ids": ["group-heron"]},
    )
    assert restricted is not None
    assert restricted.source == "manual"
    assert restricted.group_ids == ["group-heron"]
    opened = resolve_document_wall(
        {"Ethical wall": "Project Falcon"},
        tenant_id="tenant-example",
        groups=_groups(),
        override={"mode": "open"},
    )
    assert opened is None


def test_manual_override_drops_groups_outside_the_tenant() -> None:
    wall = resolve_document_wall(
        {},
        tenant_id="tenant-example",
        groups=_groups(),
        override={"mode": "restricted", "group_ids": ["group-elsewhere", "group-falcon"]},
    )
    assert wall is not None and wall.group_ids == ["group-falcon"]


# ------------------------------------------------------------ store + routes


def _install_walled_base(*, acl: list[str] | None = None) -> None:
    store = get_store()
    store.groups["group-falcon"] = _group("group-falcon", "Project Falcon")
    store.knowledge_configs[CONFIG_ID] = KnowledgeConfig(
        id=CONFIG_ID,
        tenant_id="tenant-example",
        name="Deal room",
        source_type="upload",
        enabled=True,
        acl_group_ids=list(acl if acl is not None else ["group-litigation"]),
        settings={"status": "synced"},
    )
    config = store.knowledge_configs[CONFIG_ID]
    walled = KnowledgeDocument(
        id="doc-walled",
        knowledge_config_id=CONFIG_ID,
        tenant_id="tenant-example",
        name="falcon-memo.docx",
        source_uri="upload://falcon-memo.docx",
        source_type="upload",
        updated_at="now",
        metadata={"Title": "Falcon memo", "Ethical wall": "Project Falcon"},
    )
    open_document = KnowledgeDocument(
        id="doc-open",
        knowledge_config_id=CONFIG_ID,
        tenant_id="tenant-example",
        name="engagement-letter.docx",
        source_uri="upload://engagement-letter.docx",
        source_type="upload",
        updated_at="now",
    )
    chunks = [
        _chunk(
            id="chunk-walled",
            document_id="doc-walled",
            source_name="falcon-memo.docx",
            text="Kestrel valuation memo: the Falcon purchase price is 42 million.",
            acl_group_ids=list(config.acl_group_ids),
        ),
        _chunk(
            id="chunk-open",
            document_id="doc-open",
            source_name="engagement-letter.docx",
            text="Kestrel engagement letter: standard hourly billing terms.",
            acl_group_ids=list(config.acl_group_ids),
        ),
    ]
    store.append_knowledge_sources(
        config,
        [walled, open_document],
        chunks,
        synced_at="now",
        provider_status="live",
        provider_message="seeded",
    )


def _hit_documents(user_id: str) -> set[str]:
    store = get_store()
    hits = store.retrieve_knowledge(store.users[user_id], [CONFIG_ID], "Kestrel memo", limit=10)
    return {hit.document_id for hit in hits}


def test_store_applies_metadata_wall_when_documents_are_indexed() -> None:
    _install_walled_base()
    documents = {item.id: item for item in get_store().knowledge_documents_for(CONFIG_ID)}
    assert documents["doc-walled"].wall is not None
    assert documents["doc-walled"].wall.group_ids == ["group-falcon"]
    assert documents["doc-open"].wall is None
    chunks = {item.id: item for item in get_store().knowledge_chunks_for(CONFIG_ID)}
    assert chunks["chunk-walled"].wall_group_ids == ["group-falcon"]
    assert chunks["chunk-open"].wall_group_ids is None


def test_retrieval_hides_walled_passages_from_people_outside_the_wall() -> None:
    _install_walled_base()
    store = get_store()
    # user-jane shares the knowledge base (Litigation) but is not on the wall;
    # user-admin is a tenant admin and is not on the wall either.
    assert _hit_documents("user-jane") == {"doc-open"}
    assert _hit_documents("user-admin") == {"doc-open"}
    assert _hit_documents("user-owner") == {"doc-open"}
    store.users["user-jane"].group_ids = ["group-litigation", "group-falcon"]
    assert _hit_documents("user-jane") == {"doc-open", "doc-walled"}


def test_resharing_the_base_keeps_document_walls() -> None:
    _install_walled_base()
    store = get_store()
    config = store.knowledge_configs[CONFIG_ID]
    config.acl_group_ids = ["group-litigation", "group-finance"]
    store.update_knowledge_acl(config)
    chunks = {item.id: item for item in store.knowledge_chunks_for(CONFIG_ID)}
    assert chunks["chunk-walled"].wall_group_ids == ["group-falcon"]
    assert _hit_documents("user-admin") == {"doc-open"}


def test_document_list_hides_walled_documents_from_readers_outside_the_wall() -> None:
    _install_walled_base()
    response = client.get(f"/api/knowledge/{CONFIG_ID}/documents", headers=headers("user-jane"))
    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == ["doc-open"]

    admin_view = client.get(f"/api/knowledge/{CONFIG_ID}/documents", headers=headers("user-admin"))
    assert admin_view.status_code == 200
    by_id = {item["id"]: item for item in admin_view.json()}
    # Administrators manage the base, so they see the document exists and why it
    # is walled, but retrieval still excludes it for them.
    assert by_id["doc-walled"]["wall"]["group_ids"] == ["group-falcon"]


def test_admin_can_restrict_and_open_a_document_with_audit() -> None:
    _install_walled_base()
    restrict = client.put(
        f"/api/knowledge/{CONFIG_ID}/documents/doc-open/access",
        headers=headers("user-admin"),
        json={"mode": "restricted", "group_ids": ["group-falcon"]},
    )
    assert restrict.status_code == 200, restrict.text
    assert _hit_documents("user-jane") == set()

    opened = client.put(
        f"/api/knowledge/{CONFIG_ID}/documents/doc-walled/access",
        headers=headers("user-admin"),
        json={"mode": "open"},
    )
    assert opened.status_code == 200, opened.text
    assert _hit_documents("user-jane") == {"doc-walled"}

    reset = client.put(
        f"/api/knowledge/{CONFIG_ID}/documents/doc-walled/access",
        headers=headers("user-admin"),
        json={"mode": "metadata"},
    )
    assert reset.status_code == 200
    assert _hit_documents("user-jane") == set()

    events = [event for event in get_store().audit_events if event.action == "knowledge.document_wall_changed"]
    assert len(events) == 3
    assert events[0].metadata["mode"] == "restricted"
    assert events[0].metadata["group_ids"] == ["group-falcon"]


def test_restricting_needs_a_group_and_rejects_unknown_groups() -> None:
    _install_walled_base()
    empty = client.put(
        f"/api/knowledge/{CONFIG_ID}/documents/doc-open/access",
        headers=headers("user-admin"),
        json={"mode": "restricted", "group_ids": []},
    )
    assert empty.status_code == 400
    unknown = client.put(
        f"/api/knowledge/{CONFIG_ID}/documents/doc-open/access",
        headers=headers("user-admin"),
        json={"mode": "restricted", "group_ids": ["group-missing"]},
    )
    assert unknown.status_code == 400


def test_only_admins_can_open_a_metadata_wall() -> None:
    _install_walled_base(acl=[])
    store = get_store()
    config = store.knowledge_configs[CONFIG_ID]
    config.owner_user_id = "user-jane"
    response = client.put(
        f"/api/knowledge/{CONFIG_ID}/documents/doc-walled/access",
        headers=headers("user-jane"),
        json={"mode": "open"},
    )
    assert response.status_code == 403


def test_readers_cannot_change_walls() -> None:
    _install_walled_base()
    response = client.put(
        f"/api/knowledge/{CONFIG_ID}/documents/doc-open/access",
        headers=headers("user-jane"),
        json={"mode": "restricted", "group_ids": ["group-litigation"]},
    )
    assert response.status_code == 403


def test_wall_overrides_cannot_be_written_through_config_settings() -> None:
    _install_walled_base(acl=[])
    store = get_store()
    store.knowledge_configs[CONFIG_ID].owner_user_id = "user-jane"
    response = client.patch(
        f"/api/admin/knowledge-configs/{CONFIG_ID}",
        headers=headers("user-jane"),
        json={"settings": {"document_walls": {"doc-walled": {"mode": "open"}}}},
    )
    assert response.status_code == 403
    assert "document_walls" not in store.knowledge_configs[CONFIG_ID].settings


def test_changing_wall_fields_reapplies_walls() -> None:
    _install_walled_base()
    response = client.patch(
        f"/api/admin/knowledge-configs/{CONFIG_ID}",
        headers=headers("user-admin"),
        json={"settings": {"wall_fields": ["Title"]}},
    )
    assert response.status_code == 200, response.text
    # "Title: Falcon memo" names no group, so the open document stays open and
    # the walled one keeps its default "Ethical wall" field wall.
    documents = {item.id: item for item in get_store().knowledge_documents_for(CONFIG_ID)}
    wall = documents["doc-walled"].wall
    assert wall is not None
    assert wall.group_ids == ["group-falcon"]
    assert wall.unresolved == ["Falcon memo"]


def test_sync_reapplies_walls_after_a_group_is_created() -> None:
    _install_walled_base()
    store = get_store()
    del store.groups["group-falcon"]
    store.reapply_knowledge_walls(store.knowledge_configs[CONFIG_ID])
    documents = {item.id: item for item in store.knowledge_documents_for(CONFIG_ID)}
    assert documents["doc-walled"].wall is not None
    assert documents["doc-walled"].wall.group_ids == []
    store.groups["group-falcon"] = _group("group-falcon", "Project Falcon")
    response = client.post(f"/api/knowledge/{CONFIG_ID}/sync", headers=headers("user-admin"))
    assert response.status_code == 200
    documents = {item.id: item for item in store.knowledge_documents_for(CONFIG_ID)}
    assert documents["doc-walled"].wall.group_ids == ["group-falcon"]
