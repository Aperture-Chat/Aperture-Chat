import type { Role } from "./types";

/**
 * Typed application routes. The URL is only a selector: every console still
 * renders behind the same role checks as before, and the API keeps enforcing
 * ownership and tenant scope on every request. Nothing here grants access.
 */

export type ViewKey = "chat" | "drafts" | "agents" | "library" | "admin" | "platform";

export type AgentsSection = "agents" | "automations";
export type LibrarySection = "knowledge" | "tools";
export type AdminSection =
  | "users"
  | "groups"
  | "model-access"
  | "tools"
  | "sso"
  | "analytics"
  | "policies"
  | "audit"
  | "alerts";
export type PlatformSection =
  | "setup"
  | "org-settings"
  | "models"
  | "providers"
  | "analytics"
  | "audit"
  | "alerts";

export type AppRoute =
  | { kind: "chat"; threadId?: string }
  | { kind: "drafts"; draftId?: string }
  | { kind: "agents"; section: AgentsSection }
  | { kind: "library"; section: LibrarySection }
  | { kind: "admin"; section: AdminSection }
  | { kind: "platform"; section: PlatformSection };

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  "users",
  "groups",
  "model-access",
  "tools",
  "sso",
  "analytics",
  "policies",
  "audit",
  "alerts",
];

export const PLATFORM_SECTIONS: readonly PlatformSection[] = [
  "setup",
  "org-settings",
  "models",
  "providers",
  "analytics",
  "audit",
  "alerts",
];

/** Path prefixes owned by the API/edge, never by the SPA router. */
export const RESERVED_PREFIXES = ["/api", "/v1", "/scim/v2", "/health"] as const;

export const DEFAULT_ROUTE: AppRoute = { kind: "chat" };

function isAdminSection(value: string): value is AdminSection {
  return (ADMIN_SECTIONS as readonly string[]).includes(value);
}

function isPlatformSection(value: string): value is PlatformSection {
  return (PLATFORM_SECTIONS as readonly string[]).includes(value);
}

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

export function isReservedPath(pathname: string): boolean {
  return RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Parses a pathname into a route. Returns `null` for anything the workspace
 * does not know so the caller can show an honest notice and fall back to
 * chat instead of rendering a 404 page that leaks structure.
 */
export function parsePath(pathname: string): AppRoute | null {
  if (isReservedPath(pathname)) return null;
  const segments = pathname
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return DEFAULT_ROUTE;
  const [head, second, ...rest] = segments;
  if (rest.length > 0) return null;
  switch (head) {
    case "chat": {
      if (second === undefined) return { kind: "chat" };
      const threadId = decodeSegment(second);
      return threadId ? { kind: "chat", threadId } : null;
    }
    case "drafts": {
      if (second === undefined) return { kind: "drafts" };
      const draftId = decodeSegment(second);
      return draftId ? { kind: "drafts", draftId } : null;
    }
    case "agents":
      return second === undefined ? { kind: "agents", section: "agents" } : null;
    case "automations":
      return second === undefined ? { kind: "agents", section: "automations" } : null;
    case "library": {
      if (second === undefined) return { kind: "library", section: "knowledge" };
      if (second === "knowledge" || second === "tools") return { kind: "library", section: second };
      return null;
    }
    case "admin": {
      if (second === undefined) return { kind: "admin", section: "users" };
      return isAdminSection(second) ? { kind: "admin", section: second } : null;
    }
    case "platform": {
      if (second === undefined) return { kind: "platform", section: "org-settings" };
      return isPlatformSection(second) ? { kind: "platform", section: second } : null;
    }
    default:
      return null;
  }
}

export function routeToPath(route: AppRoute): string {
  switch (route.kind) {
    case "chat":
      return route.threadId ? `/chat/${encodeURIComponent(route.threadId)}` : "/chat";
    case "drafts":
      return route.draftId ? `/drafts/${encodeURIComponent(route.draftId)}` : "/drafts";
    case "agents":
      return route.section === "automations" ? "/automations" : "/agents";
    case "library":
      return `/library/${route.section}`;
    case "admin":
      return `/admin/${route.section}`;
    case "platform":
      return `/platform/${route.section}`;
  }
}

export function viewKeyForRoute(route: AppRoute): ViewKey {
  return route.kind;
}

export function defaultRouteForView(view: ViewKey): AppRoute {
  switch (view) {
    case "chat":
      return { kind: "chat" };
    case "drafts":
      return { kind: "drafts" };
    case "agents":
      return { kind: "agents", section: "agents" };
    case "library":
      return { kind: "library", section: "knowledge" };
    case "admin":
      return { kind: "admin", section: "users" };
    case "platform":
      return { kind: "platform", section: "org-settings" };
  }
}

/**
 * Mirrors the historical `resolveViewForRole` gate: the platform console is
 * owner-only (tenant admins fall to Admin › Users, everyone else to chat) and
 * the admin console needs an admin or owner. Other routes are open to any
 * signed-in role; the API still scopes what they can load.
 */
export function routeForRole(route: AppRoute, role: Role): AppRoute {
  if (route.kind === "platform" && role !== "PLATFORM_OWNER") {
    return role === "TENANT_ADMIN" ? { kind: "admin", section: "users" } : DEFAULT_ROUTE;
  }
  if (route.kind === "admin" && role !== "PLATFORM_OWNER" && role !== "TENANT_ADMIN") {
    return DEFAULT_ROUTE;
  }
  return route;
}

export function routesEqual(a: AppRoute, b: AppRoute): boolean {
  return routeToPath(a) === routeToPath(b);
}

/** Human label used by the drafts navigation guard when leaving a screen. */
export function routeLabel(route: AppRoute): string {
  switch (route.kind) {
    case "chat":
      return route.threadId ? "open another chat" : "start a new chat";
    case "drafts":
      return route.draftId ? "open another draft" : "start a new draft";
    case "agents":
      return route.section === "automations" ? "open Automations" : "open Agents";
    case "library":
      return route.section === "tools" ? "open Tools" : "open Knowledge";
    case "admin":
      return "open the Admin console";
    case "platform":
      return "open the Platform console";
  }
}
