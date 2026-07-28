import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import {
  ethicsHandler,
  ethicAddHandler,
  ethicUpdateHandler,
} from "../src/tools/ethics.ts";
import { tasksHandler, taskUpdateHandler } from "../src/tools/tasks.ts";
import {
  entitiesHandler,
  entityAddHandler,
  entityLinkHandler,
} from "../src/tools/entities.ts";
import {
  narrativeHandler,
  meaningFrameHandler,
} from "../src/tools/narrative.ts";
import { primeHandler, primingStateHandler } from "../src/tools/priming.ts";
import { dailyLogHandler } from "../src/tools/daily-log.ts";

// ─── Task 7: Ethics ────────────────────────────────────────────────────────────

describe("ethicsHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;
    db.prepare(
      "INSERT INTO ethics (principle, scope, priority, active, rationale) VALUES (?, ?, ?, ?, ?)"
    ).run("Do no harm", "universal", 9, 1, "Core safety principle");
    db.prepare(
      "INSERT INTO ethics (principle, scope, priority, active) VALUES (?, ?, ?, ?)"
    ).run("Respect privacy", "social", 7, 1);
    db.prepare(
      "INSERT INTO ethics (principle, scope, priority, active) VALUES (?, ?, ?, ?)"
    ).run("Inactive principle", "universal", 5, 0);
  });

  after(() => { db.close(); });

  it("lists only active ethics, ordered by priority DESC", async () => {
    const json = await ethicsHandler({}, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2, "should return 2 active ethics");
    assert.equal(rows[0].principle, "Do no harm", "highest priority first");
  });

  it("filters by scope", async () => {
    const json = await ethicsHandler({ scope: "social" }, db);
    const rows = JSON.parse(json);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, "social");
  });

  it("adds an ethic", async () => {
    const json = await ethicAddHandler(
      { principle: "Be transparent", scope: "external", priority: 8 },
      db
    );
    const result = JSON.parse(json);
    assert.ok(result.id > 0);
    assert.equal(result.status, "created");
    const row = db.prepare("SELECT * FROM ethics WHERE id = ?").get(result.id) as Record<string, unknown>;
    assert.equal(row["principle"], "Be transparent");
    assert.equal(row["scope"], "external");
    assert.equal(row["priority"], 8);
  });

  it("updates an ethic to deactivate it", async () => {
    const addJson = await ethicAddHandler({ principle: "To be removed", scope: "universal" }, db);
    const { id } = JSON.parse(addJson);

    const updateJson = await ethicUpdateHandler({ ethic_id: id, active: false }, db);
    const result = JSON.parse(updateJson);
    assert.equal(result.status, "updated");

    const row = db.prepare("SELECT active, reviewed_at FROM ethics WHERE id = ?").get(id) as Record<string, unknown>;
    assert.equal(row["active"], 0, "should be deactivated");
    assert.ok(row["reviewed_at"] !== null, "reviewed_at should be set");
  });
});

// ─── Task 7: Tasks ─────────────────────────────────────────────────────────────

describe("tasksHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;
    db.prepare(
      "INSERT INTO tasks (title, status, priority) VALUES (?, ?, ?)"
    ).run("Write tests", "pending", 8);
    db.prepare(
      "INSERT INTO tasks (title, status, priority) VALUES (?, ?, ?)"
    ).run("Deploy service", "pending", 6);
    db.prepare(
      "INSERT INTO tasks (title, status, priority) VALUES (?, ?, ?)"
    ).run("Old done task", "completed", 9);
  });

  after(() => { db.close(); });

  it("returns pending tasks ordered by priority DESC", async () => {
    const json = await tasksHandler({ status: "pending" }, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].title, "Write tests", "priority 8 first");
  });

  it("filters by status", async () => {
    const json = await tasksHandler({ status: "completed" }, db);
    const rows = JSON.parse(json);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Old done task");
  });

  it("updates task status to completed and sets completed_at", async () => {
    const row = db.prepare("SELECT id FROM tasks WHERE title = 'Write tests'").get() as { id: number };
    const json = await taskUpdateHandler({ task_id: row.id, status: "completed" }, db);
    const result = JSON.parse(json);
    assert.equal(result.status, "updated");

    const updated = db.prepare("SELECT status, completed_at, updated_at FROM tasks WHERE id = ?").get(row.id) as Record<string, unknown>;
    assert.equal(updated["status"], "completed");
    assert.ok(updated["completed_at"] !== null, "completed_at should be set");
  });

  it("updates status without setting completed_at for non-completed statuses", async () => {
    const row = db.prepare("SELECT id FROM tasks WHERE title = 'Deploy service'").get() as { id: number };
    await taskUpdateHandler({ task_id: row.id, status: "in_progress" }, db);
    const updated = db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(row.id) as Record<string, unknown>;
    assert.equal(updated["status"], "in_progress");
    assert.ok(updated["completed_at"] === null, "completed_at should remain null");
  });
});

