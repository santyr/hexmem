import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { decaySweep, memoryHealth } from "../lifecycle/decay.js";
import { consolidate } from "../lifecycle/consolidate.js";
import { staleSweep, wakeDigest } from "../lifecycle/stale.js";
import { posteriorDecay } from "../learning/bayesian.js";

const DecaySweepInputSchema = {
  dry_run: z.boolean().default(true).describe("If true, calculate transitions but do not apply them"),
};

const ConsolidateInputSchema = {
  domain: z.string().default("").describe("Domain to consolidate (empty = all domains)"),
  dry_run: z.boolean().default(true).describe("If true, preview groups without creating seeds"),
  min_group_size: z.number().default(3).describe("Minimum number of items required to form a seed"),
};

const MemoryHealthInputSchema = {};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_decay_sweep",
    {
      description:
        "Apply Ebbinghaus forgetting curve to all memories. Transitions active→fading→compressed→forgotten based on time and memory strength. High-salience memories are protected.",
      inputSchema: DecaySweepInputSchema,
    },
    async (args) => {
      const result = await decaySweepHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_consolidate",
    {
      description:
        "Compress fading/compressed memories in a domain into holographic seeds. Groups by domain and 30-day windows.",
      inputSchema: ConsolidateInputSchema,
    },
    async (args) => {
      const result = await consolidateHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_posterior_decay",
    {
      description: "Apply temporal decay to lesson posteriors (monthly maintenance)",
      inputSchema: {
        dry_run: z.boolean().default(true).describe("Preview without applying"),
        decay_factor: z.number().default(0.95).describe("Multiply alpha/beta by this factor (0-1)"),
      },
    },
    async (args) => {
      const db = getDb();
      const result = posteriorDecay(db, args.decay_factor ?? 0.95, args.dry_run ?? true);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "hexmem_stale_sweep",
    {
      description:
        "Find contradiction groups — multiple active facts sharing a subject+predicate — and supersede all but the newest. Default dry_run previews; dry_run=false applies.",
      inputSchema: {
        dry_run: z.boolean().default(true).describe("Preview groups without superseding"),
      },
    },
    async (args) => {
      const result = await staleSweepHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_wake_digest",
    {
      description:
        "Session-start micro-review: the most valuable fading or review-overdue memories. Confirm with hexmem_feedback rating=helpful, retire with rating=stale or hexmem_fact_supersede.",
      inputSchema: {
        limit: z.number().default(5).describe("Max digest items"),
      },
    },
    async (args) => {
      const result = await wakeDigestHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_memory_health",
    {
      description:
        "Return per-table breakdown of memory states, overdue review counts, and average strength.",
      inputSchema: MemoryHealthInputSchema,
    },
    async () => {
      const result = await memoryHealthHandler();
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function decaySweepHandler(
  args: { dry_run?: boolean },
  db?: Database.Database
): Promise<string> {
  const { dry_run = true } = args;
  const conn = db ?? getDb();
  const result = decaySweep(conn, dry_run);
  return JSON.stringify(result, null, 2);
}

export async function consolidateHandler(
  args: {
    domain?: string;
    dry_run?: boolean;
    min_group_size?: number;
  },
  db?: Database.Database
): Promise<string> {
  const { domain = "", dry_run = true, min_group_size = 3 } = args;
  const conn = db ?? getDb();
  return consolidate(conn, domain, dry_run, min_group_size);
}

export async function memoryHealthHandler(db?: Database.Database): Promise<string> {
  const conn = db ?? getDb();
  return memoryHealth(conn);
}

export async function staleSweepHandler(
  args: { dry_run?: boolean },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  return JSON.stringify(staleSweep(conn, { dryRun: args.dry_run ?? true }), null, 2);
}

export async function wakeDigestHandler(
  args: { limit?: number },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  return JSON.stringify({ status: "ok", items: wakeDigest(conn, args.limit ?? 5) }, null, 2);
}
