import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { UserGuidePlaylist } from "./trainingDecks/user";

vi.mock("@remotion/player", () => ({ Player: () => <div data-testid="player" /> }));

afterEach(() => vi.restoreAllMocks());

function openVideo() {
  render(<UserGuidePlaylist />);
  fireEvent.click(screen.getByRole("button", { name: /Build a slide deck/ }));
  return screen.getByTestId("player").parentElement!;
}

test("fullscreen falls back to an expanded player when the browser rejects it and can be exited", async () => {
  const card = openVideo();
  const request = vi.fn().mockRejectedValue(new Error("Gesture required"));
  Object.defineProperty(card, "requestFullscreen", { configurable: true, value: request });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Fullscreen video" })));
  expect(request).toHaveBeenCalledOnce();
  expect(card).toHaveClass("is-expanded");
  fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
  expect(card).not.toHaveClass("is-expanded");
  expect(screen.getByTestId("player").parentElement).toBe(card);
});

test("landscape expands without restarting the player; portrait and Escape restore it", () => {
  let rotate = () => {};
  const media = { matches: false, addEventListener: vi.fn((_event, listener) => { rotate = listener; }), removeEventListener: vi.fn() };
  vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
  const card = openVideo();
  act(() => { media.matches = true; rotate(); });
  expect(card).toHaveClass("is-expanded");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(card).not.toHaveClass("is-expanded");
  act(() => { media.matches = true; rotate(); });
  act(() => { media.matches = false; rotate(); });
  expect(card).not.toHaveClass("is-expanded");
  expect(screen.getByTestId("player").parentElement).toBe(card);
});
