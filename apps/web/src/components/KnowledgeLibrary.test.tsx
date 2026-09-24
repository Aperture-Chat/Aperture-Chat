import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData, KnowledgeBase, KnowledgeDocument, KnowledgeSyncResult } from "../lib/types";
import { LibraryConsole } from "./LibraryConsole";

const uploadMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  uploadKnowledgeFile: uploadMock,
}));

type FetchHandler = (url: string, init?: RequestInit) => Response | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function knowledgeBase(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    id: "kb-synthetic",
    name: "Synthetic Matter Files",
    description: "Uploaded files.",
    source: "Uploaded files",
    source_type: "upload",
    linked_sources: [],
    connector_id: "upload",
    status: "synced",
    document_count: 1,
    last_sync: "Sep 23, 2026, 9:00 PM UTC",
    acl: "Groups: Litigation",
    owner_group_id: "group-litigation",
    owner_user_id: sampleData.me.id,
    enabled: true,
    ...overrides,
  };
}

function document(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: "doc-brief",
    knowledge_config_id: "kb-synthetic",
    tenant_id: "tenant-example",
    name: "brief.pdf",
    source_uri: "upload://knowledge/kb-synthetic/brief.pdf",
    source_type: "upload",
    status: "indexed",
    chunk_count: 12,
    acl_group_ids: ["group-litigation"],
    updated_at: "Sep 23, 2026, 9:00 PM UTC",
    citation_required: true,
    ...overrides,
  };
}

function configRecord(base: KnowledgeBase, settings: Record<string, unknown> = {}) {
  return {
    id: base.id,
    tenant_id: "tenant-example",
    name: base.name,
    source_type: base.source_type ?? "upload",
    connector_config_id: null,
    enabled: base.enabled,
    acl_group_ids: base.owner_group_id ? [base.owner_group_id] : [],
    owner_user_id: base.owner_user_id,
    secret_set: false,
    settings: {
      status: base.status,
      document_count: base.document_count,
      last_sync: base.last_sync,
      source: base.source,
      linked_sources: base.linked_sources ?? [],
      ...settings,
    },
  };
}

let requests: Array<{ url: string; method: string; body: unknown }> = [];

