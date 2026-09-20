import { z } from "zod";

export const capabilityTypeSchema = z.enum(["skill", "experience", "plugin", "prompt", "tool", "model", "other"]);
export type CapabilityType = z.infer<typeof capabilityTypeSchema>;

export const extractionSchema = z.object({
  what: z.string().min(1).max(400),
  visible_text: z.string().max(8000),
  commands: z.array(z.string().max(500)).max(20),
  prompt_text: z.string().max(8000).nullable(),
  source_hints: z.array(z.string().max(200)).max(10),
  questions: z.array(z.string().max(200)).max(5)
});
export type Extraction = z.infer<typeof extractionSchema>;

export const MAX_SOURCE_CONTENT = 2048;
export const MAX_SOURCES = 6;
export const searchResultSchema = z.object({
  sources: z.array(z.object({
    title: z.string().max(300),
    url: z.string().url(),
    content: z.string().max(MAX_SOURCE_CONTENT)
  })).max(MAX_SOURCES)
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const playbookSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("integrate"), install: z.array(z.string().max(500)).max(10), repo: z.string().min(1).max(300).nullable(), prompt_text: z.string().max(8000).nullable() }),
  z.object({ kind: z.literal("reference"), points: z.array(z.string().max(300)).min(1).max(10) }),
  z.object({ kind: z.literal("experience"), content: z.string().min(1).max(8000), when_to_use: z.string().max(300) })
]);
export type Playbook = z.infer<typeof playbookSchema>;

/**
 * Words a tag must never equal: the capability type/usage vocabulary itself, not a
 * descriptive tag. Kept in sync with capabilityTypeSchema's members plus the two
 * "usage" values and "integrate"/"reference" as playbook kinds.
 */
export const RESERVED_TAGS = ["skill", "experience", "plugin", "prompt", "tool", "model", "other", "integrate", "reference"] as const;

/**
 * The four fixed "接入方式" tags the owner standardized on for how a capability plugs in.
 * These are ordinary tags (no dedicated column), used alongside topic tags within the same
 * 1–6 count — see prompts.ts's reasonPrompt tag rule and scripts/normalize-tags.ts, which both
 * import this so the vocabulary can't drift between the prompt, the normalizer and tests.
 */
export const INTERFACE_TAGS = ["mcp", "cli", "library", "agent-skill"] as const;

const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Checks if a tag is valid: must match the tag pattern and not be a reserved word.
 * Used both by the tagsSchema validation and by topTags to filter legacy data.
 */
export function isValidTag(tag: string): boolean {
  return TAG_PATTERN.test(tag) && !(RESERVED_TAGS as readonly string[]).includes(tag);
}

/**
 * Tags are normalised (trim → lowercase → drop empty → dedupe) before the 1–6 count is
 * enforced, so ["RAG", "rag ", " "] becomes ["rag"]. Expressed as transform → pipe so the
 * JSON Schema sent to providers (output side of the pipe) is still representable.
 * Each normalised tag must then be an English lowercase word or hyphenated phrase
 * (`web-scraping`, not "Web Scraping" or a Chinese term) and must not be one of the
 * reserved type/usage words — a violation fails validation, triggering the existing
 * Zod-failure correction retry rather than silently accepting a bad tag.
 */
export const tagsSchema = z.array(z.string().max(40))
  .transform((tags) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))])
  .pipe(z.array(z.string().min(1).max(40)
    .refine(isValidTag, "tag must be lowercase English words joined by hyphens (e.g. web-scraping) and not a reserved type/usage word"))
    .min(1).max(6));

/**
 * Matches the `scenarios.slug` CHECK in migration 004: lowercase alphanumeric segments
 * joined by hyphens. Used as-is (no enum) in the static cardSchema, where the live list of
 * valid slugs isn't available; `cardSchemaFor` (lib/analysis/scenarios.ts) narrows this to
 * an actual `z.enum` of the loaded slugs for real pipeline runs.
 */
export const SCENARIO_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Optional/default-[] so callers without a loaded scenario list (tests, seed data, the
 * spike script) can keep constructing cards without one. `cardSchemaFor` overrides this
 * field with a real `min(1).max(3)` enum once a slug list is known.
 */
export const scenariosSchema = z.array(z.string().max(40).regex(SCENARIO_SLUG_PATTERN)).max(3).default([]);

