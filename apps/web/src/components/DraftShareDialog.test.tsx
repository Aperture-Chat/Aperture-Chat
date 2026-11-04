import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftSharing, ShareDirectory } from "../lib/api/draftCollab";
import { DraftShareDialog, matchingPeople } from "./DraftShareDialog";
import { DraftPresence, initialsOf, otherParticipants, presenceSentence } from "./DraftPresence";

const directory: ShareDirectory = {
  groups: [{ id: "group-lit", name: "Litigation", member_count: 4 }],
  people: [
    { id: "ben", display_name: "Ben Partner", email: "ben@example.test" },
    { id: "cy", display_name: "Cy Associate", email: "cy@example.test" },
  ],
  people_scope: "groups",
};

const directoryFor = vi.fn(async (): Promise<ShareDirectory> => directory);

vi.mock("../lib/api/draftCollab", () => ({
  getShareDirectory: () => directoryFor(),
}));

function sharing(overrides: Partial<DraftSharing> = {}): DraftSharing {
  return {
    draft_id: "draft-1",
    owner: { id: "ana", display_name: "Ana Owner", email: "ana@example.test" },
    role: "owner",
    can_manage: true,
    matter_bound: false,
    groups: [],
    people: [],
    ...overrides,
  };
}

function open(props: Partial<Parameters<typeof DraftShareDialog>[0]> = {}) {
  const onSave = vi.fn(async () => sharing());
  const onClose = vi.fn();
  render(
    <DraftShareDialog userId="ana" title="Memo" sharing={sharing()} onSave={onSave} onClose={onClose} {...props} />,
  );
  return { onSave, onClose };
}

afterEach(() => vi.clearAllMocks());

