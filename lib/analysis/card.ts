import { z } from "zod";

export const capabilityTypeSchema = z.enum(["skill", "experience", "plugin", "prompt", "tool", "model", "other"]);
export type CapabilityType = z.infer<typeof capabilityTypeSchema>;

/** Per-card cap on verbatim prompts, and per-prompt character cap (spec 2026-09-22). Over-cap items are dropped, never truncated. */
export const MAX_PROMPTS = 20;
export const MAX_PROMPT_CHARS = 20_000;

/**
 * Schema-level cap on how many `prompts`/`prompt_locators` items a single model output may
 * contain, kept deliberately looser than the `MAX_PROMPTS` storage cap: a collection
 * page/screenshot with 21-50 prompts must still validate successfully so the run can reach
 * `collectPrompts`/`locatePrompts`, which drop everything past `MAX_PROMPTS` and count it in
 * `unresolved` (sending the card to Review) instead of the whole analysis run dying with
 * `INVALID_OUTPUT` at schema validation.
 */
export const MAX_PROMPT_ITEMS_ACCEPTED = 50;

export const extractionSchema = z.object({
  what: z.string().min(1).max(400),
  visible_text: z.string().max(8000),
  commands: z.array(z.string().max(500)).max(20),
  /** Every complete prompt visible in the image, transcribed verbatim, one entry each (spec 2026-09-22). */
  prompts: z.array(z.string().max(MAX_PROMPT_CHARS)).max(MAX_PROMPT_ITEMS_ACCEPTED),
  source_hints: z.array(z.string().max(200)).max(10),
  questions: z.array(z.string().max(200)).max(5)
});
export type Extraction = z.infer<typeof extractionSchema>;

/** Video transcription (lib/providers/gemini-video.ts): the image extraction plus timestamped key moments. */
export const videoExtractionSchema = extractionSchema.extend({
  /**
   * What the video itself says and shows, point by point -- the material a video card's summary
   * is written from (Joey, 2026-09-22: a video card summarises the video, not the topic; web
   * search only fills source facts). `t` is where the point is made, or null when it spans the video.
   */
  content_points: z.array(z.object({
    t: z.string().regex(/^\d{1,2}:\d{2}(?::\d{2})?$/).nullable(),
    point: z.string().min(1).max(200)
  })).max(12).default([]),
  /**
   * Same `{ t, point }` field names as content_points: with a separate `note` field Gemini kept
   * writing `point` here, failing the video step twice in a row (2026-09-23). Cards stored before
   * the rename carry `note`; lib/library/queries.ts's buildVideoDetail reads both.
   */
  key_moments: z.array(z.object({
    t: z.string().regex(/^\d{1,2}:\d{2}(?::\d{2})?$/),
    point: z.string().min(1).max(120)
  })).max(8).default([])
});
export type VideoExtraction = z.infer<typeof videoExtractionSchema>;
export const VIDEO_CLIP_SEC = 5400;

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
  z.object({
    kind: z.literal("integrate"),
    install: z.array(z.string().max(500)).max(10),
    repo: z.string().min(1).max(300).nullable(),
    /**
     * A model-written usage example (a one/several-sentence prompt you could hand an agent
     * directly) for non-`prompt` type cards -- e.g. "使用 srt-whiteboard-animation skill，把我
     * 提供的 SRT 字幕做成…". This is NOT the capture's verbatim prompt text (that lives in
     * `capabilities.prompts`, spec 2026-09-22); it's the model's own illustration of how to
     * invoke the capability. `null` when the model found nothing worth illustrating, or when
     * `type === "prompt"` (the prompt itself already is the usage). Not to be confused with the
     * removed legacy `prompt_text` field this schema still discards below.
     */
    usage_prompt: z.string().max(8000).nullable().default(null)
  }),
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
  /** Prompt target is 80 chars; the cap keeps the usual headroom (see summaryPointSchema). */
  reason: z.string().max(120)
});
export type Overlap = z.infer<typeof overlapSchema>;

/** No overlap with anything in the library -- the default for a brand-new, unrelated card. */
export const NO_OVERLAP: Overlap = { relation: "none", target: null, reason: "" };

/**
 * One `**标签。** 说明句` line of a card's structured summary (M3.8 design decision: prose in
 * one block is the thing being replaced) -- `label` is the short bolded lead-in (e.g. "定位"、
 * "适用场景"), `text` is the one-sentence explanation that follows it. Rendering (Task 2) joins
 * these as Markdown; this schema only constrains their lengths so a model can't dump a whole
 * paragraph into a single point.
 *
 * The caps here (12 / 90) are deliberately looser than what the prompt asks the model to aim
 * for (≤8 / ≤60, prompts.ts) -- review fix round 1: with a 1-character-over-cap failure killing
 * the whole (expensive) reason/enrich run after `runStructured`'s two attempts, and models
 * counting CJK characters unreliably, the schema needs slack to only reject genuine
 * paragraph-dumping, not a model that slightly overshot the prompt's shaping target. Mirrors
 * `summary`'s own prompt-vs-schema gap immediately below.
 */
