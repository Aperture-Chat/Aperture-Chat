import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  commandMenuKeyAction,
  detectComposerCommandToken,
  type ComposerCommandSymbol,
  type ComposerCommandToken,
} from "./composerCommands";

type Token = ComposerCommandToken | null;
type Caret = { value: string; caret: number };

function samePlace(a: Token, b: Token) {
  return a?.symbol === b?.symbol && a?.start === b?.start;
}

function sameToken(a: Token, b: Token) {
  return samePlace(a, b) && a?.query === b?.query;
}

function tokenAt(target: HTMLTextAreaElement, symbols?: readonly ComposerCommandSymbol[]): Token {
  const found = detectComposerCommandToken(target.value, target.selectionStart);
  return found && (!symbols || symbols.includes(found.symbol)) ? found : null;
}

function caretOf(textarea: HTMLTextAreaElement | null): Caret | null {
  return textarea ? { value: textarea.value, caret: textarea.selectionStart } : null;
}

function sameCaret(a: Caret | null, target: HTMLTextAreaElement) {
  return a?.value === target.value && a.caret === target.selectionStart;
}

/** Which symbol the caret is sitting on in a composer, if any, and which choice
 * in its menu is highlighted. ``symbols`` limits it to the symbols a composer has. */
export function useComposerCommandToken(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  symbols?: readonly ComposerCommandSymbol[],
) {
  const [token, setToken] = useState<Token>(null);
  const [index, setIndex] = useState(0);
  const dismissedRef = useRef<Caret | null>(null);

  function clear() {
    setToken(null);
  }

  /** Stays closed until the text or caret moves, so Escape is not undone by the
   * selection event that follows it. */
  function dismiss() {
    dismissedRef.current = caretOf(textareaRef.current);
    clear();
  }

  function update(target: HTMLTextAreaElement) {
    if (sameCaret(dismissedRef.current, target)) return;
    dismissedRef.current = null;
    const next = tokenAt(target, symbols);
    setToken((current) => {
      if (sameToken(current, next)) return current;
      if (!samePlace(current, next)) setIndex(0);
      return next;
    });
  }

  /** Answers a key while the list is open. True when the key was used up, so
   * send-on-Enter does not also fire. */
  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>, count: number, pick: (index: number) => void) {
    const action = token ? commandMenuKeyAction(event, count, index) : null;
    if (!action) return false;
    if (action.type === "dismiss") {
      dismiss();
      if (action.keepKey) return false;
      // One press closes one thing: a drawer or editor around this list listens
      // on the document and would close along with it.
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    event.preventDefault();
    if (action.type === "move") setIndex(action.index);
    else pick(action.index);
    return true;
  }

  return { token, index, setIndex, update, dismiss, clear, handleKey };
}
