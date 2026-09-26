/* Source of truth for the downloadable role guides (user / admin / owner).
 *
 * Every section is tagged with the minimum role that should read it:
 *   "user"  → appears in all three guides
 *   "admin" → appears in the admin and owner guides
 *   "owner" → appears in the owner guide only
 *
 * The prose is grounded in the real UI (labels, tabs, tooltips) — if a control
 * is renamed or removed, update the matching section here and regenerate the
 * PDFs with scripts/guide-pdfs/generate.cjs.
 */

const p = (text) => ({ type: "p", text });
const steps = (items) => ({ type: "steps", items });
const list = (items) => ({ type: "list", items });
const note = (tone, text) => ({ type: "note", tone, text });
const table = (headers, rows) => ({ type: "table", headers, rows });
const sub = (text) => ({ type: "sub", text });

const PARTS = [
  { id: "basics", minRole: "user", label: "Getting started" },
  { id: "chat", minRole: "user", label: "Chat" },
  { id: "workspace", minRole: "user", label: "Drafts, decks, and agents" },
  { id: "toolsauto", minRole: "user", label: "Library and automations" },
  { id: "account", minRole: "user", label: "Appearance, your account, and help" },
  { id: "admin", minRole: "admin", label: "The Admin console" },
  { id: "owner", minRole: "owner", label: "The Platform owner console" },
];

