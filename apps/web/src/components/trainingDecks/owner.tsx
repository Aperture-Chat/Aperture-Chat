import { BellRing, Clock3, DatabaseZap, Edit3, KeyRound, Lock, Mail, Palette, QrCode, ShieldAlert, UserPlus } from "lucide-react";
import { TrainingDocumentationModal, type TrainingDeck } from "../TrainingVideoLibrary";
import type { FocusRegion, TrainingVideoBase } from "../trainingVideoKit";

/* Frames are real captures of the current Platform Owner Console
 * (apps/web/scripts/capture-owner-frames.cjs documents the pipeline). */

export type OwnerFocus =
  | "addProvider"
  | "providerCard"
  | "providerStats"
  | "providerCardActions"
  | "vaultPanel"
  | "vaultKeyRow"
  | "vaultKeyActions"
  | "modelsSearch"
  | "modelsColumnFilters"
  | "modelsToggle"
  | "rolesDisclosure"
  | "rolesCreateForm"
  | "rolesSetPassword"
  | "rolesUserRows"
  | "ssoIntro"
  | "ssoProtocol"
  | "ssoFields"
  | "ssoRedirect"
  | "ssoToggles"
  | "ssoSaveTest"
  | "ssoEnforce"
  | "brandPreview"
  | "brandFields"
  | "brandThemeColors"
  | "brandActions"
  | "policyCollapsed"
  | "policyFloor"
  | "policyToggles"
  | "budgetControls"
  | "sharedConnectors"
  | "analyticsFilters"
  | "runtimeScorecards"
  | "runtimeRows"
  | "activityCharts"
  | "usageScorecards"
  | "usageCharts"
  | "usageByUser"
  | "auditCriticalTile"
  | "auditTileGrid"
  | "auditSecurityAlerts"
  | "trailFilters"
  | "trailRows"
  | "alertSmtp"
  | "alertRules"
  | "alertTemplates"
  | "alertDeliveries"
  | "retentionNavigation"
  | "retentionWorkspace"
  | "retentionSources"
  | "retentionSensitive"
  | "retentionHolds"
  | "retentionSchedulePreview"
  | "retentionPanel"
  | "retentionToggles"
  | "retentionTagsSwitch"
  | "retentionTagsExplorer"
  | "retentionPreview"
  | "retentionBatch"
  | "firstOwnerSetup"
  | "firstOwnerWelcome"
  | "firstProviderValidated"
  | "firstWorkspaceAccess"
  | "firstWorkspaceReply"
  | "searchIndex"
  | "modelBrowsingPolicy";

