import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  API_KEY_HASH_SECRET: "test-hash-secret-that-is-at-least-32-characters",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
  PROVIDER_MODE: "httpsms",
  ENABLE_LIVE_SMS: "true",
  HTTPSMS_API_BASE: "https://api.httpsms.com/v1",
} satisfies NodeJS.ProcessEnv;

describe("httpSMS configuration boundary", () => {
  it("accepts the official HTTPS host in explicitly enabled production mode", () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      PROVIDER_MODE: "httpsms",
      ENABLE_LIVE_SMS: true,
      HTTPSMS_API_BASE: "https://api.httpsms.com/v1",
    });
  });

  it.each([
    "http://api.httpsms.com/v1",
    "https://provider.invalid/v1",
    "https://api.httpsms.com.attacker.invalid/v1",
    "https://api.httpsms.com./v1",
  ])("rejects a non-official API base in live mode: %s", (HTTPSMS_API_BASE) => {
    expect(() => loadConfig({ ...validEnvironment, HTTPSMS_API_BASE })).toThrow(
      "HTTPSMS_API_BASE must use the official https://api.httpsms.com host",
    );
  });

  it("does not activate live URL restrictions while Mock is selected", () => {
    const config = loadConfig({
      ...validEnvironment,
      NODE_ENV: "development",
      PROVIDER_MODE: "mock",
      ENABLE_LIVE_SMS: "false",
      HTTPSMS_API_BASE: "http://localhost:9999/v1",
    });
    expect(config.PROVIDER_MODE).toBe("mock");
  });
});

describe("message retention configuration", () => {
  it("uses conservative cleanup defaults", () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      CLEANUP_INTERVAL_MS: 3_600_000,
      CLEANUP_BATCH_SIZE: 500,
    });
  });

  it("accepts an explicit bounded interval and batch size", () => {
    expect(loadConfig({
      ...validEnvironment,
      CLEANUP_INTERVAL_MS: "60000",
      CLEANUP_BATCH_SIZE: "25",
    })).toMatchObject({
      CLEANUP_INTERVAL_MS: 60_000,
      CLEANUP_BATCH_SIZE: 25,
    });
  });

  it("rejects intervals below one minute and invalid batch sizes", () => {
    expect(() => loadConfig({ ...validEnvironment, CLEANUP_INTERVAL_MS: "59999" })).toThrow(
      "CLEANUP_INTERVAL_MS",
    );
    expect(() => loadConfig({ ...validEnvironment, CLEANUP_BATCH_SIZE: "0" })).toThrow(
      "CLEANUP_BATCH_SIZE",
    );
  });
});

describe("request boundary configuration", () => {
  it("uses bounded defaults and does not trust forwarding headers by default", () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      TRUSTED_PROXY_CIDRS: [],
      IP_REQUESTS_PER_MINUTE: 1_200,
      API_KEY_REQUESTS_PER_MINUTE: 600,
      DEVICE_REQUESTS_PER_MINUTE: 120,
      ORGANIZATION_WRITES_PER_MINUTE: 60,
    });
  });

  it("accepts only explicit IP/CIDR proxy ranges", () => {
    expect(loadConfig({
      ...validEnvironment,
      TRUSTED_PROXY_CIDRS: "127.0.0.1,10.20.0.0/16,2001:db8::/48",
    }).TRUSTED_PROXY_CIDRS).toEqual(["127.0.0.1", "10.20.0.0/16", "2001:db8::/48"]);

    for (const value of ["*", "loopback", "10.0.0.0/99", "example.com", "127.0.0.1, attacker.invalid"]) {
      expect(() => loadConfig({ ...validEnvironment, TRUSTED_PROXY_CIDRS: value })).toThrow(
        "TRUSTED_PROXY_CIDRS",
      );
    }
  });

  it("never allows abuse-prevention to fail open in production", () => {
    expect(() => loadConfig({ ...validEnvironment, RATE_LIMIT_FAIL_OPEN: "true" })).toThrow(
      "RATE_LIMIT_FAIL_OPEN must remain false in production",
    );
  });
});

describe("Android device agent safety configuration", () => {
  it("enables the authenticated pull protocol but keeps live reporting off by default", () => {
    expect(loadConfig({
      ...validEnvironment,
      NODE_ENV: "development",
      PROVIDER_MODE: "mock",
      ENABLE_LIVE_SMS: "false",
    })).toMatchObject({
      ENABLE_ANDROID_AGENT: true,
      ENABLE_ANDROID_AGENT_LIVE_REPORTING: false,
    });
  });

  it("only permits live agent outcomes behind all explicit production gates", () => {
    expect(loadConfig({
      ...validEnvironment,
      PROVIDER_MODE: "mock",
      ENABLE_ANDROID_AGENT: "true",
      ENABLE_ANDROID_AGENT_LIVE_REPORTING: "true",
    })).toMatchObject({ ENABLE_ANDROID_AGENT_LIVE_REPORTING: true });

    for (const override of [
      { NODE_ENV: "development" },
      { ENABLE_LIVE_SMS: "false" },
      { ENABLE_ANDROID_AGENT: "false" },
    ]) {
      expect(() => loadConfig({
        ...validEnvironment,
        PROVIDER_MODE: "mock",
        ENABLE_ANDROID_AGENT: "true",
        ENABLE_ANDROID_AGENT_LIVE_REPORTING: "true",
        ...override,
      })).toThrow("Android agent live reporting requires production");
    }
  });
});
