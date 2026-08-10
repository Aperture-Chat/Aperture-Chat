import type { ChatFeedbackRating } from "./types";

export const CHAT_FEEDBACK_STORAGE_KEY = "aperture-chat-feedback-v1";
export const CHAT_FEEDBACK_UPDATED_EVENT = "aperture-chat-feedback-updated";

export type ChatFeedbackEvent = {
  id: string;
  thread_id: string;
  thread_title: string;
  message_id: string;
  rating: ChatFeedbackRating;
  message_preview: string;
  model_id: string;
  user_id: string;
  user_name: string;
  created_at: string;
};

export type ChatFeedbackDraft = Omit<ChatFeedbackEvent, "id" | "created_at">;

export function loadChatFeedback(): ChatFeedbackEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CHAT_FEEDBACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isChatFeedbackEvent).slice(0, 200);
  } catch {
    return [];
  }
}

export function feedbackRatingForMessage(messageId: string): ChatFeedbackRating | null {
  return loadChatFeedback().find((item) => item.message_id === messageId)?.rating ?? null;
}

export function recordChatFeedback(draft: ChatFeedbackDraft): ChatFeedbackEvent {
  const event: ChatFeedbackEvent = {
    ...draft,
    id: `feedback-${draft.thread_id}-${draft.message_id}`,
    created_at: new Date().toISOString(),
  };
  const next = [
    event,
    ...loadChatFeedback().filter(
      (item) => item.thread_id !== draft.thread_id || item.message_id !== draft.message_id,
    ),
  ].slice(0, 200);
  saveChatFeedback(next);
  return event;
}

function saveChatFeedback(events: ChatFeedbackEvent[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_FEEDBACK_STORAGE_KEY, JSON.stringify(events));
    window.dispatchEvent(new CustomEvent(CHAT_FEEDBACK_UPDATED_EVENT));
  } catch {
    // Feedback capture should never block chat usage if browser storage is unavailable.
  }
}

function isChatFeedbackEvent(value: unknown): value is ChatFeedbackEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as ChatFeedbackEvent;
  return Boolean(
    event.id &&
      event.thread_id &&
      event.thread_title &&
      event.message_id &&
      (event.rating === "positive" || event.rating === "negative") &&
      event.message_preview &&
      event.model_id &&
      event.user_id &&
      event.user_name &&
      event.created_at,
  );
}
