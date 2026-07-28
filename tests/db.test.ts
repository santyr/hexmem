import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDbForPath } from "../src/db.ts";

test("getDbForPath opens the requested DB with WAL and foreign keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexmem-db-helper-"));
  const path = join(dir, "hexmem.db");
  const db = getDbForPath(path);

  try {
    const journalMode = db.pragma("journal_mode", { simple: true });
    const foreignKeys = db.pragma("foreign_keys", { simple: true });

    assert.equal(String(journalMode).toLowerCase(), "wal");
    assert.equal(foreignKeys, 1);
  } finally {
    db.close();
  }
});
