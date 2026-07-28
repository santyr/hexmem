import type Database from "better-sqlite3";

interface ConsolidateRow {
  id: number;
  domain: string | null;
  category?: string | null;
  created_at: string | null;
  occurred_at?: string | null;
  prompt_form: string | null;
  memory_strength?: number | null;
}

interface BuiltSeed {
  text: string;
  anchors: string[];
  originalTokens: number;
  seedTokens: number;
}

/**
 * Extractive seed: keep the STRONGEST members' prompt_forms verbatim until
 * the budget runs out, and record how much was elided — instead of blindly
 * truncating the concatenation at 500 chars (which kept whatever happened
 * to sort first and silently dropped the rest).
 */
function buildSeed(domain: string, rows: ConsolidateRow[], table: string): BuiltSeed {
  const header = `[${table}:${domain || "general"}]`;
  const ranked = [...rows].sort(
    (a, b) => (b.memory_strength ?? 1) - (a.memory_strength ?? 1),
  );
  const prompts = [...new Set(ranked.map((r) => r.prompt_form).filter(Boolean))] as string[];
  const originalChars = prompts.reduce((sum, p) => sum + p.length, 0);

  const kept: string[] = [];
  let used = header.length;
  for (const prompt of prompts) {
    if (used + prompt.length + 2 > 600) break;
    kept.push(prompt);
    used += prompt.length + 2;
  }
  const elided = prompts.length - kept.length;
  const body = kept.join("; ") + (elided > 0 ? ` (+${elided} weaker items elided)` : "");

  return {
    text: `${header} ${body}`,
    anchors: kept.slice(0, 3),
    originalTokens: Math.ceil(originalChars / 4),
    seedTokens: Math.ceil((header.length + body.length) / 4),
  };
}

function groupByDomain30Day(
  rows: ConsolidateRow[],
  dateCol: keyof ConsolidateRow,
  domainField: keyof ConsolidateRow,
): Map<string, ConsolidateRow[]> {
  // Key: domain + bucket (30-day window by epoch/30d)
  const groups = new Map<string, ConsolidateRow[]>();

  for (const row of rows) {
    const domain = (row[domainField] as string | null) ?? "general";
    const dateStr = (row[dateCol] as string | null | undefined) ?? row.created_at ?? null;
    const ts = dateStr ? new Date(dateStr).getTime() : 0;
    const bucket = Math.floor(ts / (30 * 86400 * 1000));
    const key = `${domain}:::${bucket}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return groups;
}

interface TableConfig {
  name: string;
  dateCol: string;
  domainField: string;
  extraWhere: string;
  domainFilter: (domain: string) => string;
}

export function consolidate(
  db: Database.Database,
  domain: string,
  dryRun: boolean,
  minGroupSize: number,
): string {
  const tableConfigs: TableConfig[] = [
    {
      name: "facts",
      dateCol: "created_at",
      domainField: "domain",
      extraWhere: "AND status = 'active'",
      domainFilter: (d) => d ? "AND domain = ?" : "",
    },
    {
      name: "events",
      dateCol: "occurred_at",
      domainField: "category",
      extraWhere: "",
      domainFilter: (d) => d ? "AND category = ?" : "",
    },
    {
      name: "lessons",
      dateCol: "created_at",
      domainField: "domain",
      extraWhere: "AND (valid_until IS NULL OR valid_until > datetime('now')) AND superseded_by IS NULL",
      domainFilter: (d) => d ? "AND domain = ?" : "",
    },
  ];

  let totalSeeds = 0;
  const dryRunGroups: Array<Record<string, unknown>> = [];

  for (const { name, dateCol, domainField, extraWhere, domainFilter } of tableConfigs) {
    const domainWhere = domainFilter(domain);
    const params: unknown[] = domain ? [domain] : [];

    const selectDateCol = name === "events" ? "occurred_at, created_at, category" : "created_at, domain";

    const sql = `
      SELECT id, ${selectDateCol}, prompt_form, memory_strength
      FROM ${name}
      WHERE consolidation_state IN ('fading', 'compressed')
      ${extraWhere}
      ${domainWhere}
    `;

    const rows = db.prepare(sql).all(...params) as ConsolidateRow[];

    if (rows.length === 0) continue;

    const groups = groupByDomain30Day(
      rows,
      dateCol as keyof ConsolidateRow,
      domainField as keyof ConsolidateRow,
    );

    for (const [groupKey, groupRows] of groups) {
      if (groupRows.length < minGroupSize) continue;

      const [groupDomain] = groupKey.split(":::");
      const prompts = groupRows.map((r) => r.prompt_form ?? `${groupDomain}:item`).filter(Boolean);

      if (dryRun) {
        dryRunGroups.push({
          table: name,
          domain: groupDomain,
          count: groupRows.length,
          sample_prompts: prompts.slice(0, 3),
        });
        continue;
      }

      // Build seed text
      const seed = buildSeed(groupDomain, groupRows, name);
      const sourceIds = JSON.stringify(groupRows.map((r) => r.id));

      // Insert into memory_seeds with compression metadata + verbatim anchors
      const seedResult = db.prepare(
        `INSERT INTO memory_seeds (seed_type, seed_text, source_table, source_ids,
                                   anchor_facts, original_token_estimate,
                                   seed_token_estimate, compression_ratio)
         VALUES ('consolidation', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        seed.text,
        name,
        sourceIds,
        JSON.stringify(seed.anchors),
        seed.originalTokens,
        seed.seedTokens,
        seed.seedTokens > 0 ? Math.round((seed.originalTokens / seed.seedTokens) * 100) / 100 : null,
      );

      const seedId = seedResult.lastInsertRowid as number;

      // Update source records
      const ph = groupRows.map(() => "?").join(",");
      db.prepare(
        `UPDATE ${name} SET consolidation_state = 'long_term', compressed_to_seed_id = ? WHERE id IN (${ph})`
      ).run(seedId, ...groupRows.map((r) => r.id));

      totalSeeds++;
    }
  }

  if (dryRun) {
    return JSON.stringify({
      dry_run: true,
      candidates_found: dryRunGroups.reduce((sum, g) => sum + (g["count"] as number), 0),
      groups: dryRunGroups,
    });
  }

  return JSON.stringify({
    dry_run: false,
    seeds_created: totalSeeds,
  });
}
