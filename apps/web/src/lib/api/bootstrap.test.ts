import { expect, test } from "vitest";

import { sampleData } from "../../data/sampleData";
import type { KnowledgeConfigRecord } from "../types";
import { mapKnowledgeConfigRecordToKnowledgeBase } from "./bootstrap";

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
