/** Rasterize document diagram figures (Mermaid and structure charts) to PNG.
 *
 * Transferred chat replies land as diagram fences (Mermaid, structure JSON,
 * or drawings Aperture converted from Graphviz, PlantUML, or text);
 * markdownToDocumentHtml turns those into figures with a visual placeholder.
 * This pass draws the real diagram so Drafts, DOCX export, and AI revisions
 * carry an image rather than diagram source text.
 */

import { isMindmapSource, parseMindmap } from "./diagramMindmap";
import { resolveDiagramBlock } from "./markdown";
import { diagramTypeLabel, renderMermaidPngDataUrl } from "./mermaidRender";
import { renderStewardDiagramPngDataUrl } from "./stewardDiagram";

export const DIAGRAM_RASTER_SCALE = 2;

/** Pixel size of a PNG data URL, read from its IHDR header. */
export function pngDimensions(dataUrl: string): { width: number; height: number } | null {
  const base64 = /^data:image\/png;base64,(.+)$/.exec(dataUrl)?.[1];
  if (!base64) return null;
  try {
    const header = atob(base64.slice(0, 44));
    if (header.slice(12, 16) !== "IHDR") return null;
    const read = (offset: number) =>
      ((header.charCodeAt(offset) << 24) |
        (header.charCodeAt(offset + 1) << 16) |
        (header.charCodeAt(offset + 2) << 8) |
        header.charCodeAt(offset + 3)) >>>
      0;
    const width = read(16);
    const height = read(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

function decodeNotes(value: string | null): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/** Alt text names what the figure shows: its own title when it has one. */
function diagramAltText(source: string, isStructure: boolean): string {
  if (isStructure) {
    const title = /"title"\s*:\s*"([^"]+)"/.exec(source)?.[1] ?? /^title:\s*(.+)$/m.exec(source)?.[1];
    return title ? `Structure diagram: ${title.trim()}` : "Structure diagram";
  }
  const title =
    (isMindmapSource(source) ? parseMindmap(source)?.text : undefined) ??
    /^\s*title\s*:\s*(.+)$/m.exec(source)?.[1] ??
    /^\s*(?:pie\s+(?:showData\s+)?)?title\s+(.+)$/m.exec(source)?.[1];
  const label = diagramTypeLabel(source.replace(/^\s*---[\s\S]*?---\s*/, ""));
  const kind = label === "diagram" ? "Diagram" : `${label.charAt(0).toUpperCase()}${label.slice(1)} diagram`;
  return title ? `${kind}: ${title.trim().replace(/^["']|["']$/g, "")}` : kind;
}

export function hasUnrenderedDocumentDiagram(html: string) {
  return /<figure\b(?=[^>]*\bdata-diagram-source(?:=|\s|>))(?![^>]*\bdata-diagram-rendered(?:=|\s|>))[^>]*>/i.test(
    html,
  );
}

/** Off-DOM transform: renders every pending diagram figure to a light-theme
 * PNG data URL. Data-URL <img> is the one vector-safe form that survives the
 * DOCX walker and the AI-revision asset protection; inline <svg> does not. */
export async function hydrateDocumentDiagramFigures(
  sourceHtml: string,
): Promise<{ html: string; rendered: number } | null> {
  const template = document.createElement("template");
  template.innerHTML = sourceHtml;
  const figures = Array.from(
    template.content.querySelectorAll<HTMLElement>(
      "figure[data-diagram-source]:not([data-diagram-rendered])",
    ),
  );
  if (!figures.length) return null;
  let rendered = 0;
  for (const figure of figures) {
    let source = "";
    try {
      source = decodeURIComponent(figure.getAttribute("data-diagram-source") ?? "");
    } catch {
      source = "";
    }
    let isStructure = figure.getAttribute("data-diagram-kind") === "structure";
    let resolvedNotes: string[] | undefined;
    // Figures written by the server (automation drafts) carry the raw fence
    // and its language; the browser makes the same call chat makes. A fence
    // that is not a diagram after all goes back to being a code block.
    const language = figure.getAttribute("data-diagram-language");
    if (language !== null) {
      const resolved = resolveDiagramBlock(language, source);
      if (!resolved) {
        const pre = document.createElement("pre");
        pre.className = "document-code-block";
        const code = document.createElement("code");
        code.textContent = source;
        pre.append(code);
        figure.replaceWith(pre);
        continue;
      }
      source = resolved.source;
      isStructure = resolved.kind === "structure";
      resolvedNotes = resolved.notes;
      figure.removeAttribute("data-diagram-language");
      figure.setAttribute("data-diagram-source", encodeURIComponent(source));
      if (isStructure) figure.setAttribute("data-diagram-kind", "structure");
      if (resolvedNotes?.length) figure.setAttribute("data-diagram-notes", encodeURIComponent(resolvedNotes.join("\n")));
    }
    let dataUrl: string | null = null;
    if (source.trim()) {
      try {
        dataUrl = isStructure
          ? await renderStewardDiagramPngDataUrl(source)
          : await renderMermaidPngDataUrl(source);
      } catch {
        // One malformed or unrasterizable figure must not strand every later
        // diagram in the transferred document. Mark this one honestly below
        // and continue hydrating the rest.
        dataUrl = null;
      }
    }
    if (!dataUrl) {
      const notice = document.createElement("p");
      notice.className = "document-diagram-error";
      notice.textContent = "This diagram could not be rendered.";
      figure.replaceChildren(notice);
      figure.setAttribute("data-diagram-rendered", "failed");
      continue;
    }
    const image = document.createElement("img");
    image.className = "document-diagram-image";
    image.src = dataUrl;
    image.alt = diagramAltText(source, isStructure);
    // Rasters are drawn at 2× for crisp print; the page shows them at their
    // design size so a small flowchart is not blown up to fill the column.
    const size = pngDimensions(dataUrl);
    if (size) {
      image.setAttribute("width", String(Math.round(size.width / DIAGRAM_RASTER_SCALE)));
      image.setAttribute("height", String(Math.round(size.height / DIAGRAM_RASTER_SCALE)));
    }
    const children: HTMLElement[] = [image];
    // Prose that accompanied a text drawing travels with the figure as its
    // caption, so converting the drawing never drops information.
    const notes = decodeNotes(figure.getAttribute("data-diagram-notes"));
    if (notes) {
      const caption = document.createElement("figcaption");
      caption.textContent = notes;
      children.push(caption);
    }
    figure.replaceChildren(...children);
    figure.setAttribute("data-diagram-rendered", "true");
    rendered += 1;
  }
  return { html: template.innerHTML, rendered };
}
