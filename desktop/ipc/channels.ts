export const IPC_CHANNELS = {
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
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
