import { test, describe } from "node:test";
import assert from "node:assert";
import { createTestDb } from "./helpers.js";

describe("FTS sync triggers (migration 023 parity)", () => {
  test("event insert/update/delete stays in sync with events_fts", () => {
    const { db } = createTestDb();

    const { lastInsertRowid: id } = db
      .prepare("INSERT INTO events (event_type, summary, category) VALUES ('milestone', 'deployed frobnicator', 'project')")
      .run();

    const findRows = (term: string) =>
      db.prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?").all(term);

    assert.equal(findRows("frobnicator").length, 1);

    db.prepare("UPDATE events SET summary = 'deployed widgetizer' WHERE id = ?").run(id);
    assert.equal(findRows("frobnicator").length, 0);
    assert.equal(findRows("widgetizer").length, 1);

    db.prepare("DELETE FROM events WHERE id = ?").run(id);
    assert.equal(findRows("widgetizer").length, 0);
  });

  test("lesson insert/update/delete stays in sync with lessons_fts", () => {
    const { db } = createTestDb();

    const { lastInsertRowid: id } = db
      .prepare("INSERT INTO lessons (domain, lesson) VALUES ('operations', 'ProjectAlpha records need care')")
      .run();

    const findRows = (term: string) =>
      db.prepare("SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH ?").all(term);

    assert.equal(findRows("ProjectAlpha").length, 1);

    db.prepare("UPDATE lessons SET lesson = 'qblorp channels need care' WHERE id = ?").run(id);
    assert.equal(findRows("ProjectAlpha").length, 0);
    assert.equal(findRows("qblorp").length, 1);

    db.prepare("DELETE FROM lessons WHERE id = ?").run(id);
    assert.equal(findRows("qblorp").length, 0);
  });

  test("memory seed insert stays in sync with seeds_fts", () => {
    const { db } = createTestDb();

    db.prepare("INSERT INTO memory_seeds (seed_type, seed_text) VALUES ('consolidation', 'xkremba pattern')").run();

    const rows = db.prepare("SELECT rowid FROM seeds_fts WHERE seeds_fts MATCH 'xkremba'").all();
    assert.equal(rows.length, 1);
  });

  test("fact insert is indexed in facts_fts", () => {
    const { db } = createTestDb();

    db.prepare("INSERT INTO facts (subject_text, predicate, object_text, domain) VALUES ('WorkerExample', 'runs', 'ExamplePlugin', 'operations')").run();

    const rows = db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH 'ExamplePlugin'").all();
    assert.equal(rows.length, 1);
  });
});
