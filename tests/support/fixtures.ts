import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { ApiKeyRecord, UsageRecord } from "../../src/domain/types.js";
import { generateApiKey } from "../../src/lib/crypto.js";
import { MemoryRateLimiter } from "./memory-rate-limiter.js";
import { MemoryRepository } from "./memory-repository.js";

export const TEST_NOW = new Date("2026-08-30T10:15:00.000Z");
export const HASH_SECRET = "test-hash-secret-that-is-longer-than-32-characters";
export const ORG_A_ID = "00000000-0000-4000-8000-000000000001";
export const ORG_B_ID = "00000000-0000-4000-8000-000000000002";
export const API_KEY_A_ID = "10000000-0000-4000-8000-000000000001";
export const API_KEY_B_ID = "10000000-0000-4000-8000-000000000002";
export const DEVICE_A_ID = "20000000-0000-4000-8000-000000000001";
export const DEVICE_B_ID = "20000000-0000-4000-8000-000000000002";

export interface TenantFixture {
  organizationId: string;
  apiKeyId: string;
  deviceId: string;
  rawApiKey: string;
  prefix: string;
}

export interface TestContext {
  app: FastifyInstance;
  repository: MemoryRepository;
  rateLimiter: MemoryRateLimiter;
  requestRateLimiter: MemoryRateLimiter;
  tenantA: TenantFixture;
  tenantB: TenantFixture;
}

export interface TestContextOptions {
  ipRequestsPerMinute?: number;
  apiKeyRequestsPerMinute?: number;
  deviceRequestsPerMinute?: number;
  organizationWritesPerMinute?: number;
  providerMode?: "mock" | "httpsms";
  androidAgentEnabled?: boolean;
  androidAgentLiveReportingEnabled?: boolean;
}

export function defaultUsage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  const messageLimit = overrides.messageLimit ?? 100;
  const messagesUsed = overrides.messagesUsed ?? 0;
  return {
    planCode: "starter",
    subscriptionStatus: "active",
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-01T00:00:00.000Z"),
    messagesUsed,
    messageLimit,
    messagesRemaining: Math.max(messageLimit - messagesUsed, 0),
    perMinuteRateLimit: 10,
    maxContacts: 10_000,
    ...overrides,
  };
}

export function seedTenant(
  repository: MemoryRepository,
  input: {
    organizationId: string;
    apiKeyId: string;
    deviceId: string;
    scopes?: string[];
    usage?: UsageRecord;
    organizationStatus?: "active" | "suspended";
    revokedAt?: Date | null;
    expiresAt?: Date | null;
    keyEnvironment?: "test" | "live";
  },
): TenantFixture {
  const generated = generateApiKey(HASH_SECRET, input.keyEnvironment ?? "test");
  const record: ApiKeyRecord = {
    apiKeyId: input.apiKeyId,
    organizationId: input.organizationId,
    organizationStatus: input.organizationStatus ?? "active",
    scopes: input.scopes ?? [
      "messages:write",
      "messages:read",
      "usage:read",
      "opt_outs:write",
      "contacts:read",
      "contacts:write",
    ],
    keyHash: generated.hash,
    revokedAt: input.revokedAt ?? null,
    expiresAt: input.expiresAt ?? null,
  };
  repository.seedApiKey(generated.prefix, record);
  repository.seedUsage(input.organizationId, input.usage ?? defaultUsage());
  repository.seedDevice({
    id: input.deviceId,
    organizationId: input.organizationId,
    active: true,
    provider: "mock",
    senderNumber: null,
    encryptedConfig: null,
  });
  return {
    organizationId: input.organizationId,
    apiKeyId: input.apiKeyId,
    deviceId: input.deviceId,
    rawApiKey: generated.rawKey,
    prefix: generated.prefix,
  };
}

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const providerMode = options.providerMode ?? "mock";
  const executionMode = providerMode === "httpsms" || options.androidAgentLiveReportingEnabled
    ? "live"
    : "simulation";
  const repository = new MemoryRepository(executionMode);
  const rateLimiter = new MemoryRateLimiter();
  const requestRateLimiter = new MemoryRateLimiter();
  const tenantA = seedTenant(repository, {
    organizationId: ORG_A_ID,
    apiKeyId: API_KEY_A_ID,
    deviceId: DEVICE_A_ID,
    keyEnvironment: executionMode === "live" ? "live" : "test",
  });
  const tenantB = seedTenant(repository, {
    organizationId: ORG_B_ID,
    apiKeyId: API_KEY_B_ID,
    deviceId: DEVICE_B_ID,
    keyEnvironment: executionMode === "live" ? "live" : "test",
  });
  const app = await buildApp({
    repository,
    rateLimiter,
    requestRateLimiter,
    apiKeyHashSecret: HASH_SECRET,
    providerMode,
    logger: false,
    now: () => new Date(TEST_NOW.getTime()),
    ...options,
  });
  return { app, repository, rateLimiter, requestRateLimiter, tenantA, tenantB };
}

export function validMessageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    to: "+218912345678",
    content: "Your approved transaction was completed.",
    purpose: "transactional",
    consent_confirmed: true,
    consent_reference: "checkout-order-1",
    metadata: { order_id: "order-1" },
    ...overrides,
  };
}

export function validContactBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Ahmed Al-Sadiq",
    phone: "+218 91 234 5678",
    consent_reference: "signup-form-42",
    tags: ["customer", "priority"],
    metadata: { locale: "ar-LY" },
    ...overrides,
  };
}
