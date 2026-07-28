import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { hybridSearch } from "../retrieval/hybrid.js";
import { createEmbedder } from "../retrieval/embedder.js";
import { budgetItems, compactItem, resultToGatewayItem } from "./gateway.js";
import { reinforceRefs } from "../lifecycle/reinforce.js";
import type { Sensitivity } from "../types.js";

const SearchInputSchema = {
  query: z.string().describe("Search query (keywords or phrase)"),
  limit: z.number().default(20).describe("Max results"),
  budget_tokens: z.number().default(500).describe("Approximate token budget for returned items"),
  max_sensitivity: z
    .string()
    .default("private")
    .describe("Max sensitivity level (public/private)"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_search",
    {
      description:
        "Ranked full-text search across facts, events, lessons, and memory seeds. " +
        "Multi-term queries try AND first, then fall back to OR. " +
        "Use max_sensitivity='public' to exclude private data.",
      inputSchema: SearchInputSchema,
    },
    async (args) => {
      const result = await searchHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
}

export async function searchHandler(
  args: {
    query: string;
    limit?: number;
    budget_tokens?: number;
    max_sensitivity?: string;
  },
  db?: Database.Database,
): Promise<string> {
  const { query, limit = 20, max_sensitivity = "private" } = args;

  if (max_sensitivity !== "public" && max_sensitivity !== "private") {
    return JSON.stringify({
      error: `Invalid max_sensitivity: ${max_sensitivity}. Must be 'public' or 'private'`,
    });
  }

  const budget = Math.max(16, Math.floor(args.budget_tokens ?? 500));

  if (!query || !query.trim()) {
    return JSON.stringify({ status: "ok", query: query ?? "", item_tokens: 0, truncated: false, items: [] });
  }

  const conn = db ?? getDb();
  const embedder = await createEmbedder();
  const sensitivity = max_sensitivity as Sensitivity;

  const results = await hybridSearch(conn, query, limit, sensitivity, embedder);

  const items = results.map((result) => {
    const item = compactItem(resultToGatewayItem(result), false);
    return { ...item, score: round(result.score ?? 0) };
  });
  const compacted = budgetItems(items, budget);

  // Access-based strength only works if retrieval reinforces what it returns
  reinforceRefs(conn, compacted.items.map((item) => String(item.ref)));

  return JSON.stringify({
    status: "ok",
    query,
    item_tokens: compacted.item_tokens,
    truncated: compacted.truncated,
    items: compacted.items,
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
