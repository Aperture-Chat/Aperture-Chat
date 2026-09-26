import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { DocumentAssistantWorkspace } from "./DocumentAssistantWorkspace";
import { sampleData } from "../data/sampleData";
import type { DraftNavigationGuard } from "../lib/draftNavigation";

const LEGACY_DOCUMENT_HISTORY_STORAGE_KEY = "aperture-document-history-v1";
// Draft history is cached per tenant AND user; sampleData signs in
// user-admin on tenant-example.
const SCOPED_DRAFT_CACHE_KEY = "aperture-drafts-cache-v2:tenant-example:user-admin";

beforeEach(() => {
  window.localStorage.clear();
  window.getSelection()?.removeAllRanges();
  delete (window as Partial<Window & { showSaveFilePicker: unknown }>).showSaveFilePicker;
  resetOfflineFetch();
});

function resetOfflineFetch() {
  const fetchMock = globalThis.fetch as unknown as {
    mockReset?: () => void;
    mockImplementation?: (implementation: typeof fetch) => void;
  };
  fetchMock.mockReset?.();
  fetchMock.mockImplementation?.(
    async () =>
      new Response(JSON.stringify({ error: "offline" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

function openDocumentTools(label: "Text" | "Paragraph" | "More") {
  const button = screen.getByRole("button", { name: `${label} options` });
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
}

function documentBody() {
  return screen.getByRole("textbox", { name: "Document body" });
}

function documentText() {
  return documentBody().textContent ?? "";
}

function dataWithApprovedDraftModel(modelId: string) {
  return {
    ...sampleData,
    models: sampleData.models.map((model) =>
      model.id === modelId
        ? { ...model, group_ids: ["group-litigation"], tenant_restricted: true }
        : model,
    ),
  };
}

function dataWithImageFirstDraftModels() {
  const baseModel = dataWithApprovedDraftModel("openrouter-openai-gpt-4o-mini")
    .models.find((model) => model.id === "openrouter-openai-gpt-4o-mini")!;
  return {
    ...sampleData,
    models: [
      {
        ...baseModel,
        id: "draft-image-model",
        name: "Draft image model",
        capabilities: { output_modalities: ["text", "image"] },
      },
      {
        ...baseModel,
        id: "draft-text-model",
        name: "Draft text model",
        capabilities: { output_modalities: ["text"] },
      },
    ],
  };
}

function ownerPreviewDataWithApprovedDraftModel(modelId: string) {
  const data = dataWithApprovedDraftModel(modelId);
  return {
    ...data,
    me: {
      ...data.me,
      id: "user-owner",
      role: "PLATFORM_OWNER" as const,
      display_name: "Aperture Platform Owner",
      group_ids: [],
    },
  };
}

function openExportDialog() {
  if (!screen.queryByRole("dialog", { name: "Export document" })) {
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
  }
}

function selectEditorText(text: string) {
  const editor = documentBody();
  const textNode = findTextNode(editor, text);
  if (!textNode) {
    throw new Error(`Could not find text in editor: ${text}`);
  }
  const start = textNode.data.indexOf(text);
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + text.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeEditorCaretAtTextStart(text: string) {
  const editor = documentBody();
  const textNode = findTextNode(editor, text);
  if (!textNode) throw new Error(`Could not find text in editor: ${text}`);
  const range = document.createRange();
  range.setStart(textNode, textNode.data.indexOf(text));
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function findTextNode(node: Node, text: string): Text | null {
  if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes(text)) {
    return node as Text;
  }
  for (const child of Array.from(node.childNodes)) {
    const match = findTextNode(child, text);
    if (match) return match;
  }
  return null;
}

function installDownloadSpy() {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const downloads: Array<{ blob: Blob; filename?: string; href?: string }> = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    downloads.push({ blob });
    return `blob:aperture-export-${downloads.length}`;
  });
  const revokeObjectURL = vi.fn();

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });

  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function recordDownload(this: HTMLAnchorElement) {
      const latestDownload = downloads[downloads.length - 1];
      if (latestDownload) {
        latestDownload.filename = this.download;
        latestDownload.href = this.href;
      }
    });

  return {
    createObjectURL,
    downloads,
    restore: () => {
      clickSpy.mockRestore();
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: originalCreateObjectURL,
        });
      } else {
        delete (URL as Partial<typeof URL>).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: originalRevokeObjectURL,
        });
      } else {
        delete (URL as Partial<typeof URL>).revokeObjectURL;
      }
    },
    revokeObjectURL,
  };
}

function readBlobAsText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(blob);
  });
}

function disableWebSearch() {
  const button = screen.queryByRole("button", { name: "Disable web search" });
  if (button) {
    fireEvent.click(button);
  }
}

function installChatCompletionFetchMock(
  content: string | ((payload: Record<string, unknown>) => string),
  options: { uploadError?: string } = {},
) {
  const requests: unknown[] = [];
  const fetchMock = globalThis.fetch as unknown as {
    mockImplementation: (implementation: typeof fetch) => void;
  };
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/chat/attachments")) {
      if (options.uploadError) {
        return new Response(JSON.stringify({ detail: options.uploadError }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }
      const file = (init?.body as FormData).get("file") as File;
      return new Response(
        JSON.stringify({
          id: `upload-${file.name}`,
          name: file.name,
          size: `${file.size} B`,
          kind: "document",
          text_preview: file.name.endsWith(".pdf") ? null : "Synthetic extracted text.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/chat/complete")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(payload);
      const responseContent = typeof content === "function" ? content(payload) : content;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: responseContent } }],
          citations: [
            {
              id: "cite-web-1",
              source_name: "NASA Artemis II",
              source_type: "web",
              source_uri: "https://www.nasa.gov/artemis-ii/",
              snippet: "NASA's Artemis II mission page.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  });
  return requests;
}

/** Types an instruction into the AI edit composer and runs it. */
function submitInlineAiInstruction(instruction: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "AI instruction" }), {
    target: { value: instruction },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run AI instruction" }));
}

/** Runs an instruction through the AI edit composer and accepts the reviewed
 * suggestion, the way a writer applies an inline edit. */
async function applyInlineAiInstruction(instruction: string) {
  submitInlineAiInstruction(instruction);
  fireEvent.click(await screen.findByRole("button", { name: "Accept AI suggestion" }));
}

function installDeferredChatCompletionFetchMock(content: string) {
  const requests: unknown[] = [];
  let resolveResponse: (response: Response) => void = () => {};
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const fetchMock = globalThis.fetch as unknown as {
    mockImplementation: (implementation: typeof fetch) => void;
  };
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/chat/complete")) {
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return responsePromise;
    }
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    requests,
    resolve: () =>
      resolveResponse(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content } }],
            citations: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
  };
}

function storedDraftHistory() {
  return JSON.parse(
    window.localStorage.getItem(SCOPED_DRAFT_CACHE_KEY) ?? "[]",
  ) as Array<{
    id?: string;
    title?: string;
    status?: string;
    summary?: string;
    content?: string;
    serverId?: string | null;
    serverRevision?: number | null;
    events?: Array<{ kind?: string; text?: string }>;
  }>;
}

/** Rail actions confirm in a visible notice and in the screen-reader status. */
function expectRailNotice(message: RegExp) {
  const notice = document.querySelector(".draft-rail-notice");
  expect(notice).not.toBeNull();
  expect(notice).toHaveTextContent(message);
  const announcements = Array.from(document.querySelectorAll('.sr-only[role="status"]'));
  expect(announcements.some((element) => message.test(element.textContent ?? ""))).toBe(true);
}

/** The rail's context chips show each context switch's live state. */
function expectDraftContext(expected: { sources: string; web: string; templates: string }) {
  expect(screen.getByRole("button", { name: "Sources and files" })).toHaveTextContent(
    `Sources${expected.sources}`,
  );
  expect(screen.getByRole("button", { name: /web search/i })).toHaveTextContent(`Web${expected.web}`);
  expect(screen.getByRole("button", { name: "Choose template" })).toHaveTextContent(
    `Templates${expected.templates}`,
  );
}

function draftHistoryPanel() {
  const panel = screen
    .getAllByLabelText("Draft history")
    .find((element) => element.classList.contains("draft-history-panel"));
  if (!panel) throw new Error("Draft history panel was not open.");
  return panel;
}

function providerPagedDraft(title: string, pageCount: number, subject: string, includeImages = false) {
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "draft";
  const blocks = [`# ${title}`];
  for (let page = 1; page <= pageCount; page += 1) {
    blocks.push(
      `## Section ${page}: ${subject} page ${page}`,
      `${subject} page ${page} provides concrete drafting content from the selected model rather than a local template fallback. It includes enough detail for the editable document canvas and keeps unsupported claims marked for verification.`,
    );
    if (includeImages && page % Math.max(1, Math.floor(pageCount / 6)) === 0) {
      blocks.push(`![${subject} figure ${page}](https://example.com/${slug}-${page}.jpg "${subject} figure ${page}")`);
    }
  }
  return blocks.join("\n\n");
}

function clientUpdateProviderDraft() {
  return [
    "# Client Update Draft",
    "Matter: Anderson v. Northstar Logistics",
    "The discovery deadline remains July 12, 2026.",
    "Key developments: Provider-drafted client update content is ready for attorney review.",
  ].join("\n\n");
}

function investmentMemoProviderDraft() {
  return [
    "# Investment Memo Draft",
    "Investment thesis: Provider-drafted finance memo content supports the acquisition review.",
    "Financial snapshot: Revenue, margin, growth, and diligence figures require source confirmation.",
  ].join("\n\n");
}

function cloningResearchPaper() {
  return [
    '# “Cloning” Human Organs: Current Science, Clinical Reality, and Prospects',
    "Bioprinting, organoids, and xenotransplantation are related but distinct research programs. Each program addresses a different constraint in the effort to produce safe replacement organs for patients with end-stage disease.",
    "Patient-derived organoids model tissue development and disease in controlled laboratory settings. They support drug screening and mechanistic research, but they are not complete vascularized organs suitable for routine transplantation.",
    "Three-dimensional bioprinting can arrange cells and biomaterials into increasingly complex tissue structures. Reliable vascular networks, innervation, mechanical durability, and manufacturing consistency remain major translational barriers.",
    "Gene-edited pig organs have entered closely monitored clinical evaluation. These procedures test immune compatibility and physiologic performance, while long-term survival, infection risk, rehabilitation, and equitable access remain unresolved.",
    "Stem-cell differentiation protocols can generate specialized cardiac, hepatic, renal, and retinal cell types. The scientific progress is meaningful, although maturation and integration still separate experimental grafts from complete replacement organs.",
    "Registered trials and peer-reviewed case reports must be distinguished from institutional announcements. A rigorous review retains dates, patient context, adverse events, and uncertainty instead of treating every milestone as established clinical practice.",
    "The current evidence therefore supports cautious optimism rather than claims that literal human organ cloning is complete. Continued progress depends on transparent reporting, reproducible manufacturing, ethical oversight, and durable patient outcomes.",
    "## Works Consulted",
    "National Institutes of Health. Research resources on regenerative medicine and transplantation.",
  ].join("\n\n");
}

test("starts the draft chat clean until the user talks to the assistant", () => {
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  expect(screen.getByLabelText("Document title")).toHaveValue("Untitled Draft");
  expect(documentText()).toBe("");
  expect(screen.getByText("Blank draft ready")).toBeInTheDocument();
  expectDraftContext({ sources: "Off", web: "On", templates: "Off" });
  expect(screen.getByRole("button", { name: "Disable web search" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Assistant events")).toBeEmptyDOMElement();
  expect(screen.queryByText(/You imported a draft/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Tell me what needs changed/)).not.toBeInTheDocument();
});

test("keeps workspace knowledge and templates off while web search defaults on for general research drafts", async () => {
  const chatRequests = installChatCompletionFetchMock(
    providerPagedDraft("Artemis II Mission Draft", 25, "Artemis II mission", true),
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Sources and files" }));
  expect(screen.getByText(/Off by default/)).toBeInTheDocument();
  expect(screen.getByLabelText("Workspace sources for this draft")).toHaveTextContent(
    "Litigation Playbook",
  );
  expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value:
        "write a 25 page paper on the Artemis II mission. List all of the scientific discoveries and add images of the astronauts and mission.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue("Artemis II Mission Draft");
    expect(documentText()).toContain("Artemis II mission page 25");
  });
  expect(chatRequests).toHaveLength(1);
  const payload = chatRequests[0] as {
    web_enabled: boolean;
    knowledge_config_ids: string[];
    messages: Array<{ content: string }>;
  };
  expect(payload.web_enabled).toBe(true);
  expect(payload.knowledge_config_ids).toEqual([]);
  expect(payload.messages[0].content).toContain("Use provider-hosted public web search");
  expect(documentText()).toContain("Sources");
  expect(documentText()).toContain("NASA Artemis II");
  expect(documentText()).not.toMatch(/\bshould\b/i);
  expect(documentText()).not.toMatch(/\bpaper can\b/i);
  expect(documentText()).not.toMatch(/because the prompt asks/i);
  const imageFigures = documentBody().querySelectorAll(".document-image-figure");
  expect(imageFigures.length).toBeGreaterThan(5);
  expect(documentBody().querySelector("img")?.getAttribute("src")).toContain("artemis-ii-mission");
  expect(documentText()).not.toContain("Star Wars");
  expect(
    screen.getByRole("region", { name: "Aperture Chat document work trace" }),
  ).toBeInTheDocument();
  const assistantEvents = screen.getByLabelText("Assistant events");
  expect(
    within(assistantEvents).getByRole("region", { name: "Aperture Chat document work trace" }),
  ).toBeInTheDocument();
  expectDraftContext({ sources: "Off", web: "On", templates: "Off" });
  expect(screen.getByText(/drafted with provider-hosted web search/)).toBeInTheDocument();
});

test("runs long-horizon document drafting with trace steps and image slots", async () => {
  const chatRequests = installChatCompletionFetchMock(
    providerPagedDraft("GLM Model Governance Report", 50, "GLM model governance", true),
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value:
        "Draft a 50 page report about GLM model governance and add images throughout the document.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(documentText()).toContain("GLM model governance page 50");
  });
  expect(chatRequests).toHaveLength(1);
  const payload = chatRequests[0] as {
    web_enabled: boolean;
    max_completion_tokens: number;
    messages: Array<{ content: string }>;
  };
  expect(payload.web_enabled).toBe(false);
  expect(payload.max_completion_tokens).toBe(24000);
  expect(payload.messages[0].content).toContain("Do not claim live web research");
  expect(documentBody().querySelectorAll(".document-image-figure").length).toBeGreaterThan(4);
  const trace = screen.getByRole("region", { name: "Aperture Chat document work trace" });
  fireEvent.click(within(trace).getByRole("button", { name: "Expand work trace" }));
  expect(within(trace).getByText("Sizing long-form deliverable")).toBeInTheDocument();
  expect(within(trace).getByText("Preparing visual evidence")).toBeInTheDocument();
  expect(within(trace).getByText("Generating long-form answer")).toBeInTheDocument();
  expect(within(trace).getByText("Content validator loop")).toBeInTheDocument();
  expect(within(trace).getByText("Finalizing response")).toBeInTheDocument();
  expect(documentText()).not.toMatch(/\bshould\b/i);
  expect(documentText()).not.toMatch(/because the prompt asks/i);
  expect(screen.getByText(/Provider drafting completed through/)).toBeInTheDocument();
});

test("web search defaults on and can be toggled off for research drafts", async () => {
  const chatRequests = installChatCompletionFetchMock(
    providerPagedDraft("Artemis II Mission Draft", 25, "Artemis II mission"),
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  expect(screen.getByRole("button", { name: "Disable web search" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Disable web search" }));
  expect(screen.getByRole("button", { name: "Enable web search" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expectRailNotice(/Web search disabled for this draft/);

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value:
        "write a 25 page paper on the Artemis II mission. List all of the scientific discoveries and add images of the astronauts and mission.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  expect(screen.queryByText(/Researching public web sources for Artemis II Mission Draft/)).not.toBeInTheDocument();
  await waitFor(() => {
    expect(documentText()).toContain("Artemis II mission page 25");
  });
  expect(chatRequests).toHaveLength(1);
  const payload = chatRequests[0] as { web_enabled: boolean; messages: Array<{ content: string }> };
  expect(payload.web_enabled).toBe(false);
  expect(payload.messages[0].content).toContain("Do not claim live web research");
  expect(screen.getByLabelText("Document title")).toHaveValue("Artemis II Mission Draft");
  expect(documentText()).not.toContain("Star Wars");
  expectDraftContext({ sources: "Off", web: "Off", templates: "Off" });
});

test("keeps in-progress provider drafts in history when opening a new draft workspace", async () => {
  const deferredDraft = installDeferredChatCompletionFetchMock(
    "# Parallel Document Workflows\n\nThe completed draft proves the background run updated history.",
  );

  const firstWorkspace = render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Draft a report about parallel document workflows.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(deferredDraft.requests).toHaveLength(1);
    expect(storedDraftHistory()[0]).toMatchObject({
      status: "running",
      summary: expect.stringMatching(/Drafting with/i),
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  expect(draftHistoryPanel()).toHaveTextContent("Drafting");

  firstWorkspace.unmount();
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  expect(screen.getByLabelText("Document title")).toHaveValue("Untitled Draft");
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  expect(draftHistoryPanel()).toHaveTextContent("Drafting");

  deferredDraft.resolve();

  await waitFor(() => {
    expect(storedDraftHistory()[0]).toMatchObject({
      status: "complete",
      content: expect.stringContaining("background run updated history"),
    });
  });
  await waitFor(() => {
    const historyPanel = draftHistoryPanel();
    expect(historyPanel).not.toHaveTextContent("Drafting");
    // The offline fetch mock rejects the follow-up server save, so the honest
    // label is "Local only", never "Saved".
    expect(historyPanel).toHaveTextContent("Local only");
    expect(historyPanel).toHaveTextContent("Drafted with selected model");
  });
});

test("does not duplicate Draft in generic provider draft titles", async () => {
  installChatCompletionFetchMock(
    "# Research Paper Draft\n\nProvider-backed drafting completed without duplicating the title suffix.",
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Draft a one paragraph status note confirming the live provider path.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue("Research Paper Draft");
  });
  expect(documentText()).toContain("Provider-backed drafting completed");
});

test("uses the chat completion endpoint with web enabled for document assistant web drafts", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Artemis II Timeline Update\n\nNASA's current Artemis II materials identify the mission as the next crewed Artemis flight.",
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Draft a current research memo on the Artemis II launch timeline.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(chatRequests).toHaveLength(1);
  });
  const payload = chatRequests[0] as {
    model: string;
    web_enabled: boolean;
    citations_enabled: boolean;
    messages: Array<{ content: string }>;
  };
  expect(payload.model).toBe("agent-client-update");
  expect(payload.web_enabled).toBe(true);
  expect(payload.citations_enabled).toBe(true);
  expect(payload.messages[0].content).toContain("Use provider-hosted public web search");

  await waitFor(() => {
    expect(documentText()).toContain("NASA's current Artemis II materials");
  });
  expect(documentText()).toContain("Sources");
  expect(documentText()).toContain("NASA Artemis II");
  expect(screen.getByText(/drafted with provider-hosted web search/)).toBeInTheDocument();
});

test("applies assistant instructions as a provider-backed new document version", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Revised Draft\n\nClient-ready note: The update is ready for client review.\n\nSource control: Verify cited support before export.",
  );
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  expect(
    screen.getByRole("heading", { name: "Document Assistant" }),
  ).toBeInTheDocument();
  expectDraftContext({ sources: "Off", web: "On", templates: "Off" });
  expect(screen.getByRole("button", { name: "Sources and files" })).toHaveAttribute(
    "data-tooltip",
    expect.stringMatching(/^3 workspace sources available/),
  );

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Make this client ready and add source control.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByText(/Version 2 applied from provider revision/)).toBeInTheDocument();
  });
  expect(chatRequests).toHaveLength(1);
  expect(
    (chatRequests[0] as { messages: Array<{ content: string }> }).messages[0].content,
  ).toContain("Do not describe what should be changed; make the changes directly.");
  expect(screen.getAllByText("Version 2").length).toBeGreaterThan(0);

  expect(documentText()).toContain("Client-ready note:");
  expect(documentText()).toContain("Source control:");
  expect(
    screen.getByText(/Provider revision completed through/),
  ).toBeInTheDocument();
});

test("a changed-my-mind pivot starts a fresh draft instead of a focused revision", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Community Solar Microgrids Proposal\n\nA wholly new proposal drafted from scratch about community solar microgrids.",
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "pivot-transfer",
        title: "Office lease memo",
        sourceLabel: "transferred chat",
        createdAt: "7:11 PM",
        content: "# Office lease memo\n\nDetailed lease analysis for the downtown office.",
      }}
    />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "I changed my mind — make me a proposal about community solar microgrids instead.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(documentText()).toContain("wholly new proposal drafted from scratch");
  });
  expect(chatRequests).toHaveLength(1);
  const prompt = (chatRequests[0] as { messages: Array<{ content: string }> }).messages[0].content;
  // The pivot routes through fresh creation, not the focused revision
  // contract that preserves the old document.
  expect(prompt).not.toContain("Revision request:");
  expect(documentText()).not.toContain("lease analysis");
});

test("treats an MLA request on a populated paper as an in-place transformation", async () => {
  const sourcePaper = cloningResearchPaper();
  const deferredRevision = installDeferredChatCompletionFetchMock(
    [
      "Taylor Example",
      "Professor Rivera",
      "BIO 410",
      "29 August 2026",
      "",
      sourcePaper,
    ].join("\n\n"),
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "mla-transform-transfer",
        title: "Cloning Human Organs Scientific Review",
        sourceLabel: "transferred chat",
        createdAt: "9:24 PM",
        content: sourcePaper,
      }}
    />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Write this paper in MLA format without removing any research or citations.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => expect(deferredRevision.requests).toHaveLength(1));
  // The old document stays visible while the transformation is running.
  expect(documentText()).toContain("Reliable vascular networks");
  expect(documentText()).toContain("literal human organ cloning is complete");
  expect(screen.getByLabelText("Document title")).toHaveValue(
    "Cloning Human Organs Scientific Review",
  );
  const payload = deferredRevision.requests[0] as {
    max_completion_tokens: number;
    messages: Array<{ content: string }>;
  };
  expect(payload.messages[0].content).toContain("Revision request:");
  expect(payload.messages[0].content).toContain("Current document:");
  expect(payload.messages[0].content).toContain("in-place transformation");
  expect(payload.messages[0].content).not.toContain("Draft type:");
  expect(payload.max_completion_tokens).toBe(12000);

  deferredRevision.resolve();
  await waitFor(() => {
    expect(screen.getByText(/Version 2 applied from provider revision/)).toBeInTheDocument();
  });
  expect(documentText()).toContain("Professor Rivera");
  expect(documentText()).toContain("Reliable vascular networks");
  expect(documentText()).toContain("ethical oversight");
});

test("leaves a populated paper unchanged when a whole-document transform drops its content", async () => {
  const sourcePaper = cloningResearchPaper();
  installChatCompletionFetchMock(
    "# MLA Paper\n\nTaylor Example\nProfessor Rivera\nBIO 410\n29 August 2026\n\n## Works Cited",
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "unsafe-mla-transform-transfer",
        title: "Cloning Human Organs Scientific Review",
        sourceLabel: "transferred chat",
        createdAt: "9:24 PM",
        content: sourcePaper,
      }}
    />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Convert the entire paper to MLA format." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getAllByText(/in-place transformation must retain/i).length).toBeGreaterThan(0);
  });
  expect(documentText()).toContain("Reliable vascular networks");
  expect(documentText()).toContain("ethical oversight");
  expect(documentText()).not.toContain("Taylor Example");
  expect(screen.queryByText(/Version 2 applied from provider revision/)).not.toBeInTheDocument();
});

test("keeps the current document visible until an explicit replacement succeeds", async () => {
  const deferredDraft = installDeferredChatCompletionFetchMock(
    "# Solar Microgrid Report\n\nA new report about community solar microgrids.",
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "transactional-replacement-transfer",
        title: "Office lease memo",
        sourceLabel: "transferred chat",
        createdAt: "7:11 PM",
        content: "# Office lease memo\n\nDetailed lease analysis for the downtown office.",
      }}
    />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "I changed my mind — start over with a new report about community solar microgrids.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => expect(deferredDraft.requests).toHaveLength(1));
  expect(screen.getByLabelText("Document title")).toHaveValue("Office lease memo");
  expect(documentText()).toContain("Detailed lease analysis");

  deferredDraft.resolve();
  await waitFor(() => expect(documentText()).toContain("community solar microgrids"));
  expect(documentText()).not.toContain("Detailed lease analysis");
});

