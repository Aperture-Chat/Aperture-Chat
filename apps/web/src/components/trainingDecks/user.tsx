import {
  Activity,
  Brain,
  BookOpen,
  Bot,
  CalendarClock,
  Command,
  Eye,
  FileText,
  FolderPlus,
  Info,
  Lock,
  MessageSquare,
  Mic,
  Paperclip,
  Presentation,
  Send,
  Wrench,
} from "lucide-react";
import { TrainingAccessVideo, TrainingGuidePlaylist, type TrainingDeck } from "../TrainingVideoLibrary";
import type { FocusRegion, TrainingVideoBase } from "../trainingVideoKit";

/* Frames are real captures of the current user workspace, taken as a standard
 * user (apps/web/scripts/capture-training-frames.cjs and
 * apps/web/scripts/capture-deck-frames.cjs document the pipeline). */

type UserFocus =
  | "homeComposer"
  | "chatTyped"
  | "modelSelector"
  | "modelFavorites"
  | "toolsChip"
  | "traceCollapsed"
  | "traceExpanded"
  | "responseActions"
  | "transferDraft"
  | "slashMenu"
  | "agentMenu"
  | "hashMenu"
  | "skillMenu"
  | "automationMenu"
  | "sessionShortcuts"
  | "attachUpload"
  | "sendKnowledge"
  | "sendWeb"
  | "sendAgent"
  | "sendReasoning"
  | "sendStreaming"
  | "sessionSummary"
  | "contextWindow"
  | "imageReply"
  | "imageDownload"
  | "mermaidFigure"
  | "searchPalette"
  | "draftComposer"
  | "draftModel"
  | "draftToolbar"
  | "draftAiEdit"
  | "draftSlashMenu"
  | "draftStatusBar"
  | "draftOpenFromDevice"
  | "draftOpenedDocument"
  | "draftSettings"
  | "deckLayoutMenu"
  | "deckTemplatesDrawer"
  | "deckBrandStage"
  | "deckAiEdit"
  | "deckBackgroundMenu"
  | "deckNotes"
  | "deckPresent"
  | "deckExportMenu"
  | "agentsNew"
  | "knowledgeAdd"
  | "toolsHeader"
  | "toolsRows"
  | "automationsNew"
  | "sidebarFolders"
  | "sidebarPinned"
  | "sidebarPreview"
  | "sidebarRowActions"
  | "sidebarChatsHidden"
  | "sidebarNavigation"
  | "memoryAccountEntry"
  | "memorySettings"
  | "memoryAddAndReview"
  | "memoryRecall"
  | "accessRequestEntry"
  | "accessRequestForm"
  | "accessRequestReceived"
  | "accessSignInMethod"
  | "accessOwnPassword"
  | "accessWelcome"
  | "securityOverview"
  | "securityStart"
  | "securityVerify"
  | "securityRecovery"
  | "securityReplace"
  | "securityPassword"
  | "profileEditor"
  | "appearanceControl"
  | "composerShortcuts"
  | "mobileNavigation"
  | "mobileInstall"
  | "helpLibrary"
  | "helpReportForm"
  | "helpReportReceived"
  | "modelAccessOverview"
  | "modelAccessPending"
  | "searchCommands"
  | "searchRecent"
  | "draftSaveState"
  | "draftHistory"
  | "draftHistoryPreview"
  | "unsyncedWork"
  | "themeSchedule"
  | "securitySignIn"
  | "accessPasswordForm"
  | "accessWrongPassword"
  | "accessTrouble"
  | "accessSsoForm"
  | "accessSsoProvider"
  | "accessSsoWelcome"
  | "securityRecoverySignIn"
  | "securityEnabled"
  | "securityCodesRemaining"
  | "securityPasswordUpdated"
  | "modelMenu"
  | "modelAccessWithdrawn"
  | "modelAccessExpired"
  | "modelAccessApproved"
  | "modelReply"
  | "chatStarter"
  | "chatRunning"
  | "chatStopped"
  | "chatEdit"
  | "chatEdited"
  | "chatFeedback"
  | "chatFeedbackSent"
  | "chatBranched"
  | "chatTransferred"
  | "sendOptionsMenu"
  | "sendKnowledgeReply"
  | "sessionSources"
  | "sendWebOn"
  | "sendResourceInserted"
  | "symbolSlashInserted"
  | "symbolAtInserted"
  | "symbolHashInserted"
  | "symbolDollarInserted"
  | "symbolGtQueued"
  | "symbolReply"
  | "attachMenu"
  | "attachFileReady"
  | "attachFileReply"
  | "attachLinkField"
  | "attachLinkChip"
  | "attachLinkReply"
  | "attachConnector"
  | "dictationRecording"
  | "dictationError"
  | "diagramCode"
  | "draftsRequest"
  | "draftsGenerated"
  | "draftsAiMenu"
  | "draftsExportMenu"
  | "draftsExported"
  | "draftsTitle"
  | "deckConvertDialog"
  | "deckConverted"
  | "deckOutlineRequest"
  | "deckGenerated"
  | "deckExported"
  | "deckStarters"
  | "deckTemplateStarted"
  | "historyArchived"
  | "historyRestored"
  | "historyVersions"
  | "historyDelete"
  | "agentsBlocked"
  | "agentProfileForm"
  | "agentKnowledgePick"
  | "agentSkillsPick"
  | "agentAccess"
  | "agentCreated"
  | "agentMention"
  | "agentReply"
  | "knowledgeBlocked"
  | "knowledgeCreate"
  | "knowledgeFiles"
  | "knowledgeWeb"
  | "knowledgeWebAdded"
  | "knowledgeApi"
  | "knowledgeQuestion"
  | "knowledgeReply"
  | "knowledgeSources"
  | "toolsPrompts"
  | "toolsPromptView"
  | "toolsSkills"
  | "toolsAddConnection"
  | "automationWhat"
  | "automationSteps"
  | "automationDaily"
  | "automationOnce"
  | "automationCustom"
  | "automationWeekly"
  | "automationDeliver"
  | "automationSaved"
  | "automationRunOutput"
  | "automationResultChat"
  | "automationHistory"
  | "automationPaused"
  | "automationDraftTarget"
  | "automationResultDraft"
  | "organizeFolderNew"
  | "organizeMoveMenu"
  | "organizeArchived"
  | "organizeRenamed"
  | "previewAllChats"
  | "searchResults"
  | "searchOpened"
  | "searchCommandDone"
  | "memoryRejected"
  | "memorySavedChat"
  | "memorySavedList"
  | "profileSaved"
  | "installIpad"
  | "installAndroid"
  | "privacyFooter"
  | "privacyPrompt"
  | "privacyReply"
  | "privacyRatingNote"
  | "privacyOutput";

