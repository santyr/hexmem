import type Database from "better-sqlite3";
import { buildMatchQuery } from "./retrieval/fts.js";

/**
 * Write-time quality gates shared by the fact/lesson/event add handlers.
 *
 * The 2026-07-11 audit found 44% of all facts ever written were junk on
 * arrival (dangling referents from an auto-extractor) and lint flagged 200+
 * near-duplicates — problems that are cheap to reject at write time and
 * expensive to clean up after.
 */

export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function normalizeMemoryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|to|of|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A fact whose subject is a pronoun or demonstrative is meaningless once the
 * conversation that produced it is gone ("this route", "their node", "it").
 */
export function hasDanglingReferent(subject: string): boolean {
  const s = subject.trim();
  if (!s) return true;
  return /^(this|that|these|those|it|they|them|their|he|she|him|his|her|hers|its|we|us|our|you|your)\b/i.test(
    s,
  );
}

interface DuplicateHit {
  id: number;
  ref: string;
}

interface DupConfig {
  fts: string;
  /** SQL producing the comparable text, aliased AS cmp */
  select: string;
  extraWhere: string;
}

const DUP_TABLES: Record<"facts" | "lessons" | "events", DupConfig> = {
  facts: {
    fts: "facts_fts",
    select:
      "SELECT t.id, COALESCE(t.subject_text,'') || ' ' || t.predicate || ' ' || COALESCE(t.object_text,'') AS cmp FROM facts t",
    extraWhere: "AND t.status = 'active'",
  },
  lessons: {
    fts: "lessons_fts",
    select: "SELECT t.id, t.lesson AS cmp FROM lessons t",
    extraWhere:
      "AND (t.valid_until IS NULL OR t.valid_until > datetime('now')) AND t.superseded_by IS NULL",
  },
  events: {
    fts: "events_fts",
    select: "SELECT t.id, t.summary AS cmp FROM events t",
    // Events are episodic — the same summary on a different day is a new
    // event. Only block same-summary repeats within a 48h window.
    extraWhere: "AND t.created_at > datetime('now', '-2 days')",
  },
};

/**
 * FTS-candidate near-duplicate check: pull the top bm25 candidates sharing
 * terms with the incoming text, then compare normalized forms. O(candidates),
 * not O(table).
 */
export function findNearDuplicate(
  db: Database.Database,
  table: "facts" | "lessons" | "events",
  text: string,
): DuplicateHit | null {
  const wanted = normalizeMemoryText(text);
  if (!wanted) return null;

  const cfg = DUP_TABLES[table];
  const match = buildMatchQuery(text);
  if (match.terms.length === 0) return null;

  try {
    const rows = db
      .prepare(
        `${cfg.select}
         JOIN (
           SELECT rowid, bm25(${cfg.fts}) AS r FROM ${cfg.fts}
           WHERE ${cfg.fts} MATCH ? ORDER BY r LIMIT 16
         ) f ON f.rowid = t.id
         WHERE 1=1 ${cfg.extraWhere}`,
      )
      .all(match.or) as Array<{ id: number; cmp: string }>;

    for (const row of rows) {
      if (normalizeMemoryText(row.cmp) === wanted) {
        return { id: row.id, ref: `${table}:${row.id}` };
      }
    }
  } catch {
    // FTS unavailable — skip dedup rather than block the write
  }
  return null;
}

export const LENGTH_LIMITS = {
  facts: 180,
  events: 180,
  lessons: 250,
} as const;

export function isOverLong(table: keyof typeof LENGTH_LIMITS, text: string): boolean {
  return approxTokens(text) > LENGTH_LIMITS[table];
}
