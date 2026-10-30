import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { sampleData } from "../data/sampleData";
import { DocumentAssistantWorkspace } from "./DocumentAssistantWorkspace";

// Spreadsheet mode inside the Drafts workspace: the format rail, saving as a
// kind "spreadsheet" server draft, restoring versions, and the export menu.

const SCOPED_DRAFT_CACHE_KEY = "aperture-drafts-cache-v2:tenant-example:user-admin";

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function snapshot(id: string, title: string, content: string, revision: number) {
  const now = "2026-10-29T12:00:00Z";
  return {
    document: { id, tenant_id: "tenant-example", owner_user_id: "user-admin", matter_id: null, archived: false, kind: "spreadsheet", title, current_revision: revision, created_at: now, updated_at: now },
    revision: { draft_id: id, tenant_id: "tenant-example", owner_user_id: "user-admin", revision, title, content, content_sha256: "0".repeat(64), sanitizer_version: "sheet-json-v1", created_at: now },
  };
}

function installDraftsApi(): Call[] {
  const calls: Call[] = [];
  const fetchMock = globalThis.fetch as unknown as { mockImplementation: (implementation: typeof fetch) => void; mockReset?: () => void };
  fetchMock.mockReset?.();
  let revision = 0;
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const match = url.match(/\/api\/drafts(?:\/([^/?]+))?(?:\?.*)?$/);
    if (match) {
      calls.push({ method, url, body });
      if (!match[1] && method === "GET") return json([]);
      if (!match[1] && method === "POST") {
        revision = 1;
        return json(snapshot("sheet-srv-1", String(body?.title), String(body?.content), revision), 201);
      }
      if (match[1] && method === "PUT") {
        revision += 1;
        return json(snapshot("sheet-srv-1", String(body?.title ?? "Untitled"), String(body?.content), revision));
      }
    }
    return json({ error: "offline" }, 503);
  });
  return calls;
}

function grid() {
  return screen.getByRole("grid");
}

function typeIntoActiveCell(text: string) {
  fireEvent.keyDown(grid(), { key: text[0] });
  const editor = screen.getByLabelText(/^Edit [A-Z]+\d+$/);
  fireEvent.change(editor, { target: { value: text, selectionStart: text.length } });
  fireEvent.keyDown(editor, { key: "Enter" });
}

function cellText(address: string) {
  return document.querySelector(`.sheet-pane [data-cell='${address}'] .sheet-cell-text`)?.textContent ?? null;
}

beforeEach(() => {
  window.localStorage.clear();
});

test("the format rail opens a blank workbook that saves to the server as a spreadsheet draft", async () => {
  const calls = installDraftsApi();
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const rail = screen.getByRole("group", { name: "Draft format" });
  fireEvent.click(within(rail).getByRole("button", { name: "Spreadsheet" }));
  expect(rail).toHaveAttribute("data-mode", "spreadsheet");
  expect(screen.getByRole("heading", { name: "Spreadsheet Assistant" })).toBeInTheDocument();
  typeIntoActiveCell("Units");
  typeIntoActiveCell("4");
  typeIntoActiveCell("=A2*10");
  expect(cellText("A3")).toBe("40");
  fireEvent.click(screen.getByRole("button", { name: /Save version/ }));
  await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
  const create = calls.find((call) => call.method === "POST")!;
  expect(create.body).toMatchObject({ kind: "spreadsheet" });
  expect(String(create.body?.content)).toContain('"schema":"aperture-sheet-v1"');
  expect(String(create.body?.content)).toContain('"f":"A2*10"');
  await waitFor(() => expect(screen.getByRole("status", { name: "Save status" })).toHaveTextContent("Saved"));
  const cached = JSON.parse(window.localStorage.getItem(SCOPED_DRAFT_CACHE_KEY) ?? "[]") as Array<Record<string, unknown>>;
  expect(cached.find((item) => item.serverId === "sheet-srv-1")).toMatchObject({ kind: "spreadsheet" });
});

