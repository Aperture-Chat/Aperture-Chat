import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatRequestError,
  deleteChatThread,
  generateChatThreadTitle,
  listChatThreads,
  renameChatThread,
  runAutomation,
  saveChatThread,
  sendChatStream,
  type ChatRuntimeOptions,
  type ChatWireMessage,
} from "./api";
import type {
  Automation,
  BootstrapData,
  ChatActivityTraceStep,
  ChatAttachment,
  ChatMessage,
  ChatThread,
  ModelConfig,
} from "./types";
import { replaceDiagramFence } from "./markdown";
import { preferredModel, usableModels } from "./modelAccess";
import { formatTimeLabel, platformTimestamp, type PlatformTimestamp } from "./serverClock";

const STORAGE_PREFIX = "aperture-chats-v2";
const DEFAULT_MODEL_PREFIX = "aperture-default-model";

export type ChatResponseVersion = {
  id: string;
  label: string;
  content: string;
  status?: ChatMessage["status"];
  citations?: ChatMessage["citations"];
  attachments?: ChatMessage["attachments"];
  usage?: ChatMessage["usage"];
  memoryUsed?: ChatMessage["memoryUsed"];
  memorySaved?: ChatMessage["memorySaved"];
  createdAt?: string;
  createdAtIso?: string | null;
  executedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  activityTrace?: ChatMessage["activityTrace"];
  startedAtMs?: number;
  metadata?: Record<string, unknown>;
};

function storageKey(persona: string) {
  return `${STORAGE_PREFIX}-${persona}`;
}

function defaultModelStorageKey(persona: string) {
  return `${DEFAULT_MODEL_PREFIX}-${persona}`;
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function timestampDurationMs(start: PlatformTimestamp, end: PlatformTimestamp) {
  const startMs = Date.parse(start.iso);
  const endMs = Date.parse(end.iso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function deriveTitle(content: string) {
  const clean = content.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  const words = clean.split(" ").slice(0, 7).join(" ");
  return words.length > 48 ? `${words.slice(0, 45).trimEnd()}…` : words;
}

function wordCount(content: string) {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

function stripBranchPrefix(title: string) {
  return title.replace(/^(Branch:\s*)+/i, "").trim();
}

function normalizeBranchTitle(title: string) {
  if (!/^(Branch:\s*){2,}/i.test(title)) return title;
  return `Branch: ${stripBranchPrefix(title) || "New chat"}`;
}

function persistableRuntime(runtime?: ChatRuntimeOptions): ChatRuntimeOptions | undefined {
  if (!runtime) return undefined;
  const persisted: ChatRuntimeOptions = {};
  if (runtime.agentProfileId) persisted.agentProfileId = runtime.agentProfileId;
  if (runtime.modelOverride) persisted.modelOverride = runtime.modelOverride;
  if (runtime.knowledgeConfigIds?.length) persisted.knowledgeConfigIds = [...runtime.knowledgeConfigIds];
  if (runtime.toolConfigIds?.length) persisted.toolConfigIds = [...runtime.toolConfigIds];
  if (typeof runtime.webEnabled === "boolean") persisted.webEnabled = runtime.webEnabled;
  if (runtime.fetchUrls?.length) persisted.fetchUrls = [...runtime.fetchUrls];
  if (typeof runtime.agentEnabled === "boolean") persisted.agentEnabled = runtime.agentEnabled;
  if (typeof runtime.citationsEnabled === "boolean") persisted.citationsEnabled = runtime.citationsEnabled;
  if (typeof runtime.maxCompletionTokens === "number") persisted.maxCompletionTokens = runtime.maxCompletionTokens;
  if (runtime.reasoningEffort) persisted.reasoningEffort = runtime.reasoningEffort;
  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

function runtimeFromMessage(message: ChatMessage | undefined): ChatRuntimeOptions | undefined {
  const value = message?.metadata?.chatRuntime;
  return value && typeof value === "object" ? (value as ChatRuntimeOptions) : undefined;
}

function versionFromMessage(message: ChatMessage, index: number): ChatResponseVersion {
  return {
    id: typeof message.metadata?.activeResponseVersionId === "string"
      ? message.metadata.activeResponseVersionId
      : message.id || `version-${index + 1}`,
    label: `Version ${index + 1}`,
    content: message.content,
    status: message.status,
    citations: message.citations ?? [],
    attachments: message.attachments ?? [],
    usage: message.usage ?? null,
    memoryUsed: message.memoryUsed,
    memorySaved: message.memorySaved,
    createdAt: message.createdAt,
    createdAtIso: message.createdAtIso ?? null,
    executedAt: message.executedAt ?? null,
    completedAt: message.completedAt ?? null,
    durationMs: message.durationMs ?? null,
    activityTrace: message.activityTrace ?? [],
    metadata: message.metadata ?? {},
  };
}

function isChatResponseVersion(value: unknown): value is ChatResponseVersion {
  if (!value || typeof value !== "object") return false;
  const version = value as ChatResponseVersion;
  return typeof version.id === "string" && typeof version.label === "string" && typeof version.content === "string";
}

export function responseVersionsForMessage(message: ChatMessage): ChatResponseVersion[] {
  if (message.role !== "assistant") return [];
  const rawVersions = message.metadata?.responseVersions;
  if (Array.isArray(rawVersions)) {
    const versions = rawVersions.filter(isChatResponseVersion);
    if (versions.length > 0) return versions;
  }
  return [versionFromMessage(message, 0)];
}

export function activeResponseVersionIndex(message: ChatMessage): number {
  const versions = responseVersionsForMessage(message);
  if (versions.length === 0) return 0;
  const rawIndex = message.metadata?.activeResponseVersionIndex;
  if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex)) return 0;
  return Math.min(Math.max(rawIndex, 0), versions.length - 1);
}

function withResponseVersions(message: ChatMessage, versions: ChatResponseVersion[], activeIndex: number): ChatMessage {
  const boundedIndex = Math.min(Math.max(activeIndex, 0), Math.max(versions.length - 1, 0));
  const active = versions[boundedIndex] ?? versionFromMessage(message, 0);
  // The failure notice belongs to the active version: a failed attempt keeps
  // its note when selected, and a successful sibling never inherits one.
  const activeFailureNotice = active.metadata?.failureNotice;
  return {
    ...message,
    content: active.content,
    status: active.status ?? message.status,
    citations: active.citations ?? [],
    // Versions saved before attachments were captured have no attachments
    // field; those keep the message's own attachments rather than clearing.
    attachments: active.attachments ?? message.attachments,
    usage: active.usage ?? null,
    memoryUsed: active.memoryUsed ?? message.memoryUsed,
    memorySaved: active.memorySaved ?? message.memorySaved,
    createdAt: active.createdAt ?? message.createdAt,
    createdAtIso: active.createdAtIso ?? message.createdAtIso,
    executedAt: active.executedAt ?? message.executedAt,
    completedAt: active.completedAt ?? message.completedAt,
    durationMs: active.durationMs ?? message.durationMs,
    activityTrace: active.activityTrace ?? [],
    startedAtMs: active.startedAtMs ?? message.startedAtMs,
    metadata: {
      ...(message.metadata ?? {}),
      ...(typeof activeFailureNotice === "string"
        ? { failureNotice: activeFailureNotice }
        : { failureNotice: undefined }),
      responseVersions: versions,
      activeResponseVersionIndex: boundedIndex,
      activeResponseVersionId: active.id,
    },
  };
}

export function messageWithActiveResponseVersion(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  return withResponseVersions(message, responseVersionsForMessage(message), activeResponseVersionIndex(message));
}

function regenerationQualityMessage(sourceMessage: ChatMessage): ChatWireMessage | null {
  const activeMessage = messageWithActiveResponseVersion(sourceMessage);
  const words = wordCount(activeMessage.content);
  if (words === 0) return null;
  return {
    role: "system",
    content: [
      "Regeneration guidance: generate a fresh alternative answer for the same user request.",
      `The currently selected version is about ${words} words; treat it as the quality floor.`,
      "Match or exceed its specificity, coverage, citations, and actionable detail unless the original user request explicitly asked for brevity.",
      "Do not mention this regeneration guidance in the answer.",
    ].join(" "),
  };
}

export function targetModelForRequest(
  enabledModels: ModelConfig[],
  threadModelId: string,
  fallbackModel: string,
  runtime?: ChatRuntimeOptions,
) {
  const requestedModel = runtime?.modelOverride || threadModelId;
  const availableRequestedModel = enabledModels.find((item) => item.id === requestedModel);
  const availableThreadModel = enabledModels.find((item) => item.id === threadModelId);
  // Model selection is a user contract. Complexity affects the work trace and
  // continuation behavior, but must never silently substitute another model.
  return availableRequestedModel?.id ?? availableThreadModel?.id ?? fallbackModel;
}

function normalizeThread(thread: ChatThread): ChatThread {
  const title = normalizeBranchTitle(thread.title);
  const messages = foldRegeneratedMessages(thread.messages);
  return title === thread.title && messages === thread.messages ? thread : { ...thread, title, messages };
}

function foldRegeneratedMessages(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const indexById = new Map<string, number>();
  const folded: ChatMessage[] = [];
  for (const message of messages) {
    const regeneratedFromId = message.metadata?.regeneratedFromMessageId;
    if (message.role === "assistant" && typeof regeneratedFromId === "string" && indexById.has(regeneratedFromId)) {
      const targetIndex = indexById.get(regeneratedFromId)!;
      const target = folded[targetIndex];
      const versions = responseVersionsForMessage(target);
      folded[targetIndex] = withResponseVersions(
        target,
        [...versions, versionFromMessage(message, versions.length)],
        versions.length,
      );
      changed = true;
      continue;
    }
    indexById.set(message.id, folded.length);
    folded.push(message);
  }
  return changed ? folded : messages;
}

const STOPPED_RESPONSE_MESSAGE =
  "You stopped this response before it finished. Regenerate or resend the message to run it again.";

const STREAM_RENDER_INTERVAL_MS = 80;
const STREAM_PERSIST_INTERVAL_MS = 2500;

function createThrottledStreamUpdate(render: (fullText: string) => void) {
  let latest = "";
  let lastRenderedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    lastRenderedAt = Date.now();
    render(latest);
  };

  return {
    push(fullText: string) {
      latest = fullText;
      const remaining = STREAM_RENDER_INTERVAL_MS - (Date.now() - lastRenderedAt);
      if (remaining <= 0) {
        flush();
      } else if (timer === undefined) {
        timer = setTimeout(flush, remaining);
      }
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function createThrottledPersist(save: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSavedAt = 0;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    lastSavedAt = Date.now();
    save();
  };
  return {
    touch() {
      const remaining = STREAM_PERSIST_INTERVAL_MS - (Date.now() - lastSavedAt);
      if (remaining <= 0) {
        flush();
      } else if (timer === undefined) {
        timer = setTimeout(flush, remaining);
      }
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function withStreamedPendingContent(message: ChatMessage, fullText: string): ChatMessage {
  const rawVersions = message.metadata?.responseVersions;
  if (Array.isArray(rawVersions) && rawVersions.length > 0) {
    const versions = responseVersionsForMessage(message);
    return withResponseVersions(
      message,
      versions.map((version, index, currentVersions) =>
        index === currentVersions.length - 1 ? { ...version, content: fullText } : version,
      ),
      versions.length - 1,
    );
  }
  return { ...message, content: fullText };
}

function streamedFailureContent(
  error: unknown,
  stopped: boolean,
  streamedText: string,
): { content: string; notice: string | null } {
  const partial =
    error instanceof ChatRequestError && error.partialText !== undefined
      ? error.partialText
      : streamedText;
  const notice = stopped
    ? STOPPED_RESPONSE_MESSAGE
    : error instanceof ChatRequestError
      ? actionableRequestMessage(error)
      : "Something went wrong reaching the model. Please try again.";
  // With a real partial, the streamed text stays the message body and the
  // notice travels in metadata so the UI renders the reply as a reply with
  // a compact failure note — not one giant error block.
  return partial ? { content: partial, notice } : { content: notice, notice: null };
}

/** Server refusals that name a required next step the user cannot guess. */
function actionableRequestMessage(error: ChatRequestError): string {
  if (error.status === 403 && error.message.includes("MCP tool approval required")) {
    return (
      `${error.message} Send the message again and choose Approve when the ` +
      "confirmation appears. If the tool was enabled for this workspace while " +
      "this tab was open, reload the page first so it picks up the change."
    );
  }
  return error.message;
}

/**
 * The in-browser SSE request dies on refresh, but the partial answer is
 * kept as pending so the store can reopen the same completion and continue.
 */
export function resumablePendingAssistant(thread: ChatThread): ChatMessage | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    const active = messageWithActiveResponseVersion(message);
    if (active.role === "assistant" && active.status === "pending") return message;
  }
  return null;
}

function isThreadArray(value: unknown): value is ChatThread[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as ChatThread).id === "string" &&
        Array.isArray((item as ChatThread).messages),
    )
  );
}

function loadThreads(persona: string): ChatThread[] {
  try {
    const raw = window.localStorage.getItem(storageKey(persona));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isThreadArray(parsed) && parsed.length > 0) {
        return parsed
          .filter((thread) => !thread.owner_user_id || thread.owner_user_id === persona)
          .map((thread) => normalizeThread(thread));
      }
    }
  } catch {
    // Corrupt or unavailable storage starts from an empty history.
  }
  // No demo seeding: Pinned/Recent start empty and only fill from real chats.
  return [];
}

