import { Check, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useCodeHighlight } from "../lib/codeHighlight";
import { codeIndentUnit, indentEdit, lineBreakEdit, outdentEdit, type TextEdit } from "../lib/codeEditing";
import { CodeLineText, isMarkedLine, type MarkedLines } from "./CodeLines";
import type { CodeSaveStatus } from "./useCodeBlockEditing";

const MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
export const AI_EDIT_SHORTCUT = MAC ? "⌘J" : "Ctrl+J";

/** Applies an edit as one native insertion, so ⌘Z undoes it like typing.
 * Where the browser has no insertText command it falls back to setRangeText
 * plus the input event React listens for. */
export function replaceTextareaRange(textarea: HTMLTextAreaElement, edit: TextEdit) {
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(edit.start, edit.end);
  const command = edit.text ? "insertText" : "delete";
  const inserted = typeof document.execCommand === "function" && document.execCommand(command, false, edit.text);
  if (!inserted) {
    textarea.setRangeText(edit.text, edit.start, edit.end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  textarea.setSelectionRange(edit.selectStart, edit.selectEnd);
}

function isFinishKey(event: KeyboardEvent<HTMLTextAreaElement>) {
  return event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s");
}

/** The edit Tab, Shift+Tab, or a plain Enter makes; null for other keys. */
function keyEdit(event: KeyboardEvent<HTMLTextAreaElement>, unit: string): TextEdit | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const { value, selectionStart: start, selectionEnd: end } = event.currentTarget;
  if (event.key === "Tab") return (event.shiftKey ? outdentEdit : indentEdit)(value, start, end, unit);
  return event.key === "Enter" && !event.shiftKey ? lineBreakEdit(value, start, end, unit) : null;
}

/** Keys the editor owns never reach a surrounding dialog: Esc finishes the
 * edit instead of closing the artifact canvas, and Tab indents instead of
 * moving focus. */
function claimKey(event: KeyboardEvent<HTMLTextAreaElement>) {
  event.preventDefault();
  event.stopPropagation();
}

function handleEditorKey(event: KeyboardEvent<HTMLTextAreaElement>, unit: string, onDone: () => void) {
  if (event.nativeEvent.isComposing) return;
  if (isFinishKey(event)) {
    claimKey(event);
    onDone();
    return;
  }
  const edit = keyEdit(event, unit);
  // Tab never leaves the editor, even with nothing left to outdent.
  if (event.key === "Tab" || edit) claimKey(event);
  if (edit) replaceTextareaRange(event.currentTarget, edit);
}

/** Undo (right after a save) and the Edit/Done toggle, shared by chat code
 * blocks and the artifact canvas. Each shows only when its handler exists. */
export function CodeEditButtons({
  editing,
  onToggleEditing,
  onUndo,
}: {
  editing: boolean;
  onToggleEditing?: () => void;
  onUndo?: () => void;
}) {
  return (
    <>
      {onUndo && (
        <button className="md-code-action" type="button" data-tooltip="Put back the code from before your last edit" onClick={onUndo}>
          <RotateCcw size={14} />
          Undo
        </button>
      )}
      {onToggleEditing && (
        <button
          className="md-code-action"
          type="button"
          data-tooltip={editing ? "Save your edits and return to the code view" : "Edit this code, or select lines to change them with AI"}
          onClick={onToggleEditing}
        >
          {editing ? <Check size={14} /> : <Pencil size={14} />}
          {editing ? "Done" : "Edit"}
        </button>
      )}
    </>
  );
}

/** "Saved" for a moment after a save, or a lasting note that the edit could
 * not be saved and lives on this screen only. */
export function CodeSaveNotice({ status }: { status: CodeSaveStatus }) {
  if (status === "idle") return null;
  return (
    <span className={`md-code-save-status is-${status}`} role="status">
      {status === "saved" ? "Saved" : "Edited here only"}
    </span>
  );
}

/** The code drawn with colors under the transparent textarea. */
function HighlightLayer({ value, language, marked }: { value: string; language: string; marked?: MarkedLines | null }) {
  const highlighted = useCodeHighlight(value, language);
  return (
    <pre className="code-edit-highlight" aria-hidden="true">
      <code>
        {value.split("\n").map((line, lineIndex) => (
          <span className={`code-edit-line${isMarkedLine(marked, lineIndex) ? " is-marked" : ""}`} data-code-row="" key={lineIndex}>
            <CodeLineText text={line} tokens={highlighted?.[lineIndex]} />
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * In-place code editor: a transparent textarea over the same code drawn with
 * syntax colors, so typing, selection, undo, and IME input stay native while
 * the colors follow every keystroke. Both layers share one grid cell and one
 * scroll container, so they never drift apart.
 */
export function CodeBlockEditor({
  value,
  language,
  marked,
  onChange,
  onDone,
}: {
  value: string;
  language: string;
  marked?: MarkedLines | null;
  onChange: (value: string) => void;
  /** Esc or ⌘S: leave the editor and keep the edits. */
  onDone: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const [unit] = useState(() => codeIndentUnit(value, language));
  const lineCount = value.split("\n").length;

  useEffect(() => {
    inputRef.current!.focus();
  }, []);

  return (
    <>
      <div className="md-code-editor-shell code-edit-shell">
        <div className="md-code-editor-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, lineIndex) => (
            <span key={lineIndex}>{lineIndex + 1}</span>
          ))}
        </div>
        <div className="code-edit-stack">
          <HighlightLayer language={language} marked={marked} value={value} />
          <textarea
            aria-describedby={hintId}
            aria-label={`Editable ${language || "code"} code`}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="code-edit-input"
            ref={inputRef}
            spellCheck={false}
            value={value}
            wrap="off"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => handleEditorKey(event, unit, onDone)}
          />
        </div>
      </div>
      <p className="code-edit-hint" id={hintId}>
        Tab indents · Shift+Tab outdents · Esc finishes · Select code and press {AI_EDIT_SHORTCUT} to edit it with AI
      </p>
    </>
  );
}
