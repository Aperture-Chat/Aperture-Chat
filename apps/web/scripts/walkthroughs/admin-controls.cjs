/* Workspace controls in the Admin console, performed for real.
 *
 * admin-policies: read Policy Controls, grant one Default Users capability
 * and confirm it in the group, change the memory retention, purge a person's
 * synthetic memories through the confirmation, and record the Memory
 * governance panel while the platform owner has memory off (the owner switch
 * is setup through the API and restored afterwards).
 * admin-tools: build a script response action, run its test, save it for one
 * group, use it on a real assistant reply as a member of that group, edit it,
 * and switch it to Draft; then show where connections are signed in
 * (Library › Tools). The capture cannot complete a third-party OAuth sign-in,
 * so that last step is shown up to the provider hand-off only.
 */
const { helpers } = require("./admin-shared.cjs");

const { tidyFixture, scrollTo, toast, dismissToast, openTab, expandPanel } = helpers;

const adminPolicies = {
  role: "admin",
  description: "Policy Controls, a Default Users grant, memory retention, a purge, and memory unavailable.",
  frames: [
    "admin/pol-collapsed", "admin/pol-status", "admin/pol-defaults", "admin/pol-default-saved", "admin/pol-verify",
    "admin/pol-memory", "admin/pol-memory-saved", "admin/pol-purge-confirm", "admin/pol-purged", "admin/pol-memory-off",
  ],
  async run(kit) {
    const { shot } = kit;
    await tidyFixture(kit);
    const settings = await kit.api("owner", "GET", "/api/platform/settings");
    if (!settings.memory_enabled) await kit.api("owner", "PATCH", "/api/platform/settings", { memory_enabled: true });
    const stats = await kit.api("admin", "GET", "/api/admin/memory/stats");
    if (!stats.some((stat) => stat.user_id === "user-jane" && stat.count > 0)) throw new Error("Jane needs saved synthetic memories to purge.");
    const memory = await kit.api("admin", "GET", "/api/admin/memory/policy");
    if (memory.retention_days !== 365) await kit.api("admin", "PATCH", "/api/admin/memory/policy", { retention_days: 365 });

    const page = kit.use(await kit.app("admin", "/admin/users"));
    await openTab(page, "Policies");
    await page.locator(".panel").filter({ hasText: "Policy Controls" }).first().waitFor();
    await shot("pol-collapsed");

    // 1. Policy Controls: what the service policy allows, then the defaults.
    const controls = await expandPanel(page, "Policy Controls");
    await scrollTo(page, controls, "start");
    await shot("pol-status");
    const defaultsCallout = controls.locator(".policy-callout").filter({ hasText: "Downstream defaults apply" });
    await scrollTo(page, defaultsCallout, "start");
    await shot("pol-defaults");
    const knowledge = controls.getByRole("switch", { name: "Default users can build knowledge bases" });
    if ((await knowledge.getAttribute("aria-checked")) === "true") {
      await knowledge.click();
      await toast(page, "Default user policy saved.");
    }
    await knowledge.click();
    await toast(page, "Default user policy saved.");
    await scrollTo(page, controls.locator(".policy-toggle-row").filter({ hasText: "Default users can build knowledge bases" }), "center");
    await shot("pol-default-saved");
    await dismissToast(page);

    // 2. The same grant, seen from the protected group.
    await openTab(page, "Groups");
    const defaults = page.locator(".managed-group-card").filter({ hasText: "Default Users" });
    await defaults.getByRole("button", { name: "Manage" }).click();
    const editor = page.locator(".selected-group-panel");
    await editor.getByRole("tab", { name: "Permissions" }).click();
    const row = editor.locator(".permission-row").filter({ hasText: "Can build knowledge bases" });
    if ((await row.getByRole("switch").getAttribute("aria-checked")) !== "true") throw new Error("The Default Users grant did not reach the group.");
    await scrollTo(page, row, "center");
    await shot("pol-verify");

    // 3. Personalization Memory: change the retention.
    await openTab(page, "Policies");
    const memoryPanel = await expandPanel(page, "Personalization Memory");
    await scrollTo(page, memoryPanel, "start");
    await shot("pol-memory");
    const retention = memoryPanel.getByLabel("Retention (days)");
    await retention.fill("180");
    await retention.press("Enter");
    await toast(page, "Memory policy saved.");
    await scrollTo(page, memoryPanel, "start");
    await shot("pol-memory-saved");
    await dismissToast(page);

    // 4. Memory by User: counts only, and a purge behind a confirmation.
    const counts = await expandPanel(page, "Memory by User");
    await counts.getByRole("button", { name: "Refresh" }).click();
    const jane = counts.locator(".memory-stat-row").filter({ hasText: "Jane Smith" });
    await jane.waitFor();
    await jane.getByRole("button", { name: "Purge" }).click();
    await jane.getByText(/Purge all \d+\? This cannot be undone\./).waitFor();
    await scrollTo(page, counts, "center");
    await shot("pol-purge-confirm");
    await jane.getByRole("button", { name: "Yes, purge" }).click();
    await toast(page, /Deleted \d+ memor(y|ies) for Jane Smith\./);
    await shot("pol-purged");

    // 5. When the platform owner turns memory off, the panels give way.
    await kit.api("owner", "PATCH", "/api/platform/settings", { memory_enabled: false });
    try {
      await page.reload();
      await page.getByRole("tablist", { name: "Admin sections" }).waitFor();
      await openTab(page, "Policies");
      const governance = page.locator(".panel").filter({ hasText: "Memory governance" }).first();
      await governance.waitFor();
      const toggle = governance.locator(".panel-header .panel-collapse-button").first();
      if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      await governance.getByText("Personalization memory is unavailable under the current service policy.", { exact: false }).waitFor();
      await scrollTo(page, governance, "center");
      await shot("pol-memory-off");
    } finally {
      await kit.api("owner", "PATCH", "/api/platform/settings", { memory_enabled: true });
    }
  },
};

