import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData, ChatThread, Role } from "../lib/types";
import { AppShell, type ViewKey } from "./AppShell";

vi.mock("@remotion/player", async () => {
  const React = await import("react");

  return {
    Player: ({ inputProps }: { inputProps?: { video?: { title?: string } } }) =>
      React.createElement("div", { "data-testid": "remotion-player" }, inputProps?.video?.title ?? "Remotion player"),
  };
});


beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  vi.mocked(globalThis.fetch).mockReset();
});

test("account drawer shows profile and personal usage without user management", () => {
  const data = cloneData();
  data.me = {
    ...data.me,
    phone: "970.397.8816",
    firm_name: "Example Corporation Founder",
    bio: "I like building useful things.",
  };
  const threads = [
    {
      id: "thread-usage",
      tenant_id: "tenant-example",
      owner_user_id: "user-admin",
      title: "Usage thread",
      model_id: "openrouter-openai-gpt-4o-mini",
      group_id: "group-litigation",
      pinned: false,
      used_agent: false,
      updated_at: "Just now",
      messages: [
        { id: "msg-1", role: "user", content: "Review the draft.", createdAt: "9:00 AM", status: "ok" },
        { id: "msg-2", role: "assistant", content: "Draft reviewed.", createdAt: "9:01 AM", status: "ok" },
      ],
    },
  ] satisfies ChatThread[];

  renderShell(data, vi.fn(), vi.fn(), threads);
  fireEvent.click(screen.getByText("Alex Morgan"));

  expect(screen.getByText("Role")).toBeInTheDocument();
  expect(screen.getByText("Organization")).toBeInTheDocument();
  expect(screen.getByText("Auth method")).toBeInTheDocument();
  expect(screen.getByText("Usage this month")).toBeInTheDocument();
  expect(screen.getByText("prompts")).toBeInTheDocument();
  expect(screen.getByText("responses")).toBeInTheDocument();
  expect(screen.getByText("est. tokens")).toBeInTheDocument();
  const profileButton = screen.getByRole("button", { name: /Edit account profile for Alex Morgan/ });
  expect(profileButton).toBeInTheDocument();
  expect(within(profileButton).getByText("Email")).toBeInTheDocument();
  expect(within(profileButton).getByText("alex.morgan@example.com")).toBeInTheDocument();
  expect(within(profileButton).getByText("Phone")).toBeInTheDocument();
  expect(within(profileButton).getByText("970.397.8816")).toBeInTheDocument();
  expect(within(profileButton).getByText("Position")).toBeInTheDocument();
  expect(within(profileButton).getByText("Example Corporation Founder")).toBeInTheDocument();
  expect(within(profileButton).getByText("Bio")).toBeInTheDocument();
  expect(within(profileButton).getByText("I like building useful things.")).toBeInTheDocument();
  expect(screen.queryByText("Profile")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  expect(screen.queryByText("Admin user management")).not.toBeInTheDocument();
  expect(screen.queryByText("Connected to /api/admin/users.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
  // The only network call on open is the personal daily-token budget — the
  // honest per-user meter added with downstream budget allocations.
  const calledUrls = vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input]) => String(input));
  expect(calledUrls).toEqual(
    calledUrls.filter((url) => url.endsWith("/api/auth/me/usage-budget")),
  );
});

test("account drawer edits the signed-in user's profile", async () => {
  const onProfileUpdate = vi.fn().mockResolvedValue(undefined);

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [],
    null,
    vi.fn(),
    undefined,
    undefined,
    vi.fn(),
    vi.fn(),
    "chat",
    { onProfileUpdate },
  );
  fireEvent.click(screen.getByText("Alex Morgan"));
  fireEvent.click(screen.getByRole("button", { name: /Edit account profile/ }));

  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: "Taylor Example" },
  });
  fireEvent.change(screen.getByLabelText("Phone number"), {
    target: { value: "+1 555 0100" },
  });
  fireEvent.change(screen.getByLabelText("Firm or organization"), {
    target: { value: "Meridian Advisory LLP" },
  });
  fireEvent.change(screen.getByLabelText("Website"), {
    target: { value: "https://meridian.example.com" },
  });
  fireEvent.change(screen.getByLabelText("Profile photo URL"), {
    target: { value: "https://example.com/matthew.png" },
  });
  fireEvent.change(screen.getByLabelText("Bio"), {
    target: { value: "AI automation and legal workflow builder." },
  });
  const saveProfileButton = screen.getByRole("button", { name: /Save profile/ });
  expect(saveProfileButton).toHaveClass("account-form-submit-button");
  expect(saveProfileButton.querySelector(".stable-label")).toBeNull();
  fireEvent.click(saveProfileButton);

  await waitFor(() =>
    expect(onProfileUpdate).toHaveBeenCalledWith({
      display_name: "Taylor Example",
      firm_name: "Meridian Advisory LLP",
      website_url: "https://meridian.example.com",
      phone: "+1 555 0100",
      avatar_url: "https://example.com/matthew.png",
      bio: "AI automation and legal workflow builder.",
    }),
  );
  expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
});

