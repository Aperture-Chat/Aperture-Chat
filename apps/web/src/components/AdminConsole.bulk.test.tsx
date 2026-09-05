import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData, User } from "../lib/types";
import { AdminConsole, type AdminConsoleApi } from "./AdminConsole";

test("bulk deactivation reconciles a late success after a rejection and retries only failed users", async () => {
  const pendingJane = deferred<User | void>();
  let failCasey = true;
  const deactivateUser = vi.fn(async (_actorId: string, userId: string) => {
    if (userId === "user-jane") return pendingJane.promise;
    if (failCasey) throw new Error("Account is temporarily locked.");
  });
  renderAdmin({ deactivateUser });
  selectUser("Jane Smith");
  selectUser("Casey Doe");
  fireEvent.click(screen.getByRole("button", { name: "Deactivate", exact: true }));

  await waitFor(() => expect(deactivateUser).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Deactivate", exact: true })).toBeDisabled();
  expect(userState("user-jane").active).toBe(true);
  await act(async () => pendingJane.resolve(undefined));

  expect(await screen.findByText(/Deactivated 1 of 2 selected users/)).toHaveTextContent("Casey Doe: Account is temporarily locked.");
  expect(userState("user-jane").active).toBe(false);
  expect(userState("user-jane", "users").active).toBe(false);
  expect(userState("user-casey").active).toBe(true);
  expect(screen.getByLabelText("Select Jane Smith")).not.toBeChecked();
  expect(screen.getByLabelText("Select Jane Smith")).toBeDisabled();
  expect(screen.getByLabelText("Select Casey Doe")).toBeChecked();

  failCasey = false;
  fireEvent.click(screen.getByRole("button", { name: "Deactivate", exact: true }));
  expect(await screen.findByText("Deactivated 1 user through the admin API.")).toBeInTheDocument();
  expect(deactivateUser.mock.calls.map((call) => call[1])).toEqual(["user-jane", "user-casey", "user-casey"]);
  expect(userState("user-casey").active).toBe(false);
  expect(screen.getByLabelText("Select Casey Doe")).not.toBeChecked();
});

test("bulk deactivation keeps every failed user selected even when an API throws synchronously", async () => {
  const deactivateUser = vi.fn(() => { throw new Error("Unavailable."); });
  renderAdmin({ deactivateUser });
  selectUser("Jane Smith");
  selectUser("Casey Doe");
  fireEvent.click(screen.getByRole("button", { name: "Deactivate", exact: true }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Deactivated 0 of 2 selected users.");
  expect(deactivateUser).toHaveBeenCalledTimes(2);
  expect(userState("user-jane").active).toBe(true);
  expect(userState("user-casey").active).toBe(true);
  expect(screen.getByLabelText("Select Jane Smith")).toBeChecked();
  expect(screen.getByLabelText("Select Casey Doe")).toBeChecked();
  expect(screen.getByRole("button", { name: "Deactivate", exact: true })).toBeEnabled();
});

test("group import applies successes and total count, then retries only failed and unmatched emails", async () => {
  const data = structuredClone(sampleData) as BootstrapData;
  data.groups.find((group) => group.id === "group-corporate")!.user_count = 11;
  for (const users of [data.users, data.visibleUsers]) {
    users.find((user) => user.id === "user-maya")!.group_ids.push("group-corporate");
  }
  let failCasey = true;
  const updateUser = vi.fn(async (_actorId: string, userId: string) => {
    if (userId === "user-casey" && failCasey) throw new Error("Membership service unavailable.");
  });
  renderAdmin({ updateUser }, data);
  openGroupImport();
  fireEvent.change(screen.getByLabelText("User emails"), {
    target: { value: "JANE.SMITH@example.com, jane.smith@example.com, casey.doe@example.com; maya.patel@example.com; missing@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add users to group" }));

  expect(await screen.findByText(/Added 1 user to Corporate\./)).toHaveTextContent("casey.doe@example.com: Membership service unavailable.");
  expect(screen.getByLabelText("User emails")).toHaveValue("casey.doe@example.com\nmissing@example.com");
  expect(userState("user-jane").group_ids).toContain("group-corporate");
  expect(userState("user-jane", "users").group_ids).toContain("group-corporate");
  expect(userState("user-casey").group_ids).not.toContain("group-corporate");
  expect(state().groups.find((group) => group.id === "group-corporate")!.user_count).toBe(12);
  expect(updateUser.mock.calls.map((call) => call[1])).toEqual(["user-jane", "user-casey"]);

  failCasey = false;
  fireEvent.click(screen.getByRole("button", { name: "Add users to group" }));
  await waitFor(() => expect(screen.getByLabelText("User emails")).toHaveValue("missing@example.com"));
  expect(userState("user-casey").group_ids).toContain("group-corporate");
  expect(state().groups.find((group) => group.id === "group-corporate")!.user_count).toBe(13);
  expect(updateUser.mock.calls.map((call) => call[1])).toEqual(["user-jane", "user-casey", "user-casey"]);
});

test("group import preserves failed accounts and memberships when every request fails", async () => {
  const updateUser = vi.fn(async () => { throw new Error("Request denied."); });
  renderAdmin({ updateUser });
  const originalGroup = state().groups.find((group) => group.id === "group-corporate")!;
  openGroupImport();
  fireEvent.change(screen.getByLabelText("User emails"), { target: { value: "jane.smith@example.com\ncasey.doe@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Add users to group" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Added 0 users to Corporate.");
  expect(userState("user-jane").group_ids).not.toContain("group-corporate");
  expect(userState("user-casey").group_ids).not.toContain("group-corporate");
  expect(screen.getByLabelText("User emails")).toHaveValue("jane.smith@example.com\ncasey.doe@example.com");
  expect(state().groups.find((group) => group.id === "group-corporate")!.user_count).toBe(originalGroup.user_count);
  expect(screen.getByRole("button", { name: "Add users to group" })).toBeEnabled();
});

test("group import preserves a new draft entered while its requests are pending", async () => {
  const pendingUpdate = deferred<User | void>();
  renderAdmin({ updateUser: vi.fn(() => pendingUpdate.promise) });
  openGroupImport();
  fireEvent.change(screen.getByLabelText("User emails"), { target: { value: "jane.smith@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Add users to group" }));
  fireEvent.change(screen.getByLabelText("User emails"), { target: { value: "casey.doe@example.com" } });
  await act(async () => pendingUpdate.resolve(undefined));

  expect(await screen.findByText("Added 1 user to Corporate.")).toBeInTheDocument();
  expect(screen.getByLabelText("User emails")).toHaveValue("casey.doe@example.com");
  expect(userState("user-jane").group_ids).toContain("group-corporate");
});

test("group import restores failed emails alongside a new draft entered while importing", async () => {
  const pendingUpdate = deferred<User | void>();
  renderAdmin({ updateUser: vi.fn(() => pendingUpdate.promise) });
  openGroupImport();
  fireEvent.change(screen.getByLabelText("User emails"), { target: { value: "jane.smith@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Add users to group" }));
  fireEvent.change(screen.getByLabelText("User emails"), { target: { value: "casey.doe@example.com" } });
  await act(async () => pendingUpdate.reject(new Error("Unavailable.")));

  expect(await screen.findByRole("alert")).toHaveTextContent("Added 0 users to Corporate.");
  expect(screen.getByLabelText("User emails")).toHaveValue("casey.doe@example.com\njane.smith@example.com");
  expect(userState("user-jane").group_ids).not.toContain("group-corporate");
});

function renderAdmin(adminApi: AdminConsoleApi, initialData = structuredClone(sampleData) as BootstrapData) {
  function Harness() {
    const [data, setData] = useState(initialData);
    return <><AdminConsole data={data} onDataChange={setData} adminApi={adminApi} /><output hidden data-testid="admin-data">{JSON.stringify(data)}</output></>;
  }
  return render(<Harness />);
}

function state(): BootstrapData {
  return JSON.parse(screen.getByTestId("admin-data").textContent ?? "{}");
}

function userState(userId: string, collection: "visibleUsers" | "users" = "visibleUsers") {
  return state()[collection].find((user) => user.id === userId)!;
}

function selectUser(name: string) {
  fireEvent.click(screen.getByLabelText(`Select ${name}`));
}

function selectTab(name: string) {
  const tab = screen.getAllByRole("tab", { name, exact: true })[0];
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

function openGroupImport() {
  selectTab("Groups");
  fireEvent.click(screen.getByText("Corporate"));
  selectTab("Import");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
