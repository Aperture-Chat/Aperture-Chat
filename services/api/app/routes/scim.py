from __future__ import annotations

import hmac
import re
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.core.config import get_settings
from app.models.schemas import Role, ScimListResponse, ScimUserCreate, User
from app.repositories.deps import get_store
from app.repositories.seed import (
    LastActiveAdministrativeAccountError,
    SeedStore,
    UserIdentityConflictError,
)

router = APIRouter(prefix="/scim/v2", tags=["scim"])


def scim_actor(
    authorization: str | None = Header(default=None),
    store: SeedStore = Depends(get_store),
) -> User:
    """Authenticate SCIM requests with the configured bearer token.

    SCIM is an IdP-to-service protocol, so it never trusts the spoofable
    x-aperture-user header. Without a configured token the endpoints refuse to
    pretend provisioning works.
    """
    configured_token = (get_settings().scim_bearer_token or "").strip()
    has_active_persisted_token = any(
        record.revoked_at is None for record in store.scim_tokens.values()
    )
    if not configured_token and not has_active_persisted_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "SCIM provisioning is not configured. Mint a tenant SCIM token or set "
                "APERTURE_SCIM_BEARER_TOKEN for a single-tenant deployment."
            ),
        )

    provided = (authorization or "").strip()
    scheme, separator, secret_value = provided.partition(" ")
    if scheme.casefold() != "bearer" or not separator or not secret_value.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid SCIM bearer token."
        )

    secret_value = secret_value.strip()
    tenant = store.tenant_for_scim_token(secret_value)
    if (
        tenant is None
        and configured_token
        and len(store.tenants) == 1
        and hmac.compare_digest(secret_value, configured_token)
    ):
        tenant = next(iter(store.tenants.values()))
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid SCIM bearer token."
        )
    return User(
        id=f"scim-provisioner-{tenant.id}",
        tenant_id=tenant.id,
        email=f"scim-provisioner+{tenant.slug}@aperture.local",
        display_name="SCIM Provisioner",
        role=Role.TENANT_ADMIN,
        auth_method="scim",
    )


@router.get("/Users")
def list_users(
    actor: User = Depends(scim_actor),
    store: SeedStore = Depends(get_store),
) -> ScimListResponse:
    resources = [
        to_scim_user(user)
        for user in store.users.values()
        if user.tenant_id == actor.tenant_id and user.role != Role.PLATFORM_OWNER
    ]
    return ScimListResponse(
        totalResults=len(resources), Resources=resources, itemsPerPage=len(resources)
    )


@router.post("/Users", status_code=201)
def create_user(
    payload: ScimUserCreate,
    actor: User = Depends(scim_actor),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    email = payload.userName.strip().lower()
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="SCIM userName (email) is required."
        )
    with store._store_lock:
        _assert_scim_actor_scope(actor, store)
        _assert_scim_unique_identity(
            store,
            email=email,
            entra_object_id=payload.externalId,
        )
        user = User(
            id=_next_user_id(email, store),
            tenant_id=actor.tenant_id,
            email=email,
            display_name=_display_name(payload, email),
            role=Role.USER,
            entra_object_id=payload.externalId,
            group_ids=_tenant_group_ids(payload, actor, store),
            active=payload.active,
            last_active="Provisioned via SCIM",
            auth_method="scim",
        )
        store.users[user.id] = user
        store.record_audit(
            actor,
            "scim.user_created",
            user.id,
            {"email": user.email, "group_ids": user.group_ids},
        )
        store.save_runtime_state()
        return to_scim_user(user)


