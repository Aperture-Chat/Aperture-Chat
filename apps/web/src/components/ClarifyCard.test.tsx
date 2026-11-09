import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { waitingClarification, type ClarifyQuestions } from "../lib/clarify";
import { ClarifyCard, type ClarifyCardState } from "./ClarifyCard";

const QUESTIONS: ClarifyQuestions = {
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
      options: [{ label: "The client" }, { label: "A judge" }],
      multiple: true,
      recommended: null,
    },
  ],
};

function renderCard(state: ClarifyCardState = "open") {
  const onRespond = vi.fn();
  const onAlwaysDecide = vi.fn();
  render(
    <ClarifyCard
      clarification={waitingClarification(QUESTIONS, "2026-11-08T15:00:00Z")}
      brandName="Aperture"
      state={state}
      onRespond={onRespond}
      onAlwaysDecide={onAlwaysDecide}
    />,
  );
  return { onRespond, onAlwaysDecide };
}

describe("ClarifyCard", () => {
  test("says who is asking and why, then shows one question at a time with the option it would pick", () => {
    renderCard();

    expect(screen.getByRole("heading", { name: "Aperture has 2 questions before going on" })).toBeTruthy();
    expect(screen.getByText("Two quick questions first.")).toBeTruthy();
    expect(screen.getByText("Question 1 of 2")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Which state's law applies?" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Who will read it?" })).toBeNull();
    expect(screen.getByText("Where it was signed")).toBeTruthy();
    expect(screen.getByText("Suggested").closest("label")?.textContent).toContain("New York");
    expect(screen.getByRole("status").textContent).toBe("Aperture paused to ask you 2 questions.");
  });

  test("Next moves on, Back keeps what was picked, and Continue sends every answer", () => {
    const { onRespond } = renderCard();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "California" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Choose any that apply.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "The client" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByRole("radio", { name: "California" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "The client" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "A judge" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onRespond).toHaveBeenCalledWith({
      kind: "answers",
      answers: [
        { questionId: "q1", choices: ["California"], other: "" },
        { questionId: "q2", choices: ["The client", "A judge"], other: "" },
      ],
    });
  });

  test("a skipped question is left to the assistant, and Continue waits for at least one answer", () => {
    const { onRespond } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "A judge" }));
    fireEvent.click(continueButton);

    expect(onRespond).toHaveBeenCalledWith({ kind: "answers", answers: [{ questionId: "q2", choices: ["A judge"], other: "" }] });
  });

  test("Something else opens a box for the user's own words; Enter moves on, and on the last question sends", () => {
    const { onRespond } = renderCard();

    fireEvent.click(screen.getByRole("radio", { name: "Something else" }));
    const box = screen.getByRole("textbox", { name: "Your answer: Which state's law applies?" });
    fireEvent.change(box, { target: { value: "Texas" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("Question 2 of 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Something else" }));
    const second = screen.getByRole("textbox", { name: "Your answer: Who will read it?" });
    fireEvent.change(second, { target: { value: "An insurer" } });
    fireEvent.keyDown(second, { key: "Enter" });

    expect(onRespond).toHaveBeenCalledWith({
      kind: "answers",
      answers: [
        { questionId: "q1", choices: [], other: "Texas" },
        { questionId: "q2", choices: [], other: "An insurer" },
      ],
    });
  });

  test("the assistant can decide this time, or from now on", () => {
    const { onRespond, onAlwaysDecide } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Decide for me" }));
    fireEvent.click(screen.getByRole("button", { name: "Always decide for me" }));

    expect(onRespond).toHaveBeenCalledWith({ kind: "decide" });
    expect(onAlwaysDecide).toHaveBeenCalledTimes(1);
  });

  test("while another reply runs nothing can be answered", () => {
    const { onRespond } = renderCard("busy");

    expect((screen.getByRole("radio", { name: "California" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Decide for me" }));
    expect(onRespond).not.toHaveBeenCalled();
  });

  test("once the conversation moved on, it lists what was asked and says it went unanswered", () => {
    renderCard("passed");

    expect(screen.getByText("You replied in the chat instead, so these were left unanswered.")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Which state's law applies?",
      "Who will read it?",
    ]);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
