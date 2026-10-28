"""Read handwriting, stamps, and pictures in knowledge files with a vision model.

Tesseract reads clean print well but not handwriting, margin notes, stamps, or
the text inside photos and charts. When a workspace has an image-capable model
configured -- Gemini Flash on OpenRouter, a GPT-4.1/GPT-5 deployment on Azure AI
Foundry, Claude, or any other provider the gateway speaks -- knowledge uploads
send rendered pages to it through the same gateway and usage metering as chat.
Every failure is soft: the extractor falls back to Tesseract, and a budget or
provider problem turns the reader off for the rest of the file instead of
failing the upload.
"""

from __future__ import annotations

import base64
import logging
import re
from collections.abc import Callable, Iterable
from io import BytesIO
from threading import Lock
from typing import Any

from app.core.media_transcription import (
    _gemini_flash_rank,
    is_gemini_flash_upstream,
    is_gemini_pro_upstream,
)
from app.core.model_gateway import (
    ModelGatewayAuthError,
    ModelGatewayConfigurationError,
    ModelGatewayError,
    ModelGatewayRoute,
    get_model_gateway_client,
    resolve_model_route,
    supports_image_input,
    supports_reasoning_effort,
)
from app.core.usage_budget import UsageBudgetError, new_accounting_id
from app.core.usage_budget_runtime import ProviderUsageAttribution
from app.models.schemas import ModelConfig

logger = logging.getLogger("aperture.vision_ocr")

USAGE_SURFACE = "knowledge-ocr"
MAX_IMAGE_EDGE_PX = 2000
JPEG_QUALITY = 85
DEFAULT_MAX_PAGES = 60
DEFAULT_CONCURRENCY = 4
MAX_CONSECUTIVE_FAILURES = 3
PLAIN_MAX_TOKENS = 4096
# Reasoning models spend completion tokens thinking before they answer.
REASONING_MAX_TOKENS = 12_000

_NONE_ANSWER = re.compile(r"\s*none\.?\s*", re.IGNORECASE)
_IMAGE_OUTPUT_ID = re.compile(r"(?:^|[-_.:/])(?:image|tts|embed|embedding|transcribe|realtime|audio)(?:[-_.:]|$)")

_RULES = (
    "Reproduce the words exactly as written; do not summarize, translate, or correct them. "
    "Write [illegible] for a word you cannot read and [signature] for a signature. "
    "Render tables as rows with cells separated by ' | '. "
    "Output only the transcription, with no preamble."
)
_PROMPTS = {
    "full": (
        "You are an OCR engine for scanned documents. Transcribe all text on the page in "
        "reading order, including printed text, handwriting, margin notes, stamps, dates, "
        "and text inside images. " + _RULES + " If the page has photos, charts, or "
        "diagrams, end with a line 'Visual content:' followed by one short sentence each."
    ),
    "extras": (
        "You are an OCR engine. The typed text of this page has already been extracted, so "
        "do not repeat it. Transcribe only what text extraction misses: handwriting, "
        "annotations, initials, stamps, signatures, and text inside images or scans. "
        "Then describe any chart, diagram, or photo in one short sentence each. "
        + _RULES
        + " If there is nothing like that on the page, reply exactly NONE."
    ),
    "image": (
        "You read pictures embedded in documents. Transcribe any text or handwriting in the "
        "image, then describe what it shows in one or two sentences. "
        + _RULES
        + " If the picture is only a logo, icon, or decoration, reply exactly NONE."
    ),
}