export const USER_FOCUS_REGIONS: Record<UserFocus, FocusRegion> = {
  // Captured and measured by the current training refresh pipeline.
  modelFavorites: { frame: "training/user/models-starred.png", rect: { x: 930, y: 61, w: 253, h: 55 } },
  modelAccessOverview: { frame: "training/user/models-explainer.png", rect: { x: 249, y: 82, w: 687, h: 657 } },
  modelAccessPending: { frame: "training/user/models-requested.png", rect: { x: 262, y: 611, w: 661, h: 115 } },
  searchCommands: { frame: "training/user/search-commands.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  searchRecent: { frame: "training/user/search-recent.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  draftSaveState: { frame: "training/user/drafts-saved.png", rect: { x: 453, y: 0, w: 732, h: 180 } },
  draftHistory: { frame: "training/user/history-open.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  draftHistoryPreview: { frame: "training/user/draft-history.png", rect: { x: 433.609375, y: 286.421875, w: 300, h: 226 } },
  unsyncedWork: { frame: "training/user/unsynced-work.png", rect: { x: 312.5, y: 119.688, w: 560, h: 288 } },
  themeSchedule: { frame: "training/user/theme-schedule-set.png", rect: { x: 359, y: 257, w: 467, h: 340 } },
  securitySignIn: { frame: "training/user/security-sign-in-code.png", rect: { x: 56, y: 143, w: 495, h: 569 } },
  homeComposer: { frame: "training/user/chat-home.png", rect: { x: 292, y: 288, w: 827, h: 199 } },
  chatTyped: { frame: "training/user/chat-typed.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  modelSelector: { frame: "training/user/chat-typed.png", rect: { x: 923, y: 10, w: 193, h: 45 } },
  toolsChip: { frame: "training/user/send-tools-chip.png", rect: { x: 349, y: 479, w: 135, h: 39 } },
  // chat-thread.png shows a scrolled, completed answer with no trace bar, so
  // the collapsed-trace scene targets the summary header row of the Work trace
  // card instead; sharing the frame with traceExpanded also glides the
  // highlight from the header into the full step list.
  traceCollapsed: { frame: "training/user/chat-edited.png", rect: { x: 328, y: 263, w: 600, h: 30 } },
  traceExpanded: { frame: "training/user/trace-expanded.png", rect: { x: 315, y: 250, w: 626, h: 230 } },
  responseActions: { frame: "training/user/chat-copied.png", rect: { x: 315, y: 450, w: 686, h: 37 } },
  transferDraft: { frame: "training/user/chat-edited.png", rect: { x: 1006, y: 447, w: 148, h: 42 } },
  slashMenu: { frame: "training/user/symbols-slash.png", rect: { x: 258, y: 279, w: 895, h: 325 } },
  agentMenu: { frame: "training/user/symbols-at.png", rect: { x: 258, y: 467, w: 895, h: 137 } },
  hashMenu: { frame: "training/user/symbols-hash.png", rect: { x: 258, y: 258, w: 895, h: 346 } },
  skillMenu: { frame: "training/user/symbols-dollar.png", rect: { x: 258, y: 365, w: 895, h: 239 } },
  automationMenu: { frame: "training/user/symbols-gt.png", rect: { x: 258, y: 389, w: 895, h: 189 } },
  sessionShortcuts: { frame: "training/user/session-shortcuts.png", rect: { x: 881, y: 550, w: 289, h: 305 } },
  attachUpload: { frame: "training/user/attach-menu.png", rect: { x: 317, y: 153, w: 247, h: 45 } },
  sendKnowledge: { frame: "training/user/send-knowledge.png", rect: { x: 667, y: 311, w: 441, h: 103 } },
  sendWeb: { frame: "training/user/send-menu.png", rect: { x: 667, y: 382, w: 441, h: 51 } },
  sendAgent: { frame: "training/user/send-agent.png", rect: { x: 667, y: 381, w: 441, h: 142 } },
  sendReasoning: { frame: "training/user/send-menu.png", rect: { x: 667, y: 479, w: 441, h: 43 } },
  sendStreaming: { frame: "training/user/send-menu.png", rect: { x: 667, y: 515, w: 441, h: 33 } },
  sessionSummary: { frame: "training/user/session-summary.png", rect: { x: 881, y: 0, w: 289, h: 322 } },
  contextWindow: { frame: "training/user/session-context.png", rect: { x: 881, y: 0, w: 289, h: 233 } },
  imageReply: { frame: "training/user/chat-images.png", rect: { x: 316, y: 342, w: 516, h: 513 } },
  imageDownload: { frame: "training/user/chat-images-download.png", rect: { x: 715, y: 476, w: 106, h: 34 } },
  mermaidFigure: { frame: "training/user/diagram-rendered.png", rect: { x: 315, y: 353, w: 839, h: 147 } },
  searchPalette: { frame: "training/user/search-empty.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  draftComposer: { frame: "training/user/drafts-blank.png", rect: { x: 91, y: 686, w: 349, h: 150 } },
  draftModel: { frame: "training/user/drafts-blank.png", rect: { x: 481, y: 67, w: 327, h: 48 } },
  draftToolbar: { frame: "training/user/drafts-generated.png", rect: { x: 453, y: 174, w: 732, h: 84 } },
  draftAiEdit: { frame: "training/user/drafts-ai-review.png", rect: { x: 548, y: 127, w: 467, h: 351 } },
  draftSlashMenu: { frame: "training/user/draft-slash.png", rect: { x: 555.640625, y: 390.8125, w: 292, h: 380 } },
  draftStatusBar: { frame: "training/user/draft-find.png", rect: { x: 456, y: 821, w: 729, h: 34 } },
  draftOpenFromDevice: { frame: "training/user/drafts-open-menu.png", rect: { x: 111, y: 413, w: 294, h: 106 } },
  draftOpenedDocument: { frame: "training/user/drafts-opened.png", rect: { x: 500, y: 276, w: 641, h: 548 } },
  draftSettings: { frame: "training/user/draft-settings.png", rect: { x: 103, y: 400.96875, w: 325, h: 265.03125 } },
  deckLayoutMenu: { frame: "training/user/deck-layouts.png", rect: { x: 656, y: 246, w: 497, h: 155 } },
  deckTemplatesDrawer: { frame: "training/user/deck-templates.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  deckBrandStage: { frame: "training/user/deck-editor-brand.png", rect: { x: 656, y: 418, w: 497, h: 283 } },
  deckAiEdit: { frame: "training/user/deck-ai-edit.png", rect: { x: 671, y: 268, w: 467, h: 453 } },
  deckBackgroundMenu: { frame: "training/user/deck-background.png", rect: { x: 899, y: 221, w: 231, h: 181 } },
  deckNotes: { frame: "training/user/deck-notes.png", rect: { x: 656, y: 718, w: 497, h: 118 } },
  deckPresent: { frame: "training/user/deck-presenter.png", rect: { x: 772, y: 73, w: 392, h: 761 } },
  deckExportMenu: { frame: "training/user/deck-export-menu.png", rect: { x: 773, y: 169, w: 387, h: 262 } },
  agentsNew: { frame: "training/user/agents-page.png", rect: { x: 1027, y: 176, w: 124, h: 45 } },
  knowledgeAdd: { frame: "training/user/knowledge-page.png", rect: { x: 959, y: 176, w: 192, h: 45 } },
  toolsHeader: { frame: "training/user/tools-connections.png", rect: { x: 260, y: 154, w: 312, h: 47 } },
  toolsRows: { frame: "training/user/tools-connections.png", rect: { x: 260, y: 328, w: 891, h: 527 } },
  automationsNew: { frame: "training/user/automations-page.png", rect: { x: 991, y: 176, w: 160, h: 45 } },
  sidebarFolders: { frame: "training/user/organize-filed.png", rect: { x: 9, y: 336, w: 194, h: 117 } },
  sidebarPinned: { frame: "training/user/organize-pinned.png", rect: { x: 9, y: 447, w: 194, h: 105 } },
  sidebarPreview: { frame: "training/user/preview-sidebar.png", rect: { x: 235, y: 255, w: 486, h: 591 } },
  sidebarRowActions: { frame: "training/user/organize-row-menu.png", rect: { x: 5, y: 627, w: 196, h: 149 } },
  sidebarChatsHidden: { frame: "training/user/organize-hidden.png", rect: { x: 9, y: 336, w: 194, h: 34 } },
  sidebarNavigation: { frame: "training/user/organize-sidebar.png", rect: { x: 14, y: 85, w: 202, h: 222 } },
  memoryAccountEntry: { frame: "training/user/memory-entry.png", rect: { x: 777, y: 192, w: 382, h: 65 } },
  memorySettings: { frame: "training/user/memory-settings.png", rect: { x: 280, y: 236, w: 625, h: 99 } },
  memoryAddAndReview: { frame: "training/user/memory-added.png", rect: { x: 280, y: 311, w: 625, h: 351 } },
  memoryRecall: { frame: "training/user/memory-recalled.png", rect: { x: 315, y: 311, w: 839, h: 85 } },
  accessRequestEntry: { frame: "training/user/access-sign-in-page.png", rect: { x: 101, y: 694, w: 405, h: 135 } },
  accessRequestForm: { frame: "training/user/access-request-filled.png", rect: { x: 101, y: 357, w: 405, h: 298 } },
  accessRequestReceived: { frame: "training/user/access-request-sent.png", rect: { x: 101, y: 314, w: 405, h: 415 } },
  accessSignInMethod: { frame: "training/user/access-sign-in-page.png", rect: { x: 101, y: 317, w: 405, h: 61 } },
  accessOwnPassword: { frame: "training/user/access-set-password.png", rect: { x: 345, y: 165, w: 495, h: 525 } },
  accessWelcome: { frame: "training/user/access-first-welcome.png", rect: { x: 258, y: 21, w: 895, h: 259 } },
  securityOverview: { frame: "training/user/security-overview.png", rect: { x: 790, y: 323, w: 356, h: 117 } },
  securityStart: { frame: "training/user/security-start.png", rect: { x: 790, y: 323, w: 356, h: 250 } },
  securityVerify: { frame: "training/user/account-authenticator-verify.png", rect: { x: 793, y: 741.578, w: 350, h: 100 } },
  securityRecovery: { frame: "training/user/account-recovery-save.png", rect: { x: 793, y: 309.375, w: 350, h: 532.188 } },
  securityReplace: { frame: "training/user/security-replace.png", rect: { x: 790, y: 260, w: 356, h: 336 } },
  securityPassword: { frame: "training/user/security-password-form.png", rect: { x: 777, y: 270, w: 382, h: 314 } },
  profileEditor: { frame: "training/user/account-profile-edit.png", rect: { x: 777, y: 192, w: 382, h: 654 } },
  appearanceControl: { frame: "training/user/appearance-dark.png", rect: { x: 9, y: 731, w: 207, h: 40 } },
  composerShortcuts: { frame: "training/user/send-resources.png", rect: { x: 656, y: 55, w: 463, h: 745 } },
  mobileNavigation: { frame: "training/user/mobile-navigation.png", rect: { x: 394.959, y: 0, w: 303.91, h: 855 }, fit: "contain" },
  mobileInstall: { frame: "training/user/mobile-install-ios.png", rect: { x: 415.219, y: 245.154, w: 354.562, h: 363.679 }, fit: "contain" },
  helpLibrary: { frame: "training/user/help-drawer.png", rect: { x: 760, y: 9, w: 416, h: 837 } },
  helpReportForm: { frame: "training/user/help-report-filled.png", rect: { x: 777, y: 149, w: 382, h: 521 } },
  helpReportReceived: { frame: "training/user/help-report-sent.png", rect: { x: 777, y: 149, w: 382, h: 147 } },
  accessPasswordForm: { frame: "training/user/access-password-method.png", rect: { x: 101, y: 295, w: 405, h: 362 } },
  accessWrongPassword: { frame: "training/user/access-wrong-password.png", rect: { x: 101, y: 295, w: 405, h: 418 } },
  accessTrouble: { frame: "training/user/access-trouble.png", rect: { x: 101, y: 630, w: 405, h: 155 } },
  accessSsoForm: { frame: "training/user/access-sso-email.png", rect: { x: 101, y: 317, w: 405, h: 356 } },
  accessSsoProvider: { frame: "training/user/access-sso-idp.png", rect: { x: 387, y: 368, w: 411, h: 227 } },
  accessSsoWelcome: { frame: "training/user/access-sso-welcome.png", rect: { x: 258, y: 21, w: 895, h: 259 } },
  securityRecoverySignIn: { frame: "training/user/security-sign-in-recovery.png", rect: { x: 56, y: 143, w: 495, h: 569 } },
  securityEnabled: { frame: "training/user/security-enabled.png", rect: { x: 790, y: 317, w: 356, h: 222 } },
  securityCodesRemaining: { frame: "training/user/security-codes-remaining.png", rect: { x: 790, y: 317, w: 356, h: 222 } },
  securityPasswordUpdated: { frame: "training/user/security-password-updated.png", rect: { x: 777, y: 365, w: 382, h: 85 } },
  modelMenu: { frame: "training/user/models-menu.png", rect: { x: 923, y: 54, w: 262, h: 111 } },
  modelAccessWithdrawn: { frame: "training/user/models-withdrawn.png", rect: { x: 262, y: 145, w: 661, h: 23 } },
  modelAccessExpired: { frame: "training/user/models-signed-out.png", rect: { x: 262, y: 145, w: 661, h: 23 } },
  modelAccessApproved: { frame: "training/user/models-approved.png", rect: { x: 262, y: 145, w: 661, h: 140 } },
  modelReply: { frame: "training/user/models-reply.png", rect: { x: 257, y: 219, w: 897, h: 189 } },
  chatStarter: { frame: "training/user/chat-starter.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  chatRunning: { frame: "training/user/chat-running.png", rect: { x: 315, y: 250, w: 626, h: 149 } },
  chatStopped: { frame: "training/user/chat-stopped.png", rect: { x: 257, y: 219, w: 897, h: 81 } },
  chatEdit: { frame: "training/user/chat-edit.png", rect: { x: 257, y: 93, w: 897, h: 170 } },
  chatEdited: { frame: "training/user/chat-edited.png", rect: { x: 257, y: 219, w: 897, h: 270 } },
  chatFeedback: { frame: "training/user/chat-feedback.png", rect: { x: 315, y: 489, w: 839, h: 124 } },
  chatFeedbackSent: { frame: "training/user/chat-feedback-sent.png", rect: { x: 315, y: 447, w: 839, h: 42 } },
  chatBranched: { frame: "training/user/chat-branched.png", rect: { x: 249, y: 20, w: 335, h: 25 } },
  chatTransferred: { frame: "training/user/chat-transferred.png", rect: { x: 500, y: 276, w: 641, h: 548 } },
  sendOptionsMenu: { frame: "training/user/send-menu.png", rect: { x: 656, y: 197, w: 463, h: 460 } },
  sendKnowledgeReply: { frame: "training/user/send-knowledge-reply.png", rect: { x: 257, y: 219, w: 897, h: 209 } },
  sessionSources: { frame: "training/user/session-sources.png", rect: { x: 881, y: 196, w: 289, h: 325 } },
  sendWebOn: { frame: "training/user/send-web-on.png", rect: { x: 667, y: 382, w: 441, h: 51 } },
  sendResourceInserted: { frame: "training/user/send-resource-inserted.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  symbolSlashInserted: { frame: "training/user/symbols-slash-inserted.png", rect: { x: 257, y: 605, w: 897, h: 198 } },
  symbolAtInserted: { frame: "training/user/symbols-at-inserted.png", rect: { x: 257, y: 605, w: 897, h: 198 } },
  symbolHashInserted: { frame: "training/user/symbols-hash-inserted.png", rect: { x: 257, y: 605, w: 897, h: 198 } },
  symbolDollarInserted: { frame: "training/user/symbols-dollar-inserted.png", rect: { x: 257, y: 578, w: 897, h: 252 } },
  symbolGtQueued: { frame: "training/user/symbols-gt-queued.png", rect: { x: 257, y: 578, w: 897, h: 252 } },
  symbolReply: { frame: "training/user/symbols-reply.png", rect: { x: 257, y: 292, w: 897, h: 277 } },
  attachMenu: { frame: "training/user/attach-menu.png", rect: { x: 311, y: 147, w: 259, h: 283 } },
  attachFileReady: { frame: "training/user/attach-file-ready.png", rect: { x: 292, y: 313, w: 827, h: 252 } },
  attachFileReply: { frame: "training/user/attach-file-reply.png", rect: { x: 257, y: 306, w: 897, h: 193 } },
  attachLinkField: { frame: "training/user/attach-link-field.png", rect: { x: 276, y: 576, w: 857, h: 44 } },
  attachLinkChip: { frame: "training/user/attach-link-chip.png", rect: { x: 257, y: 557, w: 897, h: 246 } },
  attachLinkReply: { frame: "training/user/attach-link-reply.png", rect: { x: 257, y: 400, w: 897, h: 169 } },
  attachConnector: { frame: "training/user/attach-connector.png", rect: { x: 309, y: 275, w: 567, h: 305 } },
  dictationRecording: { frame: "training/user/dictation-recording.png", rect: { x: 292, y: 291, w: 827, h: 199 } },
  dictationError: { frame: "training/user/dictation-error.png", rect: { x: 311, y: 308, w: 789, h: 200 } },
  diagramCode: { frame: "training/user/diagram-code.png", rect: { x: 315, y: 353, w: 839, h: 132 } },
  draftsRequest: { frame: "training/user/drafts-request.png", rect: { x: 91, y: 667, w: 349, h: 169 } },
  draftsGenerated: { frame: "training/user/drafts-generated.png", rect: { x: 500, y: 252, w: 641, h: 572 } },
  draftsAiMenu: { frame: "training/user/drafts-ai-menu.png", rect: { x: 548, y: 22, w: 467, h: 456 } },
  draftsExportMenu: { frame: "training/user/drafts-export-menu.png", rect: { x: 773, y: 169, w: 387, h: 374 } },
  draftsExported: { frame: "training/user/drafts-exported.png", rect: { x: 773, y: 169, w: 387, h: 477 } },
  draftsTitle: { frame: "training/user/drafts-generated.png", rect: { x: 721, y: 14, w: 211, h: 44 } },
  deckConvertDialog: { frame: "training/user/deck-convert-dialog.png", rect: { x: 488, y: 183, w: 387, h: 179 } },
  deckConverted: { frame: "training/user/deck-converted.png", rect: { x: 453, y: 224, w: 174, h: 631 } },
  deckOutlineRequest: { frame: "training/user/deck-outline-request.png", rect: { x: 91, y: 686, w: 349, h: 150 } },
  deckGenerated: { frame: "training/user/deck-generated.png", rect: { x: 453, y: 224, w: 174, h: 631 } },
  deckExported: { frame: "training/user/deck-exported.png", rect: { x: 773, y: 169, w: 387, h: 348 } },
  deckStarters: { frame: "training/user/deck-starters.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  deckTemplateStarted: { frame: "training/user/deck-template-started.png", rect: { x: 453, y: 224, w: 174, h: 631 } },
  historyArchived: { frame: "training/user/history-archived.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  historyRestored: { frame: "training/user/history-restored.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  historyVersions: { frame: "training/user/history-versions.png", rect: { x: 100, y: 495, w: 327, h: 174 } },
  historyDelete: { frame: "training/user/history-delete.png", rect: { x: 359, y: 297, w: 467, h: 261 } },
  agentsBlocked: { frame: "training/user/agents-blocked.png", rect: { x: 260, y: 176, w: 891, h: 68 } },
  agentProfileForm: { frame: "training/user/agent-profile.png", rect: { x: 261, y: 291, w: 889, h: 532 } },
  agentKnowledgePick: { frame: "training/user/agent-knowledge.png", rect: { x: 261, y: 291, w: 889, h: 210 } },
  agentSkillsPick: { frame: "training/user/agent-skills.png", rect: { x: 261, y: 291, w: 889, h: 305 } },
  agentAccess: { frame: "training/user/agent-access.png", rect: { x: 261, y: 291, w: 889, h: 112 } },
  agentCreated: { frame: "training/user/agent-created.png", rect: { x: 260, y: 237, w: 891, h: 49 } },
  agentMention: { frame: "training/user/agent-mention.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  agentReply: { frame: "training/user/agent-reply.png", rect: { x: 315, y: 98, w: 839, h: 253 } },
  knowledgeBlocked: { frame: "training/user/knowledge-blocked.png", rect: { x: 260, y: 176, w: 891, h: 49 } },
  knowledgeCreate: { frame: "training/user/knowledge-create.png", rect: { x: 329, y: 211, w: 527, h: 433 } },
  knowledgeFiles: { frame: "training/user/knowledge-files.png", rect: { x: 261, y: 349, w: 889, h: 472 } },
  knowledgeWeb: { frame: "training/user/knowledge-web.png", rect: { x: 283, y: 371, w: 845, h: 219 } },
  knowledgeWebAdded: { frame: "training/user/knowledge-web-added.png", rect: { x: 261, y: 365, w: 889, h: 363 } },
  knowledgeApi: { frame: "training/user/knowledge-api.png", rect: { x: 283, y: 387, w: 845, h: 304 } },
  knowledgeQuestion: { frame: "training/user/knowledge-question.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  knowledgeReply: { frame: "training/user/knowledge-reply.png", rect: { x: 257, y: 219, w: 897, h: 297 } },
  knowledgeSources: { frame: "training/user/knowledge-sources.png", rect: { x: 881, y: 211, w: 289, h: 310 } },
  toolsPrompts: { frame: "training/user/tools-prompts.png", rect: { x: 260, y: 356, w: 891, h: 464 } },
  toolsPromptView: { frame: "training/user/tools-prompt-view.png", rect: { x: 260, y: 333, w: 891, h: 522 } },
  toolsSkills: { frame: "training/user/tools-skills.png", rect: { x: 260, y: 356, w: 891, h: 464 } },
  toolsAddConnection: { frame: "training/user/tools-add-connection.png", rect: { x: 260, y: 273, w: 891, h: 387 } },
  automationWhat: { frame: "training/user/automation-what.png", rect: { x: 261, y: 248, w: 889, h: 238 } },
  automationSteps: { frame: "training/user/automation-steps.png", rect: { x: 261, y: 206, w: 889, h: 326 } },
  automationDaily: { frame: "training/user/automation-daily.png", rect: { x: 261, y: 396, w: 889, h: 231 } },
  automationOnce: { frame: "training/user/automation-once.png", rect: { x: 261, y: 396, w: 889, h: 231 } },
  automationCustom: { frame: "training/user/automation-custom.png", rect: { x: 261, y: 384, w: 889, h: 263 } },
  automationWeekly: { frame: "training/user/automation-weekly.png", rect: { x: 261, y: 384, w: 889, h: 279 } },
  automationDeliver: { frame: "training/user/automation-deliver.png", rect: { x: 261, y: 620, w: 889, h: 126 } },
  automationSaved: { frame: "training/user/automation-saved.png", rect: { x: 260, y: 292, w: 891, h: 216 } },
  automationRunOutput: { frame: "training/user/automation-run-output.png", rect: { x: 260, y: 157, w: 891, h: 541 } },
  automationResultChat: { frame: "training/user/automation-result-chat.png", rect: { x: 257, y: 219, w: 897, h: 127 } },
  automationHistory: { frame: "training/user/automation-history.png", rect: { x: 260, y: 520, w: 891, h: 310 } },
  automationPaused: { frame: "training/user/automation-paused.png", rect: { x: 260, y: 520, w: 891, h: 310 } },
  automationDraftTarget: { frame: "training/user/automation-draft-target.png", rect: { x: 261, y: 620, w: 889, h: 126 } },
  automationResultDraft: { frame: "training/user/automation-result-draft.png", rect: { x: 500, y: 276, w: 641, h: 548 } },
  organizeFolderNew: { frame: "training/user/organize-folder-new.png", rect: { x: 9, y: 368, w: 194, h: 36 } },
  organizeMoveMenu: { frame: "training/user/organize-move-menu.png", rect: { x: 5, y: 659, w: 196, h: 108 } },
  organizeArchived: { frame: "training/user/organize-archived.png", rect: { x: 777, y: 599, w: 382, h: 162 } },
  organizeRenamed: { frame: "training/user/organize-renamed.png", rect: { x: 249, y: 20, w: 269, h: 25 } },
  previewAllChats: { frame: "training/user/preview-all-chats.png", rect: { x: 268, y: 284, w: 486, h: 326 } },
  searchResults: { frame: "training/user/search-results.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  searchOpened: { frame: "training/user/search-opened.png", rect: { x: 257, y: 239, w: 897, h: 303 } },
  searchCommandDone: { frame: "training/user/search-command-done.png", rect: { x: 142, y: 732, w: 38, h: 38 } },
  memoryRejected: { frame: "training/user/memory-rejected.png", rect: { x: 280, y: 303, w: 625, h: 82 } },
  memorySavedChat: { frame: "training/user/memory-saved-chat.png", rect: { x: 257, y: 219, w: 897, h: 250 } },
  memorySavedList: { frame: "training/user/memory-saved-list.png", rect: { x: 280, y: 655, w: 625, h: 63 } },
  profileSaved: { frame: "training/user/account-profile-saved.png", rect: { x: 777, y: 130, w: 382, h: 115 } },
  installIpad: { frame: "training/user/install-ipad.png", rect: { x: 389, y: 223, w: 407, h: 409 } },
  installAndroid: { frame: "training/user/install-android.png", rect: { x: 389, y: 231, w: 407, h: 393 } },
  privacyFooter: { frame: "training/user/privacy-footer.png", rect: { x: 270, y: 630, w: 871, h: 23 } },
  privacyPrompt: { frame: "training/user/privacy-sent.png", rect: { x: 257, y: 93, w: 897, h: 105 } },
  privacyReply: { frame: "training/user/privacy-sent.png", rect: { x: 315, y: 312, w: 839, h: 53 } },
  privacyRatingNote: { frame: "training/user/privacy-rating-note.png", rect: { x: 315, y: 370, w: 839, h: 154 } },
  privacyOutput: { frame: "training/user/privacy-output.png", rect: { x: 315, y: 312, w: 839, h: 27 } },
};

type UserGuideIcon =
  | "chat"
  | "trace"
  | "commands"
  | "attach"
  | "dictation"
  | "send"
  | "session"
  | "drafts"
  | "deck"
  | "agents"
  | "knowledge"
  | "tools"
  | "automation"
  | "preview"
  | "organize"
  | "memory"
  | "privacy";

export type UserTrainingVideo = TrainingVideoBase & { icon: UserGuideIcon };

export const USER_TRAINING_VIDEOS: UserTrainingVideo[] = [
  {
    id: "access-and-sign-in",
    audioSrc: "training/user/access-and-sign-in.mp3",
    title: "Request access and enter your workspace",
    description: "Ask for an account, then sign in with a temporary password, your own password, Organization SSO, or an authenticator code.",
    icon: "chat",
    track: "Get started",
    outcomes: ["Access requested", "Temporary password replaced", "Signed in with a password or Organization SSO", "Welcome card reached"],
    prerequisites: [
      "Your workspace address, which your organization gives you (for example https://your-instance.example).",
      "Your work email address.",
      "For Organization SSO: an account at your organization's identity provider, such as Microsoft Entra ID, Okta, or Google.",
      "For a password account: the temporary password your administrator gives you after approving your request.",
      "If two-step verification is on for your account: your authenticator app, or one unused recovery code.",
    ],
    setupSteps: [
      "Open your workspace address in a web browser. The sign-in page opens.",
      "Under New to Aperture Chat?, choose Request access.",
      "Enter First name, Last name, and Work email, then choose Submit access request.",
      "Read Request received. The form does not send an email or set a password. Contact your administrator, who approves the request and tells you how to sign in.",
      "When your administrator gives you a temporary password, return to the sign-in page and choose Email & password (it appears beside Organization SSO when your workspace offers both).",
      "Enter your work email and the temporary password, then choose Sign in.",
      "On Set a new password, type a password of at least 12 characters into New password and Confirm password, then choose Set password and continue.",
      "Check that the welcome card, A good place to begin., says You're signed in.",
    ],
    paths: [
      {
        label: "Organization SSO",
        steps: [
          "Open your workspace address. Organization SSO is selected first when your workspace offers it.",
          "Optionally type your work email. It selects your organization's provider, shown as Sign in with followed by the provider's name.",
          "Choose Continue with SSO.",
          "Sign in on your identity provider's page, including any multifactor check it asks for. Aperture Chat never sees that password.",
          "You return to the workspace signed in. On your first visit your account is created automatically if your organization allows it; otherwise ask your administrator to add you.",
        ],
      },
      {
        label: "Email & password",
        steps: [
          "Choose Email & password.",
          "Enter your work email and your password, then choose Sign in.",
          "If two-step verification is on, follow the Authenticator code path.",
          "The workspace opens where you left off.",
        ],
      },
      {
        label: "Authenticator code",
        steps: [
          "After Sign in, Two-step verification asks for a code. It shows the attempts remaining and when the challenge expires (about five minutes).",
          "Open your authenticator app and type the current 6-digit code into Authenticator code.",
          "Choose Verify and continue.",
          "No phone? Choose Use a recovery code instead, type one unused recovery code, and choose Verify and continue. Each code works once.",
          "If the challenge expires, choose Back to sign in and start again.",
        ],
      },
      {
        label: "Trouble signing in",
        steps: [
          "Choose Trouble signing in? under the sign-in button.",
          "For Organization SSO, use your organization's own password recovery.",
          "For an email-and-password account, ask your workspace administrator for a temporary password.",
          "If you lost your authenticator and have no recovery codes, ask your administrator to reset two-step verification for your account.",
        ],
      },
    ],
    verify: [
      "The welcome card A good place to begin. shows You're signed in.",
      "Your name appears on the account card at the bottom of the sidebar.",
      "With Organization SSO, the identity provider's page handled your password and you returned signed in.",
    ],
    troubleshooting: [
      { symptom: "\"Invalid local credentials.\"", fix: "The password is wrong. Retype it (Show password helps), or ask your administrator for a new temporary password." },
      { symptom: "\"Unknown local account.\"", fix: "There is no active password account for that email yet: the request may still be pending, or your account signs in with Organization SSO. Choose Organization SSO, or ask your administrator." },
      { symptom: "\"SSO is enforced for this email domain; local sign-in is disabled. Use the configured identity provider.\"", fix: "Your organization requires single sign-on for your domain. Choose Organization SSO and Continue with SSO." },
      { symptom: "\"Use a password with at least 12 characters.\" or \"The passwords do not match.\"", fix: "On Set a new password, use 12 or more characters and type the same password in both fields." },
      { symptom: "\"Choose a new password.\"", fix: "The new password matches the temporary one. Pick a different password." },
      { symptom: "\"The MFA code is invalid.\" or \"Too many MFA attempts.\"", fix: "Wait for the next code in your authenticator app and check that your phone's clock is set automatically. After too many attempts, wait for the timer, or choose Back to sign in." },
      { symptom: "\"Verification unavailable\"", fix: "The sign-in challenge expired or was used up. Choose Back to sign in and sign in again." },
      { symptom: "\"Too many failed sign-in attempts for this account. Try again shortly.\"", fix: "Wait a minute before trying again, or use Trouble signing in?." },
      { symptom: "\"Too many access requests for this email. Try again shortly.\"", fix: "Your request was already recorded. Contact your administrator instead of submitting again." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "Have your workspace address, your work email, and your sign-in method ready.",
        narration: "This walkthrough takes you from your first visit to an open workspace, by every route your organization might use. Have your workspace address and your work email ready. If you already have an account, know whether you sign in with Organization S S O or with an email and password, and keep your authenticator app nearby if two-step verification is on.",
        durationSeconds: 23,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "Your workspace address, for example https://your-instance.example.",
            "Your work email address.",
            "How you sign in: Organization SSO, or an email and password.",
            "Your authenticator app or a recovery code, if two-step verification is on.",
          ],
        },
      },
      {
        title: "Start at your workspace address",
        caption: "Every visit starts on the sign-in page. This workspace offers Organization SSO and Email & password.",
        narration: "Open your workspace address in a web browser. Every visit starts here, on the sign-in page. When your organization offers both methods, the page shows two choices: Organization S S O and Email and password.",
        durationSeconds: 16,
        focus: "accessSignInMethod",
        calloutPlacement: "right-mid",
      },
      {
        title: "New here? Request access",
        caption: "No account yet? Under New to Aperture Chat?, choose Request access.",
        narration: "If you do not have an account yet, look under New to Aperture Chat, and choose Request access.",
        durationSeconds: 8,
        focus: "accessRequestEntry",
        calloutPlacement: "right-mid",
        captionPlacement: "top",
      },
      {
        title: "Ask to join",
        caption: "Enter your first name, last name, and work email, then Submit access request.",
        narration: "Enter your first name, your last name, and your work email. Then choose Submit access request.",
        durationSeconds: 8,
        focus: "accessRequestForm",
        calloutPlacement: "right-mid",
      },
      {
        title: "Request received",
        caption: "The request waits for your administrator. The form sends no email and sets no password.",
        narration: "Request received confirms the email you submitted. Your request now waits for administrator review. This form does not send an email or set a password, so contact your administrator for an update.",
        durationSeconds: 14,
        focus: "accessRequestReceived",
        calloutPlacement: "right-mid",
      },
      {
        title: "Your administrator's part",
        caption: "Your administrator approves the request and tells you how to sign in.",
        narration: "The next step happens outside Aperture Chat. Your administrator approves the request and chooses how you sign in: through your organization's single sign-on, or with a temporary password that they give you directly. When you hear back, return to the workspace address.",
        durationSeconds: 18,
        card: {
          label: "Outside Aperture Chat",
          where: "Wait for your administrator",
          steps: [
            "Your administrator approves your request.",
            "They tell you to use Organization SSO, or give you a temporary password.",
            "Keep a temporary password private; you replace it at your first sign-in.",
            "Return to your workspace address when you hear back.",
          ],
        },
      },
      {
        title: "Choose Email & password",
        caption: "With a temporary password, choose Email & password and enter your work email.",
        narration: "With a temporary password, choose Email and password. Enter your work email, then the temporary password, and choose Sign in.",
        durationSeconds: 10,
        focus: "accessPasswordForm",
        calloutPlacement: "right-mid",
      },
      {
        title: "A wrong password is refused",
        caption: "A mistyped password shows Invalid local credentials. Retype it carefully.",
        narration: "If the password is mistyped, sign-in stops with: Invalid local credentials. Retype it carefully. The eye button shows what you typed. Too many failures in a minute pause sign-in for that account briefly.",
        durationSeconds: 15,
        focus: "accessWrongPassword",
        calloutPlacement: "right-mid",
      },
      {
        title: "Set a new password",
        caption: "A temporary password leads to Set a new password: 12 or more characters, typed twice.",
        narration: "A temporary password works once. Set a new password appears, and greets you by name. Type a password of at least twelve characters, type it again to confirm, and choose Set password and continue.",
        durationSeconds: 14,
        focus: "accessOwnPassword",
        calloutPlacement: "left-rail",
      },
      {
        title: "You are signed in",
        caption: "The welcome card confirms You're signed in and shows how many models you can use.",
        narration: "The workspace opens with the welcome card. You're signed in, and Choose your model shows how many models your account can use. Open quick-start guide, or choose I'll explore on my own.",
        durationSeconds: 13,
        focus: "accessWelcome",
      },
      {
        title: "Sign in with Organization SSO",
        caption: "Organization SSO: your email selects your organization's provider. Choose Continue with SSO.",
        narration: "If your organization uses single sign-on, choose Organization S S O. Typing your work email is optional; it selects your organization's provider, shown here as Sign in with Keycloak. Yours may be Microsoft Entra I D, Okta, or Google. Choose Continue with S S O.",
        durationSeconds: 20,
        focus: "accessSsoForm",
        calloutPlacement: "right-mid",
      },
      {
        title: "Sign in at your identity provider",
        caption: "Your organization's own sign-in page handles the password and any multifactor check.",
        narration: "The browser moves to your organization's own sign-in page. Sign in there, including any multifactor check it asks for. Aperture Chat never sees this password.",
        durationSeconds: 12,
        focus: "accessSsoProvider",
        calloutPlacement: "right-mid",
      },
      {
        title: "Back in the workspace",
        caption: "The provider returns you signed in. A first visit can create your account automatically.",
        narration: "The provider sends you back, already signed in. On your first visit, your account is created automatically if your organization allows it. If it is not, you see a message, and your administrator adds you.",
        durationSeconds: 14,
        focus: "accessSsoWelcome",
      },
      {
        title: "Enter your authenticator code",
        caption: "With two-step verification on, enter the current 6-digit code and choose Verify and continue.",
        narration: "If two-step verification is on for your account, a second screen follows your password. Open your authenticator app, type the current six digit code, and choose Verify and continue. The screen shows how many attempts remain and when this challenge expires.",
        durationSeconds: 18,
        focus: "securitySignIn",
        calloutPlacement: "right-mid",
      },
      {
        title: "Or use a recovery code",
        caption: "No phone? Use a recovery code instead. Each recovery code works once.",
        narration: "Without your phone, choose Use a recovery code instead. Type one of your unused recovery codes and choose Verify and continue. Each code works only once.",
        durationSeconds: 12,
        focus: "securityRecoverySignIn",
        calloutPlacement: "right-mid",
      },
      {
        title: "Trouble signing in?",
        caption: "SSO password: use your organization's recovery. Password account: ask for a temporary password.",
        narration: "Stuck? Choose Trouble signing in. For Organization S S O, use your organization's own password recovery. For an email and password account, ask your workspace administrator for a temporary password.",
        durationSeconds: 15,
        focus: "accessTrouble",
        calloutPlacement: "right-mid",
        captionPlacement: "top",
      },
    ],
  },
  {
    id: "chat-basics",
    audioSrc: "training/user/chat-basics.mp3",
    title: "Start chatting",
    description: "Send your first message, watch it work, stop a reply, edit and resend your prompt, and copy the answer.",
    icon: "chat",
    track: "Get started",
    outcomes: ["First message sent", "Reply stopped and resent", "Answer copied"],
    prerequisites: [
      "A signed-in account with at least one available model. If the composer says Connect a model provider to start chatting..., see Choose models and request access.",
    ],
    setupSteps: [
      "Choose New chat at the top of the sidebar.",
      "Check the model selector at the top right (Model: and a name). Choose another model there if you need one.",
      "Type your request where it says Ask anything..., or choose a starter such as Explore an idea. A starter only fills in the opening words.",
      "Press Enter, or choose the paper-plane Send message button, to send. Shift+Enter adds a new line instead.",
      "Watch Aperture Chat is working while the reply is prepared; the answer appears under it.",
      "Read the reply. The work trace above it reads complete, and the chat is listed under Recent with a title from your request.",
      "To keep the answer, choose Copy response text under the reply and wait for Copied.",
    ],
    paths: [
      {
        label: "Stop a reply",
        steps: [
          "While Aperture Chat is working, choose · stop at the top right of the trace.",
          "The reply stops and keeps any text already written, with You stopped this response before it finished.",
          "To ask again, use Edit and resend.",
        ],
      },
      {
        label: "Edit and resend",
        steps: [
          "Point at your message and choose Edit message (the pencil).",
          "Change the text. Escape cancels.",
          "Choose Send edited message. Everything after that message is removed, and the model answers the new text.",
        ],
      },
      {
        label: "Regenerate",
        steps: [
          "On a finished reply, choose Regenerate response (the circular arrows).",
          "The model answers the same request again.",
          "A stopped or failed reply has no actions; use Edit and resend instead.",
        ],
      },
      {
        label: "Reuse a prompt in a new chat",
        steps: [
          "Point at your message and choose Load prompt in new chat (the paper plane beside the pencil).",
          "A new chat opens with your prompt and its attachments in the message box, ready to send.",
        ],
      },
    ],
    verify: [
      "Your message and the model's reply both appear, and the trace above the reply reads complete.",
      "The chat is listed under Recent in the sidebar.",
      "Copied appears beside the reply's actions after you copy it.",
    ],
    troubleshooting: [
      { symptom: "The message box says \"Connect a model provider to start chatting...\"", fix: "No model is available to your account. Open the model selector or Why isn't a model listed?, and request access." },
      { symptom: "\"You stopped this response before it finished. Regenerate or resend the message to run it again.\"", fix: "A stopped reply has no Regenerate button. Choose Edit message on your prompt, then Send edited message." },
      { symptom: "A reply reads \"… did not return a completion: …\"", fix: "The model service failed. Resend with Edit message. If it repeats, tell your administrator. Some self-hosted models reject Regenerate with \"System message must be at the beginning.\"; resend instead." },
      { symptom: "The pencil says \"Wait for the current response to finish before editing\"", fix: "Wait for the reply, or choose · stop first." },
      { symptom: "\"The edited message could not be sent. Check the text and try again.\"", fix: "Make sure the edited text is not empty, then choose Send edited message again." },
      { symptom: "\"Copy unavailable\"", fix: "The browser blocked the clipboard. Select the reply text and copy it with the keyboard instead." },
    ],
    scenes: [
      {
        title: "Start a new chat",
        caption: "New chat opens an empty chat. A starter fills in the opening words; nothing is sent yet.",
        narration: "Choose New chat at the top of the sidebar. Type in the message box, or choose a starter such as Explore an idea. A starter only fills in the opening words, so you can finish the sentence. Nothing is sent until you send it.",
        durationSeconds: 15,
        focus: "chatStarter",
      },
      {
        title: "Check the model",
        caption: "The model selector shows which model will answer this chat.",
        narration: "Before you send, check the model selector at the top right. It shows the model that will answer this chat. Choose another one there if you need it.",
        durationSeconds: 10,
        focus: "modelSelector",
        calloutPlacement: "left-rail",
      },
      {
        title: "Type and send",
        caption: "Enter sends. Shift+Enter adds a line. The paper plane sends too.",
        narration: "Type your request. Press Enter to send it, or choose the paper plane. Shift and Enter adds a new line instead of sending.",
        durationSeconds: 9,
        focus: "chatTyped",
      },
      {
        title: "Watch it work",
        caption: "Aperture Chat is working, with a timer and · stop. The answer appears below it.",
        narration: "Your message moves to the top of the chat, and Aperture Chat is working appears with a timer. The answer streams in below it. To cancel, choose stop.",
        durationSeconds: 11,
        focus: "chatRunning",
      },
      {
        title: "Stop a reply",
        caption: "A stopped reply keeps its partial text. Resend by editing your message.",
        narration: "Stopping keeps whatever was already written, with a note that you stopped it. A stopped reply has no actions of its own, so to ask again, edit your message and resend it.",
        durationSeconds: 12,
        focus: "chatStopped",
      },
      {
        title: "Edit and resend",
        caption: "Edit message (the pencil), change the text, then Send edited message.",
        narration: "Point at your message and choose the pencil, Edit message. Change the text and choose Send edited message. Everything after that message is removed, and the model answers the new version.",
        durationSeconds: 13,
        focus: "chatEdit",
      },
      {
        title: "Read the reply",
        caption: "The reply arrives under Work trace, complete. The chat is listed under Recent.",
        narration: "The new reply arrives under the work trace, which now reads complete. The chat takes its title from your request and is listed under Recent in the sidebar.",
        durationSeconds: 11,
        focus: "chatEdited",
      },
      {
        title: "Copy and other actions",
        caption: "Copy, Branch, Regenerate, and feedback sit under every finished reply. Copied confirms the copy.",
        narration: "Under every finished reply are its actions: copy, branch into a new chat, regenerate, and thumbs up or down. Choose Copy response text, and Copied confirms the reply is on your clipboard, with its formatting where the destination supports it.",
        durationSeconds: 17,
        focus: "responseActions",
      },
    ],
  },
  {
    id: "model-access",
    audioSrc: "training/user/model-access.mp3",
    title: "Choose models and request access",
    description: "Pick the model for a chat, star your default, find out why a model is missing, and request, withdraw, and use a model your administrator approves.",
    icon: "chat",
    track: "Get started",
    outcomes: ["Model chosen for a chat", "Default model starred", "Access requested or withdrawn", "Approved model used in a real reply"],
    prerequisites: [
      "A signed-in account with at least one model available. If the selector reads No models available, start at Why isn't a model listed?.",
      "Your organization must allow access requests. If it shows only models you can already use, ask your administrator about others.",
      "An administrator to review requests. Approval happens in their Admin console › Model Access.",
    ],
    setupSteps: [
      "In a chat, open the model selector (Model: and the model's name) at the top right.",
      "Choose a model to use it in this chat. Each chat keeps its own model.",
      "Choose the star beside a model to make it your default for new chats in this browser.",
      "Choose Why isn't a model listed? at the bottom of the selector. Models in your organization lists Usable now and Not available to you, with the server's reason for each.",
      "Beside a Locked model, choose Request access. The row changes to Request pending since and the date.",
      "Wait for your administrator to approve. Approval adds you to a group that carries the model and signs you out of your current sessions.",
      "Sign in again. The model is listed under Usable now and in the selector. Choose it and send a message.",
    ],
    paths: [
      {
        label: "Withdraw a request",
        steps: [
          "Open the model selector › Why isn't a model listed?.",
          "Beside the pending model, choose Withdraw request.",
          "Withdrew the request for the model appears, and Request access is offered again.",
        ],
      },
      {
        label: "Provider offline",
        steps: [
          "A Provider offline badge means the connection behind the model is not working.",
          "Requesting access does not fix a disconnected provider; the platform owner must reconnect it.",
          "Choose Refresh model access later, or use another model in the meantime.",
        ],
      },
      {
        label: "After approval",
        steps: [
          "If the dialog or a chat says Session is invalid or expired. Sign in again., sign in again.",
          "Open the selector: the new model is listed. Choose it for this chat, or star it to make it your default.",
          "Send a message; the reply comes from the newly granted model.",
        ],
      },
    ],
    verify: [
      "The selector shows Model: and your chosen model's name, and the reply comes from that model.",
      "The starred model is filled in, and new chats start with it.",
      "After approval and a fresh sign-in, the model is listed under Usable now with Available.",
    ],
    troubleshooting: [
      { symptom: "\"Not granted to any of your groups. An administrator can add you to a group that has this model.\"", fix: "Choose Request access, or ask your administrator to add you to a group that has the model." },
      { symptom: "\"The provider behind this model is not connected right now.\" (Provider offline)", fix: "A request cannot fix this. The platform owner must reconnect the provider. Use another model meanwhile." },
      { symptom: "\"Disabled by the platform owner for the whole organization.\"", fix: "The model is switched off for everyone. Ask your administrator whether it will be enabled." },
      { symptom: "\"Session is invalid or expired. Sign in again.\" right after a request", fix: "Your administrator approved the request, which signs you out. Sign in again; the model is then listed." },
      { symptom: "\"Model access requests are disabled by organization policy.\"", fix: "Your organization does not take requests here. Contact your administrator directly." },
      { symptom: "\"Too many access requests. Try again shortly.\"", fix: "Wait a minute. A pending request stays pending; you do not need to resend it." },
      { symptom: "The selector reads No models available", fix: "No model is usable for your account yet. Choose it to open Models in your organization, request access, or contact your administrator." },
    ],
    scenes: [
      {
        title: "Open the model selector",
        caption: "Model: at the top right opens the selector. Choose a model to use it in this chat.",
        narration: "Every chat is answered by one model. Open the model selector at the top right of the chat. Each row is a model you can use now, with the service that runs it. Choose a row to use that model in this chat. Each chat keeps its own choice.",
        durationSeconds: 16,
        focus: "modelMenu",
        calloutPlacement: "left-rail",
      },
      {
        title: "Star your default",
        caption: "The star sets your default model for new chats in this browser.",
        narration: "Choose the star beside a model to make it your default. It fills in, the model is selected, and new chats in this browser start with it. A star is a preference; it does not grant access to anything.",
        durationSeconds: 14,
        focus: "modelFavorites",
        calloutPlacement: "left-rail",
      },
      {
        title: "Why isn't a model listed?",
        caption: "Models in your organization shows Usable now, and every other model with the server's reason.",
        narration: "To see why a model is missing, choose Why isn't a model listed? at the bottom of the selector. Models in your organization lists what you can use now, and every other model with the server's reason. Locked means your groups do not include it. Provider offline means the connection behind it is down, and a request cannot fix that.",
        durationSeconds: 22,
        focus: "modelAccessOverview",
        calloutPlacement: "left-rail",
      },
      {
        title: "Request access",
        caption: "Request access on a Locked model sends it to your administrator. The row shows Request pending.",
        narration: "Beside a Locked model, choose Request access. Your administrator receives the request, and the row shows Request pending, with the date. A request does not unlock the model by itself.",
        durationSeconds: 13,
        focus: "modelAccessPending",
        calloutPlacement: "left-rail",
      },
      {
        title: "Withdraw a request",
        caption: "Withdraw request cancels it. You can ask again at any time.",
        narration: "Changed your mind? Choose Withdraw request. The dialog confirms it, and Request access is offered again. Here, the request is sent once more, so the administrator can review it.",
        durationSeconds: 13,
        focus: "modelAccessWithdrawn",
        calloutPlacement: "left-rail",
      },
      {
        title: "Your administrator approves",
        caption: "Approval adds you to a group that carries the model, and signs you out of current sessions.",
        narration: "Your administrator reviews the request in the Admin console and approves it through a group that carries the model. Approval changes your groups, so your current sessions end. The next time the workspace checks, it says: Session is invalid or expired. Sign in again.",
        durationSeconds: 18,
        focus: "modelAccessExpired",
        calloutPlacement: "left-rail",
      },
      {
        title: "Usable now",
        caption: "After you sign in again, the approved model is listed under Usable now.",
        narration: "Sign in again and open Why isn't a model listed? once more. The approved model now sits under Usable now, marked Available.",
        durationSeconds: 10,
        focus: "modelAccessApproved",
        calloutPlacement: "left-rail",
      },
      {
        title: "Use the approved model",
        caption: "Choose it in the selector and send a message. The reply comes from the new model.",
        narration: "Close the dialog, choose the new model in the selector, and send a message. The header shows the model in use, and the reply comes from it. Star it if you want it as your default.",
        durationSeconds: 12,
        focus: "modelReply",
      },
    ],
  },
  {
    id: "account-security",
    audioSrc: "training/user/account-security.mp3",
    title: "Protect your account and recover access",
    description: "Turn on two-step verification, sign in with a code or a recovery code, replace recovery codes, and change your password.",
    icon: "session",
    track: "Get started",
    outcomes: ["Authenticator connected", "Recovery codes stored", "Recovery code used at sign-in", "Password changed"],
    prerequisites: [
      "An email-and-password account. With Organization SSO, your identity provider manages your password and multifactor settings, and the panel says so.",
      "An authenticator app on your phone, such as Microsoft Authenticator, Google Authenticator, or a password manager with one-time codes.",
      "A safe place for recovery codes, such as a password manager.",
      "Your current password. If you still have a temporary password, replace it first.",
    ],
    setupSteps: [
      "Select your account card at the bottom of the sidebar. In the Security card, choose Manage security.",
      "Under Two-step verification (Off), choose Set up authenticator.",
      "Enter your Current password and choose Continue setup.",
      "In your authenticator app, scan the QR code, or type the Setup key shown under it.",
      "Tick I added this account to my authenticator., type the 6-digit code from the app into Authenticator code, and choose Verify authenticator.",
      "Choose Copy recovery codes and store them somewhere safe. Tick I stored these recovery codes somewhere safe., then choose Done.",
      "Check that Two-step verification shows On and Your authenticator is connected. 10 recovery codes remain.",
    ],
    paths: [
      {
        label: "Sign in with a code",
        steps: [
          "Sign in with your email and password as usual.",
          "On Two-step verification, type the current 6-digit code from your authenticator app.",
          "Choose Verify and continue.",
        ],
      },
      {
        label: "Sign in with a recovery code",
        steps: [
          "On Two-step verification, choose Use a recovery code instead.",
          "Type one unused recovery code into Recovery code and choose Verify and continue.",
          "Open Account › Manage security: the count of recovery codes remaining has gone down by one.",
          "When few codes remain, replace them.",
        ],
      },
      {
        label: "Replace recovery codes",
        steps: [
          "Account › Manage security › Replace recovery codes.",
          "Enter a current Authenticator code (or choose Use a recovery code instead).",
          "Choose Create new recovery codes. The old set stops working at once.",
          "Copy and store the new codes, tick I stored these recovery codes somewhere safe., and choose Done.",
        ],
      },
      {
        label: "Change your password",
        steps: [
          "Account › Password card › Edit.",
          "Enter Current password, then a New password of at least 12 characters, and the same in Confirm new password.",
          "Choose Update password and wait for Password updated.",
          "You stay signed in here; your older sessions on other devices are signed out.",
        ],
      },
      {
        label: "Lost or replaced phone",
        steps: [
          "Sign in with your password and one recovery code (Use a recovery code instead).",
          "If your organization allows it, choose Turn off verification, confirm with another recovery code, sign back in, and set up the new phone.",
          "If verification is required by your organization, or you have no recovery codes left, ask your administrator to reset two-step verification for your account.",
          "After the reset, sign in and set up your authenticator again.",
        ],
      },
    ],
    verify: [
      "Two-step verification shows On, with Your authenticator is connected. and the number of recovery codes that remain.",
      "Your next password sign-in asks for an Authenticator code.",
      "After signing in with a recovery code, the remaining count is one lower.",
      "After a password change, the Password card shows Password updated.",
    ],
    troubleshooting: [
      { symptom: "\"Current password is incorrect.\"", fix: "Retype your current password. If you have forgotten it, ask your administrator for a temporary password." },
      { symptom: "\"The MFA code is invalid.\"", fix: "Wait for the next code and type it promptly. Codes depend on the time, so set your phone's clock to update automatically. A code that was already used is refused." },
      { symptom: "\"Change the temporary password before enrolling MFA.\"", fix: "Sign in and choose your own password first, then set up the authenticator." },
      { symptom: "\"Finish verification or save your recovery codes before leaving this panel.\"", fix: "Complete Verify authenticator, or copy and store the recovery codes and choose Done, before closing the panel." },
      { symptom: "\"Required by your organization. You cannot turn this off.\"", fix: "Your organization requires two-step verification, so Turn off verification is not offered. To move to a new phone, ask your administrator to reset it." },
      { symptom: "\"Your organization manages sign-in. Use your identity provider's security settings…\"", fix: "You sign in with Organization SSO. Change your password and multifactor settings at your identity provider." },
      { symptom: "\"Use a password with at least 12 characters.\" or \"The new passwords do not match.\"", fix: "Use 12 or more characters and type the same new password in both fields." },
      { symptom: "\"Password changes are only available for local password accounts.\"", fix: "Your account signs in with Organization SSO. Change the password at your identity provider." },
    ],
    scenes: [
      {
        title: "Open Manage security",
        caption: "Account card › Security › Manage security shows Two-step verification and whether it is on.",
        narration: "Select your account card at the bottom of the sidebar. In the Security card, choose Manage security. Two-step verification shows whether an authenticator protects your account. Here it is off.",
        durationSeconds: 13,
        focus: "securityOverview",
        calloutPlacement: "left-rail",
      },
      {
        title: "Confirm your password",
        caption: "Set up authenticator asks for your Current password, then Continue setup.",
        narration: "Choose Set up authenticator. Enter your current password to confirm it is you, and choose Continue setup.",
        durationSeconds: 8,
        focus: "securityStart",
        calloutPlacement: "left-rail",
      },
      {
        title: "Add the account to your authenticator",
        caption: "Scan the QR code or enter the setup key, tick the box, and verify a 6-digit code.",
        narration: "Open your authenticator app and scan the Q R code, or type the setup key shown under it. These are hidden in this video, and you should keep them out of screenshots too. Tick I added this account to my authenticator, type the current six digit code, and choose Verify authenticator.",
        durationSeconds: 19,
        focus: "securityVerify",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "Store your recovery codes",
        caption: "Copy recovery codes, store them safely, tick the box, and choose Done. They are shown only once.",
        narration: "Next come your recovery codes. They are shown only once, and each one lets you sign in without your phone, one time. Choose Copy recovery codes, paste them into a password manager or another safe place, tick I stored these recovery codes somewhere safe, and choose Done.",
        durationSeconds: 18,
        focus: "securityRecovery",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "Two-step verification is on",
        caption: "On, with Your authenticator is connected and 10 recovery codes remaining.",
        narration: "Two-step verification now shows On. Your authenticator is connected, and ten recovery codes remain. From now on, every password sign-in also asks for a code.",
        durationSeconds: 13,
        focus: "securityEnabled",
        calloutPlacement: "left-rail",
      },
      {
        title: "Sign in with a code",
        caption: "After your password, type the current code from the app and choose Verify and continue.",
        narration: "The next time you sign in, Two-step verification follows your password. Type the current code from your authenticator app and choose Verify and continue.",
        durationSeconds: 11,
        focus: "securitySignIn",
        calloutPlacement: "right-mid",
      },
      {
        title: "No phone? Use a recovery code",
        caption: "Use a recovery code instead, enter one unused code, and continue.",
        narration: "If your phone is not with you, choose Use a recovery code instead, type one unused recovery code, and choose Verify and continue.",
        durationSeconds: 10,
        focus: "securityRecoverySignIn",
        calloutPlacement: "right-mid",
      },
      {
        title: "Each code works once",
        caption: "Back in Manage security, 9 recovery codes remain: the code you used is spent.",
        narration: "Back in Manage security, nine recovery codes remain. The code you just used is spent. When only a few are left, replace them.",
        durationSeconds: 10,
        focus: "securityCodesRemaining",
        calloutPlacement: "left-rail",
      },
      {
        title: "Replace your recovery codes",
        caption: "Replace recovery codes: prove it with a current code, then store the new set. The old set stops working.",
        narration: "Choose Replace recovery codes. Enter a current authenticator code, or choose Use a recovery code instead, and choose Create new recovery codes. The old set stops working at once, so store the new codes the same way, and choose Done.",
        durationSeconds: 17,
        focus: "securityReplace",
        calloutPlacement: "left-rail",
      },
      {
        title: "If you lose your phone",
        caption: "Sign in with a recovery code, then turn verification off and on again, or ask your administrator.",
        narration: "If you lose or replace your phone, sign in with a recovery code. Where your organization allows it, choose Turn off verification, confirm with another code, sign back in, and set up the new phone. If verification is required, or you have no codes left, ask your administrator to reset two-step verification for your account.",
        durationSeconds: 22,
        card: {
          label: "Recovery plan",
          where: "Lost or replaced phone",
          steps: [
            "Sign in with your password and one recovery code.",
            "If offered, choose Turn off verification and confirm with another code. You are signed out.",
            "Sign back in and choose Set up authenticator on the new phone.",
            "Verification required, or no codes left? Ask your administrator to reset two-step verification.",
          ],
        },
      },
      {
        title: "Change your password",
        caption: "Password › Edit: current password, a new password of 12+ characters, and the confirmation.",
        narration: "To change your password, choose Edit in the Password card. Enter your current password, a new password of at least twelve characters, and the same new password again. Choose Update password.",
        durationSeconds: 14,
        focus: "securityPassword",
        calloutPlacement: "left-rail",
      },
      {
        title: "Password updated",
        caption: "Password updated confirms the change. You stay signed in; older sessions are signed out.",
        narration: "Password updated confirms the change. You stay signed in here, and your older sessions on other devices are signed out. If you sign in with Organization S S O, change your password at your identity provider instead.",
        durationSeconds: 16,
        focus: "securityPasswordUpdated",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "composer-commands",
    audioSrc: "training/user/composer-commands.mp3",
    title: "Symbol shortcuts: / @ # $ >",
    description: "Type a symbol in the message box to add a saved prompt, an agent, knowledge, a skill file, or an automation, then send.",
    icon: "commands",
    track: "Chat",
    outcomes: ["All five symbols used", "Prompt, agent, knowledge, skill file, and automation added", "Cited reply from # and $"],
    prerequisites: [
      "A chat with an available model.",
      "Items to choose from: saved prompts and skill files are shared by your administrators; agents, knowledge bases, and automations are ones you can use or have built.",
    ],
    setupSteps: [
      "Click in the message box. At the start of a word, type one of the five symbols: / @ # $ or >.",
      "A list opens above the message box. Keep typing to narrow it.",
      "Use the up and down arrow keys to move, and Enter (or a click) to choose. Escape closes the list.",
      "Check what was added: prompt text in the box, or a chip under it (Agent, Knowledge, a skill file, or an automation).",
      "Finish your message and send it.",
    ],
    paths: [
      {
        label: "/ Prompts and MCP connections",
        steps: [
          "Type / to list saved prompts and enabled MCP connections.",
          "Choose a prompt to put its text in the message box; edit it before sending.",
          "Choose a connection to turn it on for this message.",
        ],
      },
      {
        label: "@ Agents",
        steps: [
          "Type @ to list the agent profiles you can use.",
          "Choose one. @ and its name are added, and the Agent chip appears.",
          "The reply runs through that agent's model, instructions, knowledge, and tools.",
        ],
      },
      {
        label: "# Knowledge",
        steps: [
          "Type # to list knowledge bases and the files in them.",
          "Choose a knowledge base, or a single file to search its source.",
          "The Knowledge chip appears; the reply searches it and cites what it uses.",
        ],
      },
      {
        label: "$ Skill files",
        steps: [
          "Type $ to list saved skill files, such as citation rules or an approval checklist.",
          "Choose one. It is attached to the message as a file chip (Name.md).",
          "The model follows it for this message.",
        ],
      },
      {
        label: "> Automations",
        steps: [
          "Type > to list your automations, including paused ones.",
          "Choose one. It is queued in the chip under the message box.",
          "When you send, the automation runs on your message. × removes it before sending.",
        ],
      },
    ],
    verify: [
      "After choosing, the message box holds the prompt text or shows the matching chip.",
      "A message sent with # and $ returns a reply that lists its sources and View N citations →.",
      "Session details › Symbol shortcuts lists all five symbols at any time.",
    ],
    troubleshooting: [
      { symptom: "\"No matching commands. Try another name.\"", fix: "Nothing matches what you typed after the symbol. Delete some letters, or check the item's name." },
      { symptom: "\"No saved prompts or enabled MCP connections yet — add them under Tools\"", fix: "Nothing is shared with you yet. Your administrator adds prompts and connections." },
      { symptom: "\"No agent profiles available yet — create one under Agents\"", fix: "Build an agent (if your account can) or ask your administrator to share one." },
      { symptom: "\"No knowledge bases are enabled yet — add one under Knowledge\"", fix: "Ask your administrator to share a knowledge base, or create one if your account can." },
      { symptom: "\"Some files could not be loaded. Retry\"", fix: "Choose Retry in the list. Sources that already loaded stay usable." },
      { symptom: "The list does not open", fix: "The symbol must start a word: type a space first if it follows other text." },
    ],
    scenes: [
      {
        title: "Slash: saved prompts",
        caption: "/ lists saved prompts and MCP connections. Arrow keys move, Enter chooses, Escape closes.",
        narration: "Five symbols add resources straight from the message box. Start a word with a slash to list your saved prompts and enabled MCP connections. Keep typing to narrow the list, use the arrow keys to move, Enter to choose, and Escape to close.",
        durationSeconds: 17,
        focus: "slashMenu",
      },
      {
        title: "The prompt fills the box",
        caption: "A saved prompt puts its text in the message box. Edit it, then send.",
        narration: "Choosing a prompt, here Matter Summary, puts its text in the message box. Add your details and edit it before you send.",
        durationSeconds: 9,
        focus: "symbolSlashInserted",
      },
      {
        title: "At sign: agents",
        caption: "@ lists the agent profiles you can use.",
        narration: "Type the at sign to list the agent profiles you can use.",
        durationSeconds: 5,
        focus: "agentMenu",
      },
      {
        title: "The agent is selected",
        caption: "@ and the agent's name are added, and the Agent chip turns on.",
        narration: "Choose one. Its name is added after the at sign, and the Agent chip turns on, so the reply runs through that agent.",
        durationSeconds: 9,
        focus: "symbolAtInserted",
      },
      {
        title: "Hash: knowledge",
        caption: "# lists knowledge bases and the files inside them.",
        narration: "Type a hash to list knowledge bases, and the files inside them. Choosing a single file searches the source that holds it.",
        durationSeconds: 9,
        focus: "hashMenu",
      },
      {
        title: "Knowledge is on",
        caption: "#Litigation Playbook is added and the Knowledge chip turns on.",
        narration: "Choose Litigation Playbook. Its name is added, and the Knowledge chip shows that this message will search it.",
        durationSeconds: 8,
        focus: "symbolHashInserted",
      },
      {
        title: "Dollar sign: skill files",
        caption: "$ lists saved skill files: rules the model follows for this message.",
        narration: "Type a dollar sign to list saved skill files. These are written rules, such as how to cite sources or route an approval.",
        durationSeconds: 9,
        focus: "skillMenu",
      },
      {
        title: "The skill file is attached",
        caption: "The skill file is attached as a chip above the message.",
        narration: "Choose Citation Discipline. It is attached as a file above your message, and the model follows it for this message.",
        durationSeconds: 9,
        focus: "symbolDollarInserted",
      },
      {
        title: "Greater-than: automations",
        caption: "> lists your automations, paused ones too.",
        narration: "Type a greater-than sign to list your automations. Paused ones are included, because this runs one on demand.",
        durationSeconds: 9,
        focus: "automationMenu",
      },
      {
        title: "The automation is queued",
        caption: "The automation waits in the chip and runs on your message when you send. × removes it.",
        narration: "Choose one, and it waits in the chip under the message box. When you send, it runs on your message. Choose the X on the chip to remove it instead.",
        durationSeconds: 11,
        focus: "symbolGtQueued",
      },
      {
        title: "Put them together",
        caption: "A question with # and $ returns a reply that follows the skill and cites the playbook.",
        narration: "Symbols combine. This message searches the litigation playbook with a hash and follows the citation skill file added with a dollar sign. The reply lists its source and offers View two citations.",
        durationSeconds: 14,
        focus: "symbolReply",
      },
    ],
  },
  {
    id: "send-options",
    audioSrc: "training/user/send-options.mp3",
    title: "Knowledge, Web, Agent, and reply settings",
    description: "Ground a reply in a knowledge base and check its citations, and choose Web, an agent, reasoning, streaming, and resources for a message.",
    icon: "send",
    track: "Chat",
    outcomes: ["Reply grounded in a knowledge base", "Citations opened", "Web, Agent, reasoning, and streaming understood", "Resource added from the browser"],
    prerequisites: [
      "A chat with an available model.",
      "For Knowledge: at least one knowledge base shared with you (see Knowledge bases).",
      "For Web: your workspace must connect web search to the model you use. Otherwise Web is greyed out.",
      "For Agent: an agent profile you can use (see Agent profiles).",
    ],
    setupSteps: [
      "In the message box, choose Send options (the arrow beside the paper plane). Send options opens on Reply settings.",
      "Choose Knowledge, then choose the source to search, such as Litigation Playbook. Each source shows how many files it holds.",
      "Choose Close send options. The Knowledge chip under the message box shows it is on.",
      "Type your question and send it.",
      "Check the reply: the work trace lists one more step, and View 2 citations → appears under the answer.",
      "Choose View citations to open Session details › Sources gathered, with each source's K number, file name, and the passage used.",
    ],
    paths: [
      {
        label: "Web",
        steps: [
          "Send options › Web. When it is available, the chip under the message box reads Web search.",
          "Send your message. Aperture Chat searches public web sources and gives the results, with their addresses, to the model so the reply can cite them.",
          "If Web is greyed out, your workspace has not connected web search to this model. Ask your administrator.",
        ],
      },
      {
        label: "Agent",
        steps: [
          "Send options › Agent. An Agent profile list appears under it.",
          "Choose the profile you want; the line under it counts its knowledge, files, and tools.",
          "Send your message. The trace reads Agent work trace. See Agent profiles to build your own.",
        ],
      },
      {
        label: "Reasoning and streaming",
        steps: [
          "Under Reasoning, drag the slider toward Fast for quicker answers or Smart for deeper thinking, on models that support it.",
          "Clear Stream replies to show each reply only when it is complete; leave it ticked to watch the answer arrive.",
        ],
      },
      {
        label: "Resources",
        steps: [
          "Send options › Resources (or MCP connections and resources).",
          "Search by name, or filter by Knowledge bases, Files in knowledge sources, MCP connections, Prompts, Agents, Skill files, or Automations.",
          "Choose an item. A prompt's text fills the message box; other items turn on for this message.",
        ],
      },
      {
        label: "Turn everything off",
        steps: [
          "Choose × on the chip under the message box.",
          "Knowledge, Web, and Agent turn off, selected MCP connections clear, and queued automations are removed.",
        ],
      },
    ],
    verify: [
      "The chip under the message box names what is on (Knowledge, Web search, Agent, or Tools with a count).",
      "A knowledge reply shows View N citations →, and Sources gathered lists the files and passages.",
      "The reply's trace includes a step for each option you turned on.",
    ],
    troubleshooting: [
      { symptom: "Web is greyed out: \"Web search is turned off for this model by your workspace configuration\"", fix: "Your workspace has not connected web search to this model. Choose another model, or ask your administrator." },
      { symptom: "With Web on, the reply stays on Aperture Chat is working", fix: "Some self-hosted models currently reject web-search requests. Choose · stop, turn Web off, and resend; tell your administrator." },
      { symptom: "\"Web search (…) is unavailable: … Turn off Web for this reply to continue without it.\"", fix: "The search service could not be reached. Turn Web off for this message, or try again later." },
      { symptom: "Knowledge cannot be chosen", fix: "No knowledge base is shared with you. Ask your administrator, or create one if your account can (see Knowledge bases)." },
      { symptom: "\"Create an agent profile in Agents to enable this mode.\"", fix: "No agent profile is available to you. Build one under Agents, or ask your administrator to share one." },
      { symptom: "\"… does not support reasoning levels\"", fix: "The selected model has no reasoning control. The slider has no effect for it." },
    ],
    scenes: [
      {
        title: "Open Send options",
        caption: "The arrow beside Send opens Send options: Knowledge, Web, Agent, Reasoning, and Stream replies.",
        narration: "Next to the paper plane, choose the small arrow to open Send options. Reply settings lists what this message can use: Knowledge, Web, and Agent, then the reasoning slider and Stream replies.",
        durationSeconds: 14,
        focus: "sendOptionsMenu",
        calloutPlacement: "left-rail",
      },
      {
        title: "Choose a knowledge base",
        caption: "Knowledge, then a source. Each source shows how many files it holds.",
        narration: "Choose Knowledge, then the source to search. Here, Litigation Playbook, with two files. The reply will search only that source and cite what it uses.",
        durationSeconds: 11,
        focus: "sendKnowledge",
        calloutPlacement: "left-rail",
      },
      {
        title: "The chip shows what is on",
        caption: "Close Send options. The Knowledge chip confirms the setting for this message.",
        narration: "Close Send options. Under the message box, the Knowledge chip confirms what this message will use. Type your question and send it.",
        durationSeconds: 10,
        focus: "toolsChip",
      },
      {
        title: "A grounded, cited reply",
        caption: "The reply draws on the playbook. View 2 citations opens the sources.",
        narration: "The reply answers from the playbook, and its trace now has five steps, including the knowledge search. Under the answer, View two citations shows that two sources were used.",
        durationSeconds: 12,
        focus: "sendKnowledgeReply",
      },
      {
        title: "Check the sources",
        caption: "Sources gathered lists each source with its K number and the passage used.",
        narration: "Choose View citations. Session details opens at Sources gathered: each file with its K number and the passage the reply relied on. Check them before you rely on the answer.",
        durationSeconds: 13,
        focus: "sessionSources",
        calloutPlacement: "left-rail",
      },
      {
        title: "Web, when it is connected",
        caption: "Web is greyed out until your workspace connects web search to the model.",
        narration: "Web searches public web sources for a single reply. Here it is greyed out, because this workspace has not connected web search to this model. Ask your administrator if you need it.",
        durationSeconds: 13,
        focus: "sendWeb",
        calloutPlacement: "left-rail",
      },
      {
        title: "Web turned on",
        caption: "Once connected, Web turns on and the chip reads Web search.",
        narration: "Once web search is connected to the model, choose Web, and the chip reads Web search. Aperture Chat then searches the web for your message and gives the model the results with their addresses, so the reply can cite them.",
        durationSeconds: 15,
        focus: "sendWebOn",
        calloutPlacement: "left-rail",
      },
      {
        title: "Use an agent",
        caption: "Agent shows the Agent profile list and counts the profile's knowledge, files, and tools.",
        narration: "Choose Agent to answer through an agent profile. Pick the profile from the list. The line under it counts its knowledge, files, and tools. Check the profile before you send, because turning Agent on can select the first one.",
        durationSeconds: 16,
        focus: "sendAgent",
        calloutPlacement: "left-rail",
      },
      {
        title: "Reasoning",
        caption: "Drag toward Fast for quick answers or Smart for deeper thinking, on models that support it.",
        narration: "The Reasoning slider trades speed for depth. Drag it toward Fast for quick answers, or toward Smart for more careful thinking. It applies only to models that support reasoning levels.",
        durationSeconds: 13,
        focus: "sendReasoning",
        calloutPlacement: "left-rail",
      },
      {
        title: "Stream replies",
        caption: "Ticked: watch the answer arrive. Cleared: see it only when it is complete.",
        narration: "Stream replies decides how answers appear. Leave it ticked to watch the answer arrive as it is written. Clear it to see each reply only when it is complete.",
        durationSeconds: 11,
        focus: "sendStreaming",
        calloutPlacement: "left-rail",
      },
      {
        title: "Browse Resources",
        caption: "Resources searches prompts, connections, agents, knowledge, skills, and automations by name.",
        narration: "The Resources tab lists everything you can add to a message: prompts, MCP connections, agents, knowledge bases and their files, skill files, and automations. Search by name or filter by type. The symbol guide underneath shows the shortcut for each.",
        durationSeconds: 18,
        focus: "composerShortcuts",
        calloutPlacement: "left-rail",
      },
      {
        title: "Add a resource",
        caption: "Choosing a saved prompt fills the message box. Review it, then send.",
        narration: "Choose a resource to add it. A saved prompt, such as Matter Summary, fills the message box with its text. Review it and add your details before you send.",
        durationSeconds: 12,
        focus: "sendResourceInserted",
      },
    ],
  },
  {
    id: "attachments",
    audioSrc: "training/user/attachments.mp3",
    title: "Attach files and sources",
    description: "Attach a file from your computer, a web page by link, or a file from a connected cloud source, and know what the model actually receives.",
    icon: "attach",
    track: "Chat",
    outcomes: ["File uploaded and used in a reply", "Web page attached and cited", "Cloud sources understood"],
    prerequisites: [
      "A chat with an available model.",
      "For cloud sources (Google Drive, OneDrive, SharePoint, Box, iManage): your administrator must set up the connector, and you sign in to your own account the first time.",
      "Files up to 25 MB each. Web pages must be public addresses starting with http:// or https://.",
    ],
    setupSteps: [
      "In the message box, choose Add attachment (the paperclip).",
      "Choose Upload from computer and pick one or more files.",
      "Wait for the file chip to finish uploading. Remove a file with the × on its chip.",
      "Type your question about the file and send it.",
      "Check the reply: it uses the file's content, and the trace includes a step for reading attachments.",
    ],
    paths: [
      {
        label: "Web page by link",
        steps: [
          "Paperclip › Web page by link.",
          "Type or paste the full address into Web page address, such as https://example.com, and choose Add link (or press Enter).",
          "The link appears as a chip. Add up to 3 links per message.",
          "Send your question. The page is fetched when you send and cited in the reply (View 1 citation →).",
        ],
      },
      {
        label: "Cloud sources",
        steps: [
          "Paperclip › choose a source under Attach from source: Google Drive, OneDrive, SharePoint, Box, or iManage.",
          "The first time, choose Connect and approve read access in the sign-in window. Only you see files from your account.",
          "Tick up to 10 files and choose Attach selected.",
          "If the dialog says the source is not ready, your administrator must finish setting up that connector.",
        ],
      },
      {
        label: "What the model receives",
        steps: [
          "Word (.docx) and text files (.txt, .md, .csv, .json, .xml, .html, .rtf, .eml, .log): the opening text, up to about 2,400 characters.",
          "Images: the picture itself, if the selected model can read images; otherwise the model says it cannot see them.",
          "Audio and video: a transcript, when your workspace has a transcription model. Media longer than 45 minutes is refused.",
          "PDF, Excel, and PowerPoint files from your computer: currently only the file name. To ask about their content, add them to a knowledge base, attach them from a cloud source, or open Word files in Drafts.",
        ],
      },
    ],
    verify: [
      "The file chip finishes uploading without Upload failed.",
      "The reply states facts that appear only in your file or page.",
      "A web-page reply offers View 1 citation → for the attached page.",
    ],
    troubleshooting: [
      { symptom: "\"Attachment exceeds the 25 MB chat upload limit.\"", fix: "Split or compress the file, or add it to a knowledge base, which accepts larger files." },
      { symptom: "\"Could not upload the attachment. Check your connection and try again.\"", fix: "Check your connection, remove the failed chip, and attach the file again." },
      { symptom: "The reply says it cannot see the content of a PDF, spreadsheet, or slide file", fix: "Files of those types uploaded from your computer currently reach the model by name only. Use a knowledge base or a cloud source instead." },
      { symptom: "\"Enter a full web address starting with http:// or https://.\"", fix: "Paste the complete address, including https://." },
      { symptom: "\"You can attach up to 3 web links per message.\"", fix: "Send the first three, then attach the rest in a follow-up message." },
      { symptom: "\"Web source fetch failed for …\"", fix: "The page could not be fetched (it may need a sign-in or be offline). Copy the text into your message instead." },
      { symptom: "\"Google Drive is not ready.\" (or another source)", fix: "Your administrator has not finished that connector. Ask them, or upload the file from your computer." },
      { symptom: "\"Media longer than 45 minutes cannot be transcribed in this version.\"", fix: "Split the recording and upload the part you need." },
    ],
    scenes: [
      {
        title: "Open the paperclip",
        caption: "Add attachment offers Upload from computer, Web page by link, and cloud sources.",
        narration: "In the message box, choose the paperclip, Add attachment. You can upload files from your computer, attach a web page by link, or pick files from a cloud source your workspace connects.",
        durationSeconds: 13,
        focus: "attachMenu",
      },
      {
        title: "Upload from your computer",
        caption: "Pick a file. Its chip shows above your message when the upload finishes.",
        narration: "Choose Upload from computer and pick a file. Here, a synthetic vendor checklist. When the upload finishes, the file sits in a chip above your message. Type your question about it.",
        durationSeconds: 13,
        focus: "attachFileReady",
      },
      {
        title: "The reply uses your file",
        caption: "The reply answers from the file: the renewal date and the security contact.",
        narration: "Send it. The reply answers from the file itself: the renewal date and the security contact, which appear nowhere else. The file stays attached to your message in the chat.",
        durationSeconds: 12,
        focus: "attachFileReply",
      },
      {
        title: "What the model reads",
        caption: "Word and text: opening text. Images: if the model can see them. PDF, Excel, PowerPoint: name only, for now.",
        narration: "Know what the model receives. Word and text files: their opening text, about two thousand four hundred characters. Images: the picture, if the model can read images. Audio and video: a transcript, when your workspace has a transcription model. P D F, Excel, and PowerPoint files from your computer currently reach the model by name only, so use a knowledge base for those.",
        durationSeconds: 25,
        focus: "attachUpload",
        calloutPlacement: "right-mid",
      },
      {
        title: "Attach a web page by link",
        caption: "Web page by link: paste a full address and choose Add link. Up to 3 per message.",
        narration: "To use a public web page, choose Web page by link. Paste the full address, starting with h t t p s, and choose Add link. You can attach up to three links to one message.",
        durationSeconds: 13,
        focus: "attachLinkField",
      },
      {
        title: "The link waits as a chip",
        caption: "The page is fetched when you send, as a cited source.",
        narration: "The link waits as a chip under the message box. The page is fetched when you send, and used as a cited source.",
        durationSeconds: 9,
        focus: "attachLinkChip",
      },
      {
        title: "A reply that cites the page",
        caption: "The reply summarizes the page and offers View 1 citation.",
        narration: "The reply describes the page, and View one citation links back to it.",
        durationSeconds: 6,
        focus: "attachLinkReply",
      },
      {
        title: "Cloud sources",
        caption: "A cloud source opens a picker. If it is not ready, your administrator must finish its setup.",
        narration: "Cloud sources, such as Google Drive, open a picker of your own files. The first time, choose Connect and approve read access. Here, Google Drive is not ready, because the workspace has not finished setting it up, so this picker cannot connect. Ask your administrator, or upload the file instead.",
        durationSeconds: 20,
        focus: "attachConnector",
      },
      {
        title: "Connect your own account",
        caption: "Once a source is ready: Connect, approve read access, tick files, Attach selected.",
        narration: "When a source is ready, the steps are the same for each provider. Choose Connect, sign in to your own account in the window that opens, and approve read access. Then tick up to ten files and choose Attach selected. Only you can see files from your account.",
        durationSeconds: 17,
        card: {
          label: "In the sign-in window",
          where: "Google Drive, OneDrive, SharePoint, Box, or iManage",
          steps: [
            "Choose Connect in the picker.",
            "Sign in with your work account in the window that opens.",
            "Review the requested access (read files) and approve it.",
            "Back in the picker, tick up to 10 files.",
            "Choose Attach selected, then send your question.",
          ],
        },
      },
    ],
  },
  {
    id: "dictation-images",
    audioSrc: "training/user/dictation-images.mp3",
    title: "Dictation, images, and diagrams",
    description: "Dictate a message when your workspace has a transcription model, ask an image model for pictures, and copy, view, and download diagrams.",
    icon: "dictation",
    track: "Chat",
    outcomes: ["Dictation and its requirement understood", "Image downloaded", "Diagram code viewed and downloaded"],
    prerequisites: [
      "For dictation: a microphone, permission for this site to use it, and a transcription model (a Gemini Flash model) set up by your platform owner.",
      "For images: an image-generation model available to you in the model selector.",
      "For diagrams: any available model. Ask for a Mermaid diagram.",
    ],
    setupSteps: [
      "In the message box, choose Dictate a message (the microphone).",
      "Allow microphone access if the browser asks.",
      "Speak. A live waveform shows it is recording; recording stops by itself after 2 minutes.",
      "Choose Stop dictation and transcribe (the square). The transcript is added to the message box as editable text.",
      "Review the text, then send it yourself; dictation never sends on its own.",
    ],
    paths: [
      {
        label: "Images",
        steps: [
          "In the model selector, choose a model that can generate images.",
          "Describe the picture you want; ask for up to 4.",
          "The images appear in the reply, labeled Generated image.",
          "Point at an image and choose Download to save it. Download links last 7 days.",
        ],
      },
      {
        label: "Diagrams",
        steps: [
          "Ask for a diagram, for example: show the stages of a process as a Mermaid flowchart.",
          "The reply shows a live figure with Copy, PNG, SVG, Code, and Edit in its header.",
          "Choose Code to read or check the diagram's source; choose Diagram to switch back.",
          "Choose PNG or SVG to download the picture, or Copy to copy it.",
        ],
      },
    ],
    verify: [
      "Dictation: the transcript appears in the message box, ready to edit.",
      "Images: Download saves the image as a file.",
      "Diagrams: the figure renders in the reply, and PNG downloads it as a picture file.",
    ],
    troubleshooting: [
      { symptom: "\"No configured Gemini Flash model is available for dictation. …\"", fix: "Your workspace has no transcription model. Type your message, and ask your platform owner to set one up." },
      { symptom: "\"Microphone access was denied. Allow microphone use for this site to dictate.\"", fix: "Allow the microphone in your browser's site settings, then try again." },
      { symptom: "\"Microphone capture is not available in this browser.\"", fix: "Use a current browser on a device with a microphone." },
      { symptom: "\"No audio was captured. Check the selected microphone and try again.\" or \"The dictation model heard no speech in the recording.\"", fix: "Check which microphone your device uses and speak closer to it." },
      { symptom: "\"… returned no images for this request. Try rephrasing the prompt or selecting a different image model.\"", fix: "Rephrase the request, or choose another image model." },
      { symptom: "\"This diagram could not be rendered. Open Code to inspect the source, or Edit to fix it.\"", fix: "The model's diagram source has an error. Ask it to correct the Mermaid code, or fix it yourself." },
    ],
    scenes: [
      {
        title: "Dictate a message",
        caption: "The microphone records your voice. A live waveform shows it is listening.",
        narration: "To speak instead of typing, choose the microphone, Dictate a message. Allow microphone access if the browser asks. While it records, a live waveform shows it is listening. Recording stops by itself after two minutes.",
        durationSeconds: 16,
        focus: "dictationRecording",
      },
      {
        title: "Dictation needs a transcription model",
        caption: "Stop sends the recording for transcription. Without a transcription model, the workspace says so.",
        narration: "Choose the square to stop. The recording goes to your workspace's transcription model, and the text is added to the message box for you to edit and send. This workspace has no transcription model, so it says so instead: no configured Gemini Flash model is available. If you see this, type your message, and tell your platform owner.",
        durationSeconds: 22,
        focus: "dictationError",
        captionPlacement: "top",
      },
      {
        title: "Ask for images",
        caption: "With an image model selected, describe the picture. These frames were recorded earlier with an image model.",
        narration: "To create pictures, choose a model that can generate images, and describe what you want. The images appear right in the reply. This workspace has no image model, so these two frames come from an earlier recording with one; the sidebar looked slightly different then.",
        durationSeconds: 18,
        focus: "imageReply",
      },
      {
        title: "Download an image",
        caption: "Download under an image saves it as a file.",
        narration: "Point at an image and choose Download to save it as a file. Download links last seven days.",
        durationSeconds: 7,
        focus: "imageDownload",
      },
      {
        title: "Diagrams are live figures",
        caption: "Ask for a Mermaid diagram. It renders in the reply with Copy, PNG, SVG, Code, and Edit.",
        narration: "Any model can draw diagrams. Ask for a Mermaid flowchart, and the reply shows a live figure. Its header offers Copy, P N G, S V G, Code, and Edit.",
        durationSeconds: 13,
        focus: "mermaidFigure",
      },
      {
        title: "Check the code, download the picture",
        caption: "Code shows the diagram source. PNG or SVG downloads the picture.",
        narration: "Choose Code to read the diagram's source, and Diagram to switch back. Choose P N G or S V G to download the picture for a document or slide.",
        durationSeconds: 11,
        focus: "diagramCode",
      },
    ],
  },
  {
    id: "work-traces",
    audioSrc: "training/user/work-traces.mp3",
    title: "Follow the work trace and act on replies",
    description: "Read the steps behind a reply, rate it with a note, branch it into a new chat, and turn it into an editable document.",
    icon: "trace",
    track: "Chat",
    outcomes: ["Trace expanded", "Feedback sent with a note", "Reply branched", "Reply transferred to Drafts"],
    prerequisites: [
      "A chat with at least one finished reply (see Start chatting).",
    ],
    setupSteps: [
      "Under a finished reply's heading, find Work trace and its summary, such as complete · 4 steps.",
      "Choose Work trace to expand it and read every step: Routing request names the model, Preparing context lists the sources, then Generating answer and Finalizing response.",
      "Choose Work trace again to collapse it.",
      "Choose Send positive feedback (thumbs up) or Send negative feedback (thumbs down) under the reply.",
      "Optionally type a note in the box that opens, then choose Send note. Note sent confirms it.",
      "Choose Branch response into new chat to continue from this reply in a separate chat.",
      "Choose Transfer to Drafts to open the reply as an editable document.",
    ],
    paths: [
      {
        label: "Rate a reply",
        steps: [
          "Choose the thumbs up or thumbs down under the reply. Positive feedback sent (or Negative feedback sent) appears.",
          "In What worked well? or What went wrong?, add an optional note of up to 2,000 characters.",
          "Choose Send note, or close the box to skip the note.",
        ],
      },
      {
        label: "Branch into a new chat",
        steps: [
          "Choose Branch response into new chat under the reply.",
          "A new chat opens, titled Branch: and the original title, holding the prompt and this reply.",
          "Continue there; the original chat is unchanged.",
        ],
      },
      {
        label: "Transfer to Drafts",
        steps: [
          "Choose Transfer to Drafts at the right of the reply's actions.",
          "Drafts opens a new document titled after the chat, saved as Version 1, with the reply and any citations.",
          "Edit it, save versions, and export it (see Draft documents).",
        ],
      },
    ],
    verify: [
      "The expanded trace lists the model used in Routing request.",
      "Note sent appears beside the reply's actions after sending a note.",
      "A chat titled Branch: … appears under Recent.",
      "Drafts opens with the reply as a saved document, and the assistant rail says it was transferred.",
    ],
    troubleshooting: [
      { symptom: "The running trace moves to the next step before that step seems done", fix: "While a reply runs, the trace advances through the planned steps on a timer. Treat it as a guide to what the request involves; the finished trace is the record." },
      { symptom: "\"Could not branch\"", fix: "The branch could not be created, often because the connection dropped. Try again when the chat has saved." },
      { symptom: "No actions under a reply", fix: "Actions appear only on finished replies. A stopped or failed reply has none; resend with Edit message." },
      { symptom: "Transfer to Drafts is missing", fix: "It appears on finished replies with text. Wait for the reply to finish." },
    ],
    scenes: [
      {
        title: "While the reply runs",
        caption: "The trace shows the planned steps and a timer while the reply is prepared.",
        narration: "While a reply runs, the trace shows a timer and the steps planned for this request. It moves through them as time passes, so use it as a guide to what the request involves. The finished trace is the record.",
        durationSeconds: 15,
        focus: "chatRunning",
      },
      {
        title: "The trace after the reply",
        caption: "Work trace, complete, and the number of steps sit above every finished reply.",
        narration: "When the reply lands, the same line becomes Work trace, complete, with the number of steps that ran.",
        durationSeconds: 8,
        focus: "traceCollapsed",
      },
      {
        title: "Expand every step",
        caption: "Routing request names the model; Preparing context lists sources; then the answer is generated and finalized.",
        narration: "Choose Work trace to expand it. Routing request names the model that answered. Preparing context lists the sources it used, here none. Then come Generating answer and Finalizing response. When you turn on knowledge, web search, attachments, or an agent, their steps appear here too.",
        durationSeconds: 20,
        focus: "traceExpanded",
        captionPlacement: "top",
        calloutPlacement: "lower-right",
      },
      {
        title: "Rate the reply",
        caption: "Thumbs up or down sends feedback. Add an optional note, then Send note.",
        narration: "To tell your workspace how a reply did, choose thumbs up or thumbs down. Feedback is sent at once, and a box opens for an optional note: what worked well, or what went wrong. Type it and choose Send note.",
        durationSeconds: 14,
        focus: "chatFeedback",
      },
      {
        title: "Note sent",
        caption: "Note sent confirms the note. The filled thumb shows your rating.",
        narration: "Note sent confirms it, and the filled thumb shows your rating. Your administrators review feedback to improve the workspace.",
        durationSeconds: 9,
        focus: "chatFeedbackSent",
      },
      {
        title: "Branch into a new chat",
        caption: "Branch response into new chat opens Branch: … with the prompt and this reply.",
        narration: "To explore a different direction without changing this chat, choose Branch response into new chat. A new chat opens, titled Branch, with the prompt and this reply, ready for your next message.",
        durationSeconds: 13,
        focus: "chatBranched",
      },
      {
        title: "Transfer to Drafts",
        caption: "Transfer to Drafts turns the reply into an editable document.",
        narration: "To turn a reply into a document, choose Transfer to Drafts at the right of its actions.",
        durationSeconds: 7,
        focus: "transferDraft",
        calloutPlacement: "lower-left",
      },
      {
        title: "Your reply, now a document",
        caption: "Drafts opens the reply as Version 1 of a saved document, ready to edit and export.",
        narration: "Drafts opens a new document titled after the chat, saved as version one, with the reply's text and formatting. The assistant rail notes where it came from. Edit it, save versions, and export it, as the Draft documents lesson shows.",
        durationSeconds: 17,
        focus: "chatTransferred",
      },
    ],
  },
  {
    id: "session-details",
    audioSrc: "training/user/session-details.mp3",
    title: "Session details and context",
    description: "Open Session details to check the model, tokens used, how full the context window is, the sources a reply used, and the symbol shortcuts.",
    icon: "session",
    track: "Chat",
    outcomes: ["Usage reviewed", "Context window understood", "Sources checked", "Symbol shortcuts found"],
    prerequisites: [
      "A chat with at least one reply. Sources gathered appears after a reply that used knowledge or the web.",
    ],
    setupSteps: [
      "In a chat, choose Session info (the i button at the top right). Session details opens on the right.",
      "Read Session summary: Current chat, Tokens used, Model, Knowledge bases, Tools, and Agent profile.",
      "Read Context window: the meter and how many of the model's tokens this chat already uses.",
      "Scroll to Sources gathered to see every source a reply used, with its K (knowledge) or W (web) number and the passage.",
      "Scroll to Symbol shortcuts for the five symbols you can type in the message box.",
      "Choose Close session details when you are done.",
    ],
    paths: [
      {
        label: "From a reply's citations",
        steps: [
          "Under a reply, choose View N citations →.",
          "Session details opens at Sources gathered for that reply. Hide citations closes it again.",
        ],
      },
    ],
    verify: [
      "Tokens used shows the counts the provider reported (in, out, and total), or Not reported by the provider.",
      "The context window meter shows a percentage and tokens used of the model's total.",
      "Sources gathered lists the same number of sources as View N citations.",
    ],
    troubleshooting: [
      { symptom: "Tokens used reads \"Not reported by the provider\"", fix: "The model service did not return usage. Nothing is wrong with your chat; the context meter may use an estimate instead." },
      { symptom: "The context meter is marked estimated or ≈", fix: "It is based on message length, because the provider did not report usage for some messages." },
      { symptom: "The context window is nearly full", fix: "Start a new chat for a fresh window. Older details may otherwise matter less to the answer." },
      { symptom: "No Sources gathered section", fix: "The replies in this chat did not use knowledge or the web. Turn on Knowledge in Send options and ask again." },
    ],
    scenes: [
      {
        title: "Session summary",
        caption: "Session info opens Session details: the chat, tokens used, model, knowledge, tools, and agent profile.",
        narration: "Choose Session info, the i button at the top right of a chat. Session summary shows the current chat, the tokens used as the provider reported them, the model, and which knowledge bases, tools, and agent profile are on.",
        durationSeconds: 16,
        focus: "sessionSummary",
        calloutPlacement: "left-rail",
      },
      {
        title: "Watch the context window",
        caption: "The meter shows how much of the model's context this chat uses. Start a new chat when it fills.",
        narration: "The context window is how much the model can keep in view while answering. The meter shows how much this chat already uses. As it fills, older details matter less, so start a new chat for long new topics.",
        durationSeconds: 15,
        focus: "contextWindow",
        calloutPlacement: "left-rail",
      },
      {
        title: "Check the sources",
        caption: "Sources gathered lists each source a reply used, with its K or W number and the passage.",
        narration: "After a reply that used knowledge or the web, Sources gathered lists each source with its number and the passage the answer relied on. View citations under a reply jumps straight here.",
        durationSeconds: 13,
        focus: "sessionSources",
        calloutPlacement: "left-rail",
      },
      {
        title: "Symbol shortcuts",
        caption: "The five symbols you can type in the message box, and what each one adds.",
        narration: "At the bottom, Symbol shortcuts lists the five symbols you can type in the message box: slash for prompts and connections, at for agents, hash for knowledge, dollar for skill files, and greater-than for automations.",
        durationSeconds: 15,
        focus: "sessionShortcuts",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
    ],
  },
  {
    id: "chat-previews",
    audioSrc: "training/user/chat-previews.mp3",
    title: "Preview chats at a glance",
    description: "Hover any listed chat to read its prompts and outputs in a compact, scrollable preview.",
    icon: "preview",
    track: "Chat",
    outcomes: ["Preview opened", "Chat recognized", "Visual content spotted"],
    prerequisites: [
      "Chats in your sidebar, in All chats, or in Archived chats.",
    ],
    setupSteps: [
      "Point at a chat name in the sidebar and wait a moment; keyboard users can focus the chat row instead.",
      "Read the Chat preview: the title and time, then Prompt 1 and Output 1, in order.",
      "Scroll inside the preview to read later prompts and outputs. The footer counts prompts and outputs.",
      "Move away, or press Escape, to close it without opening the chat.",
      "Choose the chat if you want to open it.",
    ],
    paths: [
      {
        label: "In All chats",
        steps: [
          "Choose View all chats under your recent chats.",
          "Point at any chat in All chats; the preview opens beside the list.",
          "Filter chats narrows the list by title first.",
        ],
      },
      {
        label: "In Archived chats",
        steps: [
          "Account card › Archived chats › View.",
          "Point at an archived chat to preview it before you restore or delete it.",
        ],
      },
    ],
    verify: [
      "The preview shows Chat preview, the chat's title, and Prompt 1.",
      "The footer counts the prompts and outputs.",
    ],
    troubleshooting: [
      { symptom: "\"This chat does not have previewable content yet.\"", fix: "The chat has no messages yet." },
      { symptom: "No preview appears", fix: "Rest the pointer on the chat name for a moment, or focus the row with the keyboard." },
    ],
    scenes: [
      {
        title: "See a chat before opening it",
        caption: "Point at a chat: Chat preview shows its prompts and outputs, starting at Prompt 1.",
        narration: "Point at any chat name and pause. A compact chat preview opens without leaving the screen you are on. It starts at the top with Prompt 1, then Output 1. Scroll inside it to read the rest; the footer counts prompts and outputs. Images and diagrams show as they appear in the chat, and private thinking traces stay hidden.",
        durationSeconds: 22,
        focus: "sidebarPreview",
      },
      {
        title: "Preview from All chats",
        caption: "In All chats, and in Archived chats, previews work the same way.",
        narration: "The same preview works in View all chats, and in Archived chats in your account card, so you can recognize a conversation before you open, restore, or delete it.",
        durationSeconds: 12,
        focus: "previewAllChats",
      },
    ],
  },
  {
    id: "personal-data",
    audioSrc: "training/user/personal-data.mp3",
    title: "Personal data in your chats",
    description: "Recognize the personal data your organization conceals, know what the model received, and see how rated answers are kept when your organization captures training examples.",
    icon: "privacy",
    track: "Chat",
    outcomes: ["Concealed values recognized", "What the model received understood", "Rating disclosure read"],
    prerequisites: [
      "Your administrator has turned on Personal Data Protection. If not, none of this appears and chats are stored as typed.",
      "An available model.",
    ],
    setupSteps: [
      "Look under the message box. When your organization protects personal data, the line ends with Personal data is concealed. Point at it for a short explanation.",
      "Send your message as usual. Social Security, card, and account numbers, contact details, health identifiers, and secrets become locked chips, such as SSN or Email, as soon as the message is sent.",
      "Read the reply. When your organization keeps values from the model, the model received placeholders only, so its draft shows them, for example [SSN], where a value belongs.",
      "Add the real values yourself in the system where they belong, not in the chat.",
      "When you rate a reply with the thumbs buttons, read the note box. If your organization captures training examples, it says so: a de-identified copy of rated answers and notes is kept and never sent to a model provider.",
    ],
    paths: [
      {
        label: "Values kept from the model (shown)",
        steps: [
          "Your sent message shows locked chips.",
          "The model received placeholders instead of the values, so its reply refers to them, for example [SSN] or [EMAIL].",
        ],
      },
      {
        label: "Model allowed to read values (shown)",
        steps: [
          "Your sent message still shows locked chips.",
          "The model read the values for that turn, so it can use them, for example in a signature block.",
          "Any value it writes is replaced with a locked chip before you see the reply and before the chat is saved.",
        ],
      },
      {
        label: "Rating answers when training capture is on (shown)",
        steps: [
          "Choose thumbs up or thumbs down under a reply. The note box says your organization keeps a de-identified copy of rated answers and notes, and that it is never sent to a model provider.",
          "Type a note and choose Send note, or close the box with ×. The rating counts either way.",
          "Corrections you type in the chat, such as \"That's wrong, the deadline is 60 days. Please revise.\", can be kept the same way.",
        ],
      },
    ],
    verify: [
      "The line under the message box ends with Personal data is concealed.",
      "Your sent message shows a locked chip where you typed the value.",
      "Reopening the chat later still shows the chip, not the value.",
    ],
    troubleshooting: [
      { symptom: "Your message shows the value for a moment after you send it", fix: "The concealed copy replaces it within a moment. The original value is not saved." },
      { symptom: "The reply says [SSN] or similar where you expected a value", fix: "The model never received the value. Fill it in yourself where it belongs; do not paste it back into the chat." },
      { symptom: "A name or a description of someone's health was not concealed", fix: "Concealment recognizes numbers, codes, and contact details by their format. It does not recognize names or free text about health, so leave them out when your policy requires it." },
      { symptom: "A draft still contains a value", fix: "Drafts are documents of record and are not altered. Keep personal data out of drafts unless your policy allows it." },
      { symptom: "You need the original value from an earlier chat", fix: "It was never saved, so the chat cannot give it back. Use the system of record it came from." },
    ],
    scenes: [
      {
        title: "Personal data is concealed",
        caption: "The line under the message box: Personal data is concealed.",
        narration:
          "When your organization protects personal data, the line under the message box ends with Personal data is concealed. Point at it to read what that means.",
        durationSeconds: 11,
        focus: "privacyFooter",
      },
      {
        title: "Values become locked chips",
        caption: "Sent values show as locked chips, such as SSN and Email.",
        narration:
          "Type and send as usual. This message includes a Social Security number and an email address. As soon as it is sent, each value is replaced by a locked chip, S S N and Email. The original value is not saved.",
        durationSeconds: 16,
        focus: "privacyPrompt",
      },
      {
        title: "The model received placeholders",
        caption: "The model saw placeholders, so its draft says [SSN] and [EMAIL].",
        narration:
          "Here the organization keeps values from the model, so the model received placeholders only. Its draft says S S N and EMAIL in brackets where the values belong. Add the real values yourself, in the system where they belong.",
        durationSeconds: 16,
        focus: "privacyReply",
      },
      {
        title: "Values in replies are concealed too",
        caption: "A value the model writes appears as a locked chip.",
        narration:
          "Some organizations let the model read values for work that needs them, like this signature block. The reply is concealed on its way to you, so the phone number and email appear as locked chips.",
        durationSeconds: 14,
        focus: "privacyOutput",
      },
      {
        title: "Rating answers",
        caption: "The note box says when a de-identified copy of rated answers is kept.",
        narration:
          "When you rate a reply with the thumbs buttons, the note box may say that your organization keeps a de-identified copy of rated answers and notes to improve its own models. That copy is never sent to a model provider. Add a note, or close the box.",
        durationSeconds: 18,
        focus: "privacyRatingNote",
      },
    ],
  },
  {
    id: "drafts",
    audioSrc: "training/user/drafts.mp3",
    title: "Draft documents",
    description: "Start a document from a blank page, a chat reply, or a file; have the assistant write it; edit with AI; save a version; and export it.",
    icon: "drafts",
    track: "Drafts and decks",
    outcomes: ["Document written by the assistant", "Passage edited with AI", "Version saved", "Word file exported"],
    prerequisites: [
      "An available model for AI writing and editing. Without one, you can still type, open files, save, and export.",
      "To open a file in the editor: a Word (.docx or .doc), Markdown (.md), text (.txt), or web page (.html) file.",
    ],
    setupSteps: [
      "Choose Drafts in the sidebar. A blank document opens, with the Document Assistant on the left.",
      "Type a title in the title field at the top of the page.",
      "In Ask the document assistant, describe the document you need, or choose a suggestion. Choose Apply instruction (the arrow).",
      "Wait while the assistant writes on the page. Ready to write returns when it is done.",
      "Check the title. If the assistant renamed the document, type your own title again.",
      "Select a passage, choose Ask AI in the floating toolbar (or press Ctrl+J, ⌘J on a Mac), and choose an action such as Make shorter.",
      "Review the Changes or Result view, then choose Replace. Insert below, Try again, and Discard are the alternatives.",
      "Choose Save version and wait for Saved.",
      "Choose Export, set Save to to Browser downloads, and choose Word document. The receipt names the downloaded file.",
    ],
    paths: [
      {
        label: "From a chat reply",
        steps: [
          "Under a finished chat reply, choose Transfer to Drafts.",
          "Drafts opens a new document with the reply, saved as Version 1.",
          "Continue from step 6 of the main steps.",
        ],
      },
      {
        label: "Open a file from this device",
        steps: [
          "Choose Attach file (the paperclip) in the assistant's message box.",
          "Under From this device, choose Open in editor, and pick a .docx, .doc, .md, .txt, or .html file.",
          "The file opens as a new draft with its headings and lists. The draft you had open stays in Document history.",
          "Attach to chat instead gives the file to the assistant to read with your next request.",
        ],
      },
      {
        label: "Write it yourself",
        steps: [
          "Click on the page and type. Markdown shortcuts work: # and a space starts a title, - and a space starts a list.",
          "Type / at the start of a line for the command menu: headings, lists, tables, page breaks, and AI actions.",
          "Use Text, Paragraph, More, and Insert above the page for formatting.",
        ],
      },
      {
        label: "Export formats",
        steps: [
          "Word document: an editable .docx with page breaks and images.",
          "Markdown: a .md file for plain text or web publishing.",
          "Print / Save as PDF: opens the browser's print dialog; choose Save as PDF there.",
          "Save to: Browser downloads saves straight to your downloads; Choose a location asks the browser where to save.",
        ],
      },
    ],
    verify: [
      "The toolbar shows Saved and the version number after Save version.",
      "The export receipt names the file, for example synthetic-vendor-onboarding-checklist.docx, and offers Download again.",
      "An opened file shows a note in the assistant rail: the file opened in the editor.",
    ],
    troubleshooting: [
      { symptom: "\"AI drafting is unavailable.\" or Model: No models connected", fix: "No model is available to you. You can still type, open files, save, and export. Ask your administrator for model access." },
      { symptom: "The document title changed to a template name, such as Board Update Draft", fix: "The assistant can rename a new document after a template it matched. Type your own title back into the title field, then save." },
      { symptom: "\"Could not open … Choose a .docx, .doc, .md, .txt, or .html file.\"", fix: "Save the file in one of those formats and open it again. For PDFs, use a knowledge base or attach the file to chat." },
      { symptom: "\"Wait for the assistant to finish before opening another document.\"", fix: "Let the current request finish, then open the file." },
      { symptom: "Export says \"Save your edits first\"", fix: "Choose Save version and export (or Save version and print). Exports use the saved version." },
      { symptom: "\"Local only — server save failed\"", fix: "Your changes are kept in this browser. Choose Retry, or export a copy before you leave." },
      { symptom: "\"Could not export … Try again from the export menu.\"", fix: "Try again, or choose Browser downloads in Save to." },
    ],
    scenes: [
      {
        title: "Open Drafts",
        caption: "Drafts opens a blank document, with the Document Assistant and suggested requests on the left.",
        narration: "Choose Drafts in the sidebar. A blank document opens on the right, with the Document Assistant on the left: What should we write? Type a title at the top of the page first.",
        durationSeconds: 12,
        focus: "draftComposer",
      },
      {
        title: "Check the drafting model",
        caption: "The drafting model writes and edits with AI. Without one, you can still edit, open, save, and export.",
        narration: "The model menu shows which model writes and edits. If it says No models connected, AI actions are unavailable, but you can still type, open files, save versions, and export.",
        durationSeconds: 14,
        focus: "draftModel",
        calloutPlacement: "left-rail",
      },
      {
        title: "Ask for a draft",
        caption: "Describe the document in plain words, then choose Apply instruction.",
        narration: "In Ask the document assistant, describe the document in plain words, including its headings and length. Then choose Apply instruction.",
        durationSeconds: 10,
        focus: "draftsRequest",
      },
      {
        title: "The assistant writes on the page",
        caption: "The document appears on the page, formatted. The rail records the request and the model used.",
        narration: "The assistant writes straight onto the page, with real headings and lists. The rail records your request and which model drafted it. Read it through before you share it.",
        durationSeconds: 11,
        focus: "draftsGenerated",
      },
      {
        title: "Keep your own title",
        caption: "If the assistant renames the document, type your title back into the title field.",
        narration: "Check the title. The assistant can rename a new document after a template it matched, so type your own title back in if it changed.",
        durationSeconds: 9,
        focus: "draftsTitle",
      },
      {
        title: "Select text and Ask AI",
        caption: "Select a passage, choose Ask AI, and pick an action or describe the change.",
        narration: "To change one passage, select it and choose Ask AI in the floating toolbar, or press Control J, Command J on a Mac. Pick an action such as Make shorter, or describe your own change.",
        durationSeconds: 14,
        focus: "draftsAiMenu",
      },
      {
        title: "Review, then replace",
        caption: "Changes shows what will change. Replace accepts it; Discard leaves the page as it was.",
        narration: "Review the suggestion. Changes marks what is removed and added; Result shows the new text. Choose Replace to accept it. Insert below, Try again, and Discard are the other choices. Nothing changes until you accept.",
        durationSeconds: 16,
        focus: "draftAiEdit",
      },
      {
        title: "Format like a document",
        caption: "Text, Paragraph, More, and Insert hold the formatting controls.",
        narration: "Above the page, Text sets fonts, sizes, and colors; Paragraph sets alignment and lists; More holds copy and the AI edit trail; Insert adds links, citations, images, charts, tables, and page breaks.",
        durationSeconds: 15,
        focus: "draftToolbar",
      },
      {
        title: "Insert with the slash menu",
        caption: "Type / at the start of a line for headings, lists, tables, and AI actions.",
        narration: "Type a slash at the start of a line to open the command menu. Keep typing to filter, and press Enter to add a heading, a list, a table, a page break, or an AI action such as Continue writing.",
        durationSeconds: 14,
        focus: "draftSlashMenu",
      },
      {
        title: "Find, outline, and zoom",
        caption: "The status bar counts words and opens Outline, Find, shortcuts, and zoom.",
        narration: "The status bar under the page counts pages and words. Outline lists your headings, Find opens find and replace, and zoom resizes the page on screen.",
        durationSeconds: 12,
        focus: "draftStatusBar",
      },
      {
        title: "Apply a page layout",
        caption: "Assistant settings › Apply MLA layout sets spacing, font, and title. Undo reverses it.",
        narration: "Assistant settings offers Apply M L A layout: double spacing, twelve point Times New Roman, and a centered title, keeping your text. Undo reverses it.",
        durationSeconds: 12,
        focus: "draftSettings",
      },
      {
        title: "Save a version",
        caption: "Save version stores a snapshot in your account. Saved confirms it.",
        narration: "Choose Save version. The version number goes up, and Saved confirms it reached your account. Save before you export or leave.",
        durationSeconds: 10,
        focus: "draftSaveState",
      },
      {
        title: "Choose an export",
        caption: "Export offers Word document, Markdown, and Print / Save as PDF. Save to picks where it goes.",
        narration: "Choose Export. Word document makes an editable file, Markdown makes plain text, and Print, Save as P D F opens your browser's print dialog, where you choose Save as P D F. Save to decides where the file goes: Browser downloads, or a location you choose.",
        durationSeconds: 19,
        focus: "draftsExportMenu",
        calloutPlacement: "left-rail",
      },
      {
        title: "The file is downloaded",
        caption: "The receipt names the file. Download again repeats it.",
        narration: "Here, Word document saved to browser downloads. The receipt names the file, and Download again repeats it.",
        durationSeconds: 9,
        focus: "draftsExported",
      },
      {
        title: "Start from a chat reply",
        caption: "Transfer to Drafts opens a chat reply as a saved document.",
        narration: "You can also start from a chat reply. Transfer to Drafts opens it here as a saved document, ready for the same editing, saving, and export.",
        durationSeconds: 11,
        focus: "chatTransferred",
      },
      {
        title: "Open a file from this device",
        caption: "Attach file › From this device: Attach to chat for the assistant, or Open in editor to edit the file.",
        narration: "Or start from a file. Choose the paperclip in the assistant's message box. Attach to chat gives a file to the assistant to read. Open in editor opens a Word, Markdown, text, or web page file as the document itself.",
        durationSeconds: 16,
        focus: "draftOpenFromDevice",
      },
      {
        title: "The file opens as a draft",
        caption: "The file opens with its headings and lists. The previous draft stays in Document history.",
        narration: "The file opens as a new draft with its headings and lists, and the rail confirms it. The draft you had open stays in Document history.",
        durationSeconds: 10,
        focus: "draftOpenedDocument",
      },
    ],
  },
  {
    id: "deck-basics",
    audioSrc: "training/user/deck-basics.mp3",
    title: "Build a slide deck",
    description: "Turn a document into slides, build a deck from an outline or a starter template, refine it, present it, and export a PowerPoint file.",
    icon: "deck",
    track: "Drafts and decks",
    outcomes: ["Deck created from a document, an outline, and a template", "Deck presented in presenter view", "Real .pptx exported"],
    prerequisites: [
      "An available model for the deck assistant and Edit slide with AI. Templates, layouts, notes, presenting, and export work without one.",
      "Optional: your organization's PowerPoint brand template (.pptx or .potx, up to 30 MB, no macros).",
      "AI slide images need an image-generation model in your workspace.",
    ],
    setupSteps: [
      "Choose Drafts in the sidebar, then choose Deck in the Draft format switch. A blank deck opens with the Deck Assistant.",
      "Type a title for the deck.",
      "In Ask the deck assistant, describe the deck: how many slides and what each covers. Choose Apply instruction.",
      "Wait while Building slides… runs; on smaller models this can take a few minutes. The filmstrip fills and the rail says how many slides were drafted.",
      "Review each slide. Use Layouts, Themes, speaker notes, and Edit slide with AI to refine it.",
      "Choose Save version and wait for Saved.",
      "Choose Present deck, then press P for presenter view. Escape exits.",
      "Choose Export, set Save to to Browser downloads, and choose PowerPoint deck. The receipt names the .pptx file.",
    ],
    paths: [
      {
        label: "Convert a document",
        steps: [
          "In a document with content, choose Deck in the Draft format switch.",
          "Turn this draft into slides? appears. Choose Convert into slides (or Start a blank deck).",
          "The headings become slides. Your document versions are kept either way.",
        ],
      },
      {
        label: "Start from a template",
        steps: [
          "In a deck, choose Deck starters & brand themes.",
          "Choose a starter: Pitch deck, Quarterly review, Project kickoff, Client proposal, or Training session.",
          "Choose Start and the template's name. Replace the scaffold text with your content.",
        ],
      },
      {
        label: "Your brand template",
        steps: [
          "In Deck starters & brand themes, choose Upload under Brand theme and pick your .pptx or .potx file.",
          "Choose Apply to deck. The colors, fonts, and logo carry through the slides.",
          "Load all N slides brings in every slide design. The brand theme is stored only on this device.",
        ],
      },
      {
        label: "Present",
        steps: [
          "Choose Present deck. Arrow keys, Space, or a click move forward.",
          "Press N to show notes, P for presenter view (timer, next slide, notes), and B to black out the screen.",
          "Press Escape, or choose Exit, to leave.",
        ],
      },
      {
        label: "Export formats",
        steps: [
          "PowerPoint deck: an editable .pptx with your slides and speaker notes.",
          "Markdown outline: slide titles, bullets, and notes as text.",
        ],
      },
    ],
    verify: [
      "The filmstrip lists the slides, and the rail reports how many the assistant drafted.",
      "Presenter view shows the current slide, a timer, the next slide, and your notes.",
      "The export receipt names the .pptx file.",
    ],
    troubleshooting: [
      { symptom: "Building slides… runs for several minutes", fix: "Larger decks take longer, especially on smaller models. Ask for fewer slides, or wait; your draft stays intact meanwhile." },
      { symptom: "Generate AI slide image is greyed out: \"No image-generation model is enabled for your workspace\"", fix: "Your workspace has no image model. Upload your own background from Slide background instead." },
      { symptom: "\"Could not open … Choose a PowerPoint .pptx file.\"", fix: "Open in editor accepts .pptx and .potx files. Save other formats as .pptx first." },
      { symptom: "\"… exceeds the 30 MB brand-template upload limit.\" or \"Macro-enabled presentations are not accepted. Save as .pptx or .potx first.\"", fix: "Use a smaller template, and save it without macros." },
      { symptom: "\"Brand template upload failed: …\"", fix: "Check that the file is a valid PowerPoint template and try again." },
    ],
    scenes: [
      {
        title: "Turn a document into slides",
        caption: "Choose Deck in a document with content. Convert into slides, or start a blank deck.",
        narration: "There are three ways to start a deck. First, from a document: choose Deck in the Draft format switch. Turn this draft into slides? asks how to begin. Choose Convert into slides, or Start a blank deck. Your document versions are kept either way.",
        durationSeconds: 17,
        focus: "deckConvertDialog",
      },
      {
        title: "Your headings become slides",
        caption: "Each heading becomes a slide in the filmstrip.",
        narration: "The document's title and headings become slides in the filmstrip, ready to refine.",
        durationSeconds: 7,
        focus: "deckConverted",
      },
      {
        title: "Build from an outline",
        caption: "In a blank deck, describe the slides you need and choose Apply instruction.",
        narration: "Second, from an outline. In a blank deck, tell the deck assistant how many slides you want and what each covers, then choose Apply instruction.",
        durationSeconds: 11,
        focus: "deckOutlineRequest",
      },
      {
        title: "The assistant drafts the slides",
        caption: "Building slides… fills the filmstrip. The rail says how many slides were drafted.",
        narration: "Building slides can take a few minutes on smaller models. When it is done, the filmstrip holds the slides, and the rail says how many were drafted. Save a version once you have reviewed them.",
        durationSeconds: 13,
        focus: "deckGenerated",
      },
      {
        title: "Layouts and themes",
        caption: "Layouts rearrange the selected slide; Themes recolor the whole deck.",
        narration: "Above the slide, Layouts gives the selected slide a different arrangement, such as title and bullets or two columns. Themes recolors every slide. Your text stays as written.",
        durationSeconds: 13,
        focus: "deckLayoutMenu",
      },
      {
        title: "Edit a slide with AI",
        caption: "Edit slide with AI shows before and after. Apply to slide, Try again, or Discard.",
        narration: "Choose Edit slide with AI to improve a slide, make it punchier, cut the text, or write speaker notes. Compare before and after, then choose Apply to slide, Try again, or Discard.",
        durationSeconds: 14,
        focus: "deckAiEdit",
      },
      {
        title: "Speaker notes",
        caption: "Notes under the slide go into the PowerPoint file and presenter view.",
        narration: "Speaker notes sit under the slide. They export into the PowerPoint file's notes, and appear in presenter view.",
        durationSeconds: 9,
        focus: "deckNotes",
      },
      {
        title: "Backgrounds",
        caption: "Slide background uploads your own image, for one slide or every slide.",
        narration: "Slide background takes your own image upload, on this slide or on every slide. AI slide images need an image model in your workspace.",
        durationSeconds: 11,
        focus: "deckBackgroundMenu",
      },
      {
        title: "Start from a template",
        caption: "Deck starters & brand themes: pick a starter, then Start it.",
        narration: "Third, from a template. Choose Deck starters and brand themes, pick a starter such as Project kickoff, and choose Start Project kickoff.",
        durationSeconds: 10,
        focus: "deckStarters",
      },
      {
        title: "Replace the scaffold",
        caption: "The template's slides arrive with placeholder text to replace.",
        narration: "The template's slides arrive in the filmstrip with placeholder text. Replace it with your content.",
        durationSeconds: 8,
        focus: "deckTemplateStarted",
      },
      {
        title: "Use your brand template",
        caption: "Upload a .pptx or .potx brand template, then Apply to deck. It is stored on this device.",
        narration: "In the same panel, upload your organization's PowerPoint template under Brand theme and choose Apply to deck. Load all slides brings in every slide design. The brand theme stays on this device.",
        durationSeconds: 14,
        focus: "deckTemplatesDrawer",
      },
      {
        title: "Your brand, applied",
        caption: "The stage and filmstrip take on the template's colors, fonts, and logo.",
        narration: "With a brand applied, the slides take on its colors, fonts, and logo.",
        durationSeconds: 6,
        focus: "deckBrandStage",
      },
      {
        title: "Present in presenter view",
        caption: "Present deck, then P: timer, next slide, and notes. Escape exits.",
        narration: "Choose Present deck to play it full screen. Press P for presenter view, with a timer, the next slide, and your notes. N shows notes on the slide, B blacks out the screen, and Escape exits.",
        durationSeconds: 13,
        focus: "deckPresent",
      },
      {
        title: "Export PowerPoint",
        caption: "Export deck: PowerPoint deck or Markdown outline.",
        narration: "Choose Export. PowerPoint deck makes an editable file that mirrors your slides, with notes. Markdown outline gives the titles, bullets, and notes as text.",
        durationSeconds: 12,
        focus: "deckExportMenu",
      },
      {
        title: "The deck is downloaded",
        caption: "The receipt names the .pptx file.",
        narration: "The receipt names the downloaded file, ready to open in your presentation app.",
        durationSeconds: 7,
        focus: "deckExported",
      },
    ],
  },
  {
    id: "save-and-recover-work",
    audioSrc: "training/user/save-and-recover-work.mp3",
    title: "Save, organize, and recover your drafts",
    description: "Save documents and decks to your account, reopen them from Document history, archive and restore them, return to an earlier version, and recover work kept only on this device.",
    icon: "drafts",
    track: "Drafts and decks",
    outcomes: ["Version saved to your account", "Draft archived and restored", "Earlier version found", "Device-only work reviewed"],
    prerequisites: [
      "At least one document or deck in Drafts.",
    ],
    setupSteps: [
      "In a document or deck, choose Save version and wait for Saved in the toolbar.",
      "Choose Document history (the clock at the top of the assistant rail).",
      "Point at a card to preview it, or choose the card to reopen that draft.",
      "To put finished work away, point at its card and choose Archive. Draft archived. Open Archived to restore it. confirms it.",
      "Choose Archived to find it, then choose Unarchive to bring it back to Active.",
      "Under Versions of this draft, choose a version to return to it.",
      "Delete is separate: choose Delete, read the confirmation, then choose Delete draft or Cancel.",
    ],
    paths: [
      {
        label: "When a save fails",
        steps: [
          "Local only means the latest changes are kept in this browser but have not reached your account.",
          "Choose Retry, or export a copy before you leave.",
          "If Draft changed elsewhere appears, keep your local changes safe (export), then choose Reload server copy.",
        ],
      },
      {
        label: "Only on this device",
        steps: [
          "The sidebar reminder counts items only on this device. Choose it to open the list.",
          "Retry all retries chat saves; Open Drafts takes you to drafts and decks with unsent changes.",
          "Clear list dismisses the current reminders; Hide this reminder hides the notice. Neither uploads nor deletes your work.",
        ],
      },
      {
        label: "Leaving with unsaved edits",
        steps: [
          "Keep your unsaved edits? appears when you leave or open something else.",
          "Choose Keep editing, Save copy and continue, or Discard and continue.",
        ],
      },
    ],
    verify: [
      "Saved appears in the toolbar with the version number.",
      "The draft is listed under Archived after archiving, and under Active after Unarchive.",
      "Versions of this draft lists each saved version with its time.",
    ],
    troubleshooting: [
      { symptom: "\"Local only — … Your changes are kept on this device.\"", fix: "The server save failed. Choose Retry, or export a copy before you close the browser." },
      { symptom: "\"Not saved — …, and browser storage could not keep a copy.\"", fix: "Keep the workspace open, then retry or export your changes." },
      { symptom: "\"this draft exceeds the 2 MB server draft limit\" (or the 8 MB deck limit)", fix: "Split the document, or remove large images, then save again." },
      { symptom: "\"Draft changed elsewhere\"", fix: "Another tab or device saved this draft. Export your local version if you need it, then choose Reload server copy." },
      { symptom: "\"Save two different versions of this draft to compare them\"", fix: "Compare versions needs two saved versions that differ. Save again after an edit." },
    ],
    scenes: [
      {
        title: "Save to your account",
        caption: "Save version stores a snapshot. Saved confirms it reached your account.",
        narration: "Documents and decks follow your account. Choose Save version and wait for Saved in the toolbar. Saving means it is still on its way. Local only means the latest changes stayed in this browser: choose Retry, or export a copy.",
        durationSeconds: 16,
        focus: "draftSaveState",
      },
      {
        title: "Open Document history",
        caption: "The clock at the top of the rail lists your saved documents and decks, and this draft's versions.",
        narration: "Choose the clock at the top of the assistant rail to open Document history. It lists your saved documents and decks, newest first, and the versions of the draft that is open.",
        durationSeconds: 12,
        focus: "draftHistory",
      },
      {
        title: "Preview before opening",
        caption: "Point at a card to preview it. Choose the card to reopen it.",
        narration: "Point at a card, or focus it with the keyboard, to preview its content. Choose the card to reopen that document or deck.",
        durationSeconds: 9,
        focus: "draftHistoryPreview",
      },
      {
        title: "Archive finished work",
        caption: "Archive moves a draft to Archived. Nothing is deleted.",
        narration: "To put finished work away, point at its card and choose Archive. It moves to the Archived list. Nothing is deleted.",
        durationSeconds: 9,
        focus: "historyArchived",
      },
      {
        title: "Bring it back",
        caption: "Under Archived, Unarchive returns the draft to Active.",
        narration: "To bring it back, open Archived and choose Unarchive. The draft returns to the Active list.",
        durationSeconds: 8,
        focus: "historyRestored",
      },
      {
        title: "Return to an earlier version",
        caption: "Versions of this draft lists every saved version. Choose one to restore it.",
        narration: "Versions of this draft lists every version you saved, with its time. Choose one to return to it. If you have unsaved edits, you are asked to keep, save, or discard them first.",
        durationSeconds: 12,
        focus: "historyVersions",
      },
      {
        title: "Delete asks first",
        caption: "Delete removes the draft and its versions for good. Archive it if you might need it.",
        narration: "Delete is a separate action. The confirmation explains that the draft and its saved versions are removed from your account and this browser, and cannot be recovered. Choose Cancel and archive it instead if you might need it.",
        durationSeconds: 15,
        focus: "historyDelete",
      },
      {
        title: "Work only on this device",
        caption: "Only on this device lists unsent changes. Clearing or hiding reminders never uploads or deletes work.",
        narration: "If saves fail, a reminder in the sidebar counts items only on this device. Retry all retries chat saves, and Open Drafts takes you to drafts with unsent changes. Clear list and Hide this reminder only change the reminder; neither uploads nor deletes your work.",
        durationSeconds: 19,
        focus: "unsyncedWork",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "agents",
    audioSrc: "training/user/agents.mp3",
    title: "Agent profiles",
    description: "Build a private agent with its own instructions, model, knowledge, and skill files, then use it in chat and check that the reply follows it.",
    icon: "agents",
    track: "Agents, knowledge, and automations",
    outcomes: ["Agent built and saved privately", "Agent used in chat with @", "Reply follows the agent's instructions and knowledge"],
    prerequisites: [
      "Permission to build agents: your platform owner allows users to build their own agents, and your administrator grants Can build agents to one of your groups. Until then, Agents says Building agents is not available to you.",
      "An available model for the agent to use.",
      "Optional: knowledge bases, tools, prompts, and skill files shared with you, to attach to the agent.",
    ],
    setupSteps: [
      "Choose Agents in the sidebar, then New Agent.",
      "On Profile, type an Agent name and choose the AI model. Optionally start from a template such as Research Analyst.",
      "In System prompt, write the agent's instructions: its role, what it should produce, and what it must never do. Meta prompt adds standing rules on every turn.",
      "On Knowledge, tick the knowledge bases it should search on every message.",
      "On Tools, tick any tools it may use in agent mode; tools that need approval ask before they run.",
      "On Prompts & Skills, tick saved prompts and skill files to add to its instructions.",
      "On Access, read Private — only you can use this agent.",
      "Choose Create agent and wait for the agent's name followed by created. It is ready to use in chat.",
      "In a chat, type @ and choose the agent, then type your question and send it.",
      "Check the reply: the trace reads Agent work trace, and the answer follows the agent's instructions and cites its knowledge.",
    ],
    paths: [
      {
        label: "Use it from Send options",
        steps: [
          "Send options › Agent, then choose the profile in Agent profile.",
          "Check the selected profile before sending; turning Agent on can select the first one.",
        ],
      },
      {
        label: "Use it from the Agents page",
        steps: [
          "On the agent's card or in its editor, choose Chat (or Use in Chat).",
          "A chat opens with Agent mode on for that agent.",
        ],
      },
      {
        label: "Edit, duplicate, or delete",
        steps: [
          "On the agent's card, choose Edit, change the settings, and choose Save Profile.",
          "More actions on the card offers Duplicate and Delete.",
        ],
      },
      {
        label: "Share it",
        steps: [
          "Agents you build stay private to your account.",
          "Ask an administrator to share the agent with a group.",
        ],
      },
    ],
    verify: [
      "The agent appears under Agents with your chosen model.",
      "In chat, the Agent chip shows the agent, and the reply's trace reads Agent work trace with Preparing agent tools and the knowledge search.",
      "The answer follows the instructions you wrote (here, three bullet points from the playbook) and offers its citations.",
    ],
    troubleshooting: [
      { symptom: "\"Building agents is not available to you.\"", fix: "Your groups lack Can build agents, or the service policy does not allow user-built agents. Ask your administrator." },
      { symptom: "\"Select a base AI model and enter an agent name before saving.\"", fix: "Type a name and choose an available model in AI model." },
      { symptom: "\"… is not connected, so the agent cannot answer.\"", fix: "The agent's model has no working provider. Choose another model in Profile and save." },
      { symptom: "\"Knowledge base … is turned off, so the agent answers without it.\"", fix: "Ask the knowledge base's owner to turn it back on, or untick it." },
      { symptom: "\"No agent profiles available yet — create one under Agents\" when typing @", fix: "You have no agents yet, or none is shared with you. Build one, or ask your administrator." },
      { symptom: "The reply ignores part of the instructions", fix: "Smaller models follow short, specific instructions best. Shorten the System prompt, or choose a stronger model." },
    ],
    scenes: [
      {
        title: "Building agents needs permission",
        caption: "As shipped, Agents says Building agents is not available to you. An administrator grants it.",
        narration: "An agent is a reusable assistant with its own instructions, model, knowledge, and tools. Building your own needs permission. Until your administrator grants Can build agents to one of your groups, Agents says building is not available to you, and you can still use agents shared with you.",
        durationSeconds: 19,
        focus: "agentsBlocked",
        calloutPlacement: "left-rail",
      },
      {
        title: "New Agent",
        caption: "With permission, New Agent appears on the Agents page.",
        narration: "Once it is granted, New Agent appears. Choose it to start.",
        durationSeconds: 6,
        focus: "agentsNew",
      },
      {
        title: "Name, model, and instructions",
        caption: "Agent name, AI model, and System prompt: the agent's role and what it should produce.",
        narration: "On Profile, name the agent and choose its model. In System prompt, write its instructions: its role, what it should produce, and what it must never do. This one answers in exactly three bullet points based on the litigation playbook. Meta prompt adds standing rules on every turn.",
        durationSeconds: 20,
        focus: "agentProfileForm",
      },
      {
        title: "Give it knowledge",
        caption: "Knowledge: tick the knowledge bases the agent searches on every message.",
        narration: "On Knowledge, tick the knowledge bases the agent should search for every message. Here, the litigation playbook. The agent cites what it finds.",
        durationSeconds: 10,
        focus: "agentKnowledgePick",
      },
      {
        title: "Add skill files",
        caption: "Prompts & Skills: tick saved prompts and skill files to add to its instructions.",
        narration: "On Prompts and Skills, tick the saved prompts and skill files to add to its instructions. Here, Citation Discipline. Tools work the same way on the Tools tab.",
        durationSeconds: 12,
        focus: "agentSkillsPick",
      },
      {
        title: "Private to you",
        caption: "Access: agents you build are private. An administrator can share them with a group.",
        narration: "On Access, agents you build are private to your account. An administrator can share one with a group.",
        durationSeconds: 8,
        focus: "agentAccess",
      },
      {
        title: "Create the agent",
        caption: "Create agent saves it. The confirmation says it is ready to use in chat.",
        narration: "Choose Create agent. The confirmation says it is ready to use in chat, and the editor now offers Use in Chat and Save Profile.",
        durationSeconds: 10,
        focus: "agentCreated",
      },
      {
        title: "Use it with @",
        caption: "Type @, choose the agent, and ask your question. The Agent chip turns on.",
        narration: "In a chat, type the at sign and choose the agent. Its name is added and the Agent chip turns on. Type your question and send it.",
        durationSeconds: 10,
        focus: "agentMention",
      },
      {
        title: "The reply follows the agent",
        caption: "Agent work trace, three bullet points from the playbook: the reply follows the agent's setup.",
        narration: "The trace reads Agent work trace, and the answer follows the agent's setup: three bullet points drawn from the litigation playbook it searched, with citations further down. Check replies like this whenever you change an agent's instructions.",
        durationSeconds: 17,
        focus: "agentReply",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "knowledge",
    audioSrc: "training/user/knowledge.mp3",
    title: "Knowledge bases",
    description: "Create a knowledge base from files, web pages, or an API, watch it index, and ask a question that cites it.",
    icon: "knowledge",
    track: "Agents, knowledge, and automations",
    outcomes: ["Knowledge base created", "Files and a web page indexed", "Cited answer from your own documents"],
    prerequisites: [
      "To create your own: your administrator grants Can build knowledge bases to one of your groups. Without it, you use the knowledge bases shared with you.",
      "Files up to 250 MB each: PDF, Word, Excel, PowerPoint, email (.eml, .msg), text, Markdown, CSV, JSON, images, audio, and video.",
      "For web pages: public addresses. For pages behind a sign-in, paste the text instead.",
      "Connected sources such as SharePoint, Box, Google Drive, and iManage are set up by administrators and shared with you.",
    ],
    setupSteps: [
      "Choose Library in the sidebar; Knowledge opens.",
      "Choose New knowledge base.",
      "Type a Name, keep Start with on Upload files, and choose Create. Who can search it is Only me; administrators manage sharing.",
      "Drag files onto Drag files here, or choose browse your computer.",
      "Wait for each file to show Added and appear under Indexed files with its passage count. The base shows Ready.",
      "In a chat, type # and choose your knowledge base, then type your question and send it.",
      "Check the reply: it answers from your files and offers View N citations →. Open it to see each file and passage in Sources gathered.",
    ],
    paths: [
      {
        label: "Add web pages",
        steps: [
          "In the knowledge base, open Web pages.",
          "Type the Page address (and an optional Name), then choose Fetch and add page.",
          "The page is listed under Indexed web page; Sync now fetches it again later.",
          "For a page behind a sign-in, tick Paste the text instead of fetching the page, paste it, and choose Add text.",
        ],
      },
      {
        label: "Connect an API",
        steps: [
          "Open API. Enter the API address, an optional Path and Name.",
          "Under Sign-in choose None (public API), API key, Bearer token, or Sign in with provider (OAuth), and fill in its fields.",
          "Choose Fetch and add. The JSON or text response becomes searchable passages; Sync now refreshes it.",
        ],
      },
      {
        label: "Ask without #",
        steps: [
          "Send options › Knowledge, then choose your knowledge base.",
          "Send the question; the reply searches only that source.",
        ],
      },
      {
        label: "Turn it off or tidy it",
        steps: [
          "The On switch (Assistants can search …) controls whether chats can search it.",
          "Delete a file with the bin beside it under Indexed files.",
        ],
      },
    ],
    verify: [
      "Each file shows Added and is listed under Indexed files with a passage count.",
      "The knowledge base shows Ready and On.",
      "A question with # returns facts from your files and View N citations; Sources gathered names the file (for a PDF, with the page).",
    ],
    troubleshooting: [
      { symptom: "\"You can use the knowledge bases shared with you in chat. Ask an administrator if you need to add your own.\"", fix: "Creating knowledge bases is not granted to your groups. Ask your administrator for Can build knowledge bases." },
      { symptom: "\"Skipped … (save it as .docx first)\" or \"(unsupported type)\" or \"(larger than … MB)\"", fix: "Convert old .doc files to .docx, use a supported type, or split very large files." },
      { symptom: "\"No readable text — only the name is searchable\"", fix: "The file has no text layer (for example a picture-only PDF beyond the OCR limit). Upload a text version." },
      { symptom: "\"Give the knowledge base a name.\"", fix: "Type a Name before choosing Create." },
      { symptom: "\"Enter the page address.\"", fix: "Type the full address, including https://." },
      { symptom: "\"Some files could not be loaded. Retry\" in the # menu", fix: "Choose Retry. Sources that already loaded stay usable." },
    ],
    scenes: [
      {
        title: "Knowledge needs permission to create",
        caption: "As shipped, you use shared knowledge bases. An administrator grants Can build knowledge bases.",
        narration: "A knowledge base is a collection of your documents that chat can search and cite. Open Library, Knowledge. As shipped, you can use the knowledge bases shared with you. To create your own, your administrator grants Can build knowledge bases to one of your groups.",
        durationSeconds: 17,
        focus: "knowledgeBlocked",
        calloutPlacement: "left-rail",
      },
      {
        title: "New knowledge base",
        caption: "With permission, New knowledge base appears.",
        narration: "Once it is granted, choose New knowledge base.",
        durationSeconds: 5,
        focus: "knowledgeAdd",
      },
      {
        title: "Name it and choose how to start",
        caption: "Name, Start with: Upload files, Add web pages, or Connect an API. It is private to you.",
        narration: "Give it a name, and choose how to start: upload files, add web pages, or connect an A P I. You can mix all three later. It is private to you; administrators manage sharing. Choose Create.",
        durationSeconds: 14,
        focus: "knowledgeCreate",
        calloutPlacement: "left-rail",
      },
      {
        title: "Upload and index files",
        caption: "Drag files in. Each shows Added, then appears under Indexed files with its passages.",
        narration: "Drag files onto the drop zone, or browse your computer. P D F, Word, Excel, PowerPoint, email, images, audio, and video are accepted, up to two hundred fifty megabytes each. Each file shows Added, then appears under Indexed files with its passage count, and the base shows Ready.",
        durationSeconds: 21,
        focus: "knowledgeFiles",
      },
      {
        title: "Add a web page",
        caption: "Web pages: type the address, then Fetch and add page.",
        narration: "To add a public web page, open Web pages, type its address, and choose Fetch and add page. For a page behind a sign-in, tick the box and paste its text instead.",
        durationSeconds: 12,
        focus: "knowledgeWeb",
      },
      {
        title: "The page is indexed",
        caption: "The fetched page is listed and searchable. Sync now fetches it again later.",
        narration: "The page is fetched, indexed, and listed. Sync now fetches it again when it changes.",
        durationSeconds: 7,
        focus: "knowledgeWebAdded",
      },
      {
        title: "Or connect an API",
        caption: "API: address, path, and sign-in method. The response becomes searchable passages.",
        narration: "To bring in data from a system with an A P I, open A P I. Enter its address and path, choose how it signs in, and choose Fetch and add. The response becomes searchable passages. The grey text here only shows examples.",
        durationSeconds: 16,
        focus: "knowledgeApi",
      },
      {
        title: "Ask with #",
        caption: "In chat, type # and choose the knowledge base, then ask your question.",
        narration: "Now use it. In a chat, type a hash and choose your knowledge base. The Knowledge chip turns on. Type your question and send it.",
        durationSeconds: 9,
        focus: "knowledgeQuestion",
      },
      {
        title: "An answer from your documents",
        caption: "The reply uses your files: the renewal date and contact come from the uploaded PDF.",
        narration: "The reply answers from your own files. The renewal date and the security contact come from the uploaded P D F, and View two citations offers the sources.",
        durationSeconds: 12,
        focus: "knowledgeReply",
      },
      {
        title: "Check the citations",
        caption: "Sources gathered names each file, its page, and the passage used.",
        narration: "Choose View citations. Sources gathered names each file, with the page for a P D F, and the passage the answer used.",
        durationSeconds: 10,
        focus: "knowledgeSources",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "tools-automations",
    audioSrc: "training/user/tools-automations.mp3",
    title: "Tools and the Library",
    description: "Find the connections, saved prompts, and skill files you can use, read them, and add a private connection when your administrator allows it.",
    icon: "tools",
    track: "Agents, knowledge, and automations",
    outcomes: ["Connections, Prompts, and Skills found", "A saved prompt read and used", "Private connection form understood"],
    prerequisites: [
      "Prompts and skill files are created by administrators; you can read and use them.",
      "To add your own connection: your administrator grants Can build tools to one of your groups, and you have the MCP server's address.",
    ],
    setupSteps: [
      "Choose Library in the sidebar, then Tools.",
      "Connections lists the MCP connections you can use in Agent mode, with On, Off, or Needs setup.",
      "Choose Prompts to see the saved prompts shared with you. Choose a prompt's View to read its content.",
      "Choose Skills to see the skill files shared with you.",
      "Use them in chat: type / for prompts and connections, and $ for skill files, or attach them to an agent.",
    ],
    paths: [
      {
        label: "Add a private connection",
        steps: [
          "With Can build tools granted, Connections shows Add connection.",
          "Type a Name, choose how Aperture connects (HTTP or SSE), and enter the Server URL starting with https://.",
          "Choose Add connection. It starts turned off; set sign-in, access, and approval on the next screen, test it, and turn it on.",
          "Connections you add are private to you; an administrator can share them.",
        ],
      },
      {
        label: "Read a connection's status",
        steps: [
          "On: available under policy. Off: turned off. Needs setup: missing an address, token, or sign-in.",
          "Last test failed: the latest connection test did not succeed.",
          "Asks before each use: you approve each run in chat (Approve MCP tool run?).",
        ],
      },
    ],
    verify: [
      "Prompts and Skills list the items shared with you, and View shows each one's content.",
      "Typing / in chat lists the same prompts, and $ lists the same skill files.",
    ],
    troubleshooting: [
      { symptom: "\"Connections are managed by your administrators. These are the ones you can use in Agent mode.\"", fix: "You cannot add connections yet. Ask your administrator for Can build tools if you need one." },
      { symptom: "\"Shared prompts are managed by administrators.\" or \"Skills are managed by administrators.\"", fix: "Ask your administrator to add or change a prompt or skill file." },
      { symptom: "\"Use a full address starting with https://\"", fix: "Enter the complete server address." },
      { symptom: "\"Not signed in to the provider\" or \"No access token saved\"", fix: "Open the connection's Sign-in tab and finish signing in, or ask your administrator." },
      { symptom: "\"MCP tool run denied. No message was sent.\"", fix: "You chose Deny when asked to approve a tool run. Send again and choose Approve if you trust it." },
    ],
    scenes: [
      {
        title: "Tools in the Library",
        caption: "Library › Tools: Connections, Prompts, and Skills.",
        narration: "Choose Library in the sidebar, then Tools. It has three sections: Connections, Prompts, and Skills.",
        durationSeconds: 8,
        focus: "toolsHeader",
      },
      {
        title: "Connections and their status",
        caption: "MCP connections you can use in Agent mode, each On, Off, or Needs setup.",
        narration: "Connections lists the M C P connections you can use in Agent mode. Each shows its status: On, Off, or Needs setup, and whether it asks before each use. Your administrators manage these.",
        durationSeconds: 14,
        focus: "toolsRows",
      },
      {
        title: "Saved prompts",
        caption: "Prompts lists the saved prompts shared with you. View opens one.",
        narration: "Prompts lists the saved prompts your administrators share. Choose View to read one.",
        durationSeconds: 7,
        focus: "toolsPrompts",
      },
      {
        title: "Read a prompt",
        caption: "The prompt's content is what / inserts in chat.",
        narration: "This is the text a prompt adds. In chat, type a slash to insert it into your message, or attach it to an agent.",
        durationSeconds: 9,
        focus: "toolsPromptView",
      },
      {
        title: "Skill files",
        caption: "Skills lists skill files. Type $ in chat to attach one.",
        narration: "Skills lists the skill files you can use: written rules such as citation discipline or approval routing. Type a dollar sign in chat to attach one, or add it to an agent.",
        durationSeconds: 13,
        focus: "toolsSkills",
      },
      {
        title: "Add your own connection",
        caption: "With Can build tools: Add connection, a name, HTTP or SSE, and the server address.",
        narration: "If your administrator grants Can build tools, Connections offers Add connection. Name it, choose how it connects, and enter the server's address. It starts turned off: set its sign-in and approval, test it, then turn it on. It stays private to you.",
        durationSeconds: 17,
        focus: "toolsAddConnection",
      },
    ],
  },
  {
    id: "scheduled-automations",
    audioSrc: "training/user/scheduled-automations.mp3",
    title: "Scheduled automations",
    description: "Build an automation that runs a prompt through one or more models on a schedule, deliver it to a new chat or a new draft, run it now, and read its history.",
    icon: "automation",
    track: "Agents, knowledge, and automations",
    outcomes: ["Automation built with two steps", "Schedule chosen (Daily, Weekly, Once, or Custom)", "Run now delivered a real chat and a real draft", "Run history read and automation paused"],
    prerequisites: [
      "At least one model available to you. Without one, Automations says no approved models are available and New automation is off.",
      "The prompt you want to run, and when it should run (the time zone matters).",
    ],
    setupSteps: [
      "Choose Agents in the sidebar, then Automations.",
      "Choose New automation.",
      "Under What it does, type a Name and the Prompt for the first step.",
      "Under Steps, choose a model (or one of your agents) for step 1 and an optional instruction. Choose Add step to pass the result to another model.",
      "Under Schedule, choose Daily, Weekly, Once, or Custom, set the time and Time zone, and check Next runs.",
      "Under Deliver results to, choose New chat or New draft.",
      "Leave On — runs on this schedule turned on, and choose Save automation.",
      "On the automation's card, choose Run now to test it. Wait for the result and choose Open chat (or Open draft).",
    ],
    paths: [
      {
        label: "Daily",
        steps: [
          "How often › Daily, then set Time.",
          "Next runs lists the coming days at that time.",
        ],
      },
      {
        label: "Weekly",
        steps: [
          "How often › Weekly, choose the day (Mon to Sun), then set Time.",
          "Next runs lists the coming weeks.",
        ],
      },
      {
        label: "Once",
        steps: [
          "How often › Once, then set Run at to a date and time in the future.",
          "Next runs shows that single run; if the time has passed it says No upcoming runs — this time has passed.",
        ],
      },
      {
        label: "Custom (cron)",
        steps: [
          "How often › Custom, then type a Cron expression with five fields: minute, hour, day of month, month, day of week.",
          "For example 30 7 * * 1-5 runs at 7:30 AM on weekdays. Check Next runs before saving.",
        ],
      },
      {
        label: "Deliver to a new draft",
        steps: [
          "Under Deliver results to, choose New draft.",
          "The last step is asked for a complete document, saved as a new draft.",
          "After Run now, choose Open draft to edit and export it in Drafts.",
        ],
      },
      {
        label: "Pause, resume, edit",
        steps: [
          "The switch on the card pauses the automation (Paused) or resumes it (Active).",
          "Edit changes its steps, schedule, or delivery; choose Save changes.",
          "Run history (N) lists recent runs: Succeeded, Failed, or Skipped, how each was started, and how long it took.",
        ],
      },
    ],
    verify: [
      "After saving, the card shows the schedule, the step chain, and Next run in ….",
      "Run now reports that the run saved the result to a new chat (or draft), and Output from this run shows each step.",
      "Open chat shows the delivered conversation, titled with the automation's name and the run time.",
      "Run history lists the run as Succeeded, run now.",
    ],
    troubleshooting: [
      { symptom: "\"No approved models are available yet. An administrator must enable at least one available model before automations can run.\"", fix: "Ask your administrator for access to a model; New automation stays off until then." },
      { symptom: "\"Give the automation a name.\" or \"Every step needs a model or agent.\"", fix: "Type a Name and choose a model or agent for every step." },
      { symptom: "\"Choose a date and time for the one-time run.\"", fix: "Set Run at for a Once schedule." },
      { symptom: "\"Enter a cron expression, for example 0 9 * * 1-5.\"", fix: "Type five fields separated by spaces, and check Next runs." },
      { symptom: "\"Run failed: …\" or Last run failed on the card", fix: "Read the message in Run history. A model or agent may be unavailable; edit the step and run it again." },
      { symptom: "Paused after failures", fix: "After 3 scheduled failures in a row the automation pauses itself. Fix the cause, then turn the switch back on." },
      { symptom: "An agent step does not use its tools", fix: "Tools and MCP servers need a person to approve them, so automations run agent steps without tools." },
    ],
    scenes: [
      {
        title: "Open Automations",
        caption: "Agents › Automations lists your automations. New automation starts one.",
        narration: "Open Agents in the sidebar and switch to Automations. Each card is one automation, with its schedule, its steps, and its last run. Choose New automation.",
        durationSeconds: 12,
        focus: "automationsNew",
      },
      {
        title: "What it does",
        caption: "Name it and write the prompt for the first step.",
        narration: "Under What it does, give it a name you will recognize, and write the prompt the first step works on.",
        durationSeconds: 7,
        focus: "automationWhat",
      },
      {
        title: "Chain the steps",
        caption: "Each step uses a model or agent. Add step passes the result along.",
        narration: "Under Steps, choose a model or one of your agents for step one, with an optional instruction. Choose Add step to pass the result to a second step, here to rewrite it in a friendly tone. Steps run in order.",
        durationSeconds: 15,
        focus: "automationSteps",
      },
      {
        title: "Daily",
        caption: "Daily runs at the time you set. Next runs previews the coming days.",
        narration: "Now choose when it runs. Daily runs every day at the time you set, in the time zone you choose. Next runs previews the coming runs.",
        durationSeconds: 10,
        focus: "automationDaily",
      },
      {
        title: "Once",
        caption: "Once runs a single time at Run at.",
        narration: "Once runs a single time, at the date and time you set in Run at.",
        durationSeconds: 6,
        focus: "automationOnce",
      },
      {
        title: "Custom",
        caption: "Custom takes a cron expression: minute, hour, day, month, weekday.",
        narration: "Custom takes a cron expression with five fields: minute, hour, day of month, month, and day of week. Thirty, seven, star, star, one to five runs at seven thirty on weekdays. Check Next runs before you save.",
        durationSeconds: 16,
        focus: "automationCustom",
      },
      {
        title: "Weekly",
        caption: "Weekly runs on the day and time you pick. This one runs Mondays at 9:00.",
        narration: "Weekly runs on the day and time you pick. This one runs every Monday at nine in the morning.",
        durationSeconds: 7,
        focus: "automationWeekly",
      },
      {
        title: "Where the result goes",
        caption: "Deliver results to: New chat or New draft. Then Save automation.",
        narration: "Under Deliver results to, choose New chat to get each run as a conversation you can follow up on, or New draft for a document. Leave the schedule switch on and choose Save automation.",
        durationSeconds: 13,
        focus: "automationDeliver",
      },
      {
        title: "Saved and scheduled",
        caption: "The card shows the schedule, the two-step chain, and when it runs next.",
        narration: "The automation is saved and scheduled. Its card shows the schedule, the two-step chain, and when it runs next. Test it now rather than waiting for Monday.",
        durationSeconds: 12,
        focus: "automationSaved",
      },
      {
        title: "Run now",
        caption: "Run now runs both steps and saves the result to a new chat. Output from this run shows each step.",
        narration: "Choose Run now. When it finishes, the notice says it ran two steps and saved the result to a new chat, and Output from this run shows what each step produced.",
        durationSeconds: 11,
        focus: "automationRunOutput",
        calloutPlacement: "left-rail",
      },
      {
        title: "The delivered chat",
        caption: "Open chat shows the run as a conversation, titled with the automation and run time.",
        narration: "Choose Open chat. The run arrived as a conversation titled with the automation's name and the run time, ready for follow-up questions.",
        durationSeconds: 11,
        focus: "automationResultChat",
      },
      {
        title: "Run history",
        caption: "Run history lists each run: its result, how it started, and how long it took.",
        narration: "Back on the card, Run history lists recent runs: whether each succeeded, failed, or was skipped, how it was started, how long it took, and a link to its result.",
        durationSeconds: 12,
        focus: "automationHistory",
      },
      {
        title: "Pause and resume",
        caption: "The switch pauses it. Paused automations keep their settings; turn the switch on to resume.",
        narration: "The switch on the card pauses the automation, and the card says Paused. Its settings are kept; turn the switch back on to resume.",
        durationSeconds: 10,
        focus: "automationPaused",
      },
      {
        title: "Deliver a draft instead",
        caption: "New draft asks the last step for a complete document and saves it in Drafts.",
        narration: "To get a document instead, choose New draft. This one runs once, on the first of December. The last step is asked for a complete document, saved as a new draft.",
        durationSeconds: 12,
        focus: "automationDraftTarget",
      },
      {
        title: "The delivered draft",
        caption: "Run now, then Open draft: the result opens in Drafts, ready to edit and export.",
        narration: "Run it now and choose Open draft. The document opens in Drafts, ready to edit, save, and export.",
        durationSeconds: 8,
        focus: "automationResultDraft",
      },
    ],
  },
  {
    id: "organize",
    audioSrc: "training/user/organize.mp3",
    title: "Organize and find your work",
    description: "Create folders and file chats in them, pin, archive and restore, rename chats, and hide your chat list.",
    icon: "organize",
    track: "Organize and personalize",
    outcomes: ["Folder created and a chat filed", "Chat pinned", "Chat archived and restored", "Chat renamed and list hidden"],
    prerequisites: [
      "A few chats in your sidebar.",
      "Folders are kept in this browser: they do not follow you to another browser or device.",
    ],
    setupSteps: [
      "Choose Create chat folder (the folder button beside CHATS), type a Folder name, and choose Create.",
      "Point at a chat, choose its More actions button (…), then Move to folder, and choose the folder.",
      "Check that the chat now sits inside the folder, with the folder's count updated.",
      "To keep a chat at the top, choose … › Pin chat. It moves to Pinned.",
      "To put a chat away, choose … › Archive. Find it later in your account card › Archived chats › View, and choose Restore.",
      "To rename the open chat, choose Rename chat (the pencil beside its title), type the name, and choose Save chat name.",
      "Choose the CHATS heading to hide your chat list; choose it again to show it.",
    ],
    paths: [
      {
        label: "Folders",
        steps: [
          "Folders can hold subfolders, up to four levels: choose Create subfolder in … on a folder.",
          "… › Move to folder › Remove from folder takes a chat out again.",
          "Delete … folder asks first; chats in it stay in Recent.",
        ],
      },
      {
        label: "Archive and delete",
        steps: [
          "Archive keeps the chat and removes it from the sidebar (and unpins it).",
          "Account card › Archived chats › View lists archived chats, with Restore and Permanently delete.",
          "Permanently delete asks first and cannot be undone.",
        ],
      },
      {
        label: "Rename with AI",
        steps: [
          "After the first reply, choose Rename chat with AI beside the title for a suggested name.",
        ],
      },
      {
        label: "See everything",
        steps: [
          "View all chats opens All chats, with Filter chats to search titles.",
          "View all pinned and View all folders appear when you have more than three.",
        ],
      },
    ],
    verify: [
      "The folder shows the filed chat and its count.",
      "The pinned chat appears under Pinned.",
      "An archived chat is listed under Archived chats until you restore it.",
      "With the list hidden, CHATS shows how many chats are tucked away.",
    ],
    troubleshooting: [
      { symptom: "My folders are missing in another browser", fix: "Folders are stored in the browser where you made them. Create them again there; the chats themselves are in your account." },
      { symptom: "\"Chat title cannot be blank.\"", fix: "Type a name before choosing Save chat name, or choose Cancel renaming chat." },
      { symptom: "\"The AI could not rename this chat. Try again.\"", fix: "Try again, or type a name yourself with Rename chat." },
      { symptom: "A chat disappeared from the sidebar", fix: "It may be archived (account card › Archived chats), inside a folder, or hidden with the CHATS heading. Search finds it either way." },
    ],
    scenes: [
      {
        title: "Your sidebar",
        caption: "New chat, Search, Drafts, Agents, and Library at the top; your chats below; Help and your account at the bottom.",
        narration: "The sidebar is where your work lives. At the top: New chat, Search, Drafts, Agents, and Library. Below them, your chats. At the bottom, Help, appearance, and your account card.",
        durationSeconds: 13,
        focus: "sidebarNavigation",
        calloutPlacement: "right-mid",
      },
      {
        title: "Create a folder",
        caption: "The folder button beside CHATS opens Folder name. Type it and choose Create.",
        narration: "To group related chats, choose the folder button beside the Chats heading. Type a name, here Vendor reviews, and choose Create.",
        durationSeconds: 10,
        focus: "organizeFolderNew",
      },
      {
        title: "One menu for each chat",
        caption: "Point at a chat and choose …: Pin chat, Move to folder, or Archive.",
        narration: "Point at any chat and choose its more actions button. The menu offers Pin chat, Move to folder, and Archive.",
        durationSeconds: 9,
        focus: "sidebarRowActions",
      },
      {
        title: "Move it to the folder",
        caption: "Move to folder lists your folders, plus New folder.",
        narration: "Choose Move to folder. Your folders are listed, with New folder at the end. Choose Vendor reviews.",
        durationSeconds: 8,
        focus: "organizeMoveMenu",
      },
      {
        title: "Filed",
        caption: "The chat now sits inside the folder, and the folder's count shows it.",
        narration: "The chat now sits inside the folder, and the folder's count goes up. Folders are kept in this browser, so create them again if you switch browsers.",
        durationSeconds: 11,
        focus: "sidebarFolders",
      },
      {
        title: "Pin what you use most",
        caption: "Pin chat moves a chat to Pinned at the top of your list.",
        narration: "Choose Pin chat to keep a chat at the top of your list, under Pinned.",
        durationSeconds: 6,
        focus: "sidebarPinned",
      },
      {
        title: "Archive, then restore",
        caption: "Archive removes a chat from the sidebar. Account card › Archived chats lists it with Restore.",
        narration: "Archive puts a chat away without deleting it. To find it, open your account card and choose View under Archived chats. Each archived chat offers Restore, and Permanently delete, which asks first.",
        durationSeconds: 14,
        focus: "organizeArchived",
      },
      {
        title: "Rename a chat",
        caption: "Rename chat (the pencil beside the title), type a name, and save.",
        narration: "To rename the open chat, choose the pencil beside its title, type a new name, and save it. The name changes everywhere the chat appears.",
        durationSeconds: 10,
        focus: "organizeRenamed",
      },
      {
        title: "Hide your chat list",
        caption: "Choose CHATS to hide the list. The count shows how many are tucked away.",
        narration: "Choose the Chats heading to hide your whole chat list for a cleaner screen. The heading counts the hidden chats, and a dot appears if any has an unread reply. Choose it again to show them. Search still finds everything.",
        durationSeconds: 15,
        focus: "sidebarChatsHidden",
      },
    ],
  },
  {
    id: "search-and-commands",
    audioSrc: "training/user/search-and-commands.mp3",
    title: "Search, commands, and workspace links",
    description: "Search every chat, draft, agent, and document you can access, reopen recent results, and run commands from the keyboard.",
    icon: "organize",
    track: "Organize and personalize",
    outcomes: ["Past work found and reopened", "Recent results reused", "Command run from the palette"],
    prerequisites: [
      "Some saved work to find. Archived chats are included.",
    ],
    setupSteps: [
      "Choose Search in the sidebar, or press Ctrl+K (⌘K on a Mac).",
      "Type words from a title or a message.",
      "Read the results, grouped by kind: Previous chats, Documents & knowledge, Agents, Automations, Drafts, and more.",
      "Use the arrow keys and Enter, or choose a result, to open it.",
      "Press Ctrl+K again. With an empty box, Recent lists what you opened from Search.",
      "Type > to list commands, add a word to narrow them (for example >dark), and press Enter to run one.",
    ],
    paths: [
      {
        label: "Act on a chat from Search",
        steps: [
          "Point at a chat result for its buttons: add to a folder, pin, and archive or restore.",
          "Archived chats are marked Archived conversation and can be restored from here.",
        ],
      },
      {
        label: "Commands",
        steps: [
          "New chat; Go to Chat, Drafts, Agents, Automations, Knowledge, or Tools.",
          "Switch to dark mode or Switch to light mode; Open Help; Sign out.",
          "Install app appears on phones and tablets.",
        ],
      },
      {
        label: "Workspace links",
        steps: [
          "Each screen has its own address (for example /drafts or /chat/ followed by the chat's id).",
          "Browser Back and Forward move between the screens you visited.",
          "A link never shares private content: whoever opens it must sign in and have access.",
        ],
      },
    ],
    verify: [
      "Results list the matching chats and other work.",
      "Choosing a result opens it.",
      "A command such as >dark changes the workspace at once.",
    ],
    troubleshooting: [
      { symptom: "\"Indexing your workspace… results may be incomplete until it finishes.\"", fix: "Search is still catching up. Try again in a moment." },
      { symptom: "\"No chats or workspace items found for …\"", fix: "Try fewer or different words, such as a word from the reply rather than the title." },
      { symptom: "\"No commands match …\"", fix: "Type > alone to see every command." },
      { symptom: "\"Search failed.\"", fix: "Check your connection and search again." },
    ],
    scenes: [
      {
        title: "Open Search",
        caption: "Search, or Ctrl/⌘ K, opens Search past work.",
        narration: "Choose Search in the sidebar, or press Control K, Command K on a Mac, from anywhere. Search past work opens with commands below the search box.",
        durationSeconds: 11,
        focus: "searchPalette",
        calloutPlacement: "left-rail",
      },
      {
        title: "Find past work",
        caption: "Type a word. Results are grouped: Previous chats, Automations, Drafts, and more.",
        narration: "Type a word from a title or a message. Here, vendor. Results are grouped by kind: previous chats first, including archived ones, then automations, drafts, agents, and documents you can access.",
        durationSeconds: 14,
        focus: "searchResults",
        calloutPlacement: "left-rail",
      },
      {
        title: "Open a result",
        caption: "Choose a result, or use the arrow keys and Enter, to open it.",
        narration: "Choose a result, or use the arrow keys and Enter. The chat opens exactly where you left it.",
        durationSeconds: 8,
        focus: "searchOpened",
      },
      {
        title: "Recent",
        caption: "Open Search again with an empty box: Recent lists what you opened from Search.",
        narration: "Open Search again with an empty box, and Recent lists what you opened from Search in this browser, so you can jump back.",
        durationSeconds: 9,
        focus: "searchRecent",
        calloutPlacement: "left-rail",
      },
      {
        title: "Run a command",
        caption: "Type > for commands: go to a screen, switch appearance, open Help, or sign out.",
        narration: "Type a greater-than sign to list commands: go to a screen, switch to dark or light mode, open Help, or sign out. Add a word to narrow the list. In the chat message box, the same symbol picks automations instead.",
        durationSeconds: 15,
        focus: "searchCommands",
        calloutPlacement: "left-rail",
      },
      {
        title: "The command runs at once",
        caption: ">dark and Enter switched the workspace to dark mode.",
        narration: "Here, greater-than dark and Enter switched the workspace to dark mode straight away.",
        durationSeconds: 7,
        focus: "searchCommandDone",
      },
      {
        title: "Workspace links",
        caption: "Each screen has its own address. Back and Forward revisit them; links never grant access.",
        narration: "Every screen has its own address, so browser Back and Forward move between the screens you visited, and you can keep a link to a draft or a chat. A link never shares private content: whoever opens it must sign in and have access.",
        durationSeconds: 16,
        focus: "sidebarNavigation",
        calloutPlacement: "right-mid",
      },
    ],
  },
  {
    id: "personalization-memory",
    audioSrc: "training/user/personalization-memory.mp3",
    title: "Personalization memory",
    description: "Save preferences in plain English, recall them in later sessions, and stay in control.",
    icon: "memory",
    track: "Organize and personalize",
    outcomes: ["Memory added and pinned", "Memory saved by asking in chat", "Memory recalled in a new chat", "Sensitive content refused"],
    prerequisites: [
      "Memory must be allowed by your platform and your organization. If it is off, the Personalization memory row says why.",
      "Only you can read your memories. Administrators see how many you have and can delete them, but never read them.",
    ],
    setupSteps: [
      "Select your account card at the bottom of the sidebar and choose Personalization memory.",
      "Check Use memory in my chats (applies saved memories to answers) and Learn from my conversations (lets the assistant notice lasting preferences itself).",
      "Type a memory in Add something you want remembered, choose its type (for example Preferences), and choose Add.",
      "Choose Pin on a memory that should always apply. Choose its text to correct the wording.",
      "In any chat, say Remember that … followed by the preference; it is saved for later chats.",
      "In a new chat, ask a question the memory answers, and check that the reply uses it.",
    ],
    paths: [
      {
        label: "Forget",
        steps: [
          "Personalization memory › Forget on one memory removes it.",
          "Forget everything asks Forget all …? This cannot be undone. before removing them all.",
        ],
      },
      {
        label: "Turn memory off",
        steps: [
          "Turn off Use memory in my chats to stop applying memories. Saved memories stay private and manageable.",
          "Turn off Learn from my conversations to save only what you add or ask it to remember.",
        ],
      },
    ],
    verify: [
      "The memory is listed in Personalization memory under its type, with Pin on if you pinned it.",
      "After Remember that … in chat, the sentence appears in the list.",
      "A later chat's reply uses it without being told again.",
    ],
    troubleshooting: [
      { symptom: "\"Memories cannot contain credentials, keys, or sensitive identifiers.\"", fix: "Passwords, keys, tokens, one-time codes, and card or account numbers are never stored. Keep them out of memory." },
      { symptom: "\"Write a little more so the memory is useful later.\"", fix: "Write a full phrase of at least a few words." },
      { symptom: "\"Pinned memories already fill your memory limit. Unpin or forget one before saving more.\"", fix: "Unpin or forget a memory, then add the new one." },
      { symptom: "\"That memory kind is disabled by your organization's policy.\"", fix: "Choose another type, or ask your administrator." },
      { symptom: "The row says memory is turned off", fix: "\"Memory is turned off for this platform.\", \"… for your organization.\", or your groups' policy: ask your administrator. \"You turned memory off for your account.\": turn it back on here." },
      { symptom: "No note under the reply says a memory was saved or used", fix: "The reply does not currently show that note. Check Personalization memory to confirm the memory was saved." },
    ],
    scenes: [
      {
        title: "Open Personalization memory",
        caption: "Account card › Personalization memory: see and edit what the assistant remembers about you.",
        narration: "To see what the assistant remembers, select your account card at the bottom of the sidebar and choose Personalization memory.",
        durationSeconds: 9,
        focus: "memoryAccountEntry",
        calloutPlacement: "left-rail",
      },
      {
        title: "Choose how memory works",
        caption: "Use memory applies saved memories; Learn from my conversations lets it notice preferences itself.",
        narration: "Use memory in my chats applies your saved memories to answers. Learn from my conversations lets the assistant notice lasting preferences on its own. Only you can read this list.",
        durationSeconds: 14,
        focus: "memorySettings",
        calloutPlacement: "left-rail",
      },
      {
        title: "Add and pin a memory",
        caption: "Type it, choose a type, and Add. Pin keeps it applied; choose the text to correct it.",
        narration: "Type something you want remembered, choose its type, and choose Add. It appears under that type. Pin keeps it applied, choose its text to correct the wording, and the bin forgets it.",
        durationSeconds: 12,
        focus: "memoryAddAndReview",
        calloutPlacement: "left-rail",
      },
      {
        title: "Sensitive content is refused",
        caption: "Passwords, keys, codes, and account numbers are never stored.",
        narration: "Memory protects you from yourself. Anything that looks like a password, a key, a one-time code, or an account number is refused with: Memories cannot contain credentials, keys, or sensitive identifiers.",
        durationSeconds: 15,
        focus: "memoryRejected",
        calloutPlacement: "left-rail",
      },
      {
        title: "Or just say it in chat",
        caption: "Remember that … in any chat saves the preference.",
        narration: "You can also save a memory in plain English. In any chat, say: remember that, followed by the preference. Here, I review synthetic vendors every Monday morning.",
        durationSeconds: 12,
        focus: "memorySavedChat",
      },
      {
        title: "Check it was saved",
        caption: "The sentence now appears in Personalization memory.",
        narration: "Open Personalization memory to check: the sentence is now listed. The reply itself does not show a saved note, so this list is where to confirm it.",
        durationSeconds: 11,
        focus: "memorySavedList",
        calloutPlacement: "left-rail",
      },
      {
        title: "Recalled in a new chat",
        caption: "A new chat's reply uses both memories without being told again.",
        narration: "In a new chat, ask something your memories answer. The reply knows you review vendors on Mondays and like a one-line answer first, without being told again. Memory follows your account into later chats and sign-ins.",
        durationSeconds: 15,
        focus: "memoryRecall",
      },
    ],
  },
  {
    id: "account-mobile-help",
    audioSrc: "training/user/account-mobile-help.mp3",
    title: "Personalize, use mobile, and get help",
    description: "Edit your profile, choose light or dark mode and a theme schedule, install the app on a phone, tablet, or computer, and report a problem.",
    icon: "organize",
    track: "Organize and personalize",
    outcomes: ["Profile saved", "Appearance and theme schedule set", "App installed on your device", "Problem report sent"],
    prerequisites: [
      "For installing: Safari on iPhone or iPad, Chrome on Android, or Chrome or Edge on a computer.",
      "For a report: what you did, what you expected, and what happened; optionally a screenshot (PNG, JPEG, GIF, or WebP, up to 10 MB) with no passwords or personal data.",
    ],
    setupSteps: [
      "Select your account card at the bottom of the sidebar, then the pencil beside your name (Edit account profile).",
      "Change the fields you need, such as Phone number or Firm or organization, and choose Save profile. Profile saved confirms it.",
      "Choose the moon button beside Help for Dark mode, or the sun for Light mode.",
      "Choose the clock button (Theme schedule), turn on Switch automatically, set Light mode at and Dark mode at to different times, and choose Save schedule.",
      "Choose Help at the bottom of the sidebar for the walkthroughs and the printable User guide (PDF).",
      "To report a problem, choose Report a problem in Help, fill in Subject and Message, optionally add a Screenshot, and choose Send report.",
      "Wait for Report sent: an administrator can now review it in Analytics.",
    ],
    paths: [
      {
        label: "iPhone or iPad (Safari)",
        steps: [
          "Open your workspace address in Safari and sign in. Add Aperture Chat to your home screen opens (or choose Install app in the menu).",
          "Tap the Share button in the browser toolbar.",
          "Scroll the share sheet and choose Add to Home Screen.",
          "Tap Add. Aperture Chat appears on your home screen and opens full screen.",
        ],
      },
      {
        label: "Android (Chrome)",
        steps: [
          "Open your workspace address in Chrome and sign in. The install card opens (or choose Install app in the menu).",
          "If it offers Install app, choose it and confirm in the phone's install sheet.",
          "Otherwise open the browser's ⋮ menu and choose Add to Home screen or Install app, then confirm.",
        ],
      },
      {
        label: "Computer (Chrome or Edge)",
        steps: [
          "Aperture Chat shows no install card on computers.",
          "Use the browser's own install control: the install icon at the right of the address bar, or the browser menu › Install (Chrome: Cast, save, and share › Install page as app; Edge: Apps › Install this site as an app).",
          "Confirm Install. The app opens in its own window and appears with your other apps.",
        ],
      },
      {
        label: "On a narrow screen",
        steps: [
          "Choose Open menu (top left) to reach navigation, chats, Help, Install app, and your account.",
          "Choose where to go; the menu closes. The same permissions apply as on a computer.",
        ],
      },
    ],
    verify: [
      "Profile saved appears, and your account card shows the new details.",
      "The workspace switches between light and dark at the scheduled times on this device.",
      "The installed app opens from your home screen or app list.",
      "Report sent confirms an administrator can review your report.",
    ],
    troubleshooting: [
      { symptom: "\"Use a complete http(s) website URL.\"", fix: "Enter the full website address, including https://." },
      { symptom: "\"Choose a profile photo that is 5 MB or smaller.\"", fix: "Use a smaller image." },
      { symptom: "\"Choose two different times.\"", fix: "Light mode at and Dark mode at must differ." },
      { symptom: "\"Add both a subject and a message.\"", fix: "Fill in both fields before Send report." },
      { symptom: "\"Choose a screenshot that is 10 MB or smaller.\" or \"Screenshot attachments must be PNG, JPEG, GIF, or WebP images.\"", fix: "Attach a smaller PNG, JPEG, GIF, or WebP image." },
      { symptom: "\"The issue report could not be sent.\"", fix: "Your report was not received. Check your connection and send it again." },
    ],
    scenes: [
      {
        title: "Edit your profile",
        caption: "Account card › Edit account profile: change the details, then Save profile.",
        narration: "Select your account card, then the pencil beside your name. Update the details people see in user directories, such as your phone number and organization, and choose Save profile. Cancel leaves everything as it was.",
        durationSeconds: 15,
        focus: "profileEditor",
        calloutPlacement: "left-rail",
      },
      {
        title: "Profile saved",
        caption: "Profile saved confirms the change; your card shows the new details.",
        narration: "Profile saved confirms the change, and your account card shows the new details.",
        durationSeconds: 7,
        focus: "profileSaved",
        calloutPlacement: "left-rail",
      },
      {
        title: "Light or dark",
        caption: "The moon beside Help switches to dark mode; the sun switches back.",
        narration: "Beside Help, the moon button switches the workspace to dark mode, and the sun switches it back.",
        durationSeconds: 7,
        focus: "appearanceControl",
      },
      {
        title: "Schedule light and dark",
        caption: "Theme schedule: Switch automatically, two different times, then Save schedule.",
        narration: "The clock button next to it opens Theme schedule. Turn on Switch automatically, choose when light mode and dark mode start, and choose Save schedule. It uses this device's local time and stays in this browser.",
        durationSeconds: 15,
        focus: "themeSchedule",
      },
      {
        title: "On a phone",
        caption: "On a narrow screen, Open menu reaches navigation, chats, Help, Install app, and your account.",
        narration: "On a phone, the sidebar folds away. Choose Open menu at the top left to reach navigation, your chats, Help, Install app, and your account.",
        durationSeconds: 11,
        focus: "mobileNavigation",
        captionPlacement: "bottom",
        calloutPlacement: "right-mid",
      },
      {
        title: "Install on iPhone",
        caption: "Safari: Share, Add to Home Screen, then Add.",
        narration: "On iPhone, Install app shows the steps for Safari: tap the Share button, choose Add to Home Screen, then tap Add. Aperture Chat then opens full screen from your home screen.",
        durationSeconds: 13,
        focus: "mobileInstall",
        calloutPlacement: "right-mid",
      },
      {
        title: "Install on iPad",
        caption: "iPad shows the same Safari steps.",
        narration: "On an iPad, the card shows the same Safari steps, here in a landscape window.",
        durationSeconds: 7,
        focus: "installIpad",
        calloutPlacement: "right-mid",
      },
      {
        title: "Install on Android",
        caption: "Android: Install app when Chrome offers it, or ⋮ menu › Add to Home screen.",
        narration: "On Android, choose Install app when Chrome offers it. Otherwise, as here, follow the card: open the browser's menu, choose Add to Home screen or Install app, and confirm.",
        durationSeconds: 13,
        focus: "installAndroid",
        calloutPlacement: "right-mid",
      },
      {
        title: "Install on a computer",
        caption: "Chrome or Edge: use the browser's install control. Aperture Chat shows no card on computers.",
        narration: "On a computer, Aperture Chat shows no install card. In Chrome or Edge, use the browser's own install control, at the right of the address bar or in the browser menu, and confirm. The app then opens in its own window.",
        durationSeconds: 16,
        card: {
          label: "In your browser",
          where: "Chrome or Edge on a computer",
          steps: [
            "Open your workspace address and sign in.",
            "Choose the install icon at the right of the address bar.",
            "Or open the browser menu: Chrome › Cast, save, and share › Install page as app; Edge › Apps › Install this site as an app.",
            "Choose Install. The app opens in its own window.",
          ],
        },
      },
      {
        title: "Help and the user guide",
        caption: "Help: the walkthroughs, the printable User guide (PDF), and Report a problem.",
        narration: "Choose Help at the bottom of the sidebar. It holds these walkthroughs, grouped by topic, the printable user guide as a P D F, and Report a problem.",
        durationSeconds: 11,
        focus: "helpLibrary",
        calloutPlacement: "left-rail",
      },
      {
        title: "Report a problem",
        caption: "Subject, Message with the steps, and an optional screenshot. Then Send report.",
        narration: "Choose Report a problem. Give it a short subject, and in the message say what you did, what you expected, and what happened. You may attach a screenshot, without passwords or personal data. Choose Send report.",
        durationSeconds: 14,
        focus: "helpReportForm",
        calloutPlacement: "left-rail",
      },
      {
        title: "Report sent",
        caption: "Report sent confirms an administrator can review it in Analytics.",
        narration: "Report sent confirms it arrived: an administrator can now review it in Analytics. If you see an error instead, the report was not received, so send it again.",
        durationSeconds: 12,
        focus: "helpReportReceived",
        calloutPlacement: "left-rail",
      },
    ],
  },
];

const GUIDE_ICONS = {
  chat: MessageSquare,
  trace: Activity,
  commands: Command,
  attach: Paperclip,
  dictation: Mic,
  send: Send,
  session: Info,
  drafts: FileText,
  deck: Presentation,
  agents: Bot,
  knowledge: BookOpen,
  tools: Wrench,
  automation: CalendarClock,
  preview: Eye,
  organize: FolderPlus,
  memory: Brain,
  privacy: Lock,
} satisfies Record<UserGuideIcon, typeof MessageSquare>;

const USER_DECK: TrainingDeck = {
  badge: "User guide",
  regions: USER_FOCUS_REGIONS,
  videos: USER_TRAINING_VIDEOS.filter((video) => video.id !== "access-and-sign-in"),
  icons: GUIDE_ICONS,
  pdf: {
    href: "docs/aperture-user-guide.pdf",
    title: "User guide (PDF)",
    description: "Every topic in this playlist as a printable step-by-step guide — nothing assumed.",
    tooltip: "Download the step-by-step user guide to keep, print, or share",
  },
};

export function AccessGuideVideo({ onClose }: { onClose: () => void }) {
  const video = USER_TRAINING_VIDEOS.find((entry) => entry.id === "access-and-sign-in")!;
  return <TrainingAccessVideo video={video} deck={USER_DECK} onClose={onClose} />;
}

export function UserGuidePlaylist({ brandName }: { brandName?: string | null }) {
  return (
    <TrainingGuidePlaylist
      deck={USER_DECK}
      brandName={brandName}
      introTagline="Real platform screens with callouts, captions, and transcripts — from your first message and cross-session memory to slide decks, diagrams, search, and scheduled automations."
    />
  );
}
