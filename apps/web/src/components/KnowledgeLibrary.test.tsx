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

function renderLibrary(
  bases: KnowledgeBase[],
  role: BootstrapData["me"]["role"] = "TENANT_ADMIN",
  extra: Partial<BootstrapData> = {},
) {
  let current: BootstrapData = { ...sampleData, me: { ...sampleData.me, role }, knowledgeBases: bases, ...extra };
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
    name: "",
    url: "https://example.com/retention",
    text: null,
    crawl_depth: 0,
    max_pages: 25,
    live_lookup: true,
  });
  expect(screen.getByText(/Refreshed by Sync now/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
});

test("a web page can also read the pages it links to and turn off fresh lookups", async () => {
  const base = knowledgeBase({ source_type: "web", document_count: 0 });
  stubFetch((url, init) => {
    if (url.includes("/web-sources") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return json({
        config: configRecord(base, {
          document_count: 1,
          linked_sources: [
            {
              document_id: "doc-site",
              kind: "web",
              name: "Synthetic Registry",
              url: body.url,
              refresh: true,
              crawl_depth: body.crawl_depth,
              page_count: 12,
              live_lookup: body.live_lookup,
            },
          ],
        }),
        documents: [document({ id: "doc-site", name: "Synthetic Registry", source_type: "web", source_uri: body.url, chunk_count: 30 })],
        status: "synced",
        synced_at: "now",
        provider_status: "live",
        provider_message: `Fetched ${body.url}: Read 12 pages; 2 skipped by robots.txt. Indexed 30 passages.`,
      });
    }
    if (url.includes("/documents")) return json([]);
    return undefined;
  });
  renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.change(await screen.findByLabelText("Page address"), { target: { value: "https://registry.example.com/" } });
  expect(screen.queryByLabelText("Most pages to read")).not.toBeInTheDocument();

  const pagesRail = screen.getByRole("radiogroup", { name: "Pages to read" });
  expect(within(pagesRail).getByRole("radio", { name: "This page" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(within(pagesRail).getByRole("radio", { name: "Linked pages" }));
  fireEvent.change(screen.getByLabelText("Most pages to read"), { target: { value: "40" } });
  const freshRail = screen.getByRole("radiogroup", { name: "Look for fresh pages on this site when answering" });
  expect(within(freshRail).getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(within(freshRail).getByRole("radio", { name: "Off" }));
  fireEvent.click(screen.getByRole("button", { name: "Fetch and add pages" }));

  expect(await screen.findByText(/Read 12 pages; 2 skipped by robots.txt/)).toBeInTheDocument();
  expect(requests.find((request) => request.url.includes("/web-sources"))?.body).toEqual({
    name: "",
    url: "https://registry.example.com/",
    text: null,
    crawl_depth: 1,
    max_pages: 40,
    live_lookup: false,
  });
  expect(screen.getByText(/30 passages · 12 pages · Refreshed by Sync now$/)).toBeInTheDocument();
});

test("pasted page text hides the crawl and fresh-lookup options", async () => {
  const base = knowledgeBase({ source_type: "web", document_count: 0 });
  stubFetch((url) => (url.includes("/documents") ? json([]) : undefined));
  renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await screen.findByLabelText("Page address");

  fireEvent.click(screen.getByLabelText(/Paste the text instead of fetching the page/));

  expect(screen.queryByRole("radiogroup", { name: "Pages to read" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("radiogroup", { name: "Look for fresh pages on this site when answering" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add text" })).toBeInTheDocument();
});

test("site documents with fresh lookups say so in the web page list", async () => {
  const base = knowledgeBase({
    source_type: "web",
    linked_sources: [
      { document_id: "doc-site", kind: "web", name: "Registry", url: "https://registry.example.com/", refresh: true, crawl_depth: 2, page_count: 1, live_lookup: true },
    ],
  });
  stubFetch((url, init) =>
    url.includes("/documents") && (init?.method ?? "GET") === "GET"
      ? json([document({ id: "doc-site", name: "Registry", source_type: "web", source_uri: "https://registry.example.com/" })])
      : undefined,
  );
  renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));

  expect(await screen.findByText(/· 1 page · Refreshed by Sync now · Looks for fresh pages when answering$/)).toBeInTheDocument();
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

test("knowledge authors without the API grant see API sources locked, not missing", async () => {
  stubFetch((url) => (url.includes("/documents") ? json([]) : undefined));
  renderLibrary([knowledgeBase()], "USER", {
    authoringState: { knowledge_enabled: true, tools_enabled: false, api_sources_enabled: false },
  });

  fireEvent.click(screen.getByRole("button", { name: /New knowledge base/ }));
  const apiChoice = screen.getByRole("button", { name: /Connect an API/ });
  expect(apiChoice).toBeDisabled();
  expect(apiChoice).toHaveAttribute("data-tooltip", expect.stringMatching(/Can add API sources/));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.mouseDown(await screen.findByRole("tab", { name: /API/ }));
  expect(await screen.findByText(/turn on Can add API sources/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Fetch and add/ })).not.toBeInTheDocument();
});

test("a document's name opens it as a document and its details stay on the expander", async () => {
  stubFetch((url, init) => {
    if (url.includes("/documents/doc-brief/view")) {
      return json({
        document_id: "doc-brief",
        knowledge_config_id: "kb-synthetic",
        name: "brief.pdf",
        content_type: "application/pdf",
        mode: "text",
        file_url: null,
        original_available: false,
        page_count: null,
        target: null,
        segments: [{ id: "chunk-1", page: 1, locator: "Page 1", text: "Synthetic brief text." }],
        notice: null,
      });
    }
    return url.includes("/documents") && (init?.method ?? "GET") === "GET" ? json([document()]) : undefined;
  });
  renderLibrary([knowledgeBase()]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));

  const name = await screen.findByRole("button", { name: "Open brief.pdf" });
  fireEvent.click(name);
  const viewer = await screen.findByRole("dialog", { name: "brief.pdf" });
  expect(within(viewer).getByText("Synthetic brief text.")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "brief.pdf properties" })).toBeNull();

  fireEvent.keyDown(window.document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "brief.pdf" })).toBeNull());
  expect(name).toHaveFocus();

  const preview = screen.getByRole("button", { name: "Preview brief.pdf" });
  fireEvent.click(preview);
  const reopened = await screen.findByRole("dialog", { name: "brief.pdf" });
  expect(within(reopened).getByText("Synthetic brief text.")).toBeInTheDocument();
  fireEvent.keyDown(window.document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "brief.pdf" })).toBeNull());
  expect(preview).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: "Show details for brief.pdf" }));
  expect(screen.getByRole("region", { name: "brief.pdf properties" })).toBeInTheDocument();
});

