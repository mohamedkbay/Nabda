import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { CampaignSummary, ConnectionTestResult, ContactSummary, CustomerSummary, DesktopServices, MessageSummary } from "./contracts.js";
import { DesktopDatabase, DesktopMessagingService, DesktopRepository, HttpSmsProvider, HttpSmsProviderError, testProviderConnection } from "./core/index.js";
import type { SecretStore } from "./core/secret-store.js";
import type { CampaignRecord, DesktopMessageRecord } from "./core/types.js";

const MAX_SCHEDULE_MS = 20 * 24 * 60 * 60 * 1_000;
const MAX_CAMPAIGN_RECIPIENTS = 500;

interface StoredSettings { from?: string; encryptedDefault: boolean; statusPollingSeconds: number }
interface MessageOptions { encrypted: boolean; requestId: string; sendAt?: string }
interface CampaignPolicy { messagesPerMinute: number; encrypted: boolean; lastSubmittedAt?: string }

export interface DesktopServiceFactoryInput {
  userDataPath: string;
  readProviderSecret: () => Promise<string | undefined>;
  fetchImplementation?: typeof fetch;
}

/** Electron-to-core composition root. Credentials never cross to the renderer. */
export function createDesktopServices(input: DesktopServiceFactoryInput): DesktopServices {
  mkdirSync(input.userDataPath, { recursive: true });
  const database = new DesktopDatabase(join(input.userDataPath, "httpsms-desktop.sqlite3"));
  const repository = new DesktopRepository(database);
  const messaging = new DesktopMessagingService(repository);
  const provider = new HttpSmsProvider({ ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}) });
  let workerRunning = false;

  const customerName = (id: string | null): string | undefined => id ? repository.getClient(id)?.name : undefined;
  const contactName = (id: string | null): string | undefined => id ? repository.getContact(id)?.name : undefined;

  const drainQueue = async (): Promise<void> => {
    if (workerRunning) return;
    const settings = readSettings(repository);
    const apiKey = await input.readProviderSecret();
    if (!settings.from || !apiKey) return;
    workerRunning = true;
    try {
      for (let processed = 0; processed < 10; processed += 1) {
        const now = new Date();
        const job = repository.claimNextQueueJob(now);
        if (!job) break;
        const message = repository.getMessage(job.messageId);
        if (!message) break;
        if (repository.isOptedOut(message.to)) {
          repository.completeQueueJob({ jobId: job.id, messageId: message.id, status: "cancelled", failureReason: "Recipient opted out before dispatch", now });
          continue;
        }

        const policy = message.campaignId ? readCampaignPolicy(repository, message.campaignId) : undefined;
        if (policy?.lastSubmittedAt) {
          const nextAllowedAt = new Date(policy.lastSubmittedAt).getTime() + 60_000 / policy.messagesPerMinute;
          if (nextAllowedAt > now.getTime()) {
            repository.requeueJob(job.id, "Local campaign distribution limit", new Date(nextAllowedAt), now);
            continue;
          }
        }

        try {
          const options = readMessageOptions(repository, message.id, policy?.encrypted ?? settings.encryptedDefault);
          const result = await provider.send({
            apiKey,
            from: settings.from,
            to: message.to,
            content: message.content,
            requestId: options.requestId,
            ...(options.sendAt ? { sendAt: new Date(options.sendAt) } : {}),
            encrypted: options.encrypted,
            now,
          });
          repository.completeQueueJob({
            jobId: job.id,
            messageId: message.id,
            status: result.status,
            providerMessageId: result.providerMessageId,
            payload: { provider: "httpsms", providerStatus: result.rawStatus, requestId: options.requestId },
            now,
          });
          if (message.campaignId && policy) repository.setSetting(campaignPolicyKey(message.campaignId), { ...policy, lastSubmittedAt: now.toISOString() });
        } catch (error) {
          const manualReview = error instanceof HttpSmsProviderError && error.manualReview;
          const reason = manualReview
            ? `MANUAL_REVIEW_REQUIRED: ${error.message}`
            : error instanceof Error ? error.message : "httpSMS failed";
          // Ambiguous outcomes are terminal locally: never blind-retry a send.
          repository.completeQueueJob({ jobId: job.id, messageId: message.id, status: "failed", failureReason: reason, payload: { manualReview }, now });
        }
      }
    } finally {
      workerRunning = false;
    }
  };
  const workerTimer = setInterval(() => void drainQueue(), 2_000);
  workerTimer.unref();

  const queueMessage = (message: { contactId?: string; to: string; body: string; sendAt?: string; encrypted: boolean; requestId?: string }): MessageSummary => {
    const scheduledAt = validateSendAt(message.sendAt);
    const created = messaging.queueMessage({ to: message.to, content: message.body, ...(message.contactId ? { contactId: message.contactId } : {}), ...(scheduledAt ? { scheduledAt } : {}) });
    repository.setSetting(messageOptionsKey(created.id), {
      encrypted: message.encrypted,
      requestId: message.requestId || created.id,
      ...(scheduledAt ? { sendAt: scheduledAt.toISOString() } : {}),
    } satisfies MessageOptions);
    // Submit future schedules now so the official send_at field reaches httpSMS.
    if (scheduledAt) makeQueueJobAvailableNow(database, created.id);
    queueMicrotask(() => void drainQueue());
    return mapMessage(created, message.contactId ? contactName(message.contactId) : undefined);
  };

  return {
    dashboard: { async getSnapshot() {
      const messages = repository.listMessages(50);
      const today = new Date().toISOString().slice(0, 10);
      return {
        customers: repository.listClients().length,
        contacts: repository.listContacts().length,
        queuedMessages: messages.filter((item) => ["queued", "processing"].includes(item.status)).length,
        sentToday: messages.filter((item) => item.status === "sent" && item.updatedAt.startsWith(today)).length,
        failedToday: messages.filter((item) => item.status === "failed" && item.updatedAt.startsWith(today)).length,
        integrationConfigured: Boolean(readSettings(repository).from && (await input.readProviderSecret())),
        recentMessages: messages.slice(0, 6).map((item) => mapMessage(item, contactName(item.contactId))),
      };
    } },
    customers: {
      async list() { return repository.listClients().map(mapCustomer); },
      async create(customer) { return mapCustomer(repository.createClient({ name: customer.name, ...(customer.notes ? { notes: customer.notes } : {}) })); },
    },
    contacts: {
      async list() { return repository.listContacts().map((item) => mapContact(item, customerName(item.clientId), repository.isOptedOut(item.phone))); },
      async create(contact) {
        const created = repository.createContact({ name: contact.name, phone: contact.phone, ...(contact.customerId ? { clientId: contact.customerId } : {}), consentReference: "Confirmed in httpSMS Desktop" });
        return mapContact(created, customerName(created.clientId), false);
      },
      async setOptOut({ id, optedOut }) {
        const contact = repository.getContact(id);
        if (!contact) throw new Error("Contact not found");
        if (optedOut) repository.addOptOut(contact.phone, "Set in httpSMS Desktop");
        else repository.removeOptOut(contact.phone);
        return mapContact(contact, customerName(contact.clientId), optedOut);
      },
    },
    messages: {
      async list({ limit }) { return repository.listMessages(limit).map((item) => mapMessage(item, contactName(item.contactId))); },
      async enqueue(message) { return queueMessage(message); },
      async cancel({ id }) {
        const cancelled = messaging.cancelQueuedMessage(id);
        if (!cancelled) throw new Error("Queued message not found");
        return mapMessage(cancelled, contactName(cancelled.contactId));
      },
      async refreshStatuses({ limit, secret }) {
        const candidates = repository.listMessages(limit).filter((item) => Boolean(item.providerMessageId) && ["sent", "delivered"].includes(item.status));
        for (const message of candidates) {
          try {
            const status = await provider.getStatus(secret, message.providerMessageId as string);
            repository.recordProviderStatus({ messageId: message.id, status: status.status, ...(status.failureReason ? { failureReason: status.failureReason } : {}), payload: { provider: "httpsms", providerStatus: status.rawStatus } });
          } catch { /* A transient polling failure must not mutate the message. */ }
        }
        return repository.listMessages(limit).map((item) => mapMessage(item, contactName(item.contactId)));
      },
    },
    campaigns: {
      async list() { return listCampaigns(database); },
      async create(campaign) {
        if (campaign.contactIds.length < 1 || campaign.contactIds.length > MAX_CAMPAIGN_RECIPIENTS) throw new Error("Invalid campaign size");
        const startsAt = validateSendAt(campaign.startsAt);
        if (!startsAt) throw new Error("Campaign start is required");
        const recipients = [...new Set(campaign.contactIds)].map((contactId) => {
          const contact = repository.getContact(contactId);
          if (!contact) throw new Error("Contact not found");
          return { contactId, to: contact.phone, consentReference: contact.consentReference || "Confirmed in httpSMS Desktop" };
        });
        const queued = repository.queueCampaign({ name: campaign.name, content: campaign.body, recipients, sendAt: startsAt, maxRecipients: MAX_CAMPAIGN_RECIPIENTS });
        repository.setSetting(campaignPolicyKey(queued.campaign.id), { messagesPerMinute: campaign.messagesPerMinute, encrypted: campaign.encrypted } satisfies CampaignPolicy);
        for (const messageId of campaignMessageIds(database, queued.campaign.id)) {
          repository.setSetting(messageOptionsKey(messageId), {
            encrypted: campaign.encrypted,
            requestId: messageId,
            sendAt: startsAt.toISOString(),
          } satisfies MessageOptions);
        }
        makeCampaignJobsAvailableNow(database, queued.campaign.id);
        queueMicrotask(() => void drainQueue());
        return mapCampaign(queued.campaign, database);
      },
    },
    settings: {
      async get() { return { ...readSettings(repository), secretConfigured: false }; },
      async save(settings) {
        if (settings.from && !/^\+[1-9]\d{6,14}$/.test(settings.from)) throw new Error("From must use E.164");
        repository.setSetting("desktop.settings", settings);
        return { ...settings, secretConfigured: false };
      },
      async testProviderConnection({ secret }) { return connectionResult(await testProviderConnection(provider, fixedSecretStore(secret))); },
    },
    backup: {
      async exportTo(targetPath) { database.exportBackup(targetPath); return { ok: true, fileName: basename(targetPath), message: "تم تصدير النسخة الاحتياطية." }; },
      async validateAndImportFrom(sourcePath) { database.importBackup(sourcePath); return { ok: true, fileName: basename(sourcePath), message: "تم التحقق من النسخة واستيرادها." }; },
    },
  };
}

