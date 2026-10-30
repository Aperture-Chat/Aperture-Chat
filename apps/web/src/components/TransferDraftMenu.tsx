import { ChevronDown, FileText, Presentation, Sheet as SheetIcon, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type RefObject } from "react";
import { suggestDraftFormat, transferTableCount, type DraftTransferFormat } from "../lib/draftTransfer";
import type { ChatMessage } from "../lib/types";

type TransferOption = { format: DraftTransferFormat; label: string; icon: LucideIcon; detail: (tables: number) => string };

/** The three Drafts editors, in the order of the Drafts format rail. */
const OPTIONS: TransferOption[] = [
  {
    format: "document",
    label: "Word document",
    icon: FileText,
    detail: () => "An editable document that exports to Word or PDF",
  },
  {
    format: "deck",
    label: "Slide deck",
    icon: Presentation,
    detail: () => "Slides built from the reply's headings and points",
  },
  {
    format: "spreadsheet",
    label: "Spreadsheet",
    icon: SheetIcon,
    detail: (tables) =>
      tables
        ? `${tables === 1 ? "Its table becomes a sheet" : `Its ${tables} tables become sheets`}, as edited here`
        : "Its lines go down the first column",
  },
];

const MOVES: Record<string, (index: number, count: number) => number> = {
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

type MenuRefs = { trigger: RefObject<HTMLButtonElement | null>; items: MutableRefObject<Array<HTMLButtonElement | null>> };

/** Arrows, Home, and End move between the options; Escape closes back to
 * the button; Tab closes and lets focus move on. */
function menuKeyDown(event: KeyboardEvent<HTMLDivElement>, refs: MenuRefs, close: () => void) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    refs.trigger.current?.focus();
    return;
  }
  if (event.key === "Tab") {
    close();
    return;
  }
  const move = MOVES[event.key];
  if (!move) return;
  event.preventDefault();
  const current = refs.items.current.findIndex((item) => item === document.activeElement);
  refs.items.current[move(Math.max(current, 0), OPTIONS.length)]?.focus();
}

/** Opening focuses the suggested option; a press outside closes the menu. */
function useMenuFocus(suggested: DraftTransferFormat, refs: MenuRefs, root: RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    refs.items.current[OPTIONS.findIndex((option) => option.format === suggested)]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested]);
}

function TransferChoice({
  option,
  suggested,
  tables,
  itemRef,
  onChoose,
}: {
  option: TransferOption;
  suggested: boolean;
  tables: number;
  itemRef: (element: HTMLButtonElement | null) => void;
  onChoose: () => void;
}) {
  const Icon = option.icon;
  const detail = option.detail(tables);
  return (
    <button
      ref={itemRef}
      className={`transfer-draft-option${suggested ? " is-suggested" : ""}`}
      type="button"
      role="menuitem"
      aria-label={`${option.label}${suggested ? " (suggested)" : ""}: ${detail}`}
      onClick={onChoose}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="transfer-draft-option-text">
        <strong>
          {option.label}
          {suggested && <span className="transfer-draft-suggested">Suggested</span>}
        </strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}

/** The open chooser. It reads the reply only while open: which editor fits
 * it, and how many tables a spreadsheet would get. */
function TransferMenuPanel({
  message,
  request,
  refs,
  root,
  onClose,
  onChoose,
}: {
  message: ChatMessage;
  request?: string | null;
  refs: MenuRefs;
  root: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onChoose: (format: DraftTransferFormat) => void;
}) {
  const suggested = useMemo(() => suggestDraftFormat(message.content, request), [message.content, request]);
  const tables = useMemo(() => transferTableCount(message.content), [message.content]);
  useMenuFocus(suggested, refs, root, onClose);
  return (
    <div className="transfer-draft-menu" role="menu" aria-label="Open in Drafts as" onKeyDown={(event) => menuKeyDown(event, refs, onClose)}>
      <p className="transfer-draft-menu-title" aria-hidden="true">
        Open in Drafts as
      </p>
      {OPTIONS.map((option, index) => (
        <TransferChoice
          key={option.format}
          option={option}
          suggested={option.format === suggested}
          tables={tables}
          itemRef={(element) => {
            refs.items.current[index] = element;
          }}
          onChoose={() => onChoose(option.format)}
        />
      ))}
    </div>
  );
}

/** Transfer to Drafts asks which editor the reply should open in, with the
 * one that fits it (by what was asked and what the reply holds) marked
 * Suggested and focused, so Enter takes it. */
export function TransferDraftMenu({
  message,
  request,
  onTransfer,
}: {
  message: ChatMessage;
  /** The message this reply answered, which can name the format outright. */
  request?: string | null;
  onTransfer: (message: ChatMessage, format: DraftTransferFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const refs: MenuRefs = { trigger: useRef<HTMLButtonElement | null>(null), items: useRef<Array<HTMLButtonElement | null>>([]) };
  const close = () => setOpen(false);

  return (
    <div className="transfer-draft" ref={rootRef}>
      <button
        ref={refs.trigger}
        className="transfer-draft-button"
        type="button"
        aria-label="Transfer response to Drafts"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip="Open this response in Drafts as a document, a slide deck, or a spreadsheet"
        onClick={() => setOpen((value) => !value)}
      >
        <FileText size={14} />
        <span>Transfer to Drafts</span>
        <ChevronDown size={13} className="transfer-draft-caret" aria-hidden="true" />
      </button>
      {open && (
        <TransferMenuPanel
          message={message}
          request={request}
          refs={refs}
          root={rootRef}
          onClose={close}
          onChoose={(format) => {
            close();
            onTransfer(message, format);
          }}
        />
      )}
    </div>
  );
}
