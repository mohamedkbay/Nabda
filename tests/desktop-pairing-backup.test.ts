import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopDatabase, DesktopRepository, PairingService } from "../desktop/core/index.js";

const databases: DesktopDatabase[] = [];
const directories: string[] = [];

function memoryPairing(): { database: DesktopDatabase; repository: DesktopRepository; pairing: PairingService } {
  const database = new DesktopDatabase(":memory:");
  databases.push(database);
  const repository = new DesktopRepository(database);
  return { database, repository, pairing: new PairingService(database, repository, "desk_A1b2") };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("secure LAN pairing", () => {
  it("creates the exact v1 URI with a 32-byte base64url one-time code and stores only its hash", () => {
    const { database, pairing } = memoryPairing();
    const now = new Date("2026-08-31T12:00:00.000Z");
    const offer = pairing.createOffer({ lanOrigin: "http://192.168.1.9:48191", now });

    expect(Buffer.from(offer.code, "base64url")).toHaveLength(32);
    expect(offer.expiresAt).toBe("2026-08-31T12:05:00.000Z");
    expect(offer.pairingUri).toBe(
      `nabda://pair?v=1&endpoint=http%3A%2F%2F192.168.1.9%3A48191&code=${offer.code}&desktop=desk_A1b2`,
    );
    const stored = database.db.prepare("SELECT code_hash FROM pairing_sessions WHERE id = ?").get(offer.pairingId) as {
      code_hash: string;
    };
    expect(stored.code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.code_hash).not.toContain(offer.code);
    expect(() => pairing.createOffer({ lanOrigin: "http://0.0.0.0:48191", now })).toThrow("private LAN");
    expect(() => pairing.createOffer({ lanOrigin: "https://192.168.1.9:48191", now })).toThrow("plain HTTP LAN");
  });

  it("rejects wrong, expired and reused codes while allowing one successful claim", () => {
    const { pairing } = memoryPairing();
    const now = new Date("2026-08-31T12:00:00.000Z");
    const offer = pairing.createOffer({ lanOrigin: "http://10.0.0.4:48191", now });

    const phone = { name: "Phone", installationId: "install-1", platform: "android", appVersion: "1.0.0" };
    expect(() => pairing.claim({ code: "wrong", phone, now })).toThrow("Invalid");
    const claimed = pairing.claim({ code: offer.code, phone, now });
    expect(Buffer.from(claimed.token, "base64url")).toHaveLength(32);
    expect(pairing.authenticate(claimed.token)?.id).toBe(claimed.device.id);
    expect(() => pairing.claim({ code: offer.code, phone: { ...phone, installationId: "install-2" }, now })).toThrow("already used");

    const expired = pairing.createOffer({ lanOrigin: "http://172.20.1.2:48191", now });
    expect(() =>
      pairing.claim({
        code: expired.code,
        phone: { ...phone, installationId: "install-3" },
        now: new Date(now.getTime() + 300_001),
      }),
    ).toThrow("expired");
  });

  it("supports heartbeat, revoke and token rotation without leaking raw credentials", () => {
    const { database, pairing } = memoryPairing();
    const log = vi.spyOn(console, "log");
    const offer = pairing.createOffer({ lanOrigin: "http://192.168.50.7:48191" });
    const claimed = pairing.claim({
      code: offer.code,
      phone: { name: "Android", installationId: "android-install", platform: "android", appVersion: "1.0.0" },
    });
    const heartbeatAt = new Date("2026-08-31T13:00:00.000Z");

    expect(pairing.heartbeat(claimed.token, heartbeatAt)?.lastSeenAt).toBe(heartbeatAt.toISOString());
    const credential = database.db.prepare("SELECT token_hash, last_seen_at FROM device_credentials WHERE device_id = ?").get(claimed.device.id) as {
      token_hash: string;
      last_seen_at: string;
    };
    expect(credential.token_hash).not.toContain(claimed.token);
    expect(credential.last_seen_at).toBe(heartbeatAt.toISOString());
    expect(pairing.revoke(claimed.device.id)).toBe(true);
    expect(pairing.authenticate(claimed.token)).toBeNull();
    expect(pairing.heartbeat(claimed.token)).toBeNull();

    const rotated = pairing.rotate(claimed.device.id);
    expect(rotated).not.toBe(claimed.token);
    expect(pairing.authenticate(rotated)?.id).toBe(claimed.device.id);
    expect(pairing.authenticate(claimed.token)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("validated atomic backups", () => {
  it("exports, validates and imports a local SQLite backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "nabda-desktop-test-"));
    directories.push(directory);
    const databasePath = join(directory, "nabda.sqlite");
    const backupPath = join(directory, "nabda-backup.sqlite");
    const database = new DesktopDatabase(databasePath);
    databases.push(database);
    const repository = new DesktopRepository(database);
    repository.createClient({ name: "Before backup" });
    database.exportBackup(backupPath);
    DesktopDatabase.validateBackup(backupPath);

    repository.createClient({ name: "After backup" });
    expect(repository.listClients()).toHaveLength(2);
    database.importBackup(backupPath);
    expect(repository.listClients().map((client) => client.name)).toEqual(["Before backup"]);
  });

  it("rejects an invalid backup without replacing current data", () => {
    const directory = mkdtempSync(join(tmpdir(), "nabda-desktop-invalid-"));
    directories.push(directory);
    const databasePath = join(directory, "nabda.sqlite");
    const invalidPath = join(directory, "invalid.sqlite");
    const database = new DesktopDatabase(databasePath);
    databases.push(database);
    const repository = new DesktopRepository(database);
    repository.createClient({ name: "Preserved" });
    writeFileSync(invalidPath, "not a database");

    expect(() => database.importBackup(invalidPath)).toThrow();
    expect(repository.listClients()[0]?.name).toBe("Preserved");
    expect(readFileSync(databasePath).subarray(0, 15).toString()).toBe("SQLite format 3");
  });
});
