import { SecretBox } from "../lib/crypto.js";
import type { ProviderRegistry } from "../providers/provider-factory.js";
import type { Repository } from "../repositories/repository.js";

export class StatusReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: Repository,
    private readonly providers: ProviderRegistry,
    private readonly secretBox: SecretBox,
    private readonly intervalMs: number,
    private readonly batchSize = 50,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.trigger(), this.intervalMs);
    this.timer.unref();
    this.trigger();
  }

  private trigger(): void {
    void this.runOnce().catch(() => {
      process.stderr.write("Provider status reconciliation failed; it will retry.\n");
    });
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const messages = await this.repository.claimMessagesForStatusCheck(this.batchSize, now);
      for (const message of messages) {
        if (message.expiresAt <= now) {
          await this.repository.completeMessageStatusCheck({
            messageId: message.id,
            status: "expired",
            providerStatus: "local_expiry",
            failureReason: "The delivery receipt did not arrive before the message expired.",
            at: now,
          });
          continue;
        }
        if (message.device.provider === "android_agent" || !message.providerMessageId) continue;
        try {
          const provider = this.providers.get(message.device.provider);
          if (!provider.getStatus) continue;
          let credential: string | null = null;
          if (message.device.provider === "httpsms") {
            if (!message.device.encryptedConfig) continue;
            const config = JSON.parse(this.secretBox.decrypt(message.device.encryptedConfig)) as { apiKey?: unknown };
            if (typeof config.apiKey !== "string" || !config.apiKey) continue;
            credential = config.apiKey;
          }
          const status = await provider.getStatus({
            providerMessageId: message.providerMessageId,
            credential,
          });
          await this.repository.completeMessageStatusCheck({
            messageId: message.id,
            status: status.status,
            providerStatus: status.rawStatus,
            ...(status.failureReason ? { failureReason: status.failureReason } : {}),
            at: new Date(),
          });
        } catch {
          // A temporary status-read failure must never downgrade a message.
        }
      }
    } finally {
      this.running = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
