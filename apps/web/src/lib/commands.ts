import {
  ADMIN_SECTIONS,
  PLATFORM_SECTIONS,
  routeForRole,
  routeToPath,
  routesEqual,
  type AdminSection,
  type AppRoute,
  type PlatformSection,
} from "./appRoute";
import type { Role } from "./types";

/**
 * A palette command: a navigation or shell action the current role may run.
 * Commands are built client-side from the same role predicates as the rail
 * and never call an endpoint the role could not call; the API still enforces.
 */
export type PaletteCommand = {
  id: string;
  label: string;
  /** Secondary text (path or effect) shown under the label. */
  hint?: string;
  /** Extra words that should match when filtering. */
  keywords?: string[];
  group: "navigate" | "action";
  run: () => void;
};

export type CommandActions = {
  navigate: (route: AppRoute) => void;
  newChat: () => void;
  toggleDarkMode: () => void;
  openHelp: () => void;
  signOut?: () => void;
  installApp?: () => void;
};

const ADMIN_LABELS: Record<AdminSection, string> = {
  users: "Users",
  groups: "Groups",
  "model-access": "Model Access",
  tools: "Connections",
  sso: "SSO",
  analytics: "Analytics",
  policies: "Policies",
  audit: "Audit",
  alerts: "Alerts",
};

const PLATFORM_LABELS: Record<PlatformSection, string> = {
  setup: "Setup",
  "org-settings": "Org Settings",
  models: "Models",
  providers: "Providers",
  analytics: "Analytics",
  audit: "Audit",
  alerts: "Alerts",
};

function navigationCommand(
  label: string,
  route: AppRoute,
  role: Role,
  current: AppRoute | null,
  actions: CommandActions,
  keywords: string[] = [],
): PaletteCommand | null {
  // Only offer routes the role may actually open; the gate is the same one
  // App applies to pasted URLs.
  if (!routesEqual(routeForRole(route, role), route)) return null;
  if (current && routesEqual(current, route)) return null;
  return {
    id: `go:${routeToPath(route)}`,
    label: `Go to ${label}`,
    hint: routeToPath(route),
    keywords: ["open", "navigate", ...keywords],
    group: "navigate",
    run: () => actions.navigate(route),
  };
}

export function buildCommands({
  role,
  route,
  darkMode,
  actions,
}: {
  role: Role;
  route: AppRoute | null;
  darkMode: boolean;
  actions: CommandActions;
}): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    {
      id: "action:new-chat",
      label: "New chat",
      hint: "Start a fresh conversation",
      keywords: ["start", "conversation"],
      group: "action",
      run: actions.newChat,
    },
  ];
  const nav: Array<PaletteCommand | null> = [
    navigationCommand("Chat", { kind: "chat" }, role, route, actions),
    navigationCommand("Drafts", { kind: "drafts" }, role, route, actions, ["document", "deck", "write"]),
    navigationCommand("Agents", { kind: "agents", section: "agents" }, role, route, actions),
    navigationCommand("Automations", { kind: "agents", section: "automations" }, role, route, actions, ["schedule"]),
    navigationCommand("Knowledge", { kind: "library", section: "knowledge" }, role, route, actions, ["library", "sources"]),
    navigationCommand("Tools", { kind: "library", section: "tools" }, role, route, actions, ["library", "mcp"]),
    ...ADMIN_SECTIONS.map((section) =>
      navigationCommand(`Admin › ${ADMIN_LABELS[section]}`, { kind: "admin", section }, role, route, actions, ["admin", "console"]),
    ),
    ...PLATFORM_SECTIONS.map((section) =>
      navigationCommand(`Platform › ${PLATFORM_LABELS[section]}`, { kind: "platform", section }, role, route, actions, [
        "platform",
        "owner",
        "console",
      ]),
    ),
  ];
  commands.push(...nav.filter((command): command is PaletteCommand => command !== null));
  commands.push({
    id: "action:toggle-theme",
    label: darkMode ? "Switch to light mode" : "Switch to dark mode",
    hint: "Appearance",
    keywords: ["theme", "dark", "light", "appearance"],
    group: "action",
    run: actions.toggleDarkMode,
  });
  commands.push({
    id: "action:help",
    label: "Open Help",
    hint: "Guides, walkthroughs, and issue reports",
    keywords: ["guide", "documentation", "support"],
    group: "action",
    run: actions.openHelp,
  });
  if (actions.installApp) {
    commands.push({
      id: "action:install",
      label: "Install app",
      hint: "Add this workspace to your home screen",
      keywords: ["pwa", "home screen"],
      group: "action",
      run: actions.installApp,
    });
  }
  if (actions.signOut) {
    commands.push({
      id: "action:sign-out",
      label: "Sign out",
      hint: "End this session on this device",
      keywords: ["logout", "log out"],
      group: "action",
      run: actions.signOut,
    });
  }
  return commands;
}

/** Case-insensitive match on label and keywords; every query word must appear. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.hint ?? ""} ${(command.keywords ?? []).join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Recently opened palette results, kept per user in sessionStorage only. */
export type PaletteRecentItem = {
  id: string;
  kind: string;
  title: string;
  navigation: Record<string, string>;
  openedAt: string;
};

export const PALETTE_RECENT_LIMIT = 8;

function recentKey(userId: string): string {
  return `aperture-palette-recent:${encodeURIComponent(userId)}`;
}

export function loadPaletteRecent(userId: string): PaletteRecentItem[] {
  try {
    const raw = window.sessionStorage.getItem(recentKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PaletteRecentItem =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as PaletteRecentItem).id === "string" &&
        typeof (item as PaletteRecentItem).title === "string" &&
        typeof (item as PaletteRecentItem).navigation === "object",
    );
  } catch {
    return [];
  }
}

export function rememberPaletteRecent(userId: string, item: Omit<PaletteRecentItem, "openedAt">): PaletteRecentItem[] {
  const next: PaletteRecentItem[] = [
    { ...item, openedAt: new Date().toISOString() },
    ...loadPaletteRecent(userId).filter((existing) => existing.id !== item.id || existing.kind !== item.kind),
  ].slice(0, PALETTE_RECENT_LIMIT);
  try {
    window.sessionStorage.setItem(recentKey(userId), JSON.stringify(next));
  } catch {
    // Recent items are a convenience; the palette works without them.
  }
  return next;
}
