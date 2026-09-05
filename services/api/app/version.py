"""Use package metadata for the API's public version."""

import tomllib
from importlib.metadata import version
from pathlib import Path


def _package_version() -> str:
    # Source checkouts and the Docker image retain pyproject.toml. Prefer it
    # over a developer virtualenv's potentially older editable-install metadata.
    project_file = Path(__file__).resolve().parents[1] / "pyproject.toml"
    if project_file.is_file():
        return str(tomllib.loads(project_file.read_text(encoding="utf-8"))["project"]["version"])
    return version("aperture-api")


API_VERSION = _package_version()
# The owner-console updater uses the same installed build identity as OpenAPI.
APP_VERSION = API_VERSION
