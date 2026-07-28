import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";

const NarrativeInputSchema = {
  action: z.string().describe("Action: list, create, update, resolve"),
  id: z.number().optional().describe("Thread ID (required for update/resolve)"),
  title: z.string().optional().describe("Thread title (required for create)"),
  thread_type: z.string().optional().describe("Type of thread (required for create)"),
  current_chapter: z.string().optional().describe("Current chapter label"),
  meaning_derived: z.string().optional().describe("Meaning or insight derived"),
};

const MeaningFrameInputSchema = {
  event_id: z.number().describe("Event ID this frame is about"),
  frame_type: z.string().describe("Frame type: redemption, contamination, growth, stability, chaos"),
  interpretation: z.string().describe("Interpretation of the event"),
  before_state: z.string().optional().describe("State before the event"),
  after_state: z.string().optional().describe("State after the event"),
  transformation: z.string().optional().describe("Nature of the transformation"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_narrative",
    {
      description: "Manage narrative threads: list active, create, update, or resolve",
      inputSchema: NarrativeInputSchema,
    },
    async (args) => {
      const result = await narrativeHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_meaning_frame",
    {
      description: "Add a meaning frame for an event (how it is interpreted)",
      inputSchema: MeaningFrameInputSchema,
    },
    async (args) => {
      const result = await meaningFrameHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function narrativeHandler(
  args: {
    action: string;
    id?: number;
    title?: string;
    thread_type?: string;
    current_chapter?: string;
    meaning_derived?: string;
  },
  db?: Database.Database
): Promise<string> {
  const { action } = args;
  const conn = db ?? getDb();

  if (action === "list") {
    const rows = conn
      .prepare(
        "SELECT id, title, thread_type, status, current_chapter, meaning_derived, created_at " +
          "FROM narrative_threads WHERE status = 'active' ORDER BY created_at DESC"
      )
      .all() as Record<string, unknown>[];
    return JSON.stringify(rows, null, 2);
  }

  if (action === "create") {
    if (!args.title || !args.thread_type) {
      return JSON.stringify({ error: "title and thread_type are required for create" });
    }
    const cur = conn
      .prepare(
        "INSERT INTO narrative_threads (title, thread_type, current_chapter, meaning_derived) " +
          "VALUES (?, ?, ?, ?)"
      )
      .run(
        args.title,
        args.thread_type,
        args.current_chapter ?? null,
        args.meaning_derived ?? null
      );
    return JSON.stringify({ id: cur.lastInsertRowid, status: "created" });
  }

  if (action === "update") {
    if (!args.id) {
      return JSON.stringify({ error: "id is required for update" });
    }
    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    if (args.title !== undefined) { sets.push("title = ?"); params.push(args.title); }
    if (args.thread_type !== undefined) { sets.push("thread_type = ?"); params.push(args.thread_type); }
    if (args.current_chapter !== undefined) { sets.push("current_chapter = ?"); params.push(args.current_chapter); }
    if (args.meaning_derived !== undefined) { sets.push("meaning_derived = ?"); params.push(args.meaning_derived); }

    params.push(args.id);
    conn.prepare(`UPDATE narrative_threads SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return JSON.stringify({ id: args.id, status: "updated" });
  }

  if (action === "resolve") {
    if (!args.id) {
      return JSON.stringify({ error: "id is required for resolve" });
    }
    conn
      .prepare(
        "UPDATE narrative_threads SET status = 'resolved', resolved_at = datetime('now'), " +
          "updated_at = datetime('now') WHERE id = ?"
      )
      .run(args.id);
    return JSON.stringify({ id: args.id, status: "resolved" });
  }

  return JSON.stringify({ error: `Unknown action: ${action}` });
}

export async function meaningFrameHandler(
  args: {
    event_id: number;
    frame_type: string;
    interpretation: string;
    before_state?: string;
    after_state?: string;
    transformation?: string;
  },
  db?: Database.Database
): Promise<string> {
  const { event_id, frame_type, interpretation, before_state, after_state, transformation } = args;
  const conn = db ?? getDb();

  const cur = conn
    .prepare(
      "INSERT INTO meaning_frames (event_id, frame_type, interpretation, before_state, after_state, transformation) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      event_id,
      frame_type,
      interpretation,
      before_state ?? null,
      after_state ?? null,
      transformation ?? null
    );

  return JSON.stringify({ id: cur.lastInsertRowid, status: "created" });
}
