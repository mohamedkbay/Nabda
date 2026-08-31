import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DESKTOP_SCHEMA_VERSION, desktopMigrations } from "./migrations.js";

const REQUIRED_TABLES = [
  "clients",
  "contacts",
  "opt_outs",
  "devices",
  "device_credentials",
  "pairing_sessions",
  "settings",
  "messages",
  "message_events",
  "queue_jobs",
] as const;

export class DesktopDatabase {
  readonly path: string;
  private database: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:" && !resolve(path).startsWith(resolve(dirname(path)))) {
      throw new Error("Invalid database path");
    }
    this.path = path;
    this.database = new DatabaseSync(path);
    this.configure();
    this.migrate();
  }

  get db(): DatabaseSync {
    if (this.closed) throw new Error("Database is closed");
    return this.database;
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  exportBackup(destinationPath: string): void {
    if (this.path === ":memory:") throw new Error("In-memory databases cannot be exported");
    const destination = resolve(destinationPath);
    if (destination === resolve(this.path)) throw new Error("Backup destination must differ from database path");
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    copyFileSync(this.path, destination);
    DesktopDatabase.validateBackup(destination);
  }

  importBackup(sourcePath: string): void {
    if (this.path === ":memory:") throw new Error("In-memory databases cannot import backups");
    const source = resolve(sourcePath);
    const target = resolve(this.path);
    if (source === target) throw new Error("Backup source must differ from database path");
    DesktopDatabase.validateBackup(source);

    const staged = `${target}.importing`;
    const rollback = `${target}.rollback`;
    rmSync(staged, { force: true });
    rmSync(rollback, { force: true });
    copyFileSync(source, staged);
    DesktopDatabase.validateBackup(staged);

    this.close();
    try {
      if (existsSync(target)) renameSync(target, rollback);
      renameSync(staged, target);
      this.database = new DatabaseSync(target);
      this.closed = false;
      this.configure();
      this.migrate();
      rmSync(rollback, { force: true });
    } catch (error) {
      if (existsSync(target)) rmSync(target, { force: true });
      if (existsSync(rollback)) renameSync(rollback, target);
      this.database = new DatabaseSync(target);
      this.closed = false;
      this.configure();
      throw error;
    } finally {
      rmSync(staged, { force: true });
    }
  }

  static validateBackup(path: string): void {
    const candidate = new DatabaseSync(path, { readOnly: true });
    try {
      const integrity = candidate.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
      if (!integrity || !Object.values(integrity).includes("ok")) throw new Error("Backup integrity check failed");

      const version = candidate.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
      if (Number(Object.values(version ?? {})[0]) > DESKTOP_SCHEMA_VERSION) {
        throw new Error("Backup was created by a newer application version");
      }
      const tableRows = candidate
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tables = new Set(tableRows.map((row) => row.name));
      if (REQUIRED_TABLES.some((table) => !tables.has(table))) throw new Error("Backup schema is incomplete");
    } finally {
      candidate.close();
    }
  }

  private configure(): void {
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (this.path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const currentRow = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as
      | { version: number }
      | undefined;
    let current = Number(currentRow?.version ?? 0);
    if (current > DESKTOP_SCHEMA_VERSION) throw new Error("Database schema is newer than this application");

    for (const migration of desktopMigrations) {
      if (migration.version <= current) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(migration.sql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
        this.database.exec("COMMIT");
        current = migration.version;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}
