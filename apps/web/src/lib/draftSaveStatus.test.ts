import { expect, test } from "vitest";
import { draftSaveStatus } from "./draftSaveStatus";

test("an account copy that is behind keeps its warning and action while the user keeps editing", () => {
  expect(draftSaveStatus(true, { kind: "local-only", message: "Server save failed (offline)." })).toEqual({
    tone: "local-only",
    label: "Local only",
    detail: "Server save failed (offline).",
    action: { kind: "retry" },
  });
  expect(draftSaveStatus(true, { kind: "not-stored", message: "Browser storage is full." })).toMatchObject({
    tone: "not-stored",
    label: "Not saved",
    action: { kind: "retry" },
  });
  expect(draftSaveStatus(true, { kind: "conflict", serverId: "draft-7", message: "Changed elsewhere." })).toMatchObject({
    tone: "conflict",
    label: "Draft changed elsewhere",
    action: { kind: "reload", serverId: "draft-7" },
  });
});

test("unsaved edits read Editing even while an earlier version is still saving", () => {
  expect(draftSaveStatus(true, { kind: "saving" })).toMatchObject({ tone: "editing", label: "Editing", action: null });
  expect(draftSaveStatus(false, { kind: "saving" })).toMatchObject({ tone: "saving", label: "Saving…", action: null });
});

test("Saved names the account revision only when the server confirmed one", () => {
  expect(draftSaveStatus(false, { kind: "saved", revision: 4 })).toEqual({
    tone: "saved",
    label: "Saved",
    detail: "Saved to your account (revision 4).",
    action: null,
  });
  expect(draftSaveStatus(false, { kind: "idle" })).toMatchObject({ label: "Saved", detail: "Current version is saved." });
});

test("a shared draft reports its autosave, not the version it last saved", () => {
  expect(draftSaveStatus(true, { kind: "idle" }, { kind: "saving" })).toMatchObject({ tone: "saving", label: "Saving…" });
  expect(draftSaveStatus(true, { kind: "idle" }, { kind: "synced", seq: 4 })).toEqual({
    tone: "saved",
    label: "Saved",
    detail: "Every change is saved to your account for everyone sharing this draft. Save a version to mark a point you can go back to.",
    action: null,
  });
  expect(draftSaveStatus(false, { kind: "idle" }, { kind: "offline", message: "Could not reach the API.", retryInMs: 4000 })).toEqual({
    tone: "local-only",
    label: "Not saved yet",
    detail: "Could not reach the API. Your changes are kept in this window and save again in 4 seconds.",
    action: { kind: "retry" },
  });
});

test("a version save that failed still outranks a shared draft's autosave", () => {
  expect(draftSaveStatus(false, { kind: "local-only", message: "Version save failed." }, { kind: "synced", seq: 2 })).toMatchObject({
    tone: "local-only",
    label: "Local only",
  });
});
