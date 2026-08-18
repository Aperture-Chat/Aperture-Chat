import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { PlatformConsole } from "./components/PlatformConsole";
import { sampleData } from "./data/sampleData";

const CANNED = "Mocked compliance review: four key risks identified across the draft.";
const SESSION_STORAGE_KEY = "aperture-session-user-id";
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
let chatRequests: Array<Record<string, unknown>> = [];
let uploadRequests: Array<{
  name: string;
  type: string;
  tenantId: FormDataEntryValue | null;
}> = [];
let cloudListRequests: string[];
let cloudImportRequests: Array<Record<string, unknown>>;
let feedbackRequests: Array<Record<string, unknown>>;
let previewRequests: string[];
let assistantReply = CANNED;
let chatCompletionGate: Promise<void> | null = null;
let completionUsage: Record<string, number> = {};
let completionCitations: Array<Record<string, unknown>> = [];
let objectUrlSequence = 0;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(SESSION_STORAGE_KEY, "user-admin");
  chatRequests = [];
  uploadRequests = [];
  cloudListRequests = [];
  cloudImportRequests = [];
  feedbackRequests = [];
  previewRequests = [];
  assistantReply = CANNED;
  chatCompletionGate = null;
  completionUsage = {};
  completionCitations = [];
  objectUrlSequence = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:attachment-preview-${++objectUrlSequence}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/time")) {
        return new Response(
          JSON.stringify({
            iso: "2026-07-03T02:30:00+00:00",
            unix: 1783045800,
            timezone: "UTC",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/chat/feedback")) {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        feedbackRequests.push(body);
        return new Response(
          JSON.stringify({
            id: "feedback-server-1",
            tenant_id: "tenant-example",
            user_id: "user-admin",
            user_name: "Admin",
            thread_id: body.thread_id,
            thread_title: body.thread_title ?? "",
            message_id: body.message_id,
            rating: body.rating,
            comment: body.comment ?? "",
            message_preview: body.message_preview ?? "",
            model_id: body.model_id ?? "",
            created_at: "2026-07-03T02:30:00Z",
            updated_at: "2026-07-03T02:30:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/tools/") && url.endsWith("/approve")) {
        const configId = url.split("/api/tools/")[1].split("/")[0];
        return new Response(
          JSON.stringify({
            tool_config_id: configId,
            name: configId,
            approval_token: `approval-${configId}`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/chat/cloud-attachments/google-drive/items")) {
        const parsed = new URL(url, "http://aperture.test");
        cloudListRequests.push(parsed.searchParams.get("tenant_id") ?? "");
        return new Response(
          JSON.stringify([
            {
              id: "drive-policy-1",
              name: "Drive policy memo.txt",
              kind: "Text",
              item_type: "file",
              mime_type: "text/plain",
              size: "42 B",
              size_bytes: 42,
              source_type: "google-drive",
              source_uri: "gdrive://files/drive-policy-1",
              modified_at: "2026-07-03T12:00:00Z",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/chat/cloud-attachments/google-drive/attachments")) {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        cloudImportRequests.push(body);
        return new Response(
          JSON.stringify([
            {
              id: "cloud-drive-policy",
              tenant_id: "tenant-example",
              owner_user_id: "user-admin",
              name: "Drive policy memo.txt",
              size: "42 B",
              kind: "Text",
              mime_type: "text/plain",
              size_bytes: 42,
              source_type: "google-drive",
              source_uri: "gdrive://files/drive-policy-1",
              status: "attached",
              uploaded_at: "Now",
              text_preview: "Drive policy memo text.",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/chat\/attachments\/[^/]+\/preview$/.test(url)) {
        previewRequests.push(url);
        return new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        });
      }
      if (url.endsWith("/api/chat/attachments")) {
        const form = init?.body as FormData;
        const file = form.get("file");
        const name = file instanceof File ? file.name : "brief.pdf";
        const type = file instanceof File ? file.type : "application/pdf";
        const size = file instanceof File ? file.size : 11;
        const kind = type.startsWith("image/")
          ? "Image"
          : name.endsWith(".docx") || name.endsWith(".doc")
            ? "Word"
            : "PDF";
        uploadRequests.push({ name, type, tenantId: form.get("tenant_id") });
        return new Response(
          JSON.stringify({
            id: "upload-brief",
            tenant_id: "tenant-example",
            owner_user_id: "user-admin",
            name,
            size: "11 B",
            kind,
            mime_type: type,
            size_bytes: size,
            source_type: "upload",
            source_uri: "upload://upload-brief",
            status: "uploaded",
            uploaded_at: "Now",
            text_preview: kind === "Word" ? "Extracted scenario text from the Word document." : null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/chat/complete")) {
        let body: Record<string, unknown> = {};
        if (typeof init?.body === "string") {
          body = JSON.parse(init.body) as Record<string, unknown>;
          chatRequests.push(body);
        }
        // Mirrors the backend contract: a blocked/failed ad-hoc URL fails the
        // whole request explicitly before any model call.
        const fetchUrlList = Array.isArray(body.fetch_urls) ? (body.fetch_urls as string[]) : [];
        if (fetchUrlList.includes("https://blocked.example.com/page")) {
          return new Response(
            JSON.stringify({ detail: "The web page could not be fetched: the address is not allowed." }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          );
        }
        if (chatCompletionGate) {
          await chatCompletionGate;
        }
        const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
        return new Response(
          JSON.stringify({
            id: "test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: assistantReply },
              },
            ],
            citations: [
              ...(attachmentIds.length
                ? [
                    {
                      id: "cite-upload-brief",
                      source_name: "brief.pdf",
                      source_type: "upload",
                      source_uri: "upload://upload-brief",
                      snippet: "Uploaded PDF file (11 B) available to this chat turn.",
                    },
                  ]
                : []),
              ...completionCitations,
            ],
            model: "gpt-4o",
            usage: completionUsage,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Bootstrap (and anything else) fails so the app falls back to bundled sample data.
      return new Response("unavailable", { status: 500 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectUrl,
    });
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectUrl) {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

function readBlobText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read blob"));
    reader.readAsText(blob);
  });
}

/** A hand-driven SSE response: tests push deltas and completion markers one
 * at a time to observe the pending bubble between tokens. */
function stagedSseResponse() {
  const encoder = new TextEncoder();
  let pushChunk!: (event: string) => void;
  let closeStream!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      pushChunk = (event: string) => controller.enqueue(encoder.encode(event));
      closeStream = () => controller.close();
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    push: (event: string) => pushChunk(event),
    close: () => closeStream(),
  };
}

function stubSseChatFetch(sse: ReturnType<typeof stagedSseResponse>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/chat/complete")) return sse.response;
      // Bootstrap and everything else fails so the app uses bundled sample data.
      return new Response("unavailable", { status: 500 });
    }),
  );
}

/** Render the app and wait for the workspace shell: the session-restore
 * screen paints first while bootstrap data loads, so the sidebar is not
 * available synchronously after render. */
async function renderApp() {
  const view = render(<App />);
  await screen.findByRole("button", { name: "New chat" });
  return view;
}

function openChatHistorySection(name: "Folders" | "Pinned" | "Recent") {
  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  const chatsButton = within(sidebar).getByRole("button", { name: "Chats" });
  if (chatsButton.getAttribute("aria-expanded") !== "true") fireEvent.click(chatsButton);
  const sectionButton = within(sidebar).getByRole("button", { name });
  if (sectionButton.getAttribute("aria-expanded") !== "true") fireEvent.click(sectionButton);
  return sidebar;
}

test("real chat flow: send, render assistant reply, list in Recent, and persist", async () => {
  await renderApp();

  // No demo chats are seeded — Recent starts empty.
  const sidebar = openChatHistorySection("Recent");
  expect(await screen.findByText("No recent chats.")).toBeInTheDocument();

  // Start a fresh chat and type into the live composer.
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Is this policy compliant?" },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });

  // The user's message and the assistant reply both render in the conversation.
  expect(await screen.findByText(CANNED)).toBeInTheDocument();
  const conversation = document.querySelector(".message-list") as HTMLElement;
  expect(within(conversation).getByText("Is this policy compliant?")).toBeInTheDocument();

  // The new chat now appears in the sidebar, titled from the first message.
  expect(within(sidebar).getByText("Is this policy compliant?")).toBeInTheDocument();

  // The conversation is persisted to localStorage keyed by persona.
  await waitFor(() => {
    const raw = window.localStorage.getItem("aperture-chats-v2-user-admin");
    expect(raw).toContain(CANNED);
    expect(raw).toContain('"createdAtIso":"2026-07-03T02:30:00+00:00"');
  });
  expect(chatRequests[0].surface).toBe("chat");
  expect(chatRequests[0].client_started_at).toBe("2026-07-03T02:30:00+00:00");
});

test("the first completed exchange automatically receives a subject-based AI title", async () => {
  const requestOrder: string[] = [];
  const generatedTitleRequests: string[] = [];
  const observedRequests: string[] = [];
  let latestSavedThread: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      observedRequests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/api/time")) {
        return Response.json({
          iso: "2026-07-03T02:30:00+00:00",
          unix: 1783045800,
          timezone: "UTC",
        });
      }
      if (url.includes("/api/chat/complete")) {
        return Response.json({
          id: "test-subject-title",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Here is the Artemis II mission paper." },
            },
          ],
          citations: [],
          model: "gpt-4o-mini",
          usage: {},
        });
      }
      if (/\/api\/chat\/threads\/[^/?]+$/.test(url) && init?.method === "PUT") {
        requestOrder.push("save");
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        latestSavedThread = {
          ...body,
          id: url.split("/threads/")[1],
          tenant_id: "tenant-example",
          owner_user_id: "user-admin",
        };
        return Response.json(latestSavedThread);
      }
      if (url.includes("/title/generate") && init?.method === "POST") {
        requestOrder.push("generate");
        generatedTitleRequests.push(url);
        return Response.json({
          ...latestSavedThread,
          title: "Artemis II Mission Research Paper",
          updated_at: "Just now",
        });
      }
      return new Response("unavailable", { status: 500 });
    }),
  );

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: {
      value: "I would like you to create a 15-page paper on the Artemis II mission with astronaut biographies.",
    },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });

  await waitFor(() => {
    expect(generatedTitleRequests, observedRequests.join("\n")).toHaveLength(1);
  });
  expect(await screen.findByRole("heading", { name: "Artemis II Mission Research Paper" })).toBeInTheDocument();
  const sidebar = openChatHistorySection("Recent");
  expect(within(sidebar).getByText("Artemis II Mission Research Paper")).toBeInTheDocument();
  expect(requestOrder.at(-1)).toBe("generate");
  expect(generatedTitleRequests).toHaveLength(1);
  expect(generatedTitleRequests[0]).toContain(
    "expected_title=I%20would%20like%20you%20to%20create%20a",
  );
});

test("streams the reply into the pending bubble token by token", async () => {
  const sse = stagedSseResponse();
  stubSseChatFetch(sse);
  await renderApp();

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Stream a short answer." } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  // The first tokens render while the reply is still pending — below the
  // activity trace, which keeps working through its steps alongside the
  // streamed text.
  sse.push('data: {"delta":"Oak trees grow "}\n\n');
  expect(await screen.findByText(/Oak trees grow/)).toBeInTheDocument();
  expect(screen.getByText(/is working/)).toBeInTheDocument();
  expect(screen.getByText(/Streaming reply/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Stop this response" })).toBeInTheDocument();

  sse.push('data: {"delta":"slowly and live for centuries."}\n\n');
  expect(await screen.findByText(/live for centuries\./)).toBeInTheDocument();
  expect(screen.getByText(/Streaming reply/)).toBeInTheDocument();

  sse.push('data: {"done":true,"citations":[],"usage":null}\n\n');
  sse.push("data: [DONE]\n\n");
  sse.close();

  // Completion swaps the streaming chrome for the normal finished message.
  await waitFor(() => {
    expect(screen.queryByText(/Streaming reply/)).not.toBeInTheDocument();
  });
  expect(screen.getByText(/Oak trees grow slowly and live for centuries\./)).toBeInTheDocument();
});

test("a failed stream keeps the streamed text and shows a compact failure note", async () => {
  const sse = stagedSseResponse();
  stubSseChatFetch(sse);
  await renderApp();

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Stream a short answer." } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  sse.push('data: {"delta":"# Peptides\\n\\nGLP-1 drugs are only the beginning."}\n\n');
  await screen.findByText(/GLP-1 drugs are only the beginning\./);
  sse.push('data: {"error":"OpenRouter did not return a completion: HTTP 400","retryable":false}\n\n');
  sse.close();

  // The streamed text survives as rendered markdown (the heading proves it
  // is not one flat error paragraph) with the failure as a compact note.
  expect(
    await screen.findByText("OpenRouter did not return a completion: HTTP 400"),
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Peptides" })).toBeInTheDocument();
  expect(screen.getByText(/GLP-1 drugs are only the beginning\./)).toBeInTheDocument();
});

test("reloads a pending chat and continues the partial reply", async () => {
  assistantReply = "the rest of the draft.";
  window.localStorage.setItem(
    "aperture-chats-v2-user-admin",
    JSON.stringify([
      {
        id: "thread-resume-pending",
        tenant_id: "tenant-example",
        owner_user_id: "user-admin",
        title: "Artemis paper",
        model_id: "gpt-4o-mini",
        group_id: "group-litigation",
        pinned: false,
        archived: false,
        folder_id: null,
        used_agent: false,
        updated_at: "Just now",
        messages: [
          {
            id: "msg-user-resume",
            role: "user",
            content: "Write the Artemis paper",
            createdAt: "9:00 AM",
            status: "ok",
          },
          {
            id: "msg-assistant-resume",
            role: "assistant",
            content: "Partial draft already streamed.",
            createdAt: "9:00 AM",
            status: "pending",
            startedAtMs: Date.now() - 5000,
          },
        ],
      },
    ]),
  );

  await renderApp();

  await waitFor(() => {
    expect(
      chatRequests.some((body) => {
        const messages = body.messages as Array<{ role: string; content: string }> | undefined;
        return (
          Array.isArray(messages) &&
          messages.some((message) =>
            message.content.includes("Continue exactly where the previous answer stopped"),
          )
        );
      }),
    ).toBe(true);
  });

  const sidebar = openChatHistorySection("Recent");
  fireEvent.click(within(sidebar).getByText("Artemis paper"));
  expect(await screen.findByText(/Partial draft already streamed/)).toBeInTheDocument();
  expect(await screen.findByText(/the rest of the draft/)).toBeInTheDocument();
  expect(screen.queryByText(/interrupted before it finished/)).not.toBeInTheDocument();
});

test("Stream replies toggled off keeps the finished-only pending view and persists", async () => {
  const sse = stagedSseResponse();
  stubSseChatFetch(sse);
  await renderApp();

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await screen.findByLabelText("Message");
  fireEvent.click(screen.getByRole("button", { name: "Send options" }));
  const streamToggle = await screen.findByRole("checkbox", { name: "Stream replies" });
  expect(streamToggle).toBeChecked();
  fireEvent.click(streamToggle);
  expect(streamToggle).not.toBeChecked();
  expect(window.localStorage.getItem("aperture-live-stream-user-admin")).toBe("off");
  fireEvent.keyDown(document, { key: "Escape" });

  const textarea = screen.getByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Stream a short answer." } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  sse.push('data: {"delta":"Oak trees grow slowly."}\n\n');
  // Give the stream render throttle time to fire, then confirm the partial
  // text stays hidden while the preference is off.
  await new Promise((resolve) => setTimeout(resolve, 220));
  expect(screen.queryByText(/Oak trees grow slowly\./)).not.toBeInTheDocument();
  expect(screen.queryByText(/Streaming reply/)).not.toBeInTheDocument();

  sse.push('data: {"done":true,"citations":[],"usage":null}\n\n');
  sse.push("data: [DONE]\n\n");
  sse.close();

  expect(await screen.findByText(/Oak trees grow slowly\./)).toBeInTheDocument();
});

test("a long-form prompt stays on the user-selected model", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const modelSelector = await screen.findByRole("button", { name: "Select model" });
  expect(modelSelector).toHaveTextContent("Client Update Agent");

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Write a detailed multi-step report on the policy." },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });

  expect(await screen.findByText(CANNED)).toBeInTheDocument();
  await waitFor(() => {
    expect(chatRequests.at(-1)?.model).toBe("agent-client-update");
  });
  expect(modelSelector).toHaveTextContent("Client Update Agent");
});

test("the composer tucks the reasoning slider inside the send options menu", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  await screen.findByRole("button", { name: "Select model" });
  // Hidden until the send options dropdown opens.
  expect(screen.queryByLabelText("Model reasoning level")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Send options" }));
  const slider = await screen.findByLabelText("Model reasoning level");
  // Honest state: this persona's default model has no reasoning control, so
  // the slider stays disabled instead of pretending to work.
  expect(slider).toBeDisabled();

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByLabelText("Model reasoning level")).not.toBeInTheDocument();
  });
});

test("composer grows with the draft, caps its height, and shrinks when cleared", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  let measuredScrollHeight = 124;
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    get: () => measuredScrollHeight,
  });

  fireEvent.change(textarea, { target: { value: "Line one\nLine two\nLine three" } });
  await waitFor(() => expect(textarea.style.height).toBe("124px"));
  expect(textarea.style.overflowY).toBe("hidden");

  measuredScrollHeight = 240;
  fireEvent.change(textarea, {
    target: { value: "A long prompt that needs more room but should not take over the conversation." },
  });
  await waitFor(() => expect(textarea.style.height).toBe("172px"));
  expect(textarea.style.overflowY).toBe("auto");

  measuredScrollHeight = 76;
  fireEvent.change(textarea, { target: { value: "" } });
  await waitFor(() => expect(textarea.style.height).toBe("76px"));
  expect(textarea.style.overflowY).toBe("hidden");
});

