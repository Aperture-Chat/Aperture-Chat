import {
  Archive,
  ArrowLeft,
  Bot,
  Brain,
  Bug,
  ListChecks,
  ChevronDown,
  CircleHelp,
  Clock3,
  Folder,
  FolderPlus,
  FileText,
  Menu,
  MessageSquare,
  Moon,
  Ellipsis,
  Pin,
  PinOff,
  Plus,
  Search,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  BookOpen,
  Building2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { createPortal } from "react-dom";
import { Fragment, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type FormEvent, type ReactNode } from "react";

import { LazyChunkBoundary, lazyWithReload } from "../lib/lazyChunk";

const UserGuidePlaylist = lazyWithReload("user-guide", () =>
  import("./UserTrainingVideos").then((module) => ({ default: module.UserGuidePlaylist })),
);
const MemoryManager = lazyWithReload("memory-manager", () =>
  import("./MemoryManager").then((module) => ({ default: module.MemoryManager })),
);
import type { MemoryManagerApi } from "./MemoryManager";
import type {
  AccountPasswordUpdateRequest,
  AccountProfileUpdateRequest,
  AccountApiKeyCreateResponse,
  AccountApiKeyStatus,
  BootstrapData,
  ChatThread,
  IssueReportRecord,
  IssueReportSubmission,
  Role,
  User,
} from "../lib/types";
import type { SearchNavigation } from "../lib/api/search";
import {
  defaultRouteForView,
  routeToPath,
  type AppRoute,
  type ViewKey,
} from "../lib/appRoute";
import type { ChatStore } from "../lib/chatStore";
import { buildCommands } from "../lib/commands";
import { UnsyncedWorkBadge } from "./UnsyncedWorkBadge";
import { roleLabel } from "../lib/accountDrawer";
import { isBlankNewChat } from "../lib/chatStore";
import { usableModels } from "../lib/modelAccess";
import { BREAKPOINTS, useViewportWidth } from "../lib/useViewport";
import { useModalFocus } from "../lib/useModalFocus";
import { CommandPalette } from "./CommandPalette";
import { ChatPreview } from "./ChatPreview";
import { ThemeScheduleDialog } from "./ThemeScheduleDialog";
import { DEFAULT_THEME_SCHEDULE, type ThemeSchedule } from "../lib/useThemeSchedule";
import { PlatformUpdateRow } from "./PlatformUpdateRow";
import { Logo } from "./Primitives";
import { UserAvatar } from "./UserAvatar";
import { AccountDrawer } from "./AccountDrawer";
import type { EscapeLayer } from "./AccountRow";
import { IssueReportForm } from "./IssueReportForm";
import { MyReportsPanel, type MyReportsApi } from "./MyReportsPanel";
import { forgetLegacyReadState, isThreadUnread } from "../lib/chatReadState";

export type { ViewKey };

const nav = [
  { key: "chat", label: "New chat", icon: Plus },
  { key: "drafts", label: "Drafts", icon: FileText },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "library", label: "Library", icon: BookOpen },
] as const;

const consoleNav = [
  { key: "admin", label: "Admin console", icon: ShieldCheck },
  { key: "platform", label: "Platform console", icon: Building2 },
] as const;

type ChatMenuAnchor = { top: number; bottom: number; right: number };

const CHAT_MENU_WIDTH = 190;
/** First-render guess (three actions) before the real height is measured. */
const CHAT_MENU_HEIGHT_ESTIMATE = 124;
const CHAT_MENU_GAP = 4;
const CHAT_MENU_VIEWPORT_MARGIN = 8;

/** Places a chat row menu below its trigger, or above it when the viewport
 * has no room below, keeping it fully on screen either way. */
function chatMenuPosition(anchor: ChatMenuAnchor, height: number): CSSProperties {
  const margin = CHAT_MENU_VIEWPORT_MARGIN;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(margin, Math.min(anchor.right - CHAT_MENU_WIDTH, viewportWidth - CHAT_MENU_WIDTH - margin));
  const below = anchor.bottom + CHAT_MENU_GAP;
  const above = anchor.top - CHAT_MENU_GAP - height;
  const fitsBelow = below + height + margin <= viewportHeight;
  const top = fitsBelow || above < margin
    ? Math.max(margin, Math.min(below, viewportHeight - height - margin))
    : above;
  return { left, top, maxHeight: viewportHeight - margin * 2 };
}

/** Shortcut hint for the search row; Apple keyboards label the key ⌘. */
const SEARCH_SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
    ? "⌘K"
    : "Ctrl K";

const NAV_TOOLTIPS: Record<
  (typeof nav)[number]["key"] | (typeof consoleNav)[number]["key"],
  string
> = {
  chat: "Start a fresh conversation with your workspace assistant",
  drafts: "Write and edit documents alongside the assistant",
  agents: "Run agent workflows and schedule recurring automations",
  library: "Browse knowledge sources and manage the tools available in chat",
  admin: "Manage users, groups, SSO, model access, and connections",
  platform: "Manage providers, keys, model availability, and audit policy",
};

const DEFAULT_RAIL_WIDTH = 226;
const MIN_RAIL_WIDTH = 208;
const MAX_RAIL_WIDTH = 340;

type ChatFolder = {
  id: string;
  name: string;
  created_at: string;
  // Root folders omit parent_id; subfolders nest under it. A parent id that
  // no longer resolves is treated as root so no folder can become orphaned.
  parent_id?: string | null;
};

/** Root + three nested levels; deeper trees stop reading as a sidebar. */
const FOLDER_MAX_DEPTH = 4;

function resolvedFolderParent(folder: ChatFolder, folderIds: Set<string>): string | null {
  return folder.parent_id && folderIds.has(folder.parent_id) && folder.parent_id !== folder.id
    ? folder.parent_id
    : null;
}

function childFoldersOf(folders: ChatFolder[], parentId: string | null): ChatFolder[] {
  const folderIds = new Set(folders.map((folder) => folder.id));
  return folders.filter((folder) => resolvedFolderParent(folder, folderIds) === parentId);
}

/** The folder plus every descendant. Iterative expansion, so a stored cycle
 * can never hang the sidebar. */
function folderSubtreeIds(folders: ChatFolder[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parent_id && ids.has(folder.parent_id) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}

function folderAncestorIds(folders: ChatFolder[], folderId: string): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const folderIds = new Set(byId.keys());
  const ancestors: string[] = [];
  let current = byId.get(folderId);
  while (current) {
    const parentId = resolvedFolderParent(current, folderIds);
    if (!parentId || ancestors.includes(parentId)) break;
    ancestors.push(parentId);
    current = byId.get(parentId);
  }
  return ancestors;
}

/** Depth-first flatten in tree order, for menus and drawers that list every
 * folder with its nesting depth. */
function flattenFolderTree(folders: ChatFolder[]): Array<{ folder: ChatFolder; depth: number }> {
  const rows: Array<{ folder: ChatFolder; depth: number }> = [];
  const visit = (parentId: string | null, depth: number) => {
    if (depth >= FOLDER_MAX_DEPTH + 1) return;
    childFoldersOf(folders, parentId).forEach((folder) => {
      rows.push({ folder, depth });
      visit(folder.id, depth + 1);
    });
  };
  visit(null, 0);
  return rows;
}


type UtilityDrawerKey = "help" | "report" | "my-reports" | "settings" | "account" | "all-chats" | "all-pinned" | "all-folders";

function memoryDrawerHint(data: BootstrapData): string {
  if (data.memoryState?.enabled) return "See and edit what the assistant remembers about you.";
  if (data.memoryState?.reason) return data.memoryState.reason;
  return "Personalization is currently off.";
}

const FOLDER_PREVIEW_LIMIT = 3;
const PINNED_PREVIEW_LIMIT = 3;
/* Floor and pre-measurement default; the rendered count adapts to the space
 * flex grants the recent list, so taller windows show more chats. */
const RECENT_PREVIEW_LIMIT = 4;
const RECENT_PREVIEW_MAX = 40;

export function AppShell(props: ComponentProps<typeof UserAppShell>) {
  // A new identity gets fresh local state before persistence effects run.
  // Otherwise the old user's folders/read markers can overwrite the new user's.
  return <UserAppShell key={props.data.me.id} {...props} />;
}

