const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCaptureRun, validateCaptureSource } = require("./training-capture-run.cjs");
const confirmation = "I_HAVE_REVIEWED_SYNTHETIC_DATA";

test("only confirmed local synthetic captures may overwrite public assets", () => {
  assert.throws(() => validateCaptureSource("https://your-instance.example", confirmation), /isolated local/);
  assert.throws(() => validateCaptureSource("http://localhost:5173", ""), /CONFIRMATION/);
  assert.doesNotThrow(() => validateCaptureSource("http://127.0.0.1:5173", confirmation));
});

test("missing frames fail without overwriting earlier public captures", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-capture-test-"));
  try {
    const scriptPath = path.join(work, "capture.cjs");
    const publicDirectory = path.join(work, "public");
    fs.writeFileSync(scriptPath, 'await shot("first"); await shot("second");');
    fs.mkdirSync(publicDirectory);
    fs.writeFileSync(path.join(publicDirectory, "first.png"), "original");
    const run = createCaptureRun({ scriptPath, publicDirectory, appUrl: "http://localhost:5173", confirmation, workDirectory: path.join(work, "staging") });
    fs.writeFileSync(path.join(run.outputDirectory, "first.png"), "new");
    assert.throws(() => run.complete(), /Missing frames: second/);
    assert.equal(fs.readFileSync(path.join(publicDirectory, "first.png"), "utf8"), "original");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
