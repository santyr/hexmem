import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";

const EntitiesInputSchema = {
  search: z.string().optional().describe("Filter by name or canonical_name (LIKE match)"),
  limit: z.number().default(20).describe("Max results"),
};

const EntityAddInputSchema = {
  name: z.string().describe("Entity display name"),
  entity_type: z.string().describe("Type: person, ai_agent, organization, project, concept, channel, system"),
  description: z.string().optional().describe("Brief description"),
  nature: z.string().optional().describe("For people/agents: human, ai, hybrid, bot, unknown"),
  platform_id: z.string().optional().describe("Primary platform identifier (e.g. platform user ID) — auto-creates alias"),
  platform: z.string().optional().describe("Platform for platform_id (slack, nostr, discord, etc.)"),
};

const EntityAliasAddInputSchema = {
  entity_id: z.number().describe("Entity ID to add alias to"),
  alias: z.string().describe("The alias value (e.g. platform user ID, handle, email, nickname)"),
  alias_type: z.string().default("name").describe("Type: name, handle, slack, nostr, did, email, etc."),
};

const EntityLinkInputSchema = {
  from_entity_id: z.number().describe("Source entity ID"),
  to_entity_id: z.number().describe("Target entity ID"),
  relationship_type: z.string().describe("Type of relationship (e.g. owns, knows, part_of, friend_of)"),
  strength: z.number().default(1.0).describe("Relationship strength 0.0-1.0"),
};

export function register(server: McpServer): void {
  server.registerTool(
    "hexmem_entities",
    {
      description: "List or search entities in the knowledge graph",
      inputSchema: EntitiesInputSchema,
    },
    async (args) => {
      const result = await entitiesHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_entity_add",
    {
      description: "Add a new entity to the knowledge graph",
      inputSchema: EntityAddInputSchema,
    },
    async (args) => {
      const result = await entityAddHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_entity_alias_add",
    {
      description: "Add a platform alias to an entity (platform user ID, handle, email, etc.)",
      inputSchema: EntityAliasAddInputSchema,
    },
    async (args) => {
      const result = await entityAliasAddHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "hexmem_entity_link",
    {
      description: "Create a directed relationship between two entities",
      inputSchema: EntityLinkInputSchema,
    },
    async (args) => {
      const result = await entityLinkHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

export async function entitiesHandler(
  args: { search?: string; limit?: number },
  db?: Database.Database
): Promise<string> {
  const { search, limit = 20 } = args;
  const conn = db ?? getDb();

  let entityRows: Record<string, unknown>[];

  if (search) {
    const pat = `%${search}%`;
    // Search entities AND aliases
    entityRows = conn
      .prepare(
        `SELECT DISTINCT e.id, e.entity_type, e.name, e.canonical_name, e.description, e.metadata,
                e.first_seen_at, e.last_seen_at
         FROM entities e
         LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
         WHERE e.name LIKE ? OR e.canonical_name LIKE ? OR ea.alias LIKE ?
         ORDER BY e.last_seen_at DESC LIMIT ?`
      )
      .all(pat, pat, pat, limit) as Record<string, unknown>[];
  } else {
    entityRows = conn
      .prepare(
        `SELECT id, entity_type, name, canonical_name, description, metadata,
                first_seen_at, last_seen_at
         FROM entities ORDER BY last_seen_at DESC LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];
  }

  // Enrich with aliases and relationships
  const result = entityRows.map((e) => {
    const id = e["id"] as number;

    const aliases = conn
      .prepare("SELECT alias, alias_type FROM entity_aliases WHERE entity_id = ?")
      .all(id) as { alias: string; alias_type: string }[];

    const rels = conn
      .prepare(
        `SELECT r.relationship_type, r.strength, e2.name as target_name
         FROM relationships r JOIN entities e2 ON e2.id = r.to_entity_id
         WHERE r.from_entity_id = ?
         UNION ALL
         SELECT r.relationship_type, r.strength, e2.name as target_name
         FROM relationships r JOIN entities e2 ON e2.id = r.from_entity_id
         WHERE r.to_entity_id = ?`
      )
      .all(id, id) as { relationship_type: string; strength: number; target_name: string }[];

    return {
      ...e,
      metadata: e["metadata"] ? JSON.parse(e["metadata"] as string) : null,
      aliases: aliases.length > 0 ? aliases : undefined,
      relationships: rels.length > 0 ? rels : undefined,
    };
  });

  return JSON.stringify(result, null, 2);
}

export async function entityAddHandler(
  args: {
    name: string;
    entity_type: string;
    description?: string;
    nature?: string;
    platform_id?: string;
    platform?: string;
  },
  db?: Database.Database
): Promise<string> {
  const { name, entity_type, description, nature, platform_id, platform } = args;
  const conn = db ?? getDb();

  const canonical_name = name.toLowerCase();
  const metadata = nature ? JSON.stringify({ nature }) : null;

  // Upsert: if entity already exists, update last_seen_at
  const existing = conn
    .prepare("SELECT id FROM entities WHERE entity_type = ? AND canonical_name = ?")
    .get(entity_type, canonical_name) as { id: number } | undefined;

  let entityId: number;

  if (existing) {
    conn.prepare("UPDATE entities SET last_seen_at = datetime('now'), description = COALESCE(?, description), metadata = COALESCE(?, metadata) WHERE id = ?")
      .run(description ?? null, metadata, existing.id);
    entityId = existing.id;
  } else {
    const cur = conn
      .prepare("INSERT INTO entities (name, canonical_name, entity_type, description, metadata) VALUES (?, ?, ?, ?, ?)")
      .run(name, canonical_name, entity_type, description ?? null, metadata);
    entityId = cur.lastInsertRowid as number;
  }

  // Auto-create platform alias if provided
  if (platform_id && platform) {
    conn.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, ?, ?)")
      .run(entityId, `${platform}:${platform_id}`, platform);
    // Also store the raw ID as an alias for flexible matching
    conn.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, ?, ?)")
      .run(entityId, platform_id, platform);
  }

  return JSON.stringify({ id: entityId, status: existing ? "updated" : "created" });
}

export async function entityAliasAddHandler(
  args: { entity_id: number; alias: string; alias_type?: string },
  db?: Database.Database
): Promise<string> {
  const { entity_id, alias, alias_type = "name" } = args;
  const conn = db ?? getDb();

  conn.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, ?, ?)")
    .run(entity_id, alias, alias_type);

  return JSON.stringify({ entity_id, alias, status: "created" });
}

export async function entityLinkHandler(
  args: {
    from_entity_id: number;
    to_entity_id: number;
    relationship_type: string;
    strength?: number;
  },
  db?: Database.Database
): Promise<string> {
  const { from_entity_id, to_entity_id, relationship_type, strength = 1.0 } = args;
  const conn = db ?? getDb();

  const cur = conn
    .prepare(
      "INSERT INTO relationships (from_entity_id, to_entity_id, relationship_type, strength) " +
        "VALUES (?, ?, ?, ?)"
    )
    .run(from_entity_id, to_entity_id, relationship_type, strength);

  return JSON.stringify({ id: cur.lastInsertRowid, status: "created" });
}
