FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FASTEMBED_CACHE_PATH=/opt/aperture-models \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Mirror the repository layout. app/core/config.py resolves the repo root as
# Path(__file__).parents[4] (services/api/app/core/config.py -> repo root), so
# the app package must sit exactly four directories deep or startup fails.
# This also keeps the default runtime-state and vector-db paths pointing at
# services/api/data, the directory compose mounts as a volume.
WORKDIR /srv/aperture/services/api

# Local OCR keeps uploaded legal documents inside the Aperture deployment.
# Tesseract handles scanned images while pypdfium2 (installed below) renders
# image-only PDF pages for OCR. ffmpeg extracts speech and stills from
# uploaded audio/video so those files can be transcribed with Gemini Flash
# (the same path used for composer dictation). Videos without an audio track
# still yield visual notes from extracted stills.
# The Drafts PDF export lays pages out in headless Chromium, so a document set
# in Word's usual faces needs them or metric-compatible stand-ins: Liberation
# (Times New Roman, Arial, Courier New), Carlito (Calibri), and Caladea
# (Cambria) keep the same line breaks; Noto Color Emoji and DejaVu cover the
# rest. The app's own faces ship with the API (app/static/pdf-fonts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-crosextra-carlito \
        fonts-crosextra-caladea \
        fonts-noto-color-emoji \
        tesseract-ocr \
        tesseract-ocr-eng \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Chromium's headless shell for the PDF export, in its own layer so code
# changes do not download it again. Keep the version at or above the
# playwright floor in pyproject.toml; pip then leaves it in place below.
ARG PLAYWRIGHT_VERSION=1.64.1
RUN pip install --no-cache-dir "playwright==${PLAYWRIGHT_VERSION}" \
    && python -m playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

# Headless LibreOffice turns Office, RTF, and OpenDocument knowledge files into
# PDFs for the document viewer (app/core/document_rendition.py), and the fonts
# installed above keep their line breaks. The -nogui packages leave out GTK and,
# with --no-install-recommends, Java. This is a layer of its own, about 340 MB,
# so code changes never reinstall it. Every package is a hard dependency, so the
# trim removes what only the interface uses: the gallery, new-document templates,
# wizards, and the Basic libraries behind them.
# The shared extension cache is created here because LibreOffice otherwise builds
# it on first use: one run as root under the API's umask leaves it 0700, and every
# conversion as aperture-render then aborts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-writer-nogui \
        libreoffice-calc-nogui \
        libreoffice-impress-nogui \
    && rm -rf /var/lib/apt/lists/* \
        /usr/lib/libreoffice/share/gallery \
        /usr/lib/libreoffice/share/template \
        /usr/lib/libreoffice/share/wizards \
        /usr/lib/libreoffice/share/basic \
    && install -d -m 755 /var/spool/libreoffice/uno_packages/cache/uno_packages

# LibreOffice and the scan worker run as this account, never as the API's root:
# it owns nothing, belongs to no other group, and cannot enter the 0700 data
# directory or read the API's environment. Numeric ids stay stable across images.
RUN groupadd --gid 10001 aperture-render \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin aperture-render

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
# knowledge_vectors.sqlite3, knowledge_originals/, and the auto-generated local
# signing secret all live here.
RUN mkdir -p data

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
