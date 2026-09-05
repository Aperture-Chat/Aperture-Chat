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

function createCaptureRun({ scriptPath, publicDirectory, appUrl, confirmation, policiesOnly = false, workDirectory }) {
  validateCaptureSource(appUrl, confirmation);
  const source = fs.readFileSync(scriptPath, "utf8");
  const expected = [...new Set([...source.matchAll(/await shot\("([a-z0-9-]+)"/g)].map((match) => match[1]))]
    .filter((name) => !policiesOnly || name.startsWith("policies-"));
  if (!expected.length) throw new Error("Capture script has no declared frames.");
  const workRoot = workDirectory || path.join(__dirname, "../../../tmp/training-captures");
  fs.mkdirSync(workRoot, { recursive: true });
  const outputDirectory = fs.mkdtempSync(path.join(workRoot, `${path.basename(scriptPath, ".cjs")}-`));
  return {
    outputDirectory,
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
        capturedAt: new Date().toISOString(), script: path.basename(scriptPath), frames: expected,
      }, null, 2));
      console.log(`Published ${expected.length} captured frames. Review every image and remeasure focus regions before release.`);
      console.log(`Capture evidence: ${path.relative(process.cwd(), outputDirectory)}`);
    },
  };
}

module.exports = { createCaptureRun, validateCaptureSource, captureCredentials };
