#!/bin/sh
# Aperture Chat updater sidecar.
#
# Runs as the `updater` service of docker-compose.release.yml on a stock
# docker CLI image. It is the only container that can reach the Docker
# socket; the API never does. The API hands an upgrade request over through
# a shared volume (plain key=value files) and this script:
#
#   1. validates the requested tag against a strict vX.Y.Z pattern,
#   2. pulls the new images first, so a bad tag or registry outage changes
#      nothing,
#   3. records the new tag in the project's .env (APERTURE_IMAGE_TAG) so later
#      manual `docker compose up` runs keep the upgraded version,
#   4. recreates only the API and web services (Compose orders them via
#      depends_on, so web waits for the new API to be healthy),
#   5. verifies both services and restores the recorded images if either fails.
#
# Data volumes are never touched: there is no `down`, no `-v`, no prune.
#
# Protocol files in $APERTURE_UPDATER_STATE_DIR (shared with the API):
#   heartbeat  ts=<unix> ready=0|1 ready_message=… project=…   (written here)
#   request    id=… target_version=… previous_version=… requested_by=… (from API)
#   status     id=… phase=… message=… started_at=… finished_at=…  (written here)
#   log        tail of docker output for the current/last run     (written here)
#
# Only POSIX sh + the docker CLI are required; no jq, bash, or curl.

set -u

STATE_DIR="${APERTURE_UPDATER_STATE_DIR:-/state}"
POLL_SECONDS="${APERTURE_UPDATER_POLL_SECONDS:-5}"
HEALTH_TIMEOUT="${APERTURE_UPDATER_HEALTH_TIMEOUT_SECONDS:-300}"
SERVICES="${APERTURE_UPDATER_SERVICES:-api web}"
HEALTH_SERVICE="${APERTURE_UPDATER_HEALTH_SERVICE:-api}"
READINESS_RECHECK_SECONDS=60
LOG_KEEP_BYTES=65536

PROJECT=""
WORKDIR=""
CONFIG_FILES=""
ENV_FILE=""
READY=0
READY_MESSAGE="starting"
last_readiness_check=0

RUN_ID=""
TARGET=""
PREVIOUS=""
REQUESTED_BY=""
STARTED_AT=""
ROLLBACK_TAG=""
ROLLBACK_FILE=""
COMPOSE_OVERRIDE=""
PRIVATE_DIR=""
HEARTBEAT_PID=""

log() {
  printf '%s updater: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

run_log() {
  printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$STATE_DIR/log"
}

sanitize() {
  printf '%s' "$1" | tr '\r\n' '  ' | cut -c1-1900
}

atomic_write() {
  # $1 = destination, stdin = content
  tmp="$1.tmp.$$"
  cat > "$tmp" && mv -f "$tmp" "$1"
}

kv() {
  # $1 = file, $2 = key -> value (last occurrence wins)
  grep "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2-
}

is_release_tag() {
  printf '%s' "$1" | grep -Eq '^v[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'
}

is_safe_id() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$'
}

write_heartbeat() {
  {
    printf 'ts=%s\n' "$(date +%s)"
    printf 'ready=%s\n' "$READY"
    printf 'ready_message=%s\n' "$(sanitize "$READY_MESSAGE")"
    printf 'project=%s\n' "$PROJECT"
    printf 'updater_version=1\n'
  } | atomic_write "$STATE_DIR/heartbeat"
}

write_status() {
  # $1 = phase, $2 = message, $3 = "final" to stamp finished_at
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  {
    printf 'id=%s\n' "$RUN_ID"
    printf 'phase=%s\n' "$1"
    printf 'target_version=%s\n' "$TARGET"
    printf 'previous_version=%s\n' "$PREVIOUS"
    printf 'requested_by=%s\n' "$(sanitize "$REQUESTED_BY")"
    printf 'message=%s\n' "$(sanitize "$2")"
    printf 'started_at=%s\n' "$STARTED_AT"
    printf 'updated_at=%s\n' "$now"
    if [ "${3:-}" = "final" ]; then
      printf 'finished_at=%s\n' "$now"
    fi
  } | atomic_write "$STATE_DIR/status" || return 1
  log "[$RUN_ID] $1: $2"
  run_log "$1: $2"
}

# --- Compose project discovery ---------------------------------------------

self_container_id() {
  if [ -n "${APERTURE_UPDATER_CONTAINER_ID:-}" ]; then
    printf '%s' "$APERTURE_UPDATER_CONTAINER_ID"
    return
  fi
  id="$(hostname 2>/dev/null)"
  if docker inspect --format '{{.Id}}' "$id" >/dev/null 2>&1; then
    printf '%s' "$id"
    return
  fi
  # Fallback for a custom hostname: the container id is part of the path of
  # the files Docker bind-mounts into every container.
  sed -n 's#.*/containers/\([0-9a-f]\{64\}\)/hostname.*#\1#p' /proc/self/mountinfo 2>/dev/null | head -n 1
}

