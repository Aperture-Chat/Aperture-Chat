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
import { ToolLibraryManager } from "./ToolLibraryManager";

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
          id: payload.id,
          tenant_id: "tenant-example",
          name: payload.name,
          description: payload.description,
          content: payload.content,
          category: payload.category,
          variables: payload.variables,
          group_ids: payload.group_ids ?? [],
          enabled: payload.enabled,
          updated_at: "Just now",
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

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByDisplayValue("New Client Prompt"),
  ).not.toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "Open Client Update Package" }),
  );
  expect(
    screen.getByRole("dialog", { name: "Edit Client Update Package" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "New Prompt" }));
  expect(
    screen.getByRole("dialog", { name: "New Prompt Template" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Improve content" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand content" }));
  expect(screen.getByRole("dialog", { name: "Content" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Collapse content" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Prompt" }));

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
  expect(promptCreateCall).toBeTruthy();
  const promptPayload = JSON.parse(String(promptCreateCall?.[1]?.body));
  expect(promptPayload.variables).toEqual([
    "matter_name",
    "source_summary",
    "approval_owner",
  ]);
  expect(
    currentData.promptTemplates.some(
      (template) => template.name === "New Client Prompt",
    ),
  ).toBe(true);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );

  const templateList = screen.getByLabelText("Prompt Template Library items");
  fireEvent.click(
    within(templateList).getByRole("button", {
      name: "Delete Client Update Package",
    }),
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
  expect(
    screen.queryByDisplayValue("New Workflow Skill"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
  expect(
    screen.getByRole("dialog", { name: "New Skill File" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  const skillList = screen.getByLabelText("Skill File Library items");
  fireEvent.click(
    within(skillList).getByRole("button", {
      name: "Delete Client Update Package Skill",
    }),
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
});

function renderToolLibrary(mode: "template" | "skill") {
  render(<ToolLibraryHarness mode={mode} />);
}

function ToolLibraryHarness({ mode }: { mode: "template" | "skill" }) {
  const [workspaceData, setWorkspaceData] = useState(currentData);
  return (
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
  );
}
