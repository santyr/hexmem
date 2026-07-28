import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createTestDb } from "./helpers.ts";
import { ensureVecTables, upsertVec, vecSearch, vecAvailable } from "../src/retrieval/vec.ts";
import { drainEmbeddingQueue } from "../src/retrieval/queue-worker.ts";
import { hybridSearch } from "../src/retrieval/hybrid.ts";
import type { Embedder } from "../src/types.ts";

/**
 * Deterministic fake embedder: character-bigram hashing into 384 dims,
 * L2-normalized. Similar texts get similar vectors; no model download.
 */
function fakeEmbedder(): Embedder {
  return {
    dimensions: 384,
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      const lower = text.toLowerCase();
      for (let i = 0; i < lower.length - 1; i++) {
        const h = (lower.charCodeAt(i) * 31 + lower.charCodeAt(i + 1)) % 384;
        vec[h] += 1;
      }
      let norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
      if (norm === 0) norm = 1;
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      return vec;
    },
  };
}

function vecTestDb(): Database.Database {
  const { db } = createTestDb();
  sqliteVec.load(db);
  // The test schema has no embedding_queue or its triggers — add the queue
  // (migration 006 shape) so drain tests can exercise it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_queue (
      id INTEGER PRIMARY KEY,
      source_table TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      text_to_embed TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      UNIQUE(source_table, source_id)
    );
  `);
  return db;
}

describe("vector store", () => {
  let db: Database.Database;
  const embedder = fakeEmbedder();

  beforeEach(() => {
    db = vecTestDb();
    ensureVecTables(db);
  });

  it("vecAvailable is true with extension loaded", () => {
    assert.equal(vecAvailable(db), true);
  });

  it("upsert + KNN returns the nearest source row with filters applied", async () => {
    db.prepare(
      "INSERT INTO facts (id, subject_text, predicate, object_text, domain, status) VALUES (1, 'ProjectAlpha service', 'need', 'capacity for requests', 'operations', 'active')",
    ).run();
    db.prepare(
      "INSERT INTO facts (id, subject_text, predicate, object_text, domain, status) VALUES (2, 'ProjectBeta project', 'needs', 'planning for the next release', 'homestead', 'active')",
    ).run();

    upsertVec(db, "facts", 1, await embedder.embed("ProjectAlpha service need capacity for requests"));
    upsertVec(db, "facts", 2, await embedder.embed("ProjectBeta project needs planning for the next release"));

    const results = vecSearch(db, await embedder.embed("channel liquidity routing"), 5, "private");
    assert.ok(results.length >= 2);
    assert.equal(results[0].id, 1, "ProjectAlpha fact should be nearest to a capacity query");
  });

  it("KNN respects sensitivity and status filters", async () => {
    db.prepare(
      "INSERT INTO facts (id, subject_text, predicate, object_text, sensitivity, status) VALUES (1, 'secret sauce', 'is', 'private recipe data', 'private', 'active')",
    ).run();
    upsertVec(db, "facts", 1, await embedder.embed("secret sauce private recipe data"));

    const publicResults = vecSearch(db, await embedder.embed("secret sauce recipe"), 5, "public");
    assert.equal(publicResults.length, 0, "private fact must not appear at public sensitivity");
  });

  it("upsert replaces an existing vector", async () => {
    db.prepare(
      "INSERT INTO facts (id, subject_text, predicate, object_text, status) VALUES (1, 'thing', 'is', 'old text', 'active')",
    ).run();
    upsertVec(db, "facts", 1, await embedder.embed("old text"));
    upsertVec(db, "facts", 1, await embedder.embed("completely different replacement text"));

    const count = db.prepare("SELECT COUNT(*) c FROM vec_facts").get() as { c: number };
    assert.equal(count.c, 1);
  });
});

describe("embedding queue drain", () => {
  let db: Database.Database;
  const embedder = fakeEmbedder();

  beforeEach(() => {
    db = vecTestDb();
  });

  it("drains pending rows into vec tables and marks them done", async () => {
    db.prepare(
      "INSERT INTO facts (id, subject_text, predicate, object_text, status) VALUES (1, 'a', 'b', 'c', 'active')",
    ).run();
    db.prepare(
      "INSERT INTO lessons (id, domain, lesson) VALUES (1, 'operations', 'drain me')",
    ).run();
    db.prepare(
      "INSERT INTO embedding_queue (source_table, source_id, text_to_embed) VALUES ('facts', 1, 'a b c'), ('lessons', 1, 'drain me')",
    ).run();

    const result = await drainEmbeddingQueue(db, embedder, 10);
    assert.equal(result.processed, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.remaining, 0);

    const factVecs = db.prepare("SELECT COUNT(*) c FROM vec_facts").get() as { c: number };
    const lessonVecs = db.prepare("SELECT COUNT(*) c FROM vec_lessons").get() as { c: number };
    assert.equal(factVecs.c, 1);
    assert.equal(lessonVecs.c, 1);

    const done = db.prepare("SELECT COUNT(*) c FROM embedding_queue WHERE status='done'").get() as { c: number };
    assert.equal(done.c, 2);
  });

  it("marks unknown source tables failed without stopping the batch", async () => {
    db.prepare(
      "INSERT INTO embedding_queue (source_table, source_id, text_to_embed) VALUES ('nonsense', 1, 'x'), ('facts', 1, 'valid text')",
    ).run();

    const result = await drainEmbeddingQueue(db, embedder, 10);
    assert.equal(result.failed, 1);
    assert.equal(result.processed, 1);
  });
});

describe("hybrid RRF retrieval", () => {
  let db: Database.Database;
  const embedder = fakeEmbedder();

  beforeEach(() => {
    db = vecTestDb();
    ensureVecTables(db);
  });

  it("merges FTS and vector hits, deduping by ref", async () => {
    // Row 1 matches by keyword AND vector; row 2 only semantically related
    db.prepare(
      "INSERT INTO facts (id, subject_text, predicate, object_text, status) VALUES (1, 'rebalance engine', 'uses', 'getroutes with sendpay', 'active')",
    ).run();
    db.prepare(
      "INSERT INTO facts (id, subject_text, predicate, object_text, status) VALUES (2, 'circular payments', 'move', 'liquidity between channels', 'active')",
    ).run();

    upsertVec(db, "facts", 1, await embedder.embed("rebalance engine uses getroutes with sendpay"));
    upsertVec(db, "facts", 2, await embedder.embed("circular payments move liquidity between channels"));

    const results = await hybridSearch(db, "rebalance getroutes", 10, "private", embedder);
    const refs = results.map((r) => `${r.table}:${r.id}`);

    assert.equal(new Set(refs).size, refs.length, "no duplicate refs after merge");
    assert.equal(refs[0], "facts:1", "row in both lists should rank first");
    assert.ok(refs.includes("facts:2"), "vector-only hit should still surface");
  });

  it("degrades to FTS-only with a null embedder", async () => {
    db.prepare(
      "INSERT INTO facts (id, subject_text, predicate, object_text, status) VALUES (1, 'plainkeyword', 'is', 'here', 'active')",
    ).run();
    const results = await hybridSearch(db, "plainkeyword", 10, "private", null);
    assert.equal(results.length, 1);
  });
});
