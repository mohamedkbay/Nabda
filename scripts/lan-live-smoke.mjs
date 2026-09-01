import { randomInt, randomUUID } from "node:crypto";

const baseUrl = (process.env.NBDA_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = process.env.NBDA_E2E_API_KEY || "";
const deviceToken = process.env.NBDA_DEVICE_TOKEN || "";
const deviceId = process.env.NBDA_DEVICE_ID || "";
const parsedBase = new URL(baseUrl);

if (!["localhost", "127.0.0.1", "::1"].includes(parsedBase.hostname)) {
  throw new Error("The LAN live smoke test only runs through a loopback API address.");
}
if (!apiKey.startsWith("nbda_live_")) throw new Error("A local nbda_live_ API key is required.");
if (!deviceToken.startsWith("nbda_device_")) throw new Error("A device token is required.");
if (!/^[0-9a-f-]{36}$/i.test(deviceId)) throw new Error("NBDA_DEVICE_ID must be a UUID.");

async function request(path, token, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(path === "/v1/messages" ? { "idempotency-key": randomUUID() } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

const heartbeat = await request("/v1/device/heartbeat", deviceToken, {
  app_version: "lan-live-smoke",
  android_version: "test-harness",
  simulated: false,
}, 200);
if (heartbeat.device_id !== deviceId || heartbeat.live_reporting_enabled !== true) {
  throw new Error("The live device boundary was not enabled for the expected device.");
}

const phone = `+21894${randomInt(1_000_000, 9_999_999)}`;
const created = await request("/v1/messages", apiKey, {
  device_id: deviceId,
  to: phone,
  content: "Nabda LAN wiring test. This message must be cancelled before begin.",
  purpose: "service",
  consent_confirmed: true,
  consent_reference: `lan-live-smoke-${randomUUID()}`,
  metadata: { source: "lan-live-smoke", dispatch_forbidden: true },
}, 202);
const messageId = created.data?.id;
if (!messageId || created.data.execution_mode !== "live") {
  throw new Error("The live API did not queue the smoke message.");
}

const claim = await request("/v1/device/messages/claim", deviceToken, {
  limit: 1,
  simulated: false,
}, 200);
if (claim.messages?.[0]?.id !== messageId) {
  throw new Error("The phone boundary did not claim the expected message.");
}

// Intentionally cancel before /begin. This verifies the live wiring without
// authorizing or performing any Android carrier operation.
const optOut = await request("/v1/opt-outs", apiKey, {
  phone,
  reason: "LAN live smoke cleanup before dispatch authorization",
}, 201);
if (!optOut.data?.cancelled_message_ids?.includes(messageId)) {
  throw new Error("The smoke message was not cancelled before dispatch.");
}

process.stdout.write(`LAN live smoke passed for ${messageId}: heartbeat → queued → claimed → cancelled before begin; no SMS authorized.\n`);
