/**
 * One-off re-classification pass: for every non-deleted capability, asks DeepSeek to pick the
 * best `type` (skill/experience/plugin/prompt/other) from the card's own stored fields — no new
 * web search, no re-analysis of anything else. Only `type` is written when it differs from the
 * model's pick; `updated_at` and every other column (including `playbook`, `tags`, `serial`) are
 * left alone. A card whose `verdict_by = 'human'` is skipped and logged instead of reclassified —
 * the owner may have hand-corrected it, and this script has no column that records a
 * hand-correction of `type` specifically, so it treats the whole card as human-owned rather than
 * risk clobbering that correction.
 *
 * A proposed change that crosses the `experience` boundary (experience -> non-experience, or
 * non-experience -> experience) is also skipped rather than written: `experience` is the only
 * type with its own `playbook.kind` (see card.ts's `refineCard`), so writing just `type` across
 * that boundary would leave the card with a `playbook.kind` that contradicts its new `type` (an
 * `experience` card without an `experience` playbook, or vice versa). Non-experience ->
 * non-experience changes (e.g. other -> prompt) don't have this problem and still apply as
 * normal. Boundary-crossing cards are collected into a "needs manual handling" list, printed in
 * both the dry-run output and the final summary, so the owner can fix those few by hand (改建议
 * or 重跑分析) instead of the script silently leaving a stale/mismatched playbook behind.
 *
 * Dry-run by default: prints a before -> after line for every card whose type would change, but
 * writes nothing. Pass `--apply` to actually write.
 *
 * Note: a card's displayed serial (see lib/library/serial.ts's `formatSerial`) prefixes the
 * stored number with a type-derived code (SKL/EXP/PLG/PRM/OTH). Changing `type` here therefore
 * changes what a card displays as (e.g. SKL-0012 -> PRM-0012) even though the underlying `serial`
 * number is never touched. That is intended, not a bug this script should guard against.
 *
 * Modeled on scripts/backfill-score.ts: bootstrap, import.meta.url gate, per-row try/catch with a
 * failure count, AbortSignal.timeout (never a bare, never-firing AbortController), non-zero exit
 * when every attempted row failed.
 */
import type { Pool } from "pg";
import { z } from "zod";
import { capabilityTypeSchema, type CapabilityType } from "../lib/analysis/card";
import { TIMEOUTS } from "../lib/analysis/pipeline";
import { CAPABILITY_TYPE_DEFINITIONS } from "../lib/analysis/prompts";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { formatSerial } from "../lib/library/serial";
import { createDeepSeekCall } from "../lib/providers/deepseek";

function parseArgs(args: string[]): { apply: boolean } {
  return { apply: args.includes("--apply") };
}

const typeResultSchema = z.object({ type: capabilityTypeSchema });

export interface ReclassifyCall {
  invoke(input: { prompt: string; schemaName: string; schema: typeof typeResultSchema }, signal: AbortSignal): Promise<{ value: unknown }>;
}

/**
 * Prompt for one card's type re-classification. Reuses `CAPABILITY_TYPE_DEFINITIONS` verbatim
 * (see lib/analysis/prompts.ts) rather than restating the type vocabulary, so this script's
 * verdict can't drift from what the live pipeline itself would call the same card. Like
 * `backfillScorePrompt`, there is no new search here — only the card's own stored fields.
 */
export function reclassifyTypePrompt(input: {
  title: string; summary: string; signals: string[]; playbook: unknown; tags: string[];
}): string {
  return [
    "你在给个人 agent 能力库里已经建档的一张卡片重新判断它的 type。这里没有新的联网搜索，只依据下面这张卡片自己已有的文字内容判断，不要假设你知道卡片之外的信息。",
    CAPABILITY_TYPE_DEFINITIONS,
    `标题：${input.title}`,
    `摘要：${input.summary}`,
    `价值信号：${input.signals.join("；") || "（无）"}`,
    `Playbook：${JSON.stringify(input.playbook)}`,
    `标签：${input.tags.join(", ") || "（无）"}`,
    "只输出 type 字段，从 skill、experience、plugin、prompt、other 中选一个最合适的。"
  ].join("\n\n");
}

/**
 * Writes the reclassified type for one card. Only `type` is touched — `updated_at` and every
 * other column must not move, since this is a re-classification pass, not a re-analysis.
 */
export function applyTypeReclassification(pool: Pick<Pool, "query">, id: string, type: CapabilityType) {
  return pool.query("UPDATE caphub_v2.capabilities SET type = $2 WHERE id = $1", [id, type]);
}

export interface ReclassifyRow {
  id: string; title: string; summary: string; signals: string[]; playbook: unknown; tags: string[];
  type: CapabilityType; verdictBy: "auto" | "human" | null; serial: number | null;
}

export interface NeedsManualHandling {
  capabilityId: string; title: string; before: CapabilityType; after: CapabilityType;
}

export interface ReclassifyResult {
  candidates: number; changed: number; unchanged: number; skippedHuman: number; failed: number;
  needsManualHandling: NeedsManualHandling[];
}

