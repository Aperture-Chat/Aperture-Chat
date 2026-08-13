/** Rasterize document diagram figures (Mermaid and structure charts) to PNG.
 *
 * Transferred chat replies land as ```mermaid fences; markdownToDocumentHtml
 * turns those into figures with a visual placeholder. This pass draws the
 * real diagram so Drafts, DOCX export, and AI revisions carry an image rather
 * than mermaid source text.
 */

import { diagramTypeLabel, renderMermaidPngDataUrl } from "./mermaidRender";
import { renderStewardDiagramPngDataUrl } from "./stewardDiagram";

export function hasUnrenderedDocumentDiagram(html: string) {
  return /<figure[^>]*data-diagram-source(?![^>]*data-diagram-rendered)/.test(html);
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
    const isStructure = figure.getAttribute("data-diagram-kind") === "structure";
    const dataUrl = !source.trim()
      ? null
      : isStructure
        ? await renderStewardDiagramPngDataUrl(source)
        : await renderMermaidPngDataUrl(source);
    if (!dataUrl) {
      const notice = document.createElement("p");
      notice.className = "document-diagram-error";
      notice.textContent = "This diagram could not be rendered.";
      figure.replaceChildren(notice);
      figure.setAttribute("data-diagram-rendered", "failed");
      continue;
    }
    const label = isStructure ? "structure" : diagramTypeLabel(source);
    const image = document.createElement("img");
    image.className = "document-diagram-image";
    image.src = dataUrl;
    image.alt = isStructure ? "Structure diagram" : label === "diagram" ? "Mermaid diagram" : `${label} diagram`;
    const caption = document.createElement("figcaption");
    caption.textContent =
      label === "diagram" ? "Diagram" : `${label.charAt(0).toUpperCase()}${label.slice(1)} diagram`;
    figure.replaceChildren(image, caption);
    figure.setAttribute("data-diagram-rendered", "true");
    rendered += 1;
  }
  return { html: template.innerHTML, rendered };
}
