import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register as registerIdentity } from "./tools/identity.js";
import { register as registerFacts } from "./tools/facts.js";
import { register as registerEvents } from "./tools/events.js";
import { register as registerLessons } from "./tools/lessons.js";
import { register as registerSearch } from "./tools/search.js";
import { register as registerLifecycle } from "./tools/lifecycle.js";
import { register as registerReview } from "./tools/review.js";
import { register as registerEthics } from "./tools/ethics.js";
import { register as registerTasks } from "./tools/tasks.js";
import { register as registerEntities } from "./tools/entities.js";
import { register as registerNarrative } from "./tools/narrative.js";
import { register as registerPriming } from "./tools/priming.js";
import { register as registerDailyLog } from "./tools/daily-log.js";
import { register as registerObservations } from "./tools/observations.js";
import { register as registerGateway } from "./tools/gateway.js";

export type ToolProfile = "agent-full" | "agent-minimal" | "agent-admin";

export const AGENT_GATEWAY_TOOL_NAMES = [
  "hexmem_context",
  "hexmem_recall",
  "hexmem_remember",
  "hexmem_feedback",
  "hexmem_working_set",
  "hexmem_lint",
  "hexmem_health",
] as const;

export const DETAILED_TOOL_NAMES = [
  "hexmem_identity",
  "hexmem_values",
  "hexmem_self_schemas",
  "hexmem_facts",
  "hexmem_fact_add",
  "hexmem_fact_supersede",
  "hexmem_events",
  "hexmem_event_add",
  "hexmem_lessons",
  "hexmem_lesson_add",
  "hexmem_search",
  "hexmem_decay_sweep",
  "hexmem_consolidate",
  "hexmem_posterior_decay",
  "hexmem_stale_sweep",
  "hexmem_wake_digest",
  "hexmem_memory_health",
  "hexmem_review",
  "hexmem_review_due",
  "hexmem_ethics",
  "hexmem_ethic_add",
  "hexmem_ethic_update",
  "hexmem_tasks",
  "hexmem_task_update",
  "hexmem_task_create",
  "hexmem_task_verify",
  "hexmem_task_progress",
  "hexmem_entities",
  "hexmem_entity_add",
  "hexmem_entity_alias_add",
  "hexmem_entity_link",
  "hexmem_narrative",
  "hexmem_meaning_frame",
  "hexmem_prime",
  "hexmem_priming_state",
  "hexmem_auto_prime",
  "hexmem_daily_log",
  "hexmem_observation_add",
  "hexmem_observation_resolve",
  "hexmem_observation_link",
  "hexmem_observations",
] as const;

export function registerTools(server: McpServer, profileValue?: string): void {
  const profile = resolveToolProfile(profileValue ?? process.env.HEXMEM_TOOL_PROFILE);

  if (profile === "agent-minimal") {
    registerGateway(server);
    return;
  }

  registerIdentity(server);
  registerFacts(server);
  registerEvents(server);
  registerLessons(server);
  registerSearch(server);
  registerLifecycle(server);
  registerReview(server);
  registerEthics(server);
  registerTasks(server);
  registerEntities(server);
  registerNarrative(server);
  registerPriming(server);
  registerDailyLog(server);
  registerObservations(server);
  registerGateway(server);
}

export function resolveToolProfile(value: string | undefined): ToolProfile {
  if (value === "agent-minimal" || value === "agent-admin" || value === "agent-full") {
    return value;
  }
  return "agent-full";
}

export function toolNamesForProfile(profileValue: string | undefined): string[] {
  const profile = resolveToolProfile(profileValue);
  if (profile === "agent-minimal") {
    return [...AGENT_GATEWAY_TOOL_NAMES];
  }
  return [...DETAILED_TOOL_NAMES, ...AGENT_GATEWAY_TOOL_NAMES];
}