@router.put("/Users/{user_id}")
def replace_user(
    user_id: str,
    payload: ScimUserCreate,
    actor: User = Depends(scim_actor),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    user = _get_scim_manageable_user(user_id, actor, store)
    expected_role = user.role
    expected_tenant_id = user.tenant_id
    expected_group_ids = tuple(user.group_ids)
    expected_active = user.active
    email = payload.userName.strip().lower()
    if email and any(
        other.email.lower() == email for other in store.users.values() if other.id != user.id
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="User email already exists."
        )
    next_email = email or user.email
    next_display_name = _display_name(payload, next_email)
    next_group_ids = _tenant_group_ids(payload, actor, store)
    updates: dict[str, Any] = {
        "email": next_email,
        "display_name": next_display_name,
        "active": payload.active,
        "group_ids": next_group_ids,
    }
    if payload.externalId:
        updates["entra_object_id"] = payload.externalId
    _apply_scim_user_mutation_or_503(
        store,
        user,
        actor,
        expected_role=expected_role,
        expected_tenant_id=expected_tenant_id,
        expected_group_ids=expected_group_ids,
        expected_active=expected_active,
        updates=updates,
        revoke_sessions=True,
    )
    store.record_audit(
        actor, "scim.user_replaced", user.id, {"email": user.email, "active": user.active}
    )
    store.save_runtime_state()
    return to_scim_user(user)


@router.patch("/Users/{user_id}")
def patch_user(
    user_id: str,
    payload: dict[str, Any],
    actor: User = Depends(scim_actor),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    user = _get_scim_manageable_user(user_id, actor, store)
    expected_role = user.role
    expected_tenant_id = user.tenant_id
    expected_group_ids = tuple(user.group_ids)
    expected_active = user.active
    parsed_operations: list[tuple[str, bool | str | None]] = []
    deactivating = False
    for operation in payload.get("Operations", []):
        path = str(operation.get("path", "")).lower()
        if path == "active":
            value = _scim_active_value(operation.get("value"))
            if not value:
                deactivating = True
            parsed_operations.append((path, value))
        elif path == "displayname":
            value = str(operation.get("value") or "").strip()
            parsed_operations.append((path, value or None))
    changed: list[str] = []
    updates: dict[str, Any] = {}
    for path, value in parsed_operations:
        if path == "active":
            updates["active"] = bool(value)
            changed.append("active")
        elif path == "displayname":
            if value:
                updates["display_name"] = str(value)
                changed.append("display_name")
    if updates:
        _apply_scim_user_mutation_or_503(
            store,
            user,
            actor,
            expected_role=expected_role,
            expected_tenant_id=expected_tenant_id,
            expected_group_ids=expected_group_ids,
            expected_active=expected_active,
            updates=updates,
            revoke_sessions=deactivating or any(
                field in updates for field in {"email", "entra_object_id", "group_ids"}
            ),
        )
    store.record_audit(
        actor, "scim.user_patched", user.id, {"changed": changed, "active": user.active}
    )
    store.save_runtime_state()
    return to_scim_user(user)


@router.delete("/Users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: str,
    actor: User = Depends(scim_actor),
    store: SeedStore = Depends(get_store),
) -> None:
    user = _get_scim_manageable_user(user_id, actor, store)
    expected_role = user.role
    expected_tenant_id = user.tenant_id
    expected_group_ids = tuple(user.group_ids)
    expected_active = user.active
    _apply_scim_user_mutation_or_503(
        store,
        user,
        actor,
        expected_role=expected_role,
        expected_tenant_id=expected_tenant_id,
        expected_group_ids=expected_group_ids,
        expected_active=expected_active,
        updates={"active": False},
        revoke_sessions=True,
    )
    store.record_audit(actor, "scim.user_deactivated", user.id, {"active": False})
    store.save_runtime_state()
    return None


@router.get("/Groups")
def list_groups(
    actor: User = Depends(scim_actor),
    store: SeedStore = Depends(get_store),
) -> ScimListResponse:
    groups = [
        {
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
            "id": group.id,
            "displayName": group.name,
            "externalId": group.entra_object_id,
        }
        for group in store.groups.values()
        if group.tenant_id == actor.tenant_id
    ]
    return ScimListResponse(totalResults=len(groups), Resources=groups, itemsPerPage=len(groups))


def _get_scim_manageable_user(user_id: str, actor: User, store: SeedStore) -> User:
    user = store.users.get(user_id)
    if user is None or user.tenant_id != actor.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown SCIM user.")
    if user.role == Role.PLATFORM_OWNER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Service-managed accounts cannot be managed through SCIM.",
        )
    return user


def _apply_scim_user_mutation_or_503(
    store: SeedStore,
    target: User,
    actor: User,
    *,
    expected_role: Role,
    expected_tenant_id: str | None,
    expected_group_ids: tuple[str, ...],
    expected_active: bool,
    updates: dict[str, Any],
    revoke_sessions: bool,
) -> int | None:
    try:
        return store.apply_scim_user_mutation(
            target,
            actor=actor,
            expected_role=expected_role,
            expected_tenant_id=expected_tenant_id,
            expected_group_ids=expected_group_ids,
            expected_active=expected_active,
            updates=updates,
            revoke_sessions=revoke_sessions,
            reason="scim-user-deactivated",
            updated_by=actor.id,
        )
    except UserIdentityConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except LastActiveAdministrativeAccountError as exc:
        detail = (
            "This service-managed account cannot be changed."
            if exc.role == Role.PLATFORM_OWNER
            else "This action is blocked by administrative continuity policy."
        )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from exc
    except Exception as exc:  # noqa: BLE001 - security mutation must fail closed
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is temporarily unavailable.",
        ) from exc