export const summaryPointSchema = z.object({
  label: z.string().min(1).max(12),
  text: z.string().min(1).max(90)
});
export type SummaryPoint = z.infer<typeof summaryPointSchema>;

/**
 * `定位` → `定位。` — a summary point's bold lead-in label, as both the web card and the
 * Telegram card render it (`**标签。** 说明`). Lives here, next to the schema, so the two render
 * paths share one definition without the Telegram formatter importing a React component.
 * Stored labels carry no punctuation, but a model may still write some; any trailing
 * sentence/clause mark is normalized away rather than doubled. Returns `""` for a blank label.
 */
export function summaryPointLabel(label: string): string {
  const trimmed = label.trim().replace(/[。．.:：、，,;；]+$/u, "").trim();
  return trimmed === "" ? "" : `${trimmed}。`;
}

/**
 * The bare object shape, without the cross-field superRefine below. Exported so
 * `cardSchemaFor` can `.extend()` a field (ZodObject supports this; the ZodEffects
 * produced by `.superRefine()` does not) and then re-apply the same cross-field rules.
 */
export const cardObjectSchema = z.object({
  title: z.string().min(1).max(60),
  type: capabilityTypeSchema,
  /**
   * The lead: one short sentence framing what this capability is, read by every list row,
   * search hit and un-enriched card (controller ruling: KEPT, not replaced by
   * `summary_points`) -- the structured detail now lives in `summary_points` instead of being
   * crammed into this field, hence the tightened cap (was 800). The prompt asks for ≤120 chars
   * as the shaping target; the schema cap is 180 (see summaryPointSchema's comment for why the
   * schema deliberately keeps headroom above the prompt's target instead of matching it exactly).
   */
  summary: z.string().min(1).max(180),
  /**
   * 3–5 `**标签。** 说明句` lines that follow the lead (munderdiffl.in's pattern, per the M3.8
   * brief) -- each point is one short, scannable fact, never a paragraph. Defaults are not
   * provided: every card (first pass and enrich rewrite) must produce these explicitly.
   */
  summary_points: z.array(summaryPointSchema).min(3).max(5),
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
  /** Prompt target is 80 chars; cap keeps headroom -- an 81-char reason once killed a whole
   * backfill run (M3.5 verification). See summaryPointSchema for the rationale. */
  score_reason: z.string().min(1).max(120),
  source_facts: sourceFactsSchema.default({}),
  overlap: overlapSchema.default(NO_OVERLAP),
  /**
   * 0-3 things the first pass couldn't determine from the input and that need checking --
   * each an open question about the capability itself (e.g. "是否需要登录才能用"), never about
   * how the analysis went. Design decision 4 (M3.7 plan): the second pass uses these as its
   * search targets; whatever is still unresolved after that stays on the card as a "待核实"
   * list rather than being folded into `summary` (design decision 5 keeps process narration
   * out of the summary entirely).
   */
  open_questions: z.array(z.string().max(45)).max(3).default([]),
  /**
   * Where each prompt sits in the text/url input -- the first and last ~20 characters, copied
   * from the source. Never stored: pipeline.ts resolves them with collectPrompts and stores the
   * source's own span in `capabilities.prompts` (spec 2026-09-22). Empty for images, whose
   * prompts come from the vision transcription instead.
   */
  prompt_locators: z.array(z.object({ start: z.string().min(1).max(80), end: z.string().min(1).max(80) })).max(MAX_PROMPT_ITEMS_ACCEPTED).default([])
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

/**
 * Deep analysis' `plan` step output: 4-5 search queries covering docs / repo / word-of-mouth /
 * alternatives. Capped at 5 (not 6, per the brief) so a worst-case full run -- 1 plan + 5
 * search + 2 synthesize = 8 calls -- fits the budget with room for one retry (see deep.ts's
 * DEEP_BUDGET_LIMITS, 10 calls / 400k tokens).
 */
export const deepPlanSchema = z.object({
  queries: z.array(z.string().min(1).max(200)).min(4).max(5)
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
    /** Prompt target is 300 chars; cap keeps headroom so one long fact can't discard the run. */
    text: z.string().min(1).max(450),
    source: z.number().int().min(0).nullable()
  })).max(40)
});
export type DeepFacts = z.infer<typeof deepFactsSchema>;

const deepBullet = (max: number) => z.string().min(1).max(max);

