import { randomUUID } from "node:crypto";
import type {
  ProviderAdapter,
  ProviderSendInput,
  ProviderSendResult,
  ProviderStatusInput,
  ProviderStatusResult,
} from "./provider.js";

export interface MockProviderOptions {
  resultStatus?: "sent" | "delivered";
  send?: (input: ProviderSendInput) => Promise<ProviderSendResult>;
}

export class MockProvider implements ProviderAdapter {
  readonly name = "mock" as const;

  constructor(private readonly options: MockProviderOptions = {}) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (this.options.send) return this.options.send(input);
    return {
      providerMessageId: `mock_${randomUUID()}`,
      status: this.options.resultStatus ?? "sent",
      rawStatus: "mock_accepted",
    };
  }

  async getStatus(_input: ProviderStatusInput): Promise<ProviderStatusResult> {
    const status = this.options.resultStatus ?? "sent";
    return { status, rawStatus: status === "delivered" ? "mock_delivered" : "mock_accepted" };
  }
}
