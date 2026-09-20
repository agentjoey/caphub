/**
 * One-off duplicate scan over the existing library (M3.6 Task 5).
 *
 * Why this exists: the analysis-time overlap check (M3.6 Task 1) only judges a card's overlap
 * against the library at the moment it is newly analysed -- it writes `overlap` on that new card
 * only. The 14 cards already in the library before Task 1 shipped never went through that check,
 * so they have no overlap data at all. This script is a one-off pass that surfaces duplicates
 * among the existing, already-kept cards.
 *
 * Pair selection is pure SQL over already-stored embeddings -- no model call. A self-join over
 * non-deleted, `verdict = 'keep'`, `status = 'active'` cards that already have a serial (a
 * serial-less card can't be named in `overlap.target`, which only ever holds a serial code that
 * parseSerialQuery() can resolve -- see label()'s title fallback, which exists for *display* only
 * and must never leak into a written overlap.target) with an embedding, one row per unordered
 * pair (`a.id < b.id`), keeps only pairs whose cosine similarity
 * (`1 - (a.embedding <=> b.embedding)`) clears a threshold (default 0.80, `--threshold` overrides),
 * ordered by similarity desc. With 14 cards in the library today that's at most 91 pairs, and the
 * threshold is expected to leave only a handful needing a model call.
 *
 * One DeepSeek structured call per surviving pair, given both cards' serial code, title, summary,
 * type and tags, asks for `{relation, keep, reason}`: `relation` is duplicate / upgrade /
 * complement / none (a subset of the card schema's overlap.relation -- `superseded` is a
 * *symmetric* judgment call this pairwise scan doesn't ask the model to make; the model instead
 * always says which of the two is worth keeping via `keep`), `keep` is the serial code of the
 * card worth keeping (or null when relation is none/complement, i.e. there's no "loser"), `reason`
 * is a Chinese sentence up to 80 chars. `keep`, when non-null, is validated to be one of the two
 * codes actually offered -- the same "no candidates outside what was offered" discipline the live
 * pipeline enforces on `overlap.target` (see lib/analysis/scenarios.ts).
 *
 * Dry-run by default: prints a table with columns A / B / 相似度 / 关系 / 建议保留 / 理由 for every
 * surviving pair (including relation=none/complement ones, so the owner can see what was
 * considered and dismissed) but writes nothing. `--apply` writes ONLY the `overlap` column
 * (relation + target=the kept card's serial code + reason) on the card NOT kept, for
 * relation=duplicate/upgrade pairs -- never `status`, never `updated_at`. A relation of
 * 'none' or 'complement' writes nothing for that pair.
 *
 * The point of writing `overlap` rather than acting on it directly: the detail page's overlap
 * notice (M3.6 Task 2) then lets the owner confirm or ignore each one, the same review flow a
 * freshly-analysed card's own overlap finding already goes through. This script never sets
 * `status`, since retiring a card is a decision that stays with the human, per the M3.6 design.
 *
 * A pair whose model call fails is logged and skipped; the scan continues with the remaining
 * pairs.
 *
 * Modeled on scripts/reclassify-types.ts: import.meta.url gate so tests can import this module
 * without running `main()`, dry-run default with `--apply` to write, per-pair try/catch with a
 * failure count, `AbortSignal.timeout(TIMEOUTS.reason)` (never a bare, never-firing
 * AbortController), non-zero exit when every attempted pair failed, `stripNul`/
 * `jsonStringifyStripNul` on written text.
 */
import type { Pool } from "pg";
import { z } from "zod";
import type { CapabilityType } from "../lib/analysis/card";
import { TIMEOUTS } from "../lib/analysis/pipeline";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { formatSerial } from "../lib/library/serial";
import { createDeepSeekCall } from "../lib/providers/deepseek";
import { jsonStringifyStripNul, stripNul } from "../lib/text/sanitize";

export const DEFAULT_THRESHOLD = 0.8;

function parseArgs(args: string[]): { apply: boolean; threshold: number } {
  const apply = args.includes("--apply");
  const thresholdArg = args.find((a) => a.startsWith("--threshold="));
  const threshold = thresholdArg ? Number.parseFloat(thresholdArg.slice("--threshold=".length)) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new Error(`--threshold must be a number between -1 and 1, got: ${thresholdArg}`);
  }
  return { apply, threshold };
}

export interface PairCard {
  id: string; serial: number | null; type: CapabilityType; title: string; summary: string; tags: string[];
}

export interface PairRow {
  a: PairCard; b: PairCard; similarity: number;
}

