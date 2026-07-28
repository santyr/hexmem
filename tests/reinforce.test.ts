import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import { reinforceRefs } from "../src/lifecycle/reinforce.ts";
import { recallHandler } from "../src/tools/gateway.ts";
import { searchHandler } from "../src/tools/search.ts";
import { decaySweep } from "../src/lifecycle/decay.ts";

describe("retrieval reinforcement", () => {
  let db: Database.Database;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("reinforceRefs bumps access and promotes forgotten memories to active", () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, domain, consolidation_state, access_count)
       VALUES (1, 'WorkerExample', 'runs', 'ExampleRuntime', 'operations', 'forgotten', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO lessons (id, domain, lesson, consolidation_state)
       VALUES (1, 'operations', 'reinforce me', 'fading')`,
    ).run();

    const touched = reinforceRefs(db, ["facts:1", "lessons:1", "seeds:9"]);
    assert.equal(touched, 2, "seeds refs are ignored");

    const fact = db.prepare("SELECT access_count, consolidation_state FROM facts WHERE id=1").get() as Record<string, unknown>;
    assert.equal(fact.access_count, 1);
    assert.equal(fact.consolidation_state, "active");

    const lesson = db.prepare("SELECT consolidation_state FROM lessons WHERE id=1").get() as Record<string, unknown>;
    assert.equal(lesson.consolidation_state, "active");
  });

  it("recall reinforces the memories it returns", async () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, domain, consolidation_state, access_count)
       VALUES (1, 'zephyrium', 'is', 'a made-up element', 'general', 'forgotten', 0)`,
    ).run();

    await recallHandler({ query: "zephyrium" }, db);

    const fact = db.prepare("SELECT access_count, consolidation_state FROM facts WHERE id=1").get() as Record<string, unknown>;
    assert.ok((fact.access_count as number) >= 1, "recall must bump access_count");
    assert.equal(fact.consolidation_state, "active", "recall must resurrect forgotten memories it surfaces");
  });

  it("search reinforces the memories it returns", async () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, domain, consolidation_state, access_count)
       VALUES (1, 'quorblat', 'is', 'another made-up thing', 'general', 'fading', 0)`,
    ).run();

    await searchHandler({ query: "quorblat" }, db);

    const fact = db.prepare("SELECT access_count, consolidation_state FROM facts WHERE id=1").get() as Record<string, unknown>;
    assert.ok((fact.access_count as number) >= 1);
    assert.equal(fact.consolidation_state, "active");
  });
});

describe("decay floors for curated memories", () => {
  let db: Database.Database;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("source='direct' facts never decay below fading", () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, source, consolidation_state,
                          memory_strength, created_at, last_accessed_at, access_count)
       VALUES (1, 'OpsPrinciples', 'debug_humility', 'verify my own setup first', 'direct', 'active',
               0.2, datetime('now','-400 days'), datetime('now','-400 days'), 0)`,
    ).run();

    const result = decaySweep(db, false);

    const fact = db.prepare("SELECT consolidation_state FROM facts WHERE id=1").get() as Record<string, unknown>;
    assert.equal(fact.consolidation_state, "fading", "curated fact must be floored at fading");
    assert.ok(result.protected_by_curation >= 1, "sweep should report the curation protection");
  });

  it("uncurated conversation facts still decay to forgotten", () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, source, consolidation_state,
                          memory_strength, created_at, last_accessed_at, access_count)
       VALUES (1, 'some route', 'was', 'stable that day', 'conversation', 'active',
               0.2, datetime('now','-400 days'), datetime('now','-400 days'), 0)`,
    ).run();

    decaySweep(db, false);

    const fact = db.prepare("SELECT consolidation_state FROM facts WHERE id=1").get() as Record<string, unknown>;
    assert.equal(fact.consolidation_state, "forgotten");
  });

  it("lessons never decay below fading", () => {
    db.prepare(
      `INSERT INTO lessons (id, domain, lesson, consolidation_state, memory_strength, created_at, last_accessed_at)
       VALUES (1, 'operations', 'old but curated wisdom', 'active', 0.2, datetime('now','-400 days'), datetime('now','-400 days'))`,
    ).run();

    decaySweep(db, false);

    const lesson = db.prepare("SELECT consolidation_state FROM lessons WHERE id=1").get() as Record<string, unknown>;
    assert.equal(lesson.consolidation_state, "fading");
  });
});
