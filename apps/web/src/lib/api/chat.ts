import {
  apiBase,
  authHeaders,
  apiRequest,
  readApiError,
  pathId,
  ChatRequestError,
  DEFAULT_CHAT_TIMEOUT_MS,
  type ApiMutationOptions,
} from "./http";
import type {
  ChatAttachment,
  ChatCitation,
  ChatRole,
  ChatThread,
  ChatTokenUsage,
  CloudAttachmentItem,
  MemorySavedNotice,
} from "../types";

export type ChatWireMessage = { role: ChatRole; content: string };

export type ChatFolder = {
  id: string;
  name: string;
  created_at: string;
  tenant_id?: string | null;
};

export type ChatRuntimeOptions = {
  surface?: "chat" | "draft";
  threadId?: string | null;
  draftTitle?: string | null;
  clientStartedAt?: string | null;
  agentProfileId?: string | null;
  modelOverride?: string | null;
  knowledgeConfigIds?: string[];
  toolConfigIds?: string[];
  approvedToolConfigIds?: string[];
  approvalTokens?: string[];
  webEnabled?: boolean;
  /**
   * Ad-hoc URLs (at most 3) fetched server-side as [U#] source excerpts for
   * this request. A blocked or failed URL fails the whole request explicitly
   * before any model call — there is no silent drop.
   */
  fetchUrls?: string[];
  agentEnabled?: boolean;
  citationsEnabled?: boolean;
  attachmentIds?: string[];
  attachmentNames?: string[];
  /**
   * Image attachments from earlier turns in this thread, re-supplied so the
   * model can still see them when a follow-up asks about an image. The server
   * skips ids whose uploads no longer exist instead of failing the send.
   */
  contextAttachmentIds?: string[];
  maxCompletionTokens?: number;
  /**
   * Reasoning depth for reasoning-capable models: "minimal" favors the
   * fastest useful answer, "high" makes the model think longer.
   * Omitted = provider default.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | null;
};

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { role?: ChatRole; content?: string } }>;
  citations?: ChatCitation[];
  model?: string;
  usage?: Record<string, number>;
  memory_used?: number;
  memory_saved?: MemorySavedNotice[];
};

export type ChatAssistantReply = {
  content: string;
  citations: ChatCitation[];
  /** Provider-reported token usage; undefined when the provider reported none. */
  usage?: ChatTokenUsage;
  /** How many of the user's own memories shaped this reply. */
  memoryUsed?: number;
  /** Memories captured from this turn, so the user sees what was learned. */
  memorySaved?: MemorySavedNotice[];
};

/** Keep only real, positive token counts; drop all-zero usage blocks so the
 * UI can honestly distinguish "not reported" from a genuine count. */
function normalizeTokenUsage(raw: unknown): ChatTokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const usage: ChatTokenUsage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      usage[key] = Math.round(value);
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function listChatThreads(userId: string, options: ApiMutationOptions = {}): Promise<ChatThread[]> {
  return apiRequest<ChatThread[]>(userId, "/api/chat/threads", {
    signal: options.signal,
  });
}

export function listChatFolders(userId: string, options: ApiMutationOptions = {}): Promise<ChatFolder[]> {
  return apiRequest<ChatFolder[]>(userId, "/api/chat/folders", {
    signal: options.signal,
  });
}

export function saveChatFolder(
  userId: string,
  folder: ChatFolder,
  options: ApiMutationOptions = {},
): Promise<ChatFolder> {
  return apiRequest<ChatFolder>(userId, "/api/chat/folders", {
    method: "PUT",
    body: folder,
    signal: options.signal,
  });
}

