"""Boot the real application the way the image does, then report what is on disk.

Run as a script by ``test_rendition_os_wall``, in a process of its own so that it is
not a pytest process: the store uses the real data directory and real databases, the
lifespan runs, and ``APERTURE_ENV=production`` means the conversion is refused unless
the wall really stands.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.knowledge_originals import DocumentRef
from app.main import app
from app.models.schemas import KnowledgeConfig, KnowledgeDocument
from app.repositories.deps import get_store
from app.routes import knowledge
from tests import crafted_documents as crafted

TENANT = "tenant-example"
CONFIG = "knowledge-production-boot"
DOCUMENT = "doc-production-boot"


def main() -> None:
    settings = get_settings()
    with TestClient(app):
        store = get_store()
        config = KnowledgeConfig(
            id=CONFIG, tenant_id=TENANT, name="Boot", source_type="upload", enabled=True
        )
        document = KnowledgeDocument(
            id=DOCUMENT,
            knowledge_config_id=CONFIG,
            tenant_id=TENANT,
            name="boot.docx",
            source_uri="upload://boot.docx",
            source_type="upload",
            updated_at="now",
        )
        store.knowledge_originals.save(
            DocumentRef(TENANT, CONFIG, DOCUMENT),
            crafted.docx("<w:p><w:r><w:t>Production boot words.</w:t></w:r></w:p>"),
        )
        walled = knowledge._prepared_document(config, document, store)
        store.knowledge_originals.delete_document(DocumentRef(TENANT, CONFIG, DOCUMENT))
        store.knowledge_originals.save(
            DocumentRef(TENANT, CONFIG, DOCUMENT),
            crafted.docx("<w:p><w:r><w:t>Second document.</w:t></w:r></w:p>"),
        )
        data = Path(settings.runtime_state_path).parent
        data.chmod(0o755)
        open_wall = knowledge._prepared_document(config, document, store)
        data.chmod(0o700)
        original = store.knowledge_originals.path(DocumentRef(TENANT, CONFIG, DOCUMENT))
        print(
            json.dumps(
                {
                    "environment": settings.environment,
                    "mode": walled.mode,
                    "notice": walled.notice,
                    "pages": walled.page_count,
                    "open_wall_mode": open_wall.mode,
                    "open_wall_notice": open_wall.notice,
                    "umask": _current_umask(),
                    "files": [
                        settings.application_db_path,
                        settings.runtime_state_path,
                        settings.vector_db_path,
                        str(original),
                    ],
                }
            )
        )


def _current_umask() -> int:
    current = os.umask(0)
    os.umask(current)
    return current


if __name__ == "__main__":
    main()
