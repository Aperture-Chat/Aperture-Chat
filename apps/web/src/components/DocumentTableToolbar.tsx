import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Heading,
  Rows3,
  Columns3,
  Trash2,
} from "lucide-react";

export type TableAction =
  | "row-above"
  | "row-below"
  | "column-left"
  | "column-right"
  | "delete-row"
  | "delete-column"
  | "toggle-header"
  | "delete-table";

type Props = {
  getTableRect: () => DOMRect | null;
  onAction: (action: TableAction) => void;
};

const ACTIONS: Array<{ action: TableAction; label: string; icon: typeof Trash2; divider?: boolean }> = [
  { action: "row-above", label: "Insert row above", icon: BetweenHorizontalStart },
  { action: "row-below", label: "Insert row below", icon: BetweenHorizontalEnd },
  { action: "column-left", label: "Insert column left", icon: BetweenVerticalStart },
  { action: "column-right", label: "Insert column right", icon: BetweenVerticalEnd },
  { action: "delete-row", label: "Delete row", icon: Rows3, divider: true },
  { action: "delete-column", label: "Delete column", icon: Columns3 },
  { action: "toggle-header", label: "Header row on or off", icon: Heading, divider: true },
  { action: "delete-table", label: "Delete table", icon: Trash2 },
];

/** Word's table Layout tools, floating over the table the caret is in. */
export function DocumentTableToolbar({ getTableRect, onAction }: Props) {
  const [position, setPosition] = useState<{ top: number; left: number; vertical: boolean } | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const rect = getTableRect();
      if (!rect) return;
      // Beside the table when the page margin has room, so it never covers
      // the text above or below; otherwise above (or below) the table.
      if ((window.innerWidth || 1024) - rect.right > 56) {
        setPosition({ top: Math.max(64, rect.top), left: rect.right + 10, vertical: true });
        return;
      }
      const top = rect.top - 44 < 60 ? rect.bottom + 8 : rect.top - 44;
      setPosition({ top, left: Math.max(8, rect.left), vertical: false });
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
  }, [getTableRect]);

  const toolbar = (
    <div
      className={`document-table-toolbar ${position?.vertical ? "is-vertical" : ""}`}
      role="toolbar"
      aria-label="Table tools"
      aria-orientation={position?.vertical ? "vertical" : "horizontal"}
      style={position ? { top: position.top, left: position.left } : { top: 72, left: 24 }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {ACTIONS.map(({ action, label, icon: Icon, divider }) => (
        <span key={action} className="document-table-tool">
          {divider && <span className="document-selection-divider" aria-hidden="true" />}
          <button
            type="button"
            aria-label={label}
            data-tooltip={label}
            className={action.startsWith("delete") ? "is-destructive" : undefined}
            onClick={() => onAction(action)}
          >
            <Icon size={15} />
          </button>
        </span>
      ))}
    </div>
  );
  return typeof document === "undefined" ? toolbar : createPortal(toolbar, document.body);
}
