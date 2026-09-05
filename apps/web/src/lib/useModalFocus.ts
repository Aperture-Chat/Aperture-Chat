import { useEffect, useRef, type RefObject } from "react";

/** Keep keyboard navigation inside a modal, then return to its entry point. */
export function useModalFocus<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  onClose: () => void,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const panel = ref.current;
    if (!active || !panel) return;
    const previousFocus = document.activeElement;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,iframe,[contenteditable="true"],[tabindex]',
    )).filter((element) => {
      const style = window.getComputedStyle(element);
      const closedDetails = element.closest("details:not([open])");
      return element.tabIndex >= 0 && !element.closest("[hidden],[inert]") && style.display !== "none" &&
        style.visibility !== "hidden" && (!closedDetails || element.closest("summary"));
    });
    const ownsFocus = () => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      const topDialog = dialogs[dialogs.length - 1];
      return !topDialog || topDialog === panel || topDialog.contains(panel);
    };
    let entryFrame = 0;
    let entryAttempts = 8;
    const focusEntry = () => {
      const current = document.activeElement;
      if (panel.contains(current) || !ownsFocus()) return;
      // Do not steal focus after the user or a newly opened dialog moves it.
      if (current !== previousFocus && current !== document.body && current !== document.documentElement) return;
      const style = window.getComputedStyle(panel);
      if (!panel.closest("[hidden],[inert]") && style.visibility !== "hidden" && style.display !== "none") {
        (focusable()[0] ?? panel).focus({ preventScroll: true });
      }
      // Chromium can retain visibility:hidden through the first opening frame.
      // Keep retries bounded, and cancel them as soon as focus lands or closes.
      if (!panel.contains(document.activeElement) && --entryAttempts > 0) {
        entryFrame = window.requestAnimationFrame(focusEntry);
      }
    };
    focusEntry();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      // A nested dialog owns Escape and Tab until it closes.
      if (!ownsFocus()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const targets = focusable();
        const first = targets[0];
        const last = targets[targets.length - 1];
        if (!first) {
          event.preventDefault();
          panel.focus();
        } else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(entryFrame);
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [active, ref]);
}
