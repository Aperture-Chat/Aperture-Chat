/* Accounts and access in the Admin console, performed for real.
 *
 * admin-access: two synthetic people ask to join from the public sign-in
 * page. The admin approves one, sets a temporary password, and declines the
 * other; the approved person replaces the password, lands in the workspace,
 * and gets a real reply from the local model; the declined person's sign-in
 * attempt records the real refusal. Run it before admin-sso: once a tenant
 * has SSO, the sign-in page opens on Organization SSO.
 * admin-users: Add User (an SSO account, then a local one with a temporary
 * password), role change, deactivate and reactivate, bulk deactivate, group
 * filter, the model access trace, and delete.
 * admin-groups: create a group, add a member, import emails (one unknown),
 * change a permission, the protected default group, and the result in Users.
 * Passwords are random per run and never written down.
 */
const crypto = require("node:crypto");
const { helpers } = require("./admin-shared.cjs");

const { tidyFixture, removeUsers, removeGroups, scrollTo, toast, dismissToast, openTab } = helpers;
const syntheticPassword = () => `Synthetic-${crypto.randomBytes(12).toString("base64url")}`;
const MODEL = "Qwen3.5 9B";

async function requestAccess(kit, person, { shot } = {}) {
  const page = await kit.anonymous();
  await page.getByRole("button", { name: /Request access/ }).first().click();
  await page.getByLabel("First name").fill(person.firstName);
  await page.getByLabel("Last name").fill(person.lastName);
  await page.getByLabel("Work email").fill(person.email);
  if (shot) { kit.use(page); await shot("access-request-form"); }
  await page.getByRole("button", { name: "Submit access request" }).click();
  await page.getByText("Request received").waitFor();
  if (shot) await shot("access-request-sent");
  return page;
}

async function usersTable(page) {
  const scroller = page.locator(".user-table-scroll");
  await scroller.waitFor();
  return scroller;
}

/** Scroll the users table sideways so the Actions column is in view. */
async function showActions(page) {
  const scroller = await usersTable(page);
  await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.waitForTimeout(300);
}

