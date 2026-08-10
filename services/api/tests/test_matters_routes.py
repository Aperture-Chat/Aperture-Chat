from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import (
    DraftDocumentRow,
    DraftRevisionRow,
    create_application_engine,
    create_session_factory,
    session_scope,
    upgrade_database,
)
from app.models.matters import (
    DRAFT_SANITIZER_VERSION,
    MAX_DRAFT_CONTENT_BYTES,
    draft_content_sha256,
)
from app.models.schemas import (
    ChatFolder,
    ChatThread,
    KnowledgeConfig,
    Role,
    Tenant,
    User,
)
from app.repositories.application_state import ApplicationStateRepository
from app.repositories.deps import get_store
from app.repositories.matters import MatterDraftRepository, MatterPersistenceUnavailable
from app.routes.dependencies import current_user
from app.routes.matters import (
    ReviewMatterService,
    get_matter_draft_repository,
    get_review_matter_service,
    router,
)


BASE_TIME = datetime(2026, 7, 20, 18, tzinfo=UTC)


class RouteDirectory:
    def __init__(self) -> None:
        self.tenants = {
            "tenant-a": Tenant(id="tenant-a", name="Tenant A", slug="tenant-a"),
            "tenant-b": Tenant(id="tenant-b", name="Tenant B", slug="tenant-b"),
        }
        self.users = {
            "user-one": _user("user-one"),
            "user-two": _user("user-two"),
            "user-three": _user("user-three"),
            "tenant-admin": _user("tenant-admin", role=Role.TENANT_ADMIN),
            "outside-admin": _user("outside-admin", role=Role.TENANT_ADMIN),
            "inactive-user": _user("inactive-user").model_copy(update={"active": False}),
            "tenant-b-user": _user("tenant-b-user", tenant_id="tenant-b"),
            "platform-owner": _user(
                "platform-owner",
                role=Role.PLATFORM_OWNER,
                tenant_id=None,
            ),
        }
        self.knowledge_configs: dict[str, object] = {}
        self.cleared_knowledge_matters: list[str] = []
        self.remaining_reference_count = 0
        self.audit_actions: list[tuple[str, str, str]] = []

    def tenant_by_slug(self, slug: str) -> Tenant | None:
        return next(
            (tenant for tenant in self.tenants.values() if tenant.slug == slug),
            None,
        )

    # The real SeedStore nulls identity-owned references during deletion; the
    # route fake records the calls so tests can assert stage work happened.
    def clear_matter_knowledge_references(self, matter_id: str) -> int:
        self.cleared_knowledge_matters.append(matter_id)
        return 0

    def count_matter_references(self, matter_id: str) -> int:
        return self.remaining_reference_count

    def record_audit(self, actor: User, action: str, target: str, detail=None, **_kwargs):
        self.audit_actions.append((actor.id, action, target))


def _user(user_id: str, *, role: Role = Role.USER, tenant_id: str | None = "tenant-a") -> User:
    return User(
        id=user_id,
        tenant_id=tenant_id,
        email=f"{user_id}@example.test",
        display_name=user_id,
        role=role,
    )


def _thread(thread_id: str, *, owner_user_id: str) -> ChatThread:
    return ChatThread(
        id=thread_id,
        tenant_id="tenant-a",
        owner_user_id=owner_user_id,
        title=f"Thread {thread_id}",
        model_id="model-one",
        group_id="",
        updated_at="Just now",
        messages=[],
    )


def _folder(folder_id: str, *, owner_user_id: str) -> ChatFolder:
    return ChatFolder(
        id=folder_id,
        tenant_id="tenant-a",
        owner_user_id=owner_user_id,
        name=f"Folder {folder_id}",
        created_at=BASE_TIME.isoformat(),
    )


