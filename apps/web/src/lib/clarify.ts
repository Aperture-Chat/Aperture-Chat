/** Clarifying questions: a reply that pauses to ask before it goes on.
 *
 * When a request can be read several ways, the assistant may stop before
 * doing the work and ask up to three multiple-choice questions (the API
 * parses them out of the model's reply; see
 * services/api/app/core/clarifying_questions.py). The reply is then
 * *waiting*. The user picks options, types their own answer, or lets the
 * assistant decide; the same reply then continues as a new run.
 *
 * The clarification lives on the reply's `metadata.clarify`. It is parsed
 * once here, where it comes in from the stream or from a stored chat.
 */

import { isRecord } from "./api/http";
import type { ChatWireMessage } from "./api/chat";
import type { ChatStreamActivity } from "./streamActivity";

export type ClarifyOption = { label: string; detail?: string };

export type ClarifyQuestion = {
  id: string;
  question: string;
  options: ClarifyOption[];
  /** Several options may apply together. */
  multiple: boolean;
  /** The option the assistant would pick itself, by position. */
  recommended: number | null;
};

export type ClarifyQuestions = { intro: string; questions: ClarifyQuestion[] };

/** One question's answer: options picked by label, and the user's own words.
 * Neither means the user left that one to the assistant. */
export type ClarifyAnswer = { questionId: string; choices: string[]; other: string };

/** What the model is told this turn: it may pause to ask, it must decide for
 * the user, or it has the user's answers and finishes. */
export type ClarifyMode = "ask" | "decide" | "answered";

export type WaitingClarification = ClarifyQuestions & { state: "waiting"; pausedAt: string; waitedMs: number };
export type AnsweredClarification = ClarifyQuestions & { state: "answered"; answers: ClarifyAnswer[]; waitedMs: number };
export type DelegatedClarification = ClarifyQuestions & { state: "delegated"; waitedMs: number };
export type Clarification = WaitingClarification | AnsweredClarification | DelegatedClarification;

export type ClarifyResponse = { kind: "answers"; answers: ClarifyAnswer[] } | { kind: "decide" };

/* ------------------------------------------------------------------ */
/* Parsing (the boundary)                                              */
/* ------------------------------------------------------------------ */

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseOption(raw: unknown): ClarifyOption | null {
  if (!isRecord(raw) || !text(raw.label)) return null;
  const detail = text(raw.detail);
  return detail ? { label: text(raw.label), detail } : { label: text(raw.label) };
}

function recommendedIndex(raw: unknown, options: ClarifyOption[]): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < options.length ? raw : null;
}

function parseQuestion(raw: unknown): ClarifyQuestion | null {
  if (!isRecord(raw) || !text(raw.id) || !text(raw.question) || !Array.isArray(raw.options)) return null;
  const options = raw.options.map(parseOption).filter((option): option is ClarifyOption => option !== null);
  if (options.length < 2) return null;
  return {
    id: text(raw.id),
    question: text(raw.question),
    options,
    multiple: raw.multiple === true,
    recommended: recommendedIndex(raw.recommended, options),
  };
}

/** The questions a reply paused on, as the stream and stored replies carry
 * them; null when none can be shown. */
export function parseClarifyQuestions(raw: unknown): ClarifyQuestions | null {
  if (!isRecord(raw) || !Array.isArray(raw.questions)) return null;
  const questions = raw.questions.map(parseQuestion).filter((question): question is ClarifyQuestion => question !== null);
  return questions.length ? { intro: text(raw.intro), questions } : null;
}

function parseAnswer(raw: unknown): ClarifyAnswer | null {
  if (!isRecord(raw) || !text(raw.questionId) || !Array.isArray(raw.choices)) return null;
  const choices = raw.choices.filter((choice): choice is string => typeof choice === "string" && Boolean(choice.trim()));
  return { questionId: text(raw.questionId), choices, other: text(raw.other) };
}

function parseAnswers(raw: unknown): ClarifyAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map(parseAnswer).filter((answer): answer is ClarifyAnswer => answer !== null);
}

function waitedMs(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
}

function withState(raw: Record<string, unknown>, questions: ClarifyQuestions): Clarification | null {
  const waited = waitedMs(raw.waitedMs);
  if (raw.state === "waiting") return { state: "waiting", ...questions, pausedAt: text(raw.pausedAt), waitedMs: waited };
  if (raw.state === "delegated") return { state: "delegated", ...questions, waitedMs: waited };
  const answers = raw.state === "answered" ? parseAnswers(raw.answers) : null;
  return answers ? { state: "answered", ...questions, answers, waitedMs: waited } : null;
}

