import type { Role, User } from "./types";

const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_OWNER: "Platform Owner",
  TENANT_ADMIN: "Admin",
  POWER_USER: "Power User",
  AUDITOR: "Auditor",
  AGENT_APPROVER: "Agent Approver",
  USER: "User",
};

/** Compact, non-secret profile context for role-authorized user directories. */
export function userIdentityTooltip(user: User): string {
  const details = [
    user.display_name,
    `Email: ${user.email}`,
    user.phone?.trim() ? `Phone: ${user.phone.trim()}` : null,
    user.firm_name?.trim() ? `Position: ${user.firm_name.trim()}` : null,
    user.bio?.trim() ? `Bio: ${user.bio.trim()}` : null,
    user.website_url?.trim() ? `Website: ${user.website_url.trim()}` : null,
    `Role: ${ROLE_LABELS[user.role]}`,
  ].filter((value): value is string => Boolean(value));
  return details.join("\n");
}