/** Cosine-similarity candidate pairs, selected entirely in SQL -- no model call for this step. */
export async function findCandidatePairs(pool: Pick<Pool, "query">, threshold: number): Promise<PairRow[]> {
  const { rows } = await pool.query<{
    aId: string; aSerial: number | null; aType: CapabilityType; aTitle: string; aSummary: string; aTags: string[];
    bId: string; bSerial: number | null; bType: CapabilityType; bTitle: string; bSummary: string; bTags: string[];
    similarity: number;
  }>(
    `SELECT a.id AS "aId", a.serial AS "aSerial", a.type AS "aType", a.title AS "aTitle", a.summary AS "aSummary", a.tags AS "aTags",
            b.id AS "bId", b.serial AS "bSerial", b.type AS "bType", b.title AS "bTitle", b.summary AS "bSummary", b.tags AS "bTags",
            1 - (a.embedding <=> b.embedding) AS similarity
     FROM caphub_v2.capabilities a
     JOIN caphub_v2.capabilities b ON a.id < b.id
     WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND a.verdict = 'keep' AND b.verdict = 'keep'
       AND a.status = 'active' AND b.status = 'active'
       AND a.serial IS NOT NULL AND b.serial IS NOT NULL
       AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
       AND (1 - (a.embedding <=> b.embedding)) >= $1
     ORDER BY similarity DESC`,
    [threshold]
  );
  return rows.map((r) => ({
    a: { id: r.aId, serial: r.aSerial, type: r.aType, title: r.aTitle, summary: r.aSummary, tags: r.aTags },
    b: { id: r.bId, serial: r.bSerial, type: r.bType, title: r.bTitle, summary: r.bSummary, tags: r.bTags },
    similarity: r.similarity
  }));
}

/** Falls back to the title (no id-leaking) when a card has no serial yet, same as reclassify-types.ts's dry-run labels. */
function label(card: PairCard): string {
  return formatSerial(card.type, card.serial) ?? card.title;
}

export function duplicatePairPrompt(a: PairCard, b: PairCard): string {
  const codeA = label(a);
  const codeB = label(b);
  const describe = (code: string, c: PairCard) =>
    `${code}：标题「${c.title}」，类型 ${c.type}，摘要：${c.summary}，标签：${c.tags.join(", ") || "（无）"}`;
  return [
    "你在给个人 agent 能力库里两张已经建档、疑似重复的卡片判断关系。只依据下面两张卡片自己的文字内容判断，不要假设你知道库里其他卡片的信息。",
    describe(codeA, a),
    describe(codeB, b),
    "relation 在 none（无关，只是语义相近）、duplicate（两者内容重复）、upgrade（其中一张是另一张的升级版）、complement（两者互补，都值得保留）之间选一个。",
    `keep 指出两张卡里更值得保留的那一张的编号（必须原样填写 ${codeA} 或 ${codeB} 之一），relation 为 none 或 complement 时 keep 必须为 null；relation 为 duplicate 或 upgrade 时 keep 不能为 null。`,
    "reason 用一句不超过 80 字的中文说明判断依据。"
  ].join("\n\n");
}

const duplicateRelationSchema = z.enum(["duplicate", "upgrade", "complement", "none"]);
export type DuplicateRelation = z.infer<typeof duplicateRelationSchema>;

function resultSchemaFor(codeA: string, codeB: string) {
  return z.object({
    relation: duplicateRelationSchema,
    keep: z.union([z.literal(codeA), z.literal(codeB), z.null()]),
    reason: z.string().max(80)
  });
}

export interface DuplicateCall {
  invoke(input: { prompt: string; schemaName: string; schema: ReturnType<typeof resultSchemaFor> }, signal: AbortSignal): Promise<{ value: unknown }>;
}

/** One row of the dry-run/summary table. */
export interface DuplicateRow {
  a: string; b: string; similarity: number; relation: DuplicateRelation; keep: string | null; reason: string;
}

/** Writes `overlap` on the card NOT kept. Never touches `status` or `updated_at` -- retiring a card stays a human decision. */
export function applyOverlap(pool: Pick<Pool, "query">, loserId: string, relation: "duplicate" | "upgrade", keepCode: string, reason: string) {
  return pool.query(
    "UPDATE caphub_v2.capabilities SET overlap = $2 WHERE id = $1",
    [loserId, jsonStringifyStripNul({ relation, target: keepCode, reason: stripNul(reason) })]
  );
}

