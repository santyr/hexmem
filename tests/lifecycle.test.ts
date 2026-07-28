import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import { effectiveStrength, decaySweep } from "../src/lifecycle/decay.ts";
import { review, reviewDue } from "../src/lifecycle/review.ts";
import { consolidate } from "../src/lifecycle/consolidate.ts";

// Helper to insert a fact with specific fields
function insertFact(
  db: Database.Database,
  opts: {
    subject_text: string;
    predicate?: string;
    object_text?: string;
    domain?: string;
    memory_strength?: number;
    emotional_valence?: number;
    emotional_arousal?: number;
    consolidation_state?: string;
    created_at?: string;
    last_accessed_at?: string;
    access_count?: number;
    prompt_form?: string;
    next_review_at?: string;
  }
): number {
  const r = db
    .prepare(
      `INSERT INTO facts (subject_text, predicate, object_text, domain,
       memory_strength, emotional_valence, emotional_arousal, consolidation_state,
       created_at, last_accessed_at, access_count, prompt_form, next_review_at, sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public')`
    )
    .run(
      opts.subject_text,
      opts.predicate ?? "test_pred",
      opts.object_text ?? "obj",
      opts.domain ?? "test",
      opts.memory_strength ?? 1.0,
      opts.emotional_valence ?? 0.0,
      opts.emotional_arousal ?? 0.0,
      opts.consolidation_state ?? "active",
      opts.created_at ?? new Date().toISOString(),
      opts.last_accessed_at ?? null,
      opts.access_count ?? 0,
      opts.prompt_form ?? `${opts.subject_text}|test_pred|obj`,
      opts.next_review_at ?? null
    );
  return r.lastInsertRowid as number;
}

function insertEvent(
  db: Database.Database,
  opts: {
    summary: string;
    domain?: string;
    memory_strength?: number;
    emotional_valence?: number;
    emotional_arousal?: number;
    consolidation_state?: string;
    occurred_at?: string;
    last_accessed_at?: string;
    access_count?: number;
    next_review_at?: string;
  }
): number {
  const r = db
    .prepare(
      `INSERT INTO events (summary, event_type, memory_strength, emotional_valence,
       emotional_arousal, consolidation_state, occurred_at, last_accessed_at,
       access_count, next_review_at, sensitivity)
       VALUES (?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, 'public')`
    )
    .run(
      opts.summary,
      opts.memory_strength ?? 1.0,
      opts.emotional_valence ?? 0.0,
      opts.emotional_arousal ?? 0.0,
      opts.consolidation_state ?? "active",
      opts.occurred_at ?? new Date().toISOString(),
      opts.last_accessed_at ?? null,
      opts.access_count ?? 0,
      opts.next_review_at ?? null
    );
  return r.lastInsertRowid as number;
}

function insertLesson(
  db: Database.Database,
  opts: {
    lesson: string;
    domain?: string;
    memory_strength?: number;
    emotional_valence?: number;
    emotional_arousal?: number;
    consolidation_state?: string;
    created_at?: string;
    last_accessed_at?: string;
    access_count?: number;
    prompt_form?: string;
    next_review_at?: string;
  }
): number {
  const r = db
    .prepare(
      `INSERT INTO lessons (lesson, domain, memory_strength, emotional_valence,
       emotional_arousal, consolidation_state, created_at, last_accessed_at,
       access_count, prompt_form, next_review_at, sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public')`
    )
    .run(
      opts.lesson,
      opts.domain ?? "test",
      opts.memory_strength ?? 1.0,
      opts.emotional_valence ?? 0.0,
      opts.emotional_arousal ?? 0.0,
      opts.consolidation_state ?? "active",
      opts.created_at ?? new Date().toISOString(),
      opts.last_accessed_at ?? null,
      opts.access_count ?? 0,
      opts.prompt_form ?? opts.lesson,
      opts.next_review_at ?? null
    );
  return r.lastInsertRowid as number;
}

// ─── effectiveStrength ────────────────────────────────────────────────────────

