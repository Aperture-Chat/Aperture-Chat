import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ActivityPersonCard } from "./ActivityPersonCard";

const LONG_NAME = "Alexandria Montgomery-Fitzgerald";

test("a card shows the whole name and says what its number counts", () => {
  render(<ActivityPersonCard name={LONG_NAME} detail="User · 2 models" count={1713} countLabel="messages" tokensLabel="9,056 tokens" />);
  expect(screen.getByText(LONG_NAME)).toBeInTheDocument();
  expect(screen.getByText("User · 2 models")).toBeInTheDocument();
  expect(screen.getByText((1713).toLocaleString())).toBeInTheDocument();
  expect(screen.getByText("messages")).toBeInTheDocument();
  expect(screen.getByText("9,056 tokens")).toBeInTheDocument();
});

test("a card with no action is plain content", () => {
  render(<ActivityPersonCard name="Jordan Lee" detail="1 model used" count={2} countLabel="prompts" />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  const card = screen.getByRole("listitem");
  expect(card).toHaveTextContent("Jordan Lee");
  expect(card.querySelectorAll(".activity-numbers small")).toHaveLength(1);
});

test("a card is not selected unless it says so", () => {
  render(<ActivityPersonCard name="Jordan Lee" detail="1 model" count={2} countLabel="messages" onSelect={vi.fn()} />);
  expect(screen.getByRole("listitem")).toHaveAttribute("aria-pressed", "false");
});

test("a card with an action reports the click and its selected state", () => {
  const onSelect = vi.fn();
  render(<ActivityPersonCard name="Jordan Lee" detail="1 model" count={2} countLabel="messages" onSelect={onSelect} selected />);
  const card = screen.getByRole("listitem");
  expect(card).toHaveAttribute("aria-pressed", "true");
  expect(card).toHaveClass("is-selected");
  fireEvent.click(card);
  expect(onSelect).toHaveBeenCalledTimes(1);
});
