import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./helpers.ts";

test("identity handlers read configured identity values and self schemas", async () => {
  const { db, path } = createTestDb();
  db.prepare("INSERT INTO identity (attribute, value) VALUES (?, ?)").run("agent_name", "AgentExample");
  db.prepare("INSERT INTO identity (attribute, value) VALUES (?, ?)").run("vibe", "precise");
  db.prepare("INSERT INTO identity_seeds (seed_category, seed_name, seed_text, centrality, load_order) VALUES (?, ?, ?, ?, ?)")
    .run("core", "second", "Loads second", 0.5, 20);
  db.prepare("INSERT INTO identity_seeds (seed_category, seed_name, seed_text, centrality, load_order) VALUES (?, ?, ?, ?, ?)")
    .run("core", "first", "Loads first", 0.9, 10);
  db.prepare("INSERT INTO core_values (name, description, priority, source, prompt_form) VALUES (?, ?, ?, ?, ?)")
    .run("Rigor", "Prefer verified behavior", 90, "test", "rigor");
  db.prepare("INSERT INTO core_values (name, description, priority, source, prompt_form) VALUES (?, ?, ?, ?, ?)")
    .run("Clarity", "Make state explicit", 70, "test", "clarity");
  db.prepare("INSERT INTO self_schemas (domain, schema_name, description, strength, is_aspirational) VALUES (?, ?, ?, ?, ?)")
    .run("engineering", "debugger", "Traces root causes", 0.8, 0);
  db.prepare("INSERT INTO self_schemas (domain, schema_name, description, strength, is_aspirational) VALUES (?, ?, ?, ?, ?)")
    .run("engineering", "planner", "Keeps track of work", 0.6, 1);

  const previousHexmemDb = process.env.HEXMEM_DB;
  process.env.HEXMEM_DB = path;
  const identityTools = await import("../src/tools/identity.ts");
  const dbTools = await import("../src/db.ts");

  try {
    const identity = JSON.parse(await identityTools.identityHandler());
    assert.deepEqual(identity.identity, { agent_name: "AgentExample", vibe: "precise" });
    assert.deepEqual(identity.seeds.map((seed: Record<string, unknown>) => seed.name), ["first", "second"]);

    const values = JSON.parse(await identityTools.valuesHandler());
    assert.deepEqual(values.map((value: Record<string, unknown>) => value.name), ["Rigor", "Clarity"]);

    const schemas = JSON.parse(await identityTools.selfSchemasHandler());
    assert.deepEqual(schemas.self_schemas.map((schema: Record<string, unknown>) => schema.schema_name), ["debugger", "planner"]);
    assert.deepEqual(schemas.autobiographical_knowledge, []);
  } finally {
    dbTools.closeDb();
    if (previousHexmemDb === undefined) {
      delete process.env.HEXMEM_DB;
    } else {
      process.env.HEXMEM_DB = previousHexmemDb;
    }
    db.close();
  }
});
