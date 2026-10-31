import { afterEach, expect, test, vi } from "vitest";
import type { MyUsageBudgetCap } from "./api/auth";
import type { MfaAccountStatus } from "./api";
import type { ChatThread, User } from "./types";
import {
  archivedChatsLabel,
  authMethodLabel,
  availablePreviewRoles,
  capDetail,
  capPercent,
  capSpent,
  capTitle,
  finishedReplyCount,
  getMyUsageSummary,
  mfaSummary,
  passwordDraftProblem,
  photoFileProblem,
  previewRoleLabel,
  passwordDraftDirty,
  profileDraftChanged,
  profileDraftFromUser,
  profileDraftProblem,
  profileUpdateFromDraft,
  roleLabel,
  mfaNeedsRecoveryCodes,
  usageCountLabel,
  usageResetLabel,
  usageTokensLabel,
  usageTokensNote,
  usageTokensUnreported,
  type MyUsageSummary,
  type ProfileDraft,
} from "./accountDrawer";

const summary: MyUsageSummary = {
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  resets_at: "2026-11-01T00:00:00+00:00",
  requests: 4,
  chats: 2,
  total_tokens: 12345,
  tokens_reported_requests: 4,
};

const mfa: MfaAccountStatus = {
  enabled: true,
  tenant_required: false,
  can_disable: true,
  confirmed_at: null,
  recovery_codes_remaining: 8,
};

const cap: MyUsageBudgetCap = {
  scope: "user",
  label: "Your budget",
  budget_period: "day",
  daily_token_limit: 2000,
  reported_tokens: 500,
  period_start: "2026-10-30",
  period_end: "2026-10-30",
};

function threadWith(...statuses: [string, string][]): ChatThread {
  return { id: "t", messages: statuses.map(([role, status], index) => ({ id: `m${index}`, role, status, content: "", createdAt: "" })) } as ChatThread;
}

test("role labels fall back to User for an unknown role", () => {
  expect(roleLabel("PLATFORM_OWNER")).toBe("Platform Owner");
  expect(roleLabel("AUDITOR")).toBe("Auditor");
  expect(roleLabel("SOMETHING_NEW")).toBe("User");
});

test("preview labels are short, and other roles keep their full name", () => {
  expect(previewRoleLabel("PLATFORM_OWNER")).toBe("Owner");
  expect(previewRoleLabel("TENANT_ADMIN")).toBe("Admin");
  expect(previewRoleLabel("USER")).toBe("User");
  expect(previewRoleLabel("POWER_USER")).toBe("Power User");
});

test("preview roles step down from the real role", () => {
  expect(availablePreviewRoles("PLATFORM_OWNER")).toEqual(["PLATFORM_OWNER", "TENANT_ADMIN", "USER"]);
  expect(availablePreviewRoles("TENANT_ADMIN")).toEqual(["TENANT_ADMIN", "USER"]);
  expect(availablePreviewRoles("USER")).toEqual(["USER"]);
  expect(availablePreviewRoles("POWER_USER")).toEqual(["POWER_USER"]);
});

test("auth method reads in plain words", () => {
  expect(authMethodLabel("local")).toBe("Password");
  expect(authMethodLabel("sso")).toBe("Single sign-on");
  expect(authMethodLabel(undefined)).toBe("Single sign-on");
});

test("archived chats count agrees in number", () => {
  expect(archivedChatsLabel(0)).toBe("Chats you archive are kept here");
  expect(archivedChatsLabel(1)).toBe("1 archived chat");
  expect(archivedChatsLabel(66)).toBe("66 archived chats");
});

test("the security summary follows the real state", () => {
  expect(mfaSummary(null, "local")).toBe("Authenticator app and recovery codes");
  expect(mfaSummary(mfa, "local")).toBe("On · 8 recovery codes left");
  expect(mfaSummary({ ...mfa, recovery_codes_remaining: 1 }, "local")).toBe("On · 1 recovery code left");
  expect(mfaSummary({ ...mfa, recovery_codes_remaining: 0 }, "local")).toBe("On · No recovery codes left");
  expect(mfaSummary({ ...mfa, enabled: false }, "local")).toBe("Off");
  expect(mfaSummary({ ...mfa, enabled: false, tenant_required: true }, "local")).toBe("Required by your organization");
  expect(mfaSummary({ ...mfa, enabled: false }, "sso")).toBe("Managed by your identity provider");
});

