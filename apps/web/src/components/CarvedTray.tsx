import { forwardRef, type KeyboardEvent, type ReactNode } from "react";

const PAGE_KEYS = new Set(["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"]);

/** The recessed floor a panel's content sits on. The panel holds still and the
 * content scrolls under the tray's carved rim, so the rim is always in view. */
export const CarvedTray = forwardRef<HTMLDivElement, { children: ReactNode }>(function CarvedTray({ children }, ref) {
  return (
    <div className="carved-tray">
      <div className="carved-tray-scroll" ref={ref} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
});

/** A browser scrolls from the focused element outward, and a panel's header is
 * beside its tray, not inside it. Moving focus before the key's default action
 * lets the browser scroll the tray exactly as it scrolled the whole panel. */
export function sendScrollKeysToTray(event: KeyboardEvent, tray: HTMLElement | null) {
  if (tray && PAGE_KEYS.has(event.key) && !tray.contains(event.target as Node)) {
    tray.focus();
  }
}
