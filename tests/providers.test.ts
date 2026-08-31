import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderError } from "../src/domain/errors.js";
import { HttpSmsProvider } from "../src/providers/httpsms-provider.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { createProviderRegistry } from "../src/providers/provider-factory.js";

const sendInput = {
  messageId: "30000000-0000-4000-8000-000000000001",
  from: "+218911111111",
  to: "+218922222222",
  content: "Authorized test transaction",
  scheduledAt: new Date("2026-08-30T10:15:00.000Z"),
  credential: null,
};

describe("MockProvider", () => {
  it("is self-contained and returns a synthetic provider id", async () => {
    const provider = new MockProvider();

    await expect(provider.send(sendInput)).resolves.toMatchObject({
      status: "sent",
      rawStatus: "mock_accepted",
    });
    const result = await provider.send(sendInput);
    expect(result.providerMessageId).toMatch(/^mock_/);
  });

  it("allows deterministic behavior in worker tests", async () => {
    const send = vi.fn(async () => ({
      providerMessageId: "mock_fixed",
      status: "delivered" as const,
      rawStatus: "mock_delivered",
    }));
    const provider = new MockProvider({ send });

    await expect(provider.send(sendInput)).resolves.toMatchObject({
      providerMessageId: "mock_fixed",
      status: "delivered",
    });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("HttpSmsProvider live-send guard", () => {
  it("cannot be constructed while live SMS is disabled", () => {
    const fetchSpy = vi.fn();

    expect(() => new HttpSmsProvider({
      apiBase: "https://provider.invalid/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: false,
      environment: "production",
      fetchImplementation: fetchSpy as unknown as typeof fetch,
    })).toThrowError(ProviderError);
    expect(() => new HttpSmsProvider({
      apiBase: "https://provider.invalid/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: false,
      environment: "production",
      fetchImplementation: fetchSpy as unknown as typeof fetch,
    })).toThrow("Live SMS is disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the guard active in the test environment even if the flag is true", () => {
    expect(() => new HttpSmsProvider({
      apiBase: "https://provider.invalid/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: true,
      environment: "test",
      fetchImplementation: vi.fn() as unknown as typeof fetch,
    })).toThrow("Live SMS is disabled");
  });

  it("keeps live sending disabled in the development environment", () => {
    expect(() => new HttpSmsProvider({
      apiBase: "https://provider.invalid/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: true,
      environment: "development",
      fetchImplementation: vi.fn() as unknown as typeof fetch,
    })).toThrow("Live SMS is disabled");
  });

  it("checks the live guard before validating the provider URL", () => {
    expect(() => new HttpSmsProvider({
      apiBase: "http://attacker.invalid/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: false,
      environment: "production",
      fetchImplementation: vi.fn() as unknown as typeof fetch,
    })).toThrow("Live SMS is disabled");
  });

  it.each([
    "http://api.httpsms.com/v1",
    "https://provider.invalid/v1",
    "https://api.httpsms.com.attacker.invalid/v1",
  ])("rejects a non-official live provider base URL: %s", (apiBase) => {
    expect(() => new HttpSmsProvider({
      apiBase,
      timeoutMs: 1_000,
      liveSmsEnabled: true,
      environment: "production",
      fetchImplementation: vi.fn() as unknown as typeof fetch,
    })).toThrow("official HTTPS endpoint");
  });

  it("accepts the official HTTPS provider host without making a request", () => {
    const fetchSpy = vi.fn();
    expect(() => new HttpSmsProvider({
      apiBase: "https://api.httpsms.com/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: true,
      environment: "production",
      fetchImplementation: fetchSpy as unknown as typeof fetch,
    })).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks provider 5xx responses as an unknown outcome", async () => {
    const provider = new HttpSmsProvider({
      apiBase: "https://api.httpsms.com/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: true,
      environment: "production",
      fetchImplementation: vi.fn(async () => new Response("server error", { status: 503 })),
    });

    const result = provider.send({ ...sendInput, credential: "provider-test-key" });
    await expect(result).rejects.toMatchObject({
      code: "provider_outcome_unknown",
      outcomeUnknown: true,
    });
  });

  it.each([408, 409])("treats ambiguous provider HTTP %s as an unknown outcome", async (status) => {
    const provider = new HttpSmsProvider({
      apiBase: "https://api.httpsms.com/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: true,
      environment: "production",
      fetchImplementation: vi.fn(async () => new Response("ambiguous", { status })),
    });

    await expect(provider.send({ ...sendInput, credential: "provider-test-key" })).rejects.toMatchObject({
      code: "provider_outcome_unknown",
      outcomeUnknown: true,
    });
  });

  it("keeps confirmed client rejections distinct from unknown outcomes", async () => {
    const provider = new HttpSmsProvider({
      apiBase: "https://api.httpsms.com/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: true,
      environment: "production",
      fetchImplementation: vi.fn(async () => new Response("bad request", { status: 400 })),
    });

    const result = provider.send({ ...sendInput, credential: "provider-test-key" });
    await expect(result).rejects.toMatchObject({
      code: "provider_rejected",
      outcomeUnknown: false,
    });
  });

  it("marks a truncated provider response as an unknown outcome", async () => {
    const brokenResponse = {
      ok: true,
      status: 200,
      text: vi.fn(async () => { throw new Error("truncated"); }),
    } as unknown as Response;
    const provider = new HttpSmsProvider({
      apiBase: "https://api.httpsms.com/v1",
      timeoutMs: 1_000,
      liveSmsEnabled: true,
      environment: "production",
      fetchImplementation: vi.fn(async () => brokenResponse),
    });

    const result = provider.send({ ...sendInput, credential: "provider-test-key" });
    await expect(result).rejects.toMatchObject({
      code: "provider_outcome_unknown",
      outcomeUnknown: true,
    });
  });
});

describe("provider registry mode isolation", () => {
  const baseEnvironment = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    API_KEY_HASH_SECRET: "test-hash-secret-that-is-at-least-32-characters",
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  } satisfies NodeJS.ProcessEnv;

  it("registers only Mock in mock mode", () => {
    const registry = createProviderRegistry(loadConfig({
      ...baseEnvironment,
      PROVIDER_MODE: "mock",
      ENABLE_LIVE_SMS: "false",
    }));

    expect(registry.get("mock")).toBeInstanceOf(MockProvider);
    expect(() => registry.get("httpsms")).toThrow("Provider httpsms is disabled");
  });

  it("registers only httpSMS in explicitly enabled production mode", () => {
    const registry = createProviderRegistry(loadConfig({
      ...baseEnvironment,
      NODE_ENV: "production",
      PROVIDER_MODE: "httpsms",
      ENABLE_LIVE_SMS: "true",
      HTTPSMS_API_BASE: "https://api.httpsms.com/v1",
    }));

    expect(registry.get("httpsms")).toBeInstanceOf(HttpSmsProvider);
    expect(() => registry.get("mock")).toThrow("Provider mock is disabled");
  });
});
