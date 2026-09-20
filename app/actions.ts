"use server";
import { revalidatePath } from "next/cache";
import type { CapabilityType } from "../lib/analysis/card";
import {
  decide, editSuggestion, ignoreOverlap, requestRerun, requestReview, setProgress, setStatus, softDelete,
  supersedeOverlapTarget, type ActionResult, type CapabilityStatus
} from "../lib/library/actions";
import type { Progress } from "../lib/library/labels";
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
export async function setProgressAction(id: string, expectedUpdatedAt: string, progress: Progress, link: string | null): Promise<ActionResult> {
  const locale = await getLocale();
  const r = await setProgress(getRuntime().pool, { id, expectedUpdatedAt, progress, link }, locale); refresh(); return r;
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
export async function setStatusAction(id: string, expectedUpdatedAt: string, status: CapabilityStatus, supersededBy: string | null, note: string | null): Promise<ActionResult> {
  const locale = await getLocale();
  const r = await setStatus(getRuntime().pool, { id, expectedUpdatedAt, status, supersededBy, note }, locale); refresh(); return r;
}
export async function ignoreOverlapAction(id: string, expectedUpdatedAt: string): Promise<ActionResult> {
  const locale = await getLocale();
  const r = await ignoreOverlap(getRuntime().pool, { id, expectedUpdatedAt }, locale); refresh(); return r;
}
export async function supersedeOverlapTargetAction(id: string): Promise<ActionResult> {
  const locale = await getLocale();
  const r = await supersedeOverlapTarget(getRuntime().pool, { id }, locale); refresh(); return r;
}
