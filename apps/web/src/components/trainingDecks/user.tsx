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
  | "memoryRecall";

const FOCUS_REGIONS: Record<UserFocus, FocusRegion> = {
  homeComposer: { frame: "training/user/chat-home.png", rect: { x: 323, y: 352, w: 768, h: 155 } },
  modelSelector: { frame: "training/user/chat-home.png", rect: { x: 806, y: 10, w: 311, h: 39 } },
  toolsChip: { frame: "training/user/chat-home.png", rect: { x: 374, y: 452, w: 130, h: 32 } },
  sendButtonsHome: { frame: "training/user/chat-home.png", rect: { x: 995, y: 449, w: 80, h: 37 } },
  micButton: { frame: "training/user/chat-home.png", rect: { x: 928, y: 452, w: 28, h: 30 } },
  traceCollapsed: { frame: "training/user/chat-thread.png", rect: { x: 319, y: 76, w: 623, h: 32 } },
  traceExpanded: { frame: "training/user/chat-trace-expanded.png", rect: { x: 314, y: 235, w: 626, h: 261 } },
  responseActions: { frame: "training/user/chat-response-actions.png", rect: { x: 315, y: 580, w: 155, h: 38 } },
  transferDraft: { frame: "training/user/chat-response-actions.png", rect: { x: 1000, y: 580, w: 152, h: 38 } },
  slashMenu: { frame: "training/user/composer-slash.png", rect: { x: 259, y: 599, w: 571, h: 80 } },
  agentMenu: { frame: "training/user/composer-agent.png", rect: { x: 259, y: 547, w: 886, h: 132 } },
  composerField: { frame: "training/user/composer-slash.png", rect: { x: 259, y: 679, w: 576, h: 159 } },
  attachButton: { frame: "training/user/composer-attach.png", rect: { x: 275, y: 781, w: 34, h: 34 } },
  attachUpload: { frame: "training/user/composer-attach.png", rect: { x: 279, y: 489, w: 243, h: 38 } },
  attachWebLink: { frame: "training/user/composer-attach.png", rect: { x: 279, y: 523, w: 243, h: 38 } },
  attachConnectors: { frame: "training/user/composer-attach.png", rect: { x: 279, y: 570, w: 250, h: 200 } },
  sendOptionsButton: { frame: "training/user/composer-send-options.png", rect: { x: 781, y: 779, w: 37, h: 37 } },
  sendKnowledge: { frame: "training/user/composer-send-options.png", rect: { x: 559, y: 564, w: 250, h: 45 } },
  sendWeb: { frame: "training/user/composer-send-options.png", rect: { x: 559, y: 614, w: 250, h: 45 } },
  sendAgent: { frame: "training/user/composer-send-options.png", rect: { x: 559, y: 664, w: 250, h: 46 } },
  sendReasoning: { frame: "training/user/composer-send-options.png", rect: { x: 568, y: 730, w: 233, h: 31 } },
  sessionSummary: { frame: "training/user/chat-session-panel.png", rect: { x: 879, y: 70, w: 291, h: 170 } },
  contextWindow: { frame: "training/user/chat-session-panel.png", rect: { x: 881, y: 398, w: 288, h: 237 } },
  imageReply: { frame: "training/user/chat-images.png", rect: { x: 315, y: 309, w: 517, h: 379 } },
  imageDownload: { frame: "training/user/chat-images-download.png", rect: { x: 1037, y: 656, w: 106, h: 34 } },
  mermaidFigure: { frame: "training/user/chat-mermaid.png", rect: { x: 317, y: 390, w: 830, h: 290 } },
  searchPalette: { frame: "training/user/search-palette.png", rect: { x: 280, y: 100, w: 624, h: 220 } },
  draftModeToggle: { frame: "training/user/drafts.png", rect: { x: 481, y: 13, w: 198, h: 37 } },
  draftComposer: { frame: "training/user/drafts.png", rect: { x: 93, y: 685, w: 348, h: 148 } },
  draftModel: { frame: "training/user/drafts.png", rect: { x: 481, y: 60, w: 316, h: 44 } },
  draftToolbar: { frame: "training/user/drafts.png", rect: { x: 479, y: 173, w: 661, h: 108 } },
  draftVersions: { frame: "training/user/drafts.png", rect: { x: 481, y: 60, w: 524, h: 93 } },
  deckModeToggle: { frame: "training/user/deck-editor.png", rect: { x: 481, y: 13, w: 198, h: 37 } },
  deckFilmstrip: { frame: "training/user/deck-editor.png", rect: { x: 461, y: 257, w: 159, h: 598 } },
  deckLayoutMenu: { frame: "training/user/deck-layouts.png", rect: { x: 775, y: 433, w: 367, h: 175 } },
  deckTemplatesDrawer: { frame: "training/user/deck-templates.png", rect: { x: 86, y: 177, w: 359, h: 502 } },
  deckBrandStage: { frame: "training/user/deck-editor-brand.png", rect: { x: 657, y: 404, w: 490, h: 262 } },
  deckAiEdit: { frame: "training/user/deck-ai-edit.png", rect: { x: 944, y: 211, w: 241, h: 258 } },
  deckAiImage: { frame: "training/user/deck-ai-image.png", rect: { x: 984, y: 215, w: 199, h: 219 } },
  deckStageWithBg: { frame: "training/user/deck-ai-applied.png", rect: { x: 656, y: 389, w: 496, h: 283 } },
  deckNotes: { frame: "training/user/deck-notes.png", rect: { x: 658, y: 727, w: 494, h: 106 } },
  deckPresent: { frame: "training/user/deck-present.png", rect: { x: 14, y: 692, w: 1157, h: 152 } },
  deckExportMenu: { frame: "training/user/deck-export.png", rect: { x: 775, y: 159, w: 392, h: 198 } },
  agentsProfile: { frame: "training/user/agents.png", rect: { x: 261, y: 171, w: 887, h: 63 } },
  agentsNew: { frame: "training/user/agents.png", rect: { x: 1039, y: 32, w: 128, h: 39 } },
  knowledgeAdd: { frame: "training/user/knowledge.png", rect: { x: 934, y: 95, w: 168, h: 34 } },
  knowledgeTable: { frame: "training/user/knowledge.png", rect: { x: 255, y: 165, w: 900, h: 80 } },
  toolsHeader: { frame: "training/user/tools.png", rect: { x: 248, y: 78, w: 916, h: 146 } },
  toolsRows: { frame: "training/user/tools.png", rect: { x: 261, y: 234, w: 887, h: 97 } },
  automationsTabs: { frame: "training/user/automations.png", rect: { x: 780, y: 26, w: 208, h: 30 } },
  automationsNew: { frame: "training/user/automations.png", rect: { x: 999, y: 21, w: 162, h: 36 } },
  automationsBanner: { frame: "training/user/automations.png", rect: { x: 248, y: 93, w: 916, h: 59 } },
  automationsCard: { frame: "training/user/automations.png", rect: { x: 261, y: 174, w: 886, h: 112 } },
  sidebarFolders: { frame: "training/user/sidebar-chats.png", rect: { x: 30, y: 274, w: 180, h: 46 } },
  sidebarPinned: { frame: "training/user/sidebar-chats.png", rect: { x: 30, y: 313, w: 180, h: 80 } },
  sidebarPreview: { frame: "training/user/sidebar-chat-preview.png", rect: { x: 310, y: 292, w: 435, h: 530 } },
  sidebarRowActions: { frame: "training/user/sidebar-chats.png", rect: { x: 118, y: 431, w: 80, h: 34 } },
  sidebarUtilities: { frame: "training/user/sidebar-chats.png", rect: { x: 9, y: 683, w: 207, h: 160 } },
  memoryAccountEntry: { frame: "training/user/memory-account.png", rect: { x: 881, y: 247, w: 283, h: 44 } },
  memorySettings: { frame: "training/user/memory-manager.png", rect: { x: 343, y: 312, w: 696, h: 104 } },
  memoryAddAndReview: { frame: "training/user/memory-manager.png", rect: { x: 343, y: 421, w: 696, h: 190 } },
  memoryRecall: { frame: "training/user/memory-recall.png", rect: { x: 378, y: 157, w: 684, h: 107 } },
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
    id: "chat-basics",
    audioSrc: "training/user/chat-basics.mp3",
    title: "Start chatting",
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
        caption: "Hover the composer to see all five symbol shortcuts at a glance.",
        narration:
          "Hover over the composer and a cheat sheet lists every symbol shortcut: slash for prompts and MCP tools, at for agents, hash for knowledge, dollar for skill files, and the angle bracket for automations.",
        durationSeconds: 15,
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
    description: "Generate, format, version, and export documents with the assistant.",
    icon: "drafts",
    outcomes: ["Draft generated", "Version saved", "Export ready"],
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
          "Describe the document you need and the assistant writes it straight into the editor, showing its own work trace as it goes. You can also transfer any chat response here to keep working on it.",
        durationSeconds: 13,
        focus: "draftComposer",
      },
      {
        title: "Pick the drafting model",
        caption: "The model selector chooses which approved model writes and edits this draft.",
        narration: "The model selector picks which approved model writes and edits this draft.",
        durationSeconds: 6,
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
        title: "Versions and export",
        caption: "Export needs a saved version, then offers Word document, Markdown, or Print / Save as PDF.",
        narration:
          "Save a version when the draft reaches a good state — you can compare or restore later. Export works from your latest saved version and offers a Word document, Markdown, or the print view for Save as PDF.",
        durationSeconds: 15,
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
    outcomes: ["Agent created", "Agent used in chat"],
    scenes: [
      {
        title: "What an agent is",
        caption: "An agent bundles a model route, meta prompts, knowledge, and tools — like this Contract Review Assistant.",
        narration:
          "An agent profile bundles a model route, meta prompts, knowledge bases, and tools into one reusable configuration — like this Contract Review Assistant, ready to use in chat.",
        durationSeconds: 14,
        focus: "agentsProfile",
      },
      {
        title: "Create one",
        caption: "New Agent builds a profile from the models and sources your workspace approved.",
        narration:
          "New Agent creates a profile using the models and sources your workspace has approved. Once saved, it is available to every chat.",
        durationSeconds: 10,
        focus: "agentsNew",
      },
      {
        title: "Use it in chat",
        caption: "Type @ in the composer, or turn on Agent in send options, to route through a profile.",
        narration:
          "Back in chat, type the at sign and the menu lists your profiles — pick one and the reply routes through its full configuration. The Agent toggle in send options does the same.",
        durationSeconds: 13,
        focus: "agentMenu",
      },
    ],
  },
  {
    id: "knowledge",
    audioSrc: "training/user/knowledge.mp3",
    title: "Knowledge bases",
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
        caption: "Type # in the composer to cite a knowledge base or a specific file.",
        narration:
          "In the composer, type hash to reference a knowledge base or a specific file. Replies grounded in knowledge return citations that link back to the source.",
        durationSeconds: 12,
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
  regions: FOCUS_REGIONS,
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
