import type { Pool } from "pg";
import { formatSerial } from "../library/serial";
import type { CapabilityType, SummaryPoint } from "./card";
import { toVectorLiteral } from "./embedding";

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

/**
 * A nearby kept capability offered to the reason step, both for the pre-existing "similar
 * capabilities" context and (new) as an overlap-relation candidate -- see prompts.ts's
 * reasonPrompt and scenarios.ts's cardSchemaFor, which narrows `overlap.target` to exactly the
 * `code`s returned here. `code` is null only for the vanishingly rare kept card with no serial
 * yet (see capabilities.ts's upsertCapability); such a candidate can still be shown by title but
 * can never be cited as an overlap target.
 */
export interface SimilarCandidate {
  id: string;
  code: string | null;
  title: string;
  type: CapabilityType;
  summary: string;
  tags: string[];
}

const ONE_LINE_LEN = 60;

/** Truncates a card's full summary to a short one-line blurb for a candidate list. */
function oneLine(summary: string): string {
  return summary.length > ONE_LINE_LEN ? `${summary.slice(0, ONE_LINE_LEN)}…` : summary;
}

/**
 * Joins the prose lead with its structured points' text (M3.8: most of a card's substance now
 * lives in `summary_points`, not `summary` -- see queries.ts's ILIKE fix) before truncating to
 * the one-line blurb, so overlap judgement isn't working from just the ~120-char lead.
 */
function fullSummaryText(summary: string, points: SummaryPoint[] | null | undefined): string {
  const pointsText = (points ?? []).map((p) => p.text).filter(Boolean).join(" ");
  return [summary, pointsText].filter(Boolean).join(" ");
}

interface CandidateRow { id: string; title: string; type: CapabilityType; summary: string; summary_points: SummaryPoint[] | null; tags: string[]; serial: number | null }

function toCandidate(row: CandidateRow): SimilarCandidate {
  return { id: row.id, code: formatSerial(row.type, row.serial), title: row.title, type: row.type, summary: oneLine(fullSummaryText(row.summary, row.summary_points)), tags: row.tags };
}

const CANDIDATE_COLUMNS = "id, title, type, summary, summary_points, tags, serial";

/** Kept, active capabilities resembling `text`, excluding the capture currently being analysed. */
export async function findSimilar(pool: Pick<Pool, "query">, text: string, captureId: string, limit = 5): Promise<SimilarCandidate[]> {
  const tokens = similarTokens(text.slice(0, 500));
  if (!tokens.length) return [];
  const q = tokens.map((t) => `'${t}'`).join(" | ");
  const r = await pool.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM caphub_v2.capabilities
     WHERE verdict = 'keep' AND deleted_at IS NULL AND status = 'active' AND capture_id <> $3 AND search @@ to_tsquery('simple', $1)
     ORDER BY ts_rank(search, to_tsquery('simple', $1)) DESC LIMIT $2`, [q, limit, captureId]);
  return r.rows.map(toCandidate);
}

/**
 * Kept, active capabilities nearest to a given embedding by cosine distance (`<=>`). Two ways
 * to call it:
 *  - `{ capabilityId }`: compares against that capability's own stored embedding, excluding
 *    itself. The embedding value is never pulled into JS -- the comparison happens entirely in
 *    SQL via a self-referencing join on the same table -- and it returns no rows at all when
 *    `capabilityId` itself has no embedding yet.
 *  - `{ embedding, excludeCaptureId? }`: compares against an embedding computed elsewhere (e.g.
 *    a throwaway query embedding of the incoming material on a capture's first analysis run,
 *    before any capability row -- let alone its own embedding -- exists yet; see
 *    lib/analysis/pipeline.ts's `loadSimilar`), optionally excluding one capture's own
 *    (not-yet-existing-or-not-yet-kept) row.
 * lib/analysis/pipeline.ts falls back to `findSimilar`'s text search when neither form has
 * anything to compare against.
 */
export async function similarByEmbedding(
  pool: Pick<Pool, "query">,
  input: { capabilityId: string; limit?: number } | { embedding: number[]; excludeCaptureId?: string | null; limit?: number }
): Promise<SimilarCandidate[]> {
  const limit = input.limit ?? 5;
  if ("capabilityId" in input) {
    const r = await pool.query<CandidateRow>(
      `SELECT c.id, c.title, c.type, c.summary, c.summary_points, c.tags, c.serial
       FROM caphub_v2.capabilities c, caphub_v2.capabilities self
       WHERE self.id = $1 AND self.embedding IS NOT NULL
         AND c.id <> $1 AND c.verdict = 'keep' AND c.deleted_at IS NULL AND c.status = 'active' AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> self.embedding
       LIMIT $2`, [input.capabilityId, limit]);
    return r.rows.map(toCandidate);
  }
  const excludeCaptureId = input.excludeCaptureId ?? null;
  const r = await pool.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM caphub_v2.capabilities
     WHERE verdict = 'keep' AND deleted_at IS NULL AND status = 'active' AND embedding IS NOT NULL
       AND ($3::text IS NULL OR capture_id <> $3)
     ORDER BY embedding <=> $1::vector
     LIMIT $2`, [toVectorLiteral(input.embedding), limit, excludeCaptureId]);
  return r.rows.map(toCandidate);
}
