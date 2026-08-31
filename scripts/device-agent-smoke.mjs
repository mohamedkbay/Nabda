import { randomInt, randomUUID } from "node:crypto";

const baseUrl = (process.env.NBDA_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = process.env.NBDA_E2E_API_KEY || "";
const deviceToken = process.env.NBDA_DEVICE_TOKEN || "";
const deviceId = process.env.NBDA_DEVICE_ID || "";

const parsedBase = new URL(baseUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(parsedBase.hostname)) {
  throw new Error("The Android simulation smoke test only runs against a loopback server.");
}
if (!apiKey.startsWith("nbda_test_")) {
  throw new Error("NBDA_E2E_API_KEY must be a local nbda_test_ key.");
}
if (!deviceToken.startsWith("nbda_device_")) {
  throw new Error("NBDA_DEVICE_TOKEN must be a local one-time device token.");
}
if (!/^[0-9a-f-]{36}$/i.test(deviceId)) {
  throw new Error("NBDA_DEVICE_ID must be a UUID.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function post(path, token, body, expectedStatus = 200, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

const healthResponse = await fetch(`${baseUrl}/health`);
const health = await healthResponse.json();
assert(healthResponse.ok && health.provider_mode === "mock", "The API must be healthy and locked to Mock mode.");

const heartbeat = await post("/v1/device/heartbeat", deviceToken, {
  app_version: "e2e-simulation",
  android_version: "test-harness",
  simulated: true,
});
assert(heartbeat.device_id === deviceId, "The device token did not resolve to the expected device.");
assert(heartbeat.live_reporting_enabled === false, "Live Android reporting must remain disabled in this smoke test.");

const suffix = String(randomInt(1_000_000, 9_999_999));
const created = await post("/v1/messages", apiKey, {
  device_id: deviceId,
  to: `+21894${suffix}`,
  content: "Nabda Android simulation test — no SMS is sent.",
  purpose: "service",
  consent_confirmed: true,
  consent_reference: `android-simulation-${randomUUID()}`,
  metadata: { source: "android-simulation-smoke" },
}, 202, { "idempotency-key": randomUUID() });
const messageId = created.data?.id;
assert(messageId, "The API did not return a message ID.");
assert(created.data.status === "queued", "The Android message was not queued.");

const claimed = await post("/v1/device/messages/claim", deviceToken, { limit: 1, simulated: true });
assert(claimed.messages?.length === 1, "The Android device did not claim exactly one message.");
assert(claimed.messages[0].id === messageId, "The device claimed an unexpected message.");
const leaseToken = claimed.messages[0].lease_token;
const attemptId = randomUUID();

const begun = await post(`/v1/device/messages/${messageId}/begin`, deviceToken, {
  lease_token: leaseToken,
  attempt_id: attemptId,
  simulated: true,
});
assert(begun.authorized === true && begun.duplicate === false, "The simulated attempt was not authorized once.");

const eventId = randomUUID();
const eventBody = {
  lease_token: leaseToken,
  attempt_id: attemptId,
  event_id: eventId,
  status: "sent",
  occurred_at: new Date().toISOString(),
  provider_message_id: `simulation_${randomUUID()}`,
  simulated: true,
};
const recorded = await post(`/v1/device/messages/${messageId}/events`, deviceToken, eventBody);
assert(recorded.accepted === true && recorded.duplicate === false, "The simulated event was not accepted once.");
assert(recorded.status === "cancelled" && recorded.failure_code === "simulation_only", "Simulation did not finish safely.");

const conflictingReplay = await post(`/v1/device/messages/${messageId}/events`, deviceToken, {
  ...eventBody,
  status: "failed",
  error_code: "mutated_replay_must_fail",
}, 409);
assert(conflictingReplay.error?.code === "device_event_conflict", "A mutated event replay was not rejected.");

const replayed = await post(`/v1/device/messages/${messageId}/events`, deviceToken, eventBody);
assert(replayed.accepted === true && replayed.duplicate === true, "The duplicate device event was not idempotent.");

const finalMessage = await get(`/v1/messages/${messageId}`);
assert(finalMessage.data.status === "cancelled", "The public message status is not cancelled.");
assert(finalMessage.data.failure?.code === "simulation_only", "The public result does not prove simulation-only handling.");

process.stdout.write(`Android simulation smoke passed for message ${messageId}: queued → claimed → authorized → cancelled/simulation_only; exact replay deduped and mutated replay rejected.\n`);
