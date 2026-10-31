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
 * user by the walkthrough modules in apps/web/scripts/walkthroughs/ (run with
 * apps/web/scripts/capture-walkthroughs.cjs; docs/TRAINING.md documents the pipeline). */

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
  | "draftFormatRail"
  | "draftTraceRunning"
  | "draftTraceDone"
  | "draftsPdfExported"
  | "draftsPrint"
  | "draftPageNavigator"
  | "draftTransferMenu"
  | "draftsTransferred"
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
  | "accountOverview"
  | "accountUsage"
  | "apiAccessCreate"
  | "apiAccessActive"
  | "apiAccessRotate"
  | "apiAccessRevoke"
  | "apiAccessRevoked"
  | "accountArchived"
  | "accountArchivedDelete"
  | "accountWorkspace"
  | "installIpad"
  | "installAndroid"
  | "privacyFooter"
  | "privacyPrompt"
  | "privacyReply"
  | "privacyRatingNote"
  | "privacyOutput"
  | "reportHelpRows"
  | "reportKind"
  | "reportFields"
  | "reportScreenshot"
  | "reportSent"
  | "reportTracker"
  | "reportHelpDot"
  | "reportUnread"
  | "reportReply"
  | "reportReplied"
  | "reportClosed"
  | "reportReopen"
  | "reportReopened"
  | "reportIdea"
  | "reportSecurity"
  | "reportAll"
  | "handoffCard"
  | "handoffEditRequest"
  | "handoffContinued"
  | "handoffWriting"
  | "handoffWritten"
  | "handoffDeckCard"
  | "handoffDeckBuilt"
  | "handoffSheetCard"
  | "handoffSheetBuilt"
  | "deckAddPanel"
  | "deckSlideAdded"
  | "deckChangeLayout"
  | "deckPicturePanel"
  | "deckPictureAdded"
  | "deckWebImages"
  | "deckTextToolbar"
  | "deckTextColors"
  | "deckTextFit"
  | "deckAiReview"
  | "deckAiText"
  | "deckFitCheck"
  | "sheetFixApplied"
  | "sheetFixPreview"
  | "sheetCheckTotal"
  | "sheetVersionRestored"
  | "sheetVersions"
  | "sheetRailUpdate"
  | "sheetUndo"
  | "sheetExplain"
  | "sheetAskTablePreview"
  | "sheetAskCellApplied"
  | "sheetAskCellPreview"
  | "sheetAskOpen"
  | "sheetCheckSum"
  | "sheetCheckFormula"
  | "sheetBuiltTrace"
  | "sheetBuiltGrid"
  | "sheetWorking"
  | "sheetRequest"
  | "sheetSuggestions"
  | "sheetFormatRail"
  | "sheetCompare"
  | "sheetReopened"
  | "sheetExportNotes"
  | "sheetExportPanel"
  | "sheetFrozenHeader"
  | "sheetFilterApplied"
  | "sheetFilterMenu"
  | "sheetValidationNotice"
  | "sheetValidationList"
  | "sheetValidationPanel"
  | "sheetDataMenu"
  | "sheetConditional"
  | "sheetChartPlaced"
  | "sheetChartPanel"
  | "sheetPivotResult"
  | "sheetPivotPanel"
  | "sheetInsertMenu"
  | "sheetStyleGallery"
  | "sheetNamedTotal"
  | "sheetStatusSum"
  | "sheetFormulaTyping"
  | "sheetTableHeader"
  | "sheetTablePanel"
  | "sheetFormatMenu"
  | "sheetDateColumn"
  | "sheetOpenMenu"
  | "sheetTemplateTabs"
  | "sheetTemplates"
  | "deckThemes"
  | "deckThemesMore"
  | "deckThemeSorter"
  | "deckAddHighlights"
  | "deckStatement"
  | "deckBigNumber"
  | "deckPictureBullets"
  | "historySpreadsheet"
  | "historyVersionsCleared"
  | "draftSaveFailed"
  | "knowledgeApiLocked"
  | "toolsAddLocked"
  | "wordOpened"
  | "wordOpenedEnd"
  | "wordAskAi"
  | "wordAiReview"
  | "wordAiApplied"
  | "wordSaved"
  | "wordExported"
  | "pdfOpened"
  | "wordTemplateUploaded"
  | "templatesPanel"
  | "templatePlaced"
  | "templateRequest"
  | "templateDrafted"
  | "layoutRequest"
  | "layoutApplied"
  | "templateExisting"
  | "mlaApplied"
  | "historyLocalChanges"
  | "agentsHermesLocked"
  | "traceRunningFolded"
  | "transferMenu"
  | "chatTransferredDeck"
  | "traceKnowledge"
  | "codeTrace"
  | "codeBlock"
  | "codeDownload"
  | "codeEditing"
  | "codeSaved"
  | "codeAskAi"
  | "codeAiMenu"
  | "canvasReply"
  | "canvasPreview"
  | "canvasCode"
  | "canvasEdited"
  | "canvasExpanded"
  | "canvasTab"
  | "tableReply"
  | "tableEditing"
  | "tableRowAdded"
  | "tableTransfer"
  | "tableSheet"
  | "diagramStructure"
  | "diagramTheme"
  | "diagramConnectors"
  | "diagramDragged"
  | "diagramCardColor"
  | "diagramArrow"
  | "diagramPng"
  | "knowledgeProperties"
  | "knowledgeLookup"
  | "knowledgeReading"
  | "knowledgeLiveReply"
  | "knowledgeLiveSource"
  | "knowledgeWebRow"
  | "agentTrace"
  | "sourcesQuestion"
  | "sourcesTrace"
  | "sourcesReply"
  | "sourcesPanel"
  | "sourcesRow"
  | "sourcesMark"
  | "sourcesCallout"
  | "sourcesControls"
  | "sourcesBack"
  | "sourcesDownload"
  | "sourcesWord"
  | "sourcesInline"
  | "sourcesInlineOpen"
  | "sourcesLibrary"
  | "sourcesPreview"
  | "sourcesNone"
  | "sourcesOldText"
  | "traceFlag"
  | "diagramCardSwatches"
  | "codeAiReview"
  | "codeAiRefined"
  | "codeAiApplied";

