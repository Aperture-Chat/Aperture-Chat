import { useLayoutEffect, type RefObject } from "react";
import { commandMenuFit, scrollTopShowingCaret } from "./commandMenuFit";

function placeMenu(menu: HTMLElement, composerSelector: string, ceilingSelector: string, ceilingEdge: "top" | "bottom") {
  const composer = menu.closest(composerSelector)?.getBoundingClientRect();
  const ceiling = document.querySelector(ceilingSelector)?.getBoundingClientRect();
  if (!composer || !ceiling) return;
  const placed = commandMenuFit(composer.top, ceiling[ceilingEdge]);
  menu.classList.toggle("is-folded", placed.folded);
  if (!placed.folded) menu.style.setProperty("--command-menu-room", `${placed.room}px`);
}

function showCaret(editor: HTMLTextAreaElement) {
  const caretShare = editor.selectionEnd / editor.value.length;
  editor.scrollTop = scrollTopShowingCaret(editor.scrollTop, editor.clientHeight, editor.scrollHeight, caretShare);
}

/** Keeps a composer's symbol menu inside the room above it, or folds it into the
 * composer. The ceiling is the highest edge the menu may reach: a page header's
 * bottom in chat, the assistant rail's top in Drafts. */
export function useCommandMenuFit({
  open,
  menuRef,
  textareaRef,
  composerSelector,
  ceilingSelector,
  ceilingEdge,
  keepCaretInView,
  contentKey,
}: {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  composerSelector: string;
  ceilingSelector: string;
  ceilingEdge: "top" | "bottom";
  /** The editor gives up room to a folded menu, which can hide the typed line. */
  keepCaretInView: boolean;
  /** Changes when the menu or composer may have changed size. */
  contentKey: string;
}) {
  useLayoutEffect(() => {
    if (!open) return;
    function fit() {
      if (menuRef.current) placeMenu(menuRef.current, composerSelector, ceilingSelector, ceilingEdge);
      if (keepCaretInView && textareaRef.current) showCaret(textareaRef.current);
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, menuRef, textareaRef, composerSelector, ceilingSelector, ceilingEdge, keepCaretInView, contentKey]);
}
