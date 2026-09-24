import { apiRequest, pathId, type ApiMutationOptions } from "./http";
import type { Automation, AutomationRunResult, AutomationSchedulePreview } from "../types";

export type AutomationSavePayload = {
  id?: string | null;
  name: string;
  surface: "chat" | "draft";
  trigger_type: "once" | "daily" | "weekly" | "cron";
  run_at?: string | null;
  weekly_day?: string | null;
  time_of_day?: string | null;
  cron_expression?: string | null;
  timezone?: string | null;
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
 * for this run only (used by the chat ">" shortcut). `payload.deliver` saves
 * the result as a new chat or draft, like a scheduled run (console Run now). */
export function runAutomation(
  userId: string,
  automationId: string,
  payload: { input?: string; deliver?: boolean } = {},
  options: ApiMutationOptions = {},
): Promise<AutomationRunResult> {
  const body = {
    ...(payload.input ? { input: payload.input } : {}),
    ...(payload.deliver ? { deliver: true } : {}),
  };
  return apiRequest<AutomationRunResult>(userId, `/api/automations/${pathId(automationId)}/run`, {
    method: "POST",
    body: Object.keys(body).length ? body : undefined,
    signal: options.signal,
  });
}

/** Validates a schedule and lists its next runs with the scheduler's own math. */
export function previewAutomationSchedule(
  userId: string,
  schedule: {
    trigger_type: string;
    run_at?: string | null;
    weekly_day?: string | null;
    time_of_day?: string | null;
    cron_expression?: string | null;
    timezone?: string | null;
  },
  options: ApiMutationOptions = {},
): Promise<AutomationSchedulePreview> {
  return apiRequest<AutomationSchedulePreview>(userId, "/api/automations/schedule-preview", {
    method: "POST",
    body: schedule,
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
