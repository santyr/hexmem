import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_GATEWAY_TOOL_NAMES,
  DETAILED_TOOL_NAMES,
  resolveToolProfile,
  toolNamesForProfile,
  registerTools,
} from "../src/tools.ts";

class FakeServer {
  names: string[] = [];
  registerTool(name: string): void {
    this.names.push(name);
  }
}

describe("tool profile filtering", () => {
  it("defaults to agent-full and preserves detailed tools", () => {
    assert.equal(resolveToolProfile(undefined), "agent-full");
    const names = toolNamesForProfile("agent-full");
    assert.ok(names.includes("hexmem_fact_add"));
    assert.ok(names.includes("hexmem_recall"));
  });

  it("agent-minimal exposes only gateway tools", () => {
    const names = toolNamesForProfile("agent-minimal");
    assert.deepEqual(names, AGENT_GATEWAY_TOOL_NAMES);
    assert.ok(!names.includes("hexmem_fact_add"));
    assert.ok(!names.includes("hexmem_decay_sweep"));
  });

  it("agent-admin is recognized and includes detailed tools", () => {
    assert.equal(resolveToolProfile("agent-admin"), "agent-admin");
    const names = toolNamesForProfile("agent-admin");
    assert.ok(names.includes("hexmem_memory_health"));
    assert.ok(names.length >= AGENT_GATEWAY_TOOL_NAMES.length + DETAILED_TOOL_NAMES.length);
  });

  it("full profile advertises every registered tool", () => {
    const server = new FakeServer();
    registerTools(server as never, "agent-full");
    const advertised = new Set(toolNamesForProfile("agent-full"));
    const missing = server.names.filter((name) => !advertised.has(name));

    assert.deepEqual(missing, []);
  });

  it("registerTools respects explicit agent-minimal profile", () => {
    const server = new FakeServer();
    registerTools(server as never, "agent-minimal");
    assert.deepEqual(server.names, AGENT_GATEWAY_TOOL_NAMES);
  });
});
