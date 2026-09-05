/* Measure the UI shown in a frame, in the same CSS-pixel coordinate space as
 * the 1185 x 855 training composition. Selectors use Playwright's locator
 * engine so exact visible text can identify a panel without positional DOM
 * guesses. Nothing in this helper changes the application or scroll position.
 *
 * In a capture script's shot(name), before screenshot():
 *   Object.assign(measured, await measureFrameFocus(page, "owner", name));
 * Save measured-rects.json alongside the staged PNGs. Returned zoom: 1 is
 * intentional: these coordinates describe the complete, newly captured UI,
 * not the historical 4/3 crops in some owner policy scenes.
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const first = (selector) => ({ selector });
const union = (selector) => ({ selector, union: true });
const panel = (title) => `.panel:has(> .panel-header h2:text-is(${JSON.stringify(title)}))`;
const retention = {
  retentionPanel: first(panel("Data Retention")),
  retentionToggles: union(`${panel("Data Retention")} .policy-toggle-row`),
  retentionTagsSwitch: first(".prompt-panel-view-switch"),
  retentionTagsExplorer: union(".retention-tags-toolbar, .retention-batch-bar, .retention-tagged-list"),
  retentionPreview: first(".prompt-output-modal"),
  retentionBatch: first(".retention-batch-bar"),
};

const FOCUS_TARGETS = {
  user: {
    accessRequestForm: first(".auth-access-form"),
    accessRequestReceived: first(".auth-access-success"),
    accessSignInMethod: first(".auth-panel"),
    accessOwnPassword: first(".auth-panel"),
    accessWelcome: first(".first-run-welcome"),
    securityOverview: first(".account-security"),
    securityStart: first(".account-security"),
    securityVerify: union(".account-security input[autocomplete=\"one-time-code\"], .account-security .account-security-actions"),
    securityRecovery: first(".account-security-form"),
    securityReplace: first(".account-security"),
    securityPassword: first(".account-password-card"),
    profileEditor: first(".account-profile-form"),
    appearanceControl: first(".sidebar-bottom"),
    composerShortcuts: first("[role=\"note\"][aria-label=\"Composer shortcuts\"]"),
    mobileNavigation: first("#workspace-navigation"),
    mobileInstall: first(".pwa-install-modal"),
    helpLibrary: first("[role=\"dialog\"][aria-label=\"Help\"]"),
    helpReportForm: first(".issue-report-form"),
    helpReportReceived: first(".issue-report-success"),

    homeComposer: first(".composer"),
    modelSelector: first(".workspace-header .model-select"),
    toolsChip: first(".composer-tools-status"),
    sendButtonsHome: union(".composer .send-button, .composer .send-options-button"),
    micButton: first(".composer .dictation-button"),
    traceCollapsed: first(".pending-trace-header"),
    traceExpanded: first(".pending-trace.is-expanded"),
    responseActions: first(".assistant-message .message-quick-actions"),
    transferDraft: first(".transfer-draft-button"),
    slashMenu: first(".composer-command-menu[role='listbox']"),
    agentMenu: first(".composer-command-menu[role='listbox']"),
    composerField: first(".composer"),
    attachButton: first(".composer button[aria-label='Add attachment']"),
    attachUpload: first(".attach-option:has(strong:text-is('Upload from computer'))"),
    attachWebLink: first(".attach-option:has(strong:text-is('Web page by link'))"),
    attachConnectors: union(".attach-menu-label, .attach-menu-label ~ .attach-option"),
    sendOptionsButton: first(".composer .send-options-button"),
    sendKnowledge: first(".send-option:has(strong:text-is('Knowledge'))"),
    sendWeb: first(".send-option:has(strong:text-is('Web'))"),
    sendAgent: first(".send-option:has(strong:text-is('Agent'))"),
    sendReasoning: first(".send-menu-reasoning"),
    sessionSummary: union(".session-panel .audit-heading:first-child, .session-panel .audit-list > .audit-row"),
    contextWindow: first(".session-panel .context-window-detail"),
    imageReply: first(".message-rendered-response .md-image"),
    imageDownload: first(".md-image-download"),
    mermaidFigure: first(".md-diagram-panel:not(.is-loading):not(.is-deferred)"),
    searchPalette: first(".command-palette-panel"),
    draftModeToggle: first(".deck-mode-switch"),
    draftComposer: first(".draft-command-box"),
    draftModel: first(".document-model-menu"),
    draftToolbar: first(".document-toolbar"),
    draftVersions: union(".document-version-label, .document-save-version-button, .document-compare-button, .document-export-button"),
    deckModeToggle: first(".deck-mode-switch"),
    deckFilmstrip: first(".deck-filmstrip"),
    deckLayoutMenu: first(".deck-layout-menu"),
    deckTemplatesDrawer: first(".draft-template-panel[aria-label='Deck templates']"),
    deckBrandStage: first(".deck-stage"),
    deckAiEdit: first(".inline-ai-popover:has(textarea[aria-label='AI edit instruction'])"),
    deckAiImage: first("[role='dialog'][aria-label='Generate AI slide image']"),
    deckStageWithBg: first(".deck-stage"),
    deckNotes: first(".deck-notes-strip"),
    deckPresent: first(".deck-present-notes"),
    deckExportMenu: first(".document-export-panel"),
    agentsProfile: first(".agent-profile-list > *"),
    agentsNew: first(".agent-workspace-page .console-header button:has-text('New agent')"),
    knowledgeAdd: first(".feature-grid button:has-text('Add Knowledge Base')"),
    knowledgeTable: first(".feature-grid .data-table"),
    toolsHeader: first(".feature-grid > .panel > .panel-header"),
    toolsRows: first(".feature-grid .data-table tbody"),
    automationsTabs: first(".automations-page .console-header [role='group'][aria-label='Agent workspace sections']"),
    automationsNew: first(".automations-page .console-header button:has-text('New automation')"),
    automationsBanner: first(".automations-groundwork-note"),
    automationsCard: first(".automation-card"),
    sidebarFolders: first(".chat-section:has(#sidebar-folders)"),
    sidebarPinned: first(".chat-section:has(#sidebar-pinned)"),
    sidebarPreview: first(".chat-hover-preview"),
    sidebarRowActions: first(".chat-row:hover .chat-row-actions"),
    sidebarUtilities: first(".sidebar-bottom"),
    memoryAccountEntry: first(".account-drawer-list button:has(strong:text-is('Personalization memory'))"),
    memorySettings: first(".memory-settings"),
    memoryAddAndReview: union(".memory-add-row, .memory-list"),
    memoryRecall: first(".assistant-message .message-rendered-response"),
  },
  admin: {
    accessRequestsQueue: first(".access-request-queue"),
    accessSignInHandoff: first(".access-handoff"),
    accessTemporaryPassword: first(".password-reset-modal"),
    accessModelReadiness: first(".model-access-panel"),
    accessFirstReply: first(".assistant-message .message-rendered-response"),
    feedbackOverview: first(panel("Chat Feedback")),
    feedbackEntries: first("[aria-label='Admin chat feedback events']"),
    feedbackConversation: first("[role='dialog'][aria-label='Feedback and conversation']"),
    feedbackIssueReport: first("[role='dialog'][aria-label='Platform issue report']"),
    usersTabs: first("[role='tablist'][aria-label='Admin sections']"),
    usersAdd: first(".user-management-panel button:has-text('Add User')"),
    usersTable: first(".user-management-table"),
    usersActions: union(".user-management-table .user-row-actions"),
    groupsCards: first(".managed-group-list"),
    groupsEditor: first(".selected-group-panel"),
    groupsPermGrid: first(".group-permission-grid"),
    groupsAgentAuthoring: first(".group-permission-grid .permission-row:has(strong:text-is('Can build agents'))"),
    maSync: union(".model-access-panel .model-list-controls > *"),
    maColumns: first(".model-access-table thead"),
    maToggleScope: union(".model-access-table tbody tr:first-child .model-grant-cell, .model-access-table tbody tr:first-child .model-groups-cell"),
    responseOverview: first(panel("Chat output actions")),
    responseCreate: first(`${panel("Chat output actions")} button:has-text('New response action')`),
    connResponseActions: first(panel("Chat output actions")),
    ssoPreset: first(".sso-create-form .connector-config-selector"),
    ssoFields: first(".sso-create-form .connector-config-grid"),
    ssoCreate: union(".sso-create-form .sso-redirect-hint, .sso-create-form .connector-config-actions"),
    ssoPanel: first(panel("SSO and Provisioning")),
    anFilters: first("[aria-label='Runtime events filter']"),
    anRuntime: first(".chat-feedback-panel .feedback-summary-grid"),
    anUsage: first(".model-activity-chart-grid"),
    anBudget: first(".tenant-budget-panel"),
    policyCollapsed: union("[role='tabpanel'][data-state='active'] .panel"),
    policyServiceAvailability: union(".tenant-policy-panel > .policy-callout:nth-child(2), .tenant-policy-panel > .policy-toggle-stack:nth-child(3)"),
    policyDefaults: union(".tenant-policy-panel > .policy-callout:nth-child(4), .tenant-policy-panel > .policy-toggle-stack:nth-child(5)"),
    policyMemory: first(panel("Personalization Memory")),
    policyCounts: first(panel("Memory by User")),
    auCards: first(".audit-summary-grid"),
    auPromptSelect: first("[aria-label='Prompt activity filter']"),
    auTrailFilters: first(".audit-filter-toolbar"),
    alEmail: first(panel("Email Delivery")),
    alRules: first(panel("Alert Rules")),
    alRuleForm: first(".alert-rule-form"),
    alDeliveries: first(panel("Alert Deliveries")),
    ...retention,
  },
  owner: {
    firstOwnerSetup: first(".auth-form"),
    firstOwnerWelcome: first(".first-run-welcome"),
    firstProviderValidated: first(".provider-card:has(.provider-summary > .pill:text-is('Connected'))"),
    firstWorkspaceAccess: union(".owner-management-form, .owner-user-list"),
    firstWorkspaceReply: first(".assistant-message .message-rendered-response"),
    addProvider: first(".provider-connections-panel button:has-text('Add Provider')"),
    providerCard: first(".provider-card"),
    providerStats: union(".provider-card:first-child .provider-summary > .pill, .provider-card:first-child .provider-summary dl"),
    providerCardActions: first(".provider-actions"),
    vaultPanel: first(".provider-keys"),
    vaultKeyRow: first(".provider-keys .key-table tbody tr"),
    vaultKeyActions: first(".provider-keys .key-table tbody tr .table-actions"),
    modelsSearch: union(".model-list-controls > *"),
    modelsColumnFilters: first(".model-list-header"),
    modelsToggle: first(".model-list-row .model-status-cell [role='switch']"),
    rolesDisclosure: first(".owner-control-panel .panel-header"),
    rolesCreateForm: first(".owner-management-form"),
    rolesSetPassword: first(".owner-user-list button[aria-label^='Set a password']:not([disabled])"),
    rolesUserRows: first(".owner-user-list"),
    ssoIntro: first(".sso-requirements-panel .panel-header"),
    ssoProtocol: first(".sso-readiness-grid label:has(select):has-text('Protocol')"),
    ssoFields: first(".sso-readiness-grid"),
    ssoRedirect: first(".sso-redirect-uri"),
    ssoToggles: union(".sso-requirements-panel .permission-row.owner-toggle-row"),
    ssoSaveTest: first(".sso-action-row"),
    ssoEnforce: first(".sso-requirements-panel .permission-row:has-text('Enforce')"),
    brandPreview: first(".branding-preview"),
    brandFields: first(".platform-branding-panel .owner-form-grid"),
    brandThemeColors: first(".branding-theme-fields"),
    brandActions: first(".branding-actions"),
    policyCollapsed: first(".tenant-policy-panel"),
    policyFloor: first(".policy-toggle-stack .permission-row"),
    policyToggles: first(".policy-toggle-stack"),
    budgetControls: first(".budget-control-grid"),
    sharedConnectors: first(panel("Connectors")),
    analyticsFilters: first("[aria-label='Runtime events filter']"),
    runtimeScorecards: first(".chat-feedback-panel .feedback-summary-grid"),
    runtimeRows: first("[aria-label='Runtime clock events']"),
    activityCharts: first(".model-activity-panel .model-activity-chart-grid"),
    usageScorecards: first(".usage-summary-grid"),
    usageCharts: first(`${panel("User Usage")} .model-activity-chart-grid`),
    usageByUser: first("[aria-label='Usage by user']"),
    auditCriticalTile: first(".audit-summary-card"),
    auditTileGrid: first(".audit-summary-grid"),
    auditSecurityAlerts: first("[aria-label='Security alert filter']"),
    trailFilters: first(".audit-filter-toolbar"),
    trailRows: first(".audit-trail-list"),
    alertSmtp: first(panel("Email Delivery")),
    alertRules: first(panel("Alert Rules")),
    alertTemplates: first(`${panel("Alert Rules")} .panel-actions`),
    alertDeliveries: first("[role='list'][aria-label='Alert deliveries']"),
    ...retention,
  },
};

function readFocusRegions(role) {
  if (!Object.hasOwn(FOCUS_TARGETS, role)) throw new Error(`Unknown training role: ${role}`);
  const sourceText = fs.readFileSync(path.join(__dirname, "../src/components/trainingDecks", `${role}.tsx`), "utf8");
  const source = ts.createSourceFile(`${role}.tsx`, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ["FOCUS_REGIONS", `${role.toUpperCase()}_FOCUS_REGIONS`].includes(node.name.getText(source))) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declaration || !ts.isObjectLiteralExpression(declaration.initializer)) throw new Error(`Missing focus regions: ${role}`);
  return Object.fromEntries(declaration.initializer.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) throw new Error(`Invalid focus definition: ${role}`);
    const frame = property.initializer.properties.find((value) => value.name?.getText(source) === "frame");
    if (!frame || !ts.isStringLiteral(frame.initializer)) throw new Error(`Missing focus frame: ${property.name.getText(source)}`);
    return [property.name.getText(source), { frame: frame.initializer.text }];
  }));
}

function assertFocusCoverage(role) {
  const regions = readFocusRegions(role);
  const missing = Object.keys(regions).filter((key) => !FOCUS_TARGETS[role][key]);
  const extra = Object.keys(FOCUS_TARGETS[role]).filter((key) => !regions[key]);
  if (missing.length || extra.length) throw new Error(`${role} focus selectors differ from deck: missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`);
  return regions;
}

async function measureFrameFocus(page, role, frameName, { onlyKeys } = {}) {
  const regions = assertFocusCoverage(role);
  const frame = `training/${role}/${frameName}.png`;
  const viewport = page.viewportSize();
  if (viewport?.width !== 1185 || viewport?.height !== 855) throw new Error("Training focus measurements require the 1185 x 855 CSS-pixel viewport.");
  const measured = {};
  for (const [key, region] of Object.entries(regions)) {
    if (region.frame !== frame || (onlyKeys && !onlyKeys.includes(key))) continue;
    const target = FOCUS_TARGETS[role][key];
    const bounds = await page.locator(target.selector).evaluateAll((elements, options) => {
      const visible = elements.filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      });
      const chosen = options.union ? visible : visible.slice(options.nth || 0, (options.nth || 0) + 1);
      if (!chosen.length) return null;
      // A table cell can have a viewport-space box while being hidden inside
      // a horizontal scroller. Intersect every clipping ancestor so the
      // highlight follows pixels the learner can actually see.
      const rects = chosen.map((element) => {
        const rect = element.getBoundingClientRect();
        let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const clip = ancestor.getBoundingClientRect();
          if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)) {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
        }
        return { left, top, right, bottom };
      }).filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
      if (!rects.length) return null;
      return {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      };
    }, target);
    if (!bounds) throw new Error(`Missing visible training focus ${role}.${key} in ${frameName}: ${target.selector}`);
    const left = Math.max(0, Math.floor(bounds.left - 3));
    const top = Math.max(0, Math.floor(bounds.top - 3));
    const right = Math.min(viewport.width, Math.ceil(bounds.right + 3));
    const bottom = Math.min(viewport.height, Math.ceil(bounds.bottom + 3));
    if (right - left < 8 || bottom - top < 8) throw new Error(`Training focus ${role}.${key} is outside ${frameName}; scroll it into view before capture.`);
    const visibleFraction = ((right - left) * (bottom - top)) / ((bounds.right - bounds.left) * (bounds.bottom - bounds.top));
    if (visibleFraction < 0.15) throw new Error(`Training focus ${role}.${key} is mostly outside ${frameName}; use a dedicated scrolled frame.`);
    measured[key] = { frame, rect: { x: left, y: top, w: right - left, h: bottom - top }, zoom: 1 };
  }
  return measured;
}

module.exports = { FOCUS_TARGETS, readFocusRegions, assertFocusCoverage, measureFrameFocus };

if (require.main === module) {
  for (const role of ["user", "admin", "owner"]) {
    const regions = assertFocusCoverage(role);
    console.log(`${role}: ${Object.keys(regions).length} focus selectors across ${new Set(Object.values(regions).map((region) => region.frame)).size} frames`);
  }
}