export const USER_FOCUS_REGIONS: Record<UserFocus, FocusRegion> = {
  // Captured and measured by the current training refresh pipeline.
  modelFavorites: { frame: "training/user/models-starred.png", rect: { x: 857, y: 61, w: 252, h: 55 } },
  modelAccessOverview: { frame: "training/user/models-explainer.png", rect: { x: 249, y: 82, w: 687, h: 657 } },
  modelAccessPending: { frame: "training/user/models-requested.png", rect: { x: 262, y: 611, w: 661, h: 115 } },
  searchCommands: { frame: "training/user/search-commands.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  searchRecent: { frame: "training/user/search-recent.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  draftSaveState: { frame: "training/user/drafts-saved.png", rect: { x: 810, y: 72, w: 355, h: 157 } },
  draftHistory: { frame: "training/user/history-open.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  draftHistoryPreview: { frame: "training/user/draft-history.png", rect: { x: 433, y: 275, w: 306, h: 191 } },
  unsyncedWork: { frame: "training/user/unsynced-work.png", rect: { x: 309, y: 116, w: 567, h: 300 } },
  themeSchedule: { frame: "training/user/theme-schedule-set.png", rect: { x: 359, y: 257, w: 467, h: 340 } },
  securitySignIn: { frame: "training/user/security-sign-in-code.png", rect: { x: 56, y: 132, w: 495, h: 591 } },
  homeComposer: { frame: "training/user/chat-home.png", rect: { x: 292, y: 307, w: 827, h: 199 } },
  chatTyped: { frame: "training/user/chat-typed.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  modelSelector: { frame: "training/user/chat-typed.png", rect: { x: 923, y: 10, w: 193, h: 45 } },
  toolsChip: { frame: "training/user/send-tools-chip.png", rect: { x: 349, y: 479, w: 144, h: 39 } },
  // The folded line above a finished reply: Worked for, the time, and the steps.
  traceCollapsed: { frame: "training/user/chat-edited.png", rect: { x: 315, y: 250, w: 686, h: 35 } },
  traceExpanded: { frame: "training/user/trace-expanded.png", rect: { x: 315, y: 250, w: 686, h: 229 } },
  responseActions: { frame: "training/user/chat-copied.png", rect: { x: 315, y: 472, w: 660, h: 37 } },
  transferDraft: { frame: "training/user/chat-edited.png", rect: { x: 980, y: 468, w: 174, h: 45 } },
  slashMenu: { frame: "training/user/symbols-slash.png", rect: { x: 258, y: 365, w: 895, h: 239 } },
  agentMenu: { frame: "training/user/symbols-at.png", rect: { x: 258, y: 467, w: 895, h: 137 } },
  hashMenu: { frame: "training/user/symbols-hash.png", rect: { x: 258, y: 258, w: 895, h: 346 } },
  skillMenu: { frame: "training/user/symbols-dollar.png", rect: { x: 258, y: 365, w: 895, h: 239 } },
  automationMenu: { frame: "training/user/symbols-gt.png", rect: { x: 258, y: 372, w: 895, h: 189 } },
  sessionShortcuts: { frame: "training/user/session-shortcuts.png", rect: { x: 881, y: 550, w: 289, h: 305 } },
  attachUpload: { frame: "training/user/attach-menu.png", rect: { x: 317, y: 169, w: 247, h: 45 } },
  sendKnowledge: { frame: "training/user/send-knowledge.png", rect: { x: 667, y: 314, w: 441, h: 104 } },
  sendWeb: { frame: "training/user/send-menu.png", rect: { x: 667, y: 386, w: 441, h: 50 } },
  sendAgent: { frame: "training/user/send-agent.png", rect: { x: 667, y: 384, w: 441, h: 142 } },
  sendReasoning: { frame: "training/user/send-menu.png", rect: { x: 667, y: 483, w: 441, h: 42 } },
  sendStreaming: { frame: "training/user/send-menu.png", rect: { x: 667, y: 519, w: 441, h: 32 } },
  sessionSummary: { frame: "training/user/session-summary.png", rect: { x: 881, y: 0, w: 289, h: 322 } },
  contextWindow: { frame: "training/user/session-context.png", rect: { x: 881, y: 105, w: 289, h: 236 } },
  imageReply: { frame: "training/user/chat-images.png", rect: { x: 316, y: 342, w: 516, h: 513 } },
  imageDownload: { frame: "training/user/chat-images-download.png", rect: { x: 715, y: 476, w: 106, h: 34 } },
  mermaidFigure: { frame: "training/user/diagram-rendered.png", rect: { x: 315, y: 334, w: 839, h: 165 } },
  searchPalette: { frame: "training/user/search-empty.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  draftComposer: { frame: "training/user/drafts-blank.png", rect: { x: 91, y: 686, w: 349, h: 150 } },
  draftModel: { frame: "training/user/drafts-blank.png", rect: { x: 486, y: 72, w: 327, h: 42 } },
  draftToolbar: { frame: "training/user/drafts-generated.png", rect: { x: 453, y: 168, w: 732, h: 84 } },
  draftAiEdit: { frame: "training/user/drafts-ai-review.png", rect: { x: 548, y: 111, w: 467, h: 363 } },
  draftSlashMenu: { frame: "training/user/draft-slash.png", rect: { x: 552, y: 194, w: 299, h: 387 } },
  draftStatusBar: { frame: "training/user/draft-find.png", rect: { x: 453, y: 818, w: 732, h: 37 } },
  draftOpenFromDevice: { frame: "training/user/drafts-open-menu.png", rect: { x: 111, y: 413, w: 294, h: 106 } },
  draftOpenedDocument: { frame: "training/user/drafts-opened.png", rect: { x: 500, y: 270, w: 641, h: 554 } },
  draftSettings: { frame: "training/user/draft-settings.png", rect: { x: 100, y: 395, w: 331, h: 274 } },
  deckLayoutMenu: { frame: "training/user/deck-layouts.png", rect: { x: 657, y: 268, w: 496, h: 157 } },
  deckTemplatesDrawer: { frame: "training/user/deck-templates.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  deckBrandStage: { frame: "training/user/deck-editor-brand.png", rect: { x: 657, y: 468, w: 496, h: 283 } },
  deckBackgroundMenu: { frame: "training/user/deck-background.png", rect: { x: 817, y: 229, w: 231, h: 181 } },
  deckNotes: { frame: "training/user/deck-notes.png", rect: { x: 657, y: 718, w: 496, h: 118 } },
  deckPresent: { frame: "training/user/deck-presenter.png", rect: { x: 772, y: 73, w: 392, h: 761 } },
  deckExportMenu: { frame: "training/user/deck-export-menu.png", rect: { x: 772, y: 162, w: 387, h: 262 } },
  agentsNew: { frame: "training/user/agents-page.png", rect: { x: 1025, y: 176, w: 126, h: 45 } },
  knowledgeAdd: { frame: "training/user/knowledge-page.png", rect: { x: 957, y: 176, w: 194, h: 45 } },
  toolsHeader: { frame: "training/user/tools-connections.png", rect: { x: 260, y: 154, w: 318, h: 47 } },
  toolsRows: { frame: "training/user/tools-connections.png", rect: { x: 260, y: 328, w: 891, h: 527 } },
  automationsNew: { frame: "training/user/automations-page.png", rect: { x: 989, y: 176, w: 162, h: 45 } },
  sidebarFolders: { frame: "training/user/organize-filed.png", rect: { x: 9, y: 336, w: 194, h: 117 } },
  sidebarPinned: { frame: "training/user/organize-pinned.png", rect: { x: 9, y: 447, w: 194, h: 105 } },
  sidebarPreview: { frame: "training/user/preview-sidebar.png", rect: { x: 235, y: 237, w: 486, h: 610 } },
  sidebarRowActions: { frame: "training/user/organize-row-menu.png", rect: { x: 5, y: 627, w: 196, h: 149 } },
  sidebarChatsHidden: { frame: "training/user/organize-hidden.png", rect: { x: 9, y: 336, w: 194, h: 34 } },
  sidebarNavigation: { frame: "training/user/organize-sidebar.png", rect: { x: 14, y: 85, w: 202, h: 222 } },
  memoryAccountEntry: { frame: "training/user/memory-entry.png", rect: { x: 776, y: 270, w: 384, h: 76 } },
  memorySettings: { frame: "training/user/memory-settings.png", rect: { x: 280, y: 236, w: 625, h: 99 } },
  memoryAddAndReview: { frame: "training/user/memory-added.png", rect: { x: 280, y: 311, w: 625, h: 351 } },
  memoryRecall: { frame: "training/user/memory-recalled.png", rect: { x: 257, y: 168, w: 897, h: 401 } },
  accessRequestEntry: { frame: "training/user/access-sign-in-page.png", rect: { x: 101, y: 714, w: 405, h: 135 } },
  accessRequestForm: { frame: "training/user/access-request-filled.png", rect: { x: 101, y: 368, w: 405, h: 298 } },
  accessRequestReceived: { frame: "training/user/access-request-sent.png", rect: { x: 101, y: 335, w: 405, h: 415 } },
  accessSignInMethod: { frame: "training/user/access-sign-in-page.png", rect: { x: 101, y: 339, w: 405, h: 59 } },
  accessOwnPassword: { frame: "training/user/access-set-password.png", rect: { x: 345, y: 165, w: 495, h: 525 } },
  accessWelcome: { frame: "training/user/access-first-welcome.png", rect: { x: 258, y: 21, w: 895, h: 259 } },
  securityOverview: { frame: "training/user/security-overview.png", rect: { x: 776, y: 339, w: 384, h: 141 } },
  securityStart: { frame: "training/user/security-start.png", rect: { x: 788, y: 396, w: 360, h: 189 } },
  securityVerify: { frame: "training/user/account-authenticator-verify.png", rect: { x: 793, y: 741.578, w: 350, h: 100 } },
  securityRecovery: { frame: "training/user/account-recovery-save.png", rect: { x: 793, y: 309.375, w: 350, h: 532.188 } },
  securityReplace: { frame: "training/user/security-replace.png", rect: { x: 788, y: 335, w: 360, h: 256 } },
  securityPassword: { frame: "training/user/security-password-form.png", rect: { x: 776, y: 332, w: 384, h: 263 } },
  profileEditor: { frame: "training/user/account-profile-edit.png", rect: { x: 788, y: 98, w: 360, h: 582 } },
  appearanceControl: { frame: "training/user/appearance-dark.png", rect: { x: 9, y: 731, w: 207, h: 40 } },
  composerShortcuts: { frame: "training/user/send-resources.png", rect: { x: 656, y: 55, w: 463, h: 745 } },
  mobileNavigation: { frame: "training/user/mobile-navigation.png", rect: { x: 394.959, y: 0, w: 303.91, h: 855 }, fit: "contain" },
  mobileInstall: { frame: "training/user/mobile-install-ios.png", rect: { x: 415.219, y: 245.154, w: 354.562, h: 363.679 }, fit: "contain" },
  helpLibrary: { frame: "training/user/help-drawer.png", rect: { x: 760, y: 9, w: 416, h: 837 } },
  accessPasswordForm: { frame: "training/user/access-password-method.png", rect: { x: 101, y: 317, w: 405, h: 360 } },
  accessWrongPassword: { frame: "training/user/access-wrong-password.png", rect: { x: 101, y: 317, w: 405, h: 416 } },
  accessTrouble: { frame: "training/user/access-trouble.png", rect: { x: 101, y: 650, w: 405, h: 155 } },
  accessSsoForm: { frame: "training/user/access-sso-email.png", rect: { x: 101, y: 339, w: 405, h: 354 } },
  accessSsoProvider: { frame: "training/user/access-sso-idp.png", rect: { x: 387, y: 368, w: 411, h: 227 } },
  accessSsoWelcome: { frame: "training/user/access-sso-welcome.png", rect: { x: 258, y: 21, w: 895, h: 259 } },
  securityRecoverySignIn: { frame: "training/user/security-sign-in-recovery.png", rect: { x: 56, y: 132, w: 495, h: 591 } },
  securityEnabled: { frame: "training/user/security-enabled.png", rect: { x: 776, y: 339, w: 384, h: 169 } },
  securityCodesRemaining: { frame: "training/user/security-codes-remaining.png", rect: { x: 776, y: 339, w: 384, h: 169 } },
  securityPasswordUpdated: { frame: "training/user/security-password-updated.png", rect: { x: 776, y: 457, w: 384, h: 63 } },
  modelMenu: { frame: "training/user/models-menu.png", rect: { x: 850, y: 54, w: 266, h: 111 } },
  modelAccessWithdrawn: { frame: "training/user/models-withdrawn.png", rect: { x: 262, y: 145, w: 661, h: 23 } },
  modelAccessExpired: { frame: "training/user/models-signed-out.png", rect: { x: 262, y: 145, w: 661, h: 23 } },
  modelAccessApproved: { frame: "training/user/models-approved.png", rect: { x: 262, y: 145, w: 661, h: 140 } },
  modelReply: { frame: "training/user/models-reply.png", rect: { x: 257, y: 219, w: 897, h: 172 } },
  chatStarter: { frame: "training/user/chat-starter.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  chatRunning: { frame: "training/user/chat-running.png", rect: { x: 315, y: 250, w: 686, h: 191 } },
  chatStopped: { frame: "training/user/chat-stopped.png", rect: { x: 257, y: 219, w: 897, h: 81 } },
  chatEdit: { frame: "training/user/chat-edit.png", rect: { x: 257, y: 93, w: 897, h: 170 } },
  chatEdited: { frame: "training/user/chat-edited.png", rect: { x: 257, y: 219, w: 897, h: 294 } },
  chatFeedback: { frame: "training/user/chat-feedback.png", rect: { x: 315, y: 510, w: 839, h: 123 } },
  chatFeedbackSent: { frame: "training/user/chat-feedback-sent.png", rect: { x: 315, y: 468, w: 839, h: 45 } },
  chatBranched: { frame: "training/user/chat-branched.png", rect: { x: 249, y: 20, w: 335, h: 25 } },
  chatTransferred: { frame: "training/user/chat-transferred.png", rect: { x: 500, y: 270, w: 641, h: 554 } },
  sendOptionsMenu: { frame: "training/user/send-menu.png", rect: { x: 656, y: 194, w: 463, h: 467 } },
  sendKnowledgeReply: { frame: "training/user/send-knowledge-reply.png", rect: { x: 257, y: 239, w: 897, h: 173 } },
  sessionSources: { frame: "training/user/session-sources.png", rect: { x: 881, y: 348, w: 289, h: 173 } },
  sendWebOn: { frame: "training/user/send-web-on.png", rect: { x: 667, y: 386, w: 441, h: 50 } },
  sendResourceInserted: { frame: "training/user/send-resource-inserted.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  symbolSlashInserted: { frame: "training/user/symbols-slash-inserted.png", rect: { x: 257, y: 605, w: 897, h: 198 } },
  symbolAtInserted: { frame: "training/user/symbols-at-inserted.png", rect: { x: 257, y: 605, w: 897, h: 198 } },
  symbolHashInserted: { frame: "training/user/symbols-hash-inserted.png", rect: { x: 257, y: 605, w: 897, h: 198 } },
  symbolDollarInserted: { frame: "training/user/symbols-dollar-inserted.png", rect: { x: 257, y: 561, w: 897, h: 252 } },
  symbolGtQueued: { frame: "training/user/symbols-gt-queued.png", rect: { x: 257, y: 561, w: 897, h: 252 } },
  symbolReply: { frame: "training/user/symbols-reply.png", rect: { x: 257, y: 360, w: 897, h: 209 } },
  attachMenu: { frame: "training/user/attach-menu.png", rect: { x: 311, y: 163, w: 259, h: 283 } },
  attachFileReady: { frame: "training/user/attach-file-ready.png", rect: { x: 292, y: 313, w: 827, h: 252 } },
  attachFileReply: { frame: "training/user/attach-file-reply.png", rect: { x: 257, y: 306, w: 897, h: 176 } },
  attachLinkField: { frame: "training/user/attach-link-field.png", rect: { x: 276, y: 576, w: 857, h: 44 } },
  attachLinkChip: { frame: "training/user/attach-link-chip.png", rect: { x: 257, y: 557, w: 897, h: 246 } },
  attachLinkReply: { frame: "training/user/attach-link-reply.png", rect: { x: 257, y: 396, w: 897, h: 172 } },
  attachConnector: { frame: "training/user/attach-connector.png", rect: { x: 309, y: 275, w: 567, h: 305 } },
  dictationRecording: { frame: "training/user/dictation-recording.png", rect: { x: 292, y: 307, w: 827, h: 199 } },
  dictationError: { frame: "training/user/dictation-error.png", rect: { x: 311, y: 324, w: 789, h: 200 } },
  diagramCode: { frame: "training/user/diagram-code.png", rect: { x: 315, y: 334, w: 839, h: 127 } },
  draftsRequest: { frame: "training/user/drafts-request.png", rect: { x: 91, y: 667, w: 349, h: 169 } },
  draftsGenerated: { frame: "training/user/drafts-generated.png", rect: { x: 500, y: 246, w: 641, h: 578 } },
  draftsAiMenu: { frame: "training/user/drafts-ai-menu.png", rect: { x: 548, y: 13, w: 467, h: 461 } },
  draftsExportMenu: { frame: "training/user/drafts-export-menu.png", rect: { x: 772, y: 162, w: 387, h: 437 } },
  draftsExported: { frame: "training/user/drafts-exported.png", rect: { x: 772, y: 162, w: 387, h: 540 } },
  draftsTitle: { frame: "training/user/drafts-generated.png", rect: { x: 807, y: 14, w: 225, h: 44 } },
  draftFormatRail: { frame: "training/user/drafts-blank.png", rect: { x: 481, y: 11, w: 326, h: 50 } },
  draftTraceRunning: { frame: "training/user/drafts-running.png", rect: { x: 91, y: 297, w: 345, h: 241 } },
  draftTraceDone: { frame: "training/user/drafts-generated.png", rect: { x: 91, y: 297, w: 345, h: 312 } },
  draftsPdfExported: { frame: "training/user/drafts-pdf-exported.png", rect: { x: 785, y: 365, w: 361, h: 343 } },
  draftsPrint: { frame: "training/user/drafts-print.png", rect: { x: 785, y: 507, w: 361, h: 128 } },
  draftPageNavigator: { frame: "training/user/drafts-pages.png", rect: { x: 458, y: 486, w: 43, h: 98 } },
  draftTransferMenu: { frame: "training/user/drafts-transfer-menu.png", rect: { x: 836, y: 302, w: 318, h: 261 } },
  draftsTransferred: { frame: "training/user/drafts-transferred.png", rect: { x: 500, y: 270, w: 641, h: 554 } },
  deckConvertDialog: { frame: "training/user/deck-convert-dialog.png", rect: { x: 488, y: 177, w: 387, h: 179 } },
  deckConverted: { frame: "training/user/deck-converted.png", rect: { x: 453, y: 246, w: 174, h: 562 } },
  deckOutlineRequest: { frame: "training/user/deck-outline-request.png", rect: { x: 91, y: 645, w: 349, h: 191 } },
  deckGenerated: { frame: "training/user/deck-generated.png", rect: { x: 453, y: 246, w: 174, h: 562 } },
  deckExported: { frame: "training/user/deck-exported.png", rect: { x: 772, y: 162, w: 387, h: 348 } },
  deckStarters: { frame: "training/user/deck-starters.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  deckTemplateStarted: { frame: "training/user/deck-template-started.png", rect: { x: 453, y: 246, w: 174, h: 562 } },
  historyArchived: { frame: "training/user/history-archived.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  historyRestored: { frame: "training/user/history-restored.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  historyVersions: { frame: "training/user/history-versions.png", rect: { x: 100, y: 495, w: 327, h: 174 } },
  historyDelete: { frame: "training/user/history-delete.png", rect: { x: 359, y: 297, w: 467, h: 261 } },
  agentsBlocked: { frame: "training/user/agents-blocked.png", rect: { x: 260, y: 176, w: 891, h: 68 } },
  agentProfileForm: { frame: "training/user/agent-profile.png", rect: { x: 261, y: 296, w: 889, h: 540 } },
  agentKnowledgePick: { frame: "training/user/agent-knowledge.png", rect: { x: 261, y: 296, w: 889, h: 210 } },
  agentSkillsPick: { frame: "training/user/agent-skills.png", rect: { x: 261, y: 296, w: 889, h: 305 } },
  agentAccess: { frame: "training/user/agent-access.png", rect: { x: 261, y: 296, w: 889, h: 112 } },
  agentCreated: { frame: "training/user/agent-created.png", rect: { x: 260, y: 237, w: 891, h: 49 } },
  agentMention: { frame: "training/user/agent-mention.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  agentReply: { frame: "training/user/agent-reply.png", rect: { x: 315, y: 98, w: 839, h: 757 } },
  knowledgeBlocked: { frame: "training/user/knowledge-blocked.png", rect: { x: 260, y: 176, w: 891, h: 49 } },
  knowledgeCreate: { frame: "training/user/knowledge-create.png", rect: { x: 329, y: 211, w: 527, h: 433 } },
  knowledgeFiles: { frame: "training/user/knowledge-files.png", rect: { x: 261, y: 296, w: 889, h: 559 } },
  knowledgeWeb: { frame: "training/user/knowledge-web.png", rect: { x: 283, y: 318, w: 845, h: 505 } },
  knowledgeWebAdded: { frame: "training/user/knowledge-web-added.png", rect: { x: 260, y: 176, w: 891, h: 68 } },
  knowledgeApi: { frame: "training/user/knowledge-api.png", rect: { x: 283, y: 334, w: 845, h: 304 } },
  knowledgeQuestion: { frame: "training/user/knowledge-question.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  knowledgeReply: { frame: "training/user/knowledge-reply.png", rect: { x: 257, y: 219, w: 897, h: 260 } },
  knowledgeSources: { frame: "training/user/knowledge-sources.png", rect: { x: 881, y: 379, w: 289, h: 142 } },
  toolsPrompts: { frame: "training/user/tools-prompts.png", rect: { x: 260, y: 356, w: 891, h: 464 } },
  toolsPromptView: { frame: "training/user/tools-prompt-view.png", rect: { x: 260, y: 333, w: 891, h: 522 } },
  toolsSkills: { frame: "training/user/tools-skills.png", rect: { x: 260, y: 356, w: 891, h: 464 } },
  toolsAddConnection: { frame: "training/user/tools-add-connection.png", rect: { x: 260, y: 273, w: 891, h: 387 } },
  automationWhat: { frame: "training/user/automation-what.png", rect: { x: 261, y: 248, w: 889, h: 238 } },
  automationSteps: { frame: "training/user/automation-steps.png", rect: { x: 261, y: 206, w: 889, h: 326 } },
  automationDaily: { frame: "training/user/automation-daily.png", rect: { x: 261, y: 396, w: 889, h: 231 } },
  automationOnce: { frame: "training/user/automation-once.png", rect: { x: 261, y: 396, w: 889, h: 231 } },
  automationCustom: { frame: "training/user/automation-custom.png", rect: { x: 261, y: 384, w: 889, h: 263 } },
  automationWeekly: { frame: "training/user/automation-weekly.png", rect: { x: 261, y: 384, w: 889, h: 287 } },
  automationDeliver: { frame: "training/user/automation-deliver.png", rect: { x: 261, y: 620, w: 889, h: 126 } },
  automationSaved: { frame: "training/user/automation-saved.png", rect: { x: 260, y: 292, w: 891, h: 216 } },
  automationRunOutput: { frame: "training/user/automation-run-output.png", rect: { x: 260, y: 148, w: 891, h: 558 } },
  automationResultChat: { frame: "training/user/automation-result-chat.png", rect: { x: 257, y: 219, w: 897, h: 130 } },
  automationHistory: { frame: "training/user/automation-history.png", rect: { x: 260, y: 520, w: 891, h: 310 } },
  automationPaused: { frame: "training/user/automation-paused.png", rect: { x: 260, y: 520, w: 891, h: 310 } },
  automationDraftTarget: { frame: "training/user/automation-draft-target.png", rect: { x: 261, y: 620, w: 889, h: 126 } },
  automationResultDraft: { frame: "training/user/automation-result-draft.png", rect: { x: 500, y: 270, w: 641, h: 554 } },
  organizeFolderNew: { frame: "training/user/organize-folder-new.png", rect: { x: 9, y: 368, w: 194, h: 36 } },
  organizeMoveMenu: { frame: "training/user/organize-move-menu.png", rect: { x: 5, y: 659, w: 196, h: 108 } },
  organizeArchived: { frame: "training/user/organize-archived.png", rect: { x: 788, y: 711, w: 360, h: 56 } },
  organizeRenamed: { frame: "training/user/organize-renamed.png", rect: { x: 249, y: 20, w: 235, h: 25 } },
  previewAllChats: { frame: "training/user/preview-all-chats.png", rect: { x: 268, y: 284, w: 486, h: 326 } },
  searchResults: { frame: "training/user/search-results.png", rect: { x: 279, y: 99, w: 627, h: 588 } },
  searchOpened: { frame: "training/user/search-opened.png", rect: { x: 257, y: 239, w: 897, h: 286 } },
  searchCommandDone: { frame: "training/user/search-command-done.png", rect: { x: 142, y: 732, w: 38, h: 38 } },
  memoryRejected: { frame: "training/user/memory-rejected.png", rect: { x: 280, y: 303, w: 625, h: 82 } },
  memorySavedChat: { frame: "training/user/memory-saved-chat.png", rect: { x: 257, y: 168, w: 897, h: 401 } },
  memorySavedList: { frame: "training/user/memory-saved-list.png", rect: { x: 280, y: 655, w: 625, h: 63 } },
  profileSaved: { frame: "training/user/account-profile-saved.png", rect: { x: 775, y: 85, w: 386, h: 238 } },
  accountOverview: { frame: "training/user/account-overview.png", rect: { x: 761, y: 73, w: 414, h: 712 } },
  accountUsage: { frame: "training/user/account-overview.png", rect: { x: 775, y: 470, w: 386, h: 157 } },
  apiAccessCreate: { frame: "training/user/account-api-empty.png", rect: { x: 776, y: 354, w: 384, h: 219 } },
  apiAccessActive: { frame: "training/user/account-api-active.png", rect: { x: 776, y: 341, w: 384, h: 245 } },
  apiAccessRotate: { frame: "training/user/account-api-rotate.png", rect: { x: 788, y: 534, w: 360, h: 83 } },
  apiAccessRevoke: { frame: "training/user/account-api-revoke.png", rect: { x: 788, y: 534, w: 360, h: 83 } },
  apiAccessRevoked: { frame: "training/user/account-api-revoked.png", rect: { x: 776, y: 341, w: 384, h: 219 } },
  accountArchived: { frame: "training/user/account-archived.png", rect: { x: 788, y: 712, w: 360, h: 56 } },
  accountArchivedDelete: { frame: "training/user/account-archived-delete.png", rect: { x: 799, y: 675, w: 340, h: 83 } },
  accountWorkspace: { frame: "training/user/account-workspace.png", rect: { x: 775, y: 249, w: 386, h: 198 } },
  installIpad: { frame: "training/user/install-ipad.png", rect: { x: 389, y: 223, w: 407, h: 409 } },
  installAndroid: { frame: "training/user/install-android.png", rect: { x: 389, y: 231, w: 407, h: 393 } },
  privacyFooter: { frame: "training/user/privacy-footer.png", rect: { x: 270, y: 646, w: 871, h: 23 } },
  privacyPrompt: { frame: "training/user/privacy-sent.png", rect: { x: 257, y: 93, w: 897, h: 126 } },
  privacyReply: { frame: "training/user/privacy-sent.png", rect: { x: 315, y: 313, w: 839, h: 54 } },
  privacyRatingNote: { frame: "training/user/privacy-rating-note.png", rect: { x: 315, y: 368, w: 839, h: 154 } },
  privacyOutput: { frame: "training/user/privacy-output.png", rect: { x: 315, y: 292, w: 839, h: 28 } },
  reportHelpRows: { frame: "training/user/report-help.png", rect: { x: 777, y: 118, w: 382, h: 136 } },
  reportKind: { frame: "training/user/report-kind.png", rect: { x: 792, y: 164, w: 352, h: 222 } },
  reportFields: { frame: "training/user/report-filled.png", rect: { x: 792, y: 393, w: 352, h: 257 } },
  reportScreenshot: { frame: "training/user/report-screenshot.png", rect: { x: 792, y: 567, w: 352, h: 279 } },
  reportSent: { frame: "training/user/report-sent.png", rect: { x: 777, y: 149, w: 382, h: 147 } },
  reportTracker: { frame: "training/user/report-status.png", rect: { x: 777, y: 149, w: 382, h: 89 } },
  reportHelpDot: { frame: "training/user/report-dot.png", rect: { x: 9, y: 731, w: 135, h: 40 } },
  reportUnread: { frame: "training/user/report-unread.png", rect: { x: 777, y: 189, w: 382, h: 96 } },
  reportReply: { frame: "training/user/report-reply.png", rect: { x: 777, y: 579, w: 382, h: 266 } },
  reportReplied: { frame: "training/user/report-replied.png", rect: { x: 777, y: 599, w: 382, h: 68 } },
  reportClosed: { frame: "training/user/report-closed.png", rect: { x: 777, y: 118, w: 382, h: 174 } },
  reportReopen: { frame: "training/user/report-reopen.png", rect: { x: 777, y: 695, w: 382, h: 151 } },
  reportReopened: { frame: "training/user/report-reopened.png", rect: { x: 777, y: 9, w: 382, h: 836 } },
  reportIdea: { frame: "training/user/report-idea.png", rect: { x: 792, y: 164, w: 352, h: 123 } },
  reportSecurity: { frame: "training/user/report-security.png", rect: { x: 792, y: 87, w: 352, h: 212 } },
  reportAll: { frame: "training/user/report-all.png", rect: { x: 777, y: 224, w: 382, h: 278 } },
  handoffCard: { frame: "training/user/handoff-card.png", rect: { x: 315, y: 243, w: 586, h: 160 } },
  handoffEditRequest: { frame: "training/user/handoff-edit-request.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  handoffContinued: { frame: "training/user/handoff-continued.png", rect: { x: 257, y: 123, w: 897, h: 732 } },
  handoffWriting: { frame: "training/user/handoff-writing.png", rect: { x: 91, y: 17, w: 349, h: 615 } },
  handoffWritten: { frame: "training/user/handoff-written.png", rect: { x: 500, y: 246, w: 641, h: 578 } },
  handoffDeckCard: { frame: "training/user/handoff-deck-card.png", rect: { x: 315, y: 243, w: 586, h: 160 } },
  handoffDeckBuilt: { frame: "training/user/handoff-deck-built.png", rect: { x: 453, y: 246, w: 174, h: 562 } },
  handoffSheetCard: { frame: "training/user/handoff-sheet-card.png", rect: { x: 315, y: 243, w: 586, h: 160 } },
  handoffSheetBuilt: { frame: "training/user/handoff-sheet-built.png", rect: { x: 453, y: 282, w: 732, h: 495 } },
  deckAddPanel: { frame: "training/user/deck-add-panel.png", rect: { x: 73, y: 0, w: 386, h: 855 } },
  deckSlideAdded: { frame: "training/user/deck-slide-added.png", rect: { x: 465, y: 442, w: 688, h: 309 } },
  deckChangeLayout: { frame: "training/user/deck-change-layout.png", rect: { x: 73, y: 0, w: 386, h: 855 } },
  deckPicturePanel: { frame: "training/user/deck-picture-panel.png", rect: { x: 73, y: 0, w: 386, h: 855 } },
  deckPictureAdded: { frame: "training/user/deck-picture-added.png", rect: { x: 657, y: 468, w: 496, h: 283 } },
  deckWebImages: { frame: "training/user/deck-web-images.png", rect: { x: 73, y: 0, w: 386, h: 855 } },
  deckTextToolbar: { frame: "training/user/deck-text-toolbar.png", rect: { x: 657, y: 725, w: 498, h: 46 } },
  deckTextColors: { frame: "training/user/deck-text-colors.png", rect: { x: 990, y: 606, w: 189, h: 122 } },
  deckTextFit: { frame: "training/user/deck-text-fit.png", rect: { x: 682, y: 725, w: 448, h: 23 } },
  deckAiReview: { frame: "training/user/deck-ai-review.png", rect: { x: 73, y: 0, w: 386, h: 855 } },
  deckAiText: { frame: "training/user/deck-ai-text.png", rect: { x: 73, y: 0, w: 386, h: 855 } },
  deckFitCheck: { frame: "training/user/deck-fit-check.png", rect: { x: 91, y: 604, w: 345, h: 64 } },
  sheetFixApplied: { frame: "training/user/sheet-fix-applied.png", rect: { x: 604, y: 226, w: 474, h: 44 } },
  sheetFixPreview: { frame: "training/user/sheet-fix-preview.png", rect: { x: 489, y: 538, w: 466, h: 308 } },
  sheetCheckTotal: { frame: "training/user/sheet-check-total.png", rect: { x: 651, y: 336, w: 156, h: 174 } },
  sheetVersionRestored: { frame: "training/user/sheet-version-restored.png", rect: { x: 1072, y: 24, w: 88, h: 24 } },
  sheetVersions: { frame: "training/user/sheet-history.png", rect: { x: 100, y: 495, w: 331, h: 174 } },
  sheetRailUpdate: { frame: "training/user/sheet-rail-update.png", rect: { x: 91, y: 221, w: 345, h: 309 } },
  sheetUndo: { frame: "training/user/sheet-undo.png", rect: { x: 476, y: 177, w: 70, h: 37 } },
  sheetExplain: { frame: "training/user/sheet-explain.png", rect: { x: 710, y: 514, w: 466, h: 314 } },
  sheetAskTablePreview: { frame: "training/user/sheet-ask-table-preview.png", rect: { x: 489, y: 514, w: 466, h: 324 } },
  sheetAskCellApplied: { frame: "training/user/sheet-ask-cell-applied.png", rect: { x: 604, y: 226, w: 474, h: 44 } },
  sheetAskCellPreview: { frame: "training/user/sheet-ask-cell-preview.png", rect: { x: 639, y: 200, w: 466, h: 324 } },
  sheetAskOpen: { frame: "training/user/sheet-ask-open.png", rect: { x: 639, y: 50, w: 466, h: 474 } },
  sheetCheckSum: { frame: "training/user/sheet-check-sum.png", rect: { x: 475, y: 828, w: 470, h: 21 } },
  sheetCheckFormula: { frame: "training/user/sheet-check-formula.png", rect: { x: 651, y: 360, w: 456, h: 30 } },
  sheetBuiltTrace: { frame: "training/user/sheet-built.png", rect: { x: 91, y: 278, w: 345, h: 292 } },
  sheetBuiltGrid: { frame: "training/user/sheet-built.png", rect: { x: 501, y: 308, w: 606, h: 226 } },
  sheetWorking: { frame: "training/user/sheet-working.png", rect: { x: 91, y: 278, w: 345, h: 190 } },
  sheetRequest: { frame: "training/user/sheet-request.png", rect: { x: 91, y: 623, w: 349, h: 213 } },
  sheetSuggestions: { frame: "training/user/sheet-start.png", rect: { x: 93, y: 413, w: 345, h: 186 } },
  sheetFormatRail: { frame: "training/user/sheet-start.png", rect: { x: 481, y: 11, w: 323, h: 50 } },
  sheetCompare: { frame: "training/user/sheet-compare.png", rect: { x: 589, y: 495, w: 428, h: 71 } },
  sheetReopened: { frame: "training/user/sheet-xlsx-opened.png", rect: { x: 541, y: 777, w: 337, h: 42 } },
  sheetExportNotes: { frame: "training/user/sheet-exported.png", rect: { x: 91, y: 202, w: 345, h: 115 } },
  sheetExportPanel: { frame: "training/user/sheet-export-panel.png", rect: { x: 772, y: 162, w: 387, h: 407 } },
  sheetFrozenHeader: { frame: "training/user/sheet-freeze.png", rect: { x: 501, y: 308, w: 676, h: 30 } },
  sheetFilterApplied: { frame: "training/user/sheet-filter-applied.png", rect: { x: 810, y: 311, w: 24, h: 24 } },
  sheetFilterMenu: { frame: "training/user/sheet-filter-menu.png", rect: { x: 810, y: 333, w: 306, h: 370 } },
  sheetValidationNotice: { frame: "training/user/sheet-validation-reject.png", rect: { x: 699, y: 718, w: 243, h: 45 } },
  sheetValidationList: { frame: "training/user/sheet-validation-list.png", rect: { x: 651, y: 452, w: 226, h: 140 } },
  sheetValidationPanel: { frame: "training/user/sheet-validation-panel.png", rect: { x: 862, y: 282, w: 323, h: 495 } },
  sheetDataMenu: { frame: "training/user/sheet-data-menu.png", rect: { x: 827, y: 213, w: 243, h: 352 } },
  sheetConditional: { frame: "training/user/sheet-conditional.png", rect: { x: 862, y: 282, w: 323, h: 495 } },
  sheetChartPlaced: { frame: "training/user/sheet-chart-made.png", rect: { x: 788, y: 346, w: 366, h: 231 } },
  sheetChartPanel: { frame: "training/user/sheet-chart-panel.png", rect: { x: 862, y: 282, w: 323, h: 495 } },
  sheetPivotResult: { frame: "training/user/sheet-pivot-made.png", rect: { x: 501, y: 356, w: 286, h: 198 } },
  sheetPivotPanel: { frame: "training/user/sheet-pivot-panel.png", rect: { x: 862, y: 282, w: 323, h: 495 } },
  sheetInsertMenu: { frame: "training/user/sheet-insert-menu.png", rect: { x: 771, y: 213, w: 243, h: 523 } },
  sheetStyleGallery: { frame: "training/user/sheet-style-gallery.png", rect: { x: 878, y: 213, w: 302, h: 376 } },
  sheetNamedTotal: { frame: "training/user/sheet-structured-sum.png", rect: { x: 604, y: 226, w: 474, h: 44 } },
  sheetStatusSum: { frame: "training/user/sheet-structured-filled.png", rect: { x: 475, y: 828, w: 470, h: 21 } },
  sheetFormulaTyping: { frame: "training/user/sheet-structured-typing.png", rect: { x: 453, y: 218, w: 732, h: 61 } },
  sheetTableHeader: { frame: "training/user/sheet-table-made.png", rect: { x: 501, y: 308, w: 605, h: 30 } },
  sheetTablePanel: { frame: "training/user/sheet-table-panel.png", rect: { x: 862, y: 282, w: 323, h: 495 } },
  sheetFormatMenu: { frame: "training/user/sheet-format-menu.png", rect: { x: 883, y: 213, w: 243, h: 403 } },
  sheetDateColumn: { frame: "training/user/sheet-opened-csv.png", rect: { x: 501, y: 308, w: 92, h: 469 } },
  sheetOpenMenu: { frame: "training/user/sheet-open-menu.png", rect: { x: 105, y: 407, w: 306, h: 375 } },
  sheetTemplateTabs: { frame: "training/user/sheet-template-started.png", rect: { x: 541, y: 777, w: 283, h: 42 } },
  sheetTemplates: { frame: "training/user/sheet-templates.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  deckThemes: { frame: "training/user/deck-themes.png", rect: { x: 657, y: 268, w: 496, h: 157 } },
  deckThemesMore: { frame: "training/user/deck-themes-more.png", rect: { x: 657, y: 268, w: 496, h: 157 } },
  deckThemeSorter: { frame: "training/user/deck-theme-sorter.png", rect: { x: 453, y: 246, w: 732, h: 609 } },
  deckAddHighlights: { frame: "training/user/deck-add-highlights.png", rect: { x: 73, y: 0, w: 386, h: 855 } },
  deckStatement: { frame: "training/user/deck-statement.png", rect: { x: 657, y: 468, w: 496, h: 283 } },
  deckBigNumber: { frame: "training/user/deck-big-number.png", rect: { x: 657, y: 468, w: 496, h: 283 } },
  deckPictureBullets: { frame: "training/user/deck-picture-bullets.png", rect: { x: 657, y: 468, w: 496, h: 283 } },
  historyVersionsCleared: { frame: "training/user/history-local-changes.png", rect: { x: 100, y: 599, w: 331, h: 70 } },
  historySpreadsheet: { frame: "training/user/history-spreadsheet.png", rect: { x: 100, y: 280, w: 637, h: 201 } },
  draftSaveFailed: { frame: "training/user/drafts-save-failed.png", rect: { x: 1017, y: 188, w: 148, h: 43 } },
  knowledgeApiLocked: { frame: "training/user/knowledge-api-locked.png", rect: { x: 283, y: 334, w: 845, h: 68 } },
  toolsAddLocked: { frame: "training/user/tools-connections.png", rect: { x: 994, y: 270, w: 157, h: 45 } },
  wordOpened: { frame: "training/user/word-opened.png", rect: { x: 500, y: 270, w: 641, h: 554 } },
  wordOpenedEnd: { frame: "training/user/word-opened-end.png", rect: { x: 575, y: 524, w: 491, h: 300 } },
  wordAskAi: { frame: "training/user/word-ask-ai.png", rect: { x: 563, y: 419, w: 467, h: 233 } },
  wordAiReview: { frame: "training/user/word-ai-review.png", rect: { x: 563, y: 419, w: 467, h: 386 } },
  wordAiApplied: { frame: "training/user/word-ai-applied.png", rect: { x: 575, y: 381, w: 491, h: 52 } },
  wordSaved: { frame: "training/user/word-saved.png", rect: { x: 810, y: 72, w: 355, h: 157 } },
  wordExported: { frame: "training/user/word-exported.png", rect: { x: 772, y: 162, w: 387, h: 523 } },
  pdfOpened: { frame: "training/user/pdf-opened.png", rect: { x: 605, y: 262, w: 431, h: 562 } },
  wordTemplateUploaded: { frame: "training/user/word-template-uploaded.png", rect: { x: 100, y: 425, w: 331, h: 244 } },
  templatesPanel: { frame: "training/user/templates-panel.png", rect: { x: 100, y: 233, w: 331, h: 436 } },
  templatePlaced: { frame: "training/user/template-placed.png", rect: { x: 500, y: 270, w: 641, h: 554 } },
  templateRequest: { frame: "training/user/template-request.png", rect: { x: 91, y: 602, w: 349, h: 234 } },
  templateDrafted: { frame: "training/user/template-drafted.png", rect: { x: 500, y: 246, w: 641, h: 578 } },
  layoutRequest: { frame: "training/user/layout-request.png", rect: { x: 91, y: 686, w: 349, h: 150 } },
  layoutApplied: { frame: "training/user/layout-applied.png", rect: { x: 91, y: 202, w: 345, h: 83 } },
  templateExisting: { frame: "training/user/template-existing.png", rect: { x: 500, y: 291, w: 641, h: 533 } },
  mlaApplied: { frame: "training/user/mla-applied.png", rect: { x: 500, y: 246, w: 641, h: 578 } },
  historyLocalChanges: { frame: "training/user/history-local-changes.png", rect: { x: 101, y: 352, w: 325, h: 59 } },
  agentsHermesLocked: { frame: "training/user/agents-page.png", rect: { x: 260, y: 234, w: 442, h: 329 } },
  traceRunningFolded: { frame: "training/user/trace-running-folded.png", rect: { x: 315, y: 250, w: 686, h: 58 } },
  transferMenu: { frame: "training/user/transfer-menu.png", rect: { x: 836, y: 206, w: 318, h: 261 } },
  chatTransferredDeck: { frame: "training/user/chat-transferred-deck.png", rect: { x: 453, y: 246, w: 174, h: 562 } },
  traceKnowledge: { frame: "training/user/send-knowledge-trace.png", rect: { x: 315, y: 126, w: 686, h: 416 } },
  codeTrace: { frame: "training/user/code-trace.png", rect: { x: 315, y: 147, w: 686, h: 352 } },
  codeBlock: { frame: "training/user/code-reply.png", rect: { x: 315, y: 313, w: 839, h: 93 } },
  codeDownload: { frame: "training/user/code-reply.png", rect: { x: 879, y: 322, w: 106, h: 35 } },
  codeEditing: { frame: "training/user/code-editing.png", rect: { x: 315, y: 313, w: 839, h: 144 } },
  codeSaved: { frame: "training/user/code-saved.png", rect: { x: 441, y: 322, w: 635, h: 35 } },
  codeAskAi: { frame: "training/user/code-ask-ai.png", rect: { x: 689, y: 311, w: 91, h: 47 } },
  codeAiMenu: { frame: "training/user/code-ai-menu.png", rect: { x: 304, y: 408, w: 466, h: 418 } },
  canvasReply: { frame: "training/user/canvas-reply.png", rect: { x: 983, y: 409, w: 93, h: 35 } },
  canvasPreview: { frame: "training/user/canvas-preview.png", rect: { x: 287, y: 0, w: 898, h: 855 } },
  canvasCode: { frame: "training/user/canvas-code.png", rect: { x: 287, y: 0, w: 898, h: 855 } },
  canvasEdited: { frame: "training/user/canvas-edited.png", rect: { x: 287, y: 0, w: 898, h: 855 } },
  canvasExpanded: { frame: "training/user/canvas-expanded.png", rect: { x: 0, y: 0, w: 1185, h: 73 } },
  canvasTab: { frame: "training/user/canvas-tab.png", rect: { x: 1156, y: 392, w: 29, h: 71 } },
  tableReply: { frame: "training/user/table-reply.png", rect: { x: 315, y: 292, w: 839, h: 201 } },
  tableEditing: { frame: "training/user/table-editing.png", rect: { x: 315, y: 292, w: 839, h: 201 } },
  tableRowAdded: { frame: "training/user/table-row-added.png", rect: { x: 315, y: 292, w: 839, h: 241 } },
  tableTransfer: { frame: "training/user/table-transfer.png", rect: { x: 836, y: 276, w: 318, h: 261 } },
  tableSheet: { frame: "training/user/table-sheet.png", rect: { x: 501, y: 332, w: 676, h: 445 } },
  diagramStructure: { frame: "training/user/diagram-structure.png", rect: { x: 315, y: 225, w: 839, h: 404 } },
  diagramTheme: { frame: "training/user/diagram-theme.png", rect: { x: 316, y: 119, w: 837, h: 217 } },
  diagramConnectors: { frame: "training/user/diagram-connectors.png", rect: { x: 330, y: 248, w: 809, h: 73 } },
  diagramDragged: { frame: "training/user/diagram-dragged.png", rect: { x: 316, y: 267, w: 837, h: 402 } },
  diagramCardColor: { frame: "training/user/diagram-card-color.png", rect: { x: 316, y: 267, w: 837, h: 402 } },
  diagramArrow: { frame: "training/user/diagram-arrow.png", rect: { x: 616, y: 436, w: 308, h: 49 } },
  diagramPng: { frame: "training/user/diagram-final.png", rect: { x: 800, y: 232, w: 79, h: 35 } },
  knowledgeProperties: { frame: "training/user/knowledge-properties.png", rect: { x: 296, y: 482, w: 819, h: 315 } },
  knowledgeLookup: { frame: "training/user/knowledge-web.png", rect: { x: 300, y: 628, w: 811, h: 93 } },
  knowledgeReading: { frame: "training/user/knowledge-reading.png", rect: { x: 283, y: 463, w: 845, h: 102 } },
  knowledgeLiveReply: { frame: "training/user/knowledge-live-reply.png", rect: { x: 257, y: 219, w: 897, h: 234 } },
  knowledgeLiveSource: { frame: "training/user/knowledge-live-source.png", rect: { x: 881, y: 306, w: 289, h: 214 } },
  knowledgeWebRow: { frame: "training/user/knowledge-web-row.png", rect: { x: 284, y: 741, w: 843, h: 65 } },
  agentTrace: { frame: "training/user/agent-trace.png", rect: { x: 315, y: 98, w: 686, h: 463 } },
  sourcesQuestion: { frame: "training/user/sources-question.png", rect: { x: 292, y: 339, w: 827, h: 199 } },
  sourcesTrace: { frame: "training/user/sources-trace.png", rect: { x: 315, y: 235, w: 686, h: 339 } },
  sourcesReply: { frame: "training/user/sources-reply.png", rect: { x: 315, y: 313, w: 839, h: 99 } },
  sourcesPanel: { frame: "training/user/sources-panel.png", rect: { x: 881, y: 258, w: 289, h: 262 } },
  sourcesRow: { frame: "training/user/sources-panel.png", rect: { x: 881, y: 309, w: 289, h: 122 } },
  sourcesMark: { frame: "training/user/sources-pdf.png", rect: { x: 290, y: 294, w: 708, h: 131 } },
  sourcesCallout: { frame: "training/user/sources-pdf.png", rect: { x: 140, y: 63, w: 1045, h: 101 } },
  sourcesControls: { frame: "training/user/sources-moved.png", rect: { x: 687, y: 8, w: 437, h: 50 } },
  sourcesBack: { frame: "training/user/sources-back.png", rect: { x: 1036, y: 11, w: 44, h: 44 } },
  sourcesDownload: { frame: "training/user/sources-back.png", rect: { x: 1080, y: 11, w: 94, h: 44 } },
  sourcesWord: { frame: "training/user/sources-word.png", rect: { x: 140, y: 63, w: 1045, h: 290 } },
  sourcesInline: { frame: "training/user/sources-inline.png", rect: { x: 827, y: 313, w: 32, h: 24 } },
  sourcesInlineOpen: { frame: "training/user/sources-inline-open.png", rect: { x: 140, y: 63, w: 1045, h: 101 } },
  sourcesLibrary: { frame: "training/user/sources-library.png", rect: { x: 1024, y: 351, w: 45, h: 45 } },
  sourcesPreview: { frame: "training/user/sources-preview.png", rect: { x: 140, y: 0, w: 1045, h: 69 } },
  sourcesNone: { frame: "training/user/sources-none.png", rect: { x: 315, y: 292, w: 839, h: 28 } },
  sourcesOldText: { frame: "training/user/sources-old-text.png", rect: { x: 140, y: 63, w: 1045, h: 42 } },
  traceFlag: { frame: "training/user/trace-flag.png", rect: { x: 315, y: 76, w: 686, h: 322 } },
  diagramCardSwatches: { frame: "training/user/diagram-card-swatches.png", rect: { x: 917, y: 531, w: 210, h: 68 } },
  codeAiReview: { frame: "training/user/code-ai-review.png", rect: { x: 304, y: 408, w: 466, h: 316 } },
  codeAiRefined: { frame: "training/user/code-ai-refined.png", rect: { x: 304, y: 408, w: 466, h: 316 } },
  codeAiApplied: { frame: "training/user/code-ai-applied.png", rect: { x: 315, y: 313, w: 839, h: 112 } },
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
      "Watch Aperture Chat is working: a timer, each step as it lands, and what comes Next. The answer appears under it.",
      "Read the reply. The work trace above it reads Worked for, the time it took, and the number of steps, and the chat is listed under Recent with a title from your request.",
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
      "Your message and the model's reply both appear, and the trace above the reply reads Worked for and the time it took.",
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
        narration: "Choose New chat at the top of the sidebar. Type in the message box, or choose a starter below it. Explore an idea put these opening words here, so you can finish the sentence. Nothing is sent until you send it.",
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
        caption: "Enter sends. Shift+Enter adds a line. Say the length and format you want.",
        narration: "Type your request, and say the length and format you want, as this one does, to save a follow-up. Press Enter to send it, or choose the paper plane. Shift and Enter adds a new line instead of sending.",
        durationSeconds: 14,
        focus: "chatTyped",
      },
      {
        title: "Watch it work",
        caption: "Aperture Chat is working, with a timer, each step as it lands, and · stop.",
        narration: "Your message moves to the top of the chat, and Aperture Chat is working appears with a timer. Each step lands as it happens, and Next says what comes after it. The answer streams in below. To cancel, choose stop.",
        durationSeconds: 15,
        focus: "chatRunning",
      },
      {
        title: "Stop a reply",
        caption: "Stop keeps any text already written. Here nothing had arrived, so only the note shows.",
        narration: "Stopping keeps whatever was already written, with a note that you stopped it. This reply was stopped before any words arrived, so only the note shows. A stopped reply has no actions of its own, even though the note mentions Regenerate, so edit your message and resend it.",
        durationSeconds: 18,
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
        caption: "The trace now reads Worked for and the time. The chat is listed under Recent.",
        narration: "The new reply arrives under the work trace, which now reads Worked for, the time it took, and the number of steps. The chat takes its title from your request and is listed under Recent in the sidebar.",
        durationSeconds: 14,
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
      "Select your account card at the bottom of the sidebar. Under Preferences and security, choose Manage beside Security.",
      "Under Two-step verification, choose Set up authenticator.",
      "Enter your Current password and choose Continue setup.",
      "In your authenticator app, scan the QR code, or type the Setup key shown under it.",
      "Tick I added this account to my authenticator., type the 6-digit code from the app into Authenticator code, and choose Verify authenticator.",
      "Choose Copy recovery codes and store them somewhere safe. Tick I stored these recovery codes somewhere safe., then choose Done.",
      "Check that the Security row shows On · 10 recovery codes left, and that Two-step verification says Your authenticator is connected.",
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
          "Open Account and read the Security row: the number of recovery codes left has gone down by one.",
          "When few codes remain, replace them.",
        ],
      },
      {
        label: "Replace recovery codes",
        steps: [
          "Account › Security › Manage › Replace recovery codes.",
          "Enter a current Authenticator code (or choose Use a recovery code instead).",
          "Choose Create new recovery codes. The old set stops working at once.",
          "Copy and store the new codes, tick I stored these recovery codes somewhere safe., and choose Done.",
        ],
      },
      {
        label: "Change your password",
        steps: [
          "Account › Password › Change.",
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
      "The Security row shows On with the number of recovery codes left, and Two-step verification says Your authenticator is connected.",
      "Your next password sign-in asks for an Authenticator code.",
      "After signing in with a recovery code, the Security row shows one recovery code fewer.",
      "After a password change, the Password row shows Password updated.",
    ],
    troubleshooting: [
      { symptom: "\"Current password is incorrect.\"", fix: "Retype your current password. If you have forgotten it, ask your administrator for a temporary password." },
      { symptom: "\"The MFA code is invalid.\"", fix: "Wait for the next code and type it promptly. Codes depend on the time, so set your phone's clock to update automatically. A code that was already used is refused." },
      { symptom: "\"Change the temporary password before enrolling MFA.\"", fix: "Sign in and choose your own password first, then set up the authenticator." },
      { symptom: "\"Finish verification or save your recovery codes before leaving this panel.\"", fix: "Complete Verify authenticator, or copy and store the recovery codes and choose Done, before closing the panel." },
      { symptom: "\"Required by your organization. You cannot turn this off.\"", fix: "Your organization requires two-step verification, so Turn off verification is not offered. To move to a new phone, ask your administrator to reset it." },
      { symptom: "\"Your organization manages sign-in. Use your identity provider's security settings…\" or the Security row says \"Managed by your identity provider\"", fix: "You sign in with Organization SSO. Change your password and multifactor settings at your identity provider." },
      { symptom: "The Security row says \"On · No recovery codes left\"", fix: "You have used every code. Choose Manage, then Replace recovery codes, while you still have your authenticator." },
      { symptom: "\"Use a password with at least 12 characters.\" or \"The new passwords do not match.\"", fix: "Use 12 or more characters and type the same new password in both fields." },
      { symptom: "\"Password changes are only available for local password accounts.\"", fix: "Your account signs in with Organization SSO. Change the password at your identity provider." },
    ],
    scenes: [
      {
        title: "Open Security",
        caption: "Account card › Security › Manage opens Two-step verification. The row says whether it is on.",
        narration: "Select your account card at the bottom of the sidebar. Under Preferences and security, choose Manage beside Security. The row says whether an authenticator protects your account, and Two-step verification opens below it. Here it is off.",
        durationSeconds: 16,
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
        narration: "Next come your recovery codes. They are shown only once, and each one signs you in once without your phone. Choose Copy recovery codes and paste them into a password manager, apart from the phone that holds your authenticator. Tick I stored these recovery codes somewhere safe, and choose Done.",
        durationSeconds: 19,
        focus: "securityRecovery",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "Two-step verification is on",
        caption: "The Security row shows On · 10 recovery codes left, and Your authenticator is connected.",
        narration: "The Security row now shows On, with ten recovery codes left, and Two-step verification says your authenticator is connected. From now on, every password sign-in also asks for a code.",
        durationSeconds: 14,
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
        caption: "Back in Account, the Security row shows 9 recovery codes left: the code you used is spent.",
        narration: "Back in Account, the Security row shows nine recovery codes left. The code you just used is spent. When only a few are left, replace them.",
        durationSeconds: 11,
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
        caption: "Password › Change: current password, a new password of 12+ characters, and the confirmation.",
        narration: "To change your password, choose Change beside Password. Enter your current password, a new password of at least twelve characters, and the same new password again. Choose Update password.",
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
      "A message sent with # and $ returns a reply with markers such as [K1], and View N sources → lists what it used.",
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
        narration: "Type the at sign to list the agent profiles you can use. Keep typing to narrow the list.",
        durationSeconds: 7,
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
        narration: "Symbols combine. This message searches the litigation playbook with a hash and follows the citation skill file added with a dollar sign. The reply marks what it took from the playbook, and View two sources lists the playbook file and the skill file. It reads sources, not citations, because an attached file carries no marker.",
        durationSeconds: 22,
        focus: "symbolReply",
      },
      {
        title: "Reach for the right symbol",
        caption: "Hash for your documents, at for a repeated job, dollar for rules this once.",
        narration: "Use hash when the answer must come from your documents, at for a job you repeat, and dollar for rules you want followed this once.",
        durationSeconds: 9,
        focus: "symbolReply",
      },
    ],
  },
  {
    id: "send-options",
    audioSrc: "training/user/send-options.mp3",
    title: "Knowledge, Web, Agent, and reply settings",
    description: "Ground a reply in a knowledge base and check its sources, and choose Web, an agent, reasoning, streaming, and resources for a message.",
    icon: "send",
    track: "Chat",
    outcomes: ["Reply grounded in a knowledge base", "Sources opened", "Web, Agent, reasoning, and streaming understood", "Resource added from the browser"],
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
      "Type your question and send it. Asking it to cite the source after each sentence gets you checkable markers such as [K1].",
      "Check the reply: the work trace says what it found, such as Found 2 passages in workspace knowledge, and a button such as View 1 citation → appears under the answer.",
      "Choose that button to open Session details › Sources gathered, with each file name, K number, and the passage used. Only passages the reply cited are listed. Choose a row to open the document at that passage.",
    ],
    paths: [
      {
        label: "Web",
        steps: [
          "When your workspace connects web search to the model you use, Web is on in every new chat, and the chip under the message box reads Web search.",
          "Send your message. Aperture Chat searches public web sources and gives the results, with their addresses, to the model so the reply can cite them.",
          "To answer without the web, turn off Web in Send options (or choose × on the chip, which turns every option off). That lasts for this chat; the next new chat starts with Web on again.",
          "If Web is greyed out, your workspace has not connected web search to this model. Ask your administrator.",
        ],
      },
      {
        label: "Agent",
        steps: [
          "Send options › Agent. An Agent profile list appears under it.",
          "Choose the profile you want; the line under it counts its knowledge, files, and tools.",
          "Send your message. The finished trace reads Agent worked for and the time, with a Working as step naming the profile. See Agent profiles to build your own.",
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
      "A knowledge reply that cited its sources shows View N citations →, and Sources gathered lists the files and passages.",
      "The reply's trace opens with Routed to and what you switched on, then reports what each option found.",
    ],
    troubleshooting: [
      { symptom: "Web is greyed out: \"Web search is turned off for this model by your workspace configuration\"", fix: "Your workspace has not connected web search to this model. Choose another model, or ask your administrator." },
      { symptom: "With Web on, the reply stays on Aperture Chat is working", fix: "Some self-hosted models currently reject web-search requests. Choose · stop, turn Web off, and resend; tell your administrator." },
      { symptom: "\"Web search (…) is unavailable: … Turn off Web for this reply to continue without it.\"", fix: "The search service could not be reached. Turn Web off for this message, or try again later." },
      { symptom: "A knowledge reply has no View N citations button", fix: "Only sources the reply cited are listed, and this reply wrote no markers such as [K1]. Ask again and add \"cite the source after each sentence\". The trace still says what was found." },
      { symptom: "Knowledge cannot be chosen", fix: "No knowledge base is shared with you. Ask your administrator, or create one if your account can (see Knowledge bases)." },
      { symptom: "\"Create an agent profile in Agents to enable this mode.\"", fix: "No agent profile is available to you. Build one under Agents, or ask your administrator to share one." },
      { symptom: "An agent is listed as \"(needs Hermes approval)\" and cannot be chosen", fix: "It is a Hermes agent. Ask your administrator to turn on Can use Hermes companion for one of your groups." },
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
        caption: "The reply draws on the playbook. View 1 citation opens the source it cited.",
        narration: "The reply answers from the playbook, with a marker after each sentence, and its folded trace counts nine steps and two passed checks. Under the answer, View one citation counts the passages it cited, so two markers to the same passage count once. Asking it to cite after each sentence, as this request does, gets you those markers.",
        durationSeconds: 22,
        focus: "sendKnowledgeReply",
      },
      {
        title: "Check the sources",
        caption: "Sources gathered lists each cited passage with its file and K number.",
        narration: "Choose View one citation. Session details opens at Sources gathered: each passage the reply cited, with its file and K number. Choose the row to open the document at that passage, and check it before you rely on the answer.",
        durationSeconds: 17,
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
        caption: "Once connected, Web is on in every new chat and the chip reads Web search.",
        narration: "Once web search is connected to the model, Web is on in every new chat, and the chip reads Web search. Aperture Chat searches the web for your message and gives the model the results with their addresses, so the reply can cite them. Turn Web off in Send options for a chat that should not use it.",
        durationSeconds: 20,
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
        narration: "The Reasoning slider trades speed for depth. Drag it toward Fast for quick answers, or toward Smart for more careful thinking. It applies only to models that support reasoning levels. Use Fast for short lookups and rewrites, and Smart when the answer needs weighing up.",
        durationSeconds: 18,
        focus: "sendReasoning",
        calloutPlacement: "left-rail",
      },
      {
        title: "Stream replies",
        caption: "Ticked: watch the answer arrive. Cleared: see it only when it is complete.",
        narration: "Stream replies decides how answers appear. Leave it ticked to watch the answer arrive as it is written. Clear it to see each reply only when it is complete. Clear it when you would rather read one finished answer than watch it build.",
        durationSeconds: 16,
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
      "Check the reply: it uses the file's content, the trace includes Read 1 attachment, and View 1 source → lists the file.",
    ],
    paths: [
      {
        label: "Web page by link",
        steps: [
          "Paperclip › Web page by link.",
          "Type or paste the full address into Web page address, such as https://example.com, and choose Add link (or press Enter).",
          "The link appears as a chip. Add up to 3 links per message.",
          "Send your question. The page is fetched when you send, the trace includes Read 1 linked page, and View 1 source → lists it, or View 1 citation → when the reply marks the page.",
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
          "PDF, Excel, and PowerPoint files from your computer: currently only the file name. To ask about their content, add them to a knowledge base, attach them from a cloud source, or open a Word or PDF file in Drafts with Open in editor (in the Drafts paperclip menu).",
        ],
      },
    ],
    verify: [
      "The file chip finishes uploading without Upload failed.",
      "The reply states facts that appear only in your file or page.",
      "A web-page reply offers View 1 source →, or View 1 citation → when it marks the page.",
    ],
    troubleshooting: [
      { symptom: "\"Attachment exceeds the 25 MB chat upload limit.\"", fix: "Split or compress the file, or add it to a knowledge base, which accepts larger files." },
      { symptom: "\"Could not upload the attachment. Check your connection and try again.\"", fix: "Check your connection, remove the failed chip, and attach the file again." },
      { symptom: "The reply says it cannot see the content of a PDF, spreadsheet, or slide file", fix: "Files of those types uploaded from your computer currently reach the model by name only. Use a knowledge base or a cloud source instead, or open a Word or PDF file in Drafts with Open in editor." },
      { symptom: "\"Enter a full web address starting with http:// or https://.\"", fix: "Paste the complete address, including https://." },
      { symptom: "\"You can attach up to 3 web links per message.\"", fix: "Send the first three, then attach the rest in a follow-up message." },
      { symptom: "\"Web source fetch failed for …\"", fix: "The page could not be fetched (it may need a sign-in or be offline). Copy the text into your message instead." },
      { symptom: "\"Google Drive is not ready.\" (or another source)", fix: "Your administrator has not finished that connector. Ask them, or upload the file from your computer." },
      { symptom: "A cloud source, such as Google Drive, is missing from the paperclip menu", fix: "Your workspace administrators hid it (Admin console › Connections › Hide). A hidden source is no longer offered in the attach menu, and the server refuses it with \"Google Drive is not available in this workspace.\" Ask your administrator, or upload the file from your computer." },
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
        narration: "For a P D F or spreadsheet, use a knowledge base, because P D F, Excel, and PowerPoint files from your computer reach the model by name only. Word and text files send their opening text. Images send the picture, if the model can read them. Audio and video send a transcript, when your workspace can transcribe.",
        durationSeconds: 22,
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
        caption: "The page is fetched when you send, and the reply reads it as a source.",
        narration: "The link waits as a chip above the message. The page is fetched when you send, and the reply reads it as a source.",
        durationSeconds: 9,
        focus: "attachLinkChip",
      },
      {
        title: "A reply that uses the page",
        caption: "The reply describes the page and offers View 1 source.",
        narration: "The reply describes the page, and View one source lists the page it read. Open the page yourself before you rely on a summary of it.",
        durationSeconds: 10,
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
      "For diagrams: any available model. Ask for a diagram, flowchart, or process. Mermaid, Graphviz, PlantUML, arrow chains, numbered step or layer lists, and box drawings all render as figures.",
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
          "Ask for a diagram, for example: show the stages of a process as a flowchart.",
          "The reply shows a figure in the workspace's colors, with Copy, PNG, SVG, Code, and Edit in its header. Mermaid, Graphviz (DOT), PlantUML, arrow chains (A → B → C), numbered step or layer lists, and box drawings are all drawn as figures.",
          "Notes the model wrote alongside a text drawing appear under the figure.",
          "Choose Code to read the source exactly as the model wrote it; choose Diagram to switch back. Copy copies that source.",
          "Choose PNG or SVG to download the picture.",
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
      { symptom: "\"This diagram could not be rendered. Open Code to inspect the source, or Edit to fix it.\"", fix: "The model's diagram source has an error. Open Code to see it, then ask the model to correct the diagram, or choose Edit to fix it yourself." },
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
        narration: "To create pictures, choose a model that can generate images, and describe what you want. The images appear right in the reply. This workspace has no image model, so these two frames come from an earlier recording with one, made before the workspace's current look.",
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
        caption: "Mermaid, Graphviz, PlantUML, arrow chains, step lists, and box drawings all render as figures.",
        narration: "Any model can draw diagrams. Ask for a flowchart or a process, and the reply shows a figure in the workspace's colors. The model may write Mermaid, Graphviz, PlantUML, an arrow chain, a numbered list of steps, or a box drawing; each one is drawn as a figure. Here, the model wrote Graphviz. The header offers Copy, P N G, S V G, Code, and Edit.",
        durationSeconds: 24,
        focus: "mermaidFigure",
        captionPlacement: "top",
      },
      {
        title: "Check the code, download the picture",
        caption: "Code shows the source as the model wrote it. PNG or SVG downloads the picture.",
        narration: "Choose Code to see the source exactly as the model wrote it, here Graphviz, and Diagram to switch back. Copy copies that source. Notes the model writes beside a text drawing appear under the figure. Choose P N G or S V G to download the picture for a document or slide.",
        durationSeconds: 19,
        focus: "diagramCode",
      },
    ],
  },
  {
    id: "work-traces",
    audioSrc: "training/user/work-traces.mp3",
    title: "Follow the work trace and act on replies",
    description: "Read what was really done for a reply, rate it with a note, branch it into a new chat, and send it to Drafts as a document, a deck, or a spreadsheet.",
    icon: "trace",
    track: "Chat",
    outcomes: ["Running and finished trace read", "Feedback sent with a note", "Reply branched", "Reply transferred to Drafts in the format you chose"],
    prerequisites: [
      "A chat with an available model (see Start chatting).",
    ],
    setupSteps: [
      "Send a message. Under the reply's heading, the work trace opens by itself: Aperture Chat is working, a timer, each step as it lands, and Next.",
      "To fold it to one line while it runs, choose the arrow beside the timer (Collapse work trace). · stop stays available.",
      "When the reply lands, the trace reads Worked for, the time it took, and the number of steps, such as Worked for 13s · 5 steps.",
      "Choose that line (Expand work trace) to read every step: Routed to names the model, Thought for is the time until the first words arrived, and Delivered the reply gives the length.",
      "Choose it again to fold it (Collapse work trace).",
      "Choose Send positive feedback (thumbs up) or Send negative feedback (thumbs down) under the reply.",
      "Optionally type a note in the box that opens, then choose Send note. Note sent confirms it.",
      "Choose Branch response into new chat to continue from this reply in a separate chat.",
      "Choose Transfer to Drafts, then Word document, Slide deck, or Spreadsheet under Open in Drafts as.",
    ],
    paths: [
      {
        label: "Read the steps",
        steps: [
          "Routed to names the model, and With lists what you switched on: knowledge, web search, tools, attachments.",
          "Then what was really gathered: Found 2 passages in workspace knowledge, Searched the web, Read 1 attachment, Read 1 linked page, Recalled 2 memories, or Working as and an agent's name.",
          "Thought for is the time until the first words arrived. Wrote the reply, Wrote python, Drew a diagram, and Built a table name what the reply holds.",
          "Checks on the finished reply count in the summary, such as 1 check passed: Verified, Code blocks are all closed, Every citation links to a source.",
          "A flag in amber is a problem to read before you rely on the reply, such as A code block was left open.",
        ],
      },
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
        label: "Transfer as a Word document",
        steps: [
          "Choose Transfer to Drafts at the right of the reply's actions.",
          "Under Open in Drafts as, choose Word document.",
          "Drafts opens a new document titled after the chat, saved as Version 1, with the reply and any citations.",
          "Edit it, save versions, and export it to Word or PDF (see Draft documents).",
        ],
      },
      {
        label: "Transfer as a slide deck",
        steps: [
          "Choose Transfer to Drafts, then Slide deck.",
          "Drafts opens the deck editor, with slides built from the reply's headings and points.",
          "A reply with headings and short points makes the best deck. See Build a slide deck.",
        ],
      },
      {
        label: "Transfer as a spreadsheet",
        steps: [
          "Choose Transfer to Drafts, then Spreadsheet. The line under it says what will happen, such as Its table becomes a sheet.",
          "Each table in the reply becomes a sheet, with the edits you made in chat. A reply with no table puts its lines down the first column.",
          "See Edit tables and diagrams in a reply.",
        ],
      },
    ],
    verify: [
      "The finished trace reads Worked for and the time, and Routed to names the model.",
      "Note sent appears beside the reply's actions after sending a note.",
      "A chat titled Branch: … appears under Recent.",
      "Drafts opens the reply in the format you chose, as Version 1, and the assistant rail says it was transferred.",
    ],
    troubleshooting: [
      { symptom: "Thinking keeps counting and no words arrive", fix: "The model is busy or slow. Wait, or choose · stop and resend. Thought for records how long the first words took." },
      { symptom: "\"Connection dropped — resumed where it left off\"", fix: "The connection dropped and the reply picked up again, so nothing is needed. If it repeats with no words arriving, choose · stop and resend when the model is less busy." },
      { symptom: "A step lands just after the reply appears", fix: "Steps play in one at a time, so the trace can finish a moment after the reply. The finished trace is the record." },
      { symptom: "\"A code block was left open\"", fix: "The reply ends inside a code block, so it may be cut off. Ask it to continue, or regenerate." },
      { symptom: "\"HTML page ends early\"", fix: "There is no closing tag, so the page may be cut off. Ask it to finish the page, or regenerate." },
      { symptom: "\"Not met: …\"", fix: "A check found something you asked for missing from the reply. Regenerate or ask a follow-up to cover it." },
      { symptom: "\"Not met: Deliver the complete long-form piece\" on a short answer", fix: "This is a known false alarm, not a fault in the reply. The check treats words such as brief, draft, memo, report, paper, page, or complete as a request for a long piece of at least 1,200 words, even in a one-line question. If the short answer is what you wanted, ignore the flag. You do not need to regenerate." },
      { symptom: "A flag says the reply cites a marker \"with no source\"", fix: "Those markers have nothing behind them in this reply. Do not rely on those claims until you have checked them." },
      { symptom: "\"Could not branch\"", fix: "The branch could not be created, often because the connection dropped. Try again when the chat has saved." },
      { symptom: "No actions under a reply", fix: "Actions appear only on finished replies. A stopped or failed reply has none; resend with Edit message." },
      { symptom: "Transfer to Drafts is missing", fix: "It appears on finished replies with text. Wait for the reply to finish." },
    ],
    scenes: [
      {
        title: "While the reply runs",
        caption: "Aperture Chat is working, a timer, each step as it lands, and what comes Next.",
        narration: "While a reply runs, the work trace stays open under its heading. Aperture Chat is working, with a timer. Every line is something that really happened: here, the model it was routed to and two memories it recalled. Steps land one at a time, and Next is a hint at what comes after, not a promise.",
        durationSeconds: 20,
        focus: "chatRunning",
      },
      {
        title: "Fold it to one line",
        caption: "The arrow beside the timer folds the running trace. · stop stays available.",
        narration: "Want more room? Choose the arrow beside the timer. The trace folds to one line that still names the current step, with Next under it, and stop stays available. Your choice carries over when the reply lands.",
        durationSeconds: 14,
        focus: "traceRunningFolded",
      },
      {
        title: "The trace after the reply",
        caption: "Worked for, the time it took, and the number of steps sit above the finished reply.",
        narration: "When the reply lands, the line reads Worked for, then the time it took and the number of steps. A chat you reopen later starts folded, like this.",
        durationSeconds: 10,
        focus: "traceCollapsed",
      },
      {
        title: "Expand every step",
        caption: "Routed to names the model. Thought for is the time until the first words arrived.",
        narration: "Choose that line to expand it. Routed to names the model that answered. Recalled counts the memories it used. Thought for is the time until the first words arrived. Then come Wrote the reply, and Delivered the reply, with its length in words.",
        durationSeconds: 17,
        focus: "traceExpanded",
        captionPlacement: "top",
        calloutPlacement: "lower-right",
      },
      {
        title: "What you turn on shows up here",
        caption: "What was found, then the checks on the finished reply.",
        narration: "This reply searched a knowledge base, and the trace says what it found: two passages from two sources. After the reply come the checks. Verified means something you asked for was met, and Every citation links to a source means each marker has a document behind it. The summary counts the checks that passed.",
        durationSeconds: 21,
        focus: "traceKnowledge",
        calloutPlacement: "lower-right",
      },
      {
        title: "Read a flag",
        caption: "An amber step is a flag: something you asked for may be missing.",
        narration: "An amber step is a flag, and the header counts it. Here the request asked for sources, and the reply names some with no link or marker, so the check is right: the model wrote them from memory, and they may not exist. Turn on Knowledge or Web and ask again. Flags can be wrong, so check the reply yourself.",
        durationSeconds: 20,
        focus: "traceFlag",
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
        caption: "Transfer to Drafts, at the right of the actions, asks which editor to open.",
        narration: "To keep working on a reply outside the chat, choose Transfer to Drafts at the right of its actions.",
        durationSeconds: 8,
        focus: "transferDraft",
        calloutPlacement: "lower-left",
      },
      {
        title: "Choose the format",
        caption: "Word document, Slide deck, or Spreadsheet. Suggested marks the best fit.",
        narration: "Open in Drafts as offers three editors: Word document, Slide deck, and Spreadsheet. Suggested marks the one that fits what you asked for and what the reply holds, and Enter takes it. Each option says what it will do with this reply. For a table, Spreadsheet is usually the one you want.",
        durationSeconds: 20,
        focus: "transferMenu",
        calloutPlacement: "lower-left",
      },
      {
        title: "Your reply, now a document",
        caption: "Word document opens the reply as Version 1 of a saved document, ready to edit and export.",
        narration: "Word document opens a new document titled after the chat, saved as version one, with the reply's text and formatting. The assistant rail notes where it came from. Edit it, save versions, and export it, as the Draft documents lesson shows.",
        durationSeconds: 17,
        focus: "chatTransferred",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "The same reply as a deck",
        caption: "Slide deck builds slides from the reply's headings and points.",
        narration: "Slide deck opens the deck editor instead, with slides built from the reply's headings and points. A reply with clear headings makes the best deck, so ask for them first if you plan to present it. The original chat stays as it was.",
        durationSeconds: 16,
        focus: "chatTransferredDeck",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "code-in-chat",
    audioSrc: "training/user/code-in-chat.mp3",
    title: "Work with code in chat",
    description: "Read highlighted code, save it as a named file, edit it in place, have AI change only the lines you select, and run a page in the artifact canvas.",
    icon: "commands",
    track: "Chat",
    outcomes: ["Code saved as a named file", "Code edited and saved into the reply", "Selected lines changed with AI", "Page run and edited in the artifact canvas"],
    prerequisites: [
      "A chat with an available model. Ask AI uses the model selected for the chat.",
      "Preview runs HTML, SVG, and CSS. Other languages open in the canvas as source.",
    ],
    setupSteps: [
      "Ask for code, and name the language and the function or page you want.",
      "Read the code block: its language, its line count, and numbered, colored lines. Colors work out the language even when the reply did not name it.",
      "Choose Copy to copy the code, or Download to save it as a named file.",
      "Choose Edit, change the code, and choose Done (or press Esc). Saved appears in the toolbar.",
      "Choose Undo to put back the code from before your last edit.",
      "Select lines in the block with the pointer. Choose Ask AI, or press ⌘J (Ctrl+J on Windows).",
      "Choose an action such as Add comments, or type your own instruction, and press Enter.",
      "Read the suggestion's line changes, then choose Replace or Discard.",
      "On an HTML, SVG, or CSS block, choose Preview to run it in the artifact canvas.",
    ],
    paths: [
      {
        label: "Download",
        steps: [
          "Choose Download in the block's toolbar. Pointing at it shows the name it will use.",
          "The name comes from a filename in the block, then an HTML or SVG title, then the main function or class, then the nearest heading.",
        ],
      },
      {
        label: "Edit in place",
        steps: [
          "Choose Edit. The block becomes an editor with the same colors.",
          "Tab indents, Shift+Tab outdents, and Esc finishes.",
          "Choose Done. Saved appears, and the edit is part of the reply, so Copy, Download, and Transfer to Drafts all carry it.",
          "Undo puts back the code from before your last edit.",
        ],
      },
      {
        label: "Ask AI on a selection",
        steps: [
          "Select the lines you want changed, in the block or in the editor.",
          "Choose Ask AI, or press ⌘J (Ctrl+J on Windows).",
          "Choose Fix bugs, Simplify, Add comments, Add error handling, Use clearer names, Add types, or Modernize syntax, or type your own instruction.",
          "The suggestion shows lines added and removed. Type a follow-up to refine it, or choose Try again for another version.",
          "Choose Replace to write it in, or Discard to leave your code as it was.",
          "Only the lines you selected change.",
        ],
      },
      {
        label: "Artifact canvas",
        steps: [
          "Choose Preview on a code block. The canvas slides in from the right.",
          "Preview runs the page; Code shows the numbered source. Edit, Done, and Undo work here too, and Ask AI works on lines you select in the code.",
          "Use the arrows to move between the code blocks in this chat.",
          "Choose Expand the canvas to the full window for more room, and Close the artifact canvas (or Esc) to return to the chat.",
          "The pull tab at the right edge of the chat reopens it.",
        ],
      },
    ],
    verify: [
      "Download saves a file with the code and a meaningful name, such as renewals_due.py.",
      "Saved appears after Done, and the code keeps your edit when you reopen the chat.",
      "After Replace, the suggestion shows in the block with Saved, and Undo offers the earlier code.",
      "Preview shows the running page, and an edit to its source changes the preview.",
    ],
    troubleshooting: [
      { symptom: "\"Edited here only\"", fix: "The edit could not be saved to the reply, so it lives on this screen. Copy your code, reload the chat, and edit again." },
      { symptom: "Edit and Ask AI are missing", fix: "They appear when the reply has finished. Wait for it, or choose · stop." },
      { symptom: "\"The code changed since you selected it. Close this and select the code again.\"", fix: "The code moved under the selection. Close the box and select the lines again." },
      { symptom: "\"Choose a model in the composer to edit code with AI.\"", fix: "Choose a model in the model selector at the top right, then select the code again." },
      { symptom: "Edit code with AI shows \"System message must be at the beginning.\"", fix: "Some self-hosted models accept only one system message, so they refuse this request. Choose another model, or ask for the change in chat and paste it in with Edit." },
      { symptom: "\"Personal data was hidden from the model. Check the ⟦ ⟧ placeholders.\"", fix: "Your organization conceals personal data, so the suggestion holds placeholders. Replace them before you accept it." },
      { symptom: "Preview shows only the source", fix: "Preview runs HTML, SVG, and CSS. Other languages open as source, and you run them yourself." },
      { symptom: "A page in the canvas cannot reach the internet or another site's files", fix: "The canvas runs pages in a sandbox. Ask for one self-contained page with inline CSS and scripts." },
      { symptom: "\"A code block was left open\" or \"HTML page ends early\" in the trace", fix: "The reply was cut off. Ask it to continue, or regenerate." },
    ],
    scenes: [
      {
        title: "Ask for code",
        caption: "Name the language and what you want. The trace shows Wrote python and its checks.",
        narration: "Ask for code, and name the language and what you want, as this request does. The work trace shows what came back: Wrote python, with its line count, then the checks. Code blocks are all closed means the reply was not cut off.",
        durationSeconds: 16,
        focus: "codeTrace",
        calloutPlacement: "lower-right",
      },
      {
        title: "Read the block",
        caption: "Language, line count, numbered lines, and colors that follow the language.",
        narration: "The reply shows a code block with its language, its line count, and numbered lines. The colors follow the language, even when the reply did not name it.",
        durationSeconds: 11,
        focus: "codeBlock",
      },
      {
        title: "Download a named file",
        caption: "Copy copies the code. Download saves a named file, here renewals_due.py.",
        narration: "Copy puts the code on your clipboard. Download saves it as a file with a meaningful name, taken from the code: here, renewals underscore due dot p y. Point at Download to see the name first.",
        durationSeconds: 14,
        focus: "codeDownload",
      },
      {
        title: "Edit it in place",
        caption: "Edit turns the block into an editor. Tab indents, and Esc finishes.",
        narration: "To change the code yourself, choose Edit. The block becomes an editor with the same colors. Here, thirty days becomes forty-five. Tab indents, Shift and Tab outdents, and Escape finishes.",
        durationSeconds: 14,
        focus: "codeEditing",
      },
      {
        title: "Saved into the reply",
        caption: "Saved means the change is part of the reply. Undo puts back the earlier code.",
        narration: "Choose Done. Saved appears, and the change is now part of the reply, so Copy, Download, and Transfer to Drafts all carry it. Undo puts back the code from before your last edit.",
        durationSeconds: 13,
        focus: "codeSaved",
      },
      {
        title: "Select lines for AI",
        caption: "Select lines, then choose Ask AI, or press ⌘J (Ctrl+J on Windows).",
        narration: "To have AI change part of the code, select those lines. Ask AI appears above them. Command J does the same, or Control J on Windows.",
        durationSeconds: 11,
        focus: "codeAskAi",
      },
      {
        title: "Say what to change",
        caption: "Choose an action, or type your own instruction. Only the selected lines change.",
        narration: "Edit code with AI names the lines it will change. Choose Fix bugs, Simplify, Add comments, Add error handling, Use clearer names, Add types, or Modernize syntax, or type your own instruction. Only the lines you selected change.",
        durationSeconds: 17,
        focus: "codeAiMenu",
        calloutPlacement: "upper-right",
      },
      {
        title: "Review the suggestion",
        caption: "The suggestion shows the lines added and removed. Nothing has changed yet.",
        narration: "The suggestion shows the lines added and removed, in the block's colors. Nothing in your code has changed yet. Replace writes it in, Try again asks for another version, and Discard drops it.",
        durationSeconds: 13,
        focus: "codeAiReview",
        calloutPlacement: "upper-right",
      },
      {
        title: "Refine it",
        caption: "Type a follow-up under the suggestion, and the model reworks it.",
        narration: "Not quite right? Type a follow-up under the suggestion, and the model reworks it. Here the follow-up asks for short comments, and the comment comes back shorter. A follow-up saves you from starting over.",
        durationSeconds: 14,
        focus: "codeAiRefined",
        calloutPlacement: "upper-right",
      },
      {
        title: "Replace, or Discard",
        caption: "Replace changes only the selected lines. Discard leaves your code as it was.",
        narration: "Choose Replace, and only the lines you selected change. Saved appears, and Undo puts back the earlier code. Discard closes the box and leaves your code as it was.",
        durationSeconds: 12,
        focus: "codeAiApplied",
      },
      {
        title: "Ask for something you can run",
        caption: "Preview runs HTML, SVG, and CSS in the artifact canvas.",
        narration: "For something you can run, ask for one self-contained H T M L file, as this request does. Then choose Preview on the block. It runs H T M L, S V G, and C S S. Other languages open as source.",
        durationSeconds: 16,
        focus: "canvasReply",
      },
      {
        title: "The artifact canvas",
        caption: "The canvas runs the page beside your chat. The arrows step through this chat's code.",
        narration: "The artifact canvas slides in from the right and runs the page in a sandbox, beside your chat. The title shows the file name and line count. The arrows step through the code blocks in this chat, here two of two.",
        durationSeconds: 15,
        focus: "canvasPreview",
        calloutPlacement: "left-rail",
      },
      {
        title: "Read the source",
        caption: "Code shows the numbered source. Edit, Copy, and Download work here too.",
        narration: "Choose Code to read the numbered source. Edit, Copy, and Download work here as they do in the chat.",
        durationSeconds: 8,
        focus: "canvasCode",
        calloutPlacement: "left-rail",
      },
      {
        title: "Edit, then see the change",
        caption: "After Done, Saved appears, and Preview shows the change.",
        narration: "Here the heading was edited in Code. Choose Done, and Saved appears. Back in Preview, the page shows the new heading. Download uses the new name too, because this file takes its name from the page title.",
        durationSeconds: 15,
        focus: "canvasEdited",
        calloutPlacement: "left-rail",
      },
      {
        title: "More room",
        caption: "Expand takes the whole window. Reload restarts the page.",
        narration: "Need more room? Choose the expand button for the full window, and the same button restores it. Reload restarts the page from the beginning, which helps with games and animations.",
        durationSeconds: 12,
        focus: "canvasExpanded",
      },
      {
        title: "Back to the chat",
        caption: "The pull tab reopens the canvas and counts the code blocks in this chat.",
        narration: "Close the canvas, or press Escape, to return to the chat. The pull tab at the right edge reopens it, and counts the code blocks here. Your edit is saved in the reply.",
        durationSeconds: 12,
        focus: "canvasTab",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "edit-replies",
    audioSrc: "training/user/edit-replies.mp3",
    title: "Edit tables and diagrams in a reply",
    description: "Correct a table where it sits, send it to a spreadsheet, and restyle, rearrange, and export a diagram, all without asking the model again.",
    icon: "drafts",
    track: "Chat",
    outcomes: ["Table corrected in the reply", "Edited table opened as a spreadsheet", "Diagram restyled and rearranged", "Diagram saved as a picture"],
    prerequisites: [
      "A chat with an available model, and a finished reply with a table or a diagram. The tools appear once the reply has finished.",
      "Style, dragging, and arrow handles work on structure diagrams, the boxes-and-arrows charts labeled Structure diagram. Other figures, such as a pie chart or a timeline, offer Edit on their source.",
    ],
    setupSteps: [
      "Ask for a table. Saying markdown table keeps the answer in chat.",
      "Click a cell, type the new value, and press Tab to move to the next cell or Enter to move down.",
      "Use Add row, Add column, Delete row, or Delete column under the table. Undo steps back.",
      "Choose Done.",
      "Choose Transfer to Drafts, then Spreadsheet, to open the edited table as a sheet.",
      "Ask for a flowchart, org chart, or process flow, and name the boxes.",
      "On the diagram, choose Style, then a theme, Connectors, and Corners.",
      "Drag a box to move it. Its arrows follow.",
      "With a box selected, choose Header color and a swatch.",
      "Click an arrow, and drag its round handle to bend it.",
      "Choose PNG or SVG to save the chart as a picture.",
    ],
    paths: [
      {
        label: "Edit a table",
        steps: [
          "Click any cell, or point at the table and choose Edit table to start at the first header.",
          "Type. Tab moves to the next cell, Enter moves down, Shift goes back, and Esc cancels the open cell.",
          "Add row and Add column work from the cell you are in. Delete row and Delete column remove its row or column.",
          "Undo steps back through your changes. Done closes the tools.",
          "Your edits are saved into the reply, so Copy and Transfer to Drafts carry them.",
        ],
      },
      {
        label: "Send a table to a spreadsheet",
        steps: [
          "Choose Transfer to Drafts. Spreadsheet is marked Suggested when the reply is mostly a table.",
          "Check the line under it, such as Its table becomes a sheet, as edited here.",
          "Choose Spreadsheet. Each table becomes its own sheet, with a bold frozen header.",
          "See Build a spreadsheet with the assistant.",
        ],
      },
      {
        label: "Restyle a diagram",
        steps: [
          "Choose Style in the diagram's toolbar.",
          "Choose a theme: Aperture, Graphite, Forest, Indigo, Plum, Ember, Soft, or Blueprint.",
          "Under Connectors, choose Elbow, Curved, or Straight. Under Corners, choose Rounded or Square.",
          "Every choice applies and saves at once. Choose Style again to close the tray.",
        ],
      },
      {
        label: "Rearrange boxes and arrows",
        steps: [
          "Drag a box by its body. Guides help it line up, and its arrows follow.",
          "Click text in a box to retype it. With a box selected, the arrow keys nudge it, and Shift moves it further.",
          "Point at a box for its chip: move it between rows, choose Header color, show it as a banner, or delete it.",
          "Click an arrow for its chip: Solid, Dashed, or Dotted, reverse it, or edit its label. Drag either end to another box.",
          "An arrow with a corner has a round handle to bend it. An arrow running straight between aligned boxes has none, and Straight connectors have none.",
          "⌘Z (Ctrl+Z on Windows) undoes a change. Reset layout puts dragged boxes back and straightens bent arrows.",
        ],
      },
      {
        label: "Edit in a form, or by its source",
        steps: [
          "Choose Edit to open Edit diagram, a form for every box, its details, and the arrows, with a live preview.",
          "Choose Code to read the source as the model wrote it. Copy copies that source.",
          "On a pie chart, timeline, or other figure, Edit is the way to change it.",
        ],
      },
    ],
    verify: [
      "Reopen the chat: the table and the diagram keep your changes.",
      "The spreadsheet shows your edited values and any row you added.",
      "PNG and SVG download the chart as drawn, with your theme, colors, and layout.",
    ],
    troubleshooting: [
      { symptom: "\"Build this as a spreadsheet?\" appears instead of a reply", fix: "Asking for a table can offer the spreadsheet editor. Choose Continue in chat for a reply here, or Build in spreadsheet editor." },
      { symptom: "\"That edit could not be saved. The reply changed underneath it; try again.\"", fix: "The reply changed while you were typing. Open the cell again and retype the change." },
      { symptom: "Style is missing from a diagram", fix: "Style appears on structure diagrams. Ask again for a flowchart with boxes and arrows, or use Edit on this figure." },
      { symptom: "The boxes have no arrows", fix: "Ask for them in words, such as connect each box to the next box with an arrow, or add them with Edit." },
      { symptom: "An arrow has no round handle", fix: "It runs straight between aligned boxes, or Connectors is set to Straight. Drag a box out of line, or choose Elbow or Curved." },
      { symptom: "Reset layout is greyed out", fix: "Nothing has been dragged or bent yet." },
      { symptom: "\"The reply was cut off mid-diagram — showing everything that arrived. Use Edit to finish the chart, or regenerate the reply.\"", fix: "Choose Edit to finish the chart, or regenerate the reply." },
      { symptom: "\"Diagram source needs repair\"", fix: "The chart's structure is incomplete. Ask for the diagram again." },
      { symptom: "\"Saving failed — try again.\"", fix: "The Edit diagram change did not save. Check your connection and choose Save diagram again." },
    ],
    scenes: [
      {
        title: "A table in a reply",
        caption: "Every table in a finished reply can be edited where it sits.",
        narration: "Ask for a comparison in a table. Every table in a finished reply can be edited where it sits, without asking the model again. That saves a round trip when one value is wrong.",
        durationSeconds: 13,
        focus: "tableReply",
      },
      {
        title: "Click a cell and type",
        caption: "Tab moves across, Enter moves down, and Esc cancels the open cell.",
        narration: "Click a cell and type. Here the annual cost changes. Tab moves to the next cell and Enter moves down, as in a spreadsheet, and Escape cancels the cell you are in. The tools under the table add and delete rows and columns.",
        durationSeconds: 16,
        focus: "tableEditing",
      },
      {
        title: "Add a row",
        caption: "Add row puts a row under the current cell. Undo steps back, and Done closes the tools.",
        narration: "Add row puts an empty row under the current cell. Fill it in, with Tab moving across. Undo steps back through your changes, and Done closes the tools.",
        durationSeconds: 12,
        focus: "tableRowAdded",
      },
      {
        title: "Send it to a spreadsheet",
        caption: "Spreadsheet is Suggested here: Its table becomes a sheet, as edited here.",
        narration: "Your edits are part of the reply, so what you do next carries them. Choose Transfer to Drafts. Spreadsheet is suggested here, and it says what will happen: its table becomes a sheet, as edited here.",
        durationSeconds: 14,
        focus: "tableTransfer",
        calloutPlacement: "lower-left",
      },
      {
        title: "The edited table as a sheet",
        caption: "The table opens as a sheet with a bold frozen header, and your edits.",
        narration: "The spreadsheet editor opens with your table on its own sheet, under a bold frozen header, with your new cost and your new row. A reply with several tables gets a sheet for each. The spreadsheet lessons go on from here.",
        durationSeconds: 15,
        focus: "tableSheet",
        calloutPlacement: "left-rail",
      },
      {
        title: "A diagram you can edit",
        caption: "Ask for a process flow. The reply draws a structure diagram with its own toolbar.",
        narration: "Ask for a flowchart, an org chart, or a process flow, and name the boxes. Short titles make the cleanest chart. The reply draws a structure diagram, with Copy, P N G, S V G, Code, Style, and Edit in its toolbar.",
        durationSeconds: 16,
        focus: "diagramStructure",
      },
      {
        title: "Choose a theme",
        caption: "Style opens the tray. A theme recolors the whole chart and saves at once.",
        narration: "Choose Style. Eight themes are offered: Aperture, Graphite, Forest, Indigo, Plum, Ember, Soft, and Blueprint. A theme recolors the whole chart, and the choice saves at once. Here, Forest.",
        durationSeconds: 14,
        focus: "diagramTheme",
        calloutPlacement: "lower-left",
      },
      {
        title: "Connectors and corners",
        caption: "Connectors: Elbow, Curved, or Straight. Corners: Rounded or Square.",
        narration: "Connectors sets how arrows run: Elbow, Curved, or Straight. Corners sets the box shape: Rounded or Square. Reset layout puts dragged boxes back and straightens bent arrows.",
        durationSeconds: 13,
        focus: "diagramConnectors",
        calloutPlacement: "lower-left",
      },
      {
        title: "Drag a box",
        caption: "Drag a box anywhere. Its arrows follow, and guides help it line up.",
        narration: "Drag a box by its body to place it anywhere. Its arrows follow, and guides help it line up. Click the text in a box to retype it, and with a box selected, the arrow keys nudge it.",
        durationSeconds: 13,
        focus: "diagramDragged",
      },
      {
        title: "Recolor one box",
        caption: "The chip beside a box holds Header color and its swatches.",
        narration: "Point at a box and a small chip appears beside it. It moves the box between rows, changes its header color, turns it into a banner, and deletes it. Choose Header color to see the swatches.",
        durationSeconds: 13,
        focus: "diagramCardSwatches",
      },
      {
        title: "One box, one color",
        caption: "Only that box changes. The rest keep the theme.",
        narration: "Choose a swatch, and only that box changes. The rest keep the theme, so one color can mark the step that matters.",
        durationSeconds: 9,
        focus: "diagramCardColor",
      },
      {
        title: "Bend an arrow",
        caption: "Click an arrow for its chip. An arrow with a corner has a round handle to bend it.",
        narration: "Click an arrow to select it. Its chip sets Solid, Dashed, or Dotted, reverses it, and edits its label. An arrow with a corner has a round handle: drag it to bend the arrow. Drag either end to connect it to another box.",
        durationSeconds: 16,
        focus: "diagramArrow",
      },
      {
        title: "Save the picture",
        caption: "PNG and SVG save the chart as drawn, with your theme and layout.",
        narration: "Choose P N G for a picture, or S V G for a drawing that stays sharp at any size. Both save the chart as drawn, with your theme, colors, and layout. Your changes are saved in the reply, so they are still here when you reopen the chat.",
        durationSeconds: 16,
        focus: "diagramPng",
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
      "A chat with at least one reply. Sources gathered appears after a reply that cited knowledge or the web, or that had a file attached.",
    ],
    setupSteps: [
      "In a chat, choose Session info (the i button at the top right). Session details opens on the right.",
      "Read Session summary: Current chat, Tokens used, Model, Knowledge bases, Tools, and Agent profile.",
      "Read Context window: the meter and how many of the model's tokens this chat already uses.",
      "Scroll to Sources gathered to see the sources behind your replies, with each K (knowledge) or W (web) number and the passage. Choose a document row to open it at that passage.",
      "Scroll to Symbol shortcuts for the five symbols you can type in the message box.",
      "Choose Close session details when you are done.",
    ],
    paths: [
      {
        label: "From a reply's sources",
        steps: [
          "Under a reply, choose View N citations → (or View N sources →, when the list includes something the reply consulted without citing it).",
          "Session details opens at Sources gathered, with that reply under Selected response. The same button then reads Hide citations or Hide sources and closes it again.",
          "Choose a document row to read it on the cited page. See Check a source: open the cited document.",
        ],
      },
    ],
    verify: [
      "Tokens used shows the counts the provider reported (in, out, and total), or Not reported by the provider.",
      "The context window meter shows a percentage and tokens used of the model's total.",
      "Selected response under Sources gathered lists the same number of sources as the button under the reply.",
    ],
    troubleshooting: [
      { symptom: "Tokens used reads \"Not reported by the provider\"", fix: "The model service did not return usage. Nothing is wrong with your chat; the context meter may use an estimate instead." },
      { symptom: "The context meter is marked estimated or ≈", fix: "It is based on message length, because the provider did not report usage for some messages." },
      { symptom: "The context window is nearly full", fix: "Start a new chat for a fresh window. Older details may otherwise matter less to the answer." },
      { symptom: "No Sources gathered section", fix: "No reply in this chat cited a source or had a file attached. Turn on Knowledge in Send options, and ask it to cite the source after each sentence." },
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
        caption: "Sources gathered lists what the reply cited, with its K or W number and the passage.",
        narration: "After a reply that cited knowledge or the web, Sources gathered lists each source with its number and the passage the answer relied on. The button under a reply jumps straight here, and choosing a document row opens it at that passage.",
        durationSeconds: 16,
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
    id: "check-sources",
    audioSrc: "training/user/check-sources.mp3",
    title: "Check a source: open the cited document",
    description: "Open the document behind an answer, land on the cited page with the passage marked, and check it before you rely on it.",
    icon: "knowledge",
    track: "Chat",
    outcomes: ["Cited document opened on the cited page", "Passage checked against the reply", "Original file downloaded", "Library file previewed"],
    prerequisites: [
      "A knowledge base you can search, your own or one shared with you. Knowledge bases shows how to build one.",
      "Documents uploaded since this release. Older ones open as their indexed text until someone who manages the knowledge base uploads them again.",
      "For Word, PowerPoint, and Excel layouts: a server that can convert them. Otherwise they open as text, with a note saying so.",
    ],
    setupSteps: [
      "In a chat, type # and choose your knowledge base, then type a plain question and send it.",
      "Under the reply, choose View N citations →. If the list also holds something the reply did not mark, such as an attached file or a web result, it reads View N sources →. Session details opens at Sources gathered.",
      "Read a row: the file, its K number, the page or Opens at the passage, and the cited sentence. Only documents the reply cited are listed.",
      "Choose the row. The document opens on the cited page with the sentence marked and its passage shaded.",
      "Read Cited passage at the top and compare it with the reply. Choose Show more, when it appears, for the whole passage.",
      "Use Previous page and Next page, or type a number in the page box and press Enter. Use Zoom in and Zoom out to change the size.",
      "Choose Go to the cited passage to return to the mark.",
      "Choose Download original to save the file as it was uploaded.",
      "Choose Close document, or press Escape, to return to the chat.",
    ],
    paths: [
      {
        label: "From a marker in the reply",
        steps: [
          "In the reply, choose a K marker such as K1 beside the fact you want to check.",
          "The document opens at the same page and passage as its row in Sources gathered.",
          "A W marker opens the web page it cites in a new browser tab.",
        ],
      },
      {
        label: "From the Library",
        steps: [
          "Choose Library in the sidebar; Knowledge opens.",
          "Open a knowledge base and find the file on Files.",
          "Choose Preview (the eye), or the file's name.",
          "The file opens at the first page with no Cited passage, because nothing was cited.",
        ],
      },
    ],
    verify: [
      "The viewer shows the page the row named, or the passage's page if the row named none, with the cited sentence marked.",
      "Cited passage matches the marked sentence and supports what the reply said.",
      "Go to the cited passage returns to the mark after you move away.",
      "The downloaded file is the document that was uploaded.",
    ],
    troubleshooting: [
      { symptom: "No View citations button under a reply", fix: "The reply wrote no marker, so nothing is listed. Check that the knowledge base is chosen, ask again and add \"cite the source after each sentence\", and treat an unsourced answer as unchecked." },
      { symptom: "A document you expected is not in Sources gathered", fix: "Only documents the reply wrote a marker for are listed, even if the trace found passages in others. Ask about that document by name." },
      { symptom: "A source is listed, but its passage has nothing to do with the answer", fix: "Listed means the reply wrote the marker, not that the passage supports it. A reply can name passages only to say they did not help. Open the source and read it. That is what this lesson is for." },
      { symptom: "\"The original file is not available, so this shows the text that was indexed.\"", fix: "The document was uploaded before originals were kept. Ask whoever manages the knowledge base to upload it again and remove the old copy, because an upload adds a new document. A connected source gets its originals at the next sync." },
      { symptom: "\"This server cannot show this file type with its original layout, so this shows the text that was indexed.\"", fix: "The server has no converter for this file type. The text and the passage are still shown. Download the original to see its layout." },
      { symptom: "\"The original layout could not be prepared, so this shows the text that was indexed.\"", fix: "The conversion failed for this file. Download the original to read it." },
      { symptom: "\"These words could not be marked on this page, so they are shown here.\"", fix: "The page's text differs from what was indexed, as a scan can. Read Cited passage, then find the words on the page." },
      { symptom: "\"The cited sentence could not be picked out on this page, so the whole passage is shaded.\"", fix: "Read the shaded passage for the sentence." },
      { symptom: "\"This is the best match for the passage, not an exact location.\"", fix: "The page is the closest match. Check the pages around it." },
      { symptom: "\"This passage has moved or was removed, so this opens at the page it was cited from.\"", fix: "The document changed after the reply was written. Check that the reply still holds, and ask again." },
      { symptom: "\"This document is no longer available\"", fix: "It was removed, or you no longer have access to it. Ask the knowledge base's owner." },
      { symptom: "\"This PDF is protected by a password\"", fix: "It cannot be shown here. Choose Download original and open it with its password." },
      { symptom: "\"Download failed. Try again.\"", fix: "Choose Download original again. If it keeps failing, check your connection." },
    ],
    scenes: [
      {
        title: "Ask from your documents",
        caption: "Type #, choose the knowledge base, and ask a plain question.",
        narration: "An answer is only as good as the page behind it, so check that page before you rely on it. Start in a chat. Type a hash, choose your knowledge base, and ask a plain, specific question. This shared knowledge base holds a twelve page P D F, a Word file, and a short F A Q.",
        durationSeconds: 19,
        focus: "sourcesQuestion",
      },
      {
        title: "The trace shows what was searched",
        caption: "The trace counts the passages found. That is what was searched, not what was cited.",
        narration: "The trace shows what was searched. Here it found passages from all three documents. Finding a passage does not mean the reply cited it, so the source list is decided after the reply is written.",
        durationSeconds: 13,
        focus: "sourcesTrace",
        calloutPlacement: "left-rail",
      },
      {
        title: "The reply marks what it cites",
        caption: "K markers show where each fact came from. View 2 citations opens the list.",
        narration: "Fold the trace to read the answer. K markers show where each fact came from. Their numbers count every passage searched, so K three and K four are normal. View two citations counts only the passages the reply marked. If the list also holds something unmarked, such as an attached file, it reads View sources.",
        durationSeconds: 21,
        focus: "sourcesReply",
      },
      {
        title: "Only cited documents are listed",
        caption: "Sources gathered lists the two documents the reply cited, not the third it searched.",
        narration: "Choose View citations. Session details opens at Sources gathered. It lists the two documents the reply cited, and leaves out the F A Q, which was searched but not cited. Listed means the reply wrote a marker. Anything it drew on without one stays off this list.",
        durationSeconds: 19,
        focus: "sourcesPanel",
        calloutPlacement: "left-rail",
      },
      {
        title: "Open a source",
        caption: "Each row shows the file, its K number, the page when it has one, and the cited sentence.",
        narration: "Each row shows the file, its K number, and the sentence that was cited. A P D F row names the page, and a Word row may say Opens at the passage. Choose the row for the handbook.",
        durationSeconds: 14,
        focus: "sourcesRow",
        calloutPlacement: "left-rail",
      },
      {
        title: "It lands on the cited page",
        caption: "The real document opens at page 7, with the cited sentence marked.",
        narration: "The real document opens, on the page that was cited, with the sentence marked and its passage shaded. This is page seven of twelve. You are reading the document itself, not a summary of it.",
        durationSeconds: 13,
        focus: "sourcesMark",
      },
      {
        title: "The Cited passage callout",
        caption: "Cited passage repeats what was cited and names the page.",
        narration: "Cited passage repeats what the reply relied on and names the page. Read it against the answer. If the reply says more than the page does, trust the page. If the page does not support the reply, ask again and paste the sentence you found.",
        durationSeconds: 17,
        focus: "sourcesCallout",
      },
      {
        title: "Move through the document",
        caption: "Previous page, Next page, a page number, Zoom in, and Zoom out.",
        narration: "Read around the passage, because the sentences nearby often change its meaning. Previous page and Next page turn the pages, or type a number into the page box and press Enter. Zoom in and Zoom out change the size.",
        durationSeconds: 16,
        focus: "sourcesControls",
      },
      {
        title: "Jump back to the passage",
        caption: "Go to the cited passage returns to the mark from anywhere.",
        narration: "When you have finished reading around it, choose Go to the cited passage, the target icon. You return to the mark from anywhere in the document.",
        durationSeconds: 10,
        focus: "sourcesBack",
      },
      {
        title: "Download original, then close",
        caption: "Download original saves the file as uploaded. Close document returns to the chat.",
        narration: "Download original, the arrow into a tray, saves the file exactly as it was uploaded, which is what to share or file. Close document, the X, returns you to the chat, or press Escape.",
        durationSeconds: 13,
        focus: "sourcesDownload",
      },
      {
        title: "Word files keep their layout",
        caption: "A Word source opens as pages, on the cited page, with the passage marked.",
        narration: "On servers that can convert them, Word files open the same way, as real pages. The first view is converted on the server, so you may see Preparing document for up to a minute. The darker mark is the cited sentence. A pale patch elsewhere can be a stray match.",
        durationSeconds: 18,
        focus: "sourcesWord",
      },
      {
        title: "Open a source from the reply",
        caption: "Each K marker in the reply opens that source.",
        narration: "You do not need the list. Each K marker in the reply is a button. Choose the one beside the fact you want to check.",
        durationSeconds: 9,
        focus: "sourcesInline",
      },
      {
        title: "The same place, one click sooner",
        caption: "An inline marker opens the same page and passage as its row.",
        narration: "It opens the same document at the same passage. This is the quickest way to check one fact at a time as you read.",
        durationSeconds: 9,
        focus: "sourcesInlineOpen",
      },
      {
        title: "Preview a file from the Library",
        caption: "In Library › Knowledge, Preview or the file name opens the viewer.",
        narration: "To read a file with no question in mind, open Library, Knowledge, and your knowledge base. Choose Preview, the eye beside a file, or the file's name.",
        durationSeconds: 11,
        focus: "sourcesLibrary",
      },
      {
        title: "A preview starts at the top",
        caption: "With nothing cited, the file opens at page 1 with no callout.",
        narration: "It opens in the same viewer at the first page. Nothing has been cited, so there is no callout and no mark. The page, zoom, and download controls work the same way.",
        durationSeconds: 12,
        focus: "sourcesPreview",
      },
      {
        title: "Why a reply can show no sources",
        caption: "No marker, no button: this reply cited nothing, so there is nothing to check it against.",
        narration: "Some replies show no sources. No marker was written, so no button appears. That can mean the question had nothing to do with your documents, as here, or that the reply drew on them without marking it. To get markers, ask again and add cite the source after each sentence. Treat an unsourced answer as unchecked.",
        durationSeconds: 21,
        focus: "sourcesNone",
      },
      {
        title: "Older documents open as text",
        caption: "Documents uploaded earlier show their indexed text, with no Download original.",
        narration: "Documents uploaded before this release have no stored original, so they open as their indexed text, with this note, and there is no Download original. You can still read the passage. For the real pages, ask whoever manages the knowledge base to upload the file again and remove the old copy. Uploading adds a new document.",
        durationSeconds: 22,
        focus: "sourcesOldText",
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
      "Read the reply. When your organization keeps values from the model, the model received placeholders only, so its reply shows locked chips, such as SSN, where a value belongs.",
      "Add the real values yourself in the system where they belong, not in the chat.",
      "When you rate a reply with the thumbs buttons, read the note box. If your organization captures training examples, it says so: a de-identified copy of rated answers and notes is kept and never sent to a model provider.",
    ],
    paths: [
      {
        label: "Values kept from the model (shown)",
        steps: [
          "Your sent message shows locked chips.",
          "The model received placeholders instead of the values, so its reply shows locked chips in their place, such as SSN or Email.",
          "The work trace records it: Concealed personal data in your message.",
        ],
      },
      {
        label: "Model allowed to read values (shown)",
        steps: [
          "Your sent message still shows locked chips.",
          "The model read the values for that turn, so it can use them, for example in a signature block.",
          "Any value it writes is replaced with a locked chip before you see the reply and before the chat is saved.",
          "The work trace may still say the model saw placeholders. In this mode that line is wrong.",
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
      { symptom: "The reply shows a locked chip where you expected a value", fix: "The model never received the value. Fill it in yourself where it belongs; do not paste it back into the chat." },
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
        caption: "The model saw placeholders, so its reply shows locked chips where the values belong.",
        narration:
          "Here the organization keeps values from the model, so the model received placeholders only. Its reply shows the same locked chips where the values belong. Add the real values yourself, in the system where they belong.",
        durationSeconds: 15,
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
    description: "Start a document from a blank page, a chat request or reply, or a file; have the assistant write it; edit with AI; save a version; and export it.",
    icon: "drafts",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["Document written by the assistant", "Passage edited with AI", "Version saved", "Word file and archival PDF exported"],
    prerequisites: [
      "An available model for AI writing and editing. Without one, you can still type, open files, save, and export.",
      "To open a file in the editor: a Word (.docx or .doc), PDF (.pdf), Markdown (.md), text (.txt), or web page (.html) file.",
    ],
    setupSteps: [
      "Choose Drafts in the sidebar. A blank document opens, with the Document Assistant on the left and the format rail at the top: Document, Deck, and Spreadsheet.",
      "Keep Document selected.",
      "In Ask the document assistant, describe the document you need, or choose a suggestion. Choose Apply instruction (the arrow).",
      "Wait while the assistant writes on the page. The work trace under your request shows each step as it is reached, and Ready to write returns when it is done.",
      "Type your title in the title field beside the format rail. The assistant's first draft replaces any title you typed, so do this after it finishes.",
      "Select a passage, choose Ask AI in the floating toolbar (or press Ctrl+J, ⌘J on a Mac), and choose an action such as Improve writing.",
      "Review the Changes or Result view. Original formatting kept means only the words change. Choose Replace; Insert below, Try again, and Discard are the alternatives.",
      "Choose Save version (it reads Save in a narrower window) and wait for Saved at the end of the toolbar.",
      "Choose Export, set Save to to Browser downloads, and choose Word document. The receipt names the downloaded file.",
    ],
    paths: [
      {
        label: "From a chat request",
        steps: [
          "In chat, ask for a document. When chat asks Write this in Drafts?, choose Write in Drafts.",
          "Drafts writes it from your request and saves it. See Hand a chat request to Drafts.",
        ],
      },
      {
        label: "From a chat reply",
        steps: [
          "Under a finished chat reply, choose Transfer to Drafts.",
          "Open in Drafts as offers Word document, Slide deck, and Spreadsheet, with the best fit marked Suggested. Choose Word document.",
          "Drafts opens a new document with the reply, saved as Version 1.",
          "Continue from step 6 of the main steps.",
        ],
      },
      {
        label: "Open a file from this device",
        steps: [
          "Choose Attach file (the paperclip) in the assistant's message box.",
          "Under From this device, choose Open in editor, and pick a .docx, .pdf, .doc, .md, .txt, or .html file.",
          "Word and PDF files keep their page setup, headers, footers, tab stops, and tables; Markdown keeps its headings and lists. The draft you had open stays in Document history.",
          "Attach to chat instead gives the file to the assistant to read with your next request. See Open a Word or PDF file and keep its formatting.",
        ],
      },
      {
        label: "Write it yourself",
        steps: [
          "Click on the page and type. Markdown shortcuts work: # and a space starts a title, - and a space starts a list.",
          "Type / at the start of a line for the command menu: headings, lists, tables, page breaks, and AI actions.",
          "Use Text, Paragraph, More, and Insert above the page for formatting. Templates and page layout have their own lesson.",
        ],
      },
      {
        label: "Export formats",
        steps: [
          "Word document: an editable .docx with page breaks and images.",
          "PDF document: an archival PDF/A file built on the server, with searchable text, embedded fonts, and bookmarks from your headings. Long documents show progress, and the X beside it cancels.",
          "Markdown: a .md file for plain text or web publishing.",
          "Print: opens the browser's print dialog with the saved version, for paper. Use PDF document when you need a file to keep or send.",
          "Save to: Browser downloads saves straight to your downloads; Choose a location asks the browser where to save. If that location cannot be written, the file goes to your downloads and the receipt says so.",
        ],
      },
    ],
    verify: [
      "The toolbar shows Saved after Save version, and the version label at the top shows the new number.",
      "The export receipt names the file, for example synthetic-vendor-onboarding-checklist.docx, and offers Download again. A PDF receipt also lists its pages, PDF/A-2b archival, and any bookmarks.",
      "An opened file shows a note in the assistant rail: the file opened in the editor.",
    ],
    troubleshooting: [
      { symptom: "\"AI drafting is unavailable.\" or Model: No models connected", fix: "No model is available to you. You can still type, open files, save, and export. Ask your administrator for model access." },
      { symptom: "\"No local draft was substituted. …'s content filter withheld the model's reply (… sent the request to …). Choose a different model or try again.\"", fix: "The model provider's safety filter blocked the reply, so nothing was written to your page. Choose a different model in the model menu, or rephrase and try again. During an edit the message starts with \"No revision was applied.\"" },
      { symptom: "The document title changed to a template name, such as Board Update Draft", fix: "The assistant's first draft sets its own title, even if you typed one first. Type your title into the title field after it finishes, then save." },
      { symptom: "\"Could not open … Choose a .docx, .pdf, .doc, .md, .txt, or .html file.\"", fix: "Save the file in one of those formats and open it again." },
      { symptom: "\"Wait for the assistant to finish before opening another document.\"", fix: "Let the current request finish, then open the file." },
      { symptom: "Export says \"Save your edits first\"", fix: "Choose Save version and export (or Save version and print). Exports use the saved version." },
      { symptom: "Local only at the end of the toolbar", fix: "Your changes are kept in this browser. Choose Retry beside it, or export a copy before you leave." },
      { symptom: "\"… could not be written to the chosen location, so it was sent to your browser downloads instead.\"", fix: "The browser could not save to the place you chose. Find the file in your downloads, or set Save to to Browser downloads." },
      { symptom: "The export stops and no receipt appears", fix: "Try again, or choose Browser downloads in Save to. For PDF document, the server may be busy or you may already have 2 PDF exports running, so wait a minute and try again." },
    ],
    scenes: [
      {
        title: "Open Drafts",
        caption: "Drafts opens a blank document, with the Document Assistant and suggested requests on the left.",
        narration: "Choose Drafts in the sidebar. A blank document opens on the right, with the Document Assistant on the left: What should we write?",
        durationSeconds: 10,
        focus: "draftComposer",
      },
      {
        title: "Choose a format",
        caption: "The rail at the top chooses the format: Document, Deck, or Spreadsheet.",
        narration: "The rail at the top chooses the format. Document is for pages you export to Word or P D F, Deck is for slides that export to PowerPoint, and Spreadsheet is for a workbook that exports to Excel. This lesson stays in Document; the other two have their own lessons.",
        durationSeconds: 19,
        focus: "draftFormatRail",
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
        narration: "In Ask the document assistant, say who the document is for, the headings you want, and how long it should be. Choose Sources first if it must use your own material, because it cannot know your facts. Then choose Apply instruction.",
        durationSeconds: 16,
        focus: "draftsRequest",
      },
      {
        title: "Follow the work trace",
        caption: "The work trace sits under your request, with a timer, each step as it lands, and what comes next.",
        narration: "The work trace appears under your request. Aperture Chat is working, with a timer beside it. Each step lands as it is reached, and Next names the step ahead. On a busy or smaller model a long draft can take several minutes, so you can see it is still moving.",
        durationSeconds: 18,
        focus: "draftTraceRunning",
        calloutPlacement: "right-mid",
      },
      {
        title: "The assistant writes on the page",
        caption: "The document appears on the page, formatted, ready for you to read through.",
        narration: "The assistant writes straight onto the page, with real headings and lists. Check the length too: you asked for one page, and this runs onto a second. Read it through before you share it, and replace anything in square brackets: those are details it did not have.",
        durationSeconds: 17,
        focus: "draftsGenerated",
      },
      {
        title: "Read the finished trace",
        caption: "Worked for shows the time and steps. The rail also records the model and any citations.",
        narration: "When it finishes, the trace says how long it worked and how many steps it took. Choose that line to fold it away or open it again. Below it, the rail records the model used. Cited, above Draft chat, means strict citations are on; no sources were chosen here, so the rail reports zero citations.",
        durationSeconds: 20,
        focus: "draftTraceDone",
      },
      {
        title: "Keep your own title",
        caption: "The first draft sets its own title, so type yours now.",
        narration: "Check the title. The assistant's first draft replaces it, even if you typed one first, often with a template's name. Type your own title into the field beside the format rail.",
        durationSeconds: 13,
        focus: "draftsTitle",
      },
      {
        title: "Select text and Ask AI",
        caption: "Select a passage, choose Ask AI, and pick an action or describe the change.",
        narration: "To change one passage, select it and choose Ask AI in the floating toolbar, or press Control J, Command J on a Mac. Pick an action such as Improve writing, or describe your own change.",
        durationSeconds: 14,
        focus: "draftsAiMenu",
      },
      {
        title: "Review, then replace",
        caption: "Changes shows what will change. Original formatting kept means only the words change.",
        narration: "Review the suggestion. Changes marks what is removed and added; Result shows the new text. Original formatting kept means only the words change, so bold text, links, and styles stay. Choose Replace to accept it. Nothing changes until you accept.",
        durationSeconds: 18,
        focus: "draftAiEdit",
        calloutPlacement: "left-rail",
      },
      {
        title: "Format like a document",
        caption: "Text, Paragraph, More, and Insert hold the formatting controls.",
        narration: "Above the page, Text sets fonts, sizes, and colors; Paragraph sets alignment and lists; More holds copy and the AI edit trail; Insert adds links, citations, images, charts, tables, and page breaks. Use the style list for headings instead of bold, because headings feed the Outline and the P D F's bookmarks.",
        durationSeconds: 22,
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
        caption: "The status bar stays in view: page and word counts, Outline, Find, shortcuts, and zoom.",
        narration: "The status bar stays in view under the page, however long the document gets. It counts pages and words. Outline lists your headings, Find opens find and replace, and zoom resizes the page on screen.",
        durationSeconds: 15,
        focus: "draftStatusBar",
      },
      {
        title: "Save a version",
        caption: "Save version stores a snapshot in your account. Saved confirms it.",
        narration: "Choose Save version, which reads Save in a narrower window like this one. The version number goes up, and Saved, at the end of the toolbar, confirms it reached your account. If it says Local only, choose Retry beside it. Save before you export or leave.",
        durationSeconds: 18,
        focus: "draftSaveState",
      },
      {
        title: "Choose an export",
        caption: "Export offers Word document, PDF document, Markdown, and Print. Save to picks where it goes.",
        narration: "Choose Export. Word document makes a file you can keep editing, P D F document makes an archival P D F, Markdown makes plain text, and Print goes to your browser's print dialog. Save to decides where a file goes: Browser downloads, or a location you choose.",
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
        title: "Export a PDF",
        caption: "PDF document builds an archival PDF on the server. The receipt lists its pages and PDF/A-2b.",
        narration: "P D F document builds the file on the server, as an archival P D F A file with searchable text, embedded fonts, and bookmarks from your headings. A long document shows its progress, and the X beside it cancels. The receipt lists the pages and the archival standard.",
        durationSeconds: 19,
        focus: "draftsPdfExported",
      },
      {
        title: "Print on paper",
        caption: "Print opens your browser's print dialog with the saved version.",
        narration: "Print is separate. It opens your browser's own print dialog with the saved version, and the panel confirms it. Use it for paper. When you need a file to keep or send, choose P D F document.",
        durationSeconds: 14,
        focus: "draftsPrint",
      },
      {
        title: "Start from a chat reply",
        caption: "Transfer to Drafts asks how to open the reply: Word document, Slide deck, or Spreadsheet.",
        narration: "You can also start from chat. Under a finished reply, choose Transfer to Drafts. Open in Drafts as offers Word document, Slide deck, and Spreadsheet, and marks the best fit Suggested. Each option says what happens to the reply: a table becomes a sheet, and plain lines go down the first column. Here, choose Word document.",
        durationSeconds: 22,
        focus: "draftTransferMenu",
      },
      {
        title: "The reply opens as a document",
        caption: "The reply opens in the editor as a new, saved document.",
        narration: "The reply opens here as a new document, saved as Version 1. Asking chat for a document works too: choose Write in Drafts on the card it offers. The next lesson shows that path.",
        durationSeconds: 13,
        focus: "draftsTransferred",
      },
      {
        title: "Open a file from this device",
        caption: "Attach file › From this device: Attach to chat for the assistant, or Open in editor to edit the file.",
        narration: "Or start from a file. Choose the paperclip in the assistant's message box. Attach to chat gives a file to the assistant to read. Open in editor opens a Word, P D F, Markdown, text, or web page file as the document itself.",
        durationSeconds: 17,
        focus: "draftOpenFromDevice",
      },
      {
        title: "The file opens as a draft",
        caption: "The file opens as a new draft. The previous draft stays in Document history.",
        narration: "The file opens as a new draft, and the rail confirms it. Word and P D F files keep their page setup, headers, footers, and tables; this Markdown file keeps its headings and lists. The draft you had open stays in Document history.",
        durationSeconds: 17,
        focus: "draftOpenedDocument",
      },
      {
        title: "Move through a long document",
        caption: "The page navigator beside the sheet jumps a page at a time. The status bar shows where you are.",
        narration: "In a long document, the page navigator beside the sheet stays in view. Its arrows jump to the previous or next page, and it shows where you are. The status bar shows the same page and the document's length.",
        durationSeconds: 15,
        focus: "draftPageNavigator",
      },
    ],
  },
  {
    id: "chat-to-drafts",
    audioSrc: "training/user/chat-to-drafts.mp3",
    title: "Hand a chat request to Drafts",
    description: "Ask chat for a document, a slide deck, or a spreadsheet, then have Drafts build it as an editable, saved draft, or keep it in chat, or change the request first.",
    icon: "drafts",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["Chat offers Drafts for a document, deck, or spreadsheet request", "Document written and saved in Drafts", "Deck and workbook built in their editors", "Request kept in chat, or returned for editing"],
    prerequisites: [
      "An available model. Chat only offers Drafts when a model is available to you.",
      "Agent mode off, with no tools or links chosen for the message. Those requests always go straight to chat.",
    ],
    setupSteps: [
      "In a chat, ask for a document, for example: Draft a one-page memo to the operations team about the vendor review schedule.",
      "Send it. Chat holds the request and asks Write this in Drafts? Send stays off until you choose.",
      "Choose Write in Drafts.",
      "Drafts opens and starts writing at once. The rail says Writing the document you asked for in chat, and the work trace under your request lists each step.",
      "Wait for Ready to write to return and for Saved in the toolbar. The document is Version 1 in your account.",
      "Read it through, then edit, save, and export it as in Draft documents.",
    ],
    paths: [
      {
        label: "Ask for a slide deck",
        steps: [
          "Ask for a presentation, for example: Create a slide deck about the vendor review timeline, with four slides.",
          "Chat asks Build this as a slide deck?",
          "Choose Build in deck editor. Drafts switches to Deck and the rail says Building the slide deck you asked for in chat.",
          "Wait for the slides to fill the filmstrip. The assistant names the deck, so the toolbar can show Editing: choose Save version and wait for Saved.",
        ],
      },
      {
        label: "Ask for a spreadsheet",
        steps: [
          "Ask for a tracker, budget, or workbook, for example: Create a spreadsheet to track four vendor reviews, with columns for vendor, owner, due date, and status.",
          "Chat asks Build this as a spreadsheet?",
          "Choose Build in spreadsheet editor. Drafts switches to Spreadsheet and the rail says Building the spreadsheet you asked for in chat.",
          "Wait for Ready to build spreadsheets to return and for Saved in the toolbar. The assistant can add sheets, so open each tab at the bottom and check the cells and formulas. See Build a spreadsheet with the assistant.",
        ],
      },
      {
        label: "Keep it in chat",
        steps: [
          "Choose Continue in chat (for a deck, Draft slides in chat).",
          "The request is sent to this conversation and the reply arrives as usual.",
          "To move a finished reply to Drafts later, choose Transfer to Drafts under it, then Word document, Slide deck, or Spreadsheet.",
        ],
      },
      {
        label: "Change the request first",
        steps: [
          "Choose Edit request.",
          "The request returns to the message box, with any files you attached. Change it and send it again.",
        ],
      },
      {
        label: "When the card does not appear",
        steps: [
          "Agent mode, chosen tools, fetched links, and queued automations always send straight to chat.",
          "Questions and short pieces usually stay in chat: emails, poems, short summaries, outlines, recaps, social posts, and code. An executive summary or a blog post counts as a document, so the card appears.",
          "Adding in chat or right here to a request keeps it in chat.",
          "Attached files, Web, and knowledge bases you chose come along to Drafts.",
        ],
      },
    ],
    verify: [
      "Drafts shows the document with Version 1 and Saved in the toolbar; a deck shows its slides in the filmstrip; a workbook shows its cells in the grid.",
      "The rail in Drafts records your request, and its work trace ends with Worked for and the time it took.",
      "Continue in chat puts the request and its reply in the conversation instead.",
    ],
    troubleshooting: [
      { symptom: "Send is off, and its tooltip says \"Choose Drafts or chat for the request above first\"", fix: "Chat is holding your request. Choose the Drafts button on the card, Continue in chat, or Edit request." },
      { symptom: "\"Could not upload the attachment.\" on the card", fix: "A file you attached could not be uploaded. Try again, or choose Edit request and attach it again." },
      { symptom: "No card appears and the reply arrives in chat", fix: "The request read as a question or a short piece, or Agent mode, a tool, or a link was on. Open Drafts and ask there, or use Transfer to Drafts under the reply." },
      { symptom: "The new document has a template's name, such as Investment Memo Draft", fix: "The assistant renamed it after a template it matched. Type your own title into the title field, then save." },
      { symptom: "\"No drafting model connected\" in Drafts", fix: "Drafts has no model to write with. Your request waits in the assistant's message box; ask your administrator for model access." },
      { symptom: "\"No local draft was substituted. …\", \"Deck request failed: …\", or \"The spreadsheet request failed: …\"", fix: "The model could not finish. Choose Apply instruction to try again, or pick another model in the model menu." },
      { symptom: "\"The model's reply was not valid spreadsheet changes twice, so nothing was applied. Try rephrasing the request.\"", fix: "Smaller models can struggle with large workbooks. Ask for fewer columns or rows, or choose a stronger model, and send it again." },
      { symptom: "\"The model's structured output failed validation twice, so the deck was built from its outline instead.\"", fix: "Smaller models can return slides in the wrong format. See Build a slide deck for the sentence to add to your request, or choose a stronger model." },
    ],
    scenes: [
      {
        title: "Ask chat for a document",
        caption: "A document request is held, and chat asks: Write this in Drafts?",
        narration: "In chat, ask for a document, such as a one-page memo. When a request reads like a document, chat holds it and asks: Write this in Drafts? Send stays off until you choose.",
        durationSeconds: 13,
        focus: "handoffCard",
      },
      {
        title: "Write in Drafts",
        caption: "Drafts opens and starts writing, with its work trace under your request.",
        narration: "Choose Write in Drafts. Drafts opens and starts writing straight away. The assistant shows Writing, and the work trace under your request lands one step at a time, with the next step below it.",
        durationSeconds: 14,
        focus: "handoffWriting",
      },
      {
        title: "Written and saved",
        caption: "The memo is on the page as Version 1, saved to your account.",
        narration: "When it finishes, the memo is on the page, saved as Version 1. This small local test model took over three minutes; hosted models are far faster. Check it against your request: it wrote five pages instead of one, guessed the year, and left brackets. It also took a template's name, so type your own title.",
        durationSeconds: 21,
        focus: "handoffWritten",
      },
      {
        title: "Ask for a slide deck",
        caption: "A deck request asks: Build this as a slide deck?",
        narration: "Ask for a presentation or a slide deck, and the card asks: Build this as a slide deck? Choose Build in deck editor, or Draft slides in chat to get the slide text here instead. Leave out this request's last sentence: it only helps this small local model.",
        durationSeconds: 18,
        focus: "handoffDeckCard",
      },
      {
        title: "The deck editor builds it",
        caption: "Drafts switches to Deck and builds the slides you asked for.",
        narration: "Drafts switches to Deck and builds the slides you asked for in chat. The assistant names the deck, so the toolbar can show Editing when the filmstrip fills. Choose Save version. Once it shows Saved, the deck is ready to refine, present, and export.",
        durationSeconds: 18,
        focus: "handoffDeckBuilt",
      },
      {
        title: "Ask for a spreadsheet",
        caption: "A spreadsheet request asks: Build this as a spreadsheet?",
        narration: "Ask for a tracker, a budget, or a spreadsheet, and the card asks: Build this as a spreadsheet? Choose Build in spreadsheet editor for a real workbook with formulas, tables, and charts that exports to Excel. Tip: name the columns you want, and it needs less fixing afterward.",
        durationSeconds: 19,
        focus: "handoffSheetCard",
      },
      {
        title: "The spreadsheet editor builds it",
        caption: "Drafts switches to Spreadsheet and builds the workbook in the grid.",
        narration: "Drafts switches to Spreadsheet and builds the workbook. The work trace says what it built and that every formula was recalculated, but that does not prove it matches your request: you asked for four vendors, and it wrote five. Check every tab, widen any column whose text is cut off, then ask the Spreadsheet Assistant for changes.",
        durationSeconds: 21,
        focus: "handoffSheetBuilt",
      },
      {
        title: "Keep it in chat",
        caption: "Continue in chat sends the request here, and the reply arrives as usual.",
        narration: "Prefer the answer here? Choose Continue in chat. The request is sent to this conversation and the reply arrives as usual. Agent mode, chosen tools, and links always go straight to chat. Emails, short summaries, outlines, and code usually stay here too, with no card.",
        durationSeconds: 19,
        focus: "handoffContinued",
        calloutPlacement: "left-rail",
      },
      {
        title: "Change the request",
        caption: "Edit request puts the request back in the message box to change it.",
        narration: "To change the request first, choose Edit request. It returns to the message box, with any files you attached. Edit it and send it again.",
        durationSeconds: 10,
        focus: "handoffEditRequest",
      },
    ],
  },
  {
    id: "draft-word-pdf",
    audioSrc: "training/user/draft-word-pdf.mp3",
    title: "Open a Word or PDF file and keep its formatting",
    description: "Open a Word or PDF file in Drafts with its page setup, headers, footers, tab stops, and tables intact, fill it in with Ask AI without losing the formatting, and export it back to Word.",
    icon: "drafts",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["Word file opened with its formatting", "Blanks filled with Ask AI, formatting kept", "Version saved and Word file exported", "PDF opened the same way"],
    prerequisites: [
      "A Word (.docx, .dotx, or .doc) or PDF file on this device. A .docx keeps the most; a .doc opens from its readable text.",
      "An available model for Ask AI. Opening, editing, saving, and exporting work without one.",
      "PDFs must not be password-protected.",
    ],
    setupSteps: [
      "Choose Drafts in the sidebar.",
      "Choose Attach file (the paperclip) in the assistant's message box. Under From this device, choose Open in editor.",
      "Pick the .docx file. It opens as a new draft with its page size, margins, fonts, header, footer with page numbers, tab stops, and tables. The rail says it opened in the editor.",
      "Select the passage to change, then choose Ask AI in the floating toolbar.",
      "Type the change and include the real values, for example Fill in the blanks: 1 November 2026, Northwind Example Supplies, and 100 Example Way, Springfield, and press Enter.",
      "Review the suggestion. Original formatting kept means only the words change: bold text, fonts, and styles stay as they were. Choose Replace.",
      "Choose Save version and wait for Saved.",
      "Choose Export, set Save to to Browser downloads, and choose Word document. The receipt names the file.",
      "Open the downloaded file in Word: the header, footer, page numbers, tab stops, and table are still there.",
    ],
    paths: [
      {
        label: "Open a PDF",
        steps: [
          "Choose Attach file › Open in editor and pick the .pdf file.",
          "It is rebuilt as editable paragraphs with its page size, margins, fonts, and running header and footer. Page numbers become live fields.",
          "Edit, save, and export it like any draft. Word document export gives you an editable .docx.",
        ],
      },
      {
        label: "Reuse a Word file as a template",
        steps: [
          "Choose Templates in the assistant rail.",
          "Choose Upload Word template (the upload button at the bottom of Templates) and pick the file.",
          "On a blank page it places the template. On a page with text, it applies the template's page, header, footer, and styles without removing any words.",
          "The template is listed under Uploaded in Templates, stored in this browser.",
        ],
      },
      {
        label: "Other files and Attach to chat",
        steps: [
          "Markdown (.md), text (.txt), and web page (.html) files open the same way; Markdown keeps its headings and lists.",
          "Attach to chat, instead of Open in editor, gives the file to the assistant to read with your next request.",
        ],
      },
    ],
    verify: [
      "The page shows the file's header and footer, with live page numbers such as Page 1 of 1.",
      "The review showed Original formatting kept, and the filled passage keeps its bold text.",
      "The toolbar shows Saved, and the export receipt names the .docx file.",
    ],
    troubleshooting: [
      { symptom: "\"Could not open … Choose a .docx, .pdf, .doc, .md, .txt, or .html file.\"", fix: "Save the file in one of those formats and open it again." },
      { symptom: "\"This PDF is password-protected. Remove the password and try again.\" or \"The PDF could not be read.\"", fix: "Remove the password, or save a fresh PDF from the app that made it, then open it again." },
      { symptom: "Text from a PDF opens bolder than it was", fix: "Some PDF fonts (for example Georgia or Times New Roman in a PDF printed from a browser) can open as bold or semibold. Select the text and set its weight back, or open the original Word file instead when you have it." },
      { symptom: "\"The Word file's full formatting could not be read, so it opened with simplified formatting.\"", fix: "Open the file in Word, save it again as .docx, and open the new copy." },
      { symptom: "\"Legacy .doc files are imported from readable text or Word-saved HTML. Use .docx for higher fidelity.\"", fix: "Save the file as .docx in Word, then open it again to keep its formatting." },
      { symptom: "The review does not say Original formatting kept", fix: "The change restyled or restructured the passage (into a list or table, for example), so the reply replaces it as written. Check it, or choose Discard and ask for a smaller change." },
      { symptom: "\"Wait for the assistant to finish before opening another document.\"", fix: "Let the current request finish, then open the file." },
    ],
    scenes: [
      {
        title: "Open in editor",
        caption: "Attach file › From this device › Open in editor opens a Word, PDF, Markdown, text, or web page file.",
        narration: "Choose Drafts, then Attach file, the paperclip in the assistant's message box. Under From this device, choose Open in editor, and pick a Word or P D F file. It opens as the document itself.",
        durationSeconds: 15,
        focus: "draftOpenFromDevice",
      },
      {
        title: "The formatting comes along",
        caption: "The Word file opens with its page setup, header, fonts, and table.",
        narration: "The Word file opens as a new draft with its formatting: the page size and margins, the running header, its fonts and colors, and the fee table. The rail confirms it opened in the editor.",
        durationSeconds: 14,
        focus: "wordOpened",
      },
      {
        title: "Tab stops and page numbers",
        caption: "Signature lines keep their tab stops, and the footer keeps live page numbers.",
        narration: "Further down, the signature lines keep their tab stops, and the footer keeps its live page numbers: Page one of one.",
        durationSeconds: 9,
        focus: "wordOpenedEnd",
      },
      {
        title: "Ask AI to fill the blanks",
        caption: "Select the passage, choose Ask AI, and describe the change.",
        narration: "Select the passage with the blanks and choose Ask AI in the floating toolbar. Say what to change and give it the real values, here a date, a vendor's name, and an address, because it cannot know them. Then press Enter.",
        durationSeconds: 15,
        focus: "wordAskAi",
      },
      {
        title: "Original formatting kept",
        caption: "Original formatting kept: only the words change. Replace accepts it.",
        narration: "Review the suggestion. Changes marks what is removed and added. Original formatting kept means only the words change: the bold text and fonts stay as they were. Choose Replace.",
        durationSeconds: 13,
        focus: "wordAiReview",
      },
      {
        title: "The selected blanks are filled",
        caption: "The filled passage keeps its bold text. Blanks you did not select stay as they were.",
        narration: "The three blanks in that passage are filled, and they keep their bold text and the document's fonts. The teal mark fades on its own. Ask AI changes only what you select, so the signature block still needs filling. Select it and ask again, or type over it.",
        durationSeconds: 18,
        focus: "wordAiApplied",
      },
      {
        title: "Save a version",
        caption: "Save version stores this version in your account.",
        narration: "Choose Save version and wait for Saved. This version is now in your account.",
        durationSeconds: 7,
        focus: "wordSaved",
      },
      {
        title: "Export to Word",
        caption: "Export › Word document. The file keeps its header, footer, tab stops, and table.",
        narration: "Choose Export, set Save to to Browser downloads, and choose Word document. The receipt names the file. Open it in Word: the header, footer, page numbers, tab stops, and table are still there.",
        durationSeconds: 14,
        focus: "wordExported",
      },
      {
        title: "Open a PDF",
        caption: "A PDF opens as editable text with its header, footer, and page numbers.",
        narration: "A P D F opens the same way. It is rebuilt as editable paragraphs with its page size, fonts, and running header and footer, and its page numbers become live fields. Here the zoom in the status bar is set to show the whole page.",
        durationSeconds: 17,
        focus: "pdfOpened",
      },
      {
        title: "Reuse a Word file as a template",
        caption: "Templates › Upload Word template saves the file's layout for new drafts.",
        narration: "To reuse a file's layout, choose Templates, then Upload Word template at the bottom of the panel, and pick the file. It is saved in this browser, under Uploaded further along that row, and placed on the blank page, ready to fill in.",
        durationSeconds: 16,
        focus: "wordTemplateUploaded",
      },
    ],
  },
  {
    id: "document-templates",
    audioSrc: "training/user/document-templates.mp3",
    title: "Start from a template and set the page layout",
    description: "Start a document from a built-in template, have the assistant draft it from your request, and set line spacing, margins, and other page layout in plain words or with the MLA layout.",
    icon: "drafts",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["Template placed and drafted by the assistant", "Layout applied without rewriting a word", "Version saved", "Template layout and MLA applied to existing text"],
    prerequisites: [
      "An available model to draft from a template. Placing a template and changing the layout work without one.",
    ],
    setupSteps: [
      "Choose Drafts in the sidebar. In the assistant rail, choose Templates.",
      "Choose a category, such as Legal, then a template, such as Mutual NDA. On a blank page it places the template, with bracketed fields to fill in.",
      "In Ask the document assistant, describe what to fill in: the parties, the date, and the purpose.",
      "Choose Create Mutual NDA draft at the bottom of Templates. The assistant drafts the document from the template and your request.",
      "Wait for Ready to write and Saved in the toolbar, then read the draft through.",
      "In Ask the document assistant, type the layout you want in plain words, for example Use 1.5 line spacing and 1.25-inch margins, and press Enter.",
      "The rail says the layout was applied directly in the editor and no model call was needed. No words were rewritten, and the change is already saved as a new version.",
    ],
    paths: [
      {
        label: "Fill in the brackets yourself",
        steps: [
          "After placing a template, type over each bracketed field, such as [Party A Legal Name].",
          "Save a version when you are done.",
        ],
      },
      {
        label: "Apply a template to text you already have",
        steps: [
          "Open the draft, choose Templates, and choose a template, such as Contract Amendment.",
          "Its page setup, header, footer, and styles are applied. Your text is unchanged.",
          "To reorganize the text into the template's sections, ask the assistant.",
        ],
      },
      {
        label: "Layout you can ask for",
        steps: [
          "Line spacing: single, 1.5, or double.",
          "Margins for every side or one side, in inches, centimeters, millimeters, or points.",
          "Font and size, paper size (Letter, Legal, or A4), and landscape or portrait.",
          "Justified or left-aligned text, first-line indents, paragraph gaps, page numbers, and header or footer text.",
          "A named format: contract, letter, memo, report, academic, or screenplay.",
        ],
      },
      {
        label: "MLA layout",
        steps: [
          "Choose Assistant settings (the sliders key beside the paperclip in the message box).",
          "Choose Apply MLA layout: double spacing, 12-point Times New Roman, and a centered title. Your text is kept.",
          "Undo reverses it. Save a version to keep it.",
        ],
      },
      {
        label: "Use templates in chat",
        steps: [
          "Choosing a template turns on Use templates in chat. Turn it off in Templates when you want a free-form draft.",
          "The selected template then shapes the new drafts you ask the assistant for.",
        ],
      },
    ],
    verify: [
      "The page shows the drafted agreement with the parties and date from your request.",
      "The rail records your layout request and that no model call was needed, and the page shows the new spacing and margins.",
      "The toolbar shows Saved, and the version label shows the new number.",
    ],
    troubleshooting: [
      { symptom: "A layout request was rewritten by the model instead of applied", fix: "The request mixed layout with other changes. Ask for the layout on its own, in plain words such as 1.5 line spacing and 1-inch margins." },
      { symptom: "A layout request changes nothing on a paper in MLA layout", fix: "MLA papers keep their layout (screen readers hear \"This paper is set in MLA layout (12-point Times New Roman, double spaced); its layout is not changed here.\"). Undo the MLA layout first if you need a different one." },
      { symptom: "Create … draft is off", fix: "No model is available to you. Place the template and fill in the brackets yourself, or ask your administrator for model access." },
      { symptom: "The document title changed to the template's name", fix: "Type your own title into the title field, then save." },
    ],
    scenes: [
      {
        title: "Open Templates",
        caption: "Templates in the assistant rail lists built-in templates by category.",
        narration: "Choose Drafts, then Templates in the assistant rail. Templates are grouped by category. Under Legal you find Client Update, Approval Email, Legal Contract, Mutual N D A, and Contract Amendment.",
        durationSeconds: 15,
        focus: "templatesPanel",
      },
      {
        title: "Place a template",
        caption: "Choosing Mutual NDA places the full template, with bracketed fields to fill in.",
        narration: "Choose Mutual N D A. On a blank page the whole template is placed, formatted, with bracketed fields to fill in. You can type over them yourself, or let the assistant draft it.",
        durationSeconds: 13,
        focus: "templatePlaced",
      },
      {
        title: "Describe what to fill in",
        caption: "Describe the parties, date, and purpose, then choose Create Mutual NDA draft.",
        narration: "In Ask the document assistant, describe what to fill in: the parties, the date, and the purpose. Name everything the brackets ask for, including addresses and states. Anything you leave out stays in brackets. Then choose Create Mutual N D A draft at the bottom of Templates.",
        durationSeconds: 19,
        focus: "templateRequest",
      },
      {
        title: "The assistant drafts it",
        caption: "The agreement is drafted from the template and your request, then saved.",
        narration: "The assistant drafts the agreement from the template and your request, naming the parties and the date, and saves it. Read it through and fill anything still in brackets: here the addresses, and a purpose it missed even though you gave one.",
        durationSeconds: 15,
        focus: "templateDrafted",
      },
      {
        title: "Ask for a layout in plain words",
        caption: "Type the layout you want, such as 1.5 line spacing and 1.25-inch margins.",
        narration: "Now set the page layout in plain words. The draft was reopened here, so Draft chat is clear. Type, for example, use one point five line spacing and one point two five inch margins, and press Enter.",
        durationSeconds: 15,
        focus: "layoutRequest",
      },
      {
        title: "Applied, nothing rewritten",
        caption: "The layout is applied and saved as a new version. No model call, and no words rewritten.",
        narration: "The layout is applied directly in the editor and saved as a new version, so the toolbar already shows Saved. The rail says no model call was needed, and not a word was rewritten.",
        durationSeconds: 13,
        focus: "layoutApplied",
        calloutPlacement: "right-mid",
      },
      {
        title: "A template on existing text",
        caption: "Choosing a template for a page with text applies its layout and keeps your words.",
        narration: "On a page that already has text, choosing a template, here Contract Amendment, applies its page setup and styles and keeps your words. Ask the assistant if you want them reorganized into the template's sections.",
        durationSeconds: 15,
        focus: "templateExisting",
      },
      {
        title: "MLA layout",
        caption: "Assistant settings › Apply MLA layout formats an academic paper.",
        narration: "For an academic paper, choose Assistant settings, the sliders key beside the paperclip, then choose Apply M L A layout.",
        durationSeconds: 9,
        focus: "draftSettings",
      },
      {
        title: "MLA applied",
        caption: "Double spacing, 12-point Times New Roman, and a centered title. Undo reverses it.",
        narration: "The paper is set in double spacing and twelve point Times New Roman, with a centered title, and your text is kept. Undo reverses it; save a version to keep it.",
        durationSeconds: 12,
        focus: "mlaApplied",
      },
    ],
  },
  {
    id: "deck-basics",
    audioSrc: "training/user/deck-basics.mp3",
    title: "Build a slide deck",
    description: "Turn a document into slides, build a deck from an outline or a starter template, give it one of seven theme designs or your own brand, present it, and export a PowerPoint file.",
    icon: "deck",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["Deck created from a document, an outline, and a template", "Theme design or brand template applied", "Deck presented in presenter view", "Real .pptx exported"],
    prerequisites: [
      "An available model for the deck assistant. Converting a document, templates, layouts, notes, presenting, and export work without one.",
      "Optional: your organization's PowerPoint brand template (.pptx or .potx, up to 30 MB, no macros).",
    ],
    setupSteps: [
      "Choose Drafts in the sidebar, then choose Deck in the format rail at the top (Document, Deck, Spreadsheet). A blank deck opens with the Deck Assistant.",
      "Type a title for the deck.",
      "In Ask the deck assistant, describe the deck: how many slides and what each covers. Choose Apply instruction.",
      "Wait while Building slides… runs; on smaller models this can take a few minutes. The work trace under your request lists each step. The filmstrip fills, and the rail says how many slides were drafted and reports its fit check.",
      "Choose Themes above the slide and pick a design. Slide sorter shows it on every slide at once; Undo goes back.",
      "Review each slide. Add slide, the slide's layout chip, Slide pictures, and Edit slide with AI open panels on the left (see Edit slides: layouts, pictures, and text).",
      "Add speaker notes under the slide.",
      "Choose Save version and wait for Saved.",
      "Choose Present deck, then press P for presenter view. Escape exits.",
      "Choose Export, set Save to to Browser downloads, and choose PowerPoint deck. The receipt names the .pptx file.",
    ],
    paths: [
      {
        label: "Convert a document",
        steps: [
          "In a document with content, choose Deck in the format rail.",
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
          "On a deck with slides, the brand's colors, fonts, logo, and background are applied at once; Applied — remove takes them off, and Apply to deck applies a stored brand again.",
          "Load all N slides replaces the deck with the template's own slide designs. The brand theme is stored only on this device.",
        ],
      },
      {
        label: "Layouts and themes",
        steps: [
          "The strip above the slide has Layouts (for the selected slide) and Themes (for every slide). Both scroll sideways.",
          "Layouts: Title, Title + bullets, Two columns, Picture + bullets, Image + caption, Statement, Big number, Section, Quote, and Closing.",
          "Themes change the whole design, and your text stays as written: Aperture (clean type with a slim accent rule), Signal (bold color blocks with white type), Violet (a solid side panel beside the words), Editorial (serif type and hairline rules), Midnight (a dark slide with bright circles), Forest (a fine border framing every slide), and Swiss (oversized type and a single red square).",
          "Fold away layouts and themes hides the strip for more room; Show layouts and themes brings it back.",
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
          "PowerPoint deck: an editable .pptx with your slides, pictures, alt text, and speaker notes.",
          "Markdown outline: slide titles, bullets, and notes as text.",
        ],
      },
    ],
    verify: [
      "The filmstrip lists the slides, and the rail reports how many the assistant drafted and its fit check.",
      "Presenter view shows the current slide, a timer, the next slide, and your notes.",
      "The export receipt names the .pptx file.",
    ],
    troubleshooting: [
      { symptom: "Building slides… runs for several minutes", fix: "Larger decks take longer, especially on smaller models. Ask for fewer slides, or wait; your draft stays intact meanwhile." },
      { symptom: "\"The model's structured output failed validation twice, so the deck was built from its outline instead.\"", fix: "Smaller models can return slides in the wrong format, so the deck may have only a couple of slides, with raw text on one. Undo, then ask again and add: Each slide's layout value is just the layout's name, with its fields beside it. Or choose a stronger model." },
      { symptom: "Generate AI picture is off: \"No image-generation model is enabled for your workspace\"", fix: "Your workspace has no image model. Upload your own picture from Slide pictures instead." },
      { symptom: "\"Could not open … Choose a PowerPoint .pptx file.\"", fix: "Open in editor in a deck accepts .pptx and .potx files. Save other formats as .pptx first." },
      { symptom: "\"… exceeds the 30 MB brand-template upload limit.\" or \"Macro-enabled presentations are not accepted. Save as .pptx or .potx first.\"", fix: "Use a smaller template, and save it without macros." },
      { symptom: "After a brand is applied, slide text is hard to read on its background", fix: "Some brand templates pair a dark background with dark text. Choose Load all N slides to start from the template's own slide designs, or recolor the text with Text color." },
      { symptom: "\"The brand template could not be read.\", or another message in the Brand theme card", fix: "Check that the file is a valid PowerPoint template and try again." },
    ],
    scenes: [
      {
        title: "Turn a document into slides",
        caption: "Choose Deck in a document with content. Convert into slides, or start a blank deck.",
        narration: "There are three ways to start a deck. First, from a document: choose Deck in the format rail. Turn this draft into slides? asks how to begin. Choose Convert into slides, or Start a blank deck. Your document versions are kept either way.",
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
        narration: "Second, from an outline. In a blank deck, tell the deck assistant how many slides you want and what each covers, then choose Apply instruction. Leave out the last sentence you see here: it only helps this small local model.",
        durationSeconds: 15,
        focus: "deckOutlineRequest",
      },
      {
        title: "The assistant drafts the slides",
        caption: "The rail says how many slides were drafted, and its fit check confirms the text fits.",
        narration: "Building slides can take a few minutes on smaller models. When it is done, the filmstrip holds the slides, and the rail says how many were drafted. Its fit check confirms every slide's text fits its boxes. The assistant saves this as a new version. If the toolbar shows Editing, choose Save version.",
        durationSeconds: 21,
        focus: "deckGenerated",
      },
      {
        title: "Choose a layout",
        caption: "Layouts rearrange the selected slide. The strip scrolls sideways and folds away.",
        narration: "Above the slide, Layouts rearranges the selected slide, and your text stays as written. Scroll the strip sideways for more, such as Section, Quote, and Closing. Fold away layouts and themes, the arrow at the left, gives the slide more room.",
        durationSeconds: 17,
        focus: "deckLayoutMenu",
        calloutPlacement: "left-rail",
      },
      {
        title: "Themes are whole designs",
        caption: "Each theme changes the shapes, type, and colors of every slide. Your words stay as written.",
        narration: "Choose Themes. Each of the seven themes is a whole design, not just new colors. Aperture is clean type with a slim accent rule. Signal, here, is bold color blocks with white type. Violet puts a solid side panel beside the words, and Editorial uses serif type and hairline rules, like a magazine.",
        durationSeconds: 21,
        focus: "deckThemes",
        calloutPlacement: "left-rail",
      },
      {
        title: "Three more designs",
        caption: "Midnight, Forest, and Swiss complete the seven. Scroll the strip to reach them.",
        narration: "Scroll the strip for three more. Midnight, here, is a dark slide with bright circles. Forest draws a fine border around every slide. Swiss uses oversized type and a single red square.",
        durationSeconds: 14,
        focus: "deckThemesMore",
        calloutPlacement: "left-rail",
      },
      {
        title: "See a design on every slide",
        caption: "Slide sorter shows every slide at once. Undo goes back to the theme you had.",
        narration: "Choose Slide sorter in the toolbar to see every slide at once, here in Swiss, with each layout's name under it. The assistant chose Big number and Statement for two slides, so check them: Big number needs a real figure, and this one holds a phrase. Undo returns to the theme you had.",
        durationSeconds: 20,
        focus: "deckThemeSorter",
      },
      {
        title: "Refine slides in the left panel",
        caption: "Add slide, the layout chip, Slide pictures, and Edit slide with AI open panels on the left.",
        narration: "To refine slides, Add slide, the slide's layout chip, Slide pictures, and Edit slide with AI each open a panel on the left, like this one for adding a slide. The next lesson walks through each of them.",
        durationSeconds: 15,
        focus: "deckAddPanel",
      },
      {
        title: "Speaker notes",
        caption: "Notes under the slide go into the PowerPoint file and presenter view.",
        narration: "Speaker notes sit under the slide. They export into the PowerPoint file's notes, and appear in presenter view.",
        durationSeconds: 9,
        focus: "deckNotes",
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
        caption: "Upload a .pptx or .potx brand template. It is applied to the deck and stored on this device.",
        narration: "In the same panel, upload your organization's PowerPoint template under Brand theme. Its colors, fonts, logo, and background are applied to the deck, and the brand theme stays on this device. If text turns hard to read, as the title does here, choose Load all slides to use the template's own slide designs.",
        durationSeconds: 21,
        focus: "deckTemplatesDrawer",
      },
      {
        title: "Your brand, applied",
        caption: "Load all slides starts the deck from the template's own designs, in its colors, fonts, and logo.",
        narration: "Here, Load all six slides started the deck from the template's own slide designs, in its colors, fonts, and logo. Replace their text with yours.",
        durationSeconds: 11,
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
    id: "deck-editing",
    audioSrc: "training/user/deck-editing.mp3",
    title: "Edit slides: layouts, pictures, and text",
    description: "Add slides from the layout panel, change a slide's layout, make one point with a Statement, Big number, or Picture + bullets slide, add a picture with alt text, format slide text, fix text that no longer fits, and edit a slide with AI.",
    icon: "deck",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["Slide added with the layout you chose", "One point made with a Statement or Big number slide", "Picture added with alt text", "Slide text formatted and fitted", "Slide edited with AI, checked, and saved"],
    prerequisites: [
      "A deck open in Drafts. Build a slide deck shows how to start one.",
      "An available model for Edit slide with AI and the deck assistant. Layouts, pictures, and text formatting work without one.",
      "A picture on this device: PNG, JPEG, WebP, or GIF.",
      "Generate AI picture needs an image-generation model in your workspace.",
    ],
    setupSteps: [
      "In the filmstrip, select the slide the new one should follow, then choose Add slide under the filmstrip.",
      "In Add a slide, pick a layout. Openers, Content, Pictures, and Highlights jump to each group. Statement and Big number are under Highlights; Picture + bullets is under Pictures. The slide is added after the selected one.",
      "Click a text box on the new slide and type over the placeholder text.",
      "To change the slide's layout, choose the layout chip at the top right of the slide (for example Two columns), then pick a layout in Change layout. The slide keeps its words.",
      "Choose Slide pictures in the toolbar. In the Picture panel, choose Upload from this device and pick a picture.",
      "Type a short description in Alt text, then choose Done.",
      "Select words in a text box. In the floating text toolbar, change the size, choose Bold, or choose Text color and a theme color. Clear formatting returns the text to the layout's style.",
      "If the toolbar says Shrunk to fit, as PowerPoint does, or Text overflows this box, shorten the text, size it down, or drag a corner of the box.",
      "Choose Edit slide with AI in the toolbar and pick an action such as Cut the text in half. Compare Before and After in the left panel.",
      "Choose Apply to slide. Try again asks for another version; Discard leaves the slide as it was.",
      "Choose Save version and wait for Saved.",
    ],
    paths: [
      {
        label: "Make one point: Statement, Big number, Picture + bullets",
        steps: [
          "Statement (Highlights): one sentence in large type, with a supporting line below it.",
          "Big number (Highlights): the figure in the title box, and what it measures in the line below.",
          "Picture + bullets (Pictures): a picture beside a short list. Add the picture from Slide pictures, then type the bullets.",
          "A theme restyles these slides too, so check them again after you change it.",
        ],
      },
      {
        label: "Find a picture on the web",
        steps: [
          "In the Picture panel, type a few words in Or describe the picture, then choose Find web images.",
          "Choose a result to use it on the slide.",
          "If nothing comes back, the panel says No web images were found. Try other words, or upload your own picture.",
        ],
      },
      {
        label: "Generate an AI picture",
        steps: [
          "Describe the picture in Or describe the picture, then choose Generate AI picture.",
          "It needs an image-generation model. Without one the button is off and the panel says No image-generation model is enabled for your workspace.",
        ],
      },
      {
        label: "Edit only some of the text with AI",
        steps: [
          "Highlight words in a text box, then choose Ask AI in the floating text toolbar.",
          "The left panel opens as Edit slide text with AI and changes only the highlighted words.",
          "Type what to change or pick an action, review the Changes, and choose Replace.",
        ],
      },
      {
        label: "Have the deck assistant revise every slide",
        steps: [
          "In Ask the deck assistant, describe the change, for example Make every slide title five words or fewer, and choose Apply instruction.",
          "While it works, the rail lists its steps, including Checking slide fit.",
          "When it finishes, the rail reports the result and the fit check, for example Fit check: every slide's text fits its boxes.",
        ],
      },
      {
        label: "Slide background",
        steps: [
          "Choose Slide background in the toolbar.",
          "Upload background… puts your own image behind this slide. Use on every slide, Remove from this slide, and Clear from all slides manage it.",
        ],
      },
      {
        label: "More room for the slide",
        steps: [
          "Fold away layouts and themes (the arrow beside Layouts) hides the strip above the slide.",
          "Show layouts and themes brings it back.",
        ],
      },
    ],
    verify: [
      "The filmstrip shows the new slide with its layout name, for example Slide 3: Image + caption.",
      "The picture is on the slide, and Alt text holds its description, which is kept in the PowerPoint export.",
      "After Apply to slide, the slide shows the After version, and the toolbar shows Saved after Save version.",
      "The rail's fit check reports that every slide's text fits its boxes.",
    ],
    troubleshooting: [
      { symptom: "\"Pictures can be PNG, JPEG, WebP, or GIF.\"", fix: "Save the picture in one of those formats and upload it again." },
      { symptom: "\"… has no picture. Switch this slide to a layout that holds one; its words come along.\"", fix: "Choose Picture + bullets or Image + caption under Layouts with a picture, then add the picture." },
      { symptom: "\"No web images were found for … Try other words.\"", fix: "Try other words, or upload your own picture. The search reaches public web pictures, so it needs internet access from your browser." },
      { symptom: "Generate AI picture is off: \"No image-generation model is enabled for your workspace\"", fix: "Upload your own picture, or ask your administrator for an image model." },
      { symptom: "\"Text overflows this box · shorten it, size it down, or drag a corner\"", fix: "Shorten the text, choose a smaller size, drag a corner of the box, or use Edit slide with AI and Cut the text in half." },
      { symptom: "Bullets after the eighth disappear when you leave the slide", fix: "A bullet box keeps up to eight bullets; extra lines are not saved. Shorten the list, or use Edit slide with AI and Split into two slides." },
      { symptom: "\"… had no slot in this layout — undo restores them.\"", fix: "The new layout has fewer text boxes. Undo, or pick a layout with more boxes." },
      { symptom: "Edit slide with AI is off", fix: "No model is available to you. Ask your administrator for model access; layouts, pictures, and formatting still work." },
    ],
    scenes: [
      {
        title: "Add a slide",
        caption: "Add slide opens Add a slide: layouts grouped as Openers, Content, Pictures, and Highlights.",
        narration: "Select the slide the new one should follow, then choose Add slide under the filmstrip. Add a slide opens on the left, with layouts grouped as Openers, Content, Pictures, and Highlights. Pick one, here Two columns.",
        durationSeconds: 15,
        focus: "deckAddPanel",
      },
      {
        title: "Fill in the new slide",
        caption: "The slide is added after the selected one. Click a text box and type.",
        narration: "The new slide is added after the one you selected, and its layout chip names the layout. Click a text box and type over the placeholder text.",
        durationSeconds: 11,
        focus: "deckSlideAdded",
      },
      {
        title: "Change the layout",
        caption: "The layout chip opens Change layout. The slide keeps its words.",
        narration: "To rearrange a slide, choose its layout chip at the top right of the slide. Change layout shows the same groups, with the current layout marked. Pick another one, here Image plus caption. The slide keeps its words.",
        durationSeconds: 15,
        focus: "deckChangeLayout",
      },
      {
        title: "Slide pictures",
        caption: "Slide pictures: upload from this device, find web images, or generate an AI picture.",
        narration: "Choose Slide pictures in the toolbar. The Picture panel offers Upload from this device, Find web images, and Generate AI picture. Generating needs an image model; without one the panel says so and the button stays off.",
        durationSeconds: 16,
        focus: "deckPicturePanel",
      },
      {
        title: "Upload a picture and add alt text",
        caption: "The picture fills the slide's picture area. Alt text describes it for screen readers.",
        narration: "Choose Upload from this device and pick a picture. It fills the slide's picture area. Type a short description in Alt text: screen readers read it aloud, and it is kept in the PowerPoint export.",
        durationSeconds: 14,
        focus: "deckPictureAdded",
      },
      {
        title: "Find web images",
        caption: "Describe the picture and choose Find web images. If nothing comes back, try other words.",
        narration: "To search the web instead, describe the picture and choose Find web images, then choose a result. If nothing comes back, as here, the panel says No web images were found. Try other words, or upload your own.",
        durationSeconds: 15,
        focus: "deckWebImages",
      },
      {
        title: "Format slide text",
        caption: "Select words in a text box: the floating toolbar sets size, bold, color, and more.",
        narration: "Click a text box and select some words. The floating text toolbar appears: Ask AI, font size, Bold, Italic, Underline, Text color, list levels, and Clear formatting. With nothing selected, it formats the whole box.",
        durationSeconds: 16,
        focus: "deckTextToolbar",
      },
      {
        title: "Theme colors",
        caption: "Text color opens Theme colors, drawn from the deck's theme.",
        narration: "Text color opens the deck's theme colors, so slides stay consistent. Point at a swatch to read its name, then choose one. Theme color at the end returns the text to the layout's color.",
        durationSeconds: 14,
        focus: "deckTextColors",
      },
      {
        title: "When text no longer fits",
        caption: "Bigger text than the box holds is shrunk to fit, and the toolbar says so.",
        narration: "Here the bullets were made bigger than the box can hold. The box shrinks them to fit, and the toolbar says Shrunk to fit, as PowerPoint does. If it says Text overflows this box, shorten the text, size it down, or drag a corner.",
        durationSeconds: 16,
        focus: "deckTextFit",
      },
      {
        title: "Edit slide with AI",
        caption: "Edit slide with AI reviews Before and After in the left panel. Apply to slide accepts it.",
        narration: "To fix it with AI, choose Edit slide with AI in the toolbar and pick an action, here Cut the text in half. The left panel shows Before and After. Check the speaker notes too, because this reply rewrote them. Choose Apply to slide, or Try again, or Discard.",
        durationSeconds: 18,
        focus: "deckAiReview",
      },
      {
        title: "Edit only the highlighted text",
        caption: "Highlight words and choose Ask AI: Edit slide text with AI changes just those words.",
        narration: "To change only some words, highlight them and choose Ask AI in the text toolbar. The panel opens as Edit slide text with AI. Describe the change or pick an action, then review it and choose Replace.",
        durationSeconds: 15,
        focus: "deckAiText",
      },
      {
        title: "Slide background",
        caption: "Slide background puts your own image behind one slide or every slide.",
        narration: "Slide background puts your own image behind the slide. Upload background adds it to this slide; Use on every slide, Remove from this slide, and Clear from all slides manage it.",
        durationSeconds: 13,
        focus: "deckBackgroundMenu",
      },
      {
        title: "The fit check",
        caption: "After the deck assistant revises the slides, its fit check confirms every slide's text fits.",
        narration: "When the deck assistant drafts or revises every slide, it checks that each slide's text fits its boxes, and rewrites any that do not. The rail reports it: Fit check, every slide's text fits its boxes. The revision is saved as a new version, so the toolbar already shows Saved.",
        durationSeconds: 20,
        focus: "deckFitCheck",
        calloutPlacement: "right-mid",
      },
      {
        title: "Layouts that make one point",
        caption: "Highlights jumps to Statement, Big number, Quote, and Closing.",
        narration: "When a slide has one thing to say, skip the bullets. In Add a slide, Highlights jumps to Statement, Big number, Quote, and Closing.",
        durationSeconds: 10,
        focus: "deckAddHighlights",
      },
      {
        title: "A Statement slide",
        caption: "Statement sets one sentence in large type, with a supporting line below it.",
        narration: "Statement sets one sentence in large type, with a supporting line below it. Use it for the idea you want people to remember.",
        durationSeconds: 10,
        focus: "deckStatement",
      },
      {
        title: "A Big number slide",
        caption: "Big number puts one figure on the slide, with what it measures below it.",
        narration: "Big number does the same for a figure. Type the number in the top box and what it measures below it. One number per slide reads faster than a chart of ten.",
        durationSeconds: 11,
        focus: "deckBigNumber",
      },
      {
        title: "Picture + bullets",
        caption: "Picture + bullets sets a picture beside a short list.",
        narration: "Picture plus bullets, under Pictures, sets a picture beside a short list. Add the picture from Slide pictures, as you saw earlier, and keep the list short so it does not crowd the picture.",
        durationSeconds: 13,
        focus: "deckPictureBullets",
      },
    ],
  },
  {
    id: "spreadsheet-basics",
    audioSrc: "training/user/spreadsheet-basics.mp3",
    title: "Build a spreadsheet with the assistant",
    description: "Ask the Spreadsheet Assistant for a workbook in plain words, read how it was built, check its formulas, change one cell or a whole table with Ask AI, and go back with Undo or a saved version.",
    icon: "drafts",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["A workbook built from a plain request", "Formulas and totals checked by hand", "One cell and a whole table changed with Ask AI, reviewed first", "A change undone and an earlier version restored"],
    prerequisites: [
      "Access to Drafts and an available model. The model picker at the top of the editor shows which one is in use.",
      "No file is needed. To build from your own data, have a CSV or Excel file ready.",
    ],
    setupSteps: [
      "Open Drafts and choose Spreadsheet in the format rail.",
      "In the message box, describe the sheet: name the columns, say how many rows, say what each calculated column does, and say where totals go. Or choose a suggestion and edit it.",
      "Press Enter or choose the send key. The work trace runs in Draft chat while the grid waits.",
      "When it finishes, read the trace. Recalculated every formula means no formula shows an error. It does not mean the numbers are right.",
      "Select a calculated cell and press F2 to see the cells it reads. Press Esc to leave it unchanged.",
      "Select the numbers above a total and compare the Sum in the status bar with the total.",
      "If they differ, select the total, press F2, and read which cells it adds. Then select the cells to fix, choose Ask AI, and say exactly what to change.",
      "To change one cell, type a label beside it if it needs one, select it, and choose Ask AI (Ctrl+J, ⌘J on a Mac). Type what you want or pick an action.",
      "Check the Preview and the highlighted cells, then choose Apply, Try again, or Discard.",
      "To change a whole table, select all of it and use Ask AI the same way.",
      "If a change is wrong, choose Undo (Ctrl+Z, ⌘Z on a Mac). An AI change undoes in one step.",
      "To revise the whole workbook, type in the message box again. It changes the workbook at once and saves a new version, so check the result. Short requests work better than one long one.",
      "Choose Document history and, under Versions of this draft, choose a version to restore it. This changes only the screen, so export it or save a change to keep it. The list clears when you leave Drafts, reload, or reopen the draft, which then starts again at Version 1.",
    ],
    paths: [
      {
        label: "Build from your own data",
        steps: [
          "Choose the paperclip, then Attach to chat, and pick a CSV or Excel file.",
          "Ask for what you want from it, for example Turn my attached data into a clean table with totals and a chart.",
          "The assistant reads the file's rows as its data. To edit the file's cells yourself instead, choose Open in editor.",
        ],
      },
      {
        label: "Start from a chat",
        steps: [
          "Ask for a spreadsheet in chat, for example a budget in Excel.",
          "If the card Build this as a spreadsheet? appears, choose Build in spreadsheet editor. Drafts opens and starts building.",
          "Continue in chat keeps the answer in the conversation instead.",
        ],
      },
      {
        label: "Send a table from a reply",
        steps: [
          "Under a reply that has a table, choose Transfer to Drafts.",
          "Choose Spreadsheet. Each table in the reply becomes a sheet you can edit.",
        ],
      },
      {
        label: "Use your sources or the web",
        steps: [
          "Choose Sources above Draft chat and select a workspace source, or turn on Web if your workspace allows it.",
          "Ask for the workbook as usual. With Web on, the assistant is told to put each source's name in a cell note on the numbers it supports.",
        ],
      },
      {
        label: "Ask AI actions",
        steps: [
          "Select cells and choose Ask AI. Press Ctrl+J, ⌘J on a Mac, or right-click and choose Ask AI about this.",
          "Write a formula for this cell, Explain these formulas, Fix formula errors, and Add a totals row are at the top of the list, with actions for cleaning and analyzing data below them.",
          "After a Preview, type in the box under it to adjust the result, for example round to dollars.",
        ],
      },
      {
        label: "Choose another model",
        steps: [
          "Open the model picker at the top of the editor and choose a model.",
          "Assistant settings, beside the paperclip, also sets the reasoning level and whether sources must be cited.",
        ],
      },
    ],
    verify: [
      "The grid shows the columns you asked for, and the draft has taken the workbook's name.",
      "The work trace says Recalculated every formula, None show an error.",
      "Selecting a calculated cell shows a formula in the formula bar, not a typed number.",
      "The status bar's Sum matches the workbook's total, and the total's formula adds only the rows above it.",
      "After Undo the AI change is gone, and after restoring a version the label at the top names that version.",
    ],
    troubleshooting: [
      { symptom: "The result is not what you asked for: numbers in the wrong place, a blank sheet left over, or missing headers", fix: "Small models do this with long requests. Restore the last version in Document history, then ask again in smaller steps, and say exactly which row holds the headers. Build the table first, then add the chart in a second request." },
      { symptom: "A total is too high, often about double, yet the trace says None show an error", fix: "The formula works, so no error shows, but its range is wrong. Select the total and press F2: a range that reaches into another total counts those rows twice. Ask AI can correct it, and saying which rows to add and which row holds the total helps." },
      { symptom: "The work trace says a formula \"still shows an error\"", fix: "Select one of the named cells and use Ask AI with Fix formula errors, or correct the formula yourself. A cell with an error has a small mark in its corner." },
      { symptom: "The work trace says Fixing 25 formulas that errored", fix: "Nothing is wrong. The first pass left a formula error, so the cells went back to the model once. Read the check that follows it." },
      { symptom: "\"The model's reply was not valid spreadsheet changes twice, so nothing was applied. Try rephrasing the request.\"", fix: "Your workbook is unchanged. Make the request shorter and more specific, or choose another model." },
      { symptom: "The work trace says Answered without changing the workbook", fix: "It treated your message as a question. Say what to change, for example add a column called Status." },
      { symptom: "The work trace says Skipped 2 changes", fix: "The assistant asked for something the workbook could not accept, and Draft chat lists each one. Ask for those changes again in plain words." },
      { symptom: "The grid will not accept typing and the box says \"The spreadsheet assistant is building your workbook...\"", fix: "The grid is locked while the assistant works, and a long request on a small model can take minutes. Wait for Worked for in the trace." },
      { symptom: "\"New revisions will appear after you save or ask the assistant to revise.\" on a draft that had versions", fix: "The list covers versions made since you opened the draft. A reopened draft starts again at Version 1 with your latest saved work, and earlier versions are no longer listed. Export any version you want to keep before you leave it." },
      { symptom: "\"No drafting model connected\", or Ask AI is off", fix: "No model is available to you. Ask your administrator for model access. The grid, tables, charts, and exports still work without one." },
      { symptom: "Ask AI changed more cells than you expected", fix: "It works on the selection. Choose Discard, select only the cells you mean, and ask again." },
    ],
    scenes: [
      {
        title: "Know what to ask for",
        caption: "A good workbook starts with a clear request.",
        narration: "A good spreadsheet starts with a clear request. Before you ask, decide what the sheet is for, which columns you want, how many rows, what each calculated column does, and what to total. The more of this you say, the less you fix later.",
        durationSeconds: 16,
        card: {
          label: "Checklist",
          where: "Decide these first",
          steps: [
            "What the sheet is for, in one line",
            "The column names, in order",
            "How many rows, or a file with the real data",
            "What each calculated column does",
            "What to total, and where the total goes",
          ],
        },
      },
      {
        title: "Choose Spreadsheet",
        caption: "In Drafts, the format rail switches between Document, Deck, and Spreadsheet.",
        narration: "Open Drafts and choose Spreadsheet in the format rail. A blank workbook opens on the right, and the left panel becomes the Spreadsheet Assistant.",
        durationSeconds: 10,
        focus: "sheetFormatRail",
      },
      {
        title: "Start from a suggestion",
        caption: "A suggestion fills the message box, so you can edit it before sending.",
        narration: "Three suggested requests help you start. Choosing one puts it in the message box, so you can change it before you send it. To write your own, just type in the box.",
        durationSeconds: 12,
        focus: "sheetSuggestions",
      },
      {
        title: "Write a plain, specific request",
        caption: "Name the columns, the row count, the calculation, and where the total goes.",
        narration: "Use plain words and be specific. Here the request names the columns and where they go, asks for six rows of sample vendors, says how Variance is worked out, and says where the total goes. Then press Enter, or choose the send key.",
        durationSeconds: 17,
        focus: "sheetRequest",
      },
      {
        title: "Watch it work",
        caption: "The work trace shows each step, and the grid waits until it finishes.",
        narration: "Your request moves into Draft chat, and the work trace runs under it, with a timer, each step as it lands, and what comes next. The grid stays locked until it finishes. How long that takes depends on your model and how busy it is.",
        durationSeconds: 16,
        focus: "sheetWorking",
      },
      {
        title: "Read the result",
        caption: "The workbook lands in the grid. Read it like a first draft.",
        narration: "The workbook lands in the grid, and the draft takes its name. Read it like a first draft, not a finished answer. Are the headers right, are the rows in the right place, and do the numbers make sense?",
        durationSeconds: 13,
        focus: "sheetBuiltGrid",
      },
      {
        title: "Read the trace",
        caption: "Recalculated every formula means no errors, not that the numbers are right.",
        narration: "The trace reads Worked for, with the time and the steps. That long time is not normal: this ran on a small local test model with other work queued, and hosted models answer far faster. Recalculated every formula means no formula shows an error. It does not mean the numbers are right, so check them yourself.",
        durationSeconds: 21,
        focus: "sheetBuiltTrace",
      },
      {
        title: "Check a formula",
        caption: "Press F2 on a calculated cell to see the cells it reads, outlined in color.",
        narration: "Never take a number on trust. Select a calculated cell and press F2. The formula opens, and the cells it reads are outlined in color, so you can see that Variance really is Budget minus Actual. Press Escape to leave it unchanged.",
        durationSeconds: 17,
        focus: "sheetCheckFormula",
      },
      {
        title: "Check a total",
        caption: "Select the numbers above a total and compare the Sum in the status bar.",
        narration: "To check a total, select the numbers above it. The status bar adds them up: seventy five thousand dollars. That matches the Total row, but the bold row under it says one hundred fifty thousand. One of these is wrong, and this check is how you find out.",
        durationSeconds: 17,
        focus: "sheetCheckSum",
      },
      {
        title: "Find the mistake",
        caption: "The colored outline shows this sum reaches into the Total row, so it counts twice.",
        narration: "The draft was reopened here, so Draft chat is clear and the label reads Version 1. Select the bold total and press F2. It adds rows two to eight, and row eight is already a total, so everything counts twice. Neither that nor row eight's typed numbers is a formula error, so the trace didn't flag them.",
        durationSeconds: 21,
        focus: "sheetCheckTotal",
      },
      {
        title: "Fix it with Ask AI",
        caption: "Select the rows, say exactly what to change, and check the Preview.",
        narration: "Select the two rows and choose Ask AI, or press Control J, Command J on a Mac. Say exactly what you want: use SUM formulas for rows two to seven in row eight, then clear row nine. The Preview highlights what will change. Choose Apply.",
        durationSeconds: 17,
        focus: "sheetFixPreview",
      },
      {
        title: "Confirm the fix",
        caption: "Row 8 now holds a live formula, and the extra row is gone.",
        narration: "Row eight now holds a live formula, the extra row is gone, and the total still reads seventy five thousand, the same as the status bar's Sum. Next time, say which rows to add and where the total goes: put one total in row eight, adding rows two to seven. Small, exact instructions get the best results.",
        durationSeconds: 21,
        focus: "sheetFixApplied",
      },
      {
        title: "Ask AI about one cell",
        caption: "Select one cell and choose an action, or type what you want.",
        narration: "Ask AI works on whatever you've selected, so it also suits a single cell. Here B 10 is selected, beside a typed label. Pick an action, or type what you want. Use the word formula and say which cell, so the answer lands where you expect.",
        durationSeconds: 17,
        focus: "sheetAskOpen",
      },
      {
        title: "Review before you apply",
        caption: "Ask AI shows a Preview with the changed cells highlighted. Nothing is kept until Apply.",
        narration: "Ask AI never changes the sheet on its own. Its answer is a Preview, with the changed cells highlighted in the grid. Apply keeps it, Try again asks for another, and Discard leaves the sheet as it was. The box below lets you adjust it.",
        durationSeconds: 17,
        focus: "sheetAskCellPreview",
      },
      {
        title: "A live formula, not a typed number",
        caption: "The formula bar shows a formula, so the answer stays right as the data changes.",
        narration: "Apply writes it in. The formula bar shows a live formula, not a typed number, so the answer stays right when the data changes. Ask for formulas whenever you can.",
        durationSeconds: 12,
        focus: "sheetAskCellApplied",
      },
      {
        title: "Change a whole table",
        caption: "The selection sets the scope. Read the Preview for anything you did not ask for.",
        narration: "The selection sets the scope. Select the whole table and ask for something bigger, here a Status column. Every cell it would change is highlighted. Read the Preview too: this reply also added a red highlight nobody asked for. If you don't want extras, say so, or choose Try again.",
        durationSeconds: 19,
        focus: "sheetAskTablePreview",
      },
      {
        title: "Undo in one step",
        caption: "Undo removes the whole AI change at once, and Redo brings it back.",
        narration: "An AI change counts as one step. If it isn't right after all, choose Undo, or press Control Z, Command Z on a Mac, and all of it goes at once, as the Status column has here. Redo brings it back.",
        durationSeconds: 15,
        focus: "sheetUndo",
      },
      {
        title: "Ask a question",
        caption: "Explain these formulas answers in plain words and changes nothing.",
        narration: "Ask AI answers questions too. Select some cells and choose Explain these formulas. It explains them in plain words and changes nothing, so the button says Done. It's a good way to understand a workbook someone else built.",
        durationSeconds: 16,
        focus: "sheetExplain",
      },
      {
        title: "Revise the whole workbook",
        caption: "The message box changes the workbook at once, so check the result.",
        narration: "For bigger changes, use the message box again. The trace says Updated the workbook and Saved as the next version. There's no Preview here, so the version before this one is your way back. Check this result too: the chart includes the Total row, which is the tall bar. Double-click the chart and shorten its Data range.",
        durationSeconds: 21,
        focus: "sheetRailUpdate",
      },
      {
        title: "Find your versions",
        caption: "Document history lists the versions made since you opened this draft.",
        narration: "Choose Document history, the clock at the top of the panel. Versions of this draft lists each version made since you opened it, with what changed. Before a big change, choose Save, so you have a version of your own to come back to.",
        durationSeconds: 15,
        focus: "sheetVersions",
      },
      {
        title: "Go back to a version",
        caption: "Choose a version to restore it. Export it or save a change to keep it.",
        narration: "Choose a version to restore it. The label shows which one you're on, and newer versions stay in the list. The chart has gone because Version 2 had none. This changes only the screen: your account still holds your latest save. To keep this version, export it now, or change something and choose Save.",
        durationSeconds: 20,
        focus: "sheetVersionRestored",
      },
      {
        title: "The list does not last",
        caption: "Leaving Drafts or reopening the draft clears the list.",
        narration: "The list does not last. Leave Drafts, reload the page, or reopen the draft, and it clears. The draft starts again at Version 1, with your latest saved work.",
        durationSeconds: 12,
        focus: "sheetVersionRestored",
      },
    ],
  },
  {
    id: "spreadsheet-editing",
    audioSrc: "training/user/spreadsheet-editing.mp3",
    title: "Work in a spreadsheet: formulas, tables, charts, and files",
    description: "Start from a template or your own file, turn data into a table with formulas that use column names, summarize it with a pivot table and a chart, add rules that format, check, and filter it, then export an Excel file and compare versions.",
    icon: "drafts",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["A table whose formulas use column names", "A pivot table and chart built from the data", "Rules that format, restrict, and filter the data", "An Excel file exported, reopened, and checked"],
    prerequisites: [
      "Access to Drafts. Nothing in this lesson needs a model.",
      "For your own data, an .xlsx, .xlsm, .csv, or .tsv file of 12 MB or less.",
      "New to spreadsheets in Drafts? Build a spreadsheet with the assistant is the shorter place to start.",
    ],
    setupSteps: [
      "In Drafts, choose Spreadsheet in the format rail.",
      "Choose the paperclip, then Open in editor, and pick your Excel or CSV file. It opens as a new workbook, and Draft chat records it.",
      "If a column shows hash marks, select the columns, open Format (the highlighter key), and choose Auto-fit column width.",
      "Type the header of any column you plan to calculate, such as Total, next to the data.",
      "Click inside the data, open Format, and choose Format as table…. Check Table range and My data has a header row, type a Table name such as Invoices, and choose Create table.",
      "Select the empty cells of the calculated column, type a formula with column names, such as =[@Units]*[@[Unit price]], and press Ctrl+Enter (⌘Enter on a Mac) to fill them all.",
      "On another sheet, total the column by name, such as =SUM(Invoices[Total]), and compare it with the Sum in the status bar.",
      "Click inside the table, open Table styles, and pick a style.",
      "Open Insert (the plus key) and choose Pivot table…. Under Use as, set a field to Rows and a number field to Values, then choose Create pivot table.",
      "Select the pivot's header and rows, open Insert, choose Chart…, pick a type, type a Title, and choose Insert chart.",
      "Select cells, open Format, choose Conditional formatting…, pick a rule under Format cells if, and choose Add rule.",
      "Select a column, open Data (the funnel key), choose Data validation…, type the Choices (comma separated), and choose Add rule.",
      "Choose a column's filter button, clear the values you do not want or set a Condition, and choose Apply. Data › Clear filter choices brings the rows back.",
      "Open Format and choose Freeze top row.",
      "Choose Export. If the panel says Save your edits first, choose Save version. Then choose Excel workbook or CSV (current sheet).",
      "Read any Export note in Draft chat, then open the file to check it.",
      "After more edits, choose Save version again, then Compare versions, and check the cells that changed. Do this before you leave the draft, because a reopened draft starts a new version list. In a narrow window these two buttons read Save and Compare.",
    ],
    paths: [
      {
        label: "Start from a template",
        steps: [
          "Choose Spreadsheet, then Templates above Draft chat.",
          "Select a workbook: Monthly budget, Sales tracker, Project plan, Invoice, Expense report, Loan calculator, Inventory tracker, or KPI dashboard.",
          "Choose Start and the workbook's name, such as Start Sales tracker. It opens as a new spreadsheet draft.",
          "The sample data is fictional. Type over it, and the formulas, tables, and charts follow.",
        ],
      },
      {
        label: "Start from a blank workbook",
        steps: [
          "Choose Spreadsheet. A blank workbook starts on Sheet1.",
          "Click a cell and type. Enter moves down and Tab moves right.",
          "Type = to start a formula. Function names are suggested as you type, and Tab accepts one.",
        ],
      },
      {
        label: "Open an Excel workbook",
        steps: [
          "Choose the paperclip, then Open in editor, and pick an .xlsx or .xlsm file.",
          "Every sheet opens, and Draft chat says how many.",
          "Read any line that starts with Import note. It names something the editor changed or could not keep.",
        ],
      },
      {
        label: "Make a table from the Table styles key",
        steps: [
          "Click inside data that has a header row, with no tables on the workbook yet.",
          "Open Table styles. The menu says which range it will format, such as Format A1:F31 as a table.",
          "Pick a style. To name the table or add a totals row, choose More table options….",
        ],
      },
      {
        label: "Add a totals row to a table",
        steps: [
          "Click inside the table and open Table styles, then More table options….",
          "Turn on Totals row. Number columns get a total, and the table grows by one row.",
        ],
      },
      {
        label: "AutoSum and the function list",
        steps: [
          "Select the cell under a column of numbers, open More, and choose Sum, Average, Count numbers, Max, or Min under AutoSum. In a wider window AutoSum has its own key.",
          "For anything else, open Insert and choose Function…. Search by name or by what you want to do, then choose a function to start it in the cell.",
        ],
      },
      {
        label: "Sort and clean up data",
        steps: [
          "Open Data and choose Sort A → Z… or Sort Z → A…. Add level sorts by a second column.",
          "Remove duplicates… removes rows that repeat an earlier row in the columns you check.",
          "Split text to columns… splits a column at a comma, semicolon, space, tab, or a separator you type.",
        ],
      },
      {
        label: "Name a cell or range",
        steps: [
          "Select the cells, type a name in the Name box at the left of the formula bar, and press Enter.",
          "Use the name in formulas, such as =B4*TaxRate. Data › Named ranges… lists every name.",
        ],
      },
      {
        label: "Notes, find, and shortcuts",
        steps: [
          "Insert › Note adds a note to the selected cell. It exports to Excel as a comment.",
          "Find in the status bar searches this sheet, all sheets, or formulas, and can replace.",
          "The keyboard key in the status bar lists every shortcut. Ctrl+/ (⌘/ on a Mac) opens it too.",
        ],
      },
    ],
    verify: [
      "Every row of the calculated column shows a value, and the formula bar shows the same column-name formula in each one.",
      "=SUM(Invoices[Total]), the pivot's Grand Total, and the status bar's Sum all show the same number.",
      "Typing a value that is not on the list is refused, with a message starting Choose one of.",
      "The Export panel says Sent to your browser downloads, and the file opens again through Open in editor with its sheets, table, and chart.",
      "Compare versions lists the cells you changed, with what each held before and after.",
    ],
    troubleshooting: [
      { symptom: "A column shows hash marks (########)", fix: "The column is too narrow for the value, and nothing is lost. Select it, open Format, and choose Auto-fit column width, or drag the column's right edge." },
      { symptom: "A filter button covers a column's header", fix: "Auto-fit does not leave room for the button. Drag the column's right edge wider." },
      { symptom: "#REF! in a formula that uses [@Units]", fix: "The @ reads this row of the table, so the formula must sit inside the table, and typing beside a table does not add to it. Click a cell in the table's last column, open Insert, and choose Columns left, then type the header and formula in the new column. Columns right from the last column lands outside the table." },
      { symptom: "Double-clicking the square at a cell's corner opens the cell", fix: "Fill down another way: drag the square down the column, or select the cells and press Ctrl+D (⌘D on a Mac)." },
      { symptom: "\"That name is already used.\"", fix: "Table names must be unique in the workbook. Type another one." },
      { symptom: "\"That range overlaps a table, so it was not formatted.\"", fix: "A range can belong to only one table. Pick cells outside it, or choose Convert to range on the existing table first." },
      { symptom: "\"Click inside your data, or select a range with a header row, to make it a table.\"", fix: "The selected cell has no data around it. Click a cell in the data, then open Table styles again." },
      { symptom: "\"This cell is part of a pivot table. Change the pivot from its panel.\"", fix: "Pivot cells are calculated. Click inside the pivot, open Insert, choose Pivot table…, and change it there, or change the source data." },
      { symptom: "\"No field names found in the first row of the source.\"", fix: "Source data must start on a row of column names. Correct the range, for example to start at row 1." },
      { symptom: "\"Choose one of: …\"", fix: "The cell has a list rule. Pick a value from its arrow, or press Esc to cancel. To accept other values, select the cell, open Data › Data validation…, and turn off Reject entries that break the rule." },
      { symptom: "\"Fill in the rule's values first.\"", fix: "The rule has no choices or limits yet. Fill in Choices (comma separated), or the Value fields, then choose Add rule." },
      { symptom: "\"Old .xls files are not supported. Save it as .xlsx in Excel first.\"", fix: "Open the file in Excel, save it as .xlsx, and open that copy." },
      { symptom: "\"… is larger than 12 MB.\"", fix: "Open a smaller file, or remove sheets you do not need and save a copy." },
      { symptom: "\"Export note: Pivot tables export as values.\"", fix: "The file keeps the pivot's numbers, but they will not update there. Rebuild the pivot in the other app if you need it live." },
      { symptom: "\"Export note: The filter on … overlaps a table, which has its own filter, so it was left out.\"", fix: "The table keeps its filter buttons in the file. Any choices made with them are not saved in the file, so set them again there." },
      { symptom: "Compare versions is off: \"Save two different versions of this draft to compare them\"", fix: "Make a change, choose Save version, and try again. Versions from before you reopened the draft no longer count." },
      { symptom: "\"These versions hold the same cells.\"", fix: "Nothing in the cells differs between the two you picked. Choose another Base or Compared with." },
    ],
    scenes: [
      {
        title: "Start from a template",
        caption: "Templates lists eight ready-made workbooks. Select one and choose Start.",
        narration: "In Drafts, choose Spreadsheet, then Templates above the chat. Eight ready-made workbooks are listed, including a budget, a project plan, an invoice, and a loan calculator. Select one, here Sales tracker, and choose Start Sales tracker.",
        durationSeconds: 17,
        focus: "sheetTemplates",
      },
      {
        title: "A template is a live workbook",
        caption: "It opens as a new workbook with real sheets, tables, and formulas.",
        narration: "The template opens as a new workbook. Its tabs are real sheets, here Orders, Pivot, and Summary. The sample data is fictional, so type over it, and the formulas, tables, and charts follow.",
        durationSeconds: 14,
        focus: "sheetTemplateTabs",
      },
      {
        title: "Open your own file",
        caption: "The paperclip's Open in editor puts an Excel or CSV file in the grid.",
        narration: "To use your own data, choose the paperclip, then Open in editor. It opens an Excel workbook or a C S V file as a new workbook you edit directly. Attach to chat is different: the assistant reads that file, but it stays out of the grid.",
        durationSeconds: 17,
        focus: "sheetOpenMenu",
      },
      {
        title: "Read what came in",
        caption: "Hash marks mean a column is too narrow. The values are safe.",
        narration: "The file opens on its own sheet, named after the file, and the chat records it. Hash marks in a column only mean it is too narrow for its values. Nothing is lost, and the next step fixes it.",
        durationSeconds: 14,
        focus: "sheetDateColumn",
        calloutPlacement: "right-mid",
      },
      {
        title: "The Format menu",
        caption: "Format holds conditional formatting, tables, freeze panes, and auto-fit.",
        narration: "Four keys near the end of the toolbar hold most of the tools: Insert is the plus, Data is the funnel, Format is the highlighter, and Table styles is the small table. Select the columns, open Format, and choose Auto-fit column width.",
        durationSeconds: 17,
        focus: "sheetFormatMenu",
      },
      {
        title: "Make the data a table",
        caption: "Format as table finds the range. Name the table and choose Create table.",
        narration: "Type the header of any column you plan to calculate first, here Total, because typing beside a finished table doesn't add to it. Click inside the data, open Format, and choose Format as table. The panel finds the range and the header row. Name the table, here Invoices, then scroll the panel down and choose Create table.",
        durationSeconds: 21,
        focus: "sheetTablePanel",
        calloutPlacement: "left-rail",
      },
      {
        title: "What a table gives you",
        caption: "A colored header, banded rows, and a filter button on every column.",
        narration: "The data is now a table, with a colored header, banded rows, and a filter button on every column. If a button covers a header, drag the column's edge wider. The bigger gain is in formulas, because they can now use the table's name and its columns.",
        durationSeconds: 17,
        focus: "sheetTableHeader",
      },
      {
        title: "Write a formula with column names",
        caption: "[@Units] reads this row's Units. Press Ctrl or ⌘ Enter to fill the selection.",
        narration: "Select the empty Total cells and type a formula that uses column names instead of cell addresses: equals, at Units, times, at Unit price. The at sign means this row, and a name with a space gets a second pair of brackets. Press Control Enter, Command Enter on a Mac, to fill every selected cell.",
        durationSeconds: 21,
        focus: "sheetFormulaTyping",
      },
      {
        title: "Check it in the status bar",
        caption: "Select cells and the status bar shows their Sum, Average, Min, and Max.",
        narration: "Every row now has its total, and the formula reads the same in each one, so it's easy to trust. With the column selected, the status bar shows the Sum, Average, Min, and Max. Use it as a quick check on any number.",
        durationSeconds: 16,
        focus: "sheetStatusSum",
      },
      {
        title: "Total a table by name",
        caption: "=SUM(Invoices[Total]) works from any sheet and reads the whole column.",
        narration: "Table names work on every sheet. Here, on a new Summary sheet, equals SUM of Invoices, with Total in brackets, adds the whole column, and shows the same number as the status bar. More, then Currency format, makes it read as dollars.",
        durationSeconds: 17,
        focus: "sheetNamedTotal",
      },
      {
        title: "Restyle with the gallery",
        caption: "Table styles offers three tones of six colors, applied as you pick.",
        narration: "Click inside the table and open Table styles. The gallery has Light, Medium, and Dark tones of six colors, and the table changes as you pick, so try a few. Below it, switch Banded rows, Filter buttons, and Bold first column on or off.",
        durationSeconds: 17,
        focus: "sheetStyleGallery",
      },
      {
        title: "The Insert menu",
        caption: "Insert adds rows and columns, and opens Chart, Table, Pivot table, and more.",
        narration: "Insert adds rows and columns beside the selection, and opens Chart, Table, Pivot table, Note, and Function. Function lists every function with a short description, and you can search it. Sheet adds a tab. Not sure of a name? Search Function by what you want to do.",
        durationSeconds: 18,
        focus: "sheetInsertMenu",
      },
      {
        title: "Build a pivot table",
        caption: "Under Use as, set the field to group by to Rows and the number to Values.",
        narration: "Click inside the data, open Insert, and choose Pivot table. Source data is filled in for you. Under Use as, tell it what each field does. Here Vendor goes to Rows and Total goes to Values, summed. New sheet keeps it apart from your data. Scroll the panel down and choose Create pivot table.",
        durationSeconds: 20,
        focus: "sheetPivotPanel",
        calloutPlacement: "left-rail",
      },
      {
        title: "Read the pivot",
        caption: "One row per vendor, and a Grand Total that matches the table.",
        narration: "The pivot appears on its own sheet, with one row per vendor and a Grand Total that matches the table. It updates when the source data changes. Its cells can't be typed over, so to change it, click inside it and open Pivot table again.",
        durationSeconds: 17,
        focus: "sheetPivotResult",
      },
      {
        title: "Insert a chart",
        caption: "Select the header and the rows to chart, then pick a type and check the preview.",
        narration: "Select what to chart, including the header row but not the Grand Total. Open Insert and choose Chart. Pick a type, here Bar, and watch the preview. The first column gives the labels, and the first row names the series. Scroll the panel down, add a Title, and choose Insert chart.",
        durationSeconds: 19,
        focus: "sheetChartPanel",
        calloutPlacement: "left-rail",
      },
      {
        title: "Place the chart",
        caption: "Click a chart to select it, drag to move it, and double-click for its settings.",
        narration: "The chart sits on the sheet and redraws when the numbers change. Click it to select it, drag it to move it, and drag its corner to resize it. Double-click it to reopen its settings. If it runs past the edge, zoom out in the status bar, as here at seventy five percent.",
        durationSeconds: 18,
        focus: "sheetChartPlaced",
      },
      {
        title: "Conditional formatting",
        caption: "Rules color cells by their values, and they update as the data changes.",
        narration: "Select the cells, open Format, and choose Conditional formatting. Pick a rule under Format cells if, then choose Add rule. Here Data bars draw a bar in each Total, and Text contains, with the word Late, turns those statuses red. Rules on this sheet lists them, with keys to reorder or delete.",
        durationSeconds: 20,
        focus: "sheetConditional",
        calloutPlacement: "left-rail",
      },
      {
        title: "The Data menu",
        caption: "Data sorts and filters, and holds the clean-up tools.",
        narration: "Data, the funnel key, sorts and filters, and holds the clean-up tools: Remove duplicates, Split text to columns, Data validation, and Named ranges. Run Remove duplicates before you build a pivot, so repeated rows don't inflate its totals.",
        durationSeconds: 18,
        focus: "sheetDataMenu",
      },
      {
        title: "Data validation",
        caption: "A list of choices keeps a column to the values you allow.",
        narration: "Select the Status cells, open Data, and choose Data validation. Keep A list of choices, and type the choices with commas between them. Reject entries that break the rule is on, so anything else is refused. Choose Add rule.",
        durationSeconds: 16,
        focus: "sheetValidationPanel",
        calloutPlacement: "left-rail",
      },
      {
        title: "Pick from the list",
        caption: "The selected cell shows an arrow that opens its choices.",
        narration: "Select a cell in the range and an arrow appears on it. Choose the arrow to open the list, then pick a value. A dropdown like this keeps a column clean, so filters and pivots group it correctly.",
        durationSeconds: 13,
        focus: "sheetValidationList",
      },
      {
        title: "A refused entry",
        caption: "Anything else is refused, and the sheet says what is allowed.",
        narration: "Type something that isn't on the list and press Enter. The cell stays open, and a message says, Choose one of Open, Paid, Late. Correct it, or press Escape to cancel.",
        durationSeconds: 12,
        focus: "sheetValidationNotice",
      },
      {
        title: "Filter a column",
        caption: "A filter button sorts the column, sets a condition, or picks values to show.",
        narration: "Choose the filter button on a column. You can sort, set a Condition such as Greater than, or clear the values you don't want to see. Here Paid is cleared, so only Late and Open stay. Choose Apply.",
        durationSeconds: 14,
        focus: "sheetFilterMenu",
      },
      {
        title: "See what the filter hides",
        caption: "Other rows are hidden, not deleted, and the row numbers skip.",
        narration: "Only matching rows show, the button changes to a funnel, and the row numbers skip, because the others are hidden, not deleted. To bring them back, open Data and choose Clear filter choices.",
        durationSeconds: 13,
        focus: "sheetFilterApplied",
      },
      {
        title: "Freeze the header",
        caption: "Freeze top row keeps the header on screen while you scroll.",
        narration: "Open Format and choose Freeze top row. The header now stays on screen as you scroll. Freeze first column and Freeze above and left of selection work the same way, and Unfreeze panes removes it.",
        durationSeconds: 14,
        focus: "sheetFrozenHeader",
      },
      {
        title: "Export: save first",
        caption: "Exports use a saved version, so save your edits, then pick a format.",
        narration: "Choose Export. With unsaved edits, the panel says Save your edits first, because exports use a saved version. Choose Save version. Then pick Excel workbook for every sheet, or C S V for the current sheet's values only.",
        durationSeconds: 17,
        focus: "sheetExportPanel",
        calloutPlacement: "left-rail",
      },
      {
        title: "Read the export notes",
        caption: "Draft chat lists anything the file stores differently, such as pivot tables.",
        narration: "The file goes to your browser downloads, or to a location you choose. Then read the notes in the chat. Pivot tables export as values, so they won't update in the file. Here a filter on the table was left out too, because the table has its own.",
        durationSeconds: 17,
        focus: "sheetExportNotes",
      },
      {
        title: "Open the export to check it",
        caption: "Open in editor reads the .xlsx back with its sheets, table, and formatting.",
        narration: "Before you share a workbook, open the export and look. Here Open in editor reads the file back: all three sheets return, with the table, its formulas, the frozen header, and the data bars. The chart is back on the Pivot tab.",
        durationSeconds: 16,
        focus: "sheetReopened",
      },
      {
        title: "Compare two versions",
        caption: "Compare lists every cell that differs, with what it held before and after.",
        narration: "After more edits, choose Save, then Compare. Pick a Base and a version to compare it with. The list shows every cell that differs, with what it held before and after. It's read only. Compare before you leave the draft, because reopening it starts a new version list.",
        durationSeconds: 18,
        focus: "sheetCompare",
      },
    ],
  },
  {
    id: "save-and-recover-work",
    audioSrc: "training/user/save-and-recover-work.mp3",
    title: "Save, organize, and recover your drafts",
    description: "Save documents, decks, and spreadsheets to your account, reopen them from Document history, archive and restore them, return to an earlier version while the draft is open, and recover work kept only on this device.",
    icon: "drafts",
    track: "Drafts, decks, and spreadsheets",
    outcomes: ["Version saved to your account", "Draft archived and restored", "Earlier version found while the draft is open", "Device-only work reviewed"],
    prerequisites: [
      "At least one document, deck, or spreadsheet in Drafts.",
    ],
    setupSteps: [
      "In a document, deck, or spreadsheet, choose Save version (it reads Save in a narrower window) and wait for Saved at the end of the toolbar.",
      "Choose Document history (the clock at the top of the assistant rail). A document, a slide, or a grid icon marks each card's format.",
      "Point at a card to preview it, or choose the card to reopen that draft.",
      "To put finished work away, point at its card and choose Archive. Draft archived. Open Archived to restore it. confirms it.",
      "Choose Archived to find it, then choose Unarchive to bring it back to Active.",
      "Under Versions of this draft, choose a version to return to it. The list covers versions made since you opened the draft. To keep one, export it while it is on screen, or change something and choose Save version.",
      "Delete is separate: choose Delete, read the confirmation, then choose Delete draft or Cancel.",
    ],
    paths: [
      {
        label: "When a save fails",
        steps: [
          "Local only at the end of the toolbar means the latest changes are kept in this browser but have not reached your account. Point at it to read why.",
          "Choose Retry beside it once you are back online, or export a copy before you leave.",
          "If Draft changed elsewhere appears, keep your local changes safe (export), then choose Reload server copy beside it.",
        ],
      },
      {
        label: "Only on this device",
        steps: [
          "The sidebar reminder counts items only on this device. Choose it to open the list.",
          "Retry all retries chat saves. Open Drafts opens Drafts: in Document history, drafts with unsent changes are marked Local changes. Open one and choose Retry.",
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
      "Saved appears at the end of the toolbar, and the version label at the top shows the new number.",
      "A saved spreadsheet is listed in Document history beside your documents and decks.",
      "The draft is listed under Archived after archiving, and under Active after Unarchive.",
      "Versions of this draft lists each version made since you opened the draft, with its time.",
    ],
    troubleshooting: [
      { symptom: "Local only with Retry beside it (its tooltip ends \"Your changes are kept on this device.\")", fix: "The server save failed, and your changes are kept in this browser. Check your connection and choose Retry, or export a copy before you close the browser." },
      { symptom: "Not saved, with \"… and browser storage could not keep a copy.\" beside it", fix: "Keep the workspace open, then choose Retry or export your changes." },
      { symptom: "\"This draft exceeds the 2 MB server draft limit\", \"This deck exceeds the 8 MB server deck limit\", or \"This workbook exceeds the 8 MB server spreadsheet limit\"", fix: "Split the document, or remove large images, then save again. For a workbook, move data to a separate file or remove what you no longer need." },
      { symptom: "\"Draft changed elsewhere\" with Reload server copy beside it", fix: "Another tab or device saved this draft. Export your local version if you need it, then choose Reload server copy." },
      { symptom: "\"Save two different versions of this draft to compare them\"", fix: "Compare versions needs two saved versions that differ. Save again after an edit. Versions from before you reopened the draft no longer count." },
      { symptom: "\"New revisions will appear after you save or ask the assistant to revise.\" on a draft that had versions", fix: "The list covers versions made since you opened the draft. A reopened draft starts again at Version 1 with your latest saved work, and earlier versions are no longer listed. Export any version you want to keep before you leave it." },
    ],
    scenes: [
      {
        title: "Save to your account",
        caption: "Save version stores a snapshot. Saved confirms it reached your account.",
        narration: "Documents, decks, and spreadsheets all follow your account. Choose Save version, shown here as Save, and wait for Saved at the end of the toolbar. Editing means there are changes to save. Local only means the latest changes stayed in this browser: choose Retry, or export a copy.",
        durationSeconds: 19,
        focus: "draftSaveState",
      },
      {
        title: "Open Document history",
        caption: "The clock at the top of the rail lists your saved drafts, and this draft's versions.",
        narration: "Choose the clock at the top of the assistant rail to open Document history. It lists your saved documents, decks, and spreadsheets, newest first, and the versions of the draft that is open.",
        durationSeconds: 13,
        focus: "draftHistory",
      },
      {
        title: "Preview before opening",
        caption: "Point at a card to preview it. Choose the card to reopen it.",
        narration: "Point at a card, or focus it with the keyboard, to preview its content. Choose the card to reopen that draft.",
        durationSeconds: 8,
        focus: "draftHistoryPreview",
      },
      {
        title: "Spreadsheets are here too",
        caption: "A saved spreadsheet sits beside your documents and decks. A grid icon marks its card.",
        narration: "A saved spreadsheet is listed here as well, with a grid icon on its card, and the preview shows its sheets and cells. Archive, Delete, and Versions of this draft work the same way for every format. Choose the card to reopen the workbook.",
        durationSeconds: 17,
        focus: "historySpreadsheet",
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
        caption: "Versions of this draft lists what was made since you opened it. Choose one to restore it.",
        narration: "Versions of this draft lists the versions made since you opened it, with their times. Choose one to return to it. If you have unsaved edits, you are asked to keep, save, or discard them first.",
        durationSeconds: 13,
        focus: "historyVersions",
      },
      {
        title: "The list lasts while the draft is open",
        caption: "Reopening a draft clears its version list.",
        narration: "The list lasts only while the draft stays open. Leave Drafts, reload the page, or reopen the draft, and it clears: the draft starts again at Version 1, with your latest saved work, and this message shows until you save again.",
        durationSeconds: 16,
        focus: "historyVersionsCleared",
      },
      {
        title: "Keep an older version",
        caption: "Returning to a version changes the screen, not your saved draft.",
        narration: "Returning to a version only changes what is on screen. Your account still holds your latest save, so reopening the draft brings that back. To keep the older version, export it now. To make it your latest, change something, then choose Save version.",
        durationSeconds: 17,
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
        title: "When a save fails",
        caption: "Local only keeps your changes in this browser. Retry sends them again.",
        narration: "If a save cannot reach your account, here because the browser is offline, the toolbar says Local only, with Retry beside it. Your changes are kept in this browser. Choose Retry once you are back online, or export a copy before you leave.",
        durationSeconds: 17,
        focus: "draftSaveFailed",
        calloutPlacement: "right-mid",
      },
      {
        title: "Work only on this device",
        caption: "Only on this device lists unsent changes. Clearing or hiding reminders never uploads or deletes work.",
        narration: "If saves fail, a reminder in the sidebar counts items only on this device. Open Drafts opens Drafts. If a chat's save failed, Retry all appears here too. Clear list and Hide this reminder only change the reminder; neither uploads nor deletes your work.",
        durationSeconds: 19,
        focus: "unsyncedWork",
        calloutPlacement: "left-rail",
      },
      {
        title: "Find it and retry",
        caption: "In Document history, Local changes marks a draft whose latest edits are only on this device.",
        narration: "Back online, open Document history. A draft whose latest edits never reached your account is marked Local changes. Open it and choose Retry beside Local only; Saved confirms the edits are in your account.",
        durationSeconds: 15,
        focus: "historyLocalChanges",
        calloutPlacement: "right-mid",
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
    outcomes: ["Agent built and saved privately", "Agent used in chat with @", "Reply checked against the agent's instructions and knowledge"],
    prerequisites: [
      "Permission to build agents: your platform owner allows users to build their own agents, and your administrator grants Can build agents to one of your groups. Until then, Agents says Building agents is not available to you.",
      "An available model for the agent to use.",
      "Optional: knowledge bases, tools, prompts, and skill files shared with you, to attach to the agent.",
      "Agents that use the Hermes companion also need Can use Hermes companion on one of your groups. Until then they show Needs Hermes approval from your administrator, and you cannot chat with them.",
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
      "Check the reply against the agent: the trace reads Agent worked for, Working as names the agent, and the answer should follow its instructions and cite its knowledge. Smaller models can drift, so read it.",
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
      "In chat, the Agent chip shows the agent, and the reply's trace reads Agent worked for, with Working as and the agent's name, and a step for the passages found in its knowledge.",
      "The answer draws on the instructions you wrote and its knowledge, and offers its citations. Here, three bullet points from the playbook, plus extras a smaller model added.",
    ],
    troubleshooting: [
      { symptom: "\"Building agents is not available to you.\"", fix: "Your groups lack Can build agents, or the service policy does not allow user-built agents. Ask your administrator." },
      { symptom: "\"Select a base AI model and enter an agent name before saving.\"", fix: "Type a name and choose an available model in AI model." },
      { symptom: "\"… is not connected, so the agent cannot answer.\"", fix: "The agent's model has no working provider. Choose another model in Profile and save." },
      { symptom: "\"Knowledge base … is turned off, so the agent answers without it.\"", fix: "Ask the knowledge base's owner to turn it back on, or untick it." },
      { symptom: "An agent card says \"Needs Hermes approval from your administrator\", or chat says \"… uses the Hermes companion, which your administrator hasn't turned on for your groups.\"", fix: "That agent uses the Hermes companion. Ask your administrator to turn on Can use Hermes companion for one of your groups." },
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
        title: "Agents shared with you",
        caption: "A shared agent marked Needs Hermes approval stays locked until your group may use Hermes.",
        narration: "Agents shared with you are listed here too. One marked Needs Hermes approval from your administrator uses the Hermes companion, and stays locked until your administrator allows Hermes for one of your groups. This one also has no connected model, so its card says so.",
        durationSeconds: 18,
        focus: "agentsHermesLocked",
        calloutPlacement: "right-mid",
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
        title: "The trace names the agent",
        caption: "Working as the agent, and the passages it found in its knowledge.",
        narration: "While it runs, the trace opens by itself. Afterward it reads Agent worked for, with the time it took. Working as names your agent, and the next steps show the passages it found in its knowledge. This is how you confirm the right agent answered.",
        durationSeconds: 17,
        focus: "agentTrace",
      },
      {
        title: "Check the reply against the agent",
        caption: "Three bullet points from the playbook, plus extras the instructions ruled out.",
        narration: "Fold the trace to read the answer. The three bullet points come from the litigation playbook it searched, but it also adds an opening line, workflow guidance, and a diagram, though the instructions said exactly three. Smaller models drift like this, so test an agent on a real question whenever you change its instructions.",
        durationSeconds: 21,
        focus: "agentReply",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "knowledge",
    audioSrc: "training/user/knowledge.mp3",
    title: "Knowledge bases",
    description: "Build a knowledge base from files, a website, or an API, read what each file carries about itself, choose how scans are read, and ask a question that cites it.",
    icon: "knowledge",
    track: "Agents, knowledge, and automations",
    outcomes: ["Knowledge base created", "Files and a website indexed", "File properties read", "Cited answer from your documents and a page looked up on the spot"],
    prerequisites: [
      "To create your own: your administrator grants Can build knowledge bases to one of your groups. Without it, you use the knowledge bases shared with you.",
      "Files up to 250 MB each: PDF, Word, Excel, PowerPoint, email (.eml, .msg), text, Markdown, CSV, JSON, images, audio, and video.",
      "For web pages: public addresses. Sign-in pages and anything the site's robots.txt excludes are skipped; for pages behind a sign-in, paste the text instead.",
      "To read handwriting, stamps, and signatures: an image-capable model set up for your workspace. Without one, scanned pages use standard OCR.",
      "To connect an API: your administrator also grants Can add API sources. Until then, Connect an API is shown locked.",
      "Connected sources such as SharePoint, Box, Google Drive, and iManage are set up by administrators and shared with you.",
    ],
    setupSteps: [
      "Choose Library in the sidebar; Knowledge opens.",
      "Choose New knowledge base.",
      "Type a Name, keep Start with on Upload files, and choose Create. Who can search it is Only me; administrators manage sharing.",
      "Drag files onto Drag files here, or choose browse your computer.",
      "Wait for each file to show Added and appear under Indexed files with its passage count. The base shows Ready.",
      "In a chat, type # and choose your knowledge base, then type your question and send it.",
      "Check the reply: it answers from your files and offers View N citations →. Open it to see each document the reply cited in Sources gathered, then choose a row to open the document on the cited page. Check a source covers that step by step.",
    ],
    paths: [
      {
        label: "Add a web page or a whole site",
        steps: [
          "In the knowledge base, open Web pages.",
          "Type the Page address and an optional Name.",
          "Under Pages to read, choose This page, Linked pages, or Two levels. Linked pages also reads the same-site pages this page links to; Two levels also reads the pages those pages link to.",
          "For Linked pages or Two levels, set Most pages to read, up to 100.",
          "Under Look for fresh pages on this site when answering, keep On to let a question look up a page that was not read up front, or choose Off to answer only from the pages read now and on Sync now.",
          "Choose Fetch and add pages (Fetch and add page for This page). The site is listed as one item with its page count, and the notice says how many pages were read and how many more links were saved.",
          "Sync now reads it again later. For a page behind a sign-in, tick Paste the text instead of fetching the page (for pages behind a sign-in), paste it, and choose Add text.",
        ],
      },
      {
        label: "Read a file's properties",
        steps: [
          "On Files, choose the arrow beside a file (Show details).",
          "Properties lists what the file carries about itself: title, author, dates, labels, and custom fields such as a matter number, plus its size and who uploaded it.",
          "Who can find it says who can reach the file.",
          "Properties are searchable, so you can ask for a file by its author or matter number.",
        ],
      },
      {
        label: "Choose how scans and pictures are read",
        steps: [
          "Open Settings and find Handwriting and images.",
          "Keep AI reading on so an image-capable model reads handwriting, stamps, signatures, and pictures in scanned pages, images, Word, and PowerPoint files.",
          "Choose Standard OCR only to keep pages on this server. Standard OCR still reads printed scans.",
          "Choose Save changes. The setting applies to files read from then on.",
          "If the note says No image-capable model is set up for this workspace, scanned pages use standard OCR until an administrator adds one.",
        ],
      },
      {
        label: "Connect an API",
        steps: [
          "Connecting an API needs Can add API sources as well. Without it, Connect an API shows a lock, and API says Connecting APIs needs approval.",
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
      "A question with # returns facts from your files and View N citations; Sources gathered names each document the reply cited (for a PDF, with the page).",
      "A website shows its page count under Web pages, with Looks for fresh pages when answering when that is on.",
      "Show details on a file lists its Properties.",
    ],
    troubleshooting: [
      { symptom: "\"You can use the knowledge bases shared with you in chat. Ask an administrator if you need to add your own.\"", fix: "Creating knowledge bases is not granted to your groups. Ask your administrator for Can build knowledge bases." },
      { symptom: "\"Skipped … (save it as .docx first)\" or \"(unsupported type)\" or \"(larger than … MB)\"", fix: "Convert old .doc files to .docx, use a supported type, or split very large files." },
      { symptom: "\"No readable text — only the name is searchable\"", fix: "The file has no text layer (for example a picture-only PDF beyond the OCR limit). Upload a text version." },
      { symptom: "\"Connecting APIs needs approval. Ask your administrator to turn on Can add API sources for one of your groups.\"", fix: "API sources need their own grant, on top of Can build knowledge bases. Ask your administrator. API data already indexed stays searchable." },
      { symptom: "\"Give the knowledge base a name.\"", fix: "Type a Name before choosing Create." },
      { symptom: "\"Enter the page address.\"", fix: "Type the full address, including https://." },
      { symptom: "A site reads fewer pages than you expected, and the notice says \"skipped by robots.txt\" or \"could not be read\"", fix: "Only public pages can be read, and pages the site's robots.txt excludes are skipped. Raise Most pages to read, or paste the text of pages behind a sign-in." },
      { symptom: "\"This file carried no properties beyond its name.\"", fix: "The file holds no title, author, or custom fields. Add them in the program that made it and upload it again." },
      { symptom: "\"No image-capable model is set up for this workspace, so scanned pages use standard OCR, which cannot read handwriting.\"", fix: "Ask an administrator to set up an image-capable model. Until then, upload typed versions of handwritten pages." },
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
        narration: "Give it a name, and choose how to start: upload files, add web pages, or connect an A P I. Connect an A P I shows a lock until your administrator also grants Can add A P I sources. You can mix sources later. It is private to you. Choose Create.",
        durationSeconds: 18,
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
        title: "Read a file's properties",
        caption: "The arrow beside a file shows its Properties and who can find it.",
        narration: "Choose the arrow beside a file to show its details. Properties lists what the file carries about itself: its title, author, dates, and custom fields such as a matter number. They are searchable, so you can ask for a document by who wrote it. Who can find it says who can reach this file.",
        durationSeconds: 19,
        focus: "knowledgeProperties",
      },
      {
        title: "Read a website",
        caption: "Web pages: the address, Pages to read, and Most pages to read.",
        narration: "To add a public site, open Web pages and type its address. Pages to read sets how far to go: This page, Linked pages, which also reads the same-site pages it links to, or Two levels, one step further. Most pages to read caps the total. Sign-in pages are skipped, so paste those in below.",
        durationSeconds: 21,
        focus: "knowledgeWeb",
      },
      {
        title: "Look for fresh pages",
        caption: "Look for fresh pages on this site when answering: On looks up pages not read up front.",
        narration: "Look for fresh pages on this site when answering starts On. When a question needs a page that was not read up front, it is looked up on this site at that moment and cited. Choose Off to answer only from the pages read now and on Sync now.",
        durationSeconds: 16,
        focus: "knowledgeLookup",
      },
      {
        title: "What was read",
        caption: "The notice says how many pages were read and how many links were saved.",
        narration: "Choose Fetch and add pages. The notice says what happened: three pages read, stopped at the limit you set, and two more same-site links saved for later. A good habit is to read the pages people ask about most, and let the lookup handle the rest.",
        durationSeconds: 17,
        focus: "knowledgeWebAdded",
      },
      {
        title: "The site is one item",
        caption: "One item, with its page count. Sync now reads it again.",
        narration: "The site is one item in the list, with its page count, and Looks for fresh pages when answering. Sync now reads it again whenever it changes.",
        durationSeconds: 10,
        focus: "knowledgeWebRow",
      },
      {
        title: "How scans and pictures are read",
        caption: "Settings › Handwriting and images: AI reading on or Standard OCR only.",
        narration: "On Settings, Handwriting and images decides how scanned pages and pictures are read. With an image-capable model, AI reading on reads handwriting, stamps, signatures, and pictures. Standard OCR only keeps pages on your server and still reads printed scans. This practice workspace has no such model, so the note says so.",
        durationSeconds: 23,
        focus: "knowledgeReading",
      },
      {
        title: "Connecting an API needs approval",
        caption: "Without Can add API sources, API says Connecting APIs needs approval.",
        narration: "A P I sources send requests on your behalf, so they need their own permission. Without it, the A P I tab says Connecting A P Is needs approval: ask your administrator to turn on Can add A P I sources for one of your groups.",
        durationSeconds: 16,
        focus: "knowledgeApiLocked",
      },
      {
        title: "Or connect an API",
        caption: "API: address, path, and sign-in method. The response becomes searchable passages.",
        narration: "Once it is granted, open A P I to bring in data from a system with an A P I. Enter its address and path, choose how it signs in, and choose Fetch and add. The response becomes searchable passages. The grey text here only shows examples.",
        durationSeconds: 17,
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
        narration: "The reply answers from your own files. The renewal date and the security contact come from the uploaded P D F, and View citations offers the sources.",
        durationSeconds: 12,
        focus: "knowledgeReply",
      },
      {
        title: "Check the citations",
        caption: "Sources gathered names each document the reply cited, its page, and the passage.",
        narration: "Choose View citations. Sources gathered names each document the reply cited, with the page for a P D F, and the passage. Choose a row to open the document on that page. The lesson Check a source shows that loop in full.",
        durationSeconds: 16,
        focus: "knowledgeSources",
        calloutPlacement: "left-rail",
      },
      {
        title: "A page looked up while answering",
        caption: "No page read so far covers this, so the lookup found one on the site.",
        narration: "Now ask something the pages read so far cannot answer. The returns page was never read up front, so it is looked up for this question, and the answer is cited. Looked up pages are not stored, so each new question looks again.",
        durationSeconds: 16,
        focus: "knowledgeLiveReply",
      },
      {
        title: "The looked up page is cited",
        caption: "Marked Live page, the source links to the page on the site.",
        narration: "Open the citation. The source is marked Live page and names the site. Choose it to read that page in a new browser tab.",
        durationSeconds: 9,
        focus: "knowledgeLiveSource",
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
      "To add your own connection: your administrator grants Can build tools to one of your groups, and you have the MCP server's address. Until then, Add connection is shown locked.",
      "Hermes connections also need Can use Hermes companion on one of your groups. Until then they show Locked.",
    ],
    setupSteps: [
      "Choose Library in the sidebar, then Tools.",
      "Connections lists the MCP connections you can use in Agent mode, with On, Off, Needs setup, or Locked.",
      "Choose Prompts to see the saved prompts shared with you. Choose a prompt's View to read its content.",
      "Choose Skills to see the skill files shared with you.",
      "Use them in chat: type / for prompts and connections, and $ for skill files, or attach them to an agent.",
    ],
    paths: [
      {
        label: "Add a private connection",
        steps: [
          "Without Can build tools, Add connection shows a lock. With it, choose Add connection.",
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
          "Locked, with Needs Hermes approval from your administrator: a Hermes connection your groups cannot use yet.",
        ],
      },
    ],
    verify: [
      "Prompts and Skills list the items shared with you, and View shows each one's content.",
      "Typing / in chat lists the same prompts, and $ lists the same skill files.",
    ],
    troubleshooting: [
      { symptom: "\"Connections are managed by your administrators. These are the ones you can use in Agent mode.\"", fix: "You cannot add connections yet. Ask your administrator for Can build tools if you need one." },
      { symptom: "Add connection is off, with a lock: \"Adding your own MCP connections needs approval. Ask your administrator to turn on Can build tools for one of your groups.\"", fix: "Ask your administrator for Can build tools if you need your own connection." },
      { symptom: "\"Locked\" and \"Needs Hermes approval from your administrator\" on a connection", fix: "Hermes needs approval. Ask your administrator to turn on Can use Hermes companion for one of your groups." },
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
        caption: "MCP connections you can use in Agent mode: On, Off, Needs setup, or Locked until approved.",
        narration: "Connections lists the M C P connections you can use in Agent mode. Each shows its status: On, Off, or Needs setup, and whether it asks before each use. A Hermes connection shows Locked, with Needs Hermes approval from your administrator, until your group is allowed to use Hermes.",
        durationSeconds: 20,
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
        title: "Adding a connection needs approval",
        caption: "Add connection shows a lock until your administrator grants Can build tools.",
        narration: "You can also add your own connection, once your administrator allows it. Until they grant Can build tools to one of your groups, Add connection shows a lock.",
        durationSeconds: 11,
        focus: "toolsAddLocked",
      },
      {
        title: "Add your own connection",
        caption: "With Can build tools: Add connection, a name, HTTP or SSE, and the server address.",
        narration: "Once it is granted, choose Add connection. Name it, choose how it connects, and enter the server's address. It starts turned off: set its sign-in and approval, test it, then turn it on. It stays private to you.",
        durationSeconds: 15,
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
      { symptom: "An agent is listed as \"(agent, needs Hermes approval)\" and cannot be chosen for a step", fix: "That agent uses the Hermes companion. Ask your administrator to turn on Can use Hermes companion for one of your groups, or choose another model or agent." },
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
          "Permanently delete asks first, and Delete forever cannot be undone. Keep leaves the chat archived.",
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
      { symptom: "A chat left its folder after you renamed it", fix: "Renaming a chat currently takes it out of its folder. Choose … › Move to folder and pick the folder again." },
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
      "Select your account card at the bottom of the sidebar. Under Preferences and security, choose Personalization memory.",
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
      "A later chat's reply uses it without being told again, and its work trace says Recalled and a count of memories.",
    ],
    troubleshooting: [
      { symptom: "\"Memories cannot contain credentials, keys, or sensitive identifiers.\"", fix: "Passwords, keys, tokens, one-time codes, and card or account numbers are never stored. Keep them out of memory." },
      { symptom: "\"Write a little more so the memory is useful later.\"", fix: "Write a full phrase of at least a few words." },
      { symptom: "\"Pinned memories already fill your memory limit. Unpin or forget one before saving more.\"", fix: "Unpin or forget a memory, then add the new one." },
      { symptom: "\"That memory kind is disabled by your organization's policy.\"", fix: "Choose another type, or ask your administrator." },
      { symptom: "The row says memory is turned off", fix: "\"Memory is turned off for this platform.\", \"… for your organization.\", or your groups' policy: ask your administrator. \"You turned memory off for your account.\": turn it back on here." },
      { symptom: "No note under the reply says a memory was saved", fix: "The reply does not currently show that note. Check Personalization memory to confirm the memory was saved. To see that saved memories were used, expand the work trace: it says Recalled and a count." },
    ],
    scenes: [
      {
        title: "Open Personalization memory",
        caption: "Account card › Personalization memory: see and edit what the assistant remembers about you.",
        narration: "To see what the assistant remembers, select your account card at the bottom of the sidebar. Under Preferences and security, choose Personalization memory.",
        durationSeconds: 11,
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
        narration: "Open Personalization memory to check: the sentence is now listed. A reply saying it was saved is not proof, because the product shows no note of its own, so this list is where to confirm it.",
        durationSeconds: 14,
        focus: "memorySavedList",
        calloutPlacement: "left-rail",
      },
      {
        title: "Recalled in a new chat",
        caption: "The work trace says Recalled, and the reply uses your memories.",
        narration: "In a new chat, ask something your memories answer. The work trace says it recalled your memories, and the reply knows you review vendors on Mondays and like a one-line answer first, without being told again. Memory follows your account into later chats and sign-ins.",
        durationSeconds: 18,
        focus: "memoryRecall",
      },
    ],
  },
  {
    id: "account-mobile-help",
    audioSrc: "training/user/account-mobile-help.mp3",
    title: "Personalize, use mobile, and get help",
    description: "Find your way around Account: edit your profile, read your usage, manage a personal API key, and review archived chats. Then set light or dark mode, install the app, and find Help.",
    icon: "organize",
    track: "Organize and personalize",
    outcomes: ["Profile saved and usage read", "API key created, rotated, and revoked", "Appearance and theme schedule set", "App installed, and Help found"],
    prerequisites: [
      "For installing: Safari on iPhone or iPad, Chrome on Android, or Chrome or Edge on a computer.",
      "For API access: your platform owner turns on Downstream API access. Administrators then have it; other people also need Can use API on one of their groups. Without it, Account does not list API access.",
    ],
    setupSteps: [
      "Select your account card at the bottom of the sidebar. Account opens with your name, Role, Organization, and Sign-in at the top.",
      "Choose Edit beside your name. Change the fields you need, such as Display name, Phone number, or Firm or organization, and choose Save profile. Profile saved. confirms it.",
      "Under Usage this month, read Requests, Chats, and Tokens. The heading says when they reset.",
      "Choose the moon button beside Help for Dark mode, or the sun for Light mode.",
      "Choose the clock button (Theme schedule), turn on Switch automatically, set Light mode at and Dark mode at to different times, and choose Save schedule.",
      "Choose Help at the bottom of the sidebar. It holds Report a problem, My reports, the walkthroughs, and the printable User guide (PDF).",
      "To send a problem, idea, question, feedback, or security concern and follow the replies, see Report a problem and follow it up.",
    ],
    paths: [
      {
        label: "Create a personal API key",
        steps: [
          "Open Account. Under Preferences and security, expand API access.",
          "Copy the Platform URL: it is the OpenAI-compatible base URL your tool asks for.",
          "Choose Create key, then choose Copy beside New API key at once. For security, the full key is shown only once.",
          "Paste the URL and key into your tool.",
          "Reopen Account: API access shows Active key, the key masked, when it was created, and when it was last used.",
        ],
      },
      {
        label: "Rotate or revoke a key",
        steps: [
          "To replace a key, choose Rotate key. Replace this API key? The current key stops working immediately.",
          "Choose Replace key, copy the new key, and update every tool that used the old one. Keep key changes nothing.",
          "To end access, choose Revoke. Revoke this API key? Any connected coding tools will lose access immediately.",
          "Choose Revoke key. API access offers Create key again.",
        ],
      },
      {
        label: "Archived chats",
        steps: [
          "Under Data, choose View beside Archived chats.",
          "Point at a title to preview the chat.",
          "Restore returns it to your sidebar at once.",
          "Permanently delete asks first: Delete forever removes the full conversation and cannot be undone. Keep leaves it archived.",
        ],
      },
      {
        label: "Administrators and owners: Workspace",
        steps: [
          "Account adds a Workspace section with Admin console, and Platform owner console for owners.",
          "View as previews the workspace with another role. Choose a role on the rail; Account says Previewing, and which role is really yours.",
          "Choose your own role to stop previewing.",
        ],
      },
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
      "Profile saved. appears, and Account shows the new details.",
      "After Create key and reopening Account, API access shows Active key with a masked value. After Revoke key, it offers Create key again.",
      "The workspace switches between light and dark at the scheduled times on this device.",
      "The installed app opens from your home screen or app list.",
      "Help opens with Report a problem and My reports at the top.",
    ],
    troubleshooting: [
      { symptom: "\"Enter a display name.\"", fix: "Display name cannot be empty. Type the name people should see." },
      { symptom: "\"Use a complete http(s) website URL.\"", fix: "Enter the full website address, including https://." },
      { symptom: "\"Unsaved changes. Choose Cancel to discard them.\"", fix: "Escape keeps what you typed. Choose Save profile to keep it, or Cancel to discard it." },
      { symptom: "Account does not list API access", fix: "Ask your administrator. Downstream API access must be on for the platform, and standard users also need Can use API on one of their groups." },
      { symptom: "\"Clipboard access is unavailable. Select and copy the value manually.\"", fix: "Your browser blocked Copy. Select the value in the box and copy it by hand before you close Account." },
      { symptom: "You closed Account before copying a new key", fix: "The full key cannot be shown again. Choose Rotate key to create a new one." },
      { symptom: "\"Usage is unavailable right now.\"", fix: "Close Account and open it again. Your chats are not affected." },
      { symptom: "Tokens says Not reported", fix: "Your model provider did not report token counts. Requests and Chats are still counted." },
      { symptom: "\"Choose a profile photo that is 5 MB or smaller.\"", fix: "Use a smaller image." },
      { symptom: "\"Choose two different times.\"", fix: "Light mode at and Dark mode at must differ." },
      { symptom: "Help shows a dot", fix: "One of your reports has a reply or a new status. Open Help › My reports (see Report a problem and follow it up)." },
    ],
    scenes: [
      {
        title: "Your Account",
        caption: "Your account card opens Account: your profile, Preferences and security, Usage this month, and Data.",
        narration: "Select your account card at the bottom of the sidebar. Account opens beside your work. At the top are your name, your role, your organization, and how you sign in. Below them are Preferences and security, Usage this month, and Data.",
        durationSeconds: 16,
        focus: "accountOverview",
        calloutPlacement: "left-rail",
      },
      {
        title: "Edit your profile",
        caption: "Edit opens the form in place: change the details, then Save profile.",
        narration: "Choose Edit beside your name, and the form opens in place. Change your display name, phone number, or organization, which are the details your teammates see, and choose Save profile. Cancel leaves everything as it was.",
        durationSeconds: 16,
        focus: "profileEditor",
        calloutPlacement: "left-rail",
      },
      {
        title: "Profile saved",
        caption: "Profile saved. confirms the change, and Account shows the new details.",
        narration: "Profile saved confirms the change, and Account shows the new details under your role and organization.",
        durationSeconds: 8,
        focus: "profileSaved",
        calloutPlacement: "left-rail",
      },
      {
        title: "Usage this month",
        caption: "Requests, Chats, and Tokens are your own, and the heading says when they reset.",
        narration: "Usage this month counts your own Requests, Chats, and Tokens, and the heading says when they reset. Every model request counts, including automatic chat titles, so Requests runs ahead of Chats. If your administrator sets a limit, a meter appears here too.",
        durationSeconds: 18,
        focus: "accountUsage",
        calloutPlacement: "left-rail",
      },
      {
        title: "API access",
        caption: "API access gives a tool the Platform URL and a personal key. Create key makes one.",
        narration: "If your organization allows it, A P I access lets a coding tool use this workspace with your approved models. Expand it, copy the Platform U R L, and choose Create key.",
        durationSeconds: 13,
        focus: "apiAccessCreate",
        calloutPlacement: "left-rail",
      },
      {
        title: "A key is shown only once",
        caption: "Copy the new key straight away. Reopened, API access shows Active key, masked.",
        narration: "The new key appears only once, so choose Copy and paste it into your tool straight away. It is hidden from this video, and you should keep it out of screenshots too. Reopen Account, and A P I access shows your active key, masked, with when it was created and last used.",
        durationSeconds: 18,
        focus: "apiAccessActive",
        calloutPlacement: "left-rail",
      },
      {
        title: "Rotate a key",
        caption: "Rotate key asks first. Replace key stops the old key immediately; Keep key changes nothing.",
        narration: "To replace a key, choose Rotate key. Account asks first, because the current key stops working immediately. Choose Replace key, or Keep key to change nothing. You have one personal key, so update every tool that uses it.",
        durationSeconds: 16,
        focus: "apiAccessRotate",
        calloutPlacement: "left-rail",
      },
      {
        title: "Revoke a key",
        caption: "Revoke asks first: connected tools lose access immediately.",
        narration: "If a key may have leaked, or you have finished with it, choose Revoke. Connected tools lose access immediately. Choose Revoke key to confirm, or Keep key to change nothing.",
        durationSeconds: 12,
        focus: "apiAccessRevoke",
        calloutPlacement: "left-rail",
      },
      {
        title: "The key is gone",
        caption: "The key stops working at once, and API access offers Create key again.",
        narration: "The key stops working at once, so any tool still using it gets an error. A P I access offers Create key again.",
        durationSeconds: 9,
        focus: "apiAccessRevoked",
        calloutPlacement: "left-rail",
      },
      {
        title: "Archived chats",
        caption: "Data › Archived chats › View lists what you archived, with Restore and Permanently delete.",
        narration: "Under Data, choose View beside Archived chats. Each chat you archived has two buttons: Restore returns it to your sidebar, and the bin deletes it. Point at a title to preview it first.",
        durationSeconds: 13,
        focus: "accountArchived",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "Delete forever asks first",
        caption: "Delete forever cannot be undone. Keep leaves the chat archived.",
        narration: "The bin asks first, because it removes the full conversation and cannot be undone. Choose Delete forever, or Keep to leave the chat archived.",
        durationSeconds: 11,
        focus: "accountArchivedDelete",
        calloutPlacement: "left-rail",
      },
      {
        title: "If you are an administrator",
        caption: "Administrators also see Workspace: the Admin console and View as.",
        narration: "If you are an administrator, Account also shows Workspace. It links to the Admin console, and View as previews the workspace with another role, so you can check what a person really sees. Choose your own role to stop previewing.",
        durationSeconds: 16,
        focus: "accountWorkspace",
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
        narration: "On a phone, the sidebar folds away. Choose Open menu at the top left, and this panel opens: navigation, your chats, Help, Install app, and your account.",
        durationSeconds: 12,
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
        caption: "Help: Report a problem, My reports, the walkthroughs, and the printable User guide (PDF).",
        narration: "Choose Help at the bottom of the sidebar. At the top, Report a problem sends a problem, idea, question, feedback, or security concern to your administrators, and My reports follows their replies. The next lesson, Report a problem and follow it up, walks through both. Below them are these walkthroughs, grouped by topic, and the printable user guide as a P D F.",
        durationSeconds: 24,
        focus: "helpLibrary",
        calloutPlacement: "left-rail",
      },
    ],
  },
  {
    id: "report-and-follow-up",
    audioSrc: "training/user/report-and-follow-up.mp3",
    title: "Report a problem and follow it up",
    description: "Send a problem, idea, question, feedback, or security concern to your administrators, then follow its status, answer replies, and reopen it in My reports.",
    icon: "session",
    track: "Organize and personalize",
    outcomes: ["Report sent with a screenshot and technical details", "Status and replies followed in My reports", "Reply sent to your administrators", "Resolved report found under Closed and reopened"],
    prerequisites: [
      "Any signed-in account. No permission is needed to report.",
      "What you were doing, what you expected, and what happened. For a problem, the steps that make it happen again.",
      "Optionally, a screenshot (PNG, JPEG, GIF, or WebP, up to 10 MB) with no passwords or personal data.",
      "Your administrators answer reports in their Admin console › Reports.",
    ],
    setupSteps: [
      "Choose Help at the bottom of the sidebar, then Report a problem.",
      "Under What would you like to send?, choose Problem.",
      "Under How much is this affecting you?, choose Blocking me, Slows me down, or Minor.",
      "Type a short Subject. In Message, describe what you did, what you expected, and what happened.",
      "Optionally add a screenshot: Choose image, Capture screen, or paste or drop an image into the form.",
      "Leave Include technical details ticked to send the page, browser, and recent errors (What's included lists them). No chat content is attached.",
      "Choose Send report and wait for Report #… sent.",
      "Choose View status. My reports opens the report with its tracker at Received.",
      "When Help shows a dot, choose Help › My reports and open the report to read the reply from Support team.",
      "To answer, type in Add a reply and choose Send reply.",
      "When it is resolved, find it under Closed in My reports.",
    ],
    paths: [
      {
        label: "Idea, Question, or Feedback",
        steps: [
          "Help › Report a problem, then choose Idea, Question, or Feedback.",
          "The form skips How much is this affecting you? and changes its prompts: Idea asks what you'd like to do and the problem it would solve; Question asks anything about how the platform works; Feedback asks what's working well or could be better.",
          "Fill in Subject and Message and choose Send report. Follow it in My reports like a problem.",
        ],
      },
      {
        label: "Security",
        steps: [
          "Help › Report a problem, then choose Security.",
          "Read the notice: Security concerns go only to your administrators and are never posted publicly.",
          "Describe what you noticed and where. Do not include passwords, keys, or personal data.",
          "Choose Send report. My reports lists it as a Security concern.",
        ],
      },
      {
        label: "With a screenshot",
        steps: [
          "Choose image picks a file from your device. You can also paste an image, or drop one onto the Screenshot area.",
          "Capture screen asks your browser to share the screen; choose this tab. The report panel hides itself for the picture, so the screenshot shows the page behind it.",
          "Check the thumbnail for passwords or personal data. Remove screenshot (×) takes it off.",
          "PNG, JPEG, GIF, or WebP images up to 10 MB are accepted.",
        ],
      },
      {
        label: "Reopen a resolved report",
        steps: [
          "Help › My reports › Closed, then open the report.",
          "Under Still having this problem?, optionally say what is still happening.",
          "Choose Reopen report. It moves back to Open at Received, and your administrators see that you reopened it.",
        ],
      },
    ],
    verify: [
      "Report #… sent appeared after Send report.",
      "Help › My reports lists the report with its type, when it was last updated, and its status.",
      "The report's tracker and conversation show each status change and every reply.",
      "After Reopen report, the report is listed under Open again, at Received.",
    ],
    troubleshooting: [
      { symptom: "\"Add both a subject and a message.\"", fix: "Fill in Subject and Message, then choose Send report." },
      { symptom: "\"Choose a PNG, JPEG, GIF, or WebP image.\" or \"Choose a screenshot that is 10 MB or smaller.\"", fix: "Attach a smaller image in one of those formats, or send the report without a screenshot." },
      { symptom: "\"This browser can't capture the screen.\"", fix: "Take a screenshot with your device's own tool, then use Choose image, or paste it into the form." },
      { symptom: "\"The issue report could not be sent.\"", fix: "The report was not received. Check your connection and choose Send report again. The form keeps what you typed in this browser tab." },
      { symptom: "\"You're sending these very quickly. Wait a moment and try again.\"", fix: "You can send up to four reports and ten replies a minute. Wait a minute, then send again." },
      { symptom: "\"This report is closed. Reopen it to add more detail.\"", fix: "It was resolved or closed while you were writing. Go back to My reports, open it, and choose Reopen report." },
      { symptom: "\"Your reports could not be loaded.\"", fix: "Check your connection, then open Help › My reports again." },
      { symptom: "No dot on Help after a reply", fix: "The workspace checks for news when the page loads and whenever you open Help or close a panel. Open Help › My reports to check." },
    ],
    scenes: [
      {
        title: "Before you begin",
        caption: "Know what happened, what you expected, and the steps. A screenshot is optional.",
        narration: "This walkthrough sends a report to your administrators and follows it until it is resolved. Before you start, know what you were doing, what you expected, and what happened instead. For a problem, the steps that make it happen again help most. A screenshot is optional; keep passwords and personal data out of it.",
        durationSeconds: 20,
        card: {
          label: "Checklist",
          where: "Have these ready",
          steps: [
            "What you were doing, what you expected, and what happened.",
            "For a problem: the steps that make it happen again.",
            "Optionally, a screenshot with no passwords or personal data.",
          ],
        },
      },
      {
        title: "Open Help",
        caption: "Help: Report a problem sends something new; My reports follows what you sent.",
        narration: "Choose Help at the bottom of the sidebar. At the top are two rows. Report a problem sends something new to your administrators. My reports follows the reports you have already sent.",
        durationSeconds: 13,
        focus: "reportHelpRows",
        calloutPlacement: "left-rail",
      },
      {
        title: "What are you sending?",
        caption: "Choose Problem, Idea, Question, Feedback, or Security. A problem also asks how much it affects you.",
        narration: "Choose Report a problem. Under What would you like to send?, choose Problem, Idea, Question, Feedback, or Security. A problem also asks: How much is this affecting you? Choose Blocking me, Slows me down, or Minor. Here, Slows me down.",
        durationSeconds: 17,
        focus: "reportKind",
        calloutPlacement: "left-rail",
      },
      {
        title: "Describe it",
        caption: "A short Subject, then what you did, what you expected, and what happened.",
        narration: "Give it a short subject. In Message, say what you did, what you expected, and what actually happened. Steps that make it happen again help most.",
        durationSeconds: 10,
        focus: "reportFields",
        calloutPlacement: "left-rail",
      },
      {
        title: "Add a screenshot and details",
        caption: "Choose image, Capture screen, or paste one. Include technical details adds the page and recent errors.",
        narration: "Under Screenshot, choose Choose image, or paste or drop a picture. Capture screen asks your browser to share this tab, and attaches a picture of the page behind the report panel. Include technical details is ticked: What's included lists the page, your browser and screen, and any recent errors or failed requests. No chat content is ever attached.",
        durationSeconds: 24,
        focus: "reportScreenshot",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "Send report",
        caption: "Report #2 sent confirms your administrators can see it. View status follows it.",
        narration: "Choose Send report. Report sent, with its number, confirms that it arrived: your administrators can see it now. Choose View status to follow it.",
        durationSeconds: 11,
        focus: "reportSent",
        calloutPlacement: "left-rail",
      },
      {
        title: "Follow its status",
        caption: "The tracker shows Received, In review, In progress, and Resolved. Your report sits below.",
        narration: "My reports opens on your report. The tracker shows where it stands: Received, In review, In progress, and Resolved. Your message and screenshot sit below, and every reply will appear under them.",
        durationSeconds: 14,
        focus: "reportTracker",
        calloutPlacement: "left-rail",
      },
      {
        title: "Your administrator's part",
        caption: "In Admin console › Reports, your administrator updates the status and replies.",
        narration: "The next steps happen on your administrator's screen, in the Admin console under Reports. They open your report, change its status, for example to In review, and reply to you. They can also add internal notes, which you never see.",
        durationSeconds: 16,
        card: {
          label: "Your administrator's part",
          where: "Admin console › Reports",
          steps: [
            "Your administrator opens your report.",
            "They change its Status, for example to In review.",
            "They reply to you, or add an internal note you never see.",
            "When it is fixed, they mark it Resolved.",
          ],
        },
      },
      {
        title: "A dot on Help means news",
        caption: "When someone replies or changes the status, a dot appears on Help.",
        narration: "When your administrator replies or changes the status, a dot appears on Help. The workspace checks when the page loads, and whenever you open Help or close a panel.",
        durationSeconds: 12,
        focus: "reportHelpDot",
        calloutPlacement: "right-mid",
      },
      {
        title: "Open My reports",
        caption: "My reports shows how many reports have news. Choose it, then the report.",
        narration: "Open Help. My reports shows how many of your reports have news. Choose it, then choose the report.",
        durationSeconds: 8,
        focus: "reportUnread",
        calloutPlacement: "left-rail",
      },
      {
        title: "Read the reply and answer",
        caption: "Support team replied and the tracker moved to In review. Add a reply, then Send reply.",
        narration: "The reply appears under your report, from Support team, and the tracker has moved to In review. To answer, type in Add a reply and choose Send reply. Replies go to your administrators.",
        durationSeconds: 14,
        focus: "reportReply",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "Your reply is sent",
        caption: "Your reply joins the conversation, marked You.",
        narration: "Your reply joins the conversation, marked You. While the report is open, you can keep adding detail here.",
        durationSeconds: 8,
        focus: "reportReplied",
        calloutPlacement: "left-rail",
      },
      {
        title: "Resolved reports move to Closed",
        caption: "A resolved report leaves Open. Choose Closed to find it, marked Resolved.",
        narration: "When your administrator marks the report resolved, it leaves Open. In My reports, choose Closed to find it, marked Resolved.",
        durationSeconds: 10,
        focus: "reportClosed",
        calloutPlacement: "left-rail",
      },
      {
        title: "Still having this problem?",
        caption: "Read the final reply. If it is back, say what still happens and choose Reopen report.",
        narration: "Open it to read the final reply. If the problem comes back, type what is still happening under Still having this problem?, and choose Reopen report. The text is optional.",
        durationSeconds: 12,
        focus: "reportReopen",
        calloutPlacement: "left-rail",
        captionPlacement: "top",
      },
      {
        title: "Reopened",
        caption: "The report is open again at Received, and your administrators see that you reopened it.",
        narration: "The report is open again, back at Received, and your administrators see that you reopened it, with your note. Follow it in My reports as before.",
        durationSeconds: 10,
        focus: "reportReopened",
        calloutPlacement: "left-rail",
      },
      {
        title: "Ideas, questions, and feedback",
        caption: "Idea, Question, and Feedback skip the impact question and change the prompts.",
        narration: "Not a problem? Choose Idea, Question, or Feedback. The form skips the impact question, and its prompts change to match. An idea asks what you would like to do, and the problem it would solve. Send it the same way.",
        durationSeconds: 15,
        focus: "reportIdea",
        calloutPlacement: "left-rail",
      },
      {
        title: "Security concerns stay private",
        caption: "Security concerns go only to your administrators and are never posted publicly.",
        narration: "For something that looks unsafe, such as a suspicious email or unexpected access, choose Security. Security concerns go only to your administrators and are never posted publicly. Leave out passwords, keys, and personal data.",
        durationSeconds: 17,
        focus: "reportSecurity",
        calloutPlacement: "left-rail",
      },
      {
        title: "Check it worked",
        caption: "My reports › All lists every report with its type, last update, and status.",
        narration: "To check, open My reports and choose All. Every report you sent is listed with its type, when it was last updated, and its status. Here, the reopened problem, the idea, and the security concern are all Received.",
        durationSeconds: 15,
        focus: "reportAll",
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