@pytest.fixture
def matters_api(tmp_path: Path):
    engine = create_application_engine(f"sqlite:///{tmp_path / 'matters-routes.sqlite3'}")
    upgrade_database(engine)
    repository = MatterDraftRepository(engine)
    application = ApplicationStateRepository(engine)
    actor = {"value": _user("user-one")}
    directory = RouteDirectory()
    route_app = FastAPI()
    route_app.include_router(router)
    cleared_review_matters: list[str] = []
    review_service = ReviewMatterService(
        get_matrix=lambda matrix_id: None,
        set_matter=lambda *args, **kwargs: None,
        clear_references=lambda matter_id: cleared_review_matters.append(matter_id) or 0,
    )
    directory.cleared_review_matters = cleared_review_matters
    route_app.dependency_overrides[current_user] = lambda: actor["value"]
    route_app.dependency_overrides[get_store] = lambda: directory
    route_app.dependency_overrides[get_matter_draft_repository] = lambda: repository
    route_app.dependency_overrides[get_review_matter_service] = lambda: review_service
    client = TestClient(route_app)
    try:
        yield client, actor, repository, application, engine, route_app, directory
    finally:
        client.close()
        route_app.dependency_overrides.clear()
        engine.dispose()


def test_matter_crud_tenant_scope_and_membership_management_roles(matters_api) -> None:
    client, actor, repository, _application, _engine, _route_app, _directory = matters_api
    user_one = _user("user-one")
    tenant_admin = _user("tenant-admin", role=Role.TENANT_ADMIN)
    outside_admin = _user("outside-admin", role=Role.TENANT_ADMIN)
    platform_owner = _user("platform-owner", role=Role.PLATFORM_OWNER, tenant_id=None)

    actor["value"] = user_one
    forbidden_create = client.post(
        "/api/matters",
        json={"name": "User managed", "member_user_ids": ["user-two"]},
    )
    assert forbidden_create.status_code == 403
    personal = client.post("/api/matters", json={"name": "  Personal   matter  "})
    assert personal.status_code == 201
    personal_id = personal.json()["id"]
    assert personal.json()["name"] == "Personal matter"
    creator_update = client.put(
        f"/api/matters/{personal_id}",
        json={"expected_version": 1, "name": "Creator managed matter"},
    )
    assert creator_update.status_code == 200
    assert creator_update.json()["version"] == 2

    ordinary_member_add = client.put(
        f"/api/matters/{personal_id}/members/tenant-admin",
        json={"expected_version": 2},
    )
    assert ordinary_member_add.status_code == 403
    actor["value"] = outside_admin
    nonmember_admin_add = client.put(
        f"/api/matters/{personal_id}/members/user-two",
        json={"expected_version": 1},
    )
    assert nonmember_admin_add.status_code == 403

    actor["value"] = tenant_admin
    created = client.post(
        "/api/matters",
        json={
            "name": "Managed matter",
            "member_user_ids": ["user-one"],
            "retention_days": 30,
        },
    )
    assert created.status_code == 201
    matter_id = created.json()["id"]
    assert created.json()["version"] == 1
    assert created.json()["retention_days"] == 30

    added = client.put(
        f"/api/matters/{matter_id}/members/user-two",
        json={"expected_version": 1},
    )
    assert added.status_code == 200
    assert added.json()["version"] == 2

    actor["value"] = user_one
    ordinary_add = client.put(
        f"/api/matters/{matter_id}/members/user-three",
        json={"expected_version": 2},
    )
    assert ordinary_add.status_code == 403
    cross_tenant_query = client.get(
        f"/api/matters/{matter_id}",
        headers={"X-Aperture-Tenant": "tenant-b"},
    )
    assert cross_tenant_query.status_code == 403

    actor["value"] = platform_owner
    assert client.get(f"/api/matters/{matter_id}").status_code == 400
    assert (
        client.get(
            f"/api/matters/{matter_id}",
            headers={"X-Aperture-Tenant": "missing"},
        ).status_code
        == 404
    )
    owner_without_membership = client.get(
        f"/api/matters/{matter_id}",
        headers={"X-Aperture-Tenant": "tenant-a"},
    )
    assert owner_without_membership.status_code == 403
    owner_created = client.post(
        "/api/matters",
        headers={"X-Aperture-Tenant": "tenant-a"},
        json={"name": "Owner-created matter"},
    )
    assert owner_created.status_code == 201
    owner_matter_id = owner_created.json()["id"]
    owner_update = client.put(
        f"/api/matters/{owner_matter_id}",
        headers={"X-Aperture-Tenant": "tenant-a"},
        json={"expected_version": 1, "name": "Owner scoped"},
    )
    assert owner_update.status_code == 200
    assert owner_update.json()["version"] == 2
    owner_add = client.put(
        f"/api/matters/{owner_matter_id}/members/user-three",
        headers={"X-Aperture-Tenant": "tenant-a"},
        json={"expected_version": 2},
    )
    assert owner_add.status_code == 200
    assert owner_add.json()["version"] == 3

    actor["value"] = tenant_admin
    for invalid_target in (
        "tenant-b-user",
        "inactive-user",
        "missing-user",
        "platform-owner",
    ):
        rejected = client.put(
            f"/api/matters/{matter_id}/members/{invalid_target}",
            json={"expected_version": 2},
        )
        assert rejected.status_code == 404
    rejected_create = client.post(
        "/api/matters",
        json={"name": "Invalid members", "member_user_ids": ["tenant-b-user"]},
    )
    assert rejected_create.status_code == 404

    actor["value"] = user_one
    ordinary_member_update = client.put(
        f"/api/matters/{matter_id}",
        json={"expected_version": 2, "retention_days": None},
    )
    assert ordinary_member_update.status_code == 403
    ordinary_member_delete = client.delete(
        f"/api/matters/{matter_id}",
        params={"expected_version": 2},
    )
    assert ordinary_member_delete.status_code == 403
    assert (
        repository.get_matter_deletion_job(
            matter_id,
            tenant_id="tenant-a",
            actor_user_id="tenant-admin",
        )
        is None
    )

    actor["value"] = tenant_admin
    cleared_retention = client.put(
        f"/api/matters/{matter_id}",
        json={"expected_version": 2, "retention_days": None},
    )
    assert cleared_retention.status_code == 200
    assert cleared_retention.json()["retention_days"] is None
    assert cleared_retention.json()["version"] == 3
    assert (
        client.put(
            f"/api/matters/{matter_id}",
            json={"expected_version": 3},
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"/api/matters/{matter_id}",
            json={"expected_version": 2, "name": "Stale"},
        ).status_code
        == 409
    )

    actor["value"] = user_one
    memberships = client.get(f"/api/matters/{matter_id}/members")
    assert memberships.status_code == 200
    assert {item["member_user_id"] for item in memberships.json()} == {
        "tenant-admin",
        "user-one",
        "user-two",
    }
    assert (
        client.delete(
            f"/api/matters/{matter_id}/members/user-two",
            params={"expected_version": 3},
        ).status_code
        == 403
    )
    actor["value"] = tenant_admin
    removed = client.delete(
        f"/api/matters/{matter_id}/members/user-two",
        params={"expected_version": 3},
    )
    assert removed.status_code == 200
    assert removed.json()["version"] == 4

    actor["value"] = _user("tenant-b-user", tenant_id="tenant-b")
    assert client.get(f"/api/matters/{matter_id}").status_code == 404
    assert client.get("/api/matters").json() == []


