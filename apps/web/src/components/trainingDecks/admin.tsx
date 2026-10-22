import { BarChart3, BellRing, Database, DatabaseZap, Inbox, Lock, Mail, Plug, ShieldCheck, SlidersHorizontal, UserPlus, Users, Wrench } from "lucide-react";
import { TrainingDocumentationModal, type TrainingDeck } from "../TrainingVideoLibrary";
import type { FocusRegion, TrainingVideoBase } from "../trainingVideoKit";

/* Every frame is a real capture of an isolated synthetic instance, made by the
 * complete walkthrough modules scripts/walkthroughs/admin-*.cjs (run with
 * scripts/capture-walkthroughs.cjs). Each module performs its task from the
 * first click to the verified result; rects are measured from the live DOM at
 * capture time and imported with apply-training-focus.cjs. */

export type AdminFocus =
  | "accessRequestForm"
  | "accessRequestSent"
  | "accessRequestsQueue"
  | "accessApproveAs"
  | "accessSignInHandoff"
  | "accessTemporaryPassword"
  | "accessPasswordSet"
  | "accessDeclined"
  | "accessForcedPassword"
  | "accessFirstWelcome"
  | "accessFirstReply"
  | "accessDeclinedSignin"
  | "accessSsoHandoff"
  | "accessSsoSignin"
  | "accessSsoWelcome"
  | "accessSsoRow"
  | "usersTabs"
  | "usersAddForm"
  | "usersCreatedRow"
  | "usersPasswordDialog"
  | "usersLocalRow"
  | "usersRoleCell"
  | "usersRowActions"
  | "usersBulkSelect"
  | "usersBulkDone"
  | "usersGroupFilter"
  | "usersTraceBlocked"
  | "usersDeletedToast"
  | "groupsCards"
  | "groupsAddForm"
  | "groupsNewCard"
  | "groupsMemberRow"
  | "groupsImport"
  | "groupsImportResult"
  | "groupsPermGrid"
  | "groupsKnowledgeRow"
  | "groupsDefaultSummary"
  | "groupsVerifyTable"
  | "maCatalog"
  | "maGroupEditor"
  | "maTraceBlocked"
  | "maGroupGranted"
  | "maTraceUsable"
  | "maHiddenRow"
  | "maRefused"
  | "maFiltered"
  | "mrUserDialog"
  | "mrUserRequested"
  | "mrQueue"
  | "mrGroupChoice"
  | "mrApproved"
  | "mrDeclined"
  | "mrUserAfter"
  | "mrTrace"
  | "ssoReadonlyEmpty"
  | "ssoPolicyAvailable"
  | "ssoPresetEntra"
  | "ssoPresetOkta"
  | "ssoPresetGoogle"
  | "ssoFields"
  | "ssoCreate"
  | "ssoCard"
  | "ssoTestResult"
  | "ssoSignin"
  | "ssoIdpLogin"
  | "ssoWelcome"
  | "ssoJitRow"
  | "ssoMappings"
  | "ssoSyncedRow"
  | "ssoEnforceRow"
  | "ssoRefused"
  | "ssoReadonlyCard"
  | "policyCollapsed"
  | "policyServiceAvailability"
  | "policyDefaults"
  | "polKnowledgeRow"
  | "polVerifyRow"
  | "policyMemory"
  | "polRetentionField"
  | "polPurgeConfirm"
  | "policyCounts"
  | "polMemoryOff"
  | "responseOverview"
  | "toolsBuilder"
  | "toolsScript"
  | "toolsGroups"
  | "toolsTestResult"
  | "toolsSavedRow"
  | "toolsUserButton"
  | "toolsUserResult"
  | "toolsEdit"
  | "toolsDraftRow"
  | "toolsLibrary"
  | "toolsSignIn"
  | "cnPanel"
  | "cnWebOn"
  | "cnWebTested"
  | "cnWebSearxng"
  | "cnWebKeyed"
  | "cnDriveForm"
  | "cnDriveTested"
  | "cnGraphForm"
  | "cnGraphTested"
  | "cnBoxTested"
  | "cnImanageTested"
  | "cnUserAttach"
  | "cnBoxHidden"
  | "cnUserAttachHidden"
  | "cnBoxShown"
  | "cnOffForAll"
  | "anSections"
  | "anFilters"
  | "anCsv"
  | "anActivity"
  | "anUsageCards"
  | "anBudget"
  | "anAllocationForm"
  | "anAllocationTable"
  | "anCapHit"
  | "auSignals"
  | "auSignalRecords"
  | "auInsights"
  | "auChartRecords"
  | "auPromptRecord"
  | "auAlertAck"
  | "auTrailFilters"
  | "alEmail"
  | "alRuleForm"
  | "alRuleDetections"
  | "alRuleRow"
  | "alFlaggedChat"
  | "alDeliverySent"
  | "alArchived"
  | "alSupportTemplate"
  | "retNavigation"
  | "retForever"
  | "retSourceForm"
  | "retSourceRow"
  | "retScan"
  | "retConfirm"
  | "retConversation"
  | "retHold"
  | "retPreview"
  | "retDeleteConfirm"
  | "fbUserRate"
  | "fbUserReport"
  | "fbOverview"
  | "feedbackConversation"
  | "fbIssues"
  | "feedbackIssueReport"
  | "fbReports"
  | "rpUserHelp"
  | "rpUserForm"
  | "rpUserSecurity"
  | "rpUserSent"
  | "rpQueue"
  | "rpSearch"
  | "rpTicket"
  | "rpTriage"
  | "rpInternal"
  | "rpReply"
  | "rpUserReply"
  | "rpNeedsReply"
  | "rpResolved"
  | "rpUserResolved"
  | "rpAudit"
  | "pdpFind"
  | "pdpToggles"
  | "pdpCategories"
  | "pdpPreview"
  | "pdpCoverage"
  | "pdpChatPrompt"
  | "pdpChatReply"
  | "pdpActivity"
  | "pdpAuditTrail"
  | "pdpModelRow"
  | "pdpOutput"
  | "pdpOffRow"
  | "pdpStillConcealed"
  | "dsCapture"
  | "dsSignals"
  | "dsSafeguards"
  | "dsExcluded"
  | "dsScan"
  | "dsUserCorrection"
  | "dsUserNote"
  | "dsOverview"
  | "dsMix"
  | "dsSuggestions"
  | "dsEditorFormat"
  | "dsEditorRules"
  | "dsCard"
  | "dsExample"
  | "dsConcealedExample"
  | "dsApproved"
  | "dsDownload"
  | "dsAudit";

export const ADMIN_FOCUS_REGIONS: Record<AdminFocus, FocusRegion> = {
  accessRequestForm: { frame: "training/admin/access-request-form.png", rect: { x: 101, y: 368, w: 405, h: 298 } },
  accessRequestSent: { frame: "training/admin/access-request-sent.png", rect: { x: 101, y: 193, w: 405, h: 557 } },
  accessRequestsQueue: { frame: "training/admin/access-queue.png", rect: { x: 262, y: 267, w: 887, h: 328 } },
  accessApproveAs: { frame: "training/admin/access-queue.png", rect: { x: 567, y: 350, w: 548, h: 92 } },
  accessSignInHandoff: { frame: "training/admin/access-handoff.png", rect: { x: 262, y: 325, w: 887, h: 205 } },
  accessTemporaryPassword: { frame: "training/admin/access-temp-password.png", rect: { x: 359, y: 262, w: 467, h: 331 } },
  accessPasswordSet: { frame: "training/admin/access-password-set.png", rect: { x: 262, y: 747, w: 887, h: 61 } },
  accessDeclined: { frame: "training/admin/access-declined.png", rect: { x: 500, y: 15, w: 647, h: 50 } },
  accessForcedPassword: { frame: "training/admin/access-forced-password.png", rect: { x: 390, y: 357, w: 405, h: 288 } },
  accessFirstWelcome: { frame: "training/admin/access-first-welcome.png", rect: { x: 258, y: 21, w: 895, h: 259 } },
  accessFirstReply: { frame: "training/admin/access-reply.png", rect: { x: 315, y: 311, w: 839, h: 70 } },
  accessDeclinedSignin: { frame: "training/admin/access-declined-signin.png", rect: { x: 101, y: 308, w: 405, h: 346 } },
  accessSsoHandoff: { frame: "training/admin/access-sso-approved.png", rect: { x: 262, y: 325, w: 887, h: 205 } },
  accessSsoSignin: { frame: "training/admin/access-sso-signin.png", rect: { x: 101, y: 339, w: 405, h: 354 } },
  accessSsoWelcome: { frame: "training/admin/access-sso-welcome.png", rect: { x: 258, y: 21, w: 895, h: 259 } },
  accessSsoRow: { frame: "training/admin/access-sso-row.png", rect: { x: 262, y: 750, w: 887, h: 61 } },
  usersTabs: { frame: "training/admin/users-list.png", rect: { x: 261, y: 163, w: 889, h: 91 } },
  usersAddForm: { frame: "training/admin/users-add-form.png", rect: { x: 112, y: 321, w: 1037, h: 158 } },
  usersCreatedRow: { frame: "training/admin/users-created.png", rect: { x: 132, y: 714, w: 986, h: 61 } },
  usersPasswordDialog: { frame: "training/admin/users-password-dialog.png", rect: { x: 359, y: 270, w: 467, h: 315 } },
  usersLocalRow: { frame: "training/admin/users-password-set.png", rect: { x: 132, y: 747, w: 986, h: 61 } },
  usersRoleCell: { frame: "training/admin/users-role-changed.png", rect: { x: 486, y: 747, w: 144, h: 61 } },
  usersRowActions: { frame: "training/admin/users-deactivated.png", rect: { x: 967, y: 755, w: 151, h: 45 } },
  usersBulkSelect: { frame: "training/admin/users-bulk-selected.png", rect: { x: 132, y: 236, w: 986, h: 572 } },
  usersBulkDone: { frame: "training/admin/users-bulk-done.png", rect: { x: 132, y: 692, w: 986, h: 116 } },
  usersGroupFilter: { frame: "training/admin/users-filtered.png", rect: { x: 670, y: 258, w: 161, h: 45 } },
  usersTraceBlocked: { frame: "training/admin/users-trace.png", rect: { x: 222, y: 334, w: 741, h: 214 } },
  usersDeletedToast: { frame: "training/admin/users-deleted.png", rect: { x: 500, y: 15, w: 647, h: 50 } },
  groupsCards: { frame: "training/admin/groups-list.png", rect: { x: 297, y: 464, w: 817, h: 267 } },
  groupsAddForm: { frame: "training/admin/groups-add-form.png", rect: { x: 297, y: 414, w: 817, h: 92 } },
  groupsNewCard: { frame: "training/admin/groups-created.png", rect: { x: 707, y: 383, w: 407, h: 88 } },
  groupsMemberRow: { frame: "training/admin/groups-members.png", rect: { x: 312, y: 445, w: 776, h: 62 } },
  groupsImport: { frame: "training/admin/groups-import.png", rect: { x: 297, y: 550, w: 767, h: 244 } },
  groupsImportResult: { frame: "training/admin/groups-import-result.png", rect: { x: 500, y: 15, w: 647, h: 60 } },
  groupsPermGrid: { frame: "training/admin/groups-permissions.png", rect: { x: 312, y: 36, w: 787, h: 742 } },
  groupsKnowledgeRow: { frame: "training/admin/groups-permission-saved.png", rect: { x: 312, y: 506, w: 787, h: 70 } },
  groupsDefaultSummary: { frame: "training/admin/groups-default.png", rect: { x: 297, y: 158, w: 817, h: 100 } },
  groupsVerifyTable: { frame: "training/admin/groups-verify.png", rect: { x: 282, y: 379, w: 867, h: 214 } },
  maCatalog: { frame: "training/admin/ma-catalog.png", rect: { x: 132, y: 202, w: 949, h: 156 } },
  maGroupEditor: { frame: "training/admin/ma-groups-editor.png", rect: { x: 112, y: 592, w: 1037, h: 110 } },
  maTraceBlocked: { frame: "training/admin/ma-trace-blocked.png", rect: { x: 222, y: 529, w: 741, h: 214 } },
  maGroupGranted: { frame: "training/admin/ma-group-granted.png", rect: { x: 112, y: 592, w: 1037, h: 110 } },
  maTraceUsable: { frame: "training/admin/ma-trace-usable.png", rect: { x: 222, y: 503, w: 741, h: 240 } },
  maHiddenRow: { frame: "training/admin/ma-hidden.png", rect: { x: 725, y: 410, w: 157, h: 30 } },
  maRefused: { frame: "training/admin/ma-reenable-refused.png", rect: { x: 500, y: 15, w: 647, h: 60 } },
  maFiltered: { frame: "training/admin/ma-filter.png", rect: { x: 132, y: 604, w: 1017, h: 204 } },
  mrUserDialog: { frame: "training/admin/mr-user-dialog.png", rect: { x: 262, y: 628, w: 661, h: 98 } },
  mrUserRequested: { frame: "training/admin/mr-user-requested.png", rect: { x: 262, y: 628, w: 661, h: 110 } },
  mrQueue: { frame: "training/admin/mr-queue.png", rect: { x: 261, y: 0, w: 889, h: 366 } },
  mrGroupChoice: { frame: "training/admin/mr-group-choice.png", rect: { x: 776, y: 117, w: 338, h: 129 } },
  mrApproved: { frame: "training/admin/mr-approved.png", rect: { x: 262, y: 96, w: 887, h: 62 } },
  mrDeclined: { frame: "training/admin/mr-declined.png", rect: { x: 262, y: 96, w: 887, h: 62 } },
  mrUserAfter: { frame: "training/admin/mr-user-after.png", rect: { x: 262, y: 633, w: 661, h: 93 } },
  mrTrace: { frame: "training/admin/mr-trace.png", rect: { x: 222, y: 444, w: 741, h: 240 } },
  ssoReadonlyEmpty: { frame: "training/admin/sso-readonly-empty.png", rect: { x: 261, y: 271, w: 889, h: 249 } },
  ssoPolicyAvailable: { frame: "training/admin/sso-policy-available.png", rect: { x: 261, y: 271, w: 889, h: 195 } },
  ssoPresetEntra: { frame: "training/admin/sso-add-entra.png", rect: { x: 283, y: 314, w: 562, h: 201 } },
  ssoPresetOkta: { frame: "training/admin/sso-add-okta.png", rect: { x: 283, y: 332, w: 562, h: 183 } },
  ssoPresetGoogle: { frame: "training/admin/sso-add-google.png", rect: { x: 283, y: 332, w: 562, h: 183 } },
  ssoFields: { frame: "training/admin/sso-add-custom.png", rect: { x: 283, y: 409, w: 845, h: 217 } },
  ssoCreate: { frame: "training/admin/sso-add-custom.png", rect: { x: 283, y: 631, w: 845, h: 132 } },
  ssoCard: { frame: "training/admin/sso-created.png", rect: { x: 282, y: 227, w: 420, h: 582 } },
  ssoTestResult: { frame: "training/admin/sso-tested.png", rect: { x: 297, y: 564, w: 390, h: 188 } },
  ssoSignin: { frame: "training/admin/sso-signin.png", rect: { x: 101, y: 339, w: 405, h: 354 } },
  ssoIdpLogin: { frame: "training/admin/sso-idp-login.png", rect: { x: 387, y: 368, w: 411, h: 227 } },
  ssoWelcome: { frame: "training/admin/sso-first-welcome.png", rect: { x: 258, y: 21, w: 895, h: 259 } },
  ssoJitRow: { frame: "training/admin/sso-jit-user.png", rect: { x: 262, y: 750, w: 887, h: 61 } },
  ssoMappings: { frame: "training/admin/sso-mappings-saved.png", rect: { x: 297, y: 438, w: 390, h: 227 } },
  ssoSyncedRow: { frame: "training/admin/sso-groups-synced.png", rect: { x: 262, y: 642, w: 887, h: 61 } },
  ssoEnforceRow: { frame: "training/admin/sso-enforced.png", rect: { x: 297, y: 662, w: 390, h: 51 } },
  ssoRefused: { frame: "training/admin/sso-password-refused.png", rect: { x: 101, y: 317, w: 405, h: 435 } },
  ssoReadonlyCard: { frame: "training/admin/sso-readonly-card.png", rect: { x: 282, y: 371, w: 677, h: 484 } },
  policyCollapsed: { frame: "training/admin/pol-collapsed.png", rect: { x: 261, y: 271, w: 889, h: 427 } },
  policyServiceAvailability: { frame: "training/admin/pol-status.png", rect: { x: 262, y: 432, w: 887, h: 64 } },
  policyDefaults: { frame: "training/admin/pol-defaults.png", rect: { x: 262, y: 96, w: 887, h: 471 } },
  polKnowledgeRow: { frame: "training/admin/pol-default-saved.png", rect: { x: 282, y: 402, w: 847, h: 51 } },
  polVerifyRow: { frame: "training/admin/pol-verify.png", rect: { x: 312, y: 506, w: 787, h: 70 } },
  policyMemory: { frame: "training/admin/pol-memory.png", rect: { x: 261, y: 285, w: 889, h: 440 } },
  polRetentionField: { frame: "training/admin/pol-memory-saved.png", rect: { x: 262, y: 524, w: 887, h: 107 } },
  polPurgeConfirm: { frame: "training/admin/pol-purge-confirm.png", rect: { x: 282, y: 720, w: 847, h: 88 } },
  policyCounts: { frame: "training/admin/pol-purged.png", rect: { x: 261, y: 654, w: 889, h: 175 } },
  polMemoryOff: { frame: "training/admin/pol-memory-off.png", rect: { x: 261, y: 499, w: 889, h: 170 } },
  responseOverview: { frame: "training/admin/tools-panel.png", rect: { x: 262, y: 309, w: 887, h: 114 } },
  toolsBuilder: { frame: "training/admin/tools-builder.png", rect: { x: 129, y: 34, w: 927, h: 787 } },
  toolsScript: { frame: "training/admin/tools-builder-filled.png", rect: { x: 146, y: 274, w: 893, h: 157 } },
  toolsGroups: { frame: "training/admin/tools-builder-filled.png", rect: { x: 146, y: 556, w: 893, h: 90 } },
  toolsTestResult: { frame: "training/admin/tools-test-run.png", rect: { x: 146, y: 567, w: 893, h: 219 } },
  toolsSavedRow: { frame: "training/admin/tools-saved.png", rect: { x: 262, y: 741, w: 887, h: 87 } },
  toolsUserButton: { frame: "training/admin/tools-user-button.png", rect: { x: 405, y: 504, w: 34, h: 35 } },
  toolsUserResult: { frame: "training/admin/tools-user-result.png", rect: { x: 269, y: 272, w: 647, h: 311 } },
  toolsEdit: { frame: "training/admin/tools-edit.png", rect: { x: 129, y: 34, w: 927, h: 787 } },
  toolsDraftRow: { frame: "training/admin/tools-draft.png", rect: { x: 262, y: 741, w: 887, h: 87 } },
  toolsLibrary: { frame: "training/admin/tools-connections.png", rect: { x: 709, y: 270, w: 442, h: 276 } },
  toolsSignIn: { frame: "training/admin/tools-connection-signin.png", rect: { x: 283, y: 677, w: 845, h: 67 } },
  cnPanel: { frame: "training/admin/cn-panel.png", rect: { x: 262, y: 272, w: 887, h: 114 } },
  cnWebOn: { frame: "training/admin/cn-web-on.png", rect: { x: 282, y: 402, w: 847, h: 51 } },
  cnWebTested: { frame: "training/admin/cn-web-tested.png", rect: { x: 282, y: 48, w: 847, h: 451 } },
  cnWebSearxng: { frame: "training/admin/cn-web-searxng.png", rect: { x: 282, y: 48, w: 847, h: 511 } },
  cnWebKeyed: { frame: "training/admin/cn-web-keyed.png", rect: { x: 282, y: 48, w: 847, h: 479 } },
  cnDriveForm: { frame: "training/admin/cn-gdrive-form.png", rect: { x: 282, y: 48, w: 847, h: 428 } },
  cnDriveTested: { frame: "training/admin/cn-gdrive-tested.png", rect: { x: 296, y: 306, w: 819, h: 130 } },
  cnGraphForm: { frame: "training/admin/cn-graph-form.png", rect: { x: 282, y: 48, w: 847, h: 446 } },
  cnGraphTested: { frame: "training/admin/cn-graph-tested.png", rect: { x: 296, y: 306, w: 819, h: 200 } },
  cnBoxTested: { frame: "training/admin/cn-box-tested.png", rect: { x: 282, y: 48, w: 847, h: 544 } },
  cnImanageTested: { frame: "training/admin/cn-imanage-tested.png", rect: { x: 296, y: 346, w: 819, h: 113 } },
  cnUserAttach: { frame: "training/admin/cn-user-attach.png", rect: { x: 311, y: 163, w: 259, h: 283 } },
  cnBoxHidden: { frame: "training/admin/cn-box-hidden.png", rect: { x: 282, y: 402, w: 847, h: 51 } },
  cnUserAttachHidden: { frame: "training/admin/cn-user-attach-hidden.png", rect: { x: 311, y: 194, w: 259, h: 252 } },
  cnBoxShown: { frame: "training/admin/cn-box-shown.png", rect: { x: 282, y: 402, w: 847, h: 51 } },
  cnOffForAll: { frame: "training/admin/cn-off-for-all.png", rect: { x: 282, y: 399, w: 847, h: 51 } },
  anSections: { frame: "training/admin/an-sections.png", rect: { x: 261, y: 271, w: 889, h: 584 } },
  anFilters: { frame: "training/admin/an-runtime.png", rect: { x: 276, y: 98, w: 859, h: 160 } },
  anCsv: { frame: "training/admin/an-csv.png", rect: { x: 774, y: 67, w: 307, h: 235 } },
  anActivity: { frame: "training/admin/an-activity.png", rect: { x: 262, y: 251, w: 887, h: 277 } },
  anUsageCards: { frame: "training/admin/an-usage.png", rect: { x: 262, y: 291, w: 887, h: 156 } },
  anBudget: { frame: "training/admin/an-budget.png", rect: { x: 261, y: 391, w: 889, h: 314 } },
  anAllocationForm: { frame: "training/admin/an-allocation-form.png", rect: { x: 262, y: 743, w: 887, h: 85 } },
  anAllocationTable: { frame: "training/admin/an-allocation-saved.png", rect: { x: 282, y: 620, w: 836, h: 98 } },
  anCapHit: { frame: "training/admin/an-cap-hit.png", rect: { x: 315, y: 250, w: 839, h: 50 } },
  auSignals: { frame: "training/admin/au-board.png", rect: { x: 262, y: 0, w: 887, h: 613 } },
  auSignalRecords: { frame: "training/admin/au-signal.png", rect: { x: 229, y: 105, w: 727, h: 645 } },
  auInsights: { frame: "training/admin/au-insights.png", rect: { x: 282, y: 124, w: 847, h: 306 } },
  auChartRecords: { frame: "training/admin/au-chart-records.png", rect: { x: 229, y: 131, w: 727, h: 593 } },
  auPromptRecord: { frame: "training/admin/au-prompt.png", rect: { x: 179, y: 148, w: 827, h: 559 } },
  auAlertAck: { frame: "training/admin/au-alert-ack.png", rect: { x: 283, y: 385, w: 845, h: 85 } },
  auTrailFilters: { frame: "training/admin/au-trail.png", rect: { x: 262, y: 271, w: 887, h: 85 } },
  alEmail: { frame: "training/admin/al-email.png", rect: { x: 261, y: 271, w: 889, h: 204 } },
  alRuleForm: { frame: "training/admin/al-template.png", rect: { x: 262, y: 0, w: 887, h: 642 } },
  alRuleDetections: { frame: "training/admin/al-detections.png", rect: { x: 283, y: 330, w: 845, h: 194 } },
  alRuleRow: { frame: "training/admin/al-rule-saved.png", rect: { x: 282, y: 459, w: 847, h: 82 } },
  alFlaggedChat: { frame: "training/admin/al-flagged-chat.png", rect: { x: 257, y: 93, w: 897, h: 105 } },
  alDeliverySent: { frame: "training/admin/al-delivery-sent.png", rect: { x: 283, y: 601, w: 845, h: 107 } },
  alArchived: { frame: "training/admin/al-archived.png", rect: { x: 283, y: 601, w: 845, h: 107 } },
  alSupportTemplate: { frame: "training/admin/al-support-template.png", rect: { x: 262, y: 146, w: 887, h: 646 } },
  retNavigation: { frame: "training/admin/ret-navigation.png", rect: { x: 262, y: 383, w: 887, h: 93 } },
  retForever: { frame: "training/admin/ret-forever.png", rect: { x: 282, y: 4, w: 849, h: 220 } },
  retSourceForm: { frame: "training/admin/ret-source.png", rect: { x: 282, y: 120, w: 847, h: 205 } },
  retSourceRow: { frame: "training/admin/ret-source-saved.png", rect: { x: 282, y: 0, w: 847, h: 100 } },
  retScan: { frame: "training/admin/ret-scan.png", rect: { x: 282, y: 108, w: 847, h: 348 } },
  retConfirm: { frame: "training/admin/ret-confirm.png", rect: { x: 282, y: 376, w: 847, h: 80 } },
  retConversation: { frame: "training/admin/ret-conversation.png", rect: { x: 179, y: 200, w: 827, h: 455 } },
  retHold: { frame: "training/admin/ret-hold.png", rect: { x: 301, y: 0, w: 809, h: 296 } },
  retPreview: { frame: "training/admin/ret-preview.png", rect: { x: 282, y: 370, w: 847, h: 173 } },
  retDeleteConfirm: { frame: "training/admin/ret-delete-confirm.png", rect: { x: 282, y: 357, w: 847, h: 140 } },
  fbUserRate: { frame: "training/admin/fb-user-rate.png", rect: { x: 315, y: 360, w: 839, h: 165 } },
  fbUserReport: { frame: "training/admin/fb-user-report.png", rect: { x: 777, y: 139, w: 382, h: 707 } },
  fbOverview: { frame: "training/admin/fb-overview.png", rect: { x: 262, y: 98, w: 887, h: 309 } },
  feedbackConversation: { frame: "training/admin/fb-conversation.png", rect: { x: 179, y: 123, w: 827, h: 609 } },
  fbIssues: { frame: "training/admin/fb-issues.png", rect: { x: 262, y: 307, w: 887, h: 240 } },
  feedbackIssueReport: { frame: "training/admin/fb-issue-detail.png", rect: { x: 209, y: 302, w: 767, h: 251 } },
  fbReports: { frame: "training/admin/fb-reports.png", rect: { x: 261, y: 271, w: 501, h: 311 } },
  rpUserHelp: { frame: "training/admin/rp-user-help.png", rect: { x: 777, y: 118, w: 382, h: 136 } },
  rpUserForm: { frame: "training/admin/rp-user-form.png", rect: { x: 777, y: 139, w: 382, h: 707 } },
  rpUserSecurity: { frame: "training/admin/rp-user-security.png", rect: { x: 792, y: 164, w: 352, h: 212 } },
  rpUserSent: { frame: "training/admin/rp-user-sent.png", rect: { x: 777, y: 149, w: 382, h: 147 } },
  rpQueue: { frame: "training/admin/rp-queue.png", rect: { x: 261, y: 271, w: 501, h: 228 } },
  rpSearch: { frame: "training/admin/rp-search.png", rect: { x: 261, y: 327, w: 387, h: 172 } },
  rpTicket: { frame: "training/admin/rp-ticket.png", rect: { x: 655, y: 395, w: 495, h: 460 } },
  rpTriage: { frame: "training/admin/rp-triage.png", rect: { x: 672, y: 342, w: 461, h: 372 } },
  rpInternal: { frame: "training/admin/rp-internal.png", rect: { x: 672, y: 537, w: 461, h: 87 } },
  rpReply: { frame: "training/admin/rp-reply.png", rect: { x: 672, y: 631, w: 461, h: 182 } },
  rpUserReply: { frame: "training/admin/rp-user-reply.png", rect: { x: 777, y: 421, w: 382, h: 266 } },
  rpNeedsReply: { frame: "training/admin/rp-needs-reply.png", rect: { x: 261, y: 86, w: 501, h: 221 } },
  rpResolved: { frame: "training/admin/rp-resolved.png", rect: { x: 261, y: 86, w: 872, h: 372 } },
  rpUserResolved: { frame: "training/admin/rp-user-resolved.png", rect: { x: 777, y: 216, w: 382, h: 629 } },
  rpAudit: { frame: "training/admin/rp-audit.png", rect: { x: 283, y: 322, w: 845, h: 506 } },
  pdpFind: { frame: "training/admin/pdp-collapsed.png", rect: { x: 262, y: 376, w: 887, h: 113 } },
  pdpToggles: { frame: "training/admin/pdp-on.png", rect: { x: 262, y: 104, w: 887, h: 143 } },
  pdpCategories: { frame: "training/admin/pdp-categories.png", rect: { x: 262, y: 273, w: 887, h: 308 } },
  pdpPreview: { frame: "training/admin/pdp-preview.png", rect: { x: 282, y: 281, w: 847, h: 292 } },
  pdpCoverage: { frame: "training/admin/pdp-coverage.png", rect: { x: 262, y: 351, w: 887, h: 269 } },
  pdpChatPrompt: { frame: "training/admin/pdp-chat.png", rect: { x: 257, y: 93, w: 897, h: 105 } },
  pdpChatReply: { frame: "training/admin/pdp-chat.png", rect: { x: 315, y: 312, w: 839, h: 53 } },
  pdpActivity: { frame: "training/admin/pdp-activity.png", rect: { x: 283, y: 383, w: 845, h: 89 } },
  pdpAuditTrail: { frame: "training/admin/pdp-audit.png", rect: { x: 283, y: 601, w: 845, h: 207 } },
  pdpModelRow: { frame: "training/admin/pdp-model-off.png", rect: { x: 282, y: 176, w: 847, h: 51 } },
  pdpOutput: { frame: "training/admin/pdp-output.png", rect: { x: 315, y: 312, w: 839, h: 27 } },
  pdpOffRow: { frame: "training/admin/pdp-off.png", rect: { x: 282, y: 124, w: 847, h: 51 } },
  pdpStillConcealed: { frame: "training/admin/pdp-after-off.png", rect: { x: 257, y: 93, w: 897, h: 105 } },
  dsCapture: { frame: "training/admin/ds-off.png", rect: { x: 262, y: 272, w: 887, h: 178 } },
  dsSignals: { frame: "training/admin/ds-on.png", rect: { x: 282, y: 399, w: 847, h: 139 } },
  dsSafeguards: { frame: "training/admin/ds-safeguards.png", rect: { x: 282, y: 0, w: 847, h: 151 } },
  dsExcluded: { frame: "training/admin/ds-safeguards.png", rect: { x: 282, y: 152, w: 847, h: 87 } },
  dsScan: { frame: "training/admin/ds-scanned.png", rect: { x: 282, y: 0, w: 847, h: 649 } },
  dsUserCorrection: { frame: "training/admin/ds-user-correction.png", rect: { x: 257, y: 87, w: 897, h: 105 } },
  dsUserNote: { frame: "training/admin/ds-user-note.png", rect: { x: 315, y: 371, w: 839, h: 154 } },
  dsOverview: { frame: "training/admin/ds-overview.png", rect: { x: 262, y: 85, w: 887, h: 141 } },
  dsMix: { frame: "training/admin/ds-mix.png", rect: { x: 262, y: 306, w: 887, h: 244 } },
  dsSuggestions: { frame: "training/admin/ds-suggestions.png", rect: { x: 262, y: 291, w: 887, h: 273 } },
  dsEditorFormat: { frame: "training/admin/ds-editor.png", rect: { x: 230, y: 274, w: 725, h: 133 } },
  dsEditorRules: { frame: "training/admin/ds-editor-rules.png", rect: { x: 230, y: 88, w: 725, h: 540 } },
  dsCard: { frame: "training/admin/ds-created.png", rect: { x: 282, y: 305, w: 421, h: 246 } },
  dsExample: { frame: "training/admin/ds-review.png", rect: { x: 282, y: 0, w: 847, h: 777 } },
  dsConcealedExample: { frame: "training/admin/ds-concealed.png", rect: { x: 282, y: 171, w: 847, h: 637 } },
  dsApproved: { frame: "training/admin/ds-approved.png", rect: { x: 297, y: 451, w: 391, h: 26 } },
  dsDownload: { frame: "training/admin/ds-download.png", rect: { x: 319, y: 284, w: 547, h: 287 } },
  dsAudit: { frame: "training/admin/ds-audit.png", rect: { x: 283, y: 322, w: 845, h: 506 } },
};

