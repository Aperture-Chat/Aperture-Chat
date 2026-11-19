import { apiBase, apiRequest, authHeaders } from "./http";

/** Fetches a remote image through the API's authenticated proxy and returns a
 * data URL. Export embedding needs canvas-readable pixels, and many image
 * hosts (or their redirect hops) block direct browser CORS access. */
export async function fetchExportImageDataUrl(userId: string, src: string): Promise<string | null> {
  if (!src || src.startsWith("data:") || typeof fetch !== "function") return null;
  try {
    const response = await fetch(
      `${apiBase}/api/assets/image-proxy?url=${encodeURIComponent(src)}`,
      { headers: authHeaders(userId) },
    );
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export type LicensedPicture = {
  data_url: string;
  alt: string;
  credit: string;
  license: string;
  artist: string;
  source_url: string;
};

/** Freely licensed photos (Wikimedia Commons) as JPEG data URLs ready to
 * place in a draft; an empty list means nothing suitable was found. */
export async function findLicensedPictures(
  userId: string,
  request: { query: string; subject?: string | null; limit?: number },
): Promise<LicensedPicture[]> {
  const response = await apiRequest<{ pictures: LicensedPicture[] }>(userId, "/api/assets/licensed-pictures", {
    method: "POST",
    body: { query: request.query, subject: request.subject || null, limit: request.limit ?? 1 },
  });
  return response.pictures;
}
