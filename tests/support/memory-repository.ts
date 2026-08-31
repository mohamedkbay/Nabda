import { randomUUID } from "node:crypto";
import type {
  ApiKeyRecord,
  ContactCursor,
  ContactPage,
  ContactRecord,
  CreateMessageCommand,
  CreateMessageResult,
  DeviceAgentBeginResult,
  DeviceAgentClaimResult,
  DeviceAgentCredentialRecord,
  DeviceAgentEventResult,
  DeviceAgentEventStatus,
  DeviceAgentPrincipal,
  DispatchSlotResult,
  MessageExecutionMode,
  MessageRecord,
  OptOutResult,
  OutboxJob,
  QueueSummaryRecord,
  StatusCheckMessage,
  UpsertContactCommand,
  UpsertContactResult,
  UsageRecord,
  WebhookDeliveryRecord,
  WorkerDispatchClaimResult,
} from "../../src/domain/types.js";
import type { Repository } from "../../src/repositories/repository.js";

export interface MemoryDevice {
  id: string;
  organizationId: string;
  active: boolean;
  provider: "mock" | "httpsms" | "android_agent";
  senderNumber: string | null;
  encryptedConfig: string | null;
}

interface MemoryDeviceLease {
  tokenHash: string;
  expiresAt: Date;
  attemptId: string | null;
  begunAt: Date | null;
}

interface MemoryDeviceEventReceipt {
  organizationId: string;
  deviceId: string;
  messageId: string;
  attemptId: string;
  leaseTokenHash: string;
  requestHash: string;
}

function copyMessage(message: MessageRecord): MessageRecord {
  return {
    ...message,
    metadata: { ...message.metadata },
  };
}

function copyUsage(usage: UsageRecord): UsageRecord {
  return { ...usage };
}

function copyContact(contact: ContactRecord): ContactRecord {
  return {
    ...contact,
    tags: [...contact.tags],
    metadata: { ...contact.metadata },
    deletedAt: contact.deletedAt ? new Date(contact.deletedAt.getTime()) : null,
    createdAt: new Date(contact.createdAt.getTime()),
    updatedAt: new Date(contact.updatedAt.getTime()),
  };
}

export class MemoryRepository implements Repository {
  failHealth = false;
  readonly touchedApiKeys = new Map<string, Date>();
  readonly touchedDeviceCredentials = new Map<string, Date>();
  readonly outboxJobs: OutboxJob[] = [];

  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  private readonly deviceCredentials = new Map<string, DeviceAgentCredentialRecord>();
  private readonly usages = new Map<string, UsageRecord>();
  private readonly devices = new Map<string, MemoryDevice>();
  private readonly messages = new Map<string, MessageRecord>();
  private readonly contacts = new Map<string, ContactRecord>();
  private readonly processingMessages = new Set<string>();
  private readonly manualReviewMessages = new Set<string>();
  private readonly deviceLeases = new Map<string, MemoryDeviceLease>();
  private readonly deviceDispatchStarted = new Map<string, Date>();
  private readonly organizationDispatchFences = new Map<string, { messageId: string; at: Date }>();
  private readonly deviceDispatchFences = new Map<string, { messageId: string; at: Date }>();
  private readonly deviceEventReceipts = new Map<string, MemoryDeviceEventReceipt>();
  private readonly optedOutRecipients = new Map<string, string>();
  private readonly recipientLocks = new Map<string, Promise<void>>();
  private readonly webhookDeliveries = new Map<string, WebhookDeliveryRecord>();

  constructor(private readonly executionMode: MessageExecutionMode = "simulation") {}

  private credentialMatches(principal: DeviceAgentPrincipal): boolean {
    return [...this.deviceCredentials.values()].some((credential) => (
      credential.credentialId === principal.credentialId
      && credential.organizationId === principal.organizationId
      && credential.deviceId === principal.deviceId
      && credential.mode === principal.mode
      && credential.revokedAt === null
    ));
  }

  seedApiKey(prefix: string, record: ApiKeyRecord): void {
    this.apiKeys.set(prefix, { ...record, scopes: [...record.scopes] });
  }

  seedUsage(organizationId: string, usage: UsageRecord): void {
    this.usages.set(organizationId, copyUsage(usage));
  }

  seedDeviceAgentCredential(prefix: string, record: DeviceAgentCredentialRecord): void {
    this.deviceCredentials.set(prefix, { ...record });
  }

  seedDevice(device: MemoryDevice): void {
    this.devices.set(device.id, { ...device });
  }

  seedMessage(message: MessageRecord): void {
    this.messages.set(message.id, copyMessage(message));
    this.processingMessages.delete(message.id);
  }

