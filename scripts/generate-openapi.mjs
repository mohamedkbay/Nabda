import fs from "node:fs/promises";
import path from "node:path";

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!["--hosting", "--api-origin", "--output"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("Invalid OpenAPI generator arguments.");
  options[args[i]] = args[i + 1];
}
const independent = (options["--hosting"] ?? "independent") === "independent";
if (options["--hosting"] && !["sites", "independent"].includes(options["--hosting"])) throw new Error("Unknown hosting profile.");

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (description, extra = {}) => ({ type: "string", ...(description ? { description } : {}), ...extra });
const integer = (description, extra = {}) => ({ type: "integer", minimum: 0, ...(description ? { description } : {}), ...extra });
const nullable = (type, extra = {}) => ({ type: [type, "null"], ...extra });
const timestamp = str(null, { format: "date-time" });
const nullableTime = nullable("string", { format: "date-time" });
const object = (properties, required = Object.keys(properties), extra = {}) => ({ type: "object", properties, required, ...extra });
const array = (items, extra = {}) => ({ type: "array", items, ...extra });
const json = (schema) => ({ "application/json": { schema } });
const response = (description, schema) => ({ description, content: json(typeof schema === "string" ? ref(schema) : schema) });
const errorResponses = (codes) => Object.fromEntries(codes.map((code) => [String(code), response({ 400: "Invalid JSON or request.", 401: "Missing, invalid, expired or revoked credential.", 403: "Cross-origin management mutation rejected.", 404: "Resource not found in this account or phone.", 409: "Conflicting request or resource state.", 413: "Request body exceeds 131,072 bytes.", 415: "Content-Type must be application/json.", 422: "Request fields are invalid.", 429: "Workspace resource allowance reached.", 500: "Unexpected server error. Never contains SQL, credentials or message contents.", 503: "Account database is not available." }[code], "Error")]));
const body = (schema) => ({ required: true, content: json(typeof schema === "string" ? ref(schema) : schema) });
const pathId = { name: "id", in: "path", required: true, schema: str(null, { maxLength: 100 }), description: "Resource ID returned by Nabda; it must belong to the current workspace." };
const management = [{ SitesBrowserSession: [] }];
const application = [{ ApplicationKey: [] }];
const device = [{ DeviceToken: [] }];
const statuses = ["accepted", "on_device", "queued", "processing", "sent", "delivered", "failed", "cancelled", "expired", "outcome_unknown"];
const eventStatuses = ["queued", "processing", "sent", "delivered", "failed", "cancelled", "expired", "outcome_unknown"];

