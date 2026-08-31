import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  defaultUsage,
  seedTenant,
  TEST_NOW,
  type TestContext,
  validContactBody,
  validMessageBody,
} from "./support/fixtures.js";

const IDEMPOTENCY_KEY = "idem-test-00000001";
const SITE_ROUTES = [
  "/",
  "/integration",
  "/api",
  "/webhooks",
  "/pricing",
  "/get-started",
  "/help",
  "/legal",
] as const;

function authHeaders(rawApiKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    "x-api-key": rawApiKey,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function postMessage(
  app: FastifyInstance,
  rawApiKey: string,
  idempotencyKey = IDEMPOTENCY_KEY,
  body: Record<string, unknown> = validMessageBody(),
) {
  return app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: authHeaders(rawApiKey, idempotencyKey),
    payload: body,
  });
}

async function postContact(
  app: FastifyInstance,
  rawApiKey: string,
  body: Record<string, unknown> = validContactBody(),
) {
  return app.inject({
    method: "POST",
    url: "/v1/contacts",
    headers: authHeaders(rawApiKey),
    payload: body,
  });
}

describe("health and API-key authentication", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    await context.app.close();
  });

  it("exposes liveness and readiness without authentication", async () => {
    const health = await context.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", provider_mode: "mock" });
    await expect(context.app.inject({ method: "GET", url: "/health/live" })).resolves.toMatchObject({ statusCode: 200 });

    const ready = await context.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });

    context.rateLimiter.failHealth = true;
    const unavailable = await context.app.inject({ method: "GET", url: "/health/ready" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ status: "not_ready" });
  });

  it("sets bounded HTTP connection and request lifetimes", () => {
    expect(context.app.server.timeout).toBe(10_000);
    expect(context.app.server.requestTimeout).toBe(15_000);
    expect(context.app.server.maxRequestsPerSocket).toBe(1_000);
    expect((context.app.initialConfig as { handlerTimeout?: number }).handlerTimeout).toBe(15_000);
  });

  it("rate-limits unauthenticated API traffic by source address", async () => {
    const limited = await createTestContext({ ipRequestsPerMinute: 1 });
    try {
      const first = await limited.app.inject({ method: "GET", url: "/v1/usage" });
      expect(first.statusCode).toBe(401);

      const second = await limited.app.inject({ method: "GET", url: "/v1/usage" });
      expect(second.statusCode).toBe(429);
      expect(second.headers["retry-after"]).toBeDefined();
      expect(second.json()).toMatchObject({ error: { code: "request_rate_limited" } });
    } finally {
      await limited.app.close();
    }
  });

  it("rate-limits authenticated API traffic independently per key", async () => {
    const limited = await createTestContext({ ipRequestsPerMinute: 10, apiKeyRequestsPerMinute: 1 });
    try {
      const first = await limited.app.inject({
        method: "GET",
        url: "/v1/usage",
        headers: authHeaders(limited.tenantA.rawApiKey),
      });
      expect(first.statusCode).toBe(200);

      const second = await limited.app.inject({
        method: "GET",
        url: "/v1/usage",
        headers: authHeaders(limited.tenantA.rawApiKey),
      });
      expect(second.statusCode).toBe(429);
      expect(second.json()).toMatchObject({ error: { code: "request_rate_limited" } });
    } finally {
      await limited.app.close();
    }
  });

  it("fails closed when request-level abuse protection is unavailable", async () => {
    context.requestRateLimiter.failConsume = true;
    const response = await context.app.inject({ method: "GET", url: "/v1/usage" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "rate_limit_unavailable" } });
  });

  it("serves the homepage and its local assets with a strict CSP", async () => {
    const homepage = await context.app.inject({ method: "GET", url: "/" });
    expect(homepage.statusCode).toBe(200);
    expect(homepage.headers["content-type"]).toContain("text/html");
    expect(homepage.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(homepage.body).toContain('<html lang="en" dir="ltr">');
    expect(homepage.body).toContain("httpSMS Desktop");
    expect(homepage.body).toContain("Unofficial");

    const stylesheet = await context.app.inject({ method: "GET", url: "/styles.css" });
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers["content-type"]).toContain("text/css");

    const clientScript = await context.app.inject({ method: "GET", url: "/app.js" });
    expect(clientScript.statusCode).toBe(200);
    expect(clientScript.headers["content-type"]).toContain("application/javascript");

    const cairoFont = await context.app.inject({
      method: "GET",
      url: "/fonts/cairo-arabic-wght-normal.woff2",
    });
    expect(cairoFont.statusCode).toBe(200);
    expect(cairoFont.headers["content-type"]).toContain("font/woff2");
    expect(cairoFont.headers["cache-control"]).toContain("immutable");

    const openGraphImage = await context.app.inject({ method: "GET", url: "/og.png" });
    expect(openGraphImage.statusCode).toBe(200);
    expect(openGraphImage.headers["content-type"]).toContain("image/png");
    expect(openGraphImage.headers["cache-control"]).toContain("immutable");
    expect(openGraphImage.rawPayload.subarray(0, 8))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("serves every marketing and help page at a clean route", async () => {
    for (const route of SITE_ROUTES) {
      const response = await context.app.inject({ method: "GET", url: route });
      expect(response.statusCode, route).toBe(200);
      expect(response.headers["content-type"], route).toContain("text/html");
      expect(response.headers["cache-control"], route).toBe("no-cache");
      expect(response.body, route).toMatch(/<title>[^<]*httpSMS Desktop[^<]*<\/title>/i);
      expect(response.body, route).toMatch(/<h1(?:\s[^>]*)?>/i);
    }

    const homepage = await context.app.inject({ method: "GET", url: "/" });
    for (const route of SITE_ROUTES.slice(1)) {
      expect(homepage.body).toContain(`href="${route}"`);
    }
  });

  it("presents the local Desktop client and separates provider costs", async () => {
    const homepage = await context.app.inject({ method: "GET", url: "/" });
    const pricing = await context.app.inject({ method: "GET", url: "/pricing" });
    const gettingStarted = await context.app.inject({ method: "GET", url: "/get-started" });
    const help = await context.app.inject({ method: "GET", url: "/help" });

    expect(homepage.body).toContain("httpSMS Desktop");
    expect(homepage.body).toContain("official httpSMS service and Android app");
    expect(pricing.body).toContain("No trial timer and no Desktop subscription");
    expect(pricing.body).toContain("Controlled elsewhere");
    expect(gettingStarted.body).toContain("Account API Key");
    expect(gettingStarted.body).toContain("without local pairing");
    expect(help.body).toContain("No custom phone software");
    expect(help.body).toContain("GET /v1/users/me");

    for (const body of [homepage.body, pricing.body, gettingStarted.body, help.body]) {
      expect(body).not.toContain("db:trial");
      expect(body).not.toContain("Nabda");
      expect(body).not.toContain("نبضة");
    }
  });

  it("publishes the educational-project legal and responsible-use notice", async () => {
    const legal = await context.app.inject({ method: "GET", url: "/legal" });
    expect(legal.statusCode).toBe(200);
    expect(legal.body).toContain("A learning project, not a permission slip.");
    expect(legal.body).toContain("مسؤولية المشغّل وسوء الاستخدام");
    expect(legal.body).toContain("LAW 5 / 2022");
    expect(legal.body).toContain("LAW 6 / 2022");
    expect(legal.body).toContain("LAW 22 / 2010");
    expect(legal.body).toContain("https://parliament.ly/");
    expect(legal.body).toContain("This allocation of responsibility is not an attempt to exclude liability that cannot legally be excluded.");

    for (const route of SITE_ROUTES.filter((route) => route !== "/legal")) {
      const page = await context.app.inject({ method: "GET", url: route });
      expect(page.body, route).toContain('href="/legal"');
    }
  });

  it("accepts trailing slashes for site pages without changing API routing", async () => {
    for (const route of SITE_ROUTES.slice(1)) {
      const response = await context.app.inject({ method: "GET", url: `${route}/` });
      expect(response.statusCode, route).toBe(200);
      expect(response.headers.location, route).toBeUndefined();
    }

    const protectedApi = await context.app.inject({ method: "GET", url: "/v1/usage" });
    expect(protectedApi.statusCode).toBe(401);
    expect(protectedApi.json()).toMatchObject({ error: { code: "invalid_api_key" } });
  });

  it("serves OpenAPI and secret-free Postman artifacts from fixed download routes", async () => {
    const openApi = await context.app.inject({ method: "GET", url: "/openapi.yaml" });
    expect(openApi.statusCode).toBe(200);
    expect(openApi.headers["content-type"]).toContain("application/yaml");
    expect(openApi.body).toContain("openapi:");

    const collection = await context.app.inject({
      method: "GET",
      url: "/downloads/nabda-api.postman_collection.json",
    });
    expect(collection.statusCode).toBe(200);
    expect(collection.headers["content-type"]).toContain("application/json");
    expect(collection.headers["content-disposition"])
      .toBe('attachment; filename="nabda-api.postman_collection.json"');
    expect(() => JSON.parse(collection.body)).not.toThrow();

    const environment = await context.app.inject({
      method: "GET",
      url: "/downloads/nabda-local.postman_environment.json",
    });
    expect(environment.statusCode).toBe(200);
    expect(environment.headers["content-type"]).toContain("application/json");
    expect(environment.headers["content-disposition"])
      .toBe('attachment; filename="nabda-local.postman_environment.json"');
    expect(() => JSON.parse(environment.body)).not.toThrow();
    const parsedEnvironment = JSON.parse(environment.body) as {
      values?: Array<{ key?: string; value?: unknown }>;
    };
    expect(parsedEnvironment.values?.find((entry) => entry.key === "api_key")?.value).toBe("");

    for (const artifact of [openApi.body, collection.body, environment.body]) {
      expect(artifact).not.toMatch(/nbda_(?:live|test)_[A-Za-z0-9_-]{8,16}\.[A-Za-z0-9_-]{40,64}/);
    }
  });

  it("rejects missing, malformed, and incorrectly hashed API keys", async () => {
    const missing = await context.app.inject({ method: "GET", url: "/v1/usage" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: { code: "invalid_api_key" } });

    const malformed = await context.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { "x-api-key": "not-an-api-key" },
    });
    expect(malformed.statusCode).toBe(401);

    const tampered = await context.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { "x-api-key": `${context.tenantA.rawApiKey.slice(0, -1)}x` },
    });
    expect(tampered.statusCode).toBe(401);
  });

  it("accepts a correctly hashed API key through Bearer authentication", async () => {
    const response = await context.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: `Bearer ${context.tenantA.rawApiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { plan: "starter" } });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
  });

  it("rejects revoked, expired, suspended-tenant, and conflicting API credentials", async () => {
    const revoked = seedTenant(context.repository, {
      organizationId: "00000000-0000-4000-8000-000000000021",
      apiKeyId: "10000000-0000-4000-8000-000000000021",
      deviceId: "20000000-0000-4000-8000-000000000021",
      revokedAt: new Date(TEST_NOW.getTime() - 1_000),
    });
    const expired = seedTenant(context.repository, {
      organizationId: "00000000-0000-4000-8000-000000000022",
      apiKeyId: "10000000-0000-4000-8000-000000000022",
      deviceId: "20000000-0000-4000-8000-000000000022",
      expiresAt: new Date(TEST_NOW.getTime()),
    });
    const suspended = seedTenant(context.repository, {
      organizationId: "00000000-0000-4000-8000-000000000023",
      apiKeyId: "10000000-0000-4000-8000-000000000023",
      deviceId: "20000000-0000-4000-8000-000000000023",
      organizationStatus: "suspended",
    });

    for (const rawApiKey of [revoked.rawApiKey, expired.rawApiKey, suspended.rawApiKey]) {
      const response = await context.app.inject({
        method: "GET",
        url: "/v1/usage",
        headers: { authorization: `Bearer ${rawApiKey}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    }

    const conflicting = await context.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: {
        authorization: `Bearer ${context.tenantA.rawApiKey}`,
        "x-api-key": context.tenantB.rawApiKey,
      },
    });
    expect(conflicting.statusCode).toBe(401);
    expect(conflicting.json()).toMatchObject({ error: { code: "invalid_api_key" } });
  });
});