def test_platform_owner_scope_never_falls_back_to_the_only_tenant(matters_api) -> None:
    client, actor, _repository, _application, _engine, _route_app, directory = matters_api
    directory.tenants.pop("tenant-b")
    actor["value"] = _user(
        "platform-owner",
        role=Role.PLATFORM_OWNER,
        tenant_id=None,
    )

    assert client.get("/api/matters").status_code == 400
    assert (
        client.get(
            "/api/matters",
            headers={"X-Aperture-Tenant": "missing"},
        ).status_code
        == 404
    )
    created = client.post(
        "/api/matters",
        headers={"X-Aperture-Tenant": "tenant-a"},
        json={"name": "Explicit owner scope"},
    )
    assert created.status_code == 201
    listed = client.get(
        "/api/matters",
        headers={"X-Aperture-Tenant": "tenant-a"},
    )
    assert [matter["id"] for matter in listed.json()] == [created.json()["id"]]

    actor["value"] = _user("unknown-tenant-user", tenant_id="missing-tenant")
    assert client.get("/api/matters").status_code == 404


def test_explicit_member_administrators_can_manage_without_role_bypass(matters_api) -> None:
    client, actor, repository, _application, _engine, _route_app, _directory = matters_api
    repository.create_matter(
        tenant_id="tenant-a",
        name="Admin-managed",
        creator_user_id="user-one",
        member_user_ids=["tenant-admin", "user-two"],
        matter_id="matter-admin-managed",
    )

    actor["value"] = _user("tenant-admin", role=Role.TENANT_ADMIN)
    updated = client.put(
        "/api/matters/matter-admin-managed",
        json={"expected_version": 1, "name": "Explicit admin managed"},
    )
    assert updated.status_code == 200
    started = client.delete(
        "/api/matters/matter-admin-managed",
        params={"expected_version": 2},
    )
    # Every external nulling stage now runs in the same request, so a healthy
    # deletion completes in one pass instead of parking at 202.
    assert started.status_code == 200
    assert started.json()["job"]["status"] == "complete"
    assert started.json()["job"]["application_refs_cleared_at"] is not None
    assert started.json()["job"]["review_refs_cleared_at"] is not None

    repository.create_matter(
        tenant_id="tenant-a",
        name="Owner-managed",
        creator_user_id="user-one",
        member_user_ids=["platform-owner"],
        matter_id="matter-owner-managed",
    )
    actor["value"] = _user(
        "platform-owner",
        role=Role.PLATFORM_OWNER,
        tenant_id=None,
    )
    owner_update = client.put(
        "/api/matters/matter-owner-managed",
        headers={"X-Aperture-Tenant": "tenant-a"},
        json={"expected_version": 1, "name": "Explicit owner managed"},
    )
    assert owner_update.status_code == 200

    actor["value"] = _user("outside-admin", role=Role.TENANT_ADMIN)
    outside = client.put(
        "/api/matters/matter-owner-managed",
        json={"expected_version": 2, "name": "Role-only bypass"},
    )
    assert outside.status_code == 403


