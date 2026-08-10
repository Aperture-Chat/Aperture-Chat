import { Clock3, FileText } from "lucide-react";
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { getDraft } from "../lib/api/drafts";
import { sanitizeDocumentHtml } from "../lib/draftRedline";

const OPEN_DELAY_MS = 420;
const CLOSE_DELAY_MS = 140;
const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 12;
const MAX_PREVIEW_WIDTH = 480;
const MAX_PREVIEW_HEIGHT = 620;
const PREVIEW_CACHE_LIMIT = 24;

type PreviewTriggerProps = {
  "aria-describedby"?: string;
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onMouseEnter?: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: ReactMouseEvent<HTMLElement>) => void;
  ref?: (node: HTMLElement | null) => void;
};

type PreviewPosition = {
  left: number;
  placement: "left" | "right";
  top: number;
};

type LoadedDraftPreview = {
  content: string;
  title: string;
  updatedAt: string;
};

type PreviewFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; draft: LoadedDraftPreview };

/** Session cache so re-hovering the same result never refetches. */
const draftPreviewCache = new Map<string, LoadedDraftPreview>();

function rememberPreview(key: string, draft: LoadedDraftPreview) {
  if (draftPreviewCache.size >= PREVIEW_CACHE_LIMIT) {
    const oldest = draftPreviewCache.keys().next().value;
    if (oldest !== undefined) draftPreviewCache.delete(oldest);
  }
  draftPreviewCache.set(key, draft);
}

/**
 * Hover/focus preview of a saved account draft, mirroring ChatPreview's
 * behavior for chat rows. The document content is fetched lazily on first
 * open (the search payload carries no draft HTML) and rendered through the
 * same sanitizer every other stored-HTML surface uses. A fetch that fails
 * says so instead of showing an empty page.
 */
export function DraftPreview({
  children,
  draftId,
  tenantSlug,
  title,
  userId,
}: {
  children: ReactElement<PreviewTriggerProps>;
  draftId: string;
  tenantSlug: string;
  title: string;
  userId: string;
}) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [fetchState, setFetchState] = useState<PreviewFetchState>({ kind: "idle" });
  const [position, setPosition] = useState<PreviewPosition>({
    left: VIEWPORT_MARGIN,
    placement: "right",
    top: VIEWPORT_MARGIN,
  });
  const cacheKey = `${userId}:${tenantSlug}:${draftId}`;

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const closeNow = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    setOpen(false);
  }, [clearCloseTimer, clearOpenTimer]);

  const openNow = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer, clearOpenTimer]);

  const scheduleOpen = useCallback(() => {
    clearCloseTimer();
    if (!canHover()) return;
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(openNow, OPEN_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer, openNow]);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(closeNow, CLOSE_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer, closeNow]);

  // Lazy fetch on first open; cached drafts render immediately.
  useEffect(() => {
    if (!open) return;
    const cached = draftPreviewCache.get(cacheKey);
    if (cached) {
      setFetchState({ kind: "ready", draft: cached });
      return;
    }
    let cancelled = false;
    setFetchState({ kind: "loading" });
    getDraft(userId, draftId, { tenantSlug })
      .then((snapshot) => {
        if (cancelled) return;
        const draft: LoadedDraftPreview = {
          content: sanitizeDocumentHtml(snapshot.revision.content),
          title: snapshot.document.title,
          updatedAt: snapshot.document.updated_at,
        };
        rememberPreview(cacheKey, draft);
        setFetchState({ kind: "ready", draft });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFetchState({
          kind: "error",
          message: error instanceof Error ? error.message : "The draft could not be loaded.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, draftId, open, tenantSlug, userId]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const listingSurface =
      anchor.closest<HTMLElement>(".sidebar, .utility-drawer, .command-palette-panel")?.getBoundingClientRect() ?? rect;
    const width = Math.min(MAX_PREVIEW_WIDTH, Math.max(280, window.innerWidth - VIEWPORT_MARGIN * 2));
    const measuredHeight = cardRef.current?.offsetHeight ?? Math.min(MAX_PREVIEW_HEIGHT, window.innerHeight - 24);
    const height = Math.min(measuredHeight, window.innerHeight - VIEWPORT_MARGIN * 2);
    const rightSpace = window.innerWidth - listingSurface.right - ANCHOR_GAP - VIEWPORT_MARGIN;
    const leftSpace = listingSurface.left - ANCHOR_GAP - VIEWPORT_MARGIN;
    const placement = rightSpace >= Math.min(width, 340) || rightSpace >= leftSpace ? "right" : "left";
    const desiredLeft = placement === "right"
      ? listingSurface.right + ANCHOR_GAP
      : listingSurface.left - ANCHOR_GAP - width;
    const desiredTop = rect.top - 20;

    setPosition({
      left: clamp(desiredLeft, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
      placement,
      top: clamp(desiredTop, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [fetchState, open, updatePosition]);

  useLayoutEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
  }, [draftId, open]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNow();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [closeNow, open]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    [clearCloseTimer, clearOpenTimer],
  );

  const original = children.props;
  const trigger = cloneElement(children, {
    "aria-describedby": open ? tooltipId : original["aria-describedby"],
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      original.onBlur?.(event);
      closeNow();
    },
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      original.onClick?.(event);
      closeNow();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      original.onFocus?.(event);
      openNow();
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      original.onKeyDown?.(event);
      if (event.key === "Escape") closeNow();
    },
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
      original.onMouseEnter?.(event);
      scheduleOpen();
    },
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => {
      original.onMouseLeave?.(event);
      scheduleClose();
    },
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      original.ref?.(node);
    },
  });

  const shownTitle = fetchState.kind === "ready" ? fetchState.draft.title : title;

  return (
    <>
      {trigger}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <aside
            className={`chat-hover-preview draft-hover-preview is-${position.placement}`}
            id={tooltipId}
            ref={cardRef}
            role="tooltip"
            style={{ left: position.left, top: position.top }}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
          >
            <div className="chat-hover-preview-header">
              <span className="chat-hover-preview-kicker">
                <FileText size={14} aria-hidden="true" />
                Draft preview
              </span>
              <strong>{shownTitle}</strong>
              {fetchState.kind === "ready" && (
                <span className="chat-hover-preview-meta">
                  <Clock3 size={12} aria-hidden="true" />
                  {fetchState.draft.updatedAt}
                </span>
              )}
            </div>
            <div
              aria-label={`${shownTitle} document`}
              className="chat-hover-preview-scroll"
              ref={scrollRef}
            >
              {fetchState.kind === "loading" && (
                <p className="chat-hover-preview-empty">Loading the saved document…</p>
              )}
              {fetchState.kind === "error" && (
                <p className="chat-hover-preview-empty">
                  This draft could not be loaded for preview ({fetchState.message}).
                </p>
              )}
              {fetchState.kind === "ready" &&
                (fetchState.draft.content.trim() ? (
                  <div
                    className="draft-hover-preview-body"
                    // Stored draft HTML is sanitized above before rendering.
                    dangerouslySetInnerHTML={{ __html: fetchState.draft.content }}
                  />
                ) : (
                  <p className="chat-hover-preview-empty">This draft has no content yet.</p>
                ))}
            </div>
            <div className="chat-hover-preview-footer">
              <span>Scroll to read · starts at top</span>
              <span>Click to open in the Drafter</span>
            </div>
          </aside>,
          document.body,
        )}
    </>
  );
}

function canHover() {
  return typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
