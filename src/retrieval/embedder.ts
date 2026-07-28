import type { Embedder } from "../types.js";

/**
 * Lazy MiniLM embedder via transformers.js (pure JS/WASM ONNX — no native
 * model server). 384 dims to match embedding_config and the vec0 tables the
 * legacy Python implementation created.
 *
 * The pipeline is loaded once per process and cached; the first call after
 * boot pays the model load (~2s warm cache, longer on first-ever download).
 * Failures cache `null` so a broken environment degrades to FTS-only
 * retrieval instead of erroring every call.
 */

const MODEL = process.env.HEXMEM_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const DIMENSIONS = 384;
const MAX_INPUT_CHARS = 2000;

let cached: Promise<Embedder | null> | undefined;

export function createEmbedder(): Promise<Embedder | null> {
  if (process.env.HEXMEM_DISABLE_EMBEDDINGS === "1") return Promise.resolve(null);
  if (!cached) cached = load();
  return cached;
}

/** Test hook: forget the cached pipeline/failure. */
export function resetEmbedderCache(): void {
  cached = undefined;
}

async function load(): Promise<Embedder | null> {
  try {
    const { pipeline } = await import("@xenova/transformers");
    const pipe = await pipeline("feature-extraction", MODEL);
    return {
      dimensions: DIMENSIONS,
      async embed(text: string): Promise<Float32Array> {
        const out = await pipe(text.slice(0, MAX_INPUT_CHARS), {
          pooling: "mean",
          normalize: true,
        });
        return new Float32Array(out.data as Float32Array);
      },
    };
  } catch (error) {
    console.error(`hexmem: embedder unavailable, retrieval degrades to FTS-only: ${error}`);
    return null;
  }
}
