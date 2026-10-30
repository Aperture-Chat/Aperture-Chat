/** One spreadsheet AI request, end to end, shared by the inline assistant and
 * the Drafts rail's Spreadsheet Assistant:
 *
 *   prompt → reply → (one retry if the reply is not readable JSON)
 *          → apply ops → recalculate → (one fix round if cells the AI wrote
 *            show formula errors, kept only when it reduces them)
 *
 * The model call is injected, so the flow is pure apart from it and can be
 * tested with a scripted model. */

import type { CellRange } from "./address";
import type { FormulaProblem } from "./recalc";
import { computeWorkbook } from "./recalc";
import { type ApplyResult, type SheetAiReply, applySheetOps, buildSheetPrompt, parseSheetAiReply, problemsInTouched } from "./sheetAi";
import type { Workbook } from "./sheetModel";

export type SheetAiPhase = "thinking" | "fixing";

export type SheetAiFlowInput = {
  ask: (prompt: string) => Promise<string>;
  instruction: string;
  workbook: Workbook;
  sheetId: string;
  scope: "cell" | "workbook";
  selection?: CellRange;
  sources?: string;
  /** Extra prompt lines (web search policy, chat context). */
  context?: string;
  /** Each stage as it starts, with how many erroring formulas went back to
   * the model (none while it first thinks). */
  onPhase?: (phase: SheetAiPhase, problems: number) => void;
  isCancelled?: () => boolean;
};

export type SheetAiFlowResult =
  | { ok: false; reason: "unreadable" | "cancelled" }
  | { ok: true; message: string; title?: string; result: ApplyResult; problems: FormulaProblem[] };

function mergeTouched(a: ApplyResult["touched"], b: ApplyResult["touched"]): ApplyResult["touched"] {
  const out = new Map(a);
  for (const [id, cells] of b) out.set(id, new Set([...new Set(out.get(id)), ...cells]));
  return out;
}

const CANCELLED = { ok: false, reason: "cancelled" } as const;

/** Said by a step when the user cancelled while it waited on the model. */
type Cancelled = "cancelled";

type Applied = { result: ApplyResult; message: string; problems: FormulaProblem[] };

function isCancelled(input: SheetAiFlowInput): boolean {
  return input.isCancelled?.() === true;
}

/** The model's reply; an unreadable one is asked once more, quoting it back. */
async function readableReply(input: SheetAiFlowInput, prompt: (previousReply?: string) => string): Promise<SheetAiReply | null | Cancelled> {
  const first = await input.ask(prompt());
  if (isCancelled(input)) return "cancelled";
  const reply = parseSheetAiReply(first);
  if (reply) return reply;
  const second = await input.ask(prompt(first));
  if (isCancelled(input)) return "cancelled";
  return parseSheetAiReply(second);
}

/** One automatic round for formulas the reply left erroring, kept only when
 * it leaves fewer broken formulas. */
async function fixRound(input: SheetAiFlowInput, applied: Applied): Promise<Applied | Cancelled> {
  const { result, problems } = applied;
  input.onPhase?.("fixing", problems.length);
  const engine = computeWorkbook(result.workbook);
  const { instruction, selection, scope } = input;
  const fixText = await input.ask(buildSheetPrompt({ instruction, workbook: result.workbook, engine, sheetId: result.activeSheetId, selection, scope, problems }));
  if (isCancelled(input)) return "cancelled";
  const fix = parseSheetAiReply(fixText);
  if (!fix?.ops.length) return applied;
  const fixed = applySheetOps(result.workbook, result.activeSheetId, fix.ops);
  const touched = mergeTouched(result.touched, fixed.touched);
  const remaining = problemsInTouched(computeWorkbook(fixed.workbook), touched);
  if (remaining.length >= problems.length) return applied;
  return {
    result: { ...fixed, warnings: [...result.warnings, ...fixed.warnings], touched },
    message: `${applied.message} ${fix.message}`.trim(),
    problems: remaining,
  };
}

export async function runSheetAiFlow(input: SheetAiFlowInput): Promise<SheetAiFlowResult> {
  const { instruction, workbook, sheetId, scope, selection, sources } = input;
  const engine = computeWorkbook(workbook);
  const prompt = (previousReply?: string) => {
    const text = buildSheetPrompt({ instruction, workbook, engine, sheetId, selection, scope, sources, previousReply });
    return input.context ? `${text}\n\n${input.context}` : text;
  };
  input.onPhase?.("thinking", 0);
  const reply = await readableReply(input, prompt);
  if (reply === "cancelled") return CANCELLED;
  if (!reply) return { ok: false, reason: "unreadable" };
  const result = applySheetOps(workbook, sheetId, reply.ops);
  let applied: Applied = { result, message: reply.message, problems: problemsInTouched(computeWorkbook(result.workbook), result.touched) };
  if (applied.problems.length) {
    const fixed = await fixRound(input, applied);
    if (fixed === "cancelled") return CANCELLED;
    applied = fixed;
  }
  return { ok: true, ...applied, title: reply.title };
}