function UserAppShell({
  data,
  actualRole,
  viewAsRole,
  onViewAsRoleChange,
  currentView,
  onViewChange,
  onNavigate,
  openHelpRequestKey,
  darkMode,
  onToggleDarkMode,
  themeSchedule = DEFAULT_THEME_SCHEDULE,
  onSaveThemeSchedule,
  pwaInstallTarget,
  onOpenPwaInstall,
  threads,
  activeChatId,
  onOpenChat,
  onNewChat,
  onOpenDraft,
  unsyncedWork,
  onTogglePin,
  onArchiveThread,
  onRestoreThread,
  onDeleteThread,
  onMoveThreadToFolder,
  onMarkThreadRead,
  onSignOut,
  onRequestSignOut,
  onProfileUpdate,
  onPasswordUpdate,
  onApiKeyLoad,
  onApiKeyCreate,
  onApiKeyRevoke,
  onSubmitIssueReport,
  myReportsApi,
  memoryApi,
  children,
}: {
  data: BootstrapData;
  actualRole: Role;
  viewAsRole: Role | null;
  onViewAsRoleChange: (role: Role | null) => void;
  currentView: ViewKey;
  onViewChange: (view: ViewKey) => void;
  /** Route-level navigation (sections and ids); falls back to `onViewChange`. */
  onNavigate?: (route: AppRoute) => void;
  openHelpRequestKey?: number;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  themeSchedule?: ThemeSchedule;
  onSaveThemeSchedule?: (schedule: ThemeSchedule) => void;
  /* Set only in mobile browser tabs (iOS/Android, not already installed);
   * gates the persistent "Install app" sidebar entry point. */
  pwaInstallTarget?: "ios" | "android" | null;
  onOpenPwaInstall?: () => void;
  threads: ChatThread[];
  activeChatId: string;
  onOpenChat: (id: string) => void;
  onNewChat: () => void;
  /** Opens one saved server draft fully loaded in the Drafter (search hits). */
  onOpenDraft?: (draftId: string) => void;
  /** Chat sync state for the "only on this device" badge; omitted in tests that mock the store. */
  unsyncedWork?: Pick<ChatStore, "threads" | "unsyncedThreadCount" | "retryUnsyncedThreads">;
  onTogglePin: (id: string) => void;
  onArchiveThread: (id: string) => void;
  onRestoreThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onMoveThreadToFolder: (id: string, folderId: string | null) => void;
  /** Records that the owner has seen a chat's newest reply (server-backed). */
  onMarkThreadRead?: (id: string) => void;
  onSignOut?: () => void;
  /** Voluntary sign-out may first preserve unfinished workspace edits. */
  onRequestSignOut?: () => void;
  onProfileUpdate?: (payload: AccountProfileUpdateRequest) => void | User | Promise<User | void>;
  onPasswordUpdate?: (payload: AccountPasswordUpdateRequest) => void | Promise<void>;
  onApiKeyLoad?: () => Promise<AccountApiKeyStatus>;
  onApiKeyCreate?: (options: { replace: boolean }) => Promise<AccountApiKeyCreateResponse>;
  onApiKeyRevoke?: () => Promise<AccountApiKeyStatus>;
  onSubmitIssueReport?: (payload: IssueReportSubmission) => Promise<IssueReportRecord | void>;
  myReportsApi?: MyReportsApi;
  memoryApi?: MemoryManagerApi;
  children: ReactNode;
}) {
  // A tenant brand gradient turns every rail into the dark treatment so the
  // gradient (set via --sidebar-gradient) shows with legible light text.
  const [themeScheduleOpen, setThemeScheduleOpen] = useState(false);
  const brandedRail = Boolean(
    data.currentTenant.gradient_start?.trim() && data.currentTenant.gradient_end?.trim(),
  );
  const darkRail = currentView === "admin" || currentView === "platform" || brandedRail;
  const [isRailCollapsed, setIsRailCollapsed] = useState(false);
  const [railWidth, setRailWidth] = useState(readSavedRailWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [drawer, setDrawer] = useState<UtilityDrawerKey | null>(null);
  // Unread support replies drive the dot on Help; the focus id opens one
  // report directly (for example right after sending it).
  const [reportsUnread, setReportsUnread] = useState(0);
  const [myReportsFocusId, setMyReportsFocusId] = useState<string | null>(null);
  const showReportsDot = reportsUnread > 0;
  useEffect(() => {
    if (!myReportsApi) return;
    if (drawer !== null && drawer !== "help") return;
    let active = true;
    myReportsApi
      .list()
      .then((items) => {
        if (active) setReportsUnread(items.filter((item) => item.unread).length);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [myReportsApi, drawer]);
  const [securityCloseBlocked, setSecurityCloseBlocked] = useState(false);
  const securityCloseBlockedRef = useRef(false);
  const updateSecurityCloseGuard = (blocked: boolean) => {
    securityCloseBlockedRef.current = blocked;
    setSecurityCloseBlocked(blocked);
  };
  const [paletteOpen, setPaletteOpen] = useState(false);
  // One chat row's "More actions" menu at a time. It renders in a portal at
  // the top layer, anchored to its trigger, so no sidebar section can clip it.
  const [chatMenu, setChatMenu] = useState<{
    threadId: string;
    view: "actions" | "folders";
    anchor: ChatMenuAnchor;
  } | null>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  const [chatMenuHeight, setChatMenuHeight] = useState(CHAT_MENU_HEIGHT_ESTIMATE);
  // People can tuck the whole chat history away; the choice is remembered per
  // account on this device. Search still finds every chat while it is hidden.
  const [chatsHidden, setChatsHidden] = useState(() => loadChatsHidden(data.me.id));
  const [folders, setFolders] = useState<ChatFolder[]>(() => loadChatFolders(data.me.id));
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  // Parent for the folder being created: null = a new root folder.
  const [folderCreateParentId, setFolderCreateParentId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  // Folders expand independently, so a whole subtree path can stay open.
  const [expandedFolderIds, setExpandedFolderIds] = useState<ReadonlySet<string>>(new Set());
  // The most recently opened folder keeps its root visible in the preview.
  const [lastExpandedFolderId, setLastExpandedFolderId] = useState<string | null>(null);
  const [pendingFolderThreadId, setPendingFolderThreadId] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const overlayOpenerRef = useRef<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const width = useViewportWidth();
  const isDrawer = width <= BREAKPOINTS.drawer;
  const autoCollapsed = currentView === "drafts";
  const collapsed = (isRailCollapsed || autoCollapsed) && !isDrawer;
  // A drawer, the palette, or Memory holds focus, so the shell behind it is out of reach.
  const shellInert = Boolean(drawer || paletteOpen || memoryOpen);
  useModalFocus(sidebarRef, isDrawer && navOpen, () => setNavOpen(false));

  // The active blank "New chat" is the empty-state landing, not a list entry.
  const activeChats = threads.filter((session) => !isBlankNewChat(session) && !session.archived);
  const folderIds = new Set(folders.map((folder) => folder.id));
  const pinnedChats = activeChats.filter((session) => session.pinned);
  const recentChats = activeChats.filter(
    (session) => !session.pinned && (!session.folder_id || !folderIds.has(session.folder_id)),
  );
  // The preview caps ROOT folders; subfolders render inside their expanded
  // parents. The root of the most recently opened folder always stays listed.
  const rootFolders = childFoldersOf(folders, null);
  const expandedRootId = lastExpandedFolderId
    ? [lastExpandedFolderId, ...folderAncestorIds(folders, lastExpandedFolderId)].find((id) =>
        rootFolders.some((folder) => folder.id === id),
      ) ?? null
    : null;
  const visibleFolders = previewFolders(rootFolders, FOLDER_PREVIEW_LIMIT, expandedRootId);
  const visiblePinnedChats = previewThreads(pinnedChats, PINNED_PREVIEW_LIMIT, activeChatId);
  // The recent list flexes to fill the sidebar down to the utility divider;
  // the row count is measured from the height flex actually grants it, so
  // taller windows show more chats and "View all chats" stays pinned just
  // above the divider. Environments without layout keep the static floor.
  const [recentFitCount, setRecentFitCount] = useState(RECENT_PREVIEW_LIMIT);
  const [recentFitMeasured, setRecentFitMeasured] = useState(false);
  const recentListRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const list = recentListRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const height = list.clientHeight;
      if (height <= 0) return;
      const firstRow = list.firstElementChild;
      const rowHeight = firstRow instanceof HTMLElement && firstRow.offsetHeight > 0 ? firstRow.offsetHeight : 30;
      const rowGap = 1;
      const rows = Math.floor((height + rowGap) / (rowHeight + rowGap));
      if (rows > 0) {
        setRecentFitCount(Math.min(Math.max(rows, 2), RECENT_PREVIEW_MAX));
        setRecentFitMeasured(true);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [collapsed, chatsHidden, recentChats.length]);
  // With real layout, one extra row renders partially clipped under the
  // fade, so the list visibly dissolves right where it meets the button
  // instead of stopping at a hard whole-row gap.
  const recentRenderCount =
    recentFitMeasured && recentChats.length > recentFitCount ? recentFitCount + 1 : recentFitCount;
  const visibleRecentChats = previewThreads(recentChats, recentRenderCount, activeChatId);
  const visibleRailWidth = collapsed ? 76 : railWidth;
  const sidebarConsoles = consoleNav.filter(({ key }) =>
    key === "platform"
      ? data.me.role === "PLATFORM_OWNER"
      : data.me.role === "TENANT_ADMIN" || data.me.role === "PLATFORM_OWNER",
  );

  useEffect(() => {
    setFolders(loadChatFolders(data.me.id));
    setExpandedFolderIds(new Set());
    setLastExpandedFolderId(null);
    setFolderCreateParentId(null);
    setChatMenu(null);
    setPendingFolderThreadId(null);
  }, [data.me.id]);

  useEffect(() => {
    saveChatFolders(data.me.id, folders);
  }, [data.me.id, folders]);

  useEffect(() => {
    forgetLegacyReadState(data.me.id);
  }, [data.me.id]);

  // The conversation on screen is being read right now, including a reply
  // that finishes while the user watches it arrive.
  const openThread = currentView === "chat" ? threads.find((thread) => thread.id === activeChatId) : undefined;
  const openThreadUnread = openThread ? isThreadUnread(openThread) : false;
  useEffect(() => {
    if (openThreadUnread && openThread) onMarkThreadRead?.(openThread.id);
  }, [openThread, openThreadUnread, onMarkThreadRead]);

  // Close the mobile drawer when we grow back to a desktop layout.
  useEffect(() => {
    if (!isDrawer && navOpen) setNavOpen(false);
  }, [isDrawer, navOpen]);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (isDrawer && navOpen) {
      document.body.classList.add("nav-locked");
      return () => document.body.classList.remove("nav-locked");
    }
    return undefined;
  }, [isDrawer, navOpen]);

  useEffect(() => {
    if (!isResizing) return;

    function onMouseMove(event: MouseEvent) {
      const nextWidth = Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, event.clientX));
      setRailWidth(nextWidth);
      saveRailWidth(nextWidth);
      if (isRailCollapsed) {
        setIsRailCollapsed(false);
      }
    }

    function onMouseUp() {
      setIsResizing(false);
    }

    document.body.classList.add("is-resizing-rail");
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      document.body.classList.remove("is-resizing-rail");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isRailCollapsed, isResizing]);

  useEffect(() => {
    if (!openHelpRequestKey) return;
    if (securityCloseBlockedRef.current) return;
    setDrawer("help");
    setNavOpen(false);
  }, [openHelpRequestKey]);

  // Cmd/Ctrl+K toggles the global search palette from anywhere in the shell.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        if (securityCloseBlockedRef.current) return;
        setPaletteOpen((open) => !open);
        setDrawer(null);
        setNavOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A chat row menu closes on an outside press or Escape; Escape returns focus
  // to the row's "More actions" button so keyboard users keep their place. It
  // follows its trigger while anything scrolls and closes once the row leaves
  // the visible chat list.
  const chatMenuThreadId = chatMenu?.threadId ?? null;
  useEffect(() => {
    if (!chatMenuThreadId) return;
    const menuTrigger = () =>
      Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>("[data-chat-row-id]") ?? [])
        .find((row) => row.dataset.chatRowId === chatMenuThreadId)
        ?.querySelector<HTMLButtonElement>(".chat-row-more") ?? null;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && (chatMenuRef.current?.contains(target) || menuTrigger()?.contains(target))) return;
      setChatMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Captured first so an open mobile navigation drawer stays open.
      event.preventDefault();
      event.stopPropagation();
      setChatMenu(null);
      menuTrigger()?.focus();
    }
    function reposition() {
      const trigger = menuTrigger();
      const list = trigger?.closest(".sidebar-main");
      if (!trigger || !list) {
        setChatMenu(null);
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      if (rect.bottom < bounds.top || rect.top > bounds.bottom) {
        setChatMenu(null);
        return;
      }
      setChatMenu((current) =>
        current &&
        (current.anchor.top !== rect.top || current.anchor.bottom !== rect.bottom || current.anchor.right !== rect.right)
          ? { ...current, anchor: { top: rect.top, bottom: rect.bottom, right: rect.right } }
          : current,
      );
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    focusChatMenuItem(chatMenuRef.current, 0);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [chatMenuThreadId]);

  // Switching between the action list and the folder list starts at the top.
  const chatMenuView = chatMenu?.view ?? null;
  useEffect(() => {
    if (chatMenuView === "folders") focusChatMenuItem(chatMenuRef.current, 0);
  }, [chatMenuView]);

  // Placement uses the rendered height so a long folder list still flips
  // above its trigger or stays inside the viewport.
  useLayoutEffect(() => {
    const height = chatMenuRef.current?.offsetHeight;
    if (height && height !== chatMenuHeight) setChatMenuHeight(height);
  });

  const closeDrawer = () => setNavOpen(false);

  const openUtilityDrawer = (nextDrawer: UtilityDrawerKey) => {
    if (securityCloseBlockedRef.current) return;
    // Read now: the sidebar goes inert in the commit that opens the drawer, which
    // blurs this element before any effect can see it.
    if (!drawer && document.activeElement instanceof HTMLElement) overlayOpenerRef.current = document.activeElement;
    setDrawer(nextDrawer);
    closeDrawer();
  };

  const overlayOpen = Boolean(drawer) || memoryOpen;
  useEffect(() => {
    if (overlayOpen) return;
    const opener = overlayOpenerRef.current;
    overlayOpenerRef.current = null;
    // Something else already took focus, such as a composer in an opened chat.
    const focused = document.activeElement;
    if (!opener || (focused !== document.body && focused !== opener)) return;
    const stillReachable = opener.isConnected && !opener.closest("[inert]") && opener.getBoundingClientRect().right >= 0;
    (stillReachable ? opener : menuButtonRef.current)?.focus({ preventScroll: true });
  }, [overlayOpen]);

  const handleSelectView = (view: ViewKey) => {
    if (securityCloseBlockedRef.current) return;
    onViewChange(view);
    setDrawer(null);
    closeDrawer();
  };

  const handleNavigateRoute = (route: AppRoute) => {
    if (securityCloseBlockedRef.current) return;
    if (onNavigate) onNavigate(route);
    else onViewChange(route.kind);
    setDrawer(null);
    closeDrawer();
  };

  // Palette commands share the rail's role predicates and existing actions;
  // nothing here can reach a screen the role could not open from the rail.
  const paletteCommands = useMemo(
    () =>
      buildCommands({
        role: data.me.role,
        route: defaultRouteForView(currentView),
        darkMode,
        actions: {
          navigate: (route) => {
            if (route.kind === "chat") handleNewChat();
            else handleNavigateRoute(route);
          },
          newChat: () => handleNewChat(),
          toggleDarkMode: onToggleDarkMode,
          openHelp: () => openUtilityDrawer("help"),
          installApp: pwaInstallTarget && onOpenPwaInstall ? onOpenPwaInstall : undefined,
          signOut: onRequestSignOut ?? onSignOut,
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.me.role, currentView, darkMode, pwaInstallTarget, onOpenPwaInstall, onRequestSignOut, onSignOut, onToggleDarkMode],
  );

  const handleOpenChat = (id: string) => {
    if (securityCloseBlockedRef.current) return;
    onMarkThreadRead?.(id);
    onOpenChat(id);
    setDrawer(null);
    closeDrawer();
  };

  const handleNewChat = () => {
    if (securityCloseBlockedRef.current) return;
    onNewChat();
    setDrawer(null);
    closeDrawer();
  };

  const openPalette = () => {
    if (securityCloseBlockedRef.current) return;
    setPaletteOpen(true);
    setDrawer(null);
    closeDrawer();
  };

  /**
   * Routes a backend search `navigation` object through the same mechanisms
   * the shell already uses (thread open + view switch). Returns false when
   * this build has no screen for the target so the palette can say so
   * honestly instead of faking a landing page.
   */
  const handlePaletteNavigate = (navigation: SearchNavigation): boolean => {
    if (securityCloseBlockedRef.current) return false;
    const view = navigation.view;
    if (view === "chat") {
      const threadId = navigation.thread_id;
      if (!threadId) return false;
      handleOpenChat(threadId);
      return true;
    }
    if (view === "drafts" && navigation.draft_id && onOpenDraft) {
      // A draft hit opens THAT document fully loaded, not a blank workspace.
      onOpenDraft(navigation.draft_id);
      setDrawer(null);
      closeDrawer();
      return true;
    }
    if (view === "drafts" || view === "agents") {
      handleNavigateRoute(defaultRouteForView(view));
      return true;
    }
    if (view === "library") {
      handleNavigateRoute({ kind: "library", section: "knowledge" });
      return true;
    }
    if (view === "automations") {
      // Automations live inside the Agents workspace section tabs.
      handleNavigateRoute({ kind: "agents", section: "automations" });
      return true;
    }
    // Review-grid and matter results have no product surface by decision:
    // the platform targets horizontal knowledge work, not legal verticals.
    return false;
  };

  // Expands a folder and its whole ancestor chain so it is actually visible.
  const revealFolder = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      next.add(folderId);
      folderAncestorIds(folders, folderId).forEach((ancestorId) => next.add(ancestorId));
      return next;
    });
    setLastExpandedFolderId(folderId);
  };

  const toggleFolderExpanded = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
        setLastExpandedFolderId(folderId);
      }
      return next;
    });
  };

  const startCreatingFolder = (parentId: string | null) => {
    setFolderCreateParentId(parentId);
    setIsCreatingFolder(true);
    if (parentId) revealFolder(parentId);
  };

  const handleCreateFolder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    const folder: ChatFolder = {
      id: createFolderId(),
      name,
      created_at: new Date().toISOString(),
      ...(folderCreateParentId ? { parent_id: folderCreateParentId } : {}),
    };
    setFolders((current) => [...current, folder]);
    revealFolder(folder.id);
    if (pendingFolderThreadId) {
      onMoveThreadToFolder(pendingFolderThreadId, folder.id);
    }
    setNewFolderName("");
    setIsCreatingFolder(false);
    setFolderCreateParentId(null);
    setPendingFolderThreadId(null);
  };

  const startFolderForThread = (chatId: string) => {
    setPendingFolderThreadId(chatId);
    startCreatingFolder(null);
  };

  const handleMoveToFolder = (chatId: string, folderId: string | null) => {
    onMoveThreadToFolder(chatId, folderId);
    if (folderId) revealFolder(folderId);
  };

  const handleDeleteFolder = (folder: ChatFolder) => {
    // Deleting removes the folder and every subfolder under it; all their
    // chats return to Recent, never silently disappearing.
    const subtreeIds = folderSubtreeIds(folders, folder.id);
    const subfolderCount = subtreeIds.size - 1;
    const subtreeChats = activeChats.filter(
      (thread) => thread.folder_id && subtreeIds.has(thread.folder_id),
    );
    const confirmed = window.confirm(
      subfolderCount > 0
        ? `Delete "${folder.name}" and its ${subfolderCount} subfolder${
            subfolderCount === 1 ? "" : "s"
          }? Chats in them will stay in Recent.`
        : `Delete "${folder.name}"? Chats in this folder will stay in Recent.`,
    );
    if (!confirmed) return;
    subtreeChats.forEach((thread) => onMoveThreadToFolder(thread.id, null));
    setFolders((current) => current.filter((item) => !subtreeIds.has(item.id)));
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      subtreeIds.forEach((id) => next.delete(id));
      return next;
    });
    setLastExpandedFolderId((current) => (current && subtreeIds.has(current) ? null : current));
    setFolderCreateParentId((current) => (current && subtreeIds.has(current) ? null : current));
    setPendingFolderThreadId(null);
    setChatMenu(null);
  };

  const hiddenChatsUnread = chatsHidden && activeChats.some((thread) => isThreadUnread(thread));
  const hiddenChatsSummary = chatsHidden && activeChats.length > 0
    ? `${activeChats.length} ${activeChats.length === 1 ? "chat" : "chats"} hidden${hiddenChatsUnread ? ", with unread replies" : ""}`
    : undefined;

  const updateChatsHidden = (hidden: boolean) => {
    setChatsHidden(hidden);
    saveChatsHidden(data.me.id, hidden);
    if (hidden) setChatMenu(null);
  };

  const toggleChatMenu = (threadId: string, trigger: HTMLElement) => {
    if (chatMenu?.threadId === threadId) {
      setChatMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setChatMenu({ threadId, view: "actions", anchor: { top: rect.top, bottom: rect.bottom, right: rect.right } });
  };

  const runChatMenuAction = (action: () => void) => {
    setChatMenu(null);
    action();
  };

  const renderChatMenu = (item: ChatThread) => {
    if (!chatMenu) return null;
    const folderView = chatMenu.view === "folders";
    return createPortal(
      <div
        ref={chatMenuRef}
        className="thread-folder-menu chat-row-menu"
        style={chatMenuPosition(chatMenu.anchor, chatMenuHeight)}
        role="menu"
        aria-label={folderView ? `Move ${item.title} to a folder` : `Actions for ${item.title}`}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusChatMenuItem(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        {folderView ? (
          <>
            <strong>Move to folder</strong>
            {flattenFolderTree(folders).map(({ folder, depth }) => (
              <button
                key={folder.id}
                type="button"
                role="menuitem"
                style={depth > 0 ? { paddingLeft: 7 + depth * 14 } : undefined}
                onClick={() => runChatMenuAction(() => handleMoveToFolder(item.id, folder.id))}
              >
                <Folder size={13} />
                <span>{folder.name}</span>
              </button>
            ))}
            {item.folder_id && (
              <button
                type="button"
                role="menuitem"
                onClick={() => runChatMenuAction(() => handleMoveToFolder(item.id, null))}
              >
                <X size={13} />
                <span>Remove from folder</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => runChatMenuAction(() => startFolderForThread(item.id))}
            >
              <Plus size={13} />
              <span>New folder</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              role="menuitem"
              onClick={() => runChatMenuAction(() => onTogglePin(item.id))}
            >
              {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              <span>{item.pinned ? "Unpin chat" : "Pin chat"}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (folders.length === 0) {
                  runChatMenuAction(() => startFolderForThread(item.id));
                } else {
                  setChatMenu((current) => (current ? { ...current, view: "folders" } : current));
                }
              }}
            >
              <FolderPlus size={14} />
              <span>Move to folder</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => runChatMenuAction(() => onArchiveThread(item.id))}
            >
              <Archive size={14} />
              <span>Archive</span>
            </button>
          </>
        )}
      </div>,
      document.body,
    );
  };

  const renderChatRow = (item: ChatThread) => {
    const selected = currentView === "chat" && item.id === activeChatId;
    const menuOpen = chatMenu?.threadId === item.id;
    return (
      <div
        className={clsx(
          "chat-row",
          selected && "is-selected",
          item.pinned && "is-pinned",
          isThreadUnread(item) && "is-unread",
          menuOpen && "has-open-menu",
        )}
        data-chat-row-id={item.id}
        key={item.id}
      >
        {isThreadUnread(item) && (
          <span className="chat-unread-dot" role="status" aria-label="Unread reply" />
        )}
        <ChatPreview thread={item}>
          <button
            className={clsx("minor-row", "chat-open", selected && "is-selected")}
            type="button"
            onClick={() => handleOpenChat(item.id)}
          >
            {item.used_agent ? <Bot size={14} /> : <MessageSquare size={14} />}
            <span>{item.title}</span>
          </button>
        </ChatPreview>
        <div className="chat-row-actions">
          <button
            className="pin-toggle chat-row-action chat-row-more"
            type="button"
            aria-label={`More actions for ${item.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-tooltip="Pin, file, or archive this chat"
            onClick={(event) => toggleChatMenu(item.id, event.currentTarget)}
          >
            <Ellipsis size={16} />
          </button>
        </div>
        {menuOpen && !collapsed && renderChatMenu(item)}
      </div>
    );
  };

  const folderCreateForm = (
    <form className="folder-create-form" onSubmit={handleCreateFolder}>
      <input
        value={newFolderName}
        onChange={(event) => setNewFolderName(event.target.value)}
        placeholder={folderCreateParentId ? "Subfolder name" : "Folder name"}
        aria-label="Folder name"
        autoFocus
      />
      <button type="submit" data-tooltip="Save this folder and add it to your sidebar">Create</button>
    </form>
  );

  // One folder plus, when expanded, its subfolders and direct chats — the
  // tree renders by recursion so subfolders nest to FOLDER_MAX_DEPTH levels.
  const renderFolderNode = (folder: ChatFolder, depth: number): ReactNode => {
    const directChats = activeChats.filter((thread) => thread.folder_id === folder.id);
    const subtreeIds = folderSubtreeIds(folders, folder.id);
    const subtreeChatCount = activeChats.filter(
      (thread) => thread.folder_id && subtreeIds.has(thread.folder_id),
    ).length;
    const nestedFolders = childFoldersOf(folders, folder.id);
    const expanded = expandedFolderIds.has(folder.id);
    const canNest = depth + 1 < FOLDER_MAX_DEPTH;
    return (
      <div className={clsx("folder-block", depth > 0 && "is-subfolder")} key={folder.id}>
        <div className={clsx("folder-row-shell", expanded && "is-selected")}>
          <button
            className={clsx("minor-row", "folder-row", expanded && "is-selected")}
            type="button"
            data-tooltip={
              expanded
                ? `Collapse the "${folder.name}" folder to tidy your sidebar`
                : `Expand the "${folder.name}" folder to see the chats inside`
            }
            aria-expanded={expanded}
            onClick={() => toggleFolderExpanded(folder.id)}
          >
            <Folder size={15} />
            <span>{folder.name}</span>
            <small>{subtreeChatCount}</small>
          </button>
          <div className="folder-row-actions">
            {canNest && (
              <button
                className="folder-delete-button folder-subfolder-button"
                type="button"
                aria-label={`Create subfolder in ${folder.name}`}
                data-tooltip={`Create a subfolder inside "${folder.name}"`}
                onClick={() => startCreatingFolder(folder.id)}
              >
                <Plus size={13} />
              </button>
            )}
            <button
              className="folder-delete-button"
              type="button"
              aria-label={`Delete ${folder.name} folder`}
              data-tooltip={
                nestedFolders.length > 0
                  ? `Delete "${folder.name}" and its subfolders — their chats move back to Recent`
                  : `Delete "${folder.name}" — its chats move back to Recent`
              }
              onClick={() => handleDeleteFolder(folder)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        {expanded && (
          <div className="folder-children">
            {isCreatingFolder && folderCreateParentId === folder.id && folderCreateForm}
            {nestedFolders.map((child) => renderFolderNode(child, depth + 1))}
            <div className="folder-chat-list">
              {directChats.length > 0 ? (
                previewThreads(directChats, 3, activeChatId).map(renderChatRow)
              ) : nestedFolders.length === 0 ? (
                <p className="sidebar-empty">No chats yet.</p>
              ) : null}
              {directChats.length > 3 && (
                <button
                  className="link-button"
                  type="button"
                  data-tooltip={`See every chat saved in "${folder.name}" in one list`}
                  onClick={() => openUtilityDrawer("all-folders")}
                >
                  View folder chats
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={clsx(
        "app",
        darkMode && "theme-dark",
        collapsed && "rail-collapsed",
        isDrawer && "is-drawer",
        navOpen && "nav-open",
        currentView === "drafts" && "view-drafts",
      )}
      style={
        {
          gridTemplateColumns: `${visibleRailWidth}px minmax(0, 1fr)`,
          "--app-content-left": isDrawer ? "0px" : `${visibleRailWidth}px`,
          "--rail-open-width": `${railWidth}px`,
        } as CSSProperties
      }
    >
      <a className="skip-link" href="#workspace-content">Skip to workspace</a>
      {isDrawer && (
        <button
          type="button"
          ref={menuButtonRef}
          className="mobile-hamburger"
          aria-label={navOpen ? "Close menu" : "Open menu"}
          data-tooltip={navOpen ? "Hide the navigation menu and return to your work" : "Open the menu to switch views and find your chats"}
          aria-expanded={navOpen}
          aria-controls="workspace-navigation"
          inert={shellInert}
          onClick={() => setNavOpen((value) => !value)}
        >
          <Menu size={18} />
        </button>
      )}
      {isDrawer && navOpen && (
        <button
          type="button"
          className="nav-backdrop"
          aria-label="Close menu"
          data-tooltip="Dismiss the navigation menu and get back to the page"
          onClick={closeDrawer}
        />
      )}

      {/* The rail's edge is the control. It sits outside the rail so nothing in
       * the logo row moves when the rail narrows, and before it so it stays
       * the first stop for the keyboard. */}
      {!isDrawer && !autoCollapsed && (
        <button
          className="rail-seam"
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls="workspace-navigation"
          data-tooltip={
            collapsed
              ? "Expand the sidebar to see your chats and folders again"
              : "Collapse the sidebar to give your workspace more room"
          }
          inert={shellInert}
          onClick={() => setIsRailCollapsed((value) => !value)}
        >
          <span className="rail-seam-bar" aria-hidden="true" />
          <span className="rail-seam-bar" aria-hidden="true" />
        </button>
      )}

      <aside
        id="workspace-navigation"
        ref={sidebarRef}
        className={clsx("sidebar", darkRail && "sidebar-dark", collapsed && "is-collapsed")}
        role={isDrawer && navOpen ? "dialog" : undefined}
        aria-modal={isDrawer && navOpen ? true : undefined}
        aria-label={isDrawer && navOpen ? "Navigation" : undefined}
        inert={(isDrawer && !navOpen) || shellInert}
        tabIndex={-1}
      >
        <div className="sidebar-top">
          {/* Both logos stay mounted so one can dissolve into the other. */}
          <div className="rail-brand">
            <Logo decorative={collapsed} brand={data.currentTenant} />
            <Logo compact decorative={!collapsed} brand={data.currentTenant} />
          </div>
          {isDrawer && (
            <button className="icon-button" type="button" aria-label="Close navigation" onClick={closeDrawer}>
              <X size={18} />
            </button>
          )}
        </div>

        <nav className="primary-nav" aria-label="Primary">
          {nav.map(({ key, label, icon: Icon }) =>
            key === "chat" ? (
              <Fragment key={key}>
                <button
                  className={clsx("nav-item", currentView === key && "is-active")}
                  type="button"
                  aria-label={label}
                  aria-current={currentView === key ? "page" : undefined}
                  data-tooltip={NAV_TOOLTIPS[key]}
                  onClick={handleNewChat}
                >
                  <Icon size={19} />
                  <span>{label}</span>
                </button>
                <button
                  className="nav-item nav-search"
                  type="button"
                  aria-label="Search"
                  aria-keyshortcuts="Control+K Meta+K"
                  data-tooltip="Search previous chats, including archived, plus agents, drafts, and indexed documents"
                  onClick={openPalette}
                >
                  <Search size={19} />
                  <span>Search</span>
                  <kbd className="nav-shortcut" aria-hidden="true">{SEARCH_SHORTCUT_LABEL}</kbd>
                </button>
              </Fragment>
            ) : (
              /* Real links so copy-link and middle-click open the same screen;
               * a plain click stays in-app through the navigation guard. */
              <a
                key={key}
                className={clsx("nav-item", currentView === key && "is-active")}
                href={routeToPath(defaultRouteForView(key))}
                aria-label={label}
                aria-current={currentView === key ? "page" : undefined}
                data-tooltip={NAV_TOOLTIPS[key]}
                onClick={(event) => {
                  if (event.defaultPrevented || event.button !== 0) return;
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  handleSelectView(key);
                }}
              >
                <Icon size={19} />
                <span>{label}</span>
              </a>
            ),
          )}
        </nav>

        {/* The list stays mounted at its open width, so the closing rail passes
         * over it instead of reflowing it, and inert keeps it out of reach. */}
        <div className="sidebar-main chat-library" inert={collapsed}>
          {/* Chat history shows folders first, then pinned chats, then
           * everything recent. Group labels appear only when more than one
           * group exists, so a short history stays one list. The heading
           * hides or shows the whole history. */}
          <div className="section-label-row chat-library-heading">
            <button
              className="chat-library-toggle"
              type="button"
              aria-label="Chats"
              aria-expanded={!chatsHidden}
              aria-controls="sidebar-chat-sections"
              aria-description={hiddenChatsSummary}
              data-tooltip={chatsHidden ? "Show your chats" : "Hide your chats"}
              onClick={() => updateChatsHidden(!chatsHidden)}
            >
              <span className="section-label">Chats</span>
              <ChevronDown className="chat-library-chevron" size={14} aria-hidden="true" />
              {chatsHidden && activeChats.length > 0 && (
                <span className="chat-library-count" aria-hidden="true">
                  {activeChats.length}
                </span>
              )}
              {hiddenChatsUnread && <span className="chat-library-unread" aria-hidden="true" />}
            </button>
            {!chatsHidden && (
              <button
                className="section-icon-button folder-create-button"
                type="button"
                aria-label="Create chat folder"
                aria-pressed={isCreatingFolder && folderCreateParentId === null}
                data-tooltip="Create a folder to group related chats in your sidebar"
                onClick={() => {
                  setPendingFolderThreadId(null);
                  if (isCreatingFolder && folderCreateParentId === null) {
                    setIsCreatingFolder(false);
                  } else {
                    startCreatingFolder(null);
                  }
                }}
              >
                <FolderPlus size={15} />
              </button>
            )}
          </div>

          {!chatsHidden && (
            <div id="sidebar-chat-sections" className="chat-navigation-panel">
              {(folders.length > 0 || (isCreatingFolder && folderCreateParentId === null)) && (
                <div className="chat-section folder-section" role="group" aria-label="Folders">
                  {isCreatingFolder && folderCreateParentId === null && folderCreateForm}
                  {folders.length > 0 && (
                    <div className={clsx("sidebar-list-preview", rootFolders.length > FOLDER_PREVIEW_LIMIT && "has-overflow")}>
                      {visibleFolders.map((folder) => renderFolderNode(folder, 0))}
                    </div>
                  )}
                  {rootFolders.length > FOLDER_PREVIEW_LIMIT && (
                    <button
                      className="link-button sidebar-view-all"
                      type="button"
                      data-tooltip="Open the full list of your folders and their chats"
                      onClick={() => openUtilityDrawer("all-folders")}
                    >
                      View all folders
                    </button>
                  )}
                </div>
              )}

              {pinnedChats.length > 0 && (
                <div className="chat-section" role="group" aria-labelledby="sidebar-pinned-label">
                  <span className="chat-section-label" id="sidebar-pinned-label">Pinned</span>
                  <div className={clsx("sidebar-list-preview", pinnedChats.length > PINNED_PREVIEW_LIMIT && "has-overflow")}>
                    {visiblePinnedChats.map(renderChatRow)}
                  </div>
                  {pinnedChats.length > PINNED_PREVIEW_LIMIT && (
                    <button
                      className="link-button sidebar-view-all"
                      type="button"
                      data-tooltip="See every chat you have pinned in one place"
                      onClick={() => openUtilityDrawer("all-pinned")}
                    >
                      View all pinned
                    </button>
                  )}
                </div>
              )}

              <div className="chat-section recent-section" role="group" aria-labelledby="sidebar-recent-label">
                <span
                  className={clsx(
                    "chat-section-label",
                    !(pinnedChats.length > 0 || folders.length > 0) && "sr-only",
                  )}
                  id="sidebar-recent-label"
                >
                  Recent
                </span>
                {recentChats.length > 0 ? (
                  <>
                    <div
                      ref={recentListRef}
                      className={clsx("sidebar-list-preview", recentChats.length > recentFitCount && "has-overflow")}
                    >
                      {visibleRecentChats.map(renderChatRow)}
                    </div>
                    {recentChats.length > recentFitCount && (
                      <button
                        className="link-button sidebar-view-all"
                        type="button"
                        data-tooltip="Browse your full chat history beyond the recent list"
                        onClick={() => openUtilityDrawer("all-chats")}
                      >
                        View all chats
                      </button>
                    )}
                  </>
                ) : activeChats.length === 0 ? (
                  <p className="sidebar-empty">Your conversations will appear here.</p>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <div className="sidebar-bottom">
          <div className="utility-rows">
            <PlatformUpdateRow userId={data.me.id} enabled={data.me.role === "PLATFORM_OWNER"} />
            {unsyncedWork && (
              <UnsyncedWorkBadge
                chat={unsyncedWork}
                scope={{ tenantId: data.currentTenant.id, userId: data.me.id }}
                collapsed={collapsed}
                onOpenDrafts={() => handleSelectView("drafts")}
              />
            )}
            {/* Management consoles follow the effective (previewed) role, the
             * same rule the account panel and route guard apply. */}
            {sidebarConsoles.map(({ key, label, icon: Icon }) => {
              const pendingRequests =
                key === "admin" && typeof data.modelAccessRequestCount === "number"
                  ? data.modelAccessRequestCount
                  : 0;
              return (
                <a
                  key={key}
                  className={clsx("minor-row console-link", currentView === key && "is-selected")}
                  href={routeToPath(defaultRouteForView(key))}
                  aria-label={label}
                  aria-current={currentView === key ? "page" : undefined}
                  data-tooltip={NAV_TOOLTIPS[key]}
                  onClick={(event) => {
                    if (event.defaultPrevented || event.button !== 0) return;
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    handleSelectView(key);
                  }}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                  {pendingRequests > 0 && (
                    <span
                      className="pill pill-warning console-link-count"
                      aria-label={`${pendingRequests} pending model access ${pendingRequests === 1 ? "request" : "requests"}`}
                    >
                      {pendingRequests}
                    </span>
                  )}
                </a>
              );
            })}
            <div className="theme-mode-row help-row">
              <button
                className="minor-row"
                type="button"
                aria-label="Help"
                data-tooltip="Get guidance on knowledge sources and agent workflows"
                onClick={() => openUtilityDrawer("help")}
              >
                <CircleHelp size={16} />
                <span>Help</span>
                {showReportsDot && (
                  <span
                    className="help-unread-dot"
                    role="status"
                    aria-label={`${reportsUnread} ${reportsUnread === 1 ? "report has" : "reports have"} a new update`}
                  />
                )}
              </button>
              <button
                type="button"
                className="theme-schedule-button"
                aria-label={darkMode ? "Light mode" : "Dark mode"}
                data-tooltip={darkMode ? "Switch to light mode" : "Switch to dark mode"}
                onClick={onToggleDarkMode}
              >
                {darkMode ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <button type="button" className={clsx("theme-schedule-button", themeSchedule.enabled && "is-active")}
                aria-label="Theme schedule" data-tooltip="Schedule light and dark mode" aria-haspopup="dialog"
                onClick={() => setThemeScheduleOpen(true)}><Clock3 size={16} /></button>
            </div>
            {themeScheduleOpen && <ThemeScheduleDialog schedule={themeSchedule}
              onSave={(next) => onSaveThemeSchedule?.(next)} onClose={() => setThemeScheduleOpen(false)} />}
            {pwaInstallTarget && onOpenPwaInstall && (
              <button
                className="minor-row"
                type="button"
                aria-label="Install app"
                data-tooltip="Add this workspace to your phone's home screen"
                onClick={onOpenPwaInstall}
              >
                <Smartphone size={16} />
                <span>Install app</span>
              </button>
            )}
          </div>

          <button
            className="account-card account-button"
            type="button"
            aria-label={`Account: ${data.me.display_name}, ${roleLabel(data.me.role)}`}
            data-tooltip="Open your account to edit your profile, password, and usage"
            onClick={() => openUtilityDrawer("account")}
          >
            <UserAvatar user={data.me} />
            <div>
              <strong>{data.me.display_name}</strong>
              <span>{viewAsRole ? `${roleLabel(data.me.role)} preview` : roleLabel(data.me.role)}</span>
            </div>
            <ChevronDown size={16} />
          </button>
        </div>

        <button
          className="sidebar-resize-handle"
          type="button"
          aria-label="Resize sidebar"
          data-tooltip="Drag or use arrow keys to resize. Double-click to collapse."
          aria-description={`${visibleRailWidth} pixels wide. Use arrow keys to resize, Home for minimum width, or End for maximum width.`}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const nextWidth = event.key === "Home" ? MIN_RAIL_WIDTH : event.key === "End" ? MAX_RAIL_WIDTH :
              Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, railWidth + (event.key === "ArrowRight" ? 16 : -16)));
            setIsRailCollapsed(false);
            setRailWidth(nextWidth);
            saveRailWidth(nextWidth);
          }}
          onDoubleClick={() => setIsRailCollapsed((value) => !value)}
          onMouseDown={(event) => {
            event.preventDefault();
            setIsResizing(true);
          }}
        />
      </aside>
      <main id="workspace-content" tabIndex={-1} className="main-surface" inert={(isDrawer && navOpen) || shellInert}>{children}</main>
      {paletteOpen && (
        <CommandPalette
          userId={data.me.id}
          tenantSlug={data.currentTenant.slug}
          onNavigate={handlePaletteNavigate}
          onClose={() => setPaletteOpen(false)}
          commands={paletteCommands}
          threads={threads}
          folders={flattenFolderTree(folders).map(({ folder, depth }) => ({
            depth,
            id: folder.id,
            name: folder.name,
          }))}
          onTogglePin={onTogglePin}
          onArchiveThread={onArchiveThread}
          onRestoreThread={onRestoreThread}
          onMoveThreadToFolder={(id, folderId) => {
            onMoveThreadToFolder(id, folderId);
            if (folderId) revealFolder(folderId);
          }}
        />
      )}
      {drawer && (
        <UtilityDrawer
          drawer={drawer}
          data={data}
          actualRole={actualRole}
          viewAsRole={viewAsRole}
          onViewAsRoleChange={onViewAsRoleChange}
          threads={threads.filter((thread) => !isBlankNewChat(thread))}
          folders={folders}
          darkMode={darkMode}
          onToggleDarkMode={onToggleDarkMode}
          onClose={() => { if (!securityCloseBlockedRef.current) setDrawer(null); }}
          securityCloseBlocked={securityCloseBlocked}
          onSecurityCloseGuardChange={updateSecurityCloseGuard}
          onOpenChat={handleOpenChat}
          onTogglePin={onTogglePin}
          onArchiveThread={onArchiveThread}
          onMoveThreadToFolder={(chatId, folderId) => {
            onMoveThreadToFolder(chatId, folderId);
            if (folderId) revealFolder(folderId);
          }}
          onStartFolderCreation={(threadId) => {
            if (securityCloseBlockedRef.current) return;
            setPendingFolderThreadId(threadId);
            updateChatsHidden(false);
            startCreatingFolder(null);
            setDrawer(null);
          }}
          onRestoreThread={onRestoreThread}
          onDeleteThread={onDeleteThread}
          onSignOut={onSignOut}
          onRequestSignOut={() => {
            if (securityCloseBlockedRef.current) return;
            setDrawer(null);
            (onRequestSignOut ?? onSignOut)?.();
          }}
          onProfileUpdate={onProfileUpdate}
          onPasswordUpdate={onPasswordUpdate}
          onApiKeyLoad={onApiKeyLoad}
          onApiKeyCreate={onApiKeyCreate}
          onApiKeyRevoke={onApiKeyRevoke}
          onSubmitIssueReport={onSubmitIssueReport}
          onOpenIssueReport={() => setDrawer("report")}
          onBackToHelp={() => setDrawer("help")}
          myReportsApi={myReportsApi}
          reportsUnread={reportsUnread}
          onReportsUnreadChange={setReportsUnread}
          myReportsFocusId={myReportsFocusId}
          onOpenMyReports={(reportId) => {
            setMyReportsFocusId(reportId ?? null);
            setDrawer("my-reports");
          }}
          currentView={currentView}
          onSelectView={handleSelectView}
          memoryAvailable={Boolean(memoryApi)}
          onOpenMemory={() => {
            if (securityCloseBlockedRef.current) return;
            setDrawer(null);
            setMemoryOpen(true);
          }}
        />
      )}
      {memoryOpen && memoryApi && (
        <LazyChunkBoundary label="Personalization memory">
          <Suspense fallback={null}>
            <MemoryManager api={memoryApi} onClose={() => setMemoryOpen(false)} />
          </Suspense>
        </LazyChunkBoundary>
      )}
    </div>
  );
}

function UtilityDrawer({
  drawer,
  data,
  actualRole,
  viewAsRole,
  onViewAsRoleChange,
  threads,
  folders,
  darkMode,
  onToggleDarkMode,
  onClose,
  securityCloseBlocked,
  onSecurityCloseGuardChange,
  onOpenChat,
  onTogglePin,
  onArchiveThread,
  onMoveThreadToFolder,
  onStartFolderCreation,
  onRestoreThread,
  onDeleteThread,
  onSignOut,
  onRequestSignOut,
  onProfileUpdate,
  onPasswordUpdate,
  onApiKeyLoad,
  onApiKeyCreate,
  onApiKeyRevoke,
  onSubmitIssueReport,
  onOpenIssueReport,
  onBackToHelp,
  myReportsApi,
  reportsUnread,
  onReportsUnreadChange,
  myReportsFocusId,
  onOpenMyReports,
  currentView,
  onSelectView,
  memoryAvailable,
  onOpenMemory,
}: {
  drawer: UtilityDrawerKey;
  data: BootstrapData;
  actualRole: Role;
  viewAsRole: Role | null;
  onViewAsRoleChange: (role: Role | null) => void;
  threads: ChatThread[];
  folders: ChatFolder[];
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onClose: () => void;
  securityCloseBlocked: boolean;
  onSecurityCloseGuardChange: (blocked: boolean) => void;
  onOpenChat: (id: string) => void;
  onTogglePin: (id: string) => void;
  onArchiveThread: (id: string) => void;
  onMoveThreadToFolder: (chatId: string, folderId: string | null) => void;
  onStartFolderCreation: (threadId: string) => void;
  onRestoreThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onSignOut?: () => void;
  onRequestSignOut?: () => void;
  onProfileUpdate?: (payload: AccountProfileUpdateRequest) => void | User | Promise<User | void>;
  onPasswordUpdate?: (payload: AccountPasswordUpdateRequest) => void | Promise<void>;
  onApiKeyLoad?: () => Promise<AccountApiKeyStatus>;
  onApiKeyCreate?: (options: { replace: boolean }) => Promise<AccountApiKeyCreateResponse>;
  onApiKeyRevoke?: () => Promise<AccountApiKeyStatus>;
  onSubmitIssueReport?: (payload: IssueReportSubmission) => Promise<IssueReportRecord | void>;
  onOpenIssueReport: () => void;
  onBackToHelp: () => void;
  myReportsApi?: MyReportsApi;
  reportsUnread: number;
  onReportsUnreadChange: (count: number) => void;
  myReportsFocusId: string | null;
  onOpenMyReports: (reportId?: string) => void;
  currentView: ViewKey;
  onSelectView: (view: ViewKey) => void;
  memoryAvailable?: boolean;
  onOpenMemory?: () => void;
}) {
  // Personal daily token caps (only finite ones are ever returned). Fetched
  // when the account drawer opens so the meter reflects today's usage.
  const drawerRef = useRef<HTMLElement>(null);
  // Open layers inside a drawer take Escape first, wherever focus happens to be.
  const escapeLayers = useRef<EscapeLayer[]>([]);
  useModalFocus(drawerRef, true, () => {
    const innermost = escapeLayers.current.at(-1);
    if (innermost) innermost.current();
    else onClose();
  });
  const title =
    drawer === "help"
      ? "Help"
      : drawer === "report"
        ? "Report a problem"
      : drawer === "my-reports"
        ? "My reports"
      : drawer === "settings"
        ? "Preferences"
        : drawer === "account"
          ? "Account"
          : drawer === "all-pinned"
            ? "Pinned chats"
            : drawer === "all-folders"
              ? "All folders"
              : "All chats";
  const availableModels = useMemo(() => usableModels(data), [data]);
  const canOpenAdmin = data.me.role === "TENANT_ADMIN" || data.me.role === "PLATFORM_OWNER";
  const canOpenPlatform = data.me.role === "PLATFORM_OWNER";
  const accountConsoles = consoleNav
    .filter(({ key }) => (key === "platform" ? canOpenPlatform : canOpenAdmin))
    .map(({ key, icon }) => ({ key, icon, tooltip: NAV_TOOLTIPS[key] }));
  const activeThreads = threads.filter((thread) => !thread.archived);
  const pinnedThreads = activeThreads.filter((thread) => thread.pinned);
  const [chatFilterText, setChatFilterText] = useState("");
  const [folderMenuThreadId, setFolderMenuThreadId] = useState<string | null>(null);
  const normalizedChatFilter = chatFilterText.trim().toLowerCase();
  const filteredActiveThreads = normalizedChatFilter
    ? activeThreads.filter((thread) => thread.title.toLowerCase().includes(normalizedChatFilter))
    : activeThreads;
  const downstreamApiEnabled = Boolean(data.platformSettings?.downstream_api_enabled);
  const locallyGrantedApiAccess =
    downstreamApiEnabled &&
    (actualRole === "PLATFORM_OWNER" || actualRole === "TENANT_ADMIN"
      ? true
      : data.me.group_ids.some((groupId) =>
          Boolean(data.groups.find((group) => group.id === groupId)?.permissions.api_access),
        ));

  // The title filter and any open folder menu are scoped to one drawer
  // visit; switching panels clears them.
  useEffect(() => {
    setChatFilterText("");
    setFolderMenuThreadId(null);
  }, [drawer]);

  // Drawer chat rows mirror the sidebar chat-row design exactly: the same
  // folder/pin/archive actions with the same reveal behavior, plus the same
  // move-to-folder menu, so organizing works wherever a chat is listed.
  const renderDrawerChatRow = (thread: ChatThread) => (
    <div className={clsx("chat-row", "drawer-chat-row", thread.pinned && "is-pinned")} key={thread.id}>
      <ChatPreview thread={thread}>
        <button
          className="drawer-row"
          type="button"
          aria-label={thread.title}
          onClick={() => onOpenChat(thread.id)}
        >
          {thread.used_agent ? <Bot size={16} /> : <MessageSquare size={16} />}
          <span>
            <strong>{thread.title}</strong>
            <small>{thread.updated_at}</small>
          </span>
        </button>
      </ChatPreview>
      <div className="chat-row-actions">
        <button
          className="pin-toggle chat-row-action"
          type="button"
          aria-label={`Add ${thread.title} to a folder`}
          data-tooltip={`File "${thread.title}" into a folder to keep related chats together`}
          onClick={() => {
            if (folders.length === 0) {
              onStartFolderCreation(thread.id);
              return;
            }
            setFolderMenuThreadId((current) => (current === thread.id ? null : thread.id));
          }}
        >
          <FolderPlus size={14} />
        </button>
        <button
          className="pin-toggle chat-row-action"
          type="button"
          aria-label={thread.pinned ? "Unpin chat" : "Pin chat"}
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
        <button
          className="pin-toggle chat-row-action"
          type="button"
          aria-label={`Archive ${thread.title}`}
          data-tooltip={`Move "${thread.title}" out of your sidebar without deleting it`}
          onClick={() => onArchiveThread(thread.id)}
        >
          <Archive size={14} />
        </button>
      </div>
      {folderMenuThreadId === thread.id && (
        <div className="thread-folder-menu">
          <strong>Move to folder</strong>
          {flattenFolderTree(folders).map(({ folder, depth }) => (
            <button
              key={folder.id}
              type="button"
              style={depth > 0 ? { marginLeft: depth * 14 } : undefined}
              data-tooltip={`Move this chat into your "${folder.name}" folder`}
              onClick={() => {
                onMoveThreadToFolder(thread.id, folder.id);
                setFolderMenuThreadId(null);
              }}
            >
              <Folder size={13} />
              <span>{folder.name}</span>
            </button>
          ))}
          {thread.folder_id && (
            <button
              type="button"
              data-tooltip="Take this chat out of its folder and back to Recent"
              onClick={() => {
                onMoveThreadToFolder(thread.id, null);
                setFolderMenuThreadId(null);
              }}
            >
              <X size={13} />
              <span>Remove from folder</span>
            </button>
          )}
          <button
            type="button"
            data-tooltip="Create a new folder and move this chat into it"
            onClick={() => onStartFolderCreation(thread.id)}
          >
            <Plus size={13} />
            <span>New folder</span>
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <button
        className="utility-backdrop"
        type="button"
        aria-label="Close drawer"
        data-tooltip="Close this panel and return to your workspace"
        onClick={onClose}
        disabled={securityCloseBlocked}
      />
      <aside
        ref={drawerRef}
        tabIndex={-1}
        className={clsx("utility-drawer", drawer === "account" && "account-utility-drawer")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClickCapture={(event) => {
          if (securityCloseBlocked && !(event.target instanceof Element && event.target.closest(".account-security-section"))) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            data-tooltip={`Close the ${title.toLowerCase()} panel and return to your workspace`}
            onClick={onClose}
            disabled={securityCloseBlocked}
          >
            <X size={17} />
          </button>
        </header>

        {drawer === "all-chats" && (
          <div className="drawer-list">
            <div className="search-box" style={{ flex: "none", width: "100%", maxWidth: "none" }}>
              <Search size={15} aria-hidden="true" />
              <input
                aria-label="Filter chats by title"
                placeholder="Filter chats"
                autoComplete="off"
                spellCheck={false}
                value={chatFilterText}
                onChange={(event) => setChatFilterText(event.target.value)}
              />
            </div>
            {filteredActiveThreads.map((thread) => renderDrawerChatRow(thread))}
            {activeThreads.length > 0 && filteredActiveThreads.length === 0 && (
              <div className="drawer-card">
                <strong>No chats match</strong>
                <span>No chat titles contain “{chatFilterText.trim()}”.</span>
              </div>
            )}
          </div>
        )}

        {drawer === "all-pinned" && (
          <div className="drawer-list">
            {pinnedThreads.length > 0 ? (
              pinnedThreads.map((thread) => renderDrawerChatRow(thread))
            ) : (
              <div className="drawer-card">
                <strong>No pinned chats</strong>
                <span>Pin a chat from the sidebar to keep it here.</span>
              </div>
            )}
          </div>
        )}

        {drawer === "all-folders" && (
          <div className="drawer-list">
            {folders.length > 0 ? (
              flattenFolderTree(folders).map(({ folder, depth }) => {
                const folderThreads = activeThreads.filter((thread) => thread.folder_id === folder.id);
                return (
                  <div
                    className={clsx("drawer-card drawer-folder-card", depth > 0 && "is-subfolder")}
                    style={depth > 0 ? { marginLeft: depth * 18 } : undefined}
                    key={folder.id}
                  >
                    <strong>{folder.name}</strong>
                    <span>{folderThreads.length} {folderThreads.length === 1 ? "chat" : "chats"}</span>
                    {folderThreads.length > 0 && (
                      <div className="drawer-folder-chat-list">
                        {folderThreads.map((thread) => renderDrawerChatRow(thread))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="drawer-card">
                <strong>No folders</strong>
                <span>Create a folder from the sidebar to organize chats.</span>
              </div>
            )}
          </div>
        )}

        {drawer === "help" && (
          <div className="help-drawer-content">
            <button
              className="drawer-row report-problem-entry"
              type="button"
              onClick={onOpenIssueReport}
            >
              <Bug size={18} />
              <span>
                <strong>Report a problem</strong>
                <small>Report an issue, share an idea, or ask a question.</small>
              </span>
            </button>
            {myReportsApi && (
              <button
                className="drawer-row my-reports-entry"
                type="button"
                onClick={() => onOpenMyReports()}
              >
                <ListChecks size={18} />
                <span>
                  <strong>My reports</strong>
                  <small>Track status and replies on reports you've sent.</small>
                </span>
                {reportsUnread > 0 && (
                  <span className="count-badge" aria-label={`${reportsUnread} with new updates`}>
                    {reportsUnread}
                  </span>
                )}
              </button>
            )}
            <LazyChunkBoundary label="The user guide">
              <Suspense
                fallback={
                  <div className="drawer-list">
                    <div className="drawer-card">
                      <strong>Loading the user guide…</strong>
                      <span>Preparing the walkthrough videos.</span>
                    </div>
                  </div>
                }
              >
                <UserGuidePlaylist brandName={data.currentTenant.chat_brand_name} />
              </Suspense>
            </LazyChunkBoundary>
          </div>
        )}

        {drawer === "report" && (
          <div className="issue-report-drawer">
            <button className="back-link-button" type="button" onClick={onBackToHelp}>
              <ArrowLeft size={15} /> Back to Help
            </button>
            <IssueReportForm
              onSubmit={onSubmitIssueReport}
              onViewReport={myReportsApi ? (reportId) => onOpenMyReports(reportId) : undefined}
            />
          </div>
        )}

        {drawer === "my-reports" && myReportsApi && (
          <div className="issue-report-drawer">
            <MyReportsPanel
              api={myReportsApi}
              focusReportId={myReportsFocusId}
              onNewReport={onOpenIssueReport}
              onBackToHelp={onBackToHelp}
              onUnreadChange={onReportsUnreadChange}
            />
          </div>
        )}

        {drawer === "settings" && (
          <div className="drawer-list">
            <button
              className="drawer-row"
              type="button"
              data-tooltip="Switch between light and dark appearance"
              onClick={onToggleDarkMode}
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
              <span>
                <strong>{darkMode ? "Light mode" : "Dark mode"}</strong>
                <small>Switch interface theme.</small>
              </span>
            </button>
            {memoryAvailable && onOpenMemory && (
              <button
                className="drawer-row"
                type="button"
                data-tooltip="Review, correct, or delete what the assistant remembers about you"
                onClick={onOpenMemory}
              >
                <Brain size={16} />
                <span>
                  <strong>Memory</strong>
                  <small>{memoryDrawerHint(data)}</small>
                </span>
              </button>
            )}
            <div className="drawer-card">
              <strong>Default model</strong>
              <span>{availableModels[0]?.name ?? "No connected model"}</span>
            </div>
            <div className="drawer-card">
              <strong>Enabled connectors</strong>
              <span>{data.connectors.filter((connector) => connector.tenant_enabled).length} tenant connectors</span>
            </div>
          </div>
        )}

        {drawer === "account" && (
          <AccountDrawer
            data={data}
            actualRole={actualRole}
            viewAsRole={viewAsRole}
            onViewAsRoleChange={onViewAsRoleChange}
            threads={threads}
            consoles={accountConsoles}
            currentView={currentView}
            onSelectView={onSelectView}
            onSecurityCloseGuardChange={onSecurityCloseGuardChange}
            escapeLayers={escapeLayers.current}
            apiAccessGranted={locallyGrantedApiAccess}
            onApiKeyLoad={onApiKeyLoad}
            onApiKeyCreate={onApiKeyCreate}
            onApiKeyRevoke={onApiKeyRevoke}
            onProfileUpdate={onProfileUpdate}
            onPasswordUpdate={onPasswordUpdate}
            memoryHint={memoryAvailable ? memoryDrawerHint(data) : null}
            onOpenMemory={onOpenMemory}
            onRestoreThread={onRestoreThread}
            onDeleteThread={onDeleteThread}
            onSignOut={onSignOut}
            onRequestSignOut={onRequestSignOut}
          />
        )}
      </aside>
    </>
  );
}

/** Moves focus within a chat row menu: step 0 focuses the first item, and
 * arrow-key steps wrap around the ends. */
function focusChatMenuItem(menu: HTMLElement | null, step: 1 | -1 | 0) {
  if (!menu) return;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = step === 0 || current < 0 ? 0 : (current + step + items.length) % items.length;
  items[next]?.focus();
}

function previewThreads(threads: ChatThread[], limit: number, activeChatId: string): ChatThread[] {
  if (threads.length <= limit) return threads;
  const activeIndex = threads.findIndex((thread) => thread.id === activeChatId);
  if (activeIndex >= limit && limit > 0) {
    return [...threads.slice(0, limit - 1), threads[activeIndex]];
  }
  return threads.slice(0, limit);
}

function previewFolders(folders: ChatFolder[], limit: number, expandedFolderId: string | null): ChatFolder[] {
  if (folders.length <= limit) return folders;
  const expandedIndex = folders.findIndex((folder) => folder.id === expandedFolderId);
  if (expandedIndex >= limit && limit > 0) {
    return [...folders.slice(0, limit - 1), folders[expandedIndex]];
  }
  return folders.slice(0, limit);
}

function readSavedRailWidth() {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
      return DEFAULT_RAIL_WIDTH;
    }
    const raw = window.localStorage.getItem("aperture-sidebar-width");
    if (raw === null) return DEFAULT_RAIL_WIDTH;
    const saved = Number(raw);
    if (!Number.isFinite(saved)) return DEFAULT_RAIL_WIDTH;
    if (saved >= 240 && saved <= 260) return DEFAULT_RAIL_WIDTH;
    return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, saved));
  } catch {
    return DEFAULT_RAIL_WIDTH;
  }
}

function saveRailWidth(width: number) {
  try {
    if (typeof window !== "undefined" && typeof window.localStorage?.setItem === "function") {
      window.localStorage.setItem("aperture-sidebar-width", String(width));
    }
  } catch {
    // Persisting the rail width is a convenience; layout state should still work if storage is unavailable.
  }
}

const CHATS_HIDDEN_STORAGE_PREFIX = "aperture-sidebar-chats-hidden";

function loadChatsHidden(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${CHATS_HIDDEN_STORAGE_PREFIX}-${userId}`) === "true";
  } catch {
    return false;
  }
}

function saveChatsHidden(userId: string, hidden: boolean) {
  try {
    const key = `${CHATS_HIDDEN_STORAGE_PREFIX}-${userId}`;
    if (hidden) window.localStorage.setItem(key, "true");
    else window.localStorage.removeItem(key);
  } catch {
    // Remembering the choice is a convenience; the toggle still works without storage.
  }
}

const FOLDER_STORAGE_PREFIX = "aperture-chat-folders";

function folderStorageKey(userId: string) {
  return `${FOLDER_STORAGE_PREFIX}-${userId}`;
}

function createFolderId() {
  return `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isChatFolderArray(value: unknown): value is ChatFolder[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as ChatFolder).id === "string" &&
        typeof (item as ChatFolder).name === "string" &&
        typeof (item as ChatFolder).created_at === "string" &&
        ((item as ChatFolder).parent_id === undefined ||
          (item as ChatFolder).parent_id === null ||
          typeof (item as ChatFolder).parent_id === "string"),
    )
  );
}

function loadChatFolders(userId: string): ChatFolder[] {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
      return [];
    }
    const raw = window.localStorage.getItem(folderStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return isChatFolderArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChatFolders(userId: string, folders: ChatFolder[]) {
  try {
    if (typeof window !== "undefined" && typeof window.localStorage?.setItem === "function") {
      window.localStorage.setItem(folderStorageKey(userId), JSON.stringify(folders));
    }
  } catch {
    // Folder labels are local convenience metadata; chat placement is still stored on each thread.
  }
}
