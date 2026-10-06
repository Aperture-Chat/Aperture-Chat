/* Registry of complete walkthrough capture modules for capture-walkthroughs.cjs.
 * Every other .cjs file in this directory exports { "<module-name>": module }.
 * Each module declares its frames as "<role>/<name>" and stages every one of
 * them with a literal `await shot("name")` call, which audit-training.cjs reads
 * to confirm that every published frame has a capture step. */
const fs = require("node:fs");
const path = require("node:path");

const WALKTHROUGHS = {};
for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith(".cjs") && name !== "index.cjs").sort()) {
  for (const [name, module] of Object.entries(require(path.join(__dirname, file)))) {
    if (WALKTHROUGHS[name]) throw new Error(`Duplicate walkthrough module ${name} in ${file}`);
    WALKTHROUGHS[name] = module;
  }
}

module.exports = { WALKTHROUGHS };
