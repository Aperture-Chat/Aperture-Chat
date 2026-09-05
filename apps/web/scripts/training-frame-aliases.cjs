/* Reuse reviewed captures when an onboarding lesson points to a detailed
 * workflow already shown elsewhere. These are byte-identical views, not
 * generated states. The first-reply scene deliberately shows the standard
 * user's conversation, which administrators and owners are asked to verify.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FRAME_ALIASES = {
  "training/admin/access-model-readiness.png": "training/admin/model-access.png",
  "training/admin/access-first-reply.png": "training/user/chat-response-actions.png",
  "training/owner/first-workspace-access.png": "training/owner/roles.png",
  "training/owner/first-workspace-reply.png": "training/user/chat-response-actions.png",
};

function publishAliases() {
  const publicRoot = path.join(__dirname, "../public");
  const evidence = [];
  const buffers = Object.entries(FRAME_ALIASES).map(([target, source]) => {
    const png = fs.readFileSync(path.join(publicRoot, source));
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (png.length < 24 || !png.subarray(0, 8).equals(signature)) throw new Error(`Missing captured source: ${source}`);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (![[1185, 855], [2370, 1710]].some(([w, h]) => w === width && h === height)) throw new Error(`Wrong source viewport: ${source}`);
    evidence.push({ target, source, sha256: crypto.createHash("sha256").update(png).digest("hex"), width, height });
    return { target, png };
  });
  for (const { target, png } of buffers) fs.writeFileSync(path.join(publicRoot, target), png);
  const work = path.join(__dirname, "../../../tmp/training-captures");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "frame-alias-evidence.json"), JSON.stringify(evidence, null, 2));
  return evidence;
}

module.exports = { FRAME_ALIASES, publishAliases };
if (require.main === module) {
  try {
    if (!process.argv.includes("--reviewed-captures")) throw new Error("Review and publish the source captures first, then pass --reviewed-captures.");
    console.log(`Published ${publishAliases().length} byte-identical onboarding views.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
