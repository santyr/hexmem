import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers";
import { primeHandler, primingStateHandler } from "../src/tools/priming";

describe("priming activation decay", () => {
  it("fresh priming entries have activation_level 1.0", async () => {
    const { db } = createTestDb();
    await primeHandler({ item_type: "concept", item_name: "ProjectAlpha", source: "test" }, db);

    const state = JSON.parse(await primingStateHandler({}, db));
    assert.equal(state.length, 1);
    assert.equal(state[0].item_name, "ProjectAlpha");
    assert.ok(state[0].activation_level > 0.99, `Expected ~1.0, got ${state[0].activation_level}`);
    db.close();
  });

  it("activation_level decays based on time since activation", async () => {
    const { db } = createTestDb();

    // Insert a priming entry that was activated 3 days ago
    db.prepare(`
      INSERT INTO priming_state (item_type, item_name, source, activation_level, activated_at, expires_at)
      VALUES ('concept', 'old-topic', 'test', 1.0, datetime('now', '-3 days'), datetime('now', '+7 days'))
    `).run();

    const state = JSON.parse(await primingStateHandler({}, db));
    assert.equal(state.length, 1);
    // After 3 days at 10%/day: 1.0 * max(0, 1.0 - 0.1 * 3) = 0.7
    assert.ok(state[0].activation_level > 0.6 && state[0].activation_level < 0.8,
      `Expected ~0.7, got ${state[0].activation_level}`);
    db.close();
  });

  it("entries decayed below 0.1 are cleaned up", async () => {
    const { db } = createTestDb();

    // Insert a priming entry activated 10 days ago (would decay to 0)
    db.prepare(`
      INSERT INTO priming_state (item_type, item_name, source, activation_level, activated_at, expires_at)
      VALUES ('concept', 'ancient-topic', 'test', 1.0, datetime('now', '-10 days'), datetime('now', '+50 days'))
    `).run();

    const state = JSON.parse(await primingStateHandler({}, db));
    assert.equal(state.length, 0, "Entry decayed to 0 should be cleaned up");
    db.close();
  });

  it("expired entries are removed regardless of activation_level", async () => {
    const { db } = createTestDb();

    db.prepare(`
      INSERT INTO priming_state (item_type, item_name, source, activation_level, activated_at, expires_at)
      VALUES ('concept', 'expired-topic', 'test', 1.0, datetime('now', '-1 hour'), datetime('now', '-30 minutes'))
    `).run();

    const state = JSON.parse(await primingStateHandler({}, db));
    assert.equal(state.length, 0, "Expired entry should be removed");
    db.close();
  });

  it("results are sorted by activation_level descending", async () => {
    const { db } = createTestDb();

    // Fresh entry
    await primeHandler({ item_type: "concept", item_name: "fresh", source: "test" }, db);

    // 2-day-old entry
    db.prepare(`
      INSERT INTO priming_state (item_type, item_name, source, activation_level, activated_at, expires_at)
      VALUES ('concept', 'older', 'test', 1.0, datetime('now', '-2 days'), datetime('now', '+5 days'))
    `).run();

    const state = JSON.parse(await primingStateHandler({}, db));
    assert.equal(state.length, 2);
    assert.equal(state[0].item_name, "fresh");
    assert.ok(state[0].activation_level > state[1].activation_level,
      "Fresh entry should have higher activation than older one");
    db.close();
  });
});