def test_private_draft_routes_are_sanitized_bounded_metadata_only_and_cas_guarded(
    matters_api,
) -> None:
    client, actor, repository, _application, engine, _route_app, _directory = matters_api
    repository.create_matter(
        tenant_id="tenant-a",
        name="Draft matter",
        creator_user_id="user-one",
        member_user_ids=["user-two"],
        matter_id="matter-drafts",
        now=BASE_TIME,
    )
    actor["value"] = _user("user-one")
    created = client.post(
        "/api/drafts",
        json={
            "title": "  Route   draft ",
            "content": (
                '<script>steal()</script><p onclick="steal()">needle '
                '<a href="javascript:steal()">safe</a></p>'
            ),
            "matter_id": "matter-drafts",
        },
    )
    assert created.status_code == 201
    assert created.json()["document"]["current_revision"] == 1
    assert created.json()["document"]["title"] == "Route draft"
    assert created.json()["revision"]["content"] == "<p>needle <a>safe</a></p>"
    draft_id = created.json()["document"]["id"]
    assert draft_id.startswith("draft-")

    listing = client.get("/api/drafts")
    assert listing.status_code == 200
    assert listing.json() == [created.json()["document"]]
    assert "content" not in listing.text
    assert "revision" not in listing.json()[0]
    detail = client.get(f"/api/drafts/{draft_id}")
    assert detail.status_code == 200
    assert detail.json() == created.json()

    actor["value"] = _user("user-two")
    assert client.get(f"/api/drafts/{draft_id}").status_code == 404
    assert (
        client.put(
            f"/api/drafts/{draft_id}",
            json={"expected_revision": 1, "content": "<p>Probe</p>"},
        ).status_code
        == 404
    )
    caller_selected = client.post(
        "/api/drafts",
        json={
            "id": draft_id,
            "title": "Caller-selected id",
            "content": "<p>Not accepted</p>",
        },
    )
    assert caller_selected.status_code == 422
    update_only = client.put(
        "/api/drafts/caller-chosen-id",
        json={"title": "Cannot create", "content": "<p>Cannot create through PUT</p>"},
    )
    assert update_only.status_code == 422
    assert client.get("/api/drafts/caller-chosen-id").status_code == 404
    second_owner_draft = client.post(
        "/api/drafts",
        json={"title": "Owner two", "content": "<p>Private owner two work</p>"},
    )
    assert second_owner_draft.status_code == 201
    assert second_owner_draft.json()["document"]["id"] != draft_id
    assert client.get("/api/drafts", params={"matter_id": "matter-drafts"}).json() == []
    actor["value"] = _user(
        "platform-owner",
        role=Role.PLATFORM_OWNER,
        tenant_id=None,
    )
    assert (
        client.get(
            f"/api/drafts/{draft_id}",
            headers={"X-Aperture-Tenant": "tenant-a"},
        ).status_code
        == 404
    )
    actor["value"] = _user("user-three")
    assert (
        client.post(
            "/api/drafts",
            json={
                "title": "Denied",
                "content": "<p>Denied</p>",
                "matter_id": "matter-drafts",
            },
        ).status_code
        == 403
    )

    actor["value"] = _user("user-one")
    updated = client.put(
        f"/api/drafts/{draft_id}",
        json={"expected_revision": 1, "content": "<p>Revision two</p>"},
    )
    assert updated.status_code == 200
    assert updated.json()["document"]["current_revision"] == 2
    assert updated.json()["document"]["matter_id"] == "matter-drafts"
    unlinked = client.put(
        f"/api/drafts/{draft_id}",
        json={"expected_revision": 2, "matter_id": None},
    )
    assert unlinked.status_code == 200
    assert unlinked.json()["document"]["current_revision"] == 3
    assert unlinked.json()["document"]["matter_id"] is None
    assert (
        client.put(
            f"/api/drafts/{draft_id}",
            json={"expected_revision": 2, "content": "<p>Stale</p>"},
        ).status_code
        == 409
    )
    assert (
        client.put(
            f"/api/drafts/{draft_id}",
            json={"expected_revision": 3, "content": None, "title": "No null content"},
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"/api/drafts/{draft_id}",
            json={"expected_revision": 3},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/drafts",
            json={"title": "Missing"},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/drafts",
            json={"title": "Oversized", "content": "a" * (MAX_DRAFT_CONTENT_BYTES + 1)},
        ).status_code
        == 413
    )

    factory = create_session_factory(engine)
    revision_200_content = "<p>Revision 200</p>"
    with session_scope(factory) as session:
        document = session.get(DraftDocumentRow, draft_id)
        assert document is not None
        document.current_revision = 200
        revision_200_at = document.updated_at
        session.add(
            DraftRevisionRow(
                draft_id=draft_id,
                revision=200,
                tenant_id="tenant-a",
                owner_user_id="user-one",
                title=document.title,
                content=revision_200_content,
                content_sha256=draft_content_sha256(revision_200_content),
                sanitizer_version=DRAFT_SANITIZER_VERSION,
                created_at=revision_200_at,
            )
        )
    at_capacity = client.get(f"/api/drafts/{draft_id}/capacity")
    assert at_capacity.status_code == 200
    assert at_capacity.json() == {
        "current_revision": 200,
        "max_revisions": 200,
        "remaining_revisions": 0,
    }
    ceiling = client.put(
        f"/api/drafts/{draft_id}",
        json={"expected_revision": 200, "content": "<p>Revision 201</p>"},
    )
    assert ceiling.status_code == 409
    assert "200-revision storage limit" in ceiling.json()["detail"]
    with session_scope(factory) as session:
        assert (
            session.scalar(
                select(DraftDocumentRow.current_revision).where(DraftDocumentRow.id == draft_id)
            )
            == 200
        )