test("clears revision instructions immediately and keeps a durable working lifecycle", async () => {
  const deferredRevision = installDeferredChatCompletionFetchMock(
    "# Operations Brief\n\nThe existing operational summary remains intact.\n\nThe expanded analysis adds concrete owners, milestones, dependencies, and verification steps.",
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "revision-lifecycle-transfer",
        title: "Operations Brief",
        sourceLabel: "transferred chat",
        createdAt: "7:10 PM",
        content:
          "# Operations Brief\n\nThe existing operational summary remains intact.",
      }}
    />,
  );
  disableWebSearch();

  const instructionBox = screen.getByLabelText("Ask the document assistant");
  const sendButton = screen.getByRole("button", { name: "Apply instruction" });
  fireEvent.change(instructionBox, {
    target: { value: "Expand the analysis with more operational detail." },
  });
  fireEvent.click(sendButton);

  expect(instructionBox).toHaveValue("");
  expect(instructionBox).toBeDisabled();
  expect(sendButton).toBeDisabled();
  expect(documentBody()).toHaveClass("is-ai-editing");
  expect(documentBody()).toHaveAttribute("aria-busy", "true");
  const workingTrace = screen.getByRole("status", {
    name: "Aperture Chat document work trace",
  });
  expect(workingTrace).toHaveTextContent("Revising current document");
  expect(within(workingTrace).getByRole("button", { name: "Expand work trace" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(within(workingTrace).queryByText("Preserving document structure")).not.toBeInTheDocument();
  fireEvent.click(within(workingTrace).getByRole("button", { name: "Expand work trace" }));
  expect(within(workingTrace).getByText("Preserving document structure")).toBeInTheDocument();
  expect(within(workingTrace).getByText("Finalizing revised version")).toBeInTheDocument();
  expect(screen.getByText(/Revising the current document through/)).toBeInTheDocument();
  expect(deferredRevision.requests).toHaveLength(1);
  fireEvent.click(sendButton);
  expect(deferredRevision.requests).toHaveLength(1);

  await waitFor(() => {
    expect(storedDraftHistory()[0]).toMatchObject({
      status: "running",
      summary: expect.stringMatching(/Revising with/),
    });
  });

  deferredRevision.resolve();

  await waitFor(() => {
    expect(documentText()).toContain("expanded analysis adds concrete owners");
    expect(screen.getByText(/Version 2 applied from provider revision/)).toBeInTheDocument();
  });
  expect(instructionBox).toBeEnabled();
  expect(documentBody()).not.toHaveClass("is-ai-editing");
  expect(documentBody()).toHaveAttribute("aria-busy", "false");
  const completedTrace = screen.getByRole("region", {
    name: "Aperture Chat document work trace",
  });
  fireEvent.click(within(completedTrace).getByRole("button", { name: "Collapse work trace" }));
  expect(within(completedTrace).queryByText("Revising current document")).not.toBeInTheDocument();
  expect(within(completedTrace).getByText("complete · 3 steps")).toBeInTheDocument();
  expect(storedDraftHistory()[0]).toMatchObject({
    status: "complete",
    events: expect.arrayContaining([
      expect.objectContaining({
        kind: "assistant",
        text: expect.stringMatching(/Provider revision completed through/),
      }),
    ]),
  });
});

test("applies an explicit two-page expansion only when two new pages are returned", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Expansion Brief\n\nThe original summary remains intact.\n\n---\n\n## Added Analysis One\n\nThe first added page expands the operational analysis with concrete detail.\n\n---\n\n## Added Analysis Two\n\nThe second added page extends the analysis with risks, owners, and next steps.",
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "two-page-expansion-transfer",
        title: "Expansion Brief",
        sourceLabel: "transferred chat",
        createdAt: "7:11 PM",
        content: "# Expansion Brief\n\nThe original summary remains intact.",
      }}
    />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Make this two pages longer and expand on the content." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByText(/Version 2 applied from provider revision/)).toBeInTheDocument();
  });
  expect(documentBody().querySelectorAll("section.document-page")).toHaveLength(3);
  expect(documentText()).toContain("Added Analysis One");
  expect(documentText()).toContain("Added Analysis Two");
  expect(chatRequests).toHaveLength(1);
  expect((chatRequests[0] as { max_completion_tokens: number }).max_completion_tokens).toBe(
    24000,
  );
});

test("preserves document tables as markdown table context during provider revisions", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Revised Table Draft\n\n| Phase | Owner | Status |\n|---|---|---|\n| Intake | Taylor | Ready |\n| Review | Legal | Open |",
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "table-transfer",
        title: "Table Draft",
        sourceLabel: "table smoke test",
        createdAt: "9:17 AM",
        content: `# Table Draft

| Phase | Owner | Status |
|---|---|---|
| Intake | Taylor | Draft |
| Review | Legal | Open |`,
      }}
    />,
  );

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Update the Intake row status to Ready while keeping the table.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByText(/Version 2 applied from provider revision/)).toBeInTheDocument();
  });
  const prompt = (chatRequests[0] as { messages: Array<{ content: string }> }).messages[0].content;
  expect(prompt).toContain("Preserve existing tables as Markdown pipe tables");
  expect(prompt).toContain("| Phase | Owner | Status |");
  expect(prompt).toContain("| --- | --- | --- |");
  expect(prompt).toContain("| Intake | Taylor | Draft |");
  expect(documentBody().querySelector(".document-data-table")).toBeInTheDocument();
  expect(documentText()).toContain("Ready");
});

test("preserves transferred images and hyperlinks through focused assistant revisions", async () => {
  const sourceUrl = "https://example.com/artemis_mission?source=draft_view";
  const imageUrl = "https://example.com/mission-team.jpg";
  const chatRequests = installChatCompletionFetchMock((payload) => {
    const prompt = ((payload.messages as Array<{ content: string }>)[0]?.content ?? "");
    const currentDocument = prompt.split("\n\nCurrent document:\n")[1] ?? "";
    return currentDocument.replace(/^## Page 1 — /m, "## ");
  });

  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "asset-preservation-transfer",
        title: "Artemis Mission Brief",
        sourceLabel: "transferred chat",
        createdAt: "9:30 PM",
        content: `# Artemis Mission Brief

[NASA mission page](${sourceUrl})

![Crew portrait](${imageUrl} "Official crew portrait")

## Page 1 — Background

The mission paragraph and its surrounding content must remain intact.`,
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Remove the written page number from the heading only." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByText(/Version 2 applied from provider revision/)).toBeInTheDocument();
  });
  const request = chatRequests[0] as {
    messages: Array<{ content: string }>;
    web_enabled: boolean;
  };
  const prompt = request.messages[0].content;
  expect(request.web_enabled).toBe(false);
  expect(prompt).toMatch(/\[NASA mission page\]\(\/api\/drafts\/preserved-assets\/link-\d+\)/);
  expect(prompt).toMatch(/!\[Crew portrait\]\(\/api\/drafts\/preserved-assets\/image-\d+/);
  expect(documentBody().querySelector(`a[href="${sourceUrl}"]`)).toBeInTheDocument();
  expect(documentBody().querySelector(`img[src="${imageUrl}"]`)).toBeInTheDocument();
  expect(documentText()).toContain("Background");
  expect(documentText()).not.toContain("Page 1 — Background");
  expect(documentText()).toContain(
    "The mission paragraph and its surrounding content must remain intact.",
  );
});

test("leaves the current draft unchanged when a revision drops protected assets", async () => {
  const sourceUrl = "https://example.com/protected-source";
  const imageUrl = "https://example.com/protected-image.jpg";
  installChatCompletionFetchMock("# Replacement\n\nThe provider omitted the existing document assets.");
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "unsafe-revision-transfer",
        title: "Protected Draft",
        sourceLabel: "transferred chat",
        createdAt: "9:31 PM",
        content: `# Protected Draft

[Research source](${sourceUrl})

![Evidence](${imageUrl} "Evidence image")

## Page 2 — Findings

This original finding must remain in the live editor.`,
      }}
    />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Remove the page number from the heading." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getAllByText(/current document was left unchanged/i).length).toBeGreaterThan(0);
  });
  expect(documentText()).toContain("Findings");
  expect(documentText()).toContain("This original finding must remain in the live editor.");
  expect(documentBody().querySelector(`a[href="${sourceUrl}"]`)).toBeInTheDocument();
  expect(documentBody().querySelector(`img[src="${imageUrl}"]`)).toBeInTheDocument();
  expect(screen.queryByText(/Version 2 applied from provider revision/)).not.toBeInTheDocument();
});

test("restores a selected prior version in the editor", async () => {
  installChatCompletionFetchMock(
    "# Revised Draft\n\nSource control: Verify cited support before export.",
  );
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Add source control." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(documentText()).toContain("Source control:");
  });

  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(screen.getByRole("button", { name: /Version 1/ }));
  expect(documentText()).not.toContain("Source control:");
  expect(screen.getByText(/Version 1 restored/)).toBeInTheDocument();
});

test("keeps manual document edits in a single stable editor value", () => {
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  const editor = documentBody();
  const manualText = "Manual client note.\n\nMatter: Anderson v. Northstar Logistics";

  editor.innerHTML = "<p>Manual client note.</p><p>Matter: Anderson v. Northstar Logistics</p>";
  fireEvent.input(editor);

  expect(documentText()).toContain("Manual client note.");
  expect(documentText()).toContain("Matter: Anderson v. Northstar Logistics");
  expect(screen.getByText(/unsaved edits/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Save version" }));

  expect(screen.getByText(/Version 2 saved from manual edits/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  expect(screen.getByRole("button", { name: /Version 2/ })).toBeInTheDocument();
  expect(documentText()).toContain("Manual client note.");
  expect(manualText).toContain("Matter: Anderson");
});

test("starts non-legal drafts from the template chooser through the provider", async () => {
  installChatCompletionFetchMock(investmentMemoProviderDraft());
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: "Finance" }));
  fireEvent.click(screen.getByRole("button", { name: /Create Investment Memo draft/ }));

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue("Investment Memo Draft");
    expect(documentText()).toContain("Investment thesis:");
  });
  expect(documentText()).toContain("Financial snapshot:");
  expect(screen.getByText(/Investment Memo Draft drafted with provider-hosted web search/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
});

test("applies a template card to the current draft without replacing its content", async () => {
  installChatCompletionFetchMock(clientUpdateProviderDraft());
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: /Create Client Update draft/ }));
  await waitFor(() => {
    expect(documentText()).toContain("Anderson v. Northstar Logistics");
  });

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: "Finance" }));
  const investmentMemoCard = screen
    .getAllByRole("button", { name: /Investment Memo/ })
    .find((button) => !button.textContent?.includes("Start"));
  expect(investmentMemoCard).toBeDefined();
  fireEvent.click(investmentMemoCard as HTMLElement);

  expect(screen.getByLabelText("Document title")).toHaveValue(
    "Client Update Draft - Investment Memo",
  );
  expect(documentText()).toContain("Investment Memo Draft");
  expect(documentText()).toContain("Investment thesis");
  expect(documentText()).toContain("Source draft content");
  expect(documentText()).toContain("Anderson v. Northstar Logistics");
  expect(screen.getByText(/Investment Memo applied to the current draft/)).toBeInTheDocument();
  expect(
    screen.getByText(/Applied the Investment Memo template to the current document/),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Version 2").length).toBeGreaterThan(0);
  expect(screen.getByText("Latest saved revision")).toBeInTheDocument();
  expect(screen.getByText("Investment Memo template applied to the current draft")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Dismiss saved revision banner" }));

  expect(screen.queryByText("Latest saved revision")).not.toBeInTheDocument();
  expect(documentText()).toContain("Anderson v. Northstar Logistics");
});

test("uploads a Word-openable template into a blank canvas", async () => {
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.change(screen.getByLabelText("Upload Word document template"), {
    target: {
      files: [
        new File(
          [
            "<h1>Engagement Letter Template</h1><p>{{content}}</p><h2>Signature block</h2>",
          ],
          "Engagement Letter Template.doc",
          { type: "application/msword" },
        ),
      ],
    },
  });

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue(
      "Engagement Letter Template",
    );
  });
  expect(documentText()).toContain("Engagement Letter Template");
  expect(documentText()).toContain("{{content}}");
  expect(documentText()).toContain("Signature block");
  expect(
    screen.getByText(/Engagement Letter Template\.doc saved to templates and added to the canvas/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Saved and added Engagement Letter Template\.doc as a Word template on the blank canvas/),
  ).toBeInTheDocument();
  expect(window.localStorage.getItem("aperture-document-word-templates-v1")).toContain(
    "Engagement Letter Template.doc",
  );
});

// Minimal real .docx: centered bold+underlined title, centered SECTION 1,
// justified clause with an underlined lead run, a List Paragraph styled
// paragraph, a hard Word page break, and a centered signature page.
const SAMPLE_DOCX_BASE64 =
  "UEsDBBQAAAAIAHmI+1z1bniw+gAAAC0CAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2Ru07DMBSGd57C8lolDgwIoTgduIzAUB7gyD5JrPomH7c0b4/TlA6owMJo/5fvl92uD86yPSYywUt+XTecoVdBGz9I/r55ru44owxegw0eJZ+Q+Lq7ajdTRGIl7EnyMed4LwSpER1QHSL6ovQhOcjlmAYRQW1hQHHTNLdCBZ/R5yrPHbxrH7GHnc3s6VCulyEJLXH2sBhnluQQozUKctHF3utvlOpEqEvy6KHRRFoVAxcXCbPyM+CUey0vk4xG9gYpv4ArLvERkhY6qJ0ryfr3mgs7Q98bhef83BZTUEhUntzZ+qw4MH711w7Kk0X6/xVL7xdeHH+7+wRQSwMEFAAAAAgAeYj7XLmBRHGwAAAAKgEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4J1TRN5pWgaEUJMuCKkrKgeIEjeNaB5KwqO3JwMDIAZG278/y233sDO5YUzGOwZNVQNBJ70yTjM4D8f1DkjKwikxe4cMFkzQ8VV7wlnkspMmExIpiEsMppzDntIkJ7QiVT6gK5PRRytyKaOmQciL0Eg3db2l8d0A/mGSXjGIvWqADEvAf2w/jkbiwcurRZd/nPhKFFlEjZnB3UdF1atdFRYob+nHi/wJUEsDBBQAAAAIAHmI+1yd87I3rgAAABsBAAAcAAAAd29yZC9fcmVscy9kb2N1bWVudC54bWwucmVsc43PuwrCQBAF0N6vWKY3m1iISDZpREgr8QOGzeSB+2JnFfP3LtgoWFhehjl3pm6f1ogHRV68U1AVJQhy2g+LmxRc+/P2AIITugGNd6RgJYa22dQXMpjyDs9LYJERxwrmlMJRStYzWeTCB3J5MvpoMeUYJxlQ33AiuSvLvYyfBjRfpugGBbEbKhD9Gugf24/jounk9d2SSz8qJKfV5PtFj3GipOCdi+yAbGr59VPzAlBLAwQUAAAACAB5iPtc1FEz36sAAAD0AAAADwAAAHdvcmQvc3R5bGVzLnhtbEWNwQ6CMBBE735Fs3cpejCGULiZmHjwoB+wgQok7bbpNiB/b4kot5m8vJmyflsjRh14cKTgkOUgNDWuHahT8Hxc9mcQHJFaNI60glkz1NWunAqOs9Eskk9cTAr6GH0hJTe9tsiZ85oSe7lgMaYaOjm50PrgGs2c5q2Rxzw/SYsDQfUbFFMRZ5+OPAbsAvoexIqurYLbwPH+J4tFaBdpRPOlYsOyKuXqbomrD1BLAwQUAAAACAB5iPtclyo3vrEBAAACBAAAEQAAAHdvcmQvZG9jdW1lbnQueG1srVNNi9swEL33Vwy6r530UIqJvZhFDYFNNsTZvcvWxFaxJSHJcf3vKzlOYSFtWLYXfTBP8+bNG60ef3UtnNFYoWRKltGCAMpKcSHrlLwefzx8J2Adk5y1SmJKRrTkMfuyGhKuqr5D6cBnkDYZUtI4p5M4tlWDHbOR0ih97KRMx5y/mjoelOHaqAqt9QRdG39dLL7FHROSZD5lqfg45dbhpvcmbD8rGJIza1NSeTY0JM5W8Z/oZbmcyzis/RUeKFqc4TPEZUW+3T9TKOjhbfNEC8jXB0q3dHcMKHfBXgg+Wck7Uvp03LzsYPkRklK55u8Ud2QuoyXQ3TpfT9qSd7zzMjmXWM0q76s2aNGckWTwMkg0fgpqVqOFLZN+N+AUaDTBTHANQgAL7yNwtJURJXIQ0keEhbw2iGEyovtqdeHGFq9SnoV1e2ZYbZi+Jd1lG8lD6zm0Hvpgp8dVy3rrcwjXqN6B7LsSjW/Kv+jndFRyUCc4CWMdaK8zutWo0vgC3ahDmzzm2ur/PyWb9S4/vh4o7L1v96svRC19K8pxckQz44Q3pMRWDTe1x/MPC4fr781+A1BLAQIUAxQAAAAIAHmI+1z1bniw+gAAAC0CAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAeYj7XLmBRHGwAAAAKgEAAAsAAAAAAAAAAAAAAIABKwEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAeYj7XJ3zsjeuAAAAGwEAABwAAAAAAAAAAAAAAIABBAIAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHNQSwECFAMUAAAACAB5iPtc1FEz36sAAAD0AAAADwAAAAAAAAAAAAAAgAHsAgAAd29yZC9zdHlsZXMueG1sUEsBAhQDFAAAAAgAeYj7XJcqN76xAQAAAgQAABEAAAAAAAAAAAAAAIABxAMAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAAFAAUAQAEAAKQFAAAAAA==";

function sampleDocxFile(name = "Sample Services Agreement.docx") {
  const bytes = Uint8Array.from(atob(SAMPLE_DOCX_BASE64), (char) => char.charCodeAt(0));
  return new File([bytes], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

test("uploads a .docx template preserving alignment, underline, and Word page breaks", async () => {
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.change(screen.getByLabelText("Upload Word document template"), {
    target: { files: [sampleDocxFile()] },
  });

  await waitFor(() => {
    expect(documentText()).toContain("SAMPLE SERVICES AGREEMENT");
  });
  const editorHtml = documentBody().innerHTML;
  // Centered title/heading paragraphs keep alignment the editor and DOCX
  // export understand.
  expect(editorHtml).toContain('text-align: center');
  expect(editorHtml).toContain('text-align: justify');
  // Underlined runs survive import.
  expect(editorHtml).toMatch(/<u>\s*SAMPLE SERVICES AGREEMENT\s*<\/u>/);
  expect(editorHtml).toMatch(/<u>\s*1\.1 ENGAGEMENT:\s*<\/u>/);
  // The Word hard page break produces real document pages: the signature
  // page starts on its own sheet.
  expect(editorHtml.match(/class="document-page"/g)?.length).toBe(2);
  expect(documentText()).toContain("SIGNATURE PAGE");
  // No mammoth intermediates leak into the document.
  expect(editorHtml).not.toContain("doc-align-");
  // The fixture's List Paragraph style is mapped, so no import warning fires.
  expect(screen.queryByText(/Template import note/)).not.toBeInTheDocument();
});

test("renders template fill-in underscores as continuous blank-line spans", async () => {
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.change(screen.getByLabelText("Upload Word document template"), {
    target: {
      files: [
        new File(
          [
            "<h1>Blank Line Template</h1><p>Between ______________ Association and Manager, dated __.</p>",
          ],
          "Blank Line Template.doc",
          { type: "application/msword" },
        ),
      ],
    },
  });

  await waitFor(() => {
    expect(documentText()).toContain("Association and Manager");
  });
  const editorHtml = documentBody().innerHTML;
  expect(editorHtml).toContain('<span class="document-blank">______________</span>');
  // Runs under 3 underscores stay plain text.
  expect(editorHtml).toContain("dated __.");
  expect(editorHtml).not.toContain('<span class="document-blank">__</span>');
});

test("sends the uploaded template structure to the drafting model", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Escrow Closing Instructions\n\nGenerated draft body.",
  );
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.change(screen.getByLabelText("Upload Word document template"), {
    target: {
      files: [
        new File(
          [
            "<h1>Escrow Closing Instructions</h1><p>Wire instructions follow the escrow addendum.</p><h2>Disbursement schedule</h2>",
          ],
          "Escrow Closing Instructions.doc",
          { type: "application/msword" },
        ),
      ],
    },
  });
  await waitFor(() => {
    expect(documentText()).toContain("Wire instructions follow the escrow addendum.");
  });

  fireEvent.click(
    screen.getByRole("button", { name: /Create Escrow Closing Instructions draft/ }),
  );

  await waitFor(() => {
    expect(chatRequests).toHaveLength(1);
  });
  const prompt = (chatRequests[0] as { messages: Array<{ content: string }> }).messages[0]
    .content;
  expect(prompt).toContain('Follow the selected "Escrow Closing Instructions" template');
  expect(prompt).toContain("--- TEMPLATE START ---");
  expect(prompt).toContain("Wire instructions follow the escrow addendum.");
  expect(prompt).toContain("Disbursement schedule");
});

test("includes the selected template structure in a template-referencing revision", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Conformed Draft\n\nThe draft now follows the uploaded template structure.",
  );
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.change(screen.getByLabelText("Upload Word document template"), {
    target: {
      files: [
        new File(
          [
            "<h1>Outside Counsel Memo</h1><p>[Draft content]</p><h2>Approval workflow</h2>",
          ],
          "Outside Counsel Memo.doc",
          { type: "application/msword" },
        ),
      ],
    },
  });
  await waitFor(() => {
    expect(documentText()).toContain("Approval workflow");
  });

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Rewrite this document to fully match the template." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(chatRequests).toHaveLength(1);
  });
  const prompt = (chatRequests[0] as { messages: Array<{ content: string }> }).messages[0]
    .content;
  expect(prompt).toContain('Follow the selected "Outside Counsel Memo" template');
  expect(prompt).toContain("--- TEMPLATE START ---");
  expect(prompt).toContain(
    "Restructure the current document to follow the template while keeping the document's substantive content.",
  );
});

test("uploads a Word template and conforms the current draft to it", async () => {
  installChatCompletionFetchMock(clientUpdateProviderDraft());
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: /Create Client Update draft/ }));
  await waitFor(() => {
    expect(documentText()).toContain("Anderson v. Northstar Logistics");
  });

  fireEvent.change(screen.getByLabelText("Upload Word document template"), {
    target: {
      files: [
        new File(
          [
            "<h1>Outside Counsel Memo</h1><p>[Draft content]</p><h2>Approval workflow</h2>",
          ],
          "Outside Counsel Memo.doc",
          { type: "application/msword" },
        ),
      ],
    },
  });

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue(
      "Client Update Draft - Outside Counsel Memo",
    );
  });
  expect(documentText()).toContain("Outside Counsel Memo");
  expect(documentText()).toContain("Approval workflow");
  expect(documentText()).toContain("Anderson v. Northstar Logistics");
  expect(documentText()).not.toContain("[Draft content]");
  expect(
    screen.getByText(/Outside Counsel Memo\.doc saved to templates and applied to the current draft/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Saved and applied Outside Counsel Memo\.doc as a Word template without removing the current draft content/),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Version 2").length).toBeGreaterThan(0);
});

test("persists uploaded Word templates in the drawer across reloads", async () => {
  installChatCompletionFetchMock(clientUpdateProviderDraft());
  const view = render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.change(screen.getByLabelText("Upload Word document template"), {
    target: {
      files: [
        new File(
          [
            "<h1>Outside Counsel Memo</h1><p>[Draft content]</p><h2>Approval workflow</h2>",
          ],
          "Outside Counsel Memo.doc",
          { type: "application/msword" },
        ),
      ],
    },
  });

  await waitFor(() => {
    expect(window.localStorage.getItem("aperture-document-word-templates-v1")).toContain(
      "Outside Counsel Memo.doc",
    );
  });

  view.unmount();
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: "Legal" }));
  fireEvent.click(screen.getByRole("button", { name: /Create Client Update draft/ }));
  await waitFor(() => {
    expect(documentText()).toContain("Anderson v. Northstar Logistics");
  });

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: "Uploaded" }));
  const persistedTemplateCard = screen
    .getAllByRole("button", { name: /Outside Counsel Memo/ })
    .find((button) => !button.textContent?.includes("Start"));
  expect(persistedTemplateCard).toBeDefined();
  fireEvent.click(persistedTemplateCard as HTMLElement);

  expect(screen.getByLabelText("Document title")).toHaveValue(
    "Client Update Draft - Outside Counsel Memo",
  );
  expect(documentText()).toContain("Approval workflow");
  expect(documentText()).toContain("Anderson v. Northstar Logistics");
  expect(documentText()).not.toContain("[Draft content]");
});

