import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { updatePosterior, getAsymmetricWeight } from "../learning/bayesian.js";

const ObservationAddSchema = {
  category: z
    .enum(["advisory", "tool_selection", "session", "architecture", "debugging", "routing"])
    .describe("Observation category"),
  action_type: z.string().describe("Type of action observed"),
  action_summary: z.string().describe("Summary of the action taken"),
  context: z.string().optional().describe("Additional context"),
  lesson_id: z
    .number()
    .optional()
    .describe("ID of linked lesson for Bayesian update"),
  outcome: z
    .enum(["adopted", "ignored", "corrected", "success", "failure", "partial"])
    .optional()
    .describe("Outcome if already known (pre-resolved)"),
  outcome_details: z.string().optional().describe("Details about the outcome"),
  outcome_source: z
    .enum(["explicit", "implicit", "review"])
    .describe("Source of the outcome determination"),
  outcome_weight: z
    .number()
    .default(1.0)
    .describe("Weight to apply to Bayesian update (default 1.0)"),
  session_id: z.string().optional().describe("Session identifier"),
};

const ObservationResolveSchema = {
  observation_id: z.number().describe("ID of the pending observation to resolve"),
  outcome: z
    .enum(["adopted", "ignored", "corrected", "success", "failure", "partial"])
    .describe("Outcome of the observation"),
  outcome_details: z.string().optional().describe("Details about the outcome"),
  outcome_weight: z
    .number()
    .default(1.0)
    .describe("Weight to apply to Bayesian update (default 1.0)"),
};

const ObservationLinkSchema = {
  observation_id: z.number().describe("ID of the resolved observation to link"),
  lesson_id: z.number().describe("ID of the lesson to link and trigger Bayesian update"),
};

