import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getDbForPath, resolveDbPath } from "../src/db.ts";

test("database path precedence is HEXMEM_DB then data dir then XDG then home", () => {
  assert.equal(resolveDbPath({ HEXMEM_DB: "/tmp/explicit.db", HEXMEM_DATA_DIR: "/ignored" }, "/workspace/example"), "/tmp/explicit.db");
  assert.equal(resolveDbPath({ HEXMEM_DATA_DIR: "/tmp/data" }, "/workspace/example"), "/tmp/data/hexmem.db");
  assert.equal(resolveDbPath({ XDG_DATA_HOME: "/tmp/xdg" }, "/workspace/example"), "/tmp/xdg/hexmem/hexmem.db");
  assert.equal(resolveDbPath({}, "/workspace/example"), "/workspace/example/.local/share/hexmem/hexmem.db");
});

test("opening a new database creates only its parent with private permissions", () => {
  const home = mkdtempSync(join(tmpdir(), "hexmem-empty-home-"));
  const path = join(home, ".local", "share", "hexmem", "hexmem.db");
  const db = getDbForPath(path);
  try {
    assert.equal(statSync(join(home, ".local", "share", "hexmem")).mode & 0o777, 0o700);
  } finally {
    db.close();
  }
});