test("persists document history across workspace reloads", async () => {
  installChatCompletionFetchMock(investmentMemoProviderDraft());
  const view = render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: "Finance" }));
  fireEvent.click(screen.getByRole("button", { name: /Create Investment Memo draft/ }));
  await waitFor(() => {
    expect(documentText()).toContain("Investment thesis:");
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Document history" })[0]);

  expect(
    screen.getByRole("button", {
      name: /Restore Investment Memo Draft from document history/,
    }),
  ).toBeInTheDocument();

  view.unmount();
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Document history" })[0]);

  expect(
    screen.getByRole("button", {
      name: /Restore Investment Memo Draft from document history/,
    }),
  ).toBeInTheDocument();
});

test("without connected models Drafts preserves prompts and manual document workflows", () => {
  const chatRequests = installChatCompletionFetchMock("This must not be requested.");
  render(<DocumentAssistantWorkspace data={{ ...sampleData, models: [], providers: [] }} initialDraft={{
    id: "manual-import-no-model",
    title: "Imported manual draft",
    sourceLabel: "Imported document",
    createdAt: "9:00 AM",
    content: "# Imported manual draft\n\nOriginal imported content.",
  }} />);

  expect(screen.getByRole("button", { name: "Document drafting model" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Document drafting model" })).toHaveTextContent("No models connected");
  expect(screen.getByText("AI drafting is unavailable.").closest("p")).toHaveTextContent("Ask your administrator to connect a model and grant your group access");
  expect(screen.getByRole("button", { name: "Rename document with AI" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Inline AI edit" })).toBeDisabled();
  const prompt = screen.getByRole("textbox", { name: "Ask the document assistant" });
  fireEvent.change(prompt, { target: { value: "Draft a client update when a model is connected." } });
  expect(screen.getByRole("button", { name: "Apply instruction" })).toBeDisabled();
  fireEvent.submit(prompt.closest("form")!);
  expect(prompt).toHaveValue("Draft a client update when a model is connected.");
  expect(chatRequests).toHaveLength(0);

  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Manually renamed document" } });
  documentBody().innerHTML = "<p>Manually edited imported content.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  expect(documentText()).toContain("Manually edited imported content.");
  const saved = JSON.parse(window.localStorage.getItem(SCOPED_DRAFT_CACHE_KEY) ?? "[]") as Array<{ title: string; content: string }>;
  expect(saved.some((item) => item.title === "Manually renamed document" && item.content.includes("Manually edited imported content."))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(screen.getByRole("dialog", { name: "Export document" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  expect(screen.getByRole("button", { name: /Restore Manually renamed document from document history/ })).toBeInTheDocument();
  expect(chatRequests).toHaveLength(0);
});

test("an unavailable model keeps an open inline edit and composer prompt intact", () => {
  const chatRequests = installChatCompletionFetchMock("This must not be requested.");
  const view = render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>Preserve the original selected wording.</p>";
  fireEvent.input(documentBody());
  const prompt = screen.getByRole("textbox", { name: "Ask the document assistant" });
  fireEvent.change(prompt, { target: { value: "My pending document instruction" } });
  selectEditorText("original selected wording");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit with AI" });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "AI instruction" }), { target: { value: "My pending inline instruction" } });

  view.rerender(<DocumentAssistantWorkspace data={{ ...sampleData, providers: sampleData.providers.map((provider) => ({ ...provider, connected: false })) }} />);
  expect(within(dialog).getByRole("button", { name: "Run AI instruction" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Run AI instruction" }));
  fireEvent.submit(prompt.closest("form")!);
  expect(prompt).toHaveValue("My pending document instruction");
  expect(within(dialog).getByRole("combobox", { name: "AI instruction" })).toHaveValue("My pending inline instruction");
  expect(documentText()).toContain("Preserve the original selected wording.");
  expect(chatRequests).toHaveLength(0);

  view.rerender(<DocumentAssistantWorkspace data={sampleData} />);
  expect(screen.getByRole("button", { name: "Apply instruction" })).toBeEnabled();
  expect(within(dialog).getByRole("button", { name: "Run AI instruction" })).toBeEnabled();
  expect(prompt).toHaveValue("My pending document instruction");
});

test("without connected models deck creation remains manual and AI requests retain their prompt", () => {
  const chatRequests = installChatCompletionFetchMock("This must not be requested.");
  render(<DocumentAssistantWorkspace data={{ ...sampleData, models: [], providers: [], me: { ...sampleData.me, role: "PLATFORM_OWNER" } }} />);
  expect(screen.getByText("AI drafting is unavailable.").closest("p")).toHaveTextContent("Connect a provider and enable a model in the Platform Owner Console");
  fireEvent.click(screen.getByRole("button", { name: "Deck", exact: true }));
  expect(screen.getByText("Slide 1 of 1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Rename deck with AI" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Edit slide with AI" })).toBeDisabled();
  const prompt = screen.getByRole("textbox", { name: "Ask the deck assistant" });
  fireEvent.change(prompt, { target: { value: "Build this deck after setup." } });
  fireEvent.submit(prompt.closest("form")!);
  expect(prompt).toHaveValue("Build this deck after setup.");
  expect(chatRequests).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(screen.getByText("PowerPoint deck")).toBeInTheDocument();
});

test("external navigation uses a stable guard that reads current unsaved edits and unregisters", () => {
  const changed = vi.fn<(guard: DraftNavigationGuard | null) => void>();
  const view = render(<DocumentAssistantWorkspace data={sampleData} onNavigationGuardChange={changed} />);
  const guard = changed.mock.calls[0]?.[0];
  expect(guard).toBeTypeOf("function");
  const cleanProceed = vi.fn();
  act(() => guard!("open a clean page", cleanProceed));
  expect(cleanProceed).toHaveBeenCalledOnce();
  documentBody().innerHTML = "<p>Keep the edits created after guard registration.</p>";
  fireEvent.input(documentBody());
  const dirtyProceed = vi.fn();
  act(() => guard!("open another page", dirtyProceed));
  expect(dirtyProceed).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Unsaved draft edits" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(documentText()).toContain("Keep the edits created after guard registration.");
  act(() => guard!("open another page", dirtyProceed));
  fireEvent.click(screen.getByRole("button", { name: "Discard and continue" }));
  expect(dirtyProceed).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(changed).toHaveBeenLastCalledWith(null);
});

test("a fresh drafting model default prefers text while keeping image models in menu order", () => {
  render(<DocumentAssistantWorkspace data={dataWithImageFirstDraftModels()} />);

  const trigger = screen.getByRole("button", { name: "Document drafting model" });
  expect(trigger).toHaveTextContent("Draft text model");
  expect(window.localStorage.getItem("aperture-document-draft-model-v1")).toBeNull();

  fireEvent.click(trigger);
  const options = within(screen.getByRole("listbox", { name: "Select drafting model" })).getAllByRole("option");
  expect(options).toHaveLength(2);
  expect(options[0]).toHaveTextContent("Draft image model");
  expect(options[1]).toHaveTextContent("Draft text model");
});

test("an unavailable drafting model falls back to text when an image model is first", () => {
  const data = dataWithImageFirstDraftModels();
  const view = render(
    <DocumentAssistantWorkspace data={{
      ...data,
      models: [{ ...data.models[1], id: "draft-temporary-model", name: "Temporary drafting model" }],
    }} />,
  );
  expect(screen.getByRole("button", { name: "Document drafting model" }))
    .toHaveTextContent("Temporary drafting model");

  view.rerender(<DocumentAssistantWorkspace data={data} />);
  expect(screen.getByRole("button", { name: "Document drafting model" }))
    .toHaveTextContent("Draft text model");
});

test("an explicitly selected image drafting model survives a data refresh", () => {
  window.localStorage.setItem("aperture-document-draft-model-v1", "draft-text-model");
  const data = dataWithImageFirstDraftModels();
  const view = render(<DocumentAssistantWorkspace data={data} />);

  fireEvent.click(screen.getByRole("button", { name: "Document drafting model" }));
  fireEvent.click(screen.getByRole("option", { name: /Draft image model/ }));
  expect(screen.getByRole("button", { name: "Document drafting model" }))
    .toHaveTextContent("Draft image model");

  view.rerender(<DocumentAssistantWorkspace data={{ ...data, models: [...data.models] }} />);
  expect(screen.getByRole("button", { name: "Document drafting model" }))
    .toHaveTextContent("Draft image model");
  expect(window.localStorage.getItem("aperture-document-draft-model-v1")).toBe("draft-text-model");
});

test("a starred image drafting model is preserved and restored after becoming available", () => {
  window.localStorage.setItem("aperture-document-draft-model-v1", "draft-image-model");
  const data = dataWithImageFirstDraftModels();
  const view = render(<DocumentAssistantWorkspace data={data} />);
  expect(screen.getByRole("button", { name: "Document drafting model" }))
    .toHaveTextContent("Draft image model");

  view.rerender(<DocumentAssistantWorkspace data={{ ...data, models: [data.models[1]] }} />);
  expect(screen.getByRole("button", { name: "Document drafting model" }))
    .toHaveTextContent("Draft text model");
  expect(window.localStorage.getItem("aperture-document-draft-model-v1")).toBe("draft-image-model");

  view.rerender(<DocumentAssistantWorkspace data={data} />);
  expect(screen.getByRole("button", { name: "Document drafting model" }))
    .toHaveTextContent("Draft image model");
});

test("starring a drafting model in the topbar menu makes it the persistent default", () => {
  const data = dataWithApprovedDraftModel("openrouter-openai-gpt-4o-mini");
  const view = render(
    <DocumentAssistantWorkspace data={data} brandName="Aperture Chat" />,
  );

  const trigger = screen.getByRole("button", { name: "Document drafting model" });
  expect(trigger).toHaveTextContent("Client Update Agent");

  // The whole trigger opens the menu; picking a row is session-only.
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: /OpenRouter: openai\/gpt-4o-mini/ }));
  expect(
    screen.getByText(/OpenRouter: openai\/gpt-4o-mini selected for drafting/),
  ).toBeInTheDocument();
  expect(window.localStorage.getItem("aperture-document-draft-model-v1")).toBeNull();

  // The star pins it as the default across sessions, chat-style.
  fireEvent.click(trigger);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Set OpenRouter: openai/gpt-4o-mini as default drafting model",
    }),
  );
  expect(
    screen.getByText(/OpenRouter: openai\/gpt-4o-mini is now your default drafting model/),
  ).toBeInTheDocument();
  expect(window.localStorage.getItem("aperture-document-draft-model-v1")).toBe(
    "openrouter-openai-gpt-4o-mini",
  );

  fireEvent.click(screen.getByRole("button", { name: "Assistant settings" }));
  expect(screen.getByLabelText("Drafting agent")).toHaveValue(
    "openrouter-openai-gpt-4o-mini",
  );

  view.unmount();
  render(
    <DocumentAssistantWorkspace data={data} brandName="Aperture Chat" />,
  );

  expect(
    screen.getByRole("button", { name: "Document drafting model" }),
  ).toHaveTextContent("OpenRouter: openai/gpt-4o-mini");
});

test("document drafting model selector includes connected platform-owner models", () => {
  const data = ownerPreviewDataWithApprovedDraftModel("openrouter-openai-gpt-4o-mini");
  render(
    <DocumentAssistantWorkspace data={data} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Document drafting model" }));
  const options = screen.getAllByRole("option").map((option) => option.textContent ?? "");

  expect(options.some((text) => text.includes("Client Update Agent"))).toBe(true);
  expect(options.some((text) => text.includes("OpenRouter: openai/gpt-4o-mini"))).toBe(true);
  expect(options.some((text) => text.includes("OpenAI: GPT-5.5"))).toBe(true);
});

test("infers a finance template from a draft request", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Investment Memo Draft\n\nInvestment thesis: AI software services acquisition has provider-drafted diligence support.\n\nOpportunity: AI software services acquisition",
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Draft a finance investment memo for an AI software services acquisition.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue("Investment Memo Draft");
    expect(documentText()).toContain("Investment thesis:");
  });
  expect(chatRequests).toHaveLength(1);
  const payload = chatRequests[0] as { messages: Array<{ content: string }>; web_enabled: boolean };
  expect(payload.web_enabled).toBe(false);
  expect(payload.messages[0].content).toContain("Draft type: Investment Memo");
  expect(payload.messages[0].content).toContain("Do not claim live web research");
  expect(documentText()).toContain(
    "Opportunity: AI software services acquisition",
  );
  expect(documentText()).not.toContain("Requested focus:");
  expect(screen.getByText(/Provider drafting completed through/)).toBeInTheDocument();
});

test("fills legal draft request details instead of reusing the seeded matter", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# Client Update Draft\n\nMatter: Cobalt Logistics discovery response\n\nThe discovery response is ready for attorney review before external delivery.",
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Draft a client update for Cobalt Logistics discovery response.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue("Client Update Draft");
    expect(documentText()).toContain(
      "Matter: Cobalt Logistics discovery response",
    );
  });
  expect(chatRequests).toHaveLength(1);
  const payload = chatRequests[0] as { messages: Array<{ content: string }>; web_enabled: boolean };
  expect(payload.web_enabled).toBe(false);
  expect(payload.messages[0].content).toContain("Draft type: Client Update");
  expect(documentText()).not.toContain(
    "Matter: Anderson v. Northstar Logistics",
  );
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
});

test("drafts a paper from a prompt library selection without showing prompt metadata", async () => {
  const chatRequests = installChatCompletionFetchMock(
    providerPagedDraft(
      "George Lucas, Star Wars, and the Merchandising Rights Opportunity Draft",
      25,
      "George Lucas Star Wars merchandising opportunity",
    ),
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: "Library" }));

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value:
        "I want you to draft me a twenty-five page paper on how George Lucas was able to get the rights to have merchandise for Star Wars.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue(
      "George Lucas, Star Wars, and the Merchandising Rights Opportunity Draft",
    );
    expect(documentBody().querySelectorAll(".document-page").length).toBeGreaterThan(1);
  });
  expect(chatRequests).toHaveLength(1);
  const payload = chatRequests[0] as { messages: Array<{ content: string }>; web_enabled: boolean };
  expect(payload.web_enabled).toBe(false);
  expect(payload.messages[0].content).toContain("Draft type: Research Paper");
  expect(payload.messages[0].content).toContain("Do not claim live web research");
  expect(documentText()).toContain("George Lucas Star Wars merchandising opportunity page 25");
  expect(documentText()).not.toMatch(/\bshould\b/i);
  expect(documentText()).not.toMatch(/\bplaceholder\b/i);
  expect(documentText()).not.toContain("Purpose:");
  expect(documentText()).not.toContain("Template instruction:");
  expect(documentText()).not.toContain("[Compose the response");
});

test("a from-scratch legal instrument request carries drafting craft rules", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "# MASTER SERVICES AGREEMENT\n\nEffective as of [Effective Date].",
  );
  render(<DocumentAssistantWorkspace data={sampleData} brandName="S.F. Steward" />);
  disableWebSearch();

  // No template chosen — the request alone has to produce instrument craft.
  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Draft a master services agreement between an accounting firm and a software vendor.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  const prompt = String(
    (chatRequests[0] as { messages: Array<{ content?: string }> }).messages[0]?.content ?? "",
  );
  expect(prompt).toContain("This is a legal instrument");
  expect(prompt).toContain("WHEREAS");
  expect(prompt).toContain("IN WITNESS WHEREOF");
  expect(prompt).toContain("number subsections hierarchically");
  // Section titles must be real headings, and an executed instrument carries
  // no research annotations.
  expect(prompt).toContain("never a bold paragraph standing in for a heading");
  expect(prompt).toContain("never annotate clauses with [Source: ...] notes");
  // The sourcing rule matches the genre: an instrument gets placeholders, not
  // "mark it for verification" annotations.
  expect(prompt).toContain("Never add [Source: ...] notes, verification brackets");
  expect(prompt).not.toContain("mark it for verification instead of inventing a citation");
  expect(prompt).toContain("governing law and venue");
  // Placeholders over invention, and real ruled lines for anything signed.
  expect(prompt).toContain("[Party Legal Name]");
  expect(prompt).toContain("run of underscores");
  expect(prompt).not.toContain("This is a financial document");
});

test("a research paper keeps its inline sourcing rule", async () => {
  const chatRequests = installChatCompletionFetchMock("# Research Paper\n\nBody.");
  render(<DocumentAssistantWorkspace data={sampleData} brandName="S.F. Steward" />);
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Write a research paper on merchandising economics." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  const prompt = String(
    (chatRequests[0] as { messages: Array<{ content?: string }> }).messages[0]?.content ?? "",
  );
  expect(prompt).toContain("mark it for verification instead of inventing a citation");
  expect(prompt).not.toContain("This is a legal instrument");
});

test("an unrelated starter template never sets the draft type for an instrument", async () => {
  const chatRequests = installChatCompletionFetchMock("# MASTER SERVICES AGREEMENT\n\nBody.");
  render(<DocumentAssistantWorkspace data={sampleData} brandName="S.F. Steward" />);
  disableWebSearch();

  // "implementation services" keyword-matches the engineering starter; the
  // request is still an agreement, and that is what the model must be told.
  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value:
        "Draft a master services agreement with a software vendor for implementation services and milestone payments.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  const prompt = String(
    (chatRequests[0] as { messages: Array<{ content?: string }> }).messages[0]?.content ?? "",
  );
  expect(prompt).toContain("Draft type: taken from the user request");
  expect(prompt).not.toContain("Draft type: Implementation Plan");
  expect(prompt).toContain("This is a legal instrument");
  // And a contract never carries a script.
  expect(prompt).toContain("never a script");
});

test("a financial document request carries figure and totals rules instead", async () => {
  const chatRequests = installChatCompletionFetchMock("# Invoice 1042\n\n| Item | Amount |\n| --- | ---: |");
  render(<DocumentAssistantWorkspace data={sampleData} brandName="S.F. Steward" />);
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Create an invoice for the March engagement hours." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  const prompt = String(
    (chatRequests[0] as { messages: Array<{ content?: string }> }).messages[0]?.content ?? "",
  );
  expect(prompt).toContain("This is a financial document");
  expect(prompt).toContain("Right-align numeric columns");
  expect(prompt).toContain("every total must equal its lines");
  expect(prompt).toContain("never invent bank or tax identifiers");
  expect(prompt).not.toContain("This is a legal instrument");
});

test("a right-aligned money column stays right aligned in the document", async () => {
  installChatCompletionFetchMock(
    "# Invoice 1042\n\n| Description | Hours | Amount |\n| --- | ---: | ---: |\n| Advisory | 12 | $4,800.00 |\n| **Total** | | **$4,800.00** |",
  );
  render(<DocumentAssistantWorkspace data={sampleData} brandName="S.F. Steward" />);
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Create an invoice for the March engagement hours." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => expect(documentText()).toContain("$4,800.00"));
  const table = documentBody().querySelector("table.document-data-table")!;
  const headers = Array.from(table.querySelectorAll("th"));
  expect(headers[0].getAttribute("style")).toBeNull();
  expect(headers[1].getAttribute("style")).toContain("text-align: right");
  expect(headers[2].getAttribute("style")).toContain("text-align: right");
  const firstRow = Array.from(table.querySelectorAll("tbody tr")).at(0)!;
  expect(firstRow.querySelectorAll("td")[2].getAttribute("style")).toContain("text-align: right");
});

test("honors requested MLA, screenplay, and contract formats from prompts", async () => {
  const chatRequests = installChatCompletionFetchMock((payload) => {
    const prompt = String(
      (payload.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? "",
    );
    if (/MLA format/i.test(prompt)) {
      return "# George Lucas and Star Wars Merchandising Rights\n\nTaylor Example\nInstructor\nCourse\n2 July 2026\n\nGeorge Lucas negotiated for merchandising economics that became central to the Star Wars business.\n\n## Works Cited\n\nLucasfilm archival materials.";
    }
    if (/film script mode/i.test(prompt)) {
      return "# Star Wars Merchandise Rights Scene\n\nFADE IN:\n\nINT. STUDIO OFFICE - DAY\n\nLUCAS and EXECUTIVE discuss merchandising rights.\n\nLUCAS: The characters can live beyond the release window.";
    }
    return "# Software Services Agreement Draft\n\nEffective Date: July 2, 2026\n\n## Confidentiality\n\nEach party will protect confidential information.";
  });

  let view = render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value:
        "Write me an essay in MLA format about George Lucas and Star Wars merchandising rights.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(documentText()).toContain("Works Cited");
  });
  expect(chatRequests).toHaveLength(1);
  expect((chatRequests[0] as { messages: Array<{ content: string }> }).messages[0].content).toContain(
    "MLA format",
  );
  expect(documentText()).not.toContain("Template instruction:");

  view.unmount();
  view = render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Write this as a film script mode about negotiating Star Wars merchandise rights.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(documentText()).toContain("FADE IN:");
  });
  expect(chatRequests).toHaveLength(2);
  expect((chatRequests[1] as { messages: Array<{ content: string }> }).messages[0].content).toContain(
    "film script mode",
  );

  view.unmount();
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Draft a legal contract for a software services agreement.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(screen.getByLabelText("Document title")).toHaveValue(
      "Software Services Agreement Draft",
    );
    expect(documentText()).toContain("Effective Date:");
  });
  expect(chatRequests).toHaveLength(3);
  expect(documentText()).toContain("Confidentiality");
});

test("uses content-backed pagination instead of stretching a short long-form response", async () => {
  const chatRequests = installChatCompletionFetchMock(
    providerPagedDraft(
      "Licensing Leverage in Entertainment Deals",
      12,
      "Licensing leverage in entertainment deals",
    ),
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  disableWebSearch();

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Draft a twelve page paper about licensing leverage in entertainment deals.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(documentBody().querySelectorAll(".document-page").length).toBeGreaterThan(1);
  });
  expect(chatRequests).toHaveLength(1);
  const payload = chatRequests[0] as { max_completion_tokens: number; messages: Array<{ content: string }> };
  expect(payload.max_completion_tokens).toBe(24000);
  expect(payload.messages[0].content).toContain("Draft a twelve page paper");
  expect(documentBody().querySelectorAll(".document-page").length).toBeLessThan(12);
  expect(screen.getByRole("navigation", { name: /Page navigation\. Page 1 of/ })).toBeInTheDocument();
  expect(documentText()).toContain("Licensing Leverage in Entertainment Deals");
  expect(documentText()).toContain("Licensing leverage in entertainment deals page 12");
  expect(documentText()).not.toMatch(/requested \d+-page/i);
});