const adminAccess = {
  role: "admin",
  description: "Two access requests: approve with a temporary password through a first real reply, and decline.",
  frames: [
    "admin/access-request-form", "admin/access-request-sent", "admin/access-queue", "admin/access-handoff",
    "admin/access-temp-password", "admin/access-password-set", "admin/access-declined", "admin/access-forced-password",
    "admin/access-first-welcome", "admin/access-reply", "admin/access-declined-signin",
  ],
  async run(kit) {
    const { shot } = kit;
    const taylor = { firstName: "Taylor", lastName: "Brooks", email: "taylor.brooks@example.test" };
    const quinn = { firstName: "Quinn", lastName: "Harper", email: "quinn.harper@example.test" };
    if ((await kit.api("admin", "GET", "/api/admin/sso-configs")).length) throw new Error("Run admin-access before any SSO configuration exists.");
    await tidyFixture(kit);

    // 1. The people ask to join from the public sign-in page.
    await requestAccess(kit, taylor, { shot });
    await requestAccess(kit, quinn);

    // 2. The admin reviews the queue on Users.
    const admin = kit.use(await kit.app("admin", "/admin/users"));
    const queue = admin.locator(".access-request-queue");
    await queue.waitFor();
    await queue.locator(".access-request-card").filter({ hasText: quinn.email }).waitFor();
    await scrollTo(admin, queue, "center");
    await shot("access-queue");

    // 3. Approve Taylor as User; the handoff explains what happens next.
    const card = queue.locator(".access-request-card").filter({ hasText: taylor.email });
    await card.getByRole("button", { name: "Approve" }).click();
    await toast(admin, "Taylor Brooks was approved as User.");
    const handoff = admin.locator(".access-handoff");
    await handoff.waitFor();
    await scrollTo(admin, handoff, "center");
    await shot("access-handoff");

    // 4. A temporary password: the dialog is captured before a value exists.
    await handoff.getByRole("button", { name: "Set temporary password" }).click();
    const dialog = admin.locator(".password-reset-modal");
    await dialog.waitFor();
    await shot("access-temp-password");
    const temporary = syntheticPassword();
    await dialog.getByLabel("New password").fill(temporary);
    await dialog.getByRole("button", { name: "Set password" }).click();
    await dialog.getByText("They must choose their own password at first sign-in.").waitFor();
    await dialog.getByRole("button", { name: "Done" }).click();
    await toast(admin, "Taylor Brooks's temporary password was set through the admin API.");
    await handoff.getByRole("button", { name: "Done" }).click();
    const taylorRow = admin.locator("tr").filter({ hasText: taylor.email });
    await taylorRow.waitFor();
    if (!/\blocal\b/.test(await taylorRow.innerText())) throw new Error("Setting a password did not switch the account to local sign-in.");
    await scrollTo(admin, taylorRow, "center");
    await shot("access-password-set");

    // 5. Decline Quinn.
    await dismissToast(admin);
    await scrollTo(admin, queue, "center");
    await queue.locator(".access-request-card").filter({ hasText: quinn.email }).getByRole("button", { name: "Decline" }).click();
    await toast(admin, "Quinn Harper's access request was declined.");
    await shot("access-declined");

    // 6. Taylor signs in with the temporary password and chooses their own.
    const person = kit.use(await kit.anonymous());
    await person.getByLabel("Email").fill(taylor.email);
    await person.getByLabel("Password", { exact: true }).fill(temporary);
    await person.getByRole("button", { name: "Sign in" }).click();
    await person.getByRole("heading", { name: "Set a new password" }).waitFor();
    await shot("access-forced-password");
    const own = syntheticPassword();
    const fields = person.locator(".auth-form input[autocomplete='new-password']");
    await fields.nth(0).fill(own);
    await fields.nth(1).fill(own);
    await person.getByRole("button", { name: "Set password and continue" }).click();
    await person.locator(".first-run-welcome").waitFor({ timeout: 30000 });
    await person.waitForTimeout(800);
    await shot("access-first-welcome");

    // 7. The first real reply from a model their group grants.
    await person.getByRole("button", { name: "Select model" }).click();
    await person.getByRole("option", { name: new RegExp(MODEL.replace(".", "\\.")) }).click();
    await person.locator(".composer textarea").fill("In one sentence, what can you help me with today?");
    await person.getByRole("button", { name: "Send message" }).click();
    const reply = person.locator(".assistant-message .message-rendered-response").last();
    await reply.waitFor({ timeout: 300000 });
    await person.getByRole("button", { name: "Send positive feedback" }).last().waitFor({ timeout: 300000 });
    await person.waitForTimeout(1000);
    await shot("access-reply");

    // 8. A declined person has no account; signing in is refused.
    const declined = kit.use(await kit.anonymous());
    await declined.getByLabel("Email").fill(quinn.email);
    await declined.getByLabel("Password", { exact: true }).fill(syntheticPassword());
    await declined.getByRole("button", { name: "Sign in" }).click();
    await declined.getByText("Unknown local account.").waitFor();
    await declined.getByLabel("Password", { exact: true }).fill("");
    await shot("access-declined-signin");
  },
};

