import type Database from "better-sqlite3";

export interface DecaySweepResult {
  dry_run: boolean;
  scanned: number;
  transitions: {
    fading: number;
    compressed: number;
    forgotten: number;
  };
  protected_by_salience: number;
  protected_by_curation: number;
}

/**
 * Deliberately curated fact sources never rot past 'fading' — the audit
 * found source='critical' facts and operating principles in 'forgotten'
 * purely because retrieval had never surfaced them.
 */
const CURATED_SOURCES = new Set(["direct", "critical", "important"]);

export function effectiveStrength(
  memoryStrength: number,
  emotionalValence: number,
  emotionalArousal: number,
  accessCount: number,
): number {
  const base = Math.max(memoryStrength || 1.0, 0.1);
  const emotionalBoost = 1.0 + (Math.abs(emotionalValence || 0) + (emotionalArousal || 0)) * 0.5;
  const frequencyBoost = 1.0 + Math.log2(1 + (accessCount || 0)) * 0.2;
  return base * emotionalBoost * frequencyBoost;
}

function daysSince(dtStr: string | null): number {
  if (!dtStr) return 365.0;
  try {
    const dt = new Date(dtStr);
    return Math.max((Date.now() - dt.getTime()) / 86400000, 0.001);
  } catch {
    return 365.0;
  }
}

const STATE_RANK: Record<string, number> = {
  active: 0,
  fading: 1,
  compressed: 2,
  forgotten: 3,
  long_term: -1, // never decay
  working: -1,   // events default state — never decay
};

function retentionToState(r: number): string {
  if (r >= 0.5) return "active";
  if (r >= 0.2) return "fading";
  if (r >= 0.05) return "compressed";
  return "forgotten";
}

interface DecayRow {
  id: number;
  memory_strength: number | null;
  emotional_valence: number | null;
  emotional_arousal: number | null;
  access_count: number | null;
  consolidation_state: string;
  last_accessed_at: string | null;
  created_at: string | null;
  occurred_at?: string | null;
  source?: string | null;
}

export function decaySweep(db: Database.Database, dryRun: boolean): DecaySweepResult {
  const result: DecaySweepResult = {
    dry_run: dryRun,
    scanned: 0,
    transitions: { fading: 0, compressed: 0, forgotten: 0 },
    protected_by_salience: 0,
    protected_by_curation: 0,
  };

  const tables: Array<{
    name: string;
    extraWhere: string;
    dateCol: string;
  }> = [
    {
      name: "facts",
      extraWhere: "AND status = 'active'",
      dateCol: "last_accessed_at",
    },
    {
      name: "events",
      extraWhere: "",
      dateCol: "occurred_at",
    },
    {
      name: "lessons",
      extraWhere: "AND (valid_until IS NULL OR valid_until > datetime('now')) AND superseded_by IS NULL",
      dateCol: "last_accessed_at",
    },
  ];

  for (const { name, extraWhere, dateCol } of tables) {
    const sql = `
      SELECT id, memory_strength, emotional_valence, emotional_arousal,
             access_count, consolidation_state,
             last_accessed_at, created_at${name === "events" ? ", occurred_at" : ""}${name === "facts" ? ", source" : ""}
      FROM ${name}
      WHERE consolidation_state IN ('active','fading','compressed')
      ${extraWhere}
    `;

    const rows = db.prepare(sql).all() as DecayRow[];

    for (const row of rows) {
      result.scanned++;

      const currentRank = STATE_RANK[row.consolidation_state] ?? 0;
      if (currentRank < 0) continue; // long_term / working — skip

      // Determine reference date
      const refDate =
        name === "events"
          ? (row.occurred_at ?? row.last_accessed_at ?? row.created_at ?? null)
          : (row.last_accessed_at ?? row.created_at ?? null);

      const t = daysSince(refDate);
      const sEff = effectiveStrength(
        row.memory_strength ?? 1.0,
        row.emotional_valence ?? 0,
        row.emotional_arousal ?? 0,
        row.access_count ?? 0,
      );

      const R = Math.exp(-t / sEff);
      let targetState = retentionToState(R);

      // Salience protection: if moving to compressed/forgotten AND high emotional salience → skip
      const salience = Math.abs(row.emotional_valence ?? 0) + (row.emotional_arousal ?? 0);
      if ((targetState === "compressed" || targetState === "forgotten") && salience > 1.2) {
        if ((STATE_RANK[targetState] ?? 0) > currentRank) result.protected_by_salience++;
        continue;
      }

      // Curation floor: lessons and deliberately-sourced facts stop at fading
      const curated =
        name === "lessons" ||
        (name === "facts" && CURATED_SOURCES.has(String(row.source ?? "")));
      if (curated && (targetState === "compressed" || targetState === "forgotten")) {
        targetState = "fading";
        result.protected_by_curation++;
      }

      const targetRank = STATE_RANK[targetState] ?? 0;

      // Only allow downward transitions
      if (targetRank <= currentRank) continue;

      // Record transition
      if (targetState === "fading") result.transitions.fading++;
      else if (targetState === "compressed") result.transitions.compressed++;
      else if (targetState === "forgotten") result.transitions.forgotten++;

      if (!dryRun) {
        db.prepare(
          `UPDATE ${name} SET consolidation_state = ?, retention_estimate = ? WHERE id = ?`
        ).run(targetState, R, row.id);
      }
    }
  }

  return result;
}

export function memoryHealth(db: Database.Database): string {
  // Health reports the LIVE corpus: superseded/decayed facts and retired
  // lessons are lifecycle history, not memory state (pre-fix this
  // over-reported forgotten by ~13× after the junk quarantine).
  const tables: Array<{ name: string; where: string }> = [
    { name: "facts", where: "WHERE status = 'active'" },
    { name: "events", where: "" },
    {
      name: "lessons",
      where:
        "WHERE superseded_by IS NULL AND (valid_until IS NULL OR valid_until > datetime('now'))",
    },
  ];
  const rows: Array<Record<string, unknown>> = [];

  for (const { name: table, where } of tables) {
    const statsRow = db.prepare(`
      SELECT
        COUNT(*) as total,
        AVG(COALESCE(memory_strength, 1.0)) as avg_strength,
        SUM(CASE WHEN consolidation_state = 'active' THEN 1 ELSE 0 END) as active_count,
        SUM(CASE WHEN consolidation_state = 'fading' THEN 1 ELSE 0 END) as fading_count,
        SUM(CASE WHEN consolidation_state = 'compressed' THEN 1 ELSE 0 END) as compressed_count,
        SUM(CASE WHEN consolidation_state = 'forgotten' THEN 1 ELSE 0 END) as forgotten_count,
        SUM(CASE WHEN consolidation_state = 'long_term' THEN 1 ELSE 0 END) as long_term_count,
        SUM(CASE WHEN next_review_at IS NOT NULL AND next_review_at <= datetime('now') THEN 1 ELSE 0 END) as overdue
      FROM ${table} ${where}
    `).get() as Record<string, unknown>;

    rows.push({
      table,
      total: statsRow["total"],
      avg_strength: statsRow["avg_strength"] !== null
        ? Math.round((statsRow["avg_strength"] as number) * 1000) / 1000
        : 0,
      active: statsRow["active_count"],
      fading: statsRow["fading_count"],
      compressed: statsRow["compressed_count"],
      forgotten: statsRow["forgotten_count"],
      long_term: statsRow["long_term_count"],
      overdue: statsRow["overdue"],
    });
  }

  return JSON.stringify({ tables: rows });
}