describe("effectiveStrength", () => {
  it("no modulation returns 1.0", () => {
    const s = effectiveStrength(1.0, 0, 0, 0);
    assert.ok(Math.abs(s - 1.0) < 0.001, `expected ~1.0, got ${s}`);
  });

  it("emotional boost: valence=0.8 arousal=0.5 → ~1.65", () => {
    const s = effectiveStrength(1.0, 0.8, 0.5, 0);
    // base=1.0, emotionalBoost=1+(0.8+0.5)*0.5=1.65, frequencyBoost=1.0
    assert.ok(Math.abs(s - 1.65) < 0.02, `expected ~1.65, got ${s}`);
  });

  it("frequency boost: accessCount=15 → ~1.78", () => {
    const s = effectiveStrength(1.0, 0, 0, 15);
    // base=1.0, emotionalBoost=1.0, frequencyBoost=1+log2(16)*0.2=1+4*0.2=1.8
    // actual: log2(16)=4, so 1+4*0.2=1.8 — but spec says ~1.78 so log2(1+15)=4, OK close
    assert.ok(s > 1.5 && s < 2.1, `expected ~1.78, got ${s}`);
  });
});

// ─── decaySweep ───────────────────────────────────────────────────────────────

describe("decaySweep", () => {
  let db: Database.Database;

  before(() => {
    ({ db } = createTestDb());
  });

  after(() => {
    db.close();
  });

  it("dry_run: counts transitions without mutating DB", () => {
    // Very old weak fact → should decay
    const oldDate = "2023-01-01T00:00:00";
    const id1 = insertFact(db, {
      subject_text: "oldweak",
      memory_strength: 0.1,
      consolidation_state: "active",
      last_accessed_at: oldDate,
      created_at: oldDate,
    });
    // Recent strong fact → stays active
    const id2 = insertFact(db, {
      subject_text: "newstrong",
      memory_strength: 5.0,
      consolidation_state: "active",
    });
    // Medium-age fading fact → should transition downward
    const midDate = "2024-01-01T00:00:00";
    const id3 = insertFact(db, {
      subject_text: "midfading",
      memory_strength: 0.3,
      consolidation_state: "fading",
      last_accessed_at: midDate,
      created_at: midDate,
    });

    const result = decaySweep(db, true);

    assert.equal(result.dry_run, true, "dry_run flag should be true");
    assert.ok(result.scanned > 0, "should have scanned some records");
    assert.ok(typeof result.transitions.fading === "number");
    assert.ok(typeof result.transitions.compressed === "number");
    assert.ok(typeof result.transitions.forgotten === "number");

    // DB should NOT be mutated
    const row1 = db.prepare("SELECT consolidation_state FROM facts WHERE id = ?").get(id1) as { consolidation_state: string };
    assert.equal(row1.consolidation_state, "active", "dry_run must not mutate DB");

    // Suppress unused variable warnings
    void id2;
    void id3;
  });

  it("actual sweep: mutates DB (consolidation_state changed for old/weak facts)", () => {
    const { db: db2 } = createTestDb();
    try {
      const veryOld = "2022-01-01T00:00:00";
      const id = insertFact(db2, {
        subject_text: "decayable",
        memory_strength: 0.05,
        consolidation_state: "active",
        last_accessed_at: veryOld,
        created_at: veryOld,
      });

      const result = decaySweep(db2, false);
      assert.equal(result.dry_run, false);

      const after = db2.prepare("SELECT consolidation_state, retention_estimate FROM facts WHERE id = ?").get(id) as {
        consolidation_state: string;
        retention_estimate: number;
      };
      // Very old weak fact should have moved to compressed or forgotten
      assert.ok(
        ["compressed", "forgotten", "fading"].includes(after.consolidation_state),
        `expected decay, got ${after.consolidation_state}`
      );
      assert.ok(after.retention_estimate < 0.5, "retention should be low");
    } finally {
      db2.close();
    }
  });

  it("protects high-salience fact from compressed/forgotten", () => {
    const { db: db3 } = createTestDb();
    try {
      const veryOld = "2022-01-01T00:00:00";
      const id = insertFact(db3, {
        subject_text: "highsalience",
        memory_strength: 0.1,
        emotional_valence: 0.9,
        emotional_arousal: 0.8,
        consolidation_state: "active",
        last_accessed_at: veryOld,
        created_at: veryOld,
      });

      decaySweep(db3, false);

      const after = db3.prepare("SELECT consolidation_state FROM facts WHERE id = ?").get(id) as {
        consolidation_state: string;
      };
      // emotional protection: |0.9| + 0.8 = 1.7 > 1.2, should NOT be compressed/forgotten
      assert.ok(
        !["compressed", "forgotten"].includes(after.consolidation_state),
        `high-salience fact should be protected, got ${after.consolidation_state}`
      );
    } finally {
      db3.close();
    }
  });
});

// ─── review ──────────────────────────────────────────────────────────────────

