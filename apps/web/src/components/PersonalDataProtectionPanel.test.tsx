import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { getPrivacyDetectors, getPrivacyPolicy, previewPrivacy, updatePrivacyPolicy } from "../lib/api/dataProtection";
import type { TenantPrivacyPolicy } from "../lib/types";
import { PersonalDataProtectionPanel } from "./PersonalDataProtectionPanel";

vi.mock("../lib/api/dataProtection", () => ({
  getPrivacyPolicy: vi.fn(),
  getPrivacyDetectors: vi.fn(),
  previewPrivacy: vi.fn(),
  updatePrivacyPolicy: vi.fn(),
}));

const policy: TenantPrivacyPolicy = {
  tenant_id: "synthetic",
  enabled: false,
  categories: ["identity", "contact"],
  conceal_from_model: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPrivacyPolicy).mockResolvedValue(policy);
  vi.mocked(getPrivacyDetectors).mockResolvedValue({
    categories: [
      { id: "identity", label: "Government and personal IDs" },
      { id: "contact", label: "Contact details" },
      { id: "financial", label: "Financial accounts" },
    ],
    detectors: [
      { id: "ssn", label: "US Social Security number", token: "SSN", category: "identity", category_label: "", example: "" },
      { id: "email", label: "Email address", token: "EMAIL", category: "contact", category_label: "", example: "" },
    ],
  });
  vi.mocked(updatePrivacyPolicy).mockImplementation(async (_user, patch) => ({ ...policy, ...patch }));
  vi.mocked(previewPrivacy).mockResolvedValue({
    concealed_sample: "SSN ⟦SSN⟧",
    detections: [{ id: "ssn", label: "US Social Security number", count: 1 }],
  });
});

async function openPanel() {
  render(<PersonalDataProtectionPanel actorUserId="synthetic" />);
  fireEvent.click(await screen.findByRole("button", { name: "Expand panel" }));
  await screen.findByText("Government and personal IDs");
}

test("turning protection on saves the policy and the model toggle waits for it", async () => {
  await openPanel();
  expect(screen.getByRole("switch", { name: "Hide values from the model too" })).toBeDisabled();
  fireEvent.click(screen.getByRole("switch", { name: "Conceal personal data" }));
  await waitFor(() => expect(updatePrivacyPolicy).toHaveBeenCalledWith("synthetic", { enabled: true }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Hide values from the model too" })).toBeEnabled());
});

test("categories toggle individually", async () => {
  await openPanel();
  fireEvent.click(screen.getByRole("switch", { name: "Conceal financial accounts" }));
  await waitFor(() =>
    expect(updatePrivacyPolicy).toHaveBeenCalledWith("synthetic", { categories: ["identity", "contact", "financial"] }),
  );
});

test("the last selected category cannot be switched off", async () => {
  vi.mocked(getPrivacyPolicy).mockResolvedValue({ ...policy, categories: ["contact"] });
  await openPanel();
  expect(screen.getByRole("switch", { name: "Conceal contact details" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Conceal government and personal ids" })).toBeEnabled();
});

test("preview shows the concealed sample with chips", async () => {
  await openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Preview concealment/ }));
  expect(await screen.findByRole("img", { name: "SSN hidden" })).toBeInTheDocument();
  expect(screen.getByText("1 value concealed")).toBeInTheDocument();
});
