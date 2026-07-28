import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.ts";
import { eventAddHandler, eventsHandler } from "../src/tools/events.ts";
import { lessonAddHandler, lessonsHandler } from "../src/tools/lessons.ts";
import { entitiesHandler, entityAddHandler, entityAliasAddHandler } from "../src/tools/entities.ts";

describe("event handlers", () => {
  it("adds events and query filters promote fading events", async () => {
    const { db } = createTestDb();
    try {
      const created = JSON.parse(await eventAddHandler({
        event_type: "deploy",
        category: "ops",
        summary: "Hexmem test deployment",
        details: "A deployment event with operational detail",
        significance: 8,
        emotional_valence: 0.2,
        emotional_arousal: 0.7,
      }, db));
      await eventAddHandler({ event_type: "deploy", category: "ops", summary: "Low signal", significance: 3 }, db);

      const stored = db.prepare("SELECT prompt_form, sensitivity, emotional_valence, emotional_arousal FROM events WHERE id = ?")
        .get(created.id) as Record<string, unknown>;
      assert.equal(stored.sensitivity, "private");
      assert.ok(String(stored.prompt_form).length > 0);
      assert.equal(stored.emotional_valence, 0.2);
      assert.equal(stored.emotional_arousal, 0.7);

      db.prepare("UPDATE events SET consolidation_state = 'fading' WHERE id = ?").run(created.id);
      const rows = JSON.parse(await eventsHandler({ event_type: "deploy", category: "ops", min_significance: 7 }, db));
      assert.deepEqual(rows.map((row: Record<string, unknown>) => row.id), [created.id]);

      const accessed = db.prepare("SELECT consolidation_state, last_accessed_at FROM events WHERE id = ?")
        .get(created.id) as Record<string, unknown>;
      assert.equal(accessed.consolidation_state, "active");
      assert.ok(accessed.last_accessed_at);
    } finally {
      db.close();
    }
  });
});

describe("lesson handlers", () => {
  it("adds lessons and query filters active current lessons", async () => {
    const { db } = createTestDb();
    try {
      const high = JSON.parse(await lessonAddHandler({
        domain: "ops",
        lesson: "Verify health before rollout",
        context: "deployments",
        confidence: 0.9,
      }, db));
      const low = JSON.parse(await lessonAddHandler({
        domain: "ops",
        lesson: "Keep rollback notes nearby",
        confidence: 0.4,
      }, db));
      db.prepare("INSERT INTO lessons (domain, lesson, confidence, valid_until) VALUES (?, ?, ?, datetime('now', '-1 day'))")
        .run("ops", "Expired lesson", 1.0);
      db.prepare("INSERT INTO lessons (domain, lesson, confidence, superseded_by) VALUES (?, ?, ?, ?)")
        .run("ops", "Superseded lesson", 1.0, high.id);
      db.prepare("UPDATE lessons SET consolidation_state = 'compressed' WHERE id = ?").run(low.id);

      const rows = JSON.parse(await lessonsHandler({ domain: "ops" }, db));
      assert.deepEqual(rows.map((row: Record<string, unknown>) => row.lesson), [
        "Verify health before rollout",
        "Keep rollback notes nearby",
      ]);

      const accessed = db.prepare("SELECT access_count, consolidation_state FROM lessons WHERE id = ?")
        .get(low.id) as Record<string, unknown>;
      assert.equal(accessed.access_count, 1);
      assert.equal(accessed.consolidation_state, "active");
    } finally {
      db.close();
    }
  });
});

describe("entity alias handler", () => {
  it("adds aliases idempotently and entity search matches aliases", async () => {
    const { db } = createTestDb();
    try {
      const entity = JSON.parse(await entityAddHandler({ name: "Dana", entity_type: "person" }, db));
      await entityAliasAddHandler({ entity_id: entity.id, alias: "dana@example.test", alias_type: "email" }, db);
      await entityAliasAddHandler({ entity_id: entity.id, alias: "dana@example.test", alias_type: "email" }, db);

      const aliases = db.prepare("SELECT alias, alias_type FROM entity_aliases WHERE entity_id = ?")
        .all(entity.id) as Array<Record<string, unknown>>;
      assert.deepEqual(aliases, [{ alias: "dana@example.test", alias_type: "email" }]);

      const rows = JSON.parse(await entitiesHandler({ search: "dana@example.test" }, db));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, "Dana");
      assert.deepEqual(rows[0].aliases, aliases);
    } finally {
      db.close();
    }
  });
});
