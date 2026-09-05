import json
from pathlib import Path

from app.main import app
from app.version import API_VERSION, APP_VERSION


def test_api_version_matches_repository_release() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    release = json.loads((repository_root / "package.json").read_text(encoding="utf-8"))
    assert API_VERSION == release["version"]
    assert APP_VERSION == API_VERSION
    assert app.version == API_VERSION
    assert app.openapi()["info"]["version"] == API_VERSION
