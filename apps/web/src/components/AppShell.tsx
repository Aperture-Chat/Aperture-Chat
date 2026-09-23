import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Brain,
  Bug,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Folder,
  FolderPlus,
  FileText,
  KeyRound,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Ellipsis,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Pencil,
  Search,
  Send,
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
import { Fragment, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentProps, type CSSProperties, type FormEvent, type ReactNode } from "react";

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
  ChatMessage,
  ChatThread,
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
import { getMyUsageBudget, type MyUsageBudget } from "../lib/api/auth";
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
import { AccountSecurity } from "./AccountSecurity";
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

const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_OWNER: "Platform Owner",
  TENANT_ADMIN: "Admin",
  TEMP_USER: "Temp User",
  POWER_USER: "Power User",
  AUDITOR: "Auditor",
  AGENT_APPROVER: "Agent Approver",
  USER: "User",
};

const PREVIEW_ROLE_LABELS: Partial<Record<Role, string>> = {
  PLATFORM_OWNER: "Platform admin",
  TENANT_ADMIN: "Admin",
  USER: "User",
};

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


type UtilityDrawerKey = "help" | "report" | "settings" | "account" | "all-chats" | "all-pinned" | "all-folders";

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
const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/* Avatars render at 96px or smaller but the data URL is stored inline on the
 * user record and shipped with every bootstrap/session-resume payload, so
 * uploads are downscaled before storing. 512px covers retina rendering. */
