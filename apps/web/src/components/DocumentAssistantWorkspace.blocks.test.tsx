import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import { DocumentAssistantWorkspace } from "./DocumentAssistantWorkspace";

// The Drafts assistant takes files the way chat does, on all three tabs: # pulls
// in a file or a whole base, an attached file opens in the viewer, and whatever
// sits in the box goes with every request that reads sources.

const FILE = "Harbor lease.pdf";
const BASE = "Litigation Playbook";
const BASE_ID = "kb-litigation-playbook";
const FILE_BLOCK = {
  id: "knowledge-lease",
  name: FILE,
  size: "2.1 MB",
  kind: "PDF",
  size_bytes: 2_200_000,
  source_type: "knowledge",
  source_uri: `knowledge://${BASE_ID}/doc-lease`,
  status: "uploaded",
  text_preview: null,
};
const BASE_BLOCK = {
  ...FILE_BLOCK,
  id: "knowledge-playbook",
  name: BASE,
  size: "12 files",
  kind: "Knowledge",
  size_bytes: null,
  source_uri: `knowledge://${BASE_ID}`,
};
const VIEW = {
  document_id: "doc-lease",
  knowledge_config_id: "",
  attachment_id: "knowledge-lease",
  name: FILE,
  content_type: "text/plain",
  mode: "text",
  file_url: null,
  original_available: true,
  page_count: null,
  target: null,
  segments: [{ id: "s1", page: null, locator: null, text: "The whole lease." }],
  notice: null,
  properties: [],
  passage_count: 1,
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

type Routes = {
  pull?: (body: { document_id?: string }) => Promise<Response> | Response;
  reply?: string;
  citations?: unknown[];
};

function install({
  pull = (body) => json(body.document_id ? FILE_BLOCK : BASE_BLOCK),
  reply = "# Draft\n\nSynthetic.",
  citations = [],
}: Routes = {}) {
  const log = {
    pulled: [] as unknown[],
    requests: [] as Array<Record<string, unknown>>,
    opened: [] as string[],
    deleted: [] as string[],
  };
  const fetchMock = globalThis.fetch as unknown as { mockImplementation: (implementation: typeof fetch) => void };
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    if (url.endsWith(`/api/knowledge/${BASE_ID}/documents`)) return json([{ id: "doc-lease", name: FILE }]);
    if (/\/api\/knowledge\/[^/]+\/documents$/.test(url)) return json([]);
    if (url.endsWith("/api/chat/attachments/knowledge")) {
      const body = JSON.parse(String(init?.body));
      log.pulled.push(body);
      return pull(body);
    }
    if (url.endsWith("/api/chat/attachments") && method === "POST") {
      const file = (init?.body as FormData).get("file") as File;
      return json({ id: `upload-${file.name}`, name: file.name, size: "1 KB", kind: "PDF", text_preview: "Text." });
    }
    if (/\/api\/chat\/attachments\/[^/]+\/view$/.test(url)) {
      log.opened.push(url);
      return json(VIEW);
    }
    if (/\/api\/chat\/attachments\/[^/]+$/.test(url) && method === "DELETE") {
      log.deleted.push(url);
      return json({ status: "deleted" });
    }
    if (url.endsWith("/api/chat/complete")) {
      log.requests.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ choices: [{ message: { role: "assistant", content: reply } }], citations });
    }
    return json({ error: "offline" }, 503);
  });
  return log;
}

function showTab(tab: string) {
  if (tab !== "Document") fireEvent.click(screen.getByRole("button", { name: tab }));
}

const BOX: Record<string, string> = {
  Document: "Ask the document assistant",
  Deck: "Ask the deck assistant",
  Spreadsheet: "Ask the spreadsheet assistant",
};

function box(tab = "Document") {
  return screen.getByRole("textbox", { name: BOX[tab] }) as HTMLTextAreaElement;
}

function type(textarea: HTMLTextAreaElement, value: string, caret = value.length) {
  fireEvent.change(textarea, { target: { value, selectionStart: caret, selectionEnd: caret } });
}