test("session details panel reports provider token usage and gathered sources", async () => {
  completionUsage = {
    prompt_tokens: 119,
    completion_tokens: 26,
    total_tokens: 145,
  };
  completionCitations = [
    {
      id: "cite-web-python",
      source_name: "Python.org release notes",
      source_type: "web",
      source_uri: "https://www.python.org/downloads/",
      snippet: "Python release listing.",
    },
  ];

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "What is the latest Python release?" },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Session info" }));
  const panel = document.querySelector(".session-panel") as HTMLElement;
  expect(within(panel).getByText("Tokens used")).toBeInTheDocument();
  expect(within(panel).getByText("119 in · 26 out")).toBeInTheDocument();
  expect(within(panel).getByText("145 total")).toBeInTheDocument();
  expect(within(panel).getByText("Context window")).toBeInTheDocument();
  expect(within(panel).getByText("Context window healthy")).toBeInTheDocument();
  expect(within(panel).getByText("145 of 128,000 tokens used")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Context window healthy: <1% used/i })).toBeInTheDocument();
  expect(within(panel).queryByText("Sources gathered")).not.toBeInTheDocument();

  const conversation = document.querySelector(".message-list") as HTMLElement;
  expect(within(conversation).queryByText("Python release listing.")).not.toBeInTheDocument();
  expect(within(conversation).queryByText("1 citation available")).not.toBeInTheDocument();
  expect(conversation.querySelector(".source-chip")).toBeNull();
  fireEvent.click(within(conversation).getByRole("button", { name: /View 1 citation/i }));
  expect(within(panel).getByText("Sources gathered")).toBeInTheDocument();
  expect(within(panel).getByText("Selected response · 1")).toBeInTheDocument();
  const sourceLink = within(panel).getByRole("link", {
    name: "Python.org release notes",
  });
  expect(sourceLink).toHaveAttribute("href", "https://www.python.org/downloads/");
  expect(within(panel).getByText("python.org")).toBeInTheDocument();
  expect(within(panel).getByText("Python release listing.")).toBeInTheDocument();
});

