import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useState, type ForwardedRef } from "react";
import { sampleData } from "../data/sampleData";
import { CHAT_FEEDBACK_STORAGE_KEY, type ChatFeedbackEvent } from "../lib/chatFeedback";
import type {
  BootstrapData,
  Connector,
  ModelConfig,
  PlatformProviderKeyCreateRequest,
  Provider,
  ProviderKey,
  ProviderModelSyncResult,
  SecurityAlert,
  SsoConfig,
  User,
  UserPromptRecord,
} from "../lib/types";
import type { PlatformTenantSummary, ScimTokenSummary } from "../lib/api/platform";
import { PlatformConsole, type PlatformConsoleActions } from "./PlatformConsole";

vi.mock("@remotion/player", async () => {
  const React = await import("react");

  return {
    Player: React.forwardRef(
      (
        {
          initialFrame,
          initiallyShowControls,
          autoPlay,
          inputProps,
        }: {
          autoPlay?: boolean;
          initialFrame?: number;
          initiallyShowControls?: boolean | number;
          inputProps?: { video?: { audioSrc?: string; title?: string } };
        },
        ref: ForwardedRef<unknown>,
      ) => {
        React.useImperativeHandle(ref, () => ({
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          play: () => undefined,
          pause: () => undefined,
          seekTo: () => undefined,
          isPlaying: () => false,
        }));

        return (
          <div
            data-autoplay={String(Boolean(autoPlay))}
            data-audio-src={inputProps?.video?.audioSrc ?? ""}
            data-initial-frame={initialFrame}
            data-initially-show-controls={String(Boolean(initiallyShowControls))}
            data-testid="remotion-player"
          >
            {inputProps?.video?.title ?? "Remotion player"}
          </div>
        );
      },
    ),
  };
});

beforeEach(() => {
  vi.mocked(globalThis.fetch).mockReset();
  window.localStorage.clear();
});

function installCsvDownloadSpy() {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const downloads: Array<{ blob: Blob; filename?: string; href?: string }> = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    downloads.push({ blob });
    return `blob:platform-export-${downloads.length}`;
  });
  const revokeObjectURL = vi.fn();

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });

  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function recordDownload(this: HTMLAnchorElement) {
      const latestDownload = downloads[downloads.length - 1];
      if (latestDownload) {
        latestDownload.filename = this.download;
        latestDownload.href = this.href;
      }
    });

  return {
    downloads,
    restore: () => {
      clickSpy.mockRestore();
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: originalCreateObjectURL,
        });
      } else {
        delete (URL as Partial<typeof URL>).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: originalRevokeObjectURL,
        });
      } else {
        delete (URL as Partial<typeof URL>).revokeObjectURL;
      }
    },
  };
}

async function readBlobAsText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

test("deleting a provider uses an in-app dialog, not chained browser prompts", async () => {
  // window.confirm() into window.prompt() silently no-opped: browsers suppress
  // the second dialog, so the delete never fired and nothing explained why.
  const confirmSpy = vi.spyOn(window, "confirm");
  const promptSpy = vi.spyOn(window, "prompt");
  const deleteProvider = vi.fn(async () => ({
    status: "deleted",
    id: "provider-openai",
    models_deleted: 2,
    keys_deleted: 1,
  }));
  const data = platformOwnerData();
  const provider = data.providers[0];

  renderPlatform(data, { deleteProvider });
  selectTab("Providers");
  await screen.findByRole("tabpanel", { name: "Providers" });
  fireEvent.click(screen.getByRole("button", { name: `Delete provider ${provider.name}` }));

  const confirmButton = await screen.findByRole("button", {
    name: `Confirm delete provider ${provider.name}`,
  });
  // Nothing is destroyed until the owner reproduces the name exactly.
  expect(confirmButton).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Confirm provider name"), {
    target: { value: "not the name" },
  });
  expect(confirmButton).toBeDisabled();

  fireEvent.change(screen.getByLabelText("Confirm provider name"), {
    target: { value: provider.name },
  });
  expect(confirmButton).toBeEnabled();
  fireEvent.click(confirmButton);

  await waitFor(() => expect(deleteProvider).toHaveBeenCalledWith(provider.id, provider.name));
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(promptSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
  promptSpy.mockRestore();
});


test("provider key reveal opens replacement-key flow and delete reconciles against platform actions", async () => {
  const data = platformOwnerData();
  const openRouterKey = data.providerKeys.find((key) => key.id === "key-openrouter-primary") as ProviderKey;
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const revealProviderKey = vi.fn(async () => ({
    ...openRouterKey,
    masked_value: "sk-••••••••1111",
    secret_value: "sk-or-v1-test-revealed-1111",
  }));
  const deleteProviderKey = vi.fn(async () => undefined);

  renderPlatform(data, { revealProviderKey, deleteProviderKey });
  selectTab("Providers");
  await screen.findByRole("tabpanel", { name: "Providers" });
  fireEvent.click(screen.getByRole("button", { name: "API keys for OpenRouter" }));

  expect(screen.queryByText("Azure OpenAI Primary")).not.toBeInTheDocument();
  expect(screen.queryByText("OpenAI Primary")).not.toBeInTheDocument();

  const row = screen.getByText("OpenRouter Primary").closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Reveal OpenRouter Primary" }));

  const revealDialog = await screen.findByRole("dialog", { name: "OpenRouter Primary revealed key" });
  expect(within(revealDialog).getByLabelText("OpenRouter Primary revealed key value")).toHaveTextContent(
    "sk-or-v1-test-revealed-1111",
  );
  expect(within(row).queryByText("sk-or-v1-test-revealed-1111")).not.toBeInTheDocument();
  fireEvent.click(within(revealDialog).getByRole("button", { name: "Copy OpenRouter Primary key" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("sk-or-v1-test-revealed-1111"));
  expect(within(revealDialog).getByRole("button", { name: "Copy OpenRouter Primary key" })).toHaveTextContent("Copied");
  fireEvent.click(within(revealDialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "OpenRouter Primary revealed key" })).not.toBeInTheDocument());
  expect(revealProviderKey).toHaveBeenCalledWith("key-openrouter-primary");

  fireEvent.click(within(row).getByRole("button", { name: "Add replacement key for OpenRouter Primary" }));

  expect(await screen.findByLabelText("Key name")).toHaveValue("OpenRouter Replacement");
  expect(screen.getByLabelText("API key or secret")).toHaveValue("");
  expect(screen.getByText(/Create the replacement key in OpenRouter/i)).toBeInTheDocument();

  fireEvent.click(within(row).getByRole("button", { name: "Delete OpenRouter Primary" }));

  await waitFor(() => expect(screen.queryByText("OpenRouter Primary")).not.toBeInTheDocument());
  expect(deleteProviderKey).toHaveBeenCalledWith("key-openrouter-primary");
});

test("expired provider keys are visibly expired and cannot reveal or enable model sync", async () => {
  const data = platformOwnerData();
  data.providerKeys = [
    {
      id: "key-openrouter-expired",
      provider_id: "provider-openrouter",
      provider_name: "OpenRouter",
      name: "OpenRouter Expired",
      environment: "Production",
      status: "Active",
      last_rotated: "Jan 1, 2025, 9:00 AM",
      expires: "Jan 1, 2025",
      masked_value: "sk-••••••••0000",
    },
  ];
  const revealProviderKey = vi.fn();

  renderPlatform(data, { revealProviderKey });
  selectTab("Providers");
  await screen.findByRole("tabpanel", { name: "Providers" });
  fireEvent.click(screen.getByRole("button", { name: "API keys for OpenRouter" }));

  const row = screen.getByText("OpenRouter Expired").closest("tr") as HTMLElement;
  expect(within(row).getByText("Expired")).toBeInTheDocument();
  expect(within(row).getByRole("button", { name: "Reveal OpenRouter Expired" })).toBeDisabled();

  const providerCard = screen.getByText("OpenRouter").closest(".provider-card") as HTMLElement;
  expect(within(providerCard).getByRole("button", { name: "Sync Models" })).toBeDisabled();
  expect(revealProviderKey).not.toHaveBeenCalled();
});

test("platform connector switches persist through platform connector action", async () => {
  const data = platformOwnerData();
  const setConnectorEnabled = vi.fn(async (connector: Connector, enabled: boolean) => {
    return { ...connector, platform_enabled: enabled, tenant_enabled: enabled };
  });

  renderPlatform(data, { setConnectorEnabled });
  selectTab("Org Settings");
  await screen.findByRole("tabpanel", { name: "Org Settings" });
  expect(screen.queryByRole("switch", { name: "Enable Box" })).not.toBeInTheDocument();
  expandPanel("Connectors");
  fireEvent.click(screen.getByRole("switch", { name: "Enable Box" }));

  expect(await screen.findByText("Box is now off for everyone in this deployment.")).toBeInTheDocument();
  expect(setConnectorEnabled).toHaveBeenCalledWith(expect.objectContaining({ id: "box" }), false);
  expect(screen.getByRole("switch", { name: "Enable Box" })).toHaveAttribute("aria-checked", "false");
});


test("explicit model setup requests open Providers and expand its connection panel", async () => {
  const data = platformOwnerData();
  const onDataChange = vi.fn();
  const actions = {};
  const { rerender } = render(<PlatformConsole data={data} onDataChange={onDataChange} platformActions={actions} />);
  expect(screen.getByRole("tab", { name: "Org Settings" })).toHaveAttribute("aria-selected", "true");
  rerender(<PlatformConsole data={data} onDataChange={onDataChange} platformActions={actions} openProvidersRequestKey={1} />);
  expect(await screen.findByRole("tabpanel", { name: "Providers" })).toBeInTheDocument();
  const panel = screen.getByRole("heading", { name: "Provider Connections" }).closest("section")!;
  fireEvent.click(within(panel).getByRole("button", { name: "Collapse panel" }));
  expect(panel).toHaveClass("is-panel-collapsed");
  selectTab("Org Settings");
  rerender(<PlatformConsole data={data} onDataChange={onDataChange} platformActions={actions} openProvidersRequestKey={2} />);
  expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
  const reopened = screen.getByRole("heading", { name: "Provider Connections" }).closest("section")!;
  expect(reopened).not.toHaveClass("is-panel-collapsed");
  expect(within(reopened).getByRole("button", { name: "Add Provider" })).toBeVisible();
});

test("platform owner can create a provider with a vaulted key", async () => {
  const data = platformOwnerData();
  const createProvider = vi.fn(async (provider: Provider) => ({
    ...provider,
    id: "provider-anthropic-legal",
  }));
  const createProviderKey = vi.fn(async (payload: PlatformProviderKeyCreateRequest) => ({
    id: "key-anthropic-legal-primary",
    provider_id: payload.provider_id,
    provider_name: "Anthropic Legal",
    name: payload.name,
    environment: payload.environment ?? "Production",
    status: "Active",
    last_rotated: "Saved now",
    expires: payload.expires ?? "Not set",
    masked_value: "••••••••1234",
  }));

  renderPlatform(data, { createProvider, createProviderKey });
  selectTab("Providers");
  await screen.findByRole("tabpanel", { name: "Providers" });
  fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));
  expect(screen.getByLabelText("Name")).toHaveValue("");
  expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Provider name");
  expect(screen.getByLabelText("Kind")).toHaveValue("openai-compatible");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Anthropic Legal" } });
  fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "anthropic" } });
  fireEvent.change(screen.getByLabelText("API key or secret"), { target: { value: "anthropic-secret-1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

  expect(await screen.findByText(/Anthropic Legal provider and masked key metadata saved/i)).toBeInTheDocument();
  expect(createProvider).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Anthropic Legal",
      kind: "anthropic",
      connected: false,
      auth_type: "api-key",
      auth_metadata: expect.objectContaining({ header_name: "x-api-key" }),
    }),
  );
  expect(createProviderKey).toHaveBeenCalledWith(
    expect.objectContaining({
      provider_id: "provider-anthropic-legal",
      name: "Anthropic Legal Primary",
      environment: "Production",
      secret_value: "anthropic-secret-1234",
    }),
  );

  fireEvent.click(await screen.findByRole("button", { name: "API keys for Anthropic Legal" }));
  expect(await screen.findByText("Anthropic Legal Primary")).toBeInTheDocument();
  expect(screen.getByText("••••••••1234")).toBeInTheDocument();
});


