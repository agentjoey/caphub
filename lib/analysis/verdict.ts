import type { Card } from "./card";

/**
 * Confident suggestions apply automatically, except (spec 2026-09-22) when a prompt the source
 * contains could not be located verbatim, or a prompt card would be kept with no verbatim
 * prompt at all -- both go to Review so a human checks against the original capture.
 */
export function decideVerdict(
  card: Pick<Card, "suggested_verdict" | "confidence" | "type">,
  threshold: number,
  prompts: { count: number; unresolved: number }
): { verdict: "keep" | "discard" | "pending"; by: "auto" | null } {
  if (prompts.unresolved > 0) return { verdict: "pending", by: null };
  if (card.type === "prompt" && prompts.count === 0 && card.suggested_verdict === "keep") return { verdict: "pending", by: null };
  if (card.confidence >= threshold) return { verdict: card.suggested_verdict, by: "auto" };
  return { verdict: "pending", by: null };
}