const schemas = {
  Error: object({ error: object({ code: str("Stable machine-readable error code."), message: str("A readable explanation and recovery hint.") }) }),
  Health: object({ status: { const: "ok" }, mode: { const: "phone-owned" }, version: str() }),
  Message: object({
    id: str(), status: str("sent and delivered are reports from the phone, not independent carrier attestations. Missing reports do not establish failure.", { enum: statuses }),
    device_id: str(), sandbox: { type: "boolean", description: "A sandbox command must never invoke the phone's SmsManager." },
    created_at: timestamp, updated_at: timestamp, send_at: timestamp, expires_at: timestamp, handed_off_at: nullableTime,
    cancellation_requested: { type: "boolean", description: "The phone may not have received or completed this request yet." },
    parts_total: nullable("integer", { minimum: 1, maximum: 100 }), parts_sent: nullable("integer", { minimum: 0, maximum: 100 }), parts_delivered: nullable("integer", { minimum: 0, maximum: 100 }),
    failure_code: nullable("string"),
  }),
  MessageCreate: object({
    device_id: str("An active phone in the authenticated workspace.", { minLength: 1, maxLength: 80 }),
    to: str("International E.164 or Libyan mobile local form. Arabic digits, spaces, parentheses and ASCII hyphens are normalized.", { minLength: 1, maxLength: 40 }),
    content: str("Preserved exactly, including whitespace. Must contain a non-whitespace character. The implementation checks at most 4,000 UTF-16 code units; emoji may consume two units.", { minLength: 1, maxLength: 4000, "x-max-utf16-code-units": 4000 }),
    sandbox: { type: "boolean", default: false, description: "Set true for protocol testing without real SMS. This flag is durably included in the phone command." },
    send_at: { ...timestamp, description: "Optional start time, including timezone. At most 30 days ahead; a past time becomes immediately eligible. Scheduling is executed on the phone." },
    expires_at: { ...timestamp, description: "Latest permitted start time, including timezone. Must be later than send_at and now, within 31 days. Defaults to 24 hours after the later of now or send_at. This is not a recall deadline for an already submitted SMS." },
  }, ["device_id", "to", "content"]),
  Cancellation: object({ id: str(), status: str(null, { enum: statuses }), cancellation_requested: { const: true }, guaranteed: { type: "boolean", description: "True only when cancelled before durable phone handoff. After handoff, wait for the phone's result." }, note: str() }, ["id", "status", "cancellation_requested", "guaranteed"]),
  Usage: object({
    day_utc: str(null, { format: "date" }), accepted_commands: integer("New accepted platform commands today. This is not a count of successfully transmitted SMS."),
    reported_sent_messages: integer("Messages created today with sent/delivered status reported by the phone."), reported_sent_parts: integer("Sum of reported sent parts for those messages."),
    pending_handoffs: integer("Unacknowledged, unexpired cloud commands."), active_devices: integer(), carrier_cost: { type: "null", description: "The API cannot infer the mobile carrier's bill." },
    source: { const: "device_reported" }, limits: object({ new_messages_per_day: { const: 1000 }, pending_handoffs: { const: 500 } }),
  }),
  Device: object({
    id: str(), name: str(), status: str(null, { enum: ["active", "revoked"] }), ready: { type: "boolean" }, permission_granted: { type: "boolean" }, sim_selected: { type: "boolean" },
    app_version: nullable("string"), android_version: nullable("string"), last_seen_at: nullableTime, created_at: timestamp,
    connected: { type: "boolean", description: "Active credential with a heartbeat younger than 180 seconds. Connected does not by itself establish SMS readiness." },
  }),
  KeySummary: object({ id: str(), name: str(), prefix: str("Display prefix only; the secret cannot be recovered."), created_at: timestamp, revoked_at: nullableTime }),
  KeyCreated: object({ id: str(), name: str(), key: str("Shown once. Keep it on your server; do not embed it in browser code.", { pattern: "^nb_app_[a-f0-9]{64}$", writeOnly: false }), created_at: timestamp }),
  PairingCreated: object({
    pairing_token: str("Single-use token valid for ten minutes; keep the QR private.", { pattern: "^nb_pair_[a-f0-9]{64}$" }),
    expires_at: timestamp,
    qr: object({ version: { const: 1 }, server_url: str(null, { format: "uri" }), pairing_token: str() }),
    pairing_url: str("Android deep link using nabda://pair?server=...&token=...", { format: "uri" }),
  }),
  Account: object({
    organization: object({ id: str(), name: str(), created_at: timestamp }), user: object({ name: str(), email: str(null, { format: "email" }) }),
    devices: array(ref("Device")), keys: array(ref("KeySummary")), usage: ref("Usage"), version: str(),
  }),
  MessagePage: object({
    messages: array(ref("Message")), counts: { type: "object", additionalProperties: integer(), description: "Counts across all messages in this workspace, not just this page." },
    as_of: timestamp, next_cursor: nullable("string", { description: "Opaque continuation cursor, or null. It preserves creation order, not a snapshot of mutable message status." }),
  }),
  DevicePair: object({
    pairing_token: str(null, { pattern: "^nb_pair_[a-f0-9]{64}$" }), name: str(null, { minLength: 1, maxLength: 80 }),
    app_version: str(null, { maxLength: 80 }), android_version: str(null, { maxLength: 80 }),
  }, ["pairing_token"]),
  DevicePaired: object({ device_id: str(), device_token: str("Shown once; protect with Android Keystore. This token cannot create application messages.", { pattern: "^nb_device_[a-f0-9]{64}$" }), server_url: str(null, { format: "uri" }), poll_after_ms: { const: 60000 } }),
  DevicePoll: object({ ready: { type: "boolean" }, permission_granted: { type: "boolean" }, sim_selected: { type: "boolean" }, app_version: str(null, { maxLength: 80 }), android_version: str(null, { maxLength: 80 }) }, ["ready", "permission_granted", "sim_selected"]),
  Command: object({
    id: str(), type: str(null, { enum: ["message.send", "message.cancel"] }), message_id: str(),
    payload: object({ to: str(), content: str(), send_at: timestamp, expires_at: timestamp, sandbox: { type: "boolean" } }, [], { description: "message.send includes all fields; message.cancel uses an empty object. The phone must durably stage this before ACK and must not submit SMS until ACK approves the command ID." }),
  }),
  PollResult: object({ commands: array(ref("Command"), { maxItems: 25 }), poll_after_ms: { const: 60000 }, server_time: timestamp }),
  DeviceAck: object({ command_ids: array(str(null, { maxLength: 100 }), { minItems: 1, maxItems: 100 }) }),
  AckResult: object({ acknowledged: array(str()), rejected: array(object({ id: str(), reason: str(null, { enum: ["cancelled", "expired", "not_found"] }) })) }),
  DeviceEvent: object({
    event_id: str("Stable per-device ID. Retries must use identical event contents.", { minLength: 1, maxLength: 100 }),
    message_id: str(null, { minLength: 1, maxLength: 80 }), status: str(null, { enum: eventStatuses }), occurred_at: timestamp,
    parts_total: integer("When provided, must be 1–100 and cannot change after first reported.", { minimum: 1, maximum: 100 }),
    parts_sent: integer("Requires parts_total and must not exceed it.", { maximum: 100 }),
    parts_delivered: integer("Requires parts_total and parts_sent; cannot exceed parts_sent.", { maximum: 100 }),
    failure_code: str("Symbolic diagnostic only. Do not include SMS text or recipient data.", { maxLength: 80, pattern: "^[A-Za-z0-9_.:-]+$" }),
  }, ["event_id", "message_id", "status", "occurred_at"], { description: "sent requires parts_sent=parts_total; delivered requires all three part counters equal. A missing delivery report is not proof of failure. outcome_unknown must not trigger blind resubmission." }),
  EventBatch: object({ events: array(ref("DeviceEvent"), { minItems: 1, maxItems: 100 }) }),
  EventReceipt: object({ accepted: array(str(), { description: "Only these events may be removed from the phone's durable outbound-event queue." }) }),
};

