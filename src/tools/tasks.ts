import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { observeTaskCompletion } from "../learning/task-observer.js";

const TasksInputSchema = {
  status: z.string().default("pending").describe("Filter by status (pending, in_progress, completed, cancelled, deferred)"),
  limit: z.number().default(10).describe("Max results"),
};

const TaskUpdateInputSchema = {
  task_id: z.number().describe("ID of the task to update"),
  status: z.string().describe("New status"),
  notes: z.string().optional().describe("Optional notes to store as context"),
  actual_effort_minutes: z.number().optional().describe("Actual effort in minutes (set on completion)"),
};

const TaskCreateInputSchema = {
  title: z.string().describe("Task title"),
  description: z.string().optional().describe("Detailed description"),
  task_type: z.string().default("todo").describe("todo, reminder, recurring, goal_step"),
  priority: z.number().default(5).describe("Priority 1-10"),
  due_at: z.string().optional().describe("Due date ISO string"),
  context: z.string().optional().describe("Additional context"),
  verification_criteria: z.array(z.object({
    id: z.string(),
    description: z.string(),
    type: z.enum(["automated", "manual", "review"]),
  })).optional().describe("Pass/fail conditions for completion"),
  blocked_by: z.array(z.number()).optional().describe("Task IDs that must complete first"),
  effort_estimate_minutes: z.number().optional().describe("Estimated effort in minutes"),
  related_lesson_ids: z.array(z.number()).optional().describe("Lesson IDs to update on completion"),
};

const TaskVerifyInputSchema = {
  task_id: z.number().describe("Task ID"),
  criterion_id: z.string().describe("Verification criterion ID"),
  status: z.enum(["pass", "fail"]).describe("Whether criterion passed"),
  notes: z.string().optional().describe("Verification notes"),
};

