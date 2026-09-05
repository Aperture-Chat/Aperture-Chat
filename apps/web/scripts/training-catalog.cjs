/* Read lesson boundaries with TypeScript's parser; never associate narration
 * with a neighboring lesson by the position of its audioSrc string. */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function parseDeck(text, role, { includeDrafts = false } = {}) {
  if (!["user", "admin", "owner"].includes(role)) throw new Error(`Unknown training role: ${role}`);
  const source = ts.createSourceFile(`${role}.tsx`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (source.parseDiagnostics.length) throw new Error(`Invalid TypeScript in ${role} training deck`);
  const declarations = source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
  );
  const declaration = declarations.find((item) => item.name.getText(source) === `${role.toUpperCase()}_TRAINING_VIDEOS`);
  const array = declaration?.initializer;
  if (!array || !ts.isArrayLiteralExpression(array)) throw new Error(`Missing lesson array in ${role} deck`);
  const lessonArrays = [{ array, publication: "published" }];
  if (includeDrafts) {
    const draftDeclaration = declarations.find((item) => item.name.getText(source) === `PENDING_${role.toUpperCase()}_TRAINING_VIDEOS`);
    if (draftDeclaration) {
      if (!ts.isArrayLiteralExpression(draftDeclaration.initializer)) throw new Error(`Invalid draft lesson array in ${role} deck`);
      lessonArrays.push({ array: draftDeclaration.initializer, publication: "draft" });
    }
  }
  const property = (object, name) => {
    if (!ts.isObjectLiteralExpression(object)) throw new Error(`Expected lesson object in ${role} deck`);
    return object.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source).replace(/^['"]|['"]$/g, "") === name);
  };
  const string = (object, name, required = true) => {
    const value = property(object, name)?.initializer;
    if (!value && !required) return undefined;
    if (!value || !ts.isStringLiteralLike(value)) throw new Error(`Expected literal ${name} in ${role} deck`);
    return value.text;
  };
  const regionDeclaration = declarations.find((item) => [`${role.toUpperCase()}_FOCUS_REGIONS`, "FOCUS_REGIONS"].includes(item.name.getText(source)));
  const regions = new Map();
  const regionDeclarations = [regionDeclaration];
  if (includeDrafts) regionDeclarations.push(declarations.find((item) => item.name.getText(source) === `PENDING_${role.toUpperCase()}_FOCUS_REGIONS`));
  for (const regionMap of regionDeclarations) {
    if (!regionMap?.initializer || !ts.isObjectLiteralExpression(regionMap.initializer)) continue;
    for (const region of regionMap.initializer.properties) {
      if (ts.isPropertyAssignment(region)) regions.set(region.name.getText(source), string(region.initializer, "frame"));
    }
  }
  // Python slices Unicode code points; TypeScript offsets use UTF-16 units.
  const offset = (position) => Array.from(text.slice(0, position)).length;
  const ids = new Set();
  const audioPaths = new Set();
  return lessonArrays.flatMap(({ array: lessons, publication }) => lessons.elements.map((lesson) => {
    const id = string(lesson, "id");
    if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate ${role} lesson id: ${id}`);
    ids.add(id);
    const existingAudio = string(lesson, "audioSrc", false);
    const audioSrc = existingAudio || `training/${role}/${id}.mp3`;
    if (!new RegExp(`^training/${role}/[a-z0-9-]+\\.mp3$`).test(audioSrc) || audioPaths.has(audioSrc)) {
      throw new Error(`Invalid or duplicate lesson audio path: ${audioSrc}`);
    }
    audioPaths.add(audioSrc);
    const scenes = property(lesson, "scenes")?.initializer;
    if (!scenes || !ts.isArrayLiteralExpression(scenes) || !scenes.elements.length) throw new Error(`Missing scenes for ${id}`);
    const title = property(lesson, "title");
    return {
      id,
      publication,
      title: string(lesson, "title"),
      audio_src: audioSrc,
      audio_missing: !existingAudio,
      audio_insert: offset(title.getStart(source)),
      scenes: scenes.elements.map((scene) => {
        const duration = property(scene, "durationSeconds")?.initializer;
        if (!duration || !ts.isNumericLiteral(duration) || !Number.isInteger(Number(duration.text)) || Number(duration.text) <= 0) {
          throw new Error(`Invalid scene duration in ${id}`);
        }
        const focus = string(scene, "focus");
        if (regionDeclaration && !regions.has(focus)) throw new Error(`Unknown focus region ${focus} in ${id}`);
        return {
          title: string(scene, "title"),
          narration: string(scene, "narration"),
          focus,
          frame: regions.get(focus),
          duration: Number(duration.text),
          span: [offset(duration.getStart(source)), offset(duration.end)],
        };
      }),
    };
  }));
}

if (require.main === module) {
  const role = process.argv[2];
  const deckPath = path.join(__dirname, "..", "src", "components", "trainingDecks", `${role}.tsx`);
  try {
    if (!["user", "admin", "owner"].includes(role)) throw new Error("Usage: node training-catalog.cjs user|admin|owner [--include-drafts]");
    process.stdout.write(JSON.stringify(parseDeck(fs.readFileSync(deckPath, "utf8"), role, { includeDrafts: process.argv.includes("--include-drafts") })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseDeck };
