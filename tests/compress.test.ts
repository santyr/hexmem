import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compress } from "../src/compress.ts";

describe("compress", () => {
  it("returns empty string for empty input", () => {
    assert.equal(compress(""), "");
  });

  it("applies symbol replacements", () => {
    const result = compress("X is equal to Y");
    assert.ok(result.includes("="), `expected '=' in: ${result}`);
  });

  it("applies arrow replacement for leads to", () => {
    const result = compress("A leads to B");
    assert.ok(result.includes("→"), `expected '→' in: ${result}`);
  });

  it("strips stop words", () => {
    const result = compress("the quick brown fox");
    assert.ok(!result.includes("the"), `'the' should be stripped: ${result}`);
  });

  it("collapses spaces to underscores", () => {
    const result = compress("hello world");
    assert.ok(result.includes("_"), `expected underscore in: ${result}`);
    assert.ok(!result.includes(" "), `expected no spaces in: ${result}`);
  });

  it("removes trailing separators", () => {
    const result = compress("hello world.");
    assert.ok(!result.endsWith("_"), `should not end with '_': ${result}`);
    assert.ok(!result.endsWith(";"), `should not end with ';': ${result}`);
  });

  it("collapses double underscores", () => {
    // stop-word removal can create double underscores
    const result = compress("this is a test");
    assert.ok(!result.includes("__"), `double underscore in: ${result}`);
  });

  it("handles sentence with period replacement", () => {
    // ". " → ";"
    const result = compress("hello world. foo bar");
    assert.ok(result.includes(";"), `expected ';' in: ${result}`);
  });

  it("handles non-empty whitespace-only input gracefully", () => {
    const result = compress("   ");
    // After trim + stop-word stripping, should be empty or just underscores cleaned
    assert.equal(typeof result, "string");
  });
});
