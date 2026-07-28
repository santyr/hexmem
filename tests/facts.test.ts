import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import { factsHandler } from "../src/tools/facts.ts";

describe("factsHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;

    // Insert test data
    // 1. Public fact in domain "code"
    db.prepare(
      `INSERT INTO facts (subject_text, predicate, object_text, domain, sensitivity, status, access_count, consolidation_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("TypeScript", "is_language_of", "hexmem-ts", "code", "public", "active", 5, "active");

    // 2. Private fact in domain "security"
    db.prepare(
      `INSERT INTO facts (subject_text, predicate, object_text, domain, sensitivity, status, access_count, consolidation_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("API_KEY", "stored_in", "vault", "security", "private", "active", 0, "active");

    // 3. Public fact in domain "code" with old last_accessed_at and consolidation_state="fading"
    db.prepare(
      `INSERT INTO facts (subject_text, predicate, object_text, domain, sensitivity, status, access_count, consolidation_state, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("Python", "also_used_for", "hexmem", "code", "public", "active", 1, "fading", "2024-01-01T00:00:00");
  });

  after(() => {
    db.close();
  });

  it("returns all active facts when no filters given", async () => {
    const json = await factsHandler({}, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows), "should return array");
    assert.equal(rows.length, 3, "should return all 3 active facts");
  });

  it("excludes private facts when max_sensitivity is 'public'", async () => {
    const json = await factsHandler({ max_sensitivity: "public" }, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.equal(row.sensitivity, "public", "all returned rows should be public");
    }
    const hasPrivate = rows.some((r: Record<string, unknown>) => r.domain === "security");
    assert.equal(hasPrivate, false, "should not include private/security facts");
  });

  it("filters by domain", async () => {
    const json = await factsHandler({ domain: "code" }, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2, "should return exactly 2 code-domain facts");
    for (const row of rows) {
      assert.equal(row.domain, "code");
    }
  });

  it("returns error JSON for invalid max_sensitivity", async () => {
    const json = await factsHandler({ max_sensitivity: "confidential" }, db);
    const result = JSON.parse(json);
    assert.ok("error" in result, "should have error key");
    assert.ok(result.error.includes("Invalid max_sensitivity"), "error message should mention field name");
  });

  it("increments access_count after query (reconsolidation)", async () => {
    // Get initial access_count of the TypeScript fact
    const before = db.prepare(
      "SELECT access_count FROM facts WHERE subject_text = 'TypeScript'"
    ).get() as { access_count: number };
    const countBefore = before.access_count;

    await factsHandler({ domain: "code" }, db);

    const after = db.prepare(
      "SELECT access_count FROM facts WHERE subject_text = 'TypeScript'"
    ).get() as { access_count: number };
    assert.equal(after.access_count, countBefore + 1, "access_count should increment by 1");
  });

  it("promotes fading fact back to active after retrieval", async () => {
    // Verify the Python fact starts as fading — reset it first since earlier tests may have changed it
    db.prepare("UPDATE facts SET consolidation_state = 'fading' WHERE subject_text = 'Python'").run();

    const beforeRow = db.prepare(
      "SELECT consolidation_state FROM facts WHERE subject_text = 'Python'"
    ).get() as { consolidation_state: string };
    assert.equal(beforeRow.consolidation_state, "fading", "should start as fading");

    // Query it
    await factsHandler({ domain: "code" }, db);

    // Now it should be active
    const afterRow = db.prepare(
      "SELECT consolidation_state FROM facts WHERE subject_text = 'Python'"
    ).get() as { consolidation_state: string };
    assert.equal(afterRow.consolidation_state, "active", "fading fact should be promoted to active after retrieval");
  });
});
