import { describe, expect, it } from "vitest";
import {
  draftRunMessage,
  draftRunNext,
  intakePaused,
  intakeRun,
  recordResearch,
  traceAnchorId,
  type DraftTraceState,
  type DraftTraceStep,
} from "./draftTrace";
import type { ChatStreamActivity } from "./streamActivity";
import { readTrace, traceSummary } from "./workTrace";

const steps: DraftTraceStep[] = [
  { id: "route", label: "Routing request", detail: "Using Model." },
  { id: "context", label: "Preparing context", detail: "Checking sources." },
  { id: "generate", label: "Generating answer", detail: "Writing." },
  { id: "finalize", label: "Finalizing response", detail: "Formatting." },
];

function run(overrides: Partial<DraftTraceState> = {}): DraftTraceState {
  return { steps, activeIndex: 0, complete: false, startedAt: 1_000, ...overrides };
}

const labels = (trace: DraftTraceState) =>
  readTrace(draftRunMessage(trace).activityTrace).map((step) => step.label);

describe("draftRunMessage", () => {
  it("shows only the steps the run has reached", () => {
    expect(labels(run({ activeIndex: 1 }))).toEqual(["Routing request", "Preparing context"]);
  });

  it("shows every step once the run is finished", () => {
    expect(labels(run({ activeIndex: 4, complete: true, endedAt: 9_000 }))).toHaveLength(4);
  });

  it("draws each planned step with its own kind, not the catch-all", () => {
    const steps = readTrace(draftRunMessage(run({ activeIndex: 3 })).activityTrace);
    expect(steps.map((step) => step.kind)).toEqual(["route", "context", "write", "save"]);
  });

  it("is pending until it ends, then carries how long it took", () => {
    expect(draftRunMessage(run())).toMatchObject({ status: "pending", startedAtMs: 1_000 });
    expect(draftRunMessage(run({ complete: true, endedAt: 15_500 }))).toMatchObject({
      status: "ok",
      durationMs: 14_500,
    });
  });

  it("never claims a check passed, because a planned step is not a result", () => {
    const planned: DraftTraceStep[] = [
      { id: "validator", label: "Content validator loop", detail: "Checking." },
      { id: "fit", label: "Checking slide fit", detail: "Measuring." },
      { id: "protect", label: "Preserving document structure", detail: "Protecting." },
    ];
    const trace = run({ steps: planned, activeIndex: 3, complete: true, endedAt: 2_000 });
    expect(traceSummary(readTrace(draftRunMessage(trace).activityTrace)).checks).toBe(0);
  });

  it("keeps a failed run to the steps it reached and flags the failure", () => {
    const failed = readTrace(
      draftRunMessage(run({ activeIndex: 1, complete: true, endedAt: 2_000, failure: "Timed out" })).activityTrace,
    );
    expect(failed.map((step) => step.label)).toEqual(["Routing request", "Preparing context", "The request failed"]);
    expect(failed[2]).toMatchObject({ kind: "flag", detail: "Timed out" });
  });

  it("uses what a spreadsheet run recorded instead of the planned steps", () => {
    const factRun = { activity: [{ id: "route:model", label: "Used Model" }], thinking: [], requestEventId: "e1" };
    expect(labels(run({ factRun }))).toEqual(["Used Model"]);
  });
});

describe("draftRunNext", () => {
  it("names the planned step after the current one", () => {
    expect(draftRunNext(run({ activeIndex: 1 }))).toBe("Generating answer");
  });

  it("says the run is finishing on the last step", () => {
    expect(draftRunNext(run({ activeIndex: 3 }))).toBe("Finish the draft");
  });

  it("leaves a spreadsheet run to the trace's own wording", () => {
    const factRun = { activity: [], thinking: [], requestEventId: "e1" };
    expect(draftRunNext(run({ factRun }))).toBeUndefined();
  });
});

describe("traceAnchorId", () => {
  const events = [
    { id: "e1", kind: "user" },
    { id: "e2", kind: "assistant" },
    { id: "e3", kind: "user" },
    { id: "e4", kind: "system" },
  ];

  it("puts the trace under the latest request, as in the chat", () => {
    expect(traceAnchorId(run(), events)).toBe("e3");
  });

  it("finds the request when it opens the conversation, as in a new document", () => {
    expect(traceAnchorId(run(), [{ id: "e1", kind: "user" }, { id: "e2", kind: "assistant" }])).toBe("e1");
  });

  it("keeps a spreadsheet run under the request it recorded", () => {
    const factRun = { activity: [], thinking: [], requestEventId: "e1" };
    expect(traceAnchorId(run({ factRun }), events)).toBe("e1");
  });

  it("has no anchor before any request exists", () => {
    expect(traceAnchorId(run(), [{ id: "e2", kind: "assistant" }])).toBeNull();
  });
});

