import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData, ToolConfig } from "../lib/types";
import { buildUpdatePayload, connectionIssues, ToolsLibrary } from "./ToolsLibrary";

type Call = { url: string; method: string; body: Record<string, unknown> | null };

let currentData: BootstrapData;
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Echo a PATCH/POST back as the API's ToolConfigRecord for `tool`. */
function recordFor(tool: ToolConfig, body: Record<string, unknown> = {}) {
  const settings = {
    description: tool.description,
    transport: tool.transport,
    auth_type: tool.auth_type,
    client_id: tool.client_id,
    oauth_authorization_url: tool.oauth_authorization_url,
    oauth_token_url: tool.oauth_token_url,
    command: tool.command,
    args: tool.args,
    scopes: tool.scopes,
    hermes_companion: tool.hermes_companion,
    runtime_invocations: tool.runtime_invocations,
    ...((body.settings as Record<string, unknown>) ?? {}),
  };
  return {
    id: tool.id,
    tenant_id: "tenant-example",
    name: (body.name as string) ?? tool.name,
    tool_type: tool.type,
    endpoint_url: (body.endpoint_url as string) ?? tool.endpoint ?? null,
    enabled: (body.enabled as boolean) ?? tool.enabled,
    approval_required: (body.approval_required as boolean) ?? tool.approval_required,
    allowed_group_ids: (body.allowed_group_ids as string[]) ?? tool.allowed_group_ids,
    owner_user_id: tool.owner_user_id ?? null,
    secret_set: Boolean(tool.secret_set),
    settings: Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)),
  };
}

const httpTool: ToolConfig = {
  id: "tool-docs-http",
  name: "Docs Search",
  description: "Searches the internal docs site.",
  type: "mcp",
  status: "ready",
  enabled: false,
  approval_required: true,
  allowed_group_ids: [],
  scopes: [],
  connected_model_ids: [],
  endpoint: "https://mcp.example.com/mcp",
  transport: "http",
  auth_type: "none",
  runtime_invocations: [{ tool_name: "search", label: "Docs search", arguments: { q: "{{query}}" } }],
};

const oauthTool: ToolConfig = {
  ...httpTool,
  id: "tool-docs-oauth",
  name: "Docs OAuth",
  enabled: true,
  auth_type: "oauth-2.1-static",
  client_id: "client-docs",
  oauth_authorization_url: "https://auth.example.com/authorize",
  oauth_token_url: "https://auth.example.com/token",
  oauth_callback_url: "https://aperture.example.com/api/tools/tool-docs-oauth/oauth/callback",
  oauth_token_stored: false,
};