const TaskProgressInputSchema = {
  include_blocked: z.boolean().default(false).describe("Include blocked tasks"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_tasks",
    {
      description: "Query tasks by status (pending, in_progress, completed, cancelled, deferred)",
      inputSchema: TasksInputSchema,
    },
    async (args) => {
      const result = await tasksHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_task_update",
    {
      description: "Update a task's status. Sets completed_at when status is 'completed'. Files observations for related lessons.",
      inputSchema: TaskUpdateInputSchema,
    },
    async (args) => {
      const result = await taskUpdateHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_task_create",
    {
      description: "Create a new task with optional verification criteria, dependencies, and lesson linking",
      inputSchema: TaskCreateInputSchema,
    },
    async (args) => {
      const result = await taskCreateHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_task_verify",
    {
      description: "Mark a verification criterion as pass/fail. Auto-completes task when all criteria pass.",
      inputSchema: TaskVerifyInputSchema,
    },
    async (args) => {
      const result = await taskVerifyHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_task_progress",
    {
      description: "Structured progress query: in_progress, pending unblocked, pending blocked, recently completed, overdue",
      inputSchema: TaskProgressInputSchema,
    },
    async (args) => {
      const result = await taskProgressHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function tasksHandler(
  args: { status?: string; limit?: number },
  db?: Database.Database
): Promise<string> {
  const { status = "pending", limit = 10 } = args;
  const conn = db ?? getDb();

  const rows = conn
    .prepare(
      "SELECT id, title, description, task_type, status, priority, due_at, context, " +
        "verification_criteria, acceptance_status, blocked_by, correction_count " +
        "FROM tasks WHERE status = ? ORDER BY priority DESC LIMIT ?"
    )
    .all(status, limit) as Record<string, unknown>[];

  return JSON.stringify(rows, null, 2);
}

export async function taskUpdateHandler(
  args: { task_id: number; status: string; notes?: string; actual_effort_minutes?: number },
  db?: Database.Database
): Promise<string> {
  const { task_id, status, notes, actual_effort_minutes } = args;
  const conn = db ?? getDb();

  const sets: string[] = ["status = ?", "updated_at = datetime('now')"];
  const params: unknown[] = [status];

  if (status === "completed") {
    sets.push("completed_at = datetime('now')");
  }

  if (notes !== undefined) {
    sets.push("context = ?");
    params.push(notes);
  }

  if (actual_effort_minutes !== undefined) {
    sets.push("actual_effort_minutes = ?");
    params.push(actual_effort_minutes);
  }

  params.push(task_id);
  conn.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  // File completion observations if status is completed
  if (status === "completed") {
    observeTaskCompletion(conn, task_id);
  }

  return JSON.stringify({ id: task_id, status: "updated" });
}

export async function taskCreateHandler(
  args: {
    title: string;
    description?: string;
    task_type?: string;
    priority?: number;
    due_at?: string;
    context?: string;
    verification_criteria?: Array<{ id: string; description: string; type: string }>;
    blocked_by?: number[];
    effort_estimate_minutes?: number;
    related_lesson_ids?: number[];
  },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  const {
    title,
    description,
    task_type = "todo",
    priority = 5,
    due_at,
    context,
    verification_criteria,
    blocked_by,
    effort_estimate_minutes,
    related_lesson_ids,
  } = args;

  const result = conn
    .prepare(
      `INSERT INTO tasks
        (title, description, task_type, priority, due_at, context,
         verification_criteria, acceptance_status, blocked_by,
         effort_estimate_minutes, related_lesson_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      description ?? null,
      task_type,
      priority,
      due_at ?? null,
      context ?? null,
      verification_criteria ? JSON.stringify(verification_criteria) : null,
      verification_criteria ? JSON.stringify({}) : null,
      blocked_by ? JSON.stringify(blocked_by) : null,
      effort_estimate_minutes ?? null,
      related_lesson_ids ? JSON.stringify(related_lesson_ids) : null,
    );

  return JSON.stringify({ id: result.lastInsertRowid, status: "created" });
}

export async function taskVerifyHandler(
  args: { task_id: number; criterion_id: string; status: "pass" | "fail"; notes?: string },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  const { task_id, criterion_id, status: criterionStatus, notes } = args;

  const task = conn
    .prepare(
      "SELECT id, verification_criteria, acceptance_status, correction_count FROM tasks WHERE id = ?"
    )
    .get(task_id) as {
    id: number;
    verification_criteria: string | null;
    acceptance_status: string | null;
    correction_count: number;
  } | undefined;

  if (!task) {
    return JSON.stringify({ error: `Task ${task_id} not found` });
  }

  if (!task.verification_criteria) {
    return JSON.stringify({ error: `Task ${task_id} has no verification criteria` });
  }

  const criteria: Array<{ id: string; description: string; type: string }> = JSON.parse(
    task.verification_criteria
  );
  const acceptance: Record<string, string> = task.acceptance_status
    ? JSON.parse(task.acceptance_status)
    : {};

  // Check criterion exists
  if (!criteria.some((c) => c.id === criterion_id)) {
    return JSON.stringify({ error: `Criterion '${criterion_id}' not found in task ${task_id}` });
  }

  // Track corrections: was previously "fail" and now "pass"
  let correctionCount = task.correction_count ?? 0;
  if (acceptance[criterion_id] === "fail" && criterionStatus === "pass") {
    correctionCount++;
  }

  acceptance[criterion_id] = criterionStatus;

  // Check if all criteria pass
  const allPass = criteria.every((c) => acceptance[c.id] === "pass");

  const sets = [
    "acceptance_status = ?",
    "correction_count = ?",
    "updated_at = datetime('now')",
  ];
  const params: unknown[] = [JSON.stringify(acceptance), correctionCount];

  if (allPass) {
    sets.push("status = 'completed'", "completed_at = datetime('now')");
  }

  params.push(task_id);
  conn.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  // File observations if auto-completed
  if (allPass) {
    observeTaskCompletion(conn, task_id);
  }

  const passed = criteria.filter((c) => acceptance[c.id] === "pass").length;
  const failed = criteria.filter((c) => acceptance[c.id] === "fail").length;

  return JSON.stringify({
    task_id,
    criterion_id,
    criterion_status: criterionStatus,
    auto_completed: allPass,
    criteria_summary: { total: criteria.length, passed, failed },
    correction_count: correctionCount,
  });
}

export async function taskProgressHandler(
  args: { include_blocked?: boolean },
  db?: Database.Database
): Promise<string> {
  const conn = db ?? getDb();
  const { include_blocked = false } = args;

  const allTasks = conn
    .prepare(
      `SELECT id, title, status, priority, due_at,
              verification_criteria, acceptance_status, blocked_by, correction_count
       FROM tasks
       WHERE status NOT IN ('cancelled')
       ORDER BY priority DESC`
    )
    .all() as Array<{
    id: number;
    title: string;
    status: string;
    priority: number;
    due_at: string | null;
    verification_criteria: string | null;
    acceptance_status: string | null;
    blocked_by: string | null;
    correction_count: number;
  }>;

  const completedIds = new Set(
    allTasks.filter((t) => t.status === "completed").map((t) => t.id)
  );

  function criteriaSummary(task: typeof allTasks[0]) {
    if (!task.verification_criteria) return null;
    const criteria: Array<{ id: string }> = JSON.parse(task.verification_criteria);
    const acceptance: Record<string, string> = task.acceptance_status
      ? JSON.parse(task.acceptance_status)
      : {};
    return {
      total: criteria.length,
      passed: criteria.filter((c) => acceptance[c.id] === "pass").length,
      failed: criteria.filter((c) => acceptance[c.id] === "fail").length,
    };
  }

  function isBlocked(task: typeof allTasks[0]): boolean {
    if (!task.blocked_by) return false;
    const deps: number[] = JSON.parse(task.blocked_by);
    return deps.some((id) => !completedIds.has(id));
  }

  function formatTask(task: typeof allTasks[0]) {
    return {
      id: task.id,
      title: task.title,
      priority: task.priority,
      due_at: task.due_at,
      criteria: criteriaSummary(task),
      correction_count: task.correction_count,
    };
  }

  const inProgress = allTasks
    .filter((t) => t.status === "in_progress")
    .map(formatTask);

  const pendingUnblocked = allTasks
    .filter((t) => t.status === "pending" && !isBlocked(t))
    .map(formatTask);

  const pendingBlocked = include_blocked
    ? allTasks.filter((t) => t.status === "pending" && isBlocked(t)).map(formatTask)
    : [];

  const recentlyCompleted = allTasks
    .filter((t) => t.status === "completed")
    .slice(0, 5)
    .map(formatTask);

  const overdue = allTasks
    .filter(
      (t) =>
        t.status !== "completed" &&
        t.due_at !== null &&
        t.due_at < new Date().toISOString()
    )
    .map(formatTask);

  return JSON.stringify({
    in_progress: inProgress,
    pending_unblocked: pendingUnblocked,
    pending_blocked: pendingBlocked,
    recently_completed: recentlyCompleted,
    overdue,
  }, null, 2);
}
