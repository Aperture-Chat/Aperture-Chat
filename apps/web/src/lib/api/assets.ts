import { apiBase, authHeaders } from "./http";

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