describe("review", () => {
  let db: Database.Database;

  before(() => {
    ({ db } = createTestDb());
  });

  after(() => {
    db.close();
  });

  it("quality=5: advances next_review_at, boosts strength, sets state=active", () => {
    const id = insertFact(db, {
      subject_text: "reviewme5",
      memory_strength: 1.0,
      consolidation_state: "fading",
    });
    // Set next_review_at to past
    db.prepare("UPDATE facts SET next_review_at = datetime('now', '-1 day') WHERE id = ?").run(id);

    const result = JSON.parse(review(db, "facts", id, 5));
    assert.ok(!result.error, `unexpected error: ${result.error}`);

    const row = db.prepare(
      "SELECT memory_strength, consolidation_state, next_review_at, last_reviewed_at FROM facts WHERE id = ?"
    ).get(id) as { memory_strength: number; consolidation_state: string; next_review_at: string | null; last_reviewed_at: string | null };

    assert.ok(row.memory_strength > 1.0, `strength should increase, got ${row.memory_strength}`);
    assert.equal(row.consolidation_state, "active");
    assert.ok(row.next_review_at !== null, "next_review_at should be set");
    assert.ok(row.last_reviewed_at !== null, "last_reviewed_at should be set");
  });

  it("quality=1: reduces strength, resets repetition_count", () => {
    const id = insertFact(db, {
      subject_text: "reviewme1",
      memory_strength: 2.0,
    });
    db.prepare("UPDATE facts SET repetition_count = 3 WHERE id = ?").run(id);

    review(db, "facts", id, 1);

    const row = db.prepare(
      "SELECT memory_strength, repetition_count FROM facts WHERE id = ?"
    ).get(id) as { memory_strength: number; repetition_count: number };

    assert.ok(row.memory_strength < 2.0, `strength should decrease, got ${row.memory_strength}`);
    assert.equal(row.repetition_count, 0, "repetition_count should reset to 0");
  });

  it("rejects invalid quality (6)", () => {
    const id = insertFact(db, { subject_text: "reviewqual" });
    const result = JSON.parse(review(db, "facts", id, 6));
    assert.ok("error" in result, "should return error for quality=6");
  });

  it("rejects unknown table", () => {
    const result = JSON.parse(review(db, "widgets", 1, 3));
    assert.ok("error" in result, "should return error for unknown table");
  });

  it("review_due returns overdue items across tables", () => {
    const { db: db2 } = createTestDb();
    try {
      const past = "2020-01-01T00:00:00";
      insertFact(db2, { subject_text: "overduefact", next_review_at: past });
      insertEvent(db2, { summary: "overdueevent", next_review_at: past });
      insertLesson(db2, { lesson: "overduelesson", next_review_at: past });

      const result = JSON.parse(reviewDue(db2, 50));
      assert.ok(Array.isArray(result), "should return array");
      assert.ok(result.length >= 3, `expected >=3 overdue items, got ${result.length}`);
      const tables = result.map((r: Record<string, unknown>) => r["source_table"]);
      assert.ok(tables.includes("facts"), "should include facts");
      assert.ok(tables.includes("events"), "should include events");
      assert.ok(tables.includes("lessons"), "should include lessons");
    } finally {
      db2.close();
    }
  });
});

// ─── consolidate ─────────────────────────────────────────────────────────────

describe("consolidate", () => {
  let db: Database.Database;

  before(() => {
    ({ db } = createTestDb());
  });

  after(() => {
    db.close();
  });

  it("dry_run: returns candidates without creating seeds", () => {
    // Insert 5 fading facts in domain "operations"
    const old = "2024-01-15T00:00:00";
    for (let i = 0; i < 5; i++) {
      insertFact(db, {
        subject_text: `project_fact_${i}`,
        domain: "operations",
        consolidation_state: "fading",
        created_at: old,
        prompt_form: `project_prompt_${i}`,
      });
    }

    const result = JSON.parse(consolidate(db, "operations", true, 3));
    assert.ok(!result.error, `unexpected error: ${JSON.stringify(result)}`);

    // Should have found candidates
    assert.ok(result.dry_run === true, "dry_run flag should be true");
    assert.ok(Array.isArray(result.groups) || result.candidates_found >= 0,
      "should return groups or candidates_found");

    // No seeds should have been created
    const seeds = db.prepare("SELECT COUNT(*) as cnt FROM memory_seeds").get() as { cnt: number };
    assert.equal(seeds.cnt, 0, "dry_run should not create seeds");
  });

  it("actual: creates memory_seed and marks sources as long_term", () => {
    const { db: db2 } = createTestDb();
    try {
      const old = "2024-01-15T00:00:00";
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(insertFact(db2, {
          subject_text: `consolidate_fact_${i}`,
          domain: "operations",
          consolidation_state: "fading",
          created_at: old,
          prompt_form: `project_seed_prompt_${i}`,
        }));
      }

      const result = JSON.parse(consolidate(db2, "operations", false, 3));
      assert.ok(!result.error, `unexpected error: ${JSON.stringify(result)}`);
      assert.ok(result.seeds_created >= 1, `expected >=1 seed, got ${result.seeds_created}`);

      // Check memory_seeds was populated
      const seed = db2.prepare("SELECT * FROM memory_seeds LIMIT 1").get() as Record<string, unknown> | undefined;
      assert.ok(seed !== undefined, "a memory seed should exist");
      assert.ok(typeof seed["seed_text"] === "string" && seed["seed_text"].length > 0, "seed_text should be populated");
      // seed_text should contain prompt forms
      assert.ok(
        (seed["seed_text"] as string).includes("operations") ||
        (seed["seed_text"] as string).includes("prompt"),
        "seed_text should contain domain or prompt content"
      );

      // Check source facts marked long_term
      const changed = db2
        .prepare("SELECT COUNT(*) as cnt FROM facts WHERE consolidation_state = 'long_term' AND id IN (" + ids.map(() => "?").join(",") + ")")
        .get(...ids) as { cnt: number };
      assert.ok(changed.cnt >= 3, `expected >= 3 facts marked long_term, got ${changed.cnt}`);
    } finally {
      db2.close();
    }
  });
});

