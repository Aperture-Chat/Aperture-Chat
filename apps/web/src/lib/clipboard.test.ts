import { afterEach, expect, test, vi } from "vitest";
import { triggerBlobDownload } from "./clipboard";

afterEach(() => vi.useRealTimers());

test("a download's delayed URL revoke is safe once the environment has no revokeObjectURL", () => {
  vi.useFakeTimers();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const names: string[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:download-1" });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  try {
    // jsdom has no revokeObjectURL, like a test that restored its URL stubs
    // before the delayed revoke fired.
    Reflect.deleteProperty(URL, "revokeObjectURL");
    triggerBlobDownload(new Blob(["print('hi')"]), "hello.py");
    expect(names).toEqual(["hello.py"]);
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
  } finally {
    click.mockRestore();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
  }
});

test("a download revokes its object URL after the browser has started it", () => {
  vi.useFakeTimers();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:download-2" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => revoked.push(url) });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  try {
    triggerBlobDownload(new Blob(["x"]), "x.txt");
    vi.advanceTimersByTime(3999);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(["blob:download-2"]);
  } finally {
    click.mockRestore();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
  }
});
