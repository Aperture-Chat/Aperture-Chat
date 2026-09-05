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
import { AgentWorkspaceConsole } from "./AgentWorkspaceConsole";

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
    if (
      url.includes("/api/admin/agent-profiles/") &&
      init?.method === "DELETE"
    ) {
      const id = url.split("/api/admin/agent-profiles/")[1] ?? "unknown-agent";
      return new Response(
        JSON.stringify({ status: "deleted", id }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (
      url.includes("/api/admin/model-access-sync") &&
      init?.method === "POST"
    ) {
      const existingModel = currentData.models.find(
        (model) => model.id === "openrouter-openai-gpt-4o-mini",
      );
      const syncedModel = {
        ...(existingModel ?? currentData.models[0]),
        id: "openrouter-new-dynamic-model",
        name: "OpenRouter: New Dynamic Model",
        provider_id: "provider-openrouter",
        provider_name: "OpenRouter",
        upstream_model_id: "openrouter/new-dynamic-model",
        platform_enabled: true,
        is_custom: false,
        created_by: undefined,
        meta_prompt: undefined,
        system_prompt: undefined,
        knowledge_base_ids: [],
        tool_ids: [],
        knowledge_config_ids: [],
        tool_config_ids: [],
        prompt_template_ids: [],
        skill_file_ids: [],
        agentic_companion: null,
        group_ids: [],
      };
      const approvedSyncedModel = {
        ...(existingModel ?? currentData.models[0]),
        id: "openrouter-approved-agent-base",
        name: "OpenRouter: Approved Agent Base",
        provider_id: "provider-openrouter",
        provider_name: "OpenRouter",
        upstream_model_id: "openrouter/approved-agent-base",
        platform_enabled: true,
        is_custom: false,
        created_by: undefined,
        meta_prompt: undefined,
        system_prompt: undefined,
        knowledge_base_ids: [],
        tool_ids: [],
        knowledge_config_ids: [],
        tool_config_ids: [],
        prompt_template_ids: [],
        skill_file_ids: [],
        agentic_companion: null,
        group_ids: ["group-litigation"],
      };
      return new Response(
        JSON.stringify([...currentData.models, syncedModel, approvedSyncedModel]),
        { status: 200, headers: { "Content-Type": "application/json" } },
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

test("agent workspace hides profile editing until Edit is clicked", async () => {
  renderAgentWorkspace();

  expect(
    screen.getByRole("heading", { name: "Agent Profiles" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Edit Agent Profile" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save Profile" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Tools Library" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("tab", { name: "Knowledge" }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));

  expect(
    screen.queryByRole("heading", { name: "Edit Agent Profile" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save Profile" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Close editor" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Knowledge" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Tools" })).toBeInTheDocument();
  expect(
    screen.getByRole("tab", { name: "Prompts & Skills" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Improve system prompt" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Improve meta prompt" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand system prompt" }));
  expect(screen.getByRole("dialog", { name: "System prompt" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Collapse system prompt" }));
  expect(screen.queryByRole("dialog", { name: "System prompt" })).not.toBeInTheDocument();

  selectTab("Knowledge");
  expect(
    await screen.findByRole("checkbox", {
      name: /Litigation Playbook.*1842 files.*stale/i,
    }),
  ).toBeInTheDocument();

  selectTab("Prompts & Skills");
  expect(screen.getByText("Skill files")).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", {
      name: /Client Update Package.*client-communications.*4 variables/i,
    }),
  ).toBeChecked();
  expect(
    screen.getByRole("checkbox", {
      name: /Client Update Package Skill.*legal-workflow.*v1\.0\.0/i,
    }),
  ).toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  expect(
    screen.queryByRole("button", { name: "Save Profile" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("tab", { name: "Knowledge" }),
  ).not.toBeInTheDocument();
});

test("agent profile delete removes the selected agent from local workspace state", async () => {
  renderAgentWorkspace();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: /Delete Agent/ }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/agent-profiles/agent-client-update"),
      expect.objectContaining({ method: "DELETE" }),
    ),
  );
  expect(
    currentData.models.some((model) => model.id === "agent-client-update"),
  ).toBe(false);
});

test("agent profile row delete works without opening the editor", async () => {
  renderAgentWorkspace();

  const agentRow = screen.getByText("Client Update Agent").closest(
    ".agent-profile-card",
  ) as HTMLElement;
  fireEvent.click(
    within(agentRow).getByRole("button", { name: "Delete" }),
  );

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/agent-profiles/agent-client-update"),
      expect.objectContaining({ method: "DELETE" }),
    ),
  );
  expect(
    currentData.models.some((model) => model.id === "agent-client-update"),
  ).toBe(false);
  expect(screen.queryByText("Client Update Agent")).not.toBeInTheDocument();
});

test("tenant admin sees locked agent profiles as organization policy protected", async () => {
  currentData = {
    ...currentData,
    me: {
      ...currentData.me,
      id: "user-admin",
      role: "TENANT_ADMIN",
      display_name: "Alex Morgan",
    },
    models: currentData.models.map((model) =>
      model.id === "agent-client-update"
        ? { ...model, admin_delete_locked: true }
        : model,
    ),
  };
  renderAgentWorkspace();

  const agentRow = screen.getByText("Client Update Agent").closest(
    ".agent-profile-card",
  ) as HTMLElement;
  const lockedButton = within(agentRow).getByRole("button", {
    name: "Locked",
  });

  expect(lockedButton).toBeDisabled();
  expect(lockedButton).toHaveAttribute(
    "data-tooltip",
    "Client Update Agent is protected by organization policy and cannot be deleted",
  );
  expect(screen.queryByText(/platform owner/i)).not.toBeInTheDocument();
});

test("tenant admin sees private and group-scoped agent profiles", async () => {
  const privateAgent = {
    ...currentData.models.find((model) => model.id === "agent-client-update")!,
    id: "agent-private-casey",
    name: "Casey Private Agent",
    platform_enabled: false,
    visibility: "private" as const,
    group_ids: [],
    created_by: "Casey Doe",
  };
  const groupAgent = {
    ...privateAgent,
    id: "agent-finance-only",
    name: "Finance Agent",
    visibility: "group" as const,
    group_ids: ["group-finance"],
    created_by: "Alex Morgan",
  };
  currentData = {
    ...currentData,
    me: {
      ...currentData.me,
      id: "user-admin",
      role: "TENANT_ADMIN",
      display_name: "Alex Morgan",
    },
    models: [...currentData.models, privateAgent, groupAgent],
  };

  renderAgentWorkspace();

  expect(screen.getByText("Casey Private Agent")).toBeInTheDocument();
  expect(screen.getByText("Finance Agent")).toBeInTheDocument();
});

test("agent profile delete does not show legacy platform-owner API wording", async () => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (
      url.includes("/api/admin/agent-profiles/agent-client-update") &&
      init?.method === "DELETE"
    ) {
      return new Response(
        JSON.stringify({ detail: "Only platform owners can perform this action." }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unavailable", { status: 500 });
  });
  renderAgentWorkspace();

  const agentRow = screen.getByText("Client Update Agent").closest(
    ".agent-profile-card",
  ) as HTMLElement;
  fireEvent.click(
    within(agentRow).getByRole("button", { name: "Delete" }),
  );

  expect(
    await screen.findByText(
      "Agent profile was not deleted: This action is not available for this agent profile.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/platform owners/i)).not.toBeInTheDocument();
});

test("clear agents deletes all configured agent profiles", async () => {
  currentData = {
    ...currentData,
    models: [
      ...currentData.models,
      {
        ...currentData.models.find(
          (model) => model.id === "agent-client-update",
        )!,
        id: "agent-extra-cleanup",
        name: "Cleanup Agent",
      },
    ],
  };
  renderAgentWorkspace();

  fireEvent.click(screen.getByRole("button", { name: "Clear Agents" }));

  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).includes("/api/admin/agent-profiles/") &&
          init?.method === "DELETE",
      ),
    ).toHaveLength(2),
  );
  expect(currentData.models.some((model) => model.id === "agent-client-update")).toBe(false);
  expect(currentData.models.some((model) => model.id === "agent-extra-cleanup")).toBe(false);
  expect(await screen.findByText("Cleared 2 agent profiles.")).toBeInTheDocument();
});

test("agent profile model selector syncs dynamic provider models", async () => {
  renderAgentWorkspace();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    screen.queryByRole("option", {
      name: "OpenRouter: New Dynamic Model · OpenRouter",
    }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Sync models" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/admin/model-access-sync",
      ),
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(
    currentData.models.some(
      (model) => model.id === "openrouter-new-dynamic-model",
    ),
  ).toBe(true);
  expect(
    await screen.findByRole("option", {
      name: "OpenRouter: New Dynamic Model · OpenRouter",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Agent model catalog synced."),
  ).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss notification" }),
  );
  expect(
    screen.queryByText("Agent model catalog synced."),
  ).not.toBeInTheDocument();
});

test("tenant admin agent model selector only shows approved synced models", async () => {
  currentData = {
    ...currentData,
    me: {
      ...currentData.me,
      id: "user-admin",
      role: "TENANT_ADMIN",
      display_name: "Alex Morgan",
    },
  };
  renderAgentWorkspace();

  fireEvent.click(screen.getByRole("button", { name: "New Agent" }));
  expect(
    screen.queryByRole("option", {
      name: "OpenRouter: New Dynamic Model · OpenRouter",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", {
      name: "OpenRouter: Approved Agent Base · OpenRouter",
    }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Sync models" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/admin/model-access-sync",
      ),
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(
    currentData.models.some(
      (model) => model.id === "openrouter-new-dynamic-model",
    ),
  ).toBe(true);
  expect(
    await screen.findByRole("option", {
      name: "OpenRouter: Approved Agent Base · OpenRouter",
    }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", {
      name: "OpenRouter: New Dynamic Model · OpenRouter",
    }),
  ).not.toBeInTheDocument();
});

function selectTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.keyDown(tab, { key: "Enter" });
  fireEvent.click(tab);
}


test.each(["missing", "disabled"] as const)("an agent with a %s base model cannot be silently rerouted when edited or synced", async (availability) => {
  const agent = currentData.models.find((model) => model.id === "agent-client-update")!;
  const base = currentData.models.find((model) => !model.is_custom && model.provider_id === agent.provider_id &&
    (model.upstream_model_id ?? model.name) === (agent.upstream_model_id ?? agent.name))!;
  expect(base).toBeTruthy();
  currentData = {
    ...currentData,
    models: availability === "missing"
      ? currentData.models.filter((model) => model.id !== base.id)
      : currentData.models.map((model) => model.id === base.id ? { ...model, platform_enabled: false } : model),
  };
  renderAgentWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const selector = screen.getByRole("combobox", { name: "AI model" });
  expect(selector).toHaveValue(availability === "missing" ? "" : base.id);
  expect(screen.getByText(/saved model is unavailable/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Renamed agent" } });
  expect(screen.getByRole("button", { name: "Save Profile" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Sync models" }));
  await screen.findByText("Agent model catalog synced.");
  expect(selector).toHaveValue(availability === "missing" ? "" : base.id);
  expect(screen.getByRole("button", { name: "Save Profile" })).toBeDisabled();

  const replacement = within(selector).getAllByRole("option").find((option) => (option as HTMLOptionElement).value &&
    (option as HTMLOptionElement).value !== base.id) as HTMLOptionElement;
  expect(replacement).toBeTruthy();
  fireEvent.change(selector, { target: { value: replacement.value } });
  expect(screen.getByRole("button", { name: "Save Profile" })).toBeEnabled();
  fetchMock.mockImplementationOnce(async (_input, init) => new Response(JSON.stringify({
    ...agent, ...JSON.parse(String(init?.body)),
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));
  await screen.findByText(/Renamed agent saved/);
  const savedCall = fetchMock.mock.calls.find(([input, init]) => String(input).includes("/agent-profiles/") && init?.method === "PATCH");
  const payload = JSON.parse(String(savedCall?.[1]?.body));
  const replacementModel = currentData.models.find((model) => model.id === replacement.value)!;
  expect(payload).toMatchObject({ provider_id: replacementModel.provider_id, upstream_model_id: replacementModel.upstream_model_id ?? replacementModel.name });
});


test("Hermes memory loading and failures stay distinct from an empty memory list and can retry", async () => {
  let rejectLoad: (error: Error) => void = () => undefined;
  fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLoad = reject; }));
  renderAgentWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  selectTab("Hermes");
  expect(screen.getByText("Loading saved memories…")).toBeInTheDocument();
  expect(screen.queryByText(/No memories saved yet/)).not.toBeInTheDocument();
  rejectLoad(new Error("Temporarily unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Saved memories could not be loaded");
  expect(screen.queryByText(/No memories saved yet/)).not.toBeInTheDocument();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{
    id: "memory-synthetic", tenant_id: "tenant-example", profile_id: "agent-client-update",
    content: "Use the agreed response format.", created_by: "user-owner", created_at: "2026-01-01T00:00:00Z",
  }]), { status: 200, headers: { "Content-Type": "application/json" } }));
  fireEvent.click(screen.getByRole("button", { name: "Retry memories" }));
  expect(await screen.findByText("Use the agreed response format.")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});


test("editing an existing agent preserves its original owner and disabled state", async () => {
  const original = { ...currentData.models.find((model) => model.id === "agent-client-update")!,
    created_by: "original-author", platform_enabled: false, notes: "Reviewed routing policy" };
  currentData = { ...currentData, models: currentData.models.map((model) => model.id === original.id ? original : model) };
  renderAgentWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Updated agent name" } });
  fetchMock.mockImplementationOnce(async (_input, init) => new Response(JSON.stringify({
    ...original, ...JSON.parse(String(init?.body)),
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));
  await screen.findByText(/Updated agent name saved/);
  const savedCall = fetchMock.mock.calls.find(([input, init]) => String(input).includes("/agent-profiles/") && init?.method === "PATCH");
  const payload = JSON.parse(String(savedCall?.[1]?.body));
  expect(payload).not.toHaveProperty("created_by");
  expect(payload).not.toHaveProperty("platform_enabled");
  expect(payload).not.toHaveProperty("notes");
  expect(currentData.models.find((model) => model.id === original.id)).toMatchObject({
    created_by: "original-author", platform_enabled: false, notes: "Reviewed routing policy", name: "Updated agent name",
  });
});

function renderAgentWorkspace(onUseInChat = vi.fn()) {
  render(<AgentWorkspaceHarness onUseInChat={onUseInChat} />);
}

function AgentWorkspaceHarness({
  onUseInChat,
}: {
  onUseInChat: (modelId: string) => void;
}) {
  const [workspaceData, setWorkspaceData] = useState(currentData);
  return (
    <AgentWorkspaceConsole
      data={workspaceData}
      onDataChange={(updater) => {
        setWorkspaceData((current) => {
          const next = updater(current);
          currentData = next;
          return next;
        });
      }}
      onUseInChat={onUseInChat}
    />
  );
}

test("standard users cannot author agents until the ceiling and the group grant are both on", () => {
  const memberGroupId = "group-default-users";
  const asUser = (agentAuthoring: boolean, usersCanCreateModels: boolean) => {
    currentData = {
      ...currentData,
      me: {
        ...currentData.me,
        id: "user-jane",
        role: "USER",
        display_name: "Jane Associate",
        group_ids: [memberGroupId],
      },
      platformSettings: {
        ...currentData.platformSettings!,
        users_can_create_models: usersCanCreateModels,
      },
      groups: currentData.groups.map((group) =>
        group.id === memberGroupId
          ? { ...group, permissions: { ...group.permissions, agent_authoring: agentAuthoring } }
          : group,
      ),
    };
  };

  // Grant without the organization ceiling: no authoring affordances, and the
  // page says the platform policy is what is blocking it.
  asUser(true, false);
  renderAgentWorkspace();
  expect(screen.queryByRole("button", { name: /New Agent/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Clear Agents/ })).not.toBeInTheDocument();
  expect(
    screen.getByText(/unavailable under the current service policy/),
  ).toBeInTheDocument();
  cleanup();

  // Ceiling without the grant: still nothing, but now the missing permission
  // is named instead of the policy.
  asUser(false, true);
  renderAgentWorkspace();
  expect(screen.queryByRole("button", { name: /New Agent/ })).not.toBeInTheDocument();
  expect(
    screen.getByText(/do not include the Can build agents permission/),
  ).toBeInTheDocument();
  cleanup();

  // Both on: the user can start a private agent, but not bulk-clear the workspace.
  asUser(true, true);
  renderAgentWorkspace();
  expect(screen.getByRole("button", { name: /New Agent/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Clear Agents/ })).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Building agents is not available to you/),
  ).not.toBeInTheDocument();
});

test("granted users edit only their own agents and cannot widen visibility", () => {
  const memberGroupId = "group-default-users";
  const mine = currentData.models.find((model) => model.is_custom)!;
  const theirs = {
    ...mine,
    id: "agent-owned-by-someone-else",
    name: "Someone Else's Agent",
    created_by: "someone-else@example.com",
    visibility: "tenant" as const,
  };
  currentData = { ...currentData, models: [...currentData.models, theirs] };
  currentData = {
    ...currentData,
    me: {
      ...currentData.me,
      id: "user-jane",
      role: "USER",
      display_name: "Jane Associate",
      group_ids: [memberGroupId],
    },
    platformSettings: { ...currentData.platformSettings!, users_can_create_models: true },
    groups: currentData.groups.map((group) =>
      group.id === memberGroupId
        ? { ...group, permissions: { ...group.permissions, agent_authoring: true } }
        : group,
    ),
    models: currentData.models.map((model) =>
      model.id === mine.id
        ? { ...model, created_by: "user-jane", visibility: "private" }
        : model.id === theirs.id
          ? { ...model, created_by: "someone-else@example.com", visibility: "tenant" }
          : model,
    ),
  };

  renderAgentWorkspace();

  // Only the profile Jane authored exposes Edit/Delete.
  const mineCard = screen.getByText(mine.name).closest(".agent-profile-card") as HTMLElement;
  expect(within(mineCard).getByRole("button", { name: /Edit/ })).toBeInTheDocument();
  expect(within(mineCard).getByRole("button", { name: /Delete/ })).toBeInTheDocument();

  fireEvent.click(within(mineCard).getByRole("button", { name: /Edit/ }));

  // Visibility is stated, not offered as a control the server would override.
  expect(screen.queryByLabelText("Visibility")).not.toBeInTheDocument();
  expect(
    screen.getByText(/Private — only you can use this agent/),
  ).toBeInTheDocument();

  selectTab("Access");
  expect(screen.queryByText("Allowed groups")).not.toBeInTheDocument();
  expect(
    screen.getByText(/Agents you build stay private to your account/),
  ).toBeInTheDocument();
});
