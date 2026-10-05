/* Renders a role guide (content.js) to a print-ready HTML document.
 * The palette, radii, and type mirror apps/web/src/styles.css so the PDFs
 * read as part of the product. Rendered to PDF by generate.cjs.
 */

const { GUIDES, partsForRole, sectionsForRole } = require("./content.cjs");
const { parseDeck } = require("../training-catalog.cjs");
const fs = require("node:fs");
const path = require("node:path");

/* Lesson blocks print the same prerequisites, steps, checks, and fixes that
 * the narrated walkthrough shows, read from the training decks, so the guide
 * and the video cannot describe different procedures. */
const LESSONS = Object.fromEntries(["user", "admin", "owner"].map((role) => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/components/trainingDecks", `${role}.tsx`), "utf8");
  return [role, new Map(parseDeck(source, role).map((lesson) => [lesson.id, lesson]))];
}));
const WATCH_IN = {
  user: "Help › Learn",
  admin: "Admin console › Documentation",
  owner: "Platform console › Documentation",
};

function lessonFor(role, id) {
  const lesson = LESSONS[role]?.get(id);
  if (!lesson) throw new Error(`Guide references an unknown ${role} walkthrough: ${id}`);
  return lesson;
}

function renderLesson(block) {
  const lesson = lessonFor(block.role, block.id);
  const seconds = lesson.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const minutes = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const list = (items, className = "plain") => `<ul class="${className}">${items.map((item) => `<li>${richText(item)}</li>`).join("")}</ul>`;
  const steps = (items) => `<ol class="steps">${items.map((item) => `<li>${richText(item)}</li>`).join("")}</ol>`;
  const parts = [
    `<div class="lesson-head"><span class="lesson-kicker">Walkthrough · ${minutes} · ${escapeHtml(WATCH_IN[block.role])}</span><strong>${escapeHtml(lesson.title)}</strong><span>${escapeHtml(lesson.description || "")}</span></div>`,
  ];
  if (lesson.prerequisites.length) parts.push(`<h4>Before you begin</h4>${list(lesson.prerequisites)}`);
  if (lesson.setup_steps.length) parts.push(`<h4>Step by step</h4>${steps(lesson.setup_steps)}`);
  for (const route of lesson.paths) parts.push(`<h4>Path: ${escapeHtml(route.label)}</h4>${steps(route.steps)}`);
  if (lesson.verify.length) parts.push(`<h4>Check that it worked</h4>${list(lesson.verify, "checks")}`);
  if (lesson.troubleshooting.length) {
    parts.push(`<h4>Troubleshooting</h4><table class="ref wrap-first"><thead><tr><th>What you see</th><th>What to do</th></tr></thead><tbody>${lesson.troubleshooting
      .map((item) => `<tr><td>${richText(item.symptom)}</td><td>${richText(item.fix)}</td></tr>`)
      .join("")}</tbody></table>`);
  }
  return `<div class="lesson-box">${parts.join("")}</div>`;
}

// Orientation images share the reviewed training assets, so guides cannot
// silently retain a separate set of screenshots after the interface changes.
const SECTION_FIGURES = {
  layout: ["user/chat-home.png", "The chat workspace: navigation on the left, model selection above, and the message composer in the main area."],
  drafts: ["user/drafts.png", "Drafts combines the document editor with a separate assistant and document controls."],
  "settings-account": ["user/account-security-overview.png", "Your account includes profile settings, password controls, and two-step verification."],
  "admin-overview": ["admin/users-list.png", "The Admin console opens the workspace controls available to your administrator account."],
  "owner-providers": ["owner/pv-overview.png", "Provider cards show the actual connection and model-catalog state."],
  "owner-connectors": ["owner/cn-panel.png", "Shared connector configuration is in the Platform Owner console under Org Settings."],
};

