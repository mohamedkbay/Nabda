import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  apiKeyDigest,
  apiKeyPrefix,
  deviceLeaseDigest,
  deviceTokenDigest,
  deviceTokenPrefix,
  generateApiKey,
  generateDeviceLease,
  generateDeviceToken,
  keyedRequestDigest,
  requestDigest,
  signWebhook,
  verifyApiKey,
  verifyDeviceToken,
} from "../src/lib/crypto.js";

describe("API key cryptography", () => {
  it("generates a parseable key and verifies only the matching HMAC digest", () => {
    const secret = "a-test-only-hash-secret-with-at-least-32-characters";
    const key = generateApiKey(secret, "test");

    expect(key.rawKey).not.toContain(secret);
    expect(apiKeyPrefix(key.rawKey)).toBe(key.prefix);
    expect(key.hash).toBe(apiKeyDigest(key.rawKey, secret));
    expect(verifyApiKey(key.rawKey, key.hash, secret)).toBe(true);
    expect(verifyApiKey(`${key.rawKey}x`, key.hash, secret)).toBe(false);
    expect(verifyApiKey(key.rawKey, key.hash, `${secret}-wrong`)).toBe(false);
    expect(verifyApiKey(key.rawKey, "not-hex", secret)).toBe(false);
  });

  it("rejects malformed raw API keys before lookup", () => {
    expect(apiKeyPrefix("plain-secret")).toBeNull();
    expect(apiKeyPrefix("nbda_test_short.secret")).toBeNull();
  });

  it("uses a canonical request digest for idempotency fingerprints", () => {
    expect(requestDigest({ alpha: 1, nested: { beta: 2, gamma: 3 } })).toBe(
      requestDigest({ nested: { gamma: 3, beta: 2 }, alpha: 1 }),
    );
    expect(requestDigest({ alpha: 1 })).not.toBe(requestDigest({ alpha: 2 }));
  });

  it("uses domain-separated keyed digests for sensitive request fingerprints", () => {
    const secret = "a-test-only-hash-secret-with-at-least-32-characters";
    const digest = keyedRequestDigest({ code: "123456" }, secret, "message-idempotency");

    expect(digest).toBe(keyedRequestDigest({ code: "123456" }, secret, "message-idempotency"));
    expect(digest).not.toBe(keyedRequestDigest({ code: "123456" }, `${secret}-other`, "message-idempotency"));
    expect(digest).not.toBe(keyedRequestDigest({ code: "123456" }, secret, "device-event"));
    expect(digest).not.toBe(requestDigest({ code: "123456" }));
  });
});

describe("device token cryptography", () => {
  it("stores only domain-separated HMAC digests for tokens and leases", () => {
    const secret = "a-test-only-hash-secret-with-at-least-32-characters";
    const token = generateDeviceToken(secret);
    const lease = generateDeviceLease(secret);

    expect(deviceTokenPrefix(token.rawToken)).toBe(token.prefix);
    expect(token.hash).toBe(deviceTokenDigest(token.rawToken, secret));
    expect(verifyDeviceToken(token.rawToken, token.hash, secret)).toBe(true);
    expect(verifyDeviceToken(token.rawToken, token.hash, `${secret}-wrong`)).toBe(false);
    expect(deviceTokenPrefix("plain-device-secret")).toBeNull();
    expect(lease.hash).toBe(deviceLeaseDigest(lease.rawToken, secret));
    expect(token.hash).not.toBe(apiKeyDigest(token.rawToken, secret));
    expect(lease.hash).not.toBe(deviceTokenDigest(lease.rawToken, secret));
  });
});

describe("webhook HMAC", () => {
  it("signs the timestamp and exact raw body", () => {
    const timestamp = 1_787_997_600;
    const rawBody = '{"event":"message.delivered","id":"evt_1"}';
    const secret = "whsec_test_only";
    const expected = `v1=${createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`, "utf8")
      .digest("hex")}`;

    expect(signWebhook(timestamp, rawBody, secret)).toBe(expected);
    expect(signWebhook(timestamp, `${rawBody}\n`, secret)).not.toBe(expected);
    expect(signWebhook(timestamp + 1, rawBody, secret)).not.toBe(expected);
  });
});
