import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import type { AiComposerAnchor } from "./AiEditComposer";

export type SlashCommandItem = {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  /** Markdown shortcut or key hint shown on the right. */
  hint?: string;
  keywords?: string;
};

type Props = {
  getAnchor: () => AiComposerAnchor | null;
  items: SlashCommandItem[];
  activeIndex: number;
  query: string;
  onPick: (item: SlashCommandItem) => void;
  onHover: (index: number) => void;
};

/**
 * The "/" command menu: typing a slash at the start of a line (or after a
 * space) lists the blocks, inserts, and AI actions the page supports. Focus
 * stays in the document; the editor's key handler drives the highlight.
 */
export function DocumentSlashMenu({ getAnchor, items, activeIndex, query, onPick, onHover }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left: number }>({
    top: 120,
    left: 40,
  });

  useLayoutEffect(() => {
    const anchor = getAnchor();
    if (!anchor) return;
    const viewportHeight = window.innerHeight || 768;
    const viewportWidth = window.innerWidth || 1024;
    const left = Math.max(8, Math.min(anchor.left - 8, viewportWidth - 300));
    if (viewportHeight - anchor.bottom > 330 || anchor.top < 330) {
      setPosition({ top: anchor.bottom + 6, left });
    } else {
      setPosition({ bottom: viewportHeight - anchor.top + 6, left });
    }
  }, [getAnchor, query]);

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-slash-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  let lastGroup = "";
  const menu = (
    <div
      className="document-slash-menu"
      role="listbox"
      aria-label="Insert block"
      style={position}
      ref={listRef}
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length === 0 ? (
        <p className="document-slash-empty">No matching blocks for “{query}”.</p>
      ) : (
        items.map((item, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          const Icon = item.icon;
          return (
            <div key={item.id} role="presentation">
              {header && <span className="document-slash-group">{header}</span>}
              <button
                type="button"
                role="option"
                data-slash-index={index}
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "is-active" : undefined}
                onMouseEnter={() => onHover(index)}
                onClick={() => onPick(item)}
              >
                <span className="document-slash-icon" aria-hidden="true">
                  <Icon size={15} />
                </span>
                <span className="document-slash-label">{item.label}</span>
                {item.hint && <kbd>{item.hint}</kbd>}
              </button>
            </div>
          );
        })
      )}
      <p className="document-slash-foot" aria-hidden="true">
        ↑↓ to choose · Enter to insert · Esc to close
      </p>
    </div>
  );
  return typeof document === "undefined" ? menu : createPortal(menu, document.body);
}
