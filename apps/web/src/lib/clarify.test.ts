import { describe, expect, test } from "vitest";
import {
  answeredActivity,
  answerSummary,
  clarifyTurns,
  draftAnswers,
  isPicked,
  otherIsOn,
  parseClarifyQuestions,
  pickOption,
  pickOther,
  typeOther,
  readClarification,
  respondToClarification,
  waitingClarification,
  type ClarifyQuestions,
} from "./clarify";

const WIRE = {
  intro: "Two quick questions first.",
  questions: [
    {
      id: "q1",
      question: "Which state's law applies?",
      options: [{ label: "California" }, { label: "New York", detail: "Where it was signed" }],
      multiple: false,
      recommended: 1,
    },
    {
      id: "q2",
      question: "Who will read it?",
      options: [{ label: "The client" }, { label: "A judge" }, { label: "Opposing counsel" }],
      multiple: true,
      recommended: null,
    },
  ],
};

const QUESTIONS = parseClarifyQuestions(WIRE) as ClarifyQuestions;
const PAUSED_AT = "2026-11-08T15:00:00.000Z";
const PAUSED_MS = Date.parse(PAUSED_AT);

describe("parseClarifyQuestions", () => {
  test("reads the questions the stream carries", () => {
    expect(QUESTIONS).toEqual(WIRE);
  });

  test("drops questions it cannot show and refuses a set with none left", () => {
    const mixed = {
      intro: 7,
      questions: [
        { id: "q1", question: "Only one choice?", options: [{ label: "Yes" }] },
        { id: "q2", question: "  ", options: [{ label: "A" }, { label: "B" }] },
        { id: "q3", question: "Pick", options: [{ label: "A" }, { nope: true }, { label: "B", detail: 3 }], recommended: 5 },
      ],
    };

    expect(parseClarifyQuestions(mixed)).toEqual({
      intro: "",
      questions: [
        { id: "q3", question: "Pick", options: [{ label: "A" }, { label: "B" }], multiple: false, recommended: null },
      ],
    });
    expect(parseClarifyQuestions({ questions: [] })).toBeNull();
    expect(parseClarifyQuestions("questions")).toBeNull();
    expect(parseClarifyQuestions(null)).toBeNull();
  });
});

describe("readClarification", () => {
  test("reads a reply that is waiting on answers", () => {
    const stored = { clarify: { state: "waiting", ...WIRE, pausedAt: PAUSED_AT } };

    expect(readClarification(stored)).toEqual({ state: "waiting", ...WIRE, pausedAt: PAUSED_AT, waitedMs: 0 });
  });

  test("reads answered and delegated replies", () => {
    const answers = [{ questionId: "q1", choices: ["California"], other: "" }];

    expect(readClarification({ clarify: { state: "answered", ...WIRE, answers, waitedMs: 5000 } })).toEqual({
      state: "answered",
      ...WIRE,
      answers,
      waitedMs: 5000,
    });
    expect(readClarification({ clarify: { state: "delegated", ...WIRE, waitedMs: 10 } })).toEqual({
      state: "delegated",
      ...WIRE,
      waitedMs: 10,
    });
  });

  test("ignores anything that is not a clarification it understands", () => {
    expect(readClarification(undefined)).toBeNull();
    expect(readClarification({})).toBeNull();
    expect(readClarification({ clarify: { state: "maybe", ...WIRE } })).toBeNull();
    expect(readClarification({ clarify: { state: "waiting", intro: "", questions: [] } })).toBeNull();
    expect(readClarification({ clarify: { state: "answered", ...WIRE, answers: "California" } })).toBeNull();
  });
});

