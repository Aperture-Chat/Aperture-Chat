import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { recordApiFailure, resetDiagnosticsForTests } from "../lib/diagnostics";
import type {
  IssueReportDetail,
  IssueReportListItem,
  IssueReportQueue,
  IssueReportUpstreamDraft,
  SupportHubReport,
  SupportSettings,
} from "../lib/types";
import { IssueReportForm } from "./IssueReportForm";
import { MyReportsPanel, type MyReportsApi } from "./MyReportsPanel";
import { RailSwitch } from "./RailSwitch";
import { SupportTicketsConsole, type SupportTicketsApi } from "./SupportTicketsConsole";

const NOW = "2026-10-21T15:00:00Z";

function ticket(overrides: Partial<IssueReportListItem> = {}): IssueReportListItem {
  return {
    id: "issue-1",
    tenant_id: "tenant-example",
    tenant_name: "Example Corporation",
    user_id: "user-jane",
    user_name: "Jane Smith",
    number: 4,
    kind: "bug",
    priority: "normal",
    status: "in_review",
    subject: "Export freezes",
    body: "Export stays on Preparing.",
    created_at: NOW,
    updated_at: NOW,
    last_activity_by: "support",
    unread: false,
    upstream: null,
    ...overrides,
  };
}

function detail(report: IssueReportListItem, events: IssueReportDetail["events"] = []): IssueReportDetail {
  return { report, events };
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetDiagnosticsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Report form ---------------------------------------------------------------

test("report form sends type, impact, and only the details the person allows", async () => {
  recordApiFailure("post", "/api/chat/thread-1/messages?x=1", 500);
  const onSubmit = vi.fn(async () => ({ ...ticket(), id: "issue-9", number: 9 }));
  const onViewReport = vi.fn();
  render(<IssueReportForm onSubmit={onSubmit} onViewReport={onViewReport} />);

  fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
  expect(screen.queryByRole("radiogroup", { name: "Impact" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Subject")).toHaveAttribute("placeholder", "What would you like to be able to do?");
  fireEvent.click(screen.getByRole("button", { name: /What's included/ }));
  expect(screen.getByText("POST /api/chat/thread-1/messages → 500")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Bulk export" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Export several chats at once." } });
  fireEvent.click(screen.getByLabelText("Include technical details"));
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));

  expect(await screen.findByText("Report #9 sent")).toBeInTheDocument();
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "feature", priority: "normal", diagnostics: null, subject: "Bulk export" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /View status/ }));
  expect(onViewReport).toHaveBeenCalledWith("issue-9");
  expect(window.sessionStorage.getItem("aperture.issue-report-draft")).toBeNull();
});

