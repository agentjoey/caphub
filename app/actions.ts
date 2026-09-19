"use server";
import { revalidatePath } from "next/cache";
import type { CapabilityType } from "../lib/analysis/card";
import { decide, editSuggestion, requestRerun, requestReview, softDelete, type ActionResult } from "../lib/library/actions";
import { getRuntime } from "../lib/runtime";

function refresh() { revalidatePath("/", "layout"); }

export async function decideAction(id: string, expectedUpdatedAt: string, verdict: "keep" | "discard"): Promise<ActionResult> {
  const r = await decide(getRuntime().pool, { id, expectedUpdatedAt, verdict }); refresh(); return r;
}
export async function editSuggestionAction(id: string, expectedUpdatedAt: string, type: CapabilityType, usage: "integrate" | "reference", tags: string[]): Promise<ActionResult> {
  const r = await editSuggestion(getRuntime().pool, { id, expectedUpdatedAt, type, usage, tags }); refresh(); return r;
}
export async function softDeleteAction(id: string, expectedUpdatedAt: string): Promise<ActionResult> {
  const r = await softDelete(getRuntime().pool, { id, expectedUpdatedAt }); refresh(); return r;
}
export async function rerunAction(captureId: string): Promise<ActionResult> {
  const { pool, config } = getRuntime();
  const r = await requestRerun(pool, { captureId, pipeline: config.pipeline }); refresh(); return r;
}
export async function reviewAction(id: string): Promise<ActionResult> {
  const r = await requestReview(getRuntime().pool, { id }); refresh(); return r;
}
