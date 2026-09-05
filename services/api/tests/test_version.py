import json
from pathlib import Path

from app.core.config import Settings
from app.core.platform_updates import current_version
from app.main import app
from app.version import API_VERSION, APP_VERSION


def test_api_version_matches_repository_release() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    release = json.loads((repository_root / "package.json").read_text(encoding="utf-8"))
    web = json.loads((repository_root / "apps/web/package.json").read_text(encoding="utf-8"))
    lock = json.loads((repository_root / "package-lock.json").read_text(encoding="utf-8"))
    assert release["version"] == web["version"] == lock["version"]
    assert lock["packages"][""]["version"] == release["version"]
    assert lock["packages"]["apps/web"]["version"] == release["version"]
    assert API_VERSION == release["version"]
    assert APP_VERSION == API_VERSION
    assert current_version(Settings(release_version="0.0.0")) == f"v{API_VERSION}"
    assert app.version == API_VERSION
    assert app.openapi()["info"]["version"] == API_VERSION
