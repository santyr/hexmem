import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_identity",
    { description: "Read the agent's identity attributes and identity seeds" },
    async () => {
      const result = await identityHandler();
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_values",
    { description: "Read core values ordered by priority" },
    async () => {
      const result = await valuesHandler();
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_self_schemas",
    { description: "Read self-schemas and autobiographical knowledge" },
    async () => {
      const result = await selfSchemasHandler();
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function identityHandler(): Promise<string> {
  const db = getDb();

  const rows = db.prepare("SELECT attribute, value FROM identity").all() as Array<{
    attribute: string;
    value: string;
  }>;
  const identity: Record<string, string> = {};
  for (const r of rows) {
    identity[r.attribute] = r.value;
  }

  const seeds = db
    .prepare(
      "SELECT seed_category, seed_name, seed_text, centrality, load_order " +
      "FROM identity_seeds ORDER BY load_order"
    )
    .all() as Array<{
      seed_category: string;
      seed_name: string;
      seed_text: string;
      centrality: number;
      load_order: number;
    }>;

  const seedList = seeds.map((s) => ({
    category: s.seed_category,
    name: s.seed_name,
    text: s.seed_text,
    centrality: s.centrality,
  }));

  return JSON.stringify({ identity, seeds: seedList }, null, 2);
}

export async function valuesHandler(): Promise<string> {
  const db = getDb();

  const rows = db
    .prepare(
      "SELECT id, name, description, priority, source, prompt_form " +
      "FROM core_values " +
      "WHERE (valid_until IS NULL OR valid_until > datetime('now')) " +
      "AND superseded_by IS NULL " +
      "ORDER BY priority DESC"
    )
    .all();

  return JSON.stringify(rows, null, 2);
}

export async function selfSchemasHandler(): Promise<string> {
  const db = getDb();

  const schemas = db
    .prepare(
      "SELECT domain, schema_name, description, strength, is_aspirational " +
      "FROM self_schemas ORDER BY strength DESC"
    )
    .all();

  let autoK: unknown[] = [];
  try {
    autoK = db
      .prepare(
        "SELECT category, knowledge, stability " +
        "FROM autobiographical_knowledge ORDER BY stability DESC"
      )
      .all();
  } catch {
    // Table may not exist — treat as empty
    autoK = [];
  }

  return JSON.stringify(
    { self_schemas: schemas, autobiographical_knowledge: autoK },
    null,
    2
  );
}
