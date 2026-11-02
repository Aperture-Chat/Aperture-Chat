import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { userFilterPanelPlacement, userFilterSummary, UserFilterControl } from "./UserFilterControl";

const USERS = [
  { id: "u1", label: "Alexandria Montgomery-Fitzgerald" },
  { id: "u2", label: "Jordan Lee" },
  { id: "u3", label: "Riley Nakamura" },
];

function Harness({ users = USERS, onChange }: { users?: typeof USERS; onChange?: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <UserFilterControl
      label="Runtime events filter user"
      users={users}
      selectedIds={selected}
      onChange={(ids) => {
        setSelected(ids);
        onChange?.(ids);
      }}
    />
  );
}

function openFilter() {
  fireEvent.click(screen.getByRole("button", { name: "Runtime events filter user" }));
  return screen.getByRole("dialog", { name: "Runtime events filter user" });
}

test("the summary says who is selected in words", () => {
  expect(userFilterSummary([], USERS, "All users")).toBe("All users");
  expect(userFilterSummary(["u2"], USERS, "All users")).toBe("Jordan Lee");
  expect(userFilterSummary(["u2", "u3"], USERS, "All users")).toBe("2 users");
  expect(userFilterSummary(["gone"], USERS, "All users")).toBe("1 user");
});

test("everyone starts selected through the All users box", () => {
  render(<Harness />);
  const panel = openFilter();
  const allUsers = within(panel).getByRole("checkbox", { name: "All users" });
  const person = within(panel).getByRole("checkbox", { name: "Jordan Lee" });
  expect(allUsers).toBeChecked();
  expect(person).not.toBeChecked();
  expect(allUsers.closest("label")).toHaveClass("is-all");
  expect(person.closest("label")).not.toHaveClass("is-all");
  expect(within(panel).getByText("Everyone")).toBeInTheDocument();
});

test("one pick reads as one selected", () => {
  render(<Harness />);
  const panel = openFilter();
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Jordan Lee" }));
  expect(within(panel).getByText("1 selected")).toBeInTheDocument();
});

test("the button says whether the panel is open, and a second press closes it", () => {
  render(<Harness />);
  const button = screen.getByRole("button", { name: "Runtime events filter user" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  fireEvent.pointerDown(button);
  fireEvent.click(button);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("people can be picked one box at a time", () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const panel = openFilter();
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Jordan Lee" }));
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Riley Nakamura" }));
  expect(onChange).toHaveBeenLastCalledWith(["u2", "u3"]);
  expect(within(panel).getByRole("checkbox", { name: "All users" })).not.toBeChecked();
  expect(within(panel).getByText("2 selected")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Runtime events filter user" })).toHaveTextContent("2 users");
});

test("unticking a person removes only that person", () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const panel = openFilter();
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Jordan Lee" }));
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Riley Nakamura" }));
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Jordan Lee" }));
  expect(onChange).toHaveBeenLastCalledWith(["u3"]);
});

test("the All users box clears every pick", () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const panel = openFilter();
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Jordan Lee" }));
  fireEvent.click(within(panel).getByRole("checkbox", { name: "All users" }));
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test("a long list can be searched, and a pick survives the search", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `u${index}`, label: `Person ${index}` }));
  const onChange = vi.fn();
  render(<Harness users={many} onChange={onChange} />);
  const panel = openFilter();
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Person 1" }));
  fireEvent.change(within(panel).getByRole("searchbox", { name: "Find a person" }), { target: { value: "person 11" } });
  expect(within(panel).queryByRole("checkbox", { name: "Person 1" })).not.toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Person 11" }));
  expect(onChange).toHaveBeenLastCalledWith(["u1", "u11"]);
});

test("a search with no match says so", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `u${index}`, label: `Person ${index}` }));
  render(<Harness users={many} />);
  const panel = openFilter();
  fireEvent.change(within(panel).getByRole("searchbox", { name: "Find a person" }), { target: { value: "zzz" } });
  expect(within(panel).getByText("No one matches that name.")).toBeInTheDocument();
});

test("the search box appears at nine people, not before", () => {
  const people = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `u${index}`, label: `Person ${index}` }));
  const { unmount } = render(<Harness users={people(8)} />);
  expect(within(openFilter()).queryByRole("searchbox")).not.toBeInTheDocument();
  unmount();
  render(<Harness users={people(9)} />);
  expect(within(openFilter()).getByRole("searchbox", { name: "Find a person" })).toBeInTheDocument();
});