function validateSendAt(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const sendAt = new Date(value);
  const offset = sendAt.getTime() - Date.now();
  if (!Number.isFinite(sendAt.getTime()) || offset < -60_000 || offset > MAX_SCHEDULE_MS) throw new Error("send_at is outside the allowed 20-day window");
  return sendAt;
}

function readSettings(repository: DesktopRepository): StoredSettings {
  return repository.getSetting<StoredSettings>("desktop.settings") ?? { encryptedDefault: false, statusPollingSeconds: 30 };
}

function messageOptionsKey(id: string): string { return `message.options.${id}`; }
function readMessageOptions(repository: DesktopRepository, id: string, fallbackEncrypted: boolean): MessageOptions {
  return repository.getSetting<MessageOptions>(messageOptionsKey(id)) ?? { encrypted: fallbackEncrypted, requestId: id };
}
function campaignPolicyKey(id: string): string { return `campaign.policy.${id}`; }
function readCampaignPolicy(repository: DesktopRepository, id: string): CampaignPolicy | undefined {
  return repository.getSetting<CampaignPolicy>(campaignPolicyKey(id)) ?? undefined;
}

function makeQueueJobAvailableNow(database: DesktopDatabase, messageId: string): void {
  database.db.prepare("UPDATE queue_jobs SET available_at = ? WHERE message_id = ? AND status = 'pending'").run(new Date().toISOString(), messageId);
}
function makeCampaignJobsAvailableNow(database: DesktopDatabase, campaignId: string): void {
  database.db.prepare("UPDATE queue_jobs SET available_at = ? WHERE status = 'pending' AND message_id IN (SELECT id FROM messages WHERE campaign_id = ?)").run(new Date().toISOString(), campaignId);
}

