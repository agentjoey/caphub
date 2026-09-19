import type { Pool } from "pg";
import { z } from "zod";
import { cardObjectSchema, refineCard } from "./card";

export interface Scenario {
  slug: string;
  labelZh: string;
  labelEn: string;
  keywords: string[];
}

/** Ordered per `sort`, as seeded by migration 004. */
export async function loadScenarios(pool: Pick<Pool, "query">): Promise<Scenario[]> {
  const { rows } = await pool.query<{ slug: string; label_zh: string; label_en: string; keywords: string[] }>(
    "SELECT slug, label_zh, label_en, keywords FROM caphub_v2.scenarios ORDER BY sort"
  );
  return rows.map((r) => ({ slug: r.slug, labelZh: r.label_zh, labelEn: r.label_en, keywords: r.keywords }));
}

/** `slug（中文名：关键词…）` list, for embedding in the reason prompt. */
export function scenariosPromptList(scenarios: Scenario[]): string {
  return scenarios.map((s) => `${s.slug}（${s.labelZh}：${s.keywords.join("、")}）`).join("；");
}

/**
 * `scenarios` field for a known, non-empty slug list: an enum of those slugs, deduped via
 * transform→pipe (same pattern as `tagsSchema`, so `z.toJSONSchema` still renders a plain
 * array), then required to have 1–3 entries.
 */
function scenariosFieldFor(slugs: readonly [string, ...string[]]) {
  const slug = z.enum(slugs);
  return z.array(slug)
    .transform((values) => [...new Set(values)])
    .pipe(z.array(slug).min(1).max(3));
}

/** `{ scenarios: [...] }` schema alone, for the backfill script's small per-card call. */
export function scenariosResultSchemaFor(slugs: readonly [string, ...string[]]) {
  return z.object({ scenarios: scenariosFieldFor(slugs) });
}

/**
 * cardSchema narrowed to a real, non-empty scenario slug list: `scenarios` becomes a
 * required enum of `slugs`, 1–3 entries, deduped. Built from `cardObjectSchema` (not
 * `cardSchema`) because `.extend()` isn't available on the ZodEffects `superRefine`
 * produces; the same cross-field rules are re-applied via `refineCard`.
 */
export function cardSchemaFor(slugs: string[]) {
  if (slugs.length === 0) throw new Error("cardSchemaFor requires at least one scenario slug");
  const nonEmpty = slugs as [string, ...string[]];
  return cardObjectSchema.extend({ scenarios: scenariosFieldFor(nonEmpty) }).superRefine(refineCard);
}
