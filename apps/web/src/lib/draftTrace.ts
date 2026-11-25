/** A Drafts document or deck run, told the way the chat work trace tells a
 * reply. These runs follow a planned list of steps, so the timeline shows the
 * ones reached and names the next one. A planned step is a plan and not a
 * result, so none is a "check", which the trace reports as passed. */

import type { ChatStreamActivity } from "./streamActivity";
import { recordActivity, traceRunMessage, type TraceKind } from "./workTrace";
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
  /** Research the model did on its own during a planned run: each step, and
   * the planned step it happened in. */
  research?: Array<{ at: number; step: ChatActivityTraceStep }>;
  /** A fact run records facts as they happen and any thinking the model
   * exposed, in place of the planned steps above: a spreadsheet run, or the
   * intake turn that reads a request before anything is written. */
  factRun?: {
    activity: ChatActivityTraceStep[];
    thinking: string[];
    /** The request it works on; the trace sits under it, as in the chat. */
    requestEventId: string;
  };
  /** The run stopped to ask the user and is waiting for the answer. */
  awaitingAnswer?: boolean;
};

function plannedActivity(trace: DraftTraceState): ChatActivityTraceStep[] {
  const finished = trace.complete && !trace.failure;
  const reached = finished ? trace.steps : trace.steps.slice(0, trace.activeIndex + 1);
  const { research = [] } = trace;
  const activity: ChatActivityTraceStep[] = reached.flatMap((step, index) => [
    { id: `${STEP_KINDS[step.id]}:${step.id}`, label: step.label, detail: step.detail },
    ...research.filter((found) => found.at === index).map((found) => found.step),
  ]);
  if (trace.failure) activity.push({ id: "flag:failed", label: "The request failed", detail: trace.failure });
  return activity;
}

/** The run as the message WorkTrace reads. */
export function draftRunMessage(trace: DraftTraceState): ChatMessage {
  return traceRunMessage({
    activity: trace.factRun?.activity ?? plannedActivity(trace),
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
  });
}

/** What the running trace names as coming next. */
export function draftRunNext(trace: DraftTraceState): string | undefined {
  if (trace.factRun) return undefined;
  return trace.steps[trace.activeIndex + 1]?.label ?? "Finish the draft";
}

/** The event the trace sits under: its request, as in the chat. */
export function traceAnchorId(
  trace: DraftTraceState,
  events: ReadonlyArray<{ id: string; kind: string }>,
): string | null {
  if (trace.factRun) return trace.factRun.requestEventId;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.kind === "user") return events[index]!.id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Research the model did on its own                                   */
/* ------------------------------------------------------------------ */

const RESEARCH_STEP_ID = /:step-\d+$/;

/** What the run's model calls have reported so far. */
function reported({ factRun, research = [] }: DraftTraceState): ChatActivityTraceStep[] {
  return factRun ? factRun.activity : research.map((found) => found.step);
}

/** Adds what a writing call reports: the research steps it took, and that
 * another model answered when the chosen one failed. A run may make several
 * writing calls, and each numbers its steps from one, so they are numbered
 * here in the order the run took them. A run says once that another model
 * took over, however many of its calls that model answers. */
export function recordResearch(trace: DraftTraceState, activities: ChatStreamActivity[]): DraftTraceState {
  const known = reported(trace);
  const taken = known.filter((step) => RESEARCH_STEP_ID.test(step.id)).length;
  const handOff = activities
    .filter((activity) => activity.kind === "model-fallback")
    .flatMap((activity) => recordActivity([], activity))
    .filter((step) => !known.some((shown) => shown.id === step.id))
    .slice(0, 1);
  const researched = activities
    .filter((activity) => activity.kind === "step")
    .flatMap((activity, index) => recordActivity([], { ...activity, number: taken + index + 1 }));
  const steps = [...handOff, ...researched];
  if (steps.length === 0) return trace;
  if (trace.factRun) {
    return { ...trace, factRun: { ...trace.factRun, activity: [...trace.factRun.activity, ...steps] } };
  }
  const { research = [], activeIndex } = trace;
  return { ...trace, research: [...research, ...steps.map((step) => ({ at: activeIndex, step }))] };
}

/* ------------------------------------------------------------------ */
/* The intake turn (see ./draftIntake)                                 */
/* ------------------------------------------------------------------ */

/** The intake turn at work, under the request it is reading. */
export function intakeRun(requestEventId: string, startedAt: number): DraftTraceState {
  const reading = {
    id: "plan:intake",
    label: "Reading your request",
    detail: "Checking whether anything needs your answer first",
  };
  return {
    steps: [],
    activeIndex: 0,
    complete: false,
    startedAt,
    factRun: { activity: [reading], thinking: [], requestEventId },
  };
}

/** The trace's row for a pause to ask, which the chat words for a reply. */
const ASKED_STEP_ID = "ask:questions";

/** The intake turn asked: its work is over and it waits for the user. */
export function intakePaused(trace: DraftTraceState, questions: number, now: number): DraftTraceState {
  if (!trace.factRun) return trace;
  const activity = recordActivity(trace.factRun.activity, { kind: "ask", questions }).map((step) =>
    step.id === ASKED_STEP_ID ? { ...step, detail: "So the draft fits what you need" } : step,
  );
  return { ...trace, factRun: { ...trace.factRun, activity }, complete: true, endedAt: now, awaitingAnswer: true };
}
