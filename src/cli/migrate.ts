import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { getDbForPath, resolveDbPath } from "../db.js";
import { applyMigrations, listMigrationFiles } from "../migrations.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const path = option("--db") ?? resolveDbPath();
const db = getDbForPath(path);
try {
  const expected = listMigrationFiles();
  const first = applyMigrations(db);
  const schema = db
    .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all();
  const fingerprint = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  const second = applyMigrations(db);
  const schemaAfter = db
    .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all();
  const fingerprintAfter = createHash("sha256").update(JSON.stringify(schemaAfter)).digest("hex");
  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  const report = {
    status:
      second.applied === 0 &&
      fingerprint === fingerprintAfter &&
      foreignKeyViolations.length === 0
        ? "pass"
        : "fail",
    database: path,
    retained_migrations: expected.length,
    first_applied: first.applied,
    second_applied: second.applied,
    schema_sha256: fingerprint,
    schema_unchanged: fingerprint === fingerprintAfter,
    foreign_key_violations: foreignKeyViolations.length,
  };
  const output = JSON.stringify(report, null, 2) + "\n";
  const reportPath = option("--report");
  if (reportPath) writeFileSync(reportPath, output, { mode: 0o600 });
  process.stdout.write(output);
  if (report.status !== "pass") process.exitCode = 1;
} finally {
  db.close();
}
