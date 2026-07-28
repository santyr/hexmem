import assert from "node:assert/strict";
import test from "node:test";

import { startHttpServer } from "../src/http.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestDb } from "./helpers.ts";
import {
  dispatchRuntimeMode,
  resolveRuntimeMode,
  runRuntime,
} from "../src/runtime.js";

test("resolveRuntimeMode defaults to http", () => {
  assert.equal(resolveRuntimeMode([]), "http");
});

test("resolveRuntimeMode selects stdio when requested", () => {
  assert.equal(resolveRuntimeMode(["--stdio"]), "stdio");
});

test("startHttpServer is available for default runtime dispatch", () => {
  assert.equal(typeof startHttpServer, "function");
});

test("dispatchRuntimeMode routes to stdio handler", async () => {
  const calls: string[] = [];

  await dispatchRuntimeMode("stdio", {
    startHttpServer: async () => {
      calls.push("http");
    },
    startStdioServer: async () => {
      calls.push("stdio");
    },
  });

  assert.deepEqual(calls, ["stdio"]);
});

test("dispatchRuntimeMode routes to http handler", async () => {
  const calls: string[] = [];

  await dispatchRuntimeMode("http", {
    startHttpServer: async () => {
      calls.push("http");
    },
    startStdioServer: async () => {
      calls.push("stdio");
    },
  });

  assert.deepEqual(calls, ["http"]);
});

test("runRuntime dispatches to stdio or http", async () => {
  const calls: string[] = [];

  await runRuntime([], {
    startStdioServer: async () => {
      calls.push("stdio");
    },
    startHttpServer: async () => {
      calls.push("http");
    },
  });

  await runRuntime(["--stdio"], {
    startStdioServer: async () => {
      calls.push("stdio");
    },
    startHttpServer: async () => {
      calls.push("http");
    },
  });

  assert.deepEqual(calls, ["http", "stdio"]);
});

test("startStdioServer serves MCP tools over stdio", async () => {
  const { db, path } = createTestDb();
  db.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts", "--stdio"],
    cwd: process.cwd(),
    env: { HEXMEM_DB: path },
    stderr: "pipe",
  });
  const client = new Client({ name: "hexmem-stdio-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "hexmem_recall"));
    assert.ok(tools.tools.some((tool) => tool.name === "hexmem_identity"));
  } finally {
    await client.close();
  }
});
