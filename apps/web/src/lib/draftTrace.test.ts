import { describe, expect, it } from "vitest";
import {
  draftRunMessage,
  draftRunNext,
  traceAnchorId,
  type DraftTraceState,
  type DraftTraceStep,
} from "./draftTrace";
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
    const sheetRun = { activity: [{ id: "route:model", label: "Used Model" }], thinking: [], requestEventId: "e1" };
    expect(labels(run({ sheetRun }))).toEqual(["Used Model"]);
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
    const sheetRun = { activity: [], thinking: [], requestEventId: "e1" };
    expect(draftRunNext(run({ sheetRun }))).toBeUndefined();
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
    const sheetRun = { activity: [], thinking: [], requestEventId: "e1" };
    expect(traceAnchorId(run({ sheetRun }), events)).toBe("e1");
  });

  it("has no anchor before any request exists", () => {
    expect(traceAnchorId(run(), [{ id: "e2", kind: "assistant" }])).toBeNull();
  });
});