const SECTIONS = [
  /* ---------------------------------------------------------------- basics */
  {
    id: "welcome",
    part: "basics",
    minRole: "user",
    title: "Welcome",
    summary: "What Aperture Chat is and how to read this guide.",
    blocks: [
      p(
        "Aperture Chat is your organization's workspace assistant. You can chat with approved AI models, draft documents and slide decks, search your organization's knowledge, and schedule recurring work. Review the sources and work trace when a response uses connected knowledge or tools.",
      ),
      p(
        "This guide explains where to look and what to choose. Words in bold — like Save version — match the labels on screen. If a step says “hover”, rest your pointer on the item without clicking; controls that offer extra help show it nearby.",
      ),
      table(
        ["Guide", "Who it is for", "What it covers"],
        [
          ["User Guide", "Everyone", "Chat, model access requests, personalization memory, documents and decks, account sync, agents, knowledge and tools, search and commands, appearance, and account security."],
          ["Administrator Guide", "Workspace admins", "Everything in the User Guide, plus the Admin console: users, groups, model access, response actions, SSO, analytics, policies and memory governance, audit, and alerts."],
          ["Platform Owner Guide", "Platform owners", "Everything in the other guides, plus setup readiness, providers and keys, organization policy, shared connectors, branding, releases, search indexing, and platform governance."],
        ],
      ),
      note(
        "tip",
        "If a feature is not configured — a connector without credentials, a model that is not enabled — the screen reports that state. Ask your administrator about account or model access; shared connector settings and credentials are managed by the service team outside tenant administration.",
      ),
    ],
  },
  {
    id: "signing-in",
    part: "basics",
    minRole: "user",
    title: "Signing in",
    summary: "Reach the sign-in screen and get into your workspace.",
    blocks: [
      steps([
        "Open the web address your organization gave you for Aperture Chat in a modern browser (Chrome, Edge, Safari, or Firefox).",
        "On the sign-in screen, type your work email address in the field marked you@company.com.",
        "If your organization uses single sign-on (SSO), the screen recognizes your email domain and offers Continue with SSO. Click it — you are sent to your organization's identity provider (for example Microsoft or Google), sign in there as usual, and return to Aperture Chat already signed in.",
        "When both methods are offered, choose Organization SSO or Email & password. The password field appears in Email & password mode; enter your password and click Sign in. Pressing Enter submits the method you selected.",
      ]),
      note(
        "info",
        "If both SSO and a password are available, either works. If your organization enforces SSO for your email domain, password sign-in is blocked on purpose — use the SSO button.",
      ),
      note(
        "info",
        "See a message you do not expect? The sign-in screen reports real problems plainly (for example, a domain that is not allowed for SSO). Copy the message and send it to your administrator.",
      ),
    ],
  },
  {
    id: "request-access",
    part: "basics",
    minRole: "user",
    title: "Request access and finish your first sign-in",
    summary: "Submit a request, understand the administrator handoff, and enter the workspace.",
    blocks: [
      steps([
        "On the sign-in screen, choose Request access. Enter your first name, last name, and work email, then submit the form.",
        "The Request received screen confirms submission for your email. If this email is new to the workspace, an administrator reviews the request. This form does not email you or create a password.",
        "Contact your administrator for an update. After approval, they provide the workspace address and confirm whether to use organization SSO or a temporary password.",
        "Choose Back to sign in. Your submitted email remains filled in. Use the sign-in method your administrator arranged.",
        "If you received a temporary password, sign in with it and complete Set a new password. Enter a new password of at least 12 characters twice. After saving, the app continues with a new authenticated session and revokes your older sessions.",
        "Complete any required authenticator verification. Once in the workspace, select an available model and send a short first message. If no model is available, ask your administrator to check your account, group, and model access.",
      ]),
      note("info", "Submitting another access request does not approve an account or recover an existing password. Trouble signing in explains the recovery path: contact your administrator for local password access, or use your organization identity provider for SSO. If sign-in settings cannot load, choose Retry connection."),
    ],
  },
  {
    id: "two-step-verification",
    part: "basics",
    minRole: "user",
    title: "Two-step verification and recovery codes",
    summary: "Set up an authenticator, complete required verification, and manage recovery codes.",
    blocks: [
      p("To add an authenticator after signing in with a local password, open your account drawer, find Security, choose Manage security, and select Set up authenticator. Confirm your current password, add the QR code or setup key to your authenticator, acknowledge that you added it, and choose Verify authenticator with a current six-digit code. Copy the one-time recovery codes into secure storage, acknowledge that you saved them, and choose Done. Copying alone does not store them for you; finish verification and code storage before leaving the panel."),
      steps([
        "If sign-in asks you to set up an authenticator, choose Begin authenticator setup. Add the displayed QR code or setup secret to your authenticator app.",
        "Confirm that you added the account, enter the current six-digit Authenticator code, and choose Verify and enable MFA before the setup expires.",
        "Use Copy recovery codes and save the codes privately when they are shown. They are not saved to a file automatically. Each recovery code can be used once when your authenticator is unavailable; do not include these codes in screenshots or issue reports.",
        "On later sign-ins, enter your current authenticator code. Use a recovery code instead switches to a single-use recovery code when necessary.",
        "If you cancel or the challenge expires, return to sign-in and start again. A cancelled setup or failed verification does not finish sign-in.",
      ]),
      p("When verification is enabled, the account card shows how many recovery codes remain. Replace recovery codes requires a fresh authenticator code or an unused recovery code; after replacement, all previous recovery codes stop working. Save the new set before leaving the dialog."),
      p("Turn off verification appears only when your organization's policy allows it. Confirm with an authenticator or recovery code; successful removal signs you out. Organization-required verification cannot be turned off here."),
      p("If you lose both the authenticator and all unused recovery codes, contact your administrator for the organization's verified recovery process. A new password does not remove the authenticator requirement. For identity-provider MFA, use that provider's recovery process."),
      note("tip", "Use the code currently shown for this workspace in your authenticator app. If it expires while you are typing, use the next code. Read the attempts, expiry, and any cooldown shown; wait for a cooldown to finish before trying again. If Security cannot load, choose Retry security settings. Keep setup keys and recovery codes out of shared documents, videos, and support attachments."),
      note("info", "SSO accounts manage voluntary authenticator setup in their identity-provider settings. Your identity provider may also require its own verification during SSO. Follow the provider's screen for that check; these instructions describe Aperture Chat's authenticator screens."),
    ],
  },
  {
    id: "layout",
    part: "basics",
    minRole: "user",
    title: "Finding your way around",
    summary: "The sidebar, the main area, and what each navigation button opens.",
    blocks: [
      p(
        "The screen has two areas: a sidebar on the left and the main work area on the right. The sidebar is how you move between the platform's views and your saved chats.",
      ),
      sub("Your first visit"),
      p("The Getting started card explains what is ready for your account and what comes next. Open quick-start guide opens user help. Administrators see Open admin guide and Manage access. Follow the setup action offered for your role when no model is available. A missing model is an access or setup task, not a successful chat connection."),
      p("Choose a guide, take the suggested action, or select I'll explore on my own (or Dismiss welcome) when you are ready. Simply loading the page does not dismiss this card. You can return to guides from Help or console Documentation later."),
      table(
        ["Sidebar button", "What it opens"],
        [
          ["New chat", "A fresh conversation with your workspace assistant. This is the default view."],
          ["Search", "Search past work for chats (including archived), documents and decks, agents, and indexed documents, plus commands. Shortcut: Ctrl+K (Windows) or ⌘K (Mac)."],
          ["Drafts", "A document and slide-deck editor with an AI assistant beside it."],
          ["Agents", "Reusable agent profiles, plus an Automations tab for scheduled runs."],
          ["Library", "Two tabs: Knowledge (searchable document collections) and Tools (connections, prompts, and skills)."],
        ],
      ),
      p(
        "Below the navigation buttons, your chat history is always listed under a small CHATS heading — folders first, then pinned chats, then recent chats. The next section covers organizing them.",
      ),
      sub("Resizing and collapsing the sidebar"),
      list([
        "Click the small chevron (‹) near the top of the sidebar to collapse it and give your work more room. Click the chevron again (›) to bring it back.",
        "Drag the sidebar's right edge to make it wider or narrower. Double-click that edge to collapse it.",
        "On a narrow window or a phone, the sidebar hides behind a menu button (three stacked lines, ☰) in the top-left corner. Tap it to open the menu; tap the dimmed area to close it.",
      ]),
      sub("Using the keyboard"),
      p("Use Tab and Shift+Tab to move between controls and Enter or Space to activate the focused control. In a dialog, keyboard focus stays with that dialog. Use its Close or Cancel button, or Escape when available, to return to the control that opened it. Confirmations explain when an action is permanent before you commit it."),
      sub("The bottom of the sidebar"),
      list([
        "Admin console and Platform console — links shown only to administrators and platform owners (see “Where the consoles live”). Platform owners may also see a Release available notice here.",
        "Help — opens the guided walkthrough videos and this downloadable guide.",
        "Dark mode / Light mode and Theme schedule — two small buttons beside Help: the moon or sun switches the appearance instantly, and the clock sets a schedule (see “Light and dark mode” later in this guide).",
        "Install app — appears on phones and tablets, and adds the workspace to your home screen (see “Install the app on your phone”).",
        "Your account card — your initials or photo, name, and role. Click it to open the account drawer, including Personalization memory when your organization has enabled it.",
      ]),
      sub("Where the consoles live"),
      p(
        "Administrators choose Admin console near the bottom of the sidebar; platform owners also see Platform console. The account drawer's Management section lists the same consoles. Regular users see neither. The account drawer also holds View as role previews, Usage this month, and your Archived chats — all covered in “Your account”.",
      ),
      sub("Returning to a view"),
      p("The browser address follows the workspace view and console tab. Browser Back and Forward return to those views; opening a saved chat or draft link still checks your account's access. A link does not share private content or grant permission to another person."),
    ],
  },
  {
    id: "organize",
    part: "basics",
    minRole: "user",
    title: "Organizing chats: folders, pins, and the chat menu",
    summary: "Keep the chats you care about easy to find.",
    blocks: [
      p(
        "Your chat history is always visible under the CHATS heading: folders first, then a Pinned group when something is pinned, then your recent chats (labeled Recent only when a group sits above them). Click the CHATS heading to hide or show the whole list; this is remembered for your account on this device. While hidden, it shows a count and a dot for unread replies, and Search still finds every chat.",
      ),
      sub("Folders"),
      steps([
        "Click the folder icon with a plus sign next to the CHATS heading.",
        "Type a name for the folder — a client, a matter, a project — and click Create.",
        "To file a chat into a folder, hover or focus its row, click the ⋯ (More actions) button, and choose Move to folder. Pick a folder, choose New folder to create one right there, or choose Remove from folder to take it out.",
        "Click a folder to expand or collapse the chats inside it.",
      ]),
      note("info", "Deleting a folder does not delete its chats — they move back to the Recent list."),
      sub("Pinned chats"),
      steps([
        "Hover or focus any chat row, click ⋯ (More actions), and choose Pin chat.",
        "The chat moves to the Pinned group, just below your folders, where it stays until you choose Unpin chat from the same menu.",
      ]),
      sub("Recent chats"),
      list([
        "Recent chats — below folders and pinned chats — list your latest conversations. Click one to reopen it exactly where you left off.",
        "Hover or focus a row to reveal its ⋯ (More actions) button. The menu offers Pin chat (or Unpin chat), Move to folder, and Archive.",
        "A dot beside a chat marks a newest assistant reply you have not opened. Read status is saved to your account, so it matches in every browser and device.",
        "Archiving moves a chat out of the sidebar without deleting it — use it to tidy up. Archived chats are listed in your account drawer, where you can restore or permanently delete them.",
        "Click View all chats at the bottom of the list to browse your full history, including everything that no longer fits in the sidebar.",
      ]),
    ],
  },
  {
    id: "search-everything",
    part: "basics",
    minRole: "user",
    title: "Searching everything",
    summary: "Find saved work, preview a result, or run an available command.",
    blocks: [
      steps([
        "Click Search near the top of the sidebar, just below New chat, or press Ctrl+K (Windows) or ⌘K (Mac) from anywhere.",
        "The Search past work box opens. Type a few words from what you remember: a chat title, message text, an agent or draft name, slide text, or text from an indexed document.",
        "Results are grouped by kind. Chat results lead, matching text is highlighted, and archived conversations are labeled explicitly. Saved documents and decks open in their matching editor.",
        "Hover over or keyboard-focus a supported chat or draft result to preview it. The chat row also offers folder, pin, and archive or restore actions when that conversation is available in the current workspace.",
        "Click a result to open it, or use Up and Down followed by Enter. Escape closes search. Recently opened results are available when the query is empty.",
      ]),
      sub("Commands and saved work"),
      p("Commands appear in a separate section from search results. Type > at the start of this search box to see all commands available to your role and permissions, then keep typing to narrow them. Commands can open workspace views and permitted actions; an unavailable feature does not become accessible through search. The same > symbol inside a chat message has a different purpose: choosing an automation for that message."),
      note(
        "info",
        "Search includes only work your account can access. If the panel says Indexing your workspace, results may be incomplete until indexing finishes; try again after it completes. A missing result is not proof the work was deleted. Unsaved device-only changes may need saving to your account before server search can find them.",
      ),
    ],
  },

  /* ------------------------------------------------------------------ chat */
  {
    id: "chat-basics",
    part: "chat",
    minRole: "user",
    title: "Your first chat",
    summary: "Send a message, pick a model, and control web search.",
    blocks: [
      steps([
        "Click New chat in the sidebar. A fresh chat greets you by the time of day — “Good morning”, “Good afternoon”, or “Good evening” with your first name (late at night it asks if you are burning the midnight oil) — above the tagline “Your approved models, your sources, your guardrails — ask Aperture Chat anything.” (The name reflects your organization's branding.)",
        "Click into the message box (the composer) — it reads Ask anything... — and type your question.",
        "Explore an idea, Compare options, and Draft a message offer starting points. Selecting one fills an editable prompt; review it before sending.",
        "Press Enter to send. Press Shift+Enter when you want a new line without sending.",
      ]),
      sub("Picking the model"),
      p(
        "The model selector sits in the top bar of every chat. Click it to choose which AI model answers this conversation. Each chat remembers its own choice, and the list only ever shows models your workspace has approved for you.",
      ),
      p("Use the arrow keys, Home, End, or type a model name to move through available models; Enter selects the highlighted model. Each row has its own star: Set [model name] as default model selects that model and remembers it for new chats. The filled star marks the single current default. Selecting a row without its star changes this conversation's model without changing the default. Drafts has a separate default drafting model, set with the star beside a row in its own selector."),
      sub("Web search and the active-tools chip"),
      list([
        "When the selected model supports it, public web search starts turned on. A chip at the bottom of the composer shows what is active: with one tool on it names it — for example Web search — and with several on it reads Tools with a count.",
        "Click the small × on that chip to clear the next message's active tools: Knowledge, Web, and Agent, selected MCP connections, and queued automations. Every new chat starts with web search on again when the model supports it.",
        "Replies that used the web come back with citations you can click, and every source is listed in the session details panel (covered below).",
      ]),
      sub("Sending"),
      list([
        "The paper-plane button sends your message with the current settings.",
        "The chevron (˅) beside it opens send options — per-reply switches for Knowledge, Web, and Agent, plus the Reasoning level (covered in their own section).",
      ]),
      sub("Dictate instead of typing"),
      list([
        "Click the microphone button in the send controls at the bottom-right of the composer to start dictating. A live waveform shows that the platform is hearing you.",
        "Click the button again — it becomes a stop square — and your words are transcribed and inserted into the composer as editable text. Nothing sends until you press Enter.",
        "If the microphone is blocked or no speech was heard, the composer says so plainly so you can fix the problem and try again. The Drafts workspace has the same dictation button for drafting instructions.",
      ]),
    ],
  },
  {
    id: "model-access-requests",
    part: "chat",
    minRole: "user",
    title: "Understand model availability and request access",
    summary: "Read the server's reason, ask for a model when permitted, and follow its request status.",
    blocks: [
      steps([
        "Open the chat model selector and choose Why isn't a model listed? If no model is usable, the No models available control opens the same explanation.",
        "Models in your organization separates Usable now from Not available to you. Read the reason on the model row: Locked describes an access restriction; Provider offline means you already have access but the provider needs attention.",
        "Choose Request access only where it is enabled. The request goes to an administrator for review; sending it does not grant immediate access.",
        "While a request is pending, the row shows its date and Withdraw request. Use Refresh model access after your administrator resolves it, then select the usable model in the chat picker.",
      ]),
      note("info", "Your organization may show only models you can already use. Its browsing policy controls whether you can inspect other enabled models and request access. Some restrictions cannot be lifted by a request; ask your administrator about the stated reason. An offline provider needs a platform-owner repair, not another group-access request."),
    ],
  },
  {
    id: "replies",
    part: "chat",
    minRole: "user",
    title: "Reading and acting on replies",
    summary: "The work trace, citations, and the actions under every message.",
    blocks: [
      sub("The work trace"),
      list([
        "While a reply is being produced, a single status line shows the current step, a live timer, and how many steps remain (for example “4s · step 2 of 5”).",
        "Click that line at any time — while running or after — to expand the full trace: which model was routed, what context was prepared, whether web search ran, and how the answer was finalized.",
        "While a reply is still streaming, a stop button appears — its label is Stop this response. Clicking it halts the reply and keeps the conversation.",
      ]),
      sub("Actions under each response"),
      list([
        "Copy — copies the response as clean, readable text.",
        "Thumbs up / thumbs down — sends feedback your administrators can review.",
        "Branch — starts a new chat that continues from that response, leaving the original untouched.",
        "Regenerate response — asks the model to answer the same prompt again. Version arrows appear on the response with a counter (for example “2 / 3”) so you can flip between the versions it has produced.",
        "Transfer to Drafts — turns the response into an editable document in the Drafts workspace, where you can format, version, and export it.",
      ]),
      sub("Actions under your own messages"),
      list([
        "Edit message — reopens your prompt for editing. Sending the edit removes the later replies and asks again from that point.",
        "Load prompt in new chat — copies the prompt and its attachments into a fresh chat's composer, ready to adjust and resend.",
      ]),
      sub("Diagrams in replies"),
      p(
        "When a reply contains a diagram (a flowchart, sequence, or similar), it renders as a real figure, not a code block. The figure's toolbar offers Copy for the diagram source, PNG and SVG to download it as an image file, and Code to flip between the drawing and its source text.",
      ),
      sub("Generated images"),
      list([
        "When the selected model can generate images, just ask for one — the finished images appear directly in the reply.",
        "Click Download under an image to save it as a file.",
      ]),
      sub("Citations and token usage"),
      list([
        "When a reply used the web or your knowledge bases, numbered citations appear with it. Click a citation to open the original source.",
        "A small token count appears under a reply only when the model provider actually reported one — the platform never shows an estimate dressed up as a real number.",
      ]),
    ],
  },
  {
    id: "symbols",
    part: "chat",
    minRole: "user",
    title: "Composer symbol shortcuts",
    summary: "Five characters that insert prompts, agents, knowledge, skills, and automations.",
    blocks: [
      p(
        "Start a word in the composer with one of five symbols and a menu opens with matching items. You can also choose Send options → Resources to browse without memorizing a symbol. The Reply settings tab's MCP connections and resources button opens the same resource browser.",
      ),
      table(
        ["Type", "What it opens"],
        [
          ["/", "Your saved prompts and enabled MCP connections."],
          ["@", "Agent profiles — the reply routes through the one you pick."],
          ["#", "Knowledge bases and the files inside them, to ground your question."],
          ["$", "Saved skill files, inserted into the message."],
          [">", "Automations — the one you pick queues and runs when you send."],
        ],
      ),
      steps([
        "Type the symbol, then keep typing to filter the list.",
        "Use the ↑ and ↓ arrow keys to move through the menu.",
        "Press Enter to insert the highlighted item, Tab to complete it, or Escape to dismiss the menu.",
      ]),
      sub("Browse resources"),
      p("On the Resources tab, use Find a resource to search by name, or select All, Knowledge bases, Files in knowledge sources, MCP connections, Prompts, Agents, Skill files, or Automations. A selected connection or automation shows a check; choose it again to remove it. Read an empty or failed-loading state before retrying. The Type shortcuts in chat reference explains each symbol below the results."),
      note("tip", "The expanded composer focuses on editing a longer message. Return to the normal composer to browse resources, adjust send options, and send with the visible controls."),
    ],
  },
  {
    id: "attachments",
    part: "chat",
    minRole: "user",
    title: "Attaching files, web pages, and connected sources",
    summary: "Upload from your computer, fetch a page by link, or pull from your organization's drives.",
    blocks: [
      steps([
        "Click the paperclip button at the bottom-left of the composer.",
        "Click Upload from computer to attach files from this device. The model reads them as context for your next message.",
        "Or click Web page by link and paste one or more web addresses — the platform fetches up to 3 public pages and attaches them as cited sources for this message.",
        "Attached items appear as chips above the composer. Click the × on a chip to remove one before sending.",
      ]),
      sub("Attach from source"),
      p(
        "Below those options, under the Attach from source heading, the menu lists your organization's workspace sources: Google Drive, OneDrive, SharePoint, Box, and iManage. Availability depends on the service team's connector setup and your own source-account access.",
      ),
      sub("Connecting your own account"),
      list([
        "Cloud sources read from your own account. The first time you pick one, the picker may ask you to connect it — click the Connect button for that source and a sign-in window opens.",
        "Approve read access in that window. The file list refreshes on its own once access is granted, and only you can see files from your account.",
        "The picker shows files at the top level of the drive or the folder configured for the source, within your account's permissions.",
      ]),
      note(
        "info",
        "If a source needs shared configuration, ask your administrator to coordinate with the service team. Shared connector administration is managed outside tenant administration. Your own Connect action in the attach menu remains separate and grants access only through your source account.",
      ),
    ],
  },
  {
    id: "send-options",
    part: "chat",
    minRole: "user",
    title: "Send options: Knowledge, Web, Agent, and Reasoning",
    summary: "Control what the model may use, one reply at a time.",
    blocks: [
      steps([
        "Click the chevron (˅) beside the paper-plane send button.",
        "The menu opens with Send now at the top — that simply sends with the current settings.",
        "Below it are three switches you can turn on or off for the next reply, and a Reasoning slider at the bottom.",
      ]),
      table(
        ["Switch", "What it does when on"],
        [
          ["Knowledge", "The reply searches your enabled knowledge bases and cites what it finds, with links back to the sources. A picker lets you choose which bases to use."],
          ["Web", "The reply uses public web search. Results come back as clickable citations, and the sources are listed in session details. Available when the selected model supports it."],
          ["Agent", "The reply uses the selected agent profile and its permitted tools. Turning this on can choose the first available profile if none is selected; confirm the Agent profile field before sending, or choose a profile with @."],
        ],
      ),
      sub("Reasoning level"),
      p(
        "The Reasoning group at the bottom of the menu is a three-position slider from Fast to Smart. Fast favors quicker answers; Smart makes the model think longer for more detailed output; the middle is a balanced default. The slider is only active when the selected model supports reasoning levels — otherwise it is disabled and says so.",
      ),
      p(
        "Whenever tools are on, the active-tools chip appears next to the paperclip: the single tool's name, or Tools with a count. Click its × to turn off Knowledge, Web, and Agent and clear selected MCP connections and queued automations for the next message.",
      ),
      p("On the Reply settings tab, Stream replies controls whether text appears as the model produces it or only after the reply finishes. The Resources tab opens the searchable resource picker; MCP connections and resources also opens it from Reply settings. These controls change how the next reply is prepared or displayed; they do not supply missing provider or connector access."),
    ],
  },
  {
    id: "session-details",
    part: "chat",
    minRole: "user",
    title: "Session details and sources",
    summary: "Real token usage, active tools, and every source this chat gathered.",
    blocks: [
      steps([
        "Click the round information button (ⓘ) at the right end of the chat's top bar.",
        "The session details panel opens for the current chat.",
      ]),
      list([
        "Current chat and Model — the user-message and response counts, and which model is active.",
        "Tokens used — shown only when the model provider reported real numbers. Otherwise the panel says “Not reported by the provider”.",
        "Tools — exactly what is switched on for your next message: web search, knowledge, agent mode, plus any automations or MCP connections you added in the composer. “Off” means nothing is active.",
        "Sources gathered — every web source (as clickable links) and workspace citation collected during this conversation.",
      ]),
      p("The Context window meter describes how much context this conversation uses. For older conversations without provider counts it can show ≈ and estimated from message length. Treat that as an estimate; Tokens used remains based on actual provider reports. When the context window fills, start a new chat and include the details it needs to continue reliably."),
    ],
  },

  /* ------------------------------------------------------------- workspace */
  {
    id: "drafts",
    part: "workspace",
    minRole: "user",
    title: "Drafting documents",
    summary: "Generate, edit, version, and export documents with the drafting assistant.",
    blocks: [
      p(
        "Click Drafts in the sidebar. The view pairs a full document editor with an AI assistant rail on the left that writes into the editor for you. A Draft format switch at the top of the editor has two buttons — Document and Deck. This section covers document mode; “Building a slide deck” covers deck mode.",
      ),
      note("info", "If the model selector says No models connected, AI drafting, AI rename, inline AI edits, and AI deck prompts are unavailable. You can still edit manually, import, save, use document history, and export. Follow the setup guidance for your role or ask your administrator for access to a working model."),
      sub("Generating a draft"),
      steps([
        "Look at the Sources, Web, and Templates chips at the top of the assistant rail first: they show which context is on before you generate anything.",
        "In the assistant's message box, describe the document you need: a memo, an engagement letter, a summary. Be specific about audience and tone if it matters. The suggested requests under the heading fill the box for you.",
        "The assistant writes the document directly into the editor. You can also send any chat response here with Transfer to Drafts.",
        "Use the model selector in the toolbar area to choose which approved model writes and edits this draft.",
      ]),
      sub("Editing like a document"),
      p(
        "The main toolbar keeps undo and redo, block style, bold, italic, underline, and inline AI editing close at hand. Text opens font, size, advanced styles, color, highlighting, and Clear formatting. Paragraph opens alignment, lists, and quotes. More opens Copy document and the AI edit trail. Select the intended text before opening a panel; Escape returns to the editor.",
      ),
      list([
        "The plus (+) Insert button opens links and citations alongside Web image, Chart, Table, Divider, and Page break. A manual page break starts a new page at your cursor; the editor also paginates longer documents automatically.",
        "Selecting text shows a floating toolbar beside it with Ask AI, block style, bold, italic, underline, strikethrough, link, and highlight.",
        "Type / at the start of a line for the command menu: AI actions such as Continue writing and Summarize the document, headings, lists, quotes, a table, a divider, a page break, a web image, or today's date. Keep typing to filter and press Enter to insert.",
        "Typing shortcuts format as you go: start a line with “#”, “##”, or “###” and a space for a title, heading, or subheading; “-” or “1.” for a list; or “>” for a quote. Type “---” and press Enter for a divider, and wrap words in “**”, “*”, or “`” for bold, italic, or code.",
        "Click inside a table to insert or delete rows and columns, turn the header row on or off, or delete the table. Click a picture to set its size (Small, Half, Large, or Full width), alignment, and alt text, or to delete it.",
        "Pasting from Word, Google Docs, or a web page keeps headings, lists, tables, links, pictures, and emphasis but drops the source's fonts, sizes, and colors so the text matches your document. Ctrl+Shift+V (⌘⇧V on a Mac) pastes plain text.",
      ]),
      sub("Editing with AI"),
      steps([
        "Select a passage and choose Ask AI in the floating toolbar, or press Ctrl+J (⌘J on a Mac). With nothing selected, the same command writes new text at the cursor.",
        "Pick an action — Improve writing, Fix spelling & grammar, Make shorter, Make longer, Simplify language, Turn into a bulleted list, Turn into a table, Summarize, or Use active voice — or a tone or language, or type your own instruction.",
        "Review the suggestion. Changes marks what was added and removed; Result shows the finished text. Nothing in the document changes yet.",
        "Choose Replace, Insert below, Try again, or Discard. To adjust the suggestion instead, type a follow-up such as “shorter” or “add a number” in the box underneath.",
      ]),
      p("An accepted AI edit stays highlighted briefly and is recorded with the document; More → AI edit trail highlights the recorded edits again so you can review what changed."),
      sub("Revise the document you already have"),
      p("Describe the change in the assistant: shorten a section, change tone, apply a template, or transform the existing paper. Revision requests work from the current document. Ask explicitly to start over, replace, or clear it when that is your intention. The editor keeps instructions separate from the deliverable; review the resulting document and use Undo or a saved version when a change needs correction."),
      p("For an existing paper, Assistant settings → Apply MLA layout applies double-spaced 12-point Times New Roman, a student heading, centered title, body and reference indents, and a separate Works Cited page without asking a model. It preserves the paper's text and supports Undo. Fill missing student details and verify quotations and sources yourself; formatting is not citation verification."),
      p("The page navigator shows the current sheet and total pages outside the document text. Older drafts are paginated when opened, and manual edits reflow after you leave the editor. Page labels do not become part of the exported body."),
      sub("Status bar, outline, find, and zoom"),
      list([
        "The status bar under the page shows the current page, word and character counts, and reading time. When text is selected, it counts the selected words too.",
        "Outline lists the document's headings; select one to jump to that section.",
        "Find (Ctrl+F, or ⌘F on a Mac) searches the document, with Match case and whole-word options. Find and replace (Ctrl+H, or ⌘⇧H on a Mac) replaces one match at a time or all of them.",
        "The keyboard button lists every editor shortcut (Ctrl+/, or ⌘/ on a Mac). The zoom controls resize the page on screen from 50% to 200% without changing the document or its exports.",
      ]),
      sub("Versions and comparing"),
      list([
        "Click Save version whenever the draft reaches a good state. You can restore an earlier version at any time from the draft's history.",
        "Compare versions opens a read-only visual redline of two saved versions, so you can see exactly what changed between them. It needs two genuinely different saved versions before it activates.",
        "Open Document history to browse saved documents and decks. Hover or keyboard-focus an entry for a preview. Archive moves finished work into Archived, where Unarchive restores it; Delete requires confirmation and permanently removes the saved item and revisions.",
        "Read the save status: account-backed documents and decks can be reopened after sign-in on another device. A pending or failed save stays a working copy in this browser. If the account version changed elsewhere, resolve the reported conflict before treating the save as complete.",
      ]),
      sub("Leaving with unsaved changes"),
      p("When you leave an edited draft through workspace navigation, open another chat or draft, or choose Sign out, the unsaved-changes dialog lets you Keep editing, Save copy and continue, or Discard and continue. The saved copy goes into local document history in this browser. If browser storage fails, the app keeps you in the draft so you can recover it. A forced security sign-out can still interrupt work; save important changes regularly."),
      sub("Exporting"),
      list([
        "Click Export to open the export panel. In document mode it offers a Word document (an editable Word file with preview page breaks and embedded images), Markdown (best for plain text or web publishing), and Print / Save as PDF, which opens your browser's print dialog with the saved version — choose “Save as PDF” there to keep a PDF copy.",
        "Exports always run from a saved version. If you have unsaved edits, the panel says Save your edits first and offers a one-click Save version and export (or Save version and print) button.",
        "When your browser supports it, choose Choose a location to select a destination, or Browser downloads to use its download folder. Word and print retain document formatting; Markdown preserves the text without its typography. Exporting a file does not by itself upload pending work to your account.",
      ]),
      note(
        "tip",
        "On a narrow window, the assistant rail becomes a slide-out drawer so the editor gets the full screen. Open it with the pen tab on the left edge or Ctrl+. (⌘. on a Mac); resting the mouse on that edge previews it. Press Escape or click the dimmed area to close it.",
      ),
    ],
  },
  {
    id: "slide-decks",
    part: "workspace",
    minRole: "user",
    title: "Building a slide deck",
    summary: "Turn a draft into slides, edit them, brand them, and export real PowerPoint.",
    blocks: [
      p(
        "Deck mode turns the Drafts workspace into a slide editor with a real PowerPoint export. Click the Deck button on the Draft format switch. If the draft already has document content, a dialog asks “Turn this draft into slides?” — choose Start a blank deck to keep the document untouched, or Convert into slides to split its headings and text into slides. Your document versions are kept either way.",
      ),
      sub("The filmstrip"),
      list([
        "Slide thumbnails run along the side. Click one to select it, or drag it to reorder the deck.",
        "Hover a thumbnail for its actions: move up, move down, duplicate, and delete (undo restores a deleted slide).",
        "Add slide at the end of the filmstrip opens the layout menu for a new slide.",
        "Slide sorter, at the right of the deck toolbar, lays every slide out in a grid. Drag to reorder, double-click a slide to edit it, and use each slide's duplicate and delete buttons.",
      ]),
      sub("Slide layouts"),
      p(
        "Above the slide, Layouts previews seven arrangements: Title, Title + bullets, Two columns, Image + caption, Section, Quote, and Closing. Select one to switch the selected slide; the layout button on the slide and in the toolbar opens the same choices. Themes offers five color palettes — Aperture, Midnight, Editorial, Violet, and Forest; a palette change recolors every slide, keeps text, media, and layout, and can be undone.",
      ),
      sub("Editing slide text"),
      list([
        "Click any text region on a slide to edit it in place. The deck toolbar carries undo and redo, bold, italic, underline, and Text for font, size, and color; More copies the deck outline or lists the keyboard shortcuts.",
        "Drag a text box by its frame to move it. Guides snap it to the slide's edges and center and to other boxes; arrow keys nudge the selected box (Shift moves ten times as far).",
        "Inside bullet lists, press Tab to indent a bullet one level and Shift+Tab to outdent it.",
      ]),
      sub("Editing slides with AI"),
      list([
        "Edit slide with AI (the AI pen in the deck toolbar, or Ctrl+J / ⌘J) reworks the whole slide: Improve this slide, Make it punchier, Cut the text in half, Write speaker notes, Pick a better layout, Split into two slides, Fix spelling & grammar, a tone or language, or your own instruction.",
        "The review shows the slide before and after, plus any new speaker notes. Choose Apply to slide, Try again, or Discard; undo restores the previous slide.",
        "To rewrite only part of a slide, highlight the text and choose Ask AI, then review the suggestion before replacing it.",
      ]),
      sub("Starter templates and your brand template"),
      list([
        "Deck starters & brand themes, above the slide (or the Templates chip in the assistant rail), opens the templates panel with five starter structures: Pitch deck, Quarterly review, Project kickoff, Client proposal, and Training session. Pick one and start it to get scaffold slides you replace.",
        "A Use templates in chat toggle (off by default) lets the selected template guide the deck assistant when it drafts for you.",
        "Upload brand template accepts your firm's own file — “.pptx or .potx — brand colors, fonts, logo, and every slide's text are extracted.” The extracted theme is stored only on this device.",
        "Once a brand theme is loaded, Apply to deck restyles the current deck with its colors, fonts, and logo, and a “Load all N slides” button can replace the deck with every slide from the uploaded template.",
      ]),
      sub("Backgrounds and AI images"),
      list([
        "The background button in the toolbar opens a per-slide menu: Upload background… (a PNG, JPEG, or WebP from this device), Use on every slide, Remove from this slide, and Clear from all slides.",
        "Generate AI slide image writes an image prompt for you, prefilled from the slide's content; press Generate image and the result becomes that slide's background. This needs an image-generation model enabled for your workspace — the button says so honestly when none is.",
        "In the assistant rail, Toggle AI slide images makes the assistant also generate an image for every slide whenever it drafts a deck.",
      ]),
      sub("Speaker notes"),
      p(
        "Every slide has a Speaker notes field below the stage. Notes export with the deck: they land in each slide's notes pane in the PowerPoint file, they appear in the Markdown outline, and they follow you into presentation mode.",
      ),
      sub("Presenting from Aperture"),
      steps([
        "Click Present deck in the deck toolbar (the monitor icon), or press F5 (⌘Enter on a Mac); add Shift to start from the current slide. The deck opens full screen.",
        "Advance by clicking the slide or with the arrow keys or Space; move back with the left arrow. Type a slide number and press Enter to jump to it.",
        "The Notes button (or N) shows your speaker notes under the slide. Presenter view (or P) shows the current slide, the next slide, a timer you can pause or reset, and your notes side by side.",
        "Press B or W to black or white out the screen; press it again to return. Leave with Escape or the Exit button in the top corner.",
      ]),
      sub("Saving and exporting"),
      list([
        "Save version stores decks to your account with revision history, like documents. Read the status to confirm the save reached the server. A local working copy or pending save remains only in this browser until synchronization succeeds; use the Only on this device reminder to find unfinished saves.",
        "Document history includes decks. Preview, reopen, archive, unarchive, and confirmed deletion use the same account controls as documents. A concurrent account edit can prevent a stale save or deletion; read the conflict message before retrying.",
        "Click Export to open the Export deck panel: PowerPoint deck produces an editable .pptx that mirrors the slides on screen — speaker notes included in each slide\u2019s notes pane — and Markdown outline exports slide titles, bullets, and speaker notes as text.",
        "Limits: a deck holds up to 100 slides and 8 MB of content. The editor tells you plainly if a deck exceeds them.",
      ]),
    ],
  },
  {
    id: "unsynced-work",
    part: "workspace",
    minRole: "user",
    title: "Recover work kept only on this device",
    summary: "Distinguish a browser working copy from a completed account save.",
    blocks: [
      p("The sidebar's Only on this device reminder appears when work has changes kept in this browser that have not reached your account. It can include chats whose last save failed, documents or decks with unsent changes, and older history from before account sync."),
      steps([
        "Open the reminder to review the named items. For chats whose last save failed, choose Retry all and check the resulting save state.",
        "For documents and decks, choose Open Drafts, open the item, and save it to your account. Review any load, quota, connection, or conflict error before leaving the browser.",
        "Older browser history remains separate until you explicitly import each item from Drafts → Document history with Import to my account. Confirm the item belongs in this account before importing.",
        "Archive finished drafts when you want them out of the active list. Account archives remain recoverable; archiving a browser-only item does not prove it has been uploaded.",
      ]),
      note("info", "Clear list dismisses these reminders without deleting or uploading work. New edits may appear again. Hide this reminder turns off this account's sidebar notice in this browser; save status remains in Drafts and chats. Downloading an export also leaves pending account saves to be resolved."),
    ],
  },
  {
    id: "agents",
    part: "workspace",
    minRole: "user",
    title: "Agent profiles",
    summary: "Reusable bundles of model, prompts, knowledge, and tools.",
    blocks: [
      p(
        "An agent profile bundles a model route, meta prompts, knowledge bases, and MCP tools into one reusable configuration. A usable profile needs an approved, enabled model backed by a working provider. A saved profile marked not connected is a configuration example, not proof that it can run.",
      ),
      sub("Creating an agent"),
      steps([
        "If your account has agent authoring permission, click Agents in the sidebar, then New Agent.",
        "Give it a name and a short description of what it is for.",
        "Work through the editor tabs: Profile (name, model, and description), Knowledge (assign knowledge bases), Tools (select MCP tools), Prompts & Skills (attach system prompts and skill files), Access (who can use it), and Hermes (the optional learning companion).",
        "Click the save button. Standard users create private profiles; administrators control group sharing and organization publishing. Check model readiness and access before trying the profile in chat.",
      ]),
      sub("Using an agent in chat"),
      list([
        "Type @ in the composer and pick an available profile to use its configured model route, instructions, knowledge, and tools.",
        "The Agent switch in Send options can choose the first available profile when none is selected. Check Agent profile and select the intended configuration before sending.",
        "If no profiles appear, ask your administrator to check that a ready profile is available to your account.",
      ]),
      p(
        "From the Agents view you can also open a profile to edit it, jump straight into a chat with it, or delete it. The Automations tab at the top of this view holds your scheduled runs — covered in “Scheduled automations”.",
      ),
    ],
  },

  /* -------------------------------------------------------------- toolsauto */
  {
    id: "knowledge",
    part: "toolsauto",
    minRole: "user",
    title: "Knowledge bases",
    summary: "Give chats grounded, citable access to your documents, web pages, and APIs.",
    blocks: [
      p(
        "Knowledge lives in the Library: click Library in the sidebar, then the Knowledge tab. The Knowledge Bases panel lists every collection with its status, security posture, and whether it is enabled.",
      ),
      steps([
        "Click Add Knowledge Base and name the collection.",
        "Choose what feeds it. A knowledge base can index documents you upload, a public web page (Add a web link — enter the address and an optional note), or an API (Connect an API — enter the endpoint and its authentication).",
        "Create the base, then check its row in the table: it shows the status, the security posture, and whether the base is enabled.",
      ]),
      note(
        "info",
        "Only enabled knowledge bases can be searched from chat, and access control is enforced per source — people only ever retrieve what they are allowed to see.",
      ),
      sub("Using knowledge in a conversation"),
      list([
        "Type # in the composer to reference a knowledge source or choose from Files in knowledge sources. A file choice references its name in your prompt and searches that file's knowledge source; the row says which source will be searched.",
        "Or turn on the Knowledge switch in send options to let the reply search your enabled bases.",
        "Replies grounded in knowledge return citations that link straight back to the source documents.",
      ]),
      note("info", "The # shortcut menu shows Loading files… while retrieving file choices. If Some files could not be loaded appears, use Retry in that menu. Files from sources that loaded successfully remain usable. If access was removed or a source needs configuration, ask your administrator to resolve it."),
    ],
  },
  {
    id: "tools",
    part: "toolsauto",
    minRole: "user",
    title: "The Tools library",
    summary: "MCP connections, saved prompts, and skill files inside the Library.",
    blocks: [
      p(
        "Click Library in the sidebar, then the Tools tab. The Tools Library and Connectors panel has three sections:",
      ),
      table(
        ["Tab", "What lives there", "Where it appears in chat"],
        [
          ["Connections", "MCP tools and connections available to models and agents.", "Type / in the composer."],
          ["Prompts", "Saved prompt templates, including {{variables}} you fill in when using them.", "Type / in the composer."],
          ["Skills", "Skill files — reusable instructions for recurring workflows.", "Type $ in the composer."],
        ],
      ),
      list([
        "Click New Prompt or New Skill to create one: give it a name, a category, a description, and the content itself, then save.",
        "Click any existing card to review or edit it; the trash icon deletes it permanently.",
        "Every tool row shows its real status — draft, approval required, or enabled — so you always know whether a connection is actually live before relying on it.",
      ]),
    ],
  },
  {
    id: "automations",
    part: "toolsauto",
    minRole: "user",
    title: "Scheduled automations",
    summary: "Recurring chat or drafting runs, as one model call or a multi-step chain.",
    blocks: [
      p(
        "Automations are saved workflows that run a chat or drafting task on a schedule. They are useful for recurring digests, weekly status checks, report refreshes, policy reviews, and any workflow where the same model chain should run the same way each time. Enabled schedules run automatically in the background (times are UTC), and each scheduled run delivers its output as a new chat thread in your sidebar.",
      ),
      sub("Creating an automation"),
      steps([
        "Click Agents in the sidebar, then the Automations tab, then New automation.",
        "Name it — for example “Monday client digest”.",
        "Choose what it runs against: chat or draft.",
        "Pick a trigger: Daily (a time each day), Weekly (a day and time), Once (a specific date and time), or Cron expression (such as 0 9 * * 1 for 9:00 every Monday, in UTC).",
        "Write the initial input — what the first step should work on.",
        "Build the model chain: each step has a model and an instruction, and each step's output feeds into the next step. Use Add step for multi-step chains and the × to remove a step.",
        "Click Save automation.",
      ]),
      sub("What to check before saving"),
      list([
        "Models — every step must use a model you can actually access. If a model is missing, your admin may need to approve it for your group.",
        "Context — write the initial input as if the automation will run without you watching. Include the matter, audience, date range, source expectations, and desired output format.",
        "Cadence — use Once for a single future run, Daily or Weekly for regular recurring work, or a reviewed Cron expression for another schedule. All times are UTC; check the intended local-time equivalent before saving.",
        "Ownership — name the automation so another person can tell what it does later.",
      ]),
      sub("Running and managing"),
      list([
        "Each automation card shows its schedule, its steps, and its last run with an honest result — succeeded or failed, with the reason.",
        "Run now executes the whole chain immediately and shows a transcript of every step's output.",
        "The toggle pauses or resumes the schedule; the pencil edits it; the trash deletes it.",
        "You can also queue an automation into any chat by typing > in the composer — it runs when you send.",
        "The list shows the automations you created. Organization administrators can review the automations in their workspace.",
      ]),
      note(
        "tip",
        "Always use Run now once after creating or editing an automation. If the run fails, the card shows the reason so you can fix the model choice, input, or instructions before depending on the saved schedule.",
      ),
    ],
  },

  /* ---------------------------------------------------------------- account */
  {
    id: "appearance",
    part: "account",
    minRole: "user",
    title: "Light and dark mode",
    summary: "Switch appearance now or schedule it for this browser.",
    blocks: [
      steps([
        "Find the moon or sun button beside Help near the bottom of the sidebar — a moon (Dark mode) while in light mode, a sun (Light mode) while in dark mode.",
        "Click it. The entire platform switches immediately — no reload, nothing to save.",
        "Click it again to switch back.",
      ]),
      sub("Schedule light and dark mode"),
      p("Choose the clock button beside it to open Theme schedule. Enable Switch automatically, set different Light mode at and Dark mode at times, then choose Save schedule. The schedule uses this device's local time every day and is saved in this browser. You can still switch manually until the next scheduled change; disable the switch to stop automatic changes."),
    ],
  },
  {
    id: "settings-account",
    part: "account",
    minRole: "user",
    title: "Your account",
    summary: "Your profile, personalization memory, password, role previews, usage, archives, and signing out.",
    blocks: [
      p(
        "Click your account card (your initials or photo) at the very bottom of the sidebar. The account drawer opens with everything about you in one place.",
      ),
      list([
        "Profile — click the card with your name and the pencil icon to edit your display name, firm, website, bio, phone number, and photo (upload an image up to 5 MB, or paste a URL). Click Save profile when done, or Cancel to discard.",
        "Management — administrators and platform owners see this section, listing the consoles they can open; the sidebar's Admin console and Platform console links go to the same places. Regular users do not have it.",
        "Personalization memory — opens your private memory manager when the feature is enabled. Use it to control, review, add, correct, pin, forget, or clear what the assistant remembers about you.",
        "Password — accounts that sign in with a password can change it here (click the pencil, enter the current password, then the new one twice — at least 12 characters). The app continues with a new authenticated session after saving and revokes previous sessions. Accounts that sign in through SSO manage their password with the SSO provider instead, and the panel says so.",
        "Security — choose Manage security to set up an authenticator for a local account, review the remaining recovery-code count, or replace codes after verifying your identity. Turning verification off is available only when organization policy permits it and signs you out. SSO accounts follow their identity-provider settings for voluntary enrollment.",
        "Role and organization — your role, your organization, any personal token caps that apply to you, and how you sign in.",
        "View as — if your role allows it, preview the workspace exactly as a lower role would see it. A note reminds you which role you are previewing; switch back the same way.",
        "Usage this month — your prompts, responses, and estimated tokens.",
        "Archived chats — every chat you have archived, with buttons to restore each one to your sidebar or delete it permanently.",
        "Sign out — ends your session and returns to the sign-in screen.",
      ]),
    ],
  },
  {
    id: "personalization-memory",
    part: "account",
    minRole: "user",
    title: "Personalization memory",
    summary: "Save and recall private preferences in plain English across chats and sessions.",
    blocks: [
      p(
        "Personalization memory belongs to your account, not to one conversation. When service policy and your organization administrator allow it, administrators and regular users can each build their own private memory. A saved item can influence a new chat immediately and still be available after you sign out and return in a later session.",
      ),
      sub("Save a memory in ordinary English"),
      steps([
        "In any chat, state what should persist in natural language — for example: “Remember that I prefer a short summary before the detail,” “Please remember that I work in commercial litigation,” or “Remember my project codename is Silver Horizon.”",
        "Send the message. The assistant confirms the memory after it is saved; you do not need a slash command or special syntax.",
        "Start a new chat, or return in a later sign-in session, and ask a natural question such as “What do you remember about me?”, “What are my writing preferences?”, or “What is my project codename?” The same account memory is available across those sessions.",
      ]),
      note(
        "info",
        "Memory is different from the context window shown in Session details. The context window describes how much of the current chat the selected model can hold at once; personalization memory is durable account context that follows you into other chats and sessions.",
      ),
      sub("Open and control the memory manager"),
      steps([
        "Click your account card — your name and role at the bottom-left of the sidebar.",
        "Click Personalization memory. The dialog titled “What the assistant remembers about you” opens.",
        "Use memory in my chats controls whether saved items are applied to answers. Learn from my conversations controls whether the assistant may notice durable preferences automatically. Turning a switch off does not expose or silently erase existing items.",
        "To add something directly, type it under Add something you want remembered, choose Standing instructions, Preferences, About you, Your work, or Other details, and click Add.",
        "Review the list below. Click a memory's wording to correct it; pin an important item; use Forget to remove one item; or choose Forget everything to clear the list.",
      ]),
      note(
        "info",
        "Only you can read your memory content. Administrators can see counts and purge memories for compliance, but the platform never shows them what an individual memory says.",
      ),
      note(
        "tip",
        "If Personalization memory is missing from your account drawer, the feature is not currently available at the platform, organization, or group level. Ask your administrator; refreshing the page cannot override that policy.",
      ),
      note(
        "warning",
        "Do not use memory as a password or secret vault. Credentials, keys, and sensitive identifiers are rejected on purpose.",
      ),
    ],
  },
  {
    id: "install-app",
    part: "account",
    minRole: "user",
    title: "Install the app on your phone",
    summary: "Put your workspace on the home screen with its own icon and name.",
    blocks: [
      p(
        "On a phone or tablet, tap Install app near the bottom of the sidebar. The “Add … to your home screen” dialog previews your organization's app name and icon.",
      ),
      list([
        "On Android, choose Install app if offered, then follow the native install sheet. Otherwise open your browser's menu and choose “Add to Home screen” or “Install app”.",
        "On iPhone and iPad, tap the browser's Share button, scroll the share sheet, choose “Add to Home Screen”, then tap Add.",
        "Open the new home-screen icon to return to the same workspace in a full-screen app.",
      ]),
    ],
  },
  {
    id: "help",
    part: "account",
    minRole: "user",
    title: "Getting help",
    summary: "Walkthrough videos and this guide, always one click away.",
    blocks: [
      list([
        "Click Help at the bottom of the sidebar for guided videos, captions, transcripts, and this PDF. The guide also covers additional procedures.",
        "Administrators can also open Documentation inside the console for role-specific videos and a printable guide.",
        "Choose Report a problem in Help to describe a problem, the affected screen, and the expected result. Share only permitted details with your administrators; omit passwords, keys, and recovery codes.",
      ]),
    ],
  },

  /* ------------------------------------------------------------------ admin */
  {
    id: "admin-overview",
    part: "admin",
    minRole: "admin",
    title: "Opening the Admin console",
    summary: "Where the console lives and what its nine tenant-governance tabs control.",
    blocks: [
      steps([
        "Click Admin console near the bottom of the sidebar. (Only workspace administrators and platform owners see it; the account drawer's Management section lists it too.)",
        "The console opens with nine tabs across the top: Users, Groups, Model Access, Connections, SSO, Analytics, Policies, Audit, and Alerts. Policies is always present between Analytics and Audit; service-wide availability determines which organization controls are active inside it.",
      ]),
      p(
        "Everything you change here writes through the admin API immediately — changes persist across refreshes and restarts, and every action lands in the tenant audit trail. Status messages under the header tell you honestly whether an action synced or failed.",
      ),
      note(
        "tip",
        "The Documentation button at the top of the console opens narrated video walkthroughs of every tab, plus this guide as a PDF.",
      ),
    ],
  },
  {
    id: "admin-users",
    part: "admin",
    minRole: "admin",
    title: "Users",
    summary: "Create tenant accounts, manage passwords, and remove leavers safely.",
    blocks: [
      p(
        "The Users tab lists the organization accounts you administer, with each person's role, groups, sign-in method, and status.",
      ),
      sub("Adding a user"),
      steps([
        "Click Add User.",
        "Enter the person's name and work email, then pick from the roles allowed by current organization policy: User, Power User, Auditor, and Agent Approver, plus Admin when administrator creation is available.",
        "Optionally pick a starting group, then create the account.",
      ]),
      sub("Reading and filtering the list"),
      list([
        "Use the group filter to work one team at a time.",
        "Watch the auth and status columns: users who arrived through SSO stay Pending until you assign them to a group — that is the signal they are waiting on you.",
      ]),
      sub("Reviewing access requests"),
      steps([
        "Open Users and review the Access requests queue. Check the requester's name, email, and request time before choosing their access level under Approve as.",
        "Choose User for standard group-based access, Temp User for the restricted Luna-only 30,000-reported-token allowance, or Admin only when that option is permitted and appropriate. Click Approve, or Decline to reject the request.",
        "After approval, use Finish sign-in setup for the approved person. Share the workspace's sign-in address and confirm the sign-in method. Approval does not send an email.",
        "For organization SSO, confirm the account exists with the identity provider. For email and password, choose Set temporary password, save a generated or entered password, and share it securely. The person must choose their own password at first sign-in.",
        "Check the person's group membership and model access, then ask them to sign in and complete a first message. Approval alone does not establish every resource permission.",
      ]),
      sub("Per-row actions"),
      p("Every row has an Actions column with account controls:"),
      list([
        "Access — opens the read-only Model access trace for this person, with their groups, each model's status, and the gates that explain it. See Resolve model requests and trace access for the full workflow.",
        "Password — opens the password dialog for that person: type a password or click Generate for a strong random one, optionally mark it a Temporary password (they must choose their own at first sign-in), and click Set password. The password is shown only here — share it over a safe channel.",
        "Deactivate / Activate — ends or restores sign-in access immediately, keeping the account's audit history intact. You can also select several accounts with their checkboxes and use the Deactivate button at the top.",
        "Delete (trash icon) — permanently deletes an eligible account and its chat history. The tooltip spells it out per person: “Permanently delete … and their chat history”. Administrator-account actions that are unavailable under current service policy remain disabled with an explanation.",
      ]),
      note("info", "Password reset and authenticator recovery are separate. The current Users screen has no authenticator-reset action. If someone has lost their authenticator and recovery codes, verify their identity and follow the organization's authorized recovery process; setting a temporary password alone does not clear MFA. Identity-provider recovery remains with the SSO provider."),
      note(
        "info",
        "Administrative continuity rules are enforced by the service. When an account action would violate them, the console blocks the action and explains that it is restricted by administrative continuity policy.",
      ),
    ],
  },
  {
    id: "admin-groups",
    part: "admin",
    minRole: "admin",
    title: "Groups",
    summary: "Groups carry permissions and model access — everything flows through them.",
    blocks: [
      p(
        "Groups are how access flows in the tenant: model grants, knowledge access controls, and permissions all attach to groups, not to individual people. New SSO users stay Pending until you put them in one.",
      ),
      steps([
        "Click Add Group and name it for the team or matter it represents.",
        "Select the group to open its editor. It has three tabs: Users, Permissions, and Import.",
        "On the Users tab, tick the people who belong in it.",
        "On the Import tab — headed “Import Users to” the group's name — paste addresses into the User emails box and click Add users to group to bulk-add them.",
        "On the Permissions tab, switch each capability on or off.",
      ]),
      sub("Runtime access and authoring permissions"),
      table(
        ["Toggle", "What it grants"],
        [
          ["Can use chat", "Start conversations and use assigned models."],
          ["Can use knowledge", "Query approved knowledge bases."],
          ["Can use agents", "Run approved agent workspaces."],
          ["Can use tools", "Invoke enabled tools and MCP actions."],
          ["Can use API", "Create personal keys for approved models when service policy allows API access."],
          ["Can use Hermes companion", "Build and run agent profiles with the Hermes learning companion. Off until approved."],
          ["Can build agents", "Create private agent profiles when service policy permits. Organization publishing stays admin-only."],
          ["Can build knowledge bases", "Create private knowledge bases. Group sharing and organization management stay admin-only."],
          ["Can build tools", "Create private tools. Group sharing, stdio commands, and organization management stay admin-only."],
          ["Can use memory", "Allow personal preferences to be learned and reused within the workspace memory policy."],
        ],
      ),
      note("warning", "Deleting a group removes its members' access that flowed through it. Check what the group grants before deleting."),
    ],
  },
  {
    id: "admin-model-access",
    part: "admin",
    minRole: "admin",
    title: "Model Access",
    summary: "Decide which synced models users can see, and which groups can use them.",
    blocks: [
      p(
        "Model Access starts from the catalog available to your organization. You decide what portion of it your users actually see.",
      ),
      steps([
        "Click Sync models to refresh the catalog whenever service availability changes.",
        "Read the counters: the All, Enabled, and Disabled status counters carry live totals alongside how many groups are available for scoping.",
        "Use the search box and the funnel filters in the column headers to cut through the catalog: check off providers, check off model labs, or type text to match runtime routes, and Clear filter resets one. The table has seven columns: Model, Provider, User Access, Groups, Filters, Knowledge, and Tools. Everything starts hidden until you decide otherwise.",
        "Flip the User Access toggle on a row to make that model visible, and use Choose groups to narrow it to specific teams.",
        "Use the Filters column to attach per-model content filters, and the Knowledge and Tools columns to scope what each model may search and call.",
      ]),
      note(
        "info",
        "Because model access flows through groups, a tenant with no groups yet sees the guard up front — “Create a group before enabling models.” — and the access switches stay off until one exists.",
      ),
      note(
        "info",
        "Newly synced models arrive disabled until service availability and organization policy permit them. If a model you expect is missing, it is not currently available to this organization.",
      ),
    ],
  },
  {
    id: "admin-model-requests",
    part: "admin",
    minRole: "admin",
    title: "Resolve model requests and trace access",
    summary: "Review requests through groups and diagnose each user's actual model access.",
    blocks: [
      sub("Review a pending request"),
      steps([
        "Open Model Access and review Access requests. Refresh reloads pending requests for your tenant. Each row names the requester and model and shows the server's access reason.",
        "Choose Grant through group carefully. An eligible existing group already carries the model. If the option says also grant model to group, approval grants the model to every member of that group as well as adding the requester.",
        "Choose Approve or Decline, then read the recorded outcome. A permission or provider restriction can still require attention after the request is resolved; a submitted decision is not a successful model response.",
      ]),
      note("warning", "Approval changes group membership. When the chosen group does not carry the model yet, it can also widen that model's availability for all group members. Review the group's purpose and members before approving."),
      sub("Trace one person's access"),
      steps([
        "Open Users and choose Access in that person's Actions column. On a narrow table, scroll to expose the actions.",
        "Model access trace lists the person's groups and each enabled model. Expand a model to inspect the policy gates in order and the reason for its result.",
        "Usable means both access and provider readiness pass. Allowed, provider offline needs a platform-owner connection repair. Blocked requires the indicated account, group, model, or policy issue to be resolved.",
        "Close the trace, make the authorized correction in Users, Groups, or Model Access, and reopen Access to verify the current server result. Ask the user to refresh model access and try the intended model.",
      ]),
      note("info", "The trace is read-only and scoped to users you can administer. It explains existing permissions; opening it does not grant access, change a role, or bypass the organization's model ceiling."),
    ],
  },
  {
    id: "admin-tools",
    part: "admin",
    minRole: "admin",
    title: "Connections: response actions and connector handoff",
    summary: "Manage response actions and route shared connector setup to the service team.",
    blocks: [
      p(
        "The Admin console's Connections tab contains Chat output actions. Shared connector switches, saved credentials, connection tests, and workspace OAuth are managed by the service team outside tenant administration.",
      ),
      note(
        "info",
        "Users still connect their own Google, Microsoft, Box, or iManage account from the composer's attach menu. Those delegated connections respect each user's source permissions. Shared credentials managed by the service team support connector setup and background knowledge sync; they do not grant users someone else's files.",
      ),
      sub("Chat output actions"),
      p(
        "Chat output actions adds admin-approved buttons to assistant responses for export, formatting, or handoff. Choose New response action to create one; existing custom actions offer Edit and Delete. Each row shows Enabled or Draft and an enable switch. Creating these actions does not configure a shared source connector.",
      ),
      p("MCP connections and model-callable tools remain in Library → Tools → Connections. Prompts and Skills also remain in the Tools library. Their authoring and use follow the existing permissions and the shared connector availability set by the service team."),
    ],
  },
  {
    id: "admin-automations",
    part: "admin",
    minRole: "admin",
    title: "Automations: preparing scheduled runs",
    summary: "What admins need to configure before users can rely on recurring model chains.",
    blocks: [
      p(
        "Users create and run automations from the Automations tab of the Agents view, and enabled schedules fire automatically in the background (UTC), delivering each run's output as a new chat thread. Admins manage group and model access; the service team manages shared connector availability and credentials outside tenant administration. Check the actual failure details to determine which setup needs attention.",
      ),
      sub("Admin readiness checklist"),
      steps([
        "Open Model Access and confirm the automation's model is visible to the user's group.",
        "Open Groups and confirm the user belongs to the group that receives the model grant.",
        "Ask the service team to confirm any required shared connector and inspect its real connection-test result. Users complete their own source-account connection when the workflow needs delegated access.",
        "If the automation uses knowledge, confirm the knowledge base is enabled and its source ACL allows the user's group.",
        "Ask the user to press Run now after saving the automation; the transcript and last-run status will show whether the setup is complete.",
      ]),
      note(
        "info",
        "Admins do not need to expose every model to make automations work. Grant the smallest approved model set that fits the scheduled workflow, then expand only when a run proves it needs more capability.",
      ),
    ],
  },
  {
    id: "admin-sso",
    part: "admin",
    minRole: "admin",
    title: "SSO: single sign-on for your tenant",
    summary: "Connect an identity provider, provision on first sign-in, and map IdP groups.",
    blocks: [
      note(
        "info",
        "If organization policy does not permit SSO management in this console, the tab is read-only and says so plainly.",
      ),
      steps([
        "Open the SSO tab and click Add SSO configuration.",
        "Pick a preset — Microsoft Entra ID, Google Workspace, Okta — or choose custom OIDC and enter any issuer. Presets prefill the issuer URL; for Entra, replace the {tenant-id} placeholder with your directory ID.",
        "Paste the Client ID and Client secret from your identity provider's app registration. The secret is vaulted server-side and never shown again.",
        "List the email domains allowed to sign in through this provider.",
        "Decide on just-in-time provisioning: when on, the first sign-in from an allowed domain creates the account automatically with the User role. Remember — they stay Pending until you assign a group.",
        "Copy the redirect URI shown at the bottom of the form and register it with your identity provider. Sign-ins cannot complete until the provider trusts that exact callback address.",
        "Click create. Enforcement always starts off, so nothing can lock the tenant out.",
        "On the new configuration's card, click Test connection — it performs a real discovery and key check against the provider.",
        "Map identity-provider group values to tenant groups on the card, so JIT users land with the right access.",
        "After the discovery and key test passes, complete a real sign-in with a permitted test account. Verify the redirect back to this workspace, the resulting account and group access, and any required MFA. Only then consider enforcement.",
      ]),
      note(
        "warning",
        "Enforcement blocks password sign-in for the allowed domains. A passing Test connection checks discovery and keys; it does not prove the client-secret exchange, callback, user session, or group mapping. Validate those in a real login before making enforcement the last step.",
      ),
    ],
  },
  {
    id: "admin-analytics",
    part: "admin",
    minRole: "admin",
    title: "Analytics",
    summary: "Runtime metadata, feedback, per-user usage, and token budgets for this tenant.",
    blocks: [
      p(
        "The Analytics tab measures how the organization actually uses the platform. Sections start collapsed behind descriptive headers — click a header to expand one — and each section carries its own filter row pairing a person picker (defaulting to All admins and users) with a date range and its presets (All, Today, Week, 30 days). Scoping one section never narrows another.",
      ),
      list([
        "Runtime Clock Metadata — organization-scoped execution timestamps captured from admin and user Chat and Draft completion events. The cards total runtime events, chat completions, and draft calls. Its CSV includes actor_id and actor_name columns, and when one user is selected the filename gains that user's suffix so exports stay unambiguous.",
        "Chat Feedback Analytics — response-level thumbs up and thumbs down signals submitted by tenant admins and users, with totals for overall, positive, and negative feedback.",
        "Model Activity — saved prompt volume by model, date, and person for the selected range, drawn as “Prompts by model”, “Prompt trend”, and “Users by prompt activity”.",
        "User Usage — durable per-user usage for this organization's admins and users across chat, drafts, agents, automations, and the API gateway. Token counts are provider-reported only and stay blank when a provider reported none. The panel has its own Filter usage by user selector for drilling into one person.",
        "Workspace Usage Budget — a read-only view of the organization's service-managed ceiling and its current UTC accounting period. This panel shows where usage stands without exposing service-level configuration.",
        "Token Allocations — per-user and per-group token caps beneath the workspace ceiling, with Per day, Per week, or Per month UTC resets. The most restrictive applicable cap wins. Choose a user or group, enter a cap, pick the period, and click Set cap. Until you add one, the table says “No allocations yet. Everyone shares the workspace ceiling.”",
      ]),
      note(
        "info",
        "Every number here comes from saved audit and usage events, and each CSV export button opens its own small date-range popover so a file contains exactly the rows you chose. If a panel has nothing to show, it says so plainly instead of showing sample data.",
      ),
    ],
  },
  {
    id: "admin-memory",
    part: "admin",
    minRole: "admin",
    title: "Policies: service availability and memory governance",
    summary: "Apply downstream tenant defaults, configure memory, and govern by count without reading content.",
    blocks: [
      p(
        "The Policies tab is always present. Policy Controls starts collapsed. When service policy enables memory, Personalization Memory and Memory by User also appear collapsed. Otherwise, Memory governance explains the restriction; saved organization settings remain intact. Expand the panel you need; administrators can narrow available capabilities, while unavailable settings remain locked.",
      ),
      sub("Policy Controls: read service availability"),
      list([
        "Administrator accounts — shows whether this console can create and manage administrators or whether new administrator accounts require service approval.",
        "Admin sign-in policy — shows whether admins must use SSO or may use an explicitly provisioned local account.",
        "SSO configuration — shows whether tenant SSO mappings are delegated or read-only.",
        "New model defaults — shows whether newly available models begin with Default Users or require explicit grants.",
      ]),
      p(
        "Below those status rows are defaults for the protected Default Users group: personal API keys, private-agent building, private knowledge-base and tool authoring, and personalization memory. A switch locks when its capability is unavailable under service policy; the saved group grant is preserved rather than silently erased. Use Groups for exceptions and Model Access for available models. Shared connector availability is managed by the service team outside tenant administration.",
      ),
      sub("Personalization Memory"),
      steps([
        "When service policy permits memory, expand Personalization Memory and turn on Memory for this organization. This makes the account-level Personalization memory row available to eligible users; existing memories stay saved but are not applied while this switch is off.",
        "Choose whether to allow Learn from conversations automatically. When off, only explicit requests such as “remember that …” and direct additions in the memory manager create memories. Every user can still opt out of automatic learning individually.",
        "Set Retention (days), from 1 through 3650. Older memories retire automatically when they pass this policy.",
        "Set Maximum memories per user, from 1 through 2000. The default is 200, which is a practical general-purpose limit; raise or lower it only when your retention, compliance, or workload policy calls for a different capacity. When the cap is passed, the least useful unpinned memories retire first.",
        "Expand Memory by User to review content-free counts. Click Refresh to reload the counts, or purge one person's memories when compliance or account cleanup requires it.",
      ]),
      note(
        "warning",
        "Memory administration never grants reading access. Administrators see policy, counts, and purge controls only; the API and the interface do not return another person's memory content.",
      ),
    ],
  },
  {
    id: "admin-retention",
    part: "admin",
    minRole: "admin",
    title: "Data retention and conversation tags",
    summary: "Find tagged conversations, inspect their contents, and review batch actions.",
    blocks: [
      steps([
        "Open Audit and expand Data Retention, then choose Schedule and rules. Forever is the default: automatic deletion is off until an administrator previews and saves a schedule. Choose 1, 5, 7, or 10 years, or keep Forever. One year means 365 days.",
        "Choose whether age starts at chat creation or the last message change. Renaming or archiving a chat does not restart its clock. Select a review window of at least 7 days. Saving a changed policy restarts that window for eligible chats.",
        "Add a stable client, matter, or regulated-record source and its aliases. A source can have a longer retention rule or Forever. Choose Apply time limits only to labels with a rule to leave all other chats stored indefinitely. The longest applicable duration wins; a matching Forever rule or active legal hold prevents automatic deletion.",
        "Save the source definitions, then use Scan existing chats in Data Retention → Tags and holds. New message saves also look for source mentions. Detected mentions are suggestions only: select the correct chats and source, then Confirm label. Remove / dismiss label rejects a false match. The label records who confirmed it and when.",
        "Optional sensitive-data suggestions check saved message text for email addresses, possible Social Security numbers, and payment cards. They do not detect every form of PII or regulated record, or inspect original uploaded files. Raw matched values are never copied into labels. Review before confirming a category.",
        "Choose Preview effect to see counts across all saved chats, including legal holds and chats without a deadline. Saving the policy recalculates existing and future chats. A shorter duration can make old chats eligible, but they still receive the review window. A longer duration delays deletion; it cannot restore deleted content. Saving Forever stops automatic deletion.",
        "To inspect chats, open Audit, expand Data Retention, and choose Tags and holds. This list includes tagged and untagged conversations available in your administrative scope.",
        "Use Search chats and tags to find titles, people, tags, or client/matter identifiers. Filter by tag type when you need a narrower set.",
        "Click a conversation title to open Tagged conversation and review its saved prompts and outputs. Close the preview to return to the same list.",
        "Select the intended chats. Archive selected keeps them stored and searchable but removes them from the active list. Delete selected opens a permanent-deletion confirmation; it does not delete until you choose Yes, delete.",
        "Under Legal holds, name a hold and choose Hold selected chats. This hold protects the selected records, including against manual deletion. For ongoing preservation of a client, also set that source's rule to Forever. Load active holds to review them; releasing a hold requires a second confirmation.",
        "Read the completed action status. Chats under an active hold are skipped by deletion. A failure or skipped record needs review; do not assume every selected row was deleted. The background scheduler handles automatic cleanup in bounded batches and writes an audit record per deleted chat.",
      ]),
      note("warning", "Permanent deletion removes the selected conversations and their attachments and cannot be undone. Preview contents and check the selected count before confirming. A tagging switch records classification; it is not a scheduled deletion rule or an action that places a hold."),
    ],
  },
  {
    id: "admin-feedback-issues",
    part: "admin",
    minRole: "admin",
    title: "Review feedback and reported issues",
    summary: "Read response ratings, written feedback, and platform reports in Analytics.",
    blocks: [
      steps([
        "Open Analytics and expand Chat Feedback. Set its person and date filters; these apply to that feedback panel.",
        "Select a response rating to preview its feedback and saved conversation. Read any written comment alongside the model output.",
        "Under Reported platform issues, select a report to review its subject, description, reporter, time, and optional screenshot. If a screenshot cannot load, read the error rather than treating it as an empty attachment.",
        "Use the report to reproduce the problem with permitted test data, then follow your organization's support process. Viewing a report does not send a reply or mark the problem resolved.",
      ]),
    ],
  },
  {
    id: "admin-audit",
    part: "admin",
    minRole: "admin",
    title: "Audit",
    summary: "Governance signals, prompt monitoring, security alerts, and the tenant trail.",
    blocks: [
      p(
        "The Audit tab is the tenant's governance station. It opens on the Admin Audit posture dashboard while the sections below start collapsed — click a section header to expand it. User Prompt Activity, Security Alerts, and the Audit Trail each carry their own filter row pairing a person picker with a date range, so one section's scope never narrows another. The CSV export buttons produce files of exactly the filtered rows — including actor_id and actor_name columns, so every exported row names who acted.",
      ),
      list([
        "Admin Audit — summary cards for tenant security and governance signals: audit events, the prompt watchlist of active DLP or misuse alerts, prompt volume, active admins, active users, connector issues, and ungrouped models. Cards that need attention are highlighted; hover one to see what it counts.",
        "Recent Governance Activity — the current tenant snapshot for identity, user, model, and connector posture: how many SSO configurations are enforced, how many users are active, and how many connectors are enabled.",
        "User Prompt Activity — drill into saved prompts from this organization's admins and users and their model responses by person, thread, model, and timestamp, scoped by the section's own user and date filter.",
        "Security Alerts — DLP and malicious-behavior flags raised from admin and user prompts, shown with redacted snippets for review. Click Acknowledge once an alert is handled, or Reopen if it needs another look.",
        "Audit Trail — the tenant's append-only transaction log, newest first. Its toolbar has a severity select, an action-category select, and a search box (Search actions, people, targets…) that narrow the rows together; the trail's CSV exports exactly the rows you are looking at. Click Refresh to reload it straight from the admin audit API.",
      ]),
      note(
        "info",
        "Security alerts fire on real prompt content — payment card numbers, shared credentials, prompt-injection attempts — but show only redacted snippets, so reviewing an alert never re-exposes the sensitive value itself.",
      ),
    ],
  },
  {
    id: "admin-alerts",
    part: "admin",
    minRole: "admin",
    title: "Alerts",
    summary: "Watch rules over audit activity, and honest delivery statuses for every alert.",
    blocks: [
      p(
        "The Alerts tab turns audit activity into notifications. It has three panels: Email Delivery, Alert Rules, and Alert Deliveries. Every alert is always logged in-app regardless of email — email is a delivery channel, not the record.",
      ),
      sub("Email Delivery"),
      p(
        "For organization administrators this panel is a read-only status: it reports whether email delivery is configured at the service level. If email is not configured, rules still work — their alerts are logged in-app and the delivery log says so honestly.",
      ),
      sub("Alert Rules"),
      list([
        "Click Suspicious-activity template to start from a sensible security rule, or New rule to build one from scratch.",
        "A rule has: a name; Action patterns — exact audit actions or prefixes such as security.* or admin.user_deleted; a Minimum severity; an optional Watched user; a threshold — how many matches within a time window before it fires; a cooldown between alerts; and email recipients. Leave recipients empty and the alert is in-app only.",
        "Rules you create here watch this organization's admin and user audit activity.",
      ]),
      sub("Alert Deliveries"),
      p(
        "Every alert trigger is listed with its real delivery status: sent, queued, failed with the actual SMTP error, email not configured, or logged in-app. The log exports to CSV, archived deliveries included. Click Archive on a delivery to clear it from the default view — its history is kept, and Show archived reveals archived deliveries so you can review or Restore them. Tenant admins can archive their tenant's deliveries only.",
      ),
    ],
  },

  /* ------------------------------------------------------------------ owner */
  {
    id: "owner-overview",
    part: "owner",
    minRole: "owner",
    title: "Opening the Platform owner console",
    summary: "The highest access level, its six tabs, and the role ceilings.",
    blocks: [
      steps([
        "Click Platform console (building icon) near the bottom of the sidebar. (Only platform owners see it; the account drawer's Management section lists it as Platform owner console.)",
        "The console has six tabs: Org Settings, Models, Providers, Analytics, Audit, and Alerts. Org Settings holds organization configuration; API keys live on each provider's card under Providers.",
      ]),
      p("Keep the three role ceilings in mind — they explain who can touch what across the entire platform:"),
      table(
        ["Role", "What it controls"],
        [
          ["Platform owner", "Providers, API keys and secrets, shared connectors, organization model availability, SSO, branding, policies, usage budgets, platform updates, alert email, and removing admins. The highest level."],
          ["Admin", "Tenant users, groups, response actions, and tenant model access — always inside the boundaries the owner sets."],
          ["User", "Chat, drafts, assigned agents, and whatever models and sources their groups allow."],
        ],
      ),
      note(
        "info",
        "First-run setup: when no active platform owner exists yet, the sign-in screen shows “Create the first platform owner” — enter a display name, email, and a password of at least 12 characters. This screen never appears again once an owner exists.",
      ),
      note(
        "tip",
        "The Documentation button opens owner walkthroughs and this PDF. Its Admin documentation and Chat help links open the other role libraries. Interactive platform guide opens the public digital walkthrough at https://aperturechat.com/guide.html in a new tab for additional platform setup and configuration guidance.",
      ),
    ],
  },
  {
    id: "owner-first-run",
    part: "owner",
    minRole: "owner",
    title: "First-run setup: from owner account to a working team",
    summary: "Create the first owner, connect a model, and verify access before inviting the team.",
    blocks: [
      steps([
        "On a new installation with no active owner, complete Create the first platform owner with your display name, work email, and a password of at least 12 characters. Confirm the password and choose Create platform owner.",
        "The Getting started card offers the setup action for your role. Open owner guide opens this role's documentation. Choose an action or explicitly dismiss the card; merely loading the workspace does not mark it reviewed.",
        "Choose Platform console near the bottom of the sidebar. Documentation opens the owner guide, narrated lessons, and the Interactive platform guide for step-by-step configuration advice.",
        "Open Providers, register the intended gateway, and save its real credential in API Keys. A successful save confirms configuration storage; Needs validation still requires a successful runtime check.",
        "For a provider that supports catalog discovery, choose Sync Models on its card. This refreshes the catalog and tests a small live model request. Read the returned status and correct credential or runtime failures before relying on the connection.",
        "In Models, review the resulting catalog and enable only the models you intend to offer. Providers with manually managed catalogs need their model configuration checked separately.",
        "Open Admin console to configure the team's groups, model access, and any permitted knowledge or tools. Approve access requests or create accounts, then complete the sign-in handoff described in Users.",
        "Verify a real first message with a synthetic standard-user account. Confirm the intended model works, restricted resources stay unavailable, and any temporary password or authenticator requirement completes correctly.",
        "If you will use SSO, complete discovery testing and a real end-to-end sign-in before enforcing it. Keep an authorized administrative sign-in path available while validating the setup.",
      ]),
      note("info", "Before inviting a team, verify the intended provider, enabled models, group memberships, and model grants. Test each intended user role; a working owner account does not prove that a standard user has access."),
      p("Use Providers and Models for service configuration, then Admin Console → Model Access and Groups for tenant access. Use Org Settings for SSO, branding, connector availability, policy, and budgets."),
    ],
  },
  {
    id: "owner-providers",
    part: "owner",
    minRole: "owner",
    title: "Providers",
    summary: "Register model gateways, read connection health, and sync catalogs.",
    blocks: [
      steps([
        "Open the Providers tab and click Add Provider.",
        "Pick the kind. Eleven are available: openai, anthropic, azure-openai, azure-foundry, gcp, amazon-bedrock, open-webui, openrouter, ollama, openai-compatible, and local. Save the base URL, auth type, region, and the label for its first key.",
        "Read the provider's card after saving. It shows the provider's brand logo, the kind, region, and a Models counter that reads enabled “of” total — for example “12 of 40” — so you can see the ceiling at a glance.",
        "Read the status badge separately from the save confirmation: Needs key means no active credential is available; Needs validation means the saved connection and credential still need a successful runtime check; Adapter needed means the required runtime adapter is unavailable; Connected reflects a validated usable route. Saving a provider or key is not a successful model test.",
        "Click API Keys on the card — the button shows how many keys are stored — to manage that provider's vaulted credentials. The next section covers the vault in detail.",
        "Click Sync Models to pull the provider's catalog. The button stays disabled until an active key exists, and says so.",
        "Use Edit Connection whenever a base URL, auth header, or catalog scope needs correction.",
      ]),
      sub("Kind-driven defaults"),
      list([
        "Picking a kind prefills sensible connection defaults. azure-foundry uses the inference endpoint https://{resource}.services.ai.azure.com/models with api-key authentication; gcp routes through Google's OpenAI-compatibility endpoint for Gemini models.",
        "The Catalog scope row appears only on openrouter providers: choose between the zero-data-retention (ZDR) filtered list and the key-scoped model list.",
      ]),
      note("info", "A provider is not usable until it has an active key in its vault — open API Keys on the card and add the key next."),
    ],
  },
  {
    id: "owner-vault",
    part: "owner",
    minRole: "owner",
    title: "API Key Vault",
    summary: "Each provider card vaults its own secrets; reveal, replace, or delete them.",
    blocks: [
      p(
        "Each provider's secrets live in a vault attached to its own card — there is no separate keys tab. Open the Providers tab and click API Keys on a card to expand its API Key Vault panel.",
      ),
      steps([
        "Click Add Key and enter the key's name, environment, expiry, and the secret itself. The secret is saved to the backend vault — only a masked value ever reaches the browser.",
        "Read each row's metadata: the key's name, environment, active status, when it was last rotated, and its expiry — stale credentials are visible before they fail.",
      ]),
      list([
        "Reveal — opens the Vault reveal dialog, which shows the secret with a Copy key button and a Done button to hide it again. Expired keys cannot be revealed.",
        "Replace — swaps in a new provider-generated secret in place.",
        "Delete — removes the key.",
      ]),
      p("Reveals, replacements, and deletes write through the platform API, so the audit trail stays complete."),
    ],
  },
  {
    id: "owner-models",
    part: "owner",
    minRole: "owner",
    title: "Models: organization availability",
    summary: "The organization ceiling — control which synced models tenants can route to.",
    blocks: [
      steps([
        "Open the Models tab. It lists every model synced from your providers.",
        "Narrow the list three ways: the search box, the All / Enabled / Disabled status filter (each option shows a live count), and per-column filters on the Provider, Model lab, and Runtime route columns — click a column's filter icon to tick specific providers, labs (OpenAI, Anthropic, Google, and so on), or routes.",
        "Read each row: the provider, the model, the exact runtime route requests will use, and whether the organization has it enabled.",
        "Flip the org status toggle to enable or disable a model. This is the ceiling: models disabled here never reach tenant admins or users.",
        "Click Edit details on any row you allow, to record its display name, runtime route, context window, notes, system prompt, and meta prompt.",
      ]),
      note(
        "info",
        "Newly synced models arrive disabled with no group access. After a sync, switch the filter to Disabled, review the new arrivals, and enable only the routes the organization has actually approved. If the Default group for enabled models policy is on (see “Policies”), enabling a model automatically attaches the protected Default Users group so users see it without a second step.",
      ),
    ],
  },
  {
    id: "owner-org-users",
    part: "owner",
    minRole: "owner",
    title: "Org Settings: users and role boundaries",
    summary: "Create accounts at any level, set passwords, and rely on the account floors.",
    blocks: [
      p(
        "The Org Settings tab gathers organization-level controls: roles and accounts, single sign-on, branding, policies and budgets, platform connectors, and search index readiness. Most sections start collapsed behind a descriptive header; click a header (or its chevron) to expand it. Search index starts open. Expand Role Boundary for the account tools.",
      ),
      steps([
        "In the create form, enter a display name and email, and pick a role: User, Admin, or Platform owner.",
        "Click Create account. It writes through the platform admin API, so the account survives refresh and restart.",
        "Manage existing accounts in the list below: change a role from its dropdown, set a password with the key button, or remove an account with the trash button.",
      ]),
      sub("Setting a password"),
      p(
        "The key button on a row opens the same dialog admins use — “Set a password for” that person. Type a password or click Generate for a strong random one, optionally mark it a Temporary password so they must choose their own at first sign-in, and click Set password. The password is shown only in that dialog — share it over a safe channel.",
      ),
      note(
        "info",
        "Two floors protect the platform. The last active platform owner can never be removed. And at least one active administrator (owner or admin) must always remain — because owners count as administrators, the sole tenant admin is removable while an active owner exists, but the API refuses any removal that would leave no administrator at all.",
      ),
      p(
        "Below the account list, the “Clear separation of duties” callout restates the boundary: platform owners manage provider secrets, owner accounts, admin delegation, SSO baselines, and platform branding.",
      ),
    ],
  },
  {
    id: "owner-sso",
    part: "owner",
    minRole: "owner",
    title: "Org Settings: single sign-on setup",
    summary: "Choose the protocol, connect a real OIDC provider, and register the redirect URI.",
    blocks: [
      p(
        "The Single Sign-On panel configures live OIDC. Users are redirected to your identity provider, and the returned ID tokens are cryptographically verified before a session is issued.",
      ),
      steps([
        "In Org Settings, expand the Single Sign-On section by clicking its header.",
        "Pick the Protocol first. OIDC (supported) is the live sign-in path. SAML appears but is disabled — labeled “SAML — Deferred, not a working sign-in path” — so a stored SAML configuration stays honest without pretending to sign anyone in. SCIM stores a SCIM provisioning base URL and token instead of a sign-in flow.",
        "Pick a preset — Microsoft Entra ID, Google Workspace, or Okta — or enter any OIDC issuer URL. For Entra, replace the {tenant-id} placeholder in the issuer with your directory ID.",
        "The issuer drives everything else: the platform fetches the provider's discovery document from {issuer}/.well-known/openid-configuration to learn its endpoints and keys.",
        "Paste the Client ID and Client secret from your app registration (for SCIM, the secret field doubles as the SCIM token). Secrets are vaulted server-side only — never returned to the browser.",
        "For SCIM, fill the SCIM base URL; if you document Duo MFA, the Duo API hostname field records it alongside.",
        "Copy the redirect URI shown in the panel and register it with your identity provider. Sign-ins cannot complete until the provider trusts this exact callback address.",
        "List the allowed email domains — only accounts on those domains can sign in through this provider.",
      ]),
    ],
  },
  {
    id: "owner-sso-security",
    part: "owner",
    minRole: "owner",
    title: "Org Settings: SSO claims, MFA, and go-live",
    summary: "Separate identity-provider MFA from the platform authenticator and verify the complete sign-in path.",
    blocks: [
      list([
        "Role and group claims — tell the platform which token attributes carry your identity provider's role and group assignments.",
        "MFA documentation — the Authenticator app select records which app your organization uses (Microsoft Authenticator, Duo Mobile, or Identity provider), alongside the MFA methods the provider enforces, so the sign-in experience is documented where admins look for it.",
        "Enrollment QR — add an enrollment URI (a standards-based TOTP link or a Duo enrollment URL) and the panel renders it as a scannable QR code for authenticator setup.",
        "Require the platform authenticator after SSO — off trusts the identity provider's MFA; on also requires users to enroll and verify with Aperture Chat's authenticator. Choose deliberately to avoid an unintended second challenge. Recording an authenticator name or enrollment link alone does not enable this requirement.",
        "Just-in-time provisioning — creates new accounts automatically the first time someone on an allowed domain signs in. They arrive with the User role until you promote them.",
      ]),
      steps([
        "Click Save SSO.",
        "Click Test connection — it performs a real discovery and key check against the provider. The test requires the OIDC protocol; with SAML or SCIM selected the button is disabled and its tooltip says to switch to OIDC.",
        "Complete a real sign-in with a permitted test account, including client-secret exchange, redirect back to the workspace, session creation, role/group mapping, and any required authenticator challenge.",
        "Only after that full sign-in succeeds, consider enforcement and confirm users know which sign-in and recovery path to use.",
      ]),
      note(
        "warning",
        "Enforce SSO blocks local password sign-in for every allowed domain. Test connection proves discovery and keys, not a completed login. Treat enforcement as the last step after the real login succeeds; a misconfigured provider can lock out administrators on those domains too.",
      ),
    ],
  },
  {
    id: "owner-branding",
    part: "owner",
    minRole: "owner",
    title: "Org Settings: platform branding",
    summary: "Rename the product, swap the logos, and recolor the theme everywhere.",
    blocks: [
      steps([
        "In Org Settings, expand Platform Branding. It starts with a live preview of the current name and logo, exactly as users see them.",
        "Fill in the identity fields: the platform name, the Platform logo URL, and the Browser icon URL (the tab icon).",
        "Record the Platform domain if you use one. As the note under the field says, it is “Recorded for admins and the API” — you still point DNS and TLS at this deployment separately; saving here does not move traffic.",
        "Set the Theme colors: Accent color for buttons and highlights, Sidebar gradient start and Sidebar gradient end for the rail (pick darker stops so the light sidebar text stays readable), and Interface text color, which applies to the light theme.",
        "No image URL handy? Click Upload PNG and the platform hosts the image for you — PNG files up to 4 MB.",
        "Click Apply branding to roll the change out everywhere the default brand appears, or Reset defaults to restore the original identity in one click.",
      ]),
      note(
        "info",
        "Branding reaches further than the shell: the same identity feeds the runtime theme colors and the per-tenant install manifest and icons, so the app people add to their phone's home screen carries your name and logo, not a generic one.",
      ),
    ],
  },
  {
    id: "owner-policies",
    part: "owner",
    minRole: "owner",
    title: "Org Settings: policies and budgets",
    summary: "Set the organization ceiling and the workspace usage budget.",
    blocks: [
      sub("Policy Controls"),
      p(
        "Expand Policy Controls in Org Settings when you need it. The first row is not a toggle at all: “Only owners can create platform owners” carries an Always on pill because the platform enforces it unconditionally. Below it are eight real switches:",
      ),
      table(
        ["Policy", "What it allows when on"],
        [
          ["Downstream API access", "Owners and admins can use the platform API downstream; standard users still need the group grant Can use API from their admin."],
          ["Tenant admins can create admins", "Delegates admin creation to tenant admins; off means owner-only."],
          ["Require SSO for admins", "Admin accounts must sign in through SSO, not passwords."],
          ["Tenant admins can manage SSO mappings", "Lets tenant admins edit their tenant's SSO configuration and group mappings."],
          ["Default group for enabled models", "Newly enabled models automatically include the protected Default Users group, so admins do not need a second step per model."],
          ["Users can build their own agents", "The first half of a two-part gate: with this on, admins can grant Can build agents to a group, and those users can build private, self-owned agents. Publishing to the organization stays admin-only. Both halves default off."],
          ["Personalization memory", "Enables the tenant-admin handoff. Admins may then turn memory on for their organization and grant Default Users access. Off locks both downstream controls while preserving saved grants. Admins and owners see counts and purge controls only, never memory content."],
          ["Users can browse the model catalog", "Users can inspect all models enabled for their organization, read availability reasons, and request access where permitted. Off shows only already-usable models and refuses access requests. This does not reveal private prompts or notes."],
        ],
      ),
      note(
        "info",
        "Active policies define the organization ceiling. Tenant admins can only operate inside these boundaries — nothing they configure can exceed them.",
      ),
      sub("Workspace Usage Budget"),
      list([
        "The Workspace Usage Budget panel sets a hard spending ceiling for the whole workspace. Choose the Budget measure — Token allowance (exact provider-reported tokens) or Dollar amount (USD) (exact provider-reported cost) — and the Reset period: Every day, Every week, or Every month, on the UTC calendar (weeks begin Monday).",
        "Enter the limit and click Save budget policy. A limit of 0 means unlimited. The usage card beside the form shows the live count for the current period, split into provider-reported and unreported completions so the number stays honest.",
        "Once the ceiling is spent, further completions are refused until the period resets. Admins can add per-user and per-group allocations beneath this ceiling from their Analytics tab.",
      ]),
      sub("Elastic Analytics"),
      p(
        "The Elastic Analytics panel reports whether backend audit export is configured, its status, and buffered events. Configure APERTURE_ELASTIC_URL or APERTURE_ELASTIC_CLOUD_ID, together with APERTURE_ELASTIC_API_KEY, in the backend environment and restart the API. The browser never receives this API key. Buffered events are delivered once the configured cluster is reachable; the panel has no connection form to save.",
      ),
    ],
  },
  {
    id: "owner-connectors",
    part: "owner",
    minRole: "owner",
    title: "Org Settings: shared connectors and source credentials",
    summary: "Configure deployment-wide availability, test real connections, and distinguish shared access from personal sign-in.",
    blocks: [
      p("Open Platform owner console → Org Settings and expand Connectors. This owner-only panel controls shared source settings and availability. Turning a connector off removes that capability across chat, source pickers, the command palette, the Tools library, and the API. Tenant administrators do not configure these shared connections."),
      p("Credential-backed sources show Credentials saved, Saved · disabled, or Needs credentials. A saved credential is configuration evidence; read Test connection for the live result. Switch-only capabilities, such as MCP Servers and Prompt Library, have an enable switch without a vendor credential form."),
      sub("Configure and test a source"),
      steps([
        "Choose Configure on the source row. Select Authentication method and fill in the fields shown for that method. Read the source's setup notes for its required permissions and redirect URI.",
        "Choose Save configuration. For an existing saved secret, leave its password field blank to retain it, or enter a new value to replace it. Wait for the save result before testing.",
        "For Google OAuth, save the client ID and secret first, then choose Connect Google Drive to authorize the workspace account used for knowledge sync. Complete the consent flow before checking the connection.",
        "Choose Test connection and read its result and individual checks. An incomplete, failed, or missing result is not proof of access. Resolve the reported issue before relying on the source.",
        "Set the source's enable switch for the deployment and verify the resulting status. Configure the intended users' source-account access separately when they will attach files in chat.",
      ]),
      table(
        ["Source", "Configuration shown by the form"],
        [
          ["Google Drive", "Google OAuth client ID and secret, with an optional Drive folder ID and source label. Paste access token is a testing option."],
          ["OneDrive / SharePoint", "Microsoft Graph directory ID, application ID, and client secret for app-only access, with optional site, drive, and root-folder IDs."],
          ["Box", "Client ID, enterprise ID, and client secret for Client Credentials Grant; an optional folder ID limits the starting location. Developer token is a testing option."],
          ["iManage", "Instance URL, API key (client ID), and OAuth client secret for Each user signs in. Service account for background sync adds the service username and password; chat still requires each user's OAuth sign-in."],
        ],
      ),
      note("info", "Google, Microsoft, Box, and iManage chat attachments use each signed-in user's delegated source account. Shared knowledge-sync credentials do not replace that sign-in or bypass source permissions. Users keep their Connect action in the attach menu."),
      sub("Clear saved configuration"),
      p("Clear configuration removes the source's saved fields, stored secret, shared OAuth data, and service-account password, and disables its saved configuration. Use it only when that removal is intended. An empty secret field alone retains the saved secret; clearing all visible fields and saving an existing configuration also performs a clear."),
      sub("Web Search"),
      p("Choose Configure on Web Search, then select Search engine and Results per search (1 to 10). DuckDuckGo is keyless. SearXNG requires an instance URL with JSON search output enabled. OpenAI, Anthropic, and OpenRouter choices use the corresponding saved provider key and bill searches to that provider account. Choose Save configuration, then Test connection to run a real query."),
      p("The engine choice applies to models without hosted web search of their own. OpenRouter-backed models use OpenRouter's built-in search regardless of this selection. The Web Search enable switch still governs availability for the deployment."),
    ],
  },
  {
    id: "owner-search-index",
    part: "owner",
    minRole: "owner",
    title: "Org Settings: search index readiness",
    summary: "Review index coverage and rebuild from live records when search needs maintenance.",
    blocks: [
      steps([
        "Open Org Settings and find Search index, which starts open. This supports Search past work for chats and saved documents and decks; it is separate from knowledge-source ingestion.",
        "Read the per-organization status: Ready or Backfilling, entry count, index mode, and completion time when available. While backfilling, the user search panel may warn that results are incomplete.",
        "Use Rebuild index when the stored index needs rebuilding from current records. Wait for the completed result and refreshed entry count. A failure message requires review; a button click is not a completed rebuild.",
        "Verify representative search terms with an account that is allowed to see the underlying work. Rebuilding does not broaden permissions: every search hit is checked against its live record and the requesting account.",
      ]),
      note("info", "If indexing is disabled for this deployment, the panel explains that searches scan records on each request and disables Rebuild index. An index entry count is a coverage signal, not a count of items every user may access."),
    ],
  },
  {
    id: "owner-platform-updates",
    part: "owner",
    minRole: "owner",
    title: "Review and install a platform release",
    summary: "Use the owner-only sidebar update notice to review release notes, install when available, and verify the reported result.",
    blocks: [
      p("For platform owners, the sidebar says Release available followed by a version when the updater is unavailable, and Update to followed by a version only when it is ready. It can also show an active update or a recent undismissed result. Tenant administrators and users do not receive this control. The current version comes from the running build; a stale deployment version setting does not establish which build is running."),
      steps([
        "When the update row appears, hover over or focus it to read release highlights and the current version. Click it to open the update dialog.",
        "Review What this update brings, and use Show full release notes or Release page when offered. Check the Release list checked timestamp and any error. Check again requests a fresh release list when no update is running.",
        "Read How the update runs before proceeding. Installation restarts the API and web app, so arrange an appropriate interruption window and follow the deployment's backup procedure.",
        "Choose Install followed by the target version only when ready. The button is available when the updater service is configured and connected. If the dialog shows Manual install on this deployment or an offline-updater message, follow those deployment instructions instead. A fresh VPS can use the release bundle installer to prepare private configuration and a stable project, then pull, start, and health-check the stack. Existing installations need the documented one-time API and updater-sidecar configuration in the same project; do not run a fresh-install workflow over existing data. Forks use their own repository release source by default. See the repository Docker release guide for the exact commands and prerequisites.",
        "Follow the recorded progress through downloading, restarting, and verifying. Show updater log opens available detail. Closing the dialog does not cancel an update that has already started.",
        "After Update installed, choose Reload now to load the new web build, then verify the workspace. If the result is Update failed or Update rolled back, inspect the reported details before using an offered Retry action. Dismiss hides a finished result; it does not install or repair a release.",
      ]),
      note("info", "A release check or accepted install request is not a completed update. During an active run the API may be temporarily unreachable; the dialog continues polling. Wait for the reported outcome and verify the refreshed application before treating the release as complete."),
    ],
  },
  {
    id: "owner-retention",
    part: "owner",
    minRole: "owner",
    title: "Organization retention and tagging",
    summary: "Set the tagging policy and govern conversations within owner access.",
    blocks: [
      p("In Platform owner console, open Audit, expand Data Retention, and choose Schedule and rules. The default is Forever, with automatic deletion off. Use the duration slider, review window, client and matter sources, and Preview effect exactly as described in the administrator retention chapter. Deployment never activates an existing metadata-only policy."),
      steps([
        "Open Audit, expand Data Retention, and choose Tags and holds. Search and filter the conversations before selecting rows.",
        "Preview the saved prompts and model outputs for a conversation. If the data cannot load, resolve the error before deciding on an action.",
        "Review the selected count and choose Archive selected or Delete selected. Read the confirmation carefully; archival preserves stored conversations, while confirmed deletion permanently removes eligible chats and attachments.",
        "Inspect the resulting action status and skipped records. Under Legal holds, create a named hold for the selected chats or review active holds. Releasing a hold requires confirmation and starts a new review window before eligible records can be deleted.",
      ]),
      note("warning", "A suggested client or sensitive-data label is not a confirmed retention source. Automatic cleanup covers saved chats, linked uploads and image previews, search entries, and chat feedback. Draft documents, learned memories, audit and usage records, generated-media storage, backups, external providers, and exported files have separate lifecycles; this control is not a complete client-erasure or regulatory-compliance guarantee."),
    ],
  },
  {
    id: "owner-analytics",
    part: "owner",
    minRole: "owner",
    title: "Analytics: runtime, feedback, activity, and usage",
    summary: "Authoritative execution timestamps, feedback, prompt volume, and per-user usage.",
    blocks: [
      p(
        "The Analytics tab carries four panels, and each panel scopes itself: a filter row at the top of every section pairs a user picker with a date range and its presets (All, Today, Week, 30 days), so narrowing one section never hides data in another. The filter's counter reads how many records the scope selected — for example “65 of 65 records”. Three panels carry their own CSV export controls, and each CSV button opens an independent date-range popover so a file contains exactly the rows you chose.",
      ),
      list([
        "Runtime Clock Metadata — authoritative execution timestamps captured from chat and draft completion audit events, not client guesses. The scorecards total the runtime events, split between main chat completions and draft generation and revision calls, and each event lists who ran it, which provider served it, how many messages were involved, and the exact client start time.",
        "Chat Feedback Analytics — response-level thumbs up and thumbs down signals submitted from chat actions, totaled by sentiment.",
        "Model Activity — saved prompt volume by model, date, and user for its filter's scope, drawn as “Prompts by model”, “Prompt trend”, and “Users by prompt activity”.",
        "User Usage — durable per-user usage from real completions across chat, drafts, agents, automations, and the API gateway, with provider-reported token counts only. The owner view is the complete one: its user picker reads All owners, admins, and users — unlike the admin console's version, which excludes platform-owner usage. The Usage by user section at the bottom ranks everyone in a contained, scrollable list; pick a person from its selector — or click their row — to focus the whole panel on them.",
      ]),
    ],
  },
  {
    id: "owner-automation-readiness",
    part: "owner",
    minRole: "owner",
    title: "Automation readiness and governance",
    summary: "The owner-level controls that make scheduled model chains reliable.",
    blocks: [
      p(
        "Automations depend on the same governance stack as chat: provider health, vaulted keys, enabled models, tenant group grants, connector policy, and the workspace usage budget. Owners do not usually build every tenant's automation, but they set the ceiling that determines whether scheduled runs can work at all.",
      ),
      steps([
        "In Providers, confirm each gateway a schedule depends on shows Connected — not Needs key, and not Adapter needed (a Bedrock provider registers but cannot serve runs until its adapter ships).",
        "Open API Keys on each provider card and replace invalid or expired keys before teams build scheduled workflows around them.",
        "In Models, enable only the routes the organization has reviewed — newly synced models start disabled, and disabled models never flow to tenant admins or user automations.",
        "In Org Settings → Connectors, configure and test the shared sources a schedule needs and keep their enable switches aligned with approved use. Check the Workspace Usage Budget: once the ceiling is spent, completions — scheduled ones included — are refused (the API answers with HTTP 429) until the period resets, and a refused run is recorded as failed rather than retried automatically.",
        "In Analytics and Audit, review automation-related chat/runtime events the same way you review normal completions: who ran it, which provider served it, and whether the run produced the expected output.",
      ]),
      note(
        "tip",
        "For a new deployment, include one automation smoke test: create a weekly one-step run on an approved model, press Run now, confirm the transcript succeeds, then restart the API and verify the automation card and last-run status persist.",
      ),
    ],
  },
  {
    id: "owner-audit",
    part: "owner",
    minRole: "owner",
    title: "Audit: owner governance signals",
    summary: "Posture tiles, prompt monitoring, security alerts, and the platform trail.",
    blocks: [
      p(
        "The Audit tab opens on the Owner Audit posture dashboard; the sections below it start collapsed — click a section header to expand it. User Prompt Activity, Security Alerts, and the Audit Trail each carry their own filter row pairing a user picker with a date range, so one section's scope never narrows another. The CSV export buttons produce files of exactly the filtered rows — with actor columns, so every exported row names who acted.",
      ),
      list([
        "Owner Audit condenses governance posture into tiles: Critical events, provider posture, the model ceiling, vault metadata, approvals awaiting review, Connectors, expired keys, connector issues, unscoped models, privileged owners, stale syncs, and the prompt watchlist of active DLP or misuse alerts. Hover a tile to see exactly what it counts.",
        "Recent Governance Activity lists the latest owner-relevant events from the current snapshot — model availability reviews, provider catalog status, vault metadata, Connector availability, and Agent approval activity — so exceptions become follow-ups instead of surprises.",
        "User Prompt Activity drills into saved user prompts by person, thread, model, and timestamp — the owner-scope view of what is actually being asked across the platform, narrowed by its own user and date filter.",
        "Security Alerts lists DLP and malicious-behavior flags raised from actual prompts, with redacted snippets for review and Acknowledge / Reopen actions, scoped by its own filter row.",
        "The Audit Trail is the append-only transaction log of platform and tenant mutations, newest first. On top of its user and date filter, its toolbar has a severity select, an action-category select, and a search box (Search actions, people, targets…) that narrow the rows together.",
      ]),
      note(
        "tip",
        "Read the tiles first. Anything unexpected — an expired key, an unscoped model — has a matching tab in this console where you can fix it, and this guide's matching section tells you how.",
      ),
    ],
  },
  {
    id: "owner-alerts",
    part: "owner",
    minRole: "owner",
    title: "Alerts: email delivery and platform-wide rules",
    summary: "Configure SMTP once, watch platform-wide activity, and read honest delivery logs.",
    blocks: [
      p(
        "The owner Alerts tab is the full version of the alerting station: you own the email configuration, your rules watch platform-wide audit activity, and every rule in the organization is listed with its scope. Alerts are always logged in-app regardless of email.",
      ),
      sub("Email Delivery: configuring SMTP"),
      steps([
        "Fill in the SMTP host and Port, and pick the security mode — STARTTLS, SSL/TLS, or unencrypted.",
        "Enter the username and password. The password is stored in the encrypted vault and never shown again; the field's placeholder confirms when one is stored.",
        "Set the From address alert emails will come from, then click Save Email Settings.",
        "Prove it works: enter a test recipient and click Send test email. It sends a real message through the saved settings and reports the genuine result — including the SMTP error if it fails.",
      ]),
      sub("Alert Rules"),
      list([
        "Rules work exactly as described in the Administrator Guide — Suspicious-activity template or New rule, with action patterns, a Minimum severity, an optional Watched user, a threshold within a window, a cooldown, and email recipients (empty recipients means in-app only).",
        "Owner rules are platform-wide: they watch audit activity across the whole organization, including owner actions. Tenant rules created by admins appear in the same list, each labeled with its scope, so you always see the full alerting picture.",
      ]),
      sub("Alert Deliveries"),
      p(
        "Every alert trigger is listed with its real delivery status — sent, queued, failed with the actual SMTP error, email not configured, or logged in-app — and the log exports to CSV, archived deliveries included. Click Archive on a delivery to clear it from the default view without deleting its history; Show archived reveals archived deliveries for review or Restore. Owners can archive any delivery, platform-scope ones included.",
      ),
    ],
  },
];