test("switching formats keeps the workbook, and the export menu offers Excel and CSV", async () => {
  installDraftsApi();
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  const rail = screen.getByRole("group", { name: "Draft format" });
  fireEvent.click(within(rail).getByRole("button", { name: "Spreadsheet" }));
  typeIntoActiveCell("Keep me");
  fireEvent.click(within(rail).getByRole("button", { name: "Document" }));
  expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  fireEvent.click(within(rail).getByRole("button", { name: "Spreadsheet" }));
  expect(cellText("A1")).toBe("Keep me");
  fireEvent.click(screen.getByRole("button", { name: /Save version/ }));
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const panel = await screen.findByRole("dialog", { name: "Export document" });
  expect(within(panel).getByText("Export workbook")).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: /Excel workbook/ })).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: /CSV \(current sheet\)/ })).toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: /Word document/ })).not.toBeInTheDocument();
});

test("a spreadsheet template opens as a workbook with live formulas", async () => {
  installDraftsApi();
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" />);
  fireEvent.click(within(screen.getByRole("group", { name: "Draft format" })).getByRole("button", { name: "Spreadsheet" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
  const templates = screen.getByLabelText("Spreadsheet templates");
  fireEvent.click(within(templates).getByRole("button", { name: /Loan calculator/ }));
  fireEvent.click(within(templates).getByRole("button", { name: /Start Loan calculator/ }));
  expect(screen.getByLabelText("Document title")).toHaveValue("Loan calculator");
  expect(screen.getByRole("tab", { name: "Loan" })).toHaveAttribute("aria-selected", "true");
  expect(cellText("B7")).toBe("$624.62");
});

const EXPENSES_REPLY = JSON.stringify({
  message: "Built a monthly expense tracker.",
  ops: [
    { op: "renameSheet", sheet: "Sheet1", name: "Expenses" },
    { op: "set", range: "A1", values: [["Category", "Amount"], ["Rent", 1800], ["Food", 420], ["Total", "=SUM(B2:B3)"]] },
    { op: "format", range: "B2:B4", style: { format: "$#,##0" } },
  ],
});

/** Answers the Drafts chat calls in turn (the last answer repeats), each after `gate` when given. */
function installSheetReply(gate?: Promise<void>, replies: string[] = [EXPENSES_REPLY]): string[] {
  const prompts: string[] = [];
  const fetchMock = globalThis.fetch as unknown as { mockImplementation: (implementation: typeof fetch) => void; mockReset?: () => void };
  fetchMock.mockReset?.();
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/chat/complete")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
      prompts.push(payload.messages.map((message) => message.content).join("\n"));
      await gate;
      const content = replies[Math.min(prompts.length, replies.length) - 1];
      return json({ choices: [{ message: { role: "assistant", content } }] });
    }
    if (/\/api\/drafts/.test(url) && (init?.method ?? "GET").toUpperCase() === "GET") return json([]);
    return json({ error: "offline" }, 503);
  });
  return prompts;
}

function renderSheetHandoff() {
  const model = sampleData.models.find((item) => item.id === "openrouter-openai-gpt-4o-mini")!;
  const data = { ...sampleData, models: sampleData.models.map((item) => (item.id === model.id ? { ...item, group_ids: ["group-litigation"], tenant_restricted: true } : item)) };
  render(
    <DocumentAssistantWorkspace
      data={data}
      brandName="Aperture Chat"
      initialRequest={{
        id: "handoff-sheet-1",
        kind: "spreadsheet",
        prompt: "Create a spreadsheet of my monthly expenses",
        webSearch: false,
        modelId: model.id,
        knowledgeIds: [],
        attachments: [],
        chatContext: "User: My rent is $1,800 and I spend about $420 on food.",
      }}
    />,
  );
}

