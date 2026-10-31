import { describe, expect, it } from "vitest";
import { ChatRequestError } from "./api/http";
import { requestFailure, fileFailure } from "./documentViewerFailures";

const named = (name: string) => Object.assign(new Error("x"), { name });

describe("requestFailure", () => {
  it("tells an expired session to sign in, offering nothing that cannot work", () => {
    const failure = requestFailure(new ChatRequestError("x", 401), "document");
    expect(failure.title).toMatch(/session has ended/i);
    expect(failure).toMatchObject({ retry: false, download: false, calm: false });
  });

  it("says plainly when access is refused", () => {
    const failure = requestFailure(new ChatRequestError("x", 403), "document");
    expect(failure.title).toMatch(/do not have access/i);
    expect(failure).toMatchObject({ retry: false, download: false });
  });

  it("is calm about a missing document", () => {
    const failure = requestFailure(new ChatRequestError("x", 404), "document");
    expect(failure.title).toBe("This document is no longer available");
    expect(failure).toMatchObject({ calm: true, retry: false, download: false });
  });

  it("speaks of the passage when an old citation is what went missing", () => {
    expect(requestFailure(new ChatRequestError("x", 404), "chunk").title).toBe("This passage is no longer available");
  });

  it("offers a retry and the original for a server fault", () => {
    const failure = requestFailure(new ChatRequestError("x", 500), "document");
    expect(failure.title).toBe("This document could not be opened");
    expect(failure.detail).toMatch(/try again/i);
    expect(failure).toMatchObject({ retry: true, download: true, calm: false });
  });

  it("treats a dropped connection and an unknown error the same way", () => {
    expect(requestFailure(new ChatRequestError("x"), "document").retry).toBe(true);
    expect(requestFailure(new Error("x"), "document").retry).toBe(true);
  });
});

describe("fileFailure", () => {
  it("names a password-protected PDF", () => {
    const failure = fileFailure(named("PasswordException"), "pages");
    expect(failure.title).toMatch(/password/i);
    expect(failure).toMatchObject({ retry: false, download: true });
  });

  it("names a damaged PDF", () => {
    for (const name of ["InvalidPDFException", "FormatError"]) {
      const failure = fileFailure(named(name), "pages");
      expect(failure.title).toMatch(/damaged/i);
      expect(failure).toMatchObject({ retry: false, download: true });
    }
  });

  it("never blames the file for a failed request", () => {
    for (const status of [500, 502, undefined]) {
      const failure = fileFailure(new ChatRequestError("x", status), "pages");
      expect(`${failure.title} ${failure.detail}`).not.toMatch(/password|damaged/i);
      expect(failure).toMatchObject({ retry: true, download: true, calm: false });
    }
  });

  it("reports a session or access problem on the file route too", () => {
    expect(fileFailure(new ChatRequestError("x", 401), "pages").title).toMatch(/session has ended/i);
    expect(fileFailure(new ChatRequestError("x", 403), "pages").title).toMatch(/do not have access/i);
    expect(fileFailure(new ChatRequestError("x", 404), "pages").calm).toBe(true);
  });

  it("names what could not be shown", () => {
    expect(fileFailure(new Error("x"), "pages").title).toBe("The pages could not be shown");
    expect(fileFailure(new Error("x"), "image").title).toBe("The image could not be shown");
  });

  it("offers a retry when the viewer's own code failed to arrive", () => {
    expect(fileFailure(new TypeError("Failed to fetch dynamically imported module"), "pages").retry).toBe(true);
  });
});
