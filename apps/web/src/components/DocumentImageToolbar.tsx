import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlignCenter, AlignLeft, AlignRight, Trash2 } from "lucide-react";
import { MEDIA_SIZE_LABELS, type MediaAlign, type MediaSize } from "../lib/documentMedia";

type Props = {
  getRect: () => DOMRect | null;
  size: MediaSize;
  align: MediaAlign;
  alt: string;
  onSize: (size: MediaSize) => void;
  onAlign: (align: MediaAlign) => void;
  onAlt: (alt: string) => void;
  onDelete: () => void;
};

const SIZES: MediaSize[] = ["sm", "md", "lg", "full"];
const ALIGNS: Array<{ value: MediaAlign; label: string; icon: typeof AlignLeft }> = [
  { value: "left", label: "Align picture left", icon: AlignLeft },
  { value: "center", label: "Center picture", icon: AlignCenter },
  { value: "right", label: "Align picture right", icon: AlignRight },
];

/** Picture tools: size, alignment, alt text, delete. */
export function DocumentImageToolbar({ getRect, size, align, alt, onSize, onAlign, onAlt, onDelete }: Props) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [outline, setOutline] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [altDraft, setAltDraft] = useState(alt);
  useLayoutEffect(() => setAltDraft(alt), [alt]);
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const rect = getRect();
      if (!rect) return;
      const width = 520;
      const top = rect.top - 50 < 60 ? rect.bottom + 8 : rect.top - 50;
      const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
      setPosition({ top, left });
      setOutline({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
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
  }, [getRect, size, align]);

  const toolbar = (
    <div
      className="document-image-toolbar"
      role="toolbar"
      aria-label="Picture tools"
      style={position ?? { top: 72, left: 24 }}
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest("input")) event.preventDefault();
      }}
    >
      <div className="document-image-sizes" role="group" aria-label="Picture size">
        {SIZES.map((option) => (
          <button key={option} type="button" aria-pressed={size === option} onClick={() => onSize(option)}>
            {MEDIA_SIZE_LABELS[option]}
          </button>
        ))}
      </div>
      <span className="document-selection-divider" aria-hidden="true" />
      {ALIGNS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className="document-image-icon"
          aria-label={label}
          aria-pressed={align === value}
          data-tooltip={label}
          onClick={() => onAlign(value)}
        >
          <Icon size={15} />
        </button>
      ))}
      <span className="document-selection-divider" aria-hidden="true" />
      <input
        type="text"
        value={altDraft}
        aria-label="Alt text"
        placeholder="Alt text"
        onChange={(event) => setAltDraft(event.target.value)}
        onBlur={() => altDraft !== alt && onAlt(altDraft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onAlt(altDraft);
          }
        }}
      />
      <button type="button" className="document-image-icon is-destructive" aria-label="Delete picture" onClick={onDelete}>
        <Trash2 size={15} />
      </button>
    </div>
  );
  const chrome = (
    <>
      {outline && <div className="document-image-outline" aria-hidden="true" style={outline} />}
      {toolbar}
    </>
  );
  return typeof document === "undefined" ? chrome : createPortal(chrome, document.body);
}