beforeEach(() => {
  calls = [];
  currentData = { ...sampleData, tools: [...sampleData.tools, httpTool] };
  respond = () => new Response("unexpected request", { status: 500 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      calls.push(call);
      return respond(call);
    }),
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderTools() {
  function Harness() {
    const [data, setData] = useState(currentData);
    return (
      <div className="library-page">
        <ToolsLibrary
          data={data}
          onDataChange={(updater) =>
            setData((current) => {
              const next = updater(current);
              currentData = next;
              return next;
            })
          }
        />
      </div>
    );
  }
  return render(<Harness />);
}

function card(name: string) {
  return screen.getByRole("article", { name });
}

/** Radix tab triggers activate on mouse down. */
function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

test("a refused Enable switch reverts and says why", async () => {
  respond = () => json({ detail: "MCP stdio commands are managed at the service level." }, 403);
  renderTools();
  const toggle = within(card("Docs Search")).getByRole("switch", { name: "Turn Docs Search on or off" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  fireEvent.click(toggle);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Docs Search was not turned on: MCP stdio commands are managed at the service level.",
  );
  expect(within(card("Docs Search")).getByRole("switch", { name: "Turn Docs Search on or off" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  expect(currentData.tools.find((tool) => tool.id === httpTool.id)?.enabled).toBe(false);
  // The switch sends only the enabled flag, never stdio command settings.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "PATCH", body: { enabled: true } });
});

test("Enable sends only {enabled} and keeps the server's answer", async () => {
  respond = (call) => json(recordFor(httpTool, call.body ?? {}));
  renderTools();
  fireEvent.click(within(card("Docs Search")).getByRole("switch", { name: "Turn Docs Search on or off" }));
  expect(await screen.findByText("Docs Search is on.")).toBeInTheDocument();
  expect(calls[0].body).toEqual({ enabled: true });
  expect(within(card("Docs Search")).getByText("On", { selector: ".ws-badge" })).toBeInTheDocument();
});

test("Add connection saves nothing until the form is submitted, and saves no invented defaults", async () => {
  respond = (call) =>
    json({
      id: "tool-new-1",
      tenant_id: "tenant-example",
      name: call.body?.name,
      tool_type: "mcp",
      endpoint_url: call.body?.endpoint_url,
      enabled: false,
      approval_required: true,
      allowed_group_ids: [],
      owner_user_id: null,
      secret_set: false,
      settings: call.body?.settings,
    }, 201);
  renderTools();
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  const form = screen.getByRole("form", { name: "Add a connection" });
  expect(calls).toHaveLength(0);
  const submit = within(form).getByRole("button", { name: "Add connection" });
  expect(submit).toBeDisabled();
  // Tenant admins cannot configure a command that runs on the server.
  expect(within(form).queryByRole("button", { name: /Local command/ })).not.toBeInTheDocument();

  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Matter search" } });
  fireEvent.change(within(form).getByLabelText("Server URL"), { target: { value: "mcp://not-a-url" } });
  expect(within(form).getByText("Use a full address starting with https://")).toBeInTheDocument();
  expect(submit).toBeDisabled();
  fireEvent.change(within(form).getByLabelText("Server URL"), { target: { value: "https://mcp.example.com/mcp" } });
  expect(calls).toHaveLength(0);
  fireEvent.click(submit);

  await screen.findByRole("heading", { name: "Matter search" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringContaining("/api/admin/tool-configs") });
  expect(calls[0].body).toEqual({
    name: "Matter search",
    tool_type: "mcp",
    endpoint_url: "https://mcp.example.com/mcp",
    enabled: false,
    approval_required: true,
    allowed_group_ids: [],
    settings: { transport: "http" },
  });
  expect(JSON.stringify(calls[0].body)).not.toMatch(/mcp:\/\/new-tool|tenant\.tool|schema discovery/);
});

test("a failed Add connection keeps the form and the catalog unchanged, and retry opens the saved connection", async () => {
  currentData = { ...currentData, tools: [] };
  let attempts = 0;
  respond = (call) => {
    attempts += 1;
    if (attempts === 1) return json({ detail: "Temporarily unavailable" }, 503);
    return json({
      ...call.body,
      id: "tool-verified",
      tenant_id: "tenant-example",
      owner_user_id: null,
      secret_set: false,
    }, 201);
  };
  renderTools();
  // Empty state offers the same single action.
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  const form = screen.getByRole("form", { name: "Add a connection" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Matter search" } });
  fireEvent.change(within(form).getByLabelText("Server URL"), { target: { value: "https://mcp.example.com/mcp" } });
  fireEvent.click(within(form).getByRole("button", { name: "Add connection" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("The connection was not added: Temporarily unavailable");
  expect(currentData.tools).toHaveLength(0);
  expect(within(screen.getByRole("form", { name: "Add a connection" })).getByLabelText("Name")).toHaveValue("Matter search");

  fireEvent.click(within(screen.getByRole("form", { name: "Add a connection" })).getByRole("button", { name: "Add connection" }));
  await waitFor(() => expect(currentData.tools).toHaveLength(1));
  expect(currentData.tools[0]).toMatchObject({ id: "tool-verified", enabled: false });
  expect(await screen.findByRole("heading", { name: "Matter search" })).toBeInTheDocument();
  expect(screen.getByLabelText("Server URL")).toHaveValue("https://mcp.example.com/mcp");
  expect(screen.getByText(/was added and is off/)).toBeInTheDocument();
});

test("Test and Run are disabled while there are unsaved changes", async () => {
  respond = (call) => json(recordFor(httpTool, call.body ?? {}));
  renderTools();
  fireEvent.click(within(card("Docs Search")).getByRole("button", { name: "Edit Docs Search" }));
  openTab("Test");
  expect(screen.getByRole("button", { name: /Test connection/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: /Run Docs search/ })).toBeEnabled();

  openTab("Connection");
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://mcp.example.com/v2" } });
  openTab("Test");
  expect(screen.getByRole("button", { name: /Test connection/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /Run Docs search/ })).toBeDisabled();
  expect(screen.getByText("Save changes to test them.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Docs Search saved.");
  // Only the changed field is sent.
  expect(calls[0]).toMatchObject({ method: "PATCH", body: { endpoint_url: "https://mcp.example.com/v2" } });
  expect(Object.keys(calls[0].body ?? {})).toEqual(["endpoint_url"]);
  expect(screen.getByRole("button", { name: /Test connection/ })).toBeEnabled();
});

test("saving a service-managed stdio tool as a tenant admin never sends command settings or a new type", async () => {
  const hermes = sampleData.tools.find((tool) => tool.id === "tool-hermes-agent-mcp")!;
  respond = (call) => json(recordFor(hermes, call.body ?? {}));
  renderTools();
  fireEvent.click(within(card("Hermes Agent MCP")).getByRole("button", { name: "Edit Hermes Agent MCP" }));
  expect(screen.getByLabelText("Command")).toHaveAttribute("readonly");
  expect(screen.getByText(/Only the service owner can change how it starts/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hermes" } });
  openTab("Access & approval");
  fireEvent.click(screen.getByRole("switch", { name: "Available to Hermes companion" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Hermes saved.");
  const body = calls[0].body!;
  expect(body).not.toHaveProperty("tool_type");
  expect(body.settings).toEqual({ hermes_companion: false });
  expect(body.settings).not.toHaveProperty("command");
  expect(body.settings).not.toHaveProperty("args");
  expect(body.settings).not.toHaveProperty("transport");
});

test("the Hermes switch is offered only for MCP tools", () => {
  currentData = {
    ...currentData,
    tools: [
      ...currentData.tools,
      { ...httpTool, id: "tool-script", name: "Uppercase", type: "custom_script", endpoint: undefined, transport: undefined },
    ],
  };
  const script = currentData.tools.find((tool) => tool.id === "tool-script")!;
  const { payload } = buildUpdatePayload(
    script,
    {
      name: "Uppercase",
      description: script.description,
      endpoint: "",
      transport: "",
      authType: "none",
      clientId: "",
      oauthAuthorizationUrl: "",
      oauthTokenUrl: "",
      scopesText: "",
      command: "",
      argsText: "",
      runtimeInvocationsText: "",
      secret: "",
      approvalRequired: script.approval_required,
      hermesCompanion: true,
      allowedGroupIds: [],
    },
    { isOwner: false, isAdmin: true },
  );
  expect(payload).toEqual({});
  renderTools();
  // Script tools are edited in Admin → Tools; the Library never re-types them.
  expect(within(card("Uppercase")).queryByRole("button", { name: "Edit Uppercase" })).not.toBeInTheDocument();
  expect(within(card("Uppercase")).getByText(/Admin → Tools/)).toBeInTheDocument();
});

test("standard users see connections they can use without management controls", () => {
  currentData = {
    ...currentData,
    me: { ...sampleData.users.find((user) => user.id === "user-jane")!, role: "USER", group_ids: ["group-finance"] },
    authoringState: { knowledge_enabled: false, tools_enabled: false },
  };
  renderTools();
  expect(screen.getByText(/Connections are managed by your administrators/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add connection" })).not.toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
  // iManage is limited to Litigation and is off, so a Finance user doesn't see it.
  expect(screen.queryByRole("article", { name: "iManage Search MCP" })).not.toBeInTheDocument();
  expect(card("Web Search")).toBeInTheDocument();
});

test("self-authoring users manage their own connections but can't run admin tests", () => {
  const me = { ...sampleData.users.find((user) => user.id === "user-jane")!, role: "USER" as const };
  currentData = {
    ...currentData,
    me,
    authoringState: { knowledge_enabled: false, tools_enabled: true },
    tools: [...currentData.tools, { ...httpTool, id: "tool-mine", name: "My tool", owner_user_id: me.id }],
  };
  renderTools();
  expect(screen.getByRole("button", { name: "Add connection" })).toBeInTheDocument();
  expect(within(card("My tool")).getByText("Only you")).toBeInTheDocument();
  fireEvent.click(within(card("My tool")).getByRole("button", { name: "Edit My tool" }));
  openTab("Test");
  expect(screen.getByRole("button", { name: /Test connection/ })).toBeDisabled();
  expect(screen.getByText("Only administrators can run connection tests.")).toBeInTheDocument();
  openTab("Access & approval");
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByText(/Sharing with groups is managed by administrators/)).toBeInTheDocument();
});

test("Connect with provider uses the server-signed authorize URL", async () => {
  currentData = { ...currentData, tools: [...currentData.tools, oauthTool] };
  const popup = { closed: false, opener: {} as unknown, location: { href: "" }, close: vi.fn() };
  const openSpy = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  respond = (call) => {
    if (call.url.includes("/oauth/authorize-url")) {
      return json({
        authorize_url: "https://auth.example.com/authorize?client_id=client-docs&state=server-signed",
        state: "server-signed",
        redirect_uri: oauthTool.oauth_callback_url,
      });
    }
    if (call.url.endsWith("/api/admin/tool-configs")) {
      return json([{ ...recordFor(oauthTool), settings: { ...recordFor(oauthTool).settings, oauth_token_status: "stored" } }]);
    }
    return new Response("unexpected", { status: 500 });
  };
  renderTools();
  expect(within(card("Docs OAuth")).getByText("Needs setup")).toBeInTheDocument();
  fireEvent.click(within(card("Docs OAuth")).getByRole("button", { name: "Edit Docs OAuth" }));
  expect(screen.getByText(/Needs setup:/).closest(".ws-notice")).toHaveTextContent("Not signed in to the provider");
  openTab("Sign-in");
  expect(screen.getByLabelText("Redirect URL")).toHaveValue(oauthTool.oauth_callback_url);
  fireEvent.click(screen.getByRole("button", { name: /Connect with provider/ }));

  await screen.findByText(/Finish signing in in the window that opened/);
  expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
  expect(calls[0]).toMatchObject({ method: "GET", url: expect.stringContaining("/api/tools/tool-docs-oauth/oauth/authorize-url") });
  expect(popup.location.href).toBe("https://auth.example.com/authorize?client_id=client-docs&state=server-signed");
  expect(popup.opener).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /Check status/ }));
  expect(await screen.findByText("Signed in — token saved")).toBeInTheDocument();
  expect(screen.getByText("Docs OAuth is signed in.")).toBeInTheDocument();
});

test("status reflects real configuration instead of a stored label", () => {
  const imanage = sampleData.tools.find((tool) => tool.id === "tool-imanage-search")!;
  // No transport means a local command, and none is configured.
  expect(connectionIssues(imanage)).toEqual(["No command to run"]);
  expect(connectionIssues(httpTool)).toEqual([]);
  expect(connectionIssues({ ...httpTool, endpoint: "" })).toEqual(["No server URL"]);
  expect(connectionIssues({ ...httpTool, auth_type: "bearer-token", secret_set: false })).toEqual(["No access token saved"]);
  renderTools();
  expect(within(card("iManage Search MCP")).getByText("Needs setup")).toBeInTheDocument();
  expect(within(card("Docs Search")).getByText("Off", { selector: ".ws-badge" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Needs setup/ }));
  expect(screen.queryByRole("article", { name: "Docs Search" })).not.toBeInTheDocument();
  expect(card("iManage Search MCP")).toBeInTheDocument();
});

test("approval copy describes what actually happens", () => {
  renderTools();
  fireEvent.click(within(card("Docs Search")).getByRole("button", { name: "Edit Docs Search" }));
  openTab("Access & approval");
  expect(
    screen.getByText("Before Aperture calls this connection, the person sending the message is asked to approve it in chat."),
  ).toBeInTheDocument();
  expect(screen.queryByText(/automations/i)).not.toBeInTheDocument();
  expect(screen.getByText("Leave every group unchecked to make it available to everyone in the workspace.")).toBeInTheDocument();
  // No secret is saved, so nothing claims one is being "retained".
  openTab("Sign-in");
  fireEvent.click(screen.getByRole("button", { name: "Access token" }));
  expect(screen.getByLabelText("Access token")).toHaveAttribute("placeholder", "Paste the access token");
  expect(screen.getByText("Not saved")).toBeInTheDocument();
});
