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

test("explicitly kept frames stay published and are not required from the run", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-capture-test-"));
  try {
    const scriptPath = path.join(work, "capture.cjs");
    const publicDirectory = path.join(work, "public");
    fs.writeFileSync(scriptPath, 'await shot("first"); await shot("second");');
    fs.mkdirSync(publicDirectory);
    fs.writeFileSync(path.join(publicDirectory, "second.png"), "original");
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]);
    // Kept names must be declared frames that are already published.
    assert.throws(() => createCaptureRun({ scriptPath, publicDirectory, appUrl: "http://localhost:5173", confirmation, workDirectory: path.join(work, "staging"), keepPublished: "third" }), /undeclared frames: third/);
    assert.throws(() => createCaptureRun({ scriptPath, publicDirectory, appUrl: "http://localhost:5173", confirmation, workDirectory: path.join(work, "staging"), keepPublished: "first" }), /no published frame/);
    const run = createCaptureRun({ scriptPath, publicDirectory, appUrl: "http://localhost:5173", confirmation, workDirectory: path.join(work, "staging"), keepPublished: "second" });
    assert.equal(run.keeps("second"), true);
    assert.equal(run.keeps("first"), false);
    fs.writeFileSync(path.join(run.outputDirectory, "first.png"), png);
    run.complete();
    assert.equal(fs.readFileSync(path.join(publicDirectory, "second.png"), "utf8"), "original");
    assert.ok(fs.readFileSync(path.join(publicDirectory, "first.png")).equals(png));
    const manifest = JSON.parse(fs.readFileSync(path.join(run.outputDirectory, "capture-manifest.json"), "utf8"));
    assert.deepEqual(manifest.keptPublished, ["second"]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
