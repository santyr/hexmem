import type Database from "better-sqlite3";

/**
 * Retrieval-driven reinforcement. Memory strength is access-based, but until
 * the 2026-07-11 overhaul only hexmem_facts/hexmem_lessons bumped access —
 * the primary retrieval paths (recall/context/search) never reinforced what
 * they returned, so anything only reachable through search decayed anyway.
 *
 * Called with the refs actually returned to the caller (post-budgeting),
 * so only memories that made it into context get stronger.
 */

const PROMOTE_SQL =
  "consolidation_state = CASE WHEN consolidation_state IN ('fading','compressed','forgotten') THEN 'active' ELSE consolidation_state END";

export function reinforceRefs(db: Database.Database, refs: string[]): number {
  const byTable: Record<"facts" | "events" | "lessons", number[]> = {
    facts: [],
    events: [],
    lessons: [],
  };
  for (const ref of refs) {
    const match = /^(facts|events|lessons):(\d+)$/.exec(ref);
    if (match) byTable[match[1] as keyof typeof byTable].push(Number(match[2]));
  }

  let touched = 0;

  if (byTable.facts.length > 0) {
    const ph = byTable.facts.map(() => "?").join(",");
    // facts_access_tracking trigger handles last_accessed_at + strength boost
    touched += db
      .prepare(
        `UPDATE facts SET access_count = COALESCE(access_count, 0) + 1, ${PROMOTE_SQL} WHERE id IN (${ph})`,
      )
      .run(...byTable.facts).changes;
  }

  if (byTable.events.length > 0) {
    const ph = byTable.events.map(() => "?").join(",");
    // update_retention_on_access trigger handles access_count + strength
    touched += db
      .prepare(
        `UPDATE events SET last_accessed_at = datetime('now'), ${PROMOTE_SQL} WHERE id IN (${ph})`,
      )
      .run(...byTable.events).changes;
  }

  if (byTable.lessons.length > 0) {
    const ph = byTable.lessons.map(() => "?").join(",");
    touched += db
      .prepare(
        `UPDATE lessons SET access_count = COALESCE(access_count, 0) + 1,
           last_accessed_at = datetime('now'), ${PROMOTE_SQL} WHERE id IN (${ph})`,
      )
      .run(...byTable.lessons).changes;
  }

  return touched;
}
