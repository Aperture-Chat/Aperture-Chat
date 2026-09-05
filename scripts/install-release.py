#!/usr/bin/env python3
"""Prepare a private, update-enabled deployment from a reviewed release bundle."""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys

BUNDLE = Path(__file__).resolve().parents[1]
FILES = ("docker-compose.release.yml", "infra/updater/updater.sh", "infra/caddy/Caddyfile")


def prepare(directory: Path, domain: str, tag: str, repository: str, registry: str) -> None:
    # A fresh directory prevents accidental replacement of an existing data stack,
    # project identity, secret, or customized proxy. Existing installs use the runbook.
    if directory.exists():
        raise ValueError("Destination already exists. Use the existing-installation runbook; no files changed.")
    if not re.fullmatch(r"v\d{1,6}\.\d{1,6}\.\d{1,6}", tag):
        raise ValueError("Choose a published vX.Y.Z release tag.")
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", domain) or "." not in domain:
        raise ValueError("Provide a public DNS hostname without a scheme, port, or path.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Repository must be an organization/repository pair.")
    if not re.fullmatch(r"[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9_./-]+", registry):
        raise ValueError("Registry must be a lowercase registry/namespace path.")
    for name in (*FILES, ".env.example"):
        if not (BUNDLE / name).is_file():
            raise ValueError("Incomplete bundle. Extract the complete reviewed Docker release bundle first.")
    directory.mkdir(parents=True, mode=0o700)
    directory.chmod(0o700)
    for name in FILES:
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(BUNDLE / name, target)
    overrides = {
        "APERTURE_SECRET_KEY": secrets.token_urlsafe(64),
        "APERTURE_IMAGE_TAG": tag,
        "APERTURE_IMAGE_REGISTRY": registry,
        "APERTURE_PLATFORM_UPDATE_REPOSITORY": repository,
        "APERTURE_PLATFORM_UPDATE_RELEASES_URL": "",
        "APERTURE_CADDY_SITE_ADDRESS": domain,
        "APERTURE_WEB_ORIGINS": f"https://{domain}",
        "APERTURE_SEED_PLATFORM_OWNER_ENABLED": "false",
        "APERTURE_SEED_DEMO_DATA_ENABLED": "false",
        "APERTURE_DEV_HEADER_AUTH_ENABLED": "false",
        # Distinct, durable project identity also fixes the data-volume namespace.
        "COMPOSE_PROJECT_NAME": "aperture-" + secrets.token_hex(6),
    }
    lines = []
    for line in (BUNDLE / ".env.example").read_text().splitlines():
        key = line.partition("=")[0]
        if key in overrides:
            continue
        lines.append(line)
    lines.extend(f"{key}={value}" for key, value in overrides.items())
    env = directory / ".env"
    # Exclusive creation with private permissions before writing the secret.
    import os
    fd = os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write("\n".join(lines) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True, help="New private deployment directory")
    parser.add_argument("--domain", required=True, help="DNS hostname pointing at this VPS")
    parser.add_argument("--tag", required=True, help="Reviewed published vX.Y.Z tag with updater support")
    parser.add_argument("--repository", default="Aperture-Chat/Aperture-Chat")
    parser.add_argument("--registry", default="ghcr.io/aperture-chat")
    parser.add_argument("--start", action="store_true", help="Pull and start the prepared stack with Docker Compose")
    args = parser.parse_args()
    try:
        if args.start:
            subprocess.run(["docker", "compose", "version"], check=True, capture_output=True)
        directory = args.directory.expanduser().resolve()
        prepare(directory, args.domain, args.tag, args.repository, args.registry)
        print("Prepared private configuration with a generated secret and updater enabled.")
        print("Keep this directory: its project identity and volumes belong to this installation.")
        if args.start:
            import os
            env = dict(os.environ, PWD=str(directory))
            # Avoid shell overrides selecting another image or Compose project.
            for key in tuple(env):
                if key.startswith(("APERTURE_", "COMPOSE_")):
                    env.pop(key)
            compose = ["docker", "compose", "--env-file", ".env", "-f", "docker-compose.release.yml", "--profile", "vps"]
            subprocess.run(compose + ["config", "--quiet"], cwd=directory, env=env, check=True)
            subprocess.run(compose + ["pull"], cwd=directory, env=env, check=True)
            subprocess.run(compose + ["up", "-d", "--wait", "--wait-timeout", "300"], cwd=directory, env=env, check=True)
            print("Containers are ready. Complete the first-owner setup in your browser immediately.")
        else:
            print("From the prepared directory, run: docker compose -f docker-compose.release.yml --profile vps up -d --wait")
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"Installation stopped: {exc}", file=sys.stderr)
        print("Any prepared files are retained for inspection. No volumes were deleted.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