function pick(name: RegExp) {
  return screen.findAllByRole("option", { name }).then((options) => fireEvent.click(options[0]));
}

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

beforeEach(() => {
  window.localStorage.clear();
});

describe.each(["Document", "Deck", "Spreadsheet"])("the %s assistant", (tab) => {
  test("# lists knowledge bases and their files", async () => {
    install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    showTab(tab);

    type(box(tab), "#");

    expect(await screen.findByRole("option", { name: new RegExp(FILE) })).toHaveTextContent(`In ${BASE}`);
    expect(screen.getByRole("option", { name: new RegExp(`^${BASE}`) })).toBeInTheDocument();
    expect(screen.getByText("Choose a file to attach it, or a knowledge base to bring in all of it.")).toBeInTheDocument();
  });

  test("a picked file becomes a block, the text goes, and the request carries it", async () => {
    const log = install({ reply: "Noted." });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    showTab(tab);
    type(box(tab), "#Harbor");

    await pick(new RegExp(FILE));

    expect(box(tab)).toHaveValue("");
    const block = await screen.findByRole("button", { name: `Open ${FILE}` });
    await waitFor(() => expect(block).toBeEnabled());
    expect(block).toHaveTextContent("2.1 MB · PDF");
    expect(log.pulled).toEqual([{ knowledge_config_id: BASE_ID, document_id: "doc-lease" }]);

    type(box(tab), "Use this");
    fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

    await waitFor(() => expect(log.requests.length).toBeGreaterThan(0));
    expect(log.requests[0].attachment_ids).toEqual(["knowledge-lease"]);
  });

  test("a picked base becomes a block that counts its files", async () => {
    const log = install({ reply: "Noted." });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    showTab(tab);
    type(box(tab), "#Litigation");

    await pick(new RegExp(`^${BASE}`));

    expect(box(tab)).toHaveValue("");
    const block = await screen.findByRole("button", { name: `Open ${BASE}` });
    await waitFor(() => expect(block).toHaveTextContent("12 files · Knowledge"));
    expect(log.pulled).toEqual([{ knowledge_config_id: BASE_ID }]);
    type(box(tab), "Use all of it");
    fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));
    await waitFor(() => expect(log.requests.length).toBeGreaterThan(0));
    expect(log.requests[0].attachment_ids).toEqual(["knowledge-playbook"]);
  });

  test("a block opens the document", async () => {
    const log = install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    showTab(tab);
    type(box(tab), "#Harbor");
    await pick(new RegExp(FILE));
    const block = await screen.findByRole("button", { name: `Open ${FILE}` });
    await waitFor(() => expect(block).toBeEnabled());

    fireEvent.click(block);

    expect(await screen.findByRole("dialog", { name: FILE })).toBeInTheDocument();
    expect(await screen.findByText("The whole lease.")).toBeInTheDocument();
    expect(log.opened.join(" ")).toContain("/api/chat/attachments/knowledge-lease/view");
  });

  test("an uploaded file is a block that opens too", async () => {
    const log = install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    showTab(tab);

    fireEvent.change(screen.getByLabelText("Attach draft source files"), {
      target: { files: [new File(["%PDF"], "brief.pdf", { type: "application/pdf" })] },
    });

    const block = await screen.findByRole("button", { name: "Open brief.pdf" });
    await waitFor(() => expect(block).toBeEnabled());
    expect(block).toHaveTextContent("1 KB · PDF");
    fireEvent.click(block);
    await screen.findByRole("dialog", { name: FILE });
    expect(log.opened.join(" ")).toContain("/api/chat/attachments/upload-brief.pdf/view");
  });
});

