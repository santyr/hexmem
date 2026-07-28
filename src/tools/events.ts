import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { compress } from "../compress.js";
import { findNearDuplicate, isOverLong } from "../quality.js";

const EventAddInputSchema = {
  event_type: z.string().describe("Type of event"),
  summary: z.string().describe("Brief summary of the event"),
  category: z.string().default("").describe("Event category (used for sensitivity lookup)"),
  details: z.string().default("").describe("Full event details"),
  significance: z.number().default(5).describe("Significance 0-10"),
  emotional_valence: z.number().default(0.0).describe("Emotional valence -1.0 to 1.0"),
  emotional_arousal: z.number().default(0.3).describe("Emotional arousal 0.0 to 1.0"),
  prompt_form: z.string().default("").describe("Compressed prompt form (auto-generated if empty)"),
  sensitivity: z.string().default("").describe("'public' or 'private' (auto-resolved from category if empty)"),
  allow_duplicate: z.boolean().default(false).describe("Bypass 48h same-summary rejection"),
  allow_long: z.boolean().default(false).describe("Bypass length rejection"),
};

const EventsInputSchema = {
  event_type: z.string().default("").describe("Filter by event type"),
  category: z.string().default("").describe("Filter by category"),
  min_significance: z.number().default(0).describe("Minimum significance (0-10)"),
  limit: z.number().default(10).describe("Max results"),
  max_sensitivity: z.string().default("private").describe("Max sensitivity level (public/private)"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_events",
    {
      description: "Query events by type, category, or minimum significance",
      inputSchema: EventsInputSchema,
    },
    async (args) => {
      const result = await eventsHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_event_add",
    {
      description: "Log an event with significance and optional emotional tags",
      inputSchema: EventAddInputSchema,
    },
    async (args) => {
      const result = await eventAddHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function eventsHandler(
  args: {
    event_type?: string;
    category?: string;
    min_significance?: number;
    limit?: number;
    max_sensitivity?: string;
  },
  db?: Database.Database
): Promise<string> {
  const {
    event_type = "",
    category = "",
    min_significance = 0,
    limit = 10,
    max_sensitivity = "private",
  } = args;

  if (max_sensitivity !== "public" && max_sensitivity !== "private") {
    return JSON.stringify({
      error: `Invalid max_sensitivity: ${max_sensitivity}. Must be 'public' or 'private'`,
    });
  }

  const conn = db ?? getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (event_type) {
    conditions.push("event_type = ?");
    params.push(event_type);
  }

  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  if (min_significance > 0) {
    conditions.push("significance >= ?");
    params.push(min_significance);
  }

  if (max_sensitivity === "public") {
    conditions.push("sensitivity = 'public'");
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const sql = `
    SELECT id, occurred_at, event_type, category, summary,
           significance, prompt_form, sensitivity
    FROM events ${where}
    ORDER BY occurred_at DESC LIMIT ?
  `;
  params.push(limit);

  const rows = conn.prepare(sql).all(...params) as Record<string, unknown>[];

  if (rows.length > 0) {
    const ids = rows.map((r) => r["id"]);
    const ph = ids.map(() => "?").join(",");
    // Only set last_accessed_at — the update_retention_on_access trigger
    // handles access_count and memory_strength boost
    conn.prepare(
      `UPDATE events SET
         last_accessed_at = datetime('now'),
         consolidation_state = CASE
           WHEN consolidation_state IN ('fading','compressed','forgotten')
           THEN 'active' ELSE consolidation_state END
       WHERE id IN (${ph})`
    ).run(...ids);
  }

  return JSON.stringify(rows, null, 2);
}

export async function eventAddHandler(
  args: {
    event_type: string;
    summary: string;
    category?: string;
    details?: string;
    significance?: number;
    emotional_valence?: number;
    emotional_arousal?: number;
    prompt_form?: string;
    sensitivity?: string;
    allow_duplicate?: boolean;
    allow_long?: boolean;
  },
  db?: Database.Database
): Promise<string> {
  const {
    event_type,
    summary,
    category = "",
    details = "",
    significance = 5,
    emotional_valence = 0.0,
    emotional_arousal = 0.3,
  } = args;
  let promptForm = args.prompt_form ?? "";
  let sensitivity = args.sensitivity ?? "";

  const conn = db ?? getDb();

  if (!args.allow_long && isOverLong("events", `${summary} ${details}`)) {
    return JSON.stringify({
      status: "rejected",
      reason: "too_long",
      hint: "Events are episodic markers — split the narrative into a lesson or trim details (allow_long to override)",
    });
  }

  if (!args.allow_duplicate) {
    const dup = findNearDuplicate(conn, "events", summary);
    if (dup) {
      return JSON.stringify({ status: "duplicate", ref: dup.ref, id: dup.id });
    }
  }

  if (!promptForm) {
    let raw = `${event_type}|${category}|${summary}`;
    if (significance >= 7) raw += `|sig:${significance}`;
    promptForm = compress(raw);
  }

  // Resolve sensitivity: explicit > domain default (using category) > "private"
  if (!sensitivity) {
    const row = conn
      .prepare(
        "SELECT sensitivity FROM domain_sensitivity WHERE domain = ? AND subject = '' LIMIT 1"
      )
      .get(category) as { sensitivity: string } | undefined;
    sensitivity = row ? row.sensitivity : "private";
  }

  if (sensitivity !== "public" && sensitivity !== "private") {
    return JSON.stringify({
      error: `Invalid sensitivity: ${sensitivity}. Must be 'public' or 'private'`,
    });
  }

  const cur = conn
    .prepare(
      "INSERT INTO events (event_type, category, summary, details, " +
        "significance, emotional_valence, emotional_arousal, prompt_form, sensitivity) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      event_type,
      category || null,
      summary,
      details || null,
      significance,
      emotional_valence,
      emotional_arousal,
      promptForm,
      sensitivity
    );

  const newId = cur.lastInsertRowid as number;

  // FTS sync handled by events_ai trigger

  return JSON.stringify({ id: newId, status: "logged" });
}
