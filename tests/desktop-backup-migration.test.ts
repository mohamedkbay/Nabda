import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopDatabase, DesktopRepository, desktopMigrations } from "../desktop/core/index.js";

const dirs: string[] = [];
const dbs: DesktopDatabase[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("desktop migration and backup", () => {
  it("upgrades an existing historical v1 database without losing messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "httpsms-desktop-v1-")); dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    old.exec(desktopMigrations[0]?.sql ?? "");
    old.prepare("INSERT INTO schema_migrations VALUES (1, 'initial_local_schema', ?)").run(new Date().toISOString());
    old.exec("PRAGMA user_version=1");
    old.prepare("INSERT INTO messages(id, phone, content, status, scheduled_at, created_at, updated_at) VALUES ('old-1', '+218910000001', 'old', 'queued', '2026-01-01', '2026-01-01', '2026-01-01')").run();
    old.close();
    const upgraded = new DesktopDatabase(path); dbs.push(upgraded);
    expect(upgraded.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(new DesktopRepository(upgraded).getMessage("old-1")?.content).toBe("old");
    expect(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE name='campaign_recipients'").get()).toBeTruthy();
    expect(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE name='pairing_sessions'").get()).toBeUndefined();
  });

  it("exports and atomically imports validated backups", () => {
    const dir = mkdtempSync(join(tmpdir(), "httpsms-desktop-backup-")); dirs.push(dir);
    const path = join(dir, "desktop.sqlite"); const backup = join(dir, "backup.sqlite");
    const db = new DesktopDatabase(path); dbs.push(db); const repo = new DesktopRepository(db);
    repo.createClient({ name: "Before" }); db.exportBackup(backup); repo.createClient({ name: "After" });
    db.importBackup(backup);
    expect(repo.listClients().map((client) => client.name)).toEqual(["Before"]);
    const invalid = join(dir, "invalid.sqlite"); writeFileSync(invalid, "invalid");
    expect(() => db.importBackup(invalid)).toThrow();
    expect(repo.listClients()).toHaveLength(1);
  });
});