test("exports the available document formats with the right fallback file type", async () => {
  const downloadSpy = installDownloadSpy();
  installChatCompletionFetchMock(clientUpdateProviderDraft());

  try {
    render(
      <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
    fireEvent.click(screen.getByRole("button", { name: /Create Client Update draft/ }));
    await waitFor(() => {
      expect(documentText()).toContain("Anderson v. Northstar Logistics");
    });
    openExportDialog();

    expect(screen.getByRole("dialog", { name: "Export document" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Word document/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Markdown/ })).toBeInTheDocument();
    expect(
      screen.getByText("Editable Word file with preview page breaks and embedded images."),
    ).toBeInTheDocument();
    expect(screen.getByText("Best for plain text or web publishing.")).toBeInTheDocument();
    // PDF stays an honest browser-print capability: the app opens the saved
    // version in the print dialog and lets the user choose "Save as PDF".
    expect(screen.getByRole("button", { name: /Print \/ Save as PDF/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Choose "Save as PDF" in that dialog to keep a PDF copy/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Basic DOCX/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Choose save location/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Word document/ }));
    await waitFor(() => {
      expect(downloadSpy.downloads[0]).toMatchObject({
        filename: "client-update-draft.docx",
        href: "blob:aperture-export-1",
      });
    });
    expect(downloadSpy.downloads[0].blob.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    // A genuine OOXML package: ZIP magic plus the main document part, with
    // the draft text readable inside the stored entry.
    const wordBytes = await readBlobAsText(downloadSpy.downloads[0].blob);
    expect(wordBytes.startsWith("PK")).toBe(true);
    expect(wordBytes).toContain("word/document.xml");
    expect(wordBytes).toContain("Anderson v. Northstar Logistics");
    expect(screen.getByText(/Downloaded client-update-draft\.docx/)).toBeInTheDocument();
    expect(screen.getByText(/Sent to your browser downloads/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Markdown/ }));
    await waitFor(() => {
      expect(downloadSpy.downloads[1]).toMatchObject({
        filename: "client-update-draft.md",
        href: "blob:aperture-export-2",
      });
    });
    expect(downloadSpy.downloads[1].blob.type).toBe("text/markdown;charset=utf-8");
    expect(screen.getByText(/Downloaded client-update-draft\.md/)).toBeInTheDocument();
    expect(downloadSpy.createObjectURL).toHaveBeenCalledTimes(2);
  } finally {
    downloadSpy.restore();
  }
});

test("uses the save picker for each document export format when available", async () => {
  installChatCompletionFetchMock(clientUpdateProviderDraft());
  const write = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const createWritable = vi.fn().mockResolvedValue({ write, close });
  const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });

  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: showSaveFilePicker,
  });

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: /Create Client Update draft/ }));
  await waitFor(() => {
    expect(documentText()).toContain("Anderson v. Northstar Logistics");
  });
  openExportDialog();

  fireEvent.click(screen.getByRole("button", { name: /Word document/ }));
  await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalledTimes(1));
  expect(showSaveFilePicker.mock.calls[0][0]).toMatchObject({
    suggestedName: "client-update-draft.docx",
  });
  expect(write.mock.calls[0][0]).toBeInstanceOf(Blob);
  await waitFor(() => {
    expect(screen.getByText(/Saved client-update-draft\.docx to your selected location/)).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole("button", { name: /Markdown/ }));
  await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalledTimes(2));
  expect(showSaveFilePicker.mock.calls[1][0]).toMatchObject({
    suggestedName: "client-update-draft.md",
  });
  expect(createWritable).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Saved to your selected location/)).toBeInTheDocument();
});

test("keeps export single-flight while Word packaging is in progress", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const createWritable = vi.fn().mockResolvedValue({ write, close });
  let resolvePicker: (handle: { createWritable: typeof createWritable }) => void = () => {};
  const pickerPromise = new Promise<{ createWritable: typeof createWritable }>((resolve) => {
    resolvePicker = resolve;
  });
  const showSaveFilePicker = vi.fn(() => pickerPromise);
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: showSaveFilePicker,
  });

  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "chat-transfer-export-progress",
        title: "Export Progress Draft",
        sourceLabel: "Chat response",
        createdAt: "9:17 AM",
        content: "# Export Progress Draft\n\nThe saved document is ready for packaging.",
      }}
    />,
  );

  openExportDialog();
  const wordChoice = screen.getByRole("button", { name: /Word document/ });
  fireEvent.click(wordChoice);

  expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Export in progress" })).toBeDisabled();
  expect(screen.getByText("Preparing Word document")).toBeInTheDocument();
  expect(wordChoice).toBeDisabled();
  fireEvent.click(wordChoice);
  expect(showSaveFilePicker).toHaveBeenCalledTimes(1);

  resolvePicker({ createWritable });
  await waitFor(() => {
    expect(screen.getByText(/Saved export-progress-draft\.docx/)).toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  expect(write).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

test("transferred mermaid fences land as diagram figures, not mermaid source text", () => {
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "chat-transfer-mermaid",
        title: "LENR milestones",
        sourceLabel: "Chat response",
        createdAt: "9:17 AM",
        content: `# LENR milestones

\`\`\`mermaid
timeline
    title Figure 6. Selected international and Chinese LENR milestones
    1989 : Fleischmann and Pons announce cold fusion
         : Worldwide replication campaign begins
\`\`\`

Author-created timeline based on the primary papers.`,
      }}
    />,
  );

  const body = documentBody();
  expect(body.querySelector(".document-diagram-figure")).toBeInTheDocument();
  expect(body.querySelector(".document-diagram-pending")).toBeInTheDocument();
  expect(body.querySelector(".document-code-block")).toBeNull();
  expect(body.querySelector(".md-code-panel")).toBeNull();
  expect(documentText()).not.toContain("Fleischmann and Pons announce cold fusion");
  expect(documentText()).not.toContain("Worldwide replication campaign begins");
  expect(documentText()).toContain("Author-created timeline based on the primary papers");
});

test("transferred image papers use content-backed Word-ready pages", async () => {
  const downloadSpy = installDownloadSpy();

  try {
    render(
      <DocumentAssistantWorkspace
        data={sampleData}
        brandName="Aperture Chat"
        initialDraft={{
          id: "chat-transfer-artemis",
          title: "write a 2 page paper on Artemis",
          sourceLabel: "write a 2 page paper on Artemis",
          createdAt: "9:17 AM",
          content: `# Artemis II: Humanity's Return to the Moon

![Artemis II crew portrait](https://commons.wikimedia.org/wiki/Special:FilePath/Artemis%202%20Crew%20Portrait.jpg "Artemis II crew portrait")

Artemis II is the first crewed mission in NASA's Artemis campaign. It is designed to test Orion, mission operations, crew systems, and deep-space navigation before a later lunar landing mission.

## Crew and Mission Role

Reid Wiseman, Victor Glover, Christina Koch, and Jeremy Hansen will fly around the Moon and return to Earth. Their work will help validate spacecraft systems, communications, life support, and crew procedures.

## Why the Mission Matters

The mission is a bridge between Apollo-era exploration and sustained lunar operations. A successful flight would give NASA and its partners evidence that Orion can support astronauts beyond low Earth orbit.`,
        }}
      />,
    );

    expect(documentBody().querySelectorAll(".document-page")).toHaveLength(1);
    expect(documentBody().querySelectorAll(".document-image-figure")).toHaveLength(1);

    openExportDialog();
    fireEvent.click(screen.getByRole("button", { name: /Word document/ }));

    await waitFor(() => {
      expect(downloadSpy.downloads[0]).toMatchObject({
        filename: "write-a-2-page-paper-on-artemis.docx",
        href: "blob:aperture-export-1",
      });
    });
    const wordXml = await readBlobAsText(downloadSpy.downloads[0].blob);
    // jsdom cannot rasterize the remote photo, so the picture is referenced
    // as an external image relationship instead of being dropped.
    expect(wordXml).toContain("Artemis%202%20Crew%20Portrait.jpg");
    expect(wordXml).toContain('TargetMode="External"');
    // The short provider result is not stretched into a fake second sheet.
    expect(wordXml.match(/<w:pageBreakBefore\/>/g) ?? []).toHaveLength(0);
  } finally {
    downloadSpy.restore();
  }
});

test("export with unsaved edits explains the save requirement and saves from the notice", async () => {
  const downloadSpy = installDownloadSpy();

  try {
    render(
      <DocumentAssistantWorkspace
        data={sampleData}
        brandName="Aperture Chat"
        initialDraft={{
          id: "chat-transfer-save-gate",
          title: "Save Gate Draft",
          sourceLabel: "Save Gate Draft",
          createdAt: "9:17 AM",
          content: `# Save Gate Draft

The original body copy arrives from the transfer and is already saved as Version 1.`,
        }}
      />,
    );

    const editor = documentBody();
    editor.innerHTML += "<p>Manual addendum the user typed but has not saved.</p>";
    fireEvent.input(editor);

    openExportDialog();
    fireEvent.click(screen.getByRole("button", { name: /Word document/ }));

    // The download must not run silently against unsaved edits; the panel
    // says exactly why and offers the fix.
    expect(screen.getByRole("alert")).toHaveTextContent(/Save your edits first/);
    expect(downloadSpy.downloads).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save version and export" }));
    await waitFor(() => {
      expect(downloadSpy.downloads[0]).toMatchObject({ filename: "save-gate-draft.docx" });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const wordXml = await readBlobAsText(downloadSpy.downloads[0].blob);
    expect(wordXml).toContain("Manual addendum the user typed but has not saved.");
    expect(screen.getByText(/Downloaded save-gate-draft\.docx/)).toBeInTheDocument();
  } finally {
    downloadSpy.restore();
  }
});

test("markdown page-break rules become real preview pages that exports honor once", async () => {
  const downloadSpy = installDownloadSpy();

  try {
    render(
      <DocumentAssistantWorkspace
        data={sampleData}
        brandName="Aperture Chat"
        initialDraft={{
          id: "chat-transfer-ruled",
          title: "Mission Report Draft",
          sourceLabel: "Mission Report Draft",
          createdAt: "9:17 AM",
          content: [
            "# Mission Report",
            "Prepared as a short ruled draft.",
            "---",
            "## Page 1 — Introduction",
            "The introduction body copy explains the mission context in a few clear sentences.",
            "---",
            "## Page 2 — Findings",
            "The findings body copy summarizes the most important results in a few clear sentences.",
          ].join("\n\n"),
        }}
      />,
    );

    const pages = documentBody().querySelectorAll(".document-page");
    expect(pages).toHaveLength(3);
    // Pagination consumes the explicit rules; no dashed markers remain inside
    // pages, so exports cannot double-break the same boundary.
    expect(documentBody().querySelector("hr.document-page-break")).toBeNull();
    expect(pages[1].querySelector("h2")?.textContent).toBe("Introduction");
    expect(pages[2].querySelector("h2")?.textContent).toBe("Findings");

    openExportDialog();
    fireEvent.click(screen.getByRole("button", { name: /Word document/ }));
    await waitFor(() => {
      expect(downloadSpy.downloads).toHaveLength(1);
    });
    const wordXml = await readBlobAsText(downloadSpy.downloads[0].blob);
    // Exactly one Word break per page boundary; a doubled boundary renders as
    // a blank sheet in Word.
    expect(wordXml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(2);
  } finally {
    downloadSpy.restore();
  }
});

test("inserting a page break splits a paginated draft into a new numbered sheet", () => {
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "chat-transfer-break",
        title: "Short Chat Transfer",
        sourceLabel: "Chat response",
        createdAt: "9:17 AM",
        content: `# Short Chat Transfer

This response is short enough for one page, but it still needs paper boundaries.`,
      }}
    />,
  );

  expect(documentBody().querySelectorAll(".document-page")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Insert content" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Page break" }));

  const pages = documentBody().querySelectorAll(".document-page");
  expect(pages).toHaveLength(2);
  expect(pages[0].querySelector(".document-page-label")).toBeNull();
  expect(pages[1].querySelector(".document-page-label")).toBeNull();
  expect(screen.getByRole("navigation", { name: /Page navigation.*of 2/ })).toBeInTheDocument();
  expect(pages[1]).toHaveAttribute("data-page-break-before", "manual");
  expect(documentBody().querySelector("hr.document-page-break")).toBeNull();
});

test("backspace crosses a preview page boundary like a normal Word paragraph", () => {
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "chat-transfer-boundary-edit",
        title: "Boundary Edit",
        sourceLabel: "Chat response",
        createdAt: "9:17 AM",
        content:
          "# Boundary Edit\n\nAlpha paragraph.\n\n---\n\n## Beta paragraph.\n\n---\n\n## Gamma paragraph.",
      }}
    />,
  );

  expect(documentBody().querySelectorAll(".document-page")).toHaveLength(3);
  placeEditorCaretAtTextStart("Beta paragraph.");
  fireEvent.keyDown(documentBody(), { key: "Backspace" });

  expect(documentBody().querySelectorAll(".document-page")).toHaveLength(2);
  expect(documentBody()).toHaveTextContent("Alpha paragraph.Beta paragraph.");
  expect(screen.getByText(/Page boundary removed/)).toBeInTheDocument();
});

test("wraps short transferred chat output in a real document page", () => {
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "chat-transfer-short",
        title: "Short Chat Transfer",
        sourceLabel: "Chat response",
        createdAt: "9:17 AM",
        content: `# Short Chat Transfer

This response is short enough for one page, but it still needs paper boundaries.

---

Summary: This divider should not masquerade as a document page.`,
      }}
    />,
  );

  const editor = documentBody();
  expect(editor).toHaveClass("is-paginated");
  expect(editor.querySelectorAll(".document-page")).toHaveLength(1);
  expect(editor.querySelector(".document-page-break")).toBeInTheDocument();
  expect(editor).toHaveTextContent("paper boundaries");
});

test("lets users edit the title and insert formatted document objects", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: async () => ({
        query: {
          pages: {
            "1": {
              title: "Star Wars",
              thumbnail: { source: "https://example.com/star-wars.jpg" },
            },
          },
        },
      }),
    }),
  );

  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  const title = screen.getByLabelText("Document title");
  fireEvent.change(title, { target: { value: "Custom Draft Title" } });
  expect(title).toHaveValue("Custom Draft Title");
  expect(screen.queryByRole("button", { name: "Edit document title" })).not.toBeInTheDocument();

  openDocumentTools("Text");
  fireEvent.click(screen.getByRole("button", { name: "Apply text color #0f766e" }));
  expect(screen.getByText(/Text color applied/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Insert content" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Chart" }));
  expect(documentBody().innerHTML).toContain("document-chart-block");

  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: {
      value: "Add a picture of Star Wars merchandising.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

  await waitFor(() => {
    expect(documentBody().innerHTML).toContain("document-media-block");
    expect(screen.getByText(/Found and inserted a web image/)).toBeInTheDocument();
  });
  expect(documentBody().innerHTML).toContain("https://example.com/star-wars.jpg");

  vi.unstubAllGlobals();
});

test("adds citations and applies inline AI edits only to highlighted text", async () => {
  const chatRequests = installChatCompletionFetchMock((payload) => {
    const prompt = ((payload.messages as Array<{ content: string }>)[0]?.content ?? "");
    if (prompt.includes("Highlighted passage:")) {
      return "The July 12, 2026 discovery deadline remains confirmed for client review.";
    }
    return clientUpdateProviderDraft();
  });
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  expect(screen.getByRole("button", { name: "Undo document edit" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Redo document edit" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  fireEvent.click(screen.getByRole("button", { name: /Create Client Update draft/ }));
  await waitFor(() => {
    expect(documentText()).toContain("The discovery deadline remains July 12, 2026.");
  });
  fireEvent.click(screen.getByRole("button", { name: "Insert content" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add citation" }));

  expect(documentBody().innerHTML).toContain("document-citation");
  expect(screen.getByText(/Citation 1 inserted/)).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Citation workspace" })).toBeInTheDocument();

  const inlineToolbarButton = screen.getByRole("button", { name: "Inline AI edit" });
  expect(fireEvent.mouseDown(inlineToolbarButton)).toBe(false);
  fireEvent.click(inlineToolbarButton);
  // With nothing highlighted, AI writes new text at the cursor instead.
  expect(screen.getByRole("dialog", { name: "Write with AI" })).toHaveTextContent(
    "New text at the cursor",
  );
  expect(screen.getByRole("option", { name: "Continue writing" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close Write with AI" }));
  expect(screen.queryByRole("dialog", { name: "Write with AI" })).not.toBeInTheDocument();

  const selectedText = "The discovery deadline remains July 12, 2026.";
  selectEditorText(selectedText);
  fireEvent.mouseUp(documentBody());
  const contextualAiButton = await screen.findByRole("button", {
    name: "Ask AI to edit highlighted text",
  });
  fireEvent.click(contextualAiButton);
  expect(screen.getByRole("dialog", { name: "Edit with AI" })).toHaveTextContent(
    selectedText,
  );
  // A preset runs immediately; the reply is reviewed before it touches the page.
  fireEvent.click(screen.getByRole("option", { name: "Improve writing" }));
  const accept = await screen.findByRole("button", { name: "Accept AI suggestion" });
  expect(documentText()).toContain(selectedText);
  expect(screen.getByLabelText("AI suggestion")).toHaveTextContent("confirmed for client review");
  fireEvent.click(accept);

  await waitFor(() => {
    expect(documentText()).toContain(
      "The July 12, 2026 discovery deadline remains confirmed for client review.",
    );
  });
  expect(chatRequests).toHaveLength(2);
  const inlinePayload = chatRequests[1] as {
    model: string;
    surface: string;
    max_completion_tokens: number;
    messages: Array<{ content: string }>;
  };
  expect(inlinePayload.model).toBe("agent-client-update");
  expect(inlinePayload.surface).toBe("draft");
  expect(inlinePayload.max_completion_tokens).toBe(2000);
  expect(inlinePayload.messages[0].content).toContain("Return only the replacement text");
  expect(inlinePayload.messages[0].content).toContain(selectedText);
  // The API reads the text between these headings as the instruction when it
  // decides whether an edit needs live web research, so the surrounding
  // document context must stay outside them.
  const instructionSection = /\nUser instruction:\s*\n([\s\S]*?)\n\s*\nHighlighted passage:\s*\n/.exec(
    inlinePayload.messages[0].content,
  );
  expect(instructionSection?.[1].trim()).toMatch(/^Improve the writing/);
  expect(instructionSection?.[1]).not.toMatch(/Text just (before|after) the highlight|Highlighted passage \(HTML\)/);
  expect(inlinePayload.messages[0].content).toMatch(/Text just (before|after) the highlight/);
  expect(documentBody().innerHTML).toContain("document-ai-suggestion");
  expect(documentText()).not.toContain(`Client-ready: ${selectedText}`);
  expect(screen.getByText(/Inline AI edit applied through/)).toBeInTheDocument();
  expect(screen.getByText(/unsaved edits/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Undo document edit" }));
  expect(documentText()).toContain(selectedText);
  expect(documentText()).not.toContain("discovery deadline remains confirmed");

  fireEvent.click(screen.getByRole("button", { name: "Redo document edit" }));
  expect(documentText()).toContain("discovery deadline remains confirmed");
});

test("keeps provider HTML formatting in the inline replacement", async () => {
  const chatRequests = installChatCompletionFetchMock(
    "<p>Replacement: The spaceship crossed <strong>deep space</strong> on its new course.</p>",
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "inline-html-transfer",
        title: "Spaceship Note",
        sourceLabel: "transferred chat",
        createdAt: "9:32 PM",
        content: "# Spaceship Note\n\nThe ship crossed the stars.\n\nKeep this second paragraph unchanged.",
      }}
    />,
  );

  const selectedText = "The ship crossed the stars.";
  selectEditorText(selectedText);
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  await applyInlineAiInstruction("Expand on the spaceship's journey.");

  await waitFor(() => {
    expect(documentText()).toContain(
      "The spaceship crossed deep space on its new course.",
    );
  });
  expect(chatRequests).toHaveLength(1);
  expect(documentText()).not.toContain("<p>");
  expect(documentText()).not.toContain("<strong>");
  expect(documentText()).not.toContain("Replacement:");
  expect(documentText()).toContain("Keep this second paragraph unchanged.");
  // The bold run the model asked for survives as real markup, and the single
  // paragraph it wrapped the sentence in does not split the paragraph it
  // replaced.
  const suggestion = documentBody().querySelector("span.document-ai-suggestion");
  expect(suggestion?.querySelector("strong")?.textContent).toBe("deep space");
  expect(suggestion?.closest("p")).not.toBeNull();
  expect(documentBody().querySelectorAll("p.document-ai-suggestion")).toHaveLength(0);
});

test("inline AI edit adds list items as real bullets instead of markdown text", async () => {
  installChatCompletionFetchMock((payload) => {
    const prompt = (payload.messages as Array<{ content: string }>)[0]?.content ?? "";
    if (prompt.includes("Highlighted passage:")) {
      return [
        "- 2017 Mirrored Revocable Trusts (Kansas law)",
        "- 2019 Pour-Over Wills naming the trusts as beneficiary",
      ].join("\n");
    }
    return "";
  });
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="S.F. Steward"
      initialDraft={{
        id: "inline-list-transfer",
        title: "Estate Plan Summary",
        sourceLabel: "transferred chat",
        createdAt: "9:45 PM",
        content: "# Estate Plan Summary\n\n- Existing durable powers of attorney\n- Existing healthcare directives\n\nKeep this closing paragraph unchanged.",
      }}
    />,
  );

  const selectedText = "Existing durable powers of attorney";
  await waitFor(() => {
    expect(documentText()).toContain(selectedText);
  });
  selectEditorText(selectedText);
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  await applyInlineAiInstruction("Add the other estate documents as bullets.");

  await waitFor(() => {
    expect(documentText()).toContain("2017 Mirrored Revocable Trusts (Kansas law)");
  });
  const suggestedItems = Array.from(
    documentBody().querySelectorAll("li.document-ai-suggestion"),
  );
  expect(suggestedItems).toHaveLength(2);
  suggestedItems.forEach((item) => {
    expect(item.parentElement?.tagName).toBe("UL");
  });
  // The literal markdown dash must not survive anywhere in the page, and the
  // suggestion must not be a span stranded inside the list.
  expect(documentText()).not.toContain("- 2017 Mirrored Revocable Trusts");
  expect(documentBody().querySelector("ul > span")).toBeNull();
  expect(documentText()).toContain("Existing healthcare directives");
  expect(documentText()).toContain("Keep this closing paragraph unchanged.");
});

test("inline AI edit keeps plain-paragraph replies inside the list they edit", async () => {
  // What the live model actually returns when asked to extend a bullet: plain
  // lines, no <li> markup. Inside a list those are bullets, not a list break.
  installChatCompletionFetchMock((payload) => {
    const prompt = (payload.messages as Array<{ content: string }>)[0]?.content ?? "";
    if (prompt.includes("Highlighted passage:")) {
      return [
        "Existing durable powers of attorney",
        "Revocable living trust agreement and any amendments",
        "Pour-over will",
      ].join("\n\n");
    }
    return "";
  });
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="S.F. Steward"
      initialDraft={{
        id: "inline-paragraph-list-transfer",
        title: "Estate Plan Summary",
        sourceLabel: "transferred chat",
        createdAt: "9:47 PM",
        content: "# Estate Plan Summary\n\n- Existing durable powers of attorney\n- Existing healthcare directives\n",
      }}
    />,
  );

  selectEditorText("Existing durable powers of attorney");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  await applyInlineAiInstruction("Add the trust and pour-over will bullets.");

  await waitFor(() => {
    expect(documentText()).toContain("Pour-over will");
  });
  const lists = documentBody().querySelectorAll("ul");
  expect(lists).toHaveLength(1);
  expect(documentBody().querySelectorAll("li.document-ai-suggestion")).toHaveLength(3);
  expect(documentBody().querySelectorAll("p.document-ai-suggestion")).toHaveLength(0);
  expect(Array.from(lists[0].children).map((item) => item.textContent)).toEqual([
    "Existing durable powers of attorney",
    "Revocable living trust agreement and any amendments",
    "Pour-over will",
    "Existing healthcare directives",
  ]);
});

test("inline AI edit splits a paragraph for a structural signature block", async () => {
  installChatCompletionFetchMock((payload) => {
    const prompt = (payload.messages as Array<{ content: string }>)[0]?.content ?? "";
    if (prompt.includes("Highlighted passage:")) {
      return [
        "<p><strong>IN WITNESS WHEREOF</strong>, the parties sign below.</p>",
        "<p>Name: ______________________<br>Date: ______________________</p>",
      ].join("");
    }
    return "";
  });
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="S.F. Steward"
      initialDraft={{
        id: "inline-signature-transfer",
        title: "Engagement Letter",
        sourceLabel: "transferred chat",
        createdAt: "9:50 PM",
        content: "# Engagement Letter\n\nSigned by the client.\n\nKeep this closing paragraph unchanged.",
      }}
    />,
  );

  selectEditorText("Signed by the client.");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  await applyInlineAiInstruction("Make this a realistic signature block.");

  await waitFor(() => {
    expect(documentText()).toContain("IN WITNESS WHEREOF");
  });
  const suggested = Array.from(documentBody().querySelectorAll("p.document-ai-suggestion"));
  expect(suggested).toHaveLength(2);
  expect(suggested[0].querySelector("strong")?.textContent).toBe("IN WITNESS WHEREOF");
  expect(suggested[1].querySelector("br")).not.toBeNull();
  // The model's underscore runs become real ruled lines: one element per
  // blank, carrying non-breaking spaces instead of underscore characters.
  const rules = Array.from(suggested[1].querySelectorAll("span.document-signature-line"));
  expect(rules).toHaveLength(2);
  rules.forEach((rule) => {
    expect(rule.textContent).toMatch(/^\u00a0+$/);
  });
  expect(documentText()).toContain("Name:");
  expect(documentText()).toContain("Date:");
  expect(documentBody().innerHTML).not.toContain("____");
  expect(documentText()).not.toContain("Signed by the client.");
  expect(documentText()).toContain("Keep this closing paragraph unchanged.");
});

test("a generated draft's fill-in blanks arrive as ruled lines, not underscores", async () => {
  installChatCompletionFetchMock(
    [
      "# Engagement Letter",
      "Signature: ______________________",
      "Printed Name: ______________________",
      "Client reference: file_2026 stays plain text.",
    ].join("\n\n"),
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="S.F. Steward"
      initialDraft={{
        id: "generated-signature-transfer",
        title: "Engagement Letter",
        sourceLabel: "transferred chat",
        createdAt: "10:02 PM",
        content: [
          "# Engagement Letter",
          "Signature: ______________________",
          "Printed Name: ______________________",
          "Client reference: file_2026 stays plain text.",
        ].join("\n\n"),
      }}
    />,
  );

  await waitFor(() => {
    expect(documentText()).toContain("Printed Name:");
  });
  expect(documentBody().querySelectorAll("span.document-signature-line")).toHaveLength(2);
  expect(documentBody().innerHTML).not.toContain("____");
  // Single underscores inside ordinary words are left alone.
  expect(documentText()).toContain("file_2026");
});

test("inline AI edit rules a signature label the model left dangling", async () => {
  // What Gemini 3.6 Flash actually returns once told not to use underscores:
  // the labels, and no blank at all.
  installChatCompletionFetchMock((payload) => {
    const prompt = (payload.messages as Array<{ content: string }>)[0]?.content ?? "";
    if (prompt.includes("Highlighted passage:")) {
      return "Signature: \n\nPrinted Name: \n\nDate:";
    }
    return "";
  });
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="S.F. Steward"
      initialDraft={{
        id: "inline-dangling-label-transfer",
        title: "Engagement Letter",
        sourceLabel: "transferred chat",
        createdAt: "10:10 PM",
        content: "# Engagement Letter\n\nSigned by the client.\n\nContact: Jane Doe",
      }}
    />,
  );

  selectEditorText("Signed by the client.");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  await applyInlineAiInstruction("Make this a realistic signature block.");

  await waitFor(() => {
    expect(documentText()).toContain("Printed Name:");
  });
  const rules = documentBody().querySelectorAll("span.document-signature-line");
  expect(rules).toHaveLength(3);
  rules.forEach((rule) => {
    expect(rule.previousSibling?.textContent).toMatch(/(Signature|Printed Name|Date):\s*$/);
  });
  // A field that already has a value is not a blank.
  expect(documentBody().innerHTML).toContain("Contact: Jane Doe");
  expect(documentBody().querySelector("p:last-child span.document-signature-line")).toBeNull();
});

test("a fresh AI edit glows for ten seconds, then settles into the page", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    installChatCompletionFetchMock("The revised sentence reads clearly.");
    render(
      <DocumentAssistantWorkspace
        data={sampleData}
        brandName="S.F. Steward"
        initialDraft={{
          id: "ai-glow-transfer",
          title: "Client Note",
          sourceLabel: "transferred chat",
          createdAt: "10:20 PM",
          content: "# Client Note\n\nThe original sentence is muddy.",
        }}
      />,
    );

    selectEditorText("The original sentence is muddy.");
    fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
    await applyInlineAiInstruction("Make it clearer.");

    await waitFor(() => {
      expect(documentText()).toContain("The revised sentence reads clearly.");
    });
    expect(documentBody()).toHaveClass("has-fresh-ai-edits");

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(documentBody()).not.toHaveClass("has-fresh-ai-edits");
    // The edit itself is still recorded — only the glow went away.
    expect(documentBody().querySelector("[data-ai-edit-at]")).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("the AI edit trail lists recorded edits, re-lights them, and clears the marks", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  installChatCompletionFetchMock("The revised sentence reads clearly.");
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="S.F. Steward"
      initialDraft={{
        id: "ai-trail-transfer",
        title: "Client Note",
        sourceLabel: "transferred chat",
        createdAt: "10:25 PM",
        content: "# Client Note\n\nThe original sentence is muddy.",
      }}
    />,
  );

  // Nothing recorded yet, so the tool is honestly unavailable.
  openDocumentTools("More");
  expect(screen.getByRole("button", { name: "AI edit trail" })).toBeDisabled();

  selectEditorText("The original sentence is muddy.");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  await applyInlineAiInstruction("Make it clearer.");

  await waitFor(() => {
    expect(documentText()).toContain("The revised sentence reads clearly.");
  });

  openDocumentTools("More");
  const trailToggle = screen.getByRole("button", { name: "AI edit trail" });
  expect(trailToggle).toBeEnabled();
  fireEvent.click(trailToggle);

  const trail = screen.getByRole("dialog", { name: "AI edit trail" });
  expect(documentBody()).toHaveClass("show-ai-edits");
  const entries = within(trail).getAllByRole("button", { name: /revised sentence/ });
  expect(entries).toHaveLength(1);
  // The entry reports which model actually made the edit.
  expect(trail).toHaveTextContent("Client Update Agent");

  fireEvent.click(entries[0]);
  expect(scrollIntoView).toHaveBeenCalled();

  fireEvent.click(within(trail).getByRole("button", { name: "Clear marks" }));
  await waitFor(() => {
    expect(screen.getByText(/AI edit mark.* cleared/)).toBeInTheDocument();
  });
  expect(documentBody().innerHTML).not.toContain("data-ai-edit-at");
  expect(documentBody().innerHTML).not.toContain("document-ai-suggestion");
  // The edited text stays exactly as it was.
  expect(documentText()).toContain("The revised sentence reads clearly.");
  openDocumentTools("More");
  expect(screen.getByRole("button", { name: "AI edit trail" })).toBeDisabled();
});

test("inline AI edit prompt describes where the highlight sits", async () => {
  const chatRequests = installChatCompletionFetchMock("Refreshed bullet text.");
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="S.F. Steward"
      initialDraft={{
        id: "inline-context-transfer",
        title: "Estate Plan Summary",
        sourceLabel: "transferred chat",
        createdAt: "9:55 PM",
        content: "# Estate Plan Summary\n\n- Existing durable powers of attorney\n",
      }}
    />,
  );

  selectEditorText("Existing durable powers of attorney");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  await applyInlineAiInstruction("Tighten this bullet.");

  await waitFor(() => {
    expect(documentText()).toContain("Refreshed bullet text.");
  });
  const prompt = (
    (chatRequests[0] as { messages: Array<{ content: string }> }).messages[0]?.content ?? ""
  );
  expect(prompt).toContain("Never write markdown syntax");
  expect(prompt).toContain("bulleted list (<ul> > <li>)");
});

test("shows the document editing glow only while inline AI is working", async () => {
  const deferredInlineEdit = installDeferredChatCompletionFetchMock(
    "The spacecraft crossed deep space on a carefully plotted lunar trajectory.",
  );
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "inline-glow-transfer",
        title: "Spacecraft Note",
        sourceLabel: "transferred chat",
        createdAt: "9:40 PM",
        content: "# Spacecraft Note\n\nThe ship crossed the stars.",
      }}
    />,
  );

  selectEditorText("The ship crossed the stars.");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  submitInlineAiInstruction("Expand on the spacecraft's journey.");

  expect(documentBody()).toHaveClass("is-ai-editing");
  expect(documentBody()).toHaveAttribute("aria-busy", "true");
  expect(deferredInlineEdit.requests).toHaveLength(1);

  deferredInlineEdit.resolve();

  // Review is not editing: the glow stops once the reply is ready to review.
  fireEvent.click(await screen.findByRole("button", { name: "Accept AI suggestion" }));
  await waitFor(() => {
    expect(documentText()).toContain("carefully plotted lunar trajectory");
  });
  expect(documentBody()).not.toHaveClass("is-ai-editing");
  expect(documentBody()).toHaveAttribute("aria-busy", "false");
});

