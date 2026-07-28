import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export type MigrationResult = {
  applied: number;
  filenames: string[];
};

export function listMigrationFiles(directory = DEFAULT_MIGRATIONS_DIR): string[] {
  return readdirSync(directory)
    .filter((name) => /^[0-9][0-9A-Za-z_-]*\.sql$/.test(name))
    .sort();
}

export function applyMigrations(
  db: Database.Database,
  directory = DEFAULT_MIGRATIONS_DIR,
): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied: string[] = [];
  const hasMigration = db.prepare("SELECT 1 FROM _migrations WHERE filename = ?");
  const recordMigration = db.prepare("INSERT INTO _migrations (filename) VALUES (?)");

  for (const filename of listMigrationFiles(directory)) {
    if (hasMigration.get(filename)) continue;
    const sql = readFileSync(join(directory, filename), "utf8");
    db.transaction(() => {
      db.exec(sql);
      recordMigration.run(filename);
    })();
    applied.push(filename);
  }

  return { applied: applied.length, filenames: applied };
}
