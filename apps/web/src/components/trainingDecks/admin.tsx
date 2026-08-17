import { BarChart3, BellRing, DatabaseZap, Mail, ShieldCheck, SlidersHorizontal, UserPlus, Users, Wrench } from "lucide-react";
import { TrainingDocumentationModal, type TrainingDeck } from "../TrainingVideoLibrary";
import type { FocusRegion, TrainingVideoBase } from "../trainingVideoKit";

/* Frames are real captures of the current Admin Console
 * (scripts/capture-admin-frames.cjs and scripts/capture-admin-analytics-frames.cjs
 * document the capture pipeline). */

export type AdminFocus =
  | "usersTabs"
  | "usersAdd"
  | "usersTable"
  | "usersActions"
  | "groupsCards"
  | "groupsEditor"
  | "groupsPermGrid"
  | "groupsAgentAuthoring"
  | "maSync"
  | "maColumns"
  | "maToggleScope"
  | "connConnectors"
  | "connConfigure"
  | "connResponseActions"
  | "ssoPreset"
  | "ssoFields"
  | "ssoCreate"
  | "ssoPanel"
  | "anFilters"
  | "anRuntime"
  | "anUsage"
  | "anBudget"
  | "policyCollapsed"
  | "policyServiceAvailability"
  | "policyDefaults"
  | "policyMemory"
  | "policyCounts"
  | "auCards"
  | "auPromptSelect"
  | "auTrailFilters"
  | "alEmail"
  | "alRules"
  | "alRuleForm"
  | "alDeliveries"
  | "retentionPanel"
  | "retentionToggles"
  | "retentionTagsSwitch"
  | "retentionTagsExplorer"
  | "retentionPreview"
  | "retentionBatch";

