/** The intake turn: Drafts reads a request before it writes anything.
 *
 * A request to the drafting assistant goes to the model twice. The *intake
 * turn* comes first: the model sees the request and what the draft holds, and
 * either finds the request clear or pauses to ask the user up to three
 * multiple-choice questions (see ./clarify). The *writing call* follows and
 * returns the document, deck, or workbook.
 *
 * The user's answers become *details*: the request with its details under it
 * is what the writing call is given and what the draft chat shows as asked.
 * The API knows the intake turn by the words its prompt opens with
 * (`DRAFT_INTAKE_PREFIX` in services/api/app/routes/chat.py).
 */

import { chosenAnswers, type AnsweredClarification, type DelegatedClarification } from "./clarify";

export const DRAFT_INTAKE_PREFIX = "You are the intake step of the drafting assistant.";

export type DraftIntakeKind = "document" | "deck" | "spreadsheet";

export type DraftIntakeInput = {
  kind: DraftIntakeKind;
  request: string;
  title: string;
  /** What the draft holds now, as plain text; empty when it is blank. */
  current: string;
  /** Names of the files attached to the draft. */
  attachments: string[];
  /** Names of the knowledge sources switched on for the draft. */
  sources: string[];
  /** The template the draft would follow, when one applies. */
  template?: string;
  webSearch: boolean;
};

const KIND_NOUNS: Record<DraftIntakeKind, string> = {
  document: "document",
  deck: "slide deck",
  spreadsheet: "spreadsheet",
};

/** Enough of the draft to judge a request against, without sending all of it twice. */
const CURRENT_CHARS = 1500;

function clipped(text: string, limit: number): string {
  const plain = text.trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1)}…`;
}

function listed(names: string[]): string {
  return names.length ? names.join(", ") : "none";
}

export function draftIntakePrompt(input: DraftIntakeInput): string {
  const noun = KIND_NOUNS[input.kind];
  return [
    `${DRAFT_INTAKE_PREFIX} The user asked for work on a ${noun} in Aperture Drafts. ` +
      "Do not write, outline, or revise anything here: the next step does the work.",
    "Decide one thing: can the work be done well from what is below?\n" +
      "- If it can, reply with exactly: READY\n" +
      "- If something only the user knows is missing, or the request leaves open a choice that would change " +
      "the result substantially (its purpose, audience, scope, length, tone, structure, or which data or " +
      "period to use), pause and ask, as your clarifying-questions instructions describe.",
    `Ask only what the result truly depends on. Do not ask about anything the request, the current ${noun}, ` +
      "the attached files, or the knowledge sources already settle, or anything a sensible default covers at " +
      `little risk. A request that names a specific change to the current ${noun} is clear.`,
    `User request:\n${input.request.trim()}`,
    `Current ${noun} ("${input.title.trim()}"):\n${clipped(input.current, CURRENT_CHARS) || "Blank: nothing has been written yet."}`,
    [
      `Attached files: ${listed(input.attachments)}`,
      `Knowledge sources: ${listed(input.sources)}`,
      ...(input.template ? [`Template: ${input.template}`] : []),
      `Web search: ${input.webSearch ? "on" : "off"}`,
    ].join("\n"),
  ].join("\n\n");
}

/** The request as the user finally put it: what they asked, then what they
 * answered. A skipped question, and choices left to the assistant, add nothing. */
export function requestWithAnswers(
  request: string,
  clarification: AnsweredClarification | DelegatedClarification,
): string {
  if (clarification.state === "delegated") return request;
  const lines = clarification.questions.flatMap((question) => {
    const chosen = chosenAnswers(clarification, question);
    return chosen.length ? [`- ${question.question} ${chosen.join("; ")}`] : [];
  });
  return lines.length ? `${request}\n\nMy answers:\n${lines.join("\n")}` : request;
}

/** Where the draft chat must scroll so the questions can be answered: no
 * further than needed to show the whole card, and to its top, where the
 * question is, when the card is taller than the list. Positions are measured
 * from the top of the list's content. */
export function revealScrollTop(
  view: { scrollTop: number; height: number },
  card: { top: number; bottom: number },
): number {
  return Math.min(card.top, Math.max(view.scrollTop, card.bottom - view.height));
}
