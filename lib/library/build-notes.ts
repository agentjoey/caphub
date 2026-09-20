import type { Pool } from "pg";
import { getDict, type Locale } from "../i18n";
import { invalid, isNonEmptyString, isParsableTimestamp, missingOrConflict, type ActionResult } from "./action-result";

export const MAX_NOTE_TEXT = 2000;
const MAX_NOTE_BY = 40;

export interface BuildNote { at: string; by: string; text: string }

/**
 * Validates and shapes a client-submitted build note. `by` is the client's self-reported agent
 * name (display only — real identity is the Access service token that authenticated the write);
 * blank/absent defaults to "agent" and is truncated to {@link MAX_NOTE_BY} chars. `text` must trim
 * to a non-empty string of at most {@link MAX_NOTE_TEXT} chars, or the note is rejected (`null`).
 */
export function normalizeNote(input: { by: unknown; text: unknown }): BuildNote | null {
  if (typeof input.text !== "string") return null;
  const text = input.text.trim();
  if (text.length === 0 || text.length > MAX_NOTE_TEXT) return null;
  const rawBy = typeof input.by === "string" ? input.by.trim() : "";
  const by = (rawBy === "" ? "agent" : rawBy).slice(0, MAX_NOTE_BY);
  return { at: new Date().toISOString(), by, text };
}

/**
 * Appends a build note to a kept, non-deleted card. Append-only (no update-in-place, no delete):
 * `build_notes || $3::jsonb` is a pure jsonb array concatenation. Uses the same optimistic-lock
 * discipline as the other writers in actions.ts (`date_trunc('milliseconds', updated_at)`),
 * since node-postgres returns millisecond-precision Dates.
 */
export async function appendBuildNote(
  pool: Pool,
  input: { id: string; expectedUpdatedAt: string; note: BuildNote },
  locale: Locale = "zh"
): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id) || !isParsableTimestamp(input.expectedUpdatedAt)) return invalid(dict.invalid);
  const r = await pool.query<{ updated_at: Date }>(
    `UPDATE caphub_v2.capabilities
        SET build_notes = build_notes || $3::jsonb, updated_at = now()
      WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2::timestamptz
        AND deleted_at IS NULL AND verdict = 'keep'
      RETURNING updated_at`,
    [input.id, input.expectedUpdatedAt, JSON.stringify([input.note])]);
  if (r.rows[0]) return { ok: true, updatedAt: r.rows[0].updated_at.toISOString() };
  return missingOrConflict(pool, input.id, locale);
}