/**
 * Objective facts about the capability's source, gathered from search results — never
 * guessed by the model (see prompts.ts's explicit "don't invent star counts / dates"
 * instruction). Every field is optional/nullable, and `{}` (nothing found) is valid and
 * is the schema's default. `last_update`/`as_of` use `z.iso.date()` (YYYY-MM-DD) so
 * `z.toJSONSchema` still renders a plain string format, not a custom refinement.
 */
export const sourceFactsSchema = z.object({
  repo_url: z.string().url().nullable().optional(),
  stars: z.number().int().nonnegative().nullable().optional(),
  last_update: z.iso.date().nullable().optional(),
  license: z.string().max(100).nullable().optional(),
  homepage: z.string().url().nullable().optional(),
  /** The date these facts were gathered, so a stale source_facts blob can be told apart from a fresh one. */
  as_of: z.iso.date().nullable().optional()
});
export type SourceFacts = z.infer<typeof sourceFactsSchema>;

export const overlapRelationSchema = z.enum(["none", "duplicate", "upgrade", "superseded", "complement"]);
export type OverlapRelation = z.infer<typeof overlapRelationSchema>;

/**
 * Whether this card overlaps with an existing kept capability in the library, judged during
 * the reason step against a candidate list of nearby cards (see similar.ts's
 * similarByEmbedding/findSimilar, and scenarios.ts's cardSchemaFor, which narrows `target` to
 * the exact serial codes offered in that run's prompt candidate list). `target` here is left as
 * a bare string so the static schema (used by tests, seed data and scripts with no live
 * candidate list) stays usable; the live pipeline always builds the per-run enum instead.
 * `relation`/`target` agreement ("none" iff target is null) is enforced in {@link refineCard},
 * alongside its other cross-field checks, the same way `type`/`playbook` coherence is.
 */
export const overlapSchema = z.object({
  relation: overlapRelationSchema,
  target: z.string().max(40).nullable(),
  reason: z.string().max(80)
});
export type Overlap = z.infer<typeof overlapSchema>;

/** No overlap with anything in the library -- the default for a brand-new, unrelated card. */
export const NO_OVERLAP: Overlap = { relation: "none", target: null, reason: "" };

/**
 * The bare object shape, without the cross-field superRefine below. Exported so
 * `cardSchemaFor` can `.extend()` a field (ZodObject supports this; the ZodEffects
 * produced by `.superRefine()` does not) and then re-apply the same cross-field rules.
 */
export const cardObjectSchema = z.object({
  title: z.string().min(1).max(60),
  type: capabilityTypeSchema,
  summary: z.string().min(1).max(800),
  signals: z.array(z.string().max(200)).min(2).max(3),
  suggested_verdict: z.enum(["keep", "discard"]),
  suggested_reason: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
  usage: z.enum(["integrate", "reference"]),
  playbook: playbookSchema,
  tags: tagsSchema,
  source_url: z.string().url().nullable(),
  scenarios: scenariosSchema,
  /** AI-assigned value score, 1 (drop) – 5 (integrate now); see prompts.ts's rubric. */
  score: z.number().int().min(1).max(5),
  score_reason: z.string().min(1).max(80),
  source_facts: sourceFactsSchema.default({}),
  overlap: overlapSchema.default(NO_OVERLAP)
});

export function refineCard<T extends {
  type: CapabilityType; usage: "integrate" | "reference"; playbook: Playbook;
  overlap: { relation: OverlapRelation; target: string | null };
}>(
  card: T,
  ctx: z.RefinementCtx
): void {
  if (card.type === "experience" && card.playbook.kind !== "experience") {
    ctx.addIssue({ code: "custom", path: ["playbook"], message: "experience type requires experience playbook" });
  }
  if (card.type !== "experience" && card.playbook.kind === "experience") {
    ctx.addIssue({ code: "custom", path: ["playbook"], message: "experience playbook requires experience type" });
  }
  if (card.type !== "experience") {
    if (card.usage === "integrate" && card.playbook.kind !== "integrate") {
      ctx.addIssue({ code: "custom", path: ["playbook"], message: "integrate usage requires integrate playbook" });
    }
    if (card.usage === "reference" && card.playbook.kind !== "reference") {
      ctx.addIssue({ code: "custom", path: ["playbook"], message: "reference usage requires reference playbook" });
    }
  }
  if (card.overlap.relation === "none" && card.overlap.target !== null) {
    ctx.addIssue({ code: "custom", path: ["overlap", "target"], message: "relation 'none' requires target to be null" });
  }
  if (card.overlap.relation !== "none" && card.overlap.target === null) {
    ctx.addIssue({ code: "custom", path: ["overlap", "target"], message: "a relation other than 'none' requires a non-null target" });
  }
}

