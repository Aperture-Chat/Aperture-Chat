/** PowerPoint-style mini toolbar for slide text. It floats just above the text
 * box being edited (below it when the box sits at the top of the window) and
 * formats the highlighted text — or, with nothing highlighted, the whole box,
 * the way PowerPoint formats a selected text box.
 *
 * Every control keeps focus and the selection in the text box (mousedown is
 * swallowed), so it acts on exactly what is highlighted. Alt+F10 in a text box
 * moves focus here; Escape returns it to the text.
 */

import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  AArrowDown,
  AArrowUp,
  Baseline,
  Bold,
  ChevronDown,
  IndentDecrease,
  IndentIncrease,
  Italic,
  RemoveFormatting,
  Sparkles,
  Strikethrough,
  Underline,
} from "lucide-react";
import type { AiComposerAnchor } from "./AiEditComposer";
import { DECK_TEXT_SIZES } from "../lib/deck/deckTextFormat";

export type DeckTextToolbarFormat = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  /** Point size of the target text; null when it mixes sizes. */
  sizePt: number | null;
  /** The layout's own size for the target text. */
  layoutSizePt: number | null;
  isList: boolean;
  /** Highlighted text (true) or the whole box (false). */
  hasSelection: boolean;
  /** How the box's text sits in it, measured as the export lays it out. */
  fit: "fits" | "shrunk" | "overflow";
};

export type DeckTextCommand = "bold" | "italic" | "underline" | "strikeThrough";

type Rect = AiComposerAnchor;

type Props = {
  getAnchor: () => AiComposerAnchor | null;
  /** Other boxes on the slide the toolbar should not cover, so they stay
   * clickable. */
  getObstacles?: () => Rect[];
  /** The slide's on-screen frame; the toolbar may sit just outside it. */
  getFrame?: () => Rect | null;
  /** Bumped when the anchor moves without a scroll or resize (typing,
   * moving the box, the stage rescaling). */
  layoutKey: string;
  format: DeckTextToolbarFormat;
  palette: Array<{ color: string; label: string }>;
  aiDisabledReason: string | null;
  onAskAi: () => void;
  onCommand: (command: DeckTextCommand) => void;
  onSize: (sizePt: number | null) => void;
  onStepSize: (direction: 1 | -1) => void;
  onColor: (color: string | null) => void;
  onIndent: (direction: 1 | -1) => void;
  onClear: () => void;
  /** Focus back to the text box, selection restored. */
  onReturn: () => void;
  /** Keyboard focus left the toolbar for somewhere other than slide text. */
  onLeave: () => void;
};

const GAP = 10;