// ─── Task 7: Entities ──────────────────────────────────────────────────────────

describe("entitiesHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;
  });

  after(() => { db.close(); });

  it("adds an entity", async () => {
    const json = await entityAddHandler(
      { name: "Alice", entity_type: "person", description: "A developer" },
      db
    );
    const result = JSON.parse(json);
    assert.ok(result.id > 0);
    assert.equal(result.status, "created");

    const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(result.id) as Record<string, unknown>;
    assert.equal(row["name"], "Alice");
    assert.equal(row["canonical_name"], "alice");
    assert.equal(row["entity_type"], "person");
  });

  it("searches by name", async () => {
    await entityAddHandler({ name: "Bob", entity_type: "person" }, db);
    await entityAddHandler({ name: "Carol", entity_type: "person" }, db);

    const json = await entitiesHandler({ search: "bob" }, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.some((r: Record<string, unknown>) => r["name"] === "Bob"));
    assert.ok(!rows.some((r: Record<string, unknown>) => r["name"] === "Carol"));
  });

  it("returns all entities when no search given", async () => {
    const json = await entitiesHandler({}, db);
    const rows = JSON.parse(json);
    assert.ok(rows.length >= 3, "should have at least 3 entities inserted so far");
  });

  it("links two entities", async () => {
    const a = JSON.parse(await entityAddHandler({ name: "ProjectX", entity_type: "project" }, db));
    const b = JSON.parse(await entityAddHandler({ name: "TeamY", entity_type: "team" }, db));

    const json = await entityLinkHandler(
      { from_entity_id: a.id, to_entity_id: b.id, relationship_type: "owned_by", strength: 0.9 },
      db
    );
    const result = JSON.parse(json);
    assert.ok(result.id > 0);
    assert.equal(result.status, "created");

    const link = db.prepare(
      "SELECT * FROM relationships WHERE from_entity_id = ? AND to_entity_id = ?"
    ).get(a.id, b.id) as Record<string, unknown>;
    assert.ok(link !== undefined, "relationship row should exist");
    assert.equal(link["relationship_type"], "owned_by");
    assert.equal(link["strength"], 0.9);
  });
});

// ─── Task 8: Narrative Threads ─────────────────────────────────────────────────

describe("narrativeHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;
  });

  after(() => { db.close(); });

  it("creates a narrative thread", async () => {
    const json = await narrativeHandler(
      { action: "create", title: "The Great Migration", thread_type: "project", current_chapter: "Planning" },
      db
    );
    const result = JSON.parse(json);
    assert.ok(result.id > 0);
    assert.equal(result.status, "created");
  });

  it("lists active narrative threads", async () => {
    const json = await narrativeHandler({ action: "list" }, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r: Record<string, unknown>) => r["status"] === "active"));
  });

  it("updates a narrative thread", async () => {
    const createJson = await narrativeHandler(
      { action: "create", title: "Side Quest", thread_type: "personal" },
      db
    );
    const { id } = JSON.parse(createJson);

    const json = await narrativeHandler(
      { action: "update", id, current_chapter: "In Progress", meaning_derived: "Learning patience" },
      db
    );
    const result = JSON.parse(json);
    assert.equal(result.status, "updated");

    const row = db.prepare("SELECT current_chapter, meaning_derived FROM narrative_threads WHERE id = ?").get(id) as Record<string, unknown>;
    assert.equal(row["current_chapter"], "In Progress");
    assert.equal(row["meaning_derived"], "Learning patience");
  });

  it("resolves a narrative thread", async () => {
    const createJson = await narrativeHandler(
      { action: "create", title: "Sprint 42", thread_type: "work" },
      db
    );
    const { id } = JSON.parse(createJson);

    const json = await narrativeHandler({ action: "resolve", id }, db);
    const result = JSON.parse(json);
    assert.equal(result.status, "resolved");

    const row = db.prepare("SELECT status, resolved_at FROM narrative_threads WHERE id = ?").get(id) as Record<string, unknown>;
    assert.equal(row["status"], "resolved");
    assert.ok(row["resolved_at"] !== null);
  });

  it("resolved threads do not appear in list", async () => {
    const json = await narrativeHandler({ action: "list" }, db);
    const rows = JSON.parse(json);
    assert.ok(rows.every((r: Record<string, unknown>) => r["status"] === "active"));
  });
});

