FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FASTEMBED_CACHE_PATH=/opt/aperture-models

# Mirror the repository layout. app/core/config.py resolves the repo root as
# Path(__file__).parents[4] (services/api/app/core/config.py -> repo root), so
# the app package must sit exactly four directories deep or startup fails.
# This also keeps the default runtime-state and vector-db paths pointing at
# services/api/data, the directory compose mounts as a volume.
WORKDIR /srv/aperture/services/api

# Local OCR keeps uploaded legal documents inside the Aperture deployment.
# Tesseract handles scanned images while pypdfium2 (installed below) renders
# image-only PDF pages for OCR.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        tesseract-ocr \
        tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

# Runtime dependencies only; dev extras (pytest, ruff) stay out of the image.
COPY services/api/pyproject.toml ./pyproject.toml
COPY services/api/app ./app
COPY services/api/alembic.ini ./alembic.ini
COPY services/api/alembic ./alembic
RUN pip install --no-cache-dir .

# Bundled free stdio MCP server (paper-search-mcp: arXiv, PubMed, bioRxiv,
# Crossref, OpenAlex, … — no API keys) so a real MCP connection can be
# configured and exercised without an external host. The dedicated wrapper
# executable exists so APERTURE_MCP_ALLOWED_COMMANDS can allowlist exactly
# this server rather than a general python interpreter.
# mcp is pinned <2: paper-search-mcp imports mcp.server.fastmcp, which the
# 2.0 SDK removed. Nothing in Aperture itself imports the mcp package.
RUN pip install --no-cache-dir "paper-search-mcp==0.1.4" "mcp[cli]>=1.6.0,<2" \
    && pip check \
    && printf '#!/bin/sh\nexec python -m paper_search_mcp.server "$@"\n' \
        > /usr/local/bin/paper-search-mcp-server \
    && chmod +x /usr/local/bin/paper-search-mcp-server

# Download the compact retrieval model during the image build so uploaded
# content is embedded locally at runtime without reaching an external service.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='BAAI/bge-small-en-v1.5', cache_dir='/opt/aperture-models')"

# Persisted state: runtime_state.json, aperture.sqlite3,
# knowledge_vectors.sqlite3, and the auto-generated local signing secret all
# live here.
RUN mkdir -p data

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
