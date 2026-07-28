import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTestDb } from "./helpers.ts";
import { startHttpServer } from "../src/http.js";

test("hexmem http server exposes health on localhost", async () => {
  const { db, path } = createTestDb();
  db.close();

  const service = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: path,
  });

  try {
    const address = service.address();
    assert.ok(address && typeof address === "object" && "port" in address);

    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(res.status, 200);

    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.server, "hexmem");
  } finally {
    await service.close();
  }
});

test("hexmem http health reports degraded when schema is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hexmem-http-bad-"));
  const path = join(dir, "hexmem.db");
  const service = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: path,
  });

  try {
    const address = service.address();
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(res.status, 503);

    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "degraded");
    assert.equal(body.server, "hexmem");
    assert.match(String(body.error), /identity/);
  } finally {
    await service.close();
  }
});

test("hexmem http mcp routes reject missing sessions", async () => {
  const { db, path } = createTestDb();
  db.close();

  const service = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: path,
  });

  try {
    const address = service.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const getRes = await fetch(`${baseUrl}/mcp`);
    assert.equal(getRes.status, 400);
    assert.deepEqual(await getRes.json(), { error: "No active session" });

    const deleteRes = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    assert.equal(deleteRes.status, 404);
    assert.deepEqual(await deleteRes.json(), { error: "Session not found" });
  } finally {
    await service.close();
  }
});

test("hexmem http mcp post initializes and reuses a session", async () => {
  const { db, path } = createTestDb();
  db.close();

  const service = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: path,
  });

  try {
    const address = service.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    };

    const initializeRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "hexmem-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(initializeRes.status, 200);
    const sessionId = initializeRes.headers.get("mcp-session-id");
    assert.ok(sessionId, "initialize response should include mcp-session-id");
    assert.match(await initializeRes.text(), /protocolVersion/);

    const initializedRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    assert.ok([200, 202].includes(initializedRes.status));

    const toolsRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });
    assert.equal(toolsRes.status, 200);
    assert.match(await toolsRes.text(), /hexmem_recall/);
  } finally {
    await service.close();
  }
});
