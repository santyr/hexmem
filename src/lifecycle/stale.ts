import type Database from "better-sqlite3";
import { normalizeMemoryText } from "../quality.js";

/**
 * Staleness management keeps retrieval from serving retired information as
 * current truth.
 *
 * staleSweep: multiple ACTIVE facts sharing a normalized (subject, predicate)
 * are a contradiction — only the newest can be current. Older rows get
 * superseded (never deleted; supersession genealogy is preserved).
 *
 * wakeDigest: the handful of most valuable at-risk memories, for a
 * session-start micro-review.
 */

export interface StaleGroup {
  subject: string;
  predicate: string;
  keep: number;
  supersede: number[];
  /**
   * duplicate: objects are near-identical — safe to auto-supersede.
   * conflict: objects differ — a subject can legitimately hold several
   * facts with one predicate, so these need judgment (fact_supersede),
   * never bulk action.
   */
  kind: "duplicate" | "conflict";
}

export interface StaleSweepResult {
  dry_run: boolean;
  groups: StaleGroup[];
  superseded: number;
}

interface FactRow {
  id: number;
  subject_text: string | null;
  predicate: string;
  object_text: string | null;
  created_at: string;
}

export function staleSweep(
  db: Database.Database,
  options: { dryRun?: boolean } = {},
): StaleSweepResult {
  const dryRun = options.dryRun ?? true;

  const rows = db
    .prepare(
      `SELECT id, subject_text, predicate, object_text, created_at
       FROM facts
       WHERE status = 'active' AND subject_text IS NOT NULL AND subject_text != ''
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as FactRow[];

  const groups = new Map<string, FactRow[]>();
  for (const row of rows) {
    const key = `${normalizeMemoryText(row.subject_text ?? "")}|${normalizeMemoryText(row.predicate)}`;
    if (key === "|") continue;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const result: StaleSweepResult = { dry_run: dryRun, groups: [], superseded: 0 };
  const supersedeStmt = db.prepare(
    `UPDATE facts SET status = 'superseded', superseded_by = ?, updated_at = datetime('now')
     WHERE id = ?`,
  );

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = list[list.length - 1];
    const older = list.slice(0, -1);

    const keepObject = normalizeMemoryText(keep.object_text ?? "");
    const kind: StaleGroup["kind"] = older.every(
      (r) => normalizeMemoryText(r.object_text ?? "") === keepObject,
    )
      ? "duplicate"
      : "conflict";

    result.groups.push({
      subject: keep.subject_text ?? "",
      predicate: keep.predicate,
      keep: keep.id,
      supersede: older.map((r) => r.id),
      kind,
    });

    if (!dryRun && kind === "duplicate") {
      for (const row of older) {
        supersedeStmt.run(keep.id, row.id);
        result.superseded++;
      }
    }
  }

  return result;
}

export interface DigestItem {
  ref: string;
  text: string;
  age_days: number;
  state: string;
  value: number;
}

/**
 * The most valuable at-risk memories: fading or overdue-for-review facts and
 * lessons, ranked by confidence × strength. Review with hexmem_feedback
 * (helpful → reinforce, stale → supersede or let decay).
 */
export function wakeDigest(db: Database.Database, limit = 5): DigestItem[] {
  const items: DigestItem[] = [];

  const factRows = db
    .prepare(
      `SELECT id, COALESCE(subject_text,'') || ' ' || predicate || ' ' || COALESCE(object_text,'') AS text,
              COALESCE(confidence, 0.5) * COALESCE(memory_strength, 1.0) AS value,
              consolidation_state AS state,
              CAST(julianday('now') - julianday(COALESCE(last_accessed_at, created_at)) AS INTEGER) AS age_days
       FROM facts
       WHERE status = 'active'
         AND (consolidation_state = 'fading'
              OR (next_review_at IS NOT NULL AND next_review_at <= datetime('now')))
       ORDER BY value DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  for (const row of factRows) {
    items.push({
      ref: `facts:${row.id}`,
      text: String(row.text),
      age_days: Number(row.age_days ?? 0),
      state: String(row.state),
      value: Math.round(Number(row.value ?? 0) * 1000) / 1000,
    });
  }

  const lessonRows = db
    .prepare(
      `SELECT id, lesson AS text,
              COALESCE(confidence, 0.5) * COALESCE(memory_strength, 1.0) AS value,
              consolidation_state AS state,
              CAST(julianday('now') - julianday(COALESCE(last_accessed_at, created_at)) AS INTEGER) AS age_days
       FROM lessons
       WHERE superseded_by IS NULL
         AND (valid_until IS NULL OR valid_until > datetime('now'))
         AND (consolidation_state = 'fading'
              OR (next_review_at IS NOT NULL AND next_review_at <= datetime('now')))
       ORDER BY value DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  for (const row of lessonRows) {
    items.push({
      ref: `lessons:${row.id}`,
      text: String(row.text),
      age_days: Number(row.age_days ?? 0),
      state: String(row.state),
      value: Math.round(Number(row.value ?? 0) * 1000) / 1000,
    });
  }

  items.sort((a, b) => b.value - a.value);
  return items.slice(0, limit);
}
