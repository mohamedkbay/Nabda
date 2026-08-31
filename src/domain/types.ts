export const MESSAGE_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "failed",
  "expired",
  "cancelled",
] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export type MessagePurpose = "transactional" | "authentication" | "service";

export type MessageExecutionMode = "simulation" | "live";

export interface ApiPrincipal {
  apiKeyId: string;
  organizationId: string;
  organizationStatus: "active" | "suspended";
  scopes: string[];
}

export interface ApiKeyRecord extends ApiPrincipal {
  keyHash: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export interface DeviceAgentPrincipal {
  credentialId: string;
  organizationId: string;
  deviceId: string;
  organizationStatus: "active" | "suspended" | "closed";
  deviceStatus: "pending" | "active" | "offline" | "disabled";
  mode: MessageExecutionMode;
}

export interface DeviceAgentCredentialRecord extends DeviceAgentPrincipal {
  tokenHash: string;
  revokedAt: Date | null;
}

export interface DeviceAgentClaim {
  message: MessageRecord;
  leaseExpiresAt: Date;
}

export type DeviceAgentClaimResult =
  | { kind: "claimed"; claim: DeviceAgentClaim }
  | { kind: "empty" }
  | { kind: "device_unavailable" };

export type DeviceAgentBeginResult =
  | { kind: "authorized"; message: MessageRecord; leaseExpiresAt: Date; duplicate: boolean }
  | { kind: "not_found" }
  | { kind: "invalid_lease" }
  | { kind: "lease_expired" }
  | { kind: "invalid_attempt" }
  | { kind: "not_dispatchable"; message: MessageRecord }
  | { kind: "rate_limited"; retryAt: Date };

export type DeviceAgentEventStatus = "sent" | "delivered" | "failed" | "cancelled";

export type DeviceAgentEventResult =
  | { kind: "accepted"; message: MessageRecord; duplicate: boolean }
  | { kind: "not_found" }
  | { kind: "event_conflict" }
  | { kind: "invalid_lease" }
  | { kind: "lease_expired" }
  | { kind: "invalid_transition" };

export type DispatchSlotResult =
  | { kind: "reserved"; duplicate: boolean }
  | { kind: "rate_limited"; retryAt: Date }
  | { kind: "unavailable" };

export type WorkerDispatchClaimResult =
  | { kind: "claimed"; message: DispatchMessage }
  | { kind: "rate_limited"; retryAt: Date }
  | { kind: "terminal" };

export interface MessageRecord {
  id: string;
  organizationId: string;
  apiKeyId: string;
  deviceId: string;
  to: string | null;
  content: string;
  purpose: MessagePurpose;
  status: MessageStatus;
  executionMode: MessageExecutionMode;
  clientReference: string | null;
  idempotencyKey: string;
  requestHash: string;
  providerMessageId: string | null;
  failureCode: string | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  scheduledAt: Date;
  expiresAt: Date;
  queuedAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  expiredAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMessageCommand {
  organizationId: string;
  apiKeyId: string;
  deviceId?: string;
  to: string;
  content: string;
  purpose: MessagePurpose;
  executionMode: MessageExecutionMode;
  clientReference?: string;
  idempotencyKey: string;
  requestHash: string;
  metadata: Record<string, unknown>;
  scheduledAt: Date;
  expiresAt: Date;
  consentCapturedAt: Date;
  consentReference?: string;
}

export type CreateMessageResult =
  | { kind: "created"; message: MessageRecord }
  | { kind: "replayed"; message: MessageRecord }
  | { kind: "idempotency_conflict" }
  | { kind: "opted_out" }
  | { kind: "subscription_inactive" }
  | { kind: "quota_exceeded"; limit: number; used: number; resetsAt: Date }
  | { kind: "device_unavailable" };

export interface UsageRecord {
  planCode: string;
  subscriptionStatus: string;
  periodStart: Date;
  periodEnd: Date;
  messagesUsed: number;
  messageLimit: number;
  messagesRemaining: number;
  perMinuteRateLimit: number;
  maxContacts: number;
}

export interface ContactRecord {
  id: string;
  organizationId: string;
  createdByApiKeyId: string;
  name: string;
  phone: string;
  consentReference: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertContactCommand {
  organizationId: string;
  apiKeyId: string;
  name: string;
  phone: string;
  consentReference?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  maxContacts: number;
  at: Date;
}

export type UpsertContactResult =
  | { kind: "upserted"; contact: ContactRecord; created: boolean }
  | { kind: "limit_exceeded"; limit: number };

export interface ContactCursor {
  createdAt: Date;
  id: string;
}

export interface ContactPage {
  contacts: ContactRecord[];
  nextCursor: ContactCursor | null;
}

export interface QueueSummaryRecord {
  queuedTotal: number;
  ready: number;
  scheduled: number;
  processing: number;
  oldestQueuedAt: Date | null;
}

export interface DispatchMessage extends MessageRecord {
  to: string;
  device: {
    provider: "mock" | "httpsms";
    senderNumber: string | null;
    encryptedConfig: string | null;
  };
}

export interface StatusCheckMessage {
  id: string;
  organizationId: string;
  status: "sent";
  providerMessageId: string | null;
  expiresAt: Date;
  device: {
    provider: "mock" | "httpsms" | "android_agent";
    encryptedConfig: string | null;
  };
}

export interface OptOutResult {
  id: string;
  created: boolean;
  cancelledMessageIds: string[];
}

export interface MessageEventRecord {
  id: string;
  organizationId: string;
  messageId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface OutboxJob {
  id: string;
  kind: "message.dispatch" | "webhook.deliver";
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface WebhookDeliveryRecord {
  id: string;
  lockId: string;
  organizationId: string;
  webhookId: string;
  url: string;
  encryptedSecret: string;
  payload: Record<string, unknown>;
  event: MessageEventRecord;
  attemptCount: number;
}
