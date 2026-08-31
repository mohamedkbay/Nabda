import type { DesktopProvider } from "./provider.js";
import { DesktopRepository } from "./repository.js";
import type { DesktopMessageRecord } from "./types.js";

export class DesktopMessagingService {
  constructor(private readonly repository: DesktopRepository) {}

  queueMessage(input: {
    contactId?: string;
    deviceId?: string;
    to: string;
    content: string;
    scheduledAt?: Date;
    now?: Date;
  }): DesktopMessageRecord {
    return this.repository.createMessage(input);
  }
}

export class LocalQueueWorker {
  constructor(
    private readonly repository: DesktopRepository,
    private readonly provider: DesktopProvider,
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
      const result = await this.provider.send(message);
      return this.repository.completeQueueJob({
        jobId: job.id,
        messageId: message.id,
        status: result.status,
        providerMessageId: result.providerMessageId,
        payload: { provider: this.provider.kind },
        now,
      });
    } catch (error) {
      return this.repository.completeQueueJob({
        jobId: job.id,
        messageId: message.id,
        status: "failed",
        failureReason: error instanceof Error ? error.message : "Provider failed",
        now,
      });
    }
  }
}

export async function testProviderConnection(provider: DesktopProvider, secret: string | null): Promise<{
  ok: boolean;
  detail: string;
}> {
  return provider.testConnection(secret);
}