/**
 * One 口碑与争议 point: a short line plus, when it came from a specific retrieved source, that
 * source's index into the same output's `sources`. `null` means "a general impression, not
 * traceable to one source" -- the escape hatch that keeps the model from inventing an index just
 * to fill the field (controller ruling, fix round 1: 口碑与争议 is exactly the section a reader
 * needs to be able to check, so it is grounded the same way `cases` is).
 */
export const deepFeedbackPointSchema = z.object({
  text: deepBullet(60),
  source: z.number().int().min(0).nullable()
});
export type DeepFeedbackPoint = z.infer<typeof deepFeedbackPointSchema>;

/**
 * Second `synthesize` pass' output, stored as `capabilities.deep_analysis`. Grounding rule
 * (owner ruling): every `cases` entry should cite a real retrieved source by index into this
 * same output's `sources`; when nothing was found, `cases` must be an empty array rather than
 * invented material -- enforced in the prompt (deep.ts's synthesize prompt spells out the same
 * rule). Every `feedback` point is grounded the same way, except that it may cite `null` (see
 * {@link deepFeedbackPointSchema}).
 *
 * Review fix round 2 (production incident: two full deep-analysis runs -- 1 plan + 5 search + 1
 * facts synthesize, all successful -- lost at the final synthesize step to `INVALID_OUTPUT`/
 * `INVALID_JSON` with only two `runStructured` attempts): a `source` index that is merely
 * out of range for `sources` is no longer a validation failure -- it's coerced to `null`
 * ("no specific source") by the `.transform` below, so one bad citation doesn't discard seven
 * successful calls. A `source` that isn't a non-negative integer still fails validation (the
 * per-field `z.number().int().min(0)` above), since that's a shape error, not a range slip.
 *
 * The character caps below (headline/summary/points/use_cases/cases/feedback/risks) are
 * deliberately looser than what the prompt asks the model to aim for (deep.ts's plan/synthesize
 * prompts) -- same review-fix rationale as `summaryPointSchema` above: models count CJK
 * characters unreliably, and the schema only needs to reject genuine paragraph-dumping, not a
 * model that slightly overshot the prompt's shaping target. Array-length bounds (3-5 points,
 * 3-5 use_cases, 0-4 cases, 0-3 feedback items each, 2-4 risks) stay strict -- those counts are
 * what keep the card scannable, not the source of the length-cap failures being fixed here.
 *
 * Round 3 (SKL-0031's third failed run): `points` needed 90, not 60. A cap counts characters,
 * but an architecture point that legitimately lists identifiers --
 * "拆为 core/timeline/scrolltrigger/plugins/utils/react/performance/frameworks", 73 chars --
 * spends them on ASCII at a fraction of the information density of the same number of CJK
 * characters. The prompt's 40-char target still shapes the prose; the cap only has to catch
 * a paragraph.
 */
const deepAnalysisObjectSchema = z.object({
  headline: deepBullet(60),
  architecture: z.object({ summary: deepBullet(120), points: z.array(deepBullet(90)).min(3).max(5) }),
  implementation: z.object({ summary: deepBullet(120), points: z.array(deepBullet(90)).min(3).max(5) }),
  use_cases: z.array(z.object({ title: deepBullet(30), detail: deepBullet(90) })).min(3).max(5),
  cases: z.array(z.object({ title: deepBullet(45), detail: deepBullet(90), source: z.number().int().min(0).nullable() })).max(4),
  feedback: z.object({
    positive: z.array(deepFeedbackPointSchema).max(3),
    negative: z.array(deepFeedbackPointSchema).max(3)
  }),
  risks: z.array(deepBullet(75)).min(2).max(4),
  sources: z.array(deepSourceSchema)
});

/**
 * The out-of-range coercion is attached transform→pipe (the same pattern as `tagsSchema` and
 * `scenariosFieldFor`) and NOT as a bare `.transform`: `runStructured` hands this schema to
 * `z.toJSONSchema`, which throws "Transforms cannot be represented in JSON Schema" on a
 * transform that isn't piped back into a representable schema -- that would kill every deep
 * analysis at the provider call, before the model ever answers.
 */
export const deepAnalysisSchema = deepAnalysisObjectSchema
  .transform((value) => {
    const clampSource = (source: number | null): number | null =>
      source !== null && source >= value.sources.length ? null : source;
    return {
      ...value,
      cases: value.cases.map((c) => ({ ...c, source: clampSource(c.source) })),
      feedback: {
        positive: value.feedback.positive.map((p) => ({ ...p, source: clampSource(p.source) })),
        negative: value.feedback.negative.map((p) => ({ ...p, source: clampSource(p.source) }))
      }
    };
  })
  .pipe(deepAnalysisObjectSchema);
export type DeepAnalysis = z.infer<typeof deepAnalysisSchema>;
