import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AiEditComposer } from "./AiEditComposer";

function renderReview(baseText: string, proposalText: string) {
  return render(
    <AiEditComposer
      getAnchor={() => ({ top: 10, bottom: 30, left: 10, right: 200 })}
      title="Edit with AI"
      targetLabel="Selected text"
      placeholder="Ask AI to edit"
      actions={[]}
      chipGroups={[]}
      phase="review"
      agentName="Writer"
      streamText=""
      runLabel="Fill the blanks"
      baseText={baseText}
      proposalText={proposalText}
      acceptLabel="Accept"
      onRun={() => {}}
      onRefine={() => {}}
      onAccept={() => {}}
      onRetry={() => {}}
      onStop={() => {}}
      onClose={() => {}}
    />,
  );
}

function changes(tag: "del" | "ins") {
  return Array.from(screen.getByLabelText("AI suggestion").querySelectorAll(tag)).map((node) => ({
    text: node.textContent,
    blank: node.classList.contains("is-blank"),
  }));
}

test("a filled blank shows the removed blank as a fill-in line, not struck-through words", () => {
  renderReview("known as __________ consisting of", "known as Cedar Grove Apartments consisting of");

  expect(changes("del")).toEqual([{ text: "__________", blank: true }]);
  expect(changes("ins")).toEqual([{ text: "Cedar Grove Apartments", blank: false }]);
});

test("removed words beside a removed blank keep their strikethrough; only the blank is a line", () => {
  renderReview("dated the Owner ______ today", "dated Cedar Grove LLC today");

  expect(changes("del")).toEqual([
    { text: "the Owner", blank: false },
    { text: "______", blank: true },
  ]);
});

test("a blank the suggestion adds also reads as a fill-in line", () => {
  renderReview("Signed by the tenant", "Signed by ________");

  expect(changes("ins")).toEqual([{ text: "________", blank: true }]);
});
