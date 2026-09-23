import type { ChatThread } from "./types";

/**
 * Unread chat indicators.
 *
 * Each thread carries its owner's read position, `last_read_message_id`: the
 * id of the newest message they have seen. The API stores it, so every
 * browser shows the same dots, and it only ever moves forward. A thread is
 * unread while its newest message is a finished assistant reply the owner has
 * not reached yet -- most usefully when an automation finished a conversation
 * while they were elsewhere. Threads whose last message is the user's own are
 * never unread: there is nothing new to review.
 */

/** Browser-only read state from before positions moved to the server. */
const LEGACY_READ_STORAGE_PREFIX = "aperture-chat-read-v1";

/** The message a reader would reach by opening the thread, if it can be read yet. */
export function readableMessageId(thread: ChatThread): string | null {
  const lastMessage = thread.messages?.[thread.messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return null;
  // A reply still streaming has not finished arriving; it becomes unread once done.
  if (lastMessage.status === "pending") return null;
  return lastMessage.id;
}

export function isThreadUnread(thread: ChatThread): boolean {
  const target = readableMessageId(thread);
  return target !== null && thread.last_read_message_id !== target;
}

/**
 * Whichever read position points further into the thread. Mirrors the API's
 * forward-only merge so a stale copy can never bring back a dot.
 */
export function laterReadMarker(
  messageIds: readonly string[],
  current: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const present = current ?? null;
  if (!incoming || incoming === present) return present;
  const incomingIndex = messageIds.indexOf(incoming);
  if (incomingIndex < 0) return present;
  const currentIndex = present ? messageIds.indexOf(present) : -1;
  if (currentIndex < 0) return incoming;
  return incomingIndex >= currentIndex ? incoming : present;
}

/** Drops the pre-server read state this browser may still hold for an account. */
export function forgetLegacyReadState(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.removeItem(`${LEGACY_READ_STORAGE_PREFIX}-${userId}`);
    window.localStorage.removeItem(`${LEGACY_READ_STORAGE_PREFIX}-${userId}:seeded`);
  } catch {
    // Leftover keys are harmless; they are simply no longer read.
  }
}
