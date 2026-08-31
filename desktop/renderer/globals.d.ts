import type {
  BackupResult,
  ConnectionTestResult,
  ContactSummary,
  CustomerSummary,
  DashboardSnapshot,
  DesktopSettings,
  DeviceSummary,
  MessageSummary,
  PairingSession,
} from "../contracts.js";

declare global {
  interface Window {
    nabdaDesktop: {
      dashboard: { get(): Promise<DashboardSnapshot> };
      customers: {
        list(): Promise<CustomerSummary[]>;
        create(input: { name: string; phone?: string; notes?: string }): Promise<CustomerSummary>;
      };
      contacts: {
        list(): Promise<ContactSummary[]>;
        create(input: {
          name: string;
          phone: string;
          customerId?: string;
          consentConfirmed: true;
        }): Promise<ContactSummary>;
        setOptOut(input: { id: string; optedOut: boolean }): Promise<ContactSummary>;
      };
      messages: {
        list(input: { limit: number }): Promise<MessageSummary[]>;
        enqueue(input: {
          contactId?: string;
          to: string;
          body: string;
          consentConfirmed: true;
        }): Promise<MessageSummary>;
        cancel(input: { id: string }): Promise<MessageSummary>;
      };
      devices: {
        list(): Promise<DeviceSummary[]>;
        createPairing(): Promise<PairingSession>;
        revoke(input: { id: string }): Promise<{ ok: true }>;
        testHeartbeat(input: { id: string }): Promise<ConnectionTestResult>;
      };
      settings: {
        get(): Promise<DesktopSettings>;
        save(input: object): Promise<DesktopSettings>;
        testProvider(input: object): Promise<ConnectionTestResult>;
      };
      backup: {
        export(): Promise<BackupResult & { cancelled?: boolean }>;
        import(): Promise<BackupResult & { cancelled?: boolean }>;
      };
    };
  }
}

export {};
