import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { getDb, getDbForPath } from "./db.js";
import { createServer } from "./server.js";
import { createEmbedder } from "./retrieval/embedder.js";
import { drainEmbeddingQueue } from "./retrieval/queue-worker.js";

const DRAIN_INTERVAL_MS = 5 * 60 * 1000;
const DRAIN_INITIAL_DELAY_MS = 30 * 1000;

/**
 * Background embedding-queue drain. Never blocks server start: the embedder
 * loads lazily, failures log once and back off to the next tick, and both
 * timers are unref'd so they can't hold the process open.
 */
function startEmbeddingDrain(): void {
  if (process.env.HEXMEM_DISABLE_EMBEDDINGS === "1") return;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const embedder = await createEmbedder();
      if (!embedder) return;
      const result = await drainEmbeddingQueue(getDb(), embedder);
      if (result.processed > 0 || result.failed > 0) {
        console.error(
          `hexmem: embedding drain processed=${result.processed} failed=${result.failed} remaining=${result.remaining}`,
        );
      }
    } catch (error) {
      console.error(`hexmem: embedding drain error: ${error}`);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, DRAIN_INITIAL_DELAY_MS).unref();
  setInterval(tick, DRAIN_INTERVAL_MS).unref();
}

export type HexmemHttpServer = {
  address(): AddressInfo;
  close(): Promise<void>;
  raw: Server;
};

export async function startHttpServer(options?: {
  host?: string;
  port?: number;
  dbPath?: string;
}): Promise<HexmemHttpServer> {
  const host = options?.host ?? process.env.HEXMEM_HTTP_HOST ?? "127.0.0.1";
  const port = options?.port ?? Number(process.env.HEXMEM_HTTP_PORT ?? "7543");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Refusing non-loopback HTTP binding without authentication");
  }
  const app = express();
  app.use(express.json());

  // Only the long-lived production server drains the embedding queue;
  // per-test servers pass an explicit dbPath and skip it.
  if (!options?.dbPath) startEmbeddingDrain();

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, transport); },
        onsessionclosed: (id) => { transports.delete(id); },
      });
      const server = createServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "No active session" });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      transports.delete(sessionId);
      return;
    }
    res.status(404).json({ error: "Session not found" });
  });

  app.get("/health", (_req, res) => {
    try {
      if (options?.dbPath) {
        const db = getDbForPath(options.dbPath);
        try {
          db.prepare("SELECT value FROM identity LIMIT 1").get();
        } finally {
          db.close();
        }
      } else {
        const db = getDb();
        db.prepare("SELECT value FROM identity LIMIT 1").get();
      }

      res.status(200).json({ status: "ok", server: "hexmem" });
    } catch (error) {
      res.status(503).json({
        status: "degraded",
        server: "hexmem",
        error: String(error),
      });
    }
  });

  return new Promise((resolve) => {
    const raw = app.listen(port, host, () => {
      resolve({
        raw,
        address(): AddressInfo {
          const address = raw.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected TCP listener address");
          }
          return address;
        },
        close(): Promise<void> {
          return new Promise((resolveClose, rejectClose) => {
            raw.close((error) => {
              if (error) {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
          });
        },
      });
    });
  });
}