const calc = (about: string): ChatStreamActivity => ({ kind: "step", number: 1, do: "calculate", ok: true, found: 1, about });

describe("recordResearch", () => {
  it("shows a planned run's research under the step it happened in", () => {
    const trace = recordResearch(run({ activeIndex: 2 }), [calc("1250000 * 0.065 / 12")]);
    expect(labels({ ...trace, activeIndex: 4, complete: true, endedAt: 9_000 })).toEqual([
      "Routing request",
      "Preparing context",
      "Generating answer",
      "Worked out a figure",
      "Finalizing response",
    ]);
  });

  it("keeps the steps of a second model call beside the first call's", () => {
    const first = recordResearch(run({ activeIndex: 2 }), [calc("1 + 1"), calc("2 + 2")]);
    const second = recordResearch(first, [calc("3 + 3")]);
    const details = readTrace(draftRunMessage(second).activityTrace)
      .filter((step) => step.kind === "calc")
      .map((step) => step.detail);
    expect(details).toEqual(["1 + 1", "2 + 2", "3 + 3"]);
  });

  const researchIds = (trace: DraftTraceState) =>
    readTrace(draftRunMessage(trace).activityTrace)
      .map((step) => step.id)
      .filter((id) => id.includes(":step-"));

  it("numbers a planned run's steps in the order the run took them", () => {
    const first = recordResearch(run({ activeIndex: 2 }), [calc("1 + 1"), calc("2 + 2")]);
    expect(researchIds(recordResearch(first, [calc("3 + 3")]))).toEqual(["calc:step-1", "calc:step-2", "calc:step-3"]);
  });

  it("numbers a spreadsheet run's steps in the order the run took them", () => {
    const factRun = { activity: [{ id: "route:model", label: "Used Model" }], thinking: [], requestEventId: "e1" };
    const first = recordResearch(run({ factRun }), [calc("1 + 1"), calc("2 + 2")]);
    expect(researchIds(recordResearch(first, [calc("3 + 3")]))).toEqual(["calc:step-1", "calc:step-2", "calc:step-3"]);
  });

  it("adds a spreadsheet run's research to what it has recorded", () => {
    const factRun = { activity: [{ id: "route:model", label: "Used Model" }], thinking: [], requestEventId: "e1" };
    const once = recordResearch(run({ factRun }), [calc("1 + 1")]);
    expect(labels(recordResearch(once, [calc("2 + 2")]))).toEqual(["Used Model", "Worked out a figure", "Worked out a figure"]);
  });

  it("records only research steps, and leaves a run alone when there are none", () => {
    const trace = run({ activeIndex: 2 });
    expect(recordResearch(trace, [{ kind: "knowledge", passages: 2, sources: 1 }])).toBe(trace);
    expect(recordResearch(trace, [])).toBe(trace);
  });

  it("says when a step could not be done", () => {
    const failed: ChatStreamActivity = { kind: "step", number: 1, do: "read_page", ok: false, found: 0, about: "" };
    const steps = readTrace(draftRunMessage(recordResearch(run({ activeIndex: 2 }), [failed])).activityTrace);
    expect(steps.at(-1)).toMatchObject({ kind: "flag", label: "Could not read a web page" });
  });
});

describe("the intake turn's trace", () => {
  const events = [{ id: "e1", kind: "user" }, { id: "e2", kind: "user" }];

  it("sits under the request it reads and says what it is doing", () => {
    const trace = intakeRun("e1", 1_000);
    expect(traceAnchorId(trace, events)).toBe("e1");
    expect(labels(trace)).toEqual(["Reading your request"]);
    expect(draftRunMessage(trace)).toMatchObject({ status: "pending" });
    // Still working: the composer stays closed until it has read the request.
    expect(trace.complete).toBe(false);
    expect(trace.awaitingAnswer).toBeFalsy();
  });

  it("stops the clock and waits once it has asked", () => {
    const paused = intakePaused(intakeRun("e1", 1_000), 2, 4_000);
    expect(labels(paused)).toEqual(["Reading your request", "Paused to ask you 2 questions"]);
    expect(readTrace(draftRunMessage(paused).activityTrace).at(-1)?.detail).toBe("So the draft fits what you need");
    expect(draftRunMessage(paused)).toMatchObject({ status: "ok", durationMs: 3_000 });
    expect(paused.awaitingAnswer).toBe(true);
    expect(paused.complete).toBe(true);
  });
});
