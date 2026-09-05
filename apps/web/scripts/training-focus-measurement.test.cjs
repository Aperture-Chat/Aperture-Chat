const assert = require("node:assert/strict");
const test = require("node:test");
const { assertFocusCoverage, measureFrameFocus } = require("./training-focus-measurement.cjs");

test("every published training focus has a measurement selector", () => {
  for (const role of ["user", "admin", "owner"]) {
    assert.ok(Object.keys(assertFocusCoverage(role)).length > 0);
  }
});

test("capture measurements reject a different composition size", async () => {
  await assert.rejects(measureFrameFocus({ viewportSize: () => ({ width: 1280, height: 720 }) }, "user", "chat-home"), /1185 x 855/);
});

test("missing or fully offscreen targets cannot become a published focus", async () => {
  const fakePage = (bounds) => ({
    viewportSize: () => ({ width: 1185, height: 855 }),
    locator: () => ({ evaluateAll: async () => bounds }),
  });
  await assert.rejects(measureFrameFocus(fakePage(null), "user", "chat-home"), /Missing visible training focus/);
  await assert.rejects(measureFrameFocus(fakePage({ left: 1200, top: 50, right: 1400, bottom: 150 }), "user", "chat-home"), /outside/);
});
