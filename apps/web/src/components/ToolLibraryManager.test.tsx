import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData } from "../lib/types";
import { formatUpdatedAt, ToolLibraryManager } from "./ToolLibraryManager";

let currentData: BootstrapData;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  currentData = {
    ...sampleData,
    me: {
      ...sampleData.me,
      id: "user-owner",
      role: "PLATFORM_OWNER",
      display_name: "Aperture Platform Owner",
    },
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (
      url.includes("/api/admin/prompt-templates") &&
      init?.method === "POST"
    ) {
      const payload = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: payload.id ?? "template-created",
          tenant_id: "tenant-example",
          name: payload.name,
          description: payload.description,
          content: payload.content,
          category: payload.category,
          variables: payload.variables,
          group_ids: payload.group_ids ?? [],
          enabled: payload.enabled,
          updated_at: "2026-09-23T15:04:00+00:00",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (
      url.includes("/api/admin/prompt-templates/template-client-update") &&
      init?.method === "DELETE"
    ) {
      return new Response(
        JSON.stringify({ status: "deleted", id: "template-client-update" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (
      url.includes("/api/admin/skill-files/skill-client-update-package") &&
      init?.method === "DELETE"
    ) {
      return new Response(
        JSON.stringify({
          status: "deleted",
          id: "skill-client-update-package",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response("unavailable", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("tool library creates template variables and deletes library items through real APIs", async () => {
  renderToolLibrary("template");

  expect(screen.queryByRole("form")).not.toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "Open Client Update Package" }),
  );
  expect(
    screen.getByRole("form", { name: "Edit Client Update Package" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  expect(screen.queryByRole("form")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
  const form = screen.getByRole("form", { name: "New prompt" });
  // New prompts start empty: no demo content that could be saved as-is.
  expect(within(form).getByLabelText("Name")).toHaveValue("");
  expect(within(form).getByLabelText("Content")).toHaveValue("");
  expect(within(form).getByRole("button", { name: "Save prompt" })).toBeDisabled();
  expect(within(form).getByRole("button", { name: /Improve with AI/ })).toBeInTheDocument();
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Client Update" } });
  fireEvent.change(within(form).getByLabelText("Content"), {
    target: {
      value:
        "Prepare a client update for {{matter_name}} using {{source_summary}} and flag {{approval_owner}} before sending.",
    },
  });
  expect(within(form).getByLabelText("Detected template variables")).toHaveTextContent("{{matter_name}}");
  fireEvent.click(within(form).getByRole("button", { name: "Save prompt" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/prompt-templates"),
      expect.objectContaining({ method: "POST" }),
    ),
  );
  const promptCreateCall = fetchMock.mock.calls.find(
    ([input, init]) =>
      String(input).includes("/api/admin/prompt-templates") &&
      init?.method === "POST",
  );
  const promptPayload = JSON.parse(String(promptCreateCall?.[1]?.body));
  expect(promptPayload.variables).toEqual([
    "matter_name",
    "source_summary",
    "approval_owner",
  ]);
  expect(promptPayload.category).toBe("general");
  expect(promptPayload.group_ids).toEqual([]);
  expect(
    currentData.promptTemplates.some(
      (template) => template.name === "Client Update",
    ),
  ).toBe(true);
  await waitFor(() =>
    expect(screen.queryByRole("form")).not.toBeInTheDocument(),
  );
  // Real timestamps render as a date on the card.
  expect(screen.getByRole("article", { name: "Client Update" })).toHaveTextContent("Updated Sep 23, 2026");

  fireEvent.click(
    screen.getByRole("button", { name: "More actions for Client Update Package" }),
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Delete Client Update Package" }),
  );
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/admin/prompt-templates/template-client-update",
      ),
      expect.objectContaining({ method: "DELETE" }),
    ),
  );
  expect(
    currentData.promptTemplates.some(
      (template) => template.id === "template-client-update",
    ),
  ).toBe(false);
  expect(
    currentData.models.find((model) => model.id === "agent-client-update")
      ?.prompt_template_ids,
  ).not.toContain("template-client-update");

  cleanup();
  renderToolLibrary("skill");
  fireEvent.click(screen.getByRole("button", { name: "New skill" }));
  const skillForm = screen.getByRole("form", { name: "New skill" });
  expect(within(skillForm).getByLabelText("Name")).toHaveValue("");
  expect(within(skillForm).getByLabelText("Content")).toHaveValue("");
  fireEvent.click(within(skillForm).getByRole("button", { name: "Cancel" }));

  fireEvent.click(
    screen.getByRole("button", { name: "More actions for Client Update Package Skill" }),
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Delete Client Update Package Skill" }),
  );
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/admin/skill-files/skill-client-update-package",
      ),
      expect.objectContaining({ method: "DELETE" }),
    ),
  );
  expect(
    currentData.skillFiles.some(
      (skill) => skill.id === "skill-client-update-package",
    ),
  ).toBe(false);
  expect(
    currentData.models.find((model) => model.id === "agent-client-update")
      ?.skill_file_ids,
  ).not.toContain("skill-client-update-package");

  expect(screen.getByRole("status")).toHaveClass(
    "ws-notice",
    "tool-library-action-status",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Client Update Package Skill was deleted.",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss notification" }),
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});


test.each(["template", "skill"] as const)("failed %s saves preserve draft content and allow retry", async (mode) => {
  renderToolLibrary(mode);
  fireEvent.click(screen.getByRole("button", { name: mode === "template" ? "New prompt" : "New skill" }));
  const form = screen.getByRole("form");
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Keep my work" } });
  fireEvent.change(within(form).getByLabelText("Content"), { target: { value: "Carefully written instructions {{topic}}" } });
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Service unavailable" }), { status: 503 }));
  fireEvent.click(within(form).getByRole("button", { name: mode === "template" ? "Save prompt" : "Save skill" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your changes are still here");
  expect(within(screen.getByRole("form")).getByLabelText("Name")).toHaveValue("Keep my work");
  expect(within(screen.getByRole("form")).getByLabelText("Content")).toHaveValue("Carefully written instructions {{topic}}");

  fetchMock.mockImplementationOnce(async (_input, init) => new Response(JSON.stringify({
    ...JSON.parse(String(init?.body)), id: "created", tenant_id: "tenant-example", updated_at: "2026-09-23T10:00:00Z",
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: mode === "template" ? "Save prompt" : "Save skill" }));
  await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("Keep my work saved");
});

test.each(["template", "skill"] as const)("editing %s content preserves access and release metadata", async (mode) => {
  const original = mode === "template" ? currentData.promptTemplates[0] : currentData.skillFiles[0];
  const restricted = { ...original, group_ids: ["group-restricted"], enabled: false, ...(mode === "skill" ? { version: "3.2.1", format: "text" } : {}) };
  if (mode === "template") currentData = { ...currentData, promptTemplates: [restricted as BootstrapData["promptTemplates"][number]] };
  else currentData = { ...currentData, skillFiles: [restricted as BootstrapData["skillFiles"][number]] };
  fetchMock.mockImplementationOnce(async (_input, init) => new Response(JSON.stringify({
    ...restricted, ...JSON.parse(String(init?.body)),
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  renderToolLibrary(mode);
  fireEvent.click(screen.getByRole("button", { name: `Open ${original.name}` }));
  fireEvent.change(screen.getByLabelText("Content"), { target: { value: "Updated instructions" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
  const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(payload).not.toHaveProperty("group_ids");
  expect(payload).not.toHaveProperty("enabled");
  expect(payload).not.toHaveProperty("version");
  expect(payload).not.toHaveProperty("format");
  const saved = mode === "template" ? currentData.promptTemplates[0] : currentData.skillFiles[0];
  expect(saved).toMatchObject({ content: "Updated instructions", group_ids: ["group-restricted"], enabled: false });
  if (mode === "skill") expect(saved).toMatchObject({ version: "3.2.1", format: "text" });
});

test.each(["template", "skill"] as const)("%s library is read-only for roles the API rejects", (mode) => {
  currentData = {
    ...currentData,
    me: { ...sampleData.users.find((user) => user.id === "user-jane")!, role: "USER" },
    // A granted self-author still can't write the shared library.
    authoringState: { knowledge_enabled: true, tools_enabled: true },
  };
  renderToolLibrary(mode);
  expect(screen.queryByRole("button", { name: /New (prompt|skill)/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /More actions for/ })).not.toBeInTheDocument();
  const first = mode === "template" ? currentData.promptTemplates[0] : currentData.skillFiles[0];
  const open = screen.getByRole("button", { name: `Open ${first.name}` });
  expect(open).toHaveTextContent("View");
  fireEvent.click(open);
  const form = screen.getByRole("form", { name: `View ${first.name}` });
  expect(within(form).getByLabelText("Content")).toHaveAttribute("readonly");
  expect(within(form).queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
  expect(within(form).queryByRole("button", { name: /Improve with AI/ })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("improving a prompt shows an indeterminate indicator and can be undone", async () => {
  let release: (value: Response) => void = () => {};
  fetchMock.mockImplementationOnce(
    () => new Promise<Response>((resolve) => { release = resolve; }),
  );
  renderToolLibrary("template");
  fireEvent.click(screen.getByRole("button", { name: "Open Client Update Package" }));
  const originalContent = (screen.getByLabelText("Content") as HTMLTextAreaElement).value;
  fireEvent.click(screen.getByRole("button", { name: /Improve with AI/ }));
  const progress = await screen.findByRole("progressbar", { name: "Improving content" });
  // No invented percentage: the rewrite has no measurable progress.
  expect(progress).not.toHaveAttribute("aria-valuenow");
  release(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Sharper prompt for {{matter}}." } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  await waitFor(() => expect(screen.getByLabelText("Content")).toHaveValue("Sharper prompt for {{matter}}."));
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Restore original/ }));
  expect(screen.getByLabelText("Content")).toHaveValue(originalContent);
});

test("long content warns that agents only receive the first 4,000 characters", () => {
  renderToolLibrary("skill");
  fireEvent.click(screen.getByRole("button", { name: "New skill" }));
  fireEvent.change(screen.getByLabelText("Content"), { target: { value: "word ".repeat(900) } });
  expect(screen.getByText(/only see the first 4,000 characters/)).toBeInTheDocument();
});

test("placeholder timestamps are not shown as real times", () => {
  expect(formatUpdatedAt("Just now")).toBeNull();
  expect(formatUpdatedAt("Seeded today")).toBeNull();
  expect(formatUpdatedAt("2026-09-23T15:04:00+00:00")).toMatch(/2026/);
});

function renderToolLibrary(mode: "template" | "skill") {
  render(<ToolLibraryHarness mode={mode} />);
}

function ToolLibraryHarness({ mode }: { mode: "template" | "skill" }) {
  const [workspaceData, setWorkspaceData] = useState(currentData);
  return (
    <div className="library-page">
      <ToolLibraryManager
        mode={mode}
        data={workspaceData}
        onDataChange={(updater) => {
          setWorkspaceData((current) => {
            const next = updater(current);
            currentData = next;
            return next;
          });
        }}
      />
    </div>
  );
}
