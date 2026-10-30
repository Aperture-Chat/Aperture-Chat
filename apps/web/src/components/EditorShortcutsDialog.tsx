import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type ShortcutGroup = { title: string; items: Array<[keys: string, action: string]> };

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const ALT = IS_MAC ? "⌥" : "Alt+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

const DOCUMENT_SHORTCUTS: ShortcutGroup[] = [
  {
    title: "AI",
    items: [
      [`${MOD}J`, "Edit the selection with AI, or write at the cursor"],
      ["/", "Command menu at the start of a line"],
    ],
  },
  {
    title: "Editing",
    items: [
      [`${MOD}Z`, "Undo"],
      [`${MOD}${SHIFT}Z`, "Redo"],
      [`${MOD}F`, "Find"],
      [IS_MAC ? `${MOD}${SHIFT}H` : "Ctrl+H", "Find and replace"],
      [`${MOD}K`, "Insert or edit a link"],
      [`${MOD}${SHIFT}V`, "Paste as plain text"],
      ["Tab", "Next table cell · indent a list item"],
    ],
  },
  {
    title: "Formatting",
    items: [
      [`${MOD}B / I / U`, "Bold, italic, underline"],
      [`${MOD}${SHIFT}X`, "Strikethrough"],
      [`${MOD}${ALT}0 – 3`, "Text, Title, Heading, Subheading"],
      [`${MOD}${SHIFT}7 / 8`, "Numbered / bulleted list"],
      [`${MOD}${SHIFT}L / E / R / J`, "Align left, center, right, justify"],
      [`${MOD}\\`, "Clear formatting"],
    ],
  },
  {
    title: "Markdown as you type",
    items: [
      ["# ## ###", "Title, heading, subheading"],
      ["- or 1.", "Bulleted or numbered list"],
      ["> ", "Quote"],
      ["**bold** *italic* `code`", "Inline emphasis"],
      ["--- Enter", "Divider"],
    ],
  },
];

const DECK_SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Slides",
    items: [
      [`${MOD}J`, "Edit the current slide with AI"],
      [`${MOD}D`, "Duplicate slide"],
      [IS_MAC ? `${MOD}${SHIFT}N` : "Ctrl+M", "New slide after this one"],
      ["Delete", "Delete the selected slide (in the slide list)"],
      ["↑ ↓", "Previous / next slide (in the slide list)"],
      [`${ALT}↑ / ↓`, "Move the slide up or down"],
      [`${MOD}Z / ${MOD}${SHIFT}Z`, "Undo / redo"],
    ],
  },
  {
    title: "Text boxes",
    items: [
      ["Drag the frame", "Move a text box (snaps to guides)"],
      ["Arrow keys", "Nudge the selected box (Shift: 10×)"],
      ["Esc", "Leave the text box"],
    ],
  },
  {
    title: "Presenting",
    items: [
      [IS_MAC ? `${MOD}Enter` : "F5", "Present from the first slide"],
      [`${SHIFT}${IS_MAC ? `${MOD}Enter` : "F5"}`, "Present from this slide"],
      ["→ ← Space", "Next / previous"],
      ["Number + Enter", "Jump to a slide"],
      ["B / W", "Black or white screen"],
      ["N", "Speaker notes"],
    ],
  },
];

const SPREADSHEET_SHORTCUTS: ShortcutGroup[] = [
  {
    title: "AI",
    items: [[`${MOD}J`, "Ask AI about the selected cells"]],
  },
  {
    title: "Moving around",
    items: [
      ["Arrow keys", "Move one cell"],
      [`${MOD}Arrow`, "Jump to the edge of the data"],
      [`${SHIFT}Arrow`, "Extend the selection"],
      ["Tab / Enter", "Next cell right / below (Shift: back)"],
      [`${MOD}Home / ${MOD}End`, "First cell / last used cell"],
      ["Page Up / Page Down", "One screen up or down"],
    ],
  },
  {
    title: "Editing",
    items: [
      ["F2", "Edit the cell"],
      ["Esc", "Cancel the edit"],
      ["F4", "Cycle $ anchors on a reference (while editing)"],
      ["Delete", "Clear the contents"],
      [`${MOD}Z / ${MOD}${SHIFT}Z`, "Undo / redo"],
      [`${MOD}C / X / V`, "Copy, cut, paste"],
      [`${MOD}${SHIFT}V`, "Paste values only"],
      [`${MOD}D`, "Fill down"],
      [`${MOD}R`, "Fill right"],
      [`${MOD};`, "Insert today's date"],
      [`${ALT}=`, "AutoSum"],
    ],
  },
  {
    title: "Selecting and formatting",
    items: [
      [`${MOD}A`, "Select the data, then the whole sheet"],
      [`${MOD}Space / ${SHIFT}Space`, "Select the column / row"],
      [`${MOD}B / I / U`, "Bold, italic, underline"],
      [`${MOD}5`, "Strikethrough"],
      [`${MOD}${SHIFT}$ / %`, "Currency / percent format"],
      [`${MOD}${SHIFT}L`, "Turn filters on or off"],
      [`${MOD}F / ${MOD}H`, "Find / find and replace"],
    ],
  },
];

/** Every keyboard shortcut the editor supports, grouped (⌘/). */
export function EditorShortcutsDialog({ kind, onClose }: { kind: "document" | "deck" | "spreadsheet"; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [onClose]);
  const groups = kind === "deck" ? DECK_SHORTCUTS : kind === "spreadsheet" ? SPREADSHEET_SHORTCUTS : DOCUMENT_SHORTCUTS;
  const dialog = (
    <div className="editor-shortcuts-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="editor-shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header>
          <strong>Keyboard shortcuts</strong>
          <button ref={closeRef} type="button" aria-label="Close keyboard shortcuts" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="editor-shortcuts-grid">
          {groups.map((group) => (
            <div key={group.title} className="editor-shortcuts-group">
              <h3>{group.title}</h3>
              <dl>
                {group.items.map(([keys, action]) => (
                  <div key={keys + action}>
                    <dt>{action}</dt>
                    <dd>
                      <kbd>{keys}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
