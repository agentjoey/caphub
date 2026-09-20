import type { Pool } from "pg";
import { getDict, type Locale } from "../i18n";

export type ActionResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: "CONFLICT" | "NOT_FOUND" | "INVALID" | "OBJECT_GONE"; message: string };

export const conflict = (message: string): ActionResult => ({ ok: false, reason: "CONFLICT", message });
export const invalid = (message: string): ActionResult => ({ ok: false, reason: "INVALID", message });

export const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
export const isParsableTimestamp = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

export async function missingOrConflict(db: Pick<Pool, "query">, id: string, locale: Locale, busyMessage?: string): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  const r = await db.query("SELECT 1 FROM caphub_v2.capabilities WHERE id = $1 AND deleted_at IS NULL", [id]);
  return r.rows.length ? conflict(busyMessage ?? dict.conflict) : { ok: false, reason: "NOT_FOUND", message: dict.cardNotFound };
}