test("citation controls prioritize the clicked response and expand hidden sources", async () => {
  const citationSet = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index + 1}`,
      source_name: `${prefix} source ${index + 1}`,
      source_type: "web",
      source_uri: `https://example.com/${prefix}/${index + 1}`,
      snippet: `${prefix} snippet ${index + 1}.`,
    }));

  completionCitations = citationSet("first", 8);
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "First cited question" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  completionCitations = citationSet("second", 10);
  const followUpTextarea = screen.getByLabelText("Message");
  fireEvent.change(followUpTextarea, {
    target: { value: "Second cited question" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(chatRequests).toHaveLength(2));

  const conversation = document.querySelector(".message-list") as HTMLElement;
  const citationButtons = within(conversation).getAllByRole("button", {
    name: /View \d+ citations/i,
  });
  expect(citationButtons).toHaveLength(2);
  fireEvent.click(citationButtons[1]);

  const panel = document.querySelector(".session-panel") as HTMLElement;
  expect(within(panel).getByText("Selected response · 10")).toBeInTheDocument();
  expect(within(panel).getByText("second source 1")).toBeInTheDocument();
  expect(within(panel).queryByText("second source 10")).not.toBeInTheDocument();
  fireEvent.click(
    within(panel).getByRole("button", {
      name: "Show 4 more cited in this response",
    }),
  );
  expect(within(panel).getByText("second source 10")).toBeInTheDocument();

  fireEvent.click(citationButtons[0]);
  expect(within(panel).getByText("Selected response · 8")).toBeInTheDocument();
  const panelText = panel.textContent ?? "";
  expect(panelText.indexOf("first source 1")).toBeGreaterThanOrEqual(0);
  expect(panelText.indexOf("second source 1")).toBeGreaterThanOrEqual(0);
  expect(panelText.indexOf("first source 1")).toBeLessThan(panelText.indexOf("second source 1"));
});

test("session details panel labels the estimate when the provider reports no usage", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Is this policy compliant?" },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Session info" }));
  const panel = document.querySelector(".session-panel") as HTMLElement;
  // Token totals stay strictly provider-reported; only the context meter
  // falls back to a clearly labeled length-based estimate.
  expect(within(panel).getByText("Not reported by the provider")).toBeInTheDocument();
  expect(within(panel).getByText("Context window healthy (estimated)")).toBeInTheDocument();
  expect(within(panel).getByText(/tokens used \(estimated\)/)).toBeInTheDocument();
  expect(
    within(panel).getByText(/Estimated from this chat's message length/),
  ).toBeInTheDocument();
  const contextButton = screen.getByRole("button", {
    name: /Context window healthy \(estimated\)/i,
  });
  expect(contextButton).toHaveClass("is-safe");
  expect(contextButton).toHaveClass("has-context-progress");
  expect(contextButton.querySelector(".context-window-ring")).toHaveTextContent("<1%");
  expect(within(panel).queryByText("Sources gathered")).not.toBeInTheDocument();
});

test("empty chats show no context usage until there is something to measure", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const contextButton = screen.getByRole("button", {
    name: /Context window not reported/i,
  });
  expect(contextButton).toHaveClass("is-unknown");
  expect(contextButton).toHaveClass("is-empty");
  expect(contextButton.querySelector(".context-window-ring")).toHaveTextContent("");
});

test("context window meter warns without blocking when reported usage reaches the model limit", async () => {
  completionUsage = {
    prompt_tokens: 110000,
    completion_tokens: 20000,
    total_tokens: 130000,
  };

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Summarize the whole matter file." },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  expect(
    screen.getByText("Context window full. This session may stop using earlier details reliably."),
  ).toBeInTheDocument();
  const contextButton = screen.getByRole("button", {
    name: /Context window full: 100% used/i,
  });
  expect(contextButton).toHaveClass("is-full");

  fireEvent.click(contextButton);
  const panel = document.querySelector(".session-panel") as HTMLElement;
  expect(within(panel).getByText("Context window full")).toBeInTheDocument();
  expect(within(panel).getByText("130,000 of 128,000 tokens used")).toBeInTheDocument();
  expect(within(panel).getByRole("meter", { name: "Context window full" })).toHaveAttribute("aria-valuenow", "100");
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Can I still ask a follow-up?" },
  });
  expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled();
});

test("an approaching context window shows an early warning without blocking the composer", async () => {
  completionUsage = {
    prompt_tokens: 100000,
    completion_tokens: 8000,
    total_tokens: 108000,
  };

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Summarize the whole matter file." },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  // 108,000 of 128,000 tokens = 84%: warned early, never blocked.
  expect(
    screen.getByText(
      "Context window 84% used. You can keep chatting — start a new chat when you want a fresh window with full attention on the details.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Context window full. This session may stop using earlier details reliably."),
  ).not.toBeInTheDocument();
  const contextButton = screen.getByRole("button", {
    name: /Context window getting full: 84% used/i,
  });
  expect(contextButton).toHaveClass("is-danger");
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Can I still ask a follow-up?" },
  });
  expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled();
});

test("a failed turn's error text is never resent as assistant history", async () => {
  const followUpRequests: Array<Record<string, unknown>> = [];
  let failNextCompletion = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/chat/complete")) {
        if (typeof init?.body === "string") {
          followUpRequests.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        if (failNextCompletion) {
          failNextCompletion = false;
          return new Response(
            'data: {"error":"OpenRouter did not return a completion: HTTP 400","retryable":false}\n\n',
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "test",
            choices: [{ index: 0, message: { role: "assistant", content: CANNED } }],
            citations: [],
            model: "gpt-4o",
            usage: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unavailable", { status: 500 });
    }),
  );
  await renderApp();

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "hi" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(
    await screen.findByText("OpenRouter did not return a completion: HTTP 400"),
  ).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "write me a 1000 word story on the odyssey" },
  });
  fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  const resentMessages = followUpRequests.at(-1)?.messages as Array<{
    role: string;
    content: string;
  }>;
  // The failed attempt carried no model output, so the follow-up history
  // holds only the real user turns — never the stored error text.
  expect(resentMessages.map((message) => message.role)).toEqual(["user", "user"]);
  expect(JSON.stringify(resentMessages)).not.toContain("did not return a completion");
});

