import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";

import { getDb } from "../db.js";
import { hybridSearch } from "../retrieval/hybrid.js";
import { createEmbedder } from "../retrieval/embedder.js";
import { reinforceRefs } from "../lifecycle/reinforce.js";
import type { SearchResult, Sensitivity } from "../types.js";
import { eventAddHandler } from "./events.js";
import { factAddHandler } from "./facts.js";
import { lessonAddHandler } from "./lessons.js";
import { memoryHealthHandler } from "./lifecycle.js";
import { observationAddHandler } from "./observations.js";
import { reviewHandler } from "./review.js";
import { taskCreateHandler } from "./tasks.js";

const GatewaySensitivitySchema = z
  .enum(["public", "private"])
  .default("private")
  .describe("Maximum sensitivity to return");

const ContextInputSchema = {
  situation: z.string().describe("Current situation or task"),
  budget_tokens: z.number().default(600).describe("Approximate token budget for returned items"),
  cwd: z.string().default("").describe("Current working directory"),
  sensitivity: GatewaySensitivitySchema,
  include_evidence: z.boolean().default(false).describe("Include compact source evidence"),
};

const RecallInputSchema = {
  query: z.string().describe("Search query"),
  intent: z.string().default("").describe("Optional retrieval intent"),
  domains: z.array(z.string()).default([]).describe("Optional domain filters"),
  budget_tokens: z.number().default(600).describe("Approximate token budget for returned items"),
  sensitivity: GatewaySensitivitySchema,
  include_evidence: z.boolean().default(false).describe("Include compact source evidence"),
  debug: z.boolean().default(false).describe("Include retrieval diagnostics"),
};

const RememberInputSchema = {
  text: z.string().describe("Durable memory text to store"),
  kind: z
    .enum(["auto", "fact", "event", "lesson", "observation", "task"])
    .default("auto")
    .describe("Memory kind. auto classifies from text."),
  domain: z.string().default("").describe("Domain/category for the memory"),
  sensitivity: z.string().default("").describe("public/private. Empty uses existing defaults."),
  source: z.string().default("hexmem_remember").describe("Memory source"),
  allow_ephemeral: z.boolean().default(false).describe("Allow likely temporary task progress"),
  confidence: z.number().default(0.8).describe("Confidence for lessons/facts"),
  session_id: z.string().optional().describe("Optional session ID"),
  subject: z.string().optional().describe("Fact subject override"),
  predicate: z.string().optional().describe("Fact predicate override"),
  object: z.string().optional().describe("Fact object override"),
};

const FeedbackInputSchema = {
  ref: z.string().describe("Memory ref such as facts:1, events:2, lessons:3"),
  rating: z.enum(["helpful", "wrong", "stale", "ignored"]).describe("Feedback rating"),
  note: z.string().optional().describe("Optional feedback note"),
  session_id: z.string().optional().describe("Optional session ID"),
};

const WorkingSetInputSchema = {
  action: z.enum(["get", "add", "remove", "clear"]).describe("Working set operation"),
  session_id: z.string().default("default").describe("Session-local working set ID"),
  item: z.string().optional().describe("Item text for add/remove"),
  item_type: z.string().default("memory").describe("Item type for add"),
  ttl_minutes: z.number().default(120).describe("Time to live for added items"),
  budget_tokens: z.number().default(200).describe("Approximate token budget for output items"),
  id: z.number().optional().describe("Working set row ID for remove"),
};

const LintInputSchema = {
  domains: z.array(z.string()).default([]).describe("Optional domains/categories to inspect"),
  budget_tokens: z.number().default(700).describe("Approximate token budget for returned issues"),
};

const HealthInputSchema = {};

type MemoryKind = "fact" | "event" | "lesson" | "observation" | "task" | "seed";

interface GatewayItem {
  ref: string;
  kind: MemoryKind;
  domain?: string;
  text: string;
  sensitivity?: string;
  score?: number;
  evidence?: Record<string, unknown>;
}