class VisionPageReader:
    """A ``PageReader`` backed by one image-capable model route.

    ``usage`` returns the request's usage-budget context; it is called once,
    just before the first provider call, so files that never need a vision
    pass never open a metered request.
    """

    def __init__(
        self,
        *,
        model: ModelConfig,
        route: ModelGatewayRoute,
        usage: Callable[[], Any],
        client: Any | None = None,
        max_pages: int = DEFAULT_MAX_PAGES,
        concurrency: int = DEFAULT_CONCURRENCY,
    ) -> None:
        self.model = model
        self.route = route
        self.concurrency = max(1, concurrency)
        self.max_pages = max(0, max_pages)
        self.pages_read = 0
        self.failures = 0
        self.skipped_for_budget = 0
        self.problem: str | None = None
        self._usage = usage
        self._usage_context: Any | None = None
        self._client = client
        self._claimed = 0
        self._consecutive_failures = 0
        self._lock = Lock()

    @property
    def model_name(self) -> str:
        return self.model.name

    def read_page(self, image: Any, *, mode: str, label: str) -> str | None:
        if not self._claim():
            return None
        usage_context = self._usage_for_call()
        if usage_context is None:
            return None
        try:
            payload = self._complete(image, mode=mode, label=label, usage_context=usage_context)
        except UsageBudgetError:
            self._stop("Reading handwriting and images stopped: the usage budget is used up.")
            return None
        except ModelGatewayAuthError as exc:
            self._stop(f"{self.route.provider_name} rejected its key (HTTP {exc.status_code}).")
            return None
        except (ModelGatewayError, ModelGatewayConfigurationError) as exc:
            self._record_failure(exc)
            return None
        except Exception as exc:  # unexpected: count it and say so, never hide it
            logger.warning("Vision page read raised unexpectedly", exc_info=True)
            self._record_failure(exc)
            return None
        text = _answer_text(payload)
        with self._lock:
            self._consecutive_failures = 0
            self.pages_read += 1
        return "" if _NONE_ANSWER.fullmatch(text) else text

    def _complete(self, image: Any, *, mode: str, label: str, usage_context: Any) -> Any:
        """One metered provider call; the completion is settled before it is used."""
        payload = (self._client or get_model_gateway_client()).complete(
            route=self.route,
            messages=_messages(image, mode=mode, label=label),
            max_tokens=REASONING_MAX_TOKENS if self._reasoning else PLAIN_MAX_TOKENS,
            options=self._options(),
        )
        with self._lock:
            usage_context.settle_provider_child(
                completion_id=new_accounting_id(),
                usage=payload.get("usage") if isinstance(payload, dict) else None,
                attribution=ProviderUsageAttribution(
                    model_id=self.model.id,
                    provider_name=self.route.provider_name,
                    surface=USAGE_SURFACE,
                    message_count=1,
                ),
            )
        return payload

    @property
    def _reasoning(self) -> bool:
        return supports_reasoning_effort(self.route.upstream_model, self.route.supported_parameters)

    def _options(self) -> dict[str, Any]:
        # Reasoning models reject sampling knobs, so they keep their defaults.
        if self._reasoning:
            return {}
        options: dict[str, Any] = {"temperature": 0}
        if self.route.provider_kind.strip().lower() == "openrouter" and is_gemini_flash_upstream(
            self.route.upstream_model
        ):
            # Transcription needs no long thinking; Gemini 3+ still requires some.
            options["reasoning"] = {"effort": "minimal"}
        return options

    def _claim(self) -> bool:
        with self._lock:
            if self.problem is not None:
                return False
            if self._claimed >= self.max_pages:
                self.skipped_for_budget += 1
                return False
            self._claimed += 1
            return True

    def _usage_for_call(self) -> Any | None:
        """The metered request to settle against, or None when it was refused."""
        with self._lock:
            if self._usage_context is not None:
                return self._usage_context
            try:
                self._usage_context = self._usage()
            except Exception as exc:  # budget, tenant scope, or accounting outage
                detail = getattr(exc, "detail", None) or str(exc)
                self.problem = self.problem or (
                    f"Reading handwriting and images was skipped: {detail}"
                )
                return None
            return self._usage_context

    def _record_failure(self, exc: Exception) -> None:
        with self._lock:
            self.failures += 1
            self._consecutive_failures += 1
            stop = self._consecutive_failures >= MAX_CONSECUTIVE_FAILURES
        logger.info("Vision page read failed (%s): %s", self.route.provider_name, exc)
        if stop:
            self._stop(f"{self.route.provider_name} could not read pages: {exc}")

    def _stop(self, problem: str) -> None:
        with self._lock:
            self.problem = self.problem or problem


