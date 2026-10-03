/* Data retention, tags, and legal holds, performed on the synthetic instance
 * WITHOUT deleting anything. Run from a freshly reset instance.
 *
 * owner-retention opens Data Retention under Audit, adds a matter source,
 * previews (never saves) a seven-year schedule, saves Forever with the new
 * source, scans existing chats for that matter, confirms the label on the
 * matching chat, places it on a legal hold, previews its conversation, and
 * previews the seven-year schedule again to show the hold counted. No finite
 * policy is ever saved, so no record becomes eligible for deletion.
 */
async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

async function retentionPanel(page) {
  const panel = page.locator(".panel").filter({ has: page.locator(".panel-header h2", { hasText: "Data Retention" }) }).first();
  await panel.waitFor();
  const toggle = panel.locator(".panel-collapse-button").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await panel.locator(".retention-view-switch").waitFor();
  await page.waitForTimeout(600);
  return panel;
}

async function previewSevenYears(page, panel) {
  await panel.getByRole("button", { name: "Schedule and rules" }).click();
  await panel.locator(".retention-preset-labels").getByRole("button", { name: "7 years" }).click();
  await panel.getByRole("button", { name: "Preview effect" }).click();
  await panel.locator(".retention-impact").waitFor();
  await page.waitForTimeout(800);
}

const retention = {
  role: "owner",
  description: "Preview a finite schedule without saving it, keep Forever, label a client's chats, and place a legal hold.",
  frames: [
    "owner/rt-navigation", "owner/rt-schedule", "owner/rt-source", "owner/rt-preview", "owner/rt-forever-saved",
    "owner/rt-scan", "owner/rt-confirmed", "owner/rt-hold", "owner/rt-conversation", "owner/rt-preview-held",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/audit");
    const panel = page.locator(".panel").filter({ has: page.locator(".panel-header h2", { hasText: "Data Retention" }) }).first();
    await panel.waitFor();
    await page.waitForTimeout(800);
    await scrollTo(page, panel, "center");
    await shot("rt-navigation");

    const open = await retentionPanel(page);
    await scrollTo(page, open.locator(".retention-view-switch"), "start");
    await page.evaluate(() => window.scrollBy(0, -40));
    await shot("rt-schedule");
    const policy = await kit.api("owner", "GET", "/api/admin/retention/policy");
    if (policy.enabled && policy.automation_enabled) throw new Error("Start from a Forever (inactive) retention policy.");

    // A stable source for one matter, with the names people actually type.
    const source = open.locator(".retention-source-section");
    await source.locator("select").first().selectOption("matter");
    await source.getByLabel("Name or reference").fill("Vendor onboarding review");
    await source.getByLabel("Aliases, separated by commas").fill("vendor onboarding, vendor review");
    await source.getByRole("button", { name: "Add source to policy" }).click();
    await source.getByText("Vendor onboarding review").first().waitFor();
    await scrollTo(page, source, "start");
    await shot("rt-source");

    // Preview a seven-year schedule. It is never saved.
    await previewSevenYears(page, open);
    await scrollTo(page, open.locator(".retention-impact"), "center");
    await shot("rt-preview");

    // Keep Forever, and save the new source with it.
    await open.locator(".retention-preset-labels").getByRole("button", { name: "Forever" }).click();
    await open.getByRole("button", { name: "Save Forever" }).click();
    await open.locator(".retention-governance > p[role='status']").waitFor();
    await page.waitForTimeout(800);
    await scrollTo(page, open.locator(".retention-governance > .retention-actions"), "center");
    await shot("rt-forever-saved");
    const saved = await kit.api("owner", "GET", "/api/admin/retention/policy");
    if (saved.enabled && saved.automation_enabled) throw new Error("A finite policy was saved; stop.");

    // Tags and holds: scan existing chats for the new source.
    await open.getByRole("button", { name: "Tags and holds" }).click();
    await open.getByRole("button", { name: "Scan existing chats" }).click();
    await page.waitForTimeout(4000);
    await open.getByLabel("Search chats and tags").fill("vendor");
    await page.waitForTimeout(1500);
    await scrollTo(page, open.locator(".retention-tag-management"), "start");
    await shot("rt-scan");

    // Select the matching chat and confirm the client label.
    const row = open.getByRole("checkbox", { name: /^Select Show the stages of a vendor onboarding process for a batch action$/ }).first();
    await row.check();
    const labels = open.getByLabel("Retention label to apply");
    const match = (await labels.locator("option").allInnerTexts()).find((text) => /Vendor onboarding review/.test(text));
    if (!match) throw new Error("The new matter is not offered as a label.");
    await labels.selectOption({ label: match });
    await open.getByRole("button", { name: "Confirm label" }).click();
    await page.waitForTimeout(2000);
    await scrollTo(page, open.locator(".retention-tag-management"), "start");
    await shot("rt-confirmed");

    // Legal hold on the same chat.
    if (!(await row.isChecked())) await row.check();
    const holds = open.locator(".retention-tag-management details");
    if (!(await holds.evaluate((element) => element.open))) await holds.locator("summary").click();
    await holds.getByLabel("Hold name").fill("Vendor review hold");
    await holds.getByRole("button", { name: "Hold selected chats" }).click();
    await page.waitForTimeout(2000);
    await scrollTo(page, holds, "center");
    await shot("rt-hold");

    // Read the conversation before deciding anything.
    await open.getByRole("button", { name: /^Preview the full conversation: Show the stages of a vendor onboarding process/ }).first().click();
    await page.locator(".prompt-output-modal").waitFor();
    await page.waitForTimeout(800);
    await shot("rt-conversation");
    await page.getByRole("button", { name: "Close conversation preview" }).click();

    // The same seven-year preview now counts the held chat. Still not saved.
    await previewSevenYears(page, open);
    await scrollTo(page, open.locator(".retention-impact"), "center");
    await shot("rt-preview-held");
    await open.locator(".retention-preset-labels").getByRole("button", { name: "Forever" }).click();
  },
};

module.exports = { "owner-retention": retention };
