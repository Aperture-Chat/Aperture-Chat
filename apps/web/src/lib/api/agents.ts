import { apiRequest, pathId, type ApiMutationOptions } from "./http";
import type { AgentRun } from "../types";

export type AgentRunAction = "approve" | "reject" | "pause" | "resume" | "schedule" | "export";

export function updateAgentRun(
  userId: string,
  runId: string,
  action: AgentRunAction,
  options: ApiMutationOptions = {},
): Promise<AgentRun> {
  return apiRequest<AgentRun>(userId, `/api/agents/runs/${pathId(runId)}/${action}`, {
    method: "POST",
    signal: options.signal,
  });
}

export function approveAgentRun(userId: string, runId: string, options: ApiMutationOptions = {}): Promise<AgentRun> {
  return updateAgentRun(userId, runId, "approve", options);
}
