"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  dashboardGet: "nabda:dashboard:get",
  customersList: "nabda:customers:list",
  customersCreate: "nabda:customers:create",
  contactsList: "nabda:contacts:list",
  contactsCreate: "nabda:contacts:create",
  contactsSetOptOut: "nabda:contacts:set-opt-out",
  messagesList: "nabda:messages:list",
  messagesEnqueue: "nabda:messages:enqueue",
  messagesCancel: "nabda:messages:cancel",
  devicesList: "nabda:devices:list",
  devicesCreatePairing: "nabda:devices:create-pairing",
  devicesRevoke: "nabda:devices:revoke",
  devicesTestHeartbeat: "nabda:devices:test-heartbeat",
  settingsGet: "nabda:settings:get",
  settingsSave: "nabda:settings:save",
  settingsTestProvider: "nabda:settings:test-provider",
  backupExport: "nabda:backup:export",
  backupImport: "nabda:backup:import",
});
const invoke = (channel, input) => ipcRenderer.invoke(channel, input);

contextBridge.exposeInMainWorld(
  "nabdaDesktop",
  Object.freeze({
    dashboard: Object.freeze({ get: () => invoke(channels.dashboardGet) }),
    customers: Object.freeze({
      list: () => invoke(channels.customersList),
      create: (input) => invoke(channels.customersCreate, input),
    }),
    contacts: Object.freeze({
      list: () => invoke(channels.contactsList),
      create: (input) => invoke(channels.contactsCreate, input),
      setOptOut: (input) => invoke(channels.contactsSetOptOut, input),
    }),
    messages: Object.freeze({
      list: (input) => invoke(channels.messagesList, input),
      enqueue: (input) => invoke(channels.messagesEnqueue, input),
      cancel: (input) => invoke(channels.messagesCancel, input),
    }),
    devices: Object.freeze({
      list: () => invoke(channels.devicesList),
      createPairing: () => invoke(channels.devicesCreatePairing),
      revoke: (input) => invoke(channels.devicesRevoke, input),
      testHeartbeat: (input) => invoke(channels.devicesTestHeartbeat, input),
    }),
    settings: Object.freeze({
      get: () => invoke(channels.settingsGet),
      save: (input) => invoke(channels.settingsSave, input),
      testProvider: (input) => invoke(channels.settingsTestProvider, input),
    }),
    backup: Object.freeze({
      export: () => invoke(channels.backupExport),
      import: () => invoke(channels.backupImport),
    }),
  }),
);