// ─── Task 8: Meaning Frames ────────────────────────────────────────────────────

describe("meaningFrameHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;
    db.prepare(
      "INSERT INTO events (event_type, summary, significance) VALUES (?, ?, ?)"
    ).run("milestone", "Launched v2", 8);
  });

  after(() => { db.close(); });

  it("adds a meaning frame for an event", async () => {
    const event = db.prepare("SELECT id FROM events WHERE event_type = 'milestone'").get() as { id: number };

    const json = await meaningFrameHandler(
      {
        event_id: event.id,
        frame_type: "growth",
        interpretation: "This launch marks a new era",
        before_state: "prototype",
        after_state: "production",
        transformation: "From experiment to product",
      },
      db
    );
    const result = JSON.parse(json);
    assert.ok(result.id > 0);
    assert.equal(result.status, "created");

    const row = db.prepare("SELECT * FROM meaning_frames WHERE id = ?").get(result.id) as Record<string, unknown>;
    assert.equal(row["frame_type"], "growth");
    assert.equal(row["interpretation"], "This launch marks a new era");
    assert.equal(row["before_state"], "prototype");
    assert.equal(row["after_state"], "production");
  });
});

// ─── Task 9: Priming ───────────────────────────────────────────────────────────

describe("primeHandler / primingStateHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;
  });

  after(() => { db.close(); });

  it("primes a concept", async () => {
    const json = await primeHandler(
      { item_type: "concept", item_name: "resilience", source: "test", ttl_minutes: 60 },
      db
    );
    const result = JSON.parse(json);
    assert.ok(result.id > 0);
    assert.equal(result.status, "primed");
  });

  it("lists active priming entries", async () => {
    const json = await primingStateHandler({}, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 1);
    assert.ok(rows.some((r: Record<string, unknown>) => r["item_name"] === "resilience"));
  });

  it("cleans up expired entries before listing", async () => {
    // Insert an already-expired entry
    db.prepare(
      "INSERT INTO priming_state (item_type, item_name, source, expires_at) VALUES (?, ?, ?, datetime('now', '-1 minute'))"
    ).run("concept", "stale-concept", "test");

    const countBefore = (db.prepare("SELECT COUNT(*) as n FROM priming_state").get() as { n: number }).n;
    assert.ok(countBefore >= 2, "should have at least 2 entries before cleanup");

    const json = await primingStateHandler({}, db);
    const rows = JSON.parse(json);

    // stale-concept should not appear
    assert.ok(!rows.some((r: Record<string, unknown>) => r["item_name"] === "stale-concept"), "expired entry should be removed");

    // DB row should actually be deleted
    const remaining = (db.prepare("SELECT COUNT(*) as n FROM priming_state WHERE item_name = 'stale-concept'").get() as { n: number }).n;
    assert.equal(remaining, 0, "expired row should be deleted from DB");
  });
});

// ─── Task 10: Daily Logs ───────────────────────────────────────────────────────

describe("dailyLogHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;
  });

  after(() => { db.close(); });

  it("adds a daily log entry", async () => {
    const json = await dailyLogHandler(
      {
        action: "add",
        kind: "reflection",
        summary: "Finished the new tools.",
        details: "Validated the current daily log schema.",
      },
      db
    );
    const result = JSON.parse(json);
    assert.ok(result.id > 0);
    assert.equal(result.status, "created");
  });

  it("queries today's entries", async () => {
    const json = await dailyLogHandler({ action: "today" }, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 1);
    assert.ok(rows.some((r: Record<string, unknown>) => r["summary"] === "Finished the new tools."));
  });

  it("queries recent entries (last 7 days)", async () => {
    await dailyLogHandler(
      { action: "add", kind: "milestone", summary: "v2 shipped" },
      db
    );
    const json = await dailyLogHandler({ action: "recent" }, db);
    const rows = JSON.parse(json);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 2);
  });

  it("returns error for unknown action", async () => {
    const json = await dailyLogHandler({ action: "unknown" }, db);
    const result = JSON.parse(json);
    assert.ok("error" in result);
  });
});
