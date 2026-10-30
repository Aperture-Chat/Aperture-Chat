import { TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { SHEET_ACTIONS } from "../../lib/aiEditPrompts";
import type { Workbook } from "../../lib/sheet/sheetModel";
import { type AiComposerAnchor, type AiComposerPhase, AiEditComposer } from "../AiEditComposer";

export type SheetAiPreview = {
  workbook: Workbook;
  changed: Map<string, Set<string>>;
  summary: string;
  warnings: string[];
  problems: number;
  sheetId: string;
};

export type SheetAiState = {
  open: boolean;
  phase: "idle" | "thinking" | "fixing" | "preview" | "answered" | "error";
  /** The instruction last sent, and the short label shown for it. */
  prompt: string;
  label: string;
  message?: string;
  error?: string;
  preview?: SheetAiPreview;
  streamed?: string;
};

const PHASES: Record<SheetAiState["phase"], AiComposerPhase> = {
  idle: "compose",
  thinking: "working",
  fixing: "working",
  preview: "review",
  answered: "review",
  error: "error",
};

type Props = {
  state: SheetAiState;
  scopeLabel: string;
  agentName: string;
  disabledReason: string | null;
  getAnchor: () => AiComposerAnchor | null;
  onRun: (instruction: string, label: string) => void;
  onRefine: (instruction: string) => void;
  onAccept: () => void;
  onRetry: () => void;
  onStop: () => void;
  onClose: () => void;
};

/** The spreadsheet's inline AI: the same composer documents and decks use,
 * with spreadsheet actions. Proposed cells preview in the grid and apply as
 * one undoable change. */
export function SheetAiComposer({ state, scopeLabel, agentName, disabledReason, getAnchor, onRun, onRefine, onAccept, onRetry, onStop, onClose }: Props) {
  const phase = PHASES[state.phase];
  useCloseOnOutsidePointer(onClose);
  return (
    <AiEditComposer
      getAnchor={getAnchor}
      title="Ask AI"
      targetLabel={scopeLabel}
      placeholder="Ask about this data, or describe a change: a formula, a cleanup, a chart…"
      actions={SHEET_ACTIONS}
      chipGroups={[]}
      phase={phase}
      agentName={agentName}
      streamText={progressText(state)}
      runLabel={state.label}
      reviewPreview={phase === "review" ? <SheetAiReview state={state} /> : undefined}
      error={state.error}
      disabledReason={disabledReason}
      acceptLabel={state.phase === "answered" ? "Done" : "Apply"}
      refinePlaceholder="Tell AI what to adjust: another column, a different chart, round to dollars…"
      onRun={onRun}
      onRefine={onRefine}
      onAccept={state.phase === "answered" ? onClose : onAccept}
      onRetry={onRetry}
      onStop={onStop}
      onClose={onClose}
    />
  );
}

/** Elements that open the composer; a press on one is the opener's toggle, not an outside click. */
export const AI_COMPOSER_TRIGGER = "data-ai-composer-trigger";

/** A press anywhere outside the composer closes it, as menus do. Capture
 * phase, so the grid still gets the same press and selects what was clicked. */
function useCloseOnOutsidePointer(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(`.ai-composer, [${AI_COMPOSER_TRIGGER}]`)) return;
      close.current();
    };
    // Capture: controls such as a tab's delete key stop their presses from bubbling.
    const options = { capture: true };
    document.addEventListener("pointerdown", dismiss, options);
    return () => document.removeEventListener("pointerdown", dismiss, options);
  }, []);
}

/** Where the composer attaches: beside the selection and any cells the
 * preview changed, so it never covers what it asks you to check; under the
 * formula bar when they are scrolled out of view. */
export function composerAnchor(gridRoot: HTMLElement | null, formulaBar: HTMLElement | null): AiComposerAnchor | null {
  const scroller = gridRoot?.querySelector(".sheet-scroll")?.getBoundingClientRect();
  const boxes = scroller ? boxesInView(gridRoot!, scroller) : [];
  if (scroller && boxes.length) return clippedUnion(boxes, scroller);
  const bar = formulaBar?.getBoundingClientRect();
  return bar ? { top: bar.top, bottom: bar.bottom, left: bar.left + bar.width / 2, right: bar.right } : null;
}

/** The selection and changed cells that show inside the grid's viewport. */
function boxesInView(gridRoot: HTMLElement, scroller: DOMRect): DOMRect[] {
  return Array.from(gridRoot.querySelectorAll(".sheet-pane.is-main :is(.sheet-selection, .is-ai-changed)"))
    .map((node) => node.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.bottom > scroller.top && box.top < scroller.bottom);
}

function clippedUnion(boxes: DOMRect[], scroller: DOMRect): AiComposerAnchor {
  return {
    top: Math.max(scroller.top, Math.min(...boxes.map((box) => box.top))),
    bottom: Math.min(scroller.bottom, Math.max(...boxes.map((box) => box.bottom))),
    left: Math.max(scroller.left, Math.min(...boxes.map((box) => box.left))),
    right: Math.min(scroller.right, Math.max(...boxes.map((box) => box.right))),
  };
}

/** The model streams sheet operations, not prose, so the working view says
 * what stage it is at instead of echoing JSON. */
function progressText(state: SheetAiState): string {
  if (state.phase === "fixing") return "Checking the formulas it wrote and fixing any errors…";
  if (state.phase === "thinking" && state.streamed) return "Writing the changes into the sheet…";
  return "";
}

function SheetAiReview({ state }: { state: SheetAiState }) {
  const preview = state.preview;
  if (!preview) return <p className="sheet-ai-message is-answer">{state.message}</p>;
  return (
    <div className="sheet-ai-review">
      {state.message && <p className="sheet-ai-message">{state.message}</p>}
      <p className="sheet-ai-summary"><span>Preview</span> {preview.summary} — highlighted in the grid.</p>
      {preview.problems > 0 && (
        <p className="sheet-ai-warning"><TriangleAlert size={14} aria-hidden="true" /> {preview.problems} formula{preview.problems === 1 ? " still shows" : "s still show"} an error. Check the highlighted cells before applying.</p>
      )}
      {preview.warnings.length > 0 && (
        <details className="sheet-ai-details">
          <summary>{preview.warnings.length} skipped change{preview.warnings.length === 1 ? "" : "s"}</summary>
          <ul>{preview.warnings.slice(0, 12).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
