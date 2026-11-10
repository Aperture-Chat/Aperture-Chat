import { describe, expect, it } from "vitest";
import type { AnsweredClarification, ClarifyQuestion, DelegatedClarification } from "./clarify";
import { DRAFT_INTAKE_PREFIX, draftIntakePrompt, requestWithAnswers, revealScrollTop, type DraftIntakeInput } from "./draftIntake";

function intake(overrides: Partial<DraftIntakeInput> = {}): DraftIntakeInput {
  return {
    kind: "document",
    request: "Draft a memo",
    title: "Untitled document",
    current: "",
    attachments: [],
    sources: [],
    webSearch: false,
    ...overrides,
  };
}

describe("draftIntakePrompt", () => {
  it("opens with the words the API knows the intake turn by", () => {
    expect(draftIntakePrompt(intake()).startsWith(DRAFT_INTAKE_PREFIX)).toBe(true);
  });

  it("quotes the request and tells the model to answer READY or ask, never to write", () => {
    const prompt = draftIntakePrompt(intake({ request: "Draft a memo about the Acme renewal" }));
    expect(prompt).toContain("User request:\nDraft a memo about the Acme renewal");
    expect(prompt).toContain("reply with exactly: READY");
    expect(prompt).toContain("Do not write");
  });

  it.each([
    ["document", "document"],
    ["deck", "slide deck"],
    ["spreadsheet", "spreadsheet"],
  ] as const)("names what a %s request works on", (kind, noun) => {
    expect(draftIntakePrompt(intake({ kind }))).toContain(`work on a ${noun} in Aperture Drafts`);
  });

  it("says a blank draft is blank, so the model does not ask what it holds", () => {
    expect(draftIntakePrompt(intake())).toContain('Current document ("Untitled document"):\nBlank: nothing has been written yet.');
  });

  it("shows what the draft holds, cut short when it is long", () => {
    const prompt = draftIntakePrompt(intake({ title: "Lease memo", current: `Opening line. ${"x".repeat(3000)}` }));
    expect(prompt).toContain('Current document ("Lease memo"):\nOpening line.');
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(3200);
  });

  it("keeps a draft of exactly the limit whole, and cuts one character more to the limit", () => {
    const atLimit = "y".repeat(1500);
    expect(draftIntakePrompt(intake({ current: atLimit }))).toContain(`:\n${atLimit}\n\nAttached files`);
    const over = draftIntakePrompt(intake({ current: "y".repeat(1501) }));
    expect(over).toContain(`:\n${"y".repeat(1499)}…\n\nAttached files`);
  });

  it("tells the model what not to ask about, in the words of the format", () => {
    const prompt = draftIntakePrompt(intake({ kind: "deck" }));
    expect(prompt).toContain(
      "Ask only what the result truly depends on. Do not ask about anything the request, the current slide deck, " +
        "the attached files, or the knowledge sources already settle, or anything a sensible default covers at " +
        "little risk. A request that names a specific change to the current slide deck is clear.",
    );
  });

  it("lists what the model will have to work from", () => {
    const prompt = draftIntakePrompt(
      intake({ attachments: ["lease.pdf", "rent roll.xlsx"], sources: ["Matters"], template: "Client memo", webSearch: true }),
    );
    expect(prompt).toContain("Attached files: lease.pdf, rent roll.xlsx");
    expect(prompt).toContain("Knowledge sources: Matters");
    expect(prompt).toContain("Template: Client memo");
    expect(prompt).toContain("Web search: on");
  });

  it("says so when there is nothing to work from", () => {
    const prompt = draftIntakePrompt(intake());
    expect(prompt).toContain("Attached files: none");
    expect(prompt).toContain("Knowledge sources: none");
    expect(prompt).toContain("Web search: off");
    expect(prompt).not.toContain("Template:");
  });
});

const questions: ClarifyQuestion[] = [
  { id: "q1", question: "Who is it for?", options: [{ label: "The client" }, { label: "The partner" }], multiple: false, recommended: 0 },
  { id: "q2", question: "What should it cover?", options: [{ label: "Risks" }, { label: "Costs" }], multiple: true, recommended: null },
  { id: "q3", question: "How long?", options: [{ label: "One page" }, { label: "Two pages" }], multiple: false, recommended: null },
];

function answered(answers: AnsweredClarification["answers"]): AnsweredClarification {
  return { state: "answered", intro: "", questions, answers, waitedMs: 0 };
}

describe("requestWithAnswers", () => {
  it("adds each answer under the request, in the user's own voice", () => {
    const text = requestWithAnswers(
      "Draft a memo",
      answered([
        { questionId: "q1", choices: ["The client"], other: "" },
        { questionId: "q2", choices: ["Risks", "Costs"], other: "Next steps" },
        { questionId: "q3", choices: [], other: "Half a page" },
      ]),
    );
    expect(text).toBe(
      "Draft a memo\n\nMy answers:\n- Who is it for? The client\n- What should it cover? Risks; Costs; Next steps\n- How long? Half a page",
    );
  });

  it("leaves out a question the user skipped", () => {
    expect(requestWithAnswers("Draft a memo", answered([{ questionId: "q3", choices: ["One page"], other: "" }]))).toBe(
      "Draft a memo\n\nMy answers:\n- How long? One page",
    );
  });

  it("is the request alone when the user answered nothing", () => {
    expect(requestWithAnswers("Draft a memo", answered([]))).toBe("Draft a memo");
  });

  it("is the request alone when the user left the choices to the assistant", () => {
    const delegated: DelegatedClarification = { state: "delegated", intro: "", questions, waitedMs: 0 };
    expect(requestWithAnswers("Draft a memo", delegated)).toBe("Draft a memo");
  });
});

describe("revealScrollTop", () => {
  const view = { scrollTop: 100, height: 400 };

  it("leaves the list alone when the card is already in view", () => {
    expect(revealScrollTop(view, { top: 150, bottom: 450 })).toBe(100);
  });

  it("scrolls just far enough to bring a card below the fold into view", () => {
    expect(revealScrollTop(view, { top: 420, bottom: 720 })).toBe(320);
  });

  it("scrolls back up to a card above the view", () => {
    expect(revealScrollTop(view, { top: 20, bottom: 90 })).toBe(20);
  });

  it("starts a card taller than the list at its top, where the question is", () => {
    expect(revealScrollTop(view, { top: 420, bottom: 900 })).toBe(420);
  });

  it("treats a card that exactly fills the list as fitting", () => {
    expect(revealScrollTop(view, { top: 300, bottom: 700 })).toBe(300);
    expect(revealScrollTop(view, { top: 100, bottom: 500 })).toBe(100);
  });
});
