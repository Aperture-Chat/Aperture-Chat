/** Drafts reads a request before it writes: it may ask first, and the writing
 * call may research on its own. DocumentAssistantWorkspace.test.tsx covers the
 * writing itself, with asking turned off. */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { DocumentAssistantWorkspace } from "./DocumentAssistantWorkspace";
import { sampleData } from "../data/sampleData";

type Payload = {
  stream: boolean;
  surface: string;
  clarify_mode: string | null;
  work_steps: boolean;
  messages: Array<{ role: string; content: string }>;
};

const ASK_SWITCH_KEY = "aperture-ask-when-unclear-user-admin";
const MEMO = "# Renewal memo\n\nThe renewal terms are summarised for the client.";
const ONE_QUESTION = {
  intro: "",
  questions: [
    {
      id: "q1",
      question: "Who is it for?",
      options: [{ label: "The client" }, { label: "The partner" }],
      multiple: false,
      recommended: 0,
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stream(...frames: unknown[]): Response {
  const lines = [...frames, { done: true, citations: [], usage: null }].map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  return new Response(`${lines.join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

const asking = (questions: unknown = ONE_QUESTION) => () => stream({ activity: { kind: "ask", questions: 1 } }, { questions });
const ready = () => stream({ delta: "READY" });
const writes = (content: string, activity: unknown[] = []) => () =>
  json({ choices: [{ message: { role: "assistant", content } }], citations: [], activity });

/** A model that answers the intake turn one way and the writing call another. */
function installModel({ intake, writing }: { intake: () => Response | Promise<Response>; writing: () => Response }) {
  const sent: Payload[] = [];
  const fetchMock = globalThis.fetch as unknown as { mockImplementation: (implementation: typeof fetch) => void };
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith("/api/chat/complete")) return json({ error: "offline" }, 503);
    const payload = JSON.parse(String(init?.body ?? "{}")) as Payload;
    sent.push(payload);
    return payload.clarify_mode === "ask" ? intake() : writing();
  });
  return sent;
}

function renderDrafts() {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const webSearch = screen.queryByRole("button", { name: "Disable web search" });
  if (webSearch) fireEvent.click(webSearch);
}

function ask(request: string, label = "Ask the document assistant") {
  fireEvent.change(screen.getByLabelText(label), { target: { value: request } });
  fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));
}

const documentText = () => screen.getByRole("textbox", { name: "Document body" }).textContent ?? "";
const prompt = (payload: Payload) => payload.messages[0]!.content;

async function questionCard() {
  return (await screen.findByRole("heading", { name: /has a question before going on/ })).closest("section")!;
}

test("an unclear request gets a question first, and nothing is written until it is answered", async () => {
  const sent = installModel({ intake: asking(), writing: writes(MEMO) });
  renderDrafts();

  ask("Draft a memo about the renewal");

  const card = await questionCard();
  expect(within(card).getByText("Who is it for?")).toBeInTheDocument();
  expect(screen.getByText("Draft a memo about the renewal")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Aperture Chat activity trace" })).toHaveTextContent("Waiting for your answer");
  expect(documentText()).not.toContain("renewal terms");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ stream: true, surface: "draft", clarify_mode: "ask", work_steps: false });
  expect(prompt(sent[0]!)).toMatch(/^You are the intake step of the drafting assistant\./);
  expect(prompt(sent[0]!)).toContain("User request:\nDraft a memo about the renewal");
  // The composer is free again: the user may answer, or ask for something else.
  expect(screen.getByLabelText("Ask the document assistant")).toBeEnabled();
});

test("the answers go to the writing call and show under the request", async () => {
  const sent = installModel({ intake: asking(), writing: writes(MEMO) });
  renderDrafts();
  ask("Draft a memo about the renewal");

  const card = await questionCard();
  fireEvent.click(within(card).getByLabelText(/The partner/));
  fireEvent.click(within(card).getByRole("button", { name: "Continue" }));

  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ stream: false, surface: "draft", clarify_mode: null });
  expect(prompt(sent[1]!)).toContain("Draft a memo about the renewal\n\nMy answers:\n- Who is it for? The partner");
  expect(screen.queryByRole("heading", { name: /has a question before going on/ })).not.toBeInTheDocument();
  // One request in the draft chat, as the user finally put it.
  expect(screen.getAllByText(/Draft a memo about the renewal/)).toHaveLength(1);
  expect(screen.getByText(/Who is it for\? The partner/)).toBeInTheDocument();
});

test("a clear request is written without a pause", async () => {
  const sent = installModel({ intake: ready, writing: writes(MEMO) });
  renderDrafts();

  ask("Draft a one-page memo to the client about the Harbor lease renewal");

  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(sent.map((payload) => payload.clarify_mode)).toEqual(["ask", null]);
  expect(prompt(sent[1]!)).not.toContain("My answers:");
  expect(screen.queryByRole("heading", { name: /before going on/ })).not.toBeInTheDocument();
  expect(screen.getAllByText(/Draft a one-page memo to the client/)).toHaveLength(1);
});

test("Decide for me starts the writing with the request as it was asked", async () => {
  const sent = installModel({ intake: asking(), writing: writes(MEMO) });
  renderDrafts();
  ask("Draft a memo about the renewal");

  fireEvent.click(within(await questionCard()).getByRole("button", { name: "Decide for me" }));

  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(prompt(sent[1]!)).toContain("Draft a memo about the renewal");
  expect(prompt(sent[1]!)).not.toContain("My answers:");
  expect(window.localStorage.getItem(ASK_SWITCH_KEY)).not.toBe("off");
});

test("Always decide for me turns asking off for later requests too", async () => {
  const sent = installModel({ intake: asking(), writing: writes(MEMO) });
  renderDrafts();
  ask("Draft a memo about the renewal");

  fireEvent.click(within(await questionCard()).getByRole("button", { name: /Always decide for me/ }));

  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(window.localStorage.getItem(ASK_SWITCH_KEY)).toBe("off");

  ask("Add a closing paragraph about next steps.");
  await waitFor(() => expect(sent).toHaveLength(3));
  expect(sent[2]!.clarify_mode).toBeNull();
});

test("with asking turned off the request goes straight to the writing call", async () => {
  window.localStorage.setItem(ASK_SWITCH_KEY, "off");
  const sent = installModel({ intake: asking(), writing: writes(MEMO) });
  renderDrafts();

  ask("Draft a memo about the renewal");

  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ stream: false, clarify_mode: null });
});

test("the switch in the drafting settings turns asking off and on", async () => {
  const sent = installModel({ intake: asking(), writing: writes(MEMO) });
  renderDrafts();
  fireEvent.click(screen.getByRole("button", { name: /Assistant settings|Drafting settings|Settings/ }));

  const askSwitch = screen.getByRole("switch", { name: "Ask me when unclear" });
  expect(askSwitch).toBeChecked();
  fireEvent.click(askSwitch);
  expect(askSwitch).not.toBeChecked();
  expect(window.localStorage.getItem(ASK_SWITCH_KEY)).toBe("off");

  ask("Draft a memo about the renewal");
  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(sent).toHaveLength(1);
});

test("when the intake turn cannot run, the request is written as asked", async () => {
  const sent = installModel({ intake: () => json({ detail: "Bad request" }, 400), writing: writes(MEMO) });
  renderDrafts();

  ask("Draft a memo about the renewal");

  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(sent).toHaveLength(2);
});

test("a new request while a question waits replaces the one it was about", async () => {
  // The model asks about the first request and finds the second one clear.
  const intakeTurns = [asking(), ready];
  const sent = installModel({ intake: () => intakeTurns.shift()!(), writing: writes(MEMO) });
  renderDrafts();
  ask("Draft a memo about the renewal");
  await questionCard();

  ask("Draft a two-page memo to the client about the Harbor lease renewal");

  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(screen.queryByRole("heading", { name: /before going on/ })).not.toBeInTheDocument();
  expect(prompt(sent.at(-1)!)).toContain("Draft a two-page memo to the client");
  expect(prompt(sent.at(-1)!)).not.toContain("Draft a memo about the renewal\n");
});

test("the writing call may research on its own, and the trace shows what it did", async () => {
  window.localStorage.setItem(ASK_SWITCH_KEY, "off");
  const sent = installModel({
    intake: ready,
    writing: writes(MEMO, [
      { kind: "step", number: 1, do: "calculate", ok: true, found: 1, about: "1250000 * 0.065 / 12" },
      { kind: "step", number: 2, do: "search_knowledge", ok: true, found: 3, about: "renewal notice period" },
    ]),
  });
  renderDrafts();

  ask("Draft a memo about the renewal");

  await waitFor(() => expect(documentText()).toContain("renewal terms are summarised"));
  expect(sent[0]!.work_steps).toBe(true);
  const trace = screen.getByRole("region", { name: "Aperture Chat activity trace" });
  await waitFor(() => expect(within(trace).getByText("Worked out a figure")).toBeInTheDocument(), { timeout: 8000 });
  expect(within(trace).getByText("1250000 * 0.065 / 12")).toBeInTheDocument();
  // The steps play in one at a time, as they do in the chat.
  await waitFor(
    () => expect(within(trace).getByText(/Looked again in workspace knowledge · 3 passages/)).toBeInTheDocument(),
    { timeout: 8000 },
  );
});

test("a deck request is read first too, and its answers reach the deck's writing call", async () => {
  const sent = installModel({ intake: asking(), writing: writes("Not a deck") });
  renderDrafts();
  fireEvent.click(screen.getByRole("button", { name: "Deck", exact: true }));

  ask("Build a deck about the renewal", "Ask the deck assistant");
  const card = await questionCard();
  expect(prompt(sent[0]!)).toContain("work on a slide deck in Aperture Drafts");
  fireEvent.click(within(card).getByLabelText(/The client/));
  fireEvent.click(within(card).getByRole("button", { name: "Continue" }));

  await waitFor(() => expect(sent.length).toBeGreaterThan(1));
  expect(sent[1]).toMatchObject({ stream: false, work_steps: true });
  expect(prompt(sent[1]!)).toContain("Build a deck about the renewal\n\nMy answers:\n- Who is it for? The client");
});

const BOSTON_DECK = [
  "```json",
  JSON.stringify({
    schema: "aperture-deck-v1",
    title: "Boston Expansion",
    slides: [
      { id: "g1", notes: "", layout: "title", title: "Boston Expansion", subtitle: "Growth plan" },
      { id: "g2", notes: "", layout: "title-bullets", title: "Why Boston", bullets: [{ runs: [{ text: "Talent density" }], level: 0 }] },
      { id: "g3", notes: "", layout: "closing", title: "Next steps", body: "Approve the budget" },
    ],
  }),
  "```",
].join("\n");

test("a question's wording never turns an edit to a built deck into a rebuild", async () => {
  // The question says "start" and "images"; the request itself asks for neither a new deck nor pictures.
  const question = {
    intro: "",
    questions: [
      {
        id: "q1",
        question: "Which fee structure should the slide start from, and should it keep its images?",
        options: [{ label: "Fixed fee" }, { label: "Hourly" }],
        multiple: false,
        recommended: 0,
      },
    ],
  };
  let intakeTurns = 0;
  const sent = installModel({ intake: () => (intakeTurns++ === 0 ? ready() : asking(question)()), writing: writes(BOSTON_DECK) });
  renderDrafts();
  fireEvent.click(screen.getByRole("button", { name: "Deck", exact: true }));
  ask("Build a deck about our Boston expansion", "Ask the deck assistant");
  await waitFor(() => expect(screen.getByText("Slide 1 of 3")).toBeInTheDocument(), { timeout: 8000 });
  const writingCalls = () => sent.filter((payload) => payload.clarify_mode !== "ask");
  const built = writingCalls().length;

  ask("Tighten the wording on slide 2", "Ask the deck assistant");
  const card = await questionCard();
  fireEvent.click(within(card).getByLabelText(/Fixed fee/));
  fireEvent.click(within(card).getByRole("button", { name: "Continue" }));

  await waitFor(() => expect(writingCalls().length).toBeGreaterThan(built));
  const revision = prompt(writingCalls()[built]!);
  expect(revision).toContain("You are revising an existing slide deck");
  expect(revision).toContain("Tighten the wording on slide 2\n\nMy answers:\n- Which fee structure should the slide start from, and should it keep its images? Fixed fee");
  expect(await screen.findByText(/Revised 3 slides/)).toBeInTheDocument();
});

test("a spreadsheet request is read first too, and its answers reach the workbook's writing call", async () => {
  const sent = installModel({ intake: asking(), writing: writes("Not a workbook") });
  renderDrafts();
  fireEvent.click(screen.getByRole("button", { name: "Spreadsheet", exact: true }));

  ask("Build a budget", "Ask the spreadsheet assistant");
  const card = await questionCard();
  expect(prompt(sent[0]!)).toContain("work on a spreadsheet in Aperture Drafts");
  fireEvent.click(within(card).getByLabelText(/The client/));
  fireEvent.click(within(card).getByRole("button", { name: "Continue" }));

  await waitFor(() => expect(sent.length).toBeGreaterThan(1));
  expect(sent[1]).toMatchObject({ stream: false, work_steps: true });
  expect(prompt(sent[1]!)).toContain("Build a budget\n\nMy answers:\n- Who is it for? The client");
});

test("questions bring the assistant drawer back when it was closed while the request was read", async () => {
  const previousWidth = window.innerWidth;
  window.innerWidth = 1000;
  let answerIntake: (response: Response) => void = () => {};
  installModel({ intake: () => new Promise<Response>((resolve) => (answerIntake = resolve)), writing: writes(MEMO) });
  const view = render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Open the document assistant" }));
    ask("Draft a memo about the renewal");
    expect(screen.getByRole("dialog", { name: "Assistant workflow" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Close the document assistant", hidden: true })[0]!);
    expect(screen.queryByRole("dialog", { name: "Assistant workflow" })).not.toBeInTheDocument();

    answerIntake(asking()());

    expect(await screen.findByRole("dialog", { name: "Assistant workflow" })).toBeInTheDocument();
    expect(within(await questionCard()).getByText("Who is it for?")).toBeInTheDocument();
  } finally {
    view.unmount();
    window.innerWidth = previousWidth;
  }
});