test("finished replies skip pending replies and prompts", () => {
  const threads = [threadWith(["user", "ok"], ["assistant", "ok"], ["assistant", "pending"]), threadWith(["assistant", "error"])];
  expect(finishedReplyCount(threads)).toBe(2);
  expect(finishedReplyCount([])).toBe(0);
});

test("the reset day is the UTC day, whatever the browser's zone", () => {
  expect(usageResetLabel(summary)).toBe("Resets Nov 1 UTC");
  expect(usageResetLabel({ ...summary, resets_at: "2027-01-01T00:00:00+00:00" })).toBe("Resets Jan 1 UTC");
});

test("token totals are never invented", () => {
  expect(usageTokensLabel(summary)).toBe("12,345");
  expect(usageTokensLabel({ ...summary, total_tokens: 18264512 })).toBe("18.3M");
  expect(usageTokensLabel({ ...summary, total_tokens: 0 })).toBe("0");
  expect(usageTokensLabel({ ...summary, total_tokens: null })).toBe("Not reported");
  expect(usageTokensLabel({ ...summary, requests: 0, total_tokens: null })).toBe("0");
});

test("tokens count as unreported only when requests ran without a report", () => {
  expect(usageTokensUnreported({ ...summary, total_tokens: null })).toBe(true);
  expect(usageTokensUnreported({ ...summary, total_tokens: null, requests: 1 })).toBe(true);
  expect(usageTokensUnreported({ ...summary, total_tokens: null, requests: 0 })).toBe(false);
  expect(usageTokensUnreported(summary)).toBe(false);
  expect(usageTokensUnreported({ ...summary, total_tokens: 0 })).toBe(false);
  expect(usageTokensUnreported({ ...summary, requests: 0 })).toBe(false);
});

test("large counts stay on one line, and small ones stay exact", () => {
  expect(usageCountLabel(0)).toBe("0");
  expect(usageCountLabel(99999)).toBe("99,999");
  expect(usageCountLabel(100000)).toBe("100K");
  expect(usageCountLabel(123456)).toBe("123.5K");
  expect(usageCountLabel(18264512)).toBe("18.3M");
  expect(usageCountLabel(2500000000)).toBe("2.5B");
});

test("the token note appears only for a partial total", () => {
  expect(usageTokensNote(summary)).toBeNull();
  expect(usageTokensNote({ ...summary, tokens_reported_requests: 0 })).toBeNull();
  expect(usageTokensNote({ ...summary, tokens_reported_requests: 3 })).toBe("Tokens reported for 3 of 4 requests.");
  expect(usageTokensNote({ ...summary, requests: 1, tokens_reported_requests: 1 })).toBeNull();
  expect(usageTokensNote({ ...summary, requests: 1284, tokens_reported_requests: 1270 })).toBe("Tokens reported for 1,270 of 1,284 requests.");
});

test("cap titles name the period, and a group cap names the group", () => {
  expect(capTitle(cap)).toBe("Daily tokens");
  expect(capTitle({ ...cap, budget_period: "week" })).toBe("Weekly tokens");
  expect(capTitle({ ...cap, budget_period: "month" })).toBe("Monthly tokens");
  expect(capTitle({ ...cap, budget_period: "lifetime" })).toBe("Temporary token grant");
  expect(capTitle({ ...cap, scope: "group", label: "Litigation", budget_period: "month" })).toBe("Litigation · monthly");
});

test("cap detail reads naturally for period and lifetime caps", () => {
  expect(capDetail(cap)).toBe("500 of 2,000 used today (UTC)");
  expect(capDetail({ ...cap, budget_period: "month" })).toBe("500 of 2,000 used this month");
  expect(capDetail({ ...cap, budget_period: "lifetime" })).toBe("500 of 2,000 used");
});

test("the meter stays inside 0 to 100", () => {
  expect(capPercent(cap)).toBe(25);
  expect(capPercent({ ...cap, reported_tokens: 5000 })).toBe(100);
  expect(capPercent({ ...cap, reported_tokens: 2000 })).toBe(100);
  expect(capPercent({ ...cap, daily_token_limit: 0 })).toBe(0);
  expect(capPercent({ ...cap, daily_token_limit: 1, reported_tokens: 1 })).toBe(100);
});

