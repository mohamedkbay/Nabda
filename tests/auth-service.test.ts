import { describe, expect, it } from "vitest";
import type { ApiKeyRecord } from "../src/domain/types.js";
import { generateApiKey } from "../src/lib/crypto.js";
import { AuthService } from "../src/services/auth-service.js";
import { HASH_SECRET, TEST_NOW } from "./support/fixtures.js";
import { MemoryRepository } from "./support/memory-repository.js";

function seedCredential(
  repository: MemoryRepository,
  environment: "live" | "test",
): ReturnType<typeof generateApiKey> {
  const generated = generateApiKey(HASH_SECRET, environment);
  const record: ApiKeyRecord = {
    apiKeyId: `10000000-0000-4000-8000-0000000000${environment === "live" ? "31" : "32"}`,
    organizationId: `00000000-0000-4000-8000-0000000000${environment === "live" ? "31" : "32"}`,
    organizationStatus: "active",
    scopes: ["usage:read"],
    keyHash: generated.hash,
    revokedAt: null,
    expiresAt: null,
  };
  repository.seedApiKey(generated.prefix, record);
  return generated;
}

describe("API-key environment boundary", () => {
  it("accepts test credentials only on Mock servers", async () => {
    const repository = new MemoryRepository();
    const testKey = seedCredential(repository, "test");
    const liveKey = seedCredential(repository, "live");
    const auth = new AuthService(repository, HASH_SECRET, "test");

    await expect(auth.authenticate(testKey.rawKey, TEST_NOW)).resolves.toMatchObject({
      apiKeyId: "10000000-0000-4000-8000-000000000032",
    });
    await expect(auth.authenticate(liveKey.rawKey, TEST_NOW)).resolves.toBeNull();
  });

  it("accepts live credentials only on live-provider servers", async () => {
    const repository = new MemoryRepository();
    const testKey = seedCredential(repository, "test");
    const liveKey = seedCredential(repository, "live");
    const auth = new AuthService(repository, HASH_SECRET, "live");

    await expect(auth.authenticate(liveKey.rawKey, TEST_NOW)).resolves.toMatchObject({
      apiKeyId: "10000000-0000-4000-8000-000000000031",
    });
    await expect(auth.authenticate(testKey.rawKey, TEST_NOW)).resolves.toBeNull();
  });
});
