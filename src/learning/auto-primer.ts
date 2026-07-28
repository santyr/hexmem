import type Database from "better-sqlite3";

export interface PrimingRecommendation {
  item_type: string;        // 'domain' | 'concept' | 'lesson'
  item_name: string;
  source: string;
  ttl_minutes: number;
  activation_level: number; // 0.0–1.0
}

export interface CwdDomainMapping {
  pattern: RegExp;
  domains: string[];
}

/**
 * Compute priming recommendations based on current context.
 * Layers: caller-configured CWD domains, active tasks, recent observations,
 * and degraded lessons. CWD mappings are deliberately opt-in so deployments
 * do not inherit provider- or operator-specific defaults.
 */
export function computePrimingRecommendations(
  db: Database.Database,
  cwd: string,
  cwdDomainMappings: readonly CwdDomainMapping[] = [],
): PrimingRecommendation[] {
  const seen = new Map<string, PrimingRecommendation>();

  function add(rec: PrimingRecommendation) {
    const key = `${rec.item_type}:${rec.item_name}`;
    const existing = seen.get(key);
    // Keep the higher activation level if duplicate
    if (!existing || existing.activation_level < rec.activation_level) {
      seen.set(key, rec);
    }
  }

  // Layer 1: caller-configured CWD domain detection (activation 0.8)
  for (const { pattern, domains } of cwdDomainMappings) {
    if (pattern.test(cwd)) {
      for (const domain of domains) {
        add({
          item_type: "domain",
          item_name: domain,
          source: `cwd:${cwd}`,
          ttl_minutes: 120,
          activation_level: 0.8,
        });
      }
    }
  }

  // Layer 2: Active task domains (activation 0.7)
  try {
    const tasks = db
      .prepare(
        "SELECT id, title, description, context FROM tasks WHERE status = 'in_progress' LIMIT 5"
      )
      .all() as Array<{ id: number; title: string; description: string | null; context: string | null }>;

    for (const task of tasks) {
      const text = `${task.title} ${task.description ?? ""} ${task.context ?? ""}`;
      const domains = extractDomainKeywords(db, text);
      for (const domain of domains) {
        add({
          item_type: "domain",
          item_name: domain,
          source: `task:${task.id}`,
          ttl_minutes: 120,
          activation_level: 0.7,
        });
      }
    }
  } catch { /* tasks table may not exist */ }

  // Layer 3: Recent unresolved observations (activation 0.5)
  try {
    const observations = db
      .prepare(
        `SELECT category, action_summary FROM observations
         WHERE resolved_at IS NULL
           AND created_at > datetime('now', '-3 days')
         ORDER BY created_at DESC LIMIT 5`
      )
      .all() as Array<{ category: string; action_summary: string }>;

    const categoryDomainMap: Record<string, string[]> = {
      debugging: ["technical", "debugging"],
      architecture: ["project", "technical"],
      routing: ["routing", "operations"],
      session: ["project"],
    };

    for (const obs of observations) {
      const domains = categoryDomainMap[obs.category] ?? [];
      for (const domain of domains) {
        add({
          item_type: "domain",
          item_name: domain,
          source: `observation:${obs.category}`,
          ttl_minutes: 60,
          activation_level: 0.5,
        });
      }
    }
  } catch { /* observations table may not exist */ }

  // Layer 4: Degraded lessons — surface their domains as warnings (activation 0.3)
  try {
    const degraded = db
      .prepare(
        `SELECT domain FROM lessons
         WHERE alpha IS NOT NULL AND beta_param IS NOT NULL
           AND CAST(alpha AS REAL) / (alpha + beta_param) < 0.3
           AND (alpha + beta_param) > 3
           AND superseded_by IS NULL
         LIMIT 5`
      )
      .all() as Array<{ domain: string }>;

    for (const lesson of degraded) {
      add({
        item_type: "domain",
        item_name: lesson.domain,
        source: "degraded-lesson",
        ttl_minutes: 60,
        activation_level: 0.3,
      });
    }
  } catch { /* lessons table may not have posterior columns */ }

  return [...seen.values()].sort((a, b) => b.activation_level - a.activation_level);
}

/**
 * Extract domain keywords from text by matching against known domains in the DB.
 */
function extractDomainKeywords(db: Database.Database, text: string): string[] {
  const words = new Set(
    text.toLowerCase().split(/\s+/).filter((w) => w.length >= 4)
  );

  // Get known domains from facts and lessons tables
  try {
    const domains = db
      .prepare(
        `SELECT DISTINCT domain FROM (
           SELECT domain FROM facts WHERE domain IS NOT NULL
           UNION
           SELECT domain FROM lessons WHERE domain IS NOT NULL
         ) ORDER BY domain`
      )
      .all() as Array<{ domain: string }>;

    return domains
      .filter((d) => {
        const domainLower = d.domain.toLowerCase();
        // Direct match: domain name appears in text
        return words.has(domainLower) || text.toLowerCase().includes(domainLower);
      })
      .map((d) => d.domain);
  } catch {
    return [];
  }
}
