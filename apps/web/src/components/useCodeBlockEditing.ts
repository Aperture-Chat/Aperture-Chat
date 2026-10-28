import { useEffect, useState } from "react";

/** "saved" into the reply, or "local": shown here only (nowhere to save). */
export type CodeSaveStatus = "idle" | "saved" | "local";

/** Saves edited code into the reply; false when it could not be saved.
 * `occurrence` counts identical code blocks above this one in the reply. */
export type CodeSave = (previousSource: string, nextSource: string, occurrence: number) => boolean;

const SAVED_NOTICE_MS = 2400;

/** "Saved" clears itself after a moment; "local" stays. */
function useSaveStatus() {
  const [status, setStatus] = useState<CodeSaveStatus>("idle");
  useEffect(() => {
    if (status !== "saved") return;
    const timer = window.setTimeout(() => setStatus("idle"), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);
  return [status, setStatus] as const;
}

/** Edited code, kept: saved into the reply when the surface can, with the
 * last saved change remembered so it can be undone. */
function useCodeSaving(text: string, onSave: CodeSave | undefined, occurrence: number) {
  // Edits belong to the code they were made on. A saved edit, a new reply
  // version, or another artifact arrives as new text and shows at once,
  // in the same render, never a frame of the previous code.
  const [draft, setDraft] = useState<{ base: string; value: string } | null>(null);
  const code = draft?.base === text ? draft.value : text;
  const setCode = (value: string) => setDraft({ base: text, value });
  const [status, setStatus] = useSaveStatus();
  const [lastEdit, setLastEdit] = useState<{ before: string; after: string } | null>(null);

  function commit(next: string) {
    setCode(next);
    if (next === text) return;
    const saved = onSave ? onSave(text, next, occurrence) : false;
    setStatus(saved ? "saved" : "local");
    setLastEdit(saved ? { before: text, after: next } : null);
  }

  /** Present while the block still shows the last saved change. */
  const undo =
    lastEdit?.after === text
      ? () => {
          commit(lastEdit.before);
          setLastEdit(null);
        }
      : undefined;

  return { code, setCode, status, commit, undo };
}

/**
 * Edit mode for a code block. Done (or Esc) saves; Undo puts back the code
 * from before the last save. Neither is offered where the block is not
 * editable, such as a reply that is still streaming.
 */
export function useCodeBlockEditing(
  text: string,
  save: { onSave?: CodeSave; occurrence: number },
  editable: boolean,
) {
  const saving = useCodeSaving(text, save.onSave, save.occurrence);
  // The editor stays open only for the text it was opened on: a new reply
  // version, or the save itself, closes it.
  const [editingText, setEditingText] = useState<string | null>(null);
  const editing = editingText === text;

  function finish() {
    setEditingText(null);
    saving.commit(saving.code);
  }

  return {
    code: saving.code,
    setCode: saving.setCode,
    commit: saving.commit,
    status: saving.status,
    editing,
    finish,
    toggle: editable ? () => (editing ? finish() : setEditingText(text)) : undefined,
    undo: editing ? undefined : saving.undo,
  };
}