def test_persisted_draft_corruption_is_a_generic_service_failure(matters_api) -> None:
    client, actor, repository, _application, engine, _route_app, _directory = matters_api
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        draft_id="draft-corrupt",
        title="Private",
        content="<p>CONFIDENTIAL_CLIENT_CONTENT</p>",
        now=BASE_TIME,
    )
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        row = session.get(
            DraftRevisionRow,
            {"draft_id": "draft-corrupt", "revision": 1},
        )
        assert row is not None
        row.content_sha256 = "0" * 64

    actor["value"] = _user("user-one")
    response = client.get("/api/drafts/draft-corrupt")
    assert response.status_code == 503
    assert response.json() == {"detail": "Matter persistence is temporarily unavailable."}
    assert "CONFIDENTIAL_CLIENT_CONTENT" not in response.text
    assert "DraftRevision" not in response.text
    assert "pydantic" not in response.text.lower()
    with pytest.raises(MatterPersistenceUnavailable):
        repository.get_draft(
            "draft-corrupt",
            tenant_id="tenant-a",
            owner_user_id="user-one",
        )


def test_repository_programming_errors_never_escape_as_client_detail(
    matters_api,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, actor, repository, _application, _engine, _route_app, _directory = matters_api
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        draft_id="draft-internal-error",
        title="Private",
        content="<p>Private content</p>",
        now=BASE_TIME,
    )
    actor["value"] = _user("user-one")

    invalid_input = client.get(f"/api/drafts/{'x' * 256}")
    assert invalid_input.status_code == 422
    assert invalid_input.json() == {"detail": "Matter or draft input is invalid."}

    def fail_snapshot(*_args: object, **_kwargs: object) -> None:
        raise ValueError("internal row detail must not escape")

    monkeypatch.setattr(repository, "_draft_snapshot", fail_snapshot)
    response = client.get("/api/drafts/draft-internal-error")
    assert response.status_code == 503
    assert response.json() == {"detail": "Matter persistence is temporarily unavailable."}
    assert "internal row detail" not in response.text


