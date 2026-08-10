/**
 * Barrel for the API client, split by domain under ./api/.
 * Consumers keep importing from "lib/api"; each symbol lives in exactly one
 * domain module. Shared fetch/session/error infrastructure is in ./api/http.
 */
export * from "./api/http";
export * from "./api/auth";
export * from "./api/chat";
export * from "./api/bootstrap";
export * from "./api/admin";
export * from "./api/platform";
export * from "./api/knowledge";
export * from "./api/memory";
export * from "./api/tools";
export * from "./api/agents";
export * from "./api/automations";
export * from "./api/assets";
export * from "./api/deckTemplates";
