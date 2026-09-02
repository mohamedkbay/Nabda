import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppError } from "./domain/errors.js";
import type {
  ApiPrincipal,
  ContactCursor,
  ContactRecord,
  DeviceAgentPrincipal,
  MessageRecord,
} from "./domain/types.js";
import { normalizeE164 } from "./lib/phone.js";
import { measureSmsContent } from "./lib/sms-content.js";
import { keyedRequestDigest } from "./lib/crypto.js";
import type { RateLimiter } from "./rate-limit/rate-limiter.js";
import type { Repository } from "./repositories/repository.js";
import { AuthService } from "./services/auth-service.js";
import { DeviceAgentService } from "./services/device-agent-service.js";
import { MessageService } from "./services/message-service.js";

export interface BuildAppOptions {
  repository: Repository;
  rateLimiter: RateLimiter;
  requestRateLimiter?: RateLimiter;
  apiKeyHashSecret: string;
  providerMode: "mock" | "httpsms";
  androidAgentEnabled?: boolean;
  androidAgentLiveReportingEnabled?: boolean;
  dispatchMinIntervalMs?: number;
  logger?: FastifyServerOptions["logger"];
  now?: () => Date;
  ipRequestsPerMinute?: number;
  apiKeyRequestsPerMinute?: number;
  deviceRequestsPerMinute?: number;
  organizationWritesPerMinute?: number;
  trustProxy?: FastifyServerOptions["trustProxy"];
}

const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const docsDirectory = resolve(publicDirectory, "../docs");
const assetsDirectory = resolve(publicDirectory, "../assets");
const cairoFontDirectory = resolve(publicDirectory, "../node_modules/@fontsource-variable/cairo/files");
const sitePages = [
  { route: "/", file: "index.html" },
  { route: "/integration", file: "integration.html" },
  { route: "/api", file: "api.html" },
  { route: "/webhooks", file: "webhooks.html" },
  { route: "/pricing", file: "pricing.html" },
  { route: "/get-started", file: "get-started.html" },
  { route: "/help", file: "help.html" },
  { route: "/legal", file: "legal.html" },
] as const;
const messageBodySchema = z.strictObject({
  device_id: z.string().uuid().optional(),
  to: z.string().min(1).max(32),
  content: z.string().trim().min(1).max(1000),
  purpose: z.enum(["transactional", "authentication", "service"]),
  consent_confirmed: z.literal(true),
  consent_reference: z.string().trim().min(1).max(255),
  client_reference: z.string().trim().min(1).max(100).optional(),
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const optOutBodySchema = z.strictObject({
  phone: z.string().min(1).max(32),
  reason: z.string().trim().min(1).max(500).optional(),
});
const contactBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  phone: z.string().min(1).max(32),
  consent_reference: z.string().trim().min(1).max(255).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64))
    .max(50)
    .refine((tags) => new Set(tags).size === tags.length, "tags must be unique")
    .default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const contactListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
const contactCursorSchema = z.strictObject({
  created_at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});
const deviceHeartbeatSchema = z.strictObject({
  app_version: z.string().trim().min(1).max(64),
  android_version: z.string().trim().min(1).max(64),
  battery_level: z.number().min(0).max(100).optional(),
  is_charging: z.boolean().optional(),
  network_type: z.string().trim().min(1).max(32).optional(),
  simulated: z.boolean().default(true),
});
const deviceClaimSchema = z.strictObject({
  limit: z.literal(1).default(1),
  simulated: z.boolean().default(true),
});
const safeAgentIdentifier = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const deviceBeginSchema = z.strictObject({
  lease_token: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  attempt_id: safeAgentIdentifier,
  simulated: z.boolean().default(true),
});
const deviceEventSchema = z.strictObject({
  lease_token: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  attempt_id: safeAgentIdentifier,
  event_id: safeAgentIdentifier,
  status: z.enum(["sent", "delivered", "failed", "cancelled"]),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  provider_message_id: z.string().trim().min(1).max(255).optional(),
  error_code: z.string().trim().min(1).max(100).optional(),
  error_message: z.string().trim().min(1).max(500).optional(),
  simulated: z.boolean(),
});

