import { ChatRequestError, apiBase, authHeaders, readApiError } from "./http";

/** A PDF converted to editable document HTML that keeps its page setup,
 * fonts, spacing, headers/footers, and pictures. The server is a stateless
 * transform: nothing about the file is stored remotely. */
export type DocumentImportResponse = {
  filename: string;
  html: string;
  page_count: number;
  warnings: string[];
};

export async function importPdfDocument(userId: string, file: File): Promise<DocumentImportResponse> {
  const form = new FormData();
  form.append("file", file);
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/drafts/document-import/pdf`, {
      method: "POST",
      headers: authHeaders(userId),
      body: form,
    });
  } catch {
    throw new ChatRequestError("Could not upload the PDF. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return (await response.json()) as DocumentImportResponse;
}