function renderSectionFigure(sectionId) {
  const figure = SECTION_FIGURES[sectionId];
  if (!figure) return "";
  const [frame, caption] = figure;
  const png = fs.readFileSync(path.join(__dirname, "../../public/training", frame));
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`Guide figure is not a PNG: ${frame}`);
  }
  return `<figure class="ui-figure"><img src="data:image/png;base64,${png.toString("base64")}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)} <span>Example workspace with synthetic data.</span></figcaption></figure>`;
}

/* The aperture mark in one flat light teal — the owner wants the documents'
 * logo unified, with none of the light/dark blade split the app gradient has. */
const LOGO_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Aperture">
  <defs>
    <mask id="blade-cutout" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#fff"/><circle cx="32" cy="32" r="6.4" fill="#000"/>
    </mask>
  </defs>
  <g fill="#0aa4b5" opacity=".96" mask="url(#blade-cutout)">
    ${[0, 60, 120, 180, 240, 300]
      .map(
        (deg) =>
          `<path d="M32 8.4 C40.1 9.1 47.2 14.5 49.7 22 C44.2 21.1 39.1 23.8 35.7 29.4 C33.2 24.8 31.4 16.5 32 8.4 Z"${deg ? ` transform="rotate(${deg} 32 32)"` : ""}/>`,
      )
      .join("")}
  </g>
