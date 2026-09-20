import type { Pool } from "pg";
import { z } from "zod";
import { capabilityTypeSchema, cardObjectSchema, NO_OVERLAP, overlapRelationSchema, refineCard, type CapabilityType } from "./card";

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
 * `overlap` field for a known set of candidate serial codes (e.g. `["TOL-0009", "SKL-0012"]`,
 * from that run's similar-card lookup -- see similar.ts's similarByEmbedding/findSimilar):
 * `target` becomes a plain nullable enum of exactly those codes, so a model citing a code
 * outside the candidate list fails validation and goes through the existing invalid-output
 * retry path (same pattern as `scenariosFieldFor`, but no dedup/array shape is needed here).
 * With no candidates at all, `target` can only ever be `null` (there is nothing to point at,
 * so `relation` must end up "none" -- enforced by `refineCard`, re-applied below).
 */
function overlapFieldFor(codes: string[]) {
  const target = codes.length > 0 ? z.enum(codes as [string, ...string[]]).nullable() : z.null();
  return z.object({ relation: overlapRelationSchema, target, reason: z.string().max(120) }).default(NO_OVERLAP);
}

/**
 * cardSchema narrowed to a real, non-empty scenario slug list: `scenarios` becomes a
 * required enum of `slugs`, 1–3 entries, deduped. Built from `cardObjectSchema` (not
 * `cardSchema`) because `.extend()` isn't available on the ZodEffects `superRefine`
 * produces; the same cross-field rules are re-applied via `refineCard`.
 *
 * `pinnedType`, when given, additionally narrows `type` to a `z.literal` of that exact value
 * (a human already set it via 改建议 — see lib/analysis/pipeline.ts's `loadPinnedType`). This
 * must happen at the schema layer, before `refineCard` runs, rather than by mutating `card.type`
 * after parsing: `refineCard` is what enforces that `playbook.kind` matches `type` (e.g. an
 * `experience` type requires an `experience`-shaped playbook), so narrowing `type` here makes a
 * disobedient model's mismatched playbook fail validation and go through the existing
 * invalid-output retry path, instead of a post-hoc type swap silently storing a card whose type
 * and playbook shape disagree.
 *
 * `overlapCandidates`, when given, narrows `overlap.target` the same way -- see
 * {@link overlapFieldFor}.
 */
export function cardSchemaFor(slugs: string[], pinnedType?: CapabilityType, overlapCandidates: string[] = []) {
  if (slugs.length === 0) throw new Error("cardSchemaFor requires at least one scenario slug");
  const nonEmpty = slugs as [string, ...string[]];
  return cardObjectSchema
    .extend({
      scenarios: scenariosFieldFor(nonEmpty),
      type: pinnedType ? z.literal(pinnedType) : capabilityTypeSchema,
      overlap: overlapFieldFor(overlapCandidates)
    })
    .superRefine(refineCard);
}
