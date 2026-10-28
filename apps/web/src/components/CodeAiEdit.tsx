import { Sparkles } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { ChatWireMessage } from "../lib/api/chat";
import { CODE_SELECTION_ACTIONS, codeLineDiff, codeSelectionLines, type CodeSelection } from "../lib/codeAiEdit";
import {
  CODE_AI_MOVED,
  codeAiAccepted,
  codeAiFailure,
  codeAiRequest,
  codeAiSessionReducer,
  type CodeAiAction,
  type CodeAiSession,
} from "../lib/codeAiSession";
import { useCodeHighlight } from "../lib/codeHighlight";
import { codeSelectionFromDom } from "../lib/codeSelectionDom";
import { AiEditComposer, type AiComposerAnchor } from "./AiEditComposer";
import { AI_EDIT_SHORTCUT, replaceTextareaRange } from "./CodeBlockEditor";
import { CodeLineText, type MarkedLines } from "./CodeLines";

/** What a surface lends its code blocks for AI edits: the model to call and
 * how to call it. Without a provider, code blocks offer no AI edit. */
export type CodeEditAssist = {
  agentName: string;
  /** Why AI edits cannot run right now (no model selected), or null. */
  unavailableReason: string | null;
  request: (
    messages: ChatWireMessage[],
    options: { signal: AbortSignal; onDelta: (fullText: string) => void },
  ) => Promise<string>;
};

const CodeEditAssistContext = createContext<CodeEditAssist | null>(null);

export const CodeEditAssistProvider = CodeEditAssistContext.Provider;

export function useCodeEditAssist(): CodeEditAssist | null {
  return useContext(CodeEditAssistContext);
}

function blockInput(block: HTMLElement) {
  return block.querySelector<HTMLTextAreaElement>("textarea.code-edit-input");
}

/** The selected range in this block: the editor's own selection while it
 * has focus, the page selection over the read-only view otherwise. */
function readBlockSelection(block: HTMLElement, code: string): CodeSelection | null {
  const input = blockInput(block);
  if (input) {
    const selected = document.activeElement === input && input.selectionEnd > input.selectionStart;
    return selected ? { start: input.selectionStart, end: input.selectionEnd } : null;
  }
  return codeSelectionFromDom(block.querySelector(".md-code-lines")!, window.getSelection(), code);
}

function useBlockSelection(blockRef: RefObject<HTMLElement | null>, code: string) {
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  useEffect(() => {
    const block = blockRef.current!;
    const read = () => setSelection(readBlockSelection(block, code));
    read();
    document.addEventListener("selectionchange", read);
    block.addEventListener("select", read);
    block.addEventListener("keyup", read);
    block.addEventListener("mouseup", read);
    return () => {
      document.removeEventListener("selectionchange", read);
      block.removeEventListener("select", read);
      block.removeEventListener("keyup", read);
      block.removeEventListener("mouseup", read);
    };
  }, [blockRef, code]);
  return selection;
}

/** ⌘J / Ctrl+J inside the block opens the AI edit on the selection. */
function useAiShortcut(blockRef: RefObject<HTMLElement | null>, onTrigger: (() => void) | null) {
  useEffect(() => {
    if (!onTrigger) return;
    const block = blockRef.current!;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      onTrigger();
    };
    block.addEventListener("keydown", onKeyDown);
    return () => block.removeEventListener("keydown", onKeyDown);
  }, [blockRef, onTrigger]);
}

/** Viewport box around the code rows from `lines.first` to `lines.last`. */
export function rowsAnchor(block: HTMLElement | null, lines: MarkedLines): AiComposerAnchor | null {
  const rows = block ? block.querySelectorAll<HTMLElement>("[data-code-row]") : [];
  const first = rows[lines.first];
  const last = rows[lines.last];
  if (!first || !last) return null;
  const top = first.getBoundingClientRect();
  return { top: top.top, bottom: last.getBoundingClientRect().bottom, left: top.left, right: top.right };
}

