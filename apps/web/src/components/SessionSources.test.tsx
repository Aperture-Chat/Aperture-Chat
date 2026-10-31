import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCitation, ChatMessage } from "../lib/types";
import { SessionSources, sessionSourceSets } from "./SessionSources";

function citation(id: string, fields: Partial<ChatCitation> = {}): ChatCitation {
  return {
    id,
    source_name: `${id}.pdf`,
    source_type: "upload",
    source_uri: `upload://${id}`,
    snippet: `Snippet of ${id}.`,
    ...fields,
  };
}

function knowledge(id: string, fields: Partial<ChatCitation> = {}): ChatCitation {
  return citation(id, {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    knowledge_config_id: "kb-1",
    k_index: 1,
    cited: true,
    locator: "Page 40",
    ...fields,
  });
}

function web(id: string, fields: Partial<ChatCitation> = {}): ChatCitation {
  return citation(id, {
    source_name: `Article ${id}`,
    source_type: "web",
    source_uri: `https://www.example.com/${id}`,
    ...fields,
  });
}

function assistant(id: string, citations: ChatCitation[], metadata?: ChatMessage["metadata"]): ChatMessage {
  return { id, role: "assistant", content: "Reply", createdAt: "now", status: "ok", citations, metadata };
}

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});

function renderSources(fields: Partial<Parameters<typeof SessionSources>[0]> = {}) {
  const onOpenDocument = vi.fn();
  render(<SessionSources messages={[]} focusedMessageId={null} onOpenDocument={onOpenDocument} {...fields} />);
  return onOpenDocument;
}

