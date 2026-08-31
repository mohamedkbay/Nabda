"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  dashboardGet: "httpsms-desktop:dashboard:get",
  customersList: "httpsms-desktop:customers:list",
  customersCreate: "httpsms-desktop:customers:create",
  contactsList: "httpsms-desktop:contacts:list",
  contactsCreate: "httpsms-desktop:contacts:create",
  contactsSetOptOut: "httpsms-desktop:contacts:set-opt-out",
  messagesList: "httpsms-desktop:messages:list",
  messagesEnqueue: "httpsms-desktop:messages:enqueue",
  messagesCancel: "httpsms-desktop:messages:cancel",
  messagesRefreshStatuses: "httpsms-desktop:messages:refresh-statuses",
  campaignsList: "httpsms-desktop:campaigns:list",
  campaignsCreate: "httpsms-desktop:campaigns:create",
  settingsGet: "httpsms-desktop:settings:get",
  settingsSave: "httpsms-desktop:settings:save",
  settingsTestProvider: "httpsms-desktop:settings:test-provider",
  backupExport: "httpsms-desktop:backup:export",
  backupImport: "httpsms-desktop:backup:import",
});
const invoke = (channel, input) => ipcRenderer.invoke(channel, input);

contextBridge.exposeInMainWorld(
  "httpSmsDesktop",
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
      refreshStatuses: (input) => invoke(channels.messagesRefreshStatuses, input),
    }),
    campaigns: Object.freeze({
      list: () => invoke(channels.campaignsList),
      create: (input) => invoke(channels.campaignsCreate, input),
    }),
    settings: Object.freeze({
      get: () => invoke(channels.settingsGet),
      save: (input) => invoke(channels.settingsSave, input),
      testProvider: () => invoke(channels.settingsTestProvider),
    }),
    backup: Object.freeze({
      export: () => invoke(channels.backupExport),
      import: () => invoke(channels.backupImport),
    }),
  }),
);
