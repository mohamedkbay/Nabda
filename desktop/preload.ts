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
  }),
  devices: Object.freeze({
    list: () => invoke(IPC_CHANNELS.devicesList),
    createPairing: () => invoke(IPC_CHANNELS.devicesCreatePairing),
    revoke: (input: unknown) => invoke(IPC_CHANNELS.devicesRevoke, input),
    testHeartbeat: (input: unknown) => invoke(IPC_CHANNELS.devicesTestHeartbeat, input),
  }),
  settings: Object.freeze({
    get: () => invoke(IPC_CHANNELS.settingsGet),
    save: (input: unknown) => invoke(IPC_CHANNELS.settingsSave, input),
    testProvider: (input: unknown) => invoke(IPC_CHANNELS.settingsTestProvider, input),
  }),
  backup: Object.freeze({
    export: () => invoke(IPC_CHANNELS.backupExport),
    import: () => invoke(IPC_CHANNELS.backupImport),
  }),
});

contextBridge.exposeInMainWorld("nabdaDesktop", api);
