import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getDraft } from "../lib/api/drafts";
import type { GlobalSearchResponse } from "../lib/api/search";
import { globalSearch } from "../lib/api/search";
import type { ChatThread } from "../lib/types";
import { CommandPalette, SEARCH_DEBOUNCE_MS, type PaletteFolderOption } from "./CommandPalette";

vi.mock("../lib/api/search", () => ({
  globalSearch: vi.fn(),
}));

vi.mock("../lib/api/drafts", () => ({
  getDraft: vi.fn(),
}));

const mockedSearch = vi.mocked(globalSearch);
const mockedGetDraft = vi.mocked(getDraft);

beforeEach(() => {
  mockedSearch.mockReset();
  mockedGetDraft.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function paletteThread(id: string, title: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    tenant_id: "tenant-example",
    owner_user_id: "user-admin",
    title,
    model_id: "openrouter-openai-gpt-4o-mini",
    group_id: "group-litigation",
    pinned: false,
    archived: false,
    folder_id: null,
    used_agent: false,
    updated_at: "Just now",
    messages: [
      { id: `${id}-prompt`, role: "user", content: "What is our retention policy?", createdAt: "9:00 AM", status: "ok" },
      { id: `${id}-reply`, role: "assistant", content: "Retention runs seven years.", createdAt: "9:01 AM", status: "ok" },
    ],
    ...overrides,
  };
}

function searchResponse(): GlobalSearchResponse {
  return {
    query: "policy",
    sections: [
      {
        kind: "chat",
        title: "Previous chats",
        results: [
          {
            id: "thread-policy",
            kind: "chat",
            title: "Quarterly policy review",
            snippet: "…retention policy applies for seven years…",
            score: 6,
            navigation: { view: "chat", thread_id: "thread-policy" },
            metadata: { archived: true },
          },
        ],
      },
      {
        kind: "draft",
        title: "Drafts",
        results: [
          {
            id: "draft-9",
            kind: "draft",
            title: "Policy rollout memo",
            snippet: "Rollout policy summary",
            score: 4,
            navigation: { view: "drafts", draft_id: "draft-9" },
            metadata: {},
          },
        ],
      },
      // Empty backend sections must stay absent from the palette.
      { kind: "matter", title: "Matters", results: [] },
    ],
  };
}

function renderPalette(
  overrides: {
    onNavigateReturns?: boolean;
    threads?: ChatThread[];
    folders?: PaletteFolderOption[];
  } = {},
) {
  const onClose = vi.fn();
  const onNavigate = vi.fn().mockReturnValue(overrides.onNavigateReturns ?? true);
  const onTogglePin = vi.fn();
  const onArchiveThread = vi.fn();
  const onRestoreThread = vi.fn();
  const onMoveThreadToFolder = vi.fn();
  const utils = render(
    <CommandPalette
      userId="user-admin"
      tenantSlug="new-organization"
      onNavigate={onNavigate}
      onClose={onClose}
      threads={overrides.threads}
      folders={overrides.folders}
      onTogglePin={onTogglePin}
      onArchiveThread={onArchiveThread}
      onRestoreThread={onRestoreThread}
      onMoveThreadToFolder={onMoveThreadToFolder}
    />,
  );
  return {
    onClose,
    onNavigate,
    onTogglePin,
    onArchiveThread,
    onRestoreThread,
    onMoveThreadToFolder,
    ...utils,
  };
}

test("empty query explains conversation retrieval and never duplicates navigation actions", () => {
  renderPalette();

  expect(screen.getByText("Find something from a previous conversation")).toBeInTheDocument();
  expect(screen.getByText(/Archived chats are included/)).toBeInTheDocument();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
  expect(mockedSearch).not.toHaveBeenCalled();
});

test("Escape and the backdrop both close the palette", () => {
  const { onClose } = renderPalette();

  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Close search" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("remote search is debounced and coalesces rapid keystrokes into one request", async () => {
  vi.useFakeTimers();
  mockedSearch.mockResolvedValue(searchResponse());
  renderPalette();
  const input = screen.getByRole("combobox");

  fireEvent.change(input, { target: { value: "pol" } });
  act(() => {
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
  });
  expect(mockedSearch).not.toHaveBeenCalled();
  // A subtle honest loading state, never sample results.
  expect(screen.getByText("Searching…")).toBeInTheDocument();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();

  fireEvent.change(input, { target: { value: "policy" } });
  act(() => {
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
  });
  expect(mockedSearch).not.toHaveBeenCalled();

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(mockedSearch).toHaveBeenCalledTimes(1);
  expect(mockedSearch).toHaveBeenCalledWith("user-admin", "policy", 8, {
    signal: expect.any(AbortSignal),
    tenantSlug: "new-organization",
  });

  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText("Previous chats")).toBeInTheDocument();
  expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
});

