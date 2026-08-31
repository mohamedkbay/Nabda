import { HttpSmsProvider, HttpSmsProviderError } from "./provider.js";
import { DesktopRepository } from "./repository.js";
import type { SecretStore } from "./secret-store.js";
import type { DesktopMessageRecord } from "./types.js";

export interface HttpSmsRuntimeSettings {
  from: string;
  encrypted?: boolean;
}

export class DesktopMessagingService {
  constructor(private readonly repository: DesktopRepository) {}

  queueMessage(input: {
    contactId?: string;
    campaignId?: string;
    to: string;
    content: string;
    scheduledAt?: Date;
    now?: Date;
  }): DesktopMessageRecord {
    return this.repository.createMessage(input);
  }

  cancelQueuedMessage(id: string, now = new Date()): DesktopMessageRecord | null {
    return this.repository.cancelQueuedMessage(id, now);
  }
}

export class LocalQueueWorker {
  constructor(
    private readonly repository: DesktopRepository,
    private readonly provider: HttpSmsProvider,
    private readonly secretStore: SecretStore,
    private readonly getSettings: () => Promise<HttpSmsRuntimeSettings>,
  ) {}

  async runOnce(now: Date = new Date()): Promise<DesktopMessageRecord | null> {
    const job = this.repository.claimNextQueueJob(now);
    if (!job) return null;
    const message = this.repository.getMessage(job.messageId);
    if (!message) throw new Error("Queued message does not exist");
    if (this.repository.isOptedOut(message.to)) {
      return this.repository.completeQueueJob({
        jobId: job.id,
        messageId: message.id,
        status: "cancelled",
        failureReason: "Recipient opted out before dispatch",
        now,
      });
    }
    try {
      const apiKey = await this.secretStore.get("provider.api-key");
      if (!apiKey) throw new HttpSmsProviderError("not_configured", "The httpSMS API key is not configured.", false);
      const settings = await this.getSettings();
      const result = await this.provider.send({
        apiKey,
        from: settings.from,
        to: message.to,
        content: message.content,
        requestId: message.id,
        sendAt: new Date(message.scheduledAt),
        ...(settings.encrypted === undefined ? {} : { encrypted: settings.encrypted }),
        now,
      });
      return this.repository.completeQueueJob({
        jobId: job.id,
        messageId: message.id,
        status: result.status,
        providerMessageId: result.providerMessageId,
        payload: { provider: "httpsms", providerStatus: result.rawStatus },
        now,
      });
    } catch (error) {
      const manualReview = error instanceof HttpSmsProviderError && error.manualReview;
      const reason = manualReview
        ? `MANUAL_REVIEW_REQUIRED: ${error.message}`
        : error instanceof Error ? error.message : "httpSMS failed";
      return this.repository.completeQueueJob({
        jobId: job.id,
        messageId: message.id,
        status: "failed",
        failureReason: reason,
        payload: { manualReview },
        now,
      });
    }
  }
}

export async function testProviderConnection(
  provider: HttpSmsProvider,
  secretStore: SecretStore,
): Promise<{ ok: true; detail: string }> {
  const apiKey = await secretStore.get("provider.api-key");
  if (!apiKey) throw new HttpSmsProviderError("not_configured", "The httpSMS API key is not configured.", false);
  return provider.testConnection(apiKey);
}

export class HttpSmsStatusService {
  constructor(
    private readonly repository: DesktopRepository,
    private readonly provider: HttpSmsProvider,
    private readonly secretStore: SecretStore,
  ) {}

  async refresh(messageId: string, now = new Date()): Promise<DesktopMessageRecord | null> {
    const message = this.repository.getMessage(messageId);
    if (!message?.providerMessageId) return null;
    const apiKey = await this.secretStore.get("provider.api-key");
    if (!apiKey) throw new HttpSmsProviderError("not_configured", "The httpSMS API key is not configured.", false);
    const status = await this.provider.getStatus(apiKey, message.providerMessageId);
    return this.repository.recordProviderStatus({
      messageId,
      status: status.status,
      ...(status.failureReason === undefined ? {} : { failureReason: status.failureReason }),
      payload: { provider: "httpsms", providerStatus: status.rawStatus },
      now,
    });
  }
}