test("AI edit review refines a suggestion as a follow-up turn and discard keeps the text", async () => {
  const chatRequests = installChatCompletionFetchMock((payload) => {
    const messages = payload.messages as Array<{ role: string; content: string }>;
    return messages.length === 1 ? "A first, longer rewrite of the sentence." : "A tighter rewrite.";
  });
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "inline-refine-transfer",
        title: "Board Note",
        sourceLabel: "transferred chat",
        createdAt: "9:10 AM",
        content: "# Board Note\n\nThe original sentence stays unless accepted.\n\nA second paragraph gives context.",
      }}
    />,
  );

  selectEditorText("The original sentence stays unless accepted.");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  submitInlineAiInstruction("Rewrite this.");
  await screen.findByRole("button", { name: "Accept AI suggestion" });
  expect(screen.getByLabelText("AI suggestion")).toHaveTextContent("A first, longer rewrite");
  // The model sees the neighbouring text so the rewrite fits where it lands.
  const firstPrompt = (chatRequests[0] as { messages: Array<{ content: string }> }).messages[0].content;
  expect(firstPrompt).toContain("Text just after the highlight");
  expect(firstPrompt).toContain("A second paragraph gives context.");

  fireEvent.change(screen.getByRole("textbox", { name: "Refine the AI suggestion" }), {
    target: { value: "Make it shorter" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refine suggestion" }));
  await waitFor(() => {
    expect(screen.getByLabelText("AI suggestion")).toHaveTextContent("A tighter rewrite.");
  });
  const refinePayload = chatRequests[1] as { messages: Array<{ role: string; content: string }> };
  expect(refinePayload.messages).toHaveLength(3);
  expect(refinePayload.messages[1]).toEqual({
    role: "assistant",
    content: "A first, longer rewrite of the sentence.",
  });
  expect(refinePayload.messages[2].content).toContain("Make it shorter");

  fireEvent.click(screen.getByRole("button", { name: "Discard AI suggestion" }));
  expect(screen.queryByRole("dialog", { name: "Edit with AI" })).not.toBeInTheDocument();
  expect(documentText()).toContain("The original sentence stays unless accepted.");
  expect(documentText()).not.toContain("tighter rewrite");
  expect(documentBody().innerHTML).not.toContain("document-ai-suggestion");
});

test("⌘J writes new text at the cursor and inserts it only after review", async () => {
  const chatRequests = installChatCompletionFetchMock("<p>Next steps follow in the appendix.</p>");
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "inline-write-transfer",
        title: "Launch Plan",
        sourceLabel: "transferred chat",
        createdAt: "9:20 AM",
        content: "# Launch Plan\n\nThe launch moves to March.",
      }}
    />,
  );

  const textNode = documentBody().querySelector("p")?.firstChild as Text;
  const caret = document.createRange();
  caret.setStart(textNode, textNode.data.length);
  caret.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  fireEvent.keyDown(documentBody(), { key: "j", metaKey: true });

  const dialog = screen.getByRole("dialog", { name: "Write with AI" });
  fireEvent.click(within(dialog).getByRole("option", { name: "Continue writing" }));
  const accept = await screen.findByRole("button", { name: "Accept AI suggestion" });
  expect(documentText()).not.toContain("Next steps follow");
  const prompt = (chatRequests[0] as { messages: Array<{ content: string }> }).messages[0].content;
  expect(prompt).toContain("Write only the new content to insert at the cursor");
  expect(prompt).toContain("The launch moves to March.");

  fireEvent.click(accept);
  await waitFor(() => {
    expect(documentText()).toContain("Next steps follow in the appendix.");
  });
  expect(documentText()).toContain("The launch moves to March.");
  expect(documentBody().querySelector("[data-ai-edit-at]")).not.toBeNull();
});

test("Insert below keeps the highlight, and ⌘Z / ⌘⇧Z undo and redo the AI edit", async () => {
  installChatCompletionFetchMock("An added supporting sentence.");
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "inline-below-transfer",
        title: "Memo",
        sourceLabel: "transferred chat",
        createdAt: "9:30 AM",
        content: "# Memo\n\nKeep this original sentence.",
      }}
    />,
  );

  selectEditorText("Keep this original sentence.");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  submitInlineAiInstruction("Add a supporting sentence.");
  fireEvent.click(await screen.findByRole("button", { name: "Insert below" }));
  await waitFor(() => {
    expect(documentText()).toContain("An added supporting sentence.");
  });
  expect(documentText()).toContain("Keep this original sentence.");
  const paragraphs = Array.from(documentBody().querySelectorAll("p")).map((node) => node.textContent);
  expect(paragraphs.indexOf("An added supporting sentence.")).toBe(
    paragraphs.indexOf("Keep this original sentence.") + 1,
  );

  fireEvent.keyDown(documentBody(), { key: "z", metaKey: true });
  await waitFor(() => {
    expect(documentText()).not.toContain("An added supporting sentence.");
  });
  fireEvent.keyDown(documentBody(), { key: "z", metaKey: true, shiftKey: true });
  await waitFor(() => {
    expect(documentText()).toContain("An added supporting sentence.");
  });
});

test("typing / opens the block menu, filters it, and inserts a table in place of the command", () => {
  installChatCompletionFetchMock("unused");
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "slash-menu-transfer",
        title: "Ops Review",
        sourceLabel: "transferred chat",
        createdAt: "9:40 AM",
        content: "# Ops Review\n\nMetrics follow.\n\n/",
      }}
    />,
  );

  const slashNode = Array.from(documentBody().querySelectorAll("p")).find((node) => node.textContent === "/")!
    .firstChild as Text;
  const caret = document.createRange();
  caret.setStart(slashNode, 1);
  caret.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  fireEvent.input(documentBody(), { inputType: "insertText", data: "/" });

  const menu = screen.getByRole("listbox", { name: "Insert block" });
  expect(within(menu).getByRole("option", { name: /Continue writing/ })).toBeInTheDocument();
  expect(within(menu).getByRole("option", { name: /Heading/ })).toBeInTheDocument();

  slashNode.data = "/tab";
  caret.setStart(slashNode, 4);
  caret.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  fireEvent.input(documentBody(), { inputType: "insertText", data: "b" });
  const filtered = screen.getByRole("listbox", { name: "Insert block" });
  expect(within(filtered).getAllByRole("option").map((option) => option.textContent)).toEqual(["Table"]);

  fireEvent.keyDown(documentBody(), { key: "Enter" });
  expect(screen.queryByRole("listbox", { name: "Insert block" })).not.toBeInTheDocument();
  expect(documentBody().querySelector("table.document-data-table thead th")).not.toBeNull();
  expect(documentBody().querySelectorAll("table tr")).toHaveLength(3);
  expect(documentText()).not.toContain("/tab");
  expect(documentText()).toContain("Metrics follow.");
});

test("paste keeps structure but drops the source page's fonts and colors", () => {
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "paste-cleanup-transfer",
        title: "Notes",
        sourceLabel: "transferred chat",
        createdAt: "9:50 AM",
        content: "# Notes\n\nPaste after this.",
      }}
    />,
  );
  const textNode = documentBody().querySelector("p")!.firstChild as Text;
  const caret = document.createRange();
  caret.setStart(textNode, textNode.data.length);
  caret.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  const html =
    '<span style="font-family:Comic Sans MS;font-size:30px;color:#ff0000;font-weight:700"> Pasted bold</span>';
  fireEvent.paste(documentBody(), {
    clipboardData: {
      getData: (type: string) => (type === "text/html" ? html : type === "text/plain" ? " Pasted bold" : ""),
      files: [],
    },
  });
  expect(documentBody().innerHTML).toContain("<strong> Pasted bold</strong>");
  expect(documentBody().innerHTML).not.toMatch(/Comic Sans|30px|#ff0000/);
  expect(screen.getByText("Pasted using the document's formatting.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo document edit" }));
  expect(documentText()).not.toContain("Pasted bold");
});

test("find highlights every match, steps through them, and replace all is one undo step", () => {
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "find-replace-transfer",
        title: "Review",
        sourceLabel: "transferred chat",
        createdAt: "10:00 AM",
        content: "# Review\n\nRevenue grew. Revenue per **customer** rose.\n\nCustomer revenue held.",
      }}
    />,
  );

  fireEvent.keyDown(documentBody(), { key: "f", metaKey: true });
  const findBox = screen.getByRole("textbox", { name: "Find in document" });
  fireEvent.change(findBox, { target: { value: "revenue" } });
  expect(screen.getByText("1 of 3")).toBeInTheDocument();
  fireEvent.keyDown(findBox, { key: "Enter" });
  expect(screen.getByText("2 of 3")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Match case" }));
  // Only the lowercase occurrence matches exactly.
  expect(screen.getByText("1 of 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Match case" }));

  fireEvent.click(screen.getByRole("button", { name: "Show replace" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), { target: { value: "sales" } });
  fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
  expect(documentText()).not.toMatch(/revenue/i);
  expect(documentText()).toContain("sales per customer rose.");
  expect(documentBody().querySelector("strong")?.textContent).toBe("customer");
  expect(screen.getByText("No results")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Undo document edit" }));
  expect(documentText()).toContain("Revenue grew. Revenue per customer rose.");
});

test("the status bar counts words, opens the outline, and zooms the page", () => {
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "status-outline-transfer",
        title: "Plan",
        sourceLabel: "transferred chat",
        createdAt: "10:05 AM",
        content: "# Plan\n\n## Goals\n\nShip the release.\n\n## Risks\n\nTimeline pressure.",
      }}
    />,
  );
  const status = screen.getByRole("contentinfo", { name: "Document status" });
  expect(status).toHaveTextContent("Page 1 of 1");
  expect(status).toHaveTextContent(/\d+ words/);

  fireEvent.click(within(status).getByRole("button", { name: "Document outline" }));
  const outline = screen.getByRole("navigation", { name: "Document outline" });
  expect(within(outline).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "",
    "Plan",
    "Goals",
    "Risks",
  ]);
  fireEvent.click(within(outline).getByRole("button", { name: "Risks" }));
  expect(window.getSelection()?.anchorNode?.textContent).toBe("Risks");

  fireEvent.click(within(status).getByRole("button", { name: "Zoom in" }));
  expect(within(status).getByRole("button", { name: /Zoom 110 percent/ })).toBeInTheDocument();
  expect(documentBody().style.zoom).toBe("1.1");
  fireEvent.click(within(status).getByRole("button", { name: /Zoom 110 percent/ }));
  expect(documentBody().style.zoom).toBe("");
});

test("Insert → Table adds a blank table and the table tools add and remove rows and columns", async () => {
  render(
    <DocumentAssistantWorkspace
      data={sampleData}
      brandName="Aperture Chat"
      initialDraft={{
        id: "table-tools-transfer",
        title: "Tracker",
        sourceLabel: "transferred chat",
        createdAt: "10:10 AM",
        content: "# Tracker\n\nTable below.",
      }}
    />,
  );
  const paragraph = documentBody().querySelector("p")!;
  const caret = document.createRange();
  caret.selectNodeContents(paragraph);
  caret.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  fireEvent.click(screen.getByRole("button", { name: "Insert content" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Table/ }));
  const table = documentBody().querySelector("table")!;
  expect(table.querySelectorAll("tr")).toHaveLength(3);
  expect(table.querySelectorAll("th")).toHaveLength(3);
  expect(table.textContent).toBe("");

  document.dispatchEvent(new Event("selectionchange"));
  const tools = await screen.findByRole("toolbar", { name: "Table tools" });
  fireEvent.click(within(tools).getByRole("button", { name: "Insert row below" }));
  expect(documentBody().querySelectorAll("table tr")).toHaveLength(4);
  fireEvent.click(within(tools).getByRole("button", { name: "Insert column right" }));
  expect(documentBody().querySelector("table tr")!.children).toHaveLength(4);
  fireEvent.click(within(tools).getByRole("button", { name: "Delete column" }));
  expect(documentBody().querySelector("table tr")!.children).toHaveLength(3);
  fireEvent.click(within(tools).getByRole("button", { name: "Delete table" }));
  expect(documentBody().querySelector("table")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo document edit" }));
  expect(documentBody().querySelector("table")).not.toBeNull();
});

test("clicking a picture opens picture tools for size, alignment, alt text and delete", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  documentBody().innerHTML =
    '<p>Before the picture.</p><figure class="document-media-block" contenteditable="false"><img src="https://example.com/chart.png" alt="Old alt"></figure><p>After.</p>';
  fireEvent.input(documentBody());
  const image = documentBody().querySelector("img")!;
  fireEvent.mouseDown(image);
  const tools = screen.getByRole("toolbar", { name: "Picture tools" });
  expect(within(tools).getByRole("button", { name: "Full width" })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(within(tools).getByRole("button", { name: "Half" }));
  expect(documentBody().querySelector("figure")).toHaveClass("document-media-size-md");
  fireEvent.click(within(tools).getByRole("button", { name: "Align picture right" }));
  expect(documentBody().querySelector("figure")).toHaveClass("document-media-align-right");
  const alt = within(tools).getByRole("textbox", { name: "Alt text" });
  fireEvent.change(alt, { target: { value: "Quarterly revenue chart" } });
  fireEvent.keyDown(alt, { key: "Enter" });
  expect(documentBody().querySelector("img")).toHaveAttribute("alt", "Quarterly revenue chart");

  fireEvent.click(within(tools).getByRole("button", { name: "Delete picture" }));
  expect(documentBody().querySelector("figure")).toBeNull();
  expect(screen.queryByRole("toolbar", { name: "Picture tools" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo document edit" }));
  expect(documentBody().querySelector("figure")).toHaveClass("document-media-size-md", "document-media-align-right");
});

test("exposes chat connector sources from the draft attach menu", () => {
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Attach file" }));

  expect(screen.getByRole("menu", { name: "Add draft attachment" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /Upload from computer/ })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /Google Drive/ })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /OneDrive/ })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /SharePoint/ })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /Box/ })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /iManage/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("menuitem", { name: /Box/ }));

  expectRailNotice(/Box source added to this draft context/);
  expect(screen.getByLabelText("Workspace sources for this draft")).toBeInTheDocument();
  expect(screen.getByLabelText(/Box Matter Knowledge/)).toBeChecked();
});

test("uploaded draft sources reach the model and strict citations tighten the request", async () => {
  const chatRequests = installChatCompletionFetchMock("# Brief\n\nA synthetic brief.");
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

  fireEvent.change(screen.getByLabelText("Attach draft source files"), {
    target: {
      files: [
        new File(["Synthetic notes"], "notes.txt", { type: "text/plain" }),
        new File(["%PDF"], "scan.pdf", { type: "application/pdf" }),
      ],
    },
  });
  const chips = screen.getByRole("list", { name: "Attached draft sources" });
  expect(within(chips).getAllByRole("listitem")).toHaveLength(2);
  // Sending waits for uploads so no request goes out without its sources.
  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Write a one-page brief from my notes." },
  });
  expect(screen.getByRole("button", { name: "Apply instruction" })).toBeDisabled();
  await waitFor(() => expect(within(chips).getByText("notes.txt").closest("li")).toHaveClass("is-ready"));
  await waitFor(() => expect(within(chips).getByText("scan.pdf").closest("li")).toHaveClass("is-name-only"));

  fireEvent.click(screen.getByRole("button", { name: "Assistant settings" }));
  fireEvent.click(screen.getByLabelText("Require source citations"));
  expect(screen.getByRole("button", { name: "Strict citations settings" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));
  await waitFor(() => expect(chatRequests).toHaveLength(1));
  const payload = chatRequests[0] as { attachment_ids: string[]; attachment_names: string[]; messages: Array<{ content: string }> };
  expect(payload.attachment_ids).toEqual(["upload-notes.txt", "upload-scan.pdf"]);
  expect(payload.attachment_names).toEqual(["notes.txt", "scan.pdf"]);
  expect(payload.messages[0].content).toContain("Citation requirement:");

  // Removing a chip removes it from the next request.
  fireEvent.click(within(chips).getByRole("button", { name: "Remove scan.pdf" }));
  expect(within(chips).queryByText("scan.pdf")).not.toBeInTheDocument();
});

