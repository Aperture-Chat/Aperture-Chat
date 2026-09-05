#!/usr/bin/env bash
set -euo pipefail

: "${API_IMAGE:?}" "${WEB_IMAGE:?}" "${IMMUTABLE_TAG:?}" "${BRANCH_TAG:?}"
: "${API_EXPECTED_DIGEST:?}" "${WEB_EXPECTED_DIGEST:?}"

digest_from_inspection() {
  local digest
  digest="$(awk '$1 == "Digest:" { print $2; exit }' <<< "$1")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$digest"
}

verify_image() {
  local reference="$1" expected="$2" output digest
  output="$(docker buildx imagetools inspect "$reference")" || return 1
  printf '%s\n' "$output"
  grep -Eq 'Platform:[[:space:]]+linux/amd64([/[:space:]]|$)' <<< "$output" || return 1
  grep -Eq 'Platform:[[:space:]]+linux/arm64([/[:space:]]|$)' <<< "$output" || return 1
  digest="$(digest_from_inspection "$output")" || return 1
  if [[ "$digest" != "$expected" ]]; then
    echo "Unexpected digest for $reference: expected $expected, received $digest." >&2
    return 1
  fi
}

previous_digest() {
  local reference="$1" output
  if output="$(docker buildx imagetools inspect "$reference" 2>&1)"; then
    digest_from_inspection "$output"
  # A first publication has no alias. Authentication/network errors must stop
  # publication rather than silently discard the recovery reference.
  elif grep -Eiq 'manifest unknown|name unknown|: not found([[:space:]]|$)' <<< "$output"; then
    printf '\n'
  else
    printf '%s\n' "$output" >&2
    return 1
  fi
}

record() {
  printf '%s\n' "$1"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# No branch alias may move until BOTH images match this run's build digests
# and contain the two supported architectures. Promote by digest so a rerun
# cannot swap a SHA tag between inspection and promotion.
verify_image "${API_IMAGE}:${IMMUTABLE_TAG}" "$API_EXPECTED_DIGEST"
verify_image "${WEB_IMAGE}:${IMMUTABLE_TAG}" "$WEB_EXPECTED_DIGEST"
previous_api="$(previous_digest "${API_IMAGE}:${BRANCH_TAG}")"
previous_web="$(previous_digest "${WEB_IMAGE}:${BRANCH_TAG}")"
record "## Branch alias promotion"
record "Verified API: \`${API_IMAGE}@${API_EXPECTED_DIGEST}\`"
record "Verified web: \`${WEB_IMAGE}@${WEB_EXPECTED_DIGEST}\`"
record "Previous API digest: \`${previous_api:-absent}\`"
record "Previous web digest: \`${previous_web:-absent}\`"

restore_alias() {
  local image="$1" previous="$2" attempted="$3" current output
  if ! output="$(docker buildx imagetools inspect "${image}:${BRANCH_TAG}" 2>&1)"; then
    record "Recovery could not inspect \`${image}:${BRANCH_TAG}\`; check the alias manually."
    return
  fi
  current="$(digest_from_inspection "$output")" || current=""
  if [[ -n "$previous" && "$current" == "$previous" ]]; then
    return
  fi
  if [[ -z "$previous" || "$current" != "$attempted" ]]; then
    # Never delete a new tag's manifest (the SHA tag can share it), or overwrite
    # an alias changed by another publisher after our attempted promotion.
    record "Recovery left \`${image}:${BRANCH_TAG}\` unchanged; inspect it manually before deploying."
  elif docker buildx imagetools create --tag "${image}:${BRANCH_TAG}" "${image}@${previous}" \
    && verify_image "${image}:${BRANCH_TAG}" "$previous"; then
    record "Restored \`${image}:${BRANCH_TAG}\` to \`${previous}\`."
  else
    record "Recovery failed for \`${image}:${BRANCH_TAG}\`; restore the recorded previous digest manually."
  fi
}

rollback_on_failure() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )); then
    record "Branch promotion failed. Alias updates are not atomic; do not deploy the moving tags until both are verified."
    restore_alias "$API_IMAGE" "$previous_api" "$API_EXPECTED_DIGEST"
    restore_alias "$WEB_IMAGE" "$previous_web" "$WEB_EXPECTED_DIGEST"
  fi
  exit "$status"
}

trap rollback_on_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker buildx imagetools create --tag "${API_IMAGE}:${BRANCH_TAG}" "${API_IMAGE}@${API_EXPECTED_DIGEST}"
docker buildx imagetools create --tag "${WEB_IMAGE}:${BRANCH_TAG}" "${WEB_IMAGE}@${WEB_EXPECTED_DIGEST}"
verify_image "${API_IMAGE}:${BRANCH_TAG}" "$API_EXPECTED_DIGEST"
verify_image "${WEB_IMAGE}:${BRANCH_TAG}" "$WEB_EXPECTED_DIGEST"
record "Both branch aliases match the verified image pair. Use the recorded digests for reproducible deployments."
