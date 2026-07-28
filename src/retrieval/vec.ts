import type Database from "better-sqlite3";
import type { Sensitivity, SearchResult } from "../types.js";

/**
 * sqlite-vec (vec0) vector store. Table shapes match what the legacy Python
 * implementation created, so existing prod tables keep working.
 */

const DIMENSIONS = 384;

interface VecTableConfig {
  vecTable: string;
  idCol: string;
}

/** source_table (as used by embedding_queue) → vec0 table */
export const VEC_TABLES: Record<string, VecTableConfig> = {
  facts: { vecTable: "vec_facts", idCol: "fact_id" },
  events: { vecTable: "vec_events", idCol: "event_id" },
  lessons: { vecTable: "vec_lessons", idCol: "lesson_id" },
  memory_seeds: { vecTable: "vec_seeds", idCol: "seed_id" },
  entities: { vecTable: "vec_entities", idCol: "entity_id" },
};

/** Source-table presentation for KNN results — mirrors fts.ts filters. */
const SEARCH_SOURCES: Array<{
  name: string;
  cols: string;
  hasSensitivity: boolean;
  extraWhere: string;
}> = [
  {
    name: "facts",
    cols: "id, subject_text, predicate, object_text, domain, sensitivity, prompt_form, confidence, created_at, last_accessed_at",
    hasSensitivity: true,
    extraWhere: "AND t.status = 'active'",
  },
  {
    name: "events",
    cols: "id, summary, category, event_type, sensitivity, prompt_form, occurred_at, created_at",
    hasSensitivity: true,
    extraWhere: "",
  },
  {
    name: "lessons",
    cols: "id, domain, lesson, context, sensitivity, prompt_form, confidence, created_at",
    hasSensitivity: true,
    extraWhere:
      "AND (t.valid_until IS NULL OR t.valid_until > datetime('now')) AND t.superseded_by IS NULL",
  },
  {
    name: "memory_seeds",
    cols: "id, seed_type, seed_text, created_at",
    hasSensitivity: false,
    extraWhere: "",
  },
];

export function vecAvailable(db: Database.Database): boolean {
  try {
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

export function ensureVecTables(db: Database.Database): void {
  for (const cfg of Object.values(VEC_TABLES)) {
    db.prepare(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${cfg.vecTable} USING vec0(
         ${cfg.idCol} INTEGER PRIMARY KEY,
         embedding float[${DIMENSIONS}]
       )`,
    ).run();
  }
}

export function upsertVec(
  db: Database.Database,
  sourceTable: string,
  id: number,
  vec: Float32Array,
): void {
  const cfg = VEC_TABLES[sourceTable];
  if (!cfg) throw new Error(`no vec table for source ${sourceTable}`);
  const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  // sqlite-vec rejects JS-number bindings for its INTEGER primary key
  db.prepare(`DELETE FROM ${cfg.vecTable} WHERE ${cfg.idCol} = ?`).run(BigInt(id));
  db.prepare(`INSERT INTO ${cfg.vecTable} (${cfg.idCol}, embedding) VALUES (?, ?)`).run(
    BigInt(id),
    blob,
  );
}

/**
 * KNN search across facts/events/lessons/seeds, joined back to source rows
 * with the same status/sensitivity filters as FTS. Results are ordered by
 * ascending distance; score is cosine similarity (vectors are normalized).
 */
export function vecSearch(
  db: Database.Database,
  queryVec: Float32Array,
  limitPerTable: number,
  maxSensitivity: Sensitivity,
): SearchResult[] {
  const blob = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
  const results: SearchResult[] = [];

  for (const src of SEARCH_SOURCES) {
    const cfg = VEC_TABLES[src.name];
    const sensitivityClause =
      src.hasSensitivity && maxSensitivity === "public" ? "AND t.sensitivity = 'public'" : "";
    const cols = src.cols
      .split(",")
      .map((c) => `t.${c.trim()}`)
      .join(", ");

    try {
      const rows = db
        .prepare(
          `SELECT ${cols}, v.distance FROM (
             SELECT ${cfg.idCol} AS vid, distance
             FROM ${cfg.vecTable}
             WHERE embedding MATCH ? AND k = ?
           ) v
           JOIN ${src.name} t ON t.id = v.vid
           WHERE 1=1 ${sensitivityClause} ${src.extraWhere}`,
        )
        .all(blob, BigInt(limitPerTable)) as Record<string, unknown>[];

      for (const row of rows) {
        const { distance, ...content } = row;
        const d = Number(distance ?? 2);
        results.push({
          table: src.name,
          id: content["id"] as number,
          content,
          // normalized vectors: L2² = 2 - 2·cos → cos = 1 - d²/2
          score: 1 - (d * d) / 2,
        });
      }
    } catch {
      // vec table missing or extension unavailable — skip
    }
  }

  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return results;
}
