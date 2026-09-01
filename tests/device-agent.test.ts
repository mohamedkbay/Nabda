import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceAgentPrincipal } from "../src/domain/types.js";
import { deviceLeaseDigest, generateDeviceToken } from "../src/lib/crypto.js";
import {
  createTestContext,
  HASH_SECRET,
  ORG_A_ID,
  ORG_B_ID,
  TEST_NOW,
  type TestContext,
  validMessageBody,
} from "./support/fixtures.js";

const AGENT_A_ID = "30000000-0000-4000-8000-000000000001";
const AGENT_B_ID = "30000000-0000-4000-8000-000000000002";
const CREDENTIAL_A_ID = "40000000-0000-4000-8000-000000000001";
const CREDENTIAL_B_ID = "40000000-0000-4000-8000-000000000002";

function seedAgent(
  context: TestContext,
  input: {
    organizationId: string;
    deviceId: string;
    credentialId: string;
    mode?: "simulation" | "live";
  },
) {
  const mode = input.mode ?? "simulation";
  const generated = generateDeviceToken(HASH_SECRET);
  context.repository.seedDevice({
    id: input.deviceId,
    organizationId: input.organizationId,
    active: true,
    provider: "android_agent",
    senderNumber: null,
    encryptedConfig: null,
  });
  context.repository.seedDeviceAgentCredential(generated.prefix, {
    credentialId: input.credentialId,
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    organizationStatus: "active",
    deviceStatus: "active",
    mode,
    tokenHash: generated.hash,
    revokedAt: null,
  });
  const principal: DeviceAgentPrincipal = {
    credentialId: input.credentialId,
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    organizationStatus: "active",
    deviceStatus: "active",
    mode,
  };
  return { rawToken: generated.rawToken, principal };
}

async function createAgentMessage(context: TestContext, idempotencyKey: string) {
  return context.app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: {
      "x-api-key": context.tenantA.rawApiKey,
      "idempotency-key": idempotencyKey,
    },
    payload: validMessageBody({ device_id: AGENT_A_ID }),
  });
}

async function createMockMessage(context: TestContext, idempotencyKey: string) {
  return context.app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: {
      "x-api-key": context.tenantA.rawApiKey,
      "idempotency-key": idempotencyKey,
    },
    payload: validMessageBody({ to: "+218912345679" }),
  });
}

function deviceHeaders(rawToken: string) {
  return { authorization: `Bearer ${rawToken}` };
}