</svg>`;

const CSS = `
  :root {
    --bg: #f4f8f9; --surface: #ffffff; --surface-soft: #f5f9fa; --surface-sunken: #eef4f6;
    --rail-dark: #001f2b; --rail-dark-2: #052b38;
    --text: #0c1a26; --text-strong: #061722; --muted: #5c6b7a; --faint: #8593a2;
    --border: #e2e9ee; --border-strong: #cfdae2;
    --teal: #087d8b; --teal-strong: #006a77; --teal-2: #0aa4b5; --teal-soft: #e6f6f7; --teal-border: #b7dfe5;
    --orange: #b9700a; --orange-soft: #fef4e4; --orange-border: #f0cd95;
    --blue: #2563eb; --blue-soft: #eef4ff; --blue-border: #c4d8fb;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: "Plus Jakarta Sans", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    font-size: 10.4pt; line-height: 1.58; color: var(--text);
    font-feature-settings: "cv01", "ss01"; text-rendering: optimizeLegibility;
  }
  code { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 0.86em;
    background: var(--surface-sunken); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
  a { color: var(--teal-strong); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
  .sec-marker { position: absolute; font-size: 2px; color: #fff; }

  /* ---- cover ---- */
  .cover { height: 9.05in; display: flex; flex-direction: column; page-break-after: always; position: relative; }
  .cover-brandline { display: flex; align-items: center; gap: 12px; }
  .cover-brandline svg { width: 44px; height: 44px; }
  .cover-brandline strong { font-size: 15pt; font-weight: 800; letter-spacing: -0.01em; color: var(--text-strong); }
  .cover-brandline span { font-size: 9pt; color: var(--muted); display: block; margin-top: 1px; }
  .cover-main { margin-top: auto; }
  .cover-badge { display: inline-block; background: var(--teal-soft); border: 1px solid var(--teal-border);
    color: var(--teal-strong); font-weight: 700; font-size: 9.5pt; border-radius: 999px; padding: 4px 14px; }
  .cover h1 { font-size: 34pt; font-weight: 800; letter-spacing: -0.02em; color: var(--text-strong);
    margin: 14px 0 4px; line-height: 1.12; }
  .cover .cover-product { font-size: 15pt; font-weight: 700; color: var(--teal-strong); margin-bottom: 18px; }
  .cover .cover-sub { font-size: 11.5pt; color: var(--muted); max-width: 5.9in; line-height: 1.6; }
  .cover-meta { margin-top: auto; padding-top: 24px; border-top: 3px solid var(--teal); display: flex;
    justify-content: space-between; font-size: 9pt; color: var(--faint); }
  .cover-rule { position: absolute; top: 84px; left: 0; right: 0; height: 1px; background: var(--border); }

  /* ---- table of contents ---- */
  .toc { page-break-after: always; }
  .toc h2 { font-size: 17pt; font-weight: 800; letter-spacing: -0.01em; color: var(--text-strong); margin-bottom: 12px; }
  .toc-part { margin: 12px 0 4px; font-size: 8.5pt; font-weight: 800; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--teal-strong); break-after: avoid; page-break-after: avoid; }
  .toc-row { display: flex; align-items: baseline; gap: 8px; padding: 1.8px 0; font-size: 10.2pt;
    break-inside: avoid; page-break-inside: avoid; }
  .toc-row .toc-num { color: var(--faint); min-width: 22px; font-variant-numeric: tabular-nums; }
  .toc-row .toc-title { font-weight: 600; color: var(--text); }
  .toc-row .toc-dots { flex: 1; border-bottom: 1.5px dotted var(--border-strong); transform: translateY(-3px); }
  .toc-row .toc-page { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 20px; text-align: right; }

  /* ---- part banners ---- */
  .part-banner { page-break-before: always; break-before: page; margin-bottom: 22px;
    background: linear-gradient(120deg, var(--rail-dark), var(--rail-dark-2)); border-radius: 14px;
    padding: 20px 24px; color: #eaf6f8; position: relative; overflow: hidden; }
  .part-banner::after { content: ""; position: absolute; inset: 0; border-radius: 14px;
    border: 1px solid rgba(10, 164, 181, 0.45); pointer-events: none; }
  .part-banner .part-kicker { font-size: 8.5pt; font-weight: 800; letter-spacing: 0.12em;
    text-transform: uppercase; color: #7fd6e0; }
  .part-banner h2 { font-size: 16pt; font-weight: 800; letter-spacing: -0.01em; margin-top: 2px; color: #f4fbfc; }

  /* ---- sections ---- */
  .doc-section { margin-bottom: 26px; position: relative; }
  .doc-section[data-section="help"] { break-inside: avoid; page-break-inside: avoid; }
  .section-intro { position: relative; break-inside: avoid; page-break-inside: avoid;
    break-after: avoid; page-break-after: avoid; }
  .doc-section h3 { font-size: 13.5pt; font-weight: 800; letter-spacing: -0.01em; color: var(--text-strong);
    display: flex; align-items: baseline; gap: 10px; break-after: avoid; page-break-after: avoid; }
  .doc-section h3 .sec-num { color: var(--teal); font-variant-numeric: tabular-nums; }
  .doc-summary { color: var(--muted); font-size: 10.2pt; margin: 3px 0 10px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border); break-after: avoid; page-break-after: avoid; }
  .doc-section h4 { font-size: 10.8pt; font-weight: 700; color: var(--text-strong); margin: 13px 0 5px;
    break-after: avoid; page-break-after: avoid; }
  .doc-section p { margin: 7px 0; }
  .ui-figure { margin: 12px 0 16px; break-inside: avoid; page-break-inside: avoid; }
  .lesson-box { margin: 12px 0 14px; padding: 12px 16px 6px; border: 1px solid var(--teal-border); border-radius: 12px;
    background: linear-gradient(180deg, var(--teal-soft), var(--surface) 64px); }
  .lesson-head { display: grid; gap: 3px; padding-bottom: 6px; border-bottom: 1px solid var(--teal-border); margin-bottom: 4px; break-inside: avoid; }
  .lesson-kicker { font-size: 7.8pt; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal-strong); }
  .lesson-head strong { font-size: 11.6pt; color: var(--text-strong); }
  .lesson-head span:last-child { font-size: 9.4pt; color: var(--muted); }
  .lesson-box h4 { break-after: avoid; }
  ul.checks { list-style: none; margin: 6px 0 8px; }
  ul.checks li { position: relative; padding: 0 0 5px 22px; break-inside: avoid; }
  ul.checks li::before { content: "✓"; position: absolute; left: 4px; top: 0; color: var(--teal); font-weight: 800; }
  .ui-figure img { display: block; width: 100%; max-height: 3.8in; object-fit: contain;
    border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface-sunken); }
  .ui-figure figcaption { margin-top: 6px; font-size: 8.4pt; line-height: 1.45; color: var(--muted); }
  .ui-figure figcaption span { color: var(--faint); }
  ol.steps { list-style: none; counter-reset: step; margin: 8px 0; }
  ol.steps li { counter-increment: step; position: relative; padding: 0 0 8px 34px; break-inside: avoid; }
  ol.steps li::before { content: counter(step); position: absolute; left: 0; top: 1px; width: 21px; height: 21px;
    border-radius: 999px; background: var(--teal-soft); border: 1px solid var(--teal-border); color: var(--teal-strong);
    font-size: 9pt; font-weight: 800; display: flex; align-items: center; justify-content: center; }
  ul.plain { margin: 7px 0 7px 4px; list-style: none; }
  ul.plain li { position: relative; padding: 0 0 6px 18px; break-inside: avoid; }
  ul.plain li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 6px; height: 6px;
    border-radius: 999px; background: var(--teal-2); }
  .note { border-radius: 10px; padding: 10px 14px 10px 14px; margin: 10px 0; font-size: 9.8pt;
    break-inside: avoid; page-break-inside: avoid; border: 1px solid; }
  .note .note-label { display: block; font-size: 8pt; font-weight: 800; letter-spacing: 0.09em;
    text-transform: uppercase; margin-bottom: 2px; }
  .note-tip { background: var(--teal-soft); border-color: var(--teal-border); }
  .note-tip .note-label { color: var(--teal-strong); }
  .note-info { background: var(--blue-soft); border-color: var(--blue-border); }
  .note-info .note-label { color: var(--blue); }
  .note-warning { background: var(--orange-soft); border-color: var(--orange-border); }
  .note-warning .note-label { color: var(--orange); }
  table.ref { width: 100%; border-collapse: separate; border-spacing: 0; margin: 10px 0; font-size: 9.8pt;
    break-inside: avoid; page-break-inside: avoid; }
  table.ref th { text-align: left; background: var(--surface-sunken); color: var(--text-strong); font-size: 8.6pt;
    font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 7px 10px;
    border-bottom: 1.5px solid var(--border-strong); }
  table.ref td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  table.ref tr td:first-child, table.ref tr th:first-child { padding-left: 12px; }
  table.ref th:first-child { border-top-left-radius: 8px; }
  table.ref th:last-child { border-top-right-radius: 8px; }
  table.ref td:first-child { font-weight: 700; color: var(--text-strong); white-space: nowrap; }
  table.ref.wrap-first td:first-child { white-space: normal; }
`;

const escapeHtml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/* Bold the exact UI labels the prose calls out. Kept deliberately dumb: the
 * content marks labels by matching them against this list. */
const UI_LABELS = [
  /* navigation and shell */
  "Continue with SSO", "Password", "New chat", "Drafts", "Agents", "Library", "Chats", "Folders", "Pinned",
  "Recent", "View all chats", "Search past work", "Search", "Help", "Dark mode", "Light mode", "Install app",
  "Management", "Admin console", "Platform owner console", "View as", "Usage this month", "Archived chats",
  "Sign out", "Save profile", "Cancel", "Create", "Profile", "Account", "Share",
  "Security", "Manage security", "Set up authenticator", "Verify authenticator", "Authenticator code",
  "Copy recovery codes", "Replace recovery codes", "Turn off verification", "Verify and enable MFA",
  "Begin authenticator setup", "Use a recovery code instead", "Theme schedule", "Switch automatically",
  "Light mode at", "Dark mode at", "Save schedule", "Only on this device", "Retry all", "Open Drafts",
  "Clear list", "Hide this reminder", "Import to my account", "Commands",
  /* chat */
  "Ask anything...", "Shift+Enter", "Web search", "Tools", "Knowledge", "Web", "Agent", "Chat", "Send now",
  "Reasoning", "Fast", "Smart", "Copy", "Branch", "Regenerate response", "Stop this response", "Edit message",
  "Load prompt in new chat", "Transfer to Drafts", "Download", "PNG", "SVG", "Code", "Upload from computer",
  "Web page by link", "Attach from source", "Messages and model", "Token usage", "Sources gathered",
  "Context window", "Tokens used", "Current chat", "Agent profile",
  "Models in your organization", "Usable now", "Not available to you", "Provider offline", "Locked",
  "Request access", "Withdraw request", "Refresh model access", "Why isn't a model listed?",
  "MCP connections and resources", "Find a resource", "Stream replies", "Type shortcuts in chat",
  "Send options", "Reply settings", "Resources", "Interactive platform guide", "Admin documentation", "Chat help",
  /* drafts and decks */
  "Draft format", "Document", "Deck", "Text size", "Superscript", "Subscript", "Highlight", "Clear formatting",
  "Web image", "Chart", "Table", "Divider", "Page break", "Inline AI edit", "Save version", "Compare versions",
  "Export deck", "Export", "Word document", "Markdown outline", "Markdown", "PowerPoint deck",
  "Print / Save as PDF", "Save your edits first", "Save version and export", "Save version and print",
  "Start a blank deck", "Convert into slides", "Add slide", "Title + bullets", "Title", "Two columns",
  "Image + caption", "Quote", "Section", "Closing", "Ask AI", "Edit slide with AI", "Apply to slide",
  "Improve writing", "Make shorter", "Make longer", "Continue writing", "Summarize the document", "Insert below",
  "Try again", "Replace", "Discard", "Changes", "Result", "Outline", "Find and replace", "Match case",
  "Keyboard shortcuts", "Copy document", "Copy deck outline", "Layouts", "Themes", "Slide sorter",
  "Presenter view", "Deck starters &amp; brand themes", "Make it punchier", "Write speaker notes",
  "Fix spelling &amp; grammar", "Simplify language", "Turn into a bulleted list", "Turn into a table",
  "Use active voice", "Improve this slide", "Cut the text in half", "Pick a better layout", "Split into two slides",
  "Generate AI slide image", "Generate image", "Toggle AI slide images", "Use templates in chat",
  "Upload brand template", "Apply to deck", "Pitch deck", "Quarterly review", "Project kickoff",
  "Client proposal", "Training session", "Upload background…", "Use on every slide", "Remove from this slide",
  "Clear from all slides", "Speaker notes", "Present deck", "Exit", "Notes",
  "Text", "Paragraph", "More", "Insert", "AI edit trail", "Assistant settings", "Apply MLA layout",
  "Document history", "Draft history", "Archived", "Unarchive", "Choose a location", "Browser downloads",
  /* agents (the tab label matches the HTML-escaped text the renderer bolds) */
  "New Agent", "Prompts &amp; Skills", "Access", "Hermes",
  /* library */
  "Knowledge Bases", "Add Knowledge Base", "Add a web link", "Connect an API", "Tools Library and Connectors",
  "Connections", "Prompts", "Skills", "New Prompt", "New Skill",
  /* automations */
  "New automation", "Run now", "Save automation", "Add step", "Once", "Daily", "Weekly", "Cron expression", "Cron",
  "Draft",
  /* admin console */
  "Users", "Groups", "Model Access", "SSO", "Analytics", "Audit", "Alerts", "Documentation", "Add User",
  "Deactivate", "Activate", "Delete", "Generate", "Temporary password", "Set password", "Pending",
  "Add Group", "Permissions", "Import", "User emails", "Add users to group", "Can use chat",
  "Can use knowledge", "Can use agents", "Can use tools", "Can use API", "Can use Hermes companion",
  "Can build agents", "Sync models", "Choose groups", "Model", "Provider", "User Access", "Filters",
  "Credentials saved", "Saved · disabled", "Needs credentials", "Configure", "Test connection",
  "Connect Google", "Chat output actions", "Add SSO configuration", "Refresh", "Runtime Clock Metadata",
  "Chat Feedback Analytics", "Model Activity", "User Usage", "Workspace Usage Budget", "Token Allocations",
  "Set cap", "Filter analytics by user", "All admins and users", "Filter usage by user", "Filter audit by user",
  "Prompt activity user", "Search actions, people, targets…", "Admin Audit", "Recent Governance Activity",
  "User Prompt Activity", "Security Alerts", "Audit Trail", "Acknowledge", "Reopen", "CSV", "Email Delivery",
  "Alert Rules", "Alert Deliveries", "Suspicious-activity template", "New rule", "Action patterns",
  "Minimum severity", "Watched user", "Archive", "Show archived", "Restore",
  "Access requests", "Grant through group", "Approve", "Decline", "Model access trace",
  "Allowed, provider offline", "Usable", "Blocked",
  /* owner console */
  "Models", "Providers", "API Key Vault", "API Keys", "Org Settings", "Add Provider", "Sync Models",
  "Edit Connection", "Add Key", "Reveal", "Replace", "Edit details", "Connected", "Adapter needed",
  "Needs key", "Catalog scope", "Vault reveal", "Copy key", "Done", "Model lab", "Runtime route",
  "Default group for enabled models", "Default Users", "Role Boundary", "Owners, admins, and users",
  "Create account", "Single Sign-On", "Protocol", "OIDC (supported)", "SCIM base URL", "SCIM",
  "Duo API hostname", "Authenticator app", "Microsoft Authenticator", "Duo Mobile", "Identity provider",
  "Client ID", "Client secret", "Save SSO", "Enforce SSO", "Platform Branding", "Platform logo URL",
  "Browser icon URL", "Platform domain", "Theme colors", "Accent color", "Sidebar gradient start",
  "Sidebar gradient end", "Interface text color", "Upload PNG", "Apply branding", "Reset defaults",
  "Policy Controls", "Always on", "Downstream API access", "Tenant admins can create admins",
  "Require SSO for admins", "Tenant admins can manage SSO mappings", "Users can build their own agents",
  "Budget measure", "Token allowance", "Dollar amount (USD)", "Reset period", "Every day", "Every week",
  "Every month", "Save budget policy", "Elastic Analytics", "Platform Connectors",
  "All owners, admins, and users", "Critical events", "Connector availability", "Agent approval activity",
  "Connectors", "Owner Audit", "SMTP host", "Port", "STARTTLS", "SSL/TLS", "From address",
  "Save Email Settings", "Send test email", "Create the first platform owner",
  "Users can browse the model catalog",
  "Require the platform authenticator after SSO", "Search index", "Rebuild index", "Backfilling",
  /* personal data protection and training datasets */
  "Personal Data Protection", "Conceal personal data", "Hide values from the model too", "What to conceal",
  "Try it with sample text", "Preview concealment", "Where it applies", "Refresh monitor", "Datasets",
  "Training Data Capture", "Capture training signals", "Capture these signals", "Review before export",
  "Skip sensitive or regulated chats", "Conceal people and client names", "Never capture from these groups",
  "Scan existing chats", "Captured Signals", "Suggested datasets", "New dataset", "Training format",
  "Create dataset", "Review Examples", "Approve all shown", "Exclude all shown", "Include examples waiting for review",
];
const LABEL_PATTERN = new RegExp(
  `(?<![\\w>])(${[...UI_LABELS].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w<])`,
  "g",
);
const CODE_PATTERN = /\{\{variables\}\}|\{issuer\}\/\.well-known\/openid-configuration|\{tenant-id\}|0 9 \* \* 1|you@company\.com/g;

function richText(text) {
  /* The product name contains the "Chat" nav label, and "Social Security"
   * contains the "Security" label — shield both from bolding. */
  const BRAND = "BRAND";
  const SSA = "SSA";
  return escapeHtml(text)
    .replaceAll("Aperture Chat", BRAND)
    .replaceAll("Social Security", SSA)
    .replace(CODE_PATTERN, (match) => `<code>${match}</code>`)
    .replace(LABEL_PATTERN, "<strong>$1</strong>")
    .replaceAll(BRAND, "Aperture Chat")
    .replaceAll(SSA, "Social Security")
    .replaceAll("https://aperturechat.com/guide.html", '<a href="https://aperturechat.com/guide.html">https://aperturechat.com/guide.html</a>');
}

function renderBlock(block) {
  switch (block.type) {
    case "p":
      return `<p>${richText(block.text)}</p>`;
    case "sub":
      return `<h4>${richText(block.text)}</h4>`;
    case "steps":
      return `<ol class="steps">${block.items.map((item) => `<li>${richText(item)}</li>`).join("")}</ol>`;
    case "list":
      return `<ul class="plain">${block.items.map((item) => `<li>${richText(item)}</li>`).join("")}</ul>`;
    case "note": {
      const label = block.tone === "warning" ? "Careful" : block.tone === "tip" ? "Tip" : "Good to know";
      return `<div class="note note-${block.tone}"><span class="note-label">${label}</span>${richText(block.text)}</div>`;
    }
    case "table": {
      const wide = block.rows.some((row) => row[0].length > 28);
      return `<table class="ref${wide ? " wrap-first" : ""}"><thead><tr>${block.headers
        .map((header) => `<th>${escapeHtml(header)}</th>`)
        .join("")}</tr></thead><tbody>${block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${richText(cell)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    }
    case "lesson":
      return renderLesson(block);
    default:
      throw new Error(`Unknown guide block type: ${block.type}`);
  }
}

