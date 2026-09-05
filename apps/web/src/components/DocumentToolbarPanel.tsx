import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";

type Props = {
  label: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
};

/** A nonmodal panel keeps the editor selection available for formatting. */
export function DocumentToolbarPanel({ label, title, open, onToggle, onClose, children }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const insidePointer = useRef<PointerEvent | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 400 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 8, maxHeight: Math.max(120, window.innerHeight - rect.bottom - 20) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      // React capture also sees owned popups rendered through a portal.
      if (insidePointer.current !== event && !root.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, onClose]);
  return (
    <div ref={root} className="document-tool-panel-control"
      onPointerDownCapture={event => { insidePointer.current = event.nativeEvent; }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onClose(); }}
      onKeyDown={event => {
        if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); onClose(); trigger.current?.focus();
        }
      }}>
      <button ref={trigger} type="button" className="document-tool-panel-trigger"
        aria-label={`${label} options`} aria-expanded={open} aria-controls={id}
        onMouseDown={event => event.preventDefault()}
        onClick={onToggle}
        onKeyDown={event => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) onToggle();
            requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[data-panel-content] button:not(:disabled),[data-panel-content] select,[data-panel-content] input')?.focus());
          }
        }}>
        {label}<ChevronDown size={12} />
      </button>
      <div ref={panel} id={id} className="document-tool-panel" role="region" aria-label={title} hidden={!open} style={position}>
        <div className="document-tool-panel-heading"><strong>{title}</strong>
          <button type="button" aria-label={`Close ${label.toLowerCase()} options`} onClick={() => { onClose(); trigger.current?.focus(); }}><X size={14} /></button>
        </div>
        <div data-panel-content>{children}</div>
      </div>
    </div>
  );
}