test("context window meter uses the latest reported request instead of cumulative token spend", async () => {
  completionUsage = {
    prompt_tokens: 81000,
    completion_tokens: 9000,
    total_tokens: 90000,
  };

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "First long question." } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  completionUsage = {
    prompt_tokens: 45000,
    completion_tokens: 5000,
    total_tokens: 50000,
  };
  const followUpTextarea = screen.getByLabelText("Message");
  fireEvent.change(followUpTextarea, {
    target: { value: "Second shorter follow-up." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(chatRequests).toHaveLength(2));

  expect(
    screen.queryByText("Context window full. This session may stop using earlier details reliably."),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Context window healthy: 39% used/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Session info" }));
  const panel = document.querySelector(".session-panel") as HTMLElement;
  expect(within(panel).getByText("140,000 total")).toBeInTheDocument();
  expect(within(panel).getByText("50,000 of 128,000 tokens used")).toBeInTheDocument();
});

test("session summary tools row reflects the chat's active tools", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Session info" }));
  const panel = document.querySelector(".session-panel") as HTMLElement;
  const toolsRow = () => within(panel).getByText("Tools").closest(".audit-row") as HTMLElement;

  // Web search is on by default, so it counts as an active tool.
  expect(within(toolsRow()).getByText("Web search")).toBeInTheDocument();
  expect(within(toolsRow()).getByText("1 on")).toBeInTheDocument();

  const composer = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(composer).getByRole("button", { name: "Send options" }));
  fireEvent.click(
    within(composer).getByRole("menuitemcheckbox", {
      name: "Agent Use enabled tools for this reply.",
    }),
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(within(toolsRow()).getByText("Web search, Agent")).toBeInTheDocument();
  expect(within(toolsRow()).getByText("2 on")).toBeInTheDocument();

  fireEvent.click(within(composer).getByRole("button", { name: "Turn off active tools" }));
  expect(within(toolsRow()).getByText("None on for this chat")).toBeInTheDocument();
  expect(within(toolsRow()).getByText("Off")).toBeInTheDocument();
});

test("assistant message actions copy readable text and branch response context", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  assistantReply = `## Formatted Result

**Plain language:** [Read this source](https://example.com/source).

| Topic | Status |
|---|---|
| Copy behavior | Should be readable |`;

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Explain formatted copy" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  expect(await screen.findByText("Formatted Result")).toBeInTheDocument();
  const conversation = document.querySelector(".message-list") as HTMLElement;

  fireEvent.click(within(conversation).getByRole("button", { name: "Copy response text" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  const copied = String(writeText.mock.calls[0][0]);
  expect(copied).toContain("Formatted Result");
  expect(copied).toContain("Plain language:");
  expect(copied).toContain("Read this source https://example.com/source");
  expect(copied).toContain("Copy behavior Should be readable");
  expect(copied).not.toContain("**");
  expect(copied).not.toContain("|---|");

  fireEvent.click(
    within(conversation).getByRole("button", {
      name: "Branch response into new chat",
    }),
  );

  expect(
    await screen.findByRole("heading", {
      name: "Branch: Explain formatted copy",
    }),
  ).toBeInTheDocument();
  const branchConversation = document.querySelector(".message-list") as HTMLElement;
  expect(within(branchConversation).getByText("Explain formatted copy")).toBeInTheDocument();
  expect(within(branchConversation).getByText("Formatted Result")).toBeInTheDocument();
});

test("assistant response copy writes rich html plus plain text when supported", async () => {
  class MockClipboardItem {
    items: Record<string, Blob>;

    constructor(items: Record<string, Blob>) {
      this.items = items;
    }
  }
  vi.stubGlobal("ClipboardItem", MockClipboardItem);
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { write },
  });
  assistantReply = `## Rich Result

**Plain language:** [Read this source](https://example.com/source).

![Demo chart](https://example.com/chart.png "Demo chart")

| Topic | Status |
|---|---|
| Copy behavior | Keeps formatting |`;

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Explain rich copy" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  expect(await screen.findByText("Rich Result")).toBeInTheDocument();
  const conversation = document.querySelector(".message-list") as HTMLElement;

  fireEvent.click(within(conversation).getByRole("button", { name: "Copy response text" }));

  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  const item = write.mock.calls[0][0][0] as MockClipboardItem;
  const html = await readBlobText(item.items["text/html"]);
  const plain = await readBlobText(item.items["text/plain"]);

  expect(html).toContain("<strong>Plain language:</strong>");
  expect(html).toContain('<a href="https://example.com/source"');
  expect(html).toContain("<img");
  expect(html).toContain('src="https://example.com/chart.png"');
  expect(html).toContain("<table");
  expect(html).not.toContain("**");
  expect(html).not.toContain("|---|");
  expect(plain).toContain("Rich Result");
  expect(plain).toContain("Read this source https://example.com/source");
  expect(plain).toContain("[Image: Demo chart] https://example.com/chart.png");
  expect(plain).not.toContain("**");
  expect(await within(conversation).findByRole("status")).toHaveTextContent("Copied");
});

test("assistant response copy falls back to plain text when rich clipboard writes are blocked", async () => {
  class MockClipboardItem {
    items: Record<string, Blob>;

    constructor(items: Record<string, Blob>) {
      this.items = items;
    }
  }
  vi.stubGlobal("ClipboardItem", MockClipboardItem);
  const write = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { write, writeText },
  });
  const documentWithMutableCommand = document as Document & { execCommand?: Document["execCommand"] };
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => false),
  });
  assistantReply = `**Plain output** with [Source](https://example.com/source).

| Item | Value |
|---|---|
| Copy | Plain text |`;

  try {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    const textarea = await screen.findByLabelText("Message");
    fireEvent.change(textarea, { target: { value: "Copy this response" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(await screen.findByText("Plain output")).toBeInTheDocument();
    const conversation = document.querySelector(".message-list") as HTMLElement;

    fireEvent.click(within(conversation).getByRole("button", { name: "Copy response text" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledTimes(1);
    const copiedViaFallback = String(writeText.mock.calls[0][0]);
    expect(copiedViaFallback).toContain("Plain output");
    expect(copiedViaFallback).toContain("Source https://example.com/source");
    expect(copiedViaFallback).toContain("Copy Plain text");
    expect(copiedViaFallback).not.toContain("**");
    expect(copiedViaFallback).not.toContain("|---|");
    expect(await within(conversation).findByRole("status")).toHaveTextContent("Copied");
  } finally {
    if (originalExecCommand) {
      Object.defineProperty(document, "execCommand", originalExecCommand);
    } else {
      delete documentWithMutableCommand.execCommand;
    }
  }
});

test("assistant response can be regenerated from the same prompt", async () => {
  assistantReply = "Version one response.";

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Draft a better answer" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  expect(await screen.findByText("Version one response.")).toBeInTheDocument();
  expect(chatRequests).toHaveLength(1);

  assistantReply = "Version two response.";
  const conversation = document.querySelector(".message-list") as HTMLElement;
  fireEvent.click(within(conversation).getByRole("button", { name: "Regenerate response" }));

  await waitFor(() => expect(chatRequests).toHaveLength(2));
  const regenerateMessages = chatRequests.at(-1)?.messages as Array<{
    role: string;
    content: string;
  }>;
  expect(regenerateMessages[0]).toEqual(
    expect.objectContaining({
      role: "system",
      content: expect.stringContaining("quality floor"),
    }),
  );
  expect(regenerateMessages.at(-1)).toEqual({
    role: "user",
    content: "Draft a better answer",
  });
  expect(await screen.findByText("Version two response.")).toBeInTheDocument();
  expect(within(conversation).queryByText("Version one response.")).not.toBeInTheDocument();
  expect(within(conversation).getAllByText("Draft a better answer")).toHaveLength(1);
  expect(document.querySelectorAll(".message-list > .message")).toHaveLength(2);
  expect(within(conversation).getByText("2 / 2")).toBeInTheDocument();

  fireEvent.click(
    within(conversation).getByRole("button", {
      name: "Previous response version",
    }),
  );
  expect(await screen.findByText("Version one response.")).toBeInTheDocument();
  expect(within(conversation).queryByText("Version two response.")).not.toBeInTheDocument();
  expect(within(conversation).getByText("1 / 2")).toBeInTheDocument();

  fireEvent.click(within(conversation).getByRole("button", { name: "Next response version" }));
  expect(await screen.findByText("Version two response.")).toBeInTheDocument();
  expect(within(conversation).queryByText("Version one response.")).not.toBeInTheDocument();
});

test("assistant response feedback persists into platform owner analytics", async () => {
  assistantReply = "Feedback target response with a useful but imperfect answer.";

  const appView = await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Rate this response" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  expect(await screen.findByText(assistantReply)).toBeInTheDocument();
  const conversation = document.querySelector(".message-list") as HTMLElement;
  fireEvent.click(
    within(conversation).getByRole("button", {
      name: "Send negative feedback",
    }),
  );

  await waitFor(() => {
    expect(window.localStorage.getItem("aperture-chat-feedback-v1")).toContain('"rating":"negative"');
  });
  // The rating reaches the server immediately, before any note is written.
  await waitFor(() => {
    expect(feedbackRequests).toHaveLength(1);
  });
  expect(feedbackRequests[0]).toMatchObject({ rating: "negative" });
  expect(feedbackRequests[0]).not.toHaveProperty("comment");

  // Every thumb click offers an optional written note.
  const noteField = within(conversation).getByPlaceholderText("What went wrong? Add a note (optional)");
  fireEvent.change(noteField, { target: { value: "It cited the wrong clause." } });
  fireEvent.click(within(conversation).getByRole("button", { name: "Send note" }));
  await waitFor(() => {
    expect(feedbackRequests).toHaveLength(2);
  });
  expect(feedbackRequests[1]).toMatchObject({
    rating: "negative",
    comment: "It cited the wrong clause.",
  });
  // Sending the note closes the composer.
  expect(
    within(conversation).queryByPlaceholderText("What went wrong? Add a note (optional)"),
  ).not.toBeInTheDocument();

  appView.unmount();
  const owner = sampleData.users.find((user) => user.role === "PLATFORM_OWNER") ?? sampleData.me;
  render(
    <PlatformConsole
      data={{ ...sampleData, me: owner, visibleUsers: sampleData.users }}
      onDataChange={(updater) => {
        void updater;
      }}
    />,
  );
  const analyticsTab = await screen.findByRole("tab", { name: "Analytics" });
  fireEvent.mouseDown(analyticsTab, { button: 0, ctrlKey: false });
  fireEvent.click(analyticsTab);

  expect(await screen.findByText("Chat Feedback")).toBeInTheDocument();
  const feedbackPanel = screen.getByRole("heading", { name: "Chat Feedback" }).closest(".panel") as HTMLElement;
  const expandButton = within(feedbackPanel).queryByRole("button", { name: "Expand panel" });
  if (expandButton) fireEvent.click(expandButton);
  expect(screen.getByText("Negative sentiment")).toBeInTheDocument();
  expect(screen.getByText(assistantReply)).toBeInTheDocument();
});

test("a created chat can be pinned and unpinned from the sidebar", async () => {
  await renderApp();

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Draft an NDA summary" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  await screen.findByText(CANNED);

  const sidebar = openChatHistorySection("Recent");
  fireEvent.click(within(sidebar).getByRole("button", { name: "Pin chat" }));

  // Pinning flips the affordance and moves the chat into the Pinned section.
  openChatHistorySection("Pinned");
  expect(within(sidebar).getByRole("button", { name: "Unpin chat" })).toBeInTheDocument();
  expect(within(sidebar).getByText("Draft an NDA summary")).toBeInTheDocument();

  // Pin state survives a reload (persisted to localStorage).
  await waitFor(() => {
    const raw = window.localStorage.getItem("aperture-chats-v2-user-admin");
    expect(raw).toContain('"pinned":true');
  });

  // Unpinning returns the Pin affordance.
  fireEvent.click(within(sidebar).getByRole("button", { name: "Unpin chat" }));
  expect(within(sidebar).getByRole("button", { name: "Pin chat" })).toBeInTheDocument();
});

test("attaching a file shows a removable chip and rides along in the sent message", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["dummy-bytes"], "brief.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(fileInput, { target: { files: [file] } });

  // The attachment chip appears in the composer with a remove control.
  expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove brief.pdf" })).toBeInTheDocument();

  // Send and confirm the file renders inside the user message.
  const textarea = screen.getByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Please review" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  await waitFor(() => expect(uploadRequests).toHaveLength(1));
  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect(await screen.findByText(CANNED)).toBeInTheDocument();
  const conversation = document.querySelector(".message-list") as HTMLElement;
  expect(within(conversation).getByText("brief.pdf")).toBeInTheDocument();
  expect(within(conversation).queryByText("[1] brief.pdf")).not.toBeInTheDocument();
  expect(
    within(conversation).queryByText("Uploaded PDF file (11 B) available to this chat turn."),
  ).not.toBeInTheDocument();
  fireEvent.click(within(conversation).getByRole("button", { name: /View 1 citation/i }));
  const panel = document.querySelector(".session-panel") as HTMLElement;
  expect(within(panel).getByText("Sources gathered")).toBeInTheDocument();
  expect(within(panel).getByText("Selected response · 1")).toBeInTheDocument();
  expect(within(panel).getByText("brief.pdf")).toBeInTheDocument();
  expect(within(panel).getByText("Uploaded PDF file (11 B) available to this chat turn.")).toBeInTheDocument();
  expect(uploadRequests).toEqual([{ name: "brief.pdf", type: "application/pdf", tenantId: "tenant-example" }]);
  expect(chatRequests.at(-1)?.attachment_ids).toEqual(["upload-brief"]);
  expect(chatRequests.at(-1)?.attachment_names).toEqual(["brief.pdf"]);
});

test("user messages render the signed-in profile photo with initials as the fallback", async () => {
  const originalAvatarUrl = sampleData.me.avatar_url;
  const fallbackUser = sampleData.users.find((user) => user.id === "user-admin");
  const originalFallbackAvatarUrl = fallbackUser?.avatar_url;
  const profileUrl = "https://images.example.test/alex-morgan-profile.png";
  sampleData.me.avatar_url = profileUrl;
  if (fallbackUser) fallbackUser.avatar_url = profileUrl;
  try {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    const textarea = await screen.findByLabelText("Message");
    fireEvent.change(textarea, { target: { value: "Show my profile photo beside this prompt" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(await screen.findByText(CANNED)).toBeInTheDocument();
    const conversation = document.querySelector(".message-list") as HTMLElement;
    const prompt = within(conversation)
      .getByText("Show my profile photo beside this prompt")
      .closest("article");
    const avatar = prompt?.querySelector(".user-message-avatar img") as HTMLImageElement | null;
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("src")).toBe(sampleData.me.avatar_url);
    expect(prompt?.querySelector(".user-message-avatar")?.textContent).not.toContain("AM");
  } finally {
    sampleData.me.avatar_url = originalAvatarUrl;
    if (fallbackUser) fallbackUser.avatar_url = originalFallbackAvatarUrl;
  }
});

test("image attachments render a thumbnail and a viewport-level hover or focus preview", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["jpeg-bytes"], "IMG_2833.jpeg", { type: "image/jpeg" });
  fireEvent.change(fileInput, { target: { files: [file] } });

  const textarea = screen.getByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Preview this image" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  expect(await screen.findByText(CANNED)).toBeInTheDocument();
  const conversation = document.querySelector(".message-list") as HTMLElement;
  const chip = within(conversation).getByText("IMG_2833.jpeg").closest(".file-chip") as HTMLElement;
  await waitFor(() => {
    expect(chip.querySelector(".file-image-thumbnail img")).not.toBeNull();
  });
  expect(chip.querySelector(".file-icon")).toBeNull();
  expect(previewRequests.some((url) => url.endsWith("/api/chat/attachments/upload-brief/preview"))).toBe(true);

  fireEvent.pointerEnter(chip);
  expect(await screen.findByRole("img", { name: "Preview of IMG_2833.jpeg" })).toBeInTheDocument();
  expect(document.querySelector("body > .attachment-image-preview")).not.toBeNull();
  fireEvent.pointerLeave(chip);
  await waitFor(() => {
    expect(screen.queryByRole("img", { name: "Preview of IMG_2833.jpeg" })).not.toBeInTheDocument();
  });

  fireEvent.focus(chip);
  expect(await screen.findByRole("img", { name: "Preview of IMG_2833.jpeg" })).toBeInTheDocument();
  fireEvent.keyDown(chip, { key: "Escape" });
  expect(screen.queryByRole("img", { name: "Preview of IMG_2833.jpeg" })).not.toBeInTheDocument();
});

test("google drive picker imports selected files into the chat composer", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composer = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(composer).getByRole("button", { name: "Add attachment" }));
  fireEvent.click(within(composer).getByRole("menuitem", { name: "Google Drive" }));

  const dialog = await screen.findByRole("dialog", {
    name: "Choose from Google Drive",
  });
  expect(await within(dialog).findByText("Drive policy memo.txt")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("option", { name: /Drive policy memo.txt/i }));
  fireEvent.click(within(dialog).getByRole("button", { name: /Attach selected \(1\)/i }));

  await waitFor(() => expect(cloudImportRequests).toHaveLength(1));
  expect(await screen.findByRole("button", { name: "Remove Drive policy memo.txt" })).toBeInTheDocument();
  expect(uploadRequests).toHaveLength(0);
  expect(cloudListRequests).toEqual(["tenant-example"]);
  expect(cloudImportRequests).toEqual([{ item_ids: ["drive-policy-1"], tenant_id: "tenant-example" }]);

  const textarea = screen.getByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Summarize the Drive memo" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect(chatRequests.at(-1)?.attachment_ids).toEqual(["cloud-drive-policy"]);
  expect(chatRequests.at(-1)?.attachment_names).toEqual(["Drive policy memo.txt"]);
});

test("text-only user prompt keeps new-chat action without clipboard copy", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Copy this prompt only" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  const conversation = document.querySelector(".message-list") as HTMLElement;
  const promptMessage = within(conversation).getByText("Copy this prompt only").closest(".message") as HTMLElement;

  expect(within(promptMessage).queryByRole("button", { name: "Copy prompt" })).not.toBeInTheDocument();
  expect(
    within(promptMessage).getByRole("button", {
      name: "Load prompt in new chat",
    }),
  ).toBeInTheDocument();
});

