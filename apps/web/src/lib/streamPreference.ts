/** Sticky per-user preference for showing chat replies as they stream in.
 * Display-only: the transport streams either way, so turning this off never
 * changes what the model, usage records, or audit trail see. */

function liveStreamStorageKey(userId: string) {
  return `aperture-live-stream-${userId}`;
}

export function loadLiveStreamPreference(userId: string): boolean {
  try {
    return localStorage.getItem(liveStreamStorageKey(userId)) !== "off";
  } catch {
    return true;
  }
}

export function storeLiveStreamPreference(userId: string, enabled: boolean) {
  try {
    localStorage.setItem(liveStreamStorageKey(userId), enabled ? "on" : "off");
  } catch {
    // Private-mode storage failures only lose the sticky preference.
  }
}
