import { renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { loadThreadTitles, useThreadTitles } from "./threadTitles";

test("a long list of conversations is asked for in batches", async () => {
  const ids = Array.from({ length: 230 }, (_, index) => `thread-${index}`);
  const load = vi.fn(async (group: string[]) => Object.fromEntries(group.map((id) => [id, `Title ${id}`])));
  const titles = await loadThreadTitles(ids, load);
  expect(load.mock.calls.map(([group]) => group.length)).toEqual([100, 100, 30]);
  expect(Object.keys(titles)).toHaveLength(230);
});

test("an exact number of batches sends no empty request", async () => {
  const ids = Array.from({ length: 200 }, (_, index) => `thread-${index}`);
  const load = vi.fn(async () => ({}));
  await loadThreadTitles(ids, load);
  expect(load).toHaveBeenCalledTimes(2);
});

test("known conversations get their names", async () => {
  const load = vi.fn(async () => ({ "thread-1": "Lease review" }));
  const ids = ["thread-1"];
  const { result } = renderHook(() => useThreadTitles(ids, load));
  await waitFor(() => expect(result.current.get("thread-1")).toBe("Lease review"));
});

test("a conversation the server has no name for is not asked about again", async () => {
  const load = vi.fn(async () => ({}));
  const ids = ["thread-gone"];
  const { result, rerender } = renderHook(() => useThreadTitles(ids, load));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  rerender();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(load).toHaveBeenCalledTimes(1);
  expect(result.current.size).toBe(0);
});

test("new conversations are fetched without asking for the known ones again", async () => {
  const load = vi.fn(async (group: string[]) => Object.fromEntries(group.map((id) => [id, id.toUpperCase()])));
  const { result, rerender } = renderHook(({ ids }) => useThreadTitles(ids, load), {
    initialProps: { ids: ["a"] },
  });
  await waitFor(() => expect(result.current.get("a")).toBe("A"));
  rerender({ ids: ["a", "b"] });
  await waitFor(() => expect(result.current.get("b")).toBe("B"));
  expect(load).toHaveBeenLastCalledWith(["b"]);
});

test("a failed lookup leaves the generic label in place", async () => {
  const load = vi.fn(async () => {
    throw new Error("offline");
  });
  const ids = ["thread-1"];
  const { result } = renderHook(() => useThreadTitles(ids, load));
  await waitFor(() => expect(load).toHaveBeenCalled());
  expect(result.current.size).toBe(0);
});

test("without a loader nothing is asked for", () => {
  const ids = ["thread-1"];
  const { result } = renderHook(() => useThreadTitles(ids, undefined));
  expect(result.current.size).toBe(0);
});