test("a cap is spent at its limit, and not before", () => {
  expect(capSpent({ ...cap, reported_tokens: 2000 })).toBe(true);
  expect(capSpent({ ...cap, reported_tokens: 2500 })).toBe(true);
  expect(capSpent({ ...cap, reported_tokens: 1999 })).toBe(false);
  expect(capPercent({ ...cap, reported_tokens: 1999 })).toBe(100);
});

test("running out of recovery codes only matters while verification is on", () => {
  expect(mfaNeedsRecoveryCodes({ ...mfa, recovery_codes_remaining: 0 })).toBe(true);
  expect(mfaNeedsRecoveryCodes({ ...mfa, recovery_codes_remaining: 1 })).toBe(false);
  expect(mfaNeedsRecoveryCodes({ ...mfa, enabled: false, recovery_codes_remaining: 0 })).toBe(false);
  expect(mfaNeedsRecoveryCodes(null)).toBe(false);
});

function stubUsageResponse(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })));
}

afterEach(() => vi.unstubAllGlobals());

test("a well-formed usage summary passes through untouched", async () => {
  stubUsageResponse(summary);
  await expect(getMyUsageSummary("user-jane")).resolves.toEqual(summary);
});

test.each([
  ["no request count", { ...summary, requests: undefined }],
  ["a text request count", { ...summary, requests: "4" }],
  ["no chat count", { ...summary, chats: undefined }],
  ["a text chat count", { ...summary, chats: "2" }],
  ["no reset time", { ...summary, resets_at: undefined }],
  ["an unreadable reset time", { ...summary, resets_at: "soon" }],
])("a usage summary with %s is refused at the door", async (_label, body) => {
  stubUsageResponse(body);
  await expect(getMyUsageSummary("user-jane")).rejects.toThrow("The usage summary could not be read.");
});

const draft: ProfileDraft = { displayName: "Jane", firmName: "", websiteUrl: "", phone: "", bio: "", avatarUrl: "" };
const FIVE_MB = 5 * 1024 * 1024;
const dataUrl = (encoded: string) => `data:image/png;base64,${encoded}`;

test("a draft starts from the user, with empty fields for anything unset", () => {
  const user = { display_name: "Jane", firm_name: null, website_url: null, phone: null, bio: null, avatar_url: null } as unknown as User;
  expect(profileDraftFromUser(user)).toEqual(draft);
  const full = { display_name: "Jane", firm_name: "F", website_url: "W", phone: "P", bio: "B", avatar_url: "A" } as User;
  expect(profileDraftFromUser(full)).toEqual({ displayName: "Jane", firmName: "F", websiteUrl: "W", phone: "P", bio: "B", avatarUrl: "A" });
});

test("a profile draft is dirty only when it differs from the saved user", () => {
  const user = { display_name: "Jane", firm_name: null, website_url: null, phone: null, bio: null, avatar_url: null } as unknown as User;
  expect(profileDraftChanged(profileDraftFromUser(user), user)).toBe(false);
  expect(profileDraftChanged({ ...draft, bio: "New" }, user)).toBe(true);
  expect(profileDraftChanged({ ...draft, displayName: "June" }, user)).toBe(true);
});

test("a password draft is dirty once anything is typed", () => {
  const empty = { currentPassword: "", newPassword: "", confirmPassword: "" };
  expect(passwordDraftDirty(empty)).toBe(false);
  expect(passwordDraftDirty({ ...empty, currentPassword: "a" })).toBe(true);
  expect(passwordDraftDirty({ ...empty, newPassword: "a" })).toBe(true);
  expect(passwordDraftDirty({ ...empty, confirmPassword: "a" })).toBe(true);
});

test("a save trims every field and sends empty strings so emptied fields clear", () => {
  expect(profileUpdateFromDraft({ displayName: " Jane ", firmName: " F ", websiteUrl: " W ", phone: " P ", bio: " B ", avatarUrl: " A " })).toEqual({
    display_name: "Jane", firm_name: "F", website_url: "W", phone: "P", bio: "B", avatar_url: "A",
  });
  expect(profileUpdateFromDraft(draft)).toEqual({ display_name: "Jane", firm_name: "", website_url: "", phone: "", bio: "", avatar_url: "" });
});

