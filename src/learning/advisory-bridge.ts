import type Database from "better-sqlite3";
import type { DetectedAdvisory } from "./advisory-detector.js";
import { observationAddHandler } from "../tools/observations.js";

/**
 * Bridge between detectAdvisoryPatterns() output and the observation system.
 * Files each DetectedAdvisory as an observation and attempts to link to
 * relevant lessons via FTS keyword matching.
 */
export function fileAdvisoryObservations(
  db: Database.Database,
  advisories: DetectedAdvisory[],
  sessionId: string,
): { filed: number; linked: number } {
  let filed = 0;
  let linked = 0;

  for (const advisory of advisories) {
    // Attempt to find a matching lesson via FTS keyword overlap
    const lessonId = findMatchingLesson(db, advisory.action_summary);

    observationAddHandler(
      {
        category: "advisory",
        action_type: "suggestion",
        action_summary: advisory.action_summary,
        lesson_id: lessonId ?? undefined,
        outcome: advisory.outcome,
        outcome_source: "implicit",
        outcome_weight: advisory.outcome_weight,
        session_id: sessionId,
      },
      db,
    );

    filed++;
    if (lessonId !== null) linked++;
  }

  return { filed, linked };
}

/**
 * Find a lesson whose text matches keywords from the advisory summary.
 * Uses FTS5 for efficient matching. Returns the best match's ID or null.
 */
function findMatchingLesson(
  db: Database.Database,
  summary: string,
): number | null {
  // Extract meaningful keywords (4+ chars, skip common words)
  const stopWords = new Set([
    "that", "this", "with", "from", "have", "been", "will", "would",
    "could", "should", "about", "which", "their", "there", "what",
    "when", "then", "than", "them", "they", "your", "into", "also",
    "some", "more", "very", "just", "like", "make", "made",
  ]);

  const words = summary
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stopWords.has(w))
    .slice(0, 8); // Limit to 8 keywords

  if (words.length === 0) return null;

  // Build FTS query with OR (any keyword match)
  const ftsQuery = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");

  try {
    const row = db
      .prepare(
        `SELECT l.id FROM lessons l
         JOIN lessons_fts f ON f.rowid = l.id
         WHERE lessons_fts MATCH ? AND l.superseded_by IS NULL
         ORDER BY rank
         LIMIT 1`
      )
      .get(ftsQuery) as { id: number } | undefined;

    return row?.id ?? null;
  } catch {
    // FTS query might fail on unusual input — return null
    return null;
  }
}
