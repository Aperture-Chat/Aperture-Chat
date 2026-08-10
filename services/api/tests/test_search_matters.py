from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db import (
    Base,
    DraftDocumentRow,
    DraftRevisionRow,
    MatterDeletionJobRow,
    MatterMembershipRow,
    MatterRow,
    create_application_engine,
)
from app.models.schemas import Role, Tenant, User
from app.repositories.deps import get_store
from app.repositories.matters import (
    MatterDraftRepository,
    MatterPersistenceUnavailable,
)
from app.repositories.review_deps import get_review_store
from app.routes.dependencies import current_user
from app.routes.matters import get_matter_draft_repository
from app.routes.search import router


class SearchDirectory:
    def __init__(self) -> None:
        self.tenants = {
            "tenant-a": Tenant(id="tenant-a", name="Tenant A", slug="tenant-a"),
            "tenant-b": Tenant(id="tenant-b", name="Tenant B", slug="tenant-b"),
        }
        self.groups = {}
        self.knowledge_configs = {}
        self.models = {}
        self.automations = {}

    def tenant_by_slug(self, slug: str) -> Tenant | None:
        return next(
            (tenant for tenant in self.tenants.values() if tenant.slug == slug),
            None,
        )

    def chat_threads_for(self, _actor: User) -> list[object]:
        return []


class EmptyReviewStore:
    def list_matrices(self, *, owner_user_id: str) -> list[object]:
        del owner_user_id
        return []


def _user(
    user_id: str,
    *,
    tenant_id: str | None = "tenant-a",
    role: Role = Role.USER,
) -> User:
    return User(
        id=user_id,
        tenant_id=tenant_id,
        email=f"{user_id}@example.test",
        display_name=user_id,
        role=role,
    )


@pytest.fixture
def matter_search_api(tmp_path: Path):
    engine = create_application_engine(f"sqlite:///{tmp_path / 'matter-search.sqlite3'}")
    Base.metadata.create_all(
        engine,
        tables=[
            MatterRow.__table__,
            MatterMembershipRow.__table__,
            MatterDeletionJobRow.__table__,
            DraftDocumentRow.__table__,
            DraftRevisionRow.__table__,
        ],
    )
    repository = MatterDraftRepository(engine)
    directory = SearchDirectory()
    actor = {"value": _user("user-one")}
    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[current_user] = lambda: actor["value"]
    application.dependency_overrides[get_store] = lambda: directory
    application.dependency_overrides[get_review_store] = lambda: EmptyReviewStore()
    application.dependency_overrides[get_matter_draft_repository] = lambda: repository
    client = TestClient(application)
    try:
        yield client, actor, repository
    finally:
        client.close()
        application.dependency_overrides.clear()
        engine.dispose()


def _section(body: dict[str, object], kind: str) -> list[dict[str, object]]:
    sections = body["sections"]
    assert isinstance(sections, list)
    section = next(item for item in sections if item["kind"] == kind)
    return section["results"]


def test_search_matters_and_drafts_keeps_membership_owner_and_tenant_boundaries(
    matter_search_api,
) -> None:
    client, actor, repository = matter_search_api
    repository.create_matter(
        tenant_id="tenant-a",
        name="Saffron shared matter",
        creator_user_id="user-one",
        member_user_ids=["user-two"],
        matter_id="matter-shared",
    )
    repository.create_matter(
        tenant_id="tenant-a",
        name="Saffron one-only matter",
        creator_user_id="user-one",
        matter_id="matter-one-only",
    )
    repository.create_matter(
        tenant_id="tenant-b",
        name="Saffron cross-tenant matter",
        creator_user_id="user-one",
        matter_id="matter-cross-tenant",
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-shared",
        draft_id="draft-one-shared",
        title="Saffron owner-one draft",
        content="<p>Saffron alpha-confidential owner-one text.</p>",
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-two",
        matter_id="matter-shared",
        draft_id="draft-two-shared",
        title="Saffron owner-two draft",
        content="<p>Saffron beta-confidential owner-two text.</p>",
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        draft_id="draft-one-unbound",
        title="Saffron unbound owner-one draft",
        content="<p>Saffron unbound owner-one text.</p>",
    )
    repository.create_draft(
        tenant_id="tenant-b",
        owner_user_id="user-one",
        matter_id="matter-cross-tenant",
        draft_id="draft-cross-tenant",
        title="Saffron cross-tenant draft",
        content="<p>Saffron cross-tenant confidential text.</p>",
    )

    owner_one = client.get("/api/search", params={"q": "saffron"})
    assert owner_one.status_code == 200
    assert {item["id"] for item in _section(owner_one.json(), "matter")} == {
        "matter-shared",
        "matter-one-only",
    }
    owner_one_drafts = _section(owner_one.json(), "draft")
    assert {item["id"] for item in owner_one_drafts} == {
        "draft-one-shared",
        "draft-one-unbound",
    }
    assert owner_one_drafts[0]["metadata"].keys() == {
        "matter_id",
        "current_revision",
        "updated_at",
    }
    assert "content" not in owner_one_drafts[0]["metadata"]
    assert "content_sha256" not in owner_one.text
    assert "sanitizer_version" not in owner_one.text

    actor["value"] = _user("user-two")
    owner_two = client.get("/api/search", params={"q": "saffron"})
    assert owner_two.status_code == 200
    assert [item["id"] for item in _section(owner_two.json(), "matter")] == ["matter-shared"]
    assert [item["id"] for item in _section(owner_two.json(), "draft")] == ["draft-two-shared"]
    serialized = json.dumps(owner_two.json())
    assert "draft-one-shared" not in serialized
    assert "alpha-confidential" not in serialized
    assert "matter-one-only" not in serialized
    assert "matter-cross-tenant" not in serialized

    actor["value"] = _user("user-three")
    nonmember = client.get("/api/search", params={"q": "saffron"})
    assert nonmember.status_code == 200
    assert _section(nonmember.json(), "matter") == []
    assert _section(nonmember.json(), "draft") == []

    actor["value"] = _user("tenant-admin", role=Role.TENANT_ADMIN)
    role_only_admin = client.get("/api/search", params={"q": "saffron"})
    assert role_only_admin.status_code == 200
    assert _section(role_only_admin.json(), "matter") == []
    assert _section(role_only_admin.json(), "draft") == []


