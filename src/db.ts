import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { applyMigrations } from "./migrations.js";

const require = createRequire(import.meta.url);

let vecLoadFailed = false;

function loadSqliteVec(db: Database.Database): void {
  if (vecLoadFailed) return;
  try {
    const sqliteVec = require("sqlite-vec") as { load(db: Database.Database): void };
    sqliteVec.load(db);
  } catch (error) {
    vecLoadFailed = true;
    console.error(`hexmem: sqlite-vec unavailable, vector search disabled: ${error}`);
  }
}

export function resolveDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME ?? homedir(),
): string {
  if (env.HEXMEM_DB) return env.HEXMEM_DB;
  if (env.HEXMEM_DATA_DIR) return join(env.HEXMEM_DATA_DIR, "hexmem.db");
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "hexmem", "hexmem.db");
  return join(home, ".local", "share", "hexmem", "hexmem.db");
}

function prepareParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function configure(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  loadSqliteVec(db);
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const path = resolveDbPath();
    prepareParent(path);
    _db = new Database(path);
    configure(_db);
    applyMigrations(_db);
  }
  return _db;
}

export function getDbForPath(path: string): Database.Database {
  prepareParent(path);
  const db = new Database(path);
  configure(db);
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
