import type Database from "better-sqlite3";

/**
 * Track access to records, incrementing access_count, updating last_accessed_at,
 * and promoting fading/compressed/forgotten records back to 'active'.
 */
export function trackAccess(db: Database.Database, table: string, ids: number[]): void {
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE ${table} SET ` +
    `access_count = COALESCE(access_count, 0) + 1, ` +
    `last_accessed_at = datetime('now'), ` +
    `consolidation_state = CASE WHEN consolidation_state IN ('fading','compressed','forgotten') ` +
    `THEN 'active' ELSE consolidation_state END ` +
    `WHERE id IN (${ph})`
  ).run(...ids);
}
