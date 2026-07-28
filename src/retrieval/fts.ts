import type Database from "better-sqlite3";
import type { Sensitivity, SearchResult } from "../types.js";

interface TableConfig {
  name: string;
  fts: string;
  cols: string;
  hasSensitivity: boolean;
  extraWhere: string;
  /** column (already selected in cols) used for the recency bonus */
  dateField: string;
  /** column (already selected in cols) holding a 0..1 confidence, or "" */
  confidenceField: string;
}

const TABLES: TableConfig[] = [
  {
    name: "facts",
    fts: "facts_fts",
    cols: "id, subject_text, predicate, object_text, domain, sensitivity, prompt_form, confidence, created_at, last_accessed_at",
    hasSensitivity: true,
    extraWhere: "AND t.status = 'active'",
    dateField: "created_at",
    confidenceField: "confidence",
  },
  {
    name: "events",
    fts: "events_fts",
    cols: "id, summary, category, event_type, sensitivity, prompt_form, occurred_at, created_at",
    hasSensitivity: true,
    extraWhere: "",
    dateField: "occurred_at",
    confidenceField: "",
  },
  {
    name: "lessons",
    fts: "lessons_fts",
    cols: "id, domain, lesson, context, sensitivity, prompt_form, confidence, created_at",
    hasSensitivity: true,
    extraWhere:
      "AND (t.valid_until IS NULL OR t.valid_until > datetime('now')) AND t.superseded_by IS NULL",
    dateField: "created_at",
    confidenceField: "confidence",
  },
  {
    name: "memory_seeds",
    fts: "seeds_fts",
    cols: "id, seed_type, seed_text, created_at",
    hasSensitivity: false,
    extraWhere: "",
    dateField: "created_at",
    confidenceField: "",
  },
];

/** Words that are FTS5 operators — never treat them as search terms. */
const FTS_OPERATORS = new Set(["and", "or", "not", "near"]);

export interface MatchQuery {
  terms: string[];
  and: string;
  or: string;
}

/**
 * Sanitize free text into a safe FTS5 MATCH expression. Each term is
 * double-quoted so punctuation and operator injection cannot break the query.
 */
export function buildMatchQuery(raw: string): MatchQuery {
  const terms: string[] = [];
  for (const match of raw.matchAll(/[A-Za-z0-9_][A-Za-z0-9_.-]*/g)) {
    const term = match[0];
    if (FTS_OPERATORS.has(term.toLowerCase())) continue;
    if (!terms.includes(term)) terms.push(term);
    if (terms.length >= 12) break;
  }
  const quoted = terms.map((t) => `"${t}"`);
  return { terms, and: quoted.join(" AND "), or: quoted.join(" OR ") };
}

function daysSince(value: unknown): number {
  if (typeof value !== "string" || !value) return 365;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return 365;
  return Math.max(ms / 86400000, 0);
}

/**
 * Blend FTS relevance with recency and confidence.
 * bm25() is smaller-is-better (negative for good matches), so relevance
 * is its negation. Recency contributes up to +2, confidence up to +1.
 */
function blendScore(ftsRank: number, row: Record<string, unknown>, cfg: TableConfig): number {
  const relevance = -ftsRank;
  const recency = 2 / (1 + daysSince(row[cfg.dateField] ?? row["created_at"]) / 30);
  const confidence = cfg.confidenceField
    ? Number(row[cfg.confidenceField] ?? 0.5) || 0
    : 0.5;
  return relevance + recency + confidence;
}

function queryTable(
  db: Database.Database,
  t: TableConfig,
  match: string,
  limit: number,
  maxSensitivity: Sensitivity,
): SearchResult[] {
  const sensitivityClause =
    t.hasSensitivity && maxSensitivity === "public" ? "AND t.sensitivity = 'public'" : "";
  const cols = t.cols
    .split(",")
    .map((c) => `t.${c.trim()}`)
    .join(", ");

  try {
    const rows = db
      .prepare(
        `SELECT ${cols}, f.fts_rank FROM (
           SELECT rowid, bm25(${t.fts}) AS fts_rank
           FROM ${t.fts} WHERE ${t.fts} MATCH ?
           ORDER BY fts_rank LIMIT ?
         ) f
         JOIN ${t.name} t ON t.id = f.rowid
         WHERE 1=1 ${sensitivityClause} ${t.extraWhere}`,
      )
      .all(match, limit * 3) as Record<string, unknown>[];

    return rows.map((row) => {
      const { fts_rank, ...content } = row;
      return {
        table: t.name,
        id: content["id"] as number,
        content,
        score: blendScore(Number(fts_rank ?? 0), content, t),
      };
    });
  } catch {
    // FTS table missing or query issue — skip this table
    return [];
  }
}

/**
 * Ranked full-text search. Tries AND semantics first for precision; when a
 * multi-term query matches nothing, falls back to OR so partial matches
 * still surface (ranked lower by bm25). Results are merged across tables
 * and ordered best-first.
 */
export function ftsSearch(
  db: Database.Database,
  query: string,
  limit: number,
  maxSensitivity: Sensitivity,
): SearchResult[] {
  const match = buildMatchQuery(query);
  if (match.terms.length === 0) return [];

  let results: SearchResult[] = [];
  for (const t of TABLES) {
    results.push(...queryTable(db, t, match.and, limit, maxSensitivity));
  }

  if (results.length === 0 && match.terms.length > 1) {
    for (const t of TABLES) {
      results.push(...queryTable(db, t, match.or, limit, maxSensitivity));
    }
  }

  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return results.slice(0, limit);
}
