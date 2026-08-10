import { apiRequest, pathId, type ApiMutationOptions } from "./http";
import type { Automation, AutomationRunResult } from "../types";

export type AutomationSavePayload = {
  id?: string | null;
  name: string;
  surface: "chat" | "draft";
  trigger_type: "once" | "daily" | "weekly" | "cron";
  run_at?: string | null;
  weekly_day?: string | null;
  time_of_day?: string | null;
  cron_expression?: string | null;
  prompt: string;
  steps: Array<{ model_id: string; instruction: string }>;
  enabled: boolean;
};

export function createAutomation(
  userId: string,
  payload: AutomationSavePayload,
  options: ApiMutationOptions = {},
): Promise<Automation> {
  return apiRequest<Automation>(userId, "/api/automations", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAutomation(
  userId: string,
  automationId: string,
  payload: Partial<AutomationSavePayload>,
  options: ApiMutationOptions = {},
): Promise<Automation> {
  return apiRequest<Automation>(userId, `/api/automations/${pathId(automationId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAutomation(
  userId: string,
  automationId: string,
  options: ApiMutationOptions = {},
): Promise<void> {
  return apiRequest<void>(userId, `/api/automations/${pathId(automationId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

/** Executes an automation's model chain immediately and returns the transcript.
 * `payload.input` replaces the stored prompt as the chain's first-step input
 * for this run only (used by the chat ">" shortcut). */
export function runAutomation(
  userId: string,
  automationId: string,
  payload: { input?: string } = {},
  options: ApiMutationOptions = {},
): Promise<AutomationRunResult> {
  return apiRequest<AutomationRunResult>(userId, `/api/automations/${pathId(automationId)}/run`, {
    method: "POST",
    body: payload.input ? { input: payload.input } : undefined,
    signal: options.signal,
  });
}

/** Fetches the Google OAuth consent URL for a connector config (admin-authenticated). */
export function connectorOAuthStartUrl(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<{ url: string }> {
  return apiRequest<{ url: string }>(userId, `/api/admin/connector-configs/${pathId(configId)}/oauth/authorize-url`, {
    signal: options.signal,
  });
}