def test_removed_member_cannot_search_creator_attribution_or_linked_private_draft(
    matter_search_api,
) -> None:
    client, actor, repository = matter_search_api
    repository.create_matter(
        tenant_id="tenant-a",
        name="Violet revoked creator matter",
        creator_user_id="user-one",
        member_user_ids=["user-two"],
        matter_id="matter-revoked",
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-revoked",
        draft_id="draft-revoked-linked",
        title="Violet linked draft",
        content="<p>revoked-secret must disappear with membership.</p>",
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        draft_id="draft-still-private",
        title="Violet unbound draft",
        content="<p>Violet unbound work remains owner searchable.</p>",
    )
    repository.remove_member(
        "matter-revoked",
        tenant_id="tenant-a",
        actor_user_id="user-two",
        member_user_id="user-one",
        expected_version=1,
    )

    revoked = client.get("/api/search", params={"q": "revoked-secret"})
    assert revoked.status_code == 200
    assert _section(revoked.json(), "matter") == []
    assert _section(revoked.json(), "draft") == []
    assert "draft-revoked-linked" not in revoked.text

    unbound = client.get("/api/search", params={"q": "violet"})
    assert [item["id"] for item in _section(unbound.json(), "draft")] == ["draft-still-private"]
    assert _section(unbound.json(), "matter") == []


def test_platform_owner_requires_explicit_tenant_and_gets_no_membership_bypass(
    matter_search_api,
) -> None:
    client, actor, repository = matter_search_api
    actor["value"] = _user(
        "platform-owner",
        tenant_id=None,
        role=Role.PLATFORM_OWNER,
    )
    repository.create_matter(
        tenant_id="tenant-a",
        name="Topaz hidden from role-only owner",
        creator_user_id="user-one",
        matter_id="matter-owner-hidden",
    )
    repository.create_matter(
        tenant_id="tenant-a",
        name="Topaz explicit owner membership",
        creator_user_id="user-one",
        member_user_ids=["platform-owner"],
        matter_id="matter-owner-member",
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-owner-member",
        draft_id="draft-other-owner",
        title="Topaz other-owner draft",
        content="<p>topaz-other-owner-secret</p>",
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="platform-owner",
        matter_id="matter-owner-member",
        draft_id="draft-platform-owner",
        title="Topaz platform-owner draft",
        content="<p>Topaz personally owned work.</p>",
    )

    missing_scope = client.get("/api/search", params={"q": "topaz"})
    assert missing_scope.status_code == 400
    unknown_scope = client.get(
        "/api/search",
        params={"q": "topaz"},
        headers={"X-Aperture-Tenant": "missing"},
    )
    assert unknown_scope.status_code == 404
    scoped = client.get(
        "/api/search",
        params={"q": "topaz"},
        headers={"X-Aperture-Tenant": "tenant-a"},
    )
    assert scoped.status_code == 200
    assert [item["id"] for item in _section(scoped.json(), "matter")] == ["matter-owner-member"]
    assert [item["id"] for item in _section(scoped.json(), "draft")] == ["draft-platform-owner"]
    serialized = json.dumps(scoped.json())
    assert "matter-owner-hidden" not in serialized
    assert "draft-other-owner" not in serialized
    assert "topaz-other-owner-secret" not in serialized


def test_matter_search_persistence_failure_is_generic_and_returns_no_partial_results(
    matter_search_api,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _actor, repository = matter_search_api

    def unavailable(**_kwargs):
        raise MatterPersistenceUnavailable("sensitive sqlite path and query")

    monkeypatch.setattr(repository, "list_matters", unavailable)
    response = client.get("/api/search", params={"q": "saffron"})

    assert response.status_code == 503
    assert response.json() == {"detail": "Matter and draft search is temporarily unavailable."}
    assert "sensitive sqlite path" not in response.text
