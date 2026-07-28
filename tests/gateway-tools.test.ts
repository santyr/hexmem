import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { createTestDb } from "./helpers.ts";
import {
  contextHandler,
  feedbackHandler,
  healthHandler,
  lintHandler,
  recallHandler,
  rememberHandler,
  workingSetHandler,
} from "../src/tools/gateway.ts";
import { registerTools } from "../src/tools.ts";

function addFact(
  db: Database.Database,
  id: number,
  subject: string,
  predicate: string,
  object: string,
  domain = "code",
  sensitivity = "public",
): void {
  db.prepare(
    `INSERT INTO facts (id, subject_text, predicate, object_text, domain, sensitivity, status, prompt_form)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(id, subject, predicate, object, domain, sensitivity, `${subject} ${predicate} ${object}`);
  db.prepare(
    `INSERT INTO facts_fts(rowid, subject_text, predicate, object_text, domain)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, subject, predicate, object, domain);
}

function addLesson(
  db: Database.Database,
  id: number,
  domain: string,
  lesson: string,
  sensitivity = "public",
): void {
  db.prepare(
    `INSERT INTO lessons (id, domain, lesson, sensitivity, prompt_form)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, domain, lesson, sensitivity, lesson);
  db.prepare(
    `INSERT INTO lessons_fts(rowid, lesson, context, domain)
     VALUES (?, ?, NULL, ?)`,
  ).run(id, lesson, domain);
}

function registeredToolNames(profile?: string): string[] {
  const priorProfile = process.env.HEXMEM_TOOL_PROFILE;
  if (profile === undefined) {
    delete process.env.HEXMEM_TOOL_PROFILE;
  } else {
    process.env.HEXMEM_TOOL_PROFILE = profile;
  }

  try {
    const names: string[] = [];
    const fakeServer = {
      registerTool(name: string) {
        names.push(name);
      },
    };
    registerTools(fakeServer as never);
    return names.sort();
  } finally {
    if (priorProfile === undefined) {
      delete process.env.HEXMEM_TOOL_PROFILE;
    } else {
      process.env.HEXMEM_TOOL_PROFILE = priorProfile;
    }
  }
}

describe("gateway recall/context tools", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb().db;
    addFact(db, 1, "HexMem", "runs_on", "ProjectAlpha", "hexmem");
    addLesson(db, 1, "hexmem", "Prefer compact gateway tools for agent memory retrieval.");
  });

  afterEach(() => {
    db.close();
  });

  it("returns compact ranked recall within a token budget by default", async () => {
    const json = await recallHandler(
      {
        query: "ProjectAlpha",
        intent: "implementation",
        domains: ["hexmem"],
        budget_tokens: 32,
        sensitivity: "public",
      },
      db,
    );

    const result = JSON.parse(json);
    assert.equal(result.status, "ok");
    assert.ok(result.item_tokens <= 32, `expected item budget <= 32, got ${result.item_tokens}`);
    assert.ok(result.items.length >= 1);
    assert.equal(result.items[0].ref, "facts:1");
    assert.equal(result.items[0].kind, "fact");
    assert.equal(result.items[0].domain, "hexmem");
    assert.ok(!("content" in result.items[0]), "compact recall should not expose raw content by default");
  });

  it("can include evidence and debug fields on recall", async () => {
    const json = await recallHandler(
      { query: "gateway", budget_tokens: 96, sensitivity: "public", include_evidence: true, debug: true },
      db,
    );

    const result = JSON.parse(json);
    assert.equal(result.status, "ok");
    assert.ok(result.items.some((item: Record<string, unknown>) => item.ref === "lessons:1"));
    const lesson = result.items.find((item: Record<string, unknown>) => item.ref === "lessons:1");
    assert.ok(lesson.evidence, "include_evidence should attach source evidence");
    assert.ok(result.debug, "debug should include retrieval diagnostics");
  });

  it("builds a compact context packet from situation and cwd", async () => {
    const json = await contextHandler(
      {
        situation: "ProjectAlpha HexMem implementation",
        cwd: "/workspace/example/ProjectAlpha",
        budget_tokens: 80,
        sensitivity: "public",
      },
      db,
    );

    const result = JSON.parse(json);
    assert.equal(result.status, "ok");
    assert.ok(result.packet.includes("HexMem"));
    assert.ok(result.item_tokens <= 80);
    assert.ok(!result.packet.includes("\"content\""), "context packet should stay compact");
  });
});

describe("gateway remember/feedback tools", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb().db;
  });

  afterEach(() => {
    db.close();
  });

  it("rejects likely ephemeral task progress by default", async () => {
    const json = await rememberHandler(
      { text: "Currently editing gateway tests before implementing code.", domain: "hexmem" },
      db,
    );

    const result = JSON.parse(json);
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "likely_ephemeral_task_progress");
    const factCount = db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number };
    const eventCount = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    const lessonCount = db.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number };
    assert.equal(factCount.n + eventCount.n + lessonCount.n, 0);
  });

  it("auto-classifies durable lessons and dedupes near-exact repeats", async () => {
    const first = JSON.parse(
      await rememberHandler(
        {
          text: "Prefer compact gateway tools when retrieving HexMem context.",
          domain: "hexmem",
          sensitivity: "public",
        },
        db,
      ),
    );
    const second = JSON.parse(
      await rememberHandler(
        {
          text: "prefer compact gateway tools when retrieving hexmem context",
          domain: "hexmem",
          sensitivity: "public",
        },
        db,
      ),
    );

    assert.equal(first.status, "stored");
    assert.equal(first.kind, "lesson");
    assert.equal(first.ref, "lessons:1");
    assert.equal(second.status, "duplicate");
    assert.equal(second.ref, "lessons:1");
    const count = db.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number };
    assert.equal(count.n, 1);
  });

  it("records feedback and reviews concrete memory refs when possible", async () => {
    addLesson(db, 1, "hexmem", "Prefer feedback loops for memory quality.");

    const json = await feedbackHandler(
      { ref: "lessons:1", rating: "helpful", note: "Used in gateway tests", session_id: "s1" },
      db,
    );

    const result = JSON.parse(json);
    assert.equal(result.status, "recorded");
    assert.equal(result.reviewed, true);
    const reviews = db.prepare("SELECT COUNT(*) AS n FROM review_log WHERE source_table = 'lessons'").get() as { n: number };
    assert.equal(reviews.n, 1);
    const observations = db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
    assert.equal(observations.n, 1);
  });
});

describe("gateway working set/lint/health tools", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb().db;
  });

  afterEach(() => {
    db.close();
  });

  it("manages a DB-backed working set with compact budgeted output", async () => {
    const add = JSON.parse(
      await workingSetHandler(
        {
          action: "add",
          session_id: "s1",
          item: "Profile filtering must expose only gateway tools in agent-minimal mode.",
          item_type: "task",
          ttl_minutes: 30,
          budget_tokens: 32,
        },
        db,
      ),
    );
    const listed = JSON.parse(await workingSetHandler({ action: "get", session_id: "s1", budget_tokens: 32 }, db));
    const removed = JSON.parse(await workingSetHandler({ action: "remove", session_id: "s1", id: add.items[0].id }, db));
    const cleared = JSON.parse(await workingSetHandler({ action: "clear", session_id: "s1" }, db));

    assert.equal(add.status, "ok");
    assert.equal(add.items.length, 1);
    assert.ok(add.item_tokens <= 32);
    assert.equal(listed.items[0].text, "Profile filtering must expose only gateway tools in agent-minimal mode.");
    assert.equal(removed.removed, 1);
    assert.equal(cleared.cleared, 0);
  });

  it("reports hygiene diagnostics for duplicates, imperatives, long entries, and secrets", async () => {
    addFact(db, 1, "HexMem", "stores", "compact gateway memory", "hexmem");
    addFact(db, 2, "hexmem", "stores", "compact gateway memory", "hexmem");
    addLesson(db, 1, "hexmem", "Run npm test before final response.");
    db.prepare(
      `INSERT INTO events (id, event_type, category, summary, details, sensitivity)
       VALUES (1, 'note', 'hexmem', ?, ?, 'private')`,
    ).run("Temporary progress note", "API key sk_live_FAKEFIXTURE12345678 should not be stored.");

    const json = await lintHandler({ budget_tokens: 220 }, db);
    const result = JSON.parse(json);
    const codes = result.issues.map((issue: Record<string, unknown>) => issue.code);

    assert.equal(result.status, "ok");
    assert.ok(codes.includes("duplicate_memory"));
    assert.ok(codes.includes("imperative_memory"));
    assert.ok(codes.includes("likely_temporary_task_state"));
    assert.ok(codes.includes("possible_secret"));
    assert.ok(result.item_tokens <= 220);
  });

  it("returns compact health wrapper output", async () => {
    addFact(db, 1, "HexMem", "has", "gateway health", "hexmem");

    const json = await healthHandler({}, db);
    const result = JSON.parse(json);

    assert.equal(result.status, "ok");
    assert.equal(result.tables.facts.total, 1);
    assert.equal(result.tables.events.total, 0);
    assert.equal(result.tables.lessons.total, 0);
  });
});

describe("HEXMEM_TOOL_PROFILE registration", () => {
  it("agent-minimal exposes only gateway tools", () => {
    const names = registeredToolNames("agent-minimal");
    assert.deepEqual(names, [
      "hexmem_context",
      "hexmem_feedback",
      "hexmem_health",
      "hexmem_lint",
      "hexmem_recall",
      "hexmem_remember",
      "hexmem_working_set",
    ]);
  });

  it("default profile exposes existing detailed tools plus gateway tools", () => {
    const names = registeredToolNames();
    assert.ok(names.includes("hexmem_fact_add"), "existing detailed fact tool should remain exposed");
    assert.ok(names.includes("hexmem_search"), "existing detailed search tool should remain exposed");
    assert.ok(names.includes("hexmem_context"), "gateway context tool should be exposed by default");
  });

  it("agent-admin exposes full/admin tools plus gateway tools", () => {
    const names = registeredToolNames("agent-admin");
    assert.ok(names.includes("hexmem_posterior_decay"), "admin maintenance tool should be exposed");
    assert.ok(names.includes("hexmem_remember"), "gateway remember tool should be exposed");
  });
});
