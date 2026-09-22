import type { Pool } from "pg";
import { MAX_PROMPT_CHARS } from "../lib/analysis/card";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { jsonStringifyStripNul } from "../lib/text/sanitize";

export interface BackfillRow {
  id: string; serial: number | null; type: string;
  playbook: { kind: string; prompt_text?: string | null; [key: string]: unknown };
  capture_kind: "image" | "text" | "url"; capture_text: string | null;
  /** Output of the capture's latest successful vision step: `{ prompts }` (new) or `{ prompt_text }` (old), or null. */
  vision_output: { prompts?: string[]; prompt_text?: string | null } | null;
}

/**
 * Picks a card's verbatim prompts from what is already stored -- no model call (spec §4). The
 * vision transcription was made from the original image at analysis time; a text capture's old
 * playbook prompt is only trusted if it appears verbatim in the capture. Tolerates non-array
 * vision_output.prompts (treats as absent, falls back to prompt_text).
 *
 * `maybeMultiple: true` flags a filled row picked from the old single-string
 * `vision_output.prompt_text` (pre-dates the new `prompts` array) whose text contains a blank
 * line ("\n\n") -- a heuristic hint that this one old transcription probably ran several
 * separate prompts together, for the human to split by hand from the dry-run log. It never
 * changes what gets stored.
 */
export function pickBackfill(row: BackfillRow): { prompts: string[]; maybeMultiple?: boolean } | { unresolved: string } {
  const visionPrompts = Array.isArray(row.vision_output?.prompts) ? row.vision_output.prompts : [];
  const oldPromptText = row.vision_output?.prompt_text ?? null;
  const fromVision = (visionPrompts.length > 0 ? visionPrompts : (oldPromptText ? [oldPromptText] : []))
    .filter((p) => p.trim() !== "" && p.length <= MAX_PROMPT_CHARS);
  if (fromVision.length > 0) {
    const usedOldPromptText = visionPrompts.length === 0 && !!oldPromptText;
    if (usedOldPromptText && oldPromptText.includes("\n\n")) return { prompts: fromVision, maybeMultiple: true };
    return { prompts: fromVision };
  }
  const legacy = row.playbook.prompt_text;
  if (row.capture_kind === "text" && legacy) {
    return row.capture_text?.includes(legacy) ? { prompts: [legacy] } : { unresolved: "text capture, playbook prompt not verbatim in source" };
  }
  return { unresolved: row.capture_kind === "image" ? "no vision transcription" : `no verifiable source for a ${row.capture_kind} capture` };
}

const CANDIDATES = `
  SELECT cb.id, cb.serial, cb.type, cb.playbook, c.kind AS capture_kind, c.text AS capture_text,
    (SELECT s.output FROM caphub_v2.analysis_steps s JOIN caphub_v2.analysis_runs r ON r.id = s.run_id
     WHERE r.capture_id = cb.capture_id AND s.step = 'vision' AND s.ok
       AND (CASE WHEN jsonb_typeof(s.output->'prompts') = 'array' THEN jsonb_array_length(s.output->'prompts') > 0 ELSE false END OR coalesce(s.output->>'prompt_text', '') <> '')
     ORDER BY s.id DESC LIMIT 1) AS vision_output
  FROM caphub_v2.capabilities cb JOIN caphub_v2.captures c ON c.id = cb.capture_id
  WHERE cb.deleted_at IS NULL AND cb.prompts = '[]'::jsonb
    AND (cb.type = 'prompt' OR coalesce(cb.playbook->>'prompt_text', '') <> '')
  ORDER BY cb.created_at`;

/**
 * Fills `prompts` and drops the legacy `playbook.prompt_text` in one UPDATE. Cards that can't be
 * filled keep their legacy text untouched for a human decision. `updated_at` is deliberately not
 * touched (a data move, not a re-analysis); `prompts = '[]'` guards against overwriting prompts a
 * concurrent rerun just stored.
 */
export async function runPromptBackfill(
  pool: Pick<Pool, "query">, apply: boolean, log: (o: Record<string, unknown>) => void
): Promise<{ candidates: number; filled: number; unresolved: number; skipped: number }> {
  const { rows } = await pool.query<BackfillRow>(CANDIDATES);
  log({ mode: apply ? "apply" : "dry-run", candidates: rows.length });
  let filled = 0;
  let unresolved = 0;
  let skipped = 0;
  for (const row of rows) {
    const pick = pickBackfill(row);
    if ("unresolved" in pick) {
      unresolved += 1;
      // Legacy prompt_text and capture_kind are logged in full so Joey can decide by hand from
      // the dry-run log which of these should be filled manually.
      log({
        capabilityId: row.id, serial: row.serial, type: row.type, unresolved: pick.unresolved,
        legacyPromptText: row.playbook.prompt_text ?? null, captureKind: row.capture_kind
      });
      continue;
    }
    const maybeMultipleField = pick.maybeMultiple ? { maybeMultiple: true as const } : {};
    if (apply) {
      const { rowCount } = await pool.query(
        `UPDATE caphub_v2.capabilities SET prompts = $2::jsonb, playbook = playbook - 'prompt_text'
         WHERE id = $1 AND prompts = '[]'::jsonb`,
        [row.id, jsonStringifyStripNul(pick.prompts.map((text) => ({ text })))]
      );
      if (rowCount === 0) {
        skipped += 1;
        log({ capabilityId: row.id, skipped: "prompts already set" });
      } else {
        filled += 1;
        log({ capabilityId: row.id, serial: row.serial, type: row.type, prompts: pick.prompts, applied: true, ...maybeMultipleField });
      }
    } else {
      filled += 1;
      log({ capabilityId: row.id, serial: row.serial, type: row.type, prompts: pick.prompts, applied: false, ...maybeMultipleField });
    }
  }
  log({ filled, unresolved, skipped, mode: apply ? "apply" : "dry-run" });
  return { candidates: rows.length, filled, unresolved, skipped };
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const config = loadConfig(process.env, "script");
  const pool = createPool(config.databaseUrl);
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    await runPromptBackfill(pool, apply, log);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`backfill-prompts failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
