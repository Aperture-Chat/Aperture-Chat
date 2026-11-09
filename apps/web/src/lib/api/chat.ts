import {
  apiBase,
  authHeaders,
  apiRequest,
  isRecord,
  readApiError,
  pathId,
  ChatRequestError,
  DEFAULT_CHAT_TIMEOUT_MS,
  type ApiMutationOptions,
} from "./http";
import type {
  ChatAttachment,
  ChatCitation,
  ChatFeedbackRecord,
  ChatFeedbackSubmitRequest,
  ChatRole,
  ChatThread,
  ChatTokenUsage,
  CloudAttachmentItem,
  MemorySavedNotice,
} from "../types";
import { parseStreamActivity, type ChatStreamActivity } from "../streamActivity";
import { parseClarifyQuestions, type ClarifyMode, type ClarifyQuestions } from "../clarify";

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
  /** Chat only: whether the assistant may pause to ask clarifying questions,
   * must make the choices itself, or is continuing with the user's answers. */
  clarifyMode?: ClarifyMode | null;
};

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { role?: ChatRole; content?: string } }>;
  citations?: ChatCitation[];
  model?: string;
  usage?: Record<string, number>;
  memory_used?: number;
  memory_saved?: MemorySavedNotice[];
  /** The latest prompt as stored, with personal data replaced by tokens. */
  concealed_prompt?: string | null;
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
  /** Set when personal-data protection concealed part of the prompt. */
  concealedPrompt?: string;
  /** Set when the reply paused to ask: it has no text until the user answers. */
  questions?: ClarifyQuestions;
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
  // syncPending and the matter choice are browser-side bookkeeping and must
  // never reach the API; only the matters API files a chat under a matter.
  const { id, syncPending: _syncPending, pendingMatterId: _pendingMatterId, matterError: _matterError, ...payload } = thread;
  return apiRequest<ChatThread>(userId, `/api/chat/threads/${pathId(id)}`, {
    method: "PUT",
    body: payload,
    signal: options.signal,
  });
}

/**
 * Records that the owner has seen a chat through `messageId`. The API keeps
 * the furthest position and answers 409 while the message's own save is
 * still in flight.
 */
