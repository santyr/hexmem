import type Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDbForPath } from "../src/db.js";
import { applyMigrations } from "../src/migrations.js";

/**
 * Creates a temporary SQLite database from the same migration authority used
 * by the runtime. A file-backed database keeps FTS5 behavior representative.
 */
export function createTestDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "hexmem-test-"));
  const path = join(dir, "hexmem.db");
  const db = getDbForPath(path);
  applyMigrations(db);
  return { db, path };
}
