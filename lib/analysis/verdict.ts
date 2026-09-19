import type { Card } from "./card";

export function decideVerdict(card: Pick<Card, "suggested_verdict" | "confidence">, threshold: number): { verdict: "keep" | "discard" | "pending"; by: "auto" | null } {
  if (card.confidence >= threshold) return { verdict: card.suggested_verdict, by: "auto" };
  return { verdict: "pending", by: null };
}
