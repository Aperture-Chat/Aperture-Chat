import { describe, expect, test } from "vitest";
import {
  buildCodePreview,
  codeArtifactFilename,
  codeArtifactLanguage,
  codeArtifactMimeType,
  codeArtifactsFromMarkdown,
  hasOpenCodeFence,
  parseFenceInfo,
} from "./codeArtifacts";

const name = (code: string, language: string, extra: { info?: string; headingHint?: string } = {}) =>
  codeArtifactFilename({ code, language, ...extra });

describe("parseFenceInfo", () => {
  test("keeps a plain language and finds no filename", () => {
    expect(parseFenceInfo("python")).toEqual({ language: "python", filename: null });
    expect(parseFenceInfo("")).toEqual({ language: "", filename: null });
  });

  test("reads title=, filename=, and file= attributes", () => {
    expect(parseFenceInfo('python title="main.py"')).toEqual({ language: "python", filename: "main.py" });
    expect(parseFenceInfo("ts filename=src/app.ts")).toEqual({ language: "ts", filename: "app.ts" });
    expect(parseFenceInfo("js file='server.js'")).toEqual({ language: "js", filename: "server.js" });
  });

  test("splits language:filename and a bare filename token", () => {
    expect(parseFenceInfo("js:server.js")).toEqual({ language: "js", filename: "server.js" });
    expect(parseFenceInfo("c:main.c")).toEqual({ language: "c", filename: "main.c" });
    expect(parseFenceInfo("main.py")).toEqual({ language: "py", filename: "main.py" });
    expect(parseFenceInfo("python scripts/build_site.py")).toEqual({ language: "python", filename: "build_site.py" });
  });

  test("a title that is prose, not a filename, is ignored", () => {
    expect(parseFenceInfo('python title="Game loop"')).toEqual({ language: "python", filename: null });
    expect(parseFenceInfo("mermaid {init: {}}")).toEqual({ language: "mermaid", filename: null });
  });
});