test("a failed upload is shown on its chip and never sent", async () => {
  const chatRequests = installChatCompletionFetchMock("# Draft\n\nSynthetic.", {
    uploadError: "Attachment exceeds the 25 MB chat upload limit.",
  });
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  fireEvent.change(screen.getByLabelText("Attach draft source files"), {
    target: { files: [new File(["x"], "huge.txt", { type: "text/plain" })] },
  });
  const chips = screen.getByRole("list", { name: "Attached draft sources" });
  await waitFor(() => expect(within(chips).getByText("huge.txt").closest("li")).toHaveClass("is-error"));
  expectRailNotice(/huge.txt could not be attached: Attachment exceeds the 25 MB/);
  fireEvent.change(screen.getByLabelText("Ask the document assistant"), {
    target: { value: "Write a short memo." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));
  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect((chatRequests[0] as { attachment_ids: string[] }).attachment_ids).toEqual([]);
});

test("empty draft chat offers starter requests that only fill the message box", () => {
  const chatRequests = installChatCompletionFetchMock("unused");
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  expect(screen.getByText("What should we write?")).toBeInTheDocument();
  const suggestions = within(screen.getByLabelText("Suggested requests")).getAllByRole("button");
  expect(suggestions).toHaveLength(3);
  fireEvent.click(suggestions[0]);
  expect(screen.getByLabelText("Ask the document assistant")).toHaveValue(suggestions[0].textContent);
  expect(chatRequests).toHaveLength(0);
});

test("Enter sends the draft instruction and Shift+Enter keeps a new line", async () => {
  const chatRequests = installChatCompletionFetchMock("# Memo\n\nSynthetic memo.");
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const prompt = screen.getByLabelText("Ask the document assistant");
  fireEvent.change(prompt, { target: { value: "Write a short memo." } });
  fireEvent.keyDown(prompt, { key: "Enter", shiftKey: true });
  expect(chatRequests).toHaveLength(0);
  fireEvent.keyDown(prompt, { key: "Enter" });
  await waitFor(() => expect(chatRequests).toHaveLength(1));
});

test("deck requests use the selected workspace sources", async () => {
  const chatRequests = installChatCompletionFetchMock("unused deck reply");
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  fireEvent.click(screen.getByRole("button", { name: "Deck", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Sources and files" }));
  fireEvent.click(screen.getByLabelText(/Litigation Playbook/));
  const prompt = screen.getByRole("textbox", { name: "Ask the deck assistant" });
  fireEvent.change(prompt, { target: { value: "Build a 3-slide briefing." } });
  fireEvent.submit(prompt.closest("form")!);
  await waitFor(() => expect(chatRequests.length).toBeGreaterThan(0));
  const ids = (chatRequests[0] as { knowledge_config_ids: string[] }).knowledge_config_ids;
  expect(ids.length).toBe(1);
});

test("connects local source files and drafting settings to the workspace state", () => {
  // Approve one non-reasoning and one reasoning-capable model so the
  // reasoning slider's disabled and enabled states are both exercised.
  const data = {
    ...sampleData,
    models: sampleData.models.map((model) =>
      model.id === "openrouter-openai-gpt-4o-mini" || model.id === "openrouter-openai-gpt-5-5"
        ? { ...model, group_ids: ["group-litigation"], tenant_restricted: true }
        : model,
    ),
  };
  render(
    <DocumentAssistantWorkspace data={data} brandName="Aperture Chat" />,
  );

  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();

  fireEvent.change(screen.getByLabelText("Attach draft source files"), {
    target: {
      files: [new File(["source"], "supplemental-log.txt", { type: "text/plain" })],
    },
  });

  expect(screen.getByRole("list", { name: "Attached draft sources" })).toHaveTextContent(
    "supplemental-log.txt",
  );
  expectRailNotice(/Attached 1 draft source/);
  fireEvent.click(screen.getByRole("button", { name: "Sources and files" }));

  expect(screen.getByLabelText(/Litigation Playbook/)).not.toBeChecked();
  fireEvent.click(screen.getByLabelText(/Litigation Playbook/));
  expect(screen.getByLabelText(/Litigation Playbook/)).toBeChecked();
  expectRailNotice(/included in this draft context/);

  fireEvent.click(screen.getByLabelText(/Litigation Playbook/));
  expect(screen.getByLabelText(/Litigation Playbook/)).not.toBeChecked();
  expectRailNotice(/removed from this draft context/);

  fireEvent.click(screen.getByRole("button", { name: "Assistant settings" }));
  const agentSelector = screen.getByLabelText("Drafting agent");
  expect(agentSelector).toHaveValue("agent-client-update");

  fireEvent.change(agentSelector, {
    target: { value: "openrouter-openai-gpt-4o-mini" },
  });
  expect(
    screen.getByText(/OpenRouter: openai\/gpt-4o-mini selected for drafting/),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Require source citations")).not.toBeChecked();

  // The Fast–Smart reasoning slider replaced the retired approval toggle.
  // It stays honestly disabled while a non-reasoning model is selected.
  expect(screen.getByLabelText("Model reasoning level")).toBeDisabled();

  fireEvent.change(agentSelector, {
    target: { value: "openrouter-openai-gpt-5-5" },
  });
  const reasoningSlider = screen.getByLabelText("Model reasoning level");
  expect(reasoningSlider).toBeEnabled();
  fireEvent.change(reasoningSlider, { target: { value: "2" } });
  expect(screen.getByLabelText("Model reasoning level")).toHaveValue("2");
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Server-first draft persistence
// ---------------------------------------------------------------------------

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function offlineResponse() {
  return jsonResponse({ error: "offline" }, 503);
}

function serverDraftSnapshot(id: string, title: string, content: string, revision: number) {
  const now = "2026-07-20T12:00:00Z";
  return {
    document: {
      id,
      tenant_id: "tenant-example",
      owner_user_id: "user-admin",
      matter_id: null,
      title,
      current_revision: revision,
      created_at: now,
      updated_at: now,
    },
    revision: {
      draft_id: id,
      tenant_id: "tenant-example",
      owner_user_id: "user-admin",
      revision,
      title,
      content,
      content_sha256: "0".repeat(64),
      sanitizer_version: "sanitized-html-v1",
      created_at: now,
    },
  };
}

type DraftsApiCall = {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
};

function installDraftsApiFetchMock(handlers: {
  list?: () => Response | Promise<Response>;
  create?: (body: Record<string, unknown>) => Response | Promise<Response>;
  update?: (draftId: string, body: Record<string, unknown>) => Response | Promise<Response>;
  get?: (draftId: string) => Response | Promise<Response>;
}) {
  const calls: DraftsApiCall[] = [];
  const fetchMock = globalThis.fetch as unknown as {
    mockImplementation: (implementation: typeof fetch) => void;
  };
  fetchMock.mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const draftsMatch = url.match(/\/api\/drafts(?:\/([^/?]+))?(?:\?.*)?$/);
    if (draftsMatch) {
      calls.push({ method, url, body });
      const draftId = draftsMatch[1] ? decodeURIComponent(draftsMatch[1]) : null;
      if (!draftId && method === "GET") return handlers.list?.() ?? jsonResponse([]);
      if (!draftId && method === "POST") {
        return handlers.create?.(body ?? {}) ?? offlineResponse();
      }
      if (draftId && method === "PUT") {
        return handlers.update?.(draftId, body ?? {}) ?? offlineResponse();
      }
      if (draftId && method === "GET") return handlers.get?.(draftId) ?? offlineResponse();
    }
    return offlineResponse();
  });
  return calls;
}

function serverSaveIndicator() {
  return screen.getByRole("status", { name: "Server save state" });
}

test("queued saves retain their document identity when another draft opens before the response", async () => {
  let resolveFirst!: (response: Response) => void;
  const firstSave = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const draftB = serverDraftSnapshot("draft-B", "Draft B", "<p>Original B.</p>", 1);
  let creates = 0;
  const calls = installDraftsApiFetchMock({
    list: () => jsonResponse([draftB.document]),
    get: () => jsonResponse(draftB),
    create: () => { creates += 1; return firstSave; },
    update: (id, body) => jsonResponse(serverDraftSnapshot(id, String(body.title), String(body.content), Number(body.expected_revision) + 1)),
  });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>First draft A.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(creates).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Draft B/ }));
  await waitFor(() => expect(documentText()).toContain("Original B."));
  documentBody().innerHTML = "<p>Updated B.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await act(async () => { resolveFirst(jsonResponse(serverDraftSnapshot("draft-A", "Untitled Draft", "<p>First draft A.</p>", 1), 201)); });
  await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1));
  expect(calls.find((call) => call.method === "PUT")).toMatchObject({
    url: expect.stringContaining("/api/drafts/draft-B"),
    body: { expected_revision: 1, content: "<p>Updated B.</p>" },
  });
  expect(documentText()).toContain("Updated B.");
  await waitFor(() => expect(storedDraftHistory().find((item) => item.serverId === "draft-A")?.content).toContain("First draft A."));
  expect(storedDraftHistory().find((item) => item.serverId === "draft-B")?.content).toContain("Updated B.");
});

test("an earlier save acknowledgement never replaces a newer queued local version", async () => {
  let resolveFirst!: (response: Response) => void;
  const firstSave = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const calls = installDraftsApiFetchMock({ create: () => firstSave, update: () => offlineResponse() });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>Earlier snapshot.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
  documentBody().innerHTML = "<p>Latest pending work.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await act(async () => { resolveFirst(jsonResponse(serverDraftSnapshot("queued-1", "Untitled Draft", "<p>Earlier snapshot.</p>", 1), 201)); });
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Local only"));
  expect(storedDraftHistory()).toHaveLength(1);
  expect(storedDraftHistory()[0]).toMatchObject({ serverId: "queued-1", serverRevision: 1, content: "<p>Latest pending work.</p>", serverSavePending: true });
  expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({ expected_revision: 1, content: "<p>Latest pending work.</p>" });
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  expect(draftHistoryPanel()).toHaveTextContent("Local changes");
});

test("a background save after unmount preserves drafts saved by the new workspace", async () => {
  let resolveFirst!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  let creates = 0;
  installDraftsApiFetchMock({ create: () => { creates += 1; return creates === 1 ? pending : offlineResponse(); } });
  const first = render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>Background first draft.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(creates).toBe(1));
  first.unmount();
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>New workspace draft.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Local only"));
  await act(async () => { resolveFirst(jsonResponse(serverDraftSnapshot("background-first", "Untitled Draft", "<p>Background first draft.</p>", 1), 201)); });
  await waitFor(() => expect(storedDraftHistory().some((item) => item.serverId === "background-first")).toBe(true));
  expect(storedDraftHistory()).toHaveLength(2);
  expect(storedDraftHistory().some((item) => item.content?.includes("New workspace draft."))).toBe(true);
});

test("reopening a draft during its first save joins the same queue across workspace mounts", async () => {
  let resolveFirst!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const calls = installDraftsApiFetchMock({ create: () => pending, update: () => offlineResponse() });
  const first = render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>Original pending body.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
  first.unmount();
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Untitled Draft/ }));
  documentBody().innerHTML = "<p>Newer reopened edits.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  await act(async () => { resolveFirst(jsonResponse(serverDraftSnapshot("same-pending", "Untitled Draft", "<p>Original pending body.</p>", 1), 201)); });
  await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({ expected_revision: 1, content: "<p>Newer reopened edits.</p>" });
  expect(storedDraftHistory()).toHaveLength(1);
  expect(storedDraftHistory()[0]).toMatchObject({ content: "<p>Newer reopened edits.</p>", serverSavePending: true });
});

test("a delayed acknowledgement preserves unsent edits written by another browser tab", async () => {
  let resolveSave!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolveSave = resolve; });
  const calls = installDraftsApiFetchMock({ create: () => pending });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>This tab's saved content.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
  const otherTabDraft = {
    ...storedDraftHistory()[0],
    content: "<p>Other tab's unsent content.</p>",
    serverSavePending: true,
    cacheWriterId: "different-browser-tab",
  };
  window.localStorage.setItem(SCOPED_DRAFT_CACHE_KEY, JSON.stringify([otherTabDraft]));
  await act(async () => { resolveSave(jsonResponse(serverDraftSnapshot("cross-tab-save", "Untitled Draft", "<p>This tab's saved content.</p>", 1), 201)); });
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Saved"));
  expect(storedDraftHistory()[0]).toMatchObject({ content: "<p>Other tab's unsent content.</p>", serverSavePending: true });
});

test("a rename-only edit can be saved and survives reopening without duplicate history entries", async () => {
  const calls = installDraftsApiFetchMock({
    create: (body) => jsonResponse(serverDraftSnapshot("rename-1", String(body.title), String(body.content), 1), 201),
    update: (id, body) => jsonResponse(serverDraftSnapshot(id, String(body.title), String(body.content), Number(body.expected_revision) + 1)),
  });
  const view = render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>Keep this body unchanged.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Saved"));
  fireEvent.change(screen.getByRole("textbox", { name: "Document title" }), { target: { value: "Renamed memo" } });
  expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
  await waitFor(() => expect(storedDraftHistory()[0]?.title).toBe("Renamed memo"));
  expect(storedDraftHistory()).toHaveLength(1);
  view.unmount();
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Renamed memo/ }));
  expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Renamed memo");
  expect(documentText()).toContain("Keep this body unchanged.");
});

test("independent same-title drafts retain both local copies", async () => {
  installDraftsApiFetchMock({});
  const first = render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>First unique memo.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Local only"));
  first.unmount();
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>Second unique memo.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Local only"));
  expect(storedDraftHistory()).toHaveLength(2);
  expect(new Set(storedDraftHistory().map((item) => item.id)).size).toBe(2);
  expect(storedDraftHistory().map((item) => item.content).join(" ")).toContain("First unique memo.");
  expect(storedDraftHistory().map((item) => item.content).join(" ")).toContain("Second unique memo.");
});

test("a same-title document and deck keep separate history copies", async () => {
  installDraftsApiFetchMock({});
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<h1>Original document</h1><p>Keep the document copy.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Local only"));
  switchToDeckMode();
  fireEvent.click(screen.getByRole("button", { name: "Convert into slides" }));
  const entries = storedDraftHistory();
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map((item) => item.id)).size).toBe(2);
  expect(entries.every((item) => item.title === "Untitled Draft")).toBe(true);
  expect(entries.some((item) => item.content?.startsWith("{"))).toBe(true);
  expect(entries.some((item) => item.content?.includes("<p>Keep the document copy.</p>"))).toBe(true);
});

test("storage and network failures report Not saved and retain content for retry", async () => {
  let online = false;
  installDraftsApiFetchMock({
    create: (body) => online
      ? jsonResponse(serverDraftSnapshot("retry-storage", String(body.title), String(body.content), 1), 201)
      : offlineResponse(),
  });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  const storageWrite = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
  try {
    documentBody().innerHTML = "<p>This is the only remaining copy.</p>";
    fireEvent.input(documentBody());
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Not saved"));
    expect(serverSaveIndicator()).toHaveTextContent("browser storage could not keep a copy");
    expect(serverSaveIndicator()).not.toHaveTextContent("kept on this device");
    expect(storedDraftHistory()).toHaveLength(0);
    expect(documentText()).toContain("This is the only remaining copy.");
    online = true;
    storageWrite.mockRestore();
    fireEvent.click(within(serverSaveIndicator()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Saved"));
    expect(storedDraftHistory()[0]?.content).toContain("This is the only remaining copy.");
  } finally {
    storageWrite.mockRestore();
  }
});

test("unsaved history navigation can be cancelled or preserve a recovery copy before restoring", async () => {
  const saved = serverDraftSnapshot("restore-target", "Saved target", "<p>Target body.</p>", 1);
  installDraftsApiFetchMock({ list: () => jsonResponse([saved.document]), get: () => jsonResponse(saved) });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>Unsaved work worth keeping.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Saved target/ }));
  const dialog = await screen.findByRole("dialog", { name: "Unsaved draft edits" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(documentText()).toContain("Unsaved work worth keeping.");
  expect(screen.queryByRole("dialog", { name: "Unsaved draft edits" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Restore Saved target/ }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Unsaved draft edits" })).getByRole("button", { name: "Save copy and continue" }));
  expect(documentText()).toContain("Target body.");
  expect(storedDraftHistory().find((item) => item.title?.includes("unsaved copy"))?.content).toContain("Unsaved work worth keeping.");
});

test("restoring a prior version requires explicit discard and Escape keeps the edits", async () => {
  installDraftsApiFetchMock({});
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>First saved version.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Local only"));
  documentBody().innerHTML = "<p>Unsaved replacement.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(screen.getByRole("button", { name: /Version 1/ }));
  expect(screen.getByRole("dialog", { name: "Unsaved draft edits" })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(documentText()).toContain("Unsaved replacement.");
  fireEvent.click(screen.getByRole("button", { name: /Version 1/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Unsaved draft edits" })).getByRole("button", { name: "Discard and continue" }));
  expect(documentText()).not.toContain("Unsaved replacement.");
  expect(screen.getByText(/Version 1 restored in the editor/)).toBeInTheDocument();
});

test("a failed recovery checkpoint keeps the current edits until explicit discard", async () => {
  installDraftsApiFetchMock({});
  render(<DocumentAssistantWorkspace data={sampleData} />);
  documentBody().innerHTML = "<p>Saved body.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Local only"));
  documentBody().innerHTML = "<p>Cannot lose this.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(screen.getByRole("button", { name: /Version 1/ }));
  const storageWrite = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  try {
    fireEvent.click(within(screen.getByRole("dialog", { name: "Unsaved draft edits" })).getByRole("button", { name: "Save copy and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Browser storage could not keep a recovery copy");
    expect(documentText()).toContain("Cannot lose this.");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Unsaved draft edits" })).getByRole("button", { name: "Keep editing" }));
    expect(documentText()).toContain("Cannot lose this.");
  } finally {
    storageWrite.mockRestore();
  }
});

test("a manual save persists to the server first and only then reports Saved", async () => {
  const calls = installDraftsApiFetchMock({
    create: (body) =>
      jsonResponse(
        serverDraftSnapshot("draft-srv-1", String(body.title), String(body.content), 1),
        201,
      ),
  });
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

  const editor = documentBody();
  editor.innerHTML = "<p>Server persisted note.</p>";
  fireEvent.input(editor);
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));

  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Saved"));
  const createCall = calls.find((call) => call.method === "POST");
  expect(createCall?.body).toMatchObject({
    title: "Untitled Draft",
    content: expect.stringContaining("Server persisted note."),
  });
  // The workspace never sends matter_id, so an existing server-side matter
  // assignment is always preserved (explicit null is the only way to clear).
  expect(createCall && createCall.body && "matter_id" in createCall.body).toBe(false);

  // The working cache lives under the tenant+user scoped key with the
  // server-assigned id, and the legacy unscoped key stays untouched.
  expect(storedDraftHistory()[0]).toMatchObject({ serverId: "draft-srv-1", serverRevision: 1 });
  expect(window.localStorage.getItem(LEGACY_DOCUMENT_HISTORY_STORAGE_KEY)).toBeNull();
});

test("a failed server save reports Local only, keeps the scoped cache, and can retry", async () => {
  let failCreates = true;
  installDraftsApiFetchMock({
    create: (body) =>
      failCreates
        ? offlineResponse()
        : jsonResponse(
            serverDraftSnapshot("draft-srv-2", String(body.title), String(body.content), 1),
            201,
          ),
  });
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

  const editor = documentBody();
  editor.innerHTML = "<p>Keep me local.</p>";
  fireEvent.input(editor);
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));

  await waitFor(() =>
    expect(serverSaveIndicator()).toHaveTextContent("Local only — server save failed"),
  );
  expect(serverSaveIndicator()).not.toHaveTextContent(/\bSaved\b/);
  // The local cache retains the content even though the server rejected it.
  expect(storedDraftHistory()[0]).toMatchObject({
    content: expect.stringContaining("Keep me local."),
  });
  expect(storedDraftHistory()[0].serverId ?? null).toBeNull();

  failCreates = false;
  fireEvent.click(within(serverSaveIndicator()).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Saved"));
  expect(storedDraftHistory()[0]).toMatchObject({ serverId: "draft-srv-2", serverRevision: 1 });
});

test("a concurrent server change surfaces as an explicit conflict, never a silent overwrite", async () => {
  window.localStorage.setItem(
    SCOPED_DRAFT_CACHE_KEY,
    JSON.stringify([
      {
        id: "server-draft-srv-9",
        title: "Bound Draft",
        summary: "Saved earlier",
        sourceLabel: "Account draft",
        content: "<p>Cached copy.</p>",
        updatedAt: "2026-07-19T10:00:00Z",
        status: "complete",
        serverId: "draft-srv-9",
        serverRevision: 3,
        serverContentStale: false,
      },
    ]),
  );
  const calls = installDraftsApiFetchMock({
    list: () =>
      jsonResponse([serverDraftSnapshot("draft-srv-9", "Bound Draft", "<p>Cached copy.</p>", 3).document]),
    update: () =>
      jsonResponse({ detail: "The draft changed before this update completed." }, 409),
  });
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Bound Draft/ }));
  await waitFor(() => expect(documentText()).toContain("Cached copy."));

  const editor = documentBody();
  editor.innerHTML = "<p>Cached copy.</p><p>Local edit.</p>";
  fireEvent.input(editor);
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));

  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Draft changed elsewhere"));
  expect(
    within(serverSaveIndicator()).getByRole("button", { name: "Reload server copy" }),
  ).toBeInTheDocument();
  const putCall = calls.find((call) => call.method === "PUT");
  expect(putCall?.body).toMatchObject({ expected_revision: 3 });
  expect(putCall && putCall.body && "matter_id" in putCall.body).toBe(false);
  // Nothing was overwritten: the local edit is still in the editor.
  expect(documentText()).toContain("Local edit.");
});

test("conflict reload leaves local edits intact when their recovery copy cannot be stored", async () => {
  const server = serverDraftSnapshot("conflict-recovery", "Conflict recovery", "<p>Server original.</p>", 1);
  installDraftsApiFetchMock({
    list: () => jsonResponse([server.document]),
    get: () => jsonResponse(server),
    update: () => jsonResponse({ detail: "Changed elsewhere." }, 409),
  });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Conflict recovery/ }));
  await waitFor(() => expect(documentText()).toContain("Server original."));
  documentBody().innerHTML = "<p>Local conflict edits.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Draft changed elsewhere"));
  const storageWrite = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
  try {
    fireEvent.click(within(serverSaveIndicator()).getByRole("button", { name: "Reload server copy" }));
    await waitFor(() => expect(serverSaveIndicator()).toHaveAttribute("data-tooltip", expect.stringContaining("could not preserve your local edits")));
    expect(documentText()).toContain("Local conflict edits.");
    expect(documentText()).not.toContain("Server original.");
  } finally {
    storageWrite.mockRestore();
  }
});

test("legacy unscoped drafts stay quarantined until an explicit confirmed import", async () => {
  window.localStorage.setItem(
    LEGACY_DOCUMENT_HISTORY_STORAGE_KEY,
    JSON.stringify([
      {
        id: "legacy-memo",
        title: "Legacy Memo",
        summary: "Saved before account scoping",
        sourceLabel: "No selected workspace source",
        content: "<p>Legacy content.</p>",
        updatedAt: "2026-01-05T10:00:00Z",
      },
    ]),
  );
  const calls = installDraftsApiFetchMock({
    create: (body) =>
      jsonResponse(
        serverDraftSnapshot("draft-srv-7", String(body.title), String(body.content), 1),
        201,
      ),
  });
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

  // Wait for the mount-time server list load; nothing may auto-upload.
  await waitFor(() => expect(calls.some((call) => call.method === "GET")).toBe(true));
  expect(calls.some((call) => call.method === "POST")).toBe(false);
  // Legacy entries never leak into the account-scoped history list.
  expect(storedDraftHistory().some((entry) => entry.id === "legacy-memo")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  const legacySection = screen.getByLabelText("Legacy local drafts");
  expect(legacySection).toHaveTextContent("Legacy Memo");
  expect(legacySection).toHaveTextContent(/never uploaded unless you explicitly import/);

  fireEvent.click(
    within(legacySection).getByRole("button", { name: "Import Legacy Memo to my account" }),
  );
  // The first click only reveals the scoped confirmation; still no upload.
  expect(calls.some((call) => call.method === "POST")).toBe(false);
  expect(legacySection).toHaveTextContent("alex.morgan@example.com");

  fireEvent.click(within(legacySection).getByRole("button", { name: "Confirm import" }));
  await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
  await waitFor(() =>
    expect(storedDraftHistory().some((entry) => entry.serverId === "draft-srv-7")).toBe(true),
  );
  // The imported entry leaves the legacy quarantine; nothing else was migrated.
  expect(window.localStorage.getItem(LEGACY_DOCUMENT_HISTORY_STORAGE_KEY)).toBeNull();
});

test("restores cached draft HTML only through the sanitizer", async () => {
  window.localStorage.setItem(
    SCOPED_DRAFT_CACHE_KEY,
    JSON.stringify([
      {
        id: "cached-hostile",
        title: "Cached Draft",
        summary: "Cached copy",
        sourceLabel: "No selected workspace source",
        content:
          '<p>Safe body.</p><script>window.__draftPwned = true;</script>' +
          '<p onclick="window.__draftPwned = true">Click</p>' +
          '<img src="https://example.com/x.png" onerror="window.__draftPwned = true">',
        updatedAt: "2026-07-19T10:00:00Z",
        status: "complete",
      },
    ]),
  );
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(screen.getByRole("button", { name: /Restore Cached Draft/ }));

  await waitFor(() => expect(documentText()).toContain("Safe body."));
  const editorHtml = documentBody().innerHTML;
  expect(editorHtml).not.toContain("<script");
  expect(editorHtml).not.toContain("onerror");
  expect(editorHtml).not.toContain("onclick");
  expect((window as { __draftPwned?: boolean }).__draftPwned).toBeUndefined();
});

test("server draft content is sanitized before entering the editor", async () => {
  const hostileServerHtml =
    '<p>Server body.</p><img src="https://example.com/y.png" onerror="window.__srvPwned = true">';
  installDraftsApiFetchMock({
    list: () =>
      jsonResponse([serverDraftSnapshot("draft-srv-5", "Server Stored Draft", hostileServerHtml, 2).document]),
    get: () => jsonResponse(serverDraftSnapshot("draft-srv-5", "Server Stored Draft", hostileServerHtml, 2)),
  });
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Server Stored Draft/ }));

  await waitFor(() => expect(documentText()).toContain("Server body."));
  expect(documentBody().innerHTML).not.toContain("onerror");
  expect((window as { __srvPwned?: boolean }).__srvPwned).toBeUndefined();
});