describe("POST /v1/messages", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    await context.app.close();
  });

  it("validates idempotency, consent, purpose, and E.164 recipients", async () => {
    const wrongMediaType = await context.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        ...authHeaders(context.tenantA.rawApiKey, "idem-media-00000001"),
        "content-type": "text/plain",
      },
      payload: JSON.stringify(validMessageBody()),
    });
    expect(wrongMediaType.statusCode).toBe(415);
    expect(wrongMediaType.json()).toMatchObject({ error: { code: "unsupported_media_type" } });

    const invalidKey = await postMessage(context.app, context.tenantA.rawApiKey, "short");
    expect(invalidKey.statusCode).toBe(422);
    expect(invalidKey.json()).toMatchObject({ error: { code: "invalid_idempotency_key" } });

    const missingConsentBody = validMessageBody();
    delete missingConsentBody.consent_confirmed;
    const missingConsent = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-test-00000002",
      missingConsentBody,
    );
    expect(missingConsent.statusCode).toBe(422);
    expect(missingConsent.json()).toMatchObject({ error: { code: "validation_error" } });

    const missingConsentReferenceBody = validMessageBody();
    delete missingConsentReferenceBody.consent_reference;
    const missingConsentReference = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-test-00000005",
      missingConsentReferenceBody,
    );
    expect(missingConsentReference.statusCode).toBe(422);
    expect(missingConsentReference.json()).toMatchObject({ error: { code: "validation_error" } });

    const promotional = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-test-00000003",
      validMessageBody({ purpose: "marketing" }),
    );
    expect(promotional.statusCode).toBe(422);

    const invalidPhone = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-test-00000004",
      validMessageBody({ to: "091-1234" }),
    );
    expect(invalidPhone.statusCode).toBe(422);
    expect(invalidPhone.json()).toMatchObject({ error: { code: "invalid_phone" } });

    const multipartGsm = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-test-00000006",
      validMessageBody({ content: "A".repeat(161) }),
    );
    expect(multipartGsm.statusCode).toBe(422);
    expect(multipartGsm.json()).toMatchObject({
      error: { code: "message_exceeds_single_segment", details: { encoding: "gsm7", limit: 160 } },
    });

    const multipartUnicode = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-test-00000007",
      validMessageBody({ content: "ن".repeat(71) }),
    );
    expect(multipartUnicode.statusCode).toBe(422);
    expect(multipartUnicode.json()).toMatchObject({
      error: { code: "message_exceeds_single_segment", details: { encoding: "ucs2", limit: 70 } },
    });
  });

  it("creates once, replays the same request, and rejects conflicting reuse", async () => {
    const body = validMessageBody();
    const first = await postMessage(context.app, context.tenantA.rawApiKey, IDEMPOTENCY_KEY, body);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ data: { status: "queued", to: "+218912345678" } });
    expect(first.headers["x-ratelimit-limit"]).toBe("10");
    const firstId = (first.json() as { data: { id: string } }).data.id;

    const replay = await postMessage(context.app, context.tenantA.rawApiKey, IDEMPOTENCY_KEY, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect((replay.json() as { data: { id: string } }).data.id).toBe(firstId);
    expect(context.repository.allMessages()).toHaveLength(1);
    expect(context.rateLimiter.consumeCalls).toHaveLength(2);

    const conflict = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      IDEMPOTENCY_KEY,
      validMessageBody({ content: "A different transaction" }),
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
  });

  it("isolates idempotency and message access by organization", async () => {
    const first = await postMessage(context.app, context.tenantA.rawApiKey);
    const firstId = (first.json() as { data: { id: string } }).data.id;

    const hidden = await context.app.inject({
      method: "GET",
      url: `/v1/messages/${firstId}`,
      headers: authHeaders(context.tenantB.rawApiKey),
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ error: { code: "message_not_found" } });

    const tenantBCreate = await postMessage(context.app, context.tenantB.rawApiKey);
    expect(tenantBCreate.statusCode).toBe(202);
    expect((tenantBCreate.json() as { data: { id: string } }).data.id).not.toBe(firstId);
    expect(context.repository.allMessages()).toHaveLength(2);
  });

  it("enforces the durable subscription quota", async () => {
    context.repository.seedUsage(context.tenantA.organizationId, defaultUsage({
      messageLimit: 1,
      messagesUsed: 1,
      messagesRemaining: 0,
    }));

    const response = await postMessage(context.app, context.tenantA.rawApiKey);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: {
        code: "subscription_quota_exceeded",
        details: { limit: 1, used: 1 },
      },
    });
    expect(response.headers["retry-after"]).toBeDefined();
    expect(context.repository.allMessages()).toHaveLength(0);
  });

  it("enforces the per-minute abuse-prevention limit", async () => {
    context.repository.seedUsage(context.tenantA.organizationId, defaultUsage({ perMinuteRateLimit: 1 }));

    const first = await postMessage(context.app, context.tenantA.rawApiKey, "idem-rate-00000001");
    expect(first.statusCode).toBe(202);
    const limited = await postMessage(context.app, context.tenantA.rawApiKey, "idem-rate-00000002");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("caps repeated messages to one recipient independently of the organization limit", async () => {
    context.repository.seedUsage(context.tenantA.organizationId, defaultUsage({ perMinuteRateLimit: 10 }));

    for (let index = 1; index <= 3; index += 1) {
      const accepted = await postMessage(
        context.app,
        context.tenantA.rawApiKey,
        `idem-recipient-0000000${index}`,
      );
      expect(accepted.statusCode).toBe(202);
    }

    const limited = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-recipient-00000004",
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({ error: { code: "recipient_rate_limited" } });

    const differentRecipient = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-recipient-00000005",
      validMessageBody({ to: "+218923456789" }),
    );
    expect(differentRecipient.statusCode).toBe(202);
  });

  it("fails closed when the abuse-prevention service is unavailable", async () => {
    context.rateLimiter.failConsume = true;

    const response = await postMessage(context.app, context.tenantA.rawApiKey);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "rate_limit_unavailable" } });
    expect(context.repository.allMessages()).toHaveLength(0);
  });

  it("blocks an opted-out recipient within the current tenant", async () => {
    context.repository.seedOptOut(context.tenantA.organizationId, "+218912345678");

    const blocked = await postMessage(context.app, context.tenantA.rawApiKey);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: { code: "recipient_opted_out" } });
    expect(context.repository.allMessages()).toHaveLength(0);

    const otherTenant = await postMessage(context.app, context.tenantB.rawApiKey);
    expect(otherTenant.statusCode).toBe(202);
  });

  it("registers an opt-out and cancels this tenant's queued messages", async () => {
    const queued = await postMessage(context.app, context.tenantA.rawApiKey);
    const queuedId = (queued.json() as { data: { id: string } }).data.id;
    const optOut = await context.app.inject({
      method: "POST",
      url: "/v1/opt-outs",
      headers: authHeaders(context.tenantA.rawApiKey),
      payload: { phone: "+218912345678", reason: "Recipient request" },
    });
    expect(optOut.statusCode).toBe(201);
    expect(optOut.json()).toMatchObject({
      data: { object: "opt_out", phone: "+218912345678", cancelled_message_ids: [queuedId] },
    });

    const cancelled = await context.app.inject({
      method: "GET",
      url: `/v1/messages/${queuedId}`,
      headers: authHeaders(context.tenantA.rawApiKey),
    });
    expect(cancelled.json()).toMatchObject({
      data: { status: "cancelled", failure: { code: "recipient_opted_out" } },
    });

    const replay = await context.app.inject({
      method: "POST",
      url: "/v1/opt-outs",
      headers: authHeaders(context.tenantA.rawApiKey),
      payload: { phone: "+218912345678" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ data: { cancelled_message_ids: [] } });

    const otherTenant = await postMessage(context.app, context.tenantB.rawApiKey);
    expect(otherTenant.statusCode).toBe(202);
  });
});