const ObservationsQuerySchema = {
  category: z
    .enum(["advisory", "tool_selection", "session", "architecture", "debugging", "routing"])
    .optional()
    .describe("Filter by category"),
  lesson_id: z
    .number()
    .optional()
    .describe("Filter by linked lesson ID"),
  pending_only: z
    .boolean()
    .default(false)
    .describe("Return only unresolved observations"),
  limit: z.number().default(50).describe("Max results"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_observation_add",
    {
      description: "Record an observation about a tool selection or advisory action",
      inputSchema: ObservationAddSchema,
    },
    async (args) => {
      const result = await observationAddHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_observation_resolve",
    {
      description: "Resolve a pending observation with an outcome, triggering Bayesian update if linked to a lesson",
      inputSchema: ObservationResolveSchema,
    },
    async (args) => {
      const result = await observationResolveHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_observation_link",
    {
      description: "Link a resolved observation to a lesson and trigger Bayesian update",
      inputSchema: ObservationLinkSchema,
    },
    async (args) => {
      const result = await observationLinkHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_observations",
    {
      description: "Query observations, optionally filtered by category or pending state",
      inputSchema: ObservationsQuerySchema,
    },
    async (args) => {
      const result = await observationsHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function observationAddHandler(
  args: {
    category: string;
    action_type: string;
    action_summary: string;
    context?: string;
    lesson_id?: number;
    outcome?: "adopted" | "ignored" | "corrected" | "success" | "failure" | "partial";
    outcome_details?: string;
    outcome_source: "explicit" | "implicit" | "review";
    outcome_weight?: number;
    session_id?: string;
  },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  const {
    category,
    action_type,
    action_summary,
    context,
    lesson_id,
    outcome,
    outcome_details,
    outcome_source,
    outcome_weight = 1.0,
    session_id,
  } = args;

  // If outcome is provided at add time, pre-resolve with resolved_at
  const resolvedAt = outcome ? "datetime('now')" : null;

  const stmt = conn.prepare(`
    INSERT INTO observations
      (category, action_type, action_summary, context, lesson_id,
       outcome, outcome_details, outcome_source, outcome_weight,
       session_id, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${resolvedAt ? resolvedAt : "NULL"})
  `);

  const result = stmt.run(
    category,
    action_type,
    action_summary,
    context ?? null,
    lesson_id ?? null,
    outcome ?? null,
    outcome_details ?? null,
    outcome_source,
    outcome_weight,
    session_id ?? null,
  );

  const newId = result.lastInsertRowid as number;

  // If pre-resolved with a lesson_id, trigger Bayesian update
  if (outcome && lesson_id) {
    const lessonRow = conn
      .prepare("SELECT domain FROM lessons WHERE id = ?")
      .get(lesson_id) as { domain: string } | undefined;

    if (lessonRow) {
      const weight = getAsymmetricWeight(lessonRow.domain, outcome) * outcome_weight;
      const { delta } = updatePosterior(conn, lesson_id, outcome, weight);
      conn
        .prepare("UPDATE observations SET confidence_delta = ? WHERE id = ?")
        .run(delta, newId);
    }
  }

  return JSON.stringify({ id: newId, status: "recorded" });
}

export async function observationResolveHandler(
  args: {
    observation_id: number;
    outcome: "adopted" | "ignored" | "corrected" | "success" | "failure" | "partial";
    outcome_details?: string;
    outcome_weight?: number;
  },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  const {
    observation_id,
    outcome,
    outcome_details,
    outcome_weight = 1.0,
  } = args;

  // Fetch the observation
  const obs = conn
    .prepare("SELECT id, lesson_id, resolved_at FROM observations WHERE id = ?")
    .get(observation_id) as
    | { id: number; lesson_id: number | null; resolved_at: string | null }
    | undefined;

  if (!obs) {
    return JSON.stringify({ error: `Observation ${observation_id} not found` });
  }

  if (obs.resolved_at !== null) {
    return JSON.stringify({ error: `Observation ${observation_id} is already resolved` });
  }

  // Resolve the observation
  conn
    .prepare(`
      UPDATE observations
      SET outcome = ?, outcome_details = ?, resolved_at = datetime('now')
      WHERE id = ?
    `)
    .run(outcome, outcome_details ?? null, observation_id);

  let confidenceDelta: number | null = null;

  // Trigger Bayesian update if linked to a lesson
  if (obs.lesson_id) {
    const lessonRow = conn
      .prepare("SELECT domain FROM lessons WHERE id = ?")
      .get(obs.lesson_id) as { domain: string } | undefined;

    if (lessonRow) {
      const weight = getAsymmetricWeight(lessonRow.domain, outcome) * outcome_weight;
      const { delta } = updatePosterior(conn, obs.lesson_id, outcome, weight);
      confidenceDelta = delta;
      conn
        .prepare("UPDATE observations SET confidence_delta = ? WHERE id = ?")
        .run(delta, observation_id);
    }
  }

  return JSON.stringify({
    status: "resolved",
    observation_id,
    outcome,
    confidence_delta: confidenceDelta,
  });
}

export async function observationsHandler(
  args: {
    category?: string;
    lesson_id?: number;
    pending_only?: boolean;
    limit?: number;
  },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  const { category, lesson_id, pending_only = false, limit = 50 } = args;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  if (lesson_id !== undefined) {
    conditions.push("lesson_id = ?");
    params.push(lesson_id);
  }

  if (pending_only) {
    conditions.push("resolved_at IS NULL");
  }

  const where =
    conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const sql = `
    SELECT id, category, action_type, action_summary, context,
           lesson_id, outcome, outcome_details, outcome_source,
           outcome_weight, confidence_delta, session_id,
           created_at, resolved_at
    FROM observations
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = conn.prepare(sql).all(...params) as Record<string, unknown>[];
  return JSON.stringify(rows, null, 2);
}

export async function observationLinkHandler(
  args: { observation_id: number; lesson_id: number },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  const { observation_id, lesson_id } = args;

  const obs = conn
    .prepare("SELECT id, outcome, outcome_weight, resolved_at, lesson_id FROM observations WHERE id = ?")
    .get(observation_id) as
    | { id: number; outcome: string | null; outcome_weight: number; resolved_at: string | null; lesson_id: number | null }
    | undefined;

  if (!obs) {
    return JSON.stringify({ error: `Observation ${observation_id} not found` });
  }

  if (!obs.outcome || !obs.resolved_at) {
    return JSON.stringify({ error: `Observation ${observation_id} is not resolved — resolve it first` });
  }

  if (obs.lesson_id !== null) {
    return JSON.stringify({ error: `Observation ${observation_id} is already linked to lesson ${obs.lesson_id}` });
  }

  // Verify lesson exists
  const lessonRow = conn
    .prepare("SELECT id, domain FROM lessons WHERE id = ?")
    .get(lesson_id) as { id: number; domain: string } | undefined;

  if (!lessonRow) {
    return JSON.stringify({ error: `Lesson ${lesson_id} not found` });
  }

  // Link and trigger Bayesian update
  const weight = getAsymmetricWeight(lessonRow.domain, obs.outcome) * obs.outcome_weight;
  const { delta } = updatePosterior(conn, lesson_id, obs.outcome, weight);

  conn
    .prepare("UPDATE observations SET lesson_id = ?, confidence_delta = ? WHERE id = ?")
    .run(lesson_id, delta, observation_id);

  return JSON.stringify({
    status: "linked",
    observation_id,
    lesson_id,
    confidence_delta: delta,
  });
}