test("API-enabled users can create a one-time key from the account drawer", async () => {
  const data = cloneData();
  const jane = data.users.find((user) => user.id === "user-jane")!;
  data.me = jane;
  data.groups = data.groups.map((group) =>
    group.id === "group-litigation"
      ? { ...group, permissions: { ...group.permissions, api_access: true } }
      : group,
  );
  const onApiKeyLoad = vi.fn().mockResolvedValue({ enabled: true, has_key: false });
  const onApiKeyCreate = vi.fn().mockResolvedValue({
    enabled: true,
    has_key: true,
    masked_value: "apt_example••••••••1234",
    created_at: "2026-07-11T20:00:00Z",
    last_used_at: null,
    secret_value: "apt_example-personal-secret-1234",
  });

  renderShell(
    data,
    vi.fn(),
    vi.fn(),
    [],
    null,
    vi.fn(),
    "USER",
    undefined,
    vi.fn(),
    vi.fn(),
    "chat",
    { onApiKeyLoad, onApiKeyCreate },
  );
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));

  const apiDetails = screen.getByText("API access").closest("details");
  expect(apiDetails).not.toBeNull();
  expect(apiDetails).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("API access"));
  expect(apiDetails).toHaveAttribute("open");
  expect(await screen.findByDisplayValue(`${window.location.origin}/v1`)).toBeInTheDocument();
  expect(onApiKeyLoad).toHaveBeenCalledTimes(1);
  const createButton = screen.getByRole("button", { name: "Create key" });
  expect(createButton).toHaveClass("account-api-action-button");
  fireEvent.click(createButton);

  expect(await screen.findByDisplayValue("apt_example-personal-secret-1234")).toBeInTheDocument();
  expect(screen.getByText(/shown only once/i)).toBeInTheDocument();
  expect(onApiKeyCreate).toHaveBeenCalledTimes(1);
});

test("account drawer omits API access while the admin permission is off", async () => {
  const onApiKeyLoad = vi.fn().mockResolvedValue({ enabled: false, has_key: false });

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [],
    null,
    vi.fn(),
    "PLATFORM_OWNER",
    undefined,
    vi.fn(),
    vi.fn(),
    "chat",
    { onApiKeyLoad },
  );
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));

  await waitFor(() => expect(onApiKeyLoad).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("API access")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create key" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Platform API URL")).not.toBeInTheDocument();
});

test("platform owners see API access from the organization policy without a group grant", () => {
  const data = cloneData();
  data.me = {
    ...data.me,
    role: "PLATFORM_OWNER",
    group_ids: [],
  };
  data.platformSettings = {
    ...data.platformSettings!,
    downstream_api_enabled: true,
  };

  renderShell(data, vi.fn(), vi.fn(), [], null, vi.fn(), "PLATFORM_OWNER");
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));

  expect(screen.getByText("API access")).toBeInTheDocument();
  expect(screen.getByText("OpenAI-compatible access")).toBeInTheDocument();
});

test("account drawer rejects uploaded profile photos over five megabytes", () => {
  const onProfileUpdate = vi.fn().mockResolvedValue(undefined);

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [],
    null,
    vi.fn(),
    undefined,
    undefined,
    vi.fn(),
    vi.fn(),
    "chat",
    { onProfileUpdate },
  );
  fireEvent.click(screen.getByText("Alex Morgan"));
  fireEvent.click(screen.getByRole("button", { name: /Edit account profile/ }));

  expect(screen.getByText("Image files up to 5 MB.")).toBeInTheDocument();
  const oversizedFile = new File([new Uint8Array((5 * 1024 * 1024) + 1)], "large-profile.png", {
    type: "image/png",
  });
  fireEvent.change(screen.getByLabelText("Upload photo"), {
    target: { files: [oversizedFile] },
  });

  expect(screen.getByText("Choose a profile photo that is 5 MB or smaller.")).toBeInTheDocument();
  expect(onProfileUpdate).not.toHaveBeenCalled();
});

test("local account drawer can submit a password update", async () => {
  const ownerData = cloneData();
  ownerData.me = ownerData.users.find((user) => user.id === "user-owner") ?? ownerData.me;
  const onPasswordUpdate = vi.fn().mockResolvedValue(undefined);

  renderShell(
    ownerData,
    vi.fn(),
    vi.fn(),
    [],
    null,
    vi.fn(),
    "PLATFORM_OWNER",
    undefined,
    vi.fn(),
    vi.fn(),
    "chat",
    { onPasswordUpdate },
  );
  fireEvent.click(screen.getByText("Aperture Platform Owner"));
  expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  const passwordCard = screen.getByText("Password").closest(".account-password-card");
  expect(passwordCard).not.toBeNull();
  expect(passwordCard).toHaveClass("is-compact");
  expect(within(passwordCard as HTMLElement).getByText("Local account")).toBeInTheDocument();
  expect(
    within(passwordCard as HTMLElement).queryByText(/Use the edit button/),
  ).not.toBeInTheDocument();
  fireEvent.click(within(passwordCard as HTMLElement).getByRole("button", { name: "Edit" }));
  expect(passwordCard).toHaveClass("is-editing");
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "old-password-123" },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "new-password-123" },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: "new-password-123" },
  });
  const updatePasswordButton = screen.getByRole("button", { name: /Update password/ });
  expect(updatePasswordButton).toHaveClass("account-form-submit-button");
  expect(updatePasswordButton.querySelector(".stable-label")).toBeNull();
  fireEvent.click(updatePasswordButton);

  await waitFor(() =>
    expect(onPasswordUpdate).toHaveBeenCalledWith({
      current_password: "old-password-123",
      new_password: "new-password-123",
    }),
  );
  expect(await screen.findByText("Password updated.")).toBeInTheDocument();
});

test("tenant icon url drives the sidebar mark before logo url", () => {
  const data = cloneData();
  data.currentTenant.icon_url = "/tenant-icon.svg";
  data.currentTenant.logo_url = "/tenant-logo.svg";

  renderShell(data);

  const logo = screen.getByLabelText("Aperture Chat");
  const mark = logo.querySelector<HTMLImageElement>("img.custom-logo-mark");
  expect(mark).toBeInTheDocument();
  expect(mark).toHaveAttribute("src", "/tenant-icon.svg");
});

test("account drawer sign out action calls the provided callback", () => {
  const onSignOut = vi.fn();

  renderShell(cloneData(), vi.fn(), vi.fn(), [], null, vi.fn(), undefined, onSignOut);
  fireEvent.click(screen.getByText("Alex Morgan"));
  fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));

  expect(onSignOut).toHaveBeenCalledTimes(1);
});

