import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { compress } from "../compress.js";
import { findNearDuplicate, isOverLong } from "../quality.js";

const LessonAddInputSchema = {
  domain: z.string().describe("Knowledge domain"),
  lesson: z.string().describe("The lesson learned"),
  context: z.string().default("").describe("Context in which lesson was learned"),
  confidence: z.number().default(0.8).describe("Confidence 0.0-1.0"),
  source_event_id: z.number().optional().describe("ID of the source event"),
  prompt_form: z.string().default("").describe("Compressed prompt form (auto-generated if empty)"),
  sensitivity: z.string().default("").describe("'public' or 'private' (auto-resolved from domain if empty)"),
  allow_duplicate: z.boolean().default(false).describe("Bypass near-duplicate rejection"),
  allow_long: z.boolean().default(false).describe("Bypass length rejection"),
};

const LessonsInputSchema = {
  domain: z.string().default("").describe("Filter by domain"),
  limit: z.number().default(20).describe("Max results"),
  max_sensitivity: z.string().default("private").describe("Max sensitivity level (public/private)"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_lessons",
    {
      description: "Query lessons, optionally filtered by domain",
      inputSchema: LessonsInputSchema,
    },
    async (args) => {
      const result = await lessonsHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_lesson_add",
    {
      description: "Record a lesson learned",
      inputSchema: LessonAddInputSchema,
    },
    async (args) => {
      const result = await lessonAddHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function lessonsHandler(
  args: {
    domain?: string;
    limit?: number;
    max_sensitivity?: string;
  },
  db?: Database.Database
): Promise<string> {
  const { domain = "", limit = 20, max_sensitivity = "private" } = args;

  if (max_sensitivity !== "public" && max_sensitivity !== "private") {
    return JSON.stringify({
      error: `Invalid max_sensitivity: ${max_sensitivity}. Must be 'public' or 'private'`,
    });
  }

  const conn = db ?? getDb();

  const conditions: string[] = [
    "(valid_until IS NULL OR valid_until > datetime('now'))",
    "superseded_by IS NULL",
  ];
  const params: unknown[] = [];

  if (domain) {
    conditions.push("domain = ?");
    params.push(domain);
  }

  if (max_sensitivity === "public") {
    conditions.push("sensitivity = 'public'");
  }

  const where = "WHERE " + conditions.join(" AND ");

  const sql = `
    SELECT id, domain, lesson, context, confidence, times_applied,
           times_validated, times_contradicted, prompt_form, sensitivity
    FROM lessons ${where}
    ORDER BY confidence DESC LIMIT ?
  `;
  params.push(limit);

  const rows = conn.prepare(sql).all(...params) as Record<string, unknown>[];

  if (rows.length > 0) {
    const ids = rows.map((r) => r["id"]);
    const ph = ids.map(() => "?").join(",");
    conn.prepare(
      `UPDATE lessons SET
         access_count = COALESCE(access_count, 0) + 1,
         last_accessed_at = datetime('now'),
         consolidation_state = CASE
           WHEN consolidation_state IN ('fading','compressed','forgotten')
           THEN 'active' ELSE consolidation_state END
       WHERE id IN (${ph})`
    ).run(...ids);
  }

  return JSON.stringify(rows, null, 2);
}

export async function lessonAddHandler(
  args: {
    domain: string;
    lesson: string;
    context?: string;
    confidence?: number;
    source_event_id?: number;
    prompt_form?: string;
    sensitivity?: string;
    allow_duplicate?: boolean;
    allow_long?: boolean;
  },
  db?: Database.Database
): Promise<string> {
  const {
    domain,
    lesson,
    context = "",
    confidence = 0.8,
    source_event_id,
  } = args;
  let promptForm = args.prompt_form ?? "";
  let sensitivity = args.sensitivity ?? "";

  const conn = db ?? getDb();

  if (!args.allow_long && isOverLong("lessons", `${lesson} ${context}`)) {
    return JSON.stringify({
      status: "rejected",
      reason: "too_long",
      hint: "Tighten the lesson; long narratives belong in event details (allow_long to override)",
    });
  }

  if (!args.allow_duplicate) {
    const dup = findNearDuplicate(conn, "lessons", lesson);
    if (dup) {
      return JSON.stringify({ status: "duplicate", ref: dup.ref, id: dup.id });
    }
  }

  if (!promptForm) {
    let raw = `${domain}|${lesson}`;
    if (context) raw += `|${context}`;
    promptForm = compress(raw);
  }

  // Resolve sensitivity: explicit > domain default > "private"
  if (!sensitivity) {
    const row = conn
      .prepare(
        "SELECT sensitivity FROM domain_sensitivity WHERE domain = ? AND subject = '' LIMIT 1"
      )
      .get(domain) as { sensitivity: string } | undefined;
    sensitivity = row ? row.sensitivity : "private";
  }

  if (sensitivity !== "public" && sensitivity !== "private") {
    return JSON.stringify({
      error: `Invalid sensitivity: ${sensitivity}. Must be 'public' or 'private'`,
    });
  }

  const cur = conn
    .prepare(
      "INSERT INTO lessons (domain, lesson, context, confidence, " +
        "source_event_id, prompt_form, sensitivity) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      domain,
      lesson,
      context || null,
      confidence,
      source_event_id ?? null,
      promptForm,
      sensitivity
    );

  const newId = cur.lastInsertRowid as number;

  // FTS sync handled by lessons_ai trigger

  return JSON.stringify({ id: newId, status: "recorded" });
}
