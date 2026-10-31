/** A Drafts document or deck run, told the way the chat work trace tells a
 * reply. These runs follow a planned list of steps, so the timeline shows the
 * ones reached and names the next one. A planned step is a plan and not a
 * result, so none is a "check", which the trace reports as passed. */

import { traceRunMessage, type TraceKind } from "./workTrace";
import type { ChatActivityTraceStep, ChatMessage } from "./types";

const STEP_KINDS = {
  route: "route",
  context: "context",
  scope: "plan",
  visuals: "image",
  generate: "write",
  revise: "write",
  protect: "plan",
  validator: "plan",
  fit: "plan",
  apply: "write",
  artwork: "image",
  finalize: "save",
} as const satisfies Record<string, TraceKind>;

export type DraftStepId = keyof typeof STEP_KINDS;

export type DraftTraceStep = {
  id: DraftStepId;
  label: string;
  detail: string;
};

export type DraftTraceState = {
  steps: DraftTraceStep[];
  activeIndex: number;
  complete: boolean;
  startedAt: number;
  endedAt?: number;
  /** Why the run stopped short of its plan. */
  failure?: string;
  /** A spreadsheet run records facts as they happen and any thinking the model
   * exposed, in place of the planned steps above. */
  sheetRun?: {
    activity: ChatActivityTraceStep[];
    thinking: string[];
    /** The request it works on; the trace sits under it, as in the chat. */
    requestEventId: string;
  };
};

function plannedActivity(trace: DraftTraceState): ChatActivityTraceStep[] {
  const finished = trace.complete && !trace.failure;
  const reached = finished ? trace.steps : trace.steps.slice(0, trace.activeIndex + 1);
  const activity: ChatActivityTraceStep[] = reached.map((step) => ({
    id: `${STEP_KINDS[step.id]}:${step.id}`,
    label: step.label,
    detail: step.detail,
  }));
  if (trace.failure) activity.push({ id: "flag:failed", label: "The request failed", detail: trace.failure });
  return activity;
}

/** The run as the message WorkTrace reads. */
export function draftRunMessage(trace: DraftTraceState): ChatMessage {
  return traceRunMessage({
    activity: trace.sheetRun?.activity ?? plannedActivity(trace),
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
  });
}

/** What the running trace names as coming next. */
export function draftRunNext(trace: DraftTraceState): string | undefined {
  if (trace.sheetRun) return undefined;
  return trace.steps[trace.activeIndex + 1]?.label ?? "Finish the draft";
}

/** The event the trace sits under: its request, as in the chat. */
export function traceAnchorId(
  trace: DraftTraceState,
  events: ReadonlyArray<{ id: string; kind: string }>,
): string | null {
  if (trace.sheetRun) return trace.sheetRun.requestEventId;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.kind === "user") return events[index]!.id;
  }
  return null;
}
