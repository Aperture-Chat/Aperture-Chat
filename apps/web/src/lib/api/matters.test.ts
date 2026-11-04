import { afterEach, describe, expect, it, vi } from "vitest";

import { changeResourceMatter, createMatter, listMatters, matterTenantSlug } from "./matters";

const fetchMock = vi.fn<typeof fetch>();

function respondWith(body: unknown, status = 200) {
  fetchMock.mockImplementation(async () =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = fetchMock;
}

function calls() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  }));
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("matterTenantSlug", () => {
  const tenant = { id: "tenant-example", slug: "example" } as never;

  it("names the viewed tenant only for platform owners", () => {
    expect(matterTenantSlug({ me: { role: "PLATFORM_OWNER" } as never, currentTenant: tenant })).toBe("example");
    expect(matterTenantSlug({ me: { role: "USER" } as never, currentTenant: tenant })).toBeUndefined();
    expect(matterTenantSlug({ me: { role: "TENANT_ADMIN" } as never, currentTenant: tenant })).toBeUndefined();
  });

  it("sends no tenant for a platform owner who is not viewing one yet", () => {
    expect(matterTenantSlug({ me: { role: "PLATFORM_OWNER" } as never, currentTenant: undefined as never })).toBeUndefined();
  });
});

describe("listMatters and createMatter", () => {
  it("lists a full page and sends the tenant a platform owner is viewing", async () => {
    respondWith([]);
    await listMatters("user-owner", { tenantSlug: "example" });
    const [call] = calls();
    expect(call.url).toMatch(/\/api\/matters\?limit=200$/);
    expect(call.headers["X-Aperture-Tenant"]).toBe("example");
  });

  it("creates a matter under the given label without a tenant header for tenant users", async () => {
    respondWith({ id: "matter-1", name: "100234-0001" }, 201);
    const created = await createMatter("user-jane", "100234-0001");
    const [call] = calls();
    expect(created.id).toBe("matter-1");
    expect(call.method).toBe("POST");
    expect(call.url).toMatch(/\/api\/matters$/);
    expect(call.body).toEqual({ name: "100234-0001" });
    expect(call.headers["X-Aperture-Tenant"]).toBeUndefined();
  });
});

describe("changeResourceMatter", () => {
  it("unlinks the old matter before linking the new one", async () => {
    respondWith({});
    await changeResourceMatter("user-jane", "chat-threads", "thread 1", "matter-a", "matter-b");
    expect(calls().map(({ method, url }) => `${method} ${url.replace(/^.*\/api/, "/api")}`)).toEqual([
      "DELETE /api/matters/matter-a/resources/chat-threads/thread%201",
      "PUT /api/matters/matter-b/resources/chat-threads/thread%201",
    ]);
  });

  it("links a knowledge base that had no matter, and sends nothing when unchanged", async () => {
    respondWith({});
    await changeResourceMatter("user-jane", "knowledge-configs", "kb-1", null, "matter-a", { tenantSlug: "example" });
    await changeResourceMatter("user-jane", "knowledge-configs", "kb-1", "matter-a", "matter-a");
    const sent = calls();
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("PUT");
    expect(sent[0].url).toMatch(/\/api\/matters\/matter-a\/resources\/knowledge-configs\/kb-1$/);
    expect(sent[0].headers["X-Aperture-Tenant"]).toBe("example");
  });

  it("stops at the first refusal so a failed unlink never links a second matter", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ detail: "This resource is not assigned to this matter." }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock;
    await expect(changeResourceMatter("user-jane", "chat-threads", "t1", "matter-a", "matter-b")).rejects.toThrow(
      "This resource is not assigned to this matter.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