test("strikethrough, highlight, and font size apply real inline formatting", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML = "<p>Formatting target text.</p>";
  fireEvent.input(editor);

  selectEditorText("Formatting");
  openDocumentTools("Text");
  fireEvent.click(screen.getByRole("button", { name: "Strikethrough" }));
  expect(editor.innerHTML).toContain("<s>Formatting</s>");

  selectEditorText("target");
  openDocumentTools("Text");
  fireEvent.click(screen.getByRole("button", { name: "Highlight in amber" }));
  expect(editor.innerHTML).toMatch(/background-color:\s*(#fde68a|rgb\(253,\s*230,\s*138\))/);

  selectEditorText("text");
  // Sizes are labeled in Word points; 24pt renders as its preview-px twin.
  openDocumentTools("Text");
  fireEvent.change(screen.getByLabelText("Text size"), { target: { value: "24" } });
  expect(editor.innerHTML).toContain("font-size: 35.4px");

  selectEditorText("text");
  openDocumentTools("Text");
  fireEvent.change(screen.getByLabelText("Text font"), { target: { value: "georgia" } });
  expect(editor.innerHTML).toMatch(/font-family:\s*georgia/i);

  // Default resets the override instead of stacking another span.
  selectEditorText("text");
  openDocumentTools("Text");
  fireEvent.change(screen.getByLabelText("Text font"), { target: { value: "default" } });
  expect(editor.innerHTML).not.toMatch(/font-family/i);
});

test("deck toolbar font and size selects restyle the highlighted slide text", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="S.F. Steward" />);
  switchToDeckMode();
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Title + bullets" }));

  const bullets = document.querySelector("[data-deck-block].is-bullets") as HTMLElement;
  bullets.innerHTML = "<ul><li>Growth targets by region</li></ul>";
  fireEvent.input(bullets);
  const textNode = bullets.querySelector("li")!.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.textContent!.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  openDocumentTools("Text");
  fireEvent.change(screen.getByLabelText("Slide text size"), { target: { value: "28" } });
  expect(bullets.innerHTML).toContain("font-size: 28px");

  const li = bullets.querySelector("li")!;
  const sizedText = li.firstChild!;
  const range2 = document.createRange();
  range2.selectNodeContents(li);
  selection.removeAllRanges();
  selection.addRange(range2);
  void sizedText;
  openDocumentTools("Text");
  fireEvent.change(screen.getByLabelText("Slide text font"), { target: { value: "times" } });
  expect(bullets.innerHTML).toMatch(/font-family:\s*(&quot;|['"])?times new roman/i);
});

test("paragraph alignment writes a real text-align the exports understand", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML = "<p>Centered summary line.</p>";
  fireEvent.input(editor);

  placeEditorCaretAtTextStart("Centered");
  openDocumentTools("Paragraph");
  fireEvent.click(screen.getByRole("button", { name: "Align center" }));
  expect(editor.innerHTML).toContain('text-align: center');
  expect(screen.getByRole("button", { name: "Align center" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  openDocumentTools("Paragraph");
  fireEvent.click(screen.getByRole("button", { name: "Align left" }));
  expect(editor.innerHTML).not.toContain("text-align");
});

test("the link tool applies a validated web address to highlighted text", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML = "<p>Read the annual report today.</p>";
  fireEvent.input(editor);

  selectEditorText("annual report");
  fireEvent.click(screen.getByRole("button", { name: "Insert content" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Link" }));
  const dialog = screen.getByRole("dialog", { name: "Link editor" });
  const input = within(dialog).getByLabelText("Link address");

  fireEvent.change(input, { target: { value: "not a real url" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply link" }));
  expect(within(dialog).getByRole("alert")).toHaveTextContent(/web address/i);
  expect(editor.innerHTML).not.toContain("<a");

  fireEvent.change(input, { target: { value: "example.com/annual-report" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply link" }));
  expect(editor.innerHTML).toContain('href="https://example.com/annual-report"');
  expect(screen.queryByRole("dialog", { name: "Link editor" })).not.toBeInTheDocument();
});

test("the link tool asks for a highlight instead of inventing a target", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML = "<p>Nothing selected here.</p>";
  fireEvent.input(editor);
  window.getSelection()?.removeAllRanges();

  fireEvent.click(screen.getByRole("button", { name: "Insert content" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Link" }));
  expect(
    screen.getByText("Highlight the text you want to link, then choose Link again."),
  ).toBeInTheDocument();
  expect(editor.innerHTML).not.toContain("<a");
});

test("word count reports the live document length", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  expect(screen.getByText("0 words")).toBeInTheDocument();

  const editor = documentBody();
  editor.innerHTML = "<p>Five short words appear here.</p>";
  fireEvent.input(editor);
  expect(screen.getByText("5 words")).toBeInTheDocument();
});

function switchToDeckMode() {
  fireEvent.click(screen.getByRole("button", { name: "Deck" }));
}

test("mode switch starts a blank deck when the document is empty", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  expect(screen.getByRole("button", { name: "Deck" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Blank deck started. Add slides from the filmstrip.")).toBeInTheDocument();
  expect(screen.getByText("Slide 1 of 1")).toBeInTheDocument();
  // Deck export menu is honest: PowerPoint + Markdown outline, no Word/print.
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(screen.getByText("PowerPoint deck")).toBeInTheDocument();
  expect(screen.getByText("Markdown outline")).toBeInTheDocument();
  expect(screen.queryByText("Word document")).not.toBeInTheDocument();
  expect(screen.queryByText("Print / Save as PDF")).not.toBeInTheDocument();
});

test("the mobile assistant drawer traps keyboard focus and makes closed controls inert", () => {
  const previousWidth = window.innerWidth;
  window.innerWidth = 391;
  const view = render(<DocumentAssistantWorkspace data={sampleData} />);
  try {
    const rail = screen.getByLabelText("Assistant workflow");
    const editor = documentBody().closest("main")!;
    expect(rail).toHaveAttribute("inert");
    expect(rail).toHaveAttribute("aria-hidden", "true");
    expect(editor).not.toHaveAttribute("inert");
    const trigger = screen.getByRole("button", { name: "Open the document assistant" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(rail).not.toHaveAttribute("inert");
    expect(rail).toHaveAttribute("aria-modal", "true");
    expect(editor).toHaveAttribute("inert");
    const first = within(rail).getByRole("button", { name: "Back to chat" });
    expect(first).toHaveFocus();
    fireEvent.change(within(rail).getByRole("textbox", { name: "Ask the document assistant" }), { target: { value: "Draft a memo" } });
    const send = within(rail).getByRole("button", { name: "Apply instruction" });
    send.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(send).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(rail).toHaveAttribute("inert");
    expect(editor).not.toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  } finally {
    view.unmount();
    window.innerWidth = previousWidth;
  }
});

test("Escape closes an unsaved-edits dialog without also closing its mobile assistant drawer", () => {
  const previousWidth = window.innerWidth;
  window.innerWidth = 391;
  const onClose = vi.fn();
  const view = render(<DocumentAssistantWorkspace data={sampleData} onCloseDraft={onClose} />);
  try {
    documentBody().innerHTML = "<p>Keep my unsaved mobile draft.</p>";
    fireEvent.input(documentBody());
    fireEvent.click(screen.getByRole("button", { name: "Open the document assistant" }));
    const rail = screen.getByRole("dialog", { name: "Assistant workflow" });
    fireEvent.click(within(rail).getByRole("button", { name: "Back to chat" }));
    expect(screen.getByRole("dialog", { name: "Unsaved draft edits" })).toBeInTheDocument();
    expect(rail).toHaveAttribute("inert");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Unsaved draft edits" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Assistant workflow" })).not.toHaveAttribute("inert");
    expect(onClose).not.toHaveBeenCalled();
    expect(documentText()).toContain("Keep my unsaved mobile draft.");
  } finally {
    view.unmount();
    window.innerWidth = previousWidth;
  }
});

/** jsdom has no PointerEvent; React reads pointerType off the native event. */
function firePointer(node: Element, type: string, pointerType = "mouse", init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(node, event);
}

test("the compact assistant drawer opens from its seam pull tab and the ⌘. shortcut", () => {
  const previousWidth = window.innerWidth;
  window.innerWidth = 1000;
  const view = render(<DocumentAssistantWorkspace data={sampleData} />);
  try {
    const rail = screen.getByLabelText("Assistant workflow");
    expect(rail).toHaveAttribute("inert");
    // The seam tab is the drawer's only opener, so it must stay keyboard reachable.
    const tab = screen.getByRole("button", { name: "Open the document assistant" });
    expect(tab).toHaveClass("draft-rail-tab");
    expect(tab).not.toHaveAttribute("tabindex");
    expect(tab).toHaveAttribute("aria-keyshortcuts");
    expect(tab).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".document-editor-topbar .ai-pen-icon")).toBeNull();

    fireEvent.click(tab);
    expect(rail).toHaveAttribute("aria-modal", "true");
    expect(rail).not.toHaveAttribute("inert");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(rail).toHaveAttribute("inert");

    fireEvent.keyDown(document, { key: ".", metaKey: true });
    expect(rail).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: ".", ctrlKey: true });
    expect(rail).toHaveAttribute("inert");
    // Shift or Alt variants are left alone.
    fireEvent.keyDown(document, { key: ".", metaKey: true, shiftKey: true });
    expect(rail).toHaveAttribute("inert");
  } finally {
    view.unmount();
    window.innerWidth = previousWidth;
  }
});

test("resting the mouse on the drawer seam peeks the assistant without taking focus", async () => {
  const previousWidth = window.innerWidth;
  window.innerWidth = 1000;
  const view = render(<DocumentAssistantWorkspace data={sampleData} />);
  try {
    const rail = screen.getByLabelText("Assistant workflow");
    const editor = documentBody().closest("main")!;
    const edge = document.querySelector(".draft-rail-edge")!;
    documentBody().focus();

    // Touch never peeks; a quick mouse pass that leaves in time does nothing either.
    firePointer(edge, "pointerover", "touch");
    firePointer(edge, "pointerover");
    firePointer(edge, "pointerout", "mouse", { relatedTarget: editor });
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(rail).toHaveAttribute("inert");

    firePointer(edge, "pointerover");
    await waitFor(() => expect(rail).not.toHaveAttribute("inert"));
    expect(rail).toHaveClass("is-peek");
    expect(rail).not.toHaveAttribute("aria-modal");
    expect(editor).not.toHaveAttribute("inert");
    expect(documentBody()).toHaveFocus();

    // Wandering off the drawer tucks it away again.
    firePointer(documentBody(), "pointermove");
    await waitFor(() => expect(rail).toHaveAttribute("inert"));

    // A click inside a peeked drawer pins it as the modal panel.
    firePointer(edge, "pointerover");
    await waitFor(() => expect(rail).toHaveClass("is-peek"));
    firePointer(within(rail).getByRole("textbox", { name: "Ask the document assistant" }), "pointerdown");
    expect(rail).toHaveAttribute("aria-modal", "true");
    expect(rail).not.toHaveClass("is-peek");
    firePointer(documentBody(), "pointermove");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(rail).not.toHaveAttribute("inert");
  } finally {
    view.unmount();
    window.innerWidth = previousWidth;
  }
});

test("compact formatting controls expand on demand and reset between draft modes", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

  const documentToggle = screen.getByRole("button", { name: "Expand document formatting" });
  expect(documentToggle).toHaveAttribute("aria-expanded", "false");
  expect(documentToggle).toHaveAttribute("aria-controls", "document-formatting-controls");

  fireEvent.click(documentToggle);
  expect(
    screen.getByRole("button", { name: "Collapse document formatting" }),
  ).toHaveAttribute("aria-expanded", "true");

  switchToDeckMode();
  const deckToggle = screen.getByRole("button", { name: "Expand deck formatting" });
  expect(deckToggle).toHaveAttribute("aria-expanded", "false");
  expect(deckToggle).toHaveAttribute("aria-controls", "deck-formatting-controls");

  fireEvent.click(deckToggle);
  expect(screen.getByRole("button", { name: "Collapse deck formatting" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  fireEvent.click(screen.getByRole("button", { name: "Document" }));
  expect(screen.getByRole("button", { name: "Expand document formatting" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("converting a document produces slides and keeps the document versions", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML =
    "<h1>Expansion Brief</h1><h2>Goals</h2><ul><li>Hire two AEs</li><li>Open Boston</li></ul>";
  fireEvent.input(editor);
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));

  switchToDeckMode();
  expect(
    screen.getByRole("dialog", { name: "Switch to deck mode" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Convert into slides" }));

  expect(screen.getByText(/2 slides created from/)).toBeInTheDocument();
  expect(screen.getByText("Slide 1 of 2")).toBeInTheDocument();

  // Switching back restores the document untouched.
  fireEvent.click(screen.getByRole("button", { name: "Document" }));
  expect(documentText()).toContain("Hire two AEs");
});

test("deck slides can be added, duplicated, reordered, and deleted honestly", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Title + bullets" }));
  expect(screen.getByText("Slide 2 of 2")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Duplicate slide 2" }));
  expect(screen.getByText("Slide 3 of 3")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Move slide 3 up" }));
  expect(screen.getByText(/Slide moved to position 2/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Delete slide 2" }));
  expect(screen.getByText(/Slide 2 deleted/)).toBeInTheDocument();
  expect(screen.getByText("Slide 2 of 2")).toBeInTheDocument();

  // Undo restores the deleted slide through the deck undo stack.
  fireEvent.click(screen.getByRole("button", { name: "Undo deck edit" }));
  expect(screen.getByText(/Deck undo applied/)).toBeInTheDocument();
});

test("presents the deck full screen with notes, navigation, and an exit", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Title + bullets" }));

  // Give slide 2 (the selected one) real speaker notes.
  fireEvent.click(screen.getByRole("button", { name: /Speaker notes/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Speaker notes" }), {
    target: { value: "Open with the quarterly numbers." },
  });

  fireEvent.click(screen.getByRole("button", { name: "Present deck" }));
  const overlay = screen.getByRole("dialog", { name: "Deck presentation" });
  expect(within(overlay).getByText("Slide 2 of 2")).toBeInTheDocument();
  // Notes opened automatically because the deck has notes, showing this slide's.
  expect(within(overlay).getByText("Open with the quarterly numbers.")).toBeInTheDocument();

  fireEvent.click(within(overlay).getByRole("button", { name: "Previous slide" }));
  expect(within(overlay).getByText("Slide 1 of 2")).toBeInTheDocument();
  expect(within(overlay).getByText("No notes for this slide.")).toBeInTheDocument();
  expect(within(overlay).getByRole("button", { name: "Previous slide" })).toBeDisabled();

  fireEvent.click(within(overlay).getByRole("button", { name: "Next slide" }));
  expect(within(overlay).getByText("Slide 2 of 2")).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Deck presentation" })).not.toBeInTheDocument();
});

test("deck text edits flow into the model and into saved versions", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  const titleBlock = screen.getByRole("textbox", { name: /Title slide title/ });
  titleBlock.innerHTML = "Launch Plan";
  fireEvent.input(titleBlock);
  fireEvent.blur(titleBlock);

  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  expect(screen.getByText(/saved from deck edits/)).toBeInTheDocument();
  // A successful device save shows no badge (the Save tooltip carries the
  // local-only truth); only storage failures surface a badge.
  expect(screen.queryByText(/Local only — decks save on this device/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Not saved — too large/)).not.toBeInTheDocument();
});

test("deck versions restore through the validator and re-enter deck mode", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML = "<p>Doc content stays.</p>";
  fireEvent.input(editor);
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));

  switchToDeckMode();
  fireEvent.click(screen.getByRole("button", { name: "Start a blank deck" }));
  const titleBlock = screen.getByRole("textbox", { name: /Title slide title/ });
  titleBlock.innerHTML = "Deck v1";
  fireEvent.input(titleBlock);
  fireEvent.blur(titleBlock);
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));

  // Back to the document: the document content is untouched.
  fireEvent.click(screen.getByRole("button", { name: "Document" }));
  expect(documentText()).toContain("Doc content stays.");

  // Back to the deck: the edited slide text is still there.
  fireEvent.click(screen.getByRole("button", { name: "Deck" }));
  expect(screen.getByRole("textbox", { name: /Title slide title/ })).toHaveTextContent("Deck v1");
});

function fencedDeckJson(): string {
  return [
    "```json",
    JSON.stringify({
      schema: "aperture-deck-v1",
      title: "Boston Expansion",
      slides: [
        { id: "g1", notes: "Open warmly", layout: "title", title: "Boston Expansion", subtitle: "Growth plan" },
        {
          id: "g2",
          notes: "Walk the numbers",
          layout: "title-bullets",
          title: "Why Boston",
          bullets: [
            { runs: [{ text: "Talent density" }], level: 0 },
            { runs: [{ text: "Customer cluster" }], level: 0 },
          ],
        },
        { id: "g3", notes: "", layout: "closing", title: "Next steps", body: "Approve the budget" },
      ],
    }),
    "```",
  ].join("\n");
}

test("the deck assistant drafts validated slides from the composer", async () => {
  const requests = installChatCompletionFetchMock(fencedDeckJson());
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  expect(screen.getByPlaceholderText("Ask the deck assistant what to build")).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("Ask the deck assistant what to build"), {
    target: { value: "Draft a deck about our Boston expansion" },
  });
  fireEvent.submit(screen.getByRole("textbox", { name: "Ask the deck assistant" }).closest("form")!);

  await waitFor(() => expect(screen.getByText("Slide 1 of 3")).toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: /Title slide title/ })).toHaveTextContent(
    "Boston Expansion",
  );
  expect(requests.length).toBeGreaterThan(0);
  const sent = requests[0] as { messages: Array<{ content: string }> };
  expect(sent.messages[0].content).toContain("aperture-deck-v1");
});

test("invalid deck JSON retries then falls back to a real outline deck", async () => {
  const requests = installChatCompletionFetchMock(
    "## Boston Expansion\n\n- Talent density\n- Customer cluster",
  );
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  fireEvent.change(screen.getByPlaceholderText("Ask the deck assistant what to build"), {
    target: { value: "Draft a Boston deck" },
  });
  fireEvent.submit(screen.getByRole("textbox", { name: "Ask the deck assistant" }).closest("form")!);

  await waitFor(() =>
    expect(screen.getAllByText(/structured output failed validation/).length).toBeGreaterThan(0),
  );
  // One retry happened, then the deterministic outline fallback produced slides.
  expect(requests).toHaveLength(2);
  expect(screen.getByText(/Slide 1 of/)).toBeInTheDocument();
});

test("a deck request asking for images gets real web pictures and backgrounds", async () => {
  const TINY_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const deckReply = [
    "```json",
    JSON.stringify({
      schema: "aperture-deck-v1",
      title: "Boston Expansion",
      slides: [
        { id: "v1", notes: "", layout: "title", title: "Boston Expansion", subtitle: "Growth plan" },
        {
          id: "v2",
          notes: "",
          layout: "image-caption",
          title: "The market",
          image: { src: "", alt: "Boston skyline at dusk" },
          caption: "Downtown Boston",
        },
        { id: "v3", notes: "", layout: "closing", title: "Next steps", body: "Approve the budget" },
      ],
    }),
    "```",
  ].join("\n");
  const chatRequests: unknown[] = [];
  const fetchMock = globalThis.fetch as unknown as {
    mockImplementation: (implementation: typeof fetch) => void;
  };
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/chat/complete")) {
      chatRequests.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: deckReply } }], citations: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("en.wikipedia.org")) {
      return new Response(
        JSON.stringify({
          query: {
            pages: { "1": { title: "Boston", thumbnail: { source: "https://upload.wikimedia.org/boston.jpg" } } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/assets/image-proxy")) {
      const bytes = Uint8Array.from(atob(TINY_PNG), (char) => char.charCodeAt(0));
      return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return new Response("unavailable", { status: 503 });
  });

  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();
  fireEvent.change(screen.getByPlaceholderText("Ask the deck assistant what to build"), {
    target: { value: "Create a five slide deck about Boston with images and graphics" },
  });
  fireEvent.submit(screen.getByRole("textbox", { name: "Ask the deck assistant" }).closest("form")!);

  await waitFor(() => expect(screen.getByText("Slide 1 of 3")).toBeInTheDocument());
  // The prompt carries the imagery guidance so the model plans picture slides.
  const sent = chatRequests[0] as { messages: Array<{ content: string }> };
  expect(sent.messages[0].content).toContain("describe the ideal photo");

  // The empty image-caption slide received the matched public web picture.
  await waitFor(() => {
    expect(document.querySelector('img[src="https://upload.wikimedia.org/boston.jpg"]')).toBeTruthy();
  });
  // With no image-generation model enabled, slide backgrounds come from the
  // proxied web image, stored as bounded data URLs in the background library.
  await waitFor(() => {
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[style]")).some((element) =>
        element.style.backgroundImage.includes("data:image/png"),
      ),
    ).toBe(true);
  });
});

test("deck blocks show corner resize handles and commit adjusted boxes", async () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  const titleBlock = screen.getByRole("textbox", { name: "Title slide title" });
  expect(titleBlock.style.maxHeight).toBe("122px");
  fireEvent.focus(titleBlock);

  // Focusing a block reveals a frame with all four corner grips.
  const seHandle = screen.getByRole("button", { name: /Resize the title block from the bottom right/ });
  expect(screen.getByRole("button", { name: /from the top left/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /from the top right/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /from the bottom left/ })).toBeInTheDocument();

  // Arrow keys nudge the corner; the block's box grows and the change lands
  // as a real deck edit.
  fireEvent.keyDown(seHandle, { key: "ArrowDown" });
  await waitFor(() => expect(titleBlock.style.maxHeight).toBe("126px"));
  expect(screen.getAllByText(/Slide block resized/).length).toBeGreaterThan(0);

  // Double-click restores the layout's default geometry.
  fireEvent.doubleClick(seHandle);
  await waitFor(() => expect(titleBlock.style.maxHeight).toBe("122px"));
});

test("deck templates drawer offers starters, brand upload, and honest AI image gating", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  // Templates drawer switches to the deck variant.
  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  expect(screen.getByText("Pitch deck")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Upload brand template" })).toBeInTheDocument();
  expect(screen.getByText(/No brand theme/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Start Pitch deck/ }));
  expect(screen.getByText("Slide 1 of 7")).toBeInTheDocument();
  expect(screen.getByText(/Pitch deck template started/)).toBeInTheDocument();

  // Image slide: dialog opens; AI generation is honestly gated when no
  // image-output model exists in the workspace catalog.
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Image + caption" }));
  fireEvent.click(screen.getByRole("button", { name: "Add image" }));
  const dialog = screen.getByRole("dialog", { name: "Slide image" });
  expect(within(dialog).getByRole("button", { name: "Generate AI image" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Find web image" })).toBeInTheDocument();
});

test("slide background menu offers upload and honestly gates the remove actions", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  fireEvent.click(screen.getByRole("button", { name: "Slide background" }));
  const menu = screen.getByRole("menu", { name: "Slide background options" });
  expect(within(menu).getByRole("menuitem", { name: /Upload background/ })).toBeEnabled();
  // A deck with no background yet cannot spread, remove, or clear one.
  expect(within(menu).getByRole("menuitem", { name: "Use on every slide" })).toBeDisabled();
  expect(within(menu).getByRole("menuitem", { name: "Remove from this slide" })).toBeDisabled();
  expect(within(menu).getByRole("menuitem", { name: "Clear from all slides" })).toBeDisabled();

  const input = screen.getByLabelText("Upload slide background image");
  expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
});


test("deck AI tools: without a highlight the AI edits the whole slide, images need a model", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  // With nothing highlighted, AI edit targets the whole current slide.
  fireEvent.click(screen.getByRole("button", { name: "Edit slide with AI" }));
  const slideDialog = screen.getByRole("dialog", { name: "Edit slide with AI" });
  expect(slideDialog).toHaveTextContent("Slide 1");
  expect(within(slideDialog).getByRole("option", { name: "Split into two slides" })).toBeInTheDocument();
  expect(within(slideDialog).getByRole("option", { name: "Write speaker notes" })).toBeInTheDocument();
  fireEvent.click(within(slideDialog).getByRole("button", { name: "Close Edit slide with AI" }));
  expect(screen.queryByRole("dialog", { name: "Edit slide with AI" })).not.toBeInTheDocument();

  // No image model in this workspace: both image entry points disable with an
  // honest tooltip instead of pretending.
  const toolbarImage = screen.getByRole("button", { name: "Generate AI slide image" });
  expect(toolbarImage).toBeDisabled();
  expect(toolbarImage).toHaveAttribute(
    "data-tooltip",
    "No image-generation model is enabled for your workspace",
  );
  const composerToggle = screen.getByRole("button", { name: "Toggle AI slide images" });
  expect(composerToggle).toBeDisabled();
});

test("deck AI selection edit rewrites the highlighted text through the provider", async () => {
  const requests = installChatCompletionFetchMock("Pipeline expanded thirty percent");
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Title + bullets" }));

  const bullets = document.querySelector("[data-deck-block].is-bullets") as HTMLElement;
  bullets.innerHTML = "<ul><li>Pipeline grew 30 percent</li></ul>";
  fireEvent.input(bullets);
  const textNode = bullets.querySelector("li")!.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.textContent!.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  fireEvent.click(screen.getByRole("button", { name: "Edit slide with AI" }));
  expect(screen.getByRole("dialog", { name: "Edit slide text with AI" })).toBeInTheDocument();
  submitInlineAiInstruction("Spell out the number");

  const accept = await screen.findByRole("button", { name: "Accept AI suggestion" });
  const sent = requests[0] as { messages: Array<{ content: string }> };
  expect(sent.messages[0].content).toContain("Pipeline grew 30 percent");
  expect(sent.messages[0].content).toContain("Spell out the number");
  // Reviewed first: the slide is untouched until the suggestion is accepted.
  expect(bullets.textContent).toContain("Pipeline grew 30 percent");
  fireEvent.click(accept);
  await waitFor(() =>
    expect(bullets.textContent).toContain("Pipeline expanded thirty percent"),
  );
});

test("whole-slide AI edit previews before and after, then splits the slide on accept", async () => {
  const requests = installChatCompletionFetchMock(
    [
      "```json",
      JSON.stringify({
        slides: [
          {
            id: "model-picked-id",
            layout: "title-bullets",
            title: "Growth drivers",
            bullets: [{ runs: [{ text: "Pipeline up 30%" }], level: 0 }],
            notes: "Walk through the pipeline numbers.",
          },
          { id: "slide-extra", layout: "quote", quote: "Fast onboarding keeps customers.", attribution: "CS lead", notes: "" },
        ],
      }),
      "```",
    ].join("\n"),
  );
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();
  expect(screen.getByText("Slide 1 of 1")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Edit slide with AI" }));
  fireEvent.click(screen.getByRole("option", { name: "Split into two slides" }));
  const accept = await screen.findByRole("button", { name: "Accept AI suggestion" });
  expect(screen.getByLabelText("AI suggestion")).toHaveTextContent("After · 2 slides");
  expect(screen.getByLabelText("AI suggestion")).toHaveTextContent("Walk through the pipeline numbers.");
  // Nothing changes until the suggestion is applied.
  expect(screen.getByText("Slide 1 of 1")).toBeInTheDocument();

  const prompt = (requests[0] as { messages: Array<{ content: string }> }).messages[0].content;
  expect(prompt).toContain("You are editing slide 1 of 1");
  expect(prompt).toContain("Split it into two focused slides");
  expect(prompt).not.toContain("data:image");

  fireEvent.click(accept);
  await waitFor(() => expect(screen.getByText("Slide 1 of 2")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Slide 1: Title + bullets" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Slide 2: Quote" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo deck edit" }));
  await waitFor(() => expect(screen.getByText("Slide 1 of 1")).toBeInTheDocument());
});

test("highlighting slide text floats the Ask AI pill that opens the inline editor", async () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="S.F. Steward" />);
  switchToDeckMode();
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Title + bullets" }));

  const bullets = document.querySelector("[data-deck-block].is-bullets") as HTMLElement;
  bullets.innerHTML = "<ul><li>Quarterly revenue targets</li></ul>";
  fireEvent.input(bullets);
  const textNode = bullets.querySelector("li")!.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.textContent!.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(bullets);

  // The same floating affordance as the document editor, over slide text.
  const pill = await screen.findByRole("button", {
    name: "Ask AI to edit highlighted slide text",
  });
  fireEvent.click(pill);
  const dialog = screen.getByRole("dialog", { name: "Edit slide text with AI" });
  expect(dialog).toHaveTextContent("Quarterly revenue targets");
  // The same one-click actions as the document editor.
  expect(within(dialog).getByRole("option", { name: "Make shorter" })).toBeInTheDocument();
  expect(within(dialog).getByRole("option", { name: "Spanish" })).toBeInTheDocument();
  // Closing leaves the slide untouched.
  fireEvent.click(within(dialog).getByRole("button", { name: "Close Edit slide text with AI" }));
  expect(
    screen.queryByRole("dialog", { name: "Edit slide text with AI" }),
  ).not.toBeInTheDocument();
  expect(bullets.textContent).toContain("Quarterly revenue targets");
});

test("deck keyboard shortcuts duplicate, navigate, reorder, and delete slides", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();
  const firstThumb = screen.getByRole("button", { name: "Slide 1: Title" });
  firstThumb.focus();
  fireEvent.keyDown(firstThumb, { key: "d", metaKey: true });
  expect(screen.getByText("Slide 2 of 2")).toBeInTheDocument();

  fireEvent.keyDown(document.activeElement ?? firstThumb, { key: "n", metaKey: true, shiftKey: true });
  expect(screen.getByText("Slide 3 of 3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Slide 3: Title + bullets" })).toBeInTheDocument();

  const thumb3 = screen.getByRole("button", { name: "Slide 3: Title + bullets" });
  fireEvent.keyDown(thumb3, { key: "ArrowUp", altKey: true });
  expect(screen.getByRole("button", { name: "Slide 2: Title + bullets" })).toBeInTheDocument();

  fireEvent.keyDown(screen.getByRole("button", { name: "Slide 2: Title + bullets" }), { key: "ArrowUp" });
  expect(screen.getByText("Slide 1 of 3")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("button", { name: "Slide 1: Title" }), { key: "Delete" });
  expect(screen.getByText(/of 2$/)).toBeInTheDocument();
  expect(screen.getByText(/Slide 1 deleted/)).toBeInTheDocument();

  fireEvent.keyDown(screen.getByRole("button", { name: /^Slide 1:/ }), { key: "z", metaKey: true });
  expect(screen.getByText(/of 3$/)).toBeInTheDocument();
});

test("slide sorter shows every slide and opens one on Enter", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Quote" }));
  fireEvent.click(screen.getByRole("button", { name: "Slide sorter" }));
  const sorter = screen.getByRole("listbox", { name: "Slide sorter" });
  expect(within(sorter).getAllByRole("option")).toHaveLength(2);
  fireEvent.keyDown(within(sorter).getByRole("option", { name: "Slide 1: Title" }), { key: "Enter" });
  expect(screen.queryByRole("listbox", { name: "Slide sorter" })).not.toBeInTheDocument();
  expect(screen.getByText("Slide 1 of 2")).toBeInTheDocument();
});

test("presenter view shows the next slide and timer; B blanks the screen; digits jump", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Quote" }));
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Closing" }));
  fireEvent.click(screen.getByRole("button", { name: "Slide 1: Title" }));
  fireEvent.click(screen.getByRole("button", { name: "Present deck" }));
  const overlay = screen.getByRole("dialog", { name: "Deck presentation" });
  expect(overlay).toHaveTextContent("Slide 1 of 3");

  fireEvent.keyDown(window, { key: "p" });
  expect(within(overlay).getByLabelText("Presenter tools")).toHaveTextContent("Next · slide 2");
  expect(within(overlay).getByRole("button", { name: "Pause timer" })).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "b" });
  expect(overlay.querySelector(".deck-present-blank.is-black")).not.toBeNull();
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(overlay.querySelector(".deck-present-blank")).toBeNull();
  expect(overlay).toHaveTextContent("Slide 2 of 3");

  fireEvent.keyDown(window, { key: "3" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(overlay).toHaveTextContent("Slide 3 of 3");
  expect(within(overlay).getByLabelText("Presenter tools")).toHaveTextContent("End of deck");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Deck presentation" })).not.toBeInTheDocument();
});

test("the move grip nudges a slide block with the arrow keys as one undo step each", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();
  const title = screen.getByRole("textbox", { name: "Title slide title" });
  fireEvent.focus(title);
  const grip = screen.getByRole("button", { name: "Move the title block" });
  const before = parseFloat(title.style.left);
  fireEvent.keyDown(grip, { key: "ArrowRight", shiftKey: true });
  expect(parseFloat(screen.getByRole("textbox", { name: "Title slide title" }).style.left)).toBe(before + 10);
  fireEvent.keyDown(grip, { key: "ArrowLeft" });
  expect(parseFloat(screen.getByRole("textbox", { name: "Title slide title" }).style.left)).toBe(before + 9);
  fireEvent.click(screen.getByRole("button", { name: "Undo deck edit" }));
  expect(parseFloat(screen.getByRole("textbox", { name: "Title slide title" }).style.left)).toBe(before + 10);
});

test("a starred drafting model survives mounts where it is temporarily unavailable", async () => {
  window.localStorage.setItem("aperture-document-draft-model-v1", "openrouter-openai-gpt-4o-mini");

  // Mount without the starred model in the usable list (bootstrap data not
  // loaded yet, or approvals filtered): the trigger falls back for display.
  const view = render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );
  expect(
    screen.getByRole("button", { name: "Document drafting model" }),
  ).not.toHaveTextContent("gpt-4o-mini");
  // The starred default is never overwritten by the display fallback.
  expect(window.localStorage.getItem("aperture-document-draft-model-v1")).toBe(
    "openrouter-openai-gpt-4o-mini",
  );

  // When the real agent list arrives on the same mount, the star wins again.
  view.rerender(
    <DocumentAssistantWorkspace
      data={dataWithApprovedDraftModel("openrouter-openai-gpt-4o-mini")}
      brandName="Aperture Chat"
    />,
  );
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Document drafting model" }),
    ).toHaveTextContent("OpenRouter: openai/gpt-4o-mini");
  });
});

