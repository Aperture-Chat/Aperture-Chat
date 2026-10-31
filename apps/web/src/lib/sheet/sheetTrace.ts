/** A Drafts spreadsheet run, told the way the chat work trace tells a reply:
 * the route chosen, then only facts as they happen (the workbook read, how
 * long the model thought, a formula fix round, what landed, what the
 * recalculation found, the version saved). Steps use the chat trace's
 * `<kind>:<slug>` ids, so WorkTrace draws them as it draws a chat reply. */

import { startTrace } from "../workTrace";
import type { ChatActivityTraceStep } from "../types";
import type { FormulaProblem } from "./recalc";
import type { Workbook } from "./sheetModel";

type Step = ChatActivityTraceStep;

export type SheetRunStart = { modelLabel: string; web: boolean; knowledge: number; attachments: number; workbook: Workbook };

export type SheetRunOutcome =
  | { kind: "applied"; built: boolean; changed: string; problems: FormulaProblem[]; skipped: number; version: string }
  | { kind: "answered" }
  | { kind: "unreadable" }
  | { kind: "failed"; error: string };

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : many}`;
}

function stepOf(id: string, label: string, detail?: string): Step {
  return detail ? { id, label, detail } : { id, label };
}

function readStep(workbook: Workbook): Step {
  const cells = workbook.sheets.reduce((total, sheet) => total + Object.keys(sheet.cells).length, 0);
  if (cells === 0) return stepOf("context:blank", "Starting from a blank workbook");
  return stepOf("context:workbook", "Read the workbook", `${plural(workbook.sheets.length, "sheet")} · ${plural(cells, "filled cell")}`);
}

/** What is known at send time: where the request went and the workbook it starts from. */
export function sheetRunStart(start: SheetRunStart): Step[] {
  const { workbook, ...route } = start;
  return [...startTrace({ ...route, tools: 0 }), readStep(workbook)];
}

/** A reply arrived: the time the model spent on it, the way the chat trace
 * records time to first words. */
export function sheetRunReplied(activity: Step[], askedAt: number, now: number): Step[] {
  const replies = activity.filter((step) => step.id.startsWith("think:reply")).length;
  const seconds = Math.max(1, Math.round((now - askedAt) / 1000));
  const id = replies ? `think:reply-${replies + 1}` : "think:reply";
  return [...activity, stepOf(id, `Thought for ${seconds}s`, "Until the model's reply arrived")];
}

/** The first pass left formulas erroring, so they go back to the model once. */
export function sheetRunFixing(activity: Step[], problems: number): Step[] {
  return [...activity, stepOf("write:fix", `Fixing ${plural(problems, "formula")} that errored`, "Sent back to the model once, with the exact cells")];
}

function problemStep(problems: FormulaProblem[]): Step {
  if (problems.length === 0) return stepOf("check:formulas", "Recalculated every formula", "None show an error");
  const named = problems.slice(0, 3).map((problem) => `${problem.sheetName}!${problem.address} ${problem.error.code}`);
  const verb = problems.length === 1 ? "shows" : "show";
  return stepOf("flag:formulas", `${plural(problems.length, "formula")} still ${verb} an error`, `${named.join(", ")} — select one and use Ask AI to fix it`);
}

function appliedSteps(outcome: Extract<SheetRunOutcome, { kind: "applied" }>): Step[] {
  return [
    stepOf("table:changes", outcome.built ? "Built the workbook" : "Updated the workbook", outcome.changed),
    problemStep(outcome.problems),
    ...(outcome.skipped ? [stepOf("flag:skipped", `Skipped ${plural(outcome.skipped, "change")}`, "Listed in the chat below")] : []),
    stepOf("done:version", `Saved as ${outcome.version}`, "Compare or restore it from Versions"),
  ];
}

function outcomeSteps(outcome: SheetRunOutcome): Step[] {
  switch (outcome.kind) {
    case "applied":
      return appliedSteps(outcome);
    case "answered":
      return [stepOf("done:answer", "Answered without changing the workbook")];
    case "unreadable":
      return [stepOf("flag:reply", "The reply was not valid spreadsheet changes", "Asked twice; nothing was applied")];
    case "failed":
      return [stepOf("flag:error", "The request failed", outcome.error)];
  }
}

/** How the run ended, after the steps already recorded. */
export function sheetRunFinished(activity: Step[], outcome: SheetRunOutcome): Step[] {
  return [...activity, ...outcomeSteps(outcome)];
}