test("document prompt hides copy action but can stage into a new session", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["docx-bytes"], "scenario-matrix.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  fireEvent.change(fileInput, { target: { files: [file] } });
  expect(await screen.findByText("scenario-matrix.docx")).toBeInTheDocument();

  const textarea = screen.getByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Review this scenario matrix" },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  const conversation = document.querySelector(".message-list") as HTMLElement;
  const promptMessage = within(conversation)
    .getByText("Review this scenario matrix")
    .closest(".message") as HTMLElement;

  expect(within(promptMessage).queryByRole("button", { name: "Copy prompt" })).not.toBeInTheDocument();

  fireEvent.click(
    within(promptMessage).getByRole("button", {
      name: "Load prompt in new chat",
    }),
  );

  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Review this scenario matrix"));
  expect(chatRequests).toHaveLength(1);
  expect(await screen.findByRole("heading", { name: /Good (morning|afternoon|evening), |Burning the midnight oil, / })).toBeInTheDocument();
  expect(screen.getByText("scenario-matrix.docx")).toBeInTheDocument();

  const stagedComposer = screen.getByLabelText("Message");
  fireEvent.change(stagedComposer, {
    target: { value: "Review this scenario matrix with valuation sensitivity" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(chatRequests).toHaveLength(2));
  expect(uploadRequests).toHaveLength(1);
  const stagedRequest = chatRequests.at(-1);
  const stagedMessages = stagedRequest?.messages as Array<{
    role: string;
    content: string;
  }>;
  expect(stagedMessages).toEqual([
    {
      role: "user",
      content: "Review this scenario matrix with valuation sensitivity\n\n[Attached files: scenario-matrix.docx]",
    },
  ]);
  expect(stagedRequest?.attachment_ids).toEqual(["upload-brief"]);
  expect(stagedRequest?.attachment_names).toEqual(["scenario-matrix.docx"]);
  const stagedConversation = document.querySelector(".message-list") as HTMLElement;
  expect(
    within(stagedConversation).getByText("Review this scenario matrix with valuation sensitivity"),
  ).toBeInTheDocument();
  expect(within(stagedConversation).queryByText("Review this scenario matrix")).not.toBeInTheDocument();
});

test("use in chat from Agents sends the selected agent profile runtime", async () => {
  await renderApp();

  openChatHistorySection("Recent");
  expect(await screen.findByText("No recent chats.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Agents/Automations" }));

  const profileCard = (await screen.findByText("Client Update Agent")).closest(".agent-profile-card");
  expect(profileCard).not.toBeNull();
  fireEvent.click(within(profileCard as HTMLElement).getByRole("button", { name: "Chat" }));

  const composer = await screen.findByLabelText("Message");
  fireEvent.change(composer, {
    target: { value: "Check the connected matter files." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  const approvalPanel = (await screen.findByText("Approve MCP tool run?")).closest(
    ".composer-approval-request",
  ) as HTMLElement;
  expect(within(approvalPanel).getByText(/Hermes Agent MCP/)).toBeInTheDocument();
  expect(chatRequests).toHaveLength(0);
  fireEvent.click(within(approvalPanel).getByRole("button", { name: "Approve" }));

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect(chatRequests[0]).toMatchObject({
    model: "agent-client-update",
    agent_enabled: true,
    agent_profile_id: "agent-client-update",
  });
  expect(chatRequests[0].knowledge_config_ids).toEqual(["kb-litigation-playbook", "kb-box-matter"]);
  expect(chatRequests[0].tool_config_ids).toEqual([
    "tool-agent-workflow",
    "tool-hermes-agent-mcp",
    "tool-template-prompts",
    "tool-skill-library",
  ]);
  expect(chatRequests[0].approved_tool_config_ids).toEqual(["tool-hermes-agent-mcp"]);
  // Approval is proven to the backend with a signed token fetched on approve.
  expect(chatRequests[0].approval_tokens).toEqual(["approval-tool-hermes-agent-mcp"]);
});

test("denying approval-required MCP tools prevents the chat API call", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composerShell = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(composerShell).getByRole("button", { name: "Send options" }));
  fireEvent.click(
    within(composerShell).getByRole("menuitemcheckbox", {
      name: "Agent Use enabled tools for this reply.",
    }),
  );

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Use the agent tools only if approved." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  const approvalPanel = (await screen.findByText("Approve MCP tool run?")).closest(
    ".composer-approval-request",
  ) as HTMLElement;
  expect(chatRequests).toHaveLength(0);
  fireEvent.click(within(approvalPanel).getByRole("button", { name: "Deny" }));

  expect(screen.getByText("MCP tool run denied. No message was sent.")).toBeInTheDocument();
  expect(chatRequests).toHaveLength(0);
});

test("composer runtime toggles are sent to the chat API", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composer = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(composer).getByRole("button", { name: "Send options" }));
  fireEvent.click(
    within(composer).getByRole("menuitemcheckbox", {
      name: "Knowledge Use connected workspace sources.",
    }),
  );
  // Web search defaults on for OpenRouter-backed models that support it.
  const webOption = within(composer).getByRole("menuitemcheckbox", {
    name: "Web Use public web search for this reply.",
  });
  expect(webOption).toBeEnabled();
  expect(webOption).toHaveAttribute("aria-checked", "true");
  fireEvent.click(
    within(composer).getByRole("menuitemcheckbox", {
      name: "Agent Use enabled tools for this reply.",
    }),
  );

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Use my sources and agent tools" },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });

  const approvalPanel = (await screen.findByText("Approve MCP tool run?")).closest(
    ".composer-approval-request",
  ) as HTMLElement;
  expect(chatRequests).toHaveLength(0);
  fireEvent.click(within(approvalPanel).getByRole("button", { name: "Approve" }));

  expect(await screen.findByText(CANNED)).toBeInTheDocument();
  const body = chatRequests.at(-1);
  expect(body?.knowledge_config_ids).toEqual(expect.arrayContaining(["kb-litigation-playbook", "kb-box-matter"]));
  expect(body?.tool_config_ids).toEqual(expect.arrayContaining(["tool-agent-workflow"]));
  expect(body?.approved_tool_config_ids).toEqual(["tool-hermes-agent-mcp"]);
  expect(body?.approval_tokens).toEqual(["approval-tool-hermes-agent-mcp"]);
  expect(body?.web_enabled).toBe(true);
  expect(body?.agent_enabled).toBe(true);
  expect(body?.citations_enabled).toBe(true);
});

test("turning web search off lasts only for the current chat", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composer = document.querySelector(".composer") as HTMLElement;
  // Web starts on; the × turns it off for this chat.
  fireEvent.click(within(composer).getByRole("button", { name: "Turn off active tools" }));
  fireEvent.click(within(composer).getByRole("button", { name: "Send options" }));
  expect(
    within(composer).getByRole("menuitemcheckbox", {
      name: "Web Search current public web sources.",
    }),
  ).toHaveAttribute("aria-checked", "false");
  fireEvent.keyDown(document, { key: "Escape" });

  // Opening a new chat re-arms the default.
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const freshComposer = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(freshComposer).getByRole("button", { name: "Send options" }));
  expect(
    within(freshComposer).getByRole("menuitemcheckbox", {
      name: "Web Use public web search for this reply.",
    }),
  ).toHaveAttribute("aria-checked", "true");
});