describe("respondToClarification", () => {
  const waiting = waitingClarification(QUESTIONS, PAUSED_AT);

  test("answers carry over with the time spent waiting on them", () => {
    const answers = [
      { questionId: "q1", choices: ["New York"], other: "" },
      { questionId: "q2", choices: ["The client", "A judge"], other: "" },
    ];

    const { next, pausedForMs } = respondToClarification(waiting, { kind: "answers", answers }, PAUSED_MS + 90_000);

    expect(pausedForMs).toBe(90_000);
    expect(next).toEqual({ state: "answered", ...QUESTIONS, answers, waitedMs: 90_000 });
  });

  test("letting the assistant decide is its own answer", () => {
    const { next } = respondToClarification(waiting, { kind: "decide" }, PAUSED_MS + 1000);

    expect(next).toEqual({ state: "delegated", ...QUESTIONS, waitedMs: 1000 });
  });

  test("a clock that reads earlier than the pause never counts negative time", () => {
    const { pausedForMs, next } = respondToClarification(waiting, { kind: "decide" }, PAUSED_MS - 5000);

    expect(pausedForMs).toBe(0);
    expect(next.waitedMs).toBe(0);
  });
});

describe("clarifyTurns", () => {
  const asked =
    "Two quick questions first.\n\nI paused to ask:\n" +
    "1. Which state's law applies? (California / New York)\n" +
    "2. Who will read it? (The client / A judge / Opposing counsel; more than one may apply)";

  test("a waiting reply is the assistant asking", () => {
    expect(clarifyTurns(waitingClarification(QUESTIONS, PAUSED_AT))).toEqual([{ role: "assistant", content: asked }]);
  });

  test("answers follow as the user's turn, with unanswered questions left to the assistant", () => {
    const answered = respondToClarification(
      waitingClarification(QUESTIONS, PAUSED_AT),
      { kind: "answers", answers: [{ questionId: "q1", choices: ["California"], other: "Plus federal law" }] },
      PAUSED_MS,
    ).next;

    expect(clarifyTurns(answered)).toEqual([
      { role: "assistant", content: asked },
      {
        role: "user",
        content:
          "My answers:\n1. Which state's law applies? California; Plus federal law\n" +
          "2. Who will read it? No preference. You decide.\n\nContinue with these answers.",
      },
    ]);
  });

  test("delegating asks the assistant to choose and say what it chose", () => {
    const delegated = respondToClarification(waitingClarification(QUESTIONS, PAUSED_AT), { kind: "decide" }, PAUSED_MS).next;

    expect(clarifyTurns(delegated)[1]).toEqual({
      role: "user",
      content:
        "Make these choices yourself: pick what you judge best for each, say in one short line what you chose, and continue.",
    });
  });
});

describe("answerSummary", () => {
  test("lists what was chosen, question by question", () => {
    const answered = respondToClarification(
      waitingClarification(QUESTIONS, PAUSED_AT),
      {
        kind: "answers",
        answers: [
          { questionId: "q1", choices: [], other: "Texas" },
          { questionId: "q2", choices: ["The client", "A judge"], other: "" },
        ],
      },
      PAUSED_MS,
    ).next;

    expect(answerSummary(answered)).toBe("Texas · The client, A judge");
  });

  test("an unanswered question reads as left to the assistant", () => {
    const answered = respondToClarification(
      waitingClarification(QUESTIONS, PAUSED_AT),
      { kind: "answers", answers: [] },
      PAUSED_MS,
    ).next;

    expect(answerSummary(answered)).toBe("Assistant's choice · Assistant's choice");
  });
});

describe("picking answers", () => {
  const [single, multiple] = QUESTIONS.questions;

  test("a single-choice question keeps the last option picked, and Something else replaces it", () => {
    let draft = pickOption({}, single, "California");
    draft = pickOption(draft, single, "New York");
    expect(draftAnswers(draft, QUESTIONS.questions)).toEqual([{ questionId: "q1", choices: ["New York"], other: "" }]);

    draft = typeOther(pickOther(draft, single), single, "  Texas ");
    expect(draftAnswers(draft, QUESTIONS.questions)).toEqual([{ questionId: "q1", choices: [], other: "Texas" }]);
    expect(isPicked(draft, single, "New York")).toBe(false);
    expect(otherIsOn(draft, single)).toBe(true);
  });

  test("a many-choice question toggles each option and Something else on its own", () => {
    let draft = pickOption({}, multiple, "The client");
    draft = pickOption(draft, multiple, "A judge");
    draft = pickOption(draft, multiple, "The client");
    draft = typeOther(pickOther(draft, multiple), multiple, "Insurer");

    expect(draftAnswers(draft, QUESTIONS.questions)).toEqual([{ questionId: "q2", choices: ["A judge"], other: "Insurer" }]);
    expect(otherIsOn(pickOther(draft, multiple), multiple)).toBe(false);
  });

  test("a question with nothing picked, or Something else left blank, is not an answer", () => {
    const blankOther = pickOther({}, single);

    expect(draftAnswers({}, QUESTIONS.questions)).toEqual([]);
    expect(draftAnswers(blankOther, QUESTIONS.questions)).toEqual([]);
    expect(isPicked({}, single, "California")).toBe(false);
  });
});

