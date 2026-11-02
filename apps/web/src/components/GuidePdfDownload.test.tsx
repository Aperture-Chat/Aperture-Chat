import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GuidePdfDownload } from "./trainingVideoKit";

const COMPLETE_PDF = "%PDF-1.4\nsynthetic guide body\nstartxref\n12\n%%EOF\n";
const FAILURE_MESSAGE = "That download did not finish, so nothing was saved. Click to try again.";

type SavedFile = { name: string; blob: Blob };
let saved: SavedFile[];
let pendingBlobs: Map<string, Blob>;
const fetchMock = vi.fn<(input: string) => Promise<Response>>();

function pdfResponse(body = COMPLETE_PDF) {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/pdf" } });
}

function renderCard() {
  render(
    <GuidePdfDownload
      href="docs/aperture-admin-guide.pdf"
      title="Administrator guide (PDF)"
      description="Every admin tab, step by step."
      tooltip="Download the printable guide"
    />,
  );
  return screen.getByRole("link", { name: /Administrator guide \(PDF\)/ });
}

beforeEach(() => {
  saved = [];
  pendingBlobs = new Map();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      const url = `blob:guide-${pendingBlobs.size}`;
      pendingBlobs.set(url, blob);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: pendingBlobs.get(this.href) as Blob });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the guide is saved only once every byte has arrived", async () => {
  let finishResponse: (response: Response) => void = () => undefined;
  fetchMock.mockReturnValue(new Promise((resolve) => { finishResponse = resolve; }));
  const link = renderCard();

  const leftToBrowser = fireEvent.click(link);

  expect(leftToBrowser).toBe(false);
  expect(fetchMock).toHaveBeenCalledWith("/docs/aperture-admin-guide.pdf");
  expect(link).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("Downloading…")).toBeInTheDocument();
  expect(saved).toEqual([]);

  finishResponse(pdfResponse());

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0].name).toBe("aperture-admin-guide.pdf");
  expect(saved[0].blob.type).toBe("application/pdf");
  expect(saved[0].blob.size).toBe(COMPLETE_PDF.length);
  await waitFor(() => expect(screen.getByText("PDF")).toBeInTheDocument());
  expect(link).toHaveAttribute("aria-busy", "false");
});

test.each([
  ["a body cut off before the end of the file", () => Promise.resolve(pdfResponse("%PDF-1.4\nsynthetic guide bo"))],
  ["the app page served in place of a missing guide", () => Promise.resolve(pdfResponse("<!doctype html><html>%%EOF</html>"))],
  ["a complete PDF behind a server error", () => Promise.resolve(new Response(COMPLETE_PDF, { status: 503 }))],
  ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
])("%s saves nothing, says so, and can be retried", async (_case, failure) => {
  fetchMock.mockImplementationOnce(failure);
  const link = renderCard();

  fireEvent.click(link);

  expect(await screen.findByText(FAILURE_MESSAGE)).toBeInTheDocument();
  expect(screen.getByText("Try again")).toBeInTheDocument();
  expect(screen.queryByText("Every admin tab, step by step.")).not.toBeInTheDocument();
  expect(saved).toEqual([]);

  fetchMock.mockResolvedValueOnce(pdfResponse());
  fireEvent.click(link);

  await waitFor(() => expect(saved).toHaveLength(1));
  await waitFor(() => expect(screen.getByText("Every admin tab, step by step.")).toBeInTheDocument());
  expect(screen.queryByText(FAILURE_MESSAGE)).not.toBeInTheDocument();
});

test("a second click during a download does not start another one", async () => {
  let finishResponse: (response: Response) => void = () => undefined;
  fetchMock.mockReturnValue(new Promise((resolve) => { finishResponse = resolve; }));
  const link = renderCard();

  fireEvent.click(link);
  const leftToBrowser = fireEvent.click(link);

  expect(leftToBrowser).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  finishResponse(pdfResponse());
  await waitFor(() => expect(saved).toHaveLength(1));
});

test.each([
  ["Command", { metaKey: true }],
  ["Control", { ctrlKey: true }],
  ["Shift", { shiftKey: true }],
  ["Option", { altKey: true }],
])("%s-click stays with the browser", (_key, modifier) => {
  const link = renderCard();

  const leftToBrowser = fireEvent.click(link, modifier);

  expect(leftToBrowser).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(link).toHaveAttribute("href", "/docs/aperture-admin-guide.pdf");
  expect(link).toHaveAttribute("download");
});
