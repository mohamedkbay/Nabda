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

export interface DeviceRecord {
  id: string;
  name: string;
  installationId: string | null;
  platform: string | null;
  appVersion: string | null;
  status: "pending" | "connected" | "offline" | "revoked";
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopMessageRecord {
  id: string;
  contactId: string | null;
  deviceId: string | null;
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

export interface QueueJobRecord {
  id: string;
  messageId: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  availableAt: string;
  lockedAt: string | null;
  lastError: string | null;
}

export interface PairingOffer {
  pairingId: string;
  code: string;
  expiresAt: string;
  pairingUri: string;
  desktopId: string;
}

export interface PairedDeviceCredentials {
  device: DeviceRecord;
  token: string;
}