def test_delete_route_clears_only_real_application_refs_and_never_leaks_private_ids(
    matters_api,
) -> None:
    client, actor, repository, application, _engine, _route_app, directory = matters_api
    repository.create_matter(
        tenant_id="tenant-a",
        name="Deletion route",
        creator_user_id="user-one",
        member_user_ids=["user-two"],
        matter_id="matter-delete-route",
        now=BASE_TIME,
    )
    application.upsert_chat_thread(_thread("private-thread-one", owner_user_id="user-one"))
    application.upsert_chat_thread(_thread("private-thread-two", owner_user_id="user-two"))
    application.upsert_chat_folder(_folder("private-folder-two", owner_user_id="user-two"))
    repository.bind_chat_thread(
        "private-thread-one",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-delete-route",
    )
    repository.bind_chat_thread(
        "private-thread-two",
        tenant_id="tenant-a",
        owner_user_id="user-two",
        matter_id="matter-delete-route",
    )
    repository.bind_chat_folder(
        "private-folder-two",
        tenant_id="tenant-a",
        owner_user_id="user-two",
        matter_id="matter-delete-route",
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-delete-route",
        draft_id="private-draft-one",
        title="Owner one",
        content="<p>Owner one work</p>",
        now=BASE_TIME,
    )
    repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-two",
        matter_id="matter-delete-route",
        draft_id="private-draft-two",
        title="Owner two",
        content="<p>Owner two work</p>",
        now=BASE_TIME,
    )

    actor["value"] = _user("user-one")
    requested = client.delete(
        "/api/matters/matter-delete-route",
        params={"expected_version": 1},
    )
    # Every stage's real worker runs in the same request, so a healthy
    # deletion completes in one pass with every stage honestly timestamped.
    assert requested.status_code == 200
    assert set(requested.json()) == {"job"}
    job = requested.json()["job"]
    assert job["status"] == "complete"
    assert job["attempt_count"] == 1
    assert job["application_refs_cleared_at"] is not None
    assert job["review_refs_cleared_at"] is not None
    assert job["knowledge_refs_cleared_at"] is not None
    assert job["legacy_refs_cleared_at"] is not None
    for private_id in (
        "private-thread-one",
        "private-thread-two",
        "private-folder-two",
        "private-draft-one",
        "private-draft-two",
    ):
        assert private_id not in requested.text

    # The real external workers were invoked exactly once for this matter.
    assert directory.cleared_review_matters == ["matter-delete-route"]
    assert directory.cleared_knowledge_matters == ["matter-delete-route"]
    assert application.get_chat_thread("private-thread-one").matter_id is None
    assert application.get_chat_thread("private-thread-two").matter_id is None
    assert application.get_chat_folder("private-folder-two").matter_id is None
    assert (
        repository.get_draft(
            "private-draft-one",
            tenant_id="tenant-a",
            owner_user_id="user-one",
        ).document.matter_id
        is None
    )
    assert (
        repository.get_draft(
            "private-draft-two",
            tenant_id="tenant-a",
            owner_user_id="user-two",
        ).document.matter_id
        is None
    )

    # The matter container is gone; a repeat delete is an idempotent complete
    # tombstone and does not rerun any worker.
    assert client.get("/api/matters/matter-delete-route").status_code == 404
    completed = client.delete(
        "/api/matters/matter-delete-route",
        params={"expected_version": 1},
    )
    assert completed.status_code == 200
    assert completed.json()["job"]["status"] == "complete"
    assert directory.cleared_review_matters == ["matter-delete-route"]
    assert directory.cleared_knowledge_matters == ["matter-delete-route"]
    assert set(completed.json()) == {"job"}
    assert client.get("/api/matters/matter-delete-route").status_code == 404
    assert client.get("/api/matters/matter-delete-route/deletion").json()["status"] == "complete"
    assert client.get("/api/drafts/private-draft-one").status_code == 200
    actor["value"] = _user("user-two")
    assert client.get("/api/drafts/private-draft-two").status_code == 200
    assert client.get("/api/matters/matter-delete-route/deletion").status_code == 403


