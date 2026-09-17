import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildCommands,
  filterCommands,
  loadPaletteRecent,
  rememberPaletteRecent,
  type CommandActions,
} from "./commands";

function actions(): CommandActions {
  return { navigate: vi.fn(), newChat: vi.fn(), toggleDarkMode: vi.fn(), openHelp: vi.fn(), signOut: vi.fn() };
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe("buildCommands", () => {
  test("users never see admin or platform destinations; owners see both", () => {
    const user = buildCommands({ role: "USER", route: { kind: "chat" }, darkMode: false, actions: actions() });
    const labels = user.map((command) => command.label);
    expect(labels).toContain("Go to Drafts");
    expect(labels.some((label) => label.startsWith("Go to Admin"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Go to Platform"))).toBe(false);
    expect(labels).not.toContain("Go to Chat");

    const admin = buildCommands({ role: "TENANT_ADMIN", route: null, darkMode: false, actions: actions() }).map((c) => c.label);
    expect(admin).toContain("Go to Admin › Model Access");
    expect(admin.some((label) => label.startsWith("Go to Platform"))).toBe(false);

    const owner = buildCommands({ role: "PLATFORM_OWNER", route: null, darkMode: true, actions: actions() }).map((c) => c.label);
    expect(owner).toContain("Go to Platform › Org Settings");
    expect(owner).not.toContain("Go to Platform › Setup");
    expect(owner).toContain("Go to Admin › Users");
    expect(owner).toContain("Switch to light mode");
  });

  test("commands run the shell actions they describe", () => {
    const shell = actions();
    const commands = buildCommands({ role: "USER", route: null, darkMode: false, actions: shell });
    commands.find((command) => command.label === "Go to Tools")!.run();
    expect(shell.navigate).toHaveBeenCalledWith({ kind: "library", section: "tools" });
    commands.find((command) => command.label === "Sign out")!.run();
    expect(shell.signOut).toHaveBeenCalledOnce();
    expect(commands.some((command) => command.label === "Install app")).toBe(false);
  });

  test("filterCommands matches every word against label, hint, and keywords", () => {
    const commands = buildCommands({ role: "PLATFORM_OWNER", route: null, darkMode: false, actions: actions() });
    expect(filterCommands(commands, "platform org settings").map((c) => c.label)).toEqual(["Go to Platform › Org Settings"]);
    expect(filterCommands(commands, "logout").map((c) => c.label)).toEqual(["Sign out"]);
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });
});

test("recent items are per user, deduplicated, newest first, and capped", () => {
  for (let index = 0; index < 10; index += 1) {
    rememberPaletteRecent("user-a", { id: `t${index}`, kind: "chat", title: `Thread ${index}`, navigation: { view: "chat", thread_id: `t${index}` } });
  }
  rememberPaletteRecent("user-a", { id: "t9", kind: "chat", title: "Thread 9 again", navigation: { view: "chat", thread_id: "t9" } });
  const recent = loadPaletteRecent("user-a");
  expect(recent).toHaveLength(8);
  expect(recent[0].title).toBe("Thread 9 again");
  expect(recent.filter((item) => item.id === "t9")).toHaveLength(1);
  expect(loadPaletteRecent("user-b")).toEqual([]);
});
