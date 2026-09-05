import secrets
from functools import lru_cache
from ipaddress import IPv4Network, IPv6Network, ip_network
from pathlib import Path

from dotenv import load_dotenv
from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The README starts uvicorn from services/api/, but the canonical .env lives at
# the repository root. Load it by absolute path so both APERTURE_* and the
# conventionally named OPENROUTER_* variables are present regardless of the
# process working directory. Existing real environment variables win (no override).
_REPO_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(_REPO_ROOT / ".env")

# The historical hardcoded signing secret. It is public, so a deployment that
# still uses it lets anyone forge session tokens / OIDC state and derive the
# local vault key. Retained only so startup can DETECT and reject it.
LEGACY_DEFAULT_SECRET = "change-me-before-production"

# Environments treated as developer/local. Unsafe conveniences (an
# auto-generated signing secret, private-network egress) are tolerated here but
# must fail closed in every deployed environment.
LOCAL_ENVIRONMENTS = frozenset({"local", "dev", "development", "test", "testing", "ci"})

# Environments where the unsigned ``x-aperture-user`` header may stand in for a
# signed session. Deliberately stricter than LOCAL_ENVIRONMENTS: "dev" and
# "development" routinely name *deployed*, internet-reachable staging sites
# (this project's own dev site is one), and identity is the one control where a
# single mis-set environment variable must never open passwordless entry into
# another person's account. Anything not listed here requires a signed session.
HEADER_AUTH_ENVIRONMENTS = frozenset({"local", "test", "testing", "ci"})

# Minimum signing-secret length required in deployed environments.
MIN_DEPLOYED_SECRET_LENGTH = 32


def resolve_repo_path(value: str | Path) -> Path:
    """Resolve operator-supplied relative paths from the repository root."""

    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return (_REPO_ROOT / path).resolve()


def _load_or_create_local_secret(data_dir: Path) -> str:
    """Return a persisted per-instance signing secret for local/dev use.

    Generated once and stored next to the runtime state so restarts stay stable
    (sessions and the vault key survive) without ever falling back to a public
    constant. Only used when no APERTURE_SECRET_KEY is configured.
    """
    secret_path = data_dir / ".signing_secret"
    try:
        existing = secret_path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass
    generated = secrets.token_urlsafe(48)
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        secret_path.write_text(generated, encoding="utf-8")
        secret_path.chmod(0o600)
    except OSError:
        # Even if we cannot persist it, use the freshly generated value for this
        # process rather than a known-public default.
        pass
    return generated


