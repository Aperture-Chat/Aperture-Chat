/* Apply completed capture measurements after narration generation finishes.
 * Only FOCUS_REGIONS initializers change; lesson narration and timing remain
 * untouched. By default every focus for the role must have fresh evidence.
 * Rects must already use 1185 x 855 composition coordinates. For portrait
 * captures, include fit: "contain" and center/scale the capture-viewport rect
 * using its containPlacement metadata before importing. Existing declared
 * fit is retained when omitted; image bounds and publication are verified.
 *
 * node apps/web/scripts/apply-training-focus.cjs admin <measured-rects.json>...
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { readFocusRegions } = require("./training-focus-measurement.cjs");

function applyMeasurements(role, files, { allowPartial = false, write = true } = {}) {
  const expected = readFocusRegions(role);
  const filename = path.join(__dirname, "../src/components/trainingDecks", `${role}.tsx`);
  let text = fs.readFileSync(filename, "utf8");
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const properties = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ["FOCUS_REGIONS", `${role.toUpperCase()}_FOCUS_REGIONS`].includes(node.name.getText(source))) {
      properties.push(...node.initializer.properties);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const declaredFits = {};
  for (const property of properties) {
    const fit = property.initializer.properties.find((item) => item.name?.getText(source) === "fit");
    if (!fit) continue;
    if (!ts.isStringLiteral(fit.initializer) || !["fill", "contain"].includes(fit.initializer.text)) {
      throw new Error(`Invalid declared image fit: ${role}.${property.name.getText(source)}`);
    }
    declaredFits[property.name.getText(source)] = fit.initializer.text;
  }
  const measurements = {};
  const capturedImages = {};
  for (const filename of files) {
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(filename, "utf8")))) {
      if (!expected[key]) throw new Error(`Unexpected focus key: ${role}.${key}`);
      if (value.frame !== expected[key].frame) throw new Error(`Frame mismatch for ${role}.${key}: ${value.frame}`);
      if (Object.hasOwn(value, "fit") && !["fill", "contain"].includes(value.fit)) {
        throw new Error(`Invalid image fit: ${role}.${key}`);
      }
      const fit = value.fit ?? declaredFits[key];
      const { x, y, w, h } = value.rect || {};
      if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1185 || y + h > 855) {
        throw new Error(`Focus outside the training canvas: ${role}.${key}`);
      }
      if (value.zoom !== 1) throw new Error(`Measurements must explicitly use full-frame zoom: ${role}.${key}`);
      const screenshot = path.join(path.dirname(filename), path.basename(value.frame));
      const png = fs.readFileSync(screenshot);
      const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (png.length < 24 || !png.subarray(0, 8).equals(signature)) throw new Error(`Missing PNG evidence: ${key}`);
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      const desktop = [[1185, 855], [2370, 1710]].some(([w, h]) => w === width && h === height);
      const portrait = [[390, 844], [780, 1688]].some(([w, h]) => w === width && h === height);
      if (!desktop && !(portrait && fit === "contain")) throw new Error(`Incorrect capture dimensions or missing contain fit for ${key}: ${width} x ${height}`);
      if (fit === "contain") {
        // Rectangles are already normalized into composition coordinates.
        // Reject raw mobile CSS coordinates rather than silently stretching
        // or applying the contain transform twice. Allow one pixel of padding.
        const scale = Math.min(1185 / width, 855 / height);
        const left = (1185 - width * scale) / 2;
        const top = (855 - height * scale) / 2;
        if (x < left - 1 || y < top - 1 || x + w > left + width * scale + 1 || y + h > top + height * scale + 1) {
          throw new Error(`Focus outside the contained image; normalize capture bounds first: ${role}.${key}`);
        }
      }
      measurements[key] = { ...value, ...(fit ? { fit } : {}) };
      capturedImages[key] = png;
    }
  }
  const missing = Object.keys(expected).filter((key) => !measurements[key]);
  if (!allowPartial && missing.length) throw new Error(`Fresh ${role} measurements are incomplete: ${missing.join(", ")}`);
  if (write) {
    for (const [key, value] of Object.entries(measurements)) {
      const published = fs.readFileSync(path.join(__dirname, "../public", value.frame));
      if (!published.equals(capturedImages[key])) throw new Error(`Publish the completed capture batch before applying ${role}.${key}; its public PNG does not match the measured image.`);
    }
  }
  const edits = [];
  for (const property of properties) {
    const value = measurements[property.name.getText(source)];
    if (!value) continue;
    const { x, y, w, h } = value.rect;
    edits.push([property.initializer.getStart(source), property.initializer.end,
      `{ frame: ${JSON.stringify(value.frame)}, rect: { x: ${x}, y: ${y}, w: ${w}, h: ${h} }${value.fit ? `, fit: ${JSON.stringify(value.fit)}` : ""} }`]);
  }
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  if (write) fs.writeFileSync(filename, text);
  return { updated: edits.length, missing, source: text };
}

module.exports = { applyMeasurements };

if (require.main === module) {
  const args = process.argv.slice(2);
  const role = args.shift();
  const allowPartial = args.includes("--allow-partial");
  const files = args.filter((argument) => argument !== "--allow-partial");
  try {
    if (!files.length) throw new Error("Usage: node apply-training-focus.cjs user|admin|owner <measured-rects.json>... [--allow-partial]");
    const { updated, missing } = applyMeasurements(role, files, { allowPartial });
    console.log(`Updated ${updated} ${role} focus regions; ${missing.length} remain without supplied measurements.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