def rank_vision_models(
    models: Iterable[ModelConfig],
    *,
    tenant_id: str | None,
    preferred: str | None = None,
) -> list[ModelConfig]:
    """Image-capable chat models this tenant may use, best page reader first.

    A model pinned by the operator wins; then Gemini Flash (newest first, full
    before lite), then Gemini Pro, then every other vision model.
    """

    pinned = (preferred or "").strip().lower()
    usable = [model for model in models if _usable_vision_model(model, tenant_id)]

    def rank(model: ModelConfig) -> tuple[Any, ...]:
        upstream = (model.upstream_model_id or "").lower()
        is_pinned = bool(pinned) and pinned in {upstream, model.id.lower()}
        if is_gemini_flash_upstream(upstream):
            family = 3
        elif is_gemini_pro_upstream(upstream):
            family = 2
        else:
            family = 1
        return (is_pinned, family, *(_gemini_flash_rank(model) if family > 1 else ()))

    return sorted(usable, key=rank, reverse=True)


def resolve_vision_model(
    store: Any, *, tenant_id: str | None, preferred: str | None = None
) -> tuple[ModelConfig, ModelGatewayRoute] | None:
    """The best vision model with a working credential for this tenant."""

    for model in rank_vision_models(store.models.values(), tenant_id=tenant_id, preferred=preferred):
        try:
            route = resolve_model_route(store, model, tenant_id=tenant_id)
        except ModelGatewayConfigurationError:
            continue
        if route.configured:
            return model, route
    return None


def _usable_vision_model(model: ModelConfig, tenant_id: str | None) -> bool:
    return _available_to_tenant(model, tenant_id) and _reads_images(model)


def _available_to_tenant(model: ModelConfig, tenant_id: str | None) -> bool:
    """Enabled, not restricted, not an agent profile, and in scope for the tenant."""
    return (
        model.platform_enabled
        and not model.tenant_restricted
        and not model.is_custom
        and model.tenant_id in (None, tenant_id)
    )


def _reads_images(model: ModelConfig) -> bool:
    """A chat model that accepts images and answers in text."""
    capabilities = model.capabilities
    if capabilities is not None and "image" in capabilities.output_modalities:
        return False
    tail = (model.upstream_model_id or "").lower().rsplit("/", 1)[-1]
    if not tail or _IMAGE_OUTPUT_ID.search(tail) or ":batch" in tail:
        return False
    return supports_image_input(
        model.upstream_model_id, capabilities.input_modalities if capabilities else ()
    )


def _messages(image: Any, *, mode: str, label: str) -> list[dict[str, Any]]:
    prompt = _PROMPTS.get(mode, _PROMPTS["full"])
    return [
        {"role": "system", "content": prompt},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": f"{label}. Follow the instructions exactly."},
                {"type": "image_url", "image_url": {"url": _jpeg_data_url(image)}},
            ],
        },
    ]


def _fit(image: Any) -> Any:
    """An RGB copy no larger than ``MAX_IMAGE_EDGE_PX`` on its long edge."""

    prepared = image.convert("RGB")
    if prepared is image:
        prepared = image.copy()
    prepared.thumbnail((MAX_IMAGE_EDGE_PX, MAX_IMAGE_EDGE_PX))
    return prepared


def _jpeg_data_url(image: Any) -> str:
    prepared = _fit(image)
    try:
        buffer = BytesIO()
        prepared.save(buffer, format="JPEG", quality=JPEG_QUALITY)
    finally:
        prepared.close()
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _answer_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    message = ((payload.get("choices") or [{}])[0] or {}).get("message") or {}
    content = message.get("content")
    if isinstance(content, list):
        content = "".join(
            str(part.get("text") or "") for part in content if isinstance(part, dict)
        )
    return content.strip() if isinstance(content, str) else ""