test("a spreadsheet request handed over from chat opens the spreadsheet editor and builds the workbook", async () => {
  const prompts = installSheetReply();
  renderSheetHandoff();
  await waitFor(() => expect(screen.getByRole("group", { name: "Draft format" })).toHaveAttribute("data-mode", "spreadsheet"));
  await waitFor(() => expect(cellText("B4")).toBe("$2,220"));
  expect(screen.getByRole("tab", { name: "Expenses" })).toBeInTheDocument();
  // No title in the reply: the untitled draft takes the first sheet's new name.
  await waitFor(() => expect(screen.getByLabelText("Document title")).toHaveValue("Expenses"));
  expect(prompts[0]).toContain("User request: Create a spreadsheet of my monthly expenses");
  expect(prompts[0]).toContain("My rent is $1,800");
  expect(screen.getByText(/Built a monthly expense tracker/)).toBeInTheDocument();
});

test("a spreadsheet request is traced the way the chat traces a reply", async () => {
  let release = () => {};
  installSheetReply(new Promise<void>((resolve) => { release = resolve; }));
  renderSheetHandoff();
  const events = screen.getByLabelText("Assistant events");
  const running = await within(events).findByRole("status", { name: "Aperture Chat activity trace" });
  expect(running).toHaveTextContent("Aperture Chat is working");
  expect(within(running).getByText(/^Routed to /)).toBeInTheDocument();
  expect(within(running).getByText("Thinking")).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: /spreadsheet work trace/ })).not.toBeInTheDocument();
  release();
  const finished = await within(events).findByRole("region", { name: "Aperture Chat activity trace" });
  expect(finished).toHaveTextContent(/Worked for \d+s/);
  // Folding and reopening a finished trace shows every step at once.
  fireEvent.click(within(finished).getByRole("button", { name: "Collapse work trace" }));
  fireEvent.click(within(finished).getByRole("button", { name: "Expand work trace" }));
  for (const label of ["Starting from a blank workbook", "Built the workbook", "Recalculated every formula"]) {
    expect(within(finished).getByText(label)).toBeInTheDocument();
  }
  expect(within(finished).getByText(/^Thought for \d+s$/)).toBeInTheDocument();
  expect(within(finished).getByText(/^Saved as Version \d+$/)).toBeInTheDocument();
  expect(within(finished).queryByText(/^Fixing /)).not.toBeInTheDocument();
  expect(within(finished).queryByText("Thinking the model exposed")).not.toBeInTheDocument();
  // As in the chat, the trace sits under the request it worked on, above the reply.
  const request = within(events).getByText("Create a spreadsheet of my monthly expenses");
  const reply = await within(events).findByText(/Built a monthly expense tracker/);
  expect(request.compareDocumentPosition(finished) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(finished.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("the spreadsheet trace records a formula fix round and the thinking the model exposed", async () => {
  const broken = JSON.stringify({ message: "Built it.", ops: [{ op: "set", range: "A1", values: [["Total", "=1/0"]] }] });
  const fixed = JSON.stringify({ message: "Fixed B1.", ops: [{ op: "set", range: "B1", values: [[0]] }] });
  const prompts = installSheetReply(undefined, [`<think>Lay out a total row.</think>${broken}`, fixed]);
  renderSheetHandoff();
  const events = screen.getByLabelText("Assistant events");
  const finished = await within(events).findByRole("region", { name: "Aperture Chat activity trace" });
  expect(prompts).toHaveLength(2);
  fireEvent.click(within(finished).getByRole("button", { name: "Collapse work trace" }));
  fireEvent.click(within(finished).getByRole("button", { name: "Expand work trace" }));
  expect(within(finished).getByText("Fixing 1 formula that errored")).toBeInTheDocument();
  expect(within(finished).getAllByText(/^Thought for \d+s$/)).toHaveLength(2);
  expect(within(finished).getByText("Recalculated every formula")).toBeInTheDocument();
  expect(within(finished).getByText("Thinking the model exposed")).toBeInTheDocument();
  expect(cellText("B1")).toBe("0");
});
