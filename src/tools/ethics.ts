import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";

const EthicsInputSchema = {
  scope: z.string().default("").describe("Filter by scope (universal, external, financial, social, axionic)"),
};

const EthicAddInputSchema = {
  principle: z.string().describe("The ethical principle statement"),
  scope: z.string().default("universal").describe("Scope: universal, external, financial, social, axionic"),
  priority: z.number().default(5).describe("Priority 1-10"),
  rationale: z.string().optional().describe("Why this principle matters"),
};

const EthicUpdateInputSchema = {
  ethic_id: z.number().describe("ID of the ethic to update"),
  principle: z.string().optional().describe("New principle text"),
  scope: z.string().optional().describe("New scope"),
  priority: z.number().optional().describe("New priority 1-10"),
  active: z.boolean().nullable().optional().describe("Set active status (null = don't change)"),
  rationale: z.string().optional().describe("New rationale"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_ethics",
    {
      description: "List active ethical principles, optionally filtered by scope",
      inputSchema: EthicsInputSchema,
    },
    async (args) => {
      const result = await ethicsHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_ethic_add",
    {
      description: "Add a new ethical principle",
      inputSchema: EthicAddInputSchema,
    },
    async (args) => {
      const result = await ethicAddHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_ethic_update",
    {
      description: "Update or deactivate an ethical principle",
      inputSchema: EthicUpdateInputSchema,
    },
    async (args) => {
      const result = await ethicUpdateHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function ethicsHandler(
  args: { scope?: string },
  db?: Database.Database
): Promise<string> {
  const { scope = "" } = args;
  const conn = db ?? getDb();

  const params: unknown[] = [1];
  let sql =
    "SELECT id, principle, scope, priority, rationale, created_at " +
    "FROM ethics WHERE active = ?";

  if (scope) {
    sql += " AND scope = ?";
    params.push(scope);
  }

  sql += " ORDER BY priority DESC";

  const rows = conn.prepare(sql).all(...params) as Record<string, unknown>[];
  return JSON.stringify(rows, null, 2);
}

export async function ethicAddHandler(
  args: {
    principle: string;
    scope?: string;
    priority?: number;
    rationale?: string;
  },
  db?: Database.Database
): Promise<string> {
  const { principle, scope = "universal", priority = 5, rationale } = args;
  const conn = db ?? getDb();

  const cur = conn
    .prepare(
      "INSERT INTO ethics (principle, scope, priority, rationale) VALUES (?, ?, ?, ?)"
    )
    .run(principle, scope, priority, rationale ?? null);

  return JSON.stringify({ id: cur.lastInsertRowid, status: "created" });
}

export async function ethicUpdateHandler(
  args: {
    ethic_id: number;
    principle?: string;
    scope?: string;
    priority?: number;
    active?: boolean | null;
    rationale?: string;
  },
  db?: Database.Database
): Promise<string> {
  const { ethic_id } = args;
  const conn = db ?? getDb();

  const sets: string[] = ["reviewed_at = datetime('now')"];
  const params: unknown[] = [];

  if (args.principle !== undefined) {
    sets.push("principle = ?");
    params.push(args.principle);
  }
  if (args.scope !== undefined) {
    sets.push("scope = ?");
    params.push(args.scope);
  }
  if (args.priority !== undefined) {
    sets.push("priority = ?");
    params.push(args.priority);
  }
  if (args.rationale !== undefined) {
    sets.push("rationale = ?");
    params.push(args.rationale);
  }
  if (args.active !== undefined && args.active !== null) {
    sets.push("active = ?");
    params.push(args.active ? 1 : 0);
  }

  params.push(ethic_id);
  conn.prepare(`UPDATE ethics SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return JSON.stringify({ id: ethic_id, status: "updated" });
}