function loadDefaultModelId(persona: string, enabledModels: ModelConfig[]): string | null {
  try {
    const saved = window.localStorage.getItem(defaultModelStorageKey(persona));
    if (saved && enabledModels.some((model) => model.id === saved)) {
      return saved;
    }
    // A saved id that is not usable RIGHT NOW is kept, never deleted: the
    // usable-model list is transient (bootstrap still loading, "view as"
    // role previews, a provider briefly disabled), and the starred default
    // must survive every one of those. It simply does not apply until its
    // model is usable again; starring another model overwrites it.
  } catch {
    // Default model preference is a convenience; fall back to the first usable model.
  }
  return null;
}

/** A blank, unsent "New chat" placeholder (filtered out of the sidebar lists). */
export function isBlankNewChat(thread: ChatThread): boolean {
  return thread.messages.length === 0 && thread.title === "New chat";
}

function createBlankThread(data: BootstrapData, modelId: string): ChatThread {
  // Bootstrap can include other visible workspace groups. A saved personal
  // chat must use the actor's membership, even for tenant administrators.
  const group = data.me.role === "PLATFORM_OWNER"
    ? data.groups[0]
    : data.groups.find((item) => data.me.group_ids.includes(item.id));
  return {
    id: uid("local"),
    tenant_id: data.currentTenant?.id ?? "tenant-example",
    owner_user_id: data.me.id,
    title: "New chat",
    model_id: modelId,
    group_id: group?.id ?? "",
    pinned: false,
    archived: false,
    folder_id: null,
    used_agent: false,
    updated_at: "Just now",
    messages: [],
  };
}

function buildActivityTrace(
  data: BootstrapData,
  modelId: string,
  content: string,
  attachments: ChatAttachment[],
  runtime?: ChatRuntimeOptions,
): ChatActivityTraceStep[] {
  const selectedModel = data.models.find((model) => model.id === modelId);
  const modelLabel = selectedModel?.name ?? modelId;
  const knowledgeCount = runtime?.knowledgeConfigIds?.length ?? 0;
  const toolCount = runtime?.toolConfigIds?.length ?? 0;
  const isLongForm = longFormRequested(content);
  const wantsImages = imageRequested(content);
  const trace: ChatActivityTraceStep[] = [
    {
      id: "route",
      label: "Routing request",
      detail: `Using ${modelLabel}.`,
    },
    {
      id: "context",
      label: "Preparing context",
      detail: contextDetail(knowledgeCount, toolCount, attachments.length),
    },
  ];

  if (runtime?.webEnabled) {
    trace.push({
      id: "web",
      label: "Web search requested",
      detail: "Provider-hosted public web search is enabled for this turn.",
    });
  }

  if (knowledgeCount > 0) {
    trace.push({
      id: "knowledge",
      label: "Retrieving workspace knowledge",
      detail: `${knowledgeCount} selected ${knowledgeCount === 1 ? "source" : "sources"} will be checked.`,
    });
  }

  if (toolCount > 0 || runtime?.agentEnabled) {
    trace.push({
      id: "tools",
      label: runtime?.agentEnabled ? "Preparing agent tools" : "Preparing tools",
      detail: toolCount > 0 ? `${toolCount} enabled ${toolCount === 1 ? "tool" : "tools"} in scope.` : "Agent workflow is enabled.",
    });
  }

  if (attachments.length > 0) {
    trace.push({
      id: "attachments",
      label: "Reading attachments",
      detail: `${attachments.length} uploaded ${attachments.length === 1 ? "file" : "files"} attached to the request.`,
    });
  }

  if (isLongForm) {
    trace.push({
      id: "scope",
      label: "Sizing long-form deliverable",
      detail: pageCountRequested(content)
        ? `Detected a ${pageCountRequested(content)}-page request; the response must be drafted as the deliverable, not an outline.`
        : "Detected a complete paper, report, memo, or draft request.",
    });
  }

  if (wantsImages) {
    trace.push({
      id: "visuals",
      label: "Preparing visual evidence",
      detail: "Images requested; the final answer can include transferable image blocks.",
    });
  }

  trace.push({
    id: "generate",
    label: isLongForm ? "Generating long-form answer" : "Generating answer",
    detail: isLongForm
      ? "The backend may continue internally until the full response is assembled."
      : "Waiting for the model response.",
  });
  if (isLongForm || wantsImages || runtime?.agentEnabled) {
    trace.push({
      id: "validator",
      label: "Content validator loop",
      detail: "A Hermes-light quality gate checks length, requested sections, and visuals before finalizing.",
    });
  }
  trace.push({
    id: "finalize",
    label: "Finalizing response",
    detail: "Formatting the answer, citations, and document-transfer actions.",
  });

  return trace;
}

function contextDetail(knowledgeCount: number, toolCount: number, attachmentCount: number) {
  const parts: string[] = [];
  if (knowledgeCount > 0) parts.push(`${knowledgeCount} knowledge ${knowledgeCount === 1 ? "source" : "sources"}`);
  if (toolCount > 0) parts.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  if (attachmentCount > 0) parts.push(`${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`);
  return parts.length > 0 ? parts.join(" · ") : "No extra sources selected.";
}

function longFormRequested(content: string) {
  return /\b(long[-\s]?form|paper|report|memo|brief|draft|pages?|comprehensive|complete)\b/i.test(content);
}

function imageRequested(content: string) {
  return /\b(images?|pictures?|photos?|graphics?|visuals?|charts?|diagrams?)\b/i.test(content);
}