export const cardSchema = cardObjectSchema.superRefine(refineCard);
export type Card = z.infer<typeof cardSchema>;

/** `{ score, score_reason, source_facts }` alone, for the score backfill script's per-card call. */
export const scoreResultSchema = cardObjectSchema.pick({ score: true, score_reason: true, source_facts: true });
export type ScoreResult = z.infer<typeof scoreResultSchema>;

/**
 * Sets `source_facts.as_of` deterministically instead of trusting the model to know today's
 * date: today (as YYYY-MM-DD) when at least one other fact field was filled, `null` when the
 * whole object is empty. Used by the score backfill script, which has no web search step and
 * therefore no source-dated facts to anchor `as_of` to — see prompts.ts's `backfillScorePrompt`.
 */
export function finalizeSourceFacts(facts: SourceFacts, now: Date = new Date()): SourceFacts {
  const filled = facts.repo_url != null || facts.stars != null || facts.last_update != null
    || facts.license != null || facts.homepage != null;
  return { ...facts, as_of: filled ? now.toISOString().slice(0, 10) : null };
}

export const reviewNoteSchema = z.object({ agrees: z.boolean(), points: z.array(z.string().max(300)).max(8) });
export type ReviewNote = z.infer<typeof reviewNoteSchema>;

// --- Deep analysis (M3.6) ---------------------------------------------------------------
// See lib/analysis/deep.ts. Owner's design decision 5: deep analysis must not produce a wall
// of text, so every field below is capped short and scannable instead of free prose.

/** Deep analysis' `plan` step output: 4-6 search queries covering docs / repo / word-of-mouth / alternatives. */
export const deepPlanSchema = z.object({
  queries: z.array(z.string().min(1).max(200)).min(4).max(6)
});
export type DeepPlan = z.infer<typeof deepPlanSchema>;

export const deepSourceSchema = z.object({ title: z.string().max(300), url: z.string().url() });
export type DeepSource = z.infer<typeof deepSourceSchema>;

/**
 * First `synthesize` pass: merges the raw search results into a flat list of grounded facts
 * before the second pass composes the final card from them. `source` indexes into the raw
 * merged sources list passed into the facts prompt (see deep.ts), or is `null` when nothing
 * relevant was found for that fact (never a guess).
 */
export const deepFactsSchema = z.object({
  facts: z.array(z.object({
    text: z.string().min(1).max(300),
    source: z.number().int().min(0).nullable()
  })).max(40)
});
export type DeepFacts = z.infer<typeof deepFactsSchema>;

const deepBullet = (max: number) => z.string().min(1).max(max);

/**
 * Second `synthesize` pass' output, stored as `capabilities.deep_analysis`. Grounding rule
 * (owner ruling): every `cases` entry must cite a real retrieved source by index into this
 * same output's `sources`; when nothing was found, `cases` must be an empty array rather than
 * invented material -- enforced here (an out-of-range index fails validation) and in the
 * prompt (deep.ts's synthesize prompt spells out the same rule).
 */
export const deepAnalysisSchema = z.object({
  headline: deepBullet(40),
  architecture: z.object({ summary: deepBullet(80), points: z.array(deepBullet(40)).min(3).max(5) }),
  implementation: z.object({ summary: deepBullet(80), points: z.array(deepBullet(40)).min(3).max(5) }),
  use_cases: z.array(z.object({ title: deepBullet(20), detail: deepBullet(60) })).min(3).max(5),
  cases: z.array(z.object({ title: deepBullet(30), detail: deepBullet(60), source: z.number().int().min(0) })).max(4),
  feedback: z.object({
    positive: z.array(deepBullet(40)).max(3),
    negative: z.array(deepBullet(40)).max(3)
  }),
  risks: z.array(deepBullet(50)).min(2).max(4),
  sources: z.array(deepSourceSchema)
}).superRefine((value, ctx) => {
  value.cases.forEach((c, i) => {
    if (c.source >= value.sources.length) {
      ctx.addIssue({ code: "custom", path: ["cases", i, "source"], message: `cases[${i}].source (${c.source}) is out of range for sources (length ${value.sources.length})` });
    }
  });
});
export type DeepAnalysis = z.infer<typeof deepAnalysisSchema>;
