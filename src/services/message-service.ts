import { AppError } from "../domain/errors.js";
import type {
  ApiPrincipal,
  CreateMessageCommand,
  MessageExecutionMode,
  MessagePurpose,
  MessageRecord,
} from "../domain/types.js";
import { keyedRequestDigest } from "../lib/crypto.js";
import type { RateLimitResult, RateLimiter } from "../rate-limit/rate-limiter.js";
import type { Repository } from "../repositories/repository.js";

export interface SubmitMessageInput {
  deviceId?: string;
  to: string;
  content: string;
  purpose: MessagePurpose;
  clientReference?: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  scheduledAt: Date;
  expiresAt: Date;
  consentCapturedAt: Date;
  consentReference: string;
  fingerprintSource: Record<string, unknown>;
}

export interface SubmitMessageOutput {
  message: MessageRecord;
  replayed: boolean;
  rateLimit?: RateLimitResult;
}

export class MessageService {
  constructor(
    private readonly repository: Repository,
    private readonly rateLimiter: RateLimiter,
    private readonly requestHashSecret: string,
    private readonly executionMode: MessageExecutionMode,
  ) {}

  async submit(principal: ApiPrincipal, input: SubmitMessageInput): Promise<SubmitMessageOutput> {
    const fingerprint = keyedRequestDigest(
      { ...input.fingerprintSource, execution_mode: this.executionMode },
      this.requestHashSecret,
      "message-idempotency",
    );

    const existing = await this.repository.findIdempotentMessage(principal.organizationId, input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== fingerprint) {
        throw new AppError(409, "idempotency_conflict", "The Idempotency-Key was already used with a different request.");
      }
      return { message: existing, replayed: true };
    }

    const usage = await this.repository.getUsage(principal.organizationId, input.consentCapturedAt);
    if (!usage || !["active", "trialing"].includes(usage.subscriptionStatus)) {
      throw new AppError(403, "subscription_inactive", "An active subscription is required.");
    }
    if (usage.messagesUsed >= usage.messageLimit) {
      throw new AppError(429, "subscription_quota_exceeded", "The subscription message quota was reached.", {
        limit: usage.messageLimit,
        used: usage.messagesUsed,
        resetsAt: usage.periodEnd.toISOString(),
      }, usage.periodEnd);
    }

    const deduplicationKey = keyedRequestDigest(
      { idempotencyKey: input.idempotencyKey, fingerprint },
      this.requestHashSecret,
      "message-rate-deduplication",
    );
    let rateLimit: RateLimitResult;
    try {
      rateLimit = await this.rateLimiter.consume(
        `${principal.organizationId}:messages`,
        usage.perMinuteRateLimit,
        input.consentCapturedAt,
        deduplicationKey,
      );
    } catch {
      throw new AppError(503, "rate_limit_unavailable", "The abuse-prevention service is temporarily unavailable.");
    }
    if (!rateLimit.allowed) {
      throw new AppError(429, "rate_limited", "The per-minute message limit was exceeded.", {
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
        resetAt: rateLimit.resetAt.toISOString(),
      }, rateLimit.resetAt);
    }

    const recipientLimit = Math.max(Math.min(usage.perMinuteRateLimit, 3), 1);
    let recipientRateLimit: RateLimitResult;
    try {
      recipientRateLimit = await this.rateLimiter.consume(
        `${principal.organizationId}:recipient:${keyedRequestDigest(input.to, this.requestHashSecret, "recipient-rate")}`,
        recipientLimit,
        input.consentCapturedAt,
        deduplicationKey,
      );
    } catch {
      throw new AppError(503, "rate_limit_unavailable", "The abuse-prevention service is temporarily unavailable.");
    }
    if (!recipientRateLimit.allowed) {
      throw new AppError(429, "recipient_rate_limited", "The per-recipient message limit was exceeded.", {
        limit: recipientRateLimit.limit,
        remaining: recipientRateLimit.remaining,
        resetAt: recipientRateLimit.resetAt.toISOString(),
      }, recipientRateLimit.resetAt);
    }

    const command: CreateMessageCommand = {
      organizationId: principal.organizationId,
      apiKeyId: principal.apiKeyId,
      to: input.to,
      content: input.content,
      purpose: input.purpose,
      executionMode: this.executionMode,
      idempotencyKey: input.idempotencyKey,
      requestHash: fingerprint,
      metadata: input.metadata,
      scheduledAt: input.scheduledAt,
      expiresAt: input.expiresAt,
      consentCapturedAt: input.consentCapturedAt,
      consentReference: input.consentReference,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.clientReference ? { clientReference: input.clientReference } : {}),
    };
    const result = await this.repository.createMessage(command);
    switch (result.kind) {
      case "created":
        return { message: result.message, replayed: false, rateLimit };
      case "replayed":
        return { message: result.message, replayed: true, rateLimit };
      case "idempotency_conflict":
        throw new AppError(409, "idempotency_conflict", "The Idempotency-Key was already used with a different request.");
      case "opted_out":
        throw new AppError(422, "recipient_opted_out", "The recipient is on this organization's blocklist.");
      case "subscription_inactive":
        throw new AppError(403, "subscription_inactive", "An active subscription is required.");
      case "quota_exceeded":
        throw new AppError(429, "subscription_quota_exceeded", "The subscription message quota was reached.", {
          limit: result.limit,
          used: result.used,
          resetsAt: result.resetsAt.toISOString(),
        }, result.resetsAt);
      case "device_unavailable":
        throw new AppError(422, "device_unavailable", "No active sending device is available for this organization.");
    }
  }
}
