import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MemoryManager, type MemoryManagerApi } from "./MemoryManager";
import type { MemoryCollection, UserMemory } from "../lib/types";

function memory(overrides: Partial<UserMemory> = {}): UserMemory {
  return {
    id: "mem-1",
    tenant_id: "tenant-apex",
    owner_user_id: "user-jane",
    kind: "preference",
    content: "Prefers a short summary before the detail",
    source: "inferred",
    source_thread_id: null,
    confidence: 0.7,
    pinned: false,
    use_count: 3,
    last_used_at: null,
    expires_at: null,
    active: true,
    created_at: "2026-01-01T00:00:00+00:00",
    updated_at: "2026-01-01T00:00:00+00:00",
    ...overrides,
  };
}

function collection(overrides: Partial<MemoryCollection> = {}): MemoryCollection {
  return {
    state: {
      enabled: true,
      capture_enabled: true,
      platform_enabled: true,
      tenant_enabled: true,
      group_allowed: true,
      user_enabled: true,
      reason: null,
    },
    settings: { user_id: "user-jane", enabled: true, auto_capture_enabled: true },
    memories: [memory()],
    ...overrides,
  };
}

function harness(data: MemoryCollection, overrides: Partial<MemoryManagerApi> = {}) {
  const api: MemoryManagerApi = {
    list: vi.fn(async () => data),
    create: vi.fn(async ({ content, kind }) => memory({ id: "mem-2", content, kind, source: "explicit" })),
    update: vi.fn(async (memoryId, patch) => memory({ id: memoryId, ...patch })),
    remove: vi.fn(async () => undefined),
    purge: vi.fn(async () => ({ removed: 1 })),
    updateSettings: vi.fn(async (patch) => ({ ...data.settings, ...patch })),
    ...overrides,
  };
  const onClose = vi.fn();
  render(<MemoryManager api={api} onClose={onClose} />);
  return { api, onClose };
}

test("shows the user their own memories and lets them add, pin, and forget", async () => {
  const { api } = harness(collection());

  expect(await screen.findByText("Prefers a short summary before the detail")).toBeInTheDocument();
  // Inferred memories are labelled so nothing appears to have been stored without cause.
  expect(screen.getByText("Learned")).toBeInTheDocument();
  expect(screen.getByText("1 memory saved")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Memory type" })).toHaveClass("memory-kind-select");

  fireEvent.change(screen.getByLabelText("Add something you want remembered"), {
    target: { value: "Always include a diagram in architecture answers" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Memory type" }), {
    target: { value: "directive" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Add/ }));

  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith({
      content: "Always include a diagram in architecture answers",
      kind: "directive",
    }),
  );
  expect(await screen.findByText("2 memories saved")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Pin: Prefers a short summary before the detail" }));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith("mem-1", { pinned: true }));

  fireEvent.click(screen.getByRole("button", { name: /Forget everything/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Yes, forget everything/ }));
  await waitFor(() => expect(api.purge).toHaveBeenCalled());
  expect(await screen.findByText("Nothing remembered yet")).toBeInTheDocument();
});

test("edits a memory in place and deletes it", async () => {
  const { api } = harness(collection());

  fireEvent.click(await screen.findByText("Prefers a short summary before the detail"));
  const input = screen.getByRole("textbox", { name: "Edit memory: Prefers a short summary before the detail" });
  fireEvent.change(input, { target: { value: "Prefers the detail first" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => expect(api.update).toHaveBeenCalledWith("mem-1", { content: "Prefers the detail first" }));
  expect(await screen.findByText("Prefers the detail first")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Forget: Prefers the detail first" }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith("mem-1"));
  expect(await screen.findByText("Nothing remembered yet")).toBeInTheDocument();
});

test("turning memory off for the account still leaves the saved list readable", async () => {
  const { api } = harness(collection());

  const settings = await screen.findByText("Use memory in my chats");
  fireEvent.click(within(settings.closest(".permission-row") as HTMLElement).getByRole("switch"));

  await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ enabled: false }));
  expect(screen.getByText("Prefers a short summary before the detail")).toBeInTheDocument();
});

test("explains why memory is unavailable and hides the personal toggles when a tier above says no", async () => {
  harness(
    collection({
      state: {
        enabled: false,
        capture_enabled: false,
        platform_enabled: true,
        tenant_enabled: false,
        group_allowed: true,
        user_enabled: true,
        reason: "Memory is turned off for your organization.",
      },
    }),
  );

  expect(await screen.findByText(/Memory is turned off for your organization\./)).toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: "Use memory in my chats" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Add/ })).toBeDisabled();
});
