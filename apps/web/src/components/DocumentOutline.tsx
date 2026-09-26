import { X } from "lucide-react";

export type DocumentOutlineHeading = { level: 1 | 2 | 3; text: string };

type Props = {
  headings: DocumentOutlineHeading[];
  activeIndex: number;
  onJump: (index: number) => void;
  onClose: () => void;
};

/** Word's Navigation pane: every heading in the document, click to jump. */
export function DocumentOutline({ headings, activeIndex, onJump, onClose }: Props) {
  return (
    <nav className="document-outline" aria-label="Document outline">
      <div className="document-outline-head">
        <strong>Outline</strong>
        <button type="button" aria-label="Close outline" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {headings.length ? (
        <ol>
          {headings.map((heading, index) => (
            <li key={`${index}-${heading.text}`} className={`is-level-${heading.level}`}>
              <button
                type="button"
                aria-current={index === activeIndex ? "location" : undefined}
                onClick={() => onJump(index)}
                title={heading.text}
              >
                {heading.text || "Untitled heading"}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="document-outline-empty">
          Headings you add appear here. Type <kbd>#</kbd> or <kbd>##</kbd> and a space to start one.
        </p>
      )}
    </nav>
  );
}
