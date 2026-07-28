import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("configured application database initializes under an empty synthetic home", async () => {
  const home = mkdtempSync(join(tmpdir(), "hexmem-runtime-home-"));
  const previous = {
    HOME: process.env.HOME,
    HEXMEM_DB: process.env.HEXMEM_DB,
    HEXMEM_DATA_DIR: process.env.HEXMEM_DATA_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.HOME = home;
  delete process.env.HEXMEM_DB;
  delete process.env.HEXMEM_DATA_DIR;
  delete process.env.XDG_DATA_HOME;

  const dbTools = await import("../src/db.ts");
  try {
    const db = dbTools.getDb();
    const migrations = db.prepare("SELECT filename FROM _migrations ORDER BY filename").all();
    assert.equal(migrations.length, 1);
    assert.ok(existsSync(join(home, ".local", "share", "hexmem", "hexmem.db")));
  } finally {
    dbTools.closeDb();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
