import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  Check,
  CornerDownLeft,
  Languages,
  ListPlus,
  Loader2,
  MessageSquareQuote,
  RotateCcw,
  Sparkles,
  Square,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import { diffWords, type RedlineToken } from "../lib/draftRedline";
import {
  AI_EDIT_GROUP_LABELS,
  aiActionMatches,
  wordTotal,
  type AiEditAction,
  type AiEditChipGroup,
} from "../lib/aiEditPrompts";

export type AiComposerPhase = "compose" | "working" | "review" | "error";

/** Viewport rectangle the composer attaches to (the selection or caret). */
export type AiComposerAnchor = { top: number; bottom: number; left: number; right: number };

type Entry = {
  key: string;
  label: string;
  instruction: string;
  kind: "custom" | "action" | "chip";
  group: string;
};

type Props = {
  /** Reads the anchor rect fresh, so the composer follows its target when the
   * page scrolls. Returning null keeps the last known position. */
  getAnchor: () => AiComposerAnchor | null;
  title: string;
  /** One line naming what the edit targets ("“Revenue grew…”", "Slide 3"). */
  targetLabel: string;
  placeholder: string;
  actions: AiEditAction[];
  chipGroups: AiEditChipGroup[];
  phase: AiComposerPhase;
  agentName: string;
  /** Streamed reply text (plain), shown live while the model writes. */
  streamText: string;
  /** Last instruction the writer ran, echoed above the result. */
  runLabel: string;
  /** The original passage and the proposal as plain text; a word diff is shown
   * when both are present. */
  baseText?: string;
  proposalText?: string;
  /** Sanitized HTML of the proposal for the "Result" view. */
  proposalHtml?: string;
  /** Replaces the diff/result body for surfaces with their own preview. */
  reviewPreview?: ReactNode;
  error?: string | null;
  disabledReason?: string | null;
  acceptLabel: string;
  onRun: (instruction: string, label: string) => void;
  onRefine: (instruction: string) => void;
  onAccept: () => void;
  onInsertBelow?: () => void;
  onRetry: () => void;
  onStop: () => void;
  onClose: () => void;
};

const ACTION_ICONS: Record<string, LucideIcon> = {
  improve: Wand2,
  transform: ListPlus,
  write: MessageSquareQuote,
  slide: Sparkles,
};

/** Largest word-by-word comparison worth drawing; beyond it the review shows
 * the result only rather than freezing on a huge LCS table. */
const MAX_DIFF_CELLS = 1_200_000;