describe("source rows", () => {
  it("opens a knowledge citation in the viewer by its ids", () => {
    const onOpenDocument = renderSources({ messages: [assistant("m1", [knowledge("handbook")])] });
    fireEvent.click(screen.getByRole("button", { name: /handbook\.pdf/ }));
    expect(onOpenDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document",
        configId: "kb-1",
        documentId: "doc-handbook",
        chunkId: "chunk-handbook",
      }),
    );
  });

  // Safari does not focus a button on click, and closing returns focus to it.
  it("takes focus on click, so closing the viewer can return to the row", () => {
    renderSources({ messages: [assistant("m1", [knowledge("handbook")])] });
    const row = screen.getByRole("button", { name: /handbook\.pdf/ });
    fireEvent.click(row);
    expect(row).toHaveFocus();
  });

  it("shows the cited sentence in place of the chunk's opening", () => {
    renderSources({ messages: [assistant("m1", [knowledge("handbook", { passage: "The cited\n  sentence." })])] });
    expect(screen.getByText("The cited sentence.")).toBeInTheDocument();
    expect(screen.queryByText("Snippet of handbook.")).toBeNull();
  });

  it("keeps the snippet on old citations", () => {
    renderSources({ messages: [assistant("m1", [knowledge("handbook")])] });
    expect(screen.getByText("Snippet of handbook.")).toBeInTheDocument();
  });

  it("says where a document opens when it knows no page", () => {
    renderSources({ messages: [assistant("m1", [knowledge("lease", { locator: null, k_index: 1 })])] });
    expect(screen.getByRole("button", { name: /lease\.pdf/ })).toHaveTextContent("Opens at the passage");
  });

  it("does not promise a passage when a document opens at the top", () => {
    renderSources({
      messages: [assistant("m1", [knowledge("whole", { locator: null, chunk_id: null })])],
    });
    expect(screen.getByRole("button", { name: /whole\.pdf/ })).not.toHaveTextContent("Opens at the passage");
  });

  it("makes the whole row the control and shows where it points", () => {
    renderSources({ messages: [assistant("m1", [knowledge("handbook")])] });
    const row = screen.getByRole("button", { name: /handbook\.pdf/ });
    expect(row).toHaveAccessibleName(expect.stringContaining("Page 40"));
    expect(within(row).getByText("Page 40")).toBeInTheDocument();
    expect(within(row).queryByText("Opens at the passage")).toBeNull();
    expect(within(row).getByText("Snippet of handbook.")).toBeInTheDocument();
  });

  it.each([
    [{ locator: "Slide 3" }, "Slide 3"],
    [{ locator: "Sheet: Q3" }, "Sheet: Q3"],
    [{ locator: null, page_start: 12, page_end: 14 }, "Pages 12–14"],
  ])("labels %j", (fields, label) => {
    renderSources({ messages: [assistant("m1", [knowledge("deck", fields)])] });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("invents no location", () => {
    renderSources({ messages: [assistant("m1", [knowledge("deck", { locator: null, k_index: null })])] });
    const row = screen.getByRole("button", { name: /deck\.pdf/ });
    expect(row).not.toHaveTextContent(/\bpage\b/i);
  });

  it("resolves an old citation through its chunk", () => {
    const old = knowledge("old", { document_id: undefined, knowledge_config_id: undefined, cited: undefined });
    const onOpenDocument = renderSources({ messages: [assistant("m1", [old])] });
    fireEvent.click(screen.getByRole("button", { name: /old\.pdf/ }));
    expect(onOpenDocument).toHaveBeenCalledWith(expect.objectContaining({ kind: "chunk", chunkId: "chunk-old" }));
  });

  it("keeps a web result a link in a new tab", () => {
    renderSources({ messages: [assistant("m1", [web("story", { cited: true })])] });
    const link = screen.getByRole("link", { name: "Article story" });
    expect(link).toHaveAttribute("href", "https://www.example.com/story");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("keeps a plain upload as text", () => {
    renderSources({ messages: [assistant("m1", [citation("file")])] });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("file.pdf")).toBeInTheDocument();
  });

  it("never links an unsafe stored address", () => {
    renderSources({ messages: [assistant("m1", [web("bad", { source_uri: "javascript:alert(1)" })])] });
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("the word cited", () => {
  it("calls a reply's own marker cited, with the number it wrote", () => {
    renderSources({ messages: [assistant("m1", [knowledge("handbook", { k_index: 3 })])] });
    expect(screen.getByText("K3")).toHaveAttribute("data-tooltip", "Cited inline as [K3]");
  });

  it("gives an old record its number without claiming it was cited inline", () => {
    renderSources({ messages: [assistant("m1", [knowledge("old", { cited: undefined, k_index: 3 })])] });
    expect(screen.getByText("K3")).toHaveAttribute("data-tooltip", "Passage K3");
  });

  it("numbers a cited web result and marks a consulted one", () => {
    renderSources({
      messages: [
        assistant("m1", [
          web("a", { cited: true, w_index: 2 }),
          web("b", { cited: false, w_index: 3 }),
        ]),
      ],
    });
    expect(screen.getByText("W2")).toHaveAttribute("data-tooltip", "Cited inline as [W2]");
    expect(screen.queryByText("W3")).toBeNull();
    expect(screen.getByText("example.com · Consulted, not cited")).toBeInTheDocument();
  });

  it("says cited for extra rows that were", () => {
    const many = Array.from({ length: 8 }, (_, index) => knowledge(`k${index}`, { k_index: index + 1 }));
    renderSources({ messages: [assistant("m1", many)] });
    expect(screen.getByRole("button", { name: "Show 2 more cited in this chat" })).toBeInTheDocument();
  });

  // R7: attachments, MCP results, and old records carry no marker to prove it.
  it("stays neutral about rows with no record of being cited", () => {
    const many = Array.from({ length: 7 }, (_, index) => citation(`u${index}`, { cited: null }));
    renderSources({ messages: [assistant("m1", many)] });
    expect(screen.getByRole("button", { name: "Show 1 more source in this chat" })).toBeInTheDocument();
  });

  it("does not say cited when a hidden row was only consulted", () => {
    const many = Array.from({ length: 7 }, (_, index) => web(`w${index}`, { cited: index === 0 }));
    renderSources({ messages: [assistant("m1", many)] });
    const more = screen.getByRole("button", { name: "Show 1 more source in this chat" });
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Hide 1 source" })).toBeInTheDocument();
  });

  it("counts plurals on the way back", () => {
    const many = Array.from({ length: 8 }, (_, index) => knowledge(`k${index}`));
    renderSources({ messages: [assistant("m1", many)] });
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more cited in this chat" }));
    expect(screen.getByRole("button", { name: "Hide 2 cited sources" })).toBeInTheDocument();
  });

  it("stays neutral when one row of many was not proved cited", () => {
    const many = Array.from({ length: 8 }, (_, index) => knowledge(`k${index}`, { cited: index === 7 ? null : true }));
    renderSources({ messages: [assistant("m1", many)] });
    expect(screen.getByRole("button", { name: "Show 2 more sources in this chat" })).toBeInTheDocument();
  });

  it("does not call other sources citations", () => {
    renderSources({
      messages: [assistant("m1", [knowledge("a")]), assistant("m2", [web("b", { cited: false })])],
      focusedMessageId: "m1",
    });
    expect(screen.getByText("Other sources in this chat")).toBeInTheDocument();
  });
});

describe("groups", () => {
  it("files by source type: web as Web, everything else as Workspace", () => {
    renderSources({ messages: [assistant("m1", [knowledge("a"), web("b"), citation("c")])] });
    expect(screen.getByText("Web · 1")).toBeInTheDocument();
    expect(screen.getByText("Workspace · 2")).toBeInTheDocument();
  });

  it("files a crawled knowledge page under Web, still opening the viewer", () => {
    const crawled = knowledge("page", { source_type: "web", source_uri: "https://example.com/page" });
    const onOpenDocument = renderSources({ messages: [assistant("m1", [crawled])] });
    expect(screen.getByText("Web · 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /page\.pdf/ }));
    expect(onOpenDocument).toHaveBeenCalledOnce();
  });

  it("puts the selected response first", () => {
    renderSources({
      messages: [assistant("m1", [knowledge("a")]), assistant("m2", [knowledge("b")])],
      focusedMessageId: "m2",
    });
    expect(screen.getByText("Selected response · 1")).toBeInTheDocument();
    expect(screen.getByText("Workspace · 1")).toBeInTheDocument();
  });

  it("does not repeat a source that is already in the selected response", () => {
    const shared = knowledge("shared");
    renderSources({ messages: [assistant("m1", [shared]), assistant("m2", [shared])], focusedMessageId: "m2" });
    expect(screen.getAllByRole("button", { name: /shared\.pdf/ })).toHaveLength(1);
  });

  it("brings the sources into view when a response is selected", () => {
    const messages = [assistant("m1", [knowledge("a")])];
    const { rerender } = render(<SessionSources messages={messages} focusedMessageId={null} onOpenDocument={vi.fn()} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(<SessionSources messages={messages} focusedMessageId="m1" onOpenDocument={vi.fn()} />);
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("shows nothing when nothing was gathered", () => {
    const { container } = render(<SessionSources messages={[]} focusedMessageId={null} onOpenDocument={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("sessionSourceSets", () => {
  const versions = (active: number) => ({
    responseVersions: [
      { id: "v1", label: "Version 1", content: "First", citations: [knowledge("first")], createdAt: "now" },
      { id: "v2", label: "Version 2", content: "Second", citations: [knowledge("second")], createdAt: "now" },
    ],
    activeResponseVersionIndex: active,
    activeResponseVersionId: active === 0 ? "v1" : "v2",
  });

  it("reads the version on screen after a regenerate", () => {
    const message = assistant("m1", [knowledge("second")], versions(0));
    const { all } = sessionSourceSets([message], null);
    expect(all.map((item) => item.id)).toEqual(["first"]);
  });

  it("reads the same version for the selected response", () => {
    const message = assistant("m1", [knowledge("first")], versions(1));
    const { focused } = sessionSourceSets([message], "m1");
    expect(focused.map((item) => item.id)).toEqual(["second"]);
  });

  it("keeps two chunks of one document as two sources", () => {
    const { all } = sessionSourceSets(
      [assistant("m1", [knowledge("a", { source_uri: "upload://x" }), knowledge("b", { source_uri: "upload://x" })])],
      null,
    );
    expect(all).toHaveLength(2);
  });

  it("collapses old citations of one source", () => {
    const { all } = sessionSourceSets([assistant("m1", [citation("a"), citation("a")])], null);
    expect(all).toHaveLength(1);
  });
});
