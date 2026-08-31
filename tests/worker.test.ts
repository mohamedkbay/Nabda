import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRecord } from "../src/domain/types.js";
import { SecretBox } from "../src/lib/crypto.js";
import type { ProviderRegistry } from "../src/providers/provider-factory.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { MessageProcessor } from "../src/worker/message-processor.js";
import { StatusReconciler } from "../src/worker/status-reconciler.js";
import { MemoryRepository } from "./support/memory-repository.js";
import { defaultUsage } from "./support/fixtures.js";

const SYSTEM_TIME = new Date("2026-08-30T10:30:00.000Z");
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000011";
const API_KEY_ID = "10000000-0000-4000-8000-000000000011";
const DEVICE_ID = "20000000-0000-4000-8000-000000000011";
const MESSAGE_ID = "30000000-0000-4000-8000-000000000011";
const PHONE = "+218912345679";

function queuedMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  const createdAt = new Date(SYSTEM_TIME.getTime() - 60_000);
  return {
    id: MESSAGE_ID,
    organizationId: ORGANIZATION_ID,
    apiKeyId: API_KEY_ID,
    deviceId: DEVICE_ID,
    to: PHONE,
    content: "Your authorized account event was completed.",
    purpose: "transactional",
    status: "queued",
    executionMode: "simulation",
    clientReference: null,
    idempotencyKey: "idem-worker-00000001",
    requestHash: "a".repeat(64),
    providerMessageId: null,
    failureCode: null,
    failureReason: null,
    metadata: {},
    scheduledAt: createdAt,
    expiresAt: new Date(SYSTEM_TIME.getTime() + 60 * 60_000),
    queuedAt: createdAt,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    expiredAt: null,
    cancelledAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function setup() {
  const repository = new MemoryRepository();
  repository.seedDevice({
    id: DEVICE_ID,
    organizationId: ORGANIZATION_ID,
    active: true,
    provider: "mock",
    senderNumber: null,
    encryptedConfig: null,
  });
  repository.seedUsage(ORGANIZATION_ID, defaultUsage({
    periodStart: new Date(SYSTEM_TIME.getTime() - 24 * 60 * 60_000),
    periodEnd: new Date(SYSTEM_TIME.getTime() + 24 * 60 * 60_000),
  }));
  const provider = new MockProvider();
  const send = vi.spyOn(provider, "send");
  const get = vi.fn((_name: "mock" | "httpsms") => provider);
  const providers: ProviderRegistry = { get };
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  const processor = new MessageProcessor(repository, providers, new SecretBox(encryptionKey));
  return { repository, provider, send, get, processor };
}

describe("MessageProcessor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SYSTEM_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the Mock provider to move a queued message to sent without network access", async () => {
    const { repository, send, processor } = setup();
    repository.seedMessage(queuedMessage());

    await processor.process(MESSAGE_ID);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: MESSAGE_ID,
      to: PHONE,
      content: "Your authorized account event was completed.",
      credential: null,
    }));
    const stored = await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID);
    expect(stored).toMatchObject({
      status: "sent",
      failureCode: null,
      failureReason: null,
    });
    expect(stored?.providerMessageId).toMatch(/^mock_/);
    expect(stored?.sentAt?.toISOString()).toBe(SYSTEM_TIME.toISOString());
  });

  it("fails a legacy multi-segment message before any provider call", async () => {
    const { repository, send, get, processor } = setup();
    repository.seedMessage(queuedMessage({ content: "ن".repeat(71) }));

    await processor.process(MESSAGE_ID);

    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID)).toMatchObject({
      status: "failed",
      failureCode: "message_exceeds_single_segment",
    });
  });

  it("cancels at claim time when the recipient opted out after acceptance", async () => {
    const { repository, send, get, processor } = setup();
    repository.seedMessage(queuedMessage());
    // The opt-out is deliberately inserted after the queued record to model the race with dispatch.
    repository.seedOptOut(ORGANIZATION_ID, PHONE);

    await processor.process(MESSAGE_ID);

    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const stored = await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID);
    expect(stored).toMatchObject({
      status: "cancelled",
      failureCode: "recipient_opted_out",
      failureReason: "The recipient opted out before dispatch.",
    });
    expect(stored?.cancelledAt?.toISOString()).toBe(SYSTEM_TIME.toISOString());
  });

  it("never dispatches a queued simulation message after the worker switches to live mode", async () => {
    const repository = new MemoryRepository("live");
    repository.seedDevice({
      id: DEVICE_ID,
      organizationId: ORGANIZATION_ID,
      active: true,
      provider: "mock",
      senderNumber: null,
      encryptedConfig: null,
    });
    repository.seedUsage(ORGANIZATION_ID, defaultUsage({
      periodStart: new Date(SYSTEM_TIME.getTime() - 24 * 60 * 60_000),
      periodEnd: new Date(SYSTEM_TIME.getTime() + 24 * 60 * 60_000),
    }));
    repository.seedMessage(queuedMessage({ executionMode: "simulation" }));
    const provider = new MockProvider();
    const send = vi.spyOn(provider, "send");
    const processor = new MessageProcessor(
      repository,
      { get: () => provider },
      new SecretBox(Buffer.alloc(32, 7).toString("base64")),
    );

    await processor.process(MESSAGE_ID);

    expect(send).not.toHaveBeenCalled();
    expect(await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID)).toMatchObject({
      status: "cancelled",
      executionMode: "simulation",
      failureCode: "execution_mode_mismatch",
    });
  });

  it("returns a retry time from the shared database fence without claiming or calling the provider", async () => {
    const { repository, send, processor } = setup();
    const secondId = "30000000-0000-4000-8000-000000000012";
    repository.seedMessage(queuedMessage());
    repository.seedMessage(queuedMessage({
      id: secondId,
      to: "+218912345680",
      idempotencyKey: "idem-worker-00000002",
    }));

    await processor.process(MESSAGE_ID);
    expect(send).toHaveBeenCalledTimes(1);

    expect(await processor.process(secondId)).toEqual({
      kind: "rate_limited",
      retryAt: new Date(SYSTEM_TIME.getTime() + 6_000),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(repository.isProcessingMessage(secondId)).toBe(false);

    vi.setSystemTime(new Date(SYSTEM_TIME.getTime() + 6_000));
    expect(await processor.process(secondId)).toEqual({ kind: "complete" });
    expect(send).toHaveBeenCalledTimes(2);
    expect((await repository.getMessage(ORGANIZATION_ID, secondId))?.status).toBe("sent");
  });

  it("commits in-flight ordering and releases database locks before the provider call", async () => {
    const repository = new MemoryRepository();
    repository.seedDevice({
      id: DEVICE_ID,
      organizationId: ORGANIZATION_ID,
      active: true,
      provider: "mock",
      senderNumber: null,
      encryptedConfig: null,
    });
    repository.seedMessage(queuedMessage());
    repository.seedUsage(ORGANIZATION_ID, defaultUsage({
      periodStart: new Date(SYSTEM_TIME.getTime() - 24 * 60 * 60_000),
      periodEnd: new Date(SYSTEM_TIME.getTime() + 24 * 60 * 60_000),
    }));
    let signalSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => { signalSendStarted = resolve; });
    const mayComplete = new Promise<void>((resolve) => { releaseSend = resolve; });
    const provider = new MockProvider({
      send: async () => {
        signalSendStarted();
        await mayComplete;
        return { providerMessageId: "mock_in_flight", status: "sent", rawStatus: "mock_accepted" };
      },
    });
    const processor = new MessageProcessor(
      repository,
      { get: () => provider },
      new SecretBox(Buffer.alloc(32, 7).toString("base64")),
    );

    const dispatch = processor.process(MESSAGE_ID);
    await sendStarted;
    let optOutCompleted = false;
    const optOut = repository.addOptOut({
      organizationId: ORGANIZATION_ID,
      apiKeyId: API_KEY_ID,
      phone: PHONE,
      at: SYSTEM_TIME,
    }).then((result) => {
      optOutCompleted = true;
      return result;
    });
    const optOutResult = await optOut;
    expect(optOutCompleted).toBe(true);
    expect(optOutResult.created).toBe(true);
    expect(optOutResult.cancelledMessageIds).toEqual([]);

    releaseSend();
    await dispatch;
    expect((await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID))?.status).toBe("sent");
  });

  it("expires a queued message at claim time without invoking a provider", async () => {
    const { repository, send, get, processor } = setup();
    repository.seedMessage(queuedMessage({
      expiresAt: new Date(SYSTEM_TIME.getTime() - 1),
    }));

    await processor.process(MESSAGE_ID);

    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const stored = await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID);
    expect(stored).toMatchObject({
      status: "expired",
      failureCode: "message_expired",
      failureReason: "The message expired before dispatch.",
    });
    expect(stored?.expiredAt?.toISOString()).toBe(SYSTEM_TIME.toISOString());
  });

  it("reconciles a later provider delivery receipt without sending again", async () => {
    const repository = new MemoryRepository();
    repository.seedDevice({
      id: DEVICE_ID,
      organizationId: ORGANIZATION_ID,
      active: true,
      provider: "mock",
      senderNumber: null,
      encryptedConfig: null,
    });
    repository.seedMessage(queuedMessage({
      status: "sent",
      providerMessageId: "mock_remote_1",
      sentAt: new Date(SYSTEM_TIME.getTime() - 30_000),
    }));
    const provider = new MockProvider({ resultStatus: "delivered" });
    const send = vi.spyOn(provider, "send");
    const reconciler = new StatusReconciler(
      repository,
      { get: () => provider },
      new SecretBox(Buffer.alloc(32, 7).toString("base64")),
      10_000,
    );

    await reconciler.runOnce();

    expect(send).not.toHaveBeenCalled();
    const stored = await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID);
    expect(stored?.status).toBe("delivered");
    expect(stored?.deliveredAt?.toISOString()).toBe(SYSTEM_TIME.toISOString());
  });

  it("expires a sent Android message without polling any provider", async () => {
    const repository = new MemoryRepository();
    repository.seedDevice({
      id: DEVICE_ID,
      organizationId: ORGANIZATION_ID,
      active: true,
      provider: "android_agent",
      senderNumber: null,
      encryptedConfig: null,
    });
    repository.seedMessage(queuedMessage({
      status: "sent",
      executionMode: "simulation",
      providerMessageId: null,
      sentAt: new Date(SYSTEM_TIME.getTime() - 60_000),
      expiresAt: new Date(SYSTEM_TIME.getTime() - 1),
    }));
    const get = vi.fn();
    const reconciler = new StatusReconciler(
      repository,
      { get } as unknown as ProviderRegistry,
      new SecretBox(Buffer.alloc(32, 7).toString("base64")),
      10_000,
    );

    await reconciler.runOnce();

    expect(get).not.toHaveBeenCalled();
    expect(await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID)).toMatchObject({
      status: "expired",
      failureCode: "provider_expired",
      failureReason: "The delivery receipt did not arrive before the message expired.",
    });
  });

  it("sweeps an expired Android queue even when the phone never reconnects", async () => {
    const repository = new MemoryRepository();
    repository.seedMessage(queuedMessage({ expiresAt: new Date(SYSTEM_TIME.getTime() - 1) }));

    await repository.claimOutboxJobs(50, "maintenance-test", SYSTEM_TIME);

    expect(await repository.getMessage(ORGANIZATION_ID, MESSAGE_ID)).toMatchObject({
      status: "expired",
      failureCode: "message_expired",
    });
  });
});
