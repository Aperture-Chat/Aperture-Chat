import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { RuntimeRecord } from "../lib/runtimeRecords";
import type { UserPromptRecord } from "../lib/types";
import { nearestExchangeId } from "./PromptActivityList";
import { RuntimeRecordList } from "./RuntimeRecordList";

const CHAT_RUN: RuntimeRecord = {
  id: "run-chat",
  surface: "chat",
  title: "Lease amendment review",
  detail: "Jordan Lee · GPT X · OpenRouter · 3 messages",
  metadata: "Chat · sent from their device Jul 1, 12:00 PM",
  executedAt: "2026-07-01T12:03:01Z",
  clientStartedAt: "2026-07-01T12:03:00Z",
  actorId: "user-1",
  actorName: "Jordan Lee",
  actorRole: "USER",
  model: "GPT X",
  provider: "OpenRouter",
  messageCount: 3,
  threadId: "thread-1",
};

const DRAFT_RUN: RuntimeRecord = { ...CHAT_RUN, id: "run-draft", surface: "draft", title: "HOA PMA", threadId: null };

function exchange(id: string, at: string, prompt: string): UserPromptRecord {
  return {
    id,
    thread_id: "thread-1",
    thread_title: "Lease amendment review",
    user_id: "user-1",
    user_name: "Jordan Lee",
    user_email: "jordan@example.test",
    model_id: "gpt-x",
    alert_count: 0,
    content: prompt,
    created_at: at,
    created_at_iso: at,
    response_content: `Answer to ${prompt}`,
    response_message_id: `${id}-answer`,
  } as UserPromptRecord;
}

const formatTime = (value: string) => `time ${value}`;

test("a chat run opens its saved conversation and marks the exchange it produced", async () => {
  const loadThreadRecords = vi.fn(async () => [
    exchange("second", "2026-07-01T12:03:00Z", "Second question"),
    exchange("first", "2026-07-01T12:00:00Z", "First question"),
  ]);
  render(<RuntimeRecordList records={[CHAT_RUN]} ariaLabel="Runs" formatTime={formatTime} loadThreadRecords={loadThreadRecords} />);

  fireEvent.click(screen.getByRole("button", { name: "Open the conversation: Lease amendment review" }));

  const dialog = await screen.findByRole("dialog", { name: "Conversation behind this run" });
  expect(loadThreadRecords).toHaveBeenCalledWith("thread-1");
  expect(await within(dialog).findByText("Answer to First question")).toBeInTheDocument();
  expect(within(dialog).getByText("2 exchanges in this conversation, oldest first.")).toBeInTheDocument();
  const runExchange = within(dialog).getByRole("article", { name: "Exchange 2 of 2" });
  expect(within(runExchange).getByText("This run")).toBeInTheDocument();
  expect(within(dialog).getByRole("article", { name: "Exchange 1 of 2" })).not.toHaveTextContent("This run");
});

test("a draft run is a record with nothing to open", () => {
  render(<RuntimeRecordList records={[DRAFT_RUN]} ariaLabel="Runs" formatTime={formatTime} loadThreadRecords={vi.fn()} />);
  expect(screen.getByText("HOA PMA")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("without access to saved conversations a chat run is a record too", () => {
  render(<RuntimeRecordList records={[CHAT_RUN]} ariaLabel="Runs" formatTime={formatTime} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("a deleted chat says what is left instead of showing an empty box", async () => {
  render(<RuntimeRecordList records={[CHAT_RUN]} ariaLabel="Runs" formatTime={formatTime} loadThreadRecords={async () => []} />);
  fireEvent.click(screen.getByRole("button", { name: /Open the conversation/ }));
  expect(await screen.findByText("This chat is no longer saved, so only the run details above remain.")).toBeInTheDocument();
});

test("a failed load says so", async () => {
  render(
    <RuntimeRecordList
      records={[CHAT_RUN]}
      ariaLabel="Runs"
      formatTime={formatTime}
      loadThreadRecords={async () => {
        throw new Error("offline");
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Open the conversation/ }));
  expect(await screen.findByText("The conversation could not be loaded. Try again in a moment.")).toBeInTheDocument();
});

test("Escape closes the conversation", async () => {
  render(<RuntimeRecordList records={[CHAT_RUN]} ariaLabel="Runs" formatTime={formatTime} loadThreadRecords={async () => []} />);
  fireEvent.click(screen.getByRole("button", { name: /Open the conversation/ }));
  await screen.findByRole("dialog");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("the run's exchange is the nearest one in time", () => {
  const records = [
    exchange("a", "2026-07-01T12:00:00Z", "a"),
    exchange("b", "2026-07-01T12:03:00Z", "b"),
    { ...exchange("c", "2026-07-01T12:04:00Z", "c"), created_at_iso: "not a date" },
  ];
  expect(nearestExchangeId(records, "2026-07-01T12:02:00Z")).toBe("b");
  expect(nearestExchangeId(records, "not a date")).toBeNull();
  expect(nearestExchangeId([], "2026-07-01T12:02:00Z")).toBeNull();
});
