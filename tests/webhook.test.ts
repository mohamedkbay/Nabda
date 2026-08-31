import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretBox, signWebhook } from "../src/lib/crypto.js";
import { validateWebhookUrl, WebhookProcessor } from "../src/worker/webhook-processor.js";
import { MemoryRepository } from "./support/memory-repository.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const DELIVERY_ID = "40000000-0000-4000-8000-000000000001";

function seedDelivery(repository: MemoryRepository, secretBox: SecretBox, url: string): void {
  repository.seedWebhookDelivery({
    id: DELIVERY_ID,
    lockId: "lease-1",
    organizationId: "00000000-0000-4000-8000-000000000001",
    webhookId: "50000000-0000-4000-8000-000000000001",
    url,
    encryptedSecret: secretBox.encrypt("tenant-webhook-secret"),
    payload: { id: "evt_1", type: "message.sent", data: { message: { id: "msg_1" } } },
    event: {
      id: "1",
      organizationId: "00000000-0000-4000-8000-000000000001",
      messageId: "30000000-0000-4000-8000-000000000001",
      type: "message.sent",
      payload: {},
      createdAt: NOW,
    },
    attemptCount: 1,
  });
}

describe("webhook delivery boundary", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    "http://93.184.216.34/hook",
    "https://127.0.0.1/hook",
    "https://10.0.0.1/hook",
    "https://[::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://240.0.0.1/hook",
    "https://255.255.255.255/hook",
    "https://[::127.0.0.1]/hook",
    "https://[64:ff9b::7f00:1]/hook",
    "https://[2002:7f00:1::]/hook",
    "https://localhost/hook",
  ])("rejects an unsafe production destination: %s", async (url) => {
    await expect(validateWebhookUrl(url, "production")).rejects.toThrow();
  });

  it("signs the exact payload and sends it to the pinned public address", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const repository = new MemoryRepository();
    const secretBox = new SecretBox(Buffer.alloc(32, 6).toString("base64"));
    const secret = "tenant-webhook-secret";
    const payload = { id: "evt_1", type: "message.sent", data: { message: { id: "msg_1" } } };
    repository.seedWebhookDelivery({
      id: "40000000-0000-4000-8000-000000000001",
      lockId: "lease-1",
      organizationId: "00000000-0000-4000-8000-000000000001",
      webhookId: "50000000-0000-4000-8000-000000000001",
      url: "https://93.184.216.34/hooks/nabda",
      encryptedSecret: secretBox.encrypt(secret),
      payload,
      event: {
        id: "1",
        organizationId: "00000000-0000-4000-8000-000000000001",
        messageId: "30000000-0000-4000-8000-000000000001",
        type: "message.sent",
        payload: {},
        createdAt: NOW,
      },
      attemptCount: 1,
    });
    const transport = vi.fn(async (
      _destination: unknown,
      _body: string,
      _headers: Record<string, string>,
      _timeoutMs: number,
    ) => 204);
    const processor = new WebhookProcessor(repository, secretBox, "production", 5_000, transport);

    await processor.process("40000000-0000-4000-8000-000000000001");

    expect(transport).toHaveBeenCalledOnce();
    const [destination, rawBody, headers] = transport.mock.calls[0] as unknown as [
      { address: string },
      string,
      Record<string, string>,
    ];
    const timestamp = Math.floor(NOW.getTime() / 1000);
    expect(destination.address).toBe("93.184.216.34");
    expect(rawBody).toBe(JSON.stringify(payload));
    expect(headers["x-nabda-signature"]).toBe(signWebhook(timestamp, rawBody, secret));
    expect(headers["x-nabda-event-id"]).toBe("1");
    expect(headers["x-nabda-timestamp"]).toBe(String(timestamp));
  });

  it("uses one total deadline across DNS resolution and the HTTP request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const repository = new MemoryRepository();
    const secretBox = new SecretBox(Buffer.alloc(32, 6).toString("base64"));
    seedDelivery(repository, secretBox, "https://hooks.example.com/nabda");
    const resolver = vi.fn(() => new Promise<readonly { address: string }[]>((resolve) => {
      setTimeout(() => resolve([{ address: "93.184.216.34" }]), 400);
    }));
    const transport = vi.fn(async (
      _destination: unknown,
      _body: string,
      _headers: Record<string, string>,
      _timeoutMs: number,
    ) => new Promise<number>(() => undefined));
    const processor = new WebhookProcessor(
      repository,
      secretBox,
      "production",
      1_000,
      transport,
      resolver,
    );

    const processing = processor.process(DELIVERY_ID);
    const rejection = expect(processing).rejects.toThrow(
      "Webhook delivery exceeded its total deadline during HTTP request.",
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(resolver).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[3]).toBe(600);
    await vi.advanceTimersByTimeAsync(599);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it("times out a DNS lookup that never settles without leaving the worker pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const repository = new MemoryRepository();
    const secretBox = new SecretBox(Buffer.alloc(32, 6).toString("base64"));
    seedDelivery(repository, secretBox, "https://dns-hang.example.com/nabda");
    const resolver = vi.fn(() => new Promise<readonly { address: string }[]>(() => undefined));
    const transport = vi.fn(async () => 204);
    const processor = new WebhookProcessor(
      repository,
      secretBox,
      "production",
      1_000,
      transport,
      resolver,
    );

    const processing = processor.process(DELIVERY_ID);
    const rejection = expect(processing).rejects.toThrow(
      "Webhook delivery exceeded its total deadline during DNS resolution.",
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(transport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;

    expect(resolver).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
