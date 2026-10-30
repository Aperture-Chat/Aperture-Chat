import { describe, expect, it, vi } from "vitest";
import { blankWorkbook } from "./sheetModel";
import { runSheetAiFlow } from "./sheetAiFlow";

const reply = (ops: unknown[], message = "Done.") => JSON.stringify({ message, ops });

describe("runSheetAiFlow", () => {
  it("retries once when the first reply is not JSON, then applies the second", async () => {
    const answers = ["Sure! Here you go.", reply([{ op: "set", range: "A1", values: [[7]] }])];
    const ask = vi.fn(async () => answers.shift() ?? "");
    const flow = await runSheetAiFlow({ ask, instruction: "Put 7 in A1", workbook: blankWorkbook(), sheetId: "sheet-1", scope: "workbook" });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]).toContain("Your previous reply was not valid JSON");
    expect(flow.ok && flow.result.workbook.sheets[0].cells.A1).toEqual({ v: 7 });
  });

  it("reports an unreadable reply after the retry", async () => {
    const flow = await runSheetAiFlow({ ask: async () => "no", instruction: "x", workbook: blankWorkbook(), sheetId: "sheet-1", scope: "workbook" });
    expect(flow).toEqual({ ok: false, reason: "unreadable" });
  });

  it("keeps a fix only when it leaves fewer broken formulas", async () => {
    const answers = [
      reply([{ op: "set", range: "A1", values: [["=1/0", "=NOPE()"]] }]),
      reply([{ op: "set", range: "A1", values: [["=1/0", "=ALSO_NOPE()"]] }]),
    ];
    const phases: string[] = [];
    const flow = await runSheetAiFlow({ ask: async () => answers.shift() ?? "", instruction: "x", workbook: blankWorkbook(), sheetId: "sheet-1", scope: "workbook", onPhase: (phase, problems) => phases.push(`${phase} ${problems}`) });
    expect(phases).toEqual(["thinking 0", "fixing 2"]);
    expect(flow.ok && flow.result.workbook.sheets[0].cells.B1).toEqual({ f: "NOPE()" });
    expect(flow.ok && flow.problems.length).toBe(2);
  });

  it("applies a fix that leaves fewer broken formulas, adding its message", async () => {
    const answers = [
      reply([{ op: "set", range: "A1", values: [["=1/0", "=NOPE()"]] }], "Built it."),
      reply([{ op: "set", range: "B1", values: [["=1+1"]] }], "Fixed B1."),
    ];
    const flow = await runSheetAiFlow({ ask: async () => answers.shift() ?? "", instruction: "x", workbook: blankWorkbook(), sheetId: "sheet-1", scope: "workbook" });
    expect(flow.ok && flow.result.workbook.sheets[0].cells.B1).toEqual({ f: "1+1" });
    expect(flow.ok && flow.problems.map((problem) => problem.address)).toEqual(["A1"]);
    expect(flow.ok && flow.message).toBe("Built it. Fixed B1.");
  });

  it("keeps the first pass when the fix reply cannot be read", async () => {
    const answers = [reply([{ op: "set", range: "A1", values: [["=1/0"]] }], "Built it."), "not json"];
    const flow = await runSheetAiFlow({ ask: async () => answers.shift() ?? "", instruction: "x", workbook: blankWorkbook(), sheetId: "sheet-1", scope: "workbook" });
    expect(flow.ok && flow.result.workbook.sheets[0].cells.A1).toEqual({ f: "1/0" });
    expect(flow.ok && flow.message).toBe("Built it.");
    expect(flow.ok && flow.problems).toHaveLength(1);
  });

  it("passes extra context lines and stops when cancelled", async () => {
    let cancelled = false;
    const ask = vi.fn(async () => { cancelled = true; return reply([]); });
    const flow = await runSheetAiFlow({ ask, instruction: "x", workbook: blankWorkbook(), sheetId: "sheet-1", scope: "workbook", context: "Use web search.", isCancelled: () => cancelled });
    expect(ask.mock.calls[0][0]).toMatch(/Use web search\.$/);
    expect(flow).toEqual({ ok: false, reason: "cancelled" });
  });

  it("passes the reply's workbook title through", async () => {
    const ask = async () => JSON.stringify({ message: "Built it.", title: "Team budget", ops: [{ op: "set", range: "A1", values: [[1]] }] });
    const flow = await runSheetAiFlow({ ask, instruction: "Build a budget", workbook: blankWorkbook(), sheetId: "sheet-1", scope: "workbook" });
    expect(flow.ok && flow.title).toBe("Team budget");
  });
});