export const OWNER_FOCUS_REGIONS: Record<OwnerFocus, FocusRegion> = {
  searchIndex: { frame: "training/owner/search-index.png", rect: { x: 261, y: 246, w: 889, h: 226 } },
  modelBrowsingPolicy: { frame: "training/owner/model-browsing-policy.png", rect: { x: 285.90625, y: 405.75, w: 839.1875, h: 44 } },
  addProvider: { frame: "training/owner/providers.png", rect: { x: 940, y: 279, w: 141, h: 45 } },
  providerCard: { frame: "training/owner/providers.png", rect: { x: 282, y: 382, w: 420, h: 340 } },
  providerStats: { frame: "training/owner/provider-catalog.png", rect: { x: 376, y: 706, w: 308, h: 87 } },
  providerCardActions: { frame: "training/owner/providers.png", rect: { x: 376, y: 613, w: 308, h: 91 } },
  // vault/audit/alerts frames are local-stack re-captures with staged synthetic
  // keys, events, rules, and deliveries; rects measured from the live DOM.
  vaultPanel: { frame: "training/owner/vault.png", rect: { x: 300, y: 390, w: 811, h: 165 } },
  vaultKeyRow: { frame: "training/owner/vault.png", rect: { x: 300, y: 496, w: 800, h: 59 } },
  vaultKeyActions: { frame: "training/owner/vault.png", rect: { x: 989, y: 496, w: 111, h: 49 } },
  modelsSearch: { frame: "training/owner/models.png", rect: { x: 583, y: 269, w: 500, h: 45 } },
  modelsColumnFilters: { frame: "training/owner/models.png", rect: { x: 283, y: 363, w: 845, h: 48 } },
  modelsToggle: { frame: "training/owner/models.png", rect: { x: 849, y: 418, w: 47, h: 30 } },
  rolesDisclosure: { frame: "training/owner/roles.png", rect: { x: 262, y: 0, w: 887, h: 90 } },
  rolesCreateForm: { frame: "training/owner/roles.png", rect: { x: 282, y: 104, w: 847, h: 142 } },
  rolesSetPassword: { frame: "training/owner/roles.png", rect: { x: 1027, y: 338, w: 45, h: 45 } },
  rolesUserRows: { frame: "training/owner/roles.png", rect: { x: 282, y: 262, w: 847, h: 527 } },
  ssoIntro: { frame: "training/owner/sso.png", rect: { x: 262, y: 0, w: 887, h: 90 } },
  ssoProtocol: { frame: "training/owner/sso.png", rect: { x: 708, y: 104, w: 421, h: 66 } },
  ssoFields: { frame: "training/owner/sso.png", rect: { x: 282, y: 104, w: 847, h: 751 } },
  ssoRedirect: { frame: "training/owner/sso.png", rect: { x: 282, y: 381, w: 847, h: 90 } },
  ssoToggles: { frame: "training/owner/sso-actions.png", rect: { x: 282, y: 237, w: 847, h: 163 } },
  ssoSaveTest: { frame: "training/owner/sso-actions.png", rect: { x: 282, y: 405, w: 847, h: 45 } },
  ssoEnforce: { frame: "training/owner/sso-actions.png", rect: { x: 282, y: 349, w: 847, h: 51 } },
  brandPreview: { frame: "training/owner/branding.png", rect: { x: 282, y: 85, w: 847, h: 87 } },
  brandFields: { frame: "training/owner/branding.png", rect: { x: 282, y: 186, w: 847, h: 539 } },
  brandThemeColors: { frame: "training/owner/branding.png", rect: { x: 282, y: 370, w: 847, h: 255 } },
  brandActions: { frame: "training/owner/branding-actions.png", rect: { x: 285.90625, y: 358.75, w: 839.1875, h: 88 } },
  // A 4:3 camera zoom removes the capture tool's unused right/bottom canvas
  // while preserving the native console text. Expanded sections use dedicated
  // scrolled frames, and rects are measured in the final zoomed composition.
  policyCollapsed: { frame: "training/owner/policies-current-collapsed.png", rect: { x: 261, y: 528, w: 889, h: 98 } },
  // The enforced-floor row sits above the toggle stack in the toggles frame,
  // inside the readable-viewport envelope pinned by trainingVideoKit.test.ts;
  // sharing the frame with policyToggles glides the highlight down the stack.
  policyFloor: { frame: "training/owner/policies-toggles-current.png", rect: { x: 282, y: 190, w: 847, h: 51 } },
  policyToggles: { frame: "training/owner/policies-toggles-current.png", rect: { x: 262, y: 170, w: 887, h: 515 } },
  budgetControls: { frame: "training/owner/policies-budget-current.png", rect: { x: 283, y: 390, w: 845, h: 94 } },
  // The legacy filename is retained; recapture the new owner Connectors panel
  // and apply its measured bounds before publishing the reconciled UI.
  sharedConnectors: { frame: "training/owner/policies-callout-current.png", rect: { x: 262, y: 382, w: 887, h: 91 } },
  analyticsFilters: { frame: "training/owner/analytics.png", rect: { x: 276, y: 98, w: 859, h: 154 } },
  runtimeScorecards: { frame: "training/owner/analytics.png", rect: { x: 262, y: 245, w: 887, h: 156 } },
  runtimeRows: { frame: "training/owner/analytics.png", rect: { x: 262, y: 408, w: 887, h: 447 } },
  activityCharts: { frame: "training/owner/analytics-activity.png", rect: { x: 262, y: 224, w: 887, h: 277 } },
  usageScorecards: { frame: "training/owner/analytics-usage.png", rect: { x: 262, y: 264, w: 887, h: 156 } },
  usageCharts: { frame: "training/owner/analytics-usage.png", rect: { x: 262, y: 427, w: 887, h: 277 } },
  usageByUser: { frame: "training/owner/analytics-usage-users.png", rect: { x: 262, y: 638, w: 887, h: 190 } },
  auditCriticalTile: { frame: "training/owner/audit.png", rect: { x: 282, y: 342, w: 166, h: 139 } },
  auditTileGrid: { frame: "training/owner/audit.png", rect: { x: 262, y: 322, w: 887, h: 467 } },
  auditSecurityAlerts: { frame: "training/owner/audit-alerts.png", rect: { x: 276, y: 419, w: 859, h: 154 } },
  trailFilters: { frame: "training/owner/audit-trail.png", rect: { x: 262, y: 742, w: 887, h: 85 } },
  trailRows: { frame: "training/owner/audit-trail.png", rect: { x: 895, y: 518, w: 81, h: 45 } },
  alertSmtp: { frame: "training/owner/alerts.png", rect: { x: 261, y: 234, w: 889, h: 459 } },
  alertRules: { frame: "training/owner/alerts-deliveries.png", rect: { x: 261, y: 0, w: 889, h: 302 } },
  alertTemplates: { frame: "training/owner/alerts-deliveries.png", rect: { x: 726, y: 31, w: 403, h: 45 } },
  alertDeliveries: { frame: "training/owner/alerts-deliveries.png", rect: { x: 262, y: 419, w: 887, h: 436 } },
  retentionNavigation: { frame: "training/owner/retention-navigation.png", rect: { x: 649, y: 163, w: 61, h: 53 } },
  retentionWorkspace: { frame: "training/owner/retention-workspace.png", rect: { x: 257.90625, y: 382.75, w: 895.1875, h: 90 } },
  retentionSources: { frame: "training/owner/retention-sources.png", rect: { x: 277.90625, y: 413.0625, w: 855.1875, h: 308.875 } },
  retentionSensitive: { frame: "training/owner/retention-sensitive.png", rect: { x: 277.90625, y: 410.9375, w: 855.1875, h: 34 } },
  retentionHolds: { frame: "training/owner/retention-holds.png", rect: { x: 296.90625, y: 318.703125, w: 817.1875, h: 216.875 } },
  retentionSchedulePreview: { frame: "training/owner/retention-schedule-preview.png", rect: { x: 277.90625, y: 367.25, w: 855.1875, h: 178.875 } },
  retentionPanel: { frame: "training/owner/retention-policy.png", rect: { x: 277.90625, y: 401.1875, w: 857.1875, h: 157 } },
  retentionToggles: { frame: "training/owner/retention-policy.png", rect: { x: 262, y: 587, w: 887, h: 229 } },
  retentionTagsSwitch: { frame: "training/owner/retention-tags.png", rect: { x: 265.90625, y: 149.75, w: 879.1875, h: 78 } },
  retentionTagsExplorer: { frame: "training/owner/retention-tags.png", rect: { x: 277.90625, y: 329.265625, w: 855.1875, h: 196.875 } },
  retentionPreview: { frame: "training/owner/retention-preview.png", rect: { x: 174.5, y: 228.09375, w: 836, h: 398.796875 } },
  retentionBatch: { frame: "training/owner/retention-batch.png", rect: { x: 277.90625, y: 355.015625, w: 855.1875, h: 145 } },
  firstOwnerSetup: { frame: "training/owner/first-owner-setup.png", rect: { x: 104, y: 362, w: 399, h: 443 } },
  firstOwnerWelcome: { frame: "training/owner/first-owner-welcome.png", rect: { x: 261, y: 24, w: 889, h: 272 } },
  firstProviderValidated: { frame: "training/owner/first-provider-validated.png", rect: { x: 713, y: 386, w: 413, h: 333 } },
  firstWorkspaceAccess: { frame: "training/owner/first-workspace-access.png", rect: { x: 282, y: 104, w: 847, h: 685 } },
  firstWorkspaceReply: { frame: "training/owner/first-workspace-reply.png", rect: { x: 315, y: 332, w: 839, h: 163 } },
};

type OwnerGuideIcon =
  | "provider"
  | "model"
  | "rotation"
  | "users"
  | "identity"
  | "mfa"
  | "branding"
  | "policy"
  | "clock"
  | "audit"
  | "alerts"
  | "retention";