test("pending assistant response shows an activity trace for enabled tools", async () => {
  let resolveCompletion!: () => void;
  chatCompletionGate = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  window.localStorage.setItem("aperture-default-model-user-admin", "openrouter-openai-gpt-4o-mini");

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composer = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(composer).getByRole("button", { name: "Send options" }));
  fireEvent.click(
    within(composer).getByRole("menuitemcheckbox", {
      name: "Knowledge Use connected workspace sources.",
    }),
  );
  // Web search is already on by default for this OpenRouter-backed model.
  expect(
    within(composer).getByRole("menuitemcheckbox", {
      name: "Web Use public web search for this reply.",
    }),
  ).toHaveAttribute("aria-checked", "true");

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "Write a 25 page paper on Artemis II" },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });

  const trace = await screen.findByRole("status", {
    name: "Aperture Chat activity trace",
  });
  expect(
    within(trace).getByText("Complex requests can take longer. Aperture Chat keeps working while long-form answers are assembled and checked."),
  ).toBeInTheDocument();
  // Collapsed by default: only the current (first) step is visible.
  expect(within(trace).getByText("Routing request")).toBeInTheDocument();
  expect(within(trace).queryByText("Preparing context")).not.toBeInTheDocument();
  fireEvent.click(within(trace).getByRole("button", { name: "Expand work trace" }));
  expect(within(trace).getByText("Using Client Update Agent.")).toBeInTheDocument();
  expect(within(trace).getByText("Preparing context")).toBeInTheDocument();
  expect(within(trace).getByText("Web search requested")).toBeInTheDocument();
  expect(within(trace).getByText("Retrieving workspace knowledge")).toBeInTheDocument();
  expect(within(trace).getByText("Sizing long-form deliverable")).toBeInTheDocument();
  expect(within(trace).getByText("Generating long-form answer")).toBeInTheDocument();
  expect(within(trace).getByText("Content validator loop")).toBeInTheDocument();
  expect(screen.queryByLabelText("Aperture Chat is typing")).not.toBeInTheDocument();
  await waitFor(() => expect(chatRequests.at(-1)?.model).toBe("agent-client-update"));

  resolveCompletion();
  expect(await screen.findByText(CANNED)).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Aperture Chat activity trace" })).toBeInTheDocument();
});

test("exposed think tags move into a nested subsection of the work trace", async () => {
  assistantReply = [
    "<think>",
    "I compared the available routes before choosing the approved model.",
    "</think>",
    "",
    "## Final answer",
    "Use the selected Groq route.",
  ].join("\n");

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Choose the route" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  const finalHeading = await screen.findByRole("heading", { name: "Final answer" });
  const renderedResponse = finalHeading.closest(".message-rendered-response") as HTMLElement;
  expect(renderedResponse).not.toHaveTextContent("I compared the available routes");
  expect(renderedResponse).not.toHaveTextContent("<think>");

  const trace = screen.getByRole("region", { name: "Aperture Chat activity trace" });
  expect(within(trace).getByText(/complete · \d+ steps · thinking/)).toBeInTheDocument();
  fireEvent.click(within(trace).getByRole("button", { name: "Expand work trace" }));

  const thinkingSummary = within(trace).getByText("Thinking traces").closest("summary");
  expect(thinkingSummary).not.toBeNull();
  fireEvent.click(thinkingSummary!);
  expect(within(trace).getByText("I compared the available routes before choosing the approved model.")).toBeInTheDocument();
  expect(within(trace).getByText("Exposed by the model")).toBeInTheDocument();
});

test("a pending response in one chat does not block sending from a new chat", async () => {
  let resolveCompletion!: () => void;
  chatCompletionGate = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const firstComposer = await screen.findByLabelText("Message");
  fireEvent.change(firstComposer, {
    target: { value: "Draft the long paper" },
  });
  fireEvent.keyDown(firstComposer, { key: "Enter" });

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect(await screen.findByRole("status", { name: "Aperture Chat activity trace" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(await screen.findByRole("heading", { name: "New chat" })).toBeInTheDocument();

  const secondComposer = screen.getByLabelText("Message");
  fireEvent.change(secondComposer, {
    target: { value: "Summarize the independent issue" },
  });
  const sendButton = screen.getByRole("button", { name: "Send message" });
  expect(sendButton).toBeEnabled();
  fireEvent.click(sendButton);

  await waitFor(() => expect(chatRequests).toHaveLength(2));
  const sidebar = openChatHistorySection("Recent");
  expect(within(sidebar).getByText("Draft the long paper")).toBeInTheDocument();
  expect(within(sidebar).getByText("Summarize the independent issue")).toBeInTheDocument();

  resolveCompletion();
  expect(await screen.findByText(CANNED)).toBeInTheDocument();
});

test("send options dropdown can toggle runtime tools and send", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composer = document.querySelector(".composer") as HTMLElement;
  expect(within(composer).queryByRole("button", { name: "Knowledge" })).not.toBeInTheDocument();
  expect(within(composer).queryByRole("button", { name: "Web" })).not.toBeInTheDocument();
  expect(within(composer).queryByRole("button", { name: "Agent" })).not.toBeInTheDocument();
  // Web search defaults on, so the tools status chip shows that specific tool.
  expect(composer.querySelector(".composer-tools-status")).toHaveTextContent("Web search");
  expect(composer.querySelector(".composer-tools-status b")).not.toBeInTheDocument();

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Use send options" } });

  fireEvent.click(within(composer).getByRole("button", { name: "Send options" }));
  fireEvent.click(
    within(composer).getByRole("menuitemcheckbox", {
      name: "Knowledge Use connected workspace sources.",
    }),
  );
  expect(within(composer).getByRole("group", { name: "Knowledge source" })).toBeInTheDocument();
  fireEvent.click(
    within(composer).getByRole("menuitemradio", {
      name: /Box Matter Knowledge/,
    }),
  );
  expect(composer.querySelector(".composer-tools-status")).toHaveTextContent("Tools");
  expect(composer.querySelector(".composer-tools-status b")).toHaveTextContent("2");
  fireEvent.click(within(composer).getByRole("button", { name: "Turn off active tools" }));
  expect(composer.querySelector(".composer-tools-status")).not.toBeInTheDocument();
  fireEvent.click(
    within(composer).getByRole("menuitemcheckbox", {
      name: "Web Search current public web sources.",
    }),
  );
  fireEvent.click(
    within(composer).getByRole("menuitem", {
      name: "Send now Use the current composer settings.",
    }),
  );

  expect(await screen.findByText(CANNED)).toBeInTheDocument();
  const body = chatRequests.at(-1);
  expect(body?.knowledge_config_ids).toEqual([]);
  expect(body?.web_enabled).toBe(true);
});

test("assistant markdown tables render as native tables and transfer into Drafts", async () => {
  assistantReply = `## List of Scientific Discoveries from Artemis II

As of June 2024, the list of scientific discoveries from Artemis II is:

| Category | Discovery Status |
|---|---|
| Lunar geology | No discoveries yet; mission had not flown |
| Lunar samples | No discoveries; Artemis II does not collect samples |

---

**Summary:** Artemis II had no completed mission-specific scientific discoveries as of June 2024.`;
  completionCitations = [
    {
      id: "cite-artemis",
      source_name: "NASA Artemis II overview",
      source_type: "web",
      source_uri: "https://www.nasa.gov/artemis-ii/",
      snippet: "NASA Artemis II source.",
    },
  ];

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, {
    target: { value: "List Artemis II discoveries" },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });

  const table = await screen.findByRole("table");
  expect(table).toHaveTextContent("Category");
  expect(table).toHaveTextContent("Lunar geology");

  const conversation = document.querySelector(".message-list") as HTMLElement;
  expect(conversation).not.toHaveTextContent("|---|---|");
  expect(conversation).not.toHaveTextContent("**Summary:**");
  expect(conversation).not.toHaveTextContent("NASA Artemis II source.");

  fireEvent.click(
    within(conversation).getByRole("button", {
      name: "Transfer response to Drafts",
    }),
  );

  expect(await screen.findByRole("heading", { name: "Document Assistant" })).toBeInTheDocument();
  expect(screen.getByLabelText("Document title")).toHaveValue("List Artemis II discoveries");
  const editor = screen.getByRole("textbox", { name: "Document body" });
  expect(editor).toHaveClass("is-paginated");
  expect(editor.querySelectorAll(".document-page")).toHaveLength(1);
  expect(editor).toHaveTextContent("Lunar geology");
  expect(editor).toHaveTextContent("Summary:");
  expect(editor).toHaveTextContent("Sources");
  expect(editor).toHaveTextContent("NASA Artemis II overview");
  expect(editor).toHaveTextContent("NASA Artemis II source.");
  expect(document.querySelector(".document-data-table")).toBeInTheDocument();
  expect(editor.innerHTML).not.toContain("|---|---|");
  expect(editor.innerHTML).not.toContain("**Summary:**");
});

test("assistant markdown images render and transfer into Drafts", async () => {
  assistantReply = `## Artemis II Visuals

![Artemis II crew portrait](https://commons.wikimedia.org/wiki/Special:FilePath/Artemis%202%20Crew%20Portrait.jpg "Artemis II crew portrait; source: NASA via Wikimedia Commons")

The crew portrait should sit near the crew section of the paper.`;

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Add Artemis II images" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  const image = await screen.findByRole("img", {
    name: "Artemis II crew portrait",
  });
  expect(image).toHaveClass("md-image");
  expect(image.closest("figure")).toHaveClass("md-figure");
  expect(image).toHaveAttribute("src", expect.stringContaining("Artemis%202%20Crew%20Portrait.jpg"));

  const conversation = document.querySelector(".message-list") as HTMLElement;
  fireEvent.click(
    within(conversation).getByRole("button", {
      name: "Transfer response to Drafts",
    }),
  );

  expect(await screen.findByRole("heading", { name: "Document Assistant" })).toBeInTheDocument();
  const editor = screen.getByRole("textbox", { name: "Document body" });
  const transferredImage = editor.querySelector("img");
  expect(transferredImage).not.toBeNull();
  expect(transferredImage?.closest("figure")).toHaveClass("document-image-figure");
  expect(transferredImage?.getAttribute("src")).toContain("Artemis%202%20Crew%20Portrait.jpg");
  expect(editor).toHaveTextContent("Artemis II crew portrait; source: NASA via Wikimedia Commons");
});