function campaignMessageIds(database: DesktopDatabase, campaignId: string): string[] {
  const rows = database.db.prepare("SELECT id FROM messages WHERE campaign_id = ? ORDER BY created_at").all(campaignId) as unknown as Array<{ id: unknown }>;
  return rows.map((row) => String(row.id));
}

function listCampaigns(database: DesktopDatabase): CampaignSummary[] {
  const rows = database.db.prepare("SELECT id, name, content, status, scheduled_at, created_at, updated_at FROM campaigns ORDER BY created_at DESC LIMIT 100").all() as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => mapCampaign({ id: String(row.id), name: String(row.name), content: String(row.content), status: String(row.status) as CampaignRecord["status"], scheduledAt: String(row.scheduled_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }, database));
}

function mapCampaign(campaign: CampaignRecord, database: DesktopDatabase): CampaignSummary {
  const counts = database.db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status IN ('queued','processing') THEN 1 ELSE 0 END) queued, SUM(CASE WHEN status IN ('sent','delivered') THEN 1 ELSE 0 END) sent, SUM(CASE WHEN status IN ('failed','expired','cancelled') THEN 1 ELSE 0 END) failed FROM messages WHERE campaign_id = ?").get(campaign.id) as Record<string, unknown> | undefined;
  const recipientCount = Number(counts?.total ?? 0);
  const queuedCount = Number(counts?.queued ?? 0);
  const sentCount = Number(counts?.sent ?? 0);
  const failedCount = Number(counts?.failed ?? 0);
  const status: CampaignSummary["status"] = failedCount > 0 ? "attention" : queuedCount === 0 ? "completed" : new Date(campaign.scheduledAt).getTime() > Date.now() ? "scheduled" : "running";
  return { id: campaign.id, name: campaign.name, recipientCount, queuedCount, sentCount, failedCount, startsAt: campaign.scheduledAt, status, createdAt: campaign.createdAt };
}