describe("reading stored and streamed data strictly", () => {
  const valid = WIRE.questions[0];

  test.each([
    ["no id", { ...valid, id: "" }],
    ["options that are not a list", { ...valid, options: "California, New York" }],
    ["no question text", { ...valid, question: undefined }],
    ["not an object", "Which state?"],
  ])("a question with %s is dropped", (_label, question) => {
    expect(parseClarifyQuestions({ questions: [question, WIRE.questions[1]] })?.questions.map((item) => item.id)).toEqual(["q2"]);
  });

  test.each([
    [0, 0],
    [1, 1],
    [2, null],
    [-1, null],
    [0.5, null],
    ["0", null],
  ])("a suggested position of %j reads as %j", (recommended, expected) => {
    expect(parseClarifyQuestions({ questions: [{ ...valid, recommended }] })?.questions[0].recommended).toBe(expected);
  });

  test("stored answers keep only well-formed entries and real choices", () => {
    const stored = {
      clarify: {
        state: "answered",
        ...WIRE,
        answers: [
          { questionId: "q1", choices: ["California", " ", 7, null] },
          { questionId: "", choices: ["New York"] },
          { questionId: "q2", choices: "A judge" },
          "q2",
        ],
      },
    };

    expect(readClarification(stored)).toMatchObject({ answers: [{ questionId: "q1", choices: ["California"], other: "" }] });
  });

  test.each([
    [-5, 0],
    [2.6, 3],
    [Number.POSITIVE_INFINITY, 0],
    ["5000", 0],
  ])("a stored waiting time of %j reads as %j", (waited, expected) => {
    expect(readClarification({ clarify: { state: "delegated", ...WIRE, waitedMs: waited } })?.waitedMs).toBe(expected);
  });

  test("a pause with an unreadable start time counts no waiting", () => {
    const { pausedForMs, next } = respondToClarification(waitingClarification(QUESTIONS, "not a time"), { kind: "decide" }, PAUSED_MS);

    expect(pausedForMs).toBe(0);
    expect(next.waitedMs).toBe(0);
  });
});

describe("answeredActivity", () => {
  test("records what was answered, or that the choices were left to the assistant", () => {
    const waiting = waitingClarification(QUESTIONS, PAUSED_AT);
    const answers = [{ questionId: "q1", choices: ["California"], other: "" }];

    expect(answeredActivity(respondToClarification(waiting, { kind: "answers", answers }, PAUSED_MS).next)).toEqual({
      kind: "answered",
      questions: 2,
      summary: "California · Assistant's choice",
      delegated: false,
    });
    expect(answeredActivity(respondToClarification(waiting, { kind: "decide" }, PAUSED_MS).next)).toEqual({
      kind: "answered",
      questions: 2,
      summary: "",
      delegated: true,
    });
  });
});

test("picking an option after Something else turns Something else off", () => {
  const [single] = QUESTIONS.questions;
  const draft = pickOption(typeOther(pickOther({}, single), single, "Texas"), single, "California");

  expect(otherIsOn(draft, single)).toBe(false);
  expect(draftAnswers(draft, QUESTIONS.questions)).toEqual([{ questionId: "q1", choices: ["California"], other: "" }]);
});