def _assert_scim_actor_scope(actor: User, store: SeedStore) -> None:
    if (
        actor.auth_method != "scim"
        or actor.role != Role.TENANT_ADMIN
        or actor.tenant_id is None
        or actor.id != f"scim-provisioner-{actor.tenant_id}"
        or actor.tenant_id not in store.tenants
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="SCIM tenant authorization changed. Retry the request.",
        )


def _assert_scim_unique_identity(
    store: SeedStore,
    *,
    email: str | None,
    entra_object_id: str | None,
    exclude_user_id: str | None = None,
) -> None:
    normalized_email = (email or "").strip().lower()
    normalized_entra_id = (entra_object_id or "").strip().lower()
    for user in store.users.values():
        if user.id == exclude_user_id:
            continue
        if normalized_email and user.email.strip().lower() == normalized_email:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="User email already exists.",
            )
        if (
            normalized_entra_id
            and (user.entra_object_id or "").strip().lower() == normalized_entra_id
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="User Entra object ID already exists.",
            )


def _scim_active_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="SCIM active must be a boolean or the string 'true' or 'false'.",
    )


def _display_name(payload: ScimUserCreate, email: str) -> str:
    if payload.name is not None:
        parts = [payload.name.givenName or "", payload.name.familyName or ""]
        combined = " ".join(part.strip() for part in parts if part and part.strip())
        if combined:
            return combined
    local = email.split("@", 1)[0]
    return " ".join(part.capitalize() for part in re.split(r"[._-]+", local) if part) or email


def _tenant_group_ids(payload: ScimUserCreate, actor: User, store: SeedStore) -> list[str]:
    group_ids: list[str] = []
    for entry in payload.groups:
        raw = str(entry.get("value") or "").strip()
        if not raw:
            continue
        group = store.groups.get(raw)
        if group is None:
            group = next(
                (
                    item
                    for item in store.groups.values()
                    if item.tenant_id == actor.tenant_id
                    and (item.entra_object_id == raw or item.name == raw)
                ),
                None,
            )
        if group is not None and group.tenant_id == actor.tenant_id and group.id not in group_ids:
            group_ids.append(group.id)
    return group_ids


def _next_user_id(email: str, store: SeedStore) -> str:
    base = f"user-{re.sub(r'[^a-z0-9]+', '-', email.split('@', 1)[0].lower()).strip('-') or 'scim'}"
    candidate = base
    suffix = 2
    while candidate in store.users:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def to_scim_user(user: User) -> dict[str, Any]:
    return {
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
        "id": user.id,
        "externalId": user.entra_object_id,
        "userName": user.email,
        "displayName": user.display_name,
        "active": user.active,
        "groups": [{"value": group_id} for group_id in user.group_ids],
    }