function publicMessage(message: MessageRecord) {
  return {
    id: message.id,
    object: "message",
    to: message.to,
    content: message.content,
    purpose: message.purpose,
    status: message.status,
    execution_mode: message.executionMode,
    client_reference: message.clientReference,
    failure: message.failureCode ? { code: message.failureCode, reason: message.failureReason } : null,
    metadata: message.metadata,
    scheduled_at: message.scheduledAt.toISOString(),
    expires_at: message.expiresAt.toISOString(),
    queued_at: message.queuedAt.toISOString(),
    sent_at: message.sentAt?.toISOString() ?? null,
    delivered_at: message.deliveredAt?.toISOString() ?? null,
    failed_at: message.failedAt?.toISOString() ?? null,
    expired_at: message.expiredAt?.toISOString() ?? null,
    cancelled_at: message.cancelledAt?.toISOString() ?? null,
    created_at: message.createdAt.toISOString(),
    updated_at: message.updatedAt.toISOString(),
  };
}

function publicContact(contact: ContactRecord) {
  return {
    id: contact.id,
    object: "contact",
    name: contact.name,
    phone: contact.phone,
    consent_reference: contact.consentReference,
    tags: contact.tags,
    metadata: contact.metadata,
    created_at: contact.createdAt.toISOString(),
    updated_at: contact.updatedAt.toISOString(),
  };
}

function encodeContactCursor(cursor: ContactCursor): string {
  return Buffer.from(JSON.stringify({
    created_at: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), "utf8").toString("base64url");
}

function decodeContactCursor(value: string): ContactCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url cursor.");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("Non-canonical cursor.");
    const parsed = contactCursorSchema.safeParse(JSON.parse(decoded.toString("utf8")));
    if (!parsed.success) throw new Error("Invalid cursor payload.");
    return { createdAt: new Date(parsed.data.created_at), id: parsed.data.id };
  } catch {
    throw new AppError(422, "invalid_cursor", "cursor must be a valid contacts pagination cursor.");
  }
}

function rawApiKey(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  const header = request.headers["x-api-key"];
  const explicit = typeof header === "string" ? header.trim() : null;
  if (bearer && explicit && bearer !== explicit) return null;
  return bearer || explicit || null;
}

function requirePrincipal(request: FastifyRequest): ApiPrincipal {
  if (!request.principal) throw new AppError(401, "invalid_api_key", "A valid API key is required.");
  return request.principal;
}

function requireDevicePrincipal(request: FastifyRequest): DeviceAgentPrincipal {
  if (!request.devicePrincipal) {
    throw new AppError(401, "invalid_device_token", "A valid Android device token is required.");
  }
  return request.devicePrincipal;
}

