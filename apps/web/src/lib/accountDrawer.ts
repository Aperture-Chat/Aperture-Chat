/* Display rules for the Account drawer. Pure, so each sentence the drawer shows
 * has one home and one test. */
import type { MyUsageBudgetCap } from "./api/auth";
import { apiRequest } from "./api/http";
import type { AccountProfileUpdateRequest, ChatThread, Role, User } from "./types";
import type { MfaAccountStatus } from "./api";

/** `GET /api/auth/me/usage-summary`: the caller's ledger for this UTC month. */
export type MyUsageSummary = {
  period_start: string;
  period_end: string;
  resets_at: string;
  requests: number;
  chats: number;
  total_tokens: number | null;
  tokens_reported_requests: number;
};

function assertUsageSummary(body: Partial<MyUsageSummary>): MyUsageSummary {
  const readable = typeof body.requests === "number" && typeof body.chats === "number" && !Number.isNaN(Date.parse(body.resets_at ?? ""));
  if (!readable) throw new Error("The usage summary could not be read.");
  return body as MyUsageSummary;
}

export async function getMyUsageSummary(userId: string): Promise<MyUsageSummary> {
  return assertUsageSummary(await apiRequest<Partial<MyUsageSummary>>(userId, "/api/auth/me/usage-summary"));
}

const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_OWNER: "Platform Owner",
  TENANT_ADMIN: "Admin",
  TEMP_USER: "Temp User",
  POWER_USER: "Power User",
  AUDITOR: "Auditor",
  AGENT_APPROVER: "Agent Approver",
  USER: "User",
};

/** Short enough that three stops share a rail in the narrowest drawer. */
const PREVIEW_ROLE_LABELS: Partial<Record<Role, string>> = {
  PLATFORM_OWNER: "Owner",
  TENANT_ADMIN: "Admin",
  USER: "User",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as Role] ?? "User";
}

export function previewRoleLabel(role: Role): string {
  return PREVIEW_ROLE_LABELS[role] ?? roleLabel(role);
}

export function availablePreviewRoles(role: Role): Role[] {
  if (role === "PLATFORM_OWNER") return ["PLATFORM_OWNER", "TENANT_ADMIN", "USER"];
  if (role === "TENANT_ADMIN") return ["TENANT_ADMIN", "USER"];
  return [role];
}

export function authMethodLabel(method?: string | null): string {
  return method === "local" ? "Password" : "Single sign-on";
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function archivedChatsLabel(count: number): string {
  return count > 0 ? `${plural(count, "archived chat")}` : "Chats you archive are kept here";
}

export function mfaSummary(status: MfaAccountStatus | null, authMethod?: string | null): string {
  if (!status) return "Authenticator app and recovery codes";
  if (status.enabled) {
    const codes = status.recovery_codes_remaining;
    const left = codes > 0 ? `${plural(codes, "recovery code")} left` : "No recovery codes left";
    return `On · ${left}`;
  }
  if (authMethod !== "local") return "Managed by your identity provider";
  return status.tenant_required ? "Required by your organization" : "Off";
}

export function mfaNeedsRecoveryCodes(status: MfaAccountStatus | null): boolean {
  return status !== null && status.enabled && status.recovery_codes_remaining === 0;
}

/** Replies that have finished, so an open drawer knows when to refresh usage. */
export function finishedReplyCount(threads: ChatThread[]): number {
  return threads.reduce(
    (total, thread) =>
      total + thread.messages.filter((message) => message.role === "assistant" && message.status !== "pending").length,
    0,
  );
}

const RESET_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Months run on the same UTC calendar as budget periods, so read it in UTC. */
export function usageResetLabel(summary: MyUsageSummary): string {
  return `Resets ${RESET_DAY.format(new Date(summary.resets_at))} UTC`;
}

/** With no requests there is nothing left unreported, so zero is the truth. */
export function usageTokensUnreported(summary: MyUsageSummary): boolean {
  return summary.total_tokens === null && summary.requests > 0;
}

const EXACT_COUNT = new Intl.NumberFormat("en-US");
const COMPACT_COUNT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function exactCount(value: number): string {
  return EXACT_COUNT.format(value);
}

/** Six digits and up go compact, so a figure always fits its tile on one line. */
export function usageCountLabel(value: number): string {
  return value < 100_000 ? exactCount(value) : COMPACT_COUNT.format(value);
}

export function usageTokensLabel(summary: MyUsageSummary): string {
  return usageTokensUnreported(summary) ? "Not reported" : usageCountLabel(summary.total_tokens ?? 0);
}

/** Only speaks up when the token total does not cover every request. */
export function usageTokensNote(summary: MyUsageSummary): string | null {
  const { requests, tokens_reported_requests: reported } = summary;
  if (reported === 0 || reported >= requests) return null;
  return `Tokens reported for ${exactCount(reported)} of ${exactCount(requests)} requests.`;
}

const PERIOD_ADJECTIVE: Record<Exclude<MyUsageBudgetCap["budget_period"], "lifetime">, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
};

