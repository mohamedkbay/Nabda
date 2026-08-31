import type {
  BackupResult,
  CampaignSummary,
  ConnectionTestResult,
  ContactSummary,
  CustomerSummary,
  DashboardSnapshot,
  DesktopSettings,
  MessageSummary,
} from "../contracts.js";

declare global {
  interface Window {
    httpSmsDesktop: {
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
          sendAt?: string;
          encrypted: boolean;
          requestId?: string;
          consentConfirmed: true;
        }): Promise<MessageSummary>;
        cancel(input: { id: string }): Promise<MessageSummary>;
        refreshStatuses(input: { limit: number }): Promise<MessageSummary[]>;
      };
      campaigns: {
        list(): Promise<CampaignSummary[]>;
        create(input: object): Promise<CampaignSummary>;
      };
      settings: {
        get(): Promise<DesktopSettings>;
        save(input: object): Promise<DesktopSettings>;
        testProvider(): Promise<ConnectionTestResult>;
      };
      backup: {
        export(): Promise<BackupResult & { cancelled?: boolean }>;
        import(): Promise<BackupResult & { cancelled?: boolean }>;
      };
    };
  }
}

export {};