function mapCustomer(record: { id: string; name: string; notes: string | null; createdAt: string }): CustomerSummary {
  return { id: record.id, name: record.name, ...(record.notes ? { notes: record.notes } : {}), createdAt: record.createdAt };
}
function mapContact(record: { id: string; clientId: string | null; name: string; phone: string; createdAt: string }, clientName: string | undefined, optedOut: boolean): ContactSummary {
  return { id: record.id, ...(record.clientId ? { customerId: record.clientId } : {}), ...(clientName ? { customerName: clientName } : {}), name: record.name, phone: record.phone, optedOut, createdAt: record.createdAt };
}
function mapMessage(record: DesktopMessageRecord, name?: string): MessageSummary {
  return { id: record.id, ...(name ? { contactName: name } : {}), to: record.to, bodyPreview: record.content.length > 90 ? `${record.content.slice(0, 87)}…` : record.content, status: record.status === "processing" ? "queued" : record.status, createdAt: record.createdAt };
}

function readOnlySecretStore(read: () => Promise<string | undefined>): SecretStore {
  return { get: async () => (await read()) ?? null, set: async () => { throw new Error("Read-only secret store"); }, delete: async () => { throw new Error("Read-only secret store"); } };
}
function fixedSecretStore(secret: string): SecretStore { return readOnlySecretStore(async () => secret); }
function connectionResult(value: { ok: true; detail: string }): ConnectionTestResult { return { ok: value.ok, message: value.detail, checkedAt: new Date().toISOString() }; }
