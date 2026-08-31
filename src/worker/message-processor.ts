import { ProviderError } from "../domain/errors.js";
import type { DispatchMessage } from "../domain/types.js";
import { SecretBox } from "../lib/crypto.js";
import { measureSmsContent } from "../lib/sms-content.js";
import type { ProviderSendResult } from "../providers/provider.js";
import type { ProviderRegistry } from "../providers/provider-factory.js";
import type { Repository } from "../repositories/repository.js";

export type MessageProcessResult =
  | { kind: "complete" }
  | { kind: "rate_limited"; retryAt: Date };

export class MessageProcessor {
  constructor(
    private readonly repository: Repository,
    private readonly providers: ProviderRegistry,
    private readonly secretBox: SecretBox,
    private readonly dispatchMinIntervalMs = 3_000,
  ) {}

  async process(messageId: string): Promise<MessageProcessResult> {
    const claim = await this.repository.claimMessageForDispatch({
      messageId,
      dispatchMinIntervalMs: this.dispatchMinIntervalMs,
      at: new Date(),
    });
    if (claim.kind === "terminal") return { kind: "complete" };
    if (claim.kind === "rate_limited") return claim;
    const message: DispatchMessage = claim.message;
    // Claim atomically orders against opt-out, reserves the shared Postgres
    // dispatch fence and commits processing before any provider I/O. Therefore
    // this network call holds no database connection or advisory lock.

    const contentMeasure = measureSmsContent(message.content);
    if (!contentMeasure.fitsSingleSegment) {
      await this.repository.completeMessageDispatch({
        messageId: message.id,
        status: "failed",
        failureCode: "message_exceeds_single_segment",
        failureReason: "Dispatch blocked because the message would require multiple SMS segments.",
        at: new Date(),
      });
      return { kind: "complete" };
    }

    let result: ProviderSendResult;
    try {
      const provider = this.providers.get(message.device.provider);
      let credential: string | null = null;
      if (message.device.provider === "httpsms") {
        if (!message.device.encryptedConfig) throw new ProviderError("provider_not_configured", "The device provider is not configured.");
        const config = JSON.parse(this.secretBox.decrypt(message.device.encryptedConfig)) as { apiKey?: unknown };
        if (typeof config.apiKey !== "string" || !config.apiKey) {
          throw new ProviderError("provider_not_configured", "The device provider is not configured.");
        }
        credential = config.apiKey;
      }
      result = await provider.send({
        messageId: message.id,
        from: message.device.senderNumber ?? "",
        to: message.to,
        content: message.content,
        scheduledAt: message.scheduledAt,
        credential,
      });
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error
        : new ProviderError("provider_error", "The provider could not process the message.");
      await this.repository.completeMessageDispatch({
        messageId: message.id,
        status: "failed",
        failureCode: providerError.outcomeUnknown ? "provider_outcome_unknown" : providerError.code,
        failureReason: providerError.message,
        at: new Date(),
      });
      // Message jobs deliberately have one attempt. Retrying an uncertain provider call can duplicate an SMS.
      return { kind: "complete" };
    }
    // Persisting a known provider result is intentionally outside the provider-error catch. A database
    // failure here must never turn an accepted provider request into a misleading provider failure.
    await this.repository.completeMessageDispatch({
      messageId: message.id,
      status: result.status,
      providerMessageId: result.providerMessageId,
      ...(result.rawStatus ? { providerStatus: result.rawStatus } : {}),
      at: new Date(),
    });
    return { kind: "complete" };
  }
}