test("report form keeps a draft, warns on security, and accepts a pasted screenshot", () => {
  const { unmount } = render(<IssueReportForm onSubmit={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Security" }));
  expect(screen.getByRole("note")).toHaveTextContent("never posted publicly");
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Half-written" } });
  unmount();

  render(<IssueReportForm onSubmit={vi.fn()} />);
  expect(screen.getByLabelText("Subject")).toHaveValue("Half-written");
  expect(screen.getByRole("radio", { name: "Security" })).toHaveAttribute("aria-checked", "true");

  const image = new File(["png"], "paste.png", { type: "image/png" });
  fireEvent.paste(screen.getByLabelText("Subject").closest("form")!, {
    clipboardData: { items: [{ type: "image/png", getAsFile: () => image }] },
  });
  expect(screen.getByText("paste.png")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove screenshot" }));
  expect(screen.queryByText("paste.png")).not.toBeInTheDocument();
});

test("report form rejects oversized and unsupported screenshots", () => {
  render(<IssueReportForm onSubmit={vi.fn()} />);
  const input = screen.getByLabelText("Screenshot (optional)");
  fireEvent.change(input, { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
  expect(screen.getByRole("alert")).toHaveTextContent("Choose a PNG, JPEG, GIF, or WebP image.");
  const huge = new File(["x"], "huge.png", { type: "image/png" });
  Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
  fireEvent.change(input, { target: { files: [huge] } });
  expect(screen.getByRole("alert")).toHaveTextContent("10 MB or smaller");
});

// --- My reports ------------------------------------------------------------------

function myReportsApi(overrides: Partial<MyReportsApi> = {}): MyReportsApi {
  const open = ticket({ unread: true, last_activity_by: "support" });
  const resolved = ticket({
    id: "issue-2",
    number: 2,
    status: "resolved",
    subject: "Old login loop",
    upstream: {
      state: "published",
      hub_url: "https://hub.example",
      issue_number: 42,
      issue_url: "https://github.com/Aperture-Chat/Aperture-Chat/issues/42",
      issue_state: "closed",
      issue_state_reason: "completed",
      shared_by_name: "",
      sent_title: "",
      sent_body: "",
      attempts: 0,
      queued_at: NOW,
    },
  });
  return {
    list: vi.fn(async () => [open, resolved]),
    get: vi.fn(async (reportId: string) =>
      reportId === "issue-1"
        ? detail(open, [
            {
              id: "e1",
              report_id: "issue-1",
              kind: "comment",
              visibility: "public",
              actor_name: "Support team",
              actor_kind: "support",
              body: "Which browser are you using?",
              created_at: NOW,
            },
          ])
        : detail(resolved),
    ),
    markSeen: vi.fn(async () => undefined),
    reply: vi.fn(async () => detail({ ...open, unread: false, last_activity_by: "reporter" })),
    reopen: vi.fn(async () => detail({ ...resolved, status: "new" })),
    loadScreenshot: vi.fn(async () => new Blob()),
    ...overrides,
  };
}

test("my reports shows status, marks replies seen, and lets the reporter answer", async () => {
  const api = myReportsApi();
  const onUnreadChange = vi.fn();
  render(<MyReportsPanel api={api} onNewReport={vi.fn()} onUnreadChange={onUnreadChange} />);

  const list = await screen.findByRole("list", { name: "Your reports" });
  expect(within(list).getAllByRole("button")).toHaveLength(1);
  expect(onUnreadChange).toHaveBeenCalledWith(1);
  fireEvent.click(within(list).getByRole("button", { name: /#4 Export freezes, new reply/ }));

  expect(await screen.findByText("Which browser are you using?")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Progress" }).querySelector("[aria-current='step']")).toHaveTextContent(
    "In review",
  );
  await waitFor(() => expect(api.markSeen).toHaveBeenCalledWith("issue-1"));
  expect(onUnreadChange).toHaveBeenLastCalledWith(0);

  fireEvent.change(screen.getByLabelText("Add a reply"), { target: { value: "Chrome on macOS" } });
  fireEvent.click(screen.getByRole("button", { name: /Send reply/ }));
  await waitFor(() => expect(api.reply).toHaveBeenCalledWith("issue-1", "Chrome on macOS"));
});

test("closed reports show the GitHub outcome and can be reopened", async () => {
  const api = myReportsApi();
  render(<MyReportsPanel api={api} focusReportId="issue-2" onNewReport={vi.fn()} />);

  expect(await screen.findByText("Tracked on GitHub")).toBeInTheDocument();
  expect(screen.getByText(/#42 fixed/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /GitHub/ })).toHaveAttribute(
    "href",
    "https://github.com/Aperture-Chat/Aperture-Chat/issues/42",
  );
  fireEvent.click(screen.getByRole("button", { name: /Reopen report/ }));
  await waitFor(() => expect(api.reopen).toHaveBeenCalledWith("issue-2", ""));
});

// --- Console -----------------------------------------------------------------------

function queue(items: IssueReportListItem[]): IssueReportQueue {
  return { items, counts: {}, assignees: [{ id: "user-admin", name: "Alex Morgan" }] };
}

function consoleApi(overrides: Partial<SupportTicketsApi> = {}): SupportTicketsApi {
  const waiting = ticket({ id: "issue-3", number: 3, subject: "Login loop", status: "new", last_activity_by: "reporter" });
  const working = ticket();
  return {
    queue: vi.fn(async () => queue([waiting, working])),
    get: vi.fn(async (reportId: string) => detail(reportId === "issue-3" ? waiting : working)),
    update: vi.fn(async (_id: string, patch) => detail({ ...waiting, ...patch } as IssueReportListItem)),
    comment: vi.fn(async () => detail(waiting)),
    loadScreenshot: vi.fn(async () => new Blob()),
    ...overrides,
  };
}

test("admin queue filters to reports waiting on support and updates a ticket", async () => {
  const api = consoleApi();
  render(<SupportTicketsConsole variant="admin" api={api} />);

  fireEvent.click(await screen.findByRole("radio", { name: /Needs reply 1/ }));
  const list = screen.getByRole("region", { name: "Reports" });
  expect(within(list).getAllByRole("button")).toHaveLength(1);
  fireEvent.click(within(list).getByRole("button", { name: /#3 Login loop/ }));

  const panel = screen.getByRole("region", { name: "Selected report" });
  fireEvent.change(await within(panel).findByLabelText("Status"), { target: { value: "in_progress" } });
  await waitFor(() => expect(api.update).toHaveBeenCalledWith("issue-3", { status: "in_progress" }));
  expect(within(panel).queryByRole("button", { name: /Share with maintainers/ })).not.toBeInTheDocument();

  fireEvent.click(within(panel).getByRole("radio", { name: /Internal note/ }));
  fireEvent.change(within(panel).getByLabelText("Internal note"), { target: { value: "Likely SSO." } });
  fireEvent.click(within(panel).getByRole("button", { name: /Add note/ }));
  await waitFor(() =>
    expect(api.comment).toHaveBeenCalledWith("issue-3", { body: "Likely SSO.", visibility: "internal" }),
  );
});

const draft: IssueReportUpstreamDraft = {
  title: "Login loop after ⟦NAME⟧ signs in",
  body: "Signing in returns to the login page.",
  labels: ["bug"],
  diagnostics: { app_version: "0.5.13" },
  preview_markdown: "Signing in returns to the login page.\n\n---",
  redaction_count: 2,
  ai_drafted: false,
  github_new_issue_url: "https://github.com/Aperture-Chat/Aperture-Chat/issues/new?template=bug_report.yml",
  hub_url: "https://chat.aperturechat.com",
  hub_available: true,
};

test("owner reviews the redacted draft before sharing with the maintainers", async () => {
  const shareUpstream = vi.fn(async () =>
    detail(
      ticket({
        id: "issue-3",
        upstream: {
          state: "sent",
          hub_url: "https://chat.aperturechat.com",
          shared_by_name: "Owner",
          sent_title: draft.title,
          sent_body: draft.body,
          attempts: 1,
          queued_at: NOW,
          sent_at: NOW,
        },
      }),
    ),
  );
  const api = consoleApi({
    draftUpstream: vi.fn(async () => draft),
    shareUpstream,
    refreshUpstream: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  });
  render(<SupportTicketsConsole variant="owner" api={api} />);

  fireEvent.click(await screen.findByRole("button", { name: /#3 Login loop/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Share with maintainers/ }));
  const dialog = await screen.findByRole("dialog", { name: "Share with the Aperture Chat maintainers" });
  expect(await within(dialog).findByLabelText("Issue title")).toHaveValue(draft.title);
  expect(within(dialog).getByText(/2 values were replaced/)).toBeInTheDocument();
  expect(within(dialog).getByRole("link", { name: /prefilled GitHub issue/ })).toHaveAttribute(
    "href",
    draft.github_new_issue_url,
  );
  fireEvent.change(within(dialog).getByLabelText("Issue title"), { target: { value: "Login loop after sign-in" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /Send to maintainers/ }));

  await waitFor(() =>
    expect(shareUpstream).toHaveBeenCalledWith("issue-3", {
      title: "Login loop after sign-in",
      body: draft.body,
      include_diagnostics: true,
    }),
  );
  expect(await screen.findByText(/With the maintainers/)).toBeInTheDocument();
});

const settings: SupportSettings = {
  upstream_mode: "review",
  instance_id: "0f0e0d0c-aaaa-bbbb-cccc-121212121212",
  notify_reporters: true,
  hub_url: "https://chat.aperturechat.com",
  hub_is_self: false,
  email_configured: false,
  hub_enabled: true,
  hub_repository: "Aperture-Chat/Aperture-Chat",
  hub_auto_publish: false,
  hub_ai_triage: true,
  hub_token_set: false,
  hub_masked_token: "",
  model_options: [{ id: "model-a", name: "Model A" }],
};

test("owner settings save the sharing mode and a write-only GitHub token", async () => {
  const updateSettings = vi.fn(async (patch) => ({ ...settings, ...patch, hub_token_set: Boolean(patch.hub_github_token) || settings.hub_token_set }));
  const api = consoleApi({ getSettings: vi.fn(async () => settings), updateSettings });
  render(<SupportTicketsConsole variant="owner" api={api} />);

  fireEvent.click(screen.getByRole("radio", { name: "Settings" }));
  fireEvent.click(await screen.findByRole("radio", { name: /Share automatically/ }));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ upstream_mode: "automatic" }));
  expect(screen.getByText(/Email isn't set up yet/)).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText("github_pat_…"), { target: { value: "github_pat_example" } });
  fireEvent.click(screen.getByRole("button", { name: "Save token" }));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ hub_github_token: "github_pat_example" }));
});

test("community hub publishes a reviewed report with chosen labels", async () => {
  const pending: SupportHubReport = {
    id: "hubreport-1",
    instance_id: "instance-1234abcd",
    instance_version: "0.5.13",
    kind: "bug",
    priority: "normal",
    title: "PDF export hangs",
    body: "Selecting PDF never finishes.",
    status: "pending",
    triage: {
      summary: "PDF export hangs on large chats.",
      suggested_title: "PDF export never finishes on large chats",
      labels: ["bug"],
      spam_likelihood: 0.05,
      candidates: [{ number: 7, title: "PDF export slow", state: "open", url: "https://github.com/Aperture-Chat/Aperture-Chat/issues/7" }],
    },
    received_at: NOW,
    updated_at: NOW,
    instance_report_count: 3,
  };
  const publish = vi.fn(async () => ({ ...pending, status: "published" as const, issue_number: 51, issue_url: "https://github.com/Aperture-Chat/Aperture-Chat/issues/51" }));
  const hub = {
    list: vi.fn(async () => ({ items: [pending], counts: { pending: 1, all: 1 } })),
    preview: vi.fn(async () => ({ markdown: "preview" })),
    publish,
    link: vi.fn(),
    decline: vi.fn(),
    requeue: vi.fn(),
    triage: vi.fn(),
    sync: vi.fn(),
    check: vi.fn(),
  };
  render(<SupportTicketsConsole variant="owner" api={consoleApi({ getSettings: vi.fn(), updateSettings: vi.fn(), hub })} />);

  fireEvent.click(screen.getByRole("radio", { name: /Community hub/ }));
  fireEvent.click(await screen.findByRole("button", { name: "PDF export hangs" }));
  expect(screen.getByText("PDF export hangs on large chats.")).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).toHaveValue("PDF export never finishes on large chats");
  fireEvent.click(screen.getByLabelText("documentation"));
  fireEvent.click(screen.getByRole("button", { name: /Publish issue/ }));
  await waitFor(() =>
    expect(publish).toHaveBeenCalledWith("hubreport-1", {
      title: "PDF export never finishes on large chats",
      body: "Selecting PDF never finishes.",
      labels: ["bug", "documentation"],
    }),
  );
  expect(await screen.findByText(/GitHub issue #51/)).toBeInTheDocument();
});

test("rail switch moves the selection with arrow keys like the Drafts toggle", () => {
  const onChange = vi.fn();
  render(
    <RailSwitch
      ariaLabel="Show reports"
      value="open"
      onChange={onChange}
      options={[
        { value: "open", label: "Open", count: 2 },
        { value: "closed", label: "Closed", count: 1 },
        { value: "all", label: "All", count: 3 },
      ]}
    />,
  );
  const group = screen.getByRole("radiogroup", { name: "Show reports" });
  expect(group).toHaveStyle({ "--rail-count": "3", "--rail-index": "0" });
  expect(screen.getByRole("radio", { name: "Open 2" })).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(group, { key: "ArrowRight" });
  expect(onChange).toHaveBeenLastCalledWith("closed");
  fireEvent.keyDown(group, { key: "End" });
  expect(onChange).toHaveBeenLastCalledWith("all");
  fireEvent.click(screen.getByRole("radio", { name: "All 3" }));
  expect(onChange).toHaveBeenLastCalledWith("all");
});
