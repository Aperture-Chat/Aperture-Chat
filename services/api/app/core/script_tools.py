"""Sandboxed execution for admin-authored custom script tools.

A custom script tool is a Python program that reads text on stdin and writes
its transformed result to stdout. Scripts run in a separate
``python -I`` process with:

- a clean environment (PATH/HOME/TMPDIR plus an isolated artifact directory —
  no platform secrets, provider keys, or signing material reach the child),
- an empty throwaway working directory,
- CPU-time, file-size, open-file, and address-space rlimits,
- a hard wall-clock timeout, and
- capped stdout/stderr so a runaway script cannot flood the API.

When the API runs as root, the child additionally drops to an unprivileged
account so a script cannot read or rewrite the platform database, runtime state
or stored provider-key ciphertext that live on the container filesystem. Env
scrubbing alone never covered those: the secrets that matter are on disk, not in
the environment.

This contains resource abuse, secret exposure and filesystem access. It does
NOT firewall the container network — that limitation is stated verbatim in the
admin UI, never papered over.
"""

from __future__ import annotations

import logging
import os
import pwd
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from app.core.config import get_settings
from app.core.generated_artifacts import (
    GeneratedArtifactError,
    MAX_ARTIFACTS_PER_RUN,
    MAX_ARTIFACT_TOTAL_BYTES,
    persist_generated_artifact,
)
from app.core.sessions import sign_asset_token

MAX_INPUT_CHARS = 200_000
MAX_OUTPUT_CHARS = 100_000
MAX_ERROR_CHARS = 4_000
MIN_TIMEOUT_SECONDS = 1
MAX_TIMEOUT_SECONDS = 30
DEFAULT_TIMEOUT_SECONDS = 10
# Account the child drops to when the API itself runs as root. "nobody" owns
# nothing in this image, so a script gains no read or write access to the
# application database, runtime state, or vector stores.
UNPRIVILEGED_RUN_AS = "nobody"

_LOGGER = logging.getLogger(__name__)


def _unprivileged_ids() -> tuple[int, int] | None:
    """Return the (uid, gid) to drop to, or None to run as the current user.

    Only meaningful when the parent is root: a non-root API process cannot
    change user, and on a developer machine there is nothing to drop from.
    """
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return None
    try:
        entry = pwd.getpwnam(UNPRIVILEGED_RUN_AS)
    except KeyError:
        _LOGGER.warning(
            "Custom script tools are running as root: no %r account in this image.",
            UNPRIVILEGED_RUN_AS,
        )
        return None
    return entry.pw_uid, entry.pw_gid

# The launcher applies rlimits inside the child itself (instead of a
# preexec_fn, which is not safe under a threaded FastAPI server) and then
# hands control to the admin's script.
_LAUNCHER_SOURCE = """\
import resource
import runpy
import sys


def _limit(kind, value):
    try:
        resource.setrlimit(kind, (value, value))
    except (ValueError, OSError):
        pass


_limit(resource.RLIMIT_CPU, int(sys.argv[2]))
_limit(resource.RLIMIT_FSIZE, 64 * 1024 * 1024)
_limit(resource.RLIMIT_NOFILE, 64)
_limit(resource.RLIMIT_AS, 512 * 1024 * 1024)
runpy.run_path(sys.argv[1], run_name="__main__")
"""


@dataclass(frozen=True)
class ScriptRunOutcome:
    status: str  # "ok" | "error" | "timeout"
    output: str
    error: str
    exit_code: int | None
    duration_ms: int
    truncated: bool
    artifacts: tuple["ScriptArtifact", ...] = ()


@dataclass(frozen=True)
class ScriptArtifact:
    filename: str
    mime_type: str
    size_bytes: int
    download_url: str


def clamp_timeout_seconds(value: object) -> int:
    try:
        timeout = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS
    return max(MIN_TIMEOUT_SECONDS, min(MAX_TIMEOUT_SECONDS, timeout))


def validate_custom_script(script: str, timeout_seconds: int) -> None:
    """Reject scripts that cannot run. Raises ValueError with an honest reason."""
    if not script.strip():
        raise ValueError("Script cannot be empty. It reads input from stdin and prints its result.")
    if not MIN_TIMEOUT_SECONDS <= timeout_seconds <= MAX_TIMEOUT_SECONDS:
        raise ValueError(
            f"Timeout must be between {MIN_TIMEOUT_SECONDS} and {MAX_TIMEOUT_SECONDS} seconds."
        )
    try:
        compile(script, "<custom-tool>", "exec")
    except SyntaxError as exc:
        raise ValueError(f"Script has a syntax error on line {exc.lineno}: {exc.msg}") from exc


