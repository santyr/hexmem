import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import { searchHandler } from "../src/tools/search.ts";
import { buildMatchQuery } from "../src/retrieval/fts.ts";

interface SearchItem {
  ref: string;
  kind: string;
  domain?: string;
  text: string;
  score: number;
  sensitivity?: string;
}

interface SearchResponse {
  status: string;
  items: SearchItem[];
  item_tokens: number;
  truncated: boolean;
}

describe("searchHandler", () => {
  let db: Database.Database;

  before(() => {
    const { db: testDb } = createTestDb();
    db = testDb;

    // FTS sync is handled by triggers (migration 023 parity in helpers.ts)
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, domain, sensitivity, status, prompt_form)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(1, "AgentExample", "runs_on", "ProjectAlpha", "project", "public", "active", "agent_runs_project");

    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, domain, sensitivity, status, prompt_form)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(2, "AgentExample", "access_level", "administrator", "financial", "private", "active", "agent_access");

    db.prepare(
      `INSERT INTO events (id, event_type, category, summary, sensitivity, prompt_form)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(1, "milestone", "project", "Released ProjectAlpha v1", "public", "released_v1");

    db.prepare(
      `INSERT INTO lessons (id, domain, lesson, sensitivity, prompt_form)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, "coding", "Always test edge cases", "public", "test_edges");

    // For ranking: a fact mentioning timeout, and one mentioning both timeout and rebalance
    db.prepare(
      `INSERT INTO facts (id, subject_text, predicate, object_text, domain, sensitivity, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(3, "WorkerExample", "default_timeout", "15 seconds via service adapter", "operations", "public", "active");

    db.prepare(
      `INSERT INTO lessons (id, domain, lesson, sensitivity)
       VALUES (?, ?, ?, ?)`
    ).run(2, "operations", "Long-running tasks need a 45s timeout for complex workloads", "public");
  });

  after(() => {
    db.close();
  });

  it("finds fact when keyword matches object_text", async () => {
    const json = await searchHandler({ query: "ProjectAlpha", max_sensitivity: "public" }, db);
    const res = JSON.parse(json) as SearchResponse;
    assert.equal(res.status, "ok");
    const fact = res.items.find((i) => i.ref === "facts:1");
    assert.ok(fact, "should find facts:1");
    assert.ok(fact.text.includes("ProjectAlpha"));
  });

  it("multi-term query where no single row has all terms falls back to OR", async () => {
    // "timeout" appears in facts:3 and lessons:2; "access" only in facts:2.
    // No row contains both, so AND yields nothing — OR fallback must kick in.
    const json = await searchHandler({ query: "timeout access", max_sensitivity: "private" }, db);
    const res = JSON.parse(json) as SearchResponse;
    assert.ok(res.items.length >= 2, `OR fallback should surface partial matches, got ${res.items.length}`);
  });

  it("row matching more query terms ranks above row matching fewer", async () => {
    const json = await searchHandler({ query: "long-running timeout workloads", max_sensitivity: "public" }, db);
    const res = JSON.parse(json) as SearchResponse;
    assert.ok(res.items.length >= 1, "should find the timeout lesson");
    assert.equal(res.items[0].ref, "lessons:2", "lesson matching all three terms should rank first");
  });

  it("output items contain no prompt_form and scores are present", async () => {
    const json = await searchHandler({ query: "ProjectAlpha", max_sensitivity: "public" }, db);
    const res = JSON.parse(json) as SearchResponse;
    for (const item of res.items) {
      assert.ok(!("prompt_form" in item), "prompt_form must not be in search output");
      assert.ok(!("content" in item), "raw row dump must not be in search output");
      assert.equal(typeof item.score, "number");
    }
  });

  it("respects budget_tokens and reports truncation", async () => {
    const json = await searchHandler(
      { query: "timeout access ProjectAlpha", max_sensitivity: "private", budget_tokens: 20 },
      db,
    );
    const res = JSON.parse(json) as SearchResponse;
    assert.ok(res.item_tokens <= 40, "tiny budget should keep output small");
    assert.ok(res.truncated, "should report truncation with a tiny budget");
  });

  it("excludes private data when max_sensitivity is public", async () => {
    const json = await searchHandler({ query: "access", max_sensitivity: "public" }, db);
    const res = JSON.parse(json) as SearchResponse;
    assert.equal(res.items.length, 0, "private access fact should be excluded");
  });

  it("finds private fact when max_sensitivity is private", async () => {
    const json = await searchHandler({ query: "access", max_sensitivity: "private" }, db);
    const res = JSON.parse(json) as SearchResponse;
    assert.ok(res.items.some((i) => i.ref === "facts:2"));
  });

  it("finds event and lesson matches", async () => {
    const eventRes = JSON.parse(
      await searchHandler({ query: "Released", max_sensitivity: "public" }, db),
    ) as SearchResponse;
    assert.ok(eventRes.items.some((i) => i.ref === "events:1"));

    const lessonRes = JSON.parse(
      await searchHandler({ query: "edge cases", max_sensitivity: "public" }, db),
    ) as SearchResponse;
    assert.ok(lessonRes.items.some((i) => i.ref === "lessons:1"));
  });

  it("returns empty items for empty query", async () => {
    const res = JSON.parse(
      await searchHandler({ query: "", max_sensitivity: "public" }, db),
    ) as SearchResponse;
    assert.equal(res.items.length, 0);
  });

  it("returns error JSON for invalid max_sensitivity", async () => {
    const result = JSON.parse(
      await searchHandler({ query: "test", max_sensitivity: "confidential" }, db),
    );
    assert.ok("error" in result);
  });

  it("does not crash on FTS syntax characters in query", async () => {
    const res = JSON.parse(
      await searchHandler({ query: 'timeout AND (rebalance" OR *', max_sensitivity: "public" }, db),
    ) as SearchResponse;
    assert.equal(res.status, "ok");
  });
});

describe("buildMatchQuery", () => {
  it("quotes terms and builds AND/OR variants", () => {
    const q = buildMatchQuery("getroutes timeout rebalance");
    assert.equal(q.and, '"getroutes" AND "timeout" AND "rebalance"');
    assert.equal(q.or, '"getroutes" OR "timeout" OR "rebalance"');
    assert.equal(q.terms.length, 3);
  });

  it("drops FTS operator words so pre-ORed queries stay valid", () => {
    const q = buildMatchQuery("alpha OR beta AND gamma NOT delta");
    assert.deepEqual(q.terms, ["alpha", "beta", "gamma", "delta"]);
  });

  it("returns empty for punctuation-only input", () => {
    const q = buildMatchQuery("(((***)))");
    assert.equal(q.terms.length, 0);
    assert.equal(q.and, "");
  });
});
