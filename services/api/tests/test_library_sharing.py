"""Who gets a prompt or a skill.

Whoever creates a prompt or skill picks its audience: Only me, everyone in
the workspace, or specific groups. An Only me item exists for its owner alone:
another tenant admin never sees it in a listing, the workspace payload, the
audit trail, or a lookup (404, never 403, so its existence does not leak). A
group share reaches the people in those groups, and tenant admins keep
managing it. Platform owners see and manage everything.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.policy import library_item_shared_with, library_item_visible_to
from app.main import app
from app.models.schemas import PromptTemplate, Role, SkillFile
from app.repositories.deps import get_store
from app.routes.chat import _resolve_prompt_templates, _resolve_skill_files

client = TestClient(app)

ADMIN_A = "user-admin"  # tenant admin, in litigation and finance
ADMIN_B = "user-drew"  # tenant admin, in litigation
OWNER = "user-owner"  # platform owner
LITIGATOR = "user-jane"  # regular user, in litigation
PENDING = "user-maya"  # regular user, in no group
FINANCE = "group-finance"
LITIGATION = "group-litigation"


@dataclass(frozen=True)
class Kind:
    path: str
    payload_key: str
    collection: str
    profile_field: str
    model: type
    noun: str
    body: dict[str, object] = field(default_factory=dict)

    def resolve(self, store, actor, ids):
        resolver = _resolve_prompt_templates if self.model is PromptTemplate else _resolve_skill_files
        return resolver(store, actor, ids)

    def records(self, store) -> dict:
        return getattr(store, self.collection)


PROMPT = Kind(
    path="/api/admin/prompt-templates",
    payload_key="promptTemplates",
    collection="prompt_templates",
    profile_field="prompt_template_ids",
    model=PromptTemplate,
    noun="prompt",
    body={"name": "My hearing notes", "content": "Summarize {{topic}} for me."},
)
SKILL = Kind(
    path="/api/admin/skill-files",
    payload_key="skillFiles",
    collection="skill_files",
    profile_field="skill_file_ids",
    model=SkillFile,
    noun="skill",
    body={"name": "My drafting habits", "content": "# Always write in short sentences"},
)
KINDS = pytest.mark.parametrize("kind", [PROMPT, SKILL], ids=["prompt", "skill"])


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _create(kind: Kind, user_id: str = ADMIN_A, **overrides: object):
    return client.post(kind.path, headers=headers(user_id), json={**kind.body, **overrides})


def _created(kind: Kind, user_id: str = ADMIN_A, **overrides: object) -> dict:
    response = _create(kind, user_id, **overrides)
    assert response.status_code == 201, response.text
    return response.json()


def _only_me(kind: Kind, user_id: str = ADMIN_A) -> str:
    return _created(kind, user_id, only_me=True)["id"]


def _patch(kind: Kind, item_id: str, user_id: str, **changes: object):
    return client.patch(f"{kind.path}/{item_id}", headers=headers(user_id), json=changes)


def _listed(kind: Kind, user_id: str) -> set[str]:
    response = client.get(kind.path, headers=headers(user_id))
    assert response.status_code == 200, response.text
    return {item["id"] for item in response.json()}


def _in_workspace(kind: Kind, user_id: str) -> set[str]:
    response = client.get("/api/bootstrap", headers=headers(user_id))
    assert response.status_code == 200, response.text
    return {item["id"] for item in response.json()[kind.payload_key]}


def _legacy(kind: Kind, item_id: str = "legacy-item") -> str:
    """An item saved before creators were recorded."""
    kind.records(get_store())[item_id] = kind.model(
        id=item_id, tenant_id="tenant-example", name="Old item", content="Old content"
    )
    return item_id


# --- Creating -----------------------------------------------------------------


@KINDS
def test_the_creator_can_keep_a_new_item_to_themselves(kind: Kind) -> None:
    item = _created(kind, only_me=True)
    assert (item["only_me"], item["owner_user_id"], item["group_ids"]) == (True, ADMIN_A, [])


@KINDS
def test_a_new_item_is_shared_with_everyone_unless_the_creator_says_otherwise(kind: Kind) -> None:
    item = _created(kind)
    assert (item["only_me"], item["owner_user_id"], item["group_ids"]) == (False, ADMIN_A, [])


@KINDS
def test_the_creator_can_share_a_new_item_with_chosen_groups(kind: Kind) -> None:
    item = _created(kind, group_ids=[FINANCE])
    assert (item["only_me"], item["group_ids"]) == (False, [FINANCE])


@KINDS
def test_only_me_cannot_also_name_groups(kind: Kind) -> None:
    response = _create(kind, only_me=True, group_ids=[LITIGATION])
    assert response.status_code == 400, response.text
    assert "Only me" in response.json()["detail"]


@KINDS
def test_a_platform_owner_can_keep_an_item_to_themselves(kind: Kind) -> None:
    item = _created(kind, OWNER, only_me=True, tenant_id="tenant-example")
    assert (item["only_me"], item["owner_user_id"]) == (True, OWNER)
    assert item["id"] not in _listed(kind, ADMIN_A)


# --- Who sees it --------------------------------------------------------------


@KINDS
def test_an_only_me_item_reaches_its_owner_and_platform_owners_alone(kind: Kind) -> None:
    item_id = _only_me(kind)
    for viewer in (ADMIN_A, OWNER):
        assert item_id in _listed(kind, viewer)
        assert item_id in _in_workspace(kind, viewer)
    assert item_id not in _listed(kind, ADMIN_B)
    for viewer in (ADMIN_B, LITIGATOR, PENDING):
        assert item_id not in _in_workspace(kind, viewer)


@KINDS
@pytest.mark.parametrize("method", ["patch", "delete"])
def test_another_admin_gets_not_found_for_an_only_me_item(kind: Kind, method: str) -> None:
    item_id = _only_me(kind)
    body = {"json": {"name": "Taken"}} if method == "patch" else {}
    response = getattr(client, method)(f"{kind.path}/{item_id}", headers=headers(ADMIN_B), **body)
    assert response.status_code == 404, response.text
    assert kind.records(get_store())[item_id].name == kind.body["name"]


@KINDS
def test_the_owner_and_a_platform_owner_manage_an_only_me_item(kind: Kind) -> None:
    item_id = _only_me(kind)
    renamed = _patch(kind, item_id, ADMIN_A, name="Renamed")
    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["only_me"], renamed.json()["owner_user_id"]) == (True, ADMIN_A)
    assert _patch(kind, item_id, OWNER, description="Reviewed").status_code == 200
    deleted = client.delete(f"{kind.path}/{item_id}", headers=headers(OWNER))
    assert deleted.status_code == 200, deleted.text
    assert item_id not in kind.records(get_store())


@KINDS
def test_a_group_share_reaches_those_groups_and_stays_manageable_by_admins(kind: Kind) -> None:
    item_id = _created(kind, group_ids=[FINANCE])["id"]
    # ADMIN_A is in finance; ADMIN_B is not, but administrators manage shared items.
    assert item_id in _listed(kind, ADMIN_B)
    assert item_id in _in_workspace(kind, ADMIN_B)
    assert item_id in _in_workspace(kind, ADMIN_A)
    # A regular user outside the group does not get it.
    assert item_id not in _in_workspace(kind, LITIGATOR)
    assert item_id not in _in_workspace(kind, PENDING)


@KINDS
def test_people_in_a_shared_group_get_the_item(kind: Kind) -> None:
    item_id = _created(kind, group_ids=[LITIGATION])["id"]
    assert item_id in _in_workspace(kind, LITIGATOR)
    assert item_id not in _in_workspace(kind, PENDING)


@KINDS
def test_an_item_for_everyone_reaches_the_whole_workspace(kind: Kind) -> None:
    item_id = _created(kind)["id"]
    for viewer in (ADMIN_B, LITIGATOR, PENDING, OWNER):
        assert item_id in _in_workspace(kind, viewer)


# --- The rule itself ----------------------------------------------------------


def _item(kind: Kind, **overrides: object):
    values: dict[str, object] = {
        "id": "item-1",
        "tenant_id": "tenant-example",
        "name": "Item",
        "content": "Content",
        "owner_user_id": ADMIN_A,
    }
    values.update(overrides)
    return kind.model(**values)


@KINDS
def test_visibility_and_use_for_each_audience(kind: Kind) -> None:
    users = get_store().users
    only_me = _item(kind, only_me=True)
    for user_id, expected in ((ADMIN_A, True), (OWNER, True), (ADMIN_B, False), (LITIGATOR, False)):
        assert library_item_visible_to(users[user_id], only_me) is expected, user_id
        assert library_item_shared_with(users[user_id], only_me) is expected, user_id
    finance = _item(kind, group_ids=[FINANCE])
    # Shared with: the people who get it. Visible to: those, plus administrators.
    for user_id, shared, visible in (
        (ADMIN_A, True, True),
        (ADMIN_B, False, True),
        (LITIGATOR, False, False),
        (OWNER, True, True),
    ):
        assert library_item_shared_with(users[user_id], finance) is shared, user_id
        assert library_item_visible_to(users[user_id], finance) is visible, user_id
    everyone = _item(kind)
    for user_id in (ADMIN_B, LITIGATOR, PENDING):
        assert library_item_shared_with(users[user_id], everyone) is True, user_id
        assert library_item_visible_to(users[user_id], everyone) is True, user_id


@KINDS
def test_another_tenant_never_sees_an_item(kind: Kind) -> None:
    users = get_store().users
    for audience in ({}, {"only_me": True}, {"group_ids": [LITIGATION]}):
        elsewhere = _item(kind, tenant_id="tenant-other", **audience)
        for user_id in (ADMIN_A, LITIGATOR):
            assert library_item_visible_to(users[user_id], elsewhere) is False
            assert library_item_shared_with(users[user_id], elsewhere) is False
        assert library_item_visible_to(users[OWNER], elsewhere) is True


@KINDS
def test_an_only_me_item_with_no_owner_belongs_to_platform_owners(kind: Kind) -> None:
    users = get_store().users
    orphan = _item(kind, only_me=True, owner_user_id=None)
    assert library_item_visible_to(users[OWNER], orphan) is True
    assert library_item_visible_to(users[ADMIN_A], orphan) is False


@KINDS
def test_an_only_me_item_never_carries_groups(kind: Kind) -> None:
    with pytest.raises(ValidationError):
        _item(kind, only_me=True, group_ids=[LITIGATION])


# --- Using it in chat ---------------------------------------------------------


@KINDS
def test_only_the_owner_uses_an_only_me_item_in_chat(kind: Kind) -> None:
    item_id = _only_me(kind)
    store = get_store()
    for user_id in (ADMIN_A, OWNER):
        assert [item.id for item in kind.resolve(store, store.users[user_id], [item_id])] == [item_id]
    for user_id in (ADMIN_B, LITIGATOR):
        with pytest.raises(HTTPException) as refused:
            kind.resolve(store, store.users[user_id], [item_id])
        assert refused.value.status_code == 403
        assert "restricted" in refused.value.detail


@KINDS
def test_a_group_share_is_used_only_by_those_groups_in_chat(kind: Kind) -> None:
    item_id = _created(kind, group_ids=[FINANCE])["id"]
    store = get_store()
    assert [item.id for item in kind.resolve(store, store.users[ADMIN_A], [item_id])] == [item_id]
    with pytest.raises(HTTPException) as refused:
        kind.resolve(store, store.users[LITIGATOR], [item_id])
    assert refused.value.status_code == 403


# --- Changing the audience ----------------------------------------------------


@KINDS
def test_the_creator_makes_a_shared_item_only_me_and_its_groups_clear(kind: Kind) -> None:
    item_id = _created(kind, group_ids=[LITIGATION])["id"]
    private = _patch(kind, item_id, ADMIN_A, only_me=True)
    assert private.status_code == 200, private.text
    assert (private.json()["only_me"], private.json()["owner_user_id"], private.json()["group_ids"]) == (
        True,
        ADMIN_A,
        [],
    )
    assert item_id not in _listed(kind, ADMIN_B)
    assert item_id not in _in_workspace(kind, LITIGATOR)


@KINDS
def test_an_admin_cannot_take_someone_elses_item_private(kind: Kind) -> None:
    item_id = _created(kind)["id"]
    taken = _patch(kind, item_id, ADMIN_B, only_me=True)
    assert taken.status_code == 403, taken.text
    assert kind.noun in taken.json()["detail"]
    item = kind.records(get_store())[item_id]
    assert (item.only_me, item.owner_user_id) == (False, ADMIN_A)
    assert item_id in _listed(kind, ADMIN_A)


@KINDS
def test_another_admin_still_edits_and_reshares_a_shared_item(kind: Kind) -> None:
    item_id = _created(kind)["id"]
    reshared = _patch(kind, item_id, ADMIN_B, name="Team version", group_ids=[LITIGATION])
    assert reshared.status_code == 200, reshared.text
    body = reshared.json()
    assert (body["name"], body["group_ids"], body["only_me"], body["owner_user_id"]) == (
        "Team version",
        [LITIGATION],
        False,
        ADMIN_A,
    )


@KINDS
def test_an_item_with_no_known_creator_cannot_be_taken_private_by_an_admin(kind: Kind) -> None:
    item_id = _legacy(kind)
    assert _patch(kind, item_id, ADMIN_A, only_me=True).status_code == 403
    assert kind.records(get_store())[item_id].only_me is False


@KINDS
def test_a_platform_owner_makes_any_item_only_me_for_its_creator_or_itself(kind: Kind) -> None:
    created_id = _created(kind)["id"]
    for_creator = _patch(kind, created_id, OWNER, only_me=True)
    assert for_creator.status_code == 200, for_creator.text
    assert for_creator.json()["owner_user_id"] == ADMIN_A
    legacy_id = _legacy(kind)
    for_self = _patch(kind, legacy_id, OWNER, only_me=True)
    assert for_self.status_code == 200, for_self.text
    assert (for_self.json()["only_me"], for_self.json()["owner_user_id"]) == (True, OWNER)


@KINDS
def test_only_me_and_groups_conflict_on_update(kind: Kind) -> None:
    item_id = _only_me(kind)
    assert _patch(kind, item_id, ADMIN_A, group_ids=[LITIGATION]).status_code == 400
    shared_id = _created(kind)["id"]
    assert _patch(kind, shared_id, ADMIN_A, only_me=True, group_ids=[LITIGATION]).status_code == 400
    assert kind.records(get_store())[shared_id].only_me is False


@KINDS
def test_turning_only_me_off_shares_with_everyone_or_the_chosen_groups(kind: Kind) -> None:
    item_id = _only_me(kind)
    opened = _patch(kind, item_id, ADMIN_A, only_me=False)
    assert opened.status_code == 200, opened.text
    assert (opened.json()["only_me"], opened.json()["group_ids"], opened.json()["owner_user_id"]) == (
        False,
        [],
        ADMIN_A,
    )
    assert item_id in _in_workspace(kind, PENDING)
    private_again = _patch(kind, item_id, ADMIN_A, only_me=True)
    assert private_again.status_code == 200, private_again.text
    to_groups = _patch(kind, item_id, ADMIN_A, only_me=False, group_ids=[FINANCE])
    assert to_groups.status_code == 200, to_groups.text
    assert (to_groups.json()["only_me"], to_groups.json()["group_ids"]) == (False, [FINANCE])
    assert item_id not in _in_workspace(kind, LITIGATOR)


@KINDS
def test_an_edit_that_leaves_the_audience_alone_keeps_it(kind: Kind) -> None:
    item_id = _created(kind, group_ids=[FINANCE])["id"]
    edited = _patch(kind, item_id, ADMIN_A, description="Month end")
    assert edited.status_code == 200, edited.text
    assert (edited.json()["only_me"], edited.json()["group_ids"]) == (False, [FINANCE])


# --- Agents -------------------------------------------------------------------


def _profile_body(kind: Kind, item_ids: list[str]) -> dict[str, object]:
    model = next(m for m in get_store().models.values() if m.platform_enabled and m.upstream_model_id)
    return {
        "name": "Shared agent",
        "provider_id": model.provider_id,
        "upstream_model_id": model.upstream_model_id,
        "system_prompt": "Be helpful.",
        "is_custom": True,
        kind.profile_field: item_ids,
    }


@KINDS
def test_another_admin_cannot_attach_an_only_me_item_to_an_agent(kind: Kind) -> None:
    item_id = _only_me(kind)
    body = _profile_body(kind, [item_id])
    borrowed = client.post("/api/admin/agent-profiles", headers=headers(ADMIN_B), json=body)
    assert borrowed.status_code == 404, borrowed.text
    own = client.post("/api/admin/agent-profiles", headers=headers(ADMIN_A), json=body)
    assert own.status_code == 201, own.text


@KINDS
def test_another_admin_saves_an_agent_that_already_carries_an_only_me_item(kind: Kind) -> None:
    item_id = _only_me(kind)
    profile = client.post(
        "/api/admin/agent-profiles", headers=headers(ADMIN_A), json=_profile_body(kind, [item_id])
    )
    assert profile.status_code == 201, profile.text
    profile_id = profile.json()["id"]
    path = f"/api/admin/agent-profiles/{profile_id}"
    # The editor sends back the ids it was given, including the one it cannot see.
    kept = client.patch(path, headers=headers(ADMIN_B), json={kind.profile_field: [item_id]})
    assert kept.status_code == 200, kept.text
    assert kept.json()[kind.profile_field] == [item_id]
    # Unticking the "Unavailable item" detaches it.
    removed = client.patch(path, headers=headers(ADMIN_B), json={kind.profile_field: []})
    assert removed.status_code == 200, removed.text
    assert removed.json()[kind.profile_field] == []
    # Once detached it cannot be attached again by someone who cannot see it.
    again = client.patch(path, headers=headers(ADMIN_B), json={kind.profile_field: [item_id]})
    assert again.status_code == 404, again.text


@KINDS
def test_an_admin_still_attaches_what_they_can_see(kind: Kind) -> None:
    store = get_store()
    knowledge_id = next(
        config.id for config in store.knowledge_configs.values() if config.tenant_id == "tenant-example"
    )
    shared_id = _created(kind)["id"]
    body = {**_profile_body(kind, [shared_id]), "knowledge_config_ids": [knowledge_id]}
    created = client.post("/api/admin/agent-profiles", headers=headers(ADMIN_B), json=body)
    assert created.status_code == 201, created.text
    assert created.json()[kind.profile_field] == [shared_id]


# --- Audit trail --------------------------------------------------------------


def _audit_targets(user_id: str) -> set[str]:
    response = client.get("/api/admin/audit-events", headers=headers(user_id))
    assert response.status_code == 200, response.text
    return {event["target"] for event in response.json()}


@KINDS
def test_other_admins_do_not_see_audit_events_for_an_only_me_item(kind: Kind) -> None:
    item_id = _only_me(kind)
    _patch(kind, item_id, ADMIN_A, name="Renamed")
    shared_id = _created(kind)["id"]
    assert item_id not in _audit_targets(ADMIN_B)
    assert shared_id in _audit_targets(ADMIN_B)
    assert item_id in _audit_targets(ADMIN_A)
    assert item_id in _audit_targets(OWNER)


@KINDS
def test_making_an_item_only_me_hides_its_earlier_events_too(kind: Kind) -> None:
    item_id = _created(kind)["id"]
    assert item_id in _audit_targets(ADMIN_B)
    assert _patch(kind, item_id, ADMIN_A, only_me=True).status_code == 200
    # The event from when it was shared names an item that is now private.
    assert item_id not in _audit_targets(ADMIN_B)
    assert item_id in _audit_targets(ADMIN_A)


@KINDS
def test_a_deleted_only_me_item_stays_out_of_other_admins_audit_trail(kind: Kind) -> None:
    item_id = _only_me(kind)
    deleted = client.delete(f"{kind.path}/{item_id}", headers=headers(ADMIN_A))
    assert deleted.status_code == 200, deleted.text
    assert item_id not in _audit_targets(ADMIN_B)
    assert item_id in _audit_targets(ADMIN_A)
    assert item_id in _audit_targets(OWNER)


@KINDS
def test_the_audit_trail_records_who_an_item_was_shared_with(kind: Kind) -> None:
    item_id = _only_me(kind)
    response = client.get("/api/admin/audit-events", headers=headers(ADMIN_A))
    event = next(event for event in response.json() if event["target"] == item_id)
    assert event["metadata"]["only_me"] is True
    assert event["metadata"]["owner_user_id"] == ADMIN_A


# --- Deleted accounts ---------------------------------------------------------


@KINDS
def test_a_deleted_owner_leaves_the_item_off_and_to_platform_owners_only(kind: Kind) -> None:
    item_id = _only_me(kind)
    shared_id = _created(kind)["id"]
    store = get_store()
    former = store.users[ADMIN_A].model_copy()
    deleted = client.delete(f"/api/admin/users/{ADMIN_A}", headers=headers(OWNER))
    assert deleted.status_code == 200, deleted.text
    orphan = kind.records(store)[item_id]
    assert (orphan.only_me, orphan.owner_user_id, orphan.enabled) == (True, None, False)
    shared = kind.records(store)[shared_id]
    assert (shared.owner_user_id, shared.enabled) == (None, True)
    assert item_id in _listed(kind, OWNER)
    assert item_id not in _listed(kind, ADMIN_B)
    # A later account that reuses the id inherits nothing.
    store.users[ADMIN_A] = former
    assert item_id not in _listed(kind, ADMIN_A)
    assert _patch(kind, shared_id, ADMIN_A, only_me=True).status_code == 403


@KINDS
def test_deleting_someone_else_leaves_an_only_me_item_alone(kind: Kind) -> None:
    item_id = _only_me(kind)
    deleted = client.delete(f"/api/admin/users/{LITIGATOR}", headers=headers(OWNER))
    assert deleted.status_code == 200, deleted.text
    item = kind.records(get_store())[item_id]
    assert (item.owner_user_id, item.enabled) == (ADMIN_A, True)


# --- Stored data --------------------------------------------------------------


@KINDS
def test_rows_saved_before_sharing_load_as_shared_with_no_owner(kind: Kind) -> None:
    from app.repositories.identity_config_sql import _model_from_payload

    legacy_payload = _item(kind, group_ids=[LITIGATION]).model_dump(mode="json")
    del legacy_payload["only_me"]
    del legacy_payload["owner_user_id"]
    loaded = _model_from_payload(kind.model, legacy_payload, kind.collection)
    assert isinstance(loaded, kind.model)
    assert (loaded.only_me, loaded.owner_user_id, loaded.group_ids) == (False, None, [LITIGATION])


@KINDS
def test_only_me_round_trips_through_stored_payloads(kind: Kind) -> None:
    from app.repositories.identity_config_sql import _model_from_payload

    item_id = _only_me(kind)
    stored = kind.records(get_store())[item_id].model_dump(mode="json")
    reloaded = _model_from_payload(kind.model, stored, kind.collection)
    assert (reloaded.only_me, reloaded.owner_user_id) == (True, ADMIN_A)


def test_a_regular_user_still_cannot_write_to_the_library() -> None:
    for kind in (PROMPT, SKILL):
        assert _create(kind, LITIGATOR, only_me=True).status_code == 403
    assert get_store().users[LITIGATOR].role == Role.USER