/** True when a proposed type change crosses the `experience` boundary in either direction. */
function crossesExperienceBoundary(before: CapabilityType, after: CapabilityType): boolean {
  return (before === "experience") !== (after === "experience");
}

/**
 * The reclassification loop, factored out of `main()` so it can run against fakes (a fake pool
 * and a fake DeepSeek call) instead of a real database/provider — same shape as
 * scripts/backfill-score.ts's `runBackfill`. Logs a before -> after row (with both the raw type
 * and the resulting displayed serial) for every card whose type would change; in dry-run that's
 * the full "would change" table, with `--apply` it's also written. A change that crosses the
 * `experience` boundary is logged separately and returned in `needsManualHandling` instead of
 * being applied — see the module header comment for why.
 */
export async function runReclassify(
  pool: Pick<Pool, "query">, call: ReclassifyCall, apply: boolean, log: (o: Record<string, unknown>) => void
): Promise<ReclassifyResult> {
  const { rows } = await pool.query<ReclassifyRow>(
    `SELECT id, title, summary, signals, playbook, tags, type, verdict_by AS "verdictBy", serial
     FROM caphub_v2.capabilities WHERE deleted_at IS NULL ORDER BY created_at`
  );
  log({ mode: apply ? "apply" : "dry-run", candidates: rows.length });
  let changed = 0;
  let unchanged = 0;
  let skippedHuman = 0;
  let failed = 0;
  const needsManualHandling: NeedsManualHandling[] = [];
  for (const row of rows) {
    // The owner may have hand-corrected this card's type already; there is no column that
    // records a hand-correction of `type` specifically, so `verdict_by = 'human'` (a correction
    // of the card at all) is treated as reason enough to leave `type` alone too.
    if (row.verdictBy === "human") {
      skippedHuman += 1;
      log({ capabilityId: row.id, title: row.title, skipped: "verdict_by=human" });
      continue;
    }
    const prompt = reclassifyTypePrompt(row);
    try {
      // A bare `new AbortController().signal` never fires — a hung DeepSeek call would block this
      // row (and the whole script) forever. Bound it the same way the live pipeline bounds its
      // reasoning-step calls (see TIMEOUTS.reason in pipeline.ts).
      const raw = await call.invoke({ prompt, schemaName: "capability_type", schema: typeResultSchema }, AbortSignal.timeout(TIMEOUTS.reason));
      const { type: nextType } = typeResultSchema.parse(raw.value);
      if (nextType === row.type) {
        unchanged += 1;
        continue;
      }
      if (crossesExperienceBoundary(row.type, nextType)) {
        // Writing just `type` here would leave `playbook.kind` contradicting the new `type`
        // (card.ts's `refineCard` invariant) — surfaced for the owner to fix by hand instead.
        needsManualHandling.push({ capabilityId: row.id, title: row.title, before: row.type, after: nextType });
        log({
          capabilityId: row.id, title: row.title, before: row.type, after: nextType,
          needsManualHandling: "crosses experience boundary — playbook.kind would contradict type"
        });
        continue;
      }
      log({
        capabilityId: row.id, title: row.title,
        before: row.type, after: nextType,
        serialBefore: formatSerial(row.type, row.serial), serialAfter: formatSerial(nextType, row.serial),
        applied: apply
      });
      if (apply) await applyTypeReclassification(pool, row.id, nextType);
      changed += 1;
    } catch (error) {
      failed += 1;
      log({ capabilityId: row.id, title: row.title, error: error instanceof Error ? error.message : String(error) });
    }
  }
  log({
    candidates: rows.length, changed, unchanged, skippedHuman, failed,
    needsManualHandling, mode: apply ? "apply" : "dry-run"
  });
  return { candidates: rows.length, changed, unchanged, skippedHuman, failed, needsManualHandling };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "script");
  if (!config.providers.deepseekApiKey) throw new Error("DEEPSEEK_API_KEY required to reclassify types");
  const pool = createPool(config.databaseUrl);
  const call = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    const { changed, unchanged, failed, needsManualHandling } = await runReclassify(pool, call, apply, log);
    if (needsManualHandling.length > 0) {
      process.stdout.write(
        `${needsManualHandling.length} card(s) need manual handling (crosses the experience boundary — fix by hand via 改建议 or 重跑分析):\n` +
        needsManualHandling.map((c) => `  ${c.capabilityId}  ${c.before} -> ${c.after}  ${c.title}`).join("\n") + "\n"
      );
    }
    // Every attempted row failing (and none succeeding, changed or not) is the signature of a
    // systemic problem — a bad API key, DeepSeek being down, a schema mismatch — not per-row
    // noise. Exiting non-zero lets a caller (cron, CI, a human watching `$?`) notice.
    const attempted = changed + unchanged + failed;
    if (attempted > 0 && changed === 0 && unchanged === 0 && failed === attempted) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked as a CLI script (`npx tsx scripts/reclassify-types.ts`), not when
// imported (e.g. by scripts/reclassify-types.test.ts, for applyTypeReclassification).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`reclassify-types failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
