import { describe, expect, it } from "vitest";
import type { DraftSharing, ShareDirectory } from "./api/draftCollab";
import { choiceFromSharing, sharePayload, sharingSentence, shareChoiceProblem } from "./draftShareChoice";

const directory: ShareDirectory = {
  groups: [
    { id: "group-lit", name: "Litigation", member_count: 12 },
    { id: "group-tax", name: "Tax", member_count: 4 },
  ],
  people: [
    { id: "ben", display_name: "Ben Partner", email: "ben@example.test" },
    { id: "cy", display_name: "Cy Associate", email: "cy@example.test" },
  ],
  people_scope: "groups",
};

function sharing(overrides: Partial<DraftSharing> = {}): DraftSharing {
  return {
    draft_id: "draft-1",
    owner: { id: "ana", display_name: "Ana Owner", email: "ana@example.test" },
    role: "owner",
    can_manage: true,
    matter_bound: false,
    groups: [],
    people: [],
    ...overrides,
  };
}

describe("draft share choice", () => {
  it("starts private, with the only group preselected for when they switch", () => {
    const choice = choiceFromSharing(sharing(), { ...directory, groups: [directory.groups[0]] });
    expect(choice).toEqual({ mode: "private", groupIds: ["group-lit"], userIds: [] });
    expect(sharePayload(choice)).toEqual({ group_ids: [], user_ids: [] });
  });

  it("reads an existing group or people share back into the matching mode", () => {
    expect(choiceFromSharing(sharing({ groups: [directory.groups[1]] }), directory)).toEqual({
      mode: "group",
      groupIds: ["group-tax"],
      userIds: [],
    });
    expect(choiceFromSharing(sharing({ people: [directory.people[0]] }), directory)).toEqual({
      mode: "people",
      groupIds: [],
      userIds: ["ben"],
    });
  });

  it("sends only the chosen mode's shares", () => {
    expect(sharePayload({ mode: "group", groupIds: ["group-lit"], userIds: ["ben"] })).toEqual({
      group_ids: ["group-lit"],
      user_ids: [],
    });
    expect(sharePayload({ mode: "people", groupIds: ["group-lit"], userIds: ["ben", "cy"] })).toEqual({
      group_ids: [],
      user_ids: ["ben", "cy"],
    });
  });

  it("asks for a group or a person before sharing", () => {
    expect(shareChoiceProblem({ mode: "group", groupIds: [], userIds: [] })).toBe("Choose at least one group.");
    expect(shareChoiceProblem({ mode: "people", groupIds: [], userIds: [] })).toBe("Add at least one person.");
    expect(shareChoiceProblem({ mode: "private", groupIds: [], userIds: [] })).toBeNull();
  });

  it("says in words who can open the draft", () => {
    expect(sharingSentence(sharing())).toBe("Only you can open this draft.");
    expect(sharingSentence(sharing({ groups: [directory.groups[0]] }))).toBe(
      "Everyone in Litigation can open and edit this draft.",
    );
    expect(sharingSentence(sharing({ people: directory.people }))).toBe(
      "Ben Partner and Cy Associate can open and edit this draft.",
    );
    expect(
      sharingSentence(sharing({ groups: [directory.groups[0]], people: directory.people })),
    ).toBe("Everyone in Litigation, Ben Partner and Cy Associate can open and edit this draft.");
    expect(sharingSentence(sharing({ role: "collaborator", can_manage: false, people: [directory.people[0]] }))).toBe(
      "Ana Owner shared this draft with you. Ben Partner can open and edit it.",
    );
  });
});