const adminUsers = {
  role: "admin",
  description: "Create SSO and local accounts, change a role, deactivate, bulk deactivate, filter, trace, and delete.",
  frames: [
    "admin/users-list", "admin/users-add-form", "admin/users-created", "admin/users-password-dialog",
    "admin/users-password-set", "admin/users-role-changed", "admin/users-deactivated", "admin/users-bulk-selected",
    "admin/users-bulk-done", "admin/users-filtered", "admin/users-trace", "admin/users-deleted",
  ],
  async run(kit) {
    const { shot } = kit;
    const avery = { name: "Avery Collins", email: "avery.collins@example.test" };
    const robin = { name: "Robin Shaw", email: "robin.shaw@example.test" };
    await tidyFixture(kit);
    await removeUsers(kit, [avery.email, robin.email]);
    const page = kit.use(await kit.app("admin", "/"));
    // Start where people start: the Admin console link in the sidebar.
    await page.getByRole("link", { name: "Admin console" }).or(page.getByRole("button", { name: "Admin console" })).first().click();
    await page.getByRole("tablist", { name: "Admin sections" }).waitFor();
    await usersTable(page);
    await shot("users-list");
    // Collapsing the sidebar gives the table room for every column, including
    // the Actions buttons (at this window width they clip otherwise).
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await page.waitForTimeout(600);

    // Add User: name, email, role, starting group.
    async function addUser(person, { beforeCreate } = {}) {
      await page.getByRole("button", { name: "Add User" }).click();
      const form = page.locator(".user-create-form");
      await form.waitFor();
      await form.getByLabel("Name").fill(person.name);
      await form.getByLabel("Email").fill(person.email);
      await form.getByLabel("Starting group").selectOption({ label: "Default Users" });
      if (beforeCreate) { await scrollTo(page, form, "center"); await beforeCreate(); }
      await form.getByRole("button", { name: "Create Account" }).click();
      await toast(page, `${person.name} was created through the admin API.`);
    }
    await addUser(avery, { beforeCreate: async () => { await shot("users-add-form"); } });
    const averyRow = page.locator("tr").filter({ hasText: avery.email });
    await averyRow.waitFor();
    if (!/\bsso\b/.test(await averyRow.innerText())) throw new Error("Add User did not create an SSO account.");
    await scrollTo(page, averyRow, "center");
    await shot("users-created");

    // A local account: create it, then set a temporary password.
    await addUser(robin);
    const robinRow = page.locator("tr").filter({ hasText: robin.email });
    await robinRow.waitFor();
    await scrollTo(page, robinRow, "center");
    await showActions(page);
    await robinRow.getByRole("button", { name: `Password for ${robin.name}` }).click();
    const dialog = page.locator(".password-reset-modal");
    await dialog.waitFor();
    await shot("users-password-dialog");
    await dialog.getByLabel("New password").fill(syntheticPassword());
    await dialog.getByRole("button", { name: "Set password" }).click();
    await dialog.getByText("They must choose their own password at first sign-in.").waitFor();
    await dialog.getByRole("button", { name: "Done" }).click();
    await toast(page, "Robin Shaw's temporary password was set through the admin API.");
    await (await usersTable(page)).evaluate((element) => { element.scrollLeft = 0; });
    if (!/\blocal\b/.test(await robinRow.innerText())) throw new Error("The password did not switch Robin to local sign-in.");
    await scrollTo(page, robinRow, "center");
    await shot("users-password-set");

    // Change the role from the row.
    await robinRow.getByLabel(`Role for ${robin.name}`).selectOption({ label: "Power User" });
    await toast(page, "Robin Shaw was updated through the admin API.");
    await scrollTo(page, robinRow, "center");
    await shot("users-role-changed");

    // Deactivate, then reactivate, from the Actions column.
    await showActions(page);
    await robinRow.getByRole("button", { name: `Deactivate ${robin.name}` }).click();
    await toast(page, "Robin Shaw was updated through the admin API.");
    await robinRow.getByRole("button", { name: `Activate ${robin.name}` }).waitFor();
    await scrollTo(page, robinRow, "center");
    await showActions(page);
    await shot("users-deactivated");
    await robinRow.getByRole("button", { name: `Activate ${robin.name}` }).click();
    await robinRow.getByRole("button", { name: `Deactivate ${robin.name}` }).waitFor();
    await dismissToast(page);

    // Bulk: select both new accounts and choose Deactivate in the toolbar.
    await (await usersTable(page)).evaluate((element) => { element.scrollLeft = 0; });
    await page.getByLabel(`Select ${avery.name}`).check();
    await page.getByLabel(`Select ${robin.name}`).check();
    await scrollTo(page, page.locator(".user-management-panel"), "start");
    await shot("users-bulk-selected");
    await page.locator(".user-management-panel").getByRole("button", { name: "Deactivate", exact: true }).click();
    await toast(page, "Deactivated 2 users through the admin API.");
    await scrollTo(page, averyRow, "center");
    await shot("users-bulk-done");
    await dismissToast(page);

    // Filter by group to work one team at a time.
    await scrollTo(page, page.locator(".user-management-panel"), "start");
    await page.getByLabel("Filter users by group").selectOption({ label: "Litigation" });
    await page.waitForTimeout(600);
    await shot("users-filtered");
    await page.getByLabel("Filter users by group").selectOption({ label: "All groups" });

    // Why can (or can't) someone use a model? The Access trace.
    const jane = page.locator("tr").filter({ hasText: "user-jane@example.test" });
    await scrollTo(page, jane, "center");
    await showActions(page);
    await jane.getByRole("button", { name: "Model access for Jane Smith" }).click();
    const trace = page.getByRole("dialog", { name: "Model access trace for Jane Smith" });
    await trace.waitFor();
    await trace.getByText("Evaluating…").waitFor({ state: "detached" }).catch(() => {});
    // A model none of Jane's groups grant: the trace stops at group_grant.
    const blocked = trace.locator("details.drawer-card").filter({ hasText: "OpenAI: GPT-5.5" });
    await blocked.waitFor();
    if (!/None of your groups grant this model/.test(await blocked.innerText())) throw new Error("Expected GPT-5.5 to be blocked at group_grant.");
    await scrollTo(page, blocked, "center");
    await shot("users-trace");
    await page.keyboard.press("Escape");
    await trace.waitFor({ state: "detached" });

    // Delete permanently removes the account and its chat history.
    await scrollTo(page, averyRow, "center");
    await showActions(page);
    await averyRow.getByRole("button", { name: `Delete ${avery.name}` }).click();
    await toast(page, "Avery Collins was permanently deleted.");
    await averyRow.waitFor({ state: "detached" });
    await shot("users-deleted");
  },
};

