import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { review, reviewDue } from "../lifecycle/review.js";

const ReviewInputSchema = {
  table: z.string().describe("Table to review: 'facts', 'events', or 'lessons'"),
  id: z.number().describe("ID of the item to review"),
  quality: z.number().describe("Recall quality 0-5 (0=blackout, 5=perfect)"),
};

const ReviewDueInputSchema = {
  limit: z.number().default(20).describe("Max number of due items to return"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_review",
    {
      description:
        "Review a memory item using SM-2 spaced repetition. Updates memory strength, repetition count, and schedules next review.",
      inputSchema: ReviewInputSchema,
    },
    async (args) => {
      const result = await reviewHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_review_due",
    {
      description:
        "Return items from facts, events, and lessons that are due for review (next_review_at <= now).",
      inputSchema: ReviewDueInputSchema,
    },
    async (args) => {
      const result = await reviewDueHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function reviewHandler(
  args: { table: string; id: number; quality: number },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  return review(conn, args.table, args.id, args.quality);
}

export async function reviewDueHandler(
  args: { limit?: number },
  db?: Database.Database
): Promise<string> {
  const { limit = 20 } = args;
  const conn = db ?? getDb();
  return reviewDue(conn, limit);
}