test("Escape closes the panel and returns to the button", () => {
  render(<Harness />);
  const panel = openFilter();
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Runtime events filter user" })).toHaveFocus();
});

test("Done closes the panel and returns to the button", () => {
  render(<Harness />);
  fireEvent.click(within(openFilter()).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Runtime events filter user" })).toHaveFocus();
});

test("pressing elsewhere closes the panel without pulling focus back", () => {
  render(<Harness />);
  openFilter();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Runtime events filter user" })).not.toHaveFocus();
});

test("pressing inside the panel keeps it open", () => {
  render(<Harness />);
  const panel = openFilter();
  fireEvent.pointerDown(within(panel).getByText("Jordan Lee"));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

function placeButton(top: number) {
  const button = screen.getByRole("button", { name: "Runtime events filter user" });
  button.getBoundingClientRect = () => ({ left: 100, top, bottom: top + 38, right: 360, width: 260, height: 38, x: 100, y: top, toJSON: () => ({}) });
}

test("the panel follows its button when the page scrolls, and keeps the ticks", () => {
  render(
    <div data-testid="page">
      <Harness />
    </div>,
  );
  placeButton(100);
  const panel = openFilter();
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Jordan Lee" }));
  expect(panel.style.top).toBe("144px");
  placeButton(40);
  fireEvent.scroll(screen.getByTestId("page"));
  expect(screen.getByRole("dialog")).toBe(panel);
  expect(panel.style.top).toBe("84px");
  expect(within(panel).getByRole("checkbox", { name: "Jordan Lee" })).toBeChecked();
});

test("scrolling the list itself does not move the panel", () => {
  render(<Harness />);
  placeButton(100);
  const panel = openFilter();
  placeButton(40);
  fireEvent.scroll(within(panel).getByText("Jordan Lee"));
  expect(panel.style.top).toBe("144px");
});

test("the panel closes once its button has left the screen", () => {
  render(<Harness />);
  placeButton(100);
  openFilter();
  placeButton(-80);
  fireEvent.scroll(document.body);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("the panel closes when its button has scrolled off the bottom", () => {
  render(<Harness />);
  placeButton(100);
  openFilter();
  placeButton(window.innerHeight + 5);
  fireEvent.scroll(document.body);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("resizing the window moves the panel back on screen", () => {
  render(<Harness />);
  placeButton(100);
  const panel = openFilter();
  const width = window.innerWidth;
  window.innerWidth = 400;
  fireEvent(window, new Event("resize"));
  expect(panel.style.left).toBe("72px");
  window.innerWidth = width;
});

test("the panel opens below when it fits, and stays on screen when it does not", () => {
  const viewport = { width: 1000, height: 800 };
  expect(userFilterPanelPlacement({ left: 100, top: 100, bottom: 138, width: 260 }, viewport)).toEqual({
    left: 100,
    width: 320,
    top: 144,
    maxHeight: 648,
  });
  const nearRight = userFilterPanelPlacement({ left: 900, top: 100, bottom: 138, width: 90 }, viewport);
  expect(nearRight.left).toBe(672);
  const nearBottom = userFilterPanelPlacement({ left: 100, top: 700, bottom: 738, width: 260 }, viewport);
  expect(nearBottom).toEqual({ left: 100, width: 320, bottom: 106, maxHeight: 686 });
});

test("the panel stays below the button whenever it has enough room there", () => {
  const tall = { width: 1000, height: 1200 };
  const lowOnScreen = userFilterPanelPlacement({ left: 100, top: 860, bottom: 898, width: 260 }, tall);
  expect(lowOnScreen).toEqual({ left: 100, width: 320, top: 904, maxHeight: 288 });
  const exactlyEnough = userFilterPanelPlacement({ left: 100, top: 896, bottom: 926, width: 260 }, tall);
  expect(exactlyEnough.top).toBe(932);
});

test("on a very short screen the panel takes the larger side, below on a tie", () => {
  const short = { width: 1000, height: 300 };
  const nearTop = userFilterPanelPlacement({ left: 100, top: 60, bottom: 90, width: 260 }, short);
  expect(nearTop).toEqual({ left: 100, width: 320, top: 96, maxHeight: 196 });
  const tied = userFilterPanelPlacement({ left: 100, top: 135, bottom: 165, width: 260 }, short);
  expect(tied.top).toBe(171);
});

test("the panel never gets wider than a phone", () => {
  const phone = userFilterPanelPlacement({ left: 16, top: 100, bottom: 138, width: 120 }, { width: 320, height: 568 });
  expect(phone.left).toBe(8);
  expect(phone.width).toBe(304);
});
