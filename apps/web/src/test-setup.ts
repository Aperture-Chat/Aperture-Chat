import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8000");

// jsdom defaults to a 1024px width, which trips responsive breakpoints (e.g.
// the Drafts assistant rail collapses to a drawer ≤1180px). Component tests
// assume the full desktop layout, so report a desktop width.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
}

// Without vitest `globals`, Testing Library's auto-cleanup isn't registered, so
// unmount between tests to keep the DOM isolated.
afterEach(() => cleanup());

// jsdom's Blob/File still lack arrayBuffer(); the Word-template upload path
// needs it. FileReader keeps the result in jsdom's realm so instanceof
// checks inside bundled dependencies (mammoth/JSZip) still hold.
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob."));
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(this);
    });
  };
}

// Keep component tests hermetic: default to no real network. The bootstrap
// fetch falls back to bundled sample data, and individual tests can override
// fetch (e.g. ChatFlow.test mocks the chat completion endpoint).
globalThis.fetch = vi.fn(
  async () =>
    new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
) as unknown as typeof fetch;

// The Node test runner ships a no-op localStorage (no valid file path), so we
// install a real in-memory implementation to exercise persistence behaviour.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const memoryStorage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: memoryStorage, configurable: true });
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: memoryStorage, configurable: true });
}
