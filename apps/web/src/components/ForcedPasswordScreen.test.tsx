import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ForcedPasswordScreen } from "./AuthScreen";

test("forced password screen validates length and match before submitting", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<ForcedPasswordScreen displayName="Jordan Kim" onSubmit={onSubmit} onCancel={() => {}} />);

  expect(screen.getByText(/Welcome, Jordan Kim/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: /Set password and continue/ }));
  expect(await screen.findByText("Use a password with at least 12 characters.")).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "my-own-longer-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-password-99" } });
  fireEvent.click(screen.getByRole("button", { name: /Set password and continue/ }));
  expect(await screen.findByText("The passwords do not match.")).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "my-own-longer-password" } });
  fireEvent.click(screen.getByRole("button", { name: /Set password and continue/ }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("my-own-longer-password"));
});

test("forced password screen surfaces API errors and offers a way back", async () => {
  const onSubmit = vi.fn().mockRejectedValue(new Error("Current password is incorrect."));
  const onCancel = vi.fn();
  render(<ForcedPasswordScreen displayName="Jordan Kim" onSubmit={onSubmit} onCancel={onCancel} />);

  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "my-own-longer-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "my-own-longer-password" } });
  fireEvent.click(screen.getByRole("button", { name: /Set password and continue/ }));
  expect(await screen.findByText("Current password is incorrect.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Back to sign-in" }));
  expect(onCancel).toHaveBeenCalled();
});
