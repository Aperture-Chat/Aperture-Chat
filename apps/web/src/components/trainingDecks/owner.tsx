import { BarChart3, BellRing, Clock3, DatabaseZap, Edit3, KeyRound, Lock, Mail, Palette, QrCode, ShieldAlert, UserPlus } from "lucide-react";
import { TrainingDocumentationModal, type TrainingDeck } from "../TrainingVideoLibrary";
import type { FocusRegion, TrainingVideoBase } from "../trainingVideoKit";

/* Frames are real captures of an isolated synthetic instance, taken while
 * each task is performed end to end by the walkthrough modules in
 * apps/web/scripts/walkthroughs/ (owner-*.cjs and sso.cjs; see
 * capture-walkthroughs.cjs). Rects are measured from the live DOM. */

export type OwnerFocus =
  | "rolesDisclosure"
  | "rolesCreateForm"
  | "rolesSetPassword"
  | "ssoPanelOpen"
  | "ssoRedirectCopied"
  | "idpRealmCreate"
  | "idpClientGeneral"
  | "idpClientCapability"
  | "idpClientRedirect"
  | "idpClientSecret"
  | "idpGroupMapper"
  | "idpGroups"
  | "idpUserCreate"
  | "ssoProviderDetails"
  | "ssoAccessFields"
  | "ssoAccessToggles"
  | "ssoMfaToggle"
  | "ssoActionsRow"
  | "ssoTestPassed"
  | "ssoSignInForm"
  | "idpLogin"
  | "ssoFirstWelcome"
  | "ssoJitUserRow"
  | "ssoMappingEditor"
  | "ssoGroupsSyncedRow"
  | "ssoEnforceRow"
  | "ssoPasswordBlocked"
  | "ssoDomainRejected"
  | "entraPreset"
  | "oktaPreset"
  | "googlePreset"
  | "googleTestPassed"
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
  | "activityCharts"
  | "usageScorecards"
  | "usageByUser"
  | "auditSignalBoard"
  | "auditInsightsTrends"
  | "auditInsightsPeople"
  | "auditInvestigation"
  | "auditSecurityAlerts"
  | "trailFilters"
  | "alertSmtp"
  | "alertTemplates"
  | "alertDeliveries"
  | "alertRuleForm"
  | "elasticStatus"
  | "elasticConnection"
  | "elasticStreams"
  | "elasticChecks"
  | "elasticDelivery"
  | "firstOwnerSetup"
  | "firstOwnerWelcome"
  | "firstProviderValidated"
  | "firstWorkspaceAccess"
  | "firstWorkspaceReply"
  | "searchIndex"
  | "modelBrowsingPolicy"
  | "firstProvidersEmpty"
  | "firstProviderForm"
  | "firstModelEnabled"
  | "firstAccountCreated"
  | "firstPasswordDialog"
  | "firstPersonSignIn"
  | "firstPersonNewPassword"
  | "pvOverview"
  | "pvKindMenu"
  | "pvLocalForm"
  | "pvLocalConnected"
  | "pvLocalUnreachable"
  | "pvOllamaEmpty"
  | "pvOpenaiForm"
  | "pvOpenaiRejected"
  | "pvAnthropicForm"
  | "pvAzureForm"
  | "pvAzureSaved"
  | "pvOpenrouterForm"
  | "pvGeminiForm"
  | "pvBedrockSaved"
  | "pvEditConnection"
  | "pvDeleteDialog"
  | "kvVaultOpen"
  | "kvAddForm"
  | "kvKeyAdded"
  | "kvReveal"
  | "kvReplaceForm"
  | "kvOldDeleted"
  | "kvExpired"
  | "mdOverview"
  | "mdFilter"
  | "mdDetails"
  | "mdDisabled"
  | "mdUserMenu"
  | "mdUserCatalog"
  | "mdUserCatalogOff"
  | "rolesRoleMenu"
  | "rolesOwnerCreated"
  | "rolesRoleChanged"
  | "rolesAccountDeleted"
  | "rolesAdminSignedIn"
  | "brandGradientError"
  | "brandApplied"
  | "brandSignIn"
  | "brandAppIcon"
  | "policySaved"
  | "policyApiAccess"
  | "budgetUsd"
  | "budgetSaved"
  | "budgetBlocked"
  | "budgetUnlimited"
  | "connWebTested"
  | "connWebKeyed"
  | "connDriveForm"
  | "connDriveTested"
  | "connGraphForm"
  | "connGraphTested"
  | "connBoxTested"
  | "connImanageTested"
  | "searchRebuilt"
  | "searchUserResults"
  | "searchUserPrivate"
  | "alertSmtpFilled"
  | "alertTestFailed"
  | "alertTestSent"
  | "alertRuleCreated"
  | "alertUserFlagged"
  | "elasticCloudCheck"
  | "elasticKeyHelp"
  | "kibanaImport"
  | "kibanaImported"
  | "kibanaDiscover"
  | "analyticsOverview"
  | "runtimeCsv"
  | "feedbackEvents"
  | "feedbackRecord"
  | "auditChartRecords"
  | "auditAlertAcknowledged"
  | "trailExport"
  | "retentionEntry"
  | "retentionSchedule"
  | "retentionSource"
  | "retentionPreviewFinite"
  | "retentionForeverSaved"
  | "retentionScan"
  | "retentionConfirmed"
  | "retentionHold"
  | "retentionConversation"
  | "retentionPreviewHeld";

