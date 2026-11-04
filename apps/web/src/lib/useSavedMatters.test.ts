import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as mattersApi from "./api/matters";
import type { Matter } from "./matters";
import { clearSavedMatters, useSavedMatters } from "./useSavedMatters";

function matter(id: string, name: string): Matter {
  return {
    id,
    tenant_id: "tenant-example",
    name,
    created_by_user_id: "user-jane",
    version: 1,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearSavedMatters();
});

describe("useSavedMatters", () => {
  it("loads this person's matters for the tenant they are viewing", async () => {
    const list = vi.spyOn(mattersApi, "listMatters").mockResolvedValue([matter("matter-1", "100234-0001")]);
    const view = renderHook(() => useSavedMatters("user-owner", "example"));
    expect(view.result.current.status).toBe("loading");
    await waitFor(() => expect(view.result.current.status).toBe("ready"));
    expect(view.result.current.matters.map((item) => item.name)).toEqual(["100234-0001"]);
    expect(list).toHaveBeenCalledWith("user-owner", expect.objectContaining({ tenantSlug: "example" }));
  });

  it("offers a number typed once to every later picker without asking the server to save it again", async () => {
    vi.spyOn(mattersApi, "listMatters").mockResolvedValue([]);
    const create = vi.spyOn(mattersApi, "createMatter").mockImplementation(async (_user, name) => matter("matter-new", name));
    const first = renderHook(() => useSavedMatters("user-jane"));
    await waitFor(() => expect(first.result.current.status).toBe("ready"));

    let created!: Matter;
    await act(async () => { created = await first.result.current.resolve(" 100234-0009 "); });
    expect(created.name).toBe("100234-0009");
    expect(first.result.current.matters.map((item) => item.id)).toEqual(["matter-new"]);

    let again!: Matter;
    await act(async () => { again = await first.result.current.resolve("100234-0009"); });
    expect(again.id).toBe("matter-new");
    expect(create).toHaveBeenCalledTimes(1);

    // A picker opened later in the session starts from the saved list.
    vi.spyOn(mattersApi, "listMatters").mockImplementation(() => new Promise(() => undefined));
    const later = renderHook(() => useSavedMatters("user-jane"));
    expect(later.result.current.status).toBe("ready");
    expect(later.result.current.matters.map((item) => item.id)).toEqual(["matter-new"]);
  });

  it("says when the list could not load and loads again on retry", async () => {
    const list = vi
      .spyOn(mattersApi, "listMatters")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([matter("matter-1", "100234-0001")]);
    const view = renderHook(() => useSavedMatters("user-jane"));
    await waitFor(() => expect(view.result.current.status).toBe("failed"));
    act(() => view.result.current.retry());
    await waitFor(() => expect(view.result.current.status).toBe("ready"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("asks the server for nothing while turned off", () => {
    const list = vi.spyOn(mattersApi, "listMatters");
    renderHook(() => useSavedMatters("user-jane", undefined, false));
    expect(list).not.toHaveBeenCalled();
  });
});