const adminGroups = {
  role: "admin",
  description: "Create a group, add members one by one and by email import, change a permission, and verify.",
  frames: [
    "admin/groups-list", "admin/groups-add-form", "admin/groups-created", "admin/groups-members",
    "admin/groups-import", "admin/groups-import-result", "admin/groups-permissions", "admin/groups-permission-saved",
    "admin/groups-default", "admin/groups-verify",
  ],
  async run(kit) {
    const { shot } = kit;
    const name = "Contracts Review";
    await tidyFixture(kit);
    await removeGroups(kit, [name]);
    const page = kit.use(await kit.app("admin", "/admin/users"));
    await openTab(page, "Groups");
    const panel = page.locator(".group-management-panel");
    await panel.waitFor();
    await shot("groups-list");

    // Create the group.
    await panel.getByRole("button", { name: "Add Group" }).click();
    const form = panel.locator(".group-create-form");
    await form.getByLabel("Group name").fill(name);
    await shot("groups-add-form");
    await form.getByRole("button", { name: "Create group" }).click();
    await toast(page, `${name} was added as a platform group.`);
    const cardRow = panel.locator(".managed-group-card").filter({ hasText: name });
    await cardRow.getByRole("button", { name: "Manage" }).click();
    const editor = panel.locator(".selected-group-panel");
    await editor.getByText(name, { exact: true }).first().waitFor();
    await scrollTo(page, cardRow, "center");
    await shot("groups-created");

    // Add one member with the Users tab switch.
    await editor.getByRole("tab", { name: "Users" }).click();
    await editor.getByRole("switch", { name: `Add Jane Smith to ${name}` }).click();
    await toast(page, "Jane Smith group membership synced with the admin API.");
    await editor.getByRole("switch", { name: `Remove Jane Smith from ${name}` }).waitFor();
    await scrollTo(page, editor.locator("tr").filter({ hasText: "Jane Smith" }), "center");
    await shot("groups-members");
    await dismissToast(page);

    // Import several existing accounts by email; unknown addresses stay behind.
    await editor.getByRole("tab", { name: "Import" }).click();
    const importBox = editor.getByLabel("User emails");
    await importBox.fill("user-casey@example.test\nuser-maya@example.test\ndana.lopez@example.test");
    await scrollTo(page, editor, "start");
    await shot("groups-import");
    await editor.getByRole("button", { name: "Add users to group" }).click();
    await toast(page, `Added 2 users to ${name}.`);
    await shot("groups-import-result");
    await dismissToast(page);

    // Permissions: read the grid, then grant one.
    await editor.getByRole("tab", { name: "Permissions" }).click();
    const grid = editor.locator(".group-permission-grid");
    await grid.waitFor();
    await scrollTo(page, grid, "start");
    await shot("groups-permissions");
    await grid.getByRole("switch", { name: "Can build knowledge bases" }).click();
    await toast(page, `${name} group permissions synced with the admin API.`);
    await scrollTo(page, grid.locator(".permission-row").filter({ hasText: "Can build knowledge bases" }), "center");
    await shot("groups-permission-saved");
    await dismissToast(page);

    // The protected default group.
    const defaults = panel.locator(".managed-group-card").filter({ hasText: "Default Users" });
    await defaults.getByRole("button", { name: "Manage" }).click();
    await editor.getByText("Protected", { exact: true }).waitFor();
    await scrollTo(page, defaults, "start");
    await shot("groups-default");

    // Verify: Users filtered to the new group lists its three members.
    await openTab(page, "Users");
    await page.getByLabel("Filter users by group").selectOption({ label: name });
    await page.waitForTimeout(600);
    const rows = page.locator(".user-management-table tbody tr");
    if ((await rows.count()) !== 3) throw new Error(`Expected 3 members of ${name}, saw ${await rows.count()}.`);
    await shot("groups-verify");
  },
};

module.exports = { "admin-access": adminAccess, "admin-users": adminUsers, "admin-groups": adminGroups };
