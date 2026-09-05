import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Bot,
  CalendarClock,
  FileText,
  Folder,
  FolderPlus,
  MessageSquare,
  Pin,
  PinOff,
  Search,
  Table2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  globalSearch,
  type GlobalSearchHit,
  type GlobalSearchKind,
  type GlobalSearchSection,
  type SearchNavigation,
} from "../lib/api/search";
import type { ChatThread } from "../lib/types";
import { ChatPreview } from "./ChatPreview";
import { DraftPreview } from "./DraftPreview";

export type PaletteFolderOption = {
  depth: number;
  id: string;
  name: string;
};

export const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_SECTION_LIMIT = 8;

const KIND_ICONS: Record<GlobalSearchKind, LucideIcon> = {
  chat: MessageSquare,
  knowledge: BookOpen,
  review: Table2,
  agent: Bot,
  automation: CalendarClock,
  matter: Folder,
  draft: FileText,
};

const panelStyle: CSSProperties = {
  position: "fixed",
  top: "12vh",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 97,
  width: "min(620px, calc(100vw - 32px))",
  maxHeight: "68vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-lg)",
  overflow: "hidden",
};

const groupLabelStyle: CSSProperties = {
  margin: "0 0 6px",
  fontSize: "11.5px",
  fontWeight: 800,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

const statusLineStyle: CSSProperties = {
  margin: 0,
  color: "var(--muted)",
  fontSize: "13px",
};

/**
 * Global search overlay. Renders the backend's sections verbatim and routes
 * each result through its backend-provided `navigation` object via
 * `onNavigate`. Search is retrieval-first: it does not duplicate the shell's
 * navigation rail, chat results lead, and archived conversations are labeled
 * explicitly. Sections that come back empty stay absent, and no placeholder
 * results are ever shown.
 */
export function CommandPalette({
  userId,
  tenantSlug,
  onNavigate,
  onClose,
  threads,
  folders,
  onTogglePin,
  onArchiveThread,
  onRestoreThread,
  onMoveThreadToFolder,
}: {
  userId: string;
  /** Active tenant context, including for platform-owner matter and draft search. */
  tenantSlug: string;
  /** Routes a backend `navigation` object; returns false when this build has no screen for it. */
  onNavigate: (navigation: SearchNavigation) => boolean;
  onClose: () => void;
  /** Local chat threads; enables hover previews and row actions on chat hits. */
  threads?: ChatThread[];
  /** Flattened folder tree for the move-to-folder menu on chat hits. */
  folders?: PaletteFolderOption[];
  onTogglePin?: (id: string) => void;
  onArchiveThread?: (id: string) => void;
  onRestoreThread?: (id: string) => void;
  onMoveThreadToFolder?: (id: string, folderId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [sections, setSections] = useState<GlobalSearchSection[]>([]);
  /** The query the current `sections` were fetched for; "" means none yet. */
  const [resultsQuery, setResultsQuery] = useState("");
  const [resultsScope, setResultsScope] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [folderMenuThreadId, setFolderMenuThreadId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-results`;

  const threadById = useMemo(() => {
    const map = new Map<string, ChatThread>();
    for (const thread of threads ?? []) map.set(thread.id, thread);
    return map;
  }, [threads]);

  const trimmed = query.trim();
  const searchScope = JSON.stringify([userId, tenantSlug]);

  // Focus the input on open and hand focus back to the opener on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previous?.focus();
  }, []);

  // Debounced remote search; aborts stale in-flight requests.
  useEffect(() => {
    if (!trimmed) {
      setSections([]);
      setResultsQuery("");
      setError(null);
      return;
    }
    setError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      globalSearch(userId, trimmed, SEARCH_SECTION_LIMIT, {
        signal: controller.signal,
        tenantSlug,
      })
        .then((response) => {
          if (controller.signal.aborted) return;
          setResultsScope(JSON.stringify([userId, tenantSlug]));
          setSections(response.sections.filter((section) => section.results.length > 0));
          setResultsQuery(trimmed);
        })
        .catch((requestError: unknown) => {
          if (controller.signal.aborted) return;
          setError(requestError instanceof Error ? requestError.message : "Search failed.");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [tenantSlug, trimmed, userId]);

  useEffect(() => {
    setActiveIndex(0);
    setNotice(null);
    setFolderMenuThreadId(null);
  }, [trimmed]);

  // Only results fetched for the query currently typed are rendered; while a
  // newer query is in flight the list shows a searching state instead.
  const resultsAreCurrent = resultsQuery === trimmed && resultsScope === searchScope;
  const showSections = trimmed && resultsAreCurrent ? sections : [];
  const resultItems = showSections.flatMap((section) => section.results);
  const searching = Boolean(trimmed) && !resultsAreCurrent && !error;
  const itemCount = resultItems.length;
  const boundedActive = itemCount === 0 ? -1 : Math.min(activeIndex, itemCount - 1);
  const noMatches = Boolean(trimmed) && !searching && !error && resultItems.length === 0;

  const itemId = (index: number) => `${baseId}-item-${index}`;

  // Keep the active row visible while arrowing through a scrolled list.
  // (Optional call: jsdom has no scrollIntoView.)
  useEffect(() => {
    if (boundedActive < 0) return;
    document.getElementById(itemId(boundedActive))?.scrollIntoView?.({ block: "nearest" });
  });

  const openHit = (hit: GlobalSearchHit) => {
    if (onNavigate(hit.navigation)) {
      onClose();
      return;
    }
    setNotice(`"${hit.title}" has no screen in this build yet.`);
  };

  const activateItem = (index: number) => {
    if (index < 0) return;
    const hit = resultItems[index];
    if (hit) openHit(hit);
  };

  const detailForHit = (hit: GlobalSearchHit) => {
    const details = [];
    if (hit.kind === "chat" && hit.metadata.archived === true) {
      details.push("Archived conversation");
    }
    if (hit.snippet) details.push(hit.snippet);
    return details.join(" · ") || undefined;
  };

  const moveActive = (delta: number) => {
    if (itemCount === 0) return;
    setActiveIndex((current) => {
      const bounded = Math.min(current, itemCount - 1);
      return (bounded + delta + itemCount) % itemCount;
    });
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // Focus trap: cycle within the dialog.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"]):not([disabled])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      activateItem(boundedActive);
    }
  };

  /** Chat actions mirror the sidebar row strip; state comes from the live
   * local thread so a pin or archive from here updates the row instantly. */
  const renderChatActions = (thread: ChatThread) => (
    <div className="palette-result-actions">
      {onMoveThreadToFolder && (
        <button
          className="pin-toggle chat-row-action"
          type="button"
          aria-label={`Add ${thread.title} to a folder`}
          data-tooltip={`File "${thread.title}" into a folder to keep related chats together`}
          onClick={() =>
            setFolderMenuThreadId((current) => (current === thread.id ? null : thread.id))
          }
        >
          <FolderPlus size={14} />
        </button>
      )}
      {onTogglePin && (
        <button
          className="pin-toggle chat-row-action"
          type="button"
          aria-label={thread.pinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
          data-tooltip={
            thread.pinned
              ? `Unpin "${thread.title}" and let it return to your recent list`
              : `Pin "${thread.title}" to keep it at the top of your sidebar`
          }
          aria-pressed={thread.pinned}
          onClick={() => onTogglePin(thread.id)}
        >
          {thread.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      )}
      {thread.archived
        ? onRestoreThread && (
            <button
              className="pin-toggle chat-row-action"
              type="button"
              aria-label={`Restore ${thread.title}`}
              data-tooltip={`Bring "${thread.title}" back into your sidebar`}
              onClick={() => onRestoreThread(thread.id)}
            >
              <ArchiveRestore size={14} />
            </button>
          )
        : onArchiveThread && (
            <button
              className="pin-toggle chat-row-action"
              type="button"
              aria-label={`Archive ${thread.title}`}
              data-tooltip={`Move "${thread.title}" out of your sidebar without deleting it`}
              onClick={() => onArchiveThread(thread.id)}
            >
              <Archive size={14} />
            </button>
          )}
    </div>
  );

  const renderFolderMenu = (thread: ChatThread) => (
    <div className="thread-folder-menu palette-folder-menu">
      <strong>Move to folder</strong>
      {(folders ?? []).map((folder) => (
        <button
          key={folder.id}
          type="button"
          style={folder.depth > 0 ? { marginLeft: folder.depth * 14 } : undefined}
          data-tooltip={`Move this chat into your "${folder.name}" folder`}
          onClick={() => {
            onMoveThreadToFolder?.(thread.id, folder.id);
            setFolderMenuThreadId(null);
          }}
        >
          <Folder size={13} />
          <span>{folder.name}</span>
        </button>
      ))}
      {(folders ?? []).length === 0 && (
        <p className="palette-folder-menu-empty">
          No folders yet. Create one from the sidebar first.
        </p>
      )}
      {thread.folder_id && (
        <button
          type="button"
          data-tooltip="Take this chat out of its folder and back to Recent"
          onClick={() => {
            onMoveThreadToFolder?.(thread.id, null);
            setFolderMenuThreadId(null);
          }}
        >
          <X size={13} />
          <span>Remove from folder</span>
        </button>
      )}
    </div>
  );

  const renderHitRow = (index: number, hit: GlobalSearchHit) => {
    const Icon = KIND_ICONS[hit.kind] ?? Search;
    const active = index === boundedActive;
    const thread = hit.kind === "chat" ? threadById.get(hit.navigation.thread_id ?? "") : undefined;
    const draftId = hit.kind === "draft" ? hit.navigation.draft_id : undefined;

    const optionButton = (
      <button
        id={itemId(index)}
        role="option"
        aria-selected={active}
        className="drawer-row palette-option"
        type="button"
        tabIndex={-1}
        style={active ? { borderColor: "var(--teal)", background: "var(--teal-soft)" } : undefined}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => openHit(hit)}
      >
        <Icon size={16} aria-hidden="true" />
        <span>
          <strong>{hit.title}</strong>
          {detailForHit(hit) && <small>{detailForHit(hit)}</small>}
        </span>
      </button>
    );

    // Hover previews: chat hits use the live local thread (same preview as
    // the sidebar); draft hits lazily fetch the saved document.
    let wrapped: ReactNode = optionButton;
    if (thread) {
      wrapped = <ChatPreview thread={thread}>{optionButton}</ChatPreview>;
    } else if (draftId) {
      wrapped = (
        <DraftPreview draftId={draftId} tenantSlug={tenantSlug} title={hit.title} userId={userId}>
          {optionButton}
        </DraftPreview>
      );
    }

    return (
      <div className="palette-result" key={itemId(index)}>
        {wrapped}
        {thread && renderChatActions(thread)}
        {thread && folderMenuThreadId === thread.id && renderFolderMenu(thread)}
      </div>
    );
  };

  let flatIndex = -1;

  return (
    <>
      <button
        className="utility-backdrop"
        type="button"
        aria-label="Close search"
        style={{ zIndex: 96, cursor: "default" }}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search past work"
        className="command-palette-panel"
        style={panelStyle}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="command-palette-heading">
          <span>
            <strong>Search past work</strong>
            <small>Chats first, workspace second</small>
          </span>
          <kbd>Ctrl / ⌘ K</kbd>
          <button className="icon-button" type="button" aria-label="Close search dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div
          className="search-box"
          style={{ flex: "none", width: "auto", maxWidth: "none", margin: "0 12px" }}
        >
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={boundedActive >= 0 ? itemId(boundedActive) : undefined}
            aria-label="Search chat titles, messages, agents, drafts, and documents"
            placeholder="Search chat titles and message text…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          style={{ overflowY: "auto", padding: "12px", display: "grid", gap: "12px", minHeight: "96px" }}
        >
          {!trimmed && (
            <div className="command-palette-intro">
              <span className="command-palette-intro-icon">
                <MessageSquare size={18} aria-hidden="true" />
              </span>
              <span>
                <strong>Find something from a previous conversation</strong>
                <small>
                  Search every chat title and message you can access. Archived chats are included.
                </small>
                <small>
                  Results can also include agents, drafts, matters, review grids, and indexed documents.
                </small>
              </span>
            </div>
          )}
          {searching && (
            <p role="status" style={statusLineStyle}>
              Searching…
            </p>
          )}
          {error && (
            <p role="alert" style={statusLineStyle}>
              {error}
            </p>
          )}
          {showSections.map((section) => (
            <div role="group" aria-label={section.title} key={section.kind}>
              <p style={groupLabelStyle}>{section.title}</p>
              <div style={{ display: "grid", gap: "6px" }}>
                {section.results.map((hit) => {
                  flatIndex += 1;
                  return renderHitRow(flatIndex, hit);
                })}
              </div>
            </div>
          ))}
          {noMatches && (
            <p role="status" style={statusLineStyle}>
              No chats or workspace items found for “{trimmed}”.
            </p>
          )}
          {notice && (
            <p role="status" style={statusLineStyle}>
              {notice}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
