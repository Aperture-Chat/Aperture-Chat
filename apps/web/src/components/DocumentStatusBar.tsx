import { Keyboard, ListTree, Minus, Plus, TextSearch } from "lucide-react";

export const DOCUMENT_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

type Props = {
  page: number;
  pageCount: number;
  words: number;
  characters: number;
  /** Words in the current selection; null when nothing is highlighted. */
  selectionWords: number | null;
  zoom: number;
  outlineOpen: boolean;
  onZoomChange: (zoom: number) => void;
  onToggleOutline: () => void;
  onOpenFind: () => void;
  onShowShortcuts: () => void;
};

/** Word-style status bar: page, counts, reading time, outline, find, zoom. */
export function DocumentStatusBar({
  page,
  pageCount,
  words,
  characters,
  selectionWords,
  zoom,
  outlineOpen,
  onZoomChange,
  onToggleOutline,
  onOpenFind,
  onShowShortcuts,
}: Props) {
  const minutes = Math.max(1, Math.round(words / 230));
  const index = DOCUMENT_ZOOM_STEPS.findIndex((step) => Math.abs(step - zoom) < 0.001);
  const stepDown = DOCUMENT_ZOOM_STEPS.filter((step) => step < zoom - 0.001).pop();
  const stepUp = DOCUMENT_ZOOM_STEPS.find((step) => step > zoom + 0.001);
  return (
    <footer className="document-status-bar" aria-label="Document status">
      <div className="document-status-facts">
        <span>
          Page {page} of {pageCount}
        </span>
        <span aria-live="polite">
          {selectionWords !== null
            ? `${selectionWords.toLocaleString()} of ${words.toLocaleString()} words`
            : `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`}
        </span>
        <span className="document-status-optional">{characters.toLocaleString()} characters</span>
        {words > 0 && <span className="document-status-optional">{minutes} min read</span>}
      </div>
      <div className="document-status-tools">
        <button
          type="button"
          aria-label="Document outline"
          aria-pressed={outlineOpen}
          data-tooltip="Show the headings as a clickable outline"
          onClick={onToggleOutline}
        >
          <ListTree size={14} />
          <span>Outline</span>
        </button>
        <button type="button" aria-label="Find and replace" data-tooltip="Find and replace (⌘F)" onClick={onOpenFind}>
          <TextSearch size={14} />
          <span>Find</span>
        </button>
        <button type="button" aria-label="Keyboard shortcuts" data-tooltip="Keyboard shortcuts (⌘/)" onClick={onShowShortcuts}>
          <Keyboard size={14} />
        </button>
        <div className="document-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={stepDown === undefined}
            onClick={() => stepDown !== undefined && onZoomChange(stepDown)}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            className="document-zoom-value"
            aria-label={`Zoom ${Math.round(zoom * 100)} percent. Reset to 100 percent`}
            data-tooltip="Reset zoom to 100%"
            onClick={() => onZoomChange(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={stepUp === undefined || index === DOCUMENT_ZOOM_STEPS.length - 1}
            onClick={() => stepUp !== undefined && onZoomChange(stepUp)}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
    </footer>
  );
}
