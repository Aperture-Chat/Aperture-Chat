import { describe, expect, test } from "vitest";
import {
  ADMIN_SECTIONS,
  DEFAULT_ROUTE,
  PLATFORM_SECTIONS,
  defaultRouteForView,
  isReservedPath,
  parsePath,
  routeForRole,
  routeToPath,
  routesEqual,
  viewKeyForRoute,
  type AppRoute,
} from "./appRoute";

describe("parsePath", () => {
  test("root and bare sections resolve to their defaults", () => {
    expect(parsePath("/")).toEqual({ kind: "chat" });
    expect(parsePath("")).toEqual({ kind: "chat" });
    expect(parsePath("/chat")).toEqual({ kind: "chat" });
    expect(parsePath("/drafts/")).toEqual({ kind: "drafts" });
    expect(parsePath("/agents")).toEqual({ kind: "agents", section: "agents" });
    expect(parsePath("/automations")).toEqual({ kind: "agents", section: "automations" });
    expect(parsePath("/library")).toEqual({ kind: "library", section: "knowledge" });
    expect(parsePath("/admin")).toEqual({ kind: "admin", section: "users" });
    expect(parsePath("/platform")).toEqual({ kind: "platform", section: "org-settings" });
  });

  test("retired Setup links resolve to Org Settings", () => {
    const route = parsePath("/platform/setup");
    expect(route).toEqual({ kind: "platform", section: "org-settings" });
    expect(routeToPath(route!)).toBe("/platform/org-settings");
  });

  test("ids are URL-decoded and trailing slashes are tolerated", () => {
    expect(parsePath("/chat/thread%20one/")).toEqual({ kind: "chat", threadId: "thread one" });
    expect(parsePath("/drafts/draft-9")).toEqual({ kind: "drafts", draftId: "draft-9" });
  });

  test("every console section round-trips", () => {
    for (const section of ADMIN_SECTIONS) {
      const route: AppRoute = { kind: "admin", section };
      expect(parsePath(routeToPath(route))).toEqual(route);
    }
    for (const section of PLATFORM_SECTIONS) {
      const route: AppRoute = { kind: "platform", section };
      expect(parsePath(routeToPath(route))).toEqual(route);
    }
    expect(parsePath(routeToPath({ kind: "library", section: "tools" }))).toEqual({ kind: "library", section: "tools" });
  });

  test("unknown paths, reserved prefixes, and extra segments are rejected", () => {
    expect(parsePath("/nope")).toBeNull();
    expect(parsePath("/admin/secret-panel")).toBeNull();
    expect(parsePath("/platform/models/extra")).toBeNull();
    expect(parsePath("/chat/a/b")).toBeNull();
    expect(parsePath("/library/other")).toBeNull();
    expect(parsePath("/api/bootstrap")).toBeNull();
    expect(parsePath("/v1/chat/completions")).toBeNull();
    expect(parsePath("/scim/v2/Users")).toBeNull();
    expect(parsePath("/health")).toBeNull();
    expect(isReservedPath("/healthy")).toBe(false);
    expect(parsePath("/chat/%E0%A4%A")).toBeNull();
  });
});

describe("routeToPath", () => {
  test("encodes ids and formats sections", () => {
    expect(routeToPath({ kind: "chat", threadId: "a b/c" })).toBe("/chat/a%20b%2Fc");
    expect(routeToPath({ kind: "drafts" })).toBe("/drafts");
    expect(routeToPath({ kind: "agents", section: "automations" })).toBe("/automations");
    expect(routeToPath({ kind: "library", section: "tools" })).toBe("/library/tools");
    expect(routeToPath({ kind: "admin", section: "model-access" })).toBe("/admin/model-access");
    expect(routeToPath({ kind: "platform", section: "org-settings" })).toBe("/platform/org-settings");
  });

  test("view keys map to and from routes", () => {
    for (const view of ["chat", "drafts", "agents", "library", "admin", "platform"] as const) {
      expect(viewKeyForRoute(defaultRouteForView(view))).toBe(view);
    }
  });
});

describe("routeForRole", () => {
  test("platform console is owner-only and admins fall back to Admin › Users", () => {
    const platform: AppRoute = { kind: "platform", section: "models" };
    expect(routeForRole(platform, "PLATFORM_OWNER")).toEqual(platform);
    expect(routeForRole(platform, "TENANT_ADMIN")).toEqual({ kind: "admin", section: "users" });
    expect(routeForRole(platform, "USER")).toEqual(DEFAULT_ROUTE);
  });

  test("admin console needs an admin or owner; other routes are open", () => {
    const admin: AppRoute = { kind: "admin", section: "groups" };
    expect(routeForRole(admin, "PLATFORM_OWNER")).toEqual(admin);
    expect(routeForRole(admin, "TENANT_ADMIN")).toEqual(admin);
    expect(routeForRole(admin, "USER")).toEqual(DEFAULT_ROUTE);
    expect(routeForRole(admin, "TEMP_USER")).toEqual(DEFAULT_ROUTE);
    const drafts: AppRoute = { kind: "drafts", draftId: "d1" };
    expect(routeForRole(drafts, "USER")).toEqual(drafts);
  });

  test("routesEqual compares by path", () => {
    expect(routesEqual({ kind: "chat" }, { kind: "chat" })).toBe(true);
    expect(routesEqual({ kind: "chat", threadId: "x" }, { kind: "chat" })).toBe(false);
  });
});