test("backend section labels render verbatim and empty sections stay absent", async () => {
  mockedSearch.mockResolvedValue(searchResponse());
  renderPalette();

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "policy" } });

  expect(await screen.findByText("Previous chats")).toBeInTheDocument();
  expect(screen.getByText("Drafts")).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: /Quarterly policy review.*Archived conversation/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Policy rollout memo/ })).toBeInTheDocument();
  // The empty Matters section stays absent and shell navigation is never duplicated.
  expect(screen.queryByText("Matters")).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Go to" })).not.toBeInTheDocument();
});

test("clicking a result fires onNavigate with the backend navigation object and closes", async () => {
  mockedSearch.mockResolvedValue(searchResponse());
  const { onNavigate, onClose } = renderPalette();

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "policy" } });
  fireEvent.click(await screen.findByRole("option", { name: /Quarterly policy review/ }));

  expect(onNavigate).toHaveBeenCalledWith({ view: "chat", thread_id: "thread-policy" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a result the build cannot route stays open with an honest notice", async () => {
  mockedSearch.mockResolvedValue(searchResponse());
  const { onNavigate, onClose } = renderPalette({ onNavigateReturns: false });

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "policy" } });
  fireEvent.click(await screen.findByRole("option", { name: /Policy rollout memo/ }));

  expect(onNavigate).toHaveBeenCalledWith({ view: "drafts", draft_id: "draft-9" });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText(/has no screen in this build yet/)).toBeInTheDocument();
});

test("chat results carry pin, archive, and folder actions backed by the live thread", async () => {
  mockedSearch.mockResolvedValue(searchResponse());
  const thread = paletteThread("thread-policy", "Quarterly policy review", { folder_id: "folder-1" });
  const { onTogglePin, onArchiveThread, onMoveThreadToFolder } = renderPalette({
    threads: [thread],
    folders: [{ id: "folder-ops", name: "Operations", depth: 0 }],
  });

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "policy" } });
  await screen.findByRole("option", { name: /Quarterly policy review/ });

  fireEvent.click(screen.getByRole("button", { name: "Pin Quarterly policy review" }));
  expect(onTogglePin).toHaveBeenCalledWith("thread-policy");

  fireEvent.click(screen.getByRole("button", { name: "Archive Quarterly policy review" }));
  expect(onArchiveThread).toHaveBeenCalledWith("thread-policy");

  fireEvent.click(screen.getByRole("button", { name: "Add Quarterly policy review to a folder" }));
  fireEvent.click(screen.getByRole("button", { name: "Operations" }));
  expect(onMoveThreadToFolder).toHaveBeenCalledWith("thread-policy", "folder-ops");

  // A chat already filed in a folder can also be taken back out.
  fireEvent.click(screen.getByRole("button", { name: "Add Quarterly policy review to a folder" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove from folder" }));
  expect(onMoveThreadToFolder).toHaveBeenCalledWith("thread-policy", null);
});

test("an archived chat result offers restore instead of archive", async () => {
  mockedSearch.mockResolvedValue(searchResponse());
  const thread = paletteThread("thread-policy", "Quarterly policy review", { archived: true });
  const { onRestoreThread } = renderPalette({ threads: [thread] });

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "policy" } });
  await screen.findByRole("option", { name: /Quarterly policy review/ });

  expect(screen.queryByRole("button", { name: "Archive Quarterly policy review" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Restore Quarterly policy review" }));
  expect(onRestoreThread).toHaveBeenCalledWith("thread-policy");
});

test("focusing a chat result opens the same conversation preview as the sidebar", async () => {
  mockedSearch.mockResolvedValue(searchResponse());
  const thread = paletteThread("thread-policy", "Quarterly policy review");
  renderPalette({ threads: [thread] });

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "policy" } });
  const option = await screen.findByRole("option", { name: /Quarterly policy review/ });

  fireEvent.focus(option);
  const preview = await screen.findByRole("tooltip");
  expect(preview).toHaveTextContent("Chat preview");
  expect(preview).toHaveTextContent("What is our retention policy?");
  expect(preview).toHaveTextContent("Retention runs seven years.");
});

