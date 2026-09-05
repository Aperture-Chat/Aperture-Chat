import { apiRequest, type ApiMutationOptions } from "./http";
import type { PlatformUpdateStatus } from "../types";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStrings(value: Record<string, unknown>, fields: string[]) {
  return fields.every((field) => value[field] == null || typeof value[field] === "string");
}

/** An optional update check must never take down the signed-in workspace if
 * a proxy or an incompatible service returns a different response shape. */
function checkedStatus(value: unknown): PlatformUpdateStatus {
  const phases = ["idle", "requested", "accepted", "pulling", "applying", "verifying", "succeeded", "failed", "rolled_back"];
  if (!record(value) || typeof value.current_version !== "string" ||
      typeof value.update_available !== "boolean" || typeof value.check_enabled !== "boolean" ||
      typeof value.repository !== "string" || typeof value.releases_page_url !== "string" ||
      !optionalStrings(value, ["latest_version", "checked_at", "check_error"]) ||
      !Array.isArray(value.releases) || !value.releases.every((release) => record(release) &&
        ["version", "name", "url", "highlights", "notes"].every((field) => typeof release[field] === "string") &&
        optionalStrings(release, ["published_at"])) ||
      !record(value.updater) || typeof value.updater.configured !== "boolean" ||
      typeof value.updater.connected !== "boolean" || typeof value.updater.log_tail !== "string" ||
      !optionalStrings(value.updater, ["last_heartbeat_at", "project", "problem"]) ||
      !record(value.updater.run) || typeof value.updater.run.message !== "string" ||
      typeof value.updater.run.phase !== "string" || !phases.includes(value.updater.run.phase) ||
      !optionalStrings(value.updater.run, ["id", "target_version", "previous_version", "requested_by", "started_at", "updated_at", "finished_at"])) {
    throw new Error("Platform update status was not recognized. Try checking again later.");
  }
  return value as PlatformUpdateStatus;
}

// Platform-owner-only endpoints; the API answers 403 for every other role.
// Response shapes mirror services/api/app/routes/platform_updates.py.

export function getPlatformUpdateStatus(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<PlatformUpdateStatus> {
  return apiRequest<unknown>(userId, "/api/platform/updates", {
    signal: options.signal,
  }).then(checkedStatus);
}

/** Forces a fresh GitHub release lookup; the API throttles this to once a minute. */
export function checkPlatformUpdates(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<PlatformUpdateStatus> {
  return apiRequest<unknown>(userId, "/api/platform/updates/check", {
    method: "POST",
    signal: options.signal,
  }).then(checkedStatus);
}

/** Hands the upgrade to the updater sidecar; progress arrives through polling. */
export function applyPlatformUpdate(
  userId: string,
  targetVersion: string,
  options: ApiMutationOptions = {},
): Promise<PlatformUpdateStatus> {
  return apiRequest<unknown>(userId, "/api/platform/updates/apply", {
    method: "POST",
    body: { target_version: targetVersion },
    signal: options.signal,
  }).then(checkedStatus);
}