test("backend chat threads hydrate into Recent and persist pin and model selection", async () => {
  const savedThreads: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/chat/threads") && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify([
            {
              id: "thread-server-matter",
              tenant_id: "tenant-example",
              owner_user_id: "user-admin",
              title: "Server backed matter",
              model_id: "gpt-4o-mini",
              group_id: "group-litigation",
              pinned: false,
              used_agent: false,
              updated_at: "11:00 AM",
              messages: [
                {
                  id: "msg-1",
                  role: "user",
                  content: "Summarize the matter",
                  createdAt: "10:59 AM",
                  status: "ok",
                },
                {
                  id: "msg-2",
                  role: "assistant",
                  content: "Server reply",
                  createdAt: "11:00 AM",
                  status: "ok",
                },
              ],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/chat/threads") && init?.method === "PUT") {
        const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        savedThreads.push(body);
        const id = url.split("/").pop() ?? "thread-server-matter";
        return new Response(JSON.stringify({ id, owner_user_id: "user-admin", ...body }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unavailable", { status: 500 });
    }),
  );

  await renderApp();

  const sidebar = openChatHistorySection("Recent");
  expect(await within(sidebar).findByText("Server backed matter")).toBeInTheDocument();
  fireEvent.click(within(sidebar).getByText("Server backed matter"));
  expect(await screen.findByText("Server reply")).toBeInTheDocument();

  fireEvent.click(within(sidebar).getByRole("button", { name: "Pin chat" }));
  await waitFor(() => {
    expect(savedThreads.some((thread) => thread.pinned === true)).toBe(true);
  });

  fireEvent.click(screen.getByRole("button", { name: "Select model" }));
  expect(screen.queryByRole("option", { name: /OpenRouter: openai\/gpt-4o-mini/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /OpenAI: GPT-5\.5/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: /Client Update Agent/i }));
  await waitFor(() => {
    expect(savedThreads.some((thread) => thread.model_id === "agent-client-update")).toBe(true);
  });

  fireEvent.click(screen.getByRole("button", { name: "Select model" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: /Set Client Update Agent as default model/i,
    }),
  );
  expect(window.localStorage.getItem("aperture-default-model-user-admin")).toBe("agent-client-update");
});

