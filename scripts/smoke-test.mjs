import { randomInt, randomUUID } from "node:crypto";

const baseUrl = (process.env.NBDA_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = process.env.NBDA_E2E_API_KEY;

const parsedBaseUrl = new URL(baseUrl);
const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
if (parsedBaseUrl.protocol !== "http:" || !loopbackHosts.has(parsedBaseUrl.hostname) || parsedBaseUrl.username || parsedBaseUrl.password) {
  throw new Error("The smoke test only connects to a local HTTP loopback server.");
}

if (!apiKey) {
  throw new Error("NBDA_E2E_API_KEY is required. Use a development key created by npm run db:seed.");
}
if (!apiKey.startsWith("nbda_test_")) {
  throw new Error("The smoke test only accepts nbda_test_ development keys.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}, expectedStatuses = [200], authenticated = true) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(authenticated ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const raw = await response.text();
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${options.method || "GET"} ${path} returned ${response.status}: ${raw.slice(0, 500)}`);
  }
  return { response, body };
}

async function waitForMessage(messageId, statuses, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await request(`/v1/messages/${messageId}`);
    if (statuses.includes(body.data.status)) return body.data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Message ${messageId} did not reach ${statuses.join(" or ")} within ${timeoutMs} ms.`);
}

const suffix = String(randomInt(1_000_000, 9_999_999));
const immediatePhone = `+21891${suffix}`;
const scheduledPhone = `+21892${suffix}`;

const health = await request("/health", {}, [200], false);
assert(health.body?.provider_mode === "mock", "Smoke test refused to run because the API is not in Mock provider mode.");
await request("/health/live", {}, [200], false);
await request("/health/ready", {}, [200], false);

const createdContact = await request("/v1/contacts", {
  method: "POST",
  body: JSON.stringify({
    name: "Smoke Test Contact",
    phone: immediatePhone,
    consent_reference: `smoke-consent-${randomUUID()}`,
    tags: ["smoke-test"],
    metadata: { source: "local-smoke-test" },
  }),
}, [201]);
const contactId = createdContact.body.data.id;

const updatedContact = await request("/v1/contacts", {
  method: "POST",
  body: JSON.stringify({
    name: "Updated Smoke Contact",
    phone: immediatePhone,
    tags: ["smoke-test", "updated"],
    metadata: {},
  }),
}, [200]);
assert(updatedContact.body.data.id === contactId, "Contact upsert created a duplicate resource.");

const contactPage = await request("/v1/contacts?limit=100");
assert(contactPage.body.data.some((contact) => contact.id === contactId), "Created contact was not listed.");

const immediateMessage = await request("/v1/messages", {
  method: "POST",
  headers: { "idempotency-key": randomUUID() },
  body: JSON.stringify({
    to: immediatePhone,
    content: "Local Mock smoke test — no SMS is sent.",
    purpose: "service",
    consent_confirmed: true,
    consent_reference: `smoke-consent-${randomUUID()}`,
    metadata: { source: "local-smoke-test" },
  }),
}, [202]);
await waitForMessage(immediateMessage.body.data.id, ["sent", "delivered"]);

const scheduledAt = new Date(Date.now() + 5 * 60_000);
const scheduledMessage = await request("/v1/messages", {
  method: "POST",
  headers: { "idempotency-key": randomUUID() },
  body: JSON.stringify({
    to: scheduledPhone,
    content: "Scheduled local Mock smoke test — no SMS is sent.",
    purpose: "service",
    consent_confirmed: true,
    consent_reference: `smoke-consent-${randomUUID()}`,
    scheduled_at: scheduledAt.toISOString(),
    expires_at: new Date(scheduledAt.getTime() + 60 * 60_000).toISOString(),
    metadata: { source: "local-smoke-test" },
  }),
}, [202]);

const queue = await request("/v1/queue");
assert(queue.body.data.scheduled >= 1, "Queue summary did not report the scheduled message.");

const optOut = await request("/v1/opt-outs", {
  method: "POST",
  body: JSON.stringify({ phone: scheduledPhone, reason: "Local smoke-test cleanup" }),
}, [201]);
assert(optOut.body.data.cancelled_message_ids.includes(scheduledMessage.body.data.id), "Opt-out did not cancel the scheduled message.");
await waitForMessage(scheduledMessage.body.data.id, ["cancelled"]);

await request("/v1/usage");
await request(`/v1/contacts/${contactId}`, { method: "DELETE" }, [204]);
const contactsAfterDelete = await request("/v1/contacts?limit=100");
assert(!contactsAfterDelete.body.data.some((contact) => contact.id === contactId), "Deleted contact is still visible.");

process.stdout.write("Smoke test passed: health, contacts, Mock dispatch, queue, opt-out cancellation, and usage.\n");
