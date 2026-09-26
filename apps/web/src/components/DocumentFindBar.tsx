import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronUp, Replace, X } from "lucide-react";

type Props = {
  query: string;
  replacement: string;
  matchCase: boolean;
  wholeWord: boolean;
  showReplace: boolean;
  total: number;
  current: number;
  /** Bumped by the editor to pull focus back to the find box (⌘F again). */
  focusToken: number;
  onQueryChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onToggleCase: () => void;
  onToggleWholeWord: () => void;
  onToggleReplace: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
};

/** Find & replace bar pinned to the top of the page area (⌘F, ⌃H). */
export function DocumentFindBar({
  query,
  replacement,
  matchCase,
  wholeWord,
  showReplace,
  total,
  current,
  focusToken,
  onQueryChange,
  onReplacementChange,
  onToggleCase,
  onToggleWholeWord,
  onToggleReplace,
  onNext,
  onPrevious,
  onReplace,
  onReplaceAll,
  onClose,
}: Props) {
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
  }, [focusToken]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "g") {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }
  }

  const status = !query ? "" : total ? `${current + 1} of ${total}` : "No results";

  return (
    <div className="document-find-bar" role="search" aria-label="Find and replace" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="document-find-toggle"
        aria-label={showReplace ? "Hide replace" : "Show replace"}
        aria-expanded={showReplace}
        onClick={onToggleReplace}
      >
        <ChevronDown size={14} className={showReplace ? "" : "is-collapsed"} />
      </button>
      <div className="document-find-rows">
        <div className="document-find-row">
          <div className="document-find-field">
            <input
              ref={findRef}
              type="text"
              value={query}
              aria-label="Find in document"
              placeholder="Find"
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.shiftKey) onPrevious();
                  else onNext();
                }
              }}
            />
            <button
              type="button"
              className="document-find-option"
              aria-label="Match case"
              aria-pressed={matchCase}
              data-tooltip="Match case"
              onClick={onToggleCase}
            >
              Aa
            </button>
            <button
              type="button"
              className="document-find-option"
              aria-label="Whole words only"
              aria-pressed={wholeWord}
              data-tooltip="Whole words only"
              onClick={onToggleWholeWord}
            >
              <span className="document-find-word">ab</span>
            </button>
          </div>
          <span className="document-find-count" aria-live="polite">
            {status}
          </span>
          <button type="button" aria-label="Previous match" data-tooltip="Previous (⇧Enter)" disabled={!total} onClick={onPrevious}>
            <ChevronUp size={15} />
          </button>
          <button type="button" aria-label="Next match" data-tooltip="Next (Enter)" disabled={!total} onClick={onNext}>
            <ChevronDown size={15} />
          </button>
          <button type="button" aria-label="Close find" data-tooltip="Close (Esc)" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        {showReplace && (
          <div className="document-find-row">
            <div className="document-find-field">
              <input
                type="text"
                value={replacement}
                aria-label="Replace with"
                placeholder="Replace with"
                onChange={(event) => onReplacementChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (event.metaKey || event.ctrlKey) onReplaceAll();
                    else onReplace();
                  }
                }}
              />
            </div>
            <button type="button" className="document-find-action" disabled={!total} onClick={onReplace}>
              <Replace size={13} /> Replace
            </button>
            <button type="button" className="document-find-action" disabled={!total} onClick={onReplaceAll}>
              Replace all
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
