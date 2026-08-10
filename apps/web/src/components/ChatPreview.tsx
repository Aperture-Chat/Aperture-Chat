import { Clock3, Image as ImageIcon, MessageSquareText } from "lucide-react";
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { splitAssistantThinking } from "../lib/assistantThinking";
import type { ChatThread } from "../lib/types";
import { Markdown } from "./Markdown";

const OPEN_DELAY_MS = 420;
const CLOSE_DELAY_MS = 140;
const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 12;
const MAX_PREVIEW_WIDTH = 480;
const MAX_PREVIEW_HEIGHT = 620;

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

type PreviewTurn = {
  attachmentNames: string[];
  content: string;
  id: string;
  label: string;
  role: "assistant" | "user";
};

type PreviewPosition = {
  left: number;
  placement: "left" | "right";
  top: number;
};

/**
 * Adds the same rich, bounded chat preview to any chat-list trigger. The
 * preview lives in a portal so sidebar fades and drawer overflow never clip
 * it. Mouse users get a deliberate delay; keyboard users get it immediately.
 */
export function ChatPreview({
  children,
  thread,
}: {
  children: ReactElement<PreviewTriggerProps>;
  thread: ChatThread;
}) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PreviewPosition>({
    left: VIEWPORT_MARGIN,
    placement: "right",
    top: VIEWPORT_MARGIN,
  });
  const turns = useMemo(() => previewTurnsForThread(thread), [thread]);
  const promptCount = turns.filter((turn) => turn.role === "user").length;
  const outputCount = turns.filter((turn) => turn.role === "assistant").length;

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
  }, [open, turns, updatePosition]);

  // A preview is a fresh glance at a conversation, never a continuation of
  // the last hover. Reset synchronously so no lower turn flashes into view.
  useLayoutEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
  }, [open, thread.id]);

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

  return (
    <>
      {trigger}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <aside
            className={`chat-hover-preview is-${position.placement}`}
            id={tooltipId}
            ref={cardRef}
            role="tooltip"
            style={{ left: position.left, top: position.top }}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
          >
            <div className="chat-hover-preview-header">
              <span className="chat-hover-preview-kicker">
                <MessageSquareText size={14} aria-hidden="true" />
                Chat preview
              </span>
              <strong>{thread.title}</strong>
              <span className="chat-hover-preview-meta">
                <Clock3 size={12} aria-hidden="true" />
                {thread.updated_at}
                {turns.some((turn) => containsVisual(turn.content)) && (
                  <>
                    <span aria-hidden="true">·</span>
                    <ImageIcon size={12} aria-hidden="true" />
                    Visuals in chat
                  </>
                )}
              </span>
            </div>
            <div
              aria-label={`${thread.title} conversation`}
              className="chat-hover-preview-scroll"
              ref={scrollRef}
            >
              {turns.length > 0 ? (
                turns.map((turn) => (
                  <section className={`chat-hover-preview-turn is-${turn.role}`} key={turn.id}>
                    <div className="chat-hover-preview-turn-label">
                      <span>{turn.label}</span>
                    </div>
                    {turn.content && (
                      <Markdown content={turn.content} deferDiagrams preview previewPageLimit={false} />
                    )}
                    {turn.attachmentNames.length > 0 && (
                      <div className="chat-hover-preview-attachments">
                        <ImageIcon size={12} aria-hidden="true" />
                        <span>{turn.attachmentNames.join(", ")}</span>
                      </div>
                    )}
                  </section>
                ))
              ) : (
                <p className="chat-hover-preview-empty">This chat does not have previewable content yet.</p>
              )}
            </div>
            <div className="chat-hover-preview-footer">
              <span>Scroll to read · starts at top</span>
              <span>{previewCountLabel(promptCount, "prompt")} · {previewCountLabel(outputCount, "output")}</span>
            </div>
          </aside>,
          document.body,
        )}
    </>
  );
}

function previewTurnsForThread(thread: ChatThread): PreviewTurn[] {
  let promptNumber = 0;
  let outputNumber = 0;

  return thread.messages.flatMap((message) => {
    if (message.role === "system") return [];
    const content = message.role === "assistant"
      ? splitAssistantThinking(message.content).visibleContent.trim()
      : message.content.trim();
    const attachmentNames = (message.attachments ?? []).map((attachment) => attachment.name).filter(Boolean);
    if (!content && attachmentNames.length === 0) return [];

    if (message.role === "user") promptNumber += 1;
    else outputNumber += 1;
    const number = message.role === "user" ? promptNumber : outputNumber;
    return [{
      attachmentNames,
      content,
      id: message.id,
      label: `${message.role === "user" ? "Prompt" : "Output"} ${number}`,
      role: message.role,
    }];
  });
}

function previewCountLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function containsVisual(content: string) {
  return /!\[[^\]]*\]\([^\s)]+|```\s*(?:mermaid|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|quadrantChart|xychart|steward-diagram|aperture-diagram)/i.test(
    content,
  );
}

function canHover() {
  return typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