/** The clarification a stored reply carries, if it is one this page understands. */
export function readClarification(metadata: Record<string, unknown> | null | undefined): Clarification | null {
  const raw = metadata?.clarify;
  if (!isRecord(raw)) return null;
  const questions = parseClarifyQuestions(raw);
  return questions ? withState(raw, questions) : null;
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

export function waitingClarification(questions: ClarifyQuestions, pausedAt: string): WaitingClarification {
  return { state: "waiting", ...questions, pausedAt, waitedMs: 0 };
}

/** The reply's clarification once the user responds. Time spent waiting on
 * the user is not work, so it is carried along to be left out of the run's
 * duration; `pausedForMs` is how long this pause lasted. */
export function respondToClarification(
  waiting: WaitingClarification,
  response: ClarifyResponse,
  nowMs: number,
): { next: AnsweredClarification | DelegatedClarification; pausedForMs: number } {
  const pausedAtMs = Date.parse(waiting.pausedAt);
  const pausedForMs = Number.isFinite(pausedAtMs) ? Math.max(0, nowMs - pausedAtMs) : 0;
  const { intro, questions } = waiting;
  const total = waiting.waitedMs + pausedForMs;
  const next: AnsweredClarification | DelegatedClarification =
    response.kind === "decide"
      ? { state: "delegated", intro, questions, waitedMs: total }
      : { state: "answered", intro, questions, answers: response.answers, waitedMs: total };
  return { next, pausedForMs };
}

/* ------------------------------------------------------------------ */
/* What the model and the trace read                                   */
/* ------------------------------------------------------------------ */

function askedLine(question: ClarifyQuestion, index: number): string {
  const options = question.options.map((option) => option.label).join(" / ");
  const many = question.multiple ? "; more than one may apply" : "";
  return `${index + 1}. ${question.question} (${options}${many})`;
}

function askedText(clarification: Clarification): string {
  const lines = ["I paused to ask:", ...clarification.questions.map(askedLine)];
  return [clarification.intro, lines.join("\n")].filter(Boolean).join("\n\n");
}

function answerFor(clarification: AnsweredClarification, question: ClarifyQuestion): string[] {
  const answer = clarification.answers.find((item) => item.questionId === question.id);
  return answer ? [...answer.choices, answer.other].filter(Boolean) : [];
}

const DECIDE_TEXT =
  "Make these choices yourself: pick what you judge best for each, say in one short line what you chose, and continue.";

function responseText(clarification: AnsweredClarification | DelegatedClarification): string {
  if (clarification.state === "delegated") return DECIDE_TEXT;
  const lines = clarification.questions.map((question, index) => {
    const chosen = answerFor(clarification, question);
    return `${index + 1}. ${question.question} ${chosen.length ? chosen.join("; ") : "No preference. You decide."}`;
  });
  return `My answers:\n${lines.join("\n")}\n\nContinue with these answers.`;
}

/** The pause as conversation turns: the assistant asking and, once the user
 * responded, their answers. The continued reply and later turns both read it. */
export function clarifyTurns(clarification: Clarification): ChatWireMessage[] {
  const asked: ChatWireMessage = { role: "assistant", content: askedText(clarification) };
  if (clarification.state === "waiting") return [asked];
  return [asked, { role: "user", content: responseText(clarification) }];
}

const LEFT_TO_ASSISTANT = "Assistant's choice";

/** What the user chose, question by question, for the trace. */
export function answerSummary(clarification: AnsweredClarification): string {
  return clarification.questions
    .map((question) => answerFor(clarification, question).join(", ") || LEFT_TO_ASSISTANT)
    .join(" · ");
}

/** The trace's record of how the user responded. */
export function answeredActivity(clarification: AnsweredClarification | DelegatedClarification): ChatStreamActivity {
  const delegated = clarification.state === "delegated";
  return {
    kind: "answered",
    questions: clarification.questions.length,
    summary: delegated ? "" : answerSummary(clarification),
    delegated,
  };
}

/* ------------------------------------------------------------------ */
/* Answers being picked                                                */
/* ------------------------------------------------------------------ */

/** One question's answer while the user is still picking: "Something else"
 * can be on with its text not typed yet. */
type DraftAnswer = { choices: string[]; otherOn: boolean; other: string };

/** The user's picks so far, by question id. */
export type ClarifyDraft = Readonly<Record<string, DraftAnswer>>;

const EMPTY_ANSWER: DraftAnswer = { choices: [], otherOn: false, other: "" };

function answerOf(draft: ClarifyDraft, question: ClarifyQuestion): DraftAnswer {
  return draft[question.id] ?? EMPTY_ANSWER;
}

function toggled(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/** Picks an option: the only answer to a single-choice question, toggled on
 * or off among several. */
export function pickOption(draft: ClarifyDraft, question: ClarifyQuestion, label: string): ClarifyDraft {
  const current = answerOf(draft, question);
  const next = question.multiple
    ? { ...current, choices: toggled(current.choices, label) }
    : { ...current, choices: [label], otherOn: false };
  return { ...draft, [question.id]: next };
}

/** Picks "Something else": for a single-choice question it replaces the
 * option picked; among several it toggles like any option. */
export function pickOther(draft: ClarifyDraft, question: ClarifyQuestion): ClarifyDraft {
  const current = answerOf(draft, question);
  const next = question.multiple
    ? { ...current, otherOn: !current.otherOn }
    : { ...current, choices: [], otherOn: true };
  return { ...draft, [question.id]: next };
}

export function typeOther(draft: ClarifyDraft, question: ClarifyQuestion, other: string): ClarifyDraft {
  return { ...draft, [question.id]: { ...answerOf(draft, question), other } };
}

export function isPicked(draft: ClarifyDraft, question: ClarifyQuestion, label: string): boolean {
  return answerOf(draft, question).choices.includes(label);
}

export function otherIsOn(draft: ClarifyDraft, question: ClarifyQuestion): boolean {
  return answerOf(draft, question).otherOn;
}

/** The questions the user answered, in order; the rest are left to the assistant. */
export function draftAnswers(draft: ClarifyDraft, questions: ClarifyQuestion[]): ClarifyAnswer[] {
  return questions
    .map((question) => {
      const { choices, otherOn, other } = answerOf(draft, question);
      return { questionId: question.id, choices, other: otherOn ? other.trim() : "" };
    })
    .filter((answer) => answer.choices.length > 0 || answer.other);
}
