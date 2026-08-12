import asyncio
import logging
import os
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.rate_limit import RateLimitMiddleware
from app.core.scheduler import scheduler_loop
from app.repositories.deps import get_store
from app.repositories.review_deps import close_review_services, initialize_review_services
from app.routes import (
    admin,
    agents,
    assets,
    auth,
    automations,
    bootstrap,
    chat,
    connector_oauth,
    deck_templates,
    health,
    knowledge,
    matters,
    memory,
    platform,
    pwa,
    review,
    scim,
    search,
    tools,
)


def _restrict_data_directory_permissions() -> None:
    """Keep application data unreadable to anything but the API's own user.

    Custom script tools run as an unprivileged account, but that only bounds
    them if the database, runtime state and vector stores are not world
    readable -- they are created 0644 by default, which left provider-key
    ciphertext and every tenant's data open to any process in the container.
    Applied at startup so it survives image rebuilds and restored volumes.
    Failures are logged and never block boot: a deployment where the API cannot
    chmod its own data directory is still a working deployment.
    """
    # Startup runs before the databases exist on a fresh volume, so chmod alone
    # would leave every file created afterwards at the default 0644 -- protected
    # only by the directory mode, and therefore one permission change away from
    # being world readable again. The umask makes the restrictive mode the
    # default for anything this process creates from here on.
    os.umask(0o077)
    settings = get_settings()
    roots = {
        Path(settings.application_db_path).expanduser().parent,
        Path(settings.runtime_state_path).expanduser().parent,
        Path(settings.vector_db_path).expanduser().parent,
    }
    for root in roots:
        if not root.is_dir():
            continue
        try:
            os.chmod(root, 0o700)
            for entry in root.rglob("*"):
                os.chmod(entry, 0o700 if entry.is_dir() else 0o600)
        except OSError as exc:
            logging.getLogger("aperture.startup").warning(
                "Could not restrict permissions on %s: %s", root, exc
            )


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Run the in-process scheduler alongside the API and stop it cleanly.

    Skipped under pytest so route tests stay deterministic; scheduler behavior
    has its own dedicated tests.
    """
    task: asyncio.Task[None] | None = None
    _restrict_data_directory_permissions()
    store = get_store()
    try:
        # This deployment runs one API process per application database. Any
        # permit still started when a new process opens the database was
        # orphaned by the prior process and has no provider call that can still
        # settle. Reconcile it before routes or background workers accept work.
        store.usage_budget_repository.abandon_started_permits()
        # Opening review SQLite at process startup performs the durable
        # running->interrupted sweep before the API accepts traffic.
        initialize_review_services()
        store.resume_identity_cleanup_jobs()
        if get_settings().scheduler_enabled and not os.environ.get("PYTEST_CURRENT_TEST"):
            task = asyncio.create_task(scheduler_loop())
        yield
    finally:
        try:
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        finally:
            try:
                # Review workers can still record SQL usage/audit activity, so
                # stop them before closing their repository dependencies.
                close_review_services()
            finally:
                # Persist the final coalesced snapshot after the scheduler can
                # no longer mutate it. A failed flush is intentionally surfaced.
                store.close()


app = FastAPI(
    title="Aperture Chat API",
    description=(
        "Secure enterprise AI chat: auth and SSO, platform-owner controls, tenant "
        "admin, SCIM, chat, knowledge, tools, agents, and scheduled automations."
    ),
    version="0.4.1",
    lifespan=lifespan,
)


_SENSITIVE_VALIDATION_KEYS = {
    "challenge",
    "ciphertext",
    "code",
    "enrollment",
    "key",
    "password",
    "provisioning",
    "recovery",
    "secret",
    "seed",
    "token",
}


@app.exception_handler(RequestValidationError)
async def redact_sensitive_validation_input(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """Keep FastAPI's 422 shape without reflecting submitted credentials."""

    redacted_errors: list[dict[str, object]] = []
    auth_path = request.url.path.startswith("/api/auth")
    for original in exc.errors():
        error = dict(original)
        location = error.get("loc", ())
        sensitive_location = any(
            any(token in str(part).lower() for token in _SENSITIVE_VALIDATION_KEYS)
            for part in location
        )
        # A missing or malformed non-secret field can make Pydantic attach the
        # entire submitted body to ``input``. Treat every auth validation error
        # as sensitive so a sibling password, challenge, or code is never
        # reflected merely because the reported location was, for example,
        # ``email``.
        sensitive_error = auth_path or sensitive_location
        if "input" in error and sensitive_error:
            error["input"] = "[redacted]"
        if sensitive_error:
            error.pop("ctx", None)
            error["msg"] = "Input is invalid."
        redacted_errors.append(error)
    headers = {"Cache-Control": "no-store"} if auth_path else None
    return JSONResponse(
        status_code=422,
        content=jsonable_encoder({"detail": redacted_errors}),
        headers=headers,
    )


@app.exception_handler(Exception)
async def generic_unhandled_error(request: Request, _exc: Exception) -> JSONResponse:
    """Keep outer 500 responses generic and preserve the auth no-store contract."""

    headers = {"Cache-Control": "no-store"} if request.url.path.startswith("/api/auth") else None
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected server error occurred."},
        headers=headers,
    )


@app.middleware("http")
async def prevent_auth_response_caching(request: Request, call_next):
    """Guarantee that every auth success and error response is non-cacheable."""

    response = await call_next(request)
    if request.url.path.startswith("/api/auth"):
        existing = response.headers.get("Cache-Control", "")
        if "no-store" not in existing.lower():
            response.headers["Cache-Control"] = f"{existing}, no-store" if existing else "no-store"
    return response


# Register the limiter first so Starlette's reverse wrapping order leaves CORS
# outermost; browser clients then receive CORS headers even on a 429 response.
app.add_middleware(
    RateLimitMiddleware,
    settings=get_settings(),
    store_factory=get_store,
    # The repository's route suite shares one global TestClient across hundreds
    # of requests. Focused limiter tests use isolated apps with this bypass off.
    bypass_during_pytest=True,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().web_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(bootstrap.router)
app.include_router(platform.router)
app.include_router(admin.router)
app.include_router(chat.router)
app.include_router(memory.router)
app.include_router(knowledge.router)
app.include_router(connector_oauth.router)
app.include_router(tools.router)
app.include_router(agents.router)
app.include_router(automations.router)
app.include_router(matters.router)
app.include_router(deck_templates.router)
app.include_router(search.router)
app.include_router(review.router)
app.include_router(scim.router)
app.include_router(assets.router)
app.include_router(pwa.router)