export type OwnerTrainingVideo = TrainingVideoBase & { icon: OwnerGuideIcon };

export const OWNER_TRAINING_VIDEOS: OwnerTrainingVideo[] = [
  {
    id: "search-index",
    audioSrc: "training/owner/search-index.mp3",
    title: "Review workspace search readiness",
    description: "Check organization search status and rebuild the index from current records when needed.",
    icon: "audit",
    outcomes: [
      "Search status reviewed",
      "Rebuild result understood"
    ],
    setupSteps: [
      "Open Org Settings and find Search index. Read each organization's Ready or Backfilling status and entry count.",
      "Rebuild index reconstructs the index from live records. Read the completion message or error before assuming it finished.",
      "Search still verifies every hit against the live record and current permissions. Rebuilding does not grant access or restore deleted content."
    ],
    scenes: [
      {
        title: "Check whether search has caught up",
        caption: "Org Settings → Search index shows Ready or Backfilling for each organization.",
        narration: "Open Org Settings and review Search index. Each organization shows its entry count and whether indexing is Ready or Backfilling. While backfilling, search results may be incomplete. If indexing is disabled, the panel explains that searches scan records directly instead.",
        durationSeconds: 20,
        focus: "searchIndex"
      },
      {
        title: "Rebuild from current records",
        caption: "Rebuild index reports its result. Search permissions continue to apply to every result.",
        narration: "When the index needs rebuilding, choose Rebuild index and wait for its result. The rebuild uses current live records. An error does not confirm completion. Search verifies every result against its live record and your permissions, so rebuilding cannot grant access, restore deleted work, or expose another person's private content.",
        durationSeconds: 23,
        focus: "searchIndex"
      }
    ]
  },
  {
    id: "owner-first-workspace",
    audioSrc: "training/owner/owner-first-workspace.mp3",
    title: "Set up the first workspace",
    description: "Create the first owner, connect and validate a provider, arrange access, and verify a new live conversation.",
    icon: "provider",
    outcomes: ["Owner created", "Provider validated", "Workspace conversation verified"],
    setupSteps: [
      "On a fresh installation that requires setup, enter the first owner's email, display name, and a matching password of at least 12 characters, then choose Create platform owner.",
      "Use Getting started to review readiness. Set up models opens the owner console when no model is available; Open owner guide provides the detailed walkthroughs.",
      "Without a model, Drafts still supports editing, importing, saving, and exporting documents and decks. AI drafting remains unavailable until a usable model is connected and enabled.",
      "In Providers, configure a supported provider and its endpoint, store an active provider key, and run Sync Models. Check the actual result, Connected status, and returned catalog. Needs key or Needs validation means setup is incomplete; a saved key alone does not prove the connection works.",
      "Enable the intended organization models. In Admin console, review Users, Groups, and Model Access so approved accounts belong to groups that can use those models.",
      "For each approved account, arrange Organization SSO or a temporary password and share the workspace sign-in address. Approval does not send an automatic email.",
      "Complete a new sign-in with an intended user account, select an available model, send a fresh message, and confirm that a provider response arrives.",
    ],
    scenes: [
      {
        title: "Create the first platform owner",
        caption: "Fresh installations start with an owner email, display name, and a confirmed password of at least 12 characters.",
        narration:
          "When a fresh installation requires setup, create the first platform owner. Enter the owner's email and display name, create a password with at least twelve characters, and confirm it. Choose Create platform owner to establish the account that manages this workspace.",
        durationSeconds: 18,
        focus: "firstOwnerSetup",
      },
      {
        title: "Follow the Getting started checklist",
        caption: "Getting started shows model readiness. Set up models opens the owner console; Drafts can still be used manually.",
        narration:
          "After sign-in, Getting started shows account and model readiness. Without a model, Drafts still supports editing, importing, saving, and exporting; AI drafting is unavailable. Choose Set up models, then open Providers. Open owner guide supplies the detailed setup instructions.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        focus: "firstOwnerWelcome",
      },
      {
        title: "Validate the provider connection",
        caption: "Run Sync Models and check the result, Connected status, and returned catalog before enabling models.",
        narration:
          "Configure a supported provider and endpoint, then store an active key. Run Sync Models and inspect its result, the Connected status, and the returned catalog. Needs key or Needs validation means setup is incomplete. Resolve errors before enabling models, and verify an actual chat response at the end.",
        durationSeconds: 22,
        focus: "firstProviderValidated",
      },
      {
        title: "Give the team a working access path",
        caption: "Enable organization models, assign them to platform groups, and arrange sign-in for approved accounts.",
        narration:
          "Enable the intended organization models, then use Admin console to review accounts, groups, and Model Access. Approved users need an active account, the right platform group, and a model assigned to that group. Arrange SSO or a temporary password and share the workspace address; approval sends no automatic email.",
        durationSeconds: 23,
        captionPlacement: "top",
        focus: "firstWorkspaceAccess",
        calloutPlacement: "left-rail",
      },
      {
        title: "Verify a new conversation",
        caption: "Sign in as an intended user, select an available model, send a new message, and read the provider's response.",
        narration:
          "Finish with a new sign-in by an intended user. Complete any password or authenticator steps, select an available model, and send a fresh message. Confirm that the provider returns a response. This verifies that account setup, group access, model availability, and the connection work together.",
        durationSeconds: 21,
        calloutPlacement: "left-rail",
        focus: "firstWorkspaceReply",
      },
    ],
  },
  {
    id: "provider-setup",
    audioSrc: "training/owner/provider-setup.mp3",
    title: "Providers and connections",
    description: "Register gateways, read honest connection state, and sync the model catalog.",
    icon: "provider",
    outcomes: ["Provider registered", "Badge read honestly", "Catalog synced"],
    setupSteps: [
      "Open the account drawer, then Management, then Platform owner console. Open Providers for connection settings or Documentation for step-by-step advice.",
      "Add Provider registers OpenAI, Anthropic, Azure OpenAI, Azure Foundry, GCP Gemini, Bedrock, Open WebUI, OpenRouter, Ollama, OpenAI-compatible, or local gateways.",
      "Save the base URL, auth type, region, and first key label with the connection. A successful save records configuration; it does not prove the provider responds.",
      "Open API Keys on the card to add or replace that provider's vaulted secrets.",
      "Run Sync Models once an active key exists; newly synced models arrive disabled.",
      "Finish in the Models tab to enable the routes you have reviewed.",
    ],
    scenes: [
      {
        title: "Register a gateway",
        caption: "Add Provider covers OpenAI, Anthropic, Azure, Foundry, GCP Gemini, Bedrock, OpenRouter, Ollama, and more.",
        narration:
          "Open the Providers tab in the platform owner console. Add Provider registers OpenAI, Anthropic, Azure OpenAI, Azure Foundry, GCP Gemini, Bedrock, Open WebUI, OpenRouter, Ollama, OpenAI-compatible gateways, and local runtimes.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "addProvider",
      },
      {
        title: "Read the card honestly",
        caption: "Read the badge: Needs key, Needs validation, Adapter needed, or Connected.",
        narration:
          "Read the status separately from the save confirmation. Needs key means a credential is missing. Needs validation means the saved provider still needs a successful runtime check. Adapter needed identifies unsupported routing. Connected reflects a validated usable route.",
        durationSeconds: 20,
        focus: "providerCard",
      },
      {
        title: "Counts and catalog",
        caption: "Models counts enabled of total synced; the Catalog row appears only on OpenRouter cards.",
        narration:
          "The Models line counts enabled models against everything synced, and the Catalog row appears only on OpenRouter cards, where it shows the ZDR or key-scoped list in use.",
        durationSeconds: 13,
        focus: "providerStats",
      },
      {
        title: "Card actions",
        caption: "Edit Connection, Sync Models — disabled until a key is active — and API Keys with its live count.",
        narration:
          "Three actions live on the card: Edit Connection fixes the endpoint, Sync Models stays disabled until an active key exists, and API Keys opens the vault with a live count of stored keys.",
        durationSeconds: 15,
        focus: "providerCardActions",
      },
    ],
  },
  {
    id: "api-key-vault",
    audioSrc: "training/owner/api-key-vault.mp3",
    title: "API Key Vault and replacement",
    description: "Each provider card holds its own vault: store secrets server-side, then reveal, replace, or delete.",
    icon: "rotation",
    outcomes: ["Key vaulted", "Replacement ready"],
    scenes: [
      {
        title: "The vault lives in the card",
        caption: "API Keys opens the vault inside the provider card; secrets are stored server-side and masked here.",
        narration:
          "The vault is not a separate page — API Keys opens it inside each provider card, and every secret is stored server-side with only a masked value in the browser.",
        durationSeconds: 12,
        focus: "vaultPanel",
      },
      {
        title: "Read key metadata",
        caption: "Each row carries the key name, masked value, environment, status, last rotation, and expiry.",
        narration:
          "Each row carries the key name with its masked value, the environment, its status, when it was last rotated, and when it expires — so stale credentials are visible before they fail.",
        durationSeconds: 13,
        focus: "vaultKeyRow",
      },
      {
        title: "Reveal, replace, delete",
        caption: "Reveal shows the full secret for copying; expired keys cannot be revealed, only replaced or deleted.",
        narration:
          "Reveal opens a dialog with the full secret so you can copy it, Replace takes a provider-generated successor, and an expired key cannot be revealed at all — it can only be replaced or deleted.",
        durationSeconds: 14,
        focus: "vaultKeyActions",
      },
    ],
  },
  {
    id: "model-availability",
    audioSrc: "training/owner/model-availability.mp3",
    title: "Organization model availability",
    description: "Control which synced models tenant admins and users can route to.",
    icon: "model",
    outcomes: ["Catalog filtered", "Models gated"],
    scenes: [
      {
        title: "Counters and search",
        caption: "All, Enabled, and Disabled counters plus search cut through the full synced catalog.",
        narration:
          "The Models tab lists every model synced from your providers. The All, Enabled, and Disabled counters show live totals, and search cuts through the full catalog.",
        durationSeconds: 12,
        focus: "modelsSearch",
      },
      {
        title: "Filter by column",
        caption: "The funnel icons filter each column: pick providers, pick model labs, or match routes by text.",
        narration:
          "The funnel icons in the header filter each column: check off providers, check off model labs, or type text to match runtime routes.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        focus: "modelsColumnFilters",
      },
      {
        title: "Enable and gate",
        caption: "Synced models arrive disabled; the org toggle is the ceiling, and policy can attach Default Users.",
        narration:
          "Newly synced models arrive disabled, and this toggle is the organization ceiling. When the Default group policy is on in Org Settings, enabling a model auto-attaches the Default Users group.",
        durationSeconds: 14,
        focus: "modelsToggle",
      },
    ],
  },
  {
    id: "users-roles",
    audioSrc: "training/owner/users-roles.mp3",
    title: "Users and role boundaries",
    description: "Create accounts, issue passwords, and understand the owner and admin floors.",
    icon: "users",
    outcomes: ["Account created", "Password issued", "Floors clear"],
    setupSteps: [
      "Create accounts only at the role level the person needs, then verify their groups and model access in Admin console.",
      "Use the Admin console Users queue to review access requests. After approval, finish the sign-in handoff; approval does not send an email.",
      "For password accounts, provide a temporary password securely. The person chooses a new password at first sign-in; existing sessions are revoked when that change succeeds.",
      "For SSO accounts, confirm the person exists with the identity provider and give them the workspace sign-in address.",
    ],
    scenes: [
      {
        title: "The Role Boundary panel",
        caption: "Open Org Settings and expand Role Boundary to manage accounts at the permitted role level.",
        narration:
          "Open Org Settings from the platform owner console. Expand Role Boundary to manage accounts: owners create owners, admins, and users, while tenant-admin delegation stays policy-controlled. Use Documentation for step-by-step configuration guidance.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "rolesDisclosure",
      },
      {
        title: "Create an account",
        caption: "Display name, email, and role — Create account writes through the admin API.",
        narration:
          "Creating an account takes a display name, an email, and a role. Create account writes through the platform admin API, so the person survives refresh and restart.",
        durationSeconds: 12,
        focus: "rolesCreateForm",
      },
      {
        title: "Set a password",
        caption: "Every row has a set-password action: generate a strong one, mark it temporary — it shows only once.",
        narration:
          "Every account row carries a set-password action. Generate a strong password, mark it temporary so the person picks their own at first sign-in, and copy it now — it is shown only once.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "rolesSetPassword",
      },
      {
        title: "The safety floors",
        caption: "The last active owner can never be removed; owners count as admins, so the sole admin can be.",
        narration:
          "The last active platform owner can never be removed. Owners also count as administrators, so the sole tenant admin can be removed while an owner remains active.",
        durationSeconds: 13,
        focus: "rolesUserRows",
      },
    ],
  },
  {
    id: "sso-setup",
    audioSrc: "training/owner/sso-setup.mp3",
    title: "Single sign-on setup",
    description: "Connect a real OIDC identity provider with an honest protocol selector, presets, and the redirect URI.",
    icon: "identity",
    outcomes: ["Issuer configured", "Redirect registered"],
    setupSteps: [
      "Open Org Settings and expand the Single Sign-On section.",
      "Keep the protocol on OIDC — SAML is stored but deferred, and SCIM covers provisioning.",
      "Pick a preset — Microsoft Entra ID, Google Workspace, or Okta — or enter any OIDC issuer URL.",
      "For Entra, replace {tenant-id} in the issuer with your directory ID.",
      "Paste the client ID and client secret from your identity provider app registration.",
      "Copy the redirect URI shown in the panel into that app registration.",
      "Save SSO, then run Test connection, then complete a fresh OIDC sign-in and verify the workspace session and access before turning on enforcement.",
    ],
    scenes: [
      {
        title: "Live OIDC, verified tokens",
        caption: "Sign-in redirects users to your identity provider; ID tokens are cryptographically verified.",
        narration:
          "The Single Sign-On panel configures live OIDC. Users are redirected to your identity provider, and the returned ID tokens are cryptographically verified before a session is issued.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "ssoIntro",
      },
      {
        title: "An honest protocol selector",
        caption: "OIDC is the supported sign-in path; SAML is stored but deferred; SCIM covers provisioning.",
        narration:
          "The protocol selector tells the truth: OIDC is the supported sign-in path, SAML settings are stored but deferred rather than live, and SCIM exists for provisioning.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "ssoProtocol",
      },
      {
        title: "Presets and credentials",
        caption: "Entra, Google Workspace, and Okta presets prefill the issuer; the client secret stays server-side.",
        narration:
          "Presets for Entra, Google Workspace, and Okta prefill the issuer, and discovery runs from its well-known configuration path. Paste the client ID and secret — the secret is vaulted server-side and never returned to the browser.",
        durationSeconds: 17,
        captionPlacement: "top",
        focus: "ssoFields",
        calloutPlacement: "left-rail",
      },
      {
        title: "Register the redirect URI",
        caption: "Use the Copy button and register this exact callback with your identity provider.",
        narration:
          "Copy the redirect URI with the Copy button and register it with your identity provider. Sign-ins cannot complete until the provider trusts this exact callback address.",
        durationSeconds: 13,
        focus: "ssoRedirect",
      },
    ],
  },
  {
    id: "sso-security",
    audioSrc: "training/owner/sso-security.mp3",
    title: "SSO provisioning and go-live",
    description: "Choose provisioning and MFA behavior, check discovery, and verify an actual sign-in before enforcing SSO.",
    icon: "mfa",
    outcomes: ["JIT and MFA decided", "Complete sign-in verified"],
    scenes: [
      {
        title: "Choose account provisioning",
        caption: "JIT creates accounts on allowed domains with the USER role; groups determine their access.",
        narration:
          "Just-in-time provisioning creates accounts automatically for allowed domains. New accounts arrive with the USER role, and their group assignments determine access. Decide who should be provisioned before enabling this option. Keep SSO enforcement off while checking the complete sign-in path.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        focus: "ssoToggles",
      },
      {
        title: "Choose the platform MFA requirement",
        caption: "Require the platform authenticator after SSO adds an Aperture Chat verification step to identity-provider sign-in.",
        narration:
          "Require the platform authenticator after SSO is a separate decision. Off trusts the identity provider's own verification. On requires users to enroll and verify with the platform authenticator too. Recording an authenticator name or an enrollment link does not enable this requirement. Test the intended sign-in experience before requiring it for the team.",
        durationSeconds: 25,
        calloutPlacement: "left-rail",
        focus: "ssoToggles",
      },
      {
        title: "Check discovery and signing keys",
        caption: "Test connection checks discovery and signing keys; it does not complete a user sign-in.",
        narration:
          "Save SSO, then run Test connection. It checks the provider's discovery document and signing keys. A passing result does not verify the client-secret exchange, callback, user claims, or a completed workspace session. Test an actual sign-in before enforcing SSO.",
        durationSeconds: 20,
        focus: "ssoSaveTest",
      },
      {
        title: "Verify sign-in before enforcement",
        caption: "Complete a fresh OIDC sign-in and verify the intended user's access before enforcing SSO.",
        narration:
          "Before enforcing SSO, complete a fresh sign-in through the identity provider and confirm the user reaches the workspace with the intended groups and models. Test connection alone is insufficient. Enforce SSO blocks local password sign-in for allowed domains, so retain your approved recovery access path.",
        durationSeconds: 22,
        calloutPlacement: "left-rail",
        focus: "ssoEnforce",
      },
    ],
  },
  {
    id: "branding",
    audioSrc: "training/owner/branding.mp3",
    title: "Platform branding",
    description: "Rename the product and roll the logo, icon, domain, and theme colors out everywhere.",
    icon: "branding",
    outcomes: ["Brand applied", "Theme colors set"],
    scenes: [
      {
        title: "Live brand preview",
        caption: "The preview shows the logo, the platform name, and an Interface text sample as users see them.",
        narration:
          "Platform Branding opens with a live preview: the logo, the platform name, and an Interface text sample rendered exactly as users will see them.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "brandPreview",
      },
      {
        title: "Name, logo, icon, domain",
        caption: "Set the name, logo URL, browser icon, and domain — recorded for admins, it does not change routing.",
        narration:
          "The fields cover the platform name, the logo URL, the browser icon, and the platform domain. The domain is recorded for admins and the API — saving it here does not change routing.",
        durationSeconds: 14,
        focus: "brandFields",
        calloutPlacement: "left-rail",
      },
      {
        title: "Theme colors",
        caption: "Accent, sidebar gradient start and end — set both or neither — and text; empty keeps the default.",
        narration:
          "Theme colors cover the accent, the sidebar gradient start and end — set both stops or clear both — and the interface text color. Leave any field empty to keep the platform default.",
        durationSeconds: 13,
        focus: "brandThemeColors",
      },
      {
        title: "Apply it everywhere",
        caption: "Upload PNG caps at 4 MB; Apply branding reaches every surface, including the installable app icon.",
        narration:
          "Upload PNG stores the image with your tenant settings, so nothing needs hosting elsewhere — PNG uploads cap at four megabytes. Apply branding rolls the change out everywhere the brand appears, including the tenant's installable home-screen icon and manifest.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "brandActions",
      },
    ],
  },
  {
    id: "policies-connectors",
    audioSrc: "training/owner/policies-connectors.mp3",
    title: "Policies, budget, and connectors",
    description: "Set organization policies and budget, and manage shared connector configuration and credentials.",
    icon: "policy",
    outcomes: ["Ceiling set", "Budget set", "Connectors gated"],
    scenes: [
      {
        title: "A collapsed, scan-friendly start",
        caption: "Org Settings groups related controls into expandable panels; expand only the policy, budget, or connector surface you need.",
        narration:
          "Org Settings groups controls into panels. Expand Role Boundary, SSO, Branding, Policy Controls, the workspace budget, connectors, or Elastic Analytics as needed. Search index shows its status near the top.",
        durationSeconds: 16,
        focus: "policyCollapsed",
        calloutPlacement: "left-rail",
      },
      {
        title: "The enforced floor",
        caption: "One row is always on: only owners can create platform owners. No toggle can loosen it.",
        narration:
          "Policy Controls start with a row that is always enforced: only owners can create platform owners. There is no toggle to loosen it.",
        durationSeconds: 10,
        focus: "policyFloor",
        calloutPlacement: "left-rail",
      },
      {
        title: "Set the organization policy ceiling",
        caption: "API, administrator roles, SSO, model defaults, agents, memory, and model browsing define the policy ceiling.",
        narration:
          "Policy controls set the organization ceiling for API access, administrator creation, SSO requirements and delegation, default model groups, user-built agents, personalization memory, and model catalog browsing. Tenant and group controls operate inside these boundaries. Review each control's explanation before changing it.",
        durationSeconds: 24,
        focus: "policyToggles",
        calloutPlacement: "left-rail",
      },
      {
        title: "Choose whether users can browse models",
        caption: "Users can browse the model catalog controls unavailable-model explanations and access requests.",
        narration: "When Users can browse the model catalog is on, users can inspect enabled organization models, see why a model is unavailable, and request access when permitted. Turning it off shows only models they can already use and refuses new access requests. This policy does not grant model access; groups still control that.",
        durationSeconds: 22,
        focus: "modelBrowsingPolicy",
        calloutPlacement: "left-rail"
      },
      {
        title: "The workspace usage budget",
        caption: "Measure tokens or provider-reported dollars, reset daily, weekly, or monthly in UTC; zero is unlimited.",
        narration:
          "The Workspace Usage Budget is the spend ceiling: measure in tokens or provider-reported dollars, reset daily, weekly, or monthly in UTC, and zero means unlimited. The usage card shows the current period, and admins add per-user and per-group caps beneath this ceiling.",
        durationSeconds: 20,
        focus: "budgetControls",
        calloutPlacement: "left-rail",
      },
      {
        title: "Owner-managed shared connectors",
        caption: "Org Settings → Connectors is the owner-only home for shared configuration, credentials, connection tests, and workspace authorization.",
        narration:
          "Owners manage shared connectors in Org Settings. Configure the vendor's fields and credentials, save, then test the actual connection. Workspace authorization here supports shared operations such as knowledge sync; chat attachments still use each person's own cloud account. Tenant administrators do not manage these shared credentials. Read the saved, disabled, or missing-credential status before relying on a source.",
        durationSeconds: 28,
        focus: "sharedConnectors",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "runtime-analytics",
    audioSrc: "training/owner/runtime-analytics.mp3",
    title: "Analytics: runtime, activity, and usage",
    description: "Scoped runtime timestamps, model activity, and durable per-user usage.",
    icon: "clock",
    outcomes: ["Sections scoped", "Executions traced", "Usage charted"],
    scenes: [
      {
        title: "Every section scopes itself",
        caption: "Sections start collapsed; each carries its own user and date filter, so no panel's scope hides another.",
        narration:
          "Analytics sections start collapsed behind descriptive headers. Expand one and it carries its own filter — a user picker beside a date range with presets — so scoping runtime events never hides feedback, activity, or usage in another panel.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "analyticsFilters",
      },
      {
        title: "Runtime clock scorecards",
        caption: "Authoritative execution timestamps, totaled across chat and draft runs — not client guesses.",
        narration:
          "Runtime Clock Metadata totals executions with authoritative timestamps captured from chat and draft completion events, split across the scorecards — these are recorded times, not client guesses.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "runtimeScorecards",
      },
      {
        title: "Trace each execution",
        caption: "Every row lists who ran it and when; the CSV popover has its own date range and actor columns.",
        narration:
          "Each row lists who ran the execution, which provider served it, and the exact start time. The CSV export opens a popover with its own date range, and the file carries actor columns.",
        durationSeconds: 14,
        captionPlacement: "top",
        focus: "runtimeRows",
        calloutPlacement: "left-rail",
      },
      {
        title: "Model activity",
        caption: "Prompts by model, the daily trend, and users ranked by prompt activity — scoped by its own filter.",
        narration:
          "Model Activity charts prompts by model and the daily trend, and Users by prompt activity ranks who is actually running them — all inside this section's own date and user filter.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "activityCharts",
      },
      {
        title: "User Usage",
        caption: "Durable per-user usage from real completions across chat, drafts, agents, automations, and the API.",
        narration:
          "User Usage is durable per-user usage from real completions — chat, drafts, agents, automations, and the API gateway all record here as they run.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "usageScorecards",
      },
      {
        title: "Honest tokens, owner scope",
        caption: "Provider-reported tokens only; the Usage by user picker focuses the whole panel on one person.",
        narration:
          "Token counts are provider-reported only — they stay blank when a provider reported none. This owner view includes platform owners alongside admins and users, and the Usage by user picker focuses the whole panel on one person.",
        durationSeconds: 17,
        focus: "usageByUser",
      },
    ],
  },
  {
    id: "owner-audit",
    audioSrc: "training/owner/owner-audit.mp3",
    title: "Owner audit signals",
    description: "Posture tiles, security alerts, and the filtered, exportable append-only trail.",
    icon: "audit",
    outcomes: ["Posture reviewed", "Trail filtered", "Rows exported"],
    scenes: [
      {
        title: "Critical events lead",
        caption: "The posture dashboard stays open on top; the sections below it start collapsed.",
        narration:
          "The Audit tab opens on the posture dashboard while the sections below start collapsed. The grid leads with Critical events — high-severity audit events surfaced before anything else, so incidents come first. Data Retention sits below Recent Governance Activity and groups schedules, tags, and legal holds.",
        durationSeconds: 21,
        focus: "auditCriticalTile",
      },
      {
        title: "The full posture grid",
        caption: "Provider posture, model ceiling, vault, approvals, connectors, keys, owners, syncs, and the watchlist.",
        narration:
          "The rest of the grid covers provider posture, the model ceiling, vault metadata, pending approvals, connectors, expired keys, connector issues, unscoped models, privileged owners, stale syncs, and the prompt watchlist.",
        durationSeconds: 16,
        focus: "auditTileGrid",
      },
      {
        title: "Security alerts",
        caption: "Expand Security Alerts for DLP and misuse flags, scoped by the section's own user and date filter.",
        narration:
          "Expand Security Alerts for DLP and misuse flags raised from actual prompts, each with a redacted snippet you can review and acknowledge — scoped by the section's own user and date filter.",
        durationSeconds: 15,
        focus: "auditSecurityAlerts",
      },
      {
        title: "Filter the trail",
        caption: "Severity, category, and text search stack on top of the trail's own user and date filter.",
        narration:
          "Expand Audit Trail and filter by severity, by category, or by text search — all three stack on top of the section's own user and date filter.",
        durationSeconds: 11,
        focus: "trailFilters",
      },
      {
        title: "Export what you see",
        caption: "The CSV exports exactly the visible rows, with actor id, name, and role on every event.",
        narration:
          "The CSV export takes exactly the rows you can see — nothing hidden is added back — and every event carries the actor's id, name, and role.",
        durationSeconds: 11,
        focus: "trailRows",
        calloutPlacement: "upper-right",
      },
    ],
  },
  {
    id: "owner-alerts",
    audioSrc: "training/owner/owner-alerts.mp3",
    title: "Alerts and email delivery",
    description: "Configure real SMTP, define alert rules, and read every delivery's true status.",
    icon: "alerts",
    outcomes: ["SMTP configured", "Rules defined", "Deliveries verified"],
    scenes: [
      {
        title: "Email delivery",
        caption: "Real SMTP: host, port, STARTTLS, SSL, or none, and a from address; the password vaults once.",
        narration:
          "Email Delivery holds real SMTP settings — host, port, STARTTLS, SSL, or none, and the from address. The password is stored in the encrypted vault and never shown again, and alerts are always logged in-app even without email.",
        durationSeconds: 18,
        focus: "alertSmtp",
        calloutPlacement: "left-rail",
      },
      {
        title: "Rules and their scope",
        caption: "Owner rules are platform-wide; tenant rules created by admins list here with their scope label.",
        narration:
          "Alert rules watch audit activity. Rules you create here are platform-wide, and tenant rules created by admins are listed alongside them, each labeled with its scope.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "alertRules",
      },
      {
        title: "Start from a template",
        caption: "The Suspicious-activity template prefills a security watch; New rule starts from scratch.",
        narration:
          "The Suspicious-activity template prefills a rule that watches security flags and elevated-severity events, and New rule starts a custom one from scratch.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "alertTemplates",
      },
      {
        title: "Deliveries tell the truth",
        caption: "Real statuses plus Archive: clear a delivery from the view without deleting its history.",
        narration:
          "Alert Deliveries records every trigger with its real status — sent, queued, failed with the actual SMTP error, not configured, or logged in-app when no recipients are set. Archive a delivery to clear the view — its history is kept, and Show archived brings it back.",
        durationSeconds: 19,
        focus: "alertDeliveries",
      },
    ],
  },
  {
    id: "owner-retention",
    audioSrc: "training/owner/owner-retention.mp3",
    title: "Data retention and tagging",
    description: "Keep chats forever by default, review client labels and holds, and preview an optional retention schedule.",
    icon: "retention",
    outcomes: ["Forever default understood", "Client labels reviewed", "Retention changes previewed"],
    setupSteps: [
      "Open your account menu, expand Management, and choose Platform Owner Console.",
      "Select Audit, then expand Data Retention below Recent Governance Activity.",
      "Use Schedule and rules for the duration slider, client or matter sources, and Preview effect.",
      "Use Tags and holds to find conversations, review labels, and expand Legal holds.",
    ],
    scenes: [
      {
        title: "Start in the Audit tab",
        caption: "Platform Owner Console → Audit. Retention lives below Recent Governance Activity.",
        narration: "From the Platform Owner Console, select Audit in the top row of tabs. Scroll below Recent Governance Activity to find Data Retention. Expand that panel to manage both schedules and conversation labels.",
        durationSeconds: 15,
        focus: "retentionNavigation",
        calloutPlacement: "lower-left",
      },
      {
        title: "Open Data Retention in Audit",
        caption: "Schedule and rules, tags, and legal holds share one Audit panel.",
        narration: "In either console, open Audit and expand Data Retention. Schedule and rules contains the retention policy. Tags and holds contains conversation search, label review, and legal holds. User Prompt Activity remains a separate panel for inspecting prompts.",
        durationSeconds: 19,
        focus: "retentionWorkspace",
      },
      {
        title: "Forever until you choose",
        caption: "Schedule and rules → Keep chats for. Forever is selected by default.",
        narration: "Chat retention starts at Forever, with automatic deletion off. The slider offers one, five, seven, and ten years. Moving it only changes a draft. Existing chats remain stored until an administrator previews and saves an active policy.",
        durationSeconds: 18,
        focus: "retentionPanel",
      },
      {
        title: "Give each client a stable source",
        caption: "Schedule and rules → Clients, matters, and regulated records. Enter the name and aliases.",
        narration: "Add a stable source for each client, matter, or regulated record category. Enter its name and known aliases. Save the definitions even while the schedule stays at Forever. Later references in saved messages can then produce suggestions for review.",
        durationSeconds: 19,
        focus: "retentionSources",
      },
      {
        title: "Sensitive data needs review",
        caption: "Pattern matches suggest categories; they never copy raw sensitive values into labels.",
        narration: "Sensitive data suggestions recognize email addresses, possible Social Security numbers, and payment cards in saved message text. They can miss information or produce false matches. They do not inspect original uploaded files or determine which law applies. Confirm a category only after review.",
        durationSeconds: 21,
        focus: "retentionSensitive",
      },
      {
        title: "Scan and confirm the right chats",
        caption: "Tags and holds → Scan existing chats. Review each match before Confirm label.",
        narration: "In Data Retention, choose Tags and holds. Scan existing chats includes older saved conversations. Search and filter the list, preview the content, then select the intended chats and source. Confirm label makes that identity authoritative. Remove or dismiss rejects an incorrect match.",
        durationSeconds: 21,
        focus: "retentionTagsExplorer",
      },
      {
        title: "Preserve records with a legal hold",
        caption: "Tags and holds → Legal holds → Hold name → Hold selected chats.",
        narration: "In Tags and holds, expand Legal holds below the label actions. A legal hold protects the selected chats from both automatic and manual deletion. Name the hold and choose Hold selected chats. For ongoing client preservation, also set that source's rule to Forever. Releasing a hold requires confirmation and gives eligible records a new review window.",
        durationSeconds: 25,
        focus: "retentionHolds",
        calloutPlacement: "lower-left",
        captionPlacement: "top",
      },
      {
        title: "Preview a changed schedule",
        caption: "Schedule and rules → Preview effect. Review the counts before saving.",
        narration: "Return to Schedule and rules. Choose the duration, the starting clock, and a review window of at least seven days. Preview effect counts the saved chats affected by this exact draft. Shortening a policy can make older chats eligible; extending it delays deletion. Longer matching rules and legal holds win. A changed policy restarts the review window.",
        durationSeconds: 24,
        focus: "retentionSchedulePreview",
      },
      {
        title: "Read the conversation first",
        caption: "Tags and holds → select a chat title to open its conversation preview.",
        narration: "Switch back to Tags and holds, then select a conversation title to inspect its saved prompts and responses. Automatic cleanup covers chats and linked uploads, search entries, and feedback. Drafts, learned memories, exports, provider copies, and backups have separate lifecycles. This is not a complete client erasure across every data store.",
        durationSeconds: 23,
        focus: "retentionPreview",
      },
      {
        title: "Confirm manual disposition",
        caption: "Tags and holds → select chats → Archive selected or Delete selected.",
        narration: "For a manual batch action, select the intended chats and choose Archive or Delete. Read the count and confirmation. Archiving preserves the stored conversation; deletion cannot be undone. Active legal holds are skipped. Choosing Forever in the policy stops automatic deletion without restoring anything already deleted.",
        durationSeconds: 23,
        focus: "retentionBatch",
      },
    ],
  },

];

const VIDEO_ICONS = {
  provider: KeyRound,
  model: Edit3,
  rotation: KeyRound,
  users: UserPlus,
  identity: Mail,
  mfa: QrCode,
  branding: Palette,
  policy: Lock,
  clock: Clock3,
  audit: ShieldAlert,
  alerts: BellRing,
  retention: DatabaseZap,
} satisfies Record<OwnerGuideIcon, typeof KeyRound>;

const OWNER_DECK: TrainingDeck = {
  badge: "Owner walkthrough",
  regions: OWNER_FOCUS_REGIONS,
  videos: OWNER_TRAINING_VIDEOS,
  icons: VIDEO_ICONS,
  pdf: {
    href: "docs/aperture-owner-guide.pdf",
    title: "Platform owner guide (PDF)",
    description:
      "The user and administrator guides plus every owner surface — providers, keys, models, SSO, branding, policies and budgets, analytics, audit, and alert delivery.",
    tooltip: "Download the printable platform owner guide covering the entire platform",
  },
};

export function OwnerDocumentationModal({
  onClose,
  onOpenAdminDocumentation,
  onOpenUserHelp,
}: {
  onClose: () => void;
  onOpenAdminDocumentation?: () => void;
  onOpenUserHelp?: () => void;
}) {
  const openRelatedSurface = (handler: (() => void) | undefined) => {
    if (!handler) return;
    onClose();
    handler();
  };

  const headerLinks = (
      <div className="doc-header-links" aria-label="Related documentation">
        {onOpenAdminDocumentation && (
          <button
            className="doc-header-link"
            type="button"
            onClick={() => openRelatedSurface(onOpenAdminDocumentation)}
          >
            Admin documentation
          </button>
        )}
        {onOpenAdminDocumentation && onOpenUserHelp && (
          <span className="doc-header-link-divider" aria-hidden="true">
            /
          </span>
        )}
        {onOpenUserHelp && (
          <button className="doc-header-link" type="button" onClick={() => openRelatedSurface(onOpenUserHelp)}>
            Chat help
          </button>
        )}
        {(onOpenAdminDocumentation || onOpenUserHelp) && (
          <span className="doc-header-link-divider" aria-hidden="true">/</span>
        )}
        <a
          className="doc-header-link"
          href="https://aperturechat.com/guide.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          Interactive platform guide
        </a>
      </div>
    );

  return (
    <TrainingDocumentationModal
      deck={OWNER_DECK}
      docTitleId="owner-doc-title"
      videoTitleId="owner-video-title"
      title="Platform owner documentation"
      description="Narrated walkthroughs of the current console: providers, keys, models, roles, SSO, branding, policies and budgets, search, analytics, audit, and alerts."
      backTooltip="Return to the full list of training videos"
      headerLinks={headerLinks}
      onClose={onClose}
    />
  );
}
