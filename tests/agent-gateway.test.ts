import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import {
  contextHandler,
  feedbackHandler,
  healthHandler,
  lintHandler,
  recallHandler,
  rememberHandler,
  workingSetHandler,
} from "../src/tools/agent-gateway.ts";

function seedSearchRows(db: Database.Database): void {
  db.prepare("INSERT INTO facts (id, subject_text, predicate, object_text, domain, sensitivity, status, prompt_form) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1, "HexMem", "supports", "agent-minimal tool profiles", "memory", "public", "active", "hexmem_profiles");
  db.prepare("INSERT INTO lessons (id, domain, lesson, context, sensitivity, prompt_form) VALUES (?, ?, ?, ?, ?, ?)")
    .run(1, "memory", "When adding agent memory tools, preserve detailed HexMem tools for compatibility.", "MCP server changes", "public", "preserve_detailed_tools");
  db.prepare("INSERT INTO events (id, event_type, category, summary, details, significance, sensitivity, prompt_form) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1, "change", "memory", "HexMem gained compact agent recall support", "Gateway tools return budgeted packets.", 7, "public", "compact_recall");
  db.prepare("INSERT INTO facts_fts(rowid, subject_text, predicate, object_text, domain) VALUES (?, ?, ?, ?, ?)")
    .run(1, "HexMem", "supports", "agent-minimal tool profiles", "memory");
  db.prepare("INSERT INTO lessons_fts(rowid, lesson, context, domain) VALUES (?, ?, ?, ?)")
    .run(1, "When adding agent memory tools, preserve detailed HexMem tools for compatibility.", "MCP server changes", "memory");
  db.prepare("INSERT INTO events_fts(rowid, summary, details, category, event_type) VALUES (?, ?, ?, ?, ?)")
    .run(1, "HexMem gained compact agent recall support", "Gateway tools return budgeted packets.", "memory", "change");
}

describe("agent memory gateway compatibility handlers", () => {
  it("recalls compact ranked memories within the requested budget", async () => {
    const { db } = createTestDb();
    seedSearchRows(db);
    const packet = JSON.parse(await recallHandler({ query: "HexMem agent memory tools", intent: "implement gateway", domains: ["memory"], budget_tokens: 120, sensitivity: "public" }, db));
    assert.equal(packet.status, "ok");
    assert.ok(Array.isArray(packet.items));
    assert.ok(packet.items.length > 0);
    assert.ok(packet.item_tokens <= 120, "expected budget <= 120, got " + packet.item_tokens);
    assert.ok(!("content" in packet.items[0]));
    assert.match(packet.items[0].ref, /^(facts|events|lessons):[0-9]+$/);
    db.close();
  });

  it("remember rejects likely ephemeral task progress by default", async () => {
    const { db } = createTestDb();
    const result = JSON.parse(await rememberHandler({ kind: "auto", text: "Currently updating tests and will rerun npm test in this session.", domain: "memory" }, db));
    assert.equal(result.status, "rejected");
    assert.match(result.reason, /ephemeral/i);
    const rows = db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number };
    assert.equal(rows.count, 0);
    db.close();
  });

  it("remember stores durable memories and deduplicates near-exact repeats", async () => {
    const { db } = createTestDb();
    const text = "When adding HexMem gateway tools, preserve detailed tools through profile filtering.";
    const first = JSON.parse(await rememberHandler({ kind: "auto", text, domain: "memory", sensitivity: "public" }, db));
    const second = JSON.parse(await rememberHandler({ kind: "auto", text: text + " ", domain: "memory", sensitivity: "public" }, db));
    assert.equal(first.status, "stored");
    assert.equal(first.kind, "lesson");
    assert.equal(second.status, "duplicate");
    assert.equal(second.ref, first.ref);
    const rows = db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number };
    assert.equal(rows.count, 1);
    db.close();
  });

  it("working set supports add, get, remove, and clear with compact output", async () => {
    const { db } = createTestDb();
    const added = JSON.parse(await workingSetHandler({ action: "add", session_id: "test-session", item: "Preserve detailed HexMem tools while adding agent gateway tools.", ttl_minutes: 30, budget_tokens: 80 }, db));
    assert.equal(added.status, "ok");
    assert.equal(added.items.length, 1);
    assert.ok(added.item_tokens <= 80);
    const listed = JSON.parse(await workingSetHandler({ action: "get", session_id: "test-session", budget_tokens: 80 }, db));
    assert.equal(listed.items.length, 1);
    const removed = JSON.parse(await workingSetHandler({ action: "remove", session_id: "test-session", id: added.items[0].id }, db));
    assert.equal(removed.removed, 1);
    await workingSetHandler({ action: "add", session_id: "test-session", item: "Temporary context" }, db);
    const cleared = JSON.parse(await workingSetHandler({ action: "clear", session_id: "test-session" }, db));
    assert.equal(cleared.cleared, 1);
    db.close();
  });

  it("context builds a compact packet for a situation", async () => {
    const { db } = createTestDb();
    seedSearchRows(db);
    const packet = JSON.parse(await contextHandler({ situation: "HexMem agent gateway implementation", cwd: "/workspace/example/ProjectAlpha", budget_tokens: 160, sensitivity: "public" }, db));
    assert.equal(packet.status, "ok");
    assert.ok(packet.packet.includes("HexMem"));
    assert.ok(Array.isArray(packet.items));
    assert.ok(packet.item_tokens <= 160);
    db.close();
  });

  it("feedback records observations and reviews known memory refs", async () => {
    const { db } = createTestDb();
    db.prepare("INSERT INTO lessons (id, domain, lesson, sensitivity) VALUES (?, ?, ?, ?)").run(1, "memory", "Feedback should strengthen useful memories.", "public");
    const result = JSON.parse(await feedbackHandler({ ref: "lessons:1", rating: "helpful", note: "Used during gateway implementation", session_id: "feedback-test" }, db));
    assert.equal(result.status, "recorded");
    assert.equal(result.reviewed, true);
    const reviews = db.prepare("SELECT COUNT(*) AS count FROM review_log").get() as { count: number };
    assert.equal(reviews.count, 1);
    const observations = db.prepare("SELECT COUNT(*) AS count FROM observations").get() as { count: number };
    assert.equal(observations.count, 1);
    db.close();
  });

  it("lint reports hygiene diagnostics", async () => {
    const { db } = createTestDb();
    const duplicate = "HexMem gateway tools should preserve detailed tools.";
    db.prepare("INSERT INTO lessons (domain, lesson, sensitivity) VALUES (?, ?, ?), (?, ?, ?)").run("memory", duplicate, "public", "memory", duplicate + " ", "public");
    db.prepare("INSERT INTO lessons (domain, lesson, sensitivity) VALUES (?, ?, ?)").run("memory", "Run step 1 then step 2 with password=sentinel_demo_value before commit.", "private"); // synthetic secret-lint fixture
    db.prepare("INSERT INTO events (event_type, summary, details, sensitivity) VALUES (?, ?, ?, ?)").run("session", "Currently running the test suite", "temporary state", "public");
    db.prepare("INSERT INTO facts (subject_text, predicate, object_text, domain, sensitivity) VALUES (?, ?, ?, ?, ?)").run("Long memory", "contains", "word ".repeat(180), "memory", "public");
    const report = JSON.parse(await lintHandler({ budget_tokens: 500 }, db));
    const codes = report.issues.map((issue: Record<string, unknown>) => issue.code);
    assert.ok(codes.includes("duplicate_memory"));
    assert.ok(codes.includes("imperative_memory"));
    assert.ok(codes.includes("likely_temporary_task_state"));
    assert.ok(codes.includes("procedure_as_memory"));
    assert.ok(codes.includes("overly_long_memory"));
    assert.ok(codes.includes("possible_secret"));
    db.close();
  });

  it("health returns a compact summary alias", async () => {
    const { db } = createTestDb();
    const summary = JSON.parse(await healthHandler({}, db));
    assert.equal(summary.status, "ok");
    assert.ok("facts" in summary.tables);
    assert.ok(!("by_state" in summary.tables.facts));
    db.close();
  });
});
