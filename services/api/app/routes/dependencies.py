import logging
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, status

from app.core.config import get_settings
from app.core.policy import api_access_allowed
from app.core.sessions import SessionClaims, verify_session_token
from app.models.schemas import User
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore


logger = logging.getLogger("aperture.auth")


@dataclass(frozen=True, slots=True)
class AuthenticatedSession:
    user: User
    claims: SessionClaims


def current_signed_session(
    x_aperture_session: str | None = Header(default=None),
    store: SeedStore = Depends(get_store),
) -> AuthenticatedSession:
    """Require a current signed browser session; dev headers are not sessions."""

    if not x_aperture_session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A signed session is required.",
        )
    return _authenticated_signed_session(x_aperture_session, store)


def optional_signed_session(
    x_aperture_session: str | None = Header(default=None),
    store: SeedStore = Depends(get_store),
) -> AuthenticatedSession | None:
    if not x_aperture_session:
        return None
    return _authenticated_signed_session(x_aperture_session, store)


def current_user(
    x_aperture_session: str | None = Header(default=None),
    x_aperture_user: str | None = Header(default=None),
    store: SeedStore = Depends(get_store),
) -> User:
    return _current_session_user(x_aperture_session, x_aperture_user, store)


def current_user_or_api_key(
    authorization: str | None = Header(default=None),
    x_aperture_session: str | None = Header(default=None),
    x_aperture_user: str | None = Header(default=None),
    store: SeedStore = Depends(get_store),
) -> User:
    """Authenticate OpenAI-compatible routes with a personal bearer key.

    Signed browser sessions remain accepted for compatibility and interactive
    API testing. A presented bearer token never falls back to another auth
    mechanism when invalid.
    """
    if authorization:
        scheme, separator, credentials = authorization.partition(" ")
        if scheme.casefold() != "bearer" or not separator or not credentials.strip():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Use Authorization: Bearer <API key>.",
            )
        user = store.user_for_api_key(credentials.strip())
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API key is invalid or has been revoked.",
            )
        if not api_access_allowed(user, store.groups, store.platform_settings):
            detail = (
                "Downstream API access is unavailable under the current service policy."
                if not store.platform_settings.downstream_api_enabled
                else "API access is disabled for your platform groups by tenant policy."
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=detail,
            )
        return user
    return _current_session_user(x_aperture_session, x_aperture_user, store)


def _current_session_user(
    x_aperture_session: str | None,
    x_aperture_user: str | None,
    store: SeedStore,
) -> User:
    settings = get_settings()
    user_id: str | None = None

    if x_aperture_session:
        return _authenticated_signed_session(x_aperture_session, store).user
    elif x_aperture_user and settings.dev_header_auth_allowed:
        # The unsigned x-aperture-user header is a genuinely-local convenience
        # only. Every deployed environment — including one named "dev" — ignores
        # it and requires a signed session, so it can never be used to enter
        # another person's account.
        user_id = x_aperture_user

    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    user = store.users.get(user_id)
    if not user or not user.active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown or inactive user")
    return user


def _authenticated_signed_session(
    token: str,
    store: SeedStore,
) -> AuthenticatedSession:
    claims = verify_session_token(token, get_settings().secret_key)
    if claims is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is invalid or expired. Sign in again.",
        )
    try:
        user = store.user_for_session_claims(claims)
    except Exception as exc:  # noqa: BLE001 - never fail open on a revocation-store error
        logger.exception("Session revocation validation failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session validation is temporarily unavailable.",
        ) from exc
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is invalid or expired. Sign in again.",
        )
    return AuthenticatedSession(user=user, claims=claims)
