/**
 * One-shot backfill: drain the entire embedding_queue backlog.
 * Usage: npx tsx scripts/backfill-embeddings.ts
 * Respects HEXMEM_DB. Safe to re-run; failed rows are marked and skipped.
 */
import { getDb } from "../src/db.js";
import { createEmbedder } from "../src/retrieval/embedder.js";
import { drainEmbeddingQueue } from "../src/retrieval/queue-worker.js";

const db = getDb();
const embedder = await createEmbedder();
if (!embedder) {
  console.error("embedder unavailable — aborting");
  process.exit(1);
}

let total = 0;
let failedTotal = 0;

for (;;) {
  const { processed, failed, remaining } = await drainEmbeddingQueue(db, embedder, 128);
  total += processed;
  failedTotal += failed;
  console.log(`processed=${total} failed=${failedTotal} remaining=${remaining}`);
  if (processed === 0 && failed === 0) break;
  if (remaining === 0) break;
}

console.log("backfill complete");
