import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers";
import {
  observationAddHandler,
  observationResolveHandler,
  observationsHandler,
  observationLinkHandler,
} from "../src/tools/observations";

describe("observation tools", () => {
  it("observationAddHandler records a pending observation", async () => {
    const { db } = createTestDb();
    const result = JSON.parse(await observationAddHandler({
      category: "tool_selection",
      action_type: "tool_call",
      action_summary: "Used: Read for /etc/hostname",
      outcome_source: "explicit",
    }, db));
    assert.ok(result.id > 0);
    assert.equal(result.status, "recorded");
    db.close();
  });

  it("observationAddHandler records with outcome (pre-resolved)", async () => {
    const { db } = createTestDb();
    const result = JSON.parse(await observationAddHandler({
      category: "tool_selection",
      action_type: "tool_call",
      action_summary: "Used: Bash(git status)",
      outcome: "success",
      outcome_source: "explicit",
    }, db));
    assert.ok(result.id > 0);
    const row = db.prepare("SELECT outcome, resolved_at FROM observations WHERE id = ?").get(result.id) as any;
    assert.equal(row.outcome, "success");
    assert.ok(row.resolved_at !== null);
    db.close();
  });

  it("observationResolveHandler resolves pending observation", async () => {
    const { db } = createTestDb();
    const addResult = JSON.parse(await observationAddHandler({
      category: "advisory",
      action_type: "suggestion",
      action_summary: "Suggested using TypeScript",
      outcome_source: "implicit",
    }, db));

    const resolveResult = JSON.parse(await observationResolveHandler({
      observation_id: addResult.id,
      outcome: "adopted",
    }, db));
    assert.equal(resolveResult.status, "resolved");

    const row = db.prepare("SELECT outcome FROM observations WHERE id = ?").get(addResult.id) as any;
    assert.equal(row.outcome, "adopted");
    db.close();
  });

  it("observationResolveHandler triggers Bayesian update on linked lesson", async () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("technical", "Use Read instead of Bash cat", 0.8, 4.0, 1.0);

    const addResult = JSON.parse(await observationAddHandler({
      category: "tool_selection",
      action_type: "tool_call",
      action_summary: "Used: Read",
      lesson_id: 1,
      outcome_source: "explicit",
    }, db));

    await observationResolveHandler({
      observation_id: addResult.id,
      outcome: "success",
    }, db);

    const lesson = db.prepare("SELECT alpha, confidence FROM lessons WHERE id = 1").get() as any;
    assert.ok(lesson.alpha > 4.0, "alpha should have increased");
    assert.ok(lesson.confidence > 0.8, "confidence should have increased");
    db.close();
  });

  it("observationsHandler queries by category", async () => {
    const { db } = createTestDb();
    await observationAddHandler({
      category: "tool_selection", action_type: "tool_call",
      action_summary: "Read", outcome_source: "explicit", outcome: "success",
    }, db);
    await observationAddHandler({
      category: "advisory", action_type: "suggestion",
      action_summary: "Try X", outcome_source: "implicit",
    }, db);

    const tools = JSON.parse(await observationsHandler({ category: "tool_selection" }, db));
    assert.equal(tools.length, 1);

    const all = JSON.parse(await observationsHandler({}, db));
    assert.equal(all.length, 2);
    db.close();
  });

  it("observationsHandler filters pending only", async () => {
    const { db } = createTestDb();
    await observationAddHandler({
      category: "advisory", action_type: "suggestion",
      action_summary: "Try A", outcome_source: "implicit",
    }, db);
    await observationAddHandler({
      category: "advisory", action_type: "suggestion",
      action_summary: "Try B", outcome: "adopted", outcome_source: "implicit",
    }, db);

    const pending = JSON.parse(await observationsHandler({ pending_only: true }, db));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].action_summary, "Try A");
    db.close();
  });

  it("observationAddHandler accepts expanded categories", async () => {
    const { db } = createTestDb();
    for (const cat of ["session", "architecture", "debugging", "routing"] as const) {
      const result = JSON.parse(await observationAddHandler({
        category: cat,
        action_type: "test",
        action_summary: `Test ${cat}`,
        outcome_source: "explicit",
        outcome: "success",
      }, db));
      assert.ok(result.id > 0, `${cat} should be accepted`);
    }
    const all = JSON.parse(await observationsHandler({}, db));
    assert.equal(all.length, 4);
    db.close();
  });

  it("observationLinkHandler links resolved observation to lesson and triggers Bayesian update", async () => {
    const { db } = createTestDb();

    // Create a lesson
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("technical", "Always check types", 0.8, 4.0, 1.0);

    // Create a resolved observation without lesson_id
    const addResult = JSON.parse(await observationAddHandler({
      category: "tool_selection",
      action_type: "tool_call",
      action_summary: "Used: tsc --noEmit",
      outcome: "success",
      outcome_source: "explicit",
    }, db));

    // Link it
    const linkResult = JSON.parse(await observationLinkHandler({
      observation_id: addResult.id,
      lesson_id: 1,
    }, db));

    assert.equal(linkResult.status, "linked");
    assert.equal(linkResult.lesson_id, 1);
    assert.ok(linkResult.confidence_delta > 0, "positive outcome should increase confidence");

    // Verify lesson was updated
    const lesson = db.prepare("SELECT alpha, confidence FROM lessons WHERE id = 1").get() as any;
    assert.ok(lesson.alpha > 4.0, "alpha should have increased");

    // Verify observation was updated
    const obs = db.prepare("SELECT lesson_id, confidence_delta FROM observations WHERE id = ?").get(addResult.id) as any;
    assert.equal(obs.lesson_id, 1);
    assert.ok(obs.confidence_delta !== null);
    db.close();
  });

  it("observationLinkHandler rejects unresolved observation", async () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson) VALUES (?, ?)"
    ).run("technical", "Test lesson");

    const addResult = JSON.parse(await observationAddHandler({
      category: "advisory",
      action_type: "suggestion",
      action_summary: "Try X",
      outcome_source: "implicit",
    }, db));

    const result = JSON.parse(await observationLinkHandler({
      observation_id: addResult.id,
      lesson_id: 1,
    }, db));
    assert.ok(result.error?.includes("not resolved"));
    db.close();
  });

  it("observationLinkHandler rejects already-linked observation", async () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, alpha, beta_param) VALUES (?, ?, ?, ?)"
    ).run("technical", "Lesson A", 4.0, 1.0);
    db.prepare(
      "INSERT INTO lessons (domain, lesson, alpha, beta_param) VALUES (?, ?, ?, ?)"
    ).run("technical", "Lesson B", 4.0, 1.0);

    const addResult = JSON.parse(await observationAddHandler({
      category: "tool_selection",
      action_type: "tool_call",
      action_summary: "Used: Read",
      lesson_id: 1,
      outcome: "success",
      outcome_source: "explicit",
    }, db));

    const result = JSON.parse(await observationLinkHandler({
      observation_id: addResult.id,
      lesson_id: 2,
    }, db));
    assert.ok(result.error?.includes("already linked"));
    db.close();
  });
});