container_label() {
  docker inspect --format "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null
}

compose() {
  # COMPOSE_FILE takes the ':'-separated list; the profiles of explicitly
  # named services are enabled automatically by Compose.
  COMPOSE_FILE="$(printf '%s' "$CONFIG_FILES" | tr ',' ':')${COMPOSE_OVERRIDE:+:$COMPOSE_OVERRIDE}" \
  COMPOSE_PROJECT_NAME="$PROJECT" \
  COMPOSE_IGNORE_ORPHANS=1 \
    docker compose --project-directory "$WORKDIR" --env-file "$ENV_FILE" "$@"
}

with_heartbeat() {
  # Image pulls and container recreation can take longer than the API's
  # heartbeat window. Keep reporting while the real command is still running.
  (
    trap 'exit 0' TERM INT
    while :; do
      write_heartbeat
      sleep "$POLL_SECONDS" &
      wait $!
    done
  ) &
  HEARTBEAT_PID=$!
  "$@"
  command_result=$?
  kill "$HEARTBEAT_PID" 2>/dev/null || true
  wait "$HEARTBEAT_PID" 2>/dev/null || true
  HEARTBEAT_PID=""
  return "$command_result"
}

check_readiness() {
  last_readiness_check="$(date +%s)"
  if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    READY=0
    READY_MESSAGE="The Docker socket is not reachable from the updater container."
    return
  fi
  self="$(self_container_id)"
  if [ -z "$self" ]; then
    READY=0
    READY_MESSAGE="The updater could not identify its own container."
    return
  fi
  PROJECT="${APERTURE_UPDATER_PROJECT:-$(container_label "$self" com.docker.compose.project)}"
  WORKDIR="${APERTURE_UPDATER_PROJECT_DIR:-$(container_label "$self" com.docker.compose.project.working_dir)}"
  CONFIG_FILES="${APERTURE_UPDATER_CONFIG_FILES:-$(container_label "$self" com.docker.compose.project.config_files)}"
  env_label="$(container_label "$self" com.docker.compose.project.environment_file)"
  if [ -z "$PROJECT" ] || [ -z "$WORKDIR" ] || [ -z "$CONFIG_FILES" ]; then
    READY=0
    READY_MESSAGE="The updater is not running as part of a Compose project."
    return
  fi
  if [ ! -d "$WORKDIR" ]; then
    READY=0
    READY_MESSAGE="The project directory $WORKDIR is not mounted into the updater; start the stack from the project directory so \${PWD} resolves."
    return
  fi
  old_ifs="$IFS"
  IFS=','
  for file in $CONFIG_FILES; do
    if [ ! -f "$file" ]; then
      IFS="$old_ifs"
      READY=0
      READY_MESSAGE="Compose file $file is not visible inside the updater container."
      return
    fi
  done
  IFS="$old_ifs"
  case "$env_label" in
    "") ENV_FILE="$WORKDIR/.env" ;;
    *,*)
      READY=0
      READY_MESSAGE="This project uses multiple environment files. Upgrade it with the operator's Compose command so every override is preserved."
      return
      ;;
    *) ENV_FILE="$env_label" ;;
  esac
  if [ ! -f "$ENV_FILE" ]; then
    READY=0
    READY_MESSAGE="The project .env file ($ENV_FILE) was not found; APERTURE_IMAGE_TAG must live there."
    return
  fi
  if [ ! -w "$ENV_FILE" ]; then
    READY=0
    READY_MESSAGE="The project .env file ($ENV_FILE) is not writable by the updater."
    return
  fi
  if ! compose config --services >/dev/null 2>"$STATE_DIR/.config-error"; then
    READY=0
    READY_MESSAGE="Compose rejected the project configuration: $(sanitize "$(head -c 400 "$STATE_DIR/.config-error")")"
    return
  fi
  READY=1
  READY_MESSAGE="ready"
}

# --- Upgrade steps ----------------------------------------------------------

