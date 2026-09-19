"use server";
import { revalidatePath } from "next/cache";
import type { CapabilityType } from "../lib/analysis/card";
import { decide, editSuggestion, requestRerun, requestReview, softDelete, type ActionResult } from "../lib/library/actions";
import { getLocale } from "../lib/i18n/locale";
import { getRuntime } from "../lib/runtime";

function refresh() { revalidatePath("/", "layout"); }

export async function decideAction(id: string, expectedUpdatedAt: string, verdict: "keep" | "discard"): Promise<ActionResult> {
  const locale = await getLocale();
  const r = await decide(getRuntime().pool, { id, expectedUpdatedAt, verdict }, locale); refresh(); return r;
}
export async function editSuggestionAction(id: string, expectedUpdatedAt: string, type: CapabilityType, usage: "integrate" | "reference", tags: string[]): Promise<ActionResult> {
  const locale = await getLocale();
  const r = await editSuggestion(getRuntime().pool, { id, expectedUpdatedAt, type, usage, tags }, locale); refresh(); return r;
}
export async function softDeleteAction(id: string, expectedUpdatedAt: string): Promise<ActionResult> {
  const locale = await getLocale();
  const r = await softDelete(getRuntime().pool, { id, expectedUpdatedAt }, locale); refresh(); return r;
}
export async function rerunAction(captureId: string): Promise<ActionResult> {
  const locale = await getLocale();
  const { pool, config } = getRuntime();
  const r = await requestRerun(pool, { captureId, pipeline: config.pipeline }, locale); refresh(); return r;
}
export async function reviewAction(id: string): Promise<ActionResult> {
  const locale = await getLocale();
  const r = await requestReview(getRuntime().pool, { id }, locale); refresh(); return r;
}
