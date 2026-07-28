import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { applyMigrations, listMigrationFiles } from "../src/migrations.ts";

test("real migration creates the complete schema and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "hexmem-migrations-"));
  const path = join(root, "hexmem.db");
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    const expected = listMigrationFiles();
    assert.deepEqual(expected, ["001_schema.sql"]);

    const first = applyMigrations(db);
    assert.equal(first.applied, 1);
    assert.deepEqual(first.filenames, expected);

    const rows = db.prepare("SELECT filename FROM _migrations ORDER BY filename").all() as Array<{ filename: string }>;
    assert.deepEqual(rows.map((row) => row.filename), expected);
    assert.deepEqual(db.pragma("foreign_key_check"), []);

    for (const table of ["identity", "facts", "events", "lessons", "observations", "tasks", "embedding_queue"]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
    }
    for (const fts of ["facts_fts", "events_fts", "lessons_fts", "seeds_fts"]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(fts), fts);
    }
    for (const trigger of ["facts_ai", "facts_au", "facts_ad", "events_ai", "lessons_ai", "seeds_ai"]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger), trigger);
    }

    const schemaBefore = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const second = applyMigrations(db);
    const schemaAfter = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    assert.deepEqual(second, { applied: 0, filenames: [] });
    assert.deepEqual(schemaAfter, schemaBefore);

    const sql = readFileSync(join(dirname(new URL(import.meta.url).pathname), "..", "migrations", "001_schema.sql"), "utf8");
    const withoutTriggerBodies = sql.replace(/CREATE\s+TRIGGER\b[\s\S]*?\nEND\s*;/gi, "");
    assert.doesNotMatch(withoutTriggerBodies, /(?:^|;)\s*(?:INSERT|UPDATE|DELETE)\b/im, "baseline migration must be DDL-only");
  } finally {
    db.close();
  }
});
