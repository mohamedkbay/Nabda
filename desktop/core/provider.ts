import { randomUUID } from "node:crypto";
import type { DesktopMessageRecord } from "./types.js";

export interface DesktopProvider {
  readonly kind: "mock";
  testConnection(secret: string | null): Promise<{ ok: boolean; detail: string }>;
  send(message: DesktopMessageRecord): Promise<{ status: "sent" | "delivered"; providerMessageId: string }>;
}

export class MockDesktopProvider implements DesktopProvider {
  readonly kind = "mock" as const;
  sendCalls = 0;
  connectionTestCalls = 0;

  async testConnection(_secret: string | null): Promise<{ ok: boolean; detail: string }> {
    this.connectionTestCalls += 1;
    return { ok: true, detail: "Mock provider is available. No SMS was sent." };
  }

  async send(_message: DesktopMessageRecord): Promise<{ status: "sent"; providerMessageId: string }> {
    this.sendCalls += 1;
    return { status: "sent", providerMessageId: `mock_${randomUUID()}` };
  }
}
