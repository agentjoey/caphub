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
  z.object({ kind: z.literal("integrate"), install: z.array(z.string().max(500)).max(10), repo: z.string().url().nullable(), prompt_text: z.string().max(8000).nullable() }),
  z.object({ kind: z.literal("reference"), points: z.array(z.string().max(300)).min(1).max(10) }),
  z.object({ kind: z.literal("experience"), content: z.string().min(1).max(8000), when_to_use: z.string().max(300) })
]);
export type Playbook = z.infer<typeof playbookSchema>;

export const cardSchema = z.object({
  title: z.string().min(1).max(60),
  type: capabilityTypeSchema,
  summary: z.string().min(1).max(800),
  signals: z.array(z.string().max(200)).min(2).max(3),
  suggested_verdict: z.enum(["keep", "discard"]),
  suggested_reason: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
  usage: z.enum(["integrate", "reference"]),
  playbook: playbookSchema,
  tags: z.array(z.string().min(1).max(40).transform((t) => t.toLowerCase().trim())).min(1).max(6),
  source_url: z.string().url().nullable()
}).superRefine((card, ctx) => {
  if (card.type === "experience" && card.playbook.kind !== "experience") {
    ctx.addIssue({ code: "custom", path: ["playbook"], message: "experience type requires experience playbook" });
  }
  if (card.type !== "experience" && card.playbook.kind === "experience") {
    ctx.addIssue({ code: "custom", path: ["playbook"], message: "experience playbook requires experience type" });
  }
});
export type Card = z.infer<typeof cardSchema>;

export const reviewNoteSchema = z.object({ agrees: z.boolean(), points: z.array(z.string().max(300)).max(8) });
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
