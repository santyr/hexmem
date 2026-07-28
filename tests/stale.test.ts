import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import { staleSweep, wakeDigest } from "../src/lifecycle/stale.ts";

describe("staleSweep", () => {
  let db: Database.Database;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("classifies differing objects as conflicts and keeps the newest as candidate", () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, status, created_at) VALUES
       (1, 'WorkerExample', 'routing_policy', 'static threshold', 'active', datetime('now','-100 days')),
       (2, 'WorkerExample', 'routing_policy', 'adaptive threshold', 'active', datetime('now','-1 day')),
       (3, 'WorkerExample', 'runs', 'ExampleRuntime', 'active', datetime('now'))`,
    ).run();

    const result = staleSweep(db, { dryRun: true });

    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].kind, "conflict");
    assert.equal(result.groups[0].keep, 2);
    assert.deepEqual(result.groups[0].supersede, [1]);
    assert.equal(result.superseded, 0, "dry run must not write");

    const untouched = db.prepare("SELECT status FROM facts WHERE id=1").get() as { status: string };
    assert.equal(untouched.status, "active");
  });

  it("auto mode supersedes duplicates but never conflicts", () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, status, created_at) VALUES
       (1, 'WorkerExample', 'routing_policy', 'static threshold', 'active', datetime('now','-100 days')),
       (2, 'WorkerExample', 'routing_policy', 'adaptive threshold', 'active', datetime('now','-1 day')),
       (3, 'AgentExample', 'runs_on', 'host.example.invalid', 'active', datetime('now','-50 days')),
       (4, 'AgentExample', 'runs_on', 'host.example.invalid!', 'active', datetime('now','-1 day'))`,
    ).run();

    const result = staleSweep(db, { dryRun: false });
    assert.equal(result.superseded, 1, "only the duplicate pair is superseded");

    const dupOld = db.prepare("SELECT status, superseded_by FROM facts WHERE id=3").get() as Record<string, unknown>;
    assert.equal(dupOld.status, "superseded");
    assert.equal(dupOld.superseded_by, 4);

    const conflictOld = db.prepare("SELECT status FROM facts WHERE id=1").get() as { status: string };
    assert.equal(conflictOld.status, "active", "conflicting values require judgment, not bulk action");

    const conflictGroup = result.groups.find((g) => g.predicate === "routing_policy");
    assert.equal(conflictGroup?.kind, "conflict");
  });

  it("normalizes subject/predicate when grouping", () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, status, created_at) VALUES
       (1, 'The ProjectAlpha service', 'refresh_interval', '600s', 'active', datetime('now','-10 days')),
       (2, 'projectalpha service', 'refresh_interval', '300s', 'active', datetime('now'))`,
    ).run();

    const result = staleSweep(db, { dryRun: true });
    assert.equal(result.groups.length, 1, "normalized subjects should group together");
  });
});

describe("wakeDigest", () => {
  let db: Database.Database;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("returns at-risk memories ordered by value, respecting limit", () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, status, consolidation_state, confidence, memory_strength) VALUES
       (1, 'high value', 'is', 'fading', 'active', 'fading', 1.0, 5.0),
       (2, 'low value', 'is', 'fading too', 'active', 'fading', 0.3, 0.5),
       (3, 'healthy', 'is', 'active', 'active', 'active', 1.0, 5.0)`,
    ).run();
    db.prepare(
      `INSERT INTO lessons (id, domain, lesson, consolidation_state, confidence, memory_strength, next_review_at) VALUES
       (1, 'operations', 'overdue lesson', 'active', 0.9, 2.0, datetime('now','-3 days'))`,
    ).run();

    const digest = wakeDigest(db, 2);
    assert.equal(digest.length, 2);
    assert.equal(digest[0].ref, "facts:1", "highest value first");
    assert.equal(digest[1].ref, "lessons:1", "overdue lesson beats low-value fading fact");
  });

  it("excludes healthy memories", () => {
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, status, consolidation_state) VALUES
       (1, 'healthy', 'is', 'active', 'active', 'active')`,
    ).run();
    assert.equal(wakeDigest(db, 5).length, 0);
  });
});
