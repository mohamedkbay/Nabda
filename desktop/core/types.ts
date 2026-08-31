export type DesktopMessageStatus =
  | "queued"
  | "processing"
  | "sent"
  | "delivered"
  | "failed"
  | "expired"
  | "cancelled";

export interface ClientRecord {
  id: string;
  name: string;
  email: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactRecord {
  id: string;
  clientId: string | null;
  name: string;
  phone: string;
  consentReference: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DesktopMessageRecord {
  id: string;
  contactId: string | null;
  campaignId: string | null;
  to: string;
  content: string;
  status: DesktopMessageStatus;
  providerMessageId: string | null;
  failureReason: string | null;
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageEventRecord {
  id: string;
  messageId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CampaignRecord {
  id: string;
  name: string;
  content: string;
  status: "draft" | "scheduled" | "running" | "completed" | "cancelled";
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface QueueJobRecord {
  id: string;
  messageId: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  availableAt: string;
  lockedAt: string | null;
  lastError: string | null;
}