function stubFetch(...handlers: FetchHandler[]) {
  requests = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const handler of handlers) {
      const response = handler(url, init);
      if (response) return response;
    }
    if (url.endsWith("/api/knowledge/limits")) {
      return json({ upload_max_mb: 250, max_extracted_chars: 10_000_000, ocr_enabled: true, ocr_max_pages: 250, semantic_search: "on" });
    }
    if (url.includes("/index-status")) {
      return json({ knowledge_config_id: "kb-synthetic", semantic_search: "on", total_chunks: 12, pending_chunks: 0, pending_by_document: {} });
    }
    if (url.includes("/documents") && method === "GET") return json([document()]);
    return json({ detail: `Unhandled ${method} ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderLibrary(bases: KnowledgeBase[], role: BootstrapData["me"]["role"] = "TENANT_ADMIN") {
  let current: BootstrapData = { ...sampleData, me: { ...sampleData.me, role }, knowledgeBases: bases };
  function Harness() {
    const [data, setData] = useState(current);
    return (
      <LibraryConsole
        data={data}
        view="knowledge"
        onDataChange={(updater) =>
          setData((previous) => {
            current = updater(previous);
            return current;
          })
        }
      />
    );
  }
  render(<Harness />);
  return { data: () => current };
}

beforeEach(() => {
  uploadMock.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("knowledge bases render as cards with honest status and open into a detail view", async () => {
  stubFetch();
  renderLibrary([
    knowledgeBase(),
    knowledgeBase({ id: "kb-off", name: "Paused Base", enabled: false }),
    knowledgeBase({ id: "kb-broken", name: "Broken Sync", status: "error", provider_message: "Box token expired." }),
  ]);

  const card = screen.getByRole("article", { name: "Synthetic Matter Files" });
  expect(within(card).getByText("Ready")).toBeInTheDocument();
  expect(within(card).getByText("Files · Shared with Litigation")).toBeInTheDocument();
  expect(within(screen.getByRole("article", { name: "Paused Base" })).getAllByText("Off")).not.toHaveLength(0);
  expect(within(screen.getByRole("article", { name: "Broken Sync" })).getByText("Box token expired.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Needs attention/ })).toBeInTheDocument();
  // Uploads have nothing to sync, so the card offers no Sync action.
  fireEvent.click(within(card).getByRole("button", { name: "More actions for Synthetic Matter Files" }));
  expect(screen.queryByRole("menuitem", { name: /Sync now/ })).not.toBeInTheDocument();

  fireEvent.click(within(card).getByRole("button", { name: "Open" }));
  expect(await screen.findByRole("heading", { name: "Synthetic Matter Files" })).toBeInTheDocument();
  expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
  expect(screen.getByText(/12 passages/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
});

test("search and filter chips narrow the card grid", () => {
  stubFetch();
  renderLibrary([knowledgeBase(), knowledgeBase({ id: "kb-two", name: "Employment Policies", enabled: false })]);
  fireEvent.change(screen.getByLabelText("Search knowledge bases"), { target: { value: "employment" } });
  expect(screen.queryByRole("article", { name: "Synthetic Matter Files" })).not.toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Employment Policies" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search knowledge bases"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /^Off/ }));
  expect(screen.queryByRole("article", { name: "Synthetic Matter Files" })).not.toBeInTheDocument();
});

test("the on/off switch sends only enabled and reverts when the server refuses", async () => {
  const base = knowledgeBase();
  stubFetch((url, init) =>
    url.includes("/api/admin/knowledge-configs/kb-synthetic") && init?.method === "PATCH"
      ? json({ detail: "Knowledge base is locked." }, 409)
      : undefined,
  );
  const view = renderLibrary([base]);
  const toggle = screen.getByRole("switch", { name: "Assistants can search Synthetic Matter Files" });
  fireEvent.click(toggle);

  expect(await screen.findByText(/was not changed: Knowledge base is locked/)).toBeInTheDocument();
  const patch = requests.find((request) => request.method === "PATCH");
  expect(patch?.body).toEqual({ enabled: false });
  await waitFor(() => expect(view.data().knowledgeBases[0].enabled).toBe(true));
  expect(toggle).toHaveAttribute("aria-checked", "true");
});

test("creating a knowledge base opens it ready for files and sends no fake content", async () => {
  stubFetch((url, init) => {
    if (url.endsWith("/api/admin/knowledge-configs") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return json({ ...body, tenant_id: "tenant-example", secret_set: false }, 201);
    }
    if (url.includes("/documents")) return json([]);
    return undefined;
  });
  const view = renderLibrary([]);

  expect(screen.getByRole("heading", { name: "Add your first knowledge base" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Upload files/ }));
  const dialog = screen.getByRole("dialog", { name: "New knowledge base" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Deal Room" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

  expect(await screen.findByRole("heading", { name: "Deal Room" })).toBeInTheDocument();
  const create = requests.find((request) => request.method === "POST");
  expect(create?.body).toMatchObject({ name: "Deal Room", source_type: "upload", acl_group_ids: [], enabled: true });
  expect(view.data().knowledgeBases).toHaveLength(1);
  expect(screen.getByText(/Drag files here/)).toBeInTheDocument();
  expect(await screen.findByText("No files yet. Drop files above to add them.")).toBeInTheDocument();
});

test("uploads run one file per request with progress, skip unreadable types, and report results", async () => {
  const base = knowledgeBase({ document_count: 0 });
  stubFetch((url) => (url.includes("/documents") ? json([]) : undefined));
  let finishFirst: (result: KnowledgeSyncResult) => void = () => undefined;
  uploadMock.mockImplementationOnce(
    (_userId: string, _configId: string, _file: File, options: { onUploadProgress?: (value: number) => void }) =>
      new Promise((resolve) => {
        options.onUploadProgress?.(0.4);
        finishFirst = resolve;
      }),
  );
  uploadMock.mockRejectedValueOnce(new Error("'huge.pdf' exceeds the 250 MB knowledge upload limit."));
  renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await screen.findByText(/Drag files here/);

  fireEvent.change(screen.getByLabelText("Choose files to add"), {
    target: {
      files: [
        new File(["Synthetic brief"], "brief.txt", { type: "text/plain" }),
        new File(["%PDF"], "huge.pdf", { type: "application/pdf" }),
        new File(["legacy"], "old.doc", { type: "application/msword" }),
      ],
    },
  });

  expect(await screen.findByText(/Skipped 1 file: old.doc \(save it as .docx first\)/)).toBeInTheDocument();
  expect(await screen.findByText(/Uploading 40%/)).toBeInTheDocument();
  expect(await screen.findByText(/exceeds the 250 MB knowledge upload limit/)).toBeInTheDocument();
  expect(uploadMock).toHaveBeenCalledTimes(2);
  expect(uploadMock.mock.calls.map((call) => (call[2] as File).name)).toEqual(["brief.txt", "huge.pdf"]);

  await act(async () =>
    finishFirst({
      config: configRecord(base, { document_count: 1 }),
      documents: [document({ id: "doc-new", name: "brief.txt", chunk_count: 3 })],
      status: "synced",
      synced_at: "now",
      provider_status: "live",
      provider_message: "Indexed 1 of 1 uploaded file (3 passages).",
    } as unknown as KnowledgeSyncResult),
  );
  expect(await screen.findByText(/Added · 3 passages/)).toBeInTheDocument();
  expect(screen.getByText("1 indexed file")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

test("web pages are fetched on add and pasted text is labeled as not re-fetched", async () => {
  const base = knowledgeBase({ source_type: "web", document_count: 0 });
  stubFetch((url, init) => {
    if (url.includes("/web-sources") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return json({
        config: configRecord(base, {
          document_count: 1,
          linked_sources: [{ document_id: "doc-web", kind: "web", name: body.name, url: body.url, refresh: !body.text }],
        }),
        documents: [document({ id: "doc-web", name: body.name, source_type: "web", source_uri: body.url, chunk_count: 2 })],
        status: "synced",
        synced_at: "now",
        provider_status: "live",
        provider_message: `Fetched ${body.url} and indexed 900 extracted characters.`,
      });
    }
    if (url.includes("/documents")) return json([]);
    return undefined;
  });
  renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.change(await screen.findByLabelText("Page address"), { target: { value: "https://example.com/retention" } });
  fireEvent.click(screen.getByRole("button", { name: "Fetch and add page" }));

  expect(await screen.findByText(/Fetched https:\/\/example.com\/retention/)).toBeInTheDocument();
  expect(requests.find((request) => request.url.includes("/web-sources"))?.body).toEqual({
    name: "https://example.com/retention",
    url: "https://example.com/retention",
    text: null,
  });
  expect(screen.getByText(/Refreshed by Sync now/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
});

test("an API source sends the real request settings and keeps the secret out of the list", async () => {
  const base = knowledgeBase({ source_type: "api", document_count: 0 });
  stubFetch((url, init) => {
    if (url.includes("/api-sources") && init?.method === "POST") {
      return json({
        config: configRecord(base, {
          document_count: 1,
          linked_sources: [{ document_id: "doc-api", kind: "api", name: "Open matters", method: "GET", auth_type: "api-key", refresh: true }],
        }),
        documents: [document({ id: "doc-api", name: "Open matters", source_type: "api", source_uri: "https://api.example.com/v1/matters", chunk_count: 4 })],
        status: "synced",
        synced_at: "now",
        provider_status: "live",
        provider_message: "Fetched Open matters (3 KB) and indexed 4 passages.",
      });
    }
    if (url.includes("/documents")) return json([]);
    return undefined;
  });
  renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.change(await screen.findByLabelText("API address"), { target: { value: "https://api.example.com" } });
  fireEvent.change(screen.getByLabelText(/^Path/), { target: { value: "/v1/matters" } });
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Open matters" } });
  fireEvent.change(screen.getByLabelText("Sign-in"), { target: { value: "api-key" } });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "synthetic-key" } });
  fireEvent.change(screen.getByLabelText("Send the key as"), { target: { value: "query" } });
  fireEvent.change(screen.getByLabelText("Parameter name"), { target: { value: "api_key" } });
  fireEvent.click(screen.getByRole("button", { name: "Fetch and add" }));

  expect(await screen.findByText("Fetched Open matters (3 KB) and indexed 4 passages.")).toBeInTheDocument();
  expect(requests.find((request) => request.url.includes("/api-sources"))?.body).toEqual({
    name: "Open matters",
    base_url: "https://api.example.com",
    path: "/v1/matters",
    method: "GET",
    headers: null,
    body: null,
    auth_type: "api-key",
    secret_value: "synthetic-key",
    credential_name: "api_key",
    credential_location: "query",
  });
  expect(screen.getByText(/GET · API key · refreshed by Sync now/)).toBeInTheDocument();
  expect(screen.queryByText("synthetic-key")).not.toBeInTheDocument();
});

test("an OAuth API waiting for sign-in offers the provider sign-in from the server-signed URL", async () => {
  const base = knowledgeBase({
    source_type: "api",
    document_count: 0,
    linked_sources: [{ document_id: "doc-api", kind: "api", name: "Matter API", auth_type: "oauth-client", refresh: true, awaiting_authorization: true }],
  });
  stubFetch((url) => {
    if (url.includes("/oauth/authorize-url")) return json({ authorize_url: "https://login.example.com/authorize?state=signed", state: "signed" });
    if (url.includes("/documents")) return json([]);
    return undefined;
  });
  const popup = { closed: false, close: vi.fn(), location: { href: "" }, document: { title: "", body: {} } } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  renderLibrary([base]);

  expect(within(screen.getByRole("article", { name: "Synthetic Matter Files" })).getByText("Sign-in needed")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sign in with provider" }));

  // The window opens synchronously with the click, then goes to the signed URL.
  expect(open).toHaveBeenCalledWith("", "aperture-knowledge-oauth", expect.any(String));
  await waitFor(() => expect(popup.location.href).toBe("https://login.example.com/authorize?state=signed"));
});

test("syncing a connector knowledge base posts force and shows the provider's own result", async () => {
  const base = knowledgeBase({ id: "kb-box", name: "Box Matters", source_type: "box", connector_id: "box", source: "Box Matter Folders" });
  stubFetch((url, init) => {
    if (url.includes("/api/knowledge/kb-box/sync") && init?.method === "POST") {
      return json({
        config: configRecord(base, { status: "synced", last_sync: "Jan 2, 2026, 4:05 PM UTC", provider_message: "Box returned 1 file records from folder 12345." }),
        documents: [document({ id: "doc-box", knowledge_config_id: "kb-box", name: "Live Box motion.docx", source_type: "box" })],
        status: "synced",
        synced_at: "Jan 2, 2026, 4:05 PM UTC",
        provider_status: "live",
        provider_message: "Box returned 1 file records from folder 12345.",
      });
    }
    return undefined;
  });
  renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(await screen.findByRole("tab", { name: /Synced files/ })).toBeInTheDocument();
  expect(screen.queryByText(/Drag files here/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

  expect(await screen.findByText("Box returned 1 file records from folder 12345.")).toBeInTheDocument();
  expect(await screen.findByText("Live Box motion.docx")).toBeInTheDocument();
  expect(requests.find((request) => request.url.includes("/sync"))?.body).toEqual({ force: true });
});

test("removing a document and deleting knowledge bases call the real endpoints", async () => {
  const base = knowledgeBase();
  stubFetch((url, init) => {
    if (url.includes("/documents/doc-brief") && init?.method === "DELETE") {
      return json({ config: configRecord(base, { document_count: 0 }), documents: [], status: "synced", synced_at: "now", provider_status: "live" });
    }
    if (url.includes("/api/admin/knowledge-configs/") && init?.method === "DELETE") return json({ status: "deleted" });
    return undefined;
  });
  const view = renderLibrary([base, knowledgeBase({ id: "kb-second", name: "Second Base" })]);
  fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
  fireEvent.click(await screen.findByRole("button", { name: "Remove brief.pdf" }));
  expect(await screen.findByText("brief.pdf was removed from Synthetic Matter Files.")).toBeInTheDocument();
  expect(screen.getByText("No files yet. Drop files above to add them.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "All knowledge bases" }));
  fireEvent.click(screen.getByRole("button", { name: "More knowledge actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Delete all knowledge bases/ }));
  expect(await screen.findByText("Deleted 2 knowledge bases.")).toBeInTheDocument();
  expect(requests.filter((request) => request.method === "DELETE" && request.url.includes("/api/admin/knowledge-configs/"))).toHaveLength(2);
  expect(view.data().knowledgeBases).toHaveLength(0);
});

test("settings save the name and group sharing", async () => {
  const base = knowledgeBase({ acl: "Only Platform Owner", owner_group_id: "" });
  stubFetch((url, init) => {
    if (url.includes("/api/admin/knowledge-configs/kb-synthetic") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      return json({ ...configRecord(base), name: body.name, acl_group_ids: body.acl_group_ids });
    }
    return undefined;
  });
  renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  // Radix tabs activate on mouse down, as in a real click.
  fireEvent.mouseDown(await screen.findByRole("tab", { name: /Settings/ }));
  const settings = screen.getByRole("form", { name: "Synthetic Matter Files settings" });
  fireEvent.change(within(settings).getByLabelText("Name"), { target: { value: "Renamed Base" } });
  const firstGroup = sampleData.groups[0];
  fireEvent.click(within(settings).getByRole("checkbox", { name: new RegExp(firstGroup.name) }));
  fireEvent.click(within(settings).getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Renamed Base settings saved.")).toBeInTheDocument();
  expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
    name: "Renamed Base",
    acl_group_ids: [firstGroup.id],
  });
});

test("people without authoring rights see shared knowledge read-only", async () => {
  stubFetch();
  renderLibrary([knowledgeBase({ owner_user_id: "someone-else" })], "USER");
  expect(screen.getByText(/Ask an administrator if you need to add your own/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /New knowledge base/ })).not.toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Assistants can search Synthetic Matter Files" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
  expect(screen.queryByText(/Drag files here/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove brief.pdf" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: /Settings/ })).not.toBeInTheDocument();
});