describe("Android pull agent protocol", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    await context.app.close();
  });

  it("authenticates a domain-hashed device token and accepts minimal heartbeat telemetry", async () => {
    const agent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const missing = await context.app.inject({ method: "POST", url: "/v1/device/heartbeat", payload: {} });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: { code: "invalid_device_token" } });

    const heartbeat = await context.app.inject({
      method: "POST",
      url: "/v1/device/heartbeat",
      headers: deviceHeaders(agent.rawToken),
      payload: {
        app_version: "0.1.0",
        android_version: "15",
        simulated: true,
      },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toEqual({
      device_id: AGENT_A_ID,
      server_time: TEST_NOW.toISOString(),
      execution_mode: "simulation",
      live_reporting_enabled: false,
      poll_after_ms: 2_000,
    });

    const liveClaim = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agent.rawToken),
      payload: { limit: 1, simulated: false },
    });
    expect(liveClaim.statusCode).toBe(409);
    expect(liveClaim.json()).toMatchObject({
      error: { code: "device_mode_mismatch" },
    });
  });

  it("rejects a client mode mismatch at heartbeat, claim, begin, and event boundaries", async () => {
    const agent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const created = await createAgentMessage(context, "agent-mode-fence-0001");
    expect(created.statusCode).toBe(202);
    const messageId = created.json().data.id as string;

    const mismatchedHeartbeat = await context.app.inject({
      method: "POST",
      url: "/v1/device/heartbeat",
      headers: deviceHeaders(agent.rawToken),
      payload: { app_version: "0.1.0", android_version: "15", simulated: false },
    });
    expect(mismatchedHeartbeat.statusCode).toBe(409);
    expect(mismatchedHeartbeat.json()).toMatchObject({ error: { code: "device_mode_mismatch" } });

    const mismatchedClaim = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agent.rawToken),
      payload: { limit: 1, simulated: false },
    });
    expect(mismatchedClaim.statusCode).toBe(409);
    expect(context.repository.isProcessingMessage(messageId)).toBe(false);

    const claim = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agent.rawToken),
      payload: { limit: 1, simulated: true },
    });
    const leaseToken = claim.json().messages[0].lease_token as string;
    const attemptId = randomUUID();
    const mismatchedBegin = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: { lease_token: leaseToken, attempt_id: attemptId, simulated: false },
    });
    expect(mismatchedBegin.statusCode).toBe(409);
    expect(mismatchedBegin.json()).toMatchObject({ error: { code: "device_mode_mismatch" } });
    expect(context.repository.isProcessingMessage(messageId)).toBe(false);

    expect((await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: { lease_token: leaseToken, attempt_id: attemptId, simulated: true },
    })).statusCode).toBe(200);
    const mismatchedEvent = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/events`,
      headers: deviceHeaders(agent.rawToken),
      payload: {
        lease_token: leaseToken,
        attempt_id: attemptId,
        event_id: randomUUID(),
        status: "sent",
        simulated: false,
      },
    });
    expect(mismatchedEvent.statusCode).toBe(409);
    expect(mismatchedEvent.json()).toMatchObject({ error: { code: "device_mode_mismatch" } });
    expect((await context.repository.getMessage(ORG_A_ID, messageId))?.status).toBe("queued");
  });

  it("does not authenticate a live credential while the server live gate is off", async () => {
    const liveAgent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
      mode: "live",
    });
    const response = await context.app.inject({
      method: "POST",
      url: "/v1/device/heartbeat",
      headers: deviceHeaders(liveAgent.rawToken),
      payload: { app_version: "0.1.0-live", android_version: "15", simulated: false },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "invalid_device_token" } });
  });

  it("binds queued simulation work to its original mode after a credential rotation", async () => {
    const simulationAgent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const created = await createAgentMessage(context, "agent-queued-mode-0001");
    const messageId = created.json().data.id as string;
    const simulationClaim = await context.repository.claimDeviceAgentMessage({
      principal: simulationAgent.principal,
      leaseTokenHash: deviceLeaseDigest("simulation-lease-token-that-is-long-enough", HASH_SECRET),
      leaseExpiresAt: new Date(TEST_NOW.getTime() + 120_000),
      at: TEST_NOW,
    });
    expect(simulationClaim.kind).toBe("claimed");

    const liveAgent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: "40000000-0000-4000-8000-000000000003",
      mode: "live",
    });
    expect((await context.repository.claimDeviceAgentMessage({
      principal: liveAgent.principal,
      leaseTokenHash: deviceLeaseDigest("live-lease-token-that-is-long-enough", HASH_SECRET),
      leaseExpiresAt: new Date(TEST_NOW.getTime() + 120_000),
      at: TEST_NOW,
    })).kind).toBe("empty");
    expect((await context.repository.beginDeviceAgentMessage({
      principal: liveAgent.principal,
      messageId,
      attemptId: randomUUID(),
      leaseTokenHash: deviceLeaseDigest("simulation-lease-token-that-is-long-enough", HASH_SECRET),
      attemptLeaseExpiresAt: new Date(TEST_NOW.getTime() + 900_000),
      dispatchMinIntervalMs: 3_000,
      at: TEST_NOW,
    })).kind).toBe("not_found");
    expect((await context.repository.getMessage(ORG_A_ID, messageId))?.executionMode).toBe("simulation");
  });

  it.each(["agent_restart_unknown", "agent_dispatch_failed"] as const)(
    "quarantines a live %s outcome for manual review without retry",
    async (errorCode) => {
      await context.app.close();
      context = await createTestContext({ androidAgentLiveReportingEnabled: true });
      const liveAgent = seedAgent(context, {
        organizationId: ORG_A_ID,
        deviceId: AGENT_A_ID,
        credentialId: CREDENTIAL_A_ID,
        mode: "live",
      });
      const created = await createAgentMessage(context, `live-unknown-${errorCode}`);
      expect(created.statusCode).toBe(202);
      expect(created.json()).toMatchObject({ data: { execution_mode: "live" } });
      const messageId = created.json().data.id as string;

      const heartbeat = await context.app.inject({
        method: "POST",
        url: "/v1/device/heartbeat",
        headers: deviceHeaders(liveAgent.rawToken),
        payload: { app_version: "0.1.0-live", android_version: "15", simulated: false },
      });
      expect(heartbeat.statusCode).toBe(200);
      expect(heartbeat.json()).toMatchObject({ execution_mode: "live", live_reporting_enabled: true });

      const claim = await context.app.inject({
        method: "POST",
        url: "/v1/device/messages/claim",
        headers: deviceHeaders(liveAgent.rawToken),
        payload: { limit: 1, simulated: false },
      });
      expect(claim.statusCode).toBe(200);
      expect(claim.json()).toMatchObject({ messages: [{ id: messageId, execution_mode: "live" }] });
      const leaseToken = claim.json().messages[0].lease_token as string;
      const attemptId = randomUUID();
      expect((await context.app.inject({
        method: "POST",
        url: `/v1/device/messages/${messageId}/begin`,
        headers: deviceHeaders(liveAgent.rawToken),
        payload: { lease_token: leaseToken, attempt_id: attemptId, simulated: false },
      })).statusCode).toBe(200);

      const outcome = await context.app.inject({
        method: "POST",
        url: `/v1/device/messages/${messageId}/events`,
        headers: deviceHeaders(liveAgent.rawToken),
        payload: {
          lease_token: leaseToken,
          attempt_id: attemptId,
          event_id: randomUUID(),
          status: "failed",
          error_code: errorCode,
          error_message: "The carrier callback was not conclusive.",
          simulated: false,
        },
      });
      expect(outcome.statusCode).toBe(200);
      expect(outcome.json()).toMatchObject({
        status: "failed",
        failure_code: "provider_outcome_unknown",
      });
      expect(context.repository.isManualReviewMessage(messageId)).toBe(true);
      expect(await context.repository.getMessage(ORG_A_ID, messageId)).toMatchObject({
        status: "failed",
        executionMode: "live",
        failureCode: "provider_outcome_unknown",
      });

      const retryClaim = await context.app.inject({
        method: "POST",
        url: "/v1/device/messages/claim",
        headers: deviceHeaders(liveAgent.rawToken),
        payload: { limit: 1, simulated: false },
      });
      expect(retryClaim.statusCode).toBe(200);
      expect(retryClaim.json()).toEqual({ messages: [], poll_after_ms: 2_000 });
    },
  );

  it("requires reserve, fenced begin, then records an idempotent simulation without sending", async () => {
    const agent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const created = await createAgentMessage(context, "agent-flow-00000001");
    expect(created.statusCode).toBe(202);
    expect(context.repository.outboxJobs).toHaveLength(0);
    const messageId = created.json().data.id as string;

    const claim = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agent.rawToken),
      payload: { limit: 1, simulated: true },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({
      messages: [{ id: messageId, to: "+218912345678", body: "Your approved transaction was completed." }],
      poll_after_ms: 2_000,
    });
    const leaseToken = claim.json().messages[0].lease_token as string;
    const attemptId = randomUUID();
    const eventId = randomUUID();

    const prematureEvent = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/events`,
      headers: deviceHeaders(agent.rawToken),
      payload: {
        lease_token: leaseToken,
        attempt_id: attemptId,
        event_id: eventId,
        status: "sent",
        simulated: true,
      },
    });
    expect(prematureEvent.statusCode).toBe(409);
    expect(prematureEvent.json()).toMatchObject({ error: { code: "invalid_device_lease" } });

    const begin = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: { lease_token: leaseToken, attempt_id: attemptId, simulated: true },
    });
    expect(begin.statusCode).toBe(200);
    expect(begin.json()).toMatchObject({ authorized: true, duplicate: false, message_id: messageId });

    const duplicateBegin = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: { lease_token: leaseToken, attempt_id: attemptId, simulated: true },
    });
    expect(duplicateBegin.statusCode).toBe(200);
    expect(duplicateBegin.json()).toMatchObject({ authorized: true, duplicate: true });

    const eventPayload = {
      lease_token: leaseToken,
      attempt_id: attemptId,
      event_id: eventId,
      status: "sent",
      occurred_at: TEST_NOW.toISOString(),
      simulated: true,
    };
    const event = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/events`,
      headers: deviceHeaders(agent.rawToken),
      payload: eventPayload,
    });
    expect(event.statusCode).toBe(200);
    expect(event.json()).toEqual({
      accepted: true,
      duplicate: false,
      message_id: messageId,
      status: "cancelled",
      failure_code: "simulation_only",
    });

    const duplicateEvent = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/events`,
      headers: deviceHeaders(agent.rawToken),
      payload: eventPayload,
    });
    expect(duplicateEvent.statusCode).toBe(200);
    expect(duplicateEvent.json()).toMatchObject({ accepted: true, duplicate: true, status: "cancelled" });

    const mutatedReplay = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/events`,
      headers: deviceHeaders(agent.rawToken),
      payload: { ...eventPayload, status: "failed", error_code: "mutated" },
    });
    expect(mutatedReplay.statusCode).toBe(409);
    expect(mutatedReplay.json()).toMatchObject({ error: { code: "device_event_conflict" } });

    const publicMessage = await context.app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}`,
      headers: { "x-api-key": context.tenantA.rawApiKey },
    });
    expect(publicMessage.json()).toMatchObject({
      data: {
        status: "cancelled",
        execution_mode: "simulation",
        failure: { code: "simulation_only" },
      },
    });
  });

  it("re-checks opt-out under the begin fence and refuses a previously reserved message", async () => {
    const agent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const created = await createAgentMessage(context, "agent-optout-0000001");
    const messageId = created.json().data.id as string;
    const claim = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agent.rawToken),
      payload: { limit: 1, simulated: true },
    });
    const leaseToken = claim.json().messages[0].lease_token as string;

    const optOut = await context.app.inject({
      method: "POST",
      url: "/v1/opt-outs",
      headers: { "x-api-key": context.tenantA.rawApiKey },
      payload: { phone: "+218912345678", reason: "recipient request" },
    });
    expect(optOut.statusCode).toBe(201);

    const begin = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: { lease_token: leaseToken, attempt_id: randomUUID(), simulated: true },
    });
    expect(begin.statusCode).toBe(409);
    expect(begin.json()).toMatchObject({
      error: {
        code: "message_not_dispatchable",
        details: { status: "cancelled", failure_code: "recipient_opted_out" },
      },
    });
  });

  it("re-runs safety checks before acknowledging a duplicate begin response", async () => {
    const agent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const created = await createAgentMessage(context, "agent-begin-retry-001");
    const messageId = created.json().data.id as string;
    const claim = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agent.rawToken),
      payload: { limit: 1, simulated: true },
    });
    const leaseToken = claim.json().messages[0].lease_token as string;
    const attemptId = randomUUID();
    const beginBody = { lease_token: leaseToken, attempt_id: attemptId, simulated: true };
    expect((await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: beginBody,
    })).statusCode).toBe(200);

    const optOut = await context.app.inject({
      method: "POST",
      url: "/v1/opt-outs",
      headers: { "x-api-key": context.tenantA.rawApiKey },
      payload: { phone: "+218912345678", reason: "arrived after lost begin response" },
    });
    expect(optOut.statusCode).toBe(201);
    expect(optOut.json().data.cancelled_message_ids).toEqual([]);

    const retriedBegin = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${messageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: beginBody,
    });
    expect(retriedBegin.statusCode).toBe(409);
    expect(retriedBegin.json()).toMatchObject({
      error: {
        code: "message_not_dispatchable",
        details: { status: "cancelled", failure_code: "recipient_opted_out" },
      },
    });
    expect(context.repository.isProcessingMessage(messageId)).toBe(false);
  });

  it("shares the organization fence from Android begin to a normal worker claim", async () => {
    const agent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const agentMessage = await createAgentMessage(context, "agent-cross-fence-001");
    const mockMessage = await createMockMessage(context, "worker-cross-fence-01");
    const agentMessageId = agentMessage.json().data.id as string;
    const mockMessageId = mockMessage.json().data.id as string;
    const claim = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agent.rawToken),
      payload: { limit: 1, simulated: true },
    });
    const leaseToken = claim.json().messages[0].lease_token as string;
    expect((await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${agentMessageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: { lease_token: leaseToken, attempt_id: randomUUID(), simulated: true },
    })).statusCode).toBe(200);

    const workerAtSameTime = await context.repository.claimMessageForDispatch({
      messageId: mockMessageId,
      dispatchMinIntervalMs: 3_000,
      at: TEST_NOW,
    });
    expect(workerAtSameTime).toEqual({
      kind: "rate_limited",
      retryAt: new Date(TEST_NOW.getTime() + 6_000),
    });
    expect(context.repository.isProcessingMessage(mockMessageId)).toBe(false);

    const workerAfterInterval = await context.repository.claimMessageForDispatch({
      messageId: mockMessageId,
      dispatchMinIntervalMs: 3_000,
      at: new Date(TEST_NOW.getTime() + 6_000),
    });
    expect(workerAfterInterval.kind).toBe("claimed");
    expect(context.repository.isProcessingMessage(mockMessageId)).toBe(true);
  });

  it("shares the organization fence from a normal worker claim to Android begin", async () => {
    const agent = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const mockMessage = await createMockMessage(context, "worker-cross-fence-02");
    const agentMessage = await createAgentMessage(context, "agent-cross-fence-002");
    const mockMessageId = mockMessage.json().data.id as string;
    const agentMessageId = agentMessage.json().data.id as string;
    expect((await context.repository.claimMessageForDispatch({
      messageId: mockMessageId,
      dispatchMinIntervalMs: 3_000,
      at: TEST_NOW,
    })).kind).toBe("claimed");

    const claim = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agent.rawToken),
      payload: { limit: 1, simulated: true },
    });
    const leaseToken = claim.json().messages[0].lease_token as string;
    const attemptId = randomUUID();
    const throttled = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${agentMessageId}/begin`,
      headers: deviceHeaders(agent.rawToken),
      payload: { lease_token: leaseToken, attempt_id: attemptId, simulated: true },
    });
    expect(throttled.statusCode).toBe(429);
    expect(context.repository.isProcessingMessage(agentMessageId)).toBe(false);

    const begun = await context.repository.beginDeviceAgentMessage({
      principal: agent.principal,
      messageId: agentMessageId,
      attemptId,
      leaseTokenHash: deviceLeaseDigest(leaseToken, HASH_SECRET),
      attemptLeaseExpiresAt: new Date(TEST_NOW.getTime() + 21 * 60 * 1000),
      dispatchMinIntervalMs: 3_000,
      at: new Date(TEST_NOW.getTime() + 6_000),
    });
    expect(begun.kind).toBe("authorized");
    expect(context.repository.isProcessingMessage(agentMessageId)).toBe(true);
  });

  it("binds messages to one tenant/device, expires reservations, and enforces the dispatch interval", async () => {
    const agentA = seedAgent(context, {
      organizationId: ORG_A_ID,
      deviceId: AGENT_A_ID,
      credentialId: CREDENTIAL_A_ID,
    });
    const agentB = seedAgent(context, {
      organizationId: ORG_B_ID,
      deviceId: AGENT_B_ID,
      credentialId: CREDENTIAL_B_ID,
    });
    const first = await createAgentMessage(context, "agent-rate-000000001");
    const second = await createAgentMessage(context, "agent-rate-000000002");
    const firstId = first.json().data.id as string;

    const claimFirst = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agentA.rawToken),
      payload: { limit: 1, simulated: true },
    });
    const firstLease = claimFirst.json().messages[0].lease_token as string;
    const firstAttempt = randomUUID();
    expect((await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${firstId}/begin`,
      headers: deviceHeaders(agentA.rawToken),
      payload: { lease_token: firstLease, attempt_id: firstAttempt, simulated: true },
    })).statusCode).toBe(200);

    const foreignEvent = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${firstId}/events`,
      headers: deviceHeaders(agentB.rawToken),
      payload: {
        lease_token: firstLease,
        attempt_id: firstAttempt,
        event_id: randomUUID(),
        status: "sent",
        simulated: true,
      },
    });
    expect(foreignEvent.statusCode).toBe(404);

    expect((await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${firstId}/events`,
      headers: deviceHeaders(agentA.rawToken),
      payload: {
        lease_token: firstLease,
        attempt_id: firstAttempt,
        event_id: randomUUID(),
        status: "sent",
        simulated: true,
      },
    })).statusCode).toBe(200);

    const claimSecond = await context.app.inject({
      method: "POST",
      url: "/v1/device/messages/claim",
      headers: deviceHeaders(agentA.rawToken),
      payload: { limit: 1, simulated: true },
    });
    expect(claimSecond.json().messages[0].id).toBe(second.json().data.id);
    const throttled = await context.app.inject({
      method: "POST",
      url: `/v1/device/messages/${second.json().data.id as string}/begin`,
      headers: deviceHeaders(agentA.rawToken),
      payload: {
        lease_token: claimSecond.json().messages[0].lease_token,
        attempt_id: randomUUID(),
        simulated: true,
      },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({ error: { code: "rate_limited" } });

    const expiredClaim = await context.repository.claimDeviceAgentMessage({
      principal: agentA.principal,
      leaseTokenHash: deviceLeaseDigest("unused-lease-token-that-is-long-enough", HASH_SECRET),
      leaseExpiresAt: new Date(TEST_NOW.getTime() + 121_000),
      at: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000 + 1),
    });
    expect(expiredClaim.kind).toBe("empty");
  });
});