const managementOperation = (summary, extra) => ({ tags: ["Account management"], summary, security: management, "x-platform-browser-session-required": true, description: "Requires a signed-in Sites browser session. The platform supplies identity after authentication. Do not send or trust user-chosen oai-authenticated-* headers. This is a dashboard endpoint, not an application-key endpoint.", ...extra });
const deviceOperation = (summary, extra) => ({ tags: ["Android device"], summary, security: device, ...extra });
const messageParameters = [pathId];

const paths = {
  "/health": { get: { tags: ["Service"], summary: "Check the control-plane process", description: "A successful response does not prove a phone is connected or an SMS was delivered.", security: [], responses: { 200: response("Control plane is responding.", "Health") } } },
  "/v1/messages": { post: {
    tags: ["Messages"], summary: "Accept one message command for a linked phone", security: application,
    description: "Returns 202 only after durable cloud acceptance. The phone owns execution after handoff. Temporary recipient/text storage is purged after successful ACK. Sending is asynchronous; this response is not a send or delivery confirmation. At most 1,000 new commands/workspace/UTC day and 500 pending handoffs. No carrier cost is included. Use sandbox=true for tests.",
    parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: str(null, { minLength: 8, maxLength: 128, pattern: "^[\\x21-\\x7e]{8,128}$" }), description: "Stable key scoped to the workspace and operation, including across API-key rotation. Same normalized payload returns the same resource; changed payload returns 409. Retries do not resubmit SMS." }],
    requestBody: body("MessageCreate"), responses: { 202: response("Durably accepted, or the same resource returned for an idempotent retry. Current status may have advanced.", "Message"), ...errorResponses([400, 401, 404, 409, 413, 415, 422, 429, 500, 503]) },
  } },
  "/v1/messages/{id}": { get: { tags: ["Messages"], summary: "Read message metadata and phone-reported outcome", security: application, parameters: messageParameters, description: "Returns only this workspace's message. It does not return the SMS text or recipient; those belong to the phone after handoff.", responses: { 200: response("Message metadata.", "Message"), ...errorResponses([401, 404, 500, 503]) } } },
  "/v1/messages/{id}/cancellations": { post: { tags: ["Messages"], summary: "Cancel before handoff or ask the phone to cancel", security: application, parameters: messageParameters, description: "Before ACK, cancellation atomically prevents phone authorization. After handoff, cancellation_requested means a command is waiting for the phone; it is not a guarantee that an already submitting SMS can be stopped. Sent SMS cannot be recalled.", responses: { 200: response("Cancellation result or request.", "Cancellation"), ...errorResponses([401, 404, 409, 500, 503]) } } },
  "/v1/usage": { get: { tags: ["Messages"], summary: "Read workspace command usage", security: application, responses: { 200: response("Platform counters, separate from the SIM/carrier bill.", "Usage"), ...errorResponses([401, 500, 503]) } } },
  "/v1/device/pair": { post: {
    tags: ["Android device"], summary: "Consume a one-time pairing token", security: [], description: "The token is created by a signed-in workspace owner. Pairing consumes it atomically and returns an independently scoped phone credential. A used/expired token cannot pair another device.", requestBody: body("DevicePair"),
    responses: { 201: response("Phone linked; protect the returned credential.", "DevicePaired"), ...errorResponses([400, 401, 413, 415, 422, 500, 503]) },
  } },
  "/v1/device/poll": { post: deviceOperation("Fetch commands to stage in the phone database", {
    description: "An active phone receives at most 25 unacknowledged commands. Commands may repeat. Persist each command transactionally before ACK; polling does not authorize SMS. Cancel commands are prioritized. Expired unhanded commands are marked expired and their payloads removed during polling. Baseline idle interval is 60 seconds; FCM push is not configured by this API.",
    requestBody: body("DevicePoll"), responses: { 200: response("Pending durable handoffs.", "PollResult"), ...errorResponses([400, 401, 413, 415, 422, 500, 503]) },
  }) },
  "/v1/device/ack": { post: deviceOperation("Acknowledge durable storage and request execution handoff", {
    description: "Call only after SQLite commit on the phone. Only IDs returned in acknowledged may become execution-eligible. Cancellation/expiry between poll and ACK rejects that send. A legitimate earlier ACK repeats idempotently if its response was lost. Handoff clears cloud recipient/text. Acknowledging a cancellation command records receipt, not successful cancellation.",
    requestBody: body("DeviceAck"), responses: { 200: response("Explicit per-command approval or rejection.", "AckResult"), ...errorResponses([400, 401, 413, 415, 422, 500, 503]) },
  }) },
  "/v1/device/events": { post: deviceOperation("Upload durable execution events", {
    description: "The message must already be handed off. Retransmit the same event ID and contents until it appears in accepted. Conflicting reuse, including within a batch, is rejected. Status is merged monotonically; stale queued events cannot regress sent/delivered. Late results may resolve outcome_unknown. The endpoint reports device claims, not independently verified carrier delivery.",
    requestBody: body("EventBatch"), responses: { 200: response("Events stored or already stored identically.", "EventReceipt"), ...errorResponses([400, 401, 404, 409, 413, 415, 422, 500, 503]) },
  }) },
  "/api/account": { get: managementOperation("Read or initialize the signed-in owner's workspace", { responses: { 200: response("Workspace, current user, phones, nonsecret key summaries and usage.", "Account"), ...errorResponses([401, 500, 503]) } }) },
  "/api/keys": { post: managementOperation("Create an application API key", { requestBody: body(object({ name: str(null, { minLength: 1, maxLength: 80 }) })), responses: { 201: response("New secret, shown only once. At most 20 active application keys/workspace.", "KeyCreated"), ...errorResponses([400, 401, 403, 413, 415, 422, 429, 500, 503]) } }) },
  "/api/keys/{id}": { delete: managementOperation("Revoke an application API key", { parameters: [pathId], responses: { 200: response("Key revoked.", object({ revoked: { const: true } })), ...errorResponses([401, 403, 404, 500, 503]) } }) },
  "/api/pairings": { post: managementOperation("Create a private QR/deep-link pairing token", { requestBody: body(object({ name: str(null, { minLength: 1, maxLength: 80 }) }, [])), responses: { 201: response("Single-use token lasting ten minutes. At most five simultaneously valid codes/workspace.", "PairingCreated"), ...errorResponses([400, 401, 403, 413, 415, 422, 429, 500, 503]) } }) },
  "/api/devices": { get: managementOperation("List workspace phones", { responses: { 200: response("Phones and their readiness metadata; no token hashes.", object({ devices: array(ref("Device")) })), ...errorResponses([401, 500, 503]) } }) },
  "/api/devices/{id}": { delete: managementOperation("Revoke a phone's cloud credential", { parameters: [pathId], description: "Requires the authenticated owner's Sites session. Revocation blocks future cloud requests and clears pending cloud payloads. It cannot instantly stop work already handed off to an offline phone; stop that queue on the phone.", responses: { 200: response("Phone credential revoked.", object({ revoked: { const: true }, note: str() })), ...errorResponses([401, 403, 404, 500, 503]) } }) },
  "/api/messages": { get: managementOperation("Read a page of workspace message metadata", { parameters: [{ name: "limit", in: "query", schema: integer(null, { minimum: 1, maximum: 100, default: 30 }) }, { name: "cursor", in: "query", schema: str("Opaque next_cursor from the previous page.") }], responses: { 200: response("Stable creation-order page plus independent whole-workspace status counts.", "MessagePage"), ...errorResponses([401, 422, 500, 503]) } }) },
  "/api/messages/{id}/cancel": { post: managementOperation("Cancel from the dashboard", { parameters: [pathId], responses: { 200: response("Same handoff-aware cancellation semantics as the application API.", "Cancellation"), ...errorResponses([401, 403, 404, 409, 500, 503]) } }) },
};

