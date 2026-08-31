import { ProviderError } from "../domain/errors.js";
import type {
  ProviderAdapter,
  ProviderSendInput,
  ProviderSendResult,
  ProviderStatusInput,
  ProviderStatusResult,
} from "./provider.js";

interface HttpSmsProviderOptions {
  apiBase: string;
  timeoutMs: number;
  liveSmsEnabled: boolean;
  environment: string;
  fetchImplementation?: typeof fetch;
}

interface HttpSmsResponse {
  id?: unknown;
  status?: unknown;
  message?: unknown;
  error?: unknown;
  failure_reason?: unknown;
  data?: unknown;
}

function mapProviderStatus(status: unknown): ProviderStatusResult["status"] {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "delivered") return "delivered";
  if (normalized === "expired") return "expired";
  if (["failed", "cancelled", "canceled", "rejected"].includes(normalized)) return "failed";
  return "sent";
}

function assertOfficialApiBase(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("provider_base_url_invalid", "The provider API base URL is invalid.");
  }
  if (url.protocol !== "https:" || url.hostname !== "api.httpsms.com") {
    throw new ProviderError(
      "provider_base_url_invalid",
      "The provider API base URL must use the official HTTPS endpoint.",
    );
  }
}

export class HttpSmsProvider implements ProviderAdapter {
  readonly name = "httpsms" as const;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HttpSmsProviderOptions) {
    if (!options.liveSmsEnabled || options.environment !== "production") {
      throw new ProviderError("live_sms_disabled", "Live SMS is disabled by the server safety policy.");
    }
    assertOfficialApiBase(options.apiBase);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (!input.credential) throw new ProviderError("provider_not_configured", "The device provider is not configured.");
    if (!input.from) throw new ProviderError("sender_not_configured", "The device sender number is not configured.");

    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.options.apiBase.replace(/\/$/, "")}/messages/send`, {
        method: "POST",
        headers: {
          "x-api-key": input.credential,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: input.from,
          to: input.to,
          content: input.content,
          request_id: input.messageId,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new ProviderError(
        "provider_outcome_unknown",
        "The provider connection ended before the delivery outcome was known.",
        true,
      );
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      throw new ProviderError(
        "provider_outcome_unknown",
        "The provider response ended before the delivery outcome was known.",
        true,
      );
    }
    let parsed: HttpSmsResponse = {};
    try {
      parsed = JSON.parse(raw) as HttpSmsResponse;
    } catch {
      // Provider errors are deliberately sanitized below.
    }
    const payload = parsed.data && typeof parsed.data === "object" ? parsed.data as HttpSmsResponse : parsed;
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 409) {
        throw new ProviderError(
          "provider_outcome_unknown",
          "The provider returned a server error after receiving the request; the delivery outcome is unknown.",
          true,
        );
      }
      throw new ProviderError("provider_rejected", `Provider rejected the request (${response.status}).`);
    }
    if (typeof payload.id !== "string" || !payload.id) {
      throw new ProviderError(
        "provider_outcome_unknown",
        "The provider accepted the request without a trackable identifier.",
        true,
      );
    }
    const status = mapProviderStatus(payload.status);
    if (status === "failed" || status === "expired") {
      throw new ProviderError("provider_failed", "The provider returned a terminal failure status.");
    }
    return {
      providerMessageId: payload.id,
      status,
      rawStatus: typeof payload.status === "string" ? payload.status : "accepted",
    };
  }

  async getStatus(input: ProviderStatusInput): Promise<ProviderStatusResult> {
    if (!input.credential) throw new ProviderError("provider_not_configured", "The device provider is not configured.");
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.options.apiBase.replace(/\/$/, "")}/messages/${encodeURIComponent(input.providerMessageId)}`,
        {
          headers: { "x-api-key": input.credential, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch {
      throw new ProviderError("provider_status_unavailable", "The provider status is temporarily unavailable.");
    }
    const raw = await response.text();
    let parsed: HttpSmsResponse = {};
    try {
      parsed = JSON.parse(raw) as HttpSmsResponse;
    } catch {
      // A malformed status response is treated as temporary and never changes the public status.
    }
    if (!response.ok) throw new ProviderError("provider_status_unavailable", `Provider status check failed (${response.status}).`);
    const payload = parsed.data && typeof parsed.data === "object" ? parsed.data as HttpSmsResponse : parsed;
    const rawStatus = typeof payload.status === "string" ? payload.status : "unknown";
    return {
      status: mapProviderStatus(rawStatus),
      rawStatus,
      ...(typeof payload.failure_reason === "string" ? { failureReason: payload.failure_reason.slice(0, 300) } : {}),
    };
  }
}
