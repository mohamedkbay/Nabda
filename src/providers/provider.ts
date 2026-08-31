import type { MessageStatus } from "../domain/types.js";

export interface ProviderSendInput {
  messageId: string;
  from: string;
  to: string;
  content: string;
  scheduledAt: Date;
  credential: string | null;
}

export interface ProviderSendResult {
  providerMessageId: string;
  status: Extract<MessageStatus, "sent" | "delivered">;
  rawStatus?: string;
}

export interface ProviderStatusInput {
  providerMessageId: string;
  credential: string | null;
}

export interface ProviderStatusResult {
  status: "sent" | "delivered" | "failed" | "expired";
  rawStatus: string;
  failureReason?: string;
}

export interface ProviderAdapter {
  readonly name: "mock" | "httpsms";
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
  getStatus?(input: ProviderStatusInput): Promise<ProviderStatusResult>;
}