test("a profile draft needs a name", () => {
  expect(profileDraftProblem(draft)).toBeNull();
  expect(profileDraftProblem({ ...draft, displayName: "   " })).toBe("Enter a display name.");
});

test("a website must be a whole http(s) address", () => {
  const bad = "Use a complete http(s) website URL.";
  expect(profileDraftProblem({ ...draft, websiteUrl: "not a url" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, websiteUrl: "ftp://example.test" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, websiteUrl: "see https://example.test" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, websiteUrl: "https://example.test/a b" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, websiteUrl: "https://" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, websiteUrl: "  HTTPS://example.test  " })).toBeNull();
  expect(profileDraftProblem({ ...draft, websiteUrl: "http://example.test" })).toBeNull();
});

test("a photo address must be an image reference", () => {
  const bad = "Use an http(s), relative, or uploaded image for your profile photo.";
  expect(profileDraftProblem({ ...draft, avatarUrl: "javascript:alert(1)" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, avatarUrl: "ftp://example.test/a.png" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, avatarUrl: "plain words" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, avatarUrl: "data:text/html;base64,AAAA" })).toBe(bad);
  expect(profileDraftProblem({ ...draft, avatarUrl: "/uploads/a.png" })).toBeNull();
  expect(profileDraftProblem({ ...draft, avatarUrl: "https://example.test/a.png" })).toBeNull();
  expect(profileDraftProblem({ ...draft, avatarUrl: "http://example.test/a.png" })).toBeNull();
});

test("an uploaded photo must be base64 data", () => {
  const invalid = "Uploaded profile photo data is invalid.";
  expect(profileDraftProblem({ ...draft, avatarUrl: "data:image/png,not-base64" })).toBe(invalid);
  expect(profileDraftProblem({ ...draft, avatarUrl: "data:image/png;base64" })).toBe(invalid);
  expect(profileDraftProblem({ ...draft, avatarUrl: "data:image/png;BASE64,AAAA" })).toBeNull();
  expect(profileDraftProblem({ ...draft, avatarUrl: dataUrl("AAAA") })).toBeNull();
  expect(profileDraftProblem({ ...draft, avatarUrl: dataUrl("A A\nA A") })).toBeNull();
});

test("the five megabyte limit counts decoded bytes, padding included", () => {
  // 5 MB is 5242880 bytes: 1747626 full groups (5242878 bytes) plus two more.
  const groups = "AAAA".repeat(1747626);
  const tooLarge = "Choose a profile photo that is 5 MB or smaller.";
  expect(profileDraftProblem({ ...draft, avatarUrl: dataUrl(`${groups}AAA=`) })).toBeNull();
  expect(profileDraftProblem({ ...draft, avatarUrl: dataUrl(`${groups}AA==`) })).toBeNull();
  expect(profileDraftProblem({ ...draft, avatarUrl: dataUrl(`${groups}AAAA`) })).toBe(tooLarge);
  expect(profileDraftProblem({ ...draft, avatarUrl: dataUrl(`${groups}AAAAAA==`) })).toBe(tooLarge);
});

test("photo files must be images within five megabytes", () => {
  expect(photoFileProblem({ type: "text/plain", size: 10 })).toBe("Choose an image file for your profile photo.");
  expect(photoFileProblem({ type: "image/png", size: FIVE_MB + 1 })).toBe("Choose a profile photo that is 5 MB or smaller.");
  expect(photoFileProblem({ type: "image/png", size: FIVE_MB })).toBeNull();
});

test("a password change needs the current password, length, and a match", () => {
  const good = { currentPassword: "old", newPassword: "twelve-chars", confirmPassword: "twelve-chars" };
  expect(passwordDraftProblem(good)).toBeNull();
  expect(passwordDraftProblem({ ...good, currentPassword: "" })).toBe("Enter your current password.");
  expect(passwordDraftProblem({ ...good, newPassword: "eleven-char", confirmPassword: "eleven-char" })).toBe("Use a password with at least 12 characters.");
  expect(passwordDraftProblem({ ...good, confirmPassword: "twelve-charz" })).toBe("The new passwords do not match.");
});
