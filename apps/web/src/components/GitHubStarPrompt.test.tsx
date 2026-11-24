import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { GitHubStarPrompt, STAR_REPOSITORY_URL } from "./GitHubStarPrompt";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubServer(ask: 1 | 2 | null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/auth/star-prompt/check")) return json({ ask });
    if (url.endsWith("/api/auth/star-prompt/answer")) return new Response(null, { status: 204 });
    return json({ detail: "Unavailable" }, 503);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function answers(fetchMock: ReturnType<typeof stubServer>) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/api/auth/star-prompt/answer"))
    .map(([, init]) => JSON.parse(String(init?.body)).answer);
}

function checks(fetchMock: ReturnType<typeof stubServer>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/auth/star-prompt/check")).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("shows nothing when the server says it is not time to ask", async () => {
  const fetchMock = stubServer(null);
  render(<GitHubStarPrompt userId="user-jane" brandName="Aperture Chat" />);

  await waitFor(() => expect(checks(fetchMock)).toBe(1));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

test("the first ask links to the repository and records a star", async () => {
  const fetchMock = stubServer(1);
  render(<GitHubStarPrompt userId="user-jane" brandName="Aperture Chat" />);

  const card = await screen.findByRole("complementary", { name: "Enjoying Aperture Chat?" });
  const star = screen.getByRole("link", { name: /Star on GitHub/ });
  expect(card).toContainElement(star);
  expect(star).toHaveAttribute("href", STAR_REPOSITORY_URL);
  expect(star).toHaveAttribute("target", "_blank");
  expect(star).toHaveAttribute("rel", "noopener noreferrer");

  fireEvent.click(star);

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  await waitFor(() => expect(answers(fetchMock)).toEqual(["star"]));
});

test("not now closes the card and records the answer", async () => {
  const fetchMock = stubServer(1);
  render(<GitHubStarPrompt userId="user-jane" brandName="Aperture Chat" />);

  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  await waitFor(() => expect(answers(fetchMock)).toEqual(["later"]));
});

test("the second ask says it is the last one", async () => {
  stubServer(2);
  render(<GitHubStarPrompt userId="user-jane" brandName="Aperture Chat" />);

  const card = await screen.findByRole("complementary", { name: "Still enjoying Aperture Chat?" });
  expect(card).toHaveTextContent("If it has been useful, a star on GitHub is a quick way to say so. We won't ask again.");
});

test("a renamed workspace's second ask names the project", async () => {
  stubServer(2);
  render(<GitHubStarPrompt userId="user-jane" brandName="Harbor Legal AI" />);

  const card = await screen.findByRole("complementary", { name: "Still enjoying Harbor Legal AI?" });
  expect(card).toHaveTextContent("a star for Aperture Chat on GitHub");
});

test("a renamed workspace still names the project being starred", async () => {
  stubServer(1);
  render(<GitHubStarPrompt userId="user-jane" brandName="Harbor Legal AI" />);

  const card = await screen.findByRole("complementary", { name: "Enjoying Harbor Legal AI?" });
  expect(card).toHaveTextContent("Harbor Legal AI runs on Aperture Chat");
});

test("waits while another welcome is on screen, then checks once", async () => {
  const fetchMock = stubServer(1);
  const { rerender } = render(
    <StrictMode>
      <GitHubStarPrompt userId="user-jane" brandName="Aperture Chat" held />
    </StrictMode>,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(checks(fetchMock)).toBe(0);

  rerender(
    <StrictMode>
      <GitHubStarPrompt userId="user-jane" brandName="Aperture Chat" />
    </StrictMode>,
  );

  expect(await screen.findByRole("complementary", { name: "Enjoying Aperture Chat?" })).toBeInTheDocument();
  expect(checks(fetchMock)).toBe(1);
});

test("a failed check stays silent", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "Unavailable" }, 503)));
  render(<GitHubStarPrompt userId="user-jane" brandName="Aperture Chat" />);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});
