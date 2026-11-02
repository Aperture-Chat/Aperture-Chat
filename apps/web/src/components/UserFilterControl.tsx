import { ChevronDown, Search, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

export type FilterUser = { id: string; label: string };

/** Below this many people, a search box is more clutter than help. */
const SEARCH_MIN_USERS = 9;
const PANEL_WIDTH = 320;
const PANEL_GAP = 6;
const SCREEN_MARGIN = 8;
/** Keep the panel below the button unless that leaves less than this. */
const PANEL_MIN_ROOM = 260;

type AnchorRect = Pick<DOMRect, "left" | "top" | "bottom" | "width">;
type Viewport = { width: number; height: number };
export type PanelPlacement = { left: number; width: number; maxHeight: number; top?: number; bottom?: number };

export function userFilterSummary(selectedIds: string[], users: FilterUser[], allLabel: string) {
  if (selectedIds.length === 0) return allLabel;
  const only = selectedIds.length === 1 ? users.find((user) => user.id === selectedIds[0]) : undefined;
  if (only) return only.label;
  return `${selectedIds.length} user${selectedIds.length === 1 ? "" : "s"}`;
}

/** Where the panel sits: under the button when it fits, always on screen. */
export function userFilterPanelPlacement(anchor: AnchorRect, viewport: Viewport): PanelPlacement {
  const width = Math.min(PANEL_WIDTH, viewport.width - SCREEN_MARGIN * 2);
  const left = Math.max(SCREEN_MARGIN, Math.min(anchor.left, viewport.width - width - SCREEN_MARGIN));
  const roomBelow = viewport.height - anchor.bottom - PANEL_GAP - SCREEN_MARGIN;
  const roomAbove = anchor.top - PANEL_GAP - SCREEN_MARGIN;
  if (roomBelow >= PANEL_MIN_ROOM || roomBelow >= roomAbove) {
    return { left, width, top: anchor.bottom + PANEL_GAP, maxHeight: roomBelow };
  }
  return { left, width, bottom: viewport.height - anchor.top + PANEL_GAP, maxHeight: roomAbove };
}

function matchingUsers(users: FilterUser[], query: string) {
  const wanted = query.trim().toLowerCase();
  return wanted ? users.filter((user) => user.label.toLowerCase().includes(wanted)) : users;
}

function PersonRow({
  label,
  checked,
  onToggle,
  emphasized = false,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  emphasized?: boolean;
}) {
  return (
    <label className={emphasized ? "user-filter-row is-all" : "user-filter-row"}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span>{label}</span>
    </label>
  );
}

/** Puts focus in the panel, closes it on an outside press, and keeps it with
 * its button as the page moves: a long console scrolls easily, and losing the
 * ticks to a nudge of the wheel would be worse than a panel that follows. */
function usePanelLifecycle(
  panelRef: RefObject<HTMLDivElement | null>,
  buttonRef: RefObject<HTMLButtonElement | null>,
  onDismiss: () => void,
  onMoved: () => void,
) {
  useEffect(() => {
    panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      onDismiss();
    };
    const followButton = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      onMoved();
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("scroll", followButton, true);
    window.addEventListener("resize", followButton);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("scroll", followButton, true);
      window.removeEventListener("resize", followButton);
    };
  }, [panelRef, buttonRef, onDismiss, onMoved]);
}

function UserFilterPanel({
  label,
  users,
  selectedIds,
  onChange,
  allLabel,
  placement,
  buttonRef,
  onClose,
  onMoved,
}: {
  label: string;
  users: FilterUser[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  allLabel: string;
  placement: PanelPlacement;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClose: (returnFocus: boolean) => void;
  onMoved: () => void;
}) {
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => onClose(false), [onClose]);
  usePanelLifecycle(panelRef, buttonRef, dismiss, onMoved);

  const togglePerson = (id: string) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  };

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
  };

  const visibleUsers = matchingUsers(users, query);

  return (
    <div ref={panelRef} className="user-filter-panel" role="dialog" aria-label={label} style={placement} onKeyDown={closeOnEscape}>
      {users.length >= SEARCH_MIN_USERS && (
        <label className="user-filter-search">
          <Search size={14} />
          <input
            type="search"
            aria-label="Find a person"
            placeholder="Find a person"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      <PersonRow label={allLabel} checked={selectedIds.length === 0} onToggle={() => onChange([])} emphasized />
      <div className="user-filter-list">
        {visibleUsers.map((user) => (
          <PersonRow
            key={user.id}
            label={user.label}
            checked={selectedIds.includes(user.id)}
            onToggle={() => togglePerson(user.id)}
          />
        ))}
        {visibleUsers.length === 0 && <p className="user-filter-empty">No one matches that name.</p>}
      </div>
      <div className="user-filter-foot">
        <small>{selectedIds.length === 0 ? "Everyone" : `${selectedIds.length} selected`}</small>
        <button className="primary-button compact" type="button" onClick={() => onClose(true)}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Checkbox picker for one person, several people, or everyone. An empty
 * selection means everyone, so a filter can never quietly hide all records. */
export function UserFilterControl({
  label,
  users,
  selectedIds,
  onChange,
  allLabel = "All users",
  tooltip,
}: {
  label: string;
  users: FilterUser[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  allLabel?: string;
  tooltip?: string;
}) {
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setPlacement(null);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const placeOnButton = useCallback(() => {
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!anchor || anchor.bottom < 0 || anchor.top > window.innerHeight) {
      setPlacement(null);
      return;
    }
    setPlacement(userFilterPanelPlacement(anchor, { width: window.innerWidth, height: window.innerHeight }));
  }, []);

  const toggleOpen = () => {
    if (placement) close(false);
    else placeOnButton();
  };

  return (
    <>
      <button
        ref={buttonRef}
        className="compact-select-field user-filter-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={placement !== null}
        data-tooltip={tooltip}
        onClick={toggleOpen}
      >
        <Users size={14} />
        <span>{userFilterSummary(selectedIds, users, allLabel)}</span>
        <ChevronDown size={14} />
      </button>
      {placement &&
        createPortal(
          <UserFilterPanel
            label={label}
            users={users}
            selectedIds={selectedIds}
            onChange={onChange}
            allLabel={allLabel}
            placement={placement}
            buttonRef={buttonRef}
            onClose={close}
            onMoved={placeOnButton}
          />,
          document.body,
        )}
    </>
  );
}
