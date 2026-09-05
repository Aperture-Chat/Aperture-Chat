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
  MessageSquare,
  Mic,
  Paperclip,
  Presentation,
  Send,
  Wrench,
} from "lucide-react";
import { TrainingGuidePlaylist, type TrainingDeck } from "../TrainingVideoLibrary";
import type { FocusRegion, TrainingVideoBase } from "../trainingVideoKit";

/* Frames are real captures of the current user workspace, taken as a standard
 * user (apps/web/scripts/capture-training-frames.cjs and
 * apps/web/scripts/capture-deck-frames.cjs document the pipeline). */

type UserFocus =
  | "homeComposer"
  | "modelSelector"
  | "toolsChip"
  | "sendButtonsHome"
  | "micButton"
  | "traceCollapsed"
  | "traceExpanded"
  | "responseActions"
  | "transferDraft"
  | "slashMenu"
  | "agentMenu"
  | "composerField"
  | "attachButton"
  | "attachUpload"
  | "attachWebLink"
  | "attachConnectors"
  | "sendOptionsButton"
  | "sendKnowledge"
  | "sendWeb"
  | "sendAgent"
  | "sendReasoning"
  | "sessionSummary"
  | "contextWindow"
  | "imageReply"
  | "imageDownload"
  | "mermaidFigure"
  | "searchPalette"
  | "draftModeToggle"
  | "draftComposer"
  | "draftModel"
  | "draftToolbar"
  | "draftVersions"
  | "deckModeToggle"
  | "deckFilmstrip"
  | "deckLayoutMenu"
  | "deckTemplatesDrawer"
  | "deckBrandStage"
  | "deckAiEdit"
  | "deckAiImage"
  | "deckStageWithBg"
  | "deckNotes"
  | "deckPresent"
  | "deckExportMenu"
  | "agentsProfile"
  | "agentsNew"
  | "knowledgeAdd"
  | "knowledgeTable"
  | "toolsHeader"
  | "toolsRows"
  | "automationsTabs"
  | "automationsNew"
  | "automationsBanner"
  | "automationsCard"
  | "sidebarFolders"
  | "sidebarPinned"
  | "sidebarPreview"
  | "sidebarRowActions"
  | "sidebarUtilities"
  | "memoryAccountEntry"
  | "memorySettings"
  | "memoryAddAndReview"
  | "memoryRecall"
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
  | "helpReportReceived";