const PROFILE_PHOTO_MAX_EDGE = 512;

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
  onApiKeyCreate?: () => Promise<AccountApiKeyCreateResponse>;
  onApiKeyRevoke?: () => Promise<AccountApiKeyStatus>;
  onSubmitIssueReport?: (payload: {
    subject: string;
    body: string;
    screenshot?: File | null;
  }) => Promise<void>;
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
  const sidebarRef = useRef<HTMLElement>(null);

  const width = useViewportWidth();
  const isDrawer = width <= BREAKPOINTS.drawer;
  const autoCollapsed = currentView === "drafts";
  const collapsed = (isRailCollapsed || autoCollapsed) && !isDrawer;
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
    setDrawer(nextDrawer);
    closeDrawer();
  };

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
        } as CSSProperties
      }
    >
      <a className="skip-link" href="#workspace-content">Skip to workspace</a>
      {isDrawer && (
        <button
          type="button"
          className="mobile-hamburger"
          aria-label={navOpen ? "Close menu" : "Open menu"}
          data-tooltip={navOpen ? "Hide the navigation menu and return to your work" : "Open the menu to switch views and find your chats"}
          aria-expanded={navOpen}
          aria-controls="workspace-navigation"
          inert={Boolean(drawer || paletteOpen || memoryOpen)}
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

      <aside
        id="workspace-navigation"
        ref={sidebarRef}
        className={clsx("sidebar", darkRail && "sidebar-dark", collapsed && "is-collapsed")}
        role={isDrawer && navOpen ? "dialog" : undefined}
        aria-modal={isDrawer && navOpen ? true : undefined}
        aria-label={isDrawer && navOpen ? "Navigation" : undefined}
        inert={Boolean((isDrawer && !navOpen) || drawer || paletteOpen || memoryOpen)}
        tabIndex={-1}
      >
        <div className="sidebar-top">
          <Logo
            compact={collapsed}
            brandName={data.currentTenant.chat_brand_name ?? "Aperture Chat"}
            logoUrl={data.currentTenant.icon_url || data.currentTenant.logo_url}
          />
          {isDrawer && (
            <button className="icon-button" type="button" aria-label="Close navigation" onClick={closeDrawer}>
              <X size={18} />
            </button>
          )}
          {!isDrawer && !autoCollapsed && (
            <button
              className="icon-button sidebar-collapse-button"
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              data-tooltip={
                collapsed
                  ? "Expand the sidebar to see your chats and folders again"
                  : "Collapse the sidebar to give your workspace more room"
              }
              onClick={() => setIsRailCollapsed((value) => !value)}
            >
              {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
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

        {!collapsed && (
          <div className="sidebar-main chat-library">
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
        )}

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
      <main id="workspace-content" tabIndex={-1} className="main-surface" inert={Boolean((isDrawer && navOpen) || drawer || paletteOpen || memoryOpen)}>{children}</main>
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
  onApiKeyCreate?: () => Promise<AccountApiKeyCreateResponse>;
  onApiKeyRevoke?: () => Promise<AccountApiKeyStatus>;
  onSubmitIssueReport?: (payload: {
    subject: string;
    body: string;
    screenshot?: File | null;
  }) => Promise<void>;
  onOpenIssueReport: () => void;
  onBackToHelp: () => void;
  currentView: ViewKey;
  onSelectView: (view: ViewKey) => void;
  memoryAvailable?: boolean;
  onOpenMemory?: () => void;
}) {
  // Personal daily token caps (only finite ones are ever returned). Fetched
  // when the account drawer opens so the meter reflects today's usage.
  const drawerRef = useRef<HTMLElement>(null);
  useModalFocus(drawerRef, true, onClose);
  const [securityOpen, setSecurityOpen] = useState(false);
  const securityPanelId = useId();
  // Keep the active security flow as the only interactive account section.
  // Its recovery codes must survive navigation, profile/password changes,
  // role previews, sign-out, and keyboard shortcuts until acknowledged.
  useLayoutEffect(() => {
    if (!securityCloseBlocked) return;
    const siblings = Array.from(drawerRef.current?.querySelector(".account-drawer-list")?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && !element.classList.contains("account-security-section"));
    for (const element of siblings) element.setAttribute("inert", "");
    return () => { for (const element of siblings) element.removeAttribute("inert"); };
  }, [securityCloseBlocked]);
  const [myUsageBudget, setMyUsageBudget] = useState<MyUsageBudget | null>(null);
  useEffect(() => {
    if (drawer !== "account") return;
    let active = true;
    getMyUsageBudget(data.me.id)
      .then((budget) => {
        if (active) setMyUsageBudget(budget);
      })
      .catch(() => {
        if (active) setMyUsageBudget(null);
      });
    return () => {
      active = false;
    };
  }, [drawer, data.me.id]);

  const title =
    drawer === "help"
      ? "Help"
      : drawer === "report"
        ? "Report a problem"
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
  const accountUsage = useMemo(() => accountUsageSummary(threads), [threads]);
  const canOpenAdmin = data.me.role === "TENANT_ADMIN" || data.me.role === "PLATFORM_OWNER";
  const canOpenPlatform = data.me.role === "PLATFORM_OWNER";
  const visibleAccountConsoles = consoleNav.filter(({ key }) =>
    key === "platform" ? canOpenPlatform : canOpenAdmin,
  );
  const previewRoleOptions = useMemo(() => availablePreviewRoles(actualRole), [actualRole]);
  const activePreviewRole = viewAsRole ?? actualRole;
  const activeThreads = threads.filter((thread) => !thread.archived);
  const pinnedThreads = activeThreads.filter((thread) => thread.pinned);
  const archivedThreads = threads.filter((thread) => thread.archived);
  const profileFormId = useId();
  const profilePhotoInputId = useId();
  const passwordFormId = useId();
  const archiveSectionId = useId();
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(() => profileDraftFromUser(data.me));
  const [passwordEditing, setPasswordEditing] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState<PasswordDraft>(emptyPasswordDraft);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<AccountApiKeyStatus | null>(null);
  const [apiKeySecret, setApiKeySecret] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiCopied, setApiCopied] = useState<"url" | "key" | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reportSubject, setReportSubject] = useState("");
  const [reportBody, setReportBody] = useState("");
  const [reportScreenshot, setReportScreenshot] = useState<File | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);
  const [chatFilterText, setChatFilterText] = useState("");
  const [folderMenuThreadId, setFolderMenuThreadId] = useState<string | null>(null);
  const canUpdatePassword = data.me.auth_method === "local";
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
  const apiAccessEnabled = apiKeyStatus?.enabled ?? locallyGrantedApiAccess;
  const apiBaseUrl = `${window.location.origin.replace(/\/$/, "")}/v1`;

  const handleDeleteArchived = (thread: ChatThread) => {
    const confirmed = window.confirm(
      `Permanently delete "${thread.title}"? This removes the full conversation and cannot be undone.`,
    );
    if (!confirmed) return;
    onDeleteThread(thread.id);
  };

  useEffect(() => {
    setProfileDraft(profileDraftFromUser(data.me));
    setPasswordDraft(emptyPasswordDraft());
    setProfileError(null);
    setPasswordError(null);
    setProfileStatus(null);
    setPasswordStatus(null);
    setProfileEditing(false);
    setPasswordEditing(false);
    setApiKeyStatus(null);
    setApiKeySecret(null);
    setApiKeyError(null);
    setApiCopied(null);
  }, [data.me.id]);

  // The title filter and any open folder menu are scoped to one drawer
  // visit; switching panels clears them.
  useEffect(() => {
    setChatFilterText("");
    setFolderMenuThreadId(null);
  }, [drawer]);

  const handleIssueReportSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onSubmitIssueReport) {
      setReportError("Issue reporting is not connected right now.");
      return;
    }
    const subject = reportSubject.trim();
    const body = reportBody.trim();
    if (!subject || !body) {
      setReportError("Add both a subject and a message.");
      return;
    }
    setReportBusy(true);
    setReportError(null);
    try {
      await onSubmitIssueReport({ subject, body, screenshot: reportScreenshot });
      setReportSent(true);
      setReportSubject("");
      setReportBody("");
      setReportScreenshot(null);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : "The issue report could not be sent.");
    } finally {
      setReportBusy(false);
    }
  };

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

  useEffect(() => {
    if (drawer !== "account" || !onApiKeyLoad) return;
    let cancelled = false;
    setApiKeyBusy(true);
    setApiKeyError(null);
    void onApiKeyLoad()
      .then((status) => {
        if (!cancelled) setApiKeyStatus(status);
      })
      .catch((error) => {
        if (!cancelled) setApiKeyError(error instanceof Error ? error.message : "Could not load API access.");
      })
      .finally(() => {
        if (!cancelled) setApiKeyBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data.me.id, drawer, onApiKeyLoad]);

  useEffect(() => {
    if (!profileEditing) setProfileDraft(profileDraftFromUser(data.me));
  }, [data.me.avatar_url, data.me.bio, data.me.display_name, data.me.firm_name, data.me.phone, data.me.website_url, profileEditing]);

  const handleProfilePhotoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setProfileError("Choose an image file for your profile photo.");
      return;
    }
    if (file.size > PROFILE_IMAGE_MAX_BYTES) {
      setProfileError("Choose a profile photo that is 5 MB or smaller.");
      return;
    }
    void (async () => {
      let result: string | null = null;
      if (typeof createImageBitmap === "function") {
        result = await downscaleProfilePhotoToDataUrl(file);
      }
      if (!result) {
        // No bitmap/canvas support here: store the raw file, which the 5 MB
        // gates above and at submit time still bound.
        result = await readProfilePhotoAsDataUrl(file);
      }
      if (!result) {
        setProfileError("Could not read that image file.");
        return;
      }
      setProfileError(null);
      setProfileDraft((current) => ({ ...current, avatarUrl: result }));
    })();
  };

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onProfileUpdate) {
      setProfileError("Profile updates are not connected.");
      return;
    }
    const displayName = profileDraft.displayName.trim();
    const firmName = profileDraft.firmName.trim();
    const websiteUrl = profileDraft.websiteUrl.trim();
    const phone = profileDraft.phone.trim();
    const bio = profileDraft.bio.trim();
    const avatarUrl = profileDraft.avatarUrl.trim();
    if (!displayName) {
      setProfileError("Enter a username or display name.");
      return;
    }
    if (websiteUrl && !/^https?:\/\/\S+$/i.test(websiteUrl)) {
      setProfileError("Use a complete http(s) website URL.");
      return;
    }
    if (avatarUrl && !isProfileImageReference(avatarUrl)) {
      setProfileError("Use an http(s), relative, or uploaded image for your profile photo.");
      return;
    }
    if (avatarUrl.startsWith("data:image/")) {
      const decodedBytes = profileImageDataUrlByteLength(avatarUrl);
      if (decodedBytes === null) {
        setProfileError("Uploaded profile photo data is invalid.");
        return;
      }
      if (decodedBytes > PROFILE_IMAGE_MAX_BYTES) {
        setProfileError("Choose a profile photo that is 5 MB or smaller.");
        return;
      }
    }

    setIsSavingProfile(true);
    setProfileError(null);
    setProfileStatus(null);
    try {
      await onProfileUpdate({
        display_name: displayName,
        firm_name: firmName || null,
        website_url: websiteUrl || null,
        phone: phone || null,
        bio: bio || null,
        avatar_url: avatarUrl || null,
      });
      setProfileEditing(false);
      setProfileStatus("Profile saved.");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not save profile.");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onPasswordUpdate) {
      setPasswordError("Password updates are not connected.");
      return;
    }
    if (!canUpdatePassword) {
      setPasswordError("Password changes are managed by your SSO provider.");
      return;
    }
    if (!passwordDraft.currentPassword) {
      setPasswordError("Enter your current password.");
      return;
    }
    if (passwordDraft.newPassword.length < 12) {
      setPasswordError("Use a password with at least 12 characters.");
      return;
    }
    if (passwordDraft.newPassword !== passwordDraft.confirmPassword) {
      setPasswordError("The new passwords do not match.");
      return;
    }

    setIsSavingPassword(true);
    setPasswordError(null);
    setPasswordStatus(null);
    try {
      await onPasswordUpdate({
        current_password: passwordDraft.currentPassword,
        new_password: passwordDraft.newPassword,
      });
      setPasswordDraft(emptyPasswordDraft());
      setPasswordStatus("Password updated.");
      setPasswordEditing(false);
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Could not update password.");
    } finally {
      setIsSavingPassword(false);
    }
  };

  const handleApiKeyCreate = async () => {
    if (!onApiKeyCreate) {
      setApiKeyError("API key management is not connected.");
      return;
    }
    if (apiKeyStatus?.has_key) {
      const confirmed = window.confirm(
        "Rotate this API key? The current key will stop working immediately.",
      );
      if (!confirmed) return;
    }
    setApiKeyBusy(true);
    setApiKeyError(null);
    setApiKeySecret(null);
    try {
      const created = await onApiKeyCreate();
      setApiKeyStatus(created);
      setApiKeySecret(created.secret_value);
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Could not create the API key.");
    } finally {
      setApiKeyBusy(false);
    }
  };

  const handleApiKeyRevoke = async () => {
    if (!onApiKeyRevoke) {
      setApiKeyError("API key management is not connected.");
      return;
    }
    const confirmed = window.confirm(
      "Revoke this API key? Any connected coding tools will lose access immediately.",
    );
    if (!confirmed) return;
    setApiKeyBusy(true);
    setApiKeyError(null);
    try {
      setApiKeyStatus(await onApiKeyRevoke());
      setApiKeySecret(null);
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Could not revoke the API key.");
    } finally {
      setApiKeyBusy(false);
    }
  };

  const copyApiValue = async (value: string, field: "url" | "key") => {
    try {
      await navigator.clipboard.writeText(value);
      setApiCopied(field);
      window.setTimeout(() => setApiCopied((current) => (current === field ? null : current)), 1800);
    } catch {
      setApiKeyError("Clipboard access is unavailable. Select and copy the value manually.");
    }
  };

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
                <small>Tell us about a platform issue and attach a screenshot.</small>
              </span>
            </button>
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
            {reportSent ? (
              <div className="issue-report-success" role="status">
                <span className="feedback-icon is-positive"><Check size={18} /></span>
                <div>
                  <strong>Report sent</strong>
                  <p>Thank you. An administrator can now review it in Analytics.</p>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setReportSent(false)}
                >
                  Report another issue
                </button>
              </div>
            ) : (
              <form className="issue-report-form" onSubmit={handleIssueReportSubmit}>
                <p className="issue-report-intro">
                  Describe what happened, what you expected, and any steps that help reproduce it.
                </p>
                <label>
                  <span>Subject</span>
                  <input
                    autoFocus
                    maxLength={200}
                    value={reportSubject}
                    onChange={(event) => setReportSubject(event.currentTarget.value)}
                    placeholder="Short summary of the issue"
                    required
                  />
                </label>
                <label>
                  <span>Message</span>
                  <textarea
                    maxLength={5000}
                    rows={8}
                    value={reportBody}
                    onChange={(event) => setReportBody(event.currentTarget.value)}
                    placeholder="What happened? What were you trying to do?"
                    required
                  />
                </label>
                <label className="issue-report-attachment">
                  <span><Paperclip size={15} /> Screenshot (optional)</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0] ?? null;
                      if (file && file.size > 10 * 1024 * 1024) {
                        setReportError("Choose a screenshot that is 10 MB or smaller.");
                        event.currentTarget.value = "";
                        setReportScreenshot(null);
                        return;
                      }
                      setReportError(null);
                      setReportScreenshot(file);
                    }}
                  />
                  <small>{reportScreenshot?.name ?? "PNG, JPEG, GIF, or WebP up to 10 MB."}</small>
                </label>
                {reportError && <p className="form-error" role="alert">{reportError}</p>}
                <button className="primary-button issue-report-submit" type="submit" disabled={reportBusy}>
                  <Send size={15} /> {reportBusy ? "Sending…" : "Send report"}
                </button>
              </form>
            )}
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
          <div className="drawer-list account-drawer-list">
            <button
              className="drawer-account drawer-account-button"
              type="button"
              aria-label={`Edit account profile for ${data.me.display_name}`}
              data-tooltip="Edit your display name, firm, website, bio, phone number, and photo"
              onClick={() => setProfileEditing(true)}
            >
              <UserAvatar user={data.me} />
              <span className="account-profile-summary">
                <strong className="account-profile-name">{data.me.display_name}</strong>
                <span className="account-profile-field">
                  <span className="account-profile-field-label">Email</span>
                  <small>{data.me.email}</small>
                </span>
                {data.me.phone && (
                  <span className="account-profile-field">
                    <span className="account-profile-field-label">Phone</span>
                    <small>{data.me.phone}</small>
                  </span>
                )}
                {data.me.firm_name && (
                  <span className="account-profile-field">
                    <span className="account-profile-field-label">Position</span>
                    <small>{data.me.firm_name}</small>
                  </span>
                )}
                {data.me.bio && (
                  <span className="account-profile-field">
                    <span className="account-profile-field-label">Bio</span>
                    <small>{data.me.bio}</small>
                  </span>
                )}
              </span>
              <Pencil size={16} />
            </button>
            {visibleAccountConsoles.length > 0 && (
              <details className="drawer-card account-collapsible-card account-console-card">
                <summary className="account-collapsible-summary">
                  <span className="account-collapsible-summary-copy">
                    <strong>Management</strong>
                    <small>
                      {currentView === "platform"
                        ? "Platform owner console active"
                        : currentView === "admin"
                          ? "Admin console active"
                          : `${visibleAccountConsoles.length} ${visibleAccountConsoles.length === 1 ? "console" : "consoles"} available`}
                    </small>
                  </span>
                  <ChevronDown className="account-collapsible-chevron" size={16} aria-hidden="true" />
                </summary>
                <div className="account-collapsible-content account-console-actions">
                  {visibleAccountConsoles.map(({ key, icon: Icon }) => {
                    const isActive = currentView === key;
                    const label = key === "platform" ? "Platform owner console" : "Admin console";
                    const pendingRequests =
                      key === "admin" && typeof data.modelAccessRequestCount === "number"
                        ? data.modelAccessRequestCount
                        : 0;
                    const description =
                      key === "platform"
                        ? "Providers, organization policy, and audit"
                        : pendingRequests > 0
                          ? `${pendingRequests} model access ${pendingRequests === 1 ? "request" : "requests"} waiting`
                          : "Users, groups, model access, and connections";
                    return (
                      <button
                        key={key}
                        className={clsx("account-console-link", isActive && "is-active")}
                        type="button"
                        aria-current={isActive ? "page" : undefined}
                        data-tooltip={NAV_TOOLTIPS[key]}
                        onClick={() => onSelectView(key)}
                      >
                        <Icon size={16} />
                        <span>
                          <strong>{label}</strong>
                          <small>{description}</small>
                        </span>
                        {pendingRequests > 0 && (
                          <span className="pill pill-warning" aria-label={`${pendingRequests} pending model access requests`}>
                            {pendingRequests}
                          </span>
                        )}
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </details>
            )}
            {profileStatus && !profileEditing && <small className="drawer-success account-inline-status">{profileStatus}</small>}
            {profileEditing && (
              <form className="drawer-card account-profile-form" onSubmit={handleProfileSubmit} noValidate>
                <div className="account-form-heading">
                  <strong>Profile</strong>
                  <span>Update the identity details shown in role-authorized user directories.</span>
                </div>
                <div className="account-avatar-editor">
                  <UserAvatar
                    user={{
                      ...data.me,
                      display_name: profileDraft.displayName || data.me.display_name,
                      avatar_url: profileDraft.avatarUrl || null,
                    }}
                    className="avatar account-profile-avatar"
                  />
                  <div className="account-photo-actions">
                    <label
                      className="secondary-button"
                      htmlFor={profilePhotoInputId}
                      data-tooltip="Choose an image from your device for your profile photo"
                    >
                      <Camera size={14} />
                      Upload photo
                    </label>
                    <input
                      id={profilePhotoInputId}
                      className="sr-only"
                      type="file"
                      accept="image/*"
                      onChange={handleProfilePhotoChange}
                    />
                    <small className="account-photo-hint">Image files up to 5 MB.</small>
                    {profileDraft.avatarUrl && (
                      <button
                        className="secondary-button"
                        type="button"
                        data-tooltip="Remove your photo and go back to your initials avatar"
                        onClick={() => setProfileDraft((current) => ({ ...current, avatarUrl: "" }))}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                <label htmlFor={`${profileFormId}-name`}>
                  Username
                  <input
                    id={`${profileFormId}-name`}
                    value={profileDraft.displayName}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, displayName: event.target.value }))}
                    placeholder="Your display name"
                    maxLength={120}
                  />
                </label>
                <label htmlFor={`${profileFormId}-phone`}>
                  Phone number
                  <input
                    id={`${profileFormId}-phone`}
                    value={profileDraft.phone}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, phone: event.target.value }))}
                    placeholder="+1 555 0100"
                    maxLength={40}
                  />
                </label>
                <label htmlFor={`${profileFormId}-firm`}>
                  Firm or organization
                  <input
                    id={`${profileFormId}-firm`}
                    value={profileDraft.firmName}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, firmName: event.target.value }))}
                    placeholder="Organization name"
                    maxLength={160}
                  />
                </label>
                <label htmlFor={`${profileFormId}-website`}>
                  Website
                  <input
                    id={`${profileFormId}-website`}
                    type="url"
                    value={profileDraft.websiteUrl}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, websiteUrl: event.target.value }))}
                    placeholder="https://example.com"
                    maxLength={2048}
                  />
                </label>
                <label htmlFor={`${profileFormId}-photo-url`}>
                  Profile photo URL
                  <input
                    id={`${profileFormId}-photo-url`}
                    value={profileDraft.avatarUrl}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, avatarUrl: event.target.value }))}
                    placeholder="https://example.com/photo.jpg"
                  />
                </label>
                <label htmlFor={`${profileFormId}-bio`}>
                  Bio
                  <textarea
                    id={`${profileFormId}-bio`}
                    value={profileDraft.bio}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, bio: event.target.value }))}
                    placeholder="Add a short note about your role or focus."
                    rows={4}
                    maxLength={500}
                  />
                </label>
                {profileError && <small className="drawer-error">{profileError}</small>}
                <div className="drawer-form-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    data-tooltip="Discard your profile edits and keep your current details"
                    onClick={() => {
                      setProfileDraft(profileDraftFromUser(data.me));
                      setProfileEditing(false);
                      setProfileError(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="primary-button account-form-submit-button"
                    type="submit"
                    disabled={isSavingProfile}
                    data-tooltip="Save these profile changes so teammates see them"
                  >
                    {isSavingProfile ? "Saving…" : "Save profile"}
                  </button>
                </div>
              </form>
            )}
            {apiAccessEnabled && <details className="drawer-card account-collapsible-card account-api-card">
              <summary className="account-collapsible-summary">
                <span className="account-collapsible-summary-copy">
                  <strong>API access</strong>
                  <small>{apiKeyStatus?.has_key ? "Personal key active" : "OpenAI-compatible access"}</small>
                </span>
                <span className="account-api-state is-enabled">Enabled</span>
                <ChevronDown className="account-collapsible-chevron" size={16} aria-hidden="true" />
              </summary>
              <div className="account-collapsible-content">
                {apiKeyBusy && apiKeyStatus === null ? (
                  <span>Checking your API access…</span>
                ) : (
                  <div className="account-api-content">
                  <label>
                    Platform URL
                    <span className="account-api-value-row">
                      <input aria-label="Platform API URL" readOnly value={apiBaseUrl} />
                      <button
                        className="secondary-button account-api-copy-button"
                        type="button"
                        aria-label="Copy platform API URL"
                        data-tooltip="Copy the OpenAI-compatible base URL"
                        onClick={() => void copyApiValue(apiBaseUrl, "url")}
                      >
                        {apiCopied === "url" ? <Check size={14} /> : <Copy size={14} />}
                        {apiCopied === "url" ? "Copied" : "Copy"}
                      </button>
                    </span>
                  </label>
                  {apiKeySecret ? (
                    <div className="account-api-secret">
                      <strong>New API key</strong>
                      <span>Copy it now. For security, the full key is shown only once.</span>
                      <span className="account-api-value-row">
                        <input aria-label="New API key" readOnly value={apiKeySecret} />
                        <button
                          className="secondary-button account-api-copy-button"
                          type="button"
                          aria-label="Copy API key"
                          data-tooltip="Copy this key before closing the account panel"
                          onClick={() => void copyApiValue(apiKeySecret, "key")}
                        >
                          {apiCopied === "key" ? <Check size={14} /> : <Copy size={14} />}
                          {apiCopied === "key" ? "Copied" : "Copy"}
                        </button>
                      </span>
                    </div>
                  ) : apiKeyStatus?.has_key ? (
                    <div className="account-api-existing">
                      <span>
                        <b>Active key</b>
                        <code>{apiKeyStatus.masked_value}</code>
                      </span>
                      <small>
                        Created {formatApiTimestamp(apiKeyStatus.created_at)}
                        {apiKeyStatus.last_used_at
                          ? ` · Last used ${formatApiTimestamp(apiKeyStatus.last_used_at)}`
                          : " · Not used yet"}
                      </small>
                    </div>
                  ) : (
                    <span>Create a personal key to use this workspace through its OpenAI-compatible API.</span>
                  )}
                  <div className="account-api-actions">
                    <button
                      className="primary-button account-api-action-button"
                      type="button"
                      disabled={apiKeyBusy || !onApiKeyCreate}
                      data-tooltip={apiKeyStatus?.has_key ? "Replace the current API key" : "Create a personal API key"}
                      onClick={() => void handleApiKeyCreate()}
                    >
                      {apiKeyStatus?.has_key ? <RefreshCw size={14} /> : <KeyRound size={14} />}
                      {apiKeyStatus?.has_key ? "Rotate key" : "Create key"}
                    </button>
                    {apiKeyStatus?.has_key && (
                      <button
                        className="secondary-button account-api-action-button is-danger"
                        type="button"
                        disabled={apiKeyBusy || !onApiKeyRevoke}
                        data-tooltip="Revoke the current key immediately"
                        onClick={() => void handleApiKeyRevoke()}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                  </div>
                )}
                {apiKeyError && <small className="drawer-error">{apiKeyError}</small>}
              </div>
            </details>}
            {memoryAvailable && onOpenMemory && (
              <button
                className="drawer-row"
                type="button"
                data-tooltip="Review, correct, or delete what the assistant remembers about you"
                onClick={onOpenMemory}
              >
                <Brain size={16} />
                <span>
                  <strong>Personalization memory</strong>
                  <small>{memoryDrawerHint(data)}</small>
                </span>
              </button>
            )}
            <section className="drawer-card account-security-section" aria-label="Account security">
              <div className="account-card-heading">
                <span className="account-password-heading-copy">
                  <strong>Security</strong>
                  <small>Authenticator and recovery codes</small>
                </span>
                <button className="secondary-button" type="button" aria-expanded={securityOpen}
                  aria-controls={securityPanelId} disabled={securityCloseBlocked}
                  onClick={() => setSecurityOpen((open) => !open)}>
                  <ShieldCheck size={15} /> {securityOpen ? "Close security" : "Manage security"}
                </button>
              </div>
              {securityOpen && <div id={securityPanelId} className="account-security-expanded">
                {securityCloseBlocked && <p className="account-security-guard-note" role="status">Finish verification or save your recovery codes before leaving this panel.</p>}
                <AccountSecurity user={data.me} onSignOut={onSignOut} onCloseGuardChange={onSecurityCloseGuardChange} />
              </div>}
            </section>
            <div
              className={`drawer-card account-password-card ${passwordEditing ? "is-editing" : "is-compact"}`}
            >
              <div className="account-card-heading">
                <span className="account-password-heading-copy">
                  <strong>Password</strong>
                  {!passwordEditing && (
                    <small>{canUpdatePassword ? "Local account" : "Managed by SSO"}</small>
                  )}
                </span>
                {canUpdatePassword ? (
                  <button
                    className="secondary-button account-password-edit-button"
                    type="button"
                    aria-expanded={passwordEditing}
                    aria-controls={`${passwordFormId}-panel`}
                    data-tooltip={
                      passwordEditing
                        ? "Close the password form without making changes"
                        : "Open the form to set a new account password"
                    }
                    onClick={() => {
                      setPasswordEditing((current) => !current);
                      setPasswordError(null);
                    }}
                  >
                    <Pencil size={14} />
                    {passwordEditing ? "Close" : "Edit"}
                  </button>
                ) : (
                  <KeyRound size={16} aria-hidden="true" />
                )}
              </div>
              {canUpdatePassword ? (
                passwordEditing ? (
                  <form id={`${passwordFormId}-panel`} className="account-password-form" onSubmit={handlePasswordSubmit} noValidate>
                    <label htmlFor={`${passwordFormId}-current`}>
                      Current password
                      <input
                        id={`${passwordFormId}-current`}
                        type="password"
                        autoComplete="current-password"
                        value={passwordDraft.currentPassword}
                        onChange={(event) =>
                          setPasswordDraft((current) => ({ ...current, currentPassword: event.target.value }))
                        }
                      />
                    </label>
                    <label htmlFor={`${passwordFormId}-new`}>
                      New password
                      <input
                        id={`${passwordFormId}-new`}
                        type="password"
                        autoComplete="new-password"
                        value={passwordDraft.newPassword}
                        onChange={(event) =>
                          setPasswordDraft((current) => ({ ...current, newPassword: event.target.value }))
                        }
                        placeholder="At least 12 characters"
                      />
                    </label>
                    <label htmlFor={`${passwordFormId}-confirm`}>
                      Confirm new password
                      <input
                        id={`${passwordFormId}-confirm`}
                        type="password"
                        autoComplete="new-password"
                        value={passwordDraft.confirmPassword}
                        onChange={(event) =>
                          setPasswordDraft((current) => ({ ...current, confirmPassword: event.target.value }))
                        }
                      />
                    </label>
                    {passwordError && <small className="drawer-error">{passwordError}</small>}
                    {passwordStatus && <small className="drawer-success">{passwordStatus}</small>}
                    <div className="drawer-form-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        data-tooltip="Close the password form and keep your current password"
                        onClick={() => {
                          setPasswordEditing(false);
                          setPasswordDraft(emptyPasswordDraft());
                          setPasswordError(null);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="primary-button account-form-submit-button"
                        type="submit"
                        disabled={isSavingPassword}
                        data-tooltip="Replace your current password with the new one"
                      >
                        {isSavingPassword ? "Updating…" : "Update password"}
                      </button>
                    </div>
                  </form>
                ) : (
                  passwordStatus && <small className="drawer-success">{passwordStatus}</small>
                )
              ) : null}
            </div>
            <div className="drawer-card account-detail-card">
              <div className="account-detail-grid">
                <span>
                  <b>Role</b>
                  {roleLabel(data.me.role)}
                </span>
                <span>
                  <b>Organization</b>
                  {data.currentTenant.name}
                </span>
                {(myUsageBudget?.caps ?? []).map((cap) => (
                  <span key={`${cap.scope}:${cap.label}`}>
                    <b>
                      {cap.scope === "user"
                        ? cap.budget_period === "lifetime"
                          ? "Temporary token grant"
                          : `${cap.budget_period === "day" ? "Daily" : cap.budget_period === "week" ? "Weekly" : "Monthly"} tokens`
                        : `${cap.label} · ${cap.budget_period}`}
                    </b>
                    {cap.reported_tokens.toLocaleString()} / {cap.daily_token_limit.toLocaleString()}{" "}
                    used this {cap.budget_period}
                  </span>
                ))}
                <span>
                  <b>Auth method</b>
                  {data.me.auth_method ?? "sso"}
                </span>
              </div>
            </div>
            {previewRoleOptions.length > 1 && (
              <div className="drawer-card view-as-card">
                <strong>View as</strong>
                <span>Preview the workspace with another role.</span>
                <div className="view-as-options" role="group" aria-label="Preview role">
                  {previewRoleOptions.map((role) => {
                    const selected = activePreviewRole === role;
                    return (
                      <button
                        key={role}
                        className={clsx("view-as-option", selected && "is-active")}
                        type="button"
                        aria-pressed={selected}
                        data-tooltip={
                          role === actualRole
                            ? "Return to your own role and stop previewing"
                            : `Preview the workspace as a ${previewRoleLabel(role)} would see it`
                        }
                        onClick={() => onViewAsRoleChange(role === actualRole ? null : role)}
                      >
                        {previewRoleLabel(role)}
                      </button>
                    );
                  })}
                </div>
                {viewAsRole && (
                  <small className="view-as-note">
                    Previewing {previewRoleLabel(viewAsRole)}. Your account role is {previewRoleLabel(actualRole)}.
                  </small>
                )}
              </div>
            )}
            <div className="drawer-card">
              <strong>Usage this month</strong>
              <div className="account-usage-grid">
                <span>
                  <b>{accountUsage.prompts}</b>
                  prompts
                </span>
                <span>
                  <b>{accountUsage.responses}</b>
                  responses
                </span>
                <span>
                  <b>{formatNumber(accountUsage.estimatedTokens)}</b>
                  est. tokens
                </span>
              </div>
            </div>
            <div className="drawer-card account-archived-card">
              <div className="account-card-heading">
                <strong>Archived chats</strong>
                <button
                  className="secondary-button"
                  type="button"
                  aria-expanded={archiveOpen}
                  aria-controls={`${archiveSectionId}-panel`}
                  data-tooltip={
                    archiveOpen
                      ? "Collapse your archived chats"
                      : "Review archived chats to restore or permanently delete them"
                  }
                  onClick={() => setArchiveOpen((current) => !current)}
                >
                  <Archive size={14} />
                  {archiveOpen ? "Close" : archivedThreads.length > 0 ? `View (${archivedThreads.length})` : "View"}
                </button>
              </div>
              {archiveOpen ? (
                <div id={`${archiveSectionId}-panel`} className="account-archived-list">
                  {archivedThreads.length > 0 ? (
                    archivedThreads.map((thread) => (
                      <div className="account-archived-row" key={thread.id}>
                        {thread.used_agent ? <Bot size={16} /> : <MessageSquare size={16} />}
                        <ChatPreview thread={thread}>
                          <span className="account-archived-summary" tabIndex={0}>
                            <strong>{thread.title}</strong>
                            <small>Archived · {thread.updated_at}</small>
                          </span>
                        </ChatPreview>
                        <span className="account-archived-actions">
                          <button
                            className="archived-chat-action"
                            type="button"
                            aria-label={`Restore ${thread.title}`}
                            data-tooltip={`Return "${thread.title}" to your sidebar`}
                            onClick={() => onRestoreThread(thread.id)}
                          >
                            <ArchiveRestore size={14} />
                          </button>
                          <button
                            className="archived-chat-action is-danger"
                            type="button"
                            aria-label={`Permanently delete ${thread.title}`}
                            data-tooltip={`Permanently delete "${thread.title}" — this cannot be undone`}
                            onClick={() => handleDeleteArchived(thread)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </span>
                      </div>
                    ))
                  ) : (
                    <span className="account-archived-empty">
                      No archived chats. Archive a chat from the sidebar to keep it here without deleting it.
                    </span>
                  )}
                </div>
              ) : (
                <span>
                  {archivedThreads.length > 0
                    ? `${archivedThreads.length} archived ${archivedThreads.length === 1 ? "chat" : "chats"}. Restore them or permanently delete them.`
                    : "Chats you archive from the sidebar are kept here."}
                </span>
              )}
            </div>
            {onSignOut && (
              <button
                className="drawer-row"
                type="button"
                data-tooltip={`Sign out of ${data.currentTenant.chat_brand_name?.trim() || "Aperture Chat"} and end this session`}
                onClick={onRequestSignOut ?? onSignOut}
              >
                <LogOut size={16} />
                <span>
                  <strong>Sign out</strong>
                  <small>End this session.</small>
                </span>
              </button>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

type ProfileDraft = {
  displayName: string;
  firmName: string;
  websiteUrl: string;
  phone: string;
  bio: string;
  avatarUrl: string;
};

type PasswordDraft = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

function profileDraftFromUser(user: User): ProfileDraft {
  return {
    displayName: user.display_name,
    firmName: user.firm_name ?? "",
    websiteUrl: user.website_url ?? "",
    phone: user.phone ?? "",
    bio: user.bio ?? "",
    avatarUrl: user.avatar_url ?? "",
  };
}

function emptyPasswordDraft(): PasswordDraft {
  return {
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  };
}

async function downscaleProfilePhotoToDataUrl(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PROFILE_PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // JPEG keeps photos small; PNG sources stay PNG so transparency survives.
    return file.type === "image/png"
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

function readProfilePhotoAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" && reader.result ? reader.result : null);
    });
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

function isProfileImageReference(value: string) {
  if (value.startsWith("data:image/")) return true;
  if (value.startsWith("/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function profileImageDataUrlByteLength(value: string): number | null {
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0 || !value.slice(0, commaIndex).toLowerCase().includes(";base64")) return null;
  const encoded = value.slice(commaIndex + 1).replace(/\s/g, "");
  if (!encoded) return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
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

function availablePreviewRoles(role: Role): Role[] {
  if (role === "PLATFORM_OWNER") return ["PLATFORM_OWNER", "TENANT_ADMIN", "USER"];
  if (role === "TENANT_ADMIN") return ["TENANT_ADMIN", "USER"];
  return [role];
}

function previewRoleLabel(role: Role) {
  return PREVIEW_ROLE_LABELS[role] ?? roleLabel(role);
}

function roleLabel(role: string) {
  return ROLE_LABELS[role as Role] ?? "User";
}

function formatApiTimestamp(value?: string | null) {
  if (!value) return "recently";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function accountUsageSummary(threads: ChatThread[]) {
  const messages = threads.flatMap((thread) => thread.messages);
  const prompts = messages.filter((message) => message.role === "user").length;
  const responses = messages.filter((message) => message.role === "assistant" && message.status !== "pending").length;
  const estimatedTokens = messages.reduce((total, message) => total + estimateTokens(message), 0);
  return { prompts, responses, estimatedTokens };
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

function estimateTokens(message: ChatMessage) {
  const content = message.content.trim();
  const contentTokens = content ? Math.max(1, Math.ceil(content.length / 4)) : 0;
  const attachmentTokens = (message.attachments?.length ?? 0) * 25;
  return contentTokens + attachmentTokens;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
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
