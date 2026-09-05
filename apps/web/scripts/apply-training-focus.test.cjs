const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyMeasurements } = require("./apply-training-focus.cjs");

function withMeasurement(dimensions, measurement, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "training-fit-test-"));
  try {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(dimensions[0], 16);
    png.writeUInt32BE(dimensions[1], 20);
    fs.writeFileSync(path.join(directory, "chat-home.png"), png);
    const filename = path.join(directory, "measured-rects.json");
    fs.writeFileSync(filename, JSON.stringify({
      homeComposer: { frame: "training/user/chat-home.png", zoom: 1, ...measurement },
    }));
    run(filename);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const mobileRect = { x: 415.2191943127962, y: 245.15402843601896, w: 354.5616113744076, h: 363.6789099526066 };

test("portrait measurements retain contain fit and already-normalized focus bounds", () => {
  withMeasurement([780, 1688], { fit: "contain", rect: mobileRect }, (filename) => {
    const result = applyMeasurements("user", [filename], { allowPartial: true, write: false });
    assert.equal(result.updated, 1);
    assert.match(result.source, /homeComposer: \{[^\n]+fit: "contain"/);
    assert.ok(result.source.includes(`x: ${mobileRect.x}, y: ${mobileRect.y}`));
  });
});

test("existing contain fit is preserved when a measurement omits it", (t) => {
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(filename, ...args) {
    const value = read.call(this, filename, ...args);
    return String(filename).endsWith("trainingDecks/user.tsx")
      ? value.replace(/homeComposer: \{/, 'homeComposer: { fit: "contain",')
      : value;
  });
  withMeasurement([390, 844], { rect: mobileRect }, (filename) => {
    const result = applyMeasurements("user", [filename], { allowPartial: true, write: false });
    assert.match(result.source, /homeComposer: \{[^\n]+fit: "contain"/);
  });
});

test("portrait captures reject stretching, raw viewport coordinates, and invalid fit values", () => {
  for (const fit of [undefined, "fill", "cover", null]) {
    withMeasurement([780, 1688], { fit, rect: mobileRect }, (filename) => {
      assert.throws(() => applyMeasurements("user", [filename], { allowPartial: true, write: false }), /fit/);
    });
  }
  withMeasurement([780, 1688], { fit: "contain", rect: { x: 20, y: 242, w: 350, h: 359 } }, (filename) => {
    assert.throws(() => applyMeasurements("user", [filename], { allowPartial: true, write: false }), /normalize capture bounds first/);
  });
});

test("desktop measurements keep the default fill contract and coordinates", () => {
  withMeasurement([2370, 1710], { rect: { x: 300, y: 300, w: 300, h: 100 } }, (filename) => {
    const result = applyMeasurements("user", [filename], { allowPartial: true, write: false });
    assert.match(result.source, /homeComposer: \{ frame: "training\/user\/chat-home.png", rect: \{ x: 300, y: 300, w: 300, h: 100 \} \}/);
  });
});

test("unpublished screenshot measurements cannot replace public focus regions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "training-focus-test-"));
  try {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1185, 16);
    png.writeUInt32BE(855, 20);
    fs.writeFileSync(path.join(directory, "chat-home.png"), png);
    const filename = path.join(directory, "measured-rects.json");
    fs.writeFileSync(filename, JSON.stringify({
      homeComposer: { frame: "training/user/chat-home.png", rect: { x: 300, y: 300, w: 300, h: 100 }, zoom: 1 },
    }));
    assert.throws(() => applyMeasurements("user", [filename], { allowPartial: true }), /public PNG does not match/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