describe("the # menu in Drafts", () => {
  test("the keyboard moves through the list, picks, and never sends by accident", async () => {
    const log = install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "#Harbor");
    await screen.findByRole("option", { name: new RegExp(FILE) });
    const options = () => screen.getAllByRole("option");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options()[1].id);
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByRole("button", { name: `Open ${FILE}` });
    expect(log.pulled).toEqual([{ knowledge_config_id: BASE_ID, document_id: "doc-lease" }]);
    expect(log.requests).toEqual([]);
  });

  test("Escape closes the list and keeps what was typed", async () => {
    install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "#Harbor");
    await screen.findByRole("listbox", { name: "Knowledge commands" });

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "Knowledge commands" })).not.toBeInTheDocument();
    expect(textarea).toHaveValue("#Harbor");
  });

  test("Escape closes only the list, so the drawer around it stays until the next press", async () => {
    install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "#Harbor");
    await screen.findByRole("listbox", { name: "Knowledge commands" });
    const pageHeard = vi.fn();
    document.addEventListener("keydown", pageHeard);

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(pageHeard).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(pageHeard).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", pageHeard);
  });

  test("Enter still sends when the list is closed", async () => {
    const log = install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "Write a short memo");

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(log.requests.length).toBeGreaterThan(0));
  });

  test("only # opens a list in Drafts", () => {
    install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);

    type(box(), "/summary");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  test("leaving the box closes the list", async () => {
    install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "#");
    await screen.findByRole("listbox", { name: "Knowledge commands" });

    fireEvent.blur(textarea);

    expect(screen.queryByRole("listbox", { name: "Knowledge commands" })).not.toBeInTheDocument();
  });

  test("picking mid-sentence leaves the sentence whole", async () => {
    install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "Compare #Harbor with last year", "Compare #Harbor".length);

    await pick(new RegExp(FILE));

    expect(textarea).toHaveValue("Compare with last year");
  });

  test("the same file picked twice is one block", async () => {
    const log = install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "#Harbor");
    await pick(new RegExp(FILE));
    await screen.findByRole("button", { name: `Open ${FILE}` });
    await nextFrame();

    type(textarea, "#Harbor");
    await pick(new RegExp(FILE));

    expect(screen.getAllByRole("button", { name: `Open ${FILE}` })).toHaveLength(1);
    expect(log.pulled).toHaveLength(1);
    expect(textarea).toHaveValue("");
  });

  test("a file that cannot be pulled in says so and leaves no block", async () => {
    install({ pull: () => json({ detail: "Unknown knowledge document." }, 404) });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    type(box(), "#Harbor");

    await pick(new RegExp(FILE));

    await waitFor(() => expect(screen.queryByRole("button", { name: `Open ${FILE}` })).not.toBeInTheDocument());
    const notices = await screen.findAllByText(new RegExp(`${FILE} could not be attached: Unknown knowledge document`));
    expect(notices.length).toBeGreaterThan(0);
  });

  test("sending waits for a block still on its way", async () => {
    let arrive!: (response: Response) => void;
    const log = install({ pull: () => new Promise<Response>((resolve) => { arrive = resolve; }) });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "#Harbor");
    await pick(new RegExp(FILE));
    await waitFor(() => expect(arrive).toBeDefined());
    type(textarea, "Use this");

    expect(screen.getByRole("button", { name: "Apply instruction" })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Open ${FILE}` })).toBeDisabled();

    await act(async () => arrive(json(FILE_BLOCK)));
    await waitFor(() => expect(screen.getByRole("button", { name: `Open ${FILE}` })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

    await waitFor(() => expect(log.requests.length).toBeGreaterThan(0));
    expect(log.requests[0].attachment_ids).toEqual(["knowledge-lease"]);
  });

  test("Enter waits for a block still on its way, and keeps the words", async () => {
    let arrive!: (response: Response) => void;
    const log = install({ pull: () => new Promise<Response>((resolve) => { arrive = resolve; }) });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "#Harbor");
    await pick(new RegExp(FILE));
    await waitFor(() => expect(arrive).toBeDefined());
    await nextFrame();
    type(textarea, "Use this");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await nextFrame();

    expect(log.requests).toEqual([]);
    expect(textarea).toHaveValue("Use this");
    expect((await screen.findAllByText("Your files are still on their way. Send again in a moment.")).length).toBeGreaterThan(0);
    await act(async () => arrive(json(FILE_BLOCK)));
  });

  test("a block removed while it arrives leaves nothing behind", async () => {
    let arrive!: (response: Response) => void;
    const log = install({ pull: () => new Promise<Response>((resolve) => { arrive = resolve; }) });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    type(box(), "#Harbor");
    await pick(new RegExp(FILE));
    await waitFor(() => expect(arrive).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: `Remove ${FILE}` }));
    await act(async () => arrive(json(FILE_BLOCK)));

    await waitFor(() => expect(log.deleted.join(" ")).toContain("/api/chat/attachments/knowledge-lease"));
    expect(screen.queryByRole("button", { name: `Open ${FILE}` })).not.toBeInTheDocument();
  });

  test("removing a block takes it back and drops it from the next request", async () => {
    const log = install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    const textarea = box();
    type(textarea, "#Harbor");
    await pick(new RegExp(FILE));
    const open = await screen.findByRole("button", { name: `Open ${FILE}` });
    await waitFor(() => expect(open).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: `Remove ${FILE}` }));

    await waitFor(() => expect(log.deleted.join(" ")).toContain("/api/chat/attachments/knowledge-lease"));
    type(textarea, "Write a short memo");
    fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));
    await waitFor(() => expect(log.requests.length).toBeGreaterThan(0));
    expect(log.requests[0].attachment_ids).toEqual([]);
  });
});

describe("what a draft keeps of a source", () => {
  const CITED = { id: "c1", k_index: 1, source_name: FILE, source_type: "upload", source_uri: "x", snippet: "x", page_start: 2, page_end: 2 };

  test("a drafted document cites the file and page, never a chat marker", async () => {
    const log = install({ reply: "# Memo\n\nThe fee is four percent. [K1]\n\nA claim with no source. [K9]", citations: [CITED] });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    type(box(), "Write a memo from my file");

    fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));

    await waitFor(() => expect(document.body.textContent).toContain("(Harbor lease, p. 2)"));
    expect(log.requests.length).toBeGreaterThan(0);
    expect(document.querySelector("[contenteditable='true']")?.textContent).not.toMatch(/\[K\d/);
  });
});

describe("what a block reaches", () => {
  test("the inline AI edit reads the blocks", async () => {
    const log = install({ reply: "Revised wording." });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    type(box(), "#Harbor");
    await pick(new RegExp(FILE));
    const open = await screen.findByRole("button", { name: `Open ${FILE}` });
    await waitFor(() => expect(open).toBeEnabled());
    const body = document.querySelector<HTMLElement>("[contenteditable='true']")!;
    body.innerHTML = "<p>The original selected wording.</p>";
    fireEvent.input(body);
    const text = body.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 12);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.click(screen.getByRole("button", { name: "Inline AI edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit with AI" });

    fireEvent.change(within(dialog).getByRole("combobox", { name: "AI instruction" }), {
      target: { value: "Use the lease wording" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run AI instruction" }));

    await waitFor(() => expect(log.requests.length).toBeGreaterThan(0));
    expect(log.requests[0].attachment_ids).toEqual(["knowledge-lease"]);
  });

  test("the slide AI edit reads the blocks", async () => {
    const log = install({ reply: "Noted." });
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    fireEvent.click(screen.getByRole("button", { name: "Deck" }));
    type(box("Deck"), "#Harbor");
    await pick(new RegExp(FILE));
    const open = await screen.findByRole("button", { name: `Open ${FILE}` });
    await waitFor(() => expect(open).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Edit slide with AI" }));
    fireEvent.click(screen.getByRole("option", { name: "Improve this slide" }));

    await waitFor(() => expect(log.requests.length).toBeGreaterThan(0));
    expect(log.requests[0].attachment_ids).toEqual(["knowledge-lease"]);
  });

  test("the citation list says what a base is, not that it was uploaded", async () => {
    install();
    render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
    type(box(), "#Litigation");
    await pick(new RegExp(`^${BASE}`));
    await screen.findByRole("button", { name: `Open ${BASE}` });
    await waitFor(() => expect(screen.getByRole("button", { name: `Open ${BASE}` })).toBeEnabled());

    expect(document.body.textContent).not.toContain("12 files upload");
  });
});