export function AiEditComposer({
  getAnchor,
  title,
  targetLabel,
  placeholder,
  actions,
  chipGroups,
  phase,
  agentName,
  streamText,
  runLabel,
  baseText,
  proposalText,
  proposalHtml,
  reviewPreview,
  error,
  disabledReason,
  acceptLabel,
  onRun,
  onRefine,
  onAccept,
  onInsertBelow,
  onRetry,
  onStop,
  onClose,
}: Props) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const refineRef = useRef<HTMLTextAreaElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [refine, setRefine] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [view, setView] = useState<"changes" | "result">("changes");
  const [position, setPosition] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
    docked: boolean;
  }>({ top: 80, left: 24, width: 440, maxHeight: 480, docked: false });

  // Follow the target through scrolling and resizing. Capture-phase scroll
  // catches the page scroller as well as the window.
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const viewportWidth = window.innerWidth || 1024;
      const viewportHeight = window.innerHeight || 768;
      if (viewportWidth < 640) {
        setPosition({ left: 8, width: viewportWidth - 16, bottom: 8, maxHeight: viewportHeight * 0.7, docked: true });
        return;
      }
      const anchor = getAnchor();
      if (!anchor) return;
      const width = Math.min(460, viewportWidth - 24);
      const left = Math.max(12, Math.min(anchor.left - 12, viewportWidth - width - 12));
      const below = viewportHeight - anchor.bottom - 16;
      const above = anchor.top - 16;
      if (below >= 300 || below >= above) {
        const top = Math.min(Math.max(anchor.bottom + 10, 12), viewportHeight - 220);
        setPosition({ top, left, width, maxHeight: Math.max(220, viewportHeight - top - 12), docked: false });
      } else {
        const bottom = Math.min(Math.max(viewportHeight - anchor.top + 10, 12), viewportHeight - 220);
        setPosition({ bottom, left, width, maxHeight: Math.max(220, viewportHeight - bottom - 12), docked: false });
      }
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
  }, [getAnchor, phase]);

  // Focus follows the phase: the instruction box to start, Accept once there
  // is something to accept, so Enter always does the expected thing.
  useEffect(() => {
    const target =
      phase === "compose" || phase === "error"
        ? inputRef.current
        : phase === "review"
          ? acceptRef.current
          : rootRef.current;
    target?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => {
    if (phase === "review") setRefine("");
  }, [phase]);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    const typed = query.trim();
    if (typed) {
      list.push({ key: "custom", label: typed, instruction: typed, kind: "custom", group: "" });
    }
    actions.forEach((action) => {
      const group = AI_EDIT_GROUP_LABELS[action.group];
      if (!aiActionMatches(action, typed, group)) return;
      list.push({ key: action.id, label: action.label, instruction: action.instruction, kind: "action", group });
    });
    chipGroups.forEach((group) => {
      group.chips.forEach((chip) => {
        if (!aiActionMatches(chip, typed, group.label)) return;
        list.push({ key: chip.id, label: chip.label, instruction: chip.instruction, kind: "chip", group: group.label });
      });
    });
    return list;
  }, [actions, chipGroups, query]);

  useEffect(() => {
    setActiveIndex(query.trim() ? 0 : -1);
  }, [query]);

  const diffTokens = useMemo<RedlineToken[] | null>(() => {
    if (!baseText || !proposalText) return null;
    const cells = wordTotal(baseText) * wordTotal(proposalText);
    if (cells > MAX_DIFF_CELLS) return null;
    return diffWords(baseText, proposalText);
  }, [baseText, proposalText]);

  const hasChanges = Boolean(diffTokens?.some((token) => token.type !== "same"));
  const effectiveView = diffTokens ? view : "result";

  function run(entry: Entry | undefined) {
    if (!entry || disabledReason) return;
    setQuery("");
    onRun(entry.instruction, entry.label);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!entries.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => {
        const next = index + step;
        if (next < 0) return entries.length - 1;
        if (next >= entries.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (activeIndex >= 0) run(entries[activeIndex]);
      return;
    }
  }

  function handleRootKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (phase === "working") onStop();
      else onClose();
      return;
    }
    if (phase === "review" && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onAccept();
    }
  }

  const activeEntryId = activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;
  const style = position.docked
    ? { left: position.left, width: position.width, bottom: position.bottom, maxHeight: position.maxHeight }
    : {
        left: position.left,
        width: position.width,
        top: position.top,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
      };

  let lastGroup = "";
  const composer = (
    <div
      ref={rootRef}
      className={`ai-composer is-${phase} ${position.docked ? "is-docked" : ""}`}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      style={style}
      onKeyDown={handleRootKeyDown}
      onMouseDown={(event) => {
        // Keep clicks inside the composer from collapsing the page selection.
        const target = event.target as HTMLElement;
        if (!target.closest("textarea,input,select")) event.preventDefault();
      }}
    >
      <header className="ai-composer-head">
        <span className="ai-composer-mark" aria-hidden="true">
          <Sparkles size={14} />
        </span>
        <div className="ai-composer-head-text">
          <strong>{title}</strong>
          <span className="ai-composer-target" title={targetLabel}>
            {targetLabel}
          </span>
        </div>
        <button type="button" className="ai-composer-icon" aria-label={`Close ${title}`} onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      {(phase === "compose" || phase === "error") && (
        <>
          {phase === "error" && error && (
            <div className="ai-composer-error" role="alert">
              <p>{error}</p>
              <button type="button" onClick={onRetry}>
                <RotateCcw size={13} /> Try again
              </button>
            </div>
          )}
          <div className="ai-composer-input">
            <textarea
              ref={inputRef}
              rows={1}
              value={query}
              placeholder={placeholder}
              aria-label="AI instruction"
              role="combobox"
              aria-expanded={entries.length > 0}
              aria-controls={listId}
              aria-activedescendant={activeEntryId}
              aria-autocomplete="list"
              disabled={Boolean(disabledReason)}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />
            <button
              type="button"
              className="ai-composer-send"
              aria-label="Run AI instruction"
              disabled={!query.trim() || Boolean(disabledReason)}
              onClick={() => run(entries[0]?.kind === "custom" ? entries[0] : undefined)}
            >
              <ArrowUp size={15} />
            </button>
          </div>
          {disabledReason ? (
            <p className="ai-composer-note">{disabledReason}</p>
          ) : (
            <ul className="ai-composer-list" id={listId} role="listbox" aria-label="AI actions">
              {entries.map((entry, index) => {
                const header =
                  entry.kind !== "custom" && entry.group !== lastGroup ? entry.group : null;
                lastGroup = entry.kind === "custom" ? lastGroup : entry.group;
                const Icon =
                  entry.kind === "custom"
                    ? CornerDownLeft
                    : entry.kind === "chip"
                      ? entry.group === "Translate"
                        ? Languages
                        : MessageSquareQuote
                      : ACTION_ICONS[actions.find((action) => action.id === entry.key)?.group ?? "improve"] ?? Wand2;
                return (
                  <Fragment key={entry.key}>
                    {header && (
                      <li role="presentation" className="ai-composer-group">
                        {header}
                      </li>
                    )}
                    <li role="presentation" className={entry.kind === "chip" ? "is-chip" : undefined}>
                      <button
                        type="button"
                        id={`${listId}-${index}`}
                        role="option"
                        aria-selected={index === activeIndex}
                        className={index === activeIndex ? "is-active" : undefined}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => run(entry)}
                      >
                        <Icon size={14} aria-hidden="true" />
                        <span>{entry.kind === "custom" ? `Ask AI: “${entry.label}”` : entry.label}</span>
                      </button>
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          )}
        </>
      )}

      {phase === "working" && (
        <div className="ai-composer-body" aria-live="polite">
          <div className="ai-composer-run">
            <Loader2 size={13} className="ai-composer-spin" aria-hidden="true" />
            <span>
              {runLabel} · {agentName}
            </span>
          </div>
          <div className="ai-composer-stream">
            {streamText ? streamText : <span className="ai-composer-thinking">Thinking…</span>}
            <span className="ai-composer-caret" aria-hidden="true" />
          </div>
          <div className="ai-composer-actions">
            <button type="button" onClick={onStop}>
              <Square size={12} /> Stop
            </button>
          </div>
        </div>
      )}

      {phase === "review" && (
        <div className="ai-composer-body">
          <div className="ai-composer-run">
            <Check size={13} aria-hidden="true" />
            <span>
              {runLabel} · {agentName}
            </span>
            {diffTokens && !reviewPreview && (
              <div className="ai-composer-view" role="tablist" aria-label="Suggestion view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveView === "changes"}
                  onClick={() => setView("changes")}
                >
                  Changes
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveView === "result"}
                  onClick={() => setView("result")}
                >
                  Result
                </button>
              </div>
            )}
          </div>
          <div className="ai-composer-preview" aria-label="AI suggestion">
            {reviewPreview ??
              (effectiveView === "changes" && diffTokens ? (
                <p className="ai-composer-diff">
                  {diffTokens.map((token, index) =>
                    token.type === "same" ? (
                      <span key={index}>{token.text} </span>
                    ) : token.type === "del" ? (
                      <del key={index}>{token.text}</del>
                    ) : (
                      <ins key={index}>{token.text}</ins>
                    ),
                  )}
                  {!hasChanges && <em className="ai-composer-same">No wording changes.</em>}
                </p>
              ) : (
                <div
                  className="ai-composer-result"
                  // The proposal is sanitized with the document allowlist
                  // before it reaches this view, exactly as it would be on accept.
                  dangerouslySetInnerHTML={{ __html: proposalHtml || "" }}
                />
              ))}
          </div>
          {baseText && proposalText && !reviewPreview && (
            <p className="ai-composer-stat">
              {wordTotal(baseText)} → {wordTotal(proposalText)} words
            </p>
          )}
          <div className="ai-composer-actions">
            <button ref={acceptRef} type="button" className="is-primary" aria-label="Accept AI suggestion" onClick={onAccept}>
              <Check size={14} /> {acceptLabel}
            </button>
            {onInsertBelow && (
              <button type="button" onClick={onInsertBelow}>
                <ListPlus size={14} /> Insert below
              </button>
            )}
            <button type="button" onClick={onRetry}>
              <RotateCcw size={13} /> Try again
            </button>
            <button type="button" aria-label="Discard AI suggestion" onClick={onClose}>
              Discard
            </button>
          </div>
          <form
            className="ai-composer-refine"
            onSubmit={(event) => {
              event.preventDefault();
              const value = refine.trim();
              if (!value) return;
              setRefine("");
              onRefine(value);
            }}
          >
            <textarea
              ref={refineRef}
              rows={1}
              value={refine}
              aria-label="Refine the AI suggestion"
              placeholder="Tell AI what to change — shorter, warmer, add a number…"
              onChange={(event) => setRefine(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button type="submit" className="ai-composer-send" aria-label="Refine suggestion" disabled={!refine.trim()}>
              <ArrowUp size={15} />
            </button>
          </form>
        </div>
      )}
    </div>
  );

  return typeof document === "undefined" ? composer : createPortal(composer, document.body);
}
