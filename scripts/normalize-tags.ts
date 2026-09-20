/**
 * One-off tag-normalization pass: rewrites known synonyms of the four fixed "接入方式" tags
 * (see lib/analysis/card.ts's `INTERFACE_TAGS`: mcp, cli, library, agent-skill) to their
 * canonical form across every non-deleted capability. Pure string mapping — no model call, no
 * new web search, no re-analysis of anything else.
 *
 * The synonym map below is deliberately small and explicit rather than a fuzzy heuristic:
 * `agent-skills` -> `agent-skill` (8 production rows use the plural today), `mcp-server` ->
 * `mcp`, `cli-tool` -> `cli`, `python-library`/`libraries` -> `library`. A tag not in this map
 * is left untouched, even if it looks related — this script only fixes known synonyms, it does
 * not guess new ones.
 *
 * Only `tags` is written, and only for a card whose tags actually change after mapping +
 * dedupe; `updated_at` and every other column are left alone, same discipline as
 * scripts/reclassify-types.ts's `type`-only write. Tag order is otherwise preserved — the
 * mapping only ever renames an entry in place and then dedupes, it never reorders or drops an
 * unrelated tag.
 *
 * Dry-run by default: prints a before -> after line for every card whose tags would change
 * (id-free — shows the displayed serial code when the card has one, else the title, mirroring
 * reclassify-types.ts's review table), plus the unchanged count, but writes nothing. Pass
 * `--apply` to actually write.
 *
 * Modeled on scripts/reclassify-types.ts: bootstrap, import.meta.url gate, per-row try/catch
 * with a failure count, non-zero exit when every attempted row failed, stripNul on any
 * provider-adjacent text (none here — this script never touches model output — but tags read
 * back from the DB are still passed through as plain strings, never re-serialized as JSON,
 * since `tags` is a native Postgres `text[]`).
 */
import type { Pool } from "pg";
import { INTERFACE_TAGS, type CapabilityType } from "../lib/analysis/card";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { formatSerial } from "../lib/library/serial";

function parseArgs(args: string[]): { apply: boolean } {
  return { apply: args.includes("--apply") };
}

/**
 * Known synonyms mapped to the four canonical interface tags. Kept as a plain object (not
 * derived from INTERFACE_TAGS) since the synonyms themselves aren't part of that shared
 * vocabulary — only the canonical targets are, and importing INTERFACE_TAGS here is what keeps
 * this map's targets from drifting from the prompt's four tags.
 */
export const TAG_SYNONYMS: Record<string, (typeof INTERFACE_TAGS)[number]> = {
  "agent-skills": "agent-skill",
  "mcp-server": "mcp",
  "cli-tool": "cli",
  "python-library": "library",
  "libraries": "library"
};

/**
 * Applies the synonym map to one tag list: rewrites each known synonym to its canonical form,
 * then dedupes (a card that already has both `mcp` and `mcp-server` collapses to one `mcp`),
 * preserving the order tags otherwise appear in. Returns the same array reference-inequality-
 * wise only when something actually changed, so callers can cheaply skip a no-op write.
 */
export function normalizeTags(tags: string[]): string[] {
  const mapped = tags.map((t) => TAG_SYNONYMS[t] ?? t);
  return [...new Set(mapped)];
}

/** True when normalizing would change this tag list (different length after dedupe, or any entry renamed). */
function tagsChanged(before: string[], after: string[]): boolean {
  return before.length !== after.length || before.some((t, i) => t !== after[i]);
}

/** Writes the normalized tags for one card. Only `tags` is touched — `updated_at` must not move. */
export function applyTagNormalization(pool: Pick<Pool, "query">, id: string, tags: string[]) {
  return pool.query("UPDATE caphub_v2.capabilities SET tags = $2 WHERE id = $1", [id, tags]);
}

export interface NormalizeRow {
  id: string; title: string; tags: string[]; type: CapabilityType; serial: number | null;
}

/** One applied (or would-be-applied) change, for the id-free dry-run review table. */
export interface NormalizeChange {
  label: string; before: string[]; after: string[];
}

export interface NormalizeResult {
  candidates: number; changed: number; unchanged: number; failed: number;
  changes: NormalizeChange[];
}

/**
 * The normalization loop, factored out of `main()` so it can run against a fake pool instead of
 * a real database — same shape as scripts/reclassify-types.ts's `runReclassify`. No model call
 * is involved, so the only failure mode per row is the UPDATE itself throwing.
 */
export async function runNormalize(
  pool: Pick<Pool, "query">, apply: boolean, log: (o: Record<string, unknown>) => void
): Promise<NormalizeResult> {
  const { rows } = await pool.query<NormalizeRow>(
    "SELECT id, title, tags, type, serial FROM caphub_v2.capabilities WHERE deleted_at IS NULL ORDER BY created_at"
  );
  log({ mode: apply ? "apply" : "dry-run", candidates: rows.length });
  let changed = 0;
  let unchanged = 0;
  let failed = 0;
  const changes: NormalizeChange[] = [];
  for (const row of rows) {
    // Computing the mapping is pure (never throws); only the write below can fail, so it alone
    // is what a per-row try/catch needs to isolate.
    const nextTags = normalizeTags(row.tags);
    if (!tagsChanged(row.tags, nextTags)) {
      unchanged += 1;
      continue;
    }
    const label = formatSerial(row.type, row.serial) ?? row.title;
    try {
      if (apply) await applyTagNormalization(pool, row.id, nextTags);
      changes.push({ label, before: row.tags, after: nextTags });
      log({ capabilityId: row.id, title: row.title, before: row.tags, after: nextTags, applied: apply });
      changed += 1;
    } catch (error) {
      failed += 1;
      log({ capabilityId: row.id, title: row.title, error: error instanceof Error ? error.message : String(error) });
    }
  }
  log({ candidates: rows.length, changed, unchanged, failed, mode: apply ? "apply" : "dry-run" });
  return { candidates: rows.length, changed, unchanged, failed, changes };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "script");
  const pool = createPool(config.databaseUrl);
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    const { changed, unchanged, failed, changes } = await runNormalize(pool, apply, log);
    if (!apply) {
      process.stdout.write(
        changes.length > 0
          ? `${changes.length} proposed change(s):\n` +
            changes.map((c) => `  ${c.label}  [${c.before.join(", ")}] -> [${c.after.join(", ")}]`).join("\n") + "\n"
          : "0 proposed changes.\n"
      );
      process.stdout.write(`${unchanged} card(s) unchanged.\n`);
    }
    // Every attempted row failing (and none succeeding, changed or not) is the signature of a
    // systemic problem, not per-row noise — see reclassify-types.ts's identical reasoning.
    const attempted = changed + unchanged + failed;
    if (attempted > 0 && changed === 0 && unchanged === 0 && failed === attempted) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked as a CLI script (`npx tsx scripts/normalize-tags.ts`), not when
// imported (e.g. by scripts/normalize-tags.test.ts, for normalizeTags/applyTagNormalization).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`normalize-tags failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