export const USER_FOCUS_REGIONS: Record<UserFocus, FocusRegion> = {
  homeComposer: { frame: "training/user/chat-home.png", rect: { x: 292, y: 291, w: 827, h: 199 } },
  modelSelector: { frame: "training/user/chat-home.png", rect: { x: 867, y: 10, w: 249, h: 45 } },
  toolsChip: { frame: "training/user/chat-home.png", rect: { x: 387, y: 431, w: 137, h: 39 } },
  sendButtonsHome: { frame: "training/user/chat-home.png", rect: { x: 1021, y: 430, w: 79, h: 41 } },
  micButton: { frame: "training/user/chat-home.png", rect: { x: 948, y: 431, w: 39, h: 39 } },
  // chat-thread.png shows a scrolled, completed answer with no trace bar, so
  // the collapsed-trace scene targets the summary header row of the Work trace
  // card instead; sharing the frame with traceExpanded also glides the
  // highlight from the header into the full step list.
  traceCollapsed: { frame: "training/user/chat-trace-expanded.png", rect: { x: 328, y: 269, w: 492, h: 31 } },
  traceExpanded: { frame: "training/user/chat-trace-expanded.png", rect: { x: 315, y: 256, w: 518, h: 231 } },
  responseActions: { frame: "training/user/chat-response-actions.png", rect: { x: 315, y: 504, w: 686, h: 35 } },
  transferDraft: { frame: "training/user/chat-response-actions.png", rect: { x: 1006, y: 499, w: 148, h: 42 } },
  slashMenu: { frame: "training/user/composer-slash.png", rect: { x: 258, y: 497, w: 574, h: 137 } },
  agentMenu: { frame: "training/user/composer-agent.png", rect: { x: 258, y: 549, w: 574, h: 85 } },
  composerField: { frame: "training/user/composer-slash.png", rect: { x: 257, y: 635, w: 576, h: 198 } },
  attachButton: { frame: "training/user/composer-attach.png", rect: { x: 314, y: 775, w: 38, h: 38 } },
  attachUpload: { frame: "training/user/composer-attach.png", rect: { x: 320, y: 496, w: 246, h: 45 } },
  attachWebLink: { frame: "training/user/composer-attach.png", rect: { x: 320, y: 535, w: 246, h: 45 } },
  attachConnectors: { frame: "training/user/composer-attach.png", rect: { x: 320, y: 585, w: 246, h: 182 } },
  sendOptionsButton: { frame: "training/user/composer-send-options.png", rect: { x: 774, y: 744, w: 40, h: 41 } },
  sendKnowledge: { frame: "training/user/composer-send-options.png", rect: { x: 556, y: 500, w: 252, h: 45 } },
  sendWeb: { frame: "training/user/composer-send-options.png", rect: { x: 556, y: 539, w: 252, h: 46 } },
  sendAgent: { frame: "training/user/composer-send-options.png", rect: { x: 556, y: 579, w: 252, h: 45 } },
  sendReasoning: { frame: "training/user/composer-send-options.png", rect: { x: 556, y: 667, w: 252, h: 43 } },
  sessionSummary: { frame: "training/user/chat-session-panel.png", rect: { x: 881, y: 69, w: 289, h: 325 } },
  contextWindow: { frame: "training/user/chat-session-panel.png", rect: { x: 881, y: 400, w: 289, h: 236 } },
  imageReply: { frame: "training/user/chat-images.png", rect: { x: 316, y: 342, w: 516, h: 513 } },
  imageDownload: { frame: "training/user/chat-images-download.png", rect: { x: 715, y: 476, w: 106, h: 34 } },
  mermaidFigure: { frame: "training/user/chat-mermaid.png", rect: { x: 315, y: 302, w: 518, h: 231 } },
  searchPalette: { frame: "training/user/search-palette.png", rect: { x: 279, y: 99, w: 627, h: 224 } },
  draftModeToggle: { frame: "training/user/drafts.png", rect: { x: 481, y: 13, w: 200, h: 40 } },
  draftComposer: { frame: "training/user/drafts.png", rect: { x: 91, y: 686, w: 349, h: 150 } },
  draftModel: { frame: "training/user/drafts.png", rect: { x: 481, y: 61, w: 252, h: 48 } },
  draftToolbar: { frame: "training/user/drafts.png", rect: { x: 453, y: 168, w: 732, h: 162 } },
  draftVersions: { frame: "training/user/drafts.png", rect: { x: 481, y: 21, w: 679, h: 138 } },
  deckModeToggle: { frame: "training/user/deck-editor.png", rect: { x: 481, y: 13, w: 200, h: 40 } },
  deckFilmstrip: { frame: "training/user/deck-editor.png", rect: { x: 453, y: 288, w: 174, h: 567 } },
  deckLayoutMenu: { frame: "training/user/deck-layouts.png", rect: { x: 773, y: 450, w: 370, h: 181 } },
  deckTemplatesDrawer: { frame: "training/user/deck-templates.png", rect: { x: 98, y: 230, w: 335, h: 439 } },
  deckBrandStage: { frame: "training/user/deck-editor-brand.png", rect: { x: 656, y: 370, w: 497, h: 282 } },
  deckAiEdit: { frame: "training/user/deck-ai-edit.png", rect: { x: 705, y: 250, w: 387, h: 343 } },
  deckAiImage: { frame: "training/user/deck-ai-image.png", rect: { x: 741, y: 250, w: 387, h: 229 } },
  deckStageWithBg: { frame: "training/user/deck-ai-applied.png", rect: { x: 656, y: 370, w: 497, h: 282 } },
  deckNotes: { frame: "training/user/deck-notes.png", rect: { x: 656, y: 718, w: 497, h: 118 } },
  deckPresent: { frame: "training/user/deck-present.png", rect: { x: 0, y: 681, w: 1185, h: 174 } },
  deckExportMenu: { frame: "training/user/deck-export.png", rect: { x: 773, y: 163, w: 387, h: 197 } },
  agentsProfile: { frame: "training/user/agents.png", rect: { x: 281, y: 292, w: 849, h: 63 } },
  agentsNew: { frame: "training/user/agents.png", rect: { x: 1025, y: 61, w: 126, h: 45 } },
  knowledgeAdd: { frame: "training/user/knowledge.png", rect: { x: 909, y: 187, w: 173, h: 45 } },
  knowledgeTable: { frame: "training/user/knowledge.png", rect: { x: 281, y: 270, w: 838, h: 106 } },
  toolsHeader: { frame: "training/user/tools.png", rect: { x: 261, y: 163, w: 889, h: 94 } },
  toolsRows: { frame: "training/user/tools.png", rect: { x: 281, y: 395, w: 838, h: 59 } },
  automationsTabs: { frame: "training/user/automations.png", rect: { x: 763, y: 33, w: 215, h: 48 } },
  automationsNew: { frame: "training/user/automations.png", rect: { x: 987, y: 33, w: 164, h: 44 } },
  automationsBanner: { frame: "training/user/automations.png", rect: { x: 260, y: 184, w: 891, h: 61 } },
  automationsCard: { frame: "training/user/automations.png", rect: { x: 260, y: 282, w: 891, h: 166 } },
  sidebarFolders: { frame: "training/user/sidebar-chats.png", rect: { x: 31, y: 322, w: 172, h: 106 } },
  sidebarPinned: { frame: "training/user/sidebar-chats.png", rect: { x: 31, y: 421, w: 172, h: 88 } },
  sidebarPreview: { frame: "training/user/sidebar-chat-preview.png", rect: { x: 235, y: 296, w: 486, h: 551 } },
  sidebarRowActions: { frame: "training/user/sidebar-chats.png", rect: { x: 119, y: 545, w: 78, h: 35 } },
  sidebarUtilities: { frame: "training/user/sidebar-chats.png", rect: { x: 9, y: 646, w: 207, h: 190 } },
  memoryAccountEntry: { frame: "training/user/memory-account.png", rect: { x: 777, y: 192, w: 382, h: 65 } },
  memorySettings: { frame: "training/user/memory-manager.png", rect: { x: 280, y: 236, w: 625, h: 99 } },
  memoryAddAndReview: { frame: "training/user/memory-manager.png", rect: { x: 280, y: 342, w: 625, h: 289 } },
  memoryRecall: { frame: "training/user/memory-recall.png", rect: { x: 315, y: 250, w: 839, h: 110 } },
  accessRequestForm: { frame: "training/user/access-request-form.png", rect: { x: 104.25, y: 388.421875, w: 398, h: 291.1875 } },
  accessRequestReceived: { frame: "training/user/access-request-received.png", rect: { x: 104.25, y: 331.015625, w: 398, h: 406.015625 } },
  accessSignInMethod: { frame: "training/user/access-sign-in-method.png", rect: { x: 59, y: 99, w: 488, h: 657 } },
  accessOwnPassword: { frame: "training/user/access-own-password.png", rect: { x: 348.5, y: 168.578125, w: 488, h: 517.84375 } },
  accessWelcome: { frame: "training/user/access-welcome.png", rect: { x: 261.546875, y: 24, w: 887.90625, h: 250.78125 } },
  securityOverview: { frame: "training/user/account-security-overview.png", rect: { x: 793, y: 326, w: 350, h: 111 } },
  securityStart: { frame: "training/user/account-authenticator-start.png", rect: { x: 793, y: 326, w: 350, h: 243.59375 } },
  securityVerify: { frame: "training/user/account-authenticator-verify.png", rect: { x: 793, y: 741.578125, w: 350, h: 100 } },
  securityRecovery: { frame: "training/user/account-recovery-save.png", rect: { x: 793, y: 309.375, w: 350, h: 532.1875 } },
  securityReplace: { frame: "training/user/account-recovery-replace.png", rect: { x: 793, y: 172, w: 350, h: 328.59375 } },
  securityPassword: { frame: "training/user/account-password-form.png", rect: { x: 780, y: 338, w: 376, h: 307 } },
  profileEditor: { frame: "training/user/account-profile-form.png", rect: { x: 780, y: 181, w: 376, h: 661 } },
  appearanceControl: { frame: "training/user/appearance-control.png", rect: { x: 12, y: 649, w: 201, h: 184 } },
  composerShortcuts: { frame: "training/user/composer-shortcuts-help.png", rect: { x: 297, y: 111, w: 818, h: 174 } },
  mobileNavigation: { frame: "training/user/mobile-navigation.png", rect: { x: 394.958531, y: 0, w: 303.909953, h: 855 }, fit: "contain" },
  mobileInstall: { frame: "training/user/mobile-install-ios.png", rect: { x: 415.219194, y: 245.154028, w: 354.561611, h: 363.67891 }, fit: "contain" },
  helpLibrary: { frame: "training/user/help-library.png", rect: { x: 763, y: 12, w: 410, h: 831 } },
  helpReportForm: { frame: "training/user/help-report-form.png", rect: { x: 780, y: 152, w: 376, h: 500 } },
  helpReportReceived: { frame: "training/user/help-report-received.png", rect: { x: 780, y: 152, w: 376, h: 140 } },
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
  | "memory";

export type UserTrainingVideo = TrainingVideoBase & { icon: UserGuideIcon };

export const USER_TRAINING_VIDEOS: UserTrainingVideo[] = [
  {
    id: "access-and-sign-in",
    audioSrc: "training/user/access-and-sign-in.mp3",
    title: "Request access and enter your workspace",
    description: "Understand administrator approval, the sign-in handoff, and choosing your own password.",
    icon: "chat",
    outcomes: ["Access request understood", "Sign-in method confirmed", "First workspace opened"],
    setupSteps: [
      "Open your organization's workspace address and choose Request access when you need an account.",
      "Enter your name and work email, submit the request, and contact your administrator for approval and sign-in instructions. The form does not send an email or create a password.",
      "Return to sign-in and use the method your administrator arranged. When both are offered, explicitly select Organization SSO or Email & password.",
      "If you received a temporary password, complete the required verification and choose your own password of at least 12 characters when prompted.",
      "Review the welcome card, open the quick-start guide, and ask your administrator for model access if no model is available.",
    ],
    scenes: [
      {
        title: "Ask to join",
        caption: "Request access asks for your first name, last name, and work email.",
        narration: "Open the workspace address your organization gave you. Choose Request access, enter your first name, last name, and work email, then submit the form. Your administrator reviews access requests before you can enter the workspace.",
        durationSeconds: 16,
        focus: "accessRequestForm",
      },
      {
        title: "Wait for the administrator's handoff",
        caption: "Request received confirms the submitted email. Contact your administrator for approval and sign-in instructions.",
        narration: "Request received shows the email you submitted and explains the next steps. If that email is new to this workspace, the request awaits review. This form does not send an email or set a password. Your administrator must arrange your sign-in method after approval.",
        durationSeconds: 18,
        focus: "accessRequestReceived",
      },
      {
        title: "Choose the sign-in method you were given",
        caption: "When both methods are offered, select Organization SSO or Email & password before continuing.",
        narration: "Return to sign-in with the instructions from your administrator. When both methods are offered, choose Organization SSO or Email and password. Enter submits the selected method. Use Trouble signing in for guidance: your administrator handles local account access, while organization sign-in recovery goes through your identity provider.",
        durationSeconds: 24,
        focus: "accessSignInMethod",
      },
      {
        title: "Replace a temporary password",
        caption: "Set a new password requires at least 12 characters and a matching confirmation.",
        narration: "If your administrator gave you a temporary password, complete any required verification and follow Set a new password when it appears. Choose a password with at least twelve characters, enter it again, then select Set password and continue. After a successful change, the workspace continues with your new sign-in session.",
        durationSeconds: 21,
        focus: "accessOwnPassword",
      },
      {
        title: "Start with the welcome card",
        caption: "Open quick-start guide introduces the workspace. If model access is next, contact your administrator.",
        narration: "The welcome card confirms that you are signed in and explains your next step. Open the quick-start guide or choose to explore on your own. If no model is available, ask your administrator to enable one for your account. You can still open Drafts to edit or import a document; AI actions require an available model.",
        durationSeconds: 21,
        focus: "accessWelcome",
      },
    ],
  },
  {
    id: "chat-basics",
    audioSrc: "training/user/chat-basics.mp3",
    title: "Start chatting",
    setupSteps: [
      "Sign in using Organization SSO or Email & password, whichever your administrator arranged. Enter submits the selected method.",
      "If you need an account, choose Request access. Approval and sign-in setup are handled by your administrator; the form does not send an email or create a password.",
      "Complete a temporary password change and any authenticator verification before entering the workspace.",
      "On your first visit, the Getting started card shows account and model readiness. Open quick-start guide for help, or explicitly choose I'll explore on my own to dismiss it.",
      "Select an available model and send a short first message. Ask your administrator about group or model access if no model is available.",
      "Explore an idea, Compare options, and Draft a message put an editable starter in the composer. Review it and send when ready; selecting a starter does not send a message.",
      "The Composer shortcuts information button opens shortcut help. It does not change your message.",
      "Use Tab and Shift+Tab to move through controls. Close dialogs with their Close or Cancel control, or Escape when available, to return to your previous control.",
    ],
    description: "Send your first message, pick a model, and control the active tools.",
    icon: "chat",
    outcomes: ["First message sent", "Model chosen", "Tool chip understood"],
    scenes: [
      {
        title: "Ask anything",
        caption: "The home screen greets you by time of day; type in the composer and press Enter to send.",
        narration:
          "The home screen greets you by the time of day, and every conversation starts in the composer. Type your question and press Enter to send it — Shift and Enter adds a new line.",
        durationSeconds: 12,
        focus: "homeComposer",
      },
      {
        title: "Pick a model",
        caption: "The model selector in the top bar routes this chat; each chat remembers its own model.",
        narration:
          "The model selector in the top bar controls which model answers this chat. Each chat keeps its own choice, and only models your workspace has approved appear in the list.",
        durationSeconds: 12,
        focus: "modelSelector",
      },
      {
        title: "One chip for active tools",
        caption: "The chip names a single active tool — like Web search — or shows Tools with a count; × clears them.",
        narration:
          "This chip shows what will run with your next message: a single tool by name, like Web search, or Tools with a count when more are on. Click the X to turn off Knowledge, Web, and Agent for the next message.",
        durationSeconds: 14,
        focus: "toolsChip",
      },
      {
        title: "Send, or open send options",
        caption: "The paper plane sends now; the chevron beside it opens the send options menu.",
        narration:
          "The paper plane sends your message with the current settings. The chevron next to it opens the send options menu, where Knowledge, Web, and Agent can be switched per reply.",
        durationSeconds: 12,
        focus: "sendButtonsHome",
      },
    ],
  },
  {
    id: "work-traces",
    audioSrc: "training/user/work-traces.mp3",
    title: "Follow the work trace",
    description: "Watch the current step while a reply runs, then act on the result.",
    icon: "trace",
    outcomes: ["Trace expanded", "Response actions used"],
    scenes: [
      {
        title: "One line while it works",
        caption: "A running reply shows a collapsed trace with just the current step and a live timer.",
        narration:
          "While the platform works, the trace stays collapsed to a single line showing the current step. When the reply lands, the same line becomes a summary of how many steps ran.",
        durationSeconds: 12,
        focus: "traceCollapsed",
      },
      {
        title: "Expand for the full trace",
        caption: "Click the trace header to see every step: routing, context, web search, and finalizing.",
        narration:
          "Click the trace header any time — during or after a reply — to expand every step: which model was routed, what context was prepared, whether web search ran, and how the answer was finalized.",
        durationSeconds: 14,
        focus: "traceExpanded",
      },
      {
        title: "Act on a response",
        caption: "Copy the reply, branch it into a new chat, regenerate it, or edit and reload your own message.",
        narration:
          "Every reply ends with actions: copy the response text, branch it into a new chat, or regenerate it. Your own message has actions too — edit it, or load the prompt in a fresh chat.",
        durationSeconds: 14,
        focus: "responseActions",
      },
      {
        title: "Transfer to Drafts",
        caption: "Transfer response to Drafts turns the reply into an editable document.",
        narration:
          "Transfer response to Drafts carries the reply into the document workspace, where you can format it, save versions, and export it.",
        durationSeconds: 10,
        focus: "transferDraft",
      },
    ],
  },
  {
    id: "composer-commands",
    audioSrc: "training/user/composer-commands.mp3",
    title: "Composer symbol shortcuts",
    description: "Insert prompts, agents, knowledge, skills, and automations with one keystroke.",
    icon: "commands",
    outcomes: ["Prompt inserted", "All five symbols known"],
    setupSteps: [
      "Start a word with / to list saved prompts and enabled MCP tools.",
      "Start a word with @ to route the reply through an agent profile.",
      "Start a word with # to reference knowledge bases and their files.",
      "Start a word with $ to insert a saved skill file.",
      "Start a word with > to queue an automation to run when you send.",
      "Use the arrow keys to navigate, Enter to insert, and Escape to dismiss.",
    ],
    scenes: [
      {
        title: "The cheat sheet",
        caption: "Open Composer shortcuts from the information button for all five symbols.",
        narration:
          "Open the Composer shortcuts information button to see the cheat sheet: slash for prompts and MCP tools, at for agents, hash for knowledge, dollar for skill files, and the angle bracket for automations. Opening help does not change or send your message.",
        durationSeconds: 18,
        focus: "composerField",
      },
      {
        title: "Slash for prompts and tools",
        caption: "Typing / lists your saved prompts and enabled MCP connections; the footer shows the keys.",
        narration:
          "Type a slash and the menu lists your saved prompts and enabled MCP connections — whatever this workspace actually has. The footer shows the keys: arrows to navigate, Enter to insert, Escape to dismiss.",
        durationSeconds: 15,
        focus: "slashMenu",
      },
      {
        title: "At for agents",
        caption: "Typing @ lists agent profiles so the reply routes through one.",
        narration:
          "Type the at sign to pick an agent profile. The reply routes through that agent with its model, knowledge, and tools.",
        durationSeconds: 9,
        focus: "agentMenu",
      },
      {
        title: "Hash, dollar, and more",
        caption: "# references knowledge, $ inserts skill files, > queues an automation for this send.",
        narration:
          "The same pattern covers the rest: hash references knowledge bases and files, dollar inserts a skill file, and the angle bracket queues an automation to run when you press send.",
        durationSeconds: 13,
        focus: "composerField",
      },
    ],
  },
  {
    id: "attachments",
    audioSrc: "training/user/attachments.mp3",
    title: "Attach files and sources",
    description: "Upload documents, fetch web pages by link, or pull from connected drives.",
    icon: "attach",
    outcomes: ["File attached", "Web page fetched", "Sources understood"],
    scenes: [
      {
        title: "The paperclip",
        caption: "The paperclip opens the attachment menu for this message.",
        narration: "Click the paperclip in the composer to open the attachment menu for your next message.",
        durationSeconds: 7,
        focus: "attachButton",
      },
      {
        title: "Upload from your computer",
        caption: "Upload from computer attaches local files so the model can read them.",
        narration:
          "Upload from computer attaches files from this device. The model reads them as context for your message.",
        durationSeconds: 8,
        focus: "attachUpload",
      },
      {
        title: "Attach a web page by link",
        caption: "Web page by link fetches up to three public pages as cited sources for this message.",
        narration:
          "Web page by link attaches public web pages: paste an address and the platform fetches up to three pages as cited sources for this message.",
        durationSeconds: 11,
        focus: "attachWebLink",
      },
      {
        title: "Connect your own account",
        caption: "Cloud sources read from your account: click Connect, approve access, and the list loads.",
        narration:
          "Below that are workspace sources: Google Drive, OneDrive, SharePoint, Box, and iManage. These read from your own account — the first time you pick one, click Connect and approve read access in the sign-in window. Only you can see files from your account.",
        durationSeconds: 18,
        focus: "attachConnectors",
      },
    ],
  },
  {
    id: "dictation-images",
    audioSrc: "training/user/dictation-images.mp3",
    title: "Dictation, images, and diagrams",
    description: "Speak your message, generate images, and keep live diagrams.",
    icon: "dictation",
    outcomes: ["Message dictated", "Image downloaded", "Diagram exported"],
    scenes: [
      {
        title: "Dictate your message",
        caption: "The microphone records your voice and inserts the transcript into the composer.",
        narration:
          "Click the microphone button beside the send controls to dictate. A live waveform shows the platform is listening — click the stop square and your words are transcribed straight into the composer as editable text. Nothing sends until you press Enter.",
        durationSeconds: 17,
        focus: "micButton",
      },
      {
        title: "Ask for images",
        caption: "Models that support image generation return finished images directly in the reply.",
        narration:
          "When the selected model can generate images, just ask for what you want. The finished images appear directly in the reply.",
        durationSeconds: 9,
        focus: "imageReply",
      },
      {
        title: "Download what you keep",
        caption: "Download under an image saves it as a file; failures are reported honestly.",
        narration:
          "Click Download under any image to save it as a file you can use anywhere. If the microphone or a generation ever fails, the composer says exactly what went wrong.",
        durationSeconds: 12,
        focus: "imageDownload",
      },
      {
        title: "Diagrams are live figures",
        caption: "Diagrams render as live figures with Copy, PNG, SVG, and Code actions.",
        narration:
          "When a reply includes a diagram, it renders as a live figure right in the chat. Its header actions let you copy the source, download a PNG or SVG, or flip to the code view.",
        durationSeconds: 14,
        focus: "mermaidFigure",
      },
    ],
  },
  {
    id: "send-options",
    audioSrc: "training/user/send-options.mp3",
    title: "Knowledge, Web, Agent, and reasoning",
    description: "Control what the model can use — and how hard it thinks — for each reply.",
    icon: "send",
    outcomes: ["Toggles mastered", "Reasoning level set"],
    scenes: [
      {
        title: "Open send options",
        caption: "The chevron next to send opens the per-reply toggles.",
        narration: "Click the chevron beside the send button to open the send options menu.",
        durationSeconds: 6,
        focus: "sendOptionsButton",
      },
      {
        title: "Knowledge",
        caption: "Knowledge lets the reply search your enabled knowledge bases and cite them.",
        narration:
          "Knowledge lets the reply search your enabled knowledge bases and cite what it finds, with links back to the original sources.",
        durationSeconds: 9,
        focus: "sendKnowledge",
      },
      {
        title: "Web",
        caption: "Web uses public web search for this reply; results appear as citations.",
        narration:
          "Web uses public web search for this reply. Results come back as citations you can open, and the sources appear in the session details panel.",
        durationSeconds: 11,
        focus: "sendWeb",
      },
      {
        title: "Agent",
        caption: "Agent lets the reply use the tools your workspace has enabled.",
        narration:
          "Agent mode lets the reply use enabled tools. Pair it with an agent profile to route through a purpose-built configuration.",
        durationSeconds: 10,
        focus: "sendAgent",
      },
      {
        title: "Reasoning level",
        caption: "For models that support it, the Reasoning slider trades speed for deeper thinking.",
        narration:
          "The same menu carries a reasoning level slider. For models that support it, slide toward fast for quick answers or smart for deeper thinking — it stays off for models without real reasoning control.",
        durationSeconds: 14,
        focus: "sendReasoning",
      },
    ],
  },
  {
    id: "session-details",
    audioSrc: "training/user/session-details.mp3",
    title: "Session details and context",
    description: "Real token usage, active tools, and how full the context window is.",
    icon: "session",
    outcomes: ["Usage reviewed", "Context window understood"],
    scenes: [
      {
        title: "The session summary",
        caption: "The info button opens session details: messages, tokens, model, knowledge, tools, and agent.",
        narration:
          "The info button in the top bar opens session details: message counts, provider-reported token usage, the active model, plus whether knowledge, tools, and an agent profile are on. Only real numbers — never an estimate dressed up as real.",
        durationSeconds: 17,
        focus: "sessionSummary",
      },
      {
        title: "Watch the context window",
        caption: "The context window card shows how much of the chat the model keeps in view — and warns as it fills.",
        narration:
          "The context window card shows how full the model's memory is — how much of this chat, attachments, and sources it can keep in view. As it fills, the card warns you, and at one hundred percent a new chat is usually more reliable.",
        durationSeconds: 16,
        focus: "contextWindow",
      },
    ],
  },
  {
    id: "drafts",
    audioSrc: "training/user/drafts.mp3",
    title: "Draft documents",
    description: "Write manually or with an available model, save versions, and export documents.",
    icon: "drafts",
    outcomes: ["Document prepared", "Version saved", "Export ready"],
    scenes: [
      {
        title: "Two formats, one draft",
        caption: "The Draft format switch at the top toggles between Document and Deck.",
        narration:
          "Drafts now holds two formats. The Draft format switch at the top toggles between Document and Deck, and one draft can carry both.",
        durationSeconds: 10,
        focus: "draftModeToggle",
      },
      {
        title: "Ask for a draft",
        caption: "Describe the document you need; the assistant writes it into the editor with its own work trace.",
        narration:
          "With a usable model, describe the document you need and the assistant writes it straight into the editor, showing its own work trace as it goes. You can also transfer a chat response here to keep working on it.",
        durationSeconds: 14,
        focus: "draftComposer",
      },
      {
        title: "Pick the drafting model",
        caption: "Choose an approved model for AI work. Without a model, manual editing, import, save, history, and export remain available.",
        narration: "Choose an approved model for AI drafting and editing. If No models connected appears, AI actions are unavailable. You can still edit manually, import, save, use document history, and export. Follow the setup guidance for your role or ask your administrator for model access.",
        durationSeconds: 20,
        focus: "draftModel",
      },
      {
        title: "Format like a document",
        caption: "Block styles, text size, highlights, lists, links, citations, an Insert menu, and inline AI edit.",
        narration:
          "The toolbar covers real document formatting: block styles, text size, colors and highlights, lists, links, and citations, plus an Insert menu for images, charts, tables, and page breaks — and an inline AI edit for selected text.",
        durationSeconds: 17,
        focus: "draftToolbar",
      },
      {
        title: "Save, export, and leave safely",
        caption: "Export a saved version. When leaving unsaved work, choose Keep editing, Save copy and continue, or Discard and continue.",
        narration:
          "Save a version so you can compare or restore later, then export Word, Markdown, or a print view for PDF. When you navigate away or choose Sign out with unsaved changes, choose Keep editing, Save copy and continue, or Discard and continue. The recovery copy stays in this browser's document history. If storage fails, you stay in the draft. Save regularly because a forced security sign-out can still interrupt work.",
        durationSeconds: 27,
        focus: "draftVersions",
      },
    ],
  },
  {
    id: "deck-basics",
    audioSrc: "training/user/deck-basics.mp3",
    title: "Build a slide deck",
    description: "Turn a draft into slides, apply your brand, and export a real PowerPoint file.",
    icon: "deck",
    outcomes: ["Deck created", "Brand applied", "Real .pptx exported"],
    scenes: [
      {
        title: "One draft, two formats",
        caption: "The Draft format switch at the top starts on Document — click Deck to change formats.",
        narration:
          "At the top of every draft sits the format switch, and right now it reads Document. The same draft can carry both formats — click Deck to switch.",
        durationSeconds: 11,
        focus: "draftModeToggle",
      },
      {
        title: "The switch flips to Deck",
        caption: "The toggle now shows Deck; with document content, a dialog offers blank or convert first.",
        narration:
          "The editor becomes a slide workspace and the switch now shows Deck. If the draft already had document content, a dialog first offers Start a blank deck or Convert into slides — and your document versions are kept either way.",
        durationSeconds: 16,
        focus: "deckModeToggle",
      },
      {
        title: "Slides and the filmstrip",
        caption: "Drag thumbnails to reorder; each slide has move, duplicate, and delete actions.",
        narration:
          "The filmstrip lists every slide. Drag a thumbnail to reorder the deck, and each slide carries its own move, duplicate, and delete actions.",
        durationSeconds: 11,
        focus: "deckFilmstrip",
      },
      {
        title: "Seven layouts",
        caption: "Seven layouts cover title, bullets, columns, image, quote, section, and closing slides.",
        narration:
          "The layout menu gives each slide one of seven layouts: title, bullets, two columns, image with caption, quote, section break, and closing.",
        durationSeconds: 11,
        focus: "deckLayoutMenu",
      },
      {
        title: "Start from a template or your brand",
        caption: "Five starter decks, or upload a .pptx brand template — stored only on this device.",
        narration:
          "The templates panel offers five starters, or upload your own PowerPoint brand template. Its colors, fonts, logo, and every slide's design are extracted and stored only on this device — and Load all slides brings the whole template in.",
        durationSeconds: 17,
        focus: "deckTemplatesDrawer",
      },
      {
        title: "Your brand, applied",
        caption: "With a brand loaded, the stage and filmstrip pick up its colors, fonts, and logo.",
        narration:
          "With a brand theme applied, the stage and filmstrip restyle to match — your colors, fonts, and logo carry through the deck instead of the default look.",
        durationSeconds: 11,
        focus: "deckBrandStage",
      },
      {
        title: "Edit slide text with AI",
        caption: "Highlight text, click the AI pen, describe the change, then Apply AI edit.",
        narration:
          "Highlight any slide text and click the AI pen. Describe what should change, and Apply AI edit rewrites the highlighted text in place — undo restores it if you change your mind.",
        durationSeconds: 13,
        focus: "deckAiEdit",
      },
      {
        title: "Generate an AI slide image",
        caption: "Generate AI slide image prefills a prompt from the slide and sets the result as its background.",
        narration:
          "Generate AI slide image prefills a prompt from the slide's own content. Adjust the description if you like, and the generated image is set as that slide's background.",
        durationSeconds: 12,
        focus: "deckAiImage",
      },
      {
        title: "Backgrounds, per slide or all",
        caption: "The background menu also takes your own uploads — on this slide or on every slide.",
        narration:
          "Backgrounds are not AI-only: the background menu takes your own image uploads too, applied to just this slide or to every slide in the deck.",
        durationSeconds: 11,
        focus: "deckStageWithBg",
      },
      {
        title: "Speaker notes travel with you",
        caption: "Notes live under the stage, export inside the .pptx notes pane, and follow you when presenting.",
        narration:
          "Each slide has speaker notes under the stage. They export inside the PowerPoint file's notes pane, they appear in the Markdown outline, and they follow you into presentation mode.",
        durationSeconds: 13,
        focus: "deckNotes",
      },
      {
        title: "Present the deck",
        caption: "Present shows the deck full screen — click or arrow keys advance, notes sit below, Escape exits.",
        narration:
          "The Present button plays the deck full screen. Click anywhere or use the arrow keys to advance, keep your speaker notes open underneath to read from as you go, and leave with Escape or the Exit button.",
        durationSeconds: 14,
        focus: "deckPresent",
      },
      {
        title: "Versions and export",
        caption: "Decks save versions on this device only; Export produces a real .pptx or a Markdown outline.",
        narration:
          "Deck versions save on this device only until you export. Export produces a real, editable PowerPoint file that mirrors your slides, or a Markdown outline of titles, bullets, and notes.",
        durationSeconds: 14,
        focus: "deckExportMenu",
      },
    ],
  },
  {
    id: "agents",
    audioSrc: "training/user/agents.mp3",
    title: "Agent profiles",
    description: "Reusable configurations of model, knowledge, and tools you can chat through.",
    icon: "agents",
    outcomes: ["Profile readiness checked", "Private access understood", "Profile selection understood"],
    scenes: [
      {
        title: "What an agent is",
        caption: "A profile bundles a model route, instructions, knowledge, and tools. This saved example is not connected.",
        narration:
          "An agent profile bundles a model route, instructions, knowledge, and tools. This saved example is not connected. Before using a profile, confirm it has an approved model backed by a working provider.",
        durationSeconds: 15,
        focus: "agentsProfile",
      },
      {
        title: "Create one",
        caption: "When authoring is enabled, New Agent creates your private profile. Administrators control shared access.",
        narration:
          "If your account can build agents, choose New Agent, configure the profile, and save. Standard users create private profiles. Administrators control group sharing and organization publishing.",
        durationSeconds: 14,
        focus: "agentsNew",
      },
      {
        title: "Use it in chat",
        caption: "Type @ to choose an available profile. The Agent send option separately permits enabled tools.",
        narration:
          "In chat, type the at sign to choose an available profile. If the list is empty, ask your administrator to check profile readiness and access. The Agent send option separately permits enabled tools; it does not select a profile.",
        durationSeconds: 17,
        focus: "agentMenu",
      },
    ],
  },
  {
    id: "knowledge",
    audioSrc: "training/user/knowledge.mp3",
    title: "Knowledge bases",
    setupSteps: [
      "Open Knowledge/Tools and select Knowledge. Check the collection's access and indexing status before using it in chat.",
      "Type # in the composer. Loading files… shows progress; Some files could not be loaded offers Retry in the same menu. Successfully loaded sources remain usable.",
      "A file choice references that file in your prompt and searches its knowledge source. Read the Searches source-name detail to understand the scope.",
      "Ask your administrator to resolve missing source credentials or access. Repeated retries cannot override permissions.",
    ],
    description: "Give chats grounded, citable access to your documents and sources.",
    icon: "knowledge",
    outcomes: ["Knowledge base added", "Citations understood"],
    scenes: [
      {
        title: "Add a knowledge base",
        caption: "Add Knowledge Base creates a collection from uploads, a web link, or an API source.",
        narration:
          "Add Knowledge Base creates a collection. Its sources can be documents you upload, a web link, or an API — indexed so chat can search and cite them.",
        durationSeconds: 11,
        focus: "knowledgeAdd",
      },
      {
        title: "Status and access",
        caption: "Each base shows status, security, and whether it is enabled for chat.",
        narration:
          "Each base lists its status, security posture, and whether it is enabled. Only enabled bases are searchable from chat, and access control is enforced per source.",
        durationSeconds: 12,
        focus: "knowledgeTable",
      },
      {
        title: "Reference it while typing",
        caption: "Type # to reference knowledge. Choosing a file searches its knowledge source.",
        narration:
          "Type hash to open knowledge choices. Selecting a file references its name and searches its knowledge source. The menu identifies that source. If some files fail to load, choose Retry; sources that loaded remain available.",
        durationSeconds: 17,
        focus: "composerField",
      },
    ],
  },
  {
    id: "tools-automations",
    audioSrc: "training/user/tools-automations.mp3",
    title: "Tools and the Library",
    description: "MCP connections, saved prompts, and skills — under Knowledge/Tools in the sidebar.",
    icon: "tools",
    outcomes: ["Library sections known", "Honest status read"],
    scenes: [
      {
        title: "Tools live in the Library",
        caption: "Open Knowledge/Tools in the sidebar — the Library holds Tools alongside Knowledge.",
        narration:
          "Tools live in the Library — open Knowledge and Tools in the sidebar. The Connections section holds MCP connections, Prompts holds saved prompt templates, and Skills holds skill files — prompts surface under slash in the composer, skills under dollar.",
        durationSeconds: 18,
        focus: "toolsHeader",
      },
      {
        title: "Tool status is honest",
        caption: "Each connection shows its real status — draft and approval states are labeled.",
        narration:
          "Every row shows its real status — draft, approval required, enabled — so you always know whether a connection is actually live before relying on it.",
        durationSeconds: 11,
        focus: "toolsRows",
      },
      {
        title: "Automations moved to Agents",
        caption: "Scheduled automations live under Agents/Automations, in the Automations tab.",
        narration:
          "Scheduled automations are no longer here — they live under Agents and Automations in the sidebar, on the Automations tab, which the next walkthrough covers.",
        durationSeconds: 11,
        focus: "automationsTabs",
      },
    ],
  },
  {
    id: "scheduled-automations",
    audioSrc: "training/user/scheduled-automations.mp3",
    title: "Scheduled automations",
    description: "Set up recurring model-chain runs that deliver real chat threads.",
    icon: "automation",
    outcomes: ["Schedule chosen", "Model chain built", "Run tested"],
    setupSteps: [
      "Open Agents/Automations in the sidebar and switch to the Automations tab.",
      "Click New automation and name the workflow clearly.",
      "Choose Chat or Draft as the run target.",
      "Pick Once, Weekly, or Cron for the schedule.",
      "Choose approved models for each step and add instructions for the chain.",
      "Save it, then use Run now to test before relying on the schedule.",
    ],
    scenes: [
      {
        title: "Find automations under Agents",
        caption: "Open Agents/Automations in the sidebar, then switch to the Automations tab.",
        narration:
          "Open Agents and Automations in the sidebar and switch to the Automations tab. Scheduled chat or drafting runs live here, using only models available to your organization and approved by its administrators.",
        durationSeconds: 16,
        focus: "automationsTabs",
      },
      {
        title: "Create the scheduled run",
        caption: "New automation sets the Chat or Draft target and a Once, Weekly, or Cron schedule.",
        narration:
          "New automation builds the schedule: name it, choose Chat or Draft as the target, then pick Once, Weekly, or a Cron expression — and build the model chain step by step.",
        durationSeconds: 13,
        focus: "automationsNew",
      },
      {
        title: "Read the card",
        caption: "Each card shows the schedule, the model chain, a pause toggle, and Run now.",
        narration:
          "Each card shows the schedule, the model chain, and its status. The toggle pauses it, the pencil edits it, and Run now executes the chain immediately.",
        durationSeconds: 11,
        focus: "automationsCard",
      },
      {
        title: "Runs happen for real",
        caption: "Enabled schedules run automatically in the background in UTC; each run arrives as a new chat thread.",
        narration:
          "The banner tells you exactly how it behaves: enabled schedules run automatically in the background, times are in UTC, and each scheduled run delivers its output as a new chat thread.",
        durationSeconds: 14,
        focus: "automationsBanner",
      },
    ],
  },
  {
    id: "chat-previews",
    audioSrc: "training/user/chat-previews.mp3",
    title: "Preview chats at a glance",
    description: "Hover any listed chat to read its prompts and outputs in a compact, scrollable preview.",
    icon: "preview",
    outcomes: ["Preview opened", "Chat recognized", "Visual content spotted"],
    setupSteps: [
      "Pause the pointer over a chat name for a moment; keyboard users can focus the chat row instead.",
      "The preview always begins at Prompt 1; scroll down its right edge to read each prompt and output in order.",
      "Private thinking traces stay hidden, while images and diagrams remain visible in the conversation.",
      "Use the same preview in Recent, Pinned, folders, View all chats, and Archived chats.",
      "Move away or press Escape to close the preview without opening the chat.",
    ],
    scenes: [
      {
        title: "See the chat before opening it",
        caption: "Hover or focus any chat row, then scroll through its prompts, outputs, images, and diagrams.",
        narration:
          "Pause over any chat name and a compact conversation preview opens without changing your workspace. It always starts at the top with Prompt 1. Scroll down the right edge to read each prompt and visible output in order, including images and diagrams, while private thinking traces stay hidden. The same preview works in Recent, Pinned, folders, View all chats, and Archived chats, so you can recognize a conversation before you open, restore, or delete it.",
        durationSeconds: 29,
        focus: "sidebarPreview",
      },
    ],
  },
  {
    id: "personalization-memory",
    audioSrc: "training/user/personalization-memory.mp3",
    title: "Personalization memory",
    description: "Save preferences in plain English, recall them in later sessions, and stay in control.",
    icon: "memory",
    outcomes: ["Memory controls found", "Plain-English save and recall understood", "Cross-session use understood"],
    setupSteps: [
      "Service policy and your organization administrator must allow Personalization memory before the account row appears.",
      "Say something natural such as “Remember that I prefer a short summary first” to save it from any chat.",
      "Ask “What do you remember about me?” or a specific question about a saved preference in any later chat or session.",
      "Open your account card, then Personalization memory, whenever you want to add, correct, pin, forget, or clear memories.",
      "Keep credentials and sensitive identifiers out of memory; the platform rejects them on purpose.",
    ],
    scenes: [
      {
        title: "Open your memory controls",
        caption: "Click your account card at the bottom-left, then choose Personalization memory.",
        narration:
          "To see what the assistant remembers, click your account card at the bottom-left of the sidebar. Then choose Personalization memory. This row is available to owners, administrators, and regular users whenever memory is enabled for the platform and your organization.",
        durationSeconds: 19,
        focus: "memoryAccountEntry",
      },
      {
        title: "Choose how memory works",
        caption: "Use memory applies saved context; Learn from my conversations controls automatic capture.",
        narration:
          "Use memory in my chats applies your saved context to answers. Learn from my conversations lets the assistant notice durable preferences on its own. Turn either setting off whenever you want; memories already saved remain private and manageable.",
        durationSeconds: 18,
        focus: "memorySettings",
      },
      {
        title: "Add, review, and forget",
        caption: "Add a memory directly, or review the list to edit, pin, forget, or clear it.",
        narration:
          "You can add a memory directly and choose its type, or simply say remember that in a chat. Saved memories appear below, where you can correct the wording, pin important items, forget one item, or use Forget everything. Only you can read the content; administrators see counts and can purge for compliance, but never read it.",
        durationSeconds: 21,
        focus: "memoryAddAndReview",
      },
      {
        title: "Recall it in later sessions",
        caption: "Plain-English memory follows your account into new chats and later sign-in sessions.",
        narration:
          "Memory follows your account beyond a single conversation. After saying, for example, remember my cross-session phrase, open a new chat or return in a later sign-in session and ask a natural question such as, what is my cross-session phrase, or what do you remember about me. The assistant uses the same private memory across those sessions.",
        durationSeconds: 23,
        focus: "memoryRecall",
      },
    ],
  },
  {
    id: "organize",
    audioSrc: "training/user/organize.mp3",
    title: "Organize and find your work",
    description: "Folders, pins, archiving, the search palette, and the rest of the sidebar.",
    icon: "organize",
    outcomes: ["Folder created", "Chat pinned", "Palette opened"],
    scenes: [
      {
        title: "Folders",
        caption: "Folders group chats you revisit — like client matters; create one from the FOLDERS row.",
        narration:
          "Create folders from the sidebar for chats you keep coming back to — client matters, projects, anything ongoing — and file chats into them.",
        durationSeconds: 10,
        focus: "sidebarFolders",
      },
      {
        title: "Pin what matters",
        caption: "Pinned chats stay at the top of the sidebar.",
        narration: "Pin a chat and it stays in the Pinned section at the top of the sidebar.",
        durationSeconds: 6,
        focus: "sidebarPinned",
      },
      {
        title: "Row actions on hover",
        caption: "Hover a recent chat for add-to-folder, pin, and archive.",
        narration:
          "Hover any recent chat to reveal its quick actions: add it to a folder, pin it, or archive it out of the way.",
        durationSeconds: 9,
        focus: "sidebarRowActions",
      },
      {
        title: "Search everything",
        caption: "Search — or Ctrl/Cmd K — opens a palette across chats, including archived, agents, drafts, and documents.",
        narration:
          "Search opens the command palette — Control or Command K works anywhere. It searches your chats including archived ones, plus agents, drafts, and indexed documents, and jumps straight to what you pick.",
        durationSeconds: 14,
        focus: "searchPalette",
      },
      {
        title: "The bottom of the sidebar",
        caption: "The sidebar ends with Search, Help, and the theme switch; your account card sits underneath.",
        narration:
          "The bottom of the sidebar holds Search, Help — where these walkthroughs live — and the theme switch. Your account card opens profile editing and archived chats, and admins find the Management consoles there too.",
        durationSeconds: 14,
        focus: "sidebarUtilities",
      },
    ],
  },
  {
    id: "account-security",
    audioSrc: "training/user/account-security.mp3",
    title: "Protect your account and recover access",
    description: "Set up an authenticator, store recovery codes, and manage a local account password.",
    icon: "session",
    outcomes: ["Security controls located", "Recovery procedure understood", "Password settings understood"],
    setupSteps: [
      "Open your account card, then choose Manage security to see Two-step verification.",
      "For a local account, select Set up authenticator and confirm your current password. Use your identity provider's settings for organization-managed sign-in.",
      "Add the displayed account to your authenticator privately, acknowledge that you added it, and verify a current code.",
      "Copy and securely store the one-time recovery codes before acknowledging them and selecting Done. Never include passwords, setup keys, QR codes, or recovery codes in a support screenshot.",
      "Replace recovery codes with fresh verification when needed. If policy allows disabling verification, understand that it invalidates the authenticator and recovery codes and signs you out.",
      "To change a local password, choose Edit in the Password card, enter the current and new passwords, confirm the new password, and choose Update password.",
    ],
    scenes: [
      {
        title: "Find your security settings",
        caption: "Account → Manage security opens Two-step verification and shows its current status.",
        narration: "Open your account card and choose Manage security. Two-step verification shows whether an authenticator is on or off and whether your organization requires it. For organization-managed sign-in, follow the identity provider's security settings and contact your administrator about any additional workspace requirement.",
        durationSeconds: 22,
        focus: "securityOverview",
      },
      {
        title: "Confirm your current password",
        caption: "Local accounts start with Set up authenticator, Current password, and Continue setup.",
        narration: "For a local account without an authenticator, choose Set up authenticator. Enter your current password and select Continue setup. The password confirms that you can change this account's security settings. If the request fails, read the error before trying again; Cancel returns to the overview.",
        durationSeconds: 20,
        focus: "securityStart",
      },
      {
        title: "Verify the authenticator privately",
        caption: "Add the account to your authenticator, acknowledge it, and verify the current six-digit code.",
        narration: "Add the account to your authenticator by scanning the displayed QR code or entering its setup key privately. Check that you added it, enter the current six-digit authenticator code, and choose Verify authenticator. Keep the setup key and QR code out of screenshots, messages, and shared documents.",
        durationSeconds: 20,
        focus: "securityVerify",
      },
      {
        title: "Store the recovery codes before leaving",
        caption: "Copy recovery codes, store them securely, acknowledge storage, then choose Done.",
        narration: "After verification, save your recovery codes while they are shown. Each code works once if you cannot use the authenticator. Copy the codes into secure storage, acknowledge that you stored them, then choose Done. Copying does not store them for you. Finish this step before leaving the security panel.",
        durationSeconds: 20,
        focus: "securityRecovery",
      },
      {
        title: "Replace codes or turn verification off",
        caption: "Fresh verification is required. Replacing codes invalidates the old set; disabling verification signs you out.",
        narration: "The overview shows how many recovery codes remain. Replace recovery codes requires a current authenticator code or an unused recovery code, and the old set stops working. Turn off verification appears only when policy permits it. Confirming that action disables the authenticator and recovery codes and signs you out. Organization-required verification cannot be turned off.",
        durationSeconds: 26,
        focus: "securityReplace",
      },
      {
        title: "Change a local account password",
        caption: "Password → Edit opens Current password, New password, Confirm new password, and Update password.",
        narration: "In your account's Password card, choose Edit. Enter the current password, a new password with at least twelve characters, and a matching confirmation, then select Update password. After a successful change you remain in the workspace with a refreshed session, and older sessions are revoked. An SSO-managed password is changed through your identity provider.",
        durationSeconds: 23,
        focus: "securityPassword",
      },
    ],
  },
  {
    id: "account-mobile-help",
    audioSrc: "training/user/account-mobile-help.mp3",
    title: "Personalize, use mobile, and get help",
    description: "Find profile and appearance controls, use composer shortcuts, and report a reproducible problem.",
    icon: "organize",
    outcomes: ["Personal controls located", "Mobile navigation understood", "Support report prepared"],
    setupSteps: [
      "Open your account card and edit your profile. Save profile applies the changes; Cancel leaves the saved profile unchanged.",
      "Use the Light mode or Dark mode control at the bottom of the sidebar to change appearance.",
      "Open Composer shortcuts beside the message field for the available command prefixes and keyboard hints.",
      "On a narrow screen, open the menu to reach navigation, account, Help, and available installation instructions.",
      "Open Help for the video library and printable user guide. Choose Report a problem for a platform issue.",
      "Enter a useful subject and reproducible description, optionally attach a safe screenshot, and send the report. Confirm Report sent before assuming an administrator received it.",
    ],
    scenes: [
      {
        title: "Edit your profile",
        caption: "Open your account card, choose Edit account profile, make changes, and Save profile.",
        narration: "Open your account card, then edit your profile. Review your display name, photo, and the other optional profile fields before choosing Save profile. The changes apply after the save succeeds. Cancel returns to the account view without saving your edits.",
        durationSeconds: 18,
        focus: "profileEditor",
      },
      {
        title: "Choose your appearance",
        caption: "The sidebar's Light mode or Dark mode button names the appearance it will switch to.",
        narration: "At the bottom of the sidebar, use Light mode or Dark mode to change the workspace's appearance. The label names the mode you will switch to. Your account, Help, and Search controls are nearby when you need them.",
        durationSeconds: 14,
        focus: "appearanceControl",
      },
      {
        title: "Use the composer shortcut guide",
        caption: "Composer shortcuts explains / prompts and tools, @ agents, # knowledge, $ skills, and > automations.",
        narration: "Choose Composer shortcuts beside the message field to see the command prefixes. Start a word with slash for prompts and tools, at for agents, hash for knowledge, dollar for skills, or greater-than for automations. In the standard composer, Enter sends and Shift Enter adds a line. Dismiss shortcuts returns you to your message.",
        durationSeconds: 22,
        focus: "composerShortcuts",
      },
      {
        title: "Open navigation on a small screen",
        caption: "Open menu reveals navigation when the sidebar is collapsed on a narrow screen.",
        narration: "On a narrow screen, the sidebar collapses to leave room for your work. Choose Open menu to reach navigation, recent chats, Help, and your account. Choose the destination you need, then return to the conversation. The same account permissions apply on mobile and desktop.",
        durationSeconds: 19,
        focus: "mobileNavigation",
      },
      {
        title: "Follow your browser's installation instructions",
        caption: "Install app may show manual instructions or a browser prompt; availability depends on the browser.",
        narration: "When Install app is available, open it and follow the instructions for your browser. On iPhone or iPad, use your browser's Share button, choose Add to Home Screen, then tap Add. Other supported browsers may offer an installation prompt. Opening instructions alone does not install the app.",
        durationSeconds: 20,
        focus: "mobileInstall",
      },
      {
        title: "Find the guide while you work",
        caption: "Help contains the walkthrough library, transcripts, and the printable user guide.",
        narration: "Open Help for the guided video library. Choose a topic, pause or seek through its scenes, and read the transcript when you prefer written instructions. The printable user guide covers the workspace procedures in a PDF you can keep or share.",
        durationSeconds: 17,
        focus: "helpLibrary",
      },
      {
        title: "Describe a reproducible problem",
        caption: "Help → Report a problem opens Subject, Message, and an optional screenshot attachment.",
        narration: "In Help, choose Report a problem. Give it a clear subject and describe what you tried, what you expected, and what happened. Add the steps that reproduce the problem. You may attach a screenshot, but leave out passwords, recovery codes, personal information, and any material your team should not share.",
        durationSeconds: 20,
        focus: "helpReportForm",
      },
      {
        title: "Confirm the report reached the workspace",
        caption: "After Send report succeeds, Report sent confirms an administrator can review it in Analytics.",
        narration: "Choose Send report and wait for Report sent. That confirmation means an administrator can review the report in Analytics. If an error appears, the report has not been confirmed; review it and try again when appropriate. For updates and resolution, follow your organization's support process.",
        durationSeconds: 20,
        focus: "helpReportReceived",
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
} satisfies Record<UserGuideIcon, typeof MessageSquare>;

const USER_DECK: TrainingDeck = {
  badge: "User guide",
  regions: USER_FOCUS_REGIONS,
  videos: USER_TRAINING_VIDEOS,
  icons: GUIDE_ICONS,
  pdf: {
    href: "docs/aperture-user-guide.pdf",
    title: "User guide (PDF)",
    description: "Every topic in this playlist as a printable step-by-step guide — nothing assumed.",
    tooltip: "Download the step-by-step user guide to keep, print, or share",
  },
};

export function UserGuidePlaylist({ brandName }: { brandName?: string | null }) {
  return (
    <TrainingGuidePlaylist
      deck={USER_DECK}
      brandName={brandName}
      introTagline="Real platform screens with callouts, captions, and transcripts — from your first message and cross-session memory to slide decks, diagrams, search, and scheduled automations."
    />
  );
}
