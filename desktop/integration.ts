import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ConnectionTestResult,
  ContactSummary,
  CustomerSummary,
  DesktopServices,
  DeviceSummary,
  MessageSummary,
} from "./contracts.js";
import {
  DesktopDatabase,
  DesktopMessagingService,
  DesktopRepository,
  LocalQueueWorker,
  MockDesktopProvider,
  PairingService,
  testProviderConnection,
} from "./core/index.js";
import type { DesktopMessageRecord } from "./core/types.js";

interface StoredSettings {
  provider: "mock" | "httpsms";
  providerEndpoint?: string;
  senderLabel?: string;
  startWorkerOnLaunch: boolean;
}

export function createDesktopServices(input: { userDataPath: string }): DesktopServices {
  mkdirSync(input.userDataPath, { recursive: true });
  const database = new DesktopDatabase(join(input.userDataPath, "nabda.sqlite"));
  const repository = new DesktopRepository(database);
  const messaging = new DesktopMessagingService(repository);
  const mockProvider = new MockDesktopProvider();
  const worker = new LocalQueueWorker(repository, mockProvider);
  let workerRunning = false;
  const drainMockQueue = async (): Promise<void> => {
    if (workerRunning || !readSettings(repository).startWorkerOnLaunch) return;
    workerRunning = true;
    try {
      for (let processed = 0; processed < 25; processed += 1) {
        if (!(await worker.runOnce())) break;
      }
    } finally {
      workerRunning = false;
    }
  };
  const workerTimer = setInterval(() => void drainMockQueue(), 1_500);
  workerTimer.unref();
  const desktopId = readOrCreateDesktopId(repository);
  const pairing = new PairingService(database, repository, desktopId);

  const customerName = (clientId: string | null): string | undefined =>
    clientId ? repository.getClient(clientId)?.name : undefined;
  const contactName = (contactId: string | null): string | undefined =>
    contactId ? repository.getContact(contactId)?.name : undefined;

  return {
    dashboard: {
      async getSnapshot() {
        const messages = repository.listMessages(50);
        const today = new Date().toISOString().slice(0, 10);
        return {
          customers: repository.listClients().length,
          contacts: repository.listContacts().length,
          queuedMessages: messages.filter((message) => message.status === "queued" || message.status === "processing").length,
          sentToday: messages.filter((message) => message.status === "sent" && message.updatedAt.startsWith(today)).length,
          failedToday: messages.filter((message) => message.status === "failed" && message.updatedAt.startsWith(today)).length,
          connectedDevices: repository.listDevices().filter((device) => device.status === "connected").length,
          recentMessages: messages.slice(0, 6).map((message) => mapMessage(message, contactName(message.contactId))),
        };
      },
    },
    customers: {
      async list() {
        return repository.listClients().map((client) => mapCustomer(client));
      },
      async create(customer) {
        return mapCustomer(repository.createClient({
          name: customer.name,
          ...(customer.notes ? { notes: customer.notes } : {}),
        }));
      },
    },
    contacts: {
      async list() {
        return repository.listContacts().map((contact) => mapContact(contact, customerName(contact.clientId), repository.isOptedOut(contact.phone)));
      },
      async create(contact) {
        const created = repository.createContact({
          name: contact.name,
          phone: contact.phone,
          ...(contact.customerId ? { clientId: contact.customerId } : {}),
          consentReference: "Confirmed in Nabda Desktop",
        });
        return mapContact(created, customerName(created.clientId), false);
      },
      async setOptOut({ id, optedOut }) {
        const contact = repository.getContact(id);
        if (!contact) throw new Error("Contact not found");
        if (optedOut) repository.addOptOut(contact.phone, "Set in Nabda Desktop");
        else repository.removeOptOut(contact.phone);
        return mapContact(contact, customerName(contact.clientId), optedOut);
      },
    },
    messages: {
      async list({ limit }) {
        return repository.listMessages(limit).map((message) => mapMessage(message, contactName(message.contactId)));
      },
      async enqueue(message) {
        const queued = mapMessage(
          messaging.queueMessage({
            to: message.to,
            content: message.body,
            ...(message.contactId ? { contactId: message.contactId } : {}),
          }),
          message.contactId ? contactName(message.contactId) : undefined,
        );
        queueMicrotask(() => void drainMockQueue());
        return queued;
      },
      async cancel({ id }) {
        const cancelled = repository.cancelQueuedMessage(id);
        if (!cancelled) throw new Error("Queued message not found");
        return mapMessage(cancelled, contactName(cancelled.contactId));
      },
    },
    devices: {
      async list() {
        return repository.listDevices().map(mapDevice);
      },
      async createPairingSession({ ttlSeconds, lanOrigin }) {
        // Rotating the QR invalidates every earlier unclaimed one-time code.
        database.db
          .prepare("UPDATE pairing_sessions SET consumed_at = ? WHERE consumed_at IS NULL")
          .run(new Date().toISOString());
        const offer = pairing.createOffer({ lanOrigin, ttlSeconds });
        return {
          id: offer.pairingId,
          pairingUri: offer.pairingUri,
          manualAddress: lanOrigin,
          oneTimeCode: offer.code,
          expiresAt: offer.expiresAt,
        };
      },
      async claimPairing(claim) {
        const result = pairing.claim({
          code: claim.pairingCode,
          phone: {
            name: claim.deviceName,
            installationId: claim.installationId,
            appVersion: claim.appVersion,
            platform: claim.platform,
          },
        });
        return { deviceId: result.device.id, deviceToken: result.token };
      },
      async receiveHeartbeat(heartbeat) {
        const authenticated = pairing.authenticate(heartbeat.bearerToken);
        if (!authenticated || authenticated.installationId !== heartbeat.installationId) {
          throw new Error("Invalid device credential");
        }
        const device = pairing.heartbeat(heartbeat.bearerToken);
        if (!device?.lastSeenAt) throw new Error("Heartbeat rejected");
        return { deviceId: device.id, acceptedAt: device.lastSeenAt };
      },
      async revoke({ id }) {
        if (!pairing.revoke(id)) throw new Error("Device not found");
      },
      async testHeartbeat({ id }) {
        const device = repository.getDevice(id);
        if (!device) throw new Error("Device not found");
        const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
        const recent = Date.now() - lastSeen < 2 * 60_000;
        return result(recent, recent ? "الهاتف متصل وآخر Heartbeat حديث." : "لم يصل Heartbeat حديث من الهاتف.");
      },
    },
    settings: {
      async get() {
        return { ...readSettings(repository), secretConfigured: false };
      },
      async save(settings) {
        repository.setSetting("desktop.settings", settings);
        return { ...settings, secretConfigured: false };
      },
      async testProviderConnection({ provider, secret }) {
        if (provider !== "mock") {
          return result(false, "المزود الخارجي غير مفعّل في النسخة المحلية الآمنة.");
        }
        const tested = await testProviderConnection(mockProvider, secret ?? null);
        return result(tested.ok, tested.detail);
      },
    },
    backup: {
      async exportTo(targetPath) {
        database.exportBackup(targetPath);
        return { ok: true, fileName: basename(targetPath), message: "تم تصدير النسخة الاحتياطية." };
      },
      async validateAndImportFrom(sourcePath) {
        database.importBackup(sourcePath);
        return { ok: true, fileName: basename(sourcePath), message: "تم التحقق من النسخة واستيرادها." };
      },
    },
  };
}

