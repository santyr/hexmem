import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { compress } from "../compress.js";
import { findNearDuplicate, hasDanglingReferent, isOverLong } from "../quality.js";

const FactAddInputSchema = {
  predicate: z.string().describe("The predicate (relationship) of the fact"),
  subject_text: z.string().default("").describe("Subject as free text"),
  subject_entity_id: z.number().optional().describe("Subject entity ID"),
  object_text: z.string().default("").describe("Object as free text"),
  object_entity_id: z.number().optional().describe("Object entity ID"),
  domain: z.string().default("").describe("Knowledge domain"),
  confidence: z.number().default(1.0).describe("Confidence 0.0-1.0"),
  source: z.string().default("").describe("Source of the fact"),
  prompt_form: z.string().default("").describe("Compressed prompt form (auto-generated if empty)"),
  sensitivity: z.string().default("").describe("'public' or 'private' (auto-resolved from domain if empty)"),
  emotional_valence: z.number().default(0.0).describe("Emotional valence -1.0 to 1.0"),
  emotional_arousal: z.number().default(0.0).describe("Emotional arousal 0.0 to 1.0"),
  allow_duplicate: z.boolean().default(false).describe("Bypass near-duplicate rejection"),
  allow_unresolved: z.boolean().default(false).describe("Bypass dangling-referent rejection"),
  allow_long: z.boolean().default(false).describe("Bypass length rejection"),
};

const FactSupersedeInputSchema = {
  old_fact_id: z.number().describe("ID of the fact to supersede"),
  new_predicate: z.string().default("").describe("New predicate (carries forward if empty)"),
  new_object_text: z.string().default("").describe("New object text (carries forward if empty)"),
  new_domain: z.string().default("").describe("New domain (carries forward if empty)"),
  new_confidence: z.number().default(1.0).describe("New confidence value"),
  reason: z.string().default("").describe("Reason for superseding"),
  prompt_form: z.string().default("").describe("Compressed prompt form (auto-generated if empty)"),
};