/** A stable anchor while the targeted lines stay put, so the floating
 * controls are not re-placed on every keystroke. */
function useRowsAnchor(blockRef: RefObject<HTMLElement | null>, lines: MarkedLines) {
  const { first, last } = lines;
  return useCallback(() => rowsAnchor(blockRef.current, { first, last }), [blockRef, first, last]);
}

/** Centered above the anchor, or below it when there is no room up top;
 * always inside the viewport's side margins. */
export function offerPlacement(
  anchor: AiComposerAnchor,
  size: { width: number; height: number },
  viewportWidth: number,
): { top: number; left: number } {
  const centered = (anchor.left + anchor.right) / 2 - size.width / 2;
  const left = Math.max(8, Math.min(centered, viewportWidth - size.width - 8));
  const above = anchor.top - size.height - 8;
  return { left, top: above < 64 ? anchor.bottom + 8 : above };
}

/** Re-placed on every scroll, including scrolls of the chat's own scroller
 * (scroll does not bubble, hence the capture listener), and on resize. */
function useOfferPosition(getAnchor: () => AiComposerAnchor | null, ref: RefObject<HTMLElement | null>) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const anchor = getAnchor();
      const box = ref.current!;
      const size = { width: box.offsetWidth || 96, height: box.offsetHeight || 36 };
      if (anchor) setPosition(offerPlacement(anchor, size, window.innerWidth));
    };
    const schedule = () => {
      frame ||= window.requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [getAnchor, ref]);
  return position;
}