current_env_tag() {
  value="$(kv "$ENV_FILE" APERTURE_IMAGE_TAG)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

set_env_tag() {
  # Compose mounts the project directory, so a same-directory rename is
  # atomic. Preserve the operator's owner/mode and never truncate a live .env
  # when a disk write fails. Temporary secret material stays off the shared
  # API/updater state volume.
  tag="$1"
  tmp="$(mktemp "${ENV_FILE}.aperture-updater.XXXXXX")" || return 1
  if ! cp -p "$ENV_FILE" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if grep -q '^APERTURE_IMAGE_TAG=' "$ENV_FILE"; then
    sed "s/^APERTURE_IMAGE_TAG=.*/APERTURE_IMAGE_TAG=$tag/" "$ENV_FILE" > "$tmp" || {
      rm -f "$tmp"; return 1;
    }
  else
    printf '\nAPERTURE_IMAGE_TAG=%s\n' "$tag" >> "$tmp" || {
      rm -f "$tmp"; return 1;
    }
  fi
  mv -f "$tmp" "$ENV_FILE" || { rm -f "$tmp"; return 1; }
}

snapshot_previous_images() {
  # Moving branch tags may no longer name the running image after a pull.
  # Keep the actual local image IDs for rollback, independently of those tags.
  # This override stays private to the sidecar, not in the API-writable volume.
  PRIVATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aperture-updater.XXXXXX")" || return 1
  ROLLBACK_FILE="$PRIVATE_DIR/rollback.yml"
  printf 'services:\n' > "$ROLLBACK_FILE" || return 1
  for service in $SERVICES; do
    printf '%s' "$service" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$' || return 1
    previous_cid="$(compose ps -q "$service" 2>/dev/null | head -n 1)"
    [ -n "$previous_cid" ] || return 1
    previous_image="$(docker inspect --format '{{.Image}}' "$previous_cid" 2>/dev/null)" || return 1
    printf '%s' "$previous_image" | grep -Eq '^sha256:[0-9a-f]{64}$' || return 1
    printf '  %s:\n    image: "%s"\n    pull_policy: never\n' "$service" "$previous_image" >> "$ROLLBACK_FILE" || return 1
  done
}

cleanup_private_files() {
  if [ -n "$PRIVATE_DIR" ]; then
    rm -f "$ROLLBACK_FILE"
    rmdir "$PRIVATE_DIR" 2>/dev/null || true
  fi
  PRIVATE_DIR=""
  ROLLBACK_FILE=""
  COMPOSE_OVERRIDE=""
}

service_health() {
  cid="$(compose ps -q "$1" 2>/dev/null | head -n 1)"
  if [ -z "$cid" ]; then
    printf 'missing'
    return
  fi
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || printf 'unknown'
}

wait_healthy() {
  # $1 = service, $2 = timeout seconds
  deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    write_heartbeat
    state="$(service_health "$1")"
    case "$state" in
      healthy) return 0 ;;
      # Both release services define checks. A running process with its check
      # missing is not evidence that either HTTP service is ready.
      running) return 1 ;;
      unhealthy|exited|dead) return 1 ;;
    esac
    sleep 3
  done
  return 1
}

wait_services_healthy() {
  wait_healthy "$HEALTH_SERVICE" "$HEALTH_TIMEOUT" || return 1
  for service in $SERVICES; do
    [ "$service" = "$HEALTH_SERVICE" ] && continue
    wait_healthy "$service" "$HEALTH_TIMEOUT" || return 1
  done
}

compose_up() {
  # shellcheck disable=SC2086
  with_heartbeat compose up -d --no-build $SERVICES >> "$STATE_DIR/log" 2>&1
}

rollback() {
  reason="$1"
  if [ -z "$ROLLBACK_TAG" ] || [ ! -s "$ROLLBACK_FILE" ]; then
    write_status failed "$reason, and no previous APERTURE_IMAGE_TAG is known to roll back to. Manual attention required." final
    return
  fi
  write_status applying "$reason; rolling back to $ROLLBACK_TAG."
  if ! set_env_tag "$ROLLBACK_TAG"; then
    write_status failed "$reason, and the previous image tag could not be restored in the environment file. Manual attention required." final
    return
  fi
  COMPOSE_OVERRIDE="$ROLLBACK_FILE"
  if compose_up && wait_services_healthy; then
    write_status rolled_back "$reason. Rolled back to $ROLLBACK_TAG; the deployment is healthy on the previous version." final
  else
    write_status failed "$reason, and rollback to $ROLLBACK_TAG did not become healthy. Manual attention required." final
  fi
  COMPOSE_OVERRIDE=""
}

trim_log() {
  if [ -f "$STATE_DIR/log" ]; then
    tail -c "$LOG_KEEP_BYTES" "$STATE_DIR/log" | atomic_write "$STATE_DIR/log"
  fi
}

