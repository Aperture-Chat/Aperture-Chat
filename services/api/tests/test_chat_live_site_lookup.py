"""Chat turns look further on knowledge web sources and cite the live pages."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core import live_site_lookup as live
from app.core.model_gateway import ModelGatewayRoute
from app.core.web_fetch import FetchedWebSource, WebFetchError
from app.main import app
from app.models.schemas import KnowledgeConfig, KnowledgeDocument
from app.repositories.deps import get_store

client = TestClient(app)
LIVE_URL = "https://www.registry.test/compounds/ethanol"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


class _CapturingGateway:
    def __init__(self) -> None:
        self.messages: list[dict[str, str]] | None = None

    def complete(self, **kwargs: object) -> dict[str, object]:
        self.messages = kwargs["messages"]  # type: ignore[assignment]
        return {
            "id": "completion-live-site",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "It boils at 78.37 C [K1]."},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 12, "completion_tokens": 6, "total_tokens": 18},
        }


def _route(_store, _model, *, tenant_id: str | None) -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Test Provider",
        provider_kind="openai-compatible",
        auth_type="bearer",
        upstream_model="gpt-4o-mini",
        base_url="https://provider.invalid/v1",
        configured=True,
        status_message="Configured",
        secret_value="test-only-secret",
    )


def _install_registry() -> KnowledgeConfig:
    store = get_store()
    config = KnowledgeConfig(
        id="kb-live-registry",
        tenant_id="tenant-example",
        name="Registry",
        source_type="web",
        enabled=True,
        owner_user_id="user-admin",
        acl_group_ids=["group-litigation"],
        settings={
            "linked_sources": [
                {
                    "document_id": "doc-web-registry",
                    "kind": "web",
                    "name": "Synthetic Registry",
                    "url": "https://www.registry.test/",
                    "refresh": True,
                    "live_lookup": True,
                    "pages": ["https://www.registry.test/"],
                    "inventory": [{"url": LIVE_URL, "text": "Ethanol properties"}],
                }
            ]
        },
    )
    store.knowledge_configs[config.id] = config
    store.knowledge_documents[config.id] = [
        KnowledgeDocument(
            id="doc-web-registry",
            knowledge_config_id=config.id,
            tenant_id="tenant-example",
            name="Synthetic Registry",
            source_uri="https://www.registry.test/",
            source_type="web",
            acl_group_ids=["group-litigation"],
            updated_at="Oct 1, 2026, 9:00 AM UTC",
        )
    ]
    store.knowledge_chunks[config.id] = []
    return config


def _ask(monkeypatch: pytest.MonkeyPatch, gateway: _CapturingGateway, fetch) -> dict:
    config = _install_registry()
    monkeypatch.setattr(live, "_fetch_live_page", fetch)
    monkeypatch.setattr(live, "_platform_site_search", lambda _store, _tenant: None)
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)
    response = client.post(
        "/api/chat/complete",
        headers={"x-aperture-user": "user-admin"},
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "What is the boiling point of ethanol?"}],
            "knowledge_config_ids": [config.id],
            "citations_enabled": True,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_live_site_passage_is_injected_and_cited(monkeypatch: pytest.MonkeyPatch) -> None:
    def fetch(url: str) -> FetchedWebSource:
        assert url == LIVE_URL
        text = "Ethanol properties\n\nEthanol has a boiling point of 78.37 degrees Celsius."
        return FetchedWebSource(url, url, "ethanol.html", "text/html", text, len(text), title="Ethanol properties")

    gateway = _CapturingGateway()
    body = _ask(monkeypatch, gateway, fetch)

    citation = next(item for item in body["citations"] if item["source_uri"] == LIVE_URL)
    assert citation["locator"] == "Live page"
    assert citation["k_index"] >= 1
    assert gateway.messages is not None
    prompt = gateway.messages[0]["content"]
    assert f"(Live page) Synthetic Registry ({LIVE_URL})" in prompt
    assert "boiling point of 78.37 degrees" in prompt
    runtime_context = get_store().audit_events[-1].metadata["runtime_context"]
    assert runtime_context["live_site_urls"] == [LIVE_URL]
    assert any(ref["source_uri"] == LIVE_URL for ref in runtime_context["knowledge_hit_refs"])


def test_failed_live_fetch_still_answers_from_the_index(monkeypatch: pytest.MonkeyPatch) -> None:
    def fetch(url: str) -> FetchedWebSource:
        raise WebFetchError(502, f"Web source fetch failed for {url}: HTTP 503.")

    gateway = _CapturingGateway()
    body = _ask(monkeypatch, gateway, fetch)

    assert not any(item["source_uri"] == LIVE_URL for item in body["citations"])
    assert get_store().audit_events[-1].metadata["runtime_context"]["live_site_urls"] == []