test("focusing a draft result fetches and previews the saved document", async () => {
  mockedSearch.mockResolvedValue(searchResponse());
  mockedGetDraft.mockResolvedValue({
    document: {
      id: "draft-9",
      tenant_id: "tenant-example",
      owner_user_id: "user-admin",
      matter_id: null,
      title: "Policy rollout memo",
      current_revision: 3,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "Aug 6, 2026",
    },
    revision: {
      draft_id: "draft-9",
      revision: 3,
      title: "Policy rollout memo",
      content: "<h1>Policy rollout memo</h1><p>Phase one starts in September.</p>",
      content_sha256: "abc",
      sanitizer_version: 1,
      created_at: "2026-08-06T00:00:00Z",
    },
  } as never);
  renderPalette();

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "policy" } });
  const option = await screen.findByRole("option", { name: /Policy rollout memo/ });

  fireEvent.focus(option);
  await waitFor(() =>
    expect(mockedGetDraft).toHaveBeenCalledWith("user-admin", "draft-9", {
      tenantSlug: "new-organization",
    }),
  );
  const preview = await screen.findByRole("tooltip");
  expect(preview).toHaveTextContent("Draft preview");
  await waitFor(() => expect(preview).toHaveTextContent("Phase one starts in September."));
  expect(preview).toHaveTextContent("Click to open in the Drafter");
});

test("a query without matches shows an honest empty line instead of placeholders", async () => {
  mockedSearch.mockResolvedValue({
    query: "zzz",
    sections: [
      { kind: "chat", title: "Chats", results: [] },
      { kind: "knowledge", title: "Knowledge", results: [] },
    ],
  });
  renderPalette();

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });

  expect(await screen.findByText("No chats or workspace items found for “zzz”.")).toBeInTheDocument();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.queryByText("Previous chats")).not.toBeInTheDocument();
});

test("arrow keys move through retrieved work and Enter opens the selected result", async () => {
  mockedSearch.mockResolvedValue(searchResponse());
  const { onNavigate, onClose } = renderPalette();
  const input = screen.getByRole("combobox");

  fireEvent.change(input, { target: { value: "policy" } });
  expect(await screen.findByRole("option", { name: /Quarterly policy review/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Policy rollout memo/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  fireEvent.keyDown(input, { key: "Enter" });
  expect(onNavigate).toHaveBeenCalledWith({ view: "drafts", draft_id: "draft-9" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a failed search reports the real error instead of fake results", async () => {
  mockedSearch.mockRejectedValue(new Error("Matter and draft search is temporarily unavailable."));
  renderPalette();

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "policy" } });

  expect(
    await screen.findByText("Matter and draft search is temporarily unavailable."),
  ).toBeInTheDocument();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});
