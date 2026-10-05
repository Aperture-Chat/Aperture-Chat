import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { concealedTokenLabel, hasConcealedTokens, renderConcealed } from "./ConcealedText";
import { Markdown } from "./Markdown";

test("concealment tokens render as labeled chips and keep surrounding text", () => {
  render(<p>{renderConcealed("SSN ⟦SSN⟧ and card ⟦CARD NUMBER⟧.")}</p>);
  expect(screen.getByRole("img", { name: "SSN hidden" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Card number hidden" })).toBeInTheDocument();
  expect(screen.getByText(/and card/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("⟦");
});

test("labels read naturally and plain text is untouched", () => {
  expect(concealedTokenLabel("DRIVER LICENSE")).toBe("Driver's license");
  expect(concealedTokenLabel("DATE OF BIRTH")).toBe("Date of birth");
  expect(concealedTokenLabel("IP ADDRESS")).toBe("IP address");
  expect(hasConcealedTokens("No tokens [SSN] here")).toBe(false);
  expect(hasConcealedTokens("Has ⟦EMAIL⟧")).toBe(true);
});

test("markdown answers render chips inside paragraphs and bold text", () => {
  render(<Markdown content={"The card on record is ⟦CARD NUMBER⟧.\n\n**Contact ⟦EMAIL⟧**"} />);
  expect(screen.getByRole("img", { name: "Card number hidden" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Email hidden" })).toBeInTheDocument();
});