export const ADMIN_FOCUS_REGIONS: Record<AdminFocus, FocusRegion> = {
  usersTabs: { frame: "training/admin/users.png", rect: { x: 266, y: 88, w: 606, h: 42 } },
  usersAdd: { frame: "training/admin/users.png", rect: { x: 840, y: 156, w: 116, h: 39 } },
  usersTable: { frame: "training/admin/users.png", rect: { x: 279, y: 219, w: 854, h: 324 } },
  usersActions: { frame: "training/admin/users.png", rect: { x: 1041, y: 265, w: 100, h: 276 } },
  groupsCards: { frame: "training/admin/groups.png", rect: { x: 279, y: 235, w: 851, h: 347 } },
  groupsEditor: { frame: "training/admin/groups.png", rect: { x: 280, y: 587, w: 850, h: 268 } },
  groupsPermGrid: { frame: "training/admin/groups-permissions.png", rect: { x: 306, y: 299, w: 799, h: 477 } },
  groupsAgentAuthoring: { frame: "training/admin/groups-permissions.png", rect: { x: 306, y: 696, w: 798, h: 74 } },
  maSync: { frame: "training/admin/model-access.png", rect: { x: 676, y: 158, w: 408, h: 48 } },
  maColumns: { frame: "training/admin/model-access.png", rect: { x: 282, y: 419, w: 861, h: 39 } },
  maToggleScope: { frame: "training/admin/model-access.png", rect: { x: 672, y: 460, w: 308, h: 46 } },
  connConnectors: { frame: "training/admin/connections.png", rect: { x: 279, y: 223, w: 848, h: 364 } },
  connConfigure: { frame: "training/admin/connections.png", rect: { x: 955, y: 225, w: 117, h: 39 } },
  connResponseActions: { frame: "training/admin/response-actions.png", rect: { x: 266, y: 388, w: 876, h: 423 } },
  ssoPreset: { frame: "training/admin/sso-form.png", rect: { x: 279, y: 236, w: 307, h: 65 } },
  ssoFields: { frame: "training/admin/sso-form.png", rect: { x: 279, y: 330, w: 853, h: 218 } },
  ssoCreate: { frame: "training/admin/sso-form.png", rect: { x: 279, y: 556, w: 853, h: 130 } },
  ssoPanel: { frame: "training/admin/sso-form.png", rect: { x: 264, y: 220, w: 882, h: 478 } },
  anFilters: { frame: "training/admin/analytics.png", rect: { x: 278, y: 76, w: 856, h: 134 } },
  anRuntime: { frame: "training/admin/analytics.png", rect: { x: 276, y: 225, w: 856, h: 95 } },
  anUsage: { frame: "training/admin/analytics-activity.png", rect: { x: 268, y: 0, w: 875, h: 585 } },
  anBudget: { frame: "training/admin/analytics-usage-budget.png", rect: { x: 267, y: 280, w: 877, h: 530 } },
  // These frames are captured at the native 1185 x 855 composition size, so
  // text stays legible and measured focus borders map one-to-one to the UI.
  policyCollapsed: { frame: "training/admin/policies-collapsed.png", rect: { x: 267, y: 144, w: 877, h: 227 } },
  policyServiceAvailability: { frame: "training/admin/policies-controls.png", rect: { x: 276, y: 218, w: 858, h: 291 } },
  policyDefaults: { frame: "training/admin/policies-controls.png", rect: { x: 276, y: 530, w: 858, h: 240 } },
  policyMemory: { frame: "training/admin/policies-memory.png", rect: { x: 267, y: 225, w: 877, h: 362 } },
  policyCounts: { frame: "training/admin/policies-counts.png", rect: { x: 267, y: 306, w: 877, h: 133 } },
  auCards: { frame: "training/admin/audit.png", rect: { x: 276, y: 218, w: 856, h: 238 } },
  auPromptSelect: { frame: "training/admin/audit-alerts.png", rect: { x: 282, y: 154, w: 847, h: 131 } },
  auTrailFilters: { frame: "training/admin/audit-trail.png", rect: { x: 268, y: 518, w: 875, h: 222 } },
  alEmail: { frame: "training/admin/alerts.png", rect: { x: 264, y: 141, w: 882, h: 152 } },
  alRules: { frame: "training/admin/alerts.png", rect: { x: 264, y: 302, w: 882, h: 174 } },
  alRuleForm: { frame: "training/admin/alerts-rule-form.png", rect: { x: 266, y: 380, w: 876, h: 433 } },
  alDeliveries: { frame: "training/admin/alerts.png", rect: { x: 264, y: 486, w: 882, h: 126 } },
  // Retention frames are local-stack captures with synthetic chats and tags;
  // rects were measured from the live DOM at capture time.
  retentionPanel: { frame: "training/admin/retention-policy.png", rect: { x: 267, y: 306, w: 877, h: 268 } },
  retentionToggles: { frame: "training/admin/retention-policy.png", rect: { x: 268, y: 387, w: 875, h: 186 } },
  retentionTagsSwitch: { frame: "training/admin/retention-tags.png", rect: { x: 268, y: 81, w: 875, h: 66 } },
  retentionTagsExplorer: { frame: "training/admin/retention-tags.png", rect: { x: 268, y: 159, w: 875, h: 556 } },
  retentionPreview: { frame: "training/admin/retention-preview.png", rect: { x: 183, y: 215, w: 820, h: 424 } },
  retentionBatch: { frame: "training/admin/retention-batch.png", rect: { x: 268, y: 356, w: 875, h: 143 } },
};

type AdminGuideIcon = "users" | "groups" | "models" | "tools" | "sso" | "analytics" | "policies" | "audit" | "alerts" | "retention";

export type AdminTrainingVideo = TrainingVideoBase & { icon: AdminGuideIcon };