handle_request() {
  request="$STATE_DIR/request"
  [ -f "$request" ] || return 0

  RUN_ID="$(kv "$request" id)"
  TARGET="$(kv "$request" target_version)"
  PREVIOUS="$(kv "$request" previous_version)"
  REQUESTED_BY="$(kv "$request" requested_by)"
  STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  : > "$STATE_DIR/log"

  if ! is_safe_id "$RUN_ID"; then
    RUN_ID="invalid"
    TARGET=""
    PREVIOUS=""
    write_status failed "The upgrade request was malformed and has been discarded." final
    rm -f "$request"
    return
  fi
  if ! is_release_tag "$TARGET"; then
    TARGET=""
    write_status failed "The requested version is not a vX.Y.Z release tag; request discarded." final
    rm -f "$request"
    return
  fi
  is_release_tag "$PREVIOUS" || PREVIOUS=""

  # The API treats either a pending request or an active status as busy.
  # Publish the acknowledgement before removing the request, leaving no idle
  # gap in which a second owner request could overwrite the first one.
  write_status accepted "Preparing the upgrade to $TARGET." || return 1
  if ! rm -f "$request"; then
    write_status failed "The request could not be claimed. The running services were not changed." final
    return
  fi

  check_readiness
  write_heartbeat
  if [ "$READY" != "1" ]; then
    write_status failed "$READY_MESSAGE" final
    return
  fi

  ROLLBACK_TAG="$(current_env_tag)"
  if ! printf '%s' "$ROLLBACK_TAG" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'; then
    write_status failed "Save the currently deployed APERTURE_IMAGE_TAG in the project environment file before upgrading. The deployment was not changed." final
    return
  fi
  if [ "$ROLLBACK_TAG" = "$TARGET" ]; then
    write_status failed "APERTURE_IMAGE_TAG is already $TARGET; nothing to do." final
    return
  fi

  cleanup_private_files
  if ! snapshot_previous_images; then
    write_status failed "The running API and web images could not be recorded for rollback. The deployment was not changed." final
    cleanup_private_files
    return
  fi

  write_status pulling "Pulling the $TARGET images. Nothing changes until the pull succeeds."
  # shellcheck disable=SC2086
  if ! APERTURE_IMAGE_TAG="$TARGET" with_heartbeat compose pull $SERVICES >> "$STATE_DIR/log" 2>&1; then
    write_status failed "The $TARGET images could not be pulled. The deployment was not changed." final
    trim_log
    cleanup_private_files
    return
  fi

  write_status applying "Recreating the API and web services on $TARGET. The API restarts now."
  if ! cp -p "$ENV_FILE" "$ENV_FILE.aperture-updater.bak" || ! set_env_tag "$TARGET"; then
    write_status failed "The project environment file could not be saved. The running services were not changed." final
    trim_log
    cleanup_private_files
    return
  fi
  if ! compose_up; then
    rollback "Starting the $TARGET services failed"
    trim_log
    cleanup_private_files
    return
  fi

  write_status verifying "Waiting for the $TARGET API and web services to report healthy."
  if wait_services_healthy; then
    write_status succeeded "Upgrade to $TARGET complete. Reload the browser to load the new web build." final
  else
    rollback "The $TARGET API or web service did not become healthy within ${HEALTH_TIMEOUT}s"
  fi
  trim_log
  cleanup_private_files
}

recover_interrupted_run() {
  # If this container restarted mid-upgrade the status file would claim an
  # upgrade is still running forever; close it out so the owner can retry.
  status="$STATE_DIR/status"
  [ -f "$status" ] || return 0
  case "$(kv "$status" phase)" in
    accepted|pulling|applying|verifying)
      RUN_ID="$(kv "$status" id)"
      TARGET="$(kv "$status" target_version)"
      PREVIOUS="$(kv "$status" previous_version)"
      REQUESTED_BY="$(kv "$status" requested_by)"
      STARTED_AT="$(kv "$status" started_at)"
      write_status failed "The updater restarted while this upgrade was running. Check the services with docker compose ps, then try again." final || return 1
      # A restart can land between acknowledgement and request removal. Do
      # not automatically execute that interrupted request a second time.
      if [ "$(kv "$STATE_DIR/request" id)" = "$RUN_ID" ]; then
        rm -f "$STATE_DIR/request"
      fi
      ;;
  esac
}

# --- Main loop ----------------------------------------------------------------

mkdir -p "$STATE_DIR"
trap 'log "stopping"; exit 0' TERM INT
trap '[ -z "$HEARTBEAT_PID" ] || kill "$HEARTBEAT_PID" 2>/dev/null; cleanup_private_files' EXIT
log "starting; state dir $STATE_DIR; services: $SERVICES"
recover_interrupted_run

while :; do
  now="$(date +%s)"
  if [ $(( now - last_readiness_check )) -ge "$READINESS_RECHECK_SECONDS" ]; then
    previous_ready="$READY"
    check_readiness
    if [ "$READY" != "$previous_ready" ] || [ "$READY" != "1" ]; then
      log "readiness: $READY ($READY_MESSAGE)"
    fi
  fi
  write_heartbeat
  handle_request
  sleep "$POLL_SECONDS" &
  wait $!
done
