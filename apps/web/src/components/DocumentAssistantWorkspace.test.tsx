import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { DocumentAssistantWorkspace } from "./DocumentAssistantWorkspace";
import { sampleData } from "../data/sampleData";

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

function installChatCompletionFetchMock(content: string | ((payload: Record<string, unknown>) => string)) {
  const requests: unknown[] = [];
  const fetchMock = globalThis.fetch as unknown as {
    mockImplementation: (implementation: typeof fetch) => void;
  };
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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

test("starts the draft chat clean until the user talks to the assistant", () => {
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  expect(screen.getByLabelText("Document title")).toHaveValue("Untitled Draft");
  expect(documentText()).toBe("");
  expect(screen.getByText("Blank draft ready")).toBeInTheDocument();
  expect(screen.getByText("Context sources off")).toBeInTheDocument();
  expect(screen.getByText(/web on · templates off/)).toBeInTheDocument();
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
  const contextStrip = screen.getByRole("region", { name: "Draft context" });
  expect(contextStrip).toHaveTextContent("Context sources off");
  expect(contextStrip).toHaveTextContent(/web on · templates off/);
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
  expect(screen.getByText(/Web search disabled for this draft/)).toBeInTheDocument();

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
  const contextStrip = screen.getByRole("region", { name: "Draft context" });
  expect(contextStrip).toHaveTextContent("Context sources off");
  expect(contextStrip).toHaveTextContent(/web off · templates off/);
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
  fireEvent.click(screen.getByRole("button", { name: "Draft history" }));
  expect(draftHistoryPanel()).toHaveTextContent("Drafting");

  firstWorkspace.unmount();
  render(
    <DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />,
  );

  expect(screen.getByLabelText("Document title")).toHaveValue("Untitled Draft");
  fireEvent.click(screen.getByRole("button", { name: "Draft history" }));
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
  expect(screen.getByText("Context sources off")).toBeInTheDocument();
  expect(screen.getByText(/3 available sources/)).toBeInTheDocument();

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
  expect(documentText()).toContain("Page 2 — Findings");
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

  fireEvent.click(screen.getByRole("button", { name: "Draft history" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Draft history" }));
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

test("persists the document drafting model selected from the editor topbar", () => {
  const data = dataWithApprovedDraftModel("openrouter-openai-gpt-4o-mini");
  const view = render(
    <DocumentAssistantWorkspace data={data} brandName="Aperture Chat" />,
  );

  const topbarModelSelector = screen.getByLabelText("Document drafting model");
  expect(topbarModelSelector).toHaveValue("agent-client-update");

  fireEvent.change(topbarModelSelector, {
    target: { value: "openrouter-openai-gpt-4o-mini" },
  });

  expect(
    screen.getByText(/OpenRouter: openai\/gpt-4o-mini selected for drafting/),
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

  expect(screen.getByLabelText("Document drafting model")).toHaveValue(
    "openrouter-openai-gpt-4o-mini",
  );
  expect(
    within(screen.getByLabelText("Document drafting model")).getByRole("option", {
      selected: true,
    }),
  ).toHaveTextContent(/OpenRouter: openai\/gpt-4o-mini/);
});

test("document drafting model selector includes connected platform-owner models", () => {
  const data = ownerPreviewDataWithApprovedDraftModel("openrouter-openai-gpt-4o-mini");
  render(
    <DocumentAssistantWorkspace data={data} brandName="Aperture Chat" />,
  );

  const options = Array.from(
    screen.getByLabelText("Document drafting model").querySelectorAll("option"),
  ).map((option) => option.textContent ?? "");

  expect(options).toContain("Client Update Agent · OpenRouter");
  expect(options).toContain("OpenRouter: openai/gpt-4o-mini · OpenRouter");
  expect(options).toContain("OpenAI: GPT-5.5 · OpenRouter");
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
    expect(pages[1].querySelector("h2")?.textContent).toBe("Page 1 — Introduction");
    expect(pages[2].querySelector("h2")?.textContent).toBe("Page 2 — Findings");

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
  expect(pages[0].querySelector(".document-page-label")?.textContent).toBe("Page 1");
  expect(pages[1].querySelector(".document-page-label")?.textContent).toBe("Page 2");
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
  fireEvent.click(screen.getByRole("button", { name: "Add citation" }));

  expect(documentBody().innerHTML).toContain("document-citation");
  expect(screen.getByText(/Citation 1 inserted/)).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Citation workspace" })).toBeInTheDocument();

  const inlineToolbarButton = screen.getByRole("button", { name: "Inline AI edit" });
  expect(fireEvent.mouseDown(inlineToolbarButton)).toBe(false);
  fireEvent.click(inlineToolbarButton);
  expect(screen.getByRole("dialog", { name: "Inline AI edit panel" })).toHaveTextContent(
    /Highlight text in the document before using inline AI edit/,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close inline AI edit" }));

  const selectedText = "The discovery deadline remains July 12, 2026.";
  selectEditorText(selectedText);
  fireEvent.mouseUp(documentBody());
  const contextualAiButton = await screen.findByRole("button", {
    name: "Ask AI to edit highlighted text",
  });
  fireEvent.click(contextualAiButton);
  expect(screen.getByRole("dialog", { name: "Inline AI edit panel" })).toHaveTextContent(
    selectedText,
  );
  fireEvent.click(screen.getByRole("button", { name: "Make it clearer" }));
  expect(screen.getByLabelText("Inline edit instruction")).toHaveValue("Make it clearer");
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

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
  fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
    target: { value: "Expand on the spaceship's journey." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

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
  fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
    target: { value: "Add the other estate documents as bullets." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

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
  fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
    target: { value: "Add the trust and pour-over will bullets." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

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
  fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
    target: { value: "Make this a realistic signature block." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

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
  fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
    target: { value: "Make this a realistic signature block." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

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
    fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
      target: { value: "Make it clearer." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

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
  expect(screen.getByRole("button", { name: "AI edit trail" })).toBeDisabled();

  selectEditorText("The original sentence is muddy.");
  fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
  fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
    target: { value: "Make it clearer." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

  await waitFor(() => {
    expect(documentText()).toContain("The revised sentence reads clearly.");
  });

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
  fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
    target: { value: "Tighten this bullet." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

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
  fireEvent.change(screen.getByLabelText("Inline edit instruction"), {
    target: { value: "Expand on the spacecraft's journey." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace highlight" }));

  expect(documentBody()).toHaveClass("is-ai-editing");
  expect(documentBody()).toHaveAttribute("aria-busy", "true");
  expect(deferredInlineEdit.requests).toHaveLength(1);

  deferredInlineEdit.resolve();

  await waitFor(() => {
    expect(documentText()).toContain("carefully plotted lunar trajectory");
  });
  expect(documentBody()).not.toHaveClass("is-ai-editing");
  expect(documentBody()).toHaveAttribute("aria-busy", "false");
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

  expect(screen.getByText(/Box source added to this draft context/)).toBeInTheDocument();
  expect(screen.getByLabelText("Workspace sources for this draft")).toBeInTheDocument();
  expect(screen.getByLabelText(/Box Matter Knowledge/)).toBeChecked();
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

  expect(screen.getByText(/supplemental-log.txt/)).toBeInTheDocument();
  expect(screen.getByText(/Attached 1 draft source/)).toBeInTheDocument();

  expect(screen.getByLabelText(/Litigation Playbook/)).not.toBeChecked();
  fireEvent.click(screen.getByLabelText(/Litigation Playbook/));
  expect(screen.getByLabelText(/Litigation Playbook/)).toBeChecked();
  expect(screen.getByText(/included in this draft context/)).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText(/Litigation Playbook/));
  expect(screen.getByLabelText(/Litigation Playbook/)).not.toBeChecked();
  expect(screen.getByText(/removed from this draft context/)).toBeInTheDocument();

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
  list?: () => Response;
  create?: (body: Record<string, unknown>) => Response;
  update?: (draftId: string, body: Record<string, unknown>) => Response;
  get?: (draftId: string) => Response;
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

  fireEvent.click(screen.getByRole("button", { name: "Draft history" }));
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

  fireEvent.click(screen.getByRole("button", { name: "Draft history" }));
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

  fireEvent.click(screen.getByRole("button", { name: "Draft history" }));
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

  fireEvent.click(screen.getByRole("button", { name: "Draft history" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Strikethrough" }));
  expect(editor.innerHTML).toContain("<s>Formatting</s>");

  selectEditorText("target");
  fireEvent.click(screen.getByRole("button", { name: "Highlight in amber" }));
  expect(editor.innerHTML).toMatch(/background-color:\s*(#fde68a|rgb\(253,\s*230,\s*138\))/);

  selectEditorText("text");
  // Sizes are labeled in Word points; 24pt renders as its preview-px twin.
  fireEvent.change(screen.getByLabelText("Text size"), { target: { value: "24" } });
  expect(editor.innerHTML).toContain("font-size: 35.4px");

  selectEditorText("text");
  fireEvent.change(screen.getByLabelText("Text font"), { target: { value: "georgia" } });
  expect(editor.innerHTML).toMatch(/font-family:\s*georgia/i);

  // Default resets the override instead of stacking another span.
  selectEditorText("text");
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

  fireEvent.change(screen.getByLabelText("Slide text size"), { target: { value: "28" } });
  expect(bullets.innerHTML).toContain("font-size: 28px");

  const li = bullets.querySelector("li")!;
  const sizedText = li.firstChild!;
  const range2 = document.createRange();
  range2.selectNodeContents(li);
  selection.removeAllRanges();
  selection.addRange(range2);
  void sizedText;
  fireEvent.change(screen.getByLabelText("Slide text font"), { target: { value: "times" } });
  expect(bullets.innerHTML).toMatch(/font-family:\s*(&quot;|['"])?times new roman/i);
});

test("paragraph alignment writes a real text-align the exports understand", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML = "<p>Centered summary line.</p>";
  fireEvent.input(editor);

  placeEditorCaretAtTextStart("Centered");
  fireEvent.click(screen.getByRole("button", { name: "Align center" }));
  expect(editor.innerHTML).toContain('text-align: center');
  expect(screen.getByRole("button", { name: "Align center" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  fireEvent.click(screen.getByRole("button", { name: "Align left" }));
  expect(editor.innerHTML).not.toContain("text-align");
});

test("the link tool applies a validated web address to highlighted text", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const editor = documentBody();
  editor.innerHTML = "<p>Read the annual report today.</p>";
  fireEvent.input(editor);

  selectEditorText("annual report");
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
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

  fireEvent.click(screen.getByRole("button", { name: "Link" }));
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
  expect(screen.getByText("Upload brand template")).toBeInTheDocument();
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


test("deck AI tools gate honestly: selection edit needs a highlight, images need a model", () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  switchToDeckMode();

  // Selection AI edit refuses to open without highlighted slide text.
  fireEvent.click(screen.getByRole("button", { name: "Edit selection with AI" }));
  expect(
    screen.getByText("Highlight slide text first, then ask the AI to change it."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Edit selection with AI" })).not.toBeInTheDocument();

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

  fireEvent.click(screen.getByRole("button", { name: "Edit selection with AI" }));
  const dialog = screen.getByRole("dialog", { name: "Edit selection with AI" });
  fireEvent.change(within(dialog).getByLabelText("AI edit instruction"), {
    target: { value: "Spell out the number" },
  });
  fireEvent.submit(dialog);

  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  const sent = requests[0] as { messages: Array<{ content: string }> };
  expect(sent.messages[0].content).toContain("Pipeline grew 30 percent");
  expect(sent.messages[0].content).toContain("Spell out the number");
  await waitFor(() =>
    expect(bullets.textContent).toContain("Pipeline expanded thirty percent"),
  );
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
  const dialog = screen.getByRole("dialog", { name: "Edit selection with AI" });
  expect(within(dialog).getByText("Quarterly revenue targets")).toBeInTheDocument();
  // Quick suggestion chips fill the instruction like the document editor.
  fireEvent.click(within(dialog).getByRole("button", { name: "Shorten it" }));
  expect(within(dialog).getByLabelText("AI edit instruction")).toHaveValue("Shorten it");
  // Cancel closes without touching the slide.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(
    screen.queryByRole("dialog", { name: "Edit selection with AI" }),
  ).not.toBeInTheDocument();
  expect(bullets.textContent).toContain("Quarterly revenue targets");
});
