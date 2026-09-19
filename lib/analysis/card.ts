import { z } from "zod";

export const capabilityTypeSchema = z.enum(["skill", "experience", "plugin", "prompt", "other"]);
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
export const RESERVED_TAGS = ["skill", "experience", "plugin", "prompt", "other", "integrate", "reference"] as const;

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
  scenarios: scenariosSchema
});

export function refineCard<T extends { type: CapabilityType; usage: "integrate" | "reference"; playbook: Playbook }>(
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
}

export const cardSchema = cardObjectSchema.superRefine(refineCard);
export type Card = z.infer<typeof cardSchema>;

export const reviewNoteSchema = z.object({ agrees: z.boolean(), points: z.array(z.string().max(300)).max(8) });
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
