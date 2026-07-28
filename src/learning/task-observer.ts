import type Database from "better-sqlite3";
import { observationAddHandler } from "../tools/observations.js";

interface TaskRow {
  id: number;
  title: string;
  correction_count: number;
  effort_estimate_minutes: number | null;
  actual_effort_minutes: number | null;
  related_lesson_ids: string | null;
}

/**
 * File observations when a task completes. Links outcomes to related lessons
 * for Bayesian learning.
 */
export function observeTaskCompletion(
  db: Database.Database,
  taskId: number,
  sessionId?: string,
): { observations_filed: number } {
  const task = db
    .prepare(
      `SELECT id, title, correction_count, effort_estimate_minutes,
              actual_effort_minutes, related_lesson_ids
       FROM tasks WHERE id = ?`
    )
    .get(taskId) as TaskRow | undefined;

  if (!task) return { observations_filed: 0 };

  let filed = 0;

  // Parse related lesson IDs
  let lessonIds: number[] = [];
  if (task.related_lesson_ids) {
    try {
      lessonIds = JSON.parse(task.related_lesson_ids);
    } catch { /* invalid JSON */ }
  }

  // File observations for each related lesson
  for (const lessonId of lessonIds) {
    if (task.correction_count > 0) {
      // Task required corrections → negative signal
      observationAddHandler(
        {
          category: "session",
          action_type: "task_completion",
          action_summary: `Task "${task.title}" completed with ${task.correction_count} correction(s)`,
          lesson_id: lessonId,
          outcome: "corrected",
          outcome_source: "explicit",
          outcome_weight: 0.5 * task.correction_count,
          session_id: sessionId,
        },
        db,
      );
    } else {
      // Clean completion → positive signal
      observationAddHandler(
        {
          category: "session",
          action_type: "task_completion",
          action_summary: `Task "${task.title}" completed cleanly`,
          lesson_id: lessonId,
          outcome: "success",
          outcome_source: "explicit",
          outcome_weight: 1.0,
          session_id: sessionId,
        },
        db,
      );
    }
    filed++;
  }

  // File estimation accuracy observation if both estimates exist
  if (
    task.effort_estimate_minutes !== null &&
    task.actual_effort_minutes !== null &&
    task.actual_effort_minutes > 0
  ) {
    const ratio = task.actual_effort_minutes / task.effort_estimate_minutes;
    const accuracy = ratio > 2 ? "poor" : ratio > 1.3 ? "fair" : "good";
    observationAddHandler(
      {
        category: "session",
        action_type: "effort_estimation",
        action_summary: `Task "${task.title}" estimate=${task.effort_estimate_minutes}m actual=${task.actual_effort_minutes}m (${accuracy})`,
        outcome: accuracy === "good" ? "success" : "partial",
        outcome_source: "explicit",
        session_id: sessionId,
      },
      db,
    );
    filed++;
  }

  return { observations_filed: filed };
}