export function deleteChatFolder(
  userId: string,
  folderId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string; cleared_thread_ids: string[] }> {
  return apiRequest(userId, `/api/chat/folders/${pathId(folderId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function saveChatThread(
  userId: string,
  thread: ChatThread,
  options: ApiMutationOptions = {},
): Promise<ChatThread> {
  const { id, ...payload } = thread;
  return apiRequest<ChatThread>(userId, `/api/chat/threads/${pathId(id)}`, {
    method: "PUT",
    body: payload,
    signal: options.signal,
  });
}

/** Rename a chat without rewriting its messages or other session state. */
export function renameChatThread(
  userId: string,
  threadId: string,
  title: string,
  options: ApiMutationOptions = {},
): Promise<ChatThread> {
  return apiRequest<ChatThread>(userId, `/api/chat/threads/${pathId(threadId)}/title`, {
    method: "PATCH",
    body: { title },
    signal: options.signal,
  });
}

/**
 * Asks the API to rename a chat from its own conversation context. The server
 * generates the title with the thread's model, persists it, and returns the
 * saved thread; nothing changes when the provider call fails.
 */
export function generateChatThreadTitle(
  userId: string,
  threadId: string,
  options: ApiMutationOptions & { expectedTitle?: string } = {},
): Promise<ChatThread> {
  const expectedTitle = options.expectedTitle?.trim();
  const query = expectedTitle ? `?expected_title=${encodeURIComponent(expectedTitle)}` : "";
  return apiRequest<ChatThread>(userId, `/api/chat/threads/${pathId(threadId)}/title/generate${query}`, {
    method: "POST",
    signal: options.signal,
  });
}

/** Permanently removes a chat thread and its session record from the server. */
export function deleteChatThread(
  userId: string,
  threadId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/chat/threads/${pathId(threadId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

/**
 * Sends the running conversation to the chat completion endpoint and resolves
 * with the assistant reply text. Shares the contract with the backend agent:
 * POST /api/chat/complete, header x-aperture-user, body { model, messages, stream }.
 */
export async function sendChat(
  userId: string,
  options: {
    model: string;
    messages: ChatWireMessage[];
    runtime?: ChatRuntimeOptions;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<ChatAssistantReply> {
  const { model, messages, runtime, signal, timeoutMs = DEFAULT_CHAT_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  try {
    const response = await fetch(`${apiBase}/api/chat/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(userId),
      },
      body: JSON.stringify(chatRequestBody(model, messages, runtime, false)),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ChatRequestError(await readApiError(response), response.status);
    }

    return chatReplyFromCompletion((await response.json()) as ChatCompletionResponse);
  } catch (error) {
    if (error instanceof ChatRequestError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError(
        "The response is still running longer than this browser session allows. Try again with a higher VITE_CHAT_TIMEOUT_MS deployment setting.",
      );
    }
    throw new ChatRequestError("Could not reach the model. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Mirrors the API's CONTINUATION_PROMPT so a client-side resume after a
 * dropped connection continues the same way server-side continuation does.
 */
const STREAM_CONTINUATION_PROMPT =
  "Continue exactly where the previous answer stopped. Do not restart, summarize, " +
  "or apologize. Keep the same structure and continue until the requested work is complete.";

/**
 * Resume attempts allowed without any new text arriving. The counter resets
 * whenever a reconnect makes progress, so a long generation that keeps
 * dropping and recovering is never abandoned — only a connection that is
 * repeatedly dead with no progress ends the run.
 */
const MAX_STREAM_RESUME_ATTEMPTS = 20;
const STREAM_RESUME_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

function resumeBackoff(attempt: number, delays: number[]): number {
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)] ?? 0;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!ms || signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Matches the API's segment join: continuation text flows straight on when
 * the partial ends with whitespace, otherwise starts a new paragraph.
 */
function segmentJoiner(baseText: string): string {
  return !baseText || baseText.endsWith("\n") || baseText.endsWith(" ") ? "" : "\n\n";
}

const CANCELLED_RESPONSE_MESSAGE = "The response was cancelled before it finished.";

export async function sendChatStream(
  userId: string,
  options: {
    model: string;
    messages: ChatWireMessage[];
    runtime?: ChatRuntimeOptions;
    signal?: AbortSignal;
    onDelta?: (fullText: string) => void;
    /** Test hook: overrides the reconnect backoff schedule. */
    resumeDelaysMs?: number[];
  },
): Promise<ChatAssistantReply> {
  const { model, messages, runtime, signal, onDelta, resumeDelaysMs = STREAM_RESUME_BACKOFF_MS } = options;
  let fullText = "";
  let stalledAttempts = 0;

  // A generation ends only three ways: the completion marker arrives, the
  // provider reports a non-retryable failure, or the user hits stop. Idle
  // periods never end it — reasoning models legitimately go silent while they
  // think — and dropped connections resume automatically, re-sending the
  // partial output as context so the model continues where it stopped.
  while (true) {
    const progressBefore = fullText.length;
    try {
      return await streamChatOnce(userId, {
        model,
        messages: fullText
          ? [
              ...messages,
              { role: "assistant", content: fullText },
              { role: "user", content: STREAM_CONTINUATION_PROMPT },
            ]
          : messages,
        runtime,
        signal,
        baseText: fullText,
        onText: (text) => {
          fullText = text;
        },
        onDelta,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new ChatRequestError(CANCELLED_RESPONSE_MESSAGE, undefined, fullText);
      }
      if (!(error instanceof ChatRequestError) || !error.resumable) throw error;
      stalledAttempts = fullText.length > progressBefore ? 1 : stalledAttempts + 1;
      if (stalledAttempts > MAX_STREAM_RESUME_ATTEMPTS) throw error;
      await abortableDelay(resumeBackoff(stalledAttempts, resumeDelaysMs), signal);
      if (signal?.aborted) {
        throw new ChatRequestError(CANCELLED_RESPONSE_MESSAGE, undefined, fullText);
      }
    }
  }
}

/** One streaming attempt. Resumability is decided per failure: transport
 * drops and API-flagged retryable errors can be resumed by the caller;
 * deterministic failures surface immediately. */
async function streamChatOnce(
  userId: string,
  options: {
    model: string;
    messages: ChatWireMessage[];
    runtime?: ChatRuntimeOptions;
    signal?: AbortSignal;
    baseText: string;
    onText: (fullText: string) => void;
    onDelta?: (fullText: string) => void;
  },
): Promise<ChatAssistantReply> {
  const { model, messages, runtime, signal, baseText, onText, onDelta } = options;
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let fullText = baseText;
  // Prepended to the first delta of a resumed attempt; empty on a fresh run.
  let joiner = segmentJoiner(baseText);
  const joinNonStreamContent = (content: string) =>
    baseText ? `${baseText}${segmentJoiner(baseText)}${content}` : content;

  try {
    const response = await fetch(`${apiBase}/api/chat/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(userId),
      },
      body: JSON.stringify(chatRequestBody(model, messages, runtime, true)),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await readApiError(response);
      if (
        response.status === 400 &&
        /image models return complete responses; retry without streaming/i.test(detail)
      ) {
        const reply = await sendChat(userId, { model, messages, runtime, signal });
        return { ...reply, content: joinNonStreamContent(reply.content) };
      }
      throw new ChatRequestError(
        detail,
        response.status,
        fullText,
        response.status === 429 || response.status >= 500,
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      const reply = chatReplyFromCompletion((await response.json()) as ChatCompletionResponse);
      return { ...reply, content: joinNonStreamContent(reply.content) };
    }
    if (!contentType.includes("text/event-stream")) {
      throw new ChatRequestError(`The chat API returned an unsupported content type: ${contentType || "unknown"}.`);
    }
    if (!response.body) {
      throw new ChatRequestError("The chat API opened a stream without a response body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneEventSeen = false;
    let citations: ChatCitation[] = [];
    let usage: ChatTokenUsage | undefined;
    let memoryUsed = 0;
    let memorySaved: MemorySavedNotice[] = [];

    const processLine = (rawLine: string) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      // Non-data lines include SSE keep-alive comments the API emits while
      // the model is thinking; they carry no content and are skipped here.
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trimStart();
      if (data === "[DONE]") {
        doneEventSeen = true;
        return;
      }
      if (!data) return;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        throw new ChatRequestError("The chat API returned a malformed streaming event.", undefined, fullText);
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const record = event as Record<string, unknown>;
      if (typeof record.error === "string" && record.error.trim()) {
        throw new ChatRequestError(record.error, undefined, fullText, record.retryable === true);
      }
      if (typeof record.delta === "string" && record.delta) {
        fullText += joiner + record.delta;
        joiner = "";
        onText(fullText);
        onDelta?.(fullText);
      }
      if (record.done === true) {
        citations = Array.isArray(record.citations) ? (record.citations as ChatCitation[]) : [];
        usage = normalizeTokenUsage(record.usage);
        memoryUsed = typeof record.memory_used === "number" ? record.memory_used : 0;
        memorySaved = Array.isArray(record.memory_saved)
          ? (record.memory_saved as MemorySavedNotice[])
          : [];
      }
    };

    while (!doneEventSeen) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (doneEventSeen) break;
        newline = buffer.indexOf("\n");
      }
    }
    if (!doneEventSeen && buffer.trim()) processLine(buffer);
    if (!doneEventSeen) {
      throw new ChatRequestError(
        "The chat stream ended before the completion marker arrived.",
        undefined,
        fullText,
        true,
      );
    }
    if (!fullText) {
      throw new ChatRequestError("The model returned an empty response.", undefined, undefined, true);
    }
    return { content: fullText, citations, usage, memoryUsed, memorySaved };
  } catch (error) {
    if (error instanceof ChatRequestError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      // Only the user's stop aborts this request; there is no idle timeout.
      throw new ChatRequestError(CANCELLED_RESPONSE_MESSAGE, undefined, fullText);
    }
    throw new ChatRequestError(
      "Could not reach the model. Check your connection and try again.",
      undefined,
      fullText,
      true,
    );
  }
}

function chatRequestBody(
  model: string,
  messages: ChatWireMessage[],
  runtime: ChatRuntimeOptions | undefined,
  stream: boolean,
) {
  return {
    model,
    messages,
    stream,
    surface: runtime?.surface ?? "chat",
    thread_id: runtime?.threadId ?? null,
    draft_title: runtime?.draftTitle ?? null,
    client_started_at: runtime?.clientStartedAt ?? null,
    agent_profile_id: runtime?.agentProfileId ?? null,
    knowledge_config_ids: runtime?.knowledgeConfigIds ?? [],
    tool_config_ids: runtime?.toolConfigIds ?? [],
    approved_tool_config_ids: runtime?.approvedToolConfigIds ?? [],
    approval_tokens: runtime?.approvalTokens ?? [],
    web_enabled: Boolean(runtime?.webEnabled),
    fetch_urls: runtime?.fetchUrls ?? [],
    agent_enabled: Boolean(runtime?.agentEnabled),
    citations_enabled: runtime?.citationsEnabled ?? true,
    attachment_ids: runtime?.attachmentIds ?? [],
    attachment_names: runtime?.attachmentNames ?? [],
    context_attachment_ids: runtime?.contextAttachmentIds ?? [],
    max_completion_tokens: runtime?.maxCompletionTokens ?? null,
    reasoning_effort: runtime?.reasoningEffort ?? null,
  };
}

function chatReplyFromCompletion(data: ChatCompletionResponse): ChatAssistantReply {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new ChatRequestError("The model returned an empty response.");
  }
  return {
    content,
    citations: Array.isArray(data.citations) ? data.citations : [],
    usage: normalizeTokenUsage(data.usage),
    memoryUsed: typeof data.memory_used === "number" ? data.memory_used : 0,
    memorySaved: Array.isArray(data.memory_saved) ? data.memory_saved : [],
  };
}

export async function uploadChatAttachment(
  userId: string,
  file: File,
  options: ApiMutationOptions & { tenantId?: string | null } = {},
): Promise<ChatAttachment> {
  const form = new FormData();
  form.append("file", file);
  if (options.tenantId) form.append("tenant_id", options.tenantId);

  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/chat/attachments`, {
      method: "POST",
      headers: authHeaders(userId),
      body: form,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The upload was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not upload the attachment. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return (await response.json()) as ChatAttachment;
}

export async function loadChatAttachmentPreview(
  userId: string,
  attachmentId: string,
  options: ApiMutationOptions = {},
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/chat/attachments/${pathId(attachmentId)}/preview`, {
      headers: authHeaders(userId),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The attachment preview request was cancelled.");
    }
    throw new ChatRequestError("Could not load the attachment preview. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  const contentType = (response.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new ChatRequestError("The attachment preview response was not an image.");
  }
  return response.blob();
}

export async function transcribeDictation(
  userId: string,
  audio: Blob,
  options: ApiMutationOptions = {},
): Promise<{ text: string; model_id: string; model_name: string }> {
  const form = new FormData();
  form.append("file", audio, "dictation.wav");

  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/chat/transcriptions`, {
      method: "POST",
      headers: authHeaders(userId),
      body: form,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The dictation was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not send the dictation. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return (await response.json()) as { text: string; model_id: string; model_name: string };
}

export function listCloudAttachmentItems(
  userId: string,
  connectorId: string,
  options: ApiMutationOptions & { tenantId?: string | null } = {},
): Promise<CloudAttachmentItem[]> {
  const query = options.tenantId ? `?tenant_id=${encodeURIComponent(options.tenantId)}` : "";
  return apiRequest<CloudAttachmentItem[]>(userId, `/api/chat/cloud-attachments/${pathId(connectorId)}/items${query}`, {
    signal: options.signal,
  });
}

export function getCloudAttachmentAuthorizeUrl(
  userId: string,
  connectorId: string,
  options: ApiMutationOptions & { tenantId?: string | null } = {},
): Promise<{ url: string; label: string }> {
  const query = options.tenantId ? `?tenant_id=${encodeURIComponent(options.tenantId)}` : "";
  return apiRequest<{ url: string; label: string }>(
    userId,
    `/api/chat/cloud-attachments/${pathId(connectorId)}/authorize-url${query}`,
    { signal: options.signal },
  );
}

export function importCloudAttachments(
  userId: string,
  connectorId: string,
  payload: { item_ids: string[]; tenant_id?: string | null },
  options: ApiMutationOptions = {},
): Promise<ChatAttachment[]> {
  return apiRequest<ChatAttachment[]>(userId, `/api/chat/cloud-attachments/${pathId(connectorId)}/attachments`, {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}
