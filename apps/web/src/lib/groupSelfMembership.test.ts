import { expect, test } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData, Group, User } from "./types";
import {
  canJoinOwnGroup,
  groupMemberToggleCopy,
  membershipGroupIds,
  withMembershipChange,
  withUpdatedUser,
} from "./groupSelfMembership";

function data(): BootstrapData {
  return structuredClone(sampleData) as BootstrapData;
}

function user(id: string): User {
  return data().users.find((item) => item.id === id)!;
}

function group(createdBy: string | null | undefined = "user-admin"): Group {
  const corporate = data().groups.find((item) => item.id === "group-corporate")!;
  return { ...corporate, created_by_user_id: createdBy };
}

test("a tenant admin may join only a group they created", () => {
  const admin = user("user-admin");
  expect(canJoinOwnGroup(admin, group("user-admin"))).toBe(true);
  expect(canJoinOwnGroup(admin, group("user-drew"))).toBe(false);
  expect(canJoinOwnGroup(admin, group(null))).toBe(false);
  expect(canJoinOwnGroup(admin, { ...group(), created_by_user_id: undefined })).toBe(false);
});

test("platform owners and regular users never join through the self route", () => {
  expect(canJoinOwnGroup(user("user-owner"), group("user-owner"))).toBe(false);
  expect(canJoinOwnGroup(user("user-jane"), group("user-jane"))).toBe(false);
});

test("membership group ids add once and remove cleanly", () => {
  const admin = user("user-admin");
  expect(membershipGroupIds(admin, "group-corporate", true)).toEqual([...admin.group_ids, "group-corporate"]);
  expect(membershipGroupIds(admin, "group-litigation", true)).toEqual(admin.group_ids);
  expect(membershipGroupIds(admin, "group-litigation", false)).toEqual(
    admin.group_ids.filter((id) => id !== "group-litigation"),
  );
});

test("an updated user replaces me, users, and visible users", () => {
  const current = data();
  const updated = { ...current.me, group_ids: ["group-corporate"] };
  const next = withUpdatedUser(current, updated);
  expect(next.me.group_ids).toEqual(["group-corporate"]);
  expect(next.users.find((item) => item.id === "user-admin")!.group_ids).toEqual(["group-corporate"]);
  expect(next.visibleUsers.find((item) => item.id === "user-admin")!.group_ids).toEqual(["group-corporate"]);
  expect(next.users.find((item) => item.id === "user-jane")).toEqual(current.users.find((item) => item.id === "user-jane"));
});

test("another user's update leaves me untouched", () => {
  const current = data();
  const jane = current.users.find((item) => item.id === "user-jane")!;
  const next = withUpdatedUser(current, { ...jane, group_ids: [] });
  expect(next.me).toBe(current.me);
  expect(next.visibleUsers.find((item) => item.id === "user-jane")!.group_ids).toEqual([]);
});

test("a membership change moves the group's count by one in the right direction", () => {
  const current = data();
  const joined = { ...current.me, group_ids: [...current.me.group_ids, "group-corporate"] };
  const afterJoin = withMembershipChange(current, joined, "group-corporate", false);
  expect(afterJoin.groups.find((item) => item.id === "group-corporate")!.user_count).toBe(1);
  expect(afterJoin.me.group_ids).toContain("group-corporate");

  const left = { ...joined, group_ids: current.me.group_ids };
  const afterLeave = withMembershipChange(afterJoin, left, "group-corporate", true);
  expect(afterLeave.groups.find((item) => item.id === "group-corporate")!.user_count).toBe(0);
  expect(afterLeave.groups.find((item) => item.id === "group-litigation")).toEqual(
    current.groups.find((item) => item.id === "group-litigation"),
  );
});

test("a repeated membership change does not count twice or go below zero", () => {
  const current = data();
  const joined = { ...current.me, group_ids: [...current.me.group_ids, "group-corporate"] };
  const once = withMembershipChange(current, joined, "group-corporate", false);
  const twice = withMembershipChange(once, joined, "group-corporate", false);
  expect(twice.groups.find((item) => item.id === "group-corporate")!.user_count).toBe(1);

  const left = { ...current.me };
  const below = withMembershipChange(current, left, "group-corporate", true);
  expect(below.groups.find((item) => item.id === "group-corporate")!.user_count).toBe(0);
});

test("the fallback membership is used when the user is not loaded", () => {
  const current = { ...data(), users: [], visibleUsers: [] };
  const joined = { ...current.me, id: "user-ghost", group_ids: ["group-corporate"] };
  const next = withMembershipChange(current, joined, "group-corporate", true);
  expect(next.groups.find((item) => item.id === "group-corporate")!.user_count).toBe(0);
  const fresh = withMembershipChange(current, joined, "group-corporate", false);
  expect(fresh.groups.find((item) => item.id === "group-corporate")!.user_count).toBe(1);
});

test("a user loaded only in the full user list still decides the count", () => {
  const current = data();
  current.visibleUsers = current.visibleUsers.filter((item) => item.id !== "user-jane");
  current.users = current.users.map((item) =>
    item.id === "user-jane" ? { ...item, group_ids: ["group-corporate"] } : item,
  );
  const jane = current.users.find((item) => item.id === "user-jane")!;
  const next = withMembershipChange(current, { ...jane, group_ids: ["group-corporate"] }, "group-corporate", false);
  expect(next.groups.find((item) => item.id === "group-corporate")!.user_count).toBe(0);
});

test("my own switch on a group I created says Add me or Remove me", () => {
  const admin = user("user-admin");
  expect(groupMemberToggleCopy(admin, admin, group("user-admin"), false)).toEqual({
    label: "Add me to Corporate",
    tooltip: "Join Corporate and get the access it grants",
  });
  expect(groupMemberToggleCopy(admin, admin, group("user-admin"), true)).toEqual({
    label: "Remove me from Corporate",
    tooltip: "Leave Corporate and lose the access it grants",
  });
});

test("my own switch on someone else's group explains the rule", () => {
  const admin = user("user-admin");
  expect(groupMemberToggleCopy(admin, admin, group("user-drew"), false)).toEqual({
    label: "Add Alex Morgan to Corporate",
    tooltip: "You can add yourself only to groups you created",
  });
});

test("a tenant admin sees that only the platform owner can add another administrator", () => {
  const admin = user("user-admin");
  const drew = user("user-drew");
  expect(groupMemberToggleCopy(admin, drew, group("user-admin"), true)).toEqual({
    label: "Remove Drew Parker from Corporate",
    tooltip: "Only the platform owner can add or remove administrators",
  });
});

test("regular members and the platform owner keep the plain add and remove wording", () => {
  const admin = user("user-admin");
  const owner = user("user-owner");
  const jane = user("user-jane");
  const drew = user("user-drew");
  expect(groupMemberToggleCopy(admin, jane, group(), false)).toEqual({
    label: "Add Jane Smith to Corporate",
    tooltip: "Add Jane Smith to Corporate and grant its access",
  });
  expect(groupMemberToggleCopy(owner, drew, group(), true)).toEqual({
    label: "Remove Drew Parker from Corporate",
    tooltip: "Remove Drew Parker from Corporate and its access",
  });
});
