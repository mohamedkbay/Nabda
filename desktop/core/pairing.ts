import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { DesktopDatabase } from "./database.js";
import { DesktopRepository } from "./repository.js";
import type { DeviceRecord, PairedDeviceCredentials, PairingOffer } from "./types.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function hashCredential(scope: "pairing" | "device", value: string): string {
  return createHash("sha256").update(`nabda:${scope}:v1:`).update(value, "utf8").digest("hex");
}

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function normalizeLanEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Invalid LAN endpoint");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Pairing endpoint must be a plain HTTP LAN origin");
  }
  if (!isPrivateIpv4(parsed.hostname) || !parsed.port) throw new Error("Pairing endpoint must use a private LAN IPv4 address and port");
  return parsed.origin;
}

function requireDesktopId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{4,24}$/.test(value)) throw new Error("Invalid desktop identifier");
  return value;
}

function credentialFromToken(database: DesktopDatabase, token: string): { deviceId: string; revokedAt: string | null } | null {
  if (!/^[a-zA-Z0-9_-]{40,80}$/.test(token)) return null;
  const row = database.db
    .prepare("SELECT device_id, revoked_at FROM device_credentials WHERE token_hash = ?")
    .get(hashCredential("device", token)) as { device_id: string; revoked_at: string | null } | undefined;
  return row ? { deviceId: row.device_id, revokedAt: row.revoked_at } : null;
}

export class PairingService {
  constructor(
    private readonly database: DesktopDatabase,
    private readonly repository: DesktopRepository,
    private readonly desktopId: string,
  ) {
    requireDesktopId(desktopId);
  }

  createOffer(input: { lanOrigin: string; now?: Date; ttlMs?: number; ttlSeconds?: number }): PairingOffer {
    const endpoint = normalizeLanEndpoint(input.lanOrigin);
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? (input.ttlSeconds === undefined ? FIVE_MINUTES_MS : input.ttlSeconds * 1000);
    if (ttlMs !== FIVE_MINUTES_MS) throw new Error("Pairing TTL must be exactly five minutes");
    const pairingId = randomUUID();
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.database.db
      .prepare("INSERT INTO pairing_sessions(id, code_hash, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)")
      .run(pairingId, hashCredential("pairing", code), expiresAt, now.toISOString());
    const pairingUri = `nabda://pair?v=1&endpoint=${encodeURIComponent(endpoint)}&code=${code}&desktop=${encodeURIComponent(this.desktopId)}`;
    return { pairingId, code, expiresAt, pairingUri, desktopId: this.desktopId };
  }

  claim(input: {
    code: string;
    phone: { name: string; installationId: string; platform: string; appVersion: string };
    now?: Date;
  }): PairedDeviceCredentials {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.code)) throw new Error("Invalid pairing code");
    const now = input.now ?? new Date();
    const at = now.toISOString();
    const token = randomBytes(32).toString("base64url");
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      const codeHash = hashCredential("pairing", input.code);
      const row = this.database.db
        .prepare("SELECT id, expires_at, consumed_at FROM pairing_sessions WHERE code_hash = ?")
        .get(codeHash) as { id: string; expires_at: string; consumed_at: string | null } | undefined;
      if (!row) throw new Error("Invalid pairing code");
      if (row.consumed_at !== null) throw new Error("Pairing code was already used");
      if (new Date(row.expires_at).getTime() <= now.getTime()) throw new Error("Pairing code expired");

      const consumed = this.database.db
        .prepare("UPDATE pairing_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND code_hash = ?")
        .run(at, row.id, codeHash);
      if (consumed.changes !== 1) throw new Error("Pairing code was already used");
      const device = this.repository.createDevice({
        name: input.phone.name,
        installationId: input.phone.installationId,
        platform: input.phone.platform,
        appVersion: input.phone.appVersion,
        status: "connected",
        now,
      });
      this.database.db
        .prepare("INSERT INTO device_credentials(device_id, token_hash, revoked_at, last_seen_at, created_at) VALUES (?, ?, NULL, ?, ?)")
        .run(device.id, hashCredential("device", token), at, at);
      this.database.db.exec("COMMIT");
      return { device, token };
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }

  authenticate(token: string): DeviceRecord | null {
    const credential = credentialFromToken(this.database, token);
    if (!credential || credential.revokedAt !== null) return null;
    const device = this.repository.getDevice(credential.deviceId);
    return device?.status === "revoked" ? null : device;
  }

  heartbeat(token: string, now: Date = new Date()): DeviceRecord | null {
    const credential = credentialFromToken(this.database, token);
    if (!credential || credential.revokedAt !== null) return null;
    const at = now.toISOString();
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.database.db.prepare("UPDATE device_credentials SET last_seen_at = ? WHERE device_id = ?").run(at, credential.deviceId);
      const device = this.repository.updateDeviceStatus(credential.deviceId, "connected", now);
      this.database.db.exec("COMMIT");
      return device;
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }

  revoke(deviceId: string, now: Date = new Date()): boolean {
    const at = now.toISOString();
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.db
        .prepare("UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL")
        .run(at, deviceId);
      this.repository.updateDeviceStatus(deviceId, "revoked", now);
      this.database.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }

  rotate(deviceId: string, now: Date = new Date()): string {
    const token = randomBytes(32).toString("base64url");
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.db
        .prepare("UPDATE device_credentials SET token_hash = ?, revoked_at = NULL, last_seen_at = NULL, created_at = ? WHERE device_id = ?")
        .run(hashCredential("device", token), now.toISOString(), deviceId);
      if (result.changes !== 1) throw new Error("Device credential not found");
      this.repository.updateDeviceStatus(deviceId, "connected", now);
      this.database.db.exec("COMMIT");
      return token;
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }
}
