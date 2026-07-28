import type Database from "better-sqlite3";

// SM-2 interval ladder (seconds)
// 20min, 1hr, 1day, 3days, 1week, 2weeks, 1month, 3months, 6months, 1year
const INTERVALS = [1200, 3600, 86400, 259200, 604800, 1209600, 2592000, 7776000, 15552000, 31536000];

const VALID_TABLES = new Set(["facts", "events", "lessons"]);

interface ReviewRow {
  id: number;
  repetition_count: number | null;
  memory_strength: number | null;
  retention_estimate: number | null;
}

export function review(
  db: Database.Database,
  table: string,
  itemId: number,
  quality: number,
): string {
  if (!VALID_TABLES.has(table)) {
    return JSON.stringify({ error: `Unknown table: ${table}. Must be one of: facts, events, lessons` });
  }

  if (quality < 0 || quality > 5 || !Number.isInteger(quality)) {
    return JSON.stringify({ error: `Invalid quality: ${quality}. Must be integer 0-5` });
  }

  const row = db.prepare(`SELECT id, repetition_count, memory_strength, retention_estimate FROM ${table} WHERE id = ?`).get(itemId) as ReviewRow | undefined;

  if (!row) {
    return JSON.stringify({ error: `${table} id ${itemId} not found` });
  }

  const retentionBefore = row.retention_estimate ?? 1.0;
  let rep = row.repetition_count ?? 0;
  let strength = row.memory_strength ?? 1.0;

  // SM-2 update
  if (quality <= 2) {
    // Failed recall — reset
    rep = 0;
    strength = Math.max(strength * 0.6, 0.1);
  } else if (quality === 3) {
    // Barely remembered — slight regression
    rep = Math.max(0, rep - 1);
    strength = Math.max(strength * 0.8, 0.1);
  } else if (quality === 4) {
    // Good recall
    rep = rep + 1;
    strength = Math.min(strength * 1.1, 10.0);
  } else {
    // quality === 5 — perfect recall
    rep = rep + 2;
    strength = Math.min(strength * 1.3, 10.0);
  }

  // Clamp strength
  strength = Math.max(0.1, Math.min(10.0, strength));

  // Calculate next review interval
  const intervalSeconds = INTERVALS[Math.min(rep, INTERVALS.length - 1)];
  const nextReviewAt = new Date(Date.now() + intervalSeconds * 1000).toISOString();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE ${table} SET
       repetition_count = ?,
       memory_strength = ?,
       last_reviewed_at = datetime('now'),
       next_review_at = ?,
       retention_estimate = 1.0,
       consolidation_state = 'active'
     WHERE id = ?`
  ).run(rep, strength, nextReviewAt, itemId);

  // Insert into review_log
  db.prepare(
    `INSERT INTO review_log (source_table, source_id, reviewed_at, retention_before, quality)
     VALUES (?, ?, ?, ?, ?)`
  ).run(table, itemId, now, retentionBefore, quality);

  return JSON.stringify({
    id: itemId,
    table,
    quality,
    repetition_count: rep,
    memory_strength: strength,
    next_review_at: nextReviewAt,
    status: "reviewed",
  });
}

interface DueRow {
  id: number;
  next_review_at: string;
  [key: string]: unknown;
}

export function reviewDue(db: Database.Database, limit: number): string {
  const results: Array<Record<string, unknown>> = [];

  const perTable = Math.ceil(limit / 3);

  // facts
  const facts = db.prepare(
    `SELECT id, 'facts' as source_table, subject_text, predicate, object_text, domain,
            memory_strength, next_review_at, consolidation_state
     FROM facts
     WHERE next_review_at IS NOT NULL AND next_review_at <= datetime('now')
       AND status = 'active'
     ORDER BY next_review_at ASC LIMIT ?`
  ).all(perTable) as DueRow[];

  // events
  const events = db.prepare(
    `SELECT id, 'events' as source_table, summary, event_type, category,
            memory_strength, next_review_at, consolidation_state
     FROM events
     WHERE next_review_at IS NOT NULL AND next_review_at <= datetime('now')
     ORDER BY next_review_at ASC LIMIT ?`
  ).all(perTable) as DueRow[];

  // lessons
  const lessons = db.prepare(
    `SELECT id, 'lessons' as source_table, lesson, domain,
          memory_strength, next_review_at, consolidation_state,
          alpha, beta_param,
          CASE
            WHEN alpha IS NOT NULL AND beta_param IS NOT NULL
            THEN alpha / (alpha + beta_param)
            ELSE confidence
          END as posterior_confidence
   FROM lessons
   WHERE (
     (next_review_at IS NOT NULL AND next_review_at <= datetime('now'))
     OR (alpha IS NOT NULL AND beta_param IS NOT NULL AND alpha / (alpha + beta_param) < 0.3 AND alpha + beta_param > 3)
   )
   AND (valid_until IS NULL OR valid_until > datetime('now'))
   AND superseded_by IS NULL
   ORDER BY next_review_at ASC LIMIT ?`
  ).all(perTable) as DueRow[];

  results.push(...facts, ...events, ...lessons);

  // Sort combined by next_review_at and trim to limit
  results.sort((a, b) => {
    const da = new Date(a["next_review_at"] as string).getTime();
    const db_ = new Date(b["next_review_at"] as string).getTime();
    return da - db_;
  });

  return JSON.stringify(results.slice(0, limit));
}