interface LintIssue {
  code: string;
  severity: "info" | "warning" | "error";
  ref: string;
  text: string;
}

const GATEWAY_TOOL_NAMES = [
  "hexmem_context",
  "hexmem_recall",
  "hexmem_remember",
  "hexmem_feedback",
  "hexmem_working_set",
  "hexmem_lint",
  "hexmem_health",
] as const;

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_context",
    {
      description: "Compact relevant memory packet for the current situation.",
      inputSchema: ContextInputSchema,
    },
    async (args) => {
      const result = await contextHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.registerTool(
    "hexmem_recall",
    {
      description: "Ranked, token-budgeted retrieval by query, intent, and domain.",
      inputSchema: RecallInputSchema,
    },
    async (args) => {
      const result = await recallHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.registerTool(
    "hexmem_remember",
    {
      description:
        "Durable-memory write gateway. Auto-classifies, rejects likely temporary progress, and dedupes near-exact memories.",
      inputSchema: RememberInputSchema,
    },
    async (args) => {
      const result = await rememberHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.registerTool(
    "hexmem_feedback",
    {
      description: "Mark recalled memory helpful, wrong, stale, or ignored.",
      inputSchema: FeedbackInputSchema,
    },
    async (args) => {
      const result = await feedbackHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.registerTool(
    "hexmem_working_set",
    {
      description: "Session-local, DB-backed working set with TTL and compact output.",
      inputSchema: WorkingSetInputSchema,
    },
    async (args) => {
      const result = await workingSetHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.registerTool(
    "hexmem_lint",
    {
      description: "Hygiene diagnostics for duplicate, temporary, imperative, long, procedural, or secret-like memories.",
      inputSchema: LintInputSchema,
    },
    async (args) => {
      const result = await lintHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.registerTool(
    "hexmem_health",
    {
      description: "Compact health wrapper for memory tables.",
      inputSchema: HealthInputSchema,
    },
    async () => {
      const result = await healthHandler({});
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
}

export function gatewayToolNames(): readonly string[] {
  return GATEWAY_TOOL_NAMES;
}

export async function recallHandler(
  args: {
    query: string;
    intent?: string;
    domains?: string[];
    budget_tokens?: number;
    sensitivity?: string;
    include_evidence?: boolean;
    debug?: boolean;
  },
  db?: Database.Database,
): Promise<string> {
  const conn = db ?? getDb();
  const query = args.query ?? "";
  const intent = args.intent ?? "";
  const domains = (args.domains ?? []).map(normalizeDomain).filter(Boolean);
  const budget = cleanBudget(args.budget_tokens, 600);
  const sensitivity = normalizeSensitivity(args.sensitivity);

  if (!query.trim() && !intent.trim() && domains.length === 0) {
    return JSON.stringify({
      status: "ok",
      query,
      item_tokens: 0,
      truncated: false,
      items: [],
    });
  }

  const searchQuery = buildFtsQuery([query, intent, ...domains]);
  const rawResults = searchQuery
    ? await hybridSearch(conn, searchQuery, 30, sensitivity, await createEmbedder())
    : fallbackDomainResults(conn, domains, sensitivity);

  let candidates = rawResults.map((result) => resultToGatewayItem(result));
  if (domains.length > 0) {
    candidates = candidates.filter((item) => domains.includes(normalizeDomain(item.domain ?? "")));
  }

  const queryTerms = extractTerms([query, intent]).map((term) => term.toLowerCase());
  // Fuse the retrieval layer's blended score (bm25 + recency + confidence)
  // with term-overlap and domain bonuses.
  const ranked = candidates
    .map((item, index) => ({
      ...item,
      score: scoreItem(item, queryTerms, domains) + (item.score ?? 0) - index / 1000,
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const compacted = budgetItems(
    ranked.map((item) => compactItem(item, args.include_evidence ?? false)),
    budget,
  );

  // Access-based strength only works if retrieval reinforces what it returns
  reinforceRefs(conn, compacted.items.map((item) => String(item.ref)));

  const response: Record<string, unknown> = {
    status: "ok",
    query,
    item_tokens: compacted.item_tokens,
    truncated: compacted.truncated,
    items: compacted.items,
  };

  if (args.debug) {
    response.debug = {
      search_query: searchQuery,
      candidates: candidates.length,
      query_terms: queryTerms,
      domains,
      budget_tokens: budget,
    };
  }

  return JSON.stringify(response);
}

export async function contextHandler(
  args: {
    situation: string;
    budget_tokens?: number;
    cwd?: string;
    sensitivity?: string;
    include_evidence?: boolean;
  },
  db?: Database.Database,
): Promise<string> {
  const budget = cleanBudget(args.budget_tokens, 600);
  const cwd = args.cwd ?? "";
  const domains = inferDomainsFromCwd(cwd);
  const recall = JSON.parse(
    await recallHandler(
      {
        query: args.situation,
        intent: "context",
        domains,
        budget_tokens: budget,
        sensitivity: args.sensitivity,
        include_evidence: args.include_evidence,
      },
      db,
    ),
  ) as { items: GatewayItem[]; item_tokens: number; truncated: boolean };

  const lines = [
    `situation: ${clip(args.situation, 160)}`,
    cwd ? `cwd: ${clip(cwd, 160)}` : "",
    ...recall.items.map((item) => `- ${item.ref} ${clip(item.text, 180)}`),
  ].filter(Boolean);
  const packet = lines.join("\n");

  return JSON.stringify({
    status: "ok",
    packet,
    item_tokens: recall.item_tokens,
    truncated: recall.truncated,
    items: recall.items,
  });
}

export async function rememberHandler(
  args: {
    text: string;
    kind?: "auto" | "fact" | "event" | "lesson" | "observation" | "task";
    domain?: string;
    sensitivity?: string;
    source?: string;
    allow_ephemeral?: boolean;
    confidence?: number;
    session_id?: string;
    subject?: string;
    predicate?: string;
    object?: string;
  },
  db?: Database.Database,
): Promise<string> {
  const conn = db ?? getDb();
  const text = (args.text ?? "").trim();
  if (!text) {
    return JSON.stringify({ status: "rejected", reason: "empty_text" });
  }

  if (!args.allow_ephemeral && isLikelyEphemeralTaskProgress(text)) {
    return JSON.stringify({
      status: "rejected",
      reason: "likely_ephemeral_task_progress",
    });
  }

  const duplicate = findDuplicate(conn, text);
  if (duplicate) {
    return JSON.stringify({
      status: "duplicate",
      ref: duplicate.ref,
      kind: duplicate.kind,
    });
  }

  const requestedKind = args.kind ?? "auto";
  const kind = requestedKind === "auto" ? classifyMemoryKind(text) : requestedKind;
  const domain = args.domain || "general";
  const sensitivity = args.sensitivity || "";
  const confidence = args.confidence ?? 0.8;

  if (kind === "lesson") {
    const result = JSON.parse(
      await lessonAddHandler(
        {
          domain,
          lesson: stripMemoryPrefix(text),
          confidence,
          sensitivity,
        },
        conn,
      ),
    );
    return JSON.stringify({
      status: "stored",
      kind,
      ref: `lessons:${result.id}`,
      id: result.id,
      classified_by: requestedKind === "auto" ? "auto" : "explicit",
    });
  }

  if (kind === "event") {
    const result = JSON.parse(
      await eventAddHandler(
        {
          event_type: "memory",
          category: domain,
          summary: stripMemoryPrefix(text),
          details: "",
          significance: 5,
          sensitivity,
        },
        conn,
      ),
    );
    return JSON.stringify({
      status: "stored",
      kind,
      ref: `events:${result.id}`,
      id: result.id,
      classified_by: requestedKind === "auto" ? "auto" : "explicit",
    });
  }

  if (kind === "observation") {
    const result = JSON.parse(
      await observationAddHandler(
        {
          category: "session",
          action_type: "memory_note",
          action_summary: stripMemoryPrefix(text),
          context: domain,
          outcome_source: "implicit",
          session_id: args.session_id,
        },
        conn,
      ),
    );
    return JSON.stringify({
      status: "stored",
      kind,
      ref: `observations:${result.id}`,
      id: result.id,
      classified_by: requestedKind === "auto" ? "auto" : "explicit",
    });
  }

  if (kind === "task") {
    const result = JSON.parse(
      await taskCreateHandler(
        {
          title: stripMemoryPrefix(text),
          task_type: "todo",
          context: domain,
          priority: 5,
        },
        conn,
      ),
    );
    return JSON.stringify({
      status: "stored",
      kind,
      ref: `tasks:${result.id}`,
      id: result.id,
      classified_by: requestedKind === "auto" ? "auto" : "explicit",
    });
  }

  const result = JSON.parse(
    await factAddHandler(
      {
        subject_text: args.subject ?? domain,
        predicate: args.predicate ?? "notes",
        object_text: args.object ?? stripMemoryPrefix(text),
        domain,
        confidence,
        source: args.source ?? "hexmem_remember",
        sensitivity,
      },
      conn,
    ),
  );

  return JSON.stringify({
    status: "stored",
    kind: "fact",
    ref: `facts:${result.id}`,
    id: result.id,
    classified_by: requestedKind === "auto" ? "auto" : "explicit",
  });
}

export async function feedbackHandler(
  args: {
    ref: string;
    rating: "helpful" | "wrong" | "stale" | "ignored";
    note?: string;
    session_id?: string;
  },
  db?: Database.Database,
): Promise<string> {
  const conn = db ?? getDb();
  const parsed = parseRef(args.ref);
  let reviewed = false;

  if (parsed && ["facts", "events", "lessons"].includes(parsed.table)) {
    const quality = feedbackQuality(args.rating);
    const reviewResult = JSON.parse(
      await reviewHandler({ table: parsed.table, id: parsed.id, quality }, conn),
    );
    reviewed = !reviewResult.error;
  }

  const observation = JSON.parse(
    await observationAddHandler(
      {
        category: "session",
        action_type: "memory_feedback",
        action_summary: `${args.rating} ${args.ref}`,
        context: args.note,
        outcome: feedbackOutcome(args.rating),
        outcome_details: args.note,
        outcome_source: "explicit",
        session_id: args.session_id,
      },
      conn,
    ),
  );

  return JSON.stringify({
    status: "recorded",
    ref: args.ref,
    rating: args.rating,
    reviewed,
    observation_id: observation.id,
  });
}

export async function workingSetHandler(
  args: {
    action: "get" | "add" | "remove" | "clear";
    session_id?: string;
    item?: string;
    item_type?: string;
    ttl_minutes?: number;
    budget_tokens?: number;
    id?: number;
  },
  db?: Database.Database,
): Promise<string> {
  const conn = db ?? getDb();
  const sessionId = args.session_id || "default";
  const source = workingSetSource(sessionId);
  const budget = cleanBudget(args.budget_tokens, 200);
  cleanupWorkingSet(conn);

  let removed = 0;
  let cleared = 0;

  if (args.action === "add") {
    const item = (args.item ?? "").trim();
    if (!item) {
      return JSON.stringify({ status: "rejected", reason: "empty_item" });
    }
    const ttlMinutes = Math.max(1, Math.floor(args.ttl_minutes ?? 120));
    conn.prepare(
      `INSERT INTO priming_state (item_type, item_name, source, activation_level, expires_at)
       VALUES (?, ?, ?, 1.0, datetime('now', ?))`,
    ).run(args.item_type ?? "memory", item, source, `+${ttlMinutes} minutes`);
  } else if (args.action === "remove") {
    if (args.id !== undefined) {
      const result = conn
        .prepare("DELETE FROM priming_state WHERE source = ? AND id = ?")
        .run(source, args.id);
      removed = result.changes;
    } else if (args.item) {
      const result = conn
        .prepare("DELETE FROM priming_state WHERE source = ? AND item_name = ?")
        .run(source, args.item);
      removed = result.changes;
    }
  } else if (args.action === "clear") {
    const result = conn.prepare("DELETE FROM priming_state WHERE source = ?").run(source);
    cleared = result.changes;
  }

  const rows = conn
    .prepare(
      `SELECT id, item_type, item_name, activation_level, activated_at, expires_at
       FROM priming_state
       WHERE source = ?
       ORDER BY activation_level DESC, activated_at DESC`,
    )
    .all(source) as Array<{
    id: number;
    item_type: string;
    item_name: string;
    activation_level: number;
    activated_at: string;
    expires_at: string;
  }>;

  const items = rows.map((row) => ({
    id: row.id,
    type: row.item_type,
    text: row.item_name,
    activation: round(row.activation_level),
    activated_at: row.activated_at,
    expires_at: row.expires_at,
  }));
  const compacted = budgetItems(items, budget);

  return JSON.stringify({
    status: "ok",
    action: args.action,
    session_id: sessionId,
    removed,
    cleared,
    item_tokens: compacted.item_tokens,
    truncated: compacted.truncated,
    items: compacted.items,
  });
}

export async function lintHandler(
  args: { domains?: string[]; budget_tokens?: number },
  db?: Database.Database,
): Promise<string> {
  const conn = db ?? getDb();
  const domains = (args.domains ?? []).map(normalizeDomain).filter(Boolean);
  const budget = cleanBudget(args.budget_tokens, 700);
  const memories = collectMemories(conn, domains);
  const issues: LintIssue[] = [];

  const seen = new Map<string, string>();
  for (const memory of memories) {
    const key = normalizeMemoryText(memory.text);
    if (!key) continue;
    const prior = seen.get(key);
    if (prior) {
      issues.push({
        code: "duplicate_memory",
        severity: "warning",
        ref: memory.ref,
        text: `near duplicate of ${prior}`,
      });
    } else {
      seen.set(key, memory.ref);
    }

    if (isImperativeMemory(memory.text)) {
      issues.push({
        code: "imperative_memory",
        severity: "info",
        ref: memory.ref,
        text: clip(redactSecrets(memory.text), 120),
      });
    }

    if (isProcedureAsMemory(memory.text)) {
      issues.push({
        code: "procedure_as_memory",
        severity: "info",
        ref: memory.ref,
        text: clip(redactSecrets(memory.text), 120),
      });
    }

    if (approxTokens(memory.text) > 180) {
      issues.push({
        code: "overly_long_memory",
        severity: "warning",
        ref: memory.ref,
        text: `${approxTokens(memory.text)} approx tokens`,
      });
    }

    if (isLikelyEphemeralTaskProgress(memory.text)) {
      issues.push({
        code: "likely_temporary_task_state",
        severity: "warning",
        ref: memory.ref,
        text: clip(redactSecrets(memory.text), 120),
      });
    }

    if (containsPossibleSecret(memory.text)) {
      issues.push({
        code: "possible_secret",
        severity: "error",
        ref: memory.ref,
        text: clip(redactSecrets(memory.text), 120),
      });
    }
  }

  const compacted = budgetItems(issues, budget);
  return JSON.stringify({
    status: "ok",
    issue_count: issues.length,
    item_tokens: compacted.item_tokens,
    truncated: compacted.truncated,
    issues: compacted.items,
  });
}

export async function healthHandler(
  _args: Record<string, never>,
  db?: Database.Database,
): Promise<string> {
  try {
    const raw = JSON.parse(await memoryHealthHandler(db)) as {
      tables: Array<Record<string, unknown>>;
    };
    const tables: Record<string, Record<string, unknown>> = {};
    for (const row of raw.tables ?? []) {
      const table = String(row.table);
      tables[table] = {
        total: row.total ?? 0,
        active: row.active ?? 0,
        fading: row.fading ?? 0,
        compressed: row.compressed ?? 0,
        forgotten: row.forgotten ?? 0,
        long_term: row.long_term ?? 0,
        overdue: row.overdue ?? 0,
        avg_strength: row.avg_strength ?? 0,
      };
    }
    return JSON.stringify({
      status: "ok",
      tables,
    });
  } catch (error) {
    return JSON.stringify({
      status: "degraded",
      error: String(error),
    });
  }
}

export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function cleanBudget(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(16, Math.floor(value ?? fallback));
}

function normalizeSensitivity(value: string | undefined): Sensitivity {
  return value === "public" ? "public" : "private";
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

function extractTerms(parts: string[]): string[] {
  const terms = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(/[A-Za-z0-9_][A-Za-z0-9_-]{1,}/g)) {
      terms.add(match[0]);
    }
  }
  return [...terms].slice(0, 12);
}

function buildFtsQuery(parts: string[]): string {
  const terms = extractTerms(parts);
  return terms.join(" OR ");
}

export function inferDomainsFromCwd(cwd: string): string[] {
  const raw = process.env.HEXMEM_CWD_DOMAIN_MAP;
  if (!cwd || !raw) return [];
  try {
    const configured = JSON.parse(raw) as unknown;
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) return [];
    const lower = cwd.toLowerCase();
    const domains = new Set<string>();
    for (const [pattern, configuredDomains] of Object.entries(configured as Record<string, unknown>)) {
      if (!pattern || !lower.includes(pattern.toLowerCase()) || !Array.isArray(configuredDomains)) continue;
      for (const domain of configuredDomains) {
        if (typeof domain === "string" && domain.trim()) domains.add(domain.trim());
      }
    }
    return [...domains];
  } catch {
    return [];
  }
}

function fallbackDomainResults(
  conn: Database.Database,
  domains: string[],
  sensitivity: Sensitivity,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const domain of domains) {
    const rows = conn
      .prepare(
        `SELECT id, subject_text, predicate, object_text, domain, sensitivity, prompt_form
         FROM facts
         WHERE status = 'active' AND lower(domain) = ?
           AND (? = 'private' OR sensitivity = 'public')
         LIMIT 10`,
      )
      .all(domain, sensitivity) as Record<string, unknown>[];
    for (const row of rows) {
      results.push({ table: "facts", id: row.id as number, content: row });
    }
  }
  return results;
}

export function resultToGatewayItem(result: SearchResult): GatewayItem {
  const row = result.content;
  if (result.table === "facts") {
    return {
      ref: `facts:${result.id}`,
      kind: "fact",
      score: result.score,
      domain: asString(row.domain),
      sensitivity: asString(row.sensitivity),
      text: [row.subject_text, row.predicate, row.object_text].filter(Boolean).join(" "),
      evidence: sourceEvidence(result),
    };
  }
  if (result.table === "events") {
    return {
      ref: `events:${result.id}`,
      kind: "event",
      score: result.score,
      domain: asString(row.category),
      sensitivity: asString(row.sensitivity),
      text: asString(row.summary),
      evidence: sourceEvidence(result),
    };
  }
  if (result.table === "lessons") {
    return {
      ref: `lessons:${result.id}`,
      kind: "lesson",
      score: result.score,
      domain: asString(row.domain),
      sensitivity: asString(row.sensitivity),
      text: asString(row.lesson),
      evidence: sourceEvidence(result),
    };
  }
  return {
    ref: `${result.table}:${result.id}`,
    kind: "seed",
    score: result.score,
    domain: asString(row.seed_type),
    text: asString(row.seed_text),
    evidence: sourceEvidence(result),
  };
}

function sourceEvidence(result: SearchResult): Record<string, unknown> {
  const promptForm = result.content.prompt_form;
  return {
    table: result.table,
    id: result.id,
    prompt_form: typeof promptForm === "string" ? promptForm : undefined,
  };
}

export function compactItem(item: GatewayItem, includeEvidence: boolean): GatewayItem {
  const compacted: GatewayItem = {
    ref: item.ref,
    kind: item.kind,
    domain: item.domain,
    text: clip(item.text, 220),
    sensitivity: item.sensitivity,
  };
  if (includeEvidence && item.evidence) {
    compacted.evidence = item.evidence;
  }
  return compacted;
}

export function budgetItems<T>(
  items: T[],
  budget: number,
): { items: T[]; item_tokens: number; truncated: boolean } {
  const selected: T[] = [];
  let itemTokens = 0;

  for (const item of items) {
    const tokens = budgetTokenEstimate(item);
    if (selected.length > 0 && itemTokens + tokens > budget) {
      return { items: selected, item_tokens: itemTokens, truncated: true };
    }
    if (selected.length === 0 || itemTokens + tokens <= budget) {
      selected.push(item);
      itemTokens += tokens;
    }
  }

  return { items: selected, item_tokens: itemTokens, truncated: false };
}

function budgetTokenEstimate(item: unknown): number {
  if (
    typeof item === "object" &&
    item !== null &&
    "text" in item &&
    typeof (item as { text?: unknown }).text === "string"
  ) {
    return approxTokens((item as { text: string }).text);
  }
  return approxTokens(JSON.stringify(item));
}

function scoreItem(item: GatewayItem, queryTerms: string[], domains: string[]): number {
  const text = `${item.text} ${item.domain ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (text.includes(term)) score += 1;
  }
  if (item.domain && domains.includes(normalizeDomain(item.domain))) score += 2;
  return score;
}

function classifyMemoryKind(text: string): "fact" | "event" | "lesson" | "observation" | "task" {
  const stripped = stripMemoryPrefix(text);
  const lower = stripped.toLowerCase();

  if (/^(lesson|prefer|avoid|always|never|when|if)\b/.test(lower)) return "lesson";
  if (/^(task|todo|reminder|follow up)\b/.test(lower)) return "task";
  if (/^(observed|observation|feedback|selected tool)\b/.test(lower)) return "observation";
  if (/^(released|completed|decided|created|deployed|migrated|fixed)\b/.test(lower)) return "event";
  if (/\b(happened|occurred|milestone)\b/.test(lower)) return "event";
  return "fact";
}

function stripMemoryPrefix(text: string): string {
  return text.replace(/^\s*(lesson|fact|event|task|todo|observation)\s*:\s*/i, "").trim();
}

function isLikelyEphemeralTaskProgress(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    /\bcurrently\b/,
    /\bin progress\b/,
    /\bworking on\b/,
    /\bediting\b/,
    /\bnext step\b/,
    /\bthis session\b/,
    /\bjust ran\b/,
    /\btemporary progress\b/,
    /\bbefore implementing\b/,
  ].some((pattern) => pattern.test(lower));
}

function findDuplicate(conn: Database.Database, text: string): { ref: string; kind: string } | null {
  const wanted = normalizeMemoryText(stripMemoryPrefix(text));
  if (!wanted) return null;

  for (const memory of collectMemories(conn, [])) {
    if (normalizeMemoryText(memory.text) === wanted) {
      return { ref: memory.ref, kind: memory.kind };
    }
  }
  return null;
}

function collectMemories(
  conn: Database.Database,
  domains: string[],
): Array<{ ref: string; kind: string; domain: string; text: string }> {
  const domainSet = new Set(domains);
  const memories: Array<{ ref: string; kind: string; domain: string; text: string }> = [];

  const facts = conn
    .prepare(
      `SELECT id, subject_text, predicate, object_text, domain
       FROM facts
       WHERE status = 'active'`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of facts) {
    const domain = asString(row.domain);
    if (domainSet.size > 0 && !domainSet.has(normalizeDomain(domain))) continue;
    memories.push({
      ref: `facts:${row.id}`,
      kind: "fact",
      domain,
      text: [row.subject_text, row.predicate, row.object_text].filter(Boolean).join(" "),
    });
  }

  const events = conn
    .prepare("SELECT id, category, summary, details FROM events")
    .all() as Array<Record<string, unknown>>;
  for (const row of events) {
    const domain = asString(row.category);
    if (domainSet.size > 0 && !domainSet.has(normalizeDomain(domain))) continue;
    memories.push({
      ref: `events:${row.id}`,
      kind: "event",
      domain,
      text: [row.summary, row.details].filter(Boolean).join(" "),
    });
  }

  const lessons = conn
    .prepare(
      `SELECT id, domain, lesson, context
       FROM lessons
       WHERE (valid_until IS NULL OR valid_until > datetime('now'))
         AND superseded_by IS NULL`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of lessons) {
    const domain = asString(row.domain);
    if (domainSet.size > 0 && !domainSet.has(normalizeDomain(domain))) continue;
    memories.push({
      ref: `lessons:${row.id}`,
      kind: "lesson",
      domain,
      text: [row.lesson, row.context].filter(Boolean).join(" "),
    });
  }

  const tasks = conn
    .prepare("SELECT id, context, title, description FROM tasks WHERE status != 'completed'")
    .all() as Array<Record<string, unknown>>;
  for (const row of tasks) {
    const domain = asString(row.context);
    if (domainSet.size > 0 && !domainSet.has(normalizeDomain(domain))) continue;
    memories.push({
      ref: `tasks:${row.id}`,
      kind: "task",
      domain,
      text: [row.title, row.description].filter(Boolean).join(" "),
    });
  }

  return memories;
}

function normalizeMemoryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|to|of|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function feedbackQuality(rating: "helpful" | "wrong" | "stale" | "ignored"): number {
  if (rating === "helpful") return 5;
  if (rating === "wrong") return 1;
  if (rating === "stale") return 2;
  return 3;
}

function feedbackOutcome(
  rating: "helpful" | "wrong" | "stale" | "ignored",
): "adopted" | "ignored" | "corrected" | "partial" {
  if (rating === "helpful") return "adopted";
  if (rating === "wrong") return "corrected";
  if (rating === "stale") return "partial";
  return "ignored";
}

function parseRef(ref: string): { table: string; id: number } | null {
  const match = /^([a-z_]+):(\d+)$/.exec(ref);
  if (!match) return null;
  return { table: match[1], id: Number(match[2]) };
}

function workingSetSource(sessionId: string): string {
  return `working_set:${sessionId}`;
}

function cleanupWorkingSet(conn: Database.Database): void {
  conn.prepare("DELETE FROM priming_state WHERE source LIKE 'working_set:%' AND expires_at < datetime('now')").run();
}

function isImperativeMemory(text: string): boolean {
  return /^(run|use|do|don't|avoid|prefer|remember|check|verify|ensure|keep)\b/i.test(text.trim());
}

function isProcedureAsMemory(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(step \d+|first,|then,|next,|finally,|procedure|workflow)\b/.test(lower);
}

function containsPossibleSecret(text: string): boolean {
  return [
    /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/,
    /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*\S{8,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  ].some((pattern) => pattern.test(text));
}

function redactSecrets(text: string): string {
  return text
    .replace(/\bsk_(live|test)_[A-Za-z0-9]{8,}\b/g, "sk_$1_[REDACTED]")
    .replace(/\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
