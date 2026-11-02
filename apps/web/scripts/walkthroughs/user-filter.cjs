/** Ticks people in a console section's user filter and leaves its panel open,
 * for a frame that shows the checkboxes. The panel opens at the page level, so
 * it is found from `page`, not from the section. */
async function tickFilterUsers(page, scope, filterLabel, ...names) {
  await scope.getByRole("button", { name: filterLabel }).click();
  const panel = page.getByRole("dialog", { name: filterLabel });
  await panel.waitFor();
  for (const name of names) await panel.getByRole("checkbox", { name }).check();
  return panel;
}

/** Ticks people in a section's user filter, then closes it. */
async function pickFilterUsers(page, scope, filterLabel, ...names) {
  const panel = await tickFilterUsers(page, scope, filterLabel, ...names);
  await panel.getByRole("button", { name: "Done" }).click();
}

module.exports = { pickFilterUsers, tickFilterUsers };
