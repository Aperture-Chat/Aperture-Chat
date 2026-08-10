import { ChatRequestError, apiBase, authHeaders, readApiError } from "./http";

/** Parsed brand data from an uploaded .pptx/.potx template. The server is a
 * stateless transform: nothing about the file is stored remotely. */
export type DeckTemplateParseResponse = {
  filename: string;
  slide_count: number;
  theme: {
    colors: Record<string, string>;
    major_font: string | null;
    minor_font: string | null;
  };
  logo_candidates: Array<{
    data_url: string;
    width_px: number;
    height_px: number;
    source: string;
  }>;
  background_candidates: Array<{
    data_url: string;
    width_px: number;
    height_px: number;
    source: string;
  }>;
  /** One flattened picture per distinct layout the deck uses; slides point at
   * these by index, so a repeated design travels once. */
  designs: Array<{
    data_url: string;
    width_px: number;
    height_px: number;
    source: string;
    /** Dark artwork needs light slide text. */
    is_dark: boolean;
  }>;
  slides: Array<{
    index: number;
    title: string | null;
    blocks: string[];
    layout_name: string | null;
    design_index: number | null;
  }>;
  warnings: string[];
};

export async function parseDeckTemplate(
  userId: string,
  file: File,
): Promise<DeckTemplateParseResponse> {
  const form = new FormData();
  form.append("file", file);
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/drafts/deck-template/parse`, {
      method: "POST",
      headers: authHeaders(userId),
      body: form,
    });
  } catch {
    throw new ChatRequestError(
      "Could not upload the brand template. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return (await response.json()) as DeckTemplateParseResponse;
}