def test_expired_deletion_lease_is_reclaimed_after_repository_restart(matters_api) -> None:
    client, actor, repository, application, engine, route_app, _directory = matters_api
    stale_time = datetime(2020, 1, 1, tzinfo=UTC)
    repository.create_matter(
        tenant_id="tenant-a",
        name="Restart reclaim",
        creator_user_id="user-one",
        matter_id="matter-stale-lease",
        now=stale_time,
    )
    application.upsert_chat_thread(_thread("stale-private-thread", owner_user_id="user-one"))
    repository.bind_chat_thread(
        "stale-private-thread",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-stale-lease",
    )
    repository.request_matter_deletion(
        "matter-stale-lease",
        tenant_id="tenant-a",
        actor_user_id="user-one",
        expected_version=1,
        now=stale_time,
    )
    first_attempt = repository.claim_matter_deletion(
        "matter-stale-lease",
        tenant_id="tenant-a",
        now=stale_time,
        lease_seconds=1,
    )
    assert first_attempt.attempt_count == 1

    restarted = MatterDraftRepository(engine)
    route_app.dependency_overrides[get_matter_draft_repository] = lambda: restarted
    actor["value"] = _user("user-one")
    reclaimed = client.delete(
        "/api/matters/matter-stale-lease",
        params={"expected_version": 1},
    )

    # The reclaimed attempt runs every stage's real worker and completes.
    assert reclaimed.status_code == 200
    job = reclaimed.json()["job"]
    assert job["status"] == "complete"
    assert job["attempt_count"] == 2
    assert job["application_refs_cleared_at"] is not None
    assert job["review_refs_cleared_at"] is not None
    assert application.get_chat_thread("stale-private-thread").matter_id is None


