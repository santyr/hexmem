import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers";
import { computePrimingRecommendations } from "../src/learning/auto-primer";

describe("auto-primer", () => {
  it("uses caller-supplied cwd domain mappings", () => {
    const { db } = createTestDb();
    const recs = computePrimingRecommendations(
      db,
      "/workspace/example/ProjectAlpha",
      [{ pattern: /ProjectAlpha/i, domains: ["project", "technical"] }],
    );
    const domains = recs.map((r) => r.item_name);
    assert.ok(domains.includes("project"), "Should detect supplied project domain");
    assert.ok(domains.includes("technical"), "Should detect supplied technical domain");
    assert.equal(recs[0].activation_level, 0.8);
    assert.equal(recs[0].source, "cwd:/workspace/example/ProjectAlpha");
    db.close();
  });

  it("ships without CWD domain defaults", () => {
    const { db } = createTestDb();
    const recs = computePrimingRecommendations(db, "/workspace/example/ProjectAlpha");
    assert.equal(recs.length, 0);
    db.close();
  });

  it("primes from active tasks", () => {
    const { db } = createTestDb();

    db.prepare(
      "INSERT INTO facts (subject_text, predicate, domain, status) VALUES (?, ?, ?, 'active')"
    ).run("AgentExample", "maintains", "project");

    db.prepare(
      "INSERT INTO tasks (title, description, status, priority) VALUES (?, ?, 'in_progress', 8)"
    ).run("Fix ProjectAlpha indexing", "Debug ProjectAlpha test failures");

    const recs = computePrimingRecommendations(db, "/workspace/example");
    const domains = recs.map((r) => r.item_name);
    assert.ok(domains.includes("project"), "Should prime project domain from task");

    const projectRec = recs.find((r) => r.item_name === "project");
    assert.equal(projectRec?.activation_level, 0.7);
    assert.ok(projectRec?.source.startsWith("task:"));
    db.close();
  });

  it("primes from recent unresolved observations", () => {
    const { db } = createTestDb();

    db.prepare(
      `INSERT INTO observations (category, action_type, action_summary, outcome_source, created_at)
       VALUES ('debugging', 'bug', 'Stream drops events', 'explicit', datetime('now', '-1 day'))`
    ).run();

    const recs = computePrimingRecommendations(db, "/workspace/example");
    const domains = recs.map((r) => r.item_name);
    assert.ok(domains.includes("technical") || domains.includes("debugging"),
      "Should prime technical/debugging from debugging observation");

    const obsRec = recs.find((r) => r.source === "observation:debugging");
    assert.equal(obsRec?.activation_level, 0.5);
    db.close();
  });

  it("primes from degraded lessons", () => {
    const { db } = createTestDb();

    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("routing", "Automated review needs clear context", 0.2, 1.0, 4.0);

    const recs = computePrimingRecommendations(db, "/workspace/example");
    const routingRec = recs.find((r) => r.item_name === "routing" && r.source === "degraded-lesson");
    assert.ok(routingRec, "Should prime routing domain from degraded lesson");
    assert.equal(routingRec?.activation_level, 0.3);
    db.close();
  });

  it("deduplicates — keeps highest activation level", () => {
    const { db } = createTestDb();

    // CWD mapping gives "technical" at 0.8. A debugging observation also gives it at 0.5.
    db.prepare(
      `INSERT INTO observations (category, action_type, action_summary, outcome_source, created_at)
       VALUES ('debugging', 'bug', 'test', 'explicit', datetime('now'))`
    ).run();

    const recs = computePrimingRecommendations(
      db,
      "/workspace/example/ProjectAlpha",
      [{ pattern: /ProjectAlpha/i, domains: ["project", "technical"] }],
    );
    const technicalRecs = recs.filter((r) => r.item_name === "technical");
    assert.equal(technicalRecs.length, 1, "Should deduplicate domain:technical");
    assert.equal(technicalRecs[0].activation_level, 0.8, "Should keep higher activation (from cwd)");
    db.close();
  });

  it("returns sorted by activation_level descending", () => {
    const { db } = createTestDb();

    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("routing", "test lesson", 0.2, 1.0, 4.0);
    db.prepare(
      `INSERT INTO observations (category, action_type, action_summary, outcome_source, created_at)
       VALUES ('architecture', 'review', 'test', 'explicit', datetime('now'))`
    ).run();

    const recs = computePrimingRecommendations(
      db,
      "/workspace/example/ProjectAlpha",
      [{ pattern: /ProjectAlpha/i, domains: ["project", "technical"] }],
    );
    for (let i = 1; i < recs.length; i++) {
      assert.ok(recs[i - 1].activation_level >= recs[i].activation_level,
        `Recommendation ${i - 1} (${recs[i - 1].activation_level}) should be >= recommendation ${i} (${recs[i].activation_level})`);
    }
    db.close();
  });

  it("returns empty for unknown cwd with no tasks/observations", () => {
    const { db } = createTestDb();
    const recs = computePrimingRecommendations(db, "/workspace/example/unknown");
    assert.equal(recs.length, 0);
    db.close();
  });
});
