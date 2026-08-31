import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopDatabase,
  DesktopMessagingService,
  DesktopRepository,
  LocalQueueWorker,
  MemorySecretStore,
  MockDesktopProvider,
  SettingsSecretService,
  testProviderConnection,
} from "../desktop/core/index.js";

const opened: DesktopDatabase[] = [];

function makeCore(): { database: DesktopDatabase; repository: DesktopRepository } {
  const database = new DesktopDatabase(":memory:");
  opened.push(database);
  return { database, repository: new DesktopRepository(database) };
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

describe("desktop SQLite core", () => {
  it("applies the local migration once with all required tables", () => {
    const { database } = makeCore();
    const tables = database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String((row as { name: string }).name));

    expect(tables).toEqual(
      expect.arrayContaining([
        "clients",
        "contacts",
        "opt_outs",
        "messages",
        "message_events",
        "devices",
        "settings",
        "queue_jobs",
        "pairing_sessions",
        "device_credentials",
      ]),
    );
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
  });

  it("stores clients, contacts, settings and opt-outs locally", () => {
    const { repository } = makeCore();
    const client = repository.createClient({ name: "Acme", email: "ops@example.test" });
    const contact = repository.createContact({
      clientId: client.id,
      name: "Amina",
      phone: "+218 91 000 0000",
      consentReference: "ticket-42",
      tags: ["vip", "vip"],
    });
    repository.setSetting("ui.language", "ar");

    expect(repository.listClients()).toHaveLength(1);
    expect(repository.listContacts({ clientId: client.id })).toEqual([expect.objectContaining({ id: contact.id, tags: ["vip"] })]);
    expect(repository.getSetting<string>("ui.language")).toBe("ar");
    expect(repository.addOptOut(contact.phone, "STOP")).toBe(true);
    expect(repository.isOptedOut(contact.phone)).toBe(true);
    expect(() => repository.createMessage({ to: contact.phone, content: "Blocked" })).toThrow("opted out");
    expect(() => repository.setSetting("provider.apiKey", "do-not-store-here")).toThrow("SecretStore");
  });

  it("runs a complete local Mock queue flow", async () => {
    const { repository } = makeCore();
    const messages = new DesktopMessagingService(repository);
    const provider = new MockDesktopProvider();
    const worker = new LocalQueueWorker(repository, provider);
    const queued = messages.queueMessage({ to: "+218910000001", content: "Your code is 1234" });

    expect(queued.status).toBe("queued");
    const completed = await worker.runOnce();

    expect(completed).toEqual(expect.objectContaining({ id: queued.id, status: "sent" }));
    expect(completed?.providerMessageId).toMatch(/^mock_/);
    expect(provider.sendCalls).toBe(1);
    expect(repository.getMessageEvents(queued.id).map((event) => event.type)).toEqual(["queued", "sent"]);
    expect(await worker.runOnce()).toBeNull();
  });

  it("checks opt-out again in the worker before dispatch", async () => {
    const { repository } = makeCore();
    const provider = new MockDesktopProvider();
    const queued = repository.createMessage({ to: "+218910000002", content: "Expected update" });
    repository.addOptOut(queued.to, "Recipient changed their mind");

    const result = await new LocalQueueWorker(repository, provider).runOnce();
    expect(result?.status).toBe("cancelled");
    expect(provider.sendCalls).toBe(0);
  });
});

describe("desktop secret and connection safety", () => {
  it("keeps provider secrets outside SQLite", async () => {
    const { database } = makeCore();
    const secretStore = new MemorySecretStore();
    const secrets = new SettingsSecretService(secretStore);
    const secret = "local-secret-value-never-in-sqlite";

    await secrets.saveProviderSecret(secret);
    expect(await secrets.readProviderSecret()).toBe(secret);
    expect(await secrets.hasProviderSecret()).toBe(true);
    const persisted = database.db.prepare("SELECT value_json FROM settings").all();
    expect(JSON.stringify(persisted)).not.toContain(secret);
    await secrets.clearProviderSecret();
    expect(await secrets.readProviderSecret()).toBeNull();
  });

  it("test connection never invokes send", async () => {
    const provider = new MockDesktopProvider();
    await expect(testProviderConnection(provider, null)).resolves.toEqual({
      ok: true,
      detail: "Mock provider is available. No SMS was sent.",
    });
    expect(provider.connectionTestCalls).toBe(1);
    expect(provider.sendCalls).toBe(0);
  });
});