test("renaming the workspace title updates Recent and persists through the title endpoint", async () => {
  const originalThread = {
    id: "thread-rename-live",
    tenant_id: "tenant-example",
    owner_user_id: "user-admin",
    title: "Uploaded Document Knowledge Base",
    model_id: "gpt-4o-mini",
    group_id: "group-litigation",
    pinned: false,
    archived: false,
    folder_id: null,
    used_agent: false,
    updated_at: "11:00 AM",
    messages: [
      {
        id: "msg-rename-user",
        role: "user",
        content: "Summarize this knowledge base.",
        createdAt: "10:59 AM",
        status: "ok",
      },
      {
        id: "msg-rename-assistant",
        role: "assistant",
        content: "Knowledge base summary.",
        createdAt: "11:00 AM",
        status: "ok",
      },
    ],
  };
  const renameRequests: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/chat/threads/thread-rename-live/title") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        renameRequests.push({ url, method: init.method, body });
        return Response.json({ ...originalThread, title: body.title, updated_at: "Just now" });
      }
      if (url.includes("/api/chat/threads") && (!init?.method || init.method === "GET")) {
        return Response.json([originalThread]);
      }
      return new Response("unavailable", { status: 500 });
    }),
  );

  await renderApp();

  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  fireEvent.click(within(sidebar).getByRole("button", { name: "Chats" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Recent" }));
  fireEvent.click(await within(sidebar).findByText("Uploaded Document Knowledge Base"));

  expect(await screen.findByRole("heading", { name: "Uploaded Document Knowledge Base" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Rename chat" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), {
    target: { value: "Client knowledge base review" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save chat name" }));

  expect(await screen.findByRole("heading", { name: "Client knowledge base review" })).toBeInTheDocument();
  expect(within(sidebar).getByText("Client knowledge base review")).toBeInTheDocument();
  expect(within(sidebar).queryByText("Uploaded Document Knowledge Base")).not.toBeInTheDocument();
  expect(renameRequests).toEqual([
    {
      url: expect.stringContaining("/api/chat/threads/thread-rename-live/title"),
      method: "PATCH",
      body: { title: "Client knowledge base review" },
    },
  ]);
});

test("AI rename appears only after a finalized reply and persists through the generate endpoint", async () => {
  const baseThread = {
    tenant_id: "tenant-example",
    owner_user_id: "user-admin",
    model_id: "gpt-4o-mini",
    group_id: "group-litigation",
    pinned: false,
    archived: false,
    folder_id: null,
    used_agent: false,
    updated_at: "11:00 AM",
  };
  const finalizedThread = {
    ...baseThread,
    id: "thread-ai-title-live",
    title: "Uploaded Document Knowledge Base",
    messages: [
      {
        id: "msg-ai-user",
        role: "user",
        content: "Draft a vendor NDA checklist.",
        createdAt: "10:59 AM",
        status: "ok",
      },
      {
        id: "msg-ai-assistant",
        role: "assistant",
        content: "Vendor NDA checklist: parties, term, remedies.",
        createdAt: "11:00 AM",
        status: "ok",
      },
    ],
  };
  const unfinishedThread = {
    ...baseThread,
    id: "thread-ai-title-unfinished",
    title: "Unanswered question",
    messages: [
      {
        id: "msg-ai-unfinished-user",
        role: "user",
        content: "Still waiting on this one.",
        createdAt: "10:30 AM",
        status: "ok",
      },
      {
        id: "msg-ai-unfinished-assistant",
        role: "assistant",
        content: "",
        createdAt: "10:30 AM",
        status: "error",
      },
    ],
  };
  const generateRequests: Array<{ url: string; method?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/chat/threads/thread-ai-title-live/title/generate") && init?.method === "POST") {
        generateRequests.push({ url, method: init.method });
        return Response.json({
          ...finalizedThread,
          title: "Vendor NDA Checklist Drafting",
          updated_at: "Just now",
        });
      }
      if (url.includes("/api/chat/threads") && (!init?.method || init.method === "GET")) {
        return Response.json([finalizedThread, unfinishedThread]);
      }
      return new Response("unavailable", { status: 500 });
    }),
  );

  await renderApp();

  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  fireEvent.click(within(sidebar).getByRole("button", { name: "Chats" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Recent" }));

  fireEvent.click(await within(sidebar).findByText("Unanswered question"));
  expect(await screen.findByRole("heading", { name: "Unanswered question" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Rename chat" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Rename chat with AI" })).not.toBeInTheDocument();

  fireEvent.click(within(sidebar).getByText("Uploaded Document Knowledge Base"));
  expect(await screen.findByRole("heading", { name: "Uploaded Document Knowledge Base" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Rename chat with AI" }));

  expect(await screen.findByRole("heading", { name: "Vendor NDA Checklist Drafting" })).toBeInTheDocument();
  expect(within(sidebar).getByText("Vendor NDA Checklist Drafting")).toBeInTheDocument();
  expect(within(sidebar).queryByText("Uploaded Document Knowledge Base")).not.toBeInTheDocument();
  expect(generateRequests).toEqual([
    {
      url: expect.stringContaining("/api/chat/threads/thread-ai-title-live/title/generate"),
      method: "POST",
    },
  ]);
});

test("cached archived chats are filtered to the signed-in owner", async () => {
  const cachedThread = (id: string, ownerUserId: string, title: string) => ({
    id,
    tenant_id: "tenant-example",
    owner_user_id: ownerUserId,
    title,
    model_id: "gpt-4o-mini",
    group_id: "group-litigation",
    pinned: false,
    archived: true,
    folder_id: null,
    used_agent: false,
    updated_at: "Just now",
    messages: [
      {
        id: `${id}-message`,
        role: "user",
        content: title,
        createdAt: "9:00 AM",
        status: "ok",
      },
    ],
  });
  window.localStorage.setItem(
    "aperture-chats-v2-user-admin",
    JSON.stringify([
      cachedThread("thread-admin-archive", "user-admin", "My archived matter"),
      cachedThread("thread-other-archive", "user-owner", "Another owner's archived matter"),
    ]),
  );

  await renderApp();

  fireEvent.click(
    await screen.findByRole("button", { name: "Account: Alex Morgan, Admin" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "View (1)" }));

  expect(screen.getByText("My archived matter")).toBeInTheDocument();
  expect(screen.queryByText("Another owner's archived matter")).not.toBeInTheDocument();
  await waitFor(() => {
    const cached = window.localStorage.getItem("aperture-chats-v2-user-admin");
    expect(cached).toContain("thread-admin-archive");
    expect(cached).not.toContain("thread-other-archive");
  });
});

test("citations panel shows K labels and page or locator pills only when reported", async () => {
  completionCitations = [
    {
      id: "cite-chunk-1",
      source_name: "Discovery playbook",
      source_type: "knowledge",
      source_uri: "knowledge://kb-litigation/playbook",
      snippet: "Deadline chunk.",
      page_start: 3,
      page_end: 5,
      locator: null,
      chunk_id: "chunk-1",
      k_index: 1,
    },
    {
      id: "cite-chunk-2",
      source_name: "Discovery playbook",
      source_type: "knowledge",
      source_uri: "knowledge://kb-litigation/playbook",
      snippet: "Budget chunk.",
      page_start: 7,
      page_end: 7,
      locator: "Sheet: Q3",
      chunk_id: "chunk-2",
      k_index: 2,
    },
    {
      id: "cite-legacy",
      source_name: "Legacy memo",
      source_type: "knowledge",
      source_uri: "knowledge://kb-litigation/legacy",
      snippet: "Legacy snippet.",
    },
  ];

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Where are the discovery deadlines?" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  const conversation = document.querySelector(".message-list") as HTMLElement;
  fireEvent.click(within(conversation).getByRole("button", { name: /View 3 citations/i }));
  const panel = document.querySelector(".session-panel") as HTMLElement;
  expect(within(panel).getByText("Selected response · 3")).toBeInTheDocument();

  // Distinct chunks from the same source stay distinct entries.
  expect(within(panel).getAllByText("Discovery playbook")).toHaveLength(2);
  expect(within(panel).getByText("Deadline chunk.")).toBeInTheDocument();
  expect(within(panel).getByText("Budget chunk.")).toBeInTheDocument();

  // K labels plus page/locator pills come straight from the reported fields.
  expect(within(panel).getByText("K1")).toBeInTheDocument();
  expect(within(panel).getByText("K2")).toBeInTheDocument();
  expect(within(panel).getByText("p. 3–5")).toBeInTheDocument();
  expect(within(panel).getByText("p. 7")).toBeInTheDocument();
  expect(within(panel).getByText("Sheet: Q3")).toBeInTheDocument();

  // Legacy citations render exactly as before: no K label, no fabricated page.
  const legacyItem = within(panel).getByText("Legacy memo").closest("li") as HTMLElement;
  expect(legacyItem.querySelector(".pill")).toBeNull();
  expect(legacyItem.textContent).not.toMatch(/p\.\s?\d/);
});

test("editing a user message truncates the thread and resends through the normal send path", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const textarea = await screen.findByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "First question" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(await screen.findByText(CANNED)).toBeInTheDocument();

  assistantReply = "Second answer.";
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Second question" } });
  fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
  expect(await screen.findByText("Second answer.")).toBeInTheDocument();
  expect(chatRequests).toHaveLength(2);

  const conversation = document.querySelector(".message-list") as HTMLElement;
  const firstPrompt = within(conversation).getByText("First question").closest(".message") as HTMLElement;
  fireEvent.click(within(firstPrompt).getByRole("button", { name: "Edit message" }));

  const editor = screen.getByRole("textbox", { name: "Edit message" });
  expect(editor).toHaveValue("First question");

  // Cancel restores the untouched thread and sends nothing.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument();
  expect(within(conversation).getByText("Second question")).toBeInTheDocument();
  expect(within(conversation).getByText("Second answer.")).toBeInTheDocument();
  expect(chatRequests).toHaveLength(2);

  // Submitting the edit truncates at that message and re-runs the send path.
  assistantReply = "Revised answer.";
  const firstPromptAgain = within(conversation).getByText("First question").closest(".message") as HTMLElement;
  fireEvent.click(within(firstPromptAgain).getByRole("button", { name: "Edit message" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
    target: { value: "First question, revised" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send edited message" }));

  expect(await screen.findByText("Revised answer.")).toBeInTheDocument();
  expect(chatRequests).toHaveLength(3);
  // The resent request history contains only the edited turn — nothing stale.
  expect(chatRequests.at(-1)?.messages).toEqual([{ role: "user", content: "First question, revised" }]);

  const editedConversation = document.querySelector(".message-list") as HTMLElement;
  expect(within(editedConversation).getByText("First question, revised")).toBeInTheDocument();
  expect(within(editedConversation).queryByText("Second question")).not.toBeInTheDocument();
  expect(within(editedConversation).queryByText("Second answer.")).not.toBeInTheDocument();
  expect(within(editedConversation).queryByText(CANNED)).not.toBeInTheDocument();
  expect(document.querySelectorAll(".message-list > .message")).toHaveLength(2);

  // The persisted thread history holds no stale later messages either.
  await waitFor(() => {
    const raw = window.localStorage.getItem("aperture-chats-v2-user-admin") ?? "";
    expect(raw).toContain("Revised answer.");
    expect(raw).not.toContain("Second question");
    expect(raw).not.toContain("Second answer.");
  });
});

test("composer web links ride as fetch_urls and surface returned web citations", async () => {
  completionCitations = [
    {
      id: "cite-fetch-1",
      source_name: "example.com/page",
      source_type: "web",
      source_uri: "https://example.com/page",
      snippet: "Fetched page excerpt.",
    },
  ];

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composer = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(composer).getByRole("button", { name: "Add attachment" }));
  fireEvent.click(within(composer).getByRole("menuitem", { name: /Web page by link/ }));
  fireEvent.change(within(composer).getByRole("textbox", { name: "Web page address" }), {
    target: { value: "https://example.com/page" },
  });
  fireEvent.click(within(composer).getByRole("button", { name: "Add link" }));
  expect(within(composer).getByRole("button", { name: "Remove link https://example.com/page" })).toBeInTheDocument();

  const textarea = screen.getByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Summarize the linked page" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect(chatRequests[0].fetch_urls).toEqual(["https://example.com/page"]);
  expect(await screen.findByText(CANNED)).toBeInTheDocument();
  // The links belong to the sent message, so the chips clear with the draft.
  expect(screen.queryByRole("button", { name: "Remove link https://example.com/page" })).not.toBeInTheDocument();

  const conversation = document.querySelector(".message-list") as HTMLElement;
  fireEvent.click(within(conversation).getByRole("button", { name: /View 1 citation/i }));
  const panel = document.querySelector(".session-panel") as HTMLElement;
  const sourceLink = within(panel).getByRole("link", { name: "example.com/page" });
  expect(sourceLink).toHaveAttribute("href", "https://example.com/page");
  expect(within(panel).getByText("Fetched page excerpt.")).toBeInTheDocument();
});

test("the composer rejects invalid links and more than three links with honest copy", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composer = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(composer).getByRole("button", { name: "Add attachment" }));
  fireEvent.click(within(composer).getByRole("menuitem", { name: /Web page by link/ }));

  const addLink = (value: string) => {
    fireEvent.change(within(composer).getByRole("textbox", { name: "Web page address" }), {
      target: { value },
    });
    fireEvent.click(within(composer).getByRole("button", { name: "Add link" }));
  };

  addLink("not-a-link");
  expect(
    within(composer).getByText("Enter a full web address starting with http:// or https://."),
  ).toBeInTheDocument();

  addLink("https://example.com/a");
  addLink("https://example.com/b");
  addLink("https://example.com/c");
  expect(within(composer).getAllByRole("button", { name: /^Remove link/ })).toHaveLength(3);

  addLink("https://example.com/d");
  expect(within(composer).getByText("You can attach up to 3 web links per message.")).toBeInTheDocument();
  expect(within(composer).getAllByRole("button", { name: /^Remove link/ })).toHaveLength(3);
  expect(within(composer).queryByRole("button", { name: "Remove link https://example.com/d" })).not.toBeInTheDocument();

  const textarea = screen.getByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Use only the accepted links" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  await waitFor(() => expect(chatRequests).toHaveLength(1));
  expect(chatRequests[0].fetch_urls).toEqual([
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
  ]);
});

test("a blocked ad-hoc URL surfaces the backend error with no success state", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));

  const composer = document.querySelector(".composer") as HTMLElement;
  fireEvent.click(within(composer).getByRole("button", { name: "Add attachment" }));
  fireEvent.click(within(composer).getByRole("menuitem", { name: /Web page by link/ }));
  fireEvent.change(within(composer).getByRole("textbox", { name: "Web page address" }), {
    target: { value: "https://blocked.example.com/page" },
  });
  fireEvent.click(within(composer).getByRole("button", { name: "Add link" }));

  const textarea = screen.getByLabelText("Message");
  fireEvent.change(textarea, { target: { value: "Summarize the blocked page" } });
  fireEvent.keyDown(textarea, { key: "Enter" });

  const error = await screen.findByText("The web page could not be fetched: the address is not allowed.");
  expect(error).toHaveClass("message-error");
  expect(screen.queryByText(CANNED)).not.toBeInTheDocument();
});


test("the empty-chat greeting follows the time of day", async () => {
  const { timeOfDayGreeting } = await import("./components/ChatWorkspace");
  expect(timeOfDayGreeting(5, "Taylor Example")).toBe("Good morning, Taylor.");
  expect(timeOfDayGreeting(11, "Taylor Example")).toBe("Good morning, Taylor.");
  expect(timeOfDayGreeting(12, "Jane Smith")).toBe("Good afternoon, Jane.");
  expect(timeOfDayGreeting(16, "Jane Smith")).toBe("Good afternoon, Jane.");
  expect(timeOfDayGreeting(17, "Casey Doe")).toBe("Good evening, Casey.");
  expect(timeOfDayGreeting(20, "Casey Doe")).toBe("Good evening, Casey.");
  expect(timeOfDayGreeting(23, "Drew Parker")).toBe("Burning the midnight oil, Drew?");
  expect(timeOfDayGreeting(2, "Drew Parker")).toBe("Burning the midnight oil, Drew?");
  expect(timeOfDayGreeting(9, "")).toBe("Good morning, there.");
});

test("provider cards resolve real brand marks with an honest letter fallback", async () => {
  const { providerBrandIconPath } = await import("./components/providerIcons");
  expect(providerBrandIconPath("OpenRouter", "openrouter")).toBeTruthy();
  expect(providerBrandIconPath("OpenAI", "openai")).toBeTruthy();
  expect(providerBrandIconPath("Anthropic", "anthropic")).toBeTruthy();
  // Groq rides the generic openai-compatible runtime: it gets its own bundled
  // mark and must NOT inherit the OpenAI logo from its kind.
  expect(providerBrandIconPath("Groq", "openai-compatible")).toBeTruthy();
  expect(providerBrandIconPath("Groq", "openai-compatible")).not.toBe(
    providerBrandIconPath("OpenAI", "openai"),
  );
  // Unknown vendors still fall back to the honest letter.
  expect(providerBrandIconPath("Cerebras", "openai-compatible")).toBeNull();
});

test("prompt improver stays hidden until there is a draft, then rewrites in place", async () => {
  assistantReply = "Review the attached Q3 vendor policy for compliance gaps, citing each violated clause.";
  let releaseCompletion!: () => void;
  chatCompletionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });

  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  const textarea = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;

  expect(screen.queryByRole("button", { name: "Improve prompt" })).not.toBeInTheDocument();

  fireEvent.change(textarea, { target: { value: "check policy ok?" } });
  const improveButton = screen.getByRole("button", { name: "Improve prompt" });
  expect(improveButton).toBeEnabled();
  fireEvent.click(improveButton);

  // While the rewrite runs: the composer carries the progress rail, the draft
  // is locked, and sending is blocked so the old text cannot slip out mid-rewrite.
  await waitFor(() => {
    expect(document.querySelector(".composer.is-improving")).toBeTruthy();
  });
  expect(document.querySelector(".composer-improve-rail.is-running")).toBeTruthy();
  expect(textarea).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

  releaseCompletion();

  // The rewrite lands in the composer — nothing was sent to the conversation —
  // and the improving state stops so the user can review and send.
  await waitFor(() => {
    expect(textarea.value).toBe(
      "Review the attached Q3 vendor policy for compliance gaps, citing each violated clause.",
    );
  });
  expect(document.querySelector(".composer.is-improving")).toBeNull();
  expect(document.querySelector(".message-list")).toBeNull();

  // The improver call is a real completion with the improver contract: the
  // system instruction rides along and the draft is quoted for rewriting only.
  expect(chatRequests).toHaveLength(1);
  const messages = chatRequests[0].messages as Array<{ role: string; content: string }>;
  expect(messages[0].role).toBe("system");
  expect(messages[0].content).toContain("Do not answer the prompt");
  expect(messages[1].content).toContain("check policy ok?");
});