describe("DraftShareDialog", () => {
  it("starts private, and shares with the whole group in two clicks", async () => {
    const { onSave, onClose } = open();
    expect(await screen.findByText("Only you can open this draft. Nobody else can see it.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Only me" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: "My group" }));
    expect(screen.getByRole("switch", { name: "Share with everyone in Litigation" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save sharing" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ group_ids: ["group-lit"], user_ids: [] }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shares with specific people found by name, and asks for one first", async () => {
    const { onSave } = open();
    fireEvent.click(await screen.findByRole("radio", { name: "Specific people" }));
    expect(screen.getByRole("button", { name: "Save sharing" })).toBeDisabled();
    expect(screen.getByText("Add at least one person.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Add a person from your groups"), { target: { value: "cy" } });
    expect(screen.queryByRole("button", { name: "Add Ben Partner" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Cy Associate" }));
    fireEvent.click(screen.getByRole("button", { name: "Save sharing" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ group_ids: [], user_ids: ["cy"] }));
  });

  it("says why sharing failed and stays open", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("You can share only with your own groups and the people in them.");
    });
    const onClose = vi.fn();
    render(<DraftShareDialog userId="ana" title="Memo" sharing={sharing({ people: [directory.people[0]] })} onSave={onSave} onClose={onClose} />);
    expect(await screen.findByRole("button", { name: "Remove Ben Partner" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save sharing" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You can share only with your own groups");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a collaborator who has access and who decides it", () => {
    open({ sharing: sharing({ role: "collaborator", can_manage: false, groups: directory.groups }) });
    expect(screen.getByText("Ana Owner shared this draft with you. Everyone in Litigation can open and edit it.")).toBeInTheDocument();
    expect(screen.getByText("Only Ana Owner can change who has access.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save sharing" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
  });

  it("waits for the account save, and says when it failed", () => {
    const { unmount } = render(
      <DraftShareDialog userId="ana" title="" sharing={null} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saving this draft to your account");
    expect(screen.getByRole("heading")).toHaveTextContent("Share “this draft”");
    unmount();
    render(<DraftShareDialog userId="ana" title="Memo" sharing={null} waitingMessage="Server save failed." onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Server save failed.");
  });

  it("notes the matter wall when a matter draft is shared", async () => {
    open({ sharing: sharing({ matter_bound: true }) });
    fireEvent.click(await screen.findByRole("radio", { name: "My group" }));
    expect(screen.getByText("This draft belongs to a matter, so only people on that matter can open it.")).toBeInTheDocument();
  });
});

describe("DraftShareDialog people list", () => {
  it("lists everyone the person may add as soon as Specific people is chosen", async () => {
    const many = Array.from({ length: 40 }, (_, n) => ({
      id: `user-${n}`,
      display_name: `Person ${String(n).padStart(2, "0")}`,
      email: `p${n}@example.test`,
    }));
    directoryFor.mockResolvedValueOnce({ groups: [], people: many, people_scope: "groups" });
    open();
    fireEvent.click(await screen.findByRole("radio", { name: "Specific people" }));

    expect(screen.getAllByRole("button", { name: /^Add Person/ })).toHaveLength(40);
    expect(screen.getByLabelText("Add a person from your groups")).toBeInTheDocument();
  });

  it("says whose list it is for administrators and platform owners", async () => {
    directoryFor.mockResolvedValueOnce({ ...directory, people_scope: "organization" });
    const { unmount } = render(<DraftShareDialog userId="alex" title="Memo" sharing={sharing()} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Specific people" }));
    expect(screen.getByLabelText("Add a person from your organization")).toBeInTheDocument();
    unmount();

    directoryFor.mockResolvedValueOnce({ groups: [], people: [], people_scope: "everyone" });
    render(<DraftShareDialog userId="olive" title="Memo" sharing={sharing()} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Specific people" }));
    expect(screen.getByLabelText("Add a person")).toBeInTheDocument();
    expect(screen.getByText("There is nobody else to add yet.")).toBeInTheDocument();
  });
});

describe("matchingPeople", () => {
  it("matches every typed word against name or email, skipping people already added", () => {
    expect(matchingPeople(directory.people, [], "partner ben").map((p) => p.id)).toEqual(["ben"]);
    expect(matchingPeople(directory.people, ["ben"], "").map((p) => p.id)).toEqual(["cy"]);
    expect(matchingPeople(directory.people, [], "cy@example").map((p) => p.id)).toEqual(["cy"]);
  });
});

describe("DraftPresence", () => {
  const people = [
    { client_id: "c1", user_id: "ana", display_name: "Ana Owner", color: 1, focus: null },
    { client_id: "c2", user_id: "ben", display_name: "Ben Partner", color: 3, focus: null },
    { client_id: "c3", user_id: "ben", display_name: "Ben Partner", color: 3, focus: null },
    { client_id: "c4", user_id: "cy", display_name: "Cy", color: 5, focus: null },
  ];

  it("shows everyone else once, with a sentence for screen readers", () => {
    render(<DraftPresence participants={people} meId="ana" />);
    expect(screen.getByRole("group", { name: "Ben Partner and Cy are here" })).toBeInTheDocument();
    expect(Array.from(document.querySelectorAll(".draft-presence-chip"), (chip) => chip.textContent)).toEqual(["BP", "C"]);
  });

  it("shows nothing when nobody else is here", () => {
    const { container } = render(<DraftPresence participants={people.slice(0, 1)} meId="ana" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names people in plain words", () => {
    expect(otherParticipants(people, "ana").map((p) => p.client_id)).toEqual(["c2", "c4"]);
    expect(presenceSentence([])).toBe("");
    expect(presenceSentence(people.slice(1, 2))).toBe("Ben Partner is here");
    expect(presenceSentence([...people, { ...people[0], user_id: "dee", display_name: "Dee" }])).toBe(
      "Ana Owner, Ben Partner and 3 more are here",
    );
    expect(initialsOf("  ")).toBe("?");
    expect(initialsOf("mary jane watson")).toBe("MW");
  });
});
