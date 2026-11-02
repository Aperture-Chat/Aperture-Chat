import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import {
  ResourceSearch,
  ResourceTiles,
  ShortcutGuide,
  StreamSwitch,
  ToolSwitch,
  agentOptionDetail,
  knowledgeOptionDetail,
  resourceListShows,
  resourceSectionIcon,
  resourceSectionLabel,
  resourceViewLoadsKnowledgeFiles,
  resourceViewTitle,
  webOptionDetail,
} from "./ComposerOptions";
import { RailSwitch } from "./RailSwitch";
import { ReasoningRail, reasoningHelp } from "./ReasoningSlider";
import { BookOpen, Bot, MessageSquare, Plug } from "lucide-react";

describe("ToolSwitch", () => {
  test("reads as a labeled on/off control and toggles from the whole row", () => {
    const onToggle = vi.fn();
    render(<ToolSwitch icon={BookOpen} label="Knowledge" detail="Answer from your knowledge bases." checked={false} onToggle={onToggle} />);
    const row = screen.getByRole("menuitemcheckbox", { name: "Knowledge Answer from your knowledge bases." });
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(row).toHaveTextContent("Off");
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("shows On when the tool is on", () => {
    render(<ToolSwitch icon={BookOpen} label="Web" detail="Look up current information online." checked onToggle={() => {}} />);
    const row = screen.getByRole("menuitemcheckbox", { name: "Web Look up current information online." });
    expect(row).toHaveAttribute("aria-checked", "true");
    expect(row).toHaveTextContent("On");
    expect(row).not.toHaveTextContent("Off");
    expect(row.querySelector(".composer-switch")).toHaveClass("is-on");
  });

  test("the switch is unlit when the tool is off", () => {
    render(<ToolSwitch icon={BookOpen} label="Web" detail="Detail" checked={false} onToggle={() => {}} />);
    expect(screen.getByRole("menuitemcheckbox").querySelector(".composer-switch")).not.toHaveClass("is-on");
  });

  test("an unavailable tool cannot be switched", () => {
    const onToggle = vi.fn();
    render(<ToolSwitch icon={BookOpen} label="Web" detail="Not available for this model." checked={false} disabled onToggle={onToggle} />);
    const row = screen.getByRole("menuitemcheckbox");
    expect(row).toBeDisabled();
    fireEvent.click(row);
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("announces its picker only when it has one", () => {
    const { rerender } = render(<ToolSwitch icon={BookOpen} label="Web" detail="Detail" checked onToggle={() => {}} />);
    expect(screen.getByRole("menuitemcheckbox")).not.toHaveAttribute("aria-expanded");
    rerender(<ToolSwitch icon={BookOpen} label="Knowledge" detail="Detail" checked expanded onToggle={() => {}} />);
    expect(screen.getByRole("menuitemcheckbox")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitemcheckbox")).toHaveAttribute("aria-haspopup", "true");
  });
});

describe("StreamSwitch", () => {
  test("keeps a real checkbox with a short name and explains itself beside it", () => {
    const onToggle = vi.fn();
    render(<StreamSwitch checked onToggle={onToggle} />);
    const box = screen.getByRole("checkbox", { name: "Stream replies" });
    expect(box).toBeChecked();
    expect(box.closest("label")).toHaveTextContent("Show the words as they are written.");
    expect(box.closest("label")).toHaveTextContent("On");
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("shows Off when replies wait until they finish", () => {
    render(<StreamSwitch checked={false} onToggle={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "Stream replies" }).closest("label")).toHaveTextContent("Off");
  });
});

describe("option details", () => {
  test("Knowledge names the chosen base, and says why it is unavailable", () => {
    expect(knowledgeOptionDetail({ available: true, on: false, baseName: "Matter files" })).toBe("Answer from your knowledge bases.");
    expect(knowledgeOptionDetail({ available: true, on: true, baseName: "Matter files" })).toBe("Using Matter files.");
    expect(knowledgeOptionDetail({ available: true, on: true })).toBe("Answer from your knowledge bases.");
    expect(knowledgeOptionDetail({ available: false, on: false })).toBe("No knowledge bases are set up yet.");
  });

  test("Web says why it is unavailable", () => {
    expect(webOptionDetail(true)).toBe("Look up current information online.");
    expect(webOptionDetail(false)).toBe("Not available for this model.");
  });

  test("Agent names the chosen profile", () => {
    expect(agentOptionDetail()).toBe("Let a specialized assistant answer.");
    expect(agentOptionDetail("Client Update Agent")).toBe("Using Client Update Agent.");
  });
});

describe("resource views", () => {
  test("the tiles list nothing and load no files", () => {
    expect(resourceListShows("tiles", "Prompts")).toBe(false);
    expect(resourceViewLoadsKnowledgeFiles("tiles")).toBe(false);
  });

  test("all resources lists every section and loads files", () => {
    expect(resourceListShows("all", "Prompts")).toBe(true);
    expect(resourceViewLoadsKnowledgeFiles("all")).toBe(true);
  });

  test("a category lists only itself and loads files only when it needs them", () => {
    expect(resourceListShows("Prompts", "Prompts")).toBe(true);
    expect(resourceListShows("Prompts", "Agents")).toBe(false);
    expect(resourceViewLoadsKnowledgeFiles("Prompts")).toBe(false);
    expect(resourceViewLoadsKnowledgeFiles("Knowledge bases")).toBe(true);
    expect(resourceViewLoadsKnowledgeFiles("Files in knowledge sources")).toBe(true);
  });

  test("each section keeps its own icon, with a fallback for an unknown one", () => {
    expect(resourceSectionIcon("MCP connections")).toBe(Plug);
    expect(resourceSectionIcon("Prompts")).toBe(MessageSquare);
    expect(resourceSectionIcon("Agents")).toBe(Bot);
    expect(resourceSectionIcon("Something new")).toBe(BookOpen);
  });

  test("headings use the plain names", () => {
    expect(resourceSectionLabel("MCP connections")).toBe("Connections");
    expect(resourceSectionLabel("Files in knowledge sources")).toBe("Knowledge files");
    expect(resourceSectionLabel("Something new")).toBe("Something new");
    expect(resourceViewTitle("MCP connections", "")).toBe("Connections");
    expect(resourceViewTitle("all", "")).toBe("All resources");
    expect(resourceViewTitle("all", "smith")).toBe("Search results");
    expect(resourceViewTitle("all", "   ")).toBe("All resources");
  });
});

describe("ResourceSearch", () => {
  test("reports typing and keeps Enter from submitting the message form", () => {
    const onChange = vi.fn();
    render(<ResourceSearch value="" onChange={onChange} />);
    const box = screen.getByRole("textbox", { name: "Find a resource" });
    fireEvent.change(box, { target: { value: "smith" } });
    expect(onChange).toHaveBeenCalledWith("smith");
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(box, { key: "a" })).toBe(true);
  });
});

describe("ResourceTiles", () => {
  test("marks each tile with the view it opens, so Back can return focus to it", () => {
    render(<ResourceTiles inUse={{}} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: /^Prompts/ })).toHaveAttribute("data-resource-tile", "Prompts");
    expect(screen.getByRole("button", { name: /^All resources/ })).toHaveAttribute("data-resource-tile", "all");
  });

  test("one thing in use counts, and an idle tile keeps its description", () => {
    render(<ResourceTiles inUse={{ Agents: 1 }} onOpen={() => {}} />);
    const agents = screen.getByRole("button", { name: /^Agents/ });
    expect(agents).toHaveTextContent("1 in use");
    expect(agents).toHaveClass("is-active");
    const prompts = screen.getByRole("button", { name: /^Prompts/ });
    expect(prompts).toHaveTextContent("Saved wording to reuse");
    expect(prompts).not.toHaveClass("is-active");
  });

  test("opens the chosen category and the everything list", () => {
    const onOpen = vi.fn();
    render(<ResourceTiles inUse={{}} onOpen={onOpen} />);
    const tiles = screen.getByRole("group", { name: "Resource categories" });
    fireEvent.click(within(tiles).getByRole("button", { name: /^Connections/ }));
    expect(onOpen).toHaveBeenLastCalledWith("MCP connections");
    fireEvent.click(within(tiles).getByRole("button", { name: /^All resources/ }));
    expect(onOpen).toHaveBeenLastCalledWith("all");
  });

  test("a category in use says so instead of its description", () => {
    render(<ResourceTiles inUse={{ Automations: 2, Agents: 0 }} onOpen={() => {}} />);
    const automations = screen.getByRole("button", { name: /^Automations/ });
    expect(automations).toHaveTextContent("2 in use");
    expect(automations).toHaveClass("is-active");
    const agents = screen.getByRole("button", { name: /^Agents/ });
    expect(agents).not.toHaveTextContent("in use");
    expect(agents).not.toHaveClass("is-active");
  });
});

describe("ShortcutGuide", () => {
  const shortcuts = [{ symbol: "/", label: "Prompts" }, { symbol: "@", label: "Agents" }];
  const openGuide = (open: boolean) => {
    const guide = screen.getByRole("group", { name: "Type shortcuts in chat" }) as HTMLDetailsElement;
    guide.open = open;
    fireEvent(guide, new Event("toggle"));
    return guide;
  };

  test("starts folded and pairs each symbol with its label", () => {
    render(<ShortcutGuide shortcuts={shortcuts} />);
    const guide = screen.getByRole("group", { name: "Type shortcuts in chat" });
    expect(guide).not.toHaveAttribute("open");
    expect(within(guide).getByText("Typing shortcuts").tagName).toBe("SUMMARY");
    expect(within(guide).getByText("Agents").closest("div")?.querySelector("dt")).toHaveTextContent("@");
  });

  test("opening it brings the list into view; closing it does not move the panel", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<ShortcutGuide shortcuts={shortcuts} />);
    openGuide(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
    openGuide(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});

describe("RailSwitch", () => {
  test("a disabled rail refuses every stop but still shows the current one", () => {
    const onChange = vi.fn();
    render(
      <RailSwitch
        ariaLabel="Size"
        value="a"
        onChange={onChange}
        disabled
        options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Size" })).toHaveClass("is-disabled");
    expect(screen.getByRole("radio", { name: "A" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  test("arrow keys wrap around, Home and End jump, and other keys are left alone", () => {
    const onChange = vi.fn();
    render(
      <RailSwitch
        ariaLabel="Size"
        value="b"
        onChange={onChange}
        options={[{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }]}
      />,
    );
    const rail = screen.getByRole("radiogroup", { name: "Size" });
    const moved = (key: string) => {
      onChange.mockClear();
      const notPrevented = fireEvent.keyDown(rail, { key });
      return { to: onChange.mock.calls[0]?.[0], prevented: !notPrevented };
    };
    expect(moved("ArrowRight")).toEqual({ to: "c", prevented: true });
    expect(screen.getByRole("radio", { name: "C" })).toHaveFocus();
    expect(moved("ArrowDown")).toEqual({ to: "c", prevented: true });
    expect(moved("ArrowLeft")).toEqual({ to: "a", prevented: true });
    expect(moved("ArrowUp")).toEqual({ to: "a", prevented: true });
    expect(moved("Home")).toEqual({ to: "a", prevented: true });
    expect(moved("End")).toEqual({ to: "c", prevented: true });
    expect(moved("Enter")).toEqual({ to: undefined, prevented: false });
  });

  test("arrow keys wrap past both ends", () => {
    const onChange = vi.fn();
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
    const { rerender } = render(<RailSwitch ariaLabel="Size" value="b" onChange={onChange} options={options} />);
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    rerender(<RailSwitch ariaLabel="Size" value="a" onChange={onChange} options={options} />);
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("b");
  });

  test("only the chosen stop is lit and reachable with Tab", () => {
    render(<RailSwitch ariaLabel="Size" value="b" onChange={() => {}} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />);
    const chosen = screen.getByRole("radio", { name: "B" });
    const other = screen.getByRole("radio", { name: "A" });
    expect(chosen).toHaveClass("is-active");
    expect(chosen).toHaveAttribute("tabindex", "0");
    expect(other).not.toHaveClass("is-active");
    expect(other).toHaveAttribute("tabindex", "-1");
  });

  test("layout options apply only when asked for", () => {
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
    const { rerender } = render(<RailSwitch ariaLabel="Size" value="a" onChange={() => {}} options={options} />);
    const rail = () => screen.getByRole("radiogroup", { name: "Size" });
    expect(rail()).not.toHaveClass("is-block");
    expect(rail()).not.toHaveClass("is-stacked");
    rerender(<RailSwitch ariaLabel="Size" value="a" onChange={() => {}} options={options} block stacked />);
    expect(rail()).toHaveClass("is-block");
    expect(rail()).toHaveClass("is-stacked");
  });

  test("an enabled rail is not marked disabled", () => {
    render(<RailSwitch ariaLabel="Size" value="a" onChange={() => {}} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />);
    expect(screen.getByRole("radiogroup", { name: "Size" })).not.toHaveClass("is-disabled");
    expect(screen.getByRole("radio", { name: "B" })).toBeEnabled();
  });
});

describe("ReasoningRail", () => {
  test("offers every level by name and reports the choice", () => {
    const onChange = vi.fn();
    render(<ReasoningRail level="balanced" supported onChange={onChange} />);
    const rail = screen.getByRole("radiogroup", { name: "Model reasoning level" });
    expect(within(rail).getAllByRole("radio").map((stop) => stop.textContent)).toEqual(["Fast", "Balanced", "Smart"]);
    expect(within(rail).getByRole("radio", { name: "Balanced" })).toBeChecked();
    fireEvent.click(within(rail).getByRole("radio", { name: "Smart" }));
    expect(onChange).toHaveBeenCalledWith("smart");
  });

  test("an unsupported model sits on Balanced and cannot change", () => {
    const onChange = vi.fn();
    render(<ReasoningRail level="smart" supported={false} onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Balanced" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  test("the help line follows the chosen level", () => {
    expect(reasoningHelp("fast", true, "Model")).toBe("Quicker answers, less time thinking.");
    expect(reasoningHelp("balanced", true, "Model")).toBe("The model's usual pace.");
    expect(reasoningHelp("smart", true, "Model")).toBe("Takes longer and thinks it through.");
    expect(reasoningHelp("smart", false, "GPT Mini")).toBe("GPT Mini does not support reasoning levels.");
  });
});