export interface DuplicateScanResult {
  candidates: number; written: number; skippedRelation: number; failed: number; rows: DuplicateRow[];
}

/**
 * The scan loop, factored out of `main()` so it can run against fakes (a fake pool and a fake
 * DeepSeek call) instead of a real database/provider -- same shape as reclassify-types.ts's
 * `runReclassify`. Every surviving pair is logged and included in the returned `rows` (for the
 * dry-run table), regardless of relation; only duplicate/upgrade pairs are ever written, and only
 * when `apply` is true.
 */
export async function runDuplicateScan(
  pool: Pick<Pool, "query">, call: DuplicateCall, apply: boolean, threshold: number, log: (o: Record<string, unknown>) => void
): Promise<DuplicateScanResult> {
  const pairs = await findCandidatePairs(pool, threshold);
  log({ mode: apply ? "apply" : "dry-run", threshold, candidates: pairs.length });
  let written = 0;
  let skippedRelation = 0;
  let failed = 0;
  const rows: DuplicateRow[] = [];
  for (const pair of pairs) {
    const codeA = label(pair.a);
    const codeB = label(pair.b);
    const prompt = duplicatePairPrompt(pair.a, pair.b);
    const schema = resultSchemaFor(codeA, codeB);
    try {
      // A bare `new AbortController().signal` never fires -- a hung DeepSeek call would block this
      // pair (and the whole script) forever. Bound it the same way the live pipeline bounds its
      // reasoning-step calls (see TIMEOUTS.reason in pipeline.ts).
      const raw = await call.invoke({ prompt, schemaName: "duplicate_pair", schema }, AbortSignal.timeout(TIMEOUTS.reason));
      const { relation, keep, reason } = schema.parse(raw.value);
      if ((relation === "duplicate" || relation === "upgrade") && keep === null) {
        throw new Error(`relation=${relation} requires a non-null keep`);
      }
      rows.push({ a: codeA, b: codeB, similarity: pair.similarity, relation, keep, reason });
      log({ a: codeA, b: codeB, similarity: pair.similarity, relation, keep, reason, applied: false });
      if (relation === "none" || relation === "complement") {
        skippedRelation += 1;
        continue;
      }
      // keep is non-null here (validated above) and equals codeA or codeB (schema-validated).
      const loser = keep === codeA ? pair.b : pair.a;
      const keepCode = keep as string;
      log({ a: codeA, b: codeB, relation, loser: loser.id, keep: keepCode, applied: apply });
      if (apply) await applyOverlap(pool, loser.id, relation, keepCode, reason);
      written += 1;
    } catch (error) {
      failed += 1;
      log({ a: codeA, b: codeB, error: error instanceof Error ? error.message : String(error) });
    }
  }
  log({ candidates: pairs.length, written, skippedRelation, failed, mode: apply ? "apply" : "dry-run" });
  return { candidates: pairs.length, written, skippedRelation, failed, rows };
}

function printTable(rows: DuplicateRow[]) {
  if (rows.length === 0) {
    process.stdout.write("0 pair(s) above threshold.\n");
    return;
  }
  process.stdout.write("A\tB\t相似度\t关系\t建议保留\t理由\n");
  for (const r of rows) {
    process.stdout.write(`${r.a}\t${r.b}\t${r.similarity.toFixed(3)}\t${r.relation}\t${r.keep ?? "-"}\t${r.reason}\n`);
  }
}

async function main() {
  const { apply, threshold } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "script");
  if (!config.providers.deepseekApiKey) throw new Error("DEEPSEEK_API_KEY required to scan for duplicates");
  const pool = createPool(config.databaseUrl);
  const call = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    const { candidates, written, skippedRelation, failed, rows } = await runDuplicateScan(pool, call, apply, threshold, log);
    printTable(rows);
    process.stdout.write(`${candidates} pair(s) considered, ${written} ${apply ? "written" : "would be written"}, ${skippedRelation} skipped (relation none/complement), ${failed} failed.\n`);
    // Every attempted pair failing (and none succeeding) is the signature of a systemic problem
    // (bad API key, DeepSeek down, schema mismatch), not per-pair noise -- exit non-zero so a
    // human watching `$?` notices, same discipline as reclassify-types.ts.
    const attempted = written + skippedRelation + failed;
    if (attempted > 0 && written === 0 && skippedRelation === 0 && failed === attempted) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked as a CLI script (`npx tsx scripts/find-duplicates.ts`), not when imported
// (e.g. by scripts/find-duplicates.test.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`find-duplicates failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