def test_route_auth_dependency_and_persistence_failure_mapping_are_generic(
    matters_api,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, actor, repository, _application, _engine, route_app, _directory = matters_api

    def unavailable(**_kwargs):
        raise MatterPersistenceUnavailable("internal database detail")

    monkeypatch.setattr(repository, "list_matters", unavailable)
    response = client.get("/api/matters")
    assert response.status_code == 503
    assert response.json() == {"detail": "Matter persistence is temporarily unavailable."}
    assert "internal database detail" not in response.text

    def unauthenticated() -> User:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    route_app.dependency_overrides[current_user] = unauthenticated
    actor["value"] = _user("user-one")
    assert client.get("/api/matters").status_code == 401


def test_matter_resource_assignment_is_membership_and_owner_gated(matters_api) -> None:
    client, actor, repository, application, _engine, _route_app, directory = matters_api
    repository.create_matter(
        tenant_id="tenant-a",
        name="Assignment matter",
        creator_user_id="user-one",
        member_user_ids=["user-two"],
        matter_id="matter-assign",
        now=BASE_TIME,
    )
    application.upsert_chat_thread(_thread("assign-thread", owner_user_id="user-one"))
    application.upsert_chat_folder(_folder("assign-folder", owner_user_id="user-one"))
    directory.knowledge_configs["assign-knowledge"] = KnowledgeConfig(
        id="assign-knowledge",
        tenant_id="tenant-a",
        name="Assignment knowledge",
        source_type="upload",
        enabled=True,
        owner_user_id="user-one",
    )

    actor["value"] = _user("user-one")
    assigned = client.put("/api/matters/matter-assign/resources/chat-threads/assign-thread")
    assert assigned.status_code == 200
    assert assigned.json()["matter_id"] == "matter-assign"
    assert application.get_chat_thread("assign-thread").matter_id == "matter-assign"

    folder_assigned = client.put(
        "/api/matters/matter-assign/resources/chat-folders/assign-folder"
    )
    assert folder_assigned.status_code == 200
    assert application.get_chat_folder("assign-folder").matter_id == "matter-assign"

    # Knowledge access requires a non-pending account (group membership).
    actor["value"] = _user("user-one").model_copy(update={"group_ids": ["group-a"]})
    knowledge_assigned = client.put(
        "/api/matters/matter-assign/resources/knowledge-configs/assign-knowledge"
    )
    assert knowledge_assigned.status_code == 200
    assert directory.knowledge_configs["assign-knowledge"].matter_id == "matter-assign"
    actor["value"] = _user("user-one")

    # A member still cannot bind another user's private thread.
    application.upsert_chat_thread(_thread("foreign-thread", owner_user_id="user-two"))
    foreign = client.put("/api/matters/matter-assign/resources/chat-threads/foreign-thread")
    assert foreign.status_code == 404
    assert application.get_chat_thread("foreign-thread").matter_id is None

    # Non-members are denied by the membership gate before any resource work.
    actor["value"] = _user("user-three")
    outsider = client.put("/api/matters/matter-assign/resources/chat-threads/assign-thread")
    assert outsider.status_code == 403

    # Unknown resource types are rejected without probing anything.
    actor["value"] = _user("user-one")
    unknown = client.put("/api/matters/matter-assign/resources/drafts-typo/assign-thread")
    assert unknown.status_code == 404

    # Clearing restores a null reference without deleting the resource.
    cleared = client.delete(
        "/api/matters/matter-assign/resources/chat-threads/assign-thread"
    )
    assert cleared.status_code == 200
    assert cleared.json()["matter_id"] is None
    assert application.get_chat_thread("assign-thread").matter_id is None
    assert application.get_chat_thread("assign-thread").title == "Thread assign-thread"

    # A matter that is mid-deletion refuses new assignments.
    repository.request_matter_deletion(
        "matter-assign",
        tenant_id="tenant-a",
        actor_user_id="user-one",
        expected_version=1,
    )
    refused = client.put(
        "/api/matters/matter-assign/resources/chat-folders/assign-folder"
    )
    assert refused.status_code == 409


def test_resource_references_cannot_cross_matter_membership_boundaries(matters_api) -> None:
    """A member of one matter must not mutate another matter's assignments."""

    client, actor, repository, application, _engine, _route_app, _directory = matters_api
    repository.create_matter(
        tenant_id="tenant-a",
        name="Matter A",
        creator_user_id="user-one",
        matter_id="matter-a-boundary",
        now=BASE_TIME,
    )
    repository.create_matter(
        tenant_id="tenant-a",
        name="Matter B",
        creator_user_id="user-one",
        member_user_ids=["user-two"],
        matter_id="matter-b-boundary",
        now=BASE_TIME,
    )
    application.upsert_chat_thread(_thread("boundary-thread", owner_user_id="user-one"))

    actor["value"] = _user("user-one")
    assigned = client.put(
        "/api/matters/matter-b-boundary/resources/chat-threads/boundary-thread"
    )
    assert assigned.status_code == 200

    # user-one is later removed from Matter B but keeps Matter A membership.
    repository.remove_member(
        "matter-b-boundary",
        tenant_id="tenant-a",
        actor_user_id="user-one",
        member_user_id="user-one",
        expected_version=1,
    )

    # Clearing through Matter A's endpoint must not unlink Matter B's work.
    cross_clear = client.delete(
        "/api/matters/matter-a-boundary/resources/chat-threads/boundary-thread"
    )
    assert cross_clear.status_code == 409
    # Assigning to Matter A must not silently move it out of Matter B either.
    cross_assign = client.put(
        "/api/matters/matter-a-boundary/resources/chat-threads/boundary-thread"
    )
    assert cross_assign.status_code == 409
    assert application.get_chat_thread("boundary-thread").matter_id == "matter-b-boundary"


def test_owners_can_delete_their_own_drafts_with_a_revision_guard(matters_api) -> None:
    client, actor, _repository, _application, _engine, _route_app, _directory = matters_api
    actor["value"] = _user("user-one")
    created = client.post(
        "/api/drafts",
        json={"title": "Disposable", "content": "<p>Draft body</p>"},
    )
    assert created.status_code == 201
    draft_id = created.json()["document"]["id"]

    # Another user's draft is not theirs to remove.
    actor["value"] = _user("user-two")
    assert (
        client.delete(f"/api/drafts/{draft_id}", params={"expected_revision": 1}).status_code == 404
    )

    actor["value"] = _user("user-one")
    stale = client.delete(f"/api/drafts/{draft_id}", params={"expected_revision": 99})
    assert stale.status_code == 409

    removed = client.delete(f"/api/drafts/{draft_id}", params={"expected_revision": 1})
    assert removed.status_code == 200
    assert removed.json()["id"] == draft_id
    assert client.get(f"/api/drafts/{draft_id}").status_code == 404
    assert client.get("/api/drafts").json() == []
