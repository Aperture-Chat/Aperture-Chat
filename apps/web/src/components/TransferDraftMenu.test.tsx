import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/types";
import { TransferDraftMenu } from "./TransferDraftMenu";

const TABLE = "| A | B |\n| --- | --- |\n| 1 | 2 |";

function reply(content: string): ChatMessage {
  return { id: "r1", role: "assistant", content, createdAt: "now", status: "ok" };
}

function openMenu(content: string, request?: string) {
  const onTransfer = vi.fn();
  render(
    <div>
      <TransferDraftMenu message={reply(content)} request={request} onTransfer={onTransfer} />
      <button type="button">Elsewhere</button>
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Transfer response to Drafts" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  return { onTransfer, trigger, menu: screen.getByRole("menu", { name: "Open in Drafts as" }) };
}

test("the chooser lists the three Drafts editors and suggests the one the request named", () => {
  const { onTransfer, trigger, menu } = openMenu(TABLE, "Make a slide deck about this");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
    "Word document: An editable document that exports to Word or PDF",
    "Slide deck (suggested): Slides built from the reply's headings and points",
    "Spreadsheet: Its table becomes a sheet, as edited here",
  ]);
  expect(items[1]).toHaveFocus();
  expect(items[1]).toHaveClass("is-suggested");
  expect(within(items[1]!).getByText("Suggested")).toBeInTheDocument();
  expect(items[0]).not.toHaveClass("is-suggested");

  fireEvent.click(items[2]!);
  expect(onTransfer).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), "spreadsheet");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("the spreadsheet line says what the reply's tables become", () => {
  const { menu } = openMenu(`${TABLE}\n\nText\n\n${TABLE.replace("1", "3")}`);
  expect(within(menu).getByRole("menuitem", { name: /^Spreadsheet/ })).toHaveAccessibleName(
    "Spreadsheet (suggested): Its 2 tables become sheets, as edited here",
  );
});

test("a reply with no table still opens as a spreadsheet, down one column", () => {
  const { menu } = openMenu("Just prose.");
  expect(within(menu).getByRole("menuitem", { name: /^Spreadsheet/ })).toHaveAccessibleName(
    "Spreadsheet: Its lines go down the first column",
  );
  expect(within(menu).getByRole("menuitem", { name: /^Word document \(suggested\)/ })).toHaveFocus();
});

test("arrows wrap, Home and End jump, Tab closes, and a press outside closes", () => {
  const { menu, trigger } = openMenu("Just prose.");
  const items = within(menu).getAllByRole("menuitem");
  fireEvent.keyDown(menu, { key: "ArrowUp" });
  expect(items[2]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(items[0]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "End" });
  expect(items[2]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "Home" });
  expect(items[0]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "x" });
  expect(items[0]).toHaveFocus();
  fireEvent.keyDown(menu, { key: "Tab" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  fireEvent.click(trigger);
  fireEvent.pointerDown(within(screen.getByRole("menu")).getAllByRole("menuitem")[1]!);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