function overlaps(a: Rect, b: Rect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Where the toolbar goes: just above its text box, else just below it, else
 * just above or below the slide — the first spot inside the window that
 * covers no other box on the slide. With none free it sits above the box.
 * Exported for tests. */
export function placeDeckTextToolbar(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  obstacles: Rect[] = [],
  frame: Rect | null = null,
): { top: number; left: number; below: boolean } {
  const center = (anchor.left + anchor.right) / 2;
  const left = Math.round(Math.max(8, Math.min(center - size.width / 2, viewport.width - size.width - 8)));
  const spots = [
    { top: anchor.top - size.height - GAP, below: false },
    { top: anchor.bottom + GAP, below: true },
    ...(frame
      ? [
          { top: frame.top - size.height - GAP, below: false },
          { top: frame.bottom + GAP, below: true },
        ]
      : []),
  ];
  const fits = (top: number) => top >= 8 && top + size.height <= viewport.height - 8;
  const free = spots.find(({ top }) => {
    if (!fits(top)) return false;
    const rect = { top, bottom: top + size.height, left, right: left + size.width };
    return !overlaps(rect, anchor) && obstacles.every((obstacle) => !overlaps(rect, obstacle));
  });
  const spot = free ?? spots.find(({ top }) => fits(top)) ?? spots[0];
  return {
    top: Math.round(Math.max(8, Math.min(spot.top, viewport.height - size.height - 8))),
    left,
    below: spot.below,
  };
}

export function DeckTextToolbar({
  getAnchor,
  getObstacles,
  getFrame,
  layoutKey,
  format,
  palette,
  aiDisabledReason,
  onAskAi,
  onCommand,
  onSize,
  onStepSize,
  onColor,
  onIndent,
  onClear,
  onReturn,
  onLeave,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<"size" | "color" | null>(null);
  // Low on screen the menus open upward, so they never run off the bottom.
  const [menuUp, setMenuUp] = useState(false);
  function toggleMenu(name: "size" | "color") {
    const rect = ref.current?.getBoundingClientRect();
    setMenuUp(Boolean(rect && rect.bottom + 280 > (window.innerHeight || 768) && rect.top > 280));
    setMenu((value) => (value === name ? null : name));
  }
  const [position, setPosition] = useState<{ top: number; left: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const anchor = getAnchor();
      if (!anchor) return;
      const next = placeDeckTextToolbar(
        anchor,
        { width: ref.current?.offsetWidth || 420, height: ref.current?.offsetHeight || 40 },
        { width: window.innerWidth || 1024, height: window.innerHeight || 768 },
        getObstacles?.() ?? [],
        getFrame?.() ?? null,
      );
      setPosition((current) =>
        current && current.top === next.top && current.left === next.left && current.below === next.below
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [getAnchor, getObstacles, getFrame, layoutKey]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (menu) setMenu(null);
      else onReturn();
      return;
    }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(".deck-text-toolbar-row > button:not(:disabled), .deck-text-toolbar-row > span > button:not(:disabled)"),
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    next?.focus();
  }

  const scope = format.hasSelection ? "the highlighted text" : "the whole text box";
  const sizeLabel = format.sizePt === null ? "–" : String(format.sizePt);
  const toolbar = (
    <div
      ref={ref}
      className={`deck-text-toolbar ${position?.below ? "is-below" : ""}`}
      role="toolbar"
      aria-label="Slide text formatting"
      style={position ? { top: position.top, left: position.left } : { top: 72, left: 24, visibility: "hidden" }}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget as HTMLElement | null;
        if (next && (event.currentTarget.contains(next) || next.closest?.("[data-deck-block]"))) return;
        setMenu(null);
        onLeave();
      }}
    >
      <div className="deck-text-toolbar-row">
        <button
          type="button"
          className="deck-text-toolbar-ai"
          aria-label={format.hasSelection ? "Ask AI to edit highlighted slide text" : "Edit this slide with AI"}
          data-tooltip={aiDisabledReason ?? (format.hasSelection ? "Rewrite the highlighted text with AI (⌘J)" : "Edit this slide with AI (⌘J)")}
          disabled={Boolean(aiDisabledReason)}
          onClick={onAskAi}
        >
          <Sparkles size={14} />
          Ask AI
        </button>
        <span className="deck-text-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          aria-label="Decrease font size"
          data-tooltip={`Smaller text for ${scope} (⇧⌘<)`}
          disabled={format.sizePt !== null && format.sizePt <= DECK_TEXT_SIZES[0]}
          onClick={() => onStepSize(-1)}
        >
          <AArrowDown size={16} />
        </button>
        <span className="deck-text-toolbar-menu-wrap">
          <button
            type="button"
            className="deck-text-toolbar-size"
            aria-label={`Font size: ${format.sizePt === null ? "mixed" : `${format.sizePt} point`}`}
            aria-haspopup="menu"
            aria-expanded={menu === "size"}
            data-tooltip={`Font size of ${scope}, in PowerPoint points`}
            onClick={() => toggleMenu("size")}
          >
            {sizeLabel}
            <ChevronDown size={12} />
          </button>
          {menu === "size" && (
            <span className={`deck-text-toolbar-menu is-sizes ${menuUp ? "is-up" : ""}`} role="menu" aria-label="Font sizes">
              <button
                type="button"
                role="menuitem"
                className="is-reset"
                onClick={() => {
                  setMenu(null);
                  onSize(null);
                }}
              >
                Layout size{format.layoutSizePt ? ` (${format.layoutSizePt})` : ""}
              </button>
              {DECK_TEXT_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  role="menuitemradio"
                  aria-checked={format.sizePt === size}
                  onClick={() => {
                    setMenu(null);
                    onSize(size);
                  }}
                >
                  {size}
                </button>
              ))}
            </span>
          )}
        </span>
        <button
          type="button"
          aria-label="Increase font size"
          data-tooltip={`Larger text for ${scope} (⇧⌘>)`}
          disabled={format.sizePt !== null && format.sizePt >= DECK_TEXT_SIZES[DECK_TEXT_SIZES.length - 1]}
          onClick={() => onStepSize(1)}
        >
          <AArrowUp size={16} />
        </button>
        <span className="deck-text-toolbar-divider" aria-hidden="true" />
        <button type="button" aria-label="Bold" aria-pressed={format.bold} data-tooltip={`Bold ${scope} (⌘B)`} onClick={() => onCommand("bold")}>
          <Bold size={15} />
        </button>
        <button type="button" aria-label="Italic" aria-pressed={format.italic} data-tooltip={`Italicize ${scope} (⌘I)`} onClick={() => onCommand("italic")}>
          <Italic size={15} />
        </button>
        <button type="button" aria-label="Underline" aria-pressed={format.underline} data-tooltip={`Underline ${scope} (⌘U)`} onClick={() => onCommand("underline")}>
          <Underline size={15} />
        </button>
        <button
          type="button"
          aria-label="Strikethrough"
          aria-pressed={format.strikethrough}
          data-tooltip={`Strike through ${scope}`}
          onClick={() => onCommand("strikeThrough")}
        >
          <Strikethrough size={15} />
        </button>
        <span className="deck-text-toolbar-menu-wrap">
          <button
            type="button"
            aria-label="Text color"
            aria-haspopup="menu"
            aria-expanded={menu === "color"}
            data-tooltip={`Color ${scope} from the deck's theme`}
            onClick={() => toggleMenu("color")}
          >
            <Baseline size={16} />
            <ChevronDown size={12} />
          </button>
          {menu === "color" && (
            <span className={`deck-text-toolbar-menu is-swatches ${menuUp ? "is-up" : ""}`} role="menu" aria-label="Theme colors">
              {palette.map((swatch) => (
                <button
                  key={swatch.color}
                  type="button"
                  role="menuitem"
                  aria-label={swatch.label}
                  data-tooltip={swatch.label}
                  style={{ background: swatch.color }}
                  onClick={() => {
                    setMenu(null);
                    onColor(swatch.color);
                  }}
                />
              ))}
              <button
                type="button"
                role="menuitem"
                className="is-reset"
                onClick={() => {
                  setMenu(null);
                  onColor(null);
                }}
              >
                Theme color
              </button>
            </span>
          )}
        </span>
        {format.isList && (
          <>
            <span className="deck-text-toolbar-divider" aria-hidden="true" />
            <button type="button" aria-label="Decrease list level" data-tooltip="Move the bullet out a level (⇧Tab)" onClick={() => onIndent(-1)}>
              <IndentDecrease size={15} />
            </button>
            <button type="button" aria-label="Increase list level" data-tooltip="Move the bullet in a level (Tab)" onClick={() => onIndent(1)}>
              <IndentIncrease size={15} />
            </button>
          </>
        )}
        <span className="deck-text-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          aria-label="Clear formatting"
          data-tooltip={`Return ${scope} to the layout's formatting`}
          onClick={onClear}
        >
          <RemoveFormatting size={15} />
        </button>
      </div>
      {(format.fit !== "fits" || !format.hasSelection) && (
        <span className="deck-text-toolbar-notes">
          {format.fit === "overflow" && (
            <span className="deck-text-toolbar-scope is-warning" role="status">
              Text overflows this box · shorten it, size it down, or drag a corner
            </span>
          )}
          {format.fit === "shrunk" && (
            <span className="deck-text-toolbar-scope" role="status">
              Shrunk to fit, as PowerPoint does
            </span>
          )}
          {!format.hasSelection && <span className="deck-text-toolbar-scope">Whole box · highlight text to format part of it</span>}
        </span>
      )}
    </div>
  );

  return typeof document === "undefined" ? toolbar : createPortal(toolbar, document.body);
}