const ROLE_RANK = { user: 0, admin: 1, owner: 2 };

const GUIDES = {
  user: {
    file: "aperture-user-guide",
    docTitle: "User Guide",
    badge: "For every user",
    subtitle:
      "Everything you need to work in Aperture Chat: chat, model access, personalization memory, documents and decks, account sync, agents, knowledge and tools, automations, search, and account security. No prior knowledge assumed.",
  },
  admin: {
    file: "aperture-admin-guide",
    docTitle: "Administrator Guide",
    badge: "For workspace administrators",
    subtitle:
      "The complete User Guide, plus the Admin console: accounts, groups, model access requests and diagnostics, response actions, single sign-on, analytics, token budgets, the tenant audit trail, and alerts. No prior knowledge assumed.",
  },
  owner: {
    file: "aperture-owner-guide",
    docTitle: "Platform Owner Guide",
    badge: "For platform owners",
    subtitle:
      "The complete User and Administrator Guides, plus first-run guidance, providers and shared connectors, the API key vault, organization model availability, SSO and MFA policy, branding, search indexing, budgets, releases, analytics, audit, and alerts. No prior knowledge assumed.",
  },
};

function sectionsForRole(role) {
  const rank = ROLE_RANK[role];
  return SECTIONS.filter((section) => ROLE_RANK[section.minRole] <= rank);
}

function partsForRole(role) {
  const rank = ROLE_RANK[role];
  return PARTS.filter((part) => ROLE_RANK[part.minRole] <= rank);
}

module.exports = { GUIDES, PARTS, SECTIONS, sectionsForRole, partsForRole };
