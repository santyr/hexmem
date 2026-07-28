import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.ts";
import { factAddHandler } from "../src/tools/facts.ts";
import { lessonAddHandler } from "../src/tools/lessons.ts";
import { eventAddHandler } from "../src/tools/events.ts";
import { hasDanglingReferent } from "../src/quality.ts";

describe("write-path quality gates", () => {
  let db: Database.Database;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  describe("fact dedup", () => {
    it("returns duplicate ref instead of inserting a near-identical fact", async () => {
      const first = JSON.parse(
        await factAddHandler(
          { subject_text: "AgentExample", predicate: "runs", object_text: "ExampleRuntime with extensions", domain: "operations" },
          db,
        ),
      );
      assert.equal(first.status, "created");

      const second = JSON.parse(
        await factAddHandler(
          { subject_text: "AgentExample", predicate: "runs", object_text: "ExampleRuntime, with extensions!", domain: "operations" },
          db,
        ),
      );
      assert.equal(second.status, "duplicate");
      assert.equal(second.ref, `facts:${first.id}`);

      const count = db.prepare("SELECT COUNT(*) c FROM facts").get() as { c: number };
      assert.equal(count.c, 1);
    });

    it("allows a duplicate when allow_duplicate is set", async () => {
      await factAddHandler(
        { subject_text: "AgentExample", predicate: "runs", object_text: "ExampleRuntime", domain: "operations" },
        db,
      );
      const second = JSON.parse(
        await factAddHandler(
          { subject_text: "AgentExample", predicate: "runs", object_text: "ExampleRuntime", domain: "operations", allow_duplicate: true },
          db,
        ),
      );
      assert.equal(second.status, "created");
    });

    it("does not flag distinct facts as duplicates", async () => {
      await factAddHandler(
        { subject_text: "AgentExample", predicate: "runs", object_text: "ExampleRuntime v1", domain: "operations" },
        db,
      );
      const second = JSON.parse(
        await factAddHandler(
          { subject_text: "AgentExample", predicate: "peers_with", object_text: "ACINQ", domain: "operations" },
          db,
        ),
      );
      assert.equal(second.status, "created");
    });
  });

  describe("dangling referent guard", () => {
    it("rejects facts whose subject is a demonstrative or pronoun", async () => {
      for (const subject of ["this route", "their node", "it", "that channel"]) {
        const res = JSON.parse(
          await factAddHandler(
            { subject_text: subject, predicate: "has", object_text: "some property", domain: "operations" },
            db,
          ),
        );
        assert.equal(res.status, "rejected", `subject "${subject}" should be rejected`);
        assert.equal(res.reason, "dangling_referent");
      }
    });

    it("accepts with allow_unresolved override", async () => {
      const res = JSON.parse(
        await factAddHandler(
          {
            subject_text: "this route",
            predicate: "has",
            object_text: "context",
            domain: "operations",
            allow_unresolved: true,
          },
          db,
        ),
      );
      assert.equal(res.status, "created");
    });

    it("accepts concrete subjects including 'The X' forms", async () => {
      const res = JSON.parse(
        await factAddHandler(
          { subject_text: "The ExampleRuntime extension", predicate: "supports", object_text: "layers", domain: "project" },
          db,
        ),
      );
      assert.equal(res.status, "created");
    });

    it("pronoun-check helper flags bare and leading pronouns only", () => {
      assert.equal(hasDanglingReferent("it"), true);
      assert.equal(hasDanglingReferent("this route"), true);
      assert.equal(hasDanglingReferent("itinerary planning"), false);
      assert.equal(hasDanglingReferent("theymos"), false);
    });
  });

  describe("length guard", () => {
    it("rejects an overly long event unless allow_long", async () => {
      const essay = "word ".repeat(300);
      const rejected = JSON.parse(
        await eventAddHandler({ event_type: "note", summary: "big", details: essay }, db),
      );
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.reason, "too_long");

      const allowed = JSON.parse(
        await eventAddHandler({ event_type: "note", summary: "big", details: essay, allow_long: true }, db),
      );
      assert.equal(allowed.status, "logged");
    });

    it("accepts normal-sized events", async () => {
      const res = JSON.parse(
        await eventAddHandler({ event_type: "milestone", summary: "Deployed the fee controller" }, db),
      );
      assert.equal(res.status, "logged");
    });
  });

  describe("lesson dedup", () => {
    it("returns duplicate ref for a near-identical lesson", async () => {
      const first = JSON.parse(
        await lessonAddHandler(
          { domain: "project", lesson: "Maintenance cycles always close active work - exclude them from expansion" },
          db,
        ),
      );
      const second = JSON.parse(
        await lessonAddHandler(
          { domain: "operations", lesson: "Maintenance cycles always close active work — exclude them from expansion." },
          db,
        ),
      );
      assert.equal(second.status, "duplicate");
      assert.equal(second.ref, `lessons:${first.id}`);
    });
  });

  describe("event episodic dedup window", () => {
    it("blocks same-summary event within 48h but allows an old twin", async () => {
      db.prepare(
        "INSERT INTO events (event_type, summary, created_at, occurred_at) VALUES ('milestone', 'Deployed fee controller', datetime('now','-10 days'), datetime('now','-10 days'))",
      ).run();

      const fresh = JSON.parse(
        await eventAddHandler({ event_type: "milestone", summary: "Deployed fee controller" }, db),
      );
      assert.equal(fresh.status, "logged", "10-day-old twin should not block a new episodic event");

      const repeat = JSON.parse(
        await eventAddHandler({ event_type: "milestone", summary: "Deployed fee controller" }, db),
      );
      assert.equal(repeat.status, "duplicate", "same-session repeat should be blocked");
    });
  });
});
