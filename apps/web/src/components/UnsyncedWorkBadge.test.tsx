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
