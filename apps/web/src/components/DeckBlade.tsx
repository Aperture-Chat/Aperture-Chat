/** The deck editor's side blade: one panel for adding slides, changing a
 * layout, slide pictures, and AI slide edits.
 *
 * It slides out from the editor's left seam — where the assistant drawer
 * lives — and reports its right edge so the slide stage can make room beside
 * it: the slide being worked on stays in view instead of sitting under a
 * popover. Drag its right edge (or use the arrow keys there) to widen it; the
 * width is remembered. Below 640px it covers the editor full-width. Escape or
 * the close button closes it and returns focus to the control that opened it.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

export const DECK_BLADE_MIN_WIDTH = 300;
/** The assistant column's width, so the blade covers exactly that column. */
export const DECK_BLADE_DEFAULT_WIDTH = 380;
export const DECK_BLADE_MAX_WIDTH = 720;
/** Narrower windows get the blade full-width over the editor. */
export const DECK_BLADE_FULL_WIDTH_BELOW = 640;
/** Width the blade always leaves for the slide stage beside it. */
const DECK_BLADE_STAGE_ROOM = 280;
const DECK_BLADE_KEY_STEP = 24;
const DECK_BLADE_EXIT_MS = 240;

export type DeckBladePlacement = {
  left: number;
  width: number;
  /** Covers the editor rather than docking beside the stage. */
  full: boolean;
  min: number;
  max: number;
};

/** Where the blade sits for a preferred width. Exported for tests. */
export function deckBladePlacement(preferred: number, viewportWidth: number, leftEdge: number): DeckBladePlacement {
  const left = Math.max(0, Math.round(leftEdge));
  const room = Math.max(0, viewportWidth - left);
  if (viewportWidth < DECK_BLADE_FULL_WIDTH_BELOW) {
    return { left, width: room, full: true, min: room, max: room };
  }
  const max = Math.max(DECK_BLADE_MIN_WIDTH, Math.min(DECK_BLADE_MAX_WIDTH, room - DECK_BLADE_STAGE_ROOM));
  const wanted = Number.isFinite(preferred) ? preferred : DECK_BLADE_DEFAULT_WIDTH;
  const width = Math.round(Math.max(DECK_BLADE_MIN_WIDTH, Math.min(wanted, max)));
  return { left, width, full: false, min: DECK_BLADE_MIN_WIDTH, max };
}

function prefersReducedMotion() {
  return typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled):not([type='hidden']), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";

type Snapshot = {
  label: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  footer?: ReactNode;
  bare: boolean;
  className: string;
  children: ReactNode;
};

type Props = {
  open: boolean;
  label: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Viewport x of the editor's left seam, read fresh on every placement. */
  getLeftEdge: () => number;
  preferredWidth: number;
  /** Width chosen by dragging or arrow keys; `done` once the gesture ends. */
  onPreferredWidthChange: (width: number, done: boolean) => void;
  /** Right edge in viewport pixels while docked beside the stage; null when
   * closed or covering the editor. */
  onEdgeChange?: (right: number | null) => void;
  onClose: () => void;
  closeLabel?: string;
  /** Escape and the close button wait while false (an upload in flight). */
  dismissible?: boolean;
  /** Focus returns here when the blade closes from inside. */
  returnFocus?: () => HTMLElement | null;
  /** The content brings its own header (the AI composer). */
  bare?: boolean;
  /** A change re-runs first focus: the blade now shows something else. */
  contentKey?: string;
  footer?: ReactNode;
  className?: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
};

