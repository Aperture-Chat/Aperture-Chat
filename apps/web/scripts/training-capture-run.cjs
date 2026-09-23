/* Public frames are staged away from served assets. A failed capture must
 * never silently leave a mixture of old and newly captured training screens. */
const fs = require("node:fs");
const path = require("node:path");

function validateCaptureSource(appUrl, confirmation) {
  if (confirmation !== "I_HAVE_REVIEWED_SYNTHETIC_DATA") {
    throw new Error("Public training captures require CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA.");
  }
  const url = new URL(appUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Public training captures require an isolated local instance with synthetic data.");
  }
}

function captureCredentials() {
  const sessionFile = process.env.CAPTURE_SESSION_FILE;
  if (sessionFile) {
    const response = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    const user = response.user?.id;
    const token = response.session?.token;
    if (!user || !token) throw new Error("CAPTURE_SESSION_FILE must contain an actual sign-in response.");
    return { user, token };
  }
  return { user: process.env.CAPTURE_USER_ID || "", token: process.env.CAPTURE_SESSION_TOKEN || "" };
}

/* CAPTURE_KEEP_PUBLISHED_FRAMES names declared frames whose published images
 * stay as they are (for example, scenes that need a provider capability the
 * isolated instance lacks). Scripts skip those steps; nothing is substituted. */
function keptPublishedFrames(declared, value = process.env.CAPTURE_KEEP_PUBLISHED_FRAMES || "") {
  const kept = new Set(value.split(",").map((name) => name.trim()).filter(Boolean));
  const unknown = [...kept].filter((name) => !declared.includes(name));
  if (unknown.length) throw new Error(`CAPTURE_KEEP_PUBLISHED_FRAMES names undeclared frames: ${unknown.join(", ")}`);
  return kept;
}
function createCaptureRun({ scriptPath, publicDirectory, appUrl, confirmation, policiesOnly = false, workDirectory, keepPublished }) {
  validateCaptureSource(appUrl, confirmation);
  const source = fs.readFileSync(scriptPath, "utf8");
  const declared = [...new Set([...source.matchAll(/await shot\("([a-z0-9-]+)"/g)].map((match) => match[1]))]
    .filter((name) => !policiesOnly || name.startsWith("policies-"));
  if (!declared.length) throw new Error("Capture script has no declared frames.");
  const kept = keptPublishedFrames(declared, keepPublished);
  for (const name of kept) {
    if (!fs.existsSync(path.join(publicDirectory, `${name}.png`))) throw new Error(`Cannot keep ${name}: no published frame exists.`);
  }
  const expected = declared.filter((name) => !kept.has(name));
  if (kept.size) console.log(`Keeping published frames unchanged: ${[...kept].join(", ")}`);
  const workRoot = workDirectory || path.join(__dirname, "../../../tmp/training-captures");
  fs.mkdirSync(workRoot, { recursive: true });
  const outputDirectory = fs.mkdtempSync(path.join(workRoot, `${path.basename(scriptPath, ".cjs")}-`));
  return {
    outputDirectory,
    /** True when this run leaves the named frame as already published. */
    keeps(name) {
      return kept.has(name);
    },
    complete() {
      const missing = expected.filter((name) => !fs.existsSync(path.join(outputDirectory, `${name}.png`)));
      if (missing.length) throw new Error(`Capture incomplete; public assets unchanged. Missing frames: ${missing.join(", ")}`);
      for (const name of expected) {
        const data = fs.readFileSync(path.join(outputDirectory, `${name}.png`));
        if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new Error(`Invalid captured PNG: ${name}; public assets unchanged.`);
        }
      }
      fs.mkdirSync(publicDirectory, { recursive: true });
      for (const name of expected) fs.copyFileSync(path.join(outputDirectory, `${name}.png`), path.join(publicDirectory, `${name}.png`));
      fs.writeFileSync(path.join(outputDirectory, "capture-manifest.json"), JSON.stringify({
        capturedAt: new Date().toISOString(), script: path.basename(scriptPath), frames: expected, keptPublished: [...kept],
      }, null, 2));
      console.log(`Published ${expected.length} captured frames. Review every image and remeasure focus regions before release.`);
      console.log(`Capture evidence: ${path.relative(process.cwd(), outputDirectory)}`);
    },
  };
}

module.exports = { createCaptureRun, validateCaptureSource, captureCredentials };