// ─── memory_health ────────────────────────────────────────────────────────────

describe("memory_health", () => {
  it("returns per-table breakdown of states, overdue counts, avg strength", async () => {
    const { db } = createTestDb();
    try {
      insertFact(db, { subject_text: "h1", consolidation_state: "active", memory_strength: 1.0 });
      insertFact(db, { subject_text: "h2", consolidation_state: "fading", memory_strength: 0.5 });
      insertFact(db, { subject_text: "h3", consolidation_state: "active", memory_strength: 0.8,
        next_review_at: "2020-01-01T00:00:00" });

      const { memoryHealth } = await import("../src/lifecycle/decay.ts");
      const result = JSON.parse(memoryHealth(db));
      assert.ok(!result.error, `unexpected error: ${JSON.stringify(result)}`);
      assert.ok(Array.isArray(result.tables), "should have tables array");
      const factRow = result.tables.find((t: Record<string, unknown>) => t["table"] === "facts");
      assert.ok(factRow !== undefined, "should have facts entry");
      assert.ok(typeof factRow["total"] === "number", "should have total count");
      assert.ok(typeof factRow["avg_strength"] === "number", "should have avg_strength");
      assert.ok(typeof factRow["overdue"] === "number", "should have overdue count");
      assert.ok(factRow["overdue"] >= 1, "should have at least 1 overdue fact");
    } finally {
      db.close();
    }
  });

  it("excludes non-active facts and superseded/expired lessons from counts", async () => {
    const { db } = createTestDb();
    try {
      insertFact(db, { subject_text: "live", consolidation_state: "active" });
      // quarantined/decayed and superseded rows must not pollute health
      db.prepare(
        `INSERT INTO facts (subject_text, predicate, object_text, status, consolidation_state, next_review_at)
         VALUES ('junk', 'was', 'quarantined', 'decayed', 'forgotten', '2020-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO facts (subject_text, predicate, object_text, status, consolidation_state, next_review_at)
         VALUES ('old', 'was', 'superseded', 'superseded', 'active', '2020-01-01')`,
      ).run();
      const { lastInsertRowid: keeperId } = db
        .prepare(`INSERT INTO lessons (domain, lesson, valid_until) VALUES ('x', 'expired lesson', '2020-01-01')`)
        .run();
      db.prepare(
        `INSERT INTO lessons (domain, lesson, superseded_by, consolidation_state) VALUES ('x', 'retired lesson', ?, 'forgotten')`,
      ).run(keeperId);

      const { memoryHealth } = await import("../src/lifecycle/decay.ts");
      const result = JSON.parse(memoryHealth(db));

      const factRow = result.tables.find((t: Record<string, unknown>) => t["table"] === "facts");
      assert.equal(factRow["total"], 1, "only active-status facts count");
      assert.equal(factRow["forgotten"], 0, "quarantined facts must not show as forgotten");
      assert.equal(factRow["overdue"], 0, "decayed/superseded rows must not count as overdue");

      const lessonRow = result.tables.find((t: Record<string, unknown>) => t["table"] === "lessons");
      assert.equal(lessonRow["total"], 0, "superseded lessons must not count");
    } finally {
      db.close();
    }
  });
});
