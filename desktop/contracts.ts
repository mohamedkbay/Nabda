/**
 * DTOs crossing the Electron IPC boundary. Keep these JSON serialisable and
 * free of credentials. Provider secrets are owned by the main process only.
 */
export type EntityId = string;

export interface DashboardSnapshot {
  customers: number;
  contacts: number;
  queuedMessages: number;
  sentToday: number;
  failedToday: number;
  integrationConfigured: boolean;
  recentMessages: MessageSummary[];
}

export interface CustomerSummary {
  id: EntityId;
  name: string;
  phone?: string;
  notes?: string;
  createdAt: string;
}

export interface ContactSummary {
  id: EntityId;
  customerId?: EntityId;
  customerName?: string;
  name: string;
  phone: string;
  optedOut: boolean;
  createdAt: string;
}

export type DesktopMessageStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "expired"
  | "cancelled";

export interface MessageSummary {
  id: EntityId;
  contactName?: string;
  to: string;
  bodyPreview: string;
  status: DesktopMessageStatus;
  createdAt: string;
}

export interface DesktopSettings {
  from?: string;
  secretConfigured: boolean;
  encryptedDefault: boolean;
  statusPollingSeconds: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  checkedAt: string;
}

export interface CampaignSummary {
  id: EntityId;
  name: string;
  recipientCount: number;
  queuedCount: number;
  sentCount: number;
  failedCount: number;
  startsAt: string;
  status: "scheduled" | "running" | "completed" | "attention";
  createdAt: string;
}

export interface BackupResult {
  ok: boolean;
  fileName: string;
  message: string;
}

export interface DesktopServices {
  dashboard: {
    getSnapshot(): Promise<DashboardSnapshot>;
  };
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
    refreshStatuses(input: { limit: number; secret: string }): Promise<MessageSummary[]>;
  };
  campaigns: {
    list(): Promise<CampaignSummary[]>;
    create(input: {
      name: string;
      body: string;
      contactIds: string[];
      startsAt: string;
      messagesPerMinute: number;
      encrypted: boolean;
      consentConfirmed: true;
    }): Promise<CampaignSummary>;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    save(input: {
      from?: string;
      encryptedDefault: boolean;
      statusPollingSeconds: number;
    }): Promise<DesktopSettings>;
    /** Connection metadata only. This method must never send an SMS. */
    testProviderConnection(input: {
      secret: string;
      from?: string;
    }): Promise<ConnectionTestResult>;
  };
  backup: {
    exportTo(targetPath: string): Promise<BackupResult>;
    validateAndImportFrom(sourcePath: string): Promise<BackupResult>;
  };
}
