import { expect, test } from "vitest";

import { sampleData } from "../../data/sampleData";
import type { KnowledgeConfigRecord, SsoConfigRecord } from "../types";
import { mapKnowledgeConfigRecordToKnowledgeBase, mapSsoConfigRecordToDisplay } from "./bootstrap";

test("knowledge security label follows authoritative group ACL instead of stale user text", () => {
  const record: KnowledgeConfigRecord = {
    id: "knowledge-scientific-papers",
    tenant_id: sampleData.currentTenant.id,
    name: "Scientific LLM papers",
    source_type: "upload",
    enabled: true,
    acl_group_ids: ["group-default-users"],
    owner_user_id: "user-jane",
    settings: { acl: "Only Jane Smith" },
    secret_set: false,
    masked_secret: null,
  };

  const mapped = mapKnowledgeConfigRecordToKnowledgeBase(record, {
    groups: sampleData.groups,
    users: sampleData.users,
  });

  expect(mapped.acl).toBe("Groups: Default Users");
});

test("private knowledge security label names its sole owner", () => {
  const record: KnowledgeConfigRecord = {
    id: "knowledge-private-jane",
    tenant_id: sampleData.currentTenant.id,
    name: "Jane's sources",
    source_type: "upload",
    enabled: true,
    acl_group_ids: [],
    owner_user_id: "user-jane",
    settings: { acl: "Groups: Default Users" },
    secret_set: false,
    masked_secret: null,
  };

  const mapped = mapKnowledgeConfigRecordToKnowledgeBase(record, {
    groups: sampleData.groups,
    users: sampleData.users,
  });

  expect(mapped.acl).toBe("Only Jane Smith");
});

test("WorkOS SSO records keep their protocol, display name, and organization", () => {
  const record: SsoConfigRecord = {
    id: "sso-workos",
    tenant_id: "tenant-example",
    enabled: true,
    secret_set: true,
    masked_secret: "sk_t…tic",
    provider: "workos",
    issuer_url: "",
    client_id: "client_01JSYNTHETIC",
    scopes: [],
    mapped_groups: {},
    settings: {
      protocol: "WORKOS",
      display_name: "Meridian sign-in",
      workos_organization_id: "org_01JSYNTHETIC",
      domains: ["example.com"],
      enforced: false,
    },
  };

  const display = mapSsoConfigRecordToDisplay(record);

  expect(display.protocol).toBe("WORKOS");
  expect(display.name).toBe("Meridian sign-in");
  expect(display.workos_organization_id).toBe("org_01JSYNTHETIC");
  expect(mapSsoConfigRecordToDisplay({ ...record, settings: { domains: ["example.com"] } }).protocol).toBe("WORKOS");
  expect(mapSsoConfigRecordToDisplay({ ...record, settings: {} }).name).toBe("WorkOS");
});
