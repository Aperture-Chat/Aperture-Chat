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
  | "responseOverview"
  | "responseCreate"
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
  | "accessRequestsQueue"
  | "accessSignInHandoff"
  | "accessTemporaryPassword"
  | "accessModelReadiness"
  | "accessFirstReply"
  | "feedbackOverview"
  | "feedbackEntries"
  | "feedbackConversation"
  | "feedbackIssueReport"
  | "maRequests"
  | "maRequestGroup"
  | "maUserTrace";

export const ADMIN_FOCUS_REGIONS: Record<AdminFocus, FocusRegion> = {
  maRequests: { frame: "training/admin/model-access-requests.png", rect: { x: 264.906, y: 237.75, w: 881.188, h: 274 } },
  maRequestGroup: { frame: "training/admin/model-access-requests.png", rect: { x: 779.594, y: 355.75, w: 330.484, h: 122 } },
  maUserTrace: { frame: "training/admin/model-access-trace.png", rect: { x: 212.5, y: 68.391, w: 760, h: 684 } },
  usersTabs: { frame: "training/admin/users.png", rect: { x: 261, y: 163, w: 889, h: 54 } },
  usersAdd: { frame: "training/admin/users.png", rect: { x: 836, y: 259, w: 116, h: 45 } },
  usersTable: { frame: "training/admin/users.png", rect: { x: 282, y: 342, w: 867, h: 489 } },
  usersActions: { frame: "training/admin/users-actions.png", rect: { x: 992, y: 393, w: 136, h: 430 } },
  groupsCards: { frame: "training/admin/groups.png", rect: { x: 297, y: 427, w: 817, h: 267 } },
  groupsEditor: { frame: "training/admin/groups.png", rect: { x: 282, y: 712, w: 847, h: 143 } },
  groupsPermGrid: { frame: "training/admin/groups-permissions.png", rect: { x: 312, y: 107, w: 787, h: 671 } },
  groupsAgentAuthoring: { frame: "training/admin/groups-permissions.png", rect: { x: 312, y: 506, w: 787, h: 70 } },
  maSync: { frame: "training/admin/model-access.png", rect: { x: 668, y: 510, w: 413, h: 45 } },
  maColumns: { frame: "training/admin/model-access.png", rect: { x: 282, y: 700, w: 867, h: 46 } },
  maToggleScope: { frame: "training/admin/model-access.png", rect: { x: 869, y: 749, w: 280, h: 39 } },
  // Re-measure both targets when the reconciled Connections tab is captured.
  responseOverview: { frame: "training/admin/connections.png", rect: { x: 262, y: 235, w: 887, h: 114 } },
  responseCreate: { frame: "training/admin/connections.png", rect: { x: 892, y: 269, w: 189, h: 45 } },
  connResponseActions: { frame: "training/admin/response-actions.png", rect: { x: 262, y: 235, w: 887, h: 114 } },
  ssoPreset: { frame: "training/admin/sso-form.png", rect: { x: 283, y: 363, w: 307, h: 91 } },
  ssoFields: { frame: "training/admin/sso-form.png", rect: { x: 283, y: 459, w: 845, h: 216 } },
  ssoCreate: { frame: "training/admin/sso-form.png", rect: { x: 283, y: 739, w: 845, h: 74 } },
  ssoPanel: { frame: "training/admin/sso-readonly.png", rect: { x: 265, y: 238, w: 881, h: 617 } },
  anFilters: { frame: "training/admin/analytics.png", rect: { x: 276, y: 98, w: 859, h: 154 } },
  anRuntime: { frame: "training/admin/analytics.png", rect: { x: 262, y: 245, w: 887, h: 141 } },
  anUsage: { frame: "training/admin/analytics-activity.png", rect: { x: 262, y: 224, w: 887, h: 277 } },
  anBudget: { frame: "training/admin/analytics-usage-budget.png", rect: { x: 261, y: 190, w: 889, h: 314 } },
  // These frames are captured at the native 1185 x 855 composition size, so
  // text stays legible and measured focus borders map one-to-one to the UI.
  policyCollapsed: { frame: "training/admin/policies-collapsed.png", rect: { x: 261, y: 234, w: 889, h: 303 } },
  policyServiceAvailability: { frame: "training/admin/policies-controls.png", rect: { x: 262, y: 96, w: 887, h: 331 } },
  policyDefaults: { frame: "training/admin/policies-controls.png", rect: { x: 262, y: 432, w: 887, h: 384 } },
  policyMemory: { frame: "training/admin/policies-memory.png", rect: { x: 261, y: 338, w: 889, h: 440 } },
  policyCounts: { frame: "training/admin/policies-counts.png", rect: { x: 261, y: 442, w: 889, h: 217 } },
  auCards: { frame: "training/admin/audit.png", rect: { x: 262, y: 322, w: 887, h: 323 } },
  auPromptSelect: { frame: "training/admin/audit-alerts.png", rect: { x: 276, y: 97, w: 859, h: 154 } },
  auTrailFilters: { frame: "training/admin/audit-trail.png", rect: { x: 262, y: 244, w: 887, h: 85 } },
  alEmail: { frame: "training/admin/alerts.png", rect: { x: 261, y: 234, w: 889, h: 181 } },
  alRules: { frame: "training/admin/alerts.png", rect: { x: 261, y: 424, w: 889, h: 175 } },
  alRuleForm: { frame: "training/admin/alerts-rule-form.png", rect: { x: 262, y: 204, w: 887, h: 447 } },
  alDeliveries: { frame: "training/admin/alerts.png", rect: { x: 261, y: 608, w: 889, h: 195 } },
  // Retention frames are local-stack captures with synthetic chats and tags;
  // rects were measured from the live DOM at capture time.
  retentionNavigation: { frame: "training/admin/retention-navigation.png", rect: { x: 893.469, y: 160.75, w: 69.516, h: 58 } },
  retentionWorkspace: { frame: "training/admin/retention-workspace.png", rect: { x: 257.906, y: 382.75, w: 895.188, h: 90 } },
  retentionSources: { frame: "training/admin/retention-sources.png", rect: { x: 277.906, y: 413.062, w: 855.188, h: 308.875 } },
  retentionSensitive: { frame: "training/admin/retention-sensitive.png", rect: { x: 277.906, y: 410.938, w: 855.188, h: 34 } },
  retentionHolds: { frame: "training/admin/retention-holds.png", rect: { x: 296.906, y: 318.703, w: 817.188, h: 216.875 } },
  retentionSchedulePreview: { frame: "training/admin/retention-schedule-preview.png", rect: { x: 277.906, y: 367.25, w: 855.188, h: 178.875 } },
  retentionPanel: { frame: "training/admin/retention-policy.png", rect: { x: 277.906, y: 401.188, w: 857.188, h: 157 } },
  retentionToggles: { frame: "training/admin/retention-policy.png", rect: { x: 265.90625, y: 544.75, w: 879.1875, h: 222 } },
  retentionTagsSwitch: { frame: "training/admin/retention-tags.png", rect: { x: 265.90625, y: 129.75, w: 879.1875, h: 78 } },
  retentionTagsExplorer: { frame: "training/admin/retention-tags.png", rect: { x: 277.906, y: 329.266, w: 855.188, h: 196.875 } },
  retentionPreview: { frame: "training/admin/retention-preview.png", rect: { x: 174.5, y: 228.094, w: 836, h: 398.797 } },
  retentionBatch: { frame: "training/admin/retention-batch.png", rect: { x: 277.906, y: 355.016, w: 855.188, h: 145 } },
  accessRequestsQueue: { frame: "training/admin/access-requests.png", rect: { x: 265.906, y: 322.75, w: 879.188, h: 186 } },
  accessSignInHandoff: { frame: "training/admin/access-handoff.png", rect: { x: 265.906, y: 322.75, w: 879.188, h: 194.391 } },
  accessTemporaryPassword: { frame: "training/admin/access-temporary-password.png", rect: { x: 362.5, y: 266, w: 460, h: 323 } },
  accessModelReadiness: { frame: "training/admin/access-model-readiness.png", rect: { x: 282, y: 700, w: 867, h: 151 } },
  accessFirstReply: { frame: "training/admin/access-first-reply.png", rect: { x: 318, y: 335.766, w: 833, h: 155.5 } },
  feedbackOverview: { frame: "training/admin/support-issue-review.png", rect: { x: 265, y: 0, w: 881, h: 855 } },
  feedbackEntries: { frame: "training/admin/feedback-entries.png", rect: { x: 266, y: 412, w: 879, h: 186 } },
  feedbackConversation: { frame: "training/admin/feedback-response-preview.png", rect: { x: 183, y: 61, w: 820, h: 734 } },
  feedbackIssueReport: { frame: "training/admin/support-issue-detail.png", rect: { x: 213, y: 18, w: 760, h: 820 } },
};

