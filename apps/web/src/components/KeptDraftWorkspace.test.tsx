import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { DraftSlot } from "../lib/draftSlots";
import { KeptDraftWorkspace } from "./KeptDraftWorkspace";

type Received = Record<string, unknown>;
const received: Received[] = [];

vi.mock("./DocumentAssistantWorkspace", () => ({
  DocumentAssistantWorkspace: (props: Received) => {
    received.push(props);
    return <button type="button">Workspace</button>;
  },
}));

const latest = () => received[received.length - 1];
const slot = (draftId: string | null = null): DraftSlot => ({ key: `0:${draftId ?? ""}`, draftId, session: 0, held: false });
const transfer = { id: "transfer-1", title: "Memo", content: "Body" } as never;
const handoff = { id: "handoff-1" } as never;

function props(overrides: Partial<Parameters<typeof KeptDraftWorkspace>[0]> = {}) {
  return {
    slot: slot(),
    parked: false,
    data: sampleData,
    initialDraft: transfer,
    initialRequest: handoff,
    onCloseDraft: vi.fn(),
    onNavigationGuardChange: vi.fn(),
    onWorkingChange: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  received.length = 0;
});

describe("KeptDraftWorkspace", () => {
  it("shows the workspace on screen with everything it opens with", () => {
    const given = props();
    render(<KeptDraftWorkspace {...given} />);

    expect(screen.getByRole("button", { name: "Workspace" })).toBeVisible();
    expect(latest()).toMatchObject({
      parked: false,
      initialDraft: transfer,
      initialRequest: handoff,
      initialServerDraftId: null,
      onCloseDraft: given.onCloseDraft,
      onNavigationGuardChange: given.onNavigationGuardChange,
    });
  });

  it("opens a saved draft by its id, without a transfer or a handed-over request", () => {
    render(<KeptDraftWorkspace {...props({ slot: slot("draft-7") })} />);

    expect(latest()).toMatchObject({ initialDraft: null, initialRequest: null, initialServerDraftId: "draft-7" });
  });

  it("takes a parked workspace out of reach while keeping it mounted", () => {
    const { container } = render(<KeptDraftWorkspace {...props({ parked: true })} />);

    const frame = container.querySelector(".draft-slot");
    expect(frame).toHaveAttribute("data-parked", "true");
    expect(frame).toHaveAttribute("inert");
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: "Workspace" })).not.toBeInTheDocument();
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("stops a parked workspace from steering the app", () => {
    render(<KeptDraftWorkspace {...props({ parked: true })} />);

    expect(latest()).toMatchObject({ parked: true, initialRequest: null });
    expect(latest().onCloseDraft).toBeUndefined();
    expect(latest().onNavigationGuardChange).toBeUndefined();
  });

  it("does not mark the workspace on screen as parked", () => {
    const { container } = render(<KeptDraftWorkspace {...props()} />);

    const frame = container.querySelector(".draft-slot");
    expect(frame).not.toHaveAttribute("data-parked");
    expect(frame).not.toHaveAttribute("inert");
    expect(frame).not.toHaveAttribute("aria-hidden");
  });

  it("keeps what the workspace opened with when a later transfer arrives", () => {
    const given = props();
    const { rerender } = render(<KeptDraftWorkspace {...given} />);

    rerender(<KeptDraftWorkspace {...given} initialDraft={{ id: "transfer-2" } as never} />);

    expect(latest().initialDraft).toBe(transfer);
  });

  it("reports the assistant's work under the workspace's own key", () => {
    const given = props({ slot: slot("draft-7") });
    render(<KeptDraftWorkspace {...given} />);

    (latest().onWorkingChange as (working: boolean) => void)(true);

    expect(given.onWorkingChange).toHaveBeenCalledWith("0:draft-7", true);
  });
});
