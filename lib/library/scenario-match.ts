import type { Scenario } from "../analysis/scenarios";

/** True for a string made entirely of ASCII letters/digits (the only kind "contains" gets narrowed for). */
function isAsciiWord(s: string): boolean {
  return /^[a-z0-9]+$/i.test(s);
}

/** Whether `needle` contains `word` as a whole word (not as a substring of a larger word). */
function containsWholeWord(needle: string, word: string): boolean {
  if (!word) return false;
  const re = new RegExp(`(?:^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i");
  return re.test(needle);
}

/**
 * `needle` "contains" `label` under scenario-match semantics: CJK (or any non-pure-ASCII-word)
 * labels/keywords keep plain substring matching, since CJK text has no word-boundary ambiguity
 * the way `guide` inside `linux guide` does; a pure-ASCII label/keyword instead requires a
 * whole-word match, so short tokens like `ux`/`ui`/`ads`/`code` don't false-positive on
 * `linux`/`guide`/`build`/`downloads`/`vscode`.
 */
function looseContains(needle: string, label: string): boolean {
  if (!label) return false;
  return isAsciiWord(label) ? containsWholeWord(needle, label) : needle.includes(label);
}

/**
 * Scenario slugs whose zh/en label or keywords match a free-text search query.
 *
 * A scenario matches when the (trimmed, lowercased) query:
 *   - equals the slug, label_zh, label_en, or any keyword (case-insensitive), or
 *   - contains label_zh, or contains any keyword of length >= 2, or
 *   - is contained in label_zh.
 *
 * "Contains" is plain substring matching for CJK keywords/labels, but whole-word matching for
 * ASCII ones (see `looseContains`) — a short ASCII keyword like `ux` or `ads` must not match
 * inside an unrelated longer word like `linux` or `downloads`.
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
    const containsLabelOrKeyword = looseContains(needle, zh) || keywords.some((k) => k.length >= 2 && looseContains(needle, k));
    const labelContainsNeedle = isAsciiWord(zh) ? containsWholeWord(zh, needle) : zh.includes(needle);

    if (equalsAny || containsLabelOrKeyword || labelContainsNeedle) matched.push(s.slug);
  }
  return matched;
}
