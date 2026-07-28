const STRIP_WORDS = /\b(the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|shall|may|might|can|must|need|to|of|in|for|on|with|at|by|from|that|this|it|its|and|or|but|not|very|just|also|then|than|into|onto|upon)\b/gi;

const REPLACEMENTS: [string, string][] = [
  [" is equal to ", "="],
  [" equals ", "="],
  [" leads to ", "→"],
  [" implies ", "→"],
  [" results in ", "→"],
  [" not equal to ", "≠"],
  [" differs from ", "≠"],
  [" greater than ", ">"],
  [" over ", ">"],
  [" preferred to ", ">"],
  [". ", ";"],
];

export function compress(text: string): string {
  if (!text) return "";
  let result = text.trim();
  for (const [old, rep] of REPLACEMENTS) {
    result = result.replaceAll(old, rep);
  }
  result = result.replace(STRIP_WORDS, "");
  result = result.replace(/\s+/g, " ").trim();
  result = result.replace(/ /g, "_").replace(/__+/g, "_");
  result = result.replace(/[;_]+$/, "");
  return result;
}