const ACTION = "Checklist";
const SCRIPT = [
  "import sys",
  "",
  "# Each non-empty line of the response becomes one checklist item.",
  "lines = [line.strip(\" -*\\t\") for line in sys.stdin.read().splitlines() if line.strip()]",
  "for number, line in enumerate(lines, 1):",
  "    print(f\"{number}. [ ] {line}\")",
].join("\n");

const adminTools = {
  role: "admin",
  description: "Build, test, save, use, edit, and draft a response action; locate connection sign-in.",
  frames: [
    "admin/tools-panel", "admin/tools-builder", "admin/tools-builder-filled", "admin/tools-test-run", "admin/tools-saved",
    "admin/tools-user-button", "admin/tools-user-result", "admin/tools-edit", "admin/tools-draft", "admin/tools-connections",
    "admin/tools-connection-signin",
  ],
  async run(kit) {
    const { shot } = kit;
    // Remove an action left by an earlier run (setup only).
    for (const tool of await kit.api("admin", "GET", "/api/admin/tool-configs")) {
      if (tool.name === ACTION) await kit.api("admin", "DELETE", `/api/admin/tool-configs/${tool.id}`);
    }

    const page = kit.use(await kit.app("admin", "/admin/users"));
    await openTab(page, "Connections");
    const panel = page.locator(".panel").filter({ hasText: "Chat output actions" }).first();
    await panel.waitFor();
    await shot("tools-panel");

    // 1. The builder.
    await panel.getByRole("button", { name: "New response action" }).click();
    const builder = page.locator(".custom-tool-modal");
    await builder.waitFor();
    await shot("tools-builder");
    await builder.getByLabel("Action name").fill(ACTION);
    await builder.getByLabel("Description").fill("Turns the response into a numbered checklist you can copy.");
    await builder.locator("textarea.custom-tool-script").fill(SCRIPT);
    await builder.getByLabel("Allow Litigation to run this response action").check();
    await scrollTo(page, builder.getByLabel("Action name"), "start");
    await shot("tools-builder-filled");

    // 2. Test run with sample text.
    const sample = builder.getByLabel("Test input for the script");
    await sample.fill("Confirm the vendor's insurance certificate\nReview the data-processing terms\nSchedule the renewal call");
    await builder.getByRole("button", { name: "Run test" }).click();
    const result = builder.locator(".custom-tool-test-result");
    await result.getByText(/Finished in \d+ ms\./).waitFor({ timeout: 30000 });
    await scrollTo(page, result, "center");
    await shot("tools-test-run");

    // 3. Save: the action is enabled for the chosen group.
    await builder.getByRole("button", { name: "Create action" }).click();
    await toast(page, `${ACTION} saved and available to models and chat.`);
    const row = panel.locator(".permission-row").filter({ hasText: ACTION });
    await row.waitFor();
    await scrollTo(page, row, "center");
    await shot("tools-saved");

    // 4. A member of the group uses it on a real assistant reply.
    const user = kit.use(await kit.app("user", "/"));
    const recent = user.locator("nav[aria-label='Primary'] a, .sidebar-chat-row a, .chat-list-item").filter({ hasText: "Synthetic training — vendor review checklist" }).first();
    if (await recent.count()) await recent.click();
    else await user.getByText("Synthetic training — vendor review checklist").first().click();
    const actions = user.locator(".message-custom-tool-actions").last();
    await actions.waitFor({ timeout: 30000 });
    const button = actions.getByRole("button", { name: `Use response action ${ACTION} on this response` });
    await button.waitFor();
    await scrollTo(user, actions, "center");
    await shot("tools-user-button");
    await button.click();
    const run = user.getByRole("dialog", { name: `${ACTION} result` });
    await run.getByText(/Finished in \d+ ms\./).waitFor({ timeout: 30000 });
    await shot("tools-user-result");

    // 5. Edit it, then switch it to Draft.
    kit.use(page);
    await row.getByRole("button", { name: `Edit ${ACTION}` }).click();
    await builder.waitFor();
    await builder.getByLabel("Timeout (seconds, 1–30)").fill("15");
    await scrollTo(page, builder.getByLabel("Action name"), "start");
    await shot("tools-edit");
    await builder.getByRole("button", { name: "Save changes" }).click();
    await toast(page, `${ACTION} saved and available to models and chat.`);
    await row.getByRole("switch", { name: `Enable ${ACTION}` }).click();
    await toast(page, `${ACTION} tool state synced with the admin API.`);
    await row.getByText("Draft").waitFor();
    await scrollTo(page, row, "center");
    await shot("tools-draft");
    // A Draft action no longer appears on replies (verified, not captured).
    await user.reload();
    await user.locator(".assistant-message").last().waitFor();
    await user.waitForTimeout(1500);
    if (await user.getByRole("button", { name: `Use response action ${ACTION} on this response` }).count()) throw new Error("A Draft action still shows on replies.");

    // 6. Connections are added and signed in from Library › Tools.
    const library = kit.use(await kit.app("admin", "/library"));
    await library.getByRole("button", { name: "Tools", exact: true }).click();
    const cards = library.locator(".tool-card, article").filter({ hasText: "Hermes Agent MCP" }).first();
    await cards.waitFor();
    await shot("tools-connections");
    await cards.getByRole("button", { name: "Edit" }).click();
    await library.getByRole("tab", { name: "Sign-in" }).or(library.getByRole("button", { name: "Sign-in", exact: true })).first().click();
    const signIn = library.getByRole("button", { name: "Connect with provider" });
    await signIn.waitFor();
    await scrollTo(library, signIn, "center");
    await shot("tools-connection-signin");
  },
};

module.exports = { "admin-policies": adminPolicies, "admin-tools": adminTools };
