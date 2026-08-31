import { basename } from "node:path";
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import QRCode from "qrcode";
import { z } from "zod";
import type { DesktopServices } from "../contracts.js";
import type { SecretVault } from "../security/secret-vault.js";
import { IPC_CHANNELS } from "./channels.js";

const idSchema = z.object({ id: z.string().uuid() }).strict();
const optionalPhone = z.string().trim().min(3).max(32).optional();
const phone = z.string().trim().min(3).max(32);
const shortText = z.string().trim().min(1).max(200);
const optionalShortText = z.string().trim().max(500).optional();
const provider = z.enum(["mock", "httpsms"]);

const customerCreateSchema = z
  .object({ name: shortText, phone: optionalPhone, notes: optionalShortText })
  .strict();
const contactCreateSchema = z
  .object({
    name: shortText,
    phone,
    customerId: z.string().uuid().optional(),
    consentConfirmed: z.literal(true),
  })
  .strict();
const optOutSchema = z.object({ id: z.string().uuid(), optedOut: z.boolean() }).strict();
const messageListSchema = z.object({ limit: z.number().int().min(1).max(200) }).strict();
const enqueueSchema = z
  .object({
    contactId: z.string().uuid().optional(),
    to: phone,
    body: z.string().trim().min(1).max(1_600),
    consentConfirmed: z.literal(true),
  })
  .strict();
const settingsSchema = z
  .object({
    provider,
    providerEndpoint: z.string().url().max(2_048).optional(),
    senderLabel: z.string().trim().max(50).optional(),
    startWorkerOnLaunch: z.boolean(),
    secret: z.string().min(8).max(4_096).optional(),
    clearSecret: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.secret && value.clearSecret), {
    message: "Secret and clearSecret cannot be used together.",
  });
const providerTestSchema = z
  .object({ provider, endpoint: z.string().url().max(2_048).optional() })
  .strict();

export interface IpcRegistrationOptions {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  window: BrowserWindow;
  rendererUrl: string;
  services: DesktopServices;
  secretVault: SecretVault;
  getLanOrigin: () => string;
}

