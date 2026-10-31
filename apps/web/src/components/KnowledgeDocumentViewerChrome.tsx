import clsx from "clsx";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  LoaderCircle,
  LocateFixed,
  Minus,
  Plus,
  RotateCcw,
  X,
  ZoomIn,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { loadKnowledgeDocumentOriginal } from "../lib/api/knowledge";
import { triggerBlobDownload } from "../lib/clipboard";
import type { ViewerFailure } from "../lib/documentViewerFailures";
import { ZOOM_STOPS, panStep, passageScrollTop, readableExcerpt, stepZoom } from "../lib/documentViewerModel";
import type { KnowledgeDocumentTarget, KnowledgeDocumentView } from "../lib/types";

/** What every pane gets from the viewer. */
export type ViewerPaneProps = {
  userId: string;
  view: KnowledgeDocumentView;
  /** The cited sentence, already checked against the server's excerpt. */
  passage: string | null;
  /** A chunk was asked for, and the server no longer has it. */
  passageMissing: boolean;
  onClose: () => void;
};

/** A page that can be typed: `Page [40] of 60`. */
export type PageFieldProps = {
  noun: string;
  value: string;
  suffix: string;
  /** The same fact for a phone's toolbar. */
  compactSuffix: string;
  onSubmit: (raw: string) => void;
};

export type ViewerPosition = {
  label: string;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  field?: PageFieldProps;
};

export type ViewerZoom = { value: number; onChange: (value: number) => void };

/** Long enough to read a line: anything longer gets Show more. */
const CALLOUT_SHORT_CHARACTERS = 260;
/** On a screen this short, the page matters more than the callout. */
const SHORT_SCREEN_HEIGHT = 500;
/** A page label read out once scrolling has stopped, not at every page crossed. */
const ANNOUNCE_AFTER_MS = 300;

function IconKey({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className="icon-button" type="button" aria-label={label} data-tooltip={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function PageField({ noun, value, suffix, compactSuffix, onSubmit }: PageFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className="dv-position">
      <span className="dv-position-noun">{noun}</span>
      <input
        className="dv-page-field"
        type="text"
        inputMode={/^\d+$/.test(value) ? "numeric" : "text"}
        aria-label="Go to page"
        style={{ width: `${Math.max(value.length, 2) + 1.5}ch` }}
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && draft !== null) {
            // Cancels the edit, not the whole document.
            event.stopPropagation();
            setDraft(null);
          }
          if (event.key !== "Enter") return;
          onSubmit(draft ?? value);
          setDraft(null);
        }}
      />
      <span className="dv-page-suffix">{suffix}</span>
      <span className={clsx("dv-page-suffix-compact", compactSuffix !== suffix && "is-relabelled")}>{compactSuffix}</span>
    </span>
  );
}

function useSettled(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return settled;
}

function PositionControls({ position }: { position: ViewerPosition }) {
  const announced = useSettled(position.label, ANNOUNCE_AFTER_MS);
  return (
    <div className="dv-control-group" role="group" aria-label="Page">
      <IconKey label="Previous page" disabled={!position.canPrevious} onClick={position.onPrevious}>
        <ChevronLeft size={16} />
      </IconKey>
      {position.field ? <PageField {...position.field} /> : <span className="dv-position">{position.label}</span>}
      <span className="dv-position-status" aria-live="polite">{announced}</span>
      <IconKey label="Next page" disabled={!position.canNext} onClick={position.onNext}>
        <ChevronRight size={16} />
      </IconKey>
    </div>
  );
}

function ZoomControls({ zoom }: { zoom: ViewerZoom }) {
  const [open, setOpen] = useState(false);
  const first = ZOOM_STOPS[0];
  const last = ZOOM_STOPS[ZOOM_STOPS.length - 1];
  return (
    <div className={clsx("dv-zoom", open && "is-open")}>
      {/* Only drawn on the narrowest phones, where zoom folds away. */}
      <button
        className="icon-button dv-zoom-toggle"
        type="button"
        aria-label="Zoom controls"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ZoomIn size={16} />
      </button>
      <div className="dv-control-group" role="group" aria-label="Zoom">
        <IconKey label="Zoom out" disabled={zoom.value <= first} onClick={() => zoom.onChange(stepZoom(zoom.value, -1))}>
          <Minus size={16} />
        </IconKey>
        <span className="dv-zoom-value" aria-live="polite">{Math.round(zoom.value * 100)}%</span>
        <IconKey label="Zoom in" disabled={zoom.value >= last} onClick={() => zoom.onChange(stepZoom(zoom.value, 1))}>
          <Plus size={16} />
        </IconKey>
      </div>
    </div>
  );
}

