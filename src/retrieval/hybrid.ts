import type Database from "better-sqlite3";
import type { Sensitivity, SearchResult, Embedder } from "../types.js";
import { ftsSearch } from "./fts.js";
import { vecAvailable, vecSearch } from "./vec.js";

/**
 * Hybrid retrieval: ranked FTS plus vector KNN, merged with Reciprocal Rank
 * Fusion. Degrades to FTS-only whenever the embedder or sqlite-vec is
 * unavailable — semantic search is an enhancement, never a dependency.
 *
 * RRF: score(item) = Σ_lists 1/(K + rank). Scores are scaled ×100 so they
 * land in the same magnitude range as the FTS blend (gateway recall fuses
 * this score with its term-overlap/domain bonuses).
 */

const RRF_K = 60;
const RRF_SCALE = 100;

export async function hybridSearch(
  db: Database.Database,
  query: string,
  limit: number,
  maxSensitivity: Sensitivity,
  embedder: Embedder | null,
): Promise<SearchResult[]> {
  const ftsResults = ftsSearch(db, query, limit, maxSensitivity);

  if (!embedder || !vecAvailable(db)) return ftsResults;

  let vecResults: SearchResult[] = [];
  try {
    const queryVec = await embedder.embed(query);
    vecResults = vecSearch(db, queryVec, limit, maxSensitivity);
  } catch {
    return ftsResults;
  }
  if (vecResults.length === 0) return ftsResults;

  const merged = new Map<string, SearchResult>();
  const rrf = new Map<string, number>();

  for (const [listIndex, list] of [ftsResults, vecResults].entries()) {
    list.forEach((result, rank) => {
      const key = `${result.table}:${result.id}`;
      rrf.set(key, (rrf.get(key) ?? 0) + RRF_SCALE / (RRF_K + rank));
      // prefer the FTS copy of content (identical cols; first list wins)
      if (!merged.has(key) || listIndex === 0) {
        const existing = merged.get(key);
        if (!existing || listIndex === 0) merged.set(key, result);
      }
    });
  }

  const fused = [...merged.entries()].map(([key, result]) => ({
    ...result,
    score: rrf.get(key) ?? 0,
  }));
  fused.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return fused.slice(0, limit);
}
