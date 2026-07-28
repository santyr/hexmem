import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers";
import {
  taskCreateHandler,
  taskUpdateHandler,
  taskVerifyHandler,
  taskProgressHandler,
  tasksHandler,
} from "../src/tools/tasks";

describe("task creation", () => {
  it("creates a basic task", async () => {
    const { db } = createTestDb();
    const result = JSON.parse(await taskCreateHandler({ title: "Fix bug" }, db));
    assert.ok(result.id > 0);
    assert.equal(result.status, "created");

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.id) as any;
    assert.equal(row.title, "Fix bug");
    assert.equal(row.status, "pending");
    assert.equal(row.priority, 5);
    db.close();
  });

  it("creates task with verification criteria", async () => {
    const { db } = createTestDb();
    const criteria = [
      { id: "vc1", description: "All tests pass", type: "automated" as const },
      { id: "vc2", description: "Code review approved", type: "review" as const },
    ];

    const result = JSON.parse(await taskCreateHandler({
      title: "Implement feature",
      verification_criteria: criteria,
      priority: 8,
    }, db));

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.id) as any;
    assert.deepEqual(JSON.parse(row.verification_criteria), criteria);
    assert.deepEqual(JSON.parse(row.acceptance_status), {});
    db.close();
  });

  it("creates task with dependencies and lesson links", async () => {
    const { db } = createTestDb();
    db.prepare("INSERT INTO lessons (domain, lesson) VALUES ('tech', 'test lesson')").run();

    const result = JSON.parse(await taskCreateHandler({
      title: "Deploy",
      blocked_by: [1, 2],
      related_lesson_ids: [1],
      effort_estimate_minutes: 30,
    }, db));

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.id) as any;
    assert.deepEqual(JSON.parse(row.blocked_by), [1, 2]);
    assert.deepEqual(JSON.parse(row.related_lesson_ids), [1]);
    assert.equal(row.effort_estimate_minutes, 30);
    db.close();
  });
});

describe("task verification", () => {
  it("marks criterion as pass", async () => {
    const { db } = createTestDb();
    const criteria = [
      { id: "vc1", description: "Tests pass", type: "automated" as const },
      { id: "vc2", description: "Review done", type: "review" as const },
    ];
    const task = JSON.parse(await taskCreateHandler({
      title: "Test task",
      verification_criteria: criteria,
    }, db));

    const result = JSON.parse(await taskVerifyHandler({
      task_id: task.id,
      criterion_id: "vc1",
      status: "pass",
    }, db));

    assert.equal(result.criterion_status, "pass");
    assert.equal(result.criteria_summary.passed, 1);
    assert.equal(result.criteria_summary.total, 2);
    assert.equal(result.auto_completed, false);
    db.close();
  });

  it("auto-completes when all criteria pass", async () => {
    const { db } = createTestDb();
    const criteria = [
      { id: "vc1", description: "Tests", type: "automated" as const },
      { id: "vc2", description: "Review", type: "review" as const },
    ];
    const task = JSON.parse(await taskCreateHandler({
      title: "Auto-complete test",
      verification_criteria: criteria,
    }, db));

    await taskVerifyHandler({ task_id: task.id, criterion_id: "vc1", status: "pass" }, db);
    const result = JSON.parse(await taskVerifyHandler({
      task_id: task.id,
      criterion_id: "vc2",
      status: "pass",
    }, db));

    assert.equal(result.auto_completed, true);
    assert.equal(result.criteria_summary.passed, 2);

    const row = db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(task.id) as any;
    assert.equal(row.status, "completed");
    assert.ok(row.completed_at !== null);
    db.close();
  });

  it("tracks correction count on fail → pass transitions", async () => {
    const { db } = createTestDb();
    const criteria = [{ id: "vc1", description: "Tests", type: "automated" as const }];
    const task = JSON.parse(await taskCreateHandler({
      title: "Correction test",
      verification_criteria: criteria,
    }, db));

    // First: fail
    await taskVerifyHandler({ task_id: task.id, criterion_id: "vc1", status: "fail" }, db);
    // Then: pass (this is a correction)
    const result = JSON.parse(await taskVerifyHandler({
      task_id: task.id,
      criterion_id: "vc1",
      status: "pass",
    }, db));

    assert.equal(result.correction_count, 1);
    assert.equal(result.auto_completed, true);
    db.close();
  });

  it("rejects unknown criterion", async () => {
    const { db } = createTestDb();
    const criteria = [{ id: "vc1", description: "Tests", type: "automated" as const }];
    const task = JSON.parse(await taskCreateHandler({
      title: "test",
      verification_criteria: criteria,
    }, db));

    const result = JSON.parse(await taskVerifyHandler({
      task_id: task.id,
      criterion_id: "nonexistent",
      status: "pass",
    }, db));
    assert.ok(result.error?.includes("not found"));
    db.close();
  });
});

