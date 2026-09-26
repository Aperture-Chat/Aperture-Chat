import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  ChevronDown,
  Highlighter,
  Italic,
  Link2,
  Sparkles,
  Strikethrough,
  Underline,
} from "lucide-react";
import type { AiComposerAnchor } from "./AiEditComposer";

export type SelectionToolbarFormat = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  blockStyle: string;
};

const BLOCK_STYLE_OPTIONS = [
  { value: "p", label: "Paragraph" },
  { value: "h1", label: "Title" },
  { value: "h2", label: "Heading" },
  { value: "h3", label: "Subheading" },
  { value: "blockquote", label: "Quote" },
  { value: "ul", label: "Bulleted list" },
  { value: "ol", label: "Numbered list" },
];

const HIGHLIGHTS = [
  { color: "#fff3a3", label: "Yellow" },
  { color: "#c9f2d9", label: "Green" },
  { color: "#cfe6ff", label: "Blue" },
  { color: "#ffd6e7", label: "Pink" },
];

type Props = {
  getAnchor: () => AiComposerAnchor | null;
  format: SelectionToolbarFormat;
  aiDisabledReason: string | null;
  onAskAi: () => void;
  onCommand: (command: "bold" | "italic" | "underline" | "strikeThrough") => void;
  onBlockStyle: (value: string) => void;
  onLink: () => void;
  onHighlight: (color: string | null) => void;
};

/**
 * Word-style mini toolbar that floats above highlighted document text: AI edit
 * first, then the formatting people reach for most. Every control keeps the
 * page selection (mousedown is swallowed), so it formats exactly what is
 * highlighted.
 */
export function DocumentSelectionToolbar({
  getAnchor,
  format,
  aiDisabledReason,
  onAskAi,
  onCommand,
  onBlockStyle,
  onLink,
  onHighlight,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<"style" | "highlight" | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const anchor = getAnchor();
      const width = ref.current?.offsetWidth || 360;
      const height = ref.current?.offsetHeight || 40;
      if (!anchor) return;
      const viewportWidth = window.innerWidth || 1024;
      const center = (anchor.left + anchor.right) / 2;
      const left = Math.max(8, Math.min(center - width / 2, viewportWidth - width - 8));
      const below = anchor.top - height - 10 < 64;
      const top = below ? anchor.bottom + 10 : anchor.top - height - 10;
      setPosition({ top, left, below });
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
  }, [getAnchor]);

  const styleLabel =
    BLOCK_STYLE_OPTIONS.find((option) => option.value === format.blockStyle)?.label ?? "Paragraph";

  const toolbar = (
    <div
      ref={ref}
      className={`document-selection-toolbar ${position?.below ? "is-below" : ""}`}
      role="toolbar"
      aria-label="Selection formatting"
      // Placement runs in a layout effect before paint; the fallback only
      // shows where ranges cannot be measured (non-browser runtimes).
      style={position ? { top: position.top, left: position.left } : { top: 72, left: 24 }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="document-selection-ai"
        aria-label="Ask AI to edit highlighted text"
        data-tooltip={aiDisabledReason ?? "Rewrite, shorten, translate or restyle with AI (⌘J)"}
        disabled={Boolean(aiDisabledReason)}
        onClick={onAskAi}
      >
        <Sparkles size={14} />
        Ask AI
      </button>
      <span className="document-selection-divider" aria-hidden="true" />
      <div className="document-selection-menu-wrap">
        <button
          type="button"
          className="document-selection-style"
          aria-label={`Text style: ${styleLabel}`}
          aria-haspopup="menu"
          aria-expanded={menu === "style"}
          onClick={() => setMenu((value) => (value === "style" ? null : "style"))}
        >
          {styleLabel}
          <ChevronDown size={12} />
        </button>
        {menu === "style" && (
          <div className="document-selection-menu" role="menu" aria-label="Text styles">
            {BLOCK_STYLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === format.blockStyle}
                className={`is-${option.value}`}
                onClick={() => {
                  setMenu(null);
                  onBlockStyle(option.value);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="document-selection-divider" aria-hidden="true" />
      <button type="button" aria-label="Bold selected text" aria-pressed={format.bold} data-tooltip="Bold (⌘B)" onClick={() => onCommand("bold")}>
        <Bold size={15} />
      </button>
      <button type="button" aria-label="Italicize selected text" aria-pressed={format.italic} data-tooltip="Italic (⌘I)" onClick={() => onCommand("italic")}>
        <Italic size={15} />
      </button>
      <button type="button" aria-label="Underline selected text" aria-pressed={format.underline} data-tooltip="Underline (⌘U)" onClick={() => onCommand("underline")}>
        <Underline size={15} />
      </button>
      <button
        type="button"
        aria-label="Strike through selected text"
        aria-pressed={format.strikethrough}
        data-tooltip="Strikethrough (⌘⇧X)"
        onClick={() => onCommand("strikeThrough")}
      >
        <Strikethrough size={15} />
      </button>
      <button type="button" aria-label="Link selected text" data-tooltip="Link (⌘K)" onClick={onLink}>
        <Link2 size={15} />
      </button>
      <div className="document-selection-menu-wrap">
        <button
          type="button"
          aria-label="Highlight selected text"
          aria-haspopup="menu"
          aria-expanded={menu === "highlight"}
          data-tooltip="Highlight"
          onClick={() => setMenu((value) => (value === "highlight" ? null : "highlight"))}
        >
          <Highlighter size={15} />
        </button>
        {menu === "highlight" && (
          <div className="document-selection-menu is-swatches" role="menu" aria-label="Highlight colors">
            {HIGHLIGHTS.map((swatch) => (
              <button
                key={swatch.color}
                type="button"
                role="menuitem"
                aria-label={`${swatch.label} highlight`}
                style={{ background: swatch.color }}
                onClick={() => {
                  setMenu(null);
                  onHighlight(swatch.color);
                }}
              />
            ))}
            <button
              type="button"
              role="menuitem"
              className="is-clear"
              aria-label="Remove highlight"
              onClick={() => {
                setMenu(null);
                onHighlight(null);
              }}
            >
              None
            </button>
          </div>
        )}
      </div>
    </div>
  );
  return typeof document === "undefined" ? toolbar : createPortal(toolbar, document.body);
}
