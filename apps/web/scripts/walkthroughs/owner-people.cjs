/* Accounts and role boundaries, performed for real on the synthetic instance.
 *
 * owner-users creates an admin and a second platform owner in Org Settings ›
 * Role Boundary, issues the admin a temporary password, changes a role,
 * deletes an account through the browser's confirmation, and then signs the
 * new admin in from a fresh browser to prove what an admin can and cannot
 * open. The temporary and replacement passwords are random per run, typed only
 * after each frame, and never written to disk; the issued password is read
 * from the dialog but never photographed. Run from a freshly reset instance.
 */
const crypto = require("node:crypto");

const ADMIN = { name: "Taylor Brooks", email: "taylor.brooks@example.test" };
const OWNER = { name: "Sam Rivera", email: "sam.rivera@example.test" };

function selectIn(scope, label) {
  return scope.locator("label").filter({ hasText: new RegExp(`^\\s*${label}`) }).locator("select").first();
}

async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

async function rolePanel(page) {
  const panel = page.locator(".owner-control-panel");
  await panel.waitFor();
  const toggle = panel.locator(".panel-collapse-button").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await panel.locator(".owner-management-form").waitFor();
  return panel;
}

function userRow(panel, email) {
  return panel.locator(".owner-user-row").filter({ hasText: email });
}

async function createAccount(page, panel, person, role) {
  const form = panel.locator(".owner-management-form");
  await form.getByLabel("Display name", { exact: true }).fill(person.name);
  await form.getByLabel("Email", { exact: true }).fill(person.email);
  await selectIn(form, "Role").selectOption(role);
  await form.getByRole("button", { name: "Create account" }).click();
  await page.getByText(`${person.name} account created through the admin API.`).waitFor();
  await userRow(panel, person.email).waitFor();
}

const users = {
  role: "owner",
  description: "Create an admin and an owner, issue a temporary password, change and remove roles, and sign the new admin in.",
  frames: [
    "owner/ur-panel", "owner/ur-role-menu", "owner/ur-admin-created", "owner/ur-password-dialog",
    "owner/ur-owner-created", "owner/ur-role-changed", "owner/ur-account-deleted", "owner/ur-admin-signed-in",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/org-settings");
    const panel = await rolePanel(page);
    await scrollTo(page, panel, "start");
    await shot("ur-panel");

    // The three roles an owner can create.
    const form = panel.locator(".owner-management-form");
    await selectIn(form, "Role").click();
    await page.locator(".apx-select-menu").waitFor();
    await page.waitForTimeout(300);
    await shot("ur-role-menu", { keepFocus: true });
    await page.keyboard.press("Escape");

    // An administrator for the organization.
    await createAccount(page, panel, ADMIN, "TENANT_ADMIN");
    await scrollTo(page, userRow(panel, ADMIN.email), "center");
    await shot("ur-admin-created");

    // A temporary password, shown once; it is read here but never photographed.
    await userRow(panel, ADMIN.email).getByRole("button", { name: `Set a password for ${ADMIN.name}` }).click();
    const dialog = page.getByRole("dialog", { name: `Set a password for ${ADMIN.name}` });
    await dialog.waitFor();
    await shot("ur-password-dialog");
    await dialog.getByRole("button", { name: "Generate" }).click();
    await dialog.getByRole("button", { name: "Set password" }).click();
    await dialog.getByText(`Password set for ${ADMIN.name}.`).waitFor();
    const temporary = (await dialog.locator(".password-reveal-row code").innerText()).trim();
    if (temporary.length < 12) throw new Error("The issued password is shorter than expected.");
    await dialog.getByRole("button", { name: "Done" }).click();

    // A second platform owner: the owner floor now has a spare.
    await createAccount(page, panel, OWNER, "PLATFORM_OWNER");
    await scrollTo(page, panel.locator(".owner-user-list"), "start");
    await shot("ur-owner-created");

    // Change a role in place.
    const casey = userRow(panel, "user-casey@example.test");
    await casey.getByRole("combobox").selectOption("TENANT_ADMIN");
    await page.getByText("Casey Doe role saved through the admin API.").waitFor();
    await page.waitForTimeout(600);
    await scrollTo(page, casey, "center");
    await shot("ur-role-changed");

    // Delete an account; the browser asks for confirmation first.
    const target = panel.locator(".owner-user-row").filter({ hasText: "Morgan Example" }).first();
    const targetEmail = (await target.locator(".owner-user-identity small").first().innerText()).trim();
    page.once("dialog", (prompt) => {
      if (!/Permanently delete Morgan Example's account\?/.test(prompt.message())) throw new Error(`Unexpected confirmation: ${prompt.message()}`);
      return prompt.accept();
    });
    await target.getByRole("button", { name: "Remove Morgan Example" }).click();
    await page.getByText("Morgan Example was permanently deleted through the admin API.").waitFor();
    if (await panel.locator(".owner-user-row").filter({ hasText: targetEmail }).count()) throw new Error("The account is still listed.");
    await page.waitForTimeout(600);
    // The confirmation message sits at the top of the console, above the list.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await shot("ur-account-deleted");

    // The new admin signs in, replaces the temporary password, and lands in
    // the Admin console; the Platform console is not offered.
    const replacement = `Synthetic-${crypto.randomBytes(12).toString("base64url")}`;
    const admin = kit.use(await kit.anonymous());
    await admin.getByRole("heading", { name: "Sign in to continue" }).waitFor();
    const emailTab = admin.getByRole("button", { name: /Email & password/ });
    if (await emailTab.count()) await emailTab.click();
    await admin.getByLabel("Email", { exact: true }).fill(ADMIN.email);
    await admin.getByLabel("Password", { exact: true }).fill(temporary);
    await admin.getByRole("button", { name: "Sign in", exact: true }).click();
    await admin.getByRole("heading", { name: "Set a new password" }).waitFor();
    const fields = admin.locator(".auth-form input[type='password']");
    await fields.nth(0).fill(replacement);
    await fields.nth(1).fill(replacement);
    await admin.locator(".auth-form button[type='submit']").click();
    await admin.getByRole("navigation", { name: "Primary" }).waitFor({ timeout: 30000 });
    await admin.waitForTimeout(1500);
    if (await admin.getByRole("button", { name: /Platform console/ }).count()) throw new Error("An admin was offered the Platform console.");
    await admin.getByText("Admin console").first().waitFor();
    await shot("ur-admin-signed-in");
  },
};

module.exports = { "owner-users": users };