test("failed provider registration keeps the form and creates no ghost provider or key", async () => {
  const createProvider = vi.fn().mockRejectedValueOnce(new Error("Provider service unavailable"))
    .mockImplementationOnce(async (provider: Provider) => ({ ...provider, id: "provider-retry" }));
  const createProviderKey = vi.fn(async (payload: PlatformProviderKeyCreateRequest) => ({
    id: "key-retry", provider_id: payload.provider_id, provider_name: "Retry Provider", name: payload.name,
    environment: "Production", status: "Active", last_rotated: "Just now", expires: "Not set", masked_value: "••••••••test",
  }));
  renderPlatform(platformOwnerData(), { createProvider, createProviderKey });
  selectTab("Providers");
  fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retry Provider" } });
  fireEvent.change(screen.getByLabelText("API key or secret"), { target: { value: "synthetic-key-test" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));
  expect(await screen.findByText(/Retry Provider was not added/)).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("Retry Provider");
  expect(screen.getByLabelText("API key or secret")).toHaveValue("synthetic-key-test");
  expect(screen.queryByRole("heading", { name: "Retry Provider" })).not.toBeInTheDocument();
  expect(createProviderKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));
  const heading = await screen.findByRole("heading", { name: "Retry Provider" });
  expect(screen.getAllByRole("heading", { name: "Retry Provider" })).toHaveLength(1);
  expect(within(heading.closest(".provider-card") as HTMLElement).getByText("Needs validation")).toBeInTheDocument();
});

test("failed key setup retains the registered provider and retries its key without creating another provider", async () => {
  const createProvider = vi.fn(async (provider: Provider) => ({ ...provider, id: "provider-partial" }));
  const createProviderKey = vi.fn().mockRejectedValueOnce(new Error("Vault unavailable"))
    .mockImplementationOnce(async (payload: PlatformProviderKeyCreateRequest) => ({
      id: "key-partial", provider_id: payload.provider_id, provider_name: "Partial Provider", name: payload.name,
      environment: "Production", status: "Active", last_rotated: "Just now", expires: "Not set", masked_value: "••••••••test",
    }));
  renderPlatform(platformOwnerData(), { createProvider, createProviderKey });
  selectTab("Providers");
  fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Partial Provider" } });
  fireEvent.change(screen.getByLabelText("API key or secret"), { target: { value: "synthetic-key-test" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));
  expect(await screen.findByText(/Partial Provider was created, but its key setup did not finish/)).toBeInTheDocument();
  const card = screen.getByRole("heading", { name: "Partial Provider" }).closest(".provider-card") as HTMLElement;
  expect(within(card).getByText("Needs key")).toBeInTheDocument();
  expect(within(card).getByLabelText("API key or secret")).toHaveValue("synthetic-key-test");
  expect(within(card).queryByText("••••••••test")).not.toBeInTheDocument();
  fireEvent.click(within(card).getByRole("button", { name: "Save Key" }));
  expect(await within(card).findByText("••••••••test")).toBeInTheDocument();
  expect(createProvider).toHaveBeenCalledTimes(1);
  expect(createProviderKey).toHaveBeenLastCalledWith(expect.objectContaining({ provider_id: "provider-partial" }));
  expect(within(card).getByText("Needs validation")).toBeInTheDocument();
});

test("provider creation without a connected API does not invent a local provider", async () => {
  renderPlatform(platformOwnerData(), {});
  selectTab("Providers");
  fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unconnected Provider" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));
  expect(await screen.findByText(/provider or key API is not connected/)).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("Unconnected Provider");
  expect(screen.queryByRole("heading", { name: "Unconnected Provider" })).not.toBeInTheDocument();
});

test("openrouter provider drafts use the zdr catalog endpoint by default", async () => {
  const data = platformOwnerData();

  renderPlatform(data, {});
  selectTab("Providers");
  await screen.findByRole("tabpanel", { name: "Providers" });
  fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));
  fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "openrouter" } });

  expect(screen.getByLabelText("Base URL")).toHaveValue("https://openrouter.ai/api/v1");
  expect(screen.getByLabelText("Header")).toHaveValue("Authorization");
  expect(screen.getByLabelText("Catalog scope")).toHaveValue("zdr");
});

test("platform owner can edit provider connection metadata", async () => {
  const data = platformOwnerData();
  const provider = data.providers.find((item) => item.id === "provider-openrouter") as Provider;
  const updateProvider = vi.fn(async (providerId: string, patch: Partial<Provider>) => ({
    ...provider,
    ...patch,
    id: providerId,
  }));

  renderPlatform(data, { updateProvider });
  selectTab("Providers");
  await screen.findByRole("tabpanel", { name: "Providers" });

  const providerCard = screen.getByText("OpenRouter").closest(".provider-card") as HTMLElement;
  fireEvent.click(within(providerCard).getByRole("button", { name: "Edit Connection" }));
  const editor = await within(providerCard).findByLabelText("Name");
  fireEvent.change(editor, { target: { value: "OpenRouter ZDR" } });
  fireEvent.change(within(providerCard).getByLabelText("Region"), { target: { value: "Global" } });
  expect(within(providerCard).getByLabelText("Catalog scope")).toHaveValue("zdr");
  fireEvent.click(within(providerCard).getByRole("button", { name: "Save Connection" }));

  expect(await screen.findByText("OpenRouter ZDR connection saved through the platform API.")).toBeInTheDocument();
  expect(updateProvider).toHaveBeenCalledWith(
    provider.id,
    expect.objectContaining({
      name: "OpenRouter ZDR",
      kind: "openrouter",
      region: "Global",
      base_url: "https://openrouter.ai/api/v1",
      auth_type: "bearer",
      auth_metadata: expect.objectContaining({ header_name: "Authorization", catalog_scope: "zdr" }),
    }),
  );
  expect(screen.getByText("OpenRouter ZDR")).toBeInTheDocument();
});

test("provider model sync imports key-scoped provider catalog into the model table", async () => {
  const data = platformOwnerData();
  const provider = data.providers.find((item) => item.id === "provider-openrouter") as Provider;
  data.providers = data.providers.map((item) =>
    item.id === provider.id ? { ...item, model_count: 0, enabled_model_count: 0, last_sync: "Key saved now" } : item,
  );
  const syncedModel: ModelConfig = {
    id: "provider-openrouter-openai-gpt-4o",
    provider_id: provider.id,
    provider_name: provider.name,
    name: "OpenAI: GPT-4o",
    upstream_model_id: "openai/gpt-4o",
    platform_enabled: true,
    tenant_restricted: false,
    group_ids: [],
    notes: "Synced from OpenRouter key-scoped catalog.",
    context_window: 128000,
    visibility: "organization",
  };
  const syncProviderModels = vi.fn(async (): Promise<ProviderModelSyncResult> => ({
    provider: {
      ...provider,
      model_count: 1,
      enabled_model_count: 1,
      last_sync: "Just synced",
      status_message: "Synced from OpenRouter key-scoped catalog; ZDR eligibility was applied upstream.",
    },
    models: [syncedModel],
    imported_count: 1,
    updated_count: 0,
    removed_count: 0,
    source: "openrouter:/models/user",
    message: "Synced 1 OpenRouter model from the provider API.",
  }));

  renderPlatform(data, { syncProviderModels });
  selectTab("Providers");
  await screen.findByRole("tabpanel", { name: "Providers" });

  const providerCard = screen.getByText("OpenRouter").closest(".provider-card") as HTMLElement;
  fireEvent.click(within(providerCard).getByRole("button", { name: "Sync Models" }));

  expect(await screen.findByText("Synced 1 OpenRouter model from the provider API. 1 added.")).toBeInTheDocument();
  expect(syncProviderModels).toHaveBeenCalledWith(provider.id);
  expect(await within(providerCard).findByText("1 of 1")).toBeInTheDocument();

  selectTab("Models");
  await screen.findByRole("tabpanel", { name: "Models" });
  expect(screen.getByText("OpenAI: GPT-4o")).toBeInTheDocument();
  expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
});

test("failed catalog sync never marks an unvalidated provider connected", async () => {
  const data = platformOwnerData();
  data.providers = data.providers.map((provider) => provider.id === "provider-openrouter" ? { ...provider, connected: false } : provider);
  let rejectSync!: (error: Error) => void;
  const syncProviderModels = vi.fn(() => new Promise<ProviderModelSyncResult>((_resolve, reject) => { rejectSync = reject; }));
  renderPlatform(data, { syncProviderModels });
  selectTab("Providers");
  const card = screen.getByRole("heading", { name: "OpenRouter" }).closest(".provider-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Sync Models" }));
  expect(within(card).getByText("Needs validation")).toBeInTheDocument();
  rejectSync(new Error("Provider is unavailable"));
  expect(await screen.findByText("OpenRouter model sync failed: Provider is unavailable")).toBeInTheDocument();
  expect(within(card).getByText("Needs validation")).toBeInTheDocument();
});

test("catalog sync without a discovery API cannot manufacture connection metadata", async () => {
  const data = platformOwnerData();
  data.providers = data.providers.map((provider) => provider.id === "provider-openrouter" ? { ...provider, connected: false } : provider);
  const updateProvider = vi.fn();
  renderPlatform(data, { updateProvider });
  selectTab("Providers");
  const card = screen.getByRole("heading", { name: "OpenRouter" }).closest(".provider-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Sync Models" }));
  expect(await screen.findByText(/OpenRouter model sync failed: Model discovery is unavailable/)).toBeInTheDocument();
  expect(updateProvider).not.toHaveBeenCalled();
  expect(within(card).getByText("Needs validation")).toBeInTheDocument();
});

test("provider setup protects the pending draft and permits retry after failure", async () => {
  let rejectCreation!: (error: Error) => void;
  const createProvider = vi.fn(() => new Promise<Provider>((_resolve, reject) => { rejectCreation = reject; }));
  renderPlatform(platformOwnerData(), { createProvider });
  selectTab("Providers");
  fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Example provider" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));
  expect(screen.getByLabelText("Name")).toBeDisabled();
  expect(screen.getByLabelText("API key or secret")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close form" })).toBeDisabled();
  rejectCreation(new Error("Connection unavailable"));
  expect(await screen.findByText(/Example provider was not added/)).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toBeEnabled();
  expect(screen.getByLabelText("Name")).toHaveValue("Example provider");
});

test("models tab only exposes synced provider catalog controls", async () => {
  const data = platformOwnerData();

  renderPlatform(data, {});
  selectTab("Models");

  expect(screen.getByRole("tabpanel", { name: "Models" })).toBeInTheDocument();
  expect(screen.getByText("Organization Model Availability")).toBeInTheDocument();
  expect(
    screen.getByText("Sync provider catalogs and control which API models can flow down to tenant admins."),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Search models")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create Model" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create Preset" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Model name")).not.toBeInTheDocument();
  expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0);
});

test("model list column filters narrow by provider, model lab, and runtime route", async () => {
  const data = platformOwnerData();
  const baseModel = data.models[0];
  data.models = [
    {
      ...baseModel,
      id: "or-gpt",
      name: "OpenAI: GPT-5.5",
      upstream_model_id: "openai/gpt-5.5",
      provider_id: "provider-openrouter",
      provider_name: "OpenRouter",
    },
    {
      ...baseModel,
      id: "or-claude",
      name: "Anthropic: Claude Opus 4.8",
      upstream_model_id: "anthropic/claude-opus-4.8",
      provider_id: "provider-openrouter",
      provider_name: "OpenRouter",
    },
    {
      ...baseModel,
      id: "groq-oss",
      name: "GPT OSS 120B",
      upstream_model_id: "openai/gpt-oss-120b",
      provider_id: "provider-groq",
      provider_name: "Groq",
    },
  ];

  const { container } = renderPlatform(data, {});
  selectTab("Models");
  const listedModels = () =>
    Array.from(container.querySelectorAll(".model-list-item .model-name-cell strong")).map((node) =>
      node.textContent?.trim(),
    );
  expect(listedModels()).toHaveLength(3);

  // Provider facet: keep only Groq models.
  fireEvent.click(screen.getByRole("button", { name: "Filter by provider" }));
  fireEvent.click(within(screen.getByRole("group", { name: "Provider filter" })).getByLabelText(/Groq/));
  expect(listedModels()).toEqual(["GPT OSS 120B"]);
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(listedModels()).toHaveLength(3);

  // Model-lab facet: keep only Anthropic-lab models regardless of provider.
  fireEvent.click(screen.getByRole("button", { name: "Filter by model lab" }));
  fireEvent.click(within(screen.getByRole("group", { name: "Model lab filter" })).getByLabelText(/Anthropic/));
  expect(listedModels()).toEqual(["Anthropic: Claude Opus 4.8"]);
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

  // Runtime-route filter: contains-text across upstream ids.
  fireEvent.click(screen.getByRole("button", { name: "Filter by runtime route" }));
  fireEvent.change(screen.getByLabelText("Runtime route contains"), { target: { value: "gpt-oss" } });
  expect(listedModels()).toEqual(["GPT OSS 120B"]);
  fireEvent.change(screen.getByLabelText("Runtime route contains"), { target: { value: "no-such-route" } });
  expect(screen.getByText("No models match the current column filters.")).toBeInTheDocument();
});