function pageCountRequested(content: string) {
  const numeric = /\b(\d{1,3})\s*[- ]?\s*pages?\b/i.exec(content);
  if (numeric) return Number(numeric[1]);
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    ten: 10,
    twenty: 20,
    "twenty-five": 25,
    twentyfive: 25,
  };
  const normalized = content.toLowerCase().replace(/\s+/g, " ");
  if (/\btwenty[- ]five\s+pages?\b/.test(normalized)) return 25;
  for (const [word, value] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\s+pages?\\b`, "i").test(normalized)) return value;
  }
  return null;
}

/**
 * Default landing: a fresh blank "New chat" is the active conversation, while the
 * seeded demo threads stay in the list (and remain clickable). An existing blank
 * chat is reused so reloads never accumulate duplicate placeholders.
 */
function withBlankChat(
  threads: ChatThread[],
  data: BootstrapData,
  fallbackModel: string,
): { threads: ChatThread[]; activeId: string } {
  const existingBlank = threads.find(isBlankNewChat);
  if (existingBlank) {
    // Hydration must keep a usable choice already made in the unsent chat.
    // Defaults apply to new chats or a selection that is no longer available.
    const selectedModelUsable = usableModels(data).some((model) => model.id === existingBlank.model_id);
    if (fallbackModel && !selectedModelUsable) {
      const updatedBlank = { ...existingBlank, model_id: fallbackModel };
      return {
        threads: threads.map((thread) => (thread.id === existingBlank.id ? updatedBlank : thread)),
        activeId: existingBlank.id,
      };
    }
    return { threads, activeId: existingBlank.id };
  }
  const blank = createBlankThread(data, fallbackModel);
  return { threads: [blank, ...threads], activeId: blank.id };
}

function mergeServerThreads(
  localThreads: ChatThread[],
  serverThreads: ChatThread[],
  persona: string,
): ChatThread[] {
  const ownedServerThreads = serverThreads.filter(
    (thread) => !thread.owner_user_id || thread.owner_user_id === persona,
  );
  const serverIds = new Set(ownedServerThreads.map((thread) => thread.id));
  const localOnly = localThreads.filter(
    (thread) =>
      (!thread.owner_user_id || thread.owner_user_id === persona) &&
      !serverIds.has(thread.id),
  );
  return [...ownedServerThreads, ...localOnly].map(normalizeThread);
}

export function preservePendingTraceState(current: ChatThread, saved: ChatThread): ChatThread {
  const pendingById = new Map(
    current.messages
      .filter((message) => messageWithActiveResponseVersion(message).status === "pending")
      .map((message) => [message.id, message]),
  );
  if (pendingById.size === 0) return saved;

  return {
    ...saved,
    messages: saved.messages.map((message) => {
      const pending = pendingById.get(message.id);
      if (!pending) return message;
      // A completed server snapshot from another tab wins over a stale local
      // pending bubble so a finished answer is never reopened as in-flight.
      if (messageWithActiveResponseVersion(message).status === "ok") return message;
      return pending;
    }),
  };
}

function wireHistoryForPendingResume(thread: ChatThread, pendingMessage: ChatMessage): ChatWireMessage[] {
  const versions = responseVersionsForMessage(pendingMessage);
  const activeIndex = activeResponseVersionIndex(pendingMessage);
  const activeVersion = versions[activeIndex];
  const regeneratedFromUserId = activeVersion?.metadata?.regeneratedFromUserMessageId;
  if (typeof regeneratedFromUserId === "string") {
    const priorUserIndex = thread.messages.findIndex((message) => message.id === regeneratedFromUserId);
    if (priorUserIndex >= 0) {
      const priorVersion =
        versions.find((version, index) => index !== activeIndex && version.status === "ok") ?? versions[0];
      const qualitySource: ChatMessage = {
        ...pendingMessage,
        content: priorVersion?.content ?? "",
        status: "ok",
      };
      return [
        regenerationQualityMessage(qualitySource),
        ...wireMessagesFrom(thread.messages.slice(0, priorUserIndex + 1)),
      ].filter((message): message is ChatWireMessage => Boolean(message));
    }
  }
  return wireMessagesFrom(thread.messages);
}

function finalizeAssistantMessage(
  message: ChatMessage,
  patch: {
    content: string;
    status: "ok" | "error";
    citations?: ChatMessage["citations"];
    usage?: ChatMessage["usage"];
    memoryUsed?: number;
    memorySaved?: ChatMessage["memorySaved"];
    completed: PlatformTimestamp;
    executedAt?: string | null;
    durationMs: number | null;
    failureNotice?: string | null;
  },
): ChatMessage {
  const notice = patch.failureNotice;
  const applied = {
    content: patch.content,
    status: patch.status,
    citations: patch.citations ?? message.citations,
    usage: patch.usage ?? null,
    memoryUsed: patch.memoryUsed,
    memorySaved: patch.memorySaved,
    createdAt: patch.completed.label,
    createdAtIso: patch.completed.iso,
    executedAt: patch.executedAt ?? message.executedAt,
    completedAt: patch.completed.iso,
    durationMs: patch.durationMs,
    metadata: {
      ...(message.metadata ?? {}),
      clockSource: patch.completed.source,
      ...(notice ? { failureNotice: notice } : { failureNotice: undefined }),
    },
  };
  const rawVersions = message.metadata?.responseVersions;
  if (Array.isArray(rawVersions) && rawVersions.length > 0) {
    const versions = responseVersionsForMessage(message);
    return withResponseVersions(
      message,
      versions.map((version, index, currentVersions) =>
        index === currentVersions.length - 1
          ? {
              ...version,
              ...applied,
              metadata: {
                ...(version.metadata ?? {}),
                clockSource: patch.completed.source,
                ...(notice ? { failureNotice: notice } : { failureNotice: undefined }),
              },
            }
          : version,
      ),
      versions.length - 1,
    );
  }
  return { ...message, ...applied };
}

function wireMessagesFrom(messages: ChatMessage[]): ChatWireMessage[] {
  return messages
    .map((message) => messageWithActiveResponseVersion(message))
    .filter((message) => message.status !== "pending")
    // A failed turn without a failureNotice holds only the error or
    // stop/interruption text, never model output; replaying it as assistant
    // history would feed the provider a reply the model never gave. Partials
    // (failureNotice set) stay: their content is real streamed model text.
    .filter(
      (message) =>
        message.role !== "assistant" ||
        message.status !== "error" ||
        typeof message.metadata?.failureNotice === "string",
    )
    .map((activeMessage) => ({
      role: activeMessage.role,
      content: activeMessage.attachments?.length
        ? `${activeMessage.content}${activeMessage.content ? "\n\n" : ""}[Attached files: ${activeMessage.attachments
            .map((file) => file.name)
            .join(", ")}]`
        : activeMessage.content,
    }));
}

/** Most recent image uploads carried into follow-up requests so the model can
 * still see them when a later turn asks about an image. Bounded to keep the
 * request payload small; the server skips ids whose uploads no longer exist. */
const MAX_CONTEXT_IMAGE_ATTACHMENTS = 6;

function contextImageAttachmentIds(messages: ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const attachment of message.attachments ?? []) {
      const mimeType = attachment.mime_type?.split(";", 1)[0].trim().toLowerCase() ?? "";
      const isImage = attachment.kind.trim().toLowerCase() === "image" || mimeType.startsWith("image/");
      if (attachment.id && isImage) ids.push(attachment.id);
    }
  }
  return [...new Set(ids)].slice(-MAX_CONTEXT_IMAGE_ATTACHMENTS);
}

export type ChatStore = {
  threads: ChatThread[];
  activeId: string;
  activeThread: ChatThread | null;
  model: string;
  enabledModels: ModelConfig[];
  /** True only when the currently open thread has a model request in flight. */
  isSending: boolean;
  composerFocusToken: number;
  defaultModelId: string | null;
  selectThread: (id: string) => void;
  newChat: () => void;
  setModel: (modelId: string) => void;
  setDefaultModel: (modelId: string) => void;
  togglePin: (chatId: string) => void;
  /** Renames one persisted chat and updates every view backed by the thread store. */
  renameThread: (chatId: string, title: string) => Promise<void>;
  /**
   * Asks the API to rename a chat from its own conversation context. The
   * server generates and persists the title with the thread's model; the
   * store reconciles the saved thread everywhere it appears.
   */
  generateThreadTitle: (chatId: string) => Promise<void>;
  archiveThread: (chatId: string) => void;
  /** Returns an archived thread to the sidebar without changing its folder. */
  restoreThread: (chatId: string) => void;
  /** Permanently removes a thread locally and on the server. */
  deleteThread: (chatId: string) => void;
  moveThreadToFolder: (chatId: string, folderId: string | null) => void;
  branchFromMessage: (messageId: string) => ChatThread | null;
  regenerateResponse: (messageId: string) => boolean;
  /**
   * Edits a user message: truncates the thread at that message (dropping it
   * and everything after) and re-runs the normal send path with the edited
   * text plus the message's original attachments and runtime. Later answers
   * are never kept and assistant messages are never rewritten in place.
   */
  editUserMessage: (messageId: string, content: string) => boolean;
  /** Abort the in-flight request for a thread (default: active thread). */
  stopResponse: (threadId?: string) => boolean;
  selectResponseVersion: (messageId: string, versionIndex: number) => boolean;
  /**
   * Replaces one Mermaid diagram inside an assistant reply (reader-edited via
   * the diagram editor) and persists the thread. The active response version
   * is the source of truth for displayed content, so the fence is swapped
   * there and the message is rebuilt through withResponseVersions — editing
   * only message.content would silently revert on reload or version toggle.
   */
  updateAssistantDiagram: (messageId: string, previousSource: string, nextSource: string) => boolean;
  sendMessage: (content: string, attachments?: ChatAttachment[], runtime?: ChatRuntimeOptions) => void;
  sendMessageInNewThread: (content: string, attachments?: ChatAttachment[], runtime?: ChatRuntimeOptions) => ChatThread | null;
  /** Runs an automation immediately and records the run as an exchange in the
   * active thread. When `input` is provided it becomes the chain's first-step
   * input for this run (the user's typed question), replacing the stored
   * prompt. Resolves when the run finishes (or fails). */
  runAutomationNow: (automation: Automation, input?: string) => Promise<void>;
};

export function useChatStore(
  persona: string,
  data: BootstrapData,
  options: { enabled?: boolean } = {},
): ChatStore {
  const enabled = options.enabled ?? true;
  const enabledModels = useMemo(() => usableModels(data), [data]);

  const [defaultModelId, setDefaultModelIdState] = useState<string | null>(() => loadDefaultModelId(persona, enabledModels));
  const preferredFallbackModel = preferredModel(enabledModels)?.id ?? "";
  const savedDefaultModel = enabledModels.find((model) => model.id === defaultModelId) ?? null;
  const fallbackModel = savedDefaultModel?.id ?? preferredFallbackModel;

  // Compute the initial threads + active chat exactly once (so the random blank
  // id stays consistent between the two useState initializers).
  const initialState = useRef<{ threads: ChatThread[]; activeId: string } | null>(null);
  if (initialState.current === null) {
    initialState.current = withBlankChat(loadThreads(persona), data, fallbackModel);
  }

  const [threads, setThreads] = useState<ChatThread[]>(initialState.current.threads);
  const [activeId, setActiveId] = useState<string>(initialState.current.activeId);
  const [sendingThreadIds, setSendingThreadIds] = useState<string[]>([]);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const hydratedPersona = useRef(persona);
  const hydrationRequest = useRef(0);
  const sendingThreadIdsRef = useRef<Set<string>>(new Set());
  // One in-flight completion request per thread. Stop aborts the fetch, which
  // also closes the connection so the API cancels the provider work.
  const activeSendControllers = useRef<Map<string, { controller: AbortController; stopped: boolean }>>(new Map());
  // Pending assistant ids already handed to continuePendingAssistant so a
  // thread-list rerender cannot start a second completion for the same bubble.
  const resumedPendingIds = useRef(new Set<string>());

  const setThreadSending = useCallback((threadId: string, sending: boolean) => {
    const next = new Set(sendingThreadIdsRef.current);
    if (sending) {
      next.add(threadId);
    } else {
      next.delete(threadId);
    }
    sendingThreadIdsRef.current = next;
    setSendingThreadIds(Array.from(next));
  }, []);

  useEffect(() => {
    setDefaultModelIdState(loadDefaultModelId(persona, enabledModels));
  }, [enabledModels, persona]);

  // Re-hydrate when the persona changes (e.g. ?persona= switch on reload).
  useEffect(() => {
    if (!enabled) return;
    if (hydratedPersona.current === persona) return;
    hydratedPersona.current = persona;
    resumedPendingIds.current = new Set();
    const next = withBlankChat(loadThreads(persona), data, fallbackModel);
    setThreads(next.threads);
    setActiveId(next.activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, persona]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const requestId = hydrationRequest.current + 1;
    hydrationRequest.current = requestId;

    listChatThreads(persona)
      .then((serverThreads) => {
        if (!active || hydrationRequest.current !== requestId) return;
        const current = threadsRef.current;
        const merged = mergeServerThreads(current, serverThreads, persona).map((thread) => {
          const local = current.find((item) => item.id === thread.id);
          return local ? preservePendingTraceState(local, thread) : thread;
        });
        const next = withBlankChat(merged, data, fallbackModel);
        const activeThread = current.find((thread) => thread.id === activeIdRef.current);
        setThreads(next.threads);
        if (activeThread && isBlankNewChat(activeThread)) setActiveId(next.activeId);
      })
      .catch(() => {
        // Offline mode keeps the localStorage-backed cache as the source of truth.
      });
    return () => {
      active = false;
    };
  }, [data, enabled, fallbackModel, persona]);

  // Persist on any change.
  useEffect(() => {
    if (!enabled) return;
    try {
      window.localStorage.setItem(storageKey(persona), JSON.stringify(threads));
    } catch {
      // Persistence is best-effort.
    }
  }, [enabled, threads, persona]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeId) ?? null,
    [threads, activeId],
  );

  // Always-current snapshot so async handlers read fresh state synchronously.
  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const model =
    activeThread && enabledModels.some((item) => item.id === activeThread.model_id)
      ? activeThread.model_id
      : fallbackModel;
  const isSending = activeThread ? sendingThreadIds.includes(activeThread.id) : false;

  const persistThread = useCallback(
    (thread: ChatThread): Promise<ChatThread | null> => {
      if (!enabled || isBlankNewChat(thread)) return Promise.resolve(null);
      return saveChatThread(persona, thread)
        .then((saved) => {
          setThreads((current) =>
            current.map((item) => (item.id === saved.id ? preservePendingTraceState(item, saved) : item)),
          );
          return saved;
        })
        .catch(() => {
          // Local cache has already been updated. The next successful hydration/save reconciles the server.
          return null;
        });
    },
    [enabled, persona],
  );

  const continuePendingAssistant = useCallback(
    (thread: ChatThread, pendingMessage: ChatMessage) => {
      const targetId = thread.id;
      if (!enabled || sendingThreadIdsRef.current.has(targetId)) return;
      const activePending = messageWithActiveResponseVersion(pendingMessage);
      const pendingIndex = thread.messages.findIndex((message) => message.id === pendingMessage.id);
      let priorUser: ChatMessage | undefined;
      for (let index = pendingIndex - 1; index >= 0; index -= 1) {
        if (thread.messages[index].role === "user") {
          priorUser = thread.messages[index];
          break;
        }
      }
      const runtime = runtimeFromMessage(activePending) ?? runtimeFromMessage(priorUser);
      const targetModel = targetModelForRequest(enabledModels, thread.model_id, fallbackModel, runtime);
      if (!targetModel) return;

      const files = priorUser?.attachments ?? [];
      const initialText = activePending.content ?? "";
      const wireHistory = wireHistoryForPendingResume(thread, pendingMessage);

      setThreadSending(targetId, true);
      void (async () => {
        const sendControl = { controller: new AbortController(), stopped: false };
        activeSendControllers.current.set(targetId, sendControl);
        let streamedText = initialText;
        const streamRenderer = createThrottledStreamUpdate((fullText) => {
          setThreads((current) =>
            current.map((currentThread) =>
              currentThread.id !== targetId
                ? currentThread
                : {
                    ...currentThread,
                    messages: currentThread.messages.map((message) =>
                      message.id === pendingMessage.id ? withStreamedPendingContent(message, fullText) : message,
                    ),
                  },
            ),
          );
        });
        const streamPersist = createThrottledPersist(() => {
          const current = threadsRef.current.find((item) => item.id === targetId);
          if (current) void persistThread(current);
        });
        try {
          const reply = await sendChatStream(persona, {
            model: targetModel,
            messages: wireHistory,
            initialText,
            signal: sendControl.controller.signal,
            onDelta: (fullText) => {
              streamedText = fullText;
              streamRenderer.push(fullText);
              streamPersist.touch();
            },
            runtime: {
              ...runtime,
              surface: "chat",
              threadId: targetId,
              clientStartedAt: activePending.executedAt ?? activePending.createdAtIso ?? undefined,
              attachmentIds: files.map((file) => file.id).filter((id): id is string => Boolean(id)),
              attachmentNames: files.map((file) => file.name),
              contextAttachmentIds: contextImageAttachmentIds(
                thread.messages.slice(0, Math.max(pendingIndex, 0)),
              ),
            },
          });
          streamRenderer.cancel();
          streamPersist.cancel();
          const completed = await platformTimestamp(persona);
          const durationMs =
            activePending.startedAtMs != null ? Math.max(0, Date.now() - activePending.startedAtMs) : null;
          let savedThread: ChatThread = {
            ...thread,
            updated_at: completed.label,
            messages: thread.messages.map((message) =>
              message.id === pendingMessage.id
                ? finalizeAssistantMessage(message, {
                    content: reply.content,
                    status: "ok",
                    citations: reply.citations,
                    usage: reply.usage ?? null,
                    memoryUsed: reply.memoryUsed,
                    memorySaved: reply.memorySaved,
                    completed,
                    executedAt: activePending.executedAt,
                    durationMs,
                  })
                : message,
            ),
          };
          setThreads((current) =>
            current.map((currentThread) => {
              if (currentThread.id !== targetId) return currentThread;
              savedThread = {
                ...currentThread,
                updated_at: completed.label,
                messages: currentThread.messages.map((message) =>
                  message.id === pendingMessage.id
                    ? finalizeAssistantMessage(message, {
                        content: reply.content,
                        status: "ok",
                        citations: reply.citations,
                        usage: reply.usage ?? null,
                        memoryUsed: reply.memoryUsed,
                        memorySaved: reply.memorySaved,
                        completed,
                        executedAt: activePending.executedAt,
                        durationMs,
                      })
                    : message,
                ),
              };
              return savedThread;
            }),
          );
          persistThread(savedThread);
        } catch (error: unknown) {
          streamRenderer.cancel();
          streamPersist.cancel();
          const completed = await platformTimestamp(persona);
          const durationMs =
            activePending.startedAtMs != null ? Math.max(0, Date.now() - activePending.startedAtMs) : null;
          const failure = streamedFailureContent(error, sendControl.stopped, streamedText);
          let savedThread: ChatThread = {
            ...thread,
            updated_at: completed.label,
            messages: thread.messages.map((message) =>
              message.id === pendingMessage.id
                ? finalizeAssistantMessage(message, {
                    content: failure.content,
                    status: "error",
                    completed,
                    executedAt: activePending.executedAt,
                    durationMs,
                    failureNotice: failure.notice,
                  })
                : message,
            ),
          };
          setThreads((current) =>
            current.map((currentThread) => {
              if (currentThread.id !== targetId) return currentThread;
              savedThread = {
                ...currentThread,
                updated_at: completed.label,
                messages: currentThread.messages.map((message) =>
                  message.id === pendingMessage.id
                    ? finalizeAssistantMessage(message, {
                        content: failure.content,
                        status: "error",
                        completed,
                        executedAt: activePending.executedAt,
                        durationMs,
                        failureNotice: failure.notice,
                      })
                    : message,
                ),
              };
              return savedThread;
            }),
          );
          persistThread(savedThread);
        } finally {
          activeSendControllers.current.delete(targetId);
          setThreadSending(targetId, false);
        }
      })();
    },
    [enabled, enabledModels, fallbackModel, persistThread, persona, setThreadSending],
  );

  useEffect(() => {
    if (!enabled) return;
    for (const thread of threads) {
      const pending = resumablePendingAssistant(thread);
      if (!pending) continue;
      if (sendingThreadIdsRef.current.has(thread.id)) continue;
      if (resumedPendingIds.current.has(pending.id)) continue;
      resumedPendingIds.current.add(pending.id);
      continuePendingAssistant(thread, pending);
    }
  }, [continuePendingAssistant, enabled, threads]);

  const selectThread = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const setModel = useCallback(
    (modelId: string) => {
      if (!enabledModels.some((model) => model.id === modelId)) return;
      const existing = threadsRef.current.find((thread) => thread.id === activeId);
      if (!existing) return;
      const updatedThread = { ...existing, model_id: modelId };
      setThreads((current) => current.map((thread) => (thread.id === activeId ? updatedThread : thread)));
      persistThread(updatedThread);
    },
    [activeId, enabledModels, persistThread],
  );

  const setDefaultModel = useCallback(
    (modelId: string) => {
      if (!enabledModels.some((model) => model.id === modelId)) return;
      try {
        window.localStorage.setItem(defaultModelStorageKey(persona), modelId);
      } catch {
        // Preference save is best-effort; still select the model for this chat.
      }
      setDefaultModelIdState(modelId);
      setModel(modelId);
    },
    [enabledModels, persona, setModel],
  );

  const togglePin = useCallback((chatId: string) => {
    const existing = threadsRef.current.find((thread) => thread.id === chatId);
    if (!existing) return;
    const updatedThread = { ...existing, pinned: !existing.pinned };
    setThreads((current) => current.map((thread) => (thread.id === chatId ? updatedThread : thread)));
    persistThread(updatedThread);
  }, [persistThread]);

  const renameThread = useCallback(
    async (chatId: string, requestedTitle: string) => {
      const title = requestedTitle.trim().replace(/\s+/g, " ").slice(0, 160);
      if (!title) throw new Error("Chat title cannot be blank.");
      const existing = threadsRef.current.find((thread) => thread.id === chatId);
      if (!existing || existing.title === title) return;
      if (!enabled) throw new Error("Chat persistence is unavailable.");

      const optimistic: ChatThread = { ...existing, title, updated_at: "Just now" };
      setThreads((current) => current.map((thread) => (thread.id === chatId ? optimistic : thread)));

      try {
        const saved = await renameChatThread(persona, chatId, title);
        setThreads((current) =>
          current.map((thread) =>
            thread.id === chatId && thread.title === title
              ? preservePendingTraceState(thread, saved)
              : thread,
          ),
        );
      } catch (error) {
        setThreads((current) =>
          current.map((thread) =>
            thread.id === chatId && thread.title === title
              ? { ...thread, title: existing.title, updated_at: existing.updated_at }
              : thread,
          ),
        );
        throw error;
      }
    },
    [enabled, persona],
  );

  const generateThreadTitle = useCallback(
    async (chatId: string) => {
      if (!enabled) throw new Error("Chat persistence is unavailable.");
      // No optimistic update: the title is unknown until the provider answers,
      // so the current name stays honest until the server persists a new one.
      const saved = await generateChatThreadTitle(persona, chatId);
      setThreads((current) =>
        current.map((thread) =>
          thread.id === chatId ? preservePendingTraceState(thread, saved) : thread,
        ),
      );
    },
    [enabled, persona],
  );

  const newChat = useCallback(() => {
    setComposerFocusToken((token) => token + 1);
    const current = threadsRef.current;
    const currentModel = current.find((thread) => thread.id === activeId)?.model_id;
    const savedDefault = defaultModelId && enabledModels.some((item) => item.id === defaultModelId) ? defaultModelId : null;
    const lastModel = savedDefault ?? (enabledModels.some((item) => item.id === currentModel) ? currentModel ?? "" : fallbackModel);
    const existingEmpty = current.find((thread) => thread.messages.length === 0 && thread.title === "New chat");
    if (existingEmpty) {
      if (lastModel && existingEmpty.model_id !== lastModel) {
        const updatedEmpty = { ...existingEmpty, model_id: lastModel };
        setThreads((prev) => prev.map((thread) => (thread.id === existingEmpty.id ? updatedEmpty : thread)));
      }
      setActiveId(existingEmpty.id);
      return;
    }
    const fresh = createBlankThread(data, lastModel);
    setThreads((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
  }, [activeId, data, defaultModelId, enabledModels, fallbackModel]);

  const archiveThread = useCallback(
    (chatId: string) => {
      const existing = threadsRef.current.find((thread) => thread.id === chatId);
      if (!existing) return;
      const updatedThread: ChatThread = { ...existing, archived: true, pinned: false, updated_at: "Just now" };
      setThreads((current) => current.map((thread) => (thread.id === chatId ? updatedThread : thread)));
      persistThread(updatedThread);

      if (activeIdRef.current !== chatId) return;
      const current = threadsRef.current;
      const existingEmpty = current.find((thread) => thread.id !== chatId && isBlankNewChat(thread));
      if (existingEmpty) {
        setActiveId(existingEmpty.id);
        return;
      }
      const fresh = createBlankThread(data, fallbackModel);
      setThreads((currentThreads) => [fresh, ...currentThreads]);
      setActiveId(fresh.id);
    },
    [data, fallbackModel, persistThread],
  );

  const restoreThread = useCallback(
    (chatId: string) => {
      const existing = threadsRef.current.find((thread) => thread.id === chatId);
      if (!existing || !existing.archived) return;
      const updatedThread: ChatThread = { ...existing, archived: false, updated_at: "Just now" };
      setThreads((current) => current.map((thread) => (thread.id === chatId ? updatedThread : thread)));
      persistThread(updatedThread);
    },
    [persistThread],
  );

  const deleteThread = useCallback(
    (chatId: string) => {
      const existing = threadsRef.current.find((thread) => thread.id === chatId);
      if (!existing) return;
      setThreads((current) => current.filter((thread) => thread.id !== chatId));
      if (enabled && !isBlankNewChat(existing)) {
        deleteChatThread(persona, chatId).catch(() => {
          // Local removal already happened; a failed server delete resurfaces
          // the thread on the next hydration instead of faking success.
        });
      }

      if (activeIdRef.current !== chatId) return;
      const remaining = threadsRef.current.filter((thread) => thread.id !== chatId);
      const existingEmpty = remaining.find((thread) => isBlankNewChat(thread));
      if (existingEmpty) {
        setActiveId(existingEmpty.id);
        return;
      }
      const fresh = createBlankThread(data, fallbackModel);
      setThreads((currentThreads) => [fresh, ...currentThreads]);
      setActiveId(fresh.id);
    },
    [data, enabled, fallbackModel, persona],
  );

  const moveThreadToFolder = useCallback(
    (chatId: string, folderId: string | null) => {
      const existing = threadsRef.current.find((thread) => thread.id === chatId);
      if (!existing) return;
      const updatedThread: ChatThread = { ...existing, archived: false, folder_id: folderId, updated_at: "Just now" };
      setThreads((current) => current.map((thread) => (thread.id === chatId ? updatedThread : thread)));
      persistThread(updatedThread);
    },
    [persistThread],
  );

  const branchFromMessage = useCallback(
    (messageId: string) => {
      const current = threadsRef.current;
      const sourceThread = current.find((thread) => thread.id === activeIdRef.current);
      if (!sourceThread) return null;
      const messageIndex = sourceThread.messages.findIndex((message) => message.id === messageId);
      if (messageIndex < 0) return null;
      const sourceMessage = messageWithActiveResponseVersion(sourceThread.messages[messageIndex]);
      let priorUserIndex = -1;
      for (let index = messageIndex - 1; index >= 0; index -= 1) {
        if (sourceThread.messages[index].role === "user") {
          priorUserIndex = index;
          break;
        }
      }
      const branchContext =
        priorUserIndex >= 0
          ? [sourceThread.messages[priorUserIndex], sourceMessage]
          : [sourceMessage];
      const branchMessages = branchContext.map((message) => {
        const createdAtIso = new Date().toISOString();
        return {
          ...message,
          id: uid("msg"),
          createdAt: formatTimeLabel(createdAtIso),
          createdAtIso,
          startedAtMs: undefined,
        };
      });
      const branchTitleBase =
        sourceThread.title && sourceThread.title !== "New chat"
          ? stripBranchPrefix(sourceThread.title)
          : sourceMessage.content;
      const branchThread: ChatThread = {
        id: uid("branch"),
        tenant_id: sourceThread.tenant_id,
        owner_user_id: sourceThread.owner_user_id,
        title: `Branch: ${deriveTitle(branchTitleBase)}`,
        model_id: sourceThread.model_id || fallbackModel,
        group_id: sourceThread.group_id,
        pinned: false,
        archived: false,
        folder_id: null,
        used_agent: sourceThread.used_agent,
        updated_at: "Just now",
        messages: branchMessages,
      };
      setThreads((currentThreads) => [branchThread, ...currentThreads]);
      setActiveId(branchThread.id);
      setComposerFocusToken((token) => token + 1);
      persistThread(branchThread);
      return branchThread;
    },
    [fallbackModel, persistThread],
  );

  const regenerateResponse = useCallback(
    (messageId: string) => {
      if (!enabled) return false;
      const sourceThread = threadsRef.current.find((thread) => thread.id === activeIdRef.current);
      if (!sourceThread) return false;
      const sourceIndex = sourceThread.messages.findIndex((message) => message.id === messageId);
      const sourceMessage = sourceThread.messages[sourceIndex];
      const activeSourceMessage = sourceMessage ? messageWithActiveResponseVersion(sourceMessage) : null;
      if (!activeSourceMessage || activeSourceMessage.role !== "assistant" || activeSourceMessage.status === "pending") {
        return false;
      }
      let priorUserIndex = -1;
      for (let index = sourceIndex - 1; index >= 0; index -= 1) {
        if (sourceThread.messages[index].role === "user") {
          priorUserIndex = index;
          break;
        }
      }
      if (priorUserIndex < 0) return false;
      const priorUser = sourceThread.messages[priorUserIndex];
      const text = priorUser.content.trim();
      const files = priorUser.attachments ?? [];
      if (!text && files.length === 0) return false;

      const targetId = sourceThread.id;
      if (sendingThreadIdsRef.current.has(targetId)) return false;
      const runtime = runtimeFromMessage(activeSourceMessage) ?? runtimeFromMessage(priorUser);
      const targetModel = targetModelForRequest(enabledModels, sourceThread.model_id, fallbackModel, runtime);
      if (!targetModel) return false;

      setThreadSending(targetId, true);
      void (async () => {
        const sendControl = { controller: new AbortController(), stopped: false };
        activeSendControllers.current.set(targetId, sendControl);
        const started = await platformTimestamp(persona);
        const storedRuntime = persistableRuntime(runtime);
        const versions = responseVersionsForMessage(sourceMessage);
        const nextVersion: ChatResponseVersion = {
          id: uid("version"),
          label: `Version ${versions.length + 1}`,
          content: "",
          createdAt: started.label,
          createdAtIso: started.iso,
          executedAt: started.iso,
          status: "pending",
          citations: [],
          activityTrace: buildActivityTrace(data, targetModel, text, files, runtime),
          startedAtMs: Date.now(),
          metadata: {
            clockSource: started.source,
            regeneratedFromMessageId: sourceMessage.id,
            regeneratedFromUserMessageId: priorUser.id,
            ...(storedRuntime ? { chatRuntime: storedRuntime } : {}),
          },
        };
        const nextVersions = [...versions, nextVersion];
        const pendingMessage = withResponseVersions(sourceMessage, nextVersions, nextVersions.length - 1);
        resumedPendingIds.current.add(pendingMessage.id);
        const regeneratedMessages = sourceThread.messages.map((message, index) =>
          index === sourceIndex ? pendingMessage : message,
        );
        const wireHistory = [
          regenerationQualityMessage(activeSourceMessage),
          ...wireMessagesFrom(sourceThread.messages.slice(0, priorUserIndex + 1)),
        ].filter((message): message is ChatWireMessage => Boolean(message));
        const updated: ChatThread = {
          ...sourceThread,
          model_id: targetModel,
          updated_at: started.label,
          used_agent: sourceThread.used_agent || Boolean(runtime?.agentEnabled),
          messages: regeneratedMessages,
        };

        setThreads((current) => [updated, ...current.filter((thread) => thread.id !== targetId)]);
        setActiveId(targetId);
        persistThread(updated);

        let streamedText = "";
        const streamRenderer = createThrottledStreamUpdate((fullText) => {
          setThreads((current) =>
            current.map((thread) =>
              thread.id !== targetId
                ? thread
                : {
                    ...thread,
                    messages: thread.messages.map((message) =>
                      message.id === sourceMessage.id ? withStreamedPendingContent(message, fullText) : message,
                    ),
                  },
            ),
          );
        });
        const streamPersist = createThrottledPersist(() => {
          const current = threadsRef.current.find((item) => item.id === targetId);
          if (current) void persistThread(current);
        });

        try {
          const reply = await sendChatStream(persona, {
            model: targetModel,
            messages: wireHistory,
            signal: sendControl.controller.signal,
            onDelta: (fullText) => {
              streamedText = fullText;
              streamRenderer.push(fullText);
              streamPersist.touch();
            },
            runtime: {
              ...runtime,
              surface: "chat",
              threadId: targetId,
              clientStartedAt: started.iso,
              attachmentIds: files.map((file) => file.id).filter((id): id is string => Boolean(id)),
              attachmentNames: files.map((file) => file.name),
              contextAttachmentIds: contextImageAttachmentIds(sourceThread.messages.slice(0, priorUserIndex)),
            },
          });
          streamRenderer.cancel();
          streamPersist.cancel();
          const completed = await platformTimestamp(persona);
          const durationMs = timestampDurationMs(started, completed);
          let savedThread: ChatThread = {
            ...updated,
            updated_at: completed.label,
            messages: updated.messages.map((message) =>
              message.id === sourceMessage.id
                ? withResponseVersions(
                    message,
                    responseVersionsForMessage(message).map((version, index, currentVersions) =>
                      index === currentVersions.length - 1
                        ? {
                            ...version,
                            content: reply.content,
                            citations: reply.citations,
                            usage: reply.usage ?? null,
                            memoryUsed: reply.memoryUsed,
                            memorySaved: reply.memorySaved,
                            status: "ok",
                            createdAt: completed.label,
                            createdAtIso: completed.iso,
                            executedAt: started.iso,
                            completedAt: completed.iso,
                            durationMs,
                            metadata: {
                              ...(version.metadata ?? {}),
                              clockSource: completed.source,
                              failureNotice: undefined,
                            },
                          }
                        : version,
                    ),
                    responseVersionsForMessage(message).length - 1,
                  )
                : message,
            ),
          };
          setThreads((current) =>
            current.map((thread) => {
              if (thread.id !== targetId) return thread;
              savedThread = {
                ...thread,
                updated_at: completed.label,
                messages: thread.messages.map((message) =>
                  message.id === sourceMessage.id
                    ? withResponseVersions(
                        message,
                        responseVersionsForMessage(message).map((version, index, currentVersions) =>
                          index === currentVersions.length - 1
                            ? {
                                ...version,
                                content: reply.content,
                                citations: reply.citations,
                                usage: reply.usage ?? null,
                                memoryUsed: reply.memoryUsed,
                                memorySaved: reply.memorySaved,
                                status: "ok",
                                createdAt: completed.label,
                                createdAtIso: completed.iso,
                                executedAt: started.iso,
                                completedAt: completed.iso,
                                durationMs,
                                metadata: {
                                  ...(version.metadata ?? {}),
                                  clockSource: completed.source,
                                  failureNotice: undefined,
                                },
                              }
                            : version,
                        ),
                        responseVersionsForMessage(message).length - 1,
                      )
                    : message,
                ),
              };
              return savedThread;
            }),
          );
          persistThread(savedThread);
        } catch (error: unknown) {
          streamRenderer.cancel();
          streamPersist.cancel();
          const completed = await platformTimestamp(persona);
          const durationMs = timestampDurationMs(started, completed);
          const failure = streamedFailureContent(error, sendControl.stopped, streamedText);
          let savedThread: ChatThread = {
            ...updated,
            updated_at: completed.label,
            messages: updated.messages.map((message) =>
              message.id === sourceMessage.id
                ? withResponseVersions(
                    message,
                    responseVersionsForMessage(message).map((version, index, currentVersions) =>
                      index === currentVersions.length - 1
                        ? {
                            ...version,
                            content: failure.content,
                            status: "error",
                            createdAt: completed.label,
                            createdAtIso: completed.iso,
                            executedAt: started.iso,
                            completedAt: completed.iso,
                            durationMs,
                            metadata: {
                              ...(version.metadata ?? {}),
                              clockSource: completed.source,
                              ...(failure.notice ? { failureNotice: failure.notice } : {}),
                            },
                          }
                        : version,
                    ),
                    responseVersionsForMessage(message).length - 1,
                  )
                : message,
            ),
          };
          setThreads((current) =>
            current.map((thread) => {
              if (thread.id !== targetId) return thread;
              savedThread = {
                ...thread,
                updated_at: completed.label,
                messages: thread.messages.map((message) =>
                  message.id === sourceMessage.id
                    ? withResponseVersions(
                        message,
                        responseVersionsForMessage(message).map((version, index, currentVersions) =>
                          index === currentVersions.length - 1
                            ? {
                                ...version,
                                content: failure.content,
                                status: "error",
                                createdAt: completed.label,
                                createdAtIso: completed.iso,
                                executedAt: started.iso,
                                completedAt: completed.iso,
                                durationMs,
                                metadata: {
                                  ...(version.metadata ?? {}),
                                  clockSource: completed.source,
                                  ...(failure.notice ? { failureNotice: failure.notice } : {}),
                                },
                              }
                            : version,
                        ),
                        responseVersionsForMessage(message).length - 1,
                      )
                    : message,
                ),
              };
              return savedThread;
            }),
          );
          persistThread(savedThread);
        } finally {
          activeSendControllers.current.delete(targetId);
          setThreadSending(targetId, false);
        }
      })();
      return true;
    },
    [data, enabled, enabledModels, fallbackModel, persistThread, persona, setThreadSending],
  );

  const selectResponseVersion = useCallback(
    (messageId: string, versionIndex: number) => {
      const sourceThread = threadsRef.current.find((thread) => thread.id === activeIdRef.current);
      if (!sourceThread) return false;
      const sourceMessage = sourceThread.messages.find((message) => message.id === messageId);
      if (!sourceMessage || sourceMessage.role !== "assistant") return false;
      const versions = responseVersionsForMessage(sourceMessage);
      if (versions.length < 2 || versionIndex < 0 || versionIndex >= versions.length) return false;
      const updatedMessage = withResponseVersions(sourceMessage, versions, versionIndex);
      const updatedThread: ChatThread = {
        ...sourceThread,
        messages: sourceThread.messages.map((message) => (message.id === messageId ? updatedMessage : message)),
      };
      setThreads((current) => current.map((thread) => (thread.id === sourceThread.id ? updatedThread : thread)));
      persistThread(updatedThread);
      return true;
    },
    [persistThread],
  );

  const updateAssistantDiagram = useCallback(
    (messageId: string, previousSource: string, nextSource: string) => {
      const sourceThread = threadsRef.current.find((thread) => thread.id === activeIdRef.current);
      if (!sourceThread) return false;
      const sourceMessage = sourceThread.messages.find((message) => message.id === messageId);
      if (!sourceMessage || sourceMessage.role !== "assistant" || sourceMessage.status === "pending") return false;
      const rawVersions = sourceMessage.metadata?.responseVersions;
      let updatedMessage: ChatMessage;
      if (Array.isArray(rawVersions) && rawVersions.length > 0) {
        const versions = responseVersionsForMessage(sourceMessage);
        const activeIndex = activeResponseVersionIndex(sourceMessage);
        const activeContent = versions[activeIndex]?.content ?? sourceMessage.content;
        const replaced = replaceDiagramFence(activeContent, previousSource, nextSource);
        if (replaced === null) return false;
        const nextVersions = versions.map((version, index) =>
          index === activeIndex ? { ...version, content: replaced } : version,
        );
        updatedMessage = withResponseVersions(sourceMessage, nextVersions, activeIndex);
      } else {
        // Never fabricate a responseVersions array for a message that has
        // none: version metadata should only appear once a regeneration
        // actually happened.
        const replaced = replaceDiagramFence(sourceMessage.content, previousSource, nextSource);
        if (replaced === null) return false;
        updatedMessage = { ...sourceMessage, content: replaced };
      }
      const updatedThread: ChatThread = {
        ...sourceThread,
        messages: sourceThread.messages.map((message) => (message.id === messageId ? updatedMessage : message)),
      };
      setThreads((current) => current.map((thread) => (thread.id === sourceThread.id ? updatedThread : thread)));
      persistThread(updatedThread);
      return true;
    },
    [persistThread],
  );

  const startChatSend = useCallback(
    (thread: ChatThread, content: string, attachments?: ChatAttachment[], runtime?: ChatRuntimeOptions) => {
      const text = content.trim();
      const files = attachments ?? [];
      if (!enabled || (!text && files.length === 0)) return false;

      const targetId = thread.id;
      if (sendingThreadIdsRef.current.has(targetId)) return false;
      const targetModel = targetModelForRequest(enabledModels, thread.model_id, fallbackModel, runtime);
      if (!targetModel) return false;
      const shouldAutoNameThread = thread.messages.length === 0 && thread.title === "New chat";

      setThreadSending(targetId, true);
      void (async () => {
        const sendControl = { controller: new AbortController(), stopped: false };
        activeSendControllers.current.set(targetId, sendControl);
        const started = await platformTimestamp(persona);
        const storedRuntime = persistableRuntime(runtime);
        const userMessage: ChatMessage = {
          id: uid("msg"),
          role: "user",
          content: text,
          createdAt: started.label,
          createdAtIso: started.iso,
          status: "ok",
          attachments: files.length ? files : undefined,
          metadata: { clockSource: started.source, ...(storedRuntime ? { chatRuntime: storedRuntime } : {}) },
        };
        const pendingId = uid("msg");
        resumedPendingIds.current.add(pendingId);
        const pendingMessage: ChatMessage = {
          id: pendingId,
          role: "assistant",
          content: "",
          createdAt: started.label,
          createdAtIso: started.iso,
          executedAt: started.iso,
          status: "pending",
          citations: [],
          activityTrace: buildActivityTrace(data, targetModel, text, files, runtime),
          startedAtMs: Date.now(),
          metadata: { clockSource: started.source, ...(storedRuntime ? { chatRuntime: storedRuntime } : {}) },
        };

        const nextMessages = [...thread.messages, userMessage, pendingMessage];
        const wireHistory = wireMessagesFrom(nextMessages);

        const derivedTitle = text ? deriveTitle(text) : files[0]?.name ?? "New chat";
        const updated: ChatThread = {
          ...thread,
          title: thread.messages.length === 0 || thread.title === "New chat" ? derivedTitle : thread.title,
          model_id: targetModel,
          updated_at: started.label,
          used_agent: Boolean(runtime?.agentEnabled),
          messages: nextMessages,
        };

        setThreads((prev) => [updated, ...prev.filter((item) => item.id !== targetId)]);
        setActiveId(targetId);
        persistThread(updated);

        let streamedText = "";
        const streamRenderer = createThrottledStreamUpdate((fullText) => {
          setThreads((current) =>
            current.map((currentThread) =>
              currentThread.id !== targetId
                ? currentThread
                : {
                    ...currentThread,
                    messages: currentThread.messages.map((message) =>
                      message.id === pendingId ? withStreamedPendingContent(message, fullText) : message,
                    ),
                  },
            ),
          );
        });
        const streamPersist = createThrottledPersist(() => {
          const current = threadsRef.current.find((item) => item.id === targetId);
          if (current) void persistThread(current);
        });

        try {
          const reply = await sendChatStream(persona, {
            model: targetModel,
            messages: wireHistory,
            signal: sendControl.controller.signal,
            onDelta: (fullText) => {
              streamedText = fullText;
              streamRenderer.push(fullText);
              streamPersist.touch();
            },
            runtime: {
              ...runtime,
              surface: "chat",
              threadId: targetId,
              clientStartedAt: started.iso,
              attachmentIds: files.map((file) => file.id).filter((id): id is string => Boolean(id)),
              attachmentNames: files.map((file) => file.name),
              contextAttachmentIds: contextImageAttachmentIds(thread.messages),
            },
          });
          streamRenderer.cancel();
          streamPersist.cancel();
          const completed = await platformTimestamp(persona);
          const durationMs = timestampDurationMs(started, completed);
          let savedThread: ChatThread = {
            ...updated,
            updated_at: completed.label,
            messages: updated.messages.map((message) =>
              message.id === pendingId
                ? {
                    ...message,
                    content: reply.content,
                    citations: reply.citations,
                    usage: reply.usage ?? null,
                    memoryUsed: reply.memoryUsed,
                    memorySaved: reply.memorySaved,
                    status: "ok",
                    createdAt: completed.label,
                    createdAtIso: completed.iso,
                    executedAt: started.iso,
                    completedAt: completed.iso,
                    durationMs,
                    metadata: {
                      ...(message.metadata ?? {}),
                      clockSource: completed.source,
                      failureNotice: undefined,
                    },
                  }
                : message,
            ),
          };
          setThreads((current) =>
            current.map((thread) => {
              if (thread.id !== targetId) return thread;
              savedThread = {
                ...thread,
                updated_at: completed.label,
                messages: thread.messages.map((message) =>
                  message.id === pendingId
                    ? {
                        ...message,
                        content: reply.content,
                        citations: reply.citations,
                        usage: reply.usage ?? null,
                        memoryUsed: reply.memoryUsed,
                        memorySaved: reply.memorySaved,
                        status: "ok",
                        createdAt: completed.label,
                        createdAtIso: completed.iso,
                        executedAt: started.iso,
                        completedAt: completed.iso,
                        durationMs,
                        metadata: {
                          ...(message.metadata ?? {}),
                          clockSource: completed.source,
                          failureNotice: undefined,
                        },
                      }
                    : message,
                ),
              };
              return savedThread;
            }),
          );
          const persisted = persistThread(savedThread);
          if (shouldAutoNameThread) {
            void persisted.then(async (persistedThread) => {
              if (!persistedThread) return;
              try {
                const titled = await generateChatThreadTitle(persona, targetId, {
                  expectedTitle: persistedThread.title,
                });
                setThreads((current) =>
                  current.map((currentThread) =>
                    currentThread.id === targetId && currentThread.title === persistedThread.title
                      ? preservePendingTraceState(currentThread, titled)
                      : currentThread,
                  ),
                );
              } catch {
                // Automatic naming is best-effort. The prompt-derived fallback
                // stays visible, and the manual rename controls remain available.
              }
            });
          }
        } catch (error: unknown) {
          streamRenderer.cancel();
          streamPersist.cancel();
          const completed = await platformTimestamp(persona);
          const durationMs = timestampDurationMs(started, completed);
          const failure = streamedFailureContent(error, sendControl.stopped, streamedText);
          let savedThread: ChatThread = {
            ...updated,
            updated_at: completed.label,
            messages: updated.messages.map((message) =>
              message.id === pendingId
                ? {
                    ...message,
                    content: failure.content,
                    status: "error",
                    createdAt: completed.label,
                    createdAtIso: completed.iso,
                    executedAt: started.iso,
                    completedAt: completed.iso,
                    durationMs,
                    metadata: {
                      ...(message.metadata ?? {}),
                      clockSource: completed.source,
                      ...(failure.notice ? { failureNotice: failure.notice } : {}),
                    },
                  }
                : message,
            ),
          };
          setThreads((current) =>
            current.map((thread) => {
              if (thread.id !== targetId) return thread;
              savedThread = {
                ...thread,
                updated_at: completed.label,
                messages: thread.messages.map((message) =>
                  message.id === pendingId
                    ? {
                        ...message,
                        content: failure.content,
                        status: "error",
                        createdAt: completed.label,
                        createdAtIso: completed.iso,
                        executedAt: started.iso,
                        completedAt: completed.iso,
                        durationMs,
                        metadata: {
                          ...(message.metadata ?? {}),
                          clockSource: completed.source,
                          ...(failure.notice ? { failureNotice: failure.notice } : {}),
                        },
                      }
                    : message,
                ),
              };
              return savedThread;
            }),
          );
          persistThread(savedThread);
        } finally {
          activeSendControllers.current.delete(targetId);
          setThreadSending(targetId, false);
        }
      })();
      return true;
    },
    [data, enabled, enabledModels, fallbackModel, persistThread, persona, setThreadSending],
  );

  /**
   * Abort the in-flight completion request for a thread (default: the active
   * thread). The aborted connection makes the API cancel the provider work,
   * and the pending message settles into an honest "stopped by you" error.
   */
  const stopResponse = useCallback((threadId?: string) => {
    const targetId = threadId ?? activeIdRef.current;
    const entry = activeSendControllers.current.get(targetId);
    if (!entry) return false;
    entry.stopped = true;
    entry.controller.abort();
    return true;
  }, []);

  const editUserMessage = useCallback(
    (messageId: string, content: string) => {
      if (!enabled) return false;
      const sourceThread = threadsRef.current.find((thread) => thread.id === activeIdRef.current);
      if (!sourceThread) return false;
      if (sendingThreadIdsRef.current.has(sourceThread.id)) return false;
      const messageIndex = sourceThread.messages.findIndex((message) => message.id === messageId);
      if (messageIndex < 0) return false;
      const sourceMessage = sourceThread.messages[messageIndex];
      if (sourceMessage.role !== "user") return false;
      const text = content.trim();
      const files = sourceMessage.attachments ?? [];
      if (!text && files.length === 0) return false;
      // Truncate at the edited message: drop it and everything after, then
      // re-run the existing send path. startChatSend rebuilds the thread from
      // this truncated history, so no stale later answer can survive.
      const truncated: ChatThread = {
        ...sourceThread,
        messages: sourceThread.messages.slice(0, messageIndex),
      };
      return startChatSend(truncated, text, files, runtimeFromMessage(sourceMessage));
    },
    [enabled, startChatSend],
  );

  const sendMessage = useCallback(
    (content: string, attachments?: ChatAttachment[], runtime?: ChatRuntimeOptions) => {
      const current = threadsRef.current;
      const existing = current.find((item) => item.id === activeId);
      const thread: ChatThread = existing ?? createBlankThread(data, fallbackModel);
      startChatSend(thread, content, attachments, runtime);
    },
    [activeId, data, fallbackModel, startChatSend],
  );

  const sendMessageInNewThread = useCallback(
    (content: string, attachments?: ChatAttachment[], runtime?: ChatRuntimeOptions) => {
      const sourceThread = threadsRef.current.find((thread) => thread.id === activeIdRef.current);
      const sourceModel =
        sourceThread?.model_id && enabledModels.some((model) => model.id === sourceThread.model_id)
          ? sourceThread.model_id
          : fallbackModel;
      const fresh = createBlankThread(data, sourceModel);
      if (sourceThread && (data.me.role === "PLATFORM_OWNER" || data.me.group_ids.includes(sourceThread.group_id))) {
        fresh.group_id = sourceThread.group_id;
      }
      return startChatSend(fresh, content, attachments, runtime) ? fresh : null;
    },
    [data, enabledModels, fallbackModel, startChatSend],
  );

  const runAutomationNow = useCallback(
    async (automation: Automation, input?: string): Promise<void> => {
      if (!enabled) return;
      const current = threadsRef.current;
      const existing = current.find((item) => item.id === activeId);
      const thread: ChatThread = existing ?? createBlankThread(data, fallbackModel);
      const targetId = thread.id;
      if (sendingThreadIdsRef.current.has(targetId)) return;

      const chainInput = input?.trim() || "";
      setThreadSending(targetId, true);
      const started = await platformTimestamp(persona);
      const userMessage: ChatMessage = {
        id: uid("msg"),
        role: "user",
        content: chainInput || `Run the “${automation.name}” automation now`,
        createdAt: started.label,
        createdAtIso: started.iso,
        status: "ok",
        metadata: {
          clockSource: started.source,
          automation_id: automation.id,
          automation_name: automation.name,
        },
      };
      const pendingId = uid("msg");
      const pendingMessage: ChatMessage = {
        id: pendingId,
        role: "assistant",
        content: "",
        createdAt: started.label,
        createdAtIso: started.iso,
        executedAt: started.iso,
        status: "pending",
        citations: [],
        startedAtMs: Date.now(),
        metadata: { clockSource: started.source },
      };
      const updated: ChatThread = {
        ...thread,
        title:
          thread.messages.length === 0 || thread.title === "New chat"
            ? deriveTitle(chainInput || `Automation: ${automation.name}`)
            : thread.title,
        updated_at: started.label,
        messages: [...thread.messages, userMessage, pendingMessage],
      };
      setThreads((prev) => [updated, ...prev.filter((item) => item.id !== targetId)]);
      setActiveId(targetId);
      persistThread(updated);

      const finishWith = (content: string, status: ChatMessage["status"], completed: PlatformTimestamp) => {
        const durationMs = timestampDurationMs(started, completed);
        let savedThread: ChatThread = updated;
        setThreads((currentThreads) =>
          currentThreads.map((item) => {
            if (item.id !== targetId) return item;
            savedThread = {
              ...item,
              updated_at: completed.label,
              messages: item.messages.map((message) =>
                message.id === pendingId
                  ? {
                      ...message,
                      content,
                      status,
                      createdAt: completed.label,
                      createdAtIso: completed.iso,
                      executedAt: started.iso,
                      completedAt: completed.iso,
                      durationMs,
                      metadata: { ...(message.metadata ?? {}), clockSource: completed.source },
                    }
                  : message,
              ),
            };
            return savedThread;
          }),
        );
        persistThread(savedThread);
      };

      try {
        const result = await runAutomation(
          persona,
          automation.id,
          chainInput ? { input: chainInput } : {},
        );
        const completed = await platformTimestamp(persona);
        // The final step's output IS the answer — earlier steps already fed
        // into it, so surfacing every intermediate draft would bury the reply.
        const finalOutput =
          result.final_output?.trim() ||
          result.transcript[result.transcript.length - 1]?.output ||
          "The automation finished without output.";
        const chainLabel = result.transcript.map((step) => step.model_name).join(" → ");
        // A cut-off answer must say so rather than reading as complete.
        const cutOff = result.transcript[result.transcript.length - 1]?.truncated
          ? "\n\n_Answer stopped at the step's token limit — it may be incomplete._"
          : "";
        // Surface the schedule state so a manual run on a paused automation
        // is never mistaken for the schedule being active (or vice versa).
        const scheduleNote = automation.enabled ? "" : " · schedule paused";
        finishWith(
          `**${automation.name}** · ${result.transcript.length} step${
            result.transcript.length === 1 ? "" : "s"
          } (${chainLabel})${scheduleNote}\n\n${finalOutput}${cutOff}`,
          "ok",
          completed,
        );
      } catch (error: unknown) {
        const completed = await platformTimestamp(persona);
        let friendly: string;
        if (error instanceof ChatRequestError) {
          // No HTTP status means the connection itself failed or was cut —
          // the generic "check your connection" copy reads as a mystery and
          // gets misattributed to unrelated settings.
          friendly =
            error.status === undefined
              ? "the server did not respond, so the run never completed. If Aperture Chat was just updated or restarted, try again in a moment."
              : error.message;
        } else {
          friendly = "Something went wrong running the automation. Please try again.";
        }
        // Head off the natural misread that pausing caused the failure:
        // pausing only stops the schedule, never manual runs.
        const pausedNote = automation.enabled
          ? ""
          : "\n\n_This automation's schedule is paused. Pausing does not block manual runs — the cause above is the real one._";
        finishWith(
          `**${automation.name}** could not run: ${friendly}${pausedNote}`,
          "error",
          completed,
        );
      } finally {
        setThreadSending(targetId, false);
      }
    },
    [activeId, data, enabled, fallbackModel, persistThread, persona, setThreadSending],
  );

  return {
    threads,
    activeId,
    activeThread,
    model,
    enabledModels,
    isSending,
    composerFocusToken,
    defaultModelId,
    selectThread,
    newChat,
    setModel,
    setDefaultModel,
    togglePin,
    renameThread,
    generateThreadTitle,
    archiveThread,
    restoreThread,
    deleteThread,
    moveThreadToFolder,
    branchFromMessage,
    regenerateResponse,
    editUserMessage,
    stopResponse,
    selectResponseVersion,
    updateAssistantDiagram,
    sendMessage,
    sendMessageInNewThread,
    runAutomationNow,
  };
}
