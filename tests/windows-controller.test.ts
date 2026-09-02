import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LocalController } from "../desktop/controller/controller.js";
import { startControllerServer, type ControllerServer } from "../desktop/controller/server.js";
import { DesktopDatabase } from "../desktop/core/database.js";

const databases: DesktopDatabase[] = [];
const servers: ControllerServer[] = [];

function setup() {
  const database = new DesktopDatabase(":memory:");
  databases.push(database);
  return { database, controller: new LocalController(database) };
}

function requestWithHost(port: number, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/", headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
  while (databases.length) databases.pop()?.close();
});

describe("Windows browser controller", () => {
  it("uses an expiring one-time QR exchange and never places the permanent device key in the QR", () => {
    const { database, controller } = setup();
    const pairing = controller.createPairing("http://192.168.1.20:3210", "Front desk phone");
    const uri = new URL(pairing.pairing_uri);
    expect(uri.protocol).toBe("nabda:");
    expect(uri.hostname).toBe("pair");
    expect(uri.searchParams.get("server")).toBe("http://192.168.1.20:3210");
    expect(pairing.pairing_uri).not.toContain("nbda_device_");

    const paired = controller.pairDevice({ pairing_token: uri.searchParams.get("token") });
    expect(paired).toMatchObject({ device_name: "Front desk phone", server_url: "http://192.168.1.20:3210" });
    expect(paired.device_token).toMatch(/^nbda_device_/);
    const stored = database.db.prepare("SELECT token_hash FROM controller_devices WHERE id = ?").get(paired.device_id) as { token_hash: string };
    expect(stored.token_hash).not.toContain(paired.device_token);
    expect(() => controller.pairDevice({ pairing_token: uri.searchParams.get("token") })).toThrow("expired");
  });

  it("imports the reference CSV contact shape in safe batches with consent and deduplication", () => {
    const { controller } = setup();
    const result = controller.importContacts({
      contacts: [
        { name: "Mohamed", phone: "+218918019090" },
        { name: "Second number", phone: "+218912166969" },
        { name: "Duplicate", phone: "+218918019090" },
        { name: "Invalid", phone: "091" },
      ],
      consent_reference: "Customer export 2026-09-01",
      consent_confirmed: true,
    });
    expect(result).toEqual({ imported: 2, duplicates: 1, invalid: 1, total: 4 });
    expect(controller.getDashboard("http://192.168.1.20:3210").counts.contacts).toBe(2);
  });

  it("stores only a hashed device token and completes the one-message Android lease flow", () => {
    const { database, controller } = setup();
    controller.createContact({
      name: "Amina", phone: "+218910000001", consent_reference: "contract-1", consent_confirmed: true,
    });
    const message = controller.createMessage({
      to: "+218910000001", content: "Expected appointment reminder", consent_confirmed: true,
    });
    const provisioned = controller.provisionDevice("Office phone");
    const stored = database.db.prepare("SELECT token_hash FROM controller_devices WHERE id = ?").get(provisioned.id) as { token_hash: string };
    expect(stored.token_hash).not.toContain(provisioned.token);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);

    expect(() => controller.setLiveEnabled(true, "wrong")).toThrow("ENABLE_LIVE_SMS");
    controller.setLiveEnabled(true, "ENABLE_LIVE_SMS");
    const principal = controller.authenticateDevice(provisioned.token);
    expect(controller.heartbeat(principal, { simulated: false, app_version: "0.1.0", android_version: "15" }))
      .toMatchObject({ device_id: provisioned.id, live_reporting_enabled: true });

    const claimed = controller.claim(principal, { simulated: false, limit: 1 });
    expect(claimed.messages).toHaveLength(1);
    expect(claimed.messages[0]).toMatchObject({ id: message.id, to: "+218910000001", execution_mode: "live" });
    const lease = claimed.messages[0]?.lease_token as string;
    const attempt = randomUUID();
    expect(controller.begin(principal, message.id, { simulated: false, lease_token: lease, attempt_id: attempt }))
      .toEqual({ authorized: true, duplicate: false, attempt_id: attempt });

    const event = {
      simulated: false, lease_token: lease, attempt_id: attempt, event_id: randomUUID(), status: "sent",
      occurred_at: new Date().toISOString(), provider_message_id: "android_test",
    };
    expect(controller.event(principal, message.id, event)).toMatchObject({ accepted: true, duplicate: false, status: "sent" });
    expect(controller.event(principal, message.id, event)).toMatchObject({ accepted: true, duplicate: true, status: "sent" });
    expect(() => controller.event(principal, message.id, { ...event, status: "failed" })).toThrow("different data");
    expect(controller.repository.getMessage(message.id)?.status).toBe("sent");
  });

  it("keeps opted-out work away from the phone and queues campaigns on the computer", () => {
    const { controller } = setup();
    const first = controller.createContact({ name: "One", phone: "+218910000011", consent_reference: "ticket-1", consent_confirmed: true });
    const second = controller.createContact({ name: "Two", phone: "+218910000012", consent_reference: "ticket-2", consent_confirmed: true });
    controller.setOptOut(second.id, true);
    const campaign = controller.createCampaign({
      name: "Service notice", content: "Expected service notice", contact_ids: [first.id, second.id], consent_confirmed: true,
    });
    expect(campaign).toMatchObject({ queued: 1, skippedOptOut: 1 });
    expect(controller.getDashboard("http://192.168.1.20:3210").counts.queued).toBe(1);
  });

  it("serves health publicly and creates a protected session only for a loopback dashboard host", async () => {
    const { controller } = setup();
    const server = await startControllerServer({ controller, lanAddress: "192.168.1.20", port: 0 });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok", delivery_mode: "android_lan" });
    const direct = await fetch(`${base}/`, { redirect: "manual" });
    expect(direct.status).toBe(302);
    expect(direct.headers.get("set-cookie")).toMatch(/^nbda_control=/);
    await expect(requestWithHost(server.port, `example.test:${server.port}`)).resolves.toBe(403);

    const unlocked = await fetch(server.dashboardUrl, { redirect: "manual" });
    expect(unlocked.status).toBe(302);
    const cookie = unlocked.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^nbda_control=/);
    const page = await fetch(`${base}/`, { headers: { cookie: cookie as string } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Nabda Controller");
    const state = await fetch(`${base}/control-api/state`, { headers: { cookie: cookie as string } });
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({ system: { lan_url: `http://192.168.1.20:${server.port}` } });

    const pairingResponse = await fetch(`${base}/control-api/pairing`, {
      method: "POST",
      headers: { cookie: cookie as string, "content-type": "application/json", "x-nabda-control": "1" },
      body: JSON.stringify({ name: "QR phone" }),
    });
    expect(pairingResponse.status).toBe(201);
    const pairing = await pairingResponse.json() as { pairing_uri: string };
    const pairingUri = new URL(pairing.pairing_uri);
    const paired = await fetch(`${base}/v1/device/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_token: pairingUri.searchParams.get("token") }),
    });
    expect(paired.status).toBe(201);
    await expect(paired.json()).resolves.toMatchObject({ device_name: "QR phone" });
  });
});
