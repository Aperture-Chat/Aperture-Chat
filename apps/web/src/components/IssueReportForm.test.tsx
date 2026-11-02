import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { IssueReportForm } from "./IssueReportForm";

const CAPTURING = "is-capturing-report";
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

function stubGetDisplayMedia(getDisplayMedia?: () => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
}

function captureButton() {
  return screen.getByRole("button", { name: "Capture screen" });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  document.documentElement.classList.remove(CAPTURING);
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

test("the capture button says what will happen before anyone presses it", () => {
  stubGetDisplayMedia(vi.fn());
  render(<IssueReportForm />);
  expect(captureButton()).toBeInTheDocument();
  expect(screen.getByText("This panel hides for the picture. Your browser will ask what to share, so choose this tab.")).toBeInTheDocument();
});

test("a browser that cannot capture offers neither the button nor the note", () => {
  stubGetDisplayMedia(undefined);
  render(<IssueReportForm />);
  expect(screen.queryByRole("button", { name: "Capture screen" })).not.toBeInTheDocument();
  expect(screen.queryByText(/This panel hides for the picture/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose image" })).toBeInTheDocument();
});

test.each([
  ["cancelled", "NotAllowedError", "Permission denied"],
  ["refused by the host", "NotSupportedError", "Not supported"],
])("a capture %s leaves plain words and a way forward", async (_case, name, rawMessage) => {
  stubGetDisplayMedia(vi.fn(async () => { throw new DOMException(rawMessage, name); }));
  render(<IssueReportForm />);
  fireEvent.click(captureButton());

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("No screenshot was taken. You can take one yourself and paste it here.");
  expect(alert).not.toHaveTextContent(rawMessage);
  expect(captureButton()).toBeEnabled();
  expect(document.documentElement).not.toHaveClass(CAPTURING);
});

function stubCaptureMedia(stop: () => void, onDraw: () => void, blob: Blob | null) {
  stubGetDisplayMedia(vi.fn(async () => ({ getTracks: () => [{ stop }] })));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: onDraw } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) => done(blob));
}

test("a finished capture is taken with the panel hidden, then attaches and brings the panel back", async () => {
  const stop = vi.fn();
  const hiddenAtDraw: boolean[] = [];
  stubCaptureMedia(
    stop,
    () => hiddenAtDraw.push(document.documentElement.classList.contains(CAPTURING)),
    new Blob(["picture"], { type: "image/png" }),
  );
  render(<IssueReportForm />);
  fireEvent.click(captureButton());

  expect(await screen.findByText(/^screenshot-.*\.png$/, undefined, { timeout: 1500 })).toBeInTheDocument();
  expect(hiddenAtDraw).toEqual([true]);
  expect(document.documentElement).not.toHaveClass(CAPTURING);
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a capture that cannot be saved says so and still brings the panel back", async () => {
  const stop = vi.fn();
  stubCaptureMedia(stop, vi.fn(), null);
  render(<IssueReportForm />);
  fireEvent.click(captureButton());

  expect(await screen.findByRole("alert", undefined, { timeout: 1500 })).toHaveTextContent("The screen capture could not be saved.");
  await waitFor(() => expect(captureButton()).toBeEnabled());
  expect(document.documentElement).not.toHaveClass(CAPTURING);
  expect(stop).toHaveBeenCalledOnce();
});
