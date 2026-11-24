import type { BootstrapData, Group, User } from "./types";

/*
 * Group membership rules the admin console shows. A tenant admin may add or
 * remove only themself, and only in a group they created; adding any other
 * administrator stays with the platform owner. Platform owners hold no group
 * membership. The API enforces the same boundary.
 */

export function canJoinOwnGroup(actor: User, group: Group): boolean {
  return actor.role === "TENANT_ADMIN" && group.created_by_user_id === actor.id;
}

export function membershipGroupIds(user: User, groupId: string, member: boolean): string[] {
  if (!member) return user.group_ids.filter((id) => id !== groupId);
  return user.group_ids.includes(groupId) ? user.group_ids : [...user.group_ids, groupId];
}

/** Puts a user record the API returned everywhere the console reads it, including the signed-in user. */
export function withUpdatedUser(data: BootstrapData, updatedUser: User): BootstrapData {
  const merge = (user: User) => (user.id === updatedUser.id ? { ...user, ...updatedUser } : user);
  return {
    ...data,
    me: data.me.id === updatedUser.id ? { ...data.me, ...updatedUser } : data.me,
    users: data.users.map(merge),
    visibleUsers: data.visibleUsers.map(merge),
  };
}

/** Applies a confirmed membership change and moves the group's count once. */
export function withMembershipChange(
  data: BootstrapData,
  updatedUser: User,
  groupId: string,
  fallbackWasMember: boolean,
): BootstrapData {
  const loaded = [...data.visibleUsers, ...data.users].find((user) => user.id === updatedUser.id);
  const wasMember = loaded ? loaded.group_ids.includes(groupId) : fallbackWasMember;
  const delta = Number(updatedUser.group_ids.includes(groupId)) - Number(wasMember);
  const next = withUpdatedUser(data, updatedUser);
  return {
    ...next,
    groups: next.groups.map((group) =>
      group.id === groupId ? { ...group, user_count: Math.max(0, group.user_count + delta) } : group,
    ),
  };
}

export type MemberToggleCopy = { label: string; tooltip: string };

export function groupMemberToggleCopy(actor: User, user: User, group: Group, isMember: boolean): MemberToggleCopy {
  if (user.id === actor.id && canJoinOwnGroup(actor, group)) return ownGroupCopy(group, isMember);
  const label = `${isMember ? "Remove" : "Add"} ${user.display_name} ${isMember ? "from" : "to"} ${group.name}`;
  return { label, tooltip: memberToggleTooltip(actor, user, group, isMember) };
}

function ownGroupCopy(group: Group, isMember: boolean): MemberToggleCopy {
  return isMember
    ? { label: `Remove me from ${group.name}`, tooltip: `Leave ${group.name} and lose the access it grants` }
    : { label: `Add me to ${group.name}`, tooltip: `Join ${group.name} and get the access it grants` };
}

function memberToggleTooltip(actor: User, user: User, group: Group, isMember: boolean) {
  if (user.id === actor.id) return "You can add yourself only to groups you created";
  if (actor.role === "TENANT_ADMIN" && user.role === "TENANT_ADMIN") {
    return "Only the platform owner can add or remove administrators";
  }
  return isMember
    ? `Remove ${user.display_name} from ${group.name} and its access`
    : `Add ${user.display_name} to ${group.name} and grant its access`;
}
