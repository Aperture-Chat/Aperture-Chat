import { describe, expect, it } from "vitest";
import { readTrace, traceRunMessage } from "../workTrace";
import type { FormulaProblem } from "./recalc";
import { blankWorkbook, parseWorkbook } from "./sheetModel";
import { sheetRunFinished, sheetRunFixing, sheetRunReplied, sheetRunStart } from "./sheetTrace";

function workbookOf(input: unknown) {
  const parsed = parseWorkbook(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
}

const FILLED = workbookOf({
  sheets: [
    { id: "a", name: "Budget", cells: { A1: { v: "Rent" }, B1: { v: 1800 } } },
    { id: "b", name: "Notes", cells: { A1: { v: "Due on the 1st" } } },
  ],
});

function problem(sheetName: string, address: string, code: string): FormulaProblem {
  return { sheetId: "a", sheetName, address, formula: "=1/0", error: { code } } as FormulaProblem;
}

const START = { modelLabel: "Analyst", web: false, knowledge: 0, attachments: 0 };

describe("sheetRunStart", () => {
  it("routes to the model and says it starts from a blank workbook", () => {
    expect(sheetRunStart({ ...START, web: true, workbook: blankWorkbook() })).toEqual([
      { id: "route:model", label: "Routed to Analyst", detail: "With web search" },
      { id: "context:blank", label: "Starting from a blank workbook" },
    ]);
  });

  it("reads a filled workbook, counting its sheets and filled cells, with what the user switched on", () => {
    expect(sheetRunStart({ ...START, knowledge: 2, attachments: 1, workbook: FILLED })).toEqual([
      { id: "route:model", label: "Routed to Analyst", detail: "With 2 knowledge sources and 1 attachment" },
      { id: "context:workbook", label: "Read the workbook", detail: "2 sheets · 3 filled cells" },
    ]);
  });

  it("names one sheet and one cell in the singular", () => {
    const one = workbookOf({ sheets: [{ id: "a", name: "Budget", cells: { A1: { v: 1 } } }] });
    expect(sheetRunStart({ ...START, workbook: one })[1]).toEqual({ id: "context:workbook", label: "Read the workbook", detail: "1 sheet · 1 filled cell" });
  });
});

describe("sheetRunReplied", () => {
  it("records how long the model thought, once per reply", () => {
    const first = sheetRunReplied([], 1_000, 13_400);
    expect(first).toEqual([{ id: "think:reply", label: "Thought for 12s", detail: "Until the model's reply arrived" }]);
    expect(sheetRunReplied(first, 20_000, 20_200)[1]).toEqual({ id: "think:reply-2", label: "Thought for 1s", detail: "Until the model's reply arrived" });
  });
});

describe("sheetRunFixing", () => {
  it("says how many formulas went back to the model", () => {
    expect(sheetRunFixing([], 3)).toEqual([{ id: "write:fix", label: "Fixing 3 formulas that errored", detail: "Sent back to the model once, with the exact cells" }]);
    expect(sheetRunFixing([], 1)[0].label).toBe("Fixing 1 formula that errored");
  });
});

describe("sheetRunFinished", () => {
  it("tells a clean build: what was written, the recalculation, and the saved version", () => {
    const steps = sheetRunFinished([], { kind: "applied", built: true, changed: "42 cells, 1 chart", problems: [], skipped: 0, version: "Version 2" });
    expect(steps).toEqual([
      { id: "table:changes", label: "Built the workbook", detail: "42 cells, 1 chart" },
      { id: "check:formulas", label: "Recalculated every formula", detail: "None show an error" },
      { id: "done:version", label: "Saved as Version 2", detail: "Compare or restore it from Versions" },
    ]);
  });

  it("flags formulas that still error, naming up to three, and changes it skipped", () => {
    const problems = [problem("Budget", "B4", "#REF!"), problem("Budget", "C4", "#DIV/0!"), problem("Notes", "A2", "#NAME?"), problem("Notes", "A3", "#N/A")];
    const steps = sheetRunFinished([], { kind: "applied", built: false, changed: "8 cells", problems, skipped: 1, version: "Version 5" });
    expect(steps.map((step) => step.id)).toEqual(["table:changes", "flag:formulas", "flag:skipped", "done:version"]);
    expect(steps[0].label).toBe("Updated the workbook");
    expect(steps[1]).toEqual({ id: "flag:formulas", label: "4 formulas still show an error", detail: "Budget!B4 #REF!, Budget!C4 #DIV/0!, Notes!A2 #NAME? — select one and use Ask AI to fix it" });
    expect(steps[2]).toEqual({ id: "flag:skipped", label: "Skipped 1 change", detail: "Listed in the chat below" });
  });

  it("names one erroring formula and several skipped changes in the right number", () => {
    const steps = sheetRunFinished([], { kind: "applied", built: false, changed: "2 cells", problems: [problem("Budget", "B4", "#REF!")], skipped: 3, version: "Version 3" });
    expect(steps[1].label).toBe("1 formula still shows an error");
    expect(steps[2].label).toBe("Skipped 3 changes");
  });

  it("ends an answer, an unreadable reply, and a failure honestly", () => {
    expect(sheetRunFinished([], { kind: "answered" })).toEqual([{ id: "done:answer", label: "Answered without changing the workbook" }]);
    expect(sheetRunFinished([], { kind: "unreadable" })).toEqual([
      { id: "flag:reply", label: "The reply was not valid spreadsheet changes", detail: "Asked twice; nothing was applied" },
    ]);
    expect(sheetRunFinished([], { kind: "failed", error: "Provider timed out" })).toEqual([
      { id: "flag:error", label: "The request failed", detail: "Provider timed out" },
    ]);
  });

  it("adds to the steps already recorded", () => {
    const started = sheetRunStart({ ...START, workbook: FILLED });
    expect(sheetRunFinished(started, { kind: "answered" }).slice(0, 2)).toEqual(started);
  });
});

describe("traceRunMessage", () => {
  const activity = [
    ...sheetRunStart({ ...START, workbook: blankWorkbook() }),
    ...sheetRunReplied([], 0, 5_000),
    ...sheetRunFinished([], { kind: "applied", built: true, changed: "3 cells", problems: [], skipped: 0, version: "Version 1" }),
  ];

  it("is a pending reply with no length while the run works", () => {
    const message = traceRunMessage({ activity, startedAt: 1_000 });
    expect(message).toMatchObject({ role: "assistant", content: "", status: "pending", startedAtMs: 1_000, activityTrace: activity });
    expect(message.durationMs).toBeUndefined();
    expect(message.id).toBe("trace-run-1000");
  });

  it("knows how long a finished run took", () => {
    expect(traceRunMessage({ activity, startedAt: 1_000, endedAt: 15_500 })).toMatchObject({ status: "ok", durationMs: 14_500 });
  });

  it("reads back as the chat trace's kinds", () => {
    expect(readTrace(traceRunMessage({ activity, startedAt: 0 }).activityTrace).map((step) => step.kind)).toEqual([
      "route", "context", "think", "table", "check", "done",
    ]);
  });
});
