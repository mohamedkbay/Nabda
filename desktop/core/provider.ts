import { normalizeDesktopPhone } from "./repository.js";

const OFFICIAL_API_BASE = "https://api.httpsms.com/v1";
const MAX_SCHEDULE_MS = 20 * 24 * 60 * 60 * 1000;

export class HttpSmsProviderError extends Error {
  constructor(
    readonly code: "not_configured" | "rejected" | "outcome_unknown" | "status_unavailable",
    message: string,
    readonly manualReview: boolean,
  ) {
    super(message);
    this.name = "HttpSmsProviderError";
  }
}

export interface HttpSmsSendInput {
  apiKey: string;
  from: string;
  to: string;
  content: string;
  requestId: string;
  sendAt?: Date;
  encrypted?: boolean;
  now?: Date;
}

export interface HttpSmsSendResult {
  providerMessageId: string;
  status: "sent" | "delivered";
  rawStatus: string;
}

export interface HttpSmsStatusResult {
  status: "sent" | "delivered" | "failed" | "expired";
  rawStatus: string;
  failureReason?: string;
}

interface ProviderPayload {
  id?: unknown;
  status?: unknown;
  data?: unknown;
  failure_reason?: unknown;
}

function payloadFrom(raw: string): ProviderPayload {
  try {
    const parsed = JSON.parse(raw) as ProviderPayload;
    return parsed.data && typeof parsed.data === "object" ? (parsed.data as ProviderPayload) : parsed;
  } catch {
    return {};
  }
}

function mapStatus(value: unknown): HttpSmsStatusResult["status"] {
  const status = String(value ?? "").toLowerCase();
  if (status === "delivered") return "delivered";
  if (status === "expired") return "expired";
  if (["failed", "cancelled", "canceled", "rejected"].includes(status)) return "failed";
  return "sent";
}

function safeApiKey(value: string): string {
  if (value.trim().length < 8 || value.length > 4096) {
    throw new HttpSmsProviderError("not_configured", "The httpSMS API key is not configured.", false);
  }
  return value;
}

export class HttpSmsProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(input: { fetchImplementation?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImplementation = input.fetchImplementation ?? fetch;
    this.timeoutMs = input.timeoutMs ?? 10_000;
  }

  async testConnection(apiKey: string): Promise<{ ok: true; detail: string }> {
    const response = await this.request(`${OFFICIAL_API_BASE}/users/me`, {
      headers: this.headers(safeApiKey(apiKey)),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new HttpSmsProviderError("rejected", `httpSMS rejected the credentials (${response.status}).`, false);
    return { ok: true, detail: "Connected to httpSMS. No SMS was sent." };
  }

  async send(input: HttpSmsSendInput): Promise<HttpSmsSendResult> {
    const now = input.now ?? new Date();
    const apiKey = safeApiKey(input.apiKey);
    if (input.content.trim().length < 1 || input.content.length > 4000) {
      throw new HttpSmsProviderError("rejected", "Message content is invalid.", false);
    }
    if (input.sendAt && input.sendAt.getTime() > now.getTime() + MAX_SCHEDULE_MS) {
      throw new HttpSmsProviderError("rejected", "Messages may be scheduled at most 20 days ahead.", false);
    }
    const body: Record<string, unknown> = {
      content: input.content,
      from: normalizeDesktopPhone(input.from),
      to: normalizeDesktopPhone(input.to),
      request_id: input.requestId,
    };
    if (input.sendAt && input.sendAt.getTime() > now.getTime()) body.send_at = input.sendAt.toISOString();
    if (input.encrypted !== undefined) body.encrypted = input.encrypted;

    let response: Response;
    try {
      response = await this.fetchImplementation(`${OFFICIAL_API_BASE}/messages/send`, {
        method: "POST",
        headers: this.headers(apiKey, true),
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new HttpSmsProviderError(
        "outcome_unknown",
        "The connection ended before the send outcome was known. Manual review is required; the message will not be retried automatically.",
        true,
      );
    }
    const raw = await response.text().catch(() => "");
    const payload = payloadFrom(raw);
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 409) {
        throw new HttpSmsProviderError(
          "outcome_unknown",
          "httpSMS may have received the request. Manual review is required; the message will not be retried automatically.",
          true,
        );
      }
      throw new HttpSmsProviderError("rejected", `httpSMS rejected the request (${response.status}).`, false);
    }
    if (typeof payload.id !== "string" || payload.id.length === 0) {
      throw new HttpSmsProviderError("outcome_unknown", "httpSMS accepted the request without a trackable ID. Manual review is required.", true);
    }
    const rawStatus = typeof payload.status === "string" ? payload.status : "accepted";
    const status = mapStatus(rawStatus);
    if (status === "failed" || status === "expired") {
      throw new HttpSmsProviderError("rejected", "httpSMS returned a terminal failure.", false);
    }
    return { providerMessageId: payload.id, status, rawStatus };
  }

  async getStatus(apiKey: string, providerMessageId: string): Promise<HttpSmsStatusResult> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(providerMessageId)) {
      throw new HttpSmsProviderError("status_unavailable", "Invalid provider message ID.", false);
    }
    const response = await this.request(`${OFFICIAL_API_BASE}/messages/${encodeURIComponent(providerMessageId)}`, {
      headers: this.headers(safeApiKey(apiKey)),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await response.text().catch(() => "");
    if (!response.ok) throw new HttpSmsProviderError("status_unavailable", `httpSMS status check failed (${response.status}).`, false);
    const payload = payloadFrom(raw);
    const rawStatus = typeof payload.status === "string" ? payload.status : "unknown";
    return {
      status: mapStatus(rawStatus),
      rawStatus,
      ...(typeof payload.failure_reason === "string" ? { failureReason: payload.failure_reason.slice(0, 300) } : {}),
    };
  }

  private headers(apiKey: string, json = false): Record<string, string> {
    return { "x-api-key": apiKey, accept: "application/json", ...(json ? { "content-type": "application/json" } : {}) };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImplementation(url, init);
    } catch {
      throw new HttpSmsProviderError("status_unavailable", "Unable to reach httpSMS.", false);
    }
  }
}
