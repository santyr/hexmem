export interface ConversationMessage {
  role: "assistant" | "user";
  text: string;
}

export interface DetectedAdvisory {
  action_summary: string;
  outcome: "adopted" | "corrected" | "ignored";
  outcome_weight: number;
}

// Patterns that suggest the assistant was giving advice (not just reporting facts)
const ADVISORY_PATTERNS = /\b(suggest|recommend|should|could|try|consider|i['']d|would|let['']s|how about)\b/i;

// User response patterns
const POSITIVE_PATTERNS = /\b(yes|good|exactly|perfect|great|right|agreed|nice|makes sense|let['']s do|sounds good|good (idea|point|call))\b/i;
const BUILD_PATTERNS = /\b(and (also|we)|plus|additionally|good point|building on)\b/i;
const NEGATIVE_PATTERNS = /\b(no[,.]?\s|actually|not quite|instead|wrong|don['']t think|won['']t work|that['']s not|incorrect)\b/i;

export function detectAdvisoryPatterns(messages: ConversationMessage[]): DetectedAdvisory[] {
  const results: DetectedAdvisory[] = [];

  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];

    // Only analyze assistant → user pairs
    if (current.role !== "assistant" || next.role !== "user") continue;

    // Skip non-advisory messages (factual responses, status reports)
    if (!ADVISORY_PATTERNS.test(current.text)) continue;

    const summary = current.text.slice(0, 120);
    const response = next.text;

    if (NEGATIVE_PATTERNS.test(response)) {
      results.push({ action_summary: summary, outcome: "corrected", outcome_weight: 1.0 });
    } else if (POSITIVE_PATTERNS.test(response) || BUILD_PATTERNS.test(response)) {
      results.push({ action_summary: summary, outcome: "adopted", outcome_weight: 1.0 });
    } else {
      // Check for topic change (low word overlap)
      const adviceWords = new Set(current.text.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const responseWords = new Set(response.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const overlap = [...adviceWords].filter(w => responseWords.has(w)).length;
      const overlapRatio = adviceWords.size > 0 ? overlap / adviceWords.size : 0;

      if (overlapRatio < 0.1 && response.length > 10) {
        results.push({ action_summary: summary, outcome: "ignored", outcome_weight: 0.5 });
      }
    }
  }

  return results;
}
