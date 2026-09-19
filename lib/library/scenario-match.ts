import type { Scenario } from "../analysis/scenarios";

/**
 * Scenario slugs whose zh/en label or keywords match a free-text search query.
 *
 * A scenario matches when the (trimmed, lowercased) query:
 *   - equals the slug, label_zh, label_en, or any keyword (case-insensitive), or
 *   - contains label_zh, or contains any keyword of length >= 2, or
 *   - is contained in label_zh.
 */
export function matchScenarios(q: string, scenarios: Scenario[]): string[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const matched: string[] = [];
  for (const s of scenarios) {
    const zh = s.labelZh.toLowerCase();
    const en = s.labelEn.toLowerCase();
    const slug = s.slug.toLowerCase();
    const keywords = s.keywords.map((k) => k.toLowerCase());

    const equalsAny = needle === slug || needle === zh || needle === en || keywords.includes(needle);
    const containsLabelOrKeyword = needle.includes(zh) || keywords.some((k) => k.length >= 2 && needle.includes(k));
    const labelContainsNeedle = zh.includes(needle);

    if (equalsAny || containsLabelOrKeyword || labelContainsNeedle) matched.push(s.slug);
  }
  return matched;
}