const PERIOD_SPAN: Record<Exclude<MyUsageBudgetCap["budget_period"], "lifetime">, string> = {
  day: "today (UTC)",
  week: "this week",
  month: "this month",
};

export function capTitle(cap: MyUsageBudgetCap): string {
  if (cap.budget_period === "lifetime") return "Temporary token grant";
  const adjective = PERIOD_ADJECTIVE[cap.budget_period];
  if (cap.scope === "user") return `${adjective[0].toUpperCase()}${adjective.slice(1)} tokens`;
  return `${cap.label} · ${adjective}`;
}

export function capDetail(cap: MyUsageBudgetCap): string {
  const used = `${exactCount(cap.reported_tokens)} of ${exactCount(cap.daily_token_limit)} used`;
  return cap.budget_period === "lifetime" ? used : `${used} ${PERIOD_SPAN[cap.budget_period]}`;
}

/** A spent cap means replies are being refused, unlike one that merely rounds up. */
export function capSpent(cap: MyUsageBudgetCap): boolean {
  return cap.reported_tokens >= cap.daily_token_limit;
}

/** Whole percent of the cap used, held to the meter's 0 to 100 range. */
export function capPercent(cap: MyUsageBudgetCap): number {
  if (cap.daily_token_limit <= 0) return 0;
  return Math.min(100, Math.round((cap.reported_tokens / cap.daily_token_limit) * 100));
}

const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type ProfileDraft = {
  displayName: string;
  firmName: string;
  websiteUrl: string;
  phone: string;
  bio: string;
  avatarUrl: string;
};

export function profileDraftFromUser(user: User): ProfileDraft {
  return {
    displayName: user.display_name,
    firmName: user.firm_name ?? "",
    websiteUrl: user.website_url ?? "",
    phone: user.phone ?? "",
    bio: user.bio ?? "",
    avatarUrl: user.avatar_url ?? "",
  };
}

/** An empty string clears a field. The API reads null as "leave it alone". */
export function profileUpdateFromDraft(draft: ProfileDraft): AccountProfileUpdateRequest {
  return {
    display_name: draft.displayName.trim(),
    firm_name: draft.firmName.trim(),
    website_url: draft.websiteUrl.trim(),
    phone: draft.phone.trim(),
    bio: draft.bio.trim(),
    avatar_url: draft.avatarUrl.trim(),
  };
}

function isProfileImageReference(value: string) {
  if (value.startsWith("data:image/") || value.startsWith("/")) return true;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function dataUrlByteLength(value: string): number | null {
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0 || !value.slice(0, commaIndex).toLowerCase().includes(";base64")) return null;
  const encoded = value.slice(commaIndex + 1).replace(/\s/g, "");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}

/** The first problem with a draft, or null when it can be sent. */
export function profileDraftProblem(draft: ProfileDraft): string | null {
  const websiteUrl = draft.websiteUrl.trim();
  const avatarUrl = draft.avatarUrl.trim();
  if (!draft.displayName.trim()) return "Enter a display name.";
  if (websiteUrl && !/^https?:\/\/\S+$/i.test(websiteUrl)) return "Use a complete http(s) website URL.";
  if (avatarUrl && !isProfileImageReference(avatarUrl)) {
    return "Use an http(s), relative, or uploaded image for your profile photo.";
  }
  if (!avatarUrl.startsWith("data:image/")) return null;
  const decodedBytes = dataUrlByteLength(avatarUrl);
  if (decodedBytes === null) return "Uploaded profile photo data is invalid.";
  return decodedBytes > PROFILE_IMAGE_MAX_BYTES ? "Choose a profile photo that is 5 MB or smaller." : null;
}

export function profileDraftChanged(draft: ProfileDraft, user: User): boolean {
  const saved = profileDraftFromUser(user);
  return (Object.keys(saved) as (keyof ProfileDraft)[]).some((field) => draft[field] !== saved[field]);
}

export function photoFileProblem(file: Pick<File, "type" | "size">): string | null {
  if (!file.type.startsWith("image/")) return "Choose an image file for your profile photo.";
  return file.size > PROFILE_IMAGE_MAX_BYTES ? "Choose a profile photo that is 5 MB or smaller." : null;
}

export type PasswordDraft = { currentPassword: string; newPassword: string; confirmPassword: string };

export function passwordDraftDirty(draft: PasswordDraft): boolean {
  return Object.values(draft).some(Boolean);
}

export function passwordDraftProblem(draft: PasswordDraft): string | null {
  if (!draft.currentPassword) return "Enter your current password.";
  if (draft.newPassword.length < 12) return "Use a password with at least 12 characters.";
  return draft.newPassword === draft.confirmPassword ? null : "The new passwords do not match.";
}
