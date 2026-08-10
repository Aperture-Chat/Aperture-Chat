from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayRoute
from app.core.web_fetch import FetchedWebSource, WebFetchError
from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _headers() -> dict[str, str]:
    return {"x-aperture-user": "user-admin"}


def _route() -> ModelGatewayRoute:
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


def _tenant_route(_store, _model, *, tenant_id: str | None) -> ModelGatewayRoute:
    assert tenant_id == "tenant-example"
    return _route()


class _CapturingGateway:
    def __init__(self) -> None:
        self.messages: list[dict[str, str]] | None = None
        self.call_count = 0

    def complete(self, **kwargs: object) -> dict[str, object]:
        self.call_count += 1
        self.messages = kwargs["messages"]  # type: ignore[assignment]
        return {
            "id": "completion-url-fetch",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Grounded answer [U1]."},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
        }


def test_ad_hoc_url_is_fetched_once_injected_and_cited_without_query_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_url = "https://example.test/report?token=do-not-store"
    fetch_calls: list[str] = []

    def fake_fetch(url: str, **kwargs: object) -> FetchedWebSource:
        fetch_calls.append(url)
        assert kwargs["max_chars"] == 12_000
        return FetchedWebSource(
            requested_url=url,
            final_url=url,
            filename="report.html",
            content_type="text/html",
            text="The verified filing deadline is July 31.",
            byte_count=120,
        )

    gateway = _CapturingGateway()
    monkeypatch.setattr("app.routes.chat.fetch_web_source", fake_fetch)
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _tenant_route)
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)

    response = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "What is the filing deadline?"}],
            "fetch_urls": [requested_url, f"  {requested_url}  "],
            "citations_enabled": True,
        },
    )

    assert response.status_code == 200
    assert fetch_calls == [requested_url]
    body = response.json()
    fetched_citation = next(item for item in body["citations"] if item["id"] == "cite-fetch-1")
    assert fetched_citation["source_uri"] == "https://example.test/report"
    assert fetched_citation["source_name"] == "report.html"
    assert fetched_citation["page_start"] is None
    assert gateway.messages is not None
    prompt = gateway.messages[0]["content"]
    assert "[U1] report.html (https://example.test/report)" in prompt
    assert "verified filing deadline is July 31" in prompt
    assert "untrusted source material" in prompt
    assert "do-not-store" not in prompt

    runtime_context = get_store().audit_events[-1].metadata["runtime_context"]
    assert runtime_context["fetched_urls"] == [
        {
            "u_index": 1,
            "source_name": "report.html",
            "source_uri": "https://example.test/report",
            "byte_count": 120,
            "content_type": "text/html",
        }
    ]
    assert "do-not-store" not in str(runtime_context)
    assert "verified filing deadline" not in str(runtime_context)
    fetched_audit_citation = next(
        item for item in runtime_context["citations"] if item["id"] == "cite-fetch-1"
    )
    assert fetched_audit_citation["snippet"] == "[fetched source excerpt omitted from audit]"


def test_ad_hoc_url_fetch_failure_stops_before_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = _CapturingGateway()
    monkeypatch.setattr(
        "app.routes.chat.fetch_web_source",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            WebFetchError(400, "Web source URL is not permitted: blocked metadata address")
        ),
    )
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _tenant_route)
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)

    response = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Fetch this."}],
            "fetch_urls": ["http://169.254.169.254/latest/meta-data"],
        },
    )

    assert response.status_code == 400
    assert "not permitted" in response.json()["detail"]
    assert gateway.call_count == 0


def test_ad_hoc_url_contract_rejects_more_than_three_or_blank_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _tenant_route)

    too_many = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Fetch these."}],
            "fetch_urls": [f"https://example.test/{index}" for index in range(4)],
        },
    )
    blank = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Fetch this."}],
            "fetch_urls": ["   "],
        },
    )

    assert too_many.status_code == 422
    assert blank.status_code == 422
    assert blank.json()["detail"] == "Ad-hoc URL entries must not be blank."