type AdminGuideIcon = "users" | "groups" | "models" | "tools" | "connectors" | "sso" | "analytics" | "reports" | "policies" | "audit" | "alerts" | "retention" | "privacy" | "datasets";

export type AdminTrainingVideo = TrainingVideoBase & { icon: AdminGuideIcon };

/* Ordered by track: the Documentation library groups lessons under each
 * track heading in this order. */
export const ADMIN_TRAINING_VIDEOS: AdminTrainingVideo[] = [
  {
    id: "admin-access-onboarding",
    audioSrc: "training/admin/admin-access-onboarding.mp3",
    title: "Approve access and finish sign-in",
    description: "Take a real access request from the sign-in page to a working first chat, by temporary password or by organization SSO, and decline a request you do not recognize.",
    icon: "users",
    track: "Accounts and access",
    outcomes: [
      "Request approved with the right role",
      "Sign-in arranged by temporary password or SSO",
      "First real reply confirmed",
      "Unrecognized request declined",
    ],
    prerequisites: [
      "An Admin account. Admin console › Users shows the Access requests panel only while someone is waiting.",
      "A model granted to Default Users in Model Access, so the approved person has something to chat with.",
      "For the SSO path: single sign-on already set up on the SSO tab, and the person's account at your identity provider with a verified email on an allowed domain.",
      "A safe way to share a temporary password, such as in person or your password manager's sharing. Aperture Chat sends no email.",
    ],
    setupSteps: [
      "The person opens your workspace address, chooses Request access, enters First name, Last name, and Work email, and chooses Submit access request. They see Request received.",
      "Choose Admin console at the bottom of the sidebar. Users opens with an Access requests panel that lists each person's name, email, and request time.",
      "Check that you recognize the person and the email address.",
      "In Approve as, keep User, then choose Approve. The status reads \"… was approved as User.\"",
      "In Finish sign-in setup, choose Set temporary password.",
      "Choose Generate (or type at least 12 characters), keep Temporary password on, and choose Set password.",
      "Choose Copy, share the password over your safe channel, then choose Done in the dialog and Done in Finish sign-in setup. The row now shows local under Auth.",
      "The person chooses Email & password on the sign-in page, signs in with the temporary password, enters their own password twice on Set a new password, and chooses Set password and continue.",
      "They land on the welcome card. Ask them to start a new chat, choose a model, and send a short message.",
      "Confirm that a reply arrives. That proves the approval, the group, model access, and sign-in all work.",
    ],
    paths: [
      {
        label: "Organization SSO, no password (shown)",
        steps: [
          "Make sure single sign-on is set up on the SSO tab and the person has an account at your identity provider with a verified email on an allowed domain.",
          "Approve the request as User. In Finish sign-in setup, choose Done. Do not set a password.",
          "Tell the person to open the workspace, enter their work email, and choose Continue with SSO.",
          "They sign in at the identity provider and land on the welcome card.",
          "Users shows the account Active, with sso under Auth.",
        ],
      },
      {
        label: "Decline a request (shown)",
        steps: [
          "In Access requests, choose Decline on the request you do not recognize. There is no confirmation step.",
          "The status reads \"… access request was declined.\" The pending account is deleted.",
          "If that person tries to sign in, they see \"Unknown local account.\" They can submit a new request later.",
        ],
      },
      {
        label: "Approve as Temp User or Admin",
        steps: [
          "Temp User gives access to the designated Luna model only and stops after 30,000 reported tokens. It needs an enabled Luna model.",
          "Admin appears in Approve as only when service policy allows it. Otherwise Policies › Policy Controls notes \"Administrator accounts are created by your service team.\"",
          "Arrange sign-in the same way: a temporary password or organization SSO.",
        ],
      },
    ],
    verify: [
      "The status reads \"… was approved as User.\" and the request leaves the queue.",
      "Users shows the person Active, with local under Auth after a password is set, or sso for the SSO path.",
      "The person reaches the welcome card and gets a real reply to a first message.",
      "A declined person's sign-in attempt shows \"Unknown local account.\"",
    ],
    troubleshooting: [
      { symptom: "\"Access was not approved. This access request is no longer pending.\"", fix: "Another administrator already approved or declined it. Reload Users to see the current queue." },
      { symptom: "\"Access was not approved. Enable a Luna model for this workspace before approving temporary access.\"", fix: "Approve as User instead, or ask your service team to enable a Luna model." },
      { symptom: "The approved person sees \"Unknown local account.\"", fix: "Approved accounts start as SSO accounts. Set a temporary password (Finish sign-in setup, or Password in the row's Actions), or have them use Continue with SSO." },
      { symptom: "\"Invalid local credentials.\"", fix: "The temporary password was mistyped. Set a new one; each new password replaces the last." },
      { symptom: "Set password stays unavailable in the password dialog", fix: "Passwords need at least 12 characters. Choose Generate." },
      { symptom: "The person's model menu reads No models available", fix: "None of their groups carries a model. Grant one to Default Users in Model Access, or choose Access on their Users row to see why." },
      { symptom: "\"Too many access requests for this email. Try again shortly.\"", fix: "The sign-in page accepts three requests per email in a short window. Wait a minute, then submit once." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "Have an Admin account, a model for Default Users, a sign-in method, and a safe way to share a password.",
        narration:
          "This lesson takes a real access request all the way to a working first chat. Before you begin, have four things: an Admin account, a model granted to Default Users, a decision about how each person signs in, and a safe way to share a temporary password. Aperture Chat sends no email.",
        durationSeconds: 21,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "An Admin account.",
            "A model granted to Default Users in Model Access.",
            "How each person signs in: a temporary password, or organization SSO.",
            "A safe way to share a temporary password. No email is sent.",
          ],
        },
      },
      {
        title: "The person asks to join",
        caption: "On the sign-in page: Request access, then first name, last name, and work email.",
        narration:
          "Start where the person starts. On your workspace's sign-in page, they choose Request access, enter their first name, last name, and work email, and choose Submit access request.",
        durationSeconds: 13,
        calloutPlacement: "right-mid",
        focus: "accessRequestForm",
      },
      {
        title: "The request waits for you",
        caption: "Request received. No email is sent and no password is set.",
        narration:
          "They see Request received. Nothing else happens yet: no email is sent and no password is set. The request waits for an administrator.",
        durationSeconds: 10,
        calloutPlacement: "right-mid",
        focus: "accessRequestSent",
      },
      {
        title: "Review the queue",
        caption: "Admin console › Users › Access requests: name, email, and when they asked.",
        narration:
          "Choose Admin console at the bottom of the sidebar. Users opens with an Access requests panel. Each card shows the name, the email address, and when they asked. Check that you recognize the person and the address.",
        durationSeconds: 15,
        focus: "accessRequestsQueue",
      },
      {
        title: "Choose the role and approve",
        caption: "Approve as: User for most people. Temp User and Admin follow policy.",
        narration:
          "Approve as sets the role. Keep User for most people. Temp User gives the designated Luna model only, up to thirty thousand tokens. Admin appears only when service policy allows it. Choose Approve.",
        durationSeconds: 15,
        focus: "accessApproveAs",
      },
      {
        title: "Finish sign-in setup",
        caption: "Approval sends nothing. Choose how they sign in: a temporary password, or SSO.",
        narration:
          "Approval opens Finish sign-in setup. Nothing has been sent, so decide how this person signs in. For email and password, choose Set temporary password. For organization S S O, choose Done; that path comes later in this lesson.",
        durationSeconds: 17,
        focus: "accessSignInHandoff",
      },
      {
        title: "Set a temporary password",
        caption: "Generate a password, keep Temporary password on, and choose Set password.",
        narration:
          "Choose Generate, or type at least twelve characters. Keep Temporary password on, so they must choose their own at first sign-in. Choose Set password, then Copy, and share it over your safe channel.",
        durationSeconds: 14,
        calloutPlacement: "lower-right",
        focus: "accessTemporaryPassword",
      },
      {
        title: "The account now signs in locally",
        caption: "The row reads Active, Default Users, and local under Auth.",
        narration:
          "Choose Done in the dialog and in Finish sign-in setup. The row now reads Active, in Default Users, with local under Auth.",
        durationSeconds: 10,
        focus: "accessPasswordSet",
      },
      {
        title: "Decline a request you don't recognize",
        caption: "Decline removes the pending account. There is no confirmation step.",
        narration:
          "For a request you don't recognize, choose Decline. There is no confirmation step. The status confirms the decline, and the pending account is removed.",
        durationSeconds: 11,
        focus: "accessDeclined",
      },
      {
        title: "First sign-in: their own password",
        caption: "Email & password with the temporary password, then Set a new password.",
        narration:
          "Now the person signs in. They choose Email and password, and enter their email and the temporary password. Set a new password asks for a password of their own, twice. They choose Set password and continue.",
        durationSeconds: 15,
        calloutPlacement: "right-mid",
        focus: "accessForcedPassword",
      },
      {
        title: "They reach the workspace",
        caption: "The welcome card confirms the account is signed in.",
        narration:
          "They land in the workspace on the welcome card.",
        durationSeconds: 4,
        focus: "accessFirstWelcome",
      },
      {
        title: "Confirm a real first reply",
        caption: "A new chat, a model, a short message, and a real reply.",
        narration:
          "Ask them to start a new chat, choose a model, and send a short message. A real reply proves the whole path: approval, group, model access, and sign-in.",
        durationSeconds: 11,
        focus: "accessFirstReply",
      },
      {
        title: "What a declined person sees",
        caption: "A declined request leaves no account: \"Unknown local account.\"",
        narration:
          "A declined person has no account. If they try to sign in, they see Unknown local account. They can submit a new request later.",
        durationSeconds: 10,
        calloutPlacement: "right-mid",
        focus: "accessDeclinedSignin",
      },
      {
        title: "SSO path: approve, then Done",
        caption: "When SSO is set up, approve as User and choose Done. No password.",
        narration:
          "Now the S S O path. When single sign-on is set up and the person has an account at your identity provider, approve the request the same way, then choose Done. Do not set a password.",
        durationSeconds: 14,
        focus: "accessSsoHandoff",
      },
      {
        title: "They continue with SSO",
        caption: "They enter their work email and choose Continue with SSO.",
        narration:
          "Tell them to open the workspace and enter their work email. Organization S S O is selected for your domain. They choose Continue with S S O and sign in at the identity provider.",
        durationSeconds: 14,
        calloutPlacement: "right-mid",
        focus: "accessSsoSignin",
      },
      {
        title: "Signed in through the provider",
        caption: "The identity provider sends them back, signed in.",
        narration:
          "The identity provider sends them back to the workspace, signed in.",
        durationSeconds: 6,
        focus: "accessSsoWelcome",
      },
      {
        title: "Confirm the SSO account",
        caption: "Users shows the account Active, with sso under Auth.",
        narration:
          "Back on Users, the account is Active, with S S O under Auth. Finish the same way: a first chat with a real reply.",
        durationSeconds: 9,
        focus: "accessSsoRow",
      },
    ],
  },
  {
    id: "admin-users",
    audioSrc: "training/admin/admin-users.mp3",
    title: "Users and accounts",
    description: "Create SSO and password accounts, change roles, reset passwords, deactivate and reactivate, work in bulk, filter by group, explain model access, and delete leavers.",
    icon: "users",
    track: "Accounts and access",
    outcomes: [
      "Accounts created for SSO and for passwords",
      "Role, password, and status changed",
      "Bulk and filtered views used",
      "Model access explained and a leaver deleted",
    ],
    prerequisites: [
      "An Admin account. You manage User, Temp User, Power User, Auditor, and Agent Approver accounts; admin rows are locked.",
      "A group to start people in. Default Users always exists.",
      "For password accounts: a safe way to share a temporary password.",
    ],
    setupSteps: [
      "Choose Admin console at the bottom of the sidebar. Users is the first tab.",
      "Choose Add User. Enter Name and Email, then choose a Role and a Starting group.",
      "Choose Create Account. The status reads \"… was created through the admin API.\" The new row shows sso under Auth.",
      "For someone who signs in with a password, choose Password in the row's Actions, then Generate, keep Temporary password on, and choose Set password. Auth changes to local.",
      "To change a role, choose it in the row's Role menu. It saves immediately.",
      "To pause access, choose Deactivate in the row's Actions. Choose Activate to restore it.",
      "To delete a leaver, choose the trash button in the row's Actions. Deletion is immediate and permanent.",
    ],
    paths: [
      {
        label: "An SSO account (shown)",
        steps: [
          "Add User creates an account that signs in through organization SSO: Auth reads sso.",
          "Share the workspace address; the person enters their email and chooses Continue with SSO.",
          "Without SSO set up, the account cannot sign in until you set a temporary password.",
        ],
      },
      {
        label: "A password account (shown)",
        steps: [
          "Add User as above, then choose Password in the row's Actions.",
          "Choose Generate, keep Temporary password on, choose Set password, then Copy.",
          "Share the password safely. The person chooses their own at first sign-in.",
        ],
      },
      {
        label: "Several accounts at once (shown)",
        steps: [
          "Tick the checkbox at the start of each row.",
          "Choose Deactivate at the top of the list. The status reads \"Deactivated N users through the admin API.\"",
          "Bulk deactivation also deletes each person's saved personalization memories. A row's own Deactivate button keeps them.",
          "Reactivate people one at a time with Activate.",
        ],
      },
      {
        label: "Explain one person's model access (shown)",
        steps: [
          "Choose Access in the person's row.",
          "Each model shows Usable, Allowed, provider offline, or Blocked, with every gate the policy checked.",
          "The trace explains; it changes nothing. Fix access in Groups or Model Access.",
        ],
      },
    ],
    verify: [
      "New rows show the role, group, and Auth you chose.",
      "A deactivated row reads Inactive; Activate returns it to Active.",
      "After deletion the row is gone and the status reads \"… was permanently deleted.\"",
    ],
    troubleshooting: [
      { symptom: "\"User was not created. User email already exists.\"", fix: "Someone already has that address. Set Filter users by group to All groups and find them." },
      { symptom: "\"Pick a starting group first — create one on the Groups tab if none exist yet.\"", fix: "Create a group on the Groups tab, then add the user again." },
      { symptom: "The Password button is unavailable", fix: "Passwords can be set only for active accounts other than yours and other administrators'. Reactivate the account first." },
      { symptom: "\"Reactivate the account before setting its password.\"", fix: "Choose Activate in the row's Actions, then set the password." },
      { symptom: "\"… was not deleted. Tenant admins can only delete regular users in their own tenant.\"", fix: "Administrator accounts are managed by your service team." },
      { symptom: "\"This action is blocked by administrative continuity policy.\"", fix: "The change would leave the organization without an administrator. Ask your service team." },
      { symptom: "A password reset did not reset two-step verification", fix: "Correct: Password does not reset the authenticator, and this screen has no authenticator reset. Verify the person's identity through your organization's recovery process and contact your service team." },
    ],
    scenes: [
      {
        title: "Open Users",
        caption: "Admin console from the sidebar. Users lists every account you manage.",
        narration:
          "Choose Admin console at the bottom of the sidebar. Eleven tabs cover your organization, and Users comes first. Each row shows the name, email, role, groups, sign-in method under Auth, status, and last activity.",
        durationSeconds: 16,
        focus: "usersTabs",
      },
      {
        title: "Add a user",
        caption: "Add User: Name, Email, Role, and Starting group, then Create Account.",
        narration:
          "Choose Add User. Enter the name and email, choose a role, and choose the starting group. Default Users is the usual start. Choose Create Account.",
        durationSeconds: 11,
        focus: "usersAddForm",
      },
      {
        title: "New accounts sign in with SSO",
        caption: "Add User creates an SSO account: Auth reads sso.",
        narration:
          "The new account is Active, and its Auth column reads S S O. It signs in through organization single sign-on. If your organization has no S S O, give the account a password next.",
        durationSeconds: 14,
        focus: "usersCreatedRow",
      },
      {
        title: "Set a password for a local account",
        caption: "Actions › Password: Generate, keep Temporary password on, Set password.",
        narration:
          "For someone who signs in with a password, choose Password in the row's Actions. Choose Generate, keep Temporary password on, and choose Set password. Copy it and share it safely. The person chooses their own at first sign-in.",
        durationSeconds: 16,
        calloutPlacement: "lower-right",
        focus: "usersPasswordDialog",
      },
      {
        title: "Auth switches to local",
        caption: "After a password is set, the row's Auth reads local.",
        narration:
          "Setting a password switches the account to local sign-in. The Auth column now reads local, and the person signs in with email and password.",
        durationSeconds: 10,
        focus: "usersLocalRow",
      },
      {
        title: "Change a role",
        caption: "The Role menu saves as soon as you choose. Here: Power User.",
        narration:
          "To change a role, choose it in the row's Role menu. It saves immediately, and the status confirms the update. Admin rows are locked; your service team manages them.",
        durationSeconds: 12,
        focus: "usersRoleCell",
      },
      {
        title: "Deactivate and reactivate",
        caption: "Deactivate blocks sign-in; the row reads Inactive. Activate restores it.",
        narration:
          "To pause someone's access, choose Deactivate in the row's Actions. The status turns Inactive and they can no longer sign in. Choose Activate to restore it. Nothing else about the account changes.",
        durationSeconds: 14,
        focus: "usersRowActions",
      },
      {
        title: "Select several people",
        caption: "Tick each row, then choose Deactivate at the top of the list.",
        narration:
          "To deactivate several people, tick the checkbox at the start of each row, then choose Deactivate at the top of the list.",
        durationSeconds: 9,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "usersBulkSelect",
      },
      {
        title: "Bulk results",
        caption: "Each selected account is now Inactive. Bulk deactivation also clears saved memories.",
        narration:
          "Both accounts are now Inactive. Bulk deactivation also deletes each person's saved personalization memories; the row's own Deactivate button keeps them. Reactivate people one at a time with Activate.",
        durationSeconds: 15,
        focus: "usersBulkDone",
      },
      {
        title: "Work one group at a time",
        caption: "Filter users by group narrows the list to one group's members.",
        narration:
          "Use the group filter at the top to list one group's members. Choose All groups to see everyone again.",
        durationSeconds: 8,
        focus: "usersGroupFilter",
      },
      {
        title: "Explain someone's model access",
        caption: "Actions › Access lists each model and every gate, in order.",
        narration:
          "When someone asks why a model is missing, choose Access in their row. Each model shows Usable, Allowed with the provider offline, or Blocked, with every gate the policy checked. Here, none of Jane's groups grants this model. The trace explains; it changes nothing.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "usersTraceBlocked",
      },
      {
        title: "Delete a leaver",
        caption: "The trash button deletes the account and its chat history at once.",
        narration:
          "To remove a leaver, choose the trash button in the row's Actions. There is no confirmation step: the account and its chat history are permanently deleted, and the status confirms it. Deactivate instead if you might need the account again.",
        durationSeconds: 16,
        focus: "usersDeletedToast",
      },
    ],
  },
  {
    id: "admin-groups",
    audioSrc: "training/admin/admin-groups.mp3",
    title: "Groups and permissions",
    description: "Create a group, add people one at a time or by pasting emails, set each permission, and know how the protected Default Users group behaves.",
    icon: "groups",
    track: "Accounts and access",
    outcomes: ["Group created", "Members added both ways", "Permissions set and verified", "Default Users understood"],
    prerequisites: [
      "An Admin account.",
      "The people's accounts already exist. Import adds existing accounts only.",
      "Can use API stays locked while service policy keeps downstream API access off.",
    ],
    setupSteps: [
      "Choose Admin console › Groups, then Add Group.",
      "Enter a Group name and choose Create group. Leave Optional SSO group ID empty unless you use it.",
      "Choose Manage on the new group's card.",
      "On the group's Users tab, switch on each person you want in the group.",
      "On the Import tab, paste email addresses (one per line, or separated by commas) and choose Add users to group.",
      "On the Permissions tab, switch each permission on or off. Each switch saves immediately.",
      "Open Users and choose the group in Filter users by group to confirm its members.",
    ],
    paths: [
      {
        label: "Add people one at a time (shown)",
        steps: [
          "Open the group with Manage, then its Users tab.",
          "Switch on Add … to the group for each person. The pill changes to In group.",
        ],
      },
      {
        label: "Import by email (shown)",
        steps: [
          "Open the group's Import tab and paste the addresses.",
          "Choose Add users to group. Existing accounts are added; unknown addresses and administrator accounts stay in the box.",
        ],
      },
      {
        label: "Let SSO manage membership",
        steps: [
          "On the SSO tab, map an identity-provider group value to this group (see Tenant SSO and provisioning).",
          "Membership then follows each person's next SSO sign-in.",
        ],
      },
      {
        label: "Remove a group",
        steps: [
          "Choose the trash button on its card, or tick several cards and choose Remove selected. There is no confirmation step.",
          "Members lose the access that came through that group. Default Users cannot be removed.",
        ],
      },
    ],
    verify: [
      "The group's card shows the member count.",
      "Users filtered to the group lists exactly its members.",
      "Each permission you changed shows its new switch position, and the status reads \"… group permissions synced with the admin API.\"",
    ],
    troubleshooting: [
      { symptom: "\"Group was not created. Group name already exists.\"", fix: "Choose a different name, or manage the existing group." },
      { symptom: "\"Group name is required before creating a group.\"", fix: "Enter a Group name before choosing Create group." },
      { symptom: "\"No users were added to …. No eligible platform users were found for ….\"", fix: "Those addresses have no account, or belong to administrators. Create the accounts on Users first; the addresses stay in the box so you can retry." },
      { symptom: "Can use API reads \"Downstream API access is unavailable under the current service policy.\"", fix: "Service policy controls downstream API access. Ask your service team." },
      { symptom: "\"Default Users is protected by organization policy and cannot be removed.\"", fix: "Default Users is the baseline group. Adjust its permissions and models instead." },
      { symptom: "Can build agents is on, but people still cannot build agents", fix: "It also needs service policy to allow user-built agents. Policies › Default users can build agents shows whether it does." },
      { symptom: "A person sees \"Connecting APIs needs approval. Ask your administrator to turn on Can add API sources for one of your groups.\"", fix: "Turn on Can add API sources for one of their groups. It works only with Can build knowledge bases, because API sources live inside a person's own knowledge base." },
      { symptom: "A person sees \"Needs Hermes approval from your administrator\"", fix: "Turn on Can use Hermes companion for one of their groups. Until then Hermes agents and Hermes connections stay locked for them." },
    ],
    scenes: [
      {
        title: "Groups carry access",
        caption: "Admin console › Groups. Models, knowledge, and permissions all attach to groups.",
        narration:
          "Open Admin console, Groups. Access in Aperture Chat flows through groups: model grants, knowledge access, and permissions all attach to a group, and people get access by belonging to it. Default Users is the protected starting group.",
        durationSeconds: 17,
        focus: "groupsCards",
      },
      {
        title: "Create a group",
        caption: "Add Group: enter a Group name, then Create group.",
        narration:
          "Choose Add Group, enter a group name, and choose Create group. Leave Optional S S O group I D empty unless your team uses it.",
        durationSeconds: 10,
        focus: "groupsAddForm",
      },
      {
        title: "Open the new group",
        caption: "Manage opens the group's Users, Permissions, and Import tabs.",
        narration:
          "The new group appears with no members. Choose Manage to open its settings, with Users, Permissions, and Import tabs.",
        durationSeconds: 9,
        focus: "groupsNewCard",
      },
      {
        title: "Add people one at a time",
        caption: "Users tab: switch a person on. The pill changes to In group.",
        narration:
          "On the Users tab, switch on each person who belongs in the group. The change saves at once, and their pill changes to In group.",
        durationSeconds: 10,
        focus: "groupsMemberRow",
      },
      {
        title: "Import by email",
        caption: "Import tab: paste addresses, then Add users to group.",
        narration:
          "To add many people, open Import and paste their email addresses, one per line or separated by commas. Choose Add users to group. Only existing accounts can be added.",
        durationSeconds: 13,
        focus: "groupsImport",
      },
      {
        title: "Read the import result",
        caption: "Existing accounts are added; unknown addresses are named and stay in the box.",
        narration:
          "The status reports the result. Two people were added. The third address has no account, so it is named in the message and stays in the box for you to fix and retry.",
        durationSeconds: 12,
        focus: "groupsImportResult",
      },
      {
        title: "Set each permission",
        caption: "Chat, knowledge, agents, tools, API, Hermes, authoring, and memory.",
        narration:
          "Open Permissions. Chat, knowledge, agents, and tools start on; A P I and the Hermes companion are opt-in. Four building permissions let members create their own private agents, knowledge bases, A P I sources, and tools; publishing stays with administrators. Can use memory lets the assistant remember each person's preferences.",
        durationSeconds: 23,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "groupsPermGrid",
      },
      {
        title: "Change a permission",
        caption: "Each switch saves immediately. Here: Can build knowledge bases.",
        narration:
          "Switch a permission and it saves at once. Here, Can build knowledge bases is now on, so members can create their own private knowledge bases.",
        durationSeconds: 11,
        focus: "groupsKnowledgeRow",
      },
      {
        title: "Default Users is protected",
        caption: "New and approved people start here. You can tune it but not delete it.",
        narration:
          "Default Users is the protected baseline. New accounts and approved requests start here. You can change its permissions and models, but you cannot delete it.",
        durationSeconds: 11,
        focus: "groupsDefaultSummary",
      },
      {
        title: "Confirm the members",
        caption: "Users › Filter users by group lists exactly the group's members.",
        narration:
          "To confirm, open Users and choose the group in the group filter. It lists exactly the three people you added.",
        durationSeconds: 9,
        focus: "groupsVerifyTable",
      },
    ],
  },
  {
    id: "admin-model-access",
    audioSrc: "training/admin/admin-model-access.mp3",
    title: "Tenant model access",
    description: "Grant a model to the right groups, check the effect for one person in the access trace, and hide a model when you need to.",
    icon: "models",
    track: "Accounts and access",
    outcomes: [
      "Catalog synced and filtered",
      "Model granted through groups",
      "Effect checked in the access trace",
      "Hiding a model and its limit understood",
    ],
    prerequisites: [
      "An Admin account and at least one group.",
      "Models your service team has made available to your organization.",
      "Access is granted to groups only. There is no per-person grant or deny.",
    ],
    setupSteps: [
      "Choose Admin console › Model Access, then Sync models.",
      "Find the model with Search model names or the funnel filters in the column headings.",
      "In the model's Groups column, choose the groups button (Choose groups, or N groups).",
      "Tick each group that should use the model (Allow … for …). Each tick saves immediately.",
      "On Users, choose Access for someone in that group. The model reads Usable, with group_grant passed.",
    ],
    paths: [
      {
        label: "Grant or remove a group (shown)",
        steps: [
          "Open the model's groups and tick or untick a group.",
          "Members of a ticked group can use the model; the trace for someone outside it stops at group_grant.",
        ],
      },
      {
        label: "Hide a model from everyone (shown)",
        steps: [
          "Turn off the model's User Access switch. The row reads Hidden from users.",
          "Today only your service team can turn it back on: the switch is refused with \"This model is not available to this organization.\" The same happens if you untick its last group.",
          "To narrow access without hiding it, keep at least one group ticked.",
        ],
      },
      {
        label: "Give one person a model",
        steps: [
          "Create a group for them (or use an existing one) and tick it on the model.",
          "Or approve their request on Model Access (see Review model requests and explain access).",
        ],
      },
    ],
    verify: [
      "The User Access column reads Visible to N groups.",
      "The access trace for a member shows the model Usable, or Allowed, provider offline if only the provider is down.",
      "The person sees the model in their model menu.",
    ],
    troubleshooting: [
      { symptom: "\"… user access could not sync. This model is not available to this organization. Nothing was changed.\"", fix: "The model has no groups from your organization left, so it can no longer be changed here. Ask your service team to restore its groups. Keep one group ticked when narrowing access." },
      { symptom: "\"Create a group before enabling models.\"", fix: "Create a group on the Groups tab first. Users get models only through groups." },
      { symptom: "The trace reads Allowed, provider offline", fix: "The grant works, but the provider behind the model is not connected. Your service team reconnects it." },
      { symptom: "\"Model is disabled by platform policy.\"", fix: "The model is turned off for the whole service. Ask your service team." },
      { symptom: "A model is missing from the catalog", fix: "Choose Sync models. If it is still missing, it has not been made available to your organization. Ask your service team." },
    ],
    scenes: [
      {
        title: "The model catalog",
        caption: "Sync models, the counters, search, and the status filter.",
        narration:
          "Open Admin console, Model Access. Choose Sync models to pull the latest catalog available to your organization. The counters show the synced models, how many are visible to users, and your groups. Search by name, or filter by All, Enabled, and Disabled.",
        durationSeconds: 19,
        focus: "maCatalog",
      },
      {
        title: "Choose groups for a model",
        caption: "The Groups button opens a tick list. Each tick saves immediately.",
        narration:
          "Access is granted to groups. In the model's Groups column, choose the groups button. A tick list opens under the row. Here, Qwen is granted to Litigation and Default Users. Each tick saves immediately.",
        durationSeconds: 15,
        focus: "maGroupEditor",
      },
      {
        title: "Without the grant: Blocked",
        caption: "Untick Default Users and Maya's trace stops at group_grant: Blocked.",
        narration:
          "Untick Default Users, and see the effect for one person. On Users, choose Access for Maya, who is in Default Users. The model is Blocked: none of her groups grants it, so the check stops at group grant.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        focus: "maTraceBlocked",
      },
      {
        title: "Grant it back",
        caption: "Tick Default Users again; the column reads Visible to 2 groups.",
        narration:
          "Return to Model Access and tick Default Users again. The status confirms the change, and the model is visible to two groups.",
        durationSeconds: 10,
        focus: "maGroupGranted",
      },
      {
        title: "With the grant: Usable",
        caption: "Maya's trace now passes every gate: Usable.",
        narration:
          "Open Maya's trace again. Every gate passes, including group grant and provider connected, so the model is Usable.",
        durationSeconds: 9,
        calloutPlacement: "left-rail",
        focus: "maTraceUsable",
      },
      {
        title: "Hide a model from everyone",
        caption: "Turn off User Access: the row reads Hidden from users.",
        narration:
          "To hide a model from everyone in your organization, turn off its User Access switch. The row reads Hidden from users, and no group carries it.",
        durationSeconds: 11,
        focus: "maHiddenRow",
      },
      {
        title: "Turning it back on is refused",
        caption: "Turning it back on is refused today: \"This model is not available to this organization.\"",
        narration:
          "Know this before you hide a model. Turning it back on from this console is refused today, with: This model is not available to this organization. Nothing changes. Ask your service team to restore it. To narrow access without hiding it, keep at least one group ticked.",
        durationSeconds: 19,
        focus: "maRefused",
      },
      {
        title: "Filter a long catalog",
        caption: "The funnel in Provider, Model, or Runtime Route narrows the list.",
        narration:
          "In a long catalog, use the funnel beside Model, Provider, or Runtime Route. Here the list shows only OpenRouter models. Choose Clear filter to see everything again.",
        durationSeconds: 13,
        focus: "maFiltered",
      },
    ],
  },
  {
    id: "admin-model-requests",
    audioSrc: "training/admin/admin-model-requests.mp3",
    title: "Review model requests and explain access",
    description: "Approve a person's model request into the right group, decline another, and confirm both from the person's view and the access trace.",
    icon: "models",
    track: "Accounts and access",
    outcomes: ["Request reviewed", "Approved through the narrowest group", "Decline confirmed", "Result traced"],
    prerequisites: [
      "An Admin account and the groups you grant through.",
      "Model requests allowed by service policy. When they are not, people see only the models they can already use and cannot send requests.",
    ],
    setupSteps: [
      "The person opens the model menu, chooses Why isn't a model listed?, and chooses Request access on a Locked model. They see \"Request sent for …. An administrator will review it.\"",
      "Choose Admin console › Model Access. Access requests lists the person, the model, and the server's reason.",
      "In Grant through group, choose the narrowest group that should carry the model. A group marked (also grant model to group) does not carry it yet; approving grants it to every member.",
      "Choose Approve. The panel reads \"… can now use … through ….\"",
      "Choose Decline for requests you will not grant. The panel reads \"Declined the request from ….\"",
      "Ask the person to reopen Why isn't a model listed?, and check Users › Access for them.",
    ],
    paths: [
      {
        label: "Approve through a group that already has the model",
        steps: [
          "Choose a group listed without a suffix. Approving adds the person to it; nobody else gains access.",
        ],
      },
      {
        label: "Approve and widen a group (shown)",
        steps: [
          "Choose a group marked (also grant model to group).",
          "Read the hint: approving grants the model to everyone in the group. Check its members first.",
        ],
      },
      {
        label: "Decline (shown)",
        steps: [
          "Choose Decline. The request leaves the queue, and the person's model reads Locked again with Request access available.",
        ],
      },
    ],
    verify: [
      "The panel reads \"… can now use … through ….\" and the request leaves the queue.",
      "The person's Models in your organization dialog no longer shows the model as Locked.",
      "Users › Access for the person shows group_grant passed for that model.",
    ],
    troubleshooting: [
      { symptom: "\"Choose the group that should carry this model before approving.\"", fix: "Choose a group in Grant through group. If one is already shown, choose another group and then the one you want." },
      { symptom: "\"Approved, but the server still reports: …\"", fix: "The approval worked but another gate still blocks the model, such as an offline provider. The trace shows which." },
      { symptom: "\"This request has already been resolved.\"", fix: "Another administrator approved or declined it. Choose Refresh." },
      { symptom: "Approve is refused because the model is disabled for the whole service", fix: "Ask your service team to enable the model, then approve again." },
      { symptom: "The person sees \"Model access requests are disabled by organization policy.\"", fix: "Service policy does not allow model requests. Grant access through a group instead." },
      { symptom: "The person sees \"A request for this model is already pending.\"", fix: "Their earlier request is still in your queue." },
    ],
    scenes: [
      {
        title: "The person finds a locked model",
        caption: "Model menu › Why isn't a model listed? shows each model and the reason.",
        narration:
          "Requests start with the person. In the model menu, they choose Why isn't a model listed? Models in your organization explains every model. This one is Locked: none of their groups grants it.",
        durationSeconds: 14,
        focus: "mrUserDialog",
      },
      {
        title: "They request access",
        caption: "Request access sends it to administrators.",
        narration:
          "They choose Request access. The dialog confirms: Request sent. An administrator will review it.",
        durationSeconds: 8,
        focus: "mrUserRequested",
      },
      {
        title: "Your queue",
        caption: "Model Access › Access requests: who, which model, and the server's reason.",
        narration:
          "In Admin console, open Model Access. Access requests lists each person, the model they want, and the server's reason. These are model requests; requests to join the workspace stay on Users.",
        durationSeconds: 15,
        focus: "mrQueue",
      },
      {
        title: "Choose the group",
        caption: "\"Also grant model to group\" means every member gains the model.",
        narration:
          "Choose Grant through group. Approving adds the person to that group. A group marked also grant model to group doesn't carry the model yet, and the hint warns that everyone in it gains access. Choose the narrowest group that fits, then Approve.",
        durationSeconds: 17,
        focus: "mrGroupChoice",
      },
      {
        title: "Read the decision",
        caption: "The panel names the person, the model, and the group.",
        narration:
          "Read the result. The panel names the person, the model, and the group that now carries it.",
        durationSeconds: 7,
        focus: "mrApproved",
      },
      {
        title: "Decline another request",
        caption: "Decline removes it from the queue. The person can ask again.",
        narration:
          "For a request you won't grant, choose Decline. The panel confirms it. The model stays locked for that person, and they can ask again later.",
        durationSeconds: 10,
        focus: "mrDeclined",
      },
      {
        title: "What the person sees now",
        caption: "The approved model is no longer Locked; only its provider is offline here.",
        narration:
          "The person reopens the dialog. The approved model is no longer Locked. In this example its provider is offline, so it reads Provider offline: the grant is in place, and your service team reconnects the provider.",
        durationSeconds: 16,
        focus: "mrUserAfter",
      },
      {
        title: "Confirm with the trace",
        caption: "Users › Access: group_grant passes for the approved model.",
        narration:
          "Confirm it from Users with Access. For the approved model, group grant now passes. The declined model still stops at group grant.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        focus: "mrTrace",
      },
    ],
  },
  {
    id: "admin-sso",
    audioSrc: "training/admin/admin-sso.mp3",
    title: "Tenant SSO and provisioning",
    description: "Set up your organization's single sign-on from the Admin console: check that policy allows it, create and test the connection, sign a test person in, map groups, enforce it, and recognize the read-only state.",
    icon: "sso",
    track: "Sign-in",
    outcomes: [
      "Connection created and tested",
      "Test person signed in and provisioned",
      "Groups mapped and synced",
      "Enforcement on, with its refusal recognized",
    ],
    prerequisites: [
      "An Admin account, with SSO management allowed by service policy: the SSO tab shows Add SSO configuration. If it shows \"Organization policy makes SSO configuration read-only in this console.\" instead, ask your service team.",
      "An OpenID Connect application at your identity provider, with its issuer URL, client ID, and client secret. The paths below list the exact settings for Keycloak, Microsoft Entra ID, Okta, and Google Workspace.",
      "The redirect URI shown under the Add SSO configuration form, registered exactly at the identity provider.",
      "A groups claim in the ID token if you will map groups. Google sends none.",
      "A test account at the provider with a verified email on one of your domains.",
    ],
    setupSteps: [
      "Choose Admin console › SSO. If it reads \"Organization policy makes SSO configuration read-only in this console.\" and has no Add SSO configuration button, ask your service team to allow SSO management.",
      "Choose Add SSO configuration.",
      "In Identity provider, choose your preset: Microsoft Entra ID, Google Workspace, Okta, or Custom OIDC provider.",
      "Enter the Issuer URL, Client ID, and Allowed email domains. Keep Provision new users on first sign-in (JIT) on.",
      "Register the redirect URI shown under the form at your identity provider.",
      "Paste the Client secret last, then choose Create SSO configuration. Enforcement starts off.",
      "On the new card, choose Test connection. Discovery document, Signing keys (JWKS), and Sign-in readiness must all pass.",
      "In a private window, enter the test person's email, choose Continue with SSO, and sign in at the provider. Users then lists them with sso under Auth.",
      "On the card, choose Add mapping for each identity-provider group value, choose the tenant group, and choose Save mappings.",
      "Have the test person sign in again, then check Users with Filter users by group.",
      "When everyone can sign in through the provider, turn on Enforce for tenant sign-in.",
      "Confirm that a local password on the domain is now refused.",
    ],
    paths: [
      {
        label: "Custom OIDC provider, such as Keycloak (shown)",
        steps: [
          "Choose Custom OIDC provider. Enter the issuer, such as https://your-keycloak-host/realms/your-realm.",
          "At Keycloak: a confidential client with Client authentication on, Standard flow, Require PKCE S256, the redirect URI, and a Group Membership mapper named groups with Full group path off.",
          "Map group values exactly as they appear in the token, such as litigation.",
        ],
      },
      {
        label: "Microsoft Entra ID",
        steps: [
          "Choose Microsoft Entra ID. The issuer is prefilled; replace {tenant-id} with your Directory (tenant) ID. Never use common or organizations.",
          "Use the client secret's Value, not its Secret ID.",
          "At Entra: App registrations › New registration (Web, the redirect URI), Certificates & secrets › New client secret, and Token configuration › Add groups claim. Group claims carry object IDs, so map each group's object ID.",
        ],
      },
      {
        label: "Okta",
        steps: [
          "Choose Okta. The preset fills https://{your-domain}.okta.com; replace it with your Okta domain.",
          "At Okta: Applications › Create App Integration › OIDC, Web Application, Authorization Code, the redirect URI. For group mapping, use the custom authorization server, https://your-org.okta.com/oauth2/default, and add a groups claim to the ID token.",
        ],
      },
      {
        label: "Google Workspace",
        steps: [
          "Choose Google Workspace. The issuer is https://accounts.google.com.",
          "Google ID tokens carry no groups, so manage group membership on the Groups tab instead of mapping.",
        ],
      },
      {
        label: "When SSO management is read-only (shown)",
        steps: [
          "The SSO tab shows \"Organization policy makes SSO configuration read-only in this console.\"",
          "Existing cards stay visible and keep working, but you cannot add, test, map, enforce, or remove. Ask your service team.",
        ],
      },
    ],
    verify: [
      "Test connection lists Discovery document, Signing keys (JWKS), and Sign-in readiness as passed.",
      "The test person reaches the workspace, and Users lists them with the USER role and sso under Auth.",
      "After their next sign-in, Users filtered to the mapped group lists them.",
      "The card reads enforced, and a local password on the domain is refused with \"SSO is enforced for this email domain; local sign-in is disabled. Use the configured identity provider.\"",
    ],
    troubleshooting: [
      { symptom: "\"Organization policy makes SSO configuration read-only in this console.\"", fix: "Service policy does not let administrators manage SSO, so the tab has no Add SSO configuration button. Ask your service team." },
      { symptom: "Create SSO configuration stays unavailable", fix: "Issuer URL and Client ID are required." },
      { symptom: "\"Issuer verified, but sign-in stays disabled until you add: client secret.\"", fix: "The secret was not saved, or allowed domains are missing. Cards cannot be edited: choose Remove and create the configuration again with every field." },
      { symptom: "Test connection fails at Discovery document", fix: "The issuer URL is wrong or unreachable from the server. Open the issuer followed by /.well-known/openid-configuration; for Entra use your tenant ID." },
      { symptom: "The card shows Custom Oidc instead of the display name you typed", fix: "A known limitation: the card is labeled by provider type, and the display name is not kept yet. Identify cards by their issuer." },
      { symptom: "Mapped groups do not appear after sign-in", fix: "The claim value must match exactly, including case and any leading slash, and the provider must add the groups claim to the ID token. Membership updates at the next sign-in." },
      { symptom: "\"… is outside the domains allowed for this SSO provider.\"", fix: "The provider vouched for an address on another domain. Add the domain by recreating the configuration, or keep that person out." },
      { symptom: "\"SSO is enforced for this email domain; local sign-in is disabled. Use the configured identity provider.\"", fix: "Expected after enforcement. The person chooses Continue with SSO. Turn enforcement off on the card to allow passwords again." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "SSO management allowed, provider admin access, your domains, a test account, and a way back in.",
        narration:
          "This lesson sets up single sign-on for your organization from the Admin console, from start to finish. Before you begin, have five things: service policy that lets you manage S S O, administrator access to your identity provider, your email domains, a test account with a verified email, and an administrator account that can still sign in with a local password.",
        durationSeconds: 25,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "The SSO tab offers Add SSO configuration.",
            "Administrator access to your identity provider.",
            "Your email domains, such as examplecorp.com.",
            "A test account with a verified email on one of those domains.",
            "A way back in: an admin who signs in with a local password on a domain you will not enforce.",
          ],
        },
      },
      {
        title: "Read-only until policy allows it",
        caption: "Admin console › SSO: read-only until service policy allows SSO management.",
        narration:
          "Open Admin console, S S O. When service policy doesn't let administrators manage S S O, the tab is read-only, with a Policy note and no Add button.",
        durationSeconds: 12,
        focus: "ssoReadonlyEmpty",
      },
      {
        title: "When service policy allows it",
        caption: "The Policy note is gone and Add SSO configuration appears.",
        narration:
          "Once your service team allows administrators to manage S S O, the Policy note is gone, and Add S S O configuration appears at the top of the tab. Secrets you enter stay vaulted on the server. If the note is still there, ask your service team.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "ssoPolicyAvailable",
      },
      {
        title: "Register the app at your provider",
        caption: "Outside Aperture Chat: a confidential OIDC app, the redirect URI, a secret, and a groups claim.",
        narration:
          "At your identity provider, create a confidential OpenID Connect web application with the authorization code flow, and register the redirect URI from the Add S S O configuration form. Copy the client I D and secret. Add a groups claim if you will map groups, and create a test person with a verified email. The written paths list each provider's settings.",
        durationSeconds: 25,
        card: {
          where: "Your identity provider's admin console",
          steps: [
            "Create a confidential OpenID Connect web app with the authorization code flow (Keycloak: Client authentication on, Require PKCE S256).",
            "Register the redirect URI from Aperture Chat's form exactly. No wildcards.",
            "Copy the client ID and the client secret.",
            "If you will map groups, add a groups claim to the ID token.",
            "Create the groups and a test person with a verified email on your domain.",
          ],
          values: [
            { label: "Redirect URI", value: "https://your-instance.example/api/auth/sso/callback" },
            { label: "Keycloak issuer", value: "https://your-keycloak-host/realms/your-realm" },
          ],
        },
      },
      {
        title: "Start a configuration: Entra",
        caption: "Add SSO configuration. Microsoft Entra ID prefills the issuer; replace {tenant-id}.",
        narration:
          "Back in Aperture Chat, choose Add S S O configuration. Identity provider starts on Microsoft Entra I D, and the issuer is prefilled. Replace the tenant I D placeholder with your directory I D.",
        durationSeconds: 15,
        focus: "ssoPresetEntra",
      },
      {
        title: "The Okta preset",
        caption: "Okta fills https://{your-domain}.okta.com. Use /oauth2/default to map groups.",
        narration:
          "Okta fills your Okta domain as a placeholder. To map groups, use the custom authorization server instead, ending in slash oauth two, slash default.",
        durationSeconds: 12,
        focus: "ssoPresetOkta",
      },
      {
        title: "The Google preset",
        caption: "Google Workspace fills https://accounts.google.com. Google sends no groups.",
        narration:
          "Google Workspace fills accounts dot google dot com. Google sends no groups claim, so manage groups on the Groups tab.",
        durationSeconds: 9,
        focus: "ssoPresetGoogle",
      },
      {
        title: "Enter the provider details",
        caption: "Custom OIDC provider: issuer, client ID, and allowed email domains.",
        narration:
          "This walkthrough uses Custom O I D C provider, with Keycloak. Enter the issuer U R L, the client I D, and the allowed email domains. Only addresses on those domains can sign in through this provider.",
        durationSeconds: 16,
        focus: "ssoFields",
      },
      {
        title: "Provisioning, redirect, and create",
        caption: "Keep JIT on, check the redirect URI, paste the secret last, then Create.",
        narration:
          "Keep Provision new users on first sign-in on, so accounts are created with the User role. Check that the redirect URI below matches what you registered. Paste the client secret last; it's vaulted and never shown again. Choose Create S S O configuration. Enforcement always starts off.",
        durationSeconds: 20,
        focus: "ssoCreate",
      },
      {
        title: "The new card",
        caption: "Protocol, issuer, domains, and JIT. The card is labeled by provider type.",
        narration:
          "The card shows the protocol, issuer, domains, and provisioning. It's labeled Custom O I D C rather than the name you typed; the display name isn't kept yet, so identify cards by their issuer.",
        durationSeconds: 15,
        focus: "ssoCard",
      },
      {
        title: "Test the connection",
        caption: "Discovery document, signing keys, and sign-in readiness all pass.",
        narration:
          "Choose Test connection. The discovery document loaded, the provider published its signing keys, and sign-in is ready. The test doesn't sign anyone in, so do that next.",
        durationSeconds: 12,
        focus: "ssoTestResult",
      },
      {
        title: "Sign in as the test person",
        caption: "A private window: the email selects Organization SSO. Continue with SSO.",
        narration:
          "Open a private window and go to the workspace. Enter the test person's email. Their domain selects Organization S S O. Choose Continue with S S O.",
        durationSeconds: 12,
        calloutPlacement: "right-mid",
        focus: "ssoSignin",
      },
      {
        title: "Authenticate at the provider",
        caption: "The provider's own page. Aperture Chat never sees this password.",
        narration:
          "The browser moves to the identity provider's own sign-in page, with any multifactor check it requires. Aperture Chat never sees this password.",
        durationSeconds: 11,
        calloutPlacement: "right-mid",
        focus: "ssoIdpLogin",
      },
      {
        title: "Arrive in the workspace",
        caption: "The ID token is verified and the account is created.",
        narration:
          "The provider sends them back. Aperture Chat verifies the signed I D token, creates the account, and opens the workspace.",
        durationSeconds: 10,
        focus: "ssoWelcome",
      },
      {
        title: "The provisioned account",
        caption: "Users: role User, Default Users, and sso under Auth.",
        narration:
          "On Users, the new person is listed with the User role, in Default Users, with S S O under Auth.",
        durationSeconds: 8,
        focus: "ssoJitRow",
      },
      {
        title: "Map identity-provider groups",
        caption: "Add mapping: the claim value, then the tenant group. Save mappings.",
        narration:
          "Back on the S S O tab, choose Add mapping. Enter the value exactly as the provider sends it, and choose a tenant group. Here, litigation maps to Litigation, and finance to Finance Team. Choose Save mappings. S S O now owns membership in those groups.",
        durationSeconds: 19,
        focus: "ssoMappings",
      },
      {
        title: "Groups follow the next sign-in",
        caption: "After a fresh sign-in, the person appears in the mapped group.",
        narration:
          "Membership updates at each sign-in. After the test person signs in again, Users filtered to Litigation lists them, from their litigation group at the provider.",
        durationSeconds: 12,
        focus: "ssoSyncedRow",
      },
      {
        title: "Enforce SSO",
        caption: "Enforce for tenant sign-in: the card reads enforced.",
        narration:
          "When everyone can sign in through the provider, turn on Enforce for tenant sign-in. The card reads enforced, and password sign-in ends for your domains.",
        durationSeconds: 11,
        focus: "ssoEnforceRow",
      },
      {
        title: "Passwords on the domain are refused",
        caption: "A local password on an enforced domain is refused with a clear message.",
        narration:
          "Here is what people see. This account had a local password on the domain. Password sign-in now fails with: S S O is enforced for this email domain; local sign-in is disabled. They choose Continue with S S O instead.",
        durationSeconds: 16,
        calloutPlacement: "right-mid",
        focus: "ssoRefused",
      },
      {
        title: "When SSO is read-only",
        caption: "Cards stay visible and keep working, but every control is read-only.",
        narration:
          "If service policy stops allowing S S O management, the Policy note returns. Your configuration keeps working, but mappings, enforcement, testing, and removal are read-only in this console.",
        durationSeconds: 15,
        focus: "ssoReadonlyCard",
      },
    ],
  },
  {
    id: "admin-policies",
    audioSrc: "training/admin/admin-policies.mp3",
    title: "Policies and memory governance",
    description: "Read what service policy allows, set the Default Users capabilities, tune personalization memory, purge a person's memories without reading them, and recognize when memory is unavailable.",
    icon: "policies",
    track: "Workspace controls",
    outcomes: [
      "Service limits understood",
      "Default Users capability granted and confirmed",
      "Memory retention set",
      "Memories purged without reading them",
    ],
    prerequisites: [
      "An Admin account.",
      "Service policy sets the ceiling: what is locked here is decided by your service team.",
    ],
    setupSteps: [
      "Choose Admin console › Policies. Its sections start collapsed; expand Policy Controls.",
      "If your service team limits anything you cannot change here, a Service policy note at the bottom of Policy Controls says so. No note means nothing is limited.",
      "Switch on the Default users capabilities you want: downstream API, build agents, build knowledge bases, add API sources, build tools (their own MCP connections), use Hermes agents, and use memory. All except memory start off. Each saves with \"Default user policy saved.\"",
      "Confirm the change in Groups › Default Users › Permissions.",
      "Expand Personalization Memory. Set Memory for this organization and Learn from conversations automatically.",
      "Type Retention (days), 1 to 3650, or Maximum memories per user, 1 to 2000, and press Enter. The status reads \"Memory policy saved.\"",
      "Expand Memory by User and choose Refresh. To delete one person's memories, choose Purge, then Yes, purge.",
    ],
    paths: [
      {
        label: "What the Service policy note can say",
        steps: [
          "\"Administrator accounts are created by your service team.\" Admin is not offered when you add or approve people.",
          "\"Administrators must sign in with SSO.\" Administrator accounts cannot use email and password.",
          "\"Newly available models start without access until you grant a group in Model Access.\" Grant each new model yourself.",
          "Whether you can edit SSO is shown on the SSO tab itself.",
        ],
      },
      {
        label: "What each Default users switch changes",
        steps: [
          "Downstream API: people can create personal API keys for their approved models.",
          "Build agents, knowledge bases, or tools: people can create their own private ones. Sharing and publishing stay with administrators.",
          "Add API sources: people can connect API endpoints, with keys or provider sign-in, to their own knowledge bases. It needs build knowledge bases first.",
          "Use Hermes agents: people can open Hermes agents and Hermes connections. Off, these appear locked and never run.",
          "Use memory: the assistant saves and recalls each person's private preferences.",
        ],
      },
      {
        label: "When memory is off for the platform (shown)",
        steps: [
          "Policies shows a single Memory governance panel: \"Personalization memory is unavailable under the current service policy. Saved organization settings remain intact.\"",
          "Your saved settings return when service policy allows memory again.",
        ],
      },
    ],
    verify: [
      "The status reads \"Default user policy saved.\" and the matching switch is on in Groups › Default Users › Permissions.",
      "\"Memory policy saved.\" and the new value remains after reopening Policies.",
      "After a purge the status reads \"Deleted N memories for ….\" and the person leaves Memory by User.",
    ],
    troubleshooting: [
      { symptom: "\"Unavailable under the current service policy. The saved group grant is preserved.\"", fix: "Service policy has that capability off. Your earlier grant returns when it is turned back on." },
      { symptom: "\"Turn on Memory for this organization below before granting the default group access.\"", fix: "Turn on Memory for this organization in Personalization Memory first." },
      { symptom: "\"Turn on knowledge bases above first; API sources live inside a person's own knowledge base.\"", fix: "Switch on Default users can build knowledge bases, then Default users can add API sources." },
      { symptom: "A memory number did not change", fix: "Values outside 1 to 3650 days or 1 to 2000 memories are ignored. Type a value in range and press Enter." },
      { symptom: "\"Memory policy was not saved. Personalization memory is unavailable under the current service policy.\"", fix: "Service policy has personalization memory off. Ask your service team." },
      { symptom: "\"Default user policy could not be saved.\"", fix: "Nothing changed. Reload Policies and try again; if it repeats, check the Audit trail for the refusal." },
    ],
    scenes: [
      {
        title: "Policies, collapsed",
        caption: "Admin console › Policies: Policy Controls, Personal Data Protection, and the memory sections.",
        narration:
          "Open Admin console, Policies. Its sections start collapsed: Policy Controls, Personal Data Protection, Personalization Memory, and Memory by User. When service policy turns memory off, a single Memory governance panel replaces the last two.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "policyCollapsed",
      },
      {
        title: "What service policy allows",
        caption: "The Service policy note names only what your service team limits here.",
        narration:
          "Expand Policy Controls. At the bottom, a Service policy note names anything your service team limits that you can't change here. In this workspace, administrator accounts are created by your service team. When nothing is limited, there is no note.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "policyServiceAvailability",
      },
      {
        title: "Default Users capabilities",
        caption: "Seven switches set what Default Users can do. A dimmed one is limited or waits on another.",
        narration:
          "Above it, seven switches set what Default Users can do: create personal A P I keys, build private agents and knowledge bases, add A P I sources to those knowledge bases, build tools, use Hermes agents, and use memory. A dimmed switch is off under service policy, or waits on another switch; your saved choice is kept.",
        durationSeconds: 22,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "policyDefaults",
      },
      {
        title: "Grant a capability",
        caption: "Each switch saves immediately: \"Default user policy saved.\"",
        narration:
          "Switch on Default users can build knowledge bases. It saves at once, and Default users can add A P I sources unlocks below it, because A P I sources live inside a person's own knowledge base. Sharing knowledge bases with groups stays with administrators.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "polKnowledgeRow",
      },
      {
        title: "The same switch in Groups",
        caption: "Groups › Default Users › Permissions shows the same grant.",
        narration:
          "These switches are the Default Users group's permissions. Open Groups, Default Users, Permissions, and Can build knowledge bases is on.",
        durationSeconds: 10,
        focus: "polVerifyRow",
      },
      {
        title: "Personalization Memory",
        caption: "Memory for this organization, automatic learning, retention, and capacity.",
        narration:
          "Expand Personalization Memory. Memory for this organization lets people keep private preferences that the assistant applies on every turn. Learn from conversations automatically lets it infer them; when off, only things people state outright are saved.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "policyMemory",
      },
      {
        title: "Set retention and capacity",
        caption: "Retention 1 to 3650 days; up to 2000 memories per user. Press Enter to save.",
        narration:
          "Retention retires memories older than the number of days you set, from one to three thousand six hundred fifty. Maximum memories per user ranges from one to two thousand. Type a value and press Enter; the status confirms Memory policy saved.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "polRetentionField",
      },
      {
        title: "Purge without reading",
        caption: "Memory by User shows counts only. Purge asks you to confirm.",
        narration:
          "Memory by User shows counts, never content. Choose Refresh, then Purge beside a person. Read the confirmation, Purge all, this cannot be undone, and choose Yes, purge.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "polPurgeConfirm",
      },
      {
        title: "Purged",
        caption: "The status confirms how many memories were deleted.",
        narration:
          "The status confirms how many memories were deleted, and the person leaves the list. You never saw what any memory said.",
        durationSeconds: 9,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "policyCounts",
      },
      {
        title: "When memory is unavailable",
        caption: "When service policy turns memory off, Memory governance explains it.",
        narration:
          "When service policy turns personalization memory off, Policies shows Memory governance instead. Your organization's saved settings stay intact and return when memory is turned back on.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "polMemoryOff",
      },
    ],
  },
  {
    id: "admin-connectors",
    audioSrc: "training/admin/admin-connectors.mp3",
    title: "Manage workspace connectors",
    description: "Turn sources on for your workspace, configure and test web search and each cloud file source, hide a source from the attach menu, and recognize a source your service team has turned off.",
    icon: "connectors",
    track: "Workspace controls",
    outcomes: [
      "Web Search turned on and tested",
      "Each cloud source saved and tested, with its real result read",
      "A cloud source hidden from people and shown again",
      "A source turned off for every workspace recognized",
    ],
    prerequisites: [
      "An Admin account.",
      "For cloud sources: an administrator at the vendor (Google Cloud, Microsoft Entra, Box, or iManage) who can register an application and grant consent.",
      "Your workspace's address. Connector redirect URIs are that address followed by /api/connector-oauth/callback.",
      "For SearXNG: your own instance's address, with JSON output allowed. For OpenAI, Anthropic, or OpenRouter web search: an active key for that provider, which your service team adds.",
    ],
    setupSteps: [
      "Choose Admin console › Connections. Connectors lists every source and tool for this workspace.",
      "Turn a source on with its switch. The status reads \"… is now on for everyone in this workspace.\" Off removes it everywhere: chat, pickers, the tool library, and the API.",
      "Choose Configure on Web Search, pick a Search engine and Results per search, and choose Save configuration.",
      "Choose Test connection and read every line of the result.",
      "For a cloud source, do the vendor steps first (see the paths), then choose Configure, pick the Authentication method, fill in the vendor's values and the secret, and choose Save configuration.",
      "Choose Test connection and read the result. For Google Drive, finish with Connect Google Drive.",
      "To keep a cloud source out of people's attach menu without turning it off, choose Hide. The row reads Hidden; choose Show to offer it again.",
      "Check from a person's account: the chat paperclip menu lists only the sources you have not hidden.",
    ],
    paths: [
      {
        label: "Web Search (shown)",
        steps: [
          "Configure › Search engine: DuckDuckGo (keyless), SearXNG (your own instance), or OpenAI, Anthropic, or OpenRouter web search.",
          "DuckDuckGo needs no key, but it limits automated searches from busy servers, and the server must be able to reach it; the test names the reason when it fails.",
          "SearXNG: enter the SearXNG instance URL. The instance must allow JSON output (search.formats must include json). Test connection runs a real search.",
          "OpenAI, Anthropic, or OpenRouter web search reuse that provider's key, and each search is billed to that account. Your service team adds provider keys.",
          "Results per search: how many results are added to the prompt as cited context, 1 to 10.",
        ],
      },
      {
        label: "Google Drive (shown)",
        steps: [
          "In Google Cloud, enable the Drive API, set up the Google Auth Platform with the drive.readonly scope, and create a Web application client with the redirect URI.",
          "Configure › Google OAuth (recommended): OAuth client ID, optional Drive folder ID and Source label, and the OAuth client secret. Save configuration.",
          "Choose Connect Google Drive and sign in with the workspace account used for knowledge sync, then Test connection.",
          "People connect their own Google account from the attach menu and see only their own files.",
        ],
      },
      {
        label: "OneDrive / SharePoint / Outlook (Microsoft Graph) (shown)",
        steps: [
          "In Entra, register a single-tenant app, add Files.Read.All (and Sites.Read.All) as application permissions, grant admin consent, and create a client secret.",
          "Configure › App-only (client credentials, recommended): Directory (tenant) ID, Application (client) ID, optional SharePoint site, Drive, and Root folder IDs, and the Client secret. Save configuration.",
          "Test connection requests a token and calls Graph.",
          "For chat attachments, also add the scopes as delegated permissions and the Web redirect URI.",
        ],
      },
      {
        label: "Box (shown)",
        steps: [
          "In the Box Developer Console, create a Server app with Client Credentials Grant, App + Enterprise Access, and Read all files and folders; a Box admin authorizes it in Admin Console › Platform › Platform Apps.",
          "Configure › Client Credentials Grant (recommended): Client ID, Enterprise ID, optional Folder ID, and the Client secret. Save configuration, then Test connection.",
          "For chat attachments, also enable OAuth 2.0 (Authorization Code) on the app with the redirect URI.",
        ],
      },
      {
        label: "iManage (shown)",
        steps: [
          "In iManage Control Center, add a Web, confidential application with the redirect URI and refresh tokens allowed.",
          "Configure › Each user signs in (recommended): Instance URL, API key (client ID), Customer ID, Library ID, optional Workspace ID, and the OAuth client secret. Save configuration.",
          "Test connection confirms the settings; each person completes verification by opening iManage from chat and signing in.",
          "Service account for background sync is only for knowledge sync; chat always uses each person's own sign-in.",
        ],
      },
      {
        label: "Hide a cloud source (shown)",
        steps: [
          "Choose Hide on Google Drive, OneDrive / SharePoint / Outlook, Box, or iManage. Its switch and credentials stay as they are, so knowledge sync keeps running.",
          "People no longer see it in the chat or Drafts attach menu. Choose Show to offer it again.",
        ],
      },
      {
        label: "A source off for every workspace (shown)",
        steps: [
          "When your service team turns a source off for every workspace, its row reads Off for all workspaces and its switch is locked off.",
          "Your saved settings stay. Ask your service team to allow it again; then your own switch decides.",
        ],
      },
    ],
    verify: [
      "The switch shows the new state, and the status reads \"… is now on for everyone in this workspace.\"",
      "Web Search's Test connection reads \"Web search is working through …\" with a live result.",
      "A cloud source's Test connection lists Required fields, Authentication, and API access as passed, or names the next step.",
      "After Hide, the row reads Hidden and a person's paperclip menu no longer lists the source.",
    ],
    troubleshooting: [
      { symptom: "\"Web search test failed: DuckDuckGo returned a page with no parseable results (it rate-limits automated queries). …\"", fix: "DuckDuckGo limits automated searches from busy servers. Retry later, or switch to SearXNG or a provider's web search." },
      { symptom: "\"Web search test failed: DuckDuckGo request failed: ConnectTimeout\"", fix: "The server could not reach DuckDuckGo in time. Check that your deployment can reach the internet, retry, or choose SearXNG." },
      { symptom: "\"Set the SearXNG instance URL, or switch the engine to DuckDuckGo.\"", fix: "Enter your SearXNG instance URL, or choose DuckDuckGo." },
      { symptom: "\"OpenAI web search reuses the workspace's OpenAI provider key. Add an active OpenAI key under Providers, or switch to a keyless engine.\"", fix: "Provider keys are added by your service team. Ask them for the key, or choose DuckDuckGo or SearXNG." },
      { symptom: "\"Google Drive is not connected: no refresh token is stored. …\"", fix: "Save the client ID and secret, then choose Connect Google Drive and finish Google's consent screen." },
      { symptom: "\"Microsoft Graph token request failed: token endpoint returned HTTP 400: AADSTS90002: Tenant '…' not found. …\"", fix: "The Directory (tenant) ID is wrong. Copy it from the app's Overview page in Entra." },
      { symptom: "\"Box token request failed: token endpoint returned HTTP 400: The client credentials are invalid\"", fix: "Check the Client ID and secret, and that a Box admin authorized the app in Platform Apps." },
      { symptom: "\"Fill in: …\"", fix: "A required field (marked *) or the secret is empty. Fill it in and save again." },
      { symptom: "A row reads Saved · disabled", fix: "Its credentials are saved, but the source is switched off in this workspace. Turn its switch on." },
      { symptom: "A row reads Off for all workspaces and its switch is dimmed", fix: "Your service team has turned the source off for every workspace. Ask them to allow it again." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "An Admin account, vendor administrators for cloud sources, and your workspace's address.",
        narration:
          "This lesson manages the sources and tools your workspace can use. Before you begin, have an administrator at each cloud vendor you will connect, your workspace's address for the redirect U R I, and, to use your own search engine, your SearXNG address.",
        durationSeconds: 18,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "An Admin account.",
            "An administrator at each cloud vendor: Google Cloud, Microsoft Entra, Box, or iManage.",
            "Your workspace's address; redirect URIs end in /api/connector-oauth/callback.",
            "For SearXNG, your instance's address, with JSON output allowed.",
          ],
        },
      },
      {
        title: "Find Connectors",
        caption: "Off removes a source everywhere; Hide only takes it out of the attach menu.",
        narration:
          "Open Admin console, Connections. Connectors lists every source and tool for this workspace. Read the subtitle: Off removes a connector everywhere, in chat, pickers, the tool library, and the A P I. Hide only takes a cloud source out of the attach menu.",
        durationSeconds: 18,
        focus: "cnPanel",
      },
      {
        title: "Turn a source on",
        caption: "Switch Web Search on: it is on for everyone in this workspace.",
        narration:
          "Here Web Search is off. Switch it on, and the status confirms that Web Search is now on for everyone in this workspace. Built-in tools, such as M C P Servers and Prompt Library, have only a switch.",
        durationSeconds: 15,
        focus: "cnWebOn",
      },
      {
        title: "Test DuckDuckGo",
        caption: "DuckDuckGo needs no key. Here the real test could not reach it in time.",
        narration:
          "Choose Configure. DuckDuckGo needs no key. Choose Save configuration, then Test connection, which runs a real search. In this recording, the request to DuckDuckGo timed out, so the test failed with that reason. DuckDuckGo also limits automated searches from busy servers. Retry later, or choose another engine.",
        durationSeconds: 22,
        calloutPlacement: "left-rail",
        focus: "cnWebTested",
      },
      {
        title: "Use your own SearXNG",
        caption: "SearXNG: your instance's URL, with JSON output allowed. The real search passed.",
        narration:
          "To use your own search instance, choose SearXNG and enter its U R L. The instance must allow J S O N output. Save, then test. This real search passed: web search is working through SearXNG, with five live results.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "cnWebSearxng",
      },
      {
        title: "Keyed search engines",
        caption: "OpenAI, Anthropic, or OpenRouter web search reuse that provider's key and bill that account.",
        narration:
          "You can also choose Open A I, Anthropic, or OpenRouter web search. They reuse that provider's key, and each search is billed to that account. This workspace has no Open A I key, so the test says so. Your service team adds provider keys.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "cnWebKeyed",
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
          "Back in Aperture Chat, choose Configure on Google Drive and keep Google O Auth. Paste the client I D, an optional Drive folder I D to index from, and a source label people will recognize, then the client secret. Choose Save configuration.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "cnDriveForm",
      },
      {
        title: "Authorize, then test",
        caption: "Until Connect Google Drive is completed, the test reports that no refresh token is stored.",
        narration:
          "Test connection checks each step. The fields are complete, but the workspace has not authorized Google yet, so it says no refresh token is stored. Choose Connect Google Drive, sign in with the workspace account on Google's consent screen, and test again.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "cnDriveTested",
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
        focus: "cnGraphForm",
      },
      {
        title: "A real Microsoft answer",
        caption: "With a made-up tenant ID, Microsoft answers AADSTS90002: Tenant not found.",
        narration:
          "This recording used a made-up tenant I D, so Microsoft's token service answered with error A A D S T S nine zero zero zero two: tenant not found. With your real values, the test acquires a token and checks Graph access.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "cnGraphTested",
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
        focus: "cnBoxTested",
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
        focus: "cnImanageTested",
      },
      {
        title: "What people see",
        caption: "A person's paperclip menu lists each cloud source under Attach from source.",
        narration:
          "Now look from a person's side. In a chat, the paperclip menu lists each cloud source under Attach from source: Google Drive, OneDrive, SharePoint, Box, and iManage.",
        durationSeconds: 12,
        focus: "cnUserAttach",
      },
      {
        title: "Hide a source",
        caption: "Hide: the row reads Hidden. Its switch and credentials stay as they are.",
        narration:
          "To keep a source out of that menu without turning it off, choose Hide, here on Box. The status confirms Box is hidden, and the row reads Hidden. Its switch and credentials stay, so knowledge sync keeps running.",
        durationSeconds: 15,
        focus: "cnBoxHidden",
      },
      {
        title: "Gone from the menu",
        caption: "The person's paperclip menu no longer lists Box.",
        narration:
          "The person's paperclip menu no longer offers Box. The Drafts attach menu follows the same setting.",
        durationSeconds: 9,
        focus: "cnUserAttachHidden",
      },
      {
        title: "Show it again",
        caption: "Show puts the source back in the attach menu.",
        narration:
          "Choose Show to offer it again. The status confirms Box is back in the attach menu for people in this workspace.",
        durationSeconds: 9,
        focus: "cnBoxShown",
      },
      {
        title: "Off for every workspace",
        caption: "Off for all workspaces: your service team turned it off, and its switch is locked.",
        narration:
          "Sometimes your service team turns a source off for every workspace. Its row then reads Off for all workspaces, and its switch is locked off. Your saved settings stay. Ask your service team to allow it again; then your own switch decides.",
        durationSeconds: 16,
        focus: "cnOffForAll",
      },
    ],
  },
  {
    id: "admin-tools",
    audioSrc: "training/admin/admin-tools.mp3",
    title: "Response actions and Library connections",
    description: "Build a script response action, test it, give it to a group, use it on a real reply, edit or draft it, and find where tool connections are signed in.",
    icon: "tools",
    track: "Workspace controls",
    outcomes: [
      "Response action built and tested",
      "Used on a real reply by the right group",
      "Edited and switched to Draft",
      "Connection sign-in located",
    ],
    prerequisites: [
      "An Admin account.",
      "A short Python script: it reads the reply on standard input and prints the result.",
      "The group whose members should see the button.",
    ],
    setupSteps: [
      "Choose Admin console › Connections and scroll past Connectors to Chat output actions. It lists every tool; response actions carry a Response action pill.",
      "Choose New response action. Enter Action name, Timeout (seconds, 1–30), Description, and the Python script.",
      "Under Who can run this action, tick the groups that should see it. With none ticked, everyone can.",
      "Under Test run, paste sample text and choose Run test. Read \"Finished in … ms.\" and the output.",
      "Choose Create action. The status reads \"… saved and available to models and chat.\" and the row reads Enabled.",
      "A member opens any assistant reply and chooses the action's button below it. The result opens with Copy and Download.",
      "Choose Edit to change it, or switch it off to set it to Draft and hide it from replies.",
    ],
    paths: [
      {
        label: "Script response action (shown)",
        steps: [
          "The script receives the reply text on standard input and prints its result.",
          "To return files, write them to the folder in APERTURE_ARTIFACT_DIR: up to 8 files, 50 MB each and 75 MB per run. Links appear in the output.",
          "Scripts run isolated, without platform secrets or provider keys, but can reach the network.",
        ],
      },
      {
        label: "Sign a connection in (OAuth)",
        steps: [
          "Open Library › Tools › Connections, choose Edit on the connection, then Sign-in.",
          "Register the Redirect URL at the provider, then choose Connect with provider and approve there.",
          "The badge changes from Not signed in to Signed in — token saved.",
        ],
      },
      {
        label: "Remove an action",
        steps: [
          "Choose the trash button on its row. It is deleted for the whole workspace at once, with no confirmation.",
        ],
      },
    ],
    verify: [
      "Run test shows \"Finished in … ms.\" with the expected output.",
      "Members of the chosen group see the action's button on assistant replies, and it returns the result.",
      "After switching to Draft, the row reads Draft and the button no longer appears on replies.",
    ],
    troubleshooting: [
      { symptom: "\"Script has a syntax error on line …\"", fix: "Fix the line named in the message and run the test again." },
      { symptom: "\"The script timed out.\"", fix: "Raise Timeout (up to 30 seconds) or simplify the script." },
      { symptom: "\"The script exited with an error (code 1).\"", fix: "Read the error output under the result and fix the script." },
      { symptom: "\"Script cannot be empty. It reads input from stdin and prints its result.\"", fix: "Enter a script before saving." },
      { symptom: "A member does not see the button", fix: "Check that the action is Enabled and that one of their groups is ticked under Who can run this action." },
      { symptom: "A sign-in page reads \"Sign-in link expired\"", fix: "Start sign-in again from the connection's Sign-in tab with Connect with provider. The Authorize shortcut on Connections does not complete sign-in today." },
    ],
    scenes: [
      {
        title: "Chat output actions",
        caption: "Chat output actions, below Connectors: buttons on replies, not MCP servers.",
        narration:
          "Open Admin console, Connections, and scroll past Connectors, which has its own lesson. Chat output actions are buttons you add below assistant replies, such as an export or a formatter. They are not M C P servers or model tools; those live in the Library.",
        durationSeconds: 19,
        focus: "responseOverview",
      },
      {
        title: "The response action builder",
        caption: "New response action: a name, a timeout, a description, and a Python script.",
        narration:
          "Choose New response action. The script receives the reply's text on standard input and prints its result. It runs isolated, without platform secrets or provider keys, but it can reach the network, so grant it only to groups you trust.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "toolsBuilder",
      },
      {
        title: "Write the script",
        caption: "Name it, describe it, and paste the script.",
        narration:
          "Name the action, here Checklist, and describe what it adds. This script turns each line of the reply into a numbered checklist item.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        focus: "toolsScript",
      },
      {
        title: "Choose who can run it",
        caption: "Tick groups. With none ticked, every member can use it.",
        narration:
          "Under Who can run this action, tick the groups that should see the button. Here, only Litigation. With no groups ticked, everyone in the workspace can use it.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "toolsGroups",
      },
      {
        title: "Test before saving",
        caption: "Test run: paste sample text, Run test, and read the output.",
        narration:
          "Under Test run, paste sample text and choose Run test. It finished in milliseconds, and the output is a numbered checklist. Errors and time-outs appear here too.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "toolsTestResult",
      },
      {
        title: "Create the action",
        caption: "Create action: the row reads Enabled with a Response action pill.",
        narration:
          "Choose Create action. The status confirms it is saved and available to models and chat, and the new row reads Enabled, with a Response action pill.",
        durationSeconds: 12,
        focus: "toolsSavedRow",
      },
      {
        title: "A member uses it",
        caption: "Below a reply: the action's button, for members of the chosen group.",
        narration:
          "Now a member of Litigation opens a chat. Below each assistant reply, a new button runs the action on that reply.",
        durationSeconds: 9,
        focus: "toolsUserButton",
      },
      {
        title: "The result",
        caption: "The result opens with Copy and Download.",
        narration:
          "The result opens in a dialog: every line of the reply as a checklist item, with Copy and Download.",
        durationSeconds: 9,
        focus: "toolsUserResult",
      },
      {
        title: "Edit an action",
        caption: "Edit opens the same builder. Save changes when done.",
        narration:
          "To change an action, choose Edit on its row. The same builder opens. Here the timeout goes to fifteen seconds. Choose Save changes.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        focus: "toolsEdit",
      },
      {
        title: "Switch it to Draft",
        caption: "Turn it off: Draft hides the button from replies. The trash button deletes it.",
        narration:
          "Switch an action off to set it to Draft. The button disappears from replies until you turn it back on. The trash button deletes it for everyone, with no confirmation.",
        durationSeconds: 12,
        focus: "toolsDraftRow",
      },
      {
        title: "Where connections live",
        caption: "Library › Tools › Connections: MCP servers and other tools, with their status.",
        narration:
          "Connections that models call, such as M C P servers, live in the Library, under Tools. Here, Hermes Agent M C P needs setup: it is not signed in to its provider.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "toolsLibrary",
      },
      {
        title: "Sign a connection in",
        caption: "Edit › Sign-in: register the Redirect URL, then Connect with provider.",
        narration:
          "Choose Edit, then Sign-in. Register the Redirect U R L at the provider, then choose Connect with provider and approve there. The badge then reads Signed in. This capture stops at the hand-off, because it can't sign in to an outside provider. Use this button rather than the Authorize shortcut on Connections, which doesn't complete sign-in today.",
        durationSeconds: 23,
        calloutPlacement: "left-rail",
        focus: "toolsSignIn",
      },
    ],
  },
  {
    id: "admin-personal-data",
    audioSrc: "training/admin/admin-personal-data.mp3",
    title: "Protect personal data",
    description: "Turn on Personal Data Protection, choose what to conceal and whether the model may read it, test it on sample text, and confirm the result in a real chat and in Audit.",
    icon: "privacy",
    track: "Privacy and training data",
    outcomes: [
      "Personal data concealed in chats and records",
      "Model input set to placeholders or values",
      "Concealment previewed on sample text",
      "Result confirmed in a chat and in Audit",
    ],
    prerequisites: [
      "An Admin account.",
      "Your organization's decision on which kinds of personal data must not be stored in chats, and whether the model may read them.",
      "Synthetic test values, such as the sample already in the panel. Never test with a real person's data.",
    ],
    setupSteps: [
      "Choose Admin console › Policies. Personal Data Protection sits below Policy Controls; its header reads Off or On.",
      "Expand it and switch on Conceal personal data. It saves at once for everyone in the organization, and the header reads On.",
      "Leave Hide values from the model too on unless the work needs the model to read the values. When on, typed prompts and attached file text reach the model provider as placeholders.",
      "Under What to conceal, switch off any kind of personal data you do not want concealed. At least one stays on.",
      "Under Try it with sample text, keep or edit the synthetic sample and choose Preview concealment. Read the count, the concealed text, and the pill for each detector. The preview is not saved or logged.",
      "Read Where it applies, and the limits below it.",
      "Have a person send a message with a synthetic value. It shows a locked chip such as SSN, and the line under their message box ends with Personal data is concealed.",
      "Choose Audit › User Prompt Activity › Refresh monitor: the prompt shows the same chip.",
      "In the Audit Trail choose Refresh and search privacy. PROMPT_CONCEALED records each concealed message; POLICY_UPDATED records your change.",
    ],
    paths: [
      {
        label: "Keep values from the model (default, shown)",
        steps: [
          "Hide values from the model too: on.",
          "The model receives placeholders such as ⟦SSN⟧ instead of the value, so its reply refers to the placeholder, for example [SSN].",
          "Use this when the model does not need the value to do the work, such as drafting a note or summarizing a record.",
        ],
      },
      {
        label: "Let the model read the values (shown)",
        steps: [
          "Switch off Hide values from the model too. The row reads \"The model reads the original value for that turn. It is still concealed everywhere it is stored or shown.\"",
          "Use this when the work needs the value, such as filling in a form or a signature block.",
          "Values the model writes are concealed before the reply reaches the browser and before it is saved.",
        ],
      },
      {
        label: "Narrow what is concealed",
        steps: [
          "Under What to conceal, switch a kind of personal data off or on. Each switch saves at once.",
          "Each card lists the values it finds. For example, Contact details covers email addresses, phone numbers, and street addresses.",
          "The last switch that is on cannot be turned off. To stop concealing, switch off Conceal personal data instead.",
        ],
      },
      {
        label: "Turn protection off (shown)",
        steps: [
          "Switch off Conceal personal data. The header reads Off, and new chats are stored and shown exactly as typed.",
          "Content filters attached to individual models still apply.",
          "Chats saved while protection was on stay concealed: their values were never stored, so they cannot come back.",
        ],
      },
    ],
    verify: [
      "The panel header reads On.",
      "Preview concealment reports the values concealed, for example \"6 values concealed\", with a pill for each detector.",
      "A test message shows locked chips in the chat and in Audit › User Prompt Activity.",
      "The Audit Trail lists PROMPT_CONCEALED for the message and POLICY_UPDATED for your change.",
    ],
    troubleshooting: [
      { symptom: "A kind of personal data cannot be switched off", fix: "At least one stays selected. Switch another one on first, or switch off Conceal personal data." },
      { symptom: "Hide values from the model too is dimmed", fix: "It applies only while Conceal personal data is on." },
      { symptom: "\"Nothing detected\"", fix: "The sample has no value the selected kinds recognize. Detection checks formats and checksums, so a look-alike such as a card number that fails its check digit is left alone." },
      { symptom: "A name or a description of someone's health was not concealed", fix: "Detection does not recognize names or free-text health details. Ask people to leave them out, or add a content filter to the model." },
      { symptom: "A draft still contains a value", fix: "Drafts are documents of record and are not altered. A draft request that contained personal data is recorded in the Audit Trail as DRAFT_NOT_CONCEALED." },
      { symptom: "\"Personal data protection settings could not be loaded.\"", fix: "Reload Policies. If it repeats, confirm your account is still an administrator." },
      { symptom: "\"The setting was not saved.\"", fix: "Nothing changed. Try again; if it repeats, check the Audit Trail and your connection." },
    ],
    scenes: [
      {
        title: "Find Personal Data Protection",
        caption: "Admin console › Policies › Personal Data Protection. Here it reads Off.",
        narration:
          "Open Admin console, Policies. Personal Data Protection sits below Policy Controls, and its header shows whether it is on. Here it reads Off: chats are stored and shown exactly as typed. Expand it.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        focus: "pdpFind",
      },
      {
        title: "Turn on concealment",
        caption: "Conceal personal data: on. Hide values from the model too is on by default.",
        narration:
          "Switch on Conceal personal data. It saves at once for everyone in the organization, and the header reads On. Hide values from the model too is already on, so typed prompts and attached file text reach the model provider as placeholders.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "pdpToggles",
      },
      {
        title: "Choose what to conceal",
        caption: "Six kinds of personal data, each listing the values it finds.",
        narration:
          "What to conceal lists six kinds of personal data and the values each one finds: government and personal I Ds, contact details, financial accounts, health identifiers, secrets and credentials, and network identifiers. Switch off any you do not want concealed. At least one stays on.",
        durationSeconds: 20,
        calloutPlacement: "left-rail",
        focus: "pdpCategories",
      },
      {
        title: "Try it with sample text",
        caption: "Preview concealment: 6 values concealed, with a pill for each detector.",
        narration:
          "Under Try it with sample text, keep the synthetic sample or edit it, and choose Preview concealment. Six values concealed: each one becomes a labeled chip, and a pill counts each detector. The preview is not saved or logged.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "pdpPreview",
      },
      {
        title: "Where it applies, and its limits",
        caption: "Chats, replies, records, and exports. Names, drafts, and uploads are not altered.",
        narration:
          "Where it applies lists every place concealment reaches: chats and titles, model replies as they stream, prompt activity, feedback, alerts, tags, memories, issue reports, search, the Elastic export, and training datasets. Read the limits too. Names and free-text health details are not detected, and drafts and uploaded files are not altered.",
        durationSeconds: 24,
        calloutPlacement: "left-rail",
        focus: "pdpCoverage",
      },
      {
        title: "What people see",
        caption: "A sent SSN and email show as locked chips.",
        narration:
          "Now a person sends a message with a test Social Security number and email address. Once it is sent, each value shows as a locked chip, and the line under their message box says Personal data is concealed.",
        durationSeconds: 15,
        focus: "pdpChatPrompt",
      },
      {
        title: "The model received placeholders",
        caption: "The model saw placeholders, so its draft says [SSN] and [EMAIL].",
        narration:
          "The model never saw the values. It received placeholders, so its draft says S S N and EMAIL in brackets where the values belong.",
        durationSeconds: 10,
        focus: "pdpChatReply",
      },
      {
        title: "Concealed in User Prompt Activity",
        caption: "Audit › User Prompt Activity shows the same chip.",
        narration:
          "In Audit, expand User Prompt Activity and choose Refresh monitor. The same prompt shows the chip, so reviewing activity never shows the value again.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "pdpActivity",
      },
      {
        title: "Recorded in the Audit Trail",
        caption: "Search privacy: PROMPT_CONCEALED and POLICY_UPDATED.",
        narration:
          "In the Audit Trail, choose Refresh and search privacy. PROMPT_CONCEALED records each concealed message, with who sent it, the model, and whether the model saw placeholders. POLICY_UPDATED records your change.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "pdpAuditTrail",
      },
      {
        title: "Let the model read the values",
        caption: "Hide values from the model too: off. Values stay concealed where stored or shown.",
        narration:
          "Some work needs the model to read the value, such as filling in a form. Switch off Hide values from the model too. The model then reads the original value for that turn, and it is still concealed everywhere it is stored or shown.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "pdpModelRow",
      },
      {
        title: "Replies are concealed too",
        caption: "Values the model writes appear as locked chips.",
        narration:
          "Now the model reads a test phone number and email and writes them into a signature. The reply is concealed before it reaches the browser and before it is saved, so both show as chips.",
        durationSeconds: 13,
        focus: "pdpOutput",
      },
      {
        title: "Turn protection off",
        caption: "Conceal personal data: off. New chats are stored as typed.",
        narration:
          "To stop concealing, switch off Conceal personal data. The header reads Off, and new chats are stored and shown exactly as typed. Content filters attached to individual models still apply.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "pdpOffRow",
      },
      {
        title: "Saved chats stay concealed",
        caption: "Chats saved while protection was on keep their chips.",
        narration:
          "Chats saved while protection was on stay concealed. Their values were never stored, so turning protection off cannot bring them back. The note under the message box is gone for new messages.",
        durationSeconds: 13,
        focus: "pdpStillConcealed",
      },
    ],
  },
  {
    id: "admin-training-datasets",
    audioSrc: "training/admin/admin-training-datasets.mp3",
    title: "Build training datasets from ratings and corrections",
    description: "Capture de-identified ratings and corrections, route them into datasets by practice area, department, and kind of work, review them, and download a file for fine-tuning an open-weight model.",
    icon: "datasets",
    track: "Privacy and training data",
    outcomes: [
      "Capture on, with safeguards set",
      "Existing chats scanned",
      "Dataset created from a suggestion",
      "Examples approved and downloaded",
    ],
    prerequisites: [
      "An Admin account.",
      "Your organization's approval to keep de-identified copies of rated answers for model training, and a decision on which groups are never captured.",
      "People who rate replies with the thumbs buttons or correct the assistant in chat.",
      "For the download: a place inside your organization to keep the file, such as the environment where you will fine-tune an open-weight model.",
    ],
    setupSteps: [
      "Choose Admin console › Datasets. Training Data Capture reads Off, and nothing is collected.",
      "Switch on Capture training signals. The header reads Capturing.",
      "Under Capture these signals, keep or clear Helpful ratings, Unhelpful ratings and notes, and Corrections and regenerations.",
      "Check the safeguards. Review before export, Skip sensitive or regulated chats, and Conceal people and client names are on by default.",
      "Under Never capture from these groups, choose any group whose work must never be captured.",
      "Choose Scan existing chats to capture chats saved before capture was on. The notice reads \"Scanned N chats and captured N new examples.\"",
      "From now on, ratings and corrections are captured as chats are saved. In Captured Signals, choose Refresh to see the counts and the work mix.",
      "Under Suggested datasets, choose Create on a suggestion, or choose New dataset.",
      "Check the Name, Training format, and routing rules, then choose Create dataset.",
      "Choose Review on the dataset card. Read each example as it would be exported, then choose Approve or Exclude, or Approve all shown.",
      "Choose Download, then Download N examples in the dialog. Keep the ZIP inside your organization.",
      "Choose Audit › Audit Trail › Refresh and set the category filter to training to see each step recorded.",
    ],
    paths: [
      {
        label: "Preference pairs (DPO) (shown)",
        steps: [
          "Uses corrections whose revised answer was accepted: not rated down and not corrected again.",
          "train.jsonl holds prompt, chosen (the revised answer), and rejected (the original answer).",
        ],
      },
      {
        label: "Supervised fine-tuning",
        steps: [
          "Uses answers rated helpful and accepted revisions.",
          "train.jsonl holds chat messages that end in the approved or revised answer.",
        ],
      },
      {
        label: "Binary feedback (KTO)",
        steps: [
          "Uses every judged answer, so it works with thumbs ratings alone.",
          "train.jsonl holds prompt, completion, and a true or false label.",
        ],
      },
      {
        label: "Create a dataset from scratch",
        steps: [
          "Choose New dataset in the Datasets panel.",
          "Type a Name and an optional Description, and choose a Training format.",
          "Choose rule chips under Signals, Practice areas (a broad area includes its specialties), Kinds of work, Departments, and Models. Leave a rule empty to accept everything.",
          "Optionally type a System prompt for every example, then choose Create dataset.",
        ],
      },
      {
        label: "Skip review",
        steps: [
          "Switch off Review before export. New examples are approved as they are captured, and you can still exclude any of them.",
          "Or keep review on and switch on Include examples waiting for review in the Download dialog, for one download.",
        ],
      },
      {
        label: "Edit, archive, or delete a dataset",
        steps: [
          "The pencil edits the name, format, and rules. Every example is re-routed at once.",
          "Archive stops routing examples to the dataset; Restore brings it back.",
          "Delete removes the dataset definition. Its examples stay captured and keep routing to other datasets.",
        ],
      },
    ],
    verify: [
      "Training Data Capture reads Capturing, and Captured Signals counts examples.",
      "The dataset card shows approved examples and none waiting.",
      "The download is a ZIP with train.jsonl, metadata.jsonl, and README.md.",
      "The Audit Trail lists DATASET_CREATED, EXAMPLES_REVIEWED, and DATASET_EXPORTED.",
    ],
    troubleshooting: [
      { symptom: "Scan existing chats is dimmed", fix: "Switch on Capture training signals first." },
      { symptom: "\"No examples captured yet\"", fix: "Capture is off, or nobody has rated or corrected an answer since it was turned on. Turn capture on and choose Scan existing chats to include earlier work." },
      { symptom: "A rated chat was not captured", fix: "It may carry a sensitive or regulated retention tag; a chat in which a Social Security or card number was found is usually tagged. Or its owner is in a group under Never capture from these groups. Very short replies are also skipped." },
      { symptom: "A follow-up was not treated as a correction", fix: "A correction needs clear pushback, such as \"that's wrong\", \"you missed\", or \"should be\". A new question, or a style request such as \"make it shorter\" on its own, is not enough." },
      { symptom: "An example has the wrong practice area", fix: "Without a subject retention tag, the practice area comes from keywords, and the example says Practice area from keywords. Turn on subject tagging in Data Retention, or route by department instead." },
      { symptom: "Download is dimmed", fix: "No examples match the dataset yet. Check its rules and format: preference pairs need corrections whose revised answer was accepted." },
      { symptom: "The dialog says Download 0 examples", fix: "Nothing is approved yet. Approve examples, or switch on Include examples waiting for review." },
      { symptom: "\"Training data settings could not be loaded.\"", fix: "Reload Datasets. If it repeats, confirm your account is still an administrator." },
    ],
    scenes: [
      {
        title: "Find Datasets",
        caption: "Admin console › Datasets. Training Data Capture reads Off.",
        narration:
          "Open Admin console, Datasets. Training Data Capture reads Off: nothing is collected, and chats, ratings, and corrections are used only for their normal purpose.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "dsCapture",
      },
      {
        title: "Turn on capture",
        caption: "Capture training signals: on. Three signals are captured by default.",
        narration:
          "Switch on Capture training signals. The header reads Capturing. Under Capture these signals, all three are on: helpful ratings, unhelpful ratings and notes, and corrections and regenerations. Select a chip to stop capturing that signal.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "dsSignals",
      },
      {
        title: "Safeguards",
        caption: "Review before export, skip sensitive chats, and conceal names: on by default.",
        narration:
          "Three safeguards are on by default. Review before export holds new examples for your approval. Skip sensitive or regulated chats never captures a chat with a sensitive or regulated retention tag. Conceal people and client names replaces workspace names and configured client and matter names. Identifiers such as account numbers are always concealed.",
        durationSeconds: 25,
        calloutPlacement: "left-rail",
        focus: "dsSafeguards",
      },
      {
        title: "Never capture a group",
        caption: "Never capture from these groups: HR is excluded.",
        narration:
          "Under Never capture from these groups, choose any group whose work must stay out. Here HR is excluded, so nothing its members do is captured.",
        durationSeconds: 10,
        calloutPlacement: "left-rail",
        focus: "dsExcluded",
      },
      {
        title: "Scan existing chats",
        caption: "Scan existing chats captures work saved before capture was on.",
        narration:
          "Choose Scan existing chats to include work saved before capture was on. The notice says how many chats were scanned and how many new examples were captured. Your model providers still run under zero data retention: examples stay in this deployment until you download them.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "dsScan",
      },
      {
        title: "A correction, captured as it happens",
        caption: "A person says the answer was wrong and asks for a revision.",
        narration:
          "From now on, capture is automatic. Here a person tells the assistant its answer was wrong and asks it to revise. That pushback marks the first answer as rejected and the revised answer as preferred.",
        durationSeconds: 15,
        focus: "dsUserCorrection",
      },
      {
        title: "What people see",
        caption: "The note box says a de-identified copy of rated answers is kept.",
        narration:
          "When they rate the revised answer, the note box tells them that their organization keeps a de-identified copy of rated answers and notes, and never sends it to a model provider.",
        durationSeconds: 13,
        focus: "dsUserNote",
      },
      {
        title: "Captured Signals",
        caption: "Captured, waiting for review, approved, and values de-identified.",
        narration:
          "Back in Datasets, choose Refresh. Captured Signals counts what has been captured, what is waiting for review, what is approved, and how many values were de-identified before storage.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "dsOverview",
      },
      {
        title: "The work mix",
        caption: "Every example sorted by practice area, kind of work, and department.",
        narration:
          "Below the counts, examples are sorted three ways: by practice area, by kind of work, and by department, meaning the person's groups. Practice areas come from a chat's subject tag, or from keywords in the person's own words.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "dsMix",
      },
      {
        title: "Suggested datasets",
        caption: "Suggestions for practice areas and departments with three or more examples.",
        narration:
          "Suggested datasets appear for practice areas and departments with at least three examples. A practice area with enough corrections is suggested as preference pairs. Choose Create on the litigation corrections suggestion.",
        durationSeconds: 15,
        calloutPlacement: "left-rail",
        focus: "dsSuggestions",
      },
      {
        title: "Choose a training format",
        caption: "Supervised fine-tuning, preference pairs, or binary feedback.",
        narration:
          "The dialog is filled in from the suggestion. Training format decides what the file teaches: supervised fine-tuning on approved answers, preference pairs that set the original answer against the revised one, or binary feedback that labels every judged answer good or bad.",
        durationSeconds: 19,
        calloutPlacement: "left-rail",
        focus: "dsEditorFormat",
      },
      {
        title: "Routing rules",
        caption: "Signals, practice areas, kinds of work, departments, and models. Empty accepts all.",
        narration:
          "Rules decide which examples belong: signals, practice areas, kinds of work, departments, and models. Leave a rule empty to accept everything, and a broad practice area includes its specialties. Here only Litigation is chosen. Choose Create dataset.",
        durationSeconds: 18,
        calloutPlacement: "left-rail",
        focus: "dsEditorRules",
      },
      {
        title: "The dataset card",
        caption: "Format, rules, and how many matching examples are approved and waiting.",
        narration:
          "The dataset card shows its format, its rules, and how many matching examples are approved and waiting. One example can feed several datasets, and editing a rule re-routes every example at once.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "dsCard",
      },
      {
        title: "Review an example",
        caption: "Prompt, original answer, correction, and the revised answer marked Preferred.",
        narration:
          "Choose Review. Each example is shown exactly as it would be exported: the prompt, the original answer, the person's correction, and the revised answer, marked Preferred.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        focus: "dsExample",
      },
      {
        title: "De-identified before storage",
        caption: "Names and identifiers became placeholders, though chat protection was off.",
        narration:
          "Names and identifiers never reach the training store. In this tax example, the client's name, a coworker's name, and a phone number became placeholders, even though chat protection was off.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "dsConcealedExample",
      },
      {
        title: "Approve",
        caption: "Approve all shown, or approve and exclude one at a time.",
        narration:
          "Filter to Waiting for review and choose Approve all shown, or approve and exclude examples one at a time. The card now shows every matching example approved, with none waiting.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "dsApproved",
      },
      {
        title: "Download",
        caption: "A ZIP: train.jsonl, metadata.jsonl, and a dataset card.",
        narration:
          "Choose Download. The ZIP holds train dot J S O N L in the dataset's format, line-aligned metadata with no user names or chat I Ds, and a dataset card. Choose Download, and keep the file inside your organization.",
        durationSeconds: 17,
        focus: "dsDownload",
      },
      {
        title: "Every step is audited",
        caption: "Audit Trail, category training: each step recorded.",
        narration:
          "In Audit, choose Refresh in the Audit Trail and set the category filter to training. It records each capture setting change, the scan, the new dataset, the review, and the download.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "dsAudit",
      },
    ],
  },
  {
    id: "admin-analytics",
    audioSrc: "training/admin/admin-analytics.mp3",
    title: "Tenant analytics",
    description: "Scope each analytics section to a person and dates, export CSV, read usage and the workspace budget, and set a token cap that people actually hit.",
    icon: "analytics",
    track: "Oversight and compliance",
    outcomes: ["Sections scoped by person and date", "CSV exported", "Usage and budget read", "Token cap set and enforced"],
    prerequisites: [
      "An Admin account.",
      "Some real activity: chats, drafts, or automations from people in your organization.",
      "The workspace ceiling comes from your service team; your caps sit inside it.",
    ],
    setupSteps: [
      "Choose Admin console › Analytics. Every section starts collapsed.",
      "Expand Runtime Clock Metadata. Choose a person and dates, or All, Today, Week, or 30 days.",
      "Choose CSV, pick dates or All dates, and choose Download N rows.",
      "Expand Model Activity, User Usage, and Workspace Usage Budget to read volume, tokens, and the ceiling.",
      "Expand Token Allocations. Choose a person or group in the first menu, enter the Token cap, choose Per day, Per week, or Per month, and choose Set cap.",
      "The row shows the cap and a meter of tokens used in the current UTC period.",
      "Choose Remove allocation for … to lift the cap.",
    ],
    paths: [
      {
        label: "Cap one person (shown)",
        steps: [
          "Choose User · their name, enter the cap, choose the period, and Set cap.",
          "Once they pass it, their next message reads \"Your daily token budget has been reached. Requests are blocked until the next UTC day.\"",
        ],
      },
      {
        label: "Cap a group",
        steps: [
          "Choose Group · its name instead. Members then see \"Your group's daily token budget has been reached. Requests are blocked until the next UTC day.\"",
          "When several caps apply, the most restrictive one wins.",
        ],
      },
      {
        label: "Export other sections",
        steps: [
          "Chat Feedback and User Usage have their own CSV buttons with the same date choice.",
          "Choosing one person in a section's filter adds them to the file name.",
        ],
      },
    ],
    verify: [
      "Each filter shows \"N of M records\" for its own section only.",
      "The CSV downloads with the section and person in its file name, such as aperture-admin-runtime-analytics-….",
      "The cap row shows used and capped tokens, and a capped person's next message is refused with the budget message.",
    ],
    troubleshooting: [
      { symptom: "\"Enter a whole number of tokens (0 means no cap).\"", fix: "Type digits only. 0 records the person or group with no cap." },
      { symptom: "\"Unknown user for this workspace.\" or \"Unknown group for this workspace.\"", fix: "The person or group was removed. Choose Refresh and pick again." },
      { symptom: "\"Allocations total … tokens, more than the …-token workspace ceiling.\"", fix: "Allowed, but the ceiling still wins. Lower the caps or ask your service team to raise the ceiling." },
      { symptom: "The capped person waits several minutes before seeing the refusal", fix: "The chat retries a refused request before showing the message. The refusal itself is immediate on the server." },
      { symptom: "Token columns are blank for some rows", fix: "Tokens are counted only when the provider reports them; blank means none was reported." },
    ],
    scenes: [
      {
        title: "Analytics sections",
        caption: "Admin console › Analytics: six sections, each collapsed until you open it.",
        narration:
          "Open Admin console, Analytics. Six sections start collapsed: Runtime Clock Metadata, Chat Feedback, Model Activity, User Usage, Workspace Usage Budget, and Token Allocations.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "anSections",
      },
      {
        title: "Scope a section",
        caption: "Each section has its own person picker, dates, and All, Today, Week, 30 days.",
        narration:
          "Expand Runtime Clock Metadata. Every section has its own filter: a person, a date range, and the All, Today, Week, and thirty days shortcuts. Here, Jane Smith over thirty days. Filtering one section never changes another.",
        durationSeconds: 17,
        focus: "anFilters",
      },
      {
        title: "Export CSV",
        caption: "CSV › choose dates or All dates › Download N rows.",
        narration:
          "Choose C S V. Pick a date range, or All dates, and choose Download. The file name carries the section, the person, and the dates.",
        durationSeconds: 10,
        focus: "anCsv",
      },
      {
        title: "Model Activity",
        caption: "Prompts by model, the prompt trend, and the most active people.",
        narration:
          "Model Activity charts saved prompts by model, the trend over time, and who is most active.",
        durationSeconds: 8,
        focus: "anActivity",
      },
      {
        title: "User Usage",
        caption: "Messages and provider-reported tokens for your organization.",
        narration:
          "User Usage counts messages and tokens for your organization's admins and users, across chat, drafts, agents, automations, and the A P I. Tokens are reported by the provider; blank means none was reported.",
        durationSeconds: 16,
        focus: "anUsageCards",
      },
      {
        title: "The workspace budget",
        caption: "Read-only: your service team sets the workspace ceiling.",
        narration:
          "Workspace Usage Budget is read-only. Your service team sets the ceiling, here unlimited, and you see the tokens and completions counted in the current U T C period.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "anBudget",
      },
      {
        title: "Set a token cap",
        caption: "Token Allocations: who, the cap, and the reset period. Set cap.",
        narration:
          "In Token Allocations, choose a person or a group, enter the token cap, and choose Per day, Per week, or Per month. Choose Set cap. Here, Jane gets two hundred tokens a day.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "anAllocationForm",
      },
      {
        title: "Read the meter",
        caption: "Used tokens against the cap, for the current UTC period.",
        narration:
          "The row shows the cap and a meter of tokens used in the current U T C period. Jane has already used more than two hundred tokens today, so the meter is full. When several caps apply, the most restrictive wins.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "anAllocationTable",
      },
      {
        title: "What the person sees",
        caption: "\"Your daily token budget has been reached.\" Remove the cap to lift it.",
        narration:
          "Jane's next message is refused: Your daily token budget has been reached. Requests are blocked until the next U T C day. The chat retries for a few minutes before showing this. To lift it, choose Remove allocation.",
        durationSeconds: 16,
        focus: "anCapHit",
      },
    ],
  },
  {
    id: "admin-audit",
    audioSrc: "training/admin/admin-audit.mp3",
    title: "Tenant audit",
    description: "Investigate a real flagged prompt from start to finish: the signal board, Audit Insights, the prompt and reply, the security alert, and the audit trail.",
    icon: "audit",
    track: "Oversight and compliance",
    outcomes: ["Signal opened", "Trend inspected", "Prompt and reply read", "Alert acknowledged and trail filtered"],
    prerequisites: [
      "An Admin account.",
      "A flagged prompt to investigate. This lesson follows a real prompt-injection attempt, the same one the Alerts and delivery lesson follows to a delivered email.",
    ],
    setupSteps: [
      "Choose Admin console › Audit. The banner counts the signals that need attention.",
      "Select a red signal, such as Prompt watchlist, to open its records. Close it to return.",
      "In Audit Insights, choose 7, 14, or 30 days, then select a bar or point to list the records behind it.",
      "Expand User Prompt Activity, search for the prompt, and open it to read the prompt and the model's reply.",
      "Expand Security Alerts and choose Acknowledge once you have reviewed the alert.",
      "Expand Audit Trail. Filter by severity, category, and text, then choose CSV to export what you see.",
    ],
    paths: [
      {
        label: "Start from an alert email",
        steps: [
          "The email names the rule, detection, person, and time, never the flagged text.",
          "Open Admin console › Audit › Security Alerts and find the alert by detection and time, then follow the steps above.",
        ],
      },
      {
        label: "Export evidence",
        steps: [
          "User Prompt Activity and Audit Trail each have a CSV button. The trail export carries exactly the filtered rows.",
        ],
      },
    ],
    verify: [
      "The investigation lists the flagged records with person, model, and time.",
      "The prompt dialog shows the exact prompt and the model's saved reply.",
      "The alert reads Acknowledged, and the trail shows the security.prompt_flagged events.",
    ],
    troubleshooting: [
      { symptom: "A signal opens with no records", fix: "The count reflects the current snapshot; check the Audit Insights range or the trail's date filter." },
      { symptom: "The prompt you expect is missing from User Prompt Activity", fix: "Each section has its own person and date filter. Choose All and clear the search." },
      { symptom: "\"Security alert was not updated: …\"", fix: "Nothing changed. Refresh and acknowledge again; another administrator may have changed it." },
    ],
    scenes: [
      {
        title: "Signals that need attention",
        caption: "Admin console › Audit: the banner, three signal groups, and List or Cards.",
        narration:
          "Open Admin console, Audit. The banner counts the signals that need attention. They're grouped into Security signals, Identity and access, and Models and workspace. Red rows need attention.",
        durationSeconds: 14,
        focus: "auSignals",
      },
      {
        title: "Open a signal",
        caption: "Prompt watchlist lists the active prompt alerts behind its count, newest first.",
        narration:
          "Select Prompt watchlist. The investigation lists the active alerts behind the count. The newest are today's system-prompt extraction and prompt-injection attempts from Jane Smith.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "auSignalRecords",
      },
      {
        title: "Audit Insights",
        caption: "Choose 7, 14, or 30 days to chart events, alerts, people, areas, and hours.",
        narration:
          "Close it and scroll to Audit Insights. Choose a seven, fourteen, or thirty day range. The charts show events by day and severity, security alerts, the most active people, activity by area, and activity by hour.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "auInsights",
      },
      {
        title: "The records behind a bar",
        caption: "Select any bar or point to list its records, open and acknowledged.",
        narration:
          "Select today's point in Security alerts by day. The records behind it are split into open and acknowledged alerts.",
        durationSeconds: 9,
        calloutPlacement: "left-rail",
        focus: "auChartRecords",
      },
      {
        title: "Read the prompt and the reply",
        caption: "User Prompt Activity: the exact prompt and the model's saved reply.",
        narration:
          "Expand User Prompt Activity and search for the prompt. Open it to read exactly what was sent and what the model replied. Here the model declined to reveal its instructions.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "auPromptRecord",
      },
      {
        title: "Acknowledge the alert",
        caption: "Security Alerts: Acknowledge once reviewed. Reopen brings it back.",
        narration:
          "Expand Security Alerts. Each alert shows the detection, person, model, time, and a redacted snippet. When you have reviewed it, choose Acknowledge. Reopen returns it to active review.",
        durationSeconds: 14,
        focus: "auAlertAck",
      },
      {
        title: "The audit trail",
        caption: "Severity, category, and text filters. CSV exports exactly what you see.",
        narration:
          "Expand Audit Trail, the append-only record, newest first. Filter by severity, category, and text; here, security dot prompt flagged. C S V exports exactly the rows you see.",
        durationSeconds: 14,
        captionPlacement: "top",
        focus: "auTrailFilters",
      },
    ],
  },
  {
    id: "admin-alerts",
    audioSrc: "training/admin/admin-alerts.mp3",
    title: "Alerts and delivery",
    description: "Check email delivery, create a rule from the Prompt-injection template with a recipient, follow a real flagged prompt to a delivered email, and know the other rule templates, including Support-reports.",
    icon: "alerts",
    track: "Oversight and compliance",
    outcomes: ["Email status read", "Rule created from a template", "Real alert delivered", "Delivery archived and restored"],
    prerequisites: [
      "An Admin account.",
      "Email delivery configured by your service team. Without it, alerts are still logged in-app.",
      "The addresses that should receive alerts.",
    ],
    setupSteps: [
      "Choose Admin console › Alerts. Email Delivery should read Email configured.",
      "In Alert Rules, choose Prompt-injection template. Suspicious-activity template and Support-reports template prefill other rules the same way.",
      "Check the action pattern security.prompt_flagged, the minimum severity, Fire when, and Cooldown.",
      "Enter Email recipients, separated by commas.",
      "Under Only these detections, keep or change the ticked detectors.",
      "Choose Create Rule. The rule appears in the list, enabled.",
      "When a matching prompt is flagged, Alert Deliveries shows the delivery and its status, such as sent.",
    ],
    paths: [
      {
        label: "Prompt-injection template (shown)",
        steps: [
          "Watches security.prompt_flagged for Prompt injection, System-prompt extraction, and Credential extraction, at Warning and above, every match, with a 10-minute cooldown.",
        ],
      },
      {
        label: "Suspicious-activity template",
        steps: [
          "Watches security.*: security flags, content-filter hits, and elevated governance events, at Warning and above, with a 15-minute cooldown and no detection filter.",
        ],
      },
      {
        label: "Support-reports template (shown)",
        steps: [
          "Prefills New support reports: action patterns support.issue_reported, support.issue_reporter_replied, and support.issue_reopened, at Info and above, every match, with no cooldown.",
          "Add Email recipients and choose Create Rule. Each new report from Help, each reply from the person who reported, and each reopened report then sends an email. Work the ticket in Reports.",
        ],
      },
      {
        label: "New rule",
        steps: [
          "Enter a Rule name. Action patterns accepts exact actions or prefixes such as admin.* or auth.*; empty matches every action.",
          "Choose a minimum severity, an optional Watched user, Fire when (matches within minutes), and a cooldown.",
          "Detections apply only to security.prompt_flagged events.",
        ],
      },
      {
        label: "In-app only",
        steps: [
          "Leave Email recipients empty. Deliveries read logged in-app.",
        ],
      },
    ],
    verify: [
      "The rule appears enabled, with its patterns, detections, and recipient count.",
      "Alert Deliveries shows the delivery with status sent and the recipient.",
      "The email arrives with the rule and detection in its subject and no flagged text.",
    ],
    troubleshooting: [
      { symptom: "\"A rule name is required.\"", fix: "Enter a Rule name." },
      { symptom: "\"'…' is not a valid email address.\"", fix: "Separate recipients with commas and check each address." },
      { symptom: "\"Detections only apply to security.prompt_flagged events. …\"", fix: "Add security.prompt_flagged or security.* to Action patterns, or clear the detections." },
      { symptom: "\"None of the chosen detections can reach the minimum severity '…'. …\"", fix: "Lower Minimum severity or choose other detections." },
      { symptom: "A delivery reads email not configured", fix: "Email delivery is managed at the service level. The alert stays logged in-app; ask your service team to configure email." },
      { symptom: "A delivery reads failed", fix: "Its detail shows the mail server's real error. Share it with your service team." },
    ],
    scenes: [
      {
        title: "Email delivery status",
        caption: "Admin console › Alerts: read-only email status. Alerts are always logged in-app.",
        narration:
          "Open Admin console, Alerts. Email Delivery is read-only for administrators: your service team configures the mail server. Here it reads Email configured. Either way, every alert is logged in-app.",
        durationSeconds: 15,
        focus: "alEmail",
      },
      {
        title: "Start from a template",
        caption: "Prompt-injection template: patterns, severity, threshold, cooldown, and recipients.",
        narration:
          "In Alert Rules, choose Prompt-injection template. It watches security dot prompt flagged events at Warning and above, fires on every match, and waits ten minutes before firing again. Enter the email recipients, separated by commas.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "alRuleForm",
      },
      {
        title: "Only these detections",
        caption: "Ticked detectors only. Leave all unticked to match every event the patterns allow.",
        narration:
          "Only these detections narrows the rule to chosen detectors: here prompt injection, system-prompt extraction, and credential extraction. Leave them all unticked to match every event the patterns allow. Choose Create Rule.",
        durationSeconds: 16,
        calloutPlacement: "left-rail",
        focus: "alRuleDetections",
      },
      {
        title: "The rule is live",
        caption: "The rule lists its patterns, detections, severity, and recipients.",
        narration:
          "The rule appears in the list, enabled, with its patterns, detections, and one recipient. Disable pauses it; the pencil edits it.",
        durationSeconds: 10,
        focus: "alRuleRow",
      },
      {
        title: "A real flagged prompt",
        caption: "A person tries a prompt injection. The chat continues; the scan runs in the background.",
        narration:
          "Now a person sends a prompt-injection attempt in an ordinary chat. The chat isn't blocked, and the model declines. In the background, the prompt scan flags it.",
        durationSeconds: 12,
        focus: "alFlaggedChat",
      },
      {
        title: "The delivery is sent",
        caption: "Alert Deliveries: the rule, the detection, the person, the recipient, and sent.",
        narration:
          "Back in Alerts, choose Refresh. Alert Deliveries shows the trigger: the rule, the detection, the person, and the recipient, with the real status sent. A failure would show the mail server's actual error.",
        durationSeconds: 15,
        focus: "alDeliverySent",
      },
      {
        title: "In the recipient's inbox",
        caption: "The email names the rule, detection, person, and time, never the flagged text.",
        narration:
          "In the recipient's inbox, the subject reads Aperture Chat alert, followed by the rule and the detection. The body names the scope, event, person, and time, and says where to review it. The flagged text is never included.",
        durationSeconds: 16,
        card: {
          label: "Check",
          where: "The recipient's inbox",
          steps: [
            "Subject: [Aperture Chat alert] Prompt injection: Prompt-injection attempt.",
            "The body names the rule, scope, detection, event, person, and time.",
            "The flagged text is not included. Review it in Admin console › Audit › Security Alerts.",
            "Nothing arrived? Check spam, then the delivery's status in Alert Deliveries.",
          ],
        },
      },
      {
        title: "Archive a delivery",
        caption: "Archive hides it without deleting history. Show archived brings it back.",
        narration:
          "Choose Archive to clear a delivery from the list. Its history is kept: Show archived lists it again, marked Archived, with Restore.",
        durationSeconds: 10,
        focus: "alArchived",
      },
      {
        title: "Other templates",
        caption: "Support-reports template: an email for each new report, reply, or reopen from Help.",
        narration:
          "The other templates work the same way. Support-reports template prefills a rule named New support reports. It watches new reports from Help, replies from the person who reported, and reopened reports, on every match with no cooldown. Add recipients and choose Create Rule to hear about reports without watching the Reports tab.",
        durationSeconds: 22,
        calloutPlacement: "left-rail",
        focus: "alSupportTemplate",
      },
    ],
  },
  {
    id: "admin-retention",
    audioSrc: "training/admin/admin-retention.mp3",
    title: "Data retention and tagging",
    description: "Keep chats forever by default, label conversations by client or matter, place a legal hold, and preview a finite schedule before anything is deleted.",
    icon: "retention",
    track: "Oversight and compliance",
    outcomes: ["Forever default understood", "Matter labeled and confirmed", "Legal hold placed", "Finite schedule previewed"],
    prerequisites: [
      "An Admin account.",
      "Your organization's retention rules, and the client or matter names and aliases people use.",
      "Saved chats to label. Labels come only from saved message text.",
    ],
    setupSteps: [
      "Choose Admin console › Audit and expand Data Retention.",
      "Schedule and rules: Keep chats for starts at Forever, with automatic deletion off.",
      "Under Clients, matters, and regulated records, choose a Source type, enter Name or reference and aliases, and choose Add source to policy.",
      "Choose Save Forever. The status reads \"Forever saved. Automatic deletion is off for all chats.\"",
      "Choose Tags and holds, then Scan existing chats. Search for the matter and review each suggestion.",
      "Select the right chats, choose the label, and choose Confirm label.",
      "Expand Legal holds, enter a Hold name, and choose Hold selected chats.",
      "To consider a time limit, choose it in Schedule and rules and choose Preview effect. Save only after reviewing the counts.",
    ],
    paths: [
      {
        label: "Keep forever (default, shown)",
        steps: [
          "Leave Keep chats for at Forever. Choose Save Forever after adding sources; nothing is deleted.",
        ],
      },
      {
        label: "A finite schedule (previewed, shown)",
        steps: [
          "Choose 1, 5, 7, or 10 years. Count age from and Review window (at least 7 days) appear.",
          "Choose Preview effect and read how many chats are old enough, on hold, or kept.",
          "Choose Save retention policy only when the counts are right. Eligible chats enter the review window first.",
        ],
      },
      {
        label: "A rule for one label",
        steps: [
          "Each source has a Retention rule menu. A longer matching rule wins over the default schedule.",
          "Tick Apply time limits only to labels with a rule to leave unlabeled chats at Forever.",
        ],
      },
      {
        label: "Manual archive or delete",
        steps: [
          "In Tags and holds, select chats and choose Archive selected or Delete selected.",
          "Delete asks first and cannot be undone. Chats under an active legal hold are skipped.",
        ],
      },
    ],
    verify: [
      "The source appears in the list with its aliases, and Save Forever confirms automatic deletion is off.",
      "The confirmed chats show the matter label; held chats show Legal hold.",
      "Preview effect reports the totals without changing anything.",
    ],
    troubleshooting: [
      { symptom: "\"Enter a source name of at least two characters.\"", fix: "Enter the client or matter name." },
      { symptom: "\"Aliases must be 3–160 characters long.\"", fix: "Remove very short aliases, such as initials." },
      { symptom: "\"Preview this exact policy again before saving; the policy or affected chats changed.\"", fix: "Choose Preview effect again, then save." },
      { symptom: "Scan suggests nothing for a matter", fix: "Suggestions come from saved message text only. Add the aliases people actually write, save, and scan again." },
      { symptom: "Hold selected chats is unavailable", fix: "Select 1 to 500 chats and enter a Hold name of at least three characters." },
    ],
    scenes: [
      {
        title: "Find Data Retention",
        caption: "Admin console › Audit › Data Retention, below Recent Governance Activity.",
        narration:
          "Open Admin console, Audit, and scroll to Data Retention. Expand it to manage the schedule, labels, and legal holds.",
        durationSeconds: 10,
        focus: "retNavigation",
      },
      {
        title: "Forever until you choose",
        caption: "Keep chats for: Forever. Automatic deletion off.",
        narration:
          "Schedule and rules opens at Forever, with automatic deletion off. Nothing is ever deleted until you preview and save a time limit.",
        durationSeconds: 10,
        focus: "retForever",
      },
      {
        title: "Add a client or matter",
        caption: "Source type, Name or reference, and the aliases people write.",
        narration:
          "Under Clients, matters, and regulated records, choose a source type, here Matter. Enter its name and the aliases people actually write, such as Harbor Logistics and Matter twenty-two oh seven. Choose Add source to policy.",
        durationSeconds: 16,
        focus: "retSourceForm",
      },
      {
        title: "Save the source, still Forever",
        caption: "Save Forever keeps deletion off and saves the source.",
        narration:
          "Choose Save Forever. The status confirms automatic deletion is off for all chats, and the new matter appears with its own Retention rule menu.",
        durationSeconds: 11,
        focus: "retSourceRow",
      },
      {
        title: "Scan for mentions",
        caption: "Tags and holds › Scan existing chats, then search. Suggestions need your review.",
        narration:
          "A person has since chatted about the Harbor Logistics renewal. Choose Tags and holds, then Scan existing chats to check older conversations; new chats are checked as they're saved. Search for Harbor. The chat carries a suggested matter label, which governs retention only after you confirm it.",
        durationSeconds: 20,
        focus: "retScan",
      },
      {
        title: "Confirm the label",
        caption: "Select the chats, choose the label, and Confirm label.",
        narration:
          "Select the right chats, choose the matter label, and choose Confirm label. The label is now authoritative. Remove or dismiss label rejects a wrong match.",
        durationSeconds: 11,
        focus: "retConfirm",
      },
      {
        title: "Read before you act",
        caption: "Select a chat title to read its saved prompts and replies.",
        narration:
          "Before acting on a chat, select its title to read the saved prompt and reply.",
        durationSeconds: 7,
        calloutPlacement: "left-rail",
        focus: "retConversation",
      },
      {
        title: "Place a legal hold",
        caption: "Legal holds › Hold name › Hold selected chats.",
        narration:
          "Expand Legal holds. Enter a hold name and choose Hold selected chats. Held chats are protected from both automatic and manual deletion until the hold is released, and each now reads Legal hold.",
        durationSeconds: 15,
        focus: "retHold",
      },
      {
        title: "Preview a finite schedule",
        caption: "Choose a time limit, then Preview effect. Review before saving.",
        narration:
          "To consider a time limit, return to Schedule and rules and choose one, here seven years. Choose Preview effect. It counts the chats old enough now, those on legal hold, and those kept. Save only after reviewing; eligible chats get a review window of at least seven days. This walkthrough doesn't save it.",
        durationSeconds: 21,
        focus: "retPreview",
      },
      {
        title: "Manual deletion asks first",
        caption: "Delete selected asks for confirmation. Held chats are skipped.",
        narration:
          "For manual cleanup, select chats and choose Archive selected or Delete selected. Delete asks first, says it can't be undone, and skips chats under an active legal hold. Choose Cancel if you're not sure.",
        durationSeconds: 15,
        focus: "retDeleteConfirm",
      },
    ],
  },
  {
    id: "admin-feedback-issues",
    audioSrc: "training/admin/admin-feedback-issues.mp3",
    title: "Review feedback and reported issues",
    description: "Follow a real rating with a note and a reported problem from the person's screen to your review in Analytics, then hand the report to Reports.",
    icon: "analytics",
    track: "Oversight and compliance",
    outcomes: ["Rating and note reviewed in context", "Reported problem read and opened in Reports", "Review scoped by person and date"],
    prerequisites: [
      "An Admin account.",
      "People who rate replies or report problems from Help.",
    ],
    setupSteps: [
      "The person rates a reply with the thumbs buttons below it and may add a note, then chooses Send note.",
      "The person reports a problem from Help › Report a problem: they choose Problem (or Idea, Question, Feedback, or Security), enter a Subject and Message, add an optional screenshot, and choose Send report.",
      "Choose Admin console › Analytics and expand Chat Feedback.",
      "Choose the person and dates, or Today, Week, or 30 days.",
      "Open a feedback row to read the note and the rated exchange.",
      "Scroll to Reported platform issues and open a report to read it.",
      "Choose Manage in Reports to reply, set the status, priority, and assignee, or add an internal note. The person follows it in Help › My reports.",
    ],
    paths: [
      {
        label: "A rating with a note (shown)",
        steps: [
          "Thumbs up or down, then an optional note. The row shows the sentiment, model, person, and note.",
        ],
      },
      {
        label: "A reported problem (shown)",
        steps: [
          "Help › Report a problem. Analytics shows the subject, message, sender, time, and any screenshot.",
          "Manage in Reports opens the Reports tab, where you reply, set the status, and keep internal notes (see Work reported problems in Reports).",
        ],
      },
    ],
    verify: [
      "The summary counts Total feedback, Positive, Negative, and Issue reports for your scope.",
      "Feedback and conversation shows the note and the rated exchange.",
      "Platform issue report shows the subject and message the person sent.",
      "Manage in Reports opens the Reports tab with the report in its queue.",
    ],
    troubleshooting: [
      { symptom: "The list is empty", fix: "Widen the person and date filter. Each section filters independently." },
      { symptom: "The conversation could not be loaded", fix: "The dialog says so and shows the saved reply preview only. Use the evidence that loaded." },
      { symptom: "\"The screenshot preview could not be loaded.\"", fix: "The report has a screenshot that failed to load. Read the text and try again later." },
    ],
    scenes: [
      {
        title: "The person rates a reply",
        caption: "Thumbs below a reply, then an optional note and Send note.",
        narration:
          "Feedback starts with the person. Below any reply, they choose thumbs up or thumbs down, then may add a note and choose Send note.",
        durationSeconds: 10,
        focus: "fbUserRate",
      },
      {
        title: "The person reports a problem",
        caption: "Help › Report a problem: the type, Subject, Message, an optional screenshot, Send report.",
        narration:
          "For a problem with the workspace itself, they open Help, Report a problem, choose what they are sending, here Problem, enter a subject and message, attach a screenshot if they like, and choose Send report.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "fbUserReport",
      },
      {
        title: "Scope your review",
        caption: "Analytics › Chat Feedback: a person and dates, then the four counts.",
        narration:
          "In Admin console, open Analytics and expand Chat Feedback. Choose the person and the dates, here Jane Smith, today. The summary counts total feedback, positive, negative, and issue reports.",
        durationSeconds: 14,
        focus: "fbOverview",
      },
      {
        title: "Read the rating in context",
        caption: "Feedback and conversation: the note and the rated exchange.",
        narration:
          "Open a row. Feedback and conversation shows the person, sentiment, model, and time, their note, and the rated exchange, highlighted. It shows saved text and does not run the model again.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "feedbackConversation",
      },
      {
        title: "Reported platform issues",
        caption: "Reports from Help, newest first, with Manage in Reports beside the heading.",
        narration:
          "Below the ratings, Reported platform issues lists reports from Help, with the subject, sender, and time. Manage in Reports sits beside the heading.",
        durationSeconds: 11,
        focus: "fbIssues",
      },
      {
        title: "Read the report",
        caption: "Platform issue report: subject, message, sender, time, and any screenshot.",
        narration:
          "Open a report to read the subject, message, sender, time, and any screenshot. This preview is read-only. To reply or change the report's status, close it and choose Manage in Reports.",
        durationSeconds: 14,
        calloutPlacement: "left-rail",
        focus: "feedbackIssueReport",
      },
      {
        title: "Manage in Reports",
        caption: "Manage in Reports opens the ticket queue: reply, set the status, and keep notes there.",
        narration:
          "Choose Manage in Reports. The Reports tab opens with the report in its queue. Replies, status, priority, assignment, and internal notes all happen there, as the lesson Work reported problems in Reports shows.",
        durationSeconds: 16,
        focus: "fbReports",
      },
    ],
  },
  {
    id: "admin-reports",
    audioSrc: "training/admin/admin-reports.mp3",
    title: "Work reported problems in Reports",
    description: "Take a report from Help to resolved: find it in Reports, set its status, priority, and assignee, keep internal notes, reply to the person, and confirm every step in the Audit Trail.",
    icon: "reports",
    track: "Oversight and compliance",
    outcomes: [
      "New report found under Needs reply",
      "Status, priority, and assignee set",
      "Internal note kept and reply sent",
      "Report resolved and audited",
    ],
    prerequisites: [
      "An Admin account. Reports lists the reports people in your organization send.",
      "People who send reports from Help › Report a problem. They follow your replies in Help › My reports.",
    ],
    setupSteps: [
      "The person opens Help › Report a problem, chooses what they are sending (Problem, Idea, Question, Feedback, or Security), enters a Subject and Message, and chooses Send report. They see \"Report #N sent\".",
      "Choose Admin console › Reports. Needs reply lists reports waiting on you; Open lists every report still being worked.",
      "Search by subject, person, or #number, then select the report.",
      "Set Status (such as In review), Priority, and Assignee. Each change saves at once and appears in the activity. The person sees status changes; priority and assignee changes are internal.",
      "For a note only administrators see, choose Internal note, type it, and choose Add note.",
      "To answer the person, choose Reply to and their first name, such as Reply to Jane, type your reply, and choose Send reply. They see it in Help › My reports.",
      "When the person replies, the report returns to Needs reply. Choose Refresh to see it.",
      "When it is fixed, type a closing reply and choose Reply and resolve, or set Status to Resolved.",
      "Choose Audit › Audit Trail, choose Refresh, and set the category filter to support to see each step.",
    ],
    paths: [
      {
        label: "A problem (shown)",
        steps: [
          "Problem asks How much is this affecting you?: Blocking me, Slows me down, or Minor. That sets the starting priority, High, Normal, or Low; you can raise it to Urgent.",
          "The report may carry a screenshot and, unless the person cleared Include technical details, the version, page, browser, and recent errors. Open Technical details on the report to read them.",
        ],
      },
      {
        label: "An idea, a question, or feedback",
        steps: [
          "The same form, with prompts for that type. The report's Type shows it; change Type if the person chose the wrong one.",
          "Work it the same way: reply, set a status, and resolve or close it.",
        ],
      },
      {
        label: "A security concern (shown)",
        steps: [
          "Choosing Security tells the person: \"Security concerns go only to your administrators and are never posted publicly.\"",
          "The report's Type reads Security concern. Follow your organization's security process, and keep sensitive details in internal notes.",
        ],
      },
      {
        label: "Closed and reopened reports",
        steps: [
          "Closed lists resolved and closed reports; All lists everything. The Status menu narrows the list to one status.",
          "On a resolved report the person sees Still having this problem? and can choose Reopen report; it returns to your queue.",
        ],
      },
      {
        label: "An email for each new report",
        steps: [
          "Admin console › Alerts › Support-reports template prefills New support reports, which watches support.issue_reported, support.issue_reporter_replied, and support.issue_reopened.",
          "Add Email recipients and choose Create Rule (see Alerts and delivery).",
        ],
      },
    ],
    verify: [
      "The report shows the status, priority, and assignee you set, and each change appears in its activity.",
      "The person's My reports shows your reply and the progress tracker, never your internal note.",
      "After Reply and resolve, the status reads Resolved and the report leaves Open.",
      "The Audit Trail, filtered to support, lists the report, each change, your replies, and the person's reply.",
    ],
    troubleshooting: [
      { symptom: "\"No reports yet\"", fix: "Nobody in your organization has sent a report. Reports people send from Help › Report a problem appear here." },
      { symptom: "\"Nothing matches\"", fix: "A view, menu, or search is narrowing the list. Choose All, set the menus back to Any status and All types, and clear the search." },
      { symptom: "Reply and resolve is not offered", fix: "It appears only with Reply to selected while the report is open, and it needs a reply typed first." },
      { symptom: "\"The change could not be saved.\"", fix: "Nothing changed. Choose Refresh and try again; another administrator may have changed the report." },
      { symptom: "\"Reports could not be loaded.\"", fix: "Choose Refresh. If it repeats, confirm your account is still an administrator." },
      { symptom: "The open report does not show the person's latest reply", fix: "Refresh updates the list, not the report already open. Select another report and then this one again, or reload the page." },
    ],
    scenes: [
      {
        title: "Where reports start",
        caption: "Help: Report a problem sends a report; My reports follows it.",
        narration:
          "Reports start with the person. In Help, Report a problem sends a report to you, and My reports is where they follow its status and your replies.",
        durationSeconds: 11,
        focus: "rpUserHelp",
      },
      {
        title: "The person sends a report",
        caption: "The type, how much it affects them, a Subject, and a Message.",
        narration:
          "They choose what they are sending: a problem, an idea, a question, feedback, or a security concern. For a problem, they say how much it affects them, which sets the starting priority. Then a subject and message, an optional screenshot, and Send report.",
        durationSeconds: 17,
        focus: "rpUserForm",
      },
      {
        title: "Security concerns stay private",
        caption: "Security: only administrators see it, and it is never posted publicly.",
        narration:
          "Security works the same way, and tells the person that security concerns go only to administrators and are never posted publicly.",
        durationSeconds: 10,
        focus: "rpUserSecurity",
      },
      {
        title: "Report sent",
        caption: "\"Report #N sent\", with View status.",
        narration:
          "They see Report sent, with its number. Their administrators can see it now, and View status opens it in My reports.",
        durationSeconds: 9,
        focus: "rpUserSent",
      },
      {
        title: "Needs reply",
        caption: "Admin console › Reports › Needs reply: reports waiting on you.",
        narration:
          "Open Admin console, Reports. Needs reply lists reports where the person spoke last. Open lists every report still being worked, then Closed and All. The new report is here, marked Received.",
        durationSeconds: 15,
        focus: "rpQueue",
      },
      {
        title: "Search the queue",
        caption: "Search by subject, person, or #number.",
        narration:
          "In a busy queue, search by subject, person, or report number. The status and type menus narrow it further.",
        durationSeconds: 9,
        focus: "rpSearch",
      },
      {
        title: "Open the report",
        caption: "Who sent it, the message, and Status, Priority, Assignee, and Type.",
        narration:
          "Select the report. You see who sent it and when, their message, and Technical details if they included them. Above the message are Status, Priority, Assignee, and Type.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "rpTicket",
      },
      {
        title: "Triage it",
        caption: "Each change saves at once. Priority and assignee are marked internal.",
        narration:
          "Set Status to In review, raise Priority to High, and choose an assignee, here Alex Morgan. Each change saves at once and appears in the activity. The person sees status changes; priority and assignee are marked internal.",
        durationSeconds: 17,
        calloutPlacement: "left-rail",
        focus: "rpTriage",
      },
      {
        title: "Keep an internal note",
        caption: "Internal note: only administrators see it.",
        narration:
          "To record something for other administrators, choose Internal note, type it, and choose Add note. It is marked Internal note, and the person never sees it.",
        durationSeconds: 11,
        calloutPlacement: "left-rail",
        focus: "rpInternal",
      },
      {
        title: "Reply to the person",
        caption: "Reply to Jane: the person sees it in My reports.",
        narration:
          "To answer the person, choose Reply to Jane, type your reply, and choose Send reply. They see it in My reports.",
        durationSeconds: 9,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "rpReply",
      },
      {
        title: "The person answers",
        caption: "My reports: your reply, the progress tracker, and Add a reply.",
        narration:
          "In Help, My reports, the person sees your reply and the tracker at In review. Your internal note is not there. They add a reply and choose Send reply.",
        durationSeconds: 12,
        focus: "rpUserReply",
      },
      {
        title: "Back in Needs reply",
        caption: "Their answer puts the report back in Needs reply.",
        narration:
          "Choose Refresh. Their answer puts the report back in Needs reply, marked so you can see who is waiting.",
        durationSeconds: 8,
        focus: "rpNeedsReply",
      },
      {
        title: "Reply and resolve",
        caption: "Reply and resolve sends your reply and marks the report Resolved.",
        narration:
          "Open the report to read their answer. When it is fixed, type a closing reply and choose Reply and resolve. The status reads Resolved, and the report leaves Open.",
        durationSeconds: 12,
        focus: "rpResolved",
      },
      {
        title: "The person sees Resolved",
        caption: "Resolved, with Reopen report if the problem comes back.",
        narration:
          "The person's tracker reads Resolved, with your closing reply. If the problem comes back, they choose Reopen report, and it returns to your queue.",
        durationSeconds: 11,
        focus: "rpUserResolved",
      },
      {
        title: "Every step is audited",
        caption: "Audit Trail, category support: each report, change, and reply.",
        narration:
          "In Audit, choose Refresh in the Audit Trail and set the category filter to support. It records the report, each change, your replies, and the person's reply.",
        durationSeconds: 12,
        calloutPlacement: "left-rail",
        captionPlacement: "top",
        focus: "rpAudit",
      },
      {
        title: "An email for each new report",
        caption: "Alerts › Support-reports template: an email for each new report or reply.",
        narration:
          "To hear about reports without watching this tab, open Alerts and choose Support-reports template. Add recipients and create the rule, as the Alerts and delivery lesson shows.",
        durationSeconds: 13,
        calloutPlacement: "left-rail",
        focus: "alSupportTemplate",
      },
    ],
  },
];

const VIDEO_ICONS = {
  users: UserPlus,
  groups: Users,
  models: SlidersHorizontal,
  tools: Wrench,
  connectors: Plug,
  sso: Mail,
  analytics: BarChart3,
  reports: Inbox,
  policies: SlidersHorizontal,
  audit: ShieldCheck,
  alerts: BellRing,
  retention: DatabaseZap,
  privacy: Lock,
  datasets: Database,
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
      "The full user guide plus every admin tab — users, groups, model access, connections, SSO, analytics, reports, policies and memory, datasets, audit, and alerts — spelled out step by step.",
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
      description="Narrated walkthroughs of every admin surface: users, groups, model access, connections, SSO, analytics, reports, policies and memory, datasets, audit, and alerts."
      backTooltip="Return to the full list of admin walkthroughs"
      onClose={onClose}
    />
  );
}