const FactsInputSchema = {
  domain: z.string().default("").describe("Filter by domain"),
  entity: z.string().default("").describe("Filter by entity name"),
  tier: z.string().default("").describe("Filter by decay tier (hot/warm/cold)"),
  limit: z.number().default(20).describe("Max results"),
  max_sensitivity: z.string().default("private").describe("Max sensitivity level (public/private)"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_facts",
    {
      description: "Query facts by domain, entity name, or decay tier (hot/warm/cold)",
      inputSchema: FactsInputSchema,
    },
    async (args) => {
      const result = await factsHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_fact_add",
    {
      description: "Add a new fact (subject-predicate-object triple)",
      inputSchema: FactAddInputSchema,
    },
    async (args) => {
      const result = await factAddHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_fact_supersede",
    {
      description: "Supersede an existing fact with a new version. Old fact is never deleted.",
      inputSchema: FactSupersedeInputSchema,
    },
    async (args) => {
      const result = await factSupersedeHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function factsHandler(
  args: {
    domain?: string;
    entity?: string;
    tier?: string;
    limit?: number;
    max_sensitivity?: string;
  },
  db?: Database.Database
): Promise<string> {
  const { domain = "", entity = "", tier = "", limit = 20, max_sensitivity = "private" } = args;

  if (max_sensitivity !== "public" && max_sensitivity !== "private") {
    return JSON.stringify({
      error: `Invalid max_sensitivity: ${max_sensitivity}. Must be 'public' or 'private'`,
    });
  }

  const conn = db ?? getDb();

  const conditions: string[] = ["f.status = 'active'"];
  const params: unknown[] = [];

  if (domain) {
    conditions.push("f.domain = ?");
    params.push(domain);
  }

  if (entity) {
    conditions.push(
      "(f.subject_text LIKE ? OR f.object_text LIKE ? OR e.name LIKE ? OR e.canonical_name LIKE ?)"
    );
    const pat = `%${entity}%`;
    params.push(pat, pat, pat, pat);
  }

  if (tier === "hot") {
    conditions.push("JULIANDAY('now') - JULIANDAY(f.last_accessed_at) <= 7");
  } else if (tier === "warm") {
    conditions.push("JULIANDAY('now') - JULIANDAY(f.last_accessed_at) BETWEEN 7 AND 30");
  } else if (tier === "cold") {
    conditions.push("(f.last_accessed_at IS NULL OR JULIANDAY('now') - JULIANDAY(f.last_accessed_at) > 30)");
  }

  if (max_sensitivity === "public") {
    conditions.push("f.sensitivity = 'public'");
  }

  const where = conditions.join(" AND ");
  const sql = `
    SELECT f.id, f.subject_text, f.predicate, f.object_text,
           f.confidence, f.domain, f.access_count, f.last_accessed_at,
           f.prompt_form, f.sensitivity, e.name AS subject_name
    FROM facts f LEFT JOIN entities e ON f.subject_entity_id = e.id
    WHERE ${where}
    ORDER BY f.access_count DESC LIMIT ?
  `;
  params.push(limit);

  const rows = conn.prepare(sql).all(...params) as Record<string, unknown>[];

  if (rows.length > 0) {
    const ids = rows.map((r) => r["id"]);
    const ph = ids.map(() => "?").join(",");
    // Increment access_count — the facts_access_tracking trigger
    // handles last_accessed_at and memory_strength boost
    conn.prepare(
      `UPDATE facts SET
         access_count = COALESCE(access_count, 0) + 1,
         consolidation_state = CASE
           WHEN consolidation_state IN ('fading','compressed','forgotten')
           THEN 'active' ELSE consolidation_state END
       WHERE id IN (${ph})`
    ).run(...ids);
  }

  return JSON.stringify(rows, null, 2);
}

function resolveSensitivity(
  conn: Database.Database,
  domain: string,
  subjectText: string,
  explicitSensitivity: string
): string {
  if (explicitSensitivity) return explicitSensitivity;
  const row = conn
    .prepare(
      "SELECT sensitivity FROM domain_sensitivity " +
        "WHERE domain = ? AND (subject = ? OR subject = '') " +
        "ORDER BY CASE WHEN subject = ? THEN 0 ELSE 1 END LIMIT 1"
    )
    .get(domain, subjectText || "", subjectText || "") as
    | { sensitivity: string }
    | undefined;
  return row ? row.sensitivity : "private";
}

export async function factAddHandler(
  args: {
    predicate: string;
    subject_text?: string;
    subject_entity_id?: number;
    object_text?: string;
    object_entity_id?: number;
    domain?: string;
    confidence?: number;
    source?: string;
    prompt_form?: string;
    sensitivity?: string;
    emotional_valence?: number;
    emotional_arousal?: number;
    allow_duplicate?: boolean;
    allow_unresolved?: boolean;
    allow_long?: boolean;
  },
  db?: Database.Database
): Promise<string> {
  const {
    predicate,
    subject_text = "",
    subject_entity_id,
    object_text = "",
    object_entity_id,
    domain = "",
    confidence = 1.0,
    source = "",
    emotional_valence = 0.0,
    emotional_arousal = 0.0,
  } = args;

  let promptForm = args.prompt_form ?? "";
  let sensitivity = args.sensitivity ?? "";

  const conn = db ?? getDb();

  // Write-time quality gates (audit 2026-07-11): a fact must survive on its
  // own once the conversation that produced it is gone.
  if (!args.allow_unresolved && !subject_entity_id && hasDanglingReferent(subject_text)) {
    return JSON.stringify({
      status: "rejected",
      reason: "dangling_referent",
      hint: `Subject "${subject_text}" won't be resolvable later — name the concrete entity`,
    });
  }

  const factText = `${subject_text} ${predicate} ${object_text}`;
  if (!args.allow_long && isOverLong("facts", factText)) {
    return JSON.stringify({
      status: "rejected",
      reason: "too_long",
      hint: "Split into multiple facts or move the narrative into a lesson (allow_long to override)",
    });
  }

  if (!args.allow_duplicate) {
    const dup = findNearDuplicate(conn, "facts", factText);
    if (dup) {
      return JSON.stringify({ status: "duplicate", ref: dup.ref, id: dup.id });
    }
  }

  if (!promptForm) {
    let raw = `${subject_text}|${predicate}|${object_text}`;
    if (domain) raw += `|d:${domain}`;
    raw += `|c:${confidence}`;
    promptForm = compress(raw);
  }

  sensitivity = resolveSensitivity(conn, domain, subject_text, sensitivity);

  if (sensitivity !== "public" && sensitivity !== "private") {
    return JSON.stringify({
      error: `Invalid sensitivity: ${sensitivity}. Must be 'public' or 'private'`,
    });
  }

  const cur = conn
    .prepare(
      "INSERT INTO facts (subject_entity_id, subject_text, predicate, " +
        "object_entity_id, object_text, domain, confidence, source, " +
        "emotional_valence, emotional_arousal, prompt_form, sensitivity) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      subject_entity_id ?? null,
      subject_text || null,
      predicate,
      object_entity_id ?? null,
      object_text || null,
      domain || null,
      confidence,
      source || null,
      emotional_valence,
      emotional_arousal,
      promptForm,
      sensitivity
    );

  const newId = cur.lastInsertRowid as number;

  // FTS sync handled by facts_ai trigger

  return JSON.stringify({ id: newId, status: "created" });
}

export async function factSupersedeHandler(
  args: {
    old_fact_id: number;
    new_predicate?: string;
    new_object_text?: string;
    new_domain?: string;
    new_confidence?: number;
    reason?: string;
    prompt_form?: string;
  },
  db?: Database.Database
): Promise<string> {
  const {
    old_fact_id,
    new_predicate = "",
    new_object_text = "",
    new_domain = "",
    new_confidence = 1.0,
    reason = "",
  } = args;
  let promptForm = args.prompt_form ?? "";

  const conn = db ?? getDb();

  const old = conn
    .prepare("SELECT * FROM facts WHERE id = ?")
    .get(old_fact_id) as Record<string, unknown> | undefined;

  if (!old) {
    return JSON.stringify({ error: `Fact ${old_fact_id} not found` });
  }

  const predicate = new_predicate || (old["predicate"] as string);
  const objectText = new_object_text || ((old["object_text"] as string | null) ?? "");
  const domain = new_domain || ((old["domain"] as string | null) ?? "");

  if (!promptForm) {
    let raw = `${(old["subject_text"] as string | null) ?? ""}|${predicate}|${objectText}`;
    if (domain) raw += `|d:${domain}`;
    raw += `|c:${new_confidence}`;
    promptForm = compress(raw);
  }

  const cur = conn
    .prepare(
      "INSERT INTO facts (subject_entity_id, subject_text, predicate, " +
        "object_entity_id, object_text, domain, confidence, source, " +
        "emotional_valence, emotional_arousal, prompt_form, sensitivity) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      (old["subject_entity_id"] as number | null) ?? null,
      (old["subject_text"] as string | null) ?? null,
      predicate,
      (old["object_entity_id"] as number | null) ?? null,
      objectText || null,
      domain || null,
      new_confidence,
      reason || (old["source"] as string | null) || null,
      (old["emotional_valence"] as number) ?? 0,
      (old["emotional_arousal"] as number) ?? 0.3,
      promptForm,
      old["sensitivity"] as string
    );

  const newId = cur.lastInsertRowid as number;

  conn
    .prepare(
      "UPDATE facts SET status = 'superseded', superseded_by = ?, " +
        "updated_at = datetime('now') WHERE id = ?"
    )
    .run(newId, old_fact_id);

  // FTS sync handled by facts_ai trigger

  return JSON.stringify({ old_id: old_fact_id, new_id: newId, status: "superseded" });
}
