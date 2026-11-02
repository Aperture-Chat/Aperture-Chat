import { expect, test } from "vitest";
import { EMPTY_SECTION_SCOPE, scopeFilenamePart, sectionScopeMatch, toggleScopeUser } from "./SectionScopeFilter";

const WHEN = "2026-07-01T12:00:00Z";
const USERS = [
  { id: "u1", label: "Jordan Lee" },
  { id: "u2", label: "Riley O'Neil" },
];

test("an empty user list means everyone, signed-in or not", () => {
  expect(sectionScopeMatch(EMPTY_SECTION_SCOPE, WHEN, "u1")).toBe(true);
  expect(sectionScopeMatch(EMPTY_SECTION_SCOPE, WHEN, null)).toBe(true);
});

test("a filter with people keeps only those people", () => {
  const scope = { ...EMPTY_SECTION_SCOPE, userIds: ["u1", "u2"] };
  expect(sectionScopeMatch(scope, WHEN, "u1")).toBe(true);
  expect(sectionScopeMatch(scope, WHEN, "u2")).toBe(true);
  expect(sectionScopeMatch(scope, WHEN, "u3")).toBe(false);
  expect(sectionScopeMatch(scope, WHEN, null)).toBe(false);
  expect(sectionScopeMatch(scope, WHEN, undefined)).toBe(false);
});

test("dates still apply on top of the people", () => {
  const scope = { fromDate: "2026-08-01", throughDate: "", userIds: ["u1"] };
  expect(sectionScopeMatch(scope, WHEN, "u1")).toBe(false);
});

test("a click adds a person, and a second click takes them back out", () => {
  const added = toggleScopeUser(EMPTY_SECTION_SCOPE, "u1");
  expect(added.userIds).toEqual(["u1"]);
  const both = toggleScopeUser(added, "u2");
  expect(both.userIds).toEqual(["u1", "u2"]);
  expect(toggleScopeUser(both, "u1").userIds).toEqual(["u2"]);
});

test("the file name says who the export covers", () => {
  expect(scopeFilenamePart(EMPTY_SECTION_SCOPE, USERS)).toBe("");
  expect(scopeFilenamePart({ ...EMPTY_SECTION_SCOPE, userIds: ["u2"] }, USERS)).toBe("riley-o-neil");
  expect(scopeFilenamePart({ ...EMPTY_SECTION_SCOPE, userIds: ["u1", "u2"] }, USERS)).toBe("2-users");
  expect(scopeFilenamePart({ ...EMPTY_SECTION_SCOPE, userIds: ["gone"] }, USERS)).toBe("gone");
});
