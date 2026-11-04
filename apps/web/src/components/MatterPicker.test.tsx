import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Matter } from "../lib/matters";
import type { SavedMatters } from "../lib/useSavedMatters";
import { MatterChooser, MatterField, matterFieldHint } from "./MatterPicker";

function matter(id: string, name: string): Matter {
  return {
    id,
    tenant_id: "tenant-example",
    name,
    created_by_user_id: "user-jane",
    version: 1,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
  };
}

const MATTERS = [matter("matter-1", "100234-0001"), matter("matter-2", "100234-0002"), matter("matter-3", "Acme Lease Review")];
const EMPTY_HINT = "Files everything in this base under one number.";

function saved(overrides: Partial<SavedMatters> = {}): SavedMatters {
  return { matters: MATTERS, status: "ready", resolve: vi.fn(), retry: vi.fn(), ...overrides };
}

function Field({ initial = "", list = saved(), onEscape = vi.fn() }: { initial?: string; list?: SavedMatters; onEscape?: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div onKeyDown={(event) => event.key === "Escape" && onEscape()}>
      <MatterField value={value} onChange={setValue} saved={list} emptyHint={EMPTY_HINT} />
      <output data-testid="value">{value}</output>
    </div>
  );
}

describe("matterFieldHint", () => {
  it("explains the empty field, a saved number, a new one, and one too long", () => {
    expect(matterFieldHint("", { matters: [], status: "ready" }, EMPTY_HINT)).toBe(EMPTY_HINT);
    expect(matterFieldHint("", { matters: MATTERS, status: "ready" }, EMPTY_HINT)).toBe(
      `${EMPTY_HINT} Pick a saved number or type a new one.`,
    );
    expect(matterFieldHint("", { matters: [], status: "failed" }, EMPTY_HINT)).toBe(
      `${EMPTY_HINT} Your saved numbers could not load; you can still type one.`,
    );
    expect(matterFieldHint(" 100234-0002 ", { matters: MATTERS, status: "ready" }, EMPTY_HINT)).toBe("One of your saved numbers.");
    expect(matterFieldHint("100234-0003", { matters: MATTERS, status: "ready" }, EMPTY_HINT)).toBe(
      "A new number. It is saved for next time.",
    );
    expect(matterFieldHint("x".repeat(201), { matters: MATTERS, status: "ready" }, EMPTY_HINT)).toBe("Use 200 characters or fewer.");
  });
});