export function registerIpcHandlers(options: IpcRegistrationOptions): () => void {
  const { ipcMain, services } = options;
  const register = <T>(
    channel: string,
    schema: z.ZodType<T>,
    action: (input: T) => Promise<unknown>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      assertTrustedSender(event, options.rendererUrl);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error("Invalid request.");
      try {
        return await action(parsed.data);
      } catch (error) {
        // Keep credentials, database paths and provider responses out of IPC.
        if (error instanceof PublicDesktopError) throw error;
        throw new Error("The operation could not be completed.");
      }
    });
  };

  register(IPC_CHANNELS.dashboardGet, emptySchema, () => services.dashboard.getSnapshot());
  register(IPC_CHANNELS.customersList, emptySchema, () => services.customers.list());
  register(IPC_CHANNELS.customersCreate, customerCreateSchema, (input) =>
    services.customers.create({
      name: input.name,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    }),
  );
  register(IPC_CHANNELS.contactsList, emptySchema, () => services.contacts.list());
  register(IPC_CHANNELS.contactsCreate, contactCreateSchema, (input) =>
    services.contacts.create({
      name: input.name,
      phone: input.phone,
      consentConfirmed: true,
      ...(input.customerId ? { customerId: input.customerId } : {}),
    }),
  );
  register(IPC_CHANNELS.contactsSetOptOut, optOutSchema, (input) => services.contacts.setOptOut(input));
  register(IPC_CHANNELS.messagesList, messageListSchema, (input) => services.messages.list(input));
  register(IPC_CHANNELS.messagesEnqueue, enqueueSchema, (input) =>
    services.messages.enqueue({
      to: input.to,
      body: input.body,
      consentConfirmed: true,
      ...(input.contactId ? { contactId: input.contactId } : {}),
    }),
  );
  register(IPC_CHANNELS.messagesCancel, idSchema, (input) => services.messages.cancel(input));
  register(IPC_CHANNELS.devicesList, emptySchema, () => services.devices.list());
  register(IPC_CHANNELS.devicesCreatePairing, emptySchema, async () => {
    const session = await services.devices.createPairingSession({
      ttlSeconds: 300,
      lanOrigin: options.getLanOrigin(),
    });
    const qrDataUrl = await QRCode.toDataURL(session.pairingUri, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
      color: { dark: "#102d29", light: "#ffffff" },
    });
    return { ...session, qrDataUrl };
  });
  register(IPC_CHANNELS.devicesRevoke, idSchema, async (input) => {
    await services.devices.revoke(input);
    return { ok: true };
  });
  register(IPC_CHANNELS.devicesTestHeartbeat, idSchema, (input) => services.devices.testHeartbeat(input));
  register(IPC_CHANNELS.settingsGet, emptySchema, async () => {
    const settings = await services.settings.get();
    return { ...settings, secretConfigured: await options.secretVault.hasSecret() };
  });
  register(IPC_CHANNELS.settingsSave, settingsSchema, async ({ secret, clearSecret, ...settings }) => {
    if (clearSecret) await options.secretVault.clear();
    if (secret) await options.secretVault.save(secret);
    const saved = await services.settings.save({
      provider: settings.provider,
      startWorkerOnLaunch: settings.startWorkerOnLaunch,
      ...(settings.providerEndpoint ? { providerEndpoint: settings.providerEndpoint } : {}),
      ...(settings.senderLabel ? { senderLabel: settings.senderLabel } : {}),
    });
    return { ...saved, secretConfigured: await options.secretVault.hasSecret() };
  });
  register(IPC_CHANNELS.settingsTestProvider, providerTestSchema, async (input) => {
    const secret = input.provider === "mock" ? undefined : await options.secretVault.read();
    if (input.provider !== "mock" && !secret) {
      return { ok: false, message: "No provider secret is saved.", checkedAt: new Date().toISOString() };
    }
    // Deliberately calls a metadata-only method: no recipient/body parameters exist.
    return services.settings.testProviderConnection({
      provider: input.provider,
      ...(secret ? { secret } : {}),
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    });
  });
  register(IPC_CHANNELS.backupExport, emptySchema, async () => {
    const result = await dialog.showSaveDialog(options.window, {
      title: "تصدير نسخة احتياطية",
      defaultPath: `nabda-backup-${new Date().toISOString().slice(0, 10)}.nabda`,
      filters: [{ name: "Nabda backup", extensions: ["nabda"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    return services.backup.exportTo(result.filePath);
  });
  register(IPC_CHANNELS.backupImport, emptySchema, async () => {
    const picked = await dialog.showOpenDialog(options.window, {
      title: "استيراد نسخة احتياطية",
      filters: [{ name: "Nabda backup", extensions: ["nabda"] }],
      properties: ["openFile", "dontAddToRecent"],
    });
    const sourcePath = picked.filePaths[0];
    if (picked.canceled || !sourcePath) return { ok: false, cancelled: true };
    const confirmation = await dialog.showMessageBox(options.window, {
      type: "warning",
      title: "تأكيد الاستيراد",
      message: `استيراد ${basename(sourcePath)}؟`,
      detail: "سيتم التحقق من النسخة قبل استبدال البيانات المحلية. أنشئ نسخة احتياطية أولاً.",
      buttons: ["إلغاء", "تحقق واستورد"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { ok: false, cancelled: true };
    return services.backup.validateAndImportFrom(sourcePath);
  });

  const channels = Object.values(IPC_CHANNELS);
  return () => channels.forEach((channel) => ipcMain.removeHandler(channel));
}

const emptySchema = z.undefined().or(z.null());

function assertTrustedSender(event: IpcMainInvokeEvent, rendererUrl: string): void {
  const actual = event.senderFrame?.url;
  if (actual !== rendererUrl) throw new Error("Untrusted IPC sender.");
}

export class PublicDesktopError extends Error {}
