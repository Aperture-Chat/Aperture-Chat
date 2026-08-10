#!/usr/bin/env bash
set -euo pipefail

env_file="${APERTURE_DEPLOY_ENV_FILE:-.env.deploy.local}"

if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$env_file"
  set +a
fi

: "${APERTURE_DEPLOY_HOST:?Set APERTURE_DEPLOY_HOST in $env_file}"
: "${APERTURE_DEPLOY_USER:?Set APERTURE_DEPLOY_USER in $env_file}"
: "${APERTURE_DEPLOY_SSH_KEY:?Set APERTURE_DEPLOY_SSH_KEY in $env_file}"

ssh_args=(-i "$APERTURE_DEPLOY_SSH_KEY")

if [[ -n "${APERTURE_DEPLOY_SSH_PORT:-}" ]]; then
  ssh_args+=(-p "$APERTURE_DEPLOY_SSH_PORT")
fi

exec ssh "${ssh_args[@]}" "${APERTURE_DEPLOY_USER}@${APERTURE_DEPLOY_HOST}" "$@"
