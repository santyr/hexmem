import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.ts";

describe("createTestDb", () => {
  const { db, path } = createTestDb();

  after(() => db.close());

  it("returns a valid path string", () => {
    assert.ok(typeof path === "string" && path.length > 0);
  });

  const expectedTables = [
    "facts", "events", "lessons", "identity", "identity_seeds",
    "entities", "entity_aliases", "ethics", "domain_sensitivity", "review_log",
    "memory_seeds", "core_values", "self_schemas", "tasks",
    "narrative_threads", "meaning_frames", "priming_state", "daily_logs",
  ];

  for (const table of expectedTables) {
    it(`has table: ${table}`, () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      assert.ok(row, `table '${table}' not found`);
    });
  }

  const expectedFts = ["facts_fts", "events_fts", "lessons_fts", "seeds_fts"];

  for (const fts of expectedFts) {
    it(`has FTS5 virtual table: ${fts}`, () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(fts);
      assert.ok(row, `FTS5 table '${fts}' not found`);
    });
  }

  it("can insert and query a fact", () => {
    db.prepare(
      `INSERT INTO facts (subject_text, predicate, object_text) VALUES (?, ?, ?)`
    ).run("AgentExample", "is", "a synthetic agent");
    const row = db.prepare("SELECT * FROM facts WHERE subject_text = ?").get("AgentExample") as Record<string, unknown> | undefined;
    assert.ok(row, "inserted fact not found");
    assert.equal(row["predicate"], "is");
    assert.equal(row["object_text"], "a synthetic agent");
    assert.equal(row["sensitivity"], "private");
    assert.equal(row["status"], "active");
  });

  it("can insert and query an event", () => {
    db.prepare(
      `INSERT INTO events (event_type, summary) VALUES (?, ?)`
    ).run("milestone", "Test event created");
    const row = db.prepare("SELECT * FROM events WHERE event_type = ?").get("milestone") as Record<string, unknown> | undefined;
    assert.ok(row, "inserted event not found");
    assert.equal(row["summary"], "Test event created");
  });

  it("can insert and query a lesson", () => {
    db.prepare(
      `INSERT INTO lessons (domain, lesson) VALUES (?, ?)`
    ).run("testing", "Always write tests first");
    const row = db.prepare("SELECT * FROM lessons WHERE domain = ?").get("testing") as Record<string, unknown> | undefined;
    assert.ok(row, "inserted lesson not found");
    assert.equal(row["lesson"], "Always write tests first");
  });

  it("enforces sensitivity CHECK constraint on facts", () => {
    assert.throws(() => {
      db.prepare(
        `INSERT INTO facts (subject_text, predicate, sensitivity) VALUES (?, ?, ?)`
      ).run("X", "test", "invalid");
    });
  });

  it("daily_logs uses the current summary/details schema", () => {
    const rows = db.prepare("PRAGMA table_info(daily_logs)").all() as Array<{
      name: string;
    }>;
    const names = rows.map((row) => row.name);
    assert.deepEqual(
      names,
      ["id", "day", "ts", "kind", "summary", "details", "source", "tags"],
    );
  });
});