function requireScope(principal: ApiPrincipal, scope: string): void {
  if (!principal.scopes.includes(scope) && !principal.scopes.includes("*")) {
    throw new AppError(403, "insufficient_scope", `The API key requires the ${scope} scope.`);
  }
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.x-api-key",
        "request.headers.authorization",
        "request.headers.x-api-key",
        "content",
        "credential",
      ],
    },
    bodyLimit: 32 * 1024,
    connectionTimeout: 10_000,
    requestTimeout: 15_000,
    handlerTimeout: 15_000,
    maxRequestsPerSocket: 1_000,
    trustProxy: options.trustProxy ?? false,
    requestIdHeader: "x-request-id",
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
  });

  const [
    renderedPages,
    stylesheet,
    clientScript,
    cairoArabic,
    cairoLatinExtended,
    cairoLatin,
    openApiDocument,
    postmanCollection,
    postmanEnvironment,
    openGraphImage,
    favicon,
    brandMark,
    brandWordmark,
    androidPhoneFrame,
  ] = await Promise.all([
    Promise.all(sitePages.map(async ({ route, file }) => [
      route,
      await readFile(resolve(publicDirectory, file)),
    ] as const)),
    readFile(resolve(publicDirectory, "styles.css")),
    readFile(resolve(publicDirectory, "app.js")),
    readFile(resolve(cairoFontDirectory, "cairo-arabic-wght-normal.woff2")),
    readFile(resolve(cairoFontDirectory, "cairo-latin-ext-wght-normal.woff2")),
    readFile(resolve(cairoFontDirectory, "cairo-latin-wght-normal.woff2")),
    readFile(resolve(docsDirectory, "openapi.yaml")),
    readFile(resolve(docsDirectory, "postman/nabda-api.postman_collection.json")),
    readFile(resolve(docsDirectory, "postman/nabda-local.postman_environment.json")),
    readFile(resolve(assetsDirectory, "nabda-og.png")),
    readFile(resolve(publicDirectory, "favicon.svg")),
    readFile(resolve(publicDirectory, "brand/nabda-mark.svg")),
    readFile(resolve(publicDirectory, "brand/nabda-wordmark.svg")),
    readFile(resolve(publicDirectory, "brand/android-phone-frame.svg")),
  ]);

  // The custom phone-agent protocol is legacy-only and is never registered by default.
  const androidAgentEnabled = options.androidAgentEnabled ?? true;
  const androidAgentLiveReportingEnabled = options.androidAgentLiveReportingEnabled ?? false;
  const executionMode = options.providerMode === "httpsms" || androidAgentLiveReportingEnabled
    ? "live"
    : "simulation";
  const auth = new AuthService(
    options.repository,
    options.apiKeyHashSecret,
    executionMode === "live" ? "live" : "test",
  );
  const deviceAgent = new DeviceAgentService(
    options.repository,
    options.apiKeyHashSecret,
    androidAgentLiveReportingEnabled,
  );
  const messages = new MessageService(
    options.repository,
    options.rateLimiter,
    options.apiKeyHashSecret,
    executionMode,
  );
  const requestRateLimiter = options.requestRateLimiter ?? options.rateLimiter;
  const now = options.now ?? (() => new Date());
  const dispatchMinIntervalMs = options.dispatchMinIntervalMs ?? 3_000;
  const ipRequestsPerMinute = options.ipRequestsPerMinute ?? 120;
  const apiKeyRequestsPerMinute = options.apiKeyRequestsPerMinute ?? 600;
  const deviceRequestsPerMinute = options.deviceRequestsPerMinute ?? 120;
  const organizationWritesPerMinute = options.organizationWritesPerMinute ?? 60;

  async function enforceRequestLimit(key: string, limit: number, at: Date): Promise<void> {
    let result;
    try {
      result = await requestRateLimiter.consume(`http:${key}`, limit, at);
    } catch {
      throw new AppError(503, "rate_limit_unavailable", "The request protection service is unavailable.");
    }
    if (!result.allowed) {
      throw new AppError(
        429,
        "request_rate_limited",
        "Too many API requests were received.",
        { limit: result.limit, remaining: result.remaining, reset_at: result.resetAt.toISOString() },
        result.resetAt,
      );
    }
  }

  function enforceDeviceMode(principal: DeviceAgentPrincipal, simulated: boolean): void {
    if (!deviceAgent.matchesRequestedMode(principal, simulated)) {
      throw new AppError(
        409,
        "device_mode_mismatch",
        "The requested operating mode does not match the authenticated device credential.",
      );
    }
    if (principal.mode === "live" && !androidAgentLiveReportingEnabled) {
      throw new AppError(403, "android_agent_live_reporting_disabled", "Live Android SMS reporting is disabled.");
    }
  }

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode);
      if (
        ["subscription_quota_exceeded", "rate_limited", "recipient_rate_limited", "request_rate_limited"]
          .includes(error.code)
        && error.retryAt
      ) {
        const retrySeconds = Math.max(Math.ceil((error.retryAt.getTime() - now().getTime()) / 1000), 1);
        reply.header(
          "retry-after",
          error.code === "subscription_quota_exceeded"
            ? error.retryAt.toUTCString()
            : String(retrySeconds),
        );
      }
      return reply.send({
        error: { code: error.code, message: error.message, details: error.details, request_id: request.id },
      });
    }
    const frameworkStatus = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 0;
    if (frameworkStatus >= 400 && frameworkStatus < 500) {
      return reply.code(frameworkStatus).send({
        error: {
          code: frameworkStatus === 413 ? "payload_too_large" : "invalid_request",
          message: frameworkStatus === 413 ? "The request body is too large." : "The HTTP request is invalid.",
          request_id: request.id,
        },
      });
    }
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({
      error: { code: "internal_error", message: "An unexpected error occurred.", request_id: request.id },
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (path?.startsWith("/v1/")) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
      if (["POST", "PUT", "PATCH"].includes(request.method)) {
        const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType !== "application/json") {
          throw new AppError(415, "unsupported_media_type", "This endpoint accepts application/json only.");
        }
      }
    }
    if (path === "/health/ready" || path?.startsWith("/v1/")) {
      await enforceRequestLimit(`ip:${request.ip}`, ipRequestsPerMinute, now());
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    provider_mode: options.providerMode,
    delivery_mode: androidAgentLiveReportingEnabled ? "android_lan" : options.providerMode,
  }));
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const checks = await Promise.allSettled([options.repository.health(), options.rateLimiter.health()]);
    const ready = checks.every((check) => check.status === "fulfilled");
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
  });
  for (const [route, page] of renderedPages) {
    const routes = route === "/" ? [route] : [route, `${route}/`];
    for (const registeredRoute of routes) {
      app.get(registeredRoute, async (_request, reply) => reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .send(page));
    }
  }
  app.get("/styles.css", async (_request, reply) => reply
    .type("text/css; charset=utf-8")
    .header("cache-control", "no-cache")
    .send(stylesheet));
  app.get("/app.js", async (_request, reply) => reply
    .type("application/javascript; charset=utf-8")
    .header("cache-control", "no-cache")
    .send(clientScript));
  app.get("/fonts/cairo-arabic-wght-normal.woff2", async (_request, reply) => reply
    .type("font/woff2")
    .header("cache-control", "public, max-age=31536000, immutable")
    .send(cairoArabic));
  app.get("/fonts/cairo-latin-ext-wght-normal.woff2", async (_request, reply) => reply
    .type("font/woff2")
    .header("cache-control", "public, max-age=31536000, immutable")
    .send(cairoLatinExtended));
  app.get("/fonts/cairo-latin-wght-normal.woff2", async (_request, reply) => reply
    .type("font/woff2")
    .header("cache-control", "public, max-age=31536000, immutable")
    .send(cairoLatin));
  app.get("/og.png", async (_request, reply) => reply
    .type("image/png")
    .header("cache-control", "public, max-age=31536000, immutable")
    .send(openGraphImage));
  for (const [route, asset] of [
    ["/favicon.svg", favicon],
    ["/brand/nabda-mark.svg", brandMark],
    ["/brand/nabda-wordmark.svg", brandWordmark],
    ["/brand/android-phone-frame.svg", androidPhoneFrame],
  ] as const) {
    app.get(route, async (_request, reply) => reply
      .type("image/svg+xml; charset=utf-8")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(asset));
  }
  app.get("/openapi.yaml", async (_request, reply) => reply
    .type("application/yaml; charset=utf-8")
    .header("cache-control", "no-cache")
    .send(openApiDocument));
  app.get("/downloads/nabda-api.postman_collection.json", async (_request, reply) => reply
    .type("application/json; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("content-disposition", 'attachment; filename="nabda-api.postman_collection.json"')
    .send(postmanCollection));
  app.get("/downloads/nabda-local.postman_environment.json", async (_request, reply) => reply
    .type("application/json; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("content-disposition", 'attachment; filename="nabda-local.postman_environment.json"')
    .send(postmanEnvironment));

  if (androidAgentEnabled) await app.register(async (device) => {
    device.addHook("preHandler", async (request) => {
      if (!androidAgentEnabled) {
        throw new AppError(503, "device_agent_disabled", "The Android device agent is disabled on this server.");
      }
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (!token) throw new AppError(401, "invalid_device_token", "A valid Android device token is required.");
      const principal = await deviceAgent.authenticate(token, now());
      if (!principal) throw new AppError(401, "invalid_device_token", "A valid Android device token is required.");
      await enforceRequestLimit(`device:${principal.credentialId}`, deviceRequestsPerMinute, now());
      request.devicePrincipal = principal;
    });

    device.post("/heartbeat", async (request) => {
      const principal = requireDevicePrincipal(request);
      const parsed = deviceHeartbeatSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(422, "validation_error", "The heartbeat body is invalid.", parsed.error.flatten());
      }
      enforceDeviceMode(principal, parsed.data.simulated);
      const accepted = await deviceAgent.heartbeat(principal, parsed.data, now());
      if (!accepted) throw new AppError(409, "device_unavailable", "The Android device is unavailable.");
      return {
        device_id: principal.deviceId,
        server_time: now().toISOString(),
        execution_mode: principal.mode,
        live_reporting_enabled: principal.mode === "live" && androidAgentLiveReportingEnabled,
        poll_after_ms: 2_000,
      };
    });

    device.post("/messages/claim", async (request) => {
      const principal = requireDevicePrincipal(request);
      const parsed = deviceClaimSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(422, "validation_error", "The claim body is invalid.", parsed.error.flatten());
      }
      enforceDeviceMode(principal, parsed.data.simulated);
      const { result, rawLeaseToken } = await deviceAgent.claim(principal, now());
      if (result.kind === "device_unavailable") {
        throw new AppError(409, "device_unavailable", "The Android device is unavailable.");
      }
      if (result.kind === "empty") return { messages: [], poll_after_ms: 2_000 };
      return {
        messages: [{
          id: result.claim.message.id,
          to: result.claim.message.to,
          body: result.claim.message.content,
          execution_mode: result.claim.message.executionMode,
          lease_token: rawLeaseToken,
          lease_expires_at: result.claim.leaseExpiresAt.toISOString(),
        }],
        poll_after_ms: 2_000,
      };
    });

    device.post<{ Params: { id: string } }>("/messages/:id/begin", async (request) => {
      const principal = requireDevicePrincipal(request);
      if (!z.string().uuid().safeParse(request.params.id).success) {
        throw new AppError(404, "message_not_found", "The message was not found.");
      }
      const parsed = deviceBeginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(422, "validation_error", "The begin body is invalid.", parsed.error.flatten());
      }
      enforceDeviceMode(principal, parsed.data.simulated);
      const result = await deviceAgent.begin({
        principal,
        messageId: request.params.id,
        attemptId: parsed.data.attempt_id,
        leaseToken: parsed.data.lease_token,
        dispatchMinIntervalMs,
        at: now(),
      });
      switch (result.kind) {
        case "authorized":
          return {
            authorized: true,
            duplicate: result.duplicate,
            message_id: result.message.id,
            lease_expires_at: result.leaseExpiresAt.toISOString(),
          };
        case "not_found":
          throw new AppError(404, "message_not_found", "The message was not found.");
        case "invalid_lease":
          throw new AppError(409, "invalid_device_lease", "The device lease does not match this message.");
        case "lease_expired":
          throw new AppError(410, "device_lease_expired", "The device lease expired before the attempt began.");
        case "invalid_attempt":
          throw new AppError(409, "device_attempt_conflict", "Another sending attempt already began for this lease.");
        case "not_dispatchable":
          throw new AppError(409, "message_not_dispatchable", "The message is no longer safe to dispatch.", {
            status: result.message.status,
            failure_code: result.message.failureCode,
          });
        case "rate_limited":
          throw new AppError(429, "rate_limited", "The minimum device dispatch interval has not elapsed.", {
            resetAt: result.retryAt.toISOString(),
          }, result.retryAt);
      }
    });

    device.post<{ Params: { id: string } }>("/messages/:id/events", async (request) => {
      const principal = requireDevicePrincipal(request);
      if (!z.string().uuid().safeParse(request.params.id).success) {
        throw new AppError(404, "message_not_found", "The message was not found.");
      }
      const parsed = deviceEventSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(422, "validation_error", "The device event body is invalid.", parsed.error.flatten());
      }
      enforceDeviceMode(principal, parsed.data.simulated);
      const eventTime = parsed.data.occurred_at ? new Date(parsed.data.occurred_at) : now();
      const serverTime = now();
      if (
        eventTime > new Date(serverTime.getTime() + 5 * 60 * 1000)
        || eventTime < new Date(serverTime.getTime() - 24 * 60 * 60 * 1000)
      ) {
        throw new AppError(422, "invalid_event_time", "occurred_at must be within the accepted server window.");
      }
      const result = await deviceAgent.recordEvent({
        principal,
        messageId: request.params.id,
        eventId: parsed.data.event_id,
        attemptId: parsed.data.attempt_id,
        leaseToken: parsed.data.lease_token,
        requestHash: keyedRequestDigest({
          status: parsed.data.status,
          mode: principal.mode,
          occurred_at: parsed.data.occurred_at ?? null,
          provider_message_id: parsed.data.provider_message_id ?? null,
          error_code: parsed.data.error_code ?? null,
          error_message: parsed.data.error_message ?? null,
        }, options.apiKeyHashSecret, "device-event-idempotency"),
        requestedStatus: parsed.data.status,
        ...(parsed.data.provider_message_id ? { providerMessageId: parsed.data.provider_message_id } : {}),
        ...(parsed.data.error_code ? { errorCode: parsed.data.error_code } : {}),
        ...(parsed.data.error_message ? { errorMessage: parsed.data.error_message } : {}),
        occurredAt: eventTime,
        at: serverTime,
      });
      switch (result.kind) {
        case "accepted":
          return {
            accepted: true,
            duplicate: result.duplicate,
            message_id: result.message.id,
            status: result.message.status,
            failure_code: result.message.failureCode,
          };
        case "not_found":
          throw new AppError(404, "message_not_found", "The message was not found.");
        case "event_conflict":
          throw new AppError(409, "device_event_conflict", "The event ID was already used for a different attempt.");
        case "invalid_lease":
          throw new AppError(409, "invalid_device_lease", "The lease or attempt does not match the begun attempt.");
        case "lease_expired":
          throw new AppError(410, "device_lease_expired", "The begun attempt lease expired before its result was recorded.");
        case "invalid_transition":
          throw new AppError(409, "invalid_message_transition", "The reported status is invalid for the current message state.");
      }
    });
  }, { prefix: "/v1/device" });

  await app.register(async (v1) => {
    v1.addHook("preHandler", async (request) => {
      const key = rawApiKey(request);
      if (!key) throw new AppError(401, "invalid_api_key", "A valid API key is required.");
      const principal = await auth.authenticate(key, now());
      if (!principal) throw new AppError(401, "invalid_api_key", "A valid API key is required.");
      await enforceRequestLimit(`api-key:${principal.apiKeyId}`, apiKeyRequestsPerMinute, now());
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        await enforceRequestLimit(
          `organization-write:${principal.organizationId}`,
          organizationWritesPerMinute,
          now(),
        );
      }
      request.principal = principal;
    });

    v1.post("/messages", async (request, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal, "messages:write");
      const idempotencyValue = request.headers["idempotency-key"];
      const idempotencyKey = typeof idempotencyValue === "string" ? idempotencyValue.trim() : "";
      if (!idempotencyPattern.test(idempotencyKey)) {
        throw new AppError(422, "invalid_idempotency_key", "Idempotency-Key must be 16-128 safe ASCII characters.");
      }
      const parsed = messageBodySchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(422, "validation_error", "The request body is invalid.", parsed.error.flatten());
      const contentMeasure = measureSmsContent(parsed.data.content);
      if (!contentMeasure.fitsSingleSegment) {
        throw new AppError(
          422,
          "message_exceeds_single_segment",
          "MVP messages must fit in one SMS segment.",
          {
            encoding: contentMeasure.encoding,
            units: contentMeasure.units,
            limit: contentMeasure.singleSegmentLimit,
          },
        );
      }
      if (Buffer.byteLength(JSON.stringify(parsed.data.metadata), "utf8") > 4096) {
        throw new AppError(422, "validation_error", "metadata must not exceed 4096 bytes.");
      }
      const phone = normalizeE164(parsed.data.to);
      if (!phone) throw new AppError(422, "invalid_phone", "to must be a valid phone number; Libyan numbers may omit +218.");
      const requestTime = now();
      const scheduledAt = parsed.data.scheduled_at ? new Date(parsed.data.scheduled_at) : requestTime;
      if (scheduledAt < new Date(requestTime.getTime() - 1000)) {
        throw new AppError(422, "invalid_schedule", "scheduled_at cannot be in the past.");
      }
      if (scheduledAt > new Date(requestTime.getTime() + 7 * 24 * 60 * 60 * 1000)) {
        throw new AppError(422, "invalid_schedule", "scheduled_at cannot be more than 7 days ahead.");
      }
      const expiresAt = parsed.data.expires_at
        ? new Date(parsed.data.expires_at)
        : new Date(scheduledAt.getTime() + 24 * 60 * 60 * 1000);
      if (expiresAt <= scheduledAt || expiresAt > new Date(requestTime.getTime() + 30 * 24 * 60 * 60 * 1000)) {
        throw new AppError(422, "invalid_expiry", "expires_at must be after scheduled_at and within 30 days.");
      }

      const result = await messages.submit(principal, {
        ...(parsed.data.device_id ? { deviceId: parsed.data.device_id } : {}),
        to: phone,
        content: parsed.data.content,
        purpose: parsed.data.purpose,
        ...(parsed.data.client_reference ? { clientReference: parsed.data.client_reference } : {}),
        idempotencyKey,
        metadata: parsed.data.metadata,
        scheduledAt,
        expiresAt,
        consentCapturedAt: requestTime,
        consentReference: parsed.data.consent_reference,
        fingerprintSource: {
          device_id: parsed.data.device_id ?? null,
          to: phone,
          content: parsed.data.content,
          purpose: parsed.data.purpose,
          client_reference: parsed.data.client_reference ?? null,
          scheduled_at: parsed.data.scheduled_at ?? null,
          expires_at: parsed.data.expires_at ?? null,
          consent_reference: parsed.data.consent_reference,
          metadata: parsed.data.metadata,
        },
      });
      if (result.rateLimit) {
        reply.headers({
          "x-ratelimit-limit": String(result.rateLimit.limit),
          "x-ratelimit-remaining": String(result.rateLimit.remaining),
          "x-ratelimit-reset": result.rateLimit.resetAt.toISOString(),
        });
      }
      if (result.replayed) reply.header("idempotent-replayed", "true");
      return reply.code(result.replayed ? 200 : 202).send({ data: publicMessage(result.message) });
    });

    v1.post("/opt-outs", async (request, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal, "opt_outs:write");
      const parsed = optOutBodySchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(422, "validation_error", "The request body is invalid.", parsed.error.flatten());
      const phone = normalizeE164(parsed.data.phone);
      if (!phone) throw new AppError(422, "invalid_phone", "phone must be valid; Libyan numbers may omit +218.");
      const result = await options.repository.addOptOut({
        organizationId: principal.organizationId,
        apiKeyId: principal.apiKeyId,
        phone,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        at: now(),
      });
      return reply.code(result.created ? 201 : 200).send({
        data: {
          id: result.id,
          object: "opt_out",
          phone,
          active: true,
          cancelled_message_ids: result.cancelledMessageIds,
        },
      });
    });

    v1.post("/contacts", async (request, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal, "contacts:write");
      const usage = await options.repository.getUsage(principal.organizationId, now());
      if (!usage || !["active", "trialing"].includes(usage.subscriptionStatus)) {
        throw new AppError(403, "subscription_inactive", "An active subscription is required.");
      }
      const parsed = contactBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(422, "validation_error", "The request body is invalid.", parsed.error.flatten());
      }
      if (Buffer.byteLength(JSON.stringify(parsed.data.metadata), "utf8") > 4096) {
        throw new AppError(422, "validation_error", "metadata must not exceed 4096 bytes.");
      }
      const phone = normalizeE164(parsed.data.phone);
      if (!phone) throw new AppError(422, "invalid_phone", "phone must be valid; Libyan numbers may omit +218.");
      const result = await options.repository.upsertContact({
        organizationId: principal.organizationId,
        apiKeyId: principal.apiKeyId,
        name: parsed.data.name,
        phone,
        ...(typeof parsed.data.consent_reference === "string"
          ? { consentReference: parsed.data.consent_reference }
          : {}),
        tags: parsed.data.tags,
        metadata: parsed.data.metadata,
        maxContacts: usage.maxContacts,
        at: now(),
      });
      if (result.kind === "limit_exceeded") {
        throw new AppError(409, "contact_limit_exceeded", "The plan's active contact limit was reached.", {
          limit: result.limit,
        });
      }
      return reply.code(result.created ? 201 : 200).send({ data: publicContact(result.contact) });
    });

    v1.get("/contacts", async (request) => {
      const principal = requirePrincipal(request);
      requireScope(principal, "contacts:read");
      const parsed = contactListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new AppError(422, "validation_error", "The query parameters are invalid.", parsed.error.flatten());
      }
      const page = await options.repository.listContacts({
        organizationId: principal.organizationId,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor ? decodeContactCursor(parsed.data.cursor) : null,
      });
      return {
        data: page.contacts.map(publicContact),
        meta: {
          limit: parsed.data.limit,
          next_cursor: page.nextCursor ? encodeContactCursor(page.nextCursor) : null,
        },
      };
    });

    v1.delete<{ Params: { id: string } }>("/contacts/:id", async (request, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal, "contacts:write");
      if (!z.string().uuid().safeParse(request.params.id).success) {
        throw new AppError(404, "contact_not_found", "The contact was not found.");
      }
      const deleted = await options.repository.deleteContact({
        organizationId: principal.organizationId,
        apiKeyId: principal.apiKeyId,
        contactId: request.params.id,
        at: now(),
      });
      if (!deleted) throw new AppError(404, "contact_not_found", "The contact was not found.");
      return reply.code(204).send();
    });

    v1.get("/queue", async (request) => {
      const principal = requirePrincipal(request);
      requireScope(principal, "messages:read");
      const summary = await options.repository.getQueueSummary(principal.organizationId, now());
      return {
        data: {
          object: "queue_summary",
          queued_total: summary.queuedTotal,
          ready: summary.ready,
          scheduled: summary.scheduled,
          processing: summary.processing,
          oldest_queued_at: summary.oldestQueuedAt?.toISOString() ?? null,
        },
      };
    });

    v1.get<{ Params: { id: string } }>("/messages/:id", async (request) => {
      const principal = requirePrincipal(request);
      requireScope(principal, "messages:read");
      if (!z.string().uuid().safeParse(request.params.id).success) {
        throw new AppError(404, "message_not_found", "The message was not found.");
      }
      const message = await options.repository.getMessage(principal.organizationId, request.params.id);
      if (!message) throw new AppError(404, "message_not_found", "The message was not found.");
      return { data: publicMessage(message) };
    });

    v1.get("/usage", async (request) => {
      const principal = requirePrincipal(request);
      requireScope(principal, "usage:read");
      const usage = await options.repository.getUsage(principal.organizationId, now());
      if (!usage) throw new AppError(404, "subscription_not_found", "No current subscription was found.");
      return {
        data: {
          plan: usage.planCode,
          subscription_status: usage.subscriptionStatus,
          period_start: usage.periodStart.toISOString(),
          period_end: usage.periodEnd.toISOString(),
          messages_used: usage.messagesUsed,
          message_limit: usage.messageLimit,
          messages_remaining: usage.messagesRemaining,
          per_minute_rate_limit: usage.perMinuteRateLimit,
          max_contacts: usage.maxContacts,
        },
      };
    });
  }, { prefix: "/v1" });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({
    error: { code: "not_found", message: "The endpoint was not found." },
  }));

  return app;
}