function AskAiOffer({
  blockRef,
  lines,
  disabledReason,
  onAsk,
}: {
  blockRef: RefObject<HTMLElement | null>;
  lines: MarkedLines;
  disabledReason: string | null;
  onAsk: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const position = useOfferPosition(useRowsAnchor(blockRef, lines), ref);
  useAiShortcut(blockRef, disabledReason ? null : onAsk);
  return createPortal(
    <div
      className="document-selection-toolbar code-ai-offer"
      ref={ref}
      role="toolbar"
      aria-label="Selected code"
      // Hidden only until the first placement, which runs before paint.
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
      // Keeps the code selection alive while the button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        className="document-selection-ai"
        type="button"
        aria-label="Ask AI to edit the selected code"
        data-tooltip={disabledReason || `Rewrite, fix, or comment the selected code with AI (${AI_EDIT_SHORTCUT})`}
        disabled={Boolean(disabledReason)}
        onClick={onAsk}
      >
        <Sparkles size={14} />
        Ask AI
      </button>
    </div>,
    document.body,
  );
}

/** Offers "Ask AI" while code in the block is selected. */
function SelectionOffer({
  assist,
  blockRef,
  code,
  onOpen,
}: {
  assist: CodeEditAssist;
  blockRef: RefObject<HTMLElement | null>;
  code: string;
  onOpen: (selection: CodeSelection) => void;
}) {
  const selection = useBlockSelection(blockRef, code);
  if (!selection) return null;
  return (
    <AskAiOffer
      blockRef={blockRef}
      disabledReason={assist.unavailableReason}
      lines={codeSelectionLines(code, selection)}
      onAsk={() => onOpen(selection)}
    />
  );
}

const DIFF_SIGN = { add: "+", remove: "−", same: " " } as const;
const DIFF_SPOKEN = { add: "Added: ", remove: "Removed: ", same: "" } as const;

/** Personal-data screening may replace values with ⟦…⟧ tokens before the
 * model sees them; a suggestion that carries new ones needs a second look. */
function concealedNote(selected: string, proposal: string) {
  return proposal.includes("⟦") && !selected.includes("⟦")
    ? "Personal data was hidden from the model. Check the ⟦ ⟧ placeholders."
    : null;
}

/** The suggestion as a line diff against the selection, colored like the block. */
export function CodeDiffPreview({ before, after, language }: { before: string; after: string; language: string }) {
  const rows = useMemo(() => codeLineDiff(before, after), [before, after]);
  const beforeTokens = useCodeHighlight(before, language);
  const afterTokens = useCodeHighlight(after, language);
  const note = concealedNote(before, after);
  return (
    <div className="code-ai-diff">
      <p className="code-ai-diff-stat">
        <span className="is-add">+{rows.filter((row) => row.kind === "add").length}</span>{" "}
        <span className="is-remove">−{rows.filter((row) => row.kind === "remove").length}</span> lines
        {note && <span className="code-ai-diff-note">{note}</span>}
      </p>
      <pre className="code-ai-diff-lines">
        <code>
          {rows.map((row, index) => (
            <span className={`code-ai-diff-row is-${row.kind}`} key={index}>
              <span className="code-ai-diff-sign" aria-hidden="true">
                {DIFF_SIGN[row.kind]}
              </span>
              <span className="code-ai-diff-text">
                <span className="sr-only">{DIFF_SPOKEN[row.kind]}</span>
                <CodeLineText
                  text={row.text}
                  tokens={row.kind === "add" ? afterTokens?.[row.after] : beforeTokens?.[row.before]}
                />
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

type SessionControls = {
  session: CodeAiSession | null;
  open: (selection: CodeSelection) => void;
  run: (instruction: string) => void;
  refine: (instruction: string) => void;
  retry: (session: CodeAiSession) => void;
  stop: () => void;
  close: () => void;
  accept: (apply: (session: CodeAiSession, nextCode: string) => void) => void;
};

/** What the session's handlers share across renders. */
type SessionRuntime = {
  assist: CodeEditAssist | null;
  language: string;
  session: CodeAiSession | null;
  code: string;
  dispatch: Dispatch<CodeAiAction>;
  /** The request whose replies count; a close or a newer request replaces
   * it, so even a provider that ignores the abort cannot answer late. */
  current: object | null;
  controller: AbortController | null;
};

function cancelRequest(runtime: SessionRuntime) {
  runtime.current = null;
  runtime.controller?.abort();
}

async function sendRequest(runtime: SessionRuntime, messages: ChatWireMessage[], runLabel: string) {
  cancelRequest(runtime);
  const controller = new AbortController();
  const token = {};
  Object.assign(runtime, { controller, current: token });
  const live = () => runtime.current === token;
  runtime.dispatch({ type: "send", runLabel, messages });
  try {
    const text = await runtime.assist!.request(messages, {
      signal: controller.signal,
      onDelta: (fullText) => live() && runtime.dispatch({ type: "stream", text: fullText }),
    });
    if (live()) runtime.dispatch({ type: "reply", text });
  } catch (error) {
    if (live()) runtime.dispatch({ type: "fail", error: codeAiFailure(error, controller.signal.aborted) });
  }
}

function sendInstruction(runtime: SessionRuntime, instruction: string, refine: boolean) {
  const next = codeAiRequest(runtime.session!, { code: runtime.code, language: runtime.language, instruction, refine });
  void sendRequest(runtime, next.messages, next.runLabel);
}

function closeSession(runtime: SessionRuntime) {
  cancelRequest(runtime);
  runtime.dispatch({ type: "close" });
}

function acceptSession(runtime: SessionRuntime, apply: (session: CodeAiSession, nextCode: string) => void) {
  const session = runtime.session!;
  const next = codeAiAccepted(session, runtime.code);
  if (next === null) {
    runtime.dispatch({ type: "fail", error: CODE_AI_MOVED });
    return;
  }
  apply(session, next);
  closeSession(runtime);
}

function useCodeAiSession(assist: CodeEditAssist | null, code: string, language: string): SessionControls {
  const [session, dispatch] = useReducer(codeAiSessionReducer, null);
  const runtimeRef = useRef<SessionRuntime>({ assist, language, session, code, dispatch, current: null, controller: null });
  const runtime = runtimeRef.current;
  Object.assign(runtime, { assist, language, session, code });
  useEffect(() => () => cancelRequest(runtimeRef.current), []);
  return {
    session,
    open: (selection) => dispatch({ type: "open", code: runtime.code, selection }),
    run: (instruction) => sendInstruction(runtime, instruction, false),
    refine: (instruction) => sendInstruction(runtime, instruction, true),
    retry: (current) => void sendRequest(runtime, current.pending, current.runLabel),
    stop: () => runtime.controller!.abort(),
    close: () => closeSession(runtime),
    accept: (apply) => acceptSession(runtime, apply),
  };
}

function CodeAiComposer({
  assist,
  blockRef,
  controls,
  session,
  code,
  embedded,
  language,
  onApply,
}: {
  assist: CodeEditAssist;
  blockRef: RefObject<HTMLElement | null>;
  controls: SessionControls;
  session: CodeAiSession;
  code: string;
  embedded: boolean;
  language: string;
  onApply: (session: CodeAiSession, nextCode: string) => void;
}) {
  const getAnchor = useRowsAnchor(blockRef, codeSelectionLines(code, session.selection));
  return (
    <AiEditComposer
      embedded={embedded}
      getAnchor={getAnchor}
      title="Edit code with AI"
      targetLabel={`${session.label} · ${language || "code"}`}
      placeholder="Tell AI how to change the selected code…"
      actions={CODE_SELECTION_ACTIONS}
      chipGroups={[]}
      phase={session.phase}
      agentName={assist.agentName}
      streamText={session.stream}
      runLabel={session.runLabel}
      reviewPreview={
        session.phase === "review" ? (
          <CodeDiffPreview before={session.selectedText} after={session.proposal} language={language} />
        ) : undefined
      }
      error={session.error}
      disabledReason={assist.unavailableReason}
      acceptLabel="Replace"
      onRun={controls.run}
      onRefine={controls.refine}
      onAccept={() => controls.accept(onApply)}
      onRetry={() => controls.retry(session)}
      onStop={controls.stop}
      onClose={controls.close}
    />
  );
}

/** Puts an accepted suggestion in place: into the open editor as one
 * undoable insertion, or through `onApply` for the read-only view. */
function applyAccepted(block: HTMLElement, session: CodeAiSession, nextCode: string, onApply: (code: string) => void) {
  const input = blockInput(block);
  if (!input) return onApply(nextCode);
  const { selection, proposal } = session;
  replaceTextareaRange(input, { ...selection, text: proposal, selectStart: selection.start, selectEnd: selection.start + proposal.length });
}

/**
 * AI edit for a code block: select code, press "Ask AI" (or the shortcut),
 * describe the change, review the line diff, accept. While editing, the
 * accepted code goes into the editor as one undoable insertion; otherwise
 * `onApply` receives the whole updated code to save.
 */
export function useCodeAiEdit({
  assist,
  blockRef,
  code,
  embedded = false,
  language,
  onApply,
}: {
  assist: CodeEditAssist | null;
  blockRef: RefObject<HTMLElement | null>;
  code: string;
  /** Render the composer in place (inside a dialog such as the artifact
   * canvas) instead of floating beside the code. */
  embedded?: boolean;
  language: string;
  onApply: (nextCode: string) => void;
}): { marked: MarkedLines | null; layer: ReactNode } {
  const controls = useCodeAiSession(assist, code, language);
  const { session } = controls;
  const apply = (current: CodeAiSession, nextCode: string) => applyAccepted(blockRef.current!, current, nextCode, onApply);
  const layer =
    assist &&
    (session ? (
      <CodeAiComposer
        assist={assist}
        blockRef={blockRef}
        code={code}
        controls={controls}
        embedded={embedded}
        language={language}
        session={session}
        onApply={apply}
      />
    ) : (
      <SelectionOffer assist={assist} blockRef={blockRef} code={code} onOpen={controls.open} />
    ));
  return { marked: session && codeSelectionLines(code, session.selection), layer };
}
