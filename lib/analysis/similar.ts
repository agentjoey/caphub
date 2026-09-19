import type { Pool } from "pg";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_RUN = /[\p{L}\p{N}]+/gu;
const MAX_TOKENS = 8;

/**
 * Extract up to MAX_TOKENS distinct search tokens from a seed string, CJK-aware:
 * ASCII/digit runs become one token each; CJK runs become one token each, and a
 * CJK run longer than 4 characters also contributes its first-4-character prefix
 * (since Chinese/Japanese/Korean text has no word boundaries and a long run is
 * unlikely to match another document verbatim). Any tsquery metacharacter is
 * stripped from a candidate token before it is considered.
 */
export function similarTokens(seed: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    if (tokens.length >= MAX_TOKENS) return;
    const t = raw.replace(/[&|!():*'"<>]/g, "").toLowerCase();
    if (t.length < 2 || seen.has(t)) return;
    seen.add(t);
    tokens.push(t);
  };
  for (const match of seed.matchAll(WORD_RUN)) {
    if (tokens.length >= MAX_TOKENS) break;
    const run = match[0];
    if (CJK.test(run[0])) {
      add(run);
      if (run.length > 4) add(run.slice(0, 4));
    } else {
      add(run);
    }
  }
  return tokens;
}

export async function findSimilar(pool: Pick<Pool, "query">, text: string, limit = 5): Promise<Array<{ id: string; title: string; tags: string[] }>> {
  const tokens = similarTokens(text.slice(0, 500));
  if (!tokens.length) return [];
  const q = tokens.map((t) => `'${t}'`).join(" | ");
  const r = await pool.query<{ id: string; title: string; tags: string[] }>(
    `SELECT id, title, tags FROM caphub_v2.capabilities
     WHERE verdict = 'keep' AND deleted_at IS NULL AND search @@ to_tsquery('simple', $1)
     ORDER BY ts_rank(search, to_tsquery('simple', $1)) DESC LIMIT $2`, [q, limit]);
  return r.rows;
}