describe("task completion with Bayesian feedback", () => {
  it("files positive observation on clean completion for related lessons", async () => {
    const { db } = createTestDb();

    db.prepare(
      "INSERT INTO lessons (id, domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(1, "technical", "Always run tests", 0.8, 4.0, 1.0);

    const task = JSON.parse(await taskCreateHandler({
      title: "Run tests",
      related_lesson_ids: [1],
    }, db));

    await taskUpdateHandler({ task_id: task.id, status: "completed" }, db);

    // Check observation was filed
    const obs = db.prepare("SELECT * FROM observations WHERE action_type = 'task_completion'").all() as any[];
    assert.equal(obs.length, 1);
    assert.equal(obs[0].outcome, "success");
    assert.equal(obs[0].lesson_id, 1);

    // Check lesson posterior increased
    const lesson = db.prepare("SELECT alpha FROM lessons WHERE id = 1").get() as any;
    assert.ok(lesson.alpha > 4.0, "Alpha should have increased from positive outcome");
    db.close();
  });

  it("files negative observation when corrections were needed", async () => {
    const { db } = createTestDb();

    db.prepare(
      "INSERT INTO lessons (id, domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(1, "technical", "Type safety matters", 0.8, 4.0, 1.0);

    const criteria = [{ id: "vc1", description: "Types check", type: "automated" as const }];
    const task = JSON.parse(await taskCreateHandler({
      title: "Fix types",
      verification_criteria: criteria,
      related_lesson_ids: [1],
    }, db));

    // Fail then pass (1 correction)
    await taskVerifyHandler({ task_id: task.id, criterion_id: "vc1", status: "fail" }, db);
    await taskVerifyHandler({ task_id: task.id, criterion_id: "vc1", status: "pass" }, db);

    const obs = db.prepare(
      "SELECT * FROM observations WHERE action_type = 'task_completion' AND lesson_id = 1"
    ).get() as any;
    assert.equal(obs.outcome, "corrected");
    assert.equal(obs.outcome_weight, 0.5); // 0.5 * 1 correction

    // Lesson posterior should have decreased
    const lesson = db.prepare("SELECT alpha, beta_param FROM lessons WHERE id = 1").get() as any;
    assert.ok(lesson.beta_param > 1.0, "Beta should have increased from negative outcome");
    db.close();
  });
});

describe("task progress", () => {
  it("returns structured progress summary", async () => {
    const { db } = createTestDb();

    await taskCreateHandler({ title: "Done task", priority: 5 }, db);
    await taskUpdateHandler({ task_id: 1, status: "completed" }, db);

    await taskCreateHandler({ title: "Active task", priority: 8 }, db);
    await taskUpdateHandler({ task_id: 2, status: "in_progress" }, db);

    await taskCreateHandler({ title: "Waiting task", priority: 3 }, db);

    const progress = JSON.parse(await taskProgressHandler({}, db));
    assert.equal(progress.in_progress.length, 1);
    assert.equal(progress.in_progress[0].title, "Active task");
    assert.equal(progress.pending_unblocked.length, 1);
    assert.equal(progress.pending_unblocked[0].title, "Waiting task");
    assert.equal(progress.recently_completed.length, 1);
    db.close();
  });

  it("identifies blocked tasks", async () => {
    const { db } = createTestDb();

    await taskCreateHandler({ title: "Prerequisite", priority: 8 }, db);
    await taskCreateHandler({
      title: "Blocked task",
      priority: 5,
      blocked_by: [1],
    }, db);

    // Without include_blocked
    const progress1 = JSON.parse(await taskProgressHandler({ include_blocked: false }, db));
    assert.equal(progress1.pending_blocked.length, 0);
    assert.equal(progress1.pending_unblocked.length, 1); // only prerequisite

    // With include_blocked
    const progress2 = JSON.parse(await taskProgressHandler({ include_blocked: true }, db));
    assert.equal(progress2.pending_blocked.length, 1);
    assert.equal(progress2.pending_blocked[0].title, "Blocked task");

    // Complete prerequisite → blocked task becomes unblocked
    await taskUpdateHandler({ task_id: 1, status: "completed" }, db);
    const progress3 = JSON.parse(await taskProgressHandler({ include_blocked: true }, db));
    assert.equal(progress3.pending_blocked.length, 0);
    assert.equal(progress3.pending_unblocked.length, 1);
    assert.equal(progress3.pending_unblocked[0].title, "Blocked task");
    db.close();
  });
});
