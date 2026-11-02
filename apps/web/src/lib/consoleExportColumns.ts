/** What each console export writes, one list per kind of record. The Platform
 * and Admin consoles export the same fields. */

import type { ChatFeedbackEvent } from "./chatFeedback";
import type { RuntimeRecord } from "./runtimeRecords";
import type { ExportColumn } from "./tabularExport";
import type { AuditEvent, UsageRecord, UserPromptRecord } from "./types";

export type FeedbackDisplayItem = ChatFeedbackEvent & { comment?: string };

export const RUNTIME_ANALYTICS_EXPORT_COLUMNS: Array<ExportColumn<RuntimeRecord>> = [
  { header: "id", value: (item) => item.id },
  { header: "actor_id", value: (item) => item.actorId },
  { header: "actor_name", value: (item) => item.actorName },
  { header: "surface", value: (item) => item.surface },
  { header: "title", value: (item) => item.title },
  { header: "detail", value: (item) => item.detail },
  { header: "metadata", value: (item) => item.metadata },
  { header: "executed_at", kind: "datetime", value: (item) => item.executedAt },
  { header: "client_started_at", kind: "datetime", value: (item) => item.clientStartedAt },
  { header: "model", value: (item) => item.model },
  { header: "provider", value: (item) => item.provider },
  { header: "message_count", value: (item) => item.messageCount },
  { header: "thread_id", value: (item) => item.threadId },
];

export const CHAT_FEEDBACK_EXPORT_COLUMNS: Array<ExportColumn<FeedbackDisplayItem>> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", kind: "datetime", value: (item) => item.created_at },
  { header: "rating", value: (item) => item.rating },
  { header: "comment", value: (item) => item.comment ?? "" },
  { header: "thread_id", value: (item) => item.thread_id },
  { header: "thread_title", value: (item) => item.thread_title },
  { header: "message_id", value: (item) => item.message_id },
  { header: "model_id", value: (item) => item.model_id },
  { header: "user_id", value: (item) => item.user_id },
  { header: "user_name", value: (item) => item.user_name },
  { header: "message_preview", value: (item) => item.message_preview },
];

export const AUDIT_TRAIL_EXPORT_COLUMNS: Array<ExportColumn<AuditEvent>> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", kind: "datetime", value: (item) => item.created_at },
  { header: "tenant_id", value: (item) => item.tenant_id ?? "" },
  { header: "actor_id", value: (item) => item.actor_id },
  { header: "actor_name", value: (item) => item.actor_name },
  { header: "actor_role", value: (item) => item.actor_role },
  { header: "action", value: (item) => item.action },
  { header: "action_type", value: (item) => item.action_type },
  { header: "target", value: (item) => item.target },
  { header: "target_type", value: (item) => item.target_type },
  { header: "target_name", value: (item) => item.target_name },
  { header: "detail", value: (item) => item.detail },
  { header: "severity", value: (item) => item.severity ?? "" },
  { header: "severity_reason", value: (item) => item.severity_reason ?? "" },
  { header: "redacted", value: (item) => item.redacted },
  { header: "metadata_json", value: (item) => JSON.stringify(item.metadata ?? {}) },
];

export const USAGE_RECORD_EXPORT_COLUMNS: Array<ExportColumn<UsageRecord>> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", kind: "datetime", value: (item) => item.created_at },
  { header: "user_id", value: (item) => item.user_id },
  { header: "user_name", value: (item) => item.user_name },
  { header: "user_role", value: (item) => item.user_role },
  { header: "model_id", value: (item) => item.model_id },
  { header: "provider_name", value: (item) => item.provider_name },
  { header: "surface", value: (item) => item.surface },
  { header: "message_count", value: (item) => item.message_count },
  { header: "prompt_tokens", value: (item) => item.prompt_tokens ?? "" },
  { header: "completion_tokens", value: (item) => item.completion_tokens ?? "" },
  { header: "total_tokens", value: (item) => item.total_tokens ?? "" },
  { header: "thread_id", value: (item) => item.thread_id ?? "" },
  { header: "source", value: (item) => item.source },
];

export const PROMPT_ACTIVITY_EXPORT_COLUMNS: Array<ExportColumn<UserPromptRecord>> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", kind: "datetime", value: (item) => item.created_at_iso || item.created_at },
  { header: "user_id", value: (item) => item.user_id },
  { header: "user_name", value: (item) => item.user_name },
  { header: "user_email", value: (item) => item.user_email },
  { header: "user_role", value: (item) => item.user_role ?? "" },
  { header: "thread_id", value: (item) => item.thread_id },
  { header: "thread_title", value: (item) => item.thread_title },
  { header: "model_id", value: (item) => item.model_id },
  { header: "active_alert_count", value: (item) => item.alert_count },
  { header: "prompt", value: (item) => item.content },
  { header: "response", value: (item) => item.response_content ?? "" },
  { header: "response_status", value: (item) => item.response_status ?? "" },
  { header: "response_truncated", value: (item) => item.response_truncated ?? false },
];
