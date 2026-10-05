/* Scheduled automations, performed for real as the synthetic standard user
 * against the local training model.
 *
 * user-automations builds a two-step automation, shows each schedule type
 * (Weekly, Daily, Once, Custom cron) with the live Next runs preview, saves it
 * delivering to a new chat, runs it now and opens the delivered chat, reads
 * the run history, pauses it, and then builds a one-time automation that
 * delivers a new draft, runs it, and opens the draft. Every output is the
 * model's real output; nothing is scheduled to run while the capture waits.
 */
const { helpers } = require("./user-common.cjs");
const { scrollTo } = helpers;

const CHAT_AUTOMATION = {
  name: "Weekly vendor summary (synthetic)",
  prompt: "List three things to check in a synthetic vendor review this week.",
  steps: [
    "Draft three short bullet points.",
    "Rewrite the bullets in a friendly tone, under 60 words in total.",
  ],
};
const DRAFT_AUTOMATION = {
  name: "Vendor onboarding brief (synthetic)",
  prompt: "Write a short brief for a new team member about how a synthetic vendor is onboarded.",
  step: "Write a one-page brief with a title and three short sections.",
};

async function editor(page) {
  const section = page.locator("section.automation-editor");
  await section.waitFor();
  return section;
}

async function setStep(section, index, instruction) {
  const model = section.getByLabel(`Step ${index} model or agent`);
  const options = await model.locator("option").allInnerTexts();
  const choice = options.find((text) => /Qwen3\.5 9B/.test(text) && !/Finance|agent/i.test(text));
  if (!choice) throw new Error("No usable model option for the automation step.");
  await model.selectOption({ label: choice });
  await section.getByLabel(`Step ${index} instruction`).fill(instruction);
}

async function how(section, label) {
  await section.locator("[aria-label='How often']").getByRole("button", { name: label, exact: true }).click();
  await section.page().waitForTimeout(600);
}

async function scrollEditorTo(page, locator) {
  await scrollTo(page, locator, "center");
}

async function runNow(page, card, target) {
  await card.getByRole("button", { name: "Run now" }).click();
  await page.getByText(new RegExp(`ran \\d+ step\\(s\\) and saved the result to a new ${target}`)).first().waitFor({ timeout: 300000 });
  await page.waitForTimeout(1000);
}

