import type Database from "better-sqlite3";

const POSITIVE_OUTCOMES = new Set(["adopted", "success", "validated"]);
const NEGATIVE_OUTCOMES = new Set(["corrected", "failure", "contradicted"]);
const IGNORED_OUTCOME = "ignored";
const IGNORED_WEIGHT = 0.3;

export function computeConfidence(alpha: number, betaParam: number): number {
  return alpha / (alpha + betaParam);
}

export function getAsymmetricWeight(domain: string, outcome: string): number {
  const isPositive = POSITIVE_OUTCOMES.has(outcome);
  const isNegative = NEGATIVE_OUTCOMES.has(outcome) || outcome === IGNORED_OUTCOME;

  if (domain === "security" && isNegative) return 2.0;
  if (domain === "social" && isPositive) return 0.5;
  return 1.0;
}

export function updatePosterior(
  db: Database.Database,
  lessonId: number,
  outcome: string,
  weight: number,
): { alpha: number; beta_param: number; confidence: number; delta: number } {
  const row = db.prepare(
    "SELECT alpha, beta_param, confidence FROM lessons WHERE id = ?"
  ).get(lessonId) as { alpha: number; beta_param: number; confidence: number } | undefined;

  if (!row) throw new Error(`Lesson ${lessonId} not found`);

  let alpha = row.alpha ?? 1.0;
  let betaParam = row.beta_param ?? 1.0;
  const priorConfidence = computeConfidence(alpha, betaParam);

  if (POSITIVE_OUTCOMES.has(outcome)) {
    alpha += weight;
  } else if (NEGATIVE_OUTCOMES.has(outcome)) {
    betaParam += weight;
  } else if (outcome === IGNORED_OUTCOME) {
    betaParam += IGNORED_WEIGHT * weight;
  }

  const posteriorConfidence = computeConfidence(alpha, betaParam);
  const delta = posteriorConfidence - priorConfidence;

  db.prepare(
    `UPDATE lessons SET
       alpha = ?,
       beta_param = ?,
       confidence = ?,
       times_validated = CASE WHEN ? THEN times_validated + 1 ELSE times_validated END,
       times_contradicted = CASE WHEN ? THEN times_contradicted + 1 ELSE times_contradicted END,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    alpha,
    betaParam,
    posteriorConfidence,
    POSITIVE_OUTCOMES.has(outcome) ? 1 : 0,
    NEGATIVE_OUTCOMES.has(outcome) ? 1 : 0,
    lessonId,
  );

  return { alpha, beta_param: betaParam, confidence: posteriorConfidence, delta };
}

export function posteriorDecay(
  db: Database.Database,
  factor: number,
  dryRun: boolean,
): { updated: number; scanned: number } {
  const lessons = db.prepare(
    "SELECT id, alpha, beta_param FROM lessons WHERE superseded_by IS NULL AND (valid_until IS NULL OR valid_until > datetime('now'))"
  ).all() as Array<{ id: number; alpha: number; beta_param: number }>;

  if (dryRun) {
    return { updated: 0, scanned: lessons.length };
  }

  const stmt = db.prepare(
    "UPDATE lessons SET alpha = ?, beta_param = ?, confidence = ?, updated_at = datetime('now') WHERE id = ?"
  );

  let updated = 0;
  for (const lesson of lessons) {
    const newAlpha = Math.max(1.0, lesson.alpha * factor);
    const newBeta = Math.max(1.0, lesson.beta_param * factor);
    const newConfidence = computeConfidence(newAlpha, newBeta);
    stmt.run(newAlpha, newBeta, newConfidence, lesson.id);
    updated++;
  }

  return { updated, scanned: lessons.length };
}