/**
 * @param {"user"|"admin"|"owner"} role
 * @param {Record<string, number>} [pageMap] section id → 1-based page number (second pass)
 */
function renderGuideHtml(role, pageMap = {}) {
  const guide = GUIDES[role];
  const parts = partsForRole(role);
  const sections = sectionsForRole(role);
  const numberOf = new Map(sections.map((section, index) => [section.id, index + 1]));
  const generatedOn = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const toc = parts
    .map((part, partIndex) => {
      const rows = sections
        .filter((section) => section.part === part.id)
        .map(
          (section) => `<div class="toc-row"><span class="toc-num">${numberOf.get(section.id)}</span><span class="toc-title">${escapeHtml(
            section.title,
          )}</span><span class="toc-dots"></span><span class="toc-page">${pageMap[section.id] ?? ""}</span></div>`,
        )
        .join("");
      return `<div class="toc-part">Part ${partIndex + 1} · ${escapeHtml(part.label)}</div>${rows}`;
    })
    .join("");

  const body = parts
    .map((part, partIndex) => {
      const partSections = sections
        .filter((section) => section.part === part.id)
        .map(
          (section) => `<section class="doc-section" data-section="${escapeHtml(section.id)}"><div class="section-intro"><span class="sec-marker">[[s:${section.id}]]</span><h3><span class="sec-num">${numberOf.get(
            section.id,
          )}.</span>${escapeHtml(section.title)}</h3><p class="doc-summary">${escapeHtml(section.summary)}</p>${renderSectionFigure(section.id)}</div>${section.blocks
            .map(renderBlock)
            .join("")}</section>`,
        )
        .join("");
      return `<div class="part-banner"><div class="part-kicker">Part ${partIndex + 1}</div><h2>${escapeHtml(part.label)}</h2></div>${partSections}`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Aperture Chat — ${guide.docTitle}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,500&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="cover">
  <div class="cover-brandline">${LOGO_SVG}<div><strong>Aperture Chat</strong><span>Secure, source-aware answers across your connected workspace</span></div></div>
  <div class="cover-rule"></div>
  <div class="cover-main">
    <span class="cover-badge">${escapeHtml(guide.badge)}</span>
    <h1>${escapeHtml(guide.docTitle)}</h1>
    <div class="cover-product">Aperture Chat</div>
    <p class="cover-sub">${escapeHtml(guide.subtitle)}</p>
  </div>
  <div class="cover-meta"><span>${sections.length} sections · every instruction spelled out step by step</span><span>Generated ${generatedOn}</span></div>
</div>
<div class="toc"><h2>Contents</h2>${toc}</div>
${body}
</body></html>`;
}

module.exports = { renderGuideHtml, GUIDES };
