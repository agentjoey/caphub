export interface EmbeddingRow {
  title: string;
  summary: string;
  tags: string[];
  /** Both zh and en labels for each of the capability's scenarios, in the caller's chosen order. */
  scenarioLabels: string[];
  /**
   * `summary_points`' `label`/`text` pairs (M3.8), flattened to plain strings. Included so a
   * structured card's search/embedding quality doesn't regress now that most of what used to
   * live in the prose `summary` has moved here -- a query matching only a point's wording
   * (e.g. a term that appears in a point's `text` but not in the now-short `summary`) must
   * still find this card.
   */
  summaryPoints: Array<{ label: string; text: string }>;
}

/** Deterministic text fed to the embedding model for a capability card. */
export function embeddingText(row: EmbeddingRow): string {
  const lines = [row.title, row.summary];
  if (row.summaryPoints.length > 0) lines.push(row.summaryPoints.map((p) => `${p.label}: ${p.text}`).join("; "));
  if (row.tags.length > 0) lines.push(`标签: ${row.tags.join(", ")}`);
  if (row.scenarioLabels.length > 0) lines.push(`场景: ${row.scenarioLabels.join(", ")}`);
  return lines.join("\n");
}

/** `pgvector` text input format for a `$n::vector` query parameter. */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
