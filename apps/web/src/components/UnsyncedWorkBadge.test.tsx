import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatThread } from "../lib/types";
import { UnsyncedWorkBadge, summarizeUnsyncedWork } from "./UnsyncedWorkBadge";

const scope = { tenantId: "tenant-example", userId: "user-jane" };
const cacheKey = "aperture-drafts-cache-v2:tenant-example:user-jane";

function thread(id: string, syncPending: boolean): ChatThread {
  return {
    id,
    owner_user_id: "user-jane",
    title: `Thread ${id}`,
    model_id: "m",
    group_id: null,
    pinned: false,
    used_agent: false,
    updated_at: "now",
    messages: [{ id: `${id}-m`, role: "user", content: "hi", createdAt: "12:00 PM", status: "ok" }],
    syncPending,
  } as ChatThread;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

test("opens outside the sidebar stacking context and restores focus on Escape", () => {
  const { container } = render(
    <aside style={{ isolation: "isolate", transform: "translateX(0)" }}>
      <UnsyncedWorkBadge
        chat={{ threads: [thread("a", true)], unsyncedThreadCount: 1, retryUnsyncedThreads: vi.fn(async () => {}) }}
        scope={scope}
        onOpenDrafts={vi.fn()}
      />
    </aside>,
  );
  const trigger = screen.getByRole("button", { name: "1 item only on this device" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Only on this device" });
  const backdrop = screen.getByRole("button", { name: "Close unsynced work" });
  expect(container).not.toContainElement(dialog);
  expect(dialog.parentElement).toBe(document.body);
  expect(backdrop.parentElement).toBe(document.body);
  expect(within(dialog).getByRole("button", { name: "Close unsynced work dialog" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "Close unsynced work" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("counts unsynced chats, drafts, decks, and legacy history from real local state", () => {
  window.localStorage.setItem(
    cacheKey,
    JSON.stringify([
      { id: "d1", title: "Uploaded memo", serverId: "srv-1", serverRevision: 2 },
      { id: "d2", title: "Local deck", kind: "deck" },
      { id: "d3", title: "Edited memo", serverId: "srv-3", serverRevision: 1, serverSavePending: true },
    ]),
  );
  window.localStorage.setItem("aperture-document-history-v1", JSON.stringify([{ id: "old-1", title: "Old draft" }]));
  const summary = summarizeUnsyncedWork({ threads: [thread("a", true), thread("b", false)] }, scope);
  expect(summary.threads.map((item) => item.id)).toEqual(["a"]);
  expect(summary.drafts.map((item) => item.id)).toEqual(["d2", "d3"]);
  expect(summary.legacyCount).toBe(1);
  expect(summary.total).toBe(4);
});

test("renders nothing when everything is on the server, otherwise opens a panel with real actions", async () => {
  const retry = vi.fn(async () => {});
  const onOpenDrafts = vi.fn();
  const clean = render(
    <UnsyncedWorkBadge
      chat={{ threads: [thread("a", false)], unsyncedThreadCount: 0, retryUnsyncedThreads: retry }}
      scope={scope}
      onOpenDrafts={onOpenDrafts}
    />,
  );
  expect(screen.queryByRole("button", { name: /only on this device/ })).not.toBeInTheDocument();
  clean.unmount();

  window.localStorage.setItem(cacheKey, JSON.stringify([{ id: "d2", title: "Local deck", kind: "deck" }]));
  render(
    <UnsyncedWorkBadge
      chat={{ threads: [thread("a", true)], unsyncedThreadCount: 1, retryUnsyncedThreads: retry }}
      scope={scope}
      onOpenDrafts={onOpenDrafts}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "2 items only on this device" }));
  const dialog = screen.getByRole("dialog", { name: "Only on this device" });
  expect(within(dialog).getByText("Thread a")).toBeInTheDocument();
  expect(within(dialog).getByText(/Local deck \(deck\) — never uploaded/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry all" }));
  expect(retry).toHaveBeenCalledOnce();
  fireEvent.click(within(dialog).getByRole("button", { name: "Open Drafts" }));
  expect(onOpenDrafts).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});


test("archived local drafts leave the notice while their contents stay recoverable", () => {
  const entries = [
    { id: "active", title: "Active draft", content: "<p>Active</p>" },
    { id: "archived", title: "Finished draft", content: "<p>Keep me</p>", archived: true },
  ];
  window.localStorage.setItem(cacheKey, JSON.stringify(entries));
  expect(summarizeUnsyncedWork({ threads: [] }, scope).drafts.map(item => item.id)).toEqual(["active"]);
  expect(JSON.parse(window.localStorage.getItem(cacheKey)!)).toEqual(entries);
});

const preferenceKey = "aperture-work-reminders-v1:tenant-example:user-jane";
const reminderChat = () => ({ threads: [thread("a", true)], unsyncedThreadCount: 1, retryUnsyncedThreads: vi.fn(async () => {}) });

test("clear list persists across remounts, preserves work and reports new edits", () => {
  const drafts = [{ id: "d1", title: "Keep draft", content: "<p>Original</p>" }];
  const legacy = [{ id: "old", title: "Keep legacy", content: "<p>Old</p>" }];
  localStorage.setItem(cacheKey, JSON.stringify(drafts));
  localStorage.setItem("aperture-document-history-v1", JSON.stringify(legacy));
  const chat = reminderChat();
  const originalChat = JSON.stringify(chat.threads);
  const props = { chat, scope, onOpenDrafts: vi.fn() };
  const first = render(<UnsyncedWorkBadge {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "3 items only on this device" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear list" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /only on this device/ })).not.toBeInTheDocument();
  expect(localStorage.getItem(cacheKey)).toBe(JSON.stringify(drafts));
  expect(localStorage.getItem("aperture-document-history-v1")).toBe(JSON.stringify(legacy));
  expect(JSON.stringify(chat.threads)).toBe(originalChat);
  expect(chat.retryUnsyncedThreads).not.toHaveBeenCalled();
  first.unmount();
  const second = render(<UnsyncedWorkBadge {...props} />);
  expect(screen.queryByRole("button", { name: /only on this device/ })).not.toBeInTheDocument();
  // Sync bookkeeping alone must not bring a dismissed reminder back.
  localStorage.setItem(cacheKey, JSON.stringify([{ ...drafts[0], updatedAt: "later", serverSavePending: true }]));
  fireEvent(window, new Event("aperture-document-history-updated"));
  expect(screen.queryByRole("button", { name: /only on this device/ })).not.toBeInTheDocument();
  localStorage.setItem(cacheKey, JSON.stringify([{ ...drafts[0], content: "<p>Edited</p>" }]));
  fireEvent(window, new Event("aperture-document-history-updated"));
  fireEvent.click(screen.getByRole("button", { name: "1 item only on this device" }));
  expect(screen.getByText(/Keep draft — never uploaded/)).toBeInTheDocument();
  expect(screen.queryByText("Thread a")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close unsynced work dialog" }));
  second.rerender(<UnsyncedWorkBadge {...props} chat={{ ...chat, threads: [{ ...chat.threads[0], messages: [{ ...chat.threads[0].messages[0], content: "New message text" }] }] }} />);
  expect(screen.getByRole("button", { name: "2 items only on this device" })).toBeInTheDocument();
});

test("hide reminder persists for this account and browser while other accounts keep their notices", () => {
  const props = { chat: reminderChat(), scope, onOpenDrafts: vi.fn() };
  const first = render(<UnsyncedWorkBadge {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "1 item only on this device" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide this reminder" }));
  expect(JSON.parse(localStorage.getItem(preferenceKey)!).hidden).toBe(true);
  first.unmount();
  localStorage.setItem(cacheKey, JSON.stringify([{ id: "new", title: "New work" }]));
  const second = render(<UnsyncedWorkBadge {...props} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  second.rerender(<UnsyncedWorkBadge {...props} scope={{ ...scope, userId: "another-user" }} />);
  expect(screen.getByRole("button", { name: "1 item only on this device" })).toBeInTheDocument();
  second.rerender(<UnsyncedWorkBadge {...props} scope={{ ...scope, tenantId: "another-tenant" }} />);
  expect(screen.getByRole("button", { name: "1 item only on this device" })).toBeInTheDocument();
});

test("dismissal from another tab closes the dialog and malformed preferences remain recoverable", () => {
  localStorage.setItem(preferenceKey, "not json");
  render(<UnsyncedWorkBadge chat={reminderChat()} scope={scope} onOpenDrafts={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "1 item only on this device" }));
  localStorage.setItem(preferenceKey, JSON.stringify({ hidden: true, cleared: [] }));
  fireEvent(window, new StorageEvent("storage", { key: preferenceKey }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("a storage failure keeps the notice and explains that the preference was not saved", () => {
  render(<UnsyncedWorkBadge chat={reminderChat()} scope={scope} onOpenDrafts={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "1 item only on this device" }));
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
  fireEvent.click(screen.getByRole("button", { name: "Clear list" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Your browser could not save this preference");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(localStorage.getItem(preferenceKey)).toBeNull();
});
