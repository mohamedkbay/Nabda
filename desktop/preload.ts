import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./ipc/channels.js";

const invoke = <T>(channel: string, input?: unknown): Promise<T> => ipcRenderer.invoke(channel, input) as Promise<T>;

const api = Object.freeze({
  dashboard: Object.freeze({ get: () => invoke(IPC_CHANNELS.dashboardGet) }),
  customers: Object.freeze({
    list: () => invoke(IPC_CHANNELS.customersList),
    create: (input: unknown) => invoke(IPC_CHANNELS.customersCreate, input),
  }),
  contacts: Object.freeze({
    list: () => invoke(IPC_CHANNELS.contactsList),
    create: (input: unknown) => invoke(IPC_CHANNELS.contactsCreate, input),
    setOptOut: (input: unknown) => invoke(IPC_CHANNELS.contactsSetOptOut, input),
  }),
  messages: Object.freeze({
    list: (input: unknown) => invoke(IPC_CHANNELS.messagesList, input),
    enqueue: (input: unknown) => invoke(IPC_CHANNELS.messagesEnqueue, input),
    cancel: (input: unknown) => invoke(IPC_CHANNELS.messagesCancel, input),
    refreshStatuses: (input: unknown) => invoke(IPC_CHANNELS.messagesRefreshStatuses, input),
  }),
  campaigns: Object.freeze({
    list: () => invoke(IPC_CHANNELS.campaignsList),
    create: (input: unknown) => invoke(IPC_CHANNELS.campaignsCreate, input),
  }),
  settings: Object.freeze({
    get: () => invoke(IPC_CHANNELS.settingsGet),
    save: (input: unknown) => invoke(IPC_CHANNELS.settingsSave, input),
    testProvider: () => invoke(IPC_CHANNELS.settingsTestProvider),
  }),
  backup: Object.freeze({
    export: () => invoke(IPC_CHANNELS.backupExport),
    import: () => invoke(IPC_CHANNELS.backupImport),
  }),
});

contextBridge.exposeInMainWorld("httpSmsDesktop", api);