test("a document's details show its preserved properties and its ethical wall", async () => {
  const group = sampleData.groups[0];
  const walled = document({
    metadata: { Title: "Falcon memo", Author: "Avery Example", "Ethical wall": group.name },
    wall: { source: "metadata", group_ids: [group.id], field: "Ethical wall", values: [group.name], unresolved: [] },
  });
  stubFetch((url, init) => (url.includes("/documents") && (init?.method ?? "GET") === "GET" ? json([walled]) : undefined));
  renderLibrary([knowledgeBase()]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));

  expect(await screen.findByText("Walled")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show details for brief.pdf" }));
  const properties = screen.getByRole("region", { name: "brief.pdf properties" });
  expect(within(properties).getByText("Avery Example")).toBeInTheDocument();
  expect(within(properties).getByText("Falcon memo")).toBeInTheDocument();
  const access = screen.getByRole("region", { name: "Who can find brief.pdf" });
  expect(
    within(access).getByText(
      `Ethical wall from the file's "Ethical wall" property: only ${group.name} can find it, administrators included.`,
    ),
  ).toBeInTheDocument();
});

test("a wall that names no known group is shown as hidden", async () => {
  const closed = document({
    wall: { source: "metadata", group_ids: [], field: "Ethical wall", values: ["Project Kestrel"], unresolved: ["Project Kestrel"] },
  });
  stubFetch((url, init) => (url.includes("/documents") && (init?.method ?? "GET") === "GET" ? json([closed]) : undefined));
  renderLibrary([knowledgeBase()]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(await screen.findByText("Hidden")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show details for brief.pdf" }));
  expect(screen.getByText(/It names no group in this workspace, so nobody can find it until the group exists\./)).toBeInTheDocument();
  expect(screen.getByText(/"Project Kestrel" matches no group, so it admits nobody\./)).toBeInTheDocument();
});

test("administrators limit a document to groups through the access endpoint", async () => {
  const base = knowledgeBase();
  const group = sampleData.groups[0];
  stubFetch((url, init) => {
    if (url.includes("/documents/doc-brief/access") && init?.method === "PUT") {
      const limited = document({ wall: { source: "manual", group_ids: [group.id] } });
      return json({
        config: configRecord(base, { document_walls: { "doc-brief": { mode: "restricted", group_ids: [group.id] } } }),
        documents: [limited],
        status: "synced",
        synced_at: "now",
        provider_status: "unchanged",
        provider_message: `Only members of ${group.name} can now find brief.pdf.`,
      });
    }
    return undefined;
  });
  const view = renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(await screen.findByRole("button", { name: "Show details for brief.pdf" }));
  const editor = screen.getByRole("radiogroup", { name: "Access for brief.pdf" });
  expect(within(editor).getByRole("radio", { name: "Open" })).toBeInTheDocument();
  fireEvent.click(within(editor).getByRole("radio", { name: "Limit" }));
  const save = screen.getByRole("button", { name: "Save access" });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: group.name }));
  fireEvent.click(save);

  expect(await screen.findByText(`Only members of ${group.name} can now find brief.pdf.`)).toBeInTheDocument();
  expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
    mode: "restricted",
    group_ids: [group.id],
  });
  expect(view.data().knowledgeBases[0].document_walls).toEqual({
    "doc-brief": { mode: "restricted", group_ids: [group.id] },
  });
  expect(screen.getByText("Walled")).toBeInTheDocument();
});