describe("codeArtifactFilename", () => {
  test("an explicit fence filename wins over everything else", () => {
    expect(name("<title>Ignored</title>", "html", { info: 'html title="index.html"' })).toBe("index.html");
  });

  test("a first-line comment naming a file wins over the content", () => {
    expect(name("// file: src/app.ts\nexport class Ignored {}", "ts")).toBe("app.ts");
    expect(name("# filename: tools/x.py\ndef run(): pass", "python")).toBe("x.py");
    expect(name("<!-- index.html -->\n<title>Other</title>", "html")).toBe("index.html");
    expect(name("/* theme.css */\nbody {}", "css")).toBe("theme.css");
  });

  test("a comment that only mentions a file in prose is not a filename", () => {
    expect(name("# loads config.yaml before start\nimport os", "python")).toBe("aperture-python-snippet.py");
    expect(name("#!/usr/bin/env python\nprint(1)", "python")).toBe("aperture-python-snippet.py");
  });

  test("HTML and SVG documents are named after their <title>", () => {
    const html = "<!DOCTYPE html>\n<html><head><title>Block Bros 3D &amp; Friends</title></head></html>";
    expect(name(html, "html")).toBe("block-bros-3d-friends.html");
    expect(name('<svg viewBox="0 0 1 1"><title>Sales Funnel</title></svg>', "svg")).toBe("sales-funnel.svg");
  });

  test("titles keep camel-cased words whole", () => {
    expect(name("<title>iPhone Tips</title>", "html")).toBe("iphone-tips.html");
  });

  test("long names stop at a word boundary within 56 characters", () => {
    const exact = `${"a".repeat(27)} ${"b".repeat(28)}`;
    expect(name(`<title>${exact}</title>`, "html")).toBe(`${"a".repeat(27)}-${"b".repeat(28)}.html`);
    expect(name(`<title>${exact} c</title>`, "html")).toBe(`${"a".repeat(27)}-${"b".repeat(28)}.html`);
    expect(name(`<title>${"x".repeat(70)}</title>`, "html")).toBe(`${"x".repeat(56)}.html`);
    const explicit64 = `${"f".repeat(61)}.py`;
    expect(name("x", "py", { info: `py title="${explicit64}"` })).toBe(explicit64);
  });

  test("a language:filename fence with an unusable name still uses its language", () => {
    expect(name("export class Foo {}", "js:---.js", { info: "js:---.js" })).toBe("foo.js");
  });

  test("an untitled HTML page falls back to its first heading", () => {
    expect(name("<main><h1 class='x'>Café <em>Menu</em></h1></main>", "html")).toBe("cafe-menu.html");
  });

  test("Python, Go, Rust, and Ruby name files after the primary symbol in snake_case", () => {
    expect(name("import os\n\nclass GameEngine:\n    def tick(self): pass", "python")).toBe("game_engine.py");
    expect(name("def parseHTTPHeaders(raw):\n    return raw", "py")).toBe("parse_http_headers.py");
    expect(name("package main\n\ntype RateLimiter struct {}", "go")).toBe("rate_limiter.go");
    expect(name("pub struct TokenBucket {}\nfn main() {}", "rust")).toBe("token_bucket.rs");
    expect(name("class OrderMailer\nend", "ruby")).toBe("order_mailer.rb");
  });

  test("nested definitions do not beat the top-level symbol", () => {
    expect(name("def outer():\n    def inner(): pass\n", "python")).toBe("outer.py");
  });

  test("Java, Kotlin, C#, Swift, and PHP keep the PascalCase type name", () => {
    expect(name("import java.util.*;\npublic final class OrderService {}", "java")).toBe("OrderService.java");
    expect(name("data class UserProfile(val id: Int)", "kotlin")).toBe("UserProfile.kt");
    expect(name("public sealed record Invoice(int Id);", "csharp")).toBe("Invoice.cs");
    expect(name("struct ContentView: View {}", "swift")).toBe("ContentView.swift");
    expect(name("<?php\nfinal class InvoiceController {}", "php")).toBe("InvoiceController.php");
  });

  test("React components stay PascalCase; other JavaScript is kebab-case", () => {
    expect(name("export default function TodoList() { return null; }", "tsx")).toBe("TodoList.tsx");
    expect(name("const SettingsPanel = () => <div />;", "jsx")).toBe("SettingsPanel.jsx");
    expect(name("export function debounceInput(fn) {}", "javascript")).toBe("debounce-input.js");
    expect(name("export class HttpClient {}", "typescript")).toBe("http-client.ts");
  });

  test("SQL is named after the first created object", () => {
    expect(name('CREATE TABLE IF NOT EXISTS "OrderItems" (id int);', "sql")).toBe("order_items.sql");
    expect(name("create or replace view monthly_sales as select 1;", "postgresql")).toBe("monthly_sales.sql");
  });

  test("shell functions use kebab-case", () => {
    expect(name("deploy_site() {\n  echo hi\n}", "bash")).toBe("deploy-site.sh");
  });

  test("without a symbol, the nearest heading names the file", () => {
    expect(name("body { color: red; }", "css", { headingHint: "Dark **mode** styles" })).toBe("dark-mode-styles.css");
  });

  test("generic headings are skipped for the language fallback", () => {
    expect(name("{\"a\": 1}", "json", { headingHint: "Full code" })).toBe("aperture-json-snippet.json");
  });

  test("falls back to an aperture-<language>-snippet name", () => {
    expect(name("x = 1", "")).toBe("aperture-code-snippet.txt");
    expect(name("echo hi", "zsh")).toBe("aperture-zsh-snippet.zsh");
    expect(name("Get-Process", "powershell")).toBe("aperture-powershell-snippet.ps1");
    expect(name("a,b", "csv")).toBe("aperture-csv-snippet.csv");
    expect(name("??", "klingon")).toBe("aperture-klingon-snippet.txt");
  });

  test("Dockerfiles and Makefiles keep their conventional names", () => {
    expect(name("FROM node:24", "dockerfile")).toBe("Dockerfile");
    expect(name("build:\n\tgo build", "makefile")).toBe("Makefile");
  });

  test("names are safe ASCII with no path separators and a length cap", () => {
    const longTitle = `<title>${"Extremely ".repeat(20)}Long Game</title>`;
    const long = name(longTitle, "html");
    expect(long.endsWith(".html")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z0-9-]+\.html$/);
    expect(name("x", "py", { info: 'py title="../../etc/pass wd.py"' })).toBe("aperture-py-snippet.py");
    expect(name("x", "py", { info: 'py title="..\\evil.py"' })).toBe("evil.py");
    const longExplicit = name("x", "py", { info: `py title="${"a".repeat(90)}.py"` });
    expect(longExplicit).toBe(`${"a".repeat(56)}.py`);
  });

  test("a named file with no usable stem falls back to the content", () => {
    expect(name("// file: ---.ts\nexport class Foo {}", "ts")).toBe("foo.ts");
  });
});

