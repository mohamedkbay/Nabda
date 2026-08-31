import type {
  ApiKeyRecord,
  ContactCursor,
  ContactPage,
  ContactRecord,
  CreateMessageCommand,
  CreateMessageResult,
  DeviceAgentClaimResult,
  DeviceAgentBeginResult,
  DeviceAgentCredentialRecord,
  DeviceAgentEventResult,
  DeviceAgentEventStatus,
  DeviceAgentPrincipal,
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
} from "../domain/types.js";

export interface Repository {
  health(): Promise<void>;
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  touchApiKey(apiKeyId: string, at: Date): Promise<void>;
  findDeviceAgentCredentialByPrefix(prefix: string): Promise<DeviceAgentCredentialRecord | null>;
  touchDeviceAgentCredential(credentialId: string, at: Date): Promise<void>;
  heartbeatDeviceAgent(input: {
    principal: DeviceAgentPrincipal;
    telemetry: Record<string, unknown>;
    at: Date;
  }): Promise<boolean>;
  claimDeviceAgentMessage(input: {
    principal: DeviceAgentPrincipal;
    leaseTokenHash: string;
    leaseExpiresAt: Date;
    at: Date;
  }): Promise<DeviceAgentClaimResult>;
  beginDeviceAgentMessage(input: {
    principal: DeviceAgentPrincipal;
    messageId: string;
    attemptId: string;
    leaseTokenHash: string;
    attemptLeaseExpiresAt: Date;
    dispatchMinIntervalMs: number;
    at: Date;
  }): Promise<DeviceAgentBeginResult>;
  recordDeviceAgentEvent(input: {
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
  }): Promise<DeviceAgentEventResult>;
  findIdempotentMessage(organizationId: string, idempotencyKey: string): Promise<MessageRecord | null>;
  createMessage(command: CreateMessageCommand): Promise<CreateMessageResult>;
  getMessage(organizationId: string, messageId: string): Promise<MessageRecord | null>;
  getUsage(organizationId: string, at: Date): Promise<UsageRecord | null>;
  addOptOut(input: {
    organizationId: string;
    apiKeyId: string;
    phone: string;
    reason?: string;
    at: Date;
  }): Promise<OptOutResult>;

  upsertContact(command: UpsertContactCommand): Promise<UpsertContactResult>;
  listContacts(input: {
    organizationId: string;
    limit: number;
    cursor: ContactCursor | null;
  }): Promise<ContactPage>;
  deleteContact(input: {
    organizationId: string;
    apiKeyId: string;
    contactId: string;
    at: Date;
  }): Promise<boolean>;
  getQueueSummary(organizationId: string, at: Date): Promise<QueueSummaryRecord>;

  claimOutboxJobs(limit: number, lockId: string, now: Date): Promise<OutboxJob[]>;
  markOutboxPublished(outboxId: string, lockId: string, at: Date): Promise<void>;
  releaseOutboxJob(outboxId: string, lockId: string, availableAt: Date, error: string): Promise<void>;

  claimMessageForDispatch(input: {
    messageId: string;
    dispatchMinIntervalMs: number;
    at: Date;
  }): Promise<WorkerDispatchClaimResult>;
  completeMessageDispatch(input: {
    messageId: string;
    status: "sent" | "delivered" | "failed" | "cancelled";
    providerMessageId?: string;
    providerStatus?: string;
    failureCode?: string;
    failureReason?: string;
    at: Date;
  }): Promise<MessageRecord | null>;
  claimMessagesForStatusCheck(limit: number, at: Date): Promise<StatusCheckMessage[]>;
  completeMessageStatusCheck(input: {
    messageId: string;
    status: "sent" | "delivered" | "failed" | "expired";
    providerStatus: string;
    failureReason?: string;
    at: Date;
  }): Promise<MessageRecord | null>;

  getWebhookDelivery(deliveryId: string): Promise<WebhookDeliveryRecord | null>;
  completeWebhookDelivery(input: {
    deliveryId: string;
    lockId: string;
    succeeded: boolean;
    httpStatus?: number;
    error?: string;
    at: Date;
  }): Promise<void>;
}
