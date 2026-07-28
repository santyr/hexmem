import type Database from "better-sqlite3";
import type { Embedder } from "../types.js";
import { ensureVecTables, upsertVec, vecAvailable, VEC_TABLES } from "./vec.js";

/**
 * Drains embedding_queue (fed by insert triggers since migration 006, but
 * unconsumed from 2026-02-03 until this overhaul — 5,700 rows deep at the
 * time of the audit).
 */

export interface DrainResult {
  processed: number;
  failed: number;
  remaining: number;
}

interface QueueRow {
  id: number;
  source_table: string;
  source_id: number;
  text_to_embed: string;
}

export async function drainEmbeddingQueue(
  db: Database.Database,
  embedder: Embedder,
  batch = 64,
): Promise<DrainResult> {
  if (!vecAvailable(db)) {
    return { processed: 0, failed: 0, remaining: countPending(db) };
  }
  ensureVecTables(db);

  const rows = db
    .prepare(
      `SELECT id, source_table, source_id, text_to_embed
       FROM embedding_queue WHERE status = 'pending' ORDER BY id LIMIT ?`,
    )
    .all(batch) as QueueRow[];

  const markDone = db.prepare(
    "UPDATE embedding_queue SET status = 'done', processed_at = datetime('now') WHERE id = ?",
  );
  const markFailed = db.prepare(
    "UPDATE embedding_queue SET status = 'failed', error_message = ?, processed_at = datetime('now') WHERE id = ?",
  );

  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (!VEC_TABLES[row.source_table]) {
        markFailed.run(`unknown source_table ${row.source_table}`, row.id);
        failed++;
        continue;
      }
      const vec = await embedder.embed(row.text_to_embed ?? "");
      upsertVec(db, row.source_table, row.source_id, vec);
      markDone.run(row.id);
      processed++;
    } catch (error) {
      markFailed.run(String(error).slice(0, 500), row.id);
      failed++;
    }
  }

  return { processed, failed, remaining: countPending(db) };
}

function countPending(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM embedding_queue WHERE status = 'pending'")
    .get() as { n: number };
  return row.n;
}