/** Fetches through the session header, so this cannot be a plain link. */
export function DownloadOriginal({
  userId,
  configId,
  documentId,
  name,
  labelled = false,
}: {
  userId: string;
  configId: string;
  documentId: string;
  name?: string;
  labelled?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "busy" | "failed">("idle");
  const download = async () => {
    setStatus("busy");
    try {
      const { blob, filename } = await loadKnowledgeDocumentOriginal(userId, configId, documentId);
      triggerBlobDownload(blob, filename ?? name ?? "document");
      setStatus("idle");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <>
      <button
        className={labelled ? "secondary-button" : "icon-button"}
        type="button"
        aria-label="Download original"
        data-tooltip="Download original"
        disabled={status === "busy"}
        onClick={() => void download()}
      >
        <Download size={16} />
        {labelled && "Download original"}
      </button>
      {status === "failed" && <span className="dv-inline-error" role="alert">Download failed. Try again.</span>}
    </>
  );
}

export function ViewerToolbar({
  name,
  position,
  zoom,
  onJump,
  download,
  onClose,
}: {
  name: string;
  position?: ViewerPosition;
  zoom?: ViewerZoom;
  onJump?: () => void;
  download?: ReactNode;
  onClose: () => void;
}) {
  return (
    <header className="dv-toolbar">
      <div className="dv-title">
        <span className="dv-title-icon" aria-hidden="true"><FileText size={15} /></span>
        <strong title={name}>{name}</strong>
      </div>
      <IconKeyRow position={position} zoom={zoom} onJump={onJump} download={download} />
      <IconKey label="Close document" onClick={onClose}>
        <X size={16} />
      </IconKey>
    </header>
  );
}

function IconKeyRow({
  position,
  zoom,
  onJump,
  download,
}: {
  position?: ViewerPosition;
  zoom?: ViewerZoom;
  onJump?: () => void;
  download?: ReactNode;
}) {
  return (
    <div className="dv-controls">
      {position && <PositionControls position={position} />}
      {zoom && <ZoomControls zoom={zoom} />}
      {onJump && (
        <IconKey label="Go to the cited passage" onClick={onJump}>
          <LocateFixed size={16} />
        </IconKey>
      )}
      {download}
    </div>
  );
}

export function ViewerToolbarDownload({
  userId,
  view,
  labelled,
}: Pick<ViewerPaneProps, "userId" | "view"> & { labelled?: boolean }) {
  if (!view.original_available) return null;
  return (
    <DownloadOriginal
      userId={userId}
      configId={view.knowledge_config_id}
      documentId={view.document_id}
      name={view.name}
      labelled={labelled}
    />
  );
}

function calloutStart(): "closed" | "short" {
  return window.innerHeight < SHORT_SCREEN_HEIGHT ? "closed" : "short";
}

type CalloutShown = "short" | "full";

function CalloutText({
  shown,
  opening,
  whole,
  onChange,
}: {
  shown: CalloutShown;
  opening: string;
  whole: string;
  onChange: (shown: CalloutShown) => void;
}) {
  const hasMore = opening !== whole || whole.length > CALLOUT_SHORT_CHARACTERS;
  const full = shown === "full";
  return (
    <>
      <blockquote>{full ? whole : opening}</blockquote>
      {hasMore && (
        <button className="dv-callout-more" type="button" onClick={() => onChange(full ? "short" : "full")}>
          {full ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function CalloutHeading({ place, closed, onToggle }: { place: string | null; closed: boolean; onToggle: () => void }) {
  return (
    <div className="dv-callout-heading">
      <span>Cited passage</span>
      {place && <small>{place}</small>}
      <button
        className="icon-button dv-callout-toggle"
        type="button"
        aria-label={closed ? "Show the passage" : "Hide the passage"}
        aria-expanded={!closed}
        onClick={onToggle}
      >
        <ChevronDown size={15} />
      </button>
    </div>
  );
}

/** What was cited, always, so a page with nothing to mark still shows it. Leads
 * with the cited sentence; Show more gives the whole retrieved passage. `note`
 * adds a precise, quiet reason when the page cannot help. */
export function PassageCallout({
  target,
  place,
  lead,
  note,
}: {
  target: KnowledgeDocumentTarget | null;
  place: string | null;
  lead?: string | null;
  note?: string | null;
}) {
  const [shown, setShown] = useState<CalloutShown | "closed">(calloutStart);
  if (!target?.excerpt) return null;
  const whole = readableExcerpt(target.excerpt);
  const closed = shown === "closed";
  return (
    <aside className="dv-callout" data-shown={shown} role="note" aria-label="Cited passage">
      <CalloutHeading place={place} closed={closed} onToggle={() => setShown(closed ? "short" : "closed")} />
      {!closed && <CalloutText shown={shown} opening={lead ?? whole} whole={whole} onChange={setShown} />}
      {!target.exact && <small>This is the best match for the passage, not an exact location.</small>}
      {note && <small>{note}</small>}
    </aside>
  );
}

export function PassageMissingNotice({ missing, atCitedPage }: { missing: boolean; atCitedPage: boolean }) {
  if (!missing) return null;
  return (
    <p className="dv-notice">
      {atCitedPage
        ? "This passage has moved or was removed, so this opens at the page it was cited from."
        : "This passage has moved or was removed, so the document opens at the top."}
    </p>
  );
}

export function ViewerNotice({ text }: { text: string | null }) {
  return text ? <p className="dv-notice">{text}</p> : null;
}

export function ViewerStatus({ text }: { text: string }) {
  return (
    <div className="dv-state" role="status">
      <LoaderCircle className="is-spinning" size={20} />
      <span>{text}</span>
    </div>
  );
}

export function ViewerProblem({
  title,
  detail,
  alert = true,
  children,
}: {
  title: string;
  detail: string;
  alert?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="dv-state" role={alert ? "alert" : undefined}>
      <strong>{title}</strong>
      <span>{detail}</span>
      {children && <div className="dv-state-actions">{children}</div>}
    </div>
  );
}

/** A failure, with only the steps that can actually work. */
export function ViewerFailureState({
  failure,
  onRetry,
  download,
}: {
  failure: ViewerFailure;
  onRetry: () => void;
  download: ReactNode;
}) {
  return (
    <ViewerProblem alert={!failure.calm} title={failure.title} detail={failure.detail}>
      {failure.retry && (
        <button className="secondary-button" type="button" onClick={onRetry}>
          <RotateCcw size={15} />
          Try again
        </button>
      )}
      {failure.download && download}
    </ViewerProblem>
  );
}

function hasModifier(event: KeyboardEvent) {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLInputElement;
}

function turnAction(key: string, position: ViewerPosition): (() => void) | null {
  if (key === "ArrowLeft" && position.canPrevious) return position.onPrevious;
  return key === "ArrowRight" && position.canNext ? position.onNext : null;
}

function pageKeyAction(event: KeyboardEvent, position: ViewerPosition, pages: HTMLElement | null): (() => void) | null {
  if (hasModifier(event) || isTyping(event.target)) return null;
  const turn = turnAction(event.key, position);
  const pan = pages ? panStep(event.key, pages) : 0;
  if (!pages || pan === 0) return turn;
  // Browsers can stop short of the room they report, as Chromium does with a
  // scrollbar gutter. If the page did not move, its edge is here, so turn.
  return () => {
    const before = pages.scrollLeft;
    pages.scrollLeft = before + pan;
    if (pages.scrollLeft === before) turn?.();
  };
}

/** Left and right pan a zoomed page, then turn the page at its edge; up, down,
 * and space keep scrolling. */
export function usePageKeys(position: ViewerPosition, pages: RefObject<HTMLElement | null>) {
  const latest = useRef(position);
  latest.current = position;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = pageKeyAction(event, latest.current, pages.current);
      if (!action) return;
      event.preventDefault();
      action();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pages]);
}

/** Scroll offset that shows the cited sentence inside `scroller`, or the rest
 * of its passage when only that is marked. Null when nothing is marked. */
export function passageMarkTop(scroller: HTMLElement): number | null {
  const mark = scroller.querySelector<HTMLElement>("mark:not(.is-tint)") ?? scroller.querySelector<HTMLElement>("mark");
  const page = mark?.closest<HTMLElement>(".dv-page, .dv-paper");
  if (!mark || !page) return null;
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  return passageScrollTop({
    markTop: mark.getBoundingClientRect().top - origin,
    pageTop: page.getBoundingClientRect().top - origin,
    viewportHeight: scroller.clientHeight,
  });
}

/** Puts the keyboard on the pages once they exist, so arrows and space scroll
 * them straight away, unless the person has already moved focus to a control. */
export function useFocusOnReady(ref: RefObject<HTMLElement | null>, ready: boolean) {
  useEffect(() => {
    const target = ref.current;
    if (!ready || !target) return;
    const panel = target.closest<HTMLElement>('[role="dialog"]');
    const active = document.activeElement;
    if (active === panel || !panel?.contains(active)) target.focus({ preventScroll: true });
  }, [ready, ref]);
}