type AdminGuideIcon = "users" | "groups" | "models" | "tools" | "sso" | "analytics" | "policies" | "audit" | "alerts" | "retention";

export type AdminTrainingVideo = TrainingVideoBase & { icon: AdminGuideIcon };

export const ADMIN_TRAINING_VIDEOS: AdminTrainingVideo[] = [
  {
    id: "admin-model-requests",
    audioSrc: "training/admin/admin-model-requests.mp3",
    title: "Review model requests and explain access",
    description: "Review pending model requests, choose the correct group, and trace the rules for an individual user.",
    icon: "models",
    outcomes: [
      "Request reviewed",
      "Group scope checked",
      "Access traced"
    ],
    setupSteps: [
      "Open Model Access and review its Access requests panel. This queue concerns models; new-account approvals remain on Users.",
      "Read the requester, model, and server reason, then choose Grant through group.",
      "If the selected group does not yet carry the model, approval grants it to everyone in that group. Check the full membership before confirming.",
      "Approve or Decline, then verify the resulting server decision. An allowed model can still be unusable if its provider is offline.",
      "On Users, choose Access in the person's Actions column to inspect their group membership and each policy gate without changing it."
    ],
    scenes: [
      {
        title: "Separate model requests from account approvals",
        caption: "Model Access → Access requests lists people asking for a model their groups do not grant.",
        narration: "Open Model Access and review Access requests. Each row identifies the requester, model, and the server's reason for the restriction. These are model requests from existing users. The access-request queue on Users separately handles approval to join the workspace.",
        durationSeconds: 20,
        focus: "maRequests"
      },
      {
        title: "Choose the group with care",
        caption: "Grant through group can add the requester and, when permitted, grant the model to the whole group.",
        narration: "Choose Grant through group before approving. Approval adds the requester to that group. If the option says also grant model to group, every member of the group gains that model too. Review who belongs to the group and choose the narrowest appropriate one. Unavailable choices reflect your current permissions.",
        durationSeconds: 20,
        focus: "maRequestGroup"
      },
      {
        title: "Review the result before declaring success",
        caption: "Approve or Decline resolves the request. Model permission still depends on provider availability.",
        narration: "Choose Approve or Decline and read the result. A successful approval changes access through the selected group, but a provider problem can still prevent replies. Ask the user to refresh model access and verify a real message. Use Refresh to reload the pending queue when other administrators are also reviewing it.",
        durationSeconds: 22,
        focus: "maRequests"
      },
      {
        title: "Trace one person's model access",
        caption: "Users → Actions → Access shows groups, the server reason, and each policy gate in order.",
        narration: "On Users, choose Access in the person's Actions column you are helping. The trace lists their groups and the evaluated gates for each model. Expand a model to see why it is usable, blocked, or allowed with a provider offline. This view explains the decision; it does not change group membership or permissions.",
        durationSeconds: 21,
        focus: "maUserTrace",
        calloutPlacement: "left-rail"
      }
    ]
  },
  {
    id: "admin-access-onboarding",
    audioSrc: "training/admin/admin-access-onboarding.mp3",
    title: "Approve access and finish sign-in",
    description: "Take an access request through account approval, sign-in instructions, and a verified first conversation.",
    icon: "users",
    outcomes: ["Request reviewed", "Sign-in arranged", "First reply verified"],
    setupSteps: [
      "Choose Admin console near the bottom of the sidebar, then select Users.",
      "Confirm the requester and choose an available Approve as role. Approval changes account access; your team must still arrange sign-in.",
      "In Finish sign-in setup, share the workspace sign-in address and confirm Organization SSO or Email & password. No approval email is sent automatically.",
      "When local sign-in is allowed, set a temporary password and share it securely with the named recipient. They choose their own password during first sign-in and complete any required authenticator verification.",
      "Check that the account is active, belongs to the intended platform group, and can use an enabled model assigned to that group in Model Access.",
      "Without an available model, the person can still edit, import, save, and export in Drafts. AI drafting and a first chat response require working model access.",
      "Ask the person to open a new chat, select the available model, send a short message, and confirm that its response arrives.",
    ],
    scenes: [
      {
        title: "Review the request",
        caption: "Users shows Access requests with the person's name, email, request time, and Approve as role.",
        narration:
          "Start in Users and review the Access requests queue. Confirm the person's name and email, choose an appropriate role from Approve as, then approve the request or decline it. The available roles follow your organization's policy.",
        durationSeconds: 16,
        focus: "accessRequestsQueue",
      },
      {
        title: "Arrange their sign-in",
        caption: "Finish sign-in setup explains the manual handoff. Share the workspace address and agreed sign-in method.",
        narration:
          "Approval opens Finish sign-in setup. Share the workspace sign-in address and confirm how this person will authenticate. For Organization SSO, check their identity-provider account. For Email and password, arrange a temporary password. No email has been sent automatically.",
        durationSeconds: 20,
        focus: "accessSignInHandoff",
      },
      {
        title: "Set a temporary password when needed",
        caption: "Keep Temporary password on, save the password, and share it securely with its intended recipient.",
        narration:
          "When local sign-in is allowed, choose Set temporary password. Generate or enter a password, keep Temporary password on, and choose Set password. Share the saved password securely with the recipient. Their first sign-in requires a password of their own and any configured authenticator verification.",
        durationSeconds: 21,
        focus: "accessTemporaryPassword",
        calloutPlacement: "lower-right",
      },
      {
        title: "Check account, group, and model access",
        caption: "An active account needs a platform group and an enabled model assigned to that group.",
        narration:
          "Check the active account, its platform group, and the enabled model assigned in Model Access. Without an available model, Drafts still supports editing, importing, saving, and exporting. AI drafting and a chat response require working model access, so resolve that step before testing the first reply.",
        durationSeconds: 21,
        focus: "accessModelReadiness",
      },
      {
        title: "Confirm the first real reply",
        caption: "Have the new user select a model, send a fresh message, and confirm that a response arrives.",
        narration:
          "Have the person complete sign-in and open a new chat. They select an available model and send a short message. Confirm that the provider returns a response. This checks the complete path from the approved account through model access to a working conversation.",
        durationSeconds: 18,
        focus: "accessFirstReply",
      },
    ],
  },
  {
    id: "admin-users",
    audioSrc: "training/admin/admin-users.mp3",
    title: "Users and accounts",
    setupSteps: [
      "Review the Access requests queue on Users, select Approve as, and approve or decline the request.",
      "After approval, complete Finish sign-in setup. Share the workspace sign-in address and confirm SSO or email-and-password access; no email is sent automatically.",
      "For local access, choose Set temporary password, save the password, and share it securely with the named recipient. The password dialog shows the recipient and sign-in address.",
      "Check group membership and model access, then verify that the person can complete their first sign-in and first message.",
      "For a lost authenticator with no unused recovery code, verify the person's identity through your organization's approved recovery process. Password resets do not reset the authenticator; the current Users screen has no authenticator-reset button.",
    ],
    description: "Create tenant accounts, manage passwords and status, and remove leavers safely.",
    icon: "users",
    outcomes: ["Account created", "Safety floor understood"],
    scenes: [
      {
        title: "The tenant user list",
        caption: "Open Admin console from the sidebar; nine tabs cover the whole tenant.",
        narration:
          "Open the admin console from the Admin console link near the bottom of the sidebar. Nine tabs cover the tenant — Users, Groups, Model Access, Connections, SSO, Analytics, Policies, Audit, and Alerts — and Users is where it starts.",
        durationSeconds: 18,
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
        caption: "Account actions follow your permissions. A password reset does not reset two-step verification.",
        narration:
          "Each row has password, activation, and account-deletion controls allowed by your permissions. A password reset does not reset the authenticator. If someone loses both their authenticator and recovery codes, verify their identity through your organization's approved recovery process. This Users screen has no authenticator-reset button. Unavailable account actions remain disabled with an explanation.",
        durationSeconds: 28,
        focus: "usersActions",
      },
    ],
  },
  {
    id: "admin-groups",
    audioSrc: "training/admin/admin-groups.mp3",
    title: "Groups and permissions",
    description: "Create groups, assign users, and configure runtime access and authoring permissions.",
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
        caption: "Control runtime access, private authoring, and memory; service policy still limits what groups can grant.",
        narration:
          "The Permissions tab controls chat, knowledge, agents, tools, API access, and Hermes. Separate switches grant private agent, knowledge-base, and tool authoring, plus memory access. Read each switch before changing it; service policy still limits what the group can grant.",
        durationSeconds: 19,
        focus: "groupsPermGrid",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
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
        caption: "Sync models pulls the available catalog; All, Enabled, and Disabled counters carry live totals.",
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
    title: "Response actions and connector responsibilities",
    description: "Manage buttons on assistant replies and understand which connection settings need the service team.",
    icon: "tools",
    outcomes: ["Response actions located", "Service handoff understood"],
    scenes: [
      {
        title: "Find Chat output actions",
        caption: "The Admin console's Connections tab contains Chat output actions. The service team manages shared connector configuration.",
        narration:
          "Open Connections in the Admin console to find Chat output actions. These are buttons on assistant replies. Shared connector settings and credentials are managed outside tenant administration. Ask your service team to configure or test a shared source connection.",
        durationSeconds: 19,
        focus: "responseOverview",
      },
      {
        title: "Create a response action",
        caption: "New response action opens the action builder; review its name, description, and script before saving.",
        narration:
          "Choose New response action to open the builder. Give the action a clear name and description, review its script, and test it with suitable sample input before saving. Saved actions can be edited or removed from this panel. Review what an action does before making it available to your team.",
        durationSeconds: 20,
        focus: "responseCreate",
      },
      {
        title: "Keep the connection types clear",
        caption: "Library → Tools manages model-callable tools. Personal attachment connections remain scoped to the signed-in user.",
        narration:
          "Model-callable tools and MCP servers are managed on the Library's Tools tab according to your permissions. Shared connector credentials remain with the service team. People still connect their own cloud account from the attachment picker to access their own files; that personal authorization does not grant shared connector administration.",
        durationSeconds: 23,
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
      "After Test connection passes, complete a fresh identity-provider sign-in and verify the callback, workspace session, and intended groups before enforcing sign-in.",
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
        title: "Test discovery and complete a sign-in",
        caption: "Enforcement starts off. Check discovery, complete a fresh user sign-in, and verify group access before enforcement.",
        narration:
          "Create the configuration with enforcement off, then run Test connection to check discovery and signing keys. Map the identity provider's group values to tenant groups. Complete a fresh user sign-in and verify the workspace session and access before requiring SSO. A passing discovery test alone does not prove sign-in works.",
        durationSeconds: 23,
        focus: "ssoCreate",
      },
      {
        title: "When SSO management is restricted",
        caption: "When service policy restricts SSO management, this tab is read-only for admins.",
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
        caption: "User Usage records completions for workspace admins and users; token counts are provider-reported.",
        narration:
          "Model Activity charts saved prompt volume, and User Usage keeps a durable per-user record of real completions for this organization's admins and users across chat, drafts, agents, and the API. Token counts are provider-reported only — blank means the provider reported none.",
        durationSeconds: 21,
        focus: "anUsage",
      },
      {
        title: "The workspace budget and token caps",
        caption: "The workspace ceiling is read-only here; admins add user and group caps — most restrictive wins.",
        narration:
          "The workspace usage ceiling is managed by the service team and shown here read-only. Below it, admins set per-user and per-group token caps with daily, weekly, or monthly UTC resets. When several caps apply, the most restrictive one wins.",
        durationSeconds: 18,
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
        caption: "Policies stays available. Memory controls and counts appear only when service policy permits them.",
        narration:
          "Policies stays available, and its sections start collapsed. When service policy allows memory, Personalization Memory and Memory by User expose its controls and counts. Otherwise, Memory governance explains why they are unavailable, while saved organization settings remain intact.",
        durationSeconds: 20,
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
        caption: "API, private agent, knowledge and tool authoring, and memory apply to Default Users; locked grants stay saved.",
        narration:
          "These defaults apply to the protected Default Users group: personal API keys, private agent building, private knowledge-base and tool authoring, and personalization memory. When service policy makes a capability unavailable, its switch locks while the saved group grant stays preserved for a later re-enable.",
        durationSeconds: 21,
        focus: "policyDefaults",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "Set the memory policy",
        caption: "Choose organization enablement, automatic learning, retention, and a one-to-two-thousand memory capacity.",
        narration:
          "When service policy permits memory, expand Personalization Memory to decide whether this organization uses memory and whether the assistant may learn durable preferences automatically. Retention ranges from one to three thousand six hundred fifty days. Capacity ranges from one to two thousand memories per user, with two hundred as the general-purpose default.",
        durationSeconds: 25,
        focus: "policyMemory",
        calloutPlacement: "left-rail",
      },
      {
        title: "Compliance sees counts, never content",
        caption: "Memory by User shows content-free counts and purge controls; administrators cannot read another person's memory.",
        narration:
          "When available, Memory by User is a compliance surface, not a reading surface. Refresh it to see content-free counts and purge a person's memories when policy requires it. Administrators cannot read what another person's memory says.",
        durationSeconds: 17,
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
        caption: "Audit opens with the posture dashboard. Expand the sections below for detailed controls.",
        narration:
          "The Audit tab opens on the posture dashboard — audit events, critical events, the prompt watchlist, active admins and users, connector issues, and ungrouped models — while the sections below start collapsed. Cards that need attention are highlighted. Data Retention sits below Recent Governance Activity and groups schedules, tags, and legal holds.",
        durationSeconds: 24,
        focus: "auCards",
      },
      {
        title: "Prompts and security alerts",
        caption: "Expand each section for its own user and date filter; prompts show the model's response too.",
        narration:
          "Expand User Prompt Activity to drill into saved prompts and their model responses, scoped by the section's own user and date filter. Below it, Security Alerts lists DLP and misuse flags with redacted snippets you can acknowledge or reopen — behind its own filter as well.",
        durationSeconds: 20,
        focus: "auPromptSelect",
        captionPlacement: "top",
      },
      {
        title: "The append-only trail",
        caption: "Severity, category, and text search stack on the trail's own filter; CSV exports the visible rows.",
        narration:
          "The Audit Trail is the tenant's append-only log, newest first. Severity, category, and text search stack on top of the trail's own user and date filter, and the CSV export carries exactly the visible filtered rows, actor columns included.",
        durationSeconds: 18,
        focus: "auTrailFilters",
        captionPlacement: "top",
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
        caption: "Start from the Suspicious-activity template or New rule; matches stay within your administrative scope.",
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
        calloutPlacement: "left-rail",
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
    description: "Keep chats forever by default, review client labels and holds, and preview an optional retention schedule.",
    icon: "retention",
    outcomes: ["Forever default understood", "Client labels reviewed", "Retention changes previewed"],
    setupSteps: [
      "Choose Admin console near the bottom of the sidebar.",
      "Select Audit, then expand Data Retention below Recent Governance Activity.",
      "Use Schedule and rules for the duration slider, client or matter sources, and Preview effect.",
      "Use Tags and holds to find conversations, review labels, and expand Legal holds.",
    ],
    scenes: [
      {
        title: "Start in the Audit tab",
        caption: "Admin Console → Audit. Retention lives below Recent Governance Activity.",
        narration: "From the Admin Console, select Audit in the top row of tabs. Scroll below Recent Governance Activity to find Data Retention. Expand that panel to manage both schedules and conversation labels.",
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
  {
    id: "admin-feedback-issues",
    audioSrc: "training/admin/admin-feedback-issues.mp3",
    title: "Review feedback and reported issues",
    description: "Inspect response ratings, written notes, conversation context, and platform issue reports in Analytics.",
    icon: "analytics",
    outcomes: ["Feedback scoped", "Conversation reviewed", "Issue evidence inspected"],
    setupSteps: [
      "Open Admin console → Analytics and expand Chat Feedback.",
      "Use the person and date controls to narrow the review. Response ratings and platform issues share this scope but have separate totals.",
      "Platform issues come from Help → Report a problem. An empty review scope means there are no matching records to inspect.",
      "Open a feedback row to read its note and the saved conversation. Wait for the conversation to load and locate the rated exchange.",
      "Open a row under Reported platform issues to inspect its subject, report text, sender, timestamp, and any attached screenshot.",
      "Use your team's support process to assign follow-up after reviewing the evidence. Close the preview to return to the list.",
    ],
    scenes: [
      {
        title: "Start with a clear review scope",
        caption: "Analytics → Chat Feedback combines response ratings and reported platform issues with person and date filters.",
        narration:
          "Open Analytics and expand Chat Feedback. Choose a person and date range, or a date shortcut. The summary separates total response feedback, positive ratings, negative ratings, and platform issue reports. If the scope has no matching records, the list stays empty.",
        durationSeconds: 19,
        focus: "feedbackOverview",
        calloutPlacement: "left-rail",
      },
      {
        title: "Read the rating and written note",
        caption: "Each feedback row identifies the chat, model, user, rating, timestamp, and optional written comment.",
        narration:
          "Read the feedback row before opening it. It identifies the chat, model, user, rating, and time, with a response preview and any written comment. Positive and negative ratings describe the person's feedback; inspect the underlying exchange to understand what happened.",
        durationSeconds: 19,
        focus: "feedbackEntries",
      },
      {
        title: "Inspect the conversation in context",
        caption: "Feedback and conversation shows the saved exchanges, with the rated exchange highlighted when available.",
        narration:
          "Open the row to view Feedback and conversation. Read the user's note and the saved prompt and response around the highlighted rated exchange. If the conversation could not be loaded, the dialog says that only the saved response preview is available. Use the evidence that actually loaded.",
        durationSeconds: 20,
        focus: "feedbackConversation",
        calloutPlacement: "left-rail",
      },
      {
        title: "Review the reported platform problem",
        caption: "Reported platform issues opens the report text, sender, timestamp, and any attached screenshot.",
        narration:
          "Reports submitted through Help, Report a problem appear under Reported platform issues. Open an existing report and read its subject, description, sender, and timestamp. Inspect an attached screenshot when it loads. Use these details in your team's support process, then close the preview.",
        durationSeconds: 20,
        focus: "feedbackIssueReport",
        calloutPlacement: "left-rail",
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
