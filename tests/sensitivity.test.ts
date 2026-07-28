import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import {
  factAddHandler,
  factSupersedeHandler,
} from "../src/tools/facts.ts";
import { eventAddHandler } from "../src/tools/events.ts";
import { lessonAddHandler } from "../src/tools/lessons.ts";

describe("sensitivity resolution", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;

    // Seed domain_sensitivity table
    db.prepare(
      "INSERT INTO domain_sensitivity (domain, subject, sensitivity) VALUES (?, ?, ?)"
    ).run("security", "", "private");
    db.prepare(
      "INSERT INTO domain_sensitivity (domain, subject, sensitivity) VALUES (?, ?, ?)"
    ).run("financial", "", "private");
    db.prepare(
      "INSERT INTO domain_sensitivity (domain, subject, sensitivity) VALUES (?, ?, ?)"
    ).run("social", "AgentExample", "private");
  });

  after(() => {
    db.close();
  });

  // Test 1: fact auto-gets sensitivity="private" from domain_sensitivity table
  it("factAddHandler: security domain auto-gets private sensitivity", async () => {
    const result = await factAddHandler(
      {
        predicate: "has_key",
        subject_text: "server",
        object_text: "xyz",
        domain: "security",
      },
      db
    );
    const parsed = JSON.parse(result);
    assert.ok(!("error" in parsed), `should not have error: ${result}`);
    assert.ok("id" in parsed, "should have id");
    assert.equal(parsed.status, "created");

    const row = db.prepare("SELECT sensitivity FROM facts WHERE id = ?").get(parsed.id) as
      | { sensitivity: string }
      | undefined;
    assert.ok(row, "inserted fact should exist");
    assert.equal(row.sensitivity, "private", "security domain should default to private");
  });

  // Test 2: explicit sensitivity overrides domain default
  it("factAddHandler: explicit sensitivity overrides domain default", async () => {
    const result = await factAddHandler(
      {
        predicate: "has_key",
        subject_text: "server",
        // distinct object so the write-time dedup gate doesn't collapse it
        // into test 1's fact
        object_text: "published fingerprint abc",
        domain: "security",
        sensitivity: "public",
      },
      db
    );
    const parsed = JSON.parse(result);
    assert.ok(!("error" in parsed), `should not have error: ${result}`);

    const row = db.prepare("SELECT sensitivity FROM facts WHERE id = ?").get(parsed.id) as
      | { sensitivity: string }
      | undefined;
    assert.ok(row);
    assert.equal(row.sensitivity, "public", "explicit sensitivity should override domain default");
  });

  // Test 3: unknown domain defaults to "private"
  it("factAddHandler: unknown domain defaults to private", async () => {
    const result = await factAddHandler(
      {
        predicate: "color",
        subject_text: "sky",
        object_text: "blue",
        domain: "general",
      },
      db
    );
    const parsed = JSON.parse(result);
    assert.ok(!("error" in parsed), `should not have error: ${result}`);

    const row = db.prepare("SELECT sensitivity FROM facts WHERE id = ?").get(parsed.id) as
      | { sensitivity: string }
      | undefined;
    assert.ok(row);
    assert.equal(row.sensitivity, "private", "unknown domain should default to private");
  });

  // Test 4: invalid sensitivity returns error JSON
  it("factAddHandler: invalid sensitivity returns error JSON", async () => {
    const result = await factAddHandler(
      {
        predicate: "test",
        subject_text: "x",
        sensitivity: "invalid",
      },
      db
    );
    const parsed = JSON.parse(result);
    assert.ok("error" in parsed, "should have error key");
    assert.ok(
      parsed.error.includes("invalid") || parsed.error.toLowerCase().includes("sensitivity"),
      `error message should mention the issue: ${parsed.error}`
    );
  });

  // Test 5: factSupersedeHandler carries forward sensitivity from old fact
  it("factSupersedeHandler: new fact carries forward sensitivity from old", async () => {
    // Insert an old private fact first
    const addResult = await factAddHandler(
      {
        predicate: "has_secret",
        subject_text: "vault",
        object_text: "old_value",
        domain: "security",
      },
      db
    );
    const added = JSON.parse(addResult);
    assert.ok(!("error" in added), `setup fact_add should succeed: ${addResult}`);
    const oldId = added.id as number;

    const result = await factSupersedeHandler(
      {
        old_fact_id: oldId,
        new_object_text: "new_value",
        reason: "rotation",
      },
      db
    );
    const parsed = JSON.parse(result);
    assert.ok(!("error" in parsed), `should not have error: ${result}`);
    assert.equal(parsed.old_id, oldId);
    assert.equal(parsed.status, "superseded");

    const newRow = db.prepare("SELECT sensitivity FROM facts WHERE id = ?").get(
      parsed.new_id
    ) as { sensitivity: string } | undefined;
    assert.ok(newRow, "new fact should exist");
    assert.equal(newRow.sensitivity, "private", "new fact should carry forward private sensitivity");

    const oldRow = db.prepare("SELECT status, superseded_by FROM facts WHERE id = ?").get(
      oldId
    ) as { status: string; superseded_by: number } | undefined;
    assert.ok(oldRow);
    assert.equal(oldRow.status, "superseded");
    assert.equal(oldRow.superseded_by, parsed.new_id);
  });

  // Test 6: eventAddHandler auto-private from domain_sensitivity (category=security)
  it("eventAddHandler: security category auto-gets private sensitivity", async () => {
    const result = await eventAddHandler(
      {
        event_type: "incident",
        summary: "key rotation",
        category: "security",
      },
      db
    );
    const parsed = JSON.parse(result);
    assert.ok(!("error" in parsed), `should not have error: ${result}`);
    assert.ok("id" in parsed, "should have id");
    assert.equal(parsed.status, "logged");

    const row = db.prepare("SELECT sensitivity FROM events WHERE id = ?").get(parsed.id) as
      | { sensitivity: string }
      | undefined;
    assert.ok(row);
    assert.equal(row.sensitivity, "private", "security category should default to private");
  });

  // Test 7: lessonAddHandler auto-private for security domain
  it("lessonAddHandler: security domain auto-gets private sensitivity", async () => {
    const result = await lessonAddHandler(
      {
        domain: "security",
        lesson: "never log creds",
      },
      db
    );
    const parsed = JSON.parse(result);
    assert.ok(!("error" in parsed), `should not have error: ${result}`);
    assert.ok("id" in parsed, "should have id");
    assert.equal(parsed.status, "recorded");

    const row = db.prepare("SELECT sensitivity FROM lessons WHERE id = ?").get(parsed.id) as
      | { sensitivity: string }
      | undefined;
    assert.ok(row);
    assert.equal(row.sensitivity, "private", "security domain lesson should default to private");
  });
});