  seedOptOut(organizationId: string, phone: string): void {
    this.optedOutRecipients.set(`${organizationId}:${phone}`, randomUUID());
  }

  seedWebhookDelivery(delivery: WebhookDeliveryRecord): void {
    this.webhookDeliveries.set(delivery.id, delivery);
  }

  allMessages(): MessageRecord[] {
    return [...this.messages.values()].map(copyMessage);
  }

  allContacts(): ContactRecord[] {
    return [...this.contacts.values()].map(copyContact);
  }

  isProcessingMessage(messageId: string): boolean {
    return this.processingMessages.has(messageId);
  }

  isManualReviewMessage(messageId: string): boolean {
    return this.manualReviewMessages.has(messageId);
  }

  async health(): Promise<void> {
    if (this.failHealth) throw new Error("memory repository unavailable");
  }

  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const record = this.apiKeys.get(prefix);
    return record ? { ...record, scopes: [...record.scopes] } : null;
  }

  async touchApiKey(apiKeyId: string, at: Date): Promise<void> {
    this.touchedApiKeys.set(apiKeyId, new Date(at.getTime()));
  }

  async findDeviceAgentCredentialByPrefix(prefix: string): Promise<DeviceAgentCredentialRecord | null> {
    const record = this.deviceCredentials.get(prefix);
    return record ? { ...record } : null;
  }

  async touchDeviceAgentCredential(credentialId: string, at: Date): Promise<void> {
    this.touchedDeviceCredentials.set(credentialId, new Date(at.getTime()));
  }

  async heartbeatDeviceAgent(input: {
    principal: DeviceAgentPrincipal;
    telemetry: Record<string, unknown>;
    at: Date;
  }): Promise<boolean> {
    const device = this.devices.get(input.principal.deviceId);
    if (
      !device
      || device.organizationId !== input.principal.organizationId
      || device.provider !== "android_agent"
      || !device.active
      || !this.credentialMatches(input.principal)
    ) return false;
    return true;
  }

  async claimDeviceAgentMessage(input: {
    principal: DeviceAgentPrincipal;
    leaseTokenHash: string;
    leaseExpiresAt: Date;
    at: Date;
  }): Promise<DeviceAgentClaimResult> {
    const device = this.devices.get(input.principal.deviceId);
    if (
      !device
      || !device.active
      || device.organizationId !== input.principal.organizationId
      || device.provider !== "android_agent"
      || !this.credentialMatches(input.principal)
    ) return { kind: "device_unavailable" };

    const candidates = [...this.messages.values()]
      .filter((message) => (
        message.organizationId === input.principal.organizationId
        && message.deviceId === input.principal.deviceId
        && message.executionMode === input.principal.mode
        && message.status === "queued"
        && message.scheduledAt <= input.at
        && !this.processingMessages.has(message.id)
        && (!this.deviceLeases.has(message.id)
          || (this.deviceLeases.get(message.id)?.expiresAt.getTime() ?? 0) <= input.at.getTime())
      ))
      .sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime());
    for (const message of candidates) {
      if (message.expiresAt <= input.at) {
        this.messages.set(message.id, {
          ...message,
          status: "expired",
          failureCode: "message_expired",
          failureReason: "The message expired before the Android device claimed it.",
          expiredAt: new Date(input.at),
          updatedAt: new Date(input.at),
        });
        this.deviceLeases.delete(message.id);
        continue;
      }
      const usage = this.usages.get(message.organizationId);
      if (!usage || !["active", "trialing"].includes(usage.subscriptionStatus)) {
        this.messages.set(message.id, {
          ...message,
          status: "cancelled",
          failureCode: "subscription_inactive",
          failureReason: "Dispatch was cancelled because the subscription is inactive.",
          cancelledAt: new Date(input.at),
          updatedAt: new Date(input.at),
        });
        this.deviceLeases.delete(message.id);
        continue;
      }
      if (this.optedOutRecipients.has(`${message.organizationId}:${message.to}`)) {
        this.messages.set(message.id, {
          ...message,
          status: "cancelled",
          failureCode: "recipient_opted_out",
          failureReason: "The recipient opted out before the Android device claimed the message.",
          cancelledAt: new Date(input.at),
          updatedAt: new Date(input.at),
        });
        this.deviceLeases.delete(message.id);
        continue;
      }
      this.deviceLeases.set(message.id, {
        tokenHash: input.leaseTokenHash,
        expiresAt: new Date(input.leaseExpiresAt),
        attemptId: null,
        begunAt: null,
      });
      return {
        kind: "claimed",
        claim: { message: copyMessage(message), leaseExpiresAt: new Date(input.leaseExpiresAt) },
      };
    }
    return { kind: "empty" };
  }

  private reserveDispatchSlot(input: {
    organizationId: string;
    deviceId: string;
    messageId: string;
    perMinuteRateLimit: number;
    dispatchMinIntervalMs: number;
    at: Date;
  }): DispatchSlotResult {
    const message = this.messages.get(input.messageId);
    const device = this.devices.get(input.deviceId);
    if (
      !message
      || message.organizationId !== input.organizationId
      || message.deviceId !== input.deviceId
      || message.status !== "queued"
      || !device?.active
    ) return { kind: "unavailable" };
    const organizationFence = this.organizationDispatchFences.get(input.organizationId);
    const deviceFenceKey = `${input.organizationId}:${input.deviceId}`;
    const deviceFence = this.deviceDispatchFences.get(deviceFenceKey);
    if (
      organizationFence?.messageId === input.messageId
      && deviceFence?.messageId === input.messageId
    ) return { kind: "reserved", duplicate: true };
    const lastDispatch = [organizationFence?.at, deviceFence?.at]
      .filter((candidate): candidate is Date => candidate instanceof Date)
      .sort((left, right) => right.getTime() - left.getTime())[0];
    if (lastDispatch) {
      const planIntervalMs = Math.ceil(60_000 / Math.max(input.perMinuteRateLimit, 1));
      const retryAt = new Date(lastDispatch.getTime() + Math.max(input.dispatchMinIntervalMs, planIntervalMs));
      if (retryAt > input.at) return { kind: "rate_limited", retryAt };
    }
    const reservedAt = new Date(input.at);
    this.organizationDispatchFences.set(input.organizationId, { messageId: input.messageId, at: reservedAt });
    this.deviceDispatchFences.set(deviceFenceKey, { messageId: input.messageId, at: reservedAt });
    this.deviceDispatchStarted.set(input.messageId, reservedAt);
    return { kind: "reserved", duplicate: false };
  }

  async beginDeviceAgentMessage(input: {
    principal: DeviceAgentPrincipal;
    messageId: string;
    attemptId: string;
    leaseTokenHash: string;
    attemptLeaseExpiresAt: Date;
    dispatchMinIntervalMs: number;
    at: Date;
  }): Promise<DeviceAgentBeginResult> {
    const message = this.messages.get(input.messageId);
    if (
      !message
      || message.organizationId !== input.principal.organizationId
      || message.deviceId !== input.principal.deviceId
      || message.executionMode !== input.principal.mode
      || this.devices.get(message.deviceId)?.provider !== "android_agent"
      || !this.credentialMatches(input.principal)
    ) return { kind: "not_found" };
    const lease = this.deviceLeases.get(message.id);
    if (!lease || lease.tokenHash !== input.leaseTokenHash) return { kind: "invalid_lease" };
    if (lease.expiresAt <= input.at) return { kind: "lease_expired" };
    const duplicateAttempt = this.processingMessages.has(message.id)
      && lease.attemptId === input.attemptId;
    if (this.processingMessages.has(message.id) && !duplicateAttempt) return { kind: "invalid_attempt" };
    if (message.status !== "queued") return { kind: "not_dispatchable", message: copyMessage(message) };

    let terminal: MessageRecord | null = null;
    if (message.expiresAt <= input.at) {
      terminal = {
        ...message,
        status: "expired",
        failureCode: "message_expired",
        failureReason: "The message expired before the Android sending attempt began.",
        expiredAt: new Date(input.at),
        updatedAt: new Date(input.at),
      };
    } else if (
      input.principal.organizationStatus !== "active"
      || !this.usages.has(message.organizationId)
      || !["active", "trialing"].includes(this.usages.get(message.organizationId)?.subscriptionStatus ?? "")
      || !this.devices.get(message.deviceId)?.active
      || ![...this.deviceCredentials.values()].some((credential) => (
        credential.credentialId === input.principal.credentialId
        && credential.organizationId === message.organizationId
        && credential.deviceId === message.deviceId
        && credential.mode === input.principal.mode
        && credential.revokedAt === null
      ))
    ) {
      terminal = {
        ...message,
        status: "cancelled",
        failureCode: "device_unavailable",
        failureReason: "Dispatch was cancelled because the organization, subscription, or device is unavailable.",
        cancelledAt: new Date(input.at),
        updatedAt: new Date(input.at),
      };
    } else if (this.optedOutRecipients.has(`${message.organizationId}:${message.to}`)) {
      terminal = {
        ...message,
        status: "cancelled",
        failureCode: "recipient_opted_out",
        failureReason: "The recipient opted out before the Android sending attempt began.",
        cancelledAt: new Date(input.at),
        updatedAt: new Date(input.at),
      };
    }
    if (terminal) {
      this.messages.set(terminal.id, terminal);
      this.deviceLeases.delete(terminal.id);
      this.processingMessages.delete(terminal.id);
      return { kind: "not_dispatchable", message: copyMessage(terminal) };
    }

    if (duplicateAttempt) {
      return {
        kind: "authorized",
        message: copyMessage(message),
        leaseExpiresAt: new Date(lease.expiresAt),
        duplicate: true,
      };
    }

    const slot = await this.reserveDispatchSlot({
      organizationId: message.organizationId,
      deviceId: message.deviceId,
      messageId: message.id,
      perMinuteRateLimit: this.usages.get(message.organizationId)?.perMinuteRateLimit ?? 1,
      dispatchMinIntervalMs: input.dispatchMinIntervalMs,
      at: input.at,
    });
    if (slot.kind === "rate_limited") return slot;
    if (slot.kind === "unavailable") return { kind: "not_dispatchable", message: copyMessage(message) };
    lease.attemptId = input.attemptId;
    lease.begunAt = new Date(input.at);
    lease.expiresAt = new Date(input.attemptLeaseExpiresAt);
    this.processingMessages.add(message.id);
    return {
      kind: "authorized",
      message: copyMessage(message),
      leaseExpiresAt: new Date(input.attemptLeaseExpiresAt),
      duplicate: false,
    };
  }

  async recordDeviceAgentEvent(input: {
    principal: DeviceAgentPrincipal;
    messageId: string;
    eventId: string;
    attemptId: string;
    leaseTokenHash: string;
    requestHash: string;
    requestedStatus: DeviceAgentEventStatus;
    providerMessageId?: string;
    errorCode?: string;
    errorMessage?: string;
    occurredAt: Date;
    at: Date;
  }): Promise<DeviceAgentEventResult> {
    const simulated = input.principal.mode === "simulation";
    if (!this.credentialMatches(input.principal)) return { kind: "not_found" };
    const receiptKey = `${input.principal.organizationId}:${input.eventId}`;
    const receipt = this.deviceEventReceipts.get(receiptKey);
    if (receipt) {
      if (
        receipt.deviceId !== input.principal.deviceId
        || receipt.messageId !== input.messageId
        || receipt.attemptId !== input.attemptId
      ) return { kind: "event_conflict" };
      if (receipt.leaseTokenHash !== input.leaseTokenHash) return { kind: "invalid_lease" };
      if (receipt.requestHash !== input.requestHash) return { kind: "event_conflict" };
      const replayed = this.messages.get(input.messageId);
      return replayed
        ? { kind: "accepted", message: copyMessage(replayed), duplicate: true }
        : { kind: "not_found" };
    }
    const message = this.messages.get(input.messageId);
    if (
      !message
      || message.organizationId !== input.principal.organizationId
      || message.deviceId !== input.principal.deviceId
      || message.executionMode !== input.principal.mode
      || this.devices.get(message.deviceId)?.provider !== "android_agent"
    ) return { kind: "not_found" };
    const lease = this.deviceLeases.get(message.id);
    if (
      !lease
      || lease.tokenHash !== input.leaseTokenHash
      || lease.attemptId !== input.attemptId
      || (message.status === "queued" && !this.processingMessages.has(message.id))
    ) return { kind: "invalid_lease" };
    if (lease.expiresAt <= input.at) return { kind: "lease_expired" };
    const validTransition = simulated
      ? message.status === "queued"
      : message.status === "queued"
        ? ["sent", "delivered", "failed", "cancelled"].includes(input.requestedStatus)
        : message.status === "sent"
          ? ["delivered", "failed"].includes(input.requestedStatus)
          : false;
    if (!validTransition) return { kind: "invalid_transition" };
    const status = simulated ? "cancelled" : input.requestedStatus;
    const providerOutcomeUnknown = !simulated
      && status === "failed"
      && ["agent_restart_unknown", "agent_dispatch_failed"].includes(input.errorCode ?? "");
    const updated: MessageRecord = {
      ...message,
      status,
      providerMessageId: simulated ? null : input.providerMessageId ?? message.providerMessageId,
      failureCode: simulated
        ? "simulation_only"
        : providerOutcomeUnknown
          ? "provider_outcome_unknown"
          : status === "failed"
            ? input.errorCode ?? "android_agent_failed"
            : status === "cancelled"
              ? input.errorCode ?? "android_agent_cancelled"
              : null,
      failureReason: simulated
        ? "Simulation completed without sending an SMS."
        : providerOutcomeUnknown
          ? "The Android agent restarted after dispatch began; the carrier outcome is unknown and requires manual review."
          : input.errorMessage ?? null,
      sentAt: ["sent", "delivered"].includes(status) ? message.sentAt ?? new Date(input.occurredAt) : message.sentAt,
      deliveredAt: status === "delivered" ? new Date(input.occurredAt) : message.deliveredAt,
      failedAt: status === "failed" ? new Date(input.occurredAt) : message.failedAt,
      cancelledAt: status === "cancelled" ? new Date(input.occurredAt) : message.cancelledAt,
      updatedAt: new Date(input.occurredAt),
    };
    this.messages.set(updated.id, updated);
    this.processingMessages.delete(updated.id);
    if (providerOutcomeUnknown) this.manualReviewMessages.add(updated.id);
    if (status !== "sent") this.deviceLeases.delete(updated.id);
    this.deviceEventReceipts.set(receiptKey, {
      organizationId: input.principal.organizationId,
      deviceId: input.principal.deviceId,
      messageId: input.messageId,
      attemptId: input.attemptId,
      leaseTokenHash: input.leaseTokenHash,
      requestHash: input.requestHash,
    });
    return { kind: "accepted", message: copyMessage(updated), duplicate: false };
  }

  async findIdempotentMessage(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<MessageRecord | null> {
    const message = [...this.messages.values()].find((candidate) => (
      candidate.organizationId === organizationId && candidate.idempotencyKey === idempotencyKey
    ));
    return message ? copyMessage(message) : null;
  }

  async createMessage(command: CreateMessageCommand): Promise<CreateMessageResult> {
    if (command.executionMode !== this.executionMode) return { kind: "device_unavailable" };
    const existing = await this.findIdempotentMessage(command.organizationId, command.idempotencyKey);
    if (existing) {
      return existing.requestHash === command.requestHash
        ? { kind: "replayed", message: existing }
        : { kind: "idempotency_conflict" };
    }

    const usage = this.usages.get(command.organizationId);
    if (!usage || !["active", "trialing"].includes(usage.subscriptionStatus)) {
      return { kind: "subscription_inactive" };
    }
    if (this.optedOutRecipients.has(`${command.organizationId}:${command.to}`)) {
      return { kind: "opted_out" };
    }
    if (usage.messagesUsed >= usage.messageLimit) {
      return {
        kind: "quota_exceeded",
        limit: usage.messageLimit,
        used: usage.messagesUsed,
        resetsAt: usage.periodEnd,
      };
    }

    const device = command.deviceId
      ? this.devices.get(command.deviceId)
      : [...this.devices.values()].find((candidate) => (
        candidate.organizationId === command.organizationId
        && candidate.active
        && candidate.provider !== "android_agent"
        && (candidate.provider === "httpsms" ? "live" : "simulation") === command.executionMode
      ));
    const deviceModeAllowed = device?.provider === "android_agent"
      ? [...this.deviceCredentials.values()].some((credential) => (
        credential.organizationId === command.organizationId
        && credential.deviceId === device.id
        && credential.mode === command.executionMode
        && credential.revokedAt === null
      ))
      : device != null && (device.provider === "httpsms" ? "live" : "simulation") === command.executionMode;
    if (!device || !device.active || device.organizationId !== command.organizationId || !deviceModeAllowed) {
      return { kind: "device_unavailable" };
    }

    const at = new Date(command.consentCapturedAt.getTime());
    const message: MessageRecord = {
      id: randomUUID(),
      organizationId: command.organizationId,
      apiKeyId: command.apiKeyId,
      deviceId: device.id,
      to: command.to,
      content: command.content,
      purpose: command.purpose,
      status: "queued",
      executionMode: command.executionMode,
      clientReference: command.clientReference ?? null,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      providerMessageId: null,
      failureCode: null,
      failureReason: null,
      metadata: { ...command.metadata },
      scheduledAt: new Date(command.scheduledAt.getTime()),
      expiresAt: new Date(command.expiresAt.getTime()),
      queuedAt: at,
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      expiredAt: null,
      cancelledAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.messages.set(message.id, message);
    this.usages.set(command.organizationId, {
      ...usage,
      messagesUsed: usage.messagesUsed + 1,
      messagesRemaining: Math.max(usage.messageLimit - usage.messagesUsed - 1, 0),
    });
    if (device.provider !== "android_agent") {
      this.outboxJobs.push({
        id: randomUUID(),
        kind: "message.dispatch",
        aggregateId: message.id,
        payload: { messageId: message.id, executionMode: message.executionMode },
        attempts: 0,
      });
    }
    return { kind: "created", message: copyMessage(message) };
  }

  async getMessage(organizationId: string, messageId: string): Promise<MessageRecord | null> {
    const message = this.messages.get(messageId);
    return message?.organizationId === organizationId ? copyMessage(message) : null;
  }

  async getUsage(organizationId: string, _at: Date): Promise<UsageRecord | null> {
    const usage = this.usages.get(organizationId);
    return usage ? copyUsage(usage) : null;
  }

  private async withRecipientLock<T>(
    organizationId: string,
    phone: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${organizationId}:${phone}`;
    const previous = this.recipientLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.recipientLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.recipientLocks.get(key) === tail) this.recipientLocks.delete(key);
    }
  }

  async addOptOut(input: {
    organizationId: string;
    apiKeyId: string;
    phone: string;
    reason?: string;
    at: Date;
  }): Promise<OptOutResult> {
    return this.withRecipientLock(input.organizationId, input.phone, async () => {
      const key = `${input.organizationId}:${input.phone}`;
      const knownId = this.optedOutRecipients.get(key);
      const id = knownId ?? randomUUID();
      this.optedOutRecipients.set(key, id);
      const cancelledMessageIds: string[] = [];
      for (const [messageId, message] of this.messages) {
        if (
          message.organizationId !== input.organizationId
          || message.to !== input.phone
          || message.status !== "queued"
          || this.processingMessages.has(messageId)
        ) continue;
        cancelledMessageIds.push(messageId);
        this.messages.set(messageId, {
          ...message,
          status: "cancelled",
          failureCode: "recipient_opted_out",
          failureReason: "The recipient opted out before dispatch.",
          cancelledAt: new Date(input.at.getTime()),
          updatedAt: new Date(input.at.getTime()),
        });
      }
      return { id, created: !knownId, cancelledMessageIds };
    });
  }

  async upsertContact(command: UpsertContactCommand): Promise<UpsertContactResult> {
    const existing = [...this.contacts.values()].find((contact) => (
      contact.organizationId === command.organizationId
      && contact.phone === command.phone
      && contact.deletedAt === null
    ));
    if (existing) {
      const updated: ContactRecord = {
        ...existing,
        name: command.name,
        consentReference: command.consentReference ?? null,
        tags: [...command.tags],
        metadata: { ...command.metadata },
        updatedAt: new Date(command.at.getTime()),
      };
      this.contacts.set(updated.id, updated);
      return { kind: "upserted", contact: copyContact(updated), created: false };
    }

    const activeContactCount = [...this.contacts.values()].filter((contact) => (
      contact.organizationId === command.organizationId && contact.deletedAt === null
    )).length;
    if (activeContactCount >= command.maxContacts) {
      return { kind: "limit_exceeded", limit: command.maxContacts };
    }

    const created: ContactRecord = {
      id: randomUUID(),
      organizationId: command.organizationId,
      createdByApiKeyId: command.apiKeyId,
      name: command.name,
      phone: command.phone,
      consentReference: command.consentReference ?? null,
      tags: [...command.tags],
      metadata: { ...command.metadata },
      deletedAt: null,
      createdAt: new Date(command.at.getTime()),
      updatedAt: new Date(command.at.getTime()),
    };
    this.contacts.set(created.id, created);
    return { kind: "upserted", contact: copyContact(created), created: true };
  }

  async listContacts(input: {
    organizationId: string;
    limit: number;
    cursor: ContactCursor | null;
  }): Promise<ContactPage> {
    const contacts = [...this.contacts.values()]
      .filter((contact) => {
        if (contact.organizationId !== input.organizationId || contact.deletedAt !== null) return false;
        if (!input.cursor) return true;
        const timeDifference = contact.createdAt.getTime() - input.cursor.createdAt.getTime();
        return timeDifference < 0 || (timeDifference === 0 && contact.id < input.cursor.id);
      })
      .sort((left, right) => {
        const timeDifference = right.createdAt.getTime() - left.createdAt.getTime();
        if (timeDifference !== 0) return timeDifference;
        return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
      });
    const hasMore = contacts.length > input.limit;
    const page = contacts.slice(0, input.limit).map(copyContact);
    const last = page.at(-1);
    return {
      contacts: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async deleteContact(input: {
    organizationId: string;
    apiKeyId: string;
    contactId: string;
    at: Date;
  }): Promise<boolean> {
    const contact = this.contacts.get(input.contactId);
    if (!contact || contact.organizationId !== input.organizationId || contact.deletedAt !== null) return false;
    this.contacts.delete(contact.id);
    return true;
  }

  async getQueueSummary(organizationId: string, at: Date): Promise<QueueSummaryRecord> {
    const queued = [...this.messages.values()].filter((message) => (
      message.organizationId === organizationId && message.status === "queued"
    ));
    const pending = queued.filter((message) => !this.processingMessages.has(message.id));
    const oldestQueuedAt = queued.reduce<Date | null>((oldest, message) => (
      !oldest || message.queuedAt < oldest ? message.queuedAt : oldest
    ), null);
    return {
      queuedTotal: queued.length,
      ready: pending.filter((message) => message.scheduledAt <= at).length,
      scheduled: pending.filter((message) => message.scheduledAt > at).length,
      processing: queued.filter((message) => this.processingMessages.has(message.id)).length,
      oldestQueuedAt: oldestQueuedAt ? new Date(oldestQueuedAt.getTime()) : null,
    };
  }

  async claimOutboxJobs(limit: number, _lockId: string, now: Date): Promise<OutboxJob[]> {
    for (const [id, message] of this.messages) {
      if (message.status !== "queued" || this.processingMessages.has(id) || message.expiresAt > now) continue;
      this.messages.set(id, {
        ...message,
        status: "expired",
        failureCode: "message_expired",
        failureReason: "The message expired before dispatch.",
        expiredAt: new Date(now),
        updatedAt: new Date(now),
      });
    }
    return this.outboxJobs.slice(0, limit).map((job) => ({ ...job, payload: { ...job.payload } }));
  }

  async markOutboxPublished(outboxId: string, _lockId: string, _at: Date): Promise<void> {
    const index = this.outboxJobs.findIndex((job) => job.id === outboxId);
    if (index >= 0) this.outboxJobs.splice(index, 1);
  }

  async releaseOutboxJob(
    _outboxId: string,
    _lockId: string,
    _availableAt: Date,
    _error: string,
  ): Promise<void> {}

  async claimMessageForDispatch(input: {
    messageId: string;
    dispatchMinIntervalMs: number;
    at: Date;
  }): Promise<WorkerDispatchClaimResult> {
    const message = this.messages.get(input.messageId);
    if (
      !message
      || message.status !== "queued"
      || message.scheduledAt > input.at
      || this.processingMessages.has(input.messageId)
    ) return { kind: "terminal" };

    if (message.expiresAt <= input.at) {
      this.messages.set(message.id, {
        ...message,
        status: "expired",
        failureCode: "message_expired",
        failureReason: "The message expired before dispatch.",
        expiredAt: new Date(input.at.getTime()),
        updatedAt: new Date(input.at.getTime()),
      });
      return { kind: "terminal" };
    }

    if (this.optedOutRecipients.has(`${message.organizationId}:${message.to}`)) {
      this.messages.set(message.id, {
        ...message,
        status: "cancelled",
        failureCode: "recipient_opted_out",
        failureReason: "The recipient opted out before dispatch.",
        cancelledAt: new Date(input.at.getTime()),
        updatedAt: new Date(input.at.getTime()),
      });
      return { kind: "terminal" };
    }

    const device = this.devices.get(message.deviceId);
    if (!device || !device.active) {
      this.messages.set(message.id, {
        ...message,
        status: "cancelled",
        failureCode: "device_unavailable",
        failureReason: "Dispatch was cancelled because the organization or device is unavailable.",
        cancelledAt: new Date(input.at.getTime()),
        updatedAt: new Date(input.at.getTime()),
      });
      return { kind: "terminal" };
    }
    if (device.provider === "android_agent") return { kind: "terminal" };
    if (message.executionMode !== this.executionMode) {
      this.messages.set(message.id, {
        ...message,
        status: "cancelled",
        failureCode: "execution_mode_mismatch",
        failureReason: "Dispatch was cancelled because the message execution mode does not match this worker.",
        cancelledAt: new Date(input.at),
        updatedAt: new Date(input.at),
      });
      return { kind: "terminal" };
    }
    const usage = this.usages.get(message.organizationId);
    if (!usage || !["active", "trialing"].includes(usage.subscriptionStatus)) {
      this.messages.set(message.id, {
        ...message,
        status: "cancelled",
        failureCode: "subscription_inactive",
        failureReason: "Dispatch was cancelled because the subscription is inactive.",
        cancelledAt: new Date(input.at),
        updatedAt: new Date(input.at),
      });
      return { kind: "terminal" };
    }
    const slot = this.reserveDispatchSlot({
      organizationId: message.organizationId,
      deviceId: message.deviceId,
      messageId: message.id,
      perMinuteRateLimit: usage.perMinuteRateLimit,
      dispatchMinIntervalMs: input.dispatchMinIntervalMs,
      at: input.at,
    });
    if (slot.kind !== "reserved") return slot.kind === "unavailable" ? { kind: "terminal" } : slot;
    this.processingMessages.add(input.messageId);
    if (!message.to) throw new Error("A dispatchable message is missing its retained recipient.");
    return {
      kind: "claimed",
      message: {
        ...copyMessage(message),
        to: message.to,
        device: {
          provider: device.provider,
          senderNumber: device.senderNumber,
          encryptedConfig: device.encryptedConfig,
        },
      },
    };
  }

  async completeMessageDispatch(input: {
    messageId: string;
    status: "sent" | "delivered" | "failed" | "cancelled";
    providerMessageId?: string;
    providerStatus?: string;
    failureCode?: string;
    failureReason?: string;
    at: Date;
  }): Promise<MessageRecord | null> {
    const message = this.messages.get(input.messageId);
    if (!message || message.status !== "queued" || !this.processingMessages.has(input.messageId)) return null;
    const updated: MessageRecord = {
      ...message,
      status: input.status,
      providerMessageId: input.providerMessageId ?? message.providerMessageId,
      failureCode: input.failureCode ?? null,
      failureReason: input.failureReason ?? null,
      sentAt: input.status === "sent" || input.status === "delivered" ? new Date(input.at.getTime()) : message.sentAt,
      deliveredAt: input.status === "delivered" ? new Date(input.at.getTime()) : message.deliveredAt,
      failedAt: input.status === "failed" ? new Date(input.at.getTime()) : message.failedAt,
      expiredAt: message.expiredAt,
      cancelledAt: input.status === "cancelled" ? new Date(input.at.getTime()) : message.cancelledAt,
      updatedAt: new Date(input.at.getTime()),
    };
    this.messages.set(updated.id, updated);
    this.processingMessages.delete(updated.id);
    return copyMessage(updated);
  }

  async claimMessagesForStatusCheck(limit: number, at: Date): Promise<StatusCheckMessage[]> {
    return [...this.messages.values()]
      .filter((message) => message.status === "sent")
      .filter((message) => message.executionMode === this.executionMode)
      .filter((message) => {
        const provider = this.devices.get(message.deviceId)?.provider;
        return provider === "android_agent" ? message.expiresAt <= at : Boolean(message.providerMessageId);
      })
      .slice(0, limit)
      .map((message) => {
        const device = this.devices.get(message.deviceId);
        return {
          id: message.id,
          organizationId: message.organizationId,
          status: "sent" as const,
          providerMessageId: message.providerMessageId,
          expiresAt: new Date(message.expiresAt),
          device: {
            provider: device?.provider === "android_agent"
              ? "android_agent"
              : device?.provider === "httpsms" ? "httpsms" : "mock",
            encryptedConfig: device?.encryptedConfig ?? null,
          },
        };
      });
  }

  async completeMessageStatusCheck(input: {
    messageId: string;
    status: "sent" | "delivered" | "failed" | "expired";
    providerStatus: string;
    failureReason?: string;
    at: Date;
  }): Promise<MessageRecord | null> {
    const message = this.messages.get(input.messageId);
    if (!message || message.status !== "sent") return null;
    const updated: MessageRecord = {
      ...message,
      status: input.status,
      failureCode: input.status === "failed" ? "provider_failed" : input.status === "expired" ? "provider_expired" : message.failureCode,
      failureReason: input.status === "failed" || input.status === "expired" ? input.failureReason ?? null : message.failureReason,
      deliveredAt: input.status === "delivered" ? new Date(input.at) : message.deliveredAt,
      failedAt: input.status === "failed" ? new Date(input.at) : message.failedAt,
      expiredAt: input.status === "expired" ? new Date(input.at) : message.expiredAt,
      updatedAt: new Date(input.at),
    };
    this.messages.set(updated.id, updated);
    return copyMessage(updated);
  }

  async getWebhookDelivery(deliveryId: string): Promise<WebhookDeliveryRecord | null> {
    return this.webhookDeliveries.get(deliveryId) ?? null;
  }

  async completeWebhookDelivery(_input: {
    deliveryId: string;
    lockId: string;
    succeeded: boolean;
    httpStatus?: number;
    error?: string;
    at: Date;
  }): Promise<void> {}
}