test("knowledge base owners who are not administrators cannot lift a wall", async () => {
  stubFetch();
  renderLibrary([knowledgeBase({ owner_group_id: "" })], "USER", {
    authoringState: { ...(sampleData.authoringState ?? {}), knowledge_enabled: true } as BootstrapData["authoringState"],
  });
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(await screen.findByRole("button", { name: "Show details for brief.pdf" }));
  const editor = screen.getByRole("radiogroup", { name: "Access for brief.pdf" });
  expect(within(editor).queryByRole("radio", { name: "Open" })).not.toBeInTheDocument();
});

test("settings save AI page reading and wall fields only when they change", async () => {
  const base = knowledgeBase();
  stubFetch((url, init) => {
    if (url.endsWith("/api/knowledge/limits")) {
      return json({
        upload_max_mb: 250,
        max_extracted_chars: 10_000_000,
        ocr_enabled: true,
        ocr_max_pages: 250,
        semantic_search: "on",
        vision_ocr: { available: true, model_name: "Gemini Flash", max_pages: 60 },
      });
    }
    if (url.includes("/api/admin/knowledge-configs/kb-synthetic") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      return json(configRecord(base, body.settings));
    }
    return undefined;
  });
  const view = renderLibrary([base]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.mouseDown(await screen.findByRole("tab", { name: /Settings/ }));
  const settings = screen.getByRole("form", { name: "Synthetic Matter Files settings" });
  expect(await within(settings).findByText(/Gemini Flash reads handwriting, stamps, signatures, and pictures/)).toBeInTheDocument();
  fireEvent.click(within(settings).getByRole("radio", { name: "Standard OCR only" }));
  fireEvent.change(within(settings).getByLabelText("More wall fields"), { target: { value: "Matter team; Deal group" } });
  fireEvent.click(within(settings).getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Synthetic Matter Files settings saved.")).toBeInTheDocument();
  expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
    name: "Synthetic Matter Files",
    acl_group_ids: ["group-litigation"],
    settings: { vision_ocr: false, wall_fields: ["Matter team", "Deal group"] },
  });
  expect(view.data().knowledgeBases[0].vision_ocr).toBe(false);
  expect(view.data().knowledgeBases[0].wall_fields).toEqual(["Matter team", "Deal group"]);
});

test("the upload area names the model that reads handwriting", async () => {
  stubFetch((url) =>
    url.endsWith("/api/knowledge/limits")
      ? json({
          upload_max_mb: 250,
          max_extracted_chars: 10_000_000,
          ocr_enabled: true,
          ocr_max_pages: 250,
          semantic_search: "on",
          vision_ocr: { available: true, model_name: "Gemini Flash", max_pages: 60 },
        })
      : undefined,
  );
  renderLibrary([knowledgeBase()]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(await screen.findByText(/Handwriting, stamps, and pictures are read by Gemini Flash\./)).toBeInTheDocument();
});