export const ADMIN_TRAINING_VIDEOS: AdminTrainingVideo[] = [
  {
    id: "admin-users",
    audioSrc: "training/admin/admin-users.mp3",
    title: "Users and accounts",
    description: "Create tenant accounts, manage passwords and status, and remove leavers safely.",
    icon: "users",
    outcomes: ["Account created", "Safety floor understood"],
    scenes: [
      {
        title: "The tenant user list",
        caption: "Open the console from the account drawer's Management section; nine tabs cover the whole tenant.",
        narration:
          "The admin console opens from the Management section of your account drawer. Nine tabs cover the tenant — Users, Groups, Model Access, Connections, SSO, Analytics, Policies, Audit, and Alerts — and Users is where it starts.",
        durationSeconds: 17,
        focus: "usersTabs",
      },
      {
        title: "Add a user",
        caption: "Add User shows the roles allowed by current organization policy, including Admin when delegated.",
        narration:
          "Add User creates an account with a name, email, role, and starting group. The role menu shows the choices allowed by current organization policy. When administrator creation is available, Admin appears alongside User, Power User, Auditor, and Agent Approver.",
        durationSeconds: 19,
        focus: "usersAdd",
      },
      {
        title: "Filter and read the table",
        caption: "Filter by group; each row shows role, groups, auth, status, last active, and an Actions column.",
        narration:
          "Filter the list by group to work one team at a time. Each row shows the role, groups, sign-in method, status, and last active time, with an Actions column at the end for account-level controls.",
        durationSeconds: 14,
        focus: "usersTable",
      },
      {
        title: "Passwords, removal, and the safety floor",
        caption: "Password, Deactivate, and permanent Delete per row; the last active administrator cannot be removed.",
        narration:
          "Every row carries a Password reset, a Deactivate or Activate switch, and a permanent Delete that removes the account and its chat history. Administrator account actions that are not available under the current service policy remain disabled with a clear explanation.",
        durationSeconds: 19,
        focus: "usersActions",
      },
    ],
  },
  {
    id: "admin-groups",
    audioSrc: "training/admin/admin-groups.mp3",
    title: "Groups and permissions",
    description: "Create groups, assign users, and tune the seven-toggle permission grid.",
    icon: "groups",
    outcomes: ["Group created", "Permissions tuned"],
    scenes: [
      {
        title: "Groups gate everything",
        caption: "Model grants, knowledge access, and permissions all attach to groups; Default Users is the baseline.",
        narration:
          "Groups are how access flows in this tenant: model grants, knowledge access, and permissions all attach to groups. Default Users gives new accounts a protected baseline you can tune.",
        durationSeconds: 13,
        focus: "groupsCards",
      },
      {
        title: "Inside the group editor",
        caption: "Select a group to open its editor: Users, Permissions, and Import tabs with live counts.",
        narration:
          "Select a group to open its editor. Three tabs — Users, Permissions, and Import — manage membership one person at a time, tune what the group can do, and bulk-import members by pasting emails.",
        durationSeconds: 14,
        focus: "groupsEditor",
      },
      {
        title: "The permission grid",
        caption: "Seven toggles: chat, knowledge, agents, and tools start on; API, Hermes, and agent building start off.",
        narration:
          "The Permissions tab is a seven-toggle grid. Chat, knowledge, agents, and tools start on; Can use API, Can use Hermes companion, and Can build agents start off. API access is available only when the current service policy permits it.",
        durationSeconds: 17,
        focus: "groupsPermGrid",
      },
      {
        title: "Grant agent building",
        caption: "Can build agents allows private, self-owned agents from approved models; publishing stays admin-only.",
        narration:
          "Can build agents lets group members create private, self-owned agent profiles from models available to the organization. It only works when service policy permits user-built agents, and publishing to the organization stays admin-only.",
        durationSeconds: 17,
        focus: "groupsAgentAuthoring",
      },
    ],
  },
  {
    id: "admin-model-access",
    audioSrc: "training/admin/admin-model-access.mp3",
    title: "Tenant model access",
    description: "Decide which synced models users see and which groups can use them.",
    icon: "models",
    outcomes: ["Models gated per group", "Catalog synced"],
    scenes: [
      {
        title: "Sync the tenant catalog",
        caption: "Sync models pulls the owner-enabled catalog; All, Enabled, and Disabled counters carry live totals.",
        narration:
          "Model Access starts from the catalog available to your organization. Sync models refreshes it whenever service availability changes, and the All, Enabled, and Disabled counters carry live totals for the models you can govern.",
        durationSeconds: 16,
        focus: "maSync",
      },
      {
        title: "Read and filter the columns",
        caption: "Seven columns describe each model; funnel filters narrow by provider, model lab, or runtime route.",
        narration:
          "Each row reads across seven columns — Model, Provider, User Access, Groups, Filters, Knowledge, and Tools — and the funnel filters in the header narrow the list by provider, by model lab, or by matching text in the runtime route.",
        durationSeconds: 17,
        focus: "maColumns",
      },
      {
        title: "Turn on and scope",
        caption: "Access flows through groups; with zero groups the toggle stays off and the panel says to create one.",
        narration:
          "The user access toggle shows a model to users, and Choose groups narrows it to specific teams. Access only flows through groups — with none created, the toggle stays off and the panel says create a group before enabling models.",
        durationSeconds: 16,
        focus: "maToggleScope",
      },
    ],
  },
  {
    id: "admin-tools",
    audioSrc: "training/admin/admin-tools.mp3",
    title: "Connections and response actions",
    description: "Enable sources with real credentials and manage response actions on assistant replies.",
    icon: "tools",
    outcomes: ["Connector configured", "Honest statuses read"],
    scenes: [
      {
        title: "Tenant connectors",
        caption: "Each connector wears an honest pill: Credentials saved, Saved · disabled, or Needs credentials.",
        narration:
          "Connections lists the sources this tenant can attach in chat and drafts. Each connector wears an honest credential pill — Credentials saved, Saved but disabled, or Needs credentials — so the toggle never pretends a source works.",
        durationSeconds: 16,
        focus: "connConnectors",
      },
      {
        title: "Configure with vendor credentials",
        caption: "Configure opens the vendor's real fields; save, then test the connection before relying on it.",
        narration:
          "Configure opens the vendor-specific form. Service credentials can power background indexing, while Google Drive, Microsoft 365, Box, and iManage users connect their own account from chat. Save, then test the connection before you rely on it.",
        durationSeconds: 15,
        focus: "connConfigure",
      },
      {
        title: "Response actions, not MCP",
        caption: "Chat output actions add admin-approved buttons to responses; MCP servers live in Knowledge/Tools → Tools.",
        narration:
          "Chat output actions add admin-approved buttons to assistant responses, like exports or formatters. This panel does not add MCP servers or model-callable tools — those live on the Tools tab, under Knowledge and Tools in the sidebar.",
        durationSeconds: 17,
        focus: "connResponseActions",
      },
    ],
  },
  {
    id: "admin-sso",
    audioSrc: "training/admin/admin-sso.mp3",
    title: "Tenant SSO and provisioning",
    description: "Connect an identity provider, provision on first sign-in, and map IdP groups.",
    icon: "sso",
    outcomes: ["Provider connected", "Tested before enforced"],
    setupSteps: [
      "Open the SSO tab and choose Add SSO configuration.",
      "Pick a preset — Microsoft Entra ID, Google Workspace, Okta — or a custom OIDC issuer.",
      "Paste the client ID and client secret from your IdP app registration; the secret is vaulted server-side.",
      "List the email domains allowed to sign in, and register the shown redirect URI with your IdP.",
      "Create the configuration — enforcement always starts off — then run Test connection.",
      "Map IdP group values to tenant groups on the card so JIT users land with the right access.",
      "Only enforce tenant sign-in after the test passes.",
    ],
    scenes: [
      {
        title: "Pick the identity provider",
        caption: "Presets for Entra, Google Workspace, and Okta prefill the issuer; custom OIDC works too.",
        narration:
          "Add SSO configuration starts with a provider preset — Microsoft Entra ID, Google Workspace, Okta, or a custom OIDC issuer. Presets prefill the issuer URL; for Entra, replace the tenant-id placeholder with your directory ID.",
        durationSeconds: 19,
        focus: "ssoPreset",
      },
      {
        title: "Issuer, client, and domains",
        caption: "The secret is vaulted server-side and never shown again; allowed domains gate who can sign in.",
        narration:
          "Fill in the issuer, client ID, and client secret from your app registration — the secret is vaulted server-side and never shown again. Allowed email domains gate who can sign in through this provider.",
        durationSeconds: 15,
        focus: "ssoFields",
      },
      {
        title: "Create, test, then enforce",
        caption: "Enforcement starts off; run the live connection test and map IdP groups before requiring SSO.",
        narration:
          "Create the configuration — enforcement always starts off, so nothing can lock the tenant out. From the card, run the live connection test, map identity-provider groups to tenant groups, and only enforce sign-in once the test passes.",
        durationSeconds: 17,
        focus: "ssoCreate",
      },
      {
        title: "When owners hold the keys",
        caption: "If organization policy restricts SSO management to owners, this tab is read-only for admins.",
        narration:
          "When organization policy makes SSO management read-only, you can still review the configurations and enforcement state, but editing controls remain unavailable in this console.",
        durationSeconds: 13,
        focus: "ssoPanel",
      },
    ],
  },
  {
    id: "admin-analytics",
    audioSrc: "training/admin/admin-analytics.mp3",
    title: "Tenant analytics",
    description: "Date-and-user scoped runtime, usage, and budget analytics with CSV exports.",
    icon: "analytics",
    outcomes: ["Usage measured", "Caps set"],
    scenes: [
      {
        title: "Every section scopes itself",
        caption: "Sections start collapsed; each carries its own person picker and date range.",
        narration:
          "Analytics sections start collapsed behind descriptive headers. Expand one and it carries its own filter — a person picker beside a date range with presets — so scoping runtime events never hides feedback, activity, or usage in another panel.",
        durationSeconds: 18,
        focus: "anFilters",
      },
      {
        title: "Runtime metadata and CSV",
        caption: "Runtime Clock Metadata exports CSV with actor columns; a single-user view suffixes the filename.",
        narration:
          "Runtime Clock Metadata shows execution timestamps from real chat and draft completions. The CSV popover has its own date range, files carry actor columns, and selecting a single user stamps that user into the filename.",
        durationSeconds: 17,
        focus: "anRuntime",
      },
      {
        title: "Model activity and user usage",
        caption: "User Usage records durable per-user completions; token counts are provider-reported, owners excluded.",
        narration:
          "Model Activity charts saved prompt volume, and User Usage keeps a durable per-user record of real completions for this organization's admins and users across chat, drafts, agents, and the API. Token counts are provider-reported only — blank means the provider reported none.",
        durationSeconds: 21,
        focus: "anUsage",
      },
      {
        title: "The workspace budget and token caps",
        caption: "The owner sets the workspace ceiling; admins add per-user and per-group caps — most restrictive wins.",
        narration:
          "The owner sets the workspace usage ceiling, shown here read-only. Below it, admins set per-user and per-group token caps with daily, weekly, or monthly UTC resets — and when several caps apply, the most restrictive one wins.",
        durationSeconds: 17,
        focus: "anBudget",
      },
    ],
  },
  {
    id: "admin-policies",
    audioSrc: "training/admin/admin-policies.mp3",
    title: "Policies and memory governance",
    description: "Apply organization controls inside service-wide availability and govern private memory without reading it.",
    icon: "policies",
    outcomes: ["Service policy understood", "Default access set", "Memory governed privately"],
    scenes: [
      {
        title: "A collapsed, scan-friendly start",
        caption: "Policies is always present; Policy Controls, Personalization Memory, and Memory by User all start collapsed.",
        narration:
          "The Policies tab is always present. Policy Controls, Personalization Memory, and Memory by User all start collapsed, so you can scan the page and expand only the control you need.",
        durationSeconds: 14,
        focus: "policyCollapsed",
        calloutPlacement: "left-rail",
      },
      {
        title: "Read service availability first",
        caption: "Available, read-only, and service-managed statuses define what this organization can govern.",
        narration:
          "Expand Policy Controls and read service availability first. Status rows show which administrator account, sign-in, SSO, and model-default decisions are available in this console. Your controls can narrow access for the organization, while capabilities unavailable under service policy remain locked.",
        durationSeconds: 22,
        focus: "policyServiceAvailability",
        calloutPlacement: "left-rail",
      },
      {
        title: "Set Default Users downstream",
        caption: "API, private-agent building, and memory switches apply to Default Users; locked grants stay saved.",
        narration:
          "The three downstream switches apply to the protected Default Users group: personal API keys, private-agent building, and personalization memory. If the owner turns a ceiling off, the matching switch locks while its saved group grant stays preserved for a later re-enable.",
        durationSeconds: 19,
        focus: "policyDefaults",
        calloutPlacement: "left-rail",
      },
      {
        title: "Set the memory policy",
        caption: "Choose organization enablement, automatic learning, retention, and a one-to-two-thousand memory capacity.",
        narration:
          "Expand Personalization Memory to decide whether this organization uses memory and whether the assistant may learn durable preferences automatically. Retention ranges from one to three thousand six hundred fifty days. Capacity ranges from one to two thousand memories per user, with two hundred as the general-purpose default.",
        durationSeconds: 23,
        focus: "policyMemory",
        calloutPlacement: "left-rail",
      },
      {
        title: "Compliance sees counts, never content",
        caption: "Memory by User shows content-free counts and purge controls; admins and owners cannot read another person's memory.",
        narration:
          "Memory by User is a compliance surface, not a reading surface. Refresh it to see content-free counts and purge a person's memories when policy requires it. Administrators cannot read what another person's memory says.",
        durationSeconds: 16,
        focus: "policyCounts",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "admin-audit",
    audioSrc: "training/admin/admin-audit.mp3",
    title: "Tenant audit",
    description: "Governance signals, prompt monitoring, security alerts, and the tenant trail.",
    icon: "audit",
    outcomes: ["Signals reviewed", "Alerts actioned", "Trail exported"],
    scenes: [
      {
        title: "Posture at a glance",
        caption: "The dashboard stays open on top — critical events lead — while the sections below start collapsed.",
        narration:
          "The Audit tab opens on the posture dashboard — audit events, critical events, the prompt watchlist, active admins and users, connector issues, and ungrouped models — while the sections below start collapsed. Cards that need attention are highlighted.",
        durationSeconds: 18,
        focus: "auCards",
      },
      {
        title: "Prompts and security alerts",
        caption: "Expand each section for its own user and date filter; prompts show the model's response too.",
        narration:
          "Expand User Prompt Activity to drill into saved prompts and their model responses, scoped by the section's own user and date filter. Below it, Security Alerts lists DLP and misuse flags with redacted snippets you can acknowledge or reopen — behind its own filter as well.",
        durationSeconds: 20,
        focus: "auPromptSelect",
      },
      {
        title: "The append-only trail",
        caption: "Severity, category, and text search stack on the trail's own filter; CSV exports the visible rows.",
        narration:
          "The Audit Trail is the tenant's append-only log, newest first. Severity, category, and text search stack on top of the trail's own user and date filter, and the CSV export carries exactly the visible filtered rows, actor columns included.",
        durationSeconds: 18,
        focus: "auTrailFilters",
      },
    ],
  },
  {
    id: "admin-alerts",
    audioSrc: "training/admin/admin-alerts.mp3",
    title: "Alerts and delivery",
    description: "Watch rules over tenant audit activity with honest email delivery statuses.",
    icon: "alerts",
    outcomes: ["Rule created", "Deliveries read honestly"],
    scenes: [
      {
        title: "Email delivery status",
        caption: "Admins see a read-only email status; alerts are always logged in-app whether or not email works.",
        narration:
          "The Alerts tab starts with Email Delivery — for admins this is a read-only status of the platform email configuration. Either way, alerts are always logged in-app, so nothing depends on email being set up.",
        durationSeconds: 15,
        focus: "alEmail",
      },
      {
        title: "Tenant alert rules",
        caption: "Start from the Suspicious-activity template or New rule; owner actions never match tenant rules.",
        narration:
          "Alert rules watch this organization's admin and user audit activity. Start from the Suspicious-activity template or build one with New rule, and every match stays scoped to the people you administer.",
        durationSeconds: 15,
        focus: "alRules",
      },
      {
        title: "Anatomy of a rule",
        caption: "Action patterns like security.*, minimum severity, watched user, fire-when threshold, cooldown, recipients.",
        narration:
          "A rule combines action patterns like security dot star, a minimum severity, an optional watched user, a fire-when threshold within a window, and a cooldown. Email recipients are comma-separated — leave them empty and the rule logs in-app only.",
        durationSeconds: 18,
        focus: "alRuleForm",
      },
      {
        title: "Honest delivery statuses",
        caption: "Real statuses plus Archive: clear a delivery from the view without deleting its history.",
        narration:
          "Alert Deliveries records every trigger with its real status — sent, queued, failed with the actual SMTP error, not configured, or logged in-app. Archive a delivery to clear the view — its history is kept, and Show archived brings it back for review or restore.",
        durationSeconds: 19,
        focus: "alDeliveries",
      },
    ],
  },
  {
    id: "admin-retention",
    audioSrc: "training/admin/admin-retention.mp3",
    title: "Data retention and tagging",
    description: "Turn on chat tagging, find tagged conversations, and archive or delete them in bulk.",
    icon: "retention",
    outcomes: ["Tagging toggles understood", "Tagged chats found", "Batch action executed safely"],
    scenes: [
      {
        title: "The Data Retention panel",
        caption: "Policies hosts the Data Retention panel: three tagging toggles, all off until you enable them.",
        narration:
          "The Policies tab hosts the Data Retention panel. Three toggles control how chats are tagged, and every one of them starts off — nothing is tagged until an administrator turns tagging on.",
        durationSeconds: 13,
        focus: "retentionPanel",
      },
      {
        title: "Three sources of tags",
        caption: "Tag chats that use MCP connections, chats with file uploads, and chats by subject.",
        narration:
          "Tag chats that use MCP connections marks any conversation that touched a connected tool, like Box. Tag chats with file uploads marks conversations carrying documents or images. And Tag chats by subject asks the chat's own model to classify each new conversation once, into a curated set of subjects like legal or financial.",
        durationSeconds: 24,
        focus: "retentionToggles",
      },
      {
        title: "Prompts and Tags",
        caption: "User Prompt Activity now has two views — switch to Tags to see every chat with its tags.",
        narration:
          "The Audit tab's User Prompt Activity panel now carries two views. Prompts is the activity list you know. Switch to Tags, and every chat in the organization appears — tagged or not.",
        durationSeconds: 13,
        focus: "retentionTagsSwitch",
      },
      {
        title: "Read the tag chips",
        caption: "Each row shows its tag chips — mcp, attachments, and subject — with search and a tag-type filter.",
        narration:
          "Each row carries its tag chips. An mcp chip names the connection the chat used, attachments distinguishes documents from images, and subject shows the model's classification. The search box and the tag-type filter narrow the list to exactly the cohort you need.",
        durationSeconds: 19,
        focus: "retentionTagsExplorer",
      },
      {
        title: "Preview before you act",
        caption: "Click a chat title to read the full conversation before deciding what happens to it.",
        narration:
          "Click any chat title to open the full conversation preview, so you can read exactly what a chat contains before acting on it.",
        durationSeconds: 9,
        focus: "retentionPreview",
      },
      {
        title: "Archive or delete in bulk",
        caption: "Select chats — or select all — then Archive or Delete with an inline confirm; legal holds are never deleted.",
        narration:
          "Select the chats that matter, or select them all, then choose Archive or Delete. A confirmation is always required before anything happens, and chats under an active legal hold are skipped and reported — a hold always wins.",
        durationSeconds: 16,
        focus: "retentionBatch",
      },
    ],
  },
];

const VIDEO_ICONS = {
  users: UserPlus,
  groups: Users,
  models: SlidersHorizontal,
  tools: Wrench,
  sso: Mail,
  analytics: BarChart3,
  policies: SlidersHorizontal,
  audit: ShieldCheck,
  alerts: BellRing,
  retention: DatabaseZap,
} satisfies Record<AdminGuideIcon, typeof UserPlus>;

const ADMIN_DECK: TrainingDeck = {
  badge: "Admin walkthrough",
  regions: ADMIN_FOCUS_REGIONS,
  videos: ADMIN_TRAINING_VIDEOS,
  icons: VIDEO_ICONS,
  pdf: {
    href: "docs/aperture-admin-guide.pdf",
    title: "Administrator guide (PDF)",
    description:
      "The full user guide plus every admin tab — users, groups, model access, connections, SSO, analytics, policies and memory, audit, and alerts — spelled out step by step.",
    tooltip: "Download the printable administrator guide covering every console tab",
  },
};

export function AdminDocumentationModal({ onClose }: { onClose: () => void }) {
  return (
    <TrainingDocumentationModal
      deck={ADMIN_DECK}
      docTitleId="admin-doc-title"
      videoTitleId="admin-video-title"
      title="Admin console documentation"
      description="Narrated walkthroughs of every admin surface: users, groups, model access, connections, SSO, analytics, policies and memory, audit, and alerts."
      backTooltip="Return to the full list of admin walkthroughs"
      onClose={onClose}
    />
  );
}
