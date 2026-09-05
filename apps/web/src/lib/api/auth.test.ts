import { afterEach, expect, test, vi } from "vitest";
import { revokeSession, updateAccountPassword } from "./auth";
import { authHeaders, setSessionToken } from "./http";

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionToken(null);
});

test("password update replaces the revoked session before the next API call", async () => {
  setSessionToken("old-session");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    status: "updated", session: { user_id: "user-test", auth_method: "local", token: "replacement-session" },
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
  await updateAccountPassword("user-test", { current_password: "existing-password", new_password: "replacement-password" });
  expect(authHeaders("user-test")["x-aperture-session"]).toBe("replacement-session");
});

test("failed password update leaves the current session intact", async () => {
  setSessionToken("current-session");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Current password is incorrect." }), { status: 401, headers: { "Content-Type": "application/json" } })));
  await expect(updateAccountPassword("user-test", { current_password: "wrong-password", new_password: "replacement-password" })).rejects.toThrow("Current password is incorrect.");
  expect(authHeaders("user-test")["x-aperture-session"]).toBe("current-session");
});

test("a late password response cannot restore a session after sign-out", async () => {
  setSessionToken("old-session");
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const update = updateAccountPassword("user-test", { current_password: "existing-password", new_password: "replacement-password" });
  setSessionToken(null);
  finish(new Response(JSON.stringify({ status: "updated", session: { user_id: "user-test", auth_method: "local", token: "replacement-session" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
  await update;
  expect(authHeaders("user-test")["x-aperture-session"]).toBeUndefined();
});

test("logout revokes the captured token without clearing a later session", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "logged_out" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  setSessionToken("later-session");
  await revokeSession("ended-session");
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/auth/logout"), expect.objectContaining({
    method: "POST", headers: { "x-aperture-session": "ended-session" }, keepalive: true,
  }));
  expect(authHeaders("user-test")["x-aperture-session"]).toBe("later-session");
});

test("logout accepts an already invalid session and reports server revocation failures", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Already revoked", { status: 401 })));
  await expect(revokeSession("ended-session")).resolves.toBeUndefined();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
  await expect(revokeSession("ended-session")).rejects.toThrow("could not confirm session revocation");
});