function readOrCreateDesktopId(repository: DesktopRepository): string {
  const existing = repository.getSetting<string>("desktop.id");
  if (existing) return existing;
  const created = randomBytes(6).toString("hex");
  repository.setSetting("desktop.id", created);
  return created;
}

function readSettings(repository: DesktopRepository): StoredSettings {
  return repository.getSetting<StoredSettings>("desktop.settings") ?? {
    provider: "mock",
    startWorkerOnLaunch: true,
  };
}

function mapCustomer(record: { id: string; name: string; notes: string | null; createdAt: string }, phone?: string): CustomerSummary {
  return {
    id: record.id,
    name: record.name,
    ...(phone ? { phone } : {}),
    ...(record.notes ? { notes: record.notes } : {}),
    createdAt: record.createdAt,
  };
}

function mapContact(
  record: { id: string; clientId: string | null; name: string; phone: string; createdAt: string },
  clientName: string | undefined,
  optedOut: boolean,
): ContactSummary {
  return {
    id: record.id,
    ...(record.clientId ? { customerId: record.clientId } : {}),
    ...(clientName ? { customerName: clientName } : {}),
    name: record.name,
    phone: record.phone,
    optedOut,
    createdAt: record.createdAt,
  };
}

function mapMessage(record: DesktopMessageRecord, name?: string): MessageSummary {
  return {
    id: record.id,
    ...(name ? { contactName: name } : {}),
    to: record.to,
    bodyPreview: record.content.length > 90 ? `${record.content.slice(0, 87)}…` : record.content,
    status: record.status === "processing" ? "queued" : record.status,
    createdAt: record.createdAt,
  };
}

function mapDevice(record: {
  id: string;
  name: string;
  status: "pending" | "connected" | "offline" | "revoked";
  lastSeenAt: string | null;
}): DeviceSummary {
  return {
    id: record.id,
    name: record.name,
    status: record.status === "pending" ? "offline" : record.status,
    ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
  };
}

function result(ok: boolean, message: string): ConnectionTestResult {
  return { ok, message, checkedAt: new Date().toISOString() };
}