test("the display language drops a fence's file name", () => {
  expect(codeArtifactLanguage("js:server.js")).toBe("js");
  expect(codeArtifactLanguage("main.py")).toBe("py");
  expect(codeArtifactLanguage("python", 'python title="x.py"')).toBe("python");
  expect(codeArtifactLanguage("")).toBe("");
});

test("download MIME types follow the file extension", () => {
  expect(codeArtifactMimeType("game.html")).toBe("text/html;charset=utf-8");
  expect(codeArtifactMimeType("chart.svg")).toBe("image/svg+xml;charset=utf-8");
  expect(codeArtifactMimeType("app.js")).toBe("text/javascript;charset=utf-8");
  expect(codeArtifactMimeType("data.json")).toBe("application/json;charset=utf-8");
  expect(codeArtifactMimeType("Dockerfile")).toBe("text/plain;charset=utf-8");
});

test("previewable code builds a sandbox document; other code is source only", () => {
  expect(buildCodePreview("<h1>Hi</h1>", "html")).toMatchObject({ label: "HTML" });
  expect(buildCodePreview("<h1>Hi</h1>", "html").srcDoc).toContain("<body>\n<h1>Hi</h1>");
  expect(buildCodePreview("<!doctype html><p>x</p>", "text").srcDoc).toBe("<!doctype html><p>x</p>");
  expect(buildCodePreview("<svg></svg>", "xml")).toMatchObject({ label: "SVG" });
  expect(buildCodePreview("p { color: red }", "css").srcDoc).toContain("<style>p { color: red }</style>");
  expect(buildCodePreview("print(1)", "python")).toEqual({ label: "Source", srcDoc: null });
});

describe("codeArtifactsFromMarkdown", () => {
  test("lists code fences in order with names, skipping diagrams and hermes blocks", () => {
    const markdown = [
      "## Snake game",
      "```html",
      "<title>Snake</title>",
      "<canvas></canvas>",
      "```",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "```hermes-memory",
      "remember this",
      "```",
      "### Styles",
      "```css",
      "canvas { border: 0 }",
      "```",
    ].join("\n");
    const artifacts = codeArtifactsFromMarkdown(markdown, "m1");
    expect(artifacts.map((item) => [item.key, item.filename, item.language, item.lineCount])).toEqual([
      ["m1:0", "snake.html", "html", 2],
      ["m1:1", "styles.css", "css", 1],
    ]);
    expect(artifacts[0]!.code).toBe("<title>Snake</title>\n<canvas></canvas>");
  });

  test("a reply with no code has no artifacts", () => {
    expect(codeArtifactsFromMarkdown("Just prose.\n\n- a list", "m2")).toEqual([]);
  });
});

test("hasOpenCodeFence reports a fence that is still streaming", () => {
  expect(hasOpenCodeFence("Intro\n```html\n<div>")).toBe(true);
  expect(hasOpenCodeFence("```html\n<div>\n```\nDone")).toBe(false);
  expect(hasOpenCodeFence("````md\n```js\nx\n```\n")).toBe(true);
  expect(hasOpenCodeFence("````md\n```js\nx\n```\n````")).toBe(false);
  expect(hasOpenCodeFence("```\nx\n~~~")).toBe(true);
  expect(hasOpenCodeFence("```\nx\n```js")).toBe(true);
  expect(hasOpenCodeFence("- step\n  ```sh\n  ls\n  ```")).toBe(false);
  expect(hasOpenCodeFence("~~~\nx\n~~~")).toBe(false);
  expect(hasOpenCodeFence("No code here")).toBe(false);
});
