import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopDatabase,
  DesktopMessagingService,
  DesktopRepository,
  HttpSmsProvider,
  HttpSmsProviderError,
  LocalQueueWorker,
  MemorySecretStore,
  SettingsSecretService,
  testProviderConnection,
} from "../desktop/core/index.js";

const opened: DesktopDatabase[] = [];
function core() {
  const database = new DesktopDatabase(":memory:");
  opened.push(database);
  return { database, repository: new DesktopRepository(database) };
}
afterEach(() => {
  while (opened.length) opened.pop()?.close();
  vi.restoreAllMocks();
});

describe("local SQLite data", () => {
  it("migrates to schema v4 with the local browser-controller tables", () => {
    const { database } = core();
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    const tables = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["clients", "contacts", "opt_outs", "messages", "message_events", "queue_jobs", "campaigns", "campaign_recipients", "controller_devices", "device_claims", "device_event_receipts"]));
    expect(tables).not.toEqual(expect.arrayContaining(["devices", "device_credentials", "pairing_sessions"]));
  });

  it("stores customer data and blocks opted-out recipients", () => {
    const { repository } = core();
    const client = repository.createClient({ name: "Acme" });
    const contact = repository.createContact({ clientId: client.id, name: "Amina", phone: "+218 91 000 0000", consentReference: "ticket-1" });
    repository.addOptOut(contact.phone, "STOP");
    expect(repository.isOptedOut(contact.phone)).toBe(true);
    expect(() => repository.createMessage({ to: contact.phone, content: "blocked" })).toThrow("opted out");
  });

  it("queues campaigns with consent, scheduling limits and opt-out filtering", () => {
    const { repository } = core();
    const now = new Date("2026-08-31T10:00:00.000Z");
    repository.addOptOut("+218910000002", "STOP", now);
    const result = repository.queueCampaign({
      name: "Service window",
      content: "Maintenance starts tonight",
      recipients: [
        { to: "+218910000001", consentReference: "contract-1" },
        { to: "+218910000002", consentReference: "contract-2" },
      ],
      sendAt: new Date(now.getTime() + 60_000),
      now,
    });
    expect(result).toEqual(expect.objectContaining({ queued: 1, skippedOptOut: 1 }));
    expect(repository.listMessages()).toHaveLength(1);
    expect(() => repository.queueCampaign({ name: "Bad", content: "x", recipients: [{ to: "+218910000003", consentReference: "" }], sendAt: now, now })).toThrow("Consent");
    expect(() => repository.createMessage({ to: "+218910000004", content: "x", scheduledAt: new Date(now.getTime() + 21 * 86_400_000), now })).toThrow("20 days");
  });

  it("cancels queued messages transactionally", () => {
    const { repository } = core();
    const queued = repository.createMessage({ to: "+218910000005", content: "cancel me" });
    expect(repository.cancelQueuedMessage(queued.id)?.status).toBe("cancelled");
    expect(repository.getMessageEvents(queued.id).map((event) => event.type)).toEqual(["queued", "cancelled"]);
    expect(repository.claimNextQueueJob()).toBeNull();
  });
});

describe("official httpSMS adapter", () => {
  it("tests credentials read-only through GET /users/me", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new HttpSmsProvider({ fetchImplementation: fakeFetch });
    const secrets = new MemorySecretStore();
    await secrets.set("provider.api-key", "secret-test-key");
    await expect(testProviderConnection(provider, secrets)).resolves.toEqual({ ok: true, detail: "Connected to httpSMS. No SMS was sent." });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.httpsms.com/v1/users/me");
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("sends the documented body and polls status with injected fetch only", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return String(url).endsWith("/send")
        ? new Response(JSON.stringify({ data: { id: "msg_1", status: "sent" } }), { status: 200 })
        : new Response(JSON.stringify({ data: { id: "msg_1", status: "delivered" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new HttpSmsProvider({ fetchImplementation: fakeFetch });
    const now = new Date("2026-08-31T10:00:00.000Z");
    const sendAt = new Date(now.getTime() + 60_000);
    await expect(provider.send({ apiKey: "secret-test-key", from: "+218910000000", to: "+218910000001", content: "Expected alert", requestId: "local-1", sendAt, encrypted: true, now })).resolves.toEqual({ providerMessageId: "msg_1", status: "sent", rawStatus: "sent" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ content: "Expected alert", from: "+218910000000", to: "+218910000001", request_id: "local-1", send_at: sendAt.toISOString(), encrypted: true });
    await expect(provider.getStatus("secret-test-key", "msg_1")).resolves.toEqual({ status: "delivered", rawStatus: "delivered" });
    expect(requests[1]?.url).toBe("https://api.httpsms.com/v1/messages/msg_1");
  });

  it("marks uncertain sends for manual review and never retries blindly", async () => {
    const { repository } = core();
    const fakeFetch = vi.fn(async () => { throw new Error("socket closed"); }) as unknown as typeof fetch;
    const provider = new HttpSmsProvider({ fetchImplementation: fakeFetch });
    const secrets = new MemorySecretStore();
    await secrets.set("provider.api-key", "secret-test-key");
    repository.createMessage({ to: "+218910000006", content: "Expected alert" });
    const worker = new LocalQueueWorker(repository, provider, secrets, async () => ({ from: "+218910000000" }));
    const result = await worker.runOnce();
    expect(result).toEqual(expect.objectContaining({ status: "failed" }));
    expect(result?.failureReason).toContain("MANUAL_REVIEW_REQUIRED");
    expect(await worker.runOnce()).toBeNull();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("never sends an opted-out message even if opt-out occurs after queueing", async () => {
    const { repository } = core();
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    const provider = new HttpSmsProvider({ fetchImplementation: fakeFetch });
    const secrets = new MemorySecretStore();
    const message = repository.createMessage({ to: "+218910000007", content: "Expected alert" });
    repository.addOptOut(message.to, "STOP");
    const worker = new LocalQueueWorker(repository, provider, secrets, async () => ({ from: "+218910000000" }));
    expect((await worker.runOnce())?.status).toBe("cancelled");
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("secret storage boundary", () => {
  it("does not persist provider keys in SQLite", async () => {
    const { database } = core();
    const secrets = new SettingsSecretService(new MemorySecretStore());
    await secrets.saveProviderSecret("never-in-sqlite");
    expect(JSON.stringify(database.db.prepare("SELECT * FROM settings").all())).not.toContain("never-in-sqlite");
    expect(() => new DesktopRepository(database).setSetting("provider.api-key", "bad")).toThrow("SecretStore");
  });
});
