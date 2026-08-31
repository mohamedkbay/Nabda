import type {
  DeviceAgentEventStatus,
  DeviceAgentPrincipal,
} from "../domain/types.js";
import {
  deviceLeaseDigest,
  deviceTokenPrefix,
  generateDeviceLease,
  verifyDeviceToken,
} from "../lib/crypto.js";
import type { Repository } from "../repositories/repository.js";

const LEASE_DURATION_MS = 2 * 60 * 1000;
const ATTEMPT_LEASE_DURATION_MS = 15 * 60 * 1000;

export class DeviceAgentService {
  constructor(
    private readonly repository: Repository,
    private readonly hashSecret: string,
    private readonly liveModeEnabled = false,
  ) {}

  async authenticate(rawToken: string, now = new Date()): Promise<DeviceAgentPrincipal | null> {
    const prefix = deviceTokenPrefix(rawToken);
    if (!prefix) return null;
    const record = await this.repository.findDeviceAgentCredentialByPrefix(prefix);
    if (
      !record
      || record.revokedAt
      || record.organizationStatus !== "active"
      || !["active", "offline"].includes(record.deviceStatus)
      || (record.mode === "live" && !this.liveModeEnabled)
      || !verifyDeviceToken(rawToken, record.tokenHash, this.hashSecret)
    ) return null;
    void this.repository.touchDeviceAgentCredential(record.credentialId, now).catch(() => undefined);
    return {
      credentialId: record.credentialId,
      organizationId: record.organizationId,
      deviceId: record.deviceId,
      organizationStatus: record.organizationStatus,
      deviceStatus: record.deviceStatus,
      mode: record.mode,
    };
  }

  matchesRequestedMode(principal: DeviceAgentPrincipal, simulated: boolean): boolean {
    return principal.mode === (simulated ? "simulation" : "live");
  }

  async heartbeat(
    principal: DeviceAgentPrincipal,
    telemetry: Record<string, unknown>,
    at: Date,
  ): Promise<boolean> {
    return this.repository.heartbeatDeviceAgent({
      principal,
      telemetry: {
        ...telemetry,
        simulated: principal.mode === "simulation",
        agent_mode: principal.mode,
      },
      at,
    });
  }

  async claim(principal: DeviceAgentPrincipal, at: Date) {
    const lease = generateDeviceLease(this.hashSecret);
    const leaseExpiresAt = new Date(at.getTime() + LEASE_DURATION_MS);
    const result = await this.repository.claimDeviceAgentMessage({
      principal,
      leaseTokenHash: lease.hash,
      leaseExpiresAt,
      at,
    });
    return { result, rawLeaseToken: lease.rawToken };
  }

  async begin(input: {
    principal: DeviceAgentPrincipal;
    messageId: string;
    attemptId: string;
    leaseToken: string;
    dispatchMinIntervalMs: number;
    at: Date;
  }) {
    return this.repository.beginDeviceAgentMessage({
      principal: input.principal,
      messageId: input.messageId,
      attemptId: input.attemptId,
      leaseTokenHash: deviceLeaseDigest(input.leaseToken, this.hashSecret),
      attemptLeaseExpiresAt: new Date(input.at.getTime() + ATTEMPT_LEASE_DURATION_MS),
      dispatchMinIntervalMs: input.dispatchMinIntervalMs,
      at: input.at,
    });
  }

  async recordEvent(input: {
    principal: DeviceAgentPrincipal;
    messageId: string;
    eventId: string;
    attemptId: string;
    leaseToken: string;
    requestHash: string;
    requestedStatus: DeviceAgentEventStatus;
    providerMessageId?: string;
    errorCode?: string;
    errorMessage?: string;
    occurredAt: Date;
    at: Date;
  }) {
    return this.repository.recordDeviceAgentEvent({
      principal: input.principal,
      messageId: input.messageId,
      eventId: input.eventId,
      attemptId: input.attemptId,
      leaseTokenHash: deviceLeaseDigest(input.leaseToken, this.hashSecret),
      requestHash: input.requestHash,
      requestedStatus: input.requestedStatus,
      ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      occurredAt: input.occurredAt,
      at: input.at,
    });
  }
}