test("admins can preview the regular user workspace from account settings", () => {
  const data = cloneData();
  const onViewAsRoleChange = vi.fn();

  renderShell(data, vi.fn(), vi.fn(), [], null, onViewAsRoleChange);
  fireEvent.click(screen.getByText("Alex Morgan"));

  const previewGroup = screen.getByRole("group", { name: "Preview role" });
  expect(within(previewGroup).getByRole("button", { name: "Admin" })).toHaveAttribute("aria-pressed", "true");
  expect(within(previewGroup).getByRole("button", { name: "User" })).toBeInTheDocument();
  expect(within(previewGroup).queryByRole("button", { name: "Platform admin" })).not.toBeInTheDocument();

  fireEvent.click(within(previewGroup).getByRole("button", { name: "User" }));
  expect(onViewAsRoleChange).toHaveBeenCalledWith("USER");
});

test("user preview hides admin console entry points while keeping a way back to admin", () => {
  const data = cloneData();
  data.me = { ...data.me, role: "USER" };
  const onViewAsRoleChange = vi.fn();

  renderShell(data, vi.fn(), vi.fn(), [], "USER", onViewAsRoleChange, "TENANT_ADMIN");

  const primaryNav = screen.getByRole("navigation", { name: "Primary" });
  expect(within(primaryNav).queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();
  expect(within(primaryNav).queryByRole("button", { name: "Platform" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("Alex Morgan"));
  const previewGroup = screen.getByRole("group", { name: "Preview role" });
  expect(within(previewGroup).getByRole("button", { name: "User" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(previewGroup).getByRole("button", { name: "Admin" }));
  expect(onViewAsRoleChange).toHaveBeenCalledWith(null);
});

test("platform owners can preview admin and user workspaces", () => {
  const ownerData = cloneData();
  ownerData.me = ownerData.users.find((user) => user.id === "user-owner") ?? ownerData.me;
  const onViewAsRoleChange = vi.fn();

  renderShell(ownerData, vi.fn(), vi.fn(), [], null, onViewAsRoleChange, "PLATFORM_OWNER");
  fireEvent.click(screen.getByText("Aperture Platform Owner"));

  const previewGroup = screen.getByRole("group", { name: "Preview role" });
  expect(within(previewGroup).getByRole("button", { name: "Platform admin" })).toHaveAttribute("aria-pressed", "true");
  expect(within(previewGroup).getByRole("button", { name: "Admin" })).toBeInTheDocument();
  expect(within(previewGroup).getByRole("button", { name: "User" })).toBeInTheDocument();

  fireEvent.click(within(previewGroup).getByRole("button", { name: "Admin" }));
  expect(onViewAsRoleChange).toHaveBeenCalledWith("TENANT_ADMIN");
});

test("regular users do not see admin or platform entry points", () => {
  const data = cloneData();
  data.me = data.users.find((user) => user.id === "user-jane") ?? data.me;

  renderShell(data);

  const primaryNav = screen.getByRole("navigation", { name: "Primary" });
  expect(within(primaryNav).queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();
  expect(within(primaryNav).queryByRole("button", { name: "Platform" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Preferences" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  const accountDrawer = screen.getByRole("dialog", { name: "Account" });
  expect(within(accountDrawer).queryByRole("button", { name: /console/ })).not.toBeInTheDocument();
});

test("admins reach their console from the account drawer instead of the rail", () => {
  const adminData = cloneData();
  const adminViewChange = vi.fn();
  renderShell(adminData, adminViewChange);

  const primaryNav = screen.getByRole("navigation", { name: "Primary" });
  expect(within(primaryNav).queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();
  expect(within(primaryNav).queryByRole("button", { name: "Platform" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Alex Morgan"));
  const accountDrawer = screen.getByRole("dialog", { name: "Account" });
  const managementDetails = within(accountDrawer).getByText("Management").closest("details");
  expect(managementDetails).not.toBeNull();
  expect(managementDetails).not.toHaveAttribute("open");
  fireEvent.click(within(accountDrawer).getByText("Management"));
  expect(managementDetails).toHaveAttribute("open");
  expect(within(accountDrawer).getByRole("button", { name: /Admin console/ })).toBeInTheDocument();
  expect(within(accountDrawer).queryByRole("button", { name: /Platform owner console/ })).not.toBeInTheDocument();
  fireEvent.click(within(accountDrawer).getByRole("button", { name: /Admin console/ }));
  expect(adminViewChange).toHaveBeenCalledWith("admin");
});

test("platform owners reach both management consoles from the account drawer", () => {
  const ownerData = cloneData();
  ownerData.me = ownerData.users.find((user) => user.id === "user-owner") ?? ownerData.me;
  const ownerViewChange = vi.fn();
  renderShell(ownerData, ownerViewChange);

  const primaryNav = screen.getByRole("navigation", { name: "Primary" });
  expect(within(primaryNav).queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();
  expect(within(primaryNav).queryByRole("button", { name: "Platform" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Aperture Platform Owner"));
  const accountDrawer = screen.getByRole("dialog", { name: "Account" });
  expect(within(accountDrawer).getByRole("button", { name: /Admin console/ })).toBeInTheDocument();
  fireEvent.click(within(accountDrawer).getByRole("button", { name: /Platform owner console/ }));
  expect(ownerViewChange).toHaveBeenCalledWith("platform");
});

test("New chat stays a primary action while Chats reveals independent organization sections", () => {
  const onNewChat = vi.fn();
  const onViewChange = vi.fn();
  renderShell(cloneData(), onViewChange, onNewChat);

  const primaryNav = screen.getByRole("navigation", { name: "Primary" });
  fireEvent.click(within(primaryNav).getByRole("button", { name: "New chat" }));

  expect(onNewChat).toHaveBeenCalledTimes(1);
  expect(onViewChange).not.toHaveBeenCalledWith("chat");

  const libraryButton = within(primaryNav).getByRole("button", { name: "Knowledge/Tools" });
  const chatsButton = screen.getByRole("button", { name: "Chats" });
  expect(libraryButton.compareDocumentPosition(chatsButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  expect(chatsButton).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Folders" })).not.toBeInTheDocument();

  fireEvent.click(chatsButton);

  expect(chatsButton).toHaveAttribute("aria-expanded", "true");
  const foldersButton = screen.getByRole("button", { name: "Folders" });
  const pinnedButton = screen.getByRole("button", { name: "Pinned" });
  const recentButton = screen.getByRole("button", { name: "Recent" });
  expect(foldersButton).toHaveAttribute("aria-expanded", "false");
  expect(pinnedButton).toHaveAttribute("aria-expanded", "false");
  expect(recentButton).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("No folders yet.")).not.toBeInTheDocument();

  fireEvent.click(foldersButton);
  expect(foldersButton).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("No folders yet.")).toBeInTheDocument();
  expect(pinnedButton).toHaveAttribute("aria-expanded", "false");
  expect(recentButton).toHaveAttribute("aria-expanded", "false");
});

test("draft mode hides the disabled sidebar expand control", () => {
  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [],
    null,
    vi.fn(),
    "TENANT_ADMIN",
    undefined,
    vi.fn(),
    vi.fn(),
    "drafts",
  );

  expect(screen.queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
});

test("mobile navigation uses only the menu control and hides desktop collapse", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 462 });
  const { container } = renderShell(cloneData());

  const menuButton = screen.getByRole("button", { name: "Open menu" });
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
  expect((container.querySelector(".app") as HTMLElement).style.getPropertyValue("--app-content-left")).toBe("0px");

  fireEvent.click(menuButton);

  expect(screen.getAllByRole("button", { name: "Close menu" }).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
});

test("desktop shell exposes the visible sidebar boundary for fixed notices", () => {
  const { container } = renderShell(cloneData());

  expect((container.querySelector(".app") as HTMLElement).style.getPropertyValue("--app-content-left")).toBe("226px");
});

test("sidebar chats can be archived and moved into a folder", () => {
  const onArchiveThread = vi.fn();
  const onMoveThreadToFolder = vi.fn();
  const thread = {
    id: "thread-contract",
    tenant_id: "tenant-example",
    owner_user_id: "user-admin",
    title: "Contract review",
    model_id: "openrouter-openai-gpt-4o-mini",
    group_id: "group-litigation",
    pinned: false,
    used_agent: false,
    updated_at: "Just now",
    messages: [{ id: "msg-1", role: "user", content: "Review this.", createdAt: "9:00 AM", status: "ok" }],
  } satisfies ChatThread;

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [thread],
    null,
    vi.fn(),
    "TENANT_ADMIN",
    undefined,
    onArchiveThread,
    onMoveThreadToFolder,
  );

  fireEvent.click(screen.getByRole("button", { name: "Chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Folders" }));

  fireEvent.click(screen.getByRole("button", { name: "Create chat folder" }));
  fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Matter folders" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  fireEvent.click(screen.getByLabelText("Add Contract review to a folder"));
  fireEvent.click(screen.getByRole("button", { name: "Matter folders" }));
  expect(onMoveThreadToFolder).toHaveBeenCalledWith("thread-contract", expect.stringMatching(/^folder-/));

  fireEvent.click(screen.getByLabelText("Archive Contract review"));
  expect(onArchiveThread).toHaveBeenCalledWith("thread-contract");
});

test("sidebar folders can be deleted and their chats move back to recent", () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const folder = {
    id: "folder-client",
    name: "Client folder",
    created_at: "2026-06-29T00:00:00.000Z",
  };
  window.localStorage.setItem("aperture-chat-folders-user-admin", JSON.stringify([folder]));
  const onMoveThreadToFolder = vi.fn();
  const thread = shellThread("thread-client", "Client matter", {
    folder_id: "folder-client",
  });

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [thread],
    null,
    vi.fn(),
    "TENANT_ADMIN",
    undefined,
    vi.fn(),
    onMoveThreadToFolder,
  );

  fireEvent.click(screen.getByRole("button", { name: "Chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Folders" }));

  expect(screen.getByText("Client folder")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Delete Client folder folder"));

  expect(confirmSpy).toHaveBeenCalledWith(
    'Delete "Client folder"? Chats in this folder will stay in Recent.',
  );
  expect(onMoveThreadToFolder).toHaveBeenCalledWith("thread-client", null);
  expect(screen.queryByText("Client folder")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  expect(screen.getByText("Client matter")).toBeInTheDocument();
});

test("sidebar caps folders, pinned chats, and recent chats behind view-all drawers", () => {
  const folders = Array.from({ length: 5 }, (_, index) => ({
    id: `folder-${index + 1}`,
    name: `Matter folder ${index + 1}`,
    created_at: "2026-06-29T00:00:00.000Z",
  }));
  window.localStorage.setItem("aperture-chat-folders-user-admin", JSON.stringify(folders));
  const pinnedThreads = Array.from({ length: 4 }, (_, index) =>
    shellThread(`pinned-${index + 1}`, `Pinned matter ${index + 1}`, { pinned: true }),
  );
  const recentThreads = Array.from({ length: 5 }, (_, index) =>
    shellThread(`recent-${index + 1}`, `Recent matter ${index + 1}`),
  );

  renderShell(cloneData(), vi.fn(), vi.fn(), [...pinnedThreads, ...recentThreads]);

  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  fireEvent.click(within(sidebar).getByRole("button", { name: "Chats" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Folders" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Pinned" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Recent" }));
  expect(within(sidebar).getByText("Matter folder 1")).toBeInTheDocument();
  expect(within(sidebar).getByText("Matter folder 3")).toBeInTheDocument();
  expect(within(sidebar).queryByText("Matter folder 4")).not.toBeInTheDocument();
  expect(within(sidebar).getByRole("button", { name: "View all folders" })).toBeInTheDocument();

  expect(within(sidebar).getByText("Pinned matter 1")).toBeInTheDocument();
  expect(within(sidebar).getByText("Pinned matter 3")).toBeInTheDocument();
  expect(within(sidebar).queryByText("Pinned matter 4")).not.toBeInTheDocument();
  expect(within(sidebar).getByRole("button", { name: "View all pinned" })).toBeInTheDocument();

  expect(within(sidebar).getByText("Recent matter 1")).toBeInTheDocument();
  expect(within(sidebar).getByText("Recent matter 4")).toBeInTheDocument();
  expect(within(sidebar).queryByText("Recent matter 5")).not.toBeInTheDocument();
  expect(within(sidebar).getByRole("button", { name: "View all chats" })).toBeInTheDocument();

  fireEvent.click(within(sidebar).getByRole("button", { name: "View all folders" }));
  expect(screen.getByRole("dialog", { name: "All folders" })).toBeInTheDocument();
  expect(screen.getByText("Matter folder 5")).toBeInTheDocument();
});

test("folders nest as subfolders and a subtree delete returns chats to recent", () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const onMoveThreadToFolder = vi.fn();
  const thread = shellThread("thread-acme", "Acme kickoff", {
    folder_id: "folder-grand",
    messages: [
      { id: "acme-prompt", role: "user", content: "Prepare the kickoff.", createdAt: "9:00 AM", status: "ok" },
      { id: "acme-reply", role: "assistant", content: "Folder preview answer.", createdAt: "9:01 AM", status: "ok" },
    ],
  });

  // A seeded three-level tree exercises the stored parent_id load path.
  window.localStorage.setItem(
    "aperture-chat-folders-user-admin",
    JSON.stringify([
      { id: "folder-root", name: "Clients", created_at: "2026-06-29T00:00:00.000Z" },
      { id: "folder-child", name: "Acme", created_at: "2026-06-29T00:00:00.000Z", parent_id: "folder-root" },
      { id: "folder-grand", name: "2026 Matters", created_at: "2026-06-29T00:00:00.000Z", parent_id: "folder-child" },
    ]),
  );

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [thread],
    null,
    vi.fn(),
    "TENANT_ADMIN",
    undefined,
    vi.fn(),
    onMoveThreadToFolder,
  );

  fireEvent.click(screen.getByRole("button", { name: "Chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Folders" }));

  // Subfolders stay hidden until their parent expands; the root badge counts
  // every chat in the subtree, not only direct children.
  expect(screen.getByRole("button", { name: "Clients 1" })).toBeInTheDocument();
  expect(screen.queryByText("Acme")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clients 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Acme 1" }));
  fireEvent.click(screen.getByRole("button", { name: "2026 Matters 1" }));
  const folderChat = screen.getByRole("button", { name: "Acme kickoff" });
  fireEvent.focus(folderChat);
  expect(within(document.querySelector(".chat-hover-preview") as HTMLElement).getByText("Folder preview answer.")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });

  // New subfolders can be created at any level up to the depth cap.
  fireEvent.click(screen.getByLabelText("Create subfolder in Clients"));
  fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Beta Corp" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("button", { name: "Beta Corp 0" })).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Create subfolder in 2026 Matters"));
  fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Archive" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("button", { name: "Archive 0" })).toBeInTheDocument();
  // The fourth level is the cap: no deeper subfolder control renders.
  expect(screen.queryByLabelText("Create subfolder in Archive")).not.toBeInTheDocument();

  const stored = JSON.parse(
    window.localStorage.getItem("aperture-chat-folders-user-admin") ?? "[]",
  ) as Array<{ name: string; parent_id?: string | null }>;
  expect(stored.find((folder) => folder.name === "Beta Corp")?.parent_id).toBe("folder-root");
  expect(stored.find((folder) => folder.name === "Archive")?.parent_id).toBe("folder-grand");

  // Deleting the root removes the whole subtree and frees its chats.
  fireEvent.click(screen.getByLabelText("Delete Clients folder"));
  expect(confirmSpy).toHaveBeenCalledWith(
    'Delete "Clients" and its 4 subfolders? Chats in them will stay in Recent.',
  );
  expect(onMoveThreadToFolder).toHaveBeenCalledWith("thread-acme", null);
  expect(screen.queryByText("Clients")).not.toBeInTheDocument();
  expect(
    JSON.parse(window.localStorage.getItem("aperture-chat-folders-user-admin") ?? "[]"),
  ).toEqual([]);
});

test("pinned sidebar rows keep the persistent action fade state", () => {
  const pinnedThread = shellThread(
    "pinned-long-title",
    "Create me a sonnet and make it significantly longer",
    { pinned: true },
  );

  renderShell(cloneData(), vi.fn(), vi.fn(), [pinnedThread]);

  fireEvent.click(screen.getByRole("button", { name: "Chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Pinned" }));

  const row = screen.getByText(pinnedThread.title).closest(".chat-row");
  expect(row).toHaveClass("is-pinned");
  expect(within(row as HTMLElement).getByRole("button", { name: "Unpin chat" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("chat previews show every prompt and output, reset to the top, and omit thinking traces", () => {
  const previewThread = shellThread("thread-rich-preview", "Rich preview", {
    messages: [
      {
        id: "preview-prompt",
        role: "user",
        content: "Summarize the launch plan with a visual.",
        createdAt: "9:00 AM",
        status: "ok",
      },
      {
        id: "preview-response",
        role: "assistant",
        content:
          '<think>Compare every internal option before answering.</think>\n\n## Launch plan\nShip the verified path. [Read more](https://example.com)\n\n![Launch chart](/api/chat/generated-images/launch.png "Launch chart")\n\n```mermaid\nflowchart LR\n  Build --> Verify\n```',
        createdAt: "9:01 AM",
        status: "ok",
      },
      {
        id: "preview-follow-up",
        role: "user",
        content: "What should happen after verification?",
        createdAt: "9:02 AM",
        status: "ok",
      },
      {
        id: "preview-follow-up-response",
        role: "assistant",
        content: "<thinking>Keep this planning trace private.</thinking>\n\nRelease the verified build, then monitor health.",
        createdAt: "9:03 AM",
        status: "ok",
      },
    ],
  });

  renderShell(cloneData(), vi.fn(), vi.fn(), [previewThread]);
  fireEvent.click(screen.getByRole("button", { name: "Chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  const trigger = screen.getByRole("button", { name: "Rich preview" });
  fireEvent.focus(trigger);

  const preview = document.querySelector(".chat-hover-preview") as HTMLElement;
  const scroll = preview.querySelector(".chat-hover-preview-scroll") as HTMLDivElement;
  expect(preview).toBeInTheDocument();
  expect(within(preview).getByText("Prompt 1")).toBeInTheDocument();
  expect(within(preview).getByText("Output 1")).toBeInTheDocument();
  expect(within(preview).getByText("Prompt 2")).toBeInTheDocument();
  expect(within(preview).getByText("Output 2")).toBeInTheDocument();
  expect(within(preview).getByText("Launch plan")).toBeInTheDocument();
  expect(within(preview).getByText("What should happen after verification?")).toBeInTheDocument();
  expect(within(preview).getByText("Release the verified build, then monitor health.")).toBeInTheDocument();
  expect(within(preview).getByAltText("Launch chart")).toBeInTheDocument();
  expect(preview.querySelector(".md-diagram-panel")).toBeInTheDocument();
  expect(preview.querySelector(".chat-hover-preview-meta")).toHaveTextContent("Visuals in chat");
  expect(within(preview).queryByText(/Compare every internal option/)).not.toBeInTheDocument();
  expect(within(preview).queryByText(/Keep this planning trace private/)).not.toBeInTheDocument();
  expect(within(preview).queryByRole("button")).not.toBeInTheDocument();
  expect(within(preview).queryByRole("link")).not.toBeInTheDocument();

  scroll.scrollTop = 240;
  expect(preview.querySelectorAll(".chat-hover-preview-scroll")).toHaveLength(1);
  expect(preview.querySelector(".chat-hover-preview-scrollbar")).not.toBeInTheDocument();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.querySelector(".chat-hover-preview")).not.toBeInTheDocument();
  fireEvent.focus(trigger);
  expect((document.querySelector(".chat-hover-preview-scroll") as HTMLDivElement).scrollTop).toBe(0);
});

test("chat previews open after a deliberate hover delay and stay closed for a passing pointer", () => {
  vi.useFakeTimers();
  try {
    const previewThread = shellThread("thread-hover-preview", "Hover preview", {
      messages: [
        { id: "hover-prompt", role: "user", content: "What is this chat about?", createdAt: "9:00 AM", status: "ok" },
        { id: "hover-response", role: "assistant", content: "A concise hover summary.", createdAt: "9:01 AM", status: "ok" },
      ],
    });

    renderShell(cloneData(), vi.fn(), vi.fn(), [previewThread]);
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    const trigger = screen.getByRole("button", { name: "Hover preview" });

    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(419));
    expect(document.querySelector(".chat-hover-preview")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(within(document.querySelector(".chat-hover-preview") as HTMLElement).getByText("A concise hover summary.")).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(140));
    expect(document.querySelector(".chat-hover-preview")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("the same chat preview is available in all-chat and archive listings", () => {
  const activeThreads = Array.from({ length: 5 }, (_, index) =>
    shellThread(`preview-active-${index + 1}`, `Preview active ${index + 1}`, {
      messages: [
        { id: `active-${index + 1}-prompt`, role: "user", content: `Question ${index + 1}`, createdAt: "9:00 AM", status: "ok" },
        { id: `active-${index + 1}-reply`, role: "assistant", content: `Answer ${index + 1}`, createdAt: "9:01 AM", status: "ok" },
      ],
    }),
  );
  const archivedThread = shellThread("preview-archived", "Preview archived", {
    archived: true,
    messages: [
      { id: "archived-prompt", role: "user", content: "Archived question", createdAt: "8:00 AM", status: "ok" },
      { id: "archived-reply", role: "assistant", content: "Archived answer", createdAt: "8:01 AM", status: "ok" },
    ],
  });

  renderShell(cloneData(), vi.fn(), vi.fn(), [...activeThreads, archivedThread]);
  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  fireEvent.click(within(sidebar).getByRole("button", { name: "Chats" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Recent" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "View all chats" }));

  const allChats = screen.getByRole("dialog", { name: "All chats" });
  fireEvent.focus(within(allChats).getByRole("button", { name: "Preview active 1" }));
  expect(within(document.querySelector(".chat-hover-preview") as HTMLElement).getByText("Answer 1")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(within(allChats).getByRole("button", { name: "Close" }));

  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  fireEvent.click(screen.getByRole("button", { name: "View (1)" }));
  const archivedSummary = screen.getByText("Preview archived").closest(".account-archived-summary") as HTMLElement;
  fireEvent.focus(archivedSummary);
  expect(within(document.querySelector(".chat-hover-preview") as HTMLElement).getByText("Archived answer")).toBeInTheDocument();
});

function shellThread(id: string, title: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    tenant_id: "tenant-example",
    owner_user_id: "user-admin",
    title,
    model_id: "openrouter-openai-gpt-4o-mini",
    group_id: "group-litigation",
    pinned: false,
    archived: false,
    folder_id: null,
    used_agent: false,
    updated_at: "Just now",
    messages: [{ id: `${id}-msg`, role: "user", content: title, createdAt: "9:00 AM", status: "ok" }],
    ...overrides,
  };
}

test("account drawer archived section restores and permanently deletes chats", () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const onRestoreThread = vi.fn();
  const onDeleteThread = vi.fn();
  const archivedThread = shellThread("thread-archived", "Archived matter", { archived: true });

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [archivedThread],
    null,
    vi.fn(),
    "TENANT_ADMIN",
    undefined,
    vi.fn(),
    vi.fn(),
    "chat",
    { onRestoreThread, onDeleteThread },
  );
  fireEvent.click(screen.getByText("Alex Morgan"));

  expect(screen.getByText("Archived chats")).toBeInTheDocument();
  expect(screen.queryByText("Archived matter")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "View (1)" }));
  expect(screen.getByText("Archived matter")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Restore Archived matter" }));
  expect(onRestoreThread).toHaveBeenCalledWith("thread-archived");

  fireEvent.click(screen.getByRole("button", { name: "Permanently delete Archived matter" }));
  expect(confirmSpy).toHaveBeenCalledWith(
    'Permanently delete "Archived matter"? This removes the full conversation and cannot be undone.',
  );
  expect(onDeleteThread).toHaveBeenCalledWith("thread-archived");
  confirmSpy.mockRestore();
});

test("help drawer lists the user guide playlist and opens a walkthrough", async () => {
  renderShell(cloneData());
  fireEvent.click(screen.getByRole("button", { name: "Help" }));

  expect(await screen.findByText("Start chatting")).toBeInTheDocument();
  expect(screen.getByText("Follow the work trace")).toBeInTheDocument();
  expect(screen.getByText("Composer symbol shortcuts")).toBeInTheDocument();
  expect(screen.getByText("Attach files and sources")).toBeInTheDocument();
  expect(screen.getByText("Knowledge, Web, Agent, and reasoning")).toBeInTheDocument();
  expect(screen.getByText("Session details and context")).toBeInTheDocument();
  expect(screen.getByText("Draft documents")).toBeInTheDocument();
  expect(screen.getByText("Agent profiles")).toBeInTheDocument();
  expect(screen.getByText("Knowledge bases")).toBeInTheDocument();
  expect(screen.getByText("Tools and the Library")).toBeInTheDocument();
  expect(screen.getByText("Scheduled automations")).toBeInTheDocument();
  expect(screen.getByText("Preview chats at a glance")).toBeInTheDocument();
  expect(screen.getByText("Hover any listed chat to read its prompts and outputs in a compact, scrollable preview.")).toBeInTheDocument();
  expect(screen.getByText("Personalization memory")).toBeInTheDocument();
  expect(
    screen.getByText("Save preferences in plain English, recall them in later sessions, and stay in control."),
  ).toBeInTheDocument();
  expect(screen.getByText("Organize and find your work")).toBeInTheDocument();

  const guidePdf = screen.getByRole("link", { name: /User guide \(PDF\)/ });
  expect(guidePdf).toHaveAttribute("href", "docs/aperture-user-guide.pdf");
  expect(guidePdf).toHaveAttribute("download");

  fireEvent.click(screen.getByRole("button", { name: /^Preview chats at a glance/ }));
  const dialog = await screen.findByRole("dialog", { name: "Preview chats at a glance" });
  expect(within(dialog).getByTestId("remotion-player")).toBeInTheDocument();
  expect(within(dialog).getByText("Transcript")).toBeInTheDocument();
  expect(within(dialog).getByText("Preview opened")).toBeInTheDocument();
  expect(within(dialog).getByText("Quick reference")).toBeInTheDocument();
});

function renderShell(
  data: BootstrapData,
  onViewChange = vi.fn(),
  onNewChat = vi.fn(),
  threads: ChatThread[] = [],
  viewAsRole: Role | null = null,
  onViewAsRoleChange = vi.fn(),
  actualRole: Role = data.me.role,
  onSignOut?: () => void,
  onArchiveThread = vi.fn(),
  onMoveThreadToFolder = vi.fn(),
  currentView: ViewKey = "chat",
  accountHandlers: {
    onProfileUpdate?: ComponentProps<typeof AppShell>["onProfileUpdate"];
    onPasswordUpdate?: ComponentProps<typeof AppShell>["onPasswordUpdate"];
    onApiKeyLoad?: ComponentProps<typeof AppShell>["onApiKeyLoad"];
    onApiKeyCreate?: ComponentProps<typeof AppShell>["onApiKeyCreate"];
    onApiKeyRevoke?: ComponentProps<typeof AppShell>["onApiKeyRevoke"];
    onRestoreThread?: (id: string) => void;
    onDeleteThread?: (id: string) => void;
    onOpenChat?: (id: string) => void;
  } = {},
) {
  return render(
    <AppShell
      data={data}
      actualRole={actualRole}
      viewAsRole={viewAsRole}
      onViewAsRoleChange={onViewAsRoleChange}
      currentView={currentView}
      onViewChange={onViewChange}
      darkMode={false}
      onToggleDarkMode={vi.fn()}
      threads={threads}
      activeChatId="chat-new"
      onOpenChat={accountHandlers.onOpenChat ?? vi.fn()}
      onNewChat={onNewChat}
      onTogglePin={vi.fn()}
      onArchiveThread={onArchiveThread}
      onRestoreThread={accountHandlers.onRestoreThread ?? vi.fn()}
      onDeleteThread={accountHandlers.onDeleteThread ?? vi.fn()}
      onMoveThreadToFolder={onMoveThreadToFolder}
      onSignOut={onSignOut}
      onProfileUpdate={accountHandlers.onProfileUpdate}
      onPasswordUpdate={accountHandlers.onPasswordUpdate}
      onApiKeyLoad={accountHandlers.onApiKeyLoad}
      onApiKeyCreate={accountHandlers.onApiKeyCreate}
      onApiKeyRevoke={accountHandlers.onApiKeyRevoke}
    >
      <main>Workspace</main>
    </AppShell>,
  );
}

function cloneData(): BootstrapData {
  return structuredClone(sampleData) as BootstrapData;
}

test("Cmd/Ctrl+K opens conversation-first search and Escape closes it", () => {
  renderShell(cloneData());

  expect(screen.queryByRole("dialog", { name: "Search past work" })).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  const dialog = screen.getByRole("dialog", { name: "Search past work" });
  const input = within(dialog).getByRole("combobox");
  expect(input).toHaveFocus();
  expect(within(dialog).getByText("Find something from a previous conversation")).toBeInTheDocument();
  expect(within(dialog).getByText(/Archived chats are included/)).toBeInTheDocument();
  expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
  // Empty query never fires a search request.
  expect(globalThis.fetch).not.toHaveBeenCalled();

  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Search past work" })).not.toBeInTheDocument();
});

test("sidebar Search entry opens retrieval instead of duplicating page navigation", () => {
  renderShell(cloneData());

  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  const dialog = screen.getByRole("dialog", { name: "Search past work" });

  expect(within(dialog).getByPlaceholderText("Search chat titles and message text…")).toHaveFocus();
  expect(within(dialog).queryByRole("group", { name: "Go to" })).not.toBeInTheDocument();
});

test("palette chat results route through the shell's open-chat handler", async () => {
  const onOpenChat = vi.fn();
  vi.mocked(globalThis.fetch).mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          query: "pricing",
          sections: [
            {
              kind: "chat",
              title: "Chats",
              results: [
                {
                  id: "thread-pricing",
                  kind: "chat",
                  title: "Pricing analysis",
                  snippet: "…pricing follows the rate card…",
                  score: 5,
                  navigation: { view: "chat", thread_id: "thread-pricing" },
                  metadata: {},
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    [],
    null,
    vi.fn(),
    "TENANT_ADMIN",
    undefined,
    vi.fn(),
    vi.fn(),
    "chat",
    { onOpenChat },
  );

  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const dialog = screen.getByRole("dialog", { name: "Search past work" });
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "pricing" } });

  fireEvent.click(await within(dialog).findByRole("option", { name: /Pricing analysis/ }));

  expect(onOpenChat).toHaveBeenCalledWith("thread-pricing");
  expect(screen.queryByRole("dialog", { name: "Search past work" })).not.toBeInTheDocument();
});

test("all-chats drawer filter narrows threads by title without inventing results", () => {
  const recentThreads = Array.from({ length: 5 }, (_, index) =>
    shellThread(`recent-${index + 1}`, `Recent matter ${index + 1}`),
  );
  const pricingThread = shellThread("thread-pricing", "Pricing analysis");

  renderShell(cloneData(), vi.fn(), vi.fn(), [...recentThreads, pricingThread]);

  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  fireEvent.click(within(sidebar).getByRole("button", { name: "Chats" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Recent" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "View all chats" }));

  const drawerDialog = screen.getByRole("dialog", { name: "All chats" });
  const filterInput = within(drawerDialog).getByLabelText("Filter chats by title");
  expect(within(drawerDialog).getByText("Pricing analysis")).toBeInTheDocument();
  expect(within(drawerDialog).getByText("Recent matter 1")).toBeInTheDocument();

  fireEvent.change(filterInput, { target: { value: "pricing" } });
  expect(within(drawerDialog).getByText("Pricing analysis")).toBeInTheDocument();
  expect(within(drawerDialog).queryByText("Recent matter 1")).not.toBeInTheDocument();

  fireEvent.change(filterInput, { target: { value: "zzz" } });
  expect(within(drawerDialog).getByText("No chats match")).toBeInTheDocument();
  expect(within(drawerDialog).queryByText("Pricing analysis")).not.toBeInTheDocument();

  fireEvent.change(filterInput, { target: { value: "" } });
  expect(within(drawerDialog).getByText("Recent matter 5")).toBeInTheDocument();
});

test("all-chats drawer rows carry the same pin, archive, and folder actions as the sidebar", () => {
  const onArchiveThread = vi.fn();
  const onMoveThreadToFolder = vi.fn();
  const recentThreads = Array.from({ length: 5 }, (_, index) =>
    shellThread(`recent-${index + 1}`, `Recent matter ${index + 1}`),
  );

  renderShell(
    cloneData(),
    vi.fn(),
    vi.fn(),
    recentThreads,
    null,
    vi.fn(),
    "TENANT_ADMIN",
    undefined,
    onArchiveThread,
    onMoveThreadToFolder,
  );

  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  fireEvent.click(within(sidebar).getByRole("button", { name: "Chats" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Recent" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "View all chats" }));

  const drawerDialog = screen.getByRole("dialog", { name: "All chats" });
  expect(within(drawerDialog).getAllByRole("button", { name: "Pin chat" })).toHaveLength(5);

  fireEvent.click(within(drawerDialog).getByRole("button", { name: "Archive Recent matter 2" }));
  expect(onArchiveThread).toHaveBeenCalledWith("recent-2");

  // With no folders yet, the folder action starts folder creation in the
  // sidebar (same as the sidebar rows) and closes the drawer.
  fireEvent.click(
    within(drawerDialog).getByRole("button", { name: "Add Recent matter 3 to a folder" }),
  );
  expect(screen.queryByRole("dialog", { name: "All chats" })).not.toBeInTheDocument();
  expect(within(sidebar).getByLabelText("Folder name")).toBeInTheDocument();
});