const document = {
  openapi: "3.1.0",
  info: { title: "Nabda — phone-owned SMS API", version: "0.2.0", description: "Nabda delivers a command to your own Android phone; the phone stores its queue and sends through your SIM. This specification describes the implemented free-edition control plane. It does not offer a carrier transport service, webhook delivery endpoint, push configuration API or bulk/campaign endpoint. A 202 response means accepted, not sent or delivered. Platform quotas differ from Android throughput and SIM costs. Bodies are limited to 131,072 bytes. Management routes use Sites browser identity; third-party apps and phones use different Bearer credentials." },
  servers: [{ url: "https://nabda-phone-api.mohamed-kbay.chatgpt.site", description: "Hosted Nabda API" }],
  tags: [{ name: "Messages", description: "Server-to-server application API. Keep application secrets out of frontend bundles." }, { name: "Android device", description: "Protocol for the paired phone and its durable SQLite queue." }, { name: "Account management", description: "Dashboard/browser endpoints authenticated by Sites dispatch. Not accessible with an application API key." }, { name: "Service" }],
  security: application,
  paths,
  components: {
    securitySchemes: {
      ApplicationKey: { type: "http", scheme: "bearer", bearerFormat: "nb_app_<64 hexadecimal characters>", description: "Workspace application key, issued once by the dashboard and stored as a SHA-256 verifier. Cannot poll or impersonate a phone." },
      DeviceToken: { type: "http", scheme: "bearer", bearerFormat: "nb_device_<64 hexadecimal characters>", description: "Phone-only token returned by pairing. Cannot create messages or manage a workspace." },
      SitesBrowserSession: { type: "apiKey", in: "header", name: "Cookie", description: "Opaque browser session cookies managed by Sites, not a Nabda application key. Use normal top-level navigation to /signin-with-chatgpt?return_to=/dashboard; do not manufacture cookies or identity headers. Sites dispatch authenticates the session and supplies trusted identity headers to the Worker. No standalone OAuth/token endpoint is implemented in Nabda." },
    },
    schemas,
  },
  "x-privacy": { cloud_payload: "Recipient and content are temporary command data until successful durable-phone ACK; they are then permanently removed from the cloud command. Message metadata and hashes remain.", expiry_cleanup: "Expired commands are cleaned when the phone polls. This edition does not claim an exact scheduled deletion deadline.", phone_owned: "SQLite owns recipient, body, queue, attempt and part history. No automatic lost-phone backup/restore is implemented." },
  "x-transport": { baseline_poll_interval_ms: 60000, push_configured: false, webhook_delivery_implemented: false, outcome_source: "device_reported" },
};

