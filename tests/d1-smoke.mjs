import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Isolated local Cloudflare D1. This never calls a phone, carrier or deployed API.
const bundled = await build({ entryPoints: ["lib/nabda-api.ts"], bundle: true, write: false, platform: "neutral", format: "esm", target: "es2022" });
const { handleNabdaApi } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: "export default { fetch() { return new Response('isolated'); } }",
  compatibilityDate: "2026-05-15",
  d1Databases: { DB: `nabda-test-${crypto.randomUUID()}` },
}));

try {
  const db = await mf.getD1Database("DB");
  const migration = await fs.readFile("drizzle/0000_windy_sage.sql", "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  const browser = { id: "d1-smoke-user", email: "d1-smoke@example.invalid", name: "D1 smoke" };
  const call = async (path, method = "GET", payload, headers = {}, principal) => {
    const response = await handleNabdaApi(new Request(`https://nabda.invalid${path}`, {
      method,
      headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }), { DB: db }, principal);
    assert.ok(response, path);
    return { status: response.status, data: await response.json() };
  };

  assert.equal((await call("/api/account")).status, 401);
  assert.equal((await call("/api/account", "GET", undefined, {}, browser)).status, 200);
  const key = await call("/api/keys", "POST", { name: "D1 smoke" }, {}, browser);
  assert.equal(key.status, 201);
  const app = { authorization: `Bearer ${key.data.key}`, "idempotency-key": "d1-smoke-message-1" };
  const pairing = await call("/api/pairings", "POST", { name: "No-SMS test phone" }, {}, browser);
  assert.equal(pairing.status, 201);
  const paired = await call("/v1/device/pair", "POST", { pairing_token: pairing.data.pairing_token });
  assert.equal(paired.status, 201);
  const phone = { authorization: `Bearer ${paired.data.device_token}` };
  assert.equal((await call("/v1/device/pair", "POST", { pairing_token: pairing.data.pairing_token })).status, 401);
  const payload = { device_id: paired.data.device_id, to: "+218910000001", content: "Sandbox database smoke test", sandbox: true };
  const message = await call("/v1/messages", "POST", payload, app);
  assert.equal(message.status, 202);
  const repeat = await call("/v1/messages", "POST", payload, app);
  assert.equal(repeat.data.id, message.data.id);
  assert.equal((await call("/v1/messages", "POST", { ...payload, content: "Changed" }, app)).status, 409);
  const poll = await call("/v1/device/poll", "POST", { ready: true, permission_granted: true, sim_selected: true }, phone);
  assert.equal(poll.status, 200);
  assert.equal(poll.data.commands.length, 1);
  const commandId = poll.data.commands[0].id;
  const ack = await call("/v1/device/ack", "POST", { command_ids: [commandId] }, phone);
  assert.equal(ack.status, 200);
  assert.deepEqual(ack.data.acknowledged, [commandId]);
  assert.equal((await db.prepare("SELECT payload_json FROM commands WHERE id=?").bind(commandId).first()).payload_json, null);
  assert.deepEqual((await call("/v1/device/ack", "POST", { command_ids: [commandId] }, phone)).data.acknowledged, [commandId]);
  const event = { event_id: "d1-smoke-sent", message_id: message.data.id, status: "sent", parts_total: 1, parts_sent: 1, parts_delivered: 0, occurred_at: new Date().toISOString() };
  const eventResult = await call("/v1/device/events", "POST", { events: [event] }, phone);
  assert.equal(eventResult.status, 200);
  assert.deepEqual(eventResult.data.accepted, [event.event_id]);
  assert.equal((await call(`/v1/messages/${message.data.id}`, "GET", undefined, app)).data.status, "sent");
  assert.equal((await call("/v1/device/events", "POST", { events: [event] }, phone)).status, 200);

  // Cancellation between poll and handoff must keep the phone's staged send blocked.
  const cancelMessage = await call("/v1/messages", "POST", payload, { ...app, "idempotency-key": "d1-smoke-cancel-1" });
  const cancelPoll = await call("/v1/device/poll", "POST", { ready: true, permission_granted: true, sim_selected: true }, phone);
  const staged = cancelPoll.data.commands.find((c) => c.message_id === cancelMessage.data.id);
  assert.ok(staged);
  assert.equal((await call(`/v1/messages/${cancelMessage.data.id}/cancellations`, "POST", {}, app)).data.guaranteed, true);
  const blocked = await call("/v1/device/ack", "POST", { command_ids: [staged.id] }, phone);
  assert.deepEqual(blocked.data.acknowledged, []);
  assert.equal(blocked.data.rejected[0].reason, "cancelled");
  console.log("Real local D1 smoke passed: auth, pairing single-use, idempotency, payload purge, events and cancellation/ACK race. No SMS sent.");
} finally {
  await mf.dispose();
}
