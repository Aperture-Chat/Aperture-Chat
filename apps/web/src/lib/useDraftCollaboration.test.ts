import { describe, expect, it, vi } from "vitest";
import type { DraftSharing } from "./api/draftCollab";
import { isLiveSharing, liveEventHandler, liveServerState } from "./useDraftCollaboration";

function sharing(overrides: Partial<DraftSharing> = {}): DraftSharing {
  return {
    draft_id: "draft-1",
    owner: { id: "ana", display_name: "Ana", email: "ana@example.test" },
    role: "owner",
    can_manage: true,
    matter_bound: false,
    groups: [],
    people: [],
    ...overrides,
  };
}

describe("isLiveSharing", () => {
  it("is live once shared with a group or a person, and always for a collaborator", () => {
    expect(isLiveSharing(sharing(), "draft-1")).toBe(false);
    expect(isLiveSharing(sharing({ groups: [{ id: "g", name: "Lit", member_count: 2 }] }), "draft-1")).toBe(true);
    expect(isLiveSharing(sharing({ people: [{ id: "ben", display_name: "Ben", email: "b@x" }] }), "draft-1")).toBe(true);
    expect(isLiveSharing(sharing({ role: "collaborator", can_manage: false }), "draft-1")).toBe(true);
  });

  it("is never live for another draft's sharing or none", () => {
    expect(isLiveSharing(sharing({ role: "collaborator" }), "draft-2")).toBe(false);
    expect(isLiveSharing(null, "draft-1")).toBe(false);
    expect(isLiveSharing(sharing({ role: "collaborator" }), null)).toBe(false);
  });
});

describe("liveEventHandler", () => {
  function setup() {
    const session = { remoteSaved: vi.fn(), stop: vi.fn(), seq: 4 };
    const callbacks = { onParticipants: vi.fn(), onVersion: vi.fn(), onAccessLost: vi.fn() };
    return { session, callbacks, handle: liveEventHandler(session, "client-me", callbacks) };
  }

  it("catches up on hello and on other people's saves, not on its own", () => {
    const { session, callbacks, handle } = setup();
    handle({ event: "hello", data: { client_id: "client-me", role: "owner", seq: 7, current_revision: 2, participants: [] } });
    handle({ event: "live", data: { seq: 8, current_revision: 2, updated_by_client: "client-other" } });
    handle({ event: "live", data: { seq: 9, current_revision: 2, updated_by_client: "client-me" } });
    expect(session.remoteSaved.mock.calls).toEqual([[7], [8]]);
    expect(callbacks.onParticipants).toHaveBeenCalledWith([]);
  });

  it("reports versions, presence, resyncs, and lost access", () => {
    const { session, callbacks, handle } = setup();
    const person = { client_id: "c2", user_id: "ben", display_name: "Ben", color: 3, focus: null };
    handle({ event: "presence", data: { participants: [person] } });
    handle({ event: "version", data: { revision: 3, current_revision: 3, seq: 9, author_user_id: "ben", updated_by_client: "client-me" } });
    handle({ event: "resync", data: {} });
    handle({ event: "access", data: { state: "revoked" } });

    expect(callbacks.onParticipants).toHaveBeenCalledWith([person]);
    expect(callbacks.onVersion).toHaveBeenCalledWith({ revision: 3, authorUserId: "ben", byThisEditor: true });
    expect(session.remoteSaved.mock.calls).toEqual([[9], [5]]);
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(callbacks.onAccessLost).toHaveBeenCalledWith("revoked");
  });
});

describe("liveServerState", () => {
  it("names who last saved the live copy", () => {
    expect(
      liveServerState({
        live: {
          draft_id: "draft-1",
          kind: "deck",
          seq: 2,
          current_revision: 5,
          title: "Plan",
          content: "{}",
          content_sha256: "a".repeat(64),
          updated_at: "2026-11-03T12:00:00Z",
          updated_by_user_id: "ben",
          updated_by_client: "client-ben",
        },
        role: "collaborator",
        updated_by_name: "Ben",
      }),
    ).toEqual({
      seq: 2,
      currentRevision: 5,
      title: "Plan",
      content: "{}",
      updatedByUserId: "ben",
      updatedByClient: "client-ben",
      updatedByName: "Ben",
    });
  });
});
