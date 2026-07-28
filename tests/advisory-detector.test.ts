import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectAdvisoryPatterns, type ConversationMessage } from "../src/learning/advisory-detector";

function msgs(...pairs: [string, string][]): ConversationMessage[] {
  return pairs.flatMap(([assistantText, user]) => [
    { role: "assistant" as const, text: assistantText },
    { role: "user" as const, text: user },
  ]);
}

describe("advisory pattern detector", () => {
  it("detects adoption from explicit agreement", () => {
    const results = detectAdvisoryPatterns(msgs(
      ["I suggest using TypeScript for this project.", "Yes, good idea. Let's do that."]
    ));
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "adopted");
  });

  it("detects correction from explicit disagreement", () => {
    const results = detectAdvisoryPatterns(msgs(
      ["You should restart the service.", "No, actually we need to check logs first."]
    ));
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "corrected");
  });

  it("detects ignored from topic change", () => {
    const results = detectAdvisoryPatterns(msgs(
      ["I recommend adding error handling here.", "What time is the meeting tomorrow?"]
    ));
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "ignored");
  });

  it("detects adoption from building on suggestion", () => {
    const results = detectAdvisoryPatterns(msgs(
      ["We could add a cache layer.", "Good point, and we should also add TTL expiration."]
    ));
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "adopted");
  });

  it("returns empty for non-advisory messages", () => {
    const results = detectAdvisoryPatterns(msgs(
      ["The hostname is ogsatoth.", "Thanks."]
    ));
    assert.equal(results.length, 0);
  });

  it("handles multiple exchanges", () => {
    const results = detectAdvisoryPatterns(msgs(
      ["Try approach A.", "Yes, that works."],
      ["Also consider approach B.", "No, B won't work here."]
    ));
    assert.equal(results.length, 2);
    assert.equal(results[0].outcome, "adopted");
    assert.equal(results[1].outcome, "corrected");
  });

  it("includes action_summary from assistant message", () => {
    const results = detectAdvisoryPatterns(msgs(
      ["I suggest using Read instead of cat.", "Good call."]
    ));
    assert.ok(results[0].action_summary.includes("Read"));
  });
});
