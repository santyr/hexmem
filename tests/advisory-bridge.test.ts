import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers";
import { fileAdvisoryObservations } from "../src/learning/advisory-bridge";
import type { DetectedAdvisory } from "../src/learning/advisory-detector";

describe("advisory bridge", () => {
  it("files advisory observations from detected patterns", () => {
    const { db } = createTestDb();

    const advisories: DetectedAdvisory[] = [
      { action_summary: "Suggested using TypeScript for type safety", outcome: "adopted", outcome_weight: 1.0 },
      { action_summary: "Recommended switching to Vitest", outcome: "corrected", outcome_weight: 1.0 },
      { action_summary: "Try using a different approach", outcome: "ignored", outcome_weight: 0.5 },
    ];

    const result = fileAdvisoryObservations(db, advisories, "test-session-1");
    assert.equal(result.filed, 3);

    // Check observations were created
    const rows = db.prepare("SELECT * FROM observations ORDER BY id").all() as any[];
    assert.equal(rows.length, 3);

    assert.equal(rows[0].category, "advisory");
    assert.equal(rows[0].action_type, "suggestion");
    assert.equal(rows[0].outcome, "adopted");
    assert.equal(rows[0].outcome_source, "implicit");
    assert.equal(rows[0].session_id, "test-session-1");

    assert.equal(rows[1].outcome, "corrected");
    assert.equal(rows[2].outcome, "ignored");
    assert.equal(rows[2].outcome_weight, 0.5);
    db.close();
  });

  it("links observations to matching lessons via FTS", () => {
    const { db } = createTestDb();

    // Insert a lesson and its FTS entry
    db.prepare(
      "INSERT INTO lessons (id, domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(1, "technical", "Use TypeScript strict mode for better type safety", 0.8, 4.0, 1.0);
    db.prepare(
      "INSERT INTO lessons_fts (rowid, lesson, context, domain) VALUES (?, ?, ?, ?)"
    ).run(1, "Use TypeScript strict mode for better type safety", null, "technical");

    const advisories: DetectedAdvisory[] = [
      { action_summary: "Suggested using TypeScript for type safety", outcome: "adopted", outcome_weight: 1.0 },
    ];

    const result = fileAdvisoryObservations(db, advisories, "test-session-2");
    assert.equal(result.filed, 1);
    assert.equal(result.linked, 1);

    // Check the observation was linked to the lesson
    const obs = db.prepare("SELECT lesson_id, confidence_delta FROM observations WHERE id = 1").get() as any;
    assert.equal(obs.lesson_id, 1);

    // Bayesian update should have fired (positive outcome = adopted)
    const lesson = db.prepare("SELECT alpha, confidence FROM lessons WHERE id = 1").get() as any;
    assert.ok(lesson.alpha > 4.0, "alpha should have increased from positive outcome");
    db.close();
  });

  it("handles empty advisory list", () => {
    const { db } = createTestDb();
    const result = fileAdvisoryObservations(db, [], "test-session-3");
    assert.equal(result.filed, 0);
    assert.equal(result.linked, 0);
    db.close();
  });

  it("does not link when no matching lesson exists", () => {
    const { db } = createTestDb();

    const advisories: DetectedAdvisory[] = [
      { action_summary: "Try using quantum computing for sorting", outcome: "ignored", outcome_weight: 0.5 },
    ];

    const result = fileAdvisoryObservations(db, advisories, "test-session-4");
    assert.equal(result.filed, 1);
    assert.equal(result.linked, 0);

    const obs = db.prepare("SELECT lesson_id FROM observations WHERE id = 1").get() as any;
    assert.equal(obs.lesson_id, null);
    db.close();
  });
});
