import { afterEach, expect, test, vi } from "vitest";

import { createAdminGroup, setAdminOwnGroupMembership } from "./admin";

const fetchMock = vi.fn<typeof fetch>();

function respondWith(body: unknown) {
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  globalThis.fetch = fetchMock;
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) };
}

afterEach(() => {
  fetchMock.mockReset();
});

test("joining my own group puts member true on the group's membership/me route", async () => {
  respondWith({ id: "user-admin", group_ids: ["group/corp"] });
  const user = await setAdminOwnGroupMembership("user-admin", "group/corp", true);

  const call = lastCall();
  expect(call.url).toMatch(/\/api\/admin\/groups\/group%2Fcorp\/membership\/me$/);
  expect(call.method).toBe("PUT");
  expect(call.body).toEqual({ member: true });
  expect(user.group_ids).toEqual(["group/corp"]);
});

test("leaving my own group sends member false", async () => {
  respondWith({ id: "user-admin", group_ids: [] });
  await setAdminOwnGroupMembership("user-admin", "group-corp", false);
  expect(lastCall().body).toEqual({ member: false });
});

test("creating a group passes add_me through to the API", async () => {
  respondWith({ id: "group-new" });
  await createAdminGroup("user-admin", { name: "Trial Team", add_me: true });
  expect(lastCall().body).toEqual({ name: "Trial Team", add_me: true });
});