describe("MatterField", () => {
  it("offers saved numbers when focused and fills the field with the one picked", () => {
    render(<Field />);
    const input = screen.getByRole("combobox", { name: /client-matter number/i });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(input);
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["100234-0001", "100234-0002", "Acme Lease Review"]);
    fireEvent.mouseDown(options[1]);
    expect(screen.getByTestId("value").textContent).toBe("100234-0002");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("One of your saved numbers.")).toBeTruthy();
  });

  it("narrows the list as a number is typed and says a new one will be saved", () => {
    render(<Field />);
    const input = screen.getByRole("combobox", { name: /client-matter number/i });
    fireEvent.change(input, { target: { value: "acme" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Acme Lease Review"]);
    fireEvent.change(input, { target: { value: "100999-0001" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("A new number. It is saved for next time.")).toBeTruthy();
  });

  it("picks with the arrow keys and Enter, and Escape closes only the list", () => {
    const onEscape = vi.fn();
    render(<Field onEscape={onEscape} />);
    const input = screen.getByRole("combobox", { name: /client-matter number/i });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-1$/);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("100234-0002");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
    // With the list closed, Escape is the dialog's again.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("opens and closes the list from its button, and has none without saved numbers", () => {
    const { unmount } = render(<Field />);
    fireEvent.click(screen.getByRole("button", { name: "Show saved numbers" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide saved numbers" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    unmount();
    render(<Field list={saved({ matters: [] })} />);
    expect(screen.queryByRole("button", { name: "Show saved numbers" })).toBeNull();
  });
});

describe("MatterChooser", () => {
  it("files the chat under a saved number in one click and marks the current one", () => {
    const onChoose = vi.fn();
    render(<MatterChooser saved={saved()} currentId="matter-1" onChoose={onChoose} />);
    const current = screen.getByRole("menuitemradio", { name: "100234-0001" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "100234-0002" }));
    expect(onChoose).toHaveBeenCalledWith("matter-2");
  });

  it("saves a new number, then files the chat under it", async () => {
    const onChoose = vi.fn();
    const resolve = vi.fn(async (label: string) => matter("matter-new", label));
    render(<MatterChooser saved={saved({ resolve })} currentId={null} onChoose={onChoose} />);
    const input = screen.getByRole("textbox", { name: "Client-matter number" });
    fireEvent.change(input, { target: { value: "100999-0001" } });
    expect(screen.getByText("No saved number matches. Save it to use it now and next time.")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith("matter-new"));
    expect(resolve).toHaveBeenCalledWith("100999-0001");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("uses the saved matter when the typed number already exists", async () => {
    const onChoose = vi.fn();
    const resolve = vi.fn(async () => MATTERS[2]);
    render(<MatterChooser saved={saved({ resolve })} currentId={null} onChoose={onChoose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Client-matter number" }), { target: { value: "acme lease review" } });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith("matter-3"));
  });

  it("says why a number was not saved and keeps the chat as it was", async () => {
    const onChoose = vi.fn();
    const resolve = vi.fn(async () => {
      throw new Error("Matter name is limited to 200 characters.");
    });
    render(<MatterChooser saved={saved({ resolve })} currentId={null} onChoose={onChoose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Client-matter number" }), { target: { value: "100999-0002" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Matter name is limited to 200 characters.");
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("removes the tag, and offers a retry when saved numbers did not load", () => {
    const onChoose = vi.fn();
    const retry = vi.fn();
    render(<MatterChooser saved={saved({ matters: [], status: "failed", retry })} currentId="matter-1" onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /did not load/ }));
    expect(retry).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove the tag from this chat" }));
    expect(onChoose).toHaveBeenCalledWith(null);
  });

  it("says the saved numbers are loading, and shows no empty list when nothing matches", () => {
    const { unmount } = render(<MatterChooser saved={saved({ matters: [], status: "loading" })} currentId={null} onChoose={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Loading your saved numbers…");
    unmount();
    render(<MatterChooser saved={saved()} currentId={null} onChoose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Client-matter number" }), { target: { value: "999999" } });
    expect(screen.queryByRole("group", { name: "Your saved numbers" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("No saved number matches. Save it to use it now and next time.")).toBeTruthy();
  });

  it("explains the first use and waits on an empty entry", () => {
    render(<MatterChooser saved={saved({ matters: [] })} currentId={null} onChoose={vi.fn()} />);
    expect(screen.getByText("Type the number you file this work under, such as 100234-0001.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("MatterField details", () => {
  const field = () => screen.getByRole("combobox", { name: /client-matter number/i });
  const activeOption = () => field().getAttribute("aria-activedescendant");

  it("accepts a label of exactly the limit", () => {
    expect(matterFieldHint("x".repeat(200), { matters: MATTERS, status: "ready" }, EMPTY_HINT)).toBe(
      "A new number. It is saved for next time.",
    );
  });

  it("moves through the list both ways, wrapping, and Enter picks the first option too", () => {
    render(<Field />);
    fireEvent.focus(field());
    expect(activeOption()).toBeNull();
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(activeOption()).toMatch(/-2$/);
    expect(screen.getAllByRole("option")[2].className).toBe("is-active");
    expect(screen.getAllByRole("option")[0].className).toBe("");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(activeOption()).toMatch(/-0$/);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(activeOption()).toMatch(/-2$/);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(activeOption()).toMatch(/-1$/);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(activeOption()).toMatch(/-0$/);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("100234-0001");
  });

  it("starts from the top again after the list closes or the text changes", () => {
    render(<Field />);
    fireEvent.focus(field());
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(activeOption()).toBeNull();
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(activeOption()).toMatch(/-0$/);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.change(field(), { target: { value: "1002" } });
    expect(activeOption()).toBeNull();
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(activeOption()).toMatch(/-0$/);
  });

  it("marks the chosen saved number with a check and offers all of them to swap", () => {
    render(<Field initial="100234-0002" />);
    fireEvent.focus(field());
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(options.map((option) => Boolean(option.querySelector("svg")))).toEqual([false, true, false]);
  });

  it("keeps spelling help and the list button out of the way", () => {
    render(<Field list={saved({ matters: [MATTERS[0]] })} />);
    expect(field().getAttribute("spellcheck")).toBe("false");
    expect(screen.getByRole("button", { name: "Show saved numbers" }).getAttribute("tabindex")).toBe("-1");
  });
});

describe("MatterChooser details", () => {
  it("lists a single saved number", () => {
    render(<MatterChooser saved={saved({ matters: [MATTERS[0]] })} currentId={null} onChoose={vi.fn()} />);
    expect(screen.getByRole("menuitemradio", { name: "100234-0001" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Client-matter number" }).getAttribute("spellcheck")).toBe("false");
  });

  it("shows Saving… while a new number is saved, and Save again after a refusal without a reason", async () => {
    let refuse!: (reason: unknown) => void;
    const resolve = vi.fn(() => new Promise<Matter>((_resolve, reject) => { refuse = reject; }));
    render(<MatterChooser saved={saved({ resolve })} currentId={null} onChoose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Client-matter number" }), { target: { value: "100999-0003" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const busy = await screen.findByRole("button", { name: "Saving…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    refuse("offline");
    expect((await screen.findByRole("alert")).textContent).toBe("The number was not saved.");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says the number was not saved when the refusal gives no words", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("");
    });
    render(<MatterChooser saved={saved({ resolve })} currentId={null} onChoose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Client-matter number" }), { target: { value: "100999-0004" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The number was not saved.");
  });

  it("marks the chat's matter with a check", () => {
    render(<MatterChooser saved={saved()} currentId="matter-2" onChoose={vi.fn()} />);
    const choices = screen.getAllByRole("menuitemradio");
    expect(choices.map((choice) => Boolean(choice.querySelector("svg")))).toEqual([false, true, false]);
  });
});
