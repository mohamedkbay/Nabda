export const IPC_CHANNELS = {
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
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
