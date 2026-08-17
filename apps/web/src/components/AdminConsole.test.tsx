import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData, Group, ModelConfig, SecurityAlert, User, UserPromptRecord } from "../lib/types";
import { AdminConsole, type AdminConsoleApi } from "./AdminConsole";

vi.mock("@remotion/player", async () => {
  const React = await import("react");

  return {
    Player: ({ inputProps }: { inputProps?: { video?: { title?: string; audioSrc?: string } } }) =>
      React.createElement(
        "div",
        { "data-testid": "remotion-player", "data-audio-src": inputProps?.video?.audioSrc ?? "" },
        inputProps?.video?.title ?? "Remotion player",
      ),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

test("admin console creates users only after the admin API returns a persisted account", async () => {
  const createdUser: User = {
    id: "user-taylor",
    tenant_id: "tenant-example",
    email: "taylor.new@example.com",
    display_name: "Taylor New",
    role: "USER",
    group_ids: ["group-default-users"],
    active: true,
    last_active: "Never",
    auth_method: "sso",
  };
  const createDeferred = deferred<User>();
  const adminApi: AdminConsoleApi = {
    createUser: vi.fn(() => createDeferred.promise),
  };

  renderAdmin(adminApi);
  fireEvent.click(screen.getByRole("button", { name: "Add User" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Taylor New" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "taylor.new@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

  expect(screen.queryByText("Taylor New")).not.toBeInTheDocument();
  createDeferred.resolve(createdUser);

  expect(await screen.findByText("Taylor New")).toBeInTheDocument();
  expect(await screen.findByText("Taylor New was created through the admin API.")).toBeInTheDocument();
  expect(adminApi.createUser).toHaveBeenCalledWith(
    "user-admin",
    expect.objectContaining({
      tenant_id: "tenant-example",
      email: "taylor.new@example.com",
      display_name: "Taylor New",
      role: "USER",
      group_ids: ["group-default-users"],
      active: true,
    }),
    expect.any(Object),
  );
});

test("admin console does not keep a local user when create fails", async () => {
  const adminApi: AdminConsoleApi = {
    createUser: vi.fn(async () => {
      throw new Error("User email already exists.");
    }),
  };

  renderAdmin(adminApi);
  fireEvent.click(screen.getByRole("button", { name: "Add User" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Duplicate Jane" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jane.smith@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

  expect(await screen.findByText("User was not created. User email already exists.")).toBeInTheDocument();
  expect(screen.queryByText("Duplicate Jane")).not.toBeInTheDocument();
});

test("admin reviews a pending request and approves Luna-only temporary access", async () => {
  const data = cloneData();
  const pending: User = {
    id: "user-request-jamie",
    tenant_id: "tenant-example",
    email: "jamie@example.com",
    display_name: "Jamie Rivera",
    role: "USER",
    group_ids: [],
    active: false,
    last_active: "Never",
    auth_method: "sso",
    access_request_status: "pending",
    access_requested_at: "2026-08-13T12:00:00Z",
  };
  data.users.push(pending);
  data.visibleUsers.push(pending);
  const approved: User = {
    ...pending,
    role: "TEMP_USER",
    active: true,
    group_ids: ["group-default-users"],
    access_request_status: "approved",
    access_reviewed_at: "2026-08-13T12:05:00Z",
  };
  const approveAccessRequest = vi.fn(async () => approved);

  renderAdmin({ approveAccessRequest }, data);
  expect(screen.getByRole("heading", { name: "Access requests" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Access level for Jamie Rivera"), {
    target: { value: "TEMP_USER" },
  });
  expect(screen.getByText("Luna only; requests stop after 30,000 reported tokens.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));

  expect(await screen.findByText(/approved as a Temp User with Luna-only access and a 30,000-token grant/)).toBeInTheDocument();
  expect(approveAccessRequest).toHaveBeenCalledWith(
    "user-admin",
    pending.id,
    "TEMP_USER",
    expect.any(Object),
  );
  expect(screen.queryByRole("heading", { name: "Access requests" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Role for Jamie Rivera")).toHaveValue("TEMP_USER");
});

test("admin console applies role changes only from the returned API user", async () => {
  const updatedJane: User = {
    ...cloneData().visibleUsers.find((user) => user.id === "user-jane")!,
    role: "POWER_USER",
  };
  const updateDeferred = deferred<User>();
  const adminApi: AdminConsoleApi = {
    updateUser: vi.fn(() => updateDeferred.promise),
  };

  renderAdmin(adminApi);
  const roleSelect = screen.getByLabelText("Role for Jane Smith") as HTMLSelectElement;
  expect(roleSelect.value).toBe("USER");

  fireEvent.change(roleSelect, { target: { value: "POWER_USER" } });
  expect(roleSelect.value).toBe("USER");
  updateDeferred.resolve(updatedJane);

  await waitFor(() => expect((screen.getByLabelText("Role for Jane Smith") as HTMLSelectElement).value).toBe("POWER_USER"));
  expect(adminApi.updateUser).toHaveBeenCalledWith(
    "user-admin",
    "user-jane",
    { role: "POWER_USER" },
    expect.any(Object),
  );
});

test("admin deletes a regular user through the admin API but never admins or themselves", async () => {
  const adminApi: AdminConsoleApi = {
    deleteUser: vi.fn(async () => {}),
  };

  renderAdmin(adminApi);

  // Tenant admins cannot delete other admins or their own account.
  expect(screen.getByRole("button", { name: "Delete Drew Parker" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Delete Alex Morgan" })).toBeDisabled();

  // Regular users in the tenant are deletable, and the row only disappears
  // after the API confirms.
  fireEvent.click(screen.getByRole("button", { name: "Delete Jane Smith" }));
  expect(await screen.findByText("Jane Smith was permanently deleted.")).toBeInTheDocument();
  expect(adminApi.deleteUser).toHaveBeenCalledWith("user-admin", "user-jane", expect.any(Object));
  expect(screen.queryByLabelText("Role for Jane Smith")).not.toBeInTheDocument();
});

test("admin console keeps the user row when deletion fails at the API", async () => {
  const adminApi: AdminConsoleApi = {
    deleteUser: vi.fn(async () => {
      throw new Error("Tenant admins can only delete regular users in their own tenant.");
    }),
  };

  renderAdmin(adminApi);
  fireEvent.click(screen.getByRole("button", { name: "Delete Jane Smith" }));

  expect(
    await screen.findByText(
      "Jane Smith was not deleted. Tenant admins can only delete regular users in their own tenant.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Role for Jane Smith")).toBeInTheDocument();
});

test("admin console keeps users, platform groups, and model grants in separate tab sections", async () => {
  renderAdmin({});

  expect(screen.getByRole("heading", { name: "Users (5)" })).toBeInTheDocument();
  expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  expect(screen.queryByText("AD Group Sync")).not.toBeInTheDocument();
  expect(screen.queryByText("Model Access by Group")).not.toBeInTheDocument();

  selectTab("Groups");
  expect(await screen.findByRole("heading", { name: "Groups" })).toBeInTheDocument();
  expect(screen.getByText(/Default Users stays protected for baseline access/i)).toBeInTheDocument();
  expect(screen.getByText("5 platform groups · 0 unassigned users")).toBeInTheDocument();
  expect(screen.getAllByText("1 platform member").length).toBeGreaterThan(0);
  expect(screen.getByText("Default group")).toBeInTheDocument();
  expect(screen.getByLabelText("Select Default Users for removal")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Default Users" })).toBeDisabled();
  expect(screen.getAllByRole("tab", { name: "Users" }).length).toBeGreaterThan(1);
  expect(screen.getByRole("tab", { name: "Permissions" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Import" })).toBeInTheDocument();
  selectTab("Permissions");
  expect(screen.getByText("Group Permissions")).toBeInTheDocument();

  selectTab("Model Access");
  expect(await screen.findByRole("button", { name: "Sync models" })).toBeInTheDocument();
  expect(screen.getAllByText("6").length).toBeGreaterThan(0);
  expect(screen.getByText(/models synced to this tenant/i)).toBeInTheDocument();
  expect(screen.getByText(/visible to users/i)).toBeInTheDocument();
  expect(screen.queryByLabelText("Model access group")).not.toBeInTheDocument();
  expect(screen.queryByText("o3-mini")).not.toBeInTheDocument();
});

test("tenant admin users tab never renders platform owner accounts", () => {
  const data = cloneData();
  data.me = { ...data.users.find((user) => user.id === "user-owner")! };
  // Simulate a stale or crafted payload that wrongly includes the platform owner.
  data.visibleUsers = [...data.users];

  renderAdmin({}, data);

  expect(screen.getByRole("heading", { name: "Users (5)" })).toBeInTheDocument();
  expect(screen.queryByText("Aperture Platform Owner")).not.toBeInTheDocument();
  expect(screen.queryByText("owner@aperture.local")).not.toBeInTheDocument();
  expect(screen.getByText("Alex Morgan")).toBeInTheDocument();
  expect(screen.getByText("Jane Smith")).toBeInTheDocument();
});

test("tenant admins can inspect peer profile context without seeing platform owners", () => {
  const data = cloneData();
  data.visibleUsers = data.visibleUsers.map((user) =>
    user.id === "user-drew"
      ? {
          ...user,
          firm_name: "Drew Parker Legal",
          bio: "Tenant administration and litigation operations.",
          phone: "+1 555 0199",
          avatar_url: "https://images.example.test/drew-parker.png",
          website_url: "https://drew.example.com",
        }
      : user,
  );

  renderAdmin({}, data);

  const drewIdentity = screen.getByText("Drew Parker").closest(".user-identity-cell");
  expect(drewIdentity).toHaveAttribute(
    "data-tooltip",
    [
      "Drew Parker",
      "Email: drew.parker@example.com",
      "Phone: +1 555 0199",
      "Position: Drew Parker Legal",
      "Bio: Tenant administration and litigation operations.",
      "Website: https://drew.example.com",
      "Role: Admin",
    ].join("\n"),
  );
  expect(drewIdentity?.querySelector(".mini-avatar img")).toHaveAttribute(
    "src",
    "https://images.example.test/drew-parker.png",
  );
  expect(screen.queryByText("Aperture Platform Owner")).not.toBeInTheDocument();
  expect(screen.queryByText("owner@aperture.local")).not.toBeInTheDocument();
});

test("admin model access sync refreshes the tenant model catalog", async () => {
  const existingModels = cloneData().models.filter((item) => item.platform_enabled);
  const syncedModel: ModelConfig = {
    ...existingModels[0],
    id: "openrouter-anthropic-claude-3-5-sonnet",
    provider_id: "provider-openrouter",
    provider_name: "OpenRouter",
    name: "Anthropic: Claude 3.5 Sonnet",
    upstream_model_id: "anthropic/claude-3.5-sonnet",
    tenant_restricted: true,
    group_ids: [],
    knowledge_base_ids: ["kb-litigation-playbook"],
    tool_ids: ["tool-citation-checker"],
  };
  const adminApi: AdminConsoleApi = {
    syncModelAccess: vi.fn(async () => [...existingModels, syncedModel]),
  };

  renderAdmin(adminApi);
  selectTab("Model Access");
  expect(screen.queryByText("Anthropic: Claude 3.5 Sonnet")).not.toBeInTheDocument();

  fireEvent.click(await screen.findByRole("button", { name: "Sync models" }));

  expect(await screen.findByText("Anthropic: Claude 3.5 Sonnet")).toBeInTheDocument();
  expect(await screen.findByText("Synced 7 models into Model Access.")).toBeInTheDocument();
  expect(adminApi.syncModelAccess).toHaveBeenCalledWith("user-admin", expect.any(Object));
  expect(screen.getByRole("status")).toHaveClass("inline-warning", "action-status-toast");

  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByText("Synced 7 models into Model Access.")).not.toBeInTheDocument();
});

test("admin model access loads the management catalog separately from chat-visible bootstrap models", async () => {
  const baseData = cloneData();
  const catalogOnlyModel: ModelConfig = {
    ...baseData.models[0],
    id: "provider-openrouter-anthropic-claude-3-5-sonnet",
    provider_id: "provider-openrouter",
    provider_name: "OpenRouter",
    name: "Anthropic: Claude 3.5 Sonnet",
    upstream_model_id: "anthropic/claude-3.5-sonnet",
    platform_enabled: true,
    group_ids: [],
  };
  const fullCatalog = [...baseData.models.filter((item) => item.platform_enabled), catalogOnlyModel];
  const initialData = cloneData();
  initialData.models = fullCatalog.filter((item) => item.group_ids.length > 0);
  const catalog = deferred<ModelConfig[]>();
  const adminApi: AdminConsoleApi = {
    listModelAccess: vi.fn(() => catalog.promise),
  };

  function Harness() {
    const [data, setData] = useState<BootstrapData>(() => initialData);
    return <AdminConsole data={data} onDataChange={setData} adminApi={adminApi} />;
  }

  render(<Harness />);
  selectTab("Model Access");

  expect(screen.queryByText("Anthropic: Claude 3.5 Sonnet")).not.toBeInTheDocument();
  catalog.resolve(fullCatalog);
  expect(await screen.findByText("Anthropic: Claude 3.5 Sonnet")).toBeInTheDocument();
  expect(screen.getByText("OpenRouter: openai/gpt-4o-mini")).toBeInTheDocument();
  expect(adminApi.listModelAccess).toHaveBeenCalledWith("user-admin", expect.any(Object));
});

test("admin model access filters the table by model name search", async () => {
  const initialData = cloneData();
  const glmModel: ModelConfig = {
    ...initialData.models[0],
    id: "openrouter-zai-glm-5-2",
    provider_id: "provider-openrouter",
    provider_name: "OpenRouter",
    name: "Z.ai: GLM 5.2",
    upstream_model_id: "z-ai/glm-5.2",
    platform_enabled: true,
    group_ids: [],
  };
  initialData.models = [...initialData.models, glmModel];

  renderAdmin({}, initialData);
  selectTab("Model Access");

  const search = await screen.findByLabelText("Search model names");
  expect(screen.getByRole("radio", { name: /All/ })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("button", { name: "Filter by provider" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Filter by model lab" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Filter by runtime route" })).toBeInTheDocument();
  expect(screen.getByText("Z.ai: GLM 5.2")).toBeInTheDocument();

  fireEvent.change(search, { target: { value: "glm" } });
  expect(screen.getByText("Z.ai: GLM 5.2")).toBeInTheDocument();
  expect(screen.queryByText("gpt-4o")).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: "gpt" } });
  expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0);
  expect(screen.getByText("OpenAI: GPT-5.5")).toBeInTheDocument();
  expect(screen.queryByText("Z.ai: GLM 5.2")).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: "no-such-model" } });
  expect(screen.getByText('No models match "no-such-model".')).toBeInTheDocument();

  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Filter by runtime route" }));
  fireEvent.change(screen.getByLabelText("Runtime route contains"), { target: { value: "z-ai" } });
  expect(screen.getByText("Z.ai: GLM 5.2")).toBeInTheDocument();
  expect(screen.queryByText("OpenAI: GPT-5.5")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

  fireEvent.click(screen.getByRole("radio", { name: /Disabled/ }));
  expect(screen.getByText("Z.ai: GLM 5.2")).toBeInTheDocument();
});

test("admin model access user toggle persists through the admin API", async () => {
  const initialData = cloneData();
  initialData.models = initialData.models.map((item) =>
    item.id === "openrouter-openai-gpt-5-5" ? { ...item, group_ids: [] } : item,
  );
  const model = initialData.models.find((item) => item.id === "openrouter-openai-gpt-5-5")!;
  const adminApi: AdminConsoleApi = {
    updateModelAccess: vi.fn(async (_actorUserId, _modelId, patch) => ({
      ...model,
      group_ids: patch.group_ids,
      tenant_restricted: true,
    })),
  };

  renderAdmin(adminApi, initialData);
  selectTab("Model Access");
  const grantSwitch = await screen.findByRole("switch", { name: "Enable OpenAI: GPT-5.5 for users" });
  expect(grantSwitch).toHaveAttribute("aria-checked", "false");

  fireEvent.click(grantSwitch);

  await waitFor(() =>
    expect(adminApi.updateModelAccess).toHaveBeenCalledWith(
      "user-admin",
      "openrouter-openai-gpt-5-5",
      { group_ids: ["group-default-users"] },
      expect.any(Object),
    ),
  );
});

test("admin model access explains that groups are required before enabling models", async () => {
  const initialData = cloneData();
  initialData.groups = [];
  initialData.users = initialData.users.map((user) => ({ ...user, group_ids: [] }));
  initialData.visibleUsers = initialData.visibleUsers.map((user) => ({ ...user, group_ids: [] }));
  initialData.models = initialData.models.map((model) => ({ ...model, group_ids: [] }));
  const adminApi: AdminConsoleApi = {
    updateModelAccess: vi.fn(),
  };

  renderAdmin(adminApi, initialData);
  selectTab("Model Access");

  expect(await screen.findByText("Create a group before enabling models.")).toBeInTheDocument();
  expect(screen.getByText(/Users inherit a model only after they belong to an allowed group/i)).toBeInTheDocument();
  const grantSwitch = await screen.findByRole("switch", { name: "Enable OpenAI: GPT-5.5 for users" });
  expect(grantSwitch).toBeDisabled();
  fireEvent.click(grantSwitch);
  expect(adminApi.updateModelAccess).not.toHaveBeenCalled();
  expect(screen.getAllByText("Create a group first").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "No groups available for OpenAI: GPT-5.5" })).toBeDisabled();
  expect(screen.getAllByText("No groups yet").length).toBeGreaterThan(0);
});

test("admin model access group editor persists groups per model", async () => {
  const model = cloneData().models.find((item) => item.id === "gpt-4o")!;
  const adminApi: AdminConsoleApi = {
    updateModelAccess: vi.fn(async (_actorUserId, _modelId, patch) => ({
      ...model,
      group_ids: patch.group_ids,
      tenant_restricted: true,
    })),
  };

  renderAdmin(adminApi);
  selectTab("Model Access");
  fireEvent.click(await screen.findByRole("button", { name: "Edit groups for gpt-4o" }));
  fireEvent.click(await screen.findByLabelText("Allow gpt-4o for HR"));

  await waitFor(() =>
    expect(adminApi.updateModelAccess).toHaveBeenCalledWith(
      "user-admin",
      "gpt-4o",
      { group_ids: ["group-litigation", "group-corporate", "group-default-users", "group-hr"] },
      expect.any(Object),
    ),
  );
});

test("admin console creates and removes platform groups", async () => {
  const createdGroup: Group = {
    id: "group-trial-team",
    tenant_id: "tenant-example",
    name: "Trial Team",
    distinguished_name: "Platform-managed group",
    entra_object_id: "platform-group-trial-team",
    synced: true,
    user_count: 0,
    permissions: {},
  };
  const adminApi: AdminConsoleApi = {
    createGroup: vi.fn(async () => createdGroup),
    deleteGroups: vi.fn(async (_actorUserId, groupIds) => groupIds),
  };

  renderAdmin(adminApi);
  selectTab("Groups");
  fireEvent.click(await screen.findByRole("button", { name: "Add Group" }));
  fireEvent.change(screen.getByLabelText("Group name"), { target: { value: "Trial Team" } });
  fireEvent.click(screen.getByRole("button", { name: "Create group" }));

  expect((await screen.findAllByText("Trial Team")).length).toBeGreaterThan(0);
  expect(adminApi.createGroup).toHaveBeenCalledWith(
    "user-admin",
    expect.objectContaining({ name: "Trial Team", distinguished_name: "Platform-managed group" }),
    expect.any(Object),
  );

  fireEvent.click(screen.getByLabelText("Select Trial Team for removal"));
  fireEvent.click(screen.getByRole("button", { name: "Remove selected" }));

  await waitFor(() =>
    expect(adminApi.deleteGroups).toHaveBeenCalledWith(
      "user-admin",
      ["group-trial-team"],
      expect.any(Object),
    ),
  );
});

test("a refused permission change leaves the toggle showing what the server still holds", async () => {
  // A toggle that stays flipped after the server refuses tells an admin that
  // access was granted when it was not.
  const adminApi: AdminConsoleApi = {
    updateGroup: vi.fn(async () => {
      throw new Error("Server refused");
    }),
  };

  renderAdmin(adminApi);
  selectTab("Groups");
  fireEvent.click(await screen.findByText("Corporate"));
  expect(await screen.findByRole("region", { name: "Corporate group settings" })).toBeInTheDocument();
  selectTab("Permissions");

  const apiPermission = screen.getByRole("switch", { name: "Can use API" });
  expect(apiPermission).toHaveAttribute("aria-checked", "false");

  fireEvent.click(apiPermission);

  await waitFor(() => expect(adminApi.updateGroup).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: "Can use API" })).toHaveAttribute("aria-checked", "false"),
  );
  expect(screen.getByText(/Nothing was changed\./)).toBeInTheDocument();
});

test("admin group editor persists membership and expanded default-on permissions", async () => {
  const data = cloneData();
  const corporate = data.groups.find((group) => group.id === "group-corporate")!;
  const jane = data.visibleUsers.find((user) => user.id === "user-jane")!;
  const adminApi: AdminConsoleApi = {
    updateGroup: vi.fn(async (_actorUserId, _groupId, patch) => ({
      ...corporate,
      ...patch,
    })),
    updateUser: vi.fn(async (_actorUserId, _userId, patch) => ({
      ...jane,
      ...patch,
    })),
  };

  renderAdmin(adminApi);
  selectTab("Groups");
  fireEvent.click(await screen.findByText("Corporate"));

  expect(await screen.findByRole("region", { name: "Corporate group settings" })).toBeInTheDocument();
  selectTab("Permissions");
  const chatPermission = screen.getByRole("switch", { name: "Can use chat" });
  const apiPermission = screen.getByRole("switch", { name: "Can use API" });
  expect(chatPermission).toHaveAttribute("aria-checked", "true");
  expect(apiPermission).toHaveAttribute("aria-checked", "false");

  fireEvent.click(chatPermission);

  await waitFor(() =>
    expect(adminApi.updateGroup).toHaveBeenCalledWith(
      "user-admin",
      "group-corporate",
      {
        permissions: expect.objectContaining({
          chat_access: false,
          agents_access: true,
          tools_access: true,
        }),
      },
      expect.any(Object),
    ),
  );

  fireEvent.click(apiPermission);

  await waitFor(() =>
    expect(adminApi.updateGroup).toHaveBeenLastCalledWith(
      "user-admin",
      "group-corporate",
      {
        permissions: expect.objectContaining({
          chat_access: false,
          api_access: true,
        }),
      },
      expect.any(Object),
    ),
  );

  selectTab("Users", { last: true });
  fireEvent.click(screen.getByRole("switch", { name: "Add Jane Smith to Corporate" }));

  await waitFor(() =>
    expect(adminApi.updateUser).toHaveBeenCalledWith(
      "user-admin",
      "user-jane",
      { group_ids: ["group-litigation", "group-corporate"] },
      expect.any(Object),
    ),
  );
});

test("admin group import adds platform users to the selected group", async () => {
  const data = cloneData();
  const maya = data.visibleUsers.find((user) => user.id === "user-maya")!;
  const adminApi: AdminConsoleApi = {
    updateUser: vi.fn(async (_actorUserId, _userId, patch) => ({
      ...maya,
      ...patch,
    })),
  };

  renderAdmin(adminApi);
  selectTab("Groups");
  fireEvent.click(await screen.findByText("Litigation"));
  selectTab("Import");
  fireEvent.change(await screen.findByLabelText("User emails"), {
    target: { value: "maya.patel@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add users to group" }));

  await waitFor(() =>
    expect(adminApi.updateUser).toHaveBeenCalledWith(
      "user-admin",
      "user-maya",
      { group_ids: ["group-default-users", "group-litigation"] },
      expect.any(Object),
    ),
  );
  expect(await screen.findByText("Added 1 user to Litigation.")).toBeInTheDocument();
});

test("admin connections panel exposes OAuth authorize links for MCP tools", async () => {
  renderAdmin({});
  selectTab("Connections");

  const authorize = await screen.findByRole("link", { name: /Authorize/ });
  expect(authorize).toHaveAttribute(
    "href",
    expect.stringContaining("https://hermes.example.local/oauth/authorize"),
  );
  expect(authorize).toHaveAttribute("href", expect.stringContaining("client_id=hermes-agent-mcp-client"));
  expect(authorize).toHaveAttribute(
    "href",
    expect.stringContaining(
      "redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fapi%2Ftools%2Ftool-hermes-agent-mcp%2Foauth%2Fcallback",
    ),
  );
});

test("admin audit tab renders tenant audit events from the admin API", async () => {
  const listAuditEvents = vi.fn(async () => [
    {
      id: "audit-tenant-1",
      tenant_id: "tenant-example",
      actor_id: "user-admin",
      actor_name: "Alex Morgan",
      actor_role: "TENANT_ADMIN",
      action: "admin.group_updated",
      action_type: "GROUP_UPDATED",
      target: "group-litigation",
      target_type: "Group",
      target_name: "Litigation",
      detail: "Permissions synced.",
      created_at: "2026-07-01T20:00:00Z",
      redacted: false,
      metadata: {},
    },
  ]);

  renderAdmin({ listAuditEvents });
  selectTab("Audit");

  expect(await screen.findByText("Admin Audit")).toBeInTheDocument();
  expect(await screen.findByText("Audit Trail")).toBeInTheDocument();
  expandPanel("Audit Trail");
  expect(await screen.findByText("GROUP_UPDATED")).toBeInTheDocument();
  expect(screen.getByText(/Alex Morgan \(Admin\) · Group: Litigation · Permissions synced/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: /Refresh/ }).at(-1)!);
  await waitFor(() => expect(listAuditEvents).toHaveBeenCalledTimes(2));
});

test("admin analytics and audit monitors hide platform owner prompt records", async () => {
  const data = cloneData();
  data.visibleUsers = [...data.users];
  const promptRecords: UserPromptRecord[] = [
    {
      id: "message-jane-dlp",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane.smith@example.com",
      user_role: "USER",
      thread_id: "thread-jane-dlp",
      thread_title: "Matter intake DLP check",
      model_id: "gpt-4o",
      content: "Please review this client matter for SSN exposure.",
      created_at: "Jul 6, 2026, 5:00 PM UTC",
      created_at_iso: "2026-07-06T23:00:00Z",
      response_message_id: "message-jane-dlp-response",
      response_content: "The saved output confirms that the matter should follow the restricted-data workflow.",
      response_status: "ok",
      response_truncated: false,
      alert_count: 1,
    },
    {
      id: "message-owner-private",
      user_id: "user-owner",
      user_name: "Aperture Platform Owner",
      user_email: "owner@aperture.local",
      thread_id: "thread-owner-private",
      thread_title: "Owner private governance",
      model_id: "gpt-4o",
      content: "Owner private platform query.",
      created_at: "Jul 6, 2026, 6:00 PM UTC",
      created_at_iso: "2026-07-07T00:00:00Z",
      alert_count: 1,
    },
  ];
  const alerts: SecurityAlert[] = [
    {
      id: "alert-jane-dlp",
      tenant_id: "tenant-example",
      user_id: "user-jane",
      user_name: "Jane Smith",
      rule_id: "ssn",
      rule_label: "Sensitive identifier",
      category: "dlp",
      severity: "high",
      snippet: "Please review this client matter for [REDACTED].",
      model_id: "gpt-4o",
      thread_id: "thread-jane-dlp",
      surface: "chat",
      created_at: "2026-07-06T23:00:00Z",
      acknowledged: false,
    },
    {
      id: "alert-owner-private",
      tenant_id: "tenant-example",
      user_id: "user-owner",
      user_name: "Aperture Platform Owner",
      rule_id: "owner-private",
      rule_label: "Owner private alert",
      category: "dlp",
      severity: "high",
      snippet: "Owner private platform query.",
      model_id: "gpt-4o",
      thread_id: "thread-owner-private",
      surface: "chat",
      created_at: "2026-07-07T00:00:00Z",
      acknowledged: false,
    },
  ];
  const adminApi: AdminConsoleApi = {
    listPromptActivity: vi.fn(async () => promptRecords),
    listSecurityAlerts: vi.fn(async () => alerts),
  };

  renderAdmin(adminApi, data);
  selectTab("Analytics");

  expandPanel("Model Activity");
  expect(await screen.findByText("Prompts by model")).toBeInTheDocument();
  expect(await screen.findByText("1 total prompts")).toBeInTheDocument();
  // Jane appears both as a record and in the new user filter option list.
  expect(screen.getAllByText("Jane Smith").length).toBeGreaterThan(0);
  expect(screen.queryByText("Owner private platform query.")).not.toBeInTheDocument();
  // The section user filter never lists platform owners.
  const analyticsUserFilter = screen.getByLabelText("Model activity filter user");
  expect(
    within(analyticsUserFilter).queryByRole("option", { name: /Aperture Platform Owner/ }),
  ).not.toBeInTheDocument();
  expect(
    within(analyticsUserFilter).getByRole("option", { name: /Jane Smith/ }),
  ).toBeInTheDocument();

  selectTab("Audit");
  expect(await screen.findByText("User Prompt Activity")).toBeInTheDocument();
  expandPanel("User Prompt Activity");
  expandPanel("Security Alerts");
  expect(screen.getByText("Matter intake DLP check")).toBeInTheDocument();
  expect(screen.getByText("Sensitive identifier")).toBeInTheDocument();
  expect(screen.queryByText("Owner private governance")).not.toBeInTheDocument();
  expect(screen.queryByText("Owner private alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Aperture Platform Owner/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Drew Parker/ })).not.toBeInTheDocument();
  // Both the prompt drilldown and the new audit user filter list these users.
  expect(screen.getAllByRole("option", { name: /Alex Morgan/ }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("option", { name: /Jane Smith/ }).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Preview prompt and model output: Matter intake DLP check" }));
  const previewDialog = screen.getByRole("dialog", { name: "Prompt and model output" });
  expect(within(previewDialog).getByText(/SSN exposure/)).toBeInTheDocument();
  expect(within(previewDialog).getByText(/restricted-data workflow/)).toBeInTheDocument();
});

test("audit and analytics user filters narrow records and exports to one user", async () => {
  const promptRecords: PromptActivityRecord[] = [
    {
      id: "message-jane-1",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane@aperture.local",
      thread_id: "thread-jane-1",
      thread_title: "Jane thread",
      model_id: "gpt-4o",
      content: "Jane asks about intake.",
      created_at: "Jul 6, 2026, 5:00 PM UTC",
      created_at_iso: "2026-07-06T23:00:00Z",
      alert_count: 0,
    },
    {
      id: "message-casey-1",
      user_id: "user-casey",
      user_name: "Casey Doe",
      user_email: "casey@aperture.local",
      thread_id: "thread-casey-1",
      thread_title: "Casey thread",
      model_id: "gpt-4o",
      content: "Casey asks about billing.",
      created_at: "Jul 6, 2026, 6:00 PM UTC",
      created_at_iso: "2026-07-07T00:00:00Z",
      alert_count: 0,
    },
  ];
  const adminApi: AdminConsoleApi = {
    listPromptActivity: vi.fn(async () => promptRecords),
    listSecurityAlerts: vi.fn(async () => []),
  };

  renderAdmin(adminApi);
  selectTab("Audit");
  expect(await screen.findByText("User Prompt Activity")).toBeInTheDocument();
  expandPanel("User Prompt Activity");
  await waitFor(() => expect(adminApi.listPromptActivity).toHaveBeenCalledWith("user-admin", undefined, expect.any(Object)));
  expect(screen.getByText("Jane thread")).toBeInTheDocument();
  expect(screen.getByText("Casey thread")).toBeInTheDocument();

  // Filter to Jane: Casey's records disappear from the audit surfaces.
  fireEvent.change(screen.getByLabelText("Prompt activity filter user"), {
    target: { value: "user-jane" },
  });
  expect(screen.getByText("Jane thread")).toBeInTheDocument();
  expect(screen.queryByText("Casey thread")).not.toBeInTheDocument();

  // The date range still applies on top of the user filter.
  fireEvent.change(screen.getByLabelText("Prompt activity filter start date"), {
    target: { value: "2027-01-01" },
  });
  expect(screen.queryByText("Jane thread")).not.toBeInTheDocument();
});

test("prompt preview loads and shows the clicked thread's full conversation", async () => {
  // Only the newest exchange fits the activity list window; the older turn
  // must come back from the thread drilldown fetch.
  const listedRecords: UserPromptRecord[] = [
    {
      id: "message-jane-turn-2",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane@aperture.local",
      user_role: "USER",
      thread_id: "thread-jane-multi",
      thread_title: "Jane multi-turn intake",
      model_id: "gpt-4o",
      content: "Second question about retention windows.",
      created_at: "Jul 6, 2026, 6:00 PM UTC",
      created_at_iso: "2026-07-07T00:00:00Z",
      response_message_id: "message-jane-turn-2-response",
      response_content: "Second saved answer about retention.",
      response_status: "ok",
      alert_count: 0,
    },
  ];
  const fullThread: UserPromptRecord[] = [
    listedRecords[0],
    {
      id: "message-jane-turn-1",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane@aperture.local",
      user_role: "USER",
      thread_id: "thread-jane-multi",
      thread_title: "Jane multi-turn intake",
      model_id: "gpt-4o",
      content: "First question about the intake form.",
      created_at: "Jul 6, 2026, 5:00 PM UTC",
      created_at_iso: "2026-07-06T23:00:00Z",
      response_message_id: "message-jane-turn-1-response",
      response_content: "First saved answer about intake.",
      response_status: "ok",
      alert_count: 0,
    },
  ];
  const adminApi: AdminConsoleApi = {
    listPromptActivity: vi.fn(async () => listedRecords),
    listThreadPromptActivity: vi.fn(async () => fullThread),
    listSecurityAlerts: vi.fn(async () => []),
  };

  renderAdmin(adminApi);
  selectTab("Audit");
  expect(await screen.findByText("User Prompt Activity")).toBeInTheDocument();
  expandPanel("User Prompt Activity");
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Preview prompt and model output: Jane multi-turn intake",
    }),
  );

  const dialog = screen.getByRole("dialog", { name: "Prompt and model output" });
  await waitFor(() =>
    expect(adminApi.listThreadPromptActivity).toHaveBeenCalledWith(
      "user-admin",
      "thread-jane-multi",
      expect.any(Object),
    ),
  );
  // The older exchange never appeared in the list; the drilldown fills it in.
  expect(
    await within(dialog).findByText("First question about the intake form."),
  ).toBeInTheDocument();
  expect(within(dialog).getByText("First saved answer about intake.")).toBeInTheDocument();
  expect(within(dialog).getByText("Second question about retention windows.")).toBeInTheDocument();
  expect(within(dialog).getByText("Second saved answer about retention.")).toBeInTheDocument();
  expect(within(dialog).getByText(/2 exchanges in this conversation, oldest first/)).toBeInTheDocument();

  // Exchanges read oldest-first and the clicked one is marked.
  const firstExchange = within(dialog).getByRole("article", { name: "Exchange 1 of 2" });
  const secondExchange = within(dialog).getByRole("article", { name: "Exchange 2 of 2" });
  expect(within(firstExchange).getByText("First question about the intake form.")).toBeInTheDocument();
  expect(within(secondExchange).getByText("Second question about retention windows.")).toBeInTheDocument();
  expect(firstExchange.className).not.toContain("is-selected");
  expect(secondExchange.className).toContain("is-selected");
  expect(within(secondExchange).getByText("Selected exchange")).toBeInTheDocument();
});

test("connector configuration form saves provider credentials and runs a live test", async () => {
  const saveConnectorConfig = vi.fn(async (_actor: string, connector: { id: string }, payload: { auth_type?: string | null; settings?: Record<string, unknown> | null }) => ({
    connector: {
      tenant_config_id: "conncfg-graph-example",
      auth_status: "configured" as const,
    },
    record: {
      id: "conncfg-graph-example",
      tenant_id: "tenant-example",
      connector_id: connector.id,
      enabled: true,
      auth_type: String(payload.auth_type),
      scopes: [],
      settings: payload.settings ?? {},
      secret_set: true,
      masked_secret: "gr•••••et",
    },
  }));
  const testConnectorConfig = vi.fn(async () => ({
    status: "ok" as const,
    message: "Connected to Microsoft Graph.",
    checks: [
      { name: "Authentication", status: "ok", detail: "Token issued by login.microsoftonline.com" },
      { name: "API access", status: "ok", detail: "Reached the tenant root site" },
    ],
  }));

  renderAdmin({ saveConnectorConfig, testConnectorConfig } as unknown as AdminConsoleApi);
  selectTab("Connections");

  const graphBlock = screen
    .getByText("OneDrive / SharePoint / Outlook")
    .closest(".connector-config-block") as HTMLElement;
  fireEvent.click(within(graphBlock).getByRole("button", { name: /Configure/ }));

  fireEvent.change(screen.getByLabelText(/Directory \(tenant\) ID/), {
    target: { value: "11111111-2222-3333-4444-555555555555" },
  });
  fireEvent.change(screen.getByLabelText(/Application \(client\) ID/), {
    target: { value: "app-client-id" },
  });
  fireEvent.change(screen.getByLabelText(/Client secret/), {
    target: { value: "graph-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Save configuration/ }));

  await waitFor(() => expect(saveConnectorConfig).toHaveBeenCalledTimes(1));
  const payload = saveConnectorConfig.mock.calls[0][2];
  expect(payload).toMatchObject({
    connector_id: "microsoft-graph",
    auth_type: "client-credentials",
    secret_value: "graph-secret",
    settings: expect.objectContaining({
      auth_mode: "client-credentials",
      tenant_id: "11111111-2222-3333-4444-555555555555",
      client_id: "app-client-id",
    }),
  });

  fireEvent.click(await screen.findByRole("button", { name: /Test connection/ }));
  await waitFor(() =>
    expect(testConnectorConfig).toHaveBeenCalledWith(expect.any(String), "conncfg-graph-example", expect.anything()),
  );
  expect((await screen.findAllByText("Connected to Microsoft Graph.")).length).toBeGreaterThan(0);
  expect(screen.getByText(/Reached the tenant root site/)).toBeInTheDocument();
});

test("iManage defaults to delegated user sign-in and keeps service credentials out of chat", async () => {
  renderAdmin({});
  selectTab("Connections");

  const block = screen.getByText("iManage").closest(".connector-config-block") as HTMLElement;
  fireEvent.click(within(block).getByRole("button", { name: /Configure/ }));
  const form = screen.getByTestId("connector-config-imanage");

  expect(within(form).getByLabelText("Authentication method")).toHaveValue("oauth-client");
  expect(within(form).getByRole("option", { name: "Each user signs in (recommended)" })).toBeInTheDocument();
  expect(within(form).getByText(/Chat users sign in individually/)).toBeInTheDocument();
  expect(within(form).queryByLabelText(/Service account username/)).not.toBeInTheDocument();

  fireEvent.change(within(form).getByLabelText("Authentication method"), {
    target: { value: "password" },
  });
  expect(within(form).getByLabelText(/Service account username/)).toBeInTheDocument();
  expect(within(form).getByRole("option", { name: "Service account for background sync" })).toBeInTheDocument();
});

test("connector form saves an intentionally cleared existing configuration", async () => {
  const data = cloneData();
  data.connectors = data.connectors.map((connector) =>
    connector.id === "google-drive" ? { ...connector, tenant_config_id: "conncfg-google-drive-example" } : connector,
  );
  const saveConnectorConfig = vi.fn(async (_actor: string, connector: { id: string }, payload: { settings?: Record<string, unknown> | null }) => ({
    connector: {
      tenant_config_id: "conncfg-google-drive-example",
      tenant_enabled: false,
      auth_status: "not-configured" as const,
    },
    record: {
      id: "conncfg-google-drive-example",
      tenant_id: "tenant-example",
      connector_id: connector.id,
      enabled: false,
      auth_type: "oauth-client",
      scopes: [],
      settings: payload.settings ?? {},
      secret_set: false,
      masked_secret: null,
    },
  }));

  renderAdmin({ saveConnectorConfig } as unknown as AdminConsoleApi, data);
  selectTab("Connections");

  const driveBlock = screen.getByText("Google Drive").closest(".connector-config-block") as HTMLElement;
  fireEvent.click(within(driveBlock).getByRole("button", { name: /Configure/ }));
  const driveForm = screen.getByTestId("connector-config-google-drive");

  fireEvent.change(within(driveForm).getByLabelText(/OAuth client ID/), { target: { value: "" } });
  fireEvent.change(within(driveForm).getByLabelText(/Drive folder ID/), { target: { value: "" } });
  fireEvent.change(within(driveForm).getByLabelText(/Source label/), { target: { value: "" } });
  fireEvent.click(within(driveForm).getByRole("button", { name: /Save configuration/ }));

  await waitFor(() => expect(saveConnectorConfig).toHaveBeenCalledTimes(1));
  expect(saveConnectorConfig.mock.calls[0][2]).toMatchObject({
    connector_id: "google-drive",
    enabled: false,
    auth_type: "oauth-client",
    settings: {},
    replace_settings: true,
    clear_secret: true,
    clear_oauth: true,
    clear_service_password: true,
  });
});

test("connector form blocks saving when required provider fields are missing", async () => {
  const saveConnectorConfig = vi.fn();
  renderAdmin({ saveConnectorConfig } as unknown as AdminConsoleApi);
  selectTab("Connections");

  const boxBlock = screen.getByText("Box").closest(".connector-config-block") as HTMLElement;
  fireEvent.click(within(boxBlock).getByRole("button", { name: /Configure/ }));
  fireEvent.click(screen.getByRole("button", { name: /Save configuration/ }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/Client ID.*Enterprise ID/);
  expect(saveConnectorConfig).not.toHaveBeenCalled();
});

test("connector and SSO forms keep field labels aligned", () => {
  renderAdmin({});
  selectTab("Connections");

  const driveBlock = screen.getByText("Google Drive").closest(".connector-config-block") as HTMLElement;
  fireEvent.click(within(driveBlock).getByRole("button", { name: /Configure/ }));
  const driveForm = screen.getByTestId("connector-config-google-drive");
  expect(driveForm.querySelector(":scope > label.connector-config-selector select")).toBeInTheDocument();
  for (const mark of Array.from(driveForm.querySelectorAll(".required-mark"))) {
    expect(mark.parentElement).toHaveClass("connector-field-label");
  }

  selectTab("SSO");
  fireEvent.click(screen.getByRole("button", { name: "Add SSO configuration" }));
  const ssoForm = screen.getByTestId("sso-create-form");
  expect(ssoForm.querySelector(":scope > label.connector-config-selector select")).toBeInTheDocument();
  for (const mark of Array.from(ssoForm.querySelectorAll(".required-mark"))) {
    expect(mark.parentElement).toHaveClass("connector-field-label");
  }
});

test("sso tab creates a tenant SSO configuration through the admin API", async () => {
  const createdConfig = {
    ...cloneData().ssoConfigs[0],
    id: "sso-new-google",
    name: "Google Workspace",
    issuer: "https://accounts.google.com",
    enforced: false,
    status: "ready" as const,
    mapped_groups: {},
  };
  const adminApi: AdminConsoleApi = { createSsoConfig: vi.fn(async () => createdConfig) };

  renderAdmin(adminApi);
  selectTab("SSO");
  fireEvent.click(screen.getByRole("button", { name: "Add SSO configuration" }));
  fireEvent.change(screen.getByLabelText("Identity provider preset"), { target: { value: "google-workspace" } });
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "google-client-id" } });
  fireEvent.change(screen.getByLabelText("Allowed email domains"), { target: { value: "example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Create SSO configuration" }));

  expect(
    await screen.findByText("Google Workspace SSO configuration created. Test the connection before enforcing it."),
  ).toBeInTheDocument();
  expect(adminApi.createSsoConfig).toHaveBeenCalledWith(
    "user-admin",
    expect.objectContaining({
      tenant_id: "tenant-example",
      provider: "google-workspace",
      issuer_url: "https://accounts.google.com",
      client_id: "google-client-id",
      settings: expect.objectContaining({
        enforced: false,
        domains: ["example.com"],
        jit_provisioning: true,
      }),
    }),
    expect.any(Object),
  );
});

test("sso tab saves IdP group mappings through the admin API", async () => {
  const adminApi: AdminConsoleApi = { updateSsoConfig: vi.fn(async () => undefined) };

  renderAdmin(adminApi);
  selectTab("SSO");
  const card = screen.getByText("Microsoft Entra ID", { selector: "strong" }).closest(".settings-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: /Add mapping/ }));
  fireEvent.change(within(card).getByLabelText("IdP group value 1"), { target: { value: "legal-team" } });
  fireEvent.change(within(card).getByLabelText("Tenant group for mapping 1"), {
    target: { value: "group-litigation" },
  });
  fireEvent.click(within(card).getByRole("button", { name: "Save mappings" }));

  expect(await screen.findByText("Microsoft Entra ID group mappings saved.")).toBeInTheDocument();
  expect(adminApi.updateSsoConfig).toHaveBeenCalledWith(
    "user-admin",
    "sso-entra",
    { mapped_groups: { "legal-team": "group-litigation" } },
    expect.any(Object),
  );
});

test("sso tab runs a live connection test and renders the result", async () => {
  const adminApi: AdminConsoleApi = {
    testSsoConfig: vi.fn(async () => ({
      status: "ok" as const,
      message: "Discovery document and JWKS fetched.",
      checks: [{ name: "discovery", status: "ok", detail: "openid-configuration loaded" }],
    })),
  };

  renderAdmin(adminApi);
  selectTab("SSO");
  const card = screen.getByText("Microsoft Entra ID", { selector: "strong" }).closest(".settings-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: /Test connection/ }));

  expect(await within(card).findByText("Discovery document and JWKS fetched.")).toBeInTheDocument();
  expect(within(card).getByText(/openid-configuration loaded/)).toBeInTheDocument();
  expect(adminApi.testSsoConfig).toHaveBeenCalledWith("user-admin", "sso-entra", expect.any(Object));
});

test("sso tab is read-only when organization policy does not permit management", () => {
  const data = cloneData();
  data.platformSettings = {
    downstream_api_enabled: false,
    require_sso_for_admins: false,
    users_can_create_models: false,
    tenant_admins_can_manage_sso: false,
    tenant_admins_can_create_admins: false,
    default_user_group_enabled: true,
  };

  renderAdmin({}, data);
  selectTab("SSO");

  expect(screen.getByText(/makes SSO configuration read-only/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Add SSO configuration/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Test connection/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Save mappings/ })).not.toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Enforce Microsoft Entra ID" })).toBeDisabled();
});

test("group API grants stay blocked while service policy withholds downstream access", async () => {
  const data = cloneData();
  data.platformSettings = {
    ...data.platformSettings!,
    downstream_api_enabled: false,
  };

  renderAdmin({}, data);
  selectTab("Groups");
  fireEvent.click(await screen.findByText("Corporate"));
  selectTab("Permissions");

  expect(screen.getByRole("switch", { name: "Can use API" })).toBeDisabled();
  expect(
    screen.getByText("Downstream API access is unavailable under the current service policy."),
  ).toBeInTheDocument();
});

test("policies expose neutral service availability and persist downstream defaults for admins", async () => {
  const data = cloneData();
  data.platformSettings = {
    ...data.platformSettings!,
    downstream_api_enabled: true,
    users_can_create_models: false,
    memory_enabled: false,
  };
  const defaultGroup = data.groups.find((group) => group.default_group)!;
  const updateGroup = vi.fn(async (_actorId: string, _groupId: string, patch: { permissions?: Record<string, boolean> }) => ({
    ...defaultGroup,
    permissions: patch.permissions ?? defaultGroup.permissions,
  }));

  renderAdmin({ updateGroup }, data);
  selectTab("Policies");

  expect(screen.getByRole("heading", { name: "Policy Controls" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Expand panel" })).toHaveLength(3);
  expandPanel("Policy Controls");
  expect(screen.getByText("Service policy defines which capabilities are available.", { exact: false })).toBeInTheDocument();
  expect(screen.getByText("Administrator accounts")).toBeInTheDocument();
  expect(screen.getByText("Admin sign-in policy")).toBeInTheDocument();
  expect(screen.getByText("SSO configuration")).toBeInTheDocument();
  expect(screen.getByText("New model defaults")).toBeInTheDocument();

  const apiDefault = screen.getByRole("switch", { name: "Default users can use downstream API" });
  expect(apiDefault).not.toBeDisabled();
  fireEvent.click(apiDefault);
  await waitFor(() =>
    expect(updateGroup).toHaveBeenCalledWith(
      "user-admin",
      defaultGroup.id,
      expect.objectContaining({ permissions: expect.objectContaining({ api_access: true }) }),
      expect.any(Object),
    ),
  );
  expect(await screen.findByText("Default user policy saved.")).toBeInTheDocument();

  expect(screen.getByRole("switch", { name: "Default users can build agents" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Default users can use memory" })).toBeDisabled();
  expect(screen.getByRole("heading", { name: "Memory governance" })).toBeInTheDocument();
  expandPanel("Memory governance");
  expect(screen.getByText(/personalization memory is unavailable under the current service policy/i)).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/platform owner/i);
});

test("every policy panel is collapsed by default when memory is available", () => {
  const data = cloneData();
  data.platformSettings = { ...data.platformSettings!, memory_enabled: true };
  data.memoryPolicy = {
    tenant_id: data.currentTenant.id,
    enabled: true,
    auto_capture_enabled: true,
    retention_days: 365,
    max_memories_per_user: 200,
    excluded_kinds: [],
    updated_at: "2026-08-03T00:00:00Z",
  };

  renderAdmin({}, data);
  selectTab("Policies");

  expect(screen.getByRole("heading", { name: "Policy Controls" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Personalization Memory" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Memory by User" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Expand panel" })).toHaveLength(4);
  expect(screen.queryByText("Service policy defines which capabilities are available.", { exact: false })).not.toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: "Memory for this organization" })).not.toBeInTheDocument();
  expect(screen.queryByText("No memories stored yet")).not.toBeInTheDocument();
});

test("retention tags live in the audit prompt panel and policies keep the toggles", async () => {
  const policy = {
    tenant_id: "tenant-synthetic",
    enabled: false,
    chat_retention_days: 0,
    retention_basis: "last_activity" as const,
    action: "purge" as const,
    grace_days: 0,
    notify_admins: false,
    mcp_tagging_enabled: false,
    attachment_tagging_enabled: false,
    subject_tagging_enabled: false,
    external_tags_enabled: false,
    rules: [],
    updated_at: "",
  };
  const getRetentionPolicy = vi.fn(async () => policy);
  const updateRetentionPolicy = vi.fn(
    async (
      _actorId: string,
      patch: { mcp_tagging_enabled?: boolean; attachment_tagging_enabled?: boolean },
    ) => ({ ...policy, ...patch }),
  );
  const listRetentionThreads = vi.fn(async () => [
    {
      thread_id: "thread-box-1",
      title: "Box contract review",
      owner_user_id: "user-jane",
      tags: [
        {
          id: "tag-1",
          tenant_id: "tenant-synthetic",
          thread_id: "thread-box-1",
          namespace: "mcp",
          key: "tool-box",
          value: "Box",
          source: "auto" as const,
          applied_at: "2026-08-16T00:00:00Z",
        },
      ],
    },
    {
      thread_id: "thread-plain-1",
      title: "Untagged research chat",
      owner_user_id: "user-jane",
      archived: true,
      tags: [],
    },
  ]);

  renderAdmin({ getRetentionPolicy, updateRetentionPolicy, listRetentionThreads });
  selectTab("Audit");
  expandPanel("User Prompt Activity");
  fireEvent.click(screen.getByRole("button", { name: "Tags" }));
  expect(await screen.findByText("Box contract review")).toBeInTheDocument();
  expect(screen.getByText("mcp: tool-box / Box")).toBeInTheDocument();
  // Untagged chats list too — batch actions must cover every conversation.
  expect(screen.getByText("Untagged research chat")).toBeInTheDocument();
  expect(screen.getByText("archived")).toBeInTheDocument();
  // The search box and namespace filter narrow the bounded list.
  fireEvent.change(screen.getByRole("searchbox", { name: "Search chats and tags" }), {
    target: { value: "box" },
  });
  expect(screen.queryByText("Untagged research chat")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search chats and tags" }), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by tag type" }), {
    target: { value: "untagged" },
  });
  expect(screen.queryByText("Box contract review")).not.toBeInTheDocument();
  expect(screen.getByText("Untagged research chat")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by tag type" }), {
    target: { value: "all" },
  });

  selectTab("Policies");
  expect(await screen.findByRole("heading", { name: "Data Retention" })).toBeInTheDocument();
  expandPanel("Data Retention");
  const toggle = screen.getByRole("switch", { name: "Tag chats that use MCP connections" });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(updateRetentionPolicy).toHaveBeenCalledWith(
      "user-admin",
      { mcp_tagging_enabled: true },
      expect.any(Object),
    ),
  );
  expect(await screen.findByText("Retention policy saved.")).toBeInTheDocument();

  const uploadsToggle = screen.getByRole("switch", { name: "Tag chats with file uploads" });
  fireEvent.click(uploadsToggle);
  await waitFor(() =>
    expect(updateRetentionPolicy).toHaveBeenCalledWith(
      "user-admin",
      { attachment_tagging_enabled: true },
      expect.any(Object),
    ),
  );

  const subjectToggle = screen.getByRole("switch", { name: "Tag chats by subject" });
  fireEvent.click(subjectToggle);
  await waitFor(() =>
    expect(updateRetentionPolicy).toHaveBeenCalledWith(
      "user-admin",
      { subject_tagging_enabled: true },
      expect.any(Object),
    ),
  );
});

test("data retention rows preview the full conversation and batch delete with confirm", async () => {
  const policy = {
    tenant_id: "tenant-synthetic",
    enabled: false,
    chat_retention_days: 0,
    retention_basis: "last_activity" as const,
    action: "purge" as const,
    grace_days: 0,
    notify_admins: false,
    mcp_tagging_enabled: true,
    attachment_tagging_enabled: false,
    subject_tagging_enabled: false,
    external_tags_enabled: false,
    rules: [],
    updated_at: "",
  };
  const tag = (threadId: string) => ({
    id: `tag-${threadId}`,
    tenant_id: "tenant-synthetic",
    thread_id: threadId,
    namespace: "mcp",
    key: "tool-box",
    value: "Box",
    source: "auto" as const,
    applied_at: "2026-08-16T00:00:00Z",
  });
  const getRetentionPolicy = vi.fn(async () => policy);
  const listRetentionThreads = vi.fn(async () => [
    { thread_id: "thread-box-1", title: "Box contract review", owner_user_id: "user-jane", tags: [tag("thread-box-1")] },
    { thread_id: "thread-box-2", title: "Box billing", owner_user_id: "user-jane", tags: [tag("thread-box-2")] },
  ]);
  const listThreadPromptActivity = vi.fn(async (_actorId: string, threadId: string) => [
    {
      id: "p2",
      user_id: "user-jane",
      user_name: "Jane",
      user_email: "jane@example.test",
      thread_id: threadId,
      thread_title: "Box contract review",
      model_id: "model-synthetic",
      content: "Second question",
      created_at: "10:05 AM",
      alert_count: 0,
      response_content: "Second answer",
    },
    {
      id: "p1",
      user_id: "user-jane",
      user_name: "Jane",
      user_email: "jane@example.test",
      thread_id: threadId,
      thread_title: "Box contract review",
      model_id: "model-synthetic",
      content: "First question",
      created_at: "10:00 AM",
      alert_count: 0,
      response_content: "First answer",
    },
  ]);
  const runRetentionBatch = vi.fn(async () => ({
    action: "delete",
    requested: 2,
    disposed: 1,
    skipped_held: 1,
    skipped_missing: 0,
  }));

  renderAdmin({ getRetentionPolicy, listRetentionThreads, listThreadPromptActivity, runRetentionBatch });
  selectTab("Audit");
  expandPanel("User Prompt Activity");
  fireEvent.click(screen.getByRole("button", { name: "Tags" }));

  fireEvent.click(
    await screen.findByRole("button", { name: "Preview the full conversation: Box contract review" }),
  );
  expect(await screen.findByRole("dialog", { name: "Tagged conversation" })).toBeInTheDocument();
  expect(await screen.findByText("First question")).toBeInTheDocument();
  expect(screen.getByText("Second answer")).toBeInTheDocument();
  expect(screen.getByText(/2 exchanges in this conversation, oldest first\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close conversation preview" }));

  fireEvent.click(screen.getByRole("checkbox", { name: "Select all listed chats" }));
  fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
  expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Yes, delete/ }));
  await waitFor(() =>
    expect(runRetentionBatch).toHaveBeenCalledWith(
      "user-admin",
      { action: "delete", thread_ids: ["thread-box-1", "thread-box-2"] },
      expect.any(Object),
    ),
  );
  expect(
    await screen.findByText("Deleted 1 chat. 1 under an active legal hold was skipped."),
  ).toBeInTheDocument();
});

test("admin documentation lists narrated walkthroughs for every console tab", async () => {
  renderAdmin({});
  fireEvent.click(screen.getByRole("button", { name: "Documentation" }));

  expect(await screen.findByRole("dialog", { name: "Admin console documentation" })).toBeInTheDocument();
  for (const title of [
    "Users and accounts",
    "Groups and permissions",
    "Tenant model access",
    "Connections and response actions",
    "Tenant SSO and provisioning",
    "Tenant analytics",
    "Policies and memory governance",
    "Tenant audit",
    "Alerts and delivery",
    "Data retention and tagging",
  ]) {
    expect(screen.getByRole("button", { name: `Watch ${title}` })).toBeInTheDocument();
  }
  expect(screen.getAllByText(/Remotion video$/)).toHaveLength(10);

  const guidePdf = screen.getByRole("link", { name: /Administrator guide \(PDF\)/ });
  expect(guidePdf).toHaveAttribute("href", "docs/aperture-admin-guide.pdf");
  expect(guidePdf).toHaveAttribute("download");

  fireEvent.click(screen.getByRole("button", { name: "Watch Tenant SSO and provisioning" }));
  expect(screen.getByRole("dialog", { name: "Tenant SSO and provisioning video" })).toBeInTheDocument();
  expect(screen.getByTestId("remotion-player")).toHaveAttribute("data-audio-src", "training/admin/admin-sso.mp3");
  expect(screen.getByText("Voiceover, captions, and title cards use the same timeline.")).toBeInTheDocument();
  expect(screen.getByText("Setup checklist")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Back to documentation videos" }));
  fireEvent.click(screen.getByRole("button", { name: "Watch Policies and memory governance" }));
  expect(screen.getByRole("dialog", { name: "Policies and memory governance video" })).toBeInTheDocument();
  expect(screen.getByTestId("remotion-player")).toHaveAttribute("data-audio-src", "training/admin/admin-policies.mp3");
  expect(screen.getByText(/all start collapsed/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Back to documentation videos" }));
  fireEvent.click(screen.getByRole("button", { name: "Close documentation" }));
  expect(screen.queryByRole("dialog", { name: "Admin console documentation" })).not.toBeInTheDocument();
});

function renderAdmin(adminApi: AdminConsoleApi, initialData = cloneData()) {
  function Harness() {
    const [data, setData] = useState<BootstrapData>(() => initialData);
    return <AdminConsole data={data} onDataChange={setData} adminApi={adminApi} />;
  }

  return render(<Harness />);
}

function selectTab(name: string, options: { last?: boolean } = {}) {
  const tabs = screen.getAllByRole("tab", { name });
  const tab = options.last ? tabs[tabs.length - 1] : tabs[0];
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

function expandPanel(title: string) {
  const heading = screen.getByRole("heading", { name: title });
  const panel = heading.closest(".panel") as HTMLElement;
  const toggle = within(panel).queryByRole("button", { name: "Expand panel" });
  if (toggle) fireEvent.click(toggle);
}

function cloneData(): BootstrapData {
  return structuredClone(sampleData) as BootstrapData;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("admin sets a temporary password for a regular user but not for peers", async () => {
  const resetUserPassword = vi.fn().mockResolvedValue(undefined);
  renderAdmin({ resetUserPassword });

  // data.me is Alex Morgan (TENANT_ADMIN): peer-administrator actions stay off-limits.
  const peerRow = screen.getByText("Drew Parker").closest("tr")!;
  expect(within(peerRow).getByRole("button", { name: /Password/ })).toBeDisabled();
  expect(within(peerRow).getByRole("button", { name: /Password/ })).toHaveAttribute(
    "data-tooltip",
    "Administrator password resets are managed outside this console",
  );

  const userRow = screen.getByText("Jane Smith").closest("tr")!;
  fireEvent.click(within(userRow).getByRole("button", { name: /Password/ }));

  const dialog = screen.getByRole("dialog", { name: /Set a password for Jane Smith/ });
  fireEvent.click(within(dialog).getByRole("button", { name: /Generate/ }));
  const passwordInput = within(dialog).getByPlaceholderText("At least 12 characters") as HTMLInputElement;
  expect(passwordInput.value.length).toBeGreaterThanOrEqual(12);
  fireEvent.change(passwordInput, { target: { value: "starter-password-123" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Set password" }));

  await screen.findByText(/Password set for Jane Smith/);
  expect(resetUserPassword).toHaveBeenCalledTimes(1);
  const [actorId, targetId, payload] = resetUserPassword.mock.calls[0];
  expect(actorId).toBe(sampleData.me.id);
  expect(targetId).toBe(sampleData.users.find((user) => user.display_name === "Jane Smith")!.id);
  expect(payload).toEqual({ password: "starter-password-123", temporary: true });
  expect(within(dialog).getByRole("button", { name: /Copy/ })).toBeInTheDocument();
});

test("alerts tab shows honest unconfigured email status and creates a rule from the template", async () => {
  const createAlertRule = vi.fn(async () => undefined);
  const adminApi: AdminConsoleApi = {
    listAlertRules: vi.fn(async () => []),
    createAlertRule,
    updateAlertRule: vi.fn(async () => undefined),
    deleteAlertRule: vi.fn(async () => undefined),
    listAlertNotifications: vi.fn(async () => []),
    getAlertEmailStatus: vi.fn(async () => ({
      configured: false,
      from_address: "",
      message:
        "Email delivery is not configured. Alerts are still logged in-app; email delivery configuration is managed at the service level.",
    })),
  };

  renderAdmin(adminApi);
  selectTab("Alerts");

  expect(await screen.findByText("Email not configured")).toBeInTheDocument();
  expect(screen.getByText(/Alerts are still logged in-app/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Suspicious-activity template/ }));
  expect(screen.getByLabelText("Action patterns")).toHaveValue("security.*");
  fireEvent.change(screen.getByLabelText("Email recipients"), { target: { value: "soc@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Rule" }));

  await waitFor(() => expect(createAlertRule).toHaveBeenCalled());
  expect(createAlertRule).toHaveBeenCalledWith(
    "user-admin",
    expect.objectContaining({
      name: "Suspicious activity",
      action_patterns: ["security.*"],
      min_severity: "warning",
      recipients: ["soc@example.com"],
    }),
    expect.any(Object),
  );
});

test("alert deliveries render real failure detail with an honest status pill", async () => {
  const adminApi: AdminConsoleApi = {
    listAlertRules: vi.fn(async () => []),
    createAlertRule: vi.fn(async () => undefined),
    updateAlertRule: vi.fn(async () => undefined),
    deleteAlertRule: vi.fn(async () => undefined),
    listAlertNotifications: vi.fn(async () => [
      {
        id: "alertnotif-1",
        rule_id: "alertrule-1",
        rule_name: "Suspicious activity",
        scope: "tenant",
        tenant_id: "tenant-example",
        event_id: "audit-1",
        event_action: "security.prompt_flagged",
        event_severity: "critical",
        actor_id: "user-jane",
        actor_name: "Jane Smith",
        summary: "PROMPT_FLAGGED · prompt-1",
        matched_count: 1,
        recipients: ["soc@example.com"],
        status: "failed",
        status_detail: "Connection refused by smtp.example.com",
        attempts: 5,
        created_at: "2026-07-15T10:00:00+00:00",
        delivered_at: null,
      },
    ]),
    getAlertEmailStatus: vi.fn(async () => ({ configured: true, from_address: "alerts@example.com", message: "ok" })),
  };

  renderAdmin(adminApi);
  selectTab("Alerts");

  expect(await screen.findByText("failed")).toBeInTheDocument();
  expect(screen.getByText(/Connection refused by smtp.example.com/)).toBeInTheDocument();
  expect(screen.getByText(/5 attempts/)).toBeInTheDocument();
});

test("audit trail severity pills carry reasons and the severity filter narrows rows", async () => {
  const adminApi: AdminConsoleApi = {
    listAuditEvents: vi.fn(async () => [
      {
        id: "audit-critical",
        tenant_id: "tenant-example",
        actor_id: "user-admin",
        actor_name: "Alex Admin",
        actor_role: "TENANT_ADMIN",
        action: "admin.user_deleted",
        action_type: "USER_DELETED",
        target: "user-x",
        target_type: "user",
        target_name: "Departed User",
        detail: "",
        created_at: "2026-07-15T10:00:00+00:00",
        redacted: true,
        metadata: {},
        severity: "critical",
        severity_reason: "A user account was permanently deleted.",
      },
      {
        id: "audit-info",
        tenant_id: "tenant-example",
        actor_id: "user-jane",
        actor_name: "Jane Smith",
        actor_role: "USER",
        action: "chat.thread_saved",
        action_type: "THREAD_SAVED",
        target: "thread-1",
        target_type: "chat",
        target_name: "Weekly sync",
        detail: "",
        created_at: "2026-07-15T09:00:00+00:00",
        redacted: true,
        metadata: {},
        severity: "info",
        severity_reason: "No elevated rule matched; routine activity.",
      },
    ]),
  };

  const { container } = renderAdmin(adminApi);
  selectTab("Audit");

  expandPanel("Audit Trail");
  expect(await screen.findByText("USER_DELETED")).toBeInTheDocument();
  expect(screen.getByText("THREAD_SAVED")).toBeInTheDocument();
  const reasonPill = container.querySelector(
    '.audit-severity-pill[data-tooltip="A user account was permanently deleted."]',
  );
  expect(reasonPill).not.toBeNull();

  fireEvent.change(screen.getByLabelText("Filter audit events by severity"), {
    target: { value: "critical" },
  });
  expect(screen.getByText("USER_DELETED")).toBeInTheDocument();
  expect(screen.queryByText("THREAD_SAVED")).not.toBeInTheDocument();
  expect(screen.getByText("1 of 2 events")).toBeInTheDocument();
});

test("user usage panel renders honest token dashes and never lists platform owners", async () => {
  const adminApi: AdminConsoleApi = {
    getUsageSummary: vi.fn(async () => ({
      totals: {
        messages: 3,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        active_users: 2,
        models_used: 1,
        tokens_reported_messages: 0,
      },
      by_user: [
        {
          user_id: "user-jane",
          user_name: "Jane Smith",
          user_role: "USER",
          message_count: 2,
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          model_count: 1,
          surfaces: ["chat"],
          last_active_at: "2026-07-15T10:00:00+00:00",
        },
      ],
      by_model: [
        {
          model_id: "gpt-4o-mini",
          provider_name: "Azure OpenAI",
          message_count: 3,
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          user_count: 2,
          last_used_at: "2026-07-15T10:00:00+00:00",
        },
      ],
      by_day: [{ date: "2026-07-15", message_count: 3, total_tokens: null }],
      by_surface: [{ surface: "chat", message_count: 3 }],
      backfilled_record_count: 0,
    })),
    listUsageRecords: vi.fn(async () => []),
  };

  const data = cloneData();
  renderAdmin(adminApi, data);
  selectTab("Analytics");

  expandPanel("User Usage");
  expect(await screen.findByText("Usage by user")).toBeInTheDocument();
  const totalTokensTile = screen.getByText("Total tokens").closest(".feedback-summary-card")!;
  expect(within(totalTokensTile as HTMLElement).getByText("—")).toBeInTheDocument();
  expect(
    within(totalTokensTile as HTMLElement).getByText("0 of 3 messages reported tokens"),
  ).toBeInTheDocument();

  const usagePicker = screen.getByLabelText("Usage filter user");
  const ownerNames = data.users
    .filter((user) => user.role === "PLATFORM_OWNER")
    .map((user) => user.display_name);
  for (const ownerName of ownerNames) {
    expect(within(usagePicker).queryByText(ownerName)).not.toBeInTheDocument();
  }
});

test("analytics shows the tenant daily token budget read-only", async () => {
  const fetchMock = vi.mocked(globalThis.fetch);
  const offlineResponse = () =>
    new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  fetchMock.mockImplementation(async (input) => {
    if (String(input).endsWith("/api/admin/usage-budget")) {
      return new Response(
        JSON.stringify({
          tenant_id: "tenant-example",
          budget_unit: "tokens",
          budget_period: "day",
          limit_value: 0,
          daily_token_limit: 0,
          spend_limit_nanos: 0,
          updated_at: "2026-07-20T00:00:00+00:00",
          updated_by: "user-owner",
          usage_date: "2026-07-20",
          period_start: "2026-07-20",
          period_end: "2026-07-20",
          reported_tokens: 4321,
          reported_tokens_overflowed: false,
          reported_cost_nanos: 0,
          reported_cost_usd: 0,
          reported_cost_overflowed: false,
          metered_completions: 5,
          unmetered_completions: 3,
          cost_metered_completions: 0,
          cost_unmetered_completions: 8,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return offlineResponse();
  });

  try {
    renderAdmin({});
    selectTab("Analytics");

    expect(await screen.findByText("Workspace Usage Budget")).toBeInTheDocument();
    expandPanel("Workspace Usage Budget");
    expect(await screen.findByText("Unlimited")).toBeInTheDocument();
    expect(screen.getByText("4,321")).toBeInTheDocument();
    expect(screen.getByText("UTC 2026-07-20 – 2026-07-20.")).toBeInTheDocument();

    // Metered and unmetered completions stay distinct values.
    const meteredCard = screen.getByText("Reported completions").closest(".feedback-summary-card") as HTMLElement;
    expect(within(meteredCard).getByText("5")).toBeInTheDocument();
    const unmeteredCard = screen
      .getByText("Unreported completions")
      .closest(".feedback-summary-card") as HTMLElement;
    expect(within(unmeteredCard).getByText("3")).toBeInTheDocument();

    // Read-only for organization admins: honest service-policy status, no edit input.
    expect(screen.getByText(/managed at the service level/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Token budget limit")).not.toBeInTheDocument();
  } finally {
    // Restore the suite's hermetic offline default for any later tests.
    fetchMock.mockImplementation(async () => offlineResponse());
  }
});

test("token allocations panel manages per-user and per-group daily caps", async () => {
  const fetchMock = vi.mocked(globalThis.fetch);
  const putRequests: unknown[] = [];
  let allocations = [
    {
      principal_type: "group",
      principal_id: "group-litigation",
      display_name: "Litigation",
      budget_period: "day",
      daily_token_limit: 40000,
      period_start: "2026-07-21",
      period_end: "2026-07-21",
      reported_tokens: 40000,
      metered_completions: 12,
      updated_at: "2026-07-21T00:00:00+00:00",
      updated_by: "user-admin",
    },
  ];
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url.endsWith("/api/admin/usage-allocations") && method === "GET") {
      return new Response(
        JSON.stringify({
          usage_date: "2026-07-21",
          budget_unit: "tokens",
          budget_period: "day",
          limit_value: 50000,
          daily_token_limit: 50000,
          allocations,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/admin/usage-allocations") && method === "PUT") {
      const body = JSON.parse(String((init as RequestInit).body));
      putRequests.push(body);
      allocations = [
        ...allocations,
        {
          principal_type: body.principal_type,
          principal_id: body.principal_id,
          display_name: body.principal_id,
          budget_period: body.budget_period,
          daily_token_limit: body.daily_token_limit,
          period_start: "2026-07-21",
          period_end: "2026-07-21",
          reported_tokens: 0,
          metered_completions: 0,
          updated_at: "2026-07-21T00:00:00+00:00",
          updated_by: "user-admin",
        },
      ];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/admin/usage-allocations/group/group-litigation") && method === "DELETE") {
      allocations = allocations.filter((row) => row.principal_id !== "group-litigation");
      return new Response(JSON.stringify({ removed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    renderAdmin({});
    selectTab("Analytics");

    // The exhausted group meter shows honest numbers against its cap.
    expect(await screen.findByText("Token Allocations")).toBeInTheDocument();
    expandPanel("Token Allocations");
    expect(await screen.findByText("Litigation")).toBeInTheDocument();
    expect(screen.getByText(/40,000 \/ 40,000/)).toBeInTheDocument();

    // Oversubscription is impossible here (40k < 50k ceiling): no warning.
    expect(screen.queryByText(/more than the/)).not.toBeInTheDocument();

    // Add a user cap.
    const picker = screen.getByLabelText("Allocation principal");
    const userOption = within(picker).getAllByRole("option").find((option) =>
      option.textContent?.startsWith("User ·"),
    ) as HTMLOptionElement;
    fireEvent.change(picker, { target: { value: userOption.value } });
    fireEvent.change(screen.getByLabelText("Token cap"), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "Set cap" }));
    await waitFor(() => expect(putRequests).toHaveLength(1));
    expect(putRequests[0]).toMatchObject({
      daily_token_limit: 1500,
      budget_period: "day",
      principal_type: "user",
    });

    // Remove the group cap.
    fireEvent.click(screen.getByRole("button", { name: "Remove allocation for Litigation" }));
    await waitFor(() => expect(screen.queryByText("Litigation")).not.toBeInTheDocument());
  } finally {
    fetchMock.mockReset();
  }
});

test("prompt phrase search filters exchanges and finds chats by matter number", async () => {
  const promptRecords = [
    {
      id: "message-jane-matter",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane@example.test",
      thread_id: "thread-matter-1",
      thread_title: "Acme merger diligence",
      model_id: "model-synthetic",
      content: "Summarize the escrow terms.",
      created_at: "Jul 6, 2026, 5:00 PM UTC",
      created_at_iso: "2026-07-06T23:00:00Z",
      alert_count: 0,
    },
    {
      id: "message-casey-billing",
      user_id: "user-casey",
      user_name: "Casey Doe",
      user_email: "casey@example.test",
      thread_id: "thread-billing-1",
      thread_title: "Billing question",
      model_id: "model-synthetic",
      content: "Casey asks about billing.",
      created_at: "Jul 6, 2026, 6:00 PM UTC",
      created_at_iso: "2026-07-07T00:00:00Z",
      alert_count: 0,
    },
  ];
  const listPromptActivity = vi.fn(async () => promptRecords);
  const listRetentionThreads = vi.fn(async () => [
    {
      thread_id: "thread-matter-1",
      title: "Acme merger diligence",
      owner_user_id: "user-jane",
      matter_id: "matter-acme-001",
      matter_label: "Acme Corp — 12345.001 Merger",
      tags: [],
    },
  ]);

  renderAdmin({ listPromptActivity, listRetentionThreads });
  selectTab("Audit");
  expandPanel("User Prompt Activity");
  expect(await screen.findByText("Acme merger diligence")).toBeInTheDocument();

  const search = screen.getByRole("searchbox", { name: "Search prompt activity" });
  // Phrase search over prompt text.
  fireEvent.change(search, { target: { value: "billing" } });
  expect(screen.getByText("Billing question")).toBeInTheDocument();
  expect(screen.queryByText("Acme merger diligence")).not.toBeInTheDocument();
  // Client/matter number search rides the retention matter labels.
  fireEvent.change(search, { target: { value: "12345.001" } });
  expect(screen.getByText("Acme merger diligence")).toBeInTheDocument();
  expect(screen.queryByText("Billing question")).not.toBeInTheDocument();
  expect(screen.getByText("1 of 2 prompts")).toBeInTheDocument();
  // A miss says so instead of showing an empty void.
  fireEvent.change(search, { target: { value: "no-such-phrase" } });
  expect(screen.getByText("No prompts match this search.")).toBeInTheDocument();

  // The Tags side shows and searches the same matter label.
  fireEvent.click(screen.getByRole("button", { name: "Tags" }));
  expect(await screen.findByText("matter: Acme Corp — 12345.001 Merger")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search chats and tags" }), {
    target: { value: "acme" },
  });
  expect(screen.getByText("Acme merger diligence")).toBeInTheDocument();
});
