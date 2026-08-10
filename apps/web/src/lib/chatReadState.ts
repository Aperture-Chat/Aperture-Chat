import type { ChatThread } from "./types";

/**
 * Per-user "which chats have I looked at" state.
 *
 * A chat counts as unread when it has changed since the last time this user
 * opened it -- most usefully when an automation finished a conversation while
 * they were elsewhere. Read state is a per-person, per-device UI affordance
 * rather than shared workspace data, so it lives beside the other
 * `aperture-*-user-<id>` client state instead of on the server. That means a
 * new browser starts with nothing marked unread rather than lighting up the
 * whole list, which `seedReadState` below handles deliberately.
 */
export const CHAT_READ_STORAGE_PREFIX = "aperture-chat-read-v1";

/** Bounds the stored map so it cannot grow with an account's whole history. */
const MAX_TRACKED_THREADS = 500;

export type ChatReadState = Record<string, number>;

function storageKey(userId: string) {
  return `${CHAT_READ_STORAGE_PREFIX}-${userId}`;
}

function timestampOf(value: string | undefined | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function loadReadState(userId: string): ChatReadState {
  if (typeof window === "undefined" || !userId) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function saveReadState(userId: string, state: ChatReadState): void {
  if (typeof window === "undefined" || !userId) return;
  // Newest reads win when trimming: an old thread nobody opens again is the
  // safest entry to forget.
  const trimmed = Object.entries(state)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TRACKED_THREADS);
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Read state is an indicator, never a blocker. Losing it shows a dot again,
    // which is strictly better than failing the interaction that triggered it.
  }
}

/**
 * A thread is unread when the assistant has said something the user has not
 * opened since. Threads whose last message is the user's own are never unread:
 * there is nothing new to review.
 */
export function isThreadUnread(thread: ChatThread, state: ChatReadState): boolean {
  const lastMessage = thread.messages?.[thread.messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return false;
  const readAt = state[thread.id];
  // A thread with no entry has never been opened in this browser. That is the
  // headline case -- an automation finished a conversation while the user was
  // elsewhere -- so it is unread. Pre-existing history avoids this because
  // seedReadState stamps it once, on the first load for the account.
  if (readAt === undefined) return true;
  return timestampOf(thread.updated_at) > readAt;
}

export function markThreadRead(state: ChatReadState, thread: ChatThread): ChatReadState {
  // Stamp the thread's own updated_at rather than "now": a reply that lands
  // while the thread is open still registers as something to look at.
  return { ...state, [thread.id]: Math.max(timestampOf(thread.updated_at), state[thread.id] ?? 0) };
}

/** Marks that an account's history has already been stamped in this browser. */
export function hasSeededReadState(userId: string): boolean {
  if (typeof window === "undefined" || !userId) return false;
  try {
    return window.localStorage.getItem(`${storageKey(userId)}:seeded`) === "1";
  } catch {
    return false;
  }
}

function rememberSeeded(userId: string): void {
  try {
    window.localStorage.setItem(`${storageKey(userId)}:seeded`, "1");
  } catch {
    // Worst case the history is stamped read again next load, which is the
    // same visible result.
  }
}

/**
 * Stamp an account's existing history as read, exactly once per browser.
 *
 * This is what stops the indicator lighting up a whole chat list the first time
 * a user loads a build that has it. It must NOT run again afterwards: a thread
 * that appears later -- an automation finishing while the user was away -- has
 * no entry precisely because it is new, and stamping it would hide the dot the
 * feature exists to show.
 */
export function seedReadState(
  userId: string,
  state: ChatReadState,
  threads: ChatThread[],
): ChatReadState {
  if (!userId || !threads.length || hasSeededReadState(userId)) return state;
  const next = { ...state };
  for (const thread of threads) {
    if (next[thread.id] === undefined) next[thread.id] = timestampOf(thread.updated_at);
  }
  rememberSeeded(userId);
  return next;
}
