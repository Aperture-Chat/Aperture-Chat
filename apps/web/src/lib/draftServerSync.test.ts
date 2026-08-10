import { beforeEach, describe, expect, test } from "vitest";
import {
  LEGACY_DRAFT_HISTORY_STORAGE_KEY,
  loadLegacyDraftHistory,
  loadScopedDraftCache,
  mergeServerDraftsIntoCache,
  removeLegacyDraftHistoryEntry,
  saveScopedDraftCache,
  scopedDraftCacheKey,
  utf8ByteLength,
} from "./draftServerSync";
import type { DraftDocument } from "./api/drafts";

type Entry = {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  serverId?: string | null;
  serverRevision?: number | null;
  serverContentStale?: boolean;
};

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Entry;
  return typeof entry.id === "string" && typeof entry.content === "string";
}

function serverDoc(overrides: Partial<DraftDocument> = {}): DraftDocument {
  return {
    id: "draft-srv-1",
    tenant_id: "tenant-example",
    owner_user_id: "user-admin",
    matter_id: null,
    title: "Server Draft",
    current_revision: 1,
    created_at: "2026-07-19T10:00:00Z",
    updated_at: "2026-07-19T10:00:00Z",
    ...overrides,
  };
}

const scopeA = { tenantId: "tenant-example", userId: "user-admin" };
const scopeB = { tenantId: "tenant-example", userId: "user-other" };

beforeEach(() => {
  window.localStorage.clear();
});

describe("scoped draft cache", () => {
  test("cache key is scoped by both tenant and user with encoded components", () => {
    expect(scopedDraftCacheKey(scopeA)).toBe("aperture-drafts-cache-v2:tenant-example:user-admin");
    expect(scopedDraftCacheKey({ tenantId: "t:1", userId: "u:2" })).toBe(
      "aperture-drafts-cache-v2:t%3A1:u%3A2",
    );
  });

  test("entries saved for one identity are invisible to another", () => {
    const entry: Entry = {
      id: "draft-1",
      title: "Mine",
      content: "<p>Mine</p>",
      updatedAt: "2026-07-19T10:00:00Z",
    };
    saveScopedDraftCache(scopeA, [entry]);
    expect(loadScopedDraftCache(scopeA, isEntry)).toHaveLength(1);
    expect(loadScopedDraftCache(scopeB, isEntry)).toHaveLength(0);
  });

  test("never reads the legacy unscoped key as a fallback", () => {
    window.localStorage.setItem(
      LEGACY_DRAFT_HISTORY_STORAGE_KEY,
      JSON.stringify([
        { id: "legacy-1", title: "Old", content: "<p>Old</p>", updatedAt: "2026-01-01T00:00:00Z" },
      ]),
    );
    expect(loadScopedDraftCache(scopeA, isEntry)).toHaveLength(0);
  });
});

describe("legacy quarantine", () => {
  test("loading legacy history never writes or migrates anything", () => {
    const raw = JSON.stringify([
      { id: "legacy-1", title: "Old", content: "<p>Old</p>", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    window.localStorage.setItem(LEGACY_DRAFT_HISTORY_STORAGE_KEY, raw);
    const legacy = loadLegacyDraftHistory(isEntry);
    expect(legacy).toHaveLength(1);
    expect(window.localStorage.getItem(LEGACY_DRAFT_HISTORY_STORAGE_KEY)).toBe(raw);
    expect(window.localStorage.getItem(scopedDraftCacheKey(scopeA))).toBeNull();
  });

  test("removing one imported entry keeps the rest quarantined", () => {
    window.localStorage.setItem(
      LEGACY_DRAFT_HISTORY_STORAGE_KEY,
      JSON.stringify([
        { id: "legacy-1", title: "A", content: "<p>A</p>", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "legacy-2", title: "B", content: "<p>B</p>", updatedAt: "2026-01-02T00:00:00Z" },
      ]),
    );
    removeLegacyDraftHistoryEntry("legacy-1");
    const remaining = loadLegacyDraftHistory(isEntry);
    expect(remaining.map((entry) => entry.id)).toEqual(["legacy-2"]);
    removeLegacyDraftHistoryEntry("legacy-2");
    expect(window.localStorage.getItem(LEGACY_DRAFT_HISTORY_STORAGE_KEY)).toBeNull();
  });
});

describe("mergeServerDraftsIntoCache", () => {
  const stub = (doc: DraftDocument): Entry => ({
    id: `server-${doc.id}`,
    title: doc.title,
    content: "",
    updatedAt: doc.updated_at,
    serverId: doc.id,
    serverRevision: null,
    serverContentStale: true,
  });

  test("keeps local content when revisions match and clears the stale flag", () => {
    const cached: Entry[] = [
      {
        id: "draft-a",
        title: "A",
        content: "<p>Full local copy</p>",
        updatedAt: "2026-07-19T09:00:00Z",
        serverId: "draft-srv-1",
        serverRevision: 1,
        serverContentStale: true,
      },
    ];
    const merged = mergeServerDraftsIntoCache(cached, [serverDoc()], stub);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("<p>Full local copy</p>");
    expect(merged[0].serverContentStale).toBe(false);
  });

  test("flags the entry stale when the server revision is ahead without advancing the CAS revision", () => {
    const cached: Entry[] = [
      {
        id: "draft-a",
        title: "A",
        content: "<p>Older local copy</p>",
        updatedAt: "2026-07-19T09:00:00Z",
        serverId: "draft-srv-1",
        serverRevision: 1,
      },
    ];
    const merged = mergeServerDraftsIntoCache(
      cached,
      [serverDoc({ current_revision: 4, title: "A (renamed)", updated_at: "2026-07-20T08:00:00Z" })],
      stub,
    );
    expect(merged[0].serverContentStale).toBe(true);
    expect(merged[0].serverRevision).toBe(1);
    expect(merged[0].title).toBe("A (renamed)");
  });

  test("creates stubs for unknown server drafts and preserves local-only entries", () => {
    const cached: Entry[] = [
      {
        id: "local-only",
        title: "Local only",
        content: "<p>Never synced</p>",
        updatedAt: "2026-07-20T09:00:00Z",
      },
    ];
    const merged = mergeServerDraftsIntoCache(cached, [serverDoc()], stub);
    expect(merged.map((entry) => entry.id).sort()).toEqual(["local-only", "server-draft-srv-1"]);
    const stubEntry = merged.find((entry) => entry.id === "server-draft-srv-1");
    expect(stubEntry?.serverContentStale).toBe(true);
    expect(stubEntry?.content).toBe("");
    const local = merged.find((entry) => entry.id === "local-only");
    expect(local?.serverId).toBeUndefined();
  });
});

test("utf8ByteLength counts multibyte characters", () => {
  expect(utf8ByteLength("abc")).toBe(3);
  expect(utf8ByteLength("é")).toBe(2);
});
