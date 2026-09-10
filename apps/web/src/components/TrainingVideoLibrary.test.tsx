import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { UserGuidePlaylist } from "./trainingDecks/user";
import { AuthScreen } from "./AuthScreen";

vi.mock("@remotion/player", () => ({ Player: () => <div data-testid="player" /> }));

afterEach(() => vi.restoreAllMocks());

function openVideo() {
  render(<UserGuidePlaylist />);
  fireEvent.click(screen.getByRole("button", { name: /Build a slide deck/ }));
  return screen.getByTestId("player").parentElement!;
}

test("access guidance is available before sign-in and preserves the request form", async () => {
  // jsdom does not implement native dialog methods.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  onTestFinished(() => {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });
  render(<AuthScreen authOptions={{ local_auth_enabled: true, password_auth_enabled: true, providers: [] }} />);
  fireEvent.click(screen.getByRole("button", { name: /Watch the access/ }));
  expect(await screen.findByRole("dialog", { name: "Request access and enter your workspace" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close access walkthrough" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Request access/ }));
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Taylor" } });
  fireEvent.click(screen.getByRole("button", { name: /Watch the access/ }));
  expect(await screen.findByRole("dialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close access walkthrough" }));
  expect(screen.getByLabelText("First name")).toHaveValue("Taylor");
});

test("the workspace Help playlist starts with chatting and excludes pre-sign-in guidance", () => {
  render(<UserGuidePlaylist />);
  expect(screen.queryByRole("button", { name: /Request access and enter/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Start chatting/ })).toBeVisible();
  expect(screen.getByText(/18 guided walkthroughs/)).toBeVisible();
});

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
