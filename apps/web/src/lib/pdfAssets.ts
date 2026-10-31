/**
 * The binary files pdf.js fetches on demand. Vite hashes their names, so they
 * cannot be served as a plain directory. Loaded apart from the engine: a PDF
 * with embedded fonts and ordinary images never needs this map.
 */
type AssetUrls = Record<string, string>;

const urlsByKind: Record<string, AssetUrls> = {
  wasmUrl: import.meta.glob(
    ["../../../../node_modules/pdfjs-dist/wasm/*.wasm", "!**/quickjs-eval.wasm"],
    { eager: true, query: "?url&no-inline", import: "default" },
  ),
  standardFontDataUrl: import.meta.glob("../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", {
    eager: true,
    query: "?url&no-inline",
    import: "default",
  }),
  cMapUrl: import.meta.glob("../../../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
    eager: true,
    query: "?url&no-inline",
    import: "default",
  }),
};

export function pdfAssetUrl(kind: string, filename: string): string | null {
  const urls = urlsByKind[kind] ?? {};
  const path = Object.keys(urls).find((candidate) => candidate.endsWith(`/${filename}`));
  return path ? urls[path] : null;
}
