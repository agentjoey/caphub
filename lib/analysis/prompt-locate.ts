import { MAX_PROMPT_CHARS, MAX_PROMPTS, type Extraction } from "./card";
import type { Material } from "./material";

export interface PromptLocator { start: string; end: string }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds `anchor` in `source` at or after `from`: exact first, then whitespace-insensitive.
 * The fallback strips all whitespace from the anchor and allows optional whitespace (`\s*`)
 * between every pair of adjacent non-whitespace characters -- not just where the anchor still
 * has a whitespace run. A CJK anchor that spans a source line break often comes back from the
 * model with the line break dropped entirely (no space at all, e.g. "行结尾第二行" for source
 * "...行结尾\n第二行..."), so anchoring only on the anchor's own whitespace runs would miss it;
 * allowing whitespace between every character catches that case too. Returns the source span,
 * so whatever is sliced later is the source's own characters.
 */
function findAnchor(source: string, anchor: string, from: number): { index: number; end: number } | null {
  const needle = anchor.trim();
  if (!needle) return null;
  const exact = source.indexOf(needle, from);
  if (exact !== -1) return { index: exact, end: exact + needle.length };
  const chars = [...needle].filter((c) => !/\s/.test(c));
  if (chars.length === 0) return null;
  const pattern = new RegExp(chars.map(escapeRegExp).join("\\s*"), "g");
  pattern.lastIndex = from;
  const m = pattern.exec(source);
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

/**
 * Slices each located prompt out of `source` verbatim. Locators are resolved in order, each
 * searched from where the previous one ended; a locator whose anchors aren't both found, or
 * whose span exceeds MAX_PROMPT_CHARS, or that falls past MAX_PROMPTS, is dropped and counted
 * in `unresolved` -- never truncated or repaired.
 *
 * Known limitation: the end anchor is matched as the *first* occurrence at or after the start
 * anchor, so if the end phrase also appears earlier inside the prompt's own body (a repeated
 * phrase), the slice ends at that first occurrence instead of the model's intended end -- the
 * located prompt then comes out shorter than the real one.
 */
export function locatePrompts(source: string, locators: PromptLocator[]): { prompts: string[]; unresolved: number } {
  const prompts: string[] = [];
  let unresolved = 0;
  let cursor = 0;
  for (const locator of locators) {
    if (prompts.length >= MAX_PROMPTS) { unresolved += 1; continue; }
    const start = findAnchor(source, locator.start, cursor);
    const end = start ? findAnchor(source, locator.end, start.index) : null;
    if (!start || !end) { unresolved += 1; continue; }
    const stop = Math.max(end.end, start.end);
    const text = source.slice(start.index, stop);
    if (text.length > MAX_PROMPT_CHARS) { unresolved += 1; continue; }
    prompts.push(text);
    cursor = stop;
  }
  return { prompts, unresolved };
}

/**
 * The verbatim prompts for one analysis run, taken only from the input source: the vision
 * transcription for an image, or the reason step's locators resolved against the exact text
 * the reason prompt showed the model (the text capture, or the fetched page text).
 */
export function collectPrompts(input: { material: Material; extraction: Extraction | null; locators: PromptLocator[] }): { prompts: string[]; unresolved: number } {
  const { material, extraction, locators } = input;
  if (material.kind === "image" || material.kind === "video") {
    // Mirrors locatePrompts' own capping: a blank transcription is simply dropped (never
    // counted), but a non-blank item past MAX_PROMPTS, or one over MAX_PROMPT_CHARS, is
    // dropped *and* counted in `unresolved` so a 21+-prompt screenshot lands in Review instead
    // of silently losing items.
    let unresolved = 0;
    const valid: string[] = [];
    for (const p of extraction?.prompts ?? []) {
      if (p.trim() === "") continue;
      if (p.length > MAX_PROMPT_CHARS) { unresolved += 1; continue; }
      valid.push(p);
    }
    unresolved += Math.max(0, valid.length - MAX_PROMPTS);
    return { prompts: valid.slice(0, MAX_PROMPTS), unresolved };
  }
  const source = material.text;
  if (source === null) return { prompts: [], unresolved: locators.length };
  return locatePrompts(source, locators);
}
