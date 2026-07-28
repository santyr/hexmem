import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { computePrimingRecommendations } from "../learning/auto-primer.js";

const PrimeInputSchema = {
  item_type: z.string().describe("Type: entity, concept, schema, emotion, theme"),
  item_name: z.string().describe("Name of the item to prime"),
  source: z.string().describe("What triggered this priming"),
  ttl_minutes: z.number().default(60).describe("Time-to-live in minutes"),
};

const PrimingStateInputSchema = {};

const AutoPrimeInputSchema = {
  cwd: z.string().default("").describe("Current working directory for domain detection"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_prime",
    {
      description: "Prime (activate) a concept, entity, schema, emotion, or theme in working memory",
      inputSchema: PrimeInputSchema,
    },
    async (args) => {
      const result = await primeHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_priming_state",
    {
      description: "List currently active priming entries (expired entries are deleted first)",
      inputSchema: PrimingStateInputSchema,
    },
    async (_args) => {
      const result = await primingStateHandler({});
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_auto_prime",
    {
      description: "Automatically prime relevant context based on cwd, active tasks, observations, and degraded lessons",
      inputSchema: AutoPrimeInputSchema,
    },
    async (args) => {
      const result = await autoPrimeHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function primeHandler(
  args: {
    item_type: string;
    item_name: string;
    source: string;
    ttl_minutes?: number;
  },
  db?: Database.Database
): Promise<string> {
  const { item_type, item_name, source, ttl_minutes = 60 } = args;
  const conn = db ?? getDb();

  const cur = conn
    .prepare(
      "INSERT INTO priming_state (item_type, item_name, source, expires_at) " +
        `VALUES (?, ?, ?, datetime('now', '+${Math.floor(ttl_minutes)} minutes'))`
    )
    .run(item_type, item_name, source);

  return JSON.stringify({ id: cur.lastInsertRowid, status: "primed" });
}

export async function primingStateHandler(
  _args: Record<string, never>,
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();

  // Delete expired entries
  conn.prepare("DELETE FROM priming_state WHERE expires_at < datetime('now')").run();

  // Decay activation level based on time since activation (10% per day)
  conn.prepare(`
    UPDATE priming_state
    SET activation_level = activation_level * MAX(0, 1.0 - 0.1 * (JULIANDAY('now') - JULIANDAY(activated_at)))
    WHERE expires_at > datetime('now')
  `).run();

  // Clean up entries that decayed below threshold
  conn.prepare("DELETE FROM priming_state WHERE activation_level <= 0.1").run();

  const rows = conn
    .prepare(
      "SELECT id, item_type, item_name, activation_level, activated_at, source, expires_at " +
        "FROM priming_state ORDER BY activation_level DESC"
    )
    .all() as Record<string, unknown>[];

  return JSON.stringify(rows, null, 2);
}

export async function autoPrimeHandler(
  args: { cwd?: string },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  const cwd = args.cwd ?? "";

  const recommendations = computePrimingRecommendations(conn, cwd);

  let applied = 0;
  for (const rec of recommendations) {
    conn
      .prepare(
        `INSERT INTO priming_state (item_type, item_name, source, activation_level, expires_at)
         VALUES (?, ?, ?, ?, datetime('now', '+${Math.floor(rec.ttl_minutes)} minutes'))`
      )
      .run(rec.item_type, rec.item_name, rec.source, rec.activation_level);
    applied++;
  }

  return JSON.stringify({
    status: "auto-primed",
    applied,
    domains: recommendations.map((r) => r.item_name),
  });
}
