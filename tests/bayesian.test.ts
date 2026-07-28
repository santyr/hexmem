import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers";
import {
  updatePosterior,
  computeConfidence,
  posteriorDecay,
  getAsymmetricWeight,
} from "../src/learning/bayesian";

describe("Bayesian update engine", () => {
  it("computeConfidence returns alpha / (alpha + beta)", () => {
    assert.equal(computeConfidence(4, 1), 0.8);
    assert.equal(computeConfidence(1, 1), 0.5);
    assert.equal(computeConfidence(9, 1), 0.9);
  });

  it("updatePosterior increases alpha on positive outcome", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("test", "test lesson", 0.8, 4.0, 1.0);

    const result = updatePosterior(db, 1, "adopted", 1.0);
    assert.ok(result.alpha > 4.0);
    assert.equal(result.beta_param, 1.0);
    assert.ok(result.confidence > 0.8);
    db.close();
  });

  it("updatePosterior increases beta_param on negative outcome", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("test", "test lesson", 0.8, 4.0, 1.0);

    const result = updatePosterior(db, 1, "corrected", 1.0);
    assert.equal(result.alpha, 4.0);
    assert.ok(result.beta_param > 1.0);
    assert.ok(result.confidence < 0.8);
    db.close();
  });

  it("updatePosterior adds weak negative for ignored outcome", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("test", "test lesson", 0.5, 2.5, 2.5);

    const result = updatePosterior(db, 1, "ignored", 1.0);
    assert.equal(result.alpha, 2.5);
    assert.ok(result.beta_param > 2.5);
    assert.ok(result.beta_param < 3.0);
    db.close();
  });

  it("updatePosterior applies custom weight", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("test", "test lesson", 0.5, 2.5, 2.5);

    const result = updatePosterior(db, 1, "corrected", 2.0);
    assert.equal(result.beta_param, 4.5);
    db.close();
  });

  it("updatePosterior updates confidence column to posterior mean", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("test", "test lesson", 0.8, 4.0, 1.0);

    updatePosterior(db, 1, "adopted", 1.0);

    const row = db.prepare("SELECT confidence, alpha, beta_param FROM lessons WHERE id = 1").get() as any;
    const expectedConfidence = row.alpha / (row.alpha + row.beta_param);
    assert.equal(row.confidence, expectedConfidence);
    db.close();
  });

  it("updatePosterior increments times_validated on positive", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("test", "test lesson", 0.8, 4.0, 1.0);

    updatePosterior(db, 1, "success", 1.0);
    const row = db.prepare("SELECT times_validated FROM lessons WHERE id = 1").get() as any;
    assert.equal(row.times_validated, 1);
    db.close();
  });

  it("updatePosterior increments times_contradicted on negative", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, confidence, alpha, beta_param) VALUES (?, ?, ?, ?, ?)"
    ).run("test", "test lesson", 0.8, 4.0, 1.0);

    updatePosterior(db, 1, "corrected", 1.0);
    const row = db.prepare("SELECT times_contradicted FROM lessons WHERE id = 1").get() as any;
    assert.equal(row.times_contradicted, 1);
    db.close();
  });

  it("getAsymmetricWeight returns 2.0 for security domain negatives", () => {
    assert.equal(getAsymmetricWeight("security", "corrected"), 2.0);
    assert.equal(getAsymmetricWeight("security", "adopted"), 1.0);
  });

  it("getAsymmetricWeight returns 0.5 for social domain positives", () => {
    assert.equal(getAsymmetricWeight("social", "adopted"), 0.5);
    assert.equal(getAsymmetricWeight("social", "corrected"), 1.0);
  });

  it("getAsymmetricWeight returns 1.0 for default domain", () => {
    assert.equal(getAsymmetricWeight("technical", "adopted"), 1.0);
    assert.equal(getAsymmetricWeight("technical", "corrected"), 1.0);
  });

  it("posteriorDecay multiplies alpha and beta by factor with floor", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, alpha, beta_param) VALUES (?, ?, ?, ?)"
    ).run("test", "lesson1", 10.0, 2.0);
    db.prepare(
      "INSERT INTO lessons (domain, lesson, alpha, beta_param) VALUES (?, ?, ?, ?)"
    ).run("test", "lesson2", 1.0, 1.0);

    const result = posteriorDecay(db, 0.5, false);
    assert.equal(result.updated, 2);

    const row1 = db.prepare("SELECT alpha, beta_param FROM lessons WHERE id = 1").get() as any;
    assert.equal(row1.alpha, 5.0);
    assert.equal(row1.beta_param, 1.0);

    const row2 = db.prepare("SELECT alpha, beta_param FROM lessons WHERE id = 2").get() as any;
    assert.equal(row2.alpha, 1.0);
    assert.equal(row2.beta_param, 1.0);
    db.close();
  });

  it("posteriorDecay in dry_run mode does not modify data", () => {
    const { db } = createTestDb();
    db.prepare(
      "INSERT INTO lessons (domain, lesson, alpha, beta_param) VALUES (?, ?, ?, ?)"
    ).run("test", "lesson1", 10.0, 2.0);

    const result = posteriorDecay(db, 0.5, true);
    assert.equal(result.updated, 0);

    const row = db.prepare("SELECT alpha FROM lessons WHERE id = 1").get() as any;
    assert.equal(row.alpha, 10.0);
    db.close();
  });
});