export function markChatThreadRead(
  userId: string,
  threadId: string,
  messageId: string,
  options: ApiMutationOptions = {},
): Promise<{ thread_id: string; last_read_message_id: string | null }> {
  return apiRequest(userId, `/api/chat/threads/${pathId(threadId)}/read`, {
    method: "PUT",
    body: { message_id: messageId },
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
/** Abort a streaming attempt when no bytes — including SSE keep-alives —
 * arrive. Idle thinking is not a stall; the API comments every 10s. */
const STREAM_STALL_MS = 45_000;

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

/** Aborts reject with a DOMException, which is not an Error in every
 * environment; its name is what identifies it. */
function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

/** Watchdog for a silent TCP/SSE socket. Any received chunk, including
 * keep-alive comments, resets the timer. timeoutMs <= 0 disables it. */
function createStallWatchdog(timeoutMs: number, onStall: () => void) {
  if (timeoutMs <= 0) {
    return { bump() {}, didStall: () => false, stop() {} };
  }
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      onStall();
    }, timeoutMs);
  };
  bump();
  return {
    bump,
    didStall: () => stalled,
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Matches the API's segment join: continuation text flows straight on when
 * the partial ends with whitespace, otherwise starts a new paragraph.
 */
function segmentJoiner(baseText: string): string {
  return !baseText || baseText.endsWith("\n") || baseText.endsWith(" ") ? "" : "\n\n";
}

const CANCELLED_RESPONSE_MESSAGE = "The response was cancelled before it finished.";

/** Hands a well-formed activity event to the caller; anything else is dropped. */
function reportActivity(raw: unknown, onActivity?: (activity: ChatStreamActivity) => void) {
  const activity = parseStreamActivity(raw);
  if (activity && onActivity) onActivity(activity);
}

/** A user stop ends the generation at once, keeping what already streamed. */
function throwIfStopped(signal: AbortSignal | undefined, partialText: string) {
  if (signal?.aborted) throw new ChatRequestError(CANCELLED_RESPONSE_MESSAGE, undefined, partialText);
}

/** A new id for a server-owned run: what the API calls `run_id`. */
export function newChatRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

/** The connection dropped while the reply may still be generating on the
 * server; following its run again picks up where this one stopped. */
class StreamDropError extends ChatRequestError {
  constructor(message: string, partialText: string) {
    super(message, undefined, partialText, true);
  }
}

/** The server no longer has the run (it restarted, or the run is long past),
 * so the reply continues as a new run from the text already received. */
class RunGoneError extends ChatRequestError {
  constructor(message: string, partialText: string) {
    super(message, 404, partialText, true);
  }
}

export type SendChatStreamOptions = {
  model: string;
  messages: ChatWireMessage[];
  runtime?: ChatRuntimeOptions;
  signal?: AbortSignal;
  onDelta?: (fullText: string) => void;
  /** Called when the API reports the prompt as stored with personal data
   * concealed, so the bubble can show the same text immediately. */
  onConcealedPrompt?: (concealed: string) => void;
  /** What the API reports doing for this reply (context gathered,
   * continuation rounds, screening, checks), plus reconnects made here. */
  onActivity?: (activity: ChatStreamActivity) => void;
  /**
   * Already-streamed assistant text, used after a page reload or a dropped
   * connection so the next attempt continues instead of starting over.
   */
  initialText?: string;
  /** The server-owned run generating this reply. With one, the reply keeps
   * generating when this page goes away, and a dropped connection follows
   * the same run again instead of asking the model to continue. */
  runId?: string;
  /** Start by following `runId` (a page that came back) instead of
   * starting it. */
  attach?: boolean;
  /** Called when the reply continues under a new run, so the caller can
   * record which run to follow after a reload. */
  onRun?: (runId: string) => void;
  /** Called just before the reply so far arrives in one piece, when a
   * page that came back starts following a run. Activities follow it. */
  onSnapshot?: () => void;
  /** Test hook: how new run ids are made. */
  newRunId?: () => string;
  /** Test hook: overrides the reconnect backoff schedule. */
  resumeDelaysMs?: number[];
  /** Test hook: overrides the no-bytes stall timeout. 0 disables it. */
  stallTimeoutMs?: number;
};

export function sendChatStream(userId: string, options: SendChatStreamOptions): Promise<ChatAssistantReply> {
  return new ResumableReply(userId, options).finish();
}

/** The run being followed, and the last frame position received from it. */
type FollowedRun = { id: string; position: number; follow: boolean };

/**
 * One reply, carried to its end across failures. A generation ends when the
 * completion marker arrives, the provider reports a non-retryable failure, or
 * the user hits stop. Thinking time with keep-alives is not a stall. A socket
 * that goes silent — no deltas and no keep-alives — is aborted; a server run
 * is then followed again, and a reply without one is resumed with the
 * partial text.
 */
class ResumableReply {
  private fullText: string;
  private stalledAttempts = 0;
  private reconnects = 0;
  private run: FollowedRun | null;

  constructor(
    private readonly userId: string,
    private readonly options: SendChatStreamOptions,
  ) {
    this.fullText = options.initialText || "";
    this.run = options.runId ? { id: options.runId, position: 0, follow: Boolean(options.attach) } : null;
  }

  async finish(): Promise<ChatAssistantReply> {
    while (true) {
      const progressBefore = this.fullText.length;
      try {
        return await this.attempt();
      } catch (error) {
        await this.recover(error, progressBefore);
      }
    }
  }

  private attempt(): Promise<ChatAssistantReply> {
    const { model, messages, runtime, onDelta, onConcealedPrompt, onActivity, onSnapshot, signal } = this.options;
    const attempt: StreamAttempt = {
      signal,
      baseText: this.fullText,
      stallTimeoutMs: this.options.stallTimeoutMs ?? STREAM_STALL_MS,
      onText: (text) => {
        this.fullText = text;
      },
      onPosition: (position) => {
        if (this.run) this.run.position = position;
      },
      onDelta,
      onConcealedPrompt,
      onActivity,
      onSnapshot,
    };
    if (this.run?.follow) {
      return followRunOnce(this.userId, { ...attempt, runId: this.run.id, after: this.run.position });
    }
    return streamChatOnce(this.userId, {
      ...attempt,
      model,
      messages: continuationOf(messages, this.fullText),
      runtime,
      runId: this.run?.id,
    });
  }

  /** Waits out a resumable failure and chooses the next attempt; any other
   * failure, a stop, or too many attempts without progress ends the reply. */
  private async recover(error: unknown, progressBefore: number): Promise<void> {
    const { signal } = this.options;
    throwIfStopped(signal, this.fullText);
    this.countAttempt(error, progressBefore);
    if (error instanceof RunGoneError) {
      this.startNewRun();
      return;
    }
    await abortableDelay(resumeBackoff(this.stalledAttempts, this.options.resumeDelaysMs || STREAM_RESUME_BACKOFF_MS), signal);
    throwIfStopped(signal, this.fullText);
    if (this.run && error instanceof StreamDropError) this.run.follow = true;
    else this.startNewRun();
    this.reconnects += 1;
    this.options.onActivity?.({ kind: "resume", attempt: this.reconnects });
  }

  /** The counter resets whenever an attempt made progress, so only a
   * connection that is repeatedly dead with no progress ends the run. */
  private countAttempt(error: unknown, progressBefore: number) {
    if (!(error instanceof ChatRequestError) || !error.resumable) throw error;
    this.stalledAttempts = this.fullText.length > progressBefore ? 1 : this.stalledAttempts + 1;
    if (this.stalledAttempts > MAX_STREAM_RESUME_ATTEMPTS) throw error;
  }

  private startNewRun() {
    if (!this.run) return;
    this.run = { id: (this.options.newRunId || newChatRunId)(), position: 0, follow: false };
    this.options.onRun?.(this.run.id);
  }
}

/** The conversation for an attempt: with text so far, ask to continue it. */
function continuationOf(messages: ChatWireMessage[], fullText: string): ChatWireMessage[] {
  if (!fullText) return messages;
  return [
    ...messages,
    { role: "assistant", content: fullText },
    { role: "user", content: STREAM_CONTINUATION_PROMPT },
  ];
}

/** Asks the server to stop a run. Closing the page never stops one. */
export function cancelChatRun(userId: string, runId: string): Promise<{ id: string; status: string }> {
  return apiRequest<{ id: string; status: string }>(userId, `/api/chat/runs/${pathId(runId)}/cancel`, {
    method: "POST",
  });
}

/** What one streaming request reports back while it reads. */
type StreamAttempt = {
  signal?: AbortSignal;
  /** The reply text before this request: continued, never repeated. */
  baseText: string;
  stallTimeoutMs: number;
  onText: (fullText: string) => void;
  /** The position of the last frame fully read, for following a run again. */
  onPosition: (position: number) => void;
  onDelta?: (fullText: string) => void;
  onConcealedPrompt?: (concealed: string) => void;
  onActivity?: (activity: ChatStreamActivity) => void;
  onSnapshot?: () => void;
};

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** One streaming attempt. Resumability is decided per failure: transport
 * drops and API-flagged retryable errors can be resumed by the caller;
 * deterministic failures surface immediately. */
async function streamChatOnce(
  userId: string,
  options: StreamAttempt & {
    model: string;
    messages: ChatWireMessage[];
    runtime?: ChatRuntimeOptions;
    runId?: string;
  },
): Promise<ChatAssistantReply> {
  const { model, messages, runtime, runId } = options;
  return runStreamAttempt(options, 0, async (requestSignal, reader) => {
    const response = await fetch(`${apiBase}/api/chat/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(userId),
      },
      body: JSON.stringify(chatRequestBody(model, messages, runtime, true, runId)),
      signal: requestSignal,
    });
    if (!response.ok) return completeAfterRefusal(userId, options, response, reader);
    if ((response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
      const reply = chatReplyFromCompletion((await response.json()) as ChatCompletionResponse);
      if (reply.concealedPrompt) options.onConcealedPrompt?.(reply.concealedPrompt);
      return { ...reply, content: reader.joinWhole(reply.content) };
    }
    return reader.read(response);
  });
}

/** Image models answer whole, never streamed: that one refusal is retried
 * without streaming. Every other refusal ends the attempt. */
async function completeAfterRefusal(
  userId: string,
  options: { model: string; messages: ChatWireMessage[]; runtime?: ChatRuntimeOptions; signal?: AbortSignal },
  response: Response,
  reader: EventStreamReader,
): Promise<ChatAssistantReply> {
  const detail = await readApiError(response);
  if (response.status === 400 && /image models return complete responses; retry without streaming/i.test(detail)) {
    const { model, messages, runtime, signal } = options;
    const reply = await sendChat(userId, { model, messages, runtime, signal });
    return { ...reply, content: reader.joinWhole(reply.content) };
  }
  throw new ChatRequestError(detail, response.status, reader.text(), retryableStatus(response.status));
}

/** Follows a server run from frame `after` on: a page that came back, or a
 * connection that dropped while the run kept generating. */
async function followRunOnce(
  userId: string,
  options: StreamAttempt & { runId: string; after: number },
): Promise<ChatAssistantReply> {
  const { runId, after } = options;
  return runStreamAttempt(options, after, async (requestSignal, reader) => {
    const response = await fetch(`${apiBase}/api/chat/runs/${pathId(runId)}/events?after=${after}`, {
      headers: authHeaders(userId),
      signal: requestSignal,
    });
    if (response.status === 404) throw new RunGoneError(await readApiError(response), reader.text());
    if (!response.ok) {
      throw new ChatRequestError(await readApiError(response), response.status, reader.text(), retryableStatus(response.status));
    }
    return reader.read(response);
  });
}

/** Runs one request with a stall watchdog, turning transport failures into
 * drops that carry the text received so far. */
async function runStreamAttempt(
  attempt: StreamAttempt,
  after: number,
  request: (signal: AbortSignal, reader: EventStreamReader) => Promise<ChatAssistantReply>,
): Promise<ChatAssistantReply> {
  const { signal, stallTimeoutMs } = attempt;
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const watchdog = createStallWatchdog(stallTimeoutMs, () => controller.abort());
  const reader = new EventStreamReader(attempt, after, watchdog);
  try {
    return await request(controller.signal, reader);
  } catch (error) {
    throw transportFailure(error, signal, reader.text());
  } finally {
    watchdog.stop();
  }
}

function transportFailure(error: unknown, signal: AbortSignal | undefined, partialText: string): ChatRequestError {
  if (error instanceof ChatRequestError) return error;
  if (!isAbortError(error)) {
    return new StreamDropError("Could not reach the model. Check your connection and try again.", partialText);
  }
  if (signal?.aborted) return new ChatRequestError(CANCELLED_RESPONSE_MESSAGE, undefined, partialText);
  return new StreamDropError("The chat stream stalled before the completion marker arrived.", partialText);
}

/** An event field that is a plain object, else null. */
function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function parseEventData(data: string, partialText: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new ChatRequestError("The chat API returned a malformed streaming event.", undefined, partialText);
  }
}

function framePositionOf(line: string): number | null {
  const position = Number.parseInt(line.slice(3).trim(), 10);
  return Number.isFinite(position) ? position : null;
}

function eventStreamBody(response: Response): ReadableStream<Uint8Array> {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    throw new ChatRequestError(`The chat API returned an unsupported content type: ${contentType || "unknown"}.`);
  }
  if (!response.body) {
    throw new ChatRequestError("The chat API opened a stream without a response body.");
  }
  return response.body;
}

/** Reads the API's Server-Sent Events into the reply. A follow that resumes
 * mid-run (`after` > 0) continues the same text; a new request or a fresh
 * follow starts a new segment after the text before it. */
class EventStreamReader {
  private fullText: string;
  /** Prepended to the first delta of a new segment; empty mid-run. */
  private joiner: string;
  private doneEventSeen = false;
  private citations: ChatCitation[] = [];
  private usage: ChatTokenUsage | undefined;
  private memoryUsed = 0;
  private memorySaved: MemorySavedNotice[] = [];
  private concealedPrompt: string | undefined;
  private questions: ClarifyQuestions | null = null;
  /** A frame's position counts once its data has been read, so a connection
   * cut between the two reads that frame again. */
  private framePosition: number | null = null;

  constructor(
    private readonly attempt: StreamAttempt,
    after: number,
    private readonly watchdog: { bump: () => void },
  ) {
    this.fullText = attempt.baseText;
    this.joiner = after > 0 ? "" : segmentJoiner(attempt.baseText);
  }

  text(): string {
    return this.fullText;
  }

  /** A complete (non-streamed) reply joined onto the text before it. */
  joinWhole(content: string): string {
    const base = this.attempt.baseText;
    return base ? `${base}${segmentJoiner(base)}${content}` : content;
  }

  async read(response: Response): Promise<ChatAssistantReply> {
    const body = eventStreamBody(response);
    this.watchdog.bump();
    await this.consume(body.getReader());
    if (!this.doneEventSeen) {
      throw new StreamDropError("The chat stream ended before the completion marker arrived.", this.fullText);
    }
    if (!this.fullText && !this.questions) {
      throw new ChatRequestError("The model returned an empty response.", undefined, undefined, true);
    }
    return {
      // A paused reply's lead-in travels with its questions.
      content: this.questions ? "" : this.fullText,
      citations: this.citations,
      usage: this.usage,
      memoryUsed: this.memoryUsed,
      memorySaved: this.memorySaved,
      concealedPrompt: this.concealedPrompt,
      ...(this.questions ? { questions: this.questions } : {}),
    };
  }

  private async consume(bodyReader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    while (!this.doneEventSeen) {
      const chunk = await bodyReader.read();
      this.watchdog.bump();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer = this.processLines(buffer + decoder.decode(chunk.value, { stream: true }));
    }
    if (!this.doneEventSeen && buffer.trim()) this.processLine(buffer);
  }

  /** Reads each complete line; returns the unfinished rest. */
  private processLines(buffer: string): string {
    let rest = buffer;
    let newline = rest.indexOf("\n");
    while (newline >= 0 && !this.doneEventSeen) {
      this.processLine(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
      newline = rest.indexOf("\n");
    }
    return rest;
  }

  private processLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("id:")) {
      this.framePosition = framePositionOf(line);
      return;
    }
    // Other non-data lines include SSE keep-alive comments the API emits
    // while the model is thinking; they carry no content and are skipped.
    if (!line.startsWith("data:")) return;
    this.readData(line.slice(5).trimStart());
    if (this.framePosition !== null) this.attempt.onPosition(this.framePosition);
    this.framePosition = null;
  }

  private readData(data: string): void {
    if (data === "[DONE]") {
      this.doneEventSeen = true;
      return;
    }
    const event = data ? parseEventData(data, this.fullText) : null;
    if (isRecord(event)) this.applyEvent(event);
  }

  private applyEvent(record: Record<string, unknown>): void {
    if (typeof record.error === "string" && record.error.trim()) {
      throw new ChatRequestError(record.error, undefined, this.fullText, record.retryable === true);
    }
    const snapshot = objectField(record, "snapshot");
    if (snapshot) this.applySnapshot(snapshot);
    this.showConcealedPrompt(objectField(record, "privacy")?.concealed_prompt);
    reportActivity(record.activity, this.attempt.onActivity);
    if (typeof record.delta === "string" && record.delta) this.appendDelta(record.delta);
    this.questions = parseClarifyQuestions(record.questions) ?? this.questions;
    if (record.done === true) this.recordDone(record);
  }

  private appendDelta(delta: string): void {
    this.fullText += this.joiner + delta;
    this.joiner = "";
    this.attempt.onText(this.fullText);
    this.attempt.onDelta?.(this.fullText);
  }

  private recordDone(record: Record<string, unknown>): void {
    this.citations = Array.isArray(record.citations) ? (record.citations as ChatCitation[]) : [];
    this.usage = normalizeTokenUsage(record.usage);
    this.memoryUsed = typeof record.memory_used === "number" ? record.memory_used : 0;
    this.memorySaved = Array.isArray(record.memory_saved) ? (record.memory_saved as MemorySavedNotice[]) : [];
  }

  private showConcealedPrompt(concealed: unknown): void {
    if (typeof concealed !== "string" || !concealed) return;
    this.concealedPrompt = concealed;
    this.attempt.onConcealedPrompt?.(concealed);
  }

  /** The reply so far, in one piece, for a page following a run it did not
   * start. `base` is the text the run itself continued. */
  private applySnapshot(snapshot: Record<string, unknown>): void {
    const base = typeof snapshot.base === "string" ? snapshot.base : this.attempt.baseText;
    const text = typeof snapshot.text === "string" ? snapshot.text : "";
    this.attempt.onSnapshot?.();
    this.fullText = base;
    this.joiner = segmentJoiner(base);
    this.showConcealedPrompt(snapshot.concealed_prompt);
    const activities: unknown[] = Array.isArray(snapshot.activities) ? snapshot.activities : [];
    for (const activity of activities) reportActivity(activity, this.attempt.onActivity);
    this.questions = parseClarifyQuestions(snapshot.questions);
    if (text) this.appendDelta(text);
    else this.attempt.onText(this.fullText);
  }
}

function chatRequestBody(
  model: string,
  messages: ChatWireMessage[],
  runtime: ChatRuntimeOptions | undefined,
  stream: boolean,
  runId?: string,
) {
  return {
    model,
    messages,
    stream,
    surface: runtime?.surface ?? "chat",
    thread_id: runtime?.threadId ?? null,
    ...(runId ? { run_id: runId } : {}),
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
    clarify_mode: runtime?.clarifyMode ?? null,
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
    concealedPrompt: typeof data.concealed_prompt === "string" && data.concealed_prompt ? data.concealed_prompt : undefined,
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

/** Takes back a file staged but never sent. The server refuses once a chat
 * holds the file, so a saved message cannot lose it from here. */
export function deleteChatAttachment(userId: string, attachmentId: string): Promise<unknown> {
  return apiRequest<unknown>(userId, `/api/chat/attachments/${pathId(attachmentId)}`, { method: "DELETE" });
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

/** Brings a knowledge document, or with no document_id a whole base, into the
 * chat as an attachment that points at it. */
export function attachKnowledge(
  userId: string,
  payload: { knowledge_config_id: string; document_id?: string },
  options: ApiMutationOptions = {},
): Promise<ChatAttachment> {
  return apiRequest<ChatAttachment>(userId, "/api/chat/attachments/knowledge", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function submitChatFeedback(
  userId: string,
  payload: ChatFeedbackSubmitRequest,
  options: ApiMutationOptions = {},
): Promise<ChatFeedbackRecord> {
  return apiRequest<ChatFeedbackRecord>(userId, "/api/chat/feedback", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}