class Settings(BaseSettings):
    app_name: str = "Aperture Chat"
    # Accept both APERTURE_ENVIRONMENT and the shorter APERTURE_ENV so an operator
    # who sets either name actually flips the deployment posture (fail-closed
    # secret/auth). Without this alias APERTURE_ENV was silently ignored.
    environment: str = Field(
        default="local",
        validation_alias=AliasChoices("APERTURE_ENVIRONMENT", "APERTURE_ENV"),
    )
    # No hardcoded default: resolved in _resolve_secret_key() below. Local/dev
    # instances auto-generate a persistent secret; deployed environments must
    # supply a strong APERTURE_SECRET_KEY and fail closed otherwise.
    secret_key: str = ""
    local_auth_enabled: bool = True
    # Dev convenience only: allows the legacy plain x-aperture-user header when no
    # signed session token is presented. Honored ONLY in the narrow set of
    # genuinely-local environments (see dev_header_auth_allowed); every other
    # environment — including "dev"/"development" staging deployments — always
    # requires a signed session token regardless of this flag.
    dev_header_auth_enabled: bool = True
    # Sessions slide: the web app rotates its token on every load through
    # GET /api/auth/session, so this TTL is the maximum idle gap between
    # visits before sign-in is required again, not a cap on total signed-in
    # time for an active user.
    session_ttl_seconds: int = 7 * 24 * 60 * 60
    # Comma-separated origins the SSO callback may return sessions to.
    web_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5176,http://127.0.0.1:5176"
    )
    # External base URL of this API, used to build the OIDC redirect URI that
    # admins register with their identity provider.
    api_base_url: str = "http://localhost:8000"
    # Process-local token-bucket limits. A value of zero disables that endpoint
    # class. Each API worker owns independent buckets, so multi-worker
    # deployments need a shared limiter before these values become global caps.
    auth_rate_limit_per_minute: int = Field(default=10, ge=0, le=100_000)
    # Credential stuffing is an per-account attack, so the strict limit above is
    # applied per email by the sign-in route. Whole offices and VPNs reach the
    # API from one address -- and behind a reverse proxy with no trusted-proxy
    # allowlist every user shares the proxy's address -- so the per-address
    # ceiling for sign-in traffic is this multiple of it. It still bounds a
    # flood from a single source without one colleague's login attempt
    # consuming everyone else's budget.
    auth_ip_rate_limit_multiplier: int = Field(default=20, ge=1, le=1_000)
    chat_rate_limit_per_minute: int = Field(default=20, ge=0, le=100_000)
    rate_limit_max_buckets: int = Field(default=10_000, ge=100, le=1_000_000)
    rate_limit_idle_ttl_seconds: float = Field(default=300.0, ge=60.0, le=86_400.0)
    # Forwarded client addresses are honored only when the socket peer is in
    # this explicit comma-separated IP/CIDR allowlist. Empty means trust no
    # proxy and intentionally shares an IP bucket behind a reverse proxy.
    rate_limit_trusted_proxies: str = Field(
        default="",
        validation_alias=AliasChoices(
            "APERTURE_RATE_LIMIT_TRUSTED_PROXIES",
            "APERTURE_RATE_LIMIT_TRUSTED_PROXY_IPS",
        ),
    )
    seed_platform_owner_enabled: bool = True
    seed_demo_data_enabled: bool = True
    bootstrap_platform_owner_email: str = "owner@aperture.local"
    bootstrap_tenant_admin_email: str = "admin@example.local"
    runtime_state_path: str = str(_REPO_ROOT / "services/api/data/runtime_state.json")
    vector_db_path: str = str(_REPO_ROOT / "services/api/data/knowledge_vectors.sqlite3")
    # Application records migrate to this relational store in bounded phases.
    # SQLite is the zero-setup default; APERTURE_DATABASE_URL can select another
    # SQLAlchemy dialect once its driver is installed and deployment is ready.
    application_db_path: str = str(_REPO_ROOT / "services/api/data/aperture.sqlite3")
    database_url: str | None = None
    # Knowledge uploads stay on the FastAPI UploadFile spool while they are
    # validated and extracted, so larger files roll to disk instead of being
    # copied wholesale into API-process memory.
    knowledge_upload_max_mb: int = Field(default=250, ge=25, le=2048)
    # Deck brand templates (.pptx/.potx) parsed for theme extraction.
    deck_template_upload_max_mb: int = Field(default=30, ge=1, le=100)
    knowledge_max_extracted_chars: int = Field(default=10_000_000, ge=100_000, le=50_000_000)
    knowledge_ocr_enabled: bool = True
    knowledge_ocr_max_pages: int = Field(default=250, ge=1, le=2000)
    knowledge_ocr_page_timeout_seconds: float = Field(default=45.0, ge=1.0, le=300.0)
    knowledge_dense_embeddings_enabled: bool = True
    knowledge_embedding_model: str = "BAAI/bge-small-en-v1.5"
    knowledge_embedding_cache_dir: str = "/opt/aperture-models"
    knowledge_embedding_threads: int = Field(default=2, ge=1, le=16)
    elastic_url: str | None = None
    elastic_api_key: str | None = None
    scim_bearer_token: str | None = None
    # In-process background scheduler: fires enabled automation schedules and
    # flushes buffered audit events to Elastic. It runs inside the API process
    # because runtime state is a single-process store; disable only for
    # debugging (schedules then only run via "Run now").
    scheduler_enabled: bool = True
    scheduler_interval_seconds: float = 30.0

    # OpenRouter is configured with conventional, non-prefixed env names. The
    # explicit validation_alias bypasses env_prefix="APERTURE_" so these resolve
    # to OPENROUTER_* rather than APERTURE_OPENROUTER_*. The key stays server-side
    # only and is never serialized into responses, logs, or audit metadata.
    openrouter_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENROUTER_API_KEY"),
    )
    openrouter_base_url: str = Field(
        default="https://openrouter.ai/api/v1",
        validation_alias=AliasChoices("OPENROUTER_BASE_URL"),
    )
    openrouter_default_model: str = Field(
        default="openai/gpt-5.5",
        validation_alias=AliasChoices("OPENROUTER_DEFAULT_MODEL"),
    )
    openrouter_app_title: str = Field(
        default="Aperture Chat",
        validation_alias=AliasChoices("OPENROUTER_APP_TITLE"),
    )
    openrouter_app_referer: str = Field(
        default="http://localhost:5173",
        validation_alias=AliasChoices("OPENROUTER_APP_REFERER"),
    )
    box_base_url: str = Field(
        default="https://api.box.com/2.0",
        validation_alias=AliasChoices("BOX_BASE_URL"),
    )

    # Platform-hosted web search (provider-agnostic). OpenRouter-backed models
    # use OpenRouter's native web plugin; every other provider gets results
    # from this engine injected as prompt context. "duckduckgo" needs no
    # setup; switch to "searxng" once a SearXNG instance is running.
    web_search_engine: str = "duckduckgo"
    searxng_base_url: str | None = None
    web_search_max_results: int = 5
    web_search_timeout_seconds: float = 12.0
    # Long-form chat requests may use multiple provider calls for generation,
    # continuation, and quality revision. Keep this per-call timeout explicit so
    # Docker deployments can tune slow providers without code changes.
    model_gateway_timeout_seconds: float = 300.0

    # Comma-separated hostnames the egress guard may reach even in a deployed
    # environment (e.g. an internal SearXNG or on-prem iManage host). Exact,
    # case-insensitive, host-only (no scheme/port). Binds APERTURE_EGRESS_ALLOW_HOSTS.
    egress_allow_hosts: str = ""

    # Platform update checker (platform owners only). The API polls the public
    # GitHub Releases API for the repository below and offers a one-click
    # upgrade when a newer vX.Y.Z release exists. Checks run in the in-process
    # scheduler at this interval; the unauthenticated GitHub limit is 60/h, so
    # keep the interval in hours. Disable to run fully offline.
    platform_update_check_enabled: bool = True
    platform_update_repository: str = "Aperture-Chat/Aperture-Chat"
    # Empty derives the endpoint from repository, including independent forks.
    platform_update_releases_url: str = ""
    platform_update_check_interval_seconds: float = Field(default=6 * 3600.0, ge=300.0)
    platform_update_request_timeout_seconds: float = Field(default=10.0, ge=1.0, le=60.0)
    # Deprecated compatibility input; update checks use app/version.py so stale
    # deployment environment files cannot override the running image identity.
    release_version: str = ""
    # Directory shared with the updater sidecar (docker-compose.release.yml
    # mounts the aperture-updater-state volume here). Empty means no sidecar:
    # updates are still detected and described, but must be applied manually.
    platform_updater_state_dir: str = ""

    model_config = SettingsConfigDict(
        env_prefix="APERTURE_",
        env_file=".env",
        extra="ignore",
        populate_by_name=True,
    )

    @property
    def is_local_environment(self) -> bool:
        """True for developer/local/test environments; False for deployed ones.

        Gates unsafe conveniences (dev header auth, private-network egress) so
        they stay available locally but fail closed in production/staging.
        """
        return self.environment.strip().lower() in LOCAL_ENVIRONMENTS

    @property
    def dev_header_auth_allowed(self) -> bool:
        """Whether an unsigned ``x-aperture-user`` header may authenticate.

        Requires both the explicit flag and a genuinely-local environment. A
        deployed instance named "dev" is still deployed: it fails closed here
        even though :attr:`is_local_environment` is True for it.
        """
        return (
            self.dev_header_auth_enabled
            and self.environment.strip().lower() in HEADER_AUTH_ENVIRONMENTS
        )

    @property
    def web_origin_list(self) -> list[str]:
        """Normalized browser origins shared by CORS and redirect validation."""
        return [
            normalized
            for origin in self.web_origins.split(",")
            if (normalized := origin.strip().rstrip("/"))
        ]

    @property
    def rate_limit_trusted_proxy_networks(self) -> tuple[IPv4Network | IPv6Network, ...]:
        """Validated proxy IPs/CIDRs allowed to supply ``X-Forwarded-For``."""
        return tuple(
            ip_network(value.strip(), strict=False)
            for value in self.rate_limit_trusted_proxies.split(",")
            if value.strip()
        )

    @property
    def egress_allow_host_set(self) -> frozenset[str]:
        """Operator-approved hostnames the egress guard permits in any environment."""
        return frozenset(host.strip().lower() for host in self.egress_allow_hosts.split(",") if host.strip())

    @property
    def knowledge_upload_max_bytes(self) -> int:
        return self.knowledge_upload_max_mb * 1024 * 1024

    @property
    def deck_template_upload_max_bytes(self) -> int:
        return self.deck_template_upload_max_mb * 1024 * 1024

    @property
    def application_database_url(self) -> str:
        configured = (self.database_url or "").strip()
        if configured:
            return configured
        path = resolve_repo_path(self.application_db_path)
        return f"sqlite+pysqlite:///{path.as_posix()}"

    @model_validator(mode="after")
    def _resolve_secret_key(self) -> "Settings":
        secret = (self.secret_key or "").strip()
        if self.is_local_environment:
            # Never crash a developer's instance. With no secret configured we
            # generate and persist a strong one so a fresh local instance is not
            # signed with a public constant. An explicitly-configured secret
            # (even the legacy default) is kept as-is so an existing local vault
            # stays decryptable.
            if not secret:
                secret = _load_or_create_local_secret(Path(self.runtime_state_path).parent)
        else:
            # Deployed: fail closed on missing / public-default / weak secrets.
            if not secret:
                raise RuntimeError(
                    "APERTURE_SECRET_KEY must be set to a unique, high-entropy value in "
                    "non-local environments."
                )
            if secret == LEGACY_DEFAULT_SECRET:
                raise RuntimeError(
                    "APERTURE_SECRET_KEY is still the public default value; set a unique, "
                    "high-entropy secret before deploying."
                )
            if len(secret) < MIN_DEPLOYED_SECRET_LENGTH:
                raise RuntimeError(
                    f"APERTURE_SECRET_KEY must be at least {MIN_DEPLOYED_SECRET_LENGTH} "
                    "characters in non-local environments."
                )
        self.secret_key = secret
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