test("history preview, archive, unarchive and confirmed deletion preserve the draft lifecycle", async () => {
  window.localStorage.setItem(SCOPED_DRAFT_CACHE_KEY, JSON.stringify([{
    id: 'history-audit', title: 'History audit', content: '<h1>History audit</h1><p>Preview passage.</p>',
    summary: 'A saved test draft', sourceLabel: 'Local draft', updatedAt: new Date().toISOString(), status: 'complete',
  }]));
  const view = render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Document history' }));
  const restore = screen.getByRole('button', { name: /Restore History audit from document history/ });
  fireEvent.focus(restore);
  await waitFor(() => expect(screen.getByRole('status', { name: 'Preview of History audit' })).toHaveTextContent('Preview passage.'));
  fireEvent.click(screen.getByRole('button', { name: 'Archive History audit' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /Restore History audit from document history/ })).not.toBeInTheDocument());
  view.unmount();
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Document history' }));
  fireEvent.click(screen.getByRole('button', { name: 'Archived', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Unarchive History audit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Active', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete History audit' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete draft' })).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: /Restore History audit from document history/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete History audit' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete draft' })).getByRole('button', { name: 'Delete draft' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /Restore History audit from document history/ })).not.toBeInTheDocument());
  expect(JSON.parse(window.localStorage.getItem(SCOPED_DRAFT_CACHE_KEY)!)).toEqual([]);
});

test('mode notch supports keyboard navigation', () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Document', exact: true }), { key: 'ArrowRight' });
  expect(screen.getByRole('button', { name: 'Deck', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('returning from deck mode retains unsaved document edits', () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const body = documentBody();
  body.innerHTML = '<h1>Working draft</h1><p>Unsaved passage retained.</p>';
  fireEvent.input(body);
  fireEvent.click(screen.getByRole('button', { name: 'Deck', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: "Convert into slides" }));
  fireEvent.click(screen.getByRole('button', { name: 'Document', exact: true }));
  expect(documentText()).toContain('Unsaved passage retained.');
  expect(screen.getByRole('button', { name: 'Save version' })).toBeEnabled();
});

test('browser download remains available when a save picker is exposed', async () => {
  const downloads = installDownloadSpy();
  const picker = vi.fn();
  Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
  try {
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    documentBody().innerHTML = '<h1>Download check</h1><p>Exported content.</p>';
    fireEvent.input(documentBody());
    fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
    openExportDialog();
    fireEvent.change(screen.getByLabelText('Export destination'), { target: { value: 'download' } });
    fireEvent.click(screen.getByRole('button', { name: /Word document/ }));
    await waitFor(() => expect(downloads.downloads).toHaveLength(1));
    expect(picker).not.toHaveBeenCalled();
  } finally { downloads.restore(); }
});

test('MLA layout repairs a saved paper without a provider call and can be undone', () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML = '<p>The validator has repeated findings.</p><p>[Student Name]</p><p>Teacher</p><p>History</p><p>[Date]</p><h2>River Crossing</h2><p>Keep this exact historical passage.</p>';
  fireEvent.input(editor);
  fireEvent.click(screen.getByRole('button', { name: 'Assistant settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply MLA layout' }));
  expect(documentText()).not.toContain('validator');
  expect(documentText()).toContain('Keep this exact historical passage.');
  expect(documentBody().querySelector('.document-mla-body')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));
  expect(documentText()).toContain('The validator has repeated findings.');
});

test.each(['document', 'deck'] as const)('copy %s reports denied clipboard access and succeeds on retry', async (mode) => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writeText = vi.fn().mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    documentBody().innerHTML = '<h1>Copy verification</h1><p>Preserved passage.</p>';
    fireEvent.input(documentBody());
    if (mode === 'deck') {
      fireEvent.click(screen.getByRole('button', { name: 'Deck', exact: true }));
      fireEvent.click(screen.getByRole('button', { name: 'Convert into slides' }));
    }
    openDocumentTools('More');
    const button = screen.getByRole('button', { name: mode === 'deck' ? 'Copy deck outline' : 'Copy document' });
    fireEvent.click(button);
    // Decks now also report their server save in a status badge; read the
    // workspace status line specifically.
    const statusLine = () =>
      screen.getAllByRole('status').filter((element) => !element.classList.contains('document-server-save-state'))[0];
    await waitFor(() => expect(statusLine()).toHaveTextContent('Could not access the clipboard.'));
    fireEvent.click(button);
    await waitFor(() => expect(statusLine()).toHaveTextContent(`${mode === 'deck' ? 'Deck outline' : 'Document'} copied to clipboard.`));
    expect(writeText.mock.calls[1][0]).toContain('Preserved passage.');
  } finally {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

function serverDeckSnapshot(id: string, title: string, content: string, revision: number) {
  const snapshot = serverDraftSnapshot(id, title, content, revision);
  return {
    document: { ...snapshot.document, kind: "deck" },
    revision: { ...snapshot.revision, sanitizer_version: "deck-json-v1" },
  };
}

test("decks save to the server as kind deck and report Saved, conflicts, and size refusals honestly", async () => {
  let creates = 0;
  const calls = installDraftsApiFetchMock({
    create: (body) => {
      creates += 1;
      return jsonResponse(serverDeckSnapshot("deck-srv-1", String(body.title), String(body.content), 1), 201);
    },
    update: () => jsonResponse({ detail: "The draft changed before this update completed." }, 409),
  });
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  documentBody().innerHTML = "<h1>Board deck</h1><p>Agenda item one.</p>";
  fireEvent.input(documentBody());
  fireEvent.click(screen.getByRole("button", { name: "Deck", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Convert into slides" }));

  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Saved"));
  const createCall = calls.find((call) => call.method === "POST");
  expect(createCall?.body).toMatchObject({ kind: "deck" });
  expect(String(createCall?.body?.content)).toContain('"schema":"aperture-deck-v1"');
  expect(screen.queryByText(/decks save on this device/)).not.toBeInTheDocument();
  const cached = storedDraftHistory().find((item) => item.serverId === "deck-srv-1") as Record<string, unknown> | undefined;
  expect(cached).toMatchObject({ serverId: "deck-srv-1", serverRevision: 1, kind: "deck" });
  expect(creates).toBe(1);

  // A second save is a CAS update; a 409 is an explicit conflict with a reload action.
  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Board deck v2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Draft changed elsewhere"));
  expect(within(serverSaveIndicator()).getByRole("button", { name: "Reload server copy" })).toBeInTheDocument();
  expect(creates).toBe(1);
});

test("a server deck opened by id enters the deck editor bound to its server revision", async () => {
  const deck = JSON.stringify({
    schema: "aperture-deck-v1",
    title: "Kickoff",
    theme: {},
    slides: [
      { id: "s1", layout: "title", title: [{ text: "Kickoff" }], subtitle: [{ text: "Q4 plan" }], notes: "" },
      { id: "s2", layout: "title-bullets", title: [{ text: "Agenda" }], bullets: [{ runs: [{ text: "Roadmap review" }], level: 0 }], notes: "" },
    ],
  });
  const calls = installDraftsApiFetchMock({
    get: () => jsonResponse(serverDeckSnapshot("deck-srv-9", "Kickoff", deck, 3)),
    update: (_id, body) => jsonResponse(serverDeckSnapshot("deck-srv-9", "Kickoff", String(body.content), 4)),
  });
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" initialServerDraftId="deck-srv-9" />);

  expect(await screen.findByRole("button", { name: "Document", exact: true })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Deck", exact: true })).toHaveAttribute("aria-pressed", "true"));
  expect(screen.getByLabelText("Document title")).toHaveValue("Kickoff");
  await waitFor(() => expect(serverSaveIndicator()).toHaveTextContent("Saved"));

  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Kickoff (final)" } });
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
  const put = calls.find((call) => call.method === "PUT");
  expect(put?.url).toContain("/api/drafts/deck-srv-9");
  expect(put?.body).toMatchObject({ expected_revision: 3 });
  expect(String(put?.body?.content)).toContain("Roadmap review");
});


test("saved draft loading failures are visible and selecting the card retries", async () => {
  const saved = serverDraftSnapshot("open-retry", "Retry review", "<p>Recovered review.</p>", 1);
  let available = false;
  installDraftsApiFetchMock({ list: () => jsonResponse([saved.document]), get: () => available ? jsonResponse(saved) : offlineResponse() });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Retry review/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not open");
  expect(screen.getAllByText("Document history")).toHaveLength(1);
  available = true;
  fireEvent.click(screen.getByRole("button", { name: /Restore Retry review/ }));
  await waitFor(() => expect(documentText()).toContain("Recovered review."));
});

test("slide layouts are directly browsable and applied to the selected slide", () => {
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Deck" }));
  const gallery = screen.getByLabelText("Browse slide layouts");
  expect(within(gallery).getAllByRole("button")).toHaveLength(7);
  fireEvent.click(within(gallery).getByRole("button", { name: "Apply Two columns layout" }));
  expect(within(gallery).getByRole("button", { name: "Apply Two columns layout" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Deck starters & brand themes" }));
  expect(screen.getByLabelText("Deck starter templates")).toBeInTheDocument();
});


test("palette changes preserve slide text and can be undone", () => {
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Deck" }));
  const title = screen.getByRole("textbox", { name: "Title slide title" });
  title.innerHTML = "A title to keep";
  fireEvent.input(title);
  fireEvent.click(screen.getByRole("button", { name: "Themes", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Apply Midnight color theme" }));
  expect(screen.getByRole("textbox", { name: "Title slide title" })).toHaveTextContent("A title to keep");
  expect(screen.getByRole("button", { name: "Apply Midnight color theme" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Undo deck edit" }));
  expect(screen.getByRole("button", { name: "Apply Aperture color theme" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("textbox", { name: "Title slide title" })).toHaveTextContent("A title to keep");
});

test("local pending drafts can be archived without deleting their only copy", async () => {
  window.localStorage.setItem(SCOPED_DRAFT_CACHE_KEY, JSON.stringify([{
    id: "pending-archive", title: "Offline notes", content: "<p>Keep these notes.</p>",
    summary: "Local changes", sourceLabel: "Local draft", updatedAt: new Date().toISOString(),
    status: "complete", serverSavePending: true,
  }]));
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(screen.getByRole("button", { name: "Archive Offline notes" }));
  await waitFor(() => expect(storedDraftHistory().find(item => item.id === "pending-archive")).toMatchObject({archived: true, content: "<p>Keep these notes.</p>"}));
});


test("reopening the same document from deck mode rehydrates its newly mounted editor", async () => {
  const saved = serverDraftSnapshot("remount-doc", "Remount review", "<p>Document body survives mode changes.</p>", 1);
  installDraftsApiFetchMock({ list: () => jsonResponse([saved.document]), get: () => jsonResponse(saved) });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Remount review/ }));
  await waitFor(() => expect(documentText()).toContain("Document body survives mode changes."));
  fireEvent.click(screen.getByRole("button", { name: "Deck" }));
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(screen.getByRole("button", { name: /Restore Remount review/ }));
  await waitFor(() => expect(documentText()).toContain("Document body survives mode changes."));
});


test("the deck starters shortcut opens its assistant drawer on a phone", () => {
  const width = window.innerWidth;
  window.innerWidth = 390;
  try {
    render(<DocumentAssistantWorkspace data={sampleData} />);
    fireEvent.click(screen.getByRole("button", { name: "Deck" }));
    fireEvent.click(screen.getByRole("button", { name: "Deck starters & brand themes" }));
    expect(screen.getByRole("dialog", { name: "Assistant workflow" })).toBeInTheDocument();
    expect(screen.getByLabelText("Deck starter templates")).toBeInTheDocument();
  } finally { window.innerWidth = width; }
});


test("restoring an old account draft rebuilds pages and keeps page numbers outside its body", async () => {
  const paragraph = "This restored paragraph remains part of the paper. ".repeat(30);
  const body = `<span class="document-page-label">Page 6</span><h2>Page 4 — Launch vehicle</h2>${Array.from({length: 8}, () => `<p>${paragraph}</p>`).join("")}<p>See page 4 of the reference.</p>`;
  const saved = serverDraftSnapshot("old-pagination", "Archived paper", body, 1);
  installDraftsApiFetchMock({ list: () => jsonResponse([saved.document]), get: () => jsonResponse(saved) });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Archived paper/ }));
  await waitFor(() => expect(documentBody().querySelectorAll("section.document-page").length).toBeGreaterThan(1));
  expect(documentBody().querySelector(".document-page-label")).toBeNull();
  expect(documentText()).not.toContain("Page 6");
  expect(documentBody().querySelector("h2")).toHaveTextContent("Launch vehicle");
  expect(documentBody().querySelector("h2")).not.toHaveTextContent("Page 4");
  expect(documentText()).toContain("See page 4 of the reference.");
  const navigator = screen.getByRole("navigation", { name: /Page navigation/ });
  expect(documentBody()).not.toContainElement(navigator);
  expect(navigator).toHaveAttribute("aria-label", `Page navigation. Page 1 of ${documentBody().querySelectorAll("section.document-page").length}`);
});

test("restored explicit page breaks remain real boundaries without label text", async () => {
  const saved = serverDraftSnapshot("manual-pagination", "Manual breaks", "<p>First page.</p><hr class=\"document-page-break\"><p>Second page.</p>", 1);
  installDraftsApiFetchMock({ list: () => jsonResponse([saved.document]), get: () => jsonResponse(saved) });
  render(<DocumentAssistantWorkspace data={sampleData} />);
  fireEvent.click(screen.getByRole("button", { name: "Document history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Restore Manual breaks/ }));
  await waitFor(() => expect(documentBody().querySelectorAll("section.document-page")).toHaveLength(2));
  expect(documentBody().querySelectorAll("section.document-page")[1]).toHaveAttribute("data-page-break-before", "manual");
  expect(documentText()).toBe("First page.Second page.");
});