// Every operation receives a stable ID and a bounded JSON-only response contract.
for (const [path, methods] of Object.entries(paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    operation.operationId = method + path.replace(/\{([^}]+)\}/g, "by-$1").replace(/[^a-zA-Z0-9]+/g, "_");
  }
}
if (independent) {
  const url = new URL(options["--api-origin"] ?? "https://api.example.invalid");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Set --api-origin to an HTTPS origin (HTTP only for loopback).");
  document.servers = [{ url: url.origin, description: "Independent Nabda API on Cloudflare Workers" }];
  document.info.description = document.info.description.replace("Management routes use Sites browser identity", "Management routes use a verified GitHub sign-in and a Nabda browser session");
  document.tags.find((tag) => tag.name === "Account management").description = "Dashboard endpoints authenticated by a verified Nabda browser session on the API origin. Not accessible with an application API key.";
  delete document.components.securitySchemes.SitesBrowserSession;
  document.components.securitySchemes.NabdaBrowserSession = { type: "apiKey", in: "cookie", name: "__Host-nabda_session", description: "Opaque HttpOnly, Secure, SameSite=Lax Nabda session after top-level GitHub OAuth sign-in at /auth/github. The server verifies state, browser binding and S256 PKCE. The dashboard stays on the API origin. POST /auth/logout revokes this browser session. API keys and device tokens do not authenticate management calls; caller-provided identity headers are ignored." };
  for (const methods of Object.values(document.paths)) for (const operation of Object.values(methods)) {
    if (!operation.security?.some((scheme) => "SitesBrowserSession" in scheme)) continue;
    operation.security = [{ NabdaBrowserSession: [] }];
    delete operation["x-platform-browser-session-required"];
    operation["x-nabda-browser-session-required"] = true;
    operation.description = "Requires a verified Nabda browser session established through /auth/github. The browser dashboard and session remain on the API origin; mutating requests must be same-origin. An application key or caller-supplied identity header cannot impersonate an account.";
  }
  document["x-browser-authentication"] = { provider: "GitHub", sign_in: "/auth/github", callback: "/auth/github/callback", sign_out: { method: "POST", path: "/auth/logout" }, website_separate_from_api: true };
}
const output = options["--output"] ? path.resolve(options["--output"]) : new URL("../public/openapi.json", import.meta.url);
await fs.mkdir(options["--output"] ? path.dirname(output) : new URL("../public/", import.meta.url), { recursive: true });
await fs.writeFile(output, JSON.stringify(document, null, 2) + "\n");
console.log(`OpenAPI 3.1 generated: ${Object.keys(paths).length} paths, ${Object.keys(schemas).length} schemas.`);