def run_custom_script(script: str, input_text: str, timeout_seconds: int) -> ScriptRunOutcome:
    timeout_seconds = clamp_timeout_seconds(timeout_seconds)
    input_text = input_text[:MAX_INPUT_CHARS]
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="aperture-tool-") as workdir:
        artifact_dir = Path(workdir) / "artifacts"
        artifact_dir.mkdir()
        launcher_path = Path(workdir) / "launcher.py"
        script_path = Path(workdir) / "tool.py"
        launcher_path.write_text(_LAUNCHER_SOURCE, encoding="utf-8")
        script_path.write_text(script, encoding="utf-8")
        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": workdir,
            "TMPDIR": workdir,
            "LANG": "C.UTF-8",
            "PYTHONIOENCODING": "utf-8",
            "APERTURE_ARTIFACT_DIR": str(artifact_dir),
        }
        run_as = _unprivileged_ids()
        privilege_kwargs: dict[str, object] = {}
        if run_as is not None:
            uid, gid = run_as
            # The scratch tree is created 0700 by root, so hand it to the
            # account the child will become -- otherwise the script cannot even
            # write the artifacts it is invited to produce.
            os.chown(workdir, uid, gid)
            os.chown(artifact_dir, uid, gid)
            for path in (launcher_path, script_path):
                os.chown(path, uid, gid)
            privilege_kwargs = {"user": uid, "group": gid, "extra_groups": []}
        try:
            completed = subprocess.run(
                [sys.executable, "-I", str(launcher_path), str(script_path), str(timeout_seconds)],
                input=input_text,
                capture_output=True,
                text=True,
                timeout=timeout_seconds + 2,
                cwd=workdir,
                env=env,
                **privilege_kwargs,  # type: ignore[arg-type]
            )
        except subprocess.TimeoutExpired:
            duration_ms = int((time.monotonic() - started) * 1000)
            return ScriptRunOutcome(
                status="timeout",
                output="",
                error=f"Script exceeded the {timeout_seconds}s time limit and was stopped.",
                exit_code=None,
                duration_ms=duration_ms,
                truncated=False,
            )
        artifacts: list[ScriptArtifact] = []
        artifact_error = ""
        total_artifact_bytes = 0
        try:
            candidates = sorted(artifact_dir.iterdir()) if completed.returncode == 0 else []
            if len(candidates) > MAX_ARTIFACTS_PER_RUN:
                raise GeneratedArtifactError("Response action produced more than 8 artifacts.")
            settings = get_settings()
            for candidate in candidates:
                if candidate.is_symlink() or not candidate.is_file():
                    raise GeneratedArtifactError("Response action artifacts must be regular files.")
                total_artifact_bytes += candidate.stat().st_size
                if total_artifact_bytes > MAX_ARTIFACT_TOTAL_BYTES:
                    raise GeneratedArtifactError("Response action artifacts exceed 75 MB in total.")
                stored = persist_generated_artifact(candidate)
                token = sign_asset_token(stored.stored_name, settings.secret_key)
                artifacts.append(
                    ScriptArtifact(
                        filename=stored.filename,
                        mime_type=stored.mime_type,
                        size_bytes=stored.size_bytes,
                        download_url=(
                            f"/api/tools/generated-artifacts/{stored.stored_name}"
                            f"?token={quote(token)}&filename={quote(stored.filename)}"
                        ),
                    )
                )
        except (GeneratedArtifactError, OSError) as exc:
            artifact_error = str(exc)
    duration_ms = int((time.monotonic() - started) * 1000)
    output = completed.stdout or ""
    if artifacts:
        if len(artifacts) == 1:
            artifact = artifacts[0]
            kind = "PowerPoint" if artifact.filename.lower().endswith(".pptx") else "file"
            download_message = (
                f"To download your {kind}, copy this link into your browser:\n"
                f"{artifact.download_url}"
            )
        else:
            download_lines = "\n".join(
                f"- {artifact.filename}: {artifact.download_url}" for artifact in artifacts
            )
            download_message = (
                "To download your files, copy the appropriate link into your browser:\n"
                f"{download_lines}"
            )
        output = f"{output.rstrip()}\n\n{download_message}\n"
    truncated = len(output) > MAX_OUTPUT_CHARS
    stderr = completed.stderr or ""
    if artifact_error:
        stderr = f"{stderr}\n{artifact_error}".strip()
    return ScriptRunOutcome(
        status="ok" if completed.returncode == 0 and not artifact_error else "error",
        output=output[:MAX_OUTPUT_CHARS],
        error=stderr[:MAX_ERROR_CHARS],
        exit_code=completed.returncode,
        duration_ms=duration_ms,
        truncated=truncated,
        artifacts=tuple(artifacts),
    )
