export interface EmbeddingRow {
  title: string;
  summary: string;
  tags: string[];
  /** Both zh and en labels for each of the capability's scenarios, in the caller's chosen order. */
  scenarioLabels: string[];
}

/** Deterministic text fed to the embedding model for a capability card. */
export function embeddingText(row: EmbeddingRow): string {
  const lines = [row.title, row.summary];
  if (row.tags.length > 0) lines.push(`标签: ${row.tags.join(", ")}`);
  if (row.scenarioLabels.length > 0) lines.push(`场景: ${row.scenarioLabels.join(", ")}`);
  return lines.join("\n");
}

/** `pgvector` text input format for a `$n::vector` query parameter. */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