export const OWNER_FOCUS_REGIONS: Record<OwnerFocus, FocusRegion> = {
  searchIndex: { frame: "training/owner/si-status.png", rect: { x: 261, y: 246, w: 889, h: 226 } },
  modelBrowsingPolicy: { frame: "training/owner/md-browse-policy.png", rect: { x: 282, y: 402, w: 847, h: 51 } },
  // vault/audit/alerts frames are local-stack re-captures with staged synthetic
  // keys, events, rules, and deliveries; rects measured from the live DOM.
  rolesDisclosure: { frame: "training/owner/ur-panel.png", rect: { x: 282, y: 125, w: 847, h: 223 } },
  rolesCreateForm: { frame: "training/owner/ur-admin-created.png", rect: { x: 282, y: 395, w: 847, h: 65 } },
  rolesSetPassword: { frame: "training/owner/ur-password-dialog.png", rect: { x: 359, y: 262, w: 467, h: 331 } },
  // Single sign-on walkthroughs: real captures from capture-walkthroughs.cjs
  // (sso-oidc, sso-golive, sso-providers) against a local Keycloak.
  ssoPanelOpen: { frame: "training/owner/sso-panel-open.png", rect: { x: 262, y: 0, w: 887, h: 230 } },
  ssoRedirectCopied: { frame: "training/owner/sso-redirect-copied.png", rect: { x: 282, y: 383, w: 847, h: 90 } },
  idpRealmCreate: { frame: "training/owner/idp-realm-create.png", rect: { x: 169, y: 131, w: 847, h: 593 } },
  idpClientGeneral: { frame: "training/owner/idp-client-general.png", rect: { x: 279, y: 227, w: 877, h: 163 } },
  idpClientCapability: { frame: "training/owner/idp-client-capability.png", rect: { x: 279, y: 227, w: 877, h: 461 } },
  idpClientRedirect: { frame: "training/owner/idp-client-redirect.png", rect: { x: 279, y: 347, w: 877, h: 79 } },
  idpClientSecret: { frame: "training/owner/idp-client-secret.png", rect: { x: 38, y: 443, w: 980, h: 59 } },
  idpGroupMapper: { frame: "training/owner/idp-group-mapper.png", rect: { x: 13, y: 271, w: 1030, h: 219 } },
  idpGroups: { frame: "training/owner/idp-groups.png", rect: { x: 589, y: 380, w: 596, h: 143 } },
  idpUserCreate: { frame: "training/owner/idp-user-create.png", rect: { x: 13, y: 289, w: 1030, h: 417 } },
  ssoProviderDetails: { frame: "training/owner/sso-form-filled.png", rect: { x: 282, y: 0, w: 847, h: 268 } },
  ssoAccessFields: { frame: "training/owner/sso-access-settings.png", rect: { x: 282, y: 0, w: 847, h: 198 } },
  ssoAccessToggles: { frame: "training/owner/sso-access-settings.png", rect: { x: 282, y: 501, w: 847, h: 163 } },
  ssoMfaToggle: { frame: "training/owner/sso-access-settings.png", rect: { x: 282, y: 557, w: 847, h: 51 } },
  ssoActionsRow: { frame: "training/owner/sso-actions.png", rect: { x: 282, y: 405, w: 847, h: 45 } },
  ssoTestPassed: { frame: "training/owner/sso-saved-tested.png", rect: { x: 282, y: 368, w: 847, h: 118 } },
  ssoSignInForm: { frame: "training/owner/sso-signin-sso.png", rect: { x: 101, y: 317, w: 405, h: 356 } },
  idpLogin: { frame: "training/owner/idp-login.png", rect: { x: 387, y: 368, w: 411, h: 227 } },
  ssoFirstWelcome: { frame: "training/owner/sso-first-welcome.png", rect: { x: 258, y: 21, w: 895, h: 259 } },
  ssoJitUserRow: { frame: "training/owner/sso-jit-user.png", rect: { x: 262, y: 750, w: 887, h: 61 } },
  ssoMappingEditor: { frame: "training/owner/sso-admin-mapping.png", rect: { x: 297, y: 438, w: 390, h: 227 } },
  ssoGroupsSyncedRow: { frame: "training/owner/sso-groups-synced.png", rect: { x: 262, y: 605, w: 887, h: 61 } },
  ssoEnforceRow: { frame: "training/owner/sso-enforce-saved.png", rect: { x: 282, y: 402, w: 847, h: 51 } },
  ssoPasswordBlocked: { frame: "training/owner/sso-password-blocked.png", rect: { x: 101, y: 295, w: 405, h: 437 } },
  ssoDomainRejected: { frame: "training/owner/sso-domain-rejected.png", rect: { x: 101, y: 317, w: 405, h: 430 } },
  entraPreset: { frame: "training/owner/sso-preset-entra.png", rect: { x: 282, y: 410, w: 847, h: 201 } },
  oktaPreset: { frame: "training/owner/sso-preset-okta.png", rect: { x: 282, y: 410, w: 847, h: 201 } },
  googlePreset: { frame: "training/owner/sso-preset-google.png", rect: { x: 282, y: 410, w: 847, h: 201 } },
  googleTestPassed: { frame: "training/owner/sso-google-tested.png", rect: { x: 282, y: 368, w: 847, h: 118 } },
  brandPreview: { frame: "training/owner/br-panel.png", rect: { x: 262, y: 0, w: 887, h: 192 } },
  brandFields: { frame: "training/owner/br-name-logo.png", rect: { x: 282, y: 105, w: 847, h: 600 } },
  brandThemeColors: { frame: "training/owner/br-colors.png", rect: { x: 282, y: 37, w: 847, h: 255 } },
  brandActions: { frame: "training/owner/br-reset.png", rect: { x: 282, y: 345, w: 847, h: 155 } },
  // A 4:3 camera zoom removes the capture tool's unused right/bottom canvas
  // while preserving the native console text. Expanded sections use dedicated
  // scrolled frames, and rects are measured in the final zoomed composition.
  policyCollapsed: { frame: "training/owner/pc-overview.png", rect: { x: 261, y: 418, w: 889, h: 98 } },
  // The enforced-floor row sits above the toggle stack in the toggles frame,
  // inside the readable-viewport envelope pinned by trainingVideoKit.test.ts;
  // sharing the frame with policyToggles glides the highlight down the stack.
  policyFloor: { frame: "training/owner/pc-policy-toggles.png", rect: { x: 282, y: 104, w: 847, h: 51 } },
  policyToggles: { frame: "training/owner/pc-policy-toggles.png", rect: { x: 262, y: 84, w: 887, h: 515 } },
  budgetControls: { frame: "training/owner/pc-budget-panel.png", rect: { x: 283, y: 391, w: 845, h: 94 } },
  // The legacy filename is retained; recapture the new owner Connectors panel
  // and apply its measured bounds before publishing the reconciled UI.
  sharedConnectors: { frame: "training/owner/cn-panel.png", rect: { x: 261, y: 0, w: 889, h: 855 } },
  analyticsFilters: { frame: "training/owner/an-runtime-scoped.png", rect: { x: 262, y: 98, w: 887, h: 303 } },
  runtimeScorecards: { frame: "training/owner/an-runtime.png", rect: { x: 262, y: 245, w: 887, h: 610 } },
  activityCharts: { frame: "training/owner/an-activity.png", rect: { x: 262, y: 391, w: 887, h: 277 } },
  usageScorecards: { frame: "training/owner/an-usage.png", rect: { x: 262, y: 286, w: 887, h: 156 } },
  usageByUser: { frame: "training/owner/an-usage-user.png", rect: { x: 262, y: 47, w: 887, h: 782 } },
  auditSignalBoard: { frame: "training/owner/au-summary.png", rect: { x: 262, y: 322, w: 887, h: 533 } },
  auditInsightsTrends: { frame: "training/owner/au-insights.png", rect: { x: 282, y: 465, w: 847, h: 306 } },
  auditInsightsPeople: { frame: "training/owner/au-insights-people.png", rect: { x: 282, y: 17, w: 847, h: 658 } },
  auditInvestigation: { frame: "training/owner/au-signal-records.png", rect: { x: 229, y: 69, w: 727, h: 717 } },
  auditSecurityAlerts: { frame: "training/owner/au-alerts.png", rect: { x: 262, y: 98, w: 887, h: 746 } },
  trailFilters: { frame: "training/owner/au-trail-filtered.png", rect: { x: 262, y: 245, w: 887, h: 85 } },
  alertSmtp: { frame: "training/owner/al-email-panel.png", rect: { x: 261, y: 234, w: 889, h: 521 } },
  alertTemplates: { frame: "training/owner/al-rule-templates.png", rect: { x: 282, y: 79, w: 633, h: 45 } },
  alertDeliveries: { frame: "training/owner/al-delivered.png", rect: { x: 283, y: 384, w: 845, h: 107 } },
  alertRuleForm: { frame: "training/owner/al-rule-form.png", rect: { x: 262, y: 0, w: 887, h: 642 } },
  // Elastic frames come from a real single-node synthetic cluster the panel
  // was saved against; the delivery counts are its actual sends.
  elasticStatus: { frame: "training/owner/el-failing.png", rect: { x: 262, y: 84, w: 887, h: 95 } },
  elasticConnection: { frame: "training/owner/el-self-managed.png", rect: { x: 282, y: 0, w: 847, h: 260 } },
  elasticStreams: { frame: "training/owner/el-streams.png", rect: { x: 282, y: 56, w: 847, h: 384 } },
  elasticChecks: { frame: "training/owner/el-checked.png", rect: { x: 282, y: 130, w: 847, h: 289 } },
  elasticDelivery: { frame: "training/owner/el-synced.png", rect: { x: 282, y: 521, w: 847, h: 334 } },
  firstOwnerSetup: { frame: "training/owner/fw-setup.png", rect: { x: 101, y: 359, w: 405, h: 449 } },
  firstOwnerWelcome: { frame: "training/owner/fw-welcome.png", rect: { x: 258, y: 21, w: 895, h: 280 } },
  firstProviderValidated: { frame: "training/owner/fw-provider-connected.png", rect: { x: 282, y: 463, w: 847, h: 210 } },
  firstWorkspaceAccess: { frame: "training/owner/fw-model-access.png", rect: { x: 282, y: 645, w: 867, h: 163 } },
  firstWorkspaceReply: { frame: "training/owner/fw-first-reply.png", rect: { x: 315, y: 311, w: 839, h: 49 } },
  firstProvidersEmpty: { frame: "training/owner/fw-providers-empty.png", rect: { x: 262, y: 279, w: 887, h: 272 } },
  firstProviderForm: { frame: "training/owner/fw-provider-form.png", rect: { x: 262, y: 362, w: 887, h: 321 } },
  firstModelEnabled: { frame: "training/owner/fw-model-enabled.png", rect: { x: 283, y: 468, w: 845, h: 77 } },
  firstAccountCreated: { frame: "training/owner/fw-account-created.png", rect: { x: 282, y: 171, w: 847, h: 289 } },
  firstPasswordDialog: { frame: "training/owner/fw-password-dialog.png", rect: { x: 359, y: 279, w: 467, h: 297 } },
  firstPersonSignIn: { frame: "training/owner/fw-person-signin.png", rect: { x: 101, y: 302, w: 405, h: 290 } },
  firstPersonNewPassword: { frame: "training/owner/fw-person-new-password.png", rect: { x: 390, y: 357, w: 405, h: 288 } },
  pvOverview: { frame: "training/owner/pv-overview.png", rect: { x: 262, y: 362, w: 887, h: 493 } },
  pvKindMenu: { frame: "training/owner/pv-kind-menu.png", rect: { x: 496, y: 82, w: 207, h: 287 } },
  pvLocalForm: { frame: "training/owner/pv-local-form.png", rect: { x: 262, y: 0, w: 887, h: 317 } },
  pvLocalConnected: { frame: "training/owner/pv-local-connected.png", rect: { x: 282, y: 470, w: 420, h: 338 } },
  pvLocalUnreachable: { frame: "training/owner/pv-local-unreachable.png", rect: { x: 709, y: 470, w: 420, h: 338 } },
  pvOllamaEmpty: { frame: "training/owner/pv-ollama-empty.png", rect: { x: 282, y: 552, w: 420, h: 256 } },
  pvOpenaiForm: { frame: "training/owner/pv-openai-form.png", rect: { x: 262, y: 0, w: 887, h: 317 } },
  pvOpenaiRejected: { frame: "training/owner/pv-openai-rejected.png", rect: { x: 709, y: 552, w: 420, h: 256 } },
  pvAnthropicForm: { frame: "training/owner/pv-anthropic-form.png", rect: { x: 262, y: 0, w: 887, h: 317 } },
  pvAzureForm: { frame: "training/owner/pv-azure-form.png", rect: { x: 262, y: 0, w: 887, h: 317 } },
  pvAzureSaved: { frame: "training/owner/pv-azure-saved.png", rect: { x: 282, y: 534, w: 420, h: 274 } },
  pvOpenrouterForm: { frame: "training/owner/pv-openrouter-form.png", rect: { x: 262, y: 0, w: 887, h: 367 } },
  pvGeminiForm: { frame: "training/owner/pv-gemini-form.png", rect: { x: 262, y: 0, w: 887, h: 317 } },
  pvBedrockSaved: { frame: "training/owner/pv-bedrock-saved.png", rect: { x: 709, y: 488, w: 420, h: 320 } },
  pvEditConnection: { frame: "training/owner/pv-edit-connection.png", rect: { x: 300, y: 197, w: 811, h: 234 } },
  pvDeleteDialog: { frame: "training/owner/pv-delete-dialog.png", rect: { x: 359, y: 298, w: 467, h: 259 } },
  kvVaultOpen: { frame: "training/owner/kv-vault-open.png", rect: { x: 300, y: 626, w: 811, h: 165 } },
  kvAddForm: { frame: "training/owner/kv-add-form.png", rect: { x: 300, y: 509, w: 811, h: 163 } },
  kvKeyAdded: { frame: "training/owner/kv-key-added.png", rect: { x: 300, y: 731, w: 800, h: 59 } },
  kvReveal: { frame: "training/owner/kv-reveal.png", rect: { x: 309, y: 316, w: 567, h: 223 } },
  kvReplaceForm: { frame: "training/owner/kv-replace-form.png", rect: { x: 300, y: 456, w: 811, h: 163 } },
  kvOldDeleted: { frame: "training/owner/kv-old-deleted.png", rect: { x: 300, y: 638, w: 800, h: 152 } },
  kvExpired: { frame: "training/owner/kv-expired.png", rect: { x: 300, y: 741, w: 800, h: 49 } },
  mdOverview: { frame: "training/owner/md-overview.png", rect: { x: 601, y: 269, w: 482, h: 45 } },
  mdFilter: { frame: "training/owner/md-filter.png", rect: { x: 363, y: 402, w: 223, h: 183 } },
  mdDetails: { frame: "training/owner/md-details.png", rect: { x: 295, y: 399, w: 821, h: 298 } },
  mdDisabled: { frame: "training/owner/md-disabled.png", rect: { x: 283, y: 523, w: 845, h: 61 } },
  mdUserMenu: { frame: "training/owner/md-user-menu.png", rect: { x: 829, y: 54, w: 287, h: 127 } },
  mdUserCatalog: { frame: "training/owner/md-user-catalog.png", rect: { x: 249, y: 82, w: 687, h: 657 } },
  mdUserCatalogOff: { frame: "training/owner/md-user-catalog-off.png", rect: { x: 249, y: 82, w: 687, h: 504 } },
  rolesRoleMenu: { frame: "training/owner/ur-role-menu.png", rect: { x: 838, y: 203, w: 266, h: 139 } },
  rolesOwnerCreated: { frame: "training/owner/ur-owner-created.png", rect: { x: 282, y: 722, w: 847, h: 65 } },
  rolesRoleChanged: { frame: "training/owner/ur-role-changed.png", rect: { x: 282, y: 395, w: 847, h: 65 } },
  rolesAccountDeleted: { frame: "training/owner/ur-account-deleted.png", rect: { x: 260, y: 162, w: 891, h: 55 } },
  rolesAdminSignedIn: { frame: "training/owner/ur-admin-signed-in.png", rect: { x: 9, y: 680, w: 207, h: 156 } },
  brandGradientError: { frame: "training/owner/br-gradient-error.png", rect: { x: 282, y: 0, w: 847, h: 311 } },
  brandApplied: { frame: "training/owner/br-applied.png", rect: { x: 0, y: 0, w: 229, h: 855 } },
  brandSignIn: { frame: "training/owner/br-signin.png", rect: { x: 101, y: 107, w: 405, h: 41 } },
  brandAppIcon: { frame: "training/owner/br-app-icon.png", rect: { x: 461, y: 296, w: 263, h: 263 } },
  policySaved: { frame: "training/owner/pc-policy-saved.png", rect: { x: 260, y: 162, w: 891, h: 55 } },
  policyApiAccess: { frame: "training/owner/pc-api-access.png", rect: { x: 777, y: 255, w: 382, h: 222 } },
  budgetUsd: { frame: "training/owner/pc-budget-usd.png", rect: { x: 283, y: 391, w: 845, h: 110 } },
  budgetSaved: { frame: "training/owner/pc-budget-saved.png", rect: { x: 283, y: 391, w: 845, h: 246 } },
  budgetBlocked: { frame: "training/owner/pc-budget-blocked.png", rect: { x: 257, y: 219, w: 897, h: 81 } },
  budgetUnlimited: { frame: "training/owner/pc-budget-unlimited.png", rect: { x: 283, y: 334, w: 845, h: 246 } },
  connWebTested: { frame: "training/owner/cn-web-tested.png", rect: { x: 282, y: 68, w: 847, h: 486 } },
  connWebKeyed: { frame: "training/owner/cn-web-keyed.png", rect: { x: 282, y: 68, w: 847, h: 479 } },
  connDriveForm: { frame: "training/owner/cn-gdrive-form.png", rect: { x: 282, y: 68, w: 847, h: 428 } },
  connDriveTested: { frame: "training/owner/cn-gdrive-tested.png", rect: { x: 296, y: 266, w: 819, h: 130 } },
  connGraphForm: { frame: "training/owner/cn-graph-form.png", rect: { x: 282, y: 68, w: 847, h: 446 } },
  connGraphTested: { frame: "training/owner/cn-graph-tested.png", rect: { x: 296, y: 266, w: 819, h: 200 } },
  connBoxTested: { frame: "training/owner/cn-box-tested.png", rect: { x: 282, y: 68, w: 847, h: 544 } },
  connImanageTested: { frame: "training/owner/cn-imanage-tested.png", rect: { x: 296, y: 306, w: 819, h: 113 } },
  searchRebuilt: { frame: "training/owner/si-rebuilt.png", rect: { x: 261, y: 246, w: 889, h: 308 } },
  searchUserResults: { frame: "training/owner/si-user-results.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  searchUserPrivate: { frame: "training/owner/si-user-private.png", rect: { x: 279, y: 99, w: 627, h: 205 } },
  alertSmtpFilled: { frame: "training/owner/al-smtp-filled.png", rect: { x: 261, y: 234, w: 889, h: 521 } },
  alertTestFailed: { frame: "training/owner/al-test-failed.png", rect: { x: 262, y: 384, w: 887, h: 86 } },
  alertTestSent: { frame: "training/owner/al-test-sent.png", rect: { x: 262, y: 384, w: 887, h: 86 } },
  alertRuleCreated: { frame: "training/owner/al-rule-created.png", rect: { x: 282, y: 386, w: 847, h: 82 } },
  alertUserFlagged: { frame: "training/owner/al-user-flagged.png", rect: { x: 257, y: 93, w: 897, h: 366 } },
  elasticCloudCheck: { frame: "training/owner/el-cloud-id.png", rect: { x: 282, y: 459, w: 847, h: 129 } },
  elasticKeyHelp: { frame: "training/owner/el-key-help.png", rect: { x: 282, y: 247, w: 847, h: 360 } },
  kibanaImport: { frame: "training/owner/kb-import.png", rect: { x: 885, y: 93, w: 300, h: 762 } },
  kibanaImported: { frame: "training/owner/kb-imported.png", rect: { x: 885, y: 93, w: 300, h: 762 } },
  kibanaDiscover: { frame: "training/owner/kb-discover.png", rect: { x: 300, y: 384, w: 885, h: 471 } },
  analyticsOverview: { frame: "training/owner/an-overview.png", rect: { x: 261, y: 234, w: 889, h: 447 } },
  runtimeCsv: { frame: "training/owner/an-runtime-csv.png", rect: { x: 774, y: 67, w: 307, h: 252 } },
  feedbackEvents: { frame: "training/owner/an-feedback.png", rect: { x: 262, y: 408, w: 887, h: 447 } },
  feedbackRecord: { frame: "training/owner/an-feedback-record.png", rect: { x: 179, y: 57, w: 827, h: 741 } },
  auditChartRecords: { frame: "training/owner/au-chart-records.png", rect: { x: 229, y: 17, w: 727, h: 821 } },
  auditAlertAcknowledged: { frame: "training/owner/au-alert-acknowledged.png", rect: { x: 262, y: 317, w: 887, h: 527 } },
  trailExport: { frame: "training/owner/au-trail-export.png", rect: { x: 669, y: 451, w: 307, h: 252 } },
  retentionEntry: { frame: "training/owner/rt-navigation.png", rect: { x: 261, y: 422, w: 889, h: 95 } },
  retentionSchedule: { frame: "training/owner/rt-schedule.png", rect: { x: 282, y: 154, w: 849, h: 221 } },
  retentionSource: { frame: "training/owner/rt-source.png", rect: { x: 282, y: 0, w: 847, h: 855 } },
  retentionPreviewFinite: { frame: "training/owner/rt-preview.png", rect: { x: 282, y: 370, w: 847, h: 174 } },
  retentionForeverSaved: { frame: "training/owner/rt-forever-saved.png", rect: { x: 282, y: 405, w: 847, h: 86 } },
  retentionScan: { frame: "training/owner/rt-scan.png", rect: { x: 282, y: 6, w: 847, h: 192 } },
  retentionConfirmed: { frame: "training/owner/rt-confirmed.png", rect: { x: 282, y: 6, w: 847, h: 409 } },
  retentionHold: { frame: "training/owner/rt-hold.png", rect: { x: 301, y: 321, w: 809, h: 212 } },
  retentionConversation: { frame: "training/owner/rt-conversation.png", rect: { x: 179, y: 132, w: 827, h: 591 } },
  retentionPreviewHeld: { frame: "training/owner/rt-preview-held.png", rect: { x: 282, y: 370, w: 847, h: 116 } },
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
  | "elastic"
  | "retention";

export type OwnerTrainingVideo = TrainingVideoBase & { icon: OwnerGuideIcon };

export const OWNER_TRAINING_VIDEOS: OwnerTrainingVideo[] = [
  {
    id: "owner-first-workspace",
    audioSrc: "training/owner/owner-first-workspace.mp3",
    title: "Set up the first workspace",
    description: "Create the first platform owner on a new installation, connect a model, give one person access, and watch that person get a real reply.",
    icon: "provider",
    track: "Get started",
    outcomes: [
      "The first platform owner exists and is signed in",
      "A provider shows Connected and its model is enabled",
      "A new person signs in, sets a password, and gets a reply from the model",
    ],
    prerequisites: [
      "A new installation that has never been set up. The first visit shows Create the first platform owner.",
      "The owner's email address, display name, and a password of at least 12 characters.",
      "A model to connect: a cloud provider API key (see Providers and connections), or a local OpenAI-compatible server such as Ollama or LM Studio that the server can reach.",
      "The email address of the first person who will use the workspace.",
    ],
    setupSteps: [
      "Open your instance's address. On the Create the first platform owner screen, enter Email, Display name, Create password, and Confirm password, then choose Create platform owner.",
      "On the Getting started card, choose Set up models. The Platform console opens on Providers with Connect your first model provider.",
      "Choose Add Provider. Enter a Name, pick the Kind, enter the Region and Base URL, and give the key a Key name.",
      "Paste the provider key into API key or secret. A local server that ignores keys still needs a placeholder value here, because Sync Models only runs with an active key on file.",
      "Choose Save Provider. Wait for the card to show Connected and the message Runtime test passed with the model's name.",
      "Open Models. New models arrive disabled; turn on the switch in Org status for the model your team should use.",
      "Open Org Settings › Role Boundary. Enter the person's Display name and Email, keep Role on User, and choose Create account.",
      "Choose the key button on the person's row (Set a password). Choose Generate, keep Temporary password on, choose Set password, and copy the password from the confirmation.",
      "Share the workspace address and the temporary password over a safe channel. Nothing is emailed automatically.",
      "Optional check: Admin console › Model Access shows the model as Visible to 1 group, and Edit groups shows Default Users ticked.",
      "In a private window, the person signs in with Email and the temporary password, chooses a new password on Set a new password, and is taken to the workspace.",
      "The person sends a first message. A reply from the connected model proves the account, the group, the model switch, and the provider all work together.",
    ],
    paths: [
      {
        label: "Local OpenAI-compatible server (shown in the video)",
        steps: [
          "Kind: openai-compatible (or ollama for Ollama, local for a generic local runtime).",
          "Base URL: the server address followed by /v1, for example http://localhost:11434/v1 for Ollama or http://localhost:1234/v1 for LM Studio. Use an address the Aperture Chat server can reach, not just your laptop.",
          "API key or secret: any placeholder value when the server does not check keys.",
          "Save Provider syncs the model list and runs a short test chat. Connected appears only when that test passes.",
        ],
      },
      {
        label: "Cloud provider (OpenAI, Anthropic, OpenRouter, Gemini, and others)",
        steps: [
          "Create an API key in the vendor's console first. The Providers and connections lesson shows where for each vendor.",
          "Kind: the vendor. The Base URL, Auth type, and Header fill in for most kinds; keep them unless your vendor says otherwise.",
          "Paste the real key into API key or secret and choose Save Provider. The catalog syncs and a test chat runs.",
          "Azure OpenAI and Azure Foundry cannot list their deployments yet, so they cannot be finished from the console; see the Azure path in Providers and connections.",
        ],
      },
      {
        label: "People sign in with single sign-on instead of passwords",
        steps: [
          "Skip Set a password. Connect your identity provider first (Single sign-on track).",
          "With Provision new users on first sign-in on, people are created as users when they first sign in, and join Default Users.",
          "Share the workspace address; people choose Continue with SSO.",
        ],
      },
    ],
    verify: [
      "The provider card shows Connected and Runtime test passed with the model's name.",
      "Models shows the model as Enabled.",
      "The person's first sign-in asks them to Set a new password, then opens the workspace.",
      "The person's first message gets an answer from the connected model, named in the Model menu at the top of the chat.",
    ],
    troubleshooting: [
      { symptom: "\"A platform owner already exists.\"", fix: "Someone finished setup first. Sign in with that owner account; the setup screen appears only once per installation." },
      { symptom: "\"Password must be at least 12 characters.\" or \"The passwords do not match.\"", fix: "Use a password or passphrase of 12 or more characters and type it the same way in both fields." },
      { symptom: "Sync Models is greyed out and the card says Needs key.", fix: "No active key is on file. Open API Keys on the card, choose Add Key, paste the key (a placeholder for a local server), and choose Save Key." },
      { symptom: "\"Key saved; model sync failed: Provider model sync failed: ConnectError.\"", fix: "The server cannot reach the Base URL. Check the address and port, that the local server is running and listening on the network, and that the URL ends in /v1." },
      { symptom: "\"Key saved; model sync failed: Provider model sync failed with HTTP 401.\"", fix: "The vendor rejected the key. Create a new key in the vendor's console, then use Replace on the key row." },
      { symptom: "The person sees No connected models in the Model menu.", fix: "Turn the model on in Models, and check Admin console › Model Access: the model needs a group the person belongs to, such as Default Users." },
      { symptom: "\"Invalid local credentials.\" when the person signs in.", fix: "Check the email and the temporary password. Set a new temporary password from Role Boundary if it was lost; it is shown only once." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "A new installation, the owner's details, a model to connect, and the first person's email.",
        narration:
          "This lesson sets up a brand new workspace from the very first screen to a working conversation. Before you begin, have four things ready: your instance's address, which has never been set up; the owner's email, display name, and a strong password; a model to connect, either a cloud provider key or a local server such as Ollama or L M Studio; and the email of the first person who will use the workspace.",
        durationSeconds: 26,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "Your instance's address. A new installation opens on Create the first platform owner.",
            "The owner's email, display name, and a password of 12 or more characters.",
            "A model: a cloud provider API key, or a local server address such as http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio).",
            "The first person's work email address.",
          ],
        },
      },
      {
        title: "Create the first platform owner",
        caption: "Email, display name, and a password of at least 12 characters. This screen appears only once.",
        narration:
          "Open your instance's address. A new installation opens on Create the first platform owner. Enter your email and display name, then create and confirm a password of at least twelve characters. Choose Create platform owner. This screen appears only once; afterwards, everyone signs in normally.",
        durationSeconds: 21,
        calloutPlacement: "right-mid",
        captionPlacement: "top",
        focus: "firstOwnerSetup",
      },
      {
        title: "Getting started",
        caption: "The welcome card lists the next steps. Choose Set up models.",
        narration:
          "You are signed in as the platform owner, and the Getting started card lists what comes next: connect your first model, then bring your team in. Choose Set up models.",
        durationSeconds: 12,
        calloutPlacement: "lower-left",
        focus: "firstOwnerWelcome",
      },
      {
        title: "Providers, still empty",
        caption: "Platform console › Providers. Choose Add Provider.",
        narration:
          "The Platform console opens on Providers, with a short checklist: add the connection, validate it and sync its models, then enable models for the right groups. Choose Add Provider.",
        durationSeconds: 13,
        calloutPlacement: "lower-left",
        focus: "firstProvidersEmpty",
      },
      {
        title: "Describe the connection",
        caption: "Name, Kind, Region, Base URL, and a Key name. Here: a local OpenAI-compatible server.",
        narration:
          "Give the provider a name, choose its kind, and enter the base U R L. This walkthrough connects a local model server that speaks the Open A I format, so the kind is open A I compatible and the address ends in slash v 1. Name the key, then paste it into A P I key or secret. A local server that ignores keys still needs a placeholder value, because model sync only runs with an active key on file. Choose Save Provider.",
        durationSeconds: 29,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "firstProviderForm",
      },
      {
        title: "Connected, for real",
        caption: "Saving the key synced the model list and ran a short test chat: Runtime test passed.",
        narration:
          "Saving the key did two real checks. It fetched the model list from the server, and it sent a short test chat to one of those models. The card shows Connected, and the message names the model that answered. If either check fails, the card says so and shows the error instead.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "firstProviderValidated",
      },
      {
        title: "Enable the model",
        caption: "Models: new models arrive disabled. Turn on Org status for the model your team should use.",
        narration:
          "Open Models. Newly synced models arrive disabled, so nobody can use a model you have not reviewed. Turn on the switch under Org status. Because the Default group policy is on, the model is also given to the Default Users group.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "firstModelEnabled",
      },
      {
        title: "Create the first person",
        caption: "Org Settings › Role Boundary: display name, email, role User, then Create account.",
        narration:
          "Now bring in the first person. Open Org Settings and expand Role Boundary. Enter their display name and work email, keep the role on User, and choose Create account. New users join the Default Users group automatically.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "firstAccountCreated",
      },
      {
        title: "Give them a temporary password",
        caption: "Set a password › Generate, keep Temporary password on, then Set password and copy it.",
        narration:
          "Choose the key button on their row. Choose Generate, and keep Temporary password on, so they must choose their own password the first time they sign in. Choose Set password, then copy it from the confirmation. It is shown only once, and nothing is emailed, so share it and the workspace address over a safe channel.",
        durationSeconds: 21,
        calloutPlacement: "left-rail",
        focus: "firstPasswordDialog",
      },
      {
        title: "Check who can use the model",
        caption: "Admin console › Model Access: the model is visible to Default Users, the group new people join.",
        narration:
          "To see why the person will have access, open the Admin console and choose Model Access. The model is visible to one group, and Edit groups shows that it is Default Users, the group every new person joins. Later, you can make your own groups and narrow access per model.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "firstWorkspaceAccess",
      },
      {
        title: "The person signs in",
        caption: "In their own browser: Email and the temporary password, then Sign in.",
        narration:
          "Now switch to the person's own browser. They open the workspace address, enter their email and the temporary password, and choose Sign in.",
        durationSeconds: 10,
        calloutPlacement: "right-mid",
        focus: "firstPersonSignIn",
      },
      {
        title: "Choose their own password",
        caption: "Set a new password replaces the temporary one before the workspace opens.",
        narration:
          "Because the password was temporary, Aperture Chat asks them to set a new password of at least twelve characters. Choose Set password and continue, and the workspace opens.",
        durationSeconds: 12,
        calloutPlacement: "right-mid",
        focus: "firstPersonNewPassword",
      },
      {
        title: "A first real reply",
        caption: "The person asks a question and the connected model answers. Setup is complete.",
        narration:
          "The person asks a first question, and the model you connected answers it. The model's name appears at the top of the chat. This one reply proves that the account, the group, the model switch, and the provider connection all work together. Your first workspace is ready.",
        durationSeconds: 18,
        calloutPlacement: "lower-left",
        focus: "firstWorkspaceReply",
      },
    ],
  },
  {
    id: "provider-setup",
    audioSrc: "training/owner/provider-setup.mp3",
    title: "Providers and connections",
    description: "Connect a model provider of any kind, get its key from the vendor, and read the real result of the connection test.",
    icon: "provider",
    track: "Get started",
    outcomes: [
      "A provider is saved with the right kind, address, and key",
      "The card shows Connected after a real model sync and test chat",
      "Failure messages are recognised and fixed",
    ],
    prerequisites: [
      "A platform owner account.",
      "For a cloud provider: an account with billing or credits at the vendor, and permission to create API keys there.",
      "For a local server (Ollama, LM Studio, or another OpenAI-compatible server): at least one model downloaded, and the server listening on an address the Aperture Chat server can reach.",
      "Azure OpenAI: the resource endpoint, KEY 1, and the deployment name from the Azure portal.",
    ],
    setupSteps: [
      "Choose Platform console at the bottom of the sidebar, then open Providers.",
      "Choose Add Provider. Enter a Name people will recognise, such as OpenAI production.",
      "Choose the Kind. For most kinds, Base URL, Auth type, and Header fill in automatically; keep them unless your vendor tells you otherwise.",
      "Enter the Region if you track it, then a Key name, the Environment, and Expires (the date the vendor key stops working, or Not set).",
      "Paste the key into API key or secret. It goes straight to the encrypted vault and is never shown on the card.",
      "Choose Save Provider. Aperture Chat saves the connection, stores the key, syncs the model list, and sends one short test chat.",
      "Read the card: Connected with Runtime test passed means the provider works. Needs key, Needs validation, or an error message means it does not yet; see Troubleshooting.",
      "Open Models and turn on the models your team should use. Newly synced models always arrive disabled.",
    ],
    paths: [
      {
        label: "Local server: Ollama, LM Studio, or OpenAI-compatible (shown end to end)",
        steps: [
          "On the model machine, download a model (Ollama: ollama pull, then a model name) and make the server listen on the network (Ollama: OLLAMA_HOST=0.0.0.0:11434; LM Studio: Developer › Start server and Serve on Local Network).",
          "Kind: ollama for Ollama (Base URL fills in as http://localhost:11434/v1), or openai-compatible for LM Studio and other servers.",
          "Base URL: the server's address the Aperture Chat server can reach, ending in /v1. LM Studio's default port is 1234.",
          "API key or secret: any placeholder if the server does not check keys. Sync needs an active key on file.",
          "Save Provider, and wait for Connected and Runtime test passed.",
        ],
      },
      {
        label: "OpenAI",
        steps: [
          "At platform.openai.com, open Settings › API keys and choose Create new secret key. Pick the Project and Permissions, create it, and copy it; it is shown once.",
          "Kind: openai. Base URL https://api.openai.com/v1, Auth type bearer, Header Authorization fill in.",
          "Paste the key and choose Save Provider.",
        ],
      },
      {
        label: "Anthropic",
        steps: [
          "At platform.claude.com, open Settings › API keys, choose Create key, set the expiration and Linked account, and copy the key (sk-ant-…).",
          "Kind: anthropic. Base URL https://api.anthropic.com, Auth type api-key, Header x-api-key fill in.",
          "Paste the key and choose Save Provider.",
        ],
      },
      {
        label: "Azure OpenAI",
        steps: [
          "Azure portal › your resource › Resource Management › Keys and Endpoint: copy KEY 1 and the Endpoint. In Foundry, copy the deployment name.",
          "Kind: azure-openai. Base URL: https://your-resource.openai.azure.com/openai. Auth type api-key and Header api-key fill in.",
          "API version: 2024-10-21. Deployment: your deployment name.",
          "Save Provider. The card stays on Needs validation with … does not expose a supported model discovery API yet: Azure deployments are not listed automatically, and the console has no control to add one by hand yet. Use another provider kind for live chat until this is supported.",
        ],
      },
      {
        label: "OpenRouter",
        steps: [
          "At openrouter.ai, add credits, open Keys, create a key with an optional credit limit, and copy it.",
          "Kind: openrouter. Base URL https://openrouter.ai/api/v1 fills in.",
          "Catalog scope: ZDR models syncs only zero-data-retention endpoints; Key-scoped models syncs what your key and OpenRouter privacy settings allow.",
          "Paste the key and choose Save Provider.",
        ],
      },
      {
        label: "Google Gemini",
        steps: [
          "In Google AI Studio, open API Keys, choose Create API key, pick the billing project, restrict it to the Gemini API, and copy it.",
          "Kind: gcp. Base URL https://generativelanguage.googleapis.com/v1beta/openai fills in.",
          "Paste the key and choose Save Provider.",
        ],
      },
      {
        label: "Other OpenAI-compatible vendors",
        steps: [
          "Kinds xai, mistral, deepseek, groq, together, fireworks, perplexity, cerebras, sambanova, moonshot, nvidia, deepinfra, cohere, and open-webui fill in the vendor's address and a bearer header.",
          "Create a key in the vendor's console, paste it, and choose Save Provider.",
        ],
      },
      {
        label: "Amazon Bedrock and Azure Foundry",
        steps: [
          "The connection can be saved, but chat cannot route to it yet. The card stays on Needs validation with does not expose a supported model discovery API yet.",
          "Use another provider kind for live chat.",
        ],
      },
    ],
    verify: [
      "The card shows Connected, and its message ends with Runtime test passed and the name of the model that answered.",
      "The card's Models line counts the synced models (for example 0 of 1 before you enable any).",
      "Platform console › Audit records platform.provider_models_synced for the provider.",
    ],
    troubleshooting: [
      { symptom: "\"Provider model sync failed: ConnectError.\"", fix: "Nothing answered at the Base URL. Check the host and port, that the server is running, and that it listens on the network rather than only on its own machine." },
      { symptom: "\"Provider model sync did not return a model list.\" for Ollama", fix: "Ollama is running but has no model. Pull one on the model machine (ollama pull, then a model name), then choose Sync Models." },
      { symptom: "\"Provider model sync failed with HTTP 401.\" and the card says Needs key", fix: "The vendor rejected the key, and Aperture Chat marked it Inactive. Create a new key in the vendor's console and add it with API Keys › Add Key, or Replace." },
      { symptom: "\"… rejected its provider key with HTTP 401. Paste a valid provider-generated key, make sure billing or credits are available, then sync models again.\"", fix: "The model list loaded, but the test chat was refused. Check billing or credits and the key's permissions at the vendor." },
      { symptom: "\"… model sync succeeded, but live chat validation failed …\"", fix: "The vendor listed models but could not answer a chat. Check model access for the key, the region, and the Base URL." },
      { symptom: "\"… does not expose a supported model discovery API yet.\"", fix: "Azure OpenAI, Azure Foundry, and Amazon Bedrock cannot sync a model list. Use a different provider kind for live chat." },
      { symptom: "Sync Models is greyed out.", fix: "There is no active key. Add one with API Keys › Add Key." },
      { symptom: "Delete provider stays greyed out, or \"… still has models in use by …\"", fix: "Type the provider's name exactly to enable Delete provider. If automations or agent profiles use its models, repoint or remove them first." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "Billing at the vendor and permission to create keys, or a local server with a model.",
        narration:
          "This lesson connects a model provider and proves that it works. It shows a local server end to end, then the form for each major cloud vendor, and the real messages you see when something is wrong. Before you begin, have either a vendor account with billing and permission to create A P I keys, or a local server with at least one model downloaded.",
        durationSeconds: 23,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "A platform owner account.",
            "Cloud: a vendor account with billing or credits, and permission to create API keys.",
            "Local: Ollama, LM Studio, or another OpenAI-compatible server with a model downloaded.",
            "Azure: the resource endpoint, KEY 1, and the deployment name.",
          ],
        },
      },
      {
        title: "The Providers tab",
        caption: "Platform console › Providers. Each card shows its status: Connected, Needs key, or Needs validation.",
        narration:
          "Choose Platform console, then open Providers. Each card is one connection, with its kind, region, model count, and status. Connected means a real test chat passed. Needs key means no working key is on file. Needs validation means a key is saved but the last check did not pass.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "pvOverview",
      },
      {
        title: "Choose the kind",
        caption: "Add Provider › Kind lists every supported vendor, plus ollama, openai-compatible, and local.",
        narration:
          "Choose Add Provider, then open Kind. It lists every vendor Aperture Chat knows: Open A I, Anthropic, Azure, Google, Amazon Bedrock, many Open A I compatible clouds, and three choices for servers you run yourself. Picking a kind fills in its address and sign-in header.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        focus: "pvKindMenu",
      },
      {
        title: "Prepare a local server",
        caption: "Download a model and make the server listen on the network, then note its /v1 address.",
        narration:
          "For a local server, do two things on the model machine first. Download at least one model, and make the server listen on the network, so the Aperture Chat server can reach it. Ollama answers on port eleven four three four, and L M Studio on port twelve thirty four, both under slash v 1.",
        durationSeconds: 20,
        card: {
          where: "The machine that runs the model",
          steps: [
            "Ollama: download a model, for example ollama pull llama3.2.",
            "Ollama: set OLLAMA_HOST=0.0.0.0:11434 and restart Ollama.",
            "LM Studio: Developer tab › Start server, then turn on Serve on Local Network.",
            "Confirm the address answers from the Aperture Chat server: it must list models at /v1/models.",
          ],
          values: [
            { label: "Ollama", value: "http://your-host:11434/v1" },
            { label: "LM Studio", value: "http://your-host:1234/v1" },
          ],
        },
      },
      {
        title: "Fill in a local connection",
        caption: "Kind openai-compatible, the server's /v1 address, a key name, and a placeholder key.",
        narration:
          "Name the provider, choose open A I compatible, and enter the server's address ending in slash v 1. Give the key a name. This server does not check keys, but model sync only runs with an active key on file, so paste any placeholder into A P I key or secret. Then choose Save Provider.",
        durationSeconds: 21,
        calloutPlacement: "left-rail",
        focus: "pvLocalForm",
      },
      {
        title: "Connected, after a real test",
        caption: "Save synced the model list and sent a test chat. Runtime test passed names the model that answered.",
        narration:
          "Saving did two real checks: it fetched the model list, then sent a short test chat. The card shows Connected, and Runtime test passed names the model that answered. The Models line reads zero of one, because new models arrive disabled until you turn them on.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "pvLocalConnected",
      },
      {
        title: "When nothing answers",
        caption: "Wrong port: \"Provider model sync failed: ConnectError.\" and Needs validation.",
        narration:
          "Here is the same server with the wrong port. Nothing answered, so the card says Needs validation and the message reads Provider model sync failed, Connect Error. Check the host, the port, and that the server listens on the network.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "pvLocalUnreachable",
      },
      {
        title: "Ollama with no model",
        caption: "Ollama answers but has nothing to offer: \"Provider model sync did not return a model list.\"",
        narration:
          "This Ollama server is running, but no model has been pulled yet. The sync gets an empty answer, so the card reads Provider model sync did not return a model list. Pull a model on that machine, then choose Sync Models.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "pvOllamaEmpty",
      },
      {
        title: "Get an OpenAI key",
        caption: "OpenAI Platform › Settings › API keys › Create new secret key. Copy it; it is shown once.",
        narration:
          "For Open A I, sign in to the Open A I platform and open Settings, then A P I keys. Choose Create new secret key, pick the project and permissions, and copy the key right away; it is shown only once. The organization also needs billing or credits.",
        durationSeconds: 19,
        card: {
          where: "OpenAI Platform (platform.openai.com)",
          steps: [
            "Sign in and open Settings › API keys.",
            "Choose Create new secret key.",
            "Enter a name, choose the Project, and set Permissions.",
            "Create the key and copy it now; it is shown only once.",
            "Make sure the organization has billing or prepaid credits.",
          ],
          values: [
            { label: "Base URL", value: "https://api.openai.com/v1" },
            { label: "Header", value: "Authorization: Bearer <key>" },
          ],
        },
      },
      {
        title: "The OpenAI connection",
        caption: "Kind openai fills in the address, bearer auth, and the Authorization header.",
        narration:
          "Choose the kind open A I. The base U R L, bearer auth, and Authorization header fill in for you. Name the key, add the date it expires if your vendor set one, paste the key, and choose Save Provider.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "pvOpenaiForm",
      },
      {
        title: "What a rejected key looks like",
        caption: "An invalid key: \"Provider model sync failed with HTTP 401.\" The key is marked Inactive and the card says Needs key.",
        narration:
          "This connection was saved with a deliberately invalid key, so you can see Open A I's real answer. The sync failed with H T T P four oh one, Aperture Chat marked the key inactive, and the card says Needs key. Create a new key at the vendor and add it to this card.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "pvOpenaiRejected",
      },
      {
        title: "Get an Anthropic key",
        caption: "Claude Console › Settings › API keys › Create key. Copy the sk-ant- key once.",
        narration:
          "For Anthropic, open the Claude Console, then Settings and A P I keys. Choose Create key, set an expiration and the linked account, and copy the key. It starts with s k dash ant, and it is shown only once.",
        durationSeconds: 15,
        card: {
          where: "Claude Console (platform.claude.com)",
          steps: [
            "Open Settings › API keys and choose Create key.",
            "Name the key, choose an expiration and the Linked account.",
            "Pick a workspace if your organization uses them.",
            "Copy the key (it starts with sk-ant-); it is shown only once.",
            "Check Settings › Billing for available credits.",
          ],
          values: [
            { label: "Base URL", value: "https://api.anthropic.com" },
            { label: "Header", value: "x-api-key: <key>" },
          ],
        },
      },
      {
        title: "The Anthropic connection",
        caption: "Kind anthropic: api-key auth with the x-api-key header.",
        narration:
          "Choose the kind anthropic. Anthropic uses its own header, x A P I key, which fills in automatically. Paste the key and choose Save Provider.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "pvAnthropicForm",
      },
      {
        title: "Gather the Azure values",
        caption: "Azure portal › Keys and Endpoint for KEY 1 and the endpoint; Foundry for the deployment name.",
        narration:
          "Azure Open A I needs three values. In the Azure portal, open your resource, then Keys and Endpoint, and copy KEY 1 and the endpoint. In Foundry, copy the deployment name you chose, which is not always the model's name.",
        durationSeconds: 16,
        card: {
          where: "Azure portal and Microsoft Foundry",
          steps: [
            "Open your Azure OpenAI resource in the Azure portal.",
            "Resource Management › Keys and Endpoint: copy KEY 1 and the Endpoint.",
            "In the Foundry portal, open Deployments and copy your deployment name.",
            "Use the dated GA API version 2024-10-21.",
          ],
          values: [
            { label: "Base URL", value: "https://your-resource.openai.azure.com/openai" },
            { label: "Header", value: "api-key: <KEY 1>" },
          ],
        },
      },
      {
        title: "The Azure OpenAI connection",
        caption: "Kind azure-openai: your resource address, API version, and Deployment.",
        narration:
          "Choose the kind azure open A I. Replace the resource in the base U R L with yours, enter the A P I version and the deployment name, and paste KEY 1.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "pvAzureForm",
      },
      {
        title: "Azure's current limit",
        caption: "Saved, but Needs validation: Azure OpenAI does not expose a supported model discovery API yet.",
        narration:
          "Be aware of a current limit. Aperture Chat stores the Azure connection, but it cannot list Azure deployments yet, so the card stays on Needs validation and says the provider does not expose a supported model discovery A P I yet. The deployment does not appear in Models on its own.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "pvAzureSaved",
      },
      {
        title: "Get an OpenRouter key",
        caption: "openrouter.ai › Keys: create a key with an optional credit limit. Privacy settings control zero data retention.",
        narration:
          "For OpenRouter, add credits, open Keys, and create a key, with a credit limit if you want one. Copy it once. In the privacy settings, you can require zero data retention for each group of models.",
        durationSeconds: 14,
        card: {
          where: "OpenRouter (openrouter.ai)",
          steps: [
            "Add credits to the account.",
            "Open Keys and create a key; set a credit limit if you want one.",
            "Copy the key; it is shown only once.",
            "Optional: Settings › Privacy, turn on zero data retention for the model groups you need.",
          ],
          values: [{ label: "Base URL", value: "https://openrouter.ai/api/v1" }],
        },
      },
      {
        title: "The OpenRouter connection",
        caption: "Catalog scope: ZDR models, or Key-scoped models that follow your OpenRouter settings.",
        narration:
          "Choose the kind openrouter. OpenRouter adds one more field, Catalog scope. Z D R models syncs only endpoints with zero data retention. Key scoped models syncs whatever your key and your OpenRouter privacy settings allow.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "pvOpenrouterForm",
      },
      {
        title: "Get a Gemini key",
        caption: "Google AI Studio › API Keys › Create API key, restricted to the Gemini API.",
        narration:
          "For Google Gemini, open Google A I Studio, then A P I Keys, and choose Create A P I key. Pick the Google Cloud project it bills to, restrict it to the Gemini A P I, and copy it.",
        durationSeconds: 14,
        card: {
          where: "Google AI Studio (aistudio.google.com)",
          steps: [
            "Open API Keys and choose Create API key.",
            "Pick the Google Cloud project the key bills to.",
            "Restrict the key to the Gemini API.",
            "Copy the key.",
          ],
          values: [{ label: "Base URL", value: "https://generativelanguage.googleapis.com/v1beta/openai" }],
        },
      },
      {
        title: "The Gemini connection",
        caption: "Kind gcp uses Google's OpenAI-compatible Gemini endpoint with a bearer key.",
        narration:
          "Choose the kind G C P. It points at Google's Open A I compatible Gemini endpoint, with the key sent as a bearer token. Paste the key and choose Save Provider.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "pvGeminiForm",
      },
      {
        title: "Amazon Bedrock is not routable yet",
        caption: "Bedrock can be saved, but chat cannot use it: the card stays on Needs validation.",
        narration:
          "Amazon Bedrock is listed, and its details can be saved, but chat cannot route to it yet. After saving, the card stays on Needs validation with the same discovery message. Use another provider kind for live chat.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "pvBedrockSaved",
      },
      {
        title: "Edit a connection",
        caption: "Edit Connection opens the same fields in place. Save Connection, then Sync Models.",
        narration:
          "To change an address or header later, choose Edit Connection on the card. The same fields open in place. Choose Save Connection, then Sync Models to test the change. Use A P I Keys to add or replace the key itself.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "pvEditConnection",
      },
      {
        title: "Delete a provider",
        caption: "Delete › type the provider's name › Delete provider. Its models and keys go with it.",
        narration:
          "To remove a provider, choose Delete and type its name exactly. The dialog tells you how many models and keys go with it. If automations or agent profiles still use its models, the delete is refused and the message names them, so repoint those first.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "pvDeleteDialog",
      },
    ],
  },
  {
    id: "api-key-vault",
    audioSrc: "training/owner/api-key-vault.mp3",
    title: "API Key Vault and replacement",
    description: "Add, reveal, replace, and delete a provider's keys, and handle a key that has expired.",
    icon: "rotation",
    track: "Get started",
    outcomes: [
      "A new key is vaulted and tested",
      "An old key is replaced without interrupting chat",
      "Expired keys are recognised and retired",
    ],
    prerequisites: [
      "A platform owner account.",
      "A provider already added in Platform console › Providers.",
      "A new key created in the vendor's console (see Providers and connections for where).",
    ],
    setupSteps: [
      "Open Platform console › Providers and choose API Keys on the provider's card. The number on the button is how many keys are stored.",
      "Read the API Key Vault table: Key Name with the masked value (first three and last four characters), Environment, Status, Last Rotated, and Expires.",
      "To add a key, choose Add Key. Enter a Key name, the Environment, and Expires (the date the vendor key stops working, or Not set).",
      "Paste the key into API key or secret and choose Save Key. Aperture Chat stores it encrypted, then syncs the models and sends a test chat with it.",
      "To see a stored key, choose the eye button (Reveal). The full value opens in a dialog with Copy key. Every reveal is recorded in the audit trail as platform.provider_key_revealed.",
      "To replace a key, create the new key at the vendor, then choose the key button (Replace) on the old row. The form opens named after the old key; paste the new key and choose Save Key.",
      "When the new key shows Active and the card still says Connected, choose the bin button (Delete) on the old row. Then revoke the old key at the vendor.",
    ],
    paths: [
      {
        label: "Rotate a key on a schedule",
        steps: [
          "Create the new key at the vendor first.",
          "Replace on the old row › paste the new key › Save Key.",
          "Confirm the new row is Active and the card is Connected.",
          "Delete the old row, then revoke the old key at the vendor.",
        ],
      },
      {
        label: "A key has expired",
        steps: [
          "When the Expires date has passed, the row shows Expired in red and Reveal is greyed out.",
          "Create a new key at the vendor, add it with Replace or Add Key, then delete the expired row.",
        ],
      },
      {
        label: "The vendor rejected a key",
        steps: [
          "After a failed sync with HTTP 401 or 403, the key is marked Inactive and the card says Needs key.",
          "Add a valid key; a successful sync makes the provider Connected again.",
        ],
      },
    ],
    verify: [
      "The new row shows Active, and the card shows Connected with Runtime test passed.",
      "The deleted key no longer appears, and the API Keys count on the card went down by one.",
      "Platform console › Audit lists platform.provider_key_created and, for a reveal, platform.provider_key_revealed.",
    ],
    troubleshooting: [
      { symptom: "Save Key stays greyed out.", fix: "Paste the key into API key or secret; a key value is required." },
      { symptom: "Reveal is greyed out and the row says Expired.", fix: "Expired keys cannot be revealed or used. Add a replacement and delete the expired row." },
      { symptom: "\"Provider key is expired. Add a replacement key before revealing or using it.\"", fix: "The key's Expires date has passed. Add a new key." },
      { symptom: "\"… key was saved, but model sync failed: …\"", fix: "The key is stored, but the provider did not accept it or could not be reached. Read the rest of the message and see Providers and connections › Troubleshooting." },
      { symptom: "Copy key says Clipboard access is unavailable.", fix: "Select the key text in the dialog and copy it manually." },
    ],
    scenes: [
      {
        title: "Open the vault",
        caption: "Providers › API Keys on a card opens that provider's API Key Vault.",
        narration:
          "Each provider keeps its own keys. Open Platform console, then Providers, and choose A P I Keys on the card. The vault shows each key's name with a masked value, only the first three and last four characters, plus its environment, status, last rotation, and expiry date.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "kvVaultOpen",
      },
      {
        title: "Add a key",
        caption: "Add Key: Key name, Environment, Expires, then paste the key and choose Save Key.",
        narration:
          "Choose Add Key. Give it a name you will recognise later, the environment, and the date it expires, if the vendor set one. Paste the key into A P I key or secret, and choose Save Key.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "kvAddForm",
      },
      {
        title: "Stored, then tested",
        caption: "The new key is Active. Saving it also synced the models and ran a test chat.",
        narration:
          "The key is stored encrypted on the server and listed as Active. Saving it also synced the models and ran a test chat with it, so you know straight away whether the vendor accepts it.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "kvKeyAdded",
      },
      {
        title: "Reveal a key",
        caption: "The eye button shows the full value with Copy key. Every reveal is audited.",
        narration:
          "When you need the value itself, choose the eye button on its row. The full key opens in a dialog with Copy key. This one is a placeholder for a local server. Every reveal is written to the audit trail with your name, so reveal keys only when you must.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "kvReveal",
      },
      {
        title: "Replace an old key",
        caption: "Replace opens Add Key named for the old key. Paste the new vendor key and choose Save Key.",
        narration:
          "To rotate a key, first create the new one at the vendor. Then choose the key button on the old row, which is Replace. The form opens named after the old key. Paste the new key and choose Save Key; it is synced and tested like any new key.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "kvReplaceForm",
      },
      {
        title: "Delete the old key",
        caption: "Once the replacement is Active, the bin button deletes the old row. Then revoke it at the vendor.",
        narration:
          "Once the replacement is Active and the card still says Connected, choose the bin button on the old row to delete it from the vault. Finish by revoking the old key in the vendor's console, so it cannot be used anywhere else.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "kvOldDeleted",
      },
      {
        title: "When a key expires",
        caption: "Past its Expires date, a key shows Expired and Reveal is greyed out. Replace it.",
        narration:
          "Keys can also run out. When the Expires date passes, the status turns to Expired in red and Reveal is greyed out, because an expired key cannot be revealed or used. Add a replacement, then delete the expired row.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "kvExpired",
      },
    ],
  },
  {
    id: "model-availability",
    audioSrc: "training/owner/model-availability.mp3",
    title: "Organization model availability",
    description: "Decide which synced models your organization can use, give them clear names, and control what people see when a model is not available to them.",
    icon: "model",
    track: "Get started",
    outcomes: [
      "Models are enabled or disabled for the whole organization",
      "Models have clear display names and notes",
      "The catalog browsing policy matches how open you want access to be",
    ],
    prerequisites: [
      "A platform owner account.",
      "At least one provider connected, so models have been synced.",
      "For the user check: a person who can sign in, or a second browser signed in as one.",
    ],
    setupSteps: [
      "Open Platform console › Models. The All, Enabled, and Disabled counters and Search models work on the whole catalog.",
      "Narrow the list with the funnel beside Provider, Model, or Runtime route. Tick values, or type text for Runtime route; Clear filter removes it.",
      "Turn a model on or off with its Org status switch. Off removes it for everyone, whatever their groups; newly synced models start off.",
      "Choose Edit details to set a Display name people will recognise, the Context window, Notes, and optional System prompt and Meta prompt, then choose Save details.",
      "Group access is set by administrators in Admin console › Model Access. With the Default group policy on, enabling a model also gives it to Default Users.",
      "Decide on catalog browsing in Org Settings › Policy Controls › Users can browse the model catalog.",
      "Check as a user: the Model menu lists only models they can use, and Why isn't a model listed? explains the rest.",
    ],
    paths: [
      {
        label: "Open catalog (Users can browse the model catalog on)",
        steps: [
          "People see every enabled model in Why isn't a model listed?, with the reason it is or is not available.",
          "Locked models offer Request access, which reaches administrators in Admin console › Model Access › Access requests.",
          "Provider offline means the person already has access, but the provider needs reconnecting.",
        ],
      },
      {
        label: "Closed catalog (Users can browse the model catalog off)",
        steps: [
          "People see only models they can already use, with the note: Your organization shows only the models you can already use. Ask an administrator about others.",
          "New access requests are refused: Model access requests are disabled by organization policy.",
        ],
      },
    ],
    verify: [
      "The Enabled and Disabled counters change, and the confirmation reads … availability saved through the platform API.",
      "A disabled model no longer appears in a user's Model menu.",
      "The renamed model shows its new Display name in the user's Model menu.",
      "With browsing off, the user's catalog shows the closed-catalog note.",
    ],
    troubleshooting: [
      { symptom: "\"No models match the current column filters.\"", fix: "A column filter is still active (the funnel shows a number). Open it and choose Clear filter." },
      { symptom: "A user cannot see an enabled model.", fix: "The model needs a group the person belongs to. Check Admin console › Model Access › Edit groups, and the person's groups in Admin console › Users." },
      { symptom: "The user sees Provider offline.", fix: "They have access, but the provider is not connected. Fix the provider in Providers, then choose Sync Models." },
      { symptom: "\"Model access requests are disabled by organization policy.\"", fix: "Users can browse the model catalog is off. Turn it on, or have an administrator add the person to a group." },
    ],
    scenes: [
      {
        title: "The model catalog",
        caption: "Platform console › Models: All, Enabled, and Disabled counters, plus Search models.",
        narration:
          "Open Platform console, then Models. Every model synced from your providers is listed here. The All, Enabled, and Disabled counters filter the list, and Search models finds a model by name.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "mdOverview",
      },
      {
        title: "Filter by column",
        caption: "The funnel beside Provider, Model, or Runtime route narrows the list. Clear filter removes it.",
        narration:
          "Each column has a funnel. Here, the provider filter shows only OpenRouter models. Tick more values to widen it, and choose Clear filter to show everything again.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "mdFilter",
      },
      {
        title: "Give a model a clear name",
        caption: "Edit details: Display name, Context window, Notes, and optional prompts. Then Save details.",
        narration:
          "Synced models keep the vendor's technical name. Choose Edit details to give one a display name people will recognise, add notes about where it runs, and set an optional system prompt. Choose Save details. The new name appears in everyone's Model menu.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "mdDetails",
      },
      {
        title: "Turn a model off for everyone",
        caption: "Org status off removes the model for the whole organization, whatever the groups say.",
        narration:
          "The Org status switch is the organization's ceiling. Turning it off removes the model for everyone, whatever their groups allow, and the Disabled counter goes up. Newly synced models always start off, so nothing reaches people until you have reviewed it.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "mdDisabled",
      },
      {
        title: "What a person sees",
        caption: "The user's Model menu lists only models they can use, under their new display names.",
        narration:
          "Now the same organization from a user's side. The Model menu lists only the models this person can use, with the display name you set. At the bottom, Why isn't a model listed? explains the rest.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "mdUserMenu",
      },
      {
        title: "Why a model is not listed",
        caption: "With browsing on, people see each model's reason: Provider offline, or Locked with Request access.",
        narration:
          "Because catalog browsing is on, the person sees every enabled model and the reason for each one. Provider offline means they already have access but the provider needs reconnecting. Locked means no group grants it, and Request access sends a request to the administrators.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "mdUserCatalog",
      },
      {
        title: "Close the catalog",
        caption: "Org Settings › Policy Controls › Users can browse the model catalog, turned off.",
        narration:
          "To keep the catalog private, open Org Settings, then Policy Controls, and turn off Users can browse the model catalog. The description changes to say what people will now see.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "modelBrowsingPolicy",
      },
      {
        title: "The closed catalog",
        caption: "People now see only models they can already use, and new access requests are refused.",
        narration:
          "The person's view now says your organization shows only the models you can already use. Locked models are hidden, and new access requests are refused. Neither setting grants access by itself; groups still decide who can use each model.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "mdUserCatalogOff",
      },
    ],
  },
  {
    id: "users-roles",
    audioSrc: "training/owner/users-roles.mp3",
    title: "Users and role boundaries",
    description: "Create user, admin, and platform owner accounts, issue temporary passwords, change or remove roles, and know the limits that keep the platform safe.",
    icon: "users",
    track: "People and access",
    outcomes: [
      "Accounts are created at the right role",
      "A temporary password is issued and replaced at first sign-in",
      "Role changes and removals respect the safety floors",
    ],
    prerequisites: [
      "A platform owner account.",
      "Each person's display name and work email.",
      "A safe channel (not the same email thread) for sharing temporary passwords.",
    ],
    setupSteps: [
      "Open Platform console › Org Settings and expand Role Boundary.",
      "Enter the person's Display name and Email, choose the Role (User, Admin, or Platform owner), and choose Create account.",
      "On the new row, choose the key button (Set a password). Choose Generate, keep Temporary password on, and choose Set password.",
      "Copy the password from the confirmation; it is shown only once. Share it and the workspace address over a safe channel. Nothing is emailed.",
      "To change a role, choose a new value in the row's role menu; it saves immediately.",
      "To remove an account, choose the bin button and confirm. Users and admins are deleted permanently; owners are deactivated instead.",
      "Verify: the person signs in, chooses a new password on Set a new password, and sees the consoles their role allows.",
    ],
    paths: [
      {
        label: "User",
        steps: [
          "Uses chat, drafts, agents, and the library. Joins Default Users when the Default group policy is on.",
          "No console access.",
        ],
      },
      {
        label: "Admin",
        steps: [
          "Everything a user can do, plus the Admin console: users, groups, model access, SSO mappings, analytics, policies, audit, and alerts for the organization.",
          "No Platform console: providers, keys, branding, and platform policies stay with owners.",
        ],
      },
      {
        label: "Platform owner",
        steps: [
          "Everything, including the Platform console. Only an owner can create or promote another owner.",
          "Owners sign in with their own local password; Set a password is unavailable on an owner who already has one.",
          "Keep at least two owners, so one can recover the other.",
        ],
      },
      {
        label: "SSO accounts",
        steps: [
          "With single sign-on, people are created at their first sign-in as users. Skip Set a password; change their role here afterwards if needed.",
        ],
      },
    ],
    verify: [
      "The confirmation reads … account created through the admin API, and the row shows the chosen role.",
      "At first sign-in the person sees Set a new password, then the workspace.",
      "A new admin sees Admin console in the sidebar but not Platform console.",
      "Platform console › Audit records each account creation, role change, password reset, and deletion.",
    ],
    troubleshooting: [
      { symptom: "\"… account was not created. User already exists.\"", fix: "That email already has an account. Find the row in the list and change its role or password instead." },
      { symptom: "The owner's role menu and bin button are greyed out.", fix: "At least one active platform owner must remain. Create a second owner first." },
      { symptom: "The bin button is greyed out on your own row.", fix: "Accounts cannot remove themselves. Ask another owner." },
      { symptom: "The key button is greyed out on an owner's row.", fix: "That owner already has a local password and changes it from their own account panel." },
      { symptom: "The person sees \"Invalid local credentials.\"", fix: "Check the email and the temporary password. Issue a new temporary password if it was lost; it cannot be shown again." },
      { symptom: "Removing an owner deactivates them instead of deleting.", fix: "This is by design: owner accounts are never deleted. Another owner can reactivate them." },
    ],
    scenes: [
      {
        title: "Role Boundary",
        caption: "Org Settings › Role Boundary: a create form above every account and its role.",
        narration:
          "Open Platform console, then Org Settings, and expand Role Boundary. The form at the top creates accounts, and every account below has a role menu, a key button for passwords, and a bin button. Your own row is greyed out: accounts cannot remove themselves, and at least one active platform owner must always remain.",
        durationSeconds: 22,
        calloutPlacement: "left-rail",
        focus: "rolesDisclosure",
      },
      {
        title: "Three roles",
        caption: "User, Admin, or Platform owner. Only owners can create or promote owners.",
        narration:
          "Role offers three levels. A user works in chat, drafts, agents, and the library. An admin also runs the Admin console for the organization. A platform owner also controls providers, keys, branding, and platform policy. Only an owner can create another owner.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        focus: "rolesRoleMenu",
      },
      {
        title: "Create an admin",
        caption: "Display name, Email, Role Admin, then Create account. The new row appears in the list.",
        narration:
          "Enter the person's display name and work email, choose Admin, and choose Create account. The account is saved straight away and appears in the list with its role.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "rolesCreateForm",
      },
      {
        title: "Issue a temporary password",
        caption: "Key button › Generate › keep Temporary password on › Set password. Copy it; it is shown once.",
        narration:
          "Choose the key button on the new row. Choose Generate for a strong password, keep Temporary password on, and choose Set password. Copy the password from the confirmation, because it is shown only once, and share it with the workspace address over a safe channel. Nothing is emailed.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "rolesSetPassword",
      },
      {
        title: "Add a second owner",
        caption: "Create a second Platform owner, so one owner can always recover the other.",
        narration:
          "Create a second platform owner the same way. With two owners, either one can be changed or deactivated, and one can always recover the other if a password or authenticator is lost.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "rolesOwnerCreated",
      },
      {
        title: "Change a role",
        caption: "Pick a new role in the row's menu. It saves immediately.",
        narration:
          "To change someone's role, pick the new value in their row. It saves immediately and is recorded in the audit trail. Here, Casey becomes an admin.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "rolesRoleChanged",
      },
      {
        title: "Remove an account",
        caption: "The bin button asks for confirmation, then deletes the account permanently.",
        narration:
          "To remove an account, choose its bin button and confirm. Users and admins are deleted permanently, with their sessions and history. Owners are never deleted; they are deactivated, so another owner can restore them. Accounts cannot remove themselves.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "rolesAccountDeleted",
      },
      {
        title: "Check what the admin sees",
        caption: "The new admin replaced the temporary password and sees Admin console, but not Platform console.",
        narration:
          "Finally, the new admin signs in with the temporary password and chooses their own. They land in the workspace with Admin console in the sidebar, and no Platform console. That boundary is the point of roles.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        focus: "rolesAdminSignedIn",
      },
    ],
  },
  {
    id: "sso-setup",
    audioSrc: "training/owner/sso-setup.mp3",
    title: "Single sign-on, start to finish",
    description: "Register the app with an OpenID Connect provider, connect it, test it, and sign the first person in. Shown end to end with Keycloak.",
    icon: "identity",
    track: "Single sign-on",
    outcomes: ["App registered at the identity provider", "Connection tested", "First person signed in"],
    prerequisites: [
      "A platform owner account that signs in with a local password on a domain you will not enforce. It is your way back in if the identity provider is unavailable.",
      "Administrator access to your identity provider: Microsoft Entra ID, Okta, Google Workspace, Keycloak, or another OpenID Connect provider.",
      "The email domains your people sign in with, such as examplecorp.com.",
      "A test account at the identity provider with a verified email on one of those domains.",
      "Your instance's public address. The redirect URI is that address followed by /api/auth/sso/callback, and the server's APERTURE_API_BASE_URL must be the same address.",
    ],
    setupSteps: [
      "Open Platform console › Org Settings, expand Single Sign-On, and choose Copy beside the redirect URI.",
      "At your identity provider, create a confidential web application that uses OpenID Connect and the authorization code flow. Paste the redirect URI exactly: scheme, host, port, and path must match.",
      "Copy the application's client ID and client secret, and note when the secret expires.",
      "Make sure the ID token carries the person's email (the email scope). If you will map groups, add a groups claim to the ID token.",
      "Assign your test account, and later the groups that should use the workspace, to the application.",
      "Back in Single Sign-On, enter a provider name, keep Protocol on OIDC (supported), and enter the issuer URL. Aperture Chat reads issuer/.well-known/openid-configuration.",
      "Paste the client ID and client secret, list the allowed email domains, and keep the group claim name your provider sends (groups by default).",
      "Leave Provision new users on first sign-in on if accounts should be created automatically. Leave Enforce SSO for these domains off for now.",
      "Choose Save SSO, then Test connection. Both checks must pass.",
      "In a private browser window, open the workspace, enter the test account's email, choose Continue with SSO, and sign in at the identity provider.",
      "Confirm the person reaches the workspace, then find the account in Admin console › Users.",
    ],
    paths: [
      {
        label: "Keycloak (shown in the video)",
        steps: [
          "Manage realms › Create realm: name the realm for your organization and choose Create. Set a Display name under Realm settings; it appears on the sign-in page.",
          "Clients › Create client: Client type OpenID Connect, Client ID aperture-chat, Name Aperture Chat, then Next.",
          "Capability config: turn on Client authentication, keep Standard flow, clear Direct access grants, turn on Require PKCE, then Next.",
          "Login settings: paste the redirect URI into Valid redirect URIs (no wildcards), then Save.",
          "Credentials tab: keep Client Id and Secret and copy the Client Secret. Keep Allowed authentication method on Any.",
          "Client scopes › aperture-chat-dedicated › Configure a new mapper › Group Membership: Name groups, Token Claim Name groups, Full group path off, Add to ID token on, Save.",
          "Groups › Create group for each group you will map. Users › Create new user: Email verified on, username, email, names, Join Groups, Create; then Credentials › Set password with Temporary off.",
          "Issuer URL for Aperture Chat: https://your-keycloak-host/realms/your-realm. Use the same host name the server and browsers both reach.",
        ],
      },
      {
        label: "Microsoft Entra ID",
        steps: [
          "Entra ID › App registrations › New registration: name it, choose Single tenant only, then Register. Copy the Application (client) ID and Directory (tenant) ID.",
          "Manage › Authentication › Add Redirect URI › Web: paste the redirect URI and Configure. Leave the implicit and hybrid ID tokens box unticked.",
          "Certificates & secrets › New client secret: choose an expiry, Add, and copy the Value (not the Secret ID) right away.",
          "Token configuration: add the email optional claim to the ID token, and Add groups claim (group object IDs) if you will map groups.",
          "Enterprise applications › your app: Properties › Assignment required? Yes; Users and groups › assign people or groups.",
          "Issuer URL: https://login.microsoftonline.com/your-tenant-id/v2.0. Never use common or organizations.",
        ],
      },
      {
        label: "Okta",
        steps: [
          "Applications › Applications › Create App Integration (Classic experience if asked): OIDC - OpenID Connect, Web Application, Next.",
          "Grant type Authorization Code; Sign-in redirect URIs: the redirect URI; Assignments: Limit access to selected groups; Save.",
          "General tab: copy the Client ID and the Client secret.",
          "For group mapping, use the default custom authorization server: Security › API › Authorization Servers › default › Claims › Add Claim named groups, ID Token, Always, value type Groups, a narrow filter, Any scope.",
          "Issuer URL: https://your-org.okta.com/oauth2/default (custom server) or https://your-org.okta.com (org server, no group claim).",
        ],
      },
      {
        label: "Google Workspace",
        steps: [
          "In Google Cloud, choose a project in your organization. Google Auth Platform › Branding: app name and support email. Audience: Internal.",
          "Clients › Create client › Web application: add the redirect URI under Authorized redirect URIs and Create.",
          "Copy the Client ID and Client secret from the dialog; the full secret is shown only once.",
          "Issuer URL: https://accounts.google.com. Google ID tokens carry no groups, so manage workspace groups in the Admin console.",
        ],
      },
    ],
    verify: [
      "Test connection lists Discovery document and Signing keys (JWKS) as passed.",
      "A private-window sign-in with the test account returns to the workspace already signed in.",
      "Admin console › Users lists the person with the USER role and sso under Auth.",
      "Admin console › Audit records auth.user_jit_created for an account created at first sign-in.",
    ],
    troubleshooting: [
      { symptom: "The identity provider rejects the redirect URI (Entra AADSTS50011, Okta \"must be a Login redirect URI\", Google redirect_uri_mismatch, Keycloak \"Invalid parameter: redirect_uri\").", fix: "Register the exact URI shown in the panel. Scheme, host, port, path, and any trailing slash must match. If the panel shows an address people do not use, fix APERTURE_API_BASE_URL." },
      { symptom: "\"Could not fetch OIDC discovery document\"", fix: "The issuer URL is wrong, or the server cannot reach it. Open the issuer followed by /.well-known/openid-configuration from the server's network. For Entra, use your tenant ID, never common." },
      { symptom: "\"Token endpoint returned 401: invalid_client\"", fix: "The client secret is wrong or expired. For Entra, copy the secret's Value rather than its Secret ID. Create a new secret at the provider, paste it, and choose Save SSO." },
      { symptom: "\"ID token validation failed\" mentioning the issuer or audience", fix: "The issuer URL must equal the issuer in the provider's discovery document, character for character, and the client ID must be the one the token was issued to." },
      { symptom: "\"The identity provider did not return an email claim\"", fix: "Grant the email scope or optional claim, and make sure the account has an email address at the provider." },
      { symptom: "\"The identity provider reports … as unverified\"", fix: "Mark the address as verified at the provider (in Keycloak, turn on Email verified), then sign in again." },
      { symptom: "\"… is outside the domains allowed for this SSO provider\"", fix: "Add the domain to Allowed email domains and save, or sign in with an account on an allowed domain." },
      { symptom: "\"JIT provisioning is disabled for this SSO provider\"", fix: "Create the account first in Admin console › Users, or turn on Provision new users on first sign-in." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "Have an owner recovery login, identity-provider admin access, your domains, a test account, and your instance address.",
        narration:
          "This walkthrough connects single sign-on from start to finish, with Keycloak as the identity provider. The same steps apply to any OpenID Connect provider, and Entra, Okta, and Google each have their own lesson. Before you begin, have five things ready: an owner account that signs in with a local password, administrator access to your identity provider, your email domains, a test account with a verified email, and your instance's public address.",
        durationSeconds: 29,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "A platform owner account with a local password, on a domain you will not enforce.",
            "Administrator access to your identity provider.",
            "The email domains your people sign in with.",
            "A test account with a verified email on one of those domains.",
            "Your instance's public address (it must match APERTURE_API_BASE_URL).",
          ],
        },
      },
      {
        title: "Open Single Sign-On",
        caption: "Platform console › Org Settings › Single Sign-On. Start by copying one value the identity provider needs.",
        narration:
          "In the Platform console, open Org Settings and expand Single Sign-On. With nothing configured yet, the form shows starter values. You will fill it in once the identity provider is ready, so start by copying one value from it.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "ssoPanelOpen",
      },
      {
        title: "Copy the redirect URI",
        caption: "Your address + /api/auth/sso/callback. The provider must have this exact value.",
        narration:
          "The redirect URI is where the identity provider sends people back after they sign in: your instance's address, followed by slash api, slash auth, slash S S O, slash callback. Choose Copy. The provider must have this exact address, including the port and the path.",
        durationSeconds: 19,
        focus: "ssoRedirectCopied",
      },
      {
        title: "Create a realm",
        caption: "Keycloak › Manage realms › Create realm. A realm holds your people and applications.",
        narration:
          "Now switch to the identity provider. In the Keycloak admin console, open Manage realms and choose Create realm. A realm is Keycloak's directory of people and applications. Name it for your organization, here example corp, and choose Create. Entra, Okta, and Google already give you a directory, so they skip this step.",
        durationSeconds: 22,
        calloutPlacement: "lower-right",
        focus: "idpRealmCreate",
      },
      {
        title: "Register the application",
        caption: "Clients › Create client: OpenID Connect, a client ID, and a display name.",
        narration:
          "Open Clients and choose Create client. Keep the client type on OpenID Connect, enter a client ID such as aperture dash chat, and a display name. The client ID is one of the values you will paste into Aperture Chat.",
        durationSeconds: 16,
        focus: "idpClientGeneral",
      },
      {
        title: "Make it a confidential client",
        caption: "Client authentication on, Standard flow on, Direct access grants off, Require PKCE with S256.",
        narration:
          "On Capability config, turn on Client authentication, so the provider issues a client secret. Keep Standard flow, which is the authorization code flow, and clear Direct access grants. Turn on Require P K C E, with the S 256 method. Aperture Chat sends an S 256 P K C E challenge with every sign-in.",
        durationSeconds: 25,
        focus: "idpClientCapability",
      },
      {
        title: "Paste the redirect URI",
        caption: "Login settings › Valid redirect URIs: the exact value you copied. No wildcards.",
        narration:
          "On Login settings, paste the redirect URI into Valid redirect URIs, then choose Save. Use the exact value, never a wildcard.",
        durationSeconds: 11,
        focus: "idpClientRedirect",
      },
      {
        title: "Copy the client secret",
        caption: "Credentials tab: copy the client secret. Treat it like a password.",
        narration:
          "Open the Credentials tab. Keep Client I D and Secret as the authenticator, and copy the client secret with the copy button. Treat it like a password: paste it straight into Aperture Chat and nowhere else.",
        durationSeconds: 15,
        focus: "idpClientSecret",
      },
      {
        title: "Send groups in the ID token",
        caption: "Dedicated scope › Group Membership mapper: claim groups, full path off, Add to ID token on.",
        narration:
          "To map identity provider groups to workspace groups, the I D token needs a groups claim. Open Client scopes, then the client's dedicated scope, and configure a Group Membership mapper. Name the claim groups. Turn off Full group path, so values read litigation rather than slash litigation. Keep Add to I D token on, and save.",
        durationSeconds: 23,
        calloutPlacement: "right-mid",
        focus: "idpGroupMapper",
      },
      {
        title: "Create the groups",
        caption: "Groups › Create group for each group you plan to map.",
        narration:
          "Under Groups, create each group you plan to map. This walkthrough uses litigation and finance.",
        durationSeconds: 7,
        focus: "idpGroups",
      },
      {
        title: "Add a test person",
        caption: "Email verified on, an address on your domain, and a group. Then set a password.",
        narration:
          "Under Users, create a test person. Turn on Email verified, because Aperture Chat refuses an address the provider reports as unverified. Use an address on your allowed domain, join the litigation group, and choose Create. Then set a password on the Credentials tab.",
        durationSeconds: 19,
        focus: "idpUserCreate",
      },
      {
        title: "Enter the provider details",
        caption: "Name, OIDC, the issuer URL, and the client ID. Paste the secret next; it is never shown again.",
        narration:
          "Back in Aperture Chat, name the provider and keep the protocol on O I D C. SAML is listed, but it is not a working sign-in path yet. Enter the issuer URL. For Keycloak, that is the server address, slash realms, slash your realm. Paste the client I D, then the client secret. The secret is stored on the server and never shown again.",
        durationSeconds: 23,
        calloutPlacement: "right-mid",
        focus: "ssoProviderDetails",
      },
      {
        title: "Choose who can sign in",
        caption: "Allowed domains and the group claim name. These must match what the provider sends.",
        narration:
          "List the allowed email domains. Only addresses on these domains can use this provider. Keep the group claim named groups, to match the mapper.",
        durationSeconds: 11,
        calloutPlacement: "right-mid",
        focus: "ssoAccessFields",
      },
      {
        title: "Provisioning, MFA, and enforcement",
        caption: "JIT on creates USER accounts at first sign-in. Keep Enforce SSO off until a real sign-in works.",
        narration:
          "Leave Provision new users on, so people are created at their first sign-in with the USER role. Leave Require the platform authenticator off to trust the provider's own multifactor check. Leave Enforce S S O off until a real sign-in works.",
        durationSeconds: 17,
        focus: "ssoAccessToggles",
      },
      {
        title: "Save, then test",
        caption: "Save SSO stores the settings; Test connection checks the provider.",
        narration:
          "Choose Save S S O to store the settings, then Test connection.",
        durationSeconds: 6,
        focus: "ssoActionsRow",
      },
      {
        title: "Read the test result",
        caption: "Discovery document and signing keys passed. The test does not sign anyone in.",
        narration:
          "Both checks passed: the discovery document loaded, and the provider published its signing keys. The test does not sign anyone in, so the next step does.",
        durationSeconds: 11,
        focus: "ssoTestPassed",
      },
      {
        title: "Sign in as the test person",
        caption: "In a private window, enter the email. An allowed domain selects Organization SSO.",
        narration:
          "Open a private window and go to the workspace. Enter the test person's email. Because it is on an allowed domain, Organization S S O is selected. Choose Continue with S S O.",
        durationSeconds: 14,
        calloutPlacement: "right-mid",
        focus: "ssoSignInForm",
      },
      {
        title: "Authenticate at the provider",
        caption: "The provider's own sign-in page, with any MFA it requires. Aperture Chat never sees this password.",
        narration:
          "The browser moves to the identity provider's own sign-in page. The person signs in there, including any multifactor check the provider requires. Aperture Chat never sees this password.",
        durationSeconds: 14,
        calloutPlacement: "right-mid",
        focus: "idpLogin",
      },
      {
        title: "Arrive in the workspace",
        caption: "The signed ID token is verified, the account is created, and the workspace opens.",
        narration:
          "The provider sends the browser back to the redirect URI. Aperture Chat verifies the signed I D token, creates the account, and opens the workspace with the welcome card.",
        durationSeconds: 13,
        focus: "ssoFirstWelcome",
      },
      {
        title: "Confirm the new account",
        caption: "Admin console › Users: the person has the USER role and sso under Auth.",
        narration:
          "Finally, open Admin console, Users. The new person is listed with the USER role and S S O as the sign-in method. Next, map groups and decide on enforcement in the Go live lesson.",
        durationSeconds: 15,
        focus: "ssoJitUserRow",
      },
    ],
  },
  {
    id: "sso-entra",
    audioSrc: "training/owner/sso-entra.mp3",
    title: "Single sign-on with Microsoft Entra ID",
    description: "Register the app in the Entra admin center, add the claims, assign people, and connect it with the Entra preset.",
    icon: "identity",
    track: "Single sign-on",
    outcomes: ["Entra app registered", "Claims and assignment set", "Entra preset saved and tested"],
    prerequisites: [
      "An Entra account with at least the Application Developer role. Token configuration and assignment need Cloud Application Administrator.",
      "Your Directory (tenant) ID, shown on the Entra overview page.",
      "Microsoft Entra ID P1 or P2 if you will assign groups to the app or use Conditional Access.",
      "The redirect URI copied from Platform console › Org Settings › Single Sign-On.",
      "A test account whose email or user principal name is on an allowed domain.",
    ],
    setupSteps: [
      "In Aperture Chat, open Org Settings › Single Sign-On and copy the redirect URI.",
      "Entra admin center › Entra ID › App registrations › New registration. Name the app, choose Single tenant only (older screens: Accounts in this organizational directory only), and select Register.",
      "On Overview, copy the Application (client) ID and the Directory (tenant) ID.",
      "Manage › Authentication › Add Redirect URI › Web. Paste the redirect URI and select Configure. Leave ID tokens (used for implicit and hybrid flows) unticked.",
      "Certificates & secrets › Client secrets › New client secret. Add a description, choose an expiry (Microsoft recommends under 12 months), and select Add. Copy the Value now; it is never shown again.",
      "Token configuration › Add optional claim › ID › email › Add.",
      "To map groups: Token configuration › Add groups claim › Groups assigned to the application (or Security groups) › Save. Values arrive as group object IDs.",
      "Enterprise applications › your app › Properties: set Assignment required? to Yes and Save. Users and groups › Add user/group: assign your test account and groups.",
      "In Aperture Chat, choose the Microsoft Entra ID preset and replace {tenant-id} in the issuer with your Directory (tenant) ID.",
      "Paste the Application (client) ID and the secret Value, list your domains, keep the group claim as groups, and leave Enforce SSO off.",
      "Choose Save SSO, then Test connection. Sign in as the test account from a private window, then check Admin console › Users.",
      "To map groups, copy each group's Object ID from Entra ID › Groups and map it in Admin console › SSO.",
    ],
    verify: [
      "Test connection passes the discovery document and signing keys for login.microsoftonline.com.",
      "The test account signs in through the Microsoft sign-in page and reaches the workspace.",
      "Admin console › Users shows the account with sso under Auth.",
      "After group mapping, the account's groups match its Entra groups at the next sign-in.",
    ],
    troubleshooting: [
      { symptom: "AADSTS50011: the redirect URI does not match", fix: "Add the exact redirect URI under Authentication on the Web platform, not as a single-page application." },
      { symptom: "AADSTS7000215: invalid client secret", fix: "You copied the Secret ID. Create a new secret and copy its Value." },
      { symptom: "AADSTS7000222: the client secret has expired", fix: "Create a new secret, paste it in Single Sign-On, and choose Save SSO. Track the new expiry date." },
      { symptom: "AADSTS700016 (app not found) or AADSTS50194 (single-tenant app used with common)", fix: "Check the client ID, and use https://login.microsoftonline.com/your-tenant-id/v2.0 as the issuer." },
      { symptom: "AADSTS50105: the user is not assigned to the app", fix: "Assign the person or one of their groups under Enterprise applications › Users and groups." },
      { symptom: "AADSTS65001 or AADSTS90094: consent is required", fix: "An administrator grants consent under API permissions › Grant admin consent for your tenant." },
      { symptom: "AADSTS53003: blocked by Conditional Access", fix: "Review the Conditional Access policy that targets the app; test policies in Report-only first." },
      { symptom: "A person signs in but receives no mapped groups", fix: "Entra omits the groups claim above 200 groups. Use Groups assigned to the application, and remember it covers direct members only." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "Entra roles, your tenant ID, the redirect URI, and a test account.",
        narration:
          "This lesson connects Microsoft Entra I D. You need an Entra account that can register applications, your directory tenant I D, the redirect URI from the Single Sign-On panel, and a test account on an allowed domain. Assigning groups to the app and Conditional Access need Entra I D P1 or P2.",
        durationSeconds: 22,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "An Entra account with Application Developer or Cloud Application Administrator.",
            "Your Directory (tenant) ID from the Entra overview page.",
            "Entra ID P1 or P2, if you will assign groups or use Conditional Access.",
            "A test account on an allowed email domain.",
          ],
        },
      },
      {
        title: "Copy the redirect URI",
        caption: "Org Settings › Single Sign-On › Copy. Entra needs this exact value.",
        narration:
          "In the Platform console, open Single Sign-On and copy the redirect URI. Entra needs this exact value.",
        durationSeconds: 9,
        focus: "ssoRedirectCopied",
      },
      {
        title: "Register the application",
        caption: "App registrations › New registration, single tenant. Copy both IDs from Overview.",
        narration:
          "In the Microsoft Entra admin center, open Entra I D, then App registrations, and choose New registration. Name the app, choose Single tenant only, and select Register. On the Overview page, copy the Application client I D and the Directory tenant I D.",
        durationSeconds: 19,
        card: {
          where: "Microsoft Entra admin center",
          steps: [
            "Entra ID › App registrations › New registration.",
            "Name: Aperture Chat.",
            "Supported account types: Single tenant only (older screens: Accounts in this organizational directory only).",
            "Select Register.",
            "On Overview, copy the Application (client) ID and the Directory (tenant) ID.",
          ],
        },
      },
      {
        title: "Add the redirect URI and a secret",
        caption: "Authentication › Web redirect URI. Certificates & secrets › copy the secret's Value.",
        narration:
          "Under Manage, open Authentication, add a redirect URI, choose Web, and paste the value you copied. Then open Certificates and secrets and create a new client secret. Copy its Value straight away. It is never shown again, and the Secret I D will not work. Note the expiry date in your calendar.",
        durationSeconds: 21,
        card: {
          where: "Microsoft Entra admin center",
          steps: [
            "Manage › Authentication › Add Redirect URI › Web. Paste it and select Configure.",
            "Leave ID tokens (used for implicit and hybrid flows) unticked.",
            "Certificates & secrets › Client secrets › New client secret. Choose an expiry and select Add.",
            "Copy the Value column now. The Secret ID is not the secret.",
          ],
          values: [{ label: "Redirect URI", value: "https://your-instance.example/api/auth/sso/callback" }],
        },
      },
      {
        title: "Claims and assignment",
        caption: "Add the email claim and a groups claim, then require assignment and assign people.",
        narration:
          "Open Token configuration. Add the email optional claim to the I D token. If you will map groups, add a groups claim for groups assigned to the application. Entra sends each group as its object I D. Then, in Enterprise applications, set Assignment required to Yes and assign your test account and groups.",
        durationSeconds: 21,
        card: {
          where: "Microsoft Entra admin center",
          steps: [
            "Token configuration › Add optional claim › ID › email › Add.",
            "Token configuration › Add groups claim › Groups assigned to the application › Save. Values are group object IDs.",
            "Enterprise applications › your app › Properties: Assignment required? Yes › Save.",
            "Users and groups › Add user/group: assign the test account and groups.",
          ],
        },
      },
      {
        title: "Use the Entra preset",
        caption: "Replace {tenant-id} with your Directory (tenant) ID, then paste the client ID.",
        narration:
          "Back in Aperture Chat, choose the Microsoft Entra I D preset. It fills the issuer template. Replace the tenant I D placeholder with your directory tenant I D, and never use common or organizations, because each token names your tenant. Paste the application client I D, then the secret Value.",
        durationSeconds: 21,
        focus: "entraPreset",
      },
      {
        title: "Domains, groups, and provisioning",
        caption: "Your domains, the groups claim, JIT on, and enforcement off for now.",
        narration:
          "List your email domains, keep the group claim named groups, leave provisioning on, and leave enforcement off until a real sign-in works.",
        durationSeconds: 10,
        focus: "ssoAccessFields",
      },
      {
        title: "Save, test, and sign in",
        caption: "Save SSO, Test connection, then a private-window sign-in through Microsoft.",
        narration:
          "Choose Save S S O, then Test connection. Then sign in as the test account from a private window. The Microsoft sign-in page applies your Conditional Access policies, and the account returns to the workspace.",
        durationSeconds: 16,
        focus: "ssoActionsRow",
      },
      {
        title: "Confirm and map groups",
        caption: "Check Admin console › Users, then map group object IDs on the SSO tab.",
        narration:
          "Confirm the account in Admin console, Users. To map groups, copy each group's Object I D from Entra and map it to a workspace group on the Admin console S S O tab. The Go live lesson shows mapping and enforcement end to end.",
        durationSeconds: 18,
        focus: "ssoJitUserRow",
      },
    ],
  },
  {
    id: "sso-okta",
    audioSrc: "training/owner/sso-okta.mp3",
    title: "Single sign-on with Okta",
    description: "Create an OIDC web app integration in Okta, choose the authorization server, add a groups claim, and connect it with the Okta preset.",
    icon: "identity",
    track: "Single sign-on",
    outcomes: ["Okta app integration created", "Authorization server chosen", "Okta preset saved and tested"],
    prerequisites: [
      "An Okta administrator account that can create app integrations.",
      "Your Okta domain, such as your-org.okta.com.",
      "API Access Management, if you will use the default custom authorization server in production (needed for a groups claim without an extra scope).",
      "The redirect URI copied from Platform console › Org Settings › Single Sign-On.",
      "A test account assigned to the app, on an allowed email domain.",
    ],
    setupSteps: [
      "In Aperture Chat, open Org Settings › Single Sign-On and copy the redirect URI.",
      "Okta Admin Console › Applications › Applications › Create App Integration. If asked, choose Classic experience.",
      "Sign-in method: OIDC - OpenID Connect. Application type: Web Application. Select Next.",
      "Name the integration, keep Grant type Authorization Code, paste the redirect URI under Sign-in redirect URIs, and choose Limit access to selected groups. Select Save.",
      "On the General tab, copy the Client ID and the Client secret. Client authentication stays Client secret; Aperture Chat uses client_secret_basic first.",
      "Choose the issuer. Org authorization server: https://your-org.okta.com (no groups claim with the default scopes). Default custom server: https://your-org.okta.com/oauth2/default.",
      "For group mapping on the custom server: Security › API › Authorization Servers › default › Claims › Add Claim. Name groups, include in ID Token Always, Value type Groups, a narrow filter such as Starts with aperture-, include in Any scope.",
      "On the same server, make sure an access policy covers this app with a rule that allows the Authorization Code grant.",
      "Assignments tab › Assign › Assign to Groups: assign the groups that should use Aperture Chat.",
      "In Aperture Chat, choose the Okta preset, enter your issuer, paste the client ID and secret, list domains, and keep the group claim as groups.",
      "Choose Save SSO, then Test connection. Sign in as the test account from a private window, then check Admin console › Users.",
    ],
    verify: [
      "Test connection passes for your Okta issuer.",
      "The test account signs in through Okta and reaches the workspace.",
      "With the custom server's groups claim, mapped workspace groups appear at the next sign-in.",
    ],
    troubleshooting: [
      { symptom: "\"The 'redirect_uri' parameter must be a Login redirect URI in the client app settings\"", fix: "Add the exact redirect URI under Sign-in redirect URIs on the app's General tab." },
      { symptom: "\"User is not assigned to the client application\"", fix: "Assign the person or one of their groups on the app's Assignments tab." },
      { symptom: "\"Policy evaluation failed for this request\"", fix: "The custom authorization server has no active access policy and rule covering this app and the Authorization Code grant." },
      { symptom: "\"Token endpoint returned 401: invalid_client\"", fix: "The client secret is wrong or inactive. Copy an active secret from the General tab and save it again." },
      { symptom: "\"The groups claim matched too many groups\"", fix: "Narrow the claim's filter, for example to groups that start with aperture-." },
      { symptom: "People sign in but no mapped groups arrive", fix: "Use the default custom authorization server with a groups claim included in Any scope. The org server sends groups only for the groups scope, which Aperture Chat does not request by default." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "Okta admin access, your Okta domain, the redirect URI, and an assigned test account.",
        narration:
          "This lesson connects Okta. You need an Okta administrator account, your Okta domain, the redirect URI from the Single Sign-On panel, and a test account. Group mapping uses Okta's default custom authorization server, which needs API Access Management in production.",
        durationSeconds: 19,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "An Okta administrator account that can create app integrations.",
            "Your Okta domain, such as your-org.okta.com.",
            "API Access Management, for groups through the default custom authorization server.",
            "A test account on an allowed email domain.",
          ],
        },
      },
      {
        title: "Copy the redirect URI",
        caption: "Org Settings › Single Sign-On › Copy. Okta needs this exact value.",
        narration:
          "In the Platform console, open Single Sign-On and copy the redirect URI. Okta needs this exact value.",
        durationSeconds: 9,
        focus: "ssoRedirectCopied",
      },
      {
        title: "Create the app integration",
        caption: "Create App Integration › OIDC - OpenID Connect › Web Application.",
        narration:
          "In the Okta Admin Console, open Applications, then Applications, and choose Create App Integration. If Okta asks, choose the classic experience. Pick O I D C, OpenID Connect, as the sign-in method and Web Application as the type. Keep the Authorization Code grant, paste the redirect URI, limit access to selected groups, and save.",
        durationSeconds: 24,
        card: {
          where: "Okta Admin Console",
          steps: [
            "Applications › Applications › Create App Integration (Classic experience if asked).",
            "Sign-in method: OIDC - OpenID Connect. Application type: Web Application. Next.",
            "App integration name: Aperture Chat. Grant type: Authorization Code.",
            "Sign-in redirect URIs: paste the redirect URI.",
            "Assignments: Limit access to selected groups. Save.",
          ],
          values: [{ label: "Redirect URI", value: "https://your-instance.example/api/auth/sso/callback" }],
        },
      },
      {
        title: "Copy the credentials",
        caption: "General tab › Client Credentials: copy the Client ID and Client secret.",
        narration:
          "On the General tab, copy the Client I D and the Client secret. Keep client authentication on Client secret.",
        durationSeconds: 9,
        card: {
          where: "Okta Admin Console",
          steps: [
            "Open the app's General tab.",
            "Client Credentials: copy the Client ID.",
            "Client authentication: Client secret.",
            "Client Secrets: copy the active secret.",
          ],
        },
      },
      {
        title: "Choose the authorization server",
        caption: "The org server is simplest. The default custom server can send a groups claim.",
        narration:
          "Next, choose the issuer. The org authorization server is simply your Okta domain, and it needs no extra setup, but with Aperture Chat's default scopes it sends no groups. To map groups, use the default custom authorization server. Add a groups claim to the I D token for any scope, with a narrow filter, and make sure an access policy allows this app.",
        durationSeconds: 24,
        card: {
          where: "Okta Admin Console",
          steps: [
            "Org server issuer: https://your-org.okta.com. No groups with the default scopes.",
            "Custom server issuer: https://your-org.okta.com/oauth2/default.",
            "Security › API › Authorization Servers › default › Claims › Add Claim.",
            "Name groups, ID Token, Always, value type Groups, filter Starts with aperture-, Any scope.",
            "Access Policies: a policy and rule that allow this app the Authorization Code grant.",
          ],
        },
      },
      {
        title: "Assign people",
        caption: "Assignments › Assign to Groups. Only assigned people can sign in.",
        narration:
          "On the Assignments tab, assign the groups that should use Aperture Chat. People who are not assigned see an error from Okta.",
        durationSeconds: 9,
        card: {
          where: "Okta Admin Console",
          steps: [
            "Open the app's Assignments tab.",
            "Assign › Assign to Groups.",
            "Choose Assign for each group, then Done.",
          ],
        },
      },
      {
        title: "Use the Okta preset",
        caption: "Enter your issuer, then paste the client ID and secret.",
        narration:
          "In Aperture Chat, choose the Okta preset and replace your org with your Okta domain. Add slash oauth2 slash default when you use the custom server. Paste the client I D and the client secret.",
        durationSeconds: 14,
        focus: "oktaPreset",
      },
      {
        title: "Save, test, and sign in",
        caption: "Save SSO, Test connection, then a private-window sign-in through Okta.",
        narration:
          "List your domains, keep the group claim named groups, and leave enforcement off. Choose Save S S O, then Test connection, and sign in as the test account from a private window. Then confirm the account in Admin console, Users.",
        durationSeconds: 17,
        focus: "ssoActionsRow",
      },
    ],
  },
  {
    id: "sso-google",
    audioSrc: "training/owner/sso-google.mp3",
    title: "Single sign-on with Google Workspace",
    description: "Create an internal OAuth client in Google Auth Platform, connect it with the Google preset, and test Google's public issuer.",
    icon: "identity",
    track: "Single sign-on",
    outcomes: ["Internal OAuth client created", "Google preset saved", "Discovery and signing keys verified"],
    prerequisites: [
      "A Google Cloud project that belongs to your Workspace or Cloud Identity organization (required for an Internal audience).",
      "Permission to configure Google Auth Platform in that project.",
      "The redirect URI copied from Platform console › Org Settings › Single Sign-On. Google requires HTTPS for production redirect URIs.",
      "A Workspace test account on an allowed email domain.",
    ],
    setupSteps: [
      "In Aperture Chat, open Org Settings › Single Sign-On and copy the redirect URI.",
      "Google Cloud console › select your organization's project › Google Auth Platform › Branding. If asked, choose Get started and enter the app name and user support email.",
      "Audience: User type Internal, so only your organization can sign in.",
      "Clients › Create client › Application type Web application. Name it, add the redirect URI under Authorized redirect URIs, and select Create.",
      "Copy the Client ID and Client secret from the dialog (or download the JSON). Google shows the full secret only once.",
      "In Aperture Chat, choose the Google Workspace preset. The issuer is https://accounts.google.com.",
      "Paste the client ID and secret, list your Workspace domains, and leave Enforce SSO off.",
      "Choose Save SSO, then Test connection. Sign in as the test account from a private window and check Admin console › Users.",
      "Google ID tokens include no groups. Assign workspace groups to people in Admin console › Users or Groups.",
    ],
    verify: [
      "Test connection passes the discovery document and signing keys for https://accounts.google.com.",
      "The test account signs in with Google and reaches the workspace.",
      "Someone outside your organization is refused by Google because the audience is Internal.",
    ],
    troubleshooting: [
      { symptom: "Error 400: redirect_uri_mismatch", fix: "Add the exact redirect URI under the client's Authorized redirect URIs." },
      { symptom: "Access blocked: org_internal", fix: "The account is outside your organization. Internal clients accept only your Workspace accounts." },
      { symptom: "\"Token endpoint returned 401: invalid_client\" or deleted_client", fix: "The secret is wrong, or Google deleted a client unused for six months. Add a new secret or client and save it." },
      { symptom: "admin_policy_enforced", fix: "A Workspace administrator blocked the app. Trust it under Security › Access and data control › API controls." },
      { symptom: "Mapped groups never change", fix: "Expected with Google: its ID tokens carry no groups claim. Manage groups in the Admin console." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "An organization-owned Cloud project, Auth Platform access, the redirect URI, and a test account.",
        narration:
          "This lesson connects Google Workspace. You need a Google Cloud project that belongs to your organization, permission to configure Google Auth Platform, the redirect URI from the Single Sign-On panel, and a Workspace test account.",
        durationSeconds: 16,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "A Google Cloud project inside your Workspace organization.",
            "Permission to configure Google Auth Platform in that project.",
            "The redirect URI from Single Sign-On (HTTPS in production).",
            "A Workspace test account on an allowed domain.",
          ],
        },
      },
      {
        title: "Configure Google Auth Platform",
        caption: "Branding, then an Internal audience so only your organization can sign in.",
        narration:
          "In the Google Cloud console, select your organization's project and open Google Auth Platform. On Branding, enter the app name and a support email. On Audience, choose Internal, so only accounts in your organization can sign in.",
        durationSeconds: 17,
        card: {
          where: "Google Cloud console",
          steps: [
            "Select your organization's project.",
            "Google Auth Platform › Branding: app name and user support email.",
            "Audience › User type: Internal.",
          ],
        },
      },
      {
        title: "Create the OAuth client",
        caption: "Clients › Create client › Web application, with the redirect URI. Copy the secret now.",
        narration:
          "Open Clients and choose Create client. Pick Web application, give it a name, and add the redirect URI under Authorized redirect URIs. Select Create, then copy the Client I D and the Client secret. Google shows the full secret only once.",
        durationSeconds: 18,
        card: {
          where: "Google Cloud console",
          steps: [
            "Google Auth Platform › Clients › Create client.",
            "Application type: Web application. Name: Aperture Chat.",
            "Authorized redirect URIs › Add URI: paste the redirect URI.",
            "Create, then copy the Client ID and Client secret from the dialog.",
          ],
          values: [{ label: "Redirect URI", value: "https://your-instance.example/api/auth/sso/callback" }],
        },
      },
      {
        title: "Use the Google preset",
        caption: "The issuer is https://accounts.google.com. Paste the client ID and secret.",
        narration:
          "In Aperture Chat, choose the Google Workspace preset. The issuer is always accounts dot google dot com. Paste the client I D and the secret, and list your Workspace domains.",
        durationSeconds: 13,
        focus: "googlePreset",
      },
      {
        title: "Save and test",
        caption: "Google's discovery document and signing keys are public, so the test passes before any sign-in.",
        narration:
          "Choose Save S S O, then Test connection. Google publishes its discovery document and signing keys publicly, so both checks pass. Next, sign in as the test account from a private window, and confirm the account in Admin console, Users.",
        durationSeconds: 18,
        calloutPlacement: "upper-right",
        focus: "googleTestPassed",
      },
      {
        title: "Groups with Google",
        caption: "Google ID tokens carry no groups. Assign workspace groups in the Admin console.",
        narration:
          "Google I D tokens do not include groups, so group mapping does not apply. Assign workspace groups to people in the Admin console instead. Everything else, including enforcement, works as described in the Go live lesson.",
        durationSeconds: 16,
        card: {
          where: "Aperture Chat Admin console",
          steps: [
            "Admin console › Users: open the person and choose their groups.",
            "Or Admin console › Groups: add members to each group.",
            "Leave the SSO tab's group mapping empty for Google.",
          ],
        },
      },
    ],
  },
  {
    id: "sso-security",
    audioSrc: "training/owner/sso-security.mp3",
    title: "Go live: groups, MFA, and enforcement",
    description: "Map identity-provider groups, prove they sync, choose the MFA rule, enforce SSO, and recognize the refusals people may see.",
    icon: "mfa",
    track: "Single sign-on",
    outcomes: ["Groups map at sign-in", "SSO enforced for the domain", "Recovery path kept"],
    prerequisites: [
      "A working SSO connection: Test connection passes and a test account has signed in.",
      "Workspace groups that match how you want to grant access.",
      "A groups claim in the ID token (not available with Google).",
      "A platform owner account that signs in with a local password on a domain you will not enforce.",
    ],
    setupSteps: [
      "Admin console › SSO: on the provider's card, choose Add mapping for each identity-provider group. Enter the claim value exactly as the provider sends it (a name, path, or object ID) and choose the workspace group.",
      "Choose Save mappings. SSO now owns membership in the mapped workspace groups; other groups stay admin-managed.",
      "Sign in again as the test account, then check Admin console › Users: the mapped group appears.",
      "Decide on Require the platform authenticator after SSO. Off trusts the provider's MFA; on adds the Aperture Chat authenticator after every SSO sign-in.",
      "Tell people on the domain that password sign-in is ending, and confirm everyone can sign in through the provider.",
      "Platform console › Org Settings › Single Sign-On: turn on Enforce SSO for these domains and choose Save SSO.",
      "Confirm that a local password on the domain is now refused, and that your owner recovery account still signs in.",
    ],
    verify: [
      "After a fresh sign-in, the person's groups in Admin console › Users match their identity-provider groups.",
      "Audit records auth.sso_groups_synced when membership changes.",
      "A local password on the enforced domain is refused with \"SSO is enforced for this email domain; local sign-in is disabled.\"",
      "Your owner recovery account still signs in with its password.",
    ],
    troubleshooting: [
      { symptom: "Mapped groups do not appear", fix: "The claim value must match exactly, including case and any leading slash. Check the group claim name in Single Sign-On, and that the provider adds the claim to the ID token." },
      { symptom: "\"SSO is enforced for this email domain; local sign-in is disabled.\"", fix: "Expected after enforcement. Use Continue with SSO. To restore password sign-in, an owner turns enforcement off." },
      { symptom: "\"… is outside the domains allowed for this SSO provider.\"", fix: "The provider vouched for an address on another domain. Add the domain, or keep that person out." },
      { symptom: "\"This email now belongs to a different identity at the provider.\"", fix: "The provider reissued the address to someone new. An administrator resets the account's password, which re-binds it at the next SSO sign-in." },
      { symptom: "\"Organization policy requires admin accounts to sign in through SSO.\"", fix: "Policy Controls requires SSO for admins. Admins use Continue with SSO; owners keep their local recovery path." },
    ],
    scenes: [
      {
        title: "Map identity-provider groups",
        caption: "Admin console › SSO: map each claim value to a workspace group, then Save mappings.",
        narration:
          "With sign-in working, map groups. Open Admin console, S S O. On the provider's card, choose Add mapping, enter the value exactly as the provider sends it, and pick a workspace group. Here, litigation maps to Litigation, and finance maps to Finance Team. Choose Save mappings. S S O now owns membership in these groups, and every other group stays under your control.",
        durationSeconds: 25,
        focus: "ssoMappingEditor",
      },
      {
        title: "Groups follow the next sign-in",
        caption: "After a fresh sign-in, the person's mapped group appears in Users.",
        narration:
          "Membership updates at each sign-in. After the test person signs in again, Admin console, Users shows the Litigation group, which came from the litigation group at the provider.",
        durationSeconds: 13,
        focus: "ssoGroupsSyncedRow",
      },
      {
        title: "Choose the MFA rule",
        caption: "Off trusts the provider's MFA. On adds the platform authenticator after every SSO sign-in.",
        narration:
          "Decide on Require the platform authenticator after S S O. Off trusts the identity provider's own multifactor check, such as Conditional Access. On asks people to enroll and use the Aperture Chat authenticator after every S S O sign-in. The authenticator name and enrollment link fields are recorded for reference; they do not enforce anything.",
        durationSeconds: 25,
        focus: "ssoMfaToggle",
      },
      {
        title: "Enforce SSO for the domain",
        caption: "Turn on Enforce SSO for these domains and choose Save SSO.",
        narration:
          "When everyone can sign in through the provider, turn on Enforce S S O for these domains and choose Save S S O. Password sign-in ends for those domains.",
        durationSeconds: 12,
        focus: "ssoEnforceRow",
      },
      {
        title: "Passwords on the domain are refused",
        caption: "A local password on an enforced domain is refused with a clear message.",
        narration:
          "Here is what people see. Morgan had a local password on this domain before S S O. Password sign-in now fails with: S S O is enforced for this email domain; local sign-in is disabled. Morgan uses Continue with S S O instead, and the existing account links to the provider.",
        durationSeconds: 21,
        calloutPlacement: "right-mid",
        focus: "ssoPasswordBlocked",
      },
      {
        title: "Other domains are refused",
        caption: "An identity-provider account outside the allowed domains cannot get in.",
        narration:
          "Allowed domains still apply after the provider vouches for someone. This account exists at the provider, but its address is on another domain, so Aperture Chat refuses it and explains why.",
        durationSeconds: 14,
        calloutPlacement: "right-mid",
        focus: "ssoDomainRejected",
      },
      {
        title: "Keep a way back in",
        caption: "Keep an owner on a local password, outside the enforced domains.",
        narration:
          "Finally, keep a way back in. Keep at least one platform owner who signs in with a local password on a domain you do not enforce. If the identity provider is ever unavailable, that owner can turn enforcement off. Test the recovery account after you go live.",
        durationSeconds: 18,
        card: {
          label: "Recovery plan",
          where: "Before and after go-live",
          steps: [
            "Keep one platform owner on a local password, outside the enforced domains.",
            "Store that owner's password and authenticator recovery codes securely.",
            "If the provider is down, that owner turns off Enforce SSO for these domains.",
            "Rotate the client secret before it expires, and save it in Single Sign-On.",
          ],
        },
      },
    ],
  },
  {
    id: "policies-connectors",
    audioSrc: "training/owner/policies-connectors.mp3",
    title: "Policies, budget, and connectors",
    description: "Set the organization's policy ceiling, cap workspace usage with a budget, and configure and test the shared connectors people use for files and web search.",
    icon: "policy",
    track: "Policies and branding",
    outcomes: [
      "Each Policy Controls switch is set deliberately, and its effect is confirmed",
      "A workspace budget caps tokens or dollars per day, week, or month",
      "Each shared connector is saved and tested, with its real result read",
    ],
    prerequisites: [
      "A platform owner account.",
      "For connectors: an administrator at the vendor (Google Cloud, Microsoft Entra, Box, or iManage) who can register an application and grant consent.",
      "Your instance's API address. Connector redirect URIs are that address followed by /api/connector-oauth/callback.",
    ],
    setupSteps: [
      "Open Platform console › Org Settings. Each area is a collapsed panel; expand only the one you need.",
      "Expand Policy Controls. Read each switch's description, which states what is true right now, then turn on or off the switches you need. Each change saves immediately and shows a confirmation.",
      "Expand Workspace Usage Budget. Choose the Budget measure (Token allowance or Dollar amount (USD)), the Reset period (Every day, Every week, or Every month, in UTC), and the limit. 0 means unlimited.",
      "Choose Save budget policy and read the confirmation, for example Workspace ceiling saved at 1,000 tokens daily.",
      "Expand Connectors. Turn each source on or off with its switch; off removes it for everyone, including the API.",
      "For a connector with credentials, choose Configure, pick the Authentication method, fill in the vendor's values and secret, and choose Save configuration.",
      "Choose Test connection and read every line of the result. For Google Drive, finish with Connect Google Drive to authorize the workspace account.",
    ],
    paths: [
      {
        label: "Policy Controls: what each switch changes",
        steps: [
          "Only owners can create platform owners: always on; no switch can loosen it.",
          "Downstream API access. On: owners and tenant admins can create personal pass-through keys; standard users still need an administrator's Can use API grant. Off: keys cannot authenticate and admins cannot grant new access.",
          "Tenant admins can create admins. On: tenant admins may create and manage other tenant admins. Off: they can create standard users only.",
          "Require SSO for admins. On: password fallback is rejected for admin accounts. Off: admins may sign in with a local password when one is provisioned.",
          "Tenant admins can manage SSO mappings. On: tenant admins can create and update SSO configurations. Off: only platform owners may change them.",
          "Default group for enabled models. On: newly enabled models include Default Users. Off: admins grant groups per model.",
          "Users can build their own agents (on: groups granted Can build agents may create private agents), Personalization memory (off: no memory anywhere), and Users can browse the model catalog (see Organization model availability).",
        ],
      },
      {
        label: "Budget in tokens",
        steps: [
          "Budget measure: Token allowance. It counts exact provider-reported tokens.",
          "Reset period: Every day, Every week (weeks begin Monday), or Every month, all in UTC.",
          "Token limit: the ceiling; 0 for unlimited. Save budget policy.",
          "When the ceiling is reached, people see: The workspace daily token budget has been reached. Requests are blocked until the next UTC day.",
        ],
      },
      {
        label: "Budget in dollars (USD)",
        steps: [
          "Budget measure: Dollar amount (USD). It uses exact provider-reported cost; unreported cost is shown separately.",
          "Enter the Dollar limit and choose Save budget policy.",
          "Administrators can add per-user and per-group allocations beneath this ceiling in the Admin console.",
        ],
      },
      {
        label: "Web Search",
        steps: [
          "Configure › Search engine: DuckDuckGo (keyless), SearXNG (your own instance; enter its URL and allow JSON output), or OpenAI, Anthropic, or OpenRouter web search (reuses that provider's key; each search is billed to that account).",
          "Results per search: how many results are added to the prompt as cited context.",
          "Save configuration, then Test connection runs a real search.",
        ],
      },
      {
        label: "Google Drive",
        steps: [
          "In Google Cloud, enable the Drive API, set up the Google Auth Platform, add the drive.readonly scope, and create a Web application client with the redirect URI.",
          "Configure › Google OAuth (recommended): OAuth client ID, optional Drive folder ID and Source label, and the OAuth client secret. Save configuration.",
          "Choose Connect Google Drive and sign in with the workspace account used for knowledge sync. Then Test connection.",
          "Chat users connect their own Google account from the attach menu and see only their own files.",
        ],
      },
      {
        label: "OneDrive / SharePoint / Outlook (Microsoft Graph)",
        steps: [
          "In Entra, register a single-tenant app, add Files.Read.All (and Sites.Read.All) as application permissions, grant admin consent, and create a client secret.",
          "Configure › App-only (client credentials, recommended): Directory (tenant) ID, Application (client) ID, optional SharePoint site, Drive, and Root folder IDs, and the Client secret.",
          "Save configuration, then Test connection requests a token and calls Graph.",
          "For chat attachments, also add the scopes as delegated permissions and the Web redirect URI.",
        ],
      },
      {
        label: "Box",
        steps: [
          "In the Box Developer Console, create a Server app with Client Credentials Grant, App + Enterprise Access, and Read all files and folders; submit it, and have a Box admin authorize it in Admin Console › Platform › Platform Apps.",
          "Configure › Client Credentials Grant (recommended): Client ID, Enterprise ID, optional Folder ID, and the Client secret.",
          "Save configuration, then Test connection.",
        ],
      },
      {
        label: "iManage",
        steps: [
          "In iManage Control Center, add a Web, confidential application with the redirect URI and refresh tokens allowed.",
          "Configure › Each user signs in (recommended): Instance URL, API key (client ID), Customer ID, Library ID, optional Workspace ID, and the OAuth client secret.",
          "Save configuration. Test connection confirms the fields; each person completes verification by opening iManage from chat and signing in.",
          "Service account for background sync is only for knowledge sync; chat always uses each person's own sign-in.",
        ],
      },
    ],
    verify: [
      "Each policy change shows its own confirmation, and the switch's description now describes the new state.",
      "With Downstream API access on, an administrator's Account panel shows API access with Create key.",
      "The budget panel shows the saved ceiling and the current period's usage; a person who exceeds it gets the budget message instead of a reply.",
      "A connector's Test connection lists Required fields, Authentication, and API access as passed.",
    ],
    troubleshooting: [
      { symptom: "\"Web search test failed: DuckDuckGo returned a page with no parseable results (it rate-limits automated queries).\"", fix: "DuckDuckGo limits automated searches from busy servers. Retry later, or switch to SearXNG or a provider's web search." },
      { symptom: "\"OpenAI web search reuses the workspace's OpenAI provider key. Add an active OpenAI key under Providers, or switch to a keyless engine.\"", fix: "Add an OpenAI key in Providers, or choose DuckDuckGo or SearXNG." },
      { symptom: "\"Google Drive is not connected: no refresh token is stored …\"", fix: "Save the client ID and secret, then choose Connect Google Drive and finish Google's consent screen." },
      { symptom: "\"Microsoft Graph token request failed: token endpoint returned HTTP 400: AADSTS90002: Tenant '…' not found.\"", fix: "The Directory (tenant) ID is wrong. Copy it from the app's Overview page in Entra." },
      { symptom: "\"Box token request failed: token endpoint returned HTTP 400: The client credentials are invalid\"", fix: "Check the Client ID and secret, and that a Box admin authorized the app in Platform Apps." },
      { symptom: "People keep seeing Aperture Chat is working for several minutes, then the budget message.", fix: "The workspace budget is spent. Raise or clear the ceiling, or wait for the next UTC period. The chat currently retries for a few minutes before it shows the message." },
      { symptom: "\"Policy was not saved: …\"", fix: "The change was not stored and the switch returns to its previous state. Read the reason and try again." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "An owner account, vendor administrators for any connectors, and your instance's API address.",
        narration:
          "This lesson covers three owner controls in Org Settings: the policy ceiling, the workspace budget, and the shared connectors for files and web search. For connectors, you need an administrator at each vendor who can register an application, and your instance's address for the redirect U R I.",
        durationSeconds: 20,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "A platform owner account.",
            "An administrator at each connector vendor: Google Cloud, Microsoft Entra, Box, or iManage.",
            "Your instance's API address; redirect URIs end in /api/connector-oauth/callback.",
          ],
        },
      },
      {
        title: "Org Settings panels",
        caption: "Org Settings groups each area into a collapsed panel. Expand only the one you need.",
        narration:
          "Open Platform console, then Org Settings. Each area is a collapsed panel: Role Boundary, Single Sign-On, Platform Branding, Policy Controls, Workspace Usage Budget, Connectors, and Elastic Analytics. Expand only the one you need.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "policyCollapsed",
      },
      {
        title: "The policy ceiling",
        caption: "Each switch's description states what is true right now, and changes when you flip it.",
        narration:
          "Policy Controls set the ceiling for the whole organization; administrators can only work inside it. Each description states what is true right now, and it changes when you flip the switch.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "policyToggles",
      },
      {
        title: "One rule is always on",
        caption: "Only owners can create platform owners: enforced by the platform, with no switch.",
        narration:
          "The first row has no switch. Only platform owners can create or promote another platform owner, and nothing in these controls can loosen that.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "policyFloor",
      },
      {
        title: "Change a policy",
        caption: "Each change saves at once, with its own confirmation. Here: Downstream API access on.",
        narration:
          "Each switch saves as soon as you flip it. Here, Downstream A P I access is turned on, and the confirmation says exactly what changed: owners and admins can now create personal keys, while standard users still need an administrator's grant.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "policySaved",
      },
      {
        title: "See the effect",
        caption: "An administrator's Account panel now offers API access with Create key.",
        narration:
          "Check the effect from the other side. An administrator opens their account panel, and A P I access now appears, with the platform U R L and Create key. With the policy off, this card is not shown at all.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        focus: "policyApiAccess",
      },
      {
        title: "The workspace budget",
        caption: "Budget measure, Reset period in UTC, and the limit. Usage for the current period shows below.",
        narration:
          "Expand Workspace Usage Budget. Choose what to measure, how often it resets, and the limit. Zero means unlimited. Below, the usage card shows how much of the current period has been used, from provider-reported numbers.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "budgetControls",
      },
      {
        title: "Tokens or dollars",
        caption: "Dollar amount (USD) uses provider-reported cost; unreported cost is shown separately.",
        narration:
          "The budget can count tokens or dollars. Choose Dollar amount, and the limit becomes a dollar figure based on the cost each provider reports. Cost a provider does not report is shown separately, so nothing is guessed.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        focus: "budgetUsd",
      },
      {
        title: "Save a ceiling",
        caption: "Save budget policy: Workspace ceiling saved at 1,000 tokens daily.",
        narration:
          "Here the ceiling is set to one thousand tokens a day and saved. Today's usage is already above it, so the next request will be refused.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        focus: "budgetSaved",
      },
      {
        title: "What people see",
        caption: "\"The workspace daily token budget has been reached. Requests are blocked until the next UTC day.\"",
        narration:
          "A person's next message is refused with the budget message: the workspace daily token budget has been reached, and requests are blocked until the next U T C day. Be aware that the chat currently keeps trying for a few minutes before this message appears.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "budgetBlocked",
      },
      {
        title: "Back to unlimited",
        caption: "A limit of 0 saves the workspace ceiling as unlimited.",
        narration:
          "Set the limit back to zero and save, and the ceiling is unlimited again. Allocations that administrators set for users and groups still apply.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "budgetUnlimited",
      },
      {
        title: "Shared connectors",
        caption: "Each source has a switch for everyone, and Configure for its credentials.",
        narration:
          "Expand Connectors. Every source and tool has a switch; off removes it for everyone, in chat, pickers, the tool library, and the A P I. Sources that need credentials show Needs credentials until you configure them.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "sharedConnectors",
      },
      {
        title: "Web Search, tested live",
        caption: "DuckDuckGo needs no key. Test connection runs a real search; here DuckDuckGo was rate-limiting.",
        narration:
          "Web Search works without a key using DuckDuckGo. Save the configuration, then Test connection runs a real search. In this recording, DuckDuckGo was limiting automated searches, so the test failed with that exact reason. Retry later, or choose another engine.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "connWebTested",
      },
      {
        title: "Keyed search engines",
        caption: "OpenAI, Anthropic, or OpenRouter web search reuse that provider's key and bill that account.",
        narration:
          "You can also choose Open A I, Anthropic, or OpenRouter web search. They reuse that provider's key, and each search is billed to that account. This workspace has no Open A I key, so the test says to add one under Providers, or pick a keyless engine.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "connWebKeyed",
      },
      {
        title: "Register Google Drive access",
        caption: "Google Cloud console: Drive API, Google Auth Platform, drive.readonly, and a Web client.",
        narration:
          "For Google Drive, start in the Google Cloud console. Enable the Drive A P I, set up the Google Auth Platform with the drive read-only scope, and create a web application client with your redirect U R I. Copy the client I D and secret.",
        durationSeconds: 17,
        card: {
          where: "Google Cloud console",
          steps: [
            "Enable the Google Drive API for your project.",
            "Google Auth Platform › Branding: app name and support email. Audience: Internal.",
            "Data Access: add the drive.readonly scope.",
            "Clients › Create client › Web application.",
            "Authorized redirect URIs: add the redirect URI below, then Create.",
            "Copy the Client ID and Client secret.",
          ],
          values: [{ label: "Redirect URI", value: "https://your-instance.example/api/connector-oauth/callback" }],
        },
      },
      {
        title: "Configure Google Drive",
        caption: "Google OAuth (recommended): client ID, optional folder ID and source label, then the secret.",
        narration:
          "Choose Configure on Google Drive and keep Google O Auth. Paste the client I D, an optional Drive folder I D to index from, and a source label people will recognise, then the client secret. Choose Save configuration.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "connDriveForm",
      },
      {
        title: "Authorize, then test",
        caption: "Until Connect Google Drive is completed, the test reports that no refresh token is stored.",
        narration:
          "Test connection checks each step. The fields are complete, but the workspace has not authorized Google yet, so it says no refresh token is stored. Choose Connect Google Drive, sign in with the workspace account on Google's consent screen, and test again.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "connDriveTested",
      },
      {
        title: "Register a Microsoft Graph app",
        caption: "Entra: a single-tenant app with Files.Read.All, admin consent, and a client secret.",
        narration:
          "For OneDrive and SharePoint, register an app in the Microsoft Entra admin center. Add Files dot Read dot All, and Sites dot Read dot All for SharePoint, as application permissions, grant admin consent, and create a client secret. Copy its value straight away.",
        durationSeconds: 19,
        card: {
          where: "Microsoft Entra admin center",
          steps: [
            "Entra ID › App registrations › New registration: Single tenant only, then Register.",
            "Overview: copy the Application (client) ID and Directory (tenant) ID.",
            "API permissions › Add a permission › Microsoft Graph › Application permissions: Files.Read.All (and Sites.Read.All).",
            "Choose Grant admin consent for your tenant.",
            "Certificates & secrets › New client secret › Add; copy the Value now.",
          ],
        },
      },
      {
        title: "Configure OneDrive and SharePoint",
        caption: "App-only (client credentials): tenant ID, client ID, optional site, drive, and folder, then the secret.",
        narration:
          "Choose Configure on OneDrive, SharePoint, and Outlook, and keep app-only access. Paste the directory tenant I D and the application client I D. A SharePoint site, drive, and root folder are optional. Add the client secret and save.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "connGraphForm",
      },
      {
        title: "A real Microsoft answer",
        caption: "With a made-up tenant ID, Microsoft answers AADSTS90002: Tenant not found.",
        narration:
          "This recording used a made-up tenant I D, so Microsoft's token service answered with error A A D S T S nine zero zero zero two: tenant not found. With your real values, the test acquires a token and checks Graph access.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "connGraphTested",
      },
      {
        title: "Register a Box app",
        caption: "Box Developer Console: a Server app with Client Credentials Grant, authorized by a Box admin.",
        narration:
          "For Box, create a server app with the client credentials grant in the Box Developer Console. Give it app plus enterprise access and read access to files and folders, submit it, and have a Box admin authorize it under Platform Apps.",
        durationSeconds: 16,
        card: {
          where: "Box Developer Console and Admin Console",
          steps: [
            "Developer Console › New App › Server › Client Credentials Grant › Create.",
            "Configuration: App Access Level App + Enterprise Access; scope Read all files and folders stored in Box.",
            "Copy the Client ID and Client Secret.",
            "Submit the app for admin approval.",
            "Box admin: Admin Console › Platform › Platform Apps › Add, and paste the Client ID.",
            "Enterprise ID: Admin Console › Account & Billing.",
          ],
        },
      },
      {
        title: "Configure and test Box",
        caption: "Client ID, Enterprise ID, optional Folder ID, and the secret. Box rejected these made-up credentials.",
        narration:
          "Choose Configure on Box. Enter the client I D, the enterprise I D, an optional folder I D, and the client secret, then save and test. Box rejected these made-up credentials with: the client credentials are invalid.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "connBoxTested",
      },
      {
        title: "Register an iManage application",
        caption: "iManage Control Center: a Web, confidential application with the redirect URL and refresh tokens.",
        narration:
          "For iManage, add an application in iManage Control Center. Make it a web, confidential client, add the redirect U R L, and allow refresh tokens. Copy the client I D and secret. Labels can vary by iManage version, so check with your iManage administrator.",
        durationSeconds: 20,
        card: {
          where: "iManage Control Center",
          steps: [
            "Settings › Applications › Add Application › Configure Manually.",
            "Authentication: Application Type Web, Client Type Confidential.",
            "Add the Redirect URL, set a Client Secret and expiry, and turn on Allow Refresh Token.",
            "Access: all users or a custom list; Review, then Finish.",
            "Copy the Client ID (API key) and the client secret.",
          ],
          values: [{ label: "Redirect URL", value: "https://your-instance.example/api/connector-oauth/callback" }],
        },
      },
      {
        title: "iManage: each person signs in",
        caption: "With Each user signs in, the test confirms the fields; people finish by signing in from chat.",
        narration:
          "Choose Configure on iManage, keep each user signs in, and enter the instance U R L, client I D, customer, and library. Save and test. Because iManage checks each person's own permissions, the test confirms the settings, and each person completes verification by opening iManage from chat and signing in.",
        durationSeconds: 22,
        calloutPlacement: "left-rail",
        focus: "connImanageTested",
      },
    ],
  },
  {
    id: "branding",
    audioSrc: "training/owner/branding.mp3",
    title: "Platform branding",
    description: "Give the platform your organization's name, logo, and colors, apply them everywhere, and check each place the brand appears.",
    icon: "branding",
    track: "Policies and branding",
    outcomes: [
      "The platform name, logo, and browser icon are set",
      "Theme colors restyle buttons, the sidebar, and text",
      "The brand appears in the sidebar, on the sign-in page, and on the installed app icon",
    ],
    prerequisites: [
      "A platform owner account.",
      "A square PNG logo under 4 MB, or public HTTPS addresses for a logo and a browser icon.",
      "Your colors as 6-digit hex values, such as #2f5d8a. Pick dark sidebar colors so the light sidebar text stays readable.",
    ],
    setupSteps: [
      "Open Platform console › Org Settings and expand Platform Branding. The preview at the top shows the logo, name, and an Interface text sample.",
      "Enter the Platform name. It replaces Aperture Chat in the sidebar, the sign-in page, the browser tab, and the installed app.",
      "Choose Upload PNG and pick your logo. It fills both Platform logo URL and Browser icon URL. Or paste HTTPS addresses into those fields instead.",
      "Enter the Platform domain people use. It is recorded for administrators and the API; it does not change DNS, TLS, or routing.",
      "Under Theme colors, set Accent color, Sidebar gradient start, Sidebar gradient end, and Interface text color. Leave a field empty to keep the default for that surface.",
      "Choose Apply branding. The message … branding saved through the platform API and will persist across reloads confirms it.",
      "Check the sidebar, open the sign-in page in a private window, and on a phone add the workspace to the home screen to see the new icon and name.",
      "To undo everything, choose Reset defaults. It saves the Aperture Chat defaults immediately.",
    ],
    paths: [
      {
        label: "Upload a PNG (shown in the video)",
        steps: [
          "Upload PNG accepts PNG files up to 4 MB and shrinks them for the sidebar and icons.",
          "The upload fills Platform logo URL and Browser icon URL with the stored image; nothing needs hosting elsewhere.",
          "Choose Apply branding to save it.",
        ],
      },
      {
        label: "Use hosted image addresses",
        steps: [
          "Paste an HTTPS address into Platform logo URL for the sidebar and sign-in mark.",
          "Paste an HTTPS address into Browser icon URL for the tab icon (it falls back to the logo when empty).",
          "Choose Apply branding.",
        ],
      },
    ],
    verify: [
      "The confirmation reads … branding saved through the platform API and will persist across reloads, and the fields keep their values after a reload.",
      "The sidebar shows the new name, logo, and gradient.",
      "A signed-out visitor sees the new name and logo on the sign-in page, including New to … under the form.",
      "The installed app icon (/api/pwa/icon-512.png) shows the uploaded logo, and the manifest's name is the new platform name.",
    ],
    troubleshooting: [
      { symptom: "\"Set both gradient colors (or clear both) so the sidebar gradient has a start and an end.\"", fix: "Fill in both Sidebar gradient start and Sidebar gradient end, or clear both." },
      { symptom: "\"… is not a 6-digit hex color like #087d8b. Fix it before applying.\"", fix: "Use a # followed by exactly six hex digits, or use the color picker beside the field." },
      { symptom: "\"Upload a PNG image for the platform logo and browser icon.\"", fix: "Export the logo as PNG; other formats are refused." },
      { symptom: "\"That PNG is larger than 4 MB. Export a smaller logo and try again.\"", fix: "Export a smaller PNG; a few hundred pixels square is plenty." },
      { symptom: "The sidebar text is hard to read.", fix: "Choose darker gradient colors, or clear both gradient fields to restore the default." },
      { symptom: "A phone still shows the old icon.", fix: "Icons are cached for a few minutes, and an installed app keeps its icon until it is removed and added to the home screen again." },
    ],
    scenes: [
      {
        title: "Open Platform Branding",
        caption: "Org Settings › Platform Branding: a live preview, the name, logo, icon, domain, and theme colors.",
        narration:
          "Open Platform console, then Org Settings, and expand Platform Branding. The preview at the top shows the logo, the platform name, and a sample of interface text, and it updates as you type. Nothing changes for anyone else until you choose Apply branding.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "brandPreview",
      },
      {
        title: "Name, logo, and domain",
        caption: "Platform name, Upload PNG for the logo and browser icon, and the Platform domain.",
        narration:
          "Enter the platform name your people will see. Choose Upload PNG and pick your logo; it fills both the logo and the browser icon, and the preview shows it straight away. The platform domain is recorded for administrators and the A P I. It does not change D N S or routing.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        focus: "brandFields",
      },
      {
        title: "A gradient needs both ends",
        caption: "Apply with only one gradient stop: \"Set both gradient colors (or clear both)…\"",
        narration:
          "Next, the theme colors. Here the accent, the gradient start, and the text color are set, but the gradient end is still empty, so Apply branding refuses with: set both gradient colors, or clear both.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "brandGradientError",
      },
      {
        title: "Theme colors",
        caption: "Accent, sidebar gradient start and end, and interface text. Empty keeps the default.",
        narration:
          "With the gradient end filled in, all four colors are set. The accent restyles buttons, switches, and links. The two gradient stops recolor the sidebar, so pick dark shades. The text color applies to the light theme. Choose Apply branding.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "brandThemeColors",
      },
      {
        title: "Applied everywhere",
        caption: "Saved for everyone: the sidebar now carries the new name, logo, and colors.",
        narration:
          "The branding is saved for the whole organization and survives a reload. The sidebar now shows the new name and logo on the new gradient, and every button uses the new accent.",
        durationSeconds: 13,
        calloutPlacement: "right-mid",
        focus: "brandApplied",
      },
      {
        title: "The sign-in page",
        caption: "Signed out, people see the new name and logo before they sign in.",
        narration:
          "Signed-out visitors see it too. The sign-in page shows the new logo and name, the accent color, and New to Example Corp Assistant under the form.",
        durationSeconds: 11,
        calloutPlacement: "right-mid",
        focus: "brandSignIn",
      },
      {
        title: "The installed app",
        caption: "The home-screen app icon now serves the uploaded logo, and the app takes the new name.",
        narration:
          "When someone adds the workspace to a phone's home screen, the app uses this icon, which now serves your logo, and the platform name as its label. Phones cache icons for a few minutes.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "brandAppIcon",
      },
      {
        title: "Back to the defaults",
        caption: "Reset defaults saves the Aperture Chat look immediately.",
        narration:
          "To undo everything, choose Reset defaults. It saves the default Aperture Chat name, logo, and colors immediately, so there is no separate Apply step.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "brandActions",
      },
    ],
  },
  {
    id: "search-index",
    audioSrc: "training/owner/search-index.mp3",
    title: "Review workspace search readiness",
    description: "Check that saved chats and drafts are searchable, rebuild the index when results are missing, and confirm what people can find.",
    icon: "audit",
    track: "Policies and branding",
    outcomes: [
      "The index status is read for each organization",
      "A rebuild completes with its entry count",
      "Search results respect each person's permissions",
    ],
    prerequisites: [
      "A platform owner account.",
      "A person's account to check search from, or a second browser signed in as one.",
    ],
    setupSteps: [
      "Open Platform console › Org Settings. Search index is the first panel.",
      "Read each organization's line: Ready or Backfilling, Indexed items, and Last rebuilt.",
      "If saved content is missing from search results, choose Rebuild index and wait for Rebuilt … index entries from live records.",
      "Ask a person to press Ctrl + K (⌘ + K on a Mac), or choose Search in the sidebar, and search for a word from one of their chats.",
      "Confirm their results come only from content they can open. Another person's private chat never appears.",
    ],
    paths: [
      {
        label: "Index disabled on this server",
        steps: [
          "The panel says The search index is disabled. Search still works by checking saved records directly.",
          "Rebuild index is greyed out; search still works, only more slowly on large workspaces.",
        ],
      },
    ],
    verify: [
      "The status reads Ready, with a current Last rebuilt time.",
      "The rebuild message reads Rebuilt … index entries from live records.",
      "A person's search lists their own chats, automations, and drafts that contain the word, and nothing private to anyone else.",
    ],
    troubleshooting: [
      { symptom: "Status shows Backfilling.", fix: "The index is still catching up, so results can be incomplete for a while. Wait, or choose Rebuild index." },
      { symptom: "\"The rebuild did not complete.\" or another error under the title.", fix: "Nothing was confirmed. Try again; if it repeats, check the server logs." },
      { symptom: "A deleted chat still appears in results.", fix: "Search checks every hit against the live record and drops deleted ones; refresh the search. A rebuild never restores deleted content." },
      { symptom: "A person cannot find a chat someone else owns.", fix: "That is expected: search shows only content the person has permission to open. Rebuilding does not change permissions." },
    ],
    scenes: [
      {
        title: "Search index status",
        caption: "Org Settings › Search index: Ready or Backfilling, Indexed items, and Last rebuilt.",
        narration:
          "Search lets people find saved chats and drafts with Control K, or Command K on a Mac. Its index status is the first panel in Org Settings. Each organization shows Ready or Backfilling, how many items are indexed, and when it was last rebuilt.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "searchIndex",
      },
      {
        title: "Rebuild from live records",
        caption: "Rebuild index reports Rebuilt … index entries from live records.",
        narration:
          "If people say saved content is missing from search, choose Rebuild index and wait for the result. Here it rebuilt thirty entries from live records, and Last rebuilt moved to now. A rebuild never changes who can see what, and never restores deleted work.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "searchRebuilt",
      },
      {
        title: "Check as a person",
        caption: "Ctrl + K: a person's results come from their own chats, automations, and drafts.",
        narration:
          "Now check from a person's side. They press Control K and search for vendor. Results come from their own chats, automations, and drafts, grouped by kind, with the matching text shown.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "searchUserResults",
      },
      {
        title: "Private stays private",
        caption: "Another person's private chat is indexed, but never appears in this person's results.",
        narration:
          "The owner has a private chat about Northwind. It is in the index, but this person's search finds nothing, because every result is checked against the live record and the person's permissions.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "searchUserPrivate",
      },
    ],
  },
  {
    id: "runtime-analytics",
    audioSrc: "training/owner/runtime-analytics.mp3",
    title: "Analytics: runtime, activity, and usage",
    description: "Scope each analytics section to a person and a date range, export it as CSV, open the conversation behind a feedback record, and read the activity and usage charts.",
    icon: "clock",
    track: "Monitoring and compliance",
    outcomes: [
      "Runtime events are scoped to one person and period, and exported as CSV",
      "A feedback rating is traced back to its conversation",
      "Model activity and per-person usage are read from the charts",
    ],
    prerequisites: [
      "A platform owner account.",
      "Some real activity in the workspace: chats, drafts, feedback, or API calls.",
    ],
    setupSteps: [
      "Open Platform console › Analytics. Four sections start collapsed: Runtime Clock Metadata, Chat Feedback, Model Activity, and User Usage.",
      "Expand a section. Each has its own filter: a person picker, From and Through dates, and the presets All, Today, Week, and 30 days. A filter changes only its own section.",
      "Runtime Clock Metadata: read the Runtime events, Chat, and Drafts totals, and the list of executions with who, which provider, and when.",
      "Choose CSV on a section, set the CSV date range (or All dates), and choose Download. The file name records the person and range.",
      "Chat Feedback: read the totals, then choose Preview on a rating or issue report to open the conversation or report behind it.",
      "Model Activity: Prompts by model, Prompt trend, and Users by prompt activity, for the section's filter.",
      "User Usage: Messages, Prompt tokens, Completion tokens, Total tokens, and Models used, then Messages by model, Message trend, and Usage by user. Pick a person in Usage by user to focus the section.",
    ],
    paths: [
      {
        label: "Export a section as CSV",
        steps: [
          "Runtime Clock Metadata, Chat Feedback, and User Usage each have CSV. The export uses its own date range, separate from the section's filter.",
          "Choose All dates or set From and Through, then Download. The button counts the rows it will export.",
          "Columns include the actor id and name, so the file can be filtered by person.",
        ],
      },
      {
        label: "Focus on one person",
        steps: [
          "Pick the person in the section's filter, or in User Usage › Usage by user.",
          "Totals, charts, and lists in that section all follow the choice; other sections do not change.",
        ],
      },
    ],
    verify: [
      "The filter line reads, for example, 52 of 119 records, and the totals change to match.",
      "The CSV downloads with one row per record and a header row (the runtime file starts id, actor_id, actor_name, surface…).",
      "Preview opens the rated conversation with the person's prompt and the saved model output.",
    ],
    troubleshooting: [
      { symptom: "A section shows fewer records than expected.", fix: "Check that section's own filter: person, dates, and preset. Choose All to clear it." },
      { symptom: "Token counts are blank.", fix: "Token counts are provider-reported only; a provider that reports none leaves them blank rather than guessed." },
      { symptom: "The CSV has a different number of rows from the list.", fix: "The CSV uses its own date range. Set it to match, or choose All dates." },
      { symptom: "Chat Feedback says ratings are recorded in this browser.", fix: "The platform API is not connected for feedback; server-side feedback loads when it is." },
    ],
    scenes: [
      {
        title: "Four sections",
        caption: "Platform console › Analytics: Runtime Clock Metadata, Chat Feedback, Model Activity, and User Usage.",
        narration:
          "Open Platform console, then Analytics. Four sections start collapsed: runtime clock metadata, chat feedback, model activity, and user usage. Expand only what you need.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "analyticsOverview",
      },
      {
        title: "Runtime Clock Metadata",
        caption: "Totals for runtime events, chat, and drafts, then each execution with who, which provider, and when.",
        narration:
          "Runtime Clock Metadata counts every chat and draft execution, using the time the server recorded. Below the totals, each row shows who ran it, which provider answered, and exactly when.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "runtimeScorecards",
      },
      {
        title: "Scope it to one person",
        caption: "Each section has its own filter: a person, From and Through, and All, Today, Week, or 30 days.",
        narration:
          "Every section has its own filter. Here it is set to Jane Smith and the last thirty days, so the line reads fifty two of one hundred nineteen records, and the totals follow. Other sections keep their own filters.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        focus: "analyticsFilters",
      },
      {
        title: "Export as CSV",
        caption: "CSV opens its own date range. Download exports the rows, with actor id and name on each.",
        narration:
          "Choose C S V. The export has its own date range, so choose All dates or set From and Through, then Download. The file carries the actor's I D and name on every row, and its name records the person and range.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "runtimeCsv",
      },
      {
        title: "Chat Feedback",
        caption: "Thumbs ratings, written notes, and platform issue reports, each with a Preview.",
        narration:
          "Chat Feedback collects thumbs up and down, written notes, and the platform issues people report from Help. Each item has a Preview.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "feedbackEvents",
      },
      {
        title: "Open the record behind a rating",
        caption: "Preview shows who rated it, the sentiment, the model, and the saved prompt and output.",
        narration:
          "Preview opens the record: who rated it, positive or negative, which model, and when, with the note and the exact exchange that was rated. It shows the saved text and does not run the model again.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "feedbackRecord",
      },
      {
        title: "Model Activity",
        caption: "Prompts by model, Prompt trend by day, and Users by prompt activity.",
        narration:
          "Model Activity charts saved prompts by model, the daily trend, and which people are most active, all for this section's filter.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        focus: "activityCharts",
      },
      {
        title: "User Usage",
        caption: "Messages, prompt and completion tokens, total tokens, and models used, from real completions.",
        narration:
          "User Usage is recorded from real completions in chat, drafts, agents, automations, and the A P I. It counts messages, prompt and completion tokens, and models used. Tokens are only what each provider reported.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "usageScorecards",
      },
      {
        title: "Focus on one person",
        caption: "Pick a person in Usage by user, and the whole section follows.",
        narration:
          "Pick a person in Usage by user, and the whole section focuses on them: their totals, their models, and their trend.",
        durationSeconds: 9,
        calloutPlacement: "left-rail",
        focus: "usageByUser",
      },
    ],
  },
  {
    id: "owner-audit",
    audioSrc: "training/owner/owner-audit.mp3",
    title: "Owner audit signals",
    description: "Triage what needs attention, open the records behind any number, read the Audit Insights trends, act on security alerts, and export the audit trail.",
    icon: "audit",
    track: "Monitoring and compliance",
    outcomes: [
      "Signals that need attention are opened and their records read",
      "A security alert is reviewed and acknowledged",
      "The audit trail is filtered and exported as CSV",
    ],
    prerequisites: ["A platform owner account."],
    setupSteps: [
      "Open Platform console › Audit. Owner Audit opens first, with a banner counting the signals that need attention.",
      "Read the four groups: Security signals, Identity & access, Providers & secrets, and Models, connectors & automations. Red rows need attention.",
      "Select any row to open an Audit investigation listing the exact records behind the number. Use Filter investigation records, then press Escape to close.",
      "In Audit Insights, choose 7 days, 14 days, or 30 days. Select any bar or point to open its records the same way.",
      "Expand Security Alerts. Review each redacted snippet and choose Acknowledge once it is handled, or Reopen to bring it back.",
      "Expand Audit Trail. Filter by severity and category, or search actions, people, and targets.",
      "Choose CSV, set the CSV date range (or All dates), and choose Download. The file contains exactly the rows that match your filters.",
    ],
    paths: [
      {
        label: "Layout choices",
        steps: [
          "Expand all or Collapse all opens or folds every signal group.",
          "List or Cards switches between compact rows and full cards. The choice is remembered in this browser.",
        ],
      },
      {
        label: "Charts in Audit Insights",
        steps: [
          "Audit events by day stacks info, warning, and critical events.",
          "Security alerts by day, and Alert breakdown By rule or By person.",
          "Most active people, Activity by area, and Activity by hour (hours outside 7 AM to 7 PM in your local time are shaded).",
        ],
      },
    ],
    verify: [
      "Each investigation's count matches the number on the signal or bar you selected.",
      "The acknowledged alert shows Acknowledged with a Reopen button, and the active count goes down by one.",
      "The audit CSV downloads with a header row (id, created_at, tenant_id, actor_id, actor_name, actor_role, action…) and one row per filtered event.",
    ],
    troubleshooting: [
      { symptom: "An investigation lists fewer records than expected.", fix: "It reflects the currently loaded audit range. Widen the Audit Insights range, or open the Audit Trail with its own dates." },
      { symptom: "The CSV is missing events you can see elsewhere.", fix: "The export follows the trail's filters and its own date range. Clear the severity or category filter, or choose All dates." },
      { symptom: "A security alert keeps reappearing.", fix: "Acknowledge marks one alert as handled; new prompts that trip the same detector raise new alerts. Use an alert rule to be emailed about them." },
    ],
    scenes: [
      {
        title: "What needs attention",
        caption: "Platform console › Audit: the banner counts signals that need attention, in four groups.",
        narration:
          "Open Platform console, then Audit. Owner Audit opens with a banner counting the signals that need attention, here eight of twenty four. Signals are grouped into security, identity and access, providers and secrets, and models, connectors, and automations. Red rows need a look.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "auditSignalBoard",
      },
      {
        title: "Every number opens its records",
        caption: "Select a signal row: Audit investigation lists the exact records behind it.",
        narration:
          "Select any row to see the records behind its number. Critical events opens an audit investigation with all twelve, newest first, and a filter box to narrow them by person, status, or model. Press Escape to return.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "auditInvestigation",
      },
      {
        title: "Audit Insights trends",
        caption: "Choose 7, 14, or 30 days. Audit events by day stacks info, warning, and critical.",
        narration:
          "Below the signals, Audit Insights charts the trends. Choose seven, fourteen, or thirty days. Audit events by day stacks info, warning, and critical events, and the charts below break security alerts down by day, by rule, or by person.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "auditInsightsTrends",
      },
      {
        title: "Who, what, and when",
        caption: "Most active people, Activity by area, and Activity by hour, with after-hours shaded.",
        narration:
          "Most active people ranks who is acting, Activity by area shows which parts of the platform are changing, and Activity by hour shades the hours outside seven in the morning to seven in the evening, so after-hours work stands out.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "auditInsightsPeople",
      },
      {
        title: "Drill into a chart",
        caption: "Select a bar or point to list its records, grouped by severity.",
        narration:
          "Charts work the same way. Selecting the bar for one day lists every event recorded that day, grouped into critical, warning, and info.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        focus: "auditChartRecords",
      },
      {
        title: "Security alerts",
        caption: "Expand Security Alerts: detector, person, model, time, and a redacted snippet.",
        narration:
          "Expand Security Alerts. Each alert names the detector, the person, the model, and the time, with a redacted snippet, so the sensitive value itself is never shown again. The count shows how many are active and how many are acknowledged.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "auditSecurityAlerts",
      },
      {
        title: "Acknowledge after review",
        caption: "Acknowledge marks an alert handled; Reopen brings it back.",
        narration:
          "Once an alert is handled, choose Acknowledge. It moves to acknowledged, the active count drops, and Reopen brings it back if you need to look again.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "auditAlertAcknowledged",
      },
      {
        title: "Filter the audit trail",
        caption: "Audit Trail: severity, category, and search on top of the section's own person and date filter.",
        narration:
          "Expand Audit Trail, the append-only log of every change. Filter by severity and category, or search actions, people, and targets. Here, warning events only: fifty four of five hundred forty one.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        focus: "trailFilters",
      },
      {
        title: "Export what you see",
        caption: "CSV › Download exports exactly the filtered rows, with actor id, name, and role on each.",
        narration:
          "Choose C S V, set the date range or keep all dates, and choose Download. The file contains exactly the rows that match your filters, with the actor's I D, name, and role on every event.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "trailExport",
      },
    ],
  },
  {
    id: "owner-alerts",
    audioSrc: "training/owner/owner-alerts.mp3",
    title: "Alerts and email delivery",
    description: "Connect a real SMTP relay, send a test email, create an alert rule, and confirm a real alert email arrives when the rule fires.",
    icon: "alerts",
    track: "Monitoring and compliance",
    outcomes: [
      "SMTP settings are saved and a test email is delivered",
      "A rule watches the right events and emails the right people",
      "A real alert is delivered and its status reads sent",
    ],
    prerequisites: [
      "A platform owner account.",
      "An SMTP relay your server can reach: Microsoft 365, Google Workspace, SendGrid, Amazon SES, or your own, with a username and password or app password.",
      "A from address the relay allows you to send as, and a mailbox that receives the alerts (for example a security team list).",
    ],
    setupSteps: [
      "Open Platform console › Alerts. Email Delivery is at the top.",
      "Enter the SMTP host, Port, and Security (STARTTLS on 587, or SSL/TLS on 465), the Username, the Password, and the From address.",
      "Choose Save Email Settings and wait for SMTP settings saved. The password is stored in the encrypted vault and never shown again.",
      "Enter a recipient beside Send test email and choose it. Read the result: Test email sent to … or the relay's exact error.",
      "In Alert Rules, choose Prompt-injection template, Suspicious-activity template, or New rule.",
      "Review the action patterns, Minimum severity, Watched user, Fire when threshold, and Cooldown. Name the rule and enter the Email recipients, separated by commas.",
      "Under Only these detections, keep the detectors this rule should watch. Choose Create Rule.",
      "When a matching event happens, Alert Deliveries lists it as queued, then sent (or failed with the SMTP error). The email names the detection but never includes the flagged text.",
    ],
    paths: [
      {
        label: "Microsoft 365 / Exchange Online",
        steps: [
          "Host smtp.office365.com, Port 587, Security STARTTLS. Username and From address: a licensed mailbox (or one the account can Send As).",
          "Turn on Authenticated SMTP for that mailbox: Microsoft 365 admin center › Users › Active users › the user › Mail › Manage email apps.",
          "Microsoft turns basic authentication for SMTP off by default at the end of December 2026. Plan to use another relay, or confirm with your Microsoft 365 administrator.",
        ],
      },
      {
        label: "Google Workspace or Gmail",
        steps: [
          "Host smtp.gmail.com, Port 587, Security STARTTLS (or 465 with SSL/TLS).",
          "Username: the full address. Password: an app password from myaccount.google.com/apppasswords (2-Step Verification required).",
          "Alternative: the Workspace SMTP relay, smtp-relay.gmail.com, configured in Admin console › Apps › Google Workspace › Gmail › Routing.",
        ],
      },
      {
        label: "SendGrid",
        steps: [
          "Host smtp.sendgrid.net, Port 587, Security STARTTLS.",
          "Username: the word apikey. Password: a SendGrid API key with Mail Send permission.",
          "From address: a verified sender or authenticated domain (Settings › Sender Authentication).",
        ],
      },
      {
        label: "Amazon SES",
        steps: [
          "Host email-smtp.<region>.amazonaws.com, Port 587 with STARTTLS (or 465 with SSL/TLS).",
          "Username and Password: SMTP credentials from SES › SMTP settings › Create SMTP credentials (not AWS access keys).",
          "From address: a verified identity. In the SES sandbox, recipients must be verified too.",
        ],
      },
      {
        label: "Your own relay (shown in the video)",
        steps: [
          "Host and Port of your relay, with STARTTLS or SSL/TLS. Its certificate must be valid for that host name and trusted by the server; a self-signed certificate is refused.",
          "Username, Password, and a From address the relay accepts.",
        ],
      },
      {
        label: "Rule templates",
        steps: [
          "Prompt-injection template: security.prompt_flagged events from the prompt-injection, system-prompt-extraction, and credential-extraction detectors, at warning and above.",
          "Suspicious-activity template: security flags and elevated-severity events.",
          "New rule: start from scratch. Leave Email recipients empty to log alerts in-app only.",
        ],
      },
    ],
    verify: [
      "Send test email shows Test email sent to …, and Last test reads sent.",
      "The new rule is listed as platform and enabled, with its detectors and recipient count.",
      "Alert Deliveries lists the rule with sent and the recipient, and the email arrives in the recipient's inbox.",
    ],
    troubleshooting: [
      { symptom: "\"(535, b'5.7.8 Authentication credentials invalid')\" or another 535 reply", fix: "The relay rejected the username or password. Re-enter the password (or app password) and choose Save Email Settings before testing again." },
      { symptom: "Send test email is greyed out and Unsaved changes. Save them before sending a test. appears", fix: "The test uses the saved settings. Choose Save Email Settings first." },
      { symptom: "\"Email delivery is not configured. Set the SMTP host and from address first.\"", fix: "Enter the SMTP host and From address and save." },
      { symptom: "A certificate verify failed error", fix: "The relay's certificate is not trusted or does not match the host name. Use the provider's official host name, or install a valid certificate on your relay." },
      { symptom: "A delivery shows email not configured or logged in-app", fix: "SMTP was not configured when the alert fired, or the rule has no recipients. Configure SMTP and add recipients; later alerts are emailed." },
      { symptom: "A delivery stays failed", fix: "Read the SMTP error on the row. Failed sends are retried with growing delays; fix the relay settings and the next retry uses them." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "An SMTP relay and its credentials, a from address, and a mailbox for the alerts.",
        narration:
          "This lesson connects alert email to a real mail relay, then proves it twice: with a test email, and with a real alert. Before you begin, have your relay's host, port, username, and password, a from address it allows, and a mailbox for the alerts, such as your security team's list.",
        durationSeconds: 19,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "Your relay's host and port, and whether it uses STARTTLS or SSL/TLS.",
            "The relay username and password (or app password or API key).",
            "A from address the relay lets you send as.",
            "A mailbox that receives the alerts.",
          ],
        },
      },
      {
        title: "Email Delivery",
        caption: "Platform console › Alerts › Email Delivery: host, port, security, username, password, and from address.",
        narration:
          "Open Platform console, then Alerts. Email Delivery holds the relay settings. Until it is filled in, alerts are only logged inside Aperture Chat.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "alertSmtp",
      },
      {
        title: "Common relay settings",
        caption: "Microsoft 365, Google Workspace, SendGrid, and Amazon SES all use STARTTLS on port 587.",
        narration:
          "Most providers use STARTTLS on port five eight seven. Microsoft 365 uses smtp dot office 365 dot com with a mailbox and Authenticated SMTP turned on. Gmail uses smtp dot gmail dot com with an app password. SendGrid uses the username a p i key and an A P I key as the password. Amazon S E S uses its own SMTP credentials, not your A W S keys.",
        durationSeconds: 31,
        card: {
          where: "Your email provider",
          steps: [
            "Microsoft 365: smtp.office365.com, 587, STARTTLS; a mailbox with Authenticated SMTP turned on.",
            "Google: smtp.gmail.com, 587, STARTTLS; the full address and an app password.",
            "SendGrid: smtp.sendgrid.net, 587, STARTTLS; username apikey, password an API key with Mail Send.",
            "Amazon SES: email-smtp.<region>.amazonaws.com, 587, STARTTLS; SMTP credentials from SES › SMTP settings.",
            "Your own relay: its host and port, with a certificate valid for that host.",
          ],
        },
      },
      {
        title: "Fill in your relay",
        caption: "Here a local test relay stands in for your provider: host, port 8033, STARTTLS, username, and from address.",
        narration:
          "Fill in your relay's details. In this recording, a local test relay stands in for your provider, so the host is localhost on port eighty thirty three, with STARTTLS. Enter the username and the from address, then the password last.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "alertSmtpFilled",
      },
      {
        title: "A real refusal",
        caption: "With a wrong password, the relay answers 535: Authentication credentials invalid.",
        narration:
          "Choose Save Email Settings, enter a recipient, and choose Send test email. This first try used a wrong password, so the relay refused it, and the result shows the relay's exact answer: five three five, authentication credentials invalid.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "alertTestFailed",
      },
      {
        title: "Test email sent",
        caption: "With the right password saved, Send test email reports Test email sent and Last test: sent.",
        narration:
          "With the correct password saved, the test goes through: test email sent to the security team, and Last test reads sent. The relay received it over an encrypted, authenticated connection.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "alertTestSent",
      },
      {
        title: "Start a rule from a template",
        caption: "Alert Rules: Prompt-injection template, Suspicious-activity template, or New rule.",
        narration:
          "Now decide what should send email. In Alert Rules, the Prompt-injection template watches attempts to override instructions or extract hidden prompts and credentials. The Suspicious-activity template watches security flags and higher-severity events. New rule starts from scratch.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        focus: "alertTemplates",
      },
      {
        title: "Shape the rule",
        caption: "Name, patterns, minimum severity, threshold, cooldown, recipients, and Only these detections.",
        narration:
          "The template fills in the action pattern, warning severity, one match within sixty minutes, and a ten minute cooldown. Name the rule and enter the email recipients. Under Only these detections, keep the detectors this rule should watch. Choose Create Rule.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        captionPlacement: "bottom",
        focus: "alertRuleForm",
      },
      {
        title: "The rule is live",
        caption: "The new rule is listed as platform and enabled, with its detectors and one recipient.",
        narration:
          "The rule appears in the list, marked platform and enabled, with the detectors it watches and one recipient.",
        durationSeconds: 9,
        calloutPlacement: "left-rail",
        focus: "alertRuleCreated",
      },
      {
        title: "Something trips the rule",
        caption: "A person asks the model to ignore its instructions and print its system prompt.",
        narration:
          "Here, a person asks the model to ignore its instructions and print its system prompt. The model declines, and the prompt scan flags the attempt as a security event, which the new rule is watching.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "alertUserFlagged",
      },
      {
        title: "Delivered",
        caption: "Alert Deliveries: the rule fired and its email was sent to the security team.",
        narration:
          "Back in Alerts, the delivery is listed under the rule's name with the status sent and the recipient. Statuses are real: queued, sent, failed with the S M T P error, email not configured, or logged in-app. Archive clears a delivery from the list without deleting its history.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        focus: "alertDeliveries",
      },
      {
        title: "In the recipient's inbox",
        caption: "The email names the rule, the detection, who, and when, but never the flagged text.",
        narration:
          "In the recipient's inbox, the email's subject names the rule and the detection. The body says who, when, and on which model, and points to Audit, Security Alerts, to review the redacted snippet. The flagged text itself is never included.",
        durationSeconds: 17,
        card: {
          where: "The recipient's inbox",
          steps: [
            "Subject: the rule name and the detection.",
            "What happened, the event and severity, who, and when.",
            "The flagged text is not included.",
            "Review it in Platform console › Audit › Security Alerts, then acknowledge it there.",
          ],
          values: [
            { label: "From", value: "alerts@example.test" },
            { label: "Subject", value: "[Aperture Chat alert] Prompt injection to security team: Prompt-injection attempt" },
          ],
        },
      },
    ],
  },
  {
    id: "elastic-analytics",
    audioSrc: "training/owner/elastic-analytics.mp3",
    title: "Elastic Analytics export",
    description: "Send Aperture Chat's audit trail, usage, chats, documents, and users to Elastic Cloud or your own Elasticsearch, and search them in Kibana.",
    icon: "elastic",
    track: "Monitoring and compliance",
    outcomes: [
      "The cluster connection is saved and every check passes",
      "The chosen data is delivered and counted per index",
      "Kibana has the Aperture data views and shows the exported records",
    ],
    prerequisites: [
      "A platform owner account.",
      "An Elasticsearch cluster: an Elastic Cloud deployment (its Cloud ID or endpoint) or a self-managed cluster the server can reach.",
      "Permission to create an API key in that cluster (Kibana Dev Tools or Stack Management › API keys).",
      "Kibana access with permission to import saved objects.",
    ],
    setupSteps: [
      "Open Platform console › Org Settings and expand Elastic Analytics. Read the status line at the top.",
      "Paste the Elasticsearch endpoint (for example https://your-cluster.example:9200) or your Elastic Cloud deployment's Cloud ID.",
      "Open How do I create an API key?, choose Copy request, and run it in Kibana Dev Tools. Copy the response's encoded value.",
      "Paste the key into API key, and keep or change the Index prefix (aperture by default).",
      "Under What to send, turn each stream on or off: Audit trail, Model usage, Chats, Documents, and Users. Leave Include message and document text off unless you need the text in Elastic.",
      "Choose Save and check. Every check must pass: Reach the cluster, API key accepted, Cluster details, and Can write Aperture indices.",
      "Choose Sync now. The Delivery table shows Sent counts and Last sent for each index.",
      "Choose Kibana data views, then in Kibana open Stack Management › Saved objects › Import, choose the downloaded file, and Import.",
      "Open Discover, pick an Aperture data view, and widen the time range to see the records.",
    ],
    paths: [
      {
        label: "Elastic Cloud (Cloud ID)",
        steps: [
          "In the Elastic Cloud console, open your deployment and copy its Cloud ID (or the Elasticsearch endpoint).",
          "Create the API key in Kibana: Dev Tools with the panel's request, or Stack Management › API keys with the same privileges.",
          "Paste the Cloud ID and key into Elastic Analytics, then Save and check.",
        ],
      },
      {
        label: "Self-managed Elasticsearch (shown in the video)",
        steps: [
          "Use the cluster's HTTP address, usually port 9200, reachable from the Aperture Chat server.",
          "Run the panel's API key request in Kibana Dev Tools (or with curl as a user who can manage API keys).",
          "Paste the endpoint and key, then Save and check.",
        ],
      },
      {
        label: "Pause, resume, or resend",
        steps: [
          "Export on pauses or resumes delivery without losing settings.",
          "Re-send everything sends all history again, for example after switching clusters.",
          "Check connection tests the form as typed, without saving it.",
        ],
      },
    ],
    verify: [
      "Save and check shows Saved and verified, and all four checks are green.",
      "The Delivery table shows 0 waiting, a Sent count, and Last sent for each stream.",
      "Kibana's import reports the Aperture data views imported, and Discover lists the exported records, including the Elastic changes you just made.",
    ],
    troubleshooting: [
      { symptom: "Delivery failing: \"Could not connect to …: [Errno 61] Connection refused.\"", fix: "Nothing answered at that address and port. Self-managed Elasticsearch usually listens on 9200; Elastic Cloud uses 443." },
      { symptom: "\"Could not connect to …: [Errno 8] nodename nor servname provided, or not known.\" after a Cloud ID", fix: "The Cloud ID does not point to a reachable deployment. Copy it again from the deployment's page in the Elastic Cloud console." },
      { symptom: "API key accepted fails", fix: "Paste the encoded value from the API key response (or the whole response), not the key id." },
      { symptom: "Can write Aperture indices fails", fix: "Recreate the key with the panel's request: create_index, index, and read on aperture-* (or your prefix), plus monitor." },
      { symptom: "Sync now is greyed out.", fix: "Save your changes first, and make sure Export on is turned on." },
      { symptom: "Discover shows no results.", fix: "Widen the time range; Discover starts at the last 15 minutes. Check the Delivery table for errors." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "An Elasticsearch cluster, permission to create an API key, and Kibana access.",
        narration:
          "This lesson connects Aperture Chat to Elastic and follows the data all the way into Kibana. Before you begin, have an Elastic Cloud deployment or your own Elasticsearch cluster, permission to create an A P I key there, and access to Kibana.",
        durationSeconds: 17,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "An Elastic Cloud deployment's Cloud ID, or your cluster's HTTP address.",
            "Permission to create an API key (Kibana Dev Tools or Stack Management › API keys).",
            "Kibana access that can import saved objects.",
          ],
        },
      },
      {
        title: "Read the status first",
        caption: "Org Settings › Elastic Analytics. Here an old address fails: Delivery failing, Connection refused.",
        narration:
          "Open Org Settings and expand Elastic Analytics. The status line tells you where things stand. This workspace still points at an old cluster that is not running, so it says Delivery failing, with the exact connection error.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "elasticStatus",
      },
      {
        title: "Elastic Cloud: the Cloud ID",
        caption: "Elastic Cloud console › your deployment: copy the Cloud ID or the Elasticsearch endpoint.",
        narration:
          "For Elastic Cloud, open your deployment in the Elastic Cloud console and copy its Cloud I D, or its Elasticsearch endpoint. Either one goes in the same field.",
        durationSeconds: 12,
        card: {
          where: "Elastic Cloud console",
          steps: [
            "Open Hosted deployments and select your deployment.",
            "Copy the Cloud ID from the deployment page.",
            "Or, under Application endpoints, copy the Elasticsearch endpoint.",
          ],
          values: [{ label: "Cloud ID looks like", value: "deployment-name:dXMtZWFzdC0x…" }],
        },
      },
      {
        title: "Check before saving",
        caption: "Check connection tests what is typed, without saving. This Cloud ID points to no real deployment.",
        narration:
          "Paste the Cloud I D and choose Check connection. It tests what you typed without saving anything. This one was made up, so Aperture Chat decoded it into a host name that does not exist, and the check says exactly that.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "elasticCloudCheck",
      },
      {
        title: "Create the API key",
        caption: "How do I create an API key? shows the exact request. Copy request, then run it in Kibana Dev Tools.",
        narration:
          "For the key, open How do I create an A P I key. It shows the exact request, with create index, index, and read on the Aperture indices, plus cluster monitor. Choose Copy request, run it in Kibana Dev Tools, and copy the encoded value from the response.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "elasticKeyHelp",
      },
      {
        title: "Self-managed: endpoint and key",
        caption: "Your cluster's address, the encoded API key, and the index prefix.",
        narration:
          "For your own cluster, enter its H T T P address, here a local test cluster on port ninety two seventeen. Paste the encoded key into A P I key, and keep the index prefix aperture unless you need another.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "elasticConnection",
      },
      {
        title: "Save and check",
        caption: "Saved and verified: reach the cluster, key accepted, cluster details, and write access all pass.",
        narration:
          "Choose Save and check. Each step is reported on its own: the cluster answered, the key was accepted, the cluster's name and version, and that the key can write the Aperture indices. All four passed. The old errors below clear at the next delivery.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "elasticChecks",
      },
      {
        title: "Choose what to send",
        caption: "Audit trail, model usage, chats, documents, and users. Message text stays out unless you include it.",
        narration:
          "Under What to send, each kind of data has its own switch and names its index. Message and document text stays in Aperture Chat unless you turn on Include message and document text. Export on pauses or resumes everything.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "elasticStreams",
      },
      {
        title: "Sync and read the delivery",
        caption: "Sync now sends the queue at once. Each index shows waiting, sent, and last sent.",
        narration:
          "Choose Sync now to send the queue immediately; otherwise it goes out about every thirty seconds. The Delivery table now shows nothing waiting, how many records each index received, and when. Then choose Kibana data views to download ready-made data views.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "elasticDelivery",
      },
      {
        title: "Import into Kibana",
        caption: "Kibana › Stack Management › Saved objects › Import: choose the downloaded file.",
        narration:
          "In Kibana, open Stack Management, then Saved objects, and choose Import. Select the downloaded file, keep Check for existing objects, and choose Import.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "kibanaImport",
      },
      {
        title: "Data views imported",
        caption: "One data view per Aperture index, plus Aperture: everything.",
        narration:
          "Kibana imported seven data views: one for each Aperture index, and Aperture everything, which covers them all.",
        durationSeconds: 9,
        calloutPlacement: "left-rail",
        focus: "kibanaImported",
      },
      {
        title: "Search it in Discover",
        caption: "Discover › Aperture: audit trail, last 30 days. The Elastic changes you just made are already there.",
        narration:
          "Open Discover, pick Aperture audit trail, and widen the time range. The records are already here, including the Elastic changes you just made: the failed check, the saved settings, the passed test, and the sync.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "kibanaDiscover",
      },
    ],
  },
  {
    id: "owner-retention",
    audioSrc: "training/owner/owner-retention.mp3",
    title: "Data retention and tagging",
    description: "Keep chats forever or preview a time limit safely, label a client's or matter's chats, and protect them with a legal hold.",
    icon: "retention",
    track: "Monitoring and compliance",
    outcomes: [
      "The effect of a time limit is previewed before anything is saved",
      "A client or matter source labels the right chats after review",
      "A legal hold protects the selected chats from deletion",
    ],
    prerequisites: [
      "A platform owner account (administrators have the same panel in the Admin console).",
      "Your organization's retention requirements, and the client or matter names and aliases people use in chats.",
      "Approval from whoever owns records policy before you save any time limit.",
    ],
    setupSteps: [
      "Open Platform console › Audit and expand Data Retention, below Recent Governance Activity.",
      "Schedule and rules: Keep chats for starts at Forever, and Automatic deletion off. Forever never deletes anything.",
      "Under Clients, matters, and regulated records, choose the Source type, enter the Name or reference and its Aliases, separated by commas, and choose Add source to policy.",
      "To consider a time limit, choose 1, 5, 7, or 10 years and choose Preview effect. Read how many chats are old enough, on legal hold, or without a deadline. Do not save until it is approved.",
      "Choose Forever again and Save Forever to keep the new source without any deletion.",
      "Tags and holds: choose Scan existing chats, search for the source, select the right chats, choose the label in Choose a label, and Confirm label.",
      "Expand Legal holds, enter a Hold name, and choose Hold selected chats.",
      "Select a chat's title to preview its conversation before deciding anything.",
    ],
    paths: [
      {
        label: "Keep everything (Forever, the default)",
        steps: [
          "Keep chats for: Forever. Choose Save Forever.",
          "Sources and labels still work, so chats stay identifiable for later policies or holds.",
        ],
      },
      {
        label: "A time limit (after approval)",
        steps: [
          "Choose 1, 5, 7, or 10 years, Count age from (Last message change or Chat creation), and a Review window of at least 7 days.",
          "Choose Preview effect and record the counts.",
          "Only then choose Save retention policy. Eligible chats enter the review window before automatic deletion, and changing the policy restarts that window.",
          "Longer matching rules and legal holds always win. Increasing the duration never restores deleted chats.",
        ],
      },
      {
        label: "Per-source rules",
        steps: [
          "Each source has a Retention rule. Use default schedule, or set a longer or shorter period for that client or matter.",
          "Apply time limits only to labels with a rule leaves unlabeled chats untouched.",
        ],
      },
    ],
    verify: [
      "Preview effect shows Effect on … saved chats with the old enough, on legal hold, and without a deletion deadline counts.",
      "After Save Forever, the message reads Forever saved. Automatic deletion is off for all chats.",
      "The labeled chat shows the source's label, and the held chat shows Legal hold.",
      "A second preview counts the held chat under on legal hold.",
    ],
    troubleshooting: [
      { symptom: "\"Aliases must be 3–160 characters long.\"", fix: "Make each alias at least three characters, and separate aliases with commas." },
      { symptom: "Scan existing chats finds nothing.", fix: "Sources match saved message text and titles. Add the names and aliases people actually type, then scan again." },
      { symptom: "Hold selected chats is greyed out.", fix: "Select at least one chat and enter a Hold name." },
      { symptom: "A chat you expected to delete was skipped.", fix: "Legal holds and longer matching rules always win. Release the hold first; releasing gives eligible chats a new review window." },
    ],
    scenes: [
      {
        title: "Find Data Retention",
        caption: "Platform console › Audit › Data Retention, below Recent Governance Activity.",
        narration:
          "Retention lives with the audit tools. Open Platform console, then Audit, and expand Data Retention, below Recent Governance Activity.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "retentionEntry",
      },
      {
        title: "Forever is the default",
        caption: "Schedule and rules › Keep chats for: Forever, with automatic deletion off.",
        narration:
          "Schedule and rules opens on the chat retention schedule. Keep chats for is set to Forever, and the status says Automatic deletion off. Forever never deletes anything; the slider offers one, five, seven, and ten years when you are ready.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "retentionSchedule",
      },
      {
        title: "Add a client or matter",
        caption: "Source type, Name or reference, and Aliases, then Add source to policy.",
        narration:
          "Add a source for each client, matter, or regulated record category. Here, a matter named vendor onboarding review, with the aliases people actually type. Each source gets its own retention rule, and sensitive data such as card numbers can be suggested too.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "retentionSource",
      },
      {
        title: "Preview a time limit",
        caption: "7 years › Preview effect: counts only. Nothing is saved, and nothing is deleted.",
        narration:
          "Choose seven years and Preview effect. It counts the saved chats this draft would affect: how many are old enough, how many are on legal hold, and how many have no deadline. This is only a preview. Save retention policy is never chosen in this lesson, so nothing becomes eligible for deletion.",
        durationSeconds: 21,
        calloutPlacement: "left-rail",
        focus: "retentionPreviewFinite",
      },
      {
        title: "Keep Forever, save the source",
        caption: "Forever › Save Forever: the new source is saved, and automatic deletion stays off.",
        narration:
          "Return to Forever and choose Save Forever. The new source is saved, and the message confirms that automatic deletion is off for all chats.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "retentionForeverSaved",
      },
      {
        title: "Scan existing chats",
        caption: "Tags and holds › Scan existing chats: suggestions for the new matter, and no chats deleted.",
        narration:
          "Switch to Tags and holds and choose Scan existing chats. It reviewed eleven saved chats and made three suggestions, and it says plainly that no chats were deleted. Suggestions are not authoritative until you confirm them.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "retentionScan",
      },
      {
        title: "Confirm the right chats",
        caption: "Select the chat, choose the label, and Confirm label.",
        narration:
          "Select only the chats that really belong to the matter, choose its label in Choose a label, and choose Confirm label. Here one chat is confirmed; the other suggestions stay suggestions until you decide.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "retentionConfirmed",
      },
      {
        title: "Place a legal hold",
        caption: "Legal holds › Hold name › Hold selected chats. The chat now shows Legal hold.",
        narration:
          "To preserve the chat whatever the schedule says, expand Legal holds, enter a hold name, and choose Hold selected chats. The row now shows Legal hold, and the chat is protected from both automatic and manual deletion until the hold is released.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "retentionHold",
      },
      {
        title: "Read the conversation",
        caption: "Select a chat title to preview its saved prompts and responses.",
        narration:
          "Before deciding anything about a chat, select its title to read the saved conversation. The preview shows the saved text only and does not run the model again.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "retentionConversation",
      },
      {
        title: "The hold is counted",
        caption: "The same seven-year preview now counts one chat on legal hold. Still not saved.",
        narration:
          "Preview seven years again, and the held chat is counted under on legal hold. Holds and longer rules always win over the schedule. When your organization approves a time limit, preview it, record these counts, and only then save it.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "retentionPreviewHeld",
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
  elastic: BarChart3,
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
      description="Narrated walkthroughs of the current console: first-run setup, providers, keys, models, roles, SSO, policies and budgets, connectors, branding, search, analytics, audit, alerts, Elastic export, and retention."
      backTooltip="Return to the full list of training videos"
      headerLinks={headerLinks}
      onClose={onClose}
    />
  );
}