test("models tab displays provider catalog in ascending alphanumeric model order", async () => {
  const data = platformOwnerData();
  const baseModel = data.models[0];
  data.models = [
    { ...baseModel, id: "zed-model", name: "Zed Model", upstream_model_id: "zed-model" },
    { ...baseModel, id: "anthropic-claude", name: "Anthropic: Claude Sonnet 5", upstream_model_id: "anthropic/claude-sonnet-5" },
    { ...baseModel, id: "10-beta", name: "10 Beta Model", upstream_model_id: "10-beta-model" },
    { ...baseModel, id: "2-alpha", name: "2 Alpha Model", upstream_model_id: "2-alpha-model" },
  ];

  const { container } = renderPlatform(data, {});
  selectTab("Models");

  expect(screen.getByRole("tabpanel", { name: "Models" })).toBeInTheDocument();
  const modelNames = Array.from(container.querySelectorAll(".model-list-item .model-name-cell strong")).map((node) =>
    node.textContent?.trim(),
  );
  expect(modelNames).toEqual([
    "2 Alpha Model",
    "10 Beta Model",
    "Anthropic: Claude Sonnet 5",
    "Zed Model",
  ]);
});

test("documentation opens owner guide and audit replaces the old activity log action", async () => {
  const data = platformOwnerData();

  renderPlatform(data, {});

  expect(screen.queryByRole("button", { name: "Activity log" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Documentation" }));

  expect(await screen.findByRole("dialog", { name: "Platform owner documentation" })).toBeInTheDocument();
  const videoTitles = [
    "Providers and connections",
    "API Key Vault and replacement",
    "Organization model availability",
    "Users and role boundaries",
    "Single sign-on setup",
    "SSO provisioning and go-live",
    "Platform branding",
    "Policies, budget, and connectors",
    "Analytics: runtime, activity, and usage",
    "Owner audit signals",
    "Alerts and email delivery",
    "Data retention and tagging",
  ];
  for (const title of videoTitles) {
    expect(screen.getByRole("button", { name: `Watch ${title}` })).toBeInTheDocument();
  }
  expect(screen.getAllByText(/guided video$/)).toHaveLength(videoTitles.length);
  expect(screen.queryByText("Training video plan")).not.toBeInTheDocument();

  const guidePdf = screen.getByRole("link", { name: /Platform owner guide \(PDF\)/ });
  expect(guidePdf).toHaveAttribute("href", "docs/aperture-owner-guide.pdf");
  expect(guidePdf).toHaveAttribute("download");

  fireEvent.click(screen.getByRole("button", { name: "Watch Providers and connections" }));
  expect(screen.getByRole("dialog", { name: "Providers and connections video" })).toBeInTheDocument();
  expect(screen.getByTestId("remotion-player")).toHaveTextContent("Providers and connections");
  expect(screen.getByTestId("remotion-player")).toHaveAttribute("data-audio-src", "training/owner/provider-setup.mp3");
  expect(screen.getByTestId("remotion-player")).toHaveAttribute("data-autoplay", "false");
  expect(screen.getByTestId("remotion-player")).toHaveAttribute("data-initial-frame", "0");
  expect(screen.getByTestId("remotion-player")).toHaveAttribute("data-initially-show-controls", "true");
  expect(screen.getByText("Voiceover, captions, and title cards use the same timeline.")).toBeInTheDocument();
  expect(screen.getByText("Setup checklist")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Back to documentation videos" }));
  expect(screen.getByRole("dialog", { name: "Platform owner documentation" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Watch Single sign-on setup" }));
  expect(screen.getByRole("dialog", { name: "Single sign-on setup video" })).toBeInTheDocument();
  expect(screen.getByTestId("remotion-player")).toHaveTextContent("Single sign-on setup");
  expect(screen.getByTestId("remotion-player")).toHaveAttribute("data-audio-src", "training/owner/sso-setup.mp3");
  expect(screen.getByText("Voiceover, captions, and title cards use the same timeline.")).toBeInTheDocument();
  expect(screen.getByText("Setup checklist")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to documentation videos" }));

  fireEvent.click(screen.getByRole("button", { name: "Watch Platform branding" }));
  expect(screen.getByRole("dialog", { name: "Platform branding video" })).toBeInTheDocument();
  expect(screen.getByTestId("remotion-player")).toHaveTextContent("Platform branding");
  expect(screen.getByTestId("remotion-player")).toHaveAttribute("data-audio-src", "training/owner/branding.mp3");
  expect(screen.getByText("Voiceover, captions, and title cards use the same timeline.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to documentation videos" }));

  fireEvent.click(screen.getByRole("button", { name: "Watch Policies, budget, and connectors" }));
  expect(screen.getByRole("dialog", { name: "Policies, budget, and connectors video" })).toBeInTheDocument();
  expect(screen.getByTestId("remotion-player")).toHaveAttribute(
    "data-audio-src",
    "training/owner/policies-connectors.mp3",
  );
  expect(screen.getByText(/every panel collapsed/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to documentation videos" }));

  fireEvent.click(screen.getByRole("button", { name: "Close documentation" }));
  expect(screen.queryByRole("dialog", { name: "Platform owner documentation" })).not.toBeInTheDocument();

  selectTab("Audit");
  await screen.findByRole("tabpanel", { name: "Audit" });
  expect(screen.getByText("User Prompt Activity")).toBeInTheDocument();
  expect(screen.getByText("Security Alerts")).toBeInTheDocument();
  expandPanel("User Prompt Activity");
  expect(screen.getByText("Prompt activity endpoint is not connected")).toBeInTheDocument();
  expect(screen.getByText("Recent Governance Activity")).toBeInTheDocument();
});

test("owner documentation header links open related help surfaces", async () => {
  const data = platformOwnerData();
  const onOpenAdminDocumentation = vi.fn();
  const onOpenUserHelp = vi.fn();

  renderPlatform(data, {}, { onOpenAdminDocumentation, onOpenUserHelp });
  fireEvent.click(screen.getByRole("button", { name: "Documentation" }));

  expect(await screen.findByRole("dialog", { name: "Platform owner documentation" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Admin documentation" }));
  expect(onOpenAdminDocumentation).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "Platform owner documentation" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Documentation" }));
  expect(await screen.findByRole("dialog", { name: "Platform owner documentation" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Chat help" }));
  expect(onOpenUserHelp).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "Platform owner documentation" })).not.toBeInTheDocument();
});

test("audit tab renders the transaction audit trail from the platform audit API", async () => {
  const data = platformOwnerData();
  const listAuditEvents = vi.fn(async () => [
    {
      id: "audit-2",
      tenant_id: null,
      actor_id: "user-owner",
      actor_name: "Aperture Platform Owner",
      actor_role: "PLATFORM_OWNER",
      action: "platform.model_status_changed",
      action_type: "MODEL_DISABLED",
      target: "gpt-4o",
      target_type: "model",
      target_name: "gpt-4o",
      detail: "platform_enabled=false",
      created_at: "2026-07-01T17:30:12+00:00",
      redacted: true,
      metadata: { platform_enabled: false },
    },
    {
      id: "audit-1",
      tenant_id: null,
      actor_id: "user-owner",
      actor_name: "Aperture Platform Owner",
      actor_role: "PLATFORM_OWNER",
      action: "platform.provider_key_revealed",
      action_type: "PROVIDER_KEY_REVEALED",
      target: "key-openrouter-primary",
      target_type: "provider-key",
      target_name: "OpenRouter Primary",
      detail: "secret_value=[redacted]",
      created_at: "2026-07-01T17:29:03+00:00",
      redacted: true,
      metadata: { secret_value: "[redacted]" },
    },
  ]);

  renderPlatform(data, { listAuditEvents });
  selectTab("Audit");
  await screen.findByRole("tabpanel", { name: "Audit" });
  expandPanel("Audit Trail");

  const trail = await screen.findByRole("list", { name: "Audit events" });
  const rows = within(trail).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText("MODEL_DISABLED")).toBeInTheDocument();
  expect(within(rows[0]).getByText(/Aperture Platform Owner \(Platform Owner\) · model: gpt-4o/)).toBeInTheDocument();
  expect(within(rows[0]).getByText(/platform_enabled=false/)).toBeInTheDocument();
  expect(within(rows[1]).getByText("PROVIDER_KEY_REVEALED")).toBeInTheDocument();
  expect(within(rows[1]).getByText(/OpenRouter Primary/)).toBeInTheDocument();
  expect(listAuditEvents).toHaveBeenCalled();

  // The aggregate snapshot panels stay alongside the transaction log.
  expect(screen.getByText("Owner Audit")).toBeInTheDocument();
  expect(screen.getByText("Recent Governance Activity")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(listAuditEvents.mock.calls.length).toBeGreaterThanOrEqual(2));
});

test("audit tab drills into user prompts and acknowledges security alerts", async () => {
  const data = platformOwnerData();
  data.users.push({
    id: "user-owner-two",
    tenant_id: null,
    email: "owner-two@aperture.local",
    display_name: "Second Platform Owner",
    role: "PLATFORM_OWNER",
    group_ids: [],
    active: true,
    last_active: "Now",
    auth_method: "local",
  });
  const promptRecords: UserPromptRecord[] = [
    {
      id: "message-jane-1",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane@example.com",
      user_role: "USER",
      thread_id: "thread-jane-dlp",
      thread_title: "Review DLP boundaries",
      model_id: "gpt-4o",
      content: "Please analyze whether this redacted card value can be stored in the matter file.",
      created_at: "Jul 6, 2026, 5:00 PM UTC",
      created_at_iso: "2026-07-06T23:00:00+00:00",
      response_message_id: "message-jane-response-1",
      response_content:
        "## Finding\n\nThe model found that the redacted value may be **stored only under the " +
        "approved matter policy**.\n\n| Control | State |\n| --- | --- |\n| Retention | 30 days |",
      response_status: "ok",
      response_truncated: false,
      response_images: ["/api/chat/generated-images/jane-audit-image.jpg?token=fresh-token"],
      alert_count: 1,
    },
  ];
  const alerts: SecurityAlert[] = [
    {
      id: "alert-jane-1",
      tenant_id: "tenant-example",
      user_id: "user-jane",
      user_name: "Jane Smith",
      rule_id: "credit-card",
      rule_label: "Payment card number",
      category: "dlp",
      severity: "high",
      snippet: "Please analyze whether [redacted] can be stored.",
      model_id: "gpt-4o",
      thread_id: "thread-jane-dlp",
      surface: "chat",
      created_at: "2026-07-06T23:00:01+00:00",
      acknowledged: false,
      acknowledged_by: null,
      acknowledged_at: null,
    },
  ];
  // The thread drilldown returns the whole conversation, including an
  // earlier exchange that never appeared in the activity list window.
  const fullThread: UserPromptRecord[] = [
    promptRecords[0],
    {
      id: "message-jane-0",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane@example.com",
      user_role: "USER",
      thread_id: "thread-jane-dlp",
      thread_title: "Review DLP boundaries",
      model_id: "gpt-4o",
      content: "Earlier question about the same matter.",
      created_at: "Jul 6, 2026, 4:00 PM UTC",
      created_at_iso: "2026-07-06T22:00:00+00:00",
      response_message_id: "message-jane-response-0",
      response_content: "Earlier saved answer.",
      response_status: "ok",
      response_truncated: false,
      alert_count: 0,
    },
  ];
  const listPromptActivity = vi.fn(async () => promptRecords);
  const listThreadPromptActivity = vi.fn(async () => fullThread);
  const listSecurityAlerts = vi.fn(async () => alerts);
  const acknowledgeSecurityAlert = vi.fn(async (alertId: string, acknowledged: boolean) => ({
    ...alerts[0],
    id: alertId,
    acknowledged,
    acknowledged_by: "user-owner",
    acknowledged_at: "2026-07-06T23:05:00+00:00",
  }));

  renderPlatform(data, {
    listPromptActivity,
    listThreadPromptActivity,
    listSecurityAlerts,
    acknowledgeSecurityAlert,
  });
  selectTab("Audit");
  await screen.findByRole("tabpanel", { name: "Audit" });
  expandPanel("User Prompt Activity");
  expandPanel("Security Alerts");

  // Data loads once for every user; the per-section pickers narrow client-side.
  await waitFor(() => expect(listPromptActivity).toHaveBeenCalledWith(undefined));
  await waitFor(() => expect(listSecurityAlerts).toHaveBeenCalledWith(undefined));
  fireEvent.change(screen.getByLabelText("Prompt activity filter user"), { target: { value: "user-jane" } });
  // Owners audit each other: peer platform owners appear in the pickers
  // alongside the signed-in owner, admins, and users.
  expect(screen.getAllByRole("option", { name: /Second Platform Owner/ }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("option", { name: /Aperture Platform Owner/ }).length).toBeGreaterThan(0);

  const promptList = await screen.findByRole("list", { name: "User prompt activity" });
  expect(within(promptList).getByText("Review DLP boundaries")).toBeInTheDocument();
  expect(within(promptList).getByText("1 active alert")).toBeInTheDocument();
  fireEvent.click(within(promptList).getByText("Review DLP boundaries"));
  const previewDialog = screen.getByRole("dialog", { name: "Prompt and model output" });
  // The preview drills into the whole thread: the earlier exchange outside
  // the list window loads in, oldest first, with the clicked turn marked.
  await waitFor(() => expect(listThreadPromptActivity).toHaveBeenCalledWith("thread-jane-dlp"));
  expect(
    await within(previewDialog).findByText("Earlier question about the same matter."),
  ).toBeInTheDocument();
  expect(within(previewDialog).getByText("Earlier saved answer.")).toBeInTheDocument();
  const clickedExchange = within(previewDialog).getByRole("article", { name: "Exchange 2 of 2" });
  expect(clickedExchange.className).toContain("is-selected");
  expect(within(clickedExchange).getByText(/redacted card value/)).toBeInTheDocument();
  expect(within(previewDialog).getByText(/redacted card value/)).toBeInTheDocument();
  // The audit view renders the output the way the user saw it: markdown
  // structure, not the raw source with its "##" and pipe characters.
  expect(within(previewDialog).getByText(/stored only under the approved matter policy/)).toBeInTheDocument();
  expect(within(previewDialog).getByRole("heading", { name: "Finding" })).toBeInTheDocument();
  expect(within(previewDialog).getByRole("table")).toBeInTheDocument();
  expect(within(previewDialog).getByRole("columnheader", { name: "Control" })).toBeInTheDocument();
  expect(previewDialog.textContent).not.toContain("## Finding");
  // Generated images saved with the output render for audit review.
  const auditImage = within(previewDialog).getByRole("img", {
    name: "Generated image saved with this model output",
  });
  expect(auditImage).toHaveAttribute(
    "src",
    "/api/chat/generated-images/jane-audit-image.jpg?token=fresh-token",
  );
  fireEvent.click(within(previewDialog).getByRole("button", { name: "Close prompt and model output preview" }));
  expect(screen.queryByRole("dialog", { name: "Prompt and model output" })).not.toBeInTheDocument();

  const alertList = await screen.findByRole("list", { name: "Security alerts" });
  expect(within(alertList).getByText("Payment card number")).toBeInTheDocument();
  expect(within(alertList).getByText(/\[redacted\]/)).toBeInTheDocument();
  fireEvent.click(within(alertList).getByRole("button", { name: "Acknowledge" }));

  await waitFor(() => expect(acknowledgeSecurityAlert).toHaveBeenCalledWith("alert-jane-1", true));
  expect(await screen.findByText(/Payment card number alert acknowledged/)).toBeInTheDocument();
});

test("audit issue cards, prompt CSV export, and model activity charts follow prompt scope", async () => {
  const data = platformOwnerData();
  data.providerKeys = data.providerKeys.map((key, index) =>
    index === 0 ? { ...key, expires: "2026-01-01" } : key,
  );
  data.models = data.models.map((model, index) =>
    index === 0 ? { ...model, platform_enabled: true, group_ids: [] } : model,
  );
  const promptRecords: UserPromptRecord[] = [
    {
      id: "message-jane-current",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane.smith@example.com",
      thread_id: "thread-jane-current",
      thread_title: "Review DLP boundaries",
      model_id: "gpt-4o",
      content: "Current redacted matter prompt.",
      created_at: "Jul 6, 2026, 5:00 PM UTC",
      created_at_iso: "2026-07-06T23:00:00+00:00",
      alert_count: 1,
    },
    {
      id: "message-jane-old",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane.smith@example.com",
      thread_id: "thread-jane-old",
      thread_title: "Old DLP review",
      model_id: "gpt-4o",
      content: "Older prompt outside the date window.",
      created_at: "Jun 30, 2026, 5:00 PM UTC",
      created_at_iso: "2026-06-30T23:00:00+00:00",
      alert_count: 0,
    },
    {
      id: "message-owner",
      user_id: "user-owner",
      user_name: "Aperture Platform Owner",
      user_email: "owner@aperture.local",
      thread_id: "thread-owner",
      thread_title: "Owner model check",
      model_id: "gpt-5.5",
      content: "Owner prompt outside the selected user.",
      created_at: "Jul 6, 2026, 6:00 PM UTC",
      created_at_iso: "2026-07-07T00:00:00+00:00",
      alert_count: 0,
    },
  ];
  const alerts: SecurityAlert[] = [
    {
      id: "alert-jane-current",
      tenant_id: "tenant-example",
      user_id: "user-jane",
      user_name: "Jane Smith",
      rule_id: "ssn",
      rule_label: "Social Security number",
      category: "dlp",
      severity: "high",
      snippet: "[redacted] appeared in a prompt.",
      model_id: "gpt-4o",
      thread_id: "thread-jane-current",
      surface: "chat",
      created_at: "2026-07-06T23:00:01+00:00",
      acknowledged: false,
      acknowledged_by: null,
      acknowledged_at: null,
    },
  ];
  const listPromptActivity = vi.fn(async (userId?: string) =>
    userId ? promptRecords.filter((record) => record.user_id === userId) : promptRecords,
  );
  const listSecurityAlerts = vi.fn(async (userId?: string) =>
    userId ? alerts.filter((alert) => alert.user_id === userId) : alerts,
  );
  const downloadSpy = installCsvDownloadSpy();

  try {
    renderPlatform(data, { listPromptActivity, listSecurityAlerts });
    selectTab("Audit");
    await screen.findByRole("tabpanel", { name: "Audit" });
    expandPanel("User Prompt Activity");
    await screen.findByText("Review DLP boundaries");

    const expiredKeysCard = screen.getByText("Expired keys").closest(".audit-summary-card");
    const promptWatchlistCard = screen.getByText("Prompt watchlist").closest(".audit-summary-card");
    const unscopedModelsCard = screen.getByText("Unscoped models").closest(".audit-summary-card");
    const ownerSummaryCards = document.querySelectorAll(".audit-summary-card");
    expect(ownerSummaryCards).toHaveLength(12);
    ownerSummaryCards.forEach((card) => {
      expect(card.tagName).toBe("BUTTON");
      expect(card).toHaveAttribute("aria-haspopup", "dialog");
      expect(card).toHaveAttribute("data-tooltip", expect.stringContaining("review every record"));
    });
    expect(expiredKeysCard).toHaveClass("is-issue");
    expect(promptWatchlistCard).toHaveClass("is-issue");
    expect(unscopedModelsCard).toHaveClass("is-issue");

    fireEvent.click(expiredKeysCard!);
    const expiredKeysDialog = screen.getByRole("dialog", { name: "Expired keys" });
    expect(within(expiredKeysDialog).getByText(data.providerKeys[0].name)).toBeInTheDocument();
    expect(within(expiredKeysDialog).getByText(/secret values are never included/i)).toBeInTheDocument();
    fireEvent.click(within(expiredKeysDialog).getByRole("button", { name: "Close Expired keys investigation" }));

    fireEvent.click(promptWatchlistCard!);
    const watchlistDialog = screen.getByRole("dialog", { name: "Prompt watchlist" });
    expect(within(watchlistDialog).getByText("Social Security number")).toBeInTheDocument();
    expect(within(watchlistDialog).getByText(/Jane Smith.*gpt-4o.*high dlp/i)).toBeInTheDocument();
    fireEvent.click(within(watchlistDialog).getByRole("button", { name: "Close Prompt watchlist investigation" }));

    fireEvent.change(screen.getByLabelText("Prompt activity filter user"), { target: { value: "user-jane" } });
    fireEvent.change(screen.getByLabelText("Prompt activity filter start date"), {
      target: { value: "2026-07-06" },
    });
    fireEvent.change(screen.getByLabelText("Prompt activity filter end date"), {
      target: { value: "2026-07-06" },
    });
    expect(screen.getByText("Review DLP boundaries")).toBeInTheDocument();
    expect(screen.queryByText("Old DLP review")).not.toBeInTheDocument();
    expect(screen.queryByText("Owner model check")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export Jane Smith prompt activity CSV" }));
    fireEvent.change(screen.getByLabelText("Jane Smith prompt activity start date"), {
      target: { value: "2026-07-06" },
    });
    fireEvent.change(screen.getByLabelText("Jane Smith prompt activity end date"), {
      target: { value: "2026-07-06" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download 1 row" }));

    expect(downloadSpy.downloads[0]).toMatchObject({
      filename: "aperture-prompt-activity-jane-smith-2026-07-06_to_2026-07-06.csv",
    });
    const promptCsv = await readBlobAsText(downloadSpy.downloads[0].blob);
    expect(promptCsv).toContain("user_email");
    expect(promptCsv).toContain("jane.smith@example.com");
    expect(promptCsv).toContain("Review DLP boundaries");
    expect(promptCsv).not.toContain("Old DLP review");
    expect(promptCsv).not.toContain("Owner model check");

    selectTab("Analytics");
    await screen.findByRole("tabpanel", { name: "Analytics" });
    expandPanel("Model Activity");
    expect(await screen.findByLabelText("Model activity bar chart")).toBeInTheDocument();
    expect(screen.getByLabelText("Model usage line chart")).toBeInTheDocument();
    expect(screen.getByLabelText("Users by prompt activity")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    // The Model Activity section has its own user + date scope.
    fireEvent.change(screen.getByLabelText("Model activity filter user"), { target: { value: "user-jane" } });
    expect(screen.getByText("2 total prompts")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Model activity filter start date"), {
      target: { value: "2026-07-06" },
    });
    fireEvent.change(screen.getByLabelText("Model activity filter end date"), {
      target: { value: "2026-07-06" },
    });
    expect(screen.getByText("1 total prompts")).toBeInTheDocument();
  } finally {
    downloadSpy.restore();
  }
});

test("analytics and audit exports download date-range CSV files and keep long logs scrollable", async () => {
  const feedbackEvents: ChatFeedbackEvent[] = [
    {
      id: "feedback-current",
      thread_id: "thread-current",
      thread_title: "Current matter chat",
      message_id: "message-current",
      rating: "positive",
      message_preview: "Useful current answer.",
      model_id: "openrouter-openai-gpt-5-5",
      user_id: "user-owner",
      user_name: "Aperture Platform Owner",
      created_at: "2026-07-01T12:00:00+00:00",
    },
    {
      id: "feedback-old",
      thread_id: "thread-old",
      thread_title: "Older matter chat",
      message_id: "message-old",
      rating: "negative",
      message_preview: "Out of range answer.",
      model_id: "openrouter-openai-gpt-4o-mini",
      user_id: "user-owner",
      user_name: "Aperture Platform Owner",
      created_at: "2026-06-01T12:00:00+00:00",
    },
  ];
  window.localStorage.setItem(CHAT_FEEDBACK_STORAGE_KEY, JSON.stringify(feedbackEvents));
  const listAuditEvents = vi.fn(async () => [
    {
      id: "audit-current",
      tenant_id: null,
      actor_id: "user-owner",
      actor_name: "Aperture Platform Owner",
      actor_role: "PLATFORM_OWNER",
      action: "platform.model_status_changed",
      action_type: "MODEL_DISABLED",
      target: "gpt-4o",
      target_type: "model",
      target_name: "gpt-4o",
      detail: "platform_enabled=false",
      created_at: "2026-07-01T17:30:12+00:00",
      redacted: true,
      metadata: { platform_enabled: false },
    },
    {
      id: "audit-old",
      tenant_id: null,
      actor_id: "user-owner",
      actor_name: "Aperture Platform Owner",
      actor_role: "PLATFORM_OWNER",
      action: "platform.provider_key_revealed",
      action_type: "PROVIDER_KEY_REVEALED",
      target: "key-openrouter-primary",
      target_type: "provider-key",
      target_name: "OpenRouter Primary",
      detail: "secret_value=[redacted]",
      created_at: "2026-06-01T17:29:03+00:00",
      redacted: true,
      metadata: { secret_value: "[redacted]" },
    },
  ]);
  const downloadSpy = installCsvDownloadSpy();

  try {
    renderPlatform(platformOwnerData(), { listAuditEvents });

    selectTab("Analytics");
    await screen.findByRole("tabpanel", { name: "Analytics" });
    expandPanel("Chat Feedback");
    const feedbackList = await screen.findByLabelText("Chat feedback events");
    expect(feedbackList).toHaveClass("scrollable-log-list");
    fireEvent.click(screen.getByRole("button", { name: "Export chat feedback analytics CSV" }));
    fireEvent.change(screen.getByLabelText("chat feedback analytics start date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("chat feedback analytics end date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download 1 row" }));

    expect(downloadSpy.downloads[0]).toMatchObject({
      filename: "aperture-chat-feedback-2026-07-01_to_2026-07-01.csv",
    });
    const feedbackCsv = await readBlobAsText(downloadSpy.downloads[0].blob);
    expect(feedbackCsv).toContain("Current matter chat");
    expect(feedbackCsv).not.toContain("Older matter chat");

    selectTab("Audit");
    expandPanel("Audit Trail");
    const trail = await screen.findByRole("list", { name: "Audit events" });
    expect(trail).toHaveClass("scrollable-log-list");
    fireEvent.click(screen.getByRole("button", { name: "Export audit trail CSV" }));
    fireEvent.change(screen.getByLabelText("audit trail start date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("audit trail end date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download 1 row" }));

    expect(downloadSpy.downloads[1]).toMatchObject({
      filename: "aperture-audit-trail-2026-07-01_to_2026-07-01.csv",
    });
    const auditCsv = await readBlobAsText(downloadSpy.downloads[1].blob);
    expect(auditCsv).toContain("MODEL_DISABLED");
    expect(auditCsv).not.toContain("PROVIDER_KEY_REVEALED");
  } finally {
    downloadSpy.restore();
  }
});

test("platform analytics shows submitted issue reports beside sentiment", async () => {
  const listIssueReports = vi.fn(async () => [
    {
      id: "issue-owner-visible",
      tenant_id: sampleData.currentTenant.id,
      user_id: "user-jane",
      user_name: "Jane Smith",
      subject: "Export remains stuck",
      body: "PDF export remains on Preparing after two minutes.",
      screenshot_filename: null,
      screenshot_mime_type: null,
      screenshot_size_bytes: null,
      created_at: "2026-08-20T18:00:00Z",
    },
  ]);
  renderPlatform(platformOwnerData(), { listIssueReports });

  selectTab("Analytics");
  expandPanel("Chat Feedback");

  expect(await screen.findByText("Export remains stuck")).toBeInTheDocument();
  expect(screen.getByText("Issue reports").closest(".feedback-summary-card")).toHaveTextContent("1");
  fireEvent.click(screen.getByRole("button", { name: "Preview issue report: Export remains stuck" }));
  expect(screen.getByRole("dialog", { name: "Platform issue report" })).toHaveTextContent(
    "PDF export remains on Preparing after two minutes.",
  );
});

test("model edit details persists owner naming, route, and notes", async () => {
  const data = platformOwnerData();
  const updateModel = vi.fn(async (modelId: string, patch: Partial<ModelConfig>) => {
    const model = data.models.find((item) => item.id === modelId) as ModelConfig;
    return { ...model, ...patch };
  });

  renderPlatform(data, { updateModel });
  selectTab("Models");
  const modelItem = screen.getAllByText("gpt-4o-mini")[0].closest(".model-list-item") as HTMLElement;

  fireEvent.click(within(modelItem).getByRole("button", { name: "Edit details" }));
  fireEvent.change(await within(modelItem).findByLabelText("Display name"), { target: { value: "Azure Mini - ZDR" } });
  fireEvent.change(within(modelItem).getByLabelText("Runtime route"), { target: { value: "gpt-4o-mini-zdr" } });
  fireEvent.change(within(modelItem).getByLabelText("Notes"), { target: { value: "Use for ZDR tenant work." } });
  fireEvent.click(within(modelItem).getByRole("button", { name: "Save details" }));

  expect(await screen.findByText("Azure Mini - ZDR model details saved through the platform API.")).toBeInTheDocument();
  expect(updateModel).toHaveBeenCalledWith(
    "gpt-4o-mini",
    expect.objectContaining({
      name: "Azure Mini - ZDR",
      upstream_model_id: "gpt-4o-mini-zdr",
      notes: "Use for ZDR tenant work.",
    }),
  );
  expect(screen.getByText("Azure Mini - ZDR")).toBeInTheDocument();
  expect(screen.getByText("gpt-4o-mini-zdr")).toBeInTheDocument();
});

test("platform owner side panels manage users, policies, branding, and elastic settings", async () => {
  const data = platformOwnerData();
  const createUser = vi.fn(async (payload) => ({
    id: payload.id ?? "user-casey-admin",
    tenant_id: payload.tenant_id ?? data.currentTenant.id,
    email: payload.email,
    display_name: payload.display_name,
    role: payload.role,
    group_ids: payload.group_ids ?? [],
    active: payload.active ?? true,
    last_active: "Saved now",
    auth_method: "sso",
  }) satisfies User);
  const serverSettings = {
    downstream_api_enabled: true,
    require_sso_for_admins: false,
    users_can_create_models: false,
    tenant_admins_can_manage_sso: true,
    tenant_admins_can_create_admins: false,
    default_user_group_enabled: true,
    memory_enabled: false,
  };
  const getPlatformSettings = vi.fn(async () => serverSettings);
  const updatePlatformSettings = vi.fn(async (patch: Partial<typeof serverSettings>) => ({
    ...serverSettings,
    ...patch,
  }));
  const updateSsoConfig = vi.fn(async (_configId, patch) => ({
    ...data.ssoConfigs[0],
    name: patch.provider === "entra-id" ? "Microsoft Entra ID" : data.ssoConfigs[0].name,
    issuer: patch.issuer_url ?? data.ssoConfigs[0].issuer,
    client_id: patch.client_id ?? data.ssoConfigs[0].client_id,
    protocol: (patch.settings?.protocol as SsoConfig["protocol"] | undefined) ?? data.ssoConfigs[0].protocol,
    redirect_url: (patch.settings?.redirect_url as string | undefined) ?? data.ssoConfigs[0].redirect_url,
    entity_id: (patch.settings?.entity_id as string | undefined) ?? data.ssoConfigs[0].entity_id,
    saml_login_url: (patch.settings?.saml_login_url as string | undefined) ?? data.ssoConfigs[0].saml_login_url,
    saml_logout_url: (patch.settings?.saml_logout_url as string | undefined) ?? data.ssoConfigs[0].saml_logout_url,
    saml_certificate: (patch.settings?.saml_certificate as string | undefined) ?? data.ssoConfigs[0].saml_certificate,
    duo_api_hostname: (patch.settings?.duo_api_hostname as string | undefined) ?? data.ssoConfigs[0].duo_api_hostname,
    scim_base_url: (patch.settings?.scim_base_url as string | undefined) ?? data.ssoConfigs[0].scim_base_url,
    role_claim: (patch.settings?.role_claim as string | undefined) ?? data.ssoConfigs[0].role_claim,
    group_claim: (patch.settings?.group_claim as string | undefined) ?? data.ssoConfigs[0].group_claim,
    mfa_provider: (patch.settings?.mfa_provider as string | undefined) ?? data.ssoConfigs[0].mfa_provider,
    mfa_methods: (patch.settings?.mfa_methods as string[] | undefined) ?? data.ssoConfigs[0].mfa_methods,
    qr_enrollment_uri: (patch.settings?.qr_enrollment_uri as string | undefined) ?? data.ssoConfigs[0].qr_enrollment_uri,
    enforced: Boolean(patch.settings?.enforced ?? data.ssoConfigs[0].enforced),
  }) satisfies SsoConfig);
  const updateTenantBranding = vi.fn(async (tenantId: string, patch: Record<string, unknown>) => ({
    ...data.currentTenant,
    ...patch,
  }));
  const getElasticStatus = vi.fn(async () => ({
    configured: false,
    connected: false,
    endpoint: null,
    lastSync: "Not connected",
    eventsBuffered: 3,
    message: "Elastic analytics export is not configured. Set APERTURE_ELASTIC_URL and APERTURE_ELASTIC_API_KEY to enable it.",
  }));

  renderPlatform(data, { createUser, updateSsoConfig, getPlatformSettings, updatePlatformSettings, updateTenantBranding, getElasticStatus });
  selectTab("Org Settings");
  await screen.findByRole("tabpanel", { name: "Org Settings" });
  await waitFor(() => expect(getPlatformSettings).toHaveBeenCalled());

  // Every section arrives collapsed with a descriptive header; expand the
  // ones this test drives.
  expect(screen.getByText("Single Sign-On")).toBeInTheDocument();
  expect(screen.getByText("Platform Branding")).toBeInTheDocument();
  expandPanel("Role Boundary");
  expandPanel("Single Sign-On");
  expandPanel("Platform Branding");
  expandPanel("Policy Controls");
  expandPanel("Connectors");
  expandPanel("Elastic Analytics");
  const soleOwnerRow = screen.getByText("owner@aperture.local").closest(".owner-user-row") as HTMLElement;
  expect(within(soleOwnerRow).getByLabelText("Role for Aperture Platform Owner")).toBeDisabled();

  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Morgan Owner" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "morgan.owner@example.com" } });
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "PLATFORM_OWNER" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));

  expect(await screen.findByText("Morgan Owner account created through the admin API.")).toBeInTheDocument();
  expect(createUser).toHaveBeenCalledWith(
    expect.objectContaining({
      display_name: "Morgan Owner",
      email: "morgan.owner@example.com",
      role: "PLATFORM_OWNER",
      tenant_id: null,
    }),
  );
  expect(screen.getByText("Morgan Owner")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Casey Admin" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey.admin@example.com" } });
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "TENANT_ADMIN" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));

  expect(await screen.findByText("Casey Admin account created through the admin API.")).toBeInTheDocument();
  expect(createUser).toHaveBeenCalledWith(
    expect.objectContaining({
      display_name: "Casey Admin",
      email: "casey.admin@example.com",
      role: "TENANT_ADMIN",
      tenant_id: data.currentTenant.id,
    }),
  );
  expect(screen.getByText("Casey Admin")).toBeInTheDocument();

  const ownerOnlyRow = screen.getByText("Only owners can create platform owners").closest(".permission-row") as HTMLElement;
  expect(within(ownerOnlyRow).getByText("Always on")).toBeInTheDocument();

  const downstreamApiToggle = screen.getByRole("switch", { name: "Downstream API access" });
  await waitFor(() => expect(downstreamApiToggle).toHaveAttribute("aria-checked", "true"));
  fireEvent.click(downstreamApiToggle);
  await waitFor(() =>
    expect(updatePlatformSettings).toHaveBeenCalledWith({ downstream_api_enabled: false }),
  );
  expect(
    await screen.findByText("Downstream API access is disabled platform-wide. Existing keys are preserved but cannot authenticate."),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("switch", { name: "Tenant admins can create admins" }));
  await waitFor(() =>
    expect(updatePlatformSettings).toHaveBeenCalledWith({ tenant_admins_can_create_admins: true }),
  );
  expect(
    await screen.findByText("Tenant admins can create and manage other tenant admins under owner policy."),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("switch", { name: "Require SSO for admins" }));
  await waitFor(() =>
    expect(updatePlatformSettings).toHaveBeenCalledWith({ require_sso_for_admins: true }),
  );
  expect(
    await screen.findByText("Admin accounts must now sign in through SSO; local admin sign-in is rejected."),
  ).toBeInTheDocument();

  // Memory is the top of the four-tier cascade: nothing downstream can turn it
  // on until the owner does, so the toggle has to reach the settings API.
  fireEvent.click(screen.getByRole("switch", { name: "Personalization memory" }));
  await waitFor(() => expect(updatePlatformSettings).toHaveBeenCalledWith({ memory_enabled: true }));
  expect(
    await screen.findByText("Tenant admins can now enable personalization memory for their organization."),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("switch", { name: "Default group for enabled models" }));
  await waitFor(() =>
    expect(updatePlatformSettings).toHaveBeenCalledWith({ default_user_group_enabled: false }),
  );
  expect(
    await screen.findByText("Enabled models will no longer auto-include the default group."),
  ).toBeInTheDocument();

  // User agent authoring is an enforced organization ceiling: the toggle saves
  // users_can_create_models, and group grants sit underneath it.
  const userAgentsToggle = screen.getByRole("switch", {
    name: "Users can build their own agents",
  });
  expect(userAgentsToggle).toHaveAttribute("aria-checked", "false");
  expect(
    screen.getByText(
      "Only tenant admins and platform owners can create or edit agent profiles. Turn on to let admins grant Can build agents to specific groups.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(userAgentsToggle);
  await waitFor(() =>
    expect(updatePlatformSettings).toHaveBeenCalledWith({ users_can_create_models: true }),
  );
  expect(screen.queryByText("Production Gate")).not.toBeInTheDocument();
  expect(screen.getByText("Web Search")).toBeInTheDocument();
  expect(screen.getByText("Prompt Library")).toBeInTheDocument();
  expect(screen.getByText("Document Templates")).toBeInTheDocument();
  expect(screen.getByText("Audit and Analytics Export")).toBeInTheDocument();

  expect(screen.getByText("Authenticator enrollment QR")).toBeInTheDocument();
  expect(screen.getByLabelText("Client secret")).toBeInTheDocument();
  // OIDC keeps the form focused: SAML/SCIM plumbing only appears for those protocols.
  expect(screen.queryByLabelText("SAML login URL")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("SAML signing certificate")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("SCIM base URL")).not.toBeInTheDocument();
  // The real callback URL is displayed for registration with the IdP, plus a live test action.
  expect(screen.getByText("Redirect URI to register with your identity provider")).toBeInTheDocument();
  expect(screen.getByText(/\/api\/auth\/sso\/callback/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Test connection/ })).toBeEnabled();

  fireEvent.change(screen.getByLabelText("Client secret"), {
    target: { value: "oidc-client-secret" },
  });
  fireEvent.change(screen.getByLabelText("QR enrollment URI"), {
    target: { value: "otpauth://totp/Example:morgan.owner@example.com?secret=EXAMPLEONLY&issuer=Example" },
  });
  expect(document.querySelector(".sso-qr-code")).not.toBeInTheDocument();
  expect(screen.getByText("Use a valid TOTP/HOTP URI with a base32 secret of at least 16 characters.")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("QR enrollment URI"), {
    target: {
      value:
        "otpauth://totp/Example:morgan.owner%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30",
    },
  });
  expect(document.querySelector(".sso-qr-code")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save SSO" }));
  await waitFor(() =>
    expect(updateSsoConfig).toHaveBeenCalledWith(
      "sso-entra",
      expect.objectContaining({
        provider: "entra-id",
        client_id: "00000000-0000-0000-0000-000000000000",
        client_secret: "oidc-client-secret",
        settings: expect.objectContaining({
          protocol: "OIDC",
          client_secret_set: true,
          jit_provisioning: true,
          // The platform authenticator stays opt-in for SSO sign-ins: the
          // IdP's own MFA is trusted unless the owner turns this on.
          require_platform_mfa: false,
          group_claim: "groups",
          qr_enrollment_uri:
            "otpauth://totp/Example:morgan.owner%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30",
        }),
      }),
    ),
  );

  const brandingSection = screen.getByText("Platform Branding").closest(".platform-branding-panel") as HTMLElement;
  const brandingPreview = brandingSection.querySelector(".branding-preview") as HTMLElement;
  expect(within(brandingPreview).getByText("Aperture Chat")).toBeInTheDocument();
  expect(within(brandingPreview).queryByText("chat.example.com")).not.toBeInTheDocument();
  const uploadControl = within(brandingSection).getByText("Upload PNG").closest(".branding-file-button") as HTMLElement;
  const resetButton = within(brandingSection).getByRole("button", { name: "Reset defaults" });
  const applyButton = within(brandingSection).getByRole("button", { name: "Apply branding" });
  expect(uploadControl.compareDocumentPosition(applyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(resetButton.compareDocumentPosition(applyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const png = new File([new Uint8Array([137, 80, 78, 71])], "example-logo.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Upload PNG"), { target: { files: [png] } });
  // Branding feedback must render inside the panel, next to the Apply button.
  expect(
    await within(brandingSection).findByText(
      "example-logo.png is ready. Apply branding to update the platform shell and favicon.",
    ),
  ).toBeInTheDocument();
  expect((screen.getByLabelText("Platform logo URL") as HTMLInputElement).value).toMatch(/^data:image\/png/);
  expect((screen.getByLabelText("Browser icon URL") as HTMLInputElement).value).toMatch(/^data:image\/png/);

  fireEvent.change(screen.getByLabelText("Platform name"), { target: { value: "Example AI" } });
  fireEvent.change(screen.getByLabelText("Platform logo URL"), { target: { value: "https://assets.example.com/logo.png" } });
  fireEvent.change(screen.getByLabelText("Browser icon URL"), { target: { value: "https://assets.example.com/icon.svg" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply branding" }));
  expect(
    await within(brandingSection).findByText(
      "Example AI branding saved through the platform API and will persist across reloads.",
    ),
  ).toBeInTheDocument();
  expect(updateTenantBranding).toHaveBeenCalledWith(
    data.currentTenant.id,
    expect.objectContaining({ chat_brand_name: "Example AI", icon_url: "https://assets.example.com/icon.svg" }),
  );
  expect(screen.getAllByText("Example AI").length).toBeGreaterThan(0);

  // A one-sided gradient is rejected with a visible in-panel warning and no API call.
  fireEvent.change(within(brandingSection).getByLabelText(/^Sidebar gradient start$/, { selector: 'input:not([type="color"])' }), { target: { value: "#063243" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply branding" }));
  expect(
    await within(brandingSection).findByText(
      "Set both gradient colors (or clear both) so the sidebar gradient has a start and an end.",
    ),
  ).toBeInTheDocument();
  expect(updateTenantBranding).toHaveBeenCalledTimes(1);
  fireEvent.change(within(brandingSection).getByLabelText(/^Sidebar gradient start$/, { selector: 'input:not([type="color"])' }), { target: { value: "" } });

  fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
  expect(
    await within(brandingSection).findByText(
      "Default Aperture Chat branding saved through the platform API and will persist across reloads.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Platform name")).toHaveValue("Aperture Chat");
  expect(screen.getByLabelText("Platform logo URL")).toHaveValue("");
  expect(screen.getByLabelText("Browser icon URL")).toHaveValue("");
  expect(screen.getByLabelText("Platform domain")).toHaveValue("chat.example.com");

  // Elastic is configured from the backend environment. The panel reports that
  // state read-only rather than offering inputs and a Save that persist nothing.
  await waitFor(() => expect(getElasticStatus).toHaveBeenCalled());
  expect(screen.getByText("Not configured")).toBeInTheDocument();
  expect(screen.queryByLabelText("Elastic Cloud ID")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("API key secret")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Save connection/ })).not.toBeInTheDocument();
  // The panel names the environment variables that actually configure export.
  expect(screen.getByText("APERTURE_ELASTIC_API_KEY", { selector: "code" })).toBeInTheDocument();
}, 10_000);

test("owner directory exposes profile context for owner-visible accounts", async () => {
  const data = platformOwnerData();
  data.users = data.users.map((user) =>
    user.id === "user-owner"
      ? {
          ...user,
          firm_name: "Aperture Chat",
          bio: "Platform governance owner.",
          phone: "+1 555 0198",
          avatar_url: "https://images.example.test/aperture-owner.png",
          website_url: "https://aperture-chat.example",
        }
      : user,
  );
  data.me = data.users.find((user) => user.id === "user-owner")!;

  renderPlatform(data, {});
  selectTab("Org Settings");
  expandPanel("Role Boundary");

  const identity = screen.getByText("owner@aperture.local").closest(".owner-user-identity");
  const ownerRow = identity?.closest(".owner-user-row");
  expect(identity).toHaveAttribute(
    "data-tooltip",
    [
      "Aperture Platform Owner",
      "Email: owner@aperture.local",
      "Phone: +1 555 0198",
      "Position: Aperture Chat",
      "Bio: Platform governance owner.",
      "Website: https://aperture-chat.example",
      "Role: Platform Owner",
    ].join("\n"),
  );
  expect(ownerRow).toHaveAttribute("data-tooltip", identity?.getAttribute("data-tooltip"));
  expect(ownerRow?.querySelector(".mini-avatar img")).toHaveAttribute(
    "src",
    "https://images.example.test/aperture-owner.png",
  );
});

function renderPlatform(
  data: BootstrapData,
  actions: PlatformConsoleActions,
  relatedHelpProps: {
    onOpenAdminDocumentation?: () => void;
    onOpenUserHelp?: () => void;
  } = {},
) {
  function Harness() {
    const [currentData, setCurrentData] = useState(data);
    return (
      <PlatformConsole
        data={currentData}
        onDataChange={setCurrentData}
        platformActions={actions}
        {...relatedHelpProps}
      />
    );
  }
  return render(<Harness />);
}

function selectTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.keyDown(tab, { key: "Enter" });
  fireEvent.click(tab);
}

/** Sections in Org Settings and Audit start collapsed; expand one by its
 * panel title before interacting with its content. */
function expandPanel(title: string) {
  const heading = screen.getByRole("heading", { name: title });
  const panel = heading.closest(".panel") as HTMLElement;
  const toggle = within(panel).queryByRole("button", { name: "Expand panel" });
  if (toggle) fireEvent.click(toggle);
}

function platformOwnerData(): BootstrapData {
  return {
    ...(structuredClone(sampleData) as BootstrapData),
    me: {
      ...(structuredClone(sampleData.me) as BootstrapData["me"]),
      id: "user-owner",
      tenant_id: null,
      email: "owner@aperture.local",
      display_name: "Aperture Platform Owner",
      role: "PLATFORM_OWNER",
      group_ids: [],
    },
  };
}

test("owner sets a password from the role boundary user list", async () => {
  const resetUserPassword = vi.fn().mockResolvedValue(undefined);
  const data = platformOwnerData();
  data.users.push({
    id: "user-jordan",
    tenant_id: null,
    email: "jordan@aperture.local",
    display_name: "Jordan Lee",
    role: "PLATFORM_OWNER",
    group_ids: [],
    active: true,
    last_active: "Invited now",
    auth_method: "sso",
  });

  renderPlatform(data, { resetUserPassword });
  selectTab("Org Settings");
  await screen.findByRole("tabpanel", { name: "Org Settings" });
  expandPanel("Role Boundary");

  // The signed-in owner uses their own account panel, but invited owners need a first password.
  expect(screen.getByRole("button", { name: "Set a password for Aperture Platform Owner" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Set a password for Jordan Lee" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "Set a password for Jordan Lee" }));
  const ownerDialog = screen.getByRole("dialog", { name: /Set a password for Jordan Lee/ });
  fireEvent.change(within(ownerDialog).getByPlaceholderText("At least 12 characters"), {
    target: { value: "starter-password-123" },
  });
  fireEvent.click(within(ownerDialog).getByRole("button", { name: "Set password" }));

  await screen.findByText(/Password set for Jordan Lee/);
  expect(resetUserPassword).toHaveBeenCalledWith("user-jordan", {
    password: "starter-password-123",
    temporary: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Close password dialog" }));

  fireEvent.click(screen.getByRole("button", { name: "Set a password for Jane Smith" }));
  const dialog = screen.getByRole("dialog", { name: /Set a password for Jane Smith/ });
  fireEvent.change(within(dialog).getByPlaceholderText("At least 12 characters"), {
    target: { value: "starter-password-456" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Set password" }));

  await screen.findByText(/Password set for Jane Smith/);
  expect(resetUserPassword).toHaveBeenCalledWith(
    data.users.find((user) => user.display_name === "Jane Smith")!.id,
    { password: "starter-password-456", temporary: true },
  );
});

test("owner deletes users and admins after a confirm popup and deactivates owners", async () => {
  const deleteUser = vi.fn().mockResolvedValue(undefined);
  const deactivateUser = vi.fn().mockResolvedValue(undefined);
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
  const data = platformOwnerData();
  data.users.push({
    id: "user-jordan",
    tenant_id: null,
    email: "jordan@aperture.local",
    display_name: "Jordan Lee",
    role: "PLATFORM_OWNER",
    group_ids: [],
    active: true,
    last_active: "Invited now",
    auth_method: "sso",
  });

  renderPlatform(data, { deleteUser, deactivateUser });
  selectTab("Org Settings");
  await screen.findByRole("tabpanel", { name: "Org Settings" });
  expandPanel("Role Boundary");

  // Denying the popup leaves the account untouched.
  fireEvent.click(screen.getByRole("button", { name: "Remove Jane Smith" }));
  expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Permanently delete Jane Smith"));
  expect(deleteUser).not.toHaveBeenCalled();
  expect(screen.getByText("jane.smith@example.com")).toBeInTheDocument();

  // Confirming hard-deletes users and admins through the admin API.
  confirmSpy.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove Jane Smith" }));
  await screen.findByText("Jane Smith was permanently deleted through the admin API.");
  expect(deleteUser).toHaveBeenCalledWith("user-jane");
  expect(screen.queryByText("jane.smith@example.com")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Remove Alex Morgan" }));
  await screen.findByText("Alex Morgan was permanently deleted through the admin API.");
  expect(deleteUser).toHaveBeenCalledWith("user-admin");

  // Owner accounts deactivate instead of delete, still behind the popup.
  fireEvent.click(screen.getByRole("button", { name: "Remove Jordan Lee" }));
  expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Deactivate Jordan Lee"));
  await screen.findByText("Jordan Lee deactivated through the admin API.");
  expect(deactivateUser).toHaveBeenCalledWith("user-jordan");

  // The signed-in owner can never remove their own account.
  expect(screen.getByRole("button", { name: "Remove Aperture Platform Owner" })).toBeDisabled();

  confirmSpy.mockRestore();
});

test("owner alerts tab saves SMTP settings without echoing the password and shows real test failures", async () => {
  const updateEmailSettings = vi.fn(async () => ({
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    username: "mailer@example.com",
    from_address: "alerts@example.com",
    password_set: true,
    masked_password: "sm••••••••",
    last_test_at: null,
    last_test_status: null,
    updated_at: null,
  }));
  const sendEmailTest = vi.fn(async () => ({
    status: "failed",
    detail: "535 authentication failed",
  }));
  const actions: PlatformConsoleActions = {
    listAlertRules: vi.fn(async () => []),
    createAlertRule: vi.fn(async () => undefined),
    updateAlertRule: vi.fn(async () => undefined),
    deleteAlertRule: vi.fn(async () => undefined),
    listAlertNotifications: vi.fn(async () => []),
    getEmailSettings: vi.fn(async () => ({
      host: "",
      port: 587,
      security: "starttls",
      username: "",
      from_address: "",
      password_set: false,
      masked_password: "",
      last_test_at: null,
      last_test_status: null,
      updated_at: null,
    })),
    updateEmailSettings,
    sendEmailTest,
  };

  renderPlatform(platformOwnerData(), actions);
  selectTab("Alerts");

  const hostInput = await screen.findByLabelText("SMTP host");
  fireEvent.change(hostInput, { target: { value: "smtp.example.com" } });
  fireEvent.change(screen.getByLabelText("Alert from address"), {
    target: { value: "alerts@example.com" },
  });
  fireEvent.change(screen.getByLabelText("SMTP username"), {
    target: { value: "mailer@example.com" },
  });
  const passwordInput = screen.getByLabelText("SMTP password");
  fireEvent.change(passwordInput, { target: { value: "s3cret-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Email Settings" }));

  await waitFor(() => expect(updateEmailSettings).toHaveBeenCalled());
  expect(updateEmailSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      host: "smtp.example.com",
      from_address: "alerts@example.com",
      username: "mailer@example.com",
      password: "s3cret-value",
    }),
  );
  await waitFor(() => expect(passwordInput).toHaveValue(""));
  expect(await screen.findByText("SMTP settings saved.")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Test email recipient"), {
    target: { value: "owner@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Send test email/ }));
  await waitFor(() => expect(sendEmailTest).toHaveBeenCalledWith("owner@example.com"));
  expect(await screen.findByText("535 authentication failed")).toBeInTheDocument();
});

test("owner alert rules list labels every rule with its scope", async () => {
  const baseRule = {
    description: "",
    enabled: true,
    action_patterns: ["security.*"],
    min_severity: "warning",
    actor_ids: [],
    threshold_count: 1,
    window_minutes: 60,
    cooldown_minutes: 60,
    recipients: [],
    created_by: "user-owner",
    created_by_name: "Riley Owner",
    created_at: "2026-07-15T09:00:00+00:00",
    updated_at: "2026-07-15T09:00:00+00:00",
    last_triggered_at: null,
  };
  const actions: PlatformConsoleActions = {
    listAlertRules: vi.fn(async () => [
      { ...baseRule, id: "alertrule-platform", scope: "platform", tenant_id: null, name: "Owner watch" },
      { ...baseRule, id: "alertrule-tenant", scope: "tenant", tenant_id: "tenant-example", name: "Tenant watch" },
    ]),
    createAlertRule: vi.fn(async () => undefined),
    updateAlertRule: vi.fn(async () => undefined),
    deleteAlertRule: vi.fn(async () => undefined),
    listAlertNotifications: vi.fn(async () => []),
    getEmailSettings: vi.fn(async () => ({
      host: "",
      port: 587,
      security: "starttls",
      username: "",
      from_address: "",
      password_set: false,
      masked_password: "",
      last_test_at: null,
      last_test_status: null,
      updated_at: null,
    })),
    updateEmailSettings: vi.fn(async () => undefined),
    sendEmailTest: vi.fn(async () => undefined),
  };

  renderPlatform(platformOwnerData(), actions);
  selectTab("Alerts");

  expect(await screen.findByText("Owner watch")).toBeInTheDocument();
  expect(screen.getByText("Tenant watch")).toBeInTheDocument();
  expect(screen.getByText("platform")).toBeInTheDocument();
  expect(screen.getByText("tenant")).toBeInTheDocument();
});

test("owner archives an alert delivery and can reveal and restore it", async () => {
  const notification = {
    id: "notification-1",
    rule_id: "alertrule-platform",
    rule_name: "Owner watch",
    scope: "platform",
    tenant_id: null,
    event_id: "audit-1",
    event_action: "security.prompt_flagged",
    event_severity: "warning",
    actor_id: "user-jane",
    actor_name: "Jane Smith",
    summary: "security.prompt_flagged by Jane Smith",
    matched_count: 1,
    recipients: [],
    status: "logged",
    status_detail: "Logged in-app",
    attempts: 0,
    archived: false,
    created_at: "2026-07-30T09:00:00+00:00",
    delivered_at: null,
  };
  const setAlertNotificationArchived = vi.fn(async (notificationId: string, archived: boolean) => ({
    ...notification,
    id: notificationId,
    archived,
  }));
  const actions: PlatformConsoleActions = {
    listAlertRules: vi.fn(async () => []),
    createAlertRule: vi.fn(async () => undefined),
    updateAlertRule: vi.fn(async () => undefined),
    deleteAlertRule: vi.fn(async () => undefined),
    listAlertNotifications: vi.fn(async () => [notification]),
    setAlertNotificationArchived,
  };

  renderPlatform(platformOwnerData(), actions);
  selectTab("Alerts");

  const deliveries = await screen.findByRole("list", { name: "Alert deliveries" });
  expect(within(deliveries).getByText("Owner watch")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Archive Owner watch delivery" }));
  await waitFor(() => expect(setAlertNotificationArchived).toHaveBeenCalledWith("notification-1", true));
  // Archived rows leave the default view and the toggle appears.
  expect(await screen.findByText("Every delivery is archived")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Show archived \(1\)/ }));
  const archivedRow = screen.getByText("Owner watch").closest(".alert-delivery-row") as HTMLElement;
  expect(archivedRow).toHaveClass("is-archived");
  expect(within(archivedRow).getByText("Archived")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Restore Owner watch delivery" }));
  await waitFor(() => expect(setAlertNotificationArchived).toHaveBeenLastCalledWith("notification-1", false));
});

test("owner usage picker includes platform owners", async () => {
  const data = platformOwnerData();
  const owner = data.users.find((user) => user.role === "PLATFORM_OWNER")!;
  const actions: PlatformConsoleActions = {
    getUsageSummary: vi.fn(async () => ({
      totals: {
        messages: 1,
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        active_users: 1,
        models_used: 1,
        tokens_reported_messages: 1,
      },
      by_user: [
        {
          user_id: owner.id,
          user_name: owner.display_name,
          user_role: "PLATFORM_OWNER",
          message_count: 1,
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          model_count: 1,
          surfaces: ["chat"],
          last_active_at: "2026-07-15T10:00:00+00:00",
        },
      ],
      by_model: [],
      by_day: [{ date: "2026-07-15", message_count: 1, total_tokens: 15 }],
      by_surface: [{ surface: "chat", message_count: 1 }],
      backfilled_record_count: 0,
    })),
    listUsageRecords: vi.fn(async () => []),
  };

  renderPlatform(data, actions);
  selectTab("Analytics");

  // Both the section header picker and the panel filter list the owner.
  expandPanel("User Usage");
  const usagePicker = await screen.findByLabelText("Focus usage on one user");
  expect(within(usagePicker).getByText(owner.display_name)).toBeInTheDocument();
  const usageFilterPicker = screen.getByLabelText("Usage filter user");
  expect(within(usageFilterPicker).getByText(owner.display_name)).toBeInTheDocument();
});

// --- Tenant lifecycle, SCIM tokens, and usage budgets -----------------------
// These surfaces talk straight to the platform API, so the tests mock fetch
// per-endpoint and assert against the exact backend response shapes.

function jsonResponse(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function tenantSummaryRow(overrides: Partial<PlatformTenantSummary> = {}): PlatformTenantSummary {
  return {
    id: "tenant-acme",
    name: "Acme Legal",
    slug: "acme-legal",
    custom_domain: null,
    primary_color: "#087d8b",
    logo_mark: "aperture",
    chat_brand_name: "Acme Chat",
    logo_url: null,
    icon_url: null,
    gradient_start: null,
    gradient_end: null,
    text_color: null,
    user_count: 4,
    group_count: 2,
    scim_token_count: 0,
    ...overrides,
  };
}

function requestMethod(init: RequestInit | undefined): string {
  return init?.method ?? "GET";
}

test("platform console has no tenant management tab", () => {
  renderPlatform(platformOwnerData(), {});
  expect(screen.queryByRole("tab", { name: "Tenants" })).not.toBeInTheDocument();
});

test("workspace budget pins to the deployment tenant and labels zero as unlimited", async () => {
  const data = platformOwnerData();
  const budgetRequests: Array<{ method: string; tenantHeader: string | null; body: unknown }> = [];
  let limitValue = 0;
  let budgetUnit: "tokens" | "usd" = "tokens";
  let budgetPeriod: "day" | "week" | "month" = "day";
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const requestInit = init as RequestInit | undefined;
    const method = requestMethod(requestInit);
    if (url.endsWith("/api/platform/usage-budget")) {
      const headers = (requestInit?.headers ?? {}) as Record<string, string>;
      const body = requestInit?.body === undefined ? undefined : JSON.parse(String(requestInit.body));
      budgetRequests.push({ method, tenantHeader: headers["X-Aperture-Tenant"] ?? null, body });
      if (method === "PATCH") {
        const update = body as {
          budget_unit: "tokens" | "usd";
          budget_period: "day" | "week" | "month";
          limit_value: number;
        };
        budgetUnit = update.budget_unit;
        budgetPeriod = update.budget_period;
        limitValue = update.limit_value;
      }
      return jsonResponse({
        tenant_id: data.currentTenant.id,
        budget_unit: budgetUnit,
        budget_period: budgetPeriod,
        limit_value: limitValue,
        daily_token_limit: budgetUnit === "tokens" ? limitValue : 0,
        spend_limit_nanos: budgetUnit === "usd" ? limitValue * 1_000_000_000 : 0,
        updated_at: "2026-07-20T08:00:00+00:00",
        updated_by: "user-owner",
        usage_date: "2026-07-20",
        period_start: "2026-07-20",
        period_end: "2026-07-20",
        reported_tokens: 12345,
        reported_tokens_overflowed: false,
        reported_cost_nanos: 12500000,
        reported_cost_usd: 0.0125,
        reported_cost_overflowed: false,
        metered_completions: 7,
        unmetered_completions: 2,
        cost_metered_completions: 6,
        cost_unmetered_completions: 3,
      });
    }
    return jsonResponse({ detail: `Unexpected request ${method} ${url}` }, { status: 500 });
  });

  renderPlatform(data, {});
  selectTab("Org Settings");
  expandPanel("Workspace Usage Budget");

  // The budget loads immediately, pinned to the deployment's tenant — no
  // tenant picker exists anywhere.
  expect(await screen.findByText(/12,345/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Budget tenant")).not.toBeInTheDocument();
  expect(budgetRequests[0]).toMatchObject({
    method: "GET",
    tenantHeader: data.currentTenant.slug,
  });

  const limitInput = screen.getByLabelText("Token budget limit");
  fireEvent.change(limitInput, { target: { value: "50000" } });
  fireEvent.click(screen.getByRole("button", { name: /Save budget policy/ }));
  expect(await screen.findByText(/Workspace ceiling saved at 50,000 tokens daily\./)).toBeInTheDocument();
  const patch = budgetRequests.find((request) => request.method === "PATCH");
  expect(patch).toMatchObject({
    tenantHeader: data.currentTenant.slug,
    body: { budget_unit: "tokens", budget_period: "day", limit_value: 50000 },
  });

  fireEvent.change(screen.getByLabelText("Budget measure"), { target: { value: "usd" } });
  fireEvent.change(screen.getByLabelText("Budget reset period"), { target: { value: "month" } });
  fireEvent.change(screen.getByLabelText("Dollar budget limit"), { target: { value: "125.50" } });
  fireEvent.click(screen.getByRole("button", { name: /Save budget policy/ }));
  expect(await screen.findByText(/Workspace ceiling saved at \$125\.50 monthly\./)).toBeInTheDocument();
  expect(budgetRequests.at(-1)).toMatchObject({
    tenantHeader: data.currentTenant.slug,
    body: { budget_unit: "usd", budget_period: "month", limit_value: 125.5 },
  });

  fireEvent.change(screen.getByLabelText("Dollar budget limit"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: /Save budget policy/ }));
  expect(await screen.findByText(/Workspace ceiling saved as unlimited/)).toBeInTheDocument();
});

test("workspace budget surfaces backend 429 detail with its Retry-After wait", async () => {
  const data = platformOwnerData();
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = requestMethod(init as RequestInit | undefined);
    if (url.endsWith("/api/platform/usage-budget") && method === "GET") {
      return jsonResponse(
        { detail: "The workspace daily token budget has been reached. Requests are blocked until the next UTC day." },
        { status: 429, headers: { "Retry-After": "3600" } },
      );
    }
    return jsonResponse({ detail: `Unexpected request ${method} ${url}` }, { status: 500 });
  });

  renderPlatform(data, {});
  selectTab("Org Settings");
  expandPanel("Workspace Usage Budget");

  expect(
    await screen.findByText(/workspace daily token budget has been reached/),
  ).toBeInTheDocument();
});

test("sso protocol picker labels SAML as deferred and not selectable", async () => {
  renderPlatform(platformOwnerData(), {});
  selectTab("Org Settings");
  await screen.findByRole("tabpanel", { name: "Org Settings" });
  expandPanel("Single Sign-On");

  const samlOption = screen.getByRole("option", {
    name: "SAML — Deferred, not a working sign-in path",
  }) as HTMLOptionElement;
  expect(samlOption.disabled).toBe(true);
  expect(screen.getByRole("option", { name: "OIDC (supported)" })).toBeInTheDocument();
});


test("every analytics and audit section carries its own user and date filter", async () => {
  renderPlatform(platformOwnerData(), {});
  expect(screen.getByRole("tablist", { name: "Platform owner sections" })).toHaveClass(
    "management-console-tabs",
  );
  selectTab("Analytics");
  expandPanel("Runtime Clock Metadata");
  expandPanel("Chat Feedback");
  expandPanel("Model Activity");
  expandPanel("User Usage");
  const runtimeFilter = await screen.findByLabelText("Runtime events filter user");
  expect(runtimeFilter).toBeInTheDocument();
  expect(
    document.querySelector('[aria-label="Runtime events filter"] [aria-label="Runtime events filter user"]'),
  ).not.toBeNull();
  expect(runtimeFilter.closest(".date-range-filter")).toHaveClass("has-extra");
  expect(screen.getByLabelText("Chat feedback filter user")).toBeInTheDocument();
  expect(screen.getByLabelText("Model activity filter user")).toBeInTheDocument();
  expect(screen.getByLabelText("Usage filter user")).toBeInTheDocument();

  selectTab("Audit");
  expandPanel("User Prompt Activity");
  expandPanel("Security Alerts");
  expandPanel("Audit Trail");
  const promptFilter = await screen.findByLabelText("Prompt activity filter user");
  expect(within(promptFilter).getByRole("option", { name: "All users" })).toBeInTheDocument();
  expect(
    document.querySelector('[aria-label="Prompt activity filter"] [aria-label="Prompt activity filter user"]'),
  ).not.toBeNull();
  expect(screen.getByLabelText("Security alert filter user")).toBeInTheDocument();
  expect(screen.getByLabelText("Audit trail filter user")).toBeInTheDocument();
});

test("owner org settings includes the data retention panel with a working toggle", async () => {
  const policy = {
    tenant_id: "tenant-synthetic",
    enabled: false,
    chat_retention_days: 0,
    retention_basis: "last_activity" as const,
    action: "purge" as const,
    grace_days: 0,
    notify_admins: false,
    mcp_tagging_enabled: false,
    attachment_tagging_enabled: false,
    subject_tagging_enabled: false,
    external_tags_enabled: false,
    rules: [],
    updated_at: "",
  };
  const getRetentionPolicy = vi.fn(async () => policy);
  const updateRetentionPolicy = vi.fn(
    async (patch: { mcp_tagging_enabled?: boolean }) => ({ ...policy, ...patch }),
  );
  const listRetentionThreads = vi.fn(async () => []);

  renderPlatform(platformOwnerData(), {
    getRetentionPolicy,
    updateRetentionPolicy,
    listRetentionThreads,
  });
  selectTab("Org Settings");

  expect(await screen.findByRole("heading", { name: "Data Retention" })).toBeInTheDocument();
  expandPanel("Data Retention");
  const toggle = await screen.findByRole("switch", { name: "Tag chats that use MCP connections" });
  await waitFor(() => expect(toggle).not.toBeDisabled());
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(updateRetentionPolicy).toHaveBeenCalledWith({ mcp_tagging_enabled: true }),
  );
  expect(await screen.findByText("Retention policy saved.")).toBeInTheDocument();
});

test("owner audit prompt panel has a tags view with the chat list", async () => {
  const listRetentionThreads = vi.fn(async () => [
    {
      thread_id: "thread-owner-tagged",
      title: "Owner tagged chat",
      owner_user_id: "user-jane",
      tags: [
        {
          id: "tag-owner-1",
          tenant_id: "tenant-synthetic",
          thread_id: "thread-owner-tagged",
          namespace: "subject",
          key: "legal",
          value: "litigation",
          source: "auto" as const,
          applied_at: "2026-08-16T00:00:00Z",
        },
      ],
    },
  ]);

  renderPlatform(platformOwnerData(), { listRetentionThreads });
  selectTab("Audit");
  expandPanel("User Prompt Activity");
  fireEvent.click(screen.getByRole("button", { name: "Tags" }));

  expect(await screen.findByText("Owner tagged chat")).toBeInTheDocument();
  expect(screen.getByText("subject: legal / litigation")).toBeInTheDocument();
});

test("clicking a feedback entry previews the note and the full rendered conversation", async () => {
  const listChatFeedback = vi.fn(async () => [
    {
      id: "feedback-1",
      tenant_id: "tenant-synthetic",
      user_id: "user-jane",
      user_name: "Jane Smith",
      thread_id: "thread-fb-1",
      thread_title: "Escrow question",
      message_id: "msg-reply-2",
      rating: "negative" as const,
      comment: "It cited the wrong clause.",
      message_preview: "**The** escrow terms are...",
      model_id: "model-synthetic",
      created_at: "2026-08-17T12:00:00Z",
      updated_at: "2026-08-17T12:00:00Z",
    },
  ]);
  const listThreadPromptActivity = vi.fn(async () => [
    {
      id: "prompt-2",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane@example.test",
      thread_id: "thread-fb-1",
      thread_title: "Escrow question",
      model_id: "model-synthetic",
      content: "Second question about escrow",
      created_at: "12:05 PM",
      created_at_iso: "2026-08-17T12:05:00Z",
      alert_count: 0,
      response_message_id: "msg-reply-2",
      response_content: "**Rated** answer about escrow",
    },
    {
      id: "prompt-1",
      user_id: "user-jane",
      user_name: "Jane Smith",
      user_email: "jane@example.test",
      thread_id: "thread-fb-1",
      thread_title: "Escrow question",
      model_id: "model-synthetic",
      content: "First question about escrow",
      created_at: "12:00 PM",
      created_at_iso: "2026-08-17T12:00:00Z",
      alert_count: 0,
      response_message_id: "msg-reply-1",
      response_content: "Earlier answer",
    },
  ]);

  renderPlatform(platformOwnerData(), { listChatFeedback, listThreadPromptActivity });
  const analyticsTab = await screen.findByRole("tab", { name: "Analytics" });
  fireEvent.mouseDown(analyticsTab, { button: 0, ctrlKey: false });
  fireEvent.click(analyticsTab);
  expandPanel("Chat Feedback");

  // The list preview reads as plain prose (markdown stripped) and carries a
  // visible Preview affordance so the row is clearly clickable.
  expect(await screen.findByText("The escrow terms are...")).toBeInTheDocument();
  expect(screen.queryByText("**The** escrow terms are...")).not.toBeInTheDocument();
  const feedbackRow = screen.getByRole("button", {
    name: "Preview feedback and conversation: Escrow question",
  });
  expect(within(feedbackRow).getByText("Preview")).toBeInTheDocument();

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Preview feedback and conversation: Escrow question",
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Feedback and conversation" });
  // The written note is front and center.
  expect(within(dialog).getByText("“It cited the wrong clause.”")).toBeInTheDocument();
  // The whole conversation renders, oldest first, as real formatted text —
  // the markdown emphasis becomes a <strong>, not literal asterisks.
  expect(await within(dialog).findByText("First question about escrow")).toBeInTheDocument();
  expect(within(dialog).getByText("Second question about escrow")).toBeInTheDocument();
  expect(within(dialog).getByText("Rated")).toBeInTheDocument();
  expect(within(dialog).queryByText("**Rated** answer about escrow")).not.toBeInTheDocument();
  expect(within(dialog).getByText("Rated exchange")).toBeInTheDocument();
  expect(within(dialog).getByText(/2 exchanges in this conversation/)).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole("button", { name: "Close feedback preview" }));
  expect(screen.queryByRole("dialog", { name: "Feedback and conversation" })).not.toBeInTheDocument();
});
