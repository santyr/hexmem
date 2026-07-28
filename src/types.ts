export type Sensitivity = "public" | "private";
export type ConsolidationState = "active" | "fading" | "compressed" | "long_term" | "forgotten";
export type FactStatus = "active" | "superseded" | "decayed";

export interface SearchResult {
  table: string;
  id: number;
  content: Record<string, unknown>;
  score?: number;
}

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  readonly dimensions: number;
}

export interface DecaySweepResult {
  dry_run: boolean;
  scanned: number;
  transitions: Record<string, number>;
  protected_by_salience: number;
}

export interface TableHealth {
  by_state: Record<string, number>;
  overdue_reviews: number;
  avg_memory_strength: number;
}

export interface MemoryHealthReport {
  facts: TableHealth;
  events: TableHealth;
  lessons: TableHealth;
}