export function DeckBlade({
  open,
  label,
  title,
  subtitle,
  icon,
  getLeftEdge,
  preferredWidth,
  onPreferredWidthChange,
  onEdgeChange,
  onClose,
  closeLabel,
  dismissible = true,
  returnFocus,
  bare = false,
  contentKey = "",
  footer,
  className = "",
  onSubmit,
  children,
}: Props) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [present, setPresent] = useState(open);
  const [placement, setPlacement] = useState<DeckBladePlacement | null>(null);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const edgeRef = useRef(onEdgeChange);
  edgeRef.current = onEdgeChange;
  const leftEdgeRef = useRef(getLeftEdge);
  leftEdgeRef.current = getLeftEdge;

  // While closing, the last open content stays on screen for the exit.
  const snapshotRef = useRef<Snapshot | null>(null);
  if (open) {
    snapshotRef.current = { label, title, subtitle, icon, footer, bare, className, children };
  }
  const snapshot = snapshotRef.current;

  useEffect(() => {
    if (open) {
      setPresent(true);
      return undefined;
    }
    if (prefersReducedMotion()) {
      setPresent(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setPresent(false), DECK_BLADE_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  const shown = open || present;

  useLayoutEffect(() => {
    if (!shown) return undefined;
    const place = () => {
      const next = deckBladePlacement(preferredWidth, window.innerWidth || 1024, leftEdgeRef.current());
      setPlacement((current) =>
        current &&
        current.left === next.left &&
        current.width === next.width &&
        current.full === next.full &&
        current.max === next.max
          ? current
          : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [shown, preferredWidth]);

  // The stage makes room only while the blade is open and docked.
  const edge = open && placement && !placement.full ? placement.left + placement.width : null;
  useLayoutEffect(() => {
    edgeRef.current?.(edge);
  }, [edge]);
  useEffect(() => () => edgeRef.current?.(null), []);

  // First focus: the current choice, else the first control in the body.
  useLayoutEffect(() => {
    if (!open || bare) return;
    const root = rootRef.current;
    if (!root) return;
    const body = root.querySelector<HTMLElement>(".deck-blade-body");
    const target =
      root.querySelector<HTMLElement>("[data-blade-initial]") ??
      body?.querySelector<HTMLElement>("[role='menuitem'][aria-current='true']") ??
      body?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)") ??
      body?.querySelector<HTMLElement>(FOCUSABLE) ??
      root;
    target.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contentKey]);

  if (!shown || !snapshot) return null;

  function close() {
    if (!dismissible) return;
    const target = returnFocus?.() ?? null;
    onClose();
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!placement || placement.full || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: placement.width, width: placement.width };
    setResizing(true);
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !placement) return;
    const width = Math.round(Math.max(placement.min, Math.min(placement.max, drag.startWidth + event.clientX - drag.startX)));
    if (width === drag.width) return;
    drag.width = width;
    onPreferredWidthChange(width, false);
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setResizing(false);
    onPreferredWidthChange(drag.width, true);
  }

  function nudgeResize(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!placement || placement.full) return;
    let width: number;
    if (event.key === "ArrowLeft") width = placement.width - DECK_BLADE_KEY_STEP;
    else if (event.key === "ArrowRight") width = placement.width + DECK_BLADE_KEY_STEP;
    else if (event.key === "Home") width = placement.min;
    else if (event.key === "End") width = placement.max;
    else if (event.key === "Enter") width = DECK_BLADE_DEFAULT_WIDTH;
    else return;
    event.preventDefault();
    onPreferredWidthChange(Math.max(placement.min, Math.min(placement.max, width)), true);
  }

  const style = placement
    ? { left: placement.left, width: placement.width }
    : { left: 0, width: DECK_BLADE_DEFAULT_WIDTH, visibility: "hidden" as const };
  const common = {
    className: `deck-blade ${snapshot.bare ? "is-bare" : ""} ${resizing ? "is-resizing" : ""} ${snapshot.className}`,
    // A bare blade hosts its own dialog (the AI composer); only a blade with
    // its own header is the dialog.
    role: snapshot.bare ? undefined : "dialog",
    "aria-label": snapshot.bare ? undefined : snapshot.label,
    "aria-modal": snapshot.bare ? undefined : false,
    "aria-hidden": open ? undefined : true,
    "data-state": open ? "open" : "closing",
    "data-full": placement?.full ? "true" : undefined,
    inert: open ? undefined : true,
    tabIndex: -1,
    style,
    onKeyDown: handleKeyDown,
  };
  const content = (
    <>
      {!snapshot.bare && (
        <header className="deck-blade-head">
          {snapshot.icon && (
            <span className="deck-blade-icon" aria-hidden="true">
              {snapshot.icon}
            </span>
          )}
          <span className="deck-blade-heading">
            <strong>{snapshot.title ?? snapshot.label}</strong>
            {snapshot.subtitle && <span>{snapshot.subtitle}</span>}
          </span>
          <button
            type="button"
            className="deck-blade-close"
            aria-label={closeLabel ?? `Close ${snapshot.label.toLowerCase()}`}
            data-tooltip="Close (Esc)"
            disabled={!dismissible}
            onClick={close}
          >
            <X size={16} />
          </button>
        </header>
      )}
      <div className="deck-blade-body">{snapshot.children}</div>
      {snapshot.footer && <footer className="deck-blade-foot">{snapshot.footer}</footer>}
      {placement && !placement.full && (
        <div
          className="deck-blade-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          aria-valuemin={placement.min}
          aria-valuemax={placement.max}
          aria-valuenow={placement.width}
          tabIndex={0}
          data-tooltip="Drag to resize · double-click resets"
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={() => onPreferredWidthChange(DECK_BLADE_DEFAULT_WIDTH, true)}
          onKeyDown={nudgeResize}
        />
      )}
    </>
  );
  if (onSubmit) {
    return (
      <form {...common} ref={(element) => { rootRef.current = element; }} onSubmit={onSubmit}>
        {content}
      </form>
    );
  }
  return (
    <section {...common} ref={(element) => { rootRef.current = element; }}>
      {content}
    </section>
  );
}