const userAutomations = {
  role: "user",
  description: "Build, schedule, run, review, and pause automations that deliver a new chat or a new draft.",
  externalOrigins: () => [],
  frames: [
    "user/automations-page", "user/automation-what", "user/automation-steps", "user/automation-weekly", "user/automation-daily",
    "user/automation-once", "user/automation-custom", "user/automation-deliver", "user/automation-saved",
    "user/automation-run-output", "user/automation-result-chat", "user/automation-history", "user/automation-paused",
    "user/automation-draft-target", "user/automation-result-draft",
  ],
  async run(kit) {
    const { shot } = kit;
    let page = await kit.app("user", "/automations");
    const create = page.getByRole("button", { name: /New automation/ }).first();
    await create.waitFor();
    await page.waitForTimeout(800);
    await shot("automations-page");

    // 1. What it does and its steps.
    await create.click();
    let section = await editor(page);
    await section.getByLabel("Name", { exact: true }).fill(CHAT_AUTOMATION.name);
    await section.getByLabel("Prompt", { exact: true }).fill(CHAT_AUTOMATION.prompt);
    await page.waitForTimeout(300);
    await shot("automation-what");
    await setStep(section, 1, CHAT_AUTOMATION.steps[0]);
    await section.getByRole("button", { name: "Add step" }).click();
    await setStep(section, 2, CHAT_AUTOMATION.steps[1]);
    await scrollEditorTo(page, section.getByLabel("Step 2 instruction"));
    await shot("automation-steps");

    // 2. Each schedule type, with the live preview.
    await how(section, "Daily");
    await section.getByLabel("Time", { exact: true }).fill("08:30");
    await page.waitForTimeout(800);
    await scrollEditorTo(page, section.locator("[aria-label='How often']"));
    await shot("automation-daily");
    await how(section, "Once");
    await section.getByLabel("Run at").fill("2026-12-01T09:00");
    await page.waitForTimeout(800);
    await scrollEditorTo(page, section.locator("[aria-label='How often']"));
    await shot("automation-once");
    await how(section, "Custom");
    await section.getByLabel("Cron expression").fill("30 7 * * 1-5");
    await page.waitForTimeout(800);
    await scrollEditorTo(page, section.locator("[aria-label='How often']"));
    await shot("automation-custom");
    await how(section, "Weekly");
    await section.locator(".weekday-picker").getByRole("button", { name: "Monday" }).click();
    await section.getByLabel("Time", { exact: true }).fill("09:00");
    await page.waitForTimeout(800);
    await scrollEditorTo(page, section.locator("[aria-label='How often']"));
    await shot("automation-weekly");

    // 3. Delivery, then save.
    const deliver = section.getByRole("button", { name: "New chat", exact: true });
    await deliver.click();
    await scrollEditorTo(page, deliver);
    await shot("automation-deliver");
    await section.getByRole("button", { name: /^Save automation/ }).click();
    await page.getByText(`Automation “${CHAT_AUTOMATION.name}” saved and scheduled.`).first().waitFor();
    const card = page.locator(`article.automation-card-2[aria-label="${CHAT_AUTOMATION.name}"]`);
    await card.waitFor();
    await scrollEditorTo(page, card);
    await shot("automation-saved");

    // 4. Run now, read the output, open the delivered chat.
    await runNow(page, card, "chat");
    // The run's output opens under the card (a disclosure that starts open).
    await card.locator(".automation-disclosure[open] .automation-output").waitFor();
    await page.waitForTimeout(800);
    await scrollEditorTo(page, card);
    await shot("automation-run-output");
    await card.getByRole("link", { name: "Open chat" }).or(card.getByRole("button", { name: "Open chat" })).first().click();
    await page.locator("article.assistant-message").first().waitFor();
    await page.waitForTimeout(1500);
    await shot("automation-result-chat");

    // 5. Run history and pause.
    await page.goto(kit.APP + "/automations");
    const again = page.locator(`article.automation-card-2[aria-label="${CHAT_AUTOMATION.name}"]`);
    await again.waitFor();
    await again.getByText(/Run history \(\d+\)/).click();
    await page.waitForTimeout(800);
    await scrollEditorTo(page, again);
    await shot("automation-history");
    await again.getByRole("switch", { name: `Enable ${CHAT_AUTOMATION.name}` }).click();
    await again.getByText(/^Paused/).first().waitFor();
    await page.waitForTimeout(600);
    await scrollEditorTo(page, again);
    await shot("automation-paused");

    // 6. A one-time automation that delivers a new draft.
    await page.getByRole("button", { name: /New automation/ }).first().click();
    section = await editor(page);
    await section.getByLabel("Name", { exact: true }).fill(DRAFT_AUTOMATION.name);
    await section.getByLabel("Prompt", { exact: true }).fill(DRAFT_AUTOMATION.prompt);
    await setStep(section, 1, DRAFT_AUTOMATION.step);
    await how(section, "Once");
    await section.getByLabel("Run at").fill("2026-12-01T09:00");
    await section.getByRole("button", { name: "New draft", exact: true }).click();
    await page.waitForTimeout(500);
    await scrollEditorTo(page, section.getByRole("button", { name: "New draft", exact: true }));
    await shot("automation-draft-target");
    await section.getByRole("button", { name: /^Save automation/ }).click();
    const draftCard = page.locator(`article.automation-card-2[aria-label="${DRAFT_AUTOMATION.name}"]`);
    await draftCard.waitFor();
    await runNow(page, draftCard, "draft");
    await draftCard.getByRole("link", { name: "Open draft" }).or(draftCard.getByRole("button", { name: "Open draft" })).first().click();
    await page.getByRole("textbox", { name: "Document body", exact: true }).waitFor();
    await page.waitForTimeout(2000);
    await shot("automation-result-draft");
  },
};

module.exports = { "user-automations": userAutomations };
