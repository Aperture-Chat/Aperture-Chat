/** Sticky per-user Reply settings switches, kept in this browser. Both are on
 * until the user turns them off. */

function switchStorageKey(name: string, userId: string) {
  return `aperture-${name}-${userId}`;
}

function loadSwitch(name: string, userId: string): boolean {
  try {
    return localStorage.getItem(switchStorageKey(name, userId)) !== "off";
  } catch {
    return true;
  }
}

function storeSwitch(name: string, userId: string, enabled: boolean) {
  try {
    localStorage.setItem(switchStorageKey(name, userId), enabled ? "on" : "off");
  } catch {
    // Private-mode storage failures only lose the sticky preference.
  }
}

/** Showing chat replies as they stream in. Display-only: the transport
 * streams either way, so turning this off never changes what the model,
 * usage records, or audit trail see. */
export function loadLiveStreamPreference(userId: string): boolean {
  return loadSwitch("live-stream", userId);
}

export function storeLiveStreamPreference(userId: string, enabled: boolean) {
  storeSwitch("live-stream", userId, enabled);
}

/** Letting the assistant pause to ask clarifying questions. Off, it makes
 * the choices itself and says what it assumed. */
export function loadAskPreference(userId: string): boolean {
  return loadSwitch("ask-when-unclear", userId);
}

export function storeAskPreference(userId: string, enabled: boolean) {
  storeSwitch("ask-when-unclear", userId, enabled);
}