describe("GET message and usage", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    await context.app.close();
  });

  it("returns a tenant-owned message and rejects malformed identifiers", async () => {
    const created = await postMessage(context.app, context.tenantA.rawApiKey);
    const createdBody = created.json() as { data: { id: string } };
    const fetched = await context.app.inject({
      method: "GET",
      url: `/v1/messages/${createdBody.data.id}`,
      headers: authHeaders(context.tenantA.rawApiKey),
    });

    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      data: {
        id: createdBody.data.id,
        object: "message",
        status: "queued",
        purpose: "transactional",
      },
    });

    const malformed = await context.app.inject({
      method: "GET",
      url: "/v1/messages/not-a-uuid",
      headers: authHeaders(context.tenantA.rawApiKey),
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toMatchObject({ error: { code: "message_not_found" } });
  });

  it("reports plan usage after message creation", async () => {
    await postMessage(context.app, context.tenantA.rawApiKey);
    const usage = await context.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: authHeaders(context.tenantA.rawApiKey),
    });

    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({
      data: {
        plan: "starter",
        subscription_status: "active",
        messages_used: 1,
        message_limit: 100,
        messages_remaining: 99,
        per_minute_rate_limit: 10,
        max_contacts: 10_000,
      },
    });
  });
});

describe("contacts API", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    await context.app.close();
  });

  it("creates and atomically updates the active contact for the same normalized phone", async () => {
    const created = await postContact(context.app, context.tenantA.rawApiKey);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      data: {
        object: "contact",
        name: "Ahmed Al-Sadiq",
        phone: "+218912345678",
        consent_reference: "signup-form-42",
        tags: ["customer", "priority"],
        metadata: { locale: "ar-LY" },
      },
    });
    const createdId = (created.json() as { data: { id: string } }).data.id;

    const updated = await postContact(context.app, context.tenantA.rawApiKey, validContactBody({
      name: "Ahmed Updated",
      phone: "00218 91 234 5678",
      consent_reference: null,
      tags: ["active"],
      metadata: { source: "support" },
    }));
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      data: {
        id: createdId,
        name: "Ahmed Updated",
        phone: "+218912345678",
        consent_reference: null,
        tags: ["active"],
        metadata: { source: "support" },
      },
    });
    expect(context.repository.allContacts()).toHaveLength(1);
  });

  it("requires an active subscription and enforces the plan contact limit", async () => {
    context.repository.seedUsage(context.tenantA.organizationId, defaultUsage({ maxContacts: 1 }));

    const first = await postContact(context.app, context.tenantA.rawApiKey);
    expect(first.statusCode).toBe(201);

    const overLimit = await postContact(
      context.app,
      context.tenantA.rawApiKey,
      validContactBody({ phone: "+218923456789", name: "Second Contact" }),
    );
    expect(overLimit.statusCode).toBe(409);
    expect(overLimit.json()).toMatchObject({
      error: { code: "contact_limit_exceeded", details: { limit: 1 } },
    });

    const updateAtLimit = await postContact(
      context.app,
      context.tenantA.rawApiKey,
      validContactBody({ name: "Updated At Limit" }),
    );
    expect(updateAtLimit.statusCode).toBe(200);

    context.repository.seedUsage(context.tenantB.organizationId, defaultUsage({
      subscriptionStatus: "cancelled",
    }));
    const inactive = await postContact(context.app, context.tenantB.rawApiKey);
    expect(inactive.statusCode).toBe(403);
    expect(inactive.json()).toMatchObject({ error: { code: "subscription_inactive" } });
  });

  it("shares the write-rate fence across organization mutations", async () => {
    const limited = await createTestContext({ organizationWritesPerMinute: 1 });
    try {
      const first = await postContact(limited.app, limited.tenantA.rawApiKey);
      expect(first.statusCode).toBe(201);

      const second = await limited.app.inject({
        method: "POST",
        url: "/v1/opt-outs",
        headers: authHeaders(limited.tenantA.rawApiKey),
        payload: { phone: "+218923456789" },
      });
      expect(second.statusCode).toBe(429);
      expect(second.json()).toMatchObject({ error: { code: "request_rate_limited" } });
    } finally {
      await limited.app.close();
    }
  });

  it("strictly validates contact fields, unique tags, and the 4KB metadata ceiling", async () => {
    const invalidPhone = await postContact(
      context.app,
      context.tenantA.rawApiKey,
      validContactBody({ phone: "091-1234" }),
    );
    expect(invalidPhone.statusCode).toBe(422);
    expect(invalidPhone.json()).toMatchObject({ error: { code: "invalid_phone" } });

    const duplicateTags = await postContact(
      context.app,
      context.tenantA.rawApiKey,
      validContactBody({ tags: ["customer", " customer "] }),
    );
    expect(duplicateTags.statusCode).toBe(422);
    expect(duplicateTags.json()).toMatchObject({ error: { code: "validation_error" } });

    const oversizedMetadata = await postContact(
      context.app,
      context.tenantA.rawApiKey,
      validContactBody({ metadata: { note: "x".repeat(4096) } }),
    );
    expect(oversizedMetadata.statusCode).toBe(422);
    expect(oversizedMetadata.json()).toMatchObject({ error: { code: "validation_error" } });

    const unknownField = await postContact(
      context.app,
      context.tenantA.rawApiKey,
      validContactBody({ unexpected: true }),
    );
    expect(unknownField.statusCode).toBe(422);
    expect(context.repository.allContacts()).toHaveLength(0);
  });

  it("paginates by an opaque (created_at, id) cursor and rejects invalid query values", async () => {
    const createdIds: string[] = [];
    for (const [name, phone] of [
      ["Contact One", "+218911111111"],
      ["Contact Two", "+218922222222"],
      ["Contact Three", "+218933333333"],
    ]) {
      const response = await postContact(
        context.app,
        context.tenantA.rawApiKey,
        validContactBody({ name, phone }),
      );
      createdIds.push((response.json() as { data: { id: string } }).data.id);
    }

    const firstPage = await context.app.inject({
      method: "GET",
      url: "/v1/contacts?limit=2",
      headers: authHeaders(context.tenantA.rawApiKey),
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json() as {
      data: Array<{ id: string }>;
      meta: { limit: number; next_cursor: string | null };
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.meta.limit).toBe(2);
    expect(firstBody.meta.next_cursor).toEqual(expect.any(String));

    const secondPage = await context.app.inject({
      method: "GET",
      url: `/v1/contacts?limit=2&cursor=${encodeURIComponent(firstBody.meta.next_cursor as string)}`,
      headers: authHeaders(context.tenantA.rawApiKey),
    });
    const secondBody = secondPage.json() as {
      data: Array<{ id: string }>;
      meta: { next_cursor: string | null };
    };
    expect(secondPage.statusCode).toBe(200);
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.meta.next_cursor).toBeNull();
    expect(new Set([...firstBody.data, ...secondBody.data].map((contact) => contact.id)))
      .toEqual(new Set(createdIds));

    for (const url of [
      "/v1/contacts?limit=0",
      "/v1/contacts?limit=101",
      "/v1/contacts?cursor=not-a-cursor",
      "/v1/contacts?unexpected=true",
    ]) {
      const invalid = await context.app.inject({
        method: "GET",
        url,
        headers: authHeaders(context.tenantA.rawApiKey),
      });
      expect(invalid.statusCode).toBe(422);
    }
  });

  it("isolates listing and data deletion by tenant and permits recreation after deletion", async () => {
    const created = await postContact(context.app, context.tenantA.rawApiKey, validContactBody({
      phone: "+218944444444",
    }));
    const contactId = (created.json() as { data: { id: string } }).data.id;

    const hiddenList = await context.app.inject({
      method: "GET",
      url: "/v1/contacts",
      headers: authHeaders(context.tenantB.rawApiKey),
    });
    expect(hiddenList.json()).toMatchObject({ data: [] });

    const crossTenantDelete = await context.app.inject({
      method: "DELETE",
      url: `/v1/contacts/${contactId}`,
      headers: authHeaders(context.tenantB.rawApiKey),
    });
    expect(crossTenantDelete.statusCode).toBe(404);

    const deleted = await context.app.inject({
      method: "DELETE",
      url: `/v1/contacts/${contactId}`,
      headers: authHeaders(context.tenantA.rawApiKey),
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(context.repository.allContacts()).toHaveLength(0);

    const deletedAgain = await context.app.inject({
      method: "DELETE",
      url: `/v1/contacts/${contactId}`,
      headers: authHeaders(context.tenantA.rawApiKey),
    });
    expect(deletedAgain.statusCode).toBe(404);

    const recreated = await postContact(context.app, context.tenantA.rawApiKey, validContactBody({
      name: "Recreated Contact",
      phone: "+218944444444",
    }));
    expect(recreated.statusCode).toBe(201);
    expect((recreated.json() as { data: { id: string } }).data.id).not.toBe(contactId);
  });

  it("enforces contact read/write scopes without weakening the queue scope", async () => {
    const readOnly = seedTenant(context.repository, {
      organizationId: context.tenantA.organizationId,
      apiKeyId: "10000000-0000-4000-8000-000000000010",
      deviceId: "20000000-0000-4000-8000-000000000010",
      scopes: ["contacts:read"],
    });
    const deniedWrite = await postContact(context.app, readOnly.rawApiKey);
    expect(deniedWrite.statusCode).toBe(403);
    expect(deniedWrite.json()).toMatchObject({ error: { code: "insufficient_scope" } });

    const allowedRead = await context.app.inject({
      method: "GET",
      url: "/v1/contacts",
      headers: authHeaders(readOnly.rawApiKey),
    });
    expect(allowedRead.statusCode).toBe(200);

    const deniedQueue = await context.app.inject({
      method: "GET",
      url: "/v1/queue",
      headers: authHeaders(readOnly.rawApiKey),
    });
    expect(deniedQueue.statusCode).toBe(403);
  });
});

describe("GET /v1/queue", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    await context.app.close();
  });

  it("reports tenant-scoped ready, scheduled, and processing queued messages", async () => {
    const processingResponse = await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-queue-00000001",
      validMessageBody({ to: "+218911111111" }),
    );
    const processingId = (processingResponse.json() as { data: { id: string } }).data.id;
    await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-queue-00000002",
      validMessageBody({ to: "+218922222222" }),
    );
    await postMessage(
      context.app,
      context.tenantA.rawApiKey,
      "idem-queue-00000003",
      validMessageBody({
        to: "+218933333333",
        scheduled_at: new Date(TEST_NOW.getTime() + 60 * 60 * 1000).toISOString(),
      }),
    );
    await postMessage(
      context.app,
      context.tenantB.rawApiKey,
      "idem-queue-00000004",
      validMessageBody({ to: "+218944444444" }),
    );
    await context.repository.claimMessageForDispatch({
      messageId: processingId,
      dispatchMinIntervalMs: 3_000,
      at: TEST_NOW,
    });

    const summary = await context.app.inject({
      method: "GET",
      url: "/v1/queue",
      headers: authHeaders(context.tenantA.rawApiKey),
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toEqual({
      data: {
        object: "queue_summary",
        queued_total: 3,
        ready: 1,
        scheduled: 1,
        processing: 1,
        oldest_queued_at: TEST_NOW.toISOString(),
      },
    });

    const tenantBSummary = await context.app.inject({
      method: "GET",
      url: "/v1/queue",
      headers: authHeaders(context.tenantB.rawApiKey),
    });
    expect(tenantBSummary.json()).toMatchObject({
      data: { queued_total: 1, ready: 1, scheduled: 0, processing: 0 },
    });
  });
});
