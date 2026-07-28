import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";

const DailyLogInputSchema = {
  action: z.string().describe("Action: add, today, recent"),
  kind: z.string().optional().describe("Entry kind: heartbeat, incident, decision, reflection, milestone, note"),
  summary: z.string().optional().describe("Log entry summary"),
  details: z.string().optional().describe("Additional details"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_daily_log",
    {
      description: "Add or query daily log entries (heartbeats, incidents, decisions, reflections, milestones)",
      inputSchema: DailyLogInputSchema,
    },
    async (args) => {
      const result = await dailyLogHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function dailyLogHandler(
  args: {
    action: string;
    kind?: string;
    summary?: string;
    details?: string;
  },
  db?: Database.Database
): Promise<string> {
  const { action } = args;
  const conn = db ?? getDb();

  if (action === "add") {
    const cur = conn
      .prepare(
        "INSERT INTO daily_logs (day, kind, summary, details) " +
          "VALUES (date('now'), ?, ?, ?)"
      )
      .run(args.kind ?? "note", args.summary ?? "", args.details ?? "");
    return JSON.stringify({ id: cur.lastInsertRowid, status: "created" });
  }

  if (action === "today") {
    const rows = conn
      .prepare(
        "SELECT id, day, kind, summary, details, ts " +
          "FROM daily_logs WHERE day = date('now') ORDER BY ts ASC"
      )
      .all() as Record<string, unknown>[];
    return JSON.stringify(rows, null, 2);
  }

  if (action === "recent") {
    const rows = conn
      .prepare(
        "SELECT id, day, kind, summary, details, ts " +
          "FROM daily_logs WHERE day >= date('now', '-7 days') ORDER BY ts DESC"
      )
      .all() as Record<string, unknown>[];
    return JSON.stringify(rows, null, 2);
  }

  return JSON.stringify({ error: `Unknown action: ${action}` });
}
